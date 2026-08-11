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

// CLAUDE_BOARD_HOME/CLAUDE_BOARD_PORT are PROTOCOL.md's; the rest are additive env
// vars documented in PROTOCOL.md "MCP surface", never repurposing an existing name.

const PORT = Number(process.env.CLAUDE_BOARD_PORT) || 7391;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_TIMEOUT_MS) || 40 * 60 * 1000; // 40m default (ADR.md entry 47)
// The shim outlives the daemon's own identical cap by this much, and only this much.
// Both read the same CLAUDE_BOARD_TIMEOUT_MS and default to the same 40m, but the
// shim's deadline is computed at blockingWait entry while the daemon's starts after
// connect and parse -- so without a margin the shim always fires first by the request
// latency, aborts, and the daemon sees a dead client and returns early: its whole
// timeout branch unreachable, no `awaitExpired` broadcast, no timeout packet, and the
// round never closed. The cap the reviewer and the agent are told about stays
// TIMEOUT_MS, the daemon's.
//
// Proportional rather than a flat five seconds, because the checks drive the cap down
// to a few hundred milliseconds and a fixed margin would be the entire runtime there.
// 5% of the cap, ceilinged at the 5s a 40 minute wait wants (invisible against it, and
// far longer than loopback latency) and floored at 250ms -- the floor is about the
// daemon's resolution, not latency: `waitForRound` (src/server.mjs) polls the store
// every 120ms, so a margin under that lets the shim win again on a short cap.
const WAIT_GRACE_MS = Math.min(5_000, Math.max(250, Math.round(TIMEOUT_MS * 0.05)));
const PROGRESS_MS = Number(process.env.CLAUDE_BOARD_PROGRESS_MS) || 20_000; // ~20s cadence
const POST_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_POST_TIMEOUT_MS) || 10_000;
// How long the THREAD-CREATING post itself may run, as opposed to how long this call
// waits for it (POST_TIMEOUT_MS above). Longer on purpose: that one post carries no board
// id, so a response lost after the body went out leaves a board this process cannot name,
// and the retry the failure message invites mints a second board, thread and tab. Letting
// the post outlive the call that made it is what turns that retry back into one board --
// see postThisRound. Bounded, not absent: a post nobody is waiting for still has to end.
const CREATE_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_CREATE_TIMEOUT_MS) || POST_TIMEOUT_MS * 3;
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

/** Whether this environment could possibly open a tab at all -- independent of
 * whether opening is administratively suppressed (NO_OPEN, used by assertCanOpenTab
 * and openBoardTab below). True on macOS, where the `open` command always exists, or
 * anywhere CLAUDE_BOARD_OPEN_CMD names an explicit opener; false otherwise. */
function canOpenTab() {
  return ASSUME_PLATFORM === 'darwin' || Boolean(process.env.CLAUDE_BOARD_OPEN_CMD);
}

/** The third refusal trigger, the VPS case: CLAUDE_CODE_ENTRYPOINT=cli and a reachable
 * daemon both look fine over SSH, but `openBoardTab` below silently no-ops on non-darwin
 * with no CLAUDE_BOARD_OPEN_CMD, so nothing on that machine can put a tab in front of
 * anyone. Unrefused, that posts a board nobody can see and blocks the full wall-clock cap
 * with nothing to report; refused here it is loud, before anything is posted, the same
 * shape as the headless refusal above.
 *
 * Deliberately NOT triggered by CLAUDE_BOARD_NO_OPEN=1, and that relationship is the
 * design rather than an oversight. NO_OPEN is documented (PROTOCOL.md "MCP shim
 * environment") as "checks only; never set by a user": it means "opening is deliberately
 * suppressed for this run", never "no way to open exists". Getting it backwards breaks
 * something real either way -- refusing through NO_OPEN=1 fails every check in this suite
 * that never touches a browser, while ignoring NO_OPEN entirely would make an
 * opening-suppressed check indistinguishable from a genuinely tab-less VPS. */
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
// long before the 40m wall-clock cap (TIMEOUT_MS above). http.request has no
// such default.
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

