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

// ── token legitimacy screening ────────────────────────────────────────────────

/** Thresholds are the user's custom system — new knobs (bundler %, sniper %) slot in here. */
export const TokenCheckThresholdsSchema = z.object({
  minLiquidityUsd: z.coerce.number().nonnegative().default(100_000),
  minMarketCapUsd: z.coerce.number().nonnegative().default(200_000),
  maxTop10Pct: z.coerce.number().min(0).max(100).default(25),
  minTokenAgeMinutes: z.coerce.number().nonnegative().default(60),
});
export type TokenCheckThresholds = z.infer<typeof TokenCheckThresholdsSchema>;

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface TokenCheck {
  id: string;
  label: string;
  status: CheckStatus;
  value: string | null; // measured value, human readable
  detail: string; // why it matters / what was compared
}

export interface TokenReport {
  mint: string;
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: string | null;
  dex: string | null;
  pairUrl: string | null;
  rugcheckScore: number | null;
  checks: TokenCheck[];
  verdict: CheckStatus;
  fetchedAt: string;
}

// ── stablecoins ───────────────────────────────────────────────────────────────

export const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
]);

/** Known mints first, then a symbol heuristic — "as much as we can" coverage. */
export function isStablecoin(mint: string, symbol?: string | null): boolean {
  if (STABLECOIN_MINTS.has(mint)) return true;
  if (!symbol) return false;
  const s = symbol.toUpperCase();
  return s.includes('USD') || s === 'DAI';
}

/** A wallet's open positions, stablecoins excluded — the roster/dashboard definition of "open". */
export function openPositions(tokens: TokenBreakdown[]): TokenBreakdown[] {
  return tokens.filter((t) => t.open && !isStablecoin(t.mint, t.symbol));
}

/** One definition of a wallet worth acting on — dashboard watch list and recs both use it. */
export const WATCH_CRITERIA = { minWinRate: 0.5, minClosedTokens: 3 };

export function isQualifyingWallet(m: WalletMetrics): boolean {
  if (m.winRate === null) return false;
  return m.winRate > WATCH_CRITERIA.minWinRate && m.closedTokens >= WATCH_CRITERIA.minClosedTokens;
}

// ── recommendations ───────────────────────────────────────────────────────────

export interface ConsensusToken {
  mint: string;
  symbol: string | null;
  count: number; // qualifying wallets currently holding it
  holders: { address: string; label: string | null }[];
}

export interface RecommendationsData {
  generatedAt: string;
  criteria: { minWinRate: number; minClosedTokens: number };
  totalAnalyzed: number;
  qualifyingWallets: number;
  consensusTokens: ConsensusToken[];
}

// ── funding chains ────────────────────────────────────────────────────────────

export interface FundingLink {
  address: string;
  direction: 'out' | 'in'; // out = this wallet funded them; in = they funded this wallet
  totalSol: number;
  transfers: number;
  firstAt: string; // ISO
  lastAt: string; // ISO
  inRoster: boolean;
}

export interface FundingReport {
  address: string;
  analyzedTxCount: number;
  truncated: boolean;
  minSol: number;
  links: FundingLink[];
  fetchedAt: string;
}
