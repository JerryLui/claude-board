// The daemon's global pomodoro clock. See ADR.md entry 8 ("The daemon owns the
// pomodoro clock, unlike every other preference") — this file is that decision made
// real. One JSON document, `$CLAUDE_BOARD_HOME/pomodoro.json`, holds both the timer
// state and its settings, written with the same atomic temp-file+fsync+rename
// discipline and the same 0600/0700 modes as src/store.mjs (mirrored here rather than
// imported: store.mjs's atomicWrite is module-private, and this document is not a
// board).
//
// The document stores the interval's absolute wall DEADLINE, not remaining seconds.
// That is what makes a daemon restart invisible (read the deadline back, it is still
// correct) and what makes "the machine was asleep" expressible at all: `setTimeout`
// does not fire during sleep, and is not re-armed across a process restart, so the
// only trustworthy question on wake or boot is "what wall-clock time is it now versus
// the deadline I already wrote down" — never "did my timer fire on time".
//
// The whole boundary-crossing rule lives in one pure function, settleBoundary(doc,
// now), so it is testable with no real clock and no daemon (test/check-pomodoro.mjs).
// Everything else in this file is a thin, impure shell around it: read the file, call
// the pure function, write the file, arm a real setTimeout for the next deadline.
//
// A second boundary sits above that one and outranks it: the pomodoro day (05:00 local
// to 05:00 local, ADR 67), whose crossing ends the loop outright rather than advancing
// it — see rollDay below. It is noticed LAZILY, by whatever next touches the document,
// reads included, so there is no scheduled job and no second clock to keep in step with
// this one. The price is that a rollover is invisible until something looks.
//
// This module is advisory only. It never touches an agent's request, never gates or
// delays `ask`, and knows nothing about boards. The one caller outside this file is
// src/server.mjs's startServer, which boots the clock and closes it on server close.

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { boardHome } from './store.mjs';
import { isCue, pickCue, NO_CUE, SOUNDS_DIRS } from './cues.mjs';

// ---------------------------------------------------------------------------------
// Settings, defaults, and the document shape (a contract other tickets build against;
// do not change field names without checking who reads them).
// ---------------------------------------------------------------------------------

// The three per-phase cue defaults go through pickCue (src/cues.mjs) rather than
// being spelled as literals, so a machine missing one of these three preferred sounds
// degrades to `None` for that phase instead of shipping a default the validator would
// refuse on the very next save (see pickCue's own comment). cueNames() reads
// src/cues.mjs's SOUNDS_DIRS and caches briefly, so this object is computed once, at
// module load, and frozen -- never re-derived per read. The freeze is what makes these
// three defaults immune to cueNames() re-reading later: a sound a reader deletes after
// startup leaves the default naming it, which mergeSettings below then refuses on the
// next save, the same way it refuses any other name that is no longer a cue.
export const DEFAULT_SETTINGS = Object.freeze({
  // The Master switch ("Pomodoro made optional behind one Master switch"): off by
  // default (ADR 105) -- the timer is an opt-in extra, and a fresh install renders
  // no pomodoro anywhere until the settings panel switches it on. A settings document
  // missing the key reads as off too, same as a fresh install (TOGGLE_KEYS' own
  // coercion below is what turns a missing or hand-mangled value into this default
  // rather than `undefined`). Off is the daemon's own durable state, not a substitute
  // for `CLAUDE_BOARD_NO_POMODORO` (ADR 68), which stays the per-SESSION suppressor a
  // hook checks before it ever asks -- this key is what the session-start hook's
  // `ensure` is safe against without the hook itself changing (see startWork's own
  // guard below). Flipping it off clears whatever Timer and Cycle were live,
  // Rollover-style (ADR 67 semantics, mergeSettings below); flipping it back on
  // starts idle and restores nothing (ADR 90: an absent timer names the state and
  // nothing else).
  enabled: false,
  workMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  notify: true,
  // Banner level -- the four-step gate on a Stranded round's own banner (ADR.md entry
  // 58; CONTEXT.md's Banner; ADR 106), independent of `notify` above -- that one gates
  // pomodoro boundary banners alone, this one gates a Stranded round's banner alone,
  // and each can be silenced without touching the other. `'this-board'` is the default
  // -- byte-for-byte the retired `notifyRounds: true` checkbox's own behavior -- so a
  // fresh install and a machine that never opens settings both land here. Replaces the
  // binary `notifyRounds` checkbox: normalizeDoc below migrates an existing document's
  // `notifyRounds` (true/absent -> this default, false -> `'off'`) the first time it is
  // read, and `notifyRounds` itself never survives into the settings this function's
  // caller sees. See BANNER_LEVELS/bannerLevel below for the closed set and the read
  // side src/stranded.mjs consults.
  bannerLevel: 'this-board',
  // The macOS status item's two preferences (the item is a second process of the same
  // bundle, ADR 72). They live in the DAEMON's document rather than
  // in the item's own defaults for the same reason every other preference here does: the
  // item owns no state at all -- it reads GET /api/pomodoro and drives the routes the
  // index widget already drives -- so a preference kept on its side would be a second
  // store, invisible to the settings panel that is the only place either of these is
  // edited. That is also what makes "hiding the item survives a logout, and the settings
  // panel brings it back" a property of this file and not of the item: an item that has
  // hidden itself cannot offer a control to unhide.
  //
  // Two booleans and not one tri-state: a reader who hides the item keeps whichever
  // countdown preference they had for when they bring it back. What lands in THIS file is
  // only the storage, the validation and the round trip through the HTTP surface -- the
  // two readers are bin/menubar.m, which polls them, and the settings panel
  // (src/pomodoro-widget.mjs, filled by src/indexpage.mjs), which writes them.
  //
  // `menubarCountdown` -- does the item show the remaining time as text beside its icon.
  // On by default: the digits are most of why the item exists, and the icon's depleting
  // arc is what makes turning them off survivable rather than gutting.
  menubarCountdown: true,
  // `menubarHidden` -- has the reader hidden the item from the index page's pomodoro
  // settings, which is the only surface that writes this (ADR 85's neighbour decision: the
  // popover carries no hide row, that row having been a one-way door out of the surface you
  // would use to undo it). Off by default for the obvious reason, and a stale document with
  // no key at all reads as off (normalizeDoc below), so an upgrade never starts out with a
  // missing status item.
  menubarHidden: false,
  // Three DIFFERENT cues -- one per phase, so the reader tells
  // work/short-break/long-break apart by ear without looking at the screen.
  cueWork: pickCue('Hero'),
  cueBreak: pickCue('Purr'),
  cueLongBreak: pickCue('Submarine'),
});

/** The closed set of Banner levels, in strictly monotone order (Off, quietest On,
 * today's-default On, loudest On) -- a settings key `bannerLevel` may take on, both on
 * disk and in a settings patch. src/stranded.mjs's `announce` switches on these exact
 * four strings; do not rename or reorder them without checking who reads them. */
export const BANNER_LEVELS = ['off', 'no-board', 'this-board', 'always'];

/** The level a round's Stranded path (src/stranded.mjs's `announce`) reads before
 * raising a Banner for a round -- as opposed to `settings.notify`, which gates a
 * pomodoro boundary's banner and nothing else (ADR.md entry 58; criterion 17:
 * independent of the pomodoro control in both directions). Takes a settings object
 * (typically `readDoc(home).settings`) rather than a whole doc, matching how
 * notify.mjs's own notifyBoundary is called.
 *
 * Handles every shape a caller might hand it: no settings object at all, an already-
 * normalized document's valid `bannerLevel`, a hand-mangled or unrecognized value (falls
 * back to the default, same "invalid reads as default" coercion every other setting in
 * this file gets), and -- the migration seam -- a document that predates `bannerLevel`
 * entirely and carries only the retired `notifyRounds` boolean: `true`/absent maps to
 * the same default `bannerLevel` would have, `false` maps to `'off'`, so a machine
 * upgraded from the checkbox changes no behavior the instant this ships. */
