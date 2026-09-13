import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { DecisionOutcome, DecisionRow } from '@million/shared';
import { useDecisions } from '../api';
import { fmtAgo, truncAddr } from '../lib/format';
import { TokenLink } from './TokenName';

const OUTCOME: Record<DecisionOutcome, { label: string; className: string }> = {
  opened: { label: 'OPENED', className: 'text-profit border-profit/50' },
  fired: { label: 'SIGNAL', className: 'text-neon border-neon/50' },
  shadow: { label: 'SHADOW', className: 'text-warn border-warn/50' },
  skip: { label: 'SKIP', className: 'text-dim border-line' },
};

type Filter = 'all' | 'skip' | 'shadow' | 'traded';
const FILTERS: { key: Filter; label: string; match: (d: DecisionRow) => boolean }[] = [
  { key: 'all', label: 'all', match: () => true },
  { key: 'traded', label: 'signals & trades', match: (d) => d.outcome === 'fired' || d.outcome === 'opened' },
  { key: 'shadow', label: 'shadow', match: (d) => d.outcome === 'shadow' },
  { key: 'skip', label: 'skipped', match: (d) => d.outcome === 'skip' },
];

/**
 * Why each token event did or did not become a trade. With `mint`, the history
 * for one token — the answer to "why didn't it buy this?".
 */
export function DecisionLog({ mint }: { mint?: string }) {
  const [quiet, setQuiet] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const { data: rows = [], isLoading } = useDecisions({ mint, quiet, limit: mint ? 100 : 150 });
  const shown = rows.filter(FILTERS.find((f) => f.key === filter)!.match);

  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">{mint ? 'Why it did or didn’t trade' : 'Decision log · newest first'}</div>
          <p className="text-xs text-dim mt-1">
            {mint
              ? 'Every time a subscribed wallet touched this token, and what the pipeline decided.'
              : 'Every token event from a subscribed wallet, and the gate that decided it. Kept for 3 days.'}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={filter === f.key ? 'text-neon underline underline-offset-4' : 'text-dim hover:text-ink'}
            >
              {f.label}
            </button>
          ))}
          <label className="flex items-center gap-1.5 text-dim cursor-pointer" title="Small buys, tokens received for free, transfers out: the frequent, routine skips.">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
            routine skips
          </label>
        </div>
      </div>
      {isLoading ? (
        <p className="px-4 pb-4 text-sm text-dim">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">
          {mint
            ? quiet
              ? 'No subscribed wallet has touched this token in the last 3 days.'
              : 'Nothing notable in the last 3 days. Tick “routine skips” to see small buys and transfers too.'
            : 'No decisions yet. They appear as soon as a subscribed wallet touches a token.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className={`border-t border-line align-baseline ${d.quiet ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 text-xs text-dim font-mono whitespace-nowrap" title={d.ts}>
                    {fmtAgo(d.ts)}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <span className={`border px-1 text-[0.6rem] font-mono font-bold tracking-widest ${OUTCOME[d.outcome].className}`}>{OUTCOME[d.outcome].label}</span>
                  </td>
                  {!mint && (
                    <td className="px-2 py-2 whitespace-nowrap">{d.mint ? <TokenLink mint={d.mint} symbol={d.symbol} /> : <span className="text-dim">—</span>}</td>
                  )}
                  <td className="px-2 py-2 whitespace-nowrap text-xs">
                    {d.wallet ? (
                      <Link to="/wallets/$address" params={{ address: d.wallet }} className="text-neon hover:underline font-mono">
                        {truncAddr(d.wallet)}
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-[0.65rem] text-dim font-mono uppercase tracking-wider whitespace-nowrap">{d.stage}</td>
                  <td className="px-4 py-2 text-ink">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
