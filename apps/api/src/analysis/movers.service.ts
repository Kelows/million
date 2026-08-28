import { Injectable } from '@nestjs/common';
import { isExcludedToken, type MoverToken } from '@million/shared';
import { PrismaService } from '../prisma.service';

const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tokens that PUMPED: candidates gathered broadly (GeckoTerminal trending/new
 * + DexScreener boosts), then ranked by DexScreener's own 24h price change,
 * banded to meme-sized (tradeable, not a major). The blank-state seed source.
 */
@Injectable()
export class MoversService {
  constructor(private readonly prisma: PrismaService) {}

  async find(minPumpPct: number, max: number, minMcap = 100_000, maxMcap = 50_000_000): Promise<MoverToken[]> {
    const mints = new Set<string>();
    for (const path of [
      '/networks/solana/trending_pools?duration=24h&page=1',
      '/networks/solana/trending_pools?duration=24h&page=2',
      '/networks/solana/trending_pools?duration=6h&page=1',
      '/networks/solana/new_pools?page=1',
    ]) {
      const body = await this.json<{ data?: { relationships?: { base_token?: { data?: { id?: string } } } }[] }>(`${GT}${path}`);
      for (const p of body?.data ?? []) {
        const mint = (p.relationships?.base_token?.data?.id ?? '').replace('solana_', '');
        if (mint && !EXCLUDE.has(mint) && !isExcludedToken(mint)) mints.add(mint);
      }
      await sleep(300);
    }
    const boosts = await this.json<{ chainId?: string; tokenAddress?: string }[]>(`${DS}/token-boosts/top/v1`);
    for (const b of Array.isArray(boosts) ? boosts : []) {
      if (b.chainId === 'solana' && b.tokenAddress && !EXCLUDE.has(b.tokenAddress)) mints.add(b.tokenAddress);
    }

    const movers: MoverToken[] = [];
    for (const mint of mints) {
      if (movers.length >= max * 3) break; // enough material to rank
      type Raw = {
        pairs?: {
          chainId: string;
          baseToken?: { address?: string; symbol?: string };
          liquidity?: { usd?: number };
          marketCap?: number;
          fdv?: number;
          priceChange?: { h24?: number };
          volume?: { h24?: number };
        }[];
      };
      const body = await this.json<Raw>(`${DS}/latest/dex/tokens/${mint}`);
      const pairs = (body?.pairs ?? []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
      if (!pairs.length) continue;
      const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const liq = best.liquidity?.usd ?? 0;
      const mcap = best.marketCap ?? best.fdv ?? 0;
      const pump = Number(best.priceChange?.h24 ?? 0);
      if (liq < 25_000 || liq > 3_000_000) continue;
      if (mcap < minMcap || mcap > maxMcap) continue;
      if (pump < minPumpPct) continue;
      movers.push({
        mint,
        symbol: best.baseToken?.symbol ?? null,
        pumpH24Pct: Math.round(pump),
        liquidityUsd: Math.round(liq),
        marketCapUsd: Math.round(mcap),
        volumeH24Usd: Math.round(best.volume?.h24 ?? 0),
        alreadyTracked: false,
      });
      await sleep(200);
    }
    movers.sort((a, b) => b.pumpH24Pct - a.pumpH24Pct);
    const top = movers.slice(0, max);
    const known = await this.prisma.token.findMany({
      where: { mint: { in: top.map((m) => m.mint) }, tracked: true },
      select: { mint: true },
    });
    const knownSet = new Set(known.map((k) => k.mint));
    for (const m of top) m.alreadyTracked = knownSet.has(m.mint);
    return top;
  }

  private async json<T>(url: string): Promise<T | null> {
    const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
    return res?.ok ? ((await res.json()) as T) : null;
  }
}
