#!/usr/bin/env node
/**
 * One-screen state of the deck, for Claude (and humans): is it up, paper or
 * live, is the feed seeing anything, what is open, what happened lately.
 *
 * Runs as the SessionStart hook, so Claude knows the state before the first
 * message. Never prints secrets and never fails loudly: a deck that isn't
 * running is a normal state, reported in one line.
 *
 *   node tools/claude/status.mjs [--brief]
 */
const API = process.env.MILLION_API ?? 'http://localhost:3001/api';
const brief = process.argv.includes('--brief');

const get = async (path) => {
  const res = await fetch(API + path, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const sol = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 1000) / 1000} ◎`;

async function main() {
  let health;
  try {
    health = await get('/health');
  } catch {
    console.log('million: the deck is not running (nothing on localhost:3001). To start it: `nvm use && mprocs` in a terminal.');
    return;
  }

  const [live, book, decisions] = await Promise.all([
    get('/live/status').catch(() => null),
    get('/trading').catch(() => null),
    get('/opportunities/decisions?limit=40').catch(() => []),
  ]);

  const lines = [];
  const mode = book?.stats?.mode === 'local' ? 'LIVE (real SOL)' : 'paper';
  lines.push(`million: deck running · ${mode} · Helius ${health.heliusConfigured ? 'configured' : 'NOT configured'}`);

  if (live) {
    const quietMin = live.lastEventAt ? (Date.now() - new Date(live.lastEventAt).getTime()) / 60000 : Infinity;
    // a registered webhook reads "connected" even when nothing can reach it
    const blind = live.subscribedWallets > 0 && (!live.connected || (live.ingestion === 'webhook' && quietMin > 60));
    lines.push(
      `feed: ${live.ingestion} · ${live.connected ? 'connected' : 'NOT connected'} · ${live.subscribedWallets} wallets followed · ${live.eventsToday} events today · last ${ago(live.lastEventAt)}` +
        (blind ? ` · ⚠ probably blind: ${live.ingestion === 'webhook' ? 'no events for an hour, is the tunnel running?' : 'signals cannot fire'}` : '') +
        (live.ingestion === 'websocket' && live.subscribedWallets > live.maxSubscriptions ? ` · ⚠ only ${live.maxSubscriptions} watched without a webhook` : ''),
    );
  }

  if (book) {
    const s = book.stats;
    const deployed = (book.open ?? []).reduce((a, p) => a + p.sizeSol, 0);
    lines.push(
      `book: ${s.openCount} open (${Math.round(deployed * 100) / 100} ◎ in) · ${s.closedCount} closed · realized ${sol(s.totalPnlSol)}` +
        (s.closedCount ? ` · ${Math.round(s.winRate * 100)}% wins` : '') +
        (s.walletBalanceSol != null ? ` · wallet ${Math.round(s.walletBalanceSol * 1000) / 1000} ◎` : '') +
        (book.halt?.halted ? ` · ⚠ HALTED: ${book.halt.reason}` : ''),
    );
    if (!brief) {
      for (const p of book.open ?? []) lines.push(`  open ${p.symbol ?? p.mint.slice(0, 6)} ${p.sizeSol} ◎ · ${p.signal ?? 'copy'} · ${ago(p.openedAt)}`);
    }
  }

  const notable = decisions.filter((d) => d.outcome !== 'skip');
  const skips = decisions.filter((d) => d.outcome === 'skip');
  lines.push(`last ${decisions.length} decisions: ${notable.length} signals/trades, ${skips.length} skips` + (decisions[0] ? ` · newest ${ago(decisions[0].ts)}` : ''));
  if (!brief) {
    for (const d of decisions.slice(0, 8)) {
      lines.push(`  ${ago(d.ts)} ${d.outcome.toUpperCase()} ${d.symbol ?? d.mint?.slice(0, 6) ?? ''}: ${d.reason}`);
    }
  }

  if (brief) lines.push('Skills: /million-brief (how is it going), /why-not-bought <token>, /tune-rules, /watch-deck, /setup-million, /find-first-whales <token>.');
  console.log(lines.join('\n'));
}

main().catch((e) => console.log(`million: status unavailable (${e.message})`));
