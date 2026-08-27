import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LiveModule } from '../live/live.module';
import { HeliusService } from '../analysis/helius.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { OwnersService } from '../analysis/owners.service';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [LiveModule],
  controllers: [WalletsController],
  providers: [WalletsService, HeliusService, TokenMetaService, DexScreenerService, OwnersService, PrismaService],
})
export class WalletsModule {}
