const STORAGE_KEY = 'million.subscriptions';

/** Mock-only for now: remembers intent locally until the live feed + failsafe pipeline exists. */
export function loadSubscriptions(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveSubscriptions(subs: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...subs]));
  } catch {
    /* per-viewer convenience only */
  }
}
