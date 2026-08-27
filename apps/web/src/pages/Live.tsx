import { Link } from '@tanstack/react-router';
import { useLiveEvents, useLiveStatus } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { fmtAgo, truncAddr } from '../lib/format';

const KIND_STYLE: Record<string, string> = {
  buy: 'text-profit',
  sell: 'text-loss',
  other: 'text-dim',
};

export function Live() {
  const { data: status } = useLiveStatus();
  const { data: events = [] } = useLiveEvents(150);

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
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

      <div className="panel">
        <div className="px-4 pt-4 pb-2 eyebrow">Events · newest first · refreshes every 5s</div>
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
                {events.map((e) => (
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
          </div>
        )}
      </div>
    </div>
  );
}
