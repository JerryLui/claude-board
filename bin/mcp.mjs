#!/usr/bin/env node
// stdio MCP shim, one per Claude Code session. Hand-rolled JSON-RPC 2.0 over
// newline-delimited JSON on stdin/stdout — zero dependencies, no MCP SDK.
// Exposes a single tool, `ask`: it posts a board to the shared daemon over HTTP,
// opens a tab on the thread's *first* board (and again on a later round only if
// no client is connected to it), and blocks on /api/board/:id/wait, emitting
// `notifications/progress` throughout so the MCP idle-abort timer never fires.
//
// The tab is opened on a one-time handoff, not on the board URL: reads are gated
// and this process is the only one holding the secret, so it is the
// only one that can hand the browser a credential. See `handoffUrl` below.
// See PROTOCOL.md "MCP surface" and "Detecting a session with no human in it".
//
// Two properties this file has to hold that are easy to lose:
//   * Every `ask` call is independent. Progress notifications, the wait and the
//     deadline are per call, never stored on the shared session — auto-backgrounding
//     means a second `ask` routinely runs while the first is still blocked, and a
//     call whose notifications get redirected dies to the MCP idle-abort timer.
//   * The daemon restarting is routine, not fatal. It restarts on a crash (KeepAlive),
//     on a kickstart, and on an ./install.sh run taking an update. The store is on disk
//     either way, so a wait that loses its socket
//     reattaches by board id instead of reporting a failure that strands answers.
//
// stdout carries protocol traffic ONLY. Every log line goes to stderr, or it
// corrupts the JSON-RPC stream.

import http from 'node:http';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSecret, secretPath, SECRET_HEADER } from '../src/secret.mjs';
import { HANDOFF_TOKEN_RE, recoveryCommand } from '../src/handoff.mjs';

// ---------------------------------------------------------------------------
// Configuration. CLAUDE_BOARD_HOME/CLAUDE_BOARD_PORT are PROTOCOL.md's; the
// rest are additive env vars this ticket introduces (documented in
// PROTOCOL.md "MCP surface"), never repurposing an existing name.
// ---------------------------------------------------------------------------

const PORT = Number(process.env.CLAUDE_BOARD_PORT) || 7391;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_TIMEOUT_MS) || 2 * 60 * 60 * 1000; // 2h default
const PROGRESS_MS = Number(process.env.CLAUDE_BOARD_PROGRESS_MS) || 20_000; // ~20s cadence
const POST_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_POST_TIMEOUT_MS) || 10_000;
const NO_OPEN = process.env.CLAUDE_BOARD_NO_OPEN === '1';
const OPEN_CMD = process.env.CLAUDE_BOARD_OPEN_CMD || 'open';
// Overrides process.platform for canOpenTab() below ONLY -- there is no second OS on
// this machine to exercise the non-darwin branch on for real. Checks only, never set
// by a user, same footing as CLAUDE_BOARD_NO_OPEN just below it.
const ASSUME_PLATFORM = process.env.CLAUDE_BOARD_ASSUME_PLATFORM || process.platform;
// Reattach backoff after the daemon drops a held-open wait (crash restart / kickstart /
// install). Starts short because a launchd restart is back in well under
// a second, then doubles up to RETRY_MAX_MS so a longer outage is not a hot loop.
const RETRY_MS = Number(process.env.CLAUDE_BOARD_RETRY_MS) || 250;
const RETRY_MAX_MS = Number(process.env.CLAUDE_BOARD_RETRY_MAX_MS) || 2_000;

// The local secret, read ONCE at startup (see src/secret.mjs). This is what the daemon
// uses to tell this session's shim from any other local process: without it every
// write is refused with 401, so `ask` says so and posts nothing rather than failing
// somewhere deeper with a message about the daemon being broken.
const SECRET = readSecret();

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

function logErr(...args) {
  console.error('[claude-board mcp]', ...args);
}

// ---------------------------------------------------------------------------
// Detecting a session with no human in it. PROTOCOL.md "Detecting a session
// with no human in it": an allowlist on CLAUDE_CODE_ENTRYPOINT that fails
// closed, plus the CLAUDE_BOARD_HEADLESS=1 override. Measured on Claude Code
// 2.1.220: `claude -p` exports sdk-cli, an interactive terminal exports cli.
// ---------------------------------------------------------------------------

const INTERACTIVE_ENTRYPOINTS = new Set(['cli', 'vscode', 'jetbrains', 'ide', 'claude-desktop', 'claude-desktop-3p']);

class ToolError extends Error {}

function assertInteractive() {
  if (process.env.CLAUDE_BOARD_HEADLESS === '1') {
    throw new ToolError(headlessRefusalMessage('CLAUDE_BOARD_HEADLESS=1 is set'));
  }
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (!entrypoint || !INTERACTIVE_ENTRYPOINTS.has(entrypoint)) {
    throw new ToolError(headlessRefusalMessage(
      `CLAUDE_CODE_ENTRYPOINT=${entrypoint ?? '(unset)'} is not one of ${[...INTERACTIVE_ENTRYPOINTS].join(', ')}`
    ));
  }
}

