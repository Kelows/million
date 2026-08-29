import { Module } from '@nestjs/common';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { RugcheckService } from './rugcheck.service';
import { JupiterService } from '../analysis/jupiter.service';
import { ScreenerController } from './screener.controller';
import { TokenCheckService } from './token-check.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [ScreenerController],
  providers: [TokenCheckService, DexScreenerService, RugcheckService,
    JupiterService, HeliusService, PrismaService],
  exports: [TokenCheckService],
})
export class ScreenerModule {}
