import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { CheckStatus, GemToken } from '@million/shared';
import { useGems, useRunGems } from '../api';
import { Addr } from '../components/Addr';
import { fmtAgo, truncAddr } from '../lib/format';

type Strictness = 'strict' | 'warn' | 'all';

const VERDICT_STYLE: Record<CheckStatus, { label: string; text: string; border: string }> = {
  pass: { label: 'PASS', text: 'text-profit', border: 'border-profit' },
  warn: { label: 'WARN', text: 'text-warn', border: 'border-warn' },
  fail: { label: 'FAIL', text: 'text-loss', border: 'border-loss' },
  unknown: { label: '?', text: 'text-dim', border: 'border-line' },
};

const fmtUsd = (n: number | null) => (n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export function Gems() {
  const { data: run, isLoading } = useGems();
  const runGems = useRunGems();
  const [strictness, setStrictness] = useState<Strictness>('strict');

  const visible = (run?.gems ?? []).filter((g) =>
    strictness === 'all' ? true : strictness === 'warn' ? g.verdict === 'pass' || g.verdict === 'warn' : g.verdict === 'pass',
  );
  const hidden = (run?.gems.length ?? 0) - visible.length;

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Gems</h1>
          <p className="text-sm text-dim mt-1">
            The loop's output: tokens held open by ≥ 2 qualifying whales, pushed through the full gauntlet.
            Consensus is only as fresh as your last analyses.
          </p>
        </div>
        <div className="text-right shrink-0 max-w-64">
          <button className="btn" disabled={runGems.isPending} onClick={() => runGems.mutate()}>
            {runGems.isPending ? 'Running gauntlet…' : run ? 'Re-run' : 'Run'}
          </button>
          {run && (
            <div className="text-xs text-dim mt-2" title={run.generatedAt}>
              {fmtAgo(run.generatedAt)} · {run.candidates} candidate{run.candidates === 1 ? '' : 's'} from{' '}
              {run.qualifyingWallets}/{run.totalAnalyzed} qualifying wallets
            </div>
          )}
        </div>
      </div>
      {runGems.error && <p className="text-xs text-loss">{runGems.error.message}</p>}

      <div className="flex items-center gap-2">
        {(['strict', 'warn', 'all'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setStrictness(mode)}
            className={`px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-widest border cursor-pointer ${
              strictness === mode ? 'border-neon text-neon' : 'border-line text-dim hover:text-ink'
            }`}
          >
            {mode === 'strict' ? 'pass only' : mode === 'warn' ? '+ warnings' : 'everything'}
          </button>
        ))}
        {hidden > 0 && <span className="text-xs text-dim">{hidden} hidden by strictness</span>}
      </div>

      {!run && !isLoading ? (
        <div className="panel p-8 text-center text-sm text-dim">
          Nothing yet — analyze the roster, then run the gauntlet.
        </div>
      ) : run && visible.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-dim">
          {run.gems.length === 0
            ? 'No consensus among qualifying whales right now — analyze more wallets or lower the min open size.'
            : 'Nothing survives at this strictness — loosen it to see what the gauntlet caught.'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((gem) => (
            <GemRow key={gem.mint} gem={gem} />
          ))}
        </div>
      )}
    </div>
  );
}

function GemRow({ gem }: { gem: GemToken }) {
  const style = VERDICT_STYLE[gem.verdict];
  return (
    <div className={`panel p-4 border-l-4 ${style.border}`}>
      <div className="flex items-baseline gap-4 flex-wrap">
        <span className={`font-mono text-sm font-bold ${style.text}`}>{style.label}</span>
        <span className="text-bright font-semibold text-lg">{gem.symbol ?? '?'}</span>
        <Addr address={gem.mint} kind="token" />
        <span className="text-warn font-mono text-sm ml-auto" title={gem.holders.map((h) => h.label ?? truncAddr(h.address)).join(', ')}>
          {gem.whaleCount} whales
        </span>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-2 text-xs font-mono text-dim">
        <span>liq {fmtUsd(gem.liquidityUsd)}</span>
        <span>mcap {fmtUsd(gem.marketCapUsd)}</span>
        <span title={gem.pairCreatedAt ?? ''}>pair {fmtAgo(gem.pairCreatedAt)}</span>
        {gem.pairUrl && (
          <a href={gem.pairUrl} target="_blank" rel="noopener noreferrer" className="text-neon hover:underline">chart ↗</a>
        )}
        <Link to="/tokens/$mint" params={{ mint: gem.mint }} className="text-neon hover:underline">details →</Link>
        <Link to="/token-check" search={{ mint: gem.mint }} className="text-neon hover:underline">full check →</Link>
        <Link to="/discover" search={{ mint: gem.mint }} className="text-neon hover:underline">find whales →</Link>
      </div>
      {(gem.failures.length > 0 || gem.warnings.length > 0) && (
        <div className="mt-2 text-xs">
          {gem.failures.length > 0 && <span className="text-loss">✗ {gem.failures.join(' · ')}</span>}
          {gem.failures.length > 0 && gem.warnings.length > 0 && <span className="text-dim"> · </span>}
          {gem.warnings.length > 0 && <span className="text-warn">△ {gem.warnings.join(' · ')}</span>}
        </div>
      )}
      <div className="mt-2 text-xs text-dim">
        held by{' '}
        {gem.holders.slice(0, 5).map((h, i) => (
          <span key={h.address}>
            {i > 0 && ', '}
            <Link to="/wallets/$address" params={{ address: h.address }} className="text-neon hover:underline">
              {h.label ?? truncAddr(h.address)}
            </Link>
          </span>
        ))}
        {gem.holders.length > 5 && ` +${gem.holders.length - 5}`}
      </div>
    </div>
  );
}
