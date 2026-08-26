import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { RecommendationsService } from './recommendations.service';

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recs: RecommendationsService) {}

  @Get()
  latest() {
    return this.recs.latest();
  }

  @Post('run')
  @HttpCode(200)
  run() {
    return this.recs.run();
  }
}
