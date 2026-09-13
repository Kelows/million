#!/usr/bin/env node
/**
 * Find your first whales from one token.
 *
 * Takes a token mint OR a pool address (any case — DexScreener URLs lowercase
 * pool addresses, and Solana addresses are case-sensitive), pulls the token's
 * size buyers through the deck's Discover endpoint, analyzes the biggest ones,
 * and keeps those whose median hold falls in the range you ask for.
 *
 * Wallets it analyzes are added to the roster UNSUBSCRIBED — following one is
 * still your call. Each analysis costs Helius credits (~10 per page, see
 * ANALYSIS_MAX_PAGES), so --analyze caps how many it looks at; a wallet already
 * analyzed in the last 24h is reused instead.
 *
 *   node tools/find-whales.mjs <token-or-pool> [--min-hold 5] [--max-hold 30]
 *        [--min-sol 1] [--min-closed 5] [--active-hours 24] [--analyze 12] [--mode recent|deep] [--pages 3]
 *        [--api http://localhost:3001/api]
 *
 * recent = the latest buyers; deep = buyers sampled across the token's whole life.
 *
 * Needs the API running (npm start).
 */
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const MIN_HOLD = Number(opt('min-hold', 5));
const MAX_HOLD = Number(opt('max-hold', 30));
const MIN_SOL = Number(opt('min-sol', 1));
const ANALYZE = Number(opt('analyze', 12));
const MIN_CLOSED = Number(opt('min-closed', 5));
const ACTIVE_HOURS = Number(opt('active-hours', 0)); // 0 = any; otherwise the wallet must have traded within this many hours // a whale needs a track record: closed tokens, not one lucky hold
const MODE = opt('mode', 'recent');
const PAGES = Number(opt('pages', 3));
const API = opt('api', 'http://localhost:3001/api');
const QUOTES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
// flags that disqualify a wallet from being a whale worth following
const EXCLUDE = new Set(['BOT_INFRA', 'HIGH_WINRATE_SUS']);

if (!input) {
  console.error('usage: node tools/find-whales.mjs <token-or-pool> [--min-hold 5] [--max-hold 30] [--min-sol 1] [--analyze 12]');
  process.exit(1);
}

const getJson = async (url, init) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

/** Token mint with its real casing, from a mint or pool address in any case. */
async function resolveToken(raw) {
  const direct = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${raw}`).catch(() => null);
  const pair = direct?.pairs?.find((p) => p.chainId === 'solana' && p.baseToken.address === raw);
  if (pair) return { mint: raw, symbol: pair.baseToken.symbol, via: 'token' };
  const search = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${raw}`).catch(() => ({ pairs: [] }));
  const lower = raw.toLowerCase();
  for (const p of search.pairs ?? []) {
    if (p.chainId !== 'solana') continue;
    const sides = [p.baseToken, p.quoteToken];
    const hit = sides.find((t) => t.address.toLowerCase() === lower);
    if (hit && !QUOTES.has(hit.address)) return { mint: hit.address, symbol: hit.symbol, via: 'token (case fixed)' };
    if (p.pairAddress.toLowerCase() === lower) {
      const token = sides.find((t) => !QUOTES.has(t.address)) ?? p.baseToken;
      return { mint: token.address, symbol: token.symbol, via: `pool ${p.pairAddress}` };
    }
  }
  return null;
}

