import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ShadowGuardStat } from '@million/shared';
import { OpportunityConfigSchema } from '@million/shared';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { PrismaService } from '../prisma.service';

const HORIZON_MS = 6 * 3_600_000; // the counterfactual convention: skipped signals are marked to market 6h later
const SWEEP_MS = 5 * 60_000;
const DEDUPE_MS = 10 * 60_000; // a cycler can trip its guard every few seconds — one phantom per (mint,wallet,reason) per window

/**
 * The shadow book: every signal a guard skips becomes a phantom position,
 * marked to market 6 hours later. Guards were induced from the same trades
 * that motivated them — this is their out-of-sample audit. "The cycler guard
 * avoided −X ◎ this week" becomes a number instead of a belief.
 */
@Injectable()
export class ShadowService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ShadowService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire-and-forget from the gates — never let the audit slow the pipeline. */
  record(mint: string, symbol: string | null, wallet: string, reason: string): void {
    void (async () => {
      const dupe = await this.prisma.shadowPosition.findFirst({
        where: { mint, wallet, reason, openedAt: { gte: new Date(Date.now() - DEDUPE_MS) } },
        select: { id: true },
      });
      if (dupe) return;
      const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
      if (!pair?.priceUsd) return; // unquotable — no honest entry mark exists
      const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
      const cfg = OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
      await this.prisma.shadowPosition.create({
        data: { mint, symbol, wallet, reason, entryPriceUsd: pair.priceUsd, sizeSol: cfg.positionSol },
      });
    })().catch((e) => this.log.warn(`shadow record ${mint.slice(0, 8)}: ${e}`));
  }

  /** Close phantoms past the horizon at market. Unquotable at close = the pool died: -100%. */
  private async sweep(): Promise<void> {
    const due = await this.prisma.shadowPosition.findMany({
      where: { status: 'open', openedAt: { lt: new Date(Date.now() - HORIZON_MS) } },
      take: 20, // bounded — DexScreener is free but not infinite
    });
    for (const p of due) {
      const pair = await this.dexscreener.fetchBestPair(p.mint).catch(() => null);
      const price = pair?.priceUsd ?? 0;
      const pnlPct = p.entryPriceUsd > 0 ? (price / p.entryPriceUsd - 1) * 100 : -100;
      await this.prisma.shadowPosition.update({
        where: { id: p.id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          exitPriceUsd: price,
          pnlPct: Math.round(pnlPct * 100) / 100,
          pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
        },
      });
    }
  }

  async stats(): Promise<ShadowGuardStat[]> {
    const rows = await this.prisma.shadowPosition.findMany();
    const by = new Map<string, { open: number; closed: number; pnlPcts: number[]; pnlSol: number }>();
    for (const r of rows) {
      const g = by.get(r.reason) ?? { open: 0, closed: 0, pnlPcts: [], pnlSol: 0 };
      if (r.status === 'open') g.open++;
      else {
        g.closed++;
        if (r.pnlPct != null) g.pnlPcts.push(r.pnlPct);
        g.pnlSol += r.pnlSol ?? 0;
      }
      by.set(r.reason, g);
    }
    return [...by.entries()]
      .map(([reason, g]) => ({
        reason,
        open: g.open,
        closed: g.closed,
        avgPnlPct: g.pnlPcts.length ? Math.round((g.pnlPcts.reduce((a, b) => a + b, 0) / g.pnlPcts.length) * 10) / 10 : null,
        avoidedSol: Math.round(-g.pnlSol * 1000) / 1000,
      }))
      .sort((a, b) => b.avoidedSol - a.avoidedSol);
  }
}
