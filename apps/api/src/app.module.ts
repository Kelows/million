import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletsModule } from './wallets/wallets.module';
import { ScreenerModule } from './screener/screener.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { FundingModule } from './funding/funding.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { GemsModule } from './gems/gems.module';
import { TokensModule } from './tokens/tokens.module';
import { CrawlerModule } from './crawler/crawler.module';
import { LiveModule } from './live/live.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WalletsModule, ScreenerModule, RecommendationsModule, FundingModule, DiscoveryModule, GemsModule, TokensModule, CrawlerModule, LiveModule],
})
export class AppModule {}
