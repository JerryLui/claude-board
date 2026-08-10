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
  workMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  notify: true,
  // Round banners' own on/off tick (ADR.md entry 58; CONTEXT.md's Banner), independent
  // of `notify` above -- that one gates pomodoro boundary banners alone, this one gates
  // a Stranded round's banner alone, and each can be silenced without touching the
  // other. On by default, INCLUDING for a settings document written before this field
  // existed: normalizeDoc below fills a missing/non-boolean value in from this same
  // default, so a reader who has never opened settings still gets round banners. See
  // roundBannersEnabled below for the read side a later chunk consults.
  notifyRounds: true,
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
  // `menubarHidden` -- has the reader hidden the item from the item's own popover. Off
  // by default for the obvious reason, and a stale document with no key at all reads as
  // off (normalizeDoc below), so an upgrade never starts out with a missing status item.
  menubarHidden: false,
  // Three DIFFERENT cues -- one per phase, so the reader tells
  // work/short-break/long-break apart by ear without looking at the screen.
  cueWork: pickCue('Hero'),
  cueBreak: pickCue('Purr'),
  cueLongBreak: pickCue('Submarine'),
});

/** The plain, obvious predicate a round's Stranded path (a later chunk, wired into the
 * daemon around sse.clientCount in src/server.mjs) consults before raising a Banner for
 * a round -- as opposed to `settings.notify`, which gates a pomodoro boundary's banner
 * and nothing else (ADR.md entry 58; criterion 17: independent of the pomodoro control
 * in both directions). Takes a settings object (typically `readDoc(home).settings`)
 * rather than a whole doc, matching how notify.mjs's own notifyBoundary is called.
 * Defaults ON for anything that is not exactly `false` -- absent, missing, or a stale
 * document with no `notifyRounds` key at all -- the same "on unless explicitly turned
 * off" reading normalizeDoc's coercion gives every other toggle here, so a settings file
 * from before this field existed still returns true. */
export function roundBannersEnabled(settings) {
  return !settings || settings.notifyRounds !== false;
}

/** How late a deadline is allowed to run before the interval counts as EXPIRED rather
 * than merely late. Below this, `settleBoundary` advances the loop as if it ran on
 * time; above it, the timer is discarded with no advance and no notification.
 * 30s covers a `setTimeout`'s own ordinary slack (event loop backlog,
 * a heavy GC pause) without covering anything that looks like real sleep — a laptop
 * lid closing is minutes to hours late, never single-digit seconds. */
export const EXPIRY_GRACE_MS = 30_000;

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
 * politely declines to disturb. */
export function startWork(doc, now) {
  const base = rollDay(doc, now);
  if (base.timer) return base;
  return { ...base, timer: { phase: 'work', deadline: now + base.settings.workMin * 60_000, paused: false } };
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

  const late = now - doc.timer.deadline;

  if (late > EXPIRY_GRACE_MS) {
    return { doc: { ...doc, timer: null }, boundary: null };
  }

  const finishedPhase = doc.timer.phase;
  let cycle = doc.cycle;
  let nextPhase;
  if (finishedPhase === 'work') {
    const breakNumber = cycle + 1;
    nextPhase = breakNumber % doc.settings.longEvery === 0 ? 'longBreak' : 'break';
  } else {
    cycle = cycle + 1;
    if (finishedPhase === 'longBreak') cycle = 0;
    nextPhase = 'work';
  }

  const durationMin =
    nextPhase === 'work' ? doc.settings.workMin : nextPhase === 'longBreak' ? doc.settings.longBreakMin : doc.settings.breakMin;

  const nextDoc = { ...doc, cycle, timer: { phase: nextPhase, deadline: now + durationMin * 60_000, paused: false } };
  return { doc: nextDoc, boundary: { phase: nextPhase } };
}

/** Forward.
 * No-op — returns `doc` UNCHANGED, by reference — against no timer at all: idle has no
 * interval to end early, and inventing one here would be `startWork`'s
 * job, not this one's.
 *
 * Otherwise this reuses `settleBoundary` itself rather than re-deriving its cycle
 * bookkeeping: it forges a doc whose timer already looks like
 * it hit its deadline exactly now — `paused: false` (forwarding a paused
 * timer both advances AND leaves the next phase running, so the paused flag a real
 * boundary would never see is cleared before settleBoundary ever looks at it) and
 * `deadline: now` (so `late === 0`, comfortably inside EXPIRY_GRACE_MS — a forward is
 * never the EXPIRED path; that path is what happens when nobody was there to press
 * anything). `settleBoundary` then computes the exact same next phase and cycle
 * arithmetic a natural boundary would have: a forwarded
 * work interval still earns its break, a forwarded break still increments the cycle, a
 * forwarded long break still resets it.
 *
 * The `boundary` half of settleBoundary's return is deliberately discarded: that value
 * is what src/pomodoro.mjs's own reconcile() feeds to `onBoundary` (the notification
 * seam), and forward's caller (createPomodoro.forward below) never sees it, which is
 * what makes "no notification, no cue" true by construction rather than by
 * a caller remembering to suppress it. */
