# million — the guide

Everything the [README](../README.md) leaves out: running it by hand, the live
feed and webhooks, paper and live trading, the research scripts, security, and
the layout of the repo. If you use an AI coding agent, `set me up` does most of
this for you.

- [What's in the deck](#whats-in-the-deck)
- [Requirements](#requirements)
- [Setup](#setup)
- [Live feed](#live-feed)
- [Trading](#trading)
- [Research tools](#research-tools)
- [Security notes](#security-notes)
- [Layout](#layout)

## What's in the deck

| Section | Page | What it's for |
|---|---|---|
| Intel | Overview | roster health at a glance, open positions |
| | Trading | open and closed positions, expectancy |
| | Trading rules | entry signals, exits, sizing, safety switches |
| | Wallets | the roster: import, analyze, subscribe, per-wallet history |
| | Tokens | everything seen, what the roster holds right now |
| | Opportunities | every signal, and why it did or didn't trade |
| | Flows | net buying and selling per token across the roster |
| | Live | the raw event stream |
| Scout | Discover | size buyers of any token |
| | Funding | who funded a wallet, to follow operators across addresses |
| | Token check | run the gauntlet on any mint |
| Ops | Crawler | the perpetual wallet ⇄ token crawl, with budgets |
| | Backtest | exit rules scored on cached candle paths |
| | Screener | batch token screening |

## Requirements

- **Node 24** (`nvm use` reads `.nvmrc`)
- **A Helius API key.** The free tier is enough to start: [dashboard.helius.dev](https://dashboard.helius.dev).
  The key is yours and never leaves your machine except to call Helius.
- **Optional:** a public URL for webhooks, only to follow more than 25 wallets
  (see [Live feed](#live-feed)). Without one, the `tunnel` pane just idles.
- [mprocs](https://github.com/pvolok/mprocs) (optional) to run everything in one terminal

## Setup

```sh
nvm use         # Node 24 from .nvmrc, in the same terminal as the rest
npm install     # builds packages/shared, creates apps/api/.env and the database
                # then add your HELIUS_API_KEY to apps/api/.env
mprocs          # or: npm run dev
```

The deck is at http://localhost:5173.

To start, paste a list of wallet addresses into **Wallets** (JSON, a plain list
or free text all work), analyze them and subscribe to the ones you want to
follow. Or open **Discover** on a token you know and pull its buyers.

## Live feed

Helius can push you every transaction your subscribed wallets make. There are
two ways to receive them.

**Websocket (no setup).** Leave `WEBHOOK_URL` empty. The API dials out to Helius
and subscribes wallet by wallet. It works from localhost, but it tops out at
**25 wallets**.

**Webhook (optional, no cap).** Helius posts transactions to a public URL, so your machine
needs one. This is the extra step, and it is deliberate: running a tunnel is a
small commitment, and anyone who does is probably going to watch the book too.

### Cloudflare Tunnel (what this repo uses)

You need a domain on Cloudflare.

1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels** and
   create a tunnel. Copy its token.
2. Add a public hostname, for example `million.yourdomain.com`, pointing to
   `http://localhost:3001`.
3. In `apps/api/.env`:
   ```sh
   WEBHOOK_URL="https://million.yourdomain.com"
   WEBHOOK_SECRET="some-long-random-string"   # Helius sends it back; other POSTs get 401
   TUNNEL_TOKEN="<the tunnel token>"
   ```
4. Install `cloudflared` (`brew install cloudflared`). The `tunnel` pane in
   `mprocs.yaml` reads the token from `.env`.

The API creates and maintains the Helius webhook for you, and replaces it if
Helius ever disables it.

### ngrok (alternative)

ngrok gives you one free static domain, so no domain of your own is needed:

```sh
ngrok http --url=your-name.ngrok-free.app 3001
```

Set `WEBHOOK_URL="https://your-name.ngrok-free.app"`. Watch the free tier's
monthly limits: this project started on ngrok and moved away after the quota ran
out and every delivery started coming back 403. The API notices a dead feed and
falls back to the websocket, but it's capped at 25 wallets.

### What the tunnel exposes

Only `/api/live/webhook`. Any request that arrives through a tunnel or proxy
(`cf-ray` or `X-Forwarded-*` headers) is refused on every other route, because
the API has no login and its config endpoint can switch on live trading. Keep it
that way.

## Trading

### Paper (default)

Every opportunity that passes your rules opens a simulated position. Fills are
priced at market plus the **measured** round-trip cost from a Jupiter quote for
that token, so the paper book pays roughly what live would.

**Stops only fire while the API is running.** Nothing protects a position
on-chain while the app is off: if your machine sleeps for a day, every stop that
should have fired in that day fires at once when it wakes, at whatever the price
is by then. That goes for live positions too.

### Live

One switch in `apps/api/.env` decides paper or live:

```sh
EXECUTOR=local
EXECUTOR_KEYPAIR_PATH=~/.million/keypair.json   # solana-keygen JSON, keep it outside the repo
```

With `EXECUTOR=local` set, **every opportunity that clears your rules is bought
with real SOL**, with no further confirmation. Leave it unset and the same
opportunities trade on paper. The deck's top bar shows which mode is running
(`PAPER` or a pulsing `◉ LIVE`). Restart the API after changing it.

Swaps go through Jupiter and are signed locally; your keys never leave your
machine. The executor enforces its own hard limits under whatever the strategy
asks for: `LOCAL_MAX_TRADE_SOL` (default 0.25 ◎ per trade) and
`LOCAL_MIN_BALANCE_SOL` (default 0.05 ◎ kept for fees).

### Developer fee

Each live swap pays a **0.25% fee** to the maintainer, in SOL, through Jupiter
(paper fills include it too). `FEE_BPS` in `apps/api/.env` lowers it; `FEE_BPS=0`
turns it off. If the fee can't be collected, the swap goes through without it.

## Research tools

`tools/` holds research and check scripts:

| Script | What it answers |
|---|---|
| `check-accounting.mjs` | Is every SOL number right? Worked examples, and with `--chain` real swaps checked against the validator's balances |
| `monte-carlo.mjs` | What does the book look like at 30 days, 180 days, 1 and 3 years, and how wide is that spread |
| `decision-clocks.mjs` | How many trades until the edge question and the fill question can be answered |
| `kill-criterion.mjs` | A stop rule for the whole strategy that actually triggers when there's no edge |
| `exit-rank-by-resolution.mjs` | Whether candle resolution changes which exit rule wins (it does) |

## Security notes

- **The API has no authentication.** It is meant to be reached from your own
  machine. Don't expose port 3001 directly.
- **The deck listens on your whole network** (`host: true` in
  `apps/web/vite.config.ts`) so you can check it from your phone. On a network
  you don't trust, remove that line: anyone who can reach port 5173 can change
  your trading rules.
- Keep the executor keypair outside the repo. `.gitignore` blocks common keypair
  file names, but don't rely on it.

## Layout

```
apps/api         NestJS API — Prisma + SQLite, Helius, Jupiter, DexScreener
apps/web         React deck — Vite, TanStack Router and Query, Tailwind
packages/shared  zod schemas and types shared by both
tools/           research and check scripts
tools/claude/    deck status and live watcher used by the agent skills
.claude/skills/  playbooks: setup, brief, why-not-bought, tune-rules, watch, find-first-whales
docs/            README images and this guide
CLAUDE.md        rules for Claude Code · AGENTS.md the same for other agents · llms.txt summary for AI crawlers
```
