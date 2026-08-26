import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { SolAddressSchema } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { FundingService } from './funding.service';

const MinSolSchema = z.object({ minSol: z.coerce.number().nonnegative().default(0.5) });

@Controller('funding')
export class FundingController {
  constructor(private readonly funding: FundingService) {}

  @Get(':address')
  chains(
    @Param('address', new ZodPipe(SolAddressSchema)) address: string,
    @Query(new ZodPipe(MinSolSchema)) query: { minSol: number },
  ) {
    return this.funding.chains(address, query.minSol);
  }
}