export function forwardTimer(doc, now) {
  if (!doc.timer) return doc;
  const forced = { ...doc, timer: { ...doc.timer, paused: false, deadline: now } };
  const { doc: next } = settleBoundary(forced, now);
  return next;
}

/** Restart. No-op — returns `doc` UNCHANGED, by reference —
 * against no timer at all, same reasoning as forwardTimer above.
 *
 * Otherwise re-mints `deadline` to a FULL interval of whatever phase is already
 * running, read from `doc.settings` at call time ("the current settings",
 * not whatever was in effect when the interval first started — the same
 * read-at-the-boundary rule mergeSettings' own comment already applies to every OTHER
 * boundary). `phase` and `cycle`/`cycleDate` are carried through untouched, spelled
 * out rather than left to rollDay: restart touches neither, and it can never be handed
 * a timer from a dead day to re-mint — readDoc has already rolled the document by the
 * time the restart control's own click reaches this function.
 *
 * Builds a fresh `{ phase, deadline, paused: false }` rather than spreading
 * `doc.timer`, which is what drops a stale `remainingMs` left over from a paused timer
 * (restart unpauses) instead of leaving it beside a `deadline` a future
 * reader could mistake for still meaning something — the same shape pauseTimer/
 * resumeTimer already keep exactly one of `deadline` or `remainingMs` for. */