function headlessRefusalMessage(reason) {
  return (
    `ask refused: no human appears to be watching this session (${reason}). ` +
    `A board is never posted where no human is watching. Nothing was posted or written. ` +
    `If this is an unattended run (a scheduled routine, /nightly, /loop), it must not call ` +
    `ask — set CLAUDE_BOARD_HEADLESS=1 or avoid the board entirely.`
  );
}

// ---------------------------------------------------------------------------
// The third refusal trigger (the VPS case):
// CLAUDE_CODE_ENTRYPOINT=cli and a reachable daemon both look fine over SSH, but
// openBoardTab (below) silently no-ops on non-darwin with no CLAUDE_BOARD_OPEN_CMD
// configured -- there is simply no mechanism on that machine to put a tab in front
// of anyone. Left unrefused, that posts a board nobody can see and blocks the full
// wall-clock cap with nothing to report. Refusing it up front is the same shape as
// the headless refusal just above: loud, before anything is posted.
// ---------------------------------------------------------------------------

/** Whether this environment could possibly open a tab at all -- independent of
 * whether opening is administratively suppressed (NO_OPEN, used by assertCanOpenTab
 * and openBoardTab below). True on macOS, where the `open` command always exists, or
 * anywhere CLAUDE_BOARD_OPEN_CMD names an explicit opener; false otherwise. */
function canOpenTab() {
  return ASSUME_PLATFORM === 'darwin' || Boolean(process.env.CLAUDE_BOARD_OPEN_CMD);
}

/** Deliberately NOT triggered by CLAUDE_BOARD_NO_OPEN=1, and that relationship is the
 * whole design here, not an oversight: NO_OPEN is documented (PROTOCOL.md "MCP shim
 * environment") as "checks only; never set by a user" -- every check in this suite
 * sets it to stand in for a browser that would otherwise really open, i.e. it means
 * "opening is deliberately suppressed for this run," never "no way to open exists."
 * A real caller never sets it, so keying this refusal on NO_OPEN alone is safe: it
 * only ever actually fires in reality (a VPS with no CLAUDE_BOARD_OPEN_CMD configured),
 * and every check that drives the shim headless via NO_OPEN=1 keeps exercising the
 * normal post-and-wait path rather than tripping a refusal that exists for a
 * completely different machine shape. Getting this backwards either way breaks
 * something real: refusing through NO_OPEN=1 fails every check in this suite that
 * never touches a browser; ignoring NO_OPEN entirely would make opening-suppressed
 * checks indistinguishable from a genuinely tab-less VPS. */
function assertCanOpenTab() {
  if (NO_OPEN) return;
  if (canOpenTab()) return;
  throw new ToolError(
    `ask refused: this session cannot open a browser tab (platform is '${ASSUME_PLATFORM}' and ` +
    `CLAUDE_BOARD_OPEN_CMD is not set, so nothing on this machine can show a human the board). ` +
    `A board is never posted where no human can see it. Nothing was posted or written. ` +
    `If this is expected (an SSH session on a machine with no display), set ` +
    `CLAUDE_BOARD_HEADLESS=1 and use the terminal for this session instead of ask; ` +
    `otherwise set CLAUDE_BOARD_OPEN_CMD to a command that can put the URL in front of a human.`
  );
}

// ---------------------------------------------------------------------------
// HTTP client to the daemon. Plain node:http, not fetch/undici: undici's
// default headersTimeout/bodyTimeout (5 minutes) would kill the /wait call
// long before the 2h wall-clock cap. http.request has no such default.
// ---------------------------------------------------------------------------

function httpJson(method, urlStr, body, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        host: u.host,
        'content-type': 'application/json',
        // On every call, not just the writes: a route that starts requiring it later
        // must not silently start failing, and a header on a GET costs nothing.
        ...(SECRET ? { [SECRET_HEADER]: SECRET } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
      signal,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch (err) {
          return reject(new Error(`invalid JSON response from daemon: ${err.message}`));
        }
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(json.error || `daemon responded ${res.statusCode}`), { statusCode: res.statusCode }));
        }
        resolve(json);
      });
    });
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon request timed out')));
    }
    req.on('error', err => {
      if (err.name === 'AbortError') return; // caller-initiated abort, not a failure to report
      // Did the request actually go out? A socket that died before the body was flushed
      // wrote nothing; one that died after may have been fully applied by the daemon,
      // which is a difference the caller's error message has to respect rather than
      // guess at.
      reject(Object.assign(err, { requestSent: req.writableFinished === true }));
    });
    if (data) req.write(data);
    req.end();
  });
}

/** `sent` distinguishes the two cases that used to share one sentence. A connection
 * that never opened really did write nothing. A connection that died
 * AFTER the request body went out may have applied the whole round and lost only the
 * response — the daemon's work is synchronous once the body is read — so claiming
 * "nothing was posted or written" there is a false statement that makes the agent retry
 * into a duplicate round. The retry is safe anyway now, because `ask` carries a
 * requestId the daemon dedupes on, but the message still has to be true. */
