import fs from 'node:fs';
import path from 'node:path';
import { APP } from './config.js';
import { settingsPath } from './claudePaths.js';

interface HookCommand {
  type: string;
  command?: string;
  [k: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [k: string]: unknown;
}

type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

// SessionEnd hooks get a short timeout from Claude Code, so push detaches
// into the background and returns immediately.
export const OUR_HOOKS: Record<string, string> = {
  SessionEnd: `${APP} push --quiet --background`,
  SessionStart: `${APP} register`,
};

const isOurs = (h: HookCommand) => typeof h.command === 'string' && h.command.includes(APP);

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Settings;
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}). Fix it by hand; ${APP} will not overwrite it.`);
  }
}

function writeSettings(file: string, s: Settings): void {
  const backup = `${file}.${APP}-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

/** Drop our hook commands (and any groups left empty by that). */
function strip(s: Settings): boolean {
  let changed = false;
  if (!s.hooks) return false;
  for (const event of Object.keys(s.hooks)) {
    const groups = s.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hooks = g.hooks.filter((h) => !isOurs(h));
      if (hooks.length !== g.hooks.length) changed = true;
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) s.hooks[event] = kept;
    else delete s.hooks[event];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return changed;
}

/** Merge our hooks into ~/.claude/settings.json. Idempotent. */
export function installHooks(file = settingsPath()): void {
  const s = readSettings(file);
  const before = JSON.stringify(s);
  strip(s);
  s.hooks = s.hooks || {};
  for (const [event, command] of Object.entries(OUR_HOOKS)) {
    s.hooks[event] = [...(s.hooks[event] || []), { hooks: [{ type: 'command', command }] }];
  }
  if (JSON.stringify(s) !== before) writeSettings(file, s);
}

export function uninstallHooks(file = settingsPath()): boolean {
  if (!fs.existsSync(file)) return false;
  const s = readSettings(file);
  if (!strip(s)) return false;
  writeSettings(file, s);
  return true;
}

export function hooksInstalled(file = settingsPath()): boolean {
  try {
    const s = readSettings(file);
    return Object.entries(OUR_HOOKS).every(([event, command]) =>
      (s.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => h.command === command)),
    );
  } catch {
    return false;
  }
}
