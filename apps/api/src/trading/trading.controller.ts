import { Controller, HttpCode, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { TradingService } from './trading.service';
import { ShadowService } from './shadow.service';

@Controller('trading')
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly shadow: ShadowService,
  ) {}

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
