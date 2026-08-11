// The stranded rule end to end (ADR.md entries 55 and 58):
// the daemon deciding that a round is Awaited while nobody is looking at its board, and
// raising exactly one Banner for it, per board, per absence.
//
// Two layers, the same split test/check-attended.mjs uses and for the same reason.
//
//  - `createStrandedWatch` driven directly, with a fake hub for "is anyone looking" and
//    a recording notifier in place of `notifyRound`. This is the only seam that can see
//    the click target and the child's lifetime: both cross to the launcher on the BUNDLE
//    path only, so a check watching an `osascript` invocation cannot prove either one.
//    The store underneath is real -- real board documents, written and read back through
//    src/store.mjs -- because "the announced marker is recorded on the board, not held in
//    the hub closure" is the whole point of that half, and a restart is checked by
//    building a SECOND watch over the same home.
//  - a real daemon on an ephemeral port with a fake notifier ahead of the real one on
//    PATH, opening and dropping real event streams against it. Whether the reviewer is
//    looking is a report the tab sends, so these drive `POST /api/board/:id/attended`
//    directly rather than needing a browser.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE. `osascript` is a stub on PATH here
// from the first line of this file, and the grace is a few milliseconds throughout rather
// than the shipped five seconds -- which is also why test/run.mjs pushes the grace out
// of reach for every OTHER check in the suite: they post awaited rounds and walk away
// too, which is exactly the shape this rule announces.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
// promisify(execFile), never execFileSync: QUIRKS.md records that a synchronous subprocess
// call deadlocks against the in-process daemon layer 2 boots below.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { SECRET_HEADER } from '../src/secret.mjs';
import { createBoard, addRound, amendRound } from '../src/board.mjs';
import { readBoard, writeBoard } from '../src/store.mjs';
import { STRANDED_BANNER, SUPPRESSED } from '../src/board.mjs';
import { roundIsAwaitedOpen } from '../src/badge.mjs';
import { CLICK_LIFETIME_MAX_MS, notifyRound, withdrawClickChild, parseElapsedTime, mayWithdrawPid } from '../src/notify.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { startServer, strandedTarget } from '../src/server.mjs';
import { createStrandedWatch, DEFAULT_STRANDED_GRACE_MS } from '../src/stranded.mjs';

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-stranded-'));
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
// A real directory whose basename is what the banner must name. `resolveBoardCwd`
// realpath's it, and the character filter in src/notify.mjs accepts this shape.
const projectDir = path.join(workDir, 'my-project');
mkdirSync(projectDir, { recursive: true });

// The store lives here for the whole file, including the daemon layer below. Set before
// anything imports a default home out of the environment.
process.env.CLAUDE_BOARD_HOME = home;
const SECRET_FILE = path.join(workDir, 'secret');
const SECRET = 'c'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

// --- the fake notifier on PATH ------------------------------------------------------
//
// Same shape as test/check-notify.mjs's and test/check-notify-round.mjs's, plus one
// thing they do not need: with STUB_OSASCRIPT_LINGER_MS set it STAYS ALIVE and records
// the signal that eventually kills it, which is how the click-serving process's lifetime
// becomes observable without a real banner (criteria 6 and 15).
// Every row carries the argv it came from, signals included, so a row can be attributed
// to the board that produced it -- see `rowsFor` below for why that matters.
const STUB_OSASCRIPT = `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const log = process.env.STUB_OSASCRIPT_LOG;
const say = what => fs.appendFileSync(log, JSON.stringify([what, ...argv]) + '\\n');
say('spawn');
const linger = Number(process.env.STUB_OSASCRIPT_LINGER_MS || '0');
if (linger > 0) {
  const bye = sig => { say(sig); process.exit(0); };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
  setTimeout(() => { say('deadline'); process.exit(0); }, linger);
}
`;

// The daemon must open no tab (criterion 1). Stubbed rather than merely not asserted, so
// a reopen added anywhere on this path shows up as a recorded invocation.
const STUB_OPEN = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_OPEN_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;

const stubDir = path.join(workDir, 'bin');
mkdirSync(stubDir, { recursive: true });
for (const [name, source] of [['osascript', STUB_OSASCRIPT], ['open', STUB_OPEN]]) {
  const p = path.join(stubDir, name);
  writeFileSync(p, source);
  chmodSync(p, 0o755);
}
process.env.PATH = `${stubDir}:${process.env.PATH}`;
process.env.STUB_OPEN_LOG = path.join(workDir, 'open-invocations.log');
process.env.STUB_OSASCRIPT_LINGER_MS = '0';

const LOG = path.join(workDir, 'osascript-invocations.log');
process.env.STUB_OSASCRIPT_LOG = LOG;

function readLines() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

const BANNER = folder => `display notification "${folder}: a round is waiting." with title "Board"`;

/** Every recorded row -- spawn and signal alike -- whose banner names `folder`.
 *
 * ONE log for the whole run, filtered per board rather than rotated per scenario,
 * because a grace armed by one scenario can fire during the next one: a check that
 * closes the tab it opened leaves a real absence behind, and that absence is genuinely
 * announced a few milliseconds later. Rotating the log made those land in the next
 * scenario's file and read as its banner. Each scenario therefore gets its own project
 * directory, and the folder name in the banner body is what says which board a row is
 * about -- which is the same identity the reviewer reads off the screen. */
function rowsFor(folder) {
  const body = BANNER(folder);
  return readLines().filter(r => r[r.length - 1] === body);
}

const spawnsFor = folder => rowsFor(folder).filter(r => r[0] === 'spawn');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** Run `fn` with a different grace, and put the old one back even if it throws. On the
 * success path only, a failing assertion would leave the next scenario running against
 * this scenario's timing -- which turns one red check into five. */
async function withGrace(ms, fn) {
  const saved = process.env.CLAUDE_BOARD_STRANDED_GRACE_MS;
  process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(ms);
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BOARD_STRANDED_GRACE_MS;
    else process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = saved;
  }
}

/** Wait until `folder` has `count` rows recorded against it, or give up. */
async function waitForRows(folder, count, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (rowsFor(folder).length >= count) break;
    await tick(10);
  }
  return rowsFor(folder);
}

/** A real project directory whose basename is what the banner will name. */
function projectFor(name) {
  const dir = path.join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The banner record this daemon has standing for a board, or null. */
const bannerOn = boardId => readBoard(boardId, home)[STRANDED_BANNER] ?? null;
const announcedAt = boardId => (bannerOn(boardId) || {}).at ?? null;

// ====================================================================================
// Layer 1: the rule itself, with a fake hub and a recording notifier.
// ====================================================================================

const AWAIT_MS = 40 * 60 * 1000;
const QUESTION = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }] });

/** A real board document on disk: awaited (a question round) unless told otherwise.
 *
 * `suppressed` stamps the daemon-only field `handlePostBoard` (src/server.mjs) writes when
 * some board already had a Watcher at creation and no tab was opened (ADR.md entry 91).
 * Layer 2 below gets it from the real daemon; here it is set by hand, because this layer's
 * whole subject is what the rule DOES with it. */
function seedBoard({ wait = true, cwd = projectDir, awaitTimeoutMs = AWAIT_MS, suppressed = false } = {}) {
  const board = createBoard({
    title: 'Stranded',
    blocks: wait ? [QUESTION('Ship?')] : [{ kind: 'markdown', text: 'an artifact, nothing asked' }],
    cwd,
    awaitTimeoutMs,
  });
  if (suppressed) board[SUPPRESSED] = true;
  writeBoard(board, home);
  return board;
}

function addAwaitedRound(boardId, prompt, awaitTimeoutMs = AWAIT_MS) {
  const board = readBoard(boardId, home);
  addRound(board, { blocks: [QUESTION(prompt)], awaitTimeoutMs });
  writeBoard(board, home);
  return board;
}

/** A stand-in for the SSE hub with exactly the two methods the rule reads, plus a fake
 * click-serving child that records the signal it is killed with.
 *
 * `looking` is the hub's three states, per board, as `createSseHub` really holds them:
 * absent (no Watcher at all), `null` (a Watcher connected but not yet reporting -- what
 * a reconnect looks like), `false` (a Watcher that has said it is hidden), `true` (one
 * that has said it is looking). The middle state is the one the rule has to treat as
 * neither, so a stand-in that only had a boolean could not fail the way the real hub
 * can. */
/** `sse` and `notify` are overridable so the two error-handler cases below can hand
 * `createStrandedWatch` a double that throws, without touching what a bare `stand()`
 * gives every other check in this file -- the default hub and notifier are exactly what
 * they were before this parameter existed. Nobody but this function may add another
 * knob here; every other check in the file calls `stand()` with no arguments at all. */
function stand({ notify, sse } = {}) {
  const withdrawn = [];
  const looking = new Map();
  // Per board, the instant a look-away window ENDS (ADR 73) -- an absolute stamp, not a
  // duration, so it decays on the real clock exactly as the hub's does and can expire
  // with nothing calling anything. Unset is the ordinary case: `looking` alone decides
  // and there is no window. `lookAway()` below is how a check opens one.
  const windowUntil = new Map();
  const remaining = id => {
    if (looking.get(id) === true) return Infinity;
    const until = windowUntil.get(id);
    return until ? Math.max(0, until - Date.now()) : 0;
  };
  const banners = [];
  const watch = createStrandedWatch({
    home,
    sse: sse || {
      // DERIVED from `attendedRemainingMs`, exactly as the real hub derives it
      // (src/server.mjs: `remainingMs(boardId) > 0`). Spelling it `looking.get(id) === true`
      // instead is the drift that hid a defect: the rule reads this boolean in one place
      // and the milliseconds in another, so a stand-in where the two disagree cannot fail
      // the way production does -- and production's whole hazard is a board that is
      // Attended on a CLOCK rather than on a report. A stand-in that has drifted from the
      // thing it stands in for is worse than none.
      isConfirmedAttended: id => remaining(id) > 0,
      // How LONG this board stays Attended, which is what tells the rule when to look
      // again (ADR 73). `Infinity` is a tab focused right now, which never ages out; a
      // finite number is a tab that has lost focus and is still inside its look-away
      // window; 0 is nobody watching.
      attendedRemainingMs: remaining,
    },
    notify: notify || ((folder, opts) => {
      // A stand-in ChildProcess, down to the one event the rule subscribes to: `exit`,
      // which is how it stops holding a handle to a reaped pid. `die()` is the check's
      // way of saying "this one exited on its own".
      const child = {
        pid: 4242,
        killed: [],
        onExit: null,
        kill(sig) { this.killed.push(sig); },
        once(event, fn) { if (event === 'exit') this.onExit = fn; },
        die() { this.onExit && this.onExit(); },
      };
      banners.push({ folder, ...opts, child });
      return child;
    }),
    // The pid path: only reached when this daemon has no handle of its own, i.e. after an
    // unclean restart. Recorded rather than performed, because the real one sends SIGTERM.
    withdraw: (pid, startedAtMs) => withdrawn.push({ pid, startedAtMs }),
  });
  /** Open a look-away window on this board that really expires, `ms` from now: the tab
   * has just lost focus and the daemon still counts the board as Attended until then. */
  const lookAway = (id, ms) => windowUntil.set(id, Date.now() + ms);
  return { looking, lookAway, banners, withdrawn, watch };
}

// The click target as the daemon really builds it (`strandedTarget`, src/server.mjs):
// the board's URL and the port from the same one read of the bound socket, handed over
// together because the launcher checks them against each other.
const PORT = 7391;
const URL_A = `http://127.0.0.1:${PORT}`;
const target = id => ({ url: `${URL_A}/b/${id}`, port: PORT });

