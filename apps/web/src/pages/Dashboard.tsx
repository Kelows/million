import { Link } from '@tanstack/react-router';
import { useWallets } from '../api';
import { StatTile } from '../components/StatTile';
import { Addr } from '../components/Addr';
import { fmtPct, fmtSol } from '../lib/format';
import { openPositions } from '@million/shared';

export function Dashboard() {
  const { data: wallets = [], isLoading } = useWallets();
  const analyzed = wallets.filter((w) => w.metrics);
  const totalPnl = analyzed.reduce((s, w) => s + (w.metrics?.realizedPnlSol ?? 0), 0);
  const winRates = analyzed.map((w) => w.metrics?.winRate).filter((r): r is number => r !== null && r !== undefined);
  const avgWinRate = winRates.length ? winRates.reduce((s, r) => s + r, 0) / winRates.length : null;
  const top = analyzed
    .filter((w) => openPositions(w.metrics?.tokens ?? []).length > 0)
    .sort((a, b) => (b.metrics?.realizedPnlSol ?? 0) - (a.metrics?.realizedPnlSol ?? 0))
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Overview</h1>
        <p className="text-sm text-dim mt-1">Whale roster health at a glance. Stats cover analyzed wallets only.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile label="Roster" value={String(wallets.length)} sub="wallets tracked" />
        <StatTile label="Analyzed" value={`${analyzed.length}/${wallets.length}`} sub="with on-chain stats" />
        <StatTile label="Avg win rate" value={fmtPct(avgWinRate)} sub="across analyzed wallets" />
        <StatTile
          label="Combined realized PnL"
          value={analyzed.length ? fmtSol(totalPnl) : '—'}
          sub="recent window, SOL-leg swaps"
          tone={totalPnl > 0 ? 'profit' : totalPnl < 0 ? 'loss' : 'default'}
        />
      </div>

      {wallets.length === 0 && !isLoading ? (
        <div className="panel p-8 text-center">
          <div className="text-bright font-semibold">Roster is empty</div>
          <p className="text-sm text-dim mt-2 mb-4">Drop the whale JSON to start screening wallets.</p>
          <Link to="/wallets" className="btn inline-block">Import wallets</Link>
        </div>
      ) : (
        <div className="panel">
          <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
            <span className="eyebrow">Top wallets by realized PnL · with open positions (excl. stables)</span>
            <Link to="/wallets" className="text-xs text-neon hover:underline">full roster →</Link>
          </div>
          {top.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-dim">No analyzed wallets with open positions yet — run analysis from the Wallets page.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-left text-dim text-xs">
                    <th className="px-4 py-2 font-normal">wallet</th>
                    <th className="px-4 py-2 font-normal">win rate</th>
                    <th className="px-4 py-2 font-normal">tokens</th>
                    <th className="px-4 py-2 font-normal text-right">realized PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((w) => (
                    <tr key={w.address} className="border-t border-line hover:bg-deck2">
                      <td className="px-4 py-2">
                        <Link to="/wallets/$address" params={{ address: w.address }} className="text-neon hover:underline">
                          {w.label ?? `${w.address.slice(0, 4)}…${w.address.slice(-4)}`}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{fmtPct(w.metrics?.winRate ?? null)}</td>
                      <td className="px-4 py-2">{w.metrics?.uniqueTokens ?? '—'}</td>
                      <td className={`px-4 py-2 text-right ${(w.metrics?.realizedPnlSol ?? 0) >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {fmtSol(w.metrics?.realizedPnlSol ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="text-xs text-dim">
        Address list stays local. Analysis reads public on-chain history via Helius — nothing is signed, no keys touch this app.
      </div>
    </div>
  );
}