export function bannerLevel(settings) {
  if (!settings) return DEFAULT_SETTINGS.bannerLevel;
  if (BANNER_LEVELS.includes(settings.bannerLevel)) return settings.bannerLevel;
  return settings.notifyRounds === false ? 'off' : DEFAULT_SETTINGS.bannerLevel;
}

/** How late a deadline is allowed to run before the interval counts as EXPIRED rather
 * than merely late. Below this, `settleBoundary` advances the loop as if it ran on
 * time; above it, the timer is discarded with no advance and no notification.
 * 30s covers a `setTimeout`'s own ordinary slack (event loop backlog,
 * a heavy GC pause) without covering anything that looks like real sleep — a laptop
 * lid closing is minutes to hours late, never single-digit seconds. */
export const EXPIRY_GRACE_MS = 30_000;

/** The EXPIRED test itself, in ONE place, so every control that can be pressed against an
 * interval whose deadline has already gone past reaches the same verdict settleBoundary
 * would. A running timer (never a paused one — a paused timer has no wall-clock deadline
 * to be late for) whose deadline is more than the grace in the past belongs to an interval
 * nobody was there for. */
function isExpired(timer, now) {
  if (!timer || timer.paused) return false;
  return typeof timer.deadline === 'number' && now - timer.deadline > EXPIRY_GRACE_MS;
}

export function defaultDoc() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    cycle: 0,
    // The pomodoro day this document belongs to, as a YYYY-MM-DD label (pomodoroDay
    // below) -- NOT the calendar date it was last written on, which is the same string
    // for every hour of the day except the ones before 05:00. Field name kept from when
    // it was the latter: it is part of the document's shape on disk and in
    // GET /api/pomodoro, and renaming it would silently un-stamp every existing
    // document (i.e. cost every reader one rollover) to say the same thing.
    //
    // null rather than "today": rollDay below treats absent/mismatched cycleDate
    // identically (not this day), so a fresh document and a stale one from yesterday
    // take the exact same reset path with no special-cased default to keep in sync
    // with it.
    cycleDate: null,
    timer: null,
  };
}

// ---------------------------------------------------------------------------------
// Pure logic. No fs, no Date.now(), no setTimeout — every function here takes `now`
// as an epoch-ms argument so the checks can drive it with any clock they like.
// ---------------------------------------------------------------------------------

/** YYYY-MM-DD in LOCAL time (not UTC — a reader west of Greenwich would otherwise
 * have their cycle reset hours before their own midnight). Plain `getFullYear` /
 * `getMonth` / `getDate` are local-time accessors on `Date`; the UTC variants are a
 * different method name entirely, so this is not a rounding trap so much as a
 * "picked the wrong function" trap — spelled out because that mistake is silent
 * (both return a plausible-looking date, just the wrong one some of the year). */
export function localDateStr(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** mm:ss, floor-free (rounds to the nearest second so a countdown does not visibly
 * skip a second right after it starts). Exported so the index page's widget (a later
 * ticket) formats the exact same way the checks pin here, rather than growing a
 * second implementation that can drift from this one. Negative/expired input clamps
 * to 00:00 rather than printing a minus sign — nothing that reaches this function is
 * meant to describe a timer that is already gone; settleBoundary is what decides that. */
export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** The hour the pomodoro day turns over, local time (ADR 67). A constant, deliberately
 * not a setting: this is the one fact every reader of the document has to agree on, and
 * a value that can change under an already-stamped `cycleDate` turns "does this timer
 * belong to the current day" into a question with two answers. 05:00 is late enough
 * that a session running past midnight still belongs to the day it started on, and
 * early enough that nobody's morning starts before it. */
export const DAY_START_HOUR = 5;

/** Which pomodoro day `now` falls in, as the same YYYY-MM-DD label localDateStr
 * produces — the day's own date, so an interval running at 01:00 is stamped with
 * yesterday's date, because it belongs to yesterday.
 *
 * Written as a comparison on the LOCAL hour rather than by subtracting five hours of
 * epoch milliseconds. The two agree on every ordinary day and disagree on the two DST
 * days a year, where subtracting real time puts the edge an hour either side of the
 * 05:00 the reader actually sees on their own clock. `setDate` handles the month and
 * year underflow for us (the 1st rolls back to the last day of the previous month). */
export function pomodoroDay(now) {
  const d = new Date(now);
  if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return localDateStr(d.getTime());
}

/** The rollover, and the ONLY staleness rule the timer has (ADR 67): a document whose
 * stored `cycleDate` names a pomodoro day other than the one `now` falls in belongs to
 * a day that has already ended, and a day ending takes the whole loop with it —
 * `timer: null` AND `cycle: 0`, the same clearing the reset control already performs
 * rather than a fourth kind of clearing. Nothing else ages: a timer paused at 09:00 and
 * resumed at 16:00 the same day resumes with its remainder intact.
 *
 * Cheap, total, and by reference when the day matches, so it is called at the top of
 * everything that touches the document — reads included (readDoc below). That is what
 * makes the boundary observable with no scheduled job behind it: whatever looks next is
 * what notices, and nothing has to run while the machine is asleep.
 *
 * An absent `cycleDate` reads as stale, exactly like a mismatched one (see defaultDoc).
 * The only document that shape describes in practice is one written before this rule
 * existed, so the upgrade costs at most whichever interval was running at the time. */
export function rollDay(doc, now) {
  const today = pomodoroDay(now);
  if (doc.cycleDate === today) return doc;
  return { ...doc, cycle: 0, cycleDate: today, timer: null };
}

/** The "ensure" half (what the session-start hook calls through the impure ensureTimer
 * below). Starts a fresh work interval ONLY when there is no timer at all: a running
 * timer, a paused timer, and a timer mid-break are every one of them left untouched,
 * which is what stops a start during a break from cutting the break short.
 *
 * The rollover runs FIRST, which is what makes the morning's first session one call
 * rather than two: the timer this function declines to touch has to be a timer from the
 * current pomodoro day, so a session start against a document left over from yesterday
 * ends yesterday's loop and starts today's work interval together. Reversing the two
 * lines is the old defect exactly — a timer paused last night that every session start
 * politely declines to disturb.
 *
 * A no-op, same shape, when `settings.enabled` is `false`: the Master switch's whole
 * point is that a timer start is REFUSED while off, and this is the one place a fresh
 * work interval is ever minted, so this is the one guard that has to exist for that to
 * be true daemon-wide -- the session-start hook's `ensure` (createPomodoro.ensureTimer
 * below) reaches no further than this function, and every other control
 * (pause/resume/reset/forward/restart) only ever transforms a timer that already
 * exists, never mints one, so none of them need their own copy of this check. */
export function startWork(doc, now) {
  const base = rollDay(doc, now);
  if (base.timer) return base;
  if (base.settings.enabled === false) return base;
  return { ...base, timer: { phase: 'work', deadline: now + base.settings.workMin * 60_000, paused: false } };
}

/** The cycle arithmetic a phase ending performs, whether that ending is a real deadline
 * (settleBoundary below) or a Forward click landed against a paused timer (forwardTimer
 * further down, which cannot route through settleBoundary at all — see its own
 * comment). One function so the two callers can never compute a different next phase
 * for the same (phase, cycle) pair: a work interval ending begins break number `cycle +
 * 1` (long iff that number is a multiple of `longEvery`); a break or long break ending
 * begins the next work interval and increments `cycle`, resetting it to 0 if the break
 * that just ended was the long one. */
