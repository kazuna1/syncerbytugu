import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './config.js';
import { claudeDir, projectsDir } from './claudePaths.js';

/**
 * Deleted sessions. `syncerbytugu delete` writes deleted/<sessionId>.json to
 * the repo; every machine then removes its copy on pull and never pushes that
 * session again. The marker holds no conversation content.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only well-formed session ids are ever used to build paths we delete. */
export function isSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

const deletedDir = (repo: string) => path.join(repo, 'deleted');

export function loadDeleted(repo: string): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(deletedDir(repo))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter(isSessionId),
    );
  } catch {
    return new Set();
  }
}

export function markDeleted(repo: string, sessionId: string, machineId: string): void {
  if (!isSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  writeJson(path.join(deletedDir(repo), `${sessionId}.json`), { deletedAt: new Date().toISOString(), by: machineId });
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/** Remove a session's transcript, its <id>/ folder (subagents, tool results) and conflict copies from each folder. */
function removeFromFolders(folders: string[], sessionId: string): number {
  let n = 0;
  for (const dir of folders) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const ours =
        name === `${sessionId}.jsonl` ||
        name === sessionId ||
        (name.startsWith(`${sessionId}.conflict-`) && name.endsWith('.jsonl'));
      if (!ours) continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** Delete everything Claude Code keeps for a session on this machine. Returns how many entries were removed. */
export function removeLocalSession(sessionId: string): number {
  if (!isSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  let n = removeFromFolders(subdirs(projectsDir()), sessionId);
  for (const sub of ['file-history', 'session-env']) {
    const p = path.join(claudeDir(), sub, sessionId);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** Delete a session's files from every project folder in the repo clone. */
export function removeRepoSession(sessionsDir: string, sessionId: string): number {
  if (!isSessionId(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return removeFromFolders(subdirs(sessionsDir), sessionId);
}
