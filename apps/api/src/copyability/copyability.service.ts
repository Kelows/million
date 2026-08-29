import { Injectable, Logger } from '@nestjs/common';
import {
  isExcludedToken,
  whaleScore,
  type CopyabilityJobStatus,
  type CopyabilityResult,
  type CopyabilityToken,
  type CopyabilityWalletRow,
  type WalletMetrics,
} from '@million/shared';
import { PrismaService } from '../prisma.service';
import { toObserved } from '../wallets/wallets.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { GeckoTerminalService } from '../analysis/geckoterminal.service';
import { EventsBus } from '../common/events.bus';

const DELAY_SEC = 60; // one candle — webhook + gauntlet + execution is realistically under a minute
const TOKENS_PER_WALLET = 6; // most recent closed trades; enough signal, bounded API cost
const MIN_ENTRY_SOL = 0.5; // ignore dust trades — they don't represent the whale's real edge
const MIN_WHALE_RET_PCT = 5; // below this the retention ratio divides by noise

/**
 * The copyability measurement: replay each whale's closed trades off the pool's
 * own minute tape, once at the whale's minute and once one candle later — the
 * copier's realistic latency. A whale whose edge evaporates in 60 seconds is a
 * sniper in disguise no matter how good the PnL looks; this is the number that
 * should decide the roster.
 */
