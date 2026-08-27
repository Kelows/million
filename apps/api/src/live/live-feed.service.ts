import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LiveStatus } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { txDeltas } from '../analysis/metrics';
import type { HeliusTx } from '../analysis/helius.service';

const MAX_SUBSCRIPTIONS = 25; // standard websocket comfort zone on the free tier
const SOL_EPS = 0.005;
const USD_EPS = 0.5;

/**
 * The Sub button, made real: one websocket to Helius, logsSubscribe per
 * subscribed wallet, every mentioning transaction parsed and stored as a
 * LiveEvent within seconds of landing on-chain. Dial-out only — works from
 * localhost, no public endpoint needed.
 */
@Injectable()
export class LiveFeedService implements OnModuleInit, OnModuleDestroy {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1_000;
  private subBySubId = new Map<number, string>(); // helius subscription id -> wallet
  private walletByReqId = new Map<number, string>(); // pending subscribe request id -> wallet
  private nextReqId = 1;
  private lastEventAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
  ) {}

  onModuleInit() {
    if (this.env.get('HELIUS_API_KEY')) this.connect();
  }

  onModuleDestroy() {
    this.closed = true;
    this.ws?.close();
  }

  async status(): Promise<LiveStatus> {
    const subscribedWallets = await this.prisma.wallet.count({ where: { subscribed: true, purgedAt: null } });
    const dayAgo = new Date(Date.now() - 86_400_000);
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscribedWallets,
      activeSubscriptions: this.subBySubId.size,
      maxSubscriptions: MAX_SUBSCRIPTIONS,
      eventsToday: await this.prisma.liveEvent.count({ where: { ts: { gte: dayAgo } } }),
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
    };
  }

  /** Called after any subscription change: tear down and resubscribe the current set. */
  async resync() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(); // reconnect path re-reads the subscribed set
    }
  }

  private connect() {
    const key = this.env.get<string>('HELIUS_API_KEY');
    if (!key || this.closed) return;
    const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${key}`);
    this.ws = ws;

    ws.onopen = async () => {
      this.reconnectDelay = 1_000;
      this.subBySubId.clear();
      this.walletByReqId.clear();
      const subs = await this.prisma.wallet.findMany({
        where: { subscribed: true, purgedAt: null },
        select: { address: true },
        take: MAX_SUBSCRIPTIONS,
      });
      for (const { address } of subs) {
        const id = this.nextReqId++;
        this.walletByReqId.set(id, address);
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'logsSubscribe',
            params: [{ mentions: [address] }, { commitment: 'confirmed' }],
          }),
        );
      }
    };

    ws.onmessage = (event) => void this.onMessage(String(event.data));
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    };
    ws.onerror = () => ws.close();
  }

  private async onMessage(raw: string) {
    let msg: {
      id?: number;
      result?: number;
      method?: string;
      params?: { subscription: number; result: { value: { signature: string; err: unknown } } };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // subscription confirmations
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const wallet = this.walletByReqId.get(msg.id);
      if (wallet) this.subBySubId.set(msg.result, wallet);
      this.walletByReqId.delete(msg.id);
      return;
    }
    if (msg.method !== 'logsNotification' || !msg.params) return;
    const wallet = this.subBySubId.get(msg.params.subscription);
    const { signature, err } = msg.params.result.value;
    if (!wallet || err) return;

    // small settle delay, then parse the tx once
    setTimeout(() => void this.ingest(wallet, signature), 2_000);
  }

  private async ingest(wallet: string, signature: string) {
    const existing = await this.prisma.liveEvent.findUnique({ where: { signature } }).catch(() => null);
    if (existing) return;
    const key = this.env.get<string>('HELIUS_API_KEY');
    const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    }).catch(() => null);
    if (!res?.ok) return;
    const [tx] = (await res.json()) as HeliusTx[];
    if (!tx) return;

    const { sol, usd, tokens } = txDeltas(wallet, tx);
    // classify from this wallet's perspective; one event per non-quote token moved
    let kind: 'buy' | 'sell' | 'other' = 'other';
    let mint: string | null = null;
    for (const [m, delta] of tokens) {
      if (delta > 0 && (sol < -SOL_EPS || usd < -USD_EPS)) {
        kind = 'buy';
        mint = m;
        break;
      }
      if (delta < 0 && (sol > SOL_EPS || usd > USD_EPS)) {
        kind = 'sell';
        mint = m;
        break;
      }
      mint = m;
    }
    if (kind === 'other' && tokens.size === 0 && Math.abs(sol) < 0.01 && Math.abs(usd) < USD_EPS) return; // noise

    this.lastEventAt = new Date();
    await this.prisma.liveEvent
      .create({
        data: {
          wallet,
          signature,
          ts: new Date((tx.timestamp || Date.now() / 1000) * 1000),
          kind,
          mint,
          sol: Math.round(sol * 1000) / 1000,
          usd: Math.round(usd * 100) / 100,
        },
      })
      .catch(() => undefined); // duplicate race is fine
  }
}
