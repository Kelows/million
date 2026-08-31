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