function daemonUnreachableMessage(err, { sent = false } = {}) {
  return [
    `claude-board daemon is not reachable at ${BASE_URL} (${err.code || err.message}).`,
    sent
      ? `The request had already been sent, so the round may or may not have landed. Retrying this same call is safe: it carries an idempotency key and the daemon will not duplicate it.`
      : `Nothing was posted or written.`,
    `Revive it with: launchctl kickstart -k gui/$(id -u)/claude-board`,
    `If it was never installed on this machine, run ./install.sh from the claude-board repository first.`,
  ].join('\n');
}

/** The daemon answered, with a refusal. That is a caller-fixable problem (a bad
 * block kind, a board id that no longer exists, a malformed round) and NOT a dead
 * service, so this message deliberately carries no revive command: kickstarting a
 * healthy daemon fixes nothing and costs the reviewer the whole session. */
function daemonRejectedMessage(err, url) {
  return [
    `claude-board daemon rejected this board (HTTP ${err.statusCode}): ${err.message}`,
    `The daemon is running — this is a problem with what was posted. Fix the block(s) and call ask again; do not restart the daemon.`,
    ...(url ? [`Board: ${url}`] : []),
  ].join('\n');
}

/** No secret on this machine, or one the daemon does not recognise. Both are the same
 * fix — run the installer, which generates one if there isn't one and never rotates
 * one that already exists — and both mean nothing was posted or written. Deliberately
 * carries no revive command: the daemon is fine, the credential is not. */
function missingSecretMessage(reason) {
  return [
    `ask refused: ${reason}`,
    `The claude-board daemon only accepts writes from a caller holding the local secret at ${secretPath()} ` +
    `(it is what tells this session's shim from any other process on the machine). Nothing was posted or written.`,
    `Fix: run ./install.sh from the claude-board repository — it generates the secret if there isn't one, and ` +
    `never rotates an existing one — then restart this Claude Code session so the shim picks it up.`,
  ].join('\n');
}

/** Split the two failure modes `httpJson` can produce. A connection-level failure
 * carries err.code and no status; a daemon refusal carries err.statusCode and the
 * daemon's own message. Conflating them is what makes a typo in a block kind read
 * as "the service is down". */
function toolErrorFor(err, url) {
  if (err?.statusCode === 401) {
    return new ToolError(missingSecretMessage(
      SECRET
        ? 'the daemon rejected this session\'s local secret (HTTP 401).'
        : 'this machine has no claude-board local secret.'
    ));
  }
  if (typeof err?.statusCode === 'number' && err.statusCode >= 400) {
    return new ToolError(daemonRejectedMessage(err, url));
  }
  const msg = daemonUnreachableMessage(err, { sent: err?.requestSent === true });
  return new ToolError(url ? `${msg}\nBoard: ${url}` : msg);
}

// Socket-level failures that mean "the daemon went away", as opposed to "the daemon
// said no". A wait that hits one of these reattaches; anything else is terminal.
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE',
]);

