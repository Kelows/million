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

/**
 * A token-for-token swap: tokens out, other tokens in, no real SOL or stablecoin
 * leg. 8TWL sold ZCAT straight into CATE 23 times (9 Sep); each tx refunded a
 * few thousandths of a SOL of account rent, so the ledger booked every one as
 * a sale for dust. That invented a -671 SOL loss on ZCAT, and CATE's side
 * counted as an airdrop with no cost.
 */
export const ROTATION_MAX_QUOTE_SOL = 0.05;

export function isRotation(tokens: Map<string, number>, sol: number, usd: number, solUsd: number): boolean {
  let out = false;
  let into = false;
  for (const d of tokens.values()) {
    if (d < 0) out = true;
    if (d > 0) into = true;
  }
  return out && into && Math.abs(sol) + Math.abs(usd) / solUsd < ROTATION_MAX_QUOTE_SOL;
}

/**
 * The basis moves with the money: what the tokens given up cost is retired and
 * carried into the tokens received, split evenly if there are several. Nothing
 * is realized, because nothing was turned into SOL; the carried cost is
 * realized when the new token is sold. A carry under the minimum spend (tokens
 * we never saw bought) adds nothing, so a later sale stays unbacked instead of
 * reading as pure profit.
 */
export function rotationSteps(positions: Map<string, LedgerPosition | null>, tokens: Map<string, number>): Map<string, LedgerAction> {
  const actions = new Map<string, LedgerAction>();
  let carried = 0;
  const received: [string, number][] = [];
  for (const [mint, delta] of tokens) {
    if (delta > 0) {
      received.push([mint, delta]);
      continue;
    }
    const existing = positions.get(mint) ?? null;
    if (delta === 0 || !existing || existing.qty <= 0) {
      actions.set(mint, { op: 'none' });
      continue;
    }
    const sold = Math.min(-delta, existing.qty);
    const remaining = existing.qty - sold;
    if (remaining <= existing.qty * LEDGER_DUST_FRACTION) {
      carried += existing.costSol;
      actions.set(mint, { op: 'delete' });
    } else {
      const retired = existing.costSol * (sold / existing.qty);
      carried += retired;
      actions.set(mint, { op: 'update', qty: remaining, costSol: existing.costSol - retired });
    }
  }
  const share = received.length ? carried / received.length : 0;
  for (const [mint, delta] of received) {
    const existing = positions.get(mint) ?? null;
    actions.set(
      mint,
      share >= LEDGER_MIN_SPEND_SOL ? { op: 'upsert', qty: (existing?.qty ?? 0) + delta, costSol: (existing?.costSol ?? 0) + share } : { op: 'none' },
    );
  }
  return actions;
}
