import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SolAddressSchema } from '@million/shared';

// NOT TokenCheckThresholdsSchema.partial(): zod still fills .default()s through
// .partial(), which silently turns "no params" into a full stale-default override.
const PartialThresholdsSchema = z.object({
  minLiquidityUsd: z.coerce.number().nonnegative().optional(),
  minMarketCapUsd: z.coerce.number().nonnegative().optional(),
  maxTop10Pct: z.coerce.number().min(0).max(100).optional(),
  minTokenAgeMinutes: z.coerce.number().nonnegative().optional(),
});
import { ZodPipe } from '../zod.pipe';
import { TokensService } from './tokens.service';
import { ConvictionService } from './conviction.service';
import { MoversService } from '../analysis/movers.service';

const MoversQuerySchema = z.object({
  minPump: z.coerce.number().min(0).default(50),
  limit: z.coerce.number().int().min(1).max(30).default(15),
  minMcap: z.coerce.number().min(0).default(100_000),
  maxMcap: z.coerce.number().min(0).default(50_000_000),
});

const ImportSchema = z.object({
  mints: z.array(SolAddressSchema).min(1).max(500),
  source: z.string().max(64).optional(),
});

@Controller('tokens')
export class TokensController {
  constructor(
    private readonly tokens: TokensService,
    private readonly movers: MoversService,
    private readonly conviction: ConvictionService,
  ) {}

  @Post('import')
  import(@Body(new ZodPipe(ImportSchema)) body: { mints: string[]; source?: string }) {
    return this.tokens.import(body.mints, body.source ?? null);
  }

  @Get()
  list() {
    return this.tokens.list();
  }

  @Get('movers')
  findMovers(@Query(new ZodPipe(MoversQuerySchema)) query: { minPump: number; limit: number; minMcap: number; maxMcap: number }) {
    return this.movers.find(query.minPump, query.limit, query.minMcap, query.maxMcap);
  }

  @Post('purge-junk')
  @HttpCode(200)
  purgeJunk() {
    return this.tokens.purgeJunk();
  }

  @Post('recheck-all')
  @HttpCode(200)
  recheckAll(@Query(new ZodPipe(PartialThresholdsSchema)) thresholds: ReturnType<typeof PartialThresholdsSchema.parse>) {
    return this.tokens.startRecheckAll(thresholds);
  }

  @Get('jobs/recheck-all')
  recheckStatus() {
    return this.tokens.getRecheckStatus();
  }

  @Get('conviction')
  convictionCohorts() {
    return this.conviction.cohorts();
  }

  @Post('conviction/snapshot')
  @HttpCode(200)
  takeSnapshot() {
    return this.conviction.snapshot();
  }

  @Get('famous')
  famous() {
    return this.tokens.famous();
  }

  @Get(':mint')
  detail(@Param('mint', new ZodPipe(SolAddressSchema)) mint: string) {
    return this.tokens.detail(mint);
  }

  @Post(':mint/check')
  @HttpCode(200)
  check(
    @Param('mint', new ZodPipe(SolAddressSchema)) mint: string,
    @Query(new ZodPipe(PartialThresholdsSchema)) thresholds: ReturnType<typeof PartialThresholdsSchema.parse>,
  ) {
    return this.tokens.check(mint, thresholds);
  }

  @Delete(':mint')
  untrack(@Param('mint', new ZodPipe(SolAddressSchema)) mint: string) {
    return this.tokens.untrack(mint);
  }
}
