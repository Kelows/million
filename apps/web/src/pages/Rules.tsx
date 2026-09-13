import { useEffect, useState } from 'react';
import { STRATEGY_PRESETS, type OpportunityConfig } from '@million/shared';
import { useCrawler, useOpportunityConfig, useSetCrawlerConfig, useSetOpportunityConfig, useTrading } from '../api';
import { Choice, Num, RuleField, RuleSection, Toggle } from '../components/RuleField';
import { ThresholdFields } from '../components/ThresholdFields';

/**
 * Every trading rule in one place, ordered the way a signal actually travels:
 * what fires it, what blocks it, how big, when we get out, what stops everything.
 */
export function Rules() {
  const { data: saved } = useOpportunityConfig();
  const save = useSetOpportunityConfig();
  const { data: crawler } = useCrawler();
  const saveCrawler = useSetCrawlerConfig();
  const { data: trading } = useTrading();
  const live = trading?.stats.mode === 'live';
  const [c, setC] = useState<OpportunityConfig | null>(null);

  useEffect(() => {
    if (saved && !c) setC(saved);
  }, [saved, c]);
  if (!c) return <p className="text-dim text-sm">Loading…</p>;

  const dirty = saved && JSON.stringify(c) !== JSON.stringify(saved);
  const set = (patch: Partial<OpportunityConfig>) => setC({ ...c, ...patch });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Trading rules</h1>
          <p className="text-sm text-dim mt-1">
            Ordered the way a signal travels: what fires it, what blocks it, how much we commit, when we leave, and what
            halts everything. Changes apply to new signals only — open positions keep the rules they were opened under.
          </p>
        </div>
        <span className="flex items-center gap-3">
          {dirty && <span className="text-xs text-warn font-mono">unsaved</span>}
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate(c)}>
            {save.isPending ? 'Saving…' : 'Save rules'}
          </button>
        </span>
      </div>

      <div className="panel p-4">
        <div className="eyebrow">
          Presets{c.strategyPreset && <span className="normal-case tracking-normal text-neon"> · based on {c.strategyPreset}</span>}
        </div>
        <p className="text-xs text-dim mt-1 mb-3">A coherent starting point, not a lock — every knob below stays editable after applying.</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {STRATEGY_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`btn py-2! px-3! text-left h-full ${c.strategyPreset === p.name ? '' : 'opacity-60'}`}
              onClick={() => {
                if (!window.confirm(`Apply "${p.name}"?\n\n${p.tagline}\n\nOverwrites the settings it defines and the gauntlet thresholds. Consider resetting the book — rule changes mid-experiment fork the data.`)) return;
                setC({ ...c, ...p.opportunity, strategyPreset: p.name });
                if (crawler?.config) saveCrawler.mutate({ ...crawler.config, thresholds: { ...crawler.config.thresholds, ...p.thresholds } });
              }}
            >
              <span className="font-bold block">{p.name}</span>
              <span className="text-[0.7rem] leading-snug normal-case tracking-normal text-dim block mt-1">{p.tagline}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <RuleSection title="1 · Signals" subtitle="What turns a whale's buy into a trade of ours.">
          <RuleField label="Signal kinds that trade" hint="Which signals open positions; the feed shows all of them either way. copy = one wallet's buy · consensus = several owners · ladder = repeated buys.">
            <Choice value={c.tradeSignals} options={['all', 'copy', 'consensus', 'ladder'] as const} onChange={(v) => set({ tradeSignals: v })} />
          </RuleField>
          <RuleField label="Min buy size (copy only)" hint="A single buy must be at least this big. Copy signals only: consensus and ladder use their own totals.">
            <Num value={c.minBuySol} onChange={(v) => set({ minBuySol: v })} min={0} step={0.5} suffix="◎" />
          </RuleField>
          <RuleField
            label="Min pool liquidity to trade"
            hint="Skip tokens whose pool is smaller than this. In thin pools the whale's own buy moves the price, so the fill isn't real. −1 = off."
            off={c.minTradeLiquidityUsd < 0}
          >
            <Num value={c.minTradeLiquidityUsd} onChange={(v) => set({ minTradeLiquidityUsd: v })} min={-1} step={25000} suffix="$" width="w-28" />
          </RuleField>
          <RuleField label="Consensus owners" hint="How many different owners must buy the same token within 15 minutes. Linked wallets count once. 0 = off." off={c.consensusOwners === 0}>
            <Num value={c.consensusOwners} onChange={(v) => set({ consensusOwners: v })} min={0} max={10} />
          </RuleField>
          <RuleField label="Consensus needs net inflow" hint="Require more SOL bought than sold, not just more buyers than sellers.">
            <Toggle value={c.consensusNetFlow} onChange={(v) => set({ consensusNetFlow: v })} />
          </RuleField>
          <RuleField label="Ladder: buys / window / total" hint="One wallet buying the same token this many times in the window, adding up to at least this much, with no sell. 0 buys = off." off={c.ladderBuys === 0}>
            <Num value={c.ladderBuys} onChange={(v) => set({ ladderBuys: v })} min={0} max={50} width="w-12" />
            <Num value={c.ladderWindowMinutes} onChange={(v) => set({ ladderWindowMinutes: v })} min={1} max={120} width="w-12" suffix="m" />
            <Num value={c.ladderMinSol} onChange={(v) => set({ ladderMinSol: v })} min={0} step={0.5} width="w-14" suffix="◎" />
          </RuleField>
          <RuleField label="Follow rotations" hint="When a subscribed wallet funds a fresh address, add it to the roster, unsubscribed, so you can analyze it first.">
            <Toggle value={c.followRotations} onChange={(v) => set({ followRotations: v })} />
          </RuleField>
        </RuleSection>

        <RuleSection title="2 · Filters" subtitle="What refuses a signal that would otherwise trade.">
          <RuleField label="Allow WARN verdicts" hint="Also trade tokens whose checks came back WARN, not only PASS.">
            <Toggle value={c.allowWarn} onChange={(v) => set({ allowWarn: v })} />
          </RuleField>
          <RuleField label="Skip pools older than" hint="Skip tokens whose pool is older than this. −1 = no limit." off={c.maxPairAgeMinutes < 0}>
            <Num value={c.maxPairAgeMinutes} onChange={(v) => set({ maxPairAgeMinutes: v })} min={-1} step={5} suffix="min" />
          </RuleField>
          <RuleField label="Ignore sniper triggers" hint="Skip signals from wallets flagged as snipers: you fill seconds after them, which is too late for their style.">
            <Toggle value={c.ignoreSniperTriggers} onChange={(v) => set({ ignoreSniperTriggers: v })} />
          </RuleField>
          <RuleField label="Min trigger copyability" hint="Skip wallets whose copied trades keep less than this share of their edge. Wallets not measured yet pass." off={c.minEdgeRetentionPct === 0}>
            <Num value={c.minEdgeRetentionPct} onChange={(v) => set({ minEdgeRetentionPct: v })} min={0} max={100} step={5} suffix="%" />
          </RuleField>
          <RuleField label="Min trigger median hold" hint="Skip wallets whose median hold is shorter than this: very fast traders can't be copied in time. 0 = off." off={c.minMedianHoldMinutes === 0}>
            <Num value={c.minMedianHoldMinutes} onChange={(v) => set({ minMedianHoldMinutes: v })} min={0} max={1440} step={5} suffix="min" />
          </RuleField>
          <RuleField label="Cycler guard" hint="Skip a buy if that wallet sold the same token within this many minutes: it's flipping, not entering. 0 = off." off={c.cyclerGuardMinutes === 0}>
            <Num value={c.cyclerGuardMinutes} onChange={(v) => set({ cyclerGuardMinutes: v })} min={0} max={120} suffix="min" />
          </RuleField>
        </RuleSection>

        <RuleSection title="3 · Sizing" subtitle="How much goes into a position, and the ceiling across all of them.">
          <RuleField label="Sizing mode" hint="fixed = same size every time · % of whale = a share of their buy · normalized = the share of their wallet they bet, applied to your bankroll (max 25%).">
            <Choice value={c.sizingMode} options={['fixed', 'whale-pct', 'whale-frac'] as const} onChange={(v) => set({ sizingMode: v })} labels={{ 'whale-pct': '% of whale', 'whale-frac': 'normalized' }} />
          </RuleField>
          <RuleField label="Max per position" hint="Largest single position, whatever the sizing mode says.">
            <Num value={c.positionSol} onChange={(v) => set({ positionSol: v })} min={0} step={0.1} suffix="◎" />
          </RuleField>
          <RuleField
            label={live ? 'Bankroll (trading wallet)' : 'Our bankroll'}
            hint={live
              ? "Live: your trading wallet's SOL balance is the bankroll, for normalized sizing and the weekly loss halt."
              : 'Paper bankroll, for normalized sizing and the weekly loss halt. In live mode the trading wallet balance is used instead.'}
            off={c.sizingMode !== 'whale-frac'}
          >
            {live ? (
              <span className="font-mono text-sm text-bright">{trading?.stats.walletBalanceSol != null ? `${trading.stats.walletBalanceSol.toFixed(3)} ◎` : 'balance unavailable'}</span>
            ) : (
              <Num value={c.bankrollSol} onChange={(v) => set({ bankrollSol: v })} min={0} suffix="◎" />
            )}
          </RuleField>
          <RuleField label="% of whale's entry" hint="Share of the whale's buy for % of whale sizing, capped by max per position." off={c.sizingMode !== 'whale-pct'}>
            <Num value={c.copyPct} onChange={(v) => set({ copyPct: v })} min={0.1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Total exposure cap" hint="Most SOL in open positions at once. First come, first served: early signals can use it up.">
            <Num value={c.maxTotalExposureSol} onChange={(v) => set({ maxTotalExposureSol: v })} min={0} step={0.5} suffix="◎" />
          </RuleField>
          <RuleField label="Max open positions" hint="Most positions open at once.">
            <Num value={c.maxOpenPositions} onChange={(v) => set({ maxOpenPositions: v })} min={1} max={50} />
          </RuleField>
          <RuleField label="Assumed slippage" hint="Fallback trading cost per side, used only when a live Jupiter quote isn't available.">
            <Num value={c.slippagePct} onChange={(v) => set({ slippagePct: v })} min={0} max={50} step={0.5} suffix="%" />
          </RuleField>
        </RuleSection>

        <RuleSection title="4 · Exits" subtitle="When and how positions close.">
          <RuleField label="Exit strategy" hint="trail = price only: a trailing stop and the hard stop · our rules = take profit and stop loss · mirror = sell when the whale sells · mirror+trail = the whale's sell cuts losers, a trail rides winners · consensus+trail = sell when several owners sell, or the trail fires.">
            <Choice value={c.exitMode} options={['trail', 'rules', 'mirror', 'mirror-trail', 'consensus-trail'] as const} onChange={(v) => set({ exitMode: v })} labels={{ rules: 'our rules', 'mirror-trail': 'mirror+trail', 'consensus-trail': 'consensus+trail' }} />
          </RuleField>
          <RuleField
            label="Owners selling that closes a position"
            off={c.exitMode !== 'consensus-trail'}
            hint="Consensus+trail only: sell when this many different owners sell the token within the window."
          >
            <Num value={c.consensusExitOwners} onChange={(v) => set({ consensusExitOwners: v })} min={1} max={10} step={1} />
          </RuleField>
          <RuleField off={c.exitMode !== 'consensus-trail'} label="Distribution window" hint="How far back owner sells are counted for that exit.">
            <Num value={c.consensusExitWindowMinutes} onChange={(v) => set({ consensusExitWindowMinutes: v })} min={1} max={240} step={5} suffix="min" />
          </RuleField>
          <RuleField label="Trail arms at" hint="How far up a position must go before the trailing stop starts following it." off={c.exitMode === 'rules'}>
            <Num value={c.trailArmPct} onChange={(v) => set({ trailArmPct: v })} min={0} max={100} step={5} suffix="%" />
          </RuleField>
          <RuleField label="Trailing stop" hint="Minimum distance the trail keeps below the peak. Jumpy tokens get a wider trail automatically, up to 35%." off={c.exitMode === 'rules'}>
            <Num value={c.trailStopPct} onChange={(v) => set({ trailStopPct: v })} min={1} max={50} suffix="%" />
          </RuleField>
          <RuleField label="Take profit" hint="Used by the our-rules exit mode only." off={c.exitMode !== 'rules'}>
            <Num value={c.takeProfitPct} onChange={(v) => set({ takeProfitPct: v })} min={1} step={10} suffix="%" />
          </RuleField>
          <RuleField label="Stop loss" hint="Always on, in every exit mode: sells if a position falls this far.">
            <Num value={c.stopLossPct} onChange={(v) => set({ stopLossPct: v })} min={1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Max hold" hint="Sell anyway after this long. Short limits cut off trades that need days to play out.">
            <Num value={c.maxHoldHours} onChange={(v) => set({ maxHoldHours: v })} min={1} max={720} suffix="h" />
            <span className="text-[0.65rem] text-dim">= {Math.round((c.maxHoldHours / 24) * 10) / 10}d</span>
          </RuleField>
        </RuleSection>

        <RuleSection title="5 · Safety" subtitle="Book-level brakes. Paper or live is set by EXECUTOR in the API's .env, not here.">
          <RuleField label="Halt after consecutive losses" hint="Stop opening positions after this many losses in a row. Resume from the Trading page.">
            <Num value={c.maxConsecutiveLosses} onChange={(v) => set({ maxConsecutiveLosses: v })} min={1} max={50} />
          </RuleField>
          <RuleField label="Weekly loss halt" hint={live ? "Stop opening positions when the last 7 days lost this share of your trading wallet's balance." : 'Stop opening positions when the last 7 days lost this share of your bankroll.'}>
            <Num value={c.weeklyLossLimitPct} onChange={(v) => set({ weeklyLossLimitPct: v })} min={1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Min funding to follow" hint="A funding transfer must be at least this big to count as a new address.">
            <Num value={c.minFundSol} onChange={(v) => set({ minFundSol: v })} min={0} step={0.5} suffix="◎" />
          </RuleField>
        </RuleSection>

        <div className="panel p-4 flex flex-col">
          <div className="eyebrow">6 · Failsafes</div>
          <p className="text-xs text-dim mt-1 mb-3">
            The gauntlet every token must clear before any signal can trade it. One stored set — the crawler, manual
            checks and opportunities all read it, so editing here changes all three.
          </p>
          {crawler?.config ? (
            <ThresholdFields value={crawler.config.thresholds} onChange={(t) => saveCrawler.mutate({ ...crawler.config, thresholds: t })} />
          ) : (
            <p className="text-sm text-dim">Loading…</p>
          )}
          {saveCrawler.isSuccess && <span className="text-xs text-profit mt-2">saved</span>}
        </div>
      </div>
    </div>
  );
}
