# Accumulation module — the second strategy

**Status:** vision. Nothing built yet. Two phases, in order: **test the data, then build the idea.**

## Where it came from

Two wallets, one technique, opposite directions:

- `GbHR4FYz…` sold OTC in 13 slices over 2 minutes — a laddered *exit*.
- `922M9fBT…` bought CORGI 240 times over 4h25m at ~1.44 ◎ a clip, Lyra 111
  times in 29 minutes, across 39 tokens at once, never selling — a laddered
  *entry*. Possibly the same operator; certainly the same skill.

Slicing an order is deliberate impact minimisation: a single 345 ◎ buy would
move a thin pool against you, 240 small ones do not.

## The critical distinction

**Laddering is execution, not alpha.** It reduces the price you pay to get in;
it does not tell you what to buy. `922M9fBT…` executes beautifully and is
**−392 ◎ (−25%)** on 1,560 ◎ deployed — proof that flawless execution on poor
selection still loses money.

So the module needs both halves:

- **Selection** — *which* token. Our candidate: the conviction score behind
  "Held across the roster" (distinct owners × √entry, discounted by profit
  already taken). Structural, not event-based.
- **Execution** — laddered entry, laddered or trailed exit.

## Why it may beat the copy module

| | Copy module | Accumulation module |
|---|---|---|
| Trigger | a whale's buy event | a token's conviction score |
| Latency | decides everything (3–5s) | irrelevant — accumulate over hours |
| Fill quality | fights the whale's own impact | minimised by slicing |
| Failure modes | cyclers, impact deflation, fill gaps, stale metrics | selection being wrong |

Every problem this week — the cycler guard, fill-fidelity, impact deflation,
copyability retention — is a *symptom of racing someone*. This strategy races
nobody. That is its structural advantage, and it collapses the whole class of
latency bugs into a single question: is the selection signal real?

## Phase 1 — test the data (do this first)

"Held across the roster" is currently **descriptive**: it reports what the
roster holds, never that this predicts anything. Same shape as the wallet
cohort validation that already works:

1. Snapshot the top-N conviction tokens hourly, recording price + score.
2. Mark to market at +6h and +24h.
3. Compare high-conviction vs low-conviction buckets.

Cost: one batched price call per hour (30 mints per request) — effectively
free. If high conviction does not outperform, the module dies here and we have
saved ourselves the build.

## Phase 2 — build the idea (only if phase 1 confirms)

- Ladder entry: split target size into N clips over M minutes, sized to stay
  under ~1% of pool depth per clip (we already compute liquidity in the gauntlet).
- Exit: laddered out, or the price-driven trailing stop the copy module now uses.
- Its own book label so expectancy is measured separately from copy/consensus.
- Runs on a schedule, not on webhooks — a different shape of module entirely.

## The open question worth settling either way

Is a relentless one-directional buyer a **signal** (someone is supporting this
token) or a **warning** (the only thing holding the price up is a bot that will
eventually stop)? `922M9fBT…` being 25% underwater while doing it leans toward
warning. Tagging tokens that wallets like it are laddering into would settle it.
