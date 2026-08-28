import { Body, Controller, Get, Post } from '@nestjs/common';
import { CopyabilityService } from './copyability.service';

@Controller('copyability')
export class CopyabilityController {
  constructor(private readonly copyability: CopyabilityService) {}

  @Get()
  rows() {
    return this.copyability.rows();
  }

  @Get('status')
  status() {
    return this.copyability.status();
  }

  @Post('run')
  run(@Body() body: { addresses?: string[]; top?: number }) {
    return this.copyability.start(body.addresses, body.top ?? 10);
  }
}
