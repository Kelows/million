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

## The change — restarted 12:52, both fast-trader guards off

`minMedianHoldMinutes: 15 → 0` **and** `cyclerGuardMinutes: 10 → 0`.

Why both at once, rather than sequentially: last night's trades ranged −57% to
+52%, so isolating a few-hundredths-of-a-SOL expectancy shift would need
hundreds of trades per variable — weeks at ~12/night, by which point the market
regime has moved. The two guards are also the same hypothesis in different
clothes (one blocks a wallet for *being* a fast trader, the other for *acting*
like one), both born from the same two trades.

Attribution is preserved a cheaper way: a disabled guard still computes its
verdict and stamps `wouldBlock` on the position. One run now answers both
questions as within-sample subgroups under identical market conditions.

`fill-deflation` and `roster-fresh` stay ON — 169 and 11 samples respectively,
both clearly blocking losers. Note `cycler` was the *predictive* proxy for a bad
fill while `fill-deflation` is the *measured* one; because of first-blocker-wins
ordering those 9 cycler phantoms were never fill-tested, so this run finally
measures the overlap instead of guessing at it.

## How to read the result

Split closed trades by `wouldBlock`:
- trades tagged `median-hold` / `cycler` = what the guards were costing us
- trades tagged neither = the baseline that was getting through before

If the tagged subgroups outperform the untagged ones, the guards were the
mistake. If they underperform, the guards were right and the +15.2% shadow
figure was a 6h buy-and-hold mirage.

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
