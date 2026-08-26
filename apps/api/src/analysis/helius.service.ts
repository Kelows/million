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
  feePayer?: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  accountData?: { account: string; nativeBalanceChange: number }[];
}

const BASE = 'https://api.helius.xyz/v0';
const RPC = 'https://mainnet.helius-rpc.com';

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
  fetchSwaps(address: string, maxPages: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    return this.fetchTxs(address, 'SWAP', maxPages);
  }

  /** Fetch native transfer transactions for an address, newest first. */
  fetchTransfers(address: string, maxPages: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    return this.fetchTxs(address, 'TRANSFER', maxPages);
  }

  /** Fetch ALL transaction types — custom-program swaps hide behind type UNKNOWN. */
  fetchHistory(address: string, maxPages: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    return this.fetchTxs(address, '', maxPages);
  }

  private async fetchTxs(address: string, type: string, maxPages: number): Promise<{ txs: HeliusTx[]; truncated: boolean }> {
    const key = this.key();
    const txs: HeliusTx[] = [];
    let before: string | undefined;
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${BASE}/addresses/${address}/transactions`);
      url.searchParams.set('api-key', key);
      if (type) url.searchParams.set('type', type);
      url.searchParams.set('limit', '100');
      if (before) url.searchParams.set('before', before);

      const res = await fetch(url);
      if (res.status === 404) break; // no transaction history for this address
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

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(`${RPC}/?api-key=${this.key()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Helius RPC ${method} responded ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new ServiceUnavailableException(`Helius RPC ${method}: ${body.error.message ?? 'error'}`);
    return body.result as T;
  }

  /** Mint-level authorities and metadata flags via DAS getAsset. Null if the asset is unknown. */
  async getAssetInfo(mint: string): Promise<AssetInfo | null> {
    type GetAssetResult = {
      mutable?: boolean;
      token_info?: { mint_authority?: string | null; freeze_authority?: string | null; token_program?: string };
    };
    const result = await this.rpc<GetAssetResult | null>('getAsset', { id: mint }).catch(() => null);
    if (!result?.token_info) return null;
    return {
      mintAuthority: result.token_info.mint_authority ?? null,
      freezeAuthority: result.token_info.freeze_authority ?? null,
      mutable: result.mutable ?? null,
      tokenProgram: result.token_info.token_program ?? null,
    };
  }

  /** Top-10 largest token accounts as % of supply (the LP vault is usually among them). */
  async getTopHolders(mint: string): Promise<TopHolders | null> {
    type Largest = { value?: { uiAmount: number | null }[] };
    type Supply = { value?: { uiAmount: number | null } };
    const [largest, supply] = await Promise.all([
      this.rpc<Largest>('getTokenLargestAccounts', [mint]).catch(() => null),
      this.rpc<Supply>('getTokenSupply', [mint]).catch(() => null),
    ]);
    const total = supply?.value?.uiAmount;
    if (!largest?.value?.length || !total) return null;
    const amounts = largest.value.map((v) => v.uiAmount ?? 0);
    const top10 = amounts.slice(0, 10).reduce((s, a) => s + a, 0);
    return {
      top10Pct: (top10 / total) * 100,
      largestPct: (amounts[0] / total) * 100,
    };
  }

  /** Batch token metadata via DAS getAssetBatch — one call per 1000 mints, same API key. */
  async fetchTokenMeta(mints: string[]): Promise<Map<string, TokenMeta>> {
    const out = new Map<string, TokenMeta>();
    if (!this.hasKey || mints.length === 0) return out;
    for (let i = 0; i < mints.length; i += 1000) {
      const res = await fetch(`${RPC}/?api-key=${this.key()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'asset-batch',
          method: 'getAssetBatch',
          params: { ids: mints.slice(i, i + 1000) },
        }),
      });
      if (!res.ok) return out; // metadata is a nice-to-have — never fail the analysis over it
      const body = (await res.json()) as { result?: (HeliusAssetBatchItem | null)[] };
      for (const item of body.result ?? []) {
        if (!item) continue;
        out.set(item.id, {
          symbol: item.content?.metadata?.symbol?.trim() || null,
          name: item.content?.metadata?.name?.trim() || null,
        });
      }
    }
    return out;
  }
}

export interface AssetInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mutable: boolean | null;
  tokenProgram: string | null;
}

export interface TopHolders {
  top10Pct: number;
  largestPct: number;
}

export interface TokenMeta {
  symbol: string | null;
  name: string | null;
}

export interface HeliusAssetBatchItem {
  id: string;
  content?: { metadata?: { symbol?: string; name?: string } };
}
