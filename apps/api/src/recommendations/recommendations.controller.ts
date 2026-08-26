import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_MIN_OPEN_SOL } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { RecommendationsService } from './recommendations.service';

const RunQuerySchema = z.object({ minOpenSol: z.coerce.number().nonnegative().default(DEFAULT_MIN_OPEN_SOL) });

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recs: RecommendationsService) {}

  @Get()
  latest() {
    return this.recs.latest();
  }

  @Post('run')
  @HttpCode(200)
  run(@Query(new ZodPipe(RunQuerySchema)) query: { minOpenSol: number }) {
    return this.recs.run(query.minOpenSol);
  }
}
