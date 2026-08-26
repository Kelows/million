import { Module } from '@nestjs/common';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from './dexscreener.service';
import { RugcheckService } from './rugcheck.service';
import { ScreenerController } from './screener.controller';
import { TokenCheckService } from './token-check.service';

@Module({
  controllers: [ScreenerController],
  providers: [TokenCheckService, DexScreenerService, RugcheckService, HeliusService],
})
export class ScreenerModule {}
