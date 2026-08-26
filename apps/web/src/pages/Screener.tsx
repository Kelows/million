import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { loadFailsafes, saveFailsafes, type FailsafeConfig } from '../lib/failsafes';
import { loadMinOpenSol, saveMinOpenSol } from '../lib/settings';

const PLANNED_CHECKS = [
  { name: 'Sell simulation', why: 'hard honeypot check — can a wallet actually sell?' },
  { name: 'Deployer history', why: 'serial-rugger detection from past launches' },
  { name: 'Bundle/sniper concentration', why: 'bundled first-block buys = hidden team supply' },
  { name: 'Holder growth curve', why: 'organic vs. botted accumulation' },
  { name: 'LP vault exclusion in holder math', why: 'clean top-10 % without the pool' },
];

interface ThresholdField {
  key: keyof FailsafeConfig;
  label: string;
  hint: string;
  step: number;
}

const FIELDS: ThresholdField[] = [
  { key: 'minLiquidityUsd', label: 'Minimum liquidity (USD)', hint: 'thin pools = you are the exit liquidity', step: 10_000 },
  { key: 'minMarketCapUsd', label: 'Minimum market cap (USD)', hint: 'filters the sub-graduation churn (98%+ die)', step: 50_000 },
  { key: 'maxTop10Pct', label: 'Max top-10 holders (%)', hint: 'consensus red line is 25–30% (LP vault included for now)', step: 5 },
  { key: 'minTokenAgeMinutes', label: 'Minimum pair age (minutes)', hint: 'most rugs happen in the first hour', step: 15 },
];

export function Screener() {
  const [config, setConfig] = useState<FailsafeConfig>(loadFailsafes);
  const [minOpenSol, setMinOpenSol] = useState<number>(loadMinOpenSol);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saveFailsafes(config)) return;
    setSaved(true);
    const t = setTimeout(() => setSaved(false), 1200);
    return () => clearTimeout(t);
  }, [config]);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Token screener</h1>
        <p className="text-sm text-dim mt-1">
          Failsafes every entry must pass. <Link to="/token-check" className="text-neon hover:underline">Token check</Link> and
          the executor both read these thresholds.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <span className="eyebrow">Failsafes {saved && <span className="text-profit normal-case tracking-normal">· saved</span>}</span>
        {FIELDS.map((field) => (
          <label key={field.key} className="flex items-center justify-between gap-4 text-sm">
            <span>
              {field.label}
              <span className="block text-xs text-dim">{field.hint}</span>
            </span>
            <input
              type="number"
              min={0}
              step={field.step}
              value={config[field.key]}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: Number(e.target.value) }))}
              className="w-40 text-right"
            />
          </label>
        ))}
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
          Mint/freeze authority, metadata mutability, token program, liquidity, market cap, pair age, top-10
          concentration, and the RugCheck risk scan already run on the <Link to="/token-check" className="text-neon hover:underline">token check</Link> page.
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
