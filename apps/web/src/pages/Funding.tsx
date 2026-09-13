import { useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { whaleScore as sharedWhaleScore, type FundingLink } from '@million/shared';
import { useFundingChains, useImportWallets } from '../api';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { fmtAgo, fmtPct, fmtSol, truncAddr } from '../lib/format';
import { usePagination } from '../lib/usePagination';
import { Pagination } from '../components/Pagination';

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function linkScore(l: FundingLink): { na: boolean; score: number | null } {
  if (!l.preview) return { na: false, score: null };
  if ((l.flags ?? []).some((f) => f === 'BOT_INFRA' || f === 'HIGH_WINRATE_SUS')) return { na: true, score: null };
  return { na: false, score: null }; // previews are historical — unscored until observed
}
const DEFAULT_MIN_SOL = 0.5;

export function Funding() {
  const { address: addressParam } = getRouteApi('/funding').useSearch();
  const initial = addressParam && SOL_ADDR.test(addressParam) ? addressParam : null;
  // the last trace is remembered across navigation; an explicit link wins
  const remembered = (() => {
    try {
      const raw = sessionStorage.getItem('million.funding.last');
      return raw ? (JSON.parse(raw) as { address: string; minSol: number }) : null;
    } catch {
      return null;
    }
  })();
  const [input, setInput] = useState(initial ?? remembered?.address ?? '');
  const [address, setAddressRaw] = useState<string | null>(initial ?? remembered?.address ?? null);
  const [minSol, setMinSol] = useState(remembered?.minSol ?? DEFAULT_MIN_SOL);
  const setAddress = (a: string | null) => {
    setAddressRaw(a);
    try {
      if (a) sessionStorage.setItem('million.funding.last', JSON.stringify({ address: a, minSol }));
    } catch { /* convenience only */ }
  };
  const [inputError, setInputError] = useState<string | null>(null);
  const { data: report, isFetching, error } = useFundingChains(address, minSol);
  const importWallets = useImportWallets();
  const navigate = useNavigate();

  const chainInto = (a: string) => {
    setInput(a);
    setAddress(a);
    navigate({ to: '/funding', search: { address: a } });
  };

  const submit = () => {
    const candidate = input.trim();
    if (!SOL_ADDR.test(candidate)) {
      setInputError('That is not a valid Solana address.');
      return;
    }
    setInputError(null);
    setAddress(candidate);
  };

  const addToRoster = (addresses: string[]) => {
    if (!addresses.length) return;
    importWallets.mutate({ wallets: addresses, source: `funding:${address ? truncAddr(address) : 'manual'}` });
  };

  const outLinks = report?.links.filter((l) => l.direction === 'out') ?? [];
  const inLinks = report?.links.filter((l) => l.direction === 'in') ?? [];
  const addableOut = outLinks.filter((l) => !l.inRoster).map((l) => l.address);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Funding chains</h1>
        <p className="text-sm text-dim mt-1">
          A known whale funding a wallet is often the same actor on a new address. Top counterparties get a quick swap
          analysis — a heuristic from their last 100 swaps, not a full read. Exchange deposit addresses can appear, so
          judge before adding.
        </p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <div className="flex gap-3 flex-wrap">
          <input
            placeholder="wallet address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="flex-1 min-w-64"
          />
          <label className="flex items-center gap-2 text-xs text-dim">
            min SOL
            <input
              type="number"
              min={0}
              step={0.1}
              value={minSol}
              onChange={(e) => setMinSol(Number(e.target.value))}
              className="w-20 text-right"
            />
          </label>
          <button className="btn" disabled={!input.trim() || isFetching} onClick={submit}>
            {isFetching ? 'Tracing…' : 'Trace'}
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
          <FundingTable
            title={`Funded by this wallet · ${outLinks.length}`}
            hint="Possible new addresses of the same trader."
            links={outLinks}
            action={
              addableOut.length > 1 ? (
                <button className="btn py-1! px-2! text-[0.6rem]!" disabled={importWallets.isPending} onClick={() => addToRoster(addableOut)}>
                  add all ({addableOut.length})
                </button>
              ) : null
            }
            onAdd={(a) => addToRoster([a])}
            onChain={chainInto}
            adding={importWallets.isPending}
          />
          <FundingTable
            title={`Funded this wallet · ${inLinks.length}`}
            hint="Who funds them, possibly their older address."
            links={inLinks}
            action={null}
            onAdd={(a) => addToRoster([a])}
            onChain={chainInto}
            adding={importWallets.isPending}
          />
          <p className="text-xs text-dim">
            {report.analyzedTxCount} transfer txs analyzed{report.truncated ? ' (truncated — most recent only)' : ''} ·
            min {report.minSol} SOL · swap stats are a heuristic (last 100 swaps, top counterparties only; '—' = beyond
            the cap) · fetched {fmtAgo(report.fetchedAt)}
          </p>
        </>
      )}
    </div>
  );
}

