import { Injectable } from '@nestjs/common';

export interface RugcheckSummary {
  score: number | null; // normalised 0-100, higher = riskier
  risks: { name: string; level: string; description: string }[];
  creator: string | null;
  creatorTokens: { mint: string; marketCap: number | null; createdAt: string | null }[] | null;
}

/** RugCheck public API — read endpoints need no key. Fails soft: null means "source unavailable". */
@Injectable()
export class RugcheckService {
  async fetchSummary(mint: string): Promise<RugcheckSummary | null> {
    // full report: same risks/score as the summary endpoint, plus the creator's launch history
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res?.ok) return null;
    type Raw = {
      score?: number;
      score_normalised?: number;
      risks?: { name?: string; level?: string; description?: string }[];
      creator?: string;
      creatorTokens?: { mint?: string; marketCap?: number; createdAt?: string }[] | null;
    };
    const body = (await res.json()) as Raw;
    return {
      score: body.score_normalised ?? body.score ?? null,
      risks: (body.risks ?? []).map((r) => ({
        name: r.name ?? 'unnamed risk',
        level: r.level ?? 'warn',
        description: r.description ?? '',
      })),
      creator: body.creator ?? null,
      creatorTokens: Array.isArray(body.creatorTokens)
        ? body.creatorTokens
            .filter((t) => t.mint)
            .map((t) => ({ mint: t.mint as string, marketCap: t.marketCap ?? null, createdAt: t.createdAt ?? null }))
        : null,
    };
  }
}
