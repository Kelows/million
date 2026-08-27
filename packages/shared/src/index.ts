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
  | 'DORMANT' // no swaps in the last 14 days
  | 'BOT_INFRA'; // automated infrastructure (broker/volume/MEV), not a trader

export interface TokenBreakdown {
  mint: string;
  symbol: string | null;
  buys: number;
  sells: number;
  solIn: number; // SOL spent buying
  solOut: number; // SOL received selling
  usdIn?: number; // USDC/USDT spent buying
  usdOut?: number; // USDC/USDT received selling
  realizedPnlSol: number;
  realizedPnlUsd?: number;
  entrySol?: number; // total entry cost expressed in SOL (usd leg converted at analysis-time price)
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
  realizedPnlUsd?: number;
  realizedPnlTotalSol?: number; // sol legs + usd legs converted at analysis-time SOL price
  solPriceUsd?: number;
  medianHoldMinutes: number | null;
  firstSeen: string | null; // ISO
  lastSeen: string | null; // ISO
  flags: WalletFlag[];
  tokens: TokenBreakdown[];
  infra?: {
    txPerDay: number;
    externalFeePayerShare: number;
    deliveries: number; // tokens sent out without proceeds
    sweepIns: number; // quote-only inflow txs
    uniqueCounterparties: number;
  };
  topFeePayer?: { address: string; share: number } | null;
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

/** Positions below this entry cost are dust, not conviction. */
export const DEFAULT_MIN_OPEN_SOL = 1;

/** A wallet's open positions — stablecoins and dust-sized entries excluded. */
export function openPositions(tokens: TokenBreakdown[], minSol: number = DEFAULT_MIN_OPEN_SOL): TokenBreakdown[] {
  return tokens.filter((t) => t.open && !isStablecoin(t.mint, t.symbol) && (t.entrySol ?? t.solIn) >= minSol);
}

/** One definition of a wallet worth acting on — dashboard watch list and recs both use it. */
export const WATCH_CRITERIA = { minWinRate: 0.5, minClosedTokens: 3 };

/** Bot-ish wallets: infrastructure, machine-speed traders, or farmed-looking stats. */
export function isBotWallet(m: WalletMetrics): boolean {
  return m.flags.some((f) => f === 'BOT_INFRA' || f === 'SNIPER_SPEED' || f === 'HIGH_WINRATE_SUS');
}

export function isQualifyingWallet(m: WalletMetrics): boolean {
  if (m.flags.includes('BOT_INFRA')) return false; // plumbing, not a trader
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
  criteria: { minWinRate: number; minClosedTokens: number; minOpenSol: number };
  totalAnalyzed: number;
  qualifyingWallets: number;
  consensusTokens: ConsensusToken[];
}

// ── funding chains ────────────────────────────────────────────────────────────

/** Quick worth-adding signal, computed from the wallet's most recent swaps. */
export interface FundingPreview {
  totalSwaps: number;
  winRate: number | null;
  closedTokens: number;
  realizedPnlSol: number;
  lastSeen: string | null;
}

/** Compress full metrics into the quick worth-adding heuristic view. */
export function summarizeMetrics(m: WalletMetrics): FundingPreview {
  return {
    totalSwaps: m.totalSwaps,
    winRate: m.winRate,
    closedTokens: m.closedTokens,
    realizedPnlSol: m.realizedPnlTotalSol ?? m.realizedPnlSol,
    lastSeen: m.lastSeen,
  };
}

export interface FundingLink {
  address: string;
  direction: 'out' | 'in'; // out = this wallet funded them; in = they funded this wallet
  totalSol: number;
  transfers: number;
  firstAt: string; // ISO
  lastAt: string; // ISO
  inRoster: boolean;
  preview: FundingPreview | null; // null when beyond the auto-analysis cap or analysis failed
}

export interface FundingReport {
  address: string;
  analyzedTxCount: number;
  truncated: boolean;
  minSol: number;
  links: FundingLink[];
  fetchedAt: string;
}

// ── whale discovery ───────────────────────────────────────────────────────────

export interface WhaleCandidate {
  address: string;
  boughtSol: number; // quote spent on this token in the scanned window, SOL terms
  buyTxs: number;
  lastBuyAt: string; // ISO
  inRoster: boolean;
  preview: FundingPreview | null; // null beyond the auto-analysis cap
  flags: WalletFlag[] | null; // from the preview analysis
}

export interface DiscoveryReport {
  mint: string;
  scannedTxs: number;
  truncated: boolean;
  minSol: number;
  candidates: WhaleCandidate[];
  fetchedAt: string;
}

// ── gems: the closed loop's output ────────────────────────────────────────────

export interface GemToken {
  mint: string;
  symbol: string | null;
  verdict: CheckStatus;
  whaleCount: number;
  holders: { address: string; label: string | null }[];
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: string | null;
  pairUrl: string | null;
  failures: string[]; // labels of failed checks
  warnings: string[]; // labels of warned checks
}

export interface GemsRunData {
  generatedAt: string;
  thresholds: TokenCheckThresholds;
  minOpenSol: number;
  totalAnalyzed: number;
  qualifyingWallets: number;
  candidates: number; // consensus tokens that entered the gauntlet
  gems: GemToken[]; // all candidates with verdicts, ranked
}

// ── tracked tokens ────────────────────────────────────────────────────────────

export interface TrackedToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  tracked: boolean; // explicitly followed vs merely seen in wallet analyses
  source: string | null;
  addedAt: string | null;
  lastCheckedAt: string | null;
  verdict: CheckStatus | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
}

/** What our own roster knows about a token. */
export interface TokenRosterIntel {
  holders: { address: string; label: string | null; entrySol: number | null }[];
  traders: { address: string; label: string | null; realizedPnlSol: number }[];
}

export interface TokenDetailData {
  token: TrackedToken;
  report: TokenReport | null;
  intel: TokenRosterIntel;
}

// ── the crawler: the loop, automated ──────────────────────────────────────────

export const CrawlerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sources: z
    .object({ wallets: z.boolean().default(true), tokens: z.boolean().default(true) })
    .refine((s) => s.wallets || s.tokens, 'at least one source must be enabled')
    .default({ wallets: true, tokens: true }),
  intervalMinutes: z.coerce.number().min(5).max(1440).default(30),
  creditsPerIteration: z.coerce.number().min(10).max(5000).default(600), // ~1 credit per fetched page/check
  maxTokensChecked: z.coerce.number().min(1).max(200).default(80),
  maxWalletsAbsorbed: z.coerce.number().min(0).max(200).default(50),
  maxWalletsReanalyzed: z.coerce.number().min(0).max(200).default(40),
  discoveryMinSol: z.coerce.number().nonnegative().default(5),
  autoAbsorb: z.boolean().default(true), // false = crawler only reports, never touches the roster
  minOpenSol: z.coerce.number().nonnegative().default(DEFAULT_MIN_OPEN_SOL),
  thresholds: TokenCheckThresholdsSchema.default(TokenCheckThresholdsSchema.parse({})),
});
export type CrawlerConfig = z.infer<typeof CrawlerConfigSchema>;

export interface CrawlerRunStats {
  creditsUsed: number;
  walletsReanalyzed: number;
  candidates: number;
  gemsPass: number;
  tokensScanned: number;
  walletsAbsorbed: number;
}

export interface CrawlerRunSummary {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  stats: CrawlerRunStats | null;
  log: string[];
}

export interface CrawlerStatus {
  config: CrawlerConfig;
  running: boolean;
  nextRunAt: string | null;
  lastRuns: CrawlerRunSummary[];
}
