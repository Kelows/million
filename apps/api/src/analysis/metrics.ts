import type { TokenBreakdown, WalletFlag, WalletMetrics } from '@million/shared';
import type { HeliusTx } from './helius.service';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const LAMPORTS = 1e9;
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
  firstBuyTs: number | null;
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
      p = { mint, qty: 0, costSol: 0, costUsd: 0, buys: 0, sells: 0, solIn: 0, solOut: 0, usdIn: 0, usdOut: 0, realSol: 0, realUsd: 0, firstBuyTs: null, lastSellTs: null };
      positions.set(mint, p);
    }
    return p;
  };

  for (const tx of ordered) {
    if (tx.feePayer && tx.feePayer !== wallet) {
      externalFeeCount++;
      feePayers.set(tx.feePayer, (feePayers.get(tx.feePayer) ?? 0) + 1);
    }

    // quote deltas: prefer accountData (exact, covers wrapped routes), fall back to native transfers
    let sol = 0;
    let usd = 0;
    const ad = tx.accountData?.find((a) => a.account === wallet);
    if (ad) {
      sol += ad.nativeBalanceChange / LAMPORTS;
    } else {
      for (const t of tx.nativeTransfers ?? []) {
        if (t.toUserAccount === wallet) sol += t.amount / LAMPORTS;
        if (t.fromUserAccount === wallet) sol -= t.amount / LAMPORTS;
      }
    }
    const tokenDeltas = new Map<string, number>();
    for (const t of tx.tokenTransfers ?? []) {
      const other = t.fromUserAccount === wallet ? t.toUserAccount : t.toUserAccount === wallet ? t.fromUserAccount : null;
      if (other && other !== wallet && counterparties.size < 5000) counterparties.add(other);
      const delta = (t.toUserAccount === wallet ? t.tokenAmount : 0) - (t.fromUserAccount === wallet ? t.tokenAmount : 0);
      if (delta === 0) continue;
      if (t.mint === WSOL) sol += delta;
      else if (t.mint === USDC || t.mint === USDT) usd += delta;
      else tokenDeltas.set(t.mint, (tokenDeltas.get(t.mint) ?? 0) + delta);
    }

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
          // sold tokens acquired before our window (or airdropped): pure proceeds
          p.realSol += gs;
          p.realUsd += gu;
        }
        traded = true;
      } else if (delta < 0) {
        deliveries++; // token sent out with no proceeds — a delivery, not a trade
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
      entrySol: round(p.solIn + p.usdIn / solPriceUsd),
      holdMinutes:
        p.firstBuyTs !== null && p.lastSellTs !== null && p.lastSellTs >= p.firstBuyTs
          ? Math.round((p.lastSellTs - p.firstBuyTs) / 60)
          : null,
      open: p.qty > 1e-9 && p.sells === 0,
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
  const externalFeePayerShare = ordered.length ? externalFeeCount / ordered.length : 0;
  const totalBuys = tokens.reduce((s, t) => s + t.buys, 0);
  const totalSells = tokens.reduce((s, t) => s + t.sells, 0);

  const flags: WalletFlag[] = [];
  const isInfra =
    ordered.length >= 50 &&
    (txPerDay > 500 ||
      externalFeePayerShare > 0.3 ||
      (deliveries >= 20 && totalSells < totalBuys * 0.2) ||
      counterparties.size > 500 ||
      sweepIns > 100);
  if (isInfra) flags.push('BOT_INFRA');
  if (firstSeen !== null && now - firstSeen < 7 * 86400 && !truncated) flags.push('FRESH_WALLET');
  if (medianHold !== null && medianHold < 5 && closed.length >= 5) flags.push('SNIPER_SPEED');
  if (winRate !== null && winRate > 0.9 && closed.length >= 20) flags.push('HIGH_WINRATE_SUS');
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

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
