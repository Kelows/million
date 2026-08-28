import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useEmitters, useLiveEvents, useLiveStatus, useOpportunities, useSetSubscribed } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { FlagChip } from '../components/FlagChip';
import { fmtAgo, truncAddr } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { Pagination } from '../components/Pagination';

const KIND_STYLE: Record<string, string> = {
  buy: 'text-profit',
  sell: 'text-loss',
  other: 'text-dim',
};

export function Live() {
  const { data: status } = useLiveStatus();
  const { data: events = [] } = useLiveEvents(150);
  const { data: opportunities = [] } = useOpportunities();
  const [buysOnly, setBuysOnly] = useState(false);
  const [minSol, setMinSol] = useState(0);
  // signal lens: the firehose is healthy, legibility is the problem — filter
  // locally and badge the events that actually became opportunities
  const oppMints = new Set(opportunities.filter((o) => o.mint).map((o) => o.mint));
  const visible = events.filter((e) => (!buysOnly || e.kind === 'buy') && Math.abs(e.sol ?? 0) >= minSol);
  const pag = usePagination(visible, 25);
  const { data: emitters = [] } = useEmitters();
  const setSubscribed = useSetSubscribed();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Live</h1>
          <p className="text-sm text-dim mt-1">
            Every swap from subscribed wallets, seconds after it lands on-chain. Sub wallets from their detail page —
            up to {status?.maxSubscriptions ?? 25} on the current plan.
          </p>
        </div>
        <div className="text-right shrink-0 text-xs font-mono">
          <div className={`font-bold ${status?.connected ? 'text-profit' : 'text-loss'}`}>
            {status?.connected ? '● FEED CONNECTED' : '○ FEED DOWN'}
          </div>
          <div className="text-dim mt-1">
            {status?.activeSubscriptions ?? 0}/{status?.subscribedWallets ?? 0} wallets streaming
          </div>
          <div className="text-dim">{status?.eventsToday ?? 0} events today</div>
        </div>
      </div>

      {emitters.length > 0 && (
        <div className="panel">
          <div className="px-4 pt-4 pb-2 eyebrow">Top emitters · last 15 min · spam is a signal too</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <tbody>
                {emitters.slice(0, 8).map((e) => (
                  <tr key={e.wallet} className="border-t border-line hover:bg-deck2">
                    <td className="pl-4 pr-0 py-2 w-8">
                      <Link to="/wallets/$address" params={{ address: e.wallet }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
                    </td>
                    <td className="px-4 py-2 text-ink">{e.label ?? truncAddr(e.wallet)}</td>
                    <td className="px-4 py-2 text-warn font-bold">{e.events} ev</td>
                    <td className="px-4 py-2 text-dim">{e.medianHoldMinutes !== null ? `hold ${e.medianHoldMinutes}m` : 'unanalyzed'}</td>
                    <td className="px-4 py-2">
                      <span className="flex gap-1">{(e.flags ?? []).map((f) => <FlagChip key={f} flag={f as import('@million/shared').WalletFlag} />)}</span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {e.subscribed && (
                        <button className="text-xs text-dim hover:text-loss" title="Unsubscribe — stop this wallet flooding the feed" onClick={() => setSubscribed.mutate({ address: e.wallet, subscribed: false })}>
                          unsub ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4 flex-wrap">
          <span className="eyebrow">Events · newest first</span>
          <span className="flex items-center gap-4 text-xs font-mono">
            <label className="flex items-center gap-1.5 text-dim cursor-pointer">
              <input type="checkbox" checked={buysOnly} onChange={(e) => setBuysOnly(e.target.checked)} />
              buys only
            </label>
            <label className="flex items-center gap-1.5 text-dim">
              ≥
              <input type="number" min={0} step={1} value={minSol} onChange={(e) => setMinSol(Number(e.target.value))} className="w-16 text-right" />
              ◎
            </label>
            <span className="text-dim">{visible.length}/{events.length}</span>
          </span>
        </div>
        {events.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">
            Nothing yet. Sub a wallet (its detail page → Sub) and events appear here as they trade.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="px-4 py-2 font-normal">when</th>
                  <th className="px-4 py-2 font-normal">wallet</th>
                  <th className="px-4 py-2 font-normal">action</th>
                  <th className="px-4 py-2 font-normal">token</th>
                  <th className="px-4 py-2 font-normal text-right">SOL</th>
                  <th className="px-4 py-2 font-normal text-right">USD</th>
                  <th className="px-4 py-2 font-normal">tx</th>
                </tr>
              </thead>
              <tbody>
                {pag.rows.map((e) => (
                  <tr key={e.id} className="border-t border-line hover:bg-deck2">
                    <td className="px-4 py-2 text-dim whitespace-nowrap" title={e.ts}>{fmtAgo(e.ts)}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <Link to="/wallets/$address" params={{ address: e.wallet }} className="text-dim hover:text-neon inline-flex">
                          <EyeIcon />
                        </Link>
                        <span className="text-ink">{e.walletLabel ?? truncAddr(e.wallet)}</span>
                      </span>
                    </td>
                    <td className={`px-4 py-2 font-bold uppercase text-xs ${KIND_STYLE[e.kind]}`}>{e.kind}</td>
                    <td className="px-4 py-2">
                      {e.mint ? (
                        <span className="inline-flex items-center gap-2">
                          <Link to="/tokens/$mint" params={{ mint: e.mint }} className="text-dim hover:text-neon inline-flex">
                            <EyeIcon />
                          </Link>
                          {e.symbol && e.mint && <TokenName mint={e.mint} symbol={e.symbol} />}
                          <Addr address={e.mint} kind="token" />
                          {oppMints.has(e.mint) && (
                            <Link to="/opportunities" title="this token fired an opportunity" className="text-neon border border-neon/50 px-1 text-[0.6rem] font-bold tracking-widest hover:bg-neon/10">OPP</Link>
                          )}
                        </span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className={`px-4 py-2 text-right ${e.sol > 0 ? 'text-profit' : e.sol < 0 ? 'text-loss' : 'text-dim'}`}>
                      {e.sol !== 0 ? e.sol.toFixed(3) : '—'}
                    </td>
                    <td className={`px-4 py-2 text-right ${e.usd > 0 ? 'text-profit' : e.usd < 0 ? 'text-loss' : 'text-dim'}`}>
                      {e.usd !== 0 ? `$${Math.abs(e.usd).toLocaleString('en-US')}` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <a
                        href={`https://solscan.io/tx/${e.signature}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={e.signature}
                        className="text-dim hover:text-neon text-xs"
                      >
                        {e.signature.slice(0, 4)}…{e.signature.slice(-4)} ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
