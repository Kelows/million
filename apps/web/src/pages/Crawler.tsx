import { useEffect, useState } from 'react';
import type { CrawlerConfig, CrawlerRunSummary } from '@million/shared';
import { useCrawler, useRunCrawlerOnce, useSetCrawlerConfig } from '../api';
import { fmtAgo } from '../lib/format';
import { ThresholdFields } from '../components/ThresholdFields';

interface NumberFieldDef {
  key: keyof Pick<CrawlerConfig, 'intervalMinutes' | 'creditsPerIteration' | 'maxTokensChecked' | 'maxWalletsAbsorbed' | 'maxWalletsReanalyzed' | 'discoveryMinSol' | 'minOpenSol' | 'deepScanBuckets' | 'minWhaleScore' | 'deepRunCredits'>;
  label: string;
  hint: string;
  step: number;
}

interface FieldSection {
  title: string;
  fields: NumberFieldDef[];
}

const SECTIONS: FieldSection[] = [
  {
    title: 'Budget — every iteration, run-once or auto',
    fields: [
      { key: 'creditsPerIteration', label: 'Credit budget per iteration', hint: '~1 credit per page fetch or check; the iteration stops mid-work when spent', step: 50 },
      { key: 'deepRunCredits', label: 'Deep-run total budget', hint: 'a deep run chains passes back-to-back until this total is spent or nothing productive remains', step: 500 },
    ],
  },
  {
    title: 'Auto mode — armed by Start',
    fields: [
      { key: 'intervalMinutes', label: 'Run an iteration every (minutes)', hint: 'this IS your iteration count: 1440 / interval = iterations per day', step: 5 },
    ],
  },
  {
    title: 'Finding tokens (from your wallets)',
    fields: [
      { key: 'minOpenSol', label: 'Min entry size (SOL)', hint: 'a wallet\u2019s token entry below this is dust and ignored', step: 0.5 },
    ],
  },
  {
    title: 'Finding wallets (from those tokens)',
    fields: [
      { key: 'discoveryMinSol', label: 'Min buy to count as a buyer (SOL)', hint: 'size floor when scanning a token\u2019s buyers', step: 1 },
      { key: 'minWhaleScore', label: 'Min whale score to absorb', hint: 'every clean buyer at or above this joins the roster — quality is absolute, not relative', step: 10 },
      { key: 'maxWalletsAbsorbed', label: 'Absorption cap per iteration', hint: 'a safety cap, not a target', step: 5 },
      { key: 'deepScanBuckets', label: 'Deep-scan buckets (new tokens)', hint: 'time checkpoints when mining a new token\u2019s whole life (~3 credits each)', step: 12 },
    ],
  },
  {
    title: 'Keeping data fresh',
    fields: [
      { key: 'maxWalletsReanalyzed', label: 'Stalest re-analyses per iteration', hint: 'rotates through the roster so cached stats never go stale', step: 5 },
    ],
  },
];

