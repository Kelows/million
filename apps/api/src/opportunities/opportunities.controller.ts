import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { OpportunityConfigSchema, type OpportunityConfig } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { DecisionLog } from '../common/decision-log';
import { OpportunitiesService } from './opportunities.service';

const ListSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const DecisionsSchema = z.object({
  mint: z.string().min(32).max(64).optional(),
  quiet: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(150),
});

@Controller('opportunities')
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly decisions: DecisionLog,
  ) {}

  @Get()
  list(@Query(new ZodPipe(ListSchema)) query: { limit: number }) {
    return this.opportunities.list(query.limit);
  }

  /** Why token events did or did not become trades — newest first, optionally for one mint. */
  @Get('decisions')
  listDecisions(@Query(new ZodPipe(DecisionsSchema)) query: { mint?: string; quiet: boolean; limit: number }) {
    return this.decisions.list(query);
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
