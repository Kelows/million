import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { STRATEGY_PRESETS } from '@million/shared';
import type { OpportunityConfig } from '@million/shared';
import { useCrawler, useLiveStatus, useOpportunities, useOpportunityConfig, useSetCrawlerConfig, useSetOpportunityConfig, useSetSubscribed, useSubscribeAll, useUnsubscribeAll, useWallets } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { STATUS_STYLE } from '../components/TokenReportView';
import { Info } from '../components/Info';
import { fmtAgo, truncAddr } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { Pagination } from '../components/Pagination';
import { DecisionLog } from '../components/DecisionLog';

function SubbedWalletsButton({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const { data: wallets = [] } = useWallets();
  const setSubscribed = useSetSubscribed();
  const unsubAll = useUnsubscribeAll();
  const subAll = useSubscribeAll();
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
                <span className="flex items-center gap-3">
                  {subbed.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-dim hover:text-loss"
                      disabled={unsubAll.isPending}
                      onClick={() => {
                        if (window.confirm(`Unsubscribe all ${subbed.length} wallets? The live feed goes silent until you sub again.`)) unsubAll.mutate();
                      }}
                    >
                      unsub all
                    </button>
                  )}
                  <button type="button" className="text-dim hover:text-ink text-sm" onClick={() => setOpen(false)}>✕</button>
                </span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {subbed.length === 0 ? (
                  <div className="py-6 text-center flex flex-col items-center gap-3">
                    <p className="text-sm text-dim">No wallets subbed — sub them from their detail page, or all at once:</p>
                    <button className="btn" disabled={subAll.isPending} onClick={() => subAll.mutate()}>
                      {subAll.isPending ? 'Subbing…' : 'Sub all analyzed wallets'}
                    </button>
                    <p className="text-xs text-dim">every analyzed, non-purged, non-infra wallet joins the feed</p>
                  </div>
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
  const tokenSignals = opportunities.filter((o) => o.kind !== 'wallet');
  const pag = usePagination(tokenSignals, 10);
  const rotations = opportunities.filter((o) => o.kind === 'wallet').slice(0, 5);
  const { data: savedConfig } = useOpportunityConfig();
  const save = useSetOpportunityConfig();
  const [config, setConfig] = useState<OpportunityConfig | null>(null);

  useEffect(() => {
    if (savedConfig && !config) setConfig(savedConfig);
  }, [savedConfig, config]);

  const dirty = config && savedConfig && JSON.stringify(config) !== JSON.stringify(savedConfig);

  return (
    <div className="flex flex-col gap-6">
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
        {tokenSignals.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">
            None yet. Sub quality wallets (wallet detail → Sub) and signals appear the moment one enters something new
            that clears the checks.
          </p>
        ) : (
          <ul>
            {pag.rows.map((o) => (
                <li key={o.id} className="border-t border-line px-4 py-3 flex items-baseline gap-4 flex-wrap">
                  <span className={`font-mono text-xs font-bold ${STATUS_STYLE[o.verdict].text}`}>{STATUS_STYLE[o.verdict].label}</span>
                  {o.signal === 'ladder' && (
                    <span className="text-neon border border-neon/50 px-1 text-[0.6rem] font-mono font-bold tracking-widest" title="a wallet accumulating this mint in repeated clips right now">LADDER</span>
                  )}
                  {o.signal === 'consensus' && (
                    <span className="text-warn border border-warn/50 px-1 text-[0.6rem] font-mono font-bold tracking-widest" title="fired by owner breadth, not a single wallet's entry">CONSENSUS</span>
                  )}
                  <span className="inline-flex items-center gap-2">
                    <Link to="/tokens/$mint" params={{ mint: o.mint! }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
                    {o.symbol && o.mint && <TokenName mint={o.mint} symbol={o.symbol} />}
                    {o.mint && <Addr address={o.mint} kind="token" />}
                  </span>
                  <span className="text-xs text-dim">
                    entered by{' '}
                    <Link to="/wallets/$address" params={{ address: o.wallet }} className="text-neon hover:underline">
                      {o.walletLabel ?? truncAddr(o.wallet)}
                    </Link>{' '}
                    · {o.buySol} ◎ · <span title={o.ts}>{fmtAgo(o.ts)}</span>
                  </span>
                  {o.fillGapPct !== null && o.fillGapPct !== undefined && (
                    <span
                      className={`text-xs font-mono ${Math.abs(o.fillGapPct) > 30 ? 'text-loss' : 'text-dim'}`}
                      title="Our price vs the whale's fill when the signal fired. A big gap means a real price spike, or a lagging price feed."
                    >
                      fill {o.fillGapPct > 0 ? '+' : ''}{o.fillGapPct}%
                    </span>
                  )}
                  {o.mint && <Link to="/discover" search={{ mint: o.mint }} className="text-xs text-neon hover:underline ml-auto">find whales →</Link>}
                </li>
              ))}
          </ul>
        )}
        <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
      </div>

      <DecisionLog />

      <div className="panel">
        <div className="px-4 pt-4 pb-2 eyebrow">Rotations · last 5 · owners spawning fresh wallets</div>
        {rotations.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">
            No rotations seen yet — when a subbed wallet funds a fresh address, it appears here with the sub inherited.
          </p>
        ) : (
          <ul>
            {rotations.map((o) => (
              <li key={o.id} className="border-t border-line px-4 py-3 flex items-baseline gap-4 flex-wrap">
                <span className="font-mono text-xs font-bold text-neon">ROTATION</span>
                <span className="inline-flex items-center gap-2">
                  <Link to="/wallets/$address" params={{ address: o.wallet }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
                  <span className="text-bright font-semibold">new wallet</span>
                  <Addr address={o.wallet} />
                </span>
                <span className="text-xs text-dim">
                  funded {o.buySol} ◎ by{' '}
                  {o.funder ? (
                    <Link to="/wallets/$address" params={{ address: o.funder }} className="text-neon hover:underline">
                      {o.funderLabel ?? truncAddr(o.funder)}
                    </Link>
                  ) : '?'}{' '}
                  · sub inherited · <span title={o.ts}>{fmtAgo(o.ts)}</span>
                </span>
                <Link to="/funding" search={{ address: o.wallet }} className="text-xs text-neon hover:underline ml-auto">trace →</Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <span className="eyebrow">Rules</span>
          <p className="text-sm text-dim mt-1">
            What turns a signal into a trade — thresholds, sizing, exits and brakes — now lives on its own page.
          </p>
        </div>
        <Link to="/rules" className="btn shrink-0">Trading rules →</Link>
      </div>
    </div>
  );
}

function PresetBar({ config, setConfig }: { config: OpportunityConfig; setConfig: (c: OpportunityConfig) => void }) {
  const { data: crawler } = useCrawler();
  const saveCrawler = useSetCrawlerConfig();
  return (
    <div className="panel p-4 flex flex-col gap-2">
      <span className="eyebrow">Strategy presets — a starting point, then tweak the knobs{config.strategyPreset && <span className="normal-case tracking-normal text-neon"> · based on {config.strategyPreset}</span>}</span>
      <div className="flex flex-wrap gap-3">
        {STRATEGY_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`btn py-1.5! px-3! text-left ${config.strategyPreset === p.name ? '' : 'opacity-60'}`}
            title={p.tagline}
            onClick={() => {
              const changes = Object.entries(p.opportunity).map(([k, v]) => `${k}=${v}`).join(', ');
              const th = Object.entries(p.thresholds).map(([k, v]) => `${k}=${v}`).join(', ');
              if (!window.confirm(`Apply "${p.name}"?\n\n${p.tagline}\n\nSets: ${changes}\nGauntlet: ${th}\n\nYour other knobs stay as they are. Consider resetting the book — settings changes mid-experiment fork the data.`)) return;
              setConfig({ ...config, ...p.opportunity, strategyPreset: p.name });
              if (crawler?.config) saveCrawler.mutate({ ...crawler.config, thresholds: { ...crawler.config.thresholds, ...p.thresholds } });
            }}
          >
            <span className="font-bold block">{p.name}</span>
            <span className="text-xs text-dim block max-w-52">{p.tagline}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
