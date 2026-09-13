import { Injectable } from '@nestjs/common';

export interface DexPair {
  pairAddresses: string[]; // top pools by liquidity — used to exclude LP vaults from holder math
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: string | null; // ISO
  dex: string | null;
  pairUrl: string | null;
}

const WSOL = 'So11111111111111111111111111111111111111112';

/** DexScreener public API — no key required. */
@Injectable()
export class DexScreenerService {
  private solPrice: { value: number; at: number } | null = null;

  /** Live SOL/USD price, cached 5 minutes. Falls back to $200 if the API is down. */
  async fetchSolPriceUsd(): Promise<number> {
    if (this.solPrice && Date.now() - this.solPrice.at < 5 * 60_000) return this.solPrice.value;
    const pair = await this.fetchBestPair(WSOL).catch(() => null);
    const value = pair?.priceUsd ?? 200;
    this.solPrice = { value, at: Date.now() };
    return value;
  }

  /** Prices for many mints at once — 30 per request, so a whole open book costs one call. */
  async fetchPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const depth = new Map<string, number>();
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30).join(',');
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res?.ok) continue;
      const pairs = (await res.json().catch(() => [])) as { baseToken?: { address?: string }; priceUsd?: string; liquidity?: { usd?: number } }[];
      for (const p of pairs ?? []) {
        const mint = p.baseToken?.address;
        const price = p.priceUsd ? Number(p.priceUsd) : null;
        if (!mint || !price) continue;
        // several pools per mint — keep the deepest, which is the honest mark
        // (the old check kept whichever pool with any liquidity came last)
        const liq = p.liquidity?.usd ?? 0;
        if (!out.has(mint) || liq > (depth.get(mint) ?? -1)) {
          out.set(mint, price);
          depth.set(mint, liq);
        }
      }
    }
    return out;
  }

  /** Symbols for many mints at once — live events carry mints, humans need names. */
  async fetchSymbols(mints: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30).join(',');
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res?.ok) continue;
      const pairs = (await res.json().catch(() => [])) as { baseToken?: { address?: string; symbol?: string } }[];
      for (const p of pairs ?? []) {
        const mint = p.baseToken?.address;
        if (mint && p.baseToken?.symbol && !out.has(mint)) out.set(mint, p.baseToken.symbol);
      }
    }
    return out;
  }

  /**
   * Distinguishes "this token has no pairs" from "we could not ask". fetchBestPair
   * collapses both into null, and a caller that treats null as death will book a
   * total loss on a healthy token every time DexScreener rate-limits us — which
   * is exactly what happened: five positions closed at -100% while every one of
   * them was still quoting normally, one of them a $46M market cap.
   */
  async probePairs(mint: string): Promise<'has-pairs' | 'no-pairs' | 'unreachable'> {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) return 'unreachable';
    if (!res.ok) return 'unreachable'; // 429 and 5xx are OUR problem, never the token's
    const body = (await res.json().catch(() => null)) as { pairs?: { chainId: string; baseToken?: { address?: string } }[] } | null;
    if (!body) return 'unreachable';
    const pairs = (body.pairs ?? []).filter((x) => x.chainId === 'solana' && x.baseToken?.address === mint);
    return pairs.length ? 'has-pairs' : 'no-pairs';
  }

  async fetchBestPair(mint: string): Promise<DexPair | null> {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res?.ok) return null;
    type Raw = {
      pairs?: {
        chainId: string;
        pairAddress?: string;
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
    const sorted = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const best = sorted[0];
    return {
      pairAddresses: sorted.slice(0, 3).map((p) => p.pairAddress).filter((a): a is string => Boolean(a)),
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
