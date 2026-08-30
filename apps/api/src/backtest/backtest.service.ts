import { Injectable, Logger } from '@nestjs/common';
import type { BacktestMarginal, HoldBand, BacktestResult, BacktestStrategyRow, BacktestTuneResult, BacktestTuneRow, TokenReport, WalletMetrics } from '@million/shared';

interface TuneParams { trailPct: number; armAtPct: number; stopLossPct: number; takeProfitPct: number }
import { isExcludedToken, TokenCheckThresholdsSchema } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { GeckoTerminalService, type Candle } from '../analysis/geckoterminal.service';
import { TokenCheckService } from '../screener/token-check.service';

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
  // Every value here must be TYPEABLE into the trading config, and every
  // parameter must MAP to a real field — a search that recommends a setting the
  // system cannot express is a search that wasted its run.
  //   trailPct     -> opportunity.trailStopPct  (schema max 50)
  //   armAtPct     -> opportunity.trailArmPct   (schema 0-100)
  //   stopLossPct  -> opportunity.stopLossPct   (schema 1-100; 100 = no stop)
  //   takeProfitPct-> opportunity.takeProfitPct (schema min 1; 9999 = off)
  // The old grid searched trailPct up to 60 — above the schema ceiling, so its
  // top rows were unreachable — and tuned a `minHoldMin` that no config field
  // exists for, spending a quarter of the search space on an unusable knob.
  trailPct: [10, 15, 20, 25, 30, 40, 50],
  armAtPct: [0, 10, 20, 30, 50, 75, 100],
  stopLossPct: [30, 50, 70, 90, 100],
  takeProfitPct: [50, 100, 200, 500, 9999],
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
/** Fisher-Yates. A comparator returning random is not a shuffle — it biases
 * toward the original order, which would quietly skew every sample. */
function shuffle<T>(xs: T[]): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
}