async function layerOne() {
  process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '1';

  await check('a board nobody is Attending, with an awaited round, announces once, naming the folder, after the grace', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    assert.equal(banners.length, 0, 'nothing may fire inside the grace, however short it is');
    await tick();
    assert.equal(banners.length, 1, 'criterion 1: one banner');
    assert.equal(banners[0].folder, 'my-project', 'the folder is folderName(board.cwd), passed through unfiltered');
    watch.close();
  });

  await check('the click carries the board\'s own URL plus #stranded-round, and the oldest awaited round\'s deadline', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    addAwaitedRound(board.id, 'And then?');
    const fresh = readBoard(board.id, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'criterion 8: two rounds awaited at once is still one board and one banner');
    assert.equal(banners[0].url, `${URL_A}/b/${board.id}#stranded-round`,
      'a plain board URL and the sentinel the index\'s live rows already use -- never a handoff (criterion 13)');
    assert.equal(banners[0].port, PORT,
      'and the bound port beside it, which is what the launcher checks the URL\'s own port against');
    assert.equal(banners[0].deadlineAt, Date.parse(fresh.rounds[0].awaitDeadline),
      'the click resolves to the OLDEST round still waiting, so that round\'s deadline is what bounds the process serving it');
    watch.close();
  });

  await check('the announced marker is recorded on the board document, not in the hub closure', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    const stored = readBoard(board.id, home);
    const rec = stored[STRANDED_BANNER];
    assert.ok(rec, `expected ${STRANDED_BANNER} on the stored board, got ${JSON.stringify(rec)}`);
    assert.ok(!Number.isNaN(Date.parse(rec.at)), 'dated with an ISO stamp, like sentAt beside it');
    assert.equal(rec.round, 1, 'and it names WHICH round it announced, so the absence can be retired when that round is over');
    assert.ok('pid' in rec, 'and the process serving its click, so a replacement daemon can withdraw it');
    watch.close();
  });

  await check('criterion 7: further rounds landing on the same board, still not Attended, raise nothing more', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    for (const prompt of ['second?', 'third?', 'fourth?']) {
      addAwaitedRound(board.id, prompt);
      watch.evaluate(board.id, target(board.id));
    }
    await tick();
    assert.equal(banners.length, 1, 'one banner per absence, however many rounds pile up behind it');
    watch.close();
  });

  await check('criterion 7: a daemon killed outright does not re-announce -- its banner is still up', async () => {
    // The crash/SIGKILL restart: the process dies without running any handler, so the
    // click-serving child is orphaned with its banner still on screen and the record is
    // still on disk. The successor must stay quiet, which is what the record is for.
    const first = stand();
    const board = seedBoard();
    first.watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(first.banners.length, 1);
    // Deliberately NOT closed: `close()` is the graceful path and it retires what it
    // withdraws (see the next check). Nothing runs when a process is SIGKILLed.

    const second = stand(); // ... a successor comes up over the same store, nobody Attending
    second.watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(second.banners.length, 0,
      'the record is on the board precisely so a restart cannot re-announce what the reviewer is still looking at');
    assert.deepEqual(first.banners[0].child.killed, [], 'and the orphan is still up, because nothing killed it');
    second.watch.close();
    first.watch.close();
  });

  await check('a graceful stop withdraws the banner and leaves the record standing', async () => {
    // Stopping the daemon SIGTERMs every click-serving child, and SIGTERM is how a banner
    // is WITHDRAWN -- criterion 15. It is tempting to conclude that a board with nothing on
    // screen may be announced again. Criterion 7 rules that out in as many words: further
    // rounds raise nothing more until the reviewer comes back, "whether or not the banner
    // already raised is still on screen". An absence ends two ways and only two -- the
    // reviewer returns, or the announced round stops being awaited -- and a daemon stop is
    // neither. Retiring here told a reviewer twice for one absence after an ordinary
    // `install.sh` update.
    const first = stand();
    const board = seedBoard();
    first.watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(first.banners.length, 1);
    const rec = bannerOn(board.id);
    assert.ok(rec);

    first.watch.close(); // install.sh takes an update
    assert.deepEqual(first.banners[0].child.killed, ['SIGTERM'],
      'criterion 15: stopping the daemon leaves none of them running');
    // The record stands -- this absence has been announced -- but its pid does not: it
    // named the process just killed, while `until` goes on claiming it may live for
    // another hour, and the successor's own launchd supervisor starts AFTER `at`, so the
    // start-time gate that used to exclude a supervisor no longer does.
    assert.deepEqual(bannerOn(board.id), { ...rec, pid: null },
      'the record survives with only its pid cleared');

    const second = stand();
    addAwaitedRound(board.id, 'a round landing under the successor?');
    second.watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(second.banners.length, 0,
      'the successor says nothing: the reviewer was told once and has not come back');
    second.watch.close();
  });

  await check('a board whose rounds are ABANDONED loses its banner, and keeps its mark', async () => {
    // ADR 69 (`ask(fresh: true)`) meets ADR 74. The reviewer ran `/clear` with a banner on
    // screen: nothing on this board is awaited any more, so the banner names a round that
    // no longer wants an answer and its click would land on a board with nothing to do --
    // for up to `min(the round's deadline, CLICK_LIFETIME_MAX_MS)`, tens of minutes.
    //
    // This used to fall out of `mayAnnounce` spending a record whose round had stopped
    // being awaited; that spend is gone with the permanent mark, so `evaluate` alone now
    // cancels the pending grace and never reaches the delivered banner. `abandoned` is the
    // withdrawal half on its own -- and it must stay ONLY that half: abandoning is not
    // returning, so the mark and the gate are left exactly as they were.
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    const before = bannerOn(board.id);
    assert.equal(before.returned, false, 'nobody has come back');

    // The shim declares the conversation over, exactly as handleAbandon does it: every
    // open round closed on disk, then the rule told.
    const abandoned = readBoard(board.id, home);
    for (const r of abandoned.rounds) if (r.status === 'open') r.status = 'abandoned';
    writeBoard(abandoned, home);
    watch.abandoned(board.id);

    assert.deepEqual(banners[0].child.killed, ['SIGTERM'],
      'the banner comes off the screen: SIGTERM is what withdraws a delivered one');
    const after = bannerOn(board.id);
    assert.ok(after, 'the mark survives -- abandoning is not returning');
    assert.equal(after.round, before.round, 'still the round that was announced');
    assert.equal(after.returned, false, 'and the gate is still shut, because nobody came back');
    assert.equal(after.pid, null, 'only the pid goes, with the process it named');
    watch.close();
  });

  await check('an abandoned board does not become announceable: the gate is untouched', async () => {
    // The half that would be easy to get wrong by reaching for `spend` again. A board
    // abandoned with a banner standing must not announce a later round without a return --
    // and abandoned boards do get later rounds: `ask(fresh: true)` starts a NEW board, but
    // nothing stops a stale shim posting into this one.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    const abandoned = readBoard(board.id, home);
    for (const r of abandoned.rounds) if (r.status === 'open') r.status = 'abandoned';
    writeBoard(abandoned, home);
    watch.abandoned(board.id);

    addAwaitedRound(board.id, 'a round landing on an abandoned board?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'silent: withdrawing a banner is not a reviewer returning');

    looking.set(board.id, true);   // ... and a genuine return still unblocks it
    watch.evaluate(board.id, target(board.id));
    looking.delete(board.id);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'the gate still works, it just was not opened by the abandon');
    watch.close();
  });

  await check('abandoning a board with no banner on it is a silent no-op', async () => {
    // `handleAbandon` calls this unconditionally, for every board a shim declares done --
    // almost none of which was ever announced. It must not throw, write, or announce.
    const { banners, watch } = stand();
    const board = seedBoard();
    assert.doesNotThrow(() => watch.abandoned(board.id));
    assert.doesNotThrow(() => watch.abandoned('b_never_created'));
    assert.doesNotThrow(() => watch.abandoned('../../etc/passwd'));
    await tick();
    assert.equal(banners.length, 0);
    assert.equal(bannerOn(board.id), null, 'nothing was written to a board that had nothing');
    watch.close();
  });

  await check('the countdown waits out the look-away window, and is clamped to what a timer can hold', async () => {
    // Two properties of one expression, `grace + whatever is left of the window`.
    //
    // It has to WAIT the window out, because no event fires when a window expires: without
    // the sum the window would not delay a banner, it would cancel it (see `evaluate`).
    await withGrace(30, async () => {
      const { lookAway, banners, watch } = stand();
      const board = seedBoard();
      lookAway(board.id, 250);   // a tab buried a moment ago, 250ms of window left
      try {
        watch.evaluate(board.id, target(board.id));
        await tick(120);           // four graces later, still inside the window
        assert.equal(banners.length, 0, 'the grace alone must not be what fires this');
        await tick(250);
        assert.equal(banners.length, 1, 'and past the window it announces, once');
      } finally {
        watch.close();
      }
    });

    // And it has to be CLAMPED. Both knobs are validated finite-and-positive but neither
    // is bounded above, and node coerces a setTimeout delay to a signed 32-bit int: a sum
    // past 2^31-1 does not throw, it warns and fires on the next tick. An operator asking
    // for a month-long window would get every board announcing instantly -- the exact
    // inverse of the request.
    await withGrace(30, async () => {
      const { lookAway, banners, watch } = stand();
      const board = seedBoard();
      lookAway(board.id, 30 * 24 * 60 * 60 * 1000); // a month, well past the ceiling
      try {
        watch.evaluate(board.id, target(board.id));
        await tick(120);
        assert.equal(banners.length, 0,
          'an over-long window must clamp to the ceiling, not wrap around into "fire immediately"');
      } finally {
        watch.close();
      }
    });
  });

  await check('a window that opens UNDER an already-armed countdown still gets its banner, with no further event', async () => {
    // The permanent false negative, and the exact sequence an `install.sh` update
    // produces. `handleEvents` evaluates at SUBSCRIBE, before the reconnecting page has
    // reported anything, so the bare grace is armed against no window at all; the page's
    // `sinceFocusMs` seeds a longer window one round trip later, and `evaluate` leaves the
    // shorter countdown alone because one is already armed.
    //
    // The grace then fires INSIDE the window. If it simply returns -- which is what asking
    // `isConfirmedAttended`, a boolean, led to -- the countdown is gone and the window
    // expires against nothing, because no event fires when a window expires. The round is
    // then never announced at all: not delayed, lost. ADR.md entry 74 accepts a banner
    // missed while the screen was locked never being repeated; it does not accept this.
    //
    // Nothing is called after the window is opened. That is the whole point: the rule has
    // to come back on its own.
    await withGrace(50, async () => {
      const { lookAway, banners, watch } = stand();
      const board = seedBoard();
      try {
        watch.evaluate(board.id, target(board.id)); // subscribe: no window yet, bare grace
        lookAway(board.id, 300);                    // ... and the report lands, seeding one
        watch.evaluate(board.id, target(board.id)); // which leaves the armed countdown alone

        await tick(150); // the grace has fired, well inside the window
        assert.equal(banners.length, 0, 'nothing may fire while the board is still Attended');

        await tick(400); // the window expires -- and NOTHING calls evaluate here
        assert.equal(banners.length, 1,
          'the rule has to re-arm on the remaining window: no event fires when one expires, so a countdown dropped here is a round that is never announced');
        assert.equal(bannerOn(board.id).round, 1);
      } finally {
        watch.close();
      }
    });
  });

  await check('a countdown armed for a look-away window is re-armed when that tab goes away', async () => {
    // The window belongs to an OPEN tab (criterion 7 says so in as many words). A timer
    // armed at grace + two minutes while a tab was buried is waiting out a window for a
    // tab nobody has open any more, so the board sits silent for the rest of it. Narrowly
    // scoped to "the board now reports no attended time at all", so it cannot become the
    // general re-arm that would let a flaky socket hold the countdown open forever -- the
    // check just below this one is what pins that.
    await withGrace(40, async () => {
      const { lookAway, banners, watch } = stand();
      const board = seedBoard();
      lookAway(board.id, 5000); // buried tab, five seconds of window left
      try {
        watch.evaluate(board.id, target(board.id));
        await tick(80);
        assert.equal(banners.length, 0, 'waiting out the window, as it should be');

        lookAway(board.id, 0);     // the tab closes: its window goes with it
        watch.evaluate(board.id, target(board.id));
        await tick(120);
        assert.equal(banners.length, 1,
          'the banner arrives one plain grace later, rather than waiting out a window nobody owns');
      } finally {
        watch.close();
      }
    });
  });

  await check('a Watcher that becomes Attended between arming and firing gets no Banner, and the countdown is re-armed rather than dropped', async () => {
    // The second Attended test: `announce` re-asks `attendedRemainingMs`
    // at fire time rather than trusting what was true when the grace was armed, and this
    // is the branch for a look-away window that is still running when it does. No race is
    // needed to reach it -- the "same instant" is just this double answering 0 when
    // `evaluate` arms the grace and something other than 0 when `announce` re-checks it,
    // and nothing in between has to call anything for that to happen: `windowUntil`
    // decays on the real clock, exactly like the hub it stands in for (ADR 73).
    //
    // No `withGrace` here: the file-wide grace set at the top of `layerOne` is already
    // one millisecond, which is the grace this case needs too.
    const { lookAway, banners, watch } = stand();
    const board = seedBoard({ cwd: projectFor('attended-between-arm-and-fire') });
    try {
      watch.evaluate(board.id, target(board.id)); // nobody looking: arms the bare grace, unwindowed
      // The double changes with NO call to evaluate -- a look-away window opens on the
      // board between the countdown being armed and the timer firing, which is exactly
      // what a report landing in that gap would produce.
      lookAway(board.id, 80);
      await tick(40); // past the 1ms grace: announce() has re-asked and found attendedFor > 0
      assert.equal(banners.length, 0,
        'a Watcher attended at fire time must get no Banner, even though none was attended when the grace was armed');

      // THE LOAD-BEARING HALF: nothing further is called from here on -- no evaluate, no
      // report, nothing. If `announce` had returned bare instead of re-arming on the
      // window's remainder (the bug this branch exists to prevent), the window would now
      // expire against nothing, because no event fires when a look-away window expires,
      // and the round would be lost for good rather than merely delayed.
      await tick(80); // comfortably past the 80ms window, with no further event of any kind
      assert.equal(banners.length, 1,
        'the round is not lost: the re-armed countdown must still fire when the window expires on its own');
      assert.equal(bannerOn(board.id).round, 1);
    } finally {
      watch.close();
    }
  });

  await check('a Watcher reported as Attended indefinitely gets no Banner and no re-arm', async () => {
    // The inverse of the case above, and the other half of the same re-ask in `announce`:
    // `if (attendedFor === Infinity) return;` -- nothing armed, because a tab focused
    // RIGHT NOW is guaranteed to produce a blur, a close or an answer eventually, and each
    // of those is an event that will call `evaluate` on its own.
    const { looking, lookAway, banners, watch } = stand();
    const board = seedBoard({ cwd: projectFor('attended-indefinitely-at-fire') });
    try {
      watch.evaluate(board.id, target(board.id)); // nobody looking yet: arms the bare grace
      // Flipped directly, with no further evaluate() call -- same insight as above, the
      // Infinity branch instead of a window's remainder.
      looking.set(board.id, true);
      await tick(40); // past the 1ms grace: announce() has re-asked and found Infinity
      assert.equal(banners.length, 0, 'a Watcher attended indefinitely at fire time must get no Banner');

      // THE "NO RE-ARM" HALF, proved through a LATER event rather than a long wait -- a
      // wait alone cannot tell "nothing armed" apart from "something armed ~25 days out",
      // which is exactly what a missing Infinity branch leaves behind, not a fast failure.
      //
      // `announce`'s first line is `pending.delete(boardId)`, so the correct branch --
      // returning bare -- leaves `pending` EMPTY. A missing branch does not merely skip a
      // `return`: `attendedFor > 0` is true for Infinity too, so execution falls into the
      // OTHER branch and calls `arm(boardId, target, Infinity, true)`, which clamps to
      // node's own ~25-day timer ceiling and puts a STALE windowed entry back in `pending`.
      // No wait of any practical length observes that timer firing, but the entry it left
      // behind is not invisible to the next real event. `evaluate`'s own re-arm guard --
      //   const armed = pending.get(boardId);
      //   if (armed && !(attendedFor === 0 && armed.windowed)) return;
      // -- reads whatever is sitting in `pending`, and a stale windowed entry combined with
      // a non-zero `attendedFor` (the finite window opened below) satisfies that guard and
      // returns WITHOUT arming anything for the window that just opened. The window then
      // expires against nothing -- no banner, ever -- which is the same permanent loss the
      // re-arm case above exists to prevent. So "no re-arm" is proved here as "a later
      // event can still arm": exactly what the Infinity branch's own justification claims,
      // that a focused tab is guaranteed to produce one.
      looking.delete(board.id);     // the tab is no longer focused...
      lookAway(board.id, 40);       // ...but hasn't closed either -- a plain blur, buried briefly
      watch.evaluate(board.id, target(board.id)); // the ordinary event a blur produces
      await tick(80); // comfortably past grace + the 40ms window
      assert.equal(banners.length, 1,
        'a later event must still be able to arm: a stale entry left behind by a missing Infinity branch blocks it forever, and the round is never announced');
    } finally {
      watch.close();
    }
  });

  await check('criterion 3: returning kills the click-serving process with SIGTERM and leaves the mark standing', async () => {
    // THE REWRITTEN ASSERTION (ADR 74). This check used to
    // pin the opposite: that coming back CLEARED the marker, so leaving again raised a
    // second banner for the same round. That was the defect, measured at roughly one
    // banner a minute for one round -- a glance at the board, or the banner's own click
    // bringing the tab forward, reset the budget.
    //
    // What a return buys now: the banner comes off the screen, and the board may announce
    // a round it has never announced. What it does not buy: another banner for the round
    // already announced, ever, however many times the reviewer leaves and comes back.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    const mark = bannerOn(board.id);
    assert.equal(mark.round, 1);
    assert.equal(mark.returned, false, 'the gate is shut from the moment a banner is raised');

    looking.set(board.id, true); // a tab reports that it is visible and focused
    watch.evaluate(board.id, target(board.id));
    assert.deepEqual(banners[0].child.killed, ['SIGTERM'],
      'SIGTERM specifically: it is the path that withdraws the delivered banner from Notification Center');
    const returnedRec = bannerOn(board.id);
    assert.ok(returnedRec, 'coming back does NOT erase the mark');
    assert.equal(returnedRec.round, 1, 'round 1 stays announced for the whole of its life');
    assert.equal(returnedRec.returned, true, 'what the return buys is the gate, not the mark');
    assert.equal(returnedRec.pid, null, 'and the pid goes with the banner it named');
    assert.equal(returnedRec.at, mark.at, 'the announcement is the same announcement, stamp and all');

    // ... and leaving again raises NOTHING, because the only round waiting has had its one
    // banner. Three departures and three returns, to make "any number of times" literal.
    for (let i = 0; i < 3; i++) {
      looking.delete(board.id);
      watch.evaluate(board.id, target(board.id));
      await tick();
      looking.set(board.id, true);
      watch.evaluate(board.id, target(board.id));
      await tick();
    }
    assert.equal(banners.length, 1, 'criterion 3: a round is announced at most once, ever');
    watch.close();
  });

  await check('criterion 5: after a genuine return and a fresh departure, a round never announced earns one banner', async () => {
    // The other side of criterion 3, and the reason the mark is per ROUND rather than per
    // board: a return really does re-arm the board, just not for the round already spent.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(bannerOn(board.id).round, 1);

    looking.set(board.id, true); // the reviewer genuinely comes back
    watch.evaluate(board.id, target(board.id));
    assert.equal(bannerOn(board.id).returned, true);

    addAwaitedRound(board.id, 'a second question, asked while they were here');
    looking.delete(board.id); // ... and leaves again
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'criterion 5: round 2 has never been announced, so it earns one banner');
    const rec = bannerOn(board.id);
    assert.equal(rec.round, 2, 'and the mark moves to the round it is about');
    assert.equal(rec.returned, false, 'with the gate shut again behind it');

    // Round 1 is still awaited and still the oldest -- and still silent forever.
    assert.ok(roundIsAwaitedOpen(readBoard(board.id, home).rounds[0]), 'round 1 really is still waiting');
    looking.set(board.id, true);
    watch.evaluate(board.id, target(board.id));
    looking.delete(board.id);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'and nothing re-announces round 1 or round 2: both marks are spent');
    watch.close();
  });

  await check('criterion 5: a board being looked at raises nothing, however many rounds land on it', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    looking.set(board.id, true);
    for (const prompt of ['a?', 'b?', 'c?']) {
      addAwaitedRound(board.id, prompt);
      watch.evaluate(board.id, target(board.id));
    }
    await tick();
    assert.equal(banners.length, 0);
    assert.equal(announcedAt(board.id), null);
    watch.close();
  });

  // --- ticket: a round nobody can see always rings -----------------------------------
  //
  // The gap this ticket closes: the mark that keeps a round from ringing twice (ADR 74)
  // is per round and permanent, and until now nothing invalidated it when the round it
  // named was AMENDED -- so a re-post that changed a round's content, with the reviewer
  // still gone, rang once for the content it replaced and then fell silent for good.

  await check('AC: a round posted while no board tab is open anywhere rings, whether it is the thread\'s first round or its twentieth', async () => {
    const { banners, watch } = stand();
    const board = seedBoard(); // round 1
    // Nineteen more rounds, each already closed out (answered, exactly as a thread that
    // has been running a while looks), standing in for a long history that must not be
    // what decides this -- only whether anyone is watching NOW.
    const stored = readBoard(board.id, home);
    stored.rounds[0].status = 'sent';
    stored.rounds[0].awaited = false;
    for (let n = 2; n <= 19; n++) {
      stored.rounds.push({ n, postedAt: stored.rounds[0].postedAt, status: 'sent', sentAt: stored.rounds[0].postedAt, title: 'closed out', awaited: false, awaitDeadline: null });
    }
    writeBoard(stored, home);
    addAwaitedRound(board.id, 'round twenty?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'the twentieth round rings exactly as the first would');
    assert.equal(bannerOn(board.id).round, 20, 'and names the round actually waiting, not round 1');
    watch.close();
  });

  await check('AC: a round posted while a board tab is open does not ring', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    looking.set(board.id, true); // the reviewer is looking, right now, when the round lands
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 0, 'a round posted into a board someone is actually watching never rings');
    watch.close();
  });

  await check('AC: a re-post that amends a round already open rings on the same terms as a new round', async () => {
    // The concrete gap: round 1 rings once (nobody watching), and is THEN amended --
    // still nobody watching, still never returned to -- with new content the reviewer
    // has never been told about. "If the reviewer cannot see it, it rings" says this must
    // ring again; before this fix the permanent per-round mark said otherwise.
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'round 1 rings once, unwatched');
    assert.equal(bannerOn(board.id).round, 1);

    // The amend, exactly as handlePostBoard performs it: a fresh call to amendRound,
    // persisted, then the daemon's own two calls in the order server.mjs makes them --
    // `amended` before `evaluate`, since the mark has to be moved before evaluate decides
    // whether there is anything left to announce.
    const fresh = readBoard(board.id, home);
    const result = amendRound(fresh, { blocks: [QUESTION('Ship now, or later?')], cwd: projectDir });
    writeBoard(fresh, home);
    watch.amended(board.id, result.round);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'the amended round rings again -- unseen content, on the same terms as a new round');
    assert.equal(bannerOn(board.id).round, 1, 'still round 1: the amend did not mint a new round number');
  });

  await check('regression: an amend must not regress the mark past round-1, or an OLDER already-answered-for round rings again while the amended one stays silent', async () => {
    // The severe defect a review caught: `nextToAnnounce` always names the OLDEST
    // still-waiting round past the mark, and a board can hold more than one awaited-open
    // round at once (ADR.md entry 45 -- an awaited page round, never sendable per ADR 35,
    // beside a later question round; exactly the shape `waitingArtifactBoard` in the
    // layer-2 checks below models). Clearing the mark to nothing on an amend reopened
    // every round at or below the one just amended, not just that one: an OLDER round
    // already announced and already returned from rang a SECOND time -- breaking "at most
    // once ever" (ADR.md entry 74) -- while the round genuinely amended, the whole point
    // of this ticket, never rang at all.
    const { looking, banners, watch } = stand();
    // Round 1: an awaited PAGE round (ADR 35: never sent, so it stays awaited-open for
    // the rest of the board's life -- the fact the old implementation tripped over).
    const board = createBoard({
      title: 'two awaited rounds', blocks: [{ kind: 'html', html: '<p>an artifact, waiting on a comment</p>' }],
      cwd: projectDir, wait: true, awaitTimeoutMs: AWAIT_MS,
    });
    writeBoard(board, home);

    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'round 1 rings, unwatched');
    assert.equal(bannerOn(board.id).round, 1);

    looking.set(board.id, true); // a genuine return: the gate opens, the mark stays at 1
    watch.evaluate(board.id, target(board.id));
    assert.equal(bannerOn(board.id).returned, true);
    looking.set(board.id, false);

    addAwaitedRound(board.id, 'Ship now, or later?'); // round 2, a genuinely new round
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'round 2 rings, never having been told about before');
    assert.equal(bannerOn(board.id).round, 2);

    // Round 2 is re-posted while nobody is watching -- still open, still asks something.
    const fresh = readBoard(board.id, home);
    const result = amendRound(fresh, { blocks: [QUESTION('or this one?')], cwd: projectDir });
    writeBoard(fresh, home);
    watch.amended(board.id, result.round);
    watch.evaluate(board.id, target(board.id));
    await tick();

    assert.equal(banners.length, 3, 'round 2 rings again for the content the reviewer never saw');
    assert.equal(bannerOn(board.id).round, 2, 'the mark names round 2, the round actually amended -- it never regresses to round 1');

    // And round 1 -- already announced, already returned from -- earns nothing from any
    // of this, however many more times the board is re-evaluated.
    for (let i = 0; i < 3; i++) {
      watch.evaluate(board.id, target(board.id));
      await tick();
    }
    assert.equal(banners.length, 3, 'round 1 never rings a second time: the amend touched round 2 alone');
    watch.close();
  });

  await check('AC: an amend to a round that has never rung leaves the grace running, and it still rings only once', async () => {
    // The other half of "watched exactly like a new one": an amend before the round's
    // very first ring must not create a SECOND countdown or a second banner -- the
    // existing grace, re-decided at fire time against whatever is on disk by then, was
    // already correct for this case (see `announce`'s own re-read), and `amended` is a
    // no-op here because there is no mark yet to clear.
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id)); // arms the grace, does not fire yet
    const fresh = readBoard(board.id, home);
    const result = amendRound(fresh, { blocks: [QUESTION('actually, ship now?')], cwd: projectDir });
    writeBoard(fresh, home);
    watch.amended(board.id, result.round); // no mark exists yet: a no-op
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'exactly one banner, for the amended content, not two');
    watch.close();
  });

  await check('AC: a round that rings, is then opened and answered, does not ring again', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'it rings once, unwatched');

    // Opened: the reviewer arrives.
    looking.set(board.id, true);
    watch.evaluate(board.id, target(board.id));
    assert.equal(bannerOn(board.id).returned, true, 'a genuine return');

    // Answered: exactly as handleSubmit leaves the round -- `sent`, no longer awaited --
    // and the daemon's own `answered` call withdrawing whatever is still on screen.
    const stored = readBoard(board.id, home);
    stored.rounds[0].status = 'sent';
    stored.rounds[0].awaited = false;
    writeBoard(stored, home);
    watch.answered(board.id, 1);

    // They leave, and come back, any number of times: nothing about this round is ever
    // worth a second banner again.
    for (let i = 0; i < 3; i++) {
      looking.set(board.id, false);
      watch.evaluate(board.id, target(board.id));
      await tick();
      looking.set(board.id, true);
      watch.evaluate(board.id, target(board.id));
    }
    assert.equal(banners.length, 1, 'answered, and never rings again');
    watch.close();
  });

  await check('criterion 8: a round that is not awaited raises nothing -- never awaited, answered, or lapsed', async () => {
    const { banners, watch } = stand();

    const artifact = seedBoard({ wait: false });
    watch.evaluate(artifact.id, target(artifact.id));

    const answered = seedBoard();
    const b1 = readBoard(answered.id, home);
    b1.rounds[0].status = 'sent';
    writeBoard(b1, home);
    watch.evaluate(answered.id, target(answered.id));

    const lapsed = seedBoard();
    const b2 = readBoard(lapsed.id, home);
    b2.rounds[0].awaitDeadline = new Date(Date.now() - 1000).toISOString();
    writeBoard(b2, home);
    watch.evaluate(lapsed.id, target(lapsed.id));

    await tick();
    assert.equal(banners.length, 0, 'three boards with nothing genuinely awaited on any of them');
    watch.close();
  });

  // --- the Suppressed clause (ADR.md entry 92) --------------------------------------
  //
  // The check just above is this one's ablation control: the SAME board, content-only and
  // not Suppressed, raises nothing at all. Everything below turns on one field.

  await check('ADR 92: a Suppressed board whose first round asks nothing is Stranded all the same', async () => {
    const { banners, watch } = stand();
    const board = seedBoard({ wait: false, suppressed: true });
    watch.evaluate(board.id, target(board.id));
    assert.equal(banners.length, 0, 'the grace is served here exactly as it is for an awaited round');
    await tick();
    assert.equal(banners.length, 1, 'no tab was opened for this board, so the Banner is the only thing that can announce it');
    assert.equal(banners[0].folder, 'my-project');
    assert.equal(bannerOn(board.id).round, 1, 'the mark goes onto round 1, which is what makes this once and for all');
    watch.close();
  });

  await check('ADR 92: and its Banner is clickable, bounded by the launcher\'s ceiling alone', async () => {
    const { banners, watch } = stand();
    const board = seedBoard({ wait: false, suppressed: true });
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(banners[0].url, `${URL_A}/b/${board.id}#stranded-round`,
      'clicking has to land on the board -- announcing a board nobody can reach announces nothing');
    assert.equal(banners[0].port, PORT, 'and the bound port beside it, or src/notify.mjs refuses the click outright');
    // Nothing on this board is Awaited, so no round deadline exists to bound the
    // click-serving child with -- and an ABSENT bound is not "no bound": src/notify.mjs's
    // `clickSecondsUntil` answers null for one, which drops the URL, the port and the
    // lifetime together and leaves a banner that cannot be clicked at all. The launcher's
    // hard ceiling is what stands in.
    assert.ok(Number.isFinite(banners[0].deadlineAt),
      `a finite bound, or there is no click: got ${banners[0].deadlineAt}`);
    assert.ok(Math.abs(banners[0].deadlineAt - (Date.now() + CLICK_LIFETIME_MAX_MS)) < 5000,
      `the ceiling alone, since nothing else bounds it: got ${banners[0].deadlineAt - Date.now()}ms`);
    assert.equal(bannerOn(board.id).until, new Date(banners[0].deadlineAt).toISOString(),
      'and `until` says the same thing, so the pid this record names is bounded by the life the child was actually given');
    watch.close();
  });

  await check('ADR 92: one Banner, once -- a return and a fresh departure buy a Suppressed board no second one', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard({ wait: false, suppressed: true });
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    // A genuine return, which is the one thing that opens the gate (ADR.md entry 74) --
    // and the case that would otherwise loop forever here, since a content-only round
    // never stops being the first round and never gets answered.
    looking.set(board.id, true);
    watch.evaluate(board.id, target(board.id));
    assert.equal(bannerOn(board.id).returned, true, 'the gate really did open');
    looking.set(board.id, false);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'round 1 sits at the mark, so an open gate has nothing left to announce');
    watch.close();
  });

  await check('ADR 92: a Suppressed board whose first round is already closed raises nothing', async () => {
    const { banners, watch } = stand();
    const board = seedBoard({ suppressed: true });
    const stored = readBoard(board.id, home);
    stored.rounds[0].status = 'sent';
    writeBoard(stored, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 0,
      'an answered first round is a reviewer who got to the board; this clause is for one that landed in silence');
    watch.close();
  });

  await check('ADR 92: a Suppressed board the reviewer has READ and closed is never announced afterwards', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard({ wait: false, suppressed: true });
    // Reached before any banner was ever raised -- the reviewer followed the index, or a
    // chat link. There is no banner record here for a return gate to be opened on, so the
    // visit has to be recorded somewhere of its own or it leaves no trace at all.
    looking.set(board.id, true);
    watch.evaluate(board.id, target(board.id));
    assert.equal(readBoard(board.id, home)[SUPPRESSED], false,
      'the debt is paid on the board document: this board no longer owes anyone an announcement');
    // And now they close the tab. Before this was recorded, one grace later a Banner
    // announced the board they had just finished reading.
    looking.set(board.id, false);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 0, 'nothing announces a board the reviewer has already been to');
    assert.equal(announcedAt(board.id), null);
    watch.close();
  });

  await check('ADR 92: a Suppressed board whose first round LAPSED is the awaited case, not the content-only one', async () => {
    const { banners, watch } = stand();
    // A wait that ran out. `closeLapsedAwaitedRounds` (src/badge.mjs) clears `awaited` and
    // leaves `status: 'open'` FOREVER, so "open and not awaited" is not the same shape as
    // "content-only" -- and this one carries a deadline that has already passed, which
    // would bound the click-serving child in the past and land the reviewer on a round
    // nothing can answer.
    const board = seedBoard({ suppressed: true });
    const stored = readBoard(board.id, home);
    stored.rounds[0].awaitDeadline = new Date(Date.now() - 60_000).toISOString();
    writeBoard(stored, home);
    const lapsed = readBoard(board.id, home);
    assert.equal(lapsed.rounds[0].status, 'open', 'the premise: a lapsed round keeps `open` for good');
    assert.equal(lapsed.rounds[0].awaited, false, 'and stops being awaited, so `waitingRounds` drops it');

    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 0, 'a round whose wait has run out is not a round nobody has been told about');
    assert.equal(announcedAt(board.id), null);
    watch.close();
  });

  await check('criterion 9: nothing crosses between boards, in either direction', async () => {
    const { looking, banners, watch } = stand();
    const mine = seedBoard();
    const theirs = seedBoard();
    // The reviewer is sitting on a DIFFERENT board's tab. That is not looking at this one.
    looking.set(theirs.id, true);
    watch.evaluate(mine.id, target(mine.id));
    watch.evaluate(theirs.id, target(theirs.id));
    await tick();
    assert.equal(banners.length, 1, 'exactly the board nobody is Attending announces');
    assert.equal(banners[0].url, `${URL_A}/b/${mine.id}#stranded-round`);
    assert.equal(announcedAt(theirs.id), null, 'the attended board is untouched');
    watch.close();
  });

  await check('the round-banner switch silences it, and the pomodoro switch does not', async () => {
    const settingsPath = path.join(home, 'pomodoro.json');
    // QUIRKS.md: an explicit temporary home, so this never lands on the reader's real
    // pomodoro state. CLAUDE_BOARD_HOME has pointed at `home` since the top of the file.
    writeFileSync(settingsPath, JSON.stringify({ settings: { notifyRounds: false } }));
    const off = stand();
    const silenced = seedBoard();
    off.watch.evaluate(silenced.id, target(silenced.id));
    await tick();
    assert.equal(off.banners.length, 0, 'criterion 17: round banners have their own control');
    assert.equal(announcedAt(silenced.id), null,
      'a banner that was never raised must not leave a marker suppressing the next one');
    off.watch.close();

    // Pomodoro banners off, round banners left alone: this rule still fires.
    writeFileSync(settingsPath, JSON.stringify({ settings: { notify: false } }));
    const on = stand();
    const loud = seedBoard();
    on.watch.evaluate(loud.id, target(loud.id));
    await tick();
    assert.equal(on.banners.length, 1, 'silencing the pomodoro must not silence these');
    on.watch.close();

    rmSync(settingsPath, { force: true });
  });

  await check('criterion 15: a round being answered terminates the process serving the click', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(watch.answered(board.id, 1), true, 'round 1 is the round the banner is about');
    assert.deepEqual(banners[0].child.killed, ['SIGTERM']);
    watch.close();
  });

  await check('criterion 15: answering a DIFFERENT round leaves the banner alone', async () => {
    // A board can hold two awaited rounds at once (ADR 45: an awaited page round beside a
    // question round), and the banner names the oldest. Killing the child for any submit
    // withdrew a banner about round 1 when round 2 was answered -- and then the record
    // still stood, because round 1 was still awaited, so the suppression rule itself
    // forbade a replacement. The reviewer lost the signal for a round still waiting, for
    // the rest of its forty minutes.
    const { banners, withdrawn, watch } = stand();
    const board = seedBoard();                          // round 1, awaited
    addAwaitedRound(board.id, 'a second, awaited too?'); // round 2, awaited
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(bannerOn(board.id).round, 1, 'the banner is about the oldest round');

    assert.equal(watch.answered(board.id, 2), false, 'round 2 is not what this banner is about');
    assert.deepEqual(banners[0].child.killed, [], 'so nothing is withdrawn');
    assert.deepEqual(withdrawn, [], 'and no recorded pid is signalled either');

    // Round 1, the one it IS about, does withdraw it.
    assert.equal(watch.answered(board.id, 1), true);
    assert.deepEqual(banners[0].child.killed, ['SIGTERM']);
    watch.close();
  });

  await check('criterion 15: ... including after an unclean restart, where the answer comes with no tab', async () => {
    // The gap: `answered` could only reach the handle THIS process holds. After a SIGKILL
    // restart there is none, and a round answered by a script carrying the local secret
    // produces no Watcher and no attended report either -- the submit-by-secret case. The
    // orphan then kept its banner up, pointing at a round already answered, and a later
    // round would raise a second one beside it. Being answered says nothing about whether
    // the child has exited: its lifetime is the round's DEADLINE.
    const crashed = stand();
    const board = seedBoard();
    crashed.watch.evaluate(board.id, target(board.id));
    await tick();
    const rec = bannerOn(board.id);
    assert.equal(rec.pid, 4242);

    const successor = stand(); // no handle for that child anywhere in this process
    assert.equal(successor.watch.answered(board.id, 1), true);
    assert.deepEqual(successor.withdrawn, [{ pid: 4242, startedAtMs: Date.parse(rec.at) }],
      'the recorded pid is what withdraws it, bounded by when the record was written');
    successor.watch.close();
    crashed.watch.close();
  });

  await check('criterion 15: stopping the daemon leaves none of them running', async () => {
    const { banners, watch } = stand();
    const one = seedBoard();
    const two = seedBoard();
    watch.evaluate(one.id, target(one.id));
    watch.evaluate(two.id, target(two.id));
    await tick();
    assert.equal(banners.length, 2, 'two absent boards, two banners -- they are counted per board');
    watch.close();
    assert.deepEqual(banners.map(b => b.child.killed), [['SIGTERM'], ['SIGTERM']]);
  });

  // The ABRUPT half of criterion 15's last sentence, which the check above cannot reach:
  // `close()` is the graceful path, and bin/daemon.mjs's shutdown backstop calls
  // `process.exit()` outright when a socket refuses to die, so src/stranded.mjs's
  // module-level `process.on('exit')` hook is the only thing between that and an unref'd
  // click child serving a banner for up to an hour with no daemon behind it.
  //
  // Nothing in-process can observe that hook: by the time it runs, the assertions that
  // would read it are gone with the process. So the scene is set in a REAL child, which
  // builds two watches over this same store, lets each raise a banner over a real
  // detached grandchild, records what it built, and then exits WITHOUT calling `close()`.
  // Only the parent can ask the question that matters -- are the grandchildren still
  // there -- and it asks it after reaping the child, by pid.
  //
  // Two watches, not one, because `strandedExitHookInstalled` means the listener is
  // installed once for ALL of them: one watch closing is no evidence the second was
  // reached, and the suite creates dozens. The latch itself is recorded from inside, where
  // it is observable, as the number of 'exit' listeners standing after two registrations.
  //
  // SIGKILL is deliberately NOT the shape under test. Nothing runs on SIGKILL, src/
  // stranded.mjs says so, and the child's own deadline is what bounds that case.
  const ABRUPT_EXIT_CHILD = `// Written by test/check-stranded.mjs; see "the abrupt path" there.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , strandedUrl, boardA, boardB, reportPath] = process.argv;
const { createStrandedWatch } = await import(strandedUrl);

const pids = [];
const stand = () => createStrandedWatch({
  home: process.env.CLAUDE_BOARD_HOME,
  // attendedRemainingMs is what evaluate actually asks (ADR 73): 0 is "nobody is
  // watching and no look-away window is running", which is this scene's whole premise.
  sse: { attendedRemainingMs: () => 0 },
  // A real process, detached and unref'd exactly as src/notify.mjs leaves the
  // click-serving child: it outlives this one unless something kills it, which is the
  // whole fact under test. Long enough that its own deadline cannot be what ends it.
  notify: () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],
      { stdio: 'ignore', detached: true });
    child.unref();
    pids.push(child.pid);
    return child;
  },
  withdraw: () => {},
});

const watches = [stand(), stand()];
watches[0].evaluate(boardA, { url: 'http://127.0.0.1:7391/b/' + boardA, port: 7391 });
watches[1].evaluate(boardB, { url: 'http://127.0.0.1:7391/b/' + boardB, port: 7391 });
await new Promise(r => setTimeout(r, 200));

// Written, not printed: process.exit() below can truncate a pipe mid-write.
writeFileSync(reportPath, JSON.stringify({ pids, exitListeners: process.listenerCount('exit') }));
// No close(), on purpose. This is the backstop calling exit outright.
process.exit(0);
`;

  /** True once the pid is gone. Bounded polling rather than a fixed sleep: the parent is
   * dying at the same time, so the grandchild's reparenting-and-reaping is not something
   * a number of milliseconds can be chosen for. */
  async function waitForGone(pid, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { process.kill(pid, 0); } catch { return true; }
      await tick(20);
    }
    return false;
  }

  await check('criterion 15: an abrupt process.exit(), with no graceful close, still takes every click-serving child', async () => {
    const one = seedBoard({ cwd: projectFor('abrupt-one') });
    const two = seedBoard({ cwd: projectFor('abrupt-two') });
    const childPath = path.join(workDir, 'abrupt-exit-child.mjs');
    const reportPath = path.join(workDir, 'abrupt-exit-report.json');
    writeFileSync(childPath, ABRUPT_EXIT_CHILD);

    const spawned = await new Promise((resolve, reject) => {
      const kid = spawn(process.execPath, [
        childPath,
        new URL('../src/stranded.mjs', import.meta.url).href,
        one.id,
        two.id,
        reportPath,
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, CLAUDE_BOARD_STRANDED_GRACE_MS: '1' },
      });
      let stderr = '';
      kid.stderr.on('data', d => { stderr += d; });
      kid.on('error', reject);
      kid.on('close', code => resolve({ code, stderr }));
    });
    assert.equal(spawned.code, 0, `the abrupt-exit child could not set the scene: ${spawned.stderr}`);

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.pids.length, 2, 'two absent boards, two real click-serving grandchildren');
    assert.equal(report.exitListeners, 1,
      "two watches must share ONE 'exit' listener: the strandedExitHookInstalled latch is what keeps the suite's dozens of watches from piling them up");
    try {
      for (const pid of report.pids) {
        assert.ok(await waitForGone(pid),
          `the click-serving child ${pid} outlived the daemon that spawned it -- the 'exit' hook did not reach its watch`);
      }
    } finally {
      // Never leave one behind if the assertion above is the thing that failed.
      for (const pid of report.pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  await check('criterion 15: a stop kills every child even when the store cannot be written', async () => {
    // "Stopping the daemon leaves none of them running" has no conditions on it. An
    // unref'd child left behind outlives its owner by up to an hour, with a banner on
    // screen whose click hands LaunchServices a port that belongs to nothing. The
    // write-before-withdraw ordering that `spend` uses is about keeping a LIVE daemon's
    // record and screen in agreement; a daemon that is going away has no such duty.
    const { banners, watch } = stand();
    const board = seedBoard();
    const boardsDir = path.join(home, 'boards');
    const mode = statSync(boardsDir).mode;
    try {
      chmodSync(boardsDir, 0o500); // full disk, read-only volume, whatever it is
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1, 'the banner still fires');
      assert.equal(bannerOn(board.id), null, 'and nothing about it reached disk');
      watch.close();
      assert.deepEqual(banners[0].child.killed, ['SIGTERM'],
        'the child goes anyway: nothing in this path may make the kill conditional');
    } finally {
      chmodSync(boardsDir, mode);
      watch.close();
    }
  });

  await check('criterion 4: a tab that comes back inside the grace raises no banner', async () => {
    await withGrace(400, async () => {
      const { looking, banners, watch } = stand();
      const board = seedBoard();
      try {
        watch.evaluate(board.id, target(board.id)); // the last Watcher just dropped
        await tick(60);
        // ... and reconnected, well inside the window. The tab reports from its own
        // `watcher` handler one round trip later, and THAT is what makes this silent --
        // not the bare socket, which says nothing about whether anyone is looking.
        looking.set(board.id, null);
        watch.evaluate(board.id, target(board.id)); // subscribed, has not spoken yet
        looking.set(board.id, true);
        watch.evaluate(board.id, target(board.id)); // ... and says it is looking
        await tick(500);
        assert.equal(banners.length, 0, 'the grace exists so a reconnect is never mistaken for an absence');
        assert.equal(announcedAt(board.id), null);
      } finally {
        watch.close();
      }
    });
  });

  await check('criterion 7: a hidden tab reconnecting is not the reviewer coming back, and raises no second banner', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    // A tab is open but buried, so the board is announced -- criterion 3, a reachable
    // state rather than a contrived one.
    looking.set(board.id, false);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    const announced = announcedAt(board.id);
    assert.ok(announced);

    // The socket drops and the tab reconnects: an EventSource reconnect, a laptop wake,
    // or a daemon restart with that same buried tab still open. The Watcher is fresh, so
    // it has reported nothing yet.
    looking.delete(board.id);
    watch.evaluate(board.id, target(board.id));
    looking.set(board.id, null);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(announcedAt(board.id), announced,
      'a Watcher that has said nothing yet must not end an absence: the marker is untouched, stamp and all');
    assert.deepEqual(banners[0].child.killed, [],
      'and the banner already delivered is not withdrawn, because nobody has come back to withdraw it for');

    // ... and a round trip later the page says what it always was: still hidden.
    looking.set(board.id, false);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1,
      'criterion 7: still exactly one banner for this absence -- the reviewer has not come back');
    watch.close();
  });

  await check('a reconnect does not RESTART the grace, however often it happens', async () => {
    // The bug this pins: a fresh Watcher counts as Attended, so an `evaluate` on subscribe
    // used to cancel the pending timer, and the tab's "still hidden" report a round trip
    // later armed a whole new one. A buried tab on a flaky socket -- or a laptop waking --
    // reconnecting oftener than the grace is long then never produced a banner at all.
    await withGrace(200, async () => {
      const { looking, banners, watch } = stand();
      const board = seedBoard();
      try {
        watch.evaluate(board.id, target(board.id)); // the last Watcher dropped: the grace starts here
        // Reconnecting every 40ms for 240ms -- oftener than the grace is long, and for
        // longer than it lasts. Restart the countdown on any of these and it never
        // finishes; leave it alone and it fires at 200 regardless of the churn.
        for (let i = 0; i < 6; i++) {
          await tick(40);
          looking.set(board.id, null);   // reconnects ...
          watch.evaluate(board.id, target(board.id));
          looking.set(board.id, false);  // ... and reports, a round trip later, that it is still buried
          watch.evaluate(board.id, target(board.id));
        }
        assert.equal(banners.length, 1,
          'the banner arrives one grace after the countdown started, however many reconnects landed on top of it');
      } finally {
        watch.close();
      }
    });
  });

  await check('a Watcher that subscribes and never reports stops holding the banner back', async () => {
    // `/events` needs only a READ credential, so a subscriber that never sends an
    // attended report would otherwise be a mute button on any board it likes -- with the
    // rule's whole authentication story (criterion 16) sitting on the write it never makes.
    // `/events` needs only a READ credential, so a subscriber that never sends an attended
    // report must not be able to mute a board -- the rule's whole authentication story
    // (criterion 16) sits on the write it never makes. A per-Watcher age bound could not
    // close this: reconnecting shortly before each grace expires keeps every Watcher
    // younger than the bound forever. So an unreported Watcher simply does not count.
    await withGrace(150, async () => {
      const { looking, banners, watch } = stand();
      const board = seedBoard();
      try {
        watch.evaluate(board.id, target(board.id)); // the last Watcher dropped: the grace starts
        // A subscriber that holds the stream open and says nothing, reconnecting every
        // 50ms against a 150ms grace -- the churn that defeats any per-Watcher bound.
        for (let i = 0; i < 8; i++) {
          await tick(50);
          looking.set(board.id, null);
          watch.evaluate(board.id, target(board.id));
        }
        assert.equal(banners.length, 1, 'silence is not evidence that anyone is looking, however often it reconnects');
      } finally {
        watch.close();
      }
    });
  });

  await check('criterion 7: several rounds awaited at once is still one board and one banner', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();                          // round 1, awaited
    addAwaitedRound(board.id, 'a second, awaited too?'); // round 2, awaited, 40 minutes out
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'criterion 8');
    assert.equal(bannerOn(board.id).round, 1, 'the record names the oldest, which is what the click resolves to');

    addAwaitedRound(board.id, 'and a third?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'the announced round is still awaited, so this is still the same absence');
    watch.close();
  });

  await check('criterion 6: the announced round being ANSWERED while another waits, with no return, raises nothing', async () => {
    // REWRITTEN (ADR 74). This used to assert the opposite -- that round 1 being answered
    // retired the record and handed round 2 an absence of its own. A round becoming the
    // oldest waiting one is not the reviewer coming back, and it earns nothing on its own.
    const { banners, watch } = stand();
    const board = seedBoard();                          // round 1, awaited
    addAwaitedRound(board.id, 'a second, awaited too?'); // round 2, awaited
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(bannerOn(board.id).round, 1);

    // Round 1 is answered by a script carrying the local secret -- no browser, so no
    // attended Watcher and no return. Round 2 is still awaited and nobody has come back.
    const answered = readBoard(board.id, home);
    answered.rounds[0].status = 'sent';
    writeBoard(answered, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'criterion 6: nobody has come back, so the board stays silent');
    assert.equal(bannerOn(board.id).round, 1, 'the mark stays on the round it was raised for');
    assert.equal(bannerOn(board.id).returned, false, 'and the gate is still shut');

    // ... until the reviewer genuinely returns, and then round 2 gets its one banner.
    watch.close();
  });

  await check('criterion 6: ... and the round the reviewer does come back for is round 2, once', async () => {
    // The same shape carried one step further: the silence of criterion 6 is a delay, not
    // a permanent loss. A genuine return and a fresh departure is what unblocks round 2.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    addAwaitedRound(board.id, 'a second, awaited too?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    const answered = readBoard(board.id, home);
    answered.rounds[0].status = 'sent';
    writeBoard(answered, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    looking.set(board.id, true);   // the reviewer comes back ...
    watch.evaluate(board.id, target(board.id));
    looking.delete(board.id);      // ... and leaves again
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'round 2 has never been announced, so now it earns its one banner');
    assert.equal(bannerOn(board.id).round, 2);
    watch.close();
  });

  await check('criterion 7, literally: a banner that has expired off the screen still counts as this board\'s one announcement', async () => {
    // The case the chosen reading turns on. The reviewer dismissed the banner and never
    // opened the board; the process serving it has long since exited, so there is nothing
    // on screen -- and the round it announced is STILL awaited. One banner per board until
    // the reviewer comes back means exactly that: nothing further for this board.
    //
    // The cost, accepted with the trade-off in view: this reviewer is told nothing more
    // about this board until the announced round's wait ends.
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    const expired = readBoard(board.id, home);
    expired[STRANDED_BANNER].until = new Date(Date.now() - 60_000).toISOString();
    writeBoard(expired, home);
    assert.ok(roundIsAwaitedOpen(readBoard(board.id, home).rounds[0]), 'the announced round really is still awaited');

    addAwaitedRound(board.id, 'a further round, with nobody back?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'exactly one banner total: the absence is still this board\'s one absence');
    assert.equal(bannerOn(board.id).round, 1, 'and the record is untouched');
    watch.close();
  });

  await check('criterion 6: the announced round LAPSING while another waits, with no return, raises nothing', async () => {
    // REWRITTEN (ADR 74). The reviewer swipes the banner away and never comes back. Round
    // 1's wait dies on its own and the process serving its click dies with it, so there is
    // nothing on screen -- and this used to be read as the absence ending, which handed
    // round 2 a second banner nobody had come back for. Lapsing is not returning.
    //
    // The distinct path: criterion 6's other half is a round ANSWERED, above. This one is
    // a wait that simply runs out, which fires no event at all and is noticed lazily.
    const { banners, watch } = stand();
    const board = seedBoard({ awaitTimeoutMs: 150 }); // a wait that dies almost at once
    addAwaitedRound(board.id, 'a second, waiting behind it', AWAIT_MS);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(bannerOn(board.id).round, 1);

    await tick(200); // round 1's wait dies, and the banner raised for it goes with it
    assert.ok(!roundIsAwaitedOpen(readBoard(board.id, home).rounds[0]), 'round 1 really did lapse');
    assert.ok(roundIsAwaitedOpen(readBoard(board.id, home).rounds[1]), 'and round 2 really is still waiting');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'criterion 6: a round becoming the oldest waiting one earns nothing on its own');
    assert.equal(bannerOn(board.id).round, 1, 'the mark is untouched');
    watch.close();
  });

  await check('criterion 6: a further round landing after the announced one is answered raises nothing either', async () => {
    // REWRITTEN (ADR 74). The same rule where the board empties first: with nothing left
    // awaited the record used to be retired outright, so the next round to land announced
    // itself. Emptying is not returning; the gate is still shut.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    // Answered by a script carrying the local secret: no browser, so no attended Watcher
    // and no return to resolve it into one.
    const answered = readBoard(board.id, home);
    answered.rounds[0].status = 'sent';
    writeBoard(answered, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.ok(bannerOn(board.id), 'the mark survives the round it names being answered');

    addAwaitedRound(board.id, 'a new round, with nobody back?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1, 'still silent: nobody has been back to this board');

    looking.set(board.id, true);
    watch.evaluate(board.id, target(board.id));
    looking.delete(board.id);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'and a genuine return and departure is what finally lets round 2 speak');
    watch.close();
  });

  await check('`until` bounds the pid, and nothing else: it is when the banner\'s own process exits', async () => {
    // Its one job is keeping a stale record from signalling a recycled pid. It is
    // deliberately NOT a term in whether the record suppresses -- see the criterion 7
    // check above, which is what that would break.
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    const rec = bannerOn(board.id);
    assert.ok(Date.parse(rec.until) <= Date.parse(rec.at) + CLICK_LIFETIME_MAX_MS,
      '`until` is the launcher\'s ceiling at the latest');
    assert.ok(Date.parse(rec.until) <= Date.parse(readBoard(board.id, home).rounds[0].awaitDeadline),
      '... and the round\'s own deadline if that comes sooner');
    watch.close();
  });

  await check('a failed durable write does not turn one absence into a banner per round', async () => {
    // `persist` returning false was not read. On a read-only store or a full disk the
    // banner fires, the record does not land, and every round after it announces again --
    // a pile-up arriving exactly when the machine is already in trouble.
    const { banners, watch } = stand();
    const board = seedBoard();
    const boardsDir = path.join(home, 'boards');
    const mode = statSync(boardsDir).mode;
    try {
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1);
      // Wipe the record and make the store refuse writes, so the next announce cannot land.
      const wiped = readBoard(board.id, home);
      wiped[STRANDED_BANNER] = null;
      writeBoard(wiped, home);
      chmodSync(boardsDir, 0o500);

      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 2, 'the banner still fires -- a broken store must not cost the reviewer the signal');
      assert.equal(bannerOn(board.id), null, 'and the write really did fail');

      // Every later event on this board -- a round landing, a tab closing -- is another
      // chance to announce the same absence again.
      for (let i = 0; i < 3; i++) watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 2,
        'but this daemon remembers it announced, so the rounds behind it add nothing (criterion 7)');
    } finally {
      chmodSync(boardsDir, mode);
      watch.close();
    }
  });

  await check('a return that could not be written withdraws nothing either: the record and the screen agree', async () => {
    // Withdrawing first and then restoring the record on a write that failed left the
    // banner GONE and the board still believing nobody had come back, which suppressed
    // every later round for the rest of the wait -- the reviewer silently loses the signal
    // on a machine that is already in trouble. So the write goes first and the withdrawal
    // only follows a write that landed.
    //
    // The cost, stated: on a read-only store, coming back to a board does not take its
    // banner off the screen until the store recovers. Consistent and recoverable, which
    // "banner gone, board deaf" was not.
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    const boardsDir = path.join(home, 'boards');
    const mode = statSync(boardsDir).mode;
    try {
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1);
      assert.ok(bannerOn(board.id));

      chmodSync(boardsDir, 0o500);
      looking.set(board.id, true);   // the reviewer comes back, but the gate cannot be written
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.deepEqual(banners[0].child.killed, [], 'nothing is withdrawn, because nothing could be recorded');
      assert.equal(bannerOn(board.id).returned, false, 'and the gate is still shut, which is what the screen shows');

      // The store comes back. Now returning does both.
      chmodSync(boardsDir, mode);
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.deepEqual(banners[0].child.killed, ['SIGTERM'], 'the withdrawal it owed');
      assert.equal(bannerOn(board.id).returned, true, 'and the gate it owed');
      assert.equal(bannerOn(board.id).pid, null, 'with the pid cleared alongside the banner it named');
    } finally {
      chmodSync(boardsDir, mode);
      watch.close();
    }
  });

  await check('a failed durable write during an amend withdraws nothing: the banner stays up, and the record is unchanged', async () => {
    // Finding 2's fix, pinned the same way `returned`'s own read-only checks above pin
    // its half of the identical order: WRITE FIRST, WITHDRAW SECOND. `amended` used to
    // withdraw before it even tried to persist, with no restore on a failed write --
    // exactly the "banner gone, board still naming the stale round" shape `returned`'s
    // own comment (two checks up) warns against. On a read-only store the move to
    // round-1 cannot land, so nothing may be withdrawn either, and the record -- on disk
    // and in whatever this daemon reads next -- has to still name the round it always
    // named.
    const { banners, watch } = stand();
    const board = seedBoard();
    const boardsDir = path.join(home, 'boards');
    const mode = statSync(boardsDir).mode;
    try {
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1, 'round 1 rings, unwatched');
      const before = bannerOn(board.id);
      assert.ok(before, 'durably recorded');

      const fresh = readBoard(board.id, home);
      const result = amendRound(fresh, { blocks: [QUESTION('or this one?')], cwd: projectDir });
      writeBoard(fresh, home);

      chmodSync(boardsDir, 0o500);
      watch.amended(board.id, result.round);
      assert.deepEqual(banners[0].child.killed, [], 'nothing is withdrawn: the write that would have moved the mark never landed');
      assert.deepEqual(readBoard(board.id, home)[STRANDED_BANNER], before,
        'the on-disk record is byte-for-byte unchanged -- the write failed, so nothing moved');

      // What this daemon believes has to agree with what is on disk, not with what
      // `amended` tried and failed to write: a later `evaluate` must not act as though
      // the mark had already moved to round 0.
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1, 'still just the one banner: the amend never actually freed round 1');

      // The store recovers, and the same amend -- retried, as the real caller would --
      // behaves normally again.
      chmodSync(boardsDir, mode);
      watch.amended(board.id, result.round);
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 2, 'once the store can be written, the amend rings again');
      assert.equal(bannerOn(board.id).round, 1, 'still round 1: the amend never minted a new round number');
    } finally {
      chmodSync(boardsDir, mode);
      watch.close();
    }
  });

  await check('when the Board is deleted before persist re-reads it, the write reports failure, no Banner is claimed as recorded, and nothing throws', async () => {
    // `persist`'s other failure branch, never exercised until now: `const fresh =
    // readBoard(board.id, home); if (!fresh) return false;`. The failed-write check above
    // breaks the STORE (chmod on boards/), which fails `writeBoard` from inside persist's
    // own try/catch; this breaks the BOARD instead, so `readBoard` returns null cleanly
    // (ENOENT) and `!fresh` returns false with nothing thrown at all.
    //
    // `announce` reads the board once (`boardOf`, from the timer callback) and hands that
    // object to `persist`, which reads it AGAIN before writing -- both inside the same
    // synchronous callback, with `notify` the only call in between the two reads. Deleting
    // the board is therefore sequenced through `notify`: `stand()`'s own notify pushes the
    // fake banner onto `banners` before handing back the fake child, so overriding just
    // that array's `push` -- not `stand()` itself, which stays exactly as the next owner
    // needs it -- lands the delete precisely between announce's read and persist's re-read.
    // Ordering chosen, not a race provoked.
    const { banners, watch } = stand();
    const board = seedBoard({ cwd: projectFor('deleted-before-persist') });
    const boardFile = path.join(home, 'boards', `${board.id}.json`);
    const originalPush = banners.push.bind(banners);
    banners.push = (...args) => {
      rmSync(boardFile, { force: true });
      return originalPush(...args);
    };

    // Nothing may throw here: `announce` runs from a timer callback with no
    // caller's `try` left around it (see `persist`'s own comment on exactly this), so an
    // uncaught throw there is an uncaught exception at the top of the event loop -- the
    // thing that would take bin/daemon.mjs down. Asserted never to fire, and the listener
    // comes off again in the `finally` so it does not linger for the rest of this file.
    let uncaught = null;
    const onUncaught = err => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    // The load-bearing capture. `persist`'s own `catch` is a backstop that ALSO returns
    // `false` -- for a THROWN failure, not a clean give-up -- so the return value, the
    // `unpersisted` fallback and the disk read the same whether the `!fresh` guard runs
    // or the guard is gone and `fresh[STRANDED_BANNER] = ...` throws a TypeError on
    // `null` that the same `catch` swallows. Silence is the only thing that tells the two
    // apart: the guard's own comment calls a deleted board an ordinary outcome ("there is
    // nothing to record on"), while the `catch` path always prints `could not record the
    // stranded banner`. Without this capture, every assertion above still holds with the
    // guard deleted outright, and the case stays green for the wrong reason.
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    try {
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1, 'the banner still fires: notify runs before the write is even attempted');
      assert.ok(!existsSync(boardFile), 'the board really is gone by the time persist re-reads it');
      assert.equal(uncaught, null, 'nothing throws when the write finds no document left to write to');
      assert.ok(!said.some(line => line.includes(board.id)),
        `a board deleted before persist re-reads it is handled silently, not logged as a failure -- got: ${JSON.stringify(said)}`);

      // "no Banner is claimed as recorded": there is no document, so nothing on disk can
      // say so. Restore the file as a recovery would leave it -- the original board, no
      // banner on it, exactly what `writeBoard(board, home)` here recreates -- and show
      // that THIS daemon still remembers announcing anyway, via the `unpersisted`
      // fallback that took the record's place when the document could not. Further
      // events are further chances to announce the same absence again if that memory
      // were not held -- the same reasoning that keeps rounds piling up behind an
      // announced one silent, applied to a board that came back.
      writeBoard(board, home);
      for (let i = 0; i < 2; i++) watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1, 'the daemon still remembers it announced, though the document holds nothing');
      assert.equal(bannerOn(board.id), null, 'and the restored document really does hold nothing: the write never landed');
    } finally {
      // The board goes back here too, and not only on the success path above: this
      // scenario deletes a real file out from under the store, and an assertion failing
      // before line 1435 would otherwise leave it deleted for the rest of the run. Same
      // reasoning as `withGrace`'s own comment -- a restore that only runs when nothing
      // went wrong turns one red check into several.
      writeBoard(board, home);
      console.error = realError;
      process.off('uncaughtException', onUncaught);
      watch.close();
    }
  });

  await check('a return that could not be written restores the in-memory record byte for byte, not half-mutated with the gate open on a write that never landed', async () => {
    // The restore line (`board[STRANDED_BANNER] = saved;`) puts the object `returned` was
    // holding back to exactly what it was before the gate was opened on it. The check
    // above this one already proves the DOCUMENT is untouched by a failed write; this one
    // is about the in-memory copy the rule was holding when the write failed -- that it
    // goes back rather than being left as `{ ...saved, returned: true, pid: null }` on a
    // gate that was never recorded anywhere.
    //
    // `board` is `returned`'s own local variable, discarded the moment the function
    // returns, and nothing the watch exposes -- the document, `banners`, `withdrawn` --
    // can tell "restored" from "half-mutated" apart from the outside: both paths return
    // before touching any of those again, so both leave the whole watch looking
    // identical. The only honest way to see it is to hold the SAME object `readBoard`
    // hands `returned`, since a mutation in place is visible through any reference to it,
    // discarded or not -- so this spies on `JSON.parse`, the one synchronous seam every
    // `readBoard` call passes through, for the single parse of this board's own file.
    // That changes no behaviour of `stranded.mjs` or `stand()`; it is restored in the
    // `finally` either way, exactly like the chmod it runs alongside.
    const { looking, banners, watch } = stand();
    const board = seedBoard({ cwd: projectFor('half-mutated-return') });
    const boardsDir = path.join(home, 'boards');
    const mode = statSync(boardsDir).mode;
    const originalParse = JSON.parse;
    let captured = null;
    try {
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.equal(banners.length, 1);
      const before = bannerOn(board.id);

      chmodSync(boardsDir, 0o500);
      JSON.parse = function (text, ...rest) {
        const result = originalParse.call(this, text, ...rest);
        // The one parse of THIS board's file triggered by the evaluate below is
        // `returned`'s own `boardOf` read -- the exact object it goes on to mutate and,
        // on a failed write, restore.
        if (result && result.id === board.id && captured === null) captured = result;
        return result;
      };
      looking.set(board.id, true); // the reviewer comes back, but the gate cannot be written
      watch.evaluate(board.id, target(board.id)); // synchronous straight through to `returned`
      JSON.parse = originalParse;
      await tick();

      assert.ok(captured, 'the rule never read the board through JSON.parse, so this check proves nothing');
      assert.deepEqual(captured[STRANDED_BANNER], before,
        'the in-memory record goes back byte for byte -- pid and returned and all -- rather than staying half-mutated with the gate open on a write that never landed');
    } finally {
      JSON.parse = originalParse;
      chmodSync(boardsDir, mode);
      watch.close();
    }
  });

  await check('a child that exits on its own is let go of, rather than kept as a reaped pid', async () => {
    const { banners, withdrawn, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    banners[0].child.die(); // its own deadline came round, or the osascript fallback just exited
    watch.answered(board.id, 1);
    assert.deepEqual(banners[0].child.killed, [],
      'the handle is dropped, so nothing is signalled through a process object that has been reaped');
    // It falls through to the recorded pid instead -- the only honest thing left to try,
    // and bounded by `until` and by the process's own start time before anything is sent.
    assert.deepEqual(withdrawn.map(w => w.pid), [4242]);
    watch.close();
  });

  await check('the daemon\'s own SIGTERM is not reported as a notification failure', async () => {
    // Node hands `killed: true, signal: 'SIGTERM'` to execFile's callback when we kill a
    // child on purpose -- which is every return-to-board. Unexempted, that printed
    // "notifications may not be appearing" on the happy path AND burned the one-shot
    // warning, so a genuinely broken notifier later in the same run said nothing at all.
    // Real `notifyRound` here, against the lingering stub on PATH, not the fake notifier.
    process.env.STUB_OSASCRIPT_LINGER_MS = '3000';
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    try {
      const child = notifyRound('kill-me');
      await tick(120);
      child.kill('SIGTERM');
      await tick(250);
    } finally {
      console.error = realError;
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
    }
    assert.deepEqual(said, [], `killing our own click-serving child must say nothing: ${said.join(' | ')}`);
  });

  await check('the click target names the socket the daemon bound, never the Host header', () => {
    // The banner's URL becomes argv of a signed binary holding the reader's Documents
    // grant, and a click hands it to the browser. `Host` is attacker-chosen -- one
    // `GET /api/board/:id/events` carrying `Host: evil.localhost:31337` used to be
    // enough to repoint an armed grace, because isLoopbackHost admits any `.localhost`
    // label and pins no port, and so a genuine claude-board banner would open somebody
    // else's server. The kernel's answer to "what did I bind" is the only one that
    // cannot be written by the party being defended against.
    const poisoned = {
      headers: { host: 'evil.localhost:31337' },
      socket: { localPort: 7391 },
    };
    const t = strandedTarget(poisoned, 'b_abc');
    assert.equal(t.url, 'http://127.0.0.1:7391/b/b_abc',
      'the bound port and a literal loopback host: no byte of the Host header survives into the click');
    assert.equal(t.port, 7391,
      'and the port crosses separately, because bin/launcher.c checks the URL against it');
    assert.ok(!String(t.url).includes('evil') && !String(t.url).includes('31337'),
      'stated as its own assertion so a future URL shape cannot quietly let the header back in');

    // No socket at all -- a request whose connection died before the rule ran -- is a
    // banner with no click, not a banner with a guessed one.
    const t2 = strandedTarget({ headers: { host: 'evil.localhost:31337' }, socket: null }, 'b_abc');
    assert.deepEqual(t2, { url: null, port: null },
      'nothing to derive a target from means no click, never a fallback to the header');
  });

  await check('a restarted daemon withdraws by pid, but only while that pid can still be the child', async () => {
    // The pid path, which is what an unclean restart leaves: record on disk, no handle in
    // memory. `until` is what bounds it -- past that instant the child has exited and its
    // pid has been recycled onto something else, and the something else may well be the
    // launchd job supervising this daemon, whose SIGTERM is relayed to node.
    const first = stand();
    const board = seedBoard();
    first.watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(first.banners.length, 1);
    const rec = bannerOn(board.id);
    assert.equal(rec.pid, 4242);
    // SIGKILL, so nothing runs: the record survives on disk and the child is orphaned.
    // Deliberately not `close()`, which is the graceful path and retires what it withdraws.

    // A replacement daemon, and the reviewer comes back while the banner is still up.
    const live = stand();
    live.looking.set(board.id, true);
    live.watch.evaluate(board.id, target(board.id));
    assert.deepEqual(live.withdrawn, [{ pid: 4242, startedAtMs: Date.parse(rec.at) }],
      'it signals the recorded pid, and hands over when the record was written so the start time can be checked');
    assert.equal(bannerOn(board.id).returned, true, 'and the return gate opens, with the mark left standing');
    live.watch.close();

    // Now the same thing with a record whose banner must long since have gone.
    const board2 = seedBoard();
    const seeder = stand();
    seeder.watch.evaluate(board2.id, target(board2.id));
    await tick();
    const stale = readBoard(board2.id, home);
    stale[STRANDED_BANNER].until = new Date(Date.now() - 60_000).toISOString();
    writeBoard(stale, home);

    const later = stand();
    later.looking.set(board2.id, true);
    later.watch.evaluate(board2.id, target(board2.id));
    assert.deepEqual(later.withdrawn, [],
      'a pid whose process must have exited is a stranger now -- possibly this daemon\'s own supervisor');
    assert.equal(bannerOn(board2.id).returned, true, 'the gate still opens; only the signal is withheld');
    later.watch.close();
    seeder.watch.close();
    first.watch.close();
  });

  await check('the daemon will not signal its own supervisor, whatever a record says', async () => {
    // The start-time gate used to do this job: the launchd supervisor shares APP_EXEC
    // exactly (install.sh puts that path in ProgramArguments) and its SIGTERM is relayed
    // to node, but it has run since login, so "started before the record was written"
    // excluded it. That stopped being true the moment a graceful stop began leaving
    // records standing -- the SUCCESSOR supervisor starts AFTER `at`. A record naming a
    // pid this daemon itself killed, plus a pid space that has wrapped over half an hour
    // of builds, is a SIGTERM to our own supervisor and every blocked `ask` dying with it.
    assert.equal(mayWithdrawPid(process.ppid), false, 'the parent is the one death that is catastrophic');
    assert.equal(mayWithdrawPid(process.pid), false, 'and signalling ourselves is never the answer either');
    for (const bad of [0, 1, -1, 1.5, NaN, null, undefined, '4242']) {
      assert.equal(mayWithdrawPid(bad), false, `${JSON.stringify(bad)} is not a pid this may signal`);
    }
    // An ordinary pid that is neither still passes, or the guard would have eaten the
    // feature rather than protected it.
    const ordinary = [process.pid, process.ppid].includes(999_99) ? 99_998 : 99_999;
    assert.equal(mayWithdrawPid(ordinary), true);
  });

  await check('the recorded pid is bounded by when it started, not just by what it is called', async () => {
    // `ps -o comm=` alone cannot discriminate: every claude-board process prints the same
    // path, including the launchd job that SUPERVISES this daemon (install.sh puts that
    // exact string in ProgramArguments), whose SIGTERM is relayed to node. So a stale
    // record naming a recycled pid could take the whole daemon down, or withdraw another
    // board's banner while its round was still awaited. The start time is what excludes
    // them: anything running since before the record was written is not what it names.
    assert.equal(parseElapsedTime('05:23'), 323_000, 'mm:ss');
    assert.equal(parseElapsedTime('   05:23  '), 323_000, 'ps pads its columns');
    assert.equal(parseElapsedTime('01:05:23'), 3_923_000, 'hh:mm:ss');
    assert.equal(parseElapsedTime('2-01:05:23'), 176_723_000, 'dd-hh:mm:ss, i.e. the supervisor');
    for (const junk of ['', 'x', '5', '1:2:3:4', null, undefined]) {
      assert.equal(parseElapsedTime(junk), null, `${JSON.stringify(junk)} must refuse rather than guess`);
    }

    // Measured against the real thing rather than assumed: this process's own etime must
    // be a shape the parser accepts, and must place its start in the past.
    const { stdout } = await execFileAsync('ps', ['-o', 'etime=', '-p', String(process.pid)]);
    const elapsed = parseElapsedTime(stdout);
    assert.ok(elapsed !== null, `macOS ps -o etime= must parse, got ${JSON.stringify(stdout)}`);
    assert.ok(elapsed >= 0 && elapsed < 86_400_000, `and be a sane elapsed time, got ${elapsed}`);

    // The COLUMN ORDER is load-bearing and was wrong once, silently. macOS clamps `comm`
    // to MAXCOMLEN (16 bytes) whenever it is not the final column -- so with
    // `-o comm=,etime=` the path comparison in withdrawClickChild could never match on
    // any real install, where APP_EXEC runs past 60 characters, and the recorded-pid
    // path was inert for the one case it exists for. Asserted against a path of that
    // length rather than against this process's own, which on a short-path install would
    // pass either way and prove nothing.
    // Two things about this setup are load-bearing.
    //
    // The path is NOT shaped `claude-board.app/Contents/MacOS/claude-board`, which is what
    // it used to be. Exec'ing an unsigned binary from inside a bundle makes macOS evaluate
    // that bundle: it SIGKILLs the process, registers the bundle with LaunchServices
    // permanently, and puts "claude-board.app is damaged and can't be opened" on screen --
    // under the real install's name, from a suite run, with the real install perfectly
    // fine (QUIRKS.md, "A copied platform binary is SIGKILLed on exec from inside a
    // `.app`, wherever the copy lives" for the kill and the symlink remedy below, and
    // "`lsregister` records are permanent" for the registration that outlives it).
    // Only the LENGTH matters
    // here, so this mirrors the real APP_EXEC's depth with no bundle anywhere in it.
    //
    // And the process at that path is a SYMBOLIC LINK to `process.execPath`, not a copy.
    // `ps` reports the path a process was started from, not the path a link resolves to,
    // so the link proves the same fact a copy would -- at no disk cost, with nothing to
    // clean up but the link itself.
    //
    // The link points at NODE, not `/bin/sleep`. A link to `/bin/sleep` would run the real
    // system binary just fine -- a link carries none of a copy's signature problem -- but
    // `process.execPath` is the one binary certain to exist here: it's the interpreter
    // already running this check, which is why the `-e` flag passed to it below means
    // anything at all.
    const longExec = path.join(workDir, 'launcher-exec-path-over-maxcomlen', 'claude-board');
    mkdirSync(path.dirname(longExec), { recursive: true });
    symlinkSync(process.execPath, longExec);
    assert.ok(longExec.length > 16, 'setup sanity: the path has to exceed MAXCOMLEN to prove anything');
    assert.ok(!longExec.includes('.app/'), 'and must NOT be bundle-shaped: exec\'ing out of one raises the damaged dialog');
    // 30s, not the 5s this started at: nothing waits for the deadline (the `finally` below
    // kills the child the moment the measurements are done), so the only thing a short one
    // bought was a race with `ps` on a machine booting other checks' daemons in parallel.
    const sleeper = spawn(longExec, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    // A spawn that fails (noexec TMPDIR, a dangling link) emits 'error' asynchronously,
    // and an unhandled one on a ChildProcess throws out of the event loop rather than into
    // the try below -- taking the whole file down instead of failing this one check.
    sleeper.on('error', () => {});
    try {
      await new Promise(r => setTimeout(r, 300));
      // Name the child, not `ps`, when setup itself failed: `sleeper.on('error', ...)`
      // above swallows a failed spawn and leaves `pid` undefined, and the child's own
      // deadline can lapse before the two `ps` calls below run on a machine already busy
      // booting daemons in parallel. Either way `ps -p` finds nothing, prints nothing, and
      // exits 1 -- which execFileAsync turns into a rejected "Command failed: ps" that
      // names the wrong culprit.
      //
      // Asserted before EACH `ps` call rather than once at the top: the second call is two
      // awaits after the first, and that gap is itself a window the deadline can lapse in,
      // so a single check at the top leaves the second call able to reject with exactly the
      // misattributed message the guard exists to remove.
      assert.ok(Number.isInteger(sleeper.pid), 'setup failure: the long-path sleeper never got a pid -- spawn failed, not a ps problem');
      const stillAlive = which => assert.doesNotThrow(() => process.kill(sleeper.pid, 0),
        `setup failure: the long-path sleeper exited before the ${which} ps could measure it -- not a ps problem`);
      stillAlive('first');
      const both = await execFileAsync('ps', ['-o', 'etime=,comm=', '-p', String(sleeper.pid)]);
      const line = both.stdout.trim();
      const cut = line.indexOf(' ');
      assert.equal(line.slice(cut + 1).trim(), longExec,
        'etime first, comm last: the full executable path must survive, or the pid gate never fires');
      assert.ok(parseElapsedTime(line.slice(0, cut)) !== null,
        'and the first column must still be an etime the parser accepts');

      stillAlive('second');
      const truncated = await execFileAsync('ps', ['-o', 'comm=,etime=', '-p', String(sleeper.pid)]);
      assert.ok(!truncated.stdout.includes(longExec),
        'and the other order really does truncate -- if macOS ever stops doing this, the comment above is what needs correcting, not this check');
    } finally {
      sleeper.kill();
    }

    // And that withdrawClickChild ASKS for that order. The two assertions above prove a
    // fact about macOS; this one proves the code depends on the right side of it. A
    // behavioural check cannot reach here -- withdrawClickChild returns early without a
    // bundle, so outside one it is unobservable by construction -- and the cost of
    // getting this wrong is not a wrong answer but silence: the gate simply never fires,
    // which is exactly how it shipped.
    const notifySrc = readFileSync(new URL('../src/notify.mjs', import.meta.url), 'utf8');
    assert.match(notifySrc, /'-o',\s*'etime=,comm='/,
      "withdrawClickChild must ask ps for etime FIRST -- with comm first macOS clamps it to 16 bytes and the path comparison can never match an APP_EXEC-length path");
    assert.doesNotMatch(notifySrc, /'comm=,etime='/,
      'and must not ask for the truncating order anywhere');

    // The guards refuse rather than throw, on a path where throwing would reach a timer.
    for (const args of [[0, Date.now()], [-1, Date.now()], [1, Date.now()], [12345, NaN], [12345, undefined]]) {
      assert.doesNotThrow(() => withdrawClickChild(...args), `withdrawClickChild(${args}) must be a silent no-op`);
    }
  });

  await check('when raising a Banner throws, announce contains it: no uncaught exception, the failure is reported, the watch stays usable, and a later round on another board still announces', async () => {
    // `announce` is a timer callback (see its own header comment): by the time it runs,
    // the request handler's try/catch that used to surround this code is long gone, so an
    // uncaught throw here is an uncaught exception at the top of the event loop -- and
    // bin/daemon.mjs answers one of those by exiting, taking every blocked `ask` on the
    // machine with it. This is "raising a Banner throws" specifically (the notifier, not
    // readPomodoroDoc or the write beside it), which is why the double throws only from
    // `notify` and lets everything else `announce` does run normally.
    const prevListeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    let uncaught = null;
    process.on('uncaughtException', err => { uncaught = err; });
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    let watch;
    try {
      const brokenBoard = seedBoard({ cwd: projectFor('poison-notify') });
      const okBoard = seedBoard({ cwd: projectFor('poison-notify-recovers') });
      const banners = [];
      // Throws only for the poisoned board's own folder, so the SAME double can also
      // prove the third observation: a genuinely different board, raised through the
      // same watch, still gets a real banner rather than being wedged by the first one's
      // failure. A double that always throws could not tell "the watch survived" apart
      // from "nothing downstream of it ever runs again".
      const notify = (folder, opts) => {
        if (folder === 'poison-notify') throw new Error('notifier is on fire');
        const child = {
          pid: 4242, killed: [], onExit: null,
          kill(sig) { this.killed.push(sig); },
          once(event, fn) { if (event === 'exit') this.onExit = fn; },
          die() { this.onExit && this.onExit(); },
        };
        banners.push({ folder, ...opts, child });
        return child;
      };
      ({ watch } = stand({ notify }));

      watch.evaluate(brokenBoard.id, target(brokenBoard.id));
      await tick();

      assert.equal(uncaught, null, 'a throwing notifier must not surface as an uncaught exception');
      assert.ok(said.some(s => s.includes('stranded banner') && s.includes(brokenBoard.id)),
        `the failure must be REPORTED via console.error, not silently swallowed -- a handler that says nothing is a different defect than one that rethrows: ${JSON.stringify(said)}`);

      // The watch stays usable. `evaluate` only ARMS a timer -- the throw lives in
      // `announce`, on that timer's own callback -- so a synchronous doesNotThrow around
      // `evaluate` alone would pass whether or not `announce` still catches anything and
      // prove nothing. Re-entering `announce` on the SAME poisoned board is what actually
      // observes containment a second time: the failed notify above never got as far as
      // writing `board[STRANDED_BANNER]`, so nothing here suppresses a second attempt --
      // `evaluate` re-arms, the grace elapses, `announce` runs and throws again, and
      // `uncaught` staying null across BOTH throws is the genuine proof that the watch
      // survived the first one rather than merely not exploding synchronously.
      watch.evaluate(brokenBoard.id, target(brokenBoard.id));
      await tick();
      assert.equal(uncaught, null, 'the watch stays usable: a second announce on the same poisoned board must not surface as an uncaught exception either');
      assert.ok(said.filter(s => s.includes('stranded banner') && s.includes(brokenBoard.id)).length >= 2,
        'and the second failure is reported too, not silently swallowed once the first one has already fired');

      // A later round on ANOTHER board -- its own project directory, its own banner --
      // still announces, proving the throw did not wedge the watch for every board
      // sharing it.
      watch.evaluate(okBoard.id, target(okBoard.id));
      await tick();
      assert.equal(banners.length, 1, 'a later round on another board still announces');
      assert.equal(banners[0].folder, 'poison-notify-recovers', 'and it is a genuinely different board, not the same one retried');
    } finally {
      watch?.close();
      console.error = realError;
      process.removeAllListeners('uncaughtException');
      for (const l of prevListeners) process.on('uncaughtException', l);
    }
  });

  await check('when the socket close path throws, evaluate contains it: no uncaught exception, the failure is reported, the watch stays usable, and a later round on another board still announces', async () => {
    // `evaluate` is what a socket's own close handler calls (src/server.mjs's `cleanup`),
    // with no request frame and no caller's try left around it -- same consequence as
    // `announce` above if it ever rethrows. `evaluate` is the entry point, so the throw
    // has to come from something it calls directly rather than from `boardOf`, which
    // already has its own catch: `sse.attendedRemainingMs` is the very first thing it
    // reads, which is exactly what a hub gone bad would fail on.
    const prevListeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    let uncaught = null;
    process.on('uncaughtException', err => { uncaught = err; });
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    let watch;
    try {
      const brokenBoard = seedBoard({ cwd: projectFor('poison-hub') });
      const okBoard = seedBoard({ cwd: projectFor('poison-hub-recovers') });
      // Throws only for the poisoned board's id, so the same hub double can also answer
      // truthfully -- "nobody attending" -- for any other board, which is what lets the
      // third observation be a real announce rather than a second throw.
      const sse = {
        attendedRemainingMs: id => {
          if (id === brokenBoard.id) throw new Error('hub is on fire');
          return 0;
        },
      };
      let banners;
      ({ banners, watch } = stand({ sse }));

      // A bare `evaluate(boardId)`, the way the close handler in src/server.mjs's
      // `cleanup` drives it. `evaluate` reads `sse.attendedRemainingMs` synchronously as
      // its very first act, so -- unlike the announce case above -- this doesNotThrow
      // really does reach the throw and observe it contained, with no timer in between.
      assert.doesNotThrow(() => watch.evaluate(brokenBoard.id),
        'evaluate must never rethrow -- it runs from a socket close handler with no caller\'s try left, and an uncaught throw there is an uncaught exception at the top of the event loop');
      await tick();

      assert.equal(uncaught, null, 'a throwing hub must not surface as an uncaught exception');
      assert.ok(said.some(s => s.includes('stranded rule') && s.includes(brokenBoard.id)),
        `the failure must be REPORTED via console.error, not silently swallowed -- a handler that says nothing is a different defect than one that rethrows: ${JSON.stringify(said)}`);

      // The watch stays usable: asking it about the very board whose hub just threw does
      // not itself throw. Genuinely reached, for the same reason as above -- no timer
      // sits between this call and `sse.attendedRemainingMs` throwing again.
      assert.doesNotThrow(() => watch.evaluate(brokenBoard.id), 'the watch stays usable after the throw');

      // A later round on ANOTHER board -- its own project directory, its own banner --
      // still announces.
      watch.evaluate(okBoard.id, target(okBoard.id));
      await tick();
      assert.equal(banners.length, 1, 'a later round on another board still announces');
      assert.equal(banners[0].folder, 'poison-hub-recovers', 'and it is a genuinely different board, not the same one retried');
    } finally {
      watch?.close();
      console.error = realError;
      process.removeAllListeners('uncaughtException');
      for (const l of prevListeners) process.on('uncaughtException', l);
    }
  });

  await check('a board id that cannot be a path is a no-op, not a throw', async () => {
    const { banners, watch } = stand();
    // `readBoard` throws for this (src/store.mjs's assertSafeId). It reaches the rule from
    // `handleAttended`, which answers 200 for a board id naming nothing at all.
    assert.doesNotThrow(() => watch.evaluate('../../etc/passwd', target('x')));
    assert.doesNotThrow(() => watch.evaluate('b_never_created', target('x')));
    await tick();
    assert.equal(banners.length, 0);
    watch.close();
  });

  await check('the grace is five seconds by default [was fifteen], and every unusable value falls back to it', async () => {
    assert.equal(DEFAULT_STRANDED_GRACE_MS, 5_000, 'the default the spec fixes, narrowed 2026-08-11 -- every unseen round otherwise carries fifteen seconds of dead time');
    // '' is the one that matters: `Number('')` is 0, and blanking a plist entry is how an
    // operator turns a knob off -- which under a `>= 0` test became a zero grace, i.e. the
    // false positive on a reconnecting tab that this whole rule exists to avoid.
    for (const bad of ['', '   ', '0', '-1', 'soon', 'NaN', '15s']) {
      process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = bad;
      const { banners, watch } = stand();
      const board = seedBoard();
      watch.evaluate(board.id, target(board.id));
      await tick(60);
      assert.equal(banners.length, 0, `CLAUDE_BOARD_STRANDED_GRACE_MS=${JSON.stringify(bad)} must fall back to the shipped five seconds, not fire at once`);
      watch.close();
    }
    delete process.env.CLAUDE_BOARD_STRANDED_GRACE_MS;
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick(120);
    assert.equal(banners.length, 0, 'with the variable unset the shipped five seconds applies, so nothing fires yet');
    watch.close();
    process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '1';
  });

  // AC: "An unseen round rings 5s after it is posted. The wait stays overridable." The
  // check above already pins the fallback default; this pins the override actually being
  // honoured end to end -- a grace set to a few milliseconds fires well inside 5s, and one
  // set past 5s does not fire before it.
  await check('the wait stays overridable: a shorter grace fires before 5s, a longer one has not fired by 5s', async () => {
    await withGrace(30, async () => {
      const { banners, watch } = stand();
      const board = seedBoard();
      watch.evaluate(board.id, target(board.id));
      await tick(200);
      assert.equal(banners.length, 1, 'CLAUDE_BOARD_STRANDED_GRACE_MS overrides the default down, well under 5s');
      watch.close();
    });
    await withGrace(5000, async () => {
      const { banners, watch } = stand();
      const board = seedBoard();
      watch.evaluate(board.id, target(board.id));
      await tick(200);
      assert.equal(banners.length, 0, 'and overrides it up: a 5s grace has not fired 200ms in');
      watch.close();
    });
  });
}

// ====================================================================================
// Layer 2: a real daemon, real event streams, a fake notifier on PATH.
// ====================================================================================

function rawRequest(port, method, pathName, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: { host: `127.0.0.1:${port}`, ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a real event stream and resolve once the daemon has handed it its watcher id --
 * i.e. once it is a Watcher of that board. The caller destroys `req` to close the tab. */
function openStream(port, boardId) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } },
      res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buf += chunk;
          const m = buf.match(/event: watcher\ndata: (.*)\n\n/);
          if (m) resolve({ req, watcher: JSON.parse(m[1]).id });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function postRound(port, body) {
  const r = await rawRequest(port, 'POST', '/api/board', {
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `post failed: ${r.body}`);
  return JSON.parse(r.body);
}

function reportAttended(port, boardId, watcher, attended) {
  return rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
    body: JSON.stringify({ watcher, attended }),
  });
}

