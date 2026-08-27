import type { TokenCheckThresholds } from '@million/shared';

interface FieldDef {
  key: keyof TokenCheckThresholds;
  label: string;
  hint: string;
  step: number;
}

const FIELDS: FieldDef[] = [
  { key: 'minLiquidityUsd', label: 'Minimum liquidity (USD)', hint: 'thin pools = you are the exit liquidity', step: 10_000 },
  { key: 'minMarketCapUsd', label: 'Minimum market cap (USD)', hint: 'filters the sub-graduation churn (98%+ die)', step: 25_000 },
  { key: 'maxTop10Pct', label: 'Max top-10 holders (%)', hint: 'LP vaults excluded from the math', step: 5 },
  { key: 'minTokenAgeMinutes', label: 'Minimum pair age (minutes)', hint: 'most rugs happen in the first hour', step: 15 },
];

/** The gauntlet's size/maturity knobs — one editor shared by Screener (local) and Crawler (server config). */
export function ThresholdFields({
  value,
  onChange,
}: {
  value: TokenCheckThresholds;
  onChange: (next: TokenCheckThresholds) => void;
}) {
  return (
    <>
      {FIELDS.map((field) => (
        <label key={field.key} className="flex items-center justify-between gap-4 text-sm">
          <span>
            {field.label}
            <span className="block text-xs text-dim">{field.hint}</span>
          </span>
          <input
            type="number"
            min={0}
            step={field.step}
            value={value[field.key]}
            onChange={(e) => onChange({ ...value, [field.key]: Number(e.target.value) })}
            className="w-36 text-right"
          />
        </label>
      ))}
    </>
  );
}
