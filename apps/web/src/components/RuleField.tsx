import type { ReactNode } from 'react';
import { Info } from './Info';

/** One setting: label, explanation, control — laid out so a long list stays scannable. */
export function RuleField({ label, hint, children, off }: { label: string; hint: string; children: ReactNode; off?: boolean }) {
  return (
    <label className={`flex items-baseline justify-between gap-4 py-2 border-b border-line/50 last:border-0 ${off ? 'opacity-45' : ''}`}>
      <span className="text-sm text-dim min-w-0">
        {label}
        <Info text={hint} />
      </span>
      <span className="shrink-0 flex items-center gap-1.5">{children}</span>
    </label>
  );
}

export function RuleSection({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="panel p-4 flex flex-col">
      <div className="eyebrow">{title}</div>
      <p className="text-xs text-dim mt-1 mb-2">{subtitle}</p>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

export function Num({ value, onChange, min, max, step = 1, suffix, width = 'w-20' }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; suffix?: string; width?: string;
}) {
  return (
    <>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} className={`${width} text-right`} />
      {suffix && <span className="text-xs text-dim">{suffix}</span>}
    </>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (b: boolean) => void }) {
  return <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />;
}

export function Choice<T extends string>({ value, options, onChange, labels }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Record<string, string>;
}) {
  return (
    <span className="flex gap-1">
      {options.map((o) => (
        <button key={o} type="button" className={`btn py-1! px-2! text-[0.62rem]! ${value === o ? '' : 'opacity-45'}`} onClick={() => onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </span>
  );
}
