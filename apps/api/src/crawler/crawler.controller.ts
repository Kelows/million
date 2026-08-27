import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { CrawlerConfigSchema, type CrawlerConfig } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { CrawlerService } from './crawler.service';

@Controller('crawler')
export class CrawlerController {
  constructor(private readonly crawler: CrawlerService) {}

  @Get()
  status() {
    return this.crawler.status();
  }

  @Put('config')
  setConfig(@Body(new ZodPipe(CrawlerConfigSchema)) config: CrawlerConfig) {
    return this.crawler.setConfig(config);
  }

  @Post('run-once')
  @HttpCode(200)
  runOnce() {
    return this.crawler.runOnce();
  }

  @Post('run-deep')
  @HttpCode(200)
  runDeep() {
    return this.crawler.runDeep();
  }
}
