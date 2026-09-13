#!/usr/bin/env node
/**
 * npx create-million [folder] — a running million deck from nothing:
 * clone, Node 24 LTS (through nvm when the current Node isn't 24), install, the
 * Helius key (hidden input, checked, never printed), then start.
 *
 * Node built-ins only: whatever runs `npx` has to be enough to run this.
 *
 *   npx create-million              → ./million
 *   npx create-million my-deck --no-start
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const REPO = 'https://github.com/Kelows/million.git';
const NODE_MAJOR = 24; // must match the repo's .nvmrc

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const dirArg = args.find((a) => !a.startsWith('--'));
const target = path.resolve(dirArg ?? 'million');
const interactive = process.stdin.isTTY && process.stdout.isTTY;

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const neon = (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const step = (s) => console.log(`\n${neon('›')} ${bold(s)}`);
const fail = (s) => {
  console.error(`\n✗ ${s}`);
  process.exit(1);
};

if (flag('help') || flag('h')) {
  console.log(`
  ${bold('npx create-million')} [folder] [--no-start]

  Clones million (an open-source Solana whale tracker and copy-trading deck),
  installs it on Node ${NODE_MAJOR}, asks for your free Helius API key and starts it.

  folder       where to put it (default: ./million)
  --no-start   set everything up, don't start the deck
`);
  process.exit(0);
}

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const nvmScript = () => {
  const p = path.join(process.env.NVM_DIR ?? path.join(homedir(), '.nvm'), 'nvm.sh');
  return existsSync(p) ? p : null;
};

/** Run a command on the pinned Node: directly if that's what's running, through nvm otherwise. */
function onPinnedNode(command, cwd, { inherit = true } = {}) {
  const current = Number(process.versions.node.split('.')[0]);
  const nvm = nvmScript();
  if (current === NODE_MAJOR && !nvm) {
    return spawnSync('sh', ['-c', command], { cwd, stdio: inherit ? 'inherit' : 'pipe' });
  }
  if (!nvm) return null;
  // nvm is a shell function: source it, pick .nvmrc's version, run with it
  return spawnSync('bash', ['-c', `. "${nvm}" >/dev/null && nvm install >/dev/null && nvm exec --silent ${command}`], {
    cwd,
    stdio: inherit ? 'inherit' : 'pipe',
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      // echo the prompt, never what's typed
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function heliusKeyWorks(key) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return res?.ok ?? false;
}

async function main() {
  console.log(`\n${bold('million')} ${dim('· open-source Solana whale tracker and copy-trading deck')}`);

  // ── 1. prerequisites ──
  if (!has('git')) fail('git is needed: https://git-scm.com/downloads');
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== NODE_MAJOR && !nvmScript()) {
    fail(
      `million runs on Node ${NODE_MAJOR} and this is Node ${major}, without nvm to switch.\n` +
        `  Install nvm (https://github.com/nvm-sh/nvm), open a new terminal, then run npx create-million again.`,
    );
  }

  // ── 2. clone ──
  if (existsSync(target) && readdirSync(target).length > 0) {
    if (existsSync(path.join(target, 'apps', 'api', 'package.json'))) {
      console.log(dim(`\n${target} already has million in it: skipping the clone.`));
    } else {
      fail(`${target} exists and isn't empty. Pick another folder: npx create-million <folder>`);
    }
  } else {
    step(`Cloning into ${path.relative(process.cwd(), target) || '.'}`);
    try {
      execFileSync('git', ['clone', '--depth', '1', REPO, target], { stdio: 'inherit' });
    } catch {
      fail('git clone failed (see above).');
    }
  }

  // ── 3. install on the pinned Node ──
  step(`Installing on Node ${NODE_MAJOR} (a few minutes the first time)`);
  const install = onPinnedNode('npm install', target);
  if (!install || install.status !== 0) fail('npm install failed (see above). Fix it, then run `npm install` inside the folder.');

  // ── 4. Helius key ──
  const envPath = path.join(target, 'apps', 'api', '.env');
  if (!existsSync(envPath)) fail(`${envPath} wasn't created by the install.`);
  let env = readFileSync(envPath, 'utf8');
  const hasKey = /^HELIUS_API_KEY="?[^"\s]+"?\s*$/m.test(env);
  if (hasKey) {
    console.log(dim('\nA Helius key is already set in apps/api/.env.'));
  } else if (interactive) {
    step('Helius API key');
    console.log('  The deck reads the chain through Helius. A free key takes two minutes:');
    console.log(`  ${neon('https://dashboard.helius.dev')}  (it stays on this machine)`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = await askHidden('  Paste it here (hidden), or press Enter to add it later: ');
      if (!key) {
        console.log(dim('  Skipped. Add HELIUS_API_KEY to apps/api/.env before starting.'));
        break;
      }
      if (await heliusKeyWorks(key)) {
        env = /^HELIUS_API_KEY=.*$/m.test(env) ? env.replace(/^HELIUS_API_KEY=.*$/m, `HELIUS_API_KEY="${key}"`) : `HELIUS_API_KEY="${key}"\n${env}`;
        writeFileSync(envPath, env);
        console.log('  ✓ key works, saved to apps/api/.env');
        break;
      }
      console.log('  ✗ Helius didn\'t accept that key. Check it and paste again.');
    }
  }

  const ready = /^HELIUS_API_KEY="?[^"\s]+"?\s*$/m.test(readFileSync(envPath, 'utf8'));
  const rel = path.relative(process.cwd(), target) || '.';

  // ── 5. start ──
  const next = () => {
    console.log(`\n${bold('Next')}`);
    console.log(`  cd ${rel} && claude        ${dim('(or codex, gemini…) then type: set me up')}`);
    console.log(`  cd ${rel} && nvm use && npm start   ${dim('to start the deck by hand')}`);
    console.log(`  ${dim('The deck opens at http://localhost:5173 · guide: docs/GUIDE.md')}\n`);
  };

  if (flag('no-start') || !interactive || !ready) {
    if (!ready) console.log(`\n${neon('!')} Add your Helius key to ${path.join(rel, 'apps/api/.env')} first.`);
    next();
    return;
  }
  const answer = (await ask(`\nStart the deck now? ${dim('[Y/n]')} `)).toLowerCase();
  if (answer === 'n' || answer === 'no') {
    next();
    return;
  }
  console.log(dim(`\nStarting. The deck opens at http://localhost:5173 · Ctrl+C to stop.\n`));
  const runner = 'npm start'; // mprocs comes with the install
  const nvm = nvmScript();
  const child = nvm
    ? spawn('bash', ['-c', `. "${nvm}" >/dev/null && nvm use >/dev/null && exec ${runner}`], { cwd: target, stdio: 'inherit' })
    : spawn('sh', ['-c', `exec ${runner}`], { cwd: target, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => fail(e?.message ?? String(e)));
