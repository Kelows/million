#!/usr/bin/env node
/**
 * Project the book forward over 30d / 180d / 1y / 3y by bootstrap simulation.
 *
 * Two stages, deliberately separate:
 *
 *  1. REPLAY — score the LIVE exit rule (trail/arm/stop/ratchet/maxHold, read
 *     from OpportunityConfig, not hardcoded) against every cached candle path,
 *     net of the measured round-trip fill cost for that pool's depth. This
 *     produces the empirical per-trade return distribution for the strategy we
 *     actually run, rather than the whale roster's raw returns.
 *
 *  2. BOOTSTRAP — resample that distribution forward at the observed trade
 *     rate, compounding through the live sizing rules and circuit breakers.
 *
 * Why bootstrap rather than a closed form: 87% of profit sits in 1% of trades
 * in the roster's observed trades. A mean and a sigma describe a normal distribution;
 * this one is nothing like normal, so the percentile fan IS the answer and any
 * single "expected return" number is actively misleading.
 *
 *   node tools/monte-carlo.mjs [--runs 20000] [--basis all|floor] [--block 1]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.DB ?? path.join(HERE, '..', 'apps', 'api', 'prisma', 'dev.db');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RUNS = Number(arg('runs', 20000));
const BASIS = arg('basis', 'all'); // all = every cached path; floor = only pools clearing the live execution floor
const BLOCK = Number(arg('block', 1)); // >1 = moving-block bootstrap, preserves regime clustering
const SIZING = arg('sizing', 'capped'); // capped = the live 0.5-clip; fractional = reinvest a constant share
const HALF_LIFE = Number(arg('halfLife', 0)); // days until the edge is halved; 0 = assume it never decays
const RES = arg('res', 'hour');
// 23% of minute paths run out of candles before the exit rule fires. Those are
// UNRESOLVED, not closed, and how they are booked moves the headline from
// +9.5% (drop) to +4.2% (mark at last close) to -4.1% (assume the stop). The
// data cannot settle it, so it is an explicit axis rather than a silent choice.
const UNRESOLVED = arg('unresolved', 'markout'); // markout | drop | worst
const FLOOR_USD = Number(arg('floor', 0)); // override the execution liquidity floor, to price the floor itself
const PARAM_UNC = arg('paramUncertainty', 'on') !== 'off'; // resample the PATH SET per run, not just trades from it // hour reaches the 168h max-hold; minute truncates at ~8h
const OUT = arg('out', path.join(HERE, '..', 'docs', 'monte-carlo.json'));

/** sqlite3 CLI rather than a driver: no build step, and this is read-only. */
function q(sql) {
  const raw = execFileSync('sqlite3', ['-json', '-readonly', DB, sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 512,
  }).trim();
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------- live config

const cfgRow = q('SELECT data FROM OpportunityConfig WHERE id = 1;')[0];
if (!cfgRow) throw new Error('no OpportunityConfig row — start the API once so it seeds defaults');
const CFG = JSON.parse(cfgRow.data);

const LIVE = {
  trailStopPct: CFG.trailStopPct ?? 10,
  trailArmPct: CFG.trailArmPct ?? 20,
  stopLossPct: CFG.stopLossPct ?? 50,
  maxHoldHours: CFG.maxHoldHours ?? 168,
  minTradeLiquidityUsd: CFG.minTradeLiquidityUsd ?? 100_000,
  positionSol: CFG.positionSol ?? 0.5,
  bankrollSol: CFG.bankrollSol ?? 10,
  maxOpenPositions: CFG.maxOpenPositions ?? 50,
  weeklyLossLimitPct: CFG.weeklyLossLimitPct ?? 50,
  exitMode: CFG.exitMode ?? 'trail',
};

/**
 * Round-trip cost by pool depth, measured with real Jupiter quotes at our 0.5◎
 * clip. A cliff at ~$500k, not a slope — so this is a lookup,
 * not an interpolation.
 */
function roundTripCostPct(liqUsd) {
  if (!liqUsd || liqUsd <= 0) return 3.18;
  if (liqUsd < 50_000) return 3.18;
  if (liqUsd < 150_000) return 2.79;
  if (liqUsd < 500_000) return 2.11;
  if (liqUsd < 2_000_000) return 0.64;
  return 0.40;
}

// ------------------------------------------------------------------- stage 1

/**
 * The live exit rule, transcribed from trading.service.ts tick():
 * peak ratchets every bar; the trail arms at armPct above entry and rides the
 * peak; a breakeven ratchet lifts the floor to +2% once the position has seen
 * +25%; the hard stop and the max-hold timeout sit underneath.
 *
 * dynamicTrailPct widens the leash to the token's own p90 drawdown x1.2 (capped
 * 35%, floored at the configured trail) once 20 bars of history exist — a
 * position in a jumpy token is not stopped out by its ordinary noise.
 */
function replayExit(closes, entry, barMinutes) {
  const { trailStopPct, trailArmPct, stopLossPct, maxHoldHours } = LIVE;
  const maxBars = Math.floor((maxHoldHours * 60) / barMinutes);
  const armLine = entry * (1 + trailArmPct / 100);
  const hist = [];
  let peak = entry;

  for (let i = 0; i < closes.length && i < maxBars; i++) {
    const px = closes[i];
    if (!(px > 0)) continue;
    hist.push(px);
    peak = Math.max(peak, px);

    // hard stop first: it is checked against entry, and it is unconditional
    if ((px / entry - 1) * 100 <= -stopLossPct) {
      return { retPct: -stopLossPct, bars: i + 1, reason: 'sl' };
    }
    if (peak >= armLine) {
      const trailPct = dynamicTrailPct(hist, trailStopPct);
      const trailLine = peak * (1 - trailPct / 100);
      const breakevenLine = peak >= entry * 1.25 ? entry * 1.02 : 0;
      if (px <= Math.max(trailLine, breakevenLine)) {
        return { retPct: (px / entry - 1) * 100, bars: i + 1, reason: 'trail' };
      }
    }
  }
  // ran out of path, or hit max hold — mark out at the last close either way
  const last = closes.filter((c) => c > 0).at(-1) ?? entry;
  const bars = Math.min(closes.length, maxBars);
  return { retPct: (last / entry - 1) * 100, bars, reason: bars >= maxBars ? 'timeout' : 'path-end' };
}

function dynamicTrailPct(hist, fallbackPct) {
  if (hist.length < 20) return fallbackPct;
  let peak = hist[0];
  const dd = [];
  for (const px of hist) {
    peak = Math.max(peak, px);
    dd.push((1 - px / peak) * 100);
  }
  dd.sort((a, b) => a - b);
  const p90 = dd[Math.floor(dd.length * 0.9)];
  return Math.min(35, Math.max(fallbackPct, p90 * 1.2));
}

function buildTradeDistribution() {
  const rows = q(`
    SELECT b.mint, b.symbol, b.resolution, b.entryPrice, b.closes,
           json_extract(t.lastReport, '$.liquidityUsd') AS liq
    FROM BacktestPath b
    LEFT JOIN Token t ON t.mint = b.mint
    WHERE b.resolution = '${RES}';
  `);

  const trades = [];
  for (const r of rows) {
    const liq = Number(r.liq) || 0;
    const floor = FLOOR_USD || LIVE.minTradeLiquidityUsd;
    if (BASIS === 'floor' && liq < floor) continue;
    let closes;
    try {
      closes = JSON.parse(r.closes);
    } catch {
      continue;
    }
    if (!Array.isArray(closes) || closes.length < 2 || !(r.entryPrice > 0)) continue;

    const barMinutes = RES === 'minute' ? 1 : 60;
    const { retPct: raw, bars, reason } = replayExit(closes, r.entryPrice, barMinutes);
    if (reason === 'path-end' && UNRESOLVED === 'drop') continue;
    const retPct = reason === 'path-end' && UNRESOLVED === 'worst' ? -LIVE.stopLossPct : raw;
    const cost = roundTripCostPct(liq);
    // cost is a round trip, applied once to the gross return
    const net = retPct - cost;
    trades.push({
      mint: r.mint,
      symbol: r.symbol,
      liquidityUsd: liq,
      grossPct: retPct,
      costPct: cost,
      netPct: net,
      holdHours: RES === 'minute' ? bars / 60 : bars,
      reason,
    });
  }
  return trades;
}

// ------------------------------------------------------------------- stage 2

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function describe(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    mean,
    p5: pct(s, 0.05),
    p10: pct(s, 0.1),
    p25: pct(s, 0.25),
    median: pct(s, 0.5),
    p75: pct(s, 0.75),
    p90: pct(s, 0.9),
    p95: pct(s, 0.95),
    min: s[0],
    max: s.at(-1),
  };
}

