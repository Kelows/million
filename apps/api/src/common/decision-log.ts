import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import type { DecisionOutcome, DecisionRow, DecisionStage } from '@million/shared';
import { PrismaService } from '../prisma.service';
import { EventsBus } from './events.bus';

const MAX_LINES = 300;
const RETENTION_HOURS = 72;
const MAX_ROWS = 50_000;

export interface DecisionInput {
  mint?: string | null;
  symbol?: string | null;
  wallet?: string | null;
  stage: DecisionStage;
  outcome: DecisionOutcome;
  code: string;
  reason: string;
  quiet?: boolean;
}

/**
 * The decision log: every verdict the pipeline makes about a token event.
 *
 * Two outputs. `push` is the api pane's narration, kept in a ring buffer for the
 * Trading page. `record` is the answer to "why didn't it buy X?": a persisted,
 * structured row per decision, shown on Opportunities and on each token's page.
 */
@Injectable()
export class DecisionLog implements OnModuleInit {
  private readonly lines: { ts: string; line: string }[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventsBus,
  ) {}

  onModuleInit() {
    void this.prune();
    setInterval(() => void this.prune(), 60 * 60_000);
  }

  push(line: string): void {
    console.log(line); // the terminal keeps its narration
    this.lines.push({ ts: new Date().toISOString(), line });
    if (this.lines.length > MAX_LINES) this.lines.shift();
  }

  tail(n = 100): { ts: string; line: string }[] {
    return this.lines.slice(-n).reverse(); // newest first
  }

  /** Persist one decision. Never throws: observability must not break the pipeline it observes. */
  record(d: DecisionInput): void {
    const who = [d.symbol ?? d.mint?.slice(0, 6), d.wallet ? `${d.wallet.slice(0, 6)}…` : null].filter(Boolean).join(' · ');
    if (!d.quiet) this.push(`[${d.stage}] ${d.outcome.toUpperCase()} ${who}: ${d.reason}`);
    void this.prisma.decision
      .create({
        data: {
          mint: d.mint ?? null,
          symbol: d.symbol ?? null,
          wallet: d.wallet ?? null,
          stage: d.stage,
          outcome: d.outcome,
          code: d.code,
          reason: d.reason,
          quiet: d.quiet ?? false,
        },
      })
      .then(() => this.bus.emit('decision'))
      .catch(() => undefined);
  }

  async list(opts: { mint?: string; quiet?: boolean; limit: number }): Promise<DecisionRow[]> {
    const rows = await this.prisma.decision.findMany({
      where: { ...(opts.mint ? { mint: opts.mint } : {}), ...(opts.quiet ? {} : { quiet: false }) },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
    // live events carry a mint, not a name: fill symbols from the token cache at read time
    const unnamed = [...new Set(rows.filter((r) => !r.symbol && r.mint).map((r) => r.mint as string))];
    const named = unnamed.length
      ? await this.prisma.token.findMany({ where: { mint: { in: unnamed }, symbol: { not: null } }, select: { mint: true, symbol: true } })
      : [];
    const symbols = new Map(named.map((t) => [t.mint, t.symbol]));
    return rows.map((r) => ({
      ...r,
      symbol: r.symbol ?? (r.mint ? symbols.get(r.mint) ?? null : null),
      ts: r.ts.toISOString(),
      stage: r.stage as DecisionStage,
      outcome: r.outcome as DecisionOutcome,
    }));
  }

  private async prune(): Promise<void> {
    await this.prisma.decision.deleteMany({ where: { ts: { lt: new Date(Date.now() - RETENTION_HOURS * 3_600_000) } } }).catch(() => undefined);
    const newest = await this.prisma.decision.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }).catch(() => null);
    if (newest && newest.id > MAX_ROWS) {
      await this.prisma.decision.deleteMany({ where: { id: { lte: newest.id - MAX_ROWS } } }).catch(() => undefined);
    }
  }
}

@Global()
@Module({ providers: [DecisionLog, PrismaService], exports: [DecisionLog] })
export class DecisionLogModule {}
