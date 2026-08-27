import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CrawlerConfigSchema,
  isJunkWallet,
  whaleScore,
  type CrawlerConfig,
  type CrawlerRunStats,
  type CrawlerRunSummary,
  type CrawlerStatus,
} from '@million/shared';
import { PrismaService } from '../prisma.service';
import { GemsService } from '../gems/gems.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { WalletsService } from '../wallets/wallets.service';

const KEEP_RUNS = 20;

/**
 * The loop, automated: re-freshen stalest analyses (wallet source), run the
 * gauntlet over consensus (gems), expand from passing gems into new clean
 * wallets (token source), absorb, repeat on a cadence. Every iteration is
 * bounded by a credit budget so 24/7 operation stays inside API quotas.
 */
@Injectable()
export class CrawlerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gems: GemsService,
    private readonly discovery: DiscoveryService,
    private readonly wallets: WalletsService,
    private readonly env: ConfigService,
  ) {}

  async onModuleInit() {
    const config = await this.getConfig();
    if (config.enabled) this.schedule(60_000); // first run a minute after boot
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  async getConfig(): Promise<CrawlerConfig> {
    const row = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } });
    if (!row) return CrawlerConfigSchema.parse({});
    return CrawlerConfigSchema.parse(JSON.parse(row.data));
  }

  async setConfig(config: CrawlerConfig): Promise<CrawlerConfig> {
    await this.prisma.crawlerConfig.upsert({
      where: { id: 1 },
      create: { id: 1, data: JSON.stringify(config) },
      update: { data: JSON.stringify(config) },
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    if (config.enabled) this.schedule(5_000);
    return config;
  }

  async status(): Promise<CrawlerStatus> {
    const runs = await this.prisma.crawlerRun.findMany({ orderBy: { id: 'desc' }, take: 8 });
    return {
      config: await this.getConfig(),
      running: this.running,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      lastRuns: runs.map((r) => {
        const data = JSON.parse(r.data) as { stats: CrawlerRunStats | null; log: string[] };
        return { id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, ...data };
      }),
    };
  }

  /** Fire one iteration outside the schedule (does not enable the crawler). */
  runOnce(): { started: boolean } {
    if (this.running) return { started: false };
    void this.iterate();
    return { started: true };
  }

  private schedule(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => void this.iterate(), delayMs);
  }

  private async iterate() {
    if (this.running) return;
    this.running = true;
    this.nextRunAt = null;
    const config = await this.getConfig();
    const analyzePages = Number(this.env.get('ANALYSIS_MAX_PAGES') ?? 5);
    const log: string[] = [];
    const stats: CrawlerRunStats = { creditsUsed: 0, walletsReanalyzed: 0, candidates: 0, gemsPass: 0, tokensScanned: 0, walletsAbsorbed: 0 };
    const say = (msg: string) => log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    const run = await this.prisma.crawlerRun.create({ data: { data: JSON.stringify({ stats: null, log: ['starting'] }) } });
    let credits = config.creditsPerIteration;

    try {
      say(`iteration start · budget ${credits} credits · sources: ${[config.sources.wallets && 'wallets', config.sources.tokens && 'tokens'].filter(Boolean).join('+')}`);

      // ── wallet source: keep consensus fresh by re-analyzing the stalest wallets ──
      if (config.sources.wallets && config.maxWalletsReanalyzed > 0) {
        const staleCandidates = await this.prisma.wallet.findMany({
          where: { status: 'done', purgedAt: null },
          orderBy: { lastAnalyzedAt: 'asc' },
          take: config.maxWalletsReanalyzed * 3, // overshoot, then drop junk — no credits wasted re-analyzing plumbing
        });
        const stale = staleCandidates
          .filter((w) => !w.metrics || !isJunkWallet(JSON.parse(w.metrics) as import('@million/shared').WalletMetrics))
          .slice(0, config.maxWalletsReanalyzed);
        for (const w of stale) {
          if (credits < analyzePages) break;
          await this.wallets.analyze(w.address).catch((e) => say(`  reanalyze ${w.address.slice(0, 8)} failed: ${e.message}`));
          credits -= analyzePages;
          stats.walletsReanalyzed++;
        }
        say(`refreshed ${stats.walletsReanalyzed} stalest analyses`);
      }

      // ── gauntlet: consensus -> gems ──
      const gemsRun = await this.gems.run(config.thresholds, config.minOpenSol).catch((e) => {
        say(`gems run failed: ${e.message}`);
        return null;
      });
      if (gemsRun) {
        stats.candidates = gemsRun.candidates;
        credits -= gemsRun.candidates * 2;
        stats.creditsUsed = config.creditsPerIteration - credits;
        const passing = gemsRun.gems.filter((g) => g.verdict === 'pass');
        stats.gemsPass = passing.length;
        // wallet discovery only needs SAFETY-clean tokens — size failsafes gate trading, not curiosity
        const expandable = gemsRun.gems.filter((g) => !g.safetyFail);
        say(`gauntlet: ${gemsRun.candidates} candidates -> ${passing.length} pass, ${expandable.length} safety-clean (expansion pool)`);

        // ── token source: expand from safety-clean gems into new clean wallets ──
        if (config.sources.tokens && expandable.length && config.maxWalletsAbsorbed > 0) {
          // novelty rotation: never-mined gems first, then least-recently mined —
          // with small caps a ranked walk would service the same top forever
          const scanTimes = new Map(
            (
              await this.prisma.token.findMany({
                where: { mint: { in: expandable.map((g) => g.mint) } },
                select: { mint: true, deepScannedAt: true },
              })
            ).map((t) => [t.mint, t.deepScannedAt?.getTime() ?? 0]),
          );
          expandable.sort((a, b) => (scanTimes.get(a.mint) ?? 0) - (scanTimes.get(b.mint) ?? 0));
          for (const gem of expandable) {
            if (credits < 10 || stats.walletsAbsorbed >= config.maxWalletsAbsorbed) break;
            // first sighting of a gem: mine its WHOLE LIFE of buyers, not the last minutes
            const useDeep = config.deepScanNewGems && !(scanTimes.get(gem.mint) ?? 0);
            const scanCost = useDeep ? config.deepScanBuckets * 3 + 25 : 16;
            if (credits < scanCost) continue;
            const report = await this.discovery
              .find(gem.mint, config.discoveryMinSol, 1, useDeep ? 'deep' : 'recent', 30, config.deepScanBuckets)
              .catch(() => null);
            if (!report) continue;
            if (useDeep) {
              await this.prisma.token.upsert({
                where: { mint: gem.mint },
                create: { mint: gem.mint, symbol: gem.symbol, deepScannedAt: new Date() },
                update: { deepScannedAt: new Date() },
              }).catch(() => undefined);
            }
            stats.tokensScanned++;
            credits -= scanCost;
            // absorb by quality threshold, not top-N — a good wallet is good regardless of rank
            const scoreOf = (x: (typeof report.candidates)[number]) =>
              whaleScore(x.preview!.winRate, x.preview!.realizedPnlSol, false);
            const clean = report.candidates
              .filter((c) => !c.inRoster && c.preview && !(c.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS'))
              .filter((c) => scoreOf(c) >= config.minWhaleScore)
              .sort((a, b) => scoreOf(b) - scoreOf(a));
            say(`  ${gem.symbol ?? gem.mint.slice(0, 8)}: ${useDeep ? `deep scan (${report.scannedTxs} txs, whole life)` : 'recent scan'}, ${report.candidates.length} buyers, ${clean.length} clean >= score ${config.minWhaleScore}`);
            if (!config.autoAbsorb) continue;
            for (const c of clean) {
              if (stats.walletsAbsorbed >= config.maxWalletsAbsorbed || credits < analyzePages) break;
              await this.wallets.import({ wallets: [c.address], source: 'crawler' });
              await this.wallets.analyze(c.address).catch(() => undefined);
              credits -= analyzePages;
              stats.walletsAbsorbed++;
              say(`  absorbed ${c.address.slice(0, 8)} (WR ${c.preview?.winRate ?? '?'})`);
            }
          }
        }
      }

      stats.creditsUsed = config.creditsPerIteration - credits;
      say(`done · ${stats.creditsUsed} credits used`);
    } catch (err) {
      say(`iteration error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      await this.prisma.crawlerRun.update({
        where: { id: run.id },
        data: { finishedAt: new Date(), data: JSON.stringify({ stats, log }) },
      });
      const staleRuns = await this.prisma.crawlerRun.findMany({ orderBy: { id: 'desc' }, skip: KEEP_RUNS, select: { id: true } });
      if (staleRuns.length) await this.prisma.crawlerRun.deleteMany({ where: { id: { in: staleRuns.map((r) => r.id) } } });
      this.running = false;
      const latest = await this.getConfig();
      if (latest.enabled) this.schedule(latest.intervalMinutes * 60_000);
    }
  }
}
