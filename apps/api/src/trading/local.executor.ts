import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { OpportunityConfigSchema } from '@million/shared';
import { DexScreenerService } from '../analysis/dexscreener.service';
import { PrismaService } from '../prisma.service';
import type { Fill, TradeExecutor } from './executor.interface';
import { FEE_ACCOUNT, feeBps } from './fee';

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag/swap/v1';
const LAMPORTS = 1_000_000_000;

// Executor-level hard rails — the LAST line of defense, deliberately dumber and
// stricter than the strategy caps above it. The strategy can be wrong; these can't be argued with.
const DEFAULT_MAX_TRADE_SOL = 0.25;
const DEFAULT_MIN_BALANCE_SOL = 0.05;
const BUY_SLIPPAGE_CAP_BPS = 1_000; // 10% — a buy that needs more is a buy we don't want
const SELL_SLIPPAGE_BPS = 2_500; // 25% — exits prioritize OUT over price
const CONFIRM_TIMEOUT_MS = 60_000;
const FEE_ACCOUNT_CHECK_MS = 10 * 60_000;

/**
 * The real thing: signs with a locally-held keypair and swaps via Jupiter.
 * No approval prompts — that's the point — which is why the rails above are
 * hardcoded constants, not config. Selected only by EXECUTOR=local: set it and
 * every opportunity that clears the rules is bought with real SOL.
 *
 * Key setup: solana-keygen style JSON (64-byte array) at EXECUTOR_KEYPAIR_PATH
 * (default ~/.million/keypair.json). Keep it outside the repo. Fund it only
 * with what the system is allowed to lose.
 */
