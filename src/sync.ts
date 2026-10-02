import fs from 'node:fs';
import path from 'node:path';
import { Config, State, loadState, readJson, saveState, writeJson } from './config.js';
import { listJsonlRecursive, slugDirFor } from './claudePaths.js';
import { NETWORK_TIMEOUT_MS, git, gitOk } from './gitRepo.js';
import { folderForKey, projectKeyFor } from './identity.js';
import { acquireLock } from './lock.js';
import { log } from './log.js';
import { loadRegistry, remember, resolveLocalPath, saveRegistry } from './registry.js';
import { loadDeleted, removeLocalSession } from './tombstones.js';
import { detokenize, tokenize } from './transform.js';
import {
  CONFLICT_RE,
  conflictIsRedundant,
  isConflictFile,
  listLocalProjects,
  mergeInto,
  pruneRedundantConflicts,
  readText,
} from './transcripts.js';

interface ProjectMeta {
  key: string;
}

interface MachineEntry {
  project: string;
  pushedAt: string;
}

export interface SyncOptions {
  /** how long to wait for another sync to finish (0 = skip immediately) */
  waitMs: number;
}

export const sessionsDir = (repo: string) => path.join(repo, 'sessions');
const machinesDir = (repo: string) => path.join(repo, 'machines');
const machineFile = (repo: string, id: string) => path.join(machinesDir(repo), `${folderForKey(id)}.json`);

function fileSig(file: string, extra = ''): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}${extra}`;
  } catch {
    return null;
  }
}

async function hasUpstream(repo: string): Promise<boolean> {
  const r = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo);
  return r.code === 0;
}

/**
 * Make the local clone identical to the remote. The clone is only a cache of
 * what's on the remote plus what we derive from ~/.claude/projects, so a hard
 * reset never loses anything the user owns.
 */
export async function resetToRemote(repo: string): Promise<void> {
  if (!fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`Sessions repo clone missing at ${repo}. Run init again.`);
  }
  await gitOk(['fetch', '--quiet', 'origin'], repo, NETWORK_TIMEOUT_MS);
  if (await hasUpstream(repo)) {
    await gitOk(['reset', '--quiet', '--hard', '@{u}'], repo);
  }
  await gitOk(['clean', '-fdq'], repo);
}

export async function commitAndPush(repo: string, message: string): Promise<'nothing' | 'pushed' | 'rejected'> {
  const status = await gitOk(['status', '--porcelain'], repo);
  if (!status.trim()) return 'nothing';
  await gitOk(['add', '-A'], repo);
  await gitOk(['commit', '--quiet', '-m', message], repo);
  const args = (await hasUpstream(repo)) ? ['push', '--quiet'] : ['push', '--quiet', '-u', 'origin', 'HEAD'];
  const r = await git(args, repo, NETWORK_TIMEOUT_MS);
  if (r.code === 0) return 'pushed';
  if (/rejected|non-fast-forward|fetch first/i.test(r.stderr)) return 'rejected';
  throw new Error(`git push failed: ${r.stderr.trim()}`);
}

interface PushRound {
  written: number;
  /** size of the transcripts written into the clone, for the progress message */
  bytes: number;
  conflicts: string[];
  cache: Record<string, string>;
}

/** Copy local transcripts into the repo clone (tokenized), per the merge rule. */
async function applyLocalToRepo(cfg: Config, state: State): Promise<PushRound> {
  const repo = cfg.repoDir;
  const reg = loadRegistry();
  const mFile = machineFile(repo, cfg.machineId);
  const machines = readJson<Record<string, MachineEntry>>(mFile, {});
  const round: PushRound = { written: 0, bytes: 0, conflicts: [], cache: {} };
  const now = new Date().toISOString();
  const deleted = loadDeleted(repo);

  for (const p of listLocalProjects()) {
    if (!p.cwd) {
      log.debug(`skip ${p.slug}: no cwd in transcripts`);
      continue;
    }
    const key = await projectKeyFor(p.cwd);
    if (fs.existsSync(p.cwd)) remember(reg, key, p.cwd, 'transcript');
    const folder = folderForKey(key);
    const projDir = path.join(sessionsDir(repo), folder);

    for (const f of p.files) {
      if (deleted.has(f.sessionId)) continue; // removed locally on the next pull
      const sig = fileSig(f.abs);
      if (!sig) continue;
      if (state.pushCache[f.abs] === sig) continue;
      const incoming = tokenize(readText(f.abs), p.cwd);
      const dest = path.join(projDir, ...f.rel.split('/'));
      const res = mergeInto(dest, incoming, cfg.machineId);
      if (res === 'written') {
        round.written++;
        round.bytes += incoming.length;
        machines[f.sessionId] = { project: folder, pushedAt: now };
      } else if (res === 'conflict') {
        round.conflicts.push(`${key}/${f.rel}`);
        log.warn(
          `session ${f.sessionId} (${key}) was continued on two machines; ` +
            `saved this machine's copy as a .conflict-${cfg.machineId}.jsonl file in the repo instead of overwriting`,
        );
      }
      round.cache[f.abs] = sig;
    }
    const metaFile = path.join(projDir, '.project.json');
    if (fs.existsSync(projDir) && !fs.existsSync(metaFile)) writeJson(metaFile, { key } satisfies ProjectMeta);
  }

  if (round.written) writeJson(mFile, machines);
  saveRegistry(reg);
  return round;
}

