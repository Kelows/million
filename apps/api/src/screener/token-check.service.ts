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
    const reuseDeployer = prevAgeMs < 24 * 3_600_000 && Boolean(prevCheck('deployer-history'));
    const reuseRug = prevAgeMs < 6 * 3_600_000 && Boolean(prevCheck('rugcheck'));

    const [asset, pair, rug, sellSim] = await Promise.all([
      staticSafe ? Promise.resolve(null) : this.helius.getAssetInfo(mint).catch(() => null),
      this.dexscreener.fetchBestPair(mint),
      reuseDeployer && reuseRug ? Promise.resolve(null) : this.rugcheck.fetchSummary(mint),
      this.jupiter.sellSimulation(mint).catch(() => null),
    ]);
    // LP vault exclusion: the pools' token accounts must not count as "holders"
    const vaultLists = await Promise.all(
      (pair?.pairAddresses ?? []).map((p) => this.helius.getTokenAccountsByOwner(p, mint).catch(() => [])),
    );
    const vaults = new Set(vaultLists.flat());
    const holders = await this.helius.getTopHolders(mint, vaults).catch(() => null);

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
        holders.top10Pct <= t.maxTop10Pct ? 'pass' : 'fail',
        fmtPct(holders.top10Pct),
        holders.excludedVaults > 0
          ? `Largest single account holds ${fmtPct(holders.largestPct)}. ${holders.excludedVaults} LP vault account${holders.excludedVaults === 1 ? '' : 's'} excluded from the math.`
          : `Largest single account holds ${fmtPct(holders.largestPct)}. No LP vault identified to exclude — the pool may be inflating this number.`,
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

    // ── deployer funding: exchange-like source (traceable) vs fresh-wallet chain (opaque) ──
    if (!reuseDeployer && rug?.creator) {
      const funding = await this.deployerFunding(rug.creator).catch(() => null);
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
      const c = prevCheck('rugcheck');
      if (c) checks.push(c);
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
}
