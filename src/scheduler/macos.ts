import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, appHome } from '../config.js';
import type { SchedulerStatus } from './index.js';

// A LaunchAgent, not cron: it runs in the login session, so git can read
// GitHub credentials from the Keychain (cron gets "could not read Username").
export const LABEL = `com.${APP}.sync`;

const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function launchctl(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: String(stdout) + String(stderr) });
    });
  });
}

/** The built cli.js next to this file's parent folder, resolved to an absolute path. */
function cliPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Runs `node cli.js sync --quiet` every interval and at login (RunAtLoad).
 * Absolute paths, since launchd doesn't load nvm or the user's shell PATH.
 */
export function plist(intervalMinutes: number): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const pathEnv = [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${s(process.execPath)}
    ${s(cliPath())}
    ${s('sync')}
    ${s('--quiet')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s([...new Set(pathEnv)].join(':'))}
  </dict>
  <key>WorkingDirectory</key>
  ${s(appHome())}
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  ${s('/dev/null')}
  <key>StandardErrorPath</key>
  ${s('/dev/null')}
</dict>
</plist>
`;
}

export async function install(intervalMinutes: number): Promise<void> {
  fs.mkdirSync(appHome(), { recursive: true });
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist(intervalMinutes), 'utf8');
  await launchctl(['bootout', `${domain()}/${LABEL}`]); // reload if already loaded
  const r = await launchctl(['bootstrap', domain(), plistPath()]);
  if (r.code !== 0) throw new Error(`Could not load LaunchAgent ${plistPath()}: ${r.out.trim()}`);
}

export async function uninstall(): Promise<void> {
  await launchctl(['bootout', `${domain()}/${LABEL}`]);
  fs.rmSync(plistPath(), { force: true });
}

export async function status(): Promise<SchedulerStatus> {
  const loaded = (await launchctl(['print', `${domain()}/${LABEL}`])).code === 0;
  return { interval: loaded, logon: loaded && fs.existsSync(plistPath()) };
}
