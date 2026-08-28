import type { WalletFlag } from '@million/shared';

const FLAG_INFO: Record<WalletFlag, { label: string; title: string; warn: boolean }> = {
  FRESH_WALLET: { label: 'fresh', title: 'First activity under 7 days ago', warn: true },
  SNIPER_SPEED: { label: 'sniper', title: 'Median hold under 5 min — uncopyable manually', warn: true },
  HIGH_WINRATE_SUS: { label: 'sus winrate', title: '>90% win rate over 20+ tokens — possibly farmed for copy-traders', warn: true },
  LOW_ACTIVITY: { label: 'low data', title: 'Fewer than 5 closed trades — stats not trustworthy yet', warn: false },
  DORMANT: { label: 'dormant', title: 'No swaps in the last 14 days', warn: false },
  DISTRIBUTOR: { label: 'distributor', title: 'Sells vastly exceed buys — an early holder exiting a bag acquired elsewhere. The PnL is real but the strategy is uncopyable; cadence acceleration is a sell signal for the token.', warn: true },
  BOT_INFRA: { label: 'infra', title: 'Automated infrastructure (broker/volume/MEV), not a trader — stats meaningless, excluded from recs', warn: true },
};

/** All flags as selectable filter options, labels matching the chips. */
export const FLAG_OPTIONS = (Object.keys(FLAG_INFO) as WalletFlag[]).map((value) => ({
  value,
  label: FLAG_INFO[value].label,
}));

export function FlagChip({ flag }: { flag: WalletFlag }) {
  const info = FLAG_INFO[flag];
  return (
    <span
      title={info.title}
      className={`inline-block px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wider border ${
        info.warn ? 'border-warn text-warn' : 'border-line text-dim'
      }`}
    >
      {info.label}
    </span>
  );
}
