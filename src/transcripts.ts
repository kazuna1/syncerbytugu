import fs from 'node:fs';
import path from 'node:path';
import { listJsonlRecursive, projectsDir } from './claudePaths.js';

export interface LocalFile {
  /** absolute path */
  abs: string;
  /** path relative to the slug folder, '/' separated (e.g. abc.jsonl, abc/subagents/x.jsonl) */
  rel: string;
  sessionId: string;
}

export interface LocalProject {
  slug: string;
  slugDir: string;
  /** project path taken from the transcripts' "cwd" field */
  cwd: string | null;
  files: LocalFile[];
}

export const CONFLICT_RE = /\.conflict-([^/]+)\.jsonl$/;

export function isConflictFile(rel: string): boolean {
  return CONFLICT_RE.test(rel);
}

export function conflictPath(file: string, machineId: string): string {
  const safe = machineId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return file.replace(/\.jsonl$/, `.conflict-${safe}.jsonl`);
}

/** Read the UTF-8 content of a transcript, dropping a BOM if one sneaked in. */
export function readText(file: string): string {
  const s = fs.readFileSync(file, 'utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.syncerbytugu-tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** First "cwd" value found in the first ~2 MB of a transcript. */
export function readCwd(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
      } catch {
        // truncated last line of the chunk
      }
    }
  } catch {
    // unreadable
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

export function countLines(content: string): number {
  if (!content) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return content.endsWith('\n') ? n : n + 1;
}

/** Every local project folder with its transcripts. Conflict copies are not included. */
export function listLocalProjects(): LocalProject[] {
  const base = projectsDir();
  let slugs: string[];
  try {
    slugs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: LocalProject[] = [];
  for (const slug of slugs.sort()) {
    const slugDir = path.join(base, slug);
    const files = listJsonlRecursive(slugDir)
      .filter((rel) => !isConflictFile(rel))
      .map((rel) => ({
        abs: path.join(slugDir, ...rel.split('/')),
        rel,
        sessionId: rel.split('/')[0].replace(/\.jsonl$/, ''),
      }));
    if (files.length === 0) continue;
    // Prefer top-level session files for cwd; they are the main transcripts.
    let cwd: string | null = null;
    for (const f of [...files].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)) {
      cwd = readCwd(f.abs);
      if (cwd) break;
    }
    out.push({ slug, slugDir, cwd, files });
  }
  return out;
}

export type MergeDecision = 'write' | 'same' | 'older' | 'conflict';

/**
 * Transcripts are append-only, so the longer one wins when the shorter is a
 * prefix of it. Both inputs must already be in the same (tokenized) space.
 */
export function decide(incoming: string, existing: string | null): MergeDecision {
  if (existing === null) return 'write';
  if (incoming === existing) return 'same';
  if (incoming.length > existing.length && incoming.startsWith(existing)) return 'write';
  if (existing.length > incoming.length && existing.startsWith(incoming)) return 'older';
  return 'conflict';
}

export type MergeResult = 'written' | 'same' | 'older' | 'conflict';

/**
 * Merge `incoming` into `dest` without ever losing data. On divergence the
 * incoming copy goes to <id>.conflict-<machine>.jsonl next to dest.
 *
 * `toCompare` maps a destination file's content into the incoming space;
 * `toWrite` maps incoming content into the destination space.
 */
export function mergeInto(
  dest: string,
  incoming: string,
  conflictMachine: string,
  toCompare: (destContent: string) => string = (s) => s,
  toWrite: (incomingContent: string) => string = (s) => s,
): MergeResult {
  const existing = fs.existsSync(dest) ? toCompare(readText(dest)) : null;
  const d = decide(incoming, existing);
  if (d === 'write') {
    writeText(dest, toWrite(incoming));
    return 'written';
  }
  if (d !== 'conflict') return d;
  const cpath = conflictPath(dest, conflictMachine);
  const cExisting = fs.existsSync(cpath) ? toCompare(readText(cpath)) : null;
  if (decide(incoming, cExisting) === 'write') writeText(cpath, toWrite(incoming));
  return 'conflict';
}
