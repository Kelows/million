import { useEffect, useRef, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useAnalyzePendingJob, useAnalyzeWallet, useHealth, useImportWallets, usePurgeJunk, useRemoveWallet, useStartAnalyzePending, useWallets } from '../api';
import { createPortal } from 'react-dom';
import { FlagChip, FLAG_OPTIONS } from '../components/FlagChip';
import { Addr } from '../components/Addr';
import { parseWalletsJson } from '../lib/parseWallets';
import { fmtAgo, fmtHold, fmtPct, fmtSol, totalPnlSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { applyFilters, useStoredFilters, type FilterField } from '../lib/useTableFilters';
import { usePagination } from '../lib/usePagination';
import { loadMinOpenSol } from '../lib/settings';
import { FilterModal } from '../components/FilterModal';
import { Pagination } from '../components/Pagination';
import { SortHeader } from '../components/SortHeader';
import { EyeIcon } from '../components/icons';
import { isBotWallet, isJunkWallet, openPositions, whaleScore, type WalletRecord } from '@million/shared';

function openCount(w: WalletRecord): number | null {
  if (!w.metrics) return null;
  return openPositions(w.metrics.tokens, loadMinOpenSol()).length;
}

const ROSTER_FILTERS: FilterField<WalletRecord>[] = [
  { key: 'openOnly', label: 'open positions only (excl. stables)', type: 'toggle', get: (w) => (openCount(w) ?? 0) > 0 },
  { key: 'excludeFlags', label: 'Exclude tags', type: 'multi', options: FLAG_OPTIONS, get: (w) => w.metrics?.flags ?? [] },
  { key: 'minWinRate', label: 'Win rate', type: 'min', unit: '%', get: (w) => (w.metrics?.winRate == null ? null : w.metrics.winRate * 100) },
  { key: 'minPnl', label: 'Realized PnL', type: 'min', unit: 'SOL', get: (w) => totalPnlSol(w.metrics) },
  { key: 'minOpen', label: 'Open positions', type: 'min', unit: 'count', get: (w) => openCount(w) },
  { key: 'maxInactiveDays', label: 'Days since active', type: 'max', unit: 'days', get: (w) => (w.metrics?.lastSeen ? (Date.now() - new Date(w.metrics.lastSeen).getTime()) / 86_400_000 : null) },
];

function rosterScore(w: WalletRecord): number | null {
  if (!w.metrics) return null;
  if (isBotWallet(w.metrics)) return null; // bots aren't scored — the flags say why
  return whaleScore(w.metrics.winRate, w.metrics.realizedPnlTotalSol ?? w.metrics.realizedPnlSol, false);
}

/** Grouped roster: an owner cluster collapses into one sortable row. */
export type RosterRow =
  | { kind: 'wallet'; w: WalletRecord }
  | { kind: 'owner'; ownerId: number; members: WalletRecord[] };

function groupAgg(members: WalletRecord[]) {
  let pnl = 0;
  let wins = 0;
  let closed = 0;
  const openMints = new Set<string>();
  let lastSeen = 0;
  let anyClean = false;
  for (const w of members) {
    const m = w.metrics;
    if (!m) continue;
    pnl += m.realizedPnlTotalSol ?? m.realizedPnlSol;
    if (!isBotWallet(m)) {
      anyClean = true;
      closed += m.closedTokens;
      if (m.winRate !== null) wins += Math.round(m.winRate * m.closedTokens);
    }
    for (const t of openPositions(m.tokens, loadMinOpenSol())) openMints.add(t.mint);
    if (m.lastSeen) lastSeen = Math.max(lastSeen, new Date(m.lastSeen).getTime());
  }
  const winRate = closed ? wins / closed : null;
  return {
    pnl,
    winRate,
    open: openMints.size,
    lastSeen: lastSeen || null,
    score: anyClean ? whaleScore(winRate, pnl, false) : null,
  };
}

const rowGet = {
  label: (r: RosterRow) => (r.kind === 'wallet' ? r.w.label : (r.members.find((m) => m.label)?.label ?? null)),
  score: (r: RosterRow) => (r.kind === 'wallet' ? rosterScore(r.w) : groupAgg(r.members).score),
  winRate: (r: RosterRow) => (r.kind === 'wallet' ? (r.w.metrics?.winRate ?? null) : groupAgg(r.members).winRate),
  pnl: (r: RosterRow) => (r.kind === 'wallet' ? totalPnlSol(r.w.metrics) : groupAgg(r.members).pnl),
  hold: (r: RosterRow) => (r.kind === 'wallet' ? (r.w.metrics?.medianHoldMinutes ?? null) : null),
  open: (r: RosterRow) => (r.kind === 'wallet' ? openCount(r.w) : groupAgg(r.members).open),
  lastSeen: (r: RosterRow) =>
    r.kind === 'wallet' ? (r.w.metrics?.lastSeen ? new Date(r.w.metrics.lastSeen).getTime() : null) : groupAgg(r.members).lastSeen,
};

const ROW_COLUMNS: SortColumn<RosterRow>[] = Object.entries(rowGet).map(([key, get]) => ({ key, get }));

const ROSTER_COLUMNS: SortColumn<WalletRecord>[] = [
  { key: 'label', get: (w) => w.label },
  { key: 'score', get: (w) => rosterScore(w) },
  { key: 'winRate', get: (w) => w.metrics?.winRate ?? null },
  { key: 'pnl', get: (w) => totalPnlSol(w.metrics) },
  { key: 'hold', get: (w) => w.metrics?.medianHoldMinutes ?? null },
  { key: 'open', get: (w) => openCount(w) },
  { key: 'lastSeen', get: (w) => (w.metrics?.lastSeen ? new Date(w.metrics.lastSeen).getTime() : null) },
];

export function Wallets() {
  const { data: wallets = [] } = useWallets();
  const health = useHealth();
  const importWallets = useImportWallets();
  const analyze = useAnalyzeWallet();
  const removeWallet = useRemoveWallet();
  const purgeJunk = usePurgeJunk();
  const pendingJob = useAnalyzePendingJob();
  const startPending = useStartAnalyzePending();
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useStoredFilters('million.filters.roster');
  const [search, setSearch] = useState('');
  const [groupOwners, setGroupOwners] = useState(() => {
    try { return localStorage.getItem('million.groupOwners') !== 'off'; } catch { return true; }
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeFlags, setPurgeFlags] = useState<Set<string>>(new Set(['BOT_INFRA']));
  const fileRef = useRef<HTMLInputElement>(null);
  const heliusOk = health.data?.heliusConfigured ?? false;

  const doImport = (text: string) => {
    setParseError(null);
    setImportResult(null);
    try {
      const parsed = parseWalletsJson(text);
      importWallets.mutate(
        { wallets: parsed, source: source || undefined },
        {
          onSuccess: (r) => {
            setImportResult(`Imported ${r.imported} new wallet${r.imported === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already in the roster` : ''}.`);
            setRaw('');
          },
          onError: (e) => setParseError(e.message),
        },
      );
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Could not parse that input.');
    }
  };

  const runAnalysis = async (addresses: string[]) => {
    setAnalyzing(new Set(addresses));
    // sequential to stay inside Helius free-tier rate limits
    for (const address of addresses) {
      await analyze.mutateAsync(address).catch(() => {});
      setAnalyzing((prev) => {
        const next = new Set(prev);
        next.delete(address);
        return next;
      });
    }
  };

  const pending = wallets.filter((w) => !w.metrics && w.status !== 'analyzing');
  const junkCount = wallets.filter((w) => w.metrics && isJunkWallet(w.metrics)).length;
  const query = search.trim().toLowerCase();
  const searched = query
    ? wallets.filter(
        (w) =>
          w.address.toLowerCase().includes(query) ||
          w.label?.toLowerCase().includes(query) ||
          w.metrics?.flags.some((f) => {
            const label = FLAG_OPTIONS.find((o) => o.value === f)?.label ?? f;
            return f.toLowerCase().includes(query) || label.toLowerCase().includes(query);
          }),
      )
    : wallets;
  const filtered = applyFilters(searched, ROSTER_FILTERS, filters);
  const rows: RosterRow[] = (() => {
    if (!groupOwners) return filtered.map((w) => ({ kind: 'wallet' as const, w }));
    const byOwner = new Map<number, WalletRecord[]>();
    const singles: RosterRow[] = [];
    for (const w of filtered) {
      if (w.ownerId) {
        const list = byOwner.get(w.ownerId) ?? [];
        list.push(w);
        byOwner.set(w.ownerId, list);
      } else singles.push({ kind: 'wallet', w });
    }
    const groups: RosterRow[] = [];
    for (const [ownerId, members] of byOwner) {
      if (members.length > 1) groups.push({ kind: 'owner', ownerId, members });
      else singles.push({ kind: 'wallet', w: members[0] });
    }
    return [...groups, ...singles];
  })();
  const urlSearch = getRouteApi('/wallets').useSearch();
  const navigate = useNavigate();
  const { sorted, sortKey, dir, toggle } = useTableSort(
    rows,
    ROW_COLUMNS,
    urlSearch.sort ?? 'lastSeen',
    urlSearch.dir ?? 'desc',
  );
  useEffect(() => {
    void navigate({ to: '/wallets', search: { sort: sortKey ?? undefined, dir }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, dir]);
  const pag = usePagination(sorted, 25);

  const toggleGroup = (ownerId: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Wallets</h1>
        <p className="text-sm text-dim mt-1">Import the whale JSON, then analyze each wallet's recent swap history.</p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <span className="eyebrow">Import</span>
        <textarea
          rows={5}
          placeholder='Paste the whale JSON here — arrays, objects, or plain addresses all work'
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="w-full resize-y"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input
            placeholder="source tag (e.g. friend-batch-1)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-56"
          />
          <button className="btn" disabled={!raw.trim() || importWallets.isPending} onClick={() => doImport(raw)}>
            {importWallets.isPending ? 'Importing…' : 'Import'}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>Load .json file</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) doImport(await file.text());
              e.target.value = '';
            }}
          />
        </div>
        {parseError && <p className="text-xs text-loss">{parseError}</p>}
        {importResult && <p className="text-xs text-profit">{importResult}</p>}
      </div>

      {!heliusOk && (
        <div className="panel p-3 text-xs text-warn border-warn!">
          Analysis needs a Helius API key. Add HELIUS_API_KEY to apps/api/.env (free at dashboard.helius.dev) and restart the API.
        </div>
      )}

      <div className="panel">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4">
          <span className="eyebrow">Roster · {sorted.length !== wallets.length ? `${sorted.length} / ${wallets.length}` : wallets.length}</span>
          <span className="mr-auto flex items-center gap-3">
            <FilterModal fields={ROSTER_FILTERS} state={filters} onChange={setFilters} />
            <button
              className="btn btn-danger py-1! px-2! text-[0.6rem]!"
              title="Choose which flags to sweep from the roster (soft-delete — knowledge kept)"
              onClick={() => setPurgeOpen(true)}
            >
              purge…
            </button>
            {purgeOpen &&
              createPortal(
                <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setPurgeOpen(false)}>
                  <div className="panel panel-raised w-96 max-w-full p-5 flex flex-col gap-4" role="dialog" aria-label="Purge wallets" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                      <span className="eyebrow">Purge wallets by flag</span>
                      <button type="button" className="text-dim hover:text-ink text-sm" onClick={() => setPurgeOpen(false)}>✕</button>
                    </div>
                    <p className="text-xs text-dim">
                      Soft-delete: hidden everywhere, knowledge kept so the crawler never re-absorbs them.
                    </p>
                    {FLAG_OPTIONS.map((option) => {
                      const count = wallets.filter((w) => w.metrics?.flags.includes(option.value)).length;
                      return (
                        <label key={option.value} className={`flex items-center gap-3 text-sm ${count === 0 ? 'opacity-40' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            className="checkbox"
                            disabled={count === 0}
                            checked={purgeFlags.has(option.value)}
                            onChange={(e) => {
                              const next = new Set(purgeFlags);
                              if (e.target.checked) next.add(option.value);
                              else next.delete(option.value);
                              setPurgeFlags(next);
                            }}
                          />
                          <span className="uppercase tracking-wider text-xs font-semibold">{option.label}</span>
                          <span className="text-xs text-dim ml-auto">{count} wallet{count === 1 ? '' : 's'}</span>
                        </label>
                      );
                    })}
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-dim">
                        {wallets.filter((w) => w.metrics?.flags.some((f) => purgeFlags.has(f))).length} wallets match
                      </span>
                      <button
                        className="btn btn-danger"
                        disabled={purgeFlags.size === 0 || purgeJunk.isPending}
                        onClick={() => purgeJunk.mutate([...purgeFlags], { onSuccess: () => setPurgeOpen(false) })}
                      >
                        {purgeJunk.isPending ? 'Purging…' : 'Purge selected'}
                      </button>
                    </div>
                  </div>
                </div>,
                document.body,
              )}
            <input
              placeholder="search address / label"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 py-1! text-xs"
            />
            <label className="flex items-center gap-2 text-xs text-dim cursor-pointer">
              <input
                type="checkbox"
                className="checkbox"
                checked={groupOwners}
                onChange={(e) => {
                  setGroupOwners(e.target.checked);
                  try { localStorage.setItem('million.groupOwners', e.target.checked ? 'on' : 'off'); } catch { /* ok */ }
                }}
              />
              group owners
            </label>
          </span>
          {(pending.length > 0 || pendingJob.data?.running) && (
            <button
              className="btn"
              disabled={!heliusOk || pendingJob.data?.running || startPending.isPending}
              title="Runs on the server — keeps going if you leave the page"
              onClick={() => startPending.mutate()}
            >
              {pendingJob.data?.running
                ? `Analyzing ${pendingJob.data.done}/${pendingJob.data.total}…`
                : `Analyze all pending (${pending.length})`}
            </button>
          )}
        </div>
        {wallets.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">Roster is empty — import the JSON above to begin.</p>
        ) : sorted.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">No wallets match the filters — clear or loosen them.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="pl-4 pr-0 py-2 w-8"></th>
                  <th className="px-4 py-2 font-normal">wallet</th>
                  <SortHeader label="label" colKey="label" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortHeader label="score" colKey="score" sortKey={sortKey} dir={dir} onToggle={toggle} hint="Whale-quality score: win rate + realized PnL, bots and farmed wallets slammed to -100. Same formula as Discover." />
                  <SortHeader label="win rate" colKey="winRate" sortKey={sortKey} dir={dir} onToggle={toggle} hint="Share of fully closed tokens that ended profitable. Open positions don't count either way." />
                  <SortHeader label="realized PnL" colKey="pnl" sortKey={sortKey} dir={dir} onToggle={toggle} right hint="Average-cost realized PnL over the analyzed window. SOL and USDC/USDT legs combined, stable legs converted at the SOL price at analysis time. Open positions not included." />
                  <SortHeader label="med. hold" colKey="hold" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortHeader label="open" colKey="open" sortKey={sortKey} dir={dir} onToggle={toggle} hint="Positions bought and never sold, excluding stablecoins and entries under the min size set in Screener → Analytics." />
                  <SortHeader label="last active" colKey="lastSeen" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th className="px-4 py-2 font-normal">flags</th>
                  <th className="px-4 py-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {pag.rows.flatMap((row) => {
                  if (row.kind === 'owner') {
                    const agg = groupAgg(row.members);
                    const isOpen = expanded.has(row.ownerId);
                    const walletRows = isOpen ? row.members : [];
                    return [
                      <tr key={`owner-${row.ownerId}`} className="border-t border-line hover:bg-deck2 cursor-pointer" onClick={() => toggleGroup(row.ownerId)}>
                        <td className="pl-4 pr-0 py-2 text-neon">{isOpen ? '▾' : '▸'}</td>
                        <td className="px-4 py-2 text-bright font-semibold" colSpan={2}>
                          Owner · {row.members.length} wallets
                          {rowGet.label(row) && <span className="text-dim font-normal ml-2">({rowGet.label(row)})</span>}
                        </td>
                        <td className="px-4 py-2">
                          {agg.score === null ? <span className="text-dim">—</span> : (
                            <span className={`font-bold ${agg.score >= 50 ? 'text-profit' : agg.score >= 0 ? 'text-ink' : 'text-loss'}`}>{agg.score}</span>
                          )}
                        </td>
                        <td className="px-4 py-2">{fmtPct(agg.winRate)}</td>
                        <td className={`px-4 py-2 text-right ${agg.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>{fmtSol(agg.pnl)}</td>
                        <td className="px-4 py-2 text-dim">—</td>
                        <td className="px-4 py-2 text-warn">{agg.open || <span className="text-dim">0</span>}</td>
                        <td className="px-4 py-2 text-dim whitespace-nowrap">{fmtAgo(agg.lastSeen ? new Date(agg.lastSeen).toISOString() : null)}</td>
                        <td className="px-4 py-2 text-xs text-dim" colSpan={2}>pooled · click to {isOpen ? 'collapse' : 'expand'}</td>
                      </tr>,
                      ...walletRows.map((w) => renderWalletRow(w, true)),
                    ];
                  }
                  return [renderWalletRow(row.w, false)];
                })}
              </tbody>
            </table>
            <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
          </div>
        )}
      </div>
    </div>
  );

  function renderWalletRow(w: WalletRecord, indent: boolean) {
    const busy = analyzing.has(w.address) || w.status === 'analyzing';
    return (
                    <tr key={w.address} className={`border-t border-line hover:bg-deck2 ${indent ? 'bg-void/40' : ''}`}>
                      <td className={`${indent ? 'pl-8' : 'pl-4'} pr-0 py-2`}>
                        <Link
                          to="/wallets/$address"
                          params={{ address: w.address }}
                          title="Open wallet detail"
                          className="text-dim hover:text-neon inline-flex"
                        >
                          <EyeIcon />
                        </Link>
                      </td>
                      <td className="px-4 py-2"><Addr address={w.address} /></td>
                      <td className="px-4 py-2 text-ink">{w.label ?? <span className="text-dim">—</span>}</td>
                      <td className="px-4 py-2">
                        {(() => {
                          if (w.metrics && isBotWallet(w.metrics)) return <span className="text-dim" title="Bot-flagged wallets are not scored — see flags">N/A</span>;
                          const score = rosterScore(w);
                          if (score === null) return <span className="text-dim">—</span>;
                          return <span className={`font-bold ${score >= 50 ? 'text-profit' : score >= 0 ? 'text-ink' : 'text-loss'}`}>{score}</span>;
                        })()}
                      </td>
                      <td className="px-4 py-2">{fmtPct(w.metrics?.winRate ?? null)}</td>
                      <td className={`px-4 py-2 text-right ${w.metrics ? ((totalPnlSol(w.metrics) ?? 0) >= 0 ? 'text-profit' : 'text-loss') : 'text-dim'}`}>
                        {w.metrics ? fmtSol(totalPnlSol(w.metrics) ?? 0) : '—'}
                      </td>
                      <td className="px-4 py-2">{fmtHold(w.metrics?.medianHoldMinutes ?? null)}</td>
                      <td className="px-4 py-2">
                        {(() => {
                          const open = w.metrics ? openPositions(w.metrics.tokens, loadMinOpenSol()) : null;
                          if (!open) return <span className="text-dim">—</span>;
                          if (open.length === 0) return <span className="text-dim">0</span>;
                          const names = open.map((t) => t.symbol ?? truncAddr(t.mint)).join(', ');
                          return <span className="text-warn" title={names}>{open.length}</span>;
                        })()}
                      </td>
                      <td className="px-4 py-2 text-dim whitespace-nowrap" title={w.metrics?.lastSeen ?? ''}>
                        {fmtAgo(w.metrics?.lastSeen ?? null)}
                      </td>
                      <td className="px-4 py-2">
                        <span className="flex gap-1 flex-wrap">
                          {w.status === 'error' && <span title={w.error ?? ''} className="text-loss text-[0.6rem] uppercase">error</span>}
                          {(w.metrics?.flags ?? []).map((f) => <FlagChip key={f} flag={f} />)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <button
                          className="btn mr-2 py-1! px-2! text-[0.6rem]!"
                          disabled={!heliusOk || busy}
                          onClick={() => runAnalysis([w.address])}
                        >
                          {busy ? '…' : w.metrics ? 're-run' : 'analyze'}
                        </button>
                        <button
                          className="text-xs text-dim hover:text-loss"
                          title="Remove from roster"
                          onClick={() => removeWallet.mutate(w.address)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
    );
  }
}