@Injectable()
export class BacktestService {
  private readonly log = new Logger(BacktestService.name);
  private job = { running: false, done: 0, total: 0 };
  private last: BacktestResult | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
    private readonly gecko: GeckoTerminalService,
    private readonly tokenCheck: TokenCheckService,
  ) {}

  async status() {
    if (!this.last) {
      // survive restarts: a 20-minute rate-limited run should not lose its
      // output to a process bounce
      const row = await this.prisma.backtestRun.findFirst({ orderBy: { id: 'desc' } }).catch(() => null);
      if (row) this.last = JSON.parse(row.payload) as BacktestResult;
    }
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
    // Scale out: sell fractions as targets are hit, the rest rides. This is the
    // laddered exit the roster actually uses — closest we can get to their game.
    const scale = (levels: [number, number][], trailRest?: number) => (path: Candle[], entry: number) => {
      let remaining = 1;
      let realized = 0;
      let peak = entry;
      const hit = levels.map(() => false);
      for (const c of path) {
        peak = Math.max(peak, c.close);
        levels.forEach(([gain, frac], i) => {
          if (!hit[i] && c.close >= entry * (1 + gain / 100)) {
            hit[i] = true;
            realized += frac * gain;
            remaining -= frac;
          }
        });
        if (trailRest && remaining > 0 && peak >= entry * 1.1 && c.close <= peak * (1 - trailRest / 100)) {
          return realized + remaining * ((c.close / entry - 1) * 100);
        }
      }
      return realized + remaining * ((path[path.length - 1].close / entry - 1) * 100);
    };
    return [
      { name: 'exit @1m (reflex)', run: hold(1) },
      { name: 'exit @15m', run: hold(15) },
      { name: 'exit @60m', run: hold(60) },
      { name: 'exit @240m', run: hold(240) },
      { name: 'hold 500m (8h)', run: hold(500) },
      // arm thresholds: how far up before the trail engages at all. Measured
      // best at +10% — a high bar leaves everything below it unprotected, and
      // the median peak is only ~+14%, so most winners never get insured.
      { name: 'trail 20% · arm +10%', run: trail(20, 10) },
      { name: 'trail 20% · arm +20%', run: trail(20, 20) },
      { name: 'trail 20% · arm +30%', run: trail(20, 30) },
      { name: 'trail 20% · arm +40%', run: trail(20, 40) },
      { name: 'trail 20% · arm +50%', run: trail(20, 50) },
      { name: 'trail 15% · arm +10%', run: trail(15, 10) },
      { name: 'trail 30% · arm +10%', run: trail(30, 10) },
      { name: 'trail 50% · no arm', run: trail(50, 0) },
      { name: 'TP100 / SL50', run: tpsl(100, 50) },
      // "their game": hold through drawdown, ladder out. High mean, brutal
      // median, and every one collapses when its single best trade is removed.
      { name: 'their: half at +100%, rest holds', run: scale([[100, 0.5]]) },
      { name: 'their: half +100%, rest trail 30%', run: scale([[100, 0.5]], 30) },
      { name: 'their: thirds +50 / +200', run: scale([[50, 0.34], [200, 0.33]]) },
      { name: 'their: quarters +50 / +100 / +300', run: scale([[50, 0.25], [100, 0.25], [300, 0.25]]) },
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
    const rows = await this.prisma.backtestPath.findMany({ where: { resolution: 'minute' } });
    if (rows.length < 10) return { ranAt: new Date().toISOString(), paths: rows.length, tried: 0, best: [], marginals: [] };
    const paths = rows.map((r) => ({ entry: r.entryPrice, closes: JSON.parse(r.closes) as number[] }));
    const cut = Math.floor(paths.length * 0.7);
    const train = paths.slice(0, cut);
    const test = paths.slice(cut);

    const score = (set: typeof paths, p: TuneParams) => {
      const rets = set.map(({ entry, closes }) => {
        let peak = entry;
        for (const c of closes) {
          peak = Math.max(peak, c);
          if (p.stopLossPct < 100 && c <= entry * (1 - p.stopLossPct / 100)) return -p.stopLossPct;
          if (c >= entry * (1 + p.takeProfitPct / 100)) return p.takeProfitPct;
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
        for (const stopLossPct of GRID.stopLossPct)
          for (const takeProfitPct of GRID.takeProfitPct) {
            const p = { trailPct, armAtPct, stopLossPct, takeProfitPct };
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
  /**
   * Swing backtest: hourly bars, so the horizon reaches DAYS instead of the
   * minute endpoint's 8.3 hours. This is the only way to test the band the
   * roster actually earns in — holds past 24h carry 61% of their profit, and
   * every conclusion we have drawn so far was blind to it.
   */
  /**
   * minSol defaults to 0 — the unfiltered population. The 1 SOL floor that used
   * to be hardcoded here is a STRATEGY choice, and baking a strategy into the
   * sample means no cohort can ever be measured against its absence.
   *
   * BOT_INFRA stays excluded at every setting: an AMM pool's "first buy" is not
   * a trade anyone could have copied, so it is bad data rather than a bold bet.
   */
  async runSwing(sample: number, minSol = 0): Promise<void> {
    const wallets = await this.prisma.wallet.findMany({ where: { metrics: { not: null }, purgedAt: null }, select: { metrics: true } });
    const entries: { mint: string; at: string }[] = [];
    for (const w of wallets) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      if ((m.flags ?? []).includes('BOT_INFRA')) continue;
      for (const t of m.tokens) {
        if (!t.firstBuyAt || isExcludedToken(t.mint) || t.solIn < minSol) continue;
        // an entry needs room to develop: skip anything too recent to have days of history
        if (Date.now() - new Date(t.firstBuyAt).getTime() < 36 * 3_600_000) continue;
        entries.push({ mint: t.mint, at: t.firstBuyAt });
      }
    }
    shuffle(entries);
    const picked = entries.slice(0, sample);
    this.job = { running: true, done: 0, total: picked.length };
    const poolCache = new Map<string, string | null>();
    for (const e of picked) {
      this.job.done++;
      const entryTs = Math.floor(new Date(e.at).getTime() / 1000);
      const existing = await this.prisma.backtestPath
        .findUnique({ where: { mint_entryTs_resolution: { mint: e.mint, entryTs, resolution: 'hour' } } })
        .catch(() => null);
      if (existing) continue;
      let pool = poolCache.get(e.mint);
      if (pool === undefined) {
        pool = (await this.dexscreener.fetchBestPair(e.mint).catch(() => null))?.pairAddresses[0] ?? null;
        poolCache.set(e.mint, pool);
      }
      if (!pool) continue;
      const candles = await this.gecko.hourCandles(pool, entryTs + 14 * 24 * 3600, 400);
      const entryCandle = this.gecko.candleAt(candles, entryTs, 2 * 3600);
      if (!entryCandle) continue;
      const after = candles.filter((c) => c.ts >= entryCandle.ts);
      if (after.length < 6) continue;
      await this.prisma.backtestPath
        .create({
          data: { mint: e.mint, entryTs, entryPrice: entryCandle.close, closes: JSON.stringify(after.map((c) => c.close)), resolution: 'hour' },
        })
        .catch(() => undefined);
    }
    this.job = { ...this.job, running: false };
  }

  /** Swing strategies scored over the hourly paths — one bar is an hour here. */
  async swingResults(): Promise<BacktestStrategyRow[]> {
    const rows = await this.prisma.backtestPath.findMany({ where: { resolution: 'hour' } });
    const paths = rows.map((r) => ({ entry: r.entryPrice, closes: JSON.parse(r.closes) as number[] })).filter((p) => p.entry > 0 && p.closes.length >= 6);
    if (!paths.length) return [];
    // stop = 0 disables the stop. Treating it as a level makes it "sell the
    // moment price touches entry", which is a different strategy entirely.
    const trail = (pct: number, arm = 20, stop = 50) => (e: number, c: number[]) => {
      let peak = e;
      for (const x of c) {
        peak = Math.max(peak, x);
        if (stop > 0 && x <= e * (1 - stop / 100)) return -stop;
        if (peak >= e * (1 + arm / 100) && x <= peak * (1 - pct / 100)) return (x / e - 1) * 100;
      }
      return (c[c.length - 1] / e - 1) * 100;
    };
    const strategies: [string, (e: number, c: number[]) => number | null][] = [
      // Fixed-duration holds are gone. Every one of them lost, and they lost
      // WORSE the longer they ran (24h -22.5%, 3d -50.5%) -- because holding for
      // a duration copies the roster's holding PERIOD without copying the exit
      // DECISION that produced it. Their long-hold profit comes from cutting
      // losers early and letting winners run; a clock does neither.
      //
      // What is left varies the two things that actually respond: how far the
      // trail sits from the peak, and how high price must go before it arms.
      ['swing: trail 15% · arm +20%', trail(15)],
      ['swing: trail 20% · arm +20%', trail(20)],
      ['swing: trail 25% · arm +20%', trail(25)],
      ['swing: trail 30% · arm +20%', trail(30)],
      ['swing: trail 40% · arm +20%', trail(40)],
      ['swing: trail 20% · arm +0%', trail(20, 0)],
      ['swing: trail 20% · arm +50%', trail(20, 50)],
      ['swing: trail 20% · arm +100%', trail(20, 100)],
      ['swing: trail 20% · stop 30%', trail(20, 20, 30)],
      ['swing: trail 20% · stop 70%', trail(20, 20, 70)],
      ['swing: trail 20% · no stop', trail(20, 20, 0)],
    ];
    return strategies
      .map(([strategy, f]) => {
        const xs = paths.map((p) => f(p.entry, p.closes)).filter((x): x is number => x !== null);
        if (!xs.length) return { strategy, trades: 0, avgRetPct: 0, medianRetPct: 0, winRate: 0, bestPct: 0, worstPct: 0 };
        const sorted = [...xs].sort((a, b) => a - b);
        return {
          strategy,
          trades: xs.length,
          avgRetPct: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
          medianRetPct: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
          winRate: Math.round((xs.filter((x) => x > 0).length / xs.length) * 100),
          bestPct: Math.round(sorted[sorted.length - 1]),
          worstPct: Math.round(sorted[0]),
        };
      })
      // horizons no path is long enough to reach score 0 by default — park them
      // at the bottom rather than letting an unmeasured row top the table
      .sort((a, b) => Number(b.trades > 0) - Number(a.trades > 0) || b.avgRetPct - a.avgRetPct);
  }

  /**
   * Entry FILTERS scored against each other, holding the exit rule fixed
   * (trail 20% hourly — the only swing rule that is not underwater). Every row
   * answers one question: does this gate earn its exclusions?
   *
   * ── Why "gauntlet pass" is marked contaminated ──────────────────────────────
   * The gauntlet is a PRESENT-TENSE check. Token.lastReport holds liquidity,
   * market cap, holder concentration and a sell simulation as they are TODAY,
   * not as they were at entry. A token that rugged after we would have bought
   * it now has no liquidity and fails its own sell-sim — so filtering on
   * "gauntlet passes" silently deletes the losers from the sample. The row is
   * reported because seeing the size of that lift is the clearest possible
   * demonstration of the bias, but it is NOT a result and must never be used to
   * justify a gate.
   *
   * Pair age is the one gate reconstructable exactly: pairCreatedAt is fixed at
   * launch, so age-at-entry is arithmetic on the entry timestamp. Those rows
   * are honest and can be acted on.
   */
  /**
   * Run the gauntlet on backtest mints that have never been checked, so the
   * cohorts stop being n=2. Costs ~5 RPC credits per token (no Enhanced API
   * calls), and the check is cache-aware, so re-running is nearly free.
   *
   * Coverage is the ONLY thing this buys. It does not make the market-facing
   * checks time-honest — see entryCohorts() — so the one-way cohort is where
   * the extra datapoints actually land.
   */
  async backfillReports(limit = 100): Promise<{ checked: number; skipped: number; failed: number }> {
    const rows = await this.prisma.backtestPath.findMany({ select: { mint: true }, distinct: ['mint'] });
    const known = await this.prisma.token.findMany({
      where: { mint: { in: rows.map((r) => r.mint) }, lastReport: { not: null } },
      select: { mint: true },
    });
    const have = new Set(known.map((t) => t.mint));
    const todo = rows.map((r) => r.mint).filter((m) => !have.has(m) && !isExcludedToken(m)).slice(0, limit);
    this.log.log(`gauntlet backfill: ${todo.length} mints without a report`);
    let checked = 0;
    let failed = 0;
    for (const mint of todo) {
      const report = await this.tokenCheck.check(mint, TokenCheckThresholdsSchema.parse({})).catch(() => null);
      if (!report) {
        failed++;
        continue;
      }
      await this.prisma.token
        .upsert({
          where: { mint },
          create: { mint, symbol: report.symbol, name: report.name, lastReport: JSON.stringify(report), lastCheckedAt: new Date() },
          update: { lastReport: JSON.stringify(report), lastCheckedAt: new Date() },
        })
        .catch(() => undefined);
      checked++;
      await new Promise((r) => setTimeout(r, 250)); // stay polite to RugCheck/DexScreener
    }
    this.log.log(`gauntlet backfill: ${checked} checked, ${failed} failed`);
    return { checked, skipped: rows.length - todo.length, failed };
  }

  async entryCohorts(): Promise<BacktestStrategyRow[]> {
    const rows = await this.prisma.backtestPath.findMany({ where: { resolution: 'hour' } });
    if (!rows.length) return [];
    const tokens = await this.prisma.token.findMany({
      where: { mint: { in: [...new Set(rows.map((r) => r.mint))] } },
      select: { mint: true, lastReport: true },
    });
    const meta = new Map(
      tokens.map((t) => {
        const rep = t.lastReport ? (JSON.parse(t.lastReport) as TokenReport) : null;
        const st = (id: string) => rep?.checks.find((c) => c.id === id)?.status ?? null;
        // Authority revocation is a ONE-WAY door: active -> revoked, never back.
        // So "active today" proves "active at entry" (excluding is exact), while
        // "revoked today" does not prove revoked at entry (admitting may let in
        // a token that was unsafe then). That error only ever ADMITS extra risk,
        // so this cohort's return is a LOWER bound on the real filter -- a bias
        // that is safe to act on, unlike the market checks.
        const oneWayClean =
          rep !== null && (['mint-authority', 'freeze-authority', 'token-program'] as const).every((id) => {
            const v = st(id);
            return v === 'pass' || v === 'warn';
          });
        return [t.mint, { verdict: rep?.verdict ?? null, pairCreatedAt: rep?.pairCreatedAt ?? null, oneWayClean }];
      }),
    );
    const paths = rows
      .filter((r) => r.entryPrice > 0)
      .map((r) => {
        const m = meta.get(r.mint);
        const created = m?.pairCreatedAt ? new Date(m.pairCreatedAt).getTime() : null;
        return {
          entry: r.entryPrice,
          closes: JSON.parse(r.closes) as number[],
          verdict: m?.verdict ?? null,
          oneWayClean: m?.oneWayClean ?? false,
          hasReport: m !== undefined && m.verdict !== null,
          ageMin: created ? (r.entryTs * 1000 - created) / 60_000 : null,
        };
      })
      .filter((p) => p.closes.length >= 6);

    // fixed exit so the rows differ ONLY by which entries they admit
    const exit = (e: number, c: number[]) => {
      let peak = e;
      for (const x of c) {
        peak = Math.max(peak, x);
        if (x <= e * 0.5) return -50;
        if (peak >= e * 1.2 && x <= peak * 0.8) return (x / e - 1) * 100;
      }
      return (c[c.length - 1] / e - 1) * 100;
    };
    type P = (typeof paths)[number];
    const cohorts: [string, (p: P) => boolean][] = [
      ['no filter — every entry', () => true],
      ['checked universe (has a report)', (p) => p.hasReport],
      ['authorities clean — TIME-HONEST', (p) => p.oneWayClean],
      ['authorities live — TIME-HONEST', (p) => p.hasReport && !p.oneWayClean],
      ['gauntlet pass/warn ⚠ LOOK-AHEAD', (p) => p.verdict !== null && p.verdict !== 'fail'],
      ['gauntlet fail ⚠ LOOK-AHEAD', (p) => p.verdict === 'fail'],
      ['pair < 60 min at entry', (p) => p.ageMin !== null && p.ageMin < 60],
      ['pair 1–24 h at entry', (p) => p.ageMin !== null && p.ageMin >= 60 && p.ageMin < 1440],
      ['pair > 24 h at entry', (p) => p.ageMin !== null && p.ageMin >= 1440],
    ];
    return cohorts.map(([strategy, keep]) => {
      const xs = paths.filter(keep).map((p) => exit(p.entry, p.closes));
      if (!xs.length) return { strategy, trades: 0, avgRetPct: 0, medianRetPct: 0, winRate: 0, bestPct: 0, worstPct: 0 };
      const sorted = [...xs].sort((a, b) => a - b);
      return {
        strategy,
        trades: xs.length,
        avgRetPct: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
        medianRetPct: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
        winRate: Math.round((xs.filter((x) => x > 0).length / xs.length) * 100),
        bestPct: Math.round(sorted[sorted.length - 1]),
        worstPct: Math.round(sorted[0]),
      };
    });
  }

  /**
   * Entry filter × exit rule. Every other table here varies one and fixes the
   * other, which cannot show that the best exit DEPENDS on the entry.
   *
   * The mirror exits are the important part: holdMinutes on a whale's token row
   * is first-buy -> last-sell, so replaying it against the candle path finally
   * models the exit mode we actually run. Until now the backtest could only
   * score rules-style exits, and we run mirror-trail -- it was grading a
   * strategy we do not trade.
   */
  async exitMatrix(): Promise<BacktestStrategyRow[]> {
    const rows = await this.prisma.backtestPath.findMany({ where: { resolution: 'minute' } });
    if (!rows.length) return [];
    const tokens = await this.prisma.token.findMany({
      where: { mint: { in: [...new Set(rows.map((r) => r.mint))] } },
      select: { mint: true, lastReport: true },
    });
    const clean = new Map<string, boolean>();
    for (const t of tokens) {
      const rep = t.lastReport ? (JSON.parse(t.lastReport) as TokenReport) : null;
      if (!rep) continue;
      const ok = (['mint-authority', 'freeze-authority', 'token-program'] as const).every((id) => {
        const st = rep.checks.find((c) => c.id === id)?.status;
        return st === 'pass' || st === 'warn';
      });
      clean.set(t.mint, ok);
    }
    // whale hold time, keyed by the same (mint, entry second) the path was cut on
    const wallets = await this.prisma.wallet.findMany({ where: { metrics: { not: null }, purgedAt: null }, select: { metrics: true } });
    const holds = new Map<string, number>();
    for (const w of wallets) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      for (const t of m.tokens) {
        if (!t.firstBuyAt || t.holdMinutes === null || t.holdMinutes === undefined) continue;
        holds.set(`${t.mint}:${Math.floor(new Date(t.firstBuyAt).getTime() / 1000)}`, t.holdMinutes);
      }
    }
    const paths = rows
      .filter((r) => r.entryPrice > 0)
      .map((r) => ({
        entry: r.entryPrice,
        closes: JSON.parse(r.closes) as number[],
        clean: clean.get(r.mint) ?? null,
        hold: holds.get(`${r.mint}:${r.entryTs}`) ?? null,
      }))
      .filter((p) => p.closes.length >= 5);

    type P = (typeof paths)[number];
    // null = this path cannot score this rule honestly (no whale exit recorded,
    // or the path ends before they sold) -- dropped rather than clamped
    const mirror = (p: P): number | null => {
      if (p.hold === null) return null;
      const i = Math.round(p.hold);
      if (i >= p.closes.length) return null;
      return (p.closes[i] / p.entry - 1) * 100;
    };
    const ruleExit = (trail: number, arm: number, stop: number, until?: number): ((p: P) => number | null) => (p) => {
      let peak = p.entry;
      const end = until ?? p.closes.length;
      for (let i = 0; i < Math.min(end, p.closes.length); i++) {
        const c = p.closes[i];
        peak = Math.max(peak, c);
        if (stop < 100 && c <= p.entry * (1 - stop / 100)) return -stop;
        if (peak >= p.entry * (1 + arm / 100) && c <= peak * (1 - trail / 100)) return (c / p.entry - 1) * 100;
      }
      const last = p.closes[Math.min(end, p.closes.length) - 1];
      return (last / p.entry - 1) * 100;
    };
    // ours: mirror-trail -- the whale's exit closes it, but a trail can fire first
    const mirrorTrail = (trail: number, arm: number, stop: number): ((p: P) => number | null) => (p) => {
      if (p.hold === null) return null;
      const i = Math.round(p.hold);
      if (i >= p.closes.length) return null;
      return ruleExit(trail, arm, stop, i + 1)(p);
    };

    // NOT "gauntlet-only": on this sample the authority checks exclude NOTHING
    // (0 of 225 minute-path mints have a live mint/freeze authority), so
    // filtering on them is identical to filtering on "we hold a report at all".
    // And we hold a report only where the backfill found a live DexScreener
    // pair TODAY -- which is survivorship, not a gate. Named for what it
    // measures so nobody reads it as a filter that earned its keep.
    // Entry cohorts by the TRIGGERING WALLET'S STYLE, because style is the only
    // stable predictor we have: realized returns anti-predict (corr -0.44
    // first-half vs second-half), while median hold time is a property of how a
    // wallet trades. A wallet that flips in 45 minutes is structurally unable to
    // catch a 10x -- and 87% of all profit lives in the top 1% of trades.
    const entries: [string, (p: P) => boolean][] = [
      ['all entries', () => true],
      ['fast whale (<30m)', (p) => p.hold !== null && p.hold < 30],
      ['dead zone (30m-2h)', (p) => p.hold !== null && p.hold >= 30 && p.hold < 120],
      ['patient whale (2h+)', (p) => p.hold !== null && p.hold >= 120],
    ];
    // Trail widths from tight to loose. A 10% trail on a wallet that holds 12
    // hours cuts the position long before they are done -- selecting for runners
    // and then exiting them early is the worst of both. This is where that gets
    // measured instead of assumed.
    const exits: [string, (p: P) => number | null][] = [
      ['mirror (their exit)', mirror],
      ['trail 10 · stop 30', ruleExit(10, 20, 30)],
      ['trail 20 · stop 30', ruleExit(20, 20, 30)],
      ['trail 30 · stop 30', ruleExit(30, 20, 30)],
      ['trail 40 · stop 30', ruleExit(40, 20, 30)],
      ['trail 50 · stop 30', ruleExit(50, 20, 30)],
      ['mirror-trail 10/20 (ours)', mirrorTrail(10, 20, 30)],
      ['mirror-trail 30/20', mirrorTrail(30, 20, 30)],
      ['mirror-trail 50/20', mirrorTrail(50, 20, 30)],
      ['no exit (ride the path)', ruleExit(100, 999, 100)],
    ];
    const out: BacktestStrategyRow[] = [];
    for (const [eName, keep] of entries) {
      const subset = paths.filter(keep);
      for (const [xName, f] of exits) {
        const xs = subset.map(f).filter((x): x is number => x !== null);
        if (!xs.length) {
          out.push({ strategy: `${eName} × ${xName}`, trades: 0, avgRetPct: 0, medianRetPct: 0, winRate: 0, bestPct: 0, worstPct: 0 });
          continue;
        }
        const sorted = [...xs].sort((a, b) => a - b);
        out.push({
          strategy: `${eName} × ${xName}`,
          trades: xs.length,
          avgRetPct: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
          medianRetPct: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
          winRate: Math.round((xs.filter((x) => x > 0).length / xs.length) * 100),
          bestPct: Math.round(sorted[sorted.length - 1]),
          worstPct: Math.round(sorted[0]),
        });
      }
    }
    return out;
  }

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
    shuffle(entries);
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
      const cached = await this.prisma.backtestPath.findUnique({ where: { mint_entryTs_resolution: { mint: e.mint, entryTs, resolution: 'minute' } } }).catch(() => null);
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
          .create({ data: { mint: e.mint, entryTs, entryPrice, closes: JSON.stringify(closes), resolution: 'minute' } })
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
    await this.prisma.backtestRun.create({ data: { payload: JSON.stringify(this.last) } }).catch(() => undefined);
    this.log.log(`backtest done: ${replayed} replayed`);
  }
}
