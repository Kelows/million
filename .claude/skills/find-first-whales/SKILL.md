---
name: find-first-whales
description: Find wallets worth following from a Solana token or pool address, using the running million deck. Pulls the token's size buyers, analyzes the biggest, and keeps the ones with a real track record and the hold style asked for. Use when someone wants to seed their roster, find whales or smart wallets from a token, or asks who bought a token.
argument-hint: <token-or-pool-address> [hold range, e.g. "1h+" or "5-30 min"]
---

# Find your first whales

Turn one token into a short list of wallets worth following.

## 1. Check the deck is running

```sh
curl -s -m 5 http://localhost:3001/api/live/status
```

If that fails, tell the user to start it (`mprocs` or `npm run dev`) and stop.

## 2. Work out the arguments

- **Address:** a token mint or a pool address. Any case is fine: DexScreener URLs
  lowercase pool addresses, and the script recovers the real casing.
- **Hold range:** map what the user asked for to `--min-hold` / `--max-hold` in
  minutes. With no preference, use `--min-hold 120 --max-hold 10080` (2 hours to
  a week): in this project's measurements, patient wallets produced outsized
  winners far more often than the 30 min – 2 h band.
  If they ask for under 5 minutes, say once that the deck flags those wallets
  `SNIPER_SPEED` ("you cannot copy this manually") and that a copy fills seconds
  after them, then do what they asked.
- Start with `--mode recent`. If fewer than 5 size buyers come back, rerun with
  `--mode deep --pages 10` (buyers sampled across the token's whole life).

## 3. Run it

```sh
node tools/find-whales.mjs <address> --min-hold <m> --max-hold <m> --analyze 12
```

Each analysis spends Helius credits (about 10 per page of history, see
`ANALYSIS_MAX_PAGES`). Don't raise `--analyze` above 20 without asking.

## 4. Report back

- The token it resolved to (symbol and mint).
- Each pick: address, median hold, win rate over how many closed tokens, flags.
  Spell out any flag in plain words.
- If the script warns that most buyers are brand-new wallets, lead with that:
  it usually means one operator, not a crowd of whales, and none of them should
  be followed on this token's evidence.
- If it reports a cluster (wallets that traded mostly the same tokens), say they
  are one operator: at most one of them is worth following, and their shared win
  rate counts once, not once per address.
- If nothing fits, say so plainly and suggest an older token with organic buyers.

Every analyzed wallet is now in the roster, **unsubscribed**. Never present a win
rate as a promise: it comes from recent history.

## 5. Subscribing

Only if the user explicitly says yes, for specific addresses:

```sh
curl -s -X PUT http://localhost:3001/api/wallets/<address>/subscribe-owner \
  -H 'Content-Type: application/json' -d '{"subscribed": true}'
```

Before subscribing, mention that a very active wallet can flood the live feed
(the Live page shows events per wallet) and that unsubscribing is one click.
