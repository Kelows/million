#!/usr/bin/env node
/**
 * Find infrastructure masquerading as whales.
 *
 * A real trader is a top buyer on a handful of tokens. A pool, router or
 * distribution service is a top buyer on EVERY token it touches — that
 * cross-token degree is the tell, and it needs no labels or allowlists.
 *
 *   node tools/find-infra.mjs [tokenCount] [minTokens]
 */
import fs from 'node:fs';

const API = process.env.API ?? 'http://localhost:3001/api';
const TOKENS = Number(process.argv[2] ?? 8);
const MIN_TOKENS = Number(process.argv[3] ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tracked = await (await fetch(`${API}/tokens`)).json();
const sample = tracked
  .filter((t) => t.liquidityUsd && t.liquidityUsd > 20_000)
  .sort(() => Math.random() - 0.5)
  .slice(0, TOKENS);

console.log(`sampling ${sample.length} unrelated tokens…\n`);
const seen = new Map(); // address -> { tokens:Set, sol:number }

for (const t of sample) {
  const res = await fetch(`${API}/discovery/token/${t.mint}?minSol=0.5&mode=recent&pages=2`).catch(() => null);
  if (!res?.ok) continue;
  const { candidates = [] } = await res.json();
  for (const c of candidates) {
    const e = seen.get(c.address) ?? { tokens: new Set(), sol: 0 };
    e.tokens.add(t.symbol ?? t.mint.slice(0, 6));
    e.sol += c.boughtSol;
    seen.set(c.address, e);
  }
  console.log(`  ${(t.symbol ?? t.mint.slice(0, 8)).padEnd(12)} ${candidates.length} candidates`);
  await sleep(400);
}

const suspects = [...seen.entries()]
  .filter(([, e]) => e.tokens.size >= MIN_TOKENS)
  .sort((a, b) => b[1].tokens.size - a[1].tokens.size);

console.log(`\naddresses appearing on ${MIN_TOKENS}+ unrelated tokens — infrastructure unless proven otherwise:\n`);
for (const [addr, e] of suspects) {
  console.log(`  ${addr}  ${e.tokens.size}/${sample.length} tokens  ${e.sol.toFixed(0)}◎  [${[...e.tokens].join(', ')}]`);
}
if (!suspects.length) console.log('  (none — the sample is clean)');
else {
  fs.writeFileSync('/tmp/infra-suspects.json', JSON.stringify(suspects.map(([a]) => a), null, 1));
  console.log(`\n${suspects.length} written to /tmp/infra-suspects.json — review, then add to INFRA_ADDRESSES.`);
}
