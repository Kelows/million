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

  /** One page of enhanced txs strictly before a signature checkpoint. */
  async fetchPageBefore(address: string, before: string): Promise<HeliusTx[]> {
    const url = new URL(`${BASE}/addresses/${address}/transactions`);
    url.searchParams.set('api-key', this.key());
    url.searchParams.set('limit', '100');
    url.searchParams.set('before', before);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res?.ok) return [];
    return (await res.json()) as HeliusTx[];
  }

  /** SOL balance of an address, in SOL. */
  async getBalanceSol(address: string): Promise<number | null> {
    const result = await this.rpc<{ value: number }>('getBalance', [address]).catch(() => null);
    return result ? result.value / 1e9 : null;
  }

  /** Lifetime tx count + first-tx time from the cheap signature index (capped walk). */
  async accountStats(address: string, maxCalls = 10): Promise<{ txs: number; capped: boolean; firstTxAt: string | null }> {
    let before: string | undefined;
    let total = 0;
    let oldest: number | null = null;
    for (let i = 0; i < maxCalls; i++) {
      type SigRow = { signature: string; blockTime?: number | null };
      const page = await this.rpc<SigRow[]>('getSignaturesForAddress', [
        address,
        before ? { limit: 1000, before } : { limit: 1000 },
      ]).catch(() => null);
      if (!page?.length) return { txs: total, capped: false, firstTxAt: oldest ? new Date(oldest * 1000).toISOString() : null };
      total += page.length;
      const last = page[page.length - 1];
      if (last.blockTime) oldest = last.blockTime;
      if (page.length < 1000) return { txs: total, capped: false, firstTxAt: oldest ? new Date(oldest * 1000).toISOString() : null };
      before = last.signature;
    }
    return { txs: total, capped: true, firstTxAt: oldest ? new Date(oldest * 1000).toISOString() : null };
  }

  /** Current slot height. */
  getSlot(): Promise<number> {
    return this.rpc<number>('getSlot', []);
  }

  /** Any signature from a block near the given slot (skipped slots probed forward). */
  async signatureAtSlot(slot: number): Promise<string | null> {
    type Block = { signatures?: string[] };
    for (let probe = 0; probe < 5; probe++) {
      const block = await this.rpc<Block>('getBlock', [
        slot + probe * 2,
        { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0 },
      ]).catch(() => null);
      if (block?.signatures?.length) return block.signatures[block.signatures.length - 1];
    }
    return null;
  }

  /** The address's signatures immediately BEFORE a global cursor signature (time-travel read). */
  async signaturesBefore(address: string, before: string, limit = 50): Promise<{ sig: string; t: number }[]> {
    type SigRow = { signature: string; blockTime?: number | null };
    const page = await this.rpc<SigRow[]>('getSignaturesForAddress', [address, { limit, before }]).catch(() => null);
    return (page ?? []).map((r) => ({ sig: r.signature, t: (r.blockTime ?? 0) * 1000 }));
  }

  /**
   * Walk the cheap signature index (1000 sigs/call) back in time until sinceMs
   * or maxCalls — the time skeleton that lets deep scans sample a token's whole life.
   */
  async signatureIndex(address: string, sinceMs: number, maxCalls = 40): Promise<{ sig: string; t: number }[]> {
    type SigRow = { signature: string; blockTime?: number | null };
    const all: { sig: string; t: number }[] = [];
    let before: string | undefined;
    for (let i = 0; i < maxCalls; i++) {
      const page = await this.rpc<SigRow[]>('getSignaturesForAddress', [
        address,
        before ? { limit: 1000, before } : { limit: 1000 },
      ]).catch(() => null);
      if (!page?.length) break;
      for (const row of page) all.push({ sig: row.signature, t: (row.blockTime ?? 0) * 1000 });
      before = page[page.length - 1].signature;
      const oldest = page[page.length - 1].blockTime;
      if (oldest && oldest * 1000 < sinceMs) break;
      if (page.length < 1000) break;
    }
    return all;
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

      let res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) break; // no transaction history for this address
      // 429: retry with backoff — bursts (deep runs) must not poison analyses with empty data
      for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      }
      if (res.status === 429) {
        truncated = true; // still throttled after retries — give up on remaining pages
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
      signal: AbortSignal.timeout(30_000),
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
      mint_extensions?: Record<string, unknown>;
      token_info?: { mint_authority?: string | null; freeze_authority?: string | null; token_program?: string };
    };
    const result = await this.rpc<GetAssetResult | null>('getAsset', { id: mint }).catch(() => null);
    if (!result?.token_info) return null;
    return {
      mintAuthority: result.token_info.mint_authority ?? null,
      freezeAuthority: result.token_info.freeze_authority ?? null,
      mutable: result.mutable ?? null,
      tokenProgram: result.token_info.token_program ?? null,
      mintExtensions: result.mint_extensions ? Object.keys(result.mint_extensions) : [],
    };
  }

  /** Token accounts for a mint owned by `owner` — used to find a pool's LP vault accounts. */
  async getTokenAccountsByOwner(owner: string, mint: string): Promise<string[]> {
    type Result = { value?: { pubkey: string }[] };
    const result = await this.rpc<Result>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]).catch(() => null);
    return result?.value?.map((v) => v.pubkey) ?? [];
  }

  /** Top-10 largest token accounts as % of supply, excluding known LP vault accounts. */
  async getTopHolders(mint: string, excludeAccounts: Set<string> = new Set()): Promise<TopHolders | null> {
    type Largest = { value?: { address: string; uiAmount: number | null }[] };
    type Supply = { value?: { uiAmount: number | null } };
    const [largest, supply] = await Promise.all([
      this.rpc<Largest>('getTokenLargestAccounts', [mint]).catch(() => null),
      this.rpc<Supply>('getTokenSupply', [mint]).catch(() => null),
    ]);
    const total = supply?.value?.uiAmount;
    if (!largest?.value?.length || !total) return null;
    const amounts = largest.value.filter((v) => !excludeAccounts.has(v.address)).map((v) => v.uiAmount ?? 0);
    if (!amounts.length) return null;
    const top10 = amounts.slice(0, 10).reduce((s, a) => s + a, 0);
    return {
      top10Pct: (top10 / total) * 100,
      largestPct: (amounts[0] / total) * 100,
      excludedVaults: excludeAccounts.size,
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
  mintExtensions: string[]; // Token-2022 extension keys — where the real 2022 risk lives
}

export interface TopHolders {
  top10Pct: number;
  largestPct: number;
  excludedVaults: number;
}

export interface TokenMeta {
  symbol: string | null;
  name: string | null;
}

export interface HeliusAssetBatchItem {
  id: string;
  content?: { metadata?: { symbol?: string; name?: string } };
}
