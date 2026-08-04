// The node:http daemon: routes, the loopback Host check, a polling wait on
// /api/board/:id/wait, and (ticket 04) the SSE push on /api/board/:id/events. See
// PROTOCOL.md "HTTP surface" and "SSE events".
//
// Four gates, in this order (DESIGN.md Decisions -> "A loopback Host check, an
// origin check, and a local secret"; SPEC_LAUNCH.md Decisions -> "Read routes are
// gated", "One-time handoff, then a session cookie"):
//
//   1. Host is loopback, on every route          -> 403, no body
//   2. non-GET is same-origin                    -> 403, no body
//   3. a write holds a credential                -> 401, no body
//   4. a read holds a credential                 -> 401, a page naming the fix
//
// Both credential gates are written as "everything, minus an explicit exception list",
// never as an enumeration of the routes that need them: a route added later is gated by
// default rather than by whoever adds it remembering. The exception list for (4) is
// `GET /api/health` (install.sh polls it with plain curl to decide whether the service
// came up, and it reveals only a version string) and `GET /auth/<token>`, which is the
// route that HANDS OUT the credential and so cannot require it.
//
// A credential is one of exactly two things (src/secret.mjs):
//
//   * the local secret, in the `x-claude-board-secret` header. The shim holds it,
//     because it can read a 0600 file. Only this one may create a board, which is the
//     only route that resolves a file.
//   * the session cookie, derived from the secret, which a browser gets by following a
//     single-use handoff (src/handoff.mjs). It reads boards and answers them, and is
//     refused in the secret header, so it can never resolve a file.
//
// SPEC_LAUNCH.md overturned DESIGN.md's "read routes stay open", and deleted the
// board-scoped submit token that decision forced. What that decision cost, plainly:
// any local process that could reach the port read every board — source excerpts,
// questions, answers — and could forge an answer on any board whose page it could
// fetch. Defensible for one author on one machine, not for a posture a stranger
// inherits by running one command.
//
// Waiting survives a daemon restart in principle: /wait polls the store (the
// source of truth) on disk rather than holding process-local state, so a waiter
// that reattaches after a restart sees exactly what a waiter that never
// disconnected would see. SSE survives it too, but differently: nothing can mutate
// the board while the daemon is down, so a client whose connection drops on
// restart just reconnects (EventSource does this natively) and picks up live
// pushes again with nothing missed in between — see DESIGN.md "Always on under
// launchd" (KeepAlive restarts the daemon on a crash; ./install.sh restarts it to
// take an update).

import http from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, writeBoard, writePage, boardHome, listBoards, searchBoards } from './store.mjs';
import { readSecret, secretPath, secretMatches, sessionToken, sessionCookieMatches, SECRET_HEADER, SESSION_COOKIE, SESSION_MAX_AGE_S } from './secret.mjs';
import { createHandoffStore, handoffTarget, recoveryCommand, HANDOFF_TOKEN_RE, DEFAULT_PORT } from './handoff.mjs';
import { createBoard, addRound, amendRound, applySubmit, buildPacket, resolveComments } from './board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, renderRefusalPage, CSP, INDEX_CSP } from './render.mjs';
import { buildThreadIndex, renderIndexPage } from './indexpage.mjs';
import { createPomodoro, readDoc as readPomodoroDoc } from './pomodoro.mjs';
import { notifyBoundary } from './notify.mjs';
import { openServed, resolveRefRoots } from './resolve.mjs';

// Declared in src/handoff.mjs (which this module imports, so it cannot import back) and
// re-exported here, where every caller has always looked for it.
export { DEFAULT_PORT } from './handoff.mjs';

// Heartbeat comment lines (`: heartbeat\n\n`) keep an idle SSE connection alive
// through proxies and idle timers that would otherwise drop it; SSE comment lines
// are invisible to EventSource's message events, so they never surface as a stray
// event to client code. Overridable so the check can prove the stream survives a
// heartbeat interval without a multi-second sleep. See PROTOCOL.md "SSE events".
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

function sseHeartbeatMs() {
  const v = Number(process.env.CLAUDE_BOARD_SSE_HEARTBEAT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SSE_HEARTBEAT_MS;
}

/** Per-server-instance SSE subscriber registry, keyed by board id. Scoped inside
 * createRequestHandler (below) rather than module-level, so two independent daemon
 * instances in the same process (as the checks spin up) never share subscribers. */
function createSseHub() {
  const subs = new Map(); // boardId -> Set<res>
  return {
    subscribe(boardId, res) {
      let set = subs.get(boardId);
      if (!set) { set = new Set(); subs.set(boardId, set); }
      set.add(res);
    },
    unsubscribe(boardId, res) {
      const set = subs.get(boardId);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) subs.delete(boardId);
    },
    broadcast(boardId, eventName, data) {
      const set = subs.get(boardId);
      if (!set || set.size === 0) return;
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of set) {
        try { res.write(payload); } catch { /* dead connection; the 'close' handler cleans it up */ }
      }
    },
    /** How many browsers currently have this board open. Reported on the POST response
     * so the shim can tell "the reviewer closed the tab" from "the reviewer is looking
     * at it", which is what decides whether a later round reopens the tab. The shim used
     * to ask for this over a `GET /api/board/:id/clients` route that was never routed
     * here, so it always got null and never reopened (audit 2026-07-31 S3). */
    clientCount(boardId) {
      const set = subs.get(boardId);
      return set ? set.size : 0;
    },
  };
}

function readPkgVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PKG_VERSION = readPkgVersion();

/** Wall-clock ceiling on a single /wait call, the server-side twin of the shim's
 * CLAUDE_BOARD_TIMEOUT_MS (PROTOCOL.md "MCP shim environment"): a waiter nobody ever
 * answers gets an explicit `timeout` packet instead of polling the store forever. */
export const DEFAULT_WAIT_TIMEOUT_MS = 7_200_000;

