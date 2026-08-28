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
  | 'BOT_INFRA' // automated infrastructure (broker/volume/MEV), not a trader
  | 'DISTRIBUTOR'; // sells vastly exceed buys — an early holder exiting a bag, not trading

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
  firstBuyAt?: string | null; // ISO — when the position was opened
  lastActivityAt?: string | null; // ISO — most recent buy or sell; fresh vs dead
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
  lifetimeTxs?: number | null; // from the signature index; null = unknown
  lifetimeCapped?: boolean; // true = account has MORE than we counted
  accountFirstTxAt?: string | null; // account age, independent of the analysis window
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
  subscribed: boolean;
  ownerId: number | null;
  /** other roster addresses assigned to the same owner (detail endpoint only) */
  ownerSiblings?: { address: string; label: string | null }[];
  /** aggregate across all owner members (detail endpoint only, when clustered) */
  ownerAggregate?: OwnerAggregate;
}

export interface OwnerAggregate {
  members: number;
  combinedPnlSol: number;
  winRate: number | null; // pooled wins / pooled closed
  closedTokens: number;
  openTokens: number; // union of open non-excluded mints
  subscribedCount: number;
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

/** Majors/wrapped/quote-like tokens that are never a meme signal — excluded like stables. */
export const EXCLUDED_TOKEN_MINTS = new Set([
  '5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ', // WBTC
  'CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump', // USDUC (stable parody, trades like a quote)
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Portal)
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Portal)
]);

/** Known mints first, then a symbol heuristic — "as much as we can" coverage. */
export function isStablecoin(mint: string, symbol?: string | null): boolean {
  if (STABLECOIN_MINTS.has(mint)) return true;
  if (!symbol) return false;
  const s = symbol.toUpperCase();
  return s.includes('USD') || s === 'DAI';
}

/** Not a signal: stables, majors, wrapped assets — by mint or symbol. */
export function isExcludedToken(mint: string, symbol?: string | null): boolean {
  if (isStablecoin(mint, symbol)) return true;
  if (EXCLUDED_TOKEN_MINTS.has(mint)) return true;
  const s = symbol?.toUpperCase();
  return s === 'WBTC' || s === 'WETH' || s === 'WSOL' || s === 'CBBTC';
}

/** Positions below this entry cost are dust, not conviction. */
export const DEFAULT_MIN_OPEN_SOL = 1;

/** Tokens a wallet ENTERED in its analysis window (>= minSol total entry, stables excluded).
 * The consensus signal: co-entry beats still-holding — meme wallets flip too fast to overlap on holds. */
export function enteredPositions(tokens: TokenBreakdown[], minSol: number, solPriceUsd = 200): TokenBreakdown[] {
  return tokens.filter(
    (t) => t.buys > 0 && !isExcludedToken(t.mint, t.symbol) && t.solIn + (t.usdIn ?? 0) / solPriceUsd >= minSol,
  );
}

/** A wallet's open positions — stablecoins and dust-sized entries excluded. */
export function openPositions(tokens: TokenBreakdown[], minSol: number = DEFAULT_MIN_OPEN_SOL): TokenBreakdown[] {
  return tokens.filter((t) => t.open && !isExcludedToken(t.mint, t.symbol) && (t.entrySol ?? t.solIn) >= minSol);
}

/** One definition of a wallet worth acting on — dashboard watch list and recs both use it. */
export const WATCH_CRITERIA = { minWinRate: 0.4, minClosedTokens: 2 }; // calibrated for deep (300-tx) windows

/** Unambiguous junk: structural evidence only. HIGH_WINRATE_SUS is suspicion, not proof —
 * it stays a warning (and blocks auto-absorption) but never justifies deletion. */
export const JUNK_FLAGS: WalletFlag[] = ['BOT_INFRA'];

export function isJunkWallet(m: WalletMetrics): boolean {
  return m.flags.some((f) => JUNK_FLAGS.includes(f));
}

/** The whale-quality score: win rate carries most weight, realized PnL the rest, bots slammed to -100. */
export function whaleScore(winRate: number | null, pnlSol: number, botLike: boolean): number {
  if (botLike) return -100;
  return Math.round((winRate ?? 0) * 100 + Math.max(-50, Math.min(200, pnlSol)) / 2);
}

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
  flags: WalletFlag[] | null; // from the preview analysis
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
  firstBuyAt: string; // ISO — deep scans surface launch-era entries
  lastBuyAt: string; // ISO
  inRoster: boolean;
  preview: FundingPreview | null; // null beyond the auto-analysis cap
  flags: WalletFlag[] | null; // from the preview analysis
}