function advancePhase(finishedPhase, cycle, settings) {
  if (finishedPhase === 'work') {
    const breakNumber = cycle + 1;
    return { nextPhase: breakNumber % settings.longEvery === 0 ? 'longBreak' : 'break', nextCycle: cycle };
  }
  return { nextPhase: 'work', nextCycle: finishedPhase === 'longBreak' ? 0 : cycle + 1 };
}

/** The duration, in minutes, a fresh interval of `phase` runs for. Shared by
 * settleBoundary, forwardTimer and restartTimer below so "how long is a phase" is
 * answered in exactly one place. */
function phaseDurationMin(phase, settings) {
  return phase === 'work' ? settings.workMin : phase === 'longBreak' ? settings.longBreakMin : settings.breakMin;
}

/** The loop's one boundary-crossing rule, and the seam a notification hangs
 * off: this function only REPORTS that a boundary occurred
 * ({ phase }); it fires nothing itself.
 *
 * `now < doc.timer.deadline` is the overwhelmingly common case (called on every real
 * setTimeout firing exactly at its own deadline, and at boot against a timer that
 * hasn't expired yet) and returns doc unchanged, by reference — callers use that to
 * skip a needless write.
 *
 * Otherwise the deadline has passed, by `late = now - deadline`:
 *  - `late > EXPIRY_GRACE_MS`: EXPIRED. The interval is discarded (`timer: null`),
 *    with no advance and no boundary reported — nothing schedules a notification for
 *    a break that was already over before anyone could take it. `cycle`/`cycleDate`
 *    are untouched: a lunch break must not cost the two pomodoros already completed
 *    today.
 *  - otherwise: advance. A `work` interval ending begins break number `cycle + 1`
 *    (long iff that number is a multiple of `longEvery`); a `break` or `longBreak`
 *    ending begins the next `work` interval, and increments `cycle` — resetting it to
 *    0 if the break that just ended was the long one. No input at either boundary. */
export function settleBoundary(doc, now) {
  // The rollover outranks every rule below: a pomodoro day that has ended ends the
  // loop, so there is no next phase to advance into and nothing to notify about — an
  // interval that was still running at 05:00 is gone, not promoted to a break nobody
  // is awake for. Checked BEFORE the paused and not-yet-due guards on purpose: both of
  // those hand the document straight back, and a paused timer (which never expires, and
  // so never reaches the rule below) would otherwise stay paused forever.
  const rolled = rollDay(doc, now);
  if (rolled !== doc) return { doc: rolled, boundary: null };

  if (!doc.timer || doc.timer.paused) return { doc, boundary: null };
  if (now < doc.timer.deadline) return { doc, boundary: null };

  if (isExpired(doc.timer, now)) {
    return { doc: { ...doc, timer: null }, boundary: null };
  }

  const { nextPhase, nextCycle } = advancePhase(doc.timer.phase, doc.cycle, doc.settings);
  const durationMin = phaseDurationMin(nextPhase, doc.settings);

  const nextDoc = { ...doc, cycle: nextCycle, timer: { phase: nextPhase, deadline: now + durationMin * 60_000, paused: false } };
  return { doc: nextDoc, boundary: { phase: nextPhase } };
}

/** Forward.
 * No-op — returns `doc` UNCHANGED, by reference — against no timer at all: idle has no
 * interval to end early, and inventing one here would be `startWork`'s
 * job, not this one's.
 *
 * A RUNNING timer reuses `settleBoundary` itself rather than re-deriving its cycle
 * bookkeeping: it forges a doc whose timer already looks like it hit its deadline
 * exactly now — `deadline: now`, so `late === 0`, comfortably inside EXPIRY_GRACE_MS (a
 * forward is never the EXPIRED path; that path is what happens when nobody was there to
 * press anything). `settleBoundary` then computes the exact same next phase and cycle
 * arithmetic a natural boundary would have: a forwarded work interval still earns its
 * break, a forwarded break still increments the cycle, a forwarded long break still
 * resets it. The forge spreads `...doc.timer`, which drags along nothing extra here — a
 * running timer's shape carries no `remainingMs` to begin with, and the timer object
 * settleBoundary builds is a fresh one that never spreads the old one either way.
 *
 * A PAUSED timer cannot take that shortcut (ADR 82). `settleBoundary` assumes a running
 * timer it can hand a just-expired deadline to — a paused timer carries `remainingMs`
 * rather than a `deadline`, and settleBoundary's own guard (`doc.timer.paused`) hands a
 * paused doc straight back rather than advancing it. This function used to force
 * `paused: false` into the forge to dodge that guard, which both advanced the phase AND
 * left it running — pause was a state Forward could silently end. ADR 82 reverses that:
 * pause is left only by the control that owns it, so a paused timer instead re-mints the
 * next phase's remaining time directly, sharing `advancePhase`/`phaseDurationMin` with
 * settleBoundary so the two paths can never compute a different next phase for the same
 * (phase, cycle), and lands paused, carrying that phase's FULL duration in `remainingMs`
 * rather than a `deadline`.
 *
 * The `boundary` half of settleBoundary's return is deliberately discarded on the running
 * path: that value is what this file's own reconcile() feeds to `onBoundary` (the
 * notification seam), and forward's caller (createPomodoro.forward below) never sees it,
 * which is what makes "no notification, no cue" true by construction rather than by a
 * caller remembering to suppress it. The paused path has no boundary to discard — it
 * never calls settleBoundary at all. */
export function forwardTimer(doc, now) {
  if (!doc.timer) return doc;
  if (doc.timer.paused) {
    const { nextPhase, nextCycle } = advancePhase(doc.timer.phase, doc.cycle, doc.settings);
    const remainingMs = phaseDurationMin(nextPhase, doc.settings) * 60_000;
    return { ...doc, cycle: nextCycle, timer: { phase: nextPhase, paused: true, remainingMs } };
  }
  const forced = { ...doc, timer: { ...doc.timer, deadline: now } };
  const { doc: next } = settleBoundary(forced, now);
  return next;
}

/** Restart. No-op — returns `doc` UNCHANGED, by reference —
 * against no timer at all, same reasoning as forwardTimer above.
 *
 * Otherwise re-mints a FULL interval of whatever phase is already running, its length
 * read from `doc.settings` at call time ("the current settings", not whatever was in
 * effect when the interval first started — the same read-at-the-boundary rule
 * mergeSettings' own comment already applies to every OTHER boundary) via the same
 * `phaseDurationMin` helper settleBoundary and forwardTimer share, so all three can
 * never disagree about how long a phase is. `phase` and `cycle`/`cycleDate` are carried
 * through untouched, spelled out rather than left to rollDay: restart touches neither,
 * and it can never be handed a timer from a dead day to re-mint — readDoc has already
 * rolled the document by the time the restart control's own click reaches this
 * function.
 *
 * PAUSED stays paused (ADR 82): restarting is not a way to leave pause any more than
 * forwarding is, and restarting a paused timer used to leave it running only because
 * this function forced `paused: false` unconditionally, not because re-minting a phase
 * means anything about running it. A running timer re-mints a `deadline`; a paused one
 * re-mints `remainingMs` to that same full duration and stays paused. Either branch builds a fresh
 * `{ phase, ... }` rather than spreading `doc.timer`, which is what drops whichever of
 * `deadline`/`remainingMs` belonged to the OLD interval instead of leaving it beside the
 * new one for a future reader to mistake for still meaning something — the same shape
 * pauseTimer/resumeTimer already keep exactly one of `deadline` or `remainingMs` for. */
export function restartTimer(doc, now) {
  if (!doc.timer) return doc;
  const { phase, paused } = doc.timer;
  const durationMin = phaseDurationMin(phase, doc.settings);
  if (paused) return { ...doc, timer: { phase, paused: true, remainingMs: durationMin * 60_000 } };
  return { ...doc, timer: { phase, deadline: now + durationMin * 60_000, paused: false } };
}

