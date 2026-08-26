import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';

@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsService, PrismaService],
})
export class RecommendationsModule {}
