import { useEffect, useState } from 'react';
import { STRATEGY_PRESETS, type OpportunityConfig } from '@million/shared';
import { useCrawler, useOpportunityConfig, useSetCrawlerConfig, useSetOpportunityConfig } from '../api';
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
        <div className="flex flex-wrap gap-3">
          {STRATEGY_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`btn py-1.5! px-3! text-left ${c.strategyPreset === p.name ? '' : 'opacity-60'}`}
              onClick={() => {
                if (!window.confirm(`Apply "${p.name}"?\n\n${p.tagline}\n\nOverwrites the settings it defines and the gauntlet thresholds. Consider resetting the book — rule changes mid-experiment fork the data.`)) return;
                setC({ ...c, ...p.opportunity, strategyPreset: p.name });
                if (crawler?.config) saveCrawler.mutate({ ...crawler.config, thresholds: { ...crawler.config.thresholds, ...p.thresholds } });
              }}
            >
              <span className="font-bold block">{p.name}</span>
              <span className="text-xs text-dim block max-w-52">{p.tagline}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <RuleSection title="1 · Signals" subtitle="What turns a whale's buy into a trade of ours.">
          <RuleField label="Signal kinds that trade" hint="The feed always shows every signal; this only decides which kinds open positions. copy = one whale's entry · consensus = several owners agreeing · ladder = one wallet accumulating in repeated clips.">
            <Choice value={c.tradeSignals} options={['both', 'copy', 'consensus', 'ladder'] as const} onChange={(v) => set({ tradeSignals: v })} />
          </RuleField>
          <RuleField label="Min buy size (copy only)" hint="A single buy must be at least this large to count as conviction. Applies ONLY to the copy path — consensus and ladder judge cumulative totals and run before this gate, so small clips still reach them.">
            <Num value={c.minBuySol} onChange={(v) => set({ minBuySol: v })} min={0} step={0.5} suffix="◎" />
          </RuleField>
          <RuleField label="Consensus owners" hint="Distinct owners (clustered wallets count once) buying the same token in the live window. 0 turns consensus off." off={c.consensusOwners === 0}>
            <Num value={c.consensusOwners} onChange={(v) => set({ consensusOwners: v })} min={0} max={10} />
          </RuleField>
          <RuleField label="Consensus needs net inflow" hint="Buyers must OUTWEIGH sellers, not merely outnumber them. Without this we bought fone while ~77 SOL was being dumped, taking the exit liquidity of the whale we were copying.">
            <Toggle value={c.consensusNetFlow} onChange={(v) => set({ consensusNetFlow: v })} />
          </RuleField>
          <RuleField label="Ladder: clips / window / total" hint="Accumulation in progress: N buys of one mint by one wallet inside the window, above a cumulative floor, with no sell between. Measured ladderers buy every ~15s in ~1.4 ◎ clips. 0 clips = off." off={c.ladderBuys === 0}>
            <Num value={c.ladderBuys} onChange={(v) => set({ ladderBuys: v })} min={0} max={50} width="w-12" />
            <Num value={c.ladderWindowMinutes} onChange={(v) => set({ ladderWindowMinutes: v })} min={1} max={120} width="w-12" suffix="m" />
            <Num value={c.ladderMinSol} onChange={(v) => set({ ladderMinSol: v })} min={0} step={0.5} width="w-14" suffix="◎" />
          </RuleField>
          <RuleField label="Follow rotations" hint="When a subscribed wallet funds a fresh address, absorb it into the roster. It is NOT auto-subscribed — analysis first, feed access only once it proves it trades.">
            <Toggle value={c.followRotations} onChange={(v) => set({ followRotations: v })} />
          </RuleField>
        </RuleSection>

        <RuleSection title="2 · Filters" subtitle="What refuses a signal that would otherwise trade.">
          <RuleField label="Allow WARN verdicts" hint="Trade tokens the gauntlet flags as WARN rather than PASS. Warn entries went 1-for-7 in an early sample; on the launch tier young tokens warn more often, so it is worth re-testing rather than assuming.">
            <Toggle value={c.allowWarn} onChange={(v) => set({ allowWarn: v })} />
          </RuleField>
          <RuleField label="Skip pools older than" hint="A ceiling on pair age — the inverse of the gauntlet's floor. On a launch strategy the run happens in the first minutes, so an old pool means the move already belongs to someone else. -1 = no ceiling." off={c.maxPairAgeMinutes < 0}>
            <Num value={c.maxPairAgeMinutes} onChange={(v) => set({ maxPairAgeMinutes: v })} min={-1} step={5} suffix="min" />
          </RuleField>
          <RuleField label="Ignore sniper triggers" hint="Refuse signals from wallets flagged SNIPER_SPEED — machine-speed entries are adverse selection at human latency.">
            <Toggle value={c.ignoreSniperTriggers} onChange={(v) => set({ ignoreSniperTriggers: v })} />
          </RuleField>
          <RuleField label="Min trigger copyability" hint="Skip wallets whose measured edge retention is below this. Unmeasured wallets pass — run Copyability on the subscribed set to grow coverage." off={c.minEdgeRetentionPct === 0}>
            <Num value={c.minEdgeRetentionPct} onChange={(v) => set({ minEdgeRetentionPct: v })} min={0} max={100} step={5} suffix="%" />
          </RuleField>
          <RuleField label="Min trigger median hold" hint="The wallet's median hold must exceed this. Copy retention is ≤0 when their holds are shorter than our latency horizon — a scalper's edge cannot be copied, only donated to. 0 = off." off={c.minMedianHoldMinutes === 0}>
            <Num value={c.minMedianHoldMinutes} onChange={(v) => set({ minMedianHoldMinutes: v })} min={0} max={1440} step={5} suffix="min" />
          </RuleField>
          <RuleField label="Cycler guard" hint="Skip a trigger that SOLD this same mint within N minutes — mid ping-pong, not entering. 0 = off." off={c.cyclerGuardMinutes === 0}>
            <Num value={c.cyclerGuardMinutes} onChange={(v) => set({ cyclerGuardMinutes: v })} min={0} max={120} suffix="min" />
          </RuleField>
        </RuleSection>

        <RuleSection title="3 · Sizing" subtitle="How much goes into a position, and the ceiling across all of them.">
          <RuleField label="Sizing mode" hint="fixed = every position the same · % of whale = a share of their raw buy · normalized = their buy as a fraction of THEIR bankroll applied to ours, capped at 25%.">
            <Choice value={c.sizingMode} options={['fixed', 'whale-pct', 'whale-frac'] as const} onChange={(v) => set({ sizingMode: v })} labels={{ 'whale-pct': '% of whale', 'whale-frac': 'normalized' }} />
          </RuleField>
          <RuleField label="Max per position" hint="Hard cap on any single entry, whatever the sizing mode computes.">
            <Num value={c.positionSol} onChange={(v) => set({ positionSol: v })} min={0} step={0.1} suffix="◎" />
          </RuleField>
          <RuleField label="Our bankroll" hint="Used by normalized sizing: their buy as a fraction of their balance, applied to this." off={c.sizingMode !== 'whale-frac'}>
            <Num value={c.bankrollSol} onChange={(v) => set({ bankrollSol: v })} min={0} suffix="◎" />
          </RuleField>
          <RuleField label="% of whale's entry" hint="Used by % of whale sizing, clamped by the per-position cap." off={c.sizingMode !== 'whale-pct'}>
            <Num value={c.copyPct} onChange={(v) => set({ copyPct: v })} min={0.1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Total exposure cap" hint="Across all open positions. Ten positions in one meta is one bet wearing ten hats — but note this is first-come-first-served, so early mediocre signals can crowd out later good ones.">
            <Num value={c.maxTotalExposureSol} onChange={(v) => set({ maxTotalExposureSol: v })} min={0} step={0.5} suffix="◎" />
          </RuleField>
          <RuleField label="Max open positions" hint="A count limit alongside the exposure cap.">
            <Num value={c.maxOpenPositions} onChange={(v) => set({ maxOpenPositions: v })} min={1} max={50} />
          </RuleField>
          <RuleField label="Assumed slippage" hint="Charged on both legs in paper mode, and scaled up when a position is large relative to pool depth.">
            <Num value={c.slippagePct} onChange={(v) => set({ slippagePct: v })} min={0} max={50} step={0.5} suffix="%" />
          </RuleField>
        </RuleSection>

        <RuleSection title="4 · Exits" subtitle="Where the roster's edge actually lives — 61% of their profit comes from holds past 24 hours.">
          <RuleField label="Exit strategy" hint="rules = our TP/SL only · mirror = their exit is our exit, a faithful copy · mirror+trail = their exit cuts losers, winners hand over to a trailing stop.">
            <Choice value={c.exitMode} options={['rules', 'mirror', 'mirror-trail'] as const} onChange={(v) => set({ exitMode: v })} labels={{ rules: 'our rules', 'mirror-trail': 'mirror+trail' }} />
          </RuleField>
          <RuleField label="Trailing stop" hint="Fallback width — the live trail is volatility-scaled per token (3× its recent 1-min swings, clamped 8–30%) and this is used until price history accumulates. Peak tracks from entry, so a winner is protected whether or not the whale has moved." off={c.exitMode === 'rules'}>
            <Num value={c.trailStopPct} onChange={(v) => set({ trailStopPct: v })} min={1} max={50} suffix="%" />
          </RuleField>
          <RuleField label="Take profit" hint="Only used in rules mode; the mirror modes let the whale or the trail decide." off={c.exitMode !== 'rules'}>
            <Num value={c.takeProfitPct} onChange={(v) => set({ takeProfitPct: v })} min={1} step={10} suffix="%" />
          </RuleField>
          <RuleField label="Stop loss" hint="Always active as a disaster brake, in every exit mode.">
            <Num value={c.stopLossPct} onChange={(v) => set({ stopLossPct: v })} min={1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Max hold" hint="Timeout exit. Measured across 7,623 closed roster trades: holds past 24h carry 61% of all profit and 3+ days alone carries 39.7%, with win rate rising from 50% (under 5 min) to 62% (past 3 days). A short timeout amputates exactly the band this strategy earns from — hence a 7-day default.">
            <Num value={c.maxHoldHours} onChange={(v) => set({ maxHoldHours: v })} min={1} max={720} suffix="h" />
            <span className="text-[0.65rem] text-dim">= {Math.round((c.maxHoldHours / 24) * 10) / 10}d</span>
          </RuleField>
        </RuleSection>

        <RuleSection title="5 · Safety" subtitle="Book-level brakes, and the two keys that gate real money.">
          <RuleField label="Paper trading enabled" hint="Every qualifying opportunity opens a simulated position. Turning this off stops the experiment collecting data.">
            <Toggle value={c.paperEnabled} onChange={(v) => set({ paperEnabled: v })} />
          </RuleField>
          <RuleField label="Auto-trade (live)" hint="The second of two keys. Even with EXECUTOR=local set, live entries refuse until this is on — an env var alone must never spend real money. Exits are never gated: an open live position must always be closable.">
            <Toggle value={c.autoTrade} onChange={(v) => set({ autoTrade: v })} />
          </RuleField>
          <RuleField label="Halt after consecutive losses" hint="Computed fresh from closed positions on every entry, so there is no stored flag to drift. Resume from the Trading page clears the streak.">
            <Num value={c.maxConsecutiveLosses} onChange={(v) => set({ maxConsecutiveLosses: v })} min={1} max={50} />
          </RuleField>
          <RuleField label="Weekly loss halt" hint="Halts when rolling 7-day realized PnL breaches this share of bankroll.">
            <Num value={c.weeklyLossLimitPct} onChange={(v) => set({ weeklyLossLimitPct: v })} min={1} max={100} suffix="%" />
          </RuleField>
          <RuleField label="Min funding to follow" hint="A rotation must move at least this much SOL to count as spawning a new address.">
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