@Injectable()
export class CopyabilityService {
  private readonly log = new Logger(CopyabilityService.name);
  private job: CopyabilityJobStatus = { running: false, done: 0, total: 0, current: null };
  private readonly poolCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
    private readonly gecko: GeckoTerminalService,
    private readonly bus: EventsBus,
  ) {}

  status(): CopyabilityJobStatus {
    return this.job;
  }

  async rows(): Promise<CopyabilityWalletRow[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, label: true, metrics: true, copyability: true, observedRealizedSol: true, observedTrades: true, observedWins: true },
    });
    return wallets
      .map((w) => {
        const m = JSON.parse(w.metrics as string) as WalletMetrics;
        return {
          address: w.address,
          label: w.label,
          whaleScore: whaleScore(toObserved(w.observedRealizedSol, w.observedTrades, w.observedWins), false),
          lastSeen: m.lastSeen ?? null,
          copyability: w.copyability ? (JSON.parse(w.copyability) as CopyabilityResult) : null,
        };
      })
      .sort((a, b) => (b.copyability?.computedAt ?? '').localeCompare(a.copyability?.computedAt ?? ''));
  }

  /** Kick off a background run: explicit addresses, or the top-N most recently active wallets. */
  start(addresses: string[] | undefined, top: number): { started: boolean } {
    if (this.job.running) return { started: false };
    this.job = { running: true, done: 0, total: 0, current: null };
    void this.run(addresses, top).finally(() => {
      this.job = { ...this.job, running: false, current: null };
      this.bus.emit('copyability');
    });
    return { started: true };
  }

  private async run(addresses: string[] | undefined, top: number): Promise<void> {
    const targets = addresses?.length ? addresses : await this.latestActive(top);
    this.job.total = targets.length;
    for (const address of targets) {
      this.job.current = address;
      await this.computeForWallet(address).catch((e) => this.log.warn(`copyability ${address}: ${e}`));
      this.job.done++;
      this.bus.emit('copyability');
    }
  }

  /** Subscribed wallets first (they trigger real entries — the gate needs THEM measured), then by activity. Bots excluded. */
  private async latestActive(top: number): Promise<string[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, metrics: true, subscribed: true },
    });
    return wallets
      .map((w) => ({ address: w.address, subscribed: w.subscribed, m: JSON.parse(w.metrics as string) as WalletMetrics }))
      .filter((w) => !(w.m.flags ?? []).includes('BOT_INFRA'))
      .sort((a, b) => Number(b.subscribed) - Number(a.subscribed) || (b.m.lastSeen ?? '').localeCompare(a.m.lastSeen ?? ''))
      .slice(0, top)
      .map((w) => w.address);
  }

  private async computeForWallet(address: string): Promise<void> {
    const row = await this.prisma.wallet.findUnique({ where: { address }, select: { metrics: true } });
    if (!row?.metrics) return;
    const m = JSON.parse(row.metrics) as WalletMetrics;
    // size = what the whale actually spent buying (entrySol is REMAINING basis — zero once closed)
    const sizeSol = (t: (typeof m.tokens)[number]) => t.solIn + (t.usdIn ?? 0) / (m.solPriceUsd ?? 200);
    const candidates = m.tokens
      .filter((t) => !t.open && t.sells > 0 && t.firstBuyAt && t.lastActivityAt && !isExcludedToken(t.mint))
      .filter((t) => sizeSol(t) >= MIN_ENTRY_SOL)
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      .slice(0, TOKENS_PER_WALLET);

    const tokens: CopyabilityToken[] = [];
    let skipped = 0;
    for (const t of candidates) {
      const measured = await this.measureToken(t.mint, t.symbol, t.firstBuyAt as string, t.lastActivityAt as string, sizeSol(t));
      if (measured) tokens.push(measured);
      else skipped++;
    }

    const result: CopyabilityResult = {
      computedAt: new Date().toISOString(),
      delaySec: DELAY_SEC,
      tokens,
      sampled: tokens.length,
      skipped,
      ...this.aggregate(tokens),
    };
    await this.prisma.wallet.update({ where: { address }, data: { copyability: JSON.stringify(result) } });
  }

  private async measureToken(mint: string, symbol: string | null, entryAt: string, exitAt: string, weightSol: number): Promise<CopyabilityToken | null> {
    const pool = await this.poolFor(mint);
    if (!pool) return null;
    const entryTs = Math.floor(new Date(entryAt).getTime() / 1000);
    const exitTs = Math.floor(new Date(exitAt).getTime() / 1000);

    // one window when the hold fits, two otherwise — each fetch covers ~40 minutes
    const sameWindow = exitTs - entryTs < 30 * 60;
    const entryCandles = await this.gecko.minuteCandles(pool, (sameWindow ? exitTs : entryTs) + 10 * 60);
    const exitCandles = sameWindow ? entryCandles : await this.gecko.minuteCandles(pool, exitTs + 10 * 60);

    const whaleEntry = this.gecko.candleAt(entryCandles, entryTs);
    const whaleExit = this.gecko.candleAt(exitCandles, exitTs);
    const copierEntry = this.gecko.candleAt(entryCandles, entryTs + DELAY_SEC);
    const copierExit = this.gecko.candleAt(exitCandles, exitTs + DELAY_SEC);
    if (!whaleEntry || !whaleExit || !copierEntry || !copierExit) return null;

    return {
      mint,
      symbol,
      entryAt,
      exitAt,
      whaleRetPct: ((whaleExit.close - whaleEntry.close) / whaleEntry.close) * 100,
      copierRetPct: ((copierExit.close - copierEntry.close) / copierEntry.close) * 100,
      weightSol,
    };
  }

  private aggregate(tokens: CopyabilityToken[]): Pick<CopyabilityResult, 'whaleAvgRetPct' | 'copierAvgRetPct' | 'edgeRetentionPct'> {
    if (!tokens.length) return { whaleAvgRetPct: null, copierAvgRetPct: null, edgeRetentionPct: null };
    const totalW = tokens.reduce((s, t) => s + t.weightSol, 0);
    const whaleAvg = tokens.reduce((s, t) => s + t.whaleRetPct * t.weightSol, 0) / totalW;
    const copierAvg = tokens.reduce((s, t) => s + t.copierRetPct * t.weightSol, 0) / totalW;
    return {
      whaleAvgRetPct: whaleAvg,
      copierAvgRetPct: copierAvg,
      edgeRetentionPct: whaleAvg >= MIN_WHALE_RET_PCT ? (copierAvg / whaleAvg) * 100 : null,
    };
  }

  private async poolFor(mint: string): Promise<string | null> {
    if (this.poolCache.has(mint)) return this.poolCache.get(mint) ?? null;
    const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
    const pool = pair?.pairAddresses[0] ?? null;
    this.poolCache.set(mint, pool);
    return pool;
  }
}
