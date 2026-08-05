// Pure-logic checks for src/pomodoro.mjs (ADR.md entry 8, SPEC_POMODORO.md) plus one
// real-daemon restart check in the style of test/check-http.mjs. No notification is
// ever fired by this file -- there is none to fire yet (ticket 02 owns that seam) --
// and nothing here shells out.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  EXPIRY_GRACE_MS,
  defaultDoc,
  localDateStr,
  formatCountdown,
  normalizeCycle,
  startWork,
  settleBoundary,
  normalizeDoc,
  readDoc,
  writeDoc,
  createPomodoro,
} from '../src/pomodoro.mjs';
import { startServer } from '../src/server.mjs';
import { NO_CUE } from '../src/cues.mjs';

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
  // normalizeCycle -- the local-midnight reset, in isolation.
  // -------------------------------------------------------------------------------

  await check('normalizeCycle: same local date is untouched (same reference, no write)', () => {
    const today = localDateStr(Date.now());
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: today };
    assert.equal(normalizeCycle(doc, Date.now()), doc);
  });

  await check('normalizeCycle: a stale cycleDate resets cycle to 0 and bumps cycleDate to today', () => {
    const now = new Date(2026, 7, 4, 9, 0, 0).getTime(); // 2026-08-04
    const doc = { ...defaultDoc(), cycle: 3, cycleDate: '2026-08-03' };
    const next = normalizeCycle(doc, now);
    assert.equal(next.cycle, 0);
    assert.equal(next.cycleDate, '2026-08-04');
  });

  await check('normalizeCycle: a missing cycleDate (fresh document) also resets', () => {
    const now = Date.now();
    const next = normalizeCycle(defaultDoc(), now);
    assert.equal(next.cycle, 0);
    assert.equal(next.cycleDate, localDateStr(now));
  });

  // -------------------------------------------------------------------------------
  // settleBoundary -- the loop, criteria 3 and 4, across a full N-break run
  // (default longEvery: 4) including the long break and the reset after it.
  // -------------------------------------------------------------------------------

  await check('settleBoundary: a full work/break loop, every 4th break long, cycle resets after it', () => {
    const t0 = new Date(2026, 7, 4, 9, 0, 0).getTime();
    let doc = { ...defaultDoc(), cycleDate: localDateStr(t0), timer: { phase: 'work', deadline: t0, paused: false } };

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
    const workDoc = { ...defaultDoc(), settings, cycleDate: localDateStr(t0), timer: { phase: 'work', deadline: t0, paused: false } };
    const { doc: afterWork } = settleBoundary(workDoc, t0);
    assert.equal(afterWork.timer.deadline - t0, 5 * 60_000); // break

    const longBreakDoc = { ...defaultDoc(), settings, cycle: 3, cycleDate: localDateStr(t0), timer: { phase: 'work', deadline: t0, paused: false } };
    const { doc: afterFourth } = settleBoundary(longBreakDoc, t0);
    assert.equal(afterFourth.timer.phase, 'longBreak');
    assert.equal(afterFourth.timer.deadline - t0, 15 * 60_000);
  });

  await check('settleBoundary: normalises the midnight reset BEFORE doing cycle arithmetic', () => {
    // cycle=3 dated yesterday: if midnight normalisation ran AFTER the arithmetic (or
    // not at all), breakNumber would be computed as 3+1=4 (a long break, wrong) instead
    // of the correct 0+1=1 (an ordinary break) once today's reset is accounted for.
    const now = new Date(2026, 7, 4, 0, 0, 5).getTime(); // just past local midnight
    const doc = { ...defaultDoc(), cycle: 3, cycleDate: '2026-08-03', timer: { phase: 'work', deadline: now - 1000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next.cycleDate, '2026-08-04');
    assert.deepEqual(boundary, { phase: 'break' }); // NOT longBreak
  });

  await check('settleBoundary: not yet due is a no-op, by reference (no needless write)', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), timer: { phase: 'work', deadline: now + 60_000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next, doc);
    assert.equal(boundary, null);
  });

  await check('settleBoundary: no timer, or a paused timer, is a no-op', () => {
    const now = Date.now();
    assert.equal(settleBoundary(defaultDoc(), now).boundary, null);
    const paused = { ...defaultDoc(), timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 5_000 } };
    const { doc: next, boundary } = settleBoundary(paused, now);
    assert.equal(next, paused);
    assert.equal(boundary, null);
  });

  // -------------------------------------------------------------------------------
  // The expiry rule (criterion 7) -- the whole reason this is a wall-clock deadline
  // rather than a countdown of remaining seconds.
  // -------------------------------------------------------------------------------

  await check('settleBoundary: a deadline past the grace period expires -- no advance, no boundary', () => {
    const deadline = Date.now() - (EXPIRY_GRACE_MS + 1);
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: localDateStr(Date.now()), timer: { phase: 'work', deadline, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, Date.now());
    assert.equal(next.timer, null);
    assert.equal(boundary, null);
    // cycle/cycleDate untouched: a lunch break must not cost pomodoros already banked.
    assert.equal(next.cycle, 2);
  });

  await check('settleBoundary: right at the grace boundary (late === EXPIRY_GRACE_MS exactly) still advances', () => {
    const now = Date.now();
    const deadline = now - EXPIRY_GRACE_MS; // late === grace, not GREATER than it
    const doc = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'work', deadline, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.notEqual(next.timer, null);
    assert.notEqual(boundary, null);
  });

  await check('settleBoundary: a deadline just inside the grace period advances normally', () => {
    const now = Date.now();
    const deadline = now - (EXPIRY_GRACE_MS - 1);
    const doc = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'work', deadline, paused: false } };
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
  // which is the exact failure criterion 7 exists to forbid.

  await check('settleBoundary: a deadline 4 hours stale (lid closed over lunch) expires -- no advance, no boundary', () => {
    const now = Date.now();
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: localDateStr(now), timer: { phase: 'work', deadline: now - FOUR_HOURS_MS, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.equal(next.timer, null);
    assert.equal(boundary, null);
    assert.equal(next.cycle, 2); // still not costing banked pomodoros
  });

  await check('settleBoundary: a deadline 5 seconds stale (an ordinary late timer) advances normally', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'work', deadline: now - 5_000, paused: false } };
    const { doc: next, boundary } = settleBoundary(doc, now);
    assert.notEqual(next.timer, null);
    assert.deepEqual(boundary, { phase: 'break' });
  });

  await check('EXPIRY_GRACE_MS itself is a handful of seconds, not fractions of one and not minutes', () => {
    // Below this range, ordinary event-loop slack (a GC pause, a busy tick) would
    // expire a perfectly healthy timer instead of advancing it; above it, real sleep
    // -- minutes at the very least -- would be miscounted as "still basically on
    // time" and fire a stale boundary, which is the exact failure criterion 7 exists
    // to forbid. This does not replace the two absolute-duration checks above; it is
    // the one assertion that catches a rescaling of the constant even before any
    // deadline math runs.
    assert.ok(EXPIRY_GRACE_MS >= 1_000, 'too small: event-loop slack alone would expire healthy timers');
    assert.ok(EXPIRY_GRACE_MS <= 60_000, 'too large: real sleep would be miscounted as on-time');
  });

  // -------------------------------------------------------------------------------
  // startWork -- the "ensure, not start" rule (criterion 2), pure half.
  // -------------------------------------------------------------------------------

  await check('startWork: begins a fresh work interval when there is no timer at all', () => {
    const now = Date.now();
    const next = startWork(defaultDoc(), now);
    assert.equal(next.timer.phase, 'work');
    assert.equal(next.timer.deadline, now + DEFAULT_SETTINGS.workMin * 60_000);
  });

  await check('startWork: a running timer is untouched, by reference', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), timer: { phase: 'work', deadline: now + 60_000, paused: false } };
    assert.equal(startWork(doc, now), doc);
  });

  await check('startWork: a paused timer is untouched -- starting during a pause does not resume or restart it', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 12_000 } };
    assert.equal(startWork(doc, now), doc);
  });

  await check('startWork: a timer mid-break is untouched -- starting during a break does not cut it short', () => {
    const now = Date.now();
    const doc = { ...defaultDoc(), timer: { phase: 'break', deadline: now + 120_000, paused: false } };
    assert.equal(startWork(doc, now), doc);
  });

  // -------------------------------------------------------------------------------
  // DEFAULT_SETTINGS / normalizeDoc -- the three per-phase cue defaults and the
  // `sound` migration (SPEC_CUES.md criterion 9). Driven directly through
  // normalizeDoc: it's a pure function of whatever JSON.parse would have handed
  // back, so none of this needs a real file or a temp dir.
  // -------------------------------------------------------------------------------

  await check('DEFAULT_SETTINGS: no sound key, and three DIFFERENT per-phase cues', () => {
    assert.equal('sound' in DEFAULT_SETTINGS, false);
    const { cueWork, cueBreak, cueLongBreak } = DEFAULT_SETTINGS;
    for (const v of [cueWork, cueBreak, cueLongBreak]) assert.equal(typeof v, 'string');
    // Criterion 9: "starts with three different cues" -- a picker offering the same
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
    const doc = { ...defaultDoc(), cycle: 2, cycleDate: '2026-08-04', timer: { phase: 'break', deadline: 12345, paused: false } };
    writeDoc(doc, home);
    assert.deepEqual(readDoc(home), doc);
    const modeOf = p => statSync(p).mode & 0o777;
    assert.equal(modeOf(home), 0o700);
    assert.equal(modeOf(path.join(home, 'pomodoro.json')), 0o600);
  });

  // -------------------------------------------------------------------------------
  // ensureTimer -- the impure "ensure, not start" wrapper createPomodoro exposes.
  // -------------------------------------------------------------------------------

  await check('ensureTimer: no-op against a RUNNING timer', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const running = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'work', deadline: now + 300_000, paused: false } };
    writeDoc(running, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h).timer, running.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: no-op against a PAUSED timer', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const paused = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'work', deadline: now - 1_000, paused: true, remainingMs: 42_000 } };
    writeDoc(paused, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h).timer, paused.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: no-op against a timer MID-BREAK -- a start during a break does not cut it short', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const midBreak = { ...defaultDoc(), cycleDate: localDateStr(now), timer: { phase: 'break', deadline: now + 90_000, paused: false } };
    writeDoc(midBreak, h);
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      assert.deepEqual(readDoc(h).timer, midBreak.timer);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  await check('ensureTimer: starts a fresh work interval when there is truly no timer', () => {
    const h = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-ensure-'));
    const now = Date.now();
    const engine = createPomodoro({ home: h });
    try {
      engine.ensureTimer(now);
      const doc = readDoc(h);
      assert.equal(doc.timer.phase, 'work');
      assert.equal(doc.timer.deadline, now + DEFAULT_SETTINGS.workMin * 60_000);
    } finally {
      engine.close();
      rmSync(h, { recursive: true, force: true });
    }
  });

  rmSync(home, { recursive: true, force: true });

  // -------------------------------------------------------------------------------
  // Criterion 10: nothing about the agent's behaviour changes. Cheap, direct proof
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
  // criterion 6, "the countdown survives a daemon restart" -- because the document
  // stores an absolute wall clock time, not a remaining-seconds counter for the new
  // process to have to guess how to resume.
  // -------------------------------------------------------------------------------

  await check('restart: a deadline written by one daemon survives that daemon closing and a second one starting', async () => {
    const restartHome = mkdtempSync(path.join(tmpdir(), 'claude-board-pomodoro-restart-'));
    try {
      const now = Date.now();
      const running = {
        ...defaultDoc(),
        cycleDate: localDateStr(now),
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
        cycleDate: localDateStr(now),
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
