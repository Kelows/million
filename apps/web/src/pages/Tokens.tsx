import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useCheckToken, useFamousTokens, useImportTokens, usePurgeJunkTokens, useRecheckAllJob, useStartRecheckAll, useTokens, useUntrackToken } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { STATUS_STYLE } from '../components/TokenReportView';
import { MoversModal } from '../components/MoversModal';
import { fmtAgo } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { SortHeader } from '../components/SortHeader';
import type { FamousTokenRow, TrackedToken } from '@million/shared';
import { Pagination } from '../components/Pagination';

const SOL_ADDR_G = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const fmtUsd = (n: number | null) => (n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

const VERDICT_RANK: Record<string, number> = { pass: 0, warn: 1, unknown: 2, fail: 3 };

const TOKEN_COLUMNS: SortColumn<TrackedToken>[] = [
  { key: 'token', get: (t) => t.symbol },
  { key: 'verdict', get: (t) => (t.verdict ? VERDICT_RANK[t.verdict] : null) },
  { key: 'liq', get: (t) => t.liquidityUsd },
  { key: 'mcap', get: (t) => t.marketCapUsd },
  { key: 'checked', get: (t) => (t.lastCheckedAt ? new Date(t.lastCheckedAt).getTime() : null) },
  { key: 'source', get: (t) => (t.tracked ? (t.source ?? 'tracked') : 'seen in analyses') },
];

export function Tokens() {
  const { data: tokens = [] } = useTokens();
  const importTokens = useImportTokens();
  const checkToken = useCheckToken();
  const untrack = useUntrackToken();
  const purgeJunk = usePurgeJunkTokens();
  const recheckJob = useRecheckAllJob();
  const startRecheck = useStartRecheckAll();
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);

  const doImport = () => {
    setParseError(null);
    const mints = [...new Set(raw.match(SOL_ADDR_G) ?? [])];
    if (!mints.length) {
      setParseError('No Solana addresses found in that input.');
      return;
    }
    importTokens.mutate({ mints, source: source || undefined }, { onSuccess: () => setRaw('') });
  };

  const query = search.trim().toLowerCase();
  const filtered = tokens.filter(
    (t) =>
      (!trackedOnly || t.tracked) &&
      (!query || t.mint.toLowerCase().includes(query) || t.symbol?.toLowerCase().includes(query) || t.name?.toLowerCase().includes(query)),
  );
  const sort = useTableSort(filtered, TOKEN_COLUMNS);
  const pag = usePagination(sort.sorted, 25);
  const junkCount = tokens.filter((t) => t.verdict !== null && (t.verdict === 'fail' || (t.liquidityUsd ?? 0) <= 0)).length;

  const runCheck = async (mint: string) => {
    setChecking(mint);
    await checkToken.mutateAsync(mint).catch(() => undefined);
    setChecking(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Tokens</h1>
        <p className="text-sm text-dim mt-1">
          Every token the system knows: imported, checked, or seen in any wallet's analysis.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <span className="eyebrow">Import</span>
        <textarea
          rows={3}
          placeholder="Paste mints — JSON, list, or free text all work"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="w-full resize-y"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input placeholder="source tag" value={source} onChange={(e) => setSource(e.target.value)} className="w-56" />
          <button className="btn" disabled={!raw.trim() || importTokens.isPending} onClick={doImport}>
            {importTokens.isPending ? 'Importing…' : 'Import'}
          </button>
          {importTokens.isSuccess && (
            <span className="text-xs text-profit">
              Added {importTokens.data.imported}{importTokens.data.skipped ? `, ${importTokens.data.skipped} already tracked` : ''}.
            </span>
          )}
        </div>
        {parseError && <p className="text-xs text-loss">{parseError}</p>}
      </div>

      <FamousPanel />

      <div className="panel">
        <div className="px-4 pt-4 pb-2 flex items-center gap-4 flex-wrap">
          <span className="eyebrow">Tokens · {filtered.length !== tokens.length ? `${filtered.length} / ${tokens.length}` : tokens.length}</span>
          <MoversModal />
          <button
            className="btn py-1! px-2! text-[0.6rem]!"
            disabled={recheckJob.data?.running || startRecheck.isPending}
            title="Re-run the gauntlet on every tracked token — server-side, survives leaving the page"
            onClick={() => startRecheck.mutate()}
          >
            {recheckJob.data?.running ? `re-checking ${recheckJob.data.done}/${recheckJob.data.total}…` : 're-check all'}
          </button>
          <input placeholder="search symbol / mint" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56 py-1! text-xs" />
          <label className="flex items-center gap-2 text-xs text-dim cursor-pointer">
            <input
              type="checkbox"
              className="checkbox"
              checked={trackedOnly}
              onChange={(e) => setTrackedOnly(e.target.checked)}
            />
            tracked only
          </label>
          {junkCount > 0 && (
            <button
              className="btn btn-danger py-1! px-2! text-[0.6rem]!"
              disabled={purgeJunk.isPending}
              title="Delete checked tokens with a FAIL verdict or zero liquidity — unchecked tokens are untouched"
              onClick={() => {
                if (window.confirm(`Delete ${junkCount} junk token${junkCount === 1 ? '' : 's'} (failed check or dead liquidity)?`)) {
                  purgeJunk.mutate();
                }
              }}
            >
              {purgeJunk.isPending ? 'purging…' : `purge junk (${junkCount})`}
            </button>
          )}
        </div>
        {filtered.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">Nothing here yet — import above, run checks, or analyze wallets (their tokens land here automatically).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="pl-4 pr-0 py-2 w-8"></th>
                  <SortHeader label="token" colKey="token" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                  <SortHeader label="verdict" colKey="verdict" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                  <SortHeader label="liq" colKey="liq" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                  <SortHeader label="mcap" colKey="mcap" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                  <SortHeader label="checked" colKey="checked" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                  <SortHeader label="source" colKey="source" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                  <th className="px-4 py-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {pag.rows.map((t) => (
                  <tr key={t.mint} className="border-t border-line hover:bg-deck2">
                    <td className="pl-4 pr-0 py-2">
                      <Link to="/tokens/$mint" params={{ mint: t.mint }} title="Open token detail" className="text-dim hover:text-neon inline-flex">
                        <EyeIcon />
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        {t.symbol && <TokenName mint={t.mint} symbol={t.symbol} />}
                        <Addr address={t.mint} kind="token" />
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {t.verdict ? (
                        <span className={`font-bold text-xs ${STATUS_STYLE[t.verdict].text}`}>{STATUS_STYLE[t.verdict].label}</span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-dim">{fmtUsd(t.liquidityUsd)}</td>
                    <td className="px-4 py-2 text-right text-dim">{fmtUsd(t.marketCapUsd)}</td>
                    <td className="px-4 py-2 text-dim" title={t.lastCheckedAt ?? ''}>{fmtAgo(t.lastCheckedAt)}</td>
                    <td className="px-4 py-2 text-dim text-xs">{t.tracked ? (t.source ?? 'tracked') : 'seen in analyses'}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button className="btn mr-2 py-1! px-2! text-[0.6rem]!" disabled={checking === t.mint} onClick={() => runCheck(t.mint)}>
                        {checking === t.mint ? '…' : t.verdict ? 're-check' : 'check'}
                      </button>
                      {t.tracked && (
                        <button className="text-xs text-dim hover:text-loss" title="Stop tracking" onClick={() => untrack.mutate(t.mint)}>✕</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
          </div>
        )}
      </div>
    </div>
  );
}

function FamousTable({ title, hint, rows, solLabel, pnlTone }: { title: string; hint: string; rows: FamousTokenRow[]; solLabel: string; pnlTone: boolean }) {
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">Nothing yet — appears as wallet analyses accumulate.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-left text-dim text-xs">
                <th className="px-4 py-2 font-normal">token</th>
                <th className="px-4 py-2 font-normal text-right">owners</th>
                <th className="px-4 py-2 font-normal text-right">{solLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint} className="border-t border-line hover:bg-deck2">
                  <td className="px-4 py-2">
                    <Link to="/tokens/$mint" params={{ mint: r.mint }} className="text-neon hover:underline">
                      <TokenName mint={r.mint} symbol={r.symbol} />
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right text-warn">{r.owners}</td>
                  <td className={`px-4 py-2 text-right ${pnlTone ? (r.sol >= 0 ? 'text-profit' : 'text-loss') : 'text-bright'}`}>
                    {pnlTone && r.sol > 0 ? '+' : ''}{r.sol} ◎
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-dim">{hint}</p>
    </div>
  );
}

const HELD_COLUMNS: SortColumn<FamousTokenRow>[] = [
  { key: 'token', get: (r) => r.symbol },
  { key: 'owners', get: (r) => r.owners },
  { key: 'entry', get: (r) => r.sol },
  { key: 'realized', get: (r) => r.realizedSol ?? null },
  { key: 'score', get: (r) => r.score ?? null },
];

function HeldTable({ rows }: { rows: FamousTokenRow[] }) {
  const sort = useTableSort(rows, HELD_COLUMNS, 'score');
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">Held across the roster</div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">Nothing yet — appears as wallet analyses accumulate.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-dim text-xs">
                <SortHeader label="token" colKey="token" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                <SortHeader label="owners" colKey="owners" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label="entry ◎" colKey="entry" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label="realized ◎" colKey="realized" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label="score" colKey="score" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right
                  hint="Conviction: owners × √entry, discounted by profit the roster already took here. High = broadly held and still fresh — positioned, not yet milked. Low despite big holdings = the echo bag of a play that already paid." />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.mint} className="border-t border-line hover:bg-deck2">
                  <td className="px-4 py-2">
                    <Link to="/tokens/$mint" params={{ mint: r.mint }} className="text-neon hover:underline">
                      <TokenName mint={r.mint} symbol={r.symbol} />
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right text-warn">{r.owners}</td>
                  <td className="px-4 py-2 text-right text-bright">{r.sol}</td>
                  <td className={`px-4 py-2 text-right ${(r.realizedSol ?? 0) > 0 ? 'text-profit' : 'text-dim'}`}>{(r.realizedSol ?? 0) > 0 ? '+' : ''}{r.realizedSol ?? 0}</td>
                  <td className="px-4 py-2 text-right text-bright font-bold">{r.score ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-dim">
        Open positions ≥ 0.5 ◎ at cost, distinct owners, infra excluded. Sorted by conviction: heavily held AND not yet cashed out ranks first.
      </p>
    </div>
  );
}

function FamousPanel() {
  const { data } = useFamousTokens();
  if (!data || (data.held.length === 0 && data.earned.length === 0)) return null;
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <HeldTable rows={data.held} />
      <FamousTable
        title="Where the roster printed"
        hint="Realized PnL summed across owners that closed trades here. History, not a signal — but it shows which hunting grounds actually paid."
        rows={data.earned}
        solLabel="realized ◎"
        pnlTone={true}
      />
    </div>
  );
}