/** Pause. No-op — returns `doc` UNCHANGED, by reference, so callers
 * can skip a needless write — against no timer at all and against a timer that is
 * already paused; pressing pause twice, or pausing a board with nothing running, must
 * not throw and must not fabricate a paused state out of nothing.
 *
 * Converts the absolute `deadline` into a `remainingMs` snapshot and drops `deadline`
 * entirely, rather than leaving a stale one beside it: a paused interval has no
 * wall-clock deadline to speak of until resumeTimer below mints a new one, and keeping
 * the old one around invites some future reader to use it by mistake. Clamped to 0 so a
 * pause that lands a hair after the real deadline (the request arrived while the
 * armed setTimeout was already in flight — see createPomodoro's reconcile) never
 * produces a negative remainder.
 *
 * The EXPIRED rule (isExpired above) is applied FIRST and outranks the pause, because
 * pausing was the one way around it. An interval whose deadline went past hours ago —
 * the lid closed mid-work, so the armed setTimeout has not come due yet in the only
 * time it counts — froze here as `remainingMs: 0` (the clamp), and resumeTimer below
 * then anchored that zero to a fresh `now`, so the very next reconcile found a deadline
 * exactly due, took the ADVANCE branch and rang a real "Break started" for an interval
 * that ended before lunch. Expiring it instead is the same answer settleBoundary gives
 * the same document, which is the point: pause is a control on a live interval, not a
 * way to launder a dead one back into the loop. */
export function pauseTimer(doc, now) {
  if (!doc.timer || doc.timer.paused) return doc;
  if (isExpired(doc.timer, now)) return { ...doc, timer: null };
  const { deadline, ...rest } = doc.timer;
  return { ...doc, timer: { ...rest, paused: true, remainingMs: Math.max(0, deadline - now) } };
}

/** Resume: the exact inverse of pauseTimer. No-op against a timer that is already
 * running or against no timer at all — resuming something that was never paused would
 * invent a fresh deadline out of thin air, discarding whatever interval (if any) was
 * actually counting down. `remainingMs` becomes `deadline = now + remainingMs`, anchored
 * to THIS `now`, so the interval continues from where pauseTimer froze it rather than
 * restarting a full interval. */
export function resumeTimer(doc, now) {
  if (!doc.timer || !doc.timer.paused) return doc;
  const { remainingMs, ...rest } = doc.timer;
  return { ...doc, timer: { ...rest, paused: false, deadline: now + (remainingMs || 0) } };
}

/** Reset: ends the loop outright rather than merely clearing the running interval —
 * `cycle` goes back to 0 alongside `timer: null` because reset ends the loop the cycle
 * was counting, not just the one interval inside it.
 * Unlike pause/resume there is no nonsensical state to no-op against: resetting an
 * already-idle document just restates `timer: null, cycle: 0`, which is already true, so
 * this never needs to inspect `doc` before acting. `now` is accepted and ignored, purely
 * so this has the same `(doc, now)` shape as pauseTimer/resumeTimer/settleBoundary above
 * — a caller wiring up the three boundary-crossing controls never has to remember which
 * one doesn't want a clock. `cycleDate` is left untouched: rollDay already owns deciding
 * when a day change means something, and reset is not that — it is the same clearing
 * a rollover performs, asked for by hand and inside the day rather than at its edge. */
export function resetTimer(doc, _now) {
  return { ...doc, timer: null, cycle: 0 };
}

/** Below this, a difference between how far the wall clock moved and how far the
 * monotonic clock moved is ordinary measurement noise (two clocks read a few
 * instructions apart, a timer that fired a hair late), not a clock being SET. A second
 * is orders of magnitude above that noise and orders of magnitude below the smallest
 * step worth correcting. */
const CLOCK_STEP_MS = 1_000;

/** ponytail: the ceiling on a FORWARD rebase, and the one heuristic in this file.
 *
 * A forward jump of the wall clock relative to the monotonic clock has exactly two
 * causes and, from inside node, ONE signature: the clock was set forward, or the machine
 * slept. Both leave the armed setTimeout firing at its own monotonic delay with the wall
 * clock far past the deadline, and node exposes no clock that keeps running across a
 * sleep to tell them apart (`performance.now()` is the monotonic one, and it is the one
 * that stops). So the size of the jump is the only evidence there is: a real clock
 * correction is seconds to a couple of minutes, and a lid closing is the tens of minutes
 * to hours EXPIRY_GRACE_MS's own comment already describes. Five minutes sits between
 * them.
 *
 * Being wrong either way is small and symmetric — a five-minute nap keeps its interval
 * where the rule would have discarded it, an implausible five-minute-plus clock step
 * discards one the rule could have kept — and both are strictly better than today's
 * behaviour, which discards the interval either way with no break and no banner.
 * THE UPGRADE PATH: a clock that keeps counting across sleep (`CLOCK_BOOTTIME`,
 * `mach_continuous_time`) makes the two causes distinguishable outright, and this
 * ceiling can then go. Nothing else in this file depends on it.
 *
 * BACKWARD steps carry no ceiling and need none: sleeping can only ever make the wall
 * clock run AHEAD of the monotonic one, so a wall clock that has fallen behind is
 * unambiguously a clock that was set. */
const MAX_FORWARD_STEP_MS = 5 * 60_000;

/** Move a running interval's absolute deadline by a wall-clock STEP, so the interval
 * keeps the real time it had left rather than the wall-clock time it was written with.
 *
 * Returns `doc` unchanged, BY REFERENCE, for everything that is not a step: no timer, a
 * paused timer (which carries `remainingMs` and so has no wall-clock deadline to
 * correct), a difference too small to be a step, and a forward jump too large to
 * distinguish from sleep — that last one is deliberately left to settleBoundary's EXPIRED
 * rule, which is the right answer for a machine that was asleep and the accepted cost for
 * an implausibly large clock correction.
 *
 * `stepMs` is `(wall elapsed) - (monotonic elapsed)` measured across one armed interval of
 * the timer below. The daemon's own document stores an ABSOLUTE deadline (this file's
 * opening comment says why), and an absolute deadline is exactly the thing a clock step
 * invalidates: NTP moves the clock 90 seconds forward and a work interval with 20 minutes
 * left is suddenly 90 seconds "late", discarded by a rule written for a lid that was
 * closed. Rebasing the deadline by the same 90 seconds restores what the reader is
 * actually owed. */
export function applyClockStep(doc, stepMs) {
  if (!doc.timer || doc.timer.paused) return doc;
  if (!Number.isFinite(stepMs) || Math.abs(stepMs) < CLOCK_STEP_MS) return doc;
  if (stepMs > MAX_FORWARD_STEP_MS) return doc;
  if (typeof doc.timer.deadline !== 'number') return doc;
  return { ...doc, timer: { ...doc.timer, deadline: doc.timer.deadline + stepMs } };
}

// ---------------------------------------------------------------------------------
// Settings: merged, not replaced, and validated at the boundary (this IS the
// boundary — the only place an HTTP body's settings patch turns into trusted doc
// shape). Every duration is minutes, matching DEFAULT_SETTINGS and startWork/
// settleBoundary's own `* 60_000` arithmetic above.
// ---------------------------------------------------------------------------------

