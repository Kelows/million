import { Module } from '@nestjs/common';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { RugcheckService } from '../screener/rugcheck.service';
import { JupiterService } from '../analysis/jupiter.service';
import { TokenCheckService } from '../screener/token-check.service';
import { PrismaService } from '../prisma.service';
import { TokensController } from './tokens.controller';
import { ConvictionService } from './conviction.service';
import { TokensService } from './tokens.service';
import { MoversService } from '../analysis/movers.service';

@Module({
  controllers: [TokensController],
  providers: [ConvictionService, TokensService, MoversService, TokenCheckService, DexScreenerService, RugcheckService,
    JupiterService, HeliusService, PrismaService],
})
export class TokensModule {}
