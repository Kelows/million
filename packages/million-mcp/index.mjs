#!/usr/bin/env node
/**
 * million-mcp: the million deck as MCP tools, for Claude Desktop, Cursor, and
 * any other MCP client. A thin layer over the deck's local HTTP API
 * (http://localhost:3001/api): it adds no logic of its own, so what a tool
 * returns is exactly what the deck shows.
 *
 * Deliberately absent: anything that touches keys, wallets that sign, or the
 * paper/live switch. Live trading is EXECUTOR=local in apps/api/.env, set by a
 * person, never by a tool.
 *
 *   npx million-mcp            (MILLION_API overrides the API address)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = (process.env.MILLION_API ?? 'http://localhost:3001/api').replace(/\/$/, '');
const VERSION = '1.0.0';
const NOT_RUNNING =
  'The million deck is not running (nothing answered at ' +
  API +
  '). Set it up with `npx create-million`, or start it from its folder with `npm start`. Repo: https://github.com/Kelows/million';

class DeckDown extends Error {}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000), // analysis and buyer discovery take a while
    });
  } catch {
    throw new DeckDown(NOT_RUNNING);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : (data?.message ?? JSON.stringify(data))}`);
  return data;
}

/** Every tool answers with JSON text, or a plain explanation when the deck is down. */
const tool = (fn) => async (args) => {
  try {
    const out = await fn(args ?? {});
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: !(e instanceof DeckDown) };
  }
};

const mint = z.string().min(32).max(44).describe('Solana token mint address (base58)');
const address = z.string().min(32).max(44).describe('Solana wallet address (base58)');

const server = new McpServer(
  { name: 'million', version: VERSION },
  {
    instructions: [
      'million is an open-source, self-hosted Solana whale tracker and copy-trading deck running on the user\'s machine.',
      'Amounts are SOL unless a field says USD. Positions are paper trades unless get_status reports mode "local" (live).',
      'Never present PnL or win rates as a promise: the project found past returns do not predict future ones.',
      'find_token_buyers and analyze_wallet spend the user\'s Helius credits: say so before running many.',
      'Subscribing a wallet is the user\'s decision. Very active wallets flood the feed.',
      'No tool can enable live trading; that is a setting the user changes themselves.',
    ].join(' '),
  },
);

server.registerTool(
  'get_status',
  {
    title: 'Deck status',
    description: 'Is the deck running, paper or live, is the live feed receiving events, how many wallets are followed, and a summary of the book (open positions, realized PnL, risk halt).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const [health, feed, book] = await Promise.all([call('GET', '/health'), call('GET', '/live/status'), call('GET', '/trading')]);
    return { health, feed, mode: book.stats.mode, stats: book.stats, halt: book.halt, openPositions: book.open.length };
  }),
);

server.registerTool(
  'get_book',
  {
    title: 'Positions',
    description: 'Open and closed positions (paper or live) with size, entry and exit prices, PnL and exit reason, plus book statistics.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => call('GET', '/trading')),
);

server.registerTool(
  'get_decisions',
  {
    title: 'Decision log',
    description: 'What the deck decided for recent token events from followed wallets, newest first: signals, opened positions, shadow trades and skips, each with its reason. Kept for 3 days.',
    inputSchema: {
      mint: mint.optional().describe('Only decisions about this token'),
      include_routine: z.boolean().optional().describe('Include routine skips (small buys, relays, transfers). Default false.'),
      limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
    },
    annotations: { readOnlyHint: true },
  },
  tool(({ mint: m, include_routine, limit }) => {
    const q = new URLSearchParams({ limit: String(limit ?? 50) });
    if (m) q.set('mint', m);
    if (include_routine) q.set('quiet', 'true');
    return call('GET', `/opportunities/decisions?${q}`);
  }),
);

server.registerTool(
  'why_not_bought',
  {
    title: 'Why it did or didn\'t buy a token',
    description: 'Everything needed to explain why the deck did or did not buy one token: its decision history (routine skips included), the token\'s check report, any position in it, and the trading rules in force.',
    inputSchema: { mint },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ mint: m }) => {
    const [decisions, token, book, rules] = await Promise.all([
      call('GET', `/opportunities/decisions?mint=${m}&quiet=true&limit=100`),
      call('GET', `/tokens/${m}`).catch(() => null),
      call('GET', '/trading'),
      call('GET', '/opportunities/config'),
    ]);
    const positions = [...book.open, ...(book.closed ?? [])].filter((p) => p.mint === m);
    return {
      decisions,
      token,
      positions,
      rules,
      note: decisions.length ? undefined : 'No followed wallet touched this token in the last 3 days (or the feed was down then).',
    };
  }),
);