async function doPush(cfg: Config): Promise<void> {
  const state = loadState();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await resetToRemote(cfg.repoDir);
    const round = await applyLocalToRepo(cfg, state);
    const pruned = pruneRedundantConflicts(sessionsDir(cfg.repoDir));
    if (pruned) log.debug(`removed ${pruned} redundant conflict copy(ies) from the repo`);
    if (round.bytes > 5 * 1024 * 1024) {
      log.info(`uploading ${round.written} transcript file(s), ${Math.round(round.bytes / 1024 / 1024)} MB ...`);
    }
    const result = await commitAndPush(cfg.repoDir, `${cfg.machineId} push ${new Date().toISOString()}`);
    if (result === 'rejected') {
      log.debug(`push rejected (attempt ${attempt}), retrying on top of the new remote state`);
      continue;
    }
    Object.assign(state.pushCache, round.cache);
    state.conflicts = [...new Set([...state.conflicts, ...round.conflicts])];
    state.lastPush = new Date().toISOString();
    saveState(state);
    const conflictNote = round.conflicts.length ? `, ${round.conflicts.length} conflict copy(ies)` : '';
    log.info(result === 'pushed' ? `pushed ${round.written} transcript file(s)${conflictNote}` : 'push: nothing new');
    return;
  }
  throw new Error('push rejected 3 times (another machine kept pushing); will retry next run');
}

/** sessionId -> machine that pushed it most recently, from machines/*.json. */
function sessionOrigins(repo: string): Map<string, string> {
  const out = new Map<string, { machine: string; at: string }>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(machinesDir(repo)).filter((f) => f.endsWith('.json'));
  } catch {
    // no machines yet
  }
  for (const f of files) {
    const machine = f.replace(/\.json$/, '');
    const entries = readJson<Record<string, MachineEntry>>(path.join(machinesDir(repo), f), {});
    for (const [sid, e] of Object.entries(entries)) {
      const prev = out.get(sid);
      if (!prev || e.pushedAt > prev.at) out.set(sid, { machine, at: e.pushedAt });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.machine]));
}

