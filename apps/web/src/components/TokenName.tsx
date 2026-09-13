import { Link } from '@tanstack/react-router';
import { truncAddr } from '../lib/format';
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

/**
 * A token as a link to its page in the deck. Never empty: a token with no known
 * symbol shows its short address instead. Not built on TokenName — that renders
 * its own <a>, and an anchor inside an anchor sends the click to DexScreener.
 */
export function TokenLink({ mint, symbol }: { mint: string; symbol: string | null | undefined }) {
  return (
    <Link to="/tokens/$mint" params={{ mint }} title={mint} className="text-neon hover:underline">
      {symbol ? <span className="font-semibold">{symbol}</span> : <span className="font-mono">{truncAddr(mint)}</span>}
    </Link>
  );
}
