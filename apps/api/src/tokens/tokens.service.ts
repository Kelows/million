import { Injectable } from '@nestjs/common';
import type { Token } from '@prisma/client';
import {
  CrawlerConfigSchema,
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
import { DexScreenerService } from '../analysis/dexscreener.service';

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCheck: TokenCheckService,
    private readonly bus: EventsBus,
    private readonly dexscreener: DexScreenerService,
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

  /** Crawler-config thresholds are THE thresholds; explicit query params override per-key. */
  private async resolveThresholds(partial: Partial<TokenCheckThresholds>): Promise<TokenCheckThresholds> {
    const row = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } }).catch(() => null);
    const base = CrawlerConfigSchema.parse(row ? JSON.parse(row.data) : {}).thresholds;
    const overrides = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
    return { ...base, ...overrides };
  }

  /** Runs the gauntlet, stores the report, and starts tracking the token. */
  async check(mint: string, partial: Partial<TokenCheckThresholds>): Promise<TokenDetailData> {
    const report = await this.tokenCheck.check(mint, await this.resolveThresholds(partial));
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
  startRecheckAll(thresholds: Partial<TokenCheckThresholds>): { started: boolean } {
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
    // "held" comes from the LIVE position ledger (analysis-seeded, event-updated);
    // "earned" still comes from metrics, since realized PnL is only known at analysis.
    const [positions, wallets, subscribed] = await Promise.all([
      this.prisma.rosterPosition.findMany({ where: { costSol: { gt: 0 } } }),
      this.prisma.wallet.findMany({
        where: { metrics: { not: null }, purgedAt: null },
        select: { address: true, ownerId: true, metrics: true, subscribed: true },
      }),
      // separate from `wallets`: a subscribed wallet not yet analyzed still has live rows we can see leave
      this.prisma.wallet.findMany({ where: { subscribed: true, purgedAt: null }, select: { address: true } }),
    ]);
    const owners = new Map(wallets.map((w) => [w.address, w.ownerId != null ? `o${w.ownerId}` : w.address]));
    const infra = new Set(
      wallets.filter((w) => ((JSON.parse(w.metrics as string) as WalletMetrics).flags ?? []).includes('BOT_INFRA')).map((w) => w.address),
    );

    // live events carry a mint, not a name — resolve symbols from the token
    // cache at read time so they fill in as we learn them
    const named = await this.prisma.token.findMany({
      where: { mint: { in: [...new Set(positions.map((p) => p.mint))] } },
      select: { mint: true, symbol: true },
    });
    const symbols = new Map(named.filter((t) => t.symbol).map((t) => [t.mint, t.symbol]));
    // mints we have never named: resolve once from DexScreener (free, batched)
    // and persist, so the 3s poll never re-fetches the same unknown
    const unknown = [...new Set(positions.map((p) => p.mint))].filter((m) => !named.some((t) => t.mint === m));
    if (unknown.length) {
      const found = await this.dexscreener.fetchSymbols(unknown).catch(() => new Map<string, string>());
      for (const mint of unknown) {
        const symbol = found.get(mint) ?? null;
        if (symbol) symbols.set(mint, symbol);
        // upsert either way — a row with no symbol still stops the retry loop
        await this.prisma.token
          .upsert({ where: { mint }, create: { mint, symbol, source: 'live-ledger' }, update: symbol ? { symbol } : {} })
          .catch(() => undefined);
      }
    }

    // A position is only "still in" if we would SEE it leave. An unsubscribed or
    // purged wallet's ledger rows are frozen at their last analysis — it may have
    // sold an hour later — so they are not a claim this table can make. On
    // 2026-09-13 those were 38 of 47 rows and 384 of 491 SOL.
    const watched = new Set(subscribed.map((w) => w.address));
    const held = new Map<string, FamousTokenRow & { keys: Set<string> }>();
    for (const p of positions) {
      if (isExcludedToken(p.mint) || infra.has(p.wallet) || !watched.has(p.wallet) || p.costSol < 0.5) continue;
      const key = owners.get(p.wallet) ?? p.wallet;
      const symbol = p.symbol ?? symbols.get(p.mint) ?? null;
      const row = held.get(p.mint) ?? { mint: p.mint, symbol, owners: 0, sol: 0, keys: new Set<string>() };
      row.symbol = row.symbol ?? symbol;
      row.keys.add(key);
      row.owners = row.keys.size;
      row.sol += p.costSol;
      held.set(p.mint, row);
    }

    // "Where the roster printed" now means round trips we WATCHED close, so it
    // reports the same trusted number as everything else. Historical per-token
    // PnL came from the truncated scan and inflated whatever it touched.
    const closes = await this.prisma.observedTrade.findMany({ where: { pnlSol: { not: 0 } } });
    const earned = new Map<string, FamousTokenRow & { keys: Set<string> }>();
    for (const c of closes) {
      if (isExcludedToken(c.mint) || infra.has(c.wallet)) continue;
      const key = owners.get(c.wallet) ?? c.wallet;
      const symbol = c.symbol ?? symbols.get(c.mint) ?? null;
      const row = earned.get(c.mint) ?? { mint: c.mint, symbol, owners: 0, sol: 0, keys: new Set<string>() };
      row.symbol = row.symbol ?? symbol;
      row.keys.add(key);
      row.owners = row.keys.size;
      row.sol += c.pnlSol;
      earned.set(c.mint, row);
    }

    const strip = (r: FamousTokenRow & { keys: Set<string> }): FamousTokenRow => ({ mint: r.mint, symbol: r.symbol, owners: r.owners, sol: Math.round(r.sol * 100) / 100 });
    // conviction: breadth × size, discounted by profit already taken here
    const scored = [...held.values()].map((r) => {
      const realized = Math.max(0, earned.get(r.mint)?.sol ?? 0);
      const entryShare = r.sol / (r.sol + realized || 1);
      return {
        ...strip(r),
        realizedSol: Math.round((earned.get(r.mint)?.sol ?? 0) * 100) / 100,
        score: Math.round(r.owners * Math.sqrt(r.sol) * entryShare * 10) / 10,
      };
    });
    return {
      held: scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 20),
      earned: [...earned.values()].sort((a, b) => b.sol - a.sol).slice(0, 15).map(strip),
    };
  }


  /** Which roster wallets hold or traded this token, from their cached analyses. */
  private async intel(mint: string): Promise<TokenRosterIntel> {
    // Same sources as "Held across the roster", for the same reason: an analysis
    // snapshot says what a wallet held when we last looked, and PnL from the
    // truncated history scan inflated whatever it touched. Holders are live
    // ledger rows of wallets whose sells we would see; traders are round trips
    // we actually watched close.
    const [positions, closes, wallets] = await Promise.all([
      this.prisma.rosterPosition.findMany({ where: { mint, costSol: { gt: 0 } }, select: { wallet: true, costSol: true } }),
      this.prisma.observedTrade.findMany({ where: { mint }, select: { wallet: true, pnlSol: true } }),
      this.prisma.wallet.findMany({ where: { purgedAt: null }, select: { address: true, label: true, subscribed: true } }),
    ]);
    const byAddress = new Map(wallets.map((w) => [w.address, w]));
    const holders: TokenRosterIntel['holders'] = positions
      .filter((p) => byAddress.get(p.wallet)?.subscribed)
      .map((p) => ({ address: p.wallet, label: byAddress.get(p.wallet)?.label ?? null, entrySol: p.costSol }));
    const realized = new Map<string, number>();
    for (const c of closes) realized.set(c.wallet, (realized.get(c.wallet) ?? 0) + c.pnlSol);
    const traders: TokenRosterIntel['traders'] = [...realized].map(([address, pnl]) => ({
      address,
      label: byAddress.get(address)?.label ?? null,
      realizedPnlSol: pnl,
    }));
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
