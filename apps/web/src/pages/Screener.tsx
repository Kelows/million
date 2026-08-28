import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useCrawler, useSetCrawlerConfig } from '../api';
import { loadMinOpenSol, saveMinOpenSol } from '../lib/settings';
import { ThresholdFields } from '../components/ThresholdFields';

const PLANNED_CHECKS = [
  { name: 'Deployer history', why: 'serial-rugger detection from past launches' },
  { name: 'Bundle/sniper concentration', why: 'bundled first-block buys = hidden team supply' },
  { name: 'Holder growth curve', why: 'organic vs. botted accumulation' },
  { name: 'LP vault exclusion in holder math', why: 'clean top-10 % without the pool' },
];


export function Screener() {
  const { data: crawler } = useCrawler();
  const save = useSetCrawlerConfig();
  const [minOpenSol, setMinOpenSol] = useState<number>(loadMinOpenSol);
  const config = crawler?.config;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Token screener</h1>
        <p className="text-sm text-dim mt-1">
          Failsafes every entry must pass — ONE set of thresholds, stored server-side: manual checks, opportunities,
          the crawler and re-checks all read the same values (also editable on the <Link to="/crawler" className="text-neon hover:underline">Crawler</Link> page).
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <span className="eyebrow">Failsafes {save.isSuccess && <span className="text-profit normal-case tracking-normal">· saved</span>}</span>
        {config ? (
          <ThresholdFields value={config.thresholds} onChange={(t) => save.mutate({ ...config, thresholds: t })} />
        ) : (
          <p className="text-sm text-dim">Loading…</p>
        )}
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <span className="eyebrow">Analytics</span>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            Min open position size (SOL)
            <span className="block text-xs text-dim">entries below this are dust, not conviction — affects open counts, filters and recs</span>
          </span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={minOpenSol}
            onChange={(e) => {
              const n = Number(e.target.value);
              setMinOpenSol(n);
              saveMinOpenSol(n);
            }}
            className="w-40 text-right"
          />
        </label>
      </div>

      <div className="panel p-4">
        <span className="eyebrow">Checks live in token check</span>
        <p className="text-sm text-dim mt-2">
          Mint/freeze authority, Token-2022 extensions, sell simulation (round-trip exit cost via Jupiter),
          liquidity, market cap, pair age, LP-excluded top-10 concentration, deployer history and the RugCheck
          risk scan already run on the <Link to="/token-check" className="text-neon hover:underline">token check</Link> page.
        </p>
      </div>

      <div className="panel p-4">
        <span className="eyebrow">Planned checks — the custom system</span>
        <ul className="mt-3 flex flex-col gap-2">
          {PLANNED_CHECKS.map((check) => (
            <li key={check.name} className="flex items-baseline gap-3 text-sm">
              <span className="text-dim font-mono text-xs">[ ]</span>
              <span className="text-ink">{check.name}</span>
              <span className="text-xs text-dim">— {check.why}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-dim mt-3">Full research list lives in TODO.md at the repo root.</p>
      </div>
    </div>
  );
}
