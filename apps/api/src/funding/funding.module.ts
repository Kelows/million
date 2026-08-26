import { Module } from '@nestjs/common';
import { HeliusService } from '../analysis/helius.service';
import { PrismaService } from '../prisma.service';
import { FundingController } from './funding.controller';
import { FundingService } from './funding.service';

@Module({
  controllers: [FundingController],
  providers: [FundingService, HeliusService, PrismaService],
})
export class FundingModule {}
