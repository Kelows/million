import { ConflictException, Injectable } from '@nestjs/common';
import { WATCH_CRITERIA, type RecommendationsData } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { ConsensusService } from '../analysis/consensus.service';

const KEEP_RUNS = 5;

@Injectable()
export class RecommendationsService {
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly consensus: ConsensusService,
  ) {}

  async latest(): Promise<RecommendationsData | null> {
    const row = await this.prisma.recommendation.findFirst({ orderBy: { id: 'desc' } });
    return row ? (JSON.parse(row.data) as RecommendationsData) : null;
  }

  async run(minOpenSol: number): Promise<RecommendationsData> {
    if (this.running) throw new ConflictException('a recommendations run is already in progress');
    this.running = true;
    try {
      const data = await this.compute(minOpenSol);
      await this.prisma.recommendation.create({ data: { data: JSON.stringify(data) } });
      // keep the table small — only the last few runs matter
      const stale = await this.prisma.recommendation.findMany({
        orderBy: { id: 'desc' },
        skip: KEEP_RUNS,
        select: { id: true },
      });
      if (stale.length) {
        await this.prisma.recommendation.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
      }
      return data;
    } finally {
      this.running = false;
    }
  }

  private async compute(minOpenSol: number): Promise<RecommendationsData> {
    const { totalAnalyzed, qualifyingWallets, consensusTokens } = await this.consensus.compute(minOpenSol, 2); // recs stays a co-entry report
    return {
      generatedAt: new Date().toISOString(),
      criteria: { ...WATCH_CRITERIA, minOpenSol },
      totalAnalyzed,
      qualifyingWallets,
      consensusTokens,
    };
  }
}
