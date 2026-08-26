import { Module } from '@nestjs/common';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { PrismaService } from '../prisma.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService, HeliusService, DexScreenerService, PrismaService],
})
export class DiscoveryModule {}