async function main() {
  const token = await resolveToken(input);
  if (!token) {
    console.error(`could not resolve "${input}" to a Solana token or pool on DexScreener`);
    process.exit(1);
  }
  console.log(`token ${token.symbol} ${token.mint}  (from ${token.via})`);
  console.log(`looking for wallets that bought ≥ ${MIN_SOL} ◎ and hold ${MIN_HOLD}–${MAX_HOLD} min (median)\n`);

  const report = await getJson(`${API}/discovery/token/${token.mint}?minSol=${MIN_SOL}&mode=${MODE}&pages=${PAGES}`);
  const candidates = report.candidates
    .filter((c) => !(c.flags ?? []).some((f) => EXCLUDE.has(f)))
    .sort((a, b) => b.boughtSol - a.boughtSol)
    .slice(0, ANALYZE);
  console.log(`${report.candidates.length} size buyers in ${report.scannedTxs} txs (${MODE}); analyzing the top ${candidates.length} by size\n`);
  if (!candidates.length) return;

  const newToRoster = candidates.filter((c) => !c.inRoster);
  if (newToRoster.length) {
    await getJson(`${API}/wallets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallets: newToRoster.map((c) => ({ address: c.address, label: `found via ${token.symbol}`.slice(0, 64) })), source: 'find-whales' }),
    });
  }

  const rows = [];
  for (const c of candidates) {
    // a wallet analyzed in the last day is reused: history doesn't move that fast, credits do
    const known = c.inRoster ? await getJson(`${API}/wallets/${c.address}`).catch(() => null) : null;
    const recent = known?.metrics && known.lastAnalyzedAt && Date.now() - new Date(known.lastAnalyzedAt).getTime() < 24 * 3600e3;
    const rec = recent ? known : await getJson(`${API}/wallets/${c.address}/analyze`, { method: 'POST' }).catch((e) => ({ error: String(e.message ?? e) }));
    const m = rec.metrics;
    if (!m) {
      console.log(`  ${c.address.slice(0, 6)}…  analysis failed: ${(rec.error ?? 'no metrics').slice(0, 80)}`);
      continue;
    }
    const hold = m.medianHoldMinutes;
    const idleHours = m.lastSeen ? (Date.now() - new Date(m.lastSeen).getTime()) / 3600e3 : Infinity;
    const active = !ACTIVE_HOURS || idleHours <= ACTIVE_HOURS;
    const fits = hold !== null && hold >= MIN_HOLD && hold <= MAX_HOLD && m.closedTokens >= MIN_CLOSED && active && !m.flags.some((f) => EXCLUDE.has(f));
    rows.push({ address: c.address, bought: c.boughtSol, hold, winRate: m.winRate, closed: m.closedTokens, flags: m.flags, fits, idleHours, mints: new Set(m.tokens.map((t) => t.mint)) });
    console.log(`  ${c.address.slice(0, 6)}…  bought ${c.boughtSol.toFixed(1).padStart(6)} ◎  median hold ${hold === null ? '   —' : String(Math.round(hold)).padStart(4) + 'm'}  ${fits ? '← fits' : ''}`);
  }

  const picks = rows.filter((r) => r.fits).sort((a, b) => b.closed - a.closed || (b.winRate ?? 0) - (a.winRate ?? 0));
  // Many brand-new wallets piling into one token is what one operator spreading a
  // position looks like, not a crowd of whales. Say so instead of ranking them.
  const fresh = rows.filter((r) => r.flags.includes('FRESH_WALLET')).length;
  if (rows.length >= 5 && fresh / rows.length >= 0.6) {
    console.log(`\n⚠ ${fresh} of ${rows.length} buyers are brand-new wallets with almost no history. That usually means one`);
    console.log('  operator spread across wallets, not independent whales. Try an older token with organic buyers.');
  }
  // Wallets that traded mostly the same tokens are one operator (or one bot's
  // copies), however many addresses it uses. On CATE, four "whales" shared 63 of
  // ~65 tokens and were all created the same day. Group them; follow one at most.
  const clusterOf = new Map();
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i].mints, b = picks[j].mints;
      const shared = [...a].filter((m) => b.has(m)).length;
      if (shared / Math.min(a.size, b.size) >= 0.8) {
        const id = clusterOf.get(picks[i].address) ?? clusterOf.get(picks[j].address) ?? picks[i].address;
        clusterOf.set(picks[i].address, id);
        clusterOf.set(picks[j].address, id);
      }
    }
  }
  const clusters = [...new Set(clusterOf.values())].map((id) => picks.filter((p) => clusterOf.get(p.address) === id));
  for (const group of clusters) {
    console.log(`\n⚠ ${group.length} of these wallets traded mostly the same tokens: one operator, not ${group.length} whales.`);
    console.log(`  ${group.map((g) => g.address.slice(0, 6) + '…').join(', ')}`);
  }
  for (const r of picks) if (clusterOf.has(r.address)) r.flags = [...r.flags, `CLUSTER×${clusters.find((g) => g.includes(r)).length}`];
  picks.sort((a, b) => Number(clusterOf.has(a.address)) - Number(clusterOf.has(b.address))); // independent wallets first

  console.log(`\n${picks.length} of ${rows.length} analyzed wallets hold ${MIN_HOLD}–${MAX_HOLD} min with ≥ ${MIN_CLOSED} closed tokens:\n`);
  for (const r of picks) {
    console.log(`  ${r.address}`);
    console.log(`    last trade ${r.idleHours < 1 ? `${Math.round(r.idleHours * 60)}m` : `${Math.round(r.idleHours)}h`} ago · bought ${r.bought.toFixed(1)} ◎ of ${token.symbol} · median hold ${Math.round(r.hold)}m · win rate ${r.winRate === null ? '—' : Math.round(r.winRate * 100) + '%'} over ${r.closed} closed tokens${r.flags.length ? ` · flags ${r.flags.join(', ')}` : ''}`);
  }
  console.log('\nAll analyzed wallets are in your roster, unsubscribed. Subscribe from a wallet\'s page in the deck.');
  console.log('Win rate here comes from recent history, not a guarantee; busy wallets can flood the live feed.');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
