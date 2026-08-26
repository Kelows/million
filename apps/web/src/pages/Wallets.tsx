import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAnalyzeWallet, useHealth, useImportWallets, useRemoveWallet, useWallets } from '../api';
import { FlagChip } from '../components/FlagChip';
import { Addr } from '../components/Addr';
import { parseWalletsJson } from '../lib/parseWallets';
import { fmtAgo, fmtHold, fmtPct, fmtSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { applyFilters, useStoredFilters, type FilterField } from '../lib/useTableFilters';
import { usePagination } from '../lib/usePagination';
import { FilterModal } from '../components/FilterModal';
import { Pagination } from '../components/Pagination';
import { SortHeader } from '../components/SortHeader';
import { EyeIcon } from '../components/icons';
import { openPositions, type WalletRecord } from '@million/shared';

function openCount(w: WalletRecord): number | null {
  if (!w.metrics) return null;
  return openPositions(w.metrics.tokens).length;
}

const ROSTER_FILTERS: FilterField<WalletRecord>[] = [
  { key: 'openOnly', label: 'open positions only (excl. stables)', type: 'toggle', get: (w) => (openCount(w) ?? 0) > 0 },
  { key: 'minWinRate', label: 'Win rate', type: 'min', unit: '%', get: (w) => (w.metrics?.winRate == null ? null : w.metrics.winRate * 100) },
  { key: 'minPnl', label: 'Realized PnL', type: 'min', unit: 'SOL', get: (w) => w.metrics?.realizedPnlSol ?? null },
  { key: 'minOpen', label: 'Open positions', type: 'min', unit: 'count', get: (w) => openCount(w) },
  { key: 'maxInactiveDays', label: 'Days since active', type: 'max', unit: 'days', get: (w) => (w.metrics?.lastSeen ? (Date.now() - new Date(w.metrics.lastSeen).getTime()) / 86_400_000 : null) },
];

const ROSTER_COLUMNS: SortColumn<WalletRecord>[] = [
  { key: 'label', get: (w) => w.label },
  { key: 'winRate', get: (w) => w.metrics?.winRate ?? null },
  { key: 'pnl', get: (w) => w.metrics?.realizedPnlSol ?? null },
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
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useStoredFilters('million.filters.roster');
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
  const filtered = applyFilters(wallets, ROSTER_FILTERS, filters);
  const { sorted, sortKey, dir, toggle } = useTableSort(filtered, ROSTER_COLUMNS);
  const pag = usePagination(sorted, 25);

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
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
          <span className="mr-auto"><FilterModal fields={ROSTER_FILTERS} state={filters} onChange={setFilters} /></span>
          {pending.length > 0 && (
            <button className="btn" disabled={!heliusOk || analyzing.size > 0} onClick={() => runAnalysis(pending.map((w) => w.address))}>
              {analyzing.size > 0 ? `Analyzing ${analyzing.size} left…` : `Analyze all pending (${pending.length})`}
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
                  <SortHeader label="win rate" colKey="winRate" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortHeader label="realized PnL" colKey="pnl" sortKey={sortKey} dir={dir} onToggle={toggle} right />
                  <SortHeader label="med. hold" colKey="hold" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortHeader label="open" colKey="open" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <SortHeader label="last active" colKey="lastSeen" sortKey={sortKey} dir={dir} onToggle={toggle} />
                  <th className="px-4 py-2 font-normal">flags</th>
                  <th className="px-4 py-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {pag.rows.map((w) => {
                  const busy = analyzing.has(w.address) || w.status === 'analyzing';
                  return (
                    <tr key={w.address} className="border-t border-line hover:bg-deck2">
                      <td className="pl-4 pr-0 py-2">
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
                      <td className="px-4 py-2">{fmtPct(w.metrics?.winRate ?? null)}</td>
                      <td className={`px-4 py-2 text-right ${w.metrics ? ((w.metrics.realizedPnlSol >= 0) ? 'text-profit' : 'text-loss') : 'text-dim'}`}>
                        {w.metrics ? fmtSol(w.metrics.realizedPnlSol) : '—'}
                      </td>
                      <td className="px-4 py-2">{fmtHold(w.metrics?.medianHoldMinutes ?? null)}</td>
                      <td className="px-4 py-2">
                        {(() => {
                          const open = w.metrics ? openPositions(w.metrics.tokens) : null;
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
                })}
              </tbody>
            </table>
            <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
