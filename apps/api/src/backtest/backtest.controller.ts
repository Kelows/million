import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { BacktestService } from './backtest.service';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Get()
  status() {
    return this.backtest.status();
  }

  @Post('tune')
  @HttpCode(200)
  tune(@Body() body: { iterations?: number }) {
    return this.backtest.tune(Math.min(5000, Math.max(50, body.iterations ?? 400)));
  }

  @Post('run')
  @HttpCode(200)
  run(@Body() body: { sample?: number }) {
    return this.backtest.start(Math.min(300, Math.max(5, body.sample ?? 60)));
  }
}
