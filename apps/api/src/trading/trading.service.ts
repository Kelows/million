import { Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OpportunityConfigSchema, type OpportunityConfig, type PaperPositionRow, type TradingHalt, type TradingStats } from '@million/shared';
import type { PaperPosition } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { HeliusService } from '../analysis/helius.service';
import { EventsBus } from '../common/events.bus';
import { ShadowService } from './shadow.service';
import { DecisionLog } from '../common/decision-log';
import { TRADE_EXECUTOR, type TradeExecutor } from './executor.interface';

// Exits are a race against the price. At a 60s poll, Stunk's -50% stop filled
// at -73.7% (13 Sep): a meme coin can fall a quarter between two looks. One
// batched DexScreener call covers the whole book, so 5s costs 12 requests a
// minute against a 300/min limit. Roster trades in a held token check it at
// once (checkMint), so the poll is the floor, not the reaction time.
const GUARD_MS = 5_000;
// the trail's volatility band is measured at a 1-minute timescale (see
// dynamicTrailPct), so the price history keeps sampling once a minute
const HISTORY_SAMPLE_MS = 60_000;
// an unquotable position is probed for "no pairs" at most once a minute
const DEAD_PROBE_MS = 60_000;

/**
 * The strategy engine: opens a position per opportunity, monitors TP/SL/timeout
 * every minute, records fills and PnL. Executor-agnostic — it never knows
 * whether fills are simulated or real. Paper stats produced here are the gate
 * that will (or won't) unlock live auto-trade.
 */
