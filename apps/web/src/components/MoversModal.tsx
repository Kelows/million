import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useImportTokens, useMovers, type MoversParams } from '../api';
import { Addr } from './Addr';
import { TokenName } from './TokenName';

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US')}`;

/** Find tokens that pumped and import the interesting ones — search fires only on the button. */
export function MoversModal() {
  const [open, setOpen] = useState(false);
  const [minPump, setMinPump] = useState(50);
  const [minMcap, setMinMcap] = useState(100_000);
  const [maxMcap, setMaxMcap] = useState(50_000_000);
  const [params, setParams] = useState<MoversParams | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: movers = [], isFetching, error } = useMovers(params);
  const importTokens = useImportTokens();

  const selectable = movers.filter((m) => !m.alreadyTracked);
  const toggle = (mint: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint);
      else next.add(mint);
      return next;
    });

  const doImport = () => {
    importTokens.mutate(
      { mints: [...selected], source: 'movers' },
      { onSuccess: () => { setSelected(new Set()); setOpen(false); } },
    );
  };

  return (
    <>
      <button type="button" className="btn py-1! px-2! text-[0.6rem]!" onClick={() => setOpen(true)}>
        Find movers
      </button>
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
            <div
              className="panel panel-raised w-[54rem] max-w-full h-[85vh] p-6 flex flex-col gap-4"
              role="dialog"
              aria-label="Find movers"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-bold text-bright tracking-wide">Tokens that pumped</h2>
                  <p className="text-xs text-dim mt-0.5">
                    trending + boosts, ranked by 24h change · liq banded $25k–$3M · meme-sized only
                  </p>
                </div>
                <button type="button" className="text-dim hover:text-ink text-lg" onClick={() => setOpen(false)}>✕</button>
              </div>

              <div className="flex items-end gap-4 flex-wrap">
                <label className="flex flex-col gap-1 text-xs text-dim">
                  min pump %
                  <input type="number" min={0} step={25} value={minPump} onChange={(e) => setMinPump(Number(e.target.value))} className="w-24 text-right" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-dim">
                  min mcap $
                  <input type="number" min={0} step={50_000} value={minMcap} onChange={(e) => setMinMcap(Number(e.target.value))} className="w-32 text-right" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-dim">
                  max mcap $
                  <input type="number" min={0} step={1_000_000} value={maxMcap} onChange={(e) => setMaxMcap(Number(e.target.value))} className="w-36 text-right" />
                </label>
                <button
                  className="btn"
                  disabled={isFetching}
                  onClick={() => setParams({ minPump, minMcap, maxMcap })}
                >
                  {isFetching ? 'Searching…' : 'Search'}
                </button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto border-t border-line">
                {params === null ? (
                  <p className="text-sm text-dim py-10 text-center">Set your filters and hit Search — external APIs, ~20s.</p>
                ) : isFetching ? (
                  <p className="text-sm text-dim py-10 text-center">Hunting movers… (~20s, external APIs)</p>
                ) : error ? (
                  <p className="text-sm text-loss py-6 text-center">{error.message}</p>
                ) : movers.length === 0 ? (
                  <p className="text-sm text-dim py-10 text-center">No movers match — lower the pump bar or widen the mcap range.</p>
                ) : (
                  <table className="w-full text-sm font-mono">
                    <thead className="sticky top-0 bg-deck2">
                      <tr className="text-left text-dim text-xs">
                        <th className="py-2 pr-2 w-8">
                          <input
                            type="checkbox"
                            className="checkbox"
                            checked={selected.size === selectable.length && selectable.length > 0}
                            onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((m) => m.mint)) : new Set())}
                          />
                        </th>
                        <th className="py-2 pr-4 font-normal">token</th>
                        <th className="py-2 pr-4 font-normal text-right">24h</th>
                        <th className="py-2 pr-4 font-normal text-right">liq</th>
                        <th className="py-2 pr-4 font-normal text-right">mcap</th>
                        <th className="py-2 font-normal text-right">vol 24h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movers.map((m) => (
                        <tr key={m.mint} className="border-t border-line hover:bg-deck2 cursor-pointer" onClick={() => !m.alreadyTracked && toggle(m.mint)}>
                          <td className="py-2.5 pr-2" onClick={(e) => e.stopPropagation()}>
                            {m.alreadyTracked ? (
                              <span className="text-dim text-xs" title="Already tracked">✓</span>
                            ) : (
                              <input type="checkbox" className="checkbox" checked={selected.has(m.mint)} onChange={() => toggle(m.mint)} />
                            )}
                          </td>
                          <td className="py-2.5 pr-4">
                            <span className="inline-flex items-center gap-2">
                              {m.symbol && <TokenName mint={m.mint} symbol={m.symbol} />}
                              <Addr address={m.mint} kind="token" />
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-right text-profit font-bold">+{m.pumpH24Pct.toLocaleString('en-US')}%</td>
                          <td className="py-2.5 pr-4 text-right text-dim">{fmtUsd(m.liquidityUsd)}</td>
                          <td className="py-2.5 pr-4 text-right text-dim">{fmtUsd(m.marketCapUsd)}</td>
                          <td className="py-2.5 text-right text-dim">{fmtUsd(m.volumeH24Usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
                <span className="text-xs text-dim">After importing: deep-scan each from Discover to absorb its quality buyers.</span>
                <button className="btn" disabled={selected.size === 0 || importTokens.isPending} onClick={doImport}>
                  {importTokens.isPending ? 'Importing…' : `Import ${selected.size || ''}`}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