/** The reviewer arrives at a board and is looking at it: a stream, then the report the
 * page sends the moment it learns its watcher id (src/ui.mjs's `watcher` event handler
 * calls `reportAttended()` right there, so this is the real sequence and not a
 * convenience). Merely opening a stream is NOT this -- that is a Watcher that has said
 * nothing yet, which is what a reconnect looks like, and which the daemon must not read
 * as the reviewer coming back. */
async function arriveAt(port, boardId) {
  const tab = await openStream(port, boardId);
  await reportAttended(port, boardId, tab.watcher, true);
  return tab;
}

/** Post a first round that asks something, into its own project directory. */
const askBoard = (folder, extra) => ({ title: `Stranded: ${folder}`, blocks: [QUESTION('Ship?')], cwd: projectFor(folder), ...extra });

/** A first round that is Awaited but asks no QUESTION -- an awaited page round (ADR.md
 * entry 45), which is one `html` block and `wait: true`. The point is what happens to the
 * NEXT post: `handlePostBoard` AMENDS a round that is still open and asks something, so a
 * board opened with `askBoard` accumulates amendments to round 1 rather than minting
 * rounds 2 and 3. A board opened this way mints real round numbers, which is what every
 * "a DIFFERENT round" check below needs. */
const waitingArtifactBoard = folder => ({
  title: `Stranded: ${folder}`,
  blocks: [{ kind: 'html', html: '<p>an artifact, waiting on a comment</p>' }],
  cwd: projectFor(folder),
  wait: true,
});

