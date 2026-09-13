import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Wallet } from '@prisma/client';
import { JUNK_FLAGS, openPositions, type OwnerAggregate, type WalletFlag, type WalletImport, type WalletMetrics,
  type WalletActivityRow, type WalletObserved, type WalletUnrealized, type WalletRecord, type WalletStatus, type CleanChurnResult, CHURN_FLAGS, CHURN_SNIPER_MAX_MIN, CHURN_DEAD_ZONE_MIN, CHURN_DEAD_ZONE_MAX } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { OwnersService } from '../analysis/owners.service';
import { EventsBus } from '../common/events.bus';
import { computeMetrics } from '../analysis/metrics';

/** Observed stats need a minimum sample before a win rate means anything. */
/** One computation path: the 5-minute sweep writes it, everything reads it. */
export function storedUnrealized(w: Wallet): WalletUnrealized | null {
  if (w.unrealizedSol == null || w.unrealizedCostSol == null) return null;
  return {
    positions: w.unrealizedPositions ?? 0,
    priced: w.unrealizedPriced ?? 0,
    costSol: w.unrealizedCostSol,
    valueSol: Math.round((w.unrealizedCostSol + w.unrealizedSol) * 1000) / 1000,
    pnlSol: w.unrealizedSol,
    pnlPct: w.unrealizedCostSol > 0 ? Math.round((w.unrealizedSol / w.unrealizedCostSol) * 1000) / 10 : null,
  };
}

export function toObserved(realizedSol: number, trades: number, wins: number): WalletObserved {
  return {
    realizedSol: Math.round(realizedSol * 1000) / 1000,
    trades,
    wins,
    winRate: trades >= 3 ? Math.round((wins / trades) * 100) / 100 : null,
  };
}

