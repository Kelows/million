import { Module } from '@nestjs/common';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { PrismaService } from '../prisma.service';
import { TRADE_EXECUTOR } from './executor.interface';
import { PaperExecutor } from './paper.executor';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';

@Module({
  controllers: [TradingController],
  providers: [
    TradingService,
    DexScreenerService,
    HeliusService,
    PrismaService,
    // THE seam: swap PaperExecutor for a JupiterExecutor and everything else stands
    { provide: TRADE_EXECUTOR, useClass: PaperExecutor },
  ],
  exports: [TradingService],
})
export class TradingModule {}
