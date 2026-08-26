import { Link, useParams } from '@tanstack/react-router';
import { useAnalyzeWallet, useWallet } from '../api';
import { StatTile } from '../components/StatTile';
import { FlagChip } from '../components/FlagChip';
import { Addr, classicUrl, explorerUrl } from '../components/Addr';
import { fmtAgo, fmtDate, fmtHold, fmtPct, fmtSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { SortHeader } from '../components/SortHeader';
import type { TokenBreakdown } from '@million/shared';

const TOKEN_COLUMNS: SortColumn<TokenBreakdown>[] = [
  { key: 'symbol', get: (t) => t.symbol },
  { key: 'trades', get: (t) => t.buys + t.sells },
  { key: 'solIn', get: (t) => t.solIn },
  { key: 'solOut', get: (t) => t.solOut },
  { key: 'realized', get: (t) => t.realizedPnlSol },
  { key: 'hold', get: (t) => t.holdMinutes },
  { key: 'state', get: (t) => (t.open ? 1 : 0) },
];

export function WalletDetail() {
  const { address } = useParams({ from: '/wallets/$address' });
  const { data: wallet, isLoading, error } = useWallet(address);
  const analyze = useAnalyzeWallet();
  // hook must run on every render path, so it sits above the early returns
  const tokenSort = useTableSort(wallet?.metrics?.tokens ?? [], TOKEN_COLUMNS, 'realized');

  if (isLoading) return <p className="text-dim text-sm">Loading…</p>;
  if (error || !wallet) {
    return (
      <div className="panel p-6 max-w-xl">
        <p className="text-loss text-sm">{error?.message ?? 'Wallet not found.'}</p>
        <Link to="/wallets" className="text-neon text-sm hover:underline mt-2 inline-block">← back to roster</Link>
      </div>
    );
  }

  const m = wallet.metrics;

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to="/wallets" className="text-xs text-dim hover:text-ink">← roster</Link>
          <h1 className="text-xl font-bold text-bright tracking-wide mt-1">
            {wallet.label ?? truncAddr(wallet.address)}
          </h1>
          <div className="mt-1 text-sm"><Addr address={wallet.address} full /></div>
          <div className="mt-1 flex gap-3 text-xs">
            <a href={explorerUrl('wallet', wallet.address)} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">GMGN ↗</a>
            <a href={classicUrl('wallet', wallet.address)} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">Solscan ↗</a>
          </div>
          <div className="flex gap-1 mt-2 flex-wrap">{(m?.flags ?? []).map((f) => <FlagChip key={f} flag={f} />)}</div>
        </div>
        <div className="text-right">
          <button className="btn" disabled={wallet.status === 'analyzing' || analyze.isPending} onClick={() => analyze.mutate(wallet.address)}>
            {wallet.status === 'analyzing' || analyze.isPending ? 'Analyzing…' : m ? 'Re-run analysis' : 'Analyze'}
          </button>
          <div className="text-xs text-dim mt-2" title={wallet.lastAnalyzedAt ?? ""}>last run {fmtAgo(wallet.lastAnalyzedAt)}</div>
        </div>
      </div>

      {wallet.status === 'error' && wallet.error && (
        <div className="panel p-3 text-xs text-loss">{wallet.error}</div>
      )}

      {!m ? (
        <div className="panel p-8 text-center text-sm text-dim">
          No analysis yet. Run it to pull this wallet's recent swap history from Helius.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="Realized PnL"
              value={fmtSol(m.realizedPnlSol)}
              sub={m.truncated ? `recent ${m.analyzedTxCount} swaps (truncated)` : `${m.analyzedTxCount} swaps`}
              tone={m.realizedPnlSol >= 0 ? 'profit' : 'loss'}
            />
            <StatTile label="Win rate" value={fmtPct(m.winRate)} sub={`${m.closedTokens} closed tokens`} />
            <StatTile label="Median hold" value={fmtHold(m.medianHoldMinutes)} sub="first buy → last sell" />
            <StatTile label="Last active" value={fmtAgo(m.lastSeen)} sub={`${fmtDate(m.firstSeen)} → ${fmtDate(m.lastSeen)}`} />
          </div>

          <div className="panel">
            <div className="px-4 pt-4 pb-2 eyebrow">Per-token breakdown · {m.tokens.length}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="text-left text-dim text-xs">
                    <SortHeader label="token" colKey="symbol" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} />
                    <SortHeader label="buys/sells" colKey="trades" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} />
                    <SortHeader label="SOL in" colKey="solIn" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} right />
                    <SortHeader label="SOL out" colKey="solOut" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} right />
                    <SortHeader label="realized" colKey="realized" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} right />
                    <SortHeader label="hold" colKey="hold" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} />
                    <SortHeader label="state" colKey="state" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {tokenSort.sorted.map((t) => (
                    <tr key={t.mint} className="border-t border-line hover:bg-deck2">
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-2">
                          {t.symbol && <span className="text-bright font-semibold">{t.symbol}</span>}
                          <Addr address={t.mint} kind="token" />
                        </span>
                      </td>
                      <td className="px-4 py-2">{t.buys}/{t.sells}</td>
                      <td className="px-4 py-2 text-right text-dim">{t.solIn.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right text-dim">{t.solOut.toFixed(2)}</td>
                      <td className={`px-4 py-2 text-right ${t.realizedPnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {fmtSol(t.realizedPnlSol)}
                      </td>
                      <td className="px-4 py-2">{fmtHold(t.holdMinutes)}</td>
                      <td className="px-4 py-2 text-xs">{t.open ? <span className="text-warn">open</span> : <span className="text-dim">closed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-dim">
            PnL is average-cost realized PnL on SOL-leg swaps within the fetched window. Token→token swaps and
            positions opened before the window are excluded — treat these as screening signals, not accounting.
          </p>
        </>
      )}
    </div>
  );
}
