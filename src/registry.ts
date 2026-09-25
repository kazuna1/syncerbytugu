import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson } from './config.js';
import { homePathForKey, projectKeyFor } from './identity.js';

export interface RegistryEntry {
  path: string;
  source: 'scan' | 'hook' | 'transcript';
  updatedAt: string;
}

export type Registry = Record<string, RegistryEntry>;

export function loadRegistry(): Registry {
  return readJson<Registry>(paths.registry(), {});
}

export function saveRegistry(reg: Registry): void {
  writeJson(paths.registry(), reg);
}

/**
 * Record key -> path. A scan never overrides a path we learned from Claude
 * itself (hook or transcript), since that is where the user actually works.
 */
export function remember(reg: Registry, key: string, projectPath: string, source: RegistryEntry['source']): boolean {
  const prev = reg[key];
  if (source === 'scan' && prev) return false;
  if (prev && prev.path === projectPath && prev.source === source) return false;
  reg[key] = { path: projectPath, source, updatedAt: new Date().toISOString() };
  return true;
}

/**
 * Local path for a project key. If the exact key is unknown, walk up
 * (github.com/x/y/sub -> github.com/x/y) and re-append the subfolder.
 */
export function resolveLocalPath(reg: Registry, key: string): string | null {
  if (reg[key]) return reg[key].path;
  const home = homePathForKey(key);
  if (home) return fs.existsSync(home) ? home : null;
  const parts = key.split('/');
  for (let i = parts.length - 1; i >= 2; i--) {
    const parent = parts.slice(0, i).join('/');
    const hit = reg[parent];
    if (hit) return path.join(hit.path, ...parts.slice(i));
  }
  return null;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'library',
  'vendor',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
]);

/** Breadth-first search for git repos under the roots, bounded by depth and time. */
export function findGitRepos(roots: string[], maxDepth = 4, timeoutMs = 10_000): string[] {
  const deadline = Date.now() + timeoutMs;
  const found: string[] = [];
  const seen = new Set<string>();
  let queue: string[] = roots.filter((r) => fs.existsSync(r));
  for (let depth = 0; depth <= maxDepth && queue.length; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (Date.now() > deadline) return found;
      const k = dir.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => e.name === '.git')) found.push(dir);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name.toLowerCase();
        if (name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name)) continue;
        next.push(path.join(dir, e.name));
      }
    }
    queue = next;
  }
  return found;
}

export async function scanIntoRegistry(reg: Registry, roots: string[]): Promise<number> {
  const repos = findGitRepos(roots);
  let added = 0;
  // Small batches keep the number of concurrent git processes reasonable.
  for (let i = 0; i < repos.length; i += 8) {
    const batch = repos.slice(i, i + 8);
    const keys = await Promise.all(batch.map((r) => projectKeyFor(r)));
    batch.forEach((r, j) => {
      if (remember(reg, keys[j], r, 'scan')) added++;
    });
  }
  return added;
}
