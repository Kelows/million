import { Module } from '@nestjs/common';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { RugcheckService } from '../screener/rugcheck.service';
import { TokenCheckService } from '../screener/token-check.service';
import { PrismaService } from '../prisma.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  controllers: [OpportunitiesController],
  providers: [OpportunitiesService, TokenCheckService, DexScreenerService, RugcheckService, HeliusService, PrismaService],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}
