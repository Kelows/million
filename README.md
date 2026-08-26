# million — whale intel deck

On-chain wallet intelligence for meme-coin whale tracking. Monorepo:

- `apps/web` — React dashboard (Vite, TanStack Router/Query, Tailwind v4)
- `apps/api` — NestJS API (Prisma + SQLite, Helius for on-chain data)
- `packages/shared` — zod schemas + types shared by web and api

## Setup

```sh
npm install
cp apps/api/.env.example apps/api/.env   # add your HELIUS_API_KEY (free tier: https://helius.dev)
npm run db:push
npm run dev
```

Web on http://localhost:5173, API on http://localhost:3001/api.

## v1 scope

Wallet analyzer: import a JSON list of whale wallets, analyze their swap history
(win rate, realized PnL, hold times, red flags). Screener and executor pages are
scaffolded but not wired — see TODO.md for the roadmap.
