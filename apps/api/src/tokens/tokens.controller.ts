import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SolAddressSchema, TokenCheckThresholdsSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { TokensService } from './tokens.service';
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
  recheckAll(@Query(new ZodPipe(TokenCheckThresholdsSchema)) thresholds: ReturnType<typeof TokenCheckThresholdsSchema.parse>) {
    return this.tokens.startRecheckAll(thresholds);
  }

  @Get('jobs/recheck-all')
  recheckStatus() {
    return this.tokens.getRecheckStatus();
  }

  @Get(':mint')
  detail(@Param('mint', new ZodPipe(SolAddressSchema)) mint: string) {
    return this.tokens.detail(mint);
  }

  @Post(':mint/check')
  @HttpCode(200)
  check(
    @Param('mint', new ZodPipe(SolAddressSchema)) mint: string,
    @Query(new ZodPipe(TokenCheckThresholdsSchema)) thresholds: ReturnType<typeof TokenCheckThresholdsSchema.parse>,
  ) {
    return this.tokens.check(mint, thresholds);
  }

  @Delete(':mint')
  untrack(@Param('mint', new ZodPipe(SolAddressSchema)) mint: string) {
    return this.tokens.untrack(mint);
  }
}
