import { Injectable } from '@nestjs/common';
import { OpportunityConfigSchema } from '@million/shared';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { PrismaService } from '../prisma.service';
import type { Fill, TradeExecutor } from './executor.interface';

/**
 * Simulated fills at DexScreener market price with a configurable slippage
 * assumption per side. Honest by construction: costs are charged on both legs.
 */
@Injectable()
export class PaperExecutor implements TradeExecutor {
  readonly mode = 'paper' as const;

  constructor(
    private readonly dexscreener: DexScreenerService,
    private readonly prisma: PrismaService,
  ) {}

  async quote(mint: string): Promise<number | null> {
    const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
    return pair?.priceUsd ?? null;
  }

  async buy(mint: string, _sizeSol: number): Promise<Fill | null> {
    const price = await this.quote(mint);
    if (price === null) return null;
    const slip = await this.slippage();
    return { priceUsd: price * (1 + slip / 100), at: new Date() };
  }

  async sell(mint: string, _sizeSol: number): Promise<Fill | null> {
    const price = await this.quote(mint);
    if (price === null) return null;
    const slip = await this.slippage();
    return { priceUsd: price * (1 - slip / 100), at: new Date() };
  }

  private async slippage(): Promise<number> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {}).slippagePct;
  }
}
