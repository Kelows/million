#!/usr/bin/env node
// Blank-slate seeding: pull Solana's trending + top-volume pools (GeckoTerminal,
// free API), filter to recent meme-sized tokens, import them as tracked tokens.
//   node tools/seed-top-tokens.mjs [--days 45] [--min-fdv 75000] [--max-fdv 1000000000] [--dry]

const GT = 'https://api.geckoterminal.com/api/v2';
const API = 'http://localhost:3001/api';
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
]);

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const DAYS = arg('days', 45);
const MIN_FDV = arg('min-fdv', 75_000);
const MAX_FDV = arg('max-fdv', 1_000_000_000);
const DRY = process.argv.includes('--dry');

async function gt(path) {
  const res = await fetch(`${GT}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

const pools = [];
for (const path of [
  '/networks/solana/trending_pools?duration=24h&page=1',
  '/networks/solana/trending_pools?duration=24h&page=2',
  '/networks/solana/pools?sort=h24_volume_usd_desc&page=1',
  '/networks/solana/pools?sort=h24_volume_usd_desc&page=2',
  '/networks/solana/new_pools?page=1',
]) {
  const body = await gt(path);
  if (body?.data) pools.push(...body.data);
  await new Promise((r) => setTimeout(r, 500)); // free-tier politeness
}
console.log(`fetched ${pools.length} pool rows`);

const now = Date.now();
const byMint = new Map();
for (const p of pools) {
  const a = p.attributes ?? {};
  const mint = (p.relationships?.base_token?.data?.id ?? '').replace('solana_', '');
  if (!mint || EXCLUDE.has(mint) || byMint.has(mint)) continue;
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : null;
  const ageDays = created ? (now - created) / 86_400_000 : null;
  const fdv = Number(a.fdv_usd ?? 0);
  const vol = Number(a.volume_usd?.h24 ?? 0);
  const liq = Number(a.reserve_in_usd ?? 0);
  if (ageDays !== null && ageDays > DAYS) continue; // "lately" only
  if (fdv < MIN_FDV || fdv > MAX_FDV) continue; // meme-sized, not majors
  if (liq < 20_000) continue; // tradeable at all
  byMint.set(mint, { mint, symbol: a.name?.split(' / ')[0] ?? '?', fdv, vol, liq, ageDays });
}

const seeds = [...byMint.values()].sort((a, b) => b.vol - a.vol);
console.log(`\n${seeds.length} seed tokens (age <= ${DAYS}d, fdv ${MIN_FDV}-${MAX_FDV}, liq >= 20k):`);
for (const s of seeds) {
  console.log(`  ${s.symbol.padEnd(12)} ${s.mint} vol24h $${Math.round(s.vol).toLocaleString()} liq $${Math.round(s.liq).toLocaleString()} fdv $${Math.round(s.fdv).toLocaleString()} age ${s.ageDays?.toFixed(1) ?? '?'}d`);
}

if (!DRY && seeds.length) {
  const res = await fetch(`${API}/tokens/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mints: seeds.map((s) => s.mint), source: 'market-top' }),
  });
  console.log('\nimport:', await res.text());
}