/**
 * One simulated book over `days`.
 *
 * SIZING is the parameter that decides whether this projection means anything.
 *
 *  - 'capped' is what the live config actually does: positionSol is a HARD 0.5◎
 *    clip. As equity grows the clip stays fixed, so the risked FRACTION decays
 *    and growth is additive, not exponential. This is the honest default.
 *
 *  - 'fractional' reinvests a constant share of equity. It compounds, and over
 *    a multi-year horizon it produces numbers (thousands of x) that are an
 *    artefact of the assumption rather than a forecast: 5% of a 100,000◎ book
 *    is a 5,000◎ clip into pools whose MEDIAN depth is $10,313. There is no
 *    such fill. Kept because it bounds the arithmetic ceiling, not because it
 *    is reachable.
 *
 * EDGE DECAY: `halfLifeDays` shrinks the drawn edge over time toward zero,
 * leaving the shape of the distribution intact. A memecoin copy edge competed
 * away in a year is the base case, not a pessimistic one; 0 disables it.
 */
function simulateBook(pool, days, tradesPerDay, opts, rng) {
  const { sizing, riskFrac, clipSol, startSol, halfLifeDays } = opts;
  let equitySol = startSol;
  const nTrades = Math.max(1, Math.round(days * tradesPerDay));
  let weekStart = 0;
  let weekOpenEquity = equitySol;
  let halted = false;
  let peak = equitySol;
  let maxDD = 0;
  let idx = Math.floor(rng() * pool.length);

  for (let i = 0; i < nTrades; i++) {
    const day = i / tradesPerDay;
    if (day - weekStart >= 7) {
      weekStart = day;
      weekOpenEquity = equitySol;
      halted = false;
    }
    if (halted) continue;

    if (BLOCK <= 1 || i % BLOCK === 0) idx = Math.floor(rng() * pool.length);
    else idx = (idx + 1) % pool.length;

    let r = pool[idx] / 100;
    // decay the EDGE (the mean), not the volatility: the tail stays, the drift goes
    if (halfLifeDays > 0) r *= Math.pow(0.5, day / halfLifeDays);

    // the live clip cannot exceed what is in the book, nor the hard cap
    const stake = sizing === 'fractional' ? equitySol * riskFrac : Math.min(clipSol, equitySol * riskFrac);
    equitySol += stake * r;

    if (equitySol <= startSol * 0.01) return { equity: 0, maxDD: 1, ruined: true };
    peak = Math.max(peak, equitySol);
    maxDD = Math.max(maxDD, 1 - equitySol / peak);
    if (equitySol <= weekOpenEquity * (1 - LIVE.weeklyLossLimitPct / 100)) halted = true;
  }
  return { equity: equitySol / startSol, maxDD, ruined: false };
}

