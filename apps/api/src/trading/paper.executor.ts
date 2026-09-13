import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpportunityConfigSchema } from '@million/shared';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { JupiterService } from '../analysis/jupiter.service';
import { PrismaService } from '../prisma.service';
import type { Fill, TradeExecutor } from './executor.interface';
import { feeBps } from './fee';

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
    private readonly jupiter: JupiterService,
    private readonly env: ConfigService,
  ) {}

  async quote(mint: string): Promise<number | null> {
    // Jupiter first: DexScreener's price can be ~30s old, and a paper exit filled
    // at a stale mark books a better price than the stop could have got
    const fresh = await this.jupiter.fetchPrices([mint]).catch(() => new Map<string, number>());
    if (fresh.has(mint)) return fresh.get(mint)!;
    const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
    return pair?.priceUsd ?? null;
  }

  /**
   * MEASURED cost, not an assumed one. The old model charged a flat 2% plus a
   * size/depth term on EVERY leg, which came to ~5.8% round trip in deep pools
   * where the real cost is 0.6% — we were taxing ourselves ten times over, and
   * that tax is baked into every conclusion drawn from the paper book so far.
   *
   * Jupiter's own round-trip quote is the honest number: it contains price
   * impact, AMM fees and any transfer tax, because a router cannot hide them.
   * Halved here, since it covers both legs. Measured across liquidity bands at
   * our clip size: 3.2% under $50k, 2.1% at $150-500k, 0.6% above $500k — a
   * cliff around $500k rather than a slope.
   *
   * Cached 5 minutes per mint: pool depth does not move fast enough to justify
   * two quote calls on every tick, and a tick loop that quotes Jupiter twice
   * per position per minute is how we rate-limited ourselves into booking
   * -100% on healthy tokens.
   */
  private readonly costCache = new Map<string, { pct: number; at: number }>();

  private async perSideSlippage(mint: string, sizeSol: number): Promise<number> {
    const hit = this.costCache.get(mint);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pct;
    const sim = await this.jupiter.sellSimulation(mint).catch(() => null);
    if (sim?.roundTripLossPct != null && sim.roundTripLossPct >= 0) {
      const pct = Math.min(25, sim.roundTripLossPct / 2);
      this.costCache.set(mint, { pct, at: Date.now() });
      return pct;
    }
    // unroutable or the probe failed — fall back to the configured assumption
    // plus a depth term, and do NOT cache a guess as if it were a measurement
    const base = await this.slippage();
    const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
    const liq = pair?.liquidityUsd ?? 0;
    if (liq <= 0) return Math.min(25, base + 5);
    const sizeUsd = sizeSol * (await this.dexscreener.fetchSolPriceUsd().catch(() => 200));
    return Math.min(25, base + (sizeUsd / liq) * 100);
  }

  async buy(mint: string, sizeSol: number): Promise<Fill | null> {
    const price = await this.quote(mint);
    if (price === null) return null;
    const slip = (await this.perSideSlippage(mint, sizeSol)) + this.feePct();
    return { priceUsd: price * (1 + slip / 100), at: new Date() };
  }

  async sell(mint: string, sizeSol: number): Promise<Fill | null> {
    const price = await this.quote(mint);
    if (price === null) return null;
    const slip = (await this.perSideSlippage(mint, sizeSol)) + this.feePct();
    return { priceUsd: price * (1 - slip / 100), at: new Date() };
  }

  /** The live developer fee, charged on both paper legs so paper matches what live would have netted. */
  private feePct(): number {
    return feeBps(this.env) / 100;
  }

  async walletBalanceSol(): Promise<number | null> {
    return null; // paper has no wallet: the bankroll in the rules is the notional one
  }

  private async slippage(): Promise<number> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {}).slippagePct;
  }
}
