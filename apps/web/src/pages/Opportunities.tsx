import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import type { OpportunityConfig } from '@million/shared';
import { useLiveStatus, useOpportunities, useOpportunityConfig, useSetOpportunityConfig, useSetSubscribed, useWallets } from '../api';
import { TokenName } from '../components/TokenName';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { STATUS_STYLE } from '../components/TokenReportView';
import { Info } from '../components/Info';
import { fmtAgo, truncAddr } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { Pagination } from '../components/Pagination';

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
                  {o.mint && <Link to="/discover" search={{ mint: o.mint }} className="text-xs text-neon hover:underline ml-auto">find whales →</Link>}
                </li>
              ))}
          </ul>
        )}
        <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
      </div>

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
            <span className="eyebrow">Trading rules · <span className="text-profit normal-case tracking-normal">paper engine live</span> · <span className="text-pulse normal-case tracking-normal">auto-trade locked</span></span>
            <label className="flex items-center gap-3 text-sm mt-3 cursor-pointer">
              <input type="checkbox" className="checkbox" checked={config.paperEnabled} onChange={(e) => setConfig({ ...config, paperEnabled: e.target.checked })} />
              paper-trade every opportunity
            </label>
            <label className="flex items-center gap-3 text-sm cursor-pointer">
              <input type="checkbox" className="checkbox" checked={config.ignoreSniperTriggers} onChange={(e) => setConfig({ ...config, ignoreSniperTriggers: e.target.checked })} />
              ignore sniper triggers (machine-speed entries are adverse selection at our latency)
            </label>
            <label className="flex items-center justify-between gap-4 text-sm max-w-sm">
              <span>Max total exposure (◎)<span className="block text-xs text-dim">portfolio cap across all open positions</span></span>
              <input type="number" min={0} step={0.5} value={config.maxTotalExposureSol} onChange={(e) => setConfig({ ...config, maxTotalExposureSol: Number(e.target.value) })} className="w-24 text-right" />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="text-dim">Min trigger copyability %<Info text="Skip signals from wallets whose measured edge retention is below this. Unmeasured wallets pass — run Copyability on the subscribed set to grow coverage." /></span>
              <input type="number" min={0} max={100} step={5} value={config.minEdgeRetentionPct} onChange={(e) => setConfig({ ...config, minEdgeRetentionPct: Number(e.target.value) })} className="w-24 text-right" />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="text-dim">Trailing stop % (winners)<Info text="mirror-trail mode: a whale exit cuts losers instantly but arms a trailing stop on winners. The leash is volatility-scaled per token (3× its recent 1-min swings, clamped 8–30%) — this value is the cold-start fallback until ~8 minutes of price history accumulates. Breakeven ratchet on top: once a winner reaches +25%, the stop never drops below entry+2%." /></span>
              <input type="number" min={1} max={50} step={1} value={config.trailStopPct} onChange={(e) => setConfig({ ...config, trailStopPct: Number(e.target.value) })} className="w-24 text-right" />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-dim">Halt after consecutive losses</span>
              <input type="number" min={1} max={50} step={1} value={config.maxConsecutiveLosses} onChange={(e) => setConfig({ ...config, maxConsecutiveLosses: Number(e.target.value) })} className="w-24 text-right" />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-dim">Weekly loss halt (% of bankroll)</span>
              <input type="number" min={1} max={100} step={1} value={config.weeklyLossLimitPct} onChange={(e) => setConfig({ ...config, weeklyLossLimitPct: Number(e.target.value) })} className="w-24 text-right" />
            </label>
            <div className="flex items-center gap-2 mt-3 text-sm">
              <span className="text-dim text-xs uppercase tracking-wider mr-1">exit strategy</span>
              {(['rules', 'mirror', 'mirror-trail'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setConfig({ ...config, exitMode: mode })}
                  title={mode === 'mirror'
                    ? 'Sell when the wallet that triggered the position sells the token. Stop loss and max hold stay active as disaster brakes; take profit is disabled — the whale is the take profit.'
                    : 'Exit purely by your own TP / SL / timeout rules.'}
                  className={`px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest border cursor-pointer ${
                    config.exitMode === mode ? 'border-neon text-neon' : 'border-line text-dim hover:text-ink'
                  }`}
                >
                  {mode === 'rules' ? 'our rules' : mode === 'mirror' ? 'mirror (pure copy)' : 'mirror + trail winners'}
                </button>
              ))}
            </div>
            <div className="grid sm:grid-cols-3 gap-x-8 gap-y-3 mt-3">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>{config.sizingMode === 'whale-pct' ? 'Max position (SOL)' : 'Position (SOL)'}</span>
                <input type="number" min={0} step={0.1} value={config.positionSol} onChange={(e) => setConfig({ ...config, positionSol: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <div className="flex items-center gap-2 text-sm">
                {(['fixed', 'whale-pct', 'whale-frac'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setConfig({ ...config, sizingMode: mode })}
                    title={mode === 'whale-frac' ? 'Normalized conviction: their buy as a share of THEIR bankroll (balance at entry, capped 25%), applied to your bankroll below' : mode === 'whale-pct' ? 'Raw % of the whale\u2019s own buy — unnormalized' : 'Every position the same size'}
                    className={`px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest border cursor-pointer ${
                      config.sizingMode === mode ? 'border-neon text-neon' : 'border-line text-dim hover:text-ink'
                    }`}
                  >
                    {mode === 'fixed' ? 'fixed size' : mode === 'whale-pct' ? '% of whale' : 'normalized'}
                  </button>
                ))}
                {config.sizingMode === 'whale-pct' && (
                  <label className="flex items-center gap-1 text-xs text-dim">
                    <input type="number" min={0.1} max={100} step={1} value={config.copyPct} onChange={(e) => setConfig({ ...config, copyPct: Number(e.target.value) })} className="w-16 text-right" />
                    % of their entry
                  </label>
                )}
              </div>
              {config.sizingMode === 'whale-frac' && (
                <label className="flex items-center justify-between gap-4 text-sm mt-3">
                  <span className="text-dim">Our bankroll <span className="text-xs">— ◎ × their fraction (cap 25%)</span></span>
                  <input type="number" min={0} step={1} value={config.bankrollSol} onChange={(e) => setConfig({ ...config, bankrollSol: Number(e.target.value) })} className="w-24 text-right" />
                </label>
              )}
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Take profit %</span>
                <input type="number" min={1} step={10} value={config.takeProfitPct} onChange={(e) => setConfig({ ...config, takeProfitPct: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Stop loss %</span>
                <input type="number" min={1} max={100} step={5} value={config.stopLossPct} onChange={(e) => setConfig({ ...config, stopLossPct: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Slippage % / side</span>
                <input type="number" min={0} max={50} step={0.5} value={config.slippagePct} onChange={(e) => setConfig({ ...config, slippagePct: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Max hold (hours)</span>
                <input type="number" min={1} max={720} step={6} value={config.maxHoldHours} onChange={(e) => setConfig({ ...config, maxHoldHours: Number(e.target.value) })} className="w-24 text-right" />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Max open positions</span>
                <input type="number" min={1} max={50} step={1} value={config.maxOpenPositions} onChange={(e) => setConfig({ ...config, maxOpenPositions: Number(e.target.value) })} className="w-24 text-right" />
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
