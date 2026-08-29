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
  | 'DISTRIBUTOR' // sells vastly exceed buys — an early holder exiting a bag, not trading
  | 'UNBACKED_HISTORY'; // 'profit' is mostly proceeds from bags we never saw bought — truncated history, not skill

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
  qty?: number; // tokens still held — without this, an open position's P&L is unmeasurable
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
  realizedPnlTotalSol?: number;
  unbackedPnlSol?: number; // proceeds from selling tokens with no recorded buy — cash, not measured profit
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
  observed?: WalletObserved; // performance from round trips we watched end to end
  unrealizedSol?: number | null; // open book marked to market by the periodic sweep
  unrealizedCostSol?: number | null;
  lastEventAt?: string | null;
  ownerSiblings?: { address: string; label: string | null }[];
  unrealized?: WalletUnrealized | null; // open book marked to market (detail view only)
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
export const WATCH_CRITERIA = { minWinRate: 0.4, minClosedTokens: 2 }; // measured on OBSERVED round trips, never on historical scans // calibrated for deep (300-tx) windows

/** Unambiguous junk: structural evidence only. HIGH_WINRATE_SUS is suspicion, not proof —
 * it stays a warning (and blocks auto-absorption) but never justifies deletion. */
export const JUNK_FLAGS: WalletFlag[] = ['BOT_INFRA'];

export function isJunkWallet(m: WalletMetrics): boolean {
  return m.flags.some((f) => JUNK_FLAGS.includes(f));
}

/** The whale-quality score: win rate carries most weight, realized PnL the rest, bots slammed to -100. */
/**
 * Score from OBSERVED trades only — round trips we watched end to end.
 *
 * The previous version scored historical PnL from a truncated scan, which
 * booked unbacked sells as pure profit and pushed 36 wallets to the top of the
 * range on 5,685 SOL that was never earned. A wallet we have not watched long
 * enough is `null` (unmeasured), never 0 — absence of evidence was reading as
 * evidence of worthlessness, which is how a 924-buy accumulator scored zero.
 */
export function whaleScore(observed: WalletObserved | undefined, botLike: boolean): number | null {
  if (botLike) return -100;
  if (!observed || observed.trades < MIN_OBSERVED_TRADES || observed.winRate === null) return null;
  return Math.round(observed.winRate * 100 + Math.max(-50, Math.min(200, observed.realizedSol)) / 2);
}

/** Below this a wallet is unmeasured, not unpromising. */
export const MIN_OBSERVED_TRADES = 3;

/** Bot-ish wallets: infrastructure, machine-speed traders, or farmed-looking stats. */
export function isBotWallet(m: WalletMetrics): boolean {
  return m.flags.some((f) => f === 'BOT_INFRA' || f === 'SNIPER_SPEED' || f === 'HIGH_WINRATE_SUS');
}

/**
 * Worth watching: judged on OBSERVED round trips. Historical win rate came from
 * a truncated scan whose unbacked sells all counted as wins, so it promoted
 * measurement error. A wallet with too few observed trades is unqualified —
 * not rejected, just not yet evidence.
 */
