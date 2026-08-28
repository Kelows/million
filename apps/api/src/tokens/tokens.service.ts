import { Injectable } from '@nestjs/common';
import type { Token } from '@prisma/client';
import {
  isExcludedToken,
  type FamousTokenRow,
  type FamousTokens,
  type TokenCheckThresholds,
  type TokenDetailData,
  type TokenReport,
  type TokenRosterIntel,
  type TrackedToken,
  type WalletMetrics,
} from '@million/shared';
import { PrismaService } from '../prisma.service';
import { TokenCheckService } from '../screener/token-check.service';
import { EventsBus } from '../common/events.bus';

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCheck: TokenCheckService,
    private readonly bus: EventsBus,
  ) {}

  async import(mints: string[], source: string | null): Promise<{ imported: number; skipped: number }> {
    const unique = [...new Set(mints)].filter((m) => !isExcludedToken(m));
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
    const rows = await this.prisma.token.findMany({ where: { purgedAt: null }, orderBy: [{ tracked: 'desc' }, { fetchedAt: 'desc' }] });
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
        purgedAt: null, // an explicit re-check un-purges — verdicts can change
      },
    });
    return this.detail(mint);
  }

  /** Delete checked tokens that are junk: FAIL verdict or dead liquidity. Unchecked tokens are untouched. */
  async purgeJunk(): Promise<{ purged: number }> {
    const rows = await this.prisma.token.findMany({
      where: { lastReport: { not: null }, purgedAt: null },
      select: { mint: true, lastReport: true },
    });
    const junk = rows
      .filter((r) => {
        const report = JSON.parse(r.lastReport as string) as TokenReport;
        return report.verdict === 'fail' || (report.liquidityUsd ?? 0) <= 0;
      })
      .map((r) => r.mint);
    if (junk.length) await this.prisma.token.updateMany({ where: { mint: { in: junk } }, data: { purgedAt: new Date() } });
    return { purged: junk.length };
  }

  private recheckJob = { running: false, done: 0, total: 0 };

  /** Server-side batch: re-run the gauntlet on every tracked token (verdicts go stale when checks evolve). */
  startRecheckAll(thresholds: TokenCheckThresholds): { started: boolean } {
    if (this.recheckJob.running) return { started: false };
    this.recheckJob = { running: true, done: 0, total: 0 };
    void (async () => {
      try {
        const tracked = await this.prisma.token.findMany({
          where: { tracked: true, purgedAt: null },
          select: { mint: true },
        });
        this.recheckJob.total = tracked.length;
        for (const { mint } of tracked) {
          await this.check(mint, thresholds).catch(() => undefined);
          this.recheckJob.done++;
          this.bus.emit('token_checked');
          await new Promise((r) => setTimeout(r, 400));
        }
      } finally {
        this.recheckJob.running = false;
        this.bus.emit('token_checked');
      }
    })();
    return { started: true };
  }

  getRecheckStatus() {
    return this.recheckJob;
  }

  async untrack(mint: string): Promise<void> {
    await this.prisma.token
      .update({ where: { mint }, data: { tracked: false } })
      .catch(() => undefined); // untracking an unknown token is a no-op
  }

  /**
   * Tokens ranked by roster attention: what distinct owners hold right now
   * (live consensus) and where they realized the most PnL (proven winners).
   * One owner with five wallets counts once — address-counting flatters clusters.
   */
  async famous(): Promise<FamousTokens> {
    const rows = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, ownerId: true, metrics: true },
    });
    const held = new Map<string, FamousTokenRow & { keys: Set<string> }>();
    const earned = new Map<string, FamousTokenRow & { keys: Set<string> }>();
    const bump = (map: typeof held, mint: string, symbol: string | null, ownerKey: string, sol: number) => {
      const row = map.get(mint) ?? { mint, symbol, owners: 0, sol: 0, keys: new Set<string>() };
      row.symbol = row.symbol ?? symbol;
      row.keys.add(ownerKey);
      row.owners = row.keys.size;
      row.sol += sol;
      map.set(mint, row);
    };
    for (const w of rows) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      if ((m.flags ?? []).includes('BOT_INFRA')) continue; // infra "holdings" are inventory, not conviction
      const ownerKey = w.ownerId != null ? `o${w.ownerId}` : w.address;
      for (const t of m.tokens) {
        if (isExcludedToken(t.mint)) continue;
        if (t.open && (t.entrySol ?? t.solIn) >= 0.5) bump(held, t.mint, t.symbol, ownerKey, t.entrySol ?? t.solIn);
        const pnl = t.realizedPnlSol + (t.realizedPnlUsd ?? 0) / (m.solPriceUsd ?? 200);
        if (t.sells > 0 && pnl !== 0) bump(earned, t.mint, t.symbol, ownerKey, pnl);
      }
    }
    const strip = (r: FamousTokenRow & { keys: Set<string> }): FamousTokenRow => ({ mint: r.mint, symbol: r.symbol, owners: r.owners, sol: Math.round(r.sol * 100) / 100 });
    return {
      held: [...held.values()].sort((a, b) => b.owners - a.owners || b.sol - a.sol).slice(0, 15).map(strip),
      earned: [...earned.values()].sort((a, b) => b.sol - a.sol).slice(0, 15).map(strip),
    };
  }

  /** Which roster wallets hold or traded this token, from their cached analyses. */
  private async intel(mint: string): Promise<TokenRosterIntel> {
    const rows = await this.prisma.wallet.findMany({ where: { metrics: { not: null }, purgedAt: null }, select: { address: true, label: true, metrics: true } });
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
