import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CopyabilityJobStatus, CopyabilityWalletRow, FamousTokens, ShadowGuardStat, TradingHalt, WalletImport, WalletRecord } from '@million/shared';

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
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T; // DELETEs return empty bodies
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
    staleTime: 30 * 60_000, // traces survive navigation — come back and it's still here
    gcTime: 60 * 60_000,
    retry: 0,
  });
}

import type { DiscoveryReport } from '@million/shared';

export interface DiscoveryParams {
  mint: string;
  minSol: number;
  mode: 'recent' | 'deep';
  sinceDays: number;
  buckets: number;
}

/** Runs only when params are set by an explicit Scan — knob changes never auto-fire a scan.
 * Results cache for 30 min and the fetch survives navigation, so a scan keeps
 * working while you browse and is still there when you come back. */
export function useDiscovery(params: DiscoveryParams | null) {
  return useQuery({
    queryKey: ['discovery', params],
    queryFn: () =>
      request<DiscoveryReport>(
        `/discovery/token/${params!.mint}?minSol=${params!.minSol}&mode=${params!.mode}&sinceDays=${params!.sinceDays}&buckets=${params!.buckets}`,
      ),
    enabled: params !== null,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
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
    mutationFn: (mint: string) => request<TokenDetailData>(`/tokens/${mint}/check`, { method: 'POST' }), // thresholds resolve server-side from the crawler config
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
    mutationFn: (mode: 'once' | 'deep' | 'stop') =>
      request<{ started?: boolean; stopping?: boolean }>(
        mode === 'stop' ? '/crawler/stop-run' : `/crawler/run-${mode === 'deep' ? 'deep' : 'once'}`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crawler'] }),
  });
}

export function usePurgeJunk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (criteria: { flags: string[]; maxPnlSol?: number; maxMedianHoldMin?: number }) =>
      request<{ purged: number }>('/wallets/purge-junk', { method: 'POST', body: JSON.stringify(criteria) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

export function usePurgeJunkTokens() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ purged: number }>('/tokens/purge-junk', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });
}

import type { LiveEventRow, LiveStatus } from '@million/shared';

export function useLiveStatus() {
  return useQuery({ queryKey: ['live-status'], queryFn: () => request<LiveStatus>('/live/status'), refetchInterval: 10_000 });
}

export function useLiveEvents(limit = 100) {
  return useQuery({
    queryKey: ['live-events', limit],
    queryFn: () => request<LiveEventRow[]>(`/live/events?limit=${limit}`),
    refetchInterval: 60_000, // backstop — SSE invalidates instantly
  });
}

export function useSetSubscribed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ address, subscribed }: { address: string; subscribed: boolean }) =>
      request<WalletRecord>(`/wallets/${address}/subscribe`, { method: 'PUT', body: JSON.stringify({ subscribed }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['live-status'] });
    },
  });
}

import type { OpportunityConfig, OpportunityRow } from '@million/shared';

export function useOpportunities() {
  return useQuery({
    queryKey: ['opportunities'],
    queryFn: () => request<OpportunityRow[]>('/opportunities'),
    refetchInterval: 60_000, // backstop — SSE invalidates instantly
  });
}

export function useOpportunityConfig() {
  return useQuery({ queryKey: ['opportunity-config'], queryFn: () => request<OpportunityConfig>('/opportunities/config') });
}

export function useSetOpportunityConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: OpportunityConfig) =>
      request<OpportunityConfig>('/opportunities/config', { method: 'PUT', body: JSON.stringify(config) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['opportunity-config'] }),
  });
}

import type { MoverToken } from '@million/shared';

export interface MoversParams {
  minPump: number;
  minMcap: number;
  maxMcap: number;
}

/** Fires only when params are set by an explicit Search click. */
export function useMovers(params: MoversParams | null) {
  return useQuery({
    queryKey: ['movers', params],
    queryFn: () => request<MoverToken[]>(`/tokens/movers?minPump=${params!.minPump}&minMcap=${params!.minMcap}&maxMcap=${params!.maxMcap}`),
    enabled: params !== null,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

export function useSubscribeOwner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ address, subscribed }: { address: string; subscribed: boolean }) =>
      request<{ affected: number }>(`/wallets/${address}/subscribe-owner`, { method: 'PUT', body: JSON.stringify({ subscribed }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['live-status'] });
    },
  });
}

import type { PaperPositionRow, TradingStats } from '@million/shared';

export interface TradingOverview {
  stats: TradingStats;
  open: PaperPositionRow[];
  closed: PaperPositionRow[];
  halt: TradingHalt;
}

export function useTrading() {
  return useQuery({ queryKey: ['trading'], queryFn: () => request<TradingOverview>('/trading'), refetchInterval: 30_000 });
}

export function useClosePosition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<{ closed: number }>(`/trading/${id}/close`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trading'] }),
  });
}

