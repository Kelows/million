import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { whaleScore, type LiveStatus, type WalletMetrics } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { TradingService } from '../trading/trading.service';
import { toObserved } from '../wallets/wallets.service';
import { EventsBus } from '../common/events.bus';
import { orchestratedDeltas, txDeltas } from '../analysis/metrics';
import { ledgerStep } from '../analysis/ledger';
import type { HeliusTx } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';

const MAX_EVENTS_PER_WINDOW = 150; // a real trader never emits this much in 15 minutes
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
  private readonly lastTouch = new Map<string, number>(); // wallet -> ms, throttles the activity write
  private edgeDead = false; // webhook registered but deliveries not arriving (e.g. tunnel quota 403)
  private lastSyncKey = ''; // address-set + URL of the last successful PUT — identical sets skip the call
  private lastSyncAt = 0;
  private webhookSynced = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService,
    private readonly opportunities: OpportunitiesService,
    private readonly bus: EventsBus,
    private readonly trading: TradingService,
    private readonly dexscreener: DexScreenerService,
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
        if (!this.webhookSynced) {
          this.edgeDead = true; // tunnel down at boot? never go deaf — WS fallback
          this.connect();
        }
      });
      // drift guard: rotations and edits keep the address set moving
      setInterval(() => void this.syncWebhook(), 5 * 60_000);
      // deadman: Helius saying "webhook active" proves nothing about DELIVERY —
      // today's failure mode was ngrok's edge 403ing everything while every
      // health signal stayed green. Silence triggers a self-probe of the public
      // URL; a failed probe flips to the websocket so the feed never goes deaf.
      setInterval(() => void this.deadmanCheck(), 5 * 60_000);
      setInterval(() => void this.muteFloodEmitters(), 5 * 60_000);
    } else this.connect();
  }

  /** Create/update the Helius webhook so it carries exactly the subscribed set. No cap. */
  private async syncWebhook(): Promise<void> {
    const key = this.env.get<string>('HELIUS_API_KEY');
    const url = `${this.env.get<string>('WEBHOOK_URL')}/api/live/webhook`;
    // `subscribed` is the whole decision. Filtering it further here would make
    // the flag mean something different from what the UI shows — and watching a
    // brand-new unanalyzed wallet is a legitimate thing to want (following a
    // launch's insiders is exactly that). If a subscription should not exist,
    // unsubscribe it; do not quietly drop it from the feed.
    const subs = await this.prisma.wallet.findMany({ where: { subscribed: true, purgedAt: null }, select: { address: true } });
    const addresses = subs.map((w) => w.address);
    // idle economy: an unchanged set needs no management call — resync only on
    // drift, or hourly as insurance against Helius-side surprises
    const syncKey = `${url}|${addresses.slice().sort().join(',')}`;
    if (this.webhookSynced && syncKey === this.lastSyncKey && Date.now() - this.lastSyncAt < 3_600_000) return;
    const base = `https://api.helius.xyz/v0/webhooks?api-key=${key}`;
    const list = (await fetch(base).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as {
      webhookID: string;
      webhookURL: string;
      active?: boolean;
      disabledReason?: string;
    }[];
    const matches = list.filter((w) => w.webhookURL === url);
    // Helius auto-disables a webhook after 24h of failed deliveries (the API was
    // down) and never re-enables it: a PUT still returns 200 and nothing is
    // delivered — while the tunnel probe stays green, so the deadman calls it a
    // quiet roster. Only a fresh webhook recovers, so replace disabled ones;
    // duplicates would double-deliver. (The list endpoint omits addresses — read
    // a webhook by id to see them.)
    const live = matches.filter((w) => w.active !== false);
    for (const w of [...matches.filter((m) => m.active === false), ...live.slice(1)]) {
      console.error(`[live] removing webhook ${w.webhookID.slice(0, 8)} (${w.disabledReason ?? 'duplicate'})`);
      await fetch(`https://api.helius.xyz/v0/webhooks/${w.webhookID}?api-key=${key}`, { method: 'DELETE' }).catch(() => undefined);
    }
    const existing = live[0];
    const body = JSON.stringify({
      webhookURL: url,
      transactionTypes: ['SWAP', 'TRANSFER'], // ANY burned the tunnel's monthly quota on vote/stake/NFT noise
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
    if (this.webhookSynced) {
      this.lastSyncKey = syncKey;
      this.lastSyncAt = Date.now();
    }
  }

  /**
   * Flood breaker: a wallet emitting more than MAX_EVENTS_PER_WINDOW in the
   * retention window is infrastructure, not a trader — one spray bot doing 600
   * txs/minute burned 300k credits overnight. Mute it and let analysis decide
   * if it ever deserves the feed back.
   */
  private async muteFloodEmitters(): Promise<void> {
    const rows = await this.prisma.liveEvent.groupBy({
      by: ['wallet'],
      _count: { wallet: true },
      where: { ts: { gte: new Date(Date.now() - EVENT_RETENTION_MINUTES * 60_000) } },
    }).catch(() => []);
    const floods = rows.filter((r) => r._count.wallet > MAX_EVENTS_PER_WINDOW).map((r) => r.wallet);
    if (!floods.length) return;
    const muted = await this.prisma.wallet.updateMany({ where: { address: { in: floods }, subscribed: true }, data: { subscribed: false } });
    if (muted.count > 0) {
      console.error(`[live] FLOOD BREAKER muted ${muted.count} wallet(s) over ${MAX_EVENTS_PER_WINDOW} events/${EVENT_RETENTION_MINUTES}min: ${floods.map((f) => f.slice(0, 6)).join(', ')}`);
      void this.syncWebhook();
    }
  }

  /**
   * Keep the position ledger current from events we already pay for. Analysis
   * reconciles periodically; this is what stops "held across the roster" from
   * being a day-old photograph between analyses.
   */
  /**
   * Observed performance: only counts when we watched the BUY too. A position
   * seeded from analysis has an entry we never saw, so closing it tells us
   * nothing trustworthy — that asymmetry is what produced 5.7k SOL of phantom
   * profit from truncated history.
   */
  private async creditObserved(
    wallet: string,
    pnlSol: number,
    fullyObserved: boolean,
    closed: boolean,
    mint?: string,
    symbol?: string | null,
    costSol = 0,
  ): Promise<void> {
    if (!fullyObserved || !Number.isFinite(pnlSol)) return;
    if (costSol < 0.01) return; // no basis, no measurable result
    // Unanalyzed wallets carry no flags, so infra sits among them and its
    // inventory moves read as trades — 183 such trades cost -182 SOL, including
    // one at -144. Judge only wallets we have actually looked at.
    const w = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true } }).catch(() => null);
    if (!w?.metrics) return;
    if (closed && mint) {
      void this.freezeCohortBaseline(wallet);
      await this.prisma.observedTrade
        .create({ data: { wallet, mint, symbol: symbol ?? null, pnlSol: Math.round(pnlSol * 1000) / 1000, costSol } })
        .catch(() => undefined);
    }
    await this.prisma.wallet
      .update({
        where: { address: wallet },
        data: {
          observedRealizedSol: { increment: Math.round(pnlSol * 1000) / 1000 },
          ...(closed ? { observedTrades: { increment: 1 }, observedWins: { increment: pnlSol > 0 ? 1 : 0 } } : {}),
        },
      })
      .catch(() => undefined);
  }

  /**
   * The cohort experiment needs a baseline frozen at one comparable moment.
   * "At absorption" no longer works — a wallet is unmeasured then. The honest
   * equivalent is the moment it FIRST becomes scoreable, so score and forward
   * PnL are separated by the same event for every wallet.
   */
  private async freezeCohortBaseline(wallet: string): Promise<void> {
    const w = await this.prisma.wallet
      .findUnique({ where: { address: wallet }, select: { scoreAtAbsorb: true, observedRealizedSol: true, observedTrades: true, observedWins: true, metrics: true } })
      .catch(() => null);
    if (!w || w.scoreAtAbsorb !== null) return; // already frozen — never re-freeze
    const observed = toObserved(w.observedRealizedSol, w.observedTrades, w.observedWins);
    const flags = w.metrics ? ((JSON.parse(w.metrics) as WalletMetrics).flags ?? []) : [];
    const score = whaleScore(observed, flags.includes('BOT_INFRA'));
    if (score === null) return; // not measurable yet
    await this.prisma.wallet
      .update({ where: { address: wallet }, data: { scoreAtAbsorb: score, pnlAtAbsorb: observed.realizedSol } })
      .catch(() => undefined);
  }

  /** 'Last active' without rewriting the metrics blob — throttled to one write per wallet per 30s. */
  private async touchWallet(wallet: string): Promise<void> {
    const last = this.lastTouch.get(wallet) ?? 0;
    if (Date.now() - last < 30_000) return;
    this.lastTouch.set(wallet, Date.now());
    if (this.lastTouch.size > 5_000) this.lastTouch.clear(); // bounded
    await this.prisma.wallet.update({ where: { address: wallet }, data: { lastEventAt: new Date() } }).catch(() => undefined);
  }

  private async applyToLedger(wallet: string, mint: string, tokenDelta: number, sol: number, usd: number, txType: string): Promise<void> {
    if (tokenDelta === 0) return;
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
    const existing = await this.prisma.rosterPosition.findUnique({ where: { wallet_mint: { wallet, mint } } });
    // the arithmetic lives in ledgerStep so it can be checked against worked examples
    const step = ledgerStep(existing, tokenDelta, sol, usd, solUsd, txType);
    const { action } = step;
    if (action.op === 'upsert') {
      await this.prisma.rosterPosition.upsert({
        where: { wallet_mint: { wallet, mint } },
        create: { wallet, mint, qty: action.qty, costSol: action.costSol, source: 'live' },
        update: { qty: action.qty, costSol: action.costSol, source: 'live' },
      });
    } else if (action.op === 'update' && existing) {
      await this.prisma.rosterPosition
        .update({ where: { id: existing.id }, data: { qty: action.qty, costSol: action.costSol, source: 'live' } })
        .catch(() => undefined);
    } else if (action.op === 'delete' && existing) {
      await this.prisma.rosterPosition.delete({ where: { id: existing.id } }).catch(() => undefined);
    }
    if (step.realizedSol === null || !existing) return;
    if (step.closed) await this.creditObserved(wallet, step.realizedSol, existing.source === 'live', true, mint, existing.symbol, existing.costSol);
    else await this.creditObserved(wallet, step.realizedSol, existing.source === 'live', false);
  }


  private async deadmanCheck(): Promise<void> {
    if (!this.webhookMode) return;
    const quietMs = this.lastEventAt ? Date.now() - this.lastEventAt.getTime() : Infinity;
    if (quietMs < 10 * 60_000) {
      if (this.edgeDead) this.recoverWebhook();
      return; // events flowing — delivery is alive by definition
    }
    const ok = await fetch(`${this.env.get<string>('WEBHOOK_URL')}/api/live/webhook`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      if (this.edgeDead) this.recoverWebhook();
      return; // tunnel healthy, the roster is just quiet
    }
    if (!this.edgeDead) {
      this.edgeDead = true;
      console.error('[live] DEADMAN: webhook edge unreachable (tunnel down or quota exhausted) — falling back to websocket');
      this.connect();
    }
  }

  private recoverWebhook(): void {
    this.edgeDead = false;
    console.log('[live] webhook edge recovered — closing websocket fallback');
    this.ws?.close();
    this.ws = null;
  }

  onModuleDestroy() {
    this.closed = true;
    this.ws?.close();
  }

  async status(): Promise<LiveStatus> {
    const subscribedWallets = await this.prisma.wallet.count({ where: { subscribed: true, purgedAt: null } });
    const dayAgo = new Date(Date.now() - 86_400_000);
    return {
      ingestion: this.webhookMode ? (this.edgeDead ? ('webhook-fallback' as const) : ('webhook' as const)) : ('websocket' as const),
      connected:
        this.webhookMode && !this.edgeDead
          ? this.webhookSynced || (this.lastEventAt !== null && Date.now() - this.lastEventAt.getTime() < 10 * 60_000) // a failed sync PUT with events still flowing is not "down"
          : this.ws?.readyState === WebSocket.OPEN,
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
    if (this.webhookMode && !this.edgeDead) return; // webhook healthy — kills stray WS reconnect loops after recovery
    const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${key}`);
    this.ws = ws;

    ws.onopen = async () => {
      this.reconnectDelay = 1_000;
      this.subBySubId.clear();
      this.walletByReqId.clear();
      const subs = await this.prisma.wallet.findMany({
        where: { subscribed: true, purgedAt: null },
        select: { address: true },
        orderBy: [{ scoreAtAbsorb: { sort: 'desc', nulls: 'last' } }], // 25 slots — spend them on the best whales
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
    const { sol, usd, tokens } = orchestratedDeltas(wallet, tx); // fee-payer fleets: executor deltas credit the subscribed orchestrator
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
    if (event && mint) void this.applyToLedger(wallet, mint, tokens.get(mint) ?? 0, sol, usd, tx.type).catch(() => undefined);
    if (event) void this.touchWallet(wallet).catch(() => undefined);
    if (event && kind === 'sell' && mint) {
      void this.trading.onTriggerSell(wallet, mint).catch(() => undefined);
      // every roster sell is a distribution vote, not just the wallet we copied
      void this.trading.onRosterSell(mint).catch(() => undefined);
    }
    if (event && kind === 'buy' && mint) {
      // live rate: a stale constant here biases the fill-fidelity gap directly
      const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
      const buySol = Math.max(0, -sol) + Math.max(0, -usd) / solUsd;
      const qty = tokens.get(mint) ?? 0;
      // the whale's own fill price in USD — the latency-cost baseline
      const whalePriceUsd = qty > 0 ? (Math.max(0, -usd) + Math.max(0, -sol) * solUsd) / qty : null;
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
