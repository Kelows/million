# Definitions — what things mean in this system

The operational definitions the code currently uses, in one place, so refining
them is a decision rather than an accident. Every one of these is provisional.

## Wallet taxonomy (current, implicit — to be made explicit as "roles")

| term | current operational definition | where it bites |
|---|---|---|
| **analyzed** | has cached metrics from the quote-aware ledger (window = ANALYSIS_MAX_PAGES × 100 txs) | everything reads from this snapshot |
| **qualifying** | WR > 40% AND ≥ 2 closed tokens AND not BOT_INFRA | consensus, watch list, crawler token-picking |
| **whale (score)** | whaleScore = WR×100 + clamp(realizedPnL)/2; bots → −100 | Discover ranking, roster column, crawler absorption (≥ minWhaleScore) |
| **sniper** | median hold < 5 min over ≥ 5 closed | flag only — uncopyable, but watchable |
| **farmed (sus WR)** | WR > 90% over ≥ 20 closed | warning; blocks auto-absorb; never purged |
| **infra (BOT_INFRA)** | ≥50 txs AND (velocity >500/day over ≥6h span, OR >30% external fee payer, OR ≥20 deliveries with almost no sells, OR >500 counterparties, OR >100 sweep-ins) | excluded from everything; purgeable |
| **junk** | BOT_INFRA only (structural evidence) | purge + crawler skip |
| **subscribed** | user-chosen; live feed follows it | Live page, Opportunities triggers |
| *(missing)* **role** | trader / sniper / rugger / insider / infra as a deliberate label | planned — role decides what a Sub MEANS |

### Open questions on "what is a whale for us"
- Score weights are folklore (WR-heavy). The honest ranking is expected value
  per trade after latency — which is the copyability score's job. Until then,
  whaleScore is a placeholder and should be treated as one.
- Window bias: all stats are per-window (last N txs), not lifetime. A wallet
  judged on its worst/best 300 txs can flip category on re-analysis.
- Cluster identity: N addresses can be one actor. Until the overlap graph
  exists, "wallet" quietly means "address", and counts lie accordingly.

## Owner (the v2 entity — named 2026-08-27)

The actor above the address. One owner ↔ many addresses; today the system
pretends address = actor, and every count that matters quietly inherits that lie.

- **Evidence that two addresses share an owner** (all already sketched in the
  roadmap, now unified under this concept):
  - funding chains — one address bankrolls the other (Funding page finds these today, manually)
  - fee payer — the same orchestrator pays gas for both (topFeePayer surfaces this today)
  - co-entry timing — same tokens, same blocks, repeatedly (overlap graph)
  - block-0 double signatures / identical-amount bundles (memecoinbible heuristics)
- **What changes when Owner exists**:
  - stats, whale score, qualifying, roles — all aggregate at owner level
  - consensus counts owners, not addresses (the correctness fix)
  - Sub follows an owner: rotation to a fresh address doesn't drop the feed
  - purge/blacklist applies to the owner — a rugger can't shed the label by rotating
- **Status**: v2 (roadmap items 4b + 5 are this concept's two halves). Until
  built, read every wallet count with the address≈owner caveat.

## Token verdicts

| verdict | meaning |
|---|---|
| PASS | clears safety checks AND size failsafes |
| WARN | tradeable with caveats (mutable metadata, Token-2022, concentration, RugCheck warns, young pair) |
| FAIL | a critical check failed — authorities, rug risks, or below size failsafes |
| safety-clean | may FAIL on size but authorities/rug checks are clean — good enough to MINE for buyers, not to trade |

## Deployer history (current vs planned)

- **Current**: corpse count — prior launches with mcap < $1k. Weak: the ~98%
  base death rate means every prolific deployer looks guilty; missing RugCheck
  mcap data counts as dead (bias).
- **Planned ("deployer autopsy")**: per-launch trajectory over the last ~10 —
  first-candle→ATH multiple, time-to-death, faded-vs-extracted (LP pull /
  insider dump vs slow bleed). Distinguishes an unlucky builder from a serial
  extractor. Expensive → on-demand tool, not a per-check cost.
- **Two consumers, opposite signs**: safety (extractor = danger) vs hunting
  (predictable extractor = the memecoinbible play). Never mix the two readings.

## Opportunity

A **subscribed** wallet buys a token that is **new for that wallet** (no prior
live buy, absent from its analyzed history), spending ≥ minBuySol, and the
token's gauntlet verdict is PASS (or WARN when allowed). Deduped per token per
24h. Recency is the point: old open positions are noise; new entries are news.

## Consensus (demoted)

Tokens entered by ≥ 2 qualifying wallets in their windows. Kept as a report
(Recs); no longer gates anything. Weak while the roster is small and cluster
identity is unresolved.
