// The node:http daemon: routes, the loopback Host check, a polling wait on
// /api/board/:id/wait, and the SSE push on /api/board/:id/events. See
// PROTOCOL.md "HTTP surface" and "SSE events".
//
// Four gates, in this order:
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
// came up, and it reveals only a version string and an opaque daemon identity — see
// DAEMON_ID) and `GET /auth/<token>`, which is the route that HANDS OUT the credential
// and so cannot require it.
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
// This overturned "read routes stay open", and deleted the
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
// pushes again with nothing missed in between (KeepAlive restarts the daemon on a
// crash; ./install.sh restarts it to take an update).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readBoard, writeBoard, writePage, readAsset, boardHome, listBoards, storeFingerprint, searchBoards, pruneStore } from './store.mjs';
import { ASSET_NAME, SHARED_ASSETS, assetContentType } from './assets.mjs';
import { readSecret, secretPath, secretMatches, sessionToken, sessionCookieMatches, SECRET_HEADER, SESSION_COOKIE, SESSION_MAX_AGE_S } from './secret.mjs';
import { createHandoffStore, handoffTarget, recoveryCommand, HANDOFF_TOKEN_RE, DEFAULT_PORT } from './handoff.mjs';
import { createBoard, addRound, amendRound, abandonOpenRounds, applySubmit, buildPacket, resolveComments, questionBlocks, stripDaemonOnly, roundContentDrifted } from './board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, renderRefusalPage, CSP, INDEX_CSP } from './render.mjs';
import { buildThreadIndex, renderIndexPage, renderThreadRows, folderName } from './indexpage.mjs';
// The one shape rule for "is this round a full-viewport page" (ADR.md entry 33),
// imported rather than restated so the push path and the page path can never
// disagree about what a page round is -- see buildRoundPushPayload below.
import { isPageRound, roundIsAwaited, roundIsAwaitedOpen, roundWaitLapsed, closeLapsedAwaitedRounds, waitingRounds } from './badge.mjs';
import { createPomodoro, readDoc as readPomodoroDoc } from './pomodoro.mjs';
import { notifyBoundary, notifyTest } from './notify.mjs';
import { isCue, cuePath } from './cues.mjs';
import { resolveRefRoots } from './resolve.mjs';
import { createStrandedWatch } from './stranded.mjs';

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

/** How long a board stays Attended after its tab last had FOCUS (CONTEXT.md "Attended";
 * ADR.md entry 73). Two minutes, because the posture this product is built for is a board
 * tab sitting behind the terminal: read as a live boolean, that tab counts as nobody
 * watching and its board strands within seconds of every glance away, roughly once a
 * minute all day. The window is what makes an open tab mean "the reviewer is around".
 *
 * A tab that is focused RIGHT NOW is Attended for as long as it stays focused, with no
 * clock on it at all -- idle detection was considered and refused, so nothing here reads
 * the reviewer's keyboard to decide whether they are present. The window only ever bounds
 * how long a tab that has LOST focus keeps counting.
 *
 * An environment variable rather than a settings row, exactly like the stranded grace
 * below and for the same two reasons: it is a characteristic of the machine, not a
 * preference, and a check has to be able to drive the rule without sleeping two real
 * minutes. Zero, negative, empty and unparseable all fall back to the default, so that
 * blanking it (the ordinary way an operator turns a knob off) cannot silently reinstate
 * the bug this exists to fix. */
export const DEFAULT_ATTENDED_WINDOW_MS = 120_000;

function attendedWindowMs() {
  const v = Number(process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ATTENDED_WINDOW_MS;
}

/** SSE subscriber registry, keyed by board id, one entry per Watcher (CONTEXT.md).
 *
 * Keyed by a server-minted `watcherId` rather than by `res` alone, so an `attended`
 * report can name which Watcher it is updating without the daemon ever trusting an
 * identifier the tab chose for itself; `handleEvents` below sends that id as the
 * stream's first event. Entries live exactly as long as the subscription does, which
 * is what makes "a tab that goes away stops counting" true with no timeout of its own.
 *
 * Exported for the checks: `res` is never inspected here, only held and later
 * `.write()`n, so a stand-in carrying a `write` method (or none) is enough. */
export function createSseHub() {
  const subs = new Map(); // boardId -> Map<watcherId, { res, attended, seq, focusedAt }>

  /** Is this Watcher inside its look-away window -- did it have focus recently enough
   * that the board still counts as Attended (ADR.md entry 73)? `focusedAt` is the last
   * instant this tab is known to have had focus, so a tab that has never reported focus
   * at all (0) is never inside a window, however long it has been connected. */
  function withinLookAway(watcher) {
    return watcher.focusedAt > 0 && Date.now() - watcher.focusedAt < attendedWindowMs();
  }

  /** How much longer this board counts as Attended. See the `attendedRemainingMs` entry
   * on the returned object for what the three answers mean. A plain function rather than
   * a `this.` call between two methods, so a caller that pulls one method off the hub does
   * not get a broken one. */
  function remainingMs(boardId) {
    const board = subs.get(boardId);
    if (!board) return 0;
    let best = 0;
    for (const watcher of board.values()) {
      if (watcher.attended === true) return Infinity;
      if (watcher.focusedAt > 0) best = Math.max(best, attendedWindowMs() - (Date.now() - watcher.focusedAt));
    }
    return Math.max(0, best);
  }

  return {
    subscribe(boardId, res) {
      let board = subs.get(boardId);
      if (!board) { board = new Map(); subs.set(boardId, board); }
      const watcherId = randomBytes(16).toString('hex');
      // A freshly opened stream is Attended-UNKNOWN (`null`), not Attended-true. The
      // page corrects it within one round trip -- src/ui.mjs's `watcher` event handler
      // reports the tab's real state the moment it learns this id -- so the unknown
      // state lasts milliseconds, but it is a distinct state and the difference is
      // load-bearing twice over. It is not evidence the reviewer is there, so it can
      // neither end an absence nor hold a banner back (`isConfirmedAttended` below is
      // what the stranded rule asks); and it is not evidence they are gone either, so
      // `isAttended` still counts it for anything merely asking whether a tab is open.
      board.set(watcherId, { res, attended: null, seq: -1, focusedAt: 0 });
      return watcherId;
    },
    unsubscribe(boardId, watcherId) {
      const board = subs.get(boardId);
      if (!board) return;
      board.delete(watcherId);
      if (board.size === 0) subs.delete(boardId);
    },
    broadcast(boardId, eventName, data) {
      const board = subs.get(boardId);
      if (!board || board.size === 0) return;
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const { res } of board.values()) {
        try { res.write(payload); } catch { /* dead connection; the 'close' handler cleans it up */ }
      }
    },
    /** How many browsers currently have this board open, reported on the POST response.
     * Nothing in bin/ reads it: the shim opens a tab for a thread's FIRST board only,
     * and the daemon announces a stranded round itself (ADR.md entry 55). */
    clientCount(boardId) {
      const board = subs.get(boardId);
      return board ? board.size : 0;
    },
    /** Record whether one Watcher's tab is Attended; returns whether the report was
     * APPLIED, which is what `handleAttended` gates the stranded rule on. A report
     * naming a `watcherId` this board has no live subscription for -- a reconnect race,
     * or a report whose tab had already closed -- is dropped silently: the tab has no
     * way to know that timing from its own side, so refusing it would only teach the
     * page to retry forever.
     *
     * `seq` is the page's own monotonic counter for the edge it is reporting, and it is
     * what keeps two reports in flight at once from landing in the wrong order: a focus
     * and a blur ~100ms apart are two POSTs on two connections, so the network decides
     * which arrives first. Applied in arrival order they can leave a Watcher marked
     * attended with the reviewer gone -- `isConfirmedAttended` then true forever, every
     * evaluate resolving to `returned`, no grace ever armed and no banner for the rest
     * of that wait, with no further DOM edge coming to correct it -- or, reversed, fire
     * a banner at a reviewer who is looking at the board. A report carrying no `seq` is
     * applied and leaves the counter alone: degrade, do not refuse. */
    setAttended(boardId, watcherId, attended, seq = null, sinceFocusMs = null) {
      const board = subs.get(boardId);
      const watcher = board && board.get(watcherId);
      if (!watcher) return false;
      if (Number.isInteger(seq)) {
        if (seq <= watcher.seq) return false; // an older edge, overtaken in flight
        watcher.seq = seq;
      }
      // The last instant this tab is known to have had focus, which is what the two-minute
      // look-away window counts from (ADR.md entry 73). Stamped when a report SAYS the tab
      // is focused, and equally when a report says it has just STOPPED being focused --
      // the tab had focus right up to this instant, so a blur starts the window here, not
      // back when focus was gained. Without the second half, a tab focused for ten minutes
      // and then buried would be treated as last-focused ten minutes ago and strand at once.
      if (watcher.attended === true || attended) watcher.focusedAt = Date.now();
      // A RECONNECT is the case this Watcher cannot observe for itself: it was minted
      // seconds ago by a fresh `/events` stream, so a buried tab's first report through it
      // is `false` against a `focusedAt` of zero and the window reads as spent. The page
      // carries how long ago IT last had focus (`sinceFocusMs`, src/ui.mjs) and that seeds
      // the stamp -- but only when this Watcher has no observation of its own, so a report
      // can never EXTEND a window the daemon is already tracking, and never invent one for
      // a tab that has not said it had focus at all.
      //
      // It is the page's own claim, like `attended` beside it, and the same write
      // credential reaches both. Not merely a weaker `attended: true`, though, and the
      // difference is worth naming: a seeded window holds a banner back WITHOUT opening the
      // return gate, where `attended: true` opens it -- a quieter state rather than a lesser
      // one. Both buy silence; neither buys a second banner for a round already announced,
      // which is the mark's business. A value old enough to be already spent lands as an
      // expired window, not an error.
      else if (!watcher.focusedAt && Number.isInteger(sinceFocusMs) && sinceFocusMs >= 0) {
        watcher.focusedAt = Date.now() - sinceFocusMs;
      }
      watcher.attended = !!attended;
      return true;
    },
    /** CONTEXT.md "Attended", OR-across-Watchers: true unless every Watcher of this
     * board has REPORTED itself hidden or unfocused AND is past its look-away window.
     * Three clauses the branches turn on, because none survives the summary above: a
     * board with no Watchers at all is NOT Attended (`if (!board) return false`, rather
     * than the vacuous "every one of zero Watchers has reported hidden"), a Watcher that
     * has not reported yet counts as looking (`attended !== false`, not `=== true`) --
     * which is the entire reason `isConfirmedAttended` below exists -- and one that
     * reported itself hidden within the last two minutes still counts (ADR.md entry 73).
     * No production reader -- kept for test/check-attended.mjs, which pins this rule
     * directly since nothing over HTTP surfaces it. Nor has `isConfirmedAttended` below
     * one any more: since ADR.md entry 73 the only accessor production reads is
     * `attendedRemainingMs`, because the stranded rule needs to know WHEN a board stops
     * being attended, not just whether it is. Both booleans are test-only now, and
     * saying so here is not bookkeeping: a stand-in that had drifted from this hub is
     * what hid a defect that made a stranded board silent forever. */
    isAttended(boardId) {
      const board = subs.get(boardId);
      if (!board) return false;
      for (const watcher of board.values()) if (watcher.attended !== false || withinLookAway(watcher)) return true;
      return false;
    },
    /** The stricter question, and the one a caller deciding whether the reviewer has
     * COME BACK has to ask: has any Watcher actually SAID it is looking, now or recently
     * enough to still be inside its look-away window? A freshly subscribed one has not,
     * so this is false through the reconnect and true again a round trip later if the tab
     * really is in front of the reviewer -- which is what keeps a hidden tab's reconnect
     * (a dropped socket, a laptop wake, a daemon restart) from reading as the reviewer
     * returning (PROTOCOL.md, `POST /api/board/:id/attended`: "unknown, not attended").
     *
     * The window (ADR.md entry 73) is why a tab buried behind the terminal -- the ordinary
     * working posture -- does not strand its board the moment focus moves: it goes on
     * answering true for two minutes after that tab last had focus. A tab that IS focused
     * answers true with no clock involved at all, however long it sits there.
     *
     * Test-only, like `isAttended` above: the rule this was written for now asks
     * `attendedRemainingMs` instead, needing the moment the window ends and not just
     * whether it is still running. See `createStrandedWatch.evaluate` (src/stranded.mjs). */
    isConfirmedAttended(boardId) {
      return remainingMs(boardId) > 0;
    },
    /** The same question with its answer in milliseconds, which is what the stranded rule
     * needs to know WHEN to ask again (ADR.md entry 73).
     *
     * `Infinity` means a tab is focused right now -- the reviewer is here, and no clock is
     * running on them. A finite number is how much of the look-away window is left on the
     * tab that last had focus; `0` is a board nobody is watching.
     *
     * Without this the window would be a mute button rather than a delay: the rule fires
     * on events, and no event fires when a window expires, so a board whose only tab was
     * buried and then left alone would go from "attended for two minutes" to "attended
     * forever". `createStrandedWatch.evaluate` arms its countdown past the remaining
     * window for exactly that reason. */
    attendedRemainingMs: remainingMs,
  };
}

