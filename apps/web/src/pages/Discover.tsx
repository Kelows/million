import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useDiscovery, useImportWallets } from '../api';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { FlagChip } from '../components/FlagChip';
import { fmtAgo, fmtPct, fmtSol, truncAddr } from '../lib/format';

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function Discover() {
  const { mint: mintParam } = getRouteApi('/discover').useSearch();
  const initial = mintParam && SOL_ADDR.test(mintParam) ? mintParam : null;
  const [input, setInput] = useState(initial ?? '');
  const [mint, setMint] = useState<string | null>(initial);
  const [minSol, setMinSol] = useState(5);
  const [inputError, setInputError] = useState<string | null>(null);
  const { data: report, isFetching, error } = useDiscovery(mint, minSol);
  const importWallets = useImportWallets();

  const submit = () => {
    const candidate = input.trim();
    if (!SOL_ADDR.test(candidate)) {
      setInputError('That is not a valid token mint address.');
      return;
    }
    setInputError(null);
    setMint(candidate);
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
              <span className="eyebrow">Size buyers · {report.candidates.length} above {report.minSol} SOL</span>
              {clean.length > 1 && (
                <button className="btn py-1! px-2! text-[0.6rem]!" disabled={importWallets.isPending} onClick={() => addToRoster(clean.map((c) => c.address))}>
                  add all clean ({clean.length})
                </button>
              )}
            </div>
            {report.candidates.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dim">No buyers above the threshold in the scanned window — lower min SOL or try a busier token.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="text-left text-dim text-xs">
                      <th className="pl-4 pr-0 py-2 w-8"></th>
                      <th className="px-4 py-2 font-normal">wallet</th>
                      <th className="px-4 py-2 font-normal text-right">bought</th>
                      <th className="px-4 py-2 font-normal">buys</th>
                      <th className="px-4 py-2 font-normal">last buy</th>
                      <th className="px-4 py-2 font-normal">WR</th>
                      <th className="px-4 py-2 font-normal text-right">PnL</th>
                      <th className="px-4 py-2 font-normal">flags</th>
                      <th className="px-4 py-2 font-normal"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.candidates.map((c) => (
                      <tr key={c.address} className="border-t border-line hover:bg-deck2">
                        <td className="pl-4 pr-0 py-2">
                          <Link to="/wallets/$address" params={{ address: c.address }} title="Open wallet detail (auto-analyzes if unknown)" className="text-dim hover:text-neon inline-flex">
                            <EyeIcon />
                          </Link>
                        </td>
                        <td className="px-4 py-2"><Addr address={c.address} /></td>
                        <td className="px-4 py-2 text-right text-bright">{c.boughtSol.toLocaleString('en-US')} ◎</td>
                        <td className="px-4 py-2 text-dim">{c.buyTxs}</td>
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
                            <button className="btn py-1! px-2! text-[0.6rem]!" disabled={importWallets.isPending} onClick={() => addToRoster([c.address])}>add</button>
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
