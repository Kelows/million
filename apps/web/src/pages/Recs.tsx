import { Link } from '@tanstack/react-router';
import { useRecommendations, useRunRecommendations } from '../api';
import { Addr } from '../components/Addr';
import { fmtAgo, truncAddr } from '../lib/format';

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
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0 max-w-xl">
          <h1 className="text-xl font-bold text-bright tracking-wide">Recommendations</h1>
          <p className="text-sm text-dim mt-1">
            Consensus across your whales, computed from cached analyses — re-run after analyzing new wallets. The
            wallet watch list lives on the overview.
          </p>
        </div>
        <div className="text-right shrink-0 max-w-64">
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
                        <td className="px-4 py-2"><Addr address={t.mint} kind="token" symbol={t.symbol} /></td>
                        <td className="px-4 py-2 text-warn">{t.count}</td>
                        <td className="px-4 py-2 text-xs">
                          {t.holders.slice(0, 4).map((h, i) => (
                            <span key={h.address}>
                              {i > 0 && <span className="text-dim">, </span>}
                              <Link
                                to="/wallets/$address"
                                params={{ address: h.address }}
                                className="text-neon hover:underline"
                              >
                                {h.label ?? truncAddr(h.address)}
                              </Link>
                            </span>
                          ))}
                          {t.holders.length > 4 && <span className="text-dim"> +{t.holders.length - 4}</span>}
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
