# Memecoin Bible — parsed notes

Source: memecoinbible.dev (French, "Arthur" / F Project team — a 9-act course whose
funnel sells their block-0 infrastructure). Scraped and parsed 2026-08-27.
Read with that bias in mind: the strategy is real, but its full form is
infrastructure-gated by design — that's what they're selling.

## Their core play, in one line

**"Turn the scam against the scammer":** serial ruggers pump every launch
predictably (their own bundle buys block-0 → 2x+ by block 5). Track the rugger,
buy their NEXT launch at block-0, exit before their coordinated dump. Repeatable
because ruggers are the most consistent actors on the chain.

## The honest gate

Block-0 entry needs shredstream access + private nodes (~10k EUR/mo per their
own numbers). Manual/API traders land at blocks +4..+5 — i.e., exactly the exit
liquidity for the block-0 crowd. **Without that infra, their offense is not our
play.** But most of the components are usable without it — see below.

## Directly usable by us

### 1. Sub a villain (the user's instinct — and it's right)
Our Sub works on ANY wallet. Their labels, our feed:
- **Sub a serial rugger** → the moment they fund/deploy/enter a new token we get
  a live event. Two consumptions:
  - **Defense (build first, trivially cheap):** rugger touches token → token is
    auto-blacklisted / auto-FAIL in the gauntlet. An "avoid list" fed by the
    most reliable predictor there is: the scammer's own wallet.
  - **Offense (needs latency work):** their strategy — enter early on the
    rugger's pump, exit on time-based/size-based rule before the dump. Gated on
    our latency; paper-trade it first like everything else.
- **Sub a sniper**: uncopyable directly (SNIPER_SPEED flag exists for a reason)
  but their *choices* are information — what block-0 crowds pile into is a
  leading indicator of attention.
- Implies a small feature: **wallet roles** (trader / sniper / rugger / insider /
  infra) as a label separate from flags — subs then mean different things per
  role, and Opportunities can treat "rugger entered" as a red signal instead of
  a buy signal.

### 2. Deployer scoring beats deployer counting
Our deployer-history check counts dead tokens. Theirs scores profitability
pattern — keep a rugger "in portfolio" if, over the last 10 launches:
- ≥3 hit +100% from first candle to ATH (≥33% "win rate" — for the TRADER,
  not the holders)
- funding traceable on Solscan (opaque/mixed funding = discard)
- consistent rug pattern (same attack vector every time = predictable)
- worked example: 7×(+100%) − 3×(−30%) = +610% per 10-launch cycle
→ Upgrade path for our deployer check AND the future rugger-tracking module:
per-launch price trajectory, not just alive/dead.

### 3. Wallet clustering heuristics (feeds our overlap-graph design)
Their four identification methods, all implementable on our stack:
- **Block-0 double signature**: same wallet at block-0 across multiple launches
  = inhuman timing = operator wallet
- **Cluster overlap**: candidate wallet's activity vs a confirmed reference
  wallet — high overlap = same operator
- **Bundle patterns**: multiple wallets, identical amounts, same block
- **Big-candle extraction**: pull every wallet inside a large green/red candle —
  instant suspect list for coordinated action

### 4. Risk rules for our paper/auto trader (they match our invariants)
- max 5% of capital per trade
- hard stop after 5 consecutive losses (daily)
- halt the week at −35% capital
- their psych section: greed / FOMO / revenge-trading are the account killers;
  winners follow the rules mechanically. Our answer is the same: rules live in
  the executor, not in the human.

### 5. Numeric thresholds worth stealing
| thing | value | use |
|---|---|---|
| first-candle MC rejection | > $15k | too high = bad loss-to-floor ratio |
| pump.fun floor | ~$2.5k MC | downside reference |
| migration threshold | ~$35k MC | graduation reference (matches our data) |
| copytrade wallet WR | > 50% | matches our qualifying bar direction |
| rugger validation | ≥3/10 launches +100% | deployer scoring |
| block cadence | ~400ms | why blocks +4..5 = already 2x |

### 6. Copyability-score thesis: confirmed by the adversary
Their entire infrastructure pitch is a proof of our roadmap item: **edge decays
per block of latency**. A wallet whose wins are all block-0 entries is
decoration for us. When we build the copyability score, "entry block delta vs
pool creation" is the measurement — this source hands us the vocabulary.

## Tools they use (for our later evaluation)
- **Axiom** (Pulse): real-time token-creation feed
- **Shreder**: shredstream (pre-block) access — the paid moat
- Solscan for lineage walking (we already link everywhere)

## TODO seeds (added to TODO.md)
- Wallet roles (trader/sniper/rugger/insider/infra) + role-aware Sub semantics
- Rugger avoid-list: subbed rugger touches token → gauntlet auto-FAIL
- Deployer profitability scoring (per-launch trajectory over last 10)
- Cluster heuristics from §3 into the overlap-graph design
- Paper trader risk defaults: 5%/trade, 5-loss stop, −35% weekly halt
