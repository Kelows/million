# Projecting the book — and why the projection is mostly a measure of ignorance

`tools/monte-carlo.mjs` replays the live exit rule against every cached candle
path, charges the measured fill cost, then resamples that distribution forward
over 30d / 180d / 1y / 3y.

```
node tools/monte-carlo.mjs --res minute --basis floor --floor 100000
```

Dashboard: https://claude.ai/code/artifact/3cd79ece-d2f6-4f46-9b8f-c20dbde1fd1b

## The result that matters

Not the median. The **spread across defensible assumptions**, all on the same
data, same rule, same 6,000 runs per horizon:

| assumption | paths | mean/trade | 3y median | P(profit) | P(ruin) |
|---|---|---|---|---|---|
| Unresolved dropped | 343 | +9.5% | 160x | 100% | 0.1% |
| Live config, $100k floor | 35 | +8.0% | 125x | 94% | 5.0% |
| $50k floor | 68 | +7.1% | 110x | 93% | 6.3% |
| No floor | 445 | +4.2% | 70x | 94% | 5.9% |
| Edge decays, 1y half-life | 445 | +4.2% | 30x | 94% | 3.7% |
| **Hourly bars** | 314 | **-0.9%** | **0x** | 32% | 68% |
| **Unresolved booked at stop** | 445 | **-4.8%** | **0x** | 3% | 97% |

Two rows flip the sign of the whole exercise, and neither is an unreasonable
reading. That is the finding.

## Three things the projection is actually measuring

**1. We cannot yet reject "no edge" at any liquidity floor.** Bootstrap 95% CI
on the per-trade mean:

```
no floor   n=445  +4.2%  [-0.8%, +9.5%]
$50k       n= 68  +7.1%  [-1.5%, +18.0%]
$100k      n= 35  +8.0%  [-1.2%, +20.8%]
$250k      n= 19  +4.5%  [-2.1%, +11.2%]
```

Every interval contains zero. **$50k does not help** — it buys 33 more paths and
moves the point estimate less than the interval width. The floors are not
distinguishable from each other on this sample.

Note the sample sizes. The configured strategy has been replayed on **35 paths**,
because the $100k execution floor postdates the path cache.

**2. The minute/hourly gap is a coarse-bar artefact, not a contradiction.**

A first pass paired the two caches by mint alone and reported that the same
tokens gave opposite answers. That pairing was wrong: of 190 shareable pairs
only **48 share an entry timestamp**, the rest averaging 65h apart with entry
prices 167% apart. Pairing on mint compares different trades.

Redone on the 48 exact (mint, entryTs) pairs, and decomposed by replaying the
hourly path over the *same window* the minute path covers
(`tools/resolution-check.mjs`):

```
A  minute bars, ~5h window    mean +17.6%   median +14.1%   win 69%
B  hourly bars, SAME window   mean  +4.6%   median -31.2%   win 29%
C  hourly bars, full 168h     mean  +9.8%   median -19.5%   win 38%

A - B   resolution effect     +12.9 pts   <- the whole gap
B - C   horizon effect         -5.2 pts   <- holding longer helps slightly
```

The gap is bar size, not data coverage, and it is ~2.5x the horizon effect.
A trailing stop can only act on the closes it is shown; on hourly candles it
never sees the intra-hour peak it exists to trail, and by the time an hourly
close confirms a retrace the price has fallen well past the trail line.

**The live tick loop runs every ~60s, so minute bars are the right analogue.**
The hourly row in the table above is a measurement artefact and should not be
read as a 68% chance of ruin.

Still genuinely unknown: minute paths reach a median of 5.3h and the config
permits 168h. Nothing measures minute-resolution behaviour past ~8h. The
horizon effect hints that holding longer is mildly positive, but it was
measured at the wrong resolution to settle it.

**3. The published backtest numbers were measured under an accidental exit rule.**
23% of minute paths run out of candles before the rule fires, at a mean of -13.9%.
Those positions are unresolved, not closed. Booking them at the last close gives
+4.2%; dropping them gives +9.5%; assuming they hit the stop gives -4.8%.

## Modelling choices worth knowing about

