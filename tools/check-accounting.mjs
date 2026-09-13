#!/usr/bin/env node
/**
 * Accounting checks: every SOL number the deck shows rests on two pieces of
 * arithmetic, and both have been wrong before.
 *
 *  1. txDeltas — how much SOL a transaction moved for a wallet. It once added
 *     wrapped-SOL transfers on top of the native balance change and doubled
 *     every trade routed through WSOL (26 of 36 real swaps, 11 routers).
 *  2. the average-cost ledger — live (ledgerStep) and analysis (computeMetrics).
 *     A transfer out once booked a -100% round trip; in analysis it left the
 *     bag "still held" at full cost.
 *
 * Worked examples with hand-computed answers run always. With --chain, a sample
 * of real swaps from subscribed wallets is also checked against the validator's
 * own pre/post balances (needs HELIUS_API_KEY and a populated DB).
 *
 *   node tools/check-accounting.mjs [--chain]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'million-accounting-'));
execFileSync(
  'npx',
  ['tsc', 'apps/api/src/analysis/ledger.ts', 'apps/api/src/analysis/metrics.ts', '--outDir', out, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck', '--moduleResolution', 'node'],
  { cwd: ROOT, stdio: 'inherit' },
);
const require = createRequire(import.meta.url);
const { ledgerStep, isRotation, rotationSteps } = require(path.join(out, 'ledger.js'));
const { txDeltas, computeMetrics } = require(path.join(out, 'metrics.js'));

let failed = 0;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const W = 'Wallet1111111111111111111111111111111111111';
const POOL = 'Pool11111111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111';
const TOK = 'Tok1111111111111111111111111111111111111111';
const TOK2 = 'Tok2222222222222222222222222222222222222222';
const WSOL = 'So11111111111111111111111111111111111111112';

// ── 1. SOL moved per transaction ────────────────────────────────────────────
console.log('\ntxDeltas — SOL moved');
{
  // router wraps nothing on the way in, unwraps 0.8 SOL on the way out; fee 5000 lamports
  const wrappedSell = {
    signature: 's1', timestamp: 1, type: 'SWAP', source: 'JUPITER', feePayer: W,
    tokenTransfers: [
      { fromUserAccount: W, toUserAccount: POOL, mint: TOK, tokenAmount: 500 },
      { fromUserAccount: POOL, toUserAccount: W, mint: WSOL, tokenAmount: 0.8 },
    ],
    nativeTransfers: [],
    accountData: [{ account: W, nativeBalanceChange: 800_000_000 - 5_000, tokenBalanceChanges: [] }],
  };
  const d = txDeltas(W, wrappedSell);
  check('wrapped sell counts the unwrapped SOL once (0.799995, not 1.6)', near(d.sol, 0.799995), `got ${d.sol}`);
  check('wrapped sell token delta is -500', d.tokens.get(TOK) === -500, `got ${d.tokens.get(TOK)}`);

  // buy paid from a WSOL balance the wallet already held: native only pays the fee
  const wsolBalanceBuy = {
    signature: 's2', timestamp: 2, type: 'SWAP', source: 'OKX_DEX_ROUTER', feePayer: W,
    tokenTransfers: [
      { fromUserAccount: W, toUserAccount: POOL, mint: WSOL, tokenAmount: 1 },
      { fromUserAccount: POOL, toUserAccount: W, mint: TOK, tokenAmount: 1000 },
    ],
    nativeTransfers: [],
    accountData: [
      { account: W, nativeBalanceChange: -5_000, tokenBalanceChanges: [] },
      { account: 'WsolAta', nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: W, mint: WSOL, rawTokenAmount: { tokenAmount: '-1000000000', decimals: 9 } }] },
    ],
  };
  check('buy from held WSOL counts the WSOL spent (-1.000005)', near(txDeltas(W, wsolBalanceBuy).sol, -1.000005), `got ${txDeltas(W, wsolBalanceBuy).sol}`);

  // native-SOL bonding-curve buy, no WSOL anywhere
  const nativeBuy = {
    signature: 's3', timestamp: 3, type: 'SWAP', source: 'PUMP_FUN', feePayer: W,
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: W, mint: TOK, tokenAmount: 1000 }],
    nativeTransfers: [{ fromUserAccount: W, toUserAccount: POOL, amount: 1_000_000_000 }],
    accountData: [{ account: W, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [] }],
  };
  check('native buy is the balance change (-1.000005)', near(txDeltas(W, nativeBuy).sol, -1.000005), `got ${txDeltas(W, nativeBuy).sol}`);
}

// ── 2. live ledger ──────────────────────────────────────────────────────────
console.log('\nledgerStep — average-cost ledger, hand-computed');
{
  let pos = null;
  const apply = (step) => {
    if (step.action.op === 'upsert' || step.action.op === 'update') pos = { qty: step.action.qty, costSol: step.action.costSol };
    if (step.action.op === 'delete') pos = null;
    return step;
  };
  let s = apply(ledgerStep(pos, 1000, -1.0, 0, 150, 'SWAP'));
  check('buy 1000 for 1.0 opens qty 1000, cost 1.0', pos?.qty === 1000 && near(pos.costSol, 1.0) && s.realizedSol === null);
  s = apply(ledgerStep(pos, 1000, -3.0, 0, 150, 'SWAP'));
  check('buy 1000 more for 3.0 averages to qty 2000, cost 4.0', pos?.qty === 2000 && near(pos.costSol, 4.0) && s.realizedSol === null);
  s = apply(ledgerStep(pos, -500, 1.5, 0, 150, 'SWAP'));
  check('sell 500 for 1.5 retires 1.0 of cost, realizes +0.5', pos?.qty === 1500 && near(pos.costSol, 3.0) && near(s.realizedSol, 0.5), JSON.stringify({ pos, s }));
  s = apply(ledgerStep(pos, -500, 0, 0, 150, 'TRANSFER'));
  check('transfer 500 out retires 1.0 of cost, books NO round trip', pos?.qty === 1000 && near(pos.costSol, 2.0) && s.realizedSol === null, JSON.stringify({ pos, s }));
  s = apply(ledgerStep(pos, -1000, 0.1, 0, 150, 'SWAP'));
  check('sell the rest for 0.1 closes it, realizes -1.9', pos === null && s.closed && near(s.realizedSol, -1.9), JSON.stringify({ pos, s }));
  // conservation: 4.0 spent = 1.0 + 2.0 retired by sales + 1.0 retired by the transfer;
  // realized = proceeds 1.6 - cost of what was SOLD 3.0 = -1.4
  check('realized total equals proceeds minus cost of what was sold (-1.4)', near(0.5 + -1.9, 1.6 - 3.0));

  check('a "buy" spending under 0.01 SOL is ignored', ledgerStep(null, 1000, -0.005, 0, 150, 'SWAP').action.op === 'none');
  check('selling an unknown position does nothing', ledgerStep(null, -10, 1, 0, 150, 'SWAP').action.op === 'none');
  const rug = ledgerStep({ qty: 1000, costSol: 2 }, -1000, 0.0001, 0, 150, 'SWAP');
  check('a SWAP for dust is a real loss (-1.9999), not a transfer', rug.closed && near(rug.realizedSol, 0.0001 - 2), JSON.stringify(rug));
  const paidTransfer = ledgerStep({ qty: 1000, costSol: 2 }, -500, 1.2, 0, 150, 'TRANSFER');
  check('tokens out WITH proceeds are a sale whatever the type (+0.2)', near(paidTransfer.realizedSol, 0.2), JSON.stringify(paidTransfer));
  const usdc = ledgerStep({ qty: 1000, costSol: 2 }, -500, 0, 225, 150, 'SWAP');
  check('USDC proceeds convert at the SOL price (225 USD = 1.5 SOL, +0.5)', near(usdc.realizedSol, 0.5), JSON.stringify(usdc));
  const over = ledgerStep({ qty: 1000, costSol: 2 }, -5000, 3, 0, 150, 'SWAP');
  check('selling more than held caps at the position (closes, +1.0)', over.closed && near(over.realizedSol, 1.0), JSON.stringify(over));
  const dust = ledgerStep({ qty: 1000, costSol: 2 }, -985, 1, 0, 150, 'SWAP');
  check('leaving <= 2% of the bag closes it', dust.closed && dust.action.op === 'delete', JSON.stringify(dust));
}

// ── 3. analysis ledger ──────────────────────────────────────────────────────
console.log('\ncomputeMetrics — analysis replay, hand-computed');
{
  const tx = (ts, type, sol, tokenTransfers) => ({
    signature: `m${ts}`, timestamp: ts, type, source: 'TEST', feePayer: W, tokenTransfers, nativeTransfers: [],
    accountData: [{ account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] }],
  });
  const txs = [
    tx(1, 'SWAP', -1.0, [{ fromUserAccount: POOL, toUserAccount: W, mint: TOK, tokenAmount: 1000 }]),
    tx(2, 'SWAP', 0.8, [{ fromUserAccount: W, toUserAccount: POOL, mint: TOK, tokenAmount: 500 }]),
    tx(3, 'TRANSFER', 0, [{ fromUserAccount: W, toUserAccount: OTHER, mint: TOK, tokenAmount: 250 }]),
    tx(4, 'SWAP', 0.1, [{ fromUserAccount: W, toUserAccount: POOL, mint: TOK, tokenAmount: 250 }]),
    tx(5, 'SWAP', 0.5, [{ fromUserAccount: W, toUserAccount: POOL, mint: TOK2, tokenAmount: 200 }]),
  ];
  const m = computeMetrics(W, txs, false, 150);
  const t = m.tokens.find((x) => x.mint === TOK);
  // 0.8 - 0.5 = +0.3 · transfer retires 0.25, no PnL · 0.1 - 0.25 = -0.15 · total +0.15
  check('realized = (0.8 - 0.5) + (0.1 - 0.25) = +0.15', near(t?.realizedPnlSol ?? NaN, 0.15, 1e-3), `got ${t?.realizedPnlSol}`);
  check('the transfer leaves nothing "still held": entrySol 0, closed', t?.entrySol === 0 && t?.open === false, JSON.stringify(t));
  const t2 = m.tokens.find((x) => x.mint === TOK2);
  check('selling tokens never seen bought realizes nothing (unbacked)', t2?.realizedPnlSol === 0, JSON.stringify(t2));
}

// ── 3b. stablecoin legs, converted at the SOL price of each trade ───────────
console.log('\ncomputeMetrics — USDC legs in SOL at trade-time price');
{
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const TOK3 = 'Tok3333333333333333333333333333333333333333';
  const TOK4 = 'Tok4444444444444444444444444444444444444444';
  const H = 3600;
  const priceAt = (ts) => (ts < 2 * H ? 100 : ts < 3 * H ? 125 : 150); // SOL: $100, then $125, then $150
  const tx = (ts, type, sol, tokenTransfers) => ({
    signature: `u${ts}`, timestamp: ts, type, source: 'TEST', feePayer: W, tokenTransfers, nativeTransfers: [],
    accountData: [{ account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] }],
  });
  const txs = [
    // buy 1000 for $1,000 at SOL $100 → 10 SOL of cost
    tx(1 * H, 'SWAP', 0, [{ fromUserAccount: W, toUserAccount: POOL, mint: USDC, tokenAmount: 1000 }, { fromUserAccount: POOL, toUserAccount: W, mint: TOK3, tokenAmount: 1000 }]),
    // sell 500 for $750 at SOL $125 → 6 SOL in, 5 SOL of cost retired → +1
    tx(2 * H, 'SWAP', 0, [{ fromUserAccount: W, toUserAccount: POOL, mint: TOK3, tokenAmount: 500 }, { fromUserAccount: POOL, toUserAccount: W, mint: USDC, tokenAmount: 750 }]),
    // sell the other 500 for 3 native SOL at SOL $150 → 3 SOL in, 5 retired → -2
    tx(3 * H, 'SWAP', 3, [{ fromUserAccount: W, toUserAccount: POOL, mint: TOK3, tokenAmount: 500 }]),
    // the EMBER pattern: buy with $2,500 at SOL $150, then send every token to another wallet
    tx(3 * H + 60, 'SWAP', 0, [{ fromUserAccount: W, toUserAccount: POOL, mint: USDC, tokenAmount: 2500 }, { fromUserAccount: POOL, toUserAccount: W, mint: TOK4, tokenAmount: 9000 }]),
    tx(3 * H + 120, 'TRANSFER', 0, [{ fromUserAccount: W, toUserAccount: OTHER, mint: TOK4, tokenAmount: 9000 }]),
  ];
  const m = computeMetrics(W, txs, false, priceAt);
  const t = m.tokens.find((x) => x.mint === TOK3);
  check('SOL in = $1,000 / 100 = 10', near(t?.solIn ?? NaN, 10, 1e-3), JSON.stringify(t));
  check('SOL out = $750 / 125 + 3 = 9', near(t?.solOut ?? NaN, 9, 1e-3), JSON.stringify(t));
  check('the raw dollar legs are kept for display ($1,000 in, $750 out)', t?.usdIn === 1000 && t?.usdOut === 750, JSON.stringify(t));
  // +$200 in dollars, but -1 SOL: SOL rose 50% while the money sat in the token
  check('realized = (6 - 5) + (3 - 5) = -1 SOL, in one unit', near(t?.realizedPnlSol ?? NaN, -1, 1e-3), `got ${t?.realizedPnlSol}`);
  check('no separate dollar PnL is left to add on top', t?.realizedPnlUsd === undefined && m.realizedPnlUsd === undefined, JSON.stringify({ t: t?.realizedPnlUsd, m: m.realizedPnlUsd }));
  const t4 = m.tokens.find((x) => x.mint === TOK4);
  check('stable-paid buy shows its SOL size ($2,500 / 150 = 16.667)', near(t4?.solIn ?? NaN, 16.667, 1e-3), JSON.stringify(t4));
  check('...and sending the bag away leaves nothing held, no PnL', t4?.entrySol === 0 && t4?.open === false && t4?.realizedPnlSol === 0, JSON.stringify(t4));
  check('wallet total matches the tokens (-1)', near(m.realizedPnlSol, -1, 1e-3) && m.realizedPnlTotalSol === m.realizedPnlSol && m.solEquivalent === true, JSON.stringify({ r: m.realizedPnlSol, t: m.realizedPnlTotalSol }));

  // rows analyzed before the switch: the shared readers fold the dollar legs in once
  const shared = require(path.join(ROOT, 'packages/shared/dist/index.js'));
  const legacyM = { solPriceUsd: 200, tokens: [] };
  const legacyT = { solIn: 0.008, usdIn: 17502, solOut: 0, usdOut: 0, realizedPnlSol: 1, realizedPnlUsd: 400 };
  check('old row: SOL in = 0.008 + $17,502 / 200 = 87.518', near(shared.tokenSolIn(legacyT, legacyM), 87.518, 1e-6), `got ${shared.tokenSolIn(legacyT, legacyM)}`);
  check('old row: realized = 1 + $400 / 200 = 3', near(shared.tokenRealizedSol(legacyT, legacyM), 3, 1e-9));
  check('new row: readers add nothing (no double count)', near(shared.tokenSolIn(t, m), t.solIn) && near(shared.tokenRealizedSol(t, m), t.realizedPnlSol));
}

// ── 3c. token-for-token swaps ───────────────────────────────────────────────
console.log('\ntoken-for-token swaps — the basis moves, nothing is realized');
{
  const A = 'TokA111111111111111111111111111111111111111';
  const B = 'TokB111111111111111111111111111111111111111';
  const C = 'TokC111111111111111111111111111111111111111';
  const D = 'TokD111111111111111111111111111111111111111';
  check('tokens out + tokens in + 0.006 SOL rent refund is a rotation', isRotation(new Map([[A, -1000], [B, 50]]), 0.006, 0, 100));
  check('...but not with a real 0.5 SOL leg', !isRotation(new Map([[A, -1000], [B, 50]]), 0.5, 0, 100));
  check('...and not a plain sell', !isRotation(new Map([[A, -1000]]), 0.006, 0, 100));

  const live = rotationSteps(new Map([[A, { qty: 1000, costSol: 2 }], [B, null]]), new Map([[A, -500], [B, 300]]));
  const la = live.get(A);
  const lb = live.get(B);
  check('live: half of A out retires 1.0 of its 2.0 cost', la?.op === 'update' && la.qty === 500 && near(la.costSol, 1), JSON.stringify(la));
  check('live: B comes in carrying that 1.0', lb?.op === 'upsert' && lb.qty === 300 && near(lb.costSol, 1), JSON.stringify(lb));
  const unknown = rotationSteps(new Map([[C, null], [D, null]]), new Map([[C, -10], [D, 10]]));
  check('live: swapping a token never seen bought carries nothing', unknown.get(D)?.op === 'none', JSON.stringify([...unknown]));

  const tx = (ts, type, sol, tokenTransfers) => ({
    signature: `r${ts}`, timestamp: ts, type, source: 'TEST', feePayer: W, tokenTransfers, nativeTransfers: [],
    accountData: [{ account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] }],
  });
  const txs = [
    tx(1, 'SWAP', -2.0, [{ fromUserAccount: POOL, toUserAccount: W, mint: A, tokenAmount: 1000 }]), // buy A for 2
    tx(2, 'SWAP', 0.006, [{ fromUserAccount: W, toUserAccount: POOL, mint: A, tokenAmount: 1000 }, { fromUserAccount: POOL, toUserAccount: W, mint: B, tokenAmount: 40 }]), // A → B
    tx(3, 'SWAP', 3.0, [{ fromUserAccount: W, toUserAccount: POOL, mint: B, tokenAmount: 40 }]), // sell B for 3
    tx(4, 'SWAP', 0.007, [{ fromUserAccount: W, toUserAccount: POOL, mint: C, tokenAmount: 10 }, { fromUserAccount: POOL, toUserAccount: W, mint: D, tokenAmount: 10 }]), // C (never bought) → D
    tx(5, 'SWAP', 1.0, [{ fromUserAccount: W, toUserAccount: POOL, mint: D, tokenAmount: 10 }]), // sell D for 1
  ];
  const m = computeMetrics(W, txs, false, 100);
  const ta = m.tokens.find((x) => x.mint === A);
  const tb = m.tokens.find((x) => x.mint === B);
  const td = m.tokens.find((x) => x.mint === D);
  check('analysis: A realizes nothing (was -1.994 as a dust sale)', ta?.realizedPnlSol === 0 && ta?.entrySol === 0 && ta?.open === false && ta?.sells === 0, JSON.stringify(ta));
  check('analysis: B cost 2 (carried) and sold for 3: +1', near(tb?.solIn ?? NaN, 2, 1e-3) && near(tb?.realizedPnlSol ?? NaN, 1, 1e-3), JSON.stringify(tb));
  check('analysis: D, from a token never seen bought, stays unbacked (no profit)', td === undefined || td.realizedPnlSol === 0, JSON.stringify(td));
  check('analysis: wallet total +1', near(m.realizedPnlSol, 1, 1e-3), `got ${m.realizedPnlSol}`);
}

// ── 4. real chain ───────────────────────────────────────────────────────────
if (process.argv.includes('--chain')) {
  console.log('\nreal swaps — txDeltas vs the validator\'s pre/post balances');
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    check('HELIUS_API_KEY set (source apps/api/.env first)', false);
  } else {
    const wallets = JSON.parse(
      execFileSync('sqlite3', ['-json', '-readonly', path.join(ROOT, 'apps/api/prisma/dev.db'), 'select address from Wallet where subscribed=1 and purgedAt is null limit 15'], { encoding: 'utf8' }).trim() || '[]',
    ).map((r) => r.address);
    const rpc = async (method, params) =>
      (await (await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const perSource = {};
    let n = 0;
    for (const w of wallets) {
      const txs = await (await fetch(`https://api.helius.xyz/v0/addresses/${w}/transactions?api-key=${key}&type=SWAP&limit=30`)).json().catch(() => []);
      for (const t of Array.isArray(txs) ? txs : []) {
        if ((perSource[t.source] ?? 0) >= 3) continue;
        const d = txDeltas(w, t);
        if (d.tokens.size !== 1) continue;
        const g = await rpc('getTransaction', [t.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
        if (!g) continue;
        const keys = [...g.transaction.message.accountKeys, ...(g.meta.loadedAddresses?.writable ?? []), ...(g.meta.loadedAddresses?.readonly ?? [])];
        const i = keys.indexOf(w);
        if (i < 0) continue;
        const wsol = (b) => (b ?? []).filter((x) => x.owner === w && x.mint === WSOL).reduce((s, x) => s + Number(x.uiTokenAmount.uiAmountString || 0), 0);
        const truth = (g.meta.postBalances[i] - g.meta.preBalances[i]) / 1e9 + wsol(g.meta.postTokenBalances) - wsol(g.meta.preTokenBalances);
        perSource[t.source] = (perSource[t.source] ?? 0) + 1;
        n++;
        check(`${t.source.padEnd(16)} ${t.signature.slice(0, 8)} ${d.sol.toFixed(6)} vs ${truth.toFixed(6)} SOL`, near(d.sol, truth, 1e-6));
      }
    }
    if (n === 0) check('found real swaps to check (subscribe some wallets first)', false);
  }
}

rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
