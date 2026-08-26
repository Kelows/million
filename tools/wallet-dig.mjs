#!/usr/bin/env node
// Wallet digger: profile, genesis and flow analysis for any Solana wallet.
//
//   node tools/wallet-dig.mjs <address> [command] [options]
//
// Commands:
//   profile   quote-aware trading ledger (default)
//   genesis   paginate to the oldest txs, show them + all external inflows
//   raw       dump the N oldest (or newest) txs in short form
// Options:
//   --pages N      max pages of 100 txs to fetch (default 30)
//   --type T       helius tx type filter (SWAP, TRANSFER, ...; default: all)
//   --exclude A,B  addresses to ignore in flow summaries (known relays)
//   --min X        min SOL / USD amount for flow rows (default 0.5)
//   --newest       for raw: newest instead of oldest
//   --no-cache     bypass the scratchpad cache
// Env: HELIUS_API_KEY (falls back to apps/api/.env)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.DIG_CACHE ?? '/tmp/wallet-dig-cache';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const L = 1e9;

function apiKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const env = readFileSync(join(ROOT, 'apps/api/.env'), 'utf8');
  return env.match(/HELIUS_API_KEY="?([^"\n]+)"?/)?.[1];
}

const args = process.argv.slice(2);
const ADDR = args[0];
if (!ADDR || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ADDR)) {
  console.error('usage: node tools/wallet-dig.mjs <address> [profile|genesis|raw] [--pages N] [--type T] [--exclude A,B] [--min X] [--newest] [--no-cache]');
  process.exit(1);
}
const cmd = args[1] && !args[1].startsWith('--') ? args[1] : 'profile';
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes('--' + name);
const PAGES = Number(opt('pages', 30));
const TYPE = opt('type', '');
const EXCLUDE = new Set((opt('exclude', '') || '').split(',').filter(Boolean));
const MIN = Number(opt('min', 0.5));
const KEY = apiKey();