/** `sent` distinguishes two cases the message must not conflate. A connection that never
 * opened really did write nothing. A connection that died AFTER the request body went
 * out may have applied the whole round and lost only the response — the daemon's work is
 * synchronous once the body is read — so "nothing was posted or written" would be false
 * there. The retry itself is safe on a round pushed into an existing board (`ask` carries
 * a requestId the daemon dedupes on); the message still has to be true.
 *
 * A THREAD-CREATING post is the exception, and it used to be told the same story it
 * cannot keep: there is no board to scope a requestId to yet, so the daemon has no way to
 * recognise a repeat of it, and a retry mints a second board, thread and tab. The two
 * markers postThisRound puts on the error name which case this is — the post is still
 * running (retry, and it joins that post) or it is over unconfirmed (a retry is a second
 * board, so look before leaping). */
function daemonUnreachableMessage(err, { sent = false } = {}) {
  // A post this call gave up on but did not cancel: the connection is alive (a dead one
  // would have failed, not run late), so this is a slow daemon, not an absent one — and
  // the revive command every other branch ends with would kill the very post that is still
  // going. Nothing to revive, one thing to do.
  if (err && err.createStillInFlight) {
    return [
      `claude-board did not answer this board post in time (${err.code || err.message}).`,
      `The post had already gone out and is STILL RUNNING here. Call ask again with the same ` +
      `arguments: it waits that post out and pushes this round into whatever board it made. Do ` +
      `not pass fresh, and do not restart the daemon — either one turns this into a second board.`,
    ].join('\n');
  }
  return [
    `claude-board daemon is not reachable at ${BASE_URL} (${err.code || err.message}).`,
    !sent
      ? `Nothing was posted or written.`
      : err && err.createPost
        ? `The board post had already gone out, so a board may or may not have been created. A thread's first post carries no idempotency key the daemon could recognise it by, so calling ask again may well create a SECOND board and tab: check the board index (or the tab that may have opened) first.`
        : `The request had already been sent, so the round may or may not have landed. Retrying this same call is safe: it carries an idempotency key and the daemon will not duplicate it.`,
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

/** `promise`, with a deadline on THIS caller rather than on the work: when `ms` passes the
 * caller is rejected with `makeError()` and the promise is left running. That is the whole
 * difference from an aborting timeout, and the reason postThisRound uses it — a request
 * that may already have changed the daemon's state is worth more still running than
 * cancelled. Both settlement paths are handled, so a promise this call walked away from
 * never surfaces as an unhandled rejection. */
function withDeadline(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    timer.unref();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
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

/** The URL to open/report for `boardId`, rebuilt from THIS process's own base URL rather
 * than taken from the response body, which is peer-supplied data: during a restart
 * window any local process can bind the port first and answer
 * `{"url":"/Applications/Evil.app"}`, and `open` would launch it with no prompt (a
 * leading `-` reaches `open`'s own flag parser, too). There is no shell involved — spawn
 * is argv-form, never `shell:true` — but "no injection" is not "safe to launch". Returns
 * null when the board id is not a board id, and the caller then opens nothing. */
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

/** Open the tab on a fresh handoff, falling back to the board URL itself. Its one caller,
 * a thread's first board, awaits it only for the mint — `open` is spawned detached
 * either way, so nothing here blocks on a browser. */
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

const ASK_TOOL = {
  name: 'ask',
  description:
    'Post a board (questions plus artifact context) to the local claude-board daemon. ' +
    'Blocks until the reviewer submits when the round carries any question block, or when ' +
    'it is a page board (one html block) posted with wait: true; every other round returns ' +
    'as soon as the post succeeds, nothing to wait for. The default wait is 40 minutes. Opens ' +
    'a browser tab on the first board of this conversation; later rounds push into the same tab. ' +
    'Returns a packet naming each question\'s status, choice and note, and every comment ' +
    'with its anchor.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Board / round title shown in the tab and round pager.' },
      blocks: {
        type: 'array',
        description:
          'Content and question blocks in display order. Questions carry their prompt by ' +
          'value; content blocks carry a source ref (or raw text/html for the html/mermaid kinds).',
        items: { type: 'object' },
      },
      wait: {
        type: 'boolean',
        description:
          'Block on this round even though it carries no question, so the reviewer\'s comments ' +
          'on it come back in this same call\'s packet instead of riding a later round. Only has ' +
          'an effect when blocks is exactly one html block (a page board); default false. A ' +
          'question round blocks regardless of this flag. A real boolean, never a quoted string: ' +
          '"false" is refused, not obeyed.',
      },
      fresh: {
        type: 'boolean',
        description:
          'Declare that you have posted NO board in this conversation, so this call starts a ' +
          'new thread on a new board and opens its own tab, instead of pushing a round onto the ' +
          'board a previous conversation left behind. This process outlives /clear, so without ' +
          'it the first question after a /clear lands on the abandoned conversation\'s board, ' +
          'under that work\'s title, with no tab opening. After a /clear it is ALWAYS true: a ' +
          'cleared context holds no board. Pass it on the first ask of a conversation whenever ' +
          'you cannot see a board URL of your own in the conversation so far, and leave it off ' +
          'for every later round, or each round opens a board of its own. Harmless when there ' +
          'is no board yet — one board, one thread, one tab — and it closes any round still ' +
          'open on the board it walks away from. Default false. A real boolean, never a quoted ' +
          'string: "false" is refused, not obeyed.',
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
    // affordance that minted it. `sanitizeAnchor` (src/board.mjs) only runs at submit
    // time, so an `md` anchor already stored on an archived board still reaches a
    // packet -- it falls through to the default below and prints as `md:<ref>`.
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

/** The conversation boundary (ADR 69). The agent has declared that it has posted no board
 * in this conversation, so whatever board this process is still holding belongs to a
 * conversation that no longer exists: forget it, and let the next post mint a new thread
 * and open its tab.
 *
 * The clear happens FIRST and unconditionally, before the daemon is told anything. The
 * boundary is the agent's declaration, not the daemon's to ratify — a daemon that is
 * down, or that 404s a board someone pruned, must not be able to wedge this conversation
 * onto the previous one's board. So the abandon call is best-effort and its failure is a
 * stderr line: the worst it costs is a round left awaited on a board nobody is reading,
 * which is exactly the state this whole flag exists to avoid but strictly better than
 * posting into it.
 *
 * A no-op when there is no board yet, which is the ordinary case for the first `ask` of a
 * conversation that never had one: nothing is abandoned, and the post below mints one
 * board, one thread and one tab exactly as it would have without the flag.
 *
 * Only ever names THIS process's own board id, held in memory here and reachable from
 * nowhere else. That is what keeps two sessions in one project directory out of each
 * other's way: a second shim's board is a different id this one has never seen, and the
 * daemon route is scoped to the id it is given. */
async function declareBoundary(session) {
  const abandoned = session.boardId;
  session.boardId = null;
  session.thread = null;
  session.url = null;
  // The abandoned board's first-post key with it: it names a round on a board this
  // conversation has walked away from, and the next post mints its own.
  session.createRequestId = null;
  // Same gate as safeBoardUrl, and for the same reason: this string goes into a URL path
  // segment. A daemon that once answered with something that is not a board id gets no
  // second chance to have it sent back.
  if (typeof abandoned !== 'string' || !BOARD_ID_RE.test(abandoned)) return;
  try {
    await httpJson('POST', `${BASE_URL}/api/board/${abandoned}/abandon`, null, { timeoutMs: POST_TIMEOUT_MS });
  } catch (err) {
    logErr(
      `could not close the round(s) still open on board ${abandoned} ` +
      `(${err.statusCode ? `HTTP ${err.statusCode}` : err.code || err.message}); ` +
      `this conversation starts a new board regardless`
    );
  }
}

/** A post's idempotency key: 128 bits of a sha256 over the parts that decide what the
 * round IS, so two calls the daemon should treat as one retry hash alike and two calls it
 * must keep apart do not. Never random — a random key would make every retry a new round,
 * which is the failure it exists to stop. */
function requestIdFor(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** This call gave up on the thread-creating post; the post itself is still running. */
function createDeadlineError() {
  return Object.assign(
    new Error(`the daemon did not answer the board post within ${formatDuration(POST_TIMEOUT_MS)}`),
    // The body went out and the daemon is synchronous once it has read it, so "nothing was
    // posted or written" is exactly what this must not say.
    { code: 'ETIMEDOUT', requestSent: true }
  );
}

/** Post this call's blocks, minting the thread's board on the first call and
 * pushing a round into it on every later one.
 *
 * Thread creation is guarded by an in-flight promise on `session`, because
 * `session.boardId == null` is read before an await and written after one: two `ask`
 * calls arriving in the same tick would otherwise both see null, both POST a brand-new
 * board and both open a tab, breaking "one thread per conversation". The promise lives
 * exactly as long as the post does — not as long as the call that made it — so a call
 * that gave up waiting still leaves the next one something to join, and a post that has
 * genuinely failed leaves the session clean for the next call to retry rather than
 * wedging the thread forever. */
async function postThisRound(session, title, blocks, wait, fresh) {
  // What this call IS, as the daemon keys it: title, blocks, wait — no board id, because
  // the first post has none to be scoped by. Computed once, up front: both the join below
  // and the push at the end need it.
  const contentId = requestIdFor([title, blocks, Boolean(wait)]);

  // Re-read the guard after EVERY await, never once on the way in. `session.creatingThread`
  // is null-checked before an await and written after one, so a single read let a call
  // that yielded — waiting out someone else's mint, or declaring a boundary — fall through
  // into the create branch beside a concurrent call that had already started minting: two
  // boards, two threads, two tabs out of one conversation, the exact outcome the guard
  // exists to prevent.
  let boundaryDeclared = false;
  let joinedMint = false;
  for (;;) {
    if (session.creatingThread) {
      // Someone else is minting the thread. Wait it out — if it succeeded we push a
      // round into its board, if it failed we loop and (unless a third call has started
      // one meanwhile) create it.
      let joined = null;
      try { joined = await session.creatingThread; } catch { /* the creator reports its own failure */ }
      if (joined) {
        joinedMint = true;
        // ...unless that post IS this call: same title, same blocks, same wait means this
        // is the retry of it (the call that made it gave up before its answer arrived),
        // and the answer is already in hand. Return it rather than posting the round a
        // second time. Re-posting cannot be made safe from here: the daemon's dedupe is an
        // identity over the round's RESOLVED content (src/server.mjs, `roundContentDrifted`),
        // so a file this round references that was regenerated between the two — the
        // artifact loop the manual prescribes, and the whole reason that gate exists — is
        // a genuinely new round to the daemon, and the retry duplicates instead of joining.
        if (session.createRequestId === contentId) {
          // Never `isFirstBoard`: the tab belongs to the call that actually made this post.
          // ponytail: when that call gave up before its answer landed, nobody opens a tab
          // at all — the daemon's own stranded announcement (ADR 55) is what tells the
          // reviewer the board is there. The upgrade, if a silent board ever proves worse
          // than a duplicate one, is a session flag recording that a tab was opened.
          return { posted: joined, isFirstBoard: false };
        }
      }
      continue;
    }
    // After that wait and before the create-vs-push branch below: a boundary declared while
    // another call was mid-mint has to walk away from the board that call actually made,
    // not from the null it saw on the way in. Once per call, and the loop re-checks the
    // guard afterwards because the boundary's own await is a yield like any other.
    //
    // Never for a board THIS CALL just waited out, though. `fresh` says "this conversation
    // has posted no board", so it walks away from what a PREVIOUS conversation left behind
    // — and a board minted milliseconds ago by a concurrent `ask` on this same shim is not
    // that, it is this conversation. Abandoning it closed a live round under the call still
    // blocked on it and minted a second board for one conversation: the ordering (plain
    // ask first, fresh second) that the guard alone does not cover.
    if (fresh && !boundaryDeclared && !joinedMint) {
      boundaryDeclared = true;
      await declareBoundary(session);
      continue;
    }
    break;
  }

  if (session.boardId == null) {
    // A first post has no board id to scope a key to, so its key is the content alone —
    // and the session remembers it, because the daemon has now seen this round under THAT
    // key and under no other. The push below sends it back on a retry of this same call
    // (see there), which is what makes the daemon answer "already applied" instead of
    // amending a second copy of every block into the round it just minted.
    const createRequestId = requestIdFor([title, blocks, Boolean(wait)]);
    session.createRequestId = createRequestId;
    const creating = (async () => {
      const posted = await httpJson(
        'POST', `${BASE_URL}/api/board`,
        { title, blocks, wait: Boolean(wait), cwd: process.cwd(), thread: session.thread ?? null, requestId: createRequestId },
        { timeoutMs: CREATE_TIMEOUT_MS }
      );
      session.boardId = posted.boardId;
      session.thread = posted.thread;
      return posted;
    })();
    // Assigned synchronously, before the first await below: a concurrent `ask`
    // entering here in the same tick sees it and waits instead of racing. Cleared when the
    // post SETTLES, not when this call returns: a call that gave up on a post still running
    // is precisely the case the next call has to be able to join.
    session.creatingThread = creating;
    const clearGuard = () => { if (session.creatingThread === creating) session.creatingThread = null; };
    creating.then(clearGuard, clearGuard);
    try {
      // The deadline is on THIS call, not on the post (see withDeadline). A thread's first
      // post carries no board id, so there is nothing for a requestId to be scoped to and
      // the daemon cannot recognise a repeat of it: a response lost here would leave a
      // board this process cannot name, and the retry the error message invites would mint
      // a second board, thread and tab while the first sat orphaned on a live awaited
      // round. Leaving the post running instead means the retry finds it on the guard
      // above, waits it out, and pushes its round into the board it actually made.
      return { posted: await withDeadline(creating, POST_TIMEOUT_MS, createDeadlineError), isFirstBoard: true };
    } catch (err) {
      // Which of the two unconfirmed cases this is, for the message to tell the truth.
      if (err && typeof err === 'object') {
        err.createPost = true;
        if (session.creatingThread === creating) err.createStillInFlight = true;
      }
      throw err;
    }
  }

  // `title` goes on every round, not just the thread's first: `ask` requires a
  // non-empty one on every call and commands/grill.md tells the agent to make it the
  // branch name, and src/board.mjs stores it per round for src/render.mjs to label the
  // round with. Dropped here, every later round reads "Round N".
  //
  // `requestId` is derived from what this round IS, not randomly: an agent retrying a
  // call whose response was lost re-sends the same blocks, so the same id, and the daemon
  // recognises it as the request it already applied instead of appending a second copy of
  // every question. A genuinely new round differs in its blocks and so gets a different
  // id. Scoped to the board so two boards cannot collide. `wait` is folded in too,
  // because it changes what round.awaited ends up as (src/board.mjs `mintAwait`): a call
  // that only flips `wait` between two otherwise-identical posts is a different request,
  // not a retry.
  //
  // Except when this call is the RETRY of the post that created this board — same title,
  // same blocks, same wait — which the daemon only ever saw under the content-only key
  // above. Board-scoping it there would hand the daemon a key it has never seen, and the
  // "safe to retry" the failure message promises would append the whole round again. (A
  // retry that arrives while that post is still running never reaches here at all: the
  // join above hands back its answer instead. This covers the one that arrives after.)
  const requestId = session.createRequestId === contentId
    ? contentId
    : requestIdFor([session.boardId, title, blocks, Boolean(wait)]);
  let posted;
  try {
    posted = await httpJson(
      'POST', `${BASE_URL}/api/board`,
      { boardId: session.boardId, blocks, title, wait: Boolean(wait), requestId },
      { timeoutMs: POST_TIMEOUT_MS }
    );
  } catch (err) {
    // The board this session has been pushing rounds into is GONE: pruned from the
    // index's settings panel while the session kept running (ADR 71). 404 is the only
    // way the daemon says that, and a session is not punished for it -- forget the dead
    // id and let the same call mint a fresh board, tab and all, rather than failing a
    // question the agent genuinely asked. `session.thread` is deliberately kept: if the
    // thread has surviving boards the fresh one rejoins them in the index, and if it
    // has none the id costs nothing.
    //
    // Re-entrant exactly once: `boardId` is null on the way back in, so the call takes
    // the create branch above, and nothing on that branch can 404.
    if (err && err.statusCode === 404) {
      session.boardId = null;
      return postThisRound(session, title, blocks, wait);
    }
    throw err;
  }
  return { posted, isFirstBoard: false };
}

/** Whether `blocks` — this call's raw, not-yet-normalized input — carries a question
 * anywhere in it: top-level, or nested inside a question's own `context` array or a
 * `compare` block's `left`/`right` side, the same three places src/board.mjs's own
 * traversals (`countersFromBoard`, `idLedgerFromBoard`, `findBlock`, `questionBlocks`)
 * walk on the normalized board. A block is minted in exactly the shape it arrives, so
 * checking the raw input finds the same set an already-posted board would. A round
 * carrying a question always blocks (CONTEXT.md "Awaited"); `wait` below is the second,
 * declared route in. */
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

/** Whether raw `blocks` is shaped like a page board — one `html` block and nothing
 * else (ADR.md entry 33, src/badge.mjs `isPageRound`) — checked here against the RAW,
 * pre-resolution input the same way `hasQuestionBlock` is: this call cannot yet know
 * whether an `html` block's `source` will fail to resolve (that only happens
 * server-side, in src/board.mjs `normalizeBlock`), so this is deliberately a looser
 * check than the authoritative one `mintAwait` runs against the normalized board. The
 * gap only matters when a `source` ref is broken AND `wait: true` was passed on it: the
 * shim still blocks (this returns true), the daemon still marks the round not-awaited
 * (its `html` block carries `error`), and the call rides out to the 40-minute timeout
 * rather than either side silently disagreeing about which comments are ever read. */
function isPageRoundShape(blocks) {
  return Array.isArray(blocks) && blocks.length === 1 && blocks[0] && typeof blocks[0] === 'object' && blocks[0].kind === 'html';
}

/** Whether THIS call has anything to wait for — the entire "does `ask` block" decision.
 * Two routes in, matching CONTEXT.md's "Awaited" glossary entry exactly: a round
 * carrying a question always does, and a page board (one `html` block, nothing else)
 * does when the caller declared `wait: true` (ADR.md entry 45). Every other shape —
 * content-only, more than one block, no question — returns as soon as the post lands,
 * `wait: true` or not: the glossary names only these two routes in, and this does not
 * invent a third. */
function isAwaited(blocks, wait) {
  return hasQuestionBlock(blocks) || (Boolean(wait) && isPageRoundShape(blocks));
}

/** A schema-declared boolean flag, read as the decision it is rather than for truthiness.
 * `wait` and `fresh` are `type: 'boolean'` in the tool schema, but nothing enforces a
 * caller's types, and a model that emits the STRING `'false'` reads as TRUE to a bare
 * `if (fresh)`: `ask` would then abandon every round still open on the live board — a
 * reviewer's question closed under them, on the one input where being wrong destroys work
 * someone is looking at — and, on `wait`, block a content-only round for the full cap.
 * Absent stays absent (both default false); anything that is not a boolean is refused by
 * name, the same way a missing title is, rather than guessed at. */
function boolArg(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new ToolError(
      `ask requires "${name}" to be a boolean (true or false), not ${JSON.stringify(value)}. ` +
      `A string is not a boolean — "false" would have read as true. Nothing was posted, written or abandoned; ` +
      `call ask again with a real boolean.`
    );
  }
  return value;
}

/** `session` carries the in-memory, per-shim-process state a live thread needs: the
 * board id to push follow-up rounds into, and the in-flight thread-creation guard. One
 * shim == one conversation == one thread, and `fresh` (ADR 69) is what moves it on to the
 * next conversation, since the process survives every one of them. Everything belonging to a single call — its
 * progress sink above all — is an argument, never session state: a second `ask` runs
 * concurrently with the first by design, and a session-stored progress sink redirects
 * call A's notifications to call B's token, leaving A with nothing holding the MCP
 * idle-abort timer off. */
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
  // Read as decisions, never as truthiness — see boolArg. Refused here, before anything is
  // posted, abandoned or written.
  const wait = boolArg(args && args.wait, 'wait');
  const fresh = boolArg(args && args.fresh, 'fresh');

  let posted;
  let isFirstBoard;
  try {
    ({ posted, isFirstBoard } = await postThisRound(session, title, blocks, wait, fresh));
  } catch (err) {
    throw toolErrorFor(err, session.url);
  }

  // Built here, never taken from the response body (see safeBoardUrl).
  const url = safeBoardUrl(posted.boardId);
  if (!url) throw new ToolError(`daemon returned an unusable board id: ${JSON.stringify(posted.boardId)}`);
  session.url = url;

  // The daemon announces a stranded round on its own now (ADR 55); this shim only
  // ever opens a tab for a thread's first board.
  if (isFirstBoard) await openAuthorizedTab(posted.boardId, url);

  // A round with nothing awaited on it (see `isAwaited` above) has nothing a human
  // needs to submit, so there is nothing left to wait for — return the instant the
  // post lands. Opening the tab above stays best-effort either way: the shim spawns
  // the opener detached and never learns whether a tab actually appeared (see
  // openBoardTab), so "the tab opened" was never a state this could return on; "the
  // post succeeded" is.
  //
  // The daemon's own verdict wins when it gives one. `isAwaited` reads the RAW blocks
  // and cannot know whether an `html` block's `source` resolved, so on a page board with
  // a broken reference the two sides disagree: the daemon mints the round not-awaited
  // (its block carries `error`) and never builds a packet, while this side would block
  // out the full cap on a round nothing will ever answer. `awaited` on the post response
  // is that same `mintAwait` result. Optional by design: a daemon from before the field
  // existed returns `undefined`, and the local shape check decides exactly as it did.
  if (posted.awaited === false || !isAwaited(blocks, wait)) {
    const text = `Board posted; no response needed (nothing awaited in this round).\nBoard: ${url}`;
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
      timeoutMs: TIMEOUT_MS + WAIT_GRACE_MS,
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

  // A `timeout` packet is the DAEMON's cap expiring, not the shim's, so `waited.timedOut`
  // above is false and this needs its own branch: falling through to "Board submitted."
  // tells the agent the reviewer answered when every answer is a synthesised
  // `unanswered` and the round is still open. Same wording as the shim-side cap, which
  // is the same event seen from the other side.
  if (packet.status === 'timeout') {
    const text =
      `No response before the daemon's wall-clock cap. Explicit no-response, not a hang. ` +
      `The round is still open at ${packet.url} — reopen it or post a fresh round to continue.\n` +
      `${summarizeAnswers(packet)}`;
    return packetResult(text, packet);
  }

  // The board was closed under this call: the conversation that owned it declared itself
  // over (ADR 69's boundary, or a direct abandon), and the daemon answers the blocked wait
  // at once instead of leaving it on a round nothing will ever answer. Its own branch,
  // because every other ending is a lie here — falling through to "Board submitted." below
  // reads a round of synthesised `unanswered` back as the reviewer's decisions, and the
  // timeout wording above would send the agent to reopen a board that is closed for good.
  // What survives is the comments: one left before the session walked away is owed to this
  // packet like any other, so they are summarised, not dropped.
  if (packet.status === 'abandoned') {
    const text =
      `Board abandoned: this round was closed before anyone answered it, because the conversation ` +
      `that owned the board declared itself over — a later ask started a new board, or the board ` +
      `was abandoned directly. No response is coming, and nothing below is a decision the reviewer ` +
      `made: this is neither an answer nor the wall-clock cap. Any comments below were left before ` +
      `it closed and still count. Post to the current board if the question still stands.\n` +
      `${summarizeAnswers(packet)}\nBoard: ${packet.url}`;
    return packetResult(text, packet);
  }

  if (packet.status === 'submitted') {
    const text = `Board submitted.\n${summarizeAnswers(packet)}\nBoard: ${packet.url}`;
    return packetResult(text, packet);
  }

  // Every ending this shim knows is branched above, so this is one it does not: a daemon
  // newer than the shim talking to it, most likely (`abandoned` arrived exactly that way).
  // It gets named, not dressed as a submit. "Board submitted." used to be the fall-through
  // for anything unrecognised, which is how a round of synthesised `unanswered` gets read
  // back as the reviewer's decisions — the one failure this whole surface exists to
  // prevent, and the fall-through would have made it again for the next status added.
  const text =
    `The wait ended with a status this shim has no branch for: ${JSON.stringify(packet.status)}. ` +
    `Nothing below is a decision anyone can vouch for — do not read the answers as the reviewer's, ` +
    `say plainly that the outcome is unrecognised, and open the board yourself. If the daemon is ` +
    `newer than this shim, ./install.sh from the claude-board repository updates both.\n` +
    `${summarizeAnswers(packet)}\nBoard: ${packet.url}`;
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

// One thread per CONVERSATION, not per shim process (ADR.md entry 69): board id /
// thread id remembered across calls, so the second `ask` in a conversation pushes a round
// into the same board instead of opening a new one — until `fresh` says the conversation
// that minted it is gone, which clears both and starts the next one over. This process
// outlives `/clear`, so the flag is the only thing that can tell those two apart.
// Nothing call-scoped lives here (see askTool's comment).
const session = { boardId: null, thread: null, url: null, creatingThread: null, createRequestId: null };

/** In-flight `tools/call` requests by JSON-RPC id, so `notifications/cancelled` has
 * something to cancel. Without it a cancelled call leaks three things: the progress
 * interval, the client-side wait, and the daemon-side /wait poll loop, which then runs
 * on a board nobody is coming back to. */
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
      // ignoring this leaves all three running for up to the full TIMEOUT_MS cap.
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
