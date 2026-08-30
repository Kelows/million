import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { BacktestService } from './backtest.service';

@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Get()
  status() {
    return this.backtest.status();
  }

  @Get('swing')
  swing() {
    return this.backtest.swingResults();
  }

  @Post('swing/run')
  @HttpCode(200)
  runSwing(@Body() body: { sample?: number; minSol?: number }) {
    void this.backtest.runSwing(Math.min(300, Math.max(5, body.sample ?? 60)), Math.max(0, body.minSol ?? 0));
    return { started: true };
  }

  @Post('backfill')
  @HttpCode(200)
  backfill(@Body() body: { limit?: number }) {
    return this.backtest.backfillReports(Math.min(500, Math.max(1, body.limit ?? 100)));
  }

  @Get('cohorts')
  cohorts() {
    return this.backtest.entryCohorts();
  }

  @Get('matrix')
  matrix() {
    return this.backtest.exitMatrix();
  }

  @Get('capture')
  capture(@Query('minPeak') minPeak?: string) {
    return this.backtest.peakCapture(Math.max(0, Number(minPeak) || 100));
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
