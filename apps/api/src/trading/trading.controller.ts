import { Controller, HttpCode, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { TradingService } from './trading.service';
import { ShadowService } from './shadow.service';
import { DecisionLog } from '../common/decision-log';

@Controller('trading')
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly shadow: ShadowService,
    private readonly decisions: DecisionLog,
  ) {}

  @Get('log')
  log(@Query('n') n?: string) {
    return this.decisions.tail(Math.min(150, Math.max(1, Number(n) || 150)));
  }

  @Get('shadow/matrix')
  shadowMatrix() {
    return this.shadow.matrix();
  }

  @Get('shadow')
  shadowStats() {
    return this.shadow.stats();
  }

  @Get()
  overview() {
    return this.trading.overview();
  }

  @Post('resume')
  @HttpCode(200)
  resume() {
    return this.trading.resume();
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@Param('id', ParseIntPipe) id: number) {
    await this.trading.closeManual(id);
    return { closed: id };
  }
}

