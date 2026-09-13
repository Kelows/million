import { Injectable } from '@nestjs/common';
import {
  CrawlerConfigSchema,
  isExcludedToken,
  OpportunityConfigSchema,
  type OpportunityConfig,
  type OpportunityRow,
  type WalletMetrics,
} from '@million/shared';
import { PrismaService } from '../prisma.service';
import { TokenCheckService } from '../screener/token-check.service';
import { TradingService } from '../trading/trading.service';
import { HeliusService } from '../analysis/helius.service';
import { EventsBus } from '../common/events.bus';
import { ShadowService } from '../trading/shadow.service';
import { DecisionLog } from '../common/decision-log';
import { DexScreenerService } from '../analysis/dexscreener.service';

// Anti-spam, not anti-signal: measured on the roster's real tapes, 43% of whale
// entries are RE-entries and 93/95 of them come within 24h of the close (median
// 12 min) — a day-long mint dedupe was silently discarding half the signal and
// all of the cross-wallet consensus. One hour bounds gauntlet load; the 15-min
// live-event recency gate already filters machine-speed flip churn.
const DEDUPE_MINUTES = 60;

/**
 * An opportunity: a subbed wallet buys a pair that is NEW for that wallet
 * (recency is the signal — stale opens are noise), sized at least minBuySol,
 * and the token survives the gauntlet (PASS, or WARN when allowed).
 * Fed by the live websocket; consumed by the Opportunities page — and later
 * by the paper trader.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCheck: TokenCheckService,
    private readonly trading: TradingService,
    private readonly helius: HeliusService,
    private readonly bus: EventsBus,
    private readonly shadow: ShadowService,
    private readonly dexscreener: DexScreenerService,
    private readonly decisions: DecisionLog,
  ) {}

  async getConfig(): Promise<OpportunityConfig> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
  }

  async setConfig(config: OpportunityConfig): Promise<OpportunityConfig> {
    await this.prisma.opportunityConfig.upsert({
      where: { id: 1 },
      create: { id: 1, data: JSON.stringify(config) },
      update: { data: JSON.stringify(config) },
    });
    return config;
  }

  async list(limit = 50): Promise<OpportunityRow[]> {
    const rows = await this.prisma.opportunity.findMany({ orderBy: { id: 'desc' }, take: limit });
    const wallets = await this.prisma.wallet.findMany({
      where: { address: { in: [...new Set(rows.flatMap((r) => [r.wallet, r.funder].filter((x): x is string => Boolean(x))))] } },
      select: { address: true, label: true },
    });
    const labels = new Map(wallets.map((w) => [w.address, w.label]));
    return rows.map((r) => ({
      id: r.id,
      kind: (r.kind as OpportunityRow['kind']) ?? 'token',
      signal: (r.signal as OpportunityRow['signal']) ?? 'copy',
      whalePriceUsd: r.whalePriceUsd,
      marketPriceUsd: r.marketPriceUsd,
      fillGapPct: r.fillGapPct,
      mint: r.mint,
      symbol: r.symbol,
      wallet: r.wallet,
      walletLabel: labels.get(r.wallet) ?? null,
      funder: r.funder,
      funderLabel: r.funder ? (labels.get(r.funder) ?? null) : null,
      verdict: r.verdict as OpportunityRow['verdict'],
      buySol: r.buySol,
      ts: r.ts.toISOString(),
    }));
  }

  /** Owner rotation: a subscribed wallet funds a FRESH unknown wallet — absorb it
   * and surface it as a wallet-kind opportunity. It is NOT subscribed: absorbing
   * is a note that the wallet exists, not a decision to stream it. */
  async evaluateRotation(funder: string, recipient: string, fundedSol: number, ts: Date): Promise<void> {
    const config = await this.getConfig();
    if (!config.followRotations || fundedSol < config.minFundSol) return;
    const known = await this.prisma.wallet.findUnique({ where: { address: recipient } });
    if (known) return; // already tracked (or already rejected)
    // freshness: a rotation target has a thin history; hubs/exchanges have thousands
    const sigs = await this.helius.signatureIndex(recipient, 0, 1).catch(() => null);
    if (!sigs || sigs.length > 50) return;
    await this.prisma.wallet.create({
      // absorbed, NOT subscribed: an unanalyzed wallet in the feed is a blank
      // cheque — one spray bot inherited a sub overnight and burned 300k credits.
      // Analysis first, subscription only once it proves it trades.
      data: { address: recipient, source: 'owner-rotation', subscribed: false },
    }).catch(() => undefined);
    await this.prisma.opportunity.create({
      data: { kind: 'wallet', mint: null, wallet: recipient, funder, verdict: 'unknown', buySol: Math.round(fundedSol * 100) / 100, ts },
    }).catch(() => undefined);
    this.decisions.push(`[opps] ROTATION ${funder.slice(0, 6)}… funded fresh wallet ${recipient.slice(0, 6)}… with ${fundedSol.toFixed(1)}◎ — absorbed`);
    this.bus.emit('opportunity');
  }

  /** Called by the live feed for every ingested buy. Cheap checks first, gauntlet last. */
  async evaluate(wallet: string, mint: string, buySol: number, ts: Date, eventId: number, whalePriceUsd: number | null = null): Promise<void> {
    const config = await this.getConfig();
    const skip = (code: string, reason: string) => this.decisions.record({ mint, wallet, stage: 'signal', outcome: 'skip', code, reason });
    // Audited guards DEFER rather than return: a phantom must mean "this would
    // have been a real trade", so the signal keeps walking the gates (gauntlet
    // included) and the shadow is only recorded if everything else passed.
    // First blocker owns the attribution.
    let blockedBy: string | null = null;
    let blockedWhy: string | null = null;
    // A guard turned OFF still computes its verdict and records it here, so one
    // run yields within-sample attribution: "how did the trades cycler would
    // have blocked actually do?" — far cheaper than sequential experiments.
    const wouldBlock: string[] = [];
    // EVERY objection, enabled or not — first-blocker-wins hides overlap, and
    // overlap is the question: are two guards refusing the same signals, or
    // different ones? Purely observational; the block decision is unchanged.
    const objections: string[] = [];
    const block = (reason: string, why: string, enabled = true) => {
      objections.push(reason);
      if (!enabled) { wouldBlock.push(reason); return; }
      if (!blockedBy) { blockedBy = reason; blockedWhy = why; } // recorded as a shadow once every other gate has had its say
    };
    // FIX: machine-speed triggers are adverse selection at human latency
    if (config.ignoreSniperTriggers) {
      const trigRow = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true } });
      if (trigRow?.metrics && (JSON.parse(trigRow.metrics) as WalletMetrics).flags.includes('SNIPER_SPEED'))
        block('sniper-flag', 'trigger wallet is SNIPER_SPEED');
    }
    if (isExcludedToken(mint)) return; // majors/stables — silent, uninteresting

    // CUMULATIVE detectors run before the per-clip floor. minBuySol asks "is
    // this one buy big enough to mean something", which is the wrong question
    // for accumulation: the measured ladderers use ~1.4 SOL clips, so a 1.5
    // floor hid every one of them from the detector built to find them. These
    // two judge the total, and carry their own floors.
    const cumulativeFired =
      (await this.tryConsensus(mint, wallet, buySol, ts, config).catch(() => false)) ||
      (await this.tryLadder(mint, wallet, buySol, ts, config).catch(() => false));
    // A cumulative signal has already spoken for this token, on better evidence
    // than one clip's size. Stop here rather than letting the copy path run its
    // gates and die on the hourly dedupe — the suppression should be intentional,
    // not a side effect of another rule we might tune later.
    if (cumulativeFired) return;

    // from here the COPY path only: one buy, judged on its own size
    if (buySol < config.minBuySol) {
      // the most common exit by far, so it is recorded as quiet: hidden by default, one click away
      this.decisions.record({
        mint, wallet, stage: 'signal', outcome: 'skip', code: 'below-min-size', quiet: true,
        reason: `${buySol.toFixed(2)} ◎ buy. A copy needs ${config.minBuySol} ◎, and it doesn't add up to a consensus or ladder signal yet`,
      });
      return;
    }


    // recency: must be NEW for this wallet — no prior live buy, not in its analyzed history
    const priorLive = await this.prisma.liveEvent.findFirst({
      where: { wallet, mint, kind: 'buy', id: { lt: eventId } },
      select: { id: true },
    });
    if (priorLive) return skip('prior-buy', 'this wallet already bought it earlier, so this is a top-up, not a new entry');
    // cycler guard: a wallet that SOLD this mint minutes ago isn't entering, it's
    // ping-ponging — copying a seconds-scale scalp cycle means buying their
    // impact spike and selling into their dump. Their profit, our fee.
    const recentSell = await this.prisma.liveEvent.findFirst({
      where: { wallet, mint, kind: 'sell', ts: { gte: new Date(Date.now() - (config.cyclerGuardMinutes || 10) * 60_000) } },
      select: { id: true },
    });
    if (recentSell) block('cycler', 'sold this mint <10min ago — mid scalp cycle', config.cyclerGuardMinutes > 0);
    const walletRow = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true, copyability: true } });
    // copyability gate: the one measured trigger below threshold went 0-for-3 as
    // predicted — a whale whose edge dies inside our latency is unfollowable no
    // matter the score. Unmeasured wallets pass; coverage grows with each run.
    if (walletRow?.copyability) {
      const cop = JSON.parse(walletRow.copyability) as { edgeRetentionPct: number | null };
      if (cop.edgeRetentionPct !== null && cop.edgeRetentionPct < config.minEdgeRetentionPct)
        block('copyability', `copyability ${Math.round(cop.edgeRetentionPct)}% < ${config.minEdgeRetentionPct}%`);
    }
    if (walletRow?.metrics) {
      const m = JSON.parse(walletRow.metrics) as WalletMetrics;
      if ((m.flags ?? []).includes('BOT_INFRA')) return skip('bot-infra', 'the buyer is flagged as bot or infrastructure: its moves are inventory, not a signal'); // inventory moves, never signal
      // retention(δ/H) is ≤0 when the wallet's holds are shorter than our latency
      // horizon — H is a property of the trader, so gate on their median hold
      // reference bar when disabled, so the counterfactual stays measurable
      const holdBar = config.minMedianHoldMinutes > 0 ? config.minMedianHoldMinutes : 15;
      if (m.medianHoldMinutes !== null && m.medianHoldMinutes < holdBar)
        block('median-hold', `median hold ${Math.round(m.medianHoldMinutes)}m < ${holdBar}m`, config.minMedianHoldMinutes > 0);
      // still holding = a top-up, not news. A CLOSED position re-entered is the
      // whale's next trade — for active roster wallets that's 43% of all entries.
      if (m.tokens.some((t) => t.mint === mint && t.open)) return skip('already-holds', 'the buyer already held this token, so this is a top-up, not a new entry');
    }

    await this.fire(mint, wallet, buySol, ts, 'copy', config, whalePriceUsd, blockedBy, wouldBlock, objections, blockedWhy);
  }

  /**
   * Consensus entries: cyclers and top-ups can't fire direct copies, but their
   * buys still VOTE. N distinct owners (cluster-deduped) buying ≥ minBuySol
   * inside the live window is breadth no single wallet can fake — that's a
   * signal in its own right, labeled so expectancy splits by entry logic.
   */
  private async tryConsensus(mint: string, wallet: string, buySol: number, ts: Date, config: OpportunityConfig): Promise<boolean> {
    if (config.consensusOwners < 1) return false;
    const events = await this.prisma.liveEvent.findMany({
      where: { mint, kind: { in: ['buy', 'sell'] } },
      select: { wallet: true, sol: true, usd: true, kind: true },
    });
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
    const sellers = new Set(events.filter((e) => e.kind === 'sell').map((e) => e.wallet));
    // net buyers only, USD legs counted: a ping-ponging wallet is churn, not conviction
    const voters = [
      ...new Set(
        events
          .filter((e) => e.kind === 'buy' && !sellers.has(e.wallet))
          .filter((e) => Math.abs(e.sol ?? 0) + Math.abs(e.usd ?? 0) / solUsd >= config.minBuySol)
          .map((e) => e.wallet),
      ),
    ];
    if (voters.length < config.consensusOwners) return false;
    // Breadth is not agreement. On fone two wallets bought ~5 SOL between them
    // while others dumped ~77 SOL seconds earlier — consensus fired, and we
    // bought the exit liquidity of the whale we were copying. Buyers must
    // outweigh sellers, not merely outnumber them.
    if (config.consensusNetFlow) {
      const flow = (kind: string) =>
        events.filter((e) => e.kind === kind).reduce((sum, e) => sum + Math.abs(e.sol ?? 0) + Math.abs(e.usd ?? 0) / solUsd, 0);
      const bought = flow('buy');
      const sold = flow('sell');
      if (sold >= bought) {
        this.decisions.record({
          mint, wallet, stage: 'signal', outcome: 'skip', code: 'consensus-distribution',
          reason: `${voters.length} wallets bought, but ${sold.toFixed(1)} ◎ was sold against ${bought.toFixed(1)} ◎ bought: distribution, not agreement`,
        });
        return false;
      }
    }
    const rows = await this.prisma.wallet.findMany({ where: { address: { in: voters } }, select: { address: true, ownerId: true } });
    const owners = new Set(rows.map((r) => (r.ownerId != null ? `o${r.ownerId}` : r.address)));
    if (owners.size < config.consensusOwners) return false;
    await this.fire(mint, wallet, buySol, ts, 'consensus', config, null);
    return true;
  }

  /**
   * A wallet buying one mint repeatedly is accumulating, not repeating itself.
   * The per-wallet novelty gates below treat clips 2..N as "continuation, not
   * news" and discard exactly the pattern that identifies the behaviour — so
   * this runs before them, and judges the cumulative position, not the clip.
   */
  private async tryLadder(mint: string, wallet: string, buySol: number, ts: Date, config: OpportunityConfig): Promise<boolean> {
    if (config.ladderBuys < 1) return false;
    const since = new Date(Date.now() - config.ladderWindowMinutes * 60_000);
    const clips = await this.prisma.liveEvent.findMany({
      where: { wallet, mint, kind: 'buy', ts: { gte: since } },
      select: { sol: true, usd: true },
    });
    if (clips.length < config.ladderBuys) return false;
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
    const cumulative = clips.reduce((sum, c) => sum + Math.abs(c.sol ?? 0) + Math.abs(c.usd ?? 0) / solUsd, 0);
    if (cumulative < config.ladderMinSol) return false;
    // a wallet that also SOLD this mint in the window is cycling, not accumulating
    const sold = await this.prisma.liveEvent.findFirst({ where: { wallet, mint, kind: 'sell', ts: { gte: since } }, select: { id: true } });
    if (sold) return false;
    this.decisions.push(`[opps] LADDER ${mint.slice(0, 6)}... ${wallet.slice(0, 6)}...: ${clips.length} clips, ${cumulative.toFixed(1)} SOL in ${config.ladderWindowMinutes}m`);
    await this.fire(mint, wallet, cumulative, ts, 'ladder', config, null);
    return true;
  }

  /** Shared trigger tail: hourly mint dedupe → gauntlet → opportunity row → paper trade. */
  private async fire(
    mint: string,
    wallet: string,
    buySol: number,
    ts: Date,
    signal: 'copy' | 'consensus' | 'ladder',
    config: OpportunityConfig,
    whalePriceUsd: number | null,
    blockedBy: string | null = null,
    wouldBlock: string[] = [],
    objections: string[] = [],
    blockedWhy: string | null = null,
  ): Promise<void> {
    // dedupe: one opportunity per token per hour, whoever (and whichever signal) triggers it
    const recent = await this.prisma.opportunity.findFirst({
      where: { mint, createdAt: { gte: new Date(Date.now() - DEDUPE_MINUTES * 60_000) } },
      select: { id: true },
    });
    if (recent) {
      this.decisions.record({ mint, wallet, stage: 'signal', outcome: 'skip', code: 'dedupe', reason: `${signal} signal, but this token was already signalled in the last hour` });
      return;
    }

    // the gauntlet decides — thresholds come from the crawler config (one source of truth)
    const crawlerRow = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } });
    const thresholds = CrawlerConfigSchema.parse(crawlerRow ? JSON.parse(crawlerRow.data) : {}).thresholds;
    const report = await this.tokenCheck.check(mint, thresholds).catch(() => null);
    // keep the verdict: a token that traded on a PASS used to show "Not checked
    // yet" on its own page, because only the manual check stored its report
    if (report) {
      await this.prisma.token
        .upsert({
          where: { mint },
          create: { mint, symbol: report.symbol, name: report.name, source: 'opportunity', lastCheckedAt: new Date(), lastReport: JSON.stringify(report) },
          update: { symbol: report.symbol ?? undefined, name: report.name ?? undefined, lastCheckedAt: new Date(), lastReport: JSON.stringify(report) },
        })
        .catch(() => undefined);
    }
    if (!report) {
      this.decisions.record({ mint, wallet, stage: 'gauntlet', outcome: 'skip', code: 'gauntlet-error', reason: `${signal} signal, but the token checks could not run (a data source failed)` });
      return;
    }
    const allowed = report.verdict === 'pass' || (config.allowWarn && report.verdict === 'warn');
    if (!allowed) {
      const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.label).join(', ');
      const warnOnly = report.verdict === 'warn' && !config.allowWarn;
      this.decisions.record({
        mint, symbol: report.symbol, wallet, stage: 'gauntlet', outcome: 'skip', code: warnOnly ? 'gauntlet-warn' : 'gauntlet',
        reason: warnOnly
          ? `${signal} signal, but the token checks came back WARN and your rules only allow PASS`
          : `${signal} signal, but the token checks came back ${report.verdict.toUpperCase()}${failed ? `: ${failed}` : ''}`,
      });
      return;
    }

    // EXECUTION floor. The gauntlet's liquidity check answers "is this token
    // real"; this answers "can we actually fill at the price we are about to
    // record". Thin pools fail the second even when they pass the first: the
    // whale's own buy spikes the quote, we book the spike, and it reverts
    // within a minute — five of seven such fills stopped out inside 60 seconds.
    if (config.minTradeLiquidityUsd >= 0 && (report.liquidityUsd ?? 0) < config.minTradeLiquidityUsd) {
      this.decisions.record({
        mint, symbol: report.symbol, wallet, stage: 'execution', outcome: 'skip', code: 'thin-pool',
        reason: `${signal} signal, but the pool is too thin to fill: $${Math.round(report.liquidityUsd ?? 0).toLocaleString('en-US')} liquidity, your floor is $${config.minTradeLiquidityUsd.toLocaleString('en-US')}`,
      });
      return;
    }

    // pair-age ceiling: on a launch strategy the run happens in the first
    // minutes, so an old pool means the move already belongs to someone else
    if (config.maxPairAgeMinutes >= 0 && report.pairCreatedAt) {
      const ageMinutes = (Date.now() - new Date(report.pairCreatedAt).getTime()) / 60_000;
      if (ageMinutes > config.maxPairAgeMinutes && !blockedBy) {
        blockedBy = 'pair-too-old';
        blockedWhy = `the pool is ${Math.round(ageMinutes)} minutes old and your ceiling is ${config.maxPairAgeMinutes}`;
      }
    }

    // impact gate: a buy that IS a meaningful share of the pool means the whale's
    // fill was mostly their own footprint — impact-alpha is zero-sum against copiers
    if (report.liquidityUsd && report.liquidityUsd > 0) {
      const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
      const impactPct = ((buySol * solUsd) / report.liquidityUsd) * 100;
      if (impactPct > 5) objections.push('impact');
      if (impactPct > 5 && !blockedBy) {
        blockedBy = 'impact';
        blockedWhy = `the buy was ${impactPct.toFixed(1)}% of the pool, so its price was mostly its own footprint`;
      }
    }

    // the honest counterfactual: everything else passed, so this WOULD have
    // traded — the phantom is now a fair test of the guard that stopped it
    if (blockedBy) {
      this.shadow.record(mint, report.symbol, wallet, blockedBy, objections.join(','));
      this.decisions.record({
        mint, symbol: report.symbol, wallet, stage: 'execution', outcome: 'shadow', code: blockedBy,
        reason: `${signal} signal passed everything else, but ${blockedWhy ?? blockedBy}. Tracked as a shadow position to test that rule`,
      });
      return;
    }

    // Record BOTH prices at decision time, not just the verdict they produced.
    // A stale feed and a genuine price spike are indistinguishable afterwards
    // unless the quote we actually saw is stored alongside the whale's fill.
    const marketPriceUsd = report.priceUsd ?? null;
    const fillGapPct =
      whalePriceUsd && marketPriceUsd ? Math.round((marketPriceUsd / whalePriceUsd - 1) * 1000) / 10 : null;
    await this.prisma.opportunity.create({
      data: {
        mint,
        symbol: report.symbol,
        wallet,
        verdict: report.verdict,
        buySol: Math.round(buySol * 100) / 100,
        ts,
        signal,
        whalePriceUsd,
        marketPriceUsd,
        fillGapPct,
      },
    });
    this.decisions.record({
      mint, symbol: report.symbol, wallet, stage: 'signal', outcome: 'fired', code: signal,
      reason: `${signal} signal: ${buySol.toFixed(2)} ◎ bought, token checks ${report.verdict.toUpperCase()}`,
    });
    this.bus.emit('opportunity');
    // every opportunity is also a (paper) trade — this is where expectancy data comes from
    void this.trading.openFromOpportunity(mint, report.symbol, wallet, whalePriceUsd, buySol, signal, wouldBlock.join(',')).catch(() => undefined);
  }
}
