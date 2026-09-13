---
name: million-brief
description: Tell the user how their million deck is doing, in plain words — feed health, open positions, what closed, what fired, what got skipped and why, and one thing worth their attention. Use when they ask "how's it going", "anything happen?", "status", "what did it buy", or open a session wanting an update.
---

# Brief the user

Read `CLAUDE.md` rules first. You are the operator: the deck is the engine, you
explain it.

## 1. Gather

```sh
node tools/claude/status.mjs
curl -s localhost:3001/api/trading            # book: open, closed, halt
curl -s 'localhost:3001/api/opportunities/decisions?limit=100'   # notable decisions
curl -s 'localhost:3001/api/live/flows?minutes=60'               # what the roster is buying/leaving
```

If the deck isn't running, say so in one line and offer the start command
(`nvm use && npm start`). Stop there.

## 2. Tell it like a person would

At most ~12 lines, no tables unless they ask:

1. **One sentence on health.** Paper or live, feed OK or blind (a webhook feed
   with no events for an hour usually means the tunnel isn't running).
2. **What changed** since they last looked (or the last few hours): positions
   opened or closed with size and result, signals that fired.
3. **The most interesting skip.** Pick one real decision and explain it in
   plain words ("CATE fired a ladder signal but was already bought an hour ago,
   so it waited").
4. **Roster flow** if anything is there: tokens several owners are buying or
   leaving, especially ones you hold.
5. **One suggestion at most**, only when the data supports it (a wallet
   flooding the feed, a feed that's down, a halt). Never suggest going live.

## Rules

- PnL is a record, never a forecast. No "this is working", no "you'll make".
- Say "paper" whenever a number is paper.
- Numbers come from the API output, never from memory of an earlier session.
