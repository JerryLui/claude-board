// The two credentials the daemon accepts: the local secret (a 0600 file, held by the
// session's own shim) and the session cookie derived from it (held by an authorized
// browser). See PROTOCOL.md "The local secret" and "The browser session cookie".
//
// Why the secret exists at all. The loopback Host check and the origin check between
// them close the network and the browser. Neither can see a local process: anything
// that can open a socket to 127.0.0.1:7391 could POST its own board naming a `cwd` it
// picked and read that directory back off the served page. The daemon runs always-on
// under launchd as the login user, so it launders that read past macOS TCC, which
// would otherwise gate ~/Documents, ~/Desktop and ~/Downloads per application. The
// secret is what a caller has to hold to make the daemon resolve a file for it.
//
// It is a FILE, not a URL parameter: tokens in URLs are rejected because
// bookmarks and stale links carry them around. A 0600 file read by the shim and sent
// in a request header has neither problem.
//
// Why the session cookie exists. The daemon overturned "read routes stay open":
// every read now needs a credential too, and the reviewer's browser cannot read a
// 0600 file. So the browser gets a cookie instead, handed to it once through a
// single-use handoff (src/handoff.mjs) and never visible in a URL a bookmark can
// capture.
//
// CLAUDE_BOARD_SECRET_FILE is a testing seam in exactly the style of
// CLAUDE_BOARD_LAUNCH_AGENTS_DIR: not user-facing configuration, defaults to the real
// path, exists so the checks never read or write the real one. (CLAUDE_BOARD_HOME used
// to be listed here as a third example and is not one — it is documented configuration
// for where the store lives; see README.md.)

import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHmac } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

/** Header the secret travels in. Lowercase because node:http lowercases every
 * incoming header name. */
export const SECRET_HEADER = 'x-claude-board-secret';

/** Cookie an authorized browser holds. See sessionToken below. */
export const SESSION_COOKIE = 'cb_session';

/** How long that cookie lives, in seconds.
 *
 * It is deliberately NOT a session cookie: bookmarking a board and opening the
 * bookmark days later still works, and a
 * cookie that dies with the browser window turns every morning into a
 * re-authorization.
 *
 * 30 days, cut from 400 on 2026-07-31. 400 was the Chrome clamp ceiling —
 * i.e. the longest the browser would honour, chosen for no reason but that. Lifetime is
 * one of only two levers that bound the cookie's exposure, because the other one people
 * reach for does not exist: cookies are NOT port-scoped (RFC 6265 §8.5), so this value
 * travels to every http server on the same host, whatever port it listens on. It cannot
 * be scoped away from them, so it is instead made to expire while it is still worth
 * something to expire. `bin/authorize.mjs` re-mints in one command, so the cost of the
 * cut is one re-authorization a month against a 13x smaller window. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export function secretPath() {
  return process.env.CLAUDE_BOARD_SECRET_FILE || path.join(os.homedir(), '.config', 'claude-board', 'secret');
}

/** The port the daemon is on, resolved the way every non-daemon caller must:
 * `CLAUDE_BOARD_PORT` when set, else the port record install.sh writes beside the
 * secret, else the default. The record exists because `claude mcp add` registers the
 * shim with no environment — a custom-port user would otherwise have to export
 * CLAUDE_BOARD_PORT in every shell for the shim/demo/authorize to find the daemon the
 * installer itself pointed launchd at. The daemon does NOT read this: launchd hands it
 * the port in the plist environment, and that stays the one authority for what to bind. */
