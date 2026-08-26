# The Closed Loop

Where every module converges. Written 2026-08-27, after the whale autopsy and the
first discovery/funding/screener iterations. This is the product thesis: each tool
is a stage of one pipeline, and the Gems feed is where the pipeline pays out.

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
3. **Paper trading** — every gem event records a simulated entry (configurable
   size, latency assumption, exit rule) and tracks it to resolution. This produces
   the number that decides everything else: does following the loop have positive
   expectancy after latency? No auto-execution until this says yes over a real
   sample (weeks, not days).
4. **Copyability score** — replay each whale's entries with +2 blocks of latency
   against real price paths; a whale whose edge dies in two blocks is decoration,
   not signal. Feeds wallet ranking and gem ranking both.
5. **Identity layer** — fee-payer clustering + funding-graph clustering: track
   the actor, not the address (the autopsy lesson). Rotated wallets inherit their
   operator's history; the roster stops decaying.
6. **Exclusion module** — infra score + manual exclude, with configurable-hop
   crawl to purge sibling wallets of anything excluded.
7. **Executor** — manual first: gem feed → pre-trade gauntlet re-check → human
   confirms → Jupiter swap with platform-fee bps (non-custodial; see
   docs/custody notes and the Custody artifact). Auto-mode is gated exclusively
   on paper-trading expectancy, never on excitement.
8. **Monetization** (if it ever goes multi-user): platform fee on executor swaps,
   referral fees — fee-on-flow without custody. We sell the road, we never hold
   the cargo.

## Invariants (things v2 must not break)

- Non-custodial, always. No float, no deposits, no "send us SOL".
- The gauntlet is advisory until paper stats justify more; the human owns entries.
- Every automated judgment (flag, verdict, score) shows its inputs in the UI —
  no black-box "trust me" labels.
- Dependency direction: analysis/ is the shared source layer; feature modules
  (wallets, screener, funding, discovery, recs, gems) stay leaves.
