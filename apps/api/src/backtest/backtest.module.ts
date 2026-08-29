import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { GeckoTerminalService } from '../analysis/geckoterminal.service';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  controllers: [BacktestController],
  providers: [BacktestService, PrismaService, DexScreenerService, GeckoTerminalService],
})
export class BacktestModule {}
