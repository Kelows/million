import { Injectable } from '@nestjs/common';

export interface RugcheckSummary {
  score: number | null; // normalised 0-100, higher = riskier
  risks: { name: string; level: string; description: string }[];
}

/** RugCheck public API — read endpoints need no key. Fails soft: null means "source unavailable". */
@Injectable()
export class RugcheckService {
  async fetchSummary(mint: string): Promise<RugcheckSummary | null> {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
      headers: { accept: 'application/json' },
    }).catch(() => null);
    if (!res?.ok) return null;
    type Raw = {
      score?: number;
      score_normalised?: number;
      risks?: { name?: string; level?: string; description?: string }[];
    };
    const body = (await res.json()) as Raw;
    return {
      score: body.score_normalised ?? body.score ?? null,
      risks: (body.risks ?? []).map((r) => ({
        name: r.name ?? 'unnamed risk',
        level: r.level ?? 'warn',
        description: r.description ?? '',
      })),
    };
  }
}