export interface DiscoveryReport {
  mint: string;
  mode: 'recent' | 'deep';
  scannedTxs: number;
  truncated: boolean;
  minSol: number;
  spanFrom: string | null; // ISO — oldest sampled tx (deep: reaches toward launch)
  spanTo: string | null;
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
  safetyFail: boolean; // failed a SAFETY check (authorities, rug risks) — size failsafes don't count
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
  discoveryMinSol: z.coerce.number().nonnegative().default(2), // 5 was above the pond — young-token buys run 1-3 SOL
  autoAbsorb: z.boolean().default(true), // false = crawler only reports, never touches the roster
  deepScanNewGems: z.boolean().default(true), // first sighting of a safety-clean gem = whole-life buyer scan
  deepScanBuckets: z.coerce.number().min(12).max(96).default(48),
  minWhaleScore: z.coerce.number().min(-100).max(200).default(40), // absorb every clean buyer at or above this, not just the best
  deepRunCredits: z.coerce.number().min(100).max(50_000).default(3_000), // a deep run chains iterations until this total is spent
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
  deepRunning: boolean;
  nextRunAt: string | null;
  lastRuns: CrawlerRunSummary[];
}

// ── live feed ─────────────────────────────────────────────────────────────────

export interface LiveEventRow {
  id: number;
  wallet: string;
  walletLabel: string | null;
  signature: string;
  ts: string; // ISO
  kind: 'buy' | 'sell' | 'other';
  mint: string | null;
  symbol: string | null;
  sol: number;
  usd: number;
}

export interface LiveStatus {
  ingestion: 'webhook' | 'websocket' | 'webhook-fallback'; // fallback = webhook registered but deliveries dead, WS carrying the feed
  connected: boolean;
  subscribedWallets: number;
  activeSubscriptions: number;
  maxSubscriptions: number;
  eventsToday: number;
  lastEventAt: string | null;
}

// ── opportunities: the live, actionable signal ────────────────────────────────

export const OpportunityConfigSchema = z.object({
  minBuySol: z.coerce.number().nonnegative().default(5), // conviction filter: every sub-5◎ trigger in the first sample bled
  allowWarn: z.boolean().default(false), // WARN entries went 1-for-7 in the first sample — the gauntlet was right
  // staged for the (paper-first) auto trader — stored now, acted on later
  positionSol: z.coerce.number().nonnegative().default(0.1), // fixed size, and the hard cap in whale-pct mode
  sizingMode: z.enum(['fixed', 'whale-pct', 'whale-frac']).default('fixed'), // whale-frac = their buy as a share of THEIR bankroll, applied to ours
  bankrollSol: z.coerce.number().nonnegative().default(5), // our notional bankroll for whale-frac sizing
  copyPct: z.coerce.number().min(0.1).max(100).default(5), // % of the whale's own entry, clamped to positionSol
  takeProfitPct: z.coerce.number().min(1).default(100),
  stopLossPct: z.coerce.number().min(1).max(100).default(50),
  autoTrade: z.boolean().default(false), // locked until paper stats prove expectancy
  paperEnabled: z.boolean().default(true), // every opportunity opens a simulated position
  slippagePct: z.coerce.number().min(0).max(50).default(2), // assumed cost per side
  maxHoldHours: z.coerce.number().min(1).max(720).default(48), // timeout exit
  maxOpenPositions: z.coerce.number().int().min(1).max(50).default(10),
  exitMode: z.enum(['rules', 'mirror']).default('rules'),
  ignoreSniperTriggers: z.boolean().default(true), // machine-speed entries are adverse selection at human latency
  maxTotalExposureSol: z.coerce.number().nonnegative().default(1), // portfolio cap across open positions // mirror = sell when the triggering wallet sells; SL+timeout stay as brakes
  followRotations: z.boolean().default(true), // subscribed wallet funds a fresh wallet -> absorb + inherit the sub
  minFundSol: z.coerce.number().nonnegative().default(1),
  // circuit breakers — the book-level brakes the per-position caps can't provide
  maxConsecutiveLosses: z.coerce.number().int().min(1).max(50).default(5), // halt after this many losses in a row
  weeklyLossLimitPct: z.coerce.number().min(1).max(100).default(35), // halt when 7-day realized PnL < -this % of bankroll
  haltClearedAt: z.string().nullable().default(null), // manual resume timestamp — closes before it don't count
  minEdgeRetentionPct: z.coerce.number().min(0).max(100).default(60), // skip triggers whose measured copyability is below this (unmeasured pass)
  trailStopPct: z.coerce.number().min(1).max(50).default(15), // asymmetric mirror: winners trail this far off peak instead of exiting flat
});
export type OpportunityConfig = z.infer<typeof OpportunityConfigSchema>;

