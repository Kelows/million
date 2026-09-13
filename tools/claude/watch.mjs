#!/usr/bin/env node
/**
 * The deck, narrated: one short line per thing worth a human's attention.
 * Built for Claude Code's Monitor tool, where every stdout line wakes Claude,
 * so it is deliberately quiet: positions opened and closed, signals, shadow
 * trades, the feed going blind or coming back, the risk halt. Routine skips
 * (thousands a day) never print.
 *
 *   node tools/claude/watch.mjs
 */
const API = process.env.MILLION_API ?? 'http://localhost:3001/api';
const MAX_LINES_PER_MIN = 12; // a busy roster must not flood the conversation

let sent = [];
const say = (line) => {
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= MAX_LINES_PER_MIN) return;
  sent.push(now);
  console.log(line);
};
const get = async (path) => {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// decisions carry no payload on the bus: read the new ones by id
let lastDecisionId = 0;
async function newDecisions({ prime = false } = {}) {
  const rows = await get('/opportunities/decisions?limit=30').catch(() => []);
  const fresh = rows.filter((d) => d.id > lastDecisionId).reverse();
  if (rows[0]) lastDecisionId = Math.max(lastDecisionId, rows[0].id);
  if (prime) return;
  for (const d of fresh) {
    if (d.outcome === 'skip') continue;
    if (d.outcome === 'opened') continue; // the paper_trade event says it with the size
    const tag = d.outcome === 'fired' ? 'SIGNAL' : 'SHADOW';
    say(`${tag} ${d.symbol ?? d.mint?.slice(0, 8)} · ${d.reason}`);
  }
}

let feedWasOk = null;
async function feedHealth() {
  const s = await get('/live/status').catch(() => null);
  const ok = Boolean(s && (s.connected || s.subscribedWallets === 0));
  if (feedWasOk !== null && ok !== feedWasOk) {
    say(ok ? 'FEED back: the deck sees your wallets again' : 'FEED DOWN: no live data, signals cannot fire until it reconnects');
  }
  feedWasOk = ok;
}

let halted = null;
async function haltState() {
  const b = await get('/trading').catch(() => null);
  if (!b) return;
  if (halted !== null && b.halt.halted !== halted) {
    say(b.halt.halted ? `HALT: new positions paused (${b.halt.reason})` : 'RESUMED: new positions allowed again');
  }
  halted = b.halt.halted;
}

function onEvent(e) {
  if (e.type === 'paper_trade' && e.data) {
    const t = e.data;
    const name = t.symbol ?? t.mint?.slice(0, 8);
    const live = t.mode === 'local' ? 'LIVE ' : '';
    if (t.kind === 'open') say(`${live}OPENED ${name} · ${t.sizeSol} ◎ · ${t.signal} signal`);
    if (t.kind === 'closed') say(`${live}CLOSED ${name} · ${t.pnlSol > 0 ? '+' : ''}${t.pnlSol} ◎ (${t.pnlPct > 0 ? '+' : ''}${t.pnlPct}%) · ${t.reason}`);
  }
  if (e.type === 'decision') scheduleDecisions();
}

let decisionTimer = null;
function scheduleDecisions() {
  // decisions arrive in bursts; read them once per burst
  if (decisionTimer) return;
  decisionTimer = setTimeout(() => {
    decisionTimer = null;
    void newDecisions();
  }, 1500);
}

async function stream() {
  const res = await fetch(API + '/live/stream', { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`stream → ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* not JSON: ignore */
        }
      }
    }
  }
  throw new Error('stream ended');
}

async function main() {
  let down = false;
  // prime state so the first poll doesn't announce what was already true
  await newDecisions({ prime: true }).catch(() => undefined);
  setInterval(() => void feedHealth(), 60_000);
  setInterval(() => void haltState(), 60_000);
  void feedHealth();
  void haltState();
  for (;;) {
    try {
      await get('/health');
      if (down) say('DECK back up');
      down = false;
      await stream();
    } catch {
      if (!down) say('DECK not reachable on localhost:3001 (stopped?). Watching for it to come back.');
      down = true;
      await sleep(15_000);
    }
  }
}

main();
