import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { HeliusService } from '../analysis/helius.service';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, HeliusService, PrismaService],
})
export class WalletsModule {}
