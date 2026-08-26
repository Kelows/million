import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import type { CheckStatus } from '@million/shared';
import { useTokenReport } from '../api';
import { Addr } from '../components/Addr';
import { loadFailsafes } from '../lib/failsafes';
import { fmtAgo } from '../lib/format';

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const STATUS_STYLE: Record<CheckStatus, { label: string; text: string; border: string }> = {
  pass: { label: 'PASS', text: 'text-profit', border: 'border-profit' },
  warn: { label: 'WARN', text: 'text-warn', border: 'border-warn' },
  fail: { label: 'FAIL', text: 'text-loss', border: 'border-loss' },
  unknown: { label: '?', text: 'text-dim', border: 'border-line' },
};

const VERDICT_COPY: Record<CheckStatus, string> = {
  pass: 'No red flags on the automated checks. Not a guarantee — the custom system (bundlers, deployer history) is still to come.',
  warn: 'Tradeable but with caveats — read every warning before sizing anything.',
  fail: 'At least one critical check failed. The failsafes say no.',
  unknown: 'Not enough data to judge — sources unreachable or token too obscure.',
};

const fmtUsd = (n: number | null) => (n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export function TokenCheck() {
  const { mint: mintParam } = getRouteApi('/token-check').useSearch();
  const initial = mintParam && SOL_ADDR.test(mintParam) ? mintParam : null;
  const [input, setInput] = useState(initial ?? '');
  const [mint, setMint] = useState<string | null>(initial);
  const [inputError, setInputError] = useState<string | null>(null);
  const failsafes = loadFailsafes();
  const { data: report, isFetching, error } = useTokenReport(mint, failsafes);

  const submit = () => {
    const candidate = input.trim();
    if (!SOL_ADDR.test(candidate)) {
      setInputError('That is not a valid Solana mint address.');
      return;
    }
    setInputError(null);
    setMint(candidate);
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Token check</h1>
        <p className="text-sm text-dim mt-1">
          Paste a mint, get a verdict. Thresholds come from the <Link to="/screener" className="text-neon hover:underline">screener failsafes</Link>.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <div className="flex gap-3">
          <input
            placeholder="token mint address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="flex-1"
          />
          <button className="btn" disabled={!input.trim() || isFetching} onClick={submit}>
            {isFetching ? 'Checking…' : 'Check'}
          </button>
        </div>
        {inputError && <p className="text-xs text-loss">{inputError}</p>}
        {error && <p className="text-xs text-loss">{error.message}</p>}
      </div>

      {report && !isFetching && (
        <>
          <div className={`panel p-4 border-l-4 ${STATUS_STYLE[report.verdict].border}`}>
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <div>
                <span className={`font-mono text-2xl font-bold ${STATUS_STYLE[report.verdict].text}`}>
                  {report.verdict.toUpperCase()}
                </span>
                <span className="ml-3 text-bright font-semibold">{report.symbol ?? '?'}</span>
                <span className="ml-2 text-sm text-dim">{report.name ?? ''}</span>
              </div>
              <span className="flex items-center gap-3">
                <Addr address={report.mint} kind="token" />
                <Link to="/discover" search={{ mint: report.mint }} className="text-xs text-neon hover:underline">find whales →</Link>
              </span>
            </div>
            <p className="text-sm text-dim mt-2">{VERDICT_COPY[report.verdict]}</p>
            <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs font-mono text-dim">
              <span>price {report.priceUsd !== null ? `$${report.priceUsd}` : '—'}</span>
              <span>liq {fmtUsd(report.liquidityUsd)}</span>
              <span>mcap {fmtUsd(report.marketCapUsd)}</span>
              <span title={report.pairCreatedAt ?? ''}>pair created {fmtAgo(report.pairCreatedAt)}</span>
              {report.dex && <span>{report.dex}</span>}
              {report.pairUrl && (
                <a href={report.pairUrl} target="_blank" rel="noopener noreferrer" className="text-neon hover:underline">
                  chart ↗
                </a>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="px-4 pt-4 pb-2 eyebrow">Checks · {report.checks.length}</div>
            <ul>
              {report.checks.map((check) => (
                <li key={check.id} className="border-t border-line px-4 py-3 flex gap-4 items-start">
                  <span className={`font-mono text-xs font-bold w-12 shrink-0 mt-0.5 ${STATUS_STYLE[check.status].text}`}>
                    {STATUS_STYLE[check.status].label}
                  </span>
                  <span className="flex-1">
                    <span className="text-sm text-ink">{check.label}</span>
                    {check.value && <span className="ml-2 font-mono text-xs text-bright">{check.value}</span>}
                    <span className="block text-xs text-dim mt-0.5">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-dim">
            Sources: Helius (authorities, holders), DexScreener (market), RugCheck (risk scan). Checked {fmtAgo(report.fetchedAt)}.
          </p>
        </>
      )}
    </div>
  );
}
