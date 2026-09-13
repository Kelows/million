import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { PrismaService } from '../prisma.service';
import { JupiterService } from '../analysis/jupiter.service';
import { TRADE_EXECUTOR } from './executor.interface';
import { LocalExecutor } from './local.executor';
import { PaperExecutor } from './paper.executor';
import { ShadowService } from './shadow.service';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';

@Module({
  controllers: [TradingController],
  providers: [JupiterService, 
    TradingService,
    DexScreenerService,
    HeliusService,
    PrismaService,
    PaperExecutor,
    LocalExecutor,
    ShadowService,
    // THE seam, and the only switch: EXECUTOR=local signs real transactions with
    // the local keypair; anything else (or nothing) stays paper. Either way every
    // opportunity that clears the rules trades.
    {
      provide: TRADE_EXECUTOR,
      inject: [ConfigService, PaperExecutor, LocalExecutor],
      useFactory: (env: ConfigService, paper: PaperExecutor, local: LocalExecutor) => {
        const live = env.get('EXECUTOR') === 'local';
        new Logger('TradingModule').warn(live ? '*** LIVE EXECUTOR — real transactions will be signed ***' : 'paper executor (set EXECUTOR=local to go live)');
        return live ? local : paper;
      },
    },
  ],
  exports: [TradingService, ShadowService],
})
export class TradingModule {}
