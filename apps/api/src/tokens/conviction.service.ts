import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConvictionCohortRow } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { TokensService } from './tokens.service';

const SNAPSHOT_MS = 60 * 60_000; // hourly
const SWEEP_MS = 10 * 60_000;
const CONTROL_SIZE = 10;

/**
 * Phase 1 of the accumulation strategy: is "held across the roster" PREDICTIVE
 * or merely descriptive? Snapshot the conviction ranking hourly against a
 * random control group of tracked tokens, mark both to market at +6h and +24h.
 *
 * The control matters more than it looks: without it a rising market makes
 * every cohort look clairvoyant. One batched price call per hour — free.
 */
@Injectable()
export class ConvictionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ConvictionService.name);
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
    private readonly tokens: TokensService,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.snapshot(), 30_000); // one shortly after boot so the series starts
    this.timers.push(setInterval(() => void this.snapshot(), SNAPSHOT_MS));
    this.timers.push(setInterval(() => void this.resolve(), SWEEP_MS));
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  private bandOf(rank: number): string {
    return rank <= 5 ? '1-5' : rank <= 10 ? '6-10' : '11-20';
  }

  async snapshot(): Promise<{ taken: number }> {
    const famous = await this.tokens.famous().catch(() => null);
    if (!famous?.held.length) return { taken: 0 };
    const ranked = famous.held.slice(0, 20);
    const rankedMints = new Set(ranked.map((r) => r.mint));

    // control: tracked tokens NOT in the conviction list — the "did everything
    // just go up?" baseline that makes the comparison mean anything
    const pool = await this.prisma.token.findMany({
      where: { purgedAt: null, mint: { notIn: [...rankedMints] } },
      select: { mint: true, symbol: true },
      take: 400,
    });
    const control = pool.sort(() => Math.random() - 0.5).slice(0, CONTROL_SIZE);

    const prices = await this.dexscreener.fetchPrices([...ranked.map((r) => r.mint), ...control.map((c) => c.mint)]);
    const rows: { mint: string; symbol: string | null; cohort: string; rank: number | null; score: number | null; owners: number | null; priceUsd: number }[] = [];
    ranked.forEach((r, i) => {
      const price = prices.get(r.mint);
      if (price) rows.push({ mint: r.mint, symbol: r.symbol, cohort: this.bandOf(i + 1), rank: i + 1, score: r.score ?? null, owners: r.owners, priceUsd: price });
    });
    for (const c of control) {
      const price = prices.get(c.mint);
      if (price) rows.push({ mint: c.mint, symbol: c.symbol, cohort: 'control', rank: null, score: null, owners: null, priceUsd: price });
    }
    if (rows.length) await this.prisma.convictionSnapshot.createMany({ data: rows });
    this.log.log(`conviction snapshot: ${rows.length} rows (${ranked.length} ranked, ${control.length} control)`);
    return { taken: rows.length };
  }

  /** Mark due snapshots to market. Unquotable = the pool died: -100%, not skipped. */
  private async resolve(): Promise<void> {
    for (const [ageMs, priceField, retField] of [
      [6 * 3_600_000, 'price6h', 'ret6hPct'],
      [24 * 3_600_000, 'price24h', 'ret24hPct'],
    ] as const) {
      const due = await this.prisma.convictionSnapshot.findMany({
        where: { [priceField]: null, takenAt: { lt: new Date(Date.now() - ageMs) } },
        take: 60,
      });
      if (!due.length) continue;
      const prices = await this.dexscreener.fetchPrices([...new Set(due.map((d) => d.mint))]);
      for (const d of due) {
        const price = prices.get(d.mint) ?? 0;
        await this.prisma.convictionSnapshot.update({
          where: { id: d.id },
          data: {
            [priceField]: price,
            [retField]: d.priceUsd > 0 ? Math.round((price / d.priceUsd - 1) * 1000) / 10 : -100,
          },
        });
      }
    }
  }

  async cohorts(): Promise<ConvictionCohortRow[]> {
    const rows = await this.prisma.convictionSnapshot.findMany();
    const order = ['1-5', '6-10', '11-20', 'control'];
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    return order
      .map((cohort) => {
        const mine = rows.filter((r) => r.cohort === cohort);
        const r6 = mine.map((r) => r.ret6hPct).filter((x): x is number => x !== null);
        const r24 = mine.map((r) => r.ret24hPct).filter((x): x is number => x !== null);
        return {
          cohort,
          snapshots: mine.length,
          resolved6h: r6.length,
          avgRet6hPct: avg(r6),
          medianRet6hPct: median(r6),
          resolved24h: r24.length,
          avgRet24hPct: avg(r24),
          medianRet24hPct: median(r24),
        };
      })
      .filter((c) => c.snapshots > 0);
  }
}