function isTransportError(err) {
  if (!err) return false;
  if (typeof err.statusCode === 'number') return false; // the daemon answered; not a transport fault
  if (err.code && TRANSPORT_ERROR_CODES.has(err.code)) return true;
  return /socket hang up|ECONNRESET|ECONNREFUSED|aborted|timed out/i.test(String(err.message || ''));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Opening the tab. macOS `open <url>` on the thread's FIRST board, and on a
// later round ONLY when nothing is connected to that board any more:
// later rounds push over SSE
// into the live tab and must not steal focus, but "if no client is connected at
// all the daemon opens the tab again", otherwise a round pushed into a tab the
// reviewer closed blocks the call in silence for the full wall clock.
// ---------------------------------------------------------------------------

// Board ids are minted by the daemon (src/board.mjs) and only ever appear in a
// URL path segment here, so anything outside this alphabet is not a board id we
// should be building a URL from — never mind handing to `open`.
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The URL to open/report for `boardId`, rebuilt from THIS process's own base URL
 * rather than taken from the response body.
 *
 * The daemon's `url` field is peer-supplied data: during a restart window any local
 * process can bind the port first and answer `{"url":"/Applications/Evil.app"}`, and
 * `open` would launch it with no prompt (a leading `-` reaches `open`'s own flag
 * parser, too). There is no shell involved — spawn is argv-form, never `shell:true`
 * — but "no injection" is not "safe to launch". Returns null when the board id is
 * not a board id, and the caller then opens nothing. */
function safeBoardUrl(boardId) {
  if (typeof boardId !== 'string' || !BOARD_ID_RE.test(boardId)) return null;
  return `${BASE_URL}/b/${boardId}`;
}

/** The URL to open so the tab lands ALREADY AUTHORIZED: a single-use, seconds-lived
 * handoff the daemon mints on request and consumes on the first fetch, which then sets
 * the browser's session cookie and redirects to the clean board URL (src/handoff.mjs,
 * PROTOCOL.md "Authorizing a browser"). The shim is the right place to ask because it is
 * the only participant that holds the secret.
 *
 * Built from THIS process's base URL and a token that has to look like a token, never
 * from a URL in the response body — same reasoning as safeBoardUrl above, and it matters
 * more here, because this string is the one handed to `open`.
 *
 * Returns null rather than throwing when the mint fails, and says out loud what that
 * costs: opening the plain board URL still works for a browser that was authorized on
 * some earlier day (the cookie is long-lived and survives daemon restarts), and lands on
 * the refusal page for one that was not. Naming the recovery command here is the
 * difference between a reviewer who types one line and a reviewer who reads "this
 * browser is not authorized" in a tab and comes back to the session to ask why. */
async function handoffUrl(boardId) {
  let token;
  try {
    const minted = await httpJson('POST', `${BASE_URL}/api/handoff`, { boardId }, { timeoutMs: POST_TIMEOUT_MS });
    token = minted && minted.token;
  } catch (err) {
    logErr(
      `could not get a browser handoff from the daemon (${err.statusCode ? `HTTP ${err.statusCode}` : err.code || err.message}); ` +
      `opening the board URL directly. If the tab says this browser is not authorized, run: ${recoveryCommand()}`
    );
    return null;
  }
  if (typeof token !== 'string' || !HANDOFF_TOKEN_RE.test(token)) {
    logErr(
      `the daemon returned no usable handoff token; opening the board URL directly. ` +
      `If the tab says this browser is not authorized, run: ${recoveryCommand()}`
    );
    return null;
  }
  return `${BASE_URL}/auth/${token}`;
}

/** Open the tab on a fresh handoff, falling back to the board URL itself. Awaited by its
 * callers only for the mint — `open` is spawned detached either way, so nothing here
 * blocks on a browser. */
async function openAuthorizedTab(boardId, url) {
  if (NO_OPEN) return; // no HTTP either: a headless run must not mint credentials it will not use
  openBoardTab((await handoffUrl(boardId)) ?? url);
}

function openBoardTab(url) {
  if (NO_OPEN) return;
  if (!canOpenTab()) return;
  // Second gate, deliberately redundant with safeBoardUrl: every caller has to be
  // handing us a loopback http URL for this daemon, and nothing else ever reaches
  // an argv slot that a GUI launcher will act on.
  if (typeof url !== 'string' || !url.startsWith(`${BASE_URL}/`)) {
    logErr(`refusing to open ${JSON.stringify(url)}: not a ${BASE_URL} board URL`);
    return;
  }
  try {
    const child = spawn(OPEN_CMD, [url], { stdio: 'ignore', detached: true });
    child.on('error', err => logErr('failed to open board tab (non-fatal):', err.message));
    child.unref();
  } catch (err) {
    logErr('failed to open board tab (non-fatal):', err.message);
  }
}

/** How many clients are connected to `boardId` right now, or null when the daemon
 * does not report it — an older daemon, which reads as "unknown". We do not reopen on a
 * guess, because opening every round is exactly the focus-stealing behaviour rejected
 * here. Unknown is logged to stderr rather than swallowed.
 *
 * ONE source: the `clients` count on the POST response, which is free and race-free —
 * it is the count at the instant the round landed. There used to be a second, a
 * `GET /api/board/:id/clients` probe, and src/server.mjs has never routed it: it 404ed,
 * so this returned null every time and the reopen below has never once fired in
 * production, while test/check-mcp.mjs kept it green by standing the route up in a
 * proxy. Deleted rather than implemented on the daemon side too,
 * because the POST response already knows and a second source is a second thing to keep
 * true. */
function connectedClientCount(posted) {
  return typeof posted.clients === 'number' ? posted.clients : null;
}

/** Reopen the tab for a later round when the reviewer has no window on this board
 * open any more. Never called for the first board (that always opens). */
async function reopenIfNoClient(posted, url) {
  const clients = connectedClientCount(posted);
  if (clients === null) {
    logErr(
      `daemon does not report connected clients for board ${posted.boardId}; not reopening the tab. ` +
      `The board URL is in every progress notification and in the result: ${url}`
    );
    return false;
  }
  if (clients > 0) return false;
  logErr(`no client connected to board ${posted.boardId}; reopening the tab at ${url}`);
  await openAuthorizedTab(posted.boardId, url);
  return true;
}

// ---------------------------------------------------------------------------
// The blocking wait: a long-held GET to /api/board/:id/wait, raced against a
// wall-clock deadline. A steady setInterval sends progress notifications the
// whole time so the MCP idle-abort timer never fires; a submit arriving after
// the interval still resolves the underlying request normally, because we never
// impose our own idle timeout on it.
//
// The GET is re-issued, not abandoned, when the socket dies. A daemon restart is
// routine (a crash under KeepAlive, a kickstart from the revive command, an install
// taking an update) and tears every open connection down; the board is untouched on
// disk and still open, so the only correct move is to reattach by board id and
// round: "the shim reattaches by board id and the page
// reconnects over SSE". Reporting "daemon not reachable" there strands whatever the
// reviewer submits next. Only a daemon refusal (a status code — 404 board gone,
// most of all) or the wall clock is terminal.
// ---------------------------------------------------------------------------

const TIMED_OUT = Symbol('claude-board-wait-deadline');
const CANCELLED = Symbol('claude-board-wait-cancelled');

/** The client cancelled this request. Distinct from every other failure: there is
 * nothing to report, because MCP says a cancelled request gets no response at all. */
class CancelledError extends Error {}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = (m / 60).toFixed(1).replace(/\.0$/, '');
  return `${h}h`;
}

