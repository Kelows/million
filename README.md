# million

**An open-source, self-hosted Solana whale tracker and copy-trading deck.** It
watches the wallets you follow, finds more wallets through the tokens they buy,
filters out bots and rugs, and trades the signals that survive: on paper by
default, live only when you choose. You can run the whole thing by talking to
Claude Code.

![The million deck: roster, open positions and PnL at a glance](docs/deck.png)

**Start in three lines** (Node 22 and [Claude Code](https://claude.com/claude-code)):

```sh
git clone https://github.com/Kelows/million && cd million
claude
> set me up
```

Without Claude Code: `nvm use && npm install && mprocs`, put a free
[Helius](https://dashboard.helius.dev) key in `apps/api/.env`, open
http://localhost:5173.

| To start you need | To start you don't need |
|---|---|
| Node 22 | a webhook, tunnel, domain or Cloudflare account |
| a free Helius API key | a trading wallet or any SOL (paper trading is the default) |
| | an account anywhere: it runs on your machine |

Without a webhook the live feed uses a websocket and follows up to 25 wallets.
A webhook only lifts that cap ([Live feed](#live-feed)).

> **Experimental. Provided as is, with no warranty.** This is a research tool,
> not a money printer, and nothing in it is financial advice. Trading meme coins
> can lose you everything you put in. If you trade real money with it, that is
> your decision and your risk: the authors are not responsible for any loss.
> Start on paper.

## Talk to it: million is the engine, Claude is the operator

You don't need to know what a webhook is. You don't need to read a single line
of this repo. If you can type a sentence, you can run a whale deck.

Every whale you've watched buy a coin at 3am, while you were asleep, reading
charts or doing it all by hand: that's the gap. million watches the wallets
without blinking. Claude Code sits on top of it and does the part that used to
need a developer: installing it, wiring it up, explaining what it did, changing
it when you ask.

```text
you     set it up. I have 5 SOL, I want to paper trade patient whales first
claude  installs the deck, checks your Helius key, asks three questions,
        applies the Swing Copy preset, sizes it to your 5 SOL, starts the feed

you     how's it going?
claude  Paper, feed healthy, 2 positions open. STONK closed +7% on the
        trailing stop. CATE fired a ladder signal but was already bought an
        hour ago, so it waited.

you     why didn't it buy K7Pa…pump? everyone was talking about it
claude  Only one wallet you follow bought it, with 0.4 SOL: under your
        1.5 SOL minimum for a copy signal. Lowering it would also let in
        every small, noisy buy. Want to change it?

you     find me whales from this token: <address>
claude  pulls its biggest buyers, analyzes them, flags the four wallets
        that are really one operator, and adds the rest for you to pick

you     watch it and tell me when it buys
claude  OPENED FRIES · 0.2 SOL (paper) · copy signal from AgmL…zN51,
        a wallet you follow that bought 1.8 SOL of it a second ago
```

(An illustration of the conversation, not a record of trades.)

Start with the three lines at the top of this page. Claude reads the project, follows the setup skill, and asks you for
what only you can decide: your Helius key, your size, your style, the wallets to
start from. Everything it runs is in the open, in this repo.

What Claude can do with it:

| You say | Claude runs |
|---|---|
| "set me up" | `/setup-million`: install, key, questions, presets, wallets, feed |
| "how's it going?" | `/million-brief`: health, positions, results, the most telling skip |
| "why didn't it buy X?" | `/why-not-bought`: the decision log for that token, in plain words |
| "make it safer" / "0.2 SOL per trade" | `/tune-rules`: shows the before → after, then saves |
| "watch it" | `/watch-deck`: live updates in the chat when it opens, closes or goes blind |
| "find me whales from this token" | `/find-first-whales`: a token's buyers, analyzed, clusters flagged |

When you open Claude Code in the repo, a hook tells Claude the deck's state
before you type anything, so "how's it going?" works from the first message.

Some things stay yours no matter how you ask. Claude never switches paper to
live on its own: you have to type
`I understand every signal will spend real SOL and I can lose all of it`
yourself. It creates a trading wallet without ever showing its secret key, and
it never prints your API keys back.

No Claude Code? Everything below works by hand too.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/loop-dark.svg">
  <img alt="The loop: 1,917 wallets and 24,115 tokens feed each other, pass through their filters down to 51 subscribed wallets and 47 clean tokens, merge into 143 opportunities and 26 positions, and every trade's outcome loops back to re-score wallets and re-tune the rules." src="docs/loop-light.svg">
</picture>

<sub>Counts from the first instance. Ribbon height is proportional to log(count): the narrowing is the filter.</sub>

Everything feeds everything.

- **Wallets find tokens.** Every swap a subscribed wallet makes arrives through a
  Helius webhook within seconds. A new buy puts that token on the table.
- **Tokens find wallets.** For any token, the crawler pulls its size buyers,
  analyzes them, and absorbs the ones that look like traders rather than bots,
  routers or distributors.
- **Two filters sit in the middle.** Wallets are flagged on behaviour (bot and
  infrastructure patterns, hold style, copyability). Tokens run a gauntlet:
  mint and freeze authority, liquidity, market cap, holder concentration,
  deployer history, a Jupiter sell simulation, RugCheck.
- **Signals.** When a subscribed wallet buys a token that passed, that's an
  opportunity: *copy* (one sized buy), *consensus* (several distinct owners in a
  window, with buyers outweighing sellers) or *ladder* (repeated small buys that
  add up). Wallets that keep entering the same tokens together are merged into
  one owner, so a cluster of addresses gets one vote.
- **Trades.** Opportunities open positions with a trailing stop, a hard stop and
  a breakeven ratchet, sized from your bankroll.
- **The loop back.** Every round trip a wallet completes re-scores it, and wallets
  with styles that don't pay get churned out. Trades the filters skipped keep
  being priced as shadow positions, and cached candle paths feed the backtester,
  so the rules can be tested against what actually happened.

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

- **Node 22** (`nvm use` reads `.nvmrc`)
- **A Helius API key.** The free tier is enough to start: [dashboard.helius.dev](https://dashboard.helius.dev).
  The key is yours and never leaves your machine except to call Helius.
- **Optional:** a public URL for webhooks, only to follow more than 25 wallets
  (see [Live feed](#live-feed)). Without one, the `tunnel` pane just idles.
- [mprocs](https://github.com/pvolok/mprocs) (optional) to run everything in one terminal

## Setup

```sh
nvm use         # Node 22 from .nvmrc, in the same terminal as the rest
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
docs/            README images
CLAUDE.md        rules for Claude Code · AGENTS.md the same for other agents · llms.txt summary for AI crawlers
```

## How it compares

Hosted Solana trading bots and terminals (Photon, GMGN, Axiom, Trojan and
similar) are fast and polished. million makes different trade-offs:

| | Hosted bots and terminals | million |
|---|---|---|
| Where it runs | their servers | your machine |
| Trading keys | usually generated or held by the service | a keypair file on your disk, only if you go live |
| Fee | typically 0.5–1% per trade | 0.25% per live swap, `FEE_BPS=0` turns it off |
| Code | closed | open source, MIT |
| Why a trade did or didn't happen | usually not shown | every decision logged with its reason |
| Paper trading | varies | the default, with measured slippage and fees |
| Rules | the settings they expose | every threshold, in code you can change |

What million doesn't do: sniping new launches, a mobile app, or hosting for
you. If a stop has to fire, the deck has to be running.

## FAQ

**Is there an open-source Solana copy-trading bot I can self-host?**
Yes, this one. Clone it, run it locally, read every line. MIT licensed.

**Do I need a webhook, a tunnel or a domain?**
No. The live feed works over a websocket for up to 25 followed wallets. A
webhook (Cloudflare Tunnel or ngrok) is only for following more.

**Do I need a Helius API key?**
Yes, a free one. It's how the deck reads wallet histories and live
transactions. It stays in `apps/api/.env` on your machine.

**Does it hold my private key or my money?**
No. Paper trading, the default, needs no wallet at all. Live trading signs with
a keypair file on your own disk, and it only turns on when you set
`EXECUTOR=local` yourself.

**Can it trade real SOL automatically?**
Only if you switch it on. Then every signal that passes your rules is bought
with real SOL without asking, within the per-trade cap you set. Start on paper.

**How does it find whales?**
From tokens: pull a token's biggest buyers, analyze their trading history, and
flag bots, relays and clusters of wallets run by one person (see
`/find-first-whales`). From wallets: every token a followed wallet buys leads to
more wallets.

**Why didn't it buy a token I expected?**
Ask Claude (`/why-not-bought <token>`) or open the token page: every decision is
logged with the rule that stopped it.

**Does it work with AI agents other than Claude Code?**
Everything the deck does is a plain local HTTP API, documented in `AGENTS.md`,
so any coding agent can drive it. The skills in `.claude/skills` are written for
Claude Code.

**Is it profitable?**
Nobody can promise that, and this project's own measurements found past returns
don't predict future ones. Treat it as a research tool and start on paper.

## License

[MIT](LICENSE). Provided as is, without warranty: see the status note at the top.