function waitTimeoutMs() {
  const v = Number(process.env.CLAUDE_BOARD_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WAIT_TIMEOUT_MS;
}

/** Number of /wait polls currently running in this process. Exported for the checks:
 * a waiter whose client disconnected must drop this back to zero (see waitForRound). */
let activeWaits = 0;
export function activeWaitCount() {
  return activeWaits;
}

/** A subdomain of the reserved `.localhost` TLD, e.g. `board.localhost`. Kept strict
 * (letters, digits, dots, dashes only) because the Host header is reflected verbatim
 * into boardUrl() and thence into `open`. */
const LOCALHOST_SUBDOMAIN = /^[a-z0-9][a-z0-9.-]*\.localhost$/;

/** True iff the Host header names loopback: 127.0.0.1, ::1, localhost, or a subdomain
 * of localhost. Anything else (including a missing header) is refused — this is what
 * closes DNS rebinding.
 *
 * `.localhost` is safe to admit alongside the bare name: RFC 6761 reserves the TLD and
 * it is never delegated in the public root, so an attacker cannot own a name under it
 * and cannot point one at this daemon. Chrome and Firefox resolve `*.localhost` to
 * loopback in the browser; Safari defers to the system resolver, which needs an
 * /etc/hosts line. Either way the mapping is the user's, not a remote DNS server's,
 * which is exactly what rebinding needs and cannot get here. */
export function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase(); // Host is case-insensitive: LOCALHOST is localhost
  let name;
  if (h.startsWith('[')) {
    // A bracketed literal must be the WHOLE authority: everything after `]` has to be
    // nothing or `:<digits>`. Dropping the remainder unchecked accepted `[::1]@evil.com`
    // and `[::1].evil.com`, and this header is reflected verbatim into boardUrl() —
    // which becomes the URL in the agent's packet and the URL the shim hands to `open`.
    const end = h.indexOf(']');
    if (end === -1) return false;
    const rest = h.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return false;
    name = h.slice(1, end);
  } else if (h.split(':').length > 2) {
    name = h; // bare IPv6 literal: without brackets it cannot carry a port
  } else {
    const idx = h.lastIndexOf(':');
    if (idx !== -1 && !/^\d+$/.test(h.slice(idx + 1))) return false;
    name = idx === -1 ? h : h.slice(0, idx);
  }
  return name === '127.0.0.1' || name === '::1' || name === 'localhost' || LOCALHOST_SUBDOMAIN.test(name);
}

/** True iff this non-GET request is same-origin. The loopback Host check alone does
 * NOT cover a page on any origin doing `fetch('http://127.0.0.1:7391/...')` — the
 * browser sets `Host: 127.0.0.1:7391` itself, so the Host check passes. What a browser
 * will not let that page forge is `Origin`/`Sec-Fetch-Site`, so those are what gate a
 * write. Both are absent on a non-browser client (the shim, curl, the checks), which is
 * deliberate: this closes the browser-driven CSRF hole the Host check cannot see, not
 * local processes, which DESIGN.md's "Localhost, one human" boundary already trusts. */
function isSameOriginWrite(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  return true;
}

/** True iff this READ may proceed: either credential, and nothing weaker. A daemon with
 * no secret on disk refuses everything gated rather than falling open — it cannot derive
 * the session cookie either, so there is no credential it could honestly accept.
 *
 * The SECRET is accepted from anywhere. The COOKIE additionally has to look like it came
 * from this origin, for the same reason writes have always been checked that way: the
 * cookie is the credential a browser holds, so a browser is the only thing that should be
 * spending it, and `Origin`/`Sec-Fetch-Site` are the two headers a page cannot forge.
 *
 * Be honest about the reach of this. It stops a PAGE on another origin reading boards
 * through the reviewer's browser. It does NOT stop the attack that motivated it (audit
 * 2026-07-31 S1): a local process that harvested the cookie — cookies are not port-scoped,
 * so any other http server on this host receives it — sets whatever headers it likes and
 * is indistinguishable from the browser here. That exposure is bounded by the cookie's
 * lifetime and named in SECURITY.md; it is not closed by this function, and this comment
 * exists so nobody later reads the check and concludes that it is. */
function isAuthorizedRead(req, secret) {
  if (!secret) return false;
  if (secretMatches(req.headers[SECRET_HEADER], secret)) return true;
  if (!sessionCookieMatches(req.headers.cookie, secret)) return false;
  return isSameOriginRead(req);
}

/** Origin/Sec-Fetch-Site as they apply to a cookie-authenticated READ. Absence passes,
 * exactly as it does for writes: the shim, curl and the checks send neither, and a
 * top-level browser navigation — the bookmark case criterion 2 turns on — sends
 * `Sec-Fetch-Site: none`. Requiring presence would refuse both and buy nothing, since
 * the caller this would be aimed at can set the header anyway. */
