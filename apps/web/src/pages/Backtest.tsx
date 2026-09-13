import { useState } from 'react';
import { useBacktest, useBackfillReports, useEntryCohorts, useExitMatrix, useHoldBands, useRunBacktest, useRunSwing, useSwingResults, useTuneBacktest } from '../api';
import { Info } from '../components/Info';

export function Backtest() {
  const { data } = useBacktest();
  const run = useRunBacktest();
  const tune = useTuneBacktest();
  const [sample, setSample] = useState(60);
  const r = data?.result;
  const running = data?.running ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Backtest</h1>
          <p className="text-sm text-dim mt-1">
            Real whale entries replayed against minute candles, scoring exit rules against each other. Built to settle
            exit questions with data instead of intuition — with 38% of the roster's profit sitting in the top 1% of
            trades, a rule that clips tails looks prudent while quietly destroying the strategy.
          </p>
        </div>
        <span className="flex items-center gap-2">
          <input
            type="number"
            min={5}
            max={300}
            step={10}
            value={sample}
            onChange={(e) => setSample(Number(e.target.value))}
            className="w-20 text-right"
          />
          <button className="btn" disabled={running || run.isPending} onClick={() => run.mutate({ sample })}>
            {running ? `Replaying ${data?.done ?? 0}/${data?.total ?? 0}…` : 'Fetch + replay'}
          </button>
          <button className="btn" disabled={tune.isPending} onClick={() => tune.mutate()} title="Tries every combination on a grid of round values, using cached paths.">
            {tune.isPending ? 'Searching…' : 'Tune parameters'}
          </button>
        </span>
      </div>

      {!r ? (
        <div className="panel p-8 text-center">
          <div className="text-bright font-semibold">{running ? 'Replaying…' : 'No run yet'}</div>
          <p className="text-sm text-dim mt-2">
            {running
              ? 'GeckoTerminal rate limits candle fetches, so a run takes a few minutes.'
              : 'Pick a sample size and run it. Entries come from the roster’s own history, not our fired signals — thousands of moments we could have copied.'}
          </p>
        </div>
      ) : (
        <div className="panel">
          <div className="px-4 pt-4 pb-2 eyebrow">
            Exit rules, ranked
            <Info text="Each rule replayed on the same entries, so differences come from the rule. Check the median too: one big winner can hide many losers." />
            <span className="normal-case tracking-normal text-dim"> · {r.replayed} of {r.sampled} entries had candle data</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="px-4 py-2 font-normal">exit rule</th>
                  <th className="px-4 py-2 font-normal text-right">avg</th>
                  <th className="px-4 py-2 font-normal text-right">median</th>
                  <th className="px-4 py-2 font-normal text-right">win rate</th>
                  <th className="px-4 py-2 font-normal text-right">best</th>
                  <th className="px-4 py-2 font-normal text-right">worst</th>
                </tr>
              </thead>
              <tbody>
                {r.strategies.map((s, i) => (
                  <tr key={s.strategy} className={`border-t border-line ${i === 0 ? 'bg-deck2/40' : ''}`}>
                    <td className="px-4 py-2 text-bright">{s.strategy}</td>
                    <td className={`px-4 py-2 text-right font-bold ${s.avgRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {s.avgRetPct > 0 ? '+' : ''}{s.avgRetPct}%
                    </td>
                    <td className={`px-4 py-2 text-right ${s.medianRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                      {s.medianRetPct > 0 ? '+' : ''}{s.medianRetPct}%
                    </td>
                    <td className="px-4 py-2 text-right text-dim">{s.winRate}%</td>
                    <td className="px-4 py-2 text-right text-profit">+{s.bestPct}%</td>
                    <td className="px-4 py-2 text-right text-loss">{s.worstPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-xs text-dim">
            Replays assume a fill at the entry candle's close and ignore slippage, so absolute numbers run optimistic —
            the ranking between rules is what transfers. Sampled from roster entries of 1+ SOL, infra excluded.
          </p>
        </div>
      )}
      <MatrixPanel />
      <SwingPanel />
      <HoldPanel />
      {tune.data && <TunePanel result={tune.data} />}
    </div>
  );
}

function SwingPanel() {
  const { data: rows = [] } = useSwingResults();
  const run = useRunSwing();
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4 flex-wrap">
        <span className="eyebrow">
          Swing — multi-day holds
          <Info text="Hourly candles reach days past entry, where minute data stops at 8 hours. Too coarse to judge a trailing stop fairly." />
        </span>
        <button className="btn py-1! px-2! text-[0.65rem]!" disabled={run.isPending} onClick={() => run.mutate({ sample: 80 })}>
          {run.isPending ? 'Fetching…' : 'Fetch hourly paths'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">No hourly paths yet — fetch some to compare multi-day holds.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-left text-dim text-xs">
                <th className="px-4 py-2 font-normal">strategy</th>
                <th className="px-4 py-2 font-normal text-right">avg</th>
                <th className="px-4 py-2 font-normal text-right">median</th>
                <th className="px-4 py-2 font-normal text-right">win rate</th>
                <th className="px-4 py-2 font-normal text-right">best</th>
                <th className="px-4 py-2 font-normal text-right">worst</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.strategy} className={`border-t border-line ${i === 0 ? 'bg-deck2/40' : ''}`}>
                  <td className="px-4 py-2 text-bright">{s.strategy}</td>
                  <td className={`px-4 py-2 text-right font-bold ${s.avgRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {s.avgRetPct > 0 ? '+' : ''}{s.avgRetPct}%
                  </td>
                  <td className={`px-4 py-2 text-right ${s.medianRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                    {s.medianRetPct > 0 ? '+' : ''}{s.medianRetPct}%
                  </td>
                  <td className="px-4 py-2 text-right text-dim">{s.winRate}%</td>
                  <td className="px-4 py-2 text-right text-profit">+{s.bestPct}%</td>
                  <td className="px-4 py-2 text-right text-loss">{s.worstPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-dim">
        Figures exclude slippage — subtract roughly 6% for a round trip. Hourly bars also hide intra-hour wicks, so
        trailing stops here fire later and look better than they would in practice.
      </p>
    </div>
  );
}

function HoldPanel() {
  const { data: bands = [] } = useHoldBands();
  if (bands.length === 0) return null;
  const peak = Math.max(...bands.map((b) => Math.abs(b.shareOfPnlPct)), 1);
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">
        Where the roster's profit lives, by hold time
        <Info text="Closed roster trades of 1+ ◎, grouped by how long they were held. Read the shape; the SOL amounts come from historical analysis." />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-left text-dim text-xs">
              <th className="px-4 py-2 font-normal">held for</th>
              <th className="px-4 py-2 font-normal text-right">trades</th>
              <th className="px-4 py-2 font-normal text-right">win rate</th>
              <th className="px-4 py-2 font-normal text-right">PnL ◎</th>
              <th className="px-4 py-2 font-normal">share of profit</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.band} className="border-t border-line">
                <td className="px-4 py-2 text-bright">{b.band}</td>
                <td className="px-4 py-2 text-right text-dim">{b.trades}</td>
                <td className="px-4 py-2 text-right text-dim">{b.winRate}%</td>
                <td className={`px-4 py-2 text-right ${b.pnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {b.pnlSol > 0 ? '+' : ''}{b.pnlSol}
                </td>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <span
                      className={`h-2 inline-block ${b.shareOfPnlPct >= 0 ? 'bg-profit' : 'bg-loss'}`}
                      style={{ width: `${Math.max(2, (Math.abs(b.shareOfPnlPct) / peak) * 100)}%` }}
                    />
                    <span className="text-xs text-dim">{b.shareOfPnlPct}%</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-dim">
        Our replay horizon is 8.3 hours — the most GeckoTerminal returns per call. Bands beyond that are invisible to
        the backtest, so any exit rule it recommends is only judged on trades that resolve inside the window.
      </p>
    </div>
  );
}


/** Rows named "entry × exit" — the only table here that varies both. */
function MatrixPanel() {
  const { data: rows = [] } = useExitMatrix();
  const { data: cohorts = [] } = useEntryCohorts();
  const backfill = useBackfillReports();
  if (!rows.length && !cohorts.length) return null;
  const table = (title: string, note: string, list: import('@million/shared').BacktestStrategyRow[]) => (
    <div className="border border-line bg-deck">
      <div className="px-4 py-3 border-b border-line">
        <h2 className="text-sm font-bold text-bright tracking-wide">{title}</h2>
        <p className="text-xs text-dim mt-1 max-w-3xl">{note}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-left text-dim text-xs">
              <th className="px-4 py-2 font-normal">entry × exit</th>
              <th className="px-4 py-2 font-normal text-right">n</th>
              <th className="px-4 py-2 font-normal text-right">avg</th>
              <th className="px-4 py-2 font-normal text-right">median</th>
              <th className="px-4 py-2 font-normal text-right">win rate</th>
              <th className="px-4 py-2 font-normal text-right">worst</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.strategy} className="border-t border-line">
                <td className="px-4 py-2 text-bright">
                  {s.strategy}
                  {/LOOK-AHEAD/.test(s.strategy) && (
                    <Info text="Biased: the checks read today's liquidity and holders, so tokens that later rugged fail and drop out. Shows the size of that bias only." />
                  )}
                </td>
                <td className="px-4 py-2 text-right text-dim">{s.trades}</td>
                <td className={`px-4 py-2 text-right font-bold ${s.avgRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {s.avgRetPct > 0 ? '+' : ''}{s.avgRetPct}%
                </td>
                <td className={`px-4 py-2 text-right ${s.medianRetPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {s.medianRetPct > 0 ? '+' : ''}{s.medianRetPct}%
                </td>
                <td className="px-4 py-2 text-right text-dim">{s.winRate}%</td>
                <td className="px-4 py-2 text-right text-loss">{s.worstPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-6">
      {table(
        'Entry filter × exit rule',
        'Every other table varies one and fixes the other, so none of them can show that the best exit depends on the entry. The mirror rows replay the whale\u2019s own hold time against the candles \u2014 the first time this backtest can score the exit mode we actually run.',
        rows,
      )}
      <div className="flex flex-col gap-2">
        {table(
          'Entry cohorts, one fixed exit',
          'Rows differ only by which entries they admit. Pair age is exact \u2014 launch time is fixed, so age-at-entry is arithmetic. Authority rows are time-honest: revocation is one-way, so \u201Cactive today\u201D proves \u201Cactive at entry\u201D.',
          cohorts,
        )}
        <button className="btn self-start py-1! px-2! text-[0.65rem]!" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
          {backfill.isPending ? 'Checking…' : 'Backfill gauntlet reports'}
        </button>
      </div>
    </div>
  );
}

const PARAM_LABEL: Record<string, string> = {
  trailPct: 'Trail %',
  armAtPct: 'Arm at +%',
  stopLossPct: 'Stop loss %',
  takeProfitPct: 'Take profit %',
};

/** Each parameter value scored across every combination it appears in. */
function MarginalsGrid({ rows }: { rows: import('@million/shared').BacktestMarginal[] }) {
  const params = [...new Set(rows.map((r) => r.param))];
  return (
    <div className="px-4 pb-3">
      <div className="text-xs text-dim mb-2">
        Read this first: each value averaged over every combination containing it. Robust effects show here; the table
        below can win on luck.
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {params.map((p) => {
          const mine = rows.filter((r) => r.param === p).sort((a, b) => b.avgTestPct - a.avgTestPct);
          const best = mine[0]?.value;
          return (
            <div key={p} className="border border-line p-2">
              <div className="eyebrow mb-1">{PARAM_LABEL[p] ?? p}</div>
              <table className="w-full text-xs font-mono">
                <tbody>
                  {mine.map((m) => (
                    <tr key={m.value} className={m.value === best ? 'text-bright' : 'text-dim'}>
                      <td className="py-0.5">{m.value}</td>
                      <td className={`py-0.5 text-right ${m.avgTestPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                        {m.avgTestPct > 0 ? '+' : ''}{m.avgTestPct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TunePanel({ result }: { result: import('@million/shared').BacktestTuneResult }) {
  if (!result.paths) return null;
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">
        Parameter search
        <Info text="Random search on cached paths, ranked on the training set. Trust the test column: train far above test means overfitting." />
        <span className="normal-case tracking-normal text-dim"> · {result.tried} combinations over {result.paths} cached entries</span>
      </div>
      <MarginalsGrid rows={result.marginals} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-left text-dim text-xs">
              <th className="px-4 py-2 font-normal">trail</th>
              <th className="px-4 py-2 font-normal">arm at</th>
              <th className="px-4 py-2 font-normal">stop</th>
              <th className="px-4 py-2 font-normal">take profit</th>
              <th className="px-4 py-2 font-normal text-right">train avg</th>
              <th className="px-4 py-2 font-normal text-right">TEST avg</th>
              <th className="px-4 py-2 font-normal text-right">test median</th>
              <th className="px-4 py-2 font-normal text-right">test WR</th>
            </tr>
          </thead>
          <tbody>
            {result.best.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-4 py-2 text-bright">{r.trailPct}%</td>
                <td className="px-4 py-2 text-dim">+{r.armAtPct}%</td>
                <td className="px-4 py-2 text-dim">{r.stopLossPct >= 100 ? 'none' : `−${r.stopLossPct}%`}</td>
                <td className="px-4 py-2 text-dim">{r.takeProfitPct >= 9999 ? 'none' : `+${r.takeProfitPct}%`}</td>
                <td className="px-4 py-2 text-right text-dim">{r.trainAvgPct > 0 ? '+' : ''}{r.trainAvgPct}%</td>
                <td className={`px-4 py-2 text-right font-bold ${r.testAvgPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {r.testAvgPct > 0 ? '+' : ''}{r.testAvgPct}%
                </td>
                <td className={`px-4 py-2 text-right ${r.testMedianPct >= 0 ? 'text-profit' : 'text-loss'}`}>
                  {r.testMedianPct > 0 ? '+' : ''}{r.testMedianPct}%
                </td>
                <td className="px-4 py-2 text-right text-dim">{r.testWinRate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-dim">
        The grid is deliberately coarse and round: fewer degrees of freedom to spend on noise, every value one you
        could type into the config, and small enough to search exhaustively so the result is reproducible rather than a
        lucky draw. Still — four parameters against a few dozen entries overfits easily. Trust the marginals over the
        winner, treat a large train/test gap as a warning, and fetch more paths before changing a live setting.
      </p>
    </div>
  );
}
