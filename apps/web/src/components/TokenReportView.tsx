import type { CheckStatus, TokenReport } from '@million/shared';
import { Addr } from './Addr';
import { fmtAgo } from '../lib/format';

export const STATUS_STYLE: Record<CheckStatus, { label: string; text: string; border: string }> = {
  pass: { label: 'PASS', text: 'text-profit', border: 'border-profit' },
  warn: { label: 'WARN', text: 'text-warn', border: 'border-warn' },
  fail: { label: 'FAIL', text: 'text-loss', border: 'border-loss' },
  unknown: { label: '?', text: 'text-dim', border: 'border-line' },
};

const VERDICT_COPY: Record<CheckStatus, string> = {
  pass: 'No red flags on the automated checks. Not a guarantee — bundler/sniper analysis is still to come.',
  warn: 'Tradeable but with caveats — read every warning before sizing anything.',
  fail: 'At least one critical check failed. The failsafes say no.',
  unknown: 'Not enough data to judge — sources unreachable or token too obscure.',
};

const fmtUsd = (n: number | null) => (n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export function TokenReportView({ report, headerExtra }: { report: TokenReport; headerExtra?: React.ReactNode }) {
  return (
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
            {headerExtra}
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
    </>
  );
}
