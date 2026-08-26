import { TokenCheckThresholdsSchema, type TokenCheckThresholds } from '@million/shared';

const STORAGE_KEY = 'million.failsafes';

export type FailsafeConfig = TokenCheckThresholds;

export const DEFAULT_FAILSAFES: FailsafeConfig = TokenCheckThresholdsSchema.parse({});

export function loadFailsafes(): FailsafeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_FAILSAFES, ...JSON.parse(raw) } : DEFAULT_FAILSAFES;
  } catch {
    return DEFAULT_FAILSAFES;
  }
}

export function saveFailsafes(config: FailsafeConfig): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}
