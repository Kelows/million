import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WalletImport, WalletRecord } from '@million/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.message
      ? Array.isArray(body.message) ? body.message.join('; ') : body.message
      : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  heliusConfigured: boolean;
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => request<Health>('/health'), refetchInterval: 30_000 });
}

export function useWallets() {
  return useQuery({ queryKey: ['wallets'], queryFn: () => request<WalletRecord[]>('/wallets') });
}

export function useWallet(address: string) {
  return useQuery({ queryKey: ['wallets', address], queryFn: () => request<WalletRecord>(`/wallets/${address}`) });
}

export function useImportWallets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: WalletImport) =>
      request<{ imported: number; skipped: number }>('/wallets/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

export function useAnalyzeWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => request<WalletRecord>(`/wallets/${address}/analyze`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

export function useRemoveWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => request<void>(`/wallets/${address}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

import type { TokenCheckThresholds, TokenReport } from '@million/shared';

export function useTokenReport(mint: string | null, thresholds: TokenCheckThresholds) {
  const params = new URLSearchParams(Object.entries(thresholds).map(([k, v]) => [k, String(v)]));
  return useQuery({
    queryKey: ['token-report', mint, thresholds],
    queryFn: () => request<TokenReport>(`/screener/token/${mint}?${params}`),
    enabled: mint !== null,
    staleTime: 30_000,
    retry: 0,
  });
}

import type { RecommendationsData } from '@million/shared';
import { loadMinOpenSol } from './lib/settings';

export function useRecommendations() {
  return useQuery({ queryKey: ['recommendations'], queryFn: () => request<RecommendationsData | null>('/recommendations') });
}

export function useRunRecommendations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<RecommendationsData>(`/recommendations/run?minOpenSol=${loadMinOpenSol()}`, { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['recommendations'], data),
  });
}

import type { FundingReport } from '@million/shared';

export function useFundingChains(address: string | null, minSol: number) {
  return useQuery({
    queryKey: ['funding', address, minSol],
    queryFn: () => request<FundingReport>(`/funding/${address}?minSol=${minSol}`),
    enabled: address !== null,
    staleTime: 60_000,
    retry: 0,
  });
}

import type { DiscoveryReport } from '@million/shared';

export function useDiscovery(mint: string | null, minSol: number) {
  return useQuery({
    queryKey: ['discovery', mint, minSol],
    queryFn: () => request<DiscoveryReport>(`/discovery/token/${mint}?minSol=${minSol}`),
    enabled: mint !== null,
    staleTime: 60_000,
    retry: 0,
  });
}

import type { GemsRunData } from '@million/shared';
import { loadFailsafes } from './lib/failsafes';

export function useGems() {
  return useQuery({ queryKey: ['gems'], queryFn: () => request<GemsRunData | null>('/gems') });
}

export function useRunGems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const params = new URLSearchParams(
        Object.entries({ ...loadFailsafes(), minOpenSol: loadMinOpenSol() }).map(([k, v]) => [k, String(v)]),
      );
      return request<GemsRunData>(`/gems/run?${params}`, { method: 'POST' });
    },
    onSuccess: (data) => qc.setQueryData(['gems'], data),
  });
}

import type { TokenDetailData, TrackedToken } from '@million/shared';

export function useTokens() {
  return useQuery({ queryKey: ['tokens'], queryFn: () => request<TrackedToken[]>('/tokens') });
}

export function useTokenDetail(mint: string) {
  return useQuery({ queryKey: ['tokens', mint], queryFn: () => request<TokenDetailData>(`/tokens/${mint}`) });
}

export function useImportTokens() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { mints: string[]; source?: string }) =>
      request<{ imported: number; skipped: number }>('/tokens/import', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
}

export function useCheckToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mint: string) => {
      const params = new URLSearchParams(Object.entries(loadFailsafes()).map(([k, v]) => [k, String(v)]));
      return request<TokenDetailData>(`/tokens/${mint}/check?${params}`, { method: 'POST' });
    },
    onSuccess: (data, mint) => {
      qc.setQueryData(['tokens', mint], data);
      qc.invalidateQueries({ queryKey: ['tokens'], exact: true });
    },
  });
}

export function useUntrackToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mint: string) => request<void>(`/tokens/${mint}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
}

import type { CrawlerConfig, CrawlerStatus } from '@million/shared';

export function useCrawler() {
  return useQuery({
    queryKey: ['crawler'],
    queryFn: () => request<CrawlerStatus>('/crawler'),
    refetchInterval: 10_000,
  });
}

export function useSetCrawlerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: CrawlerConfig) =>
      request<CrawlerConfig>('/crawler/config', { method: 'PUT', body: JSON.stringify(config) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crawler'] }),
  });
}

export function useRunCrawlerOnce() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ started: boolean }>('/crawler/run-once', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crawler'] }),
  });
}
