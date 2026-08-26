import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConsensusService } from '../analysis/consensus.service';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';

@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsService, ConsensusService, PrismaService],
})
export class RecommendationsModule {}
