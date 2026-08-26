import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useCheckToken, useImportTokens, useTokens, useUntrackToken } from '../api';
import { Addr } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { STATUS_STYLE } from '../components/TokenReportView';
import { fmtAgo } from '../lib/format';

const SOL_ADDR_G = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const fmtUsd = (n: number | null) => (n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);

export function Tokens() {
  const { data: tokens = [] } = useTokens();
  const importTokens = useImportTokens();
  const checkToken = useCheckToken();
  const untrack = useUntrackToken();
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  const doImport = () => {
    setParseError(null);
    const mints = [...new Set(raw.match(SOL_ADDR_G) ?? [])];
    if (!mints.length) {
      setParseError('No Solana addresses found in that input.');
      return;
    }
    importTokens.mutate({ mints, source: source || undefined }, { onSuccess: () => setRaw('') });
  };

  const runCheck = async (mint: string) => {
    setChecking(mint);
    await checkToken.mutateAsync(mint).catch(() => undefined);
    setChecking(null);
  };

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-bright tracking-wide">Tokens</h1>
        <p className="text-sm text-dim mt-1">Tracked tokens — anything checked, imported, or worth keeping an eye on.</p>
      </div>

      <div className="panel p-4 flex flex-col gap-3">
        <span className="eyebrow">Import</span>
        <textarea
          rows={3}
          placeholder="Paste mints — JSON, list, or free text all work"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          className="w-full resize-y"
        />
        <div className="flex flex-wrap items-center gap-3">
          <input placeholder="source tag" value={source} onChange={(e) => setSource(e.target.value)} className="w-56" />
          <button className="btn" disabled={!raw.trim() || importTokens.isPending} onClick={doImport}>
            {importTokens.isPending ? 'Importing…' : 'Import'}
          </button>
          {importTokens.isSuccess && (
            <span className="text-xs text-profit">
              Added {importTokens.data.imported}{importTokens.data.skipped ? `, ${importTokens.data.skipped} already tracked` : ''}.
            </span>
          )}
        </div>
        {parseError && <p className="text-xs text-loss">{parseError}</p>}
      </div>

      <div className="panel">
        <div className="px-4 pt-4 pb-2 eyebrow">Tracked · {tokens.length}</div>
        {tokens.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dim">Nothing tracked yet — import above, or run a check anywhere (gems, token check) and it lands here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-mono">
              <thead>
                <tr className="text-left text-dim text-xs">
                  <th className="pl-4 pr-0 py-2 w-8"></th>
                  <th className="px-4 py-2 font-normal">token</th>
                  <th className="px-4 py-2 font-normal">verdict</th>
                  <th className="px-4 py-2 font-normal text-right">liq</th>
                  <th className="px-4 py-2 font-normal text-right">mcap</th>
                  <th className="px-4 py-2 font-normal">checked</th>
                  <th className="px-4 py-2 font-normal">source</th>
                  <th className="px-4 py-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.mint} className="border-t border-line hover:bg-deck2">
                    <td className="pl-4 pr-0 py-2">
                      <Link to="/tokens/$mint" params={{ mint: t.mint }} title="Open token detail" className="text-dim hover:text-neon inline-flex">
                        <EyeIcon />
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        {t.symbol && <span className="text-bright font-semibold">{t.symbol}</span>}
                        <Addr address={t.mint} kind="token" />
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {t.verdict ? (
                        <span className={`font-bold text-xs ${STATUS_STYLE[t.verdict].text}`}>{STATUS_STYLE[t.verdict].label}</span>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-dim">{fmtUsd(t.liquidityUsd)}</td>
                    <td className="px-4 py-2 text-right text-dim">{fmtUsd(t.marketCapUsd)}</td>
                    <td className="px-4 py-2 text-dim" title={t.lastCheckedAt ?? ''}>{fmtAgo(t.lastCheckedAt)}</td>
                    <td className="px-4 py-2 text-dim text-xs">{t.source ?? '—'}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      <button className="btn mr-2 py-1! px-2! text-[0.6rem]!" disabled={checking === t.mint} onClick={() => runCheck(t.mint)}>
                        {checking === t.mint ? '…' : t.verdict ? 're-check' : 'check'}
                      </button>
                      <button className="text-xs text-dim hover:text-loss" title="Stop tracking" onClick={() => untrack.mutate(t.mint)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
