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
@Injectable()
export class JupiterService {
  async sellSimulation(mint: string): Promise<SellSimulation | null> {
    const buy = await this.quote(WSOL, mint, PROBE_LAMPORTS);
    if (buy === null) return { buyRoute: false, sellRoute: false, roundTripLossPct: null };
    const sell = await this.quote(mint, WSOL, buy);
    if (sell === null) return { buyRoute: true, sellRoute: false, roundTripLossPct: null };
    const loss = (1 - sell / PROBE_LAMPORTS) * 100;
    return { buyRoute: true, sellRoute: true, roundTripLossPct: Math.round(loss * 10) / 10 };
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
