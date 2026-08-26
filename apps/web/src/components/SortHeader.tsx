import type { SortDir } from '../lib/useTableSort';

interface SortHeaderProps {
  label: string;
  colKey: string;
  sortKey: string | null;
  dir: SortDir;
  onToggle: (key: string) => void;
  right?: boolean;
}

export function SortHeader({ label, colKey, sortKey, dir, onToggle, right }: SortHeaderProps) {
  const active = sortKey === colKey;
  return (
    <th className={`px-4 py-2 font-normal ${right ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={() => onToggle(colKey)} className={`cursor-pointer hover:text-ink ${active ? 'text-neon' : ''}`}>
        {label}
        <span className="ml-1 text-[0.55rem]">{active ? (dir === 'desc' ? '▼' : '▲') : '⇅'}</span>
      </button>
    </th>
  );
}
