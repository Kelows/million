import { useState } from 'react';

export type FilterType = 'min' | 'max' | 'toggle' | 'multi';

export interface FilterField<T> {
  key: string;
  label: string;
  type: FilterType;
  unit?: string; // shown next to number inputs
  options?: { value: string; label: string }[]; // for multi: the selectable tags
  get: (row: T) => number | boolean | string[] | null;
}

/** Active filters only — an absent key means "not filtering on this". */
export type FilterState = Record<string, number | boolean | string[]>;

export function applyFilters<T>(rows: T[], fields: FilterField<T>[], state: FilterState): T[] {
  const active = fields.filter((f) => state[f.key] !== undefined);
  if (!active.length) return rows;
  return rows.filter((row) =>
    active.every((f) => {
      const value = f.get(row);
      if (f.type === 'toggle') return value === true;
      if (f.type === 'multi') {
        const excluded = state[f.key];
        if (!Array.isArray(excluded) || excluded.length === 0) return true;
        const tags = Array.isArray(value) ? value : [];
        return !tags.some((tag) => excluded.includes(tag));
      }
      if (value === null || typeof value !== 'number') return false;
      const threshold = state[f.key] as number;
      return f.type === 'min' ? value >= threshold : value <= threshold;
    }),
  );
}

/** Filter state persisted per table. */
export function useStoredFilters(storageKey: string): [FilterState, (next: FilterState) => void] {
  const [state, setState] = useState<FilterState>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as FilterState) : {};
    } catch {
      return {};
    }
  });
  const update = (next: FilterState) => {
    setState(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* per-viewer convenience only */
    }
  };
  return [state, update];
}
