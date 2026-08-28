import { Link, useParams } from '@tanstack/react-router';
import { useCheckToken, useTokenDetail } from '../api';
import { Addr, classicUrl } from '../components/Addr';
import { EyeIcon } from '../components/icons';
import { TokenReportView } from '../components/TokenReportView';
import { fmtAgo, fmtSol, truncAddr } from '../lib/format';

export function TokenDetail() {
  const { mint } = useParams({ from: '/tokens/$mint' });
  const { data, isLoading, error } = useTokenDetail(mint);
  const check = useCheckToken();

  if (isLoading) return <p className="text-dim text-sm">Loading…</p>;
  if (error || !data) {
    return (
      <div className="panel p-6 max-w-xl">
        <p className="text-loss text-sm">{error?.message ?? 'Token not found.'}</p>
        <Link to="/tokens" className="text-neon text-sm hover:underline mt-2 inline-block">← back to tokens</Link>
      </div>
    );
  }

  const { token, report, intel } = data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link to="/tokens" className="text-xs text-dim hover:text-ink">← tokens</Link>
          <h1 className="text-xl font-bold text-bright tracking-wide mt-1">
            {token.symbol ?? truncAddr(token.mint)}
            {token.name && <span className="text-dim font-normal text-base ml-2">{token.name}</span>}
          </h1>
          <div className="mt-1 text-sm"><Addr address={token.mint} kind="token" full /></div>
          <div className="mt-1 flex gap-3 text-xs">
            <a href={classicUrl('token', token.mint)} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">DexScreener ↗</a>
            <a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-neon">Solscan ↗</a>
            <Link to="/discover" search={{ mint: token.mint }} className="text-neon hover:underline">find whales →</Link>
          </div>
        </div>
        <div className="text-right">
          <button className="btn" disabled={check.isPending} onClick={() => check.mutate(mint)}>
            {check.isPending ? 'Running gauntlet…' : report ? 'Re-check' : 'Check'}
          </button>
          <div className="text-xs text-dim mt-2" title={token.lastCheckedAt ?? ''}>last check {fmtAgo(token.lastCheckedAt)}</div>
        </div>
      </div>
      {check.error && <p className="text-xs text-loss">{check.error.message}</p>}

      {report ? (
        <TokenReportView report={report} />
      ) : (
        <div className="panel p-8 text-center">
          {check.isPending ? (
            <p className="text-sm text-dim">Running the gauntlet…</p>
          ) : (
            <>
              <div className="text-bright font-semibold">Not checked yet</div>
              <p className="text-sm text-dim mt-2 mb-4">Run the gauntlet — authorities, liquidity, LP lock, holders, deployer, on-chain sell simulation.</p>
              <button className="btn" onClick={() => check.mutate(mint)}>Run the gauntlet</button>
            </>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <IntelTable title={`Roster holders · ${intel.holders.length}`} empty="No tracked wallet holds this open.">
          {intel.holders.map((h) => (
            <tr key={h.address} className="border-t border-line hover:bg-deck2">
              <td className="pl-4 pr-0 py-2 w-8">
                <Link to="/wallets/$address" params={{ address: h.address }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
              </td>
              <td className="px-4 py-2">{h.label ?? <Addr address={h.address} />}</td>
              <td className="px-4 py-2 text-right text-warn">{h.entrySol !== null ? `${h.entrySol.toFixed(1)} ◎ still in` : '—'}</td>
            </tr>
          ))}
        </IntelTable>
        <IntelTable title={`Roster traders · ${intel.traders.length}`} empty="No tracked wallet has closed this.">
          {intel.traders.map((t) => (
            <tr key={t.address} className="border-t border-line hover:bg-deck2">
              <td className="pl-4 pr-0 py-2 w-8">
                <Link to="/wallets/$address" params={{ address: t.address }} className="text-dim hover:text-neon inline-flex"><EyeIcon /></Link>
              </td>
              <td className="px-4 py-2">{t.label ?? <Addr address={t.address} />}</td>
              <td className={`px-4 py-2 text-right ${t.realizedPnlSol >= 0 ? 'text-profit' : 'text-loss'}`}>{fmtSol(t.realizedPnlSol)}</td>
            </tr>
          ))}
        </IntelTable>
      </div>
    </div>
  );
}

function IntelTable({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="panel">
      <div className="px-4 pt-4 pb-2 eyebrow">{title}</div>
      {children.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-dim">{empty}</p>
      ) : (
        <table className="w-full text-sm font-mono"><tbody>{children}</tbody></table>
      )}
    </div>
  );
}