@Injectable()
export class TradingService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRADE_EXECUTOR) private readonly executor: TradeExecutor,
    private readonly helius: HeliusService,
    private readonly bus: EventsBus,
    private readonly shadow: ShadowService,
    private readonly decisions: DecisionLog,
    private readonly dexscreener: DexScreenerService,
  ) {}

  // last ~30 tick quotes per open position: realized volatility for the dynamic
  // trail, computed from prices we were fetching anyway — zero extra calls
  private readonly priceHistory = new Map<number, number[]>();
  private readonly lastSampleAt = new Map<number, number>();
  private readonly lastProbeAt = new Map<number, number>();
  // one exit at a time per position: the poll, a roster event and a mirror sell
  // can all decide to close in the same second, and live that is two swaps
  private readonly closing = new Set<number>();
  private heldMints = new Set<string>();
  private readonly checkingMint = new Set<string>();

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), GUARD_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async config(): Promise<OpportunityConfig> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
  }

  /** Called for every new opportunity — the feed that drives everything. */
  async openFromOpportunity(
    mint: string,
    symbol: string | null,
    wallet: string,
    whaleEntryPriceUsd: number | null = null,
    whaleBuySol: number | null = null,
    signal: string = 'copy',
    wouldBlock: string = '',
  ): Promise<void> {
    const config = await this.config();
    // Every opportunity trades, in whichever mode EXECUTOR selected: paper by
    // default, live with EXECUTOR=local. There is no second switch.
    if (config.positionSol <= 0) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'size-zero', reason: 'opportunity fired, but position size is set to 0' });
      return;
    }
    if (config.tradeSignals !== 'all' && signal !== config.tradeSignals) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'signal-not-traded', reason: `opportunity fired, but your rules only trade ${config.tradeSignals} signals, not ${signal}` });
      return;
    }
    const halt = await this.haltState(config);
    if (halt.halted) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'circuit-breaker', reason: `opportunity fired, but the circuit breaker has halted entries: ${halt.reason}` });
      return;
    }
    // conviction sizing, three flavors:
    //  fixed      — every position the same size
    //  whale-pct  — % of the whale's raw entry (unnormalized)
    //  whale-frac — the whale's entry as a share of THEIR bankroll, applied to OURS
    //               (normalized conviction: 100 SOL from a 10k whale is a flier,
    //                from a 120 SOL wallet it's an all-in — capped at 25%)
    let sizeSol = config.positionSol;
    if (config.sizingMode === 'whale-pct' && whaleBuySol) {
      sizeSol = Math.min(config.positionSol, Math.max(0.01, Math.round(whaleBuySol * config.copyPct) / 100));
    } else if (config.sizingMode === 'whale-frac' && whaleBuySol) {
      // cached balance first — stale beats hot-path latency; live RPC only self-heals an empty cache
      const row = await this.prisma.wallet.findUnique({ where: { address: wallet }, select: { balanceSol: true } });
      let balance = row?.balanceSol ?? null;
      if (balance === null) {
        balance = await this.helius.getBalanceSol(wallet).catch(() => null);
        if (balance !== null) {
          await this.prisma.wallet.update({ where: { address: wallet }, data: { balanceSol: balance, balanceAt: new Date() } }).catch(() => undefined);
        }
      }
      const bankrollAtEntry = (balance ?? 0) + whaleBuySol;
      const fraction = bankrollAtEntry > 0 ? Math.min(0.25, whaleBuySol / bankrollAtEntry) : 0.05;
      const bankroll = await this.bankroll(config);
      if (bankroll === null) {
        this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'no-balance', reason: 'opportunity fired, but the trading wallet balance could not be read' });
        return;
      }
      sizeSol = Math.min(config.positionSol, Math.max(0.01, Math.round(bankroll * fraction * 100) / 100));
    }
    const open = await this.prisma.paperPosition.findMany({ where: { status: 'open' }, select: { sizeSol: true } });
    if (open.length >= config.maxOpenPositions) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'max-positions', reason: `opportunity fired, but ${config.maxOpenPositions} positions are already open (your maximum)` });
      return;
    }
    // FIX: portfolio exposure cap — ten positions in one meta is one bet wearing ten hats
    const exposure = open.reduce((s, p) => s + p.sizeSol, 0);
    if (exposure + sizeSol > config.maxTotalExposureSol) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'exposure-cap', reason: `opportunity fired, but it would take total exposure past your ${config.maxTotalExposureSol} ◎ cap` });
      return;
    }
    const dupe = await this.prisma.paperPosition.findFirst({ where: { mint, status: 'open' } });
    if (dupe) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'already-open', reason: 'opportunity fired, but a position in this token is already open' });
      return;
    }
    // churn guard — RULES MODE ONLY: there, losses come from OUR stop logic and
    // serial re-stop-outs are our failure loop. In the mirror modes the whale's
    // judgment is the strategy, and that includes their judgment to re-enter a
    // token they just lost on: copying means following.
    if (config.exitMode === 'rules') {
      const lastClosed = await this.prisma.paperPosition.findFirst({ where: { mint, status: 'closed' }, orderBy: { closedAt: 'desc' }, select: { closedAt: true, pnlSol: true } });
      if (lastClosed?.closedAt && (lastClosed.pnlSol ?? 0) < 0 && Date.now() - lastClosed.closedAt.getTime() < 3_600_000) {
        this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'churn-guard', reason: 'opportunity fired, but this token stopped out at a loss under an hour ago' });
        return;
      }
    }
    const fill = await this.executor.buy(mint, sizeSol);
    if (!fill) {
      this.decisions.record({ mint, symbol, wallet, stage: 'trade', outcome: 'skip', code: 'no-fill', reason: `opportunity fired, but the ${this.executor.mode} buy of ${sizeSol} ◎ did not fill` });
      return;
    }
    // NOTE for the live executor: fidelity sizing must move BEFORE buy() there
    // (quote first, size, then execute) — paper fills are quotes, so post-hoc is safe.
    // fill fidelity, asymmetric — the two tails fail differently. Below their
    // fill = buying the deflation of their own impact spike (hard skip at -30%).
    // Above = the move already ran without us; buying a local top (skip at +25%).
    // Inside the band, edge decays continuously with the gap — so does size.
    if (whaleEntryPriceUsd) {
      const gap = fill.priceUsd / whaleEntryPriceUsd - 1;
      const limit = gap < 0 ? 0.3 : 0.25;
      if (Math.abs(gap) > limit) {
        this.shadow.record(mint, symbol, wallet, gap < 0 ? 'fill-deflation' : 'fill-chase');
        this.decisions.record({
          mint, symbol, wallet, stage: 'trade', outcome: 'shadow', code: gap < 0 ? 'fill-deflation' : 'fill-chase',
          reason: `our fill would be ${(gap * 100).toFixed(0)}% ${gap < 0 ? 'below' : 'above'} the whale's price: ${gap < 0 ? 'buying the dip their own buy caused' : 'the move already ran without us'}. Tracked as a shadow position`,
        });
        return;
      }
      const fidelity = Math.max(0.2, 1 - Math.abs(gap) / limit); // floor: a binary cliff at the boundary wastes information
      if (fidelity < 1) sizeSol = Math.max(0.01, Math.round(sizeSol * fidelity * 100) / 100);
    }
    await this.prisma.paperPosition.create({
      data: { mint, symbol, wallet, sizeSol, entryPriceUsd: fill.priceUsd, mode: this.executor.mode, whaleEntryPriceUsd, signal, wouldBlock: wouldBlock || null },
    });
    this.decisions.record({
      mint, symbol, wallet, stage: 'trade', outcome: 'opened', code: this.executor.mode,
      reason: `opened ${sizeSol} ◎ (${this.executor.mode}, ${signal} signal) at $${fill.priceUsd.toPrecision(3)}`,
    });
    this.bus.emit('paper_trade', { kind: 'open', symbol, mint, sizeSol, mode: this.executor.mode, signal });
  }

  /** Mirror exits: the wallet that triggered the position just sold this mint. */
  /**
   * Asymmetric mirror: the whale's exit cuts a LOSER instantly (they are our
   * risk manager), but on a WINNER it arms a trailing stop instead — mirror
   * exits capped every winner at +14% in the first sample while losers kept
   * their full depth. Let the one fat right tail we have breathe.
   */
  async onTriggerSell(wallet: string, mint: string): Promise<void> {
    const config = await this.config();
    if (config.exitMode === 'rules') return;
    const positions = await this.prisma.paperPosition.findMany({ where: { status: 'open', mint, wallet } });
    for (const p of positions) {
      // consensus-trail: one wallet leaving is noise. They took profit on their
      // own schedule and their size, neither of which is ours. We leave when the
      // CROWD leaves, or the trail/stop fires — never on one exit.
      if (config.exitMode === 'consensus-trail' || config.exitMode === 'trail') {
        this.decisions.push(`[trading] ${p.symbol ?? mint.slice(0, 8)}: trigger wallet exited — holding, ${config.exitMode} ignores a single seller`);
        continue;
      }
      // pure mirror: the whale's judgment is the strategy — their exit is our exit, win or lose
      if (config.exitMode === 'mirror') {
        await this.closeWithFill(p.id, p.mint, p.sizeSol, 'mirror');
        continue;
      }
      // mirror-trail: their exit cuts losers instantly; a winner arms a trailing stop instead
      const price = await this.executor.quote(p.mint);
      // a marginal winner (<+10%) is better mirror-closed than left to the
      // giveback zone; a real winner is already protected by the trail
      const inProfit = price !== null && price > p.entryPriceUsd * (1 + config.trailArmPct / 100);
      if (!inProfit) {
        await this.closeWithFill(p.id, p.mint, p.sizeSol, 'mirror');
      } else {
        // tick() already tracks the peak from entry, so the trail is live —
        // nothing to arm, just let it run
        this.decisions.push(`[trading] ${p.symbol ?? mint.slice(0, 8)}: whale exited in profit — trailing stop keeps the position`);
      }
    }
  }

  /** The monitor, every few seconds. Rules mode: TP/SL/timeout. Mirror mode: the whale is the TP; SL and timeout stay as brakes. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const open = await this.prisma.paperPosition.findMany({ where: { status: 'open' } });
      this.heldMints = new Set(open.map((p) => p.mint));
      for (const map of [this.priceHistory, this.lastSampleAt, this.lastProbeAt]) {
        for (const id of [...map.keys()]) if (!open.some((p) => p.id === id)) map.delete(id); // closed — drop the buffers
      }
      if (!open.length) return;
      const config = await this.config();
      const prices = await this.dexscreener.fetchPrices([...this.heldMints]).catch(() => new Map<string, number>());
      // concurrently: a slow live sell on one position must not delay the stop on another
      await Promise.all(open.map((p) => this.guard(p, prices.get(p.mint) ?? null, config)));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A roster wallet just traded a token we hold, which is when its price moves:
   * run that position's exits now rather than at the next tick.
   */
  async checkMint(mint: string): Promise<void> {
    if (!this.heldMints.has(mint) || this.checkingMint.has(mint)) return;
    this.checkingMint.add(mint);
    try {
      const positions = await this.prisma.paperPosition.findMany({ where: { status: 'open', mint } });
      if (!positions.length) return;
      const [config, prices] = await Promise.all([this.config(), this.dexscreener.fetchPrices([mint]).catch(() => new Map<string, number>())]);
      await Promise.all(positions.map((p) => this.guard(p, prices.get(mint) ?? null, config)));
    } finally {
      this.checkingMint.delete(mint);
    }
  }

  private async guard(p: PaperPosition, price: number | null, config: OpportunityConfig): Promise<void> {
    if (this.closing.has(p.id)) return;
    if (price !== null && Date.now() - (this.lastSampleAt.get(p.id) ?? 0) >= HISTORY_SAMPLE_MS) {
      const hist = this.priceHistory.get(p.id) ?? [];
      hist.push(price);
      if (hist.length > 240) hist.shift(); // 4h at one sample a minute — long enough to contain the swing band
      this.priceHistory.set(p.id, hist);
      this.lastSampleAt.set(p.id, Date.now());
    }
    if (price === null) {
      // A missing quote is NOT evidence of death. Booking -100% on it cost
      // us 2.36 SOL of fabricated loss in one night across five positions
      // that were all still quoting -- including a $46M market cap that we
      // recorded as a total loss while it was up 3%. Confirm with a probe
      // that separates "no pairs exist" from "we could not reach the API",
      // and only the first one closes the position.
      if (Date.now() - p.openedAt.getTime() > 3_600_000 && Date.now() - (this.lastProbeAt.get(p.id) ?? 0) >= DEAD_PROBE_MS) {
        this.lastProbeAt.set(p.id, Date.now());
        const probe = await this.dexscreener.probePairs(p.mint).catch(() => 'unreachable' as const);
        if (probe === 'no-pairs') await this.close(p.id, 'dead', 0);
        else this.decisions.push(`[trade] ${p.mint.slice(0, 6)}… unquotable but ${probe} — holding, not booking a loss`);
      }
      return;
    }
    const changePct = (price / p.entryPriceUsd - 1) * 100;
    // The peak ratchets on EVERY tick, for every open position — the trail
    // used to arm only when the whale sold, so a position that ran +40% and
    // reversed while the whale sat still had no protection above the -50%
    // stop, and the "a winner never finishes red" ratchet never applied.
    // Price, not the whale, is what the trail should react to.
    const peak = Math.max(p.peakPriceUsd ?? p.entryPriceUsd, price);
    if (peak > (p.peakPriceUsd ?? 0)) await this.prisma.paperPosition.update({ where: { id: p.id }, data: { peakPriceUsd: peak } });
    if (config.exitMode !== 'rules' && peak >= p.entryPriceUsd * (1 + config.trailArmPct / 100)) {
      // The leash widens to the token's OWN drawdown band (see
      // dynamicTrailPct), with the configured pct as a floor and cold-start
      // fallback, plus a breakeven ratchet: once a real winner, never red.
      //
      // 1.25 -> 1.02 is measured, not chosen. An exhaustive sweep of 640
      // combinations across both horizons — trail × arm × stop × ratchet,
      // where the ratchet options were none, 1.25->1.02, 1.50->1.10 and
      // 2.00->1.30 — put 1.25->1.02 in nearly every top-ranked row on
      // minute AND hourly paths. The later ratchets arm too rarely to
      // matter; no ratchet gives back the whole peak on a fader.
      //
      // What that sweep could NOT fix is the giveback: median 29-35% of the
      // peak handed back in every one of the 640 combinations. A trailing
      // exit only reacts after the turn, so cutting that requires knowing
      // which positions will not run — prediction, not parameters.
      const trailPct = this.dynamicTrailPct(p.id, config.trailStopPct);
      const trailLine = peak * (1 - trailPct / 100);
      const breakevenLine = peak >= p.entryPriceUsd * 1.25 ? p.entryPriceUsd * 1.02 : 0;
      if (price <= Math.max(trailLine, breakevenLine)) {
        await this.closeWithFill(p.id, p.mint, p.sizeSol, 'trail');
        return;
      }
    }
    if (config.exitMode === 'rules' && changePct >= config.takeProfitPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'tp');
    else if (changePct <= -config.stopLossPct) await this.closeWithFill(p.id, p.mint, p.sizeSol, 'sl');
    else if (Date.now() - p.openedAt.getTime() > config.maxHoldHours * 3_600_000)
      await this.closeWithFill(p.id, p.mint, p.sizeSol, 'timeout');
  }

  /**
   * Distribution exit: ANY roster wallet selling a mint we hold is a vote. When
   * enough DISTINCT OWNERS vote inside the window, the position closes.
   *
   * Owners, not wallets — one operator running five addresses must not be able
   * to constitute a crowd by itself, the same clustering the consensus ENTRY
   * uses. Only meaningful in consensus-trail mode; the other modes already have
   * their own answer to when we leave.
   */
  async onRosterSell(mint: string): Promise<void> {
    const config = await this.config();
    if (config.exitMode !== 'consensus-trail') return;
    const positions = await this.prisma.paperPosition.findMany({ where: { status: 'open', mint } });
    if (!positions.length) return;
    const since = new Date(Date.now() - config.consensusExitWindowMinutes * 60_000);
    const sells = await this.prisma.liveEvent.findMany({ where: { mint, kind: 'sell', ts: { gte: since } }, select: { wallet: true } });
    if (!sells.length) return;
    const rows = await this.prisma.wallet.findMany({
      where: { address: { in: [...new Set(sells.map((e) => e.wallet))] } },
      select: { address: true, ownerId: true },
    });
    const owners = new Set(rows.map((w) => w.ownerId ?? w.address)); // unclustered wallet = its own owner
    if (owners.size < config.consensusExitOwners) return;
    for (const p of positions) {
      this.decisions.push(`[trading] ${p.symbol ?? mint.slice(0, 8)}: ${owners.size} owners sold within ${config.consensusExitWindowMinutes}m — distribution, closing`);
      await this.closeWithFill(p.id, p.mint, p.sizeSol, 'consensus-exit');
    }
  }

  private async closeWithFill(id: number, mint: string, sizeSol: number, reason: string): Promise<void> {
    if (this.closing.has(id)) return; // an exit for this position is already in flight
    this.closing.add(id);
    try {
      const fill = await this.executor.sell(mint, sizeSol);
      if (!fill) return; // retry next tick
      await this.close(id, reason, fill.priceUsd);
    } finally {
      this.closing.delete(id);
    }
  }

  private async close(id: number, reason: string, exitPriceUsd: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') return;
    const pnlPct = p.entryPriceUsd > 0 ? (exitPriceUsd / p.entryPriceUsd - 1) * 100 : -100;
    await this.prisma.paperPosition.update({
      where: { id },
      data: {
        status: 'closed',
        exitPriceUsd,
        exitReason: reason,
        closedAt: new Date(),
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
      },
    });
    this.decisions.push(`[trading] CLOSED ${p.symbol ?? p.mint.slice(0, 8)} — ${Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000}◎ (${Math.round(pnlPct * 100) / 100}%) via ${reason}`);
    this.bus.emit('paper_trade', {
      kind: 'closed',
      symbol: p.symbol,
      mint: p.mint,
      sizeSol: p.sizeSol,
      pnlSol: Math.round(p.sizeSol * (pnlPct / 100) * 1000) / 1000,
      pnlPct: Math.round(pnlPct * 100) / 100,
      reason,
      mode: this.executor.mode,
    });
  }

  async closeManual(id: number): Promise<void> {
    const p = await this.prisma.paperPosition.findUnique({ where: { id } });
    if (!p || p.status !== 'open') throw new NotFoundException('no such open position');
    await this.closeWithFill(p.id, p.mint, p.sizeSol, 'manual');
  }

  /** Volatility-scaled trail width: clamp(3σ of 1-min returns, 8%, 30%); fallback until the buffer warms. */
  /**
   * Trail width from the position's OWN drawdown band, not from tick-to-tick
   * sigma. The old formula measured volatility at the wrong timescale: over a
   * 60s tick sigma is tiny, 3*sigma fell under the 8% floor essentially always,
   * and the trail sat permanently at its minimum.
   *
   * That is the fone failure in one number. fone's routine drawdown from its
   * running peak ran a median 17.2% and a p90 of 21.6% WHILE IT CLIMBED — an
   * 8-10% trail lives inside that band, so it does not exit on a reversal, it
   * exits on an ordinary dip. A trail must clear the noise a token makes on the
   * way up or it is just a slow market order.
   *
   * So: p90 of the drawdowns actually observed from the running peak, plus a
   * fifth for headroom, never tighter than the configured floor.
   */
  private dynamicTrailPct(positionId: number, fallbackPct: number): number {
    const hist = this.priceHistory.get(positionId) ?? [];
    if (hist.length < 20) return fallbackPct; // too early to know its band
    let peak = hist[0];
    const drawdowns: number[] = [];
    for (const px of hist) {
      peak = Math.max(peak, px);
      drawdowns.push((1 - px / peak) * 100);
    }
    drawdowns.sort((a, b) => a - b);
    const p90 = drawdowns[Math.floor(drawdowns.length * 0.9)];
    return Math.min(35, Math.max(fallbackPct, p90 * 1.2));
  }

  /**
   * Book-level circuit breakers, computed fresh from closed positions so there
   * is no stored flag to drift: a loss streak since the last manual resume, or
   * a rolling-week drawdown beyond the configured share of bankroll.
   */
  async haltState(config?: OpportunityConfig): Promise<TradingHalt> {
    const cfg = config ?? (await this.config());
    const cleared = cfg.haltClearedAt ? new Date(cfg.haltClearedAt) : new Date(0);
    const closes = await this.prisma.paperPosition.findMany({
      where: { status: 'closed', closedAt: { gt: cleared } },
      orderBy: { closedAt: 'desc' },
      select: { pnlSol: true, closedAt: true },
      take: 500,
    });
    let consecutiveLosses = 0;
    for (const p of closes) {
      if ((p.pnlSol ?? 0) >= 0) break;
      consecutiveLosses++;
    }
    const weekAgo = Date.now() - 7 * 86_400_000;
    const weeklyPnlSol = closes
      .filter((p) => (p.closedAt?.getTime() ?? 0) > weekAgo)
      .reduce((sum, p) => sum + (p.pnlSol ?? 0), 0);
    const bankroll = (await this.bankroll(cfg)) ?? cfg.bankrollSol;
    const weeklyLimitSol = (bankroll * cfg.weeklyLossLimitPct) / 100;
    const reason =
      consecutiveLosses >= cfg.maxConsecutiveLosses
        ? `${consecutiveLosses} losses in a row (limit ${cfg.maxConsecutiveLosses})`
        : weeklyPnlSol <= -weeklyLimitSol
          ? `7-day realized ${weeklyPnlSol.toFixed(2)} ◎ breaches -${cfg.weeklyLossLimitPct}% of ${bankroll.toFixed(2)} ◎ bankroll`
          : null;
    return { halted: reason !== null, reason, consecutiveLosses, weeklyPnlSol: Math.round(weeklyPnlSol * 1000) / 1000 };
  }

  /**
   * The bankroll sizing and the weekly halt measure against. Paper: the number
   * in the rules. Live: the trading wallet's actual SOL — a typed figure that
   * drifted from the real balance would size every trade wrong.
   */
  private async bankroll(cfg: OpportunityConfig): Promise<number | null> {
    return this.executor.mode === 'live' ? this.executor.walletBalanceSol().catch(() => null) : cfg.bankrollSol;
  }

  /** Manual resume: closes before now stop counting toward either breaker. */
  async resume(): Promise<TradingHalt> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    const cfg = OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {});
    const data = JSON.stringify({ ...cfg, haltClearedAt: new Date().toISOString() });
    await this.prisma.opportunityConfig.upsert({ where: { id: 1 }, create: { id: 1, data }, update: { data } });
    return this.haltState();
  }

  async overview(): Promise<{ stats: TradingStats; open: PaperPositionRow[]; closed: PaperPositionRow[]; halt: TradingHalt }> {
    const rows = await this.prisma.paperPosition.findMany({ orderBy: { id: 'desc' }, take: 300 });
    const open: PaperPositionRow[] = [];
    const closed: PaperPositionRow[] = [];
    for (const p of rows) {
      const row: PaperPositionRow = {
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        wallet: p.wallet,
        signal: p.signal,
        wouldBlock: p.wouldBlock,
        sizeSol: p.sizeSol,
        entryPriceUsd: p.entryPriceUsd,
        openedAt: p.openedAt.toISOString(),
        status: p.status as 'open' | 'closed',
        exitPriceUsd: p.exitPriceUsd,
        exitReason: p.exitReason,
        closedAt: p.closedAt?.toISOString() ?? null,
        pnlSol: p.pnlSol,
        pnlPct: p.pnlPct,
        mode: p.mode,
      };
      if (p.status === 'open') {
        const price = await this.executor.quote(p.mint).catch(() => null);
        row.currentPriceUsd = price;
        row.unrealizedPct = price !== null && p.entryPriceUsd > 0 ? Math.round((price / p.entryPriceUsd - 1) * 10000) / 100 : null;
        open.push(row);
      } else closed.push(row);
    }
    const wins = closed.filter((c) => (c.pnlSol ?? 0) > 0).length;
    const totalPnlSol = closed.reduce((s, c) => s + (c.pnlSol ?? 0), 0);
    const avgPnlPct = closed.length ? closed.reduce((s, c) => s + (c.pnlPct ?? 0), 0) / closed.length : null;
    const halt = await this.haltState();
    return {
      halt,
      stats: {
        mode: this.executor.mode,
        walletBalanceSol: this.executor.mode === 'live' ? await this.executor.walletBalanceSol().catch(() => null) : null,
        openCount: open.length,
        closedCount: closed.length,
        wins,
        winRate: closed.length ? Math.round((wins / closed.length) * 100) / 100 : null,
        totalPnlSol: Math.round(totalPnlSol * 1000) / 1000,
        avgPnlPct: avgPnlPct !== null ? Math.round(avgPnlPct * 100) / 100 : null,
        expectancySolPerTrade: closed.length ? Math.round((totalPnlSol / closed.length) * 1000) / 1000 : null,
        avgLatencyCostPct: (() => {
          const pairs = rows.filter((p) => p.whaleEntryPriceUsd && p.whaleEntryPriceUsd > 0);
          if (!pairs.length) return null;
          const costs = pairs.map((p) => (p.entryPriceUsd / p.whaleEntryPriceUsd! - 1) * 100);
          return Math.round((costs.reduce((s, x) => s + x, 0) / costs.length) * 100) / 100;
        })(),
      },
      open,
      closed,
    };
  }
}
