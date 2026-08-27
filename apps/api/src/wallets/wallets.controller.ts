import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { WalletImportSchema, type WalletImport } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { WalletsService } from './wallets.service';

@Controller()
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get('health')
  health() {
    return { ok: true, ...this.wallets.status() };
  }

  @Post('wallets/import')
  import(@Body(new ZodPipe(WalletImportSchema)) payload: WalletImport) {
    return this.wallets.import(payload);
  }

  @Get('wallets')
  list() {
    return this.wallets.list();
  }

  @Get('wallets/:address')
  get(@Param('address') address: string) {
    return this.wallets.get(address);
  }

  @Post('wallets/:address/analyze')
  @HttpCode(200)
  analyze(@Param('address') address: string) {
    return this.wallets.analyze(address);
  }

  @Post('wallets/purge-junk')
  @HttpCode(200)
  purgeJunk() {
    return this.wallets.purgeJunk();
  }

  @Delete('wallets/:address')
  remove(@Param('address') address: string) {
    return this.wallets.remove(address);
  }
}
