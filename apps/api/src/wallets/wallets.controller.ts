import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { LiveFeedService } from '../live/live-feed.service';
import { OwnersService } from '../analysis/owners.service';
import { WalletImportSchema, type WalletImport } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { WalletsService } from './wallets.service';

@Controller()
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly live: LiveFeedService,
    private readonly owners: OwnersService,
  ) {}

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

  @Put('wallets/:address/label')
  setLabel(
    @Param('address') address: string,
    @Body(new ZodPipe(z.object({ label: z.string().trim().max(64).nullable() }))) body: { label: string | null },
  ) {
    return this.wallets.setLabel(address, body.label || null);
  }

  @Put('wallets/:address/subscribe')
  async subscribe(
    @Param('address') address: string,
    @Body(new ZodPipe(z.object({ subscribed: z.boolean() }))) body: { subscribed: boolean },
  ) {
    const record = await this.wallets.setSubscribed(address, body.subscribed);
    void this.live.resync();
    return record;
  }

  @Post('owners/rebuild')
  @HttpCode(200)
  rebuildOwners() {
    return this.owners.rebuild();
  }

  @Put('wallets/:address/subscribe-owner')
  async subscribeOwner(
    @Param('address') address: string,
    @Body(new ZodPipe(z.object({ subscribed: z.boolean() }))) body: { subscribed: boolean },
  ) {
    const result = await this.wallets.setOwnerSubscribed(address, body.subscribed);
    void this.live.resync();
    return result;
  }

  @Post('wallets/purge-junk')
  @HttpCode(200)
  purgeJunk(
    @Body(new ZodPipe(z.object({ flags: z.array(z.string()).min(1).max(10).optional() })))
    body: { flags?: string[] },
  ) {
    return this.wallets.purgeJunk(body.flags as import('@million/shared').WalletFlag[] | undefined);
  }

  @Delete('wallets/:address')
  remove(@Param('address') address: string) {
    return this.wallets.remove(address);
  }
}
