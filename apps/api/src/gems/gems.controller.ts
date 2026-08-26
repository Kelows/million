import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DEFAULT_MIN_OPEN_SOL, TokenCheckThresholdsSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { GemsService } from './gems.service';

const RunQuerySchema = TokenCheckThresholdsSchema.extend({
  minOpenSol: z.coerce.number().nonnegative().default(DEFAULT_MIN_OPEN_SOL),
});

@Controller('gems')
export class GemsController {
  constructor(private readonly gems: GemsService) {}

  @Get()
  latest() {
    return this.gems.latest();
  }

  @Post('run')
  @HttpCode(200)
  run(@Query(new ZodPipe(RunQuerySchema)) query: ReturnType<typeof RunQuerySchema.parse>) {
    const { minOpenSol, ...thresholds } = query;
    return this.gems.run(thresholds, minOpenSol);
  }
}
