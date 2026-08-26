import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SolAddressSchema, TokenCheckThresholdsSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { TokensService } from './tokens.service';

const ImportSchema = z.object({
  mints: z.array(SolAddressSchema).min(1).max(500),
  source: z.string().max(64).optional(),
});

@Controller('tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Post('import')
  import(@Body(new ZodPipe(ImportSchema)) body: { mints: string[]; source?: string }) {
    return this.tokens.import(body.mints, body.source ?? null);
  }

  @Get()
  list() {
    return this.tokens.list();
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
