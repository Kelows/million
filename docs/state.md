# Where we are — 2026-08-30

## What we learned today

**Every result before today was measured through bugs.** Four, all found by the
system auditing itself:

1. A missing DexScreener quote was read as a dead pool and booked at −100%.
   Five positions, all still quoting, one a $46M market cap. 76% of the
   overnight loss was fabricated.
2. We traded pools down to $2.7k because the trading path shared the *crawler's*
   discovery liquidity floor ($5k). Below $20k, our recorded entry sat a median
   **+30.5% above the candle close** — a fill nobody could get.
3. The "volatility-scaled" trail used tick-to-tick sigma over a 60s tick, so it
   fell under its own 8% floor essentially always. It had been pinned at minimum
   since it was written.
4. The gauntlet cohort that looked like an edge was survivorship — 0 of 225
   mints had a live authority, so the filter excluded nothing.

**Costs are far lower than we assumed.** Measured with real Jupiter round-trip
quotes at our 0.5 SOL clip:

| pool liquidity | real round-trip |
|---|---|
| $25–50k | 3.18% |
| $50–150k | 2.79% |
| $150–500k | 2.11% |
| **$500k–2M** | **0.64%** |
| **> $2M** | **0.40%** |

Sharp cliff at ~$500k, not a slope. We had been modelling 4.4%.

**Style predicts, past returns anti-predict.** Wallet returns: corr −0.44 between
a wallet's own halves. Outlier trades don't cluster by wallet (permutation
p≈0.99). But median hold time does separate: the 30 min–2 h band is a dead zone
(0.25% outlier rate, −0.9% median, half of all volume) while 2 h+ wallets
produce outliers at 4–7%.

**The mirror exit contributes nothing.** Same 155 paths:

| exit | mean | median | win | worst |
|---|---|---|---|---|
| mirror only | 8.7% | 0.0% | 48% | −95% |
| mirror-trail (live) | 10.6% | 4.9% | 58% | −30% |
| **trail-only 10 + stop 30** | 9.9% | **6.2%** | 57% | −30% |

Trail-only loses 0.7 of mean and gains 1.3 of median. It also depends on nothing
but price — mirror needs the whale's sell *observed*, so every missed webhook
silently changes strategy mid-position.

**Our trail holds at the peak on 4% of runners** (3% above +300%). A wider trail
buys 4% → 36% survival but costs ~5 points of median; at the old cost assumption
it didn't pay, at deep-pool cost it starts to.

## Decisions taken

- `stopLossPct` 50 → 30 (monotonic across 1,225 combos, reproduced on hourly,
  survives dropping the best 3 trades)
- `minTradeLiquidityUsd` $50k, split from the crawler's discovery floor
- Presets: **Measured Mirror** (validated settings), **Gauntlet Only** (control
  arm — identical exits, no entry filters)
- 209 wallets unsubscribed by style; `clean churn` button ships the rule
- Book cleared; all 851 pending wallets analyzed

## The clean run — started 2026-08-30

First experiment with no known measurement bug in it. Every earlier number was
taken through at least one.

```
exitMode              trail        whales ignored; price is the only exit
trail / arm / stop    10 / 20 / 50
minTradeLiquidityUsd  100,000      ~2.4% real cost; see note below
maxHoldHours          168
positionSol           0.5          max 50 open, 10 SOL total exposure
```

Fill cost now comes from Jupiter's own round-trip quote rather than a flat 2%
assumption that was charging ~5.8% where the truth is 0.6%.

**Stop at 50, not 30.** Paired with trail 10 it wins on all three measures
intraday (+8.2% median vs +4.7%, 62% win vs 55%). The earlier 50->30 change came
from an optimizer marginal averaged across wide trails, where the trail is inert
and the stop does all the work — a confounded number.

**Why $100k and not $500k.** The cost cliff really is at $500k (0.64% vs 2.11%
below it), but only 2% of the tokens the roster touches are that deep — the
median is $10,313. A $500k floor yields ~30 trades a week and a $250k floor
~110, neither of which can resolve a 1% outlier base rate. $100k costs ~2.4%
and yields ~250-300, which is the number the experiment needs. The fill
deflation that motivated a floor at all lived under $20k; the $20-100k band
measured +0.7% entry premium, so $100k clears the actual problem with margin.

**Kill criterion, set before the data exists:** after ~300 trades, if the median
is below -10% AND no single trade cleared +100%, the tail is not reachable at
our latency and we stop. If the median is near zero and at least one outlier
landed, it is a sample-size problem, not a strategy problem.

## Next actions

1. **Replace mirror-trail with trail** — drop the mirror leg entirely. Simpler,
   better median, no dependency on observing sells. `rules` mode is NOT this
   (it has no trail at all); the naming needs fixing at the same time.
2. **Raise the floor to $250–500k.** Cost drops 2.8% → 0.6%, and deeper pools
   survive multi-day holds. Costs ~84% of signals — that is the trade.
3. **Trim the strategy list.** Only 5 of 16 clear costs. Cut all four scale-out
   variants, `hold 500m`, `exit @15m/@60m`, `trail 30/40/50`, `TP100/SL50`.
   Keep `exit @1m` (latency baseline), the trail 10/20 × arm 20/40 family, and
   `exit @240m` labelled tail-only — it flipped +33.7% → −13.8% on more data.
4. **Wait on two measurements** — nothing else depends on them:
   - hourly paths (156 of ~300 fetched) → multi-day trail test, the 3-day band
   - conviction 24h resolves ~15:11, 72h Tuesday → decides the allocation idea

## Open, unresolved

- Stop width: 30 wins on 438 paths, 50 wins on the 155-path whale-exit subset.
  Not settled; don't move it on one sample.
- Only 5 of 438 paths reach +900%, where the real outliers live (+839% mean).
  The exit rule is being chosen on a sample that barely contains its own case.
- Kill criterion still undecided. Pick the number before the data lands.
