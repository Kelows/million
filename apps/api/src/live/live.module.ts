import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { TradingModule } from '../trading/trading.module';
import { LiveController } from './live.controller';
import { LiveFeedService } from './live-feed.service';

@Module({
  imports: [OpportunitiesModule, TradingModule],
  controllers: [LiveController],
  providers: [LiveFeedService, PrismaService],
  exports: [LiveFeedService],
})
export class LiveModule {}
