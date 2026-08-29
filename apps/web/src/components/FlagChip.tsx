import type { WalletFlag } from '@million/shared';

const FLAG_INFO: Record<WalletFlag, { label: string; title: string; warn: boolean }> = {
  FRESH_WALLET: { label: 'fresh', title: 'First activity under 7 days ago', warn: true },
  SNIPER_SPEED: { label: 'sniper', title: 'Median hold under 5 min — uncopyable manually', warn: true },
  HIGH_WINRATE_SUS: { label: 'sus winrate', title: '>90% win rate over 20+ tokens — possibly farmed for copy-traders', warn: true },
  LOW_ACTIVITY: { label: 'low data', title: 'Fewer than 5 closed trades — stats not trustworthy yet', warn: false },
  DORMANT: { label: 'dormant', title: 'No swaps in the last 14 days', warn: false },
  UNBACKED_HISTORY: { label: 'unbacked', title: 'Most of this wallet\u2019s apparent profit comes from selling tokens we never saw it buy \u2014 its buy history predates our analysis window. Those sales have no cost basis, so they are cash, not measured profit. Treat the PnL and the score as unreliable until a deeper analysis backfills the buys.', warn: true },
  DISTRIBUTOR: { label: 'distributor', title: 'Sells vastly exceed buys — an early holder exiting a bag acquired elsewhere. The PnL is real but the strategy is uncopyable; cadence acceleration is a sell signal for the token.', warn: true },
  BOT_INFRA: { label: 'infra', title: 'Automated infrastructure (broker/volume/MEV), not a trader — stats meaningless, excluded from recs', warn: true },
};

/** All flags as selectable filter options, labels matching the chips. */
export const FLAG_OPTIONS = (Object.keys(FLAG_INFO) as WalletFlag[]).map((value) => ({
  value,
  label: FLAG_INFO[value].label,
}));

export function FlagChip({ flag, size = 'sm' }: { flag: WalletFlag; size?: 'sm' | 'md' }) {
  const info = FLAG_INFO[flag] ?? { label: flag.toLowerCase(), title: flag, warn: false };
  return (
    <span
      title={info.title}
      className={`inline-block font-semibold uppercase tracking-wider border ${
        size === 'md' ? 'px-2 py-1 text-[0.7rem]' : 'px-1.5 py-0.5 text-[0.6rem]'
      } ${info.warn ? 'border-warn text-warn' : 'border-line text-dim'}`}
    >
      {info.label}
    </span>
  );
}
