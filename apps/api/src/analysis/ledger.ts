/**
 * One live event applied to one wallet's position in one token — the arithmetic
 * only, no I/O, so it can be checked against worked examples
 * (tools/check-accounting.mjs). LiveFeedService.applyToLedger performs whatever
 * this returns.
 *
 * Average-cost basis: a sell of fraction f retires f of the cost, and
 * proceeds − retired cost is the realized PnL. Tokens that leave without a swap
 * and without proceeds are a move, not a sale: the basis is retired, no round
 * trip is booked.
 */

export const LEDGER_MIN_SPEND_SOL = 0.01; // a "buy" spending less is a transfer, airdrop or misparse
export const LEDGER_DUST_FRACTION = 0.02; // at or under 2% of the bag left, the position is closed
export const LEDGER_NO_PROCEEDS_SOL = 0.005;

export interface LedgerPosition {
  qty: number;
  costSol: number;
}

export type LedgerAction =
  | { op: 'none' }
  | { op: 'upsert'; qty: number; costSol: number }
  | { op: 'update'; qty: number; costSol: number }
  | { op: 'delete' };

export interface LedgerStep {
  action: LedgerAction;
  /** realized PnL of a round trip to book, or null when nothing was traded */
  realizedSol: number | null;
  closed: boolean;
}

const NOTHING: LedgerStep = { action: { op: 'none' }, realizedSol: null, closed: false };

export function ledgerStep(
  existing: LedgerPosition | null,
  tokenDelta: number,
  sol: number,
  usd: number,
  solUsd: number,
  txType: string,
): LedgerStep {
  if (tokenDelta === 0) return NOTHING;

  if (tokenDelta > 0) {
    const spent = Math.max(0, -sol) + Math.max(0, -usd) / solUsd;
    if (spent < LEDGER_MIN_SPEND_SOL) return NOTHING;
    return {
      action: { op: 'upsert', qty: (existing?.qty ?? 0) + tokenDelta, costSol: (existing?.costSol ?? 0) + spent },
      realizedSol: null,
      closed: false,
    };
  }

  if (!existing || existing.qty <= 0) return NOTHING; // selling something never recorded — analysis reconciles
  const sold = Math.min(-tokenDelta, existing.qty);
  const remaining = existing.qty - sold;
  const retired = existing.costSol * (sold / existing.qty);
  const proceeds = Math.max(0, sol) + Math.max(0, usd) / solUsd;
  const dust = remaining <= existing.qty * LEDGER_DUST_FRACTION;

  if (txType !== 'SWAP' && proceeds < LEDGER_NO_PROCEEDS_SOL) {
    return {
      action: dust ? { op: 'delete' } : { op: 'update', qty: remaining, costSol: existing.costSol - retired },
      realizedSol: null,
      closed: false,
    };
  }
  if (dust) return { action: { op: 'delete' }, realizedSol: proceeds - existing.costSol, closed: true };
  return { action: { op: 'update', qty: remaining, costSol: existing.costSol - retired }, realizedSol: proceeds - retired, closed: false };
}