/** SSE subscriber registry for the daemon-wide stream (`GET /api/events`) -- a channel a
 * process with no board can subscribe on. `createSseHub` above cannot serve this: it is
 * keyed by board id, and a process with no board (bin/menubar.m, which has no board to
 * open) has no key to subscribe under. This hub is the opposite shape on purpose -- one
 * flat set of subscribers, because there is nothing to key them BY: every subscriber wants
 * every event (a timer tick matters to a menu bar regardless of which board is on screen),
 * unlike a board stream where a Watcher only ever wants its own board's events. No
 * per-Watcher Attended bookkeeping either, for the same reason: Attended is a fact about a
 * board tab, and nothing here is about a board. */
export function createStreamHub() {
  const subs = new Map(); // subscriberId -> res

  return {
    subscribe(res) {
      const id = randomBytes(16).toString('hex');
      subs.set(id, res);
      return id;
    },
    unsubscribe(id) {
      subs.delete(id);
    },
    /** Same wire shape as `createSseHub.broadcast` (`event: <name>\ndata: <json>\n\n`),
     * deliberately: a client that already knows how to parse one SSE stream needs no
     * second parser for the other. Every live subscriber gets every event -- see this
     * function's own header for why there is no narrower audience to pick from. */
    broadcast(eventName, data) {
      if (subs.size === 0) return;
      const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of subs.values()) {
        try { res.write(payload); } catch { /* dead connection; the 'close' handler cleans it up */ }
      }
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

/** Which daemon this is, for install.sh's health gate and nothing else.
 *
 * "Something answered on the port" is not "the service I just installed came up": a
 * hand-run `node bin/daemon.mjs`, or a previous install's daemon still holding the port,
 * answers exactly the same — while the job launchd was just handed cannot bind, fails,
 * and gets throttled into a restart loop. install.sh knows the one program path it
 * pointed launchd at (the copy inside the bundle, or the clone's bin/daemon.mjs on the
 * degraded path) and compares this against a digest of it.
 *
 * The DIGEST, never the path: `/api/health` is the one route with no credential on it
 * (isOpenRoute), so anything added here is readable by any local process. A digest keeps
 * that route's disclosure exactly where it was — a version string and, now, an opaque
 * 64-hex identity — while still being reproducible by the one caller that already knows
 * the path. `process.argv[1]` rather than this module's own URL, because the identity
 * that matters is what the launcher/launchd exec'd, and it cannot change under a running
 * process, so this is computed once. */
const DAEMON_ID = createHash('sha256').update(String(process.argv[1] || ''), 'utf8').digest('hex');

/** Wall-clock ceiling on a single /wait call, the server-side twin of the shim's
 * CLAUDE_BOARD_TIMEOUT_MS (PROTOCOL.md "MCP shim environment"): a waiter nobody ever
 * answers gets an explicit `timeout` packet instead of polling the store forever.
 * 40 minutes (ADR.md entry 47), for every round -- awaited page board and question
 * round alike, one clock and one env var rather than a rule per round shape. Must
 * equal src/board.mjs's `DEFAULT_AWAIT_TIMEOUT_MS`, which is what `handlePostBoard`
 * below stamps a round's `awaitDeadline` with. */
export const DEFAULT_WAIT_TIMEOUT_MS = 2_400_000;

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
 * local processes, which "Localhost, one human" boundary already trusts. */
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
 * through the reviewer's browser. It does NOT stop the attack that motivated it: a local
 * process that harvested the cookie — cookies are not port-scoped,
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
 * top-level browser navigation — the bookmark case — sends
 * `Sec-Fetch-Site: none`. Requiring presence would refuse both and buy nothing, since
 * the caller this would be aimed at can set the header anyway. */
function isSameOriginRead(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

/** The pomodoro writes a cookie-holding browser may perform, and NOT a moment more. A
 * NAMED closed set, never a `parts[1] === 'pomodoro'` prefix match, which would silently
 * hand the cookie every pomodoro write this file ever grows, including ones that should
 * stay secret-only; the next one is secret-only until someone deliberately types it
 * here. `BOARD_COOKIE_ACTIONS` below is the same rule for the board routes.
 *
 * Each member is on the list because a browser holding only the cookie is what performs
 * it, and none reaches further than something already on it:
 *
 *  - `ensure`: the index widget's switch starts a pomodoro by hand. `startWork` is a
 *    no-op against any timer that already exists (src/pomodoro.mjs), so the worst a
 *    cookie holder does with it is begin an advisory clock that `reset` would have let
 *    them end anyway.
 *  - `preview`: the settings popover's picker must audition a cue the instant the reader
 *    selects it, before anything is saved (ADR.md entry 20). It reads and writes NOTHING
 *    (not pomodoro.json, not settings.notify), so a cookie holder gains at most "spawn
 *    `afplay` against one of the 14 files src/cues.mjs's closed set admits" — less reach
 *    than `settings`, which lets the same caller rewrite every duration and toggle.
 *  - `notifyTest`: the visual half of `preview`, from the same popover's Notify tick
 *    (src/indexpage.mjs). Reads and writes nothing either; what it gains is one banner
 *    reading "Notifications are working", a literal out of src/notify.mjs's closed
 *    table, never anything the request supplies, and there is no body to supply it with.
 *  - `forward`/`restart`: a browser holding the cookie is exactly what clicks either
 *    control. `forward` ends the running interval early (`reset`
 *    already lets a cookie holder end it outright) and `restart` re-mints the current
 *    interval's deadline (`settings` already lets the same caller change what every
 *    FUTURE deadline computes from). Both are silent by construction (src/pomodoro.mjs's
 *    forwardTimer/restartTimer never surface a `boundary` their caller could feed a
 *    notification), so neither adds "can make the machine make a sound". */
const POMODORO_COOKIE_ACTIONS = new Set(['ensure', 'pause', 'resume', 'reset', 'settings', 'preview', 'notifyTest', 'forward', 'restart']);

function isPomodoroCookieWrite(parts) {
  return parts[0] === 'api' && parts[1] === 'pomodoro' && parts.length === 3 && POMODORO_COOKIE_ACTIONS.has(parts[2]);
}

/** The board writes a cookie-holding browser may perform: `submit`, and `attended`
 * (CONTEXT.md "Watcher", "Attended" — ADR.md entry 58). A named closed set for the
 * reason `POMODORO_COOKIE_ACTIONS` above states.
 *
 * `attended` belongs on this list because it is the only party that CAN send it —
 * a browser holding a live stream on this board, reporting whether its own tab is
 * visible and focused. It reaches less than `submit` already does: it names no
 * round, carries no answer, and touches nothing durable, only the in-memory SSE
 * hub's per-Watcher flag (`createSseHub`'s `setAttended`, above) that a restart
 * clears for free. Leaving it off this list, requiring the local secret instead,
 * would make it unreachable from the one place it has to be reachable from -- a
 * browser holding only the cookie (SECURITY.md "What the cookie may write"):
 * gating it behind the secret would 403 every genuine report, and no gate at all
 * would let any local process forge one and silence a board's Stranded banner
 * until the next restart. */
const BOARD_COOKIE_ACTIONS = new Set(['submit', 'attended']);

function isBoardCookieWrite(parts) {
  return parts[0] === 'api' && parts[1] === 'board' && parts.length === 4 && BOARD_COOKIE_ACTIONS.has(parts[3]);
}

/** The store writes a cookie-holding browser may perform: `prune`, and nothing else. A
 * named closed set for the reason `POMODORO_COOKIE_ACTIONS` above states.
 *
 * `prune` is admitted with its eyes open, because it is the one member of any of these
 * three lists that DESTROYS something rather than reading or nudging it. The reasoning is
 * not "it reaches less than submit" — it reaches further — but placement: ADR 71 puts the
 * control in the index's settings panel, and the index page is exactly a browser holding
 * only the session cookie. Requiring the secret instead would make the one surface the
 * decision names unable to fire it. What still stands in front of it is the whole of the
 * rest of the gate: the loopback `Host` check, `isSameOriginWrite`, and a cookie that is
 * derived from the local secret and revoked by rotating it. The store is also already
 * fully readable to the same holder — a credential that can read every question, answer
 * and snapshotted source file in the archive is not one you are protecting the archive
 * from — and the window that decides what dies is named in the request, never here. */
const STORE_COOKIE_ACTIONS = new Set(['prune']);

function isStoreCookieWrite(parts) {
  return parts[0] === 'api' && parts[1] === 'store' && parts.length === 3 && STORE_COOKIE_ACTIONS.has(parts[2]);
}

/** True iff this write may proceed. Two ways to hold a credential, and they are not
 * interchangeable:
 *
 *  - the secret itself, in the `x-claude-board-secret` header. That is the shim, and it
 *    is what EVERY write except `submit`/`attended` and the pomodoro actions below
 *    demands — including `POST /api/board`, the only route that resolves a file, and
 *    `POST /api/handoff`, which mints browser credentials and so must never be
 *    reachable with one.
 *  - the session cookie an authorized browser holds, accepted on submit, and — as of
 *    the pomodoro slice — on `ensure`/`pause`/`resume`/`reset`/`settings` too. The index
 *    page's switch is a browser holding only the cookie: under the old rule it could
 *    render the board but could not press pause. The justification is the same one that
 *    already let submit in: the cookie is worth "may read every board in the store and
 *    may answer any open round" (src/secret.mjs `sessionToken`'s own comment), and
 *    pausing an advisory clock that never gates an `ask` and never reaches a tool is
 *    strictly less than that — `isSameOriginWrite` still stands in front of it, exactly
 *    as it does for submit. `settings` is the one that reaches furthest and the one to
 *    measure a NEW action against, because it is not board-neutral: `TOGGLE_KEYS`
 *    (src/pomodoro.mjs) persists `notifyRounds` into `pomodoro.json`, and
 *    src/stranded.mjs's `announce` refuses to raise a banner when
 *    `roundBannersEnabled` reads it false — so a cookie-only caller can durably silence
 *    every Stranded banner for every board on this machine. That is the ceiling this
 *    list currently grants; anything reaching past it wants the secret, not the cookie. The board-scoped fallback token that
 *    used to sit here is deleted rather than kept beside it. `attended` joins the cookie
 *    set on the same footing again, reaching less than either: see
 *    `BOARD_COOKIE_ACTIONS` above.
 *
 * Every non-GET goes through here, rather than an enumerated list of write routes: a
 * route added later is then gated by default instead of by remembering to add it. The
 * three exception lists are `BOARD_COOKIE_ACTIONS`, `POMODORO_COOKIE_ACTIONS` and
 * `STORE_COOKIE_ACTIONS` above. */
function isAuthorizedWrite(req, parts, secret) {
  if (!secret) return false; // no secret on disk: refuse writes rather than fall open
  if (secretMatches(req.headers[SECRET_HEADER], secret)) return true;
  if (!isBoardCookieWrite(parts) && !isPomodoroCookieWrite(parts) && !isStoreCookieWrite(parts)) return false;
  return sessionCookieMatches(req.headers.cookie, secret);
}

/** The two GET routes that are reachable with no credential, and the reason each is.
 *
 *  - `/api/health`: install.sh polls it with plain `curl` to decide whether the service
 *    actually came up, and gating it would make a fresh install report failure on a
 *    daemon that is working perfectly. It answers `{ ok, version, daemon }` and nothing
 *    else — no board, no path, no store contents. `daemon` is DAEMON_ID above: a digest
 *    of this process's own program path, so the gate can tell the daemon it just
 *    installed from any other listener on the port, and a path is still never disclosed.
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
 * explains the actual fix. Basic auth was rejected for the same reason. */
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
// itself now lives in src/render.mjs,
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

function boardUrl(req, id) {
  return `http://${req.headers.host}/b/${id}`;
}

/** The board's URL and this daemon's own port, for a banner's click target -- built from
 * the SOCKET the request arrived on and never from `boardUrl` above.
 *
 * `boardUrl` reflects the `Host` header, which is right for a URL handed back to the
 * caller that sent that header: it keeps a reviewer on the origin they are already using
 * and holding a session cookie for. It is exactly wrong here. `isLoopbackHost` admits any
 * `<anything>.localhost` and pins no port, so a `Host: localhost:31337` on a plain read --
 * `GET /api/board/<id>/events` needs only a read credential -- would put an attacker's
 * loopback origin into argv of the signed, Documents-granted launcher, and the reviewer
 * would get a genuine claude-board banner whose click opened someone else's server.
 *
 * `req.socket.localPort` is the port THIS process is listening on, learned from the
 * kernel rather than from anything a caller can write, and the host is the literal
 * 127.0.0.1 that `startServer` binds. The port is returned alongside the URL and not
 * merely embedded in it, because `notifyRound` passes it to the launcher as its own
 * argument: bin/launcher.c's `cb_is_board_url` compares the two and refuses a URL whose port
 * disagrees, so the number has to come from one read of one authoritative source rather
 * than being derived twice and hoped to agree. */
export function strandedTarget(req, id) {
  const port = req.socket && req.socket.localPort;
  if (!Number.isInteger(port) || port <= 0) return { url: null, port: null };
  return { url: `http://127.0.0.1:${port}/b/${id}`, port };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Poll the store until `round` is sent, reading from disk each iteration, so this is
 * agnostic to whether the caller was here before a daemon restart. Returns a tagged
 * result rather than a board, so the caller can tell "gone" from "nobody answered"
 * from "the client left".
 *
 * Two ways out besides the round being sent, because this is a `for(;;)` in a daemon
 * launchd keeps alive forever: `isAborted()` (the client hung up — the same liveness
 * rule handleEvents applies to an SSE subscription) and `deadlineAt` (the wall-clock
 * cap). Without them every timed-out or abandoned `ask` would leave a loop re-parsing a
 * board JSON — which embeds full file snapshots — every 120ms for the life of the
 * machine.
 *
 * `abandoned` is the fourth way out, and it is not a nicety: `abandonOpenRounds`
 * (src/board.mjs) invented a THIRD terminal state, and a loop that only recognises
 * `sent` cannot see it. A backgrounded first `ask` -- the ordinary `fresh: true` path
 * after a context compaction -- therefore polled a round the daemon had already closed
 * for the full forty-minute cap and then reported a `timeout` whose text says the board
 * is "still open ... reopen it", which is false in both halves. A round that is
 * abandoned is exactly as final as one that is sent; the only difference is what the
 * caller is told, which is the caller's branch to make, not this loop's. */
async function waitForRound(boardId, round, home, { intervalMs = 120, isAborted = () => false, deadlineAt = Infinity } = {}) {
  activeWaits++;
  try {
    for (;;) {
      if (isAborted()) return { aborted: true };
      const board = readBoard(boardId, home);
      if (!board) return { gone: true };
      const r = board.rounds.find(r => r.n === round);
      if (r && r.status === 'sent') return { board };
      if (r && r.status === 'abandoned') return { abandoned: true, board };
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
 * embedded for the client to hydrate `board` from. Pin rendering
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
    // `stripDaemonOnly` for the same reason renderBoardPage applies it (see its own
    // comment in src/board.mjs): a field present in the rendered payload and absent from
    // these pushes shows up as a spurious `computeBoardPatch` diff on the client.
    boardForClient: stripDaemonOnly({ ...board, comments: resolvedComments }),
  };
}

/** Render the SSE payload for a live push: the full board (so a subscriber's local
 * `computeBoardPatch(prevBoard, nextBoard)` can diff against it) plus a pre-rendered
 * HTML fragment covering exactly the blocks this push touched -- never the whole
 * page -- so the client only ever inserts/replaces that much DOM. `mode` is
 * 'new-round' (a fresh round section, rendered via renderRoundSection so a later
 * full reload is byte-identical to what the push already inserted) or 'amend' (the
 * round is unchanged, only specific blocks inside it were added or replaced, so the
 * fragment is just those blocks via renderBlock, with no round wrapper).
 *
 * Both modes derive `fullpage` from the round's own shape rather than being told
 * it, and the amend branch has to do so explicitly because it renders blocks
 * without a round wrapper (renderRoundSection derives it for the 'new-round'
 * branch, src/render.mjs). This function's contract is that the push and a later
 * full reload are byte-identical for the same board, and here the difference would
 * be visible damage rather than cosmetic drift: an amended page-board block
 * rendered as an ORDINARY stage resurrects a kicker and an expand control over a
 * 100vh frame (criteria 1 and 25) and drops `.page-comments`, putting the comment
 * form below the fold of a page that cannot scroll (criterion 5) -- and
 * applyRoundPush replaces the block outright, so nothing repairs it short of a
 * reload.
 *
 * Exported for test/check-page-board.mjs; the daemon's own call site is one line
 * below. */
export function buildRoundPushPayload(board, round, mode, blockIds) {
  const { commentsByBlock, boardForClient } = resolveBoardComments(board);
  const fullpage = isPageRound(board.blocks.filter(b => b.round === round));
  const html = mode === 'new-round'
    ? renderRoundSection(board, round, commentsByBlock)
    : blockIds
      .map(id => {
        const block = board.blocks.find(b => b.id === id);
        return block ? renderBlock(block, board, commentsByBlock, false, fullpage) : '';
      })
      .join('\n');
  return { round, mode, blockIds, html, board: boardForClient };
}

/** The project directory already bound to `thread`, or null when this is a thread
 * nobody has posted to yet. The thread's OLDEST board is the one that bound it, so
 * that is the one asked — reading "whatever the newest board says" would let a board
 * that somehow slipped through re-decide the answer for everything after it.
 *
 * Takes the store walk rather than making one: its only caller already has to walk for
 * the thread-uniqueness set beside it (see `handlePostBoard`), and two walks of the same
 * directory in one request handler is one more full parse of every board than the answer
 * needs. */
function boundCwdForThread(thread, boards) {
  const inThread = boards
    .filter(b => b && b.thread === thread && b.cwd)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return inThread.length ? inThread[0].cwd : null;
}

async function handlePostBoard(req, res, home, sse, stranded, stream, waiting) {
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
      // Idempotency. Everything after readJsonBody is synchronous, so a socket that dies
      // before the response lands — a reload-on-change exit, a kickstart, the shim's own
      // inactivity timeout — leaves the round fully applied and the caller told it
      // failed; the agent retries, and amendRound APPENDS a second copy of every block.
      // A retry carrying the same `requestId` is answered from what that id already did.
      //
      // Scoped to a round that is still `open` AND has not lapsed, never to the board.
      // `requestId` is derived from the round's CONTENT, so the ordinary
      // fix-and-reconfirm loop ("show file, ask, fix, show the same file, ask again")
      // posts a byte-identical body: a board-lifetime `lastRequestId` answered that as a
      // retry and handed the agent the PREVIOUS round's answer, a decision the reviewer
      // never made. And once a page board can be awaited (ADR.md entry 45), "still open"
      // alone let a re-posted artifact resume a round whose deadline had already lapsed --
      // a read-only panel for the reviewer, nothing for the agent, and the timeout text
      // telling the agent to post a fresh round landing straight back in this dedupe. A
      // lapsed round can never hand an agent anything again, so it is never the answer to
      // a retry; the post falls through and mints round N+1 with a live deadline. The
      // lost-response retry this defends against always targets a live open round, so
      // neither gate costs anything.
      //
      // The third gate is `roundContentDrifted` (src/board.mjs), and it is what makes
      // this an identity over the round's RESOLVED CONTENT rather than over the request
      // body. `requestId` hashes the raw blocks, and a raw block names a file by path, so
      // the loop the manual prescribes -- post an artifact, regenerate the file it
      // references, re-issue the identical `ask` -- arrives here as a byte-identical
      // body and used to be answered `deduped: 200`. The reviewer kept seeing v1, the
      // agent believed v2 had landed, and (a content-only round is never `sent`) nothing
      // ever moved that round out of `open` to break the cycle. Same bytes on disk is
      // still a retry; different bytes is a different round, and falls through.
      //
      // Hoisted out of the condition rather than inlined, because BOTH gates below need
      // the same answer and it must be the same one. Failing the dedupe is only half the
      // fix: a retry that falls out of it lands on the amend gate one branch down, and
      // for the shape `ask` actually posts -- an artifact block beside the question about
      // it -- that gate says yes. The round then holds the old artifact AND the new one,
      // the old question AND its duplicate, and the packet reports two answers for one
      // question. "Drifted" has to mean "not this round's business" at every gate that
      // could still put these blocks into round N, not just at the first.
      //
      // Computed only for a candidate RETRY (`isRetry`), never on the ordinary post
      // path: it re-reads every referenced file, and a post that is not answering to an
      // already-applied `requestId` has nothing to compare against anyway.
      const guarded = board.rounds[board.rounds.length - 1];
      const isRetry = Boolean(body.requestId) && board.lastRequestId === body.requestId;
      const drifted = isRetry && !!guarded && roundContentDrifted(board, guarded.n);
      if (isRetry && guarded && guarded.status === 'open'
        && !roundWaitLapsed(guarded) && !drifted) {
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
      // A round that ASKS SOMETHING is the only kind of open round a later post
      // may amend. The amend rule exists for one situation -- "the agent is
      // still assembling the round the reviewer has not answered yet" -- and a
      // round carrying no question block is not in that situation: nothing can
      // ever answer it, so it is complete the moment it lands, and it stays
      // `open` for good (ADR.md entry 35 makes a page board unsendable, and
      // `applySubmit` is the only writer of `sent`).
      //
      // Nested questions count too (questionBlocks walks context, compare sides
      // and variant options, and normalizeBlock stamps the same `round` on every
      // one), so a round whose only question sits inside a compare is still
      // amendable.
      //
      // The consequence, and it is a real one: two rounds can now be open at the
      // same time -- an artifact round that will never be sent, and the question
      // round after it. Everything that asks "which round is open" therefore
      // has to mean the LATEST open one, which is what `amendRound`
      // (src/board.mjs) and `handleSubmit` below were changed to say.
      //
      // A round whose WAIT HAS LAPSED is not amendable either, for the same reason the
      // dedupe one branch up refuses to resume one: nothing will ever hand an agent
      // anything off it again. `status` alone cannot see that -- only submit and abandon
      // move `status`, and `closeLapsedAwaitedRounds` moves only `awaited` -- so a
      // question round that timed out sits at `status: 'open'` forever, and without this
      // gate the daemon's OWN timeout advice ("post a fresh round to continue") landed
      // the agent's next question appended to the dead round. `ask` then answered
      // `awaited: false`, the shim reported "no response needed", nothing waited, and
      // the reviewer's still-live Send bar answered into a void -- for every further
      // question in that conversation. A lapsed round is never the answer to a retry
      // (PROTOCOL.md), and it is not the home of a follow-up either: this falls through
      // to `addRound` and mints round N+1 with a live deadline.
      //
      // `!drifted` (computed above) is the same rule arriving from the other direction,
      // and this gate is where it actually bites for the shape `ask` posts. A retry
      // naming a file whose bytes changed is refused by the dedupe above -- and then
      // lands HERE, on a round that is open and does ask something, because the manual's
      // own flow puts the artifact and the question about it in ONE round. Amending
      // appends: the reviewer gets round 1 holding the stale artifact, the new artifact,
      // the question and its duplicate, and `buildPacket` reports two answers for one
      // question. The dedupe gate refusing a retry only means "this is not the request I
      // already applied"; it never meant "so append it to that request's round".
      const latestAsksSomething = !!latestRound
        && questionBlocks(board).some(q => q.round === latestRound.n);
      if (latestRound && latestRound.status === 'open' && latestAsksSomething
        && !roundWaitLapsed(latestRound) && !drifted) {
        // The open round hasn't been sent yet: amend it in place rather than
        // minting round N+1.
        //
        // `title` is passed through on both paths: `ask` requires a non-empty title on
        // every call and commands/grill.md tells the agent to make it the branch name,
        // so dropping it on every round after the first leaves the reviewer looking at
        // an unlabelled "Round 2". Storing it on the round object is src/board.mjs's
        // half and rendering it is src/render.mjs's — both owned elsewhere; this side
        // stops throwing the value away.
        // `cwd` is forwarded so assertCwdNotRetargeted can actually refuse it.
        // It was dropped here, so the guard only ever saw `undefined` and returned at
        // once: a post naming a different `cwd` alongside `boardId` got a 200 and the
        // caller believed it had retargeted the board. PROTOCOL.md and the guard's own
        // comment both specify a loud 400 instead of a silent no-op.
        const result = amendRound(board, { blocks: body.blocks, title: body.title, cwd: body.cwd });
        round = result.round;
        touchedBlockIds = result.blockIds;
        pushMode = 'amend';
      } else {
        // `wait` (ADR.md entry 45): declared, never inferred from these blocks' shape
        // alone -- `addRound` (src/board.mjs) is what turns it into `awaited` +
        // `awaitDeadline` on the round it mints, the same two ways in CONTEXT.md's
        // Awaited entry names (a question anywhere in the round, or `wait: true` on
        // a page board). `awaitTimeoutMs` is this process's own env-resolved cap, so
        // the deadline stamped on the round and the wall clock `/wait` enforces below
        // are the same 40 minutes, not two constants that can drift.
        round = addRound(board, { blocks: body.blocks, title: body.title, cwd: body.cwd, wait: Boolean(body.wait), awaitTimeoutMs: waitTimeoutMs() });
        touchedBlockIds = board.blocks.filter(b => b.round === round).map(b => b.id);
        pushMode = 'new-round';
      }
    } else {
      // ONE walk of the store for this branch, feeding both things a brand-new board
      // needs to know about the threads that already exist. `boundCwdForThread` did its
      // own walk here and `takenThreads` would have been a second; a create is the one
      // post that legitimately has to look at more than its own board, and it should
      // look exactly once. Nothing else on this handler walks: a round pushed into an
      // existing board takes the branch above and reads one document.
      const boards = listBoards(home);
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
        threadCwd: body.thread ? boundCwdForThread(body.thread, boards) : null,
        // The thread ids already in use, so a minted one cannot land on another
        // session's (src/board.mjs `mintThreadId`). Thread ids route undelivered
        // comments across the whole store, so a collision is a comment delivered to a
        // project the agent has never seen and lost to the agent it was written for --
        // not the cosmetic index clash the short width was chosen against.
        takenThreads: new Set(boards.map(b => b.thread).filter(Boolean)),
        wait: Boolean(body.wait),
        awaitTimeoutMs: waitTimeoutMs(),
      });
      round = 1;
    }
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }
  // Rendered BEFORE either persist call: renderBoardPage
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
  // Unconditionally, unlike the board-scoped push above: `pushMode` is only set when
  // appending to a board that already exists (a second round in a thread), but a BRAND
  // NEW board's first round is the commonest way the waiting count moves at all -- every
  // plain `ask()` mints one. A new or amended round can be the one that makes this board
  // newly awaited (ADR 45) either way, so the daemon-wide count may have just changed
  // regardless of which branch above ran; see `broadcastWaiting`'s own comment for why
  // this fires on every post rather than only the ones that provably changed it.
  broadcastWaiting(stream, waiting, board);
  // A round has just landed: if nobody is looking at this board, it is Stranded and the
  // daemon says so after the grace (criteria 1 and 3). After the persist and the push,
  // deliberately -- the rule reads the board back off disk, and the banner it may raise
  // is about the state this request has already committed, not the one it is midway
  // through writing.
  stranded.evaluate(board.id, strandedTarget(req, board.id));
  // `clients` is the count at the instant this round landed. Nothing in bin/ reads it --
  // see createSseHub.clientCount.
  return sendJson(res, 200, {
    boardId: board.id,
    thread: board.thread,
    round,
    url: boardUrl(req, board.id),
    clients: sse.clientCount(board.id),
    // The minted round's own awaited-ness, straight from `mintAwait` (src/board.mjs),
    // so the caller does not have to re-derive it from the blocks it sent. It cannot:
    // the shim checks the RAW blocks and has no way to know that an `html` block's
    // `source` failed to resolve, which is the one case where the two answers differ
    // -- and where the shim used to block out the whole cap on a round this daemon
    // had already decided nobody would ever answer (bin/mcp.mjs `isPageRoundShape`).
    awaited: roundIsAwaited(board, board.rounds.find(r => r.n === round)),
  });
}

/** Serve the board page. Reached only by a caller that already presented a credential
 * (gate 4), so it hands out none of its own: no `Set-Cookie` here, and nothing about the
 * credential in the markup. That keeps the served page's bytes a pure function of the
 * board JSON, which is what makes the standalone `pages/*.html` archive byte-identical
 * to what the daemon serves — and what makes an archived board openable from disk with
 * no daemon and no credential at all. */
function handleGetPage(req, res, id, home) {
  const board = readBoard(id, home);
  if (!board) return sendText(res, 404, 'board not found');
  return sendHtml(res, 200, renderBoardPage(board));
}

/** The daemon's one static route: `GET /b/<ui|styles>-<hash>.<js|css>`, the shared script
 * and stylesheet every page now names instead of carrying (ADR 70).
 *
 * It sits under `/b/` and not under some `/assets/` prefix of its own because the page's
 * reference is a BARE FILENAME — the only spelling that resolves both served and from
 * Finder — and a bare filename on a page served at `/b/<id>` resolves to `/b/<name>`. The
 * two namespaces cannot collide: an asset name contains a dot, which `SAFE_BOARD_ID`
 * (src/store.mjs) forbids, so the router's `ASSET_NAME` test below is a partition, not a
 * priority.
 *
 * Served from DISK, never from the in-memory `SHARED_ASSETS`: a page written six months ago
 * names the payload it was rendered against, and this daemon is running a newer one. Reading
 * `pages/<name>` is what makes the served surface and the Finder surface literally the same
 * bytes, which is the promise the hash in the name makes.
 *
 * Behind the read gate like every other route: the caller is a page this daemon just served,
 * so it is already holding the session cookie. `immutable` caching is safe for exactly the
 * same reason the name is a hash — the bytes under a given name never change. */
function handleGetAsset(res, name, home) {
  // The fallback covers the one case where a live page names an asset the store has never
  // written: a board whose JSON exists but whose page file does not (readable through
  // `GET /b/:id`, which re-renders from JSON and never touches pages/). Serving it from
  // memory cannot serve the WRONG bytes — the name is their hash — and the alternative is a
  // board page whose whole script 404s. It stays a read: nothing is written on a GET.
  const bytes = readAsset(name, home)
    ?? (SHARED_ASSETS.find(a => a.name === name)?.contents ?? null);
  if (bytes === null) return sendText(res, 404, 'asset not found');
  res.writeHead(200, {
    'content-type': assetContentType(name),
    // byteLength, not `.length`: the fallback above hands back a JS string, whose length is
    // UTF-16 units, and the stylesheet carries non-ASCII (`·`, `—`) in its own comments.
    'content-length': Buffer.byteLength(bytes),
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(bytes);
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
    // is not. Send it where the token would have sent it.
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

/** ADR 35: a comment left on a round that returned no packet is held as undelivered
 * and rides the next packet the same thread returns, once.
 *
 * "Nobody is listening" is decided by ONE fact: whether a packet actually left this
 * round, recorded as `delivered` on the comment itself. Not by the round's shape (keying
 * on that handed an awaited page round's comments back twice -- once in its own packet,
 * through `buildPacket`'s ordinary round-scoped filter, and again here), and no longer by
 * `roundIsAwaited` either.
 *
 * `awaited` is a MINT-TIME flag, and using it as a stand-in for "its own packet carried
 * these" lost a reviewer's comment permanently: `applySubmit` moves a round to `sent`
 * without clearing `awaited` (`closeLapsedAwaitedRounds` only clears while `open`), so a
 * round born awaited and then submitted is `sent + awaited: true` for good. Any comment
 * left on it was filtered out of every future packet on the thread -- the exact loss
 * ADR 35 exists to prevent, in the commonest shape there is: a reviewer answering an
 * awaited round at a moment when no `/wait` happened to be connected.
 *
 * So the mark is what the flag was standing in for, and `commit` below now sets it for
 * the waited round's OWN comments as well as for the drained ones -- a packet leaving
 * this round is exactly the event that makes its comments delivered. The two directions
 * meet: a comment whose packet left is never drained again, and a comment whose packet
 * never left is always drained next.
 *
 * Walks every board of `thread`, not just `board`: a thread's rounds can span more
 * than one board (`boundCwdForThread` above does the same walk for the same reason),
 * and a carried-forward comment can live on any of them. Each pending comment is
 * resolved against its OWN board -- `blockId` and `n` numbering are per-board
 * (PROTOCOL.md "Identifiers") -- never smuggled into `board`'s. `round`'s own comments
 * are excluded here regardless (even on the rare shape where the round being waited on
 * is itself not awaited): `buildPacket`'s normal round-scoped filter already hands
 * those back in the same packet, and including them here too would duplicate them in
 * one response.
 *
 * Marking a comment delivered is split from computing which ones are: this function
 * only reads and resolves, and returns a `commit` closure that does the actual
 * `delivered = true` flip and `writeBoard` -- untouched until the CALLER decides the
 * packet is safely gone (see `buildPacketWithUndelivered` and `handleWait`, which
 * commit only on the response's own `finish` event). Marking eagerly, before the packet
 * is known to have left the daemon, loses the comment outright to a request that aborts
 * or a daemon that restarts in that window -- and noise beats data loss, since ADR 35
 * exists precisely so a comment produces something somebody reads. */
function drainUndeliveredComments(thread, board, round, home) {
  // ponytail: this reads and parses every board in the store on every `/wait` that
  // resolves, to find the few in this thread. The ceiling is the store's total size,
  // not the thread's -- `boundCwdForThread` above pays the same cost and its own
  // comment justifies keeping it off the hot path, which this is closer to. It is
  // fine while a store holds hundreds of boards and a wait is once per round; the
  // upgrade path, when it stops being fine, is a thread -> board-id index beside the
  // boards rather than a smarter walk.
  const boards = listBoards(home)
    .filter(b => b && b.thread === thread)
    // Reuse the already-loaded board for its own entry rather than the copy
    // listBoards just re-read from disk -- same file, but it keeps the `pending`
    // entries below pointing at the very objects the packet was built from. `commit`
    // no longer writes this object back (it re-reads), so this is about which comments
    // get drained, not about which document gets saved.
    .map(b => (b.id === board.id ? board : b))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const comments = [];
  const pendingByBoard = [];
  for (const b of boards) {
    const undelivered = (b.comments || []).filter(c => c.delivered !== true);
    // The waited round's own comments are DRAINED by nobody -- `buildPacket`'s
    // round-scoped filter already put them in this very packet, and repeating them here
    // would duplicate them in one response -- but they are MARKED by this commit all the
    // same, because that packet leaving is precisely what makes them delivered. Split
    // lists, one `writeBoard`: `drained` is what the caller adds to the packet, `mark`
    // is everything this packet accounts for.
    const drained = undelivered.filter(c => b.id !== board.id || c.round !== round);
    const mark = b.id === board.id ? undelivered : drained;
    if (!mark.length) continue;
    if (drained.length) comments.push(...resolveComments(b, drained));
    pendingByBoard.push({ board: b, pending: mark });
  }
  const commit = () => {
    for (const { board: b, pending } of pendingByBoard) {
      // Kept even though nothing in this process reads it again before `commit` runs
      // (the packet was already built from `resolveComments`' own copies, above): it
      // costs nothing, and it keeps this in-memory board agreeing with what is about to
      // be written, rather than depending on an argument about who else might hold `b`.
      for (const c of pending) c.delivered = true;
      // Re-read, and copy across ONLY the delivered marks this rule owns -- matched by
      // each comment's stable, append-only per-board `n` (src/board.mjs), never by
      // identity or array position. Writing back the whole captured `b`, as this used
      // to, made this function a participant in every read-modify-write race on the
      // board document rather than in none of them: `commit` runs on the response's own
      // `finish` event (see handleWait), a LATER macrotask than the capture above -- and
      // in that window the stranded rule's timer callback can have written a fresh
      // `STRANDED_BANNER` record onto this same board (src/stranded.mjs's `persist`
      // already defends that field against this exact writer, by name, in its own
      // comment -- that half and this one are the two sides of one invariant). This
      // is the reverse direction: without it, this closure's stale whole-board write
      // would silently erase that record, or resurrect one the reviewer had already
      // dismissed.
      //
      // A throw here is an uncaught exception at the top of the event loop -- by the
      // time a `finish` handler runs, the request's own try/catch is long gone, and
      // bin/daemon.mjs answers one of those by exiting, taking every blocked `/wait`
      // with it. So, like src/stranded.mjs's `persist`, swallow per board: the comment stays
      // undelivered and rides the next `/wait` on the thread instead, which is noise
      // (ADR 35 already tolerates a redelivery), not the data loss a crashed daemon
      // would be.
      try {
        const fresh = readBoard(b.id, home);
        if (!fresh) continue; // the board is gone; nothing to mark
        const deliveredNs = new Set(pending.map(c => c.n));
        for (const fc of fresh.comments || []) {
          if (deliveredNs.has(fc.n)) fc.delivered = true;
        }
        writeBoard(fresh, home);
      } catch (err) {
        console.error(`claude-board: could not mark comments delivered for board ${b && b.id}: ${(err && err.message) || err}`);
      }
    }
  };
  return { comments, commit };
}

/** `buildPacket` plus whatever undelivered comments the thread is owed (ADR 35) --
 * every place a packet leaves the server through `/wait` goes through this instead of
 * `buildPacket` directly, timeout included: a timed-out round still returns a packet,
 * and a comment held from an earlier round is just as owed to it as to a normal one.
 *
 * Returns `{ packet, commit }`, not a bare packet: see `drainUndeliveredComments` for
 * why persisting the delivered marks is deliberately not this function's job. Exported
 * so a check can prove the marks stay unpersisted until `commit()` runs without having
 * to win a real socket-abort race. */
export function buildPacketWithUndelivered(board, round, url, home) {
  const packet = buildPacket(board, round, url);
  const { comments: drained, commit } = drainUndeliveredComments(board.thread, board, round, home);
  if (drained.length) packet.comments = packet.comments.concat(drained);
  return { packet, commit };
}

async function handleWait(req, res, id, url, home, sse, stream, waiting) {
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
  if (result.abandoned) {
    // The conversation that owned this board declared itself over (`POST /abandon`,
    // ADR 69) while this call was still blocked on it. Answered AT ONCE and named for
    // what it is: this used to be invisible to `waitForRound`, so the caller sat on a
    // round the daemon had already closed until the forty-minute cap and was then handed
    // a `timeout` telling it the board was "still open ... reopen it" -- forty minutes of
    // nothing, ending in advice that could not work.
    //
    // Nothing is written and nothing is broadcast here, unlike the timeout branch
    // below: `handleAbandon` already persisted the close, already nudged the board's
    // open tabs, and already republished the waiting count. This branch is only the
    // reply owed to a caller that happened to be blocked when it did.
    //
    // The packet still carries whatever the store holds (partial answers included),
    // exactly as the timeout branch does, and rides the same undelivered-comment path:
    // a comment left before the session walked away is owed to this packet as much as
    // to any other. `status: 'abandoned'` is additive -- PROTOCOL.md's packet statuses
    // gain a third terminal one beside `submitted`/`discuss`/`timeout`, matching the
    // third terminal ROUND state `abandonOpenRounds` (src/board.mjs) already invented.
    const { packet, commit } = buildPacketWithUndelivered(result.board, round, boardUrl(req, id), home);
    res.once('finish', commit);
    return sendJson(res, 200, { ...packet, status: 'abandoned' });
  }
  if (result.timedOut) {
    // The wall-clock cap is an explicit no-response, not an error: same `timeout`
    // status PROTOCOL.md "Packet" already defines, carrying whatever partial answers
    // the store holds.
    //
    // When a wait dies while the page is open, the page is told over SSE. This
    // IS the moment a wait dies -- the wall clock this same call has been
    // enforcing the whole time just fired -- so the board's own open tab(s)
    // are nudged to repaint right now rather than only ever noticing on their
    // own next periodic check (src/ui.mjs's refreshAwaitDisplay). No payload
    // beyond the round number: everything a
    // tab needs to decide "read-only now" is already in `board.rounds` and its
    // own clock (badge.mjs's roundIsCurrentlyAwaited, the same predicate this
    // very call enforced server-side), so the event is a wake-up nudge, not a
    // second copy of the packet. Broadcast unconditionally rather than only for
    // a round this daemon confirms was genuinely awaited: a `/wait` on a round
    // nobody is counting down is a no-op nudge on the client (nothing there
    // reads a countdown for a round that was never showing one), and gating it
    // here would mean re-deriving the same predicate a second time for no
    // observable gain.
    // Record that the wait died, durably. Correctness does not depend on this write:
    // `readBoard` (src/store.mjs) sweeps the same flag on every read, so every reader
    // is already right, and a lapsed round stays honest even when no daemon was
    // connected to notice. What this adds is disk agreeing with them -- the board
    // JSON is the archive, and it is read by things that never go through this
    // process. The sweep has therefore ALREADY run on `result.board` (that is where
    // it came from), so this persists rather than re-deriving; gating the write on
    // "did anything change" would mean it never ran at all. Ordered ahead of the
    // broadcast so a tab that refetches on the nudge cannot read a board still
    // claiming to be awaited. See closeLapsedAwaitedRounds (src/badge.mjs).
    closeLapsedAwaitedRounds(result.board);
    writeBoard(result.board, home);
    sse.broadcast(id, 'awaitExpired', { round });
    // A wait dying is a round leaving the waiting count exactly as surely as an answer is.
    broadcastWaiting(stream, waiting, result.board);
    const { packet, commit } = buildPacketWithUndelivered(result.board, round, boardUrl(req, id), home);
    // Committed only once the response has actually left this process (see
    // drainUndeliveredComments): if the socket died in the window between
    // waitForRound resolving and here -- the exact race `isAborted()` above cannot
    // always catch, since a close event and a timer callback land in different libuv
    // phases -- `res.end()` below either never reaches 'finish' or errors out, and
    // this listener simply never fires, leaving the comment undelivered for the next
    // wait to pick up rather than losing it.
    res.once('finish', commit);
    return sendJson(res, 200, { ...packet, status: 'timeout' });
  }
  const { packet, commit } = buildPacketWithUndelivered(result.board, round, boardUrl(req, id), home);
  res.once('finish', commit);
  return sendJson(res, 200, packet);
}

/** POST /api/board/:id/abandon -> `{ ok, board, closed: [n…] }`: the shim declaring that
 * the conversation which owned this board is over (ADR 69, `fresh` on `ask`), so every
 * round still open on it is closed on the way out.
 *
 * SECRET-ONLY, deliberately: it is off `BOARD_COOKIE_ACTIONS` above, so the session
 * cookie does not reach it and a browser cannot close a round it is looking at. The only
 * caller is the shim that posted the board, naming the board id it holds in its own
 * memory — which is what scopes this to the declaring session and keeps two shims in one
 * project directory out of each other's way: nothing here reads `cwd`, `thread`, or any
 * other board.
 *
 * Takes no body. The round-closing rule is `abandonOpenRounds` (src/board.mjs) and the
 * request has nothing to add to it; `req.resume()` drains whatever a caller sent anyway
 * rather than leaving the socket half-read.
 *
 * Rendered before either persist, and the page written as well as the document — the same
 * ordering and the same pair `handleSubmit` below uses, for the same reason. It matters
 * more here than anywhere: an abandoned board is one nothing will ever post to again, so
 * this is the LAST write it will ever get, and a `pages/<id>.html` left showing live
 * widgets would stay that way in the archive for good.
 *
 * `stranded.abandoned` last, after the write has landed. That single call is the whole of
 * criterion "its Banner does not fire afterwards", and it has two halves: it cancels a
 * grace still counting down, and it withdraws the banner already on screen by SIGTERMing
 * the process serving its click. Nothing re-arms it, because only a round landing on this
 * board could, and no round ever will.
 *
 * `abandoned`, not `evaluate`, and the difference is load-bearing since ADR 74 made the
 * announcement mark permanent. `evaluate` alone now cancels the pending grace and stops:
 * with nothing awaited there is nothing to announce, so it takes the early exit and never
 * reaches the banner already delivered, which would sit on screen for up to
 * `min(the round's deadline, CLICK_LIFETIME_MAX_MS)` pointing at a board where nothing is
 * awaited. It used to fall out of `mayAnnounce` retiring a record whose round had stopped
 * being awaited — which also handed the next round a fresh banner, the behaviour entry 74
 * removes. `abandoned` keeps the withdrawal and drops the re-announcement.
 *
 * Deliberately NOT `stranded.answered`: nobody answered anything, and that path is scoped
 * to one round number where this is about every open round at once. */
function handleAbandon(req, res, id, home, sse, stranded, stream, waiting) {
  req.resume();
  const board = readBoard(id, home);
  if (!board) return sendJson(res, 404, { error: 'board not found' });
  const closed = abandonOpenRounds(board);
  if (closed.length) {
    const html = renderBoardPage(board);
    writeBoard(board, home);
    writePage(board.id, html, home);
    // The same nudge `handleWait`'s timeout branch sends, and the same event: from a
    // still-open tab's point of view this IS its round's wait ending. No payload beyond
    // the round number, for the reason given there.
    for (const n of closed) sse.broadcast(id, 'awaitExpired', { round: n });
    // Every closed round here was open, and an open round can be an awaited one -- the
    // same reasoning `broadcastWaiting`'s other call sites carry.
    broadcastWaiting(stream, waiting, board);
  }
  stranded.abandoned(id);
  return sendJson(res, 200, { ok: true, board: board.id, closed });
}

/** How a board with nothing open got that way, for the 409 a Send lands on. Two ways in
 * (`applySubmit` and `abandonOpenRounds`, src/board.mjs) and the refusal used to name only
 * one of them: a reviewer whose board was abandoned out from under them -- the ordinary
 * `fresh: true` path after a context compaction -- was told the board "has already been
 * submitted", which is a claim that someone answered it. Nobody did. `n` names the round
 * the caller asked about when there is one; without it the LAST round is the one that
 * decides, since it is the one the reviewer is looking at. */
function closedVerb(board, n = null) {
  const rounds = board.rounds || [];
  const round = n === null ? rounds[rounds.length - 1] : rounds.find(r => r.n === n);
  return round && round.status === 'abandoned'
    ? 'been abandoned: the session that posted it declared itself over'
    : 'already been submitted';
}

async function handleSubmit(req, res, id, home, sse, stranded, stream, waiting) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  const board = readBoard(id, home);
  if (!board) return sendJson(res, 404, { error: 'board not found' });
  // A round is answered exactly once, and the submitter must name which round it is
  // answering. The board is the durable record of what was decided, so a submit naming a
  // round that is not currently `open` is refused with 409 and changes nothing — which
  // is also what makes a client retry safe, rather than duplicating every comment (and
  // its pin number, PROTOCOL.md "Identifiers") and re-applying every answer. A stale
  // client is the normal case, not an attack: a laptop waking from sleep with no SSE
  // replay, a second tab, or a plain double-click on Send.
  //
  // The check is PER-ROUND -- does `claimed` name a round that is currently `open` --
  // and not "is it the single most-recent open round", because a board can hold more
  // than one open round at once and more than one of them can be genuinely awaited: an
  // artifact round (never sendable, ADR.md entry 35, unless itself awaited per ADR.md
  // entry 45) and the question round posted after it (see handlePostBoard's amend rule
  // above). Gating on the latest instead stops an awaited page round being submittable
  // the moment a second round opens beside it, and the shim's wait then hangs to the
  // wall clock. `openN` (the latest open round, or null) is kept only for the two places
  // that still need a single number to report: the already-submitted short-circuit
  // below, and the 409 body's resync hint when `claimed` names something else.
  const openRounds = board.rounds.filter(r => r.status === 'open');
  const openRound = openRounds.length ? openRounds[openRounds.length - 1] : null;
  const openN = openRound ? openRound.n : null;
  const claimed = body.round;
  if (!Number.isInteger(claimed)) {
    // "No round named" on a board with no open round is not a malformed request, it is
    // the already-submitted case — and it is the exact body the page sends when its Send
    // button is pressed on a finished board, because openRoundNumber() returns null
    // there. Answering 400 sent the client down its generic error path (it special-cases
    // only 409), which showed `submit failed: 400` and re-enabled the buttons for an
    // identical retry, forever. 409 is both truer and handled.
    if (openN === null) {
      return sendJson(res, 409, { error: `this board has ${closedVerb(board)}`, board: board.id, round: null });
    }
    return sendJson(res, 400, { error: 'submit requires an integer "round" naming the round being answered', board: board.id, round: openN });
  }
  const claimedRound = openRounds.find(r => r.n === claimed);
  if (!claimedRound) {
    return sendJson(res, 409, {
      error: openN === null
        ? `round ${claimed} is not open: this board has ${closedVerb(board, claimed)}`
        : `round ${claimed} is not open — reload the board to see what has changed`,
      board: board.id,
      round: openN,
    });
  }
  const round = claimed;
  try {
    applySubmit(board, { action: body.action, answers: body.answers, comments: body.comments }, round);
  } catch (err) {
    // Same shape as handlePostBoard's guard above, and for the same reason: applySubmit
    // now runs answers through byValueText, which throws a plain Error carrying no
    // `.status`. Without this the router's top-level catch would default it to 500, so an
    // over-cap note -- a reviewer typing too much, not an attack -- would read as a daemon
    // fault instead of a rejected request.
    return sendJson(res, 400, { error: String(err.message || err) });
  }
  // Rendered BEFORE either persist call below -- see handlePostBoard's identical
  // ordering, and its comment, for the reasoning.
  const pageHtml = renderBoardPage(board);
  writeBoard(board, home);
  writePage(board.id, pageHtml, home);
  // Every connected client -- including the one that just submitted, which is
  // subscribed to its own board like any other -- turns this round sent (and
  // read-only, if it is the page that client is showing -- ADR.md entry 42) on
  // the same signal, so a second tab never has to reload to see
  // it. `html` is the round re-rendered from the now-authoritative board (the
  // actual answers/notes/choices that were sent), not a hint to disable whatever
  // happened to already be on screen in some OTHER tab -- a second tab's own
  // unsent, unrelated selections were never what got sent, and freezing them into
  // the sent round as if they were would show every reviewer a different,
  // wrong "what was answered". A round that just became sent carries no more
  // in-progress state worth preserving, so replacing its markup outright here is
  // correct, not merely convenient.
  const { commentsByBlock, boardForClient } = resolveBoardComments(board);
  const html = renderRoundSection(board, round, commentsByBlock);
  sse.broadcast(id, 'submitted', { round, board: boardForClient, html });
  // Answered is the other way off the waiting list -- an open round this same call just
  // closed, mirroring `handleWait`'s timeout branch and `handleAbandon` above.
  broadcastWaiting(stream, waiting, board);
  // Criterion 15: the daemon owns the click-serving process and terminates it "once the
  // reviewer returns to the board OR the round is answered". This is the second half --
  // a banner still on screen pointing at a round that has just been answered has nothing
  // left to open, and killing it withdraws it. `round` is passed because the banner is
  // about ONE round and this board may have another awaited beside it; answering that
  // other one must leave the banner alone. The `evaluate` after decides the rest:
  // whoever answered is normally looking at the board, so this usually resolves to a
  // return. A submit carrying the local secret rather than a browser session does not --
  // there is no Watcher to be attended -- and there the record is retired instead, by
  // `mayAnnounce`, once the round it named stops being awaited.
  stranded.answered(id, round);
  stranded.evaluate(id, strandedTarget(req, id));
  return sendJson(res, 200, { ok: true, board: board.id, round });
}

/** POST /api/board/:id/attended: the open board tab reporting whether it is Attended
 * (CONTEXT.md "Watcher", "Attended") -- visible and focused, right now. Body:
 * `{ watcher, attended }`, where `watcher` is the id the SSE stream handed this same
 * tab in its own `watcher` event (see `handleEvents`, below) and `attended` is a
 * plain boolean. Cookie-authenticated exactly like `submit` -- `attended` joins
 * `BOARD_COOKIE_ACTIONS` above -- because a browser holding that cookie is the only
 * party that can honestly answer this question, and it is the security-relevant part of
 * this route: off every list it would 403 every report a real tab sends, and ungated it
 * would accept a forged report from any local process and silence a board's Stranded
 * banner until the next restart (SECURITY.md "What the cookie may write").
 *
 * What it STORES is a fact about a live SSE connection (`sse.setAttended`, in
 * `createSseHub` above) and nothing about the board -- but it is not free of durable
 * consequence: the stranded rule reads that fact on the line below, and a report that
 * ends an absence retires the record standing on the board, one `readBoard` and one
 * `writeBoard` over a document that can be large for a page board. That cost is paid
 * only when the reviewer actually comes back to a board that had been announced; the
 * ordinary report writes nothing.
 *
 * An unknown board id and an unknown `watcher` id are both a silent no-op rather than a
 * 404 -- see `setAttended` for why a report cannot always know it lost that race -- and
 * an unknown `watcher` stops there, before the rule is consulted at all. */
async function handleAttended(req, res, id, sse, stranded) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  if (typeof body.watcher !== 'string' || !body.watcher) {
    return sendJson(res, 400, { error: 'attended requires a string "watcher" naming the SSE connection it updates' });
  }
  if (typeof body.attended !== 'boolean') {
    return sendJson(res, 400, { error: 'attended requires a boolean "attended"' });
  }
  // Optional, and a 400 only when present and malformed: a page that predates the
  // ordering sends none and is applied as it always was (see `setAttended`).
  if (body.seq !== undefined && !(Number.isInteger(body.seq) && body.seq >= 0)) {
    return sendJson(res, 400, { error: 'attended\'s optional "seq" must be a non-negative integer' });
  }
  // How long ago this TAB last had focus, so the look-away window survives a reconnect
  // (ADR.md entry 73; see `setAttended`). Optional and validated the same way `seq` is: a
  // page that predates it sends none and the Watcher keeps only what the daemon observed
  // itself.
  if (body.sinceFocusMs !== undefined && !(Number.isInteger(body.sinceFocusMs) && body.sinceFocusMs >= 0)) {
    return sendJson(res, 400, { error: 'attended\'s optional "sinceFocusMs" must be a non-negative integer' });
  }
  // The return value is the point: `setAttended` is what knows whether this report names
  // a Watcher this board actually has AND whether it is newer than the one already
  // applied. A report that names none, or that lost a race to a later edge, changed
  // nothing -- so there is nothing to re-decide. Acting on it anyway would let any caller
  // holding a credential drive the stranded rule with a made-up id -- reaching a durable
  // write, and steering the click target with this request's socket -- on a route whose
  // whole answer is otherwise a silent no-op. Still a 200: see `setAttended` for why a tab
  // cannot know it lost that race.
  if (!sse.setAttended(id, body.watcher, body.attended, body.seq ?? null, body.sinceFocusMs ?? null)) return sendJson(res, 200, { ok: true });
  // The one report that changes whether this board is Attended is also the one event
  // that can strand a round without a round having landed or a tab having closed:
  // switching away from a board with something awaited on it (criterion 3), and coming
  // back to one already announced (criterion 6). Both are this line.
  stranded.evaluate(id, strandedTarget(req, id));
  return sendJson(res, 200, { ok: true });
}

/** GET /api/board/:id/events: subscribe this connection to round pushes and submit
 * notifications for `id`. Never resolves on its own -- the response stays open
 * until the client disconnects -- so unlike the other handlers this is not awaited
 * by the caller. Heartbeat comment lines keep it alive through idle timers and
 * proxies (see DEFAULT_SSE_HEARTBEAT_MS); `req`/`res` close/error tear the
 * subscription and the interval down so a disconnected client is never broadcast
 * to. See PROTOCOL.md "SSE events". */
function handleEvents(req, res, id, home, sse, stranded) {
  const board = readBoard(id, home);
  if (!board) return sendJson(res, 404, { error: 'board not found' });
  // Captured while the socket is unambiguously alive, because the cleanup below runs
  // after it has gone: a banner raised fifteen seconds after the last tab closed still
  // has to be able to name the board it is about, and `req.socket.localPort` is not
  // something to be reading off a destroyed socket.
  const target = strandedTarget(req, id);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  const watcherId = sse.subscribe(id, res);
  // Handed to the client as a real event, not a comment, because the page has to
  // read it as data: it is what an `attended` report (below) names to say which
  // Watcher it is updating. Sent before anything else so a report the page fires
  // off its very first visibilitychange/focus handler still has an id to carry.
  res.write(`event: watcher\ndata: ${JSON.stringify({ id: watcherId })}\n\n`);
  // A tab arriving holds any banner back at once, which is what makes "a tab that drops
  // and reconnects inside the grace window raises no banner" and "restarting the daemon
  // under an open board is silent" (criterion 4) true without a reconnect ever being a
  // case anything has to recognise. It does NOT end an absence: this Watcher is
  // Attended-unknown until it reports (see `subscribe`), and it is the report a moment
  // later -- `handleAttended`, below -- that decides whether the reviewer is actually
  // here or whether this is a buried tab that merely found its socket again.
  stranded.evaluate(id, target);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* connection is gone; cleanup below handles it */ }
  }, sseHeartbeatMs());
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    sse.unsubscribe(id, watcherId);
    // The disconnect hook: this Watcher is gone, so ask again whether anything is still
    // looking at this board. The last tab on a board with a round still awaited is
    // criterion 2, and the grace is what keeps a mere reconnect from being one. Fires on
    // req close, res close and res error alike, which is fine: a grace already counting
    // down is left alone rather than re-armed, so calling this three times costs nothing.
    stranded.evaluate(id, target);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/** `GET /api/events`: the daemon-wide stream (`createStreamHub` above), for a subscriber
 * with no single board to open one under: bin/menubar.m, which has no board id at all, and
 * the index page (ADR.md entry 87), which lists every board rather than holding one.
 * Shaped exactly like `handleEvents` above (the same `: connected` line, the same
 * heartbeat, the same close/error cleanup) because a caller that already knows how to hold
 * a `text/event-stream` connection open needs no second set of rules to learn. No
 * `watcher` event, unlike the board stream: nothing here is per-Watcher, so there is no id
 * for a later request to name. Never resolves on its own -- the response stays open until
 * the client disconnects. */
function handleStream(req, res, stream) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  const subId = stream.subscribe(res);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* connection is gone; cleanup below handles it */ }
  }, sseHeartbeatMs());
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    stream.unsubscribe(subId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// The one in-flight preview child, module scope rather than per-request: there is one
// daemon and one reader, and "a rapid series of changes never overlaps
// into a chorus" means the SECOND picker change must kill the FIRST preview, which is
// only possible if both requests can see the same handle. No per-session or per-socket
// keying -- a preview belongs to the one settings popover open at a time, the same way
// the pomodoro clock itself is one global timer and not one per request (ADR.md entry 8).
let previewChild = null;

/** Play one cue file directly with `afplay`, outside Notification Center entirely — the
 * one path ADR.md entry 20 calls out as deliberately unfiltered, because auditioning a
 * cue from a picker must not raise a banner. Kills whatever is still playing FIRST,
 * so a rapid series of picker changes each cut the previous one off rather than layering
 * into a chorus -- the kill happens even when `cue` turns out to be `None`
 * or invalid, so selecting None while something is still playing silences it too.
 *
 * Async only and every failure swallowed, never thrown -- the same discipline
 * src/notify.mjs's own header lays out, and for the identical reason: a reader's PATH,
 * a missing afplay, or a already-exited child must never be a way to fail the HTTP
 * response this rides in on or to take anything else down. */
function playPreview(cue) {
  if (previewChild) {
    try { previewChild.kill(); } catch { /* already exited: nothing to kill */ }
    previewChild = null;
  }
  const filePath = cuePath(cue); // null for NO_CUE and for anything isCue() refuses
  if (!filePath) return;
  try {
    const child = execFile('afplay', [filePath], () => {
      // Only clear the slot if it is still THIS child -- a later preview may already
      // have replaced it (killed it, even), and that call's own callback is what owns
      // clearing the slot for what it started.
      if (previewChild === child) previewChild = null;
    });
    previewChild = child;
  } catch {
    // afplay missing from PATH, or some other spawn-time failure: never audible,
    // never thrown. See this function's own header.
  }
}

/** `GET /api/waiting` -- every round in the store still waiting for an answer, as JSON.
 *
 * It exists because the thread index is HTML and nothing else answers this question: the
 * status item (ADR.md entry 72) is a native client with no DOM to scrape, and the only
 * other surface that knows which boards owe the reviewer a trip is a rendered page.
 *
 * Gated like every other read -- deliberately NOT on `isOpenRoute`'s list. What it hands
 * back is a board's title and its project folder for every live thread in the store,
 * which is precisely the "questions and answers of every board" the read gate was added
 * to stop a local process from harvesting; there is no bootstrap reason for an exception
 * here the way there is for `/api/health` and `/auth/:token`.
 *
 * The whole list, with a `total`, never a truncated one. The popover's "at most five,
 * then an overflow row" is a rule about a popover's maximum height, so it belongs to
 * whoever is drawing the popover -- a cap applied here would silently be the cap for
 * every future client, and a client that wanted to say "and 7 more" would then have no
 * number to say it with.
 *
 * `now` is the server's own clock, for the same reason `sendPomodoro` below sends it: a
 * client's wall clock is not the daemon's, and one that computes an offset once from a
 * response it already had to make can then reason about every deadline the daemon mints
 * without ever trusting its own `Date.now()`. */
function handleWaiting(req, res, waiting) {
  const rows = waiting.rows();
  return sendJson(res, 200, {
    // The `url` is the one field built per request rather than cached with the row:
    // it comes off the `Host` this request arrived with (see `boardUrl`), which is
    // right for a URL handed straight back to the caller that sent it -- and wrong to
    // freeze into a cache two different callers share.
    waiting: rows.map(r => ({ boardId: r.boardId, thread: r.thread, title: r.title, round: r.round, url: boardUrl(req, r.boardId) })),
    total: rows.length,
    now: Date.now(),
  });
}

/** Every round in the store still waiting for an answer, cached behind the store's own
 * fingerprint -- the same device `GET /api/index/rows` already uses, applied to the two
 * paths that were re-parsing every board document in the store on the daemon's one
 * thread: `GET /api/waiting` (the status item's fixed 15s poll) and the waiting count
 * every post/submit/abandon/expiry publishes. Measured by the audit at ~39 ms per walk at
 * 200 boards and ~200 ms at 1000, ahead of every blocked `/wait` and every SSE heartbeat,
 * for a number nothing bounds the growth of.
 *
 * Three things can move a row, and each has its own answer here:
 *
 *  - a board written by THIS daemon: `noteWrite` patches that one board's rows in place
 *    from the copy the request already has in memory, so a post costs no walk at all
 *    rather than a walk it could have avoided. Every route that writes a board also
 *    publishes the count, so every such write comes through here.
 *  - a wait LAPSING, which changes a row with no write behind it at all (`readBoard`
 *    sweeps it in memory and the file never moves): `lapseAt`, exactly as the rows cache
 *    computes it, off the same walk.
 *  - anything else that touches the directory -- a prune, a hand-edit, a second daemon:
 *    `storeFingerprint`, a readdir plus a stat per file and nothing parsed.
 *
 * `stamp` rides on the cached row so the sort survives a patch. It is `updatedAt` or the
 * empty string, never `String(...)`: a missing `updatedAt` stringifies to "undefined",
 * which collates ABOVE every ISO timestamp and would pin a hand-edited board to the head
 * of the list forever (the same trap buildThreadIndex documents in src/indexpage.mjs).
 * Newest first, matching how the thread index orders its own live rows.
 *
 * Per handler, like `rowsCache` beside it, so two daemons in one process never serve each
 * other's rows. */
function createWaitingCache(home) {
  let cache = null; // { print, lapseAt, rows } | null
  const rowsFor = board => waitingRounds(board).map(r => ({
    boardId: board.id,
    // The thread, so a client can group two board docs of one session the way the
    // index does rather than presenting them as two unrelated rows.
    thread: board.thread,
    // The same headline the index row uses, resolved HERE rather than left to the
    // client: title, else the project's folder name, else a plain label. A client
    // that had to fall back for itself would need `cwd` -- an absolute path from the
    // reader's machine -- to do it, and this route has no reason to hand that out.
    title: board.title || folderName(board.cwd) || '(untitled)',
    round: r.n,
    stamp: typeof board.updatedAt === 'string' ? board.updatedAt : '',
  }));
  const sorted = rows => rows.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return {
    rows() {
      const print = storeFingerprint(home);
      if (!cache || cache.print !== print || Date.now() >= cache.lapseAt) {
        // Every board read through `readBoard` -- which is what applies
        // `closeLapsedAwaitedRounds` (src/store.mjs's own comment), so a round whose
        // wait died is already un-flagged before `waitingRounds` ever sees it. That is
        // the whole handling of the lapsed case: no clock here, and no second sweep.
        const boards = listBoards(home);
        cache = { print, lapseAt: nextLapseAt(boards), rows: sorted(boards.flatMap(rowsFor)) };
      }
      return cache.rows;
    },
    /** The board a request has just written, still in memory: fold it in rather than
     * re-reading the store to learn what this process already knows.
     *
     * `lapseAt` only ever moves EARLIER here. A board whose soonest deadline this write
     * removed would leave the cache expiring sooner than it strictly must, which costs
     * one walk and cannot serve a stale row; recomputing it properly would need the
     * walk this whole function exists to skip.
     *
     * ponytail: re-fingerprinting here also ADOPTS whatever else has changed on disk
     * since the last walk, which is only sound because every writer inside this daemon
     * that can move a row publishes the count through here (`broadcastWaiting`'s call
     * sites are exactly the routes that write a board) and the one that removes boards
     * calls `reset` above. An outside editor writing a board file directly is the
     * residual, and it is the same residual `storeFingerprint`'s own comment documents:
     * at worst one row is a poll behind. The upgrade path, if a second writer ever
     * appears, is to diff the fingerprint per file rather than adopt it wholesale. */
    noteWrite(board) {
      if (!cache) return; // nothing cached: the next read walks anyway
      cache.rows = sorted(cache.rows.filter(r => r.boardId !== board.id).concat(rowsFor(board)));
      cache.lapseAt = Math.min(cache.lapseAt, nextLapseAt([board]));
      cache.print = storeFingerprint(home);
    },
    /** Drop the cache outright, for the one mutation that is not a board this process
     * holds: `POST /api/store/prune` DELETES board documents (src/store.mjs), and a
     * patch-and-re-fingerprint after that would adopt a fingerprint describing a store
     * the cached rows no longer match -- serving rows for boards that are gone. */
    reset() { cache = null; },
  };
}

/** Publish the current waiting count on the daemon-wide stream. Called from every route
 * that could plausibly have moved it -- a round newly awaited, a round answered, a wait
 * expiring, a board abandoned -- rather than only where it provably did: a push that
 * happens to repeat the same number is indistinguishable from silence to anything
 * downstream. `board` is the document that route just wrote, folded into the cache here
 * so the count costs neither a walk nor a stale answer. Safe to call with no
 * subscribers; `createStreamHub.broadcast` is a no-op then. */
function broadcastWaiting(stream, waiting, board = null) {
  if (board) waiting.noteWrite(board);
  stream.broadcast('waiting', { total: waiting.rows().length, now: Date.now() });
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

/** The other half of every pomodoro write: `sendPomodoro` answers the caller that made it,
 * this publishes the same document -- same shape, same `now` discipline -- to whoever else
 * is subscribed to the daemon-wide stream (ticket 01's whole reason to exist). Called from
 * two places: every mutating branch below, and `startServer`'s `onBoundary` hook, for the
 * boundary crossings that happen with no request behind them at all -- a work interval
 * ending while nobody is looking is exactly the case a poll-only client shows late, and
 * the case this stream exists to fix. */
function broadcastPomodoro(stream, doc) {
  stream.broadcast('pomodoro', { ...doc, now: Date.now() });
}

/** Every `/api/pomodoro*` route. `pomo` is the ONE createPomodoro instance for this
 * daemon (see createRequestHandler) — every write below goes through it rather than a
 * bare readDoc/writeDoc pair, specifically so the live setTimeout it owns gets
 * re-armed (or cleared) as part of the same call, never as an afterthought a route
 * handler could forget. See PROTOCOL.md "HTTP surface" for the route table this
 * implements. `stream` is the daemon-wide hub (`createStreamHub`) every write below
 * publishes its resulting document to, alongside answering the caller that made it. */
async function handlePomodoro(req, res, parts, pomo, home, stream) {
  // GET /api/pomodoro: read straight off disk, not through `pomo`. This is safe — not
  // merely convenient — because reconciliation happens SYNCHRONOUSLY in this same
  // single-threaded event loop the instant a deadline is crossed (the armed
  // setTimeout's own callback), so by the time any request handler runs, a deadline
  // that has already passed has already been settled and written back.
  //
  // The one boundary no armed setTimeout is watching for is the pomodoro day's own
  // (ADR 67): nothing is scheduled for 05:00, so the rollover is applied by whatever
  // reads next — and `readPomodoroDoc` is that, for this route. A page opened after
  // 05:00 therefore never renders an interval the daemon already considers dead, and
  // opening it starts nothing, since rolling a read writes nothing.
  if (req.method === 'GET' && parts.length === 2) {
    return sendPomodoro(res, readPomodoroDoc(home));
  }
  if (req.method === 'POST' && parts.length === 3) {
    const action = parts[2];
    // Every mutation answers its own caller AND publishes the result on the daemon-wide
    // stream in the same breath -- `sendPomodoro` and `broadcastPomodoro` share the exact
    // shape (`{ ...doc, now: Date.now() }`), computed at two slightly different instants
    // rather than once, which is fine: both are "now" to within a function call, and
    // nothing downstream compares them against each other.
    const respond = doc => { broadcastPomodoro(stream, doc); return sendPomodoro(res, doc); };
    // Bodyless by design: `readJsonBody` is never called on this branch, which is what
    // makes a curl-shaped `POST /api/pomodoro/ensure` with no body and no
    // `content-type` succeed rather than 415 — the session-start hook is a
    // one-line shell `curl`, and it must not have to construct or parse anything.
    if (action === 'ensure') return respond(pomo.ensureTimer());
    if (action === 'pause') return respond(pomo.pause());
    if (action === 'resume') return respond(pomo.resume());
    if (action === 'reset') return respond(pomo.reset());
    // Bodyless like ensure/pause/resume/reset above -- neither control's caller (the
    // pomodoro widget's own two buttons) has anything to say beyond "now", and
    // src/pomodoro.mjs's forwardTimer/restartTimer take only `(doc, now)`.
    if (action === 'forward') return respond(pomo.forward());
    if (action === 'restart') return respond(pomo.restart());
    if (action === 'settings') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
      }
      try {
        return respond(pomo.settings(body));
      } catch (err) {
        // mergeSettings (src/pomodoro.mjs) throws naming the offending field; a rejected
        // body is a 400 with that message, never a silent partial write — nothing in
        // `pomo.settings` persists anything before every field in the patch validates.
        return sendJson(res, 400, { error: String(err.message || err) });
      }
    }
    // `{ cue: "<name>" }` -- what a picker sends the instant the reader selects it
    // (ADR.md entry 20). Deliberately NOT routed through `pomo`: this is
    // an audition, not a setting, so it never reads or writes pomodoro.json and never
    // looks at settings.notify -- the notify toggle silences the boundary cue, not the
    // picker's own preview ("even while the notify toggle is off").
    if (action === 'preview') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
      }
      // isCue (src/cues.mjs) is the whole validator, same closed set the settings route
      // holds cueWork/cueBreak/cueLongBreak to -- and it accepts NO_CUE ('None') as
      // valid, which previews as silence (playPreview's own cuePath(cue) === null
      // branch) rather than a 400: choosing None is a choice the reader must be able to
      // audition too.
      if (!isCue(body && body.cue)) {
        return sendJson(res, 400, { error: 'cue must be one of the sounds macOS ships, or "None"' });
      }
      playPreview(body.cue);
      return sendJson(res, 200, { ok: true });
    }
    // The banner half of `preview` above: what the Notify tick sends, so that turning
    // notifications on is confirmed by one arriving rather than by waiting out an
    // interval. No body is read at all -- there is nothing for the caller to say, since
    // the sentence is a literal out of src/notify.mjs's closed MESSAGES table -- and
    // like `preview` it never touches pomodoro.json or settings.notify: the tick that
    // triggers it has not been saved yet, and a test gated on the saved value would
    // answer the question backwards.
    if (action === 'notifyTest') {
      notifyTest();
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendText(res, 404, 'not found');
}

