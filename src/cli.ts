#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, requireConfig } from './config.js';
import { projectKeyFor } from './identity.js';
import { log, setQuiet } from './log.js';
import { loadRegistry, remember, saveRegistry } from './registry.js';
import { deleteSession } from './deleteCmd.js';
import { init, status, uninstall } from './setup.js';
import { currentVersion, update } from './update.js';
import { pull, push, sync } from './sync.js';
import { countLines, listLocalProjects, readText } from './transcripts.js';

const HELP = `${APP} — sync Claude Code conversations between your computers via a private git repo

Usage:
  ${APP} init <private-repo-url>   one-time setup on each PC
  ${APP} status                    show what is synced and what is installed
  ${APP} push [--quiet]            upload local sessions (runs automatically on Claude exit)
  ${APP} pull [--quiet]            download sessions from other PCs (runs every few minutes)
  ${APP} sync [--quiet]            push then pull
  ${APP} list                      list local sessions with their project keys
  ${APP} delete [<session-id>]     delete a conversation here, in the repo, and on every machine
                                   (no id: pick from this project's sessions; --all for every
                                   project; --yes skips the confirmation)
  ${APP} update                    update ${APP} (from npm, or git pull + build for a git checkout)
  ${APP} uninstall [--purge|--keep]
  ${APP} register                  (used by the Claude Code SessionStart hook)

Options for init:
  --machine <name>   name for this PC (default: hostname)
  --allow-public     do not refuse a public GitHub repo (NOT recommended)
`;

/** Hook stdin is a JSON object with a cwd field; don't block if nothing arrives. */
async function readHookCwd(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let data = '';
    const done = () => {
      try {
        const cwd = (JSON.parse(data) as { cwd?: unknown }).cwd;
        resolve(typeof cwd === 'string' && cwd ? cwd : null);
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(() => {
      process.stdin.destroy();
      done();
    }, 150);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function register(): Promise<void> {
  const cwd = (await readHookCwd()) || process.cwd();
  const key = await projectKeyFor(cwd);
  const reg = loadRegistry();
  if (remember(reg, key, cwd, 'hook')) saveRegistry(reg);
  log.debug(`register ${key} -> ${cwd}`);
}

/**
 * Before a pull, record the current folder if it is a git project, so
 * `claude -r` (via a pull-first alias) in a freshly cloned project finds its
 * sessions on the first try. Folders without a remote are skipped: scheduled
 * runs start in places like System32 or the home folder.
 */
async function registerCwd(): Promise<void> {
  try {
    const cwd = process.cwd();
    const key = await projectKeyFor(cwd);
    if (key === 'home' || key.startsWith('home/') || key.startsWith('name/')) return;
    const reg = loadRegistry();
    if (remember(reg, key, cwd, 'hook')) saveRegistry(reg);
  } catch (e) {
    log.debug(`registerCwd failed: ${(e as Error).message}`);
  }
}

/** Re-launch ourselves detached so the Claude Code hook returns immediately. */
function background(args: string[]): void {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function list(): Promise<void> {
  for (const p of listLocalProjects()) {
    const key = p.cwd ? await projectKeyFor(p.cwd) : '(no cwd)';
    console.log(`\n${p.slug}\n  cwd: ${p.cwd ?? '?'}\n  key: ${key}`);
    for (const f of p.files) console.log(`  ${f.rel}  (${countLines(readText(f.abs))} lines)`);
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--machine');
  const cmd = positional[0];
  const quiet = flags.has('--quiet');
  setQuiet(quiet);

  switch (cmd) {
    case 'init': {
      const url = positional[1];
      if (!url) {
        console.error(`Usage: ${APP} init <private-repo-url>`);
        return 1;
      }
      const mi = argv.indexOf('--machine');
      await init(url, { allowPublic: flags.has('--allow-public'), machineId: mi >= 0 ? argv[mi + 1] : undefined });
      return 0;
    }
    case 'push':
    case 'pull':
    case 'sync': {
      if (flags.has('--background')) {
        background([cmd, '--quiet']);
        return 0;
      }
      const cfg = requireConfig();
      if (cmd !== 'push') await registerCwd();
      const fn = { push, pull, sync }[cmd];
      // Interactive and hook-triggered runs wait for a running sync; scheduled ones just skip.
      const ran = await fn(cfg, { waitMs: cmd === 'push' || !quiet ? 30_000 : 0 });
      if (!ran && !quiet) console.log('Another sync is running; try again in a moment.');
      return 0;
    }
    case 'register':
      try {
        await register();
      } catch (e) {
        log.debug(`register failed: ${(e as Error).message}`);
      }
      return 0; // never break a Claude Code session start
    case 'delete':
      await deleteSession(requireConfig(), { id: positional[1], all: flags.has('--all'), yes: flags.has('--yes') });
      return 0;
    case 'update':
      await update();
      return 0;
    case 'status':
      await status();
      return 0;
    case 'list':
      await list();
      return 0;
    case 'uninstall':
      await uninstall({ purge: flags.has('--purge'), keep: flags.has('--keep') });
      return 0;
    case undefined:
      if (flags.has('--version') || flags.has('-v')) {
        console.log(currentVersion());
        return 0;
      }
      console.log(HELP);
      return 0;
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    log.error(e.message);
    log.debug(e.stack || '');
    process.exit(1);
  },
);
