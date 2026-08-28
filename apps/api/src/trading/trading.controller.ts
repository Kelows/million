import { Controller, HttpCode, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { TradingService } from './trading.service';

@Controller('trading')
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Get()
  overview() {
    return this.trading.overview();
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@Param('id', ParseIntPipe) id: number) {
    await this.trading.closeManual(id);
    return { closed: id };
  }
}
