import { useState } from 'react';
import type { FilterField, FilterState } from '../lib/useTableFilters';

interface FilterModalProps<T> {
  fields: FilterField<T>[];
  state: FilterState;
  onChange: (next: FilterState) => void;
}

/** "Filters (n)" button + modal. Generic over the row type; wire it above any table. */
export function FilterModal<T>({ fields, state, onChange }: FilterModalProps<T>) {
  const [open, setOpen] = useState(false);
  const activeCount = Object.keys(state).length;

  const setField = (key: string, value: number | boolean | undefined) => {
    const next = { ...state };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <>
      <button type="button" className="btn py-1! px-2! text-[0.6rem]!" onClick={() => setOpen(true)}>
        Filters{activeCount > 0 && ` (${activeCount})`}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <div
            className="panel panel-raised w-96 max-w-full p-5 flex flex-col gap-4"
            role="dialog"
            aria-label="Table filters"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="eyebrow">Filters</span>
              <button type="button" className="text-dim hover:text-ink text-sm" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            {fields.map((field) =>
              field.type === 'toggle' ? (
                <label key={field.key} className="flex items-center gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 p-0!"
                    style={{ accentColor: 'var(--color-neon)' }}
                    checked={state[field.key] === true}
                    onChange={(e) => setField(field.key, e.target.checked ? true : undefined)}
                  />
                  {field.label}
                </label>
              ) : (
                <label key={field.key} className="flex items-center justify-between gap-4 text-sm">
                  <span>
                    {field.label}
                    <span className="block text-xs text-dim">{field.type === 'min' ? 'at least' : 'at most'}{field.unit ? ` · ${field.unit}` : ''}</span>
                  </span>
                  <input
                    type="number"
                    className="w-28 text-right"
                    placeholder="—"
                    value={typeof state[field.key] === 'number' ? (state[field.key] as number) : ''}
                    onChange={(e) => setField(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
                  />
                </label>
              ),
            )}
            <div className="flex justify-between items-center mt-2">
              <button type="button" className="text-xs text-dim hover:text-loss" onClick={() => onChange({})}>
                Clear all
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
