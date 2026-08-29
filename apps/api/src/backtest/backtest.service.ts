import { Injectable, Logger } from '@nestjs/common';
import type { BacktestMarginal, HoldBand, BacktestResult, BacktestStrategyRow, BacktestTuneResult, BacktestTuneRow, WalletMetrics } from '@million/shared';

interface TuneParams { trailPct: number; armAtPct: number; minHoldMin: number; stopLossPct: number }
import { isExcludedToken } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { GeckoTerminalService, type Candle } from '../analysis/geckoterminal.service';

// 500 minutes (8.3h) is the most GeckoTerminal returns in one call — and the
// horizon matters more than anything else here. The roster holds a median of 52
// minutes, but p75 is 12.7 HOURS and 83% of their profit comes from trades held
// past two hours. A 120-minute replay measured the least profitable 17% of
// their behaviour and concluded the strategy loses money.
const HORIZON_MIN = 500;

/**
 * Round numbers only, and few of them. A coarse grid is regularisation: it cuts
 * the degrees of freedom the search can spend on noise, keeps every candidate a
 * value you could actually type into the config, and is small enough (784
 * combinations) to search EXHAUSTIVELY — so the result is deterministic and
 * reproducible rather than a lucky draw.
 */
const GRID = {
  trailPct: [10, 20, 30, 40, 50, 60],
  armAtPct: [0, 10, 20, 30],
  minHoldMin: [0, 5, 15, 60, 180, 480],
  stopLossPct: [30, 50, 70, 90],
};

/**
 * Replay real whale entries against candles and score exit rules against each
 * other. Built because "180s minimum hold before mirroring" was a guess, and
 * guesses about exits are expensive here: 38% of the roster's profit sits in
 * the top 1% of trades, so a rule that clips tails destroys the strategy
 * silently while looking prudent.
 *
 * Entries come from the roster's own history (firstBuyAt per token) — thousands
 * of moments we could have copied — not our dozen fired signals.
 */
