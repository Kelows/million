import { DEFAULT_MIN_OPEN_SOL } from '@million/shared';

const KEY = 'million.minOpenSol';

/** Minimum entry cost (SOL) for a position to count as "open" in counts and filters. */
export function loadMinOpenSol(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_OPEN_SOL;
  } catch {
    return DEFAULT_MIN_OPEN_SOL;
  }
}

export function saveMinOpenSol(n: number): void {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* per-viewer convenience only */
  }
}
