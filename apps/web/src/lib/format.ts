export function truncAddr(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Signed SOL amount — sign is always explicit so profit/loss is never color-alone. */
export function fmtSol(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })} SOL`;
}

export function fmtPct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function fmtHold(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
