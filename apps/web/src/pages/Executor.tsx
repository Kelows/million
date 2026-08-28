import { Link } from '@tanstack/react-router';
import type { PaperPositionRow } from '@million/shared';
import { useClosePosition, useResumeTrading, useTrading } from '../api';
import { Addr } from '../components/Addr';
import { TokenName } from '../components/TokenName';
import { StatTile } from '../components/StatTile';
import { fmtAgo, truncAddr } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { SortHeader } from '../components/SortHeader';
import { Pagination } from '../components/Pagination';

const REASON_LABEL: Record<string, string> = { tp: 'take profit', sl: 'stop loss', timeout: 'timeout', manual: 'manual', dead: 'pool died', mirror: 'mirrored exit', trail: 'trailing stop' };

export function Executor() {
  const { data } = useTrading();
  const close = useClosePosition();
  const resume = useResumeTrading();
  const s = data?.stats;
  const halt = data?.halt;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Trading</h1>
          <p className="text-sm text-dim mt-1">
            Every opportunity becomes a {s?.mode ?? 'paper'} position: entry at market + slippage, exits by TP / SL /
            timeout. The expectancy number below is what unlocks (or forbids) live auto-trade.
          </p>
        </div>
        <span className="text-pulse font-bold tracking-widest text-xs font-mono shrink-0 mt-1">
          {(s?.mode ?? 'paper').toUpperCase()} MODE
        </span>
      </div>

      {halt?.halted && (
        <div className="panel p-4 border border-loss flex items-center justify-between gap-4">
          <div>
            <div className="text-loss font-bold tracking-widest text-xs font-mono">CIRCUIT BREAKER — TRADING HALTED</div>
            <p className="text-sm text-dim mt-1">
              {halt.reason}. No new positions open until you resume; open positions keep their exits.
            </p>
          </div>
          <button className="btn shrink-0" onClick={() => resume.mutate()} disabled={resume.isPending}>
            Resume trading
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatTile
          label="Expectancy / trade"
          value={s?.expectancySolPerTrade !== null && s?.expectancySolPerTrade !== undefined ? `${s.expectancySolPerTrade > 0 ? '+' : ''}${s.expectancySolPerTrade} ◎` : '—'}
          sub="the number that decides everything"
          tone={s?.expectancySolPerTrade != null ? (s.expectancySolPerTrade > 0 ? 'profit' : 'loss') : 'default'}
          hint="Total realized PnL divided by closed trades. Positive over a real sample (weeks) is the only thing that justifies flipping auto-trade on."
        />
        <StatTile label="Realized PnL" value={s ? `${s.totalPnlSol > 0 ? '+' : ''}${s.totalPnlSol} ◎` : '—'} sub={`${s?.closedCount ?? 0} closed`} tone={s && s.totalPnlSol !== 0 ? (s.totalPnlSol > 0 ? 'profit' : 'loss') : 'default'} />
        <StatTile label="Win rate" value={s?.winRate != null ? `${Math.round(s.winRate * 100)}%` : '—'} sub={`${s?.wins ?? 0} wins`} />
        <StatTile label="Avg trade" value={s?.avgPnlPct != null ? `${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct}%` : '—'} sub="mean closed PnL %" />
        <StatTile label="Open" value={String(s?.openCount ?? 0)} sub="positions being monitored" />
      </div>

      <PositionsTable
        title={(() => {
          const open = data?.open ?? [];
          const pnl = open.reduce((sum, p) => sum + (p.unrealizedPct != null ? (p.sizeSol * p.unrealizedPct) / 100 : 0), 0);
          const r = Math.round(pnl * 1000) / 1000;
          return `Open · ${open.length} · ${r > 0 ? '+' : ''}${r} ◎ unrealized`;
        })()}
        rows={data?.open ?? []}
        empty="No open positions — they open automatically when opportunities fire."
        onClose={(id) => close.mutate(id)}
        closing={close.isPending}
      />
      <PositionsTable
        title={`Closed · ${data?.closed.length ?? 0}`}
        rows={data?.closed ?? []}
        empty="Nothing closed yet — expectancy appears here as trades resolve."
      />
      <p className="text-xs text-dim">
        Position size, TP/SL, slippage, max hold and caps live on the{' '}
        <Link to="/opportunities" className="text-neon hover:underline">Opportunities page</Link>. Executor is pluggable:
        live trading is one provider swap away, gated on the expectancy above.
      </p>
    </div>
  );
}

const POSITION_COLUMNS = (open: boolean): SortColumn<PaperPositionRow>[] => [
  { key: 'token', get: (p) => p.symbol },
  { key: 'from', get: (p) => p.wallet },
  { key: 'size', get: (p) => p.sizeSol },
  { key: 'entry', get: (p) => p.entryPriceUsd },
  { key: 'now', get: (p) => (open ? (p.currentPriceUsd ?? null) : (p.exitPriceUsd ?? null)) },
  { key: 'pnl', get: (p) => (open ? (p.unrealizedPct ?? null) : (p.pnlPct ?? null)) },
  { key: 'when', get: (p) => new Date(open ? p.openedAt : (p.closedAt ?? p.openedAt)).getTime() },
  { key: 'reason', get: (p) => p.exitReason },
];

function PositionsTable({ title, rows, empty, onClose, closing }: {
  title: string;
  rows: PaperPositionRow[];
  empty: string;
  onClose?: (id: number) => void;
  closing?: boolean;
}) {
  const sort = useTableSort(rows, POSITION_COLUMNS(Boolean(onClose)), 'when');
  const pag = usePagination(sort.sorted, 15);
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-dim text-xs">
                <SortHeader label="token" colKey="token" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                <SortHeader label="from" colKey="from" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                <SortHeader label="size" colKey="size" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label="entry $" colKey="entry" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label={onClose ? 'now $' : 'exit $'} colKey="now" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label="PnL" colKey="pnl" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                <SortHeader label={onClose ? 'opened' : 'closed'} colKey="when" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                {onClose ? <th className="px-4 py-2 font-normal"></th> : <SortHeader label="reason" colKey="reason" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />}
              </tr>
            </thead>
            <tbody>
              {pag.rows.map((p) => {
                const pct = onClose ? p.unrealizedPct : p.pnlPct;
                return (
                  <tr key={p.id} className="border-t border-line hover:bg-deck2">
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        {p.symbol && <TokenName mint={p.mint} symbol={p.symbol} />}
                        <Addr address={p.mint} kind="token" />
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {p.wallet ? (
                        <Link to="/wallets/$address" params={{ address: p.wallet }} className="text-neon hover:underline">{truncAddr(p.wallet)}</Link>
                      ) : <span className="text-dim">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-dim">{p.sizeSol} ◎</td>
                    <td className="px-4 py-2 text-right text-dim">{p.entryPriceUsd.toPrecision(3)}</td>
                    <td className="px-4 py-2 text-right text-dim">
                      {onClose ? (p.currentPriceUsd != null ? p.currentPriceUsd.toPrecision(3) : '—') : (p.exitPriceUsd != null ? p.exitPriceUsd.toPrecision(3) : '—')}
                    </td>
                    <td className={`px-4 py-2 text-right font-bold ${pct == null ? 'text-dim' : pct >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {pct != null ? `${pct > 0 ? '+' : ''}${pct}%` : '—'}
                      {p.pnlSol != null && <span className="block text-xs font-normal">{p.pnlSol > 0 ? '+' : ''}{p.pnlSol} ◎</span>}
                    </td>
                    <td className="px-4 py-2 text-dim text-xs" title={onClose ? p.openedAt : (p.closedAt ?? '')}>
                      {fmtAgo(onClose ? p.openedAt : p.closedAt)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {onClose ? (
                        <button className="btn btn-danger py-1! px-2! text-[0.6rem]!" disabled={closing} onClick={() => onClose(p.id)}>close</button>
                      ) : (
                        <span className="text-dim">{REASON_LABEL[p.exitReason ?? ''] ?? p.exitReason}</span>
                      )}
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
  );
}
