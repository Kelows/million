import { Link, Outlet } from '@tanstack/react-router';
import { useEventStream, useHealth, useLiveStatus, useTrading, useWallets } from '../api';
import { TradeToasts } from './TradeToasts';

const NAV = [
  {
    section: 'Intel',
    links: [
      { to: '/', label: 'Overview' },
      { to: '/executor', label: 'Trading' },
      { to: '/rules', label: 'Trading rules' },
      { to: '/wallets', label: 'Wallets' },
      { to: '/tokens', label: 'Tokens' },
      { to: '/opportunities', label: 'Opportunities' },
      { to: '/flows', label: 'Flows' },
      { to: '/live', label: 'Live' },
    ],
  },
  {
    section: 'Scout',
    links: [
      { to: '/discover', label: 'Discover' },
      { to: '/funding', label: 'Funding' },
      { to: '/token-check', label: 'Token check' },
    ],
  },
  {
    section: 'Ops',
    links: [
      { to: '/crawler', label: 'Crawler' },
      { to: '/backtest', label: 'Backtest' },
      { to: '/screener', label: 'Screener' },
    ],
  },
];

export function Shell() {
  useEventStream(); // push, not poll
  const health = useHealth();
  const live = useLiveStatus();
  const wallets = useWallets();
  const trading = useTrading();
  const uplink = health.data?.ok ?? false;
  const heliusOk = health.data?.heliusConfigured ?? false;
  const stats = trading.data?.stats;
  const open = trading.data?.open ?? [];
  const openPnl = open.reduce((sum, p) => sum + (p.unrealizedPct != null ? (p.sizeSol * p.unrealizedPct) / 100 : 0), 0);
  const halted = trading.data?.halt?.halted ?? false;
  const liveMode = stats?.mode === 'live';

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 border-r border-line px-5 py-6 flex flex-col gap-8">
        <div>
          <div className="font-bold text-2xl tracking-widest text-bright">
            MILLI<span className="text-neon">O</span>N
          </div>
          <div className="eyebrow mt-1">whale deck · v1.0</div>
        </div>
        <nav className="flex flex-col gap-6">
          {NAV.map((group) => (
            <div key={group.section}>
              <div className="eyebrow mb-2">{group.section}</div>
              <div className="flex flex-col">
                {group.links.map((link) => (
                  <Link
                    key={link.to}
                    to={link.to}
                    className="px-3 py-1.5 text-sm border-l-2 border-transparent text-dim hover:text-ink"
                    activeOptions={{ exact: link.to === '/' }}
                    activeProps={{ className: 'border-neon! text-bright!' }}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-auto eyebrow">{liveMode ? 'live executor armed' : 'paper trading'}</div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-6 border-b border-line px-6 h-12 text-xs font-mono">
          <span className="flex items-center gap-2">
            <span className={`status-dot ${uplink ? 'bg-profit' : 'bg-loss'}`} />
            <span className="text-dim">API {uplink ? 'ONLINE' : 'OFFLINE'}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`status-dot ${heliusOk ? 'bg-profit' : 'bg-warn'}`} />
            <span className="text-dim">HELIUS {heliusOk ? 'KEYED' : 'NO KEY'}</span>
          </span>
          <span className="text-dim">ROSTER {wallets.data?.length ?? 0}</span>
          <span className="flex items-center gap-2">
            <span className={`status-dot ${live.data?.connected ? 'bg-profit' : 'bg-loss'}`} />
            <span className="text-dim">
              FEED {live.data?.ingestion === 'webhook' ? 'WEBHOOK' : live.data?.ingestion === 'webhook-fallback' ? 'FALLBACK' : 'WS'} · {live.data?.eventsToday ?? 0} ev
            </span>
          </span>

          {/* the live book, everywhere: open PnL marks to market on every push/poll */}
          <span className="ml-auto flex items-center gap-4 [font-variant-numeric:tabular-nums]">
            {stats && stats.openCount > 0 && (
              <span className="flex items-center gap-3">
                <span className="text-dim">OPEN {stats.openCount}</span>
                <span className={`font-bold ${openPnl >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {openPnl >= 0 ? '▲' : '▼'} {openPnl >= 0 ? '+' : ''}{(Math.round(openPnl * 1000) / 1000).toFixed(3)} ◎
                </span>
              </span>
            )}
            {stats && stats.closedCount > 0 && (
              <>
                <span className={stats.totalPnlSol >= 0 ? 'text-profit' : 'text-loss'}>
                  REAL {stats.totalPnlSol > 0 ? '+' : ''}{stats.totalPnlSol} ◎
                </span>
                {stats.expectancySolPerTrade != null && (
                  <span className={`${stats.expectancySolPerTrade >= 0 ? 'text-profit' : 'text-loss'}`} title="expectancy per trade — the number that unlocks live">
                    EXP {stats.expectancySolPerTrade > 0 ? '+' : ''}{stats.expectancySolPerTrade} ◎
                  </span>
                )}
                {stats.winRate != null && <span className="text-dim">WIN {Math.round(stats.winRate * 100)}%</span>}
              </>
            )}
            {halted && <span className="text-loss font-bold tracking-widest animate-pulse">⛔ HALTED</span>}
            <span
              className={`font-bold tracking-widest px-2 py-0.5 border ${liveMode ? 'text-loss border-loss animate-pulse' : 'text-warn border-warn/50'}`}
              title={liveMode ? 'LocalExecutor is signing real transactions' : 'simulated fills — flip EXECUTOR=local + autoTrade to go live'}
            >
              {liveMode ? '◉ LIVE' : 'PAPER'}
            </span>
          </span>
        </header>
        {live.data && !live.data.connected && live.data.subscribedWallets > 0 && (
          <div className="px-6 py-2 text-xs font-mono bg-loss/10 border-b border-loss text-loss">
            ⚠ LIVE FEED DOWN — {live.data.ingestion !== 'websocket' ? 'webhook not synced (is the tunnel pane running?)' : 'websocket disconnected'} · opportunities and mirrors are blind
          </div>
        )}
        {live.data && live.data.ingestion === 'webhook-fallback' && live.data.subscribedWallets > live.data.maxSubscriptions && (
          <div className="px-4 py-2 text-xs font-mono bg-warn/10 text-warn border-b border-warn/40">
            ⚠ WEBHOOK DELIVERIES DEAD (tunnel quota or outage) — websocket fallback carrying only the top {live.data.maxSubscriptions} of {live.data.subscribedWallets} subs
          </div>
        )}
        {live.data && live.data.connected && live.data.ingestion === 'websocket' && live.data.subscribedWallets > live.data.maxSubscriptions && (
          <div className="px-6 py-2 text-xs font-mono bg-warn/10 border-b border-warn text-warn">
            ⚠ WEBSOCKET FALLBACK — only {live.data.activeSubscriptions}/{live.data.subscribedWallets} subscribed wallets are streaming (cap {live.data.maxSubscriptions}). Restore the webhook (tunnel pane) for full coverage.
          </div>
        )}
        <TradeToasts />
        <main className="p-6 flex-1 min-w-0">
          <div className="w-full max-w-[1600px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