export function isQualifyingWallet(m: WalletMetrics, observed?: WalletObserved): boolean {
  if (m.flags.includes('BOT_INFRA')) return false; // plumbing, not a trader
  if (!observed || observed.winRate === null) return false;
  return observed.winRate > WATCH_CRITERIA.minWinRate && observed.trades >= WATCH_CRITERIA.minClosedTokens;
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
  creditsPerIteration: z.coerce.number().min(10).max(50_000).default(8_000), // REAL Helius credits — enhanced calls bill 10 each
  maxTokensChecked: z.coerce.number().min(1).max(200).default(80),
  maxWalletsAbsorbed: z.coerce.number().min(0).max(200).default(50),
  maxWalletsReanalyzed: z.coerce.number().min(0).max(200).default(40),
  discoveryMinSol: z.coerce.number().nonnegative().default(2), // 5 was above the pond — young-token buys run 1-3 SOL
  autoAbsorb: z.boolean().default(true), // false = crawler only reports, never touches the roster
  deepScanNewGems: z.boolean().default(true), // first sighting of a safety-clean gem = whole-life buyer scan
  deepScanBuckets: z.coerce.number().min(12).max(96).default(48),
  minWhaleScore: z.coerce.number().min(-100).max(200).default(40), // absorb every clean buyer at or above this, not just the best
  deepRunCredits: z.coerce.number().min(100).max(500_000).default(60_000), // a deep run chains iterations until this total is spent (real credits)
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
  // Timeout exit. 48h amputated the band the roster earns most from: measured
  // across 7.6k closed roster trades, holds past 24h carry 61% of all profit
  // and 3+ days alone carries 39.7%, with win rate climbing monotonically with
  // hold length (50% under 5 min -> 62% past 3 days). 7 days lets that tail run.
  maxHoldHours: z.coerce.number().min(1).max(720).default(168),
  maxOpenPositions: z.coerce.number().int().min(1).max(50).default(10),
  exitMode: z.enum(['rules', 'mirror', 'mirror-trail']).default('mirror'), // mirror = faithful copy, their exit is our exit; mirror-trail = their exit cuts losers but arms a trailing stop on winners
  ignoreSniperTriggers: z.boolean().default(true), // machine-speed entries are adverse selection at human latency
  maxTotalExposureSol: z.coerce.number().nonnegative().default(1), // portfolio cap across open positions // mirror = sell when the triggering wallet sells; SL+timeout stay as brakes
  followRotations: z.boolean().default(true), // subscribed wallet funds a fresh wallet -> absorb + inherit the sub
  minFundSol: z.coerce.number().nonnegative().default(1),
  // circuit breakers — the book-level brakes the per-position caps can't provide
  maxConsecutiveLosses: z.coerce.number().int().min(1).max(50).default(5), // halt after this many losses in a row
  weeklyLossLimitPct: z.coerce.number().min(1).max(100).default(35), // halt when 7-day realized PnL < -this % of bankroll
  haltClearedAt: z.string().nullable().default(null), // manual resume timestamp — closes before it don't count
  minEdgeRetentionPct: z.coerce.number().min(0).max(100).default(60), // skip triggers whose measured copyability is below this (unmeasured pass)
  trailStopPct: z.coerce.number().min(1).max(50).default(10),
  // How far up before the trail engages. Swept over 242 replayed entries:
  // +20% with a 10% trail and a 50% stop was the most robust setting and the
  // only one with a positive median (+3.3%) and majority win rate (57%).
  trailArmPct: z.coerce.number().min(0).max(100).default(20), // asymmetric mirror: winners trail this far off peak instead of exiting flat
  consensusOwners: z.coerce.number().int().min(0).max(10).default(2), // N distinct owners buying in the live window fires a consensus entry (0 = off)
  tradeSignals: z.enum(['both', 'copy', 'consensus', 'ladder']).default('both'), // which signal kinds may OPEN positions — the feed always shows both
  minMedianHoldMinutes: z.coerce.number().min(0).max(1440).default(15), // trigger wallet's median hold must exceed this — retention(δ/H) is ≤0 for scalpers (0 = off)
  ladderBuys: z.coerce.number().int().min(0).max(50).default(3), // N buys of one mint by one wallet = accumulation in progress (0 = off)
  ladderWindowMinutes: z.coerce.number().min(1).max(120).default(10),
  ladderMinSol: z.coerce.number().min(0).max(100).default(3), // cumulative across the clips, not per clip
  consensusNetFlow: z.boolean().default(true), // buyers must outweigh sellers, not merely outnumber them
  cyclerGuardMinutes: z.coerce.number().min(0).max(120).default(10), // skip a trigger that SOLD this mint within N minutes (0 = off)
  maxPairAgeMinutes: z.coerce.number().min(-1).default(-1), // skip pools older than this; -1 = no ceiling. The inverse of the age FLOOR: on a launch-tier strategy the run happens early, and a maturity gate makes you buy after it
  strategyPreset: z.string().nullable().default(null), // which preset these settings started from — a label, not a lock
});
export type OpportunityConfig = z.infer<typeof OpportunityConfigSchema>;

