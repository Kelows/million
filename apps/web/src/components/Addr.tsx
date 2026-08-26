import { useState } from 'react';
import { truncAddr } from '../lib/format';

export type AddrKind = 'wallet' | 'token';

/** Wallet profiles open in GMGN (PnL/smart-money view); tokens and txs open in Solscan. */
export function explorerUrl(kind: AddrKind, address: string): string {
  return kind === 'token' ? `https://solscan.io/token/${address}` : `https://gmgn.ai/sol/address/${address}`;
}

export function classicUrl(kind: AddrKind, address: string): string {
  return kind === 'token' ? `https://dexscreener.com/solana/${address}` : `https://solscan.io/account/${address}`;
}

export function Addr({ address, full = false, kind = 'wallet' }: { address: string; full?: boolean; kind?: AddrKind }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <button
        type="button"
        className="font-mono text-neon hover:underline cursor-pointer"
        title={copied ? 'Copied' : `${address} — click to copy`}
        onClick={() => {
          navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {full ? address : truncAddr(address)}
        {copied && <span className="text-dim ml-1 text-[0.6rem]">copied</span>}
      </button>
      {kind === 'wallet' && (
        <a
          href={explorerUrl(kind, address)}
          target="_blank"
          rel="noopener noreferrer"
          title="Open wallet in GMGN"
          className="text-dim hover:text-neon text-xs leading-none"
        >
          ↗
        </a>
      )}
    </span>
  );
}
