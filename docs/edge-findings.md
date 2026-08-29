# Do we have edge?

Measured 2026-08-30 against 3,197 observed round trips — trades where we watched
both the buy and the sell, so there is a real cost basis. Historical/unbacked
numbers are excluded throughout.

**Short answer: the roster has a real aggregate edge, it is almost entirely a
tail phenomenon, and it is not attributable to individual wallets by their past
returns. It IS partly attributable to their trading STYLE.**

## 1. The edge exists but it is a lottery

```
mean per-trade return   +11.0%
median per-trade return  +0.1%      win rate 50%
p75  +11.2%   p95  +56.0%   p99  +221.6%   max +3,099.9%
```

87% of all profit comes from the top 1% — 31 trades out of 3,197.

```
mean excluding the top 1%:  +1.5%
mean excluding the top 5%:  -2.8%
```

The median trade makes nothing. Any strategy here is a bet on catching rare
outliers, not on winning often. This is why win rate is a misleading target and
why clipping tails (take-profit ceilings, tight trails) is structurally
expensive even when it improves the median.

## 2. Past returns do NOT predict future returns

Two tests, both negative.

**Do outlier trades cluster in particular wallets?** Permutation test, 20,000
shuffles of the outlier labels across trades while preserving each wallet's
trade count (24 wallets with >=10 observed trades, 13 outliers):

```
observed:  max 4 outliers in one wallet, 2 wallets with >=2
P(chance gives >=4 in some wallet) = 0.987
P(chance gives >=2 such wallets)   = 0.991
```

The clustering we see is exactly what randomness produces.

**Does performance persist?** Splitting each wallet's trades in half
chronologically (9 wallets with >=20 trades):

```
corr(first-half mean return, second-half mean return) = -0.44
first half +21.1%  ->  second half +4.3%
```

Negative. Wallets that did well went on to do worse — mean reversion, not skill.

**Consequence: ranking wallets by realized PnL or win rate is not a strategy.**
Whatever `whaleScore` is doing, it is not selecting for future returns.

## 3. What DOES predict: hold style

Returns do not persist, but median hold time is a stable property of a wallet,
and it separates tail production sharply. Excluding infra/distributor/unbacked
wallets:

| median hold | wallets | trades | outliers | rate | mean | median |
|---|---|---|---|---|---|---|
| < 5 min | 8 | 53 | 1 | 1.89% | +35.9% | −6.9% |
| 5–30 min | 42 | 1,328 | 13 | 0.98% | +11.2% | +0.4% |
| **30 min–2 h** | 20 | 1,594 | 4 | **0.25%** | **+1.8%** | **−0.9%** |
| **2–12 h** | 18 | 102 | 7 | **6.86%** | +55.7% | +1.0% |
| **> 12 h** | 23 | 125 | 5 | **4.00%** | +61.4% | **+8.5%** |

The 30 min–2 h band is a dead zone: half of all observed volume, a 0.25% outlier
rate, and a negative median. Patient wallets (2 h+) produce outliers at 4–7% —
roughly **20x the dead-zone rate** — and the >12 h band has the best median too,
so it is not purely a tail effect.

Sample caveat: the patient bands are thin (102 and 125 trades). Treat the
magnitude as soft and the direction as the finding.

## 4. Latency

From the copyability work: replaying whale entries one candle late.

```
0 min delay:  +4.8% avg, +3.5% median, 57% win rate
1 min delay:  -1.5%
```

We fill in 3–5 s, so the favourable row applies — but only if quoted prices are
obtainable, which the fill-gap audit exists to answer.

## 5. What the backtest says about exits

445 minute paths, 170 with a recorded whale exit:

```
mirror-trail 10/20 (ours)  +10.2% avg   +4.9% median   57% wins   worst  -30%
mirror (their exit alone)   +9.7% avg    0.0% median   47% wins   worst  -95%
rules-only trail 10/20/30   +6.5% avg   +5.1% median   55% wins   worst  -30%
no exit (ride the path)     -4.0% avg  -26.6% median   28% wins   worst  -98%
```

The whale's exit signal is worth more than any exit rule we can tune, and the
trail converts a −95% tail into −30% while adding 10 points of win rate.

`stopLossPct 30` is the single most robust number in the study: monotonic across
all 1,225 grid combinations, reproduced independently on hourly bars, and it
survives dropping the three best test trades.

**Beware small samples here.** `exit @240m` led at +33.7% on 154 paths and
inverted to −13.8% on 209. Only findings that held their ranking as the sample
grew are in this document.

## 6. Where the backtest CANNOT help

The gauntlet cannot be validated by replay. Its market checks (liquidity, market
cap, holder concentration, sell simulation) are present-tense: a token that
rugged after entry now fails its own sell-sim, so filtering on "gauntlet passes"
deletes the losers from the sample. The authority checks are time-honest but
exclude nothing — 0 of 225 backtest mints have a live mint or freeze authority.

The live gauntlet is still sound: it runs at signal time, so there is no
look-ahead. It just cannot be scored historically. The `Gauntlet Only` preset
exists to answer this forward instead.

## 7. What to do about it

1. **Favour patient wallets.** Style is the only stable predictor found. The
   dead zone (30 min–2 h) is the first thing to cut.
2. **Do not rank by past PnL.** It anti-predicts.
3. **Do not clip tails.** 87% of profit is in 1% of trades.
4. **~300 trades before concluding anything** from our own book. At a ~1%
   outlier base rate, fewer than that cannot distinguish luck from edge in
   either direction.

## Open questions

- Does hold-style prediction survive on a larger sample of patient wallets?
  Currently 41 wallets and 227 trades across both patient bands.
- Is the fill-gap real, or a lagging price feed? Unresolved.
- Does `Gauntlet Only` beat `Measured Mirror` live? That is the entry-filter
  question the backtest cannot settle.
