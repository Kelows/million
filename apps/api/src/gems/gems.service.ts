import { ConflictException, Injectable } from '@nestjs/common';
import type { CheckStatus, GemsRunData, GemToken, TokenCheckThresholds } from '@million/shared';
import { ConsensusService } from '../analysis/consensus.service';
import { TokenCheckService } from '../screener/token-check.service';
import { PrismaService } from '../prisma.service';

const KEEP_RUNS = 5;
const VERDICT_RANK: Record<CheckStatus, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

/**
 * The closed loop's output: consensus tokens pushed through the full token
 * gauntlet, ranked by verdict then whale conviction. Read docs/closed-loop.md.
 */
@Injectable()
export class GemsService {
  private running = false;

  constructor(
    private readonly consensus: ConsensusService,
    private readonly tokenCheck: TokenCheckService,
    private readonly prisma: PrismaService,
  ) {}

  async latest(): Promise<GemsRunData | null> {
    const row = await this.prisma.gemsRun.findFirst({ orderBy: { id: 'desc' } });
    return row ? (JSON.parse(row.data) as GemsRunData) : null;
  }

  async run(thresholds: TokenCheckThresholds, minOpenSol: number): Promise<GemsRunData> {
    if (this.running) throw new ConflictException('a gems run is already in progress');
    this.running = true;
    try {
      const data = await this.compute(thresholds, minOpenSol);
      await this.prisma.gemsRun.create({ data: { data: JSON.stringify(data) } });
      const stale = await this.prisma.gemsRun.findMany({ orderBy: { id: 'desc' }, skip: KEEP_RUNS, select: { id: true } });
      if (stale.length) await this.prisma.gemsRun.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
      return data;
    } finally {
      this.running = false;
    }
  }

  private async compute(thresholds: TokenCheckThresholds, minOpenSol: number): Promise<GemsRunData> {
    const { totalAnalyzed, qualifyingWallets, consensusTokens } = await this.consensus.compute(minOpenSol);

    const gems: GemToken[] = [];
    // sequential: each check fans out to 4 external sources already
    for (const candidate of consensusTokens) {
      const report = await this.tokenCheck.check(candidate.mint, thresholds).catch(() => null);
      gems.push({
        mint: candidate.mint,
        symbol: report?.symbol ?? candidate.symbol,
        verdict: report?.verdict ?? 'unknown',
        whaleCount: candidate.count,
        holders: candidate.holders,
        liquidityUsd: report?.liquidityUsd ?? null,
        marketCapUsd: report?.marketCapUsd ?? null,
        pairCreatedAt: report?.pairCreatedAt ?? null,
        pairUrl: report?.pairUrl ?? null,
        failures: report?.checks.filter((c) => c.status === 'fail').map((c) => c.label) ?? [],
        warnings: report?.checks.filter((c) => c.status === 'warn').map((c) => c.label) ?? [],
      });
    }

    gems.sort(
      (a, b) =>
        VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
        b.whaleCount - a.whaleCount ||
        (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
    );

    return {
      generatedAt: new Date().toISOString(),
      thresholds,
      minOpenSol,
      totalAnalyzed,
      qualifyingWallets,
      candidates: consensusTokens.length,
      gems,
    };
  }
}