function isSameOriginRead(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/** The pomodoro writes a cookie-holding browser may perform, and NOT a moment more.
 * Named and enumerated exactly like `isSubmit` below, on purpose — never a
 * `parts[1] === 'pomodoro'` prefix match, which would silently hand the cookie every
 * pomodoro write this file ever grows, including ones that should stay secret-only.
 * `ensure` was originally left OUT of this set, on the reasoning that its one caller
 * (ticket 05's session-start hook) is a shell script holding the secret and never a
 * browser. It is in now, because that stopped being true: the index widget's switch
 * starts a pomodoro by hand, and a browser is exactly what performs it. The reach it
 * adds is the smallest of the five — `startWork` is a no-op against any timer that
 * already exists (src/pomodoro.mjs), so the worst a cookie-holder can do with it is
 * begin an advisory clock that `reset`, already on this list, would have let them end
 * anyway. It stays a NAMED member of a closed set rather than a
 * `parts[1] === 'pomodoro'` prefix match, so the next pomodoro write this file grows
 * is still secret-only until someone deliberately types it here. */
const POMODORO_COOKIE_ACTIONS = new Set(['ensure', 'pause', 'resume', 'reset', 'settings']);

function isPomodoroCookieWrite(parts) {
  return parts[0] === 'api' && parts[1] === 'pomodoro' && parts.length === 3 && POMODORO_COOKIE_ACTIONS.has(parts[2]);
}

/** True iff this write may proceed. Two ways to hold a credential, and they are not
 * interchangeable:
 *
 *  - the secret itself, in the `x-claude-board-secret` header. That is the shim, and it
 *    is what EVERY write except submit and the five pomodoro actions below demands —
 *    including `POST /api/board`, the only route that resolves a file, and
 *    `POST /api/handoff`, which mints browser credentials and so must never be
 *    reachable with one.
 *  - the session cookie an authorized browser holds, accepted on submit, and — as of
 *    the pomodoro slice — on `ensure`/`pause`/`resume`/`reset`/`settings` too. The index
 *    page's switch is a browser holding only the cookie: under the old rule it could
 *    render the board but could not press pause. The justification is the same one that
 *    already let submit in: the cookie is worth "may read every board in the store and
 *    may answer any open round" (src/secret.mjs `sessionToken`'s own comment), and
 *    pausing an advisory clock that never touches a board, never gates an `ask`, and
 *    never reaches a tool is strictly less than that — `isSameOriginWrite` still stands
 *    in front of it, exactly as it does for submit. The board-scoped fallback token that
 *    used to sit here is deleted rather than kept beside it (SPEC_LAUNCH.md: "Submit
 *    collapses into the read credential").
 *
 * Every non-GET goes through here, rather than an enumerated list of write routes: a
 * route added later is then gated by default instead of by remembering to add it. The
 * pomodoro exception is itself a closed, named list for the same reason — see
 * POMODORO_COOKIE_ACTIONS above. */
function isAuthorizedWrite(req, parts, secret) {
  if (!secret) return false; // no secret on disk: refuse writes rather than fall open
  if (secretMatches(req.headers[SECRET_HEADER], secret)) return true;
  const isSubmit = parts[0] === 'api' && parts[1] === 'board' && parts.length === 4 && parts[3] === 'submit';
  if (!isSubmit && !isPomodoroCookieWrite(parts)) return false;
  return sessionCookieMatches(req.headers.cookie, secret);
}

/** The two GET routes that are reachable with no credential, and the reason each is.
 *
 *  - `/api/health`: install.sh polls it with plain `curl` to decide whether the service
 *    actually came up, and gating it would make a fresh install report failure on a
 *    daemon that is working perfectly. It answers `{ ok, version }` and nothing else —
 *    no board, no path, no store contents.
 *  - `/auth/<token>`: the route that hands a browser its credential. Requiring one here
 *    would be a bootstrap loop. It is protected by the token being single-use, unguessable
 *    and seconds-lived instead (src/handoff.mjs).
 *
 * Deliberately a closed list, not a prefix or a pattern: a route added later is gated
 * unless someone comes here and argues for it. */
function isOpenRoute(pathname, parts) {
  if (pathname === '/api/health') return true;
  return parts[0] === 'auth' && parts.length === 2;
}

/** True iff the refusal should be an HTML page rather than a status and a JSON line.
 * A browser NAVIGATION is the case that needs prose — the reader is looking at a tab and
 * needs to be told what to type. Everything else gets the status and no markup: `/api/*`
 * covers the page's own fetches and the SSE stream (EventSource sends
 * `Accept: text/event-stream` and could not display a page anyway), and a caller that
 * does not ask for `text/html` — curl, the shim, the checks — is not a tab either. */
function wantsHtmlRefusal(req, pathname) {
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  return /\btext\/html\b/i.test(String(req.headers.accept || ''));
}

/** One status code for "no credential", everywhere: 401, matching what writes have
 * always answered, and documented as such in PROTOCOL.md.
 *
 * No `WWW-Authenticate` header, deliberately. 401 is the honest status, but that header
 * is what makes a browser throw up a username/password prompt — and there is no password
 * here, so a prompt would be an unanswerable dialog in front of the one page that
 * explains the actual fix. SPEC_LAUNCH.md rejected Basic auth for the same reason. */
function sendCredentialRefusal(req, res, pathname) {
  const command = recoveryCommand();
  if (wantsHtmlRefusal(req, pathname)) {
    return sendHtml(res, 401, renderRefusalPage(command), { 'cache-control': 'no-store' });
  }
  return sendJson(res, 401, { error: 'no claude-board credential', recover: command });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // A JSON content-type is the other half of the same guard: `text/plain` and the
    // form encodings are CORS *simple* requests, so a cross-origin page can send them
    // with no preflight; `application/json` always costs a preflight, which the daemon
    // answers for nobody.
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') {
      return reject(Object.assign(new Error('content-type must be application/json'), { status: 415 }));
    }
    // Buffers, decoded once at the end — never `data += chunk`. A socket chunk boundary
    // falls wherever the kernel put it, so stringifying each chunk on its own turns any
    // multi-byte character that straddles one into U+FFFD: an `é` in a 70KB html stage
    // silently became two replacement characters, stored with no error anywhere, which
    // is exactly the "a rendered board is always a faithful view of its source"
    // guarantee failing. bin/mcp.mjs's own reader already does it this way.
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > 25_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Content-Security-Policy for every HTML response, plus the X-Frame-Options that
// says the same thing to anything that predates `frame-ancestors` -- `CSP`
// itself now lives in src/render.mjs (ticket 10, DESIGN.md, audit S2),
// single-sourced with the `<meta http-equiv>` renderBoardPage now also emits, so
// an archived board opened from disk with no daemon (and so no HTTP response to
// carry this header) still carries the policy. See render.mjs's own comment on
// `CSP` for what it allows and why. The framing half (`frame-ancestors`, only
// honoured here, on the header — see render.mjs's comment on what a `<meta>`
// policy silently drops) is the point on the LIVE path specifically: the index
// sorts live-first then newest, so a board planted by a cross-origin post would
// be the top row with an attacker-chosen `cwd` as its label, one invisible click
// from loading a board whose `html` stage then runs at the daemon's own origin.

function sendHtml(res, status, html, extraHeaders = null) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...(extraHeaders || {}),
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// `/file/` serves bytes the daemon did not author, so it gets its own policy rather than
// the board `CSP` above. Three clauses are load-bearing and the rest is habit:
//
//   script-src 'self'   a rendered document loads its own vendored engine (the whole
//                       complaint that started this: the board CSP names no 'self', so a
//                       document embedded in a stage lost its diagrams to a CDN fallback)
//   connect-src 'none'  and this is the one that matters. The session cookie is
//                       HttpOnly and SameSite=Strict, so a served document cannot READ
//                       it -- but it is same-origin with /api/board, and a plain
//                       `fetch('/api/board/<id>/submit', {credentials:'same-origin'})`
//                       would carry that cookie and answer a question as the reviewer.
//                       'none' is what makes a served file inert toward the daemon.
//   form-action 'none'  the same escalation, spelled as a <form> instead of a fetch.
//
// What this deliberately does NOT stop: a top-level navigation from a served page to a
// daemon URL. Those are GETs against read routes, they land in a visible tab rather than
// in script, and blocking them would need `navigate-to`, which no shipping browser has.
const SERVE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

// Enough types for a rendered document and the assets one carries. An unknown extension
// is served as a download rather than guessed at: `nosniff` is on every response, so an
// octet-stream is inert in a way a mis-guessed `text/html` would not be.
const SERVE_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** The serve allowlist, read per request for the same reason `resolveRefRoots` is:
 * a handful of syscalls, and a user who edits the env var sees the effect without a
 * fresh daemon. Absent means empty, which means `/file/` is a 404 for everything. */
function serveRoots() {
  return resolveRefRoots(process.env.CLAUDE_BOARD_SERVE_ROOTS);
}

/** `GET /file/<path>` — a file from a serve root, byte for byte.
 *
 * Behind the read gate like every other non-open route, so only a browser holding the
 * session cookie gets here. Streamed from the descriptor `openServed` already opened and
 * fstat'd, never re-opened by name: the file that passed the guards is the file that is
 * sent. There is no byte cap, unlike a reference — the point of this route is a whole
 * document plus a multi-megabyte diagram engine, and nothing is buffered to reach it. */
function handleServeFile(req, res, relPath) {
  const opened = openServed(relPath, serveRoots());
  if (opened.error) return sendText(res, 404, 'not found');

  const stream = createReadStream('', { fd: opened.fd, autoClose: true });
  stream.on('error', () => {
    // Mid-stream failure: the head is already out, so there is no status left to send
    // and the honest move is a truncated body rather than a lie about its length.
    res.destroy();
  });
  res.writeHead(200, {
    'content-type': SERVE_TYPES[path.extname(opened.path).toLowerCase()] || 'application/octet-stream',
    'content-length': String(opened.size),
    'content-security-policy': SERVE_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    // These are local files a generator rewrites in place under a stable name; a
    // reviewer reloading after a re-render must not get yesterday's document.
    'cache-control': 'no-store',
  });
  stream.pipe(res);
}

function boardUrl(req, id) {
  return `http://${req.headers.host}/b/${id}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll the store until `round` is sent. Reads from disk each iteration, so this is
 * agnostic to whether the caller was here before a daemon restart.
 *
 * Two ways out other than the round being sent, because this is a `for(;;)` in a
 * single-threaded daemon that launchd keeps alive forever: `isAborted()` (the client
 * hung up — the same liveness rule handleEvents applies to an SSE subscription) and
 * `deadlineAt` (the wall-clock cap). Without them every timed-out or abandoned `ask`
 * would leave a loop re-parsing a board JSON — which embeds full file snapshots — every
 * 120ms for the life of the machine. Returns a tagged result rather than a board so the
 * caller can tell "gone" from "nobody answered" from "the client left". */
async function waitForRound(boardId, round, home, { intervalMs = 120, isAborted = () => false, deadlineAt = Infinity } = {}) {
  activeWaits++;
  try {
    for (;;) {
      if (isAborted()) return { aborted: true };
      const board = readBoard(boardId, home);
      if (!board) return { gone: true };
      const r = board.rounds.find(r => r.n === round);
      if (r && r.status === 'sent') return { board };
      if (Date.now() >= deadlineAt) return { timedOut: true, board };
      await sleep(intervalMs);
    }
  } finally {
    activeWaits--;
  }
}

/** Every comment run through resolveComment (src/board.mjs) exactly once, same
 * as renderBoardPage: `commentsByBlock` for whatever gets rendered here, and
 * `boardForClient` -- `board` with resolved-shape comments -- for whatever gets
 * embedded for the client to hydrate `board` from. Ticket 06's pin rendering
 * reads `.resolved`/`.lost` off `board.comments` directly rather than
 * re-deriving them; if an SSE payload's `board` field carried the raw stored
 * comment shape instead (no `.resolved`, no `.lost`), a client's local `board`
 * variable would go stale-shaped the moment ANY push landed, and every pin
 * placed after that would silently stop knowing whether its anchor still
 * resolves. See this same reasoning in src/render.mjs's file header. */
function resolveBoardComments(board) {
  const resolvedComments = resolveComments(board, board.comments);
  return {
    commentsByBlock: groupCommentsByBlock(resolvedComments),
    boardForClient: { ...board, comments: resolvedComments },
  };
}

/** Render the SSE payload for a live push: the full board (so a subscriber's local
 * `computeBoardPatch(prevBoard, nextBoard)` can diff against it) plus a pre-rendered
 * HTML fragment covering exactly the blocks this push touched -- never the whole
 * page -- so the client only ever inserts/replaces that much DOM. `mode` is
 * 'new-round' (a fresh round section, rendered via renderRoundSection so a later
 * full reload is byte-identical to what the push already inserted) or 'amend' (the
 * round is unchanged, only specific blocks inside it were added or replaced, so the
 * fragment is just those blocks via renderBlock, with no round wrapper). */
function buildRoundPushPayload(board, round, mode, blockIds) {
  const { commentsByBlock, boardForClient } = resolveBoardComments(board);
  const html = mode === 'new-round'
    ? renderRoundSection(board, round, commentsByBlock)
    : blockIds
      .map(id => {
        const block = board.blocks.find(b => b.id === id);
        return block ? renderBlock(block, board, commentsByBlock, false) : '';
      })
      .join('\n');
  return { round, mode, blockIds, html, board: boardForClient };
}

/** The project directory already bound to `thread`, or null when this is a thread
 * nobody has posted to yet. The thread's OLDEST board is the one that bound it, so
 * that is the one asked — reading "whatever the newest board says" would let a board
 * that somehow slipped through re-decide the answer for everything after it.
 *
 * This walks the store, which is why it is only called when the caller actually names
 * a thread: a first post (the overwhelmingly common case, and the one the shim makes)
 * pays nothing. */
function boundCwdForThread(thread, home) {
  const inThread = listBoards(home)
    .filter(b => b && b.thread === thread && b.cwd)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return inThread.length ? inThread[0].cwd : null;
}

async function handlePostBoard(req, res, home, sse) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  let board;
  let round;
  let pushMode = null; // null: a brand-new board, nothing live to push to yet
  let touchedBlockIds = [];
  try {
    if (body.boardId) {
      board = readBoard(body.boardId, home);
      if (!board) return sendJson(res, 404, { error: 'board not found' });
      // Idempotency (audit 2026-07-31 D1). Everything after readJsonBody is synchronous,
      // so a socket that dies before the response lands — a reload-on-change exit, a
      // kickstart, the shim's own inactivity timeout — leaves the round fully applied and
      // the caller told it failed. The agent then retries, and amendRound APPENDS a second
      // copy of every block: the reviewer sees the same question twice in one round. A
      // retry carrying the same `requestId` is answered from what that id already did.
      // Scoped to the round it guarded (audit). `lastRequestId` used to persist for
      // the life of the board, and `requestId` is derived from the round's CONTENT --
      // so the ordinary fix-and-reconfirm loop ("show file, ask, fix, show the same
      // file, ask again") posted a byte-identical body and was answered as a retry.
      // No round was created, nothing was pushed, and the shim's /wait returned the
      // PREVIOUS round's answer in milliseconds: the agent was handed a decision the
      // reviewer never made. The lost-response retry this defends against always
      // targets a still-open round, so gating on that costs nothing.
      const guarded = board.rounds[board.rounds.length - 1];
      if (body.requestId && board.lastRequestId === body.requestId && guarded && guarded.status === 'open') {
        return sendJson(res, 200, {
          boardId: board.id,
          thread: board.thread,
          round: board.rounds[board.rounds.length - 1].n,
          url: boardUrl(req, board.id),
          clients: sse.clientCount(board.id),
          deduped: true,
        });
      }
      const latestRound = board.rounds[board.rounds.length - 1];
      if (latestRound && latestRound.status === 'open') {
        // The open round hasn't been sent yet: amend it in place rather than
        // minting round N+1 (see DESIGN.md "the agent may amend a round that
        // is still open... without disturbing filled-in fields").
        //
        // `title` is passed through on both paths: `ask` requires a non-empty title on
        // every call and commands/grill.md tells the agent to make it the branch name,
        // so dropping it on every round after the first leaves the reviewer looking at
        // an unlabelled "Round 2". Storing it on the round object is src/board.mjs's
        // half and rendering it is src/render.mjs's — both owned elsewhere; this side
        // stops throwing the value away.
        // `cwd` is forwarded so assertCwdNotRetargeted can actually refuse it (audit).
        // It was dropped here, so the guard only ever saw `undefined` and returned at
        // once: a post naming a different `cwd` alongside `boardId` got a 200 and the
        // caller believed it had retargeted the board. PROTOCOL.md and the guard's own
        // comment both specify a loud 400 instead of a silent no-op.
        const result = amendRound(board, { blocks: body.blocks, title: body.title, cwd: body.cwd });
        round = result.round;
        touchedBlockIds = result.blockIds;
        pushMode = 'amend';
      } else {
        round = addRound(board, { blocks: body.blocks, title: body.title, cwd: body.cwd });
        touchedBlockIds = board.blocks.filter(b => b.round === round).map(b => b.id);
        pushMode = 'new-round';
      }
    } else {
      // A SECOND board in an EXISTING thread inherits that thread's already-bound
      // project directory and may not move it (src/board.mjs `bindBoardCwd`). Without
      // passing it, the additive `threadCwd` guard is dead code and the thread's
      // directory is re-decided by whoever posts next: the reviewer follows a link
      // from a thread they trust into a board reading somewhere else entirely.
      board = createBoard({
        title: body.title,
        blocks: body.blocks,
        cwd: body.cwd ?? null,
        thread: body.thread ?? null,
        threadCwd: body.thread ? boundCwdForThread(body.thread, home) : null,
      });
      round = 1;
    }
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }
  // Rendered BEFORE either persist call (ticket 11, audit V5a): renderBoardPage
  // walks every comment's anchor through resolveComment, which used to be able to
  // throw (decodeEntities' RangeError on an out-of-range numeric entity -- fixed
  // in src/anchor.mjs, but the ordering here is a second, independent guard
  // against the SAME failure shape from any future bug on that path). Rendering
  // first means a board that cannot render never becomes the persisted state in
  // the first place: if it throws, neither writeBoard nor writePage below runs,
  // this request 500s, and the store is exactly as it was before this call --
  // retryable, not wedged. The alternative (persist first, as this used to)
  // durably records the change while the archive silently stays a round behind,
  // and since GET /b/:id and /wait both re-render the SAME persisted board on
  // every future request, a render bug there turns into a permanent 500 for the
  // life of the board, not just this one request.
  // Recorded on the board rather than in memory: the failure this defends against is a
  // daemon that went away mid-request, so a dedupe table the restart empties would be
  // empty in exactly the case it is needed.
  if (body.requestId) board.lastRequestId = body.requestId;
  const html = renderBoardPage(board);
  writeBoard(board, home);
  writePage(board.id, html, home);
  if (pushMode) sse.broadcast(board.id, 'round', buildRoundPushPayload(board, round, pushMode, touchedBlockIds));
  // `clients` is the count at the instant this round landed, which is what lets the shim
  // tell "the reviewer closed the tab" from "the reviewer is looking at it" and reopen
  // only in the first case. See createSseHub.clientCount (audit 2026-07-31 S3).
  return sendJson(res, 200, {
    boardId: board.id,
    thread: board.thread,
    round,
    url: boardUrl(req, board.id),
    clients: sse.clientCount(board.id),
  });
}

/** Serve the board page. Reached only by a caller that already presented a credential
 * (gate 4), so it hands out none of its own: no `Set-Cookie` here, and nothing about the
 * credential in the markup. That keeps the served page's bytes a pure function of the
 * board JSON, which is what makes the standalone `pages/*.html` archive byte-identical
 * to what the daemon serves — and what makes an archived board openable from disk with
 * no daemon and no credential at all (SPEC_LAUNCH.md criterion 6). */
function handleGetPage(req, res, id, home) {
  const board = readBoard(id, home);
  if (!board) return sendText(res, 404, 'board not found');
  return sendHtml(res, 200, renderBoardPage(board));
}

/** POST /api/handoff -> { token, expiresAt }. Reached only with the SECRET (gate 3 does
 * not accept the session cookie for anything but submit), so a browser cannot mint
 * itself a second credential and neither can anything holding only a stolen cookie.
 *
 * The caller names a board, never a URL or a path: `handoffTarget` turns anything that
 * is not a board id into the index, so the redirect target is one of two shapes this
 * daemon chose and an open redirect is impossible by construction rather than by
 * validation. The response carries the token only — the caller builds the URL from its
 * own base URL, because "whatever answered on the port" is not necessarily this daemon
 * (see bin/mcp.mjs `safeBoardUrl` for the same reasoning). */
async function handleMintHandoff(req, res, handoffs) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  const { token, expiresAt } = handoffs.mint(handoffTarget(body && body.boardId));
  return sendJson(res, 200, { token, expiresAt, ttlMs: expiresAt - Date.now() });
}

/** GET /auth/:token — the whole point of the handoff: consume it, set the cookie, and
 * redirect to a CLEAN url. What is left in the address bar after this carries no
 * credential, so reloading it, bookmarking it and opening the bookmark days later all
 * work (the cookie is long-lived and derived from the secret, so a daemon restart does
 * not invalidate it) while the bookmark itself is worth nothing to anyone who copies it.
 *
 * A token that is expired, already used, or never existed gets the same refusal as a
 * browser with no credential at all: identical status, identical page, no hint about
 * which of the three it was. That is what makes a replay — including one by a process
 * that read the URL out of `ps` while the browser was fetching it — gain nothing.
 *
 * `Cache-Control: no-store` because a cached 302 would let a back-button navigation
 * "re-consume" a handoff from disk and land on a board it no longer authorizes;
 * `Referrer-Policy: no-referrer` so the token cannot ride out on a Referer from the
 * board page's own subresource loads. */
function handleAuthHandoff(req, res, token, handoffs, secret, pathname) {
  const entry = HANDOFF_TOKEN_RE.test(token) ? handoffs.consume(token) : null;
  const cookie = entry ? sessionToken(secret) : null;
  if (!entry || !cookie) {
    // A spent token in the hands of a browser that ALREADY holds the cookie is not an
    // attack, it is the Back button — and three other routine things: a daemon reload
    // between mint and fetch (the handoff store is process-local), the 30s TTL expiring
    // on a cold browser start, and Chrome's prerender spending the token before the
    // visible navigation. Refusing the replay is still right; telling a fully authorized
    // browser it holds no credential, and naming a command that changes nothing for it,
    // is not (audit 2026-07-31 D3). Send it where the token would have sent it.
    if (isAuthorizedRead(req, secret)) {
      res.writeHead(302, { location: handoffTarget(null), 'cache-control': 'no-store', 'content-length': '0' });
      return res.end();
    }
    return sendCredentialRefusal(req, res, pathname);
  }
  res.writeHead(302, {
    location: entry.target,
    'set-cookie': `${SESSION_COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; SameSite=Strict`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': '0',
  });
  res.end();
}

async function handleWait(req, res, id, url, home) {
  const roundParam = url.searchParams.get('round');
  const round = roundParam ? parseInt(roundParam, 10) : 1;
  const initial = readBoard(id, home);
  if (!initial) return sendJson(res, 404, { error: 'board not found' });
  if (!initial.rounds.some(r => r.n === round)) return sendJson(res, 404, { error: 'round not found' });

  let aborted = false;
  const onClose = () => { aborted = true; };
  req.on('close', onClose);
  res.on('close', onClose);

  const result = await waitForRound(id, round, home, {
    isAborted: () => aborted,
    deadlineAt: Date.now() + waitTimeoutMs(),
  });
  if (result.aborted) return; // the client is gone: nothing to write, nothing to keep polling for
  if (result.gone) return sendJson(res, 404, { error: 'board not found' });
  if (result.timedOut) {
    // The wall-clock cap is an explicit no-response, not an error: same `timeout`
    // status PROTOCOL.md "Packet" already defines, carrying whatever partial answers
    // the store holds.
    return sendJson(res, 200, { ...buildPacket(result.board, round, boardUrl(req, id)), status: 'timeout' });
  }
  return sendJson(res, 200, buildPacket(result.board, round, boardUrl(req, id)));
}

async function handleSubmit(req, res, id, home, sse) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  const board = readBoard(id, home);
  if (!board) return sendJson(res, 404, { error: 'board not found' });
  // A round is answered exactly once, and the submitter must name which round it is
  // answering. Applying a body to "whichever round the server currently thinks is open"
  // rewrote history two ways: after a round was sent it landed on that sent round
  // (rewriting answers, notes, comments and even `sentAt`, forever), and while a NEWER
  // round was open it took a stale client's round-1 answers and marked round 2 sent with
  // everything else unanswered. A stale client is the normal case, not an attack: a
  // laptop waking from sleep with no SSE replay, a second tab, or a plain double-click
  // on Send. The board is meant to be the durable record of what was decided
  // (DESIGN.md board criterion 4), so a submit that does not name the currently-open round
  // is refused with 409 and changes nothing — which is also what makes a client retry
  // safe, rather than duplicating every comment (and its pin number, PROTOCOL.md
  // "Identifiers") and re-applying every answer.
  const openRound = board.rounds.find(r => r.status === 'open');
  const openN = openRound ? openRound.n : null;
  const claimed = body.round;
  if (!Number.isInteger(claimed)) {
    // "No round named" on a board with no open round is not a malformed request, it is
    // the already-submitted case — and it is the exact body the page sends when its Send
    // button is pressed on a finished board, because openRoundNumber() returns null
    // there. Answering 400 sent the client down its generic error path (it special-cases
    // only 409), which showed `submit failed: 400` and re-enabled the buttons for an
    // identical retry, forever (audit 2026-07-31 D2). 409 is both truer and handled.
    if (openN === null) {
      return sendJson(res, 409, { error: 'this board has already been submitted', board: board.id, round: null });
    }
    return sendJson(res, 400, { error: 'submit requires an integer "round" naming the round being answered', board: board.id, round: openN });
  }
  if (openN === null || claimed !== openN) {
    return sendJson(res, 409, {
      error: openN === null
        ? `round ${claimed} is not open: this board has already been submitted`
        : `round ${claimed} is not the open round (${openN}) — reload the board to see what has changed`,
      board: board.id,
      round: openN,
    });
  }
  const round = openN;
  applySubmit(board, { action: body.action, answers: body.answers, comments: body.comments }, round);
  // Rendered BEFORE either persist call below (ticket 11, audit V5a) -- see
  // handlePostBoard's identical ordering, and its comment, for the full
  // reasoning: a board that fails to render must never become the persisted
  // state, since GET /b/:id and /wait both re-render that same persisted board
  // on every future request, and a failure that only shows up after the durable
  // write is a wedge for the life of the board, not a single failed request.
  const pageHtml = renderBoardPage(board);
  writeBoard(board, home);
  writePage(board.id, pageHtml, home);
  // Every connected client -- including the one that just submitted, which is
  // subscribed to its own board like any other -- collapses this round into the
  // history rail on the same signal, so a second tab never has to reload to see
  // it. `html` is the round re-rendered from the now-authoritative board (the
  // actual answers/notes/choices that were sent), not a hint to disable whatever
  // happened to already be on screen in some OTHER tab -- a second tab's own
  // unsent, unrelated selections were never what got sent, and freezing them into
  // the history rail as if they were would show every reviewer a different,
  // wrong "what was answered". A round that just became sent carries no more
  // in-progress state worth preserving, so replacing its markup outright here is
  // correct, not merely convenient.
  const { commentsByBlock, boardForClient } = resolveBoardComments(board);
  const html = renderRoundSection(board, round, commentsByBlock);
  sse.broadcast(id, 'submitted', { round, board: boardForClient, html });
  return sendJson(res, 200, { ok: true, board: board.id, round });
}