/** `POST /api/store/prune` — the ONLY thing in this daemon that ever deletes a board, and
 * the only caller `pruneStore` has (ADR 71). Fired by hand, from the index's settings
 * panel, and by nothing else: there is no prune on read, none at daemon start, and no
 * timer anywhere that reaches it.
 *
 * `{ days }` is required and is not defaulted here — `pruneStore` refuses a call that
 * does not name a window, and this route deliberately passes `body.days` straight
 * through rather than coercing a string or supplying a number of its own. The one number
 * that decides what dies is the caller's to name.
 *
 * No preview and no arming, matching the control that calls it: one click deletes. The
 * deliberate step is naming the window, not clicking after having named it. */
async function handlePrune(req, res, home, waiting) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'invalid JSON body' });
  }
  try {
    const { boards, assets } = pruneStore(body && body.days, home);
    // The one mutation that removes boards rather than writing one. Every cached view of
    // the store keyed on "which boards exist" has to hear about it; see
    // `createWaitingCache.reset`.
    waiting.reset();
    // Counts, not ids: nothing needs to know WHICH boards went (they are gone; there is
    // nothing left to address), and a list of every id in a large prune is a response
    // body that grows with the store for no reader.
    return sendJson(res, 200, { ok: true, boards: boards.length, assets: assets.length });
  } catch (err) {
    // `status: 400` is what pruneStore tags a refused window with; anything else really
    // is this daemon failing, and says so.
    return sendJson(res, err.status || 500, { error: String((err && err.message) || err) });
  }
}

