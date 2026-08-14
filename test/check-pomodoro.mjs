// Pure-logic checks for src/pomodoro.mjs (ADR.md entry 8) plus one
// real-daemon restart check in the style of test/check-http.mjs. No notification is
// ever fired by this file -- there is none to fire yet, a different piece of work owns that seam --
// and nothing here shells out.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  EXPIRY_GRACE_MS,
  DAY_START_HOUR,
  defaultDoc,
  localDateStr,
  pomodoroDay,
  formatCountdown,
  rollDay,
  startWork,
  settleBoundary,
  forwardTimer,
  restartTimer,
  pauseTimer,
  applyClockStep,
  normalizeDoc,
  readDoc,
  writeDoc,
  createPomodoro,
  mergeSettings,
  BANNER_LEVELS,
  bannerLevel,
} from '../src/pomodoro.mjs';
import { startServer } from '../src/server.mjs';
import { NO_CUE } from '../src/cues.mjs';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';

// ADR 105: the pomodoro ships off, so a fixture whose subject is a live timer opts in explicitly.
const onDoc = () => { const d = defaultDoc(); return { ...d, settings: { ...d.settings, enabled: true } }; };

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** Promisified server.close, so the restart check can prove the FIRST daemon's clock
 * (and its own pomodoro engine, closed via the 'close' listener src/server.mjs wires)
 * is really gone before the second one starts against the same home. */
function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

