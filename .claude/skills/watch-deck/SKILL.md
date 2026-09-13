---
name: watch-deck
description: Watch the million deck live during this conversation and tell the user when something worth knowing happens — a position opened or closed, a signal fired, the feed went down, the risk halt tripped. Use when they say "watch it", "tell me when it buys", "keep an eye on it", or want live updates while they do something else.
---

# Watch the deck

## 1. Check it's running

```sh
node tools/claude/status.mjs --brief
```

If the deck isn't running, say so and stop.

## 2. Start the watcher

Use the **Monitor** tool (persistent) with:

- command: `node tools/claude/watch.mjs`
- description: `million deck: trades, signals, feed health`

It prints one line per notable event and stays silent on routine skips. It
caps itself at 12 lines a minute.

Tell the user in one sentence that you're watching and what will reach them.

## 3. When a line arrives

Relay it in plain words, one or two lines, only adding context that helps:

- `OPENED X · 0.2 ◎ · copy signal` → which wallet and why, from
  `GET /opportunities/decisions?mint=<mint>&quiet=true&limit=5` if useful.
- `CLOSED X · … · trail` → the result and the exit reason in words ("the
  trailing stop locked it in after it came 10% off its high").
- `FEED DOWN` → say trades can't fire, and the likely cause (tunnel or
  websocket), without dumping logs.
- `HALT` → new positions are paused and why; resuming is the user's call
  (`POST /trading/resume`), never yours.

Don't comment on every SIGNAL if many arrive; batch them ("3 signals in the
last minutes, 1 opened").

## 4. Stop

When they say stop, or at the end, stop the monitor (TaskStop).
