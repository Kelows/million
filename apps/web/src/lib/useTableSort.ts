import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortColumn<T> {
  key: string;
  get: (row: T) => number | string | null;
}

/** Client-side column sorting. Null values always sort last regardless of direction. */
export function useTableSort<T>(rows: T[], columns: SortColumn<T>[], initialKey?: string, initialDir: SortDir = 'desc') {
  const [sortKey, setSortKey] = useState<string | null>(initialKey ?? null);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const toggle = (key: string) => {
    if (key !== sortKey) {
      setSortKey(key);
      setDir('desc');
      return;
    }
    setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
  };

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;
    const mul = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.get(a);
      const bv = col.get(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * mul;
      return (av - bv) * mul;
    });
  }, [rows, columns, sortKey, dir]);

  return { sortKey, dir, toggle, sorted };
}
