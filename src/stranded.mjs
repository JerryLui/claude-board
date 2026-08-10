// The stranded rule: a board with an open, awaited round and no Watcher looking at it is
// Stranded, and after a grace it gets one banner per absence (SPEC_STRANDED.md; ADR.md
// entries 55 and 58). `createStrandedWatch` is a factory, not a singleton -- call it
// exactly ONCE PER REQUEST HANDLER, the same way src/server.mjs's `createRequestHandler`
// builds a fresh SSE hub and handoff store on every call, so that two daemons sharing one
// process (as the checks spin up) never announce a Stranded absence for each other's
// boards. `createRequestHandler` is this module's only caller in src/; the checks call the
// factory directly too, with the fakes described at `createStrandedWatch` below.

import { readBoard, writeBoard, boardHome } from './store.mjs';
import { STRANDED_BANNER } from './board.mjs';
import { roundIsAwaitedOpen } from './badge.mjs';
import { notifyRound, withdrawClickChild, CLICK_LIFETIME_MAX_MS } from './notify.mjs';
import { readDoc as readPomodoroDoc, roundBannersEnabled } from './pomodoro.mjs';
import { folderName } from './indexpage.mjs';

/** How long a board has to go without being Attended before the daemon announces that a
 * round on it is Stranded (CONTEXT.md "Stranded"). Fifteen seconds is exactly one
 * src/server.mjs `DEFAULT_SSE_HEARTBEAT_MS`, and that is the whole point of the number: a
 * tab that is going to come back -- an EventSource reconnecting after a daemon restart, a
 * laptop waking, a socket some idle timer dropped -- has already come back by then, so what
 * is left standing after the grace is a reviewer who is genuinely gone (ADR.md entry 55).
 *
 * An environment variable rather than a settings row, exactly like src/server.mjs's SSE
 * heartbeat and wait-cap constants: this is a characteristic of the machine, not a
 * preference, and a check has to be able to drive the whole rule without sleeping fifteen
 * real seconds. Zero, negative, empty and unparseable all fall back to the default --
 * `Number('')` is 0 and blanking a plist entry (`<string></string>`) is the ordinary
 * way an operator turns one off, so accepting 0 would turn "I meant to unset this" into
 * a zero grace, i.e. exactly the false positive on a reconnecting tab that entry 55
 * exists to remove. */
export const DEFAULT_STRANDED_GRACE_MS = 15_000;

