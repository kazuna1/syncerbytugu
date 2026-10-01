import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { APP, Config, appHome, defaultScanRoots, loadConfig, loadState, paths, saveConfig } from './config.js';
import { NETWORK_TIMEOUT_MS, git, gitInstalled, gitOk } from './gitRepo.js';
import { hooksInstalled, installHooks, uninstallHooks } from './hooks.js';
import { normalizeRemote } from './identity.js';
import { log } from './log.js';
import { loadRegistry, saveRegistry, scanIntoRegistry } from './registry.js';
import { scheduler } from './scheduler/index.js';
import { sync } from './sync.js';

const README = `# Private — managed by ${APP}

This repo holds Claude Code conversation transcripts synced between your machines.
Transcripts contain everything typed or pasted into Claude. **Never make this repo public.**
`;

// Transcripts must be stored byte-for-byte: no CRLF conversion, no diffs of huge lines.
const GITATTRIBUTES = '* -text\n*.jsonl -diff\n';

/** Best effort: refuse a GitHub repo that is readable without credentials. */
async function isPublicGithubRepo(url: string): Promise<boolean> {
  const key = normalizeRemote(url);
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(key);
  if (!m) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': APP },
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { private?: boolean };
    return body.private === false;
  } catch {
    return false;
  }
}

async function prepareClone(cfg: Config): Promise<void> {
  const repo = cfg.repoDir;
  if (fs.existsSync(path.join(repo, '.git'))) {
    const current = (await git(['remote', 'get-url', 'origin'], repo)).stdout.trim();
    if (normalizeRemote(current) !== normalizeRemote(cfg.repoUrl)) {
      throw new Error(`${repo} is a clone of ${current}, not ${cfg.repoUrl}. Move it away or run \`${APP} uninstall\` first.`);
    }
  } else {
    if (fs.existsSync(repo) && fs.readdirSync(repo).length) {
      throw new Error(`${repo} exists and is not a git clone. Move it away and retry.`);
    }
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    log.info('Downloading the sessions repo (a large history can take a few minutes) ...');
    await gitOk(['clone', '--quiet', cfg.repoUrl, repo], undefined, NETWORK_TIMEOUT_MS);
  }
  await gitOk(['config', 'core.autocrlf', 'false'], repo);
  await gitOk(['config', 'user.name', `${APP} (${cfg.machineId})`], repo);
  await gitOk(['config', 'user.email', `${APP}@${cfg.machineId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.local`], repo);

  const empty = (await git(['rev-parse', '--verify', 'HEAD'], repo)).code !== 0;
  if (empty) {
    fs.writeFileSync(path.join(repo, 'README.md'), README, 'utf8');
    fs.writeFileSync(path.join(repo, '.gitattributes'), GITATTRIBUTES, 'utf8');
    await gitOk(['add', '-A'], repo);
    await gitOk(['commit', '--quiet', '-m', `${cfg.machineId}: initialize sessions repo`], repo);
    await gitOk(['push', '--quiet', '-u', 'origin', 'HEAD'], repo);
  }
}

