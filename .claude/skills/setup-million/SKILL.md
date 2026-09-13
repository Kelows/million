---
name: setup-million
description: Set up the million whale deck end to end for a user — check prerequisites, install, add their Helius key, start it, ask what they want to do, then configure trading rules, token checks, wallets and the live feed through the local API. Use when someone has just cloned million, asks to install or set it up, or wants it reconfigured for a different goal.
argument-hint: "[optional: what they want, e.g. 'paper trade patient whales with 5 SOL']"
---

# Set up million

Get the user from a fresh clone to a running, configured deck. Read `CLAUDE.md`
first: its **Rules for agents** apply to every step here.

Do the work yourself. Ask only what you can't know, a few questions at a time,
and explain choices in one plain sentence each.

## 1. Prerequisites

Check, and fix what you can:

- `node -v` → 22.x (`.nvmrc`). If not, suggest `nvm install 22 && nvm use`.
- `npm -v` works.
- Optional, only needed later: `mprocs` (one terminal for everything),
  `cloudflared` (webhook feed). Don't install these unprompted.

## 2. Install

```sh
npm install                              # also builds packages/shared
[ -f apps/api/.env ] || cp apps/api/.env.example apps/api/.env
npm run db:push
```

## 3. Helius key

The deck can't see the chain without it. If `HELIUS_API_KEY` in `apps/api/.env`
is empty:

- Tell them to create a free key at https://dashboard.helius.dev and either
  paste it into `apps/api/.env` themselves, or paste it here.
- If they paste it here, write it into `.env` and never print it back.

Verify without showing it:

```sh
set -a; . apps/api/.env; set +a
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
```

`200` = good. Anything else: the key is wrong; ask them to check it.

## 4. Start it

Recommend they run `mprocs` (or `npm run dev`) in their own terminal, so it keeps
running after this conversation. Then wait for:

```sh
curl -s localhost:3001/api/health        # {"ok":true,"heliusConfigured":true}
```

The deck is at http://localhost:5173.

## 5. Ask what they want

Use the question tool if available. Skip anything already stated in the
arguments. Four questions are enough:

1. **Goal**
   - *Watch and learn* — follow wallets, see signals, no positions
   - *Paper trade* — every signal opens a simulated position (recommended start)
   - *Live later* — paper now, set up to switch when they choose
2. **Style**
   - *Patient* — few trades, wallets that hold for hours or days → **Swing Copy**
   - *Balanced* — tight trailing exits, all signal types → **Measured Mirror**
   - *Crowds* — only when several different owners agree → **Consensus Chorus**
   - *Fast launches* — young, thin pools, high variance → **Launch Surf**
3. **Size** (paper SOL for now): bankroll, and the most per position.
4. **Wallets to start from**: a list they already have · a token they like (use
   `/find-first-whales`) · none yet (the crawler finds some, spending credits).

## 6. Configure

Presets live in `packages/shared` as `STRATEGY_PRESETS`; read them with
`node -e 'console.log(JSON.stringify(require("./packages/shared/dist").STRATEGY_PRESETS,null,1))'`.
Config routes replace the whole object: read, change, write back.

**Trading rules**

```sh
curl -s localhost:3001/api/opportunities/config > /tmp/rules.json
# merge: preset.opportunity, then their answers, then strategyPreset: "<preset name>"
curl -s -X PUT localhost:3001/api/opportunities/config -H 'Content-Type: application/json' -d @/tmp/rules.json
```

From their answers:
- *Watch and learn* → `positionSol: 0` (signals still show and get explained;
  nothing opens).
- Sizing → `sizingMode: "whale-frac"`, `bankrollSol`, `positionSol` = their max
  per position, `maxTotalExposureSol` ≈ a third of the bankroll unless they say
  otherwise, `maxOpenPositions` 10–20.

**Token checks**: merge `preset.thresholds` into the crawler config:

```sh
curl -s localhost:3001/api/crawler | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).config)))' > /tmp/crawler.json
# set .thresholds = { ...current, ...preset.thresholds }; leave .enabled as it is
curl -s -X PUT localhost:3001/api/crawler/config -H 'Content-Type: application/json' -d @/tmp/crawler.json
```

Turn the crawler on (`enabled: true`) only if they chose "none yet", and say it
spends Helius credits every iteration.

**Wallets**
- A list → `POST /api/wallets/import` `{"wallets":[...],"source":"setup"}`, then
  `POST /api/wallets/analyze-pending` and poll `GET /api/wallets/jobs/analyze-pending`.
  Say analysis spends credits first if the list is long.
- A token → run `/find-first-whales <token>`.
- Subscribe only the wallets they pick: `PUT /api/wallets/<address>/subscribe`
  `{"subscribed":true}`. Suggest starting with 5–15.

## 7. Live feed

- **Up to 25 wallets:** nothing to do. With `WEBHOOK_URL` empty the API uses a
  websocket. Confirm with `GET /api/live/status` (`connected: true`).
- **More than 25:** they need a public URL. Walk them through the README's
  *Live feed* section (Cloudflare Tunnel, or ngrok) and fill `WEBHOOK_URL`,
  `WEBHOOK_SECRET`, `TUNNEL_TOKEN` in `.env` — they paste the tunnel token
  themselves. Restart the API afterwards.

## 8. Live trading — only if they ask

Paper is the default and stays that way unless they explicitly ask for live.
Then, before touching anything, say plainly:

> With `EXECUTOR=local`, every opportunity that clears your rules is bought with
> real SOL from that wallet, with no confirmation. Fund it only with what you can
> lose. The authors aren't responsible for losses.

If they still say yes: they create or place the keypair themselves at
`~/.million/keypair.json` (never you); you set `EXECUTOR=local` in `.env`; they
restart the API; the deck's top bar shows `◉ LIVE`. The developer fee (0.25% per
swap, `FEE_BPS` to lower or disable) applies — mention it.

## 9. Hand over

Finish with a short summary:
- the mode (paper / watch-only / live) and the preset, with the few numbers they set
- how many wallets are subscribed, and the feed status
- where to look: **Opportunities** (signals and the decision log explaining every
  skip), **Trading** (positions), **Trading rules** (to change anything)
- that stops only fire while the API runs, so keep it on, or stay on paper
