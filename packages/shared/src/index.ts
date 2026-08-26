import { z } from 'zod';

/** Base58 Solana address (loose length check; real validation happens on-chain). */
export const SolAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a valid Solana address');

/** Accepts either bare addresses or objects — whatever shape the whale JSON has. */
export const WalletImportEntrySchema = z.union([
  SolAddressSchema,
  z
    .object({
      address: SolAddressSchema,
      label: z.string().max(64).optional(),
    })
    .loose(), // tolerate extra fields in the friend's JSON
]);

export const WalletImportSchema = z.object({
  wallets: z.array(WalletImportEntrySchema).min(1).max(2000),
  source: z.string().max(64).optional(),
});
export type WalletImport = z.infer<typeof WalletImportSchema>;

export type WalletFlag =
  | 'FRESH_WALLET' // first activity < 7 days ago
  | 'SNIPER_SPEED' // median hold under 5 minutes — you cannot copy this manually
  | 'HIGH_WINRATE_SUS' // >90% win rate over many tokens — possibly farmed for copy-traders
  | 'LOW_ACTIVITY' // too few closed trades to trust the stats
  | 'DORMANT'; // no swaps in the last 14 days

export interface TokenBreakdown {
  mint: string;
  symbol: string | null;
  buys: number;
  sells: number;
  solIn: number; // SOL spent buying
  solOut: number; // SOL received selling
  realizedPnlSol: number;
  holdMinutes: number | null; // first buy -> last sell
  open: boolean; // still holding a position
}

export interface WalletMetrics {
  totalSwaps: number;
  analyzedTxCount: number;
  truncated: boolean; // hit the fetch cap; stats cover most recent activity only
  uniqueTokens: number;
  closedTokens: number;
  winRate: number | null; // profitable closed tokens / closed tokens
  realizedPnlSol: number;
  medianHoldMinutes: number | null;
  firstSeen: string | null; // ISO
  lastSeen: string | null; // ISO
  flags: WalletFlag[];
  tokens: TokenBreakdown[];
}

export type WalletStatus = 'idle' | 'analyzing' | 'done' | 'error';

export interface WalletRecord {
  address: string;
  label: string | null;
  source: string | null;
  createdAt: string;
  lastAnalyzedAt: string | null;
  status: WalletStatus;
  metrics: WalletMetrics | null;
  error: string | null;
}
