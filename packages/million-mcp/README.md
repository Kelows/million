# million-mcp

MCP server for **[million](https://github.com/Kelows/million)**, the open-source, self-hosted Solana whale tracker and copy-trading deck. It lets Claude Desktop, Cursor, Claude Code, VS Code or any MCP client read and operate your deck: status, positions, why a token was or wasn't bought, trading rules, roster order flow, token safety checks and finding wallets worth following.

It's a thin layer over the deck's local API, so the deck has to be running on your machine. No keys pass through it, and no tool can switch paper trading to live.

## 1. Run the deck

```sh
npx create-million
```

That clones, installs and starts million at http://localhost:5173 (you need Node 24 or nvm, and a free Helius API key).

## 2. Add the server to your client

**Claude Code**

```sh
claude mcp add million -- npx -y million-mcp
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and most other clients:

```json
{
  "mcpServers": {
    "million": {
      "command": "npx",
      "args": ["-y", "million-mcp"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "million": { "type": "stdio", "command": "npx", "args": ["-y", "million-mcp"] }
  }
}
```

If the deck's API isn't on `http://localhost:3001/api`, set `MILLION_API` in the server's `env`.

## Tools

| Tool | What it does |
|---|---|
| `get_status` | running or not, paper or live, feed health, followed wallets, book summary |
| `get_book` | open and closed positions with PnL and exit reasons |
| `get_decisions` | the decision log: signals, trades, shadow trades and skips, each with its reason |
| `why_not_bought` | everything to explain one token: its decisions, check report, positions, rules |
| `get_rules` | trading rules in force |
| `update_rules` | change some rule fields, returns before and after (can't enable live trading) |
| `get_flows` | tokens the followed wallets are accumulating or distributing now |
| `get_roster_holdings` | what the followed wallets still hold, and where they took profit |
| `check_token` | safety checks: authorities, liquidity, holders, deployer, sell simulation, RugCheck |
| `find_token_buyers` | a token's biggest buyers with flags (bots, clusters), to find whales to follow |
| `import_wallets` | add wallets to the roster |
| `analyze_wallet` | a wallet's PnL in SOL, win rate, hold times and flags |
| `get_wallet` | a roster wallet's stored analysis and activity |
| `set_wallet_subscription` | follow or unfollow a wallet |

`find_token_buyers` and `analyze_wallet` spend your Helius credits.

## Ask things like

- "How's my deck doing?"
- "Why didn't it buy CATE?"
- "Find whales from this token and add the three most consistent ones."
- "Make it only trade when two different owners agree, 0.2 SOL per trade."

Experimental software, provided as is, not financial advice. MIT licensed.