async function blockingWait({ boardId, round, timeoutMs, progressMs, onProgress, onReattach, cancelled }) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const url = `${BASE_URL}/api/board/${boardId}/wait?round=${round}`;
  let finished = false;
  let backoffMs = RETRY_MS;

  // One interval for the whole wait, spanning every reattach: the MCP idle-abort
  // timer does not care that our socket blipped, so neither may the cadence.
  const progressTimer = setInterval(() => {
    if (finished) return;
    onProgress(Date.now() - start);
  }, progressMs);

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { timedOut: true };

      const controller = new AbortController();
      let deadlineTimer;
      const deadlinePromise = new Promise(resolve => {
        deadlineTimer = setTimeout(() => resolve(TIMED_OUT), remaining);
      });
      // Never rejects: the outcome is inspected, so a losing race leaves no
      // unhandled rejection behind.
      const attempt = httpJson('GET', url, null, { signal: controller.signal })
        .then(packet => ({ packet }), err => ({ err }));

      let outcome;
      try {
        // Cancellation is a third way out, beside the packet and the wall clock:
        // the user pressed escape, so the GET, the interval and this loop all stop.
        outcome = await Promise.race([attempt, deadlinePromise, ...(cancelled ? [cancelled] : [])]);
      } finally {
        clearTimeout(deadlineTimer);
      }

      if (outcome === TIMED_OUT) {
        controller.abort();
        return { timedOut: true };
      }
      if (outcome === CANCELLED) {
        controller.abort();
        throw new CancelledError('the client cancelled this ask');
      }
      if (!outcome.err) return { timedOut: false, packet: outcome.packet };

      const err = outcome.err;
      if (!isTransportError(err)) throw err; // a refusal from the daemon itself: terminal
      if (Date.now() >= deadline) return { timedOut: true };

      logErr(
        `lost the daemon mid-wait (${err.code || err.message}); board ${boardId} round ${round} is still open on disk — ` +
        `reattaching in ${backoffMs}ms`
      );
      onReattach?.(err);
      const napped = await Promise.race([
        sleep(Math.max(0, Math.min(backoffMs, deadline - Date.now()))).then(() => null),
        ...(cancelled ? [cancelled] : []),
      ]);
      if (napped === CANCELLED) throw new CancelledError('the client cancelled this ask');
      backoffMs = Math.min(backoffMs * 2, RETRY_MAX_MS);
    }
  } finally {
    finished = true;
    clearInterval(progressTimer);
  }
}

// ---------------------------------------------------------------------------
// The `ask` tool itself.
// ---------------------------------------------------------------------------

const ASK_TOOL = {
  name: 'ask',
  description:
    'Post a board (questions plus artifact context) to the local claude-board daemon. ' +
    'Blocks until the reviewer submits when the round carries any question block; a round ' +
    'of content blocks only returns as soon as the post succeeds, nothing to wait for. Opens ' +
    'a browser tab on the first board of this session; later rounds push into the same tab. ' +
    'Returns a packet naming each question\'s status, choice and note, and every comment ' +
    'with its anchor.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Board / round title shown in the tab and history rail.' },
      blocks: {
        type: 'array',
        description:
          'Content and question blocks in display order. Questions carry their prompt by ' +
          'value; content blocks carry a source ref (or raw text/html for the html/mermaid kinds).',
        items: { type: 'object' },
      },
    },
    required: ['title', 'blocks'],
  },
};

function errorResult(message, extra = {}) {
  const packet = {
    board: extra.board ?? null,
    thread: extra.thread ?? null,
    title: extra.title ?? null,
    round: extra.round ?? null,
    status: 'error',
    answers: [],
    comments: [],
    url: extra.url ?? null,
  };
  // Same two channels as a successful result, plus isError. The message itself
  // lives in `content`, which is the part no client drops.
  return { content: [{ type: 'text', text: message }], isError: true, structuredContent: packet, ...packet };
}

