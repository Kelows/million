import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useDiscovery, useImportWallets, type DiscoveryParams } from '../api';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { FlagChip } from '../components/FlagChip';
import { fmtAgo, fmtPct, fmtSol, truncAddr } from '../lib/format';
import { useTableSort, type SortColumn } from '../lib/useTableSort';
import { SortHeader } from '../components/SortHeader';
import { whaleScore as sharedWhaleScore, type WhaleCandidate } from '@million/shared';

/** The whale-finding insight: size buys are mostly bots — quality of the buyer is the signal.
 * Bots are hard-penalized; otherwise win rate carries most weight, realized PnL the rest. */
function isBotCandidate(c: WhaleCandidate): boolean {
  return (c.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS');
}

function whaleScore(c: WhaleCandidate): number | null {
  if (!c.preview) return null;
  if (isBotCandidate(c)) return null; // not scored — flags carry the verdict
  return sharedWhaleScore(c.preview.winRate, c.preview.realizedPnlSol, false);
}

const DISCOVER_COLUMNS: SortColumn<WhaleCandidate>[] = [
  { key: 'score', get: (c) => whaleScore(c) },
  { key: 'bought', get: (c) => c.boughtSol },
  { key: 'buys', get: (c) => c.buyTxs },
  { key: 'firstBuy', get: (c) => new Date(c.firstBuyAt).getTime() },
  { key: 'lastBuy', get: (c) => new Date(c.lastBuyAt).getTime() },
  { key: 'wr', get: (c) => c.preview?.winRate ?? null },
  { key: 'pnl', get: (c) => c.preview?.realizedPnlSol ?? null },
];

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function Discover() {
  const { mint: mintParam } = getRouteApi('/discover').useSearch();
  const initial = mintParam && SOL_ADDR.test(mintParam) ? mintParam : null;
  const [input, setInput] = useState(initial ?? '');
  const [minSol, setMinSol] = useState(5);
  const [mode, setMode] = useState<'recent' | 'deep'>('recent');
  const [sinceDays, setSinceDays] = useState(30);
  const [buckets, setBuckets] = useState(24);
  const [inputError, setInputError] = useState<string | null>(null);
  // scans fire only on explicit submit — knob changes just stage the next scan
  const [params, setParams] = useState<DiscoveryParams | null>(
    initial ? { mint: initial, minSol: 5, mode: 'recent', sinceDays: 30, buckets: 24 } : null,
  );
  const { data: report, isFetching, error } = useDiscovery(params);
  const [showInfra, setShowInfra] = useState(false);
  const isFlagged = (c: WhaleCandidate) => (c.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS');
  const visible = (report?.candidates ?? []).filter((c) => showInfra || !isFlagged(c));
  const hiddenCount = (report?.candidates.length ?? 0) - visible.length;
  const sort = useTableSort(visible, DISCOVER_COLUMNS, 'score');
  const importWallets = useImportWallets();
  const mint = params?.mint ?? null;

  const submit = () => {
    const candidate = input.trim();
    if (!SOL_ADDR.test(candidate)) {
      setInputError('That is not a valid token mint address.');
      return;
    }
    setInputError(null);
    setParams({ mint: candidate, minSol, mode, sinceDays, buckets });
  };

  const addToRoster = (addresses: string[]) => {
    if (!addresses.length) return;
    importWallets.mutate({ wallets: addresses, source: `discover:${mint ? truncAddr(mint) : 'manual'}` });
  };

  const clean = (report?.candidates ?? []).filter(
    (c) => !c.inRoster && c.preview && !(c.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS'),
  );

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Find new whales</h1>
        <p className="text-sm text-dim mt-1">
          Paste a token — every account that paid ≥ min SOL for it in recent transactions gets a quick analysis.
          Recent window only: this finds current size buyers, not early winners. Big ≠ smart — read the stats.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <div className="flex gap-3 flex-wrap">
          <input
            placeholder="token mint address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="flex-1 min-w-64"
          />
          <label className="flex items-center gap-2 text-xs text-dim">
            min buy (SOL)
            <input type="number" min={0} step={1} value={minSol} onChange={(e) => setMinSol(Number(e.target.value))} className="w-20 text-right" />
          </label>
          <span className="flex items-center gap-1">
            {(['recent', 'deep'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={m === 'deep' ? 'Time-sampled across the token\u2019s life — finds early buyers, costs more credits' : 'Last few hundred transactions only'}
                className={`px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest border cursor-pointer ${
                  mode === m ? 'border-neon text-neon' : 'border-line text-dim hover:text-ink'
                }`}
              >
                {m}
              </button>
            ))}
          </span>
          {mode === 'deep' && (
            <>
              <label className="flex items-center gap-2 text-xs text-dim">
                days
                <input type="number" min={1} max={365} value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))} className="w-16 text-right" />
              </label>
              <label className="flex items-center gap-2 text-xs text-dim" title="Time checkpoints sampled across the window — denser = better coverage, ~4 credits each">
                buckets
                <input type="number" min={6} max={96} value={buckets} onChange={(e) => setBuckets(Number(e.target.value))} className="w-16 text-right" />
              </label>
            </>
          )}
          <button className="btn" disabled={!input.trim() || isFetching} onClick={submit}>
            {isFetching ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {inputError && <p className="text-xs text-loss">{inputError}</p>}
        {error && <p className="text-xs text-loss">{error.message}</p>}
        {importWallets.isSuccess && (
          <p className="text-xs text-profit">
            Added {importWallets.data.imported} wallet{importWallets.data.imported === 1 ? '' : 's'} to the roster
            {importWallets.data.skipped ? ` (${importWallets.data.skipped} already there)` : ''}.
          </p>
        )}
      </div>

      {report && !isFetching && (
        <>
          <div className="panel">
            <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4">
              <span className="eyebrow">Size buyers · {visible.length}{hiddenCount > 0 ? ` (+${hiddenCount} infra hidden)` : ''} above {report.minSol} SOL</span>
              <label className="flex items-center gap-2 text-xs text-dim cursor-pointer mr-auto">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={showInfra}
                  onChange={(e) => setShowInfra(e.target.checked)}
                />
                show infra & farmed
              </label>
              {clean.length > 1 && (
                <button className="btn py-1! px-2! text-[0.6rem]!" disabled={importWallets.isPending} onClick={() => addToRoster(clean.map((c) => c.address))}>
                  add all clean ({clean.length})
                </button>
              )}
            </div>
            {visible.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dim">
                {report.candidates.length > 0
                  ? 'Only infra/farmed buyers found — tick "show infra & farmed" to see them.'
                  : 'No buyers above the threshold in the scanned window — lower min SOL or try a busier token.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="text-left text-dim text-xs">
                      <th className="pl-4 pr-0 py-2 w-8"></th>
                      <th className="px-4 py-2 font-normal">wallet</th>
                      <SortHeader label="score" colKey="score" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} hint="Buyer quality from the preview analysis: win rate + PnL, bots hard-penalized. The whale signal — size alone is mostly routers." />
                      <SortHeader label="bought" colKey="bought" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                      <SortHeader label="buys" colKey="buys" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                      <SortHeader label="first buy" colKey="firstBuy" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                      <SortHeader label="last buy" colKey="lastBuy" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                      <SortHeader label="WR" colKey="wr" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} />
                      <SortHeader label="PnL" colKey="pnl" sortKey={sort.sortKey} dir={sort.dir} onToggle={sort.toggle} right />
                      <th className="px-4 py-2 font-normal">flags</th>
                      <th className="px-4 py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sort.sorted.map((c) => (
                      <tr key={c.address} className="border-t border-line hover:bg-deck2">
                        <td className="pl-4 pr-0 py-2">
                          <Link to="/wallets/$address" params={{ address: c.address }} title="Open wallet detail (auto-analyzes if unknown)" className="text-dim hover:text-neon inline-flex">
                            <EyeIcon />
                          </Link>
                        </td>
                        <td className="px-4 py-2"><Addr address={c.address} /></td>
                        <td className="px-4 py-2">
                          {(() => {
                            if (c.preview && isBotCandidate(c)) return <span className="text-dim" title="Bot-flagged — not scored, see flags">N/A</span>;
                            const score = whaleScore(c);
                            if (score === null) return <span className="text-dim">—</span>;
                            return <span className={`font-bold ${score >= 50 ? 'text-profit' : score >= 0 ? 'text-ink' : 'text-loss'}`}>{score}</span>;
                          })()}
                        </td>
                        <td className="px-4 py-2 text-right text-bright">{c.boughtSol.toLocaleString('en-US')} ◎</td>
                        <td className="px-4 py-2 text-dim">{c.buyTxs}</td>
                        <td className="px-4 py-2 text-dim" title={c.firstBuyAt}>{fmtAgo(c.firstBuyAt)}</td>
                        <td className="px-4 py-2 text-dim" title={c.lastBuyAt}>{fmtAgo(c.lastBuyAt)}</td>
                        <td className="px-4 py-2">{c.preview ? fmtPct(c.preview.winRate) : '—'}</td>
                        <td className={`px-4 py-2 text-right ${c.preview ? (c.preview.realizedPnlSol >= 0 ? 'text-profit' : 'text-loss') : 'text-dim'}`}>
                          {c.preview ? fmtSol(c.preview.realizedPnlSol) : '—'}
                        </td>
                        <td className="px-4 py-2">
                          <span className="flex gap-1 flex-wrap">{(c.flags ?? []).map((f) => <FlagChip key={f} flag={f} />)}</span>
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          {c.inRoster ? (
                            <Link to="/wallets/$address" params={{ address: c.address }} className="text-xs text-dim hover:text-neon">in roster →</Link>
                          ) : (
                            <button
                              className="btn py-1! px-2! text-[0.6rem]!"
                              disabled={importWallets.isPending}
                              onClick={() => {
                                const bad = (c.flags ?? []).filter((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS');
                                if (bad.length && !window.confirm(`This wallet is flagged ${bad.join(' + ')} — likely plumbing or a farmed account, its stats are untrustworthy. Add to the roster anyway?`)) {
                                  return;
                                }
                                addToRoster([c.address]);
                              }}
                            >
                              add
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="text-xs text-dim">
            <Link to="/tokens/$mint" params={{ mint: report.mint }} className="text-neon hover:underline">token detail →</Link>{' '}
            · {report.scannedTxs} token txs scanned{report.truncated ? ' (truncated — most recent only)' : ''} · stats are the
            usual heuristic (last 100 txs per wallet, top {15} unknowns) · "clean" = analyzed, not infra, not farmed.
          </p>
        </>
      )}
    </div>
  );
}
