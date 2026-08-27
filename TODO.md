# Roadmap

## Phase 1 — wallet analyzer (current)
- [x] Import whale JSON → roster
- [x] Per-wallet analysis: swaps, win rate, realized PnL (SOL), hold times, flags
- [ ] Additive multi-column sort on tables (shift-click to add a secondary sort key)
- [ ] Bulk "analyze all" queue with rate limiting on the API side (frontend loops for now)
- [ ] Copyability metric: re-simulate each whale entry with +2 blocks latency — does the edge survive?
- [ ] Wallet overlap graph / clustering (PROMOTED — consensus correctness): co-entry edges + funding + fee-payer -> clusters; consensus counts clusters, not wallets. See docs/closed-loop.md v2 item 4b
- [ ] Track NEW addresses of known whales (funding graph: old wallet funds fresh wallet)

## Learned from the 2snHH deep dive (2026-08-27)
- [ ] CRITICAL analyzer gap: metrics.ts only prices SOL legs — wallets trading with USDC/USDT as base show zero PnL. Port the quote-aware ledger from tools/wallet-dig.mjs into the analyzer
- [ ] BOT_INFRA wallet flag: tx velocity (>500/day), buys-without-sells + token deliveries to third parties, huge unique-counterparty count, external fee payer on most txs, constant in-tx skim address, relay round-trip pattern -> exclude from recs/watch
- [ ] Fee-payer clustering: the orchestrator paying fees is a stronger identity key than the wallet address (whole ops rotate wallets daily but keep the orchestrator)
- [ ] Exclusion module (design agreed, build when clear): per-wallet infra score from cheap signals (tx/day, buys-without-sells + outbound deliveries, unique counterparty count, external fee-payer share, constant skim address, relay round-trips) -> BOT_INFRA flag + manual "exclude" toggle; excluded wallets drop out of recs/watch/consensus. Later: configurable-hop crawl to find sibling wallets of an excluded one
- [ ] type=SWAP fetch misses custom-program swaps (43% were UNKNOWN in the case study) — consider all-type fetch + own classification for deep analysis

## Phase 2 — token legitimacy screener (research needed)
How to tell if a token is legit — checks to implement, roughly in order of signal:
- [ ] Mint authority revoked (can't print more supply) — Helius DAS `getAsset`
- [ ] Freeze authority revoked (can't freeze your tokens = soft honeypot)
- [ ] LP burned or locked, and what % — Raydium/pump.fun AMM state
- [ ] Sell simulation (hard honeypot check): can a wallet actually sell?
- [ ] Top-10 holder concentration % (exclude LP) — under ~25% is sane
- [ ] Deployer wallet history: serial rugger detection (past tokens → how did they end?)
- [ ] Sniper/bundle concentration in first blocks (bundled buys = team supply hidden)
- [ ] Token age + holder growth curve (organic vs. botted)
- [ ] Metadata: socials exist, not copy-pasted from another token
- [ ] APIs to evaluate: RugCheck API, Birdeye token security, SolSniffer, DexScreener (liq/mcap/pairs)
- [ ] Failsafe config (already in UI): min liquidity 100k, min market cap 200k — make these enforced server-side

## Phase 3 — entry system (manual first)
- [ ] Manual executor: human inputs token + amount → screener failsafes run → confirm → swap (Jupiter API)
- [ ] Hard limits: max position size, daily loss cap, per-token exposure cap
- [ ] Exit rules BEFORE entry is allowed (research says exits are where copiers lose 60–80%)
- [ ] Paper-trade mode: log the trade without executing (validate the system risk-free first)

## Phase 4 — signal ingestion + auto mode (much later)
- [ ] Wire the roster 'sub' button (currently a localStorage mock): subscribed wallets feed Helius webhooks -> failsafe pipeline -> alerts/entries
- [ ] Live whale-entry feed (Helius webhooks on tracked wallets)
- [ ] Auto mode = whale entry → screener pass → sized entry, ONLY after paper-trade stats prove positive expectancy
