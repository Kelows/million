import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Wallet } from '@prisma/client';
import type { WalletImport, WalletMetrics, WalletRecord, WalletStatus } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { computeMetrics } from '../analysis/metrics';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helius: HeliusService,
    private readonly tokenMeta: TokenMetaService,
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
    const wallets = await this.prisma.wallet.findMany({ orderBy: { createdAt: 'asc' } });
    return wallets.map((w) => this.toRecord(w));
  }

  async get(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    return this.toRecord(wallet);
  }

  async analyze(address: string): Promise<WalletRecord> {
    const wallet = await this.prisma.wallet.findUnique({ where: { address } });
    if (!wallet) throw new NotFoundException(`wallet ${address} is not in the roster`);
    if (wallet.status === 'analyzing') throw new ConflictException(`analysis already running for ${address}`);

    await this.prisma.wallet.update({ where: { address }, data: { status: 'analyzing', error: null } });
    try {
      const maxPages = Number(this.config.get('ANALYSIS_MAX_PAGES') ?? 5);
      const { txs, truncated } = await this.helius.fetchSwaps(address, maxPages);
      const metrics = computeMetrics(address, txs, truncated);
      const symbols = await this.tokenMeta.getSymbols(metrics.tokens.map((t) => t.mint)).catch(() => new Map<string, string>());
      for (const t of metrics.tokens) t.symbol = symbols.get(t.mint) ?? null;
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
    };
  }
}
