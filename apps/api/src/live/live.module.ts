import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LiveController } from './live.controller';
import { LiveFeedService } from './live-feed.service';

@Module({
  controllers: [LiveController],
  providers: [LiveFeedService, PrismaService],
  exports: [LiveFeedService],
})
export class LiveModule {}
