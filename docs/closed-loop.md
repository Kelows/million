# The Closed Loop

Where every module converges. Written 2026-08-27, after the whale autopsy and the
first discovery/funding/screener iterations. This is the system thesis: each tool
is a stage of one pipeline, and the Gems feed is where the pipeline pays out.

**Scope decision (2026-08-27): this is a personal system for the two of us, not a
product.** No users, no custody questions, no growth concerns. The end state is a
perpetual, autonomous loop: subs stream whale activity in, the roster maintains
itself, consensus fires as events, junk dies at the gauntlet, gems accumulate —
and entries execute on rules, first on paper, then (stats permitting) live.

## The loop

```
        WALLETS (roster)                    TOKENS
  ┌──────────────────────────┐   ┌──────────────────────────┐
  │ import / funding chains  │   │ consensus (recs)         │
  │ discovery (size buyers)  │──▶│ + fresh buys by          │
  │ analyzer: WR/PnL/flags   │   │   qualifying wallets     │
  └────────────▲─────────────┘   └────────────┬─────────────┘
               │                              ▼
        add clean whales  ◀──────  TOKEN GAUNTLET (screener)
        from gem tokens            failsafes + authorities +
                                   deployer + holders + rugcheck
                                              │
                                              ▼
                                      💎 GEMS FEED
                            tokens that survived everything,
                            ranked by whale conviction
```

Two flywheel effects, one per direction:

- **Tokens → wallets**: every gem's size buyers run through Discover; the clean
  ones join the roster. Good tokens find good wallets.
- **Wallets → tokens**: every qualifying wallet's open positions feed consensus;
  overlap surfaces candidate tokens. Good wallets find good tokens.

The screener gauntlet sits between the two so that neither direction can inject
garbage: infra/bot wallets are flagged out on one side, rug-shaped tokens are
gated out on the other.

## Gems v1 (buildable now)

- **Candidates**: consensus tokens from the latest recs run — held open (≥ min
  entry size, stables excluded) by ≥ 2 qualifying, non-bot wallets.
- **Gauntlet**: full token check per candidate, server-side — user failsafes
  (min liquidity, min mcap, max top-10 %, min pair age) + mint/freeze authority,
  metadata mutability, token program, deployer history, LP-excluded holder math,
  RugCheck risk scan.
- **Strictness**: default shows PASS only; a toggle admits WARN with the warnings
  listed. FAIL/UNKNOWN never shows without explicit "show everything".
- **Ranking**: whale count desc, then combined whale realized PnL, then liquidity.
- **Each row**: verdict, holders (clickable whales), liq/mcap/age, links into
  token check and Discover.
- **Known limitation**: freshness is bounded by analysis recency. Consensus comes
  from cached snapshots — gems are hours old. Good enough to validate the loop,
  not to race it.

## The crawler formulation (agreed 2026-08-27)

The loop, restated as a perpetual crawler the user can switch on:

- **Sources** (user selects, minimum one): *wallets* (the roster / subs) and/or
  *tokens* (the tracked-token roster). Either side can seed an iteration.
- **One iteration**: token → size buyers that qualify (Discover + analyzer) →
  their open positions → consensus → gauntlet → gems → each gem's buyers → back
  into the wallet source. From a wallet source it starts half a turn later at
  the consensus step. Both directions meet in the middle.
- **Perpetual, if wanted**: the crawler re-runs on a cadence or on webhook
  events, forever, absorbing clean wallets and gems as it goes.
- **Budgets are part of the design, not an afterthought**: per-iteration API
  budget, hop limits, dedup against already-visited wallets/tokens, and a
  global pause switch. An unbounded crawl burns the Helius quota in minutes and
  mostly re-discovers plumbing — the gauntlet and BOT_INFRA filters are what
  keep a perpetual crawl from filling the roster with junk.

## V2 vision

Ordered by dependency, not ambition:

1. **Live ingestion** — Helius webhooks on subscribed wallets (the roster "Sub"
   button becomes real). Every swap by a tracked whale lands in the DB within
   seconds; analyses become incremental updates instead of full refetches.
   Consensus becomes an event ("3rd qualifying whale entered X"), not a snapshot.
2. **Gems becomes a feed, not a report** — new consensus events run the gauntlet
   automatically; passing tokens appear in real time with an alert hook
   (Telegram/Discord webhook out). This is the moment the loop is actually closed:
   discovery → screening → signal without a human clicking between stages.
   The roster self-maintains in the same motion: new counterparties are
   auto-previewed and absorbed when clean; infra/farmed wallets are flagged out;
   dormant wallets decay; funding chains follow actors across address rotations.
3. **Paper trading** — every gem event records a simulated entry (configurable
   size, latency assumption, exit rule) and tracks it to resolution. This produces
   the number that decides everything else: does following the loop have positive
   expectancy after latency? No auto-execution until this says yes over a real
   sample (weeks, not days). Built right, paper -> live is a single flag flip:
   the whole pipeline runs identically either way, only the fill is real.
4. **Copyability score** — replay each whale's entries with +2 blocks of latency
   against real price paths; a whale whose edge dies in two blocks is decoration,
   not signal. Feeds wallet ranking and gem ranking both.
4b. **Wallet overlap graph** (promoted 2026-08-27 — this is a consensus
   correctness fix, not a visualization): wallets that repeatedly co-enter the
   same tokens in tight time windows are one actor or one signal source. Until
   clustered, a cluster of N wallets co-entering counts as N independent
   confirmations in consensus — inflating the exact number the loop keys on.
   Design: edge weight = co-entries within a time window / total entries;
   cluster via connected components above a threshold; consensus then counts
   CLUSTERS, not wallets. Bonus: a cluster's aggregate stats beat any single
   member's, and funding chains + fee-payer data merge into the same graph.
5. **Identity layer** — fee-payer clustering + funding-graph clustering: track
   the actor, not the address (the autopsy lesson). Rotated wallets inherit their
   operator's history; the roster stops decaying.
6. **Exclusion module** — infra score + manual exclude, with configurable-hop
   crawl to purge sibling wallets of anything excluded.
7. **Executor** — manual first: gem feed → pre-trade gauntlet re-check → human
   confirms → Jupiter swap (non-custodial, our own keys, no one else's money).
   Auto-mode is gated exclusively on paper-trading expectancy, never on
   excitement. Rules over feelings: sizing from config, exit defined before
   entry, hard daily loss cap that halts the loop when hit.
8. **Deployment** — one always-on NestJS process (small VPS or a spare machine at
   home): webhook receiver + event queue + the existing modules. The web UI stays
   the cockpit; the daemon does the work.
9. **Monetization** — parked. Only relevant if this ever serves anyone but us;
   the non-custodial fee-on-flow path (platform bps on executor swaps) is
   documented in the Custody artifact if that day comes.

## Invariants (things v2 must not break)

- Non-custodial, always. No float, no deposits, no "send us SOL". Personal
  system or not, we never hold anyone else's money.
- The gauntlet is advisory until paper stats justify more; the human owns entries.
- The kill switch outranks the loop: a daily loss cap, a global pause flag, and
  position-size ceilings are enforced in the executor itself, not in the UI.
- Capital exposed to the loop is capital we can lose to zero; the loop never
  touches more than its allocation.
- Every automated judgment (flag, verdict, score) shows its inputs in the UI —
  no black-box "trust me" labels.
- Dependency direction: analysis/ is the shared source layer; feature modules
  (wallets, screener, funding, discovery, recs, gems) stay leaves.