/** Draw a same-size bootstrap replicate of the path set — one plausible world. */
function resample(xs, rng) {
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng() * xs.length)];
  return out;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------- run

const trades = buildTradeDistribution();
if (trades.length < 5) {
  console.error(`only ${trades.length} replayable paths on basis "${BASIS}" — nothing to project`);
  process.exit(1);
}

const netReturns = trades.map((t) => t.netPct);
const dist = describe(netReturns);
const wins = netReturns.filter((r) => r > 0).length;

// observed trade rate, straight off the live book
const rate = q(`
  SELECT COUNT(*) AS n,
         (MAX(openedAt) - MIN(openedAt)) / 86400000.0 AS days
  FROM PaperPosition;
`)[0];
const tradesPerDay = rate?.days > 0.5 ? rate.n / rate.days : 30;

// risk fraction: the live clip as a share of the live bankroll
const riskFrac = LIVE.positionSol / LIVE.bankrollSol;
const simOpts = {
  sizing: SIZING,
  riskFrac,
  clipSol: LIVE.positionSol,
  startSol: LIVE.bankrollSol,
  halfLifeDays: HALF_LIFE,
};

// The four the question asks for, plus intermediates so the fan is drawn from
// measurements rather than interpolated between four points.
const HORIZONS = [
  { label: '7 days', days: 7, minor: true },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90, minor: true },
  { label: '180 days', days: 180 },
  { label: '270 days', days: 270, minor: true },
  { label: '1 year', days: 365 },
  { label: '2 years', days: 730, minor: true },
  { label: '3 years', days: 1095 },
];

