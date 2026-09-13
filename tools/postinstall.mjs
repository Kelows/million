#!/usr/bin/env node
/**
 * Runs after `npm install` / `npm ci`, so a fresh clone is ready to start:
 *
 *  1. build packages/shared (the API and web import its dist/)
 *  2. create apps/api/.env from .env.example if there isn't one
 *  3. create or update the SQLite database and generate the Prisma client
 *
 * Step 3 never accepts data loss. If a schema change would drop data, Prisma
 * refuses; the install still finishes and says what to run, instead of either
 * deleting the database or failing the whole install over it.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = path.join(ROOT, 'apps', 'api');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

run('npm run build -w packages/shared', ROOT);

const env = path.join(API, '.env');
if (!existsSync(env)) {
  copyFileSync(path.join(API, '.env.example'), env);
  console.log('\ncreated apps/api/.env from .env.example — add your HELIUS_API_KEY');
}

try {
  run('npx prisma db push', API);
} catch {
  console.warn(
    '\n⚠ The database was not updated: the schema change would delete data, or Prisma could not run.\n' +
      '  Your data is untouched. Review the message above, then run: npm run db:push -w apps/api\n',
  );
}
