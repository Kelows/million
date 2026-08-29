import { Controller, Get, Param, Query } from '@nestjs/common';
import { CrawlerConfigSchema, SolAddressSchema } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { ZodPipe } from '../zod.pipe';
import { TokenCheckService } from './token-check.service';

@Controller('screener')
export class ScreenerController {
  constructor(private readonly tokenCheck: TokenCheckService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('token/:mint')
  // No query thresholds: they resolve from the stored crawler config, so a
  // manual check applies exactly the rules the pipeline does.
  async check(@Param('mint', new ZodPipe(SolAddressSchema)) mint: string) {
    const row = await this.prisma.crawlerConfig.findUnique({ where: { id: 1 } }).catch(() => null);
    const { thresholds } = CrawlerConfigSchema.parse(row ? JSON.parse(row.data) : {});
    return this.tokenCheck.check(mint, thresholds);
  }
}