let server, port;

/** `server.close()` alone waits for every open connection, and node's default agent
 * keeps the POST sockets above alive -- so 'close' never fires and the shutdown hook on
 * it never runs. bin/daemon.mjs solves this exact problem the same way and for the same
 * reason, which is what makes this a faithful stand-in for stopping the daemon rather
 * than a shortcut around it. */
function stopServer(s) {
  s.close();
  s.closeIdleConnections?.();
  s.closeAllConnections?.();
}

/** Run `fn` with a different look-away window, and put the old one back even if it
 * throws -- the same shape and the same reason as `withGrace` above. The shipped window
 * is two minutes (ADR 73) and no check may sleep through one. */
async function withWindow(ms, fn) {
  const saved = process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS;
  process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS = String(ms);
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS;
    else process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS = saved;
  }
}

async function layerTwo() {
  process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '60';
  // Layer 2 drives the real hub, so the shipped two-minute look-away window (ADR 73)
  // applies to every `reportAttended(..., false)` below -- a buried tab keeps its board
  // Attended, and nothing here could ever strand. Squashed to 20ms for the whole layer so
  // that "the reviewer switched to the terminal" reads as it did before the window
  // existed; the checks that are ABOUT the window set their own with `withWindow`.
  process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS = '20';
  ({ server, port } = await startServer({ home, port: 0 }));

  await check('criterion 1: a round posted into a board with no tab watching raises one banner', async () => {
    const { boardId, awaited } = await postRound(port, askBoard('unwatched'));
    assert.equal(awaited, true, 'the round has to be genuinely awaited for any of this to be about it');
    const rows = await waitForRows('unwatched', 1);
    assert.deepEqual(rows, [['spawn', '-e', BANNER('unwatched')]],
      'exactly one banner, titled Board, naming the session by its project folder');
    await tick(200);
    assert.equal(spawnsFor('unwatched').length, 1, 'and still exactly one after the grace has come round again');
    assert.ok(announcedAt(boardId), 'the marker went onto the board document');
  });

  await check('AC end to end: a re-post that amends a round already open rings again, through the real POST route', async () => {
    // The wiring this ticket adds to handlePostBoard: `stranded.amended` is called on the
    // amend branch, before the unconditional `stranded.evaluate` -- so this is the one
    // check in the file that proves the two are actually connected, not just that
    // `createStrandedWatch.amended` behaves correctly in isolation (layer 1 above).
    const { boardId } = await postRound(port, askBoard('amend-rings-again'));
    await waitForRows('amend-rings-again', 1);
    assert.equal(bannerOn(boardId).round, 1, 'round 1 rang once, unwatched');

    // Still nobody watching: a second post that amends round 1 (askBoard's question is
    // still open, so this lands on amendRound, not addRound).
    const amended = await postRound(port, { boardId, blocks: [QUESTION('or this one?')] });
    assert.equal(amended.round, 1, 'setup: this really did amend round 1, not mint round 2');

    const rows = await waitForRows('amend-rings-again', 2);
    assert.deepEqual(rows.map(r => r[0]), ['spawn', 'spawn'], 'a second banner, for the content the reviewer has never seen');
    assert.equal(bannerOn(boardId).round, 1, 'still round 1');
  });

  await check('a board that has been announced still serves the page it has on disk', async () => {
    // The record is written with `writeBoard` and NOT `writePage` -- re-rendering a page
    // board from a timer callback would be megabytes of work for a fact no client reads --
    // so it must never reach the rendered payload. When it did, `GET /b/:id` served markup
    // that `pages/<id>.html` did not have, breaking the invariant test/check-http.mjs pins
    // and with it the standalone archive that opens from Finder with no daemon at all.
    // That check misses this because test/run.mjs pushes the grace out of its reach.
    const { boardId } = await postRound(port, askBoard('page-stays-pure'));
    await waitForRows('page-stays-pure', 1);
    assert.ok(bannerOn(boardId), 'the record really is on the stored board');

    const served = (await rawRequest(port, 'GET', `/b/${boardId}`, { headers: { [SECRET_HEADER]: SECRET } })).body;
    const onDisk = readFileSync(path.join(home, 'pages', `${boardId}.html`), 'utf8');
    assert.equal(served, onDisk, 'served page must match the pages/ file exactly');
    assert.equal(served, renderBoardPage(readBoard(boardId, home)),
      're-rendering the stored JSON must reproduce it too -- the record is stripped, not merely absent from one of the three');
    assert.ok(!served.includes(STRANDED_BANNER), 'and the field name appears nowhere in the markup');
    // The second daemon-only field, stripped by the same `stripDaemonOnly` and for the same
    // reason. This one IS written inside the request that renders the page, so the
    // three-way byte identity above would survive it leaking -- which is exactly why it
    // needs saying here: nothing else in the suite would notice a page carrying the
    // daemon's own reasoning about whether it opened a tab.
    assert.ok(readBoard(boardId, home)[SUPPRESSED] === false, 'the field really is on the stored board');
    assert.ok(!served.includes(SUPPRESSED), 'and it appears nowhere in the markup either');
  });

  await check('criterion 1: and it opens no tab', () => {
    const opened = existsSync(process.env.STUB_OPEN_LOG) ? readFileSync(process.env.STUB_OPEN_LOG, 'utf8') : '';
    assert.equal(opened, '',
      'a stub `open` sits ahead of the real one on PATH: the daemon announces, it does not yank a tab in front of anyone');
  });

  // AHEAD of every check below that opens a stream, and that placement is load-bearing
  // since ADR.md entry 92: "not awaited" is only silent on a board that was not Suppressed,
  // and a Watcher standing on ANY board is what suppresses the next board posted. Run after
  // one of those, this asserts the opposite of what the rule now says and fails honestly --
  // so it runs while nothing on this daemon has ever been watched, and says so.
  await check('criterion 8: a round that is not awaited raises no banner', async () => {
    const posted = await postRound(port, {
      title: 'An artifact', blocks: [{ kind: 'markdown', text: 'nothing is asked here' }], cwd: projectFor('not-awaited'),
    });
    assert.equal(posted.suppressed, false, 'the precondition: no tab anywhere, so this board opened one of its own');
    await tick(250);
    assert.equal(spawnsFor('not-awaited').length, 0, 'nothing to answer means nothing to be stranded');
    assert.equal(announcedAt(posted.boardId), null);
  });

  await check('criterion 5: a round landing on a board somebody is looking at raises nothing', async () => {
    const { boardId } = await postRound(port, askBoard('watched'));
    // Posted before any stream existed, so round 1 is announced. Arriving withdraws that
    // banner and opens the return gate; everything after this is the attended case.
    await waitForRows('watched', 1);
    const tab = await arriveAt(port, boardId);
    try {
      await tick(30);
      assert.equal(bannerOn(boardId).returned, true, 'arriving opened the gate');
      for (const n of [2, 3, 4]) await postRound(port, { boardId, blocks: [QUESTION(`round ${n}?`)] });
      await tick(250);
      assert.equal(spawnsFor('watched').length, 1, 'however many rounds land, a board in front of the reviewer says nothing more');
    } finally {
      tab.req.destroy();
    }
  });

  await check('criterion 3: closing the tab on an ALREADY-ANNOUNCED round raises nothing more', async () => {
    // REWRITTEN (ADR 74). This used to assert a second banner here: the round was
    // announced, the reviewer glanced at the board, and closing the tab announced the same
    // round again. That is the defect -- the round is spent, and no amount of leaving and
    // coming back buys it another banner.
    const { boardId } = await postRound(port, askBoard('closed-on'));
    await waitForRows('closed-on', 1);
    const tab = await arriveAt(port, boardId); // the reviewer glances at it
    await tick(30);
    assert.equal(bannerOn(boardId).returned, true);

    tab.req.destroy(); // ... and closes the tab with round 1 still open
    await tick(250);
    assert.equal(spawnsFor('closed-on').length, 1, 'criterion 3: round 1 has had its one banner, ever');
    assert.equal(bannerOn(boardId).round, 1, 'and the mark is untouched');
  });

  await check('criterion 5: closing the tab on a round that has NEVER been announced raises one banner', async () => {
    // The positive twin of the check above, and the case the disconnect hook exists for:
    // the reviewer genuinely returned, a new round landed while they were there, and then
    // they closed the tab. That round has never been announced, so it earns its one banner.
    const { boardId } = await postRound(port, waitingArtifactBoard('closed-on-fresh'));
    await waitForRows('closed-on-fresh', 1);
    const tab = await arriveAt(port, boardId);
    await tick(30);
    assert.equal(bannerOn(boardId).returned, true, 'a genuine return');

    await postRound(port, { boardId, blocks: [QUESTION('asked while they were looking?')] });
    await tick(100);
    assert.equal(spawnsFor('closed-on-fresh').length, 1, 'nothing while they are still looking at it');

    tab.req.destroy(); // ... and the fresh departure
    await waitForRows('closed-on-fresh', 2);
    assert.equal(spawnsFor('closed-on-fresh').length, 2, 'criterion 5: round 2 earns exactly one banner');
    assert.equal(bannerOn(boardId).round, 2, 'and the mark moves to it');
  });

  await check('criterion 3: switching away from an already-announced round raises nothing more', async () => {
    // REWRITTEN (ADR 74), and the exact shape the defect was measured in: the banner's own
    // click brings the tab forward, the reviewer switches back to the terminal, and the
    // same round announces itself again a grace later, once a minute for as long as it
    // waits.
    const { boardId } = await postRound(port, askBoard('switched-away'));
    await waitForRows('switched-away', 1);
    const tab = await arriveAt(port, boardId);
    try {
      await tick(30);
      assert.equal(bannerOn(boardId).returned, true);
      // Buried and brought back, four times over: the ordinary posture, terminal to
      // browser and back.
      for (let i = 0; i < 4; i++) {
        assert.equal((await reportAttended(port, boardId, tab.watcher, false)).status, 200);
        await tick(120);
        await reportAttended(port, boardId, tab.watcher, true);
        await tick(30);
      }
      assert.equal(spawnsFor('switched-away').length, 1,
        'criterion 3: glancing at the board and leaving again, any number of times, raises nothing further');
    } finally {
      tab.req.destroy();
    }
  });

  await check('criterion 7: a tab open but not focused keeps its board attended for the window, and may strand past it', async () => {
    // End to end, through a real daemon and a real event stream: the tab reports that it
    // has lost focus, exactly as src/ui.mjs's own blur handler does, and the board has to
    // stay quiet for the whole window and then be allowed to strand.
    //
    // The window here is 400ms against a 60ms grace, so "inside" and "past" are far enough
    // apart to be two different observations rather than one race.
    await withWindow(400, async () => {
      const { boardId } = await postRound(port, waitingArtifactBoard('look-away'));
      await waitForRows('look-away', 1);
      const tab = await arriveAt(port, boardId);
      try {
        await tick(30);
        assert.equal(bannerOn(boardId).returned, true, 'a genuine return');
        // A round the reviewer has not been told about, posted while they are looking.
        await postRound(port, { boardId, blocks: [QUESTION('and this one?')] });
        await tick(50);
        assert.equal(spawnsFor('look-away').length, 1);

        await reportAttended(port, boardId, tab.watcher, false); // switches to the terminal
        await tick(200); // well past the 60ms grace, well inside the 400ms window
        assert.equal(spawnsFor('look-away').length, 1,
          'criterion 7: a tab open behind the terminal is not nobody watching');

        await waitForRows('look-away', 2, 2000);
        assert.equal(spawnsFor('look-away').length, 2,
          'criterion 7: past the window the board may strand, and this round has never been announced');
        assert.equal(bannerOn(boardId).round, 2);
      } finally {
        tab.req.destroy();
      }
    });
  });

  await check('criterion 8: a tab left focused counts as watching for as long as it stays focused', async () => {
    // No idle detection: nothing reads the reviewer's keyboard. A tab that reported focus
    // once and never reported anything again is watched for as long as it stays connected,
    // here for many times the look-away window.
    await withWindow(30, async () => {
      const { boardId } = await postRound(port, askBoard('left-focused'));
      await waitForRows('left-focused', 1);
      const tab = await arriveAt(port, boardId);
      try {
        await tick(30);
        await postRound(port, { boardId, blocks: [QUESTION('a fresh round, never announced?')] });
        await tick(400); // ~13 windows and ~6 graces, with no further report from the tab
        assert.equal(spawnsFor('left-focused').length, 1,
          'criterion 8: a focused tab never ages out, so the round waits silently in front of the reviewer');
      } finally {
        tab.req.destroy();
      }
    });
  });

  await check('criterion 3: a round landing on a board whose tab is open but hidden rings, and so does an amend to it', async () => {
    // A first round that asks nothing: an open tab, hidden, and nothing yet to strand.
    const { boardId } = await postRound(port, {
      title: 'Hidden tab', blocks: [{ kind: 'markdown', text: 'an artifact' }], cwd: projectFor('hidden-tab'),
    });
    const tab = await openStream(port, boardId);
    try {
      await reportAttended(port, boardId, tab.watcher, false);
      await tick(250);
      assert.equal(spawnsFor('hidden-tab').length, 0, 'nothing awaited yet, so nothing to be stranded');

      await postRound(port, { boardId, blocks: [QUESTION('now something?')] });
      await waitForRows('hidden-tab', 1);
      assert.equal(spawnsFor('hidden-tab').length, 1, 'the round lands on a tab that is open but not looked at');

      // The round just rung is still open and now asks something, so this lands on
      // amendRound, not addRound (see `waitingArtifactBoard`'s own comment on that split).
      // A hidden tab is exactly as unwatched as a closed one for AC purposes -- "if the
      // reviewer cannot see it, it rings" does not distinguish the two -- so the amend
      // rings again here too, on the same terms test/check-stranded.mjs's other AC checks
      // pin for a fully closed tab.
      await postRound(port, { boardId, blocks: [QUESTION('and another?')] });
      await waitForRows('hidden-tab', 2);
      assert.equal(spawnsFor('hidden-tab').length, 2,
        'an amend the reviewer cannot see rings again, even with a tab open behind it');
    } finally {
      tab.req.destroy();
    }
  });

  await check('criterion 5: two tabs on one board count as looking if either one of them is', async () => {
    const { boardId } = await postRound(port, askBoard('two-tabs'));
    await waitForRows('two-tabs', 1);
    const one = await openStream(port, boardId);
    const two = await openStream(port, boardId);
    try {
      await reportAttended(port, boardId, one.watcher, false); // one buried
      await reportAttended(port, boardId, two.watcher, true);  // one in front of the reviewer
      await postRound(port, { boardId, blocks: [QUESTION('while watched?')] });
      await tick(250);
      assert.equal(spawnsFor('two-tabs').length, 1, 'no second banner: either tab looking is enough');
      assert.equal(bannerOn(boardId).returned, true, 'and the looking tab counts as the reviewer being back');
    } finally {
      one.req.destroy();
      two.req.destroy();
    }
  });

  await check('criterion 4: a tab that drops and reconnects inside the grace window raises no banner', async () => {
    process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '600';
    try {
      const { boardId } = await postRound(port, askBoard('reconnecting'));
      const tab = await arriveAt(port, boardId); // arrives inside the post's own grace
      await tick(50);
      tab.req.destroy();
      await tick(50);
      // EventSource reconnects natively, and the page reports from its `watcher` handler
      // the moment it has an id -- which is what makes this silent. A socket that never
      // reports is not a reviewer and is not treated as one.
      const back = await arriveAt(port, boardId);
      try {
        await tick(800);
        assert.equal(spawnsFor('reconnecting').length, 0, 'a reconnect inside the window is not an absence');
        assert.equal(announcedAt(boardId), null);
      } finally {
        back.req.destroy();
      }
    } finally {
      process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '60';
    }
  });

  await check('criterion 9: a stranded round on one board raises nothing for any other board', async () => {
    // `mine` posts a genuinely new second round below (not an amend to the round already
    // carrying the mark) -- `waitingArtifactBoard` is what buys that, exactly as the
    // restart checks above use it, so this stays a check about cross-board isolation
    // rather than also exercising the amend-rings-again behaviour.
    const mine = await postRound(port, waitingArtifactBoard('board-alone'));
    const theirs = await postRound(port, askBoard('board-watched'));
    await waitForRows('board-alone', 1);
    await waitForRows('board-watched', 1);
    const watched = await arriveAt(port, theirs.boardId); // the reviewer sits on the OTHER board
    try {
      await tick(30);
      assert.equal(bannerOn(theirs.boardId).returned, true, 'the board being looked at has had its return');
      assert.equal(bannerOn(mine.boardId).returned, false, 'a reviewer attending a different board is not attending this one');
      await postRound(port, { boardId: mine.boardId, blocks: [QUESTION('still nobody?')] });
      await tick(250);
      assert.equal(spawnsFor('board-alone').length, 1, 'nothing crosses between boards, in either direction');
      assert.equal(spawnsFor('board-watched').length, 1);
    } finally {
      watched.req.destroy();
    }
  });

  await check('a report naming a Watcher this board does not have never reaches the rule', async () => {
    // `setAttended` already knows the id names nothing; discarding that and evaluating
    // anyway let any caller holding a credential drive the stranded rule with a made-up
    // id -- reaching a durable write, and steering the click target with its own socket --
    // on a route whose answer is otherwise a silent no-op.
    const { boardId } = await postRound(port, askBoard('forged-watcher'));
    await waitForRows('forged-watcher', 1);
    const before = bannerOn(boardId);
    assert.ok(before, 'the board really is in an announced absence');

    const r = await reportAttended(port, boardId, 'not-a-watcher-this-board-has', true);
    assert.equal(r.status, 200, 'still answered 200 -- a real tab cannot know it lost that race');
    await tick(100);
    assert.deepEqual(bannerOn(boardId), before,
      'and the absence is untouched: nobody has come back, whatever the report claimed');
  });

  await check('criterion 7: restarting the daemon does not re-announce a board it has already announced', async () => {
    // A genuinely NEW round, not an amend: `waitingArtifactBoard`'s own comment is why --
    // its first round asks nothing, so the follow-up below mints round 2 rather than
    // amending round 1. An amend to the round already carrying the mark now rings again
    // on purpose (the ticket this file's own AC checks cover); this check is about
    // something else, a further round earning nothing without a genuine return, and has
    // to stay clear of the amend path to keep testing that.
    const { boardId } = await postRound(port, waitingArtifactBoard('restarted'));
    await waitForRows('restarted', 1);
    assert.ok(announcedAt(boardId));

    const restarted = await startServer({ home, port: 0 }); // a second daemon over the same store
    try {
      // Whatever a restarted daemon does about this board, it must not be a banner: post
      // another round into it, with nobody Attending it.
      await postRound(restarted.port, { boardId, blocks: [QUESTION('after the restart?')] });
      await tick(250);
      assert.equal(spawnsFor('restarted').length, 1,
        'the reviewer has already been told about this board and has not been back');
    } finally {
      stopServer(restarted.server);
    }
  });

  await check('criterion 7: an install.sh-shaped stop and start does not re-announce either', async () => {
    // The routine restart, driven end to end: the daemon that raised the banner is STOPPED
    // -- which SIGTERMs the click-serving child and so takes the banner off the screen --
    // and a successor comes up over the same store. Every other restart case here stands a
    // second daemon up beside the first, which only ever exercises the unclean path.
    process.env.STUB_OSASCRIPT_LINGER_MS = '5000';
    const own = await startServer({ home, port: 0 });
    let successor = null;
    try {
      // A genuinely new round below, not an amend -- see the restart check just above for
      // why `waitingArtifactBoard` rather than `askBoard` is what keeps this check about
      // restart durability rather than about the amend-rings-again behaviour.
      const { boardId } = await postRound(own.port, waitingArtifactBoard('stop-and-start'));
      await waitForRows('stop-and-start', 1);
      const rec = bannerOn(boardId);
      assert.ok(rec);

      stopServer(own.server); // install.sh takes an update
      const rows = await waitForRows('stop-and-start', 2);
      assert.deepEqual(rows[1], ['SIGTERM', '-e', BANNER('stop-and-start')],
        'criterion 15: the click-serving process goes with the daemon');
      assert.deepEqual(bannerOn(boardId), { ...rec, pid: null },
        'the record stays -- this absence has been announced -- with only the pid of the process just killed cleared');

      successor = await startServer({ home, port: 0 });
      await postRound(successor.port, { boardId, blocks: [QUESTION('after the update?')] });
      await tick(250);
      assert.equal(spawnsFor('stop-and-start').length, 1,
        'criterion 7: nothing more until the reviewer comes back, whether or not the banner is still on screen');
    } finally {
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
      if (successor) stopServer(successor.server);
      stopServer(own.server);
    }
  });

  await check('criterion 7: a hidden tab reconnecting under an announced board raises no second banner', async () => {
    // The case the restart check above cannot reach: it restarts with NO tab connected,
    // so nothing calls the subscribe hook and the marker survives by never being looked
    // at. Here a tab IS connected and buried, which is criterion 3's own state, and the
    // reconnect goes straight through the hook.
    const { boardId } = await postRound(port, askBoard('hidden-reconnect'));
    await waitForRows('hidden-reconnect', 1);
    const announced = announcedAt(boardId);
    assert.ok(announced, 'the absence has been announced');

    const buried = await openStream(port, boardId);
    await reportAttended(port, boardId, buried.watcher, false);
    await tick(200);
    assert.equal(spawnsFor('hidden-reconnect').length, 1, 'a tab that opens buried is not the reviewer arriving');
    assert.equal(announcedAt(boardId), announced, 'so the absence is still the same absence, stamp and all');

    // The socket drops and the tab reconnects -- EventSource does this natively, and a
    // laptop wake or a daemon restart under this same buried tab looks identical from
    // here. The fresh Watcher has reported nothing yet.
    buried.req.destroy();
    await tick(30);
    const back = await openStream(port, boardId);
    try {
      await tick(30);
      assert.equal(announcedAt(boardId), announced,
        'a Watcher that has said nothing yet must not end an absence nobody has returned from');
      // ... and a round trip later the page says what it always was: still hidden.
      await reportAttended(port, boardId, back.watcher, false);
      await tick(250);
      assert.equal(spawnsFor('hidden-reconnect').length, 1,
        'criterion 7: still exactly one banner -- the reviewer has not come back, so nothing may re-announce');
    } finally {
      back.req.destroy();
    }
  });

  await check('criterion 6: returning to a board withdraws the banner already delivered', async () => {
    process.env.STUB_OSASCRIPT_LINGER_MS = '5000';
    try {
      const { boardId } = await postRound(port, askBoard('returned-to'));
      await waitForRows('returned-to', 1);
      const tab = await arriveAt(port, boardId); // the reviewer comes back, and says so
      try {
        const rows = await waitForRows('returned-to', 2);
        assert.deepEqual(rows[1], ['SIGTERM', '-e', BANNER('returned-to')],
          'the daemon kills the process serving the click, and SIGTERM is what withdraws the delivered banner');
        const rec = bannerOn(boardId);
        assert.equal(rec.returned, true, 'the gate opens, so a round never announced may still speak');
        assert.equal(rec.round, 1, 'but the mark stays: round 1 is announced for the rest of its life');
        assert.equal(rec.pid, null, 'and the pid goes with the banner just withdrawn');
      } finally {
        tab.req.destroy();
      }
    } finally {
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
    }
  });

  await check('criterion 15: a round being answered terminates the process serving the click', async () => {
    process.env.STUB_OSASCRIPT_LINGER_MS = '5000';
    try {
      const { boardId, round } = await postRound(port, askBoard('answered'));
      await waitForRows('answered', 1);
      const r = await rawRequest(port, 'POST', `/api/board/${boardId}/submit`, {
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
        body: JSON.stringify({ round, action: 'send', answers: [], comments: [] }),
      });
      assert.equal(r.status, 200, `submit failed: ${r.body}`);
      const rows = await waitForRows('answered', 2);
      assert.deepEqual(rows[1], ['SIGTERM', '-e', BANNER('answered')],
        'nothing is left for the click to open, so the daemon that owns it kills it');
    } finally {
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
    }
  });

  await check('criterion 15: stopping the daemon leaves none of the click-serving processes running', async () => {
    process.env.STUB_OSASCRIPT_LINGER_MS = '5000';
    const own = await startServer({ home, port: 0 });
    try {
      await postRound(own.port, askBoard('daemon-stopped'));
      await waitForRows('daemon-stopped', 1);
      stopServer(own.server);
      const rows = await waitForRows('daemon-stopped', 2);
      assert.deepEqual(rows[1], ['SIGTERM', '-e', BANNER('daemon-stopped')],
        'the daemon owns it, so the daemon takes it with it');
    } finally {
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
      stopServer(own.server);
    }
  });

  await check('ADR 69 end to end: abandoning a thread takes its banner off the screen', async () => {
    // The whole path, through the real route the shim calls: agent posts a question,
    // nobody looks, the banner fires, the reviewer runs `/clear`, the shim calls
    // `ask(fresh: true)` and `POST /api/board/:id/abandon` closes every open round on the
    // old board. The banner must go with them -- otherwise it sits there for up to
    // `min(the round's deadline, CLICK_LIFETIME_MAX_MS)` and clicking it opens a board
    // where nothing is awaited.
    process.env.STUB_OSASCRIPT_LINGER_MS = '5000';
    try {
      const { boardId } = await postRound(port, askBoard('abandoned-thread'));
      await waitForRows('abandoned-thread', 1);
      const rec = bannerOn(boardId);
      assert.ok(rec, 'the board really is in an announced state');

      const r = await rawRequest(port, 'POST', `/api/board/${boardId}/abandon`, {
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      });
      assert.equal(r.status, 200, `abandon failed: ${r.body}`);
      assert.ok(JSON.parse(r.body).closed.length >= 1, 'a round really was closed');

      const rows = await waitForRows('abandoned-thread', 2);
      assert.deepEqual(rows[1], ['SIGTERM', '-e', BANNER('abandoned-thread')],
        'the process serving the click is killed, and SIGTERM is what withdraws the delivered banner');
      const after = bannerOn(boardId);
      assert.ok(after, 'the mark stays: abandoning is not returning (ADR 74)');
      assert.equal(after.returned, false, 'and so does the shut gate');
      assert.equal(after.pid, null, 'only the pid goes');
    } finally {
      process.env.STUB_OSASCRIPT_LINGER_MS = '0';
    }
  });

  await check('criterion 7: the look-away window survives a daemon restart, so an install.sh update raises nothing', async () => {
    // The scenario ticket 01 forces on every reviewer: they look at a board, switch to the
    // terminal, and run `./install.sh`. The daemon restarts, EventSource reconnects, and
    // the reconnect mints a FRESH Watcher with no memory of that tab ever having had
    // focus. Read from the daemon's side alone the window is spent, the bare grace is
    // armed, and a banner fires for a round the reviewer was looking at seconds ago --
    // exactly the defect ADR 73 exists to remove, reintroduced by the restart.
    //
    // What closes it is `sinceFocusMs` on the report: the PAGE knows when it last had
    // focus and says so, and a fresh Watcher seeds its stamp from that. Never from the
    // fact of connecting, which is the reading entry 73 refuses -- the check below this
    // one is what pins that half.
    await withWindow(4000, async () => {
      // Its own daemon, so the restart can be a REAL stop and start rather than a second
      // daemon beside the first -- the same shape the install.sh check above uses, and the
      // only one where the original daemon's pending countdown genuinely dies.
      const own = await startServer({ home, port: 0 });
      let successor = null;
      try {
        // Round 1 is an awaited page round, so round 2 is a real round rather than an
        // amendment (see `waitingArtifactBoard`). Round 1 is announced and spent.
        const { boardId } = await postRound(own.port, waitingArtifactBoard('survives-restart'));
        await waitForRows('survives-restart', 1);
        const tab = await arriveAt(own.port, boardId); // the reviewer looks at it
        await tick(30);
        assert.equal(bannerOn(boardId).returned, true, 'a genuine return');

        // A round they have never been told about, posted while they are looking ...
        await postRound(own.port, { boardId, blocks: [QUESTION('and this one?')] });
        await tick(30);
        assert.equal(spawnsFor('survives-restart').length, 1, 'silent while they are looking');
        // ... and then they switch to the terminal, with the tab still open.
        await reportAttended(own.port, boardId, tab.watcher, false);

        // ./install.sh. The DAEMON goes first and the socket dies with it -- that order is
        // the scenario, and the reverse is a different one: a tab closing while the daemon
        // is still up is the last Watcher leaving, which strands on the bare grace by
        // design (the window belongs to an open tab). A successor comes up over the same
        // store and the tab's EventSource reconnects into it, minting a Watcher that has
        // never seen this tab have focus.
        stopServer(own.server);
        tab.req.destroy();
        // No banner may be raised on the way out, either: a stopping daemon destroys its
        // open SSE connections, and each close handler re-evaluates on its way out.
        await tick(150);
        assert.equal(spawnsFor('survives-restart').length, 1,
          'a daemon that has been stopped announces nothing, however its connections unwind');
        successor = await startServer({ home, port: 0 });
        const back = await openStream(successor.port, boardId);
        try {
          // What the page really sends: still buried, and last had focus a moment ago.
          await rawRequest(successor.port, 'POST', `/api/board/${boardId}/attended`, {
            headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
            body: JSON.stringify({ watcher: back.watcher, attended: false, seq: 9, sinceFocusMs: 40 }),
          });
          await tick(400); // six graces, and still well inside the four-second window
          assert.equal(spawnsFor('survives-restart').length, 1,
            'the restart must not cost the reviewer their look-away window: round 2 has never been announced and the gate is open, so only the window is holding it back');
        } finally {
          back.req.destroy();
        }
      } finally {
        if (successor) stopServer(successor.server);
        stopServer(own.server);
      }
    });
  });

  await check('criterion 7: a reconnecting tab that has never had focus gets no window from connecting', async () => {
    // The refused reading, pinned so it cannot creep back in through the seam the check
    // above opened. A tab that has never been looked at reports no `sinceFocusMs` at all,
    // and a Watcher with nothing to count from must not be treated as recently focused --
    // otherwise reconnecting shortly before each grace would be a mute button obtainable
    // with a read credential and one write.
    await withWindow(4000, async () => {
      const { boardId } = await postRound(port, waitingArtifactBoard('never-focused'));
      await waitForRows('never-focused', 1);
      const tab = await arriveAt(port, boardId);
      await tick(30);
      assert.equal(bannerOn(boardId).returned, true, 'a genuine return, so a later round may speak');
      await postRound(port, { boardId, blocks: [QUESTION('never announced?')] });
      tab.req.destroy();
      await tick(50);

      // A tab opened in the background and never looked at: it connects and reports
      // hidden, with no focus of its own to report.
      const buried = await openStream(port, boardId);
      try {
        await reportAttended(port, boardId, buried.watcher, false);
        await waitForRows('never-focused', 2);
        assert.equal(spawnsFor('never-focused').length, 2,
          'connected is not recently focused: the round still strands on the plain grace');
      } finally {
        buried.req.destroy();
      }
    });
  });

  await check('the connected-tab count stays on the round-posting response', async () => {
    const posted = await postRound(port, askBoard('still-reports-clients'));
    assert.equal(posted.clients, 0, '`clients` is published protocol and is not a casualty of this rule');
  });

  // --- a fresh board defers to an open tab (ADR.md entries 91 and 92) -----------------
  //
  // Suppression is the daemon's decision, because "any board, any project" is a fact only
  // this process can see, and it turns on a real Watcher -- a real event stream, which is
  // what an open board tab holds. The tab these open is on ANOTHER board every time, which
  // is the whole claim: it is not this board being watched that suppresses it.
  //
  // Last in this layer on purpose. A Watcher standing on some other board changes what
  // every board posted after it records, so these leave the daemon exactly as they found
  // it and nothing after them has to know that.

  await check('ADR 91: a board posted while ANOTHER board has a Watcher is Suppressed, and still raises its one banner', async () => {
    const { boardId: watched } = await postRound(port, askBoard('watched-elsewhere'));
    const tab = await openStream(port, watched);
    try {
      const posted = await postRound(port, askBoard('suppressed-awaited'));
      assert.equal(posted.suppressed, true,
        'any board, any project: a tab on some other board is what suppresses this one\'s auto-open');
      assert.equal(posted.awaited, true, 'and this one really is awaited, so it is the ordinary banner being checked');
      const rows = await waitForRows('suppressed-awaited', 1);
      assert.deepEqual(rows, [['spawn', '-e', BANNER('suppressed-awaited')]],
        'nothing opened a tab for this board, so the Banner is the whole announcement');
      await tick(200);
      assert.equal(spawnsFor('suppressed-awaited').length, 1, 'and exactly one, after the grace has come round again');
    } finally {
      tab.req.destroy();
    }
  });

  await check('ADR 92: a Suppressed page board posted without wait raises one banner too, once, with nothing awaited', async () => {
    const { boardId: watched } = await postRound(port, askBoard('watched-elsewhere-again'));
    const tab = await openStream(port, watched);
    try {
      // One `html` block and nothing else is a PAGE board (QUIRKS.md), and with no `wait`
      // nothing on it is Awaited -- the exact shape that used to land in total silence:
      // no tab, because a Watcher exists elsewhere, and no banner, because the rule only
      // knew how to announce a round somebody was blocked on.
      const posted = await postRound(port, {
        title: 'An artifact, nothing asked',
        blocks: [{ kind: 'html', html: '<p>an artifact, nothing asked</p>' }],
        cwd: projectFor('suppressed-page'),
      });
      assert.equal(posted.suppressed, true);
      assert.equal(posted.awaited, false, 'no question block and no wait: there is nothing here for anyone to answer');
      const rows = await waitForRows('suppressed-page', 1);
      assert.deepEqual(rows, [['spawn', '-e', BANNER('suppressed-page')]],
        'the one thing that can tell the reviewer this board exists at all');
      await tick(250);
      assert.equal(spawnsFor('suppressed-page').length, 1, 'once, and only once');

      const rec = bannerOn(posted.boardId);
      assert.equal(rec.round, 1, 'the mark is round 1, which is what makes the second grace above silent');
      assert.equal(rec.until, new Date(Date.parse(rec.at) + CLICK_LIFETIME_MAX_MS).toISOString(),
        'no round deadline exists to bound the process serving the click, so the launcher\'s hard ceiling alone does');
    } finally {
      tab.req.destroy();
    }
  });

  await check('ADR 91: the Banner a Suppressed board is owed fires despite the round-banner switch', async () => {
    // Suppression TRADES the tab for a Banner, so the switch that silences ordinary
    // stranded rounds does not silence this one: honouring it here too would mean a board
    // that opened no tab AND raised no notification, which nothing at all tells the
    // reviewer about. The tab side of this is test/check-mcp.mjs's (it needs a real shim
    // and a real opener); this is the daemon's half of the same decision.
    const settingsPath = path.join(home, 'pomodoro.json');
    writeFileSync(settingsPath, JSON.stringify({ settings: { notifyRounds: false } }));
    const { boardId: watched } = await postRound(port, askBoard('watched-still-banners'));
    const tab = await openStream(port, watched);
    try {
      const posted = await postRound(port, {
        title: 'An artifact, nothing asked',
        blocks: [{ kind: 'html', html: '<p>an artifact, nothing asked</p>' }],
        cwd: projectFor('banner-outranks-switch'),
      });
      assert.equal(posted.suppressed, true,
        'a Watcher is standing right there, and the switch does not enter into the decision');
      let spawns = [];
      for (let i = 0; i < 40 && spawns.length === 0; i++) { await tick(100); spawns = spawnsFor('banner-outranks-switch'); }
      assert.equal(spawns.length, 1, 'the one Banner suppression owes fires despite the switch');
      await tick(300);
      assert.equal(spawnsFor('banner-outranks-switch').length, 1, 'and only once');
    } finally {
      tab.req.destroy();
      rmSync(settingsPath, { force: true });
    }
  });
}

await layerOne();
await layerTwo()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error((err && err.stack) || err);
  })
  .finally(async () => {
    if (server) stopServer(server);
    await tick(50);
    rmSync(workDir, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall stranded checks ok');
  });
