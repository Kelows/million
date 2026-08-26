import { Injectable } from '@nestjs/common';
import { summarizeMetrics, type DiscoveryReport, type WhaleCandidate } from '@million/shared';
import { HeliusService, type HeliusTx } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { computeMetrics } from '../analysis/metrics';
import { PrismaService } from '../prisma.service';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const LAMPORTS = 1e9;
const MAX_CANDIDATES = 30;
const PREVIEW_CAP = 15;
const PREVIEW_CONCURRENCY = 3;

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly helius: HeliusService,
    private readonly dexscreener: DexScreenerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Scan a token's recent transactions for size buyers: accounts that RECEIVED the
   * token and whose own balance PAID at least minSol (SOL or stable equivalent).
   * Attribution by balance change sidesteps router/aggregator noise. Recent-window
   * bias applies: this finds current buyers, not early winners.
   */
  async find(mint: string, minSol: number, pages: number): Promise<DiscoveryReport> {
    const [{ txs, truncated }, solPrice] = await Promise.all([
      this.helius.fetchHistory(mint, pages),
      this.dexscreener.fetchSolPriceUsd(),
    ]);

    const agg = new Map<string, { boughtSol: number; buyTxs: number; lastTs: number }>();
    for (const tx of txs) {
      const spend = this.buyersOf(tx, mint, solPrice);
      for (const [buyer, spentSol] of spend) {
        if (spentSol < minSol) continue;
        const entry = agg.get(buyer) ?? { boughtSol: 0, buyTxs: 0, lastTs: 0 };
        entry.boughtSol += spentSol;
        entry.buyTxs++;
        entry.lastTs = Math.max(entry.lastTs, tx.timestamp);
        agg.set(buyer, entry);
      }
    }

    const candidates: WhaleCandidate[] = [...agg.entries()]
      .sort((a, b) => b[1].boughtSol - a[1].boughtSol)
      .slice(0, MAX_CANDIDATES)
      .map(([address, e]) => ({
        address,
        boughtSol: Math.round(e.boughtSol * 100) / 100,
        buyTxs: e.buyTxs,
        lastBuyAt: new Date(e.lastTs * 1000).toISOString(),
        inRoster: false,
        preview: null,
        flags: null,
      }));

    const known = await this.prisma.wallet.findMany({
      where: { address: { in: candidates.map((c) => c.address) } },
      select: { address: true, metrics: true },
    });
    const knownMap = new Map(known.map((w) => [w.address, w.metrics]));
    for (const c of candidates) {
      c.inRoster = knownMap.has(c.address);
      const stored = knownMap.get(c.address);
      if (stored) {
        const m = JSON.parse(stored) as Parameters<typeof summarizeMetrics>[0];
        c.preview = summarizeMetrics(m);
        c.flags = m.flags;
      }
    }

    // quick analysis of the top unknowns — is this buyer a trader worth tracking, or plumbing?
    const toPreview = candidates.filter((c) => !c.inRoster).slice(0, PREVIEW_CAP);
    for (let i = 0; i < toPreview.length; i += PREVIEW_CONCURRENCY) {
      await Promise.all(
        toPreview.slice(i, i + PREVIEW_CONCURRENCY).map(async (candidate) => {
          const history = await this.helius.fetchHistory(candidate.address, 1).catch(() => null);
          if (!history) return;
          const metrics = computeMetrics(candidate.address, history.txs, history.truncated, solPrice);
          candidate.preview = summarizeMetrics(metrics);
          candidate.flags = metrics.flags;
        }),
      );
    }

    return {
      mint,
      scannedTxs: txs.length,
      truncated,
      minSol,
      candidates,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Per tx: accounts that received the mint -> how much of their own quote they paid. */
  private buyersOf(tx: HeliusTx, mint: string, solPrice: number): Map<string, number> {
    const receivers = new Set<string>();
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint === mint && t.toUserAccount) receivers.add(t.toUserAccount);
    }
    const spend = new Map<string, number>();
    for (const receiver of receivers) {
      let sol = 0;
      const ad = tx.accountData?.find((a) => a.account === receiver);
      if (ad && ad.nativeBalanceChange < 0) sol += -ad.nativeBalanceChange / LAMPORTS;
      for (const t of tx.tokenTransfers ?? []) {
        if (t.fromUserAccount !== receiver) continue;
        if (t.mint === WSOL) sol += t.tokenAmount;
        else if (t.mint === USDC || t.mint === USDT) sol += t.tokenAmount / solPrice;
      }
      if (sol > 0) spend.set(receiver, sol);
    }
    return spend;
  }
}
