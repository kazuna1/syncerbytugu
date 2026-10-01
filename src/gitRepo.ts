import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** killed because it ran past the timeout */
  timedOut?: boolean;
}

/**
 * Run git with an argument array (never a shell string). Prompts are disabled
 * so background runs fail fast instead of hanging on a credential prompt.
 */
export function git(args: string[], cwd?: string, timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        const timedOut = !!err && (err as { killed?: boolean }).killed === true;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 ? err.message : ''), timedOut });
      },
    );
  });
}

/** For clone/fetch/push: the sessions repo can be hundreds of MB on a slow link. */
export const NETWORK_TIMEOUT_MS = 30 * 60 * 1000;

/** Like git() but throws on a non-zero exit. */
export async function gitOk(args: string[], cwd?: string, timeoutMs?: number): Promise<string> {
  const r = await git(args, cwd, timeoutMs);
  if (r.code !== 0) {
    const detail = r.timedOut ? `timed out after ${Math.round((timeoutMs ?? 120_000) / 60_000)} min` : r.stderr.trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return r.stdout;
}

export async function gitInstalled(): Promise<boolean> {
  return (await git(['--version'])).code === 0;
}
