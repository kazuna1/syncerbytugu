import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

// Longer than any git network timeout, so a slow first upload is never taken over mid-push.
const STALE_MS = 60 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryTake(file: string): boolean {
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // Someone holds it: take it over if stale or the holder died.
  try {
    const { pid, time } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; time: number };
    if (Date.now() - time < STALE_MS && pidAlive(pid)) return false;
  } catch {
    // unreadable lock file counts as stale
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // raced with another process; let the retry decide
  }
  return false;
}

/**
 * Acquire ~/.syncerbytugu/sync.lock. Returns a release function, or null if
 * another sync is running and we gave up after `waitMs`.
 */
export async function acquireLock(waitMs: number): Promise<(() => void) | null> {
  const file = paths.lock();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  const release = (): void => {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone
    }
  };
  for (;;) {
    // A stale lock is removed by the first tryTake, so the second one can win it.
    if (tryTake(file) || tryTake(file)) return release;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}
