import fs from 'node:fs';
import path from 'node:path';
import { listJsonlRecursive, projectsDir } from './claudePaths.js';
import { TOKEN_ESC, TOKEN_FWD } from './transform.js';

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

function lastJsonString(content: string, key: string): string | null {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let last: string | null = null;
  for (const m of content.matchAll(re)) last = m[1];
  if (last === null) return null;
  try {
    return JSON.parse(`"${last}"`) as string;
  } catch {
    return last;
  }
}

/** First thing the user typed, skipping command wrappers and tool results. */
function firstPrompt(content: string): string | null {
  for (const line of content.split('\n', 400)) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const c = (JSON.parse(line.replaceAll('\u0001', '')) as { message?: { content?: unknown } }).message?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as { type?: string; text?: string }[]).find((x) => x.type === 'text')?.text
            : undefined;
      if (text && !text.startsWith('<')) return text;
    } catch {
      // partial line
    }
  }
  return null;
}

export interface SessionInfo {
  /** /rename title, else Claude's own title, else the first prompt */
  title: string;
  /** ISO time of the last entry, or '' */
  updated: string;
}

export function sessionInfo(content: string): SessionInfo {
  const title =
    lastJsonString(content, 'customTitle') || lastJsonString(content, 'aiTitle') || firstPrompt(content) || '(untitled)';
  return { title: title.replace(/\s+/g, ' ').trim(), updated: lastJsonString(content, 'timestamp') || '' };
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
 * Both root tokens stand for the project root. On macOS/Linux the escaped and
 * forward-slash forms of a root are the same string, so a transcript that went
 * through a Mac comes back with only TOKEN_FWD. Comparing with the tokens
 * unified keeps that from looking like a different conversation. The tokens
 * have the same length, so offsets in the normalized text match the original.
 */
export function normalizeTokens(s: string): string {
  return s.split(TOKEN_ESC).join(TOKEN_FWD);
}

/**
 * The conversation lines of a transcript: entries with a top-level uuid
 * (user, assistant, attachment, system). Claude Code also appends bookkeeping
 * entries without one (title, mode, cost, file-history snapshots) just by
 * opening a session, so two machines can differ only in those. A line that
 * can't be parsed counts as conversation, so doubt leads to a conflict copy
 * rather than a dropped line.
 */
function conversationLines(s: string): string[] {
  return s.split('\n').filter((line) => {
    if (!line.trim()) return false;
    try {
      return typeof (JSON.parse(line.replaceAll('\u0001', '')) as { uuid?: unknown }).uuid === 'string';
    } catch {
      return true;
    }
  });
}

function startsWithLines(a: string[], b: string[]): boolean {
  return a.length >= b.length && b.every((line, i) => a[i] === line);
}

/**
 * Transcripts are append-only, so the longer one wins when the shorter is a
 * prefix of it. Both inputs must already be in the same (tokenized) space.
 * If they differ beyond that, but only in bookkeeping lines, the copy with
 * more conversation wins.
 */
export function decide(incoming: string, existing: string | null): MergeDecision {
  if (existing === null) return 'write';
  if (incoming === existing) return 'same';
  const inc = normalizeTokens(incoming);
  const ex = normalizeTokens(existing);
  if (inc === ex) return 'same';
  if (inc.length > ex.length && inc.startsWith(ex)) return 'write';
  if (ex.length > inc.length && ex.startsWith(inc)) return 'older';
  const incConv = conversationLines(inc);
  const exConv = conversationLines(ex);
  if (startsWithLines(exConv, incConv)) return exConv.length === incConv.length ? 'same' : 'older';
  if (startsWithLines(incConv, exConv)) return 'write';
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
  const d = mergeFile(dest, incoming, toCompare, toWrite);
  if (d === 'write') return 'written';
  if (d !== 'conflict') return d;
  mergeFile(conflictPath(dest, conflictMachine), incoming, toCompare, toWrite);
  return 'conflict';
}

/**
 * Write `incoming` to `file` if it is new or extends what is there. When the
 * existing file is a prefix, only the new tail is appended, so lines a machine
 * already has keep their exact bytes. When they differ only in bookkeeping
 * lines, the file is replaced by the copy with more conversation.
 */
function mergeFile(
  file: string,
  incoming: string,
  toCompare: (s: string) => string,
  toWrite: (s: string) => string,
): MergeDecision {
  const raw = fs.existsSync(file) ? readText(file) : null;
  const existing = raw === null ? null : toCompare(raw);
  const d = decide(incoming, existing);
  if (d === 'write') {
    const appendable = raw !== null && normalizeTokens(incoming).startsWith(normalizeTokens(existing!));
    writeText(file, appendable ? raw + toWrite(incoming.slice(existing!.length)) : toWrite(incoming));
  }
  return d;
}

/** True when a conflict copy holds nothing that its main transcript doesn't already have. */
export function conflictIsRedundant(conflictFile: string, toCompare: (s: string) => string = (s) => s): boolean {
  const main = conflictFile.replace(CONFLICT_RE, '.jsonl');
  if (!fs.existsSync(main) || !fs.existsSync(conflictFile)) return false;
  const d = decide(toCompare(readText(conflictFile)), toCompare(readText(main)));
  return d === 'same' || d === 'older';
}

/**
 * Delete conflict copies under `dir` that are fully contained in their main
 * transcript (false conflicts from 0.1.0's Windows/Mac token mismatch, or a
 * conflict that was later resolved). Never touches anything else.
 */
export function pruneRedundantConflicts(dir: string, toCompare: (s: string) => string = (s) => s): number {
  let n = 0;
  for (const rel of listJsonlRecursive(dir)) {
    if (!isConflictFile(rel)) continue;
    const abs = path.join(dir, ...rel.split('/'));
    if (!conflictIsRedundant(abs, toCompare)) continue;
    fs.unlinkSync(abs);
    n++;
  }
  return n;
}
