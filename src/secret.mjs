// The local secret: the one credential that tells the session's own shim from any
// other local process. See DESIGN.md Decisions -> "A loopback Host check, an
// origin check, and a local secret", and PROTOCOL.md "The local secret".
//
// Why this exists at all. The loopback Host check and the origin check between them
// close the network and the browser. Neither can see a local process: anything that
// can open a socket to 127.0.0.1:7391 could POST its own board naming a `cwd` it
// picked and read that directory back off the served page. The daemon runs always-on
// under launchd as the login user, so it launders that read past macOS TCC, which
// would otherwise gate ~/Documents, ~/Desktop and ~/Downloads per application. The
// secret is what a caller has to hold to make the daemon resolve a file for it.
//
// It is a FILE, not a URL parameter: DESIGN.md rejects tokens in URLs because
// bookmarks and stale links carry them around. A 0600 file read by the shim and sent
// in a request header has neither problem.
//
// CLAUDE_BOARD_SECRET_FILE is a testing seam in exactly the style of
// CLAUDE_BOARD_LAUNCH_AGENTS_DIR and CLAUDE_BOARD_HOME: not user-facing
// configuration, defaults to the real path, exists so the checks never read or write
// the real one.

import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHmac } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** Header the secret travels in. Lowercase because node:http lowercases every
 * incoming header name. */
export const SECRET_HEADER = 'x-claude-board-secret';

/** Cookie the served page's own submit travels in. See submitToken below. */
export const SUBMIT_COOKIE = 'cb_submit';

export function secretPath() {
  return process.env.CLAUDE_BOARD_SECRET_FILE || path.join(os.homedir(), '.config', 'claude-board', 'secret');
}

/** The secret, or null when there isn't one. Trimmed, because the file is written by
 * a shell and a trailing newline is not part of the credential. Never throws: a
 * missing or unreadable secret is a state both callers have to handle out loud
 * (the daemon refuses writes, the shim refuses to post), not an exception thrown
 * from a module top level. */
export function readSecret() {
  try {
    const s = readFileSync(secretPath(), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Constant-time equality, length-guarded. `timingSafeEqual` THROWS on a length
 * mismatch rather than returning false, so the guard is load-bearing, not defensive
 * padding — and comparing lengths first leaks only the length, which the header is
 * free to reveal anyway. A null/absent secret matches nothing: the daemon fails
 * closed rather than accepting every caller once the file is gone. */
export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The board-scoped credential the SERVED PAGE submits with.
 *
 * The reviewer's browser cannot hold the secret — it has no way to read a 0600 file,
 * and inlining the real secret into a page that any local process can GET would hand
 * the whole credential away. So `GET /b/:id` hands the browser this instead: an HMAC
 * of the board id under the secret, in a host-only, path-scoped, HttpOnly session
 * cookie. It authorises exactly one thing: answering THAT board. It cannot create a
 * board, cannot name a `cwd`, and cannot resolve a file.
 *
 * Be precise about the strength: anything that can GET the page can also take this
 * cookie, and reads are deliberately open (see PROTOCOL.md). What it buys is that a
 * local process cannot forge answers to a board it never located, and — the part that
 * matters — the file-reading route stays behind the real secret. Without the secret
 * file no token can be minted at all, so submits fail closed with everything else. */
export function submitToken(boardId, secret) {
  if (!secret) return null;
  return createHmac('sha256', secret).update(`submit:${boardId}`).digest('hex');
}

/** Parse a Cookie header into a plain object. Values are not URL-decoded: everything
 * this daemon sets is hex. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
