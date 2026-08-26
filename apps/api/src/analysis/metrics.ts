import type { TokenBreakdown, WalletFlag, WalletMetrics } from '@million/shared';
import type { HeliusTx } from './helius.service';

const WSOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

interface Position {
  mint: string;
  qty: number;
  costSol: number; // cost basis of current qty
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  realized: number;
  firstBuyTs: number | null;
  lastSellTs: number | null;
}

/**
 * Average-cost realized PnL per token, from the wallet's SOL/token deltas in each swap.
 * Token->token swaps (no SOL leg) are counted as activity but excluded from PnL.
 */
export function computeMetrics(wallet: string, txs: HeliusTx[], truncated: boolean): WalletMetrics {
  // process oldest -> newest so cost basis builds correctly
  const ordered = [...txs].sort((a, b) => a.timestamp - b.timestamp);
  const positions = new Map<string, Position>();

  const getPos = (mint: string): Position => {
    let p = positions.get(mint);
    if (!p) {
      p = { mint, qty: 0, costSol: 0, buys: 0, sells: 0, solIn: 0, solOut: 0, realized: 0, firstBuyTs: null, lastSellTs: null };
      positions.set(mint, p);
    }
    return p;
  };

  for (const tx of ordered) {
    // net SOL delta for this wallet (native + wSOL), in SOL
    let solDelta = 0;
    for (const t of tx.nativeTransfers ?? []) {
      if (t.toUserAccount === wallet) solDelta += t.amount / LAMPORTS;
      if (t.fromUserAccount === wallet) solDelta -= t.amount / LAMPORTS;
    }
    // net per-mint token deltas for this wallet
    const tokenDeltas = new Map<string, number>();
    for (const t of tx.tokenTransfers ?? []) {
      const delta = (t.toUserAccount === wallet ? t.tokenAmount : 0) - (t.fromUserAccount === wallet ? t.tokenAmount : 0);
      if (delta === 0) continue;
      if (t.mint === WSOL) {
        solDelta += delta;
      } else {
        tokenDeltas.set(t.mint, (tokenDeltas.get(t.mint) ?? 0) + delta);
      }
    }

    for (const [mint, delta] of tokenDeltas) {
      const p = getPos(mint);
      if (delta > 0 && solDelta < 0) {
        // buy: SOL out, token in
        p.buys++;
        p.qty += delta;
        p.costSol += -solDelta;
        p.solIn += -solDelta;
        if (p.firstBuyTs === null) p.firstBuyTs = tx.timestamp;
      } else if (delta < 0 && solDelta > 0) {
        // sell: token out, SOL in
        const sold = -delta;
        p.sells++;
        p.solOut += solDelta;
        p.lastSellTs = tx.timestamp;
        if (p.qty > 0) {
          const avgCost = p.costSol / p.qty;
          const costOfSold = avgCost * Math.min(sold, p.qty);
          p.realized += solDelta - costOfSold;
          p.costSol -= costOfSold;
          p.qty = Math.max(0, p.qty - sold);
        } else {
          // sold tokens acquired before our fetch window (airdrop/transfer): pure proceeds
          p.realized += solDelta;
        }
      }
      // token<->token or transfer-only legs: ignored for PnL
    }
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
      realizedPnlSol: round(p.realized),
      holdMinutes:
        p.firstBuyTs !== null && p.lastSellTs !== null && p.lastSellTs >= p.firstBuyTs
          ? Math.round((p.lastSellTs - p.firstBuyTs) / 60)
          : null,
      open: p.qty > 1e-9 && p.sells === 0,
    }))
    .sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);

  const closed = tokens.filter((t) => t.buys > 0 && t.sells > 0);
  const wins = closed.filter((t) => t.realizedPnlSol > 0).length;
  const holds = closed.map((t) => t.holdMinutes).filter((h): h is number => h !== null).sort((a, b) => a - b);
  const timestamps = ordered.map((t) => t.timestamp);
  const firstSeen = timestamps.length ? timestamps[0] : null;
  const lastSeen = timestamps.length ? timestamps[timestamps.length - 1] : null;
  const now = Date.now() / 1000;

  const winRate = closed.length ? wins / closed.length : null;
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)] : null;

  const flags: WalletFlag[] = [];
  if (firstSeen !== null && now - firstSeen < 7 * 86400 && !truncated) flags.push('FRESH_WALLET');
  if (medianHold !== null && medianHold < 5 && closed.length >= 5) flags.push('SNIPER_SPEED');
  if (winRate !== null && winRate > 0.9 && closed.length >= 20) flags.push('HIGH_WINRATE_SUS');
  if (closed.length < 5) flags.push('LOW_ACTIVITY');
  if (lastSeen !== null && now - lastSeen > 14 * 86400) flags.push('DORMANT');

  return {
    totalSwaps: ordered.length,
    analyzedTxCount: ordered.length,
    truncated,
    uniqueTokens: tokens.length,
    closedTokens: closed.length,
    winRate: winRate !== null ? round(winRate) : null,
    realizedPnlSol: round(tokens.reduce((s, t) => s + t.realizedPnlSol, 0)),
    medianHoldMinutes: medianHold,
    firstSeen: firstSeen !== null ? new Date(firstSeen * 1000).toISOString() : null,
    lastSeen: lastSeen !== null ? new Date(lastSeen * 1000).toISOString() : null,
    flags,
    tokens: tokens.slice(0, 100),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
