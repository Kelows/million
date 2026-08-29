import { Injectable } from '@nestjs/common';

const GT = 'https://api.geckoterminal.com/api/v2';
const MIN_GAP_MS = 2_600; // free tier ≈ 30 calls/min — stay under it
const RETRY_429_MS = 20_000; // the free quota refills per minute — wait it out, don't lose the token

export type Candle = { ts: number; open: number; close: number }; // unix seconds, USD

/**
 * Minute OHLCV for a pool. The copyability measurement's price source: one
 * consistent tape for both the whale's fill and the delayed copier fill, so
 * the comparison can't be skewed by mixing price sources.
 */
@Injectable()
export class GeckoTerminalService {
  private lastCall = 0;

  /** Up to `limit` minute candles ending at `beforeTs` (unix seconds), sorted ascending. */
  async minuteCandles(pool: string, beforeTs: number, limit = 40): Promise<Candle[]> {
    limit = Math.min(limit, 500); // GeckoTerminal caps at 500 per call; 1000 errors
    const url = `${GT}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${beforeTs}&limit=${limit}&currency=usd&token=base`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle();
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (res?.status !== 429) break;
      // a 429 skip would silently misreport the wallet as unmeasurable — waiting is the honest option
      await new Promise((r) => setTimeout(r, RETRY_429_MS * (attempt + 1)));
    }
    if (!res?.ok) return [];
    const body = (await res.json().catch(() => null)) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
    const list = body?.data?.attributes?.ohlcv_list ?? [];
    return list
      .filter((c) => c.length >= 5 && c[1] > 0 && c[4] > 0)
      .map((c) => ({ ts: c[0], open: c[1], close: c[4] }))
      .sort((a, b) => a.ts - b.ts);
  }

  /** The candle covering `ts`, or the nearest one after it within `toleranceSec`. Sparse tapes are normal on memecoins. */
  candleAt(candles: Candle[], ts: number, toleranceSec = 300): Candle | null {
    const minute = Math.floor(ts / 60) * 60;
    return candles.find((c) => c.ts >= minute && c.ts <= minute + toleranceSec) ?? null;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCall + MIN_GAP_MS - Date.now();
    this.lastCall = Math.max(Date.now(), this.lastCall + MIN_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