- **Two-level bootstrap.** Each simulated book first draws a bootstrap replicate
  of the whole path set, so "we may hold a lucky 445 paths" enters the fan. The
  single-level version reports P(profit) = 100% and is wrong.
- **Capped sizing by default.** `positionSol` is a hard 0.5 clip, so the risked
  fraction decays as equity grows and the book compounds sub-exponentially. The
  `--sizing fractional` arm is an arithmetic ceiling, not a forecast: 5% of a
  compounded book is a multi-thousand-SOL clip into pools with a $10,313 median
  depth.
- **Costs by measured depth**, not a flat assumption.
- **Independent draws** by default; `--block N` preserves regime clustering.

## Known biases

- Pool depth is read as of *today*, not entry — flatters every floored sample.
- Entry filters are not replayed; the gauntlet is present-tense and cannot be.
- Trade rate (30.6/day) comes from 25 positions over ~20 hours.

## How long until this resolves itself

Power to get a 95% CI that clears zero, assuming the observed distribution IS
the truth (generous — that sample's own CI contains zero):

| live trades | days at 30.6/day | P(CI clears zero) |
|---|---|---|
| 214 | 7 | 21% |
| 300 | 10 | 26% |
| 600 | 20 | 48% |
| 1,000 | 33 | 68% |
| 2,000 | 65 | 96% |

**A week is not a decision point.** ~1,000 trades (five weeks) is where the odds
pass two in three.

But the kill criterion is far cheaper than the confirm criterion. At a 3.15%
base rate for a trade clearing +100%, seeing *none* in 214 trades has a 0.1%
probability if the edge is real. A week can plausibly kill this; it cannot
confirm it. Check in weekly as a safety check, decide at ~1,000 trades.

## What would narrow it, in order

1. **Resolve the 20 open positions and reach ~300 trades.** Nothing else moves
   the interval as fast.
2. **Fetch minute paths for $100k+ pools specifically.** n=35 is the binding
   constraint on the configured strategy.
3. **Extend minute candles past 8.3h** for tokens held long — the only way to
   measure the 8-168h band at the resolution the live system actually runs at.
   Slow to fetch; not urgent now that the hourly result is understood.
4. **Record entry-time liquidity** on every path, to remove the survivorship
   flattery.

---

## What hourly candles are for, and what they cannot answer

**Why they exist (a good reason).** The GeckoTerminal minute endpoint reaches
only ~8.3 hours. `backtest.service.ts` puts it plainly: *"holds past 24h carry
61% of their profit, and every conclusion we have drawn so far was blind to
it."* Hourly bars are the only instrument that reaches the band where most of
the roster's money actually is. They should not be deleted.

**What they cannot do.** A trailing stop acts on the closes it is shown. Scoring
a peak-relative rule on hourly bars measures the bar size as much as the rule.
`tools/exit-rank-by-resolution.mjs` scores the same rules at both resolutions
over the same wall-clock window, on paths paired by `(mint, entryTs)`:

```
rule                                 minute  rank | hourly  rank | moved
trail 30 · arm 20 · stop 50          +17.0%     1 |  +1.9%     8 |   +7
trail 10 · arm 20 · stop 50 · ratch  +12.9%     2 | +12.9%     2 |    -
trail 20 · arm 40 · stop 50          +12.5%     4 |  +5.2%     6 |   +2
trail 20 · arm 20 · stop 50          +11.2%     5 |  +5.2%     5 |    -
trail 10 · arm 20 · stop 30           +9.1%     6 | +19.7%     1 |   -5
trail 20 · arm 20 · stop 30           +8.4%     7 | +12.4%     4 |   -3
hold to bar 4 (FIXED HORIZON)         +5.7%     8 |  +4.1%     7 |   -1

Spearman rank correlation: -0.05
```

**The orderings are unrelated.** The rule hourly likes best (stop 30) is sixth
on minute bars; the rule minute likes best (trail 30) is last on hourly. Note
the one stable row: the fixed-horizon rule, which does not depend on the
intra-bar path, barely moves. That is the dividing line.

### The rule of thumb

| Question | Hourly OK? |
|---|---|
| How much profit is in the 24h+ band; hold-time distribution | **yes** — path-independent |
| Fixed-horizon markouts (`exit @240m`, `hold 500m`) | **yes** |
| Entry-filter cohorts, *if* scored with a fixed-horizon exit | **yes** |
| Trail %, arm %, breakeven ratchet, stop-loss width | **no** — measures the bars |

### Two places this contaminates current conclusions

1. **`entryCohorts()` scores every entry filter through an hourly trail.** The
   fixed exit at `backtest.service.ts:462` is trail 20 / arm 20 / stop 50 on
   hourly bars. The comparison is at least common-mode across cohorts, so the
   *ranking* of filters is probably survivable, but the absolute returns are
   not. Swapping that exit for a fixed-horizon markout would remove the
   objection entirely and costs nothing — the cohorts differ by entry, not exit.

2. **The stop-30 robustness claim rests partly on hourly.** `docs/state.md`
   cites `stopLossPct 30` as *"reproduced independently on hourly bars"*. That
   reproduction is exactly what coarse bars produce — hourly ranks stop 30
   first, minute ranks it sixth. The live setting is already 50, which minute
   favours, so the setting is fine; the recorded justification is not.

Neither of these is urgent, and neither changes a live value today. Both should
be corrected before anyone cites them again.

**Caveat:** n=48 paired paths. The individual means carry wide error bars and
the −0.05 correlation is itself noisy. What is solid is the mechanism and the
direction — the fixed-horizon control behaving differently from every
path-dependent rule is the part that would be hard to get by chance.

---

## Two clocks, not one

"Five weeks" is the answer to one question. There are two, and they run at very
different speeds.

**Fill clock — nearly done.** Our entry against the trigger wallet's own
on-chain fill, over the 17 positions that recorded both:

```
mean -0.70%   median -0.47%   sd 1.10%   range -4.09% .. +1.30%
```

We fill *cheaper* than the whale on average. The fill deflation that motivated
a liquidity floor at all is not visible at the current config. Entry premium
has low variance, so it converges fast:

| pin the mean to | trades | days |
|---|---|---|
| ±1.00% | 5 | 0.2 |
| **±0.50%** | **19** | **0.6** |
| ±0.25% | 75 | 2.5 |

We have 17 of the ~19 needed for ±0.5%.

**Edge clock — cannot be hurried.** ~1,000 trades for 68% power. It counts
*trades, not dollars*: paper and live both fill ~30/day, so switching to real
money does not move it at all. What real money changes is that modelled fills
become measured ones — and that is the fill clock, which is nearly finished.

## The kill criterion cannot fire

`docs/state.md` sets it as: after ~300 trades, stop if the median is below -10%
AND no single trade has cleared +100%. Simulated against two worlds — the
observed distribution, and the same fat tails with the drift removed:

```
trades   P(fire | edge real)   P(fire | NO edge)
    50                 0.2%                1.5%
   100                 0.0%                0.0%
   300                 0.0%                0.0%
  1000                 0.0%                0.0%
```

**Past ~100 trades it fires in neither world, so it carries no information.**
The two clauses pull against each other: fat tails put a +100% trade on the
board almost immediately (3.15% base rate), so the "no outlier" clause is
essentially never true; and a distribution with a -0.9% median does not produce
a -10% *median* over hundreds of trades.

### A replacement that does fire

Calibrate to the optimistic world: **stop when the book falls below the 5th
percentile of where "the edge is real" would have put it by now.** False kills
are fixed at 5% by construction at every checkpoint.

| checkpoint | days | stop if book below | catches a dead edge |
|---|---|---|---|
| 100 | 3.3 | 0.79x | 23% |
| **300** | **9.8** | **0.82x** | **43%** |
| 500 | 16.3 | 0.93x | 59% |
| 1,000 | 32.7 | 1.47x | 82% |
| 2,000 | 65.4 | 4.51x | 97% |

It gets teeth well before the confidence interval does — 43% at ten days
against the interval's 26%. It is strictly a stop-loss on the *hypothesis*:
passing it never means the edge is real.

`tools/decision-clocks.mjs` and `tools/kill-criterion.mjs`; both read
`docs/monte-carlo.json`, so run `tools/monte-carlo.mjs` first.

**Book as of 2026-08-31:** 5 closed trades, 1.029x, median +9.2%, best +24.6%,
none over +100%. Above every kill line above, on a sample far too small to mean
anything.