/** One SSE connection for the whole app: backend events instantly invalidate
 * the matching queries — polling intervals become slow backstops. */
export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/live/stream');
    es.onmessage = (msg) => {
      try {
        const { type, data } = JSON.parse(msg.data) as { type: string; data?: unknown };
        if (type === 'live_event') {
          qc.invalidateQueries({ queryKey: ['live-events'] });
          qc.invalidateQueries({ queryKey: ['live-status'] });
          qc.invalidateQueries({ queryKey: ['emitters'] });
        } else if (type === 'opportunity') {
          qc.invalidateQueries({ queryKey: ['opportunities'] });
          qc.invalidateQueries({ queryKey: ['wallets'] }); // rotations add wallets
        } else if (type === 'paper_trade') {
          qc.invalidateQueries({ queryKey: ['trading'] });
          if (data) window.dispatchEvent(new CustomEvent('trade-toast', { detail: data }));
        } else if (type === 'crawler_run') {
          qc.invalidateQueries({ queryKey: ['crawler'] });
        } else if (type === 'wallet_analyzed') {
          qc.invalidateQueries({ queryKey: ['wallets'] });
          qc.invalidateQueries({ queryKey: ['analyze-pending'] });
        } else if (type === 'token_checked') {
          qc.invalidateQueries({ queryKey: ['tokens'] });
          qc.invalidateQueries({ queryKey: ['recheck-all'] });
        } else if (type === 'copyability') {
          qc.invalidateQueries({ queryKey: ['copyability'] });
          qc.invalidateQueries({ queryKey: ['copyability-status'] });
        }
      } catch {
        /* malformed frame — ignore */
      }
    };
    return () => es.close();
  }, [qc]);
}

export function useSetLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ address, label }: { address: string; label: string | null }) =>
      request<WalletRecord>(`/wallets/${address}/label`, { method: 'PUT', body: JSON.stringify({ label }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wallets'] }),
  });
}

export interface AnalyzePendingJob {
  running: boolean;
  done: number;
  total: number;
}

export function useAnalyzePendingJob() {
  return useQuery({
    queryKey: ['analyze-pending'],
    queryFn: () => request<AnalyzePendingJob>('/wallets/jobs/analyze-pending'),
    refetchInterval: 10_000,
  });
}

export function useStartAnalyzePending() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ started: boolean }>('/wallets/analyze-pending', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['analyze-pending'] }),
  });
}

export function useRecheckAllJob() {
  return useQuery({
    queryKey: ['recheck-all'],
    queryFn: () => request<AnalyzePendingJob>('/tokens/jobs/recheck-all'),
    refetchInterval: 10_000,
  });
}

export function useStartRecheckAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      return request<{ started: boolean }>('/tokens/recheck-all', { method: 'POST' }); // thresholds resolve server-side
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recheck-all'] }),
  });
}

import type { CohortRow } from '@million/shared';

export function useCohorts() {
  return useQuery({ queryKey: ['cohorts'], queryFn: () => request<CohortRow[]>('/wallets/cohorts'), staleTime: 5 * 60_000 });
}

export interface EmitterRow {
  wallet: string;
  label: string | null;
  events: number;
  subscribed: boolean;
  flags: string[] | null;
  medianHoldMinutes: number | null;
}

export function useEmitters() {
  return useQuery({ queryKey: ['emitters'], queryFn: () => request<EmitterRow[]>('/live/emitters'), refetchInterval: 30_000 });
}

export function useCopyability() {
  return useQuery({ queryKey: ['copyability'], queryFn: () => request<CopyabilityWalletRow[]>('/copyability') });
}

export function useCopyabilityStatus() {
  return useQuery({
    queryKey: ['copyability-status'],
    queryFn: () => request<CopyabilityJobStatus>('/copyability/status'),
    refetchInterval: (q) => (q.state.data?.running ? 2_500 : false),
  });
}

export function useRunCopyability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { addresses?: string[]; top?: number }) =>
      request<{ started: boolean }>('/copyability/run', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['copyability-status'] }),
  });
}

export function useFamousTokens() {
  return useQuery({ queryKey: ['tokens', 'famous'], queryFn: () => request<FamousTokens>('/tokens/famous') });
}

export function useResumeTrading() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<TradingHalt>('/trading/resume', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trading'] });
      qc.invalidateQueries({ queryKey: ['opportunity-config'] });
    },
  });
}

export function useUnsubscribeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ unsubscribed: number }>('/wallets/unsubscribe-all', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wallets'] });
      qc.invalidateQueries({ queryKey: ['live-status'] });
    },
  });
}

export function useShadowStats() {
  return useQuery({ queryKey: ['trading', 'shadow'], queryFn: () => request<ShadowGuardStat[]>('/trading/shadow'), refetchInterval: 60_000 });
}