export interface OpportunityRow {
  id: number;
  kind: 'token' | 'wallet';
  signal?: 'copy' | 'consensus' | 'ladder';
  whalePriceUsd?: number | null;
  marketPriceUsd?: number | null;
  fillGapPct?: number | null; // our quotable price vs the whale's fill, at decision time
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
  signal?: string; // copy | consensus
  wouldBlock?: string | null; // guards that would have blocked this entry
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

/**
 * Observed performance — the only PnL we trust. A trade counts once we have
 * seen its buy AND its sell; anything inherited from a truncated history scan
 * is excluded, because unbacked sells read as pure profit and inflated 36
 * wallets by 5,685 SOL.
 */
export interface WalletObserved {
  realizedSol: number;
  trades: number; // closed round trips we watched end to end
  wins: number;
  winRate: number | null; // null = not enough observed trades to say
}

export interface WalletActivityRow {
  address: string;
  lastEventAt: string | null;
  observedRealizedSol: number;
  observedTrades: number;
  observedWins: number;
}

export interface WalletUnrealized {
  positions: number; // open positions with a held quantity
  priced: number; // how many we could get a live price for — the rest are counted as worthless
  costSol: number;
  valueSol: number;
  pnlSol: number;
  pnlPct: number | null;
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

export interface ShadowGuardStat {
  reason: string;
  open: number;
  closed: number;
  avgPnlPct: number | null; // what the skipped trades did — negative means the guard saved money
  avoidedSol: number; // -sum(pnlSol): positive = the guard earned its keep
  avgPeakPct?: number | null; // best the skipped trades ever showed — what a trailing exit could have caught
}

// ── strategy presets: named starting points, not locks — apply, then tweak ──

export interface StrategyPreset {
  id: string;
  name: string;
  tagline: string;
  opportunity: Partial<OpportunityConfig>;
  thresholds: Partial<TokenCheckThresholds>;
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'swing-copy',
    name: 'Swing Copy',
    tagline: 'follow patient whales into proven pools — the copyability sweet spot',
    opportunity: { minBuySol: 5, minMedianHoldMinutes: 60, exitMode: 'mirror', sizingMode: 'whale-frac', tradeSignals: 'copy', consensusOwners: 0, allowWarn: false, maxPairAgeMinutes: -1, maxHoldHours: 336 },
    thresholds: { minLiquidityUsd: 100_000, minMarketCapUsd: 200_000, minTokenAgeMinutes: 60 },
  },
  {
    id: 'launch-surf',
    name: 'Launch Surf',
    tagline: 'young thin pools, skip anything over an hour old, trail the winners — high variance by design',
    opportunity: { minBuySol: 5, minMedianHoldMinutes: 15, exitMode: 'mirror-trail', sizingMode: 'whale-frac', tradeSignals: 'both', consensusOwners: 2, allowWarn: false, maxPairAgeMinutes: 60, maxHoldHours: 168 },
    thresholds: { minLiquidityUsd: 25_000, minMarketCapUsd: 50_000, minTokenAgeMinutes: 20 },
  },
  {
    id: 'measured-mirror',
    name: 'Measured Mirror',
    tagline: 'the only exit settings that survived a sample tripling — their exit, capped by a tight trail',
    /**
     * Not a guess and not a grid winner: every value here held its ranking when
     * the backtest sample grew from 51 to 170 mirror paths and 249 to 445 rule
     * paths. That filter matters — `exit @240m` looked like the best rule on
     * the small sample (+33.7%) and inverted to -13.8% on the larger one.
     *
     * Measured on 170 paths with a recorded whale exit, all entries:
     *   mirror alone        +9.7% avg ·  0.0% median · 47% wins · worst -95%
     *   mirror-trail 10/20 +10.2% avg ·  4.9% median · 57% wins · worst -30%
     * Same mean, but the trail converts a -95% tail into -30% and adds ten
     * points of win rate. The whale says when to leave; the trail says when
     * not to wait for them.
     *
     * stopLossPct 30 is the single most robust number in the whole study:
     * monotonic across all 1,225 combinations, reproduced independently on
     * hourly bars, and it survives dropping the three best test trades — so it
     * is not a tail artifact. Looser stops score worse at every step.
     *
     * trailStopPct 10 beat 15/20/25/30/40/50 on held-out marginals.
     * trailArmPct 20 sits within noise of 50; left at 20 because a higher arm
     * leaves more of the run uninsured, which is how a 14x was once held for
     * nine seconds and closed red.
     */
    opportunity: {
      exitMode: 'mirror-trail',
      trailStopPct: 10,
      trailArmPct: 20,
      stopLossPct: 30,
      takeProfitPct: 100, // inert in mirror-trail; kept at the most robust value in case exitMode moves to 'rules'
      maxHoldHours: 168,
      minBuySol: 1.5,
      minMedianHoldMinutes: 15,
      sizingMode: 'whale-frac',
      tradeSignals: 'both',
      consensusOwners: 2,
      allowWarn: false,
      maxPairAgeMinutes: -1,
    },
    thresholds: { minLiquidityUsd: 25_000, minMarketCapUsd: 50_000, minTokenAgeMinutes: 20 },
  },
  {
    id: 'gauntlet-only',
    name: 'Gauntlet Only',
    tagline: 'no signal filters at all — if the token survives the gauntlet, we copy the buy',
    // Deliberately empty of entry gates: every conviction/breadth/age/cadence
    // filter is off, so the gauntlet is the ONLY thing standing between a whale
    // buy and a position. The control arm for every other preset — if a filter
    // is worth its exclusions, it has to beat this.
    // Exits stay armed: they are risk management, not signal selection.
    opportunity: {
      minBuySol: 0,
      minMedianHoldMinutes: 0,
      consensusOwners: 0,
      ladderBuys: 0,
      cyclerGuardMinutes: 0,
      minEdgeRetentionPct: 0,
      maxPairAgeMinutes: -1,
      ignoreSniperTriggers: false,
      allowWarn: false, // the one gate that stays: the gauntlet must actually pass
      tradeSignals: 'copy',
      // EXITS ARE IDENTICAL TO 'Measured Mirror' ON PURPOSE. This preset is the
      // control arm for the entry filters, so entry must be the only thing that
      // differs — change the exits too and a difference in results tells you
      // nothing about which half caused it.
      exitMode: 'mirror-trail',
      trailStopPct: 10,
      trailArmPct: 20,
      stopLossPct: 30,
      sizingMode: 'whale-frac',
      maxHoldHours: 168,
    },
    thresholds: { minLiquidityUsd: 25_000, minMarketCapUsd: 50_000, minTokenAgeMinutes: 20 },
  },
  {
    id: 'consensus-chorus',
    name: 'Consensus Chorus',
    tagline: 'enter only when distinct owners agree — breadth over any single wallet',
    opportunity: { minBuySol: 5, minMedianHoldMinutes: 15, exitMode: 'mirror-trail', sizingMode: 'whale-frac', tradeSignals: 'consensus', consensusOwners: 2, allowWarn: false, maxPairAgeMinutes: -1, maxHoldHours: 168 },
    thresholds: { minLiquidityUsd: 25_000, minMarketCapUsd: 50_000, minTokenAgeMinutes: 20 },
  },
];

export interface ConvictionCohortRow {
  cohort: string; // "1-5" | "6-10" | "11-20" | "control"
  snapshots: number;
  resolved6h: number;
  avgRet6hPct: number | null;
  medianRet6hPct: number | null;
  resolved24h: number;
  avgRet24hPct: number | null;
  medianRet24hPct: number | null;
}

// ── roster flows: laddering in and out, both directions ──

export interface FlowRow {
  mint: string;
  symbol: string | null;
  owners: number; // distinct owners (clustered wallets count once)
  wallets: number;
  clips: number; // repeated trades are the signature — one buy is an event, twenty is a decision
  sol: number; // gross in this direction
  netSol: number; // minus the opposite direction, so churn cancels out
}

export interface RosterFlows {
  minutes: number;
  accumulating: FlowRow[]; // laddering IN — an entry signal
  distributing: FlowRow[]; // laddering OUT — the exit signal mirror exits cannot see
}

// ── backtest: score exit rules against each other on real whale entries ──

export interface BacktestStrategyRow {
  strategy: string;
  trades: number;
  avgRetPct: number;
  medianRetPct: number; // with fat tails the mean and median disagree — both matter
  winRate: number;
  bestPct: number;
  worstPct: number;
}

export interface BacktestResult {
  ranAt: string;
  sampled: number;
  replayed: number; // entries with usable candle data
  strategies: BacktestStrategyRow[];
}

export interface BacktestTuneRow {
  trailPct: number;
  armAtPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trainAvgPct: number; // what the search optimised
  testAvgPct: number; // held-out — the only number that means anything
  testMedianPct: number;
  testWinRate: number;
}

/**
 * A parameter VALUE averaged across every combination containing it. With a
 * small sample the single best combination is mostly luck; a value that holds
 * up across all its combinations is a real effect.
 */
export interface BacktestMarginal {
  param: string;
  value: number;
  combos: number;
  avgTestPct: number;
}

export interface BacktestTuneResult {
  ranAt: string;
  paths: number; // cached entries searched over
  tried: number; // exhaustive over the discrete grid
  best: BacktestTuneRow[];
  marginals: BacktestMarginal[];
}

/** Roster trades bucketed by how long they were held — where the profit lives. */
export interface HoldBand {
  band: string;
  trades: number;
  pnlSol: number;
  shareOfPnlPct: number;
  winRate: number;
}
