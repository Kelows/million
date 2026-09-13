import { Link } from '@tanstack/react-router';
import { useWallets } from '../api';
import { StatTile } from '../components/StatTile';
import { TradingTiles } from '../components/TradingTiles';
import { Addr } from '../components/Addr';
import { fmtAgo, fmtPct, fmtSol, observedPnlSol, truncAddr } from '../lib/format';
import { EyeIcon } from '../components/icons';
import { TokenLink } from '../components/TokenName';
import { Info } from '../components/Info';
import { FLAG_OPTIONS } from '../components/FlagChip';
import { applyFilters, useStoredFilters, type FilterField } from '../lib/useTableFilters';
import { useCohorts, useTrading } from '../api';
import { usePagination } from '../lib/usePagination';
import { loadMinOpenSol } from '../lib/settings';
import { FilterModal } from '../components/FilterModal';
import { Pagination } from '../components/Pagination';
import type { WalletRecord } from '@million/shared';
import { isQualifyingWallet, openPositions, WATCH_CRITERIA } from '@million/shared';

const WATCH_FILTERS: FilterField<WalletRecord>[] = [
  { key: 'excludeFlags', label: 'Exclude tags', type: 'multi', options: FLAG_OPTIONS, get: (w) => w.metrics?.flags ?? [] },
  { key: 'minWinRate', label: 'Win rate', type: 'min', unit: '%', get: (w) => (w.metrics?.winRate == null ? null : w.metrics.winRate * 100) },
  { key: 'minPnl', label: 'Observed PnL', type: 'min', unit: 'SOL', get: (w) => observedPnlSol(w) },
  { key: 'minOpen', label: 'Open positions', type: 'min', unit: 'count', get: (w) => openPositions(w.metrics?.tokens ?? [], loadMinOpenSol()).length },
  { key: 'maxInactiveDays', label: 'Days since active', type: 'max', unit: 'days', get: (w) => (w.metrics?.lastSeen ? (Date.now() - new Date(w.metrics.lastSeen).getTime()) / 86_400_000 : null) },
];

