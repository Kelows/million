interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'profit' | 'loss';
}

export function StatTile({ label, value, sub, tone = 'default' }: StatTileProps) {
  const toneClass = tone === 'profit' ? 'text-profit' : tone === 'loss' ? 'text-loss' : 'text-bright';
  return (
    <div className="panel p-4">
      <div className="eyebrow">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-2 ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-dim mt-1">{sub}</div>}
    </div>
  );
}
