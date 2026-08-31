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

**2. Minute and hourly bars disagree about the sign, on the same tokens.**

```
same 97 mints, same rule, same 168h max hold
  minute bars   mean +17.3%   median  +9.4%   win 69%
  hourly bars   mean  +7.3%   median -14.3%   win 42%
```

It is not a hold-time effect — stretching the hourly max hold from 8h to 168h
moves the mean 11 points and leaves the median flat at -19%. It is the exit rule
itself: a trailing stop reacts to the *close* of whatever bar it is given, so on
hourly candles it cannot see the intra-hour peak it exists to trail. Stop-out
rate doubles, 36% against 18%.

The live tick loop runs every ~60s, so **minute bars are the closer analogue**
and the projections default to them. But minute paths stop at 8.3h while the
config permits 168h — the favourable evidence and the long-horizon evidence come
from disjoint datasets. Neither covers the strategy as configured.

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

## What would narrow it, in order

1. **Resolve the 20 open positions and reach ~300 trades.** Nothing else moves
   the interval as fast.
2. **Backfill minute candles past 8.3h** for tokens held long — the one
   measurement that settles the minute/hourly contradiction.
3. **Fetch minute paths for $100k+ pools specifically.** n=35 is the binding
   constraint on the configured strategy.
4. **Record entry-time liquidity** on every path, to remove the survivorship
   flattery.