/** GET /api/board/:id/events: subscribe this connection to round pushes and submit
 * notifications for `id`. Never resolves on its own -- the response stays open
 * until the client disconnects -- so unlike the other handlers this is not awaited
 * by the caller. Heartbeat comment lines keep it alive through idle timers and
 * proxies (see DEFAULT_SSE_HEARTBEAT_MS); `req`/`res` close/error tear the
 * subscription and the interval down so a disconnected client is never broadcast
 * to. See PROTOCOL.md "SSE events". */
function handleEvents(req, res, id, home, sse) {
  const board = readBoard(id, home);
  if (!board) return sendJson(res, 404, { error: 'board not found' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  sse.subscribe(id, res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* connection is gone; cleanup below handles it */ }
  }, sseHeartbeatMs());
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    sse.unsubscribe(id, res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/** `{ ...doc, now: Date.now() }` for every pomodoro response, write or read alike. The
 * page renders a countdown by subtracting a deadline from a clock, and the client's
 * clock is not the daemon's (a laptop's wall clock can be minutes off, and even a
 * correct one is a separate process): handing back the SERVER's own `now` alongside the
 * document lets the page compute `serverNow - Date.now()` once on load and keep
 * subtracting that same offset from its own clock forever after, rather than trusting
 * whatever the browser's `Date.now()` says the deadline is `deadline - now` away. */
function sendPomodoro(res, doc) {
  return sendJson(res, 200, { ...doc, now: Date.now() });
}

/** Every `/api/pomodoro*` route. `pomo` is the ONE createPomodoro instance for this
 * daemon (see createRequestHandler) — every write below goes through it rather than a
 * bare readDoc/writeDoc pair, specifically so the live setTimeout it owns gets
 * re-armed (or cleared) as part of the same call, never as an afterthought a route
 * handler could forget. See PROTOCOL.md "HTTP surface" for the route table this
 * implements. */
async function handlePomodoro(req, res, parts, pomo, home) {
  // GET /api/pomodoro: read straight off disk, not through `pomo`. This is safe — not
  // merely convenient — because reconciliation happens SYNCHRONOUSLY in this same
  // single-threaded event loop the instant a deadline is crossed (the armed
  // setTimeout's own callback), so by the time any request handler runs, a deadline
  // that has already passed has already been settled and written back. There is
  // nothing left for a GET to reconcile.
  if (req.method === 'GET' && parts.length === 2) {
    return sendPomodoro(res, readPomodoroDoc(home));
  }
  if (req.method === 'POST' && parts.length === 3) {
    const action = parts[2];
    // Bodyless by design: `readJsonBody` is never called on this branch, which is what
    // makes a curl-shaped `POST /api/pomodoro/ensure` with no body and no
    // `content-type` succeed rather than 415 — ticket 05's session-start hook is a
    // one-line shell `curl`, and it must not have to construct or parse anything.
    if (action === 'ensure') return sendPomodoro(res, pomo.ensureTimer());
    if (action === 'pause') return sendPomodoro(res, pomo.pause());
    if (action === 'resume') return sendPomodoro(res, pomo.resume());
    if (action === 'reset') return sendPomodoro(res, pomo.reset());
    if (action === 'settings') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
      }
      try {
        return sendPomodoro(res, pomo.settings(body));
      } catch (err) {
        // mergeSettings (src/pomodoro.mjs) throws naming the offending field; a rejected
        // body is a 400 with that message, never a silent partial write — nothing in
        // `pomo.settings` persists anything before every field in the patch validates.
        return sendJson(res, 400, { error: String(err.message || err) });
      }
    }
  }
  return sendText(res, 404, 'not found');
}

