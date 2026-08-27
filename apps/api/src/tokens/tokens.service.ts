import { Injectable } from '@nestjs/common';
import type { Token } from '@prisma/client';
import {
  isStablecoin,
  type TokenCheckThresholds,
  type TokenDetailData,
  type TokenReport,
  type TokenRosterIntel,
  type TrackedToken,
  type WalletMetrics,
} from '@million/shared';
import { PrismaService } from '../prisma.service';
import { TokenCheckService } from '../screener/token-check.service';

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCheck: TokenCheckService,
  ) {}

  async import(mints: string[], source: string | null): Promise<{ imported: number; skipped: number }> {
    const unique = [...new Set(mints)].filter((m) => !isStablecoin(m));
    let imported = 0;
    for (const mint of unique) {
      const existing = await this.prisma.token.findUnique({ where: { mint } });
      if (existing?.tracked) continue;
      await this.prisma.token.upsert({
        where: { mint },
        create: { mint, tracked: true, source, addedAt: new Date() },
        update: { tracked: true, source, addedAt: new Date() },
      });
      imported++;
    }
    return { imported, skipped: unique.length - imported };
  }

  /** Every token we know: tracked ones first, then everything seen in wallet analyses. */
  async list(): Promise<TrackedToken[]> {
    const rows = await this.prisma.token.findMany({ orderBy: [{ tracked: 'desc' }, { fetchedAt: 'desc' }] });
    return rows.map((r) => this.toTracked(r));
  }

  async detail(mint: string): Promise<TokenDetailData> {
    const row = await this.prisma.token.findUnique({ where: { mint } });
    const report = row?.lastReport ? (JSON.parse(row.lastReport) as TokenReport) : null;
    return {
      token: row
        ? this.toTracked(row)
        : { mint, symbol: null, name: null, tracked: false, source: null, addedAt: null, lastCheckedAt: null, verdict: null, liquidityUsd: null, marketCapUsd: null },
      report,
      intel: await this.intel(mint),
    };
  }

  /** Runs the gauntlet, stores the report, and starts tracking the token. */
  async check(mint: string, thresholds: TokenCheckThresholds): Promise<TokenDetailData> {
    const report = await this.tokenCheck.check(mint, thresholds);
    await this.prisma.token.upsert({
      where: { mint },
      create: {
        mint,
        symbol: report.symbol,
        name: report.name,
        tracked: true,
        source: 'checked',
        addedAt: new Date(),
        lastCheckedAt: new Date(),
        lastReport: JSON.stringify(report),
      },
      update: {
        symbol: report.symbol ?? undefined,
        name: report.name ?? undefined,
        tracked: true,
        lastCheckedAt: new Date(),
        lastReport: JSON.stringify(report),
      },
    });
    return this.detail(mint);
  }

  async untrack(mint: string): Promise<void> {
    await this.prisma.token
      .update({ where: { mint }, data: { tracked: false } })
      .catch(() => undefined); // untracking an unknown token is a no-op
  }

  /** Which roster wallets hold or traded this token, from their cached analyses. */
  private async intel(mint: string): Promise<TokenRosterIntel> {
    const rows = await this.prisma.wallet.findMany({ where: { metrics: { not: null } }, select: { address: true, label: true, metrics: true } });
    const holders: TokenRosterIntel['holders'] = [];
    const traders: TokenRosterIntel['traders'] = [];
    for (const w of rows) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      const t = m.tokens.find((tok) => tok.mint === mint);
      if (!t) continue;
      if (t.open) holders.push({ address: w.address, label: w.label, entrySol: t.entrySol ?? t.solIn });
      else if (t.sells > 0) traders.push({ address: w.address, label: w.label, realizedPnlSol: t.realizedPnlSol + (t.realizedPnlUsd ?? 0) / (m.solPriceUsd ?? 200) });
    }
    holders.sort((a, b) => (b.entrySol ?? 0) - (a.entrySol ?? 0));
    traders.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);
    return { holders: holders.slice(0, 30), traders: traders.slice(0, 30) };
  }

  private toTracked(r: Token): TrackedToken {
    const report = r.lastReport ? (JSON.parse(r.lastReport) as TokenReport) : null;
    return {
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      tracked: r.tracked,
      source: r.source,
      addedAt: r.addedAt?.toISOString() ?? null,
      lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
      verdict: report?.verdict ?? null,
      liquidityUsd: report?.liquidityUsd ?? null,
      marketCapUsd: report?.marketCapUsd ?? null,
    };
  }
}
