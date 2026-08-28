import { Body, Controller, Get, Headers, HttpCode, Post, Query, Sse, UnauthorizedException } from '@nestjs/common';
import { map } from 'rxjs';
import { EventsBus } from '../common/events.bus';
import { ConfigService } from '@nestjs/config';
import type { HeliusTx } from '../analysis/helius.service';
import { z } from 'zod';
import type { LiveEventRow } from '@million/shared';
import { ZodPipe } from '../zod.pipe';
import { PrismaService } from '../prisma.service';
import { LiveFeedService } from './live-feed.service';

const ListSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

@Controller('live')
export class LiveController {
  constructor(
    private readonly live: LiveFeedService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly bus: EventsBus,
  ) {}

  @Get('status')
  status() {
    return this.live.status();
  }

  /** Server-sent events: the UI learns about new happenings instantly instead of polling. */
  @Sse('stream')
  stream() {
    return this.bus.stream.pipe(map((e) => ({ data: e })));
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Headers('authorization') auth: string | undefined, @Body() payload: unknown) {
    const secret = this.config.get<string>('WEBHOOK_SECRET');
    if (secret && auth !== secret) throw new UnauthorizedException();
    const txs = Array.isArray(payload) ? (payload as HeliusTx[]) : [];
    void this.live.ingestWebhookTxs(txs).catch(() => undefined);
    return { received: txs.length };
  }

  @Get('events')
  async events(@Query(new ZodPipe(ListSchema)) query: { limit: number }): Promise<LiveEventRow[]> {
    const rows = await this.prisma.liveEvent.findMany({ orderBy: { id: 'desc' }, take: query.limit });
    const wallets = await this.prisma.wallet.findMany({
      where: { address: { in: [...new Set(rows.map((r) => r.wallet))] } },
      select: { address: true, label: true },
    });
    const labels = new Map(wallets.map((w) => [w.address, w.label]));
    const mints = [...new Set(rows.map((r) => r.mint).filter((m): m is string => Boolean(m)))];
    const tokens = await this.prisma.token.findMany({ where: { mint: { in: mints } }, select: { mint: true, symbol: true } });
    const symbols = new Map(tokens.map((t) => [t.mint, t.symbol]));
    return rows.map((r) => ({
      id: r.id,
      wallet: r.wallet,
      walletLabel: labels.get(r.wallet) ?? null,
      signature: r.signature,
      ts: r.ts.toISOString(),
      kind: r.kind as LiveEventRow['kind'],
      mint: r.mint,
      symbol: r.mint ? (symbols.get(r.mint) ?? null) : null,
      sol: r.sol,
      usd: r.usd,
    }));
  }
}
