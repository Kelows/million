import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useImportTokens, useMovers } from '../api';
import { Addr } from './Addr';

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US')}`;

/** Find tokens that pumped and import the interesting ones — the blank-state seeder, as a button. */
export function MoversModal() {
  const [open, setOpen] = useState(false);
  const [minPump, setMinPump] = useState(50);
  const [minMcap, setMinMcap] = useState(100_000);
  const [maxMcap, setMaxMcap] = useState(50_000_000);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: movers = [], isFetching, error } = useMovers(open, minPump, minMcap, maxMcap);
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
              className="panel panel-raised w-[42rem] max-w-full max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-4"
              role="dialog"
              aria-label="Find movers"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4">
                <span className="eyebrow">Tokens that pumped · last 24h</span>
                <button type="button" className="text-dim hover:text-ink text-sm" onClick={() => setOpen(false)}>✕</button>
              </div>
              <div className="flex items-center gap-3 text-xs text-dim">
                <label className="flex items-center gap-2">
                  min pump %
                  <input type="number" min={0} step={25} value={minPump} onChange={(e) => setMinPump(Number(e.target.value))} className="w-20 text-right" />
                </label>
                <label className="flex items-center gap-2">
                  mcap $
                  <input type="number" min={0} step={50_000} value={minMcap} onChange={(e) => setMinMcap(Number(e.target.value))} className="w-28 text-right" />
                  –
                  <input type="number" min={0} step={1_000_000} value={maxMcap} onChange={(e) => setMaxMcap(Number(e.target.value))} className="w-32 text-right" />
                </label>
                <span>liq banded $25k–$3M · trending + boosts, ranked by 24h change</span>
              </div>

              {isFetching ? (
                <p className="text-sm text-dim py-6 text-center">Hunting movers… (~20s, external APIs)</p>
              ) : error ? (
                <p className="text-sm text-loss">{error.message}</p>
              ) : movers.length === 0 ? (
                <p className="text-sm text-dim py-6 text-center">No movers above +{minPump}% right now — lower the bar or try later.</p>
              ) : (
                <table className="w-full text-sm font-mono">
                  <thead>
                    <tr className="text-left text-dim text-xs">
                      <th className="py-2 pr-2 w-8">
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 p-0!"
                          style={{ accentColor: 'var(--color-neon)' }}
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
                      <tr key={m.mint} className="border-t border-line">
                        <td className="py-2 pr-2">
                          {m.alreadyTracked ? (
                            <span className="text-dim text-xs" title="Already tracked">✓</span>
                          ) : (
                            <input
                              type="checkbox"
                              className="w-3.5 h-3.5 p-0!"
                              style={{ accentColor: 'var(--color-neon)' }}
                              checked={selected.has(m.mint)}
                              onChange={() => toggle(m.mint)}
                            />
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <span className="inline-flex items-center gap-2">
                            {m.symbol && <span className="text-bright font-semibold">{m.symbol}</span>}
                            <Addr address={m.mint} kind="token" />
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right text-profit font-bold">+{m.pumpH24Pct.toLocaleString('en-US')}%</td>
                        <td className="py-2 pr-4 text-right text-dim">{fmtUsd(m.liquidityUsd)}</td>
                        <td className="py-2 pr-4 text-right text-dim">{fmtUsd(m.marketCapUsd)}</td>
                        <td className="py-2 text-right text-dim">{fmtUsd(m.volumeH24Usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-dim">
                  After importing: deep-scan each from its detail page (or Discover) to absorb its quality buyers.
                </span>
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
