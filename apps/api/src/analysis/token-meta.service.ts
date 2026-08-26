import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { HeliusService, type TokenMeta } from './helius.service';

@Injectable()
export class TokenMetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helius: HeliusService,
  ) {}

  /**
   * Symbols for the given mints, DB cache first. Unknown mints are fetched from
   * Helius DAS once and cached — including metadata-less ones, so they are never refetched.
   */
  async getSymbols(mints: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (mints.length === 0) return out;

    const cached = await this.prisma.token.findMany({ where: { mint: { in: mints } } });
    for (const t of cached) {
      if (t.symbol) out.set(t.mint, t.symbol);
    }

    const seen = new Set(cached.map((t) => t.mint));
    const missing = mints.filter((m) => !seen.has(m));
    if (missing.length === 0) return out;

    const fetched = await this.helius.fetchTokenMeta(missing).catch(() => new Map<string, TokenMeta>());
    for (const [mint, meta] of fetched) {
      if (meta.symbol) out.set(mint, meta.symbol);
      await this.prisma.token
        .upsert({
          where: { mint },
          create: { mint, symbol: meta.symbol, name: meta.name },
          update: { symbol: meta.symbol, name: meta.name, fetchedAt: new Date() },
        })
        .catch(() => undefined); // cache write failure must not break the analysis
    }
    return out;
  }
}