export function Crawler() {
  const { data: status } = useCrawler();
  const save = useSetCrawlerConfig();
  const runOnce = useRunCrawlerOnce();
  const [config, setConfig] = useState<CrawlerConfig | null>(null);

  useEffect(() => {
    if (status && !config) setConfig(status.config);
  }, [status, config]);

  if (!config) return <p className="text-dim text-sm">Loading…</p>;

  const sourceError = !config.sources.wallets && !config.sources.tokens;
  const set = (patch: Partial<CrawlerConfig>) => setConfig((c) => (c ? { ...c, ...patch } : c));
  const dirty = status && JSON.stringify(config) !== JSON.stringify(status.config);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Crawler</h1>
          <p className="text-sm text-dim mt-1">
            The loop, automated: refresh analyses → gauntlet → absorb clean buyers of passing gems → repeat.
            Budgeted per iteration so it can run forever.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono text-sm font-bold ${status?.deepRunning || status?.running ? 'text-warn' : status?.config.enabled ? 'text-profit' : 'text-dim'}`}>
            {status?.deepRunning ? '● DEEP RUN' : status?.running ? '● RUNNING' : status?.config.enabled ? '● ARMED' : '○ PAUSED'}
          </div>
          {status?.nextRunAt && <div className="text-xs text-dim mt-1" title={status.nextRunAt}>next run {fmtAgo(status.nextRunAt).replace(' ago', '')} from now</div>}
        </div>
      </div>

      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <span className="eyebrow">Configuration</span>
          <div className="flex gap-2">
            <button
              className="btn py-1! px-2! text-[0.6rem]!"
              disabled={runOnce.isPending || status?.running || status?.deepRunning}
              title="One pass through the loop, capped by the per-iteration budget"
              onClick={() => runOnce.mutate('once')}
            >
              {status?.running && !status?.deepRunning ? 'running…' : 'quick run'}
            </button>
            <button
              className="btn py-1! px-2! text-[0.6rem]!"
              disabled={runOnce.isPending || status?.running || status?.deepRunning}
              title="Chains passes back-to-back until the deep-run budget is spent or nothing productive remains"
              onClick={() => runOnce.mutate('deep')}
            >
              {status?.deepRunning ? 'deep running…' : `deep run (~${config.deepRunCredits.toLocaleString('en-US')} cr)`}
            </button>
            {(status?.running || status?.deepRunning) && (
              <button
                className="btn btn-danger py-1! px-2! text-[0.6rem]!"
                title="Finish the in-flight step, then abort the run"
                onClick={() => runOnce.mutate('stop')}
              >
                stop run
              </button>
            )}
            {config.enabled ? (
              <button className="btn btn-danger py-1! px-2! text-[0.6rem]!" disabled={save.isPending} onClick={() => save.mutate({ ...config, enabled: false })}>
                stop
              </button>
            ) : (
              <button className="btn py-1! px-2! text-[0.6rem]!" disabled={save.isPending || sourceError} onClick={() => save.mutate({ ...config, enabled: true })}>
                start
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-6 flex-wrap">
          <span className="text-sm">Sources:</span>
          {(['wallets', 'tokens'] as const).map((source) => (
            <label key={source} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="checkbox"
                checked={config.sources[source]}
                onChange={(e) => set({ sources: { ...config.sources, [source]: e.target.checked } })}
              />
              {source}
            </label>
          ))}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="checkbox"
              checked={config.autoAbsorb}
              onChange={(e) => set({ autoAbsorb: e.target.checked })}
            />
            auto-absorb clean wallets
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="checkbox"
              checked={config.deepScanNewGems}
              onChange={(e) => set({ deepScanNewGems: e.target.checked })}
            />
            deep-scan new gems (whole-life buyers)
          </label>
        </div>
        {sourceError && <p className="text-xs text-loss">At least one source must stay enabled.</p>}

        {SECTIONS.map((section) => (
          <div key={section.title} className="border-t border-line pt-3">
            <span className="eyebrow">{section.title}</span>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3 mt-2">
              {section.fields.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-4 text-sm">
                  <span>
                    {f.label}
                    <span className="block text-xs text-dim">{f.hint}</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={f.step}
                    value={config[f.key]}
                    onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<CrawlerConfig>)}
                    className="w-28 text-right"
                  />
                </label>
              ))}
            </div>
            {section.title.startsWith('Auto mode') && (
              <p className="text-xs font-mono text-dim mt-2">
                armed = ~{Math.round(1440 / config.intervalMinutes)} iterations/day × {config.creditsPerIteration} credits
                ≈ {Math.round((1440 / config.intervalMinutes) * config.creditsPerIteration).toLocaleString('en-US')}/day
                ≈ {Math.round(((1440 / config.intervalMinutes) * config.creditsPerIteration * 30) / 10_000)}% of the 1M/mo free tier
              </p>
            )}
          </div>
        ))}

        <div className="flex items-center gap-3">
          <button className="btn" disabled={save.isPending || !dirty || sourceError} onClick={() => save.mutate(config)}>
            {save.isPending ? 'Saving…' : 'Save config'}
          </button>
          {save.error && <span className="text-xs text-loss">{save.error.message}</span>}
          {dirty && !save.isPending && <span className="text-xs text-warn">unsaved changes</span>}
        </div>
        <div className="border-t border-line pt-4 flex flex-col gap-3">
          <span className="eyebrow">Gauntlet thresholds <span className="normal-case tracking-normal">· size gates trading; safety-clean tokens still feed wallet discovery</span></span>
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-3">
            <ThresholdFields value={config.thresholds} onChange={(thresholds) => set({ thresholds })} />
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="px-4 pt-4 pb-2 eyebrow">Iterations · last {status?.lastRuns.length ?? 0}</div>
        {(status?.lastRuns ?? []).length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">No runs yet — hit "run once now" to watch an iteration.</p>
        ) : (
          <ul>
            {status!.lastRuns.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunRow({ run }: { run: CrawlerRunSummary }) {
  const s = run.stats;
  return (
    <li className="border-t border-line px-4 py-3">
      <details>
        <summary className="cursor-pointer text-sm flex gap-4 flex-wrap items-baseline">
          <span className="text-dim font-mono text-xs" title={run.startedAt}>{fmtAgo(run.startedAt)}</span>
          {run.finishedAt === null ? (
            <span className="text-warn text-xs">running…</span>
          ) : s ? (
            <span className="font-mono text-xs">
              <span className="text-ink">{s.walletsReanalyzed} refreshed</span> · <span className="text-ink">{s.candidates} candidates</span> ·{' '}
              <span className={s.gemsPass > 0 ? 'text-profit' : 'text-dim'}>{s.gemsPass} pass</span> ·{' '}
              <span className={s.walletsAbsorbed > 0 ? 'text-neon' : 'text-dim'}>{s.walletsAbsorbed} absorbed</span> ·{' '}
              <span className="text-dim">{s.creditsUsed} credits</span>
            </span>
          ) : (
            <span className="text-dim text-xs">no stats</span>
          )}
        </summary>
        <pre className="mt-2 text-xs text-dim font-mono whitespace-pre-wrap bg-void border border-line p-3 overflow-x-auto">{run.log.join('\n')}</pre>
      </details>
    </li>
  );
}