async function fetchAll(type, maxPages) {
  const cacheFile = join(CACHE_DIR, `${ADDR}.${type || 'all'}.${maxPages}.json`);
  if (!flag('no-cache') && existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    console.log(`(cache: ${cached.length} txs from ${cacheFile})`);
    return cached;
  }
  const txs = [];
  let before;
  for (let i = 0; i < maxPages; i++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${ADDR}/transactions`);
    url.searchParams.set('api-key', KEY);
    url.searchParams.set('limit', '100');
    if (type) url.searchParams.set('type', type);
    if (before) url.searchParams.set('before', before);
    const res = await fetch(url);
    if (res.status === 429) {
      process.stderr.write('.');
      await new Promise((r) => setTimeout(r, 3000));
      i--;
      continue;
    }
    if (!res.ok) {
      console.error(`\nhelius ${res.status} on page ${i}`);
      break;
    }
    const batch = await res.json();
    txs.push(...batch);
    process.stderr.write(`\rpage ${i + 1}: ${txs.length} txs`);
    if (batch.length < 100) break;
    before = batch[batch.length - 1].signature;
  }
  process.stderr.write('\n');
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(txs));
  return txs;
}

const short = (a) => (a ? a.slice(0, 8) : '-');
const iso = (ts) => new Date(ts * 1000).toISOString();

function deltas(tx) {
  let sol = 0, usd = 0;
  const tok = new Map();
  const ad = (tx.accountData ?? []).find((a) => a.account === ADDR);
  if (ad) sol += ad.nativeBalanceChange / L;
  for (const t of tx.tokenTransfers ?? []) {
    const d = (t.toUserAccount === ADDR ? t.tokenAmount : 0) - (t.fromUserAccount === ADDR ? t.tokenAmount : 0);
    if (!d) continue;
    if (t.mint === WSOL) sol += d;
    else if (t.mint === USDC || t.mint === USDT) usd += d;
    else tok.set(t.mint, (tok.get(t.mint) ?? 0) + d);
  }
  return { sol, usd, tok };
}

function externalFlows(txs) {
  const flows = new Map();
  const add = (dir, unit, who, amt) => {
    if (EXCLUDE.has(who)) return;
    const k = `${dir}_${unit} ${who}`;
    flows.set(k, (flows.get(k) ?? 0) + amt);
  };
  for (const tx of txs) {
    for (const t of tx.nativeTransfers ?? []) {
      const sol = t.amount / L;
      if (sol < MIN) continue;
      if (t.fromUserAccount === ADDR && t.toUserAccount) add('OUT', 'SOL', t.toUserAccount, sol);
      else if (t.toUserAccount === ADDR && t.fromUserAccount) add('IN ', 'SOL', t.fromUserAccount, sol);
    }
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== USDC && t.mint !== USDT) continue;
      if (t.tokenAmount < MIN * 100) continue;
      if (t.fromUserAccount === ADDR && t.toUserAccount) add('OUT', 'USD', t.toUserAccount, t.tokenAmount);
      else if (t.toUserAccount === ADDR && t.fromUserAccount) add('IN ', 'USD', t.fromUserAccount, t.tokenAmount);
    }
  }
  return [...flows.entries()].sort((a, b) => b[1] - a[1]);
}

const txs = await fetchAll(TYPE, PAGES);
console.log(`\n#### ${ADDR} · ${txs.length} txs`);
if (!txs.length) process.exit(0);
const sorted = [...txs].sort((a, b) => a.timestamp - b.timestamp);
console.log(`span: ${iso(sorted[0].timestamp)} -> ${iso(sorted.at(-1).timestamp)}`);

if (cmd === 'raw') {
  const n = Number(opt('n', 10));
  const list = flag('newest') ? sorted.slice(-n) : sorted.slice(0, n);
  for (const tx of list) {
    console.log(`\n${iso(tx.timestamp)} ${tx.type}/${tx.source} feePayer=${short(tx.feePayer)} ${tx.description?.slice(0, 120) ?? ''}`);
    for (const t of (tx.nativeTransfers ?? []).slice(0, 6)) if (t.amount / L >= 0.001) console.log(`  SOL ${short(t.fromUserAccount)} -> ${short(t.toUserAccount)}: ${(t.amount / L).toFixed(3)}`);
    for (const t of (tx.tokenTransfers ?? []).slice(0, 6)) if (t.tokenAmount >= 0.01) console.log(`  TOK ${short(t.mint)} ${short(t.fromUserAccount)} -> ${short(t.toUserAccount)}: ${t.tokenAmount.toFixed(2)}`);
  }
} else if (cmd === 'genesis') {
  console.log('\n== OLDEST 8 TXS ==');
  for (const tx of sorted.slice(0, 8)) {
    console.log(`${iso(tx.timestamp)} ${tx.type}/${tx.source} feePayer=${short(tx.feePayer)} ${tx.description?.slice(0, 110) ?? ''}`);
  }
  console.log('\n== EXTERNAL FLOWS ==');
  for (const [k, v] of externalFlows(txs).slice(0, 20)) console.log(`  ${k}: ${v.toFixed(1)}`);
} else {
  // profile
  const pos = new Map();
  const srcs = {};
  for (const tx of sorted) {
    if (tx.type !== 'SWAP' && !(tx.tokenTransfers?.length && tx.type === 'TRANSFER')) srcs[tx.type] = (srcs[tx.type] ?? 0) + 1;
    if (tx.type === 'SWAP') srcs[tx.source] = (srcs[tx.source] ?? 0) + 1;
    const { sol, usd, tok } = deltas(tx);
    for (const [mint, d] of tok) {
      let p = pos.get(mint);
      if (!p) { p = { mint, qty: 0, cU: 0, cS: 0, buys: [], sells: [], rU: 0, rS: 0 }; pos.set(mint, p); }
      if (d > 0 && (usd < -0.5 || sol < -0.005)) {
        p.buys.push({ t: tx.timestamp, usd: -Math.min(usd, 0), sol: -Math.min(sol, 0) });
        p.qty += d; p.cU += -Math.min(usd, 0); p.cS += -Math.min(sol, 0);
      } else if (d < 0 && (usd > 0.5 || sol > 0.005)) {
        const gu = Math.max(usd, 0), gs = Math.max(sol, 0), sold = -d;
        p.sells.push({ t: tx.timestamp, usd: gu, sol: gs });
        if (p.qty > 0) {
          const fr = Math.min(sold, p.qty) / p.qty;
          p.rU += gu - p.cU * fr; p.rS += gs - p.cS * fr;
          p.cU *= 1 - fr; p.cS *= 1 - fr; p.qty = Math.max(0, p.qty - sold);
        } else { p.rU += gu; p.rS += gs; }
      }
    }
  }
  const SOLP = 200; // rough, for combining
  const tokens = [...pos.values()].filter((p) => p.buys.length + p.sells.length > 0);
  const closed = tokens.filter((p) => p.buys.length && p.sells.length);
  const wins = closed.filter((p) => p.rU + p.rS * SOLP > 0);
  const rU = tokens.reduce((s, p) => s + p.rU, 0);
  const rS = tokens.reduce((s, p) => s + p.rS, 0);
  const holds = closed.map((p) => (p.sells[0].t - p.buys[0].t) / 60).sort((a, b) => a - b);
  const qn = (a, f) => (a.length ? a[Math.floor(a.length * f)] : null);
  console.log(`tokens ${tokens.length} closed ${closed.length} winrate ${closed.length ? Math.round((wins.length / closed.length) * 100) + '%' : '-'}`);
  console.log(`realized: ${rU.toFixed(0)} USD + ${rS.toFixed(2)} SOL (~$${(rU + rS * SOLP).toFixed(0)} at SOL=$${SOLP})`);
  console.log(`hold->first sell (min): p25=${qn(holds, 0.25)?.toFixed(1)} med=${qn(holds, 0.5)?.toFixed(1)} p75=${qn(holds, 0.75)?.toFixed(1)}`);
  console.log(`tx mix: ${JSON.stringify(srcs)}`);
  const byPnl = [...tokens].sort((a, b) => b.rU + b.rS * SOLP - (a.rU + a.rS * SOLP));
  console.log('winners:');
  for (const p of byPnl.slice(0, 6)) console.log(`  ${p.mint} +${p.rU.toFixed(0)}USD/${p.rS.toFixed(2)}SOL buys=${p.buys.length} sells=${p.sells.length} first=${p.buys[0] ? iso(p.buys[0].t) : '-'}`);
  console.log('losers:');
  for (const p of [...byPnl].reverse().slice(0, 4)) console.log(`  ${p.mint} ${p.rU.toFixed(0)}USD/${p.rS.toFixed(2)}SOL buys=${p.buys.length} sells=${p.sells.length}`);
  console.log('\nexternal flows:');
  for (const [k, v] of externalFlows(txs).slice(0, 14)) console.log(`  ${k}: ${v.toFixed(1)}`);
}
