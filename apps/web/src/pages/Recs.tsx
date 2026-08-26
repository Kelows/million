import { Link } from '@tanstack/react-router';
import { useRecommendations, useRunRecommendations } from '../api';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { fmtAgo, fmtPct, fmtSol, truncAddr } from '../lib/format';

const LATER_IDEAS = [
  { name: 'Copyability score', why: 'replay each whale entry with +2 blocks latency — does the edge survive you?' },
  { name: 'Fresh-wallet funding chains', why: 'a known whale funding a new wallet = same actor, new address' },
  { name: 'Exit velocity alerts', why: 'multiple tracked whales exiting the same token within minutes' },
  { name: 'Wallet overlap graph', why: 'wallets that repeatedly enter the same tokens in the same window are one entity or one signal group' },
  { name: 'Live feed', why: 'Helius webhooks on tracked wallets instead of on-demand re-analysis' },
];

export function Recs() {
  const { data: recs, isLoading } = useRecommendations();
  const run = useRunRecommendations();

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-bright tracking-wide">Recommendations</h1>
          <p className="text-sm text-dim mt-1">
            Computed from cached analyses only — re-run after analyzing new wallets.
          </p>
        </div>
        <div className="text-right">
          <button className="btn" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Computing…' : recs ? 'Re-run' : 'Run'}
          </button>
          {recs && (
            <div className="text-xs text-dim mt-2" title={recs.generatedAt}>
              generated {fmtAgo(recs.generatedAt)} · {recs.qualifyingWallets}/{recs.totalAnalyzed} wallets qualify
              (WR &gt; {Math.round(recs.criteria.minWinRate * 100)}%, ≥ {recs.criteria.minClosedTokens} closed)
            </div>
          )}
        </div>
      </div>
      {run.error && <p className="text-xs text-loss">{run.error.message}</p>}

      {!recs && !isLoading ? (
        <div className="panel p-8 text-center text-sm text-dim">
          Nothing computed yet — hit Run once some wallets are analyzed.
        </div>
      ) : recs ? (
        <>
          <div className="panel">
            <div className="px-4 pt-4 pb-2 eyebrow">Consensus tokens · held open by ≥ 2 qualifying wallets</div>
            {recs.consensusTokens.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dim">
                No overlap right now — either conviction is scattered or the roster needs fresher analysis.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="text-left text-dim text-xs">
                      <th className="px-4 py-2 font-normal">token</th>
                      <th className="px-4 py-2 font-normal">held by</th>
                      <th className="px-4 py-2 font-normal">wallets</th>
                      <th className="px-4 py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.consensusTokens.map((t) => (
                      <tr key={t.mint} className="border-t border-line hover:bg-deck2">
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-2">
                            {t.symbol && <span className="text-bright font-semibold">{t.symbol}</span>}
                            <Addr address={t.mint} kind="token" />
                          </span>
                        </td>
                        <td className="px-4 py-2 text-warn">{t.count}</td>
                        <td className="px-4 py-2 text-xs text-dim">
                          {t.holders.slice(0, 4).map((h) => h.label ?? truncAddr(h.address)).join(', ')}
                          {t.holders.length > 4 && ` +${t.holders.length - 4}`}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link to="/token-check" search={{ mint: t.mint }} className="text-xs text-neon hover:underline">
                            check →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="px-4 pt-4 pb-2 eyebrow">Wallets to watch · qualifying, with open positions, by realized PnL</div>
            {recs.walletsToWatch.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dim">No qualifying wallets with open positions yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="text-left text-dim text-xs">
                      <th className="pl-4 pr-0 py-2 w-8"></th>
                      <th className="px-4 py-2 font-normal">wallet</th>
                      <th className="px-4 py-2 font-normal">win rate</th>
                      <th className="px-4 py-2 font-normal text-right">realized PnL</th>
                      <th className="px-4 py-2 font-normal">open</th>
                      <th className="px-4 py-2 font-normal">last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.walletsToWatch.map((w) => (
                      <tr key={w.address} className="border-t border-line hover:bg-deck2">
                        <td className="pl-4 pr-0 py-2">
                          <Link to="/wallets/$address" params={{ address: w.address }} title="Open wallet detail" className="text-dim hover:text-neon inline-flex">
                            <EyeIcon />
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          {w.label ? <span className="text-ink">{w.label}</span> : <Addr address={w.address} />}
                        </td>
                        <td className="px-4 py-2">{fmtPct(w.winRate)}</td>
                        <td className={`px-4 py-2 text-right ${w.realizedPnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>{fmtSol(w.realizedPnlSol)}</td>
                        <td className="px-4 py-2 text-warn">{w.openCount}</td>
                        <td className="px-4 py-2 text-dim">{fmtAgo(w.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      <div className="panel p-4">
        <span className="eyebrow">Possible later</span>
        <ul className="mt-3 flex flex-col gap-2">
          {LATER_IDEAS.map((idea) => (
            <li key={idea.name} className="flex items-baseline gap-3 text-sm">
              <span className="text-dim font-mono text-xs">[ ]</span>
              <span className="text-ink">{idea.name}</span>
              <span className="text-xs text-dim">— {idea.why}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
