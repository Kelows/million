# Experiment: does our edge come from holding longer than the whales?

**Started** 2026-08-29 12:47 · book, opportunities and shadow book zeroed at T0.

## Where the hypothesis came from

The overnight run (12 closed, −0.46 ◎) split cleanly by exit type:

| exit | trades | total |
|---|---|---|
| `trail` (held past the whale's exit) | 2 | **+0.58 ◎** |
| `mirror` (sold when the whale sold) | 9 | −0.48 ◎ |
| `sl` | 1 | −0.57 ◎ |

And the shadow book showed the `median-hold` guard blocking 34 signals that
averaged **+15.2%** at the 6h mark — roughly 5.2 ◎ of foregone gains — while
`roster-fresh` (169 samples, −7.2%) and `fill-deflation` (11, −26.2%) were
correctly blocking losers.

Both point the same way: **the tokens fast traders pick keep running after they
leave.** Our edge may be patience, not imitation.

## The change (one variable)

`minMedianHoldMinutes: 15 → 0` — fast-trading wallets can trigger entries again.
Everything else identical: mirror-trail exits, trail 15% (volatility-scaled),
`fill-deflation`/`roster-fresh`/`cycler` guards untouched, same sizing.

## Predictions (falsifiable)

If the hypothesis holds:
1. Trade volume rises sharply (the 34 blocked signals/night return).
2. `trail` exits outnumber and outperform `mirror` exits.
3. Expectancy improves above the −0.039 ◎/trade baseline.

If it fails:
- Fast-wallet entries fill below the whale's price and mirror-close red — meaning
  the +15.2% was a 6h buy-and-hold artifact we could never have captured with
  minute-scale exits.

## The known confound

Phantoms mark to market at **6 hours**; real exits happen in minutes. So the
shadow book measures *"was this token going up?"*, not *"would our strategy have
made money?"*. This experiment is precisely the test of whether that gap matters.

## Config drift found at T0

The overnight book actually ran with `minBuySol: 3` and `allowWarn: true` (not
the 5 / false I had assumed when analysing it). Left as-is here so the only
change between runs is the median-hold guard.
