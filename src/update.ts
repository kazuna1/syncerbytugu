import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP } from './config.js';
import { git } from './gitRepo.js';

/** The package folder this copy runs from (symlinks from `npm install -g .` are already resolved by Node). */
const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function currentVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** True for a git checkout installed with `npm install -g .`, false for an install from the npm registry. */
export function isGitInstall(): boolean {
  return fs.existsSync(path.join(packageRoot(), '.git'));
}

/** -1, 0 or 1, comparing dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Latest version on the npm registry, or null if it can't be reached. */
export async function latestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${APP}/latest`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version || null;
  } catch {
    return null;
  }
}

/** A one-line note when a newer version exists, or null (also when offline). */
export async function updateNotice(): Promise<string | null> {
  if (isGitInstall()) {
    const root = packageRoot();
    const [local, remote] = await Promise.all([
      git(['rev-parse', 'HEAD'], root, 10_000),
      git(['ls-remote', 'origin', 'HEAD'], root, 10_000),
    ]);
    const remoteHead = remote.stdout.split(/\s/)[0];
    if (local.code || remote.code || !remoteHead) return null;
    return remoteHead !== local.stdout.trim() ? `Newer code on GitHub. Run: ${APP} update` : null;
  }
  const latest = await latestNpmVersion();
  return latest && compareVersions(latest, currentVersion()) > 0
    ? `Version ${latest} is available (you have ${currentVersion()}). Run: ${APP} update`
    : null;
}

/** Run npm with the output shown; npm is a .cmd on Windows, so it needs a shell there. */
function npm(args: string[], cwd?: string): void {
  const r = spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
}

export async function update(): Promise<void> {
  const before = currentVersion();
  const root = packageRoot();

  if (isGitInstall()) {
    console.log(`Updating the ${APP} checkout at ${root} ...`);
    const pull = await git(['pull', '--ff-only'], root, 5 * 60 * 1000);
    if (pull.code !== 0) {
      throw new Error(
        `git pull failed in ${root}:\n${pull.stderr.trim()}\n` +
          'If you changed files there, commit or discard them and run update again.',
      );
    }
    npm(['install', '--no-audit', '--no-fund'], root);
    npm(['run', 'build'], root);
  } else {
    const latest = await latestNpmVersion();
    if (!latest) throw new Error('Could not reach the npm registry. Check your connection and try again.');
    if (compareVersions(latest, before) <= 0) {
      console.log(`Already up to date (${before}).`);
      return;
    }
    console.log(`Installing ${APP} ${latest} from npm ...`);
    npm(['install', '-g', `${APP}@latest`]);
  }

  const after = currentVersion();
  console.log(after === before ? `Already up to date (${after}).` : `Updated ${APP} ${before} -> ${after}.`);
}
