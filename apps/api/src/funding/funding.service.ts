import { Injectable } from '@nestjs/common';
import type { FundingLink, FundingReport } from '@million/shared';
import { HeliusService } from '../analysis/helius.service';
import { PrismaService } from '../prisma.service';

const LAMPORTS = 1e9;
const MAX_PAGES = 3;
const MAX_LINKS = 50;

@Injectable()
export class FundingService {
  constructor(
    private readonly helius: HeliusService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * SOL transfer counterparties of a wallet, both directions, above minSol.
   * "out" links are candidate new addresses of the same actor; "in" links are who funded them.
   * No freshness verification yet — exchange deposit addresses can show up, human judges.
   */
  async chains(address: string, minSol: number): Promise<FundingReport> {
    const { txs, truncated } = await this.helius.fetchTransfers(address, MAX_PAGES);

    const byCounterparty = new Map<string, FundingLink>();
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        const sol = t.amount / LAMPORTS;
        if (sol < minSol) continue; // skip fees/rent dust

        let counterparty: string | null = null;
        let direction: 'out' | 'in' | null = null;
        if (t.fromUserAccount === address && t.toUserAccount && t.toUserAccount !== address) {
          counterparty = t.toUserAccount;
          direction = 'out';
        } else if (t.toUserAccount === address && t.fromUserAccount && t.fromUserAccount !== address) {
          counterparty = t.fromUserAccount;
          direction = 'in';
        }
        if (!counterparty || !direction) continue;

        const key = `${direction}:${counterparty}`;
        const at = new Date(tx.timestamp * 1000).toISOString();
        const existing = byCounterparty.get(key);
        if (existing) {
          existing.totalSol += sol;
          existing.transfers++;
          if (at < existing.firstAt) existing.firstAt = at;
          if (at > existing.lastAt) existing.lastAt = at;
        } else {
          byCounterparty.set(key, {
            address: counterparty,
            direction,
            totalSol: sol,
            transfers: 1,
            firstAt: at,
            lastAt: at,
            inRoster: false,
          });
        }
      }
    }

    const links = [...byCounterparty.values()]
      .sort((a, b) => b.totalSol - a.totalSol)
      .slice(0, MAX_LINKS)
      .map((l) => ({ ...l, totalSol: Math.round(l.totalSol * 1000) / 1000 }));

    const known = await this.prisma.wallet.findMany({
      where: { address: { in: links.map((l) => l.address) } },
      select: { address: true },
    });
    const knownSet = new Set(known.map((w) => w.address));
    for (const l of links) l.inRoster = knownSet.has(l.address);

    return {
      address,
      analyzedTxCount: txs.length,
      truncated,
      minSol,
      links,
      fetchedAt: new Date().toISOString(),
    };
  }
}
