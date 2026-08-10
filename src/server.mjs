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
import { randomBytes } from 'node:crypto';
import { readBoard, writeBoard, writePage, boardHome, listBoards, searchBoards } from './store.mjs';
import { readSecret, secretPath, secretMatches, sessionToken, sessionCookieMatches, SECRET_HEADER, SESSION_COOKIE, SESSION_MAX_AGE_S } from './secret.mjs';
import { createHandoffStore, handoffTarget, recoveryCommand, HANDOFF_TOKEN_RE, DEFAULT_PORT } from './handoff.mjs';
import { createBoard, addRound, amendRound, applySubmit, buildPacket, resolveComments, questionBlocks, stripDaemonOnly, STRANDED_BANNER } from './board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, renderRefusalPage, CSP, INDEX_CSP } from './render.mjs';
import { buildThreadIndex, renderIndexPage, folderName } from './indexpage.mjs';
// The one shape rule for "is this round a full-viewport page" (ADR.md entry 33),
// imported rather than restated so the push path and the page path can never
// disagree about what a page round is -- see buildRoundPushPayload below.
import { isPageRound, roundIsAwaited, roundIsAwaitedOpen, roundWaitLapsed, closeLapsedAwaitedRounds } from './badge.mjs';
import { createPomodoro, readDoc as readPomodoroDoc, roundBannersEnabled } from './pomodoro.mjs';
import { notifyBoundary, notifyTest, notifyRound, withdrawClickChild, CLICK_LIFETIME_MAX_MS } from './notify.mjs';
import { isCue, cuePath } from './cues.mjs';
import { resolveRefRoots } from './resolve.mjs';

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
  const subs = new Map(); // boardId -> Map<watcherId, { res, attended }>
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
      board.set(watcherId, { res, attended: null, seq: -1 });
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
    setAttended(boardId, watcherId, attended, seq = null) {
      const board = subs.get(boardId);
      const watcher = board && board.get(watcherId);
      if (!watcher) return false;
      if (Number.isInteger(seq)) {
        if (seq <= watcher.seq) return false; // an older edge, overtaken in flight
        watcher.seq = seq;
      }
      watcher.attended = !!attended;
      return true;
    },
    /** CONTEXT.md "Attended": true iff ANY Watcher of this board might be looking at
     * it right now. Two tabs on one board count as looking if either one does; a board
     * with no Watchers at all is not Attended, same as one whose every Watcher has
     * REPORTED that it is hidden or unfocused. A Watcher that has not reported yet
     * counts as looking -- "nothing here says the reviewer is away".
     *
     * Nothing in production reads this. It exists for test/check-attended.mjs, which
     * pins the OR-across-Watchers rule directly because nothing over HTTP surfaces it.
     * Deciding whether to RAISE a banner asks `isConfirmedAttended` below instead:
     * "has not said anything yet" is not evidence of a reviewer, and a subscriber that
     * never reports would otherwise be a mute button obtainable with a READ credential. */
    isAttended(boardId) {
      const board = subs.get(boardId);
      if (!board) return false;
      for (const watcher of board.values()) if (watcher.attended !== false) return true;
      return false;
    },
    /** The stricter question, and the one a caller deciding whether the reviewer has
     * COME BACK has to ask: has any Watcher actually SAID it is looking? A freshly
     * subscribed one has not, so this is false through the reconnect and true again a
     * round trip later if the tab really is in front of the reviewer.
     *
     * Collapsing the two is a defect: `isAttended` alone would read a hidden tab's
     * reconnect -- a dropped socket, a laptop wake, a daemon restart -- as the reviewer
     * returning, clearing the announced marker off a board nobody had looked at, and the
     * tab's own "still hidden" report a moment later would announce the same absence a
     * second time (SPEC_STRANDED.md criterion 7). See `createStrandedWatch.evaluate`. */
    isConfirmedAttended(boardId) {
      const board = subs.get(boardId);
      if (!board) return false;
      for (const watcher of board.values()) if (watcher.attended === true) return true;
      return false;
    },
  };
}

/** How long a board has to go without being Attended before the daemon announces that a
 * round on it is Stranded (CONTEXT.md "Stranded"). Fifteen seconds is exactly one
 * DEFAULT_SSE_HEARTBEAT_MS, and that is the whole point of the number: a tab that is
 * going to come back -- an EventSource reconnecting after a daemon restart, a laptop
 * waking, a socket some idle timer dropped -- has already come back by then, so what
 * is left standing after the grace is a reviewer who is genuinely gone (ADR.md entry 55).
 *
 * An environment variable rather than a settings row, exactly like the heartbeat above
 * and the wait cap below: this is a characteristic of the machine, not a preference,
 * and a check has to be able to drive the whole rule without sleeping fifteen real
 * seconds. Zero, negative, empty and unparseable all fall back to the default --
 * `Number('')` is 0 and blanking a plist entry (`<string></string>`) is the ordinary
 * way an operator turns one off, so accepting 0 would turn "I meant to unset this" into
 * a zero grace, i.e. exactly the false positive on a reconnecting tab that entry 55
 * exists to remove. */
