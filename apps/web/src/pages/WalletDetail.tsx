import { useEffect, useState } from 'react';
import { getRouteApi, Link, useNavigate, useParams } from '@tanstack/react-router';
import { useAnalyzeWallet, useImportWallets, useRemoveWallet, useSetLabel, useSetSubscribed, useSubscribeOwner, useWallet } from '../api';
import { StatTile } from '../components/StatTile';
import { FlagChip } from '../components/FlagChip';
import { Addr, classicUrl, explorerUrl } from '../components/Addr';
import { fmtAgo, fmtDate, fmtHold, fmtPct, fmtSol, observedPnlSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { usePagination } from '../lib/usePagination';
import { EyeIcon } from '../components/icons';
import { Pagination } from '../components/Pagination';
import { SortHeader } from '../components/SortHeader';
import { tokenRealizedSol, tokenSolIn, tokenSolOut, type TokenBreakdown, type WalletMetrics } from '@million/shared';

const NO_METRICS = { solEquivalent: true } as WalletMetrics;

// Every amount in SOL, stablecoin legs included (see tokenSolIn in shared).
const tokenColumns = (m: WalletMetrics = NO_METRICS): SortColumn<TokenBreakdown>[] => [
  { key: 'symbol', get: (t) => t.symbol },
  { key: 'trades', get: (t) => t.buys + t.sells },
  { key: 'solIn', get: (t) => tokenSolIn(t, m) },
  { key: 'solOut', get: (t) => tokenSolOut(t, m) },
  { key: 'realized', get: (t) => tokenRealizedSol(t, m) },
  { key: 'hold', get: (t) => t.holdMinutes },
  { key: 'opened', get: (t) => (t.firstBuyAt ? new Date(t.firstBuyAt).getTime() : null) },
  { key: 'activity', get: (t) => (t.lastActivityAt ? new Date(t.lastActivityAt).getTime() : null) },
  { key: 'state', get: (t) => (t.open ? 1 : 0) },
];

/** Hover text for the stablecoin part of an amount, which the SOL figure already includes. */
function stableNote(amountUsd: number | undefined, verb: 'paid' | 'received'): string | undefined {
  if (!amountUsd || amountUsd < 1) return undefined;
  return `includes $${Math.round(amountUsd).toLocaleString('en-US')} ${verb} in USDC/USDT, converted at the SOL price of each trade`;
}

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
  const urlSearch = getRouteApi('/wallets/$address').useSearch();
  const navigate = useNavigate();
  const tokenSort = useTableSort(wallet?.metrics?.tokens ?? [], tokenColumns(wallet?.metrics ?? undefined), urlSearch.sort ?? 'activity', urlSearch.dir ?? 'desc');
  useEffect(() => {
    void navigate({ to: '/wallets/$address', params: { address }, search: { sort: tokenSort.sortKey ?? undefined, dir: tokenSort.dir }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenSort.sortKey, tokenSort.dir]);
  const pag = usePagination(tokenSort.sorted, 25);
  const setSubscribed = useSetSubscribed();
  const setLabel = useSetLabel();
  const removeWallet = useRemoveWallet();
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const subscribeOwner = useSubscribeOwner();

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
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to="/wallets" className="text-xs text-dim hover:text-ink">← roster</Link>
          <h1 className="text-xl font-bold text-bright tracking-wide mt-1 flex items-center gap-3 flex-wrap">
            {editingLabel ? (
              <input
                autoFocus
                value={labelDraft}
                placeholder="label this wallet"
                className="text-base font-normal w-56"
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setLabel.mutate({ address: wallet.address, label: labelDraft.trim() || null });
                    setEditingLabel(false);
                  }
                  if (e.key === 'Escape') setEditingLabel(false);
                }}
                onBlur={() => setEditingLabel(false)}
              />
            ) : (
              <>
                {wallet.label ?? truncAddr(wallet.address)}
                <button
                  type="button"
                  title={wallet.label ? 'Edit label' : 'Label this wallet'}
                  className="text-dim hover:text-neon text-sm font-normal"
                  onClick={() => {
                    setLabelDraft(wallet.label ?? '');
                    setEditingLabel(true);
                  }}
                >
                  ✎
                </button>
              </>
            )}
            {(m?.flags ?? []).map((f) => <FlagChip key={f} flag={f} size="md" />)}
          </h1>
          <div className="mt-1 text-sm"><Addr address={wallet.address} full /></div>
          <div className="mt-1 flex gap-3 text-xs">
            <a href={explorerUrl('wallet', wallet.address)} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">GMGN ↗</a>
            <a href={classicUrl('wallet', wallet.address)} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">Solscan ↗</a>
          </div>
          {m?.topFeePayer && (
            <div className="text-xs text-dim mt-2">
              orchestrator: <Addr address={m.topFeePayer.address} /> pays fees on {Math.round(m.topFeePayer.share * 100)}% of txs
            </div>
          )}
          {(wallet.ownerSiblings?.length ?? 0) > 0 && wallet.ownerAggregate && (
            <div className="panel p-3 mt-3 max-w-xl">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <span className="eyebrow">Owner · {wallet.ownerAggregate.members} wallets</span>
                <button
                  className="btn py-1! px-2! text-[0.6rem]!"
                  disabled={subscribeOwner.isPending}
                  title="Subscribe every wallet this owner uses."
                  onClick={() =>
                    subscribeOwner.mutate({
                      address: wallet.address,
                      subscribed: wallet.ownerAggregate!.subscribedCount !== wallet.ownerAggregate!.members,
                    })
                  }
                >
                  {wallet.ownerAggregate.subscribedCount === wallet.ownerAggregate.members
                    ? `Subbed all ●`
                    : `Sub owner (${wallet.ownerAggregate.members})`}
                </button>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs font-mono">
                <span className={wallet.ownerAggregate.combinedPnlSol >= 0 ? 'text-profit' : 'text-loss'}>
                  {fmtSol(wallet.ownerAggregate.combinedPnlSol)} combined
                </span>
                <span className="text-ink">WR {fmtPct(wallet.ownerAggregate.winRate)} pooled</span>
                <span className="text-dim">{wallet.ownerAggregate.closedTokens} closed</span>
                <span className="text-warn">{wallet.ownerAggregate.openTokens} open tokens</span>
                <span className="text-dim">{wallet.ownerAggregate.subscribedCount}/{wallet.ownerAggregate.members} subbed</span>
              </div>
              <div className="text-xs mt-2">
                {wallet.ownerSiblings!.map((s, i) => (
                  <span key={s.address}>
                    {i > 0 && <span className="text-dim">, </span>}
                    <Link to="/wallets/$address" params={{ address: s.address }} className="text-neon hover:underline">
                      {s.label ?? truncAddr(s.address)}
                    </Link>
                  </span>
                ))}
              </div>
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
          <button
            className="btn btn-danger ml-2"
            disabled={removeWallet.isPending}
            title="Remove this wallet from the roster"
            onClick={() => {
              if (window.confirm(`Remove ${wallet.label ?? truncAddr(wallet.address)} from the roster?`)) {
                removeWallet.mutate(wallet.address, { onSuccess: () => void navigate({ to: '/wallets' }) });
              }
            }}
          >
            Remove
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
          {/* same wrapping flex row as the Trading tiles: each tile hugs its content, the row shares the leftover width */}
          <div className="flex gap-4 *:flex-1 *:min-w-0 *:whitespace-nowrap overflow-x-auto">
            <StatTile
              label="Observed PnL"
              value={wallet.observed?.trades ? fmtSol(observedPnlSol(wallet) ?? 0) : '—'}
              sub={
                wallet.observed?.trades
                  ? `${wallet.observed.trades} round trips watched · ${wallet.observed.wins} won`
                  : 'unmeasured — no round trip watched yet'
              }
              tone={(observedPnlSol(wallet) ?? 0) > 0 ? 'profit' : (observedPnlSol(wallet) ?? 0) < 0 ? 'loss' : 'default'}
              hint="PnL from round trips we watched from buy to sell, so the cost is known. Older history isn't counted: its cost basis can't be trusted."
            />
            {wallet.unrealized && (
              <StatTile
                label="Unrealized PnL"
                value={`${wallet.unrealized.pnlSol > 0 ? '+' : ''}${wallet.unrealized.pnlSol} \u25ce`}
                sub={`${wallet.unrealized.priced}/${wallet.unrealized.positions} valued \u00b7 ${wallet.unrealized.costSol} \u25ce at cost${wallet.unrealized.pnlPct !== null ? ` \u00b7 ${wallet.unrealized.pnlPct > 0 ? '+' : ''}${wallet.unrealized.pnlPct}%` : ''}`}
                tone={wallet.unrealized.pnlSol > 0 ? 'profit' : wallet.unrealized.pnlSol < 0 ? 'loss' : 'default'}
                hint={`Open positions at today's prices (${wallet.unrealized.priced} of ${wallet.unrealized.positions} priced). Tokens with no price count as worthless.`}
              />
            )}
            <StatTile label="Win rate" value={fmtPct(m.winRate)} sub={`${m.closedTokens} closed tokens`} hint="Share of closed tokens that made money. Closed = at least one buy and one sell." />
            <StatTile label="Median hold" value={fmtHold(m.medianHoldMinutes)} sub="first buy → last sell" hint="Median time from first buy to last sell. Under 5 minutes across 5+ tokens earns the sniper flag." />
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
                    <SortHeader label="opened" colKey="opened" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} hint="When the position was first bought." />
                    <SortHeader label="last activity" colKey="activity" sortKey={tokenSort.sortKey} dir={tokenSort.dir} onToggle={tokenSort.toggle} hint="Last buy or sell. Recent means still active." />
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
                      <td className="px-4 py-2 text-right text-dim" title={stableNote(t.usdIn, 'paid')}>{tokenSolIn(t, m).toFixed(2)}</td>
                      <td className="px-4 py-2 text-right text-dim" title={stableNote(t.usdOut, 'received')}>{tokenSolOut(t, m).toFixed(2)}</td>
                      <td className={`px-4 py-2 text-right ${tokenRealizedSol(t, m) >= 0 ? 'text-profit' : 'text-loss'}`}>{fmtSol(tokenRealizedSol(t, m))}</td>
                      <td className="px-4 py-2">{fmtHold(t.holdMinutes)}</td>
                      <td className="px-4 py-2 text-dim whitespace-nowrap" title={t.firstBuyAt ?? ''}>{fmtAgo(t.firstBuyAt ?? null)}</td>
                      <td className="px-4 py-2 whitespace-nowrap" title={t.lastActivityAt ?? ''}>
                        {(() => {
                          if (!t.lastActivityAt) return <span className="text-dim">—</span>;
                          const hours = (Date.now() - new Date(t.lastActivityAt).getTime()) / 3_600_000;
                          const cls = t.open ? (hours < 24 ? 'text-profit' : hours < 24 * 7 ? 'text-warn' : 'text-dim') : 'text-dim';
                          return <span className={cls}>{fmtAgo(t.lastActivityAt)}</span>;
                        })()}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {t.open ? (
                          <span className="text-warn">open</span>
                        ) : t.sells === 0 ? (
                          // bought, never sold, nothing left: sent to another wallet or swapped into another token
                          <span className="text-dim" title="Bought, never sold for SOL or stablecoins, nothing left: sent to another wallet or swapped into another token.">moved out</span>
                        ) : (
                          <span className="text-dim">closed</span>
                        )}
                      </td>
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
