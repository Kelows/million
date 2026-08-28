import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useCopyability, useCopyabilityStatus, useRunCopyability } from '../api';
import { Info } from '../components/Info';
import { fmtAgo, truncAddr } from '../lib/format';
import type { CopyabilityWalletRow } from '@million/shared';

const fmtRet = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`);
const retTone = (v: number | null | undefined) => (v == null ? 'text-dim' : v >= 0 ? 'text-profit' : 'text-loss');

function retentionTone(v: number | null): string {
  if (v == null) return 'text-dim';
  if (v >= 70) return 'text-profit';
  if (v >= 30) return 'text-warn';
  return 'text-loss';
}

export function Copyability() {
  const { data: rows = [] } = useCopyability();
  const { data: status } = useCopyabilityStatus();
  const run = useRunCopyability();
  const [expanded, setExpanded] = useState<string | null>(null);

  const measured = rows.filter((r) => r.copyability);
  const running = status?.running ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-bright tracking-wide">Copyability</h1>
          <p className="text-sm text-dim mt-1 max-w-2xl">
            Each whale's closed trades replayed off the pool's own minute tape — once at their entry candle, once one
            candle (~60s) later, our realistic copy latency. A whale whose edge dies in a minute can't be copied,
            no matter how good the PnL looks.
          </p>
        </div>
        <button
          className="btn shrink-0"
          disabled={running || run.isPending}
          onClick={() => run.mutate({ top: 10 })}
        >
          {running ? `Measuring ${status?.done ?? 0}/${status?.total ?? 0}…` : 'Run on 10 latest-active'}
        </button>
      </div>

      {running && status?.current && (
        <div className="text-xs text-dim font-mono">in flight: {truncAddr(status.current)} — GeckoTerminal free tier throttles this to ~30 candles/min, a full run takes a few minutes.</div>
      )}

      {measured.length === 0 && !running ? (
        <div className="panel p-8 text-center">
          <div className="text-bright font-semibold">Nothing measured yet</div>
          <p className="text-sm text-dim mt-2">Run it on the 10 most recently active wallets — the ones you'd actually copy tomorrow.</p>
        </div>
      ) : (
        <div className="panel">
          <div className="px-4 pt-4 pb-2 eyebrow">
            Edge retention
            <Info text="Size-weighted average return over the whale's own closed trades vs the same trades one candle later. Retention = copier ÷ whale × 100. Null when the whale's measured edge is under 5% — dividing by noise. Click a row for the per-token replay." />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="px-4 py-2 font-normal">wallet</th>
                  <th className="px-4 py-2 font-normal text-right">score</th>
                  <th className="px-4 py-2 font-normal text-right">trades</th>
                  <th className="px-4 py-2 font-normal text-right">whale ret</th>
                  <th className="px-4 py-2 font-normal text-right">copier ret</th>
                  <th className="px-4 py-2 font-normal text-right">retention</th>
                  <th className="px-4 py-2 font-normal">measured</th>
                </tr>
              </thead>
              <tbody>
                {measured.map((r) => (
                  <Row key={r.address} row={r} expanded={expanded === r.address} onToggle={() => setExpanded(expanded === r.address ? null : r.address)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ row, expanded, onToggle }: { row: CopyabilityWalletRow; expanded: boolean; onToggle: () => void }) {
  const c = row.copyability;
  if (!c) return null;
  return (
    <>
      <tr className="border-t border-line hover:bg-deck2 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2">
          <Link to="/wallets/$address" params={{ address: row.address }} className="text-neon hover:underline" onClick={(e) => e.stopPropagation()}>
            {row.label ?? truncAddr(row.address)}
          </Link>
        </td>
        <td className="px-4 py-2 text-right text-bright">{row.whaleScore ?? '—'}</td>
        <td className="px-4 py-2 text-right text-dim">{c.sampled}{c.skipped > 0 ? <span className="text-dim"> (+{c.skipped} no tape)</span> : null}</td>
        <td className={`px-4 py-2 text-right ${retTone(c.whaleAvgRetPct)}`}>{fmtRet(c.whaleAvgRetPct)}</td>
        <td className={`px-4 py-2 text-right ${retTone(c.copierAvgRetPct)}`}>{fmtRet(c.copierAvgRetPct)}</td>
        <td className={`px-4 py-2 text-right font-bold ${retentionTone(c.edgeRetentionPct)}`}>
          {c.edgeRetentionPct == null ? 'n/a' : `${Math.round(c.edgeRetentionPct)}%`}
        </td>
        <td className="px-4 py-2 text-dim" title={c.computedAt}>{fmtAgo(c.computedAt)}</td>
      </tr>
      {expanded && (
        <tr className="border-t border-line bg-deck2/50">
          <td colSpan={7} className="px-4 py-3">
            {c.tokens.length === 0 ? (
              <span className="text-xs text-dim">No closed trade had candle data — pools too dead or too new for the tape.</span>
            ) : (
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-left text-dim">
                    <th className="pr-4 py-1 font-normal">token</th>
                    <th className="pr-4 py-1 font-normal text-right">size ◎</th>
                    <th className="pr-4 py-1 font-normal text-right">whale</th>
                    <th className="pr-4 py-1 font-normal text-right">copier</th>
                    <th className="pr-4 py-1 font-normal">entered</th>
                  </tr>
                </thead>
                <tbody>
                  {c.tokens.map((t) => (
                    <tr key={t.mint}>
                      <td className="pr-4 py-1">
                        <Link to="/tokens/$mint" params={{ mint: t.mint }} className="text-neon hover:underline">{t.symbol ?? truncAddr(t.mint)}</Link>
                      </td>
                      <td className="pr-4 py-1 text-right text-dim">{t.weightSol.toFixed(1)}</td>
                      <td className={`pr-4 py-1 text-right ${retTone(t.whaleRetPct)}`}>{fmtRet(t.whaleRetPct)}</td>
                      <td className={`pr-4 py-1 text-right ${retTone(t.copierRetPct)}`}>{fmtRet(t.copierRetPct)}</td>
                      <td className="pr-4 py-1 text-dim" title={t.entryAt}>{fmtAgo(t.entryAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
