# create-million

Set up **[million](https://github.com/Kelows/million)**, the open-source, self-hosted Solana whale tracker and copy-trading deck, in one command:

```sh
npx create-million
```

It clones the repo, installs it on Node 24 (switching with nvm if needed), asks for your free [Helius](https://dashboard.helius.dev) API key without echoing it, checks the key works, and starts the deck at http://localhost:5173.

```sh
npx create-million my-deck      # into ./my-deck
npx create-million --no-start   # set up, don't start
```

Then open the folder in your AI coding agent (Claude Code, Codex, Cursor, Gemini CLI…) and type `set me up`: it configures your rules, wallets and feed by conversation.

**You need:** git, Node 24 or nvm, a free Helius key.
**You don't need:** a webhook, tunnel, domain, wallet or SOL.

Experimental software, provided as is, not financial advice. MIT licensed.
