import { classicUrl } from './Addr';

/** A token's symbol, clickable everywhere: opens the DexScreener chart. */
export function TokenName({ mint, symbol }: { mint: string; symbol: string | null }) {
  if (!symbol) return null;
  return (
    <a
      href={classicUrl('token', mint)}
      target="_blank"
      rel="noopener noreferrer"
      title="Open chart on DexScreener"
      className="text-bright font-semibold hover:text-neon hover:underline"
    >
      {symbol}
    </a>
  );
}