/** The soonest instant at which a round still waiting anywhere in `boards` will lapse, or
 * `Infinity` when nothing is waiting. The one thing that changes an index row with no
 * write behind it: a wait dying takes the live dot out and the rounds-left badge down,
 * and `readBoard` performs that sweep in memory rather than writing it back, so the
 * board file is byte-identical either side of it. `GET /api/index/rows` expires its cache
 * here for exactly that reason — see the route.
 *
 * Read off boards that have ALREADY been through `readBoard`, so every round it sees is
 * one that is still genuinely waiting; the deadlines that have already passed were swept
 * to `awaited: false` before they got here, and cannot pull this back into the past. */
function nextLapseAt(boards) {
  let soonest = Infinity;
  for (const board of boards) {
    for (const round of (board.rounds || [])) {
      if (!roundIsAwaitedOpen(round)) continue;
      const at = Date.parse(round.awaitDeadline);
      if (Number.isFinite(at) && at < soonest) soonest = at;
    }
  }
  return soonest;
}

/** Build the daemon's request handler as a plain `node:http` listener, without
 * binding a port — used directly by the check and by `startServer` below.
 *
 * PER-INSTANCE, and this is where that rule is stated for the handler as a whole
 * (src/stranded.mjs's header states it again for its own factory, which is the one piece
 * a caller can reach without coming through here): everything the handler
 * owns — the SSE subscriber registry, the stranded watch, the handoff store — is built
 * here rather than at module scope, so two independent daemons in one process (as the
 * checks spin up) never share subscribers, announce for each other's boards, or redeem
 * each other's handoffs. */
