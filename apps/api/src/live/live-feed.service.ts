import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LiveStatus } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { TradingService } from '../trading/trading.service';
import { EventsBus } from '../common/events.bus';
import { txDeltas } from '../analysis/metrics';
import type { HeliusTx } from '../analysis/helius.service';

const MAX_SUBSCRIPTIONS = 25; // standard websocket comfort zone on the free tier
const EVENT_RETENTION_MINUTES = 15; // the feed is a window, not an archive
const EVENT_MAX_ROWS = 5_000; // hard cap regardless of age
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
  private webhookSynced = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
    private readonly opportunities: OpportunitiesService,
    private readonly bus: EventsBus,
    private readonly trading: TradingService,
  ) {}

  private get webhookMode(): boolean {
    return Boolean(this.env.get('WEBHOOK_URL'));
  }

  onModuleInit() {
    // retention: prune at boot and daily — opportunities/rotations/positions keep
    // their own records, so old raw events carry no unique knowledge
    void this.pruneEvents();
    setInterval(() => void this.pruneEvents(), 5 * 60_000);
    if (!this.env.get('HELIUS_API_KEY')) return;
    if (this.webhookMode) {
      void this.syncWebhook().then(() => {
        if (!this.webhookSynced) this.connect(); // tunnel down? never go deaf — WS fallback
      });
      // drift guard: rotations and edits keep the address set moving
      setInterval(() => void this.syncWebhook(), 5 * 60_000);
    } else this.connect();
  }

  /** Create/update the Helius webhook so it carries exactly the subscribed set. No cap. */
  private async syncWebhook(): Promise<void> {
    const key = this.env.get<string>('HELIUS_API_KEY');
    const url = `${this.env.get<string>('WEBHOOK_URL')}/api/live/webhook`;
    const subs = await this.prisma.wallet.findMany({ where: { subscribed: true, purgedAt: null }, select: { address: true } });
    const addresses = subs.map((w) => w.address);
    const base = `https://api.helius.xyz/v0/webhooks?api-key=${key}`;
    const list = (await fetch(base).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as { webhookID: string; webhookURL: string }[];
    const existing = list.find((w) => w.webhookURL === url);
    const body = JSON.stringify({
      webhookURL: url,
      transactionTypes: ['ANY'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
      authHeader: this.env.get<string>('WEBHOOK_SECRET') ?? '',
    });
    const headers = { 'Content-Type': 'application/json' };
    if (existing) {
      this.webhookSynced = await fetch(`https://api.helius.xyz/v0/webhooks/${existing.webhookID}?api-key=${key}`, { method: 'PUT', headers, body })
        .then((r) => r.ok)
        .catch(() => false);
    } else if (addresses.length) {
      this.webhookSynced = await fetch(base, { method: 'POST', headers, body }).then((r) => r.ok).catch(() => false);
    }
  }

  onModuleDestroy() {
    this.closed = true;
    this.ws?.close();
  }

  async status(): Promise<LiveStatus> {
    const subscribedWallets = await this.prisma.wallet.count({ where: { subscribed: true, purgedAt: null } });
    const dayAgo = new Date(Date.now() - 86_400_000);
    return {
      ingestion: this.webhookMode ? ('webhook' as const) : ('websocket' as const),
      connected: this.webhookMode ? this.webhookSynced : this.ws?.readyState === WebSocket.OPEN,
      subscribedWallets,
      activeSubscriptions: this.subBySubId.size,
      maxSubscriptions: MAX_SUBSCRIPTIONS,
      eventsToday: await this.prisma.liveEvent.count({ where: { ts: { gte: dayAgo } } }),
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
    };
  }

  /** Called after any subscription change: re-point whichever transport is active. */
  async resync() {
    if (this.webhookMode) {
      void this.syncWebhook();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(); // reconnect path re-reads the subscribed set
    }
  }

  private async pruneEvents() {
    const cutoff = new Date(Date.now() - EVENT_RETENTION_MINUTES * 60_000);
    await this.prisma.liveEvent.deleteMany({ where: { ts: { lt: cutoff } } }).catch(() => undefined);
    const count = await this.prisma.liveEvent.count().catch(() => 0);
    if (count > EVENT_MAX_ROWS) {
      const overflow = await this.prisma.liveEvent.findMany({
        orderBy: { id: 'asc' },
        take: count - EVENT_MAX_ROWS,
        select: { id: true },
      });
      await this.prisma.liveEvent.deleteMany({ where: { id: { in: overflow.map((r) => r.id) } } }).catch(() => undefined);
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

    let failed = false; // onerror -> close() can re-fire error in undici: guard the loop
    ws.onmessage = (event) => void this.onMessage(String(event.data));
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    };
    ws.onerror = () => {
      if (failed) return;
      failed = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
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
    await this.processTx(wallet, tx);
  }

  /** Webhook path: Helius delivers the parsed tx directly — route to every subscribed wallet it touches. */
  async ingestWebhookTxs(txs: HeliusTx[]): Promise<void> {
    const subs = await this.prisma.wallet.findMany({ where: { subscribed: true, purgedAt: null }, select: { address: true } });
    const subSet = subs.map((w) => w.address);
    for (const tx of txs) {
      for (const wallet of subSet) {
        const touches =
          tx.accountData?.some((a) => a.account === wallet) ||
          tx.nativeTransfers?.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet) ||
          tx.tokenTransfers?.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet);
        if (!touches) continue;
        const existing = await this.prisma.liveEvent.findUnique({ where: { signature: tx.signature } }).catch(() => null);
        if (existing) break;
        await this.processTx(wallet, tx);
        break; // one event per tx; first touching wallet claims it
      }
    }
  }

  private async processTx(wallet: string, tx: HeliusTx) {
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
    const ts = new Date((tx.timestamp || Date.now() / 1000) * 1000);
    const event = await this.prisma.liveEvent
      .create({
        data: {
          wallet,
          signature: tx.signature,
          ts,
          kind,
          mint,
          sol: Math.round(sol * 1000) / 1000,
          usd: Math.round(usd * 100) / 100,
        },
      })
      .catch(() => null); // duplicate race is fine
    if (event) this.bus.emit('live_event');
    if (event && kind === 'sell' && mint) void this.trading.onTriggerSell(wallet, mint).catch(() => undefined);
    if (event && kind === 'buy' && mint) {
      const buySol = Math.max(0, -sol) + Math.max(0, -usd) / 180; // rough stable leg conversion
      const qty = tokens.get(mint) ?? 0;
      // the whale's own fill price in USD — the latency-cost baseline
      const whalePriceUsd = qty > 0 ? (Math.max(0, -usd) + Math.max(0, -sol) * 180) / qty : null;
      void this.opportunities.evaluate(wallet, mint, buySol, ts, event.id, whalePriceUsd).catch(() => undefined);
    }
    // owner rotation: outgoing SOL to fresh wallets is how actors spawn new addresses
    if (event) {
      const outbound = new Map<string, number>();
      for (const t of tx.nativeTransfers ?? []) {
        if (t.fromUserAccount === wallet && t.toUserAccount && t.toUserAccount !== wallet) {
          outbound.set(t.toUserAccount, (outbound.get(t.toUserAccount) ?? 0) + t.amount / 1e9);
        }
      }
      for (const [recipient, fundedSol] of outbound) {
        if (fundedSol >= 0.5) void this.opportunities.evaluateRotation(wallet, recipient, fundedSol, ts).catch(() => undefined);
      }
    }
  }
}