@Injectable()
export class WalletsService implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helius: HeliusService,
    private readonly tokenMeta: TokenMetaService,
    private readonly dexscreener: DexScreenerService,
    private readonly owners: OwnersService,
    private readonly config: ConfigService,
    private readonly bus: EventsBus,
  ) {}

  private readonly log = new Logger(WalletsService.name);
  private markTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
    setTimeout(() => void this.markOpenBooks(), 45_000);
    this.markTimer = setInterval(() => void this.markOpenBooks(), 5 * 60_000);
  }

  onModuleDestroy() {
    if (this.markTimer) clearInterval(this.markTimer);
  }

  /**
   * Mark every wallet's open book to market in one pass. Pricing 1600 wallets
   * per list request is impossible; one sweep prices each distinct mint once
   * (30 per call, free) and writes the result, so the roster list gets
   * unrealized PnL for nothing.
   */
  private async markOpenBooks(): Promise<void> {
    const positions = await this.prisma.rosterPosition.findMany({ where: { qty: { gt: 0 }, costSol: { gt: 0 } } });
    if (!positions.length) return;
    const prices = await this.dexscreener.fetchPrices([...new Set(positions.map((p) => p.mint))]).catch(() => new Map<string, number>());
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
    const byWallet = new Map<string, { value: number; cost: number; positions: number; priced: number }>();
    for (const p of positions) {
      const agg = byWallet.get(p.wallet) ?? { value: 0, cost: 0, positions: 0, priced: 0 };
      agg.positions++;
      const price = prices.get(p.mint);
      if (price !== undefined) {
        // unpriceable positions count toward `positions` but not the maths, so
        // the ratio shows coverage instead of the number quietly dropping losers
        agg.priced++;
        agg.value += (p.qty * price) / solUsd;
        agg.cost += p.costSol;
      }
      byWallet.set(p.wallet, agg);
    }
    const now = new Date();
    for (const [wallet, agg] of byWallet) {
      await this.prisma.wallet
        .update({
          where: { address: wallet },
          data: {
            unrealizedSol: Math.round((agg.value - agg.cost) * 1000) / 1000,
            unrealizedCostSol: Math.round(agg.cost * 1000) / 1000,
            unrealizedPositions: agg.positions,
            unrealizedPriced: agg.priced,
            unrealizedAt: now,
          },
        })
        .catch(() => undefined);
    }
    this.log.log(`marked ${byWallet.size} open books to market`);
  }

  private pendingJob = { running: false, done: 0, total: 0 };

  async import(payload: WalletImport): Promise<{ imported: number; skipped: number }> {
    const source = payload.source ?? null;
    const entries = payload.wallets.map((w) =>
      typeof w === 'string' ? { address: w, label: null as string | null } : { address: w.address, label: w.label ?? null },
    );
    // dedupe within the payload
    const unique = new Map(entries.map((e) => [e.address, e]));

    let imported = 0;
    for (const entry of unique.values()) {
      const existing = await this.prisma.wallet.findUnique({ where: { address: entry.address } });
      if (existing) continue;
      await this.prisma.wallet.create({ data: { address: entry.address, label: entry.label, source } });
      imported++;
    }
    return { imported, skipped: unique.size - imported };
  }

  async list(): Promise<WalletRecord[]> {
    const wallets = await this.prisma.wallet.findMany({ where: { purgedAt: null }, orderBy: { createdAt: 'asc' } });
    return wallets.map((w) => this.toRecord(w));
  }

  /**
   * Mark the open book to market. Without this a pure accumulator — 924 buys,
   * zero sells, 1547 SOL deployed — scores zero and reads as a dead wallet,
   * because every metric we compute needs a completed round trip.
   */
  async activity(): Promise<WalletActivityRow[]> {
    const rows = await this.prisma.wallet.findMany({
      where: { purgedAt: null, OR: [{ lastEventAt: { not: null } }, { observedTrades: { gt: 0 } }] },
      select: { address: true, lastEventAt: true, observedRealizedSol: true, observedTrades: true, observedWins: true },
    });
    return rows.map((r) => ({
      address: r.address,
      lastEventAt: r.lastEventAt?.toISOString() ?? null,
      observedRealizedSol: r.observedRealizedSol,
      observedTrades: r.observedTrades,
      observedWins: r.observedWins,
    }));
  }

  /** Analysis is the periodic truth: replace this wallet's ledger rows wholesale. */
  private async seedPositions(address: string, metrics: WalletMetrics): Promise<void> {
    const open = metrics.tokens.filter((t) => t.open && (t.qty ?? 0) > 0);
    await this.prisma.rosterPosition.deleteMany({ where: { wallet: address } });
    if (!open.length) return;
    await this.prisma.rosterPosition.createMany({
      data: open.map((t) => ({
        wallet: address,
        mint: t.mint,
        symbol: t.symbol,
        qty: t.qty ?? 0,
        costSol: t.entrySol ?? t.solIn,
        source: 'analysis',
      })),
    });
  }

  /**
   * The per-token table is part of the same photograph as the rest of metrics.
   * Overlay the live ledger so held quantities, cost and open/closed reflect
   * what has happened since the analysis rather than what was true at it.
   */
  private async overlayLivePositions(address: string, record: WalletRecord): Promise<void> {
    if (!record.metrics) return;
    const rows = await this.prisma.rosterPosition.findMany({ where: { wallet: address } });
    if (!rows.length) return; // nothing seeded yet — trust the snapshot rather than closing everything
    const ledger = new Map(rows.map((r) => [r.mint, r]));
    for (const t of record.metrics.tokens) {
      const live = ledger.get(t.mint);
      if (live) {
        t.qty = live.qty || t.qty;
        t.entrySol = Math.round(live.costSol * 1000) / 1000;
        t.open = true;
        // the per-token table reads THIS, not metrics.lastSeen — without it a
        // token traded minutes ago still shows the analysis-era timestamp
        const touched = live.updatedAt.toISOString();
        if (live.source === 'live' && (!t.lastActivityAt || touched > t.lastActivityAt)) t.lastActivityAt = touched;
      } else if (t.open) {
        t.open = false; // sold out from under the snapshot
        t.qty = 0;
      }
    }
    // positions opened SINCE the analysis exist only in the ledger — without
    // this they are invisible on the page that is supposed to show holdings
    const known = new Set(record.metrics.tokens.map((t) => t.mint));
    for (const live of rows) {
      if (known.has(live.mint) || live.costSol <= 0) continue;
      record.metrics.tokens.push({
        mint: live.mint,
        symbol: live.symbol,
        buys: 1,
        sells: 0,
        solIn: Math.round(live.costSol * 1000) / 1000,
        solOut: 0,
        realizedPnlSol: 0,
        entrySol: Math.round(live.costSol * 1000) / 1000,
        qty: live.qty,
        holdMinutes: null,
        firstBuyAt: live.updatedAt.toISOString(),
        lastActivityAt: live.updatedAt.toISOString(),
        open: true,
      });
    }
  }

  async get(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    const record = this.toRecord(wallet);
    await this.overlayLivePositions(address, record).catch(() => undefined);
    record.unrealized = storedUnrealized(wallet);
    record.ownerSiblings = await this.owners.siblings(address);
    if (wallet.ownerId && record.ownerSiblings.length > 0) {
      record.ownerAggregate = await this.ownerAggregate(wallet.ownerId);
    }
    return record;
  }

  /** Pooled stats across an owner cluster — observed round trips, no API cost. */
  private async ownerAggregate(ownerId: number): Promise<OwnerAggregate> {
    const members = await this.prisma.wallet.findMany({ where: { ownerId, purgedAt: null } });
    let pnl = 0;
    let wins = 0;
    let closed = 0;
    const openMints = new Set<string>();
    let subscribedCount = 0;
    for (const w of members) {
      if (w.subscribed) subscribedCount++;
      // owner totals aggregate OBSERVED round trips, same basis as every other
      // number on the page — a cluster must never look better than its evidence
      pnl += w.observedRealizedSol;
      closed += w.observedTrades;
      wins += w.observedWins;
      if (!w.metrics) continue;
      const m = JSON.parse(w.metrics) as WalletMetrics;
      for (const t of openPositions(m.tokens, 0)) openMints.add(t.mint);
    }
    return {
      members: members.length,
      combinedPnlSol: Math.round(pnl * 100) / 100,
      winRate: closed ? Math.round((wins / closed) * 100) / 100 : null,
      closedTokens: closed,
      openTokens: openMints.size,
      subscribedCount,
    };
  }

  /** Subscribe (or unsubscribe) every member of the owner cluster this wallet belongs to. */
  async setOwnerSubscribed(address: string, subscribed: boolean): Promise<{ affected: number }> {
    const me = await this.prisma.wallet.findUnique({ where: { address }, select: { ownerId: true } });
    if (!me) throw new NotFoundException(`wallet ${address} is not in the roster`);
    const where = me.ownerId ? { ownerId: me.ownerId, purgedAt: null } : { address };
    const result = await this.prisma.wallet.updateMany({ where, data: { subscribed } });
    return { affected: result.count };
  }

  async analyze(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    if (wallet.status === 'analyzing') throw new ConflictException(`analysis already running for ${address}`);

    await this.prisma.wallet.update({ where: { address }, data: { status: 'analyzing', error: null } });
    try {
      const maxPages = Number(this.config.get('ANALYSIS_MAX_PAGES') ?? 5);
      const [{ txs, truncated }, solPrice, stats, balanceSol] = await Promise.all([
        this.helius.fetchHistory(address, maxPages),
        this.dexscreener.fetchSolPriceUsd(),
        this.helius.accountStats(address).catch(() => null),
        this.helius.getBalanceSol(address).catch(() => null),
      ]);
      if (txs.length === 0 && truncated) {
        // rate-limited into emptiness — an empty 'done' analysis poisons scores silently
        throw new ServiceUnavailableException('rate limited while fetching history — re-run analysis');
      }
      const metrics = computeMetrics(address, txs, truncated, solPrice);
      if (stats) {
        metrics.lifetimeTxs = stats.txs;
        metrics.lifetimeCapped = stats.capped;
        metrics.accountFirstTxAt = stats.firstTxAt;
      }
      const symbols = await this.tokenMeta.getSymbols(metrics.tokens.map((t) => t.mint)).catch(() => new Map<string, string>());
      for (const t of metrics.tokens) t.symbol = symbols.get(t.mint) ?? null;
      // owner evidence rides along for free — same txs we just fetched
      await this.owners.extractEdges(address, txs, metrics).catch(() => undefined);
      const existing = await this.prisma.wallet.findUnique({ where: { address }, select: { scoreAtAbsorb: true } });
      const pnlNow = metrics.realizedPnlTotalSol ?? metrics.realizedPnlSol;
      const isBotNow = metrics.flags.some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS');
      const cohort =
        existing?.scoreAtAbsorb == null
          ? { scoreAtAbsorb: null, pnlAtAbsorb: null } // set once the wallet has enough OBSERVED trades to score
          : {};
      const updated = await this.prisma.wallet.update({
        where: { address },
        data: {
          status: 'done',
          metrics: JSON.stringify(metrics),
          lastAnalyzedAt: new Date(),
          error: null,
          ...cohort,
          ...(balanceSol !== null ? { balanceSol, balanceAt: new Date() } : {}),
        },
      });
      await this.seedPositions(address, metrics).catch(() => undefined);
      return this.toRecord(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'analysis failed';
      await this.prisma.wallet.update({ where: { address }, data: { status: 'error', error: message } });
      throw err;
    }
  }

  /** Soft-delete wallets matching any selected flag OR under the PnL floor: hidden everywhere, knowledge kept. */
  async purgeJunk(flags: WalletFlag[] = JUNK_FLAGS, maxPnlSol?: number, maxMedianHoldMin?: number): Promise<{ purged: number }> {
    const selected = new Set(flags);
    const rows = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, metrics: true, observedRealizedSol: true },
    });
    const junk = rows
      .filter((w) => {
        const m = JSON.parse(w.metrics as string) as WalletMetrics;
        if (m.flags.some((f) => selected.has(f))) return true;
        if (maxPnlSol !== undefined && w.observedRealizedSol < maxPnlSol) return true; // observed, not the historical scan
        if (maxMedianHoldMin !== undefined && m.medianHoldMinutes !== null && m.medianHoldMinutes < maxMedianHoldMin) return true;
        return false;
      })
      .map((w) => w.address);
    if (junk.length) await this.prisma.wallet.updateMany({ where: { address: { in: junk } }, data: { purgedAt: new Date() } });
    return { purged: junk.length };
  }

  /**
   * Unsubscribe wallets whose trading STYLE cannot produce a tail. Deliberately
   * option-free: the bands come from measurement, not preference, and a knob
   * would only invite tuning them by feel.
   *
   * Unsubscribes rather than purges — the webhook cost stops, but the wallet
   * stays visible as known-bad so it is not re-absorbed later, and so this is
   * reversible if the style finding changes.
   *
   * Style is the ONLY stable predictor we have: realized returns anti-predict
   * (corr -0.44 between a wallet's first and second half), while median hold is
   * a property of how it trades.
   */
  async cleanChurn(): Promise<CleanChurnResult> {
    const rows = await this.prisma.wallet.findMany({
      where: { subscribed: true, purgedAt: null, metrics: { not: null } },
      select: { address: true, metrics: true },
    });
    const reasons = new Map<string, string>();
    for (const w of rows) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      const flag = CHURN_FLAGS.find((f) => (m.flags ?? []).includes(f));
      const h = m.medianHoldMinutes;
      if (flag) reasons.set(w.address, flag.toLowerCase().replace(/_/g, ' '));
      else if (h !== null && h < CHURN_SNIPER_MAX_MIN) reasons.set(w.address, 'sniper (<5 min) — uncopyable at our latency');
      else if (h !== null && h >= CHURN_DEAD_ZONE_MIN && h < CHURN_DEAD_ZONE_MAX)
        reasons.set(w.address, 'dead zone (30 min-2 h) — 0.25% tail rate, negative median');
    }
    const addresses = [...reasons.keys()];
    if (addresses.length) await this.prisma.wallet.updateMany({ where: { address: { in: addresses } }, data: { subscribed: false } });
    const byReason = [...new Set(reasons.values())]
      .map((reason) => ({ reason, count: [...reasons.values()].filter((r) => r === reason).length }))
      .sort((a, b) => b.count - a.count);
    const remainingSubscribed = await this.prisma.wallet.count({ where: { subscribed: true, purgedAt: null } });
    return { unsubscribed: addresses.length, byReason, remainingSubscribed };
  }

  /** Server-side batch: analyze everything pending, survives the browser leaving. */
  startAnalyzePending(): { started: boolean } {
    if (this.pendingJob.running) return { started: false };
    this.pendingJob = { running: true, done: 0, total: 0 };
    void (async () => {
      try {
        const pending = await this.prisma.wallet.findMany({
          where: { purgedAt: null, metrics: null, status: { in: ['idle', 'error'] } },
          select: { address: true },
        });
        this.pendingJob.total = pending.length;
        for (const { address } of pending) {
          await this.analyze(address).catch(() => undefined);
          this.pendingJob.done++;
          this.bus.emit('wallet_analyzed');
          await new Promise((r) => setTimeout(r, 300)); // gentle on rate limits
        }
      } finally {
        this.pendingJob.running = false;
        this.bus.emit('wallet_analyzed');
      }
    })();
    return { started: true };
  }

  getAnalyzePendingStatus() {
    return this.pendingJob;
  }

  /**
   * The cohort experiment: does a wallet's score, frozen the moment it FIRST
   * became measurable, predict what it earns afterwards? Baseline and forward
   * PnL are both observed, so the question is answered on one consistent basis.
   */
  async cohorts(): Promise<import('@million/shared').CohortRow[]> {
    const rows = await this.prisma.wallet.findMany({
      where: { purgedAt: null, scoreAtAbsorb: { not: null } },
      select: { scoreAtAbsorb: true, pnlAtAbsorb: true, observedRealizedSol: true },
    });
    const buckets: Record<string, { scores: number[]; fwd: number[] }> = {};
    for (const w of rows) {
      // forward PnL is OBSERVED since the baseline was frozen — the old version
      // subtracted historical PnL, which moved for reasons unrelated to skill
      const fwd = w.observedRealizedSol - (w.pnlAtAbsorb ?? 0);
      const sc = w.scoreAtAbsorb ?? 0;
      const bucket = sc < 40 ? '<40' : sc < 70 ? '40-70' : sc < 110 ? '70-110' : '110+';
      (buckets[bucket] ??= { scores: [], fwd: [] });
      buckets[bucket].scores.push(sc);
      buckets[bucket].fwd.push(fwd);
    }
    return Object.entries(buckets).map(([bucket, b]) => {
      const sorted = [...b.fwd].sort((x, y) => x - y);
      return {
        bucket,
        wallets: b.fwd.length,
        avgScoreAtAbsorb: Math.round(b.scores.reduce((s2, x) => s2 + x, 0) / b.scores.length),
        avgForwardPnlSol: Math.round((b.fwd.reduce((s2, x) => s2 + x, 0) / b.fwd.length) * 100) / 100,
        medianForwardPnlSol: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
      };
    }).sort((a, b) => a.avgScoreAtAbsorb - b.avgScoreAtAbsorb);
  }

  async setLabel(address: string, label: string | null): Promise<WalletRecord> {
    const updated = await this.prisma.wallet.update({ where: { address }, data: { label } }).catch(() => {
      throw new NotFoundException(`wallet ${address} is not in the roster`);
    });
    return this.toRecord(updated);
  }

  /** Sub every wallet worth streaming: analyzed, not purged, not infra. */
  async subscribeAll(): Promise<number> {
    const rows = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null, subscribed: false },
      select: { address: true, metrics: true, observedRealizedSol: true },
    });
    const eligible = rows
      .filter((w) => !((JSON.parse(w.metrics as string) as WalletMetrics).flags ?? []).includes('BOT_INFRA'))
      .map((w) => w.address);
    if (eligible.length) await this.prisma.wallet.updateMany({ where: { address: { in: eligible } }, data: { subscribed: true } });
    return eligible.length;
  }

  async unsubscribeAll(): Promise<number> {
    const r = await this.prisma.wallet.updateMany({ where: { subscribed: true }, data: { subscribed: false } });
    return r.count;
  }

  async setSubscribed(address: string, subscribed: boolean): Promise<WalletRecord> {
    const updated = await this.prisma.wallet.update({ where: { address }, data: { subscribed } }).catch(() => {
      throw new NotFoundException(`wallet ${address} is not in the roster`);
    });
    return this.toRecord(updated);
  }

  async remove(address: string): Promise<void> {
    await this.prisma.wallet.delete({ where: { address } }).catch(() => {
      throw new NotFoundException(`wallet ${address} is not in the roster`);
    });
  }

  status(): { heliusConfigured: boolean } {
    return { heliusConfigured: this.helius.hasKey };
  }

  private toRecord(w: Wallet): WalletRecord {
    const metrics = w.metrics ? (JSON.parse(w.metrics) as WalletMetrics) : null;
    // metrics is a photograph of a truncated history: good for flags, not for
    // PnL. Only lastSeen is worth refreshing from the feed; performance comes
    // from `observed` below, which is built solely from trades we watched.
    if (metrics && w.lastEventAt && (!metrics.lastSeen || w.lastEventAt.toISOString() > metrics.lastSeen)) {
      metrics.lastSeen = w.lastEventAt.toISOString();
    }
    return {
      address: w.address,
      label: w.label,
      source: w.source,
      createdAt: w.createdAt.toISOString(),
      lastAnalyzedAt: w.lastAnalyzedAt?.toISOString() ?? null,
      status: w.status as WalletStatus,
      metrics,
      observed: toObserved(w.observedRealizedSol, w.observedTrades, w.observedWins),
      unrealizedSol: w.unrealizedSol,
      unrealizedCostSol: w.unrealizedCostSol,
      lastEventAt: w.lastEventAt?.toISOString() ?? null,
      error: w.error,
      subscribed: w.subscribed,
      ownerId: w.ownerId,
    };
  }
}