/** Build the daemon's request handler as a plain `node:http` listener, without
 * binding a port — used directly by the check and by `startServer` below. Each
 * call gets its own SSE subscriber registry (createSseHub), so two independent
 * handlers built in the same process — as the checks do — never share subscribers. */
export function createRequestHandler({ home = boardHome(), secret: pinnedSecret, pomodoro } = {}) {
  const sse = createSseHub();
  // A caller-supplied instance (startServer's, below) is what makes pause/resume/reset/
  // settings and the boot-time clock share the ONE live setTimeout for this daemon —
  // two independent createPomodoro() instances against the same home would each arm
  // their own timeout off the same file, and whichever fired second would stomp the
  // first's write. Defaulted rather than required only so createRequestHandler stays
  // usable on its own (as it always has been) without every caller learning about
  // pomodoro; nothing today calls it that way, and this instance is never booted here —
  // boot-time reconciliation is startServer's job, exactly as it already was.
  const pomo = pomodoro || createPomodoro({ home });
  // Per-instance, like the SSE hub and for the same reason: two daemons in one process
  // (as the checks spin up) must not redeem each other's handoffs.
  const handoffs = createHandoffStore();
  // Re-read PER REQUEST, not once at startup (audit 2026-07-31 S4). SECURITY.md,
  // PROTOCOL.md, CHANGELOG.md and src/secret.mjs all name rotating the secret as THE way
  // to revoke every browser at once. With the value captured in a closure that was false
  // in the worst direction: the running daemon kept honouring the OLD secret — so a
  // stolen cookie stayed live until the next reboot — while every freshly started shim
  // read the NEW one and got 401s. The owner broke their own agent and revoked nothing.
  // A caller that passes `secret` explicitly still pins it, which is what the checks do;
  // absent, it comes off disk on every request. That is a 64-byte readFileSync next to a
  // board parse, and it is what makes the documented revocation actually revoke.
  const currentSecret = () => (pinnedSecret !== undefined ? pinnedSecret : readSecret());
  // Say so plainly if it is missing — a daemon that silently accepted every write
  // because the file was gone would be worse than one that refuses, since nothing in
  // the UI would ever hint that the gate was open. Startup-time only: this is a message
  // for the operator's log, not a gate, and every gate below re-reads.
  if (!currentSecret()) {
    console.error(
      `claude-board: no local secret at ${secretPath()} — every request except /api/health will be ` +
      `refused with 401, reads included: the session cookie a browser holds is derived from the ` +
      `secret, so with no secret there is no credential to accept. Run ./install.sh from the ` +
      `claude-board repository to generate one; an existing secret is never rotated.`
    );
  }
  return async function requestHandler(req, res) {
    try {
      const secret = currentSecret();
      if (!isLoopbackHost(req.headers.host)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method !== 'GET' && !isSameOriginWrite(req)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const url = new URL(req.url, 'http://internal');
      const parts = url.pathname.split('/').filter(Boolean);

      // Gate 3, after the two 403s so a cross-origin page still gets the same refusal
      // it always did. 401 with no body: a caller that does not hold the credential
      // learns nothing about what is behind it — not whether the board exists, not
      // whether the body would have parsed.
      if (req.method !== 'GET' && !isAuthorizedWrite(req, parts, secret)) {
        res.writeHead(401);
        res.end();
        return;
      }

      // Gate 4: the read gate. Everything except the two open routes above needs a
      // credential — index, board page, search, /wait and the SSE stream alike. Unlike
      // the write refusal this one carries a body, because the caller it most often
      // refuses is a human looking at a tab, not a program: see sendCredentialRefusal.
      //
      // (Ablation: delete this block and an unauthenticated index, board page and event
      // stream all answer 200 again — i.e. any local process reads every board, source
      // excerpts included. test/check-http.mjs is where that shows up, and nowhere else.)
      if (req.method === 'GET' && !isOpenRoute(url.pathname, parts) && !isAuthorizedRead(req, secret)) {
        return sendCredentialRefusal(req, res, url.pathname);
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: PKG_VERSION });
      }

      if (req.method === 'GET' && parts[0] === 'auth' && parts.length === 2) {
        return handleAuthHandoff(req, res, parts[1], handoffs, secret, url.pathname);
      }

      if (req.method === 'POST' && url.pathname === '/api/handoff') {
        return await handleMintHandoff(req, res, handoffs);
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const query = url.searchParams.get('q') || '';
        // One walk of the store, and no full-text search behind it: the box on this
        // page filters the thread list on session identity alone (title, project
        // folder, cwd, thread id), all of which buildThreadIndex has already
        // extracted from this same walk. `GET /api/search` is unchanged and remains
        // the full-text route over board bodies.
        const threads = buildThreadIndex(listBoards(home));
        // INDEX_CSP, not the board CSP: the search box is a plain GET form back to
        // this same route, and `form-action 'none'` makes the browser refuse to
        // submit it. See render.mjs's comment on INDEX_CSP.
        return sendHtml(res, 200, renderIndexPage({ threads, query }), {
          'content-security-policy': INDEX_CSP,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const results = searchBoards(query, home).map(r => ({ ...r, url: boardUrl(req, r.boardId) }));
        return sendJson(res, 200, { results });
      }

      if (req.method === 'POST' && url.pathname === '/api/board') {
        return await handlePostBoard(req, res, home, sse);
      }

      if (req.method === 'GET' && parts[0] === 'b' && parts.length === 2) {
        return handleGetPage(req, res, parts[1], home);
      }

      if (req.method === 'GET' && parts[0] === 'file') {
        // `url.pathname` is still percent-encoded, so it is decoded HERE, once, and the
        // result is handed over as an ordinary relative path. Decoding can reintroduce
        // separators (`%2F`) and dot segments (`%2e%2e`), which is precisely why
        // `openServed` splits and re-validates what it is given rather than trusting a
        // caller to have done it: an encoded traversal arrives as the literal `..`
        // segment it always was and is refused there. Decoding once, before any of that,
        // is what keeps it from being a second thing to get right. A malformed escape
        // throws, and is a 404 like every other refusal on this route.
        let relPath;
        try {
          relPath = parts.slice(1).map(decodeURIComponent).join('/');
        } catch {
          return sendText(res, 404, 'not found');
        }
        return handleServeFile(req, res, relPath);
      }

      if (parts[0] === 'api' && parts[1] === 'board' && parts.length === 4) {
        const boardId = parts[2];
        const action = parts[3];
        if (req.method === 'GET' && action === 'wait') {
          return await handleWait(req, res, boardId, url, home);
        }
        if (req.method === 'GET' && action === 'events') {
          return handleEvents(req, res, boardId, home, sse);
        }
        if (req.method === 'POST' && action === 'submit') {
          return await handleSubmit(req, res, boardId, home, sse);
        }
      }

      if (parts[0] === 'api' && parts[1] === 'pomodoro') {
        return await handlePomodoro(req, res, parts, pomo, home);
      }

      return sendText(res, 404, 'not found');
    } catch (err) {
      // A tagged status means the request was refusable, not that the daemon broke:
      // src/store.mjs throws `status: 400` for an id that cannot be a path, and that
      // reaches here from every route that takes an id out of the URL rather than the
      // body. Answering 500 would file an attack as a server fault in the log a reader
      // uses to find real ones.
      const status = err && Number.isInteger(err.status) ? err.status : 500;
      return sendJson(res, status, { error: String((err && err.message) || err) });
    }
  };
}

/** Start listening on 127.0.0.1. Resolves once bound, with the actual port (useful
 * for `port: 0` ephemeral binding in checks). */
export function startServer({ home = boardHome(), port = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT, secret } = {}) {
  // ADR.md entry 8: the daemon owns the pomodoro clock. Created here, once, and
  // threaded into createRequestHandler below rather than each side minting its own:
  // this is the ONE instance that owns the live setTimeout for this daemon, and the
  // pause/resume/reset/settings/ensure routes (src/server.mjs handlePomodoro) need to
  // re-arm the SAME timer boot() arms, not a second one racing it over the same file.
  // Boot-time reconciliation only (apply the expiry rule to whatever is on disk, arm
  // the next real boundary if a timer survives it) -- it never starts a fresh timer on
  // its own. Closed on 'close' rather than left to its own unref so a deliberate
  // restart against the same home (as the checks do) never runs two live clocks
  // against one file at once.
  //
  // `onBoundary` fires the native notification (src/notify.mjs, ADR.md entry 9). That
  // module is async and swallows every failure itself, so a reader's Notification
  // Center settings can never be a reason this callback misbehaves or the clock
  // stalls. Dropping this argument is the one edit that would leave the daemon
  // crossing every boundary in silence with the rest of the suite still green, which
  // is why test/check-notify.mjs pins it through startServer specifically.
  const pomodoro = createPomodoro({ home, onBoundary: ({ phase, settings }) => notifyBoundary(phase, settings) });

  // `secret` is passed through UNRESOLVED on purpose: defaulting it to readSecret() here
  // would pin the value for the life of the process and undo S4's fix one layer down,
  // where it would be much harder to notice. Absent means "read it per request".
  const server = http.createServer(createRequestHandler({ home, secret, pomodoro }));

  pomodoro.boot();
  server.on('close', () => pomodoro.close());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, home });
    });
  });
}