export const DEFAULT_STRANDED_GRACE_MS = 15_000;

function strandedGraceMs() {
  const v = Number(process.env.CLAUDE_BOARD_STRANDED_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STRANDED_GRACE_MS;
}

/** Every stranded watch alive in this process, and ONE 'exit' listener serving all of
 * them. Criterion 15's last sentence -- "stopping the daemon leaves none of them
 * running" -- is not free: a click-serving process is a separate, deliberately unref'd
 * process (src/notify.mjs) that would otherwise outlive its owner all the way to its
 * own deadline, which is up to forty minutes of banners for a daemon that is gone.
 * `server.on('close')` in startServer below covers the graceful stop; this covers the
 * abrupt one, since bin/daemon.mjs's shutdown backstop calls `process.exit()` outright
 * when a socket refuses to die, and an 'exit' listener is the last hook that still runs
 * there. SIGKILL is the one case nothing can cover, and there the child's own deadline
 * is what bounds it. */
const liveStrandedWatches = new Set();
let strandedExitHookInstalled = false;
function registerStrandedWatch(watch) {
  liveStrandedWatches.add(watch);
  if (strandedExitHookInstalled) return;
  strandedExitHookInstalled = true;
  process.on('exit', () => {
    for (const w of liveStrandedWatches) w.close();
  });
}

/** The stranded rule (SPEC_STRANDED.md; ADR.md entries 55 and 58), built beside the SSE
 * hub because it is a reader of `sse.isConfirmedAttended` and of nothing else the daemon does not
 * already know. One instance per request handler, like the hub and the handoff store, so
 * two daemons in one process (as the checks spin up) never announce for each other.
 *
 * The rule in one sentence: a board with at least one open, awaited round on it and no
 * Watcher looking at it is Stranded, and after a grace it gets ONE banner -- per board,
 * per absence, not per round. Rounds arrive faster than a reviewer returns, so counting
 * per board is what makes "one per absence" mean anything; the banner's click carries
 * only the board's own URL plus the `#stranded-round` sentinel, which the page resolves
 * to the oldest round still waiting AT THE MOMENT IT IS CLICKED rather than to whichever
 * round happened to trigger this.
 *
 * Four things drive it, and all four are events the daemon already handles: a round
 * landing (`handlePostBoard`), a Watcher arriving or leaving (`handleEvents`), a tab
 * reporting whether it is looked at (`handleAttended`), and a round being answered
 * (`handleSubmit`). There is no polling and no clock of its own beyond the one grace
 * timer per board, because everything else it needs to know is a fact it can read off
 * the board when one of those four happens. That is why an absence ending is decided
 * LAZILY -- see `standingBanner` -- rather than on a timer at `awaitDeadline`: nothing
 * fires when a wait lapses, and a timer built to fire there would be the "notice after
 * it has lapsed" the spec puts out of scope. It is the same absence of an event that
 * makes the click-serving child hold its own deadline as a backstop rather than waiting
 * to be told to stand down (ADR.md entry 57).
 *
 * `notify` and `withdraw` are `notifyRound` and `withdrawClickChild`, and the daemon
 * never passes anything else. They are seams for the checks alone: the PATH-stubbed
 * notifier the suite already uses can see that a banner was raised and what it says, but
 * the click target and the child's lifetime cross on the BUNDLE path only, and
 * `withdrawClickChild` does nothing at all outside a bundle -- so nothing that observes
 * an `osascript` invocation can prove either. `withdraw` in particular guards a SIGTERM
 * that must never reach the launchd job supervising this daemon, which is worth a check
 * that can actually see the decision. Same reasoning that made `createSseHub` worth
 * exporting for test/check-attended.mjs. */
export function createStrandedWatch({
  home = boardHome(),
  sse,
  notify = notifyRound,
  withdraw = withdrawClickChild,
} = {}) {
  // boardId -> { timer, target }: the grace, one per board, holding the click target
  // captured when this board first started looking Stranded. Never replaced by a later
  // evaluate: every target is built from the daemon's own bound socket
  // (`strandedTarget`), so a second one can only ever say the same thing.
  const pending = new Map();
  // boardId -> ChildProcess: the click-serving process this daemon owns for the banner
  // currently on screen for that board. At most one, because there is at most one
  // banner per board.
  const children = new Map();
  // boardId -> record, ONLY for boards whose durable write failed. The board document is
  // the source of truth and a restart is meant to read it back (that is the whole point
  // of recording it there); this is the degraded path, so that a read-only store costs
  // this rule its memory of one absence across a restart rather than a banner per round
  // for as long as the store stays broken. Empty in every healthy install.
  const unpersisted = new Map();

  // readBoard throws on an id that cannot be a path (src/store.mjs's assertSafeId) and
  // on any unreadable file. Neither is a reason for a banner rule to take down the
  // request it is riding on -- `POST /api/board/:id/attended` in particular answers 200
  // for a board id that names nothing -- so every read here degrades to "there is
  // nothing to announce" rather than throwing.
  function boardOf(boardId) {
    try { return readBoard(boardId, home); } catch { return null; }
  }

  /** Every durable write this rule makes, in one place, and every failure swallowed.
   *
   * The callers are a timer callback and an SSE socket's own close handler: by the time
   * either runs, the request handler's try/catch is long gone, so an uncaught throw here
   * is an uncaught exception at the top of the event loop -- and bin/daemon.mjs answers
   * one of those by exiting, taking every blocked `/wait` and every open stream with it.
   * A store that has gone read-only, a full disk, or a single board whose `id` disagrees
   * with its filename must cost this rule its banner and nothing else. */
  function persist(board) {
    try {
      // Re-read, and copy across ONLY this rule's own field. Writing back the whole
      // object the caller is holding would make this rule a participant in every
      // read-modify-write race on the board document rather than in none of them:
      // `drainUndeliveredComments`'s `commit` (see handleWait) captures whole boards and
      // runs from a later macrotask than this timer callback -- two writers each saving
      // their own captured copy is how one of them silently loses the other's write.
      // `commit` now does the same on its own field (ticket 09), so the race is closed
      // in both directions rather than just this one.
      //
      // Today no caller here holds a stale object -- every one of them reads through
      // `boardOf` and writes in the same synchronous turn, with no await between -- so
      // this changes no outcome yet. It is deliberate anyway, and deliberately not
      // "optimised" back: it makes the safety local to this function instead of resting on
      // a property of four call sites that a single later `await` would quietly end.
      const fresh = readBoard(board.id, home);
      if (!fresh) return false; // the board is gone; there is nothing to record on
      fresh[STRANDED_BANNER] = board[STRANDED_BANNER] ?? null;
      writeBoard(fresh, home);
      return true;
    } catch (err) {
      console.error(`claude-board: could not record the stranded banner for board ${board && board.id}: ${(err && err.message) || err}`);
      return false;
    }
  }

  // CONTEXT.md's Stranded is "Awaited while its board is not Attended", so this is the
  // Awaited half, per round: open AND minted awaited. `roundIsAwaitedOpen` (src/badge.mjs)
  // is the same predicate the countdown and the read-only downgrade already read, which
  // is what makes criterion 8 hold with no code of its own -- a round that was never
  // awaited carries `awaited: false`, one already answered is no longer `open`, and one
  // whose wait lapsed was swept back to `awaited: false` by `readBoard` itself.
  function stillWaiting(board) {
    return ((board && board.rounds) || []).filter(roundIsAwaitedOpen);
  }

  /** The record for this board, wherever it is: the board document normally, and the
   * in-memory fallback below only when the durable write failed. The document is the
   * source of truth and a restart is meant to read it back; `unpersisted` exists purely
   * so that a store which has gone read-only costs this rule its memory of one absence
   * rather than turning that absence into a banner per round. */
  function recordOn(board) {
    return (board && board[STRANDED_BANNER]) || unpersisted.get(board && board.id) || null;
  }

  /** The banner recorded on this board, if it still STANDS -- that is, if this board's
   * absence has already been announced and is still running. Exactly one question, asked
   * of exactly one round: is the round this record NAMES still awaited?
   *
   * That is criterion 7 read literally, and the literal reading is the one that was
   * chosen: one banner per board until the reviewer actually comes back. Two nearby
   * readings were rejected, and both are easy to drift back into:
   *
   *  - "is ANYTHING on the board still awaited". Wrong, and wrong in the shape
   *    `handlePostBoard` calls ordinary -- an awaited page round beside a question round.
   *    The named round dying while the second is still live would leave the record
   *    standing forever, and the second round would never get a banner of its own.
   *  - "is the banner still on screen" (`until`, below). Rejected deliberately. It made a
   *    replacement appear once the first banner's process had exited, which is a second
   *    banner for an absence nobody had come back from.
   *
   * THE COST, accepted with the trade-off in view rather than overlooked: a reviewer who
   * dismisses a banner without opening the board gets nothing further for that board until
   * the announced round's wait ends. The signal is one per absence, and dismissing it is
   * spending it.
   *
   * Not a timer. Read lazily off events the daemon already handles; a timer on
   * `awaitDeadline` would be precisely the "notice after the wait has lapsed" the spec
   * puts out of scope. `roundIsAwaitedOpen` is the same predicate `stillWaiting` applies,
   * so "the wait ended" reaches here as a fact `readBoard` already swept. */
  function standingBanner(board) {
    const rec = recordOn(board);
    if (!rec) return null;
    return roundIsAwaitedOpen((board.rounds || []).find(r => r.n === rec.round)) ? rec : null;
  }

  /** Retire the record on this board, and withdraw whatever is still serving it -- either
   * because the reviewer came back, or because the round it named stopped being awaited
   * and there is nothing left for its click to open.
   *
   * WRITE FIRST, WITHDRAW SECOND, and the order is the whole point: the record and the
   * screen have to agree. Withdrawing first and then restoring the record on a write that
   * failed left the banner gone AND the board believing it had one, which suppressed
   * every replacement for the rest of the wait -- the reviewer silently loses the signal
   * on exactly the machine that is already in trouble. So on a store that refuses the
   * write, nothing is withdrawn either: the banner stays up and the record stays standing,
   * which is consistent and recoverable, at the price of a return not withdrawing until
   * the store comes back.
   *
   * Covers the submit-by-secret edge too -- a round answered by a script carrying the
   * local secret leaves no attended Watcher to resolve into a return, so its record is
   * retired here on the next evaluation instead. */
  function spend(board) {
    const rec = recordOn(board);
    const saved = board[STRANDED_BANNER];
    board[STRANDED_BANNER] = null;
    if (!persist(board)) {
      board[STRANDED_BANNER] = saved; // the document goes back exactly as it was
      return;
    }
    unpersisted.delete(board.id);
    terminate(board.id, rec);
  }

  /** Is there something to announce about this board, and may it be announced? Also the
   * one place a spent record is retired, deliberately ahead of the suppression check
   * below -- the other order is what leaves a board deaf. */
  function mayAnnounce(board) {
    if (recordOn(board) && !standingBanner(board)) spend(board);
    // One banner per absence, per board (criterion 7): a further round landing on a board
    // whose announced round is still awaited adds nothing, and neither does a second tab
    // closing, and neither does that banner having expired off the screen. A restart reads
    // the same record off disk and says the same.
    if (recordOn(board)) return false;
    return stillWaiting(board).length > 0; // criterion 8: nothing awaited, nothing stranded
  }

  function cancel(boardId) {
    const entry = pending.get(boardId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(boardId);
  }

  /** Withdraw the banner currently on screen for `boardId`, by killing the process that
   * serves its click. SIGTERM specifically, never SIGKILL: the SIGTERM path in
   * bin/notify.m is what WITHDRAWS the delivered notification from Notification Center,
   * so criterion 6's withdrawal is this kill and not a second mechanism -- a SIGKILLed
   * child leaves its banner sitting there.
   *
   * `rec` is the board's recorded banner, and it is the only thing that can make this
   * signal a pid it did not spawn. A SIGKILLed daemon (`launchctl kickstart -k`, or
   * launchd after `ExitTimeOut`) leaves the record on disk and the `children` map empty,
   * so a replacement daemon would otherwise have no way to withdraw a banner still on
   * screen and criterion 6 would fail for the rest of that wait.
   *
   * `until` is what bounds that, and this is the ONE place it is still consulted: whether
   * the record still SUPPRESSES is a different question with a different answer (see
   * `standingBanner`), but a record whose banner's own process must long since have exited
   * names a pid that has been recycled onto something else, and signalling it would be
   * signalling a stranger. The pid path is therefore gated on the banner plausibly still
   * existing, even though the suppression is not. */
  function terminate(boardId, rec = null) {
    const held = children.get(boardId);
    if (held) {
      children.delete(boardId);
      try { held.child.kill('SIGTERM'); } catch { /* already gone: the outcome we wanted */ }
      return true;
    }
    if (!rec || !rec.pid) return false;
    const until = Date.parse(rec.until);
    if (Number.isFinite(until) && Date.now() >= until) return false; // its process is gone
    // `at` is the second half of what makes the pid safe to signal -- see withdrawClickChild.
    withdraw(rec.pid, Date.parse(rec.at));
    return true;
  }

  /** The reviewer is looking at this board again (criterion 6). Stops the pending
   * banner, withdraws the delivered one, and clears the record so that leaving again MAY
   * raise a fresh one -- which is what makes it mean "this absence has been announced"
   * rather than "this board has been announced once, ever". */
  function returned(boardId) {
    cancel(boardId);
    const board = boardOf(boardId);
    if (!recordOn(board)) {
      // Nothing recorded: no durable write on the ordinary path, which matters because
      // this runs on every `attended` report a tab sends and a page board's document can
      // be megabytes. The in-memory handle is still worth checking.
      terminate(boardId, null);
      return;
    }
    spend(board);
  }

  /** The grace has elapsed. Everything is re-decided here rather than trusted from when
   * the timer was armed: fifteen seconds is long enough for the tab to come back, the
   * round to be answered, or the wait to lapse.
   *
   * Wrapped whole, because this is a timer callback -- see `persist` above for what an
   * uncaught throw out of one costs. `readPomodoroDoc` and `folderName` are as capable
   * of throwing as the write is. */
  function announce(boardId, target) {
    pending.delete(boardId);
    try {
      // Only a Watcher that has SAID it is looking holds the banner back, and the
      // arming rule above is what makes that safe for criterion 4: a countdown is only
      // ever started at a moment when nobody was confirmed, so by the time it fires the
      // board has gone a full grace with nobody saying they are there. A tab that drops
      // and reconnects inside that window reports from its `watcher` handler one round
      // trip later, and THAT is what cancels this -- not the bare fact of a socket.
      //
      // Counting an unreported Watcher here instead was a mute button obtainable with a
      // read credential: `/events` needs no write, and a subscriber that reconnects
      // shortly before each grace expires is never old enough to age out, so no
      // per-Watcher bound could close it. There is nothing to bound now.
      if (sse.isConfirmedAttended(boardId)) return;
      const board = boardOf(boardId);
      if (!board || !mayAnnounce(board)) return;
      // The reviewer's own switch (ticket 03): off means this whole rule is silent, while
      // the pomodoro clock's own banners carry on. Read fresh here, not captured at boot,
      // for the same reason notifyBoundary re-reads on every interval -- a toggle flipped
      // mid-day takes effect on the next banner, not the next restart.
      if (!roundBannersEnabled(readPomodoroDoc(home).settings)) return;
      // The oldest round still waiting is what the click resolves to, so it is also what
      // bounds the child that serves the click, and it is what the record below names.
      // The fragment is `#stranded-round` and NOT `#open-round`: the two look alike and
      // mean different things. `#open-round` resolves to the newest open round, which is
      // right for the index's live-row links; a banner has to land on the OLDEST round
      // still waiting, which is the one the reviewer owes an answer for and the one this
      // banner's lifetime is bounded by (src/ui.mjs's `oldestAwaitedRoundNumber`
      // resolves it, on load and on hashchange/focus/visibilitychange so a tab that was
      // already open moves too).
      const oldest = stillWaiting(board)[0];
      const deadlineAt = Date.parse(oldest.awaitDeadline);
      const child = notify(folderName(board.cwd), {
        url: target && target.url ? `${target.url}#stranded-round` : null,
        // The same one read of the bound socket the URL came from, handed over separately
        // because the launcher checks the two against each other -- see `strandedTarget`.
        port: (target && target.port) || null,
        deadlineAt,
      });
      const at = Date.now();
      // Recorded durably, all four parts together. `round` is the load-bearing one: the
      // absence ends when THAT round stops being awaited. `at` and `pid` are what let a
      // replacement daemon withdraw a banner it did not raise, and `until` -- when the
      // process serving this banner will exit and withdraw it, the same
      // `min(the round's deadline, the launcher's hard ceiling)` src/notify.mjs applies to
      // the lifetime it sends -- is what bounds that pid to a process that can still be
      // the one written down. Recomputed here rather than reported back because it is one
      // expression and a second return value out of `notify` would be a contract change
      // for every caller; if the two ever drift, this side is the conservative one (it can
      // only under-estimate the banner's life, which costs a withdrawal not attempted
      // rather than a stranger signalled). `notify` swallows its own failures and never
      // throws, so this cannot record a banner that never appeared.
      const rec = {
        at: new Date(at).toISOString(),
        round: oldest.n,
        pid: (child && child.pid) || null,
        until: new Date(Number.isFinite(deadlineAt)
          ? Math.min(deadlineAt, at + CLICK_LIFETIME_MAX_MS)
          : at + CLICK_LIFETIME_MAX_MS).toISOString(),
      };
      board[STRANDED_BANNER] = rec;
      // Honoured, not fired and forgotten. A store that has gone read-only would
      // otherwise leave this daemon unable to remember it had announced anything, and
      // every round after this one would raise another banner for the same absence --
      // the exact pile-up the record exists to prevent, arriving precisely when the
      // machine is already in trouble. The board document stays the source of truth and
      // a restart still reads it; this only covers the degraded case.
      if (!persist(board)) unpersisted.set(boardId, rec);
      else unpersisted.delete(boardId);
      if (child) {
        // The round rides with the handle so that `answered` can tell whether a submit is
        // about THIS banner without reading the board back off disk on every submit.
        children.set(boardId, { child, round: oldest.n });
        // The handle is only good while the process is alive. Without this the map keeps
        // a reaped pid forever and `terminate` reports success for a child that exited on
        // its own deadline minutes ago -- and on the osascript fallback, where the child
        // exits in milliseconds, it is stale the moment it is stored.
        child.once('exit', () => {
          const held = children.get(boardId);
          if (held && held.child === child) children.delete(boardId);
        });
      }
    } catch (err) {
      console.error(`claude-board: stranded banner for board ${boardId} failed: ${(err && err.message) || err}`);
    }
  }

  const watch = {
    /** Re-decide one board, from scratch. Called after every event that can change the
     * answer; safe to call for a board that has nothing to do with any of this, which is
     * what lets the call sites stay one line each with no conditions of their own.
     *
     * `target` is `strandedTarget(req, boardId)` -- the board's URL and this daemon's
     * bound port, from the socket rather than from any header, and never a handoff since
     * no credential goes on a command line (criterion 13). Absent, the banner still
     * fires; it just cannot be clicked.
     *
     * Wrapped whole for the same reason `announce` is: one of the call sites is an SSE
     * connection's own close handler, which runs with no request frame around it. */
    evaluate(boardId, target = null) {
      try {
        // A Watcher has SAID it is looking: the reviewer is back. End the absence --
        // withdraw the banner, clear the record -- so that leaving again may raise a
        // fresh one (criterion 6). This is the ONLY thing that ends an absence while its
        // round is still awaited: a Watcher that has merely subscribed has not said
        // anything yet, and a hidden tab reconnecting must not be read as a reviewer
        // returning (criterion 7).
        if (sse.isConfirmedAttended(boardId)) return returned(boardId);
        const board = boardOf(boardId);
        // Nothing to announce -- nothing awaited (criterion 8), or an absence already
        // announced and still standing (criterion 7). Either way a grace still counting
        // down is counting down to nothing, so it goes. `mayAnnounce` also retires a
        // record whose round is over, which is the other way an absence ends.
        if (!board || !mayAnnounce(board)) return cancel(boardId);
        // Already counting down: leave it alone, deadline and target both. Re-arming on
        // every event would let a busy agent, or a tab on a flaky socket that reconnects
        // oftener than the grace is long, hold the countdown open forever and never
        // produce a banner at all. What suppresses a banner for a tab that has just
        // reconnected is `announce`'s own re-check at fire time, not the absence of a
        // timer -- which is exactly where a decision about the present belongs.
        if (pending.has(boardId)) return;
        const entry = { target };
        entry.timer = setTimeout(() => announce(boardId, entry.target), strandedGraceMs());
        // A banner that has not fired yet must never be what keeps a daemon from
        // exiting, exactly like the heartbeat interval above.
        entry.timer.unref?.();
        pending.set(boardId, entry);
      } catch (err) {
        console.error(`claude-board: stranded rule for board ${boardId} failed: ${(err && err.message) || err}`);
      }
    },

    /** THE round this board's banner is about was answered (criterion 15): the process
     * serving that banner has nothing left to serve, so the daemon that owns it kills it.
     * Deliberately NOT a clear of the record -- answering is not the same event as
     * returning, and the `evaluate` the caller makes right after this is what decides
     * everything else.
     *
     * `round` is why this takes an argument at all. Criterion 15 says the child goes when
     * "the round is answered", meaning the round the banner is ABOUT, and a board can hold
     * two awaited rounds at once (ADR.md entry 45: an awaited page round beside a question
     * round). The banner names the oldest. Answering the OTHER one used to withdraw it
     * anyway -- and then `evaluate` found the announced round still awaited, so the record
     * still stood, so nothing could replace what had just been taken off the screen. The
     * reviewer lost the signal for a round still waiting, with the suppression rule itself
     * forbidding a replacement for the rest of its forty minutes.
     *
     * The board is only read when this process has no handle of its own -- an unclean
     * restart, where the orphan's pid on the record is the only way to reach it, and where
     * a submit carrying the local secret produces no Watcher and no attended report to
     * resolve it any other way. In the ordinary case the daemon serving the submit is the
     * one that raised the banner, `handleSubmit` has already read this board, and reading
     * it again to discard the answer would be a second parse of a document that can run to
     * megabytes. `terminate`'s own `until` bound is what keeps signalling a recorded pid
     * safe; being answered says nothing about whether the child has exited, since its
     * lifetime is the round's DEADLINE. */
    answered(boardId, round) {
      const held = children.get(boardId);
      if (held) return held.round === round ? terminate(boardId) : false;
      const rec = recordOn(boardOf(boardId));
      if (!rec || rec.round !== round) return false;
      return terminate(boardId, rec);
    },

    /** Stop owning anything: every pending grace and every click-serving process this
     * daemon spawned goes with it (criterion 15). Idempotent.
     *
     * Deliberately WITHOUT retiring the records those children serve. Killing them does
     * take their banners off the screen -- SIGTERM is how a banner is withdrawn -- and it
     * is tempting to reason that a board with no banner on screen should be announceable
     * again. That is the reading criterion 7 rules out in as many words: further rounds
     * raise nothing more until the reviewer comes back, "whether or not the banner already
     * raised is still on screen". An absence ends two ways and only two, the reviewer
     * returning or the announced round ceasing to be awaited, and a daemon stop is
     * neither. Retiring here meant a reviewer who was told once at t=0 was told again
     * after an ordinary `install.sh` update -- two signals for one absence.
     *
     * Nothing here may skip the kill, either: criterion 15's last sentence is
     * unconditional, and an unref'd child left behind by a shutdown outlives its owner by
     * up to an hour with a banner whose click hands LaunchServices a port that now belongs
     * to nothing. With no write in this path there is nothing that can fail and no
     * temptation to make the kill conditional on it. */
    close() {
      for (const boardId of [...pending.keys()]) cancel(boardId);
      for (const boardId of [...children.keys()]) {
        // The pid goes even though the record stays. Leaving the record standing is the
        // point (see above), but the pid ON it names a process this daemon is about to
        // kill, while `until` goes on claiming that process may live for another hour --
        // and the successor's own launchd supervisor starts AFTER `rec.at`, so the
        // start-time gate that used to exclude a supervisor no longer does. A wrapped pid
        // space then makes that record a loaded gun pointed at the supervisor.
        // `mayWithdrawPid` is the guard that makes this safe; this narrows the window it
        // has to guard. A failed write is harmless here: the old record stands, and
        // standing is what it already meant.
        const board = boardOf(boardId);
        const rec = board && board[STRANDED_BANNER];
        if (rec && rec.pid != null) {
          rec.pid = null;
          persist(board);
        }
        terminate(boardId);
      }
      unpersisted.clear();
      liveStrandedWatches.delete(watch);
    },
  };
  registerStrandedWatch(watch);
  return watch;
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
 * answers gets an explicit `timeout` packet instead of polling the store forever.
 * 40 minutes (ADR.md entry 47), for every round -- awaited page board and question
 * round alike, one clock and one env var rather than a rule per round shape. Must
 * equal src/board.mjs's `DEFAULT_AWAIT_TIMEOUT_MS`, which is what `handlePostBoard`
 * below stamps a round's `awaitDeadline` with; the two used to be `bin/mcp.mjs`'s
 * TIMEOUT_MS and this constant, independently hardcoded at 2h apiece. */
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
 * would make it unreachable from the one place it has to be reachable from — see
 * SPEC_STRANDED.md's Next Steps item 3, which is explicit that skipping this
 * would either 403 every report or, if left ungated entirely, let a forged report
 * from any local process silence every banner on the machine. */
const BOARD_COOKIE_ACTIONS = new Set(['submit', 'attended']);

function isBoardCookieWrite(parts) {
  return parts[0] === 'api' && parts[1] === 'board' && parts.length === 4 && BOARD_COOKIE_ACTIONS.has(parts[3]);
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
 *    pausing an advisory clock that never touches a board, never gates an `ask`, and
 *    never reaches a tool is strictly less than that — `isSameOriginWrite` still stands
 *    in front of it, exactly as it does for submit. The board-scoped fallback token that
 *    used to sit here is deleted rather than kept beside it. `attended` joins the cookie
 *    set on the same footing again, reaching less than either: see
 *    `BOARD_COOKIE_ACTIONS` above.
 *
 * Every non-GET goes through here, rather than an enumerated list of write routes: a
 * route added later is then gated by default instead of by remembering to add it. The
 * two exception lists are `BOARD_COOKIE_ACTIONS` and `POMODORO_COOKIE_ACTIONS` above. */
function isAuthorizedWrite(req, parts, secret) {
  if (!secret) return false; // no secret on disk: refuse writes rather than fall open
  if (secretMatches(req.headers[SECRET_HEADER], secret)) return true;
  if (!isBoardCookieWrite(parts) && !isPomodoroCookieWrite(parts)) return false;
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
 * argument: bin/launcher.c's `is_board_url` compares the two and refuses a URL whose port
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
 * machine. */
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
 * This walks the store, which is why it is only called when the caller actually names
 * a thread: a first post (the overwhelmingly common case, and the one the shim makes)
 * pays nothing. */
function boundCwdForThread(thread, home) {
  const inThread = listBoards(home)
    .filter(b => b && b.thread === thread && b.cwd)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return inThread.length ? inThread[0].cwd : null;
}

async function handlePostBoard(req, res, home, sse, stranded) {
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
      const guarded = board.rounds[board.rounds.length - 1];
      if (body.requestId && board.lastRequestId === body.requestId && guarded && guarded.status === 'open'
        && !roundWaitLapsed(guarded)) {
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
      const latestAsksSomething = !!latestRound
        && questionBlocks(board).some(q => q.round === latestRound.n);
      if (latestRound && latestRound.status === 'open' && latestAsksSomething) {
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
 * "Nobody is listening" means `roundIsAwaited` (src/badge.mjs -- shared with the index
 * badge/tab mark and the arrival notification, see its own comment for the legacy-board
 * fallback), never the round's SHAPE: a round carrying a question always is awaited, and
 * a page board is when the call said `wait` (CONTEXT.md "Awaited", ADR.md entry 45).
 * Keying on shape instead handed an awaited page round's comments back twice -- once in
 * its own packet, through `buildPacket`'s ordinary round-scoped filter, and again here.
 * So a comment is only ever a DRAIN candidate when its own round is NOT awaited;
 * `delivered` is not what decides that, it only guarantees such a comment is handed back
 * exactly once across repeat waits on the thread, including a second wait on a round
 * that already drained it.
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
    const awaitedRounds = new Set((b.rounds || []).filter(r => roundIsAwaited(b, r)).map(r => r.n));
    const pending = (b.comments || []).filter(c =>
      c.delivered !== true
      && !awaitedRounds.has(c.round)
      && (b.id !== board.id || c.round !== round));
    if (!pending.length) continue;
    comments.push(...resolveComments(b, pending));
    pendingByBoard.push({ board: b, pending });
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
      // `STRANDED_BANNER` record onto this same board (its own `persist`, above, already
      // defends that field against this exact writer, by name, in its own comment). This
      // is the reverse direction: without it, this closure's stale whole-board write
      // would silently erase that record, or resurrect one the reviewer had already
      // dismissed.
      //
      // A throw here is an uncaught exception at the top of the event loop -- by the
      // time a `finish` handler runs, the request's own try/catch is long gone, and
      // bin/daemon.mjs answers one of those by exiting, taking every blocked `/wait`
      // with it. So, like `persist`, swallow per board: the comment simply stays
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

async function handleWait(req, res, id, url, home, sse) {
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
    //
    // SPEC_AWAITED.md ticket 03, AC 12: "when a wait dies while the page is
    // open, the page is told over SSE". This IS the moment a wait dies -- the
    // wall clock this same call has been enforcing the whole time just fired
    // -- so the board's own open tab(s) are nudged to repaint right now rather
    // than only ever noticing on their own next periodic check (src/ui.mjs's
    // refreshAwaitDisplay). No payload beyond the round number: everything a
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

async function handleSubmit(req, res, id, home, sse, stranded) {
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
      return sendJson(res, 409, { error: 'this board has already been submitted', board: board.id, round: null });
    }
    return sendJson(res, 400, { error: 'submit requires an integer "round" naming the round being answered', board: board.id, round: openN });
  }
  const claimedRound = openRounds.find(r => r.n === claimed);
  if (!claimedRound) {
    return sendJson(res, 409, {
      error: openN === null
        ? `round ${claimed} is not open: this board has already been submitted`
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
 * would accept a forged report from any local process, silencing every banner on the
 * machine (SPEC_STRANDED.md's Next Steps item 3; ADR.md entry 58).
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
  // The return value is the point: `setAttended` is what knows whether this report names
  // a Watcher this board actually has AND whether it is newer than the one already
  // applied. A report that names none, or that lost a race to a later edge, changed
  // nothing -- so there is nothing to re-decide. Acting on it anyway would let any caller
  // holding a credential drive the stranded rule with a made-up id -- reaching a durable
  // write, and steering the click target with this request's socket -- on a route whose
  // whole answer is otherwise a silent no-op. Still a 200: see `setAttended` for why a tab
  // cannot know it lost that race.
  if (!sse.setAttended(id, body.watcher, body.attended, body.seq ?? null)) return sendJson(res, 200, { ok: true });
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
    // `content-type` succeed rather than 415 — the session-start hook is a
    // one-line shell `curl`, and it must not have to construct or parse anything.
    if (action === 'ensure') return sendPomodoro(res, pomo.ensureTimer());
    if (action === 'pause') return sendPomodoro(res, pomo.pause());
    if (action === 'resume') return sendPomodoro(res, pomo.resume());
    if (action === 'reset') return sendPomodoro(res, pomo.reset());
    // Bodyless like ensure/pause/resume/reset above -- neither control's caller (the
    // pomodoro widget's own two buttons) has anything to say beyond "now", and
    // src/pomodoro.mjs's forwardTimer/restartTimer take only `(doc, now)`.
    if (action === 'forward') return sendPomodoro(res, pomo.forward());
    if (action === 'restart') return sendPomodoro(res, pomo.restart());
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

/** Build the daemon's request handler as a plain `node:http` listener, without
 * binding a port — used directly by the check and by `startServer` below.
 *
 * PER-INSTANCE, and this is the one place that rule is stated: everything the handler
 * owns — the SSE subscriber registry, the stranded watch, the handoff store — is built
 * here rather than at module scope, so two independent daemons in one process (as the
 * checks spin up) never share subscribers, announce for each other's boards, or redeem
 * each other's handoffs. */
export function createRequestHandler({ home = boardHome(), secret: pinnedSecret, pomodoro } = {}) {
  const sse = createSseHub();
  // Built here rather than passed in because it reads THIS handler's hub.
  // `requestHandler.close` below is how startServer hands it its own shutdown --
  // criterion 15's "stopping the daemon leaves none of them running".
  const stranded = createStrandedWatch({ home, sse });
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
        return await handlePostBoard(req, res, home, sse, stranded);
      }

      if (req.method === 'GET' && parts[0] === 'b' && parts.length === 2) {
        return handleGetPage(req, res, parts[1], home);
      }

      if (parts[0] === 'api' && parts[1] === 'board' && parts.length === 4) {
        const boardId = parts[2];
        const action = parts[3];
        if (req.method === 'GET' && action === 'wait') {
          return await handleWait(req, res, boardId, url, home, sse);
        }
        if (req.method === 'GET' && action === 'events') {
          return handleEvents(req, res, boardId, home, sse, stranded);
        }
        if (req.method === 'POST' && action === 'submit') {
          return await handleSubmit(req, res, boardId, home, sse, stranded);
        }
        if (req.method === 'POST' && action === 'attended') {
          return await handleAttended(req, res, boardId, sse, stranded);
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
  const handler = createRequestHandler({ home, secret, pomodoro });
  const server = http.createServer(handler);

  pomodoro.boot();
  // Both closed on 'close' rather than left to their own unrefs: the pomodoro clock so a
  // restart against the same home never runs two live timers over one file, and the
  // stranded watch so that stopping this daemon takes every click-serving process it
  // spawned with it (criterion 15). See createStrandedWatch for the abrupt-exit half.
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
