import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface HeliusTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  mint: string;
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  amount: number; // lamports
}

export interface HeliusTx {
  signature: string;
  timestamp: number; // unix seconds
  type: string;
  source: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
}

const BASE = 'https://api.helius.xyz/v0';

@Injectable()
export class HeliusService {
  constructor(private readonly config: ConfigService) {}

  get hasKey(): boolean {
    return Boolean(this.config.get<string>('HELIUS_API_KEY'));
  }

  private key(): string {
    const key = this.config.get<string>('HELIUS_API_KEY');
    if (!key) {
      throw new ServiceUnavailableException(
        'HELIUS_API_KEY is not set. Add it to apps/api/.env (free key at dashboard.helius.dev).',
      );
    }
    return key;
  }

  /** Fetch swap transactions for an address, newest first, up to maxPages * 100 txs. */
  async fetchSwaps(address: string, maxPages: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    const key = this.key();
    const txs: HeliusTx[] = [];
    let before: string | undefined;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${BASE}/addresses/${address}/transactions`);
      url.searchParams.set('api-key', key);
      url.searchParams.set('type', 'SWAP');
      url.searchParams.set('limit', '100');
      if (before) url.searchParams.set('before', before);

      const res = await fetch(url);
      if (res.status === 429) {
        // rate limited — return what we have rather than failing the whole analysis
        truncated = true;
        break;
      }
      if (!res.ok) {
        throw new ServiceUnavailableException(`Helius responded ${res.status} for ${address}`);
      }
      const batch = (await res.json()) as HeliusTx[];
      txs.push(...batch);
      if (batch.length < 100) break;
      before = batch[batch.length - 1].signature;
      if (page === maxPages - 1) truncated = true;
    }
    return { txs, truncated };
  }
}
