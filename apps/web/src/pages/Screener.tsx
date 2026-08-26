import { useEffect, useState } from 'react';

export interface FailsafeConfig {
  minLiquidityUsd: number;
  minMarketCapUsd: number;
}

const DEFAULTS: FailsafeConfig = { minLiquidityUsd: 100_000, minMarketCapUsd: 200_000 };
const STORAGE_KEY = 'million.failsafes';

export function loadFailsafes(): FailsafeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const PLANNED_CHECKS = [
  { name: 'Mint authority revoked', why: 'team cannot print more supply' },
  { name: 'Freeze authority revoked', why: 'team cannot freeze your tokens (soft honeypot)' },
  { name: 'LP burned or locked', why: 'team cannot pull the liquidity' },
  { name: 'Sell simulation', why: 'hard honeypot check — can a wallet actually sell?' },
  { name: 'Top-10 holder concentration', why: 'under ~25% excluding LP is sane' },
  { name: 'Deployer history', why: 'serial-rugger detection from past launches' },
  { name: 'Bundle/sniper concentration', why: 'bundled first-block buys = hidden team supply' },
  { name: 'Holder growth curve', why: 'organic vs. botted accumulation' },
];

export function Screener() {
  const [config, setConfig] = useState<FailsafeConfig>(loadFailsafes);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 1200);
      return () => clearTimeout(t);
    } catch {
      /* storage unavailable — config stays in memory */
    }
  }, [config]);

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Token screener</h1>
        <p className="text-sm text-dim mt-1">
          Failsafes every entry must pass. The executor reads these before any trade is allowed.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <span className="eyebrow">Failsafes {saved && <span className="text-profit normal-case tracking-normal">· saved</span>}</span>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            Minimum liquidity (USD)
            <span className="block text-xs text-dim">thin pools = you are the exit liquidity</span>
          </span>
          <input
            type="number"
            min={0}
            step={10_000}
            value={config.minLiquidityUsd}
            onChange={(e) => setConfig((c) => ({ ...c, minLiquidityUsd: Number(e.target.value) }))}
            className="w-40 text-right"
          />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            Minimum market cap (USD)
            <span className="block text-xs text-dim">filters the sub-graduation churn (98%+ die)</span>
          </span>
          <input
            type="number"
            min={0}
            step={50_000}
            value={config.minMarketCapUsd}
            onChange={(e) => setConfig((c) => ({ ...c, minMarketCapUsd: Number(e.target.value) }))}
            className="w-40 text-right"
          />
        </label>
      </div>

      <div className="panel p-4">
        <span className="eyebrow">Legitimacy checks — planned, not wired yet</span>
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
