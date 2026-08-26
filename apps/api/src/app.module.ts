import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletsModule } from './wallets/wallets.module';
import { ScreenerModule } from './screener/screener.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { FundingModule } from './funding/funding.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WalletsModule, ScreenerModule, RecommendationsModule, FundingModule],
})
export class AppModule {}
