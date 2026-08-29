import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CrawlerConfigSchema, DEFAULT_MIN_OPEN_SOL } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { ZodPipe } from '../zod.pipe';
import { GemsService } from './gems.service';

// Thresholds come from the stored crawler config like everywhere else. This
// endpoint used to take them as REQUIRED query params with schema defaults, so
// the web sent browser-local values and a caller that sent none silently got
// the 100k/200k defaults — a second source of truth that disagreed with the
// one on screen.
const RunQuerySchema = z.object({
  minOpenSol: z.coerce.number().nonnegative().default(DEFAULT_MIN_OPEN_SOL),
});

@Controller('gems')
export class GemsController {
  constructor(
    private readonly gems: GemsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  latest() {
    return this.gems.latest();
  }

  @Post('run')
  @HttpCode(200)
  async run(@Query(new ZodPipe(RunQuerySchema)) query: ReturnType<typeof RunQuerySchema.parse>) {
    const row = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } }).catch(() => null);
    const { thresholds } = CrawlerConfigSchema.parse(row ? JSON.parse(row.data) : {});
    return this.gems.run(thresholds, query.minOpenSol);
  }
}