const DURATION_KEYS = ['workMin', 'breakMin', 'longBreakMin'];
// Every boolean setting, validated identically and independently: `enabled` is the
// Master switch that gates the whole daemon-side loop, `notify` gates a pomodoro
// boundary's banner, and the two `menubar*` keys are the status item's own pair.
// `bannerLevel` -- the Stranded round's own gate (`bannerLevel` above), the retired
// `notifyRounds` checkbox's replacement -- is NOT on this list: it
// is a closed set of four strings, not a boolean, and is validated in its own block
// below the same way CUE_KEYS is. Independence is the property that matters and it is
// structural here, not argued -- neither key's presence or absence in a patch ever
// touches another's stored value, the same as any two unrelated keys in this loop,
// which is what "silencing one leaves the other alone" (criterion 17) comes down to at
// this layer -- `enabled` included: turning pomodoro off must not (and, being just
// another key in this same loop, structurally cannot) touch `bannerLevel`, the safety
// net SECURITY.md documents. A patch carrying the retired `notifyRounds` key hits none
// of the blocks below and is silently dropped, the same as any other key this module no
// longer recognizes. Adding a key to this list is the whole of teaching both boundaries
// about it: mergeSettings refuses a non-boolean by name below, and normalizeDoc fills a
// missing or hand-mangled one in from DEFAULT_SETTINGS.
const TOGGLE_KEYS = ['enabled', 'notify', 'menubarCountdown', 'menubarHidden'];
// The three per-phase cue settings -- validated against
// src/cues.mjs's isCue, the one place the closed set of legal values (the 14 sounds
// macOS ships, plus `None`) is enumerated. Not re-enumerated here on purpose (this
// file's own comment above already says do not re-derive that set anywhere else).
const CUE_KEYS = ['cueWork', 'cueBreak', 'cueLongBreak'];

/** A day. Generous on purpose — this is not a defense against a bad PLAN (nobody is
 * stopped from setting a silly-but-harmless 3-hour break), only against a value that
 * breaks arithmetic or produces a deadline so far out it may as well be "never":
 * `startWork`/`settleBoundary` multiply this by 60_000 into a `setTimeout` delay, and
 * node clamps a delay above ~24.8 days to 1ms (32-bit signed int overflow) — this cap
 * sits comfortably under that with room to spare. */
const MAX_DURATION_MIN = 24 * 60;

/** `longEvery` is a modulo divisor in settleBoundary (`breakNumber % longEvery`):
 * `0` is a divide-by-zero (NaN, never equal, no long break ever triggers correctly) and
 * a negative value makes "every Nth break" meaningless. 100 is the same
 * generous-not-tight ceiling as MAX_DURATION_MIN — nobody plans a 100-pomodoro day, but
 * this only exists to keep the arithmetic sane, not to enforce a sensible schedule. */
const MAX_LONG_EVERY = 100;

/** Node's setTimeout coerces anything past this to 1ms rather than clamping to it. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** The closed set of phases a stored timer may name — settleBoundary's advance rule and
 * durationMin both fall through to `break` for anything unrecognised, so a document
 * naming a phase that does not exist would silently run on break durations forever. */
const PHASES = ['work', 'break', 'longBreak'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isBoundedInt(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max;
}

/** Merge a partial settings patch into `doc`, validated at this trust boundary (the
 * body arrived over HTTP — see src/server.mjs's settings route). Throws a plain `Error`
 * naming the offending field on the first bad value found, in the same shape
 * src/board.mjs's own validators throw in — the caller (the HTTP route) is what turns
 * that into a 400, exactly as it already does for a malformed board post. A thrown
 * error means NOTHING from this patch is applied: there is no partial-write path here,
 * unlike a field-by-field merge that keeps whatever validated before it hit a bad one.
 *
 * Unknown keys are silently DROPPED, not rejected — a client built against a newer or
 * older settings shape should not turn "I don't recognize this key" into a hard failure
 * the way a bad VALUE on a key this module does recognize must (a bad `longEvery`
 * divides by zero three lines into the next boundary crossing; a bad key it has never
 * heard of touches nothing).
 *
 * Deliberately does not look at `doc.timer` at all for any other key: changing a
 * duration does NOT retarget whatever interval is already running — the running
 * deadline was computed from the OLD value the moment the interval started, and a
 * duration change here only changes what the NEXT `startWork`/`settleBoundary` boundary
 * computes. Retargeting a live countdown out from under a reviewer mid-interval (the
 * deadline visibly jumping while they watch it) was rejected in favor of "the interval
 * you started is the interval you get; the new setting takes effect from the next one".
 *
 * The ONE exception is `enabled` flipping true → false ("Pomodoro made optional"): that
 * transition ends the loop the way a Rollover does (ADR 67 semantics) rather than
 * merely changing what the next boundary computes, because there IS no next boundary to
 * hand it to — the Timer is cleared and the Cycle reset to zero in the same settings
 * write, not left for some later control to notice the switch is off. The reverse
 * direction (false → true) restores nothing (ADR 90): the doc's timer is already null
 * by the time anything reads it (normalizeDoc's own boundary guard below enforces that
 * even against a hand-edited file), so there is nothing for this function to leave
 * alone either way. */
export function mergeSettings(doc, patch) {
  if (!isPlainObject(patch)) throw new Error('settings patch must be a JSON object');
  const settings = { ...doc.settings };
  for (const key of DURATION_KEYS) {
    if (!(key in patch)) continue;
    if (!isBoundedInt(patch[key], 1, MAX_DURATION_MIN)) {
      throw new Error(`settings.${key} must be an integer number of minutes between 1 and ${MAX_DURATION_MIN}`);
    }
    settings[key] = patch[key];
  }
  if ('longEvery' in patch) {
    if (!isBoundedInt(patch.longEvery, 1, MAX_LONG_EVERY)) {
      throw new Error(`settings.longEvery must be an integer between 1 and ${MAX_LONG_EVERY} (settleBoundary divides by it)`);
    }
    settings.longEvery = patch.longEvery;
  }
  for (const key of TOGGLE_KEYS) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'boolean') throw new Error(`settings.${key} must be a boolean`);
    settings[key] = patch[key];
  }
  for (const key of CUE_KEYS) {
    if (!(key in patch)) continue;
    if (!isCue(patch[key])) {
      // Names the directories rather than listing the valid names: the list is up to 14
      // long and the reader's real question on a rejected save is where to put a sound.
      throw new Error(
        `settings.${key} must be "${NO_CUE}" or the name of a sound in ${SOUNDS_DIRS.join(' / ')}`
      );
    }
    settings[key] = patch[key];
  }
  // `bannerLevel` -- a closed set of four strings, not a boolean, so it gets its own
  // block rather than joining TOGGLE_KEYS, the same reason CUE_KEYS above is not folded
  // into that loop either. Named-400 by construction: the message states the field
  // (`settings.bannerLevel`) and the whole legal set, so a rejected save tells the
  // caller exactly what it could have sent instead, the same shape isCue's own message
  // above gives a bad cue.
  if ('bannerLevel' in patch) {
    if (!BANNER_LEVELS.includes(patch.bannerLevel)) {
      throw new Error(`settings.bannerLevel must be one of ${BANNER_LEVELS.join(', ')}`);
    }
    settings.bannerLevel = patch.bannerLevel;
  }
  // The one exception to "never looks at doc.timer" — see this function's own comment.
  // `!== false` / `=== false` rather than truthy/falsy: both sides have already been
  // through TOGGLE_KEYS' strict-boolean validation above (or were never touched by the
  // patch at all, in which case they still carry whatever normalizeDoc/DEFAULT_SETTINGS
  // already coerced them to), so this is a plain boolean comparison, not a coercion.
  const wasEnabled = doc.settings.enabled !== false;
  const isEnabled = settings.enabled !== false;
  if (wasEnabled && !isEnabled) {
    return { ...doc, settings, timer: null, cycle: 0 };
  }
  return { ...doc, settings };
}

