import { Injectable } from '@nestjs/common';
import { enteredPositions, type WalletMetrics } from '@million/shared';
import { PrismaService } from '../prisma.service';
import type { HeliusTx } from './helius.service';

const LAMPORTS = 1e9;
const FUNDING_MIN_SOL = 1;
const FEEPAYER_MIN_SHARE = 0.15;
const COENTRY_MIN_SHARED = 2;
const COENTRY_MIN_JACCARD = 0.25;
const HUB_DEGREE_MAX = 6; // a node funding/paying for more than this many wallets is a disperser/exchange, not an owner — never cluster through it

/**
 * The Owner graph, v1. Edges are extracted from data we already fetch (funding
 * from analysis history, fee payer from metrics, co-entry from cached ledgers)
 * — owner detection costs no extra API calls. Clustering = union-find over
 * thresholded edges with hub nodes excluded. ownerId is rebuilt wholesale and
 * NOT stable across rebuilds (v1 caveat).
 */
@Injectable()
export class OwnersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Funding + fee-payer edges from one wallet's freshly fetched history. Free. */
  async extractEdges(wallet: string, txs: HeliusTx[], metrics: WalletMetrics): Promise<void> {
    const flows = new Map<string, number>();
    for (const tx of txs) {
      for (const t of tx.nativeTransfers ?? []) {
        const sol = t.amount / LAMPORTS;
        if (sol < 0.1) continue;
        const other = t.fromUserAccount === wallet ? t.toUserAccount : t.toUserAccount === wallet ? t.fromUserAccount : null;
        if (!other || other === wallet) continue;
        flows.set(other, (flows.get(other) ?? 0) + sol);
      }
    }
    const edges: { a: string; b: string; type: string; weight: number }[] = [];
    for (const [other, total] of [...flows.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10)) {
      if (total >= FUNDING_MIN_SOL) edges.push(this.norm(wallet, other, 'funding', Math.round(total * 100) / 100));
    }
    if (metrics.topFeePayer && metrics.topFeePayer.share >= FEEPAYER_MIN_SHARE) {
      edges.push(this.norm(wallet, metrics.topFeePayer.address, 'feepayer', metrics.topFeePayer.share));
    }
    for (const e of edges) {
      await this.prisma.walletEdge
        .upsert({ where: { a_b_type: { a: e.a, b: e.b, type: e.type } }, create: e, update: { weight: e.weight } })
        .catch(() => undefined);
    }
  }

  /** Co-entry edges across analyzed wallets (DB-only), then cluster and assign ownerIds. */
  async rebuild(): Promise<{ owners: number; clustered: number }> {
    const rows = await this.prisma.wallet.findMany({
      where: { metrics: { not: null }, purgedAt: null },
      select: { address: true, metrics: true },
    });
    const entered = new Map<string, Set<string>>();
    for (const w of rows) {
      const m = JSON.parse(w.metrics as string) as WalletMetrics;
      if (m.flags.includes('BOT_INFRA')) continue;
      const mints = new Set(enteredPositions(m.tokens, 0.5, m.solPriceUsd ?? 200).map((t) => t.mint));
      if (mints.size) entered.set(w.address, mints);
    }
    const addrs = [...entered.keys()];
    for (let i = 0; i < addrs.length; i++) {
      for (let k = i + 1; k < addrs.length; k++) {
        const A = entered.get(addrs[i])!;
        const B = entered.get(addrs[k])!;
        let shared = 0;
        for (const m of A) if (B.has(m)) shared++;
        if (shared < COENTRY_MIN_SHARED) continue;
        const jaccard = shared / (A.size + B.size - shared);
        if (jaccard < COENTRY_MIN_JACCARD) continue;
        const e = this.norm(addrs[i], addrs[k], 'coentry', Math.round(jaccard * 100) / 100);
        await this.prisma.walletEdge
          .upsert({ where: { a_b_type: { a: e.a, b: e.b, type: e.type } }, create: e, update: { weight: e.weight } })
          .catch(() => undefined);
      }
    }
    return this.cluster();
  }

  /** Union-find over all stored edges; hub nodes excluded; ownerIds assigned to roster wallets. */
  private async cluster(): Promise<{ owners: number; clustered: number }> {
    const edges = await this.prisma.walletEdge.findMany();
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(x, root);
      return root;
    };
    const union = (x: string, y: string) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    };
    for (const e of edges) {
      // co-entry is evidence, never a bridge: copytraders of the same launches would
      // chain the whole roster into one blob (the 182-wallet owner incident)
      if (e.type === 'coentry') continue;
      if ((degree.get(e.a) ?? 0) > HUB_DEGREE_MAX || (degree.get(e.b) ?? 0) > HUB_DEGREE_MAX) continue;
      if (parent.get(e.a) === undefined) parent.set(e.a, e.a);
      if (parent.get(e.b) === undefined) parent.set(e.b, e.b);
      union(e.a, e.b);
    }

    const roster = await this.prisma.wallet.findMany({ where: { purgedAt: null }, select: { address: true } });
    const rosterSet = new Set(roster.map((w) => w.address));
    const groups = new Map<string, string[]>();
    for (const addr of rosterSet) {
      if (parent.get(addr) === undefined) continue;
      const root = find(addr);
      const list = groups.get(root) ?? [];
      list.push(addr);
      groups.set(root, list);
    }
    // only multi-wallet groups earn an ownerId; singletons stay null
    await this.prisma.wallet.updateMany({ data: { ownerId: null } });
    let ownerId = 0;
    let clustered = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      ownerId++;
      clustered += members.length;
      await this.prisma.wallet.updateMany({ where: { address: { in: members } }, data: { ownerId } });
    }
    return { owners: ownerId, clustered };
  }

  async siblings(address: string): Promise<{ address: string; label: string | null }[]> {
    const me = await this.prisma.wallet.findUnique({ where: { address }, select: { ownerId: true } });
    if (!me?.ownerId) return [];
    const rows = await this.prisma.wallet.findMany({
      where: { ownerId: me.ownerId, address: { not: address }, purgedAt: null },
      select: { address: true, label: true },
    });
    return rows;
  }

  private norm(x: string, y: string, type: string, weight: number) {
    return x < y ? { a: x, b: y, type, weight } : { a: y, b: x, type, weight };
  }
}
