import { Module } from '@nestjs/common';
import { ConsensusService } from '../analysis/consensus.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { RugcheckService } from '../screener/rugcheck.service';
import { JupiterService } from '../analysis/jupiter.service';
import { TokenCheckService } from '../screener/token-check.service';
import { PrismaService } from '../prisma.service';
import { GemsController } from './gems.controller';
import { GemsService } from './gems.service';

@Module({
  controllers: [GemsController],
  providers: [GemsService, ConsensusService, TokenCheckService, DexScreenerService, RugcheckService,
    JupiterService, HeliusService, PrismaService],
})
export class GemsModule {}
