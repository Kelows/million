import type { TokenBreakdown, WalletFlag, WalletMetrics } from '@million/shared';
import type { HeliusTx } from './helius.service';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const LAMPORTS = 1e9;

export interface TxDeltas {
  sol: number;
  usd: number;
  tokens: Map<string, number>;
}
// classification noise floors: below these a quote delta is fees/rent, not a trade leg
const SOL_EPS = 0.005;
const USD_EPS = 0.5;

interface Position {
  mint: string;
  qty: number;
  costSol: number;
  costUsd: number;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  usdIn: number;
  usdOut: number;
  realSol: number;
  realUsd: number;
  unbackedSol: number; // proceeds from selling tokens we never saw bought — not profit, just cash
  unbackedUsd: number;
  firstBuyTs: number | null;
  lastBuyTs: number | null;
  lastSellTs: number | null;
}

/**
 * Quote-aware average-cost ledger over a wallet's full history.
 * SOL, USDC and USDT are all treated as quote currencies (the 2snHH lesson:
 * stable-quoted traders are invisible to a SOL-only ledger). Also derives
 * infrastructure signals: sweeps, deliveries, external fee payers, counterparties.
 */
export function computeMetrics(wallet: string, txs: HeliusTx[], truncated: boolean, solPriceUsd = 200): WalletMetrics {
  const ordered = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const positions = new Map<string, Position>();
  const counterparties = new Set<string>();
  const feePayers = new Map<string, number>();
  let externalFeeCount = 0;
  let deliveries = 0;
  let sweepIns = 0;
  let tradeTxCount = 0;

  const getPos = (mint: string): Position => {
    let p = positions.get(mint);
    if (!p) {
      p = { mint, qty: 0, costSol: 0, costUsd: 0, buys: 0, sells: 0, solIn: 0, solOut: 0, usdIn: 0, usdOut: 0, realSol: 0, realUsd: 0, unbackedSol: 0, unbackedUsd: 0, firstBuyTs: null, lastBuyTs: null, lastSellTs: null };
      positions.set(mint, p);
    }
    return p;
  };

  for (const tx of ordered) {
    if (tx.feePayer && tx.feePayer !== wallet) {
      externalFeeCount++;
      feePayers.set(tx.feePayer, (feePayers.get(tx.feePayer) ?? 0) + 1);
    }

    const { sol, usd, tokens: tokenDeltas } = orchestratedDeltas(wallet, tx, counterparties);

    if (tokenDeltas.size === 0) {
      if (usd > USD_EPS || sol > 0.01) sweepIns++;
      continue;
    }

    let traded = false;
    for (const [mint, delta] of tokenDeltas) {
      const p = getPos(mint);
      if (delta > 0 && (sol < -SOL_EPS || usd < -USD_EPS)) {
        // buy: token in, quote out
        const cs = sol < 0 ? -sol : 0;
        const cu = usd < 0 ? -usd : 0;
        p.buys++;
        p.qty += delta;
        p.costSol += cs;
        p.costUsd += cu;
        p.solIn += cs;
        p.usdIn += cu;
        if (p.firstBuyTs === null) p.firstBuyTs = tx.timestamp;
        p.lastBuyTs = tx.timestamp;
        traded = true;
      } else if (delta < 0 && (sol > SOL_EPS || usd > USD_EPS)) {
        // sell: token out, quote in
        const gs = sol > 0 ? sol : 0;
        const gu = usd > 0 ? usd : 0;
        const sold = -delta;
        p.sells++;
        p.solOut += gs;
        p.usdOut += gu;
        p.lastSellTs = tx.timestamp;
        if (p.qty > 0) {
          const fraction = Math.min(sold, p.qty) / p.qty;
          p.realSol += gs - p.costSol * fraction;
          p.realUsd += gu - p.costUsd * fraction;
          p.costSol *= 1 - fraction;
          p.costUsd *= 1 - fraction;
          p.qty = Math.max(0, p.qty - sold);
        } else {
          // Sold tokens we never saw bought — acquired before our window, or
          // airdropped. Booking the proceeds as profit invented 5.7k SOL of
          // phantom PnL across the roster and pushed those wallets to the top
          // of the scoring range. Profit needs a cost basis; this has none, so
          // it is tracked separately and kept out of realized.
          p.unbackedSol += gs;
          p.unbackedUsd += gu;
        }
        traded = true;
      } else if (delta < 0) {
        deliveries++; // token sent out with no proceeds — a delivery, not a trade
        // ...but the tokens did leave. Moving a bag to a fresh wallet used to
        // leave it here as "still held" at full cost. Retire that share of the
        // basis; no proceeds means no realized PnL either way.
        if (p.qty > 0) {
          const fraction = Math.min(-delta, p.qty) / p.qty;
          p.costSol *= 1 - fraction;
          p.costUsd *= 1 - fraction;
          p.qty = Math.max(0, p.qty + delta);
        }
      }
      // delta > 0 with no payment: airdrop/incoming transfer — ignored for PnL
    }
    if (traded) tradeTxCount++;
  }

  const tokens: TokenBreakdown[] = [...positions.values()]
    .filter((p) => p.buys + p.sells > 0)
    .map((p) => ({
      mint: p.mint,
      symbol: null,
      buys: p.buys,
      sells: p.sells,
      solIn: round(p.solIn),
      solOut: round(p.solOut),
      usdIn: round(p.usdIn),
      usdOut: round(p.usdOut),
      realizedPnlSol: round(p.realSol),
      realizedPnlUsd: round(p.realUsd),
      // remaining cost basis in SOL terms — the live exposure, not the total ever bought
      entrySol: round(p.costSol + p.costUsd / solPriceUsd),
      qty: p.qty,
      holdMinutes:
        p.firstBuyTs !== null && p.lastSellTs !== null && p.lastSellTs >= p.firstBuyTs
          ? Math.round((p.lastSellTs - p.firstBuyTs) / 60)
          : null,
      firstBuyAt: p.firstBuyTs !== null ? new Date(p.firstBuyTs * 1000).toISOString() : null,
      lastActivityAt:
        p.lastBuyTs !== null || p.lastSellTs !== null
          ? new Date(Math.max(p.lastBuyTs ?? 0, p.lastSellTs ?? 0) * 1000).toISOString()
          : null,
      // open = still holding a meaningful position; partial exits stay open (whales sell half and ride)
      open: p.qty > 1e-9 && p.costSol + p.costUsd / solPriceUsd > 0.02,
    }))
    .sort((a, b) => b.realizedPnlSol + (b.realizedPnlUsd ?? 0) / solPriceUsd - (a.realizedPnlSol + (a.realizedPnlUsd ?? 0) / solPriceUsd));

  const closed = tokens.filter((t) => t.buys > 0 && t.sells > 0);
  const wins = closed.filter((t) => t.realizedPnlSol + (t.realizedPnlUsd ?? 0) / solPriceUsd > 0).length;
  const holds = closed.map((t) => t.holdMinutes).filter((h): h is number => h !== null).sort((a, b) => a - b);
  const timestamps = ordered.map((t) => t.timestamp);
  const firstSeen = timestamps.length ? timestamps[0] : null;
  const lastSeen = timestamps.length ? timestamps[timestamps.length - 1] : null;
  const now = Date.now() / 1000;

  const winRate = closed.length ? wins / closed.length : null;
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)] : null;
  const realizedPnlSol = round(tokens.reduce((s, t) => s + t.realizedPnlSol, 0));
  const realizedPnlUsd = round(tokens.reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0));

  const spanDays = firstSeen !== null && lastSeen !== null ? Math.max((lastSeen - firstSeen) / 86400, 1 / 24) : 1 / 24;
  const txPerDay = ordered.length / spanDays;
  // velocity is only meaningful over a real observation span — a truncated window
  // of one active afternoon extrapolates to absurd tx/day and flags humans as bots
  const velocityReliable = spanDays >= 0.25;
  const externalFeePayerShare = ordered.length ? externalFeeCount / ordered.length : 0;
  const totalBuys = tokens.reduce((s, t) => s + t.buys, 0);
  const totalSells = tokens.reduce((s, t) => s + t.sells, 0);

  const flags: WalletFlag[] = [];
  const isInfra =
    ordered.length >= 50 &&
    ((velocityReliable && txPerDay > 500) ||
      externalFeePayerShare > 0.3 ||
      (deliveries >= 20 && totalSells < totalBuys * 0.2) ||
      counterparties.size > 500 ||
      sweepIns > 100);
  if (isInfra) flags.push('BOT_INFRA');
  // the SPX lesson: 117 sells vs 12 buys = a distribution pipe, not a trader.
  // Their "PnL" is an exit ramp for a position acquired elsewhere (bridge, insider, early).
  if (!isInfra && totalSells >= 20 && totalSells > totalBuys * 4) flags.push('DISTRIBUTOR');
  if (firstSeen !== null && now - firstSeen < 7 * 86400 && !truncated) flags.push('FRESH_WALLET');
  if (medianHold !== null && medianHold < 5 && closed.length >= 5) flags.push('SNIPER_SPEED');
  if (winRate !== null && winRate > 0.9 && closed.length >= 20) flags.push('HIGH_WINRATE_SUS');
  const unbackedTotal = [...positions.values()].reduce((sum, p) => sum + p.unbackedSol + p.unbackedUsd / solPriceUsd, 0);
  // history truncation makes a wallet look brilliant: it sells bags we never saw
  // it buy, and every sale reads as pure profit. Flag it rather than trust it.
  if (unbackedTotal > 1 && unbackedTotal > Math.abs(realizedPnlSol + realizedPnlUsd / solPriceUsd)) flags.push('UNBACKED_HISTORY');
  if (closed.length < 5) flags.push('LOW_ACTIVITY');
  if (lastSeen !== null && now - lastSeen > 14 * 86400) flags.push('DORMANT');

  const topFeePayerEntry = [...feePayers.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    totalSwaps: tradeTxCount,
    analyzedTxCount: ordered.length,
    truncated,
    uniqueTokens: tokens.length,
    closedTokens: closed.length,
    winRate: winRate !== null ? round(winRate) : null,
    realizedPnlSol,
    realizedPnlUsd,
    realizedPnlTotalSol: round(realizedPnlSol + realizedPnlUsd / solPriceUsd),
    unbackedPnlSol: round(
      [...positions.values()].reduce((sum, p) => sum + p.unbackedSol + p.unbackedUsd / solPriceUsd, 0),
    ),
    solPriceUsd: round(solPriceUsd),
    medianHoldMinutes: medianHold,
    firstSeen: firstSeen !== null ? new Date(firstSeen * 1000).toISOString() : null,
    lastSeen: lastSeen !== null ? new Date(lastSeen * 1000).toISOString() : null,
    flags,
    tokens: tokens.slice(0, 100),
    infra: {
      txPerDay: round(txPerDay),
      externalFeePayerShare: round(externalFeePayerShare),
      deliveries,
      sweepIns,
      uniqueCounterparties: counterparties.size,
    },
    topFeePayer:
      topFeePayerEntry && ordered.length && topFeePayerEntry[1] / ordered.length > 0.1
        ? { address: topFeePayerEntry[0], share: round(topFeePayerEntry[1] / ordered.length) }
        : null,
  };
}

