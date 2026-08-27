import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { OpportunityConfigSchema, type OpportunityConfig } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { OpportunitiesService } from './opportunities.service';

const ListSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Get()
  list(@Query(new ZodPipe(ListSchema)) query: { limit: number }) {
    return this.opportunities.list(query.limit);
  }

  @Get('config')
  getConfig() {
    return this.opportunities.getConfig();
  }

  @Put('config')
  setConfig(@Body(new ZodPipe(OpportunityConfigSchema)) config: OpportunityConfig) {
    // autoTrade stays locked until the paper engine proves expectancy
    return this.opportunities.setConfig({ ...config, autoTrade: false });
  }
}
