import type { PaperPositionRow, TradingStats } from '@million/shared';
import { StatTile } from './StatTile';

/** ONE order for the book's vital signs, wherever they appear: Open → Open PnL → Realized → Expectancy → Win rate → Avg trade. */
export function TradingTiles({ stats, open }: { stats: TradingStats; open: PaperPositionRow[] }) {
  const openPnl = Math.round(open.reduce((sum, p) => sum + (p.unrealizedPct != null ? (p.sizeSol * p.unrealizedPct) / 100 : 0), 0) * 1000) / 1000;
  const deployed = open.reduce((t, p) => t + p.sizeSol, 0);
  return (
    // flex, not a rigid grid: every tile keeps its content on one line and the row shares leftover width
    <div className="flex flex-wrap gap-4 *:flex-1 *:basis-40 *:whitespace-nowrap">
      <StatTile label="Open" value={String(stats.openCount)} sub={`${deployed.toFixed(1)} ◎ deployed`} />
      <StatTile
        label="Open PnL"
        value={open.length ? `${openPnl > 0 ? '+' : ''}${openPnl} ◎` : '—'}
        sub="unrealized, mark to market"
        tone={openPnl > 0 ? 'profit' : openPnl < 0 ? 'loss' : 'default'}
      />
      <StatTile
        label="Realized PnL"
        value={`${stats.totalPnlSol > 0 ? '+' : ''}${stats.totalPnlSol} ◎`}
        sub={`${stats.closedCount} closed`}
        tone={stats.totalPnlSol > 0 ? 'profit' : stats.totalPnlSol < 0 ? 'loss' : 'default'}
      />
      <StatTile
        label="Expectancy / trade"
        value={stats.expectancySolPerTrade != null ? `${stats.expectancySolPerTrade > 0 ? '+' : ''}${stats.expectancySolPerTrade} ◎` : '—'}
        sub="the number that unlocks live"
        tone={stats.expectancySolPerTrade != null ? (stats.expectancySolPerTrade > 0 ? 'profit' : 'loss') : 'default'}
        hint="Realized PnL divided by closed trades. Judge it over weeks of trades, not a few days."
      />
      <StatTile label="Win rate" value={stats.winRate != null ? `${Math.round(stats.winRate * 100)}%` : '—'} sub={`${stats.wins} wins`} />
      <StatTile label="Avg trade" value={stats.avgPnlPct != null ? `${stats.avgPnlPct > 0 ? '+' : ''}${stats.avgPnlPct}%` : '—'} sub="mean closed PnL %" />
    </div>
  );
}
