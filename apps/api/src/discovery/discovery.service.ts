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
const DEEP_MAX_CANDIDATES = 60;
const PREVIEW_CAP = 15;
const DEEP_PREVIEW_CAP = 25;
const PREVIEW_CONCURRENCY = 3;
const DEFAULT_DEEP_BUCKETS = 24; // time checkpoints sampled across the token's life

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
  async find(
    mint: string,
    minSol: number,
    pages: number,
    mode: 'recent' | 'deep' = 'recent',
    sinceDays = 30,
    buckets = DEFAULT_DEEP_BUCKETS,
  ): Promise<DiscoveryReport> {
    const solPrice = await this.dexscreener.fetchSolPriceUsd();
    const { txs, truncated } = mode === 'deep' ? await this.deepSample(mint, sinceDays, buckets) : await this.helius.fetchHistory(mint, pages);

    const agg = new Map<string, { boughtSol: number; buyTxs: number; lastTs: number; firstTs: number }>();
    for (const tx of txs) {
      const spend = this.buyersOf(tx, mint, solPrice);
      for (const [buyer, spentSol] of spend) {
        if (spentSol < minSol) continue;
        const entry = agg.get(buyer) ?? { boughtSol: 0, buyTxs: 0, lastTs: 0, firstTs: Number.MAX_SAFE_INTEGER };
        entry.boughtSol += spentSol;
        entry.buyTxs++;
        entry.lastTs = Math.max(entry.lastTs, tx.timestamp);
        entry.firstTs = Math.min(entry.firstTs, tx.timestamp);
        agg.set(buyer, entry);
      }
    }

    const candidates: WhaleCandidate[] = [...agg.entries()]
      .sort((a, b) => b[1].boughtSol - a[1].boughtSol)
      .slice(0, mode === 'deep' ? DEEP_MAX_CANDIDATES : MAX_CANDIDATES)
      .map(([address, e]) => ({
        address,
        boughtSol: Math.round(e.boughtSol * 100) / 100,
        buyTxs: e.buyTxs,
        firstBuyAt: new Date(e.firstTs * 1000).toISOString(),
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
    // denser scans earn more previews — the whole point is judging more candidates
    const previewCap = mode === 'deep' ? Math.min(40, Math.max(DEEP_PREVIEW_CAP, buckets)) : PREVIEW_CAP;
    const toPreview = candidates.filter((c) => !c.inRoster).slice(0, previewCap);
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

    const times = txs.map((t) => t.timestamp).filter(Boolean);
    return {
      mint,
      mode,
      scannedTxs: txs.length,
      truncated,
      minSol,
      spanFrom: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null,
      spanTo: times.length ? new Date(Math.max(...times) * 1000).toISOString() : null,
      candidates,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Deep sampling: walk the token's signature index back toward launch (or sinceDays),
   * drop evenly-spaced TIME checkpoints, and fetch one page of full txs at each.
   * Coverage across the token's life instead of the last few seconds of a hot chart.
   */
  private async deepSample(mint: string, sinceDays: number, buckets: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    const SLOT_SECONDS = 0.4;
    const nowMs = Date.now();
    const sinceMs = nowMs - sinceDays * 86_400_000;
    const currentSlot = await this.helius.getSlot().catch(() => null);
    if (!currentSlot) return this.helius.fetchHistory(mint, 5); // degraded fallback

    const seen = new Map<string, HeliusTx>();
    let missedBuckets = 0;

    for (let i = 0; i < buckets; i++) {
      const targetMs = sinceMs + ((nowMs - sinceMs) * i) / Math.max(buckets - 1, 1);
      if (nowMs - targetMs < 60_000) {
        // newest bucket: plain recent page needs no cursor
        const recent = await this.helius.fetchHistory(mint, 1).catch(() => null);
        for (const tx of recent?.txs ?? []) seen.set(tx.signature, tx);
        continue;
      }
      const slot = currentSlot - Math.floor((nowMs - targetMs) / 1000 / SLOT_SECONDS);
      const cursor = slot > 0 ? await this.helius.signatureAtSlot(slot) : null;
      let checkpoint: string | null = null;
      if (cursor) {
        const sigs = await this.helius.signaturesBefore(mint, cursor, 5);
        checkpoint = sigs[0]?.sig ?? null;
      }
      if (!checkpoint) {
        missedBuckets++;
        continue; // token may not exist yet at this time, or slot was unreadable
      }
      const page = await this.helius.fetchPageBefore(mint, checkpoint).catch(() => []);
      for (const tx of page) seen.set(tx.signature, tx);
    }

    return { txs: [...seen.values()], truncated: missedBuckets > buckets / 2 };
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
