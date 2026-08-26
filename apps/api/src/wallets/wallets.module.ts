import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { TokenMetaService } from '../analysis/token-meta.service';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, HeliusService, TokenMetaService, PrismaService],
})
export class WalletsModule {}