function FundingTable({
  title,
  hint,
  links,
  action,
  onAdd,
  onChain,
  adding,
}: {
  title: string;
  hint: string;
  links: FundingLink[];
  action: React.ReactNode;
  onAdd: (address: string) => void;
  onChain: (address: string) => void;
  adding: boolean;
}) {
  const pag = usePagination(links, 15);
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-4">
        <span className="eyebrow">{title} <span className="normal-case tracking-normal">· {hint}</span></span>
        {action}
      </div>
      {links.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">Nothing above the SOL threshold.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-left text-dim text-xs">
                <th className="pl-4 pr-0 py-2 w-8"></th>
                <th className="px-4 py-2 font-normal">wallet</th>
                <th className="px-4 py-2 font-normal text-right">total SOL</th>
                <th className="px-4 py-2 font-normal">transfers</th>
                <th className="px-4 py-2 font-normal">score</th>
                <th className="px-4 py-2 font-normal">swaps</th>
                <th className="px-4 py-2 font-normal">WR</th>
                <th className="px-4 py-2 font-normal text-right">PnL</th>
                <th className="px-4 py-2 font-normal">active</th>
                <th className="px-4 py-2 font-normal">first</th>
                <th className="px-4 py-2 font-normal">last</th>
                <th className="px-4 py-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {pag.rows.map((l) => (
                <tr key={`${l.direction}:${l.address}`} className="border-t border-line hover:bg-deck2">
                  <td className="pl-4 pr-0 py-2">
                    <Link
                      to="/wallets/$address"
                      params={{ address: l.address }}
                      title="Open wallet detail (auto-analyzes if unknown)"
                      className="text-dim hover:text-neon inline-flex"
                    >
                      <EyeIcon />
                    </Link>
                  </td>
                  <td className="px-4 py-2"><Addr address={l.address} /></td>
                  <td className="px-4 py-2 text-right text-bright">{l.totalSol.toLocaleString('en-US')}</td>
                  <td className="px-4 py-2 text-dim">{l.transfers}</td>
                  <td className="px-4 py-2">
                    {(() => {
                      const { na, score } = linkScore(l);
                      if (na) return <span className="text-dim" title="Bot-flagged — not scored">N/A</span>;
                      if (score === null) return <span className="text-dim">—</span>;
                      return <span className={`font-bold ${score >= 50 ? 'text-profit' : score >= 0 ? 'text-ink' : 'text-loss'}`}>{score}</span>;
                    })()}
                  </td>
                  <td className="px-4 py-2 text-dim">{l.preview ? l.preview.totalSwaps : '—'}</td>
                  <td className="px-4 py-2">{l.preview ? fmtPct(l.preview.winRate) : '—'}</td>
                  <td className={`px-4 py-2 text-right ${l.preview ? (l.preview.realizedPnlSol >= 0 ? 'text-profit' : 'text-loss') : 'text-dim'}`}>
                    {l.preview ? fmtSol(l.preview.realizedPnlSol) : '—'}
                  </td>
                  <td className="px-4 py-2 text-dim">{l.preview ? fmtAgo(l.preview.lastSeen) : '—'}</td>
                  <td className="px-4 py-2 text-dim" title={l.firstAt}>{fmtAgo(l.firstAt)}</td>
                  <td className="px-4 py-2 text-dim" title={l.lastAt}>{fmtAgo(l.lastAt)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      className="btn mr-2 py-1! px-2! text-[0.6rem]!"
                      title="Trace this wallet's funding chains"
                      onClick={() => onChain(l.address)}
                    >
                      chain →
                    </button>
                    {l.inRoster ? (
                      <Link to="/wallets/$address" params={{ address: l.address }} className="text-xs text-dim hover:text-neon">
                        in roster →
                      </Link>
                    ) : (
                      <button className="btn py-1! px-2! text-[0.6rem]!" disabled={adding} onClick={() => onAdd(l.address)}>
                        add
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={pag.page} pageCount={pag.pageCount} from={pag.from} to={pag.to} total={pag.total} onPage={pag.setPage} />
        </div>
      )}
    </div>
  );
}
