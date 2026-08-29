import { Injectable } from '@nestjs/common';
import type { FlowRow, RosterFlows } from '@million/shared';
import { isExcludedToken, type WalletMetrics } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';

const MIN_CLIPS = 2; // one buy is an event; repeated buys are a decision
const MIN_SOL = 1;

/**
 * Roster flows: which tokens our wallets are laddering INTO and OUT OF right now.
 *
 * Accumulation is an entry signal we already trade on. Distribution is the one
 * we had no answer for — mirror exits only watch the single wallet that
 * triggered our entry, so the whole roster could be quietly leaving a token we
 * hold and nothing would notice.
 *
 * Reads live events we already pay for; costs nothing but a price lookup.
 */
@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dexscreener: DexScreenerService,
  ) {}

  async flows(minutes = 15): Promise<RosterFlows> {
    const since = new Date(Date.now() - minutes * 60_000);
    const [events, wallets] = await Promise.all([
      this.prisma.liveEvent.findMany({
        where: { ts: { gte: since }, kind: { in: ['buy', 'sell'] }, mint: { not: null } },
        select: { wallet: true, mint: true, kind: true, sol: true, usd: true },
      }),
      this.prisma.wallet.findMany({
        where: { purgedAt: null },
        select: { address: true, ownerId: true, metrics: true, label: true },
      }),
    ]);
    if (!events.length) return { minutes, accumulating: [], distributing: [] };

    const owners = new Map(wallets.map((w) => [w.address, w.ownerId != null ? `o${w.ownerId}` : w.address]));
    const infra = new Set(
      wallets
        .filter((w) => w.metrics && ((JSON.parse(w.metrics) as WalletMetrics).flags ?? []).includes('BOT_INFRA'))
        .map((w) => w.address),
    );
    const solUsd = await this.dexscreener.fetchSolPriceUsd().catch(() => 200);

    // per (mint, direction): who, how many clips, how much
    type Agg = { clips: number; sol: number; owners: Set<string>; wallets: Set<string> };
    const buy = new Map<string, Agg>();
    const sell = new Map<string, Agg>();
    for (const e of events) {
      const mint = e.mint as string;
      if (isExcludedToken(mint) || infra.has(e.wallet)) continue;
      const size = Math.abs(e.sol ?? 0) + Math.abs(e.usd ?? 0) / solUsd;
      const target = e.kind === 'buy' ? buy : sell;
      const agg = target.get(mint) ?? { clips: 0, sol: 0, owners: new Set<string>(), wallets: new Set<string>() };
      agg.clips++;
      agg.sol += size;
      agg.owners.add(owners.get(e.wallet) ?? e.wallet);
      agg.wallets.add(e.wallet);
      target.set(mint, agg);
    }

    const mints = [...new Set([...buy.keys(), ...sell.keys()])];
    const named = await this.prisma.token.findMany({ where: { mint: { in: mints } }, select: { mint: true, symbol: true } });
    const symbols = new Map(named.map((t) => [t.mint, t.symbol]));

    const build = (side: Map<string, Agg>, other: Map<string, Agg>): FlowRow[] =>
      [...side.entries()]
        .filter(([, a]) => a.clips >= MIN_CLIPS && a.sol >= MIN_SOL)
        .map(([mint, a]) => {
          const opposite = other.get(mint);
          return {
            mint,
            symbol: symbols.get(mint) ?? null,
            owners: a.owners.size,
            wallets: a.wallets.size,
            clips: a.clips,
            sol: Math.round(a.sol * 100) / 100,
            // net matters more than gross: churn shows up as both sides at once
            netSol: Math.round((a.sol - (opposite?.sol ?? 0)) * 100) / 100,
          };
        })
        .filter((r) => r.netSol > 0) // only genuine one-way pressure
        .sort((x, y) => y.netSol - x.netSol)
        .slice(0, 15);

    return { minutes, accumulating: build(buy, sell), distributing: build(sell, buy) };
  }
}
