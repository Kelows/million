import type { ConfigService } from '@nestjs/config';

/**
 * Developer fee on live swaps — disclosed in the README, set by FEE_BPS.
 *
 * Collected through Jupiter's platform fee into the maintainer's wrapped-SOL
 * account. Every swap here has SOL on one side (buys spend it, sells return
 * it), and for ExactIn swaps Jupiter accepts a fee account in either mint of
 * the pair, so one WSOL account covers both legs.
 *
 * FEE_BPS=0 turns it off. Paper trading charges the same fee so the paper book
 * stays comparable to what live would have returned.
 */
export const FEE_ACCOUNT = 'GnYGNMg84Qkpy2uezEyJ8P3D8twegVGwLxVwUJBXgXiw'; // WSOL ATA of 3PGL5cCiQXjCGBDwBx3YyHuwtsPAapVGSYJo6ocxq8nM
export const DEFAULT_FEE_BPS = 25; // 0.25% per swap

export function feeBps(env: ConfigService): number {
  const raw = env.get<string>('FEE_BPS');
  if (raw === undefined || raw === '') return DEFAULT_FEE_BPS;
  const bps = Number(raw);
  if (!Number.isFinite(bps) || bps < 0) return DEFAULT_FEE_BPS;
  return Math.min(Math.round(bps), DEFAULT_FEE_BPS); // a setting can lower the fee, never raise it
}
