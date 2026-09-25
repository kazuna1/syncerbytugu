import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP = 'syncerbytugu';

export interface Config {
  repoUrl: string;
  repoDir: string;
  machineId: string;
  scanRoots: string[];
  intervalMinutes: number;
}

export interface State {
  lastPush?: string;
  lastPull?: string;
  /** local transcript path -> "mtimeMs:size" at the last successful push */
  pushCache: Record<string, string>;
  /** repo-relative path -> "mtimeMs:size:root" at the last pull */
  pullCache: Record<string, string>;
  unmapped: string[];
  conflicts: string[];
}

/** ~/.syncerbytugu, overridable with SYNCERBYTUGU_HOME for testing. */
export function appHome(): string {
  return process.env.SYNCERBYTUGU_HOME || path.join(os.homedir(), `.${APP}`);
}

export const paths = {
  config: () => path.join(appHome(), 'config.json'),
  registry: () => path.join(appHome(), 'registry.json'),
  state: () => path.join(appHome(), 'state.json'),
  lock: () => path.join(appHome(), 'sync.lock'),
  log: () => path.join(appHome(), 'log.txt'),
  repo: () => path.join(appHome(), 'repo'),
};

export function defaultScanRoots(): string[] {
  const roots = [os.homedir()];
  if (process.platform === 'win32') {
    for (const r of ['C:\\dev', 'C:\\projects', 'D:\\', 'E:\\']) {
      if (fs.existsSync(r)) roots.push(r);
    }
  }
  return roots;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function loadConfig(): Config | null {
  const cfg = readJson<Partial<Config> | null>(paths.config(), null);
  if (!cfg || !cfg.repoUrl) return null;
  return {
    repoUrl: cfg.repoUrl,
    repoDir: cfg.repoDir || paths.repo(),
    machineId: cfg.machineId || os.hostname(),
    scanRoots: cfg.scanRoots || defaultScanRoots(),
    intervalMinutes: cfg.intervalMinutes || 5,
  };
}

export function requireConfig(): Config {
  const cfg = loadConfig();
  if (!cfg) throw new Error(`Not initialized. Run: ${APP} init <private-repo-url>`);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  writeJson(paths.config(), cfg);
}

export function loadState(): State {
  const s = readJson<Partial<State>>(paths.state(), {});
  return {
    ...s,
    pushCache: s.pushCache || {},
    pullCache: s.pullCache || {},
    unmapped: s.unmapped || [],
    conflicts: s.conflicts || [],
  };
}

export function saveState(s: State): void {
  writeJson(paths.state(), s);
}