@Injectable()
export class BacktestService {
  private readonly log = new Logger(BacktestService.name);
  private job = { running: false, done: 0, total: 0 };
  private last: BacktestResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
    private readonly gecko: GeckoTerminalService,
  ) {}

  status() {
    return { ...this.job, result: this.last };
  }

  start(sample: number): { started: boolean } {
    if (this.job.running) return { started: false };
    this.job = { running: true, done: 0, total: 0 };
    void this.run(sample).finally(() => (this.job = { ...this.job, running: false }));
    return { started: true };
  }

  /** Each exit rule maps a post-entry candle path to a return %. */
  private strategies(): { name: string; run: (path: Candle[], entry: number) => number | null }[] {
    const trail = (pct: number, armAt = 10, minHoldMin = 0) => (path: Candle[], entry: number) => {
      let peak = entry;
      for (const [i, c] of path.entries()) {
        peak = Math.max(peak, c.close);
        if (i < minHoldMin) continue;
        if (peak >= entry * (1 + armAt / 100) && c.close <= peak * (1 - pct / 100)) return (c.close / entry - 1) * 100;
      }
      return (path[path.length - 1].close / entry - 1) * 100;
    };
    const hold = (mins: number) => (path: Candle[], entry: number) =>
      (path[Math.min(mins, path.length - 1)].close / entry - 1) * 100;
    const tpsl = (tp: number, sl: number) => (path: Candle[], entry: number) => {
      for (const c of path) {
        if (c.close >= entry * (1 + tp / 100)) return tp;
        if (c.close <= entry * (1 - sl / 100)) return -sl;
      }
      return (path[path.length - 1].close / entry - 1) * 100;
    };
    return [
      { name: 'exit @1m (reflex)', run: hold(1) },
      { name: 'exit @3m', run: hold(3) },
      { name: 'exit @15m', run: hold(15) },
      { name: 'exit @60m', run: hold(60) },
      { name: 'exit @120m', run: hold(120) },
      { name: 'exit @240m', run: hold(240) },
      { name: 'hold 500m (8h)', run: hold(500) },
      { name: 'trail 15%', run: trail(15) },
      { name: 'trail 25%', run: trail(25) },
      { name: 'trail 40%', run: trail(40) },
      { name: 'trail 25% after 3m', run: trail(25, 10, 3) },
      { name: 'TP100 / SL50', run: tpsl(100, 50) },
    ];
  }

  /**
   * Parameter search over CACHED paths. Once candles are cached, scoring a
   * strategy is arithmetic — thousands of combinations per second — so the
   * sample-efficiency that Bayesian/GP optimisation buys is not what limits us
   * here; fetching was. Random search over a bounded space is competitive with
   * grid search at a fraction of the evaluations (Bergstra & Bengio 2012) and
   * has no surrogate model to mislead us.
   *
   * The real risk is overfitting: four parameters against a few dozen entries
   * will happily memorise noise. So every candidate is fit on a train split and
   * reported on a held-out test split, and the test number is the one that counts.
   */
  async tune(): Promise<BacktestTuneResult> {
    const rows = await this.prisma.backtestPath.findMany();
    if (rows.length < 10) return { ranAt: new Date().toISOString(), paths: rows.length, tried: 0, best: [], marginals: [] };
    const paths = rows.map((r) => ({ entry: r.entryPrice, closes: JSON.parse(r.closes) as number[] }));
    const cut = Math.floor(paths.length * 0.7);
    const train = paths.slice(0, cut);
    const test = paths.slice(cut);

    const score = (set: typeof paths, p: TuneParams) => {
      const rets = set.map(({ entry, closes }) => {
        let peak = entry;
        for (let i = 0; i < closes.length; i++) {
          const c = closes[i];
          peak = Math.max(peak, c);
          if (c <= entry * (1 - p.stopLossPct / 100)) return -p.stopLossPct;
          if (i < p.minHoldMin) continue;
          if (peak >= entry * (1 + p.armAtPct / 100) && c <= peak * (1 - p.trailPct / 100)) return (c / entry - 1) * 100;
        }
        return (closes[closes.length - 1] / entry - 1) * 100;
      });
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sorted = [...rets].sort((a, b) => a - b);
      return { avg, median: sorted[Math.floor(sorted.length / 2)], winRate: rets.filter((x) => x > 0).length / rets.length };
    };

    const candidates: BacktestTuneRow[] = [];
    for (const trailPct of GRID.trailPct)
      for (const armAtPct of GRID.armAtPct)
        for (const minHoldMin of GRID.minHoldMin)
          for (const stopLossPct of GRID.stopLossPct) {
            const p = { trailPct, armAtPct, minHoldMin, stopLossPct };
            const tr = score(train, p);
            const te = score(test, p);
            candidates.push({
              ...p,
              trainAvgPct: Math.round(tr.avg * 10) / 10,
              testAvgPct: Math.round(te.avg * 10) / 10,
              testMedianPct: Math.round(te.median * 10) / 10,
              testWinRate: Math.round(te.winRate * 100),
            });
          }

    // MARGINALS matter more than the winner. With a few dozen entries the single
    // best combination is mostly luck; a parameter VALUE that performs well
    // averaged across every combination containing it is a real effect. Read
    // these first and the top table second.
    const marginals: BacktestMarginal[] = [];
    for (const [param, values] of Object.entries(GRID) as [keyof typeof GRID, number[]][]) {
      for (const value of values) {
        const subset = candidates.filter((c) => c[param] === value);
        marginals.push({
          param,
          value,
          combos: subset.length,
          avgTestPct: Math.round((subset.reduce((a, b) => a + b.testAvgPct, 0) / subset.length) * 10) / 10,
        });
      }
    }

    candidates.sort((a, b) => b.trainAvgPct - a.trainAvgPct);
    return {
      ranAt: new Date().toISOString(),
      paths: paths.length,
      tried: candidates.length,
      best: candidates.slice(0, 10),
      marginals,
    };
  }

  /**
   * Where the roster's profit lives, by how long they held. This is the fact
   * that invalidated the first backtest: median hold is under an hour, but the
   * money is in a long tail the horizon could not see. Worth having on screen
   * before anyone reasons about exits again.
   */
  async holdDistribution(): Promise<HoldBand[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { metrics: true },
    });
    const bands: { label: string; max: number }[] = [
      { label: '< 5 min', max: 5 },
      { label: '5-30 min', max: 30 },
      { label: '30-120 min', max: 120 },
      { label: '2-8 hours', max: 480 },
      { label: '8-24 hours', max: 1440 },
      { label: '1-3 days', max: 4320 },
      { label: '3+ days', max: Infinity },
    ];
    const acc = bands.map((b) => ({ ...b, trades: 0, pnlSol: 0, wins: 0 }));
    for (const w of wallets) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      if ((m.flags ?? []).includes('BOT_INFRA')) continue;
      for (const t of m.tokens) {
        if (!t.holdMinutes || t.sells === 0 || t.solIn < 1) continue;
        const band = acc.find((b) => (t.holdMinutes as number) <= b.max);
        if (!band) continue;
        band.trades++;
        band.pnlSol += t.realizedPnlSol;
        if (t.realizedPnlSol > 0) band.wins++;
      }
    }
    const total = acc.reduce((sum, b) => sum + b.pnlSol, 0) || 1;
    return acc
      .filter((b) => b.trades > 0)
      .map((b) => ({
        band: b.label,
        trades: b.trades,
        pnlSol: Math.round(b.pnlSol),
        shareOfPnlPct: Math.round((b.pnlSol / total) * 1000) / 10,
        winRate: Math.round((b.wins / b.trades) * 100),
      }));
  }

  private async run(sample: number): Promise<void> {
    const wallets = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { metrics: true },
    });
    const entries: { mint: string; at: string }[] = [];
    for (const w of wallets) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      if ((m.flags ?? []).includes('BOT_INFRA')) continue;
      for (const t of m.tokens) {
        if (!t.firstBuyAt || isExcludedToken(t.mint) || t.solIn < 1) continue;
        entries.push({ mint: t.mint, at: t.firstBuyAt });
      }
    }
    entries.sort(() => Math.random() - 0.5);
    const picked = entries.slice(0, sample);
    this.job.total = picked.length;
    this.log.log(`backtest: replaying ${picked.length} whale entries`);

    const strategies = this.strategies();
    const results = new Map<string, number[]>(strategies.map((s) => [s.name, []]));
    const poolCache = new Map<string, string | null>();
    let replayed = 0;

    for (const e of picked) {
      this.job.done++;
      let pool = poolCache.get(e.mint);
      if (pool === undefined) {
        pool = (await this.dexscreener.fetchBestPair(e.mint).catch(() => null))?.pairAddresses[0] ?? null;
        poolCache.set(e.mint, pool);
      }
      if (!pool) continue;
      const entryTs = Math.floor(new Date(e.at).getTime() / 1000);
      // cached path? then this entry costs nothing to replay again
      const cached = await this.prisma.backtestPath.findUnique({ where: { mint_entryTs: { mint: e.mint, entryTs } } }).catch(() => null);
      let closes: number[];
      let entryPrice: number;
      if (cached) {
        closes = JSON.parse(cached.closes) as number[];
        entryPrice = cached.entryPrice;
      } else {
        const candles = await this.gecko.minuteCandles(pool, entryTs + HORIZON_MIN * 60, HORIZON_MIN);
        const entryCandle = this.gecko.candleAt(candles, entryTs);
        if (!entryCandle) continue;
        const after = candles.filter((c) => c.ts >= entryCandle.ts);
        if (after.length < 5) continue;
        closes = after.map((c) => c.close);
        entryPrice = entryCandle.close;
        await this.prisma.backtestPath
          .create({ data: { mint: e.mint, entryTs, entryPrice, closes: JSON.stringify(closes) } })
          .catch(() => undefined);
      }
      const path: Candle[] = closes.map((close, i) => ({ ts: entryTs + i * 60, open: close, close }));
      if (path.length < 5) continue;
      replayed++;
      void entryPrice;
      for (const s of strategies) {
        const ret = s.run(path, entryPrice);
        if (ret !== null && Number.isFinite(ret)) results.get(s.name)!.push(ret);
      }
    }

    const rows: BacktestStrategyRow[] = strategies.map((s) => {
      const xs = results.get(s.name)!;
      const sorted = [...xs].sort((a, b) => a - b);
      const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
      return {
        strategy: s.name,
        trades: xs.length,
        avgRetPct: Math.round(avg * 10) / 10,
        medianRetPct: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : 0,
        winRate: xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : 0,
        bestPct: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
        worstPct: sorted.length ? Math.round(sorted[0]) : 0,
      };
    });
    this.last = {
      ranAt: new Date().toISOString(),
      sampled: picked.length,
      replayed,
      strategies: rows.sort((a, b) => b.avgRetPct - a.avgRetPct),
    };
    this.log.log(`backtest done: ${replayed} replayed`);
  }
}
