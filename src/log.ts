import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const MAX_LOG_BYTES = 1024 * 1024;

let quiet = false;

export function setQuiet(q: boolean): void {
  quiet = q;
}

function append(level: string, msg: string): void {
  try {
    const file = paths.log();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, file.replace(/\.txt$/, '.old.txt'));
      }
    } catch {
      // no log yet
    }
    fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${level} ${msg}\n`, 'utf8');
  } catch {
    // logging must never crash a sync
  }
}

export const log = {
  info(msg: string): void {
    append('INFO ', msg);
    if (!quiet) console.log(msg);
  },
  warn(msg: string): void {
    append('WARN ', msg);
    if (!quiet) console.warn(`warning: ${msg}`);
  },
  error(msg: string): void {
    append('ERROR', msg);
    if (!quiet) console.error(`error: ${msg}`);
  },
  /** Log file only, never console. */
  debug(msg: string): void {
    append('DEBUG', msg);
  },
};
