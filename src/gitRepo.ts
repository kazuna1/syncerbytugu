import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
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
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 ? err.message : '') });
      },
    );
  });
}

/** Like git() but throws on a non-zero exit. */
export async function gitOk(args: string[], cwd?: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function gitInstalled(): Promise<boolean> {
  return (await git(['--version'])).code === 0;
}
