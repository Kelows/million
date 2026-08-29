import { Info } from './Info';

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: 'default' | 'profit' | 'loss';
}

export function StatTile({ label, value, sub, hint, tone = 'default' }: StatTileProps) {
  const toneClass = tone === 'profit' ? 'text-profit' : tone === 'loss' ? 'text-loss' : 'text-bright';
  return (
    <div className="panel p-4">
      <div className="eyebrow">{label}{hint && <Info text={hint} />}</div>
      <div className={`font-mono text-xl xl:text-2xl font-bold mt-2 truncate ${toneClass}`} title={value}>{value}</div>
      {sub && <div className="text-xs text-dim mt-1 truncate" title={sub}>{sub}</div>}
    </div>
  );
}