const rng = mulberry32(20260831);
const projections = HORIZONS.map(({ label, days, minor }) => {
  const equities = [];
  const drawdowns = [];
  let ruined = 0;
  for (let i = 0; i < RUNS; i++) {
    // TWO-LEVEL BOOTSTRAP. The inner draw handles trade-to-trade luck. The
    // outer draw handles the bigger risk: we hold 445 paths, 87% of profit
    // lives in a handful of them, so the sample mean itself is unstable. A
    // single-level bootstrap treats the observed mean as the truth and reports
    // a false certainty (P(profit) 100%). Resampling the PATH SET each run
    // propagates "we might simply have a lucky sample" into the fan.
    const world = PARAM_UNC ? resample(netReturns, rng) : netReturns;
    const { equity, maxDD, ruined: dead } = simulateBook(world, days, tradesPerDay, simOpts, rng);
    equities.push(equity);
    drawdowns.push(maxDD);
    if (dead) ruined++;
  }
  const e = describe(equities);
  const dd = describe(drawdowns);
  const above = (x) => equities.filter((v) => v >= x).length / equities.length;
  return {
    label,
    days,
    minor: !!minor,
    trades: Math.round(days * tradesPerDay),
    equity: e,
    maxDrawdown: dd,
    pRuin: ruined / RUNS,
    pProfit: above(1),
    pDouble: above(2),
    pTenX: above(10),
    pHalf: 1 - above(0.5),
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  basis: BASIS,
  sizing: SIZING,
  halfLifeDays: HALF_LIFE,
  floorUsd: FLOOR_USD || LIVE.minTradeLiquidityUsd,
  unresolved: UNRESOLVED,
  block: BLOCK,
  paramUncertainty: PARAM_UNC,
  runs: RUNS,
  config: LIVE,
  sample: {
    paths: trades.length,
    resolution: RES,
    tradesPerDay,
    liveClosedPositions: q("SELECT COUNT(*) AS n FROM PaperPosition WHERE status='closed';")[0]?.n ?? 0,
    riskFrac,
  },
  perTrade: {
    ...dist,
    winRate: wins / netReturns.length,
    meanCost: trades.reduce((a, t) => a + t.costPct, 0) / trades.length,
    top1PctShare: tailShare(netReturns, 0.01),
    top5PctShare: tailShare(netReturns, 0.05),
    exitReasons: trades.reduce((acc, t) => ({ ...acc, [t.reason]: (acc[t.reason] ?? 0) + 1 }), {}),
  },
  trades: trades.sort((a, b) => b.netPct - a.netPct),
  projections,
};

/** Share of total profit contributed by the top q of trades. */
function tailShare(rs, q) {
  const gains = rs.filter((r) => r > 0).sort((a, b) => b - a);
  const total = gains.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const k = Math.max(1, Math.round(rs.length * q));
  return gains.slice(0, k).reduce((a, b) => a + b, 0) / total;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

// ------------------------------------------------------------------- report

const f = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d);
console.log(`\nBASIS ${BASIS} · ${trades.length} ${RES} paths · ${RUNS.toLocaleString()} runs · block ${BLOCK}`);
console.log(`exit: trail ${LIVE.trailStopPct}/arm ${LIVE.trailArmPct}/stop ${LIVE.stopLossPct}, maxHold ${LIVE.maxHoldHours}h`);
console.log(`sizing: ${SIZING} — ${LIVE.positionSol}◎ clip on ${LIVE.bankrollSol}◎ (${(riskFrac * 100).toFixed(1)}%/trade) · ${tradesPerDay.toFixed(1)} trades/day · edge half-life ${HALF_LIFE || '∞'}d\n`);

console.log('PER-TRADE (net of fill cost)');
console.log(`  mean ${f(dist.mean)}%   median ${f(dist.median)}%   win ${(wins / netReturns.length * 100).toFixed(0)}%`);
console.log(`  p5 ${f(dist.p5)}%  p25 ${f(dist.p25)}%  p75 ${f(dist.p75)}%  p95 ${f(dist.p95)}%  max ${f(dist.max)}%`);
console.log(`  top 1% of trades = ${(result.perTrade.top1PctShare * 100).toFixed(0)}% of all profit\n`);

console.log('PROJECTION (equity multiple, 1.00 = flat)');
console.log('  horizon      trades      p5     p25   median     p75      p95    P(profit)  P(ruin)');
for (const p of projections.filter((x) => !x.minor)) {
  console.log(
    `  ${p.label.padEnd(11)} ${String(p.trades).padStart(6)}  ` +
      `${p.equity.p5.toFixed(2).padStart(6)} ${p.equity.p25.toFixed(2).padStart(7)} ` +
      `${p.equity.median.toFixed(2).padStart(8)} ${p.equity.p75.toFixed(2).padStart(7)} ` +
      `${p.equity.p95.toFixed(2).padStart(8)}  ` +
      `${(p.pProfit * 100).toFixed(0).padStart(8)}% ${(p.pRuin * 100).toFixed(1).padStart(7)}%`,
  );
}
console.log(`\nwritten to ${path.relative(process.cwd(), OUT)}`);