async function main() {
  // -------------------------------------------------------------------------------
  // formatCountdown -- the mm:ss formatter the index page (a later ticket) reuses.
  // -------------------------------------------------------------------------------

  await check('formatCountdown: zero is 00:00', () => {
    assert.equal(formatCountdown(0), '00:00');
  });

  await check('formatCountdown: minutes and seconds both zero-padded', () => {
    assert.equal(formatCountdown(90_000), '01:30'); // 90s
    assert.equal(formatCountdown(5_000), '00:05');
    assert.equal(formatCountdown(25 * 60_000), '25:00'); // a full work interval
  });

  await check('formatCountdown: rounds to the nearest second', () => {
    assert.equal(formatCountdown(59_500), '01:00'); // 59.5s rounds up to a full minute
    assert.equal(formatCountdown(59_400), '00:59');
  });

  await check('formatCountdown: negative/expired input clamps to 00:00, never a minus sign', () => {
    assert.equal(formatCountdown(-5_000), '00:00');
  });

  // -------------------------------------------------------------------------------
  // localDateStr -- local time, not UTC, and correctly zero-padded at both ends of
  // a year (where an off-by-one in month/day math is easiest to miss).
  // -------------------------------------------------------------------------------

  await check('localDateStr: YYYY-MM-DD, zero-padded', () => {
    assert.equal(localDateStr(new Date(2026, 0, 1, 12, 0, 0).getTime()), '2026-01-01');
    assert.equal(localDateStr(new Date(2026, 11, 31, 23, 59, 0).getTime()), '2026-12-31');
    assert.equal(localDateStr(new Date(2026, 7, 4, 0, 0, 1).getTime()), '2026-08-04');
  });

  await check('localDateStr: reads local wall-clock fields, not the UTC ones', () => {
    // A local midnight-ish instant whose UTC calendar date is the PREVIOUS day proves
    // this isn't secretly calling the UTC accessors: getFullYear/getMonth/getDate on a
    // Date object are already local by spec, but a future edit swapping them for
    // getUTCFullYear/etc would still pass every test above run on a UTC-negative-offset
    // machine and fail only here.
    const local2359 = new Date(2026, 2, 15, 23, 59, 0); // local: 2026-03-15 23:59
    assert.equal(localDateStr(local2359.getTime()), '2026-03-15');
  });

  // -------------------------------------------------------------------------------
  // The pomodoro day and its rollover (ADR 67), in isolation. `now` is an argument
  // everywhere below, so every one of these runs the same at any hour the suite is
  // started -- including between midnight and 05:00, which is a real pomodoro day
  // boundary case and not merely an odd time to run tests.
  // -------------------------------------------------------------------------------

  await check('DAY_START_HOUR: the boundary is 05:00, stated as a constant and not as a setting', () => {
    assert.equal(DAY_START_HOUR, 5);
    // The half that matters more than the value: no settings key names it, so there is
    // nothing to configure and nothing that can change under an already-stamped
    // cycleDate. mergeSettings drops unknown keys, so a patch trying to set one is
    // silently ignored rather than stored -- assert the stored settings, not the throw.
    assert.equal('dayStartHour' in DEFAULT_SETTINGS, false);
    const patched = mergeSettings(defaultDoc(), { dayStartHour: 9 });
    assert.equal('dayStartHour' in patched.settings, false, 'the day boundary must not be reachable through the settings route');
  });

  await check('pomodoroDay: 05:00 starts the new day; everything before it still belongs to the previous one', () => {
    assert.equal(pomodoroDay(new Date(2026, 7, 4, 5, 0, 0).getTime()), '2026-08-04', '05:00 exactly is the new day');
    assert.equal(pomodoroDay(new Date(2026, 7, 4, 4, 59, 59).getTime()), '2026-08-03', 'a second before 05:00 is still yesterday');
    assert.equal(pomodoroDay(new Date(2026, 7, 4, 23, 0, 0).getTime()), '2026-08-04', 'the evening belongs to the day it is the evening of');
    assert.equal(pomodoroDay(new Date(2026, 7, 5, 0, 5, 0).getTime()), '2026-08-04', 'past midnight is not past the boundary');
  });

  await check('pomodoroDay: rolling back across a month and a year boundary, not just a day', () => {
    // 03:00 on the 1st belongs to the last day of the previous month -- the arithmetic
    // Date.setDate does for us, and the one an off-by-one would produce '2026-08-00' for.
    assert.equal(pomodoroDay(new Date(2026, 7, 1, 3, 0, 0).getTime()), '2026-07-31');
    assert.equal(pomodoroDay(new Date(2026, 0, 1, 3, 0, 0).getTime()), '2025-12-31');
  });

  await check('rollDay: the same pomodoro day is untouched, by reference (no needless write)', () => {
    const now = new Date(2026, 7, 4, 14, 0, 0).getTime();
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 60_000, paused: false } };
    assert.equal(rollDay(doc, now), doc);
  });

  await check('rollDay: a timer paused at 23:00 is gone the first time the document is rolled after 05:00 the next day, and the cycle is back to zero', () => {
    // Criteria 1 and 2, at the pure layer: one rule, both halves of the loop.
    const evening = new Date(2026, 7, 4, 23, 0, 0).getTime();
    const paused = { ...defaultDoc(), cycle: 3, cycleDate: pomodoroDay(evening), timer: { phase: 'work', paused: true, remainingMs: 12 * 60_000 } };
    const next = rollDay(paused, new Date(2026, 7, 5, 5, 0, 1).getTime());
    assert.equal(next.timer, null, 'a paused timer never expires on its own -- the day ending is what clears it');
    assert.equal(next.cycle, 0);
    assert.equal(next.cycleDate, '2026-08-05');
  });

  await check('rollDay: a timer paused at 02:00 is still there at 04:00 -- the previous day has not ended yet', () => {
    const twoAm = new Date(2026, 7, 5, 2, 0, 0).getTime();
    const paused = { ...defaultDoc(), cycle: 1, cycleDate: pomodoroDay(twoAm), timer: { phase: 'work', paused: true, remainingMs: 8 * 60_000 } };
    assert.equal(paused.cycleDate, '2026-08-04', 'sanity: a timer paused at 02:00 belongs to the previous date');
    const atFour = rollDay(paused, new Date(2026, 7, 5, 4, 0, 0).getTime());
    assert.equal(atFour, paused, 'nothing has crossed, so not even a new object');
    // ...and the same document one hour later is a different story entirely.
    assert.equal(rollDay(paused, new Date(2026, 7, 5, 5, 0, 0).getTime()).timer, null);
  });

  await check('rollDay: a work interval running at 23:55 is unaffected at 00:05 -- midnight is not a boundary', () => {
    const late = new Date(2026, 7, 4, 23, 55, 0).getTime();
    const running = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(late), timer: { phase: 'work', deadline: late + 20 * 60_000, paused: false } };
    const past = rollDay(running, new Date(2026, 7, 5, 0, 5, 0).getTime());
    assert.equal(past, running, 'the calendar date changed and the pomodoro day did not');
    assert.equal(past.cycle, 2, 'the cycle count survives midnight');
  });

  await check('rollDay: a missing cycleDate (a document written before this rule existed) reads as stale', () => {
    const now = Date.now();
    const next = rollDay({ ...defaultDoc(), cycle: 3, timer: { phase: 'break', deadline: now + 60_000, paused: false } }, now);
    assert.equal(next.cycle, 0);
    assert.equal(next.timer, null);
    assert.equal(next.cycleDate, pomodoroDay(now));
  });

  // -------------------------------------------------------------------------------
  // settleBoundary -- the loop across a full N-break run
  // (default longEvery: 4) including the long break and the reset after it.
  // -------------------------------------------------------------------------------

  await check('settleBoundary: a full work/break loop, every 4th break long, cycle resets after it', () => {
    const t0 = new Date(2026, 7, 4, 9, 0, 0).getTime();
    let doc = { ...defaultDoc(), cycleDate: pomodoroDay(t0), timer: { phase: 'work', deadline: t0, paused: false } };

    // (finishedPhase, expected next phase, expected cycle AFTER the transition)
    const steps = [
      ['work', 'break', 0],
      ['break', 'work', 1],
      ['work', 'break', 1],
      ['break', 'work', 2],
      ['work', 'break', 2],
      ['break', 'work', 3],
      ['work', 'longBreak', 3], // 4th break is long
      ['longBreak', 'work', 0], // cycle resets after the long break
    ];

    for (const [expectFinished, expectPhase, expectCycle] of steps) {
      assert.equal(doc.timer.phase, expectFinished, 'sanity: the interval about to end is the one the table expects');
      const { doc: next, boundary } = settleBoundary(doc, doc.timer.deadline); // exactly on time: late === 0
      assert.deepEqual(boundary, { phase: expectPhase });
      assert.equal(next.timer.phase, expectPhase);
      assert.equal(next.cycle, expectCycle);
      assert.ok(next.timer.deadline > doc.timer.deadline, 'each transition schedules a NEW deadline in the future');
      doc = next;
    }
  });

  await check('settleBoundary: durations come from settings (work/break/longBreak minutes all distinct)', () => {
    const t0 = Date.now();
    const settings = { ...DEFAULT_SETTINGS, workMin: 25, breakMin: 5, longBreakMin: 15 };
    const workDoc = { ...defaultDoc(), settings, cycleDate: pomodoroDay(t0), timer: { phase: 'work', deadline: t0, paused: false } };
    const { doc: afterWork } = settleBoundary(workDoc, t0);
    assert.equal(afterWork.timer.deadline - t0, 5 * 60_000); // break

    const longBreakDoc = { ...defaultDoc(), settings, cycle: 3, cycleDate: pomodoroDay(t0), timer: { phase: 'work', deadline: t0, paused: false } };
    const { doc: afterFourth } = settleBoundary(longBreakDoc, t0);
    assert.equal(afterFourth.timer.phase, 'longBreak');
    assert.equal(afterFourth.timer.deadline - t0, 15 * 60_000);
  });

  await check('settleBoundary: a boundary crossed just past midnight keeps the cycle it was counting -- midnight is not a day boundary', () => {
    // Criterion 3, at the boundary rather than at rollDay: cycle=3 dated the 3rd, an
    // interval ending at 00:00:05 on the 4th. The pomodoro day is still the 3rd, so
    // breakNumber is 3+1=4 and the break that begins is the LONG one. Under the retired
    // local-midnight rule this reset to 0 first and produced an ordinary break -- i.e.
    // the reader lost three banked pomodoros mid-stride for working past midnight.
    const now = new Date(2026, 7, 4, 0, 0, 5).getTime();
    const doc = { ...defaultDoc(), cycle: 3, cycleDate: '2026-08-03', timer: { phase: 'work', deadline: now - 1000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next.cycleDate, '2026-08-03', 'the document still belongs to the day it started in');
    assert.equal(next.cycle, 3);
    assert.deepEqual(boundary, { phase: 'longBreak' });
  });

  await check('settleBoundary: a deadline landing after 05:00 ends the loop instead of advancing it -- no next phase, no boundary reported', () => {
    // The rollover outranks the advance rule: nothing is promoted to a break at 05:00,
    // and nothing is notified about, because there is nobody there to take it.
    const now = new Date(2026, 7, 5, 5, 0, 5).getTime();
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: '2026-08-04', timer: { phase: 'work', deadline: now - 1_000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next.timer, null);
    assert.equal(next.cycle, 0);
    assert.equal(next.cycleDate, '2026-08-05');
    assert.equal(boundary, null, 'a rollover fires no notification -- it is not a phase change');
  });

  await check('settleBoundary: a PAUSED timer from a day that has ended is cleared too -- the rollover is checked before the paused guard', () => {
    // The exact defect ADR 67 names. `paused` returns the document untouched two lines
    // into this function, and a paused timer has no deadline to expire, so a rollover
    // checked anywhere after that guard would never reach a paused timer at all.
    const now = new Date(2026, 7, 5, 9, 0, 0).getTime();
    const paused = { ...defaultDoc(), cycleDate: '2026-08-04', timer: { phase: 'work', paused: true, remainingMs: 60_000 } };
    const { doc: next, boundary } = settleBoundary(paused, now);
    assert.equal(next.timer, null);
    assert.equal(boundary, null);
  });

  await check('settleBoundary: not yet due is a no-op, by reference (no needless write)', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 60_000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next, doc);
    assert.equal(boundary, null);
  });

  await check('settleBoundary: no timer, or a paused timer, is a no-op within the same pomodoro day', () => {
    const now = Date.now();
    const idle = { ...defaultDoc(), cycleDate: pomodoroDay(now) };
    assert.equal(settleBoundary(idle, now).doc, idle);
    const paused = { ...idle, timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 5_000 } };
    const { doc: next, boundary } = settleBoundary(paused, now);
    assert.equal(next, paused);
    assert.equal(boundary, null);
  });

  // -------------------------------------------------------------------------------
  // The expiry rule -- the whole reason this is a wall-clock deadline
  // rather than a countdown of remaining seconds.
  // -------------------------------------------------------------------------------

  await check('settleBoundary: a deadline past the grace period expires -- no advance, no boundary', () => {
    const deadline = Date.now() - (EXPIRY_GRACE_MS + 1);
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(Date.now()), timer: { phase: 'work', deadline, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, Date.now());
    assert.equal(next.timer, null);
    assert.equal(boundary, null);
    // cycle/cycleDate untouched: a lunch break must not cost pomodoros already banked.
    assert.equal(next.cycle, 2);
  });

  await check('settleBoundary: right at the grace boundary (late === EXPIRY_GRACE_MS exactly) still advances', () => {
    const now = Date.now();
    const deadline = now - EXPIRY_GRACE_MS; // late === grace, not GREATER than it
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.notEqual(next.timer, null);
    assert.notEqual(boundary, null);
  });

  await check('settleBoundary: a deadline just inside the grace period advances normally', () => {
    const now = Date.now();
    const deadline = now - (EXPIRY_GRACE_MS - 1);
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.notEqual(next.timer, null);
    assert.deepEqual(boundary, { phase: 'break' });
  });

  // The three checks immediately above all phrase staleness as EXPIRY_GRACE_MS plus
  // or minus a handful of milliseconds. That pins the `>` vs `>=` boundary exactly,
  // which is what it is for -- but every one of them moves in lockstep with the
  // constant, so read alone they describe the rule's SHAPE and say nothing about its
  // SCALE. The two below write staleness as an absolute duration, naming no constant,
  // and are the ones that would still fail if EXPIRY_GRACE_MS were rescaled to hours
  // -- i.e. if a lid closed over lunch started firing the break you slept through,
  // which is the exact failure this rule exists to forbid.

  await check('settleBoundary: a deadline 4 hours stale (lid closed over lunch) expires -- no advance, no boundary', () => {
    const now = Date.now();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - FOUR_HOURS_MS, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next.timer, null);
    assert.equal(boundary, null);
    assert.equal(next.cycle, 2); // still not costing banked pomodoros
  });

  await check('settleBoundary: a deadline 5 seconds stale (an ordinary late timer) advances normally', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - 5_000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.notEqual(next.timer, null);
    assert.deepEqual(boundary, { phase: 'break' });
  });

  await check('EXPIRY_GRACE_MS itself is a handful of seconds, not fractions of one and not minutes', () => {
    // Below this range, ordinary event-loop slack (a GC pause, a busy tick) would
    // expire a perfectly healthy timer instead of advancing it; above it, real sleep
    // -- minutes at the very least -- would be miscounted as "still basically on
    // time" and fire a stale boundary, which is the exact failure this rule exists
    // to forbid. This does not replace the two absolute-duration checks above; it is
    // the one assertion that catches a rescaling of the constant even before any
    // deadline math runs.
    assert.ok(EXPIRY_GRACE_MS >= 1_000, 'too small: event-loop slack alone would expire healthy timers');
    assert.ok(EXPIRY_GRACE_MS <= 60_000, 'too large: real sleep would be miscounted as on-time');
  });

  // -------------------------------------------------------------------------------
  // forwardTimer -- forward is the boundary made early. It reuses
  // settleBoundary's own advance rule at click time rather than a second bookkeeping
  // path, so these checks pin the SAME cycle bookkeeping settleBoundary's own loop
  // check above pins, just triggered by a click instead of a real deadline.
  // -------------------------------------------------------------------------------

  await check('forwardTimer: idle is a no-op, by reference -- nothing thrown, nothing invented', () => {
    const doc = defaultDoc();
    assert.equal(forwardTimer(doc, Date.now()), doc);
  });

  await check('forwardTimer: a running work interval ends immediately and begins its break', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 20 * 60_000, paused: false } };
    const next = forwardTimer(doc, now);
    assert.equal(next.timer.phase, 'break');
    assert.equal(next.timer.paused, false, 'the next phase starts running');
    assert.equal(next.timer.deadline, now + DEFAULT_SETTINGS.breakMin * 60_000);
  });

  // Criterion 11 (ADR 82): forwarding a paused Timer must land paused at the start of
  // the next phase, with that phase's FULL duration remaining -- not the runnable
  // interval the old code produced, and not whatever sliver of `remainingMs` the paused
  // timer happened to be carrying (30s here, deliberately far from a full break).
  await check('forwardTimer: forwarding a PAUSED timer lands PAUSED at the next phase, with its full duration in remainingMs (ADR 82)', () => {
    const now = Date.now();
    // The real shape pauseTimer leaves behind: no deadline, remainingMs instead.
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', paused: true, remainingMs: 30_000 } };
    const next = forwardTimer(doc, now);
    assert.equal(next.timer.phase, 'break');
    assert.equal(next.timer.paused, true, 'forward must not un-pause');
    assert.equal(next.timer.remainingMs, DEFAULT_SETTINGS.breakMin * 60_000, 'the FULL next phase, not the stale remainder');
    assert.equal('deadline' in next.timer, false, 'a paused timer has no deadline, same shape pauseTimer leaves');
  });

  await check('forwardTimer: long-break cadence intact across a full loop -- forwarded work still earns its break, forwarded break still increments the cycle, forwarded long break resets it', () => {
    const t0 = new Date(2026, 7, 4, 9, 0, 0).getTime();
    let doc = { ...defaultDoc(), cycleDate: pomodoroDay(t0), timer: { phase: 'work', deadline: t0 + 999_000, paused: false } };
    let now = t0;

    // (expected next phase, expected cycle AFTER the click) -- same shape and same
    // steps as settleBoundary's own full-loop check above, driven by forwardTimer
    // clicks (arbitrarily far from each interval's real deadline) instead of a real
    // boundary, which is the whole point: the bookkeeping must not care which one fired.
    const steps = [
      ['break', 0],
      ['work', 1],
      ['break', 1],
      ['work', 2],
      ['break', 2],
      ['work', 3],
      ['longBreak', 3], // 4th break is long
      ['work', 0], // cycle resets after the long break
    ];

    for (const [expectPhase, expectCycle] of steps) {
      now += 1_000; // each click lands at a distinct, arbitrary "now" -- never the real deadline
      const next = forwardTimer(doc, now);
      assert.equal(next.timer.phase, expectPhase);
      assert.equal(next.cycle, expectCycle);
      assert.equal(next.timer.paused, false);
      doc = next;
    }
  });

  await check('forwardTimer: the same cadence holds PAUSED -- a paused loop advances phase and cycle exactly like the running one, and never un-pauses along the way', () => {
    const t0 = new Date(2026, 7, 4, 9, 0, 0).getTime();
    // Starts paused, with a deliberately odd remainingMs -- proof each step re-mints
    // a FULL duration rather than carrying the previous step's number forward.
    let doc = { ...defaultDoc(), cycleDate: pomodoroDay(t0), timer: { phase: 'work', paused: true, remainingMs: 7_000 } };
    let now = t0;

    const steps = [
      ['break', 0, DEFAULT_SETTINGS.breakMin],
      ['work', 1, DEFAULT_SETTINGS.workMin],
      ['break', 1, DEFAULT_SETTINGS.breakMin],
      ['work', 2, DEFAULT_SETTINGS.workMin],
      ['break', 2, DEFAULT_SETTINGS.breakMin],
      ['work', 3, DEFAULT_SETTINGS.workMin],
      ['longBreak', 3, DEFAULT_SETTINGS.longBreakMin],
      ['work', 0, DEFAULT_SETTINGS.workMin],
    ];

    for (const [expectPhase, expectCycle, expectMin] of steps) {
      now += 1_000;
      const next = forwardTimer(doc, now);
      assert.equal(next.timer.phase, expectPhase);
      assert.equal(next.cycle, expectCycle);
      assert.equal(next.timer.paused, true, `${expectPhase}: still paused`);
      assert.equal(next.timer.remainingMs, expectMin * 60_000, `${expectPhase}: full duration, not carried over`);
      doc = next;
    }
  });

  // -------------------------------------------------------------------------------
  // restartTimer -- re-mints the CURRENT interval's deadline to a full phase
  // duration; phase and cycle are untouched, and it shares forward's
  // edge rules.
  // -------------------------------------------------------------------------------

  await check('restartTimer: idle is a no-op, by reference -- nothing thrown, nothing invented', () => {
    const doc = defaultDoc();
    assert.equal(restartTimer(doc, Date.now()), doc);
  });

  await check('restartTimer: re-mints the deadline to a full interval of the CURRENT phase, read from current settings -- phase and cycle untouched', () => {
    const now = Date.now();
    const settings = { ...DEFAULT_SETTINGS, workMin: 11, breakMin: 3, longBreakMin: 22 };
    for (const [phase, key] of [['work', 'workMin'], ['break', 'breakMin'], ['longBreak', 'longBreakMin']]) {
      const doc = { ...defaultDoc(), settings, cycle: 2, cycleDate: '2026-08-01', timer: { phase, deadline: now - 500_000, paused: false } };
      const next = restartTimer(doc, now);
      assert.equal(next.timer.phase, phase, 'phase untouched');
      assert.equal(next.timer.deadline, now + settings[key] * 60_000, `deadline re-minted to a full ${key}`);
      assert.equal(next.timer.paused, false);
      assert.equal(next.cycle, 2, 'cycle untouched');
      assert.equal(next.cycleDate, '2026-08-01', 'cycleDate untouched');
    }
  });

  // Criterion 12 (ADR 82): restarting a paused Timer re-mints the CURRENT phase and
  // stays paused -- it re-mints `remainingMs`, not a `deadline`, and to the phase's
  // FULL duration rather than whatever sliver (4s here) the paused timer was carrying.
  await check('restartTimer: a PAUSED timer re-mints remainingMs to a full interval of the CURRENT phase and stays paused (ADR 82)', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: '2026-08-01', timer: { phase: 'break', paused: true, remainingMs: 4_000 } };
    const next = restartTimer(doc, now);
    assert.equal(next.timer.phase, 'break', 'phase untouched');
    assert.equal(next.timer.paused, true, 'restart must not un-pause');
    assert.equal(next.timer.remainingMs, DEFAULT_SETTINGS.breakMin * 60_000, 'the FULL phase, not the stale remainder');
    assert.equal('deadline' in next.timer, false, 'a paused timer has no deadline, same shape pauseTimer leaves');
    assert.equal(next.cycle, 2, 'cycle untouched');
    assert.equal(next.cycleDate, '2026-08-01', 'cycleDate untouched');
  });

  await check('restartTimer: PAUSED holds across every phase and custom settings, same as the running case above', () => {
    const now = Date.now();
    const settings = { ...DEFAULT_SETTINGS, workMin: 11, breakMin: 3, longBreakMin: 22 };
    for (const [phase, key] of [['work', 'workMin'], ['break', 'breakMin'], ['longBreak', 'longBreakMin']]) {
      const doc = { ...defaultDoc(), settings, cycle: 2, cycleDate: '2026-08-01', timer: { phase, paused: true, remainingMs: 500 } };
      const next = restartTimer(doc, now);
      assert.equal(next.timer.phase, phase, 'phase untouched');
      assert.equal(next.timer.paused, true);
      assert.equal(next.timer.remainingMs, settings[key] * 60_000, `remainingMs re-minted to a full ${key}`);
      assert.equal('deadline' in next.timer, false);
      assert.equal(next.cycle, 2, 'cycle untouched');
    }
  });

  await check('restartTimer: a deadline hours stale is simply re-minted, never treated as expired -- restart bypasses settleBoundary\'s grace rule entirely', () => {
    const now = Date.now();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const doc = { ...defaultDoc(), cycle: 1, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - FOUR_HOURS_MS, paused: false } };
    const next = restartTimer(doc, now);
    assert.notEqual(next.timer, null, 'restart never discards the timer the way an expired settleBoundary would');
    assert.equal(next.timer.phase, 'work');
    assert.equal(next.timer.deadline, now + DEFAULT_SETTINGS.workMin * 60_000);
    assert.equal(next.cycle, 1);
  });

  // -------------------------------------------------------------------------------
  // startWork -- the "ensure, not start" rule, pure half.
  // -------------------------------------------------------------------------------

  await check('startWork: begins a fresh work interval when there is no timer at all', () => {
    const now = Date.now();
    const next = startWork(onDoc(), now);
    assert.equal(next.timer.phase, 'work');
    assert.equal(next.timer.deadline, now + DEFAULT_SETTINGS.workMin * 60_000);
  });

  await check('startWork: a running timer is untouched, by reference', () => {
    const now = Date.now();
    const doc = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 60_000, paused: false } };
    assert.equal(startWork(doc, now), doc);
  });

  await check('startWork: a paused timer from the CURRENT pomodoro day is untouched -- starting during a pause does not resume or restart it', () => {
    const now = Date.now();
    const doc = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 12_000 } };
    assert.equal(startWork(doc, now), doc);
  });

  await check('startWork: a timer mid-break is untouched -- starting during a break does not cut it short', () => {
    const now = Date.now();
    const doc = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: now + 120_000, paused: false } };
    assert.equal(startWork(doc, now), doc);
  });

  await check('startWork: a paused timer from a day that has ended is rolled away AND a fresh work interval started, in one call', () => {
    // Criterion 6's pure half, and the other side of the check above: "leave whatever is
    // already there alone" only ever meant a timer from the day being worked. The
    // morning's first session must not need a second call (nor a click) to get a timer.
    const morning = new Date(2026, 7, 5, 9, 0, 0).getTime();
    const lastNight = { ...onDoc(), cycle: 3, cycleDate: '2026-08-04', timer: { phase: 'work', paused: true, remainingMs: 12_000 } };
    const next = startWork(lastNight, morning);
    assert.equal(next.timer.phase, 'work');
    assert.equal(next.timer.paused, false, 'the morning\'s first session leaves a timer RUNNING, not a resumed pause');
    assert.equal(next.timer.deadline, morning + DEFAULT_SETTINGS.workMin * 60_000, 'a full fresh interval, not last night\'s remainder');
    assert.equal(next.cycle, 0);
    assert.equal(next.cycleDate, '2026-08-05');
  });

  // -------------------------------------------------------------------------------
  // DEFAULT_SETTINGS / normalizeDoc -- the three per-phase cue defaults and the
  // `sound` migration. Driven directly through
  // normalizeDoc: it's a pure function of whatever JSON.parse would have handed
  // back, so none of this needs a real file or a temp dir.
  // -------------------------------------------------------------------------------

  await check('DEFAULT_SETTINGS: no sound key, and three DIFFERENT per-phase cues', () => {
    assert.equal('sound' in DEFAULT_SETTINGS, false);
    const { cueWork, cueBreak, cueLongBreak } = DEFAULT_SETTINGS;
    for (const v of [cueWork, cueBreak, cueLongBreak]) assert.equal(typeof v, 'string');
    // "Starts with three different cues" -- a picker offering the same
    // sound under three different labels would satisfy every other assertion here
    // and still fail the actual point of the feature (telling phases apart by ear).
    assert.notEqual(cueWork, cueBreak);
    assert.notEqual(cueBreak, cueLongBreak);
    assert.notEqual(cueWork, cueLongBreak);
  });

  await check('normalizeDoc: no settings at all (fresh machine) gets the three distinct cue defaults, no sound key', () => {
    const settings = normalizeDoc(null).settings;
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.equal('sound' in settings, false);
  });

  await check('normalizeDoc: settings present but sound absent entirely also takes the fresh-machine defaults', () => {
    // Distinct from "sound: false" below -- an absent key is not a falsy value, and
    // the two must not collapse into the same behaviour (ablation: `'sound' in
    // parsedSettings` swapped for `parsedSettings.sound` would fail to distinguish
    // "never had a sound key" from "sound: false", and this is the check that would
    // catch it -- undefined cueWork/cueBreak/cueLongBreak here would silently equal
    // the "None on all three" migration's own output for two of the three keys by
    // coincidence, so the DIFFERENT defaults below are what actually proves it).
    const settings = normalizeDoc({ settings: { workMin: 40 } }).settings;
    assert.equal('sound' in settings, false);
    assert.equal(settings.cueWork, DEFAULT_SETTINGS.cueWork);
    assert.equal(settings.cueBreak, DEFAULT_SETTINGS.cueBreak);
    assert.equal(settings.cueLongBreak, DEFAULT_SETTINGS.cueLongBreak);
    assert.equal(settings.workMin, 40, 'sanity: an unrelated field survives normalization untouched');
  });

  await check('normalizeDoc: sound: true migrates to Glass on all three phases, and sound does not survive', () => {
    const settings = normalizeDoc({ settings: { sound: true } }).settings;
    assert.equal(settings.cueWork, 'Glass');
    assert.equal(settings.cueBreak, 'Glass');
    assert.equal(settings.cueLongBreak, 'Glass');
    assert.equal('sound' in settings, false, 'no document is left holding a sound key that still does something');
  });

  await check('normalizeDoc: sound: false migrates to None on all three phases, and sound does not survive', () => {
    const settings = normalizeDoc({ settings: { sound: false } }).settings;
    assert.equal(settings.cueWork, NO_CUE);
    assert.equal(settings.cueBreak, NO_CUE);
    assert.equal(settings.cueLongBreak, NO_CUE);
    assert.equal('sound' in settings, false);
  });

  await check('normalizeDoc: an already-migrated document with a hand-edited sound key back doesn\'t clobber cues it already states', () => {
    // A document that already carries its own cueWork (chosen by hand after an
    // earlier migration already ran) and THEN, by some later hand edit, has `sound`
    // reintroduced beside it. Deliberate choice: the sound-derived value only fills
    // in whatever the document does not already state, the same "explicit beats
    // default" precedence DEFAULT_SETTINGS itself already gets below the parsed
    // settings -- a resurrected `sound: true` must not silently overwrite a cue the
    // reader actually picked. cueBreak/cueLongBreak were never stated, so THOSE still
    // take the sound migration's word for it.
    const settings = normalizeDoc({ settings: { sound: true, cueWork: 'Blow' } }).settings;
    assert.equal(settings.cueWork, 'Blow', 'an explicitly-present cue survives a resurrected sound key untouched');
    assert.equal(settings.cueBreak, 'Glass');
    assert.equal(settings.cueLongBreak, 'Glass');
    assert.equal('sound' in settings, false);
  });

  // -------------------------------------------------------------------------------
  // bannerLevel -- the Stranded round's own four-step gate, replacing the retired
  // binary notifyRounds checkbox (ADR.md entry 58, ADR 106), independent of `notify` in
  // both directions (criterion 17). `notify` itself is covered against the real daemon
  // in test/check-http.mjs; these are the pure-logic half: the closed set, the default,
  // the predicate, the notifyRounds migration on read, and the merge boundary
  // (criterion 7: migration and the named-400 refusal).
  // -------------------------------------------------------------------------------

  await check('BANNER_LEVELS: the closed set, in strictly monotone order', () => {
    assert.deepEqual(BANNER_LEVELS, ['off', 'no-board', 'this-board', 'always']);
  });

  await check('DEFAULT_SETTINGS: bannerLevel defaults to this-board -- byte-for-byte the retired notifyRounds: true behavior', () => {
    assert.equal(DEFAULT_SETTINGS.bannerLevel, 'this-board');
  });

  await check('bannerLevel: an explicit valid level wins outright, every level round-trips', () => {
    for (const level of BANNER_LEVELS) assert.equal(bannerLevel({ bannerLevel: level }), level);
  });

  await check('bannerLevel: no settings object at all reads as the default', () => {
    assert.equal(bannerLevel(undefined), 'this-board', 'no settings object at all must still read as the default');
    assert.equal(bannerLevel(null), 'this-board');
  });

  await check('bannerLevel: an invalid/hand-mangled level falls back to the default, same coercion every other setting gets', () => {
    assert.equal(bannerLevel({ bannerLevel: 'sometimes' }), 'this-board');
    assert.equal(bannerLevel({ bannerLevel: 42 }), 'this-board');
  });

  await check('bannerLevel: legacy notifyRounds migrates -- true/absent to the default level, false to Off (criterion 7)', () => {
    assert.equal(bannerLevel({ notifyRounds: true }), 'this-board');
    assert.equal(bannerLevel({ notifyRounds: false }), 'off');
    // A settings file written before this field existed carries no notifyRounds key
    // at all -- the exact "reader who never opens settings" constraint -- and must
    // still read as the default, not off and not undefined.
    assert.equal(bannerLevel({}), 'this-board', 'a missing key must read as the default, not off');
    assert.equal(bannerLevel({ notifyRounds: 'nope' }), 'this-board', 'a non-boolean garbage value must not be mistaken for off');
  });

  await check('bannerLevel: an explicit bannerLevel wins over a legacy notifyRounds riding alongside it', () => {
    assert.equal(bannerLevel({ bannerLevel: 'always', notifyRounds: false }), 'always');
    assert.equal(bannerLevel({ bannerLevel: 'off', notifyRounds: true }), 'off');
  });

  await check('normalizeDoc: a document with no bannerLevel or notifyRounds key at all (written before either existed) reads as the default', () => {
    const settings = normalizeDoc({ settings: { workMin: 40 } }).settings;
    assert.equal(settings.bannerLevel, 'this-board');
    assert.equal('notifyRounds' in settings, false, 'the retired key must not survive normalization');
  });

  await check('normalizeDoc: migration -- an existing settings document with notifyRounds true lands on the default level (criterion 7)', () => {
    const settings = normalizeDoc({ settings: { notifyRounds: true } }).settings;
    assert.equal(settings.bannerLevel, 'this-board');
    assert.equal('notifyRounds' in settings, false);
  });

  await check('normalizeDoc: migration -- an existing settings document with notifyRounds false lands on Off (criterion 7)', () => {
    const settings = normalizeDoc({ settings: { notifyRounds: false } }).settings;
    assert.equal(settings.bannerLevel, 'off');
    assert.equal('notifyRounds' in settings, false);
  });

  await check('normalizeDoc: an explicit bannerLevel survives normalization untouched, and wins over a legacy notifyRounds riding alongside it', () => {
    const settings = normalizeDoc({ settings: { bannerLevel: 'always', notifyRounds: false } }).settings;
    assert.equal(settings.bannerLevel, 'always');
    assert.equal('notifyRounds' in settings, false);
  });

  await check('normalizeDoc: a hand-edited bannerLevel outside the closed set falls back to the default, same coercion every other setting gets', () => {
    const settings = normalizeDoc({ settings: { bannerLevel: 'sometimes' } }).settings;
    assert.equal(settings.bannerLevel, 'this-board');
  });

  await check('mergeSettings: patching notify alone leaves bannerLevel untouched', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, bannerLevel: 'off' } };
    const next = mergeSettings(doc, { notify: false });
    assert.equal(next.settings.notify, false);
    assert.equal(next.settings.bannerLevel, 'off', 'must survive a patch that never mentions it');
  });

  await check('mergeSettings: patching bannerLevel alone leaves notify untouched -- independent in the other direction too', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, notify: false } };
    const next = mergeSettings(doc, { bannerLevel: 'always' });
    assert.equal(next.settings.bannerLevel, 'always');
    assert.equal(next.settings.notify, false, 'must survive a patch that never mentions it');
  });

  await check('mergeSettings: every level in the closed set is accepted', () => {
    for (const level of BANNER_LEVELS) {
      assert.equal(mergeSettings(defaultDoc(), { bannerLevel: level }).settings.bannerLevel, level);
    }
  });

  await check('mergeSettings: an unknown bannerLevel is refused, named in the message, and changes nothing (criterion 7)', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, bannerLevel: 'no-board' } };
    assert.throws(() => mergeSettings(doc, { bannerLevel: 'sometimes' }), /settings\.bannerLevel/);
    // A refusal is total: nothing from a rejected patch is applied, so a valid key
    // riding alongside a bad one does not land either -- same contract every other
    // validated key in this function gets.
    assert.throws(() => mergeSettings(doc, { notify: false, bannerLevel: 'sometimes' }), /settings\.bannerLevel/);
    // mergeSettings never mutates its argument, so the document it was handed reads
    // back exactly as it started -- the HTTP route's own "nothing persists" guarantee
    // one layer down from here.
    assert.equal(doc.settings.bannerLevel, 'no-board');
  });

  await check('mergeSettings: a patch carrying the retired notifyRounds key is silently dropped, the same as any other key this module no longer recognizes', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, bannerLevel: 'this-board' } };
    const next = mergeSettings(doc, { notifyRounds: false });
    assert.equal(next.settings.bannerLevel, 'this-board', 'an unrecognized patch key must not silently change the level');
    assert.equal('notifyRounds' in next.settings, false);
  });

  // -------------------------------------------------------------------------------
  // menubarCountdown / menubarHidden -- the status item's two preferences.
  // Nothing reads them yet: the item and the settings panel are
  // later slices, so what is provable here is exactly what those slices will rest on --
  // the defaults, an older document that predates both keys, and the merge boundary.
  // The round trip through the HTTP surface is at the bottom of this file, against a
  // real daemon.
  // -------------------------------------------------------------------------------

  await check('DEFAULT_SETTINGS: the countdown shows by default and the item is not hidden', () => {
    assert.equal(DEFAULT_SETTINGS.menubarCountdown, true, 'the digits are most of why the item exists');
    assert.equal(DEFAULT_SETTINGS.menubarHidden, false, 'nobody has hidden anything on a fresh machine');
  });

  await check('normalizeDoc: a document written before either menu bar key existed normalises to the defaults, not to undefined', () => {
    // The upgrade case, and the one that matters: every settings file on disk today was
    // written without these two keys. `undefined` would read the same as `false` in a
    // client's `if (settings.menubarHidden)` AND be dropped from the JSON response
    // entirely by JSON.stringify -- so the failure would be a status item that never
    // shows its countdown, with nothing in the response to explain why.
    const settings = normalizeDoc({ settings: { workMin: 40, notify: false } }).settings;
    assert.equal(settings.menubarCountdown, true);
    assert.equal(settings.menubarHidden, false);
    assert.ok('menubarCountdown' in settings && 'menubarHidden' in settings, 'both keys must be PRESENT, not merely falsy-by-absence');
  });

  await check('normalizeDoc: explicit menu bar values survive untouched, and hand-edited garbage falls back to the default', () => {
    const chosen = normalizeDoc({ settings: { menubarCountdown: false, menubarHidden: true } }).settings;
    assert.equal(chosen.menubarCountdown, false, 'a reader who turned the countdown off keeps it off across a read');
    assert.equal(chosen.menubarHidden, true, 'and a hidden item stays hidden -- this is what survives a logout');

    const garbage = normalizeDoc({ settings: { menubarCountdown: 'yes', menubarHidden: 1 } }).settings;
    assert.equal(garbage.menubarCountdown, true, 'same coercion every other toggle gets');
    assert.equal(garbage.menubarHidden, false, '1 is not a boolean -- truthy is not the test here');
  });

  await check('readDoc: a pomodoro.json on disk with no menu bar keys reads them back as the defaults', () => {
    // The same upgrade case one layer out: real bytes on disk, written the way a version
    // before this work would have written them, read back through the function every
    // caller in the daemon actually uses. Its own temp home -- writing this shape into
    // the reader's real board home is the trap QUIRKS.md documents against `writeDoc`,
    // and it applies just as much to a raw writeFileSync of the same filename.
    const oldHome = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-old-'));
    try {
      const now = Date.now();
      writeFileSync(path.join(oldHome, 'pomodoro.json'), JSON.stringify({
        settings: { workMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 4, notify: true, notifyRounds: true, cueWork: NO_CUE, cueBreak: NO_CUE, cueLongBreak: NO_CUE },
        cycle: 1,
        // pomodoroDay, never localDateStr: the latter is yesterday's label for the five
        // hours after midnight, so the document would roll and this check would fail
        // before dawn and pass all day (QUIRKS.md).
        cycleDate: pomodoroDay(now),
        timer: null,
      }, null, 2), { mode: 0o600 });

      const doc = readDoc(oldHome, now);
      assert.equal(doc.settings.menubarCountdown, true);
      assert.equal(doc.settings.menubarHidden, false);
      // Also the notifyRounds migration seam, on the same old-shaped document.
      assert.equal(doc.settings.bannerLevel, 'this-board');
      assert.equal(doc.cycle, 1, 'and the rest of the document is untouched by the fill-in');
    } finally {
      rmSync(oldHome, { recursive: true, force: true });
    }
  });

  await check('mergeSettings: each menu bar key is patchable alone, leaving the other three toggles exactly as they were', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, notify: false, bannerLevel: 'off' } };
    const hidden = mergeSettings(doc, { menubarHidden: true });
    assert.equal(hidden.settings.menubarHidden, true);
    assert.equal(hidden.settings.menubarCountdown, true, 'hiding the item must not silently reset the countdown preference');
    assert.equal(hidden.settings.notify, false, 'and it touches neither banner control');
    assert.equal(hidden.settings.bannerLevel, 'off');

    const quiet = mergeSettings(doc, { menubarCountdown: false });
    assert.equal(quiet.settings.menubarCountdown, false);
    assert.equal(quiet.settings.menubarHidden, false);
  });

  await check('mergeSettings: a non-boolean menu bar value is refused by name, the same way every other toggle is', () => {
    assert.throws(() => mergeSettings(defaultDoc(), { menubarCountdown: 'off' }), /menubarCountdown/);
    assert.throws(() => mergeSettings(defaultDoc(), { menubarHidden: 1 }), /menubarHidden/);
    // A refusal is total: nothing from a rejected patch is applied, so a valid key
    // riding alongside a bad one does not land either.
    assert.throws(() => mergeSettings(defaultDoc(), { menubarHidden: true, menubarCountdown: null }), /menubarCountdown/);
  });

  // -------------------------------------------------------------------------------
  // enabled -- the Master switch. Pure semantics only: the default, the upgrade path
  // (a document with no key at all), the boundary guard against a hand-edited file
  // pairing `enabled: false` with a still-live timer, and the Rollover-style clearing
  // mergeSettings performs on the true -> false transition (and its absence in
  // reverse). The impure half -- ensureTimer refused while off, and the armed
  // setTimeout actually cancelled -- is a few sections further down, and the HTTP
  // surface is in test/check-http.mjs.
  // -------------------------------------------------------------------------------

  await check('DEFAULT_SETTINGS: the Master switch is off by default (ADR 105: the pomodoro ships off)', () => {
    assert.equal(DEFAULT_SETTINGS.enabled, false);
  });

  await check('normalizeDoc: a document with no enabled key at all reads as off -- same as a fresh install', () => {
    const settings = normalizeDoc({ settings: { workMin: 40 } }).settings;
    assert.equal(settings.enabled, false);
  });

  await check('normalizeDoc: an explicit enabled: true survives normalization untouched', () => {
    const settings = normalizeDoc({ settings: { enabled: true } }).settings;
    assert.equal(settings.enabled, true);
  });

  await check('normalizeDoc: a non-boolean enabled (hand-edited garbage) falls back to off, same coercion every other toggle gets', () => {
    const settings = normalizeDoc({ settings: { enabled: 'nope' } }).settings;
    assert.equal(settings.enabled, false);
  });

  await check('normalizeDoc: enabled: false forces the timer to null even when the document on disk still names a live one -- the boundary guard against a hand-edited file', () => {
    const now = Date.now();
    const parsed = {
      settings: { enabled: false },
      cycle: 2,
      cycleDate: pomodoroDay(now),
      timer: { phase: 'work', deadline: now + 60_000, paused: false },
    };
    const doc = normalizeDoc(parsed);
    assert.equal(doc.timer, null, 'no timer may exist while the document reads as off, however it got that way');
    assert.equal(doc.cycle, 2, 'the guard only clears the timer -- cycle bookkeeping is untouched by a read');
  });

  await check('mergeSettings: flipping enabled true -> false clears the Timer and resets the Cycle to zero, Rollover-style (ADR 67)', () => {
    const now = Date.now();
    const doc = { ...onDoc(), cycle: 3, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 300_000, paused: false } };
    const next = mergeSettings(doc, { enabled: false });
    assert.equal(next.timer, null);
    assert.equal(next.cycle, 0);
    assert.equal(next.settings.enabled, false);
    assert.equal(next.cycleDate, doc.cycleDate, 'the pomodoro day itself is untouched -- only rollDay changes that');
  });

  await check('mergeSettings: flipping enabled false -> true starts idle -- nothing is restored (ADR 90)', () => {
    const now = Date.now();
    const off = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, enabled: false }, cycle: 0, cycleDate: pomodoroDay(now), timer: null };
    const next = mergeSettings(off, { enabled: true });
    assert.equal(next.timer, null, 'no frozen timer is restored on re-enable');
    assert.equal(next.settings.enabled, true);
  });

  await check('mergeSettings: a patch that leaves enabled untouched never looks at the Timer -- the clearing is specific to the true -> false transition, not to every write', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 300_000, paused: false } };
    const next = mergeSettings(doc, { workMin: 33 });
    assert.equal(next.timer, doc.timer, 'a patch that never mentions enabled must not touch the running Timer, by reference');
  });

  await check('mergeSettings: a non-boolean enabled is rejected, naming the field, same validation every other toggle gets', () => {
    assert.throws(() => mergeSettings(defaultDoc(), { enabled: 'off' }), /enabled/);
  });

  await check('mergeSettings: patching enabled alone leaves every other toggle untouched', () => {
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, notify: false, bannerLevel: 'off', menubarHidden: true } };
    const next = mergeSettings(doc, { enabled: false });
    assert.equal(next.settings.notify, false);
    assert.equal(next.settings.bannerLevel, 'off', 'the round-banner safety net is a different key -- flipping enabled must not silently touch it');
    assert.equal(next.settings.menubarHidden, true);
  });

  await check('startWork: refuses to mint a timer when settings.enabled is false, by reference -- the daemon-side refusal a timer start is held to', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, enabled: false }, cycleDate: pomodoroDay(now) };
    assert.equal(startWork(doc, now), doc, 'idle stays idle -- no needless write, and nothing minted');
  });

  // -------------------------------------------------------------------------------
  // readDoc / writeDoc -- persistence, defaults, and the impure ensureTimer wrapper.
  // -------------------------------------------------------------------------------

  const home = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-'));

  await check('readDoc: a missing file reads as the documented defaults, never throws', () => {
    const doc = readDoc(path.join(home, 'does-not-exist'));
    assert.deepEqual(doc.settings, DEFAULT_SETTINGS);
    assert.equal(doc.cycle, 0);
    assert.equal(doc.timer, null);
  });

  await check('readDoc: an unparseable file also reads as the defaults, never throws', () => {
    const badHome = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-bad-'));
    mkdirSync(badHome, { recursive: true });
    writeFileSync(path.join(badHome, 'pomodoro.json'), '{ not json', { mode: 0o600 });
    const doc = readDoc(badHome);
    assert.equal(doc.timer, null);
    rmSync(badHome, { recursive: true, force: true });
  });

  await check('writeDoc + readDoc: round-trips exactly, and the file is 0600 / the home dir 0700', () => {
    // Stamped with the CURRENT pomodoro day: readDoc rolls what it reads (below), so a
    // document dated any other day round-trips as an empty one, correctly.
    const now = Date.now();
    const doc = { ...onDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: 12345, paused: false } };
    writeDoc(doc, home);
    assert.deepEqual(readDoc(home, now), doc);
    const modeOf = p => statSync(p).mode & 0o777;
    assert.equal(modeOf(home), 0o700);
    assert.equal(modeOf(path.join(home, 'pomodoro.json')), 0o600);
  });

  await check('readDoc: a timer paused at 23:00 is absent the FIRST time anything reads the document after 05:00 -- and the read writes nothing', () => {
    // Criteria 1, 2 and the "starts nothing" half of 7, at the layer every other reader
    // goes through: no session start, no daemon boot, no control pressed, just a read.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-roll-'));
    try {
      const evening = new Date(2026, 7, 4, 23, 0, 0).getTime();
      writeDoc({ ...onDoc(), cycle: 3, cycleDate: pomodoroDay(evening), timer: { phase: 'work', paused: true, remainingMs: 9 * 60_000 } }, h);
      const file = path.join(h, 'pomodoro.json');
      const before = readFileSync(file, 'utf8');

      const morning = readDoc(h, new Date(2026, 7, 5, 5, 0, 1).getTime());
      assert.equal(morning.timer, null);
      assert.equal(morning.cycle, 0);
      assert.equal(morning.cycleDate, '2026-08-05');
      assert.equal(readFileSync(file, 'utf8'), before, 'a read is a read: the rollover is applied to what the caller gets, never written back by the read itself');

      // The same bytes read one hour EARLIER still carry the timer -- proof this is the
      // day boundary doing the work and not readDoc dropping paused timers generally.
      const beforeFive = readDoc(h, new Date(2026, 7, 5, 4, 0, 0).getTime());
      assert.equal(beforeFive.timer.paused, true);
      assert.equal(beforeFive.cycle, 3);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // ensureTimer -- the impure "ensure, not start" wrapper createPomodoro exposes.
  // -------------------------------------------------------------------------------

  await check('ensureTimer: no-op against a RUNNING timer', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const running = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 300_000, paused: false } };
    writeDoc(running, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h, now).timer, running.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: no-op against a PAUSED timer from the CURRENT pomodoro day', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const paused = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 42_000 } };
    writeDoc(paused, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h, now).timer, paused.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: a PAUSED timer from LAST NIGHT is rolled away and a fresh work interval started, in one call -- the morning\'s first session leaves a timer running', () => {
    // Criterion 6, end to end through the engine: one call, and it both ends yesterday's
    // loop and starts today's interval. Nothing else runs in between -- no boot, no
    // second ensure, no click. The whole defect this ticket exists for is the version
    // where this leaves last night's pause exactly where it was.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const lastNight = new Date(2026, 7, 4, 23, 0, 0).getTime();
    const morning = new Date(2026, 7, 5, 9, 12, 0).getTime();
    writeDoc({ ...onDoc(), cycle: 3, cycleDate: pomodoroDay(lastNight), timer: { phase: 'work', paused: true, remainingMs: 42_000 } }, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(morning);
      const onDisk = readDoc(h, morning);
      assert.equal(onDisk.timer.phase, 'work');
      assert.equal(onDisk.timer.paused, false);
      assert.equal(onDisk.timer.deadline, morning + DEFAULT_SETTINGS.workMin * 60_000);
      assert.equal(onDisk.cycle, 0, 'yesterday\'s cycle does not carry over into the fresh interval');
      assert.equal(onDisk.cycleDate, '2026-08-05', 'the rollover was actually persisted, not merely applied to the value returned');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('resume: pausing at 09:00 and resuming at 16:00 the same day continues from the frozen remainder -- the day boundary is the only staleness rule there is', () => {
    // Criterion 5. Seven hours is far past every OTHER staleness rule in this file
    // (EXPIRY_GRACE_MS is 30 seconds), so a rule that aged a paused timer by anything
    // but the day it belongs to would show up right here.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-resume-'));
    const nineAm = new Date(2026, 7, 5, 9, 0, 0).getTime();
    const fourPm = new Date(2026, 7, 5, 16, 0, 0).getTime();
    const engine = createPomodoro({ home: h });
    try {
      writeDoc({ ...onDoc(), cycle: 1, cycleDate: pomodoroDay(nineAm), timer: { phase: 'work', deadline: nineAm + 17 * 60_000, paused: false } }, h);
      engine.pause(nineAm);
      assert.equal(readDoc(h, nineAm).timer.remainingMs, 17 * 60_000);

      engine.resume(fourPm);
      const resumed = readDoc(h, fourPm);
      assert.equal(resumed.timer.paused, false);
      assert.equal(resumed.timer.deadline, fourPm + 17 * 60_000, 'the remainder is intact, anchored to the resume');
      assert.equal(resumed.cycle, 1, 'and the cycle is still the one it was counting');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  // Criteria 11/12 through the whole engine, not just the pure reducer: pause, then
  // forward or restart, and confirm what actually lands on disk. `arm` (private to
  // createPomodoro) already bails on `doc.timer.paused` before scheduling anything, so a
  // forward/restart that lands paused leaves nothing armed with no code change needed
  // here -- these two pin the persisted document, which is the only thing a client
  // (Popover or index page) ever reads back.
  await check('engine.forward: forwarding a PAUSED timer persists PAUSED at the next phase, full duration remaining', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-forward-'));
    const now = Date.now();
    const engine = createPomodoro({ home: h });
    try {
      writeDoc({ ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 300_000, paused: false } }, h);
      engine.pause(now);
      const forwarded = engine.forward(now + 1_000);
      assert.equal(forwarded.timer.phase, 'break');
      assert.equal(forwarded.timer.paused, true);
      assert.equal(forwarded.timer.remainingMs, DEFAULT_SETTINGS.breakMin * 60_000);
      assert.deepEqual(readDoc(h, now + 1_000).timer, forwarded.timer, 'persisted, not just returned');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('engine.restart: restarting a PAUSED timer persists PAUSED at the same phase, full duration remaining', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-restart-'));
    const now = Date.now();
    const engine = createPomodoro({ home: h });
    try {
      writeDoc({ ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: now + 60_000, paused: false } }, h);
      engine.pause(now);
      const restarted = engine.restart(now + 1_000);
      assert.equal(restarted.timer.phase, 'break');
      assert.equal(restarted.timer.paused, true);
      assert.equal(restarted.timer.remainingMs, DEFAULT_SETTINGS.breakMin * 60_000);
      assert.deepEqual(readDoc(h, now + 1_000).timer, restarted.timer, 'persisted, not just returned');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: no-op against a timer MID-BREAK -- a start during a break does not cut it short', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const midBreak = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: now + 90_000, paused: false } };
    writeDoc(midBreak, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h, now).timer, midBreak.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: starts a fresh work interval when there is truly no timer', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    writeDoc(onDoc(), h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      const doc = readDoc(h, now);
      assert.equal(doc.timer.phase, 'work');
      assert.equal(doc.timer.deadline, now + DEFAULT_SETTINGS.workMin * 60_000);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // enabled -- the impure half. ensureTimer refused while off (the exact seam the
  // session-start hook's POST /api/pomodoro/ensure reaches, safe without the hook
  // changing), and the engine.settings write actually cancelling the live setTimeout
  // on the true -> false transition, not merely writing a doc that looks cleared.
  // -------------------------------------------------------------------------------

  await check('ensureTimer: refused while enabled is false -- the session-start hook\'s ensure is a no-op without the hook changing', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-off-'));
    const now = Date.now();
    writeDoc({ ...defaultDoc(), settings: { ...DEFAULT_SETTINGS, enabled: false }, cycleDate: pomodoroDay(now) }, h);
    const engine = createPomodoro({ home: h });
    try {
      const next = engine.ensureTimer(now);
      assert.equal(next.timer, null, 'no timer is minted while off');
      assert.equal(readDoc(h, now).timer, null, 'and nothing was written that would say otherwise');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('engine.settings: flipping enabled off while a Timer is running clears it, resets the Cycle, and cancels the armed boundary -- no notification fires for the interval that was cut off', async () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-disable-'));
    const boundaries = [];
    const engine = createPomodoro({ home: h, onBoundary: b => boundaries.push(b) });
    try {
      const now = Date.now();
      // A deadline moments away: if the armed setTimeout survives the disable, it
      // fires well within this check's own wait below.
      writeDoc({ ...onDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 150, paused: false } }, h);
      engine.boot(now);

      const next = engine.settings({ enabled: false }, now);
      assert.equal(next.timer, null, 'the Timer is cleared, Rollover-style');
      assert.equal(next.cycle, 0, 'the Cycle resets to zero, Rollover-style');
      assert.equal(next.settings.enabled, false);

      await new Promise(resolve => setTimeout(resolve, 400));
      assert.deepEqual(boundaries, [], `no boundary may fire for an interval the Master switch just cut off: ${JSON.stringify(boundaries)}`);
      assert.equal(readDoc(h, Date.now()).timer, null, 'and the cleared state is what is actually on disk, not just what this call returned');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('engine.settings: flipping enabled back on starts idle -- nothing is restored (ADR 90)', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-reenable-'));
    const engine = createPomodoro({ home: h });
    try {
      const now = Date.now();
      writeDoc({ ...onDoc(), cycle: 3, cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: now + 60_000, paused: false } }, h);
      engine.settings({ enabled: false }, now);
      const backOn = engine.settings({ enabled: true }, now);
      assert.equal(backOn.timer, null, 'nothing is restored -- ADR 90: an absent timer names the state and nothing else');
      assert.equal(backOn.cycle, 0);
      assert.equal(backOn.settings.enabled, true);
      // And starting fresh from idle works normally again -- being off left no residue
      // that would stop a later ensure from minting a real interval.
      const started = engine.ensureTimer(now);
      assert.equal(started.timer.phase, 'work');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // The expiry rule is not reachable around. A deadline that went past while nobody was
  // there is EXPIRED wherever it is next touched -- and pause was the one control that
  // used to launder such an interval back into a live loop, because it clamps the
  // remainder at zero and resume then anchors that zero to a fresh `now`.
  // -------------------------------------------------------------------------------

  await check('pauseTimer: an interval whose deadline went past hours ago EXPIRES rather than pausing -- pause is not a way around the expiry rule', () => {
    const now = Date.now();
    const dead = { ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - 3 * 60 * 60 * 1000, paused: false } };
    const next = pauseTimer(dead, now);
    assert.equal(next.timer, null, 'the interval is discarded, not frozen at a zero remainder');
    assert.equal(next.cycle, 2, 'expiring costs the interval, never the pomodoros already completed today');
    // The same document, settled by the boundary rule, reaches the same verdict -- which
    // is the property that matters: one expiry rule, not two that can drift.
    assert.equal(settleBoundary(dead, now).doc.timer, null);
  });

  await check('pauseTimer: a deadline late but still INSIDE the grace pauses normally, at a zero remainder -- the expiry rule is the only thing pause now defers to', () => {
    const now = Date.now();
    const barely = { ...defaultDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - (EXPIRY_GRACE_MS - 1_000), paused: false } };
    const next = pauseTimer(barely, now);
    assert.equal(next.timer.paused, true, 'a boundary the daemon was about to settle anyway is still a pausable interval');
    assert.equal(next.timer.remainingMs, 0, 'clamped, never negative');
  });

  await check('engine.pause + engine.resume: an interval that died while the lid was closed can no longer be laundered back into the loop -- no advance, and no "Break started" for an interval that ended hours ago', async () => {
    // The whole defect, end to end through the engine: pause froze a three-hour-dead
    // interval as `remainingMs: 0`, resume anchored that zero to a fresh `now`, and the
    // reconcile that followed read a deadline exactly due, took the ADVANCE branch and
    // rang a real boundary. Asserted on the BOUNDARY, because that is the half a reader
    // hears -- a banner and a cue for a break that was over before lunch.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-expired-pause-'));
    const boundaries = [];
    const engine = createPomodoro({ home: h, onBoundary: b => boundaries.push(b) });
    try {
      const now = Date.now();
      writeDoc({ ...defaultDoc(), cycle: 1, cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now - 3 * 60 * 60 * 1000, paused: false } }, h);

      engine.pause(now);
      assert.equal(readDoc(h, now).timer, null, 'pausing a dead interval ends it, on disk');

      engine.resume(now);
      assert.equal(readDoc(h, now).timer, null, 'and there is nothing left for resume to re-anchor');

      // Long enough for any deadline resume could have minted (`now + 0`) to have come
      // due and fired through the armed setTimeout.
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.deepEqual(boundaries, [], `no boundary may be reported for an interval that ended hours ago: ${JSON.stringify(boundaries)}`);
      assert.equal(readDoc(h, Date.now()).cycle, 1, 'and the pomodoros already completed today are untouched');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // The wall clock being SET, which is a different thing from time passing. Every check
  // below drives the shell's own clock: a fixed mid-morning instant that advances in real
  // time and can be stepped, so a step is a step and never an accidental crossing of the
  // 05:00 pomodoro day boundary at whatever hour the suite happens to run (QUIRKS.md's
  // own "a fixture dated with localDateStr passes all day and fails before dawn").
  // `mono` is left real: the monotonic clock is precisely the one a step does not move,
  // and using the real one is what makes these steps look like real steps.
  // -------------------------------------------------------------------------------

  /** A steppable wall clock anchored at 10:00 on a fixed date. `step(ms)` is NTP. */
  function steppableClock() {
    const base = new Date(2026, 7, 5, 10, 0, 0).getTime();
    const startedAt = Date.now();
    let stepMs = 0;
    return {
      base,
      now: () => base + (Date.now() - startedAt) + stepMs,
      step(ms) { stepMs += ms; },
    };
  }

  await check('applyClockStep: rebases a running deadline by a real step, and by nothing else', () => {
    const doc = { ...defaultDoc(), timer: { phase: 'work', deadline: 1_000_000, paused: false } };
    assert.equal(applyClockStep(doc, 90_000).timer.deadline, 1_090_000, 'a 90-second correction moves the deadline 90 seconds');
    assert.equal(applyClockStep(doc, -90_000).timer.deadline, 910_000, 'and a backward one moves it back');
    assert.equal(applyClockStep(doc, 40), doc, 'ordinary measurement noise is not a step, and is a no-op by reference');
    assert.equal(applyClockStep(doc, 6 * 60_000), doc, 'a forward jump too large to tell from a lid closing is left to the expiry rule');
    assert.equal(applyClockStep(doc, -6 * 60_000).timer.deadline, 1_000_000 - 6 * 60_000, 'a BACKWARD jump carries no such ceiling -- sleep can only ever make the wall clock run ahead');
    assert.equal(applyClockStep(doc, NaN), doc);
    const idle = defaultDoc();
    assert.equal(applyClockStep(idle, 90_000), idle, 'nothing running, nothing to rebase');
    const paused = { ...defaultDoc(), timer: { phase: 'work', paused: true, remainingMs: 60_000 } };
    assert.equal(applyClockStep(paused, 90_000), paused, 'a paused timer has no wall-clock deadline to correct');
  });

  await check('a wall-clock step FORWARD while an interval is armed advances the boundary instead of discarding it -- the widget is not left frozen at 00:00 and the break is not silently lost', async () => {
    // The failure this exists for: `arm` baked `deadline - now` into one relative libuv
    // delay, so an NTP correction of a couple of minutes left the document reading 00:00
    // for the rest of that delay and then, when it finally fired, settleBoundary read a
    // deadline two minutes past and discarded the interval -- no next phase, no boundary,
    // no banner. The interval had run its full length in REAL time; only the clock moved.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-step-fwd-'));
    const clock = steppableClock();
    const boundaries = [];
    const engine = createPomodoro({ home: h, now: clock.now, onBoundary: b => boundaries.push(b) });
    try {
      writeDoc({ ...onDoc(), cycle: 0, cycleDate: pomodoroDay(clock.base), timer: { phase: 'work', deadline: clock.base + 150, paused: false } }, h);
      engine.boot();
      clock.step(2 * 60_000); // NTP, mid-wait: the wall clock moves, the monotonic one does not
      await new Promise(resolve => setTimeout(resolve, 400));

      assert.deepEqual(boundaries.map(b => b.phase), ['break'], `the work interval must still earn its break: ${JSON.stringify(boundaries)}`);
      const onDisk = readDoc(h, clock.now());
      assert.equal(onDisk.timer.phase, 'break', 'and the advance must have landed on disk, not only in the callback');
      assert.equal(onDisk.timer.paused, false);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('a wall-clock step BACKWARD while an interval is armed settles the boundary when it is really due, rather than leaving the countdown to run the step out a second time', async () => {
    // The other direction, and the unambiguous one: the timer fires on its own monotonic
    // schedule, the wall clock now says the deadline is half an hour away, and without the
    // correction the interval would count that half hour down all over again.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-step-back-'));
    const clock = steppableClock();
    const boundaries = [];
    const engine = createPomodoro({ home: h, now: clock.now, onBoundary: b => boundaries.push(b) });
    try {
      writeDoc({ ...onDoc(), cycle: 0, cycleDate: pomodoroDay(clock.base), timer: { phase: 'work', deadline: clock.base + 150, paused: false } }, h);
      engine.boot();
      clock.step(-30 * 60_000);
      await new Promise(resolve => setTimeout(resolve, 400));

      assert.deepEqual(boundaries.map(b => b.phase), ['break'], `the boundary must land when the interval really ran out: ${JSON.stringify(boundaries)}`);
      assert.equal(readDoc(h, clock.now()).timer.phase, 'break');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('a FOUR HOUR forward jump is still a lid that was closed, not a clock correction -- the interval is discarded with no boundary, exactly as before', async () => {
    // The ablation that keeps the rebase above honest. A forward jump has two causes and
    // one signature (see applyClockStep's own comment), so the fix is bounded by size:
    // anything past a few minutes is left to the expiry rule, which is what stops "the
    // lid was closed over lunch" from turning into a break nobody was there for.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-step-sleep-'));
    const clock = steppableClock();
    const boundaries = [];
    const engine = createPomodoro({ home: h, now: clock.now, onBoundary: b => boundaries.push(b) });
    try {
      writeDoc({ ...defaultDoc(), cycle: 2, cycleDate: pomodoroDay(clock.base), timer: { phase: 'work', deadline: clock.base + 150, paused: false } }, h);
      engine.boot();
      clock.step(4 * 60 * 60 * 1000);
      await new Promise(resolve => setTimeout(resolve, 400));

      assert.deepEqual(boundaries, [], 'nothing schedules a break that was already over before anyone could take it');
      const onDisk = readDoc(h, clock.now());
      assert.equal(onDisk.timer, null, 'the interval is discarded');
      assert.equal(onDisk.cycle, 2, 'and the pomodoros already completed today are untouched');
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('a step is noticed in seconds, not at the end of the interval -- an armed wait is re-derived from the wall clock in slices, so the document never sits frozen against a stepped clock', async () => {
    // The "frozen" half, and the reason `arm` slices at all. A minute-long interval used
    // to be one 60-second libuv delay: step the clock 59 seconds forward one tick after
    // arming it and the document read 00:00 remaining for a full minute with nothing
    // scheduled to look at it. Sliced, the daemon re-derives the deadline from the wall
    // clock within seconds and writes the correction back, which is what the widget and
    // the status item read.
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-step-slice-'));
    const clock = steppableClock();
    const deadline = clock.base + 60_000;
    const engine = createPomodoro({ home: h, now: clock.now });
    try {
      writeDoc({ ...onDoc(), cycleDate: pomodoroDay(clock.base), timer: { phase: 'work', deadline, paused: false } }, h);
      engine.boot();
      clock.step(59_000);
      // Polled rather than slept out: the slice is a few seconds, and a fixed sleep sized
      // for a loaded machine is either flaky or slower than it needs to be.
      const giveUp = Date.now() + 30_000;
      let onDisk = readDoc(h, clock.now());
      while (onDisk.timer && onDisk.timer.deadline === deadline && Date.now() < giveUp) {
        await new Promise(resolve => setTimeout(resolve, 100));
        onDisk = readDoc(h, clock.now());
      }
      assert.ok(onDisk.timer, 'the interval must still be running -- neither frozen nor discarded');
      assert.ok(Math.abs(onDisk.timer.deadline - (deadline + 59_000)) < 2_000,
        `the persisted deadline must have been rebased by the step within one slice, got ${onDisk.timer.deadline - deadline}ms of correction`);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // A boundary that cannot be written down. The timer callback runs with no request
  // handler's try/catch anywhere on the stack, so an uncaught throw out of it is an
  // uncaught exception at the top of the event loop -- which bin/daemon.mjs answers by
  // exiting, into a launchd restart that lands on the same due boundary and throws again.
  // -------------------------------------------------------------------------------

  await check('a writeDoc that throws at the timer boundary costs the daemon one log line, never the process -- a store that has gone read-only cannot restart-loop the clock', async () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-readonly-'));
    const realError = console.error;
    const logged = [];
    const engine = createPomodoro({ home: h });
    try {
      const now = Date.now();
      writeDoc({ ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 120, paused: false } }, h);
      engine.boot(now);

      // ENOSPC, a revoked Documents grant and a read-only volume all reach atomicWrite the
      // same way: the open(2) for the temp file fails. Closing the directory is the one
      // shape of that a check can produce on demand.
      chmodSync(h, 0o500);
      console.error = (...args) => logged.push(args.join(' '));
      let blocked = true;
      try { closeSync(openSync(path.join(h, '.probe'), 'wx')); blocked = false; } catch { /* as intended */ }
      if (!blocked) {
        console.error = realError;
        console.log('  (skipped: this user can write a 0500 directory, so the failure cannot be staged)');
        return;
      }

      // Without the wrapper this line never returns: the throw escapes the setTimeout
      // callback, node reports an uncaught exception, and this whole check file exits.
      await new Promise(resolve => setTimeout(resolve, 400));
      console.error = realError;

      assert.ok(logged.some(line => /pomodoro/.test(line)),
        `the failure must be named on the daemon's own log rather than swallowed: ${JSON.stringify(logged)}`);
      // Still usable afterwards: the engine did not tear anything down on its way through
      // the failure, so the clock comes back on its own once the store does.
      chmodSync(h, 0o700);
      const recovered = engine.boot(Date.now());
      assert.equal(recovered.timer.phase, 'break', 'the boundary the write failed on settles as soon as the store is writable again');
      assert.equal(readDoc(h, Date.now()).timer.phase, 'break', 'and that settlement really landed on disk');
    } finally {
      console.error = realError;
      chmodSync(h, 0o700);
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  rmSync(home, { recursive: true, force: true });

  // -------------------------------------------------------------------------------
  // Nothing about the agent's behaviour changes. Cheap, direct proof
  // that this slice touched nothing on that path, rather than trusting the diff.
  // -------------------------------------------------------------------------------

  await check('bin/mcp.mjs carries no pomodoro knowledge at all', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '..', 'bin', 'mcp.mjs'), 'utf8');
    assert.equal(/pomodoro/i.test(src), false);
  });

  // -------------------------------------------------------------------------------
  // Restart behaviour, driven the way test/check-http.mjs drives it: a real
  // in-process daemon on an ephemeral port against a temp CLAUDE_BOARD_HOME. A
  // deadline written before a restart is the identical deadline after one --
  // "the countdown survives a daemon restart" -- because the document
  // stores an absolute wall clock time, not a remaining-seconds counter for the new
  // process to have to guess how to resume.
  // -------------------------------------------------------------------------------

  await check('restart: a deadline written by one daemon survives that daemon closing and a second one starting', async () => {
    const restartHome = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-restart-'));
    try {
      const now = Date.now();
      const running = {
        ...onDoc(),
        cycleDate: pomodoroDay(now),
        cycle: 2,
        timer: { phase: 'work', deadline: now + 10 * 60_000, paused: false }, // 10 min out: not due during this check
      };
      writeDoc(running, restartHome);

      const first = await startServer({ home: restartHome, port: 0 });
      const afterFirstBoot = readDoc(restartHome);
      assert.equal(afterFirstBoot.timer.deadline, running.timer.deadline);
      assert.equal(afterFirstBoot.timer.phase, 'work');
      await closeServer(first.server);

      const second = await startServer({ home: restartHome, port: 0 });
      const afterSecondBoot = readDoc(restartHome);
      assert.equal(afterSecondBoot.timer.deadline, running.timer.deadline);
      assert.equal(afterSecondBoot.timer.phase, 'work');
      assert.equal(afterSecondBoot.cycle, 2); // untouched by a boot that found nothing due
      await closeServer(second.server);
    } finally {
      rmSync(restartHome, { recursive: true, force: true });
    }
  });

  await check('restart: a deadline 4 hours stale on boot (lid closed over lunch) yields no timer and no notification', async () => {
    const expiredHome = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-expired-'));
    try {
      const now = Date.now();
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      const expired = {
        ...defaultDoc(),
        cycleDate: pomodoroDay(now),
        // Genuinely 4 hours stale -- written as an absolute duration, not phrased
        // relative to EXPIRY_GRACE_MS, so this check catches a wrong SCALE (a grace
        // period rescaled to hours) and not only a wrong `>` vs `>=` boundary.
        timer: { phase: 'work', deadline: now - FOUR_HOURS_MS, paused: false },
      };
      writeDoc(expired, expiredHome);

      const started = await startServer({ home: expiredHome, port: 0 });
      const afterBoot = readDoc(expiredHome);
      assert.equal(afterBoot.timer, null);
      await closeServer(started.server);
    } finally {
      rmSync(expiredHome, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------------
  // POST /api/pomodoro/forward and POST /api/pomodoro/restart -- route-level
  // coverage against a real in-process daemon on an ephemeral port, proving the
  // pure rules above actually land on disk through the HTTP surface, that the
  // session cookie alone (no secret) is enough for both, and that idle really is a
  // no-op all the way through the route, not just in forwardTimer/restartTimer
  // isolation. Each check mints its own secret and temp home -- never the real
  // board home (see QUIRKS.md's writeDoc trap) and never a secret shared across
  // checks, so nothing here can be confused for another check's daemon.
  // -------------------------------------------------------------------------------

  async function withPomodoroServer(fn) {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-route-'));
    const secret = randomBytes(32).toString('hex');
    const { server, port } = await startServer({ home: h, port: 0, secret });
    try {
      await fn({ home: h, port, secret });
    } finally {
      await closeServer(server);
      rmSync(h, { recursive: true, force: true });
    }
  }

  function pomodoroUrl(port, action) {
    return `http://127.0.0.1:${port}/api/pomodoro/${action}`;
  }

  await check('POST /api/pomodoro/forward: advances the running timer on disk, same cycle bookkeeping a natural boundary performs', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      const now = Date.now();
      const running = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 20 * 60_000, paused: false } };
      writeDoc(running, home);

      const res = await fetch(pomodoroUrl(port, 'forward'), { method: 'POST', headers: { [SECRET_HEADER]: secret } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.timer.phase, 'break');
      assert.equal(body.timer.paused, false);

      const onDisk = readDoc(home);
      assert.equal(onDisk.timer.phase, 'break', 'the advance really landed on disk, not just in the response');
      assert.equal(onDisk.timer.deadline, body.timer.deadline);
    });
  });

  await check('POST /api/pomodoro/forward: forwarding a PAUSED timer through the route lands PAUSED at the next phase, full duration remaining (ADR 82)', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      const now = Date.now();
      const paused = { ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', paused: true, remainingMs: 30_000 } };
      writeDoc(paused, home);

      const body = await (await fetch(pomodoroUrl(port, 'forward'), { method: 'POST', headers: { [SECRET_HEADER]: secret } })).json();
      assert.equal(body.timer.phase, 'break');
      assert.equal(body.timer.paused, true, 'forward must not un-pause');
      assert.equal(body.timer.remainingMs, DEFAULT_SETTINGS.breakMin * 60_000, 'the FULL next phase, not the stale remainder');
      assert.equal(readDoc(home).timer.paused, true, 'landed on disk, not just in the response');
    });
  });

  await check('POST /api/pomodoro/forward: idle is a no-op all the way through the route -- 200, nothing thrown, the document on disk is byte-for-byte unchanged', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      writeDoc(defaultDoc(), home);
      const pomodoroFile = path.join(home, 'pomodoro.json');
      const before = readFileSync(pomodoroFile, 'utf8');
      const mtimeBefore = statSync(pomodoroFile).mtimeMs;

      const res = await fetch(pomodoroUrl(port, 'forward'), { method: 'POST', headers: { [SECRET_HEADER]: secret } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.timer, null, 'nothing invented out of idle');

      assert.equal(readFileSync(pomodoroFile, 'utf8'), before, 'the file must not be rewritten at all for an idle forward');
      assert.equal(statSync(pomodoroFile).mtimeMs, mtimeBefore, 'no write syscall happened, not merely one that produced identical bytes');
    });
  });

  await check('POST /api/pomodoro/restart: re-mints the deadline on disk to a full interval of the current phase, from current settings -- phase and cycle untouched', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      const now = Date.now();
      await fetch(pomodoroUrl(port, 'settings'), {
        method: 'POST',
        headers: { [SECRET_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ breakMin: 9, enabled: true }),
      });
      const settings = readDoc(home).settings;
      const midBreak = { ...defaultDoc(), settings, cycle: 3, cycleDate: pomodoroDay(now), timer: { phase: 'break', deadline: now - 1_000, paused: false } };
      writeDoc(midBreak, home);

      const body = await (await fetch(pomodoroUrl(port, 'restart'), { method: 'POST', headers: { [SECRET_HEADER]: secret } })).json();
      assert.equal(body.timer.phase, 'break', 'phase untouched');
      assert.ok(body.timer.deadline > body.now, 'the deadline is back in the future');
      assert.ok(Math.abs(body.timer.deadline - (body.now + settings.breakMin * 60_000)) < 400, 're-minted to a FULL break, from current settings');
      assert.equal(body.cycle, 3, 'cycle untouched');

      const onDisk = readDoc(home);
      assert.equal(onDisk.timer.deadline, body.timer.deadline, 'landed on disk, not just in the response');
      assert.equal(onDisk.cycle, 3);
    });
  });

  await check('POST /api/pomodoro/restart: a paused timer through the route stays PAUSED, re-minted to a full interval of the same phase (ADR 82)', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      const paused = { ...onDoc(), cycleDate: pomodoroDay(Date.now()), timer: { phase: 'work', paused: true, remainingMs: 5_000 } };
      writeDoc(paused, home);

      const body = await (await fetch(pomodoroUrl(port, 'restart'), { method: 'POST', headers: { [SECRET_HEADER]: secret } })).json();
      assert.equal(body.timer.phase, 'work', 'restart must not un-pause');
      assert.equal(body.timer.paused, true);
      assert.equal(body.timer.remainingMs, DEFAULT_SETTINGS.workMin * 60_000, 'the FULL phase, not the stale remainder');
      assert.equal(readDoc(home).timer.paused, true, 'landed on disk, not just in the response');
    });
  });

  await check('POST /api/pomodoro/restart: idle is a no-op all the way through the route -- 200, nothing thrown, the document on disk is byte-for-byte unchanged', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      writeDoc(defaultDoc(), home);
      const pomodoroFile = path.join(home, 'pomodoro.json');
      const before = readFileSync(pomodoroFile, 'utf8');

      const res = await fetch(pomodoroUrl(port, 'restart'), { method: 'POST', headers: { [SECRET_HEADER]: secret } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.timer, null);
      assert.equal(readFileSync(pomodoroFile, 'utf8'), before);
    });
  });

  await check('GET /api/pomodoro: a document left over from a previous pomodoro day reads as no interval at all -- and the read starts nothing', async () => {
    // Criterion 7, at the route the page actually opens against. Dated in the past
    // outright rather than by injecting a clock, because this one cannot inject one:
    // the daemon's GET reads with its own Date.now(), so "a previous pomodoro day" has
    // to be a real one -- and any past date is one at every hour the suite might run at.
    await withPomodoroServer(async ({ home, port, secret }) => {
      writeDoc({ ...defaultDoc(), cycle: 3, cycleDate: '2020-01-01', timer: { phase: 'work', paused: true, remainingMs: 9 * 60_000 } }, home);
      const pomodoroFile = path.join(home, 'pomodoro.json');
      const before = readFileSync(pomodoroFile, 'utf8');
      const mtimeBefore = statSync(pomodoroFile).mtimeMs;

      const res = await fetch(`http://127.0.0.1:${port}/api/pomodoro`, { headers: { [SECRET_HEADER]: secret } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.timer, null, 'a plain read must never show an interval the daemon already considers dead');
      assert.equal(body.cycle, 0);
      assert.equal(body.cycleDate, pomodoroDay(body.now), 'the response names the pomodoro day it was read on');

      assert.equal(readFileSync(pomodoroFile, 'utf8'), before, 'a read stays a read -- the rollover is not written back by the GET');
      assert.equal(statSync(pomodoroFile).mtimeMs, mtimeBefore, 'no write syscall happened at all, so nothing was started either');
    });
  });

  await check('POMODORO: the session cookie alone (no secret) can call both forward and restart', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      const now = Date.now();
      writeDoc({ ...onDoc(), cycleDate: pomodoroDay(now), timer: { phase: 'work', deadline: now + 20 * 60_000, paused: false } }, home);
      const cookieHeaders = { cookie: `${SESSION_COOKIE}=${sessionToken(secret)}` };

      const forwardC = await fetch(pomodoroUrl(port, 'forward'), { method: 'POST', headers: cookieHeaders });
      assert.equal(forwardC.status, 200, 'the cookie alone must be able to forward');
      assert.equal((await forwardC.json()).timer.phase, 'break');

      const restartC = await fetch(pomodoroUrl(port, 'restart'), { method: 'POST', headers: cookieHeaders });
      assert.equal(restartC.status, 200, 'the cookie alone must be able to restart');

      // No credential at all is still refused, same as every other pomodoro write.
      const none = await fetch(pomodoroUrl(port, 'forward'), { method: 'POST' });
      assert.equal(none.status, 401);
      const noneRestart = await fetch(pomodoroUrl(port, 'restart'), { method: 'POST' });
      assert.equal(noneRestart.status, 401);
    });
  });

  await check('POST /api/pomodoro/settings + GET: both menu bar preferences round-trip through the HTTP surface and land on disk', async () => {
    await withPomodoroServer(async ({ home, port, secret }) => {
      // The surface the settings panel and the status item both go through. The pure
      // checks above prove the validator and the defaults; this proves the two keys
      // actually cross the route in both directions -- a key missing from TOGGLE_KEYS
      // would be silently DROPPED here (mergeSettings drops unknown keys rather than
      // refusing them, on purpose), so a 200 alone proves nothing and every assertion
      // below is on what came back.
      const fresh = await (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, { headers: { [SECRET_HEADER]: secret } })).json();
      assert.equal(fresh.settings.menubarCountdown, true, 'a daemon with no document yet still answers with both keys');
      assert.equal(fresh.settings.menubarHidden, false);

      const res = await fetch(pomodoroUrl(port, 'settings'), {
        method: 'POST',
        headers: { [SECRET_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ menubarCountdown: false, menubarHidden: true }),
      });
      assert.equal(res.status, 200);
      const saved = await res.json();
      assert.equal(saved.settings.menubarCountdown, false, 'the write must be reflected in its own response, not only on the next read');
      assert.equal(saved.settings.menubarHidden, true);

      const reread = await (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, { headers: { [SECRET_HEADER]: secret } })).json();
      assert.equal(reread.settings.menubarCountdown, false);
      assert.equal(reread.settings.menubarHidden, true);
      assert.equal(readDoc(home).settings.menubarHidden, true, 'and on disk -- this is what has to survive a logout');

      // Refused by name, through the route, as a 400 and not a 500: the panel shows the
      // message, so it has to name the field the reader's control writes.
      const bad = await fetch(pomodoroUrl(port, 'settings'), {
        method: 'POST',
        headers: { [SECRET_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ menubarHidden: 'yes' }),
      });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /menubarHidden/);
      assert.equal(readDoc(home).settings.menubarHidden, true, 'a refused patch changes nothing at all');
    });
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall pomodoro checks ok');
  });
