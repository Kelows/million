import { Link, Outlet } from '@tanstack/react-router';
import { useEventStream, useHealth, useLiveStatus, useWallets } from '../api';

const NAV = [
  {
    section: 'Intel',
    links: [
      { to: '/', label: 'Overview' },
      { to: '/wallets', label: 'Wallets' },
      { to: '/tokens', label: 'Tokens' },
      { to: '/opportunities', label: 'Opportunities' },
      { to: '/copyability', label: 'Copyability' },
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
      { to: '/executor', label: 'Trading' },
      { to: '/screener', label: 'Screener' },
    ],
  },
];

export function Shell() {
  useEventStream(); // push, not poll
  const health = useHealth();
  const live = useLiveStatus();
  const wallets = useWallets();
  const uplink = health.data?.ok ?? false;
  const heliusOk = health.data?.heliusConfigured ?? false;

  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 border-r border-line px-5 py-6 flex flex-col gap-8">
        <div>
          <div className="font-bold text-2xl tracking-widest text-bright">
            MILLI<span className="text-neon">O</span>N
          </div>
          <div className="eyebrow mt-1">whale deck · v0.1</div>
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
        <div className="mt-auto eyebrow">no live trading wired</div>
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
          <span className="ml-auto text-pulse font-bold tracking-widest">PAPER MODE</span>
        </header>
        {live.data && !live.data.connected && live.data.subscribedWallets > 0 && (
          <div className="px-6 py-2 text-xs font-mono bg-loss/10 border-b border-loss text-loss">
            ⚠ LIVE FEED DOWN — {live.data.ingestion === 'webhook' ? 'webhook not synced (is the ngrok pane running?)' : 'websocket disconnected'} · opportunities and mirrors are blind
          </div>
        )}
        {live.data && live.data.connected && live.data.ingestion === 'websocket' && live.data.subscribedWallets > live.data.maxSubscriptions && (
          <div className="px-6 py-2 text-xs font-mono bg-warn/10 border-b border-warn text-warn">
            ⚠ WEBSOCKET FALLBACK — only {live.data.activeSubscriptions}/{live.data.subscribedWallets} subscribed wallets are streaming (cap {live.data.maxSubscriptions}). Restore the webhook (ngrok) for full coverage.
          </div>
        )}
        <main className="p-6 flex-1 min-w-0">
          <div className="w-full max-w-[1600px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
