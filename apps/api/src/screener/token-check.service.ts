import { Injectable } from '@nestjs/common';
import type { CheckStatus, TokenCheck, TokenCheckThresholds, TokenReport } from '@million/shared';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { RugcheckService } from './rugcheck.service';
import { JupiterService } from '../analysis/jupiter.service';
import { PrismaService } from '../prisma.service';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

@Injectable()
export class TokenCheckService {
  constructor(
    private readonly helius: HeliusService,
    private readonly dexscreener: DexScreenerService,
    private readonly rugcheck: RugcheckService,
    private readonly jupiter: JupiterService,
    private readonly prisma: PrismaService,
  ) {}

  async check(mint: string, t: TokenCheckThresholds): Promise<TokenReport> {
    // cache-aware: immutable facts (revoked authorities, token program) are one-way
    // doors — once observed safe they never need re-fetching. Slow movers reuse
    // within a TTL; volatile market facts always refresh.
    const cachedRow = await this.prisma.token
      .findUnique({ where: { mint }, select: { lastReport: true, lastCheckedAt: true } })
      .catch(() => null);
    const prev = cachedRow?.lastReport ? (JSON.parse(cachedRow.lastReport) as TokenReport) : null;
    const prevAgeMs = cachedRow?.lastCheckedAt ? Date.now() - cachedRow.lastCheckedAt.getTime() : Infinity;
    const prevCheck = (id: string) => prev?.checks.find((c) => c.id === id);
    const staticSafe =
      prevCheck('mint-authority')?.status === 'pass' &&
      prevCheck('freeze-authority')?.status === 'pass' &&
      Boolean(prevCheck('token-program'));
    // only conclusive results are worth reusing — an 'unknown' means the fetch failed and deserves a retry
    const conclusive = (id: string) => { const st = prevCheck(id)?.status; return st !== undefined && st !== 'unknown'; };
    const reuseDeployer = prevAgeMs < 24 * 3_600_000 && conclusive('deployer-history') && conclusive('deployer-funding');
    const reuseRug = prevAgeMs < 6 * 3_600_000 && conclusive('rugcheck');

    // Latency is signal fidelity: this runs cold on every launch-tier trigger,
    // so the chains run CONCURRENTLY — total time is the slowest chain, not the
    // sum. (pair→vaults→holders→deep-sim) ∥ (rug→funding) ∥ asset ∥ jupiter.
    const assetP = staticSafe ? Promise.resolve(null) : this.helius.getAssetInfo(mint).catch(() => null);
    const rugP = reuseRug ? Promise.resolve(null) : this.rugcheck.fetchSummary(mint);
    const sellSimP = this.jupiter.sellSimulation(mint).catch(() => null);
    const holdersChain = (async () => {
      const pair = await this.dexscreener.fetchBestPair(mint);
      // LP vault exclusion: the pools' token accounts must not count as "holders"
      const vaultLists = await Promise.all(
        (pair?.pairAddresses ?? []).map((p) => this.helius.getTokenAccountsByOwner(p, mint).catch(() => [])),
      );
      const vaults = new Set(vaultLists.flat());
      const holders = await this.helius.getTopHolders(mint, vaults).catch(() => null);
      return { pair, vaults, holders };
    })();
    const prevDeepEarly = prevCheck('sell-sim-deep');
    const deepP =
      prevDeepEarly && prevDeepEarly.status !== 'unknown'
        ? Promise.resolve(undefined) // cached — the check block reuses it
        : holdersChain.then(({ vaults }) => this.deepSellSim(mint, vaults)).catch(() => null);
    const fundingP = rugP.then((r) => (!reuseDeployer && r?.creator ? this.deployerFunding(r.creator).catch(() => null) : null));

    const [asset, rug, sellSim, { pair, vaults, holders }] = await Promise.all([assetP, rugP, sellSimP, holdersChain]);
    void vaults;

    const checks: TokenCheck[] = [];
    const push = (id: string, label: string, status: CheckStatus, value: string | null, detail: string) =>
      checks.push({ id, label, status, value, detail });

    // ── critical: supply control ──
    if (staticSafe) {
      // one-way doors observed safe before — reuse verbatim
      for (const id of ['mint-authority', 'freeze-authority', 'metadata-mutable', 'token-program']) {
        const c = prevCheck(id);
        if (c) checks.push(c);
      }
    } else if (!asset) {
      push('mint-authority', 'Mint authority revoked', 'unknown', null, 'Could not load mint data from Helius.');
      push('freeze-authority', 'Freeze authority revoked', 'unknown', null, 'Could not load mint data from Helius.');
    } else {
      push(
        'mint-authority', 'Mint authority revoked',
        asset.mintAuthority ? 'fail' : 'pass',
        asset.mintAuthority ? 'active' : 'revoked',
        asset.mintAuthority
          ? 'The team can mint unlimited new supply and dilute holders to zero.'
          : 'Supply is fixed — no one can print more.',
      );
      push(
        'freeze-authority', 'Freeze authority revoked',
        asset.freezeAuthority ? 'fail' : 'pass',
        asset.freezeAuthority ? 'active' : 'revoked',
        asset.freezeAuthority
          ? 'The team can freeze your tokens so you can buy but never sell (honeypot).'
          : 'No one can freeze holder accounts.',
      );
      if (asset.mutable !== null) {
        // informational only: mutable metadata is the platform default on pump.fun-era
        // mints — a warn that fires on everything is noise, not signal
        push(
          'metadata-mutable', 'Metadata',
          'pass',
          asset.mutable ? 'mutable' : 'immutable',
          asset.mutable
            ? 'Mutable — the launchpad default on modern mints; not scored. Identity swaps remain possible.'
            : 'Token identity is locked.',
        );
      }
      if (asset.tokenProgram) {
        if (asset.tokenProgram === TOKEN_2022_PROGRAM) {
          // the program itself is the pump.fun default — the EXTENSIONS are the risk
          const dangerous = asset.mintExtensions.filter((e) =>
            ['permanent_delegate', 'transfer_hook', 'default_account_state'].includes(e),
          );
          const taxed = asset.mintExtensions.includes('transfer_fee_config');
          push(
            'token-program', 'Token program & extensions',
            dangerous.length ? 'fail' : taxed ? 'warn' : 'pass',
            dangerous.length ? `2022: ${dangerous.join(', ')}` : taxed ? '2022: transfer fee' : 'Token-2022, clean',
            dangerous.length
              ? 'This extension lets the team seize or block your tokens — honeypot machinery.'
              : taxed
                ? 'Transfers are taxed — factor the fee into any exit math.'
                : 'Token-2022 (the launchpad default) with no dangerous extensions.',
          );
        } else {
          push(
            'token-program', 'Token program & extensions',
            asset.tokenProgram === TOKEN_PROGRAM ? 'pass' : 'unknown',
            'SPL Token',
            'Plain SPL token, no extension tricks possible.',
          );
        }
      }
    }

    // ── critical: market failsafes ──
    if (!pair) {
      push('liquidity', `Liquidity ≥ ${fmtUsd(t.minLiquidityUsd)}`, 'fail', 'no pair', 'No active Solana DEX pair found on DexScreener — not tradeable or already abandoned.');
    } else {
      push(
        'liquidity', `Liquidity ≥ ${fmtUsd(t.minLiquidityUsd)}`,
        pair.liquidityUsd === null ? 'unknown' : pair.liquidityUsd >= t.minLiquidityUsd ? 'pass' : 'fail',
        pair.liquidityUsd === null ? null : fmtUsd(pair.liquidityUsd),
        'Thin pools mean brutal slippage and you become the exit liquidity.',
      );
      push(
        'market-cap', `Market cap ≥ ${fmtUsd(t.minMarketCapUsd)}`,
        pair.marketCapUsd === null ? 'unknown' : pair.marketCapUsd >= t.minMarketCapUsd ? 'pass' : 'fail',
        pair.marketCapUsd === null ? null : fmtUsd(pair.marketCapUsd),
        'Filters the sub-graduation churn where 98%+ of tokens die.',
      );
      if (pair.pairCreatedAt) {
        const ageMinutes = (Date.now() - new Date(pair.pairCreatedAt).getTime()) / 60_000;
        push(
          'token-age', `Pair age ≥ ${t.minTokenAgeMinutes}m`,
          ageMinutes >= t.minTokenAgeMinutes ? 'pass' : 'warn',
          ageMinutes < 60 ? `${Math.round(ageMinutes)}m` : ageMinutes < 1440 ? `${Math.round(ageMinutes / 60)}h` : `${Math.round(ageMinutes / 1440)}d`,
          'Very fresh pairs are where most rugs happen; survivorship is information.',
        );
      }
    }

    // ── warning: distribution ──
    if (holders) {
      push(
        'top10-holders', `Top-10 accounts ≤ ${fmtPct(t.maxTop10Pct)}`,
        // Concentration is the risk, not breadth: ten ~2.5% holders slightly over
        // the aggregate line can't individually nuke the pool, so a distributed
        // top-10 gets grace the aggregate-only rule denied. One big account never
        // does — and the deployer holding the top bag fails at ANY size.
        // a dev-owned top bag is judged by size: ≤3% is skin in the game,
        // 3–8% is a watch item, beyond that it's exit liquidity in waiting
        holders.largestOwner !== null && rug?.creator != null && holders.largestOwner === rug.creator
          ? holders.largestPct <= 3
            ? 'pass'
            : holders.largestPct <= 8
              ? 'warn'
              : 'fail'
          : holders.top10Pct <= t.maxTop10Pct
          ? 'pass'
          : holders.top10Pct <= t.maxTop10Pct + 10 && holders.largestPct <= 5
            ? 'pass'
            : holders.top10Pct <= t.maxTop10Pct + 10 && holders.largestPct <= 10
              ? 'warn'
              : 'fail',
        fmtPct(holders.top10Pct),
        `${holders.largestOwner !== null && rug?.creator != null && holders.largestOwner === rug.creator ? `The largest holder is the DEPLOYER (${fmtPct(holders.largestPct)} dev bag${holders.largestPct <= 3 ? ' — small enough to read as skin in the game' : holders.largestPct <= 8 ? ' — watch it' : ' — exit liquidity in waiting'}). ` : holders.top10Pct > t.maxTop10Pct && holders.top10Pct <= t.maxTop10Pct + 10 && holders.largestPct <= 5 ? 'Over the aggregate line but distributed — no account can single-handedly dump. ' : ''}Largest single account holds ${fmtPct(holders.largestPct)}. ${
          holders.excludedVaults > 0
            ? `${holders.excludedVaults} LP vault account${holders.excludedVaults === 1 ? '' : 's'} excluded from the math.`
            : 'No LP vault identified to exclude — the pool may be inflating this number.'
        }`,
      );
    } else {
      push('top10-holders', `Top-10 accounts ≤ ${fmtPct(t.maxTop10Pct)}`, 'unknown', null, 'Could not load holder accounts.');
    }

    // ── deployer history: serial ruggers launch constantly and leave corpses ──
    if (reuseDeployer) {
      for (const id of ['deployer-history', 'deployer-funding']) {
        const c = prevCheck(id);
        if (c) checks.push(c);
      }
    } else if (rug?.creatorTokens && rug.creatorTokens.length > 1) {
      const others = rug.creatorTokens.filter((ct) => ct.mint !== mint);
      const dead = others.filter((ct) => (ct.marketCap ?? 0) < 1000).length;
      const deadShare = others.length ? dead / others.length : 0;
      push(
        'deployer-history', 'Deployer history',
        others.length >= 5 && deadShare >= 0.8 ? 'fail' : others.length >= 2 && deadShare >= 0.5 ? 'warn' : 'pass',
        `${others.length} prior launches, ${dead} dead`,
        `Creator ${rug.creator ? rug.creator.slice(0, 4) + '…' + rug.creator.slice(-4) : 'unknown'} — a graveyard of past launches is the serial-rugger signature. Dead = market cap under $1k.`,
      );
    } else if (rug) {
      push('deployer-history', 'Deployer history', rug.creatorTokens ? 'pass' : 'unknown',
        rug.creatorTokens ? 'first launch' : null,
        rug.creatorTokens ? 'No other tokens from this creator in RugCheck data.' : 'RugCheck did not return creator history.');
    } else {
      // rug skipped this round — a stale cached row beats a hole in the report
      const c = prevCheck('deployer-history');
      if (c) checks.push(c);
    }

    // ── the hard honeypot check: can you actually get OUT, and at what cost ──
    if (!sellSim) {
      push('sell-simulation', 'Sell simulation', 'unknown', null, 'Jupiter quote API unreachable.');
    } else if (!sellSim.buyRoute) {
      push('sell-simulation', 'Sell simulation', 'unknown', 'no route', 'Jupiter cannot route this token at all — too new or too dead to test.');
    } else if (!sellSim.sellRoute) {
      push('sell-simulation', 'Sell simulation', 'fail', 'CANNOT SELL', 'Buy routes exist but no sell route — the classic honeypot shape.');
    } else {
      const loss = sellSim.roundTripLossPct ?? 0;
      push(
        'sell-simulation', 'Sell simulation',
        loss > 30 ? 'fail' : loss > 12 ? 'warn' : 'pass',
        `round trip −${loss}%`,
        `0.1 SOL in and back out costs ${loss}% total (impact + fees + any transfer tax). Roughly ${Math.round(loss / 2)}% per side.`,
      );
    }

    // ── LP lock: both -100% corpses in the first live sample died by liquidity
    // walking away — a pool nobody burned or locked can be drained at will ──
    if (!reuseRug) {
      if (rug?.lpLockedPct == null) {
        push('lp-lock', 'LP locked/burned', 'unknown', null, 'RugCheck has no LP lock data for this pool.');
      } else {
        push(
          'lp-lock', 'LP locked/burned',
          rug.lpLockedPct >= 80 ? 'pass' : rug.lpLockedPct >= 50 ? 'warn' : 'fail',
          `${Math.round(rug.lpLockedPct)}%`,
          rug.lpLockedPct >= 80
            ? 'Liquidity is burned or locked — the pool cannot be pulled out from under holders.'
            : 'A meaningful share of liquidity is unlocked — the deployer can drain the pool at any moment. This is how positions go to zero overnight.',
        );
      }
    }

    // ── deep honeypot probe: the REAL sell transaction of a real holder, dry-run on-chain ──
    // Transfer hooks are baked into the mint at creation, so one conclusive result is cached for good.
    const prevDeep = prevCheck('sell-sim-deep');
    if (prevDeep && prevDeep.status !== 'unknown') {
      checks.push(prevDeep);
    } else {
      const deep = (await deepP) ?? null;
      if (deep === null) {
        push('sell-sim-deep', 'Sell simulation (on-chain)', 'unknown', null, 'Could not build a holder sell transaction to simulate — no sizeable holder or no route yet.');
      } else if (deep.inconclusive) {
        push('sell-sim-deep', 'Sell simulation (on-chain)', 'unknown', 'slippage', 'Simulation hit slippage between quote and execution — market too thin to conclude, will retry.');
      } else if (deep.err) {
        push('sell-sim-deep', 'Sell simulation (on-chain)', 'fail', 'REVERTS', 'The biggest holder\u2019s real sell transaction reverts on-chain while quotes look fine — the transfer-hook honeypot shape.');
      } else {
        push('sell-sim-deep', 'Sell simulation (on-chain)', 'pass', 'executes', 'A real holder\u2019s sell transaction simulates successfully against live chain state.');
      }
    }

    // ── deployer funding: exchange-like source (traceable) vs fresh-wallet chain (opaque) ──
    if (!reuseDeployer && !rug) {
      const c = prevCheck('deployer-funding');
      if (c) checks.push(c);
    } else if (!reuseDeployer && rug?.creator) {
      const funding = await fundingP;
      if (!funding || funding.funder === null) {
        push('deployer-funding', 'Deployer funding', 'unknown', null, 'No sizeable SOL inflow found in the deployer recent history.');
      } else {
        push(
          'deployer-funding', 'Deployer funding',
          funding.funderBusy ? 'pass' : 'warn',
          funding.funderBusy ? 'exchange-like source' : 'fresh-wallet chain',
          funding.funderBusy
            ? `Biggest funder ${funding.funder.slice(0, 4)}… is a high-activity wallet (likely CEX) — an identity trail exists behind the deployer.`
            : `Biggest funder ${funding.funder.slice(0, 4)}… has a thin history — deliberate opacity is the pre-rug funding pattern. Heuristic, not proof.`,
        );
      }
    }

    // ── external: rugcheck ──
    if (reuseRug) {
      for (const id of ['rugcheck', 'lp-lock']) {
        const c = prevCheck(id);
        if (c) checks.push(c);
      }
    } else if (!rug) {
      push('rugcheck', 'RugCheck risk scan', 'unknown', null, 'RugCheck did not respond — check manually at rugcheck.xyz.');
    } else {
      const danger = rug.risks.filter((r) => r.level === 'danger');
      const warns = rug.risks.filter((r) => r.level !== 'danger');
      push(
        'rugcheck', 'RugCheck risk scan',
        danger.length ? 'fail' : warns.length ? 'warn' : 'pass',
        rug.score !== null ? `score ${Math.round(rug.score)}` : `${rug.risks.length} risks`,
        rug.risks.length
          ? rug.risks.map((r) => `${r.level === 'danger' ? '✗' : '△'} ${r.name}`).join(' · ')
          : 'No risks reported (covers LP lock, insiders, and more).',
      );
    }

    const statuses = checks.map((c) => c.status);
    const verdict: CheckStatus = statuses.includes('fail')
      ? 'fail'
      : statuses.includes('warn')
        ? 'warn'
        : statuses.every((s) => s === 'unknown')
          ? 'unknown'
          : 'pass';

    return {
      mint,
      symbol: pair?.symbol ?? null,
      name: pair?.name ?? null,
      priceUsd: pair?.priceUsd ?? null,
      liquidityUsd: pair?.liquidityUsd ?? null,
      marketCapUsd: pair?.marketCapUsd ?? null,
      pairCreatedAt: pair?.pairCreatedAt ?? null,
      dex: pair?.dex ?? null,
      pairUrl: pair?.pairUrl ?? null,
      rugcheckScore: rug?.score ?? prev?.rugcheckScore ?? null,
      checks,
      verdict,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** The deployer's biggest recent SOL funder, and whether that funder looks like
   * a high-activity hub (exchange-ish, ~full signature page) or a thin fresh wallet. */
  private async deployerFunding(creator: string): Promise<{ funder: string | null; funderBusy: boolean } | null> {
    const { txs } = await this.helius.fetchTransfers(creator, 1);
    const inflows = new Map<string, number>();
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        if (t.toUserAccount === creator && t.fromUserAccount && t.fromUserAccount !== creator) {
          const sol = t.amount / 1e9;
          if (sol >= 0.5) inflows.set(t.fromUserAccount, (inflows.get(t.fromUserAccount) ?? 0) + sol);
        }
      }
    }
    const top = [...inflows.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) return { funder: null, funderBusy: false };
    const sigs = await this.helius.signatureIndex(top[0], 0, 1);
    return { funder: top[0], funderBusy: sigs.length >= 900 };
  }

