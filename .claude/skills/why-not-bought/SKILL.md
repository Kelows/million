---
name: why-not-bought
description: Explain why million did or didn't buy a specific token, from its decision log and token checks. Use when the user asks "why didn't it buy X", "why did it buy X", pastes a token address, symbol or DexScreener link and wants to know what the deck thought of it.
argument-hint: "<token address, symbol or DexScreener link>"
---

# Why it did or didn't buy

## 1. Find the mint

- A base58 address: use it.
- A DexScreener/pump.fun/birdeye link: take the address from the URL. DexScreener
  links are often pool addresses and may be lowercased; resolve with
  `curl -s "https://api.dexscreener.com/latest/dex/search?q=<address>"` and take
  `baseToken.address` of the Solana pair.
- A symbol: `curl -s localhost:3001/api/tokens` and match; ask if several match.

## 2. Read what the deck decided

```sh
curl -s "localhost:3001/api/opportunities/decisions?mint=<MINT>&quiet=true&limit=100"
curl -s "localhost:3001/api/tokens/<MINT>"                 # symbol, verdict, liquidity
curl -s localhost:3001/api/trading                         # was/is it a position?
curl -s localhost:3001/api/opportunities/config            # the rules in force
```

Decisions are kept 3 days. `quiet=true` includes routine skips (small buys,
transfers, relays), which are often the answer.

## 3. Answer

Lead with the verdict in one sentence, then the chain, oldest first, in plain
words:

> It never became a trade: the only wallet you follow that bought it put in
> 0.4 ◎, under your 1.5 ◎ minimum for a copy signal.

Then, if a rule blocked it, name the setting and its current value, and what
changing it would also let in (more trades like this, including the bad ones).
Offer `/tune-rules`, don't change anything here.

**No decisions at all** means no wallet you follow touched it in 3 days (or the
feed was down then). Say that; offer `/find-first-whales <token>` to find wallets
that did buy it.

Never claim it "would have made money" as proof the rules are wrong: one
token is an anecdote.
