import { Injectable } from '@nestjs/common';

const WSOL = 'So11111111111111111111111111111111111111112';
const PROBE_LAMPORTS = 100_000_000; // 0.1 SOL probe
// Jupiter's free quote endpoints (new lite host first, legacy as fallback)
const HOSTS = ['https://lite-api.jup.ag/swap/v1/quote', 'https://quote-api.jup.ag/v6/quote'];

export interface SellSimulation {
  buyRoute: boolean;
  sellRoute: boolean;
  roundTripLossPct: number | null; // 0.1 SOL -> token -> SOL, total cost in %
}

/**
 * Sell simulation via Jupiter round-trip quotes: if the aggregator can't route
 * a sell, nobody can. The round-trip loss measures effective exit cost — price
 * impact + fees + Token-2022 transfer tax — because a router cannot hide them.
 * (v2, TODO: simulateTransaction as a real holder to catch transfer-hook
 * honeypots that quote fine but revert on execution.)
 */
const PRICE_API = 'https://lite-api.jup.ag/price/v3';
const PRICE_BATCH = 50;
// Jupiter reprices every ~5s (measured 13 Sep: open-book prices changed on 5s
// boundaries); a shorter cache would only re-read the same number
const PRICE_CACHE_MS = 2_000;

@Injectable()
export class JupiterService {
  private readonly priceCache = new Map<string, { price: number; at: number }>();

  /**
   * USD prices for many mints, fresh. The exit guard's mark: DexScreener's batch
   * endpoint served the same snapshot for ~30s (13 Sep: 60 one-second polls,
   * every open token changed twice, on the same polls), so a stop checked
   * against it could only react every half minute however often we asked.
   * Missing mints are simply absent: the caller falls back.
   */
  async fetchPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const stale: string[] = [];
    for (const mint of new Set(mints)) {
      const hit = this.priceCache.get(mint);
      if (hit && Date.now() - hit.at < PRICE_CACHE_MS) out.set(mint, hit.price);
      else stale.push(mint);
    }
    for (let i = 0; i < stale.length; i += PRICE_BATCH) {
      const ids = stale.slice(i, i + PRICE_BATCH).join(',');
      const res = await fetch(`${PRICE_API}?ids=${ids}`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (!res?.ok) continue;
      const body = (await res.json().catch(() => ({}))) as Record<string, { usdPrice?: number } | null>;
      for (const [mint, row] of Object.entries(body ?? {})) {
        if (!row?.usdPrice || !(row.usdPrice > 0)) continue;
        out.set(mint, row.usdPrice);
        this.priceCache.set(mint, { price: row.usdPrice, at: Date.now() });
      }
    }
    return out;
  }

  async sellSimulation(mint: string): Promise<SellSimulation | null> {
    const buy = await this.quote(WSOL, mint, PROBE_LAMPORTS);
    if (buy === null) return { buyRoute: false, sellRoute: false, roundTripLossPct: null };
    const sell = await this.quote(mint, WSOL, buy);
    if (sell === null) return { buyRoute: true, sellRoute: false, roundTripLossPct: null };
    const loss = (1 - sell / PROBE_LAMPORTS) * 100;
    return { buyRoute: true, sellRoute: true, roundTripLossPct: Math.round(loss * 10) / 10 };
  }

  /**
   * v2 deep check: build the REAL sell transaction as the token's biggest live
   * holder and dry-run it on-chain. A transfer-hook honeypot quotes fine on
   * every aggregator and reverts only at execution — this is the only probe
   * that catches it, and it costs one free Jupiter call + one RPC simulate.
   */
  async buildSellTransaction(mint: string, holderOwner: string, amountRaw: string): Promise<string | null> {
    // sell a tenth of the bag — enough to exercise the hook, small enough to route cleanly
    const amount = Math.floor(Number(amountRaw) / 10);
    if (!amount) return null;
    for (const host of HOSTS) {
      const url = `${host}?inputMint=${mint}&outputMint=${WSOL}&amount=${amount}&slippageBps=3000&swapMode=ExactIn`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res?.ok) continue;
      const quote = (await res.json().catch(() => null)) as { outAmount?: string } | null;
      if (!quote?.outAmount) continue;
      const swapHost = host.replace(/\/quote$/, '/swap');
      const swapRes = await fetch(swapHost, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: holderOwner, wrapAndUnwrapSol: true }),
      }).catch(() => null);
      if (!swapRes?.ok) continue;
      const body = (await swapRes.json().catch(() => null)) as { swapTransaction?: string } | null;
      if (body?.swapTransaction) return body.swapTransaction;
    }
    return null;
  }

  /** Raw out amount for an exact-in quote, or null when unroutable. */
  private async quote(inputMint: string, outputMint: string, amountRaw: number): Promise<number | null> {
    for (const host of HOSTS) {
      const url = `${host}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountRaw)}&slippageBps=100&swapMode=ExactIn`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!res) continue;
      if (res.status === 400 || res.status === 404) return null; // no route
      if (!res.ok) continue; // try next host
      const body = (await res.json().catch(() => null)) as { outAmount?: string } | null;
      const out = body?.outAmount ? Number(body.outAmount) : null;
      if (out && out > 0) return out;
      return null;
    }
    return null;
  }
}