export function restartTimer(doc, now) {
  if (!doc.timer) return doc;
  const { phase } = doc.timer;
  const durationMin = phase === 'work' ? doc.settings.workMin : phase === 'longBreak' ? doc.settings.longBreakMin : doc.settings.breakMin;
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
 * produces a negative remainder. */
export function pauseTimer(doc, now) {
  if (!doc.timer || doc.timer.paused) return doc;
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

// ---------------------------------------------------------------------------------
// Settings: merged, not replaced, and validated at the boundary (this IS the
// boundary — the only place an HTTP body's settings patch turns into trusted doc
// shape). Every duration is minutes, matching DEFAULT_SETTINGS and startWork/
// settleBoundary's own `* 60_000` arithmetic above.
// ---------------------------------------------------------------------------------

const DURATION_KEYS = ['workMin', 'breakMin', 'longBreakMin'];
// Every boolean setting, validated identically and independently: `notify` gates a
// pomodoro boundary's banner, `notifyRounds` gates a Stranded round's
// (roundBannersEnabled above), and the two `menubar*` keys are the status item's own
// pair. Independence is the property that matters and it is structural here, not
// argued -- neither key's presence or absence in a patch ever touches another's stored
// value, the same as any two unrelated keys in this loop, which is what "silencing one
// leaves the other alone" (criterion 17) comes down to at this layer. Adding a key to
// this list is the whole of teaching both boundaries about it: mergeSettings refuses a
// non-boolean by name below, and normalizeDoc fills a missing or hand-mangled one in
// from DEFAULT_SETTINGS.
const TOGGLE_KEYS = ['notify', 'notifyRounds', 'menubarCountdown', 'menubarHidden'];
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
 * Deliberately does not look at `doc.timer` at all: changing a duration does NOT
 * retarget whatever interval is already running — the running deadline was computed
 * from the OLD value the moment the interval started, and a duration change here only
 * changes what the NEXT `startWork`/`settleBoundary` boundary computes. Retargeting a
 * live countdown out from under a reviewer mid-interval (the deadline visibly jumping
 * while they watch it) was rejected in favor of "the interval you started is the
 * interval you get; the new setting takes effect from the next one". */
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
  // `notifyRounds` and no `menubar*` keys at all is exactly the "settings file written
  // before this work existed" case the constraint names, and this loop is what makes each
  // of them read as its own default rather than as a validation failure that would
  // otherwise fall through to `undefined`. `undefined` is not a harmless spelling of
  // "off" here either: it is what a client's `if (settings.menubarHidden)` reads the same
  // as `false` and what `JSON.stringify` drops from the response entirely, so a native
  // client asking for a key it can see in the defaults would get nothing back.
  for (const key of TOGGLE_KEYS) {
    if (typeof settings[key] !== 'boolean') settings[key] = DEFAULT_SETTINGS[key];
  }
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

/** Boots and owns the live clock for one daemon instance. `onBoundary({ phase, settings
 * })` is the seam a real notification hangs off (src/notify.mjs) — ponytail:
 * this module still fires nothing itself, by design ("no tool learns of
 * the timer" extends to this module too; the no-op default below is what a caller that
 * wants no notifications, e.g. a check, gets for free). */
export function createPomodoro({ home = boardHome(), onBoundary = () => {} } = {}) {
  let timeoutHandle = null;

  function clearArmed() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function arm(doc, now) {
    clearArmed();
    if (!doc.timer || doc.timer.paused) return;
    // Clamped at BOTH ends. Node coerces any delay over 2^31-1 ms to 1ms, so a deadline
    // more than ~24.8 days out -- a backward clock jump (a dead-battery Mac booting
    // before NTP syncs, a restored VM snapshot) or a hand-edited file, both of which
    // readDoc promises to survive -- re-armed every millisecond without ever reaching
    // the deadline, so it never converged. Measured at 846 re-arms per second on the
    // daemon's only thread. Clamping instead re-arms once per MAX_TIMEOUT_MS and lets
    // reconcile settle it when the deadline finally arrives.
    const delay = Math.min(Math.max(0, doc.timer.deadline - now), MAX_TIMEOUT_MS);
    timeoutHandle = setTimeout(() => reconcile(Date.now()), delay);
    // Belt and suspenders with close() below, same reasoning as the SSE heartbeat a
    // few lines over in src/server.mjs: a live pomodoro must never be the reason an
    // in-process check's node process fails to exit on its own.
    timeoutHandle.unref?.();
  }

  // Re-reads from disk on every call rather than trusting an in-memory copy. There is
  // exactly one daemon process today, so this is not about concurrent writers — it's
  // that disk is the single source of truth (same call this repo already made for
  // src/store.mjs's searchBoards, "no side index that could drift"), and it's cheap:
  // this file is a few hundred bytes next to a board parse.
  function reconcile(now) {
    const doc = readDoc(home, now);
    const { doc: next, boundary } = settleBoundary(doc, now);
    if (next !== doc) writeDoc(next, home);
    arm(next, now);
    // `settings` rides along here, not inside settleBoundary's own boundary object: the
    // pure function (above) knows nothing about notification toggles, only the loop --
    // src/notify.mjs reads settings.notify/settings.sound off this.
    if (boundary) onBoundary({ ...boundary, settings: next.settings });
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
    boot(now = Date.now()) {
      return reconcile(now);
    },
    /** The session-start seam ("starting when one is already running is
     * a no-op", extended to "starting is starting a NEW work interval"). Safe to call
     * on every session start: startWork is a no-op against anything already in
     * `timer`, running, paused or mid-break alike. */
    ensureTimer(now = Date.now()) {
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
    pause(now = Date.now()) {
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
    resume(now = Date.now()) {
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
     * Deliberately does not pass an `onBoundary` callback anywhere in this path —
     * `arm` only ever schedules the NEXT natural boundary's setTimeout, it
     * never itself fires notification code, so nothing here can. */
    forward(now = Date.now()) {
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
    restart(now = Date.now()) {
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
    reset(now = Date.now()) {
      const doc = readDoc(home, now);
      const next = resetTimer(doc, now);
      writeDoc(next, home);
      arm(next, now);
      return next;
    },
    /** Settings (src/server.mjs POST /api/pomodoro/settings). mergeSettings throws on
     * a bad patch — this method does not catch it, so the thrown Error propagates to
     * the HTTP route, which is what turns it into a 400 naming the field. Deliberately
     * calls neither `arm` nor touches `doc.timer`: mergeSettings' own comment is the
     * fuller version of why a settings write must not retarget whatever interval is
     * already running, and re-arming against an UNCHANGED deadline here would be a
     * no-op clearTimeout+setTimeout pair that only invites a future reader to wonder
     * why writing settings touches the live clock at all. */
    settings(patch, now = Date.now()) {
      const doc = readDoc(home, now);
      const next = mergeSettings(doc, patch);
      writeDoc(next, home);
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
