import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { BacktestService } from './backtest.service';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Get()
  status() {
    return this.backtest.status();
  }

  @Get('holds')
  holds() {
    return this.backtest.holdDistribution();
  }

  @Post('tune')
  @HttpCode(200)
  tune() {
    return this.backtest.tune(); // exhaustive over a fixed discrete grid — nothing to configure
  }

  @Post('run')
  @HttpCode(200)
  run(@Body() body: { sample?: number }) {
    return this.backtest.start(Math.min(300, Math.max(5, body.sample ?? 60)));
  }
}