export function createRequestHandler({ home = boardHome(), secret: pinnedSecret, pomodoro, stream } = {}) {
  const sse = createSseHub();
  // Built here rather than passed in because it reads THIS handler's hub.
  // `requestHandler.close` below is how startServer hands it its own shutdown --
  // criterion 15's "stopping the daemon leaves none of them running".
  const stranded = createStrandedWatch({ home, sse });
  // The daemon-wide stream (`createStreamHub`, ticket 01). Defaulted exactly like `pomo`
  // below and for the identical reason: `startServer` has to hand the SAME instance to
  // both this handler (whose `/api/events` route is what a client subscribes to) and the
  // pomodoro clock's `onBoundary` hook (which publishes a boundary crossing nobody
  // requested), so it is built there and passed in -- but a caller that never wires a
  // boundary notifier (every check that calls `createRequestHandler` directly) still gets
  // a working, if unshared, hub for free.
  const streamHub = stream || createStreamHub();
  // `GET /api/index/rows`'s one-entry cache: `{ print, query, html, lapseAt }`, or null
  // before the first poll. Per handler, like everything else here, so two daemons in one
  // process never serve each other's rows -- and dropped with the handler, so nothing here
  // outlives a daemon. See the route itself for what the fingerprint buys and what
  // `lapseAt` covers that it cannot.
  let rowsCache = null;
  // The same device for `GET /api/waiting` and the waiting count every write publishes
  // (see `createWaitingCache`). Per handler for the same reason `rowsCache` above is:
  // two daemons in one process must not answer from each other's store.
  const waitingCache = createWaitingCache(home);
  // A caller-supplied instance (startServer's, below) is what makes pause/resume/reset/
  // settings and the boot-time clock share the ONE live setTimeout for this daemon —
  // two independent createPomodoro() instances against the same home would each arm
  // their own timeout off the same file, and whichever fired second would stomp the
  // first's write. Defaulted rather than required only so createRequestHandler stays
  // usable on its own (as it always has been) without every caller learning about
  // pomodoro; nothing today calls it that way, and this instance is never booted here —
  // boot-time reconciliation is startServer's job, exactly as it already was.
  const pomo = pomodoro || createPomodoro({ home });
  const handoffs = createHandoffStore();
  // Re-read PER REQUEST, not once at startup. SECURITY.md,
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
  const requestHandler = async function requestHandler(req, res) {
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
      // Without it any local process reads every board, source excerpts included.
      if (req.method === 'GET' && !isOpenRoute(url.pathname, parts) && !isAuthorizedRead(req, secret)) {
        return sendCredentialRefusal(req, res, url.pathname);
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: PKG_VERSION, daemon: DAEMON_ID });
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

      // The rows feed the open index pages poll on their own fifteen-second tick (ADR.md
      // entry 77, amended by 87): the index already holds `GET /api/events`; giving these rows their own
      // live connection per open tab costs more than being at most one tick behind.
      //
      // The same renderer `GET /` uses, so what a poll patches in can never disagree with
      // what the page was served with -- and none of the page around it: no styles, no
      // script, no board bodies.
      //
      // What makes it cheap enough to answer on that interval for every open index is the
      // fingerprint, not the payload. `listBoards` is a synchronous read and parse of every
      // board document, which `GET /` pays once per navigation and this route would pay
      // every fifteen seconds per open tab, on the event loop, ahead of every blocked
      // `/wait` and every SSE heartbeat. `storeFingerprint` is a `readdir` plus a `stat`
      // per file and settles the common case -- nothing changed -- without parsing
      // anything. The threads themselves are cached per query behind it.
      //
      // Keyed by the query as well as the fingerprint, because two indexes can poll the
      // same daemon under different filters; one entry, not a map, since re-rendering on a
      // query the last caller did not use is one walk, not a leak, and an index nobody is
      // filtering is by far the common case.
      if (req.method === 'GET' && url.pathname === '/api/index/rows') {
        const query = url.searchParams.get('q') || '';
        const print = storeFingerprint(home);
        // The fingerprint cannot see a wait LAPSING, and a lapse changes a row: the live
        // dot goes out and the rounds-left badge drops. `readBoard` sweeps a lapsed
        // awaited round in memory rather than writing the sweep back, so nothing about the
        // file moves -- same size, same mtime, same listing -- and a fingerprint alone
        // would serve that row stale forever. The agent-still-waiting case self-heals
        // (`handleWait`'s timeout branch writes), but the one where nobody is waiting does
        // not: the reviewer closed the terminal, or the MCP call was interrupted, and an
        // index left open overnight goes on showing a live dot for a wait that died.
        //
        // So the cache also expires at the soonest deadline it can see, computed off the
        // same walk it already paid for. Precise rather than a coarse clock bucket: this
        // invalidates exactly when a row's content genuinely changes, and never otherwise.
        const lapsed = rowsCache && Date.now() >= rowsCache.lapseAt;
        if (!rowsCache || lapsed || rowsCache.print !== print || rowsCache.query !== query) {
          const boards = listBoards(home);
          const threads = buildThreadIndex(boards);
          rowsCache = { print, query, html: renderThreadRows({ threads, query }), lapseAt: nextLapseAt(boards) };
        }
        return sendJson(res, 200, { html: rowsCache.html });
      }

      // Beside `/api/search` because it is the same kind of thing: one walk of the store,
      // answered as JSON to a client with no page. See handleWaiting for why it is not on
      // `isOpenRoute` and why it returns everything rather than a client's first few.
      if (req.method === 'GET' && url.pathname === '/api/waiting') {
        return handleWaiting(req, res, waitingCache);
      }

      // The daemon-wide stream (ticket 01): timer, settings and waiting-count changes, for
      // a process with no board id to subscribe under `/api/board/:id/events` with. Gated
      // like every other read here -- there is nothing board-scoped about it to exempt.
      if (req.method === 'GET' && url.pathname === '/api/events') {
        return handleStream(req, res, streamHub);
      }

      if (req.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const results = searchBoards(query, home).map(r => ({ ...r, url: boardUrl(req, r.boardId) }));
        return sendJson(res, 200, { results });
      }

      if (req.method === 'POST' && url.pathname === '/api/board') {
        return await handlePostBoard(req, res, home, sse, stranded, streamHub, waitingCache);
      }

      if (req.method === 'GET' && parts[0] === 'b' && parts.length === 2) {
        // Ahead of the board route, and disjoint from it by construction — see
        // handleGetAsset on why the two share a prefix at all.
        if (ASSET_NAME.test(parts[1])) return handleGetAsset(res, parts[1], home);
        return handleGetPage(req, res, parts[1], home);
      }

      if (parts[0] === 'api' && parts[1] === 'board' && parts.length === 4) {
        const boardId = parts[2];
        const action = parts[3];
        if (req.method === 'GET' && action === 'wait') {
          return await handleWait(req, res, boardId, url, home, sse, streamHub, waitingCache);
        }
        if (req.method === 'GET' && action === 'events') {
          return handleEvents(req, res, boardId, home, sse, stranded);
        }
        if (req.method === 'POST' && action === 'submit') {
          return await handleSubmit(req, res, boardId, home, sse, stranded, streamHub, waitingCache);
        }
        if (req.method === 'POST' && action === 'abandon') {
          return handleAbandon(req, res, boardId, home, sse, stranded, streamHub, waitingCache);
        }
        if (req.method === 'POST' && action === 'attended') {
          return await handleAttended(req, res, boardId, sse, stranded);
        }
      }

      if (parts[0] === 'api' && parts[1] === 'pomodoro') {
        return await handlePomodoro(req, res, parts, pomo, home, streamHub);
      }

      if (req.method === 'POST' && url.pathname === '/api/store/prune') {
        return await handlePrune(req, res, home, waitingCache);
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
  // A property on the handler rather than a second return value: every caller this
  // module has ever had takes a bare listener function, and the one thing that needs
  // releasing is owned by a closure nothing else can reach. Idempotent, so a caller that
  // never calls it (a check building a handler and dropping it) loses only the pending
  // graces, which are unref'd timers, and the process-wide 'exit' hook still catches any
  // click-serving child.
  requestHandler.close = () => stranded.close();
  return requestHandler;
}

/** Start listening on 127.0.0.1. Resolves once bound, with the actual port (useful
 * for `port: 0` ephemeral binding in checks). */
export function startServer({ home = boardHome(), port = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT, secret } = {}) {
  // The daemon-wide stream (ticket 01). Created here, once, for the same reason the
  // pomodoro clock below is: `onBoundary` fires with no HTTP request behind it at all
  // (a work interval reaching its own deadline while nobody is polling), and only an
  // instance shared with `createRequestHandler`'s `/api/events` route can publish that
  // crossing to whoever is already subscribed there.
  const stream = createStreamHub();

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
  // `onBoundary` fires the native notification (src/notify.mjs, ADR.md entry 19) AND
  // publishes the crossing on the stream above -- the two are independent readers of the
  // same event, and neither's failure can touch the other: notifyBoundary swallows its
  // own errors (see its own module header) and `broadcastPomodoro` only ever writes to
  // already-open sockets. Dropping either call is the one edit that would leave the
  // daemon crossing every boundary in silence -- to Notification Center for one, to every
  // stream subscriber for the other -- with the rest of the suite still green, which is
  // why test/check-notify.mjs pins the first through startServer specifically.
  const pomodoro = createPomodoro({
    home,
    onBoundary: ({ phase, settings }) => {
      notifyBoundary(phase, settings);
      broadcastPomodoro(stream, readPomodoroDoc(home));
    },
  });

  // `secret` is passed through UNRESOLVED on purpose: defaulting it to readSecret() here
  // would pin the value for the life of the process and undo S4's fix one layer down,
  // where it would be much harder to notice. Absent means "read it per request".
  const handler = createRequestHandler({ home, secret, pomodoro, stream });
  const server = http.createServer(handler);

  pomodoro.boot();
  // Both closed on 'close' rather than left to their own unrefs: the pomodoro clock so a
  // restart against the same home never runs two live timers over one file, and the
  // stranded watch so that stopping this daemon takes every click-serving process it
  // spawned with it (criterion 15). See src/stranded.mjs's createStrandedWatch for the
  // abrupt-exit half.
  server.on('close', () => {
    pomodoro.close();
    handler.close();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, home });
    });
  });
}