export interface OpportunityRow {
  id: number;
  kind: 'token' | 'wallet';
  mint: string | null;
  symbol: string | null;
  wallet: string; // token: the buyer · rotation: the NEW wallet
  walletLabel: string | null;
  funder: string | null; // rotation only
  funderLabel: string | null;
  verdict: CheckStatus;
  buySol: number;
  ts: string; // ISO
}

/** A token that pumped recently — the blank-state seeding material. */
export interface MoverToken {
  mint: string;
  symbol: string | null;
  pumpH24Pct: number;
  liquidityUsd: number;
  marketCapUsd: number;
  volumeH24Usd: number;
  alreadyTracked: boolean;
}

// ── paper trading ─────────────────────────────────────────────────────────────

export interface PaperPositionRow {
  id: number;
  mint: string;
  symbol: string | null;
  wallet: string | null; // triggering wallet
  sizeSol: number;
  entryPriceUsd: number;
  openedAt: string;
  status: 'open' | 'closed';
  currentPriceUsd?: number | null; // open positions only
  unrealizedPct?: number | null;
  exitPriceUsd: number | null;
  exitReason: string | null; // tp | sl | timeout | manual
  closedAt: string | null;
  pnlSol: number | null;
  pnlPct: number | null;
  mode: string;
}

export interface CohortRow {
  bucket: string; // score-at-absorb range
  wallets: number;
  avgScoreAtAbsorb: number;
  avgForwardPnlSol: number; // current realized minus realized at absorption
  medianForwardPnlSol: number;
}

export interface TradingStats {
  mode: string;
  openCount: number;
  closedCount: number;
  wins: number;
  winRate: number | null;
  totalPnlSol: number;
  avgPnlPct: number | null;
  expectancySolPerTrade: number | null; // THE number — gates auto-trade
  avgLatencyCostPct: number | null; // our entry vs the whale's own fill
}

// ── copyability: does the whale's edge survive OUR latency? ──

export interface CopyabilityToken {
  mint: string;
  symbol: string | null;
  entryAt: string; // whale's first buy (ISO)
  exitAt: string; // whale's last activity (ISO)
  whaleRetPct: number; // candle-close to candle-close over the whale's hold
  copierRetPct: number; // same trade entered/exited one candle (~1 min) later
  weightSol: number; // whale's entry size — weights the aggregate
}

export interface CopyabilityResult {
  computedAt: string;
  delaySec: number; // simulated copy latency (webhook + gauntlet + execution)
  tokens: CopyabilityToken[];
  sampled: number; // closed tokens measured
  skipped: number; // closed tokens without candle/pool data
  whaleAvgRetPct: number | null; // size-weighted
  copierAvgRetPct: number | null;
  edgeRetentionPct: number | null; // copier/whale ×100 — null when whale edge too small to divide by
}

export interface CopyabilityWalletRow {
  address: string;
  label: string | null;
  whaleScore: number | null;
  lastSeen: string | null;
  copyability: CopyabilityResult | null;
}

export interface CopyabilityJobStatus {
  running: boolean;
  done: number;
  total: number;
  current: string | null; // address in flight
}

// ── famous tokens: what the roster is in, and where it won ──

export interface FamousTokenRow {
  mint: string;
  symbol: string | null;
  owners: number; // distinct owners (clustered wallets count once)
  sol: number; // held: open entry SOL at cost · earned: realized PnL SOL
  realizedSol?: number; // held rows: what the roster ALREADY took off this mint
  score?: number; // held rows: conviction — owners × √entry, discounted by profit already taken
}

export interface FamousTokens {
  held: FamousTokenRow[]; // open positions right now — the roster's live consensus
  earned: FamousTokenRow[]; // realized PnL leaders — where the roster actually printed
}

export interface TradingHalt {
  halted: boolean;
  reason: string | null;
  consecutiveLosses: number;
  weeklyPnlSol: number; // realized over the rolling 7 days (since last resume)
}
