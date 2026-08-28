import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import type { OpportunityConfig } from '@million/shared';
import { useLiveStatus, useOpportunities, useOpportunityConfig, useSetOpportunityConfig, useSetSubscribed, useWallets } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { STATUS_STYLE } from '../components/TokenReportView';
import { fmtAgo, truncAddr } from '../lib/format';

function SubbedWalletsButton({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const { data: wallets = [] } = useWallets();
  const setSubscribed = useSetSubscribed();
  const subbed = wallets.filter((w) => w.subscribed);

  return (
    <>
      <button type="button" className="text-dim mt-1 hover:text-neon cursor-pointer underline decoration-dotted" onClick={() => setOpen(true)}>
        {count} wallets subbed
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
            <div
              className="panel panel-raised w-[30rem] max-w-full max-h-[75vh] p-5 flex flex-col gap-3"
              role="dialog"
              aria-label="Subscribed wallets"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="eyebrow">Subscribed wallets · {subbed.length}/25</span>
                <button type="button" className="text-dim hover:text-ink text-sm" onClick={() => setOpen(false)}>✕</button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {subbed.length === 0 ? (
                  <p className="text-sm text-dim py-6 text-center">No wallets subbed — Sub them from their detail page.</p>
                ) : (
                  <ul>
                    {subbed.map((w) => (
                      <li key={w.address} className="border-t border-line py-2 flex items-center gap-3 text-sm font-mono">
                        <Link to="/wallets/$address" params={{ address: w.address }} className="text-dim hover:text-neon inline-flex" onClick={() => setOpen(false)}>
                          <EyeIcon />
                        </Link>
                        <span className="text-ink flex-1 truncate">{w.label ?? truncAddr(w.address)}</span>
                        <span className="text-dim text-xs">{w.metrics?.winRate !== null && w.metrics ? `WR ${Math.round((w.metrics.winRate ?? 0) * 100)}%` : ''}</span>
                        <button
                          className="text-xs text-dim hover:text-loss"
                          title="Unsubscribe"
                          disabled={setSubscribed.isPending}
                          onClick={() => setSubscribed.mutate({ address: w.address, subscribed: false })}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Opportunities() {
  const { data: status } = useLiveStatus();
  const { data: opportunities = [] } = useOpportunities();
  const { data: savedConfig } = useOpportunityConfig();
  const save = useSetOpportunityConfig();
  const [config, setConfig] = useState<OpportunityConfig | null>(null);

  useEffect(() => {
    if (savedConfig && !config) setConfig(savedConfig);
  }, [savedConfig, config]);

  const dirty = config && savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig);

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Opportunities</h1>
          <p className="text-sm text-dim mt-1">
            A subbed wallet enters a pair that's new for it, sized, and the token survives the gauntlet.
            Few signals, real-time — old open positions are noise; new entries are the news.
          </p>
        </div>
        <div className="text-right shrink-0 text-xs font-mono">
          <div className={`font-bold ${status?.connected ? 'text-profit' : 'text-loss'}`}>
            {status?.connected ? '● FEED CONNECTED' : '○ FEED DOWN'}
          </div>
          <SubbedWalletsButton count={status?.subscribedWallets ?? 0} />
        </div>
      </div>

      <div className="panel">
        <div className="px-4 pt-4 pb-2 eyebrow">Signals · newest first</div>
        {opportunities.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">
            None yet. Sub quality wallets (wallet detail → Sub) and signals appear the moment one enters something new
            that clears the checks.
          </p>
        ) : (
          <ul>
            {opportunities.map((o) => (
              <li key={o.id} className="border-t border-line px-4 py-3 flex items-baseline gap-4 flex-wrap">
                <span className={`font-mono text-xs font-bold ${STATUS_STYLE[o.verdict].text}`}>{STATUS_STYLE[o.verdict].label}</span>
                <span className="inline-flex items-center gap-2">
                  <Link to="/tokens/$mint" params={{ mint: o.mint }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
                  {o.symbol && <TokenName mint={o.mint} symbol={o.symbol} />}
                  <Addr address={o.mint} kind="token" />
                </span>
                <span className="text-xs text-dim">
                  entered by{' '}
                  <Link to="/wallets/$address" params={{ address: o.wallet }} className="text-neon hover:underline">
                    {o.walletLabel ?? truncAddr(o.wallet)}
                  </Link>{' '}
                  · {o.buySol} ◎ · <span title={o.ts}>{fmtAgo(o.ts)}</span>
                </span>
                <Link to="/discover" search={{ mint: o.mint }} className="text-xs text-neon hover:underline ml-auto">find whales →</Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {config && (
        <div className="panel p-4 flex flex-col gap-4">
          <span className="eyebrow">Definition of an opportunity</span>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>Min buy size (SOL)<span className="block text-xs text-dim">the subbed wallet's entry must be at least this</span></span>
              <input type="number" min={0} step={0.5} value={config.minBuySol} onChange={(e) => setConfig({ ...config, minBuySol: Number(e.target.value) })} className="w-28 text-right" />
            </label>
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input type="checkbox" className="checkbox" style={{ accentColor: 'var(--color-neon)' }} checked={config.allowWarn} onChange={(e) => setConfig({ ...config, allowWarn: e.target.checked })} />
              WARN verdicts count too (PASS-only if off)
            </label>
          </div>

          <div className="border-t border-line pt-4">
            <span className="eyebrow">Auto-trade · <span className="text-pulse normal-case tracking-normal">staged — paper engine first</span></span>
            <div className="grid sm:grid-cols-3 gap-x-8 gap-y-3 mt-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Position (SOL)</span>
                <input type="number" min={0} step={0.1} value={config.positionSol} onChange={(e) => setConfig({ ...config, positionSol: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Take profit %</span>
                <input type="number" min={1} step={10} value={config.takeProfitPct} onChange={(e) => setConfig({ ...config, takeProfitPct: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Stop loss %</span>
                <input type="number" min={1} max={100} step={5} value={config.stopLossPct} onChange={(e) => setConfig({ ...config, stopLossPct: Number(e.target.value) })} className="w-24 text-right" />
              </label>
            </div>
            <label className="flex items-center gap-3 text-sm mt-3 opacity-60 cursor-not-allowed" title="Locked until the paper-trade engine proves positive expectancy — see docs/closed-loop.md">
              <input type="checkbox" disabled checked={false} className="checkbox" />
              auto-trade new opportunities <span className="text-pulse text-xs font-bold tracking-widest ml-1">LOCKED</span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button className="btn" disabled={save.isPending || !dirty} onClick={() => save.mutate(config)}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {dirty && !save.isPending && <span className="text-xs text-warn">unsaved changes</span>}
            {save.error && <span className="text-xs text-loss">{save.error.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