/** One comment's anchor as a line of text: which block, and where inside it. */
function formatAnchor(anchor) {
  if (!anchor || !anchor.kind) return 'whole block';
  switch (anchor.kind) {
    case 'block': return 'whole block';
    // No `md` case: ADR.md entry 28 deleted that anchor kind along with the
    // affordance that minted it. An `md` anchor stored on an archived board is
    // rejected by src/board.mjs's sanitizeAnchor before it can reach a packet, and
    // one hand-edited into a board file falls through to the default below.
    case 'dom': return `dom:${anchor.ref}${anchor.hint ? ` ("${anchor.hint}")` : ''}`;
    // A diagram node's anchor carries a hint too (composeHint, the same
    // rule as every other element-level anchor) -- prefer it exactly like `dom`
    // above (src/render.mjs's anchorTag does the same), falling back to the bare
    // node id for an older anchor that has none.
    case 'mermaid': return `mermaid:${anchor.ref}${anchor.hint ? ` ("${anchor.hint}")` : ''}`;
    default: return `${anchor.kind}${anchor.ref ? `:${anchor.ref}` : ''}`;
  }
}

/** The text summary is the ONLY channel guaranteed to survive the MCP client: a
 * client is free to drop result keys it does not know, and everything this shim
 * returns beside `content`/`isError`/`structuredContent` is exactly that. So the
 * text has to be sufficient on its own — which means every comment's block, anchor
 * and words, not a count. `commands/grill.md` tells the agent to address comments as
 * their own input; "3 comment(s)." makes that impossible and does it silently. */
function summarizeAnswers(packet) {
  const lines = (packet.answers || []).map(a => {
    const choice = Array.isArray(a.choice) ? a.choice.join(', ') : (a.choice ?? '—');
    const note = a.note ? ` (note: ${a.note})` : '';
    return `  - ${a.id} [${a.status}] "${a.prompt}" -> ${choice}${note}`;
  });
  const comments = packet.comments || [];
  const commentBlock = comments.length
    ? [
      `${comments.length} comment(s) — each is feedback on the block it is anchored to, to address as its own input:`,
      ...comments.map(c => {
        const where = `${c.blockId}${c.blockKind ? ` (${c.blockKind})` : ''} @ ${formatAnchor(c.anchor)}`;
        const lost = c.resolved === false || c.lost ? ' [anchor no longer resolves]' : '';
        return `  - [${c.n}] ${where}${lost}: ${c.text}`;
      }),
    ].join('\n')
    : 'No comments.';
  return `${lines.join('\n')}\n${commentBlock}`;
}

/** Build a tool result carrying the packet on every channel that might survive.
 *
 * `structuredContent` is the MCP-defined home for machine-readable tool output, so
 * that is where the packet belongs; the flat copy is kept beside it because
 * PROTOCOL.md documents the packet's fields at the top level and something may
 * already read them there. Neither is load-bearing on its own: `text` above is
 * written to be sufficient by itself, because a client that keeps only `content` is
 * the case that silently loses the whole comment feature. */
function packetResult(text, packet) {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    structuredContent: packet,
    ...packet,
  };
}

/** Post this call's blocks, minting the thread's board on the first call and
 * pushing a round into it on every later one.
 *
 * Thread creation is guarded by an in-flight promise on `session`, because
 * `session.boardId == null` is read before an await and written after one: two
 * `ask` calls arriving in the same tick would otherwise both see null, both POST a
 * brand-new board and both open a tab, minting two threads for one shim. That
 * breaks "one thread per MCP shim process".
 * The promise is cleared in `finally`, so a failed first post leaves the session
 * clean for the next call to retry rather than wedging the thread forever. */
async function postThisRound(session, title, blocks) {
  if (session.creatingThread) {
    // Someone else is minting the thread. Wait it out — if it succeeded we push a
    // round into its board, if it failed we fall through and try to create it.
    try { await session.creatingThread; } catch { /* the creator reports its own failure */ }
  }

  if (session.boardId == null) {
    const creating = (async () => {
      const posted = await httpJson(
        'POST', `${BASE_URL}/api/board`,
        { title, blocks, cwd: process.cwd(), thread: session.thread ?? null },
        { timeoutMs: POST_TIMEOUT_MS }
      );
      session.boardId = posted.boardId;
      session.thread = posted.thread;
      return posted;
    })();
    // Assigned synchronously, before the first await below: a concurrent `ask`
    // entering here in the same tick sees it and waits instead of racing.
    session.creatingThread = creating;
    try {
      return { posted: await creating, isFirstBoard: true };
    } finally {
      session.creatingThread = null;
    }
  }

  // `title` goes on every round, not just the thread's first: `ask` requires a
  // non-empty one on every call and commands/grill.md tells the agent to make it the
  // branch name, and src/board.mjs now stores it per round for src/render.mjs to label
  // the round with. Dropping it here left every later round labelled "Round N".
  //
  // `requestId` is derived from what this round IS, not randomly: an agent retrying a
  // call whose response was lost re-sends the same blocks, so the same id, and the daemon
  // recognises it as the request it already applied instead of appending a second copy of
  // every question. A genuinely new round differs in its blocks and
  // so gets a different id. Scoped to the board so two boards cannot collide.
  const requestId = createHash('sha256')
    .update(JSON.stringify([session.boardId, title, blocks]))
    .digest('hex')
    .slice(0, 32);
  const posted = await httpJson(
    'POST', `${BASE_URL}/api/board`,
    { boardId: session.boardId, blocks, title, requestId },
    { timeoutMs: POST_TIMEOUT_MS }
  );
  return { posted, isFirstBoard: false };
}

