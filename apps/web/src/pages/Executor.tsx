import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { loadFailsafes } from './Screener';

export function Executor() {
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('');
  const failsafes = loadFailsafes();

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Executor</h1>
        <p className="text-sm text-dim mt-1">
          Manual entries only: you pick the token and size, the screener gets veto power. Nothing executes yet — this
          page ships in paper mode until the screener checks are wired.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <span className="eyebrow">New entry</span>
        <label className="text-sm flex flex-col gap-1">
          Token mint address
          <input placeholder="paste the token mint" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label className="text-sm flex flex-col gap-1">
          Size (SOL)
          <input type="number" min={0} step={0.1} placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" />
        </label>
      </div>

      <div className="panel p-4">
        <span className="eyebrow">Pre-trade checks</span>
        <ul className="mt-3 flex flex-col gap-2 text-sm font-mono">
          <li className="text-dim">[ ] liquidity ≥ ${failsafes.minLiquidityUsd.toLocaleString('en-US')}</li>
          <li className="text-dim">[ ] market cap ≥ ${failsafes.minMarketCapUsd.toLocaleString('en-US')}</li>
          <li className="text-dim">[ ] legitimacy checks (see <Link to="/screener" className="text-neon hover:underline">screener</Link>)</li>
          <li className="text-dim">[ ] exit rule defined before entry</li>
        </ul>
      </div>

      <div className="flex items-center gap-4">
        <button className="btn btn-danger" disabled title="Execution is not wired — paper mode">
          Execute entry
        </button>
        <span className="text-xs text-pulse font-semibold tracking-widest">PAPER MODE — execution not wired</span>
      </div>
    </div>
  );
}
