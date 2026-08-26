const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_KEYS = ['address', 'wallet', 'walletAddress', 'trackedWalletAddress', 'pubkey', 'publicKey', 'account', 'owner'];
const FIELD_NAME_RE = /(address|wallet|pubkey|publickey|account|owner|key|mint)$/i;
const LABEL_KEYS = ['label', 'name', 'tag', 'alias', 'nickname'];

export interface ParsedWallet {
  [key: string]: unknown;
  address: string;
  label?: string;
}

/**
 * Best-effort normalizer for whatever shape the whale JSON arrives in:
 * - ["addr", "addr"]
 * - [{ address, label, ...extra }] (any of several address/label key names)
 * - { wallets: [...] } / { whales: [...] } / { data: [...] }
 * - { "some label": "addr" } or { "addr": "some label" }
 */
export function parseWalletsJson(text: string): ParsedWallet[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // fall back to plain text: one address per line / comma-separated
    const found = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
    if (!found.length) throw new Error('Not valid JSON, and no Solana addresses found in the text.');
    return dedupe(found.map((address) => ({ address })));
  }
  const wallets = extract(data);
  if (!wallets.length) throw new Error('Parsed the JSON but found no Solana addresses in it.');
  return dedupe(wallets);
}

function extract(data: unknown): ParsedWallet[] {
  if (Array.isArray(data)) return data.flatMap(fromEntry);
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    // container keys first
    for (const key of ['wallets', 'whales', 'addresses', 'data', 'list']) {
      if (Array.isArray(obj[key])) return (obj[key] as unknown[]).flatMap(fromEntry);
    }
    // { label: address } or { address: label } maps
    const out: ParsedWallet[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && SOL_ADDR.test(v))
        out.push({ address: v, label: SOL_ADDR.test(k) || FIELD_NAME_RE.test(k) ? undefined : k });
      else if (SOL_ADDR.test(k)) out.push({ address: k, label: typeof v === 'string' ? v : undefined });
      else out.push(...extract(v));
    }
    return out;
  }
  return [];
}

function fromEntry(entry: unknown): ParsedWallet[] {
  if (typeof entry === 'string') return SOL_ADDR.test(entry) ? [{ address: entry }] : [];
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const addrKey = ADDRESS_KEYS.find((k) => typeof obj[k] === 'string' && SOL_ADDR.test(obj[k] as string));
    if (addrKey) {
      const labelKey = LABEL_KEYS.find((k) => typeof obj[k] === 'string');
      return [{ address: obj[addrKey] as string, label: labelKey ? (obj[labelKey] as string) : undefined }];
    }
    return extract(entry);
  }
  return [];
}

function dedupe(wallets: ParsedWallet[]): ParsedWallet[] {
  const seen = new Map<string, ParsedWallet>();
  for (const w of wallets) if (!seen.has(w.address)) seen.set(w.address, w);
  return [...seen.values()];
}
