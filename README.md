# million

**An open-source, self-hosted Solana whale tracker and copy-trading deck that
you run by talking to Claude Code.** It watches the wallets you follow, finds
more wallets through the tokens they buy, filters out bots and rugs, and trades
the signals that survive.

![The million deck: roster, open positions and PnL at a glance](docs/deck.png)

**Start in three lines** (Node 22 and [Claude Code](https://claude.com/claude-code)):

```sh
git clone https://github.com/Kelows/million && cd million
claude
> set me up
```

| To start you need | You don't need |
|---|---|
| Node 22 | a webhook, tunnel, domain or Cloudflare account |
| a free [Helius](https://dashboard.helius.dev) API key | a wallet or any SOL: it paper-trades until you switch live trading on |
| | an account anywhere: it runs on your machine |

Without a webhook the live feed uses a websocket and follows up to 25 wallets;
a webhook only lifts that cap.

> **Experimental. Provided as is, with no warranty.** This is a research tool,
> not a money printer, and nothing in it is financial advice. Trading meme coins
> can lose you everything you put in. If you trade real money with it, that is
> your decision and your risk: the authors are not responsible for any loss.

## Talk to it: million is the engine, Claude is the operator

You don't need to know what a webhook is. You don't need to read a single line
of this repo. If you can type a sentence, you can run a whale deck.

Every whale you've watched buy a coin at 3am, while you were asleep, reading
charts or doing it all by hand: that's the gap. million watches the wallets
without blinking. Claude Code sits on top of it and does the part that used to
need a developer: installing it, wiring it up, explaining what it did, changing
it when you ask.

```text
you     set it up. I have 5 SOL and I want to follow patient whales
claude  installs the deck, checks your Helius key, asks three questions,
        applies the Swing Copy preset, sizes it to your 5 SOL, starts the feed

you     how's it going?
claude  Feed healthy, 2 positions open. STONK closed +7% on the
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
claude  OPENED FRIES · 0.2 SOL · copy signal from AgmL…zN51,
        a wallet you follow that bought 1.8 SOL of it a second ago
```

(An illustration of the conversation, not a record of trades.)

Start with the three lines at the top of this page. Claude reads the project,
follows the setup skill, and asks you for what only you can decide: your Helius key, your size, your style, the wallets to
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

Some things stay yours no matter how you ask. Claude never turns on live
trading by itself: you have to type
`I understand every signal will spend real SOL and I can lose all of it`
yourself. It creates a trading wallet without ever showing its secret key, and
it never prints your API keys back.

No Claude Code? Everything works by hand too: see the [guide](docs/GUIDE.md).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/loop-dark.svg">
  <img alt="The loop: 1,917 wallets and 24,115 tokens feed each other, pass through their filters down to 51 subscribed wallets and 47 clean tokens, merge into 143 opportunities and 26 positions, and every trade's outcome loops back to re-score wallets and re-tune the rules." src="docs/loop-light.svg">
</picture>

<sub>Counts from the first instance. Ribbon height is proportional to log(count): the narrowing is the filter.</sub>

Everything feeds everything.

- **Wallets find tokens.** Every swap a subscribed wallet makes arrives through
  Helius within seconds. A new buy puts that token on the table.
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
  a breakeven ratchet, sized from your bankroll. Exits are checked every few
  seconds, and the moment a wallet you follow trades a token you hold.
- **The loop back.** Every round trip a wallet completes re-scores it, and wallets
  with styles that don't pay get churned out. Trades the filters skipped keep
  being priced as shadow positions, and cached candle paths feed the backtester,
  so the rules can be tested against what actually happened.

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
No. Until you switch live trading on, it needs no wallet at all. Live trading
signs with a keypair file on your own disk, and only turns on when you set
`EXECUTOR=local` yourself.

**Can it trade real SOL automatically?**
Only if you switch it on. Then every signal that passes your rules is bought
with real SOL without asking, within the per-trade cap you set.

**How do I set it up by hand, add a webhook or go live?**
The [guide](docs/GUIDE.md) covers setup, the live feed (Cloudflare Tunnel or
ngrok), live trading, the developer fee and security.

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
so any coding agent can drive it. The playbooks in `.claude/skills` are plain
Markdown that any agent can follow.

**Is it profitable?**
Nobody can promise that, and this project's own measurements found past returns
don't predict future ones. Treat it as a research tool.

## License

[MIT](LICENSE). Provided as is, without warranty: see the note at the top.
