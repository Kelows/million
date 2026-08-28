import { Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OpportunityConfigSchema, type OpportunityConfig, type PaperPositionRow, type TradingHalt, type TradingStats } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { EventsBus } from '../common/events.bus';
import { TRADE_EXECUTOR, type TradeExecutor } from './executor.interface';

const TICK_MS = 60_000;

/**
 * The strategy engine: opens a position per opportunity, monitors TP/SL/timeout
 * every minute, records fills and PnL. Executor-agnostic — it never knows
 * whether fills are simulated or real. Paper stats produced here are the gate
 * that will (or won't) unlock live auto-trade.
 */
@Injectable()
export class TradingService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRADE_EXECUTOR) private readonly executor: TradeExecutor,
    private readonly helius: HeliusService,
    private readonly bus: EventsBus,
  ) {}

  // last ~30 tick quotes per open position: realized volatility for the dynamic
  // trail, computed from prices we were fetching anyway — zero extra calls
  private readonly priceHistory = new Map<number, number[]>();

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async config(): Promise<OpportunityConfig> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
  }

  /** Called for every new opportunity — the feed that drives everything. */
  async openFromOpportunity(
    mint: string,
    symbol: string | null,
    wallet: string,
    whaleEntryPriceUsd: number | null = null,
    whaleBuySol: number | null = null,
    signal: string = 'copy',
  ): Promise<void> {
    const config = await this.config();
    if (!config.paperEnabled || config.positionSol <= 0) return;
    // two-key launch: the live executor refuses entries until autoTrade is ALSO
    // flipped in the UI — an env var alone must never spend real money. Exits
    // (tick/mirror) stay unaffected: an open live position must always be closable.
    if (this.executor.mode === 'live' && !config.autoTrade) {
      console.log(`[trading] skipped ${symbol ?? mint.slice(0, 8)}: live executor armed but autoTrade is OFF`);
      return;
    }
    const halt = await this.haltState(config);
    if (halt.halted) {
      console.log(`[trading] skipped ${symbol ?? mint.slice(0, 8)}: CIRCUIT BREAKER — ${halt.reason}`);
      return;
    }
    // conviction sizing, three flavors:
    //  fixed      — every position the same size
    //  whale-pct  — % of the whale's raw entry (unnormalized)
    //  whale-frac — the whale's entry as a share of THEIR bankroll, applied to OURS
    //               (normalized conviction: 100 SOL from a 10k whale is a flier,
    //                from a 120 SOL wallet it's an all-in — capped at 25%)
    let sizeSol = config.positionSol;
    if (config.sizingMode === 'whale-pct' && whaleBuySol) {
      sizeSol = Math.min(config.positionSol, Math.max(0.01, Math.round(whaleBuySol * config.copyPct) / 100));
    } else if (config.sizingMode === 'whale-frac' && whaleBuySol) {
      // cached balance first — stale beats hot-path latency; live RPC only self-heals an empty cache
      const row = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { balanceSol: true } });
      let balance = row?.balanceSol ?? null;
      if (balance === null) {
        balance = await this.helius.getBalanceSol(wallet).catch(() => null);
        if (balance !== null) {
          await this.prisma.wallet.update({ where: { address: wallet }, data: { balanceSol: balance, balanceAt: new Date() } }).catch(() => undefined);
        }
      }
      const bankrollAtEntry = (balance ?? 0) + whaleBuySol;
      const fraction = bankrollAtEntry > 0 ? Math.min(0.25, whaleBuySol / bankrollAtEntry) : 0.05;
      sizeSol = Math.min(config.positionSol, Math.max(0.01, Math.round(config.bankrollSol * fraction * 100) / 100));
    }
    const open = await this.prisma.paperPosition.findMany({ where: { status: 'open' }, select: { sizeSol: true } });
    if (open.length >= config.maxOpenPositions) {
      console.log(`[trading] skipped ${symbol ?? mint.slice(0, 8)}: maxOpenPositions (${config.maxOpenPositions}) reached`);
      return;
    }
    // FIX: portfolio exposure cap — ten positions in one meta is one bet wearing ten hats
    const exposure = open.reduce((s, p) => s + p.sizeSol, 0);
    if (exposure + sizeSol > config.maxTotalExposureSol) {
      console.log(`[trading] skipped ${symbol ?? mint.slice(0, 8)}: exposure cap (${config.maxTotalExposureSol}◎) reached`);
      return;
    }
    const dupe = await this.prisma.paperPosition.findFirst({ where: { mint, status: 'open' } });
    if (dupe) return;
    // churn guard — RULES MODE ONLY: there, losses come from OUR stop logic and
    // serial re-stop-outs are our failure loop. In the mirror modes the whale's
    // judgment is the strategy, and that includes their judgment to re-enter a
    // token they just lost on: copying means following.
    if (config.exitMode === 'rules') {
      const lastClosed = await this.prisma.paperPosition.findFirst({ where: { mint, status: 'closed' }, orderBy: { closedAt: 'desc' }, select: { closedAt: true, pnlSol: true } });
      if (lastClosed?.closedAt && (lastClosed.pnlSol ?? 0) < 0 && Date.now() - lastClosed.closedAt.getTime() < 3_600_000) {
        console.log(`[trading] skipped ${symbol ?? mint.slice(0, 8)}: lost here under an hour ago (rules-mode churn guard)`);
        return;
      }
    }
    const fill = await this.executor.buy(mint, sizeSol);
    if (!fill) return;
    await this.prisma.paperPosition.create({
      data: { mint, symbol, wallet, sizeSol, entryPriceUsd: fill.priceUsd, mode: this.executor.mode, whaleEntryPriceUsd, signal },
    });
    this.bus.emit('paper_trade', { kind: 'open', symbol, mint, sizeSol, mode: this.executor.mode, signal });
  }

  /** Mirror exits: the wallet that triggered the position just sold this mint. */
  /**
   * Asymmetric mirror: the whale's exit cuts a LOSER instantly (they are our
   * risk manager), but on a WINNER it arms a trailing stop instead — mirror
   * exits capped every winner at +14% in the first sample while losers kept
   * their full depth. Let the one fat right tail we have breathe.
   */
  async onTriggerSell(wallet: string, mint: string): Promise<void> {
    const config = await this.config();
    if (config.exitMode === 'rules') return;
    const positions = await this.prisma.paperPosition.findMany({ where: { status: 'open', mint, wallet } });
    for (const p of positions) {
      // pure mirror: the whale's judgment is the strategy — their exit is our exit, win or lose
      if (config.exitMode === 'mirror') {
        await this.closeWithFill(p.id, p.mint, p.sizeSol, 'mirror');
        continue;
      }
      // mirror-trail: their exit cuts losers instantly; a winner arms a trailing stop instead
      const price = await this.executor.quote(p.mint);
      const inProfit = price !== null && price > p.entryPriceUsd;
      if (!inProfit) {
        await this.closeWithFill(p.id, p.mint, p.sizeSol, 'mirror');
      } else if (p.peakPriceUsd === null) {
        await this.prisma.paperPosition.update({ where: { id: p.id }, data: { peakPriceUsd: price } });
        console.log(`[trading] ${p.symbol ?? mint.slice(0, 8)}: whale exited in profit — trailing ${config.trailStopPct}% instead of mirroring`);
      }
    }
  }

  /** The monitor. Rules mode: TP/SL/timeout. Mirror mode: the whale is the TP; SL and timeout stay as brakes. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const open = await this.prisma.paperPosition.findMany({ where: { status: 'open' } });
      if (!open.length) return;
      const config = await this.config();
      for (const id of [...this.priceHistory.keys()]) {
        if (!open.some((p) => p.id === id)) this.priceHistory.delete(id); // closed — drop the buffer
      }
      for (const p of open) {
        const price = await this.executor.quote(p.mint);
        if (price !== null) {
          const hist = this.priceHistory.get(p.id) ?? [];
          hist.push(price);
          if (hist.length > 30) hist.shift();
          this.priceHistory.set(p.id, hist);
        }
        if (price === null) {
          // unquotable = likely dead pool; close at total loss rather than pretend
          if (Date.now() - p.openedAt.getTime() > 3_600_000) await this.close(p.id, 'dead', 0);
          continue;
        }
        const changePct = (price / p.entryPriceUsd - 1) * 100;
        if (p.peakPriceUsd !== null) {
          // armed trailing stop: ratchet the peak, exit on the giveback.
          // The leash is volatility-scaled — a coin wicking 6%/min gets room a
          // calm one doesn't — with the configured pct as cold-start fallback,
          // and a breakeven ratchet: once a real winner (+25%), never red again.
          const peak = Math.max(p.peakPriceUsd, price);
          if (peak > p.peakPriceUsd) await this.prisma.paperPosition.update({ where: { id: p.id }, data: { peakPriceUsd: peak } });
          const trailPct = this.dynamicTrailPct(p.id, config.trailStopPct);
          const trailLine = peak * (1 - trailPct / 100);
          const breakevenLine = peak >= p.entryPriceUsd * 1.25 ? p.entryPriceUsd * 1.02 : 0;
          if (price <= Math.max(trailLine, breakevenLine)) {
            await this.closeWithFill(p.id, p.mint, p.sizeSol, 'trail');
            continue;
          }
        }
        if (config.exitMode === 'rules' && changePct >= config.takeProfitPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'tp');
        else if (changePct <= -config.stopLossPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'sl');
        else if (Date.now() - p.openedAt.getTime() > config.maxHoldHours * 3_600_000)
          await this.closeWithFill(p.id, p.mint, p.sizeSol, 'timeout');
      }
    } finally {
      this.ticking = false;
    }
  }

  private async closeWithFill(id: number, mint: string, sizeSol: number, reason: string): Promise<void> {
    const fill = await this.executor.sell(mint, sizeSol);
    if (!fill) return; // retry next tick
    await this.close(id, reason, fill.priceUsd);
  }

  private async close(id: number, reason: string, exitPriceUsd: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') return;
    const pnlPct = p.entryPriceUsd > 0 ? (exitPriceUsd / p.entryPriceUsd - 1) * 100 : -100;
    await this.prisma.paperPosition.update({
      where: { id },
      data: {
        status: 'closed',
        exitPriceUsd,
        exitReason: reason,
        closedAt: new Date(),
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
      },
    });
    this.bus.emit('paper_trade', {
      kind: 'closed',
      symbol: p.symbol,
      mint: p.mint,
      sizeSol: p.sizeSol,
      pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
      pnlPct: Math.round(pnlPct * 100) / 100,
      reason,
      mode: this.executor.mode,
    });
  }

  async closeManual(id: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') throw new NotFoundException('no such open position');
    await this.closeWithFill(p.id, p.mint, p.sizeSol, 'manual');
  }

  /** Volatility-scaled trail width: clamp(3σ of 1-min returns, 8%, 30%); fallback until the buffer warms. */
  private dynamicTrailPct(positionId: number, fallbackPct: number): number {
    const hist = this.priceHistory.get(positionId) ?? [];
    if (hist.length < 8) return fallbackPct;
    const returns = hist.slice(1).map((v, i) => v / hist[i] - 1);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const sigma = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length) * 100;
    return Math.min(30, Math.max(8, 3 * sigma));
  }

  /**
   * Book-level circuit breakers, computed fresh from closed positions so there
   * is no stored flag to drift: a loss streak since the last manual resume, or
   * a rolling-week drawdown beyond the configured share of bankroll.
   */
  async haltState(config?: OpportunityConfig): Promise<TradingHalt> {
    const cfg = config ?? (await this.config());
    const cleared = cfg.haltClearedAt ? new Date(cfg.haltClearedAt) : new Date(0);
    const closes = await this.prisma.paperPosition.findMany({
      where: { status: 'closed', closedAt: { gt: cleared } },
      orderBy: { closedAt: 'desc' },
      select: { pnlSol: true, closedAt: true },
      take: 500,
    });
    let consecutiveLosses = 0;
    for (const p of closes) {
      if ((p.pnlSol ?? 0) >= 0) break;
      consecutiveLosses++;
    }
    const weekAgo = Date.now() - 7 * 86_400_000;
    const weeklyPnlSol = closes
      .filter((p) => (p.closedAt?.getTime() ?? 0) > weekAgo)
      .reduce((sum, p) => sum + (p.pnlSol ?? 0), 0);
    const weeklyLimitSol = (cfg.bankrollSol * cfg.weeklyLossLimitPct) / 100;
    const reason =
      consecutiveLosses >= cfg.maxConsecutiveLosses
        ? `${consecutiveLosses} losses in a row (limit ${cfg.maxConsecutiveLosses})`
        : weeklyPnlSol <= -weeklyLimitSol
          ? `7-day realized ${weeklyPnlSol.toFixed(2)} ◎ breaches -${cfg.weeklyLossLimitPct}% of ${cfg.bankrollSol} ◎ bankroll`
          : null;
    return { halted: reason !== null, reason, consecutiveLosses, weeklyPnlSol: Math.round(weeklyPnlSol * 1000) / 1000 };
  }

  /** Manual resume: closes before now stop counting toward either breaker. */
  async resume(): Promise<TradingHalt> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    const cfg = OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
    const data = JSON.stringify({ ...cfg, haltClearedAt: new Date().toISOString() });
    await this.prisma.opportunityConfig.upsert({ where: { id: 1 }, create: { id: 1, data }, update: { data } });
    return this.haltState();
  }

  async overview(): Promise<{ stats: TradingStats; open: PaperPositionRow[]; closed: PaperPositionRow[]; halt: TradingHalt }> {
    const rows = await this.prisma.paperPosition.findMany({ orderBy: { id: 'desc' }, take: 300 });
    const open: PaperPositionRow[] = [];
    const closed: PaperPositionRow[] = [];
    for (const p of rows) {
      const row: PaperPositionRow = {
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        wallet: p.wallet,
        signal: p.signal,
        sizeSol: p.sizeSol,
        entryPriceUsd: p.entryPriceUsd,
        openedAt: p.openedAt.toISOString(),
        status: p.status as 'open' | 'closed',
        exitPriceUsd: p.exitPriceUsd,
        exitReason: p.exitReason,
        closedAt: p.closedAt?.toISOString() ?? null,
        pnlSol: p.pnlSol,
        pnlPct: p.pnlPct,
        mode: p.mode,
      };
      if (p.status === 'open') {
        const price = await this.executor.quote(p.mint).catch(() => null);
        row.currentPriceUsd = price;
        row.unrealizedPct = price !== null && p.entryPriceUsd > 0 ? Math.round((price / p.entryPriceUsd - 1) * 10000) / 100 : null;
        open.push(row);
      } else closed.push(row);
    }
    const wins = closed.filter((c) => (c.pnlSol ?? 0) > 0).length;
    const totalPnlSol = closed.reduce((s, c) => s + (c.pnlSol ?? 0), 0);
    const avgPnlPct = closed.length ? closed.reduce((s, c) => s + (c.pnlPct ?? 0), 0) / closed.length : null;
    const halt = await this.haltState();
    return {
      halt,
      stats: {
        mode: this.executor.mode,
        openCount: open.length,
        closedCount: closed.length,
        wins,
        winRate: closed.length ? Math.round((wins / closed.length) * 100) / 100 : null,
        totalPnlSol: Math.round(totalPnlSol * 1000) / 1000,
        avgPnlPct: avgPnlPct !== null ? Math.round(avgPnlPct * 100) / 100 : null,
        expectancySolPerTrade: closed.length ? Math.round((totalPnlSol / closed.length) * 1000) / 1000 : null,
        avgLatencyCostPct: (() => {
          const pairs = rows.filter((p) => p.whaleEntryPriceUsd && p.whaleEntryPriceUsd > 0);
          if (!pairs.length) return null;
          const costs = pairs.map((p) => (p.entryPriceUsd / p.whaleEntryPriceUsd! - 1) * 100);
          return Math.round((costs.reduce((s, x) => s + x, 0) / costs.length) * 100) / 100;
        })(),
      },
      open,
      closed,
    };
  }
}
