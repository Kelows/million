#!/usr/bin/env node
// Blank-state bootstrap: find tokens that PUMPED, deep-scan their buyers,
// absorb the quality ones into the roster — the crawler's clean starting state.
//
//   node tools/seed-top-tokens.mjs [--top 8] [--min-pump 50] [--min-score 40]
//                                  [--days 14] [--buckets 36] [--import-only] [--dry]
//
// Pipeline: candidates (GeckoTerminal trending/new/volume + DexScreener boosts)
//   -> enrich via DexScreener (priceChange.h24, liq, mcap)
//   -> filter to meme-sized movers -> rank by 24h pump -> import as tracked
//   -> deep-scan each (whole-life buyers) -> absorb clean buyers >= min score.
// Needs the API running on :3001 (it does the scanning/absorbing).

const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const API = 'http://localhost:3001/api';
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
]);

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const flag = (name) => process.argv.includes('--' + name);
const TOP = arg('top', 8);
const MIN_PUMP = arg('min-pump', 50); // +% over 24h
const MIN_SCORE = arg('min-score', 40);
const DAYS = arg('days', 14);
const BUCKETS = arg('buckets', 36);
const MAX_ABSORB_PER_TOKEN = arg('max-absorb', 10);

const j = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } }).catch(() => null);
  return res?.ok ? res.json() : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. gather candidate mints, broadly ──
const mints = new Set();
for (const path of [
  '/networks/solana/trending_pools?duration=24h&page=1',
  '/networks/solana/trending_pools?duration=24h&page=2',
  '/networks/solana/trending_pools?duration=6h&page=1',
  '/networks/solana/new_pools?page=1',
  '/networks/solana/pools?sort=h24_volume_usd_desc&page=1',
]) {
  const body = await j(`${GT}${path}`);
  for (const p of body?.data ?? []) {
    const mint = (p.relationships?.base_token?.data?.id ?? '').replace('solana_', '');
    if (mint && !EXCLUDE.has(mint)) mints.add(mint);
  }
  await sleep(400);
}
const boosts = await j(`${DS}/token-boosts/top/v1`);
for (const b of Array.isArray(boosts) ? boosts : []) {
  if (b.chainId === 'solana' && b.tokenAddress && !EXCLUDE.has(b.tokenAddress)) mints.add(b.tokenAddress);
}
console.log(`candidates: ${mints.size} mints`);

// ── 2. enrich + filter + rank by 24h pump ──
const movers = [];
for (const mint of mints) {
  const body = await j(`${DS}/latest/dex/tokens/${mint}`);
  const pairs = (body?.pairs ?? []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
  if (!pairs.length) continue;
  const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const liq = best.liquidity?.usd ?? 0;
  const mcap = best.marketCap ?? best.fdv ?? 0;
  const pump = Number(best.priceChange?.h24 ?? 0);
  if (liq < 25_000 || liq > 3_000_000) continue; // tradeable but not a major
  if (mcap < 100_000 || mcap > 50_000_000) continue; // meme-sized
  if (pump < MIN_PUMP) continue; // it must have PUMPED
  movers.push({ mint, symbol: best.baseToken?.symbol ?? '?', pump, liq, mcap, vol: best.volume?.h24 ?? 0 });
  await sleep(250);
}
movers.sort((a, b) => b.pump - a.pump);
const seeds = movers.slice(0, TOP);
console.log(`\n${movers.length} movers >= +${MIN_PUMP}% · seeding top ${seeds.length}:`);
for (const s of seeds) {
  console.log(`  ${s.symbol.padEnd(12)} +${s.pump.toFixed(0)}% · liq $${Math.round(s.liq).toLocaleString()} · mcap $${Math.round(s.mcap).toLocaleString()} · ${s.mint}`);
}
if (flag('dry') || !seeds.length) process.exit(0);

// ── 3. import as tracked tokens ──
const post = (path, body) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => (r.ok ? r.json() : null));
const imp = await post('/tokens/import', { mints: seeds.map((s) => s.mint), source: 'pumped-seed' });
console.log(`\ntokens imported: ${JSON.stringify(imp)}`);
if (flag('import-only')) process.exit(0);

// ── 4. deep-scan each seed, absorb quality buyers ──
const score = (c) => {
  if (!c.preview) return null;
  if ((c.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS')) return -100;
  return Math.round((c.preview.winRate ?? 0) * 100 + Math.max(-50, Math.min(200, c.preview.realizedPnlSol)) / 2);
};
let absorbed = 0;
for (const s of seeds) {
  const res = await fetch(`${API}/discovery/token/${s.mint}?minSol=2&mode=deep&sinceDays=${DAYS}&buckets=${BUCKETS}`).catch(() => null);
  if (!res?.ok) { console.log(`${s.symbol}: scan failed`); continue; }
  const report = await res.json();
  const good = report.candidates
    .filter((c) => !c.inRoster && (score(c) ?? -1) >= MIN_SCORE)
    .slice(0, MAX_ABSORB_PER_TOKEN);
  console.log(`${s.symbol.padEnd(12)} ${report.scannedTxs} txs sampled · ${report.candidates.length} buyers · ${good.length} at score >= ${MIN_SCORE}`);
  for (const c of good) {
    await post('/wallets/import', { wallets: [c.address], source: `seed:${s.symbol}` });
    await post(`/wallets/${c.address}/analyze`).catch(() => null);
    absorbed++;
    console.log(`   + ${c.address.slice(0, 8)} score=${score(c)} WR=${c.preview.winRate} pnl=${c.preview.realizedPnlSol}`);
  }
}
console.log(`\nblank state ready: ${seeds.length} pumped tokens tracked, ${absorbed} quality wallets absorbed. Arm the crawler and let it loop.`);
