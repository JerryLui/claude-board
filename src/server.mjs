// The node:http daemon: routes, the loopback Host check, a polling wait on
// /api/board/:id/wait, and (ticket 04) the SSE push on /api/board/:id/events. See
// PROTOCOL.md "HTTP surface" and "SSE events".
//
// Three gates, in this order (DESIGN.md Decisions -> "A loopback Host check, an
// origin check, and a local secret"):
//
//   1. Host is loopback, on every route          -> 403, no body
//   2. non-GET is same-origin                    -> 403, no body
//   3. a write holds the local secret            -> 401, no body
//
// Read routes are deliberately NOT gated by (3). The reviewer's browser has no way to
// hold a 0600 file, and the spec's whole model is "open the page and answer", so
// `GET /`, `GET /b/:id`, `/api/search`, `/wait` and the SSE stream all keep working
// without it. What that means, plainly: the archive remains readable by any local
// process. What (3) buys is that only a caller holding the secret can make the daemon
// RESOLVE A FILE — i.e. create a board naming a `cwd` and read that directory back off
// the served page, which is the gadget the audit found.
//
// Waiting survives a daemon restart in principle: /wait polls the store (the
// source of truth) on disk rather than holding process-local state, so a waiter
// that reattaches after a restart sees exactly what a waiter that never
// disconnected would see. SSE survives it too, but differently: nothing can mutate
// the board while the daemon is down, so a client whose connection drops on
// restart just reconnects (EventSource does this natively) and picks up live
// pushes again with nothing missed in between — see DESIGN.md "Always on under
// launchd, reloaded by WatchPaths".

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoard, writeBoard, writePage, boardHome, listBoards, searchBoards } from './store.mjs';
import { readSecret, secretPath, secretMatches, submitToken, parseCookies, SECRET_HEADER, SUBMIT_COOKIE } from './secret.mjs';
import { createBoard, addRound, amendRound, applySubmit, buildPacket, resolveComments } from './board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, CSP } from './render.mjs';
import { buildThreadIndex, renderIndexPage } from './indexpage.mjs';

export const DEFAULT_PORT = 7391;

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

/** True iff this write may proceed. Two ways to hold the credential:
 *
 *  - the secret itself, in the `x-claude-board-secret` header. That is the shim, and
 *    it is what `POST /api/board` — the only route that resolves a file — demands.
 *  - the board-scoped submit cookie the daemon handed the browser when it served
 *    `GET /b/:id` (see src/secret.mjs `submitToken`), which authorises answering that
 *    one board and nothing else. Without it the reviewer could never press Send,
 *    since a page cannot read a 0600 file.
 *
 * Every non-GET goes through here, rather than an enumerated list of write routes: a
 * route added later is then gated by default instead of by remembering to add it. */
function isAuthorizedWrite(req, parts, secret) {
  if (!secret) return false; // no secret on disk: refuse writes rather than fall open
  if (secretMatches(req.headers[SECRET_HEADER], secret)) return true;
  const isSubmit = parts[0] === 'api' && parts[1] === 'board' && parts.length === 4 && parts[3] === 'submit';
  if (!isSubmit) return false;
  const presented = parseCookies(req.headers.cookie)[SUBMIT_COOKIE];
  return secretMatches(presented, submitToken(parts[2], secret));
}

// A board id is minted by src/board.mjs and always matches this, but the id in a URL
// path is whatever the caller typed. It is spliced into a Set-Cookie header below, so
// it is checked rather than trusted: a CR/LF would forge a header, a `;` a cookie
// attribute, and a `/` the cookie's Path scope.
const SAFE_BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
        const result = amendRound(board, { blocks: body.blocks, title: body.title });
        round = result.round;
        touchedBlockIds = result.blockIds;
        pushMode = 'amend';
      } else {
        round = addRound(board, { blocks: body.blocks, title: body.title });
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
  const html = renderBoardPage(board);
  writeBoard(board, home);
  writePage(board.id, html, home);
  if (pushMode) sse.broadcast(board.id, 'round', buildRoundPushPayload(board, round, pushMode, touchedBlockIds));
  return sendJson(res, 200, { boardId: board.id, thread: board.thread, round, url: boardUrl(req, board.id) });
}

/** Serve the board page, and hand the browser the one credential it can hold: a
 * host-only, path-scoped, HttpOnly SESSION cookie carrying this board's submit token.
 * Session-scoped (no Max-Age) so it dies with the browser rather than accumulating one
 * cookie per board ever opened; `SameSite=Strict` so no other origin can cause it to
 * be sent, on top of the origin check a write already passes. It is not written into
 * the markup, so the served page and the standalone pages/*.html archive stay
 * byte-identical — the page's bytes remain a pure function of the board JSON. */
function handleGetPage(req, res, id, home, secret) {
  const board = readBoard(id, home);
  if (!board) return sendText(res, 404, 'board not found');
  let extra = null;
  const token = SAFE_BOARD_ID.test(id) ? submitToken(id, secret) : null;
  if (token) {
    extra = { 'set-cookie': `${SUBMIT_COOKIE}=${token}; Path=/api/board/${id}/submit; HttpOnly; SameSite=Strict` };
  }
  return sendHtml(res, 200, renderBoardPage(board), extra);
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

/** Build the daemon's request handler as a plain `node:http` listener, without
 * binding a port — used directly by the check and by `startServer` below. Each
 * call gets its own SSE subscriber registry (createSseHub), so two independent
 * handlers built in the same process — as the checks do — never share subscribers. */
export function createRequestHandler({ home = boardHome(), secret = readSecret() } = {}) {
  const sse = createSseHub();
  // Read once, at startup, and say so plainly if it is missing — a daemon that
  // silently accepted every write because the file was gone would be worse than one
  // that refuses, since nothing in the UI would ever hint that the gate was open.
  if (!secret) {
    console.error(
      `claude-board: no local secret at ${secretPath()} — every write will be refused with 401 ` +
      `(reads still work). Run ./install.sh from the claude-board repository to generate one; ` +
      `an existing secret is never rotated.`
    );
  }
  return async function requestHandler(req, res) {
    try {
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

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: PKG_VERSION });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        const query = url.searchParams.get('q') || '';
        // One walk of the store, not two: the index and the search both read every
        // board file, and this daemon is single-threaded — a second full walk blocks
        // SSE heartbeats and submits behind it for no new information.
        const boards = listBoards(home);
        const threads = buildThreadIndex(boards);
        const results = query.trim() ? searchBoards(query, home, boards) : [];
        return sendHtml(res, 200, renderIndexPage({ threads, query, results }));
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
        return handleGetPage(req, res, parts[1], home, secret);
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

      return sendText(res, 404, 'not found');
    } catch (err) {
      return sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  };
}

/** Start listening on 127.0.0.1. Resolves once bound, with the actual port (useful
 * for `port: 0` ephemeral binding in checks). */
export function startServer({ home = boardHome(), port = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT, secret = readSecret() } = {}) {
  const server = http.createServer(createRequestHandler({ home, secret }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, home });
    });
  });
}