// ---------------------------------------------------------------------------------
// Persistence. Same discipline as src/store.mjs's atomicWrite/DIR_MODE/FILE_MODE,
// duplicated rather than imported: that helper is module-private there on purpose
// (see this repo's own "nothing else in src/ gains pomodoro knowledge" boundary), and
// a board file and a settings-and-clock file are not the same kind of document to
// begin with.
// ---------------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function pomodoroPath(home) {
  return path.join(home, 'pomodoro.json');
}

function atomicWrite(targetPath, contents) {
  mkdirSync(path.dirname(targetPath), { recursive: true, mode: DIR_MODE });
  const tmp = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', FILE_MODE);
  try {
    // Looped on the returned count, same reason as src/store.mjs: writeSync issues
    // one write(2) and can return a short count without throwing.
    const buf = Buffer.from(contents, 'utf8');
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`short write to ${tmp}: wrote ${off} of ${buf.length} bytes`);
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, targetPath);
}

/** Coerce whatever JSON.parse handed back into the documented shape, defensively —
 * not full schema validation, just enough that a document written by an older or
 * newer version of this module (a missing `cueWork` key, say) fills in from
 * DEFAULT_SETTINGS instead of the reader silently losing a field everywhere it's
 * used. Runs on every read (readDoc below), which is what makes migration below
 * complete: there is no separate one-shot migration pass, only "the next write
 * carries the normalized shape back to disk".
 *
 * Migration: the retired `sound` boolean, if present,
 * becomes a THIRD layer of defaults — `Glass` on all three cues for `sound: true`,
 * `None` for `sound: false` — spread in UNDER whatever the document already states
 * explicitly for `cueWork`/`cueBreak`/`cueLongBreak`, exactly the way DEFAULT_SETTINGS
 * itself is already a layer under the parsed settings a few lines below. That is a
 * deliberate choice, not the only reading: a document could instead
 * carry both a `sound` key and already-present cue keys if an already-migrated
 * document (one that had already gone through this function once, been written back
 * without `sound`, and then had its cues hand-picked) had `sound` re-added by a hand
 * edit — the sound-derived values only fill in cues the document doesn't already
 * state, rather than clobbering a reader's actual per-phase choice with a stale
 * boolean's guess. Either way `sound` itself never survives into the returned
 * settings — "no document is left holding a sound key that still does something" is
 * true even in the branch where it does nothing at all. */
