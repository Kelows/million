import { Global, Injectable, Module } from '@nestjs/common';

// Raydium SOL/USDC, the deepest SOL/USDC pool on GeckoTerminal ($31M, 13 Sep)
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const HOUR = 3600;
const DAY = 86400;
const REFRESH_MS = 30 * 60_000;

export type SolPriceAt = (unixSeconds: number) => number;

/**
 * SOL/USD at any moment of a wallet's history, so a trade paid in USDC is
 * converted to SOL at the price of ITS day, not today's.
 *
 * Every amount a wallet spent, received or made is shown in SOL. A stable-paid
 * trade used to show only its SOL leg (8TWL bought $17,502 of EMBER and the
 * wallet page said "SOL in 0.01"), while realized PnL added the dollar leg at a
 * hard-coded $200 SOL. One unit, converted at trade time, removes both.
 *
 * Hourly candles reach ~41 days back, daily ones ~6 months; older trades use
 * the oldest daily close, and with no candles at all the current price.
 */
@Injectable()
export class SolPriceService {
  private hourly = new Map<number, number>();
  private daily = new Map<number, number>();
  private oldestDay = Infinity;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  /** A lookup for this moment's candles; `fallbackUsd` covers the case where none could be fetched. */
  async lookup(fallbackUsd: number): Promise<SolPriceAt> {
    if (Date.now() - this.loadedAt > REFRESH_MS) {
      this.loading ??= this.load().finally(() => (this.loading = null));
      await this.loading;
    }
    const hourly = this.hourly;
    const daily = this.daily;
    const oldestDay = this.oldestDay;
    return (ts) =>
      hourly.get(Math.floor(ts / HOUR) * HOUR) ??
      daily.get(Math.floor(ts / DAY) * DAY) ??
      (ts < oldestDay ? daily.get(oldestDay) : undefined) ??
      fallbackUsd;
  }

  private async load(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const [hours, days] = await Promise.all([this.candles('hour', now), this.candles('day', now)]);
    if (hours.size) this.hourly = hours;
    if (days.size) {
      this.daily = days;
      this.oldestDay = Math.min(...days.keys());
    }
    // a failed load retries on the next lookup instead of waiting out the refresh window
    if (hours.size || days.size) this.loadedAt = Date.now();
  }

  private async candles(timeframe: 'hour' | 'day', beforeTs: number): Promise<Map<number, number>> {
    const url = `${GT}/${POOL}/ohlcv/${timeframe}?aggregate=1&before_timestamp=${beforeTs}&limit=1000&currency=usd&token=base`;
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) return new Map();
    const body = (await res.json().catch(() => null)) as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null;
    const out = new Map<number, number>();
    for (const c of body?.data?.attributes?.ohlcv_list ?? []) {
      if (c.length >= 5 && c[4] > 0) out.set(c[0], c[4]); // bucket start → close
    }
    return out;
  }
}

@Global()
@Module({ providers: [SolPriceService], exports: [SolPriceService] })
export class SolPriceModule {}
