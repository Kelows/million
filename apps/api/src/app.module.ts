import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletsModule } from './wallets/wallets.module';
import { ScreenerModule } from './screener/screener.module';
import { RecommendationsModule } from './recommendations/recommendations.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WalletsModule, ScreenerModule, RecommendationsModule],
})
export class AppModule {}