  /**
   * Probe up to four of the biggest holders: build each one's real Jupiter sell
   * and dry-run it. Vault-shaped candidates fail inside the router itself (bad
   * source account) and are skipped; only a revert whose innermost failing
   * program is a token program counts as the honeypot verdict.
   */
  private async deepSellSim(mint: string, vaults: Set<string>): Promise<{ err: unknown; inconclusive: boolean } | null> {
    const candidates = await this.helius.topHolderCandidates(mint, vaults).catch(() => []);
    let sawInconclusive = false;
    for (const holder of candidates) {
      const tx = await this.jupiter.buildSellTransaction(mint, holder.owner, holder.amountRaw).catch(() => null);
      if (!tx) continue;
      const sim = await this.helius.simulateTransaction(tx);
      if (!sim) continue;
      if (sim.err === null) return { err: null, inconclusive: false };
      const logs = (sim.logs ?? []).join('\n');
      if (/SlippageToleranceExceeded|0x1771/.test(logs)) {
        sawInconclusive = true;
        continue; // market moved between quote and sim — says nothing about the token
      }
      const innermost = (sim.logs ?? []).find((l) => / failed: /.test(l));
      const routerOrFunds = !innermost || innermost.includes('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') || /insufficient funds|frozen/i.test(logs);
      if (routerOrFunds) continue; // vault-shaped or empty-ATA candidate, not evidence about the token
      return { err: sim.err, inconclusive: false }; // a token-program CPI revert — the honeypot shape
    }
    return sawInconclusive ? { err: null, inconclusive: true } : null;
  }
}
