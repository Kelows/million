import { Injectable } from '@nestjs/common';
import type { CheckStatus, TokenCheck, TokenCheckThresholds, TokenReport } from '@million/shared';
import { HeliusService } from '../analysis/helius.service';
import { DexScreenerService } from './dexscreener.service';
import { RugcheckService } from './rugcheck.service';

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
  ) {}

  async check(mint: string, t: TokenCheckThresholds): Promise<TokenReport> {
    const [asset, holders, pair, rug] = await Promise.all([
      this.helius.getAssetInfo(mint).catch(() => null),
      this.helius.getTopHolders(mint).catch(() => null),
      this.dexscreener.fetchBestPair(mint),
      this.rugcheck.fetchSummary(mint),
    ]);

    const checks: TokenCheck[] = [];
    const push = (id: string, label: string, status: CheckStatus, value: string | null, detail: string) =>
      checks.push({ id, label, status, value, detail });

    // ── critical: supply control ──
    if (!asset) {
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
        push(
          'metadata-mutable', 'Metadata immutable',
          asset.mutable ? 'warn' : 'pass',
          asset.mutable ? 'mutable' : 'immutable',
          asset.mutable ? 'Name/symbol/image can be swapped after launch — common in impersonation scams.' : 'Token identity is locked.',
        );
      }
      if (asset.tokenProgram) {
        push(
          'token-program', 'Standard token program',
          asset.tokenProgram === TOKEN_PROGRAM ? 'pass' : asset.tokenProgram === TOKEN_2022_PROGRAM ? 'warn' : 'unknown',
          asset.tokenProgram === TOKEN_2022_PROGRAM ? 'Token-2022' : 'SPL Token',
          asset.tokenProgram === TOKEN_2022_PROGRAM
            ? 'Token-2022 supports transfer fees and permanent delegates — verify its extensions manually.'
            : 'Plain SPL token, no extension tricks possible.',
        );
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
        holders.top10Pct <= t.maxTop10Pct ? 'pass' : 'warn',
        fmtPct(holders.top10Pct),
        `Largest single account holds ${fmtPct(holders.largestPct)}. The LP vault is usually among these — a big overshoot means concentrated/insider supply.`,
      );
    } else {
      push('top10-holders', `Top-10 accounts ≤ ${fmtPct(t.maxTop10Pct)}`, 'unknown', null, 'Could not load holder accounts.');
    }

    // ── external: rugcheck ──
    if (!rug) {
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
      rugcheckScore: rug?.score ?? null,
      checks,
      verdict,
      fetchedAt: new Date().toISOString(),
    };
  }
}
