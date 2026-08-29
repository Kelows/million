# Event-driven measurement — the pivot

**Status:** proposed. Nothing moved yet. Recorded before implementation so the
reasoning survives the refactor.

## What forced the question

Chasing "churner" wallets on 2026-08-29 found 36 wallets holding **5,685 SOL of
phantom profit**. The ledger booked the full proceeds of any sale with no
recorded buy as realized profit — no cost basis to subtract. One wallet showed
+1,256 SOL realized, of which 1,259 was unbacked.

Those wallets scored **117–167**, the top of our range, because
`whaleScore = winRate*100 + pnl/2` converts inflated PnL straight into rank —
which then drove absorption priority and websocket slot allocation. The cohort
validation's "110+ earns +28.9 SOL" is probably contaminated by the same rows.

The bug is fixed. The *cause* is structural and is not.

## Why complete history is unavailable, permanently

- An active wallet has 10,000+ lifetime transactions.
- Helius enhanced: 100 txs/page, 10 credits/call → ~1,000 credits per wallet.
- We cap at 10 pages, so we read roughly the most recent **10%**.
- 1,100 wallets, done properly: **>1M credits**, stale on arrival.

Truncation is not a tuning problem. It is the permanent condition.

## The better argument: correctness, not cost

We can only copy trades that happen **after** we start watching. So measuring
only what happens after we start watching is the *right* sample:

- no truncation — we saw every buy, so every cost basis is real
- no survivorship or lookahead bias
- every number describes a trade we could actually have taken

Historical PnL flatters wallets in ways that never transfer: positions opened
before we existed, at prices we could not get, with exits we would have missed.

## The split

| history (cheap 10-page scan) | events (forward) |
|---|---|
| triage: infra / sniper / distributor flags | cost basis, realized PnL |
| exclusion decisions | scoring and ranking |
| sampled — good enough for pattern detection | complete — the source of truth |

History is genuinely good at *"is this a bot?"*: patterns show up in any sample.
It is unreliable at *"how profitable is this wallet?"*: that needs complete
records. Conflating the two produced the phantom-PnL bug.

## Most of it already exists

- `RosterPosition` — cost basis maintained from live buys, seeded at analysis.
- `liveRealizedSol` — realized accumulated from live sells, basis retired
  proportionally, reset when analysis recomputes.
- The wallet detail overlay already prefers ledger truth over the snapshot.

Today the ledger is an **overlay** on the historical snapshot. The pivot makes it
**primary**: score from observed trades only; analysis provides flags and a
starting inventory, never P&L.

## Known cost: cold start

A wallet is unmeasured until it trades in front of us — perhaps two weeks for an
individual to reach 20 closed trades. Mitigation: the *population* accumulates
fast. 1,100 subscribed wallets already produce hundreds of events per hour, so
cohort-level questions resolve quickly while individual wallets stay provisional.

New scores need an explicit "unmeasured" state rather than defaulting to zero —
the accumulator bug (`922M9`, 924 buys / 0 sells, scored 0) showed what happens
when absence of data reads as absence of quality.

## Third-party enrichment — optional, verify first

Dune and Flipside index Solana DEX trades and are queried in SQL rather than paid
per transaction, which directly addresses "cannot scan everything". Birdeye and
Cielo expose wallet-PnL endpoints aimed at this use case.

Caveat worth respecting: that means trusting someone else's cost-basis logic, and
we have now found three places where ours was subtly wrong — quote-aware ledgers
(USDC-denominated traders), orchestrator attribution (fee-payer fleets), and
unbacked sells. **Validate any provider against a wallet we have measured
ourselves before relying on it.**

## Migration sketch

1. Add `observedRealizedSol` / `observedTrades` per wallet — closed round trips
   seen entirely by us, cost basis included.
2. Score from observed only; expose "unmeasured" where the sample is too small.
3. Keep analysis for flags and inventory seeding; stop reading its PnL.
4. Re-run cohort validation on observed data — the current result is suspect.
5. Optional: evaluate one third-party PnL API against our own measurements.
