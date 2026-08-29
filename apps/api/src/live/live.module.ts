import { Module } from '@nestjs/common';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { FlowsService } from './flows.service';
import { PrismaService } from '../prisma.service';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { TradingModule } from '../trading/trading.module';
import { LiveController } from './live.controller';
import { LiveFeedService } from './live-feed.service';

@Module({
  imports: [OpportunitiesModule, TradingModule],
  controllers: [LiveController],
  providers: [LiveFeedService, FlowsService, PrismaService, DexScreenerService],
  exports: [LiveFeedService],
})
export class LiveModule {}