/** Whether `blocks` — this call's raw, not-yet-normalized input — carries a question
 * anywhere in it: top-level, or nested inside a question's own `context` array or a
 * `compare` block's `left`/`right` side, the same three places src/board.mjs's own
 * traversals (`countersFromBoard`, `idLedgerFromBoard`, `findBlock`, `questionBlocks`)
 * walk on the normalized board — a block is minted in exactly the shape it arrives, so
 * checking the raw input finds the same set an already-posted board would.
 *
 * This is the entire "does this call have anything to wait for" decision:
 * a round with a question anywhere in it blocks until submit; a round with none returns
 * as soon as the post lands. One call, one shape — no mode flag, no separate
 * "no-questions" guard, just this. */
function hasQuestionBlock(blocks) {
  const found = b => {
    if (!b || typeof b !== 'object') return false;
    if (b.kind === 'question') return true;
    if (Array.isArray(b.context) && b.context.some(found)) return true;
    if (b.kind === 'compare' && (found(b.left && b.left.block) || found(b.right && b.right.block))) return true;
    return false;
  };
  return Array.isArray(blocks) && blocks.some(found);
}

/** `session` carries the in-memory, per-shim-process state a live thread needs:
 * the board id to push follow-up rounds into, and the in-flight thread-creation
 * guard. One shim == one Claude session == one thread. Everything belonging to a
 * single call — its progress sink above all — is an argument, never session state:
 * a second `ask` runs concurrently with the first by design, and storing the
 * progress sink on the session redirects call A's notifications to call B's token,
 * leaving A with nothing holding the MCP idle-abort timer off. */
async function askTool(args, session, { sendProgress, cancelled }) {
  assertInteractive(); // before anything is posted or written
  assertCanOpenTab(); // the third refusal trigger — see its own comment above
  // Refused here rather than discovered as a 401 three requests in: the daemon would
  // refuse the post anyway, and this way the message names the actual fix and no
  // request is made at all.
  if (!SECRET) throw new ToolError(missingSecretMessage('this machine has no claude-board local secret.'));

  const title = args && args.title;
  const blocks = args && args.blocks;
  if (typeof title !== 'string' || !title) throw new ToolError('ask requires a non-empty string "title"');
  if (!Array.isArray(blocks)) throw new ToolError('ask requires a "blocks" array');

  let posted;
  let isFirstBoard;
  try {
    ({ posted, isFirstBoard } = await postThisRound(session, title, blocks));
  } catch (err) {
    throw toolErrorFor(err, session.url);
  }

  // Built here, never taken from the response body (see safeBoardUrl).
  const url = safeBoardUrl(posted.boardId);
  if (!url) throw new ToolError(`daemon returned an unusable board id: ${JSON.stringify(posted.boardId)}`);
  session.url = url;

  if (isFirstBoard) await openAuthorizedTab(posted.boardId, url);
  else await reopenIfNoClient(posted, url);

  // A round with no question block anywhere in it has nothing a human
  // needs to submit, so there is nothing left to wait for — return the instant the
  // post lands. Opening the tab above stays best-effort either way: the shim spawns
  // the opener detached and never learns whether a tab actually appeared (see
  // openBoardTab), so "the tab opened" was never a state this could return on; "the
  // post succeeded" is. This is also why it is checked against the round just posted
  // rather than against `posted` (the daemon's response carries no block list back).
  if (!hasQuestionBlock(blocks)) {
    const text = `Board posted; no response needed (no question blocks in this round).\nBoard: ${url}`;
    return packetResult(text, {
      board: posted.boardId,
      thread: posted.thread,
      title,
      round: posted.round,
      status: 'posted',
      answers: [],
      comments: [],
      url,
    });
  }

  let waited;
  try {
    waited = await blockingWait({
      boardId: posted.boardId,
      round: posted.round,
      timeoutMs: TIMEOUT_MS,
      progressMs: PROGRESS_MS,
      onProgress: elapsedMs => sendProgress(elapsedMs, TIMEOUT_MS, url),
      cancelled,
    });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    throw toolErrorFor(err, url);
  }

  if (waited.timedOut) {
    const text =
      `No response within the ${formatDuration(TIMEOUT_MS)} wall-clock cap. Explicit no-response, ` +
      `not a hang. Board is still open at ${url} — reopen it or post a fresh round to continue.`;
    return packetResult(text, {
      board: posted.boardId,
      thread: posted.thread,
      title,
      round: posted.round,
      status: 'timeout',
      answers: [],
      comments: [],
      url,
    });
  }

  const packet = { ...waited.packet, url };

  if (packet.status === 'discuss') {
    const text =
      `Reviewer chose Discuss in chat. STOP posting further boards for the rest of this session — ` +
      `continue the conversation in chat using the partial answers below instead.\n` +
      `${summarizeAnswers(packet)}\nBoard: ${packet.url}`;
    return packetResult(text, packet);
  }

  // A `timeout` packet is the DAEMON's cap expiring, not the shim's, so `waited.
  // timedOut` above is false and this used to fall through to "Board submitted."
  // -- the agent was told the reviewer had answered when the answers were
  // all synthesised `unanswered` and the round is still open, so the reviewer's
  // later Send answers into nothing. Same wording as the shim-side cap, which is
  // the same event seen from the other side.
  if (packet.status === 'timeout') {
    const text =
      `No response before the daemon's wall-clock cap. Explicit no-response, not a hang. ` +
      `The round is still open at ${packet.url} — reopen it or post a fresh round to continue.\n` +
      `${summarizeAnswers(packet)}`;
    return packetResult(text, packet);
  }

  const text = `Board submitted.\n${summarizeAnswers(packet)}\nBoard: ${packet.url}`;
  return packetResult(text, packet);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over newline-delimited JSON on stdio.
// ---------------------------------------------------------------------------

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/** The board URL rides along in every progress message, not just the final result:
 * it is the fallback that cannot fail, and it has to reach the human *before* they
 * submit, not after. */
function sendProgressNotification(token, elapsedMs, totalMs, boardUrl) {
  write({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress: elapsedMs,
      total: totalMs,
      message: `waiting for reviewer… ${formatDuration(elapsedMs)} elapsed` + (boardUrl ? ` — board: ${boardUrl}` : ''),
    },
  });
}

