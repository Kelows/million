import { Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OpportunityConfigSchema, type OpportunityConfig, type PaperPositionRow, type TradingStats } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { TRADE_EXECUTOR, type TradeExecutor } from './executor.interface';

const TICK_MS = 60_000;

/**
 * The strategy engine: opens a position per opportunity, monitors TP/SL/timeout
 * every minute, records fills and PnL. Executor-agnostic — it never knows
 * whether fills are simulated or real. Paper stats produced here are the gate
 * that will (or won't) unlock live auto-trade.
 */
@Injectable()
export class TradingService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRADE_EXECUTOR) private readonly executor: TradeExecutor,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async config(): Promise<OpportunityConfig> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
  }

  /** Called for every new opportunity — the feed that drives everything. */
  async openFromOpportunity(mint: string, symbol: string | null, wallet: string): Promise<void> {
    const config = await this.config();
    if (!config.paperEnabled || config.positionSol <= 0) return;
    const openCount = await this.prisma.paperPosition.count({ where: { status: 'open' } });
    if (openCount >= config.maxOpenPositions) return;
    const dupe = await this.prisma.paperPosition.findFirst({ where: { mint, status: 'open' } });
    if (dupe) return;
    const fill = await this.executor.buy(mint, config.positionSol);
    if (!fill) return;
    await this.prisma.paperPosition.create({
      data: { mint, symbol, wallet, sizeSol: config.positionSol, entryPriceUsd: fill.priceUsd, mode: this.executor.mode },
    });
  }

  /** Mirror exits: the wallet that triggered the position just sold this mint. */
  async onTriggerSell(wallet: string, mint: string): Promise<void> {
    const config = await this.config();
    if (config.exitMode !== 'mirror') return;
    const positions = await this.prisma.paperPosition.findMany({ where: { status: 'open', mint, wallet } });
    for (const p of positions) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'mirror');
  }

  /** The monitor. Rules mode: TP/SL/timeout. Mirror mode: the whale is the TP; SL and timeout stay as brakes. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const open = await this.prisma.paperPosition.findMany({ where: { status: 'open' } });
      if (!open.length) return;
      const config = await this.config();
      for (const p of open) {
        const price = await this.executor.quote(p.mint);
        if (price === null) {
          // unquotable = likely dead pool; close at total loss rather than pretend
          if (Date.now() - p.openedAt.getTime() > 3_600_000) await this.close(p.id, 'dead', 0);
          continue;
        }
        const changePct = (price / p.entryPriceUsd - 1) * 100;
        if (config.exitMode !== 'mirror' && changePct >= config.takeProfitPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'tp');
        else if (changePct <= -config.stopLossPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'sl');
        else if (Date.now() - p.openedAt.getTime() > config.maxHoldHours * 3_600_000)
          await this.closeWithFill(p.id, p.mint, p.sizeSol, 'timeout');
      }
    } finally {
      this.ticking = false;
    }
  }

  private async closeWithFill(id: number, mint: string, sizeSol: number, reason: string): Promise<void> {
    const fill = await this.executor.sell(mint, sizeSol);
    if (!fill) return; // retry next tick
    await this.close(id, reason, fill.priceUsd);
  }

  private async close(id: number, reason: string, exitPriceUsd: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') return;
    const pnlPct = p.entryPriceUsd > 0 ? (exitPriceUsd / p.entryPriceUsd - 1) * 100 : -100;
    await this.prisma.paperPosition.update({
      where: { id },
      data: {
        status: 'closed',
        exitPriceUsd,
        exitReason: reason,
        closedAt: new Date(),
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
      },
    });
  }

  async closeManual(id: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') throw new NotFoundException('no such open position');
    await this.closeWithFill(p.id, p.mint, p.sizeSol, 'manual');
  }

  async overview(): Promise<{ stats: TradingStats; open: PaperPositionRow[]; closed: PaperPositionRow[] }> {
    const rows = await this.prisma.paperPosition.findMany({ orderBy: { id: 'desc' }, take: 300 });
    const open: PaperPositionRow[] = [];
    const closed: PaperPositionRow[] = [];
    for (const p of rows) {
      const row: PaperPositionRow = {
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        wallet: p.wallet,
        sizeSol: p.sizeSol,
        entryPriceUsd: p.entryPriceUsd,
        openedAt: p.openedAt.toISOString(),
        status: p.status as 'open' | 'closed',
        exitPriceUsd: p.exitPriceUsd,
        exitReason: p.exitReason,
        closedAt: p.closedAt?.toISOString() ?? null,
        pnlSol: p.pnlSol,
        pnlPct: p.pnlPct,
        mode: p.mode,
      };
      if (p.status === 'open') {
        const price = await this.executor.quote(p.mint).catch(() => null);
        row.currentPriceUsd = price;
        row.unrealizedPct = price !== null && p.entryPriceUsd > 0 ? Math.round((price / p.entryPriceUsd - 1) * 10000) / 100 : null;
        open.push(row);
      } else closed.push(row);
    }
    const wins = closed.filter((c) => (c.pnlSol ?? 0) > 0).length;
    const totalPnlSol = closed.reduce((s, c) => s + (c.pnlSol ?? 0), 0);
    const avgPnlPct = closed.length ? closed.reduce((s, c) => s + (c.pnlPct ?? 0), 0) / closed.length : null;
    return {
      stats: {
        mode: this.executor.mode,
        openCount: open.length,
        closedCount: closed.length,
        wins,
        winRate: closed.length ? Math.round((wins / closed.length) * 100) / 100 : null,
        totalPnlSol: Math.round(totalPnlSol * 1000) / 1000,
        avgPnlPct: avgPnlPct !== null ? Math.round(avgPnlPct * 100) / 100 : null,
        expectancySolPerTrade: closed.length ? Math.round((totalPnlSol / closed.length) * 1000) / 1000 : null,
      },
      open,
      closed,
    };
  }
}
