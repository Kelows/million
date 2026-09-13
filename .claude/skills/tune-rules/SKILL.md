---
name: tune-rules
description: Change million's trading rules or token checks through conversation — safer, more trades, bigger or smaller, different exits, a preset — showing exactly what changes before saving. Use when the user wants the deck to behave differently ("make it safer", "it trades too much", "only follow consensus", "use 0.2 SOL per trade", "tighter stop").
argument-hint: "[what they want changed]"
---

# Tune the rules

Read `CLAUDE.md` rules first. This skill never switches paper to live.

## 1. Read what's in force

```sh
curl -s localhost:3001/api/opportunities/config > /tmp/million-rules.json
curl -s localhost:3001/api/crawler | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).config,null,1)))' > /tmp/million-crawler.json
```

Field meanings live in `OpportunityConfigSchema` and `STRATEGY_PRESETS` in
`packages/shared/src/index.ts` (read the comments there). Don't guess a field
name: check the schema.

## 2. Translate intent into fields

Common requests:

| They say | Usually means |
|---|---|
| safer / fewer bad trades | raise `minBuySol`, require consensus (`tradeSignals: "consensus"`), lower `positionSol`, lower `maxOpenPositions` |
| more trades | lower `minBuySol`, `tradeSignals: "all"` |
| smaller / bigger | `positionSol`, `maxTotalExposureSol`, `bankrollSol` (paper only) |
| exits | `exitMode`, `stopLossPct`, `takeProfitPct`, `trailStopPct` |
| a style | a preset from `STRATEGY_PRESETS` (Swing Copy, Measured Mirror, Consensus Chorus, Launch Surf) |
| stricter tokens | crawler `thresholds` (liquidity, holders…) |

If the request is vague, ask one question with 2–3 concrete options.

## 3. Show the change, then save

Show a short before → after list of only the fields that change, each with one
line on the trade-off. Then save (the PUT replaces the whole object, so merge
into the file you read):

```sh
curl -s -X PUT localhost:3001/api/opportunities/config -H 'Content-Type: application/json' -d @/tmp/million-rules.json
curl -s -X PUT localhost:3001/api/crawler/config -H 'Content-Type: application/json' -d @/tmp/million-crawler.json
```

Read the config back and confirm the values stuck (zod may clamp them).

## Rules

- Never set `EXECUTOR`. Going live is `/setup-million` step 8, with the typed sentence.
- Rule changes apply to new signals; open positions keep their exits.
- No promises: "this should trade less" is fine, "this will be more profitable" is not.