async function doPull(cfg: Config): Promise<void> {
  const repo = cfg.repoDir;
  const state = loadState();
  await resetToRemote(repo);
  const deleted = loadDeleted(repo);
  for (const id of deleted) {
    // Every pull, so a deleted session that was still open here doesn't linger.
    if (removeLocalSession(id)) log.info(`removed session ${id} (deleted with \`syncerbytugu delete\`)`);
  }
  const reg = loadRegistry();
  const origins = sessionOrigins(repo);
  const ownConflictSuffix = `.conflict-${folderForKey(cfg.machineId)}.jsonl`;
  const unmapped: string[] = [];
  let written = 0;
  const conflicts: string[] = [];

  let folders: string[] = [];
  try {
    folders = fs.readdirSync(sessionsDir(repo));
  } catch {
    // empty repo
  }
  for (const folder of folders) {
    const projDir = path.join(sessionsDir(repo), folder);
    const meta = readJson<ProjectMeta | null>(path.join(projDir, '.project.json'), null);
    if (!meta?.key) continue;
    const root = resolveLocalPath(reg, meta.key);
    if (!root || !fs.existsSync(root)) {
      unmapped.push(meta.key);
      continue;
    }
    const slugDir = slugDirFor(root);
    for (const rel of listJsonlRecursive(projDir)) {
      if (rel.endsWith(ownConflictSuffix)) continue; // our own copy, already local
      const src = path.join(projDir, ...rel.split('/'));
      if (isConflictFile(rel) && conflictIsRedundant(src)) continue; // nothing the main copy lacks
      const dest = path.join(slugDir, ...rel.split('/'));
      const sig = fileSig(src, `:${root}`);
      if (sig && state.pullCache[rel + '|' + folder] === sig && fs.existsSync(dest)) continue;

      const sessionId = rel.split('/')[0].replace(CONFLICT_RE, '').replace(/\.jsonl$/, '');
      if (deleted.has(sessionId)) continue;
      const origin = origins.get(sessionId) || 'remote';
      const res = mergeInto(
        dest,
        readText(src),
        origin,
        (local) => tokenize(local, root),
        (incoming) => detokenize(incoming, root),
      );
      if (res === 'written') written++;
      if (res === 'conflict') {
        conflicts.push(`${meta.key}/${rel}`);
        log.warn(
          `session ${sessionId} (${meta.key}): this PC's copy and the synced copy (last pushed by ${origin}) ` +
            `were continued separately; kept this PC's copy and saved the synced one as a .conflict-${origin}.jsonl file`,
        );
      }
      if (sig) state.pullCache[rel + '|' + folder] = sig;
    }
    const pruned = pruneRedundantConflicts(slugDir, (s) => tokenize(s, root));
    if (pruned) log.debug(`removed ${pruned} redundant conflict copy(ies) from ${slugDir}`);
  }

  const newlyUnmapped = unmapped.filter((k) => !state.unmapped.includes(k));
  for (const k of newlyUnmapped) {
    log.info(`project ${k} has no known folder on this PC yet; open it once in Claude Code to map it`);
  }
  state.unmapped = unmapped;
  state.conflicts = [...new Set([...state.conflicts, ...conflicts])];
  state.lastPull = new Date().toISOString();
  saveState(state);
  log.info(written ? `pulled ${written} transcript file(s)` : 'pull: nothing new');
}

async function locked(opts: SyncOptions, what: string, fn: () => Promise<void>): Promise<boolean> {
  const release = await acquireLock(opts.waitMs);
  if (!release) {
    log.debug(`${what}: another sync is running, skipped`);
    return false;
  }
  try {
    await fn();
    return true;
  } finally {
    release();
  }
}

export function push(cfg: Config, opts: SyncOptions): Promise<boolean> {
  return locked(opts, 'push', () => doPush(cfg));
}

export function pull(cfg: Config, opts: SyncOptions): Promise<boolean> {
  return locked(opts, 'pull', () => doPull(cfg));
}

/** Push then pull under one lock; what the scheduled task runs. */
export function sync(cfg: Config, opts: SyncOptions): Promise<boolean> {
  return locked(opts, 'sync', async () => {
    await doPush(cfg);
    await doPull(cfg);
  });
}