@Injectable()
export class LocalExecutor implements TradeExecutor {
  readonly mode = 'live' as const;
  private readonly log = new Logger(LocalExecutor.name);
  private keypair: Keypair | null = null;
  private feeAccountOk: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly env: ConfigService,
    private readonly dexscreener: DexScreenerService,
    private readonly prisma: PrismaService,
  ) {}

  async quote(mint: string): Promise<number | null> {
    const pair = await this.dexscreener.fetchBestPair(mint).catch(() => null);
    return pair?.priceUsd ?? null;
  }

  async buy(mint: string, sizeSol: number): Promise<Fill | null> {
    const maxTrade = Number(this.env.get('LOCAL_MAX_TRADE_SOL') ?? DEFAULT_MAX_TRADE_SOL);
    if (sizeSol > maxTrade) {
      this.log.warn(`REFUSED buy ${mint.slice(0, 8)}: ${sizeSol} ◎ exceeds executor hard cap ${maxTrade} ◎`);
      return null;
    }
    const kp = this.loadKeypair();
    if (!kp) return null;
    const balance = await this.balanceSol(kp.publicKey.toBase58());
    const minBalance = Number(this.env.get('LOCAL_MIN_BALANCE_SOL') ?? DEFAULT_MIN_BALANCE_SOL);
    if (balance === null || balance - sizeSol < minBalance) {
      this.log.warn(`REFUSED buy ${mint.slice(0, 8)}: balance ${balance ?? '?'} ◎ would fall below the ${minBalance} ◎ fee reserve`);
      return null;
    }
    const slippageBps = Math.min(BUY_SLIPPAGE_CAP_BPS, Math.round((await this.configSlippagePct()) * 100));
    const sig = await this.swap(kp, WSOL, mint, Math.floor(sizeSol * LAMPORTS), slippageBps);
    if (!sig) return null;
    return this.fillFromChain(sig, mint, 'buy', sizeSol);
  }

  async sell(mint: string, sizeSol: number): Promise<Fill | null> {
    const kp = this.loadKeypair();
    if (!kp) return null;
    const raw = await this.tokenBalanceRaw(kp.publicKey.toBase58(), mint);
    if (!raw || raw === '0') {
      this.log.warn(`sell ${mint.slice(0, 8)}: no token balance on the executor wallet`);
      return null;
    }
    const sig = await this.swap(kp, mint, WSOL, Number(raw), SELL_SLIPPAGE_BPS);
    if (!sig) return null;
    return this.fillFromChain(sig, mint, 'sell', sizeSol);
  }

  // ── plumbing ──

  private loadKeypair(): Keypair | null {
    if (this.keypair) return this.keypair;
    const path = (this.env.get<string>('EXECUTOR_KEYPAIR_PATH') ?? `${homedir()}/.million/keypair.json`).replace('~', homedir());
    try {
      const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
      this.keypair = Keypair.fromSecretKey(secret);
      this.log.log(`executor wallet loaded: ${this.keypair.publicKey.toBase58()}`);
      return this.keypair;
    } catch (e) {
      this.log.error(`cannot load keypair at ${path}: ${e} — live trades disabled until fixed`);
      return null;
    }
  }

  /** Quote → build → sign → send → confirm. Null on any refusal or failure — never a partial state. */
  private async swap(kp: Keypair, inputMint: string, outputMint: string, amountRaw: number, slippageBps: number): Promise<string | null> {
    const bps = (await this.feeAccountReady()) ? feeBps(this.env) : 0;
    let built = bps > 0 ? await this.build(kp, inputMint, outputMint, amountRaw, slippageBps, bps) : null;
    // The fee must never be the reason a trade fails — least of all an exit.
    // If Jupiter will not build it with the fee, build it without.
    if (!built) built = await this.build(kp, inputMint, outputMint, amountRaw, slippageBps, 0);
    if (!built) return null;

    const tx = VersionedTransaction.deserialize(Buffer.from(built, 'base64'));
    tx.sign([kp]);
    const b64 = Buffer.from(tx.serialize()).toString('base64');
    const sig = await this.rpc<string>('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }]);
    if (!sig) return null;
    this.log.log(`sent ${inputMint === WSOL ? 'BUY' : 'SELL'} tx ${sig}`);

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const st = await this.rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>('getSignatureStatuses', [[sig]]);
      const s = st?.value?.[0];
      if (s?.err) {
        this.log.error(`tx ${sig} FAILED on-chain: ${JSON.stringify(s.err)}`);
        return null;
      }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    this.log.error(`tx ${sig} unconfirmed after ${CONFIRM_TIMEOUT_MS / 1000}s — treat as failed, VERIFY ON-CHAIN before retrying`);
    return null;
  }

  /** Quote and build one swap transaction; `feeBps` 0 builds it without the developer fee. */
  private async build(kp: Keypair, inputMint: string, outputMint: string, amountRaw: number, slippageBps: number, fee: number): Promise<string | null> {
    const feeParam = fee > 0 ? `&platformFeeBps=${fee}` : '';
    const q = await fetch(
      `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&swapMode=ExactIn${feeParam}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
    ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!q?.outAmount) {
      this.log.warn(`no route ${inputMint.slice(0, 6)}→${outputMint.slice(0, 6)}${fee ? ' (with fee)' : ''}`);
      return null;
    }
    const swap = (await fetch(`${JUP}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
        ...(fee > 0 ? { feeAccount: FEE_ACCOUNT } : {}),
      }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { swapTransaction?: string } | null;
    return swap?.swapTransaction ?? null;
  }

  /**
   * Jupiter rejects a fee into an account that does not exist, and a wrapped-SOL
   * account disappears if its owner unwraps it. Check before charging, cached so
   * a tick loop does not spend an RPC call per swap.
   */
  private async feeAccountReady(): Promise<boolean> {
    if (feeBps(this.env) === 0) return false;
    if (this.feeAccountOk && Date.now() - this.feeAccountOk.at < FEE_ACCOUNT_CHECK_MS) return this.feeAccountOk.ok;
    const info = await this.rpc<{ value: unknown }>('getAccountInfo', [FEE_ACCOUNT, { encoding: 'base64' }]);
    const ok = Boolean(info?.value);
    if (!ok) this.log.warn(`fee account ${FEE_ACCOUNT.slice(0, 8)} not found — swapping without the developer fee`);
    this.feeAccountOk = { ok, at: Date.now() };
    return ok;
  }

  /** The honest fill: actual token amounts from the confirmed tx, not the quote's promise. */
  private async fillFromChain(sig: string, mint: string, side: 'buy' | 'sell', sizeSol: number): Promise<Fill> {
    const at = new Date();
    const solUsd = await this.dexscreener.fetchSolPriceUsd();
    const key = this.env.get<string>('HELIUS_API_KEY');
    const tx = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ transactions: [sig] }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { tokenTransfers?: { mint: string; tokenAmount: number }[] }[] | null;
    const tokens = (tx?.[0]?.tokenTransfers ?? [])
      .filter((t) => t.mint === mint)
      .reduce((s, t) => Math.max(s, Math.abs(t.tokenAmount)), 0);
    if (tokens > 0 && side === 'buy') return { priceUsd: (sizeSol * solUsd) / tokens, at };
    // A sell is priced by the SOL that actually came back. Dividing the ENTRY
    // size by the tokens sold returned the entry price whatever happened, so
    // every live close booked ~0% and the loss breakers could never trip.
    const received = tokens > 0 && side === 'sell' ? await this.solReceived(sig) : null;
    if (received !== null && received > 0) return { priceUsd: (received * solUsd) / tokens, at };
    // enhanced parse unavailable — market price is the least-wrong fallback
    const market = await this.quote(mint);
    this.log.warn(`fill for ${sig} not parseable — falling back to market price`);
    return { priceUsd: market ?? 0, at };
  }

  /**
   * SOL the executor wallet netted from a confirmed swap: its own lamport change,
   * with the network fee added back so a sell is priced like a buy (swap
   * economics — slippage, developer fee, tips — but not the signature fee).
   * Not summed from parsed transfers: an unwrap lists the same SOL twice, once
   * as a WSOL transfer and once as a native one. Checked against five real
   * Jupiter sells, where the transfer sum came out at double.
   */
  private async solReceived(sig: string): Promise<number | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = await this.rpc<{ meta: { fee: number; preBalances: number[]; postBalances: number[] } | null }>('getTransaction', [
        sig,
        { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      // the fee payer — our keypair — is always account 0
      if (tx?.meta) return (tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee) / LAMPORTS;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return null;
  }

  private async balanceSol(address: string): Promise<number | null> {
    const r = await this.rpc<{ value: number }>('getBalance', [address]);
    return r ? r.value / LAMPORTS : null;
  }

  private async tokenBalanceRaw(owner: string, mint: string): Promise<string | null> {
    const r = await this.rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
      'getTokenAccountsByOwner',
      [owner, { mint }, { encoding: 'jsonParsed' }],
    );
    return r?.value?.[0]?.account.data.parsed.info.tokenAmount.amount ?? null;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    const key = this.env.get<string>('HELIUS_API_KEY');
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
    if (body?.error) {
      this.log.error(`${method}: ${body.error.message}`);
      return null;
    }
    return body?.result ?? null;
  }

  private async configSlippagePct(): Promise<number> {
    const row = await this.prisma.opportunityConfig.findUnique({ where: { id: 1 } });
    return OpportunityConfigSchema.parse(row ? JSON.parse(row.data) : {}).slippagePct;
  }
}
