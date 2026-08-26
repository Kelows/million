import { Controller, Get, Param, Query } from '@nestjs/common';
import { SolAddressSchema, TokenCheckThresholdsSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { TokenCheckService } from './token-check.service';

@Controller('screener')
export class ScreenerController {
  constructor(private readonly tokenCheck: TokenCheckService) {}

  @Get('token/:mint')
  check(
    @Param('mint', new ZodPipe(SolAddressSchema)) mint: string,
    @Query(new ZodPipe(TokenCheckThresholdsSchema)) thresholds: ReturnType<typeof TokenCheckThresholdsSchema.parse>,
  ) {
    return this.tokenCheck.check(mint, thresholds);
  }
}
