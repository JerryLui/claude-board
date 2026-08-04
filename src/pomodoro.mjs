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
// This module is advisory only. It never touches an agent's request, never gates or
// delays `ask`, and knows nothing about boards. The one caller outside this file is
// src/server.mjs's startServer, which boots the clock and closes it on server close.

import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { boardHome } from './store.mjs';

// ---------------------------------------------------------------------------------
// Settings, defaults, and the document shape (a contract other tickets build against
// — see SPEC_POMODORO.md; do not change field names without checking who reads them).
// ---------------------------------------------------------------------------------

export const DEFAULT_SETTINGS = Object.freeze({
  workMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longEvery: 4,
  notify: true,
  sound: false,
});

/** How late a deadline is allowed to run before the interval counts as EXPIRED rather
 * than merely late. Below this, `settleBoundary` advances the loop as if it ran on
 * time; above it, the timer is discarded with no advance and no notification
 * (criterion 7). 30s covers a `setTimeout`'s own ordinary slack (event loop backlog,
 * a heavy GC pause) without covering anything that looks like real sleep — a laptop
 * lid closing is minutes to hours late, never single-digit seconds. */
export const EXPIRY_GRACE_MS = 30_000;

export function defaultDoc() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    cycle: 0,
    // null rather than "today": normalizeCycle below treats absent/mismatched
    // cycleDate identically (not-today), so a fresh document and a stale one from
    // yesterday take the exact same reset path with no special-cased default to
    // keep in sync with it.
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

/** The local-midnight reset (criterion 4, second half). Cheap and total: called at
 * the top of every function that is about to do cycle arithmetic, never as a
 * standalone background job — there is nothing to reset ahead of time, since the
 * value only ever matters at the next place that reads it, and every such place
 * calls this first. */
export function normalizeCycle(doc, now) {
  const today = localDateStr(now);
  if (doc.cycleDate === today) return doc;
  return { ...doc, cycle: 0, cycleDate: today };
}

/** The "ensure" half (criterion 2's no-op rule, and what a session-start hook —
 * wired by another slice — calls through the impure ensureTimer below). Starts a
 * fresh work interval ONLY when there is no timer at all: a running timer, a paused
 * timer, and a timer mid-break are every one of them left untouched, which is what
 * stops a start during a break from cutting the break short. */
export function startWork(doc, now) {
  if (doc.timer) return doc;
  const base = normalizeCycle(doc, now);
  return { ...base, timer: { phase: 'work', deadline: now + base.settings.workMin * 60_000, paused: false } };
}

/** The loop's one boundary-crossing rule (criteria 3, 4, 7), and the seam ticket 02
 * hangs a notification off: this function only REPORTS that a boundary occurred
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
 *    are carried through normalizeCycle but otherwise untouched: a lunch break must
 *    not cost the two pomodoros already completed today.
 *  - otherwise: advance. A `work` interval ending begins break number `cycle + 1`
 *    (long iff that number is a multiple of `longEvery`); a `break` or `longBreak`
 *    ending begins the next `work` interval, and increments `cycle` — resetting it to
 *    0 if the break that just ended was the long one. No input at either boundary. */
export function settleBoundary(doc, now) {
  if (!doc.timer || doc.timer.paused) return { doc, boundary: null };
  if (now < doc.timer.deadline) return { doc, boundary: null };

  const late = now - doc.timer.deadline;
  const base = normalizeCycle(doc, now);

  if (late > EXPIRY_GRACE_MS) {
    return { doc: { ...base, timer: null }, boundary: null };
  }

  const finishedPhase = doc.timer.phase;
  let cycle = base.cycle;
  let nextPhase;
  if (finishedPhase === 'work') {
    const breakNumber = cycle + 1;
    nextPhase = breakNumber % base.settings.longEvery === 0 ? 'longBreak' : 'break';
  } else {
    cycle = cycle + 1;
    if (finishedPhase === 'longBreak') cycle = 0;
    nextPhase = 'work';
  }

  const durationMin =
    nextPhase === 'work' ? base.settings.workMin : nextPhase === 'longBreak' ? base.settings.longBreakMin : base.settings.breakMin;

  const nextDoc = { ...base, cycle, timer: { phase: nextPhase, deadline: now + durationMin * 60_000, paused: false } };
  return { doc: nextDoc, boundary: { phase: nextPhase } };
}