export async function init(repoUrl: string, flags: { allowPublic: boolean; machineId?: string }): Promise<void> {
  if (!(await gitInstalled())) throw new Error('git is not installed or not on PATH. Install it from https://git-scm.com and retry.');

  log.info(`Checking access to ${repoUrl} ...`);
  const probe = await git(['ls-remote', repoUrl], undefined, 30_000);
  if (probe.code !== 0) {
    throw new Error(
      `Cannot access ${repoUrl} without a prompt.\n${probe.stderr.trim()}\n\n` +
        'Fix: make sure plain `git clone <url>` works in a terminal without asking for a password.\n' +
        '  - HTTPS: sign in once with Git Credential Manager (run `git clone <url>` and complete the login).\n' +
        '  - SSH: add your key to the ssh-agent / GitHub and use the git@github.com:... URL.',
    );
  }
  if (!flags.allowPublic && (await isPublicGithubRepo(repoUrl))) {
    throw new Error(
      `${repoUrl} is PUBLIC. Your transcripts contain everything you typed or pasted into Claude.\n` +
        'Make the repo private on GitHub and run init again.',
    );
  }

  const prev = loadConfig();
  const cfg: Config = {
    repoUrl,
    repoDir: prev?.repoDir || paths.repo(),
    machineId: flags.machineId || prev?.machineId || os.hostname(),
    scanRoots: prev?.scanRoots || defaultScanRoots(),
    intervalMinutes: prev?.intervalMinutes || 5,
  };
  saveConfig(cfg);
  await prepareClone(cfg);
  log.info(`Sessions repo ready at ${cfg.repoDir}`);

  log.info('Looking for your projects ...');
  const reg = loadRegistry();
  const added = await scanIntoRegistry(reg, cfg.scanRoots);
  saveRegistry(reg);
  log.info(`Found ${added} new project folder(s); ${Object.keys(reg).length} known in total.`);

  installHooks();
  log.info('Claude Code hooks installed (push on exit, register on start).');

  try {
    if (process.env.SYNCERBYTUGU_NO_SCHEDULER) throw new Error('SYNCERBYTUGU_NO_SCHEDULER set; background sync not scheduled.');
    await scheduler().install(cfg.intervalMinutes);
    log.info(`Background sync scheduled every ${cfg.intervalMinutes} min and at logon.`);
  } catch (e) {
    log.warn((e as Error).message);
  }

  log.info('Running first sync (the first upload of a large history can take a few minutes) ...');
  await sync(cfg, { waitMs: 30_000 });

  log.info(
    `\nDone. Machine "${cfg.machineId}" is syncing with ${repoUrl}.\n` +
      'Nothing else to do: exit Claude here, then `claude --resume` in the same project on your other PC.',
  );
}

export async function status(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.log(`Not initialized. Run: ${APP} init <private-repo-url>`);
    return;
  }
  const state = loadState();
  const reg = loadRegistry();
  const sched = await scheduler().status();
  let sessions = 0;
  let projects = 0;
  try {
    for (const d of fs.readdirSync(path.join(cfg.repoDir, 'sessions'))) {
      projects++;
      sessions += fs.readdirSync(path.join(cfg.repoDir, 'sessions', d)).filter((f) => f.endsWith('.jsonl')).length;
    }
  } catch {
    // nothing synced yet
  }
  const yes = (b: boolean) => (b ? 'yes' : 'NO');
  console.log(
    [
      `machine         ${cfg.machineId}`,
      `repo            ${cfg.repoUrl}`,
      `local clone     ${cfg.repoDir}`,
      `last push       ${state.lastPush || 'never'}`,
      `last pull       ${state.lastPull || 'never'}`,
      `in repo         ${projects} project(s), ${sessions} session(s)`,
      `known projects  ${Object.keys(reg).length} on this PC`,
      `hooks           ${yes(hooksInstalled())}`,
      `scheduled sync  interval: ${yes(sched.interval)}, logon: ${yes(sched.logon)}`,
      `log             ${paths.log()}`,
    ].join('\n'),
  );
  if (state.unmapped.length) {
    console.log(`\nNot on this PC yet (open once in Claude Code, or clone them):\n  ${state.unmapped.join('\n  ')}`);
  }
  if (state.conflicts.length) {
    console.log(`\nConflicts (session continued on two PCs; both copies kept):\n  ${state.conflicts.join('\n  ')}`);
  }
}

export async function uninstall(flags: { purge?: boolean; keep?: boolean }): Promise<void> {
  if (uninstallHooks()) log.info('Removed our hooks from Claude Code settings.');
  await scheduler().uninstall();
  log.info('Removed scheduled background sync.');

  let purge = flags.purge === true;
  if (!flags.purge && !flags.keep && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Delete ${appHome()} (local clone, config, logs)? [y/N] `);
    rl.close();
    purge = /^y(es)?$/i.test(ans.trim());
  }
  if (purge) {
    fs.rmSync(appHome(), { recursive: true, force: true });
    console.log(`Deleted ${appHome()}.`);
  } else {
    console.log(`Kept ${appHome()}.`);
  }
  console.log('Your Claude Code transcripts in ~/.claude/projects were not touched.');
}
