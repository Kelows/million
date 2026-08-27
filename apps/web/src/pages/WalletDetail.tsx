import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useAnalyzeWallet, useImportWallets, useSetSubscribed, useWallet } from '../api';
import { StatTile } from '../components/StatTile';
import { FlagChip } from '../components/FlagChip';
import { Addr, classicUrl, explorerUrl } from '../components/Addr';
import { fmtAgo, fmtDate, fmtHold, fmtPct, fmtSol, totalPnlSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { usePagination } from '../lib/usePagination';
import { EyeIcon } from '../components/icons';
import { Pagination } from '../components/Pagination';
import { SortHeader } from '../components/SortHeader';
import type { TokenBreakdown } from '@million/shared';

const TOKEN_COLUMNS: SortColumn<TokenBreakdown>[] = [
  { key: 'symbol', get: (t) => t.symbol },
  { key: 'trades', get: (t) => t.buys + t.sells },
  { key: 'solIn', get: (t) => t.solIn },
  { key: 'solOut', get: (t) => t.solOut },
  { key: 'realized', get: (t) => t.realizedPnlSol + (t.realizedPnlUsd ?? 0) / 200 },
  { key: 'hold', get: (t) => t.holdMinutes },
  { key: 'state', get: (t) => (t.open ? 1 : 0) },
];

export function WalletDetail() {
  const { address } = useParams({ from: '/wallets/$address' });
  const { data: wallet, isLoading, error } = useWallet(address);
  const analyze = useAnalyzeWallet();
  const importWallets = useImportWallets();
  const [autoRun, setAutoRun] = useState(false);
  const notInRoster = Boolean(error?.message.includes('not in the roster'));

  // arriving on an unknown wallet (e.g. from a funding trace): import + analyze it
  useEffect(() => {
    if (!notInRoster || autoRun) return;
    setAutoRun(true);
    importWallets
      .mutateAsync({ wallets: [address], source: 'auto-visit' })
      .then(() => analyze.mutateAsync(address))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notInRoster, autoRun, address]);
  // hook must run on every render path, so it sits above the early returns
  const tokenSort = useTableSort(wallet?.metrics?.tokens ?? [], TOKEN_COLUMNS, 'realized');
  const pag = usePagination(tokenSort.sorted, 25);
  const setSubscribed = useSetSubscribed();

  if (isLoading) return <p className="text-dim text-sm">Loading…</p>;
  if (notInRoster || (autoRun && !wallet)) {
    return (
      <div className="panel p-6 max-w-xl">
        <p className="text-sm text-ink">New wallet — adding to the roster and analyzing…</p>
        <p className="text-xs text-dim mt-2 font-mono">{address}</p>
        {analyze.error && <p className="text-xs text-loss mt-2">{analyze.error.message}</p>}
      </div>
    );
  }
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
          {m?.topFeePayer && (
            <div className="text-xs text-dim mt-2">
              orchestrator: <Addr address={m.topFeePayer.address} /> pays fees on {Math.round(m.topFeePayer.share * 100)}% of txs
            </div>
          )}
          {(wallet.ownerSiblings?.length ?? 0) > 0 && (
            <div className="text-xs mt-2">
              <span className="text-warn font-semibold uppercase tracking-wider text-[0.6rem]">same owner</span>{' '}
              <span className="text-dim">·</span>{' '}
              {wallet.ownerSiblings!.map((s, i) => (
                <span key={s.address}>
                  {i > 0 && <span className="text-dim">, </span>}
                  <Link to="/wallets/$address" params={{ address: s.address }} className="text-neon hover:underline">
                    {s.label ?? truncAddr(s.address)}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <button
            className={`btn mr-2 ${wallet.subscribed ? 'bg-neon! text-void!' : ''}`}
            title={wallet.subscribed ? 'Streaming to the Live feed — click to unsubscribe' : 'Stream this wallet\u2019s swaps to the Live feed in real time'}
            disabled={setSubscribed.isPending}
            onClick={() => setSubscribed.mutate({ address: wallet.address, subscribed: !wallet.subscribed })}
          >
            {wallet.subscribed ? 'Subbed ●' : 'Sub'}
          </button>
          <Link to="/funding" search={{ address: wallet.address }} className="btn inline-block mr-2">
            Funding chains
          </Link>
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
              value={fmtSol(totalPnlSol(m) ?? 0)}
              sub={`${m.realizedPnlUsd ? `incl. $${Math.round(m.realizedPnlUsd).toLocaleString('en-US')} in stable legs · ` : ''}${m.truncated ? `recent ${m.analyzedTxCount} txs (truncated)` : `${m.analyzedTxCount} txs`}`}
              tone={(totalPnlSol(m) ?? 0) >= 0 ? 'profit' : 'loss'}
              hint="Average-cost realized PnL. SOL, USDC and USDT all count as quote currencies; stable legs are converted at the SOL price fetched at analysis time. Token→token swaps and positions opened before the window are excluded."
            />
            <StatTile label="Win rate" value={fmtPct(m.winRate)} sub={`${m.closedTokens} closed tokens`} hint="Profitable closed tokens / all closed tokens. A token counts as closed once it has at least one buy and one sell in the window." />
            <StatTile label="Median hold" value={fmtHold(m.medianHoldMinutes)} sub="first buy → last sell" hint="Median time from a token's first buy to its last sell, across closed tokens. Under 5 minutes on 5+ tokens earns the sniper flag — uncopyable by hand." />
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
                  {pag.rows.map((t) => (
                    <tr key={t.mint} className="border-t border-line hover:bg-deck2">
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-2">
                          <Link to="/tokens/$mint" params={{ mint: t.mint }} title="Open token detail" className="text-dim hover:text-neon inline-flex">
                            <EyeIcon />
                          </Link>
                          <Addr address={t.mint} kind="token" symbol={t.symbol} />
                        </span>
                      </td>
                      <td className="px-4 py-2">{t.buys}/{t.sells}</td>
                      <td className="px-4 py-2 text-right text-dim">{t.solIn.toFixed(2)}</td>
                      <td className="px-4 py-2 text-right text-dim">{t.solOut.toFixed(2)}</td>
                      <td className={`px-4 py-2 text-right ${t.realizedPnlSol + (t.realizedPnlUsd ?? 0) / 200 >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {fmtSol(t.realizedPnlSol)}
                        {Math.abs(t.realizedPnlUsd ?? 0) >= 1 && (
                          <span className="block text-xs opacity-80">{(t.realizedPnlUsd ?? 0) > 0 ? '+' : '−'}${Math.abs(Math.round(t.realizedPnlUsd ?? 0)).toLocaleString('en-US')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">{fmtHold(t.holdMinutes)}</td>
                      <td className="px-4 py-2 text-xs">{t.open ? <span className="text-warn">open</span> : <span className="text-dim">closed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
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