/** Pause (spec criterion 8). No-op — returns `doc` UNCHANGED, by reference, so callers
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
 * was counting, not just the one interval inside it (spec criterion 8's own wording).
 * Unlike pause/resume there is no nonsensical state to no-op against: resetting an
 * already-idle document just restates `timer: null, cycle: 0`, which is already true, so
 * this never needs to inspect `doc` before acting. `now` is accepted and ignored, purely
 * so this has the same `(doc, now)` shape as pauseTimer/resumeTimer/settleBoundary above
 * — a caller wiring up the three boundary-crossing controls never has to remember which
 * one doesn't want a clock. `cycleDate` is left untouched: normalizeCycle already owns
 * deciding when a date rollover means something, and reset is not that. */
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
const TOGGLE_KEYS = ['notify', 'sound'];

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
 * newer version of this module (a missing `sound` key, say) fills in from
 * DEFAULT_SETTINGS instead of the reader silently losing a field everywhere it's
 * used. */
function normalizeDoc(parsed) {
  const settings = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {}) };
  const cycle = Number.isInteger(parsed && parsed.cycle) ? parsed.cycle : 0;
  const cycleDate = typeof (parsed && parsed.cycleDate) === 'string' ? parsed.cycleDate : null;
  const timer = parsed && typeof parsed.timer === 'object' ? parsed.timer : null;
  return { settings, cycle, cycleDate, timer };
}

/** Never throws — a missing file (first run) and an unparseable one (a write that
 * landed mid-crash, or a hand-edit) both read as the defaults, mirroring how
 * src/store.mjs's listBoards survives a corrupt board file rather than taking the
 * whole daemon down over one bad read. */
export function readDoc(home = boardHome()) {
  try {
    const raw = readFileSync(pomodoroPath(home), 'utf8');
    return normalizeDoc(JSON.parse(raw));
  } catch {
    return defaultDoc();
  }
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
 * })` is the seam ticket 02 hangs a real notification off (src/notify.mjs) — ponytail:
 * this module still fires nothing itself, by design (criterion 10's "no tool learns of
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
    const delay = Math.max(0, doc.timer.deadline - now);
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
    const doc = readDoc(home);
    const { doc: next, boundary } = settleBoundary(doc, now);
    if (next !== doc) writeDoc(next, home);
    arm(next, now);
    // `settings` rides along here, not inside settleBoundary's own boundary object: the
    // pure function (above) knows nothing about notification toggles, only the loop --
    // src/notify.mjs (ticket 02) reads settings.notify/settings.sound off this.
    if (boundary) onBoundary({ ...boundary, settings: next.settings });
    return next;
  }

  return {
    /** Boot-time reconciliation (criteria 6, 7): apply the expiry rule to whatever is
     * on disk and arm the next real boundary if a timer survives it. Deliberately
     * does NOT start a fresh timer when there is none — a daemon restart alone must
     * not begin a pomodoro nobody asked for; that is ensureTimer's job, called by
     * whichever slice wires the session-start hook. */
    boot(now = Date.now()) {
      return reconcile(now);
    },
    /** The session-start seam (criterion 2's "starting when one is already running is
     * a no-op", extended to "starting is starting a NEW work interval"). Safe to call
     * on every session start: startWork is a no-op against anything already in
     * `timer`, running, paused or mid-break alike. */
    ensureTimer(now = Date.now()) {
      const doc = readDoc(home);
      const next = startWork(doc, now);
      if (next !== doc) {
        writeDoc(next, home);
        arm(next, now);
      }
      return next;
    },
    /** Pause (src/server.mjs POST /api/pomodoro/pause). Wraps the pure pauseTimer:
     * read, apply, and — only when something actually changed — persist and re-arm.
     * Re-arming matters here too, not just on resume: pauseTimer drops `deadline`
     * entirely, and arm() reads `doc.timer.paused` and clears the outstanding
     * setTimeout without setting a new one, so the interval that was counting down
     * stops actually being counted down by anything, not merely on paper. Skipping
     * this on a no-op (pausing nothing, or pausing an already-paused timer) leaves
     * whatever was already armed exactly as it was. */
    pause(now = Date.now()) {
      const doc = readDoc(home);
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
      const doc = readDoc(home);
      const next = resumeTimer(doc, now);
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
      const doc = readDoc(home);
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
      const doc = readDoc(home);
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