export function daemonPort() {
  const fromEnv = Number(process.env.CLAUDE_BOARD_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const record = Number(readFileSync(path.join(path.dirname(secretPath()), 'port'), 'utf8').trim());
    if (Number.isInteger(record) && record > 0 && record < 65536) return record;
  } catch {}
  return 7391;
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

/** The credential an AUTHORIZED BROWSER holds: an HMAC of a fixed label under the
 * secret, carried in a host-only, HttpOnly, SameSite=Strict cookie that src/server.mjs
 * sets when it consumes a handoff (src/handoff.mjs). It is what lets a browser read
 * boards and press Send, neither of which it could do with a 0600 file it cannot open.
 *
 * DERIVED, not random, and that is the whole point. A random token would have to live
 * somewhere: in daemon memory, where every `launchctl kickstart`, crash and code reload
 * logs every browser out, or in a second file to keep in sync with the first. Deriving
 * it from the secret means any daemon holding the same secret accepts the same cookie,
 * so restarts are invisible to the browser — and rotating the secret invalidates every
 * browser at once, which is the correct and intended consequence.
 *
 * There is no per-board and no per-browser component on purpose. Binding it to one
 * board is exactly what this replaced: it made "can read this board" a weaker
 * credential than the secret and left every other board reachable by whoever held it.
 *
 * Be precise about the strength. This is a bearer credential worth "may read every
 * board in the store and may answer any open round" — the whole review corpus,
 * including the source excerpts boards embed. It is NOT the secret: it is refused in
 * the `x-claude-board-secret` header, so it cannot create a board, cannot name a
 * `cwd`, and therefore can never make the daemon resolve a file. What it does not
 * defend against, and cannot:
 *
 *  - a process that can read the 0600 secret file can mint this itself, and is already
 *    fully trusted;
 *  - a browser extension with host permissions on the profile can read the cookie,
 *    because HttpOnly stops page script, not extensions;
 *  - ANY OTHER http server on this host, whatever port it listens on. Cookies are not
 *    port-scoped (RFC 6265 §8.5) and SameSite is not port-aware — site is scheme plus
 *    host — so a reviewer who opens `http://127.0.0.1:3000` in the same browser hands
 *    that server this cookie on a plain navigation, and it can then replay it here.
 *    Found 2026-07-31 and NOT fixable at this layer: the daemon cannot
 *    distinguish a replay from the browser it minted for, and Path cannot be narrowed
 *    below `/` while the index lives at `/`. What is done instead is bounding it —
 *    SESSION_MAX_AGE_S above — and refusing browser-driven cross-origin use in
 *    src/server.mjs `isSameOriginRead`. All three are stated in SECURITY.md rather than
 *    papered over here.
 *
 * No `Secure` attribute is set. Not because it would be ignored — Chrome treats
 * `http://127.0.0.1` as a potentially-trustworthy origin and does return `Secure`
 * cookies to it — but because it buys nothing on a loopback-only plain-http daemon and
 * would break any browser that does not implement that carve-out. (This comment used to
 * claim such a cookie "would simply never be sent back", which is wrong; corrected
 * 2026-07-31.) */
export function sessionToken(secret) {
  if (!secret) return null;
  return createHmac('sha256', secret).update('claude-board/session/v1').digest('hex');
}

/** True iff this request carries the session cookie for `secret`. Constant-time via
 * secretMatches, and false for every shape of absence (no Cookie header, no such
 * cookie, no secret on disk) rather than throwing. */
export function sessionCookieMatches(cookieHeader, secret) {
  if (!secret) return false;
  const expected = sessionToken(secret);
  // Order-INDEPENDENT: accept if any `cb_session` in the header matches.
  //
  // Picking one end was the bug, in both directions. RFC 6265 §5.4 orders cookies with
  // LONGER paths first, and this daemon's cookie is `Path=/` -- the shortest there is --
  // so it sorts LAST among duplicates, the opposite of what first-wins assumed. Any other
  // loopback server (cookies are not port-scoped, §8.5) could set
  // `cb_session=junk; Path=/b` and shadow the real credential on every /b/<id> forever;
  // bin/authorize.mjs re-mints the `Path=/` key and cannot clear a longer-path duplicate,
  // so the one command the refusal page names could not recover it. §5.4 is only a SHOULD
  // and its own note calls servers that depend on this order "erroneously" dependent, so
  // last-wins is no better -- searching every value is the only parse that does not bet on
  // an ordering. It leaks nothing: supplying a value that matches means already holding
  // the credential.
  return cookieValues(cookieHeader, SESSION_COOKIE).some(v => secretMatches(v, expected));
}

/** Every value carried under `name`, in header order. */
function cookieValues(header, name) {
  const values = [];
  if (!header) return values;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/** Parse a Cookie header into a plain object, first occurrence of each name winning.
 * Values are not URL-decoded: everything this daemon sets is hex. Credential checks do
 * NOT go through here — see sessionCookieMatches on why one value per name cannot be
 * the basis of an auth decision. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}