/** A wallet's quote and token deltas in one tx — shared by the ledger and the live feed. */

/**
 * Orchestrator attribution: fleets execute each trade through a fresh wallet
 * while one address pays every fee (the 2snHH pattern). When the analyzed
 * wallet is the fee payer but has no deltas of its own, the executor is the
 * account it exchanged a direct native transfer with in the same tx (the
 * fee/tip skim) — its deltas ARE the entity's trade, at zero extra fetches.
 */
export function orchestratedDeltas(wallet: string, tx: HeliusTx, counterparties?: Set<string>): TxDeltas {
  const own = txDeltas(wallet, tx, counterparties);
  if (own.tokens.size > 0 || tx.feePayer !== wallet) return own;
  const linked = new Set<string>();
  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount === wallet && t.toUserAccount) linked.add(t.toUserAccount);
    if (t.toUserAccount === wallet && t.fromUserAccount) linked.add(t.fromUserAccount);
  }
  for (const executor of linked) {
    const d = txDeltas(executor, tx);
    if (d.tokens.size > 0) return d;
  }
  return own;
}

export function txDeltas(wallet: string, tx: HeliusTx, counterparties?: Set<string>): TxDeltas {
  let sol = 0;
  let usd = 0;
  const ad = tx.accountData?.find((a) => a.account === wallet);
  if (ad) {
    // SOL moved = native balance change + net change of this wallet's WSOL token
    // balance. NOT native change + WSOL transfers: a router that wraps SOL in,
    // swaps, and unwraps out lists that SOL as a WSOL transfer AND lands it in
    // the native balance, so summing both counted it twice. Checked against raw
    // RPC pre/post balances on 36 real swaps across 11 routers: the old sum was
    // off by ~100% on 26 of them (Jupiter, PUMP_AMM, Meteora, Raydium, Orca...),
    // this is exact on all 36. A wrap-and-unwrap inside one tx nets to zero here.
    sol += ad.nativeBalanceChange / LAMPORTS;
    for (const a of tx.accountData ?? []) {
      for (const c of a.tokenBalanceChanges ?? []) {
        if (c.userAccount === wallet && c.mint === WSOL) sol += Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals;
      }
    }
  } else {
    for (const t of tx.nativeTransfers ?? []) {
      if (t.toUserAccount === wallet) sol += t.amount / LAMPORTS;
      if (t.fromUserAccount === wallet) sol -= t.amount / LAMPORTS;
    }
  }
  const tokens = new Map<string, number>();
  for (const t of tx.tokenTransfers ?? []) {
    if (counterparties) {
      const other = t.fromUserAccount === wallet ? t.toUserAccount : t.toUserAccount === wallet ? t.fromUserAccount : null;
      if (other && other !== wallet && counterparties.size < 5000) counterparties.add(other);
    }
    const delta = (t.toUserAccount === wallet ? t.tokenAmount : 0) - (t.fromUserAccount === wallet ? t.tokenAmount : 0);
    if (delta === 0) continue;
    if (t.mint === WSOL) {
      if (!ad) sol += delta; // with accountData, WSOL is already counted from the balance change above
    }
    else if (t.mint === USDC || t.mint === USDT) usd += delta;
    else tokens.set(t.mint, (tokens.get(t.mint) ?? 0) + delta);
  }
  return { sol, usd, tokens };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
