import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Wallet } from '@prisma/client';
import { JUNK_FLAGS, openPositions, type OwnerAggregate, type WalletFlag, type WalletImport, type WalletMetrics,
  type WalletUnrealized, type WalletRecord, type WalletStatus } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { OwnersService } from '../analysis/owners.service';
import { EventsBus } from '../common/events.bus';
import { computeMetrics } from '../analysis/metrics';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helius: HeliusService,
    private readonly tokenMeta: TokenMetaService,
    private readonly dexscreener: DexScreenerService,
    private readonly owners: OwnersService,
    private readonly config: ConfigService,
    private readonly bus: EventsBus,
  ) {}

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
  private async unrealized(record: WalletRecord): Promise<WalletUnrealized | null> {
    // every open position counts toward `positions`; only those we can actually
    // value count toward `priced`, and cost is only summed for the priced ones
    // so the PnL compares like with like. The ratio is shown, never hidden.
    const open = (record.metrics?.tokens ?? []).filter((t) => t.open);
    if (!open.length) return null;
    const prices = await this.dexscreener.fetchPrices(open.map((t) => t.mint));
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
    let valueSol = 0, costSol = 0, priced = 0;
    for (const t of open) {
      const price = prices.get(t.mint);
      const cost = t.entrySol ?? 0;
      const qty = t.qty ?? 0;
      if (price === undefined || qty <= 0) continue; // unquotable, or no quantity to value — excluded, and the priced/total ratio says so
      priced++;
      costSol += cost;
      valueSol += (qty * price) / solUsd;
    }
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      positions: open.length,
      priced,
      costSol: r(costSol),
      valueSol: r(valueSol),
      pnlSol: r(valueSol - costSol),
      pnlPct: costSol > 0 ? r(((valueSol - costSol) / costSol) * 100) : null,
    };
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

  async get(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    const record = this.toRecord(wallet);
    await this.overlayLivePositions(address, record).catch(() => undefined);
    record.unrealized = await this.unrealized(record).catch(() => null);
    record.ownerSiblings = await this.owners.siblings(address);
    if (wallet.ownerId && record.ownerSiblings.length > 0) {
      record.ownerAggregate = await this.ownerAggregate(wallet.ownerId);
    }
    return record;
  }

  /** Pooled stats across every member of an owner cluster — from cached metrics, no API cost. */
  private async ownerAggregate(ownerId: number): Promise<OwnerAggregate> {
    const members = await this.prisma.wallet.findMany({ where: { ownerId, purgedAt: null } });
    let pnl = 0;
    let wins = 0;
    let closed = 0;
    const openMints = new Set<string>();
    let subscribedCount = 0;
    for (const w of members) {
      if (w.subscribed) subscribedCount++;
      if (!w.metrics) continue;
      const m = JSON.parse(w.metrics) as WalletMetrics;
      pnl += m.realizedPnlTotalSol ?? m.realizedPnlSol;
      closed += m.closedTokens;
      if (m.winRate !== null) wins += Math.round(m.winRate * m.closedTokens);
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
          ? { scoreAtAbsorb: isBotNow ? -100 : (metrics.winRate ?? 0) * 100 + Math.max(-50, Math.min(200, pnlNow)) / 2, pnlAtAbsorb: pnlNow }
          : {};
      const updated = await this.prisma.wallet.update({
        where: { address },
        data: {
          status: 'done',
          metrics: JSON.stringify(metrics),
          lastAnalyzedAt: new Date(),
          liveRealizedSol: 0, // analysis recomputed realized from scratch — the live delta is now baked in
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
      select: { address: true, metrics: true },
    });
    const junk = rows
      .filter((w) => {
        const m = JSON.parse(w.metrics as string) as WalletMetrics;
        if (m.flags.some((f) => selected.has(f))) return true;
        if (maxPnlSol !== undefined && (m.realizedPnlTotalSol ?? m.realizedPnlSol) < maxPnlSol) return true;
        if (maxMedianHoldMin !== undefined && m.medianHoldMinutes !== null && m.medianHoldMinutes < maxMedianHoldMin) return true;
        return false;
      })
      .map((w) => w.address);
    if (junk.length) await this.prisma.wallet.updateMany({ where: { address: { in: junk } }, data: { purgedAt: new Date() } });
    return { purged: junk.length };
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

  /** The cohort experiment: does score-at-absorption predict FORWARD realized PnL? */
  async cohorts(): Promise<import('@million/shared').CohortRow[]> {
    const rows = await this.prisma.wallet.findMany({
      where: { purgedAt: null, metrics: { not: null }, scoreAtAbsorb: { not: null } },
      select: { metrics: true, scoreAtAbsorb: true, pnlAtAbsorb: true },
    });
    const buckets: Record<string, { scores: number[]; fwd: number[] }> = {};
    for (const w of rows) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      const fwd = (m.realizedPnlTotalSol ?? m.realizedPnlSol) - (w.pnlAtAbsorb ?? 0);
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
      select: { address: true, metrics: true },
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
    // fold the live delta into the snapshot so the UI shows the CURRENT truth:
    // metrics is a photograph taken at the last analysis, events happened since
    if (metrics) {
      if (w.lastEventAt && (!metrics.lastSeen || w.lastEventAt.toISOString() > metrics.lastSeen)) {
        metrics.lastSeen = w.lastEventAt.toISOString();
      }
      if (w.liveRealizedSol !== 0) {
        metrics.realizedPnlSol = Math.round((metrics.realizedPnlSol + w.liveRealizedSol) * 1000) / 1000;
        if (metrics.realizedPnlTotalSol !== undefined && metrics.realizedPnlTotalSol !== null) {
          metrics.realizedPnlTotalSol = Math.round((metrics.realizedPnlTotalSol + w.liveRealizedSol) * 1000) / 1000;
        }
      }
    }
    return {
      address: w.address,
      label: w.label,
      source: w.source,
      createdAt: w.createdAt.toISOString(),
      lastAnalyzedAt: w.lastAnalyzedAt?.toISOString() ?? null,
      status: w.status as WalletStatus,
      metrics,
      liveRealizedSol: w.liveRealizedSol,
      lastEventAt: w.lastEventAt?.toISOString() ?? null,
      error: w.error,
      subscribed: w.subscribed,
      ownerId: w.ownerId,
    };
  }
}
