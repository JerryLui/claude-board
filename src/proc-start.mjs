// A process's start, as the session watcher reads it: `TZ=UTC ps -o lstart=` in the C
// locale (a Swedish one prints `tors 29 okt.`), as an ISO-8601 UTC second.

import { execFileSync } from 'node:child_process';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The start of the process `pid`, or null when it runs no longer or cannot be read. */
export function processStartUtc(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let lstart;
  try {
    lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(lstart.trim().replace(/\s+/g, ' '));
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (month < 0) return null;
  const ms = Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
