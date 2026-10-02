import * as macos from './macos.js';
import * as windows from './windows.js';

export interface SchedulerStatus {
  interval: boolean;
  logon: boolean;
}

export interface Scheduler {
  install(intervalMinutes: number): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<SchedulerStatus>;
}

const notYet: Scheduler = {
  async install() {
    throw new Error(
      `Background auto-sync is not supported on ${process.platform} yet (Windows and macOS only). ` +
        'Hooks still push on exit; run `syncerbytugu pull` manually or from cron.',
    );
  },
  async uninstall() {},
  async status() {
    return { interval: false, logon: false };
  },
};

export function scheduler(): Scheduler {
  if (process.platform === 'win32') return windows;
  if (process.platform === 'darwin') return macos;
  return notYet;
}