function strandedGraceMs() {
  const v = Number(process.env.CLAUDE_BOARD_STRANDED_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STRANDED_GRACE_MS;
}

/** node's own `setTimeout` ceiling: the delay is coerced to a signed 32-bit int, and
 * anything above this fires on the next tick with a TimeoutOverflowWarning instead of
 * waiting. `arm` sums two independently-configured knobs, so the sum can reach here even
 * when neither knob alone looks unreasonable -- see that function's own comment. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Every stranded watch alive in this process, and ONE 'exit' listener serving all of
 * them. Criterion 15's last sentence -- "stopping the daemon leaves none of them
 * running" -- is not free: a click-serving process is a separate, deliberately unref'd
 * process (src/notify.mjs) that would otherwise outlive its owner all the way to its
 * own deadline, which is up to an hour of banners for a daemon that is gone -- the bound
 * is src/notify.mjs's `CLICK_LIFETIME_MAX_MS`, not the forty minutes a typical wait runs
 * for, and a longer wait is reachable because CLAUDE_BOARD_TIMEOUT_MS is on the
 * launcher's plist passthrough allowlist.
 * src/server.mjs's `startServer` covers the graceful stop (its `server.on('close')` calls
 * `stranded.close()`); this covers the abrupt one, since bin/daemon.mjs's shutdown backstop
 * calls `process.exit()` outright when a socket refuses to die, and an 'exit' listener is
 * the last hook that still runs there. SIGKILL is the one case nothing can cover, and there
 * the child's own deadline is what bounds it. */
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

/** The stranded rule (SPEC_STRANDED.md; ADR.md entries 55 and 58). Reads
 * `sse.attendedRemainingMs` and nothing else the daemon does not already know. It asked
 * `sse.isConfirmedAttended` until ADR.md entry 73 gave the hub a clock: a boolean cannot
 * say WHEN a board stops being attended, and this rule has to arm a timer for that
 * moment because nothing fires when a look-away window expires.
 *
 * The rule in one sentence: a board with at least one open, awaited round on it and no
 * Watcher looking at it is Stranded, and after a grace the oldest such round that has
 * never been announced gets ONE banner -- once, ever (ADR.md entry 74, narrowing 55).
 * "One per absence" is NOT the rule this implements any more: the mark is per round and
 * permanent, a return withdraws the banner without erasing it, and a board announces a
 * different round only after the reviewer has genuinely come back. The banner's click
 * carries only the board's own URL plus the `#stranded-round` sentinel, which the page
 * resolves to the oldest round still waiting AT THE MOMENT IT IS CLICKED rather than to
 * whichever round happened to trigger this.
 *
 * Five things drive it, and all five are events the daemon already handles: a round
 * landing (`handlePostBoard`), a Watcher arriving or leaving (`handleEvents`), a tab
 * reporting whether it is looked at (`handleAttended`), a round being answered
 * (`handleSubmit`), and a thread's open rounds being abandoned (`handleAbandon`) -- all in
 * src/server.mjs. There is no polling and no clock of its own beyond the one grace timer
 * per board, because everything else it needs to know is a fact it can read off the board
 * when one of those happens. That is why "is this round still waiting" is decided LAZILY
 * -- see `nextToAnnounce` -- rather than on a timer at `awaitDeadline`: nothing fires when
 * a wait lapses, and a timer built to fire there would be the "notice after it has lapsed"
 * the spec puts out of scope. It is the same absence of an event that makes the
 * click-serving child hold its own deadline as a backstop rather than waiting to be told
 * to stand down (ADR.md entry 57).
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
  // Set by `close()`, and never unset: a watch that has been stopped announces nothing,
  // ever again. Not merely tidiness -- `close()` cancels the graces standing at the moment
  // it runs, but a daemon shutting down destroys its open SSE connections, and each one's
  // close handler calls `evaluate` on its way out. Those land in whatever order the event
  // loop gives them, so a disconnect that runs AFTER `close()` used to arm a fresh
  // countdown on a watch whose owner was already gone -- and a stopping daemon with board
  // tabs open is precisely what an `install.sh` update is. The timers are unref'd, so a
  // process that exits promptly never sees the banner; one that lingers, or an in-process
  // daemon (which is every daemon in this suite), does.
  let closed = false;

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

  /** The oldest awaited round on this board that has NEVER been announced, or null.
   *
   * The mark is per round and permanent for the life of that round (ADR.md entry 74), and
   * `rec.round` is where it is kept: the banner always names the oldest never-announced
   * round, so the announced set is exactly "every round up to and including `rec.round`"
   * and one number holds it. The oldest waiting round only ever moves FORWARD -- rounds
   * are appended, and a round that has been answered, abandoned or lapsed never becomes
   * awaited again -- so nothing below the mark can come back needing a banner of its own.
   *
   * `roundIsAwaitedOpen` (via `stillWaiting`) is the same predicate the countdown and the
   * read-only downgrade already read, so "the wait ended" arrives here as a fact
   * `readBoard` has already swept, with no timer of this rule's own. */
  function nextToAnnounce(board) {
    const rec = recordOn(board);
    const mark = (rec && Number.isInteger(rec.round)) ? rec.round : 0;
    return stillWaiting(board).find(r => r.n > mark) || null;
  }

  /** Is there something to announce about this board, and may it be announced?
   *
   * Two gates, and they are different questions (ADR.md entry 74).
   *
   * THE RETURN GATE. A board that has announced anything says nothing further until the
   * reviewer has GENUINELY returned to it -- `rec.returned`, which only `returned()` below
   * ever sets. Further rounds landing behind the announced one earn nothing (criterion 4),
   * and neither does the announced round being answered, abandoned or lapsing while
   * another waits: a round becoming the oldest waiting one is not a reviewer coming back
   * (criterion 6). That last clause is the one this used to get wrong, by retiring the
   * record the moment its round stopped being awaited and treating the next round as a
   * fresh absence.
   *
   * THE PER-ROUND MARK. Even after a return, the round already announced never earns a
   * second banner -- `nextToAnnounce` skips everything at or below the mark (criterion 3).
   * Coming back withdraws the banner from the screen; it does not un-announce the round.
   *
   * THE COST, accepted explicitly rather than overlooked (ADR.md entry 74): a banner
   * missed while the screen was locked is never repeated, and a board whose only awaited
   * round has already been announced is silent for the rest of that round's life. */
  function mayAnnounce(board) {
    const rec = recordOn(board);
    if (rec && !rec.returned) return false;
    return nextToAnnounce(board) != null; // criterion 8: nothing awaited, nothing stranded
  }

  function cancel(boardId) {
    const entry = pending.get(boardId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(boardId);
  }

  /** Arm the one countdown this board gets, replacing whatever was armed before.
   *
   * `windowed` records that this delay is waiting out a look-away window rather than the
   * bare grace, which is what lets `evaluate` shorten it when the tab holding that window
   * goes away -- see its own comment.
   *
   * Clamped to node's own timer ceiling. `setTimeout` coerces its delay to a signed 32-bit
   * int, and a value past that does not throw: node warns and fires on the NEXT TICK. Both
   * knobs feeding this are validated finite and positive but neither is bounded above, and
   * they are summed, so an operator asking for an implausibly long window would otherwise
   * get every board announcing instantly -- the exact inverse of the request. Clamped, an
   * absurd value degrades to "about 25 days", which is at least the same direction.
   *
   * Unref'd: a banner that has not fired yet must never be what keeps a daemon from
   * exiting, exactly like src/server.mjs's SSE heartbeat interval. */
  /** The one place a countdown is started, shared by `evaluate` and `announce`'s
   * re-arm, so the timer ceiling is clamped once and `windowed` is recorded once.
   *
   * The two callers pass deliberately different delays, which is worth stating because
   * it looks like an inconsistency. `evaluate` arms the grace PLUS whatever is left of
   * the look-away window: the grace is the reviewer's chance to come back before
   * anything is said. `announce` re-arms on the bare remainder, no grace, because by
   * then the grace has already been served once -- the window is only holding back a
   * banner that was otherwise about to fire. */
  function arm(boardId, target, delayMs, windowed) {
    cancel(boardId);
    const entry = { target, windowed };
    entry.timer = setTimeout(() => announce(boardId, entry.target), Math.min(delayMs, MAX_TIMEOUT_MS));
    entry.timer.unref?.();
    pending.set(boardId, entry);
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
   * `mayAnnounce`), but a record whose banner's own process must long since have exited
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

  /** The reviewer is looking at this board again. Stops the pending banner, withdraws the
   * delivered one, and OPENS THE RETURN GATE -- without erasing the mark (ADR.md entry
   * 74). A return takes the banner off the screen and buys the board the right to announce
   * a round it has never announced; it does not buy the announced round a second banner.
   *
   * That distinction is the whole fix. The record used to be deleted here, so any report
   * that a tab was attended -- a glance at the board, or the banner's own click bringing
   * the tab forward -- reset the budget and the same round was announced again one grace
   * later, measured at roughly one banner a minute for one round.
   *
   * WRITE FIRST, WITHDRAW SECOND, and the order is the whole point: the record and the
   * screen have to agree. Withdrawing first and then restoring the record on a write that
   * failed left the banner gone AND the board believing nobody had come back, which
   * suppressed everything for the rest of the wait -- the reviewer silently loses the
   * signal on exactly the machine that is already in trouble. So on a store that refuses
   * the write, nothing is withdrawn either: the banner stays up and the gate stays shut,
   * which is consistent and recoverable.
   *
   * The pid is cleared along with the gate, because there is no banner left for it to
   * name and `until` would go on claiming that process may live for another hour.
   *
   * A record whose gate is already open takes no write at all, which matters because this
   * runs on every `attended` report a tab sends and a page board's document can be
   * megabytes. */
  function returned(boardId) {
    cancel(boardId);
    const board = boardOf(boardId);
    const rec = recordOn(board);
    if (!rec || rec.returned) {
      // Nothing to record. The in-memory handle is still worth checking: a banner raised
      // and then returned from inside one evaluate still has a child to kill.
      terminate(boardId, null);
      return;
    }
    // Copied before anything below can clear the pid off it: this is what `terminate`
    // reaches a banner by when this daemon has no child handle of its own.
    const withdrawable = { ...rec };
    const saved = board[STRANDED_BANNER];
    if (saved) {
      board[STRANDED_BANNER] = { ...saved, returned: true, pid: null };
      if (!persist(board)) {
        board[STRANDED_BANNER] = saved; // the document goes back exactly as it was
        return;
      }
    }
    // The degraded path: a record this daemon could not write is held in memory, so the
    // gate opens there instead. Mutated rather than replaced -- `recordOn` handed back
    // this very object.
    const held = unpersisted.get(boardId);
    if (held) { held.returned = true; held.pid = null; }
    terminate(boardId, withdrawable);
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
      //
      // WHY THIS ASKS FOR MILLISECONDS AND NOT A BOOLEAN. Returning here without re-arming
      // was safe while "attended" meant "a tab said it is looking": a later blur was a DOM
      // edge, and the edge was guaranteed to bring an event that armed a fresh countdown.
      // It is not safe now that the same answer can be true purely because a look-away
      // window is still running, because NO EVENT FIRES WHEN A WINDOW EXPIRES. Dropping
      // the countdown there loses the round for good -- reachable on the ordinary
      // `install.sh` update, where `handleEvents` arms the bare grace at subscribe and the
      // page's `sinceFocusMs` seeds a longer window one round trip later: the grace fires
      // first, finds the window, and the window then expires against nothing at all. That
      // is a permanent false negative, and ADR.md entry 74 accepts a missed banner never
      // being repeated, not a round that is never announced.
      //
      // `Infinity` is the one case that may still return with nothing armed: a tab that is
      // focused RIGHT NOW must produce a blur, a close or an answer eventually, and each of
      // those is an event.
      const attendedFor = sse.attendedRemainingMs(boardId);
      if (attendedFor === Infinity) return;
      if (attendedFor > 0) return arm(boardId, target, attendedFor, true);
      const board = boardOf(boardId);
      if (!board || !mayAnnounce(board)) return;
      // The reviewer's own switch (ticket 03): off means this whole rule is silent, while
      // the pomodoro clock's own banners carry on. Read fresh here, not captured at boot,
      // for the same reason notifyBoundary re-reads on every interval -- a toggle flipped
      // mid-day takes effect on the next banner, not the next restart.
      if (!roundBannersEnabled(readPomodoroDoc(home).settings)) return;
      // The oldest round still waiting that has never been announced (ADR.md entry 74):
      // what this banner is ABOUT, what the record below names, and what bounds the child
      // that serves the click. In the ordinary case it is simply the oldest waiting round;
      // it differs only after a return, where an older round has already had its one
      // banner and may never have another.
      //
      // The click itself still resolves to the oldest round waiting AT THE MOMENT IT IS
      // CLICKED, which is the round the reviewer owes an answer for -- the banner carries
      // only the board's URL and a sentinel, never a round number (ADR.md entry 55).
      // The fragment is `#stranded-round` and NOT `#open-round`: the two look alike and
      // mean different things. `#open-round` resolves to the newest open round, which is
      // right for the index's live-row links; a banner has to land on the OLDEST round
      // still waiting, which is the one the reviewer owes an answer for and the one this
      // banner's lifetime is bounded by (src/ui.mjs's `oldestAwaitedRoundNumber`
      // resolves it, on load and on hashchange/focus/visibilitychange so a tab that was
      // already open moves too).
      const oldest = nextToAnnounce(board);
      const deadlineAt = Date.parse(oldest.awaitDeadline);
      const child = notify(folderName(board.cwd), {
        url: target && target.url ? `${target.url}#stranded-round` : null,
        // The same one read of the bound socket the URL came from, handed over separately
        // because the launcher checks the two against each other -- see `strandedTarget`.
        port: (target && target.port) || null,
        deadlineAt,
      });
      const at = Date.now();
      // Recorded durably, all five parts together. `round` is the load-bearing one: it is
      // the MARK, permanent for the life of that round, and `returned` beside it is the
      // gate -- shut from the moment a banner is raised until the reviewer comes back
      // (ADR.md entry 74). A record read off disk by a successor daemon that predates this
      // field carries no `returned`, which reads as a shut gate: conservative, and the
      // side that costs a banner rather than repeating one. `at` and `pid` are what let a
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
        returned: false,
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
        // A stopped watch decides nothing. See `closed` above for the ordering this
        // closes: the call sites include an SSE connection's own close handler, and a
        // daemon shutdown destroys those connections after `close()` has already run.
        if (closed) return;
        // A tab is focused RIGHT NOW: the reviewer is here. Withdraw the banner and open
        // the return gate, WITHOUT erasing the mark, so that leaving again may raise a
        // banner for a round that has never had one and never for the round that has
        // (ADR.md entry 74). This is the ONLY thing that opens that gate: a Watcher that
        // has merely subscribed has not said anything yet, a hidden tab reconnecting must
        // not be read as a reviewer returning (criterion 7) -- and neither is a tab that
        // is merely inside its look-away window, which says the reviewer is AROUND, not
        // that they have looked at this board.
        const attendedFor = sse.attendedRemainingMs(boardId);
        if (attendedFor === Infinity) return returned(boardId);
        const board = boardOf(boardId);
        // Nothing to announce -- nothing awaited (criterion 8), a return gate still shut,
        // or every waiting round already marked. Either way a grace still counting down is
        // counting down to nothing, so it goes.
        if (!board || !mayAnnounce(board)) return cancel(boardId);
        // Already counting down: leave it alone, deadline and target both. Re-arming on
        // every event would let a busy agent, or a tab on a flaky socket that reconnects
        // oftener than the grace is long, hold the countdown open forever and never
        // produce a banner at all. What suppresses a banner for a tab that has just
        // reconnected is `announce`'s own re-check at fire time, not the absence of a
        // timer -- which is exactly where a decision about the present belongs.
        //
        // The ONE exception is a countdown armed past a look-away window whose tab has
        // since gone: that timer is waiting out a window belonging to a tab nobody has
        // open any more, so it is re-armed on the plain grace instead. Narrowly gated on
        // the board having no attended time left at all, so it cannot become the general
        // re-arm the paragraph above rules out.
        const armed = pending.get(boardId);
        if (armed && !(attendedFor === 0 && armed.windowed)) return;
        // The grace, plus whatever is left of the look-away window on the tab that last
        // had focus (ADR.md entry 73), so the countdown cannot finish while the board is
        // still Attended. `announce` re-decides on arrival and re-arms on whatever window
        // is left, so overshooting costs nothing; undershooting costs a wasted wake-up.
        arm(boardId, target, strandedGraceMs() + attendedFor, attendedFor > 0);
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
     * forbidding a replacement for the rest of that round's wait.
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

    /** Every open round on this board has been abandoned (ADR.md entry 69): the reviewer
     * ran `/clear`, the shim called `ask(fresh: true)`, and nothing on this board is
     * awaited any more. The banner standing for it names a round that no longer wants an
     * answer, and clicking it would land the reviewer on a board with nothing to do -- for
     * up to `min(the round's deadline, CLICK_LIFETIME_MAX_MS)`, which is tens of minutes.
     * So the child goes and the pid comes off the record.
     *
     * ITS OWN ENTRY POINT rather than something `evaluate` infers, and deliberately not a
     * clear of the record: abandoning is not returning. The mark stays and the gate stays
     * exactly as it was, so a fresh board's first round still earns its own banner while
     * this board's announced round never earns a second (ADR.md entry 74). Before the mark
     * was permanent this fell out of `mayAnnounce` spending a record whose round had
     * stopped being awaited; that spend is gone, and this is what replaces it -- the
     * withdrawal half, without the re-announcement half that came with it.
     *
     * The write is best-effort and the kill is not conditional on it: a store that refuses
     * the write leaves a stale pid on a record whose `until` still bounds it, which
     * `terminate`'s own guard already handles, while a banner left on screen for an
     * abandoned round is the thing this exists to prevent. */
    abandoned(boardId) {
      cancel(boardId);
      const board = boardOf(boardId);
      const rec = recordOn(board);
      terminate(boardId, rec);
      if (!rec || rec.pid == null) return;
      if (board && board[STRANDED_BANNER]) {
        board[STRANDED_BANNER] = { ...board[STRANDED_BANNER], pid: null };
        persist(board);
      }
      const held = unpersisted.get(boardId);
      if (held) held.pid = null;
    },

    /** Stop owning anything: every pending grace and every click-serving process this
     * daemon spawned goes with it (criterion 15). Idempotent.
     *
     * Deliberately WITHOUT retiring the records those children serve. Killing them does
     * take their banners off the screen -- SIGTERM is how a banner is withdrawn -- and it
     * is tempting to reason that a board with no banner on screen should be announceable
     * again. That is the reading ADR.md entry 74 rules out in as many words: further
     * rounds raise nothing more until the reviewer comes back, whether or not the banner
     * already raised is still on screen. The return gate opens ONE way, the reviewer
     * genuinely returning, and a daemon stop is not that. Retiring here meant a reviewer
     * who was told once at t=0 was told again after an ordinary `install.sh` update.
     *
     * Nothing here may skip the kill, either: criterion 15's last sentence is
     * unconditional, and an unref'd child left behind by a shutdown outlives its owner by
     * up to an hour with a banner whose click hands LaunchServices a port that now belongs
     * to nothing. With no write in this path there is nothing that can fail and no
     * temptation to make the kill conditional on it. */
    close() {
      closed = true;
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
