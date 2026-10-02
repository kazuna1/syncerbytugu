import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { APP, Config, readJson } from './config.js';
import { projectKeyFor } from './identity.js';
import { acquireLock } from './lock.js';
import { log } from './log.js';
import { commitAndPush, resetToRemote, sessionsDir } from './sync.js';
import { isSessionId, loadDeleted, markDeleted, removeLocalSession, removeRepoSession } from './tombstones.js';
import { isConflictFile, listLocalProjects, readText, sessionInfo } from './transcripts.js';

interface Candidate {
  id: string;
  key: string;
  title: string;
  updated: string;
}

/** Every session known here or in the repo, newest first. Repo info is used only when there's no local copy. */
async function candidates(repo: string): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();
  for (const p of listLocalProjects()) {
    const key = p.cwd ? await projectKeyFor(p.cwd) : p.slug;
    for (const f of p.files) {
      if (f.rel.includes('/')) continue; // subagent transcripts belong to their session
      out.set(f.sessionId, { id: f.sessionId, key, ...sessionInfo(readText(f.abs)) });
    }
  }
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(sessionsDir(repo));
  } catch {
    // empty repo
  }
  for (const folder of folders) {
    const dir = path.join(sessionsDir(repo), folder);
    const key = readJson<{ key?: string }>(path.join(dir, '.project.json'), {}).key || folder;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl') || isConflictFile(name)) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!out.has(id)) out.set(id, { id, key, ...sessionInfo(readText(path.join(dir, name))) });
    }
  }
  const deleted = loadDeleted(repo);
  return [...out.values()].filter((c) => !deleted.has(c.id)).sort((a, b) => b.updated.localeCompare(a.updated));
}

function describe(c: Candidate): string {
  const title = c.title.length > 60 ? c.title.slice(0, 57) + '...' : c.title;
  return `${c.updated.slice(0, 10) || '          '}  ${c.key}  "${title}"`;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function choose(all: Candidate[], idArg: string | undefined, showAll: boolean): Promise<Candidate | null> {
  if (idArg) {
    const hits = all.filter((c) => c.id.toLowerCase().startsWith(idArg.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${idArg}" matches ${hits.length} sessions; type more of the id.`);
    throw new Error(`No session found with id "${idArg}". Run \`${APP} delete\` to pick from a list.`);
  }
  if (!process.stdin.isTTY) throw new Error(`Pass a session id: ${APP} delete <session-id>`);

  const here = await projectKeyFor(process.cwd());
  const local = all.filter((c) => c.key === here);
  const list = showAll || local.length === 0 ? all : local;
  if (list.length === 0) {
    console.log('No synced sessions found.');
    return null;
  }
  console.log(list === local ? `Sessions for ${here} (use --all for every project):\n` : 'All sessions:\n');
  list.forEach((c, i) => console.log(`  ${String(i + 1).padStart(3)}  ${describe(c)}`));
  const n = Number(await ask('\nNumber to delete (Enter to cancel): '));
  return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null;
}

/**
 * Delete a session on this machine and from the repo, and leave a marker so
 * every other machine deletes its copy on its next pull.
 */
export async function deleteSession(cfg: Config, opts: { id?: string; all: boolean; yes: boolean }): Promise<void> {
  const release = await acquireLock(30_000);
  if (!release) throw new Error('Another sync is running; try again in a moment.');
  try {
    const repo = cfg.repoDir;
    await resetToRemote(repo);
    const target = await choose(await candidates(repo), opts.id, opts.all);
    if (!target) {
      console.log('Nothing deleted.');
      return;
    }
    if (!isSessionId(target.id)) throw new Error(`Unexpected session file name: ${target.id}`);
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error('Add --yes to delete without a prompt.');
      console.log(`\n${describe(target)}\n  ${target.id}`);
      const ans = await ask('Delete this conversation on this PC, in the repo, and on every synced machine? [y/N] ');
      if (!/^y(es)?$/i.test(ans)) {
        console.log('Nothing deleted.');
        return;
      }
    }

    const removedLocal = removeLocalSession(target.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await resetToRemote(repo);
      removeRepoSession(sessionsDir(repo), target.id);
      markDeleted(repo, target.id, cfg.machineId);
      const res = await commitAndPush(repo, `${cfg.machineId} delete ${target.id}`);
      if (res === 'rejected') continue;
      log.info(
        `Deleted "${target.title}" (${target.key}) ${removedLocal ? 'on this PC and' : 'from'} the repo. ` +
          'Other machines delete their copy on their next sync.',
      );
      log.info('If this conversation is open in Claude Code anywhere, exit it there.');
      return;
    }
    throw new Error('The repo kept changing while deleting; run the command again.');
  } finally {
    release();
  }
}
