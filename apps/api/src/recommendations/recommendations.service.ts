import { ConflictException, Injectable } from '@nestjs/common';
import { isQualifyingWallet, openPositions, WATCH_CRITERIA, type ConsensusToken, type RecommendationsData, type WalletMetrics } from '@million/shared';
import { PrismaService } from '../prisma.service';

const KEEP_RUNS = 5;

@Injectable()
export class RecommendationsService {
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  async latest(): Promise<RecommendationsData | null> {
    const row = await this.prisma.recommendation.findFirst({ orderBy: { id: 'desc' } });
    return row ? (JSON.parse(row.data) as RecommendationsData) : null;
  }

  async run(): Promise<RecommendationsData> {
    if (this.running) throw new ConflictException('a recommendations run is already in progress');
    this.running = true;
    try {
      const data = await this.compute();
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

  private async compute(): Promise<RecommendationsData> {
    const rows = await this.prisma.wallet.findMany({ where: { metrics: { not: null } } });
    const wallets = rows.map((w) => ({
      address: w.address,
      label: w.label,
      metrics: JSON.parse(w.metrics as string) as WalletMetrics,
    }));

    const qualifying = wallets.filter((w) => isQualifyingWallet(w.metrics));

    // consensus: how many qualifying wallets hold the same token open right now (stables excluded)
    const byMint = new Map<string, ConsensusToken>();
    for (const w of qualifying) {
      for (const t of openPositions(w.metrics.tokens)) {
        let entry = byMint.get(t.mint);
        if (!entry) {
          entry = { mint: t.mint, symbol: t.symbol, count: 0, holders: [] };
          byMint.set(t.mint, entry);
        }
        entry.count++;
        entry.symbol ??= t.symbol;
        entry.holders.push({ address: w.address, label: w.label });
      }
    }
    const consensusTokens = [...byMint.values()]
      .filter((t) => t.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);


    return {
      generatedAt: new Date().toISOString(),
      criteria: WATCH_CRITERIA,
      totalAnalyzed: wallets.length,
      qualifyingWallets: qualifying.length,
      consensusTokens,
    };
  }
}
