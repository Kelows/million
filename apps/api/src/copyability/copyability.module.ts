import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { GeckoTerminalService } from '../analysis/geckoterminal.service';
import { CopyabilityController } from './copyability.controller';
import { CopyabilityService } from './copyability.service';

@Module({
  controllers: [CopyabilityController],
  providers: [CopyabilityService, PrismaService, DexScreenerService, GeckoTerminalService],
})
export class CopyabilityModule {}
