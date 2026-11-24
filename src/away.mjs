import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { secretPath } from './secret.mjs';

const AWAY_FILE_MAX_BYTES = 256;
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const AWAY_HOST = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+\\.ts\\.net$`);

export function awayPath() {
  return path.join(path.dirname(secretPath()), 'away');
}

function awayFileText() {
  // O_NONBLOCK: opening a fifo with no writer otherwise blocks forever, and with it the daemon.
  const fd = openSync(awayPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { refusal: 'is not a plain file' };
    if (stat.uid !== process.getuid()) return { refusal: 'is not owned by this user' };
    if (stat.mode & 0o077) return { refusal: `is open to other users (mode ${(stat.mode & 0o777).toString(8)}, want 600)` };
    if (stat.size > AWAY_FILE_MAX_BYTES) return { refusal: 'is too long to be one host name' };
    return { text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** The away setting as it stands now: `host`, the one name besides loopback the daemon
 * answers to, or null with the `reason` it has none. Anything but a well-formed name in an
 * owner-only file reads as off. */
export function readAway() {
  let file;
  try {
    file = awayFileText();
  } catch (err) {
    if (err.code === 'ENOENT') return { host: null, reason: 'away is off' };
    return { host: null, reason: `away is off: ${awayPath()} could not be read (${err.code || err.message})` };
  }
  const host = file.text?.replace(/\r?\n$/, '');
  if (host !== undefined && host.length <= 253 && AWAY_HOST.test(host)) return { host, reason: null };
  return { host: null, reason: `away is off: ${awayPath()} ${file.refusal ?? 'does not hold one lowercase Tailscale name'}` };
}

export function readAwayHost() {
  return readAway().host;
}

export function isAwayHost(hostHeader, host = readAwayHost()) {
  if (!host || typeof hostHeader !== 'string') return false;
  const named = hostHeader.toLowerCase();
  return named === host || named === `${host}:443`;
}
