import { Injectable } from '@nestjs/common';

export interface DexPair {
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: string | null; // ISO
  dex: string | null;
  pairUrl: string | null;
}

/** DexScreener public API — no key required. */
@Injectable()
export class DexScreenerService {
  async fetchBestPair(mint: string): Promise<DexPair | null> {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
    if (!res?.ok) return null;
    type Raw = {
      pairs?: {
        chainId: string;
        dexId?: string;
        url?: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
        marketCap?: number;
        fdv?: number;
        pairCreatedAt?: number;
        baseToken?: { address?: string; symbol?: string; name?: string };
      }[];
    };
    const body = (await res.json()) as Raw;
    const pairs = (body.pairs ?? []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
    if (!pairs.length) return null;
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return {
      symbol: best.baseToken?.symbol ?? null,
      name: best.baseToken?.name ?? null,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      liquidityUsd: best.liquidity?.usd ?? null,
      marketCapUsd: best.marketCap ?? best.fdv ?? null,
      pairCreatedAt: best.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString() : null,
      dex: best.dexId ?? null,
      pairUrl: best.url ?? null,
    };
  }
}
