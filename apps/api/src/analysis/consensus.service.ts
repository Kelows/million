import { Injectable } from '@nestjs/common';
import { enteredPositions, isQualifyingWallet, type ConsensusToken, type WalletMetrics } from '@million/shared';
import { PrismaService } from '../prisma.service';

export interface ConsensusResult {
  totalAnalyzed: number;
  qualifyingWallets: number;
  consensusTokens: ConsensusToken[]; // held open by >= 2 qualifying wallets
}

/** Cross-wallet conviction: which tokens did qualifying whales ENTER recently (co-entry). */
@Injectable()
export class ConsensusService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(minOpenSol: number, minCount = 1): Promise<ConsensusResult> {
    const rows = await this.prisma.wallet.findMany({ where: { metrics: { not: null }, purgedAt: null } });
    const ownerKey = (w: { address: string; ownerId: number | null }) => (w.ownerId ? `o${w.ownerId}` : w.address);
    const wallets = rows.map((w) => ({
      address: w.address,
      label: w.label,
      ownerId: w.ownerId,
      metrics: JSON.parse(w.metrics as string) as WalletMetrics,
    }));

    const qualifying = wallets.filter((w) => isQualifyingWallet(w.metrics));

    const byMint = new Map<string, ConsensusToken>();
    const ownersSeen = new Map<string, Set<string>>();
    for (const w of qualifying) {
      for (const t of enteredPositions(w.metrics, minOpenSol)) {
        let entry = byMint.get(t.mint);
        if (!entry) {
          entry = { mint: t.mint, symbol: t.symbol, count: 0, holders: [] };
          byMint.set(t.mint, entry);
          ownersSeen.set(t.mint, new Set());
        }
        // count OWNERS, not addresses — one actor's five wallets are one confirmation
        const key = ownerKey(w);
        const seen = ownersSeen.get(t.mint)!;
        if (!seen.has(key)) {
          seen.add(key);
          entry.count++;
        }
        entry.symbol ??= t.symbol;
        entry.holders.push({ address: w.address, label: w.label });
      }
    }
    const consensusTokens = [...byMint.values()]
      .filter((t) => t.count >= minCount)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    return { totalAnalyzed: wallets.length, qualifyingWallets: qualifying.length, consensusTokens };
  }
}
