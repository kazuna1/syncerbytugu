import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './gitRepo.js';

/**
 * Normalize a git remote URL into a stable project key so the same project
 * matches across PCs regardless of protocol, credentials or case.
 *   git@github.com:KaZuNa1/AirHouse.git  -> github.com/kazuna1/airhouse
 *   https://user:tok@github.com/x/y.git  -> github.com/x/y
 */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\\/g, '/');
  // Local-path remotes (C:/repos/x.git, /srv/x.git, file:///srv/x.git)
  if (/^file:\/\//i.test(u) || /^[a-zA-Z]:\//.test(u) || u.startsWith('/')) {
    u = u.replace(/^file:\/\//i, '').replace(/^\/+/, '');
    return ('local/' + u.replace(/:/g, '')).replace(/\.git\/?$/i, '').replace(/\/+$/, '').toLowerCase();
  }
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // protocol
  u = u.replace(/^[^@/]+@/, ''); // git@ or user:token@
  u = u.replace(/^([^/:]+):(\d+)(\/|$)/, '$1$3'); // host:port/
  u = u.replace(/^([^/:]+):/, '$1/'); // scp-style host:owner/repo
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

/** Repo folder name for a key: '/' and unsafe chars become '_'. */
export function folderForKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Key for a folder without a git remote. Folders inside the home directory
 * (Desktop, Downloads, the home dir itself) are keyed relative to home so they
 * match across PCs with different user names; others fall back to name/<folder>.
 */
export function fallbackKey(projectPath: string, home = os.homedir()): string {
  const rel = path.relative(home, projectPath);
  if (!path.isAbsolute(rel) && !rel.startsWith('..')) {
    return `home/${rel.replace(/\\/g, '/').toLowerCase()}`.replace(/\/$/, '');
  }
  return `name/${path.basename(projectPath.replace(/[\\/]+$/, '')).toLowerCase()}`;
}

/** Local path for a home/... key on this PC (null for other keys). */
export function homePathForKey(key: string, home = os.homedir()): string | null {
  if (key === 'home') return home;
  if (!key.startsWith('home/')) return null;
  return path.join(home, ...key.slice('home/'.length).split('/'));
}

const cache = new Map<string, Promise<string>>();

/**
 * Project key for a project folder. Git projects are keyed by their origin
 * remote (+ subfolder if Claude ran in a subfolder of the repo); everything
 * else falls back to name/<folder>.
 */
export function projectKeyFor(projectPath: string): Promise<string> {
  const norm = path.resolve(projectPath);
  const cacheKey = process.platform === 'win32' ? norm.toLowerCase() : norm;
  let p = cache.get(cacheKey);
  if (!p) {
    p = computeKey(norm);
    cache.set(cacheKey, p);
  }
  return p;
}

async function computeKey(projectPath: string): Promise<string> {
  if (!fs.existsSync(projectPath)) return fallbackKey(projectPath);
  const [top, remote] = await Promise.all([
    git(['-C', projectPath, 'rev-parse', '--show-toplevel'], undefined, 10_000),
    git(['-C', projectPath, 'remote', 'get-url', 'origin'], undefined, 10_000),
  ]);
  if (top.code !== 0 || remote.code !== 0 || !remote.stdout.trim()) return fallbackKey(projectPath);
  const base = normalizeRemote(remote.stdout);
  const sub = path
    .relative(path.resolve(top.stdout.trim()), projectPath)
    .replace(/\\/g, '/')
    .toLowerCase();
  return sub && !sub.startsWith('..') ? `${base}/${sub}` : base;
}
