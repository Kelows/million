import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Wallet } from '@prisma/client';
import { isJunkWallet, openPositions, type OwnerAggregate, type WalletImport, type WalletMetrics, type WalletRecord, type WalletStatus } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { OwnersService } from '../analysis/owners.service';
import { computeMetrics } from '../analysis/metrics';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helius: HeliusService,
    private readonly tokenMeta: TokenMetaService,
    private readonly dexscreener: DexScreenerService,
    private readonly owners: OwnersService,
    private readonly config: ConfigService,
  ) {}

  async import(payload: WalletImport): Promise<{ imported: number; skipped: number }> {
    const source = payload.source ?? null;
    const entries = payload.wallets.map((w) =>
      typeof w === 'string' ? { address: w, label: null as string | null } : { address: w.address, label: w.label ?? null },
    );
    // dedupe within the payload
    const unique = new Map(entries.map((e) => [e.address, e]));

    let imported = 0;
    for (const entry of unique.values()) {
      const existing = await this.prisma.wallet.findUnique({ where: { address: entry.address } });
      if (existing) continue;
      await this.prisma.wallet.create({ data: { address: entry.address, label: entry.label, source } });
      imported++;
    }
    return { imported, skipped: unique.size - imported };
  }

  async list(): Promise<WalletRecord[]> {
    const wallets = await this.prisma.wallet.findMany({ where: { purgedAt: null }, orderBy: { createdAt: 'asc' } });
    return wallets.map((w) => this.toRecord(w));
  }

  async get(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    const record = this.toRecord(wallet);
    record.ownerSiblings = await this.owners.siblings(address);
    if (wallet.ownerId && record.ownerSiblings.length > 0) {
      record.ownerAggregate = await this.ownerAggregate(wallet.ownerId);
    }
    return record;
  }

  /** Pooled stats across every member of an owner cluster — from cached metrics, no API cost. */
  private async ownerAggregate(ownerId: number): Promise<OwnerAggregate> {
    const members = await this.prisma.wallet.findMany({ where: { ownerId, purgedAt: null } });
    let pnl = 0;
    let wins = 0;
    let closed = 0;
    const openMints = new Set<string>();
    let subscribedCount = 0;
    for (const w of members) {
      if (w.subscribed) subscribedCount++;
      if (!w.metrics) continue;
      const m = JSON.parse(w.metrics) as WalletMetrics;
      pnl += m.realizedPnlTotalSol ?? m.realizedPnlSol;
      closed += m.closedTokens;
      if (m.winRate !== null) wins += Math.round(m.winRate * m.closedTokens);
      for (const t of openPositions(m.tokens, 0)) openMints.add(t.mint);
    }
    return {
      members: members.length,
      combinedPnlSol: Math.round(pnl * 100) / 100,
      winRate: closed ? Math.round((wins / closed) * 100) / 100 : null,
      closedTokens: closed,
      openTokens: openMints.size,
      subscribedCount,
    };
  }

  /** Subscribe (or unsubscribe) every member of the owner cluster this wallet belongs to. */
  async setOwnerSubscribed(address: string, subscribed: boolean): Promise<{ affected: number }> {
    const me = await this.prisma.wallet.findUnique({ where: { address }, select: { ownerId: true } });
    if (!me) throw new NotFoundException(`wallet ${address} is not in the roster`);
    const where = me.ownerId ? { ownerId: me.ownerId, purgedAt: null } : { address };
    const result = await this.prisma.wallet.updateMany({ where, data: { subscribed } });
    return { affected: result.count };
  }

  async analyze(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    if (wallet.status === 'analyzing') throw new ConflictException(`analysis already running for ${address}`);

    await this.prisma.wallet.update({ where: { address }, data: { status: 'analyzing', error: null } });
    try {
      const maxPages = Number(this.config.get('ANALYSIS_MAX_PAGES') ?? 5);
      const [{ txs, truncated }, solPrice] = await Promise.all([
        this.helius.fetchHistory(address, maxPages),
        this.dexscreener.fetchSolPriceUsd(),
      ]);
      if (txs.length === 0 && truncated) {
        // rate-limited into emptiness — an empty 'done' analysis poisons scores silently
        throw new ServiceUnavailableException('rate limited while fetching history — re-run analysis');
      }
      const metrics = computeMetrics(address, txs, truncated, solPrice);
      const symbols = await this.tokenMeta.getSymbols(metrics.tokens.map((t) => t.mint)).catch(() => new Map<string, string>());
      for (const t of metrics.tokens) t.symbol = symbols.get(t.mint) ?? null;
      // owner evidence rides along for free — same txs we just fetched
      await this.owners.extractEdges(address, txs, metrics).catch(() => undefined);
      const updated = await this.prisma.wallet.update({
        where: { address },
        data: { status: 'done', metrics: JSON.stringify(metrics), lastAnalyzedAt: new Date(), error: null },
      });
      return this.toRecord(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'analysis failed';
      await this.prisma.wallet.update({ where: { address }, data: { status: 'error', error: message } });
      throw err;
    }
  }

  /** Soft-delete every junk wallet (infra / farmed): hidden everywhere, knowledge kept so re-discovery is free. */
  async purgeJunk(): Promise<{ purged: number }> {
    const rows = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, metrics: true },
    });
    const junk = rows.filter((w) => isJunkWallet(JSON.parse(w.metrics as string) as WalletMetrics)).map((w) => w.address);
    if (junk.length) await this.prisma.wallet.updateMany({ where: { address: { in: junk } }, data: { purgedAt: new Date() } });
    return { purged: junk.length };
  }

  async setSubscribed(address: string, subscribed: boolean): Promise<WalletRecord> {
    const updated = await this.prisma.wallet.update({ where: { address }, data: { subscribed } }).catch(() => {
      throw new NotFoundException(`wallet ${address} is not in the roster`);
    });
    return this.toRecord(updated);
  }

  async remove(address: string): Promise<void> {
    await this.prisma.wallet.delete({ where: { address } }).catch(() => {
      throw new NotFoundException(`wallet ${address} is not in the roster`);
    });
  }

  status(): { heliusConfigured: boolean } {
    return { heliusConfigured: this.helius.hasKey };
  }

  private toRecord(w: Wallet): WalletRecord {
    return {
      address: w.address,
      label: w.label,
      source: w.source,
      createdAt: w.createdAt.toISOString(),
      lastAnalyzedAt: w.lastAnalyzedAt?.toISOString() ?? null,
      status: w.status as WalletStatus,
      metrics: w.metrics ? (JSON.parse(w.metrics) as WalletMetrics) : null,
      error: w.error,
      subscribed: w.subscribed,
      ownerId: w.ownerId,
    };
  }
}
