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
 * `sse.isConfirmedAttended` and nothing else the daemon does not already know.
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
 * (`handleSubmit`) -- all in src/server.mjs. There is no polling and no clock of its own
 * beyond the one grace timer per board, because everything else it needs to know is a fact
 * it can read off the board when one of those four happens. That is why an absence ending
 * is decided LAZILY -- see `standingBanner` -- rather than on a timer at `awaitDeadline`:
 * nothing fires when a wait lapses, and a timer built to fire there would be the "notice
 * after it has lapsed" the spec puts out of scope. It is the same absence of an event that
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
        // exiting, exactly like src/server.mjs's SSE heartbeat interval.
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
