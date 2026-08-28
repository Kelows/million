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

  /** Owner rotation: a subscribed wallet funds a FRESH unknown wallet — absorb it,
   * inherit the subscription, and surface it as a wallet-kind opportunity. */
  async evaluateRotation(funder: string, recipient: string, fundedSol: number, ts: Date): Promise<void> {
    const config = await this.getConfig();
    if (!config.followRotations || fundedSol < config.minFundSol) return;
    const known = await this.prisma.wallet.findUnique({ where: { address: recipient } });
    if (known) return; // already tracked (or already rejected)
    // freshness: a rotation target has a thin history; hubs/exchanges have thousands
    const sigs = await this.helius.signatureIndex(recipient, 0, 1).catch(() => null);
    if (!sigs || sigs.length > 50) return;
    const funderRow = await this.prisma.wallet.findUnique({ where: { address: funder }, select: { subscribed: true, label: true } });
    await this.prisma.wallet.create({
      data: { address: recipient, source: 'owner-rotation', subscribed: funderRow?.subscribed ?? false },
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
    const skip = (why: string) => this.decisions.push(`[opps] skip ${mint.slice(0, 6)}… (${wallet.slice(0, 6)}…, ${buySol.toFixed(1)}◎): ${why}`);
    // Audited guards DEFER rather than return: a phantom must mean "this would
    // have been a real trade", so the signal keeps walking the gates (gauntlet
    // included) and the shadow is only recorded if everything else passed.
    // First blocker owns the attribution.
    let blockedBy: string | null = null;
    const block = (reason: string, why: string) => {
      if (!blockedBy) { blockedBy = reason; skip(why); }
    };
    if (buySol < config.minBuySol) return; // silent — fires on most events, would drown the log
    // FIX: machine-speed triggers are adverse selection at human latency
    if (config.ignoreSniperTriggers) {
      const trigRow = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true } });
      if (trigRow?.metrics && (JSON.parse(trigRow.metrics) as WalletMetrics).flags.includes('SNIPER_SPEED'))
        block('sniper-flag', 'trigger wallet is SNIPER_SPEED');
    }
    if (isExcludedToken(mint)) return; // majors/stables — silent, uninteresting

    // consensus voting happens BEFORE the per-wallet novelty gates: a top-up or
    // repeat buy can't fire a direct copy, but it still counts toward breadth
    await this.tryConsensus(mint, wallet, buySol, ts, config).catch(() => undefined);

    // recency: must be NEW for this wallet — no prior live buy, not in its analyzed history
    const priorLive = await this.prisma.liveEvent.findFirst({
      where: { wallet, mint, kind: 'buy', id: { lt: eventId } },
      select: { id: true },
    });
    if (priorLive) return skip('prior live buy in window — continuation, not news');
    // cycler guard: a wallet that SOLD this mint minutes ago isn't entering, it's
    // ping-ponging — copying a seconds-scale scalp cycle means buying their
    // impact spike and selling into their dump. Their profit, our fee.
    const recentSell = await this.prisma.liveEvent.findFirst({
      where: { wallet, mint, kind: 'sell', ts: { gte: new Date(Date.now() - 10 * 60_000) } },
      select: { id: true },
    });
    if (recentSell) block('cycler', 'sold this mint <10min ago — mid scalp cycle');
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
      if ((m.flags ?? []).includes('BOT_INFRA')) return skip('trigger wallet is BOT_INFRA'); // inventory moves, never signal
      // retention(δ/H) is ≤0 when the wallet's holds are shorter than our latency
      // horizon — H is a property of the trader, so gate on their median hold
      if (config.minMedianHoldMinutes > 0 && m.medianHoldMinutes !== null && m.medianHoldMinutes < config.minMedianHoldMinutes)
        block('median-hold', `median hold ${Math.round(m.medianHoldMinutes)}m < ${config.minMedianHoldMinutes}m`);
      // still holding = a top-up, not news. A CLOSED position re-entered is the
      // whale's next trade — for active roster wallets that's 43% of all entries.
      if (m.tokens.some((t) => t.mint === mint && t.open)) return skip('whale already holds it (per metrics) — top-up');
    }

    await this.fire(mint, wallet, buySol, ts, 'copy', config, whalePriceUsd, blockedBy);
  }

  /**
   * Consensus entries: cyclers and top-ups can't fire direct copies, but their
   * buys still VOTE. N distinct owners (cluster-deduped) buying ≥ minBuySol
   * inside the live window is breadth no single wallet can fake — that's a
   * signal in its own right, labeled so expectancy splits by entry logic.
   */
  private async tryConsensus(mint: string, wallet: string, buySol: number, ts: Date, config: OpportunityConfig): Promise<void> {
    if (config.consensusOwners < 1) return;
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
    if (voters.length < config.consensusOwners) return;
    const rows = await this.prisma.wallet.findMany({ where: { address: { in: voters } }, select: { address: true, ownerId: true } });
    const owners = new Set(rows.map((r) => (r.ownerId != null ? `o${r.ownerId}` : r.address)));
    if (owners.size < config.consensusOwners) return;
    await this.fire(mint, wallet, buySol, ts, 'consensus', config, null);
  }

  /** Shared trigger tail: hourly mint dedupe → gauntlet → opportunity row → paper trade. */
  private async fire(
    mint: string,
    wallet: string,
    buySol: number,
    ts: Date,
    signal: 'copy' | 'consensus',
    config: OpportunityConfig,
    whalePriceUsd: number | null,
    blockedBy: string | null = null,
  ): Promise<void> {
    // fresh-entry gate (preset knob): the trigger must be the roster's FIRST
    // owner into this mint. If our whales already hold it, the story is
    // mid-flight — we'd be buying the crowd's position, not the discovery.
    if (config.freshEntriesOnly) {
      const holders = await this.prisma.wallet.findMany({
        where: { metrics: { contains: mint }, purgedAt: null },
        select: { address: true, metrics: true },
      });
      const held = holders.some((w) => {
        if (w.address === wallet) return false; // the trigger's own (stale) position doesn't count against them
        const m = JSON.parse(w.metrics as string) as WalletMetrics;
        return m.tokens.some((t) => t.mint === mint && t.open);
      });
      if (held && !blockedBy) {
        blockedBy = 'roster-fresh';
        this.decisions.push(`[opps] skip ${mint.slice(0, 6)}… (${signal}): roster already holds this — not a fresh discovery`);
      }
    }

    // dedupe: one opportunity per token per hour, whoever (and whichever signal) triggers it
    const recent = await this.prisma.opportunity.findFirst({
      where: { mint, createdAt: { gte: new Date(Date.now() - DEDUPE_MINUTES * 60_000) } },
      select: { id: true },
    });
    if (recent) {
      this.decisions.push(`[opps] skip ${mint.slice(0, 6)}… (${signal}): opportunity already fired for this mint <1h ago`);
      return;
    }

    // the gauntlet decides — thresholds come from the crawler config (one source of truth)
    const crawlerRow = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } });
    const thresholds = CrawlerConfigSchema.parse(crawlerRow ? JSON.parse(crawlerRow.data) : {}).thresholds;
    const report = await this.tokenCheck.check(mint, thresholds).catch(() => null);
    if (!report) return;
    const allowed = report.verdict === 'pass' || (config.allowWarn && report.verdict === 'warn');
    if (!allowed) {
      const failed = report.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(',');
      this.decisions.push(`[opps] skip ${report.symbol ?? mint.slice(0, 6)} (${signal}): gauntlet ${report.verdict}${failed ? ` [${failed}]` : ''}`);
      return;
    }

    // impact gate: a buy that IS a meaningful share of the pool means the whale's
    // fill was mostly their own footprint — impact-alpha is zero-sum against copiers
    if (report.liquidityUsd && report.liquidityUsd > 0) {
      const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);
      const impactPct = ((buySol * solUsd) / report.liquidityUsd) * 100;
      if (impactPct > 5 && !blockedBy) {
        blockedBy = 'impact';
        this.decisions.push(`[opps] skip ${report.symbol ?? mint.slice(0, 6)} (${signal}): whale's ${buySol.toFixed(1)}◎ is ${impactPct.toFixed(1)}% of the pool — their fill is their own footprint`);
      }
    }

    // the honest counterfactual: everything else passed, so this WOULD have
    // traded — the phantom is now a fair test of the guard that stopped it
    if (blockedBy) {
      this.shadow.record(mint, report.symbol, wallet, blockedBy);
      return;
    }

    await this.prisma.opportunity.create({
      data: { mint, symbol: report.symbol, wallet, verdict: report.verdict, buySol: Math.round(buySol * 100) / 100, ts, signal },
    });
    this.decisions.push(`[opps] FIRED ${report.symbol ?? mint.slice(0, 6)} (${signal}) — ${buySol.toFixed(1)}◎ by ${wallet.slice(0, 6)}…, verdict ${report.verdict}`);
    this.bus.emit('opportunity');
    // every opportunity is also a (paper) trade — this is where expectancy data comes from
    void this.trading.openFromOpportunity(mint, report.symbol, wallet, whalePriceUsd, buySol, signal).catch(() => undefined);
  }
}
