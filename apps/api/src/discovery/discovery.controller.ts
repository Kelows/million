import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { SolAddressSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { DiscoveryService } from './discovery.service';

const QuerySchema = z.object({
  minSol: z.coerce.number().nonnegative().default(5),
  pages: z.coerce.number().int().min(1).max(50).default(3),
  mode: z.enum(['recent', 'deep']).default('recent'),
  sinceDays: z.coerce.number().min(1).max(365).default(30),
  buckets: z.coerce.number().int().min(6).max(96).default(24),
});

@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('token/:mint')
  find(
    @Param('mint', new ZodPipe(SolAddressSchema)) mint: string,
    @Query(new ZodPipe(QuerySchema)) query: { minSol: number; pages: number; mode: 'recent' | 'deep'; sinceDays: number; buckets: number },
  ) {
    return this.discovery.find(mint, query.minSol, query.pages, query.mode, query.sinceDays, query.buckets);
  }
}
