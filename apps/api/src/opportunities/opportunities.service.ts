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

const DEDUPE_HOURS = 24;

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
    this.bus.emit('opportunity');
  }

  /** Called by the live feed for every ingested buy. Cheap checks first, gauntlet last. */
  async evaluate(wallet: string, mint: string, buySol: number, ts: Date, eventId: number, whalePriceUsd: number | null = null): Promise<void> {
    const config = await this.getConfig();
    if (buySol < config.minBuySol) return;
    // FIX: machine-speed triggers are adverse selection at human latency
    if (config.ignoreSniperTriggers) {
      const trigRow = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true } });
      if (trigRow?.metrics && (JSON.parse(trigRow.metrics) as WalletMetrics).flags.includes('SNIPER_SPEED')) return;
    }
    if (isExcludedToken(mint)) return; // majors/stables are never opportunities

    // recency: must be NEW for this wallet — no prior live buy, not in its analyzed history
    const priorLive = await this.prisma.liveEvent.findFirst({
      where: { wallet, mint, kind: 'buy', id: { lt: eventId } },
      select: { id: true },
    });
    if (priorLive) return;
    const walletRow = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { metrics: true } });
    if (walletRow?.metrics) {
      const m = JSON.parse(walletRow.metrics) as WalletMetrics;
      if (m.tokens.some((t) => t.mint === mint && t.buys > 0)) return; // known position, not news
    }

    // dedupe: one opportunity per token per day, whoever triggers it
    const recent = await this.prisma.opportunity.findFirst({
      where: { mint, createdAt: { gte: new Date(Date.now() - DEDUPE_HOURS * 3_600_000) } },
      select: { id: true },
    });
    if (recent) return;

    // the gauntlet decides — thresholds come from the crawler config (one source of truth)
    const crawlerRow = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } });
    const thresholds = CrawlerConfigSchema.parse(crawlerRow ? JSON.parse(crawlerRow.data) : {}).thresholds;
    const report = await this.tokenCheck.check(mint, thresholds).catch(() => null);
    if (!report) return;
    const allowed = report.verdict === 'pass' || (config.allowWarn && report.verdict === 'warn');
    if (!allowed) return;

    await this.prisma.opportunity.create({
      data: { mint, symbol: report.symbol, wallet, verdict: report.verdict, buySol: Math.round(buySol * 100) / 100, ts },
    });
    this.bus.emit('opportunity');
    // every opportunity is also a (paper) trade — this is where expectancy data comes from
    void this.trading.openFromOpportunity(mint, report.symbol, wallet, whalePriceUsd).catch(() => undefined);
  }
}