export function normalizeDoc(parsed) {
  const parsedSettings = parsed && typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
  const { sound, ...rest } = parsedSettings;
  // pickCue('Glass'), not the bare literal the spec words it as: on a machine whose
  // /System/Library/Sounds has no Glass.aiff, a migration writing the literal would put a
  // value in the document that mergeSettings then REFUSES, so the reader's next save of
  // any unrelated field 400s on a cue they never chose. pickCue degrades that one case to
  // `None` and leaves the requirement satisfied verbatim everywhere Glass actually exists,
  // which is every stock machine.
  const migrated = sound ? pickCue('Glass') : NO_CUE;
  const soundMigration = 'sound' in parsedSettings ? { cueWork: migrated, cueBreak: migrated, cueLongBreak: migrated } : {};
  // `rest` and `timer` come off disk unvalidated, and this file is hand-editable by
  // design. Both are run through the same validators mergeSettings uses at the HTTP
  // boundary, because an unvalidated document does not merely render oddly -- it makes
  // the daemon ACT. A timer with no `deadline` compares `now < undefined` as false and
  // `NaN > EXPIRY_GRACE_MS` as false, so settleBoundary skipped its EXPIRED guard and
  // took the ADVANCE branch: a real notification and cue for an interval that never ran.
  // A non-numeric workMin fed straight into `deadline = now + workMin * 60_000` gave
  // setTimeout(NaN) -> 1ms -> a full write per millisecond. Deliberately weaker than
  // mergeSettings, which is the HTTP trust boundary and stays strict (bounded integers).
  // This layer only has to guarantee the arithmetic downstream cannot produce NaN -- a
  // finite positive number is therefore the whole requirement: a fractional duration
  // written straight to disk is a legitimate thing to do (the suite seeds sub-second
  // intervals that way) and harmless, now that arm() clamps the far end too.
  const settings = { ...DEFAULT_SETTINGS, ...soundMigration, ...rest };
  const isPositiveFinite = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  for (const key of ['workMin', 'breakMin', 'longBreakMin', 'longEvery']) {
    if (!isPositiveFinite(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
  }
  // Every toggle (TOGGLE_KEYS above), not just `notify` -- an older document with no
  // `menubar*` keys at all is exactly the "settings file written before this work
  // existed" case the constraint names, and this loop is what makes each of them read
  // as its own default rather than as a validation failure that would otherwise fall
  // through to `undefined`. `undefined` is not a harmless spelling of "off" here
  // either: it is what a client's `if (settings.menubarHidden)` reads the same as
  // `false` and what `JSON.stringify` drops from the response entirely, so a native
  // client asking for a key it can see in the defaults would get nothing back.
  for (const key of TOGGLE_KEYS) {
    if (typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
  }
  // Banner level -- an explicit, valid `bannerLevel` in the RAW parsed document (`rest`,
  // not `settings`: the latter already carries DEFAULT_SETTINGS' own valid bannerLevel
  // spread in above, which would make every document look "explicit") wins outright;
  // anything else (missing, hand-mangled, or a document old enough to predate the key
  // and carry only the retired `notifyRounds` boolean) is decided by the one rule
  // `bannerLevel()` above already states: `notifyRounds` true/absent migrates to the
  // same default a fresh install gets, false migrates to `'off'`. Delegating to that
  // function rather than re-deriving the mapping here is what keeps a hand-called
  // `bannerLevel(settings)` (the Stranded path's own read, elsewhere) and what a
  // document actually normalizes to on disk from ever being able to drift apart.
  // `notifyRounds` itself never survives past this line -- consumed here the same way
  // `sound` above is consumed by the cue migration and then dropped -- so nothing
  // downstream, including the next write of this same document, carries the retired key
  // forward.
  settings.bannerLevel = bannerLevel(rest);
  delete settings.notifyRounds;
  for (const key of ['cueWork', 'cueBreak', 'cueLongBreak']) {
    if (!isCue(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
  }

  const cycle = Number.isInteger(parsed && parsed.cycle) ? parsed.cycle : 0;
  const cycleDate = typeof (parsed && parsed.cycleDate) === 'string' ? parsed.cycleDate : null;

  // A timer is kept only if it can actually be settled: a known phase, plus whichever of
  // deadline/remainingMs its paused state calls for. Anything else is dropped to null,
  // which reads as "no interval running" -- the same outcome a missing file gives.
  const raw = parsed && isPlainObject(parsed.timer) ? parsed.timer : null;
  let timer = null;
  if (raw && PHASES.includes(raw.phase)) {
    const paused = raw.paused === true;
    const anchor = paused ? raw.remainingMs : raw.deadline;
    if (typeof anchor === 'number' && Number.isFinite(anchor)) timer = { ...raw, paused };
  }
  // The Master switch's structural guarantee: a document that reads as OFF never
  // carries a timer past this point, however it got that way. Every path that flips
  // `enabled` true -> false already clears the timer itself (mergeSettings above), so
  // in the ordinary run of the daemon this is a no-op; the one shape it actually
  // guards against is a hand-edited `pomodoro.json` pairing `enabled: false` with a
  // still-running or still-due timer, which — left alone — is the one way
  // `settleBoundary` could still fire a real boundary (a notification, a cue) for a
  // feature the reader turned off. Runs on every read (readDoc below), same as the
  // rest of this function's defensive coercions, so nothing downstream of readDoc ever
  // has to re-check `settings.enabled` before trusting `timer`.
  if (settings.enabled === false) timer = null;
  return { settings, cycle, cycleDate, timer };
}

/** Never throws — a missing file (first run) and an unparseable one (a write that
 * landed mid-crash, or a hand-edit) both read as the defaults, mirroring how
 * src/store.mjs's listBoards survives a corrupt board file rather than taking the
 * whole daemon down over one bad read.
 *
 * Every read is rolled (rollDay above), so a document belonging to a pomodoro day that
 * has ended is never handed to anybody — not to the pure functions above, not to
 * GET /api/pomodoro, not to a check asserting what is "on disk". This is the read half
 * of "noticed lazily by whatever next touches the document": opening the page after
 * 05:00 shows no interval without a session having started first, and starts nothing,
 * because rolling here writes nothing. The stale bytes stay on disk until the next
 * write carries the rolled shape back — the same migration discipline normalizeDoc's
 * own comment describes, and the reason `now` is a parameter rather than a Date.now()
 * call in here. */
export function readDoc(home = boardHome(), now = Date.now()) {
  let doc;
  try {
    doc = normalizeDoc(JSON.parse(readFileSync(pomodoroPath(home), 'utf8')));
  } catch {
    doc = defaultDoc();
  }
  return rollDay(doc, now);
}

export function writeDoc(doc, home = boardHome()) {
  mkdirSync(home, { recursive: true, mode: DIR_MODE });
  atomicWrite(pomodoroPath(home), JSON.stringify(doc, null, 2));
  return doc;
}

// ---------------------------------------------------------------------------------
// The impure shell: read, call the pure function, write, arm the next real boundary.
// ---------------------------------------------------------------------------------

/** No armed wait ever runs longer than this before the wall clock is consulted again.
 *
 * A `setTimeout` delay is RELATIVE and counted on a monotonic clock; the deadline it is
 * counting toward is ABSOLUTE wall time. Baking one into the other once, at the start of a
 * 25-minute interval, is what made this module quietly depend on the very thing its own
 * opening comment says it never asks — whether the timer fired on time. It does not, after
 * a clock step: the widget sat at 00:00 for the rest of the armed delay (frozen, because
 * nothing was going to look at the document until it elapsed) and then settleBoundary read
 * a deadline long past and discarded the interval, no break and no banner.
 *
 * Re-arming in slices costs one small file read every five seconds while an interval is
 * running — a few hundred bytes, against a daemon that already heartbeats its SSE clients
 * — and buys two things: a step is NOTICED inside five seconds instead of at the end of
 * the interval, and each slice is a fresh (wall, monotonic) sample pair, which is what
 * makes a step measurable at all (applyClockStep above).
 *
 * A sixth of EXPIRY_GRACE_MS, deliberately: a step detected at the very worst moment
 * still leaves the rebased boundary comfortably inside the grace that decides what a late
 * deadline means, rather than on its edge. */
const MAX_ARM_MS = 5_000;

/** How long the clock waits before retrying a boundary that threw. Long enough that a
 * durable failure (a full disk, a store gone read-only) costs one attempt and one log line
 * every minute rather than a hot loop — re-arming on the unchanged deadline would compute a
 * delay of 0 and spin the daemon's only thread — and short enough that the clock comes back
 * on its own once the disk does, with no restart. */
const RECONCILE_RETRY_MS = 60_000;

/** Boots and owns the live clock for one daemon instance. `onBoundary({ phase, settings
 * })` is the seam a real notification hangs off (src/notify.mjs) — ponytail:
 * this module still fires nothing itself, by design ("no tool learns of
 * the timer" extends to this module too; the no-op default below is what a caller that
 * wants no notifications, e.g. a check, gets for free).
 *
 * `now` and `mono` are the shell's two clocks, injectable for the same reason every pure
 * function above takes `now` as an argument: a check cannot step the machine's wall clock,
 * and the whole of the clock-step rule below is about the two disagreeing. `now` is wall
 * time in epoch ms (it is what lands in the document, so it has to be the real thing);
 * `mono` is any monotonic millisecond counter, i.e. one that a clock being SET does not
 * move. Neither is used anywhere but here — the routes and the checks that drive them keep
 * passing their own `now` per call, exactly as before. */
export function createPomodoro({
  home = boardHome(),
  onBoundary = () => {},
  now: nowFn = Date.now,
  mono = () => performance.now(),
} = {}) {
  let timeoutHandle = null;
  /** The (wall, monotonic) pair sampled when the current wait was armed, and the whole of
   * what the step detector has to work from. Null whenever nothing is armed, so a
   * reconcile that did not come from an armed wait can never be handed a stale pair. */
  let armedAt = null;

  function clearArmed() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    armedAt = null;
  }

  /** How far the wall clock moved that the monotonic clock did not, across the wait that
   * just elapsed. Zero when there is nothing to compare against, which is the honest
   * answer for a boot or for any reconcile that did not come from an armed wait. */
  function clockStepSince(now) {
    if (!armedAt) return 0;
    return (now - armedAt.wall) - (mono() - armedAt.mono);
  }

  function arm(doc, now) {
    clearArmed();
    if (!doc.timer || doc.timer.paused) return;
    // Clamped at BOTH ends. Node coerces any delay over 2^31-1 ms to 1ms, so a deadline
    // more than ~24.8 days out -- a backward clock jump (a dead-battery Mac booting
    // before NTP syncs, a restored VM snapshot) or a hand-edited file, both of which
    // readDoc promises to survive -- re-armed every millisecond without ever reaching
    // the deadline, so it never converged. Measured at 846 re-arms per second on the
    // daemon's only thread. MAX_ARM_MS (its own comment above) is the far tighter of the
    // two ceilings and the one that actually bites; MAX_TIMEOUT_MS stays spelled out
    // because it is a fact about node's own setTimeout that a future edit to MAX_ARM_MS
    // must not be able to walk past.
    const delay = Math.min(Math.max(0, doc.timer.deadline - now), MAX_ARM_MS, MAX_TIMEOUT_MS);
    // `nowFn()` and not the caller's `now`, even though the delay above is computed from the
    // caller's: this pair exists only to answer "did the wall clock jump between arming and
    // firing", and the firing end reads `nowFn()`. Sampling the two ends from two different
    // clocks -- every route passes no `now` at all, but a check may pass a fabricated one --
    // would report the difference between those clocks as a clock step.
    armedAt = { wall: nowFn(), mono: mono() };
    timeoutHandle = setTimeout(() => reconcile(nowFn(), true), delay);
    // Belt and suspenders with close() below, same reasoning as the SSE heartbeat a
    // few lines over in src/server.mjs: a live pomodoro must never be the reason an
    // in-process check's node process fails to exit on its own.
    timeoutHandle.unref?.();
  }

  /** The failure path's own re-arm: one attempt per RECONCILE_RETRY_MS, on nothing but the
   * clock, deliberately NOT on the document's deadline (which is still due, so arming on it
   * would compute a delay of 0 and spin). No `armedAt` pair is left behind — a retry is not
   * a wait against a deadline, so there is no step to measure across it. */
  function armRetry() {
    clearArmed();
    timeoutHandle = setTimeout(() => reconcile(nowFn(), false), RECONCILE_RETRY_MS);
    timeoutHandle.unref?.();
  }

  // Re-reads from disk on every call rather than trusting an in-memory copy. There is
  // exactly one daemon process today, so this is not about concurrent writers — it's
  // that disk is the single source of truth (same call this repo already made for
  // src/store.mjs's searchBoards, "no side index that could drift"), and it's cheap:
  // this file is a few hundred bytes next to a board parse.
  //
  // WRAPPED WHOLE, and that is the point of the shape rather than a decoration on it (the
  // same wrapper src/stranded.mjs's `persist` and `announce` carry, for the same reason).
  // This runs from a bare setTimeout: by the time it does, no request handler's try/catch
  // is anywhere on the stack, so an uncaught throw here is an uncaught exception at the top
  // of the event loop, which bin/daemon.mjs answers by exiting -- and launchd restarts the
  // daemon straight back onto the SAME due boundary, which throws again. A full disk turned
  // one failed `writeDoc` into a permanent restart loop with every blocked `/wait` and every
  // open stream going down on each pass. The cost of the failure is now one log line and one
  // retry a minute; the clock recovers on its own when the disk does.
  //
  // `readDoc` sits OUTSIDE the try on purpose: it never throws (see its own comment), so the
  // document this returns on the failure path is still the honest one.
  //
  // `fromTimer` says whether an armed wait is what led here, which is the only situation in
  // which `armedAt` describes anything: a boot, or a retry, has no wait behind it to have
  // measured a clock step across.
  function reconcile(now, fromTimer = false) {
    const doc = readDoc(home, now);
    let next = doc;
    try {
      // The clock-step correction, ahead of the boundary rule that would otherwise read a
      // stepped clock as a deadline nobody was there for (applyClockStep above says why).
      // A no-op by reference for everything that is not a step, so the `next !== doc` write
      // below is unchanged for every ordinary boundary.
      const stepped = applyClockStep(doc, fromTimer ? clockStepSince(now) : 0);
      const settled = settleBoundary(stepped, now);
      next = settled.doc;
      if (next !== doc) writeDoc(next, home);
      arm(next, now);
      // `settings` rides along here, not inside settleBoundary's own boundary object: the
      // pure function (above) knows nothing about notification toggles, only the loop --
      // src/notify.mjs reads settings.notify/settings.sound off this.
      if (settled.boundary) onBoundary({ ...settled.boundary, settings: next.settings });
    } catch (err) {
      // Named, never swallowed silently: a clock that has stopped settling boundaries is a
      // thing a reader will notice and a thing whoever reads the daemon's log needs told.
      console.error(`claude-board: the pomodoro boundary could not be settled: ${(err && err.message) || err}`);
      // Also reached when `onBoundary` itself throws, in which case the interval already
      // advanced and was already correctly armed -- the retry then merely wakes once, finds
      // nothing due, and re-arms properly. One spare wakeup is the whole cost of not
      // needing a second try/catch to tell the two failures apart.
      armRetry();
    }
    return next;
  }

  // pause/resume/forward/restart/reset below share one shape: read the doc off
  // disk, apply one pure transform, and persist + re-arm only when something
  // actually changed (arm() is what turns any newly-written deadline into a real
  // boundary later, so skipping it on a no-op leaves whatever was already armed
  // untouched). Each method's own comment below states only its delta from that
  // shape.
  return {
    /** Boot-time reconciliation: apply the expiry rule to whatever is
     * on disk and arm the next real boundary if a timer survives it. Deliberately
     * does NOT start a fresh timer when there is none — a daemon restart alone must
     * not begin a pomodoro nobody asked for; that is ensureTimer's job, called by
     * whichever slice wires the session-start hook. */
    boot(now = nowFn()) {
      return reconcile(now);
    },
    /** The session-start seam ("starting when one is already running is
     * a no-op", extended to "starting is starting a NEW work interval"). Safe to call
     * on every session start: startWork is a no-op against anything already in
     * `timer`, running, paused or mid-break alike. */
    ensureTimer(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = startWork(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Pause (src/server.mjs POST /api/pomodoro/pause). Re-arming matters here
     * too, not just on resume: pauseTimer drops `deadline` entirely, and arm()
     * reads `doc.timer.paused` and clears the outstanding
     * setTimeout without setting a new one, so the interval that was counting down
     * stops actually being counted down by anything, not merely on paper. Skipping
     * this on a no-op (pausing nothing, or pausing an already-paused timer) leaves
     * whatever was already armed exactly as it was. */
    pause(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = pauseTimer(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Resume (src/server.mjs POST /api/pomodoro/resume). Re-arming here is
     * LOAD-BEARING, not cosmetic, and easy to forget: resumeTimer mints a brand-new
     * absolute `deadline` from `now + remainingMs`, and the only thing that turns a
     * deadline sitting in the document into a real boundary crossing later is a live
     * setTimeout counting down to it. Skip the `arm` call and the resumed interval is
     * correct on paper — right deadline, `paused: false` — with nothing ever going to
     * fire: no expiry, no advance to the next phase, no notification, until some
     * unrelated event (a restart's `boot()`, another pause/resume) happens to
     * reconcile it. */
    resume(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = resumeTimer(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Forward (src/server.mjs POST /api/pomodoro/forward). Re-arming matters
     * exactly the way it does after resume: forwardTimer mints a brand-new
     * absolute deadline for the next phase, and only a live
     * setTimeout counting down to THAT deadline turns it into a real boundary later.
     * Unless the timer was PAUSED, in which case forwardTimer lands the next phase paused
     * too (ADR 82) with a `remainingMs` and no deadline at all — and `arm` reads
     * `doc.timer.paused` and schedules nothing, which is the right answer: a paused
     * interval has no wall-clock boundary to arm until the switch resumes it.
     * Deliberately does not pass an `onBoundary` callback anywhere in this path —
     * `arm` only ever schedules the NEXT natural boundary's setTimeout, it
     * never itself fires notification code, so nothing here can. */
    forward(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = forwardTimer(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Restart (src/server.mjs POST /api/pomodoro/restart). Same shape as forward
     * above, applying the pure restartTimer instead. */
    restart(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = restartTimer(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Reset (src/server.mjs POST /api/pomodoro/reset). Always persists and re-arms,
     * unlike pause/resume: resetTimer has no reference-equality no-op path (see its own
     * comment), and even when the document was already idle, calling `arm` is what
     * clears any setTimeout still counting toward an old deadline — skip it and a
     * reset-while-running would leave the just-cleared interval's timeout alive to fire
     * later, land back on disk (finding `!doc.timer`, a no-op in settleBoundary) but not
     * before wasting a tick pretending the reset never happened. */
    reset(now = nowFn()) {
      const doc = readDoc(home, now);
      const next = resetTimer(doc, now);
      writeDoc(next, home);
      arm(next, now);
      return next;
    },
    /** Settings (src/server.mjs POST /api/pomodoro/settings). mergeSettings throws on
     * a bad patch — this method does not catch it, so the thrown Error propagates to
     * the HTTP route, which is what turns it into a 400 naming the field. Deliberately
     * calls `arm` only when `mergeSettings` actually touched `doc.timer` — which today
     * means exactly one thing, the Master switch flipping true → false: mergeSettings'
     * own comment is the fuller version of why an ORDINARY settings write (a duration, a
     * cue) must not retarget whatever interval is already running, and re-arming
     * against an unchanged deadline would be a no-op clearTimeout+setTimeout pair that
     * only invites a future reader to wonder why writing settings touches the live
     * clock at all. The Master switch is different: mergeSettings already cleared
     * `timer` to null on that transition (Rollover semantics), and `arm` is what turns
     * that into the live setTimeout actually going away too — without it, a Timer that
     * was due to fire in the next few seconds (see MAX_ARM_MS) would still fire through
     * the setTimeout this method never cancelled, on a document it no longer belongs
     * to. */
    settings(patch, now = nowFn()) {
      const doc = readDoc(home, now);
      const next = mergeSettings(doc, patch);
      writeDoc(next, home);
      if (next.timer !== doc.timer) arm(next, now);
      return next;
    },
    /** Stops the live setTimeout. Called from src/server.mjs on server close so an
     * in-process daemon (every check that calls startServer) leaves nothing running
     * after the check that started it moves on — see the unref comment above for why
     * this is belt-and-suspenders rather than the only thing standing between a check
     * and a hang. */
    close() {
      clearArmed();
    },
  };
}