export function Dashboard() {
  const { data: wallets = [], isLoading } = useWallets();
  const analyzed = wallets.filter((w) => w.metrics);
  const totalPnl = wallets.reduce((s, w) => s + (observedPnlSol(w) ?? 0), 0);
  const measured = wallets.filter((w) => (w.observed?.trades ?? 0) > 0).length;
  const winRates = analyzed.map((w) => w.metrics?.winRate).filter((r): r is number => r !== null && r !== undefined);
  const avgWinRate = winRates.length ? winRates.reduce((s, r) => s + r, 0) / winRates.length : null;
  const [filters, setFilters] = useStoredFilters('million.filters.watch');
  const watchAll = analyzed
    .filter((w) => w.metrics && isQualifyingWallet(w.metrics, w.observed) && openPositions(w.metrics.tokens, loadMinOpenSol()).length > 0)
    .sort((a, b) => (observedPnlSol(b) ?? 0) - (observedPnlSol(a) ?? 0));
  const top = applyFilters(watchAll, WATCH_FILTERS, filters);
  const pag = usePagination(top, 10);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Overview</h1>
        <p className="text-sm text-dim mt-1">Whale roster health at a glance. Stats cover analyzed wallets only.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Roster" value={String(wallets.length)} sub="wallets tracked" />
        <StatTile label="Analyzed" value={`${analyzed.length}/${wallets.length}`} sub="with on-chain stats" />
        <StatTile label="Avg win rate" value={fmtPct(avgWinRate)} sub="across analyzed wallets" />
        <StatTile
          label="Observed PnL"
          value={measured ? fmtSol(totalPnl) : '—'}
          sub={`${measured} wallets with closed round trips`}
          tone={totalPnl > 0 ? 'profit' : totalPnl < 0 ? 'loss' : 'default'}
        />
      </div>

      <TradingPanel />

      {wallets.length === 0 && !isLoading ? (
        <div className="panel p-8 text-center">
          <div className="text-bright font-semibold">Roster is empty</div>
          <p className="text-sm text-dim mt-2 mb-4">Drop the whale JSON to start screening wallets.</p>
          <Link to="/wallets" className="btn inline-block">Import wallets</Link>
        </div>
      ) : (
        <div className="panel">
          <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
            <span className="eyebrow">
              Wallets to watch
              <Info text={`Base bar, measured on OBSERVED round trips only: win rate > ${Math.round(WATCH_CRITERIA.minWinRate * 100)}%, at least ${WATCH_CRITERIA.minClosedTokens} watched round trips, and an open position of ${loadMinOpenSol()}+ SOL (stables & dust excluded). Sorted by realized PnL. The Filters button refines further on top of this.`} />
            </span>
            <span className="flex items-center gap-3">
              <FilterModal fields={WATCH_FILTERS} state={filters} onChange={setFilters} />
              <Link to="/wallets" className="text-xs text-neon hover:underline">full roster →</Link>
            </span>
          </div>
          {top.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-dim">No qualifying wallets with open positions yet — analyze more of the roster.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-left text-dim text-xs">
                    <th className="pl-4 pr-0 py-2 w-8"></th>
                    <th className="px-4 py-2 font-normal">wallet</th>
                    <th className="px-4 py-2 font-normal">observed WR</th>
                    <th className="px-4 py-2 font-normal text-right">observed PnL</th>
                    <th className="px-4 py-2 font-normal">open</th>
                    <th className="px-4 py-2 font-normal">last active</th>
                  </tr>
                </thead>
                <tbody>
                  {pag.rows.map((w) => (
                    <tr key={w.address} className="border-t border-line hover:bg-deck2">
                      <td className="pl-4 pr-0 py-2">
                        <Link to="/wallets/$address" params={{ address: w.address }} title="Open wallet detail" className="text-dim hover:text-neon inline-flex">
                          <EyeIcon />
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Link to="/wallets/$address" params={{ address: w.address }} className="text-neon hover:underline">
                          {w.label ?? truncAddr(w.address)}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{fmtPct(w.observed?.winRate ?? null)}</td>
                      <td className={`px-4 py-2 text-right ${(observedPnlSol(w) ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {w.observed?.trades ? fmtSol(observedPnlSol(w) ?? 0) : <span className="text-dim">unmeasured</span>}
                      </td>
                      <td className="px-4 py-2 text-warn">{openPositions(w.metrics?.tokens ?? [], loadMinOpenSol()).length}</td>
                      <td className="px-4 py-2 text-dim" title={w.metrics?.lastSeen ?? ''}>{fmtAgo(w.metrics?.lastSeen ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
            </div>
          )}
        </div>
      )}
      <CohortPanel />

      <div className="text-xs text-dim">
        Address list stays local. Analysis reads public on-chain history via Helius — nothing is signed, no keys touch this app.
      </div>
    </div>
  );
}

function TradingPanel() {
  const { data } = useTrading();
  const s = data?.stats;
  const open = data?.open ?? [];
  if (!s || (s.openCount === 0 && s.closedCount === 0)) return null; // nothing traded yet — don't render an empty scoreboard
  const unrealized = open.reduce((sum, p) => sum + (p.unrealizedPct != null ? (p.sizeSol * p.unrealizedPct) / 100 : 0), 0);
  const ur = Math.round(unrealized * 1000) / 1000;
  const top = [...open]
    .sort((a, b) => Math.abs((b.unrealizedPct ?? 0) * b.sizeSol) - Math.abs((a.unrealizedPct ?? 0) * a.sizeSol))
    .slice(0, 5);
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
        <span className="eyebrow">
          Positions
          {data?.halt?.halted && <span className="ml-2 text-loss font-bold">— HALTED: {data.halt.reason}</span>}
        </span>
        <Link to="/executor" className="text-xs text-neon hover:underline">all trades →</Link>
      </div>
      <div className="px-4 pb-4">
        <TradingTiles stats={s} open={open} />
      </div>
      {top.length > 0 && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-sm font-mono">
            <tbody>
              {top.map((p) => (
                <tr key={p.id} className="border-t border-line first:border-t-0 hover:bg-deck2">
                  <td className="px-4 py-2">
                    <TokenLink mint={p.mint} symbol={p.symbol} />
                  </td>
                  <td className="px-4 py-2 text-dim text-right">{p.sizeSol.toFixed(2)} ◎</td>
                  <td className={`px-4 py-2 text-right ${(p.unrealizedPct ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {p.unrealizedPct != null ? `${p.unrealizedPct > 0 ? '+' : ''}${Math.round(p.unrealizedPct)}%` : '—'}
                  </td>
                  <td className="px-4 py-2 text-dim text-right" title={p.openedAt}>{fmtAgo(p.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CohortPanel() {
  const { data: cohorts = [] } = useCohorts();
  if (cohorts.length < 2) return null; // needs at least two buckets to say anything
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">
        Cohort validation
        <Info text="The science check: wallets are bucketed by their whale score AT absorption time, then we measure realized PnL earned SINCE. If higher buckets don't earn more going forward, the score is decorative and absorption criteria need rethinking. Grows more trustworthy as re-analyses accumulate." />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-left text-dim text-xs">
              <th className="px-4 py-2 font-normal">score at absorb</th>
              <th className="px-4 py-2 font-normal">wallets</th>
              <th className="px-4 py-2 font-normal text-right">avg forward PnL</th>
              <th className="px-4 py-2 font-normal text-right">median forward</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.bucket} className="border-t border-line">
                <td className="px-4 py-2 text-bright">{c.bucket}</td>
                <td className="px-4 py-2 text-dim">{c.wallets}</td>
                <td className={`px-4 py-2 text-right ${c.avgForwardPnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>{c.avgForwardPnlSol > 0 ? '+' : ''}{c.avgForwardPnlSol} ◎</td>
                <td className={`px-4 py-2 text-right ${c.medianForwardPnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>{c.medianForwardPnlSol > 0 ? '+' : ''}{c.medianForwardPnlSol} ◎</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
