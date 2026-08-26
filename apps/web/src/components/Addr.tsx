import { useState } from 'react';
import { truncAddr } from '../lib/format';

export function Addr({ address, full = false }: { address: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
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
  );
}
