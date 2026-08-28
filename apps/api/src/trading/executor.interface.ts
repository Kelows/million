/**
 * THE pluggable seam. The strategy engine only ever talks to this interface —
 * paper today, Jupiter (live) later, by swapping one provider binding in
 * trading.module.ts. Nothing else changes.
 */
export interface Fill {
  priceUsd: number; // effective fill price, costs included
  at: Date;
}

export interface TradeExecutor {
  readonly mode: 'paper' | 'live';
  /** Current market price for a mint, or null if unquotable. */
  quote(mint: string): Promise<number | null>;
  /** Enter a position of sizeSol. */
  buy(mint: string, sizeSol: number): Promise<Fill | null>;
  /** Exit a position fully. */
  sell(mint: string, sizeSol: number): Promise<Fill | null>;
}

export const TRADE_EXECUTOR = Symbol('TRADE_EXECUTOR');