server.registerTool(
  'get_rules',
  {
    title: 'Trading rules',
    description: 'The trading rules in force: which signals trade, minimum buy sizes, position sizing, exits (trailing stop, stop loss), exposure caps and risk halts.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => call('GET', '/opportunities/config')),
);

server.registerTool(
  'update_rules',
  {
    title: 'Change trading rules',
    description:
      'Change some trading rule fields (use get_rules for names and current values). Only the given fields change; the deck validates and may clamp values. Applies to new signals; open positions keep their exits. Cannot switch paper to live. Returns each changed field before and after.',
    inputSchema: {
      changes: z.record(z.string(), z.unknown()).describe('Field → new value, e.g. { "positionSol": 0.2, "tradeSignals": "consensus" }'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  tool(async ({ changes }) => {
    const before = await call('GET', '/opportunities/config');
    const unknown = Object.keys(changes).filter((k) => !(k in before));
    if (unknown.length) throw new Error(`Unknown rule field(s): ${unknown.join(', ')}. Call get_rules for the valid names.`);
    const after = await call('PUT', '/opportunities/config', { ...before, ...changes });
    const diff = Object.fromEntries(
      Object.keys(changes)
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
        .map((k) => [k, { before: before[k], after: after[k] }]),
    );
    return { changed: diff, unchanged: Object.keys(changes).filter((k) => !(k in diff)) };
  }),
);

server.registerTool(
  'get_flows',
  {
    title: 'Roster order flow',
    description: 'Tokens the followed wallets are accumulating or distributing right now, counted per owner (clusters of wallets vote once), bots excluded, buys netted against sells.',
    inputSchema: { minutes: z.number().int().min(5).max(240).optional().describe('Window, default 30') },
    annotations: { readOnlyHint: true },
  },
  tool(({ minutes }) => call('GET', `/live/flows?minutes=${minutes ?? 30}`)),
);

server.registerTool(
  'get_roster_holdings',
  {
    title: 'What the roster holds',
    description: 'Tokens the followed wallets still hold, ranked by distinct owners and SOL still in at cost, and where the roster realized profit on round trips it watched close.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  tool(() => call('GET', '/tokens/famous')),
);

server.registerTool(
  'check_token',
  {
    title: 'Run token checks',
    description: 'Run the deck\'s safety checks on a token: mint and freeze authority, liquidity, market cap, holder concentration, deployer history, Jupiter sell simulation, RugCheck. Returns PASS, WARN or FAIL with each check.',
    inputSchema: { mint },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(({ mint: m }) => call('POST', `/tokens/${m}/check`)),
);

server.registerTool(
  'find_token_buyers',
  {
    title: 'Find a token\'s biggest buyers',
    description: 'Size buyers of a token, with a quick analysis preview and flags (bot, fresh wallet, cluster) for the biggest. The way to find wallets worth following. Spends Helius credits.',
    inputSchema: {
      mint,
      min_sol: z.number().min(0).optional().describe('Minimum SOL a buyer spent, default 1'),
      mode: z.enum(['recent', 'deep']).optional().describe('recent: latest transactions; deep: sampled across the token\'s history. Default recent'),
      pages: z.number().int().min(1).max(10).optional().describe('History pages to scan in recent mode, default 3'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(({ mint: m, min_sol, mode, pages }) => call('GET', `/discovery/token/${m}?minSol=${min_sol ?? 1}&mode=${mode ?? 'recent'}&pages=${pages ?? 3}`)),
);

server.registerTool(
  'import_wallets',
  {
    title: 'Add wallets to the roster',
    description: 'Add wallet addresses to the roster (not followed yet). Analyze them, then subscribe the ones the user picks.',
    inputSchema: {
      wallets: z.array(address).min(1).max(500),
      label: z.string().max(60).optional().describe('Source tag, e.g. "found via CATE"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  tool(({ wallets, label }) => call('POST', '/wallets/import', { wallets, source: label ?? 'mcp' })),
);

server.registerTool(
  'analyze_wallet',
  {
    title: 'Analyze a wallet',
    description: 'Fetch a roster wallet\'s trading history and compute its metrics: realized PnL in SOL, win rate, hold times, per-token breakdown and flags (bot, distributor, fresh wallet). Spends Helius credits.',
    inputSchema: { address },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  tool(({ address: a }) => call('POST', `/wallets/${a}/analyze`)),
);

server.registerTool(
  'get_wallet',
  {
    title: 'Wallet details',
    description: 'A roster wallet\'s stored analysis, live activity, subscription state and linked wallets of the same owner.',
    inputSchema: { address },
    annotations: { readOnlyHint: true },
  },
  tool(({ address: a }) => call('GET', `/wallets/${a}`)),
);

server.registerTool(
  'set_wallet_subscription',
  {
    title: 'Follow or unfollow a wallet',
    description: 'Follow (subscribe) or unfollow a roster wallet. Followed wallets feed the live feed and can trigger trades. Only do this when the user asked for that wallet.',
    inputSchema: { address, subscribed: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  tool(({ address: a, subscribed }) => call('PUT', `/wallets/${a}/subscribe`, { subscribed })),
);

await server.connect(new StdioServerTransport());