// One thread per shim process: board id / thread id remembered across calls, so
// the second `ask` in a session pushes a round into the same board instead of
// opening a new one. Nothing call-scoped lives here (see askTool's comment).
const session = { boardId: null, thread: null, url: null, creatingThread: null };

/** In-flight `tools/call` requests by JSON-RPC id, so `notifications/cancelled`
 * has something to cancel. Without it a cancelled call leaks three things at once:
 * the progress interval keeps firing, the client-side wait stays outstanding, and
 * the daemon-side /wait poll loop runs forever on a board nobody is coming back to. */
const inFlightCalls = new Map();

function cancelCall(requestId, reason) {
  const cancel = inFlightCalls.get(requestId);
  if (!cancel) return false;
  logErr(`cancelling in-flight ask (request ${requestId})${reason ? `: ${reason}` : ''}`);
  cancel();
  return true;
}

async function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const progressToken = params && params._meta && params._meta.progressToken;

  if (name !== 'ask') {
    return respondError(id, -32602, `unknown tool: ${name}`);
  }

  // Built per call and passed down as an argument. Closing over THIS call's token
  // is the whole point: a later `ask` must not be able to steal this one's stream.
  const sendProgress = (elapsedMs, totalMs, boardUrl) =>
    sendProgressNotification(progressToken ?? id, elapsedMs, totalMs, boardUrl);

  let wasCancelled = false;
  const cancelled = new Promise(resolve => {
    inFlightCalls.set(id, () => { wasCancelled = true; resolve(CANCELLED); });
  });

  try {
    const result = await askTool(args, session, { sendProgress, cancelled });
    if (wasCancelled) return; // MCP: a cancelled request gets no response
    return respond(id, result);
  } catch (err) {
    if (err instanceof CancelledError || wasCancelled) {
      logErr(`ask (request ${id}) stopped: ${err && err.message || 'cancelled'}`);
      return; // deliberately silent: the client already moved on
    }
    const extra = { title: args && args.title, board: session.boardId, url: session.url };
    if (err instanceof ToolError) {
      return respond(id, errorResult(err.message, extra));
    }
    logErr('ask failed unexpectedly:', err && err.stack || err);
    return respond(id, errorResult(`ask failed unexpectedly: ${err && err.message || err}`, extra));
  } finally {
    inFlightCalls.delete(id);
  }
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-board', version: PKG_VERSION },
      });
    case 'notifications/initialized':
      return; // notification: no response
    case 'notifications/cancelled': {
      // The user pressed escape (or the client gave up). Stop the wait, the
      // progress interval and the daemon-side polling this call is driving —
      // ignoring this leaves all three running for up to the full 2h cap.
      const requestId = params && params.requestId;
      if (!cancelCall(requestId, params && params.reason)) {
        logErr(`cancellation for unknown or finished request ${requestId}; nothing to stop`);
      }
      return;
    }
    case 'ping':
      return respond(id, {});
    case 'tools/list':
      return respond(id, { tools: [ASK_TOOL] });
    case 'tools/call':
      return handleToolsCall(id, params);
    default:
      if (id !== undefined) return respondError(id, -32601, `method not found: ${method}`);
      return; // unknown notification: ignore
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logErr('invalid JSON-RPC line, ignoring:', err.message);
    return;
  }
  handleMessage(msg).catch(err => logErr('unhandled error handling message:', err && err.stack || err));
});

rl.on('close', () => process.exit(0));

logErr(`claude-board mcp shim ready (daemon at ${BASE_URL}, timeout ${formatDuration(TIMEOUT_MS)}, progress every ${formatDuration(PROGRESS_MS)})`);
