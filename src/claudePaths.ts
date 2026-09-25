import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ~/.claude, overridable with SYNCERBYTUGU_CLAUDE_DIR for testing. */
export function claudeDir(): string {
  return process.env.SYNCERBYTUGU_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeDir(), 'projects');
}

export function settingsPath(): string {
  return path.join(claudeDir(), 'settings.json');
}

/** Claude Code's folder name for a project path: every non-alphanumeric char becomes '-'. */
export function slugFor(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The slug folder for a project path on this PC. On Windows Claude sometimes
 * writes `d--foo` and sometimes `D--foo`, so reuse an existing folder that
 * matches case-insensitively before inventing a new one.
 */
export function slugDirFor(projectPath: string): string {
  const slug = slugFor(projectPath);
  const base = projectsDir();
  if (process.platform === 'win32') {
    try {
      const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === slug.toLowerCase());
      if (hit) return path.join(base, hit);
    } catch {
      // projects dir missing; it will be created on write
    }
  }
  return path.join(base, slug);
}

/** All *.jsonl files under dir, as paths relative to dir using '/' separators. */
export function listJsonlRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}
