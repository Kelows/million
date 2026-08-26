import { Module } from '@nestjs/common';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { RugcheckService } from '../screener/rugcheck.service';
import { TokenCheckService } from '../screener/token-check.service';
import { PrismaService } from '../prisma.service';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

@Module({
  controllers: [TokensController],
  providers: [TokensService, TokenCheckService, DexScreenerService, RugcheckService, HeliusService, PrismaService],
})
export class TokensModule {}
