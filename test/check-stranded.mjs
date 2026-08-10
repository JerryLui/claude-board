// The stranded rule end to end (SPEC_STRANDED.md ticket 05; ADR.md entries 55 and 58):
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
//    PATH, opening and dropping real event streams against it, exactly as the spec's
//    Testing section describes. Whether the reviewer is looking is a report the tab
//    sends, so these drive `POST /api/board/:id/attended` directly rather than needing a
//    browser.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE. `osascript` is a stub on PATH here
// from the first line of this file, and the grace is a few milliseconds throughout rather
// than the shipped fifteen seconds -- which is also why test/run.mjs pushes the grace out
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
import { createBoard, addRound } from '../src/board.mjs';
import { readBoard, writeBoard } from '../src/store.mjs';
import { STRANDED_BANNER } from '../src/board.mjs';
import { roundIsAwaitedOpen } from '../src/badge.mjs';
import { CLICK_LIFETIME_MAX_MS, notifyRound, withdrawClickChild, parseElapsedTime, mayWithdrawPid } from '../src/notify.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { startServer, createStrandedWatch, strandedTarget, DEFAULT_STRANDED_GRACE_MS } from '../src/server.mjs';

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

/** A real board document on disk: awaited (a question round) unless told otherwise. */
function seedBoard({ wait = true, cwd = projectDir, awaitTimeoutMs = AWAIT_MS } = {}) {
  const board = createBoard({
    title: 'Stranded',
    blocks: wait ? [QUESTION('Ship?')] : [{ kind: 'markdown', text: 'an artifact, nothing asked' }],
    cwd,
    awaitTimeoutMs,
  });
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
function stand() {
  const withdrawn = [];
  const looking = new Map();
  // When the `null` (unknown) Watcher on a board subscribed. Defaults to "just now", so
  // an ordinary `looking.set(id, null)` models a tab that has only this moment
  // reconnected; a check that wants an old one sets this back by hand.
  const since = new Map();
  const banners = [];
  const watch = createStrandedWatch({
    home,
    sse: {
      isAttended: (id, unknownAfterMs = Infinity) => {
        if (!looking.has(id)) return false;
        const state = looking.get(id);
        if (state !== null) return state;
        return Date.now() - (since.get(id) ?? Date.now()) < unknownAfterMs;
      },
      isConfirmedAttended: id => looking.get(id) === true,
    },
    notify: (folder, opts) => {
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
    },
    // The pid path: only reached when this daemon has no handle of its own, i.e. after an
    // unclean restart. Recorded rather than performed, because the real one sends SIGTERM.
    withdraw: (pid, startedAtMs) => withdrawn.push({ pid, startedAtMs }),
  });
  return { looking, since, banners, withdrawn, watch };
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

  await check('criterion 6: returning kills the click-serving process with SIGTERM and clears the marker', async () => {
    const { looking, banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    looking.set(board.id, true); // a tab reports that it is visible and focused
    watch.evaluate(board.id, target(board.id));
    assert.deepEqual(banners[0].child.killed, ['SIGTERM'],
      'SIGTERM specifically: it is the path that withdraws the delivered banner from Notification Center');
    assert.equal(announcedAt(board.id), null, 'coming back ends the absence');

    // ... and leaving again may raise a fresh one.
    looking.delete(board.id);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2, 'criterion 6: leaving again may raise a fresh banner');
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

  await check('the absence ends with the round the record NAMES, not with the last round on the board', async () => {
    // The predicate must be the named round and nothing wider. "Is ANYTHING still
    // awaited" leaves round 2 with no banner of its own for the rest of its wait, in the
    // shape handlePostBoard calls ordinary: an awaited page round beside a question round.
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
    assert.equal(banners.length, 2, 'the announced round is over, so round 2 gets an absence of its own');
    assert.equal(bannerOn(board.id).round, 2, 'and the new record names it');
    assert.deepEqual(banners[0].child.killed, ['SIGTERM'],
      'the first banner is withdrawn on the way, so the reviewer never has two standing at once');
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

  await check('a wait that dies unanswered ends its absence: a later round may raise a fresh banner', async () => {
    // The reviewer swipes the banner away and never comes back. Round 1's wait dies on
    // its own, and the process serving that banner's click dies with it -- `until` is
    // that same instant. Without the record expiring there, every later round on this
    // board is silent for the life of the store.
    const { banners, watch } = stand();
    const board = seedBoard({ awaitTimeoutMs: 150 }); // a wait that dies almost at once
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);
    assert.equal(bannerOn(board.id).round, 1);

    await tick(200); // round 1's wait dies, and the banner raised for it goes with it
    addAwaitedRound(board.id, 'and now?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2,
      'the absence that record stood for is over, so this is a new one -- and the reviewer has nothing on screen either way');
    assert.equal(bannerOn(board.id).round, 2, 'and the new record describes the new round');
    watch.close();
  });

  await check('... and so does everything on the board being answered', async () => {
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 1);

    // Answered by a script carrying the local secret: no browser, so no attended Watcher
    // and no return to resolve it into one. With nothing awaited there is no absence left.
    const answered = readBoard(board.id, home);
    answered.rounds[0].status = 'sent';
    writeBoard(answered, home);
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(bannerOn(board.id), null, 'the record is retired rather than left to suppress the next absence');
    assert.deepEqual(banners[0].child.killed, ['SIGTERM'], 'and the banner is withdrawn: nothing is left for its click to open');

    addAwaitedRound(board.id, 'a new round, a new absence?');
    watch.evaluate(board.id, target(board.id));
    await tick();
    assert.equal(banners.length, 2);
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

  await check('a clear that could not be written withdraws nothing either: the record and the screen agree', async () => {
    // Withdrawing first and then restoring the record on a write that failed left the
    // banner GONE and the board still believing it had one, which suppressed every
    // replacement for the rest of the wait -- the reviewer silently loses the signal on a
    // machine that is already in trouble. So the write goes first and the withdrawal only
    // follows a write that landed.
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
      looking.set(board.id, true);   // the reviewer comes back, but the clear cannot land
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.deepEqual(banners[0].child.killed, [], 'nothing is withdrawn, because nothing could be recorded');
      assert.ok(bannerOn(board.id), 'and the record still stands, which is what the screen shows');

      // The store comes back. Now returning does both.
      chmodSync(boardsDir, mode);
      watch.evaluate(board.id, target(board.id));
      await tick();
      assert.deepEqual(banners[0].child.killed, ['SIGTERM'], 'the withdrawal it owed');
      assert.equal(bannerOn(board.id), null, 'and the record it owed');
    } finally {
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
    assert.equal(bannerOn(board.id), null, 'and the absence ends');
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
    assert.equal(bannerOn(board2.id), null, 'the record is still retired; only the signal is withheld');
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
    // fine (QUIRKS.md, "`lsregister` records are permanent"). Only the LENGTH matters
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
    const sleeper = spawn(longExec, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    // A spawn that fails (noexec TMPDIR, a dangling link) emits 'error' asynchronously,
    // and an unhandled one on a ChildProcess throws out of the event loop rather than into
    // the try below -- taking the whole file down instead of failing this one check.
    sleeper.on('error', () => {});
    try {
      await new Promise(r => setTimeout(r, 300));
      const both = await execFileAsync('ps', ['-o', 'etime=,comm=', '-p', String(sleeper.pid)]);
      const line = both.stdout.trim();
      const cut = line.indexOf(' ');
      assert.equal(line.slice(cut + 1).trim(), longExec,
        'etime first, comm last: the full executable path must survive, or the pid gate never fires');
      assert.ok(parseElapsedTime(line.slice(0, cut)) !== null,
        'and the first column must still be an etime the parser accepts');

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

  await check('the grace is fifteen seconds by default, and every unusable value falls back to it', async () => {
    assert.equal(DEFAULT_STRANDED_GRACE_MS, 15_000, 'the default the spec fixes: one SSE heartbeat');
    // '' is the one that matters: `Number('')` is 0, and blanking a plist entry is how an
    // operator turns a knob off -- which under a `>= 0` test became a zero grace, i.e. the
    // false positive on a reconnecting tab that this whole rule exists to avoid.
    for (const bad of ['', '   ', '0', '-1', 'soon', 'NaN', '15s']) {
      process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = bad;
      const { banners, watch } = stand();
      const board = seedBoard();
      watch.evaluate(board.id, target(board.id));
      await tick(60);
      assert.equal(banners.length, 0, `CLAUDE_BOARD_STRANDED_GRACE_MS=${JSON.stringify(bad)} must fall back to the shipped fifteen seconds, not fire at once`);
      watch.close();
    }
    delete process.env.CLAUDE_BOARD_STRANDED_GRACE_MS;
    const { banners, watch } = stand();
    const board = seedBoard();
    watch.evaluate(board.id, target(board.id));
    await tick(120);
    assert.equal(banners.length, 0, 'with the variable unset the shipped fifteen seconds applies, so nothing fires yet');
    watch.close();
    process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '1';
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

async function layerTwo() {
  process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = '60';
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
  });

  await check('criterion 1: and it opens no tab', () => {
    const opened = existsSync(process.env.STUB_OPEN_LOG) ? readFileSync(process.env.STUB_OPEN_LOG, 'utf8') : '';
    assert.equal(opened, '',
      'a stub `open` sits ahead of the real one on PATH: the daemon announces, it does not yank a tab in front of anyone');
  });

  await check('criterion 5: a round landing on a board somebody is looking at raises nothing', async () => {
    const { boardId } = await postRound(port, askBoard('watched'));
    // Posted before any stream existed, so that first absence is announced. Arriving
    // ends it; everything after this is the attended case.
    await waitForRows('watched', 1);
    const tab = await arriveAt(port, boardId);
    try {
      await tick(30);
      assert.equal(announcedAt(boardId), null, 'arriving cleared the earlier absence');
      for (const n of [2, 3, 4]) await postRound(port, { boardId, blocks: [QUESTION(`round ${n}?`)] });
      await tick(250);
      assert.equal(spawnsFor('watched').length, 1, 'however many rounds land, a board in front of the reviewer says nothing more');
      assert.equal(announcedAt(boardId), null);
    } finally {
      tab.req.destroy();
    }
  });

  await check('criterion 2: closing the last tab while a round is still awaited raises one banner', async () => {
    const { boardId } = await postRound(port, askBoard('closed-on'));
    await waitForRows('closed-on', 1);
    const tab = await arriveAt(port, boardId); // the reviewer arrives, ending that absence
    await tick(30);
    assert.equal(announcedAt(boardId), null);

    tab.req.destroy(); // ... and closes the tab with the round still open
    await waitForRows('closed-on', 2);
    assert.equal(spawnsFor('closed-on').length, 2, 'the disconnect hook is what makes this case exist at all');
    assert.ok(announcedAt(boardId));
  });

  await check('criterion 3: switching away from a board with an awaited round on it raises the same banner', async () => {
    const { boardId } = await postRound(port, askBoard('switched-away'));
    await waitForRows('switched-away', 1);
    const tab = await arriveAt(port, boardId);
    try {
      await tick(30);
      assert.equal(announcedAt(boardId), null);
      const r = await reportAttended(port, boardId, tab.watcher, false); // the tab is buried
      assert.equal(r.status, 200);
      await waitForRows('switched-away', 2);
      assert.deepEqual(spawnsFor('switched-away')[1], ['spawn', '-e', BANNER('switched-away')],
        'an open tab is not the same as a reviewer looking at it');
    } finally {
      tab.req.destroy();
    }
  });

  await check('criterion 3: a round landing on a board whose tab is open but hidden raises the same banner', async () => {
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

      await postRound(port, { boardId, blocks: [QUESTION('and another?')] });
      await tick(250);
      assert.equal(spawnsFor('hidden-tab').length, 1,
        'criterion 7: this absence has already been announced, so further rounds add nothing');
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
      assert.equal(announcedAt(boardId), null);
    } finally {
      one.req.destroy();
      two.req.destroy();
    }
  });

  await check('criterion 8: a round that is not awaited raises no banner', async () => {
    const { boardId } = await postRound(port, {
      title: 'An artifact', blocks: [{ kind: 'markdown', text: 'nothing is asked here' }], cwd: projectFor('not-awaited'),
    });
    await tick(250);
    assert.equal(spawnsFor('not-awaited').length, 0, 'nothing to answer means nothing to be stranded');
    assert.equal(announcedAt(boardId), null);
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
    const mine = await postRound(port, askBoard('board-alone'));
    const theirs = await postRound(port, askBoard('board-watched'));
    await waitForRows('board-alone', 1);
    await waitForRows('board-watched', 1);
    const watched = await arriveAt(port, theirs.boardId); // the reviewer sits on the OTHER board
    try {
      await tick(30);
      assert.equal(announcedAt(theirs.boardId), null, 'the board being looked at is out of its absence');
      assert.ok(announcedAt(mine.boardId), 'a reviewer attending a different board is not attending this one');
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
    const { boardId } = await postRound(port, askBoard('restarted'));
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
      const { boardId } = await postRound(own.port, askBoard('stop-and-start'));
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
        assert.equal(announcedAt(boardId), null, 'and the absence is over, so leaving again may raise a fresh one');
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

  await check('the connected-tab count stays on the round-posting response', async () => {
    const posted = await postRound(port, askBoard('still-reports-clients'));
    assert.equal(posted.clients, 0, '`clients` is published protocol and is not a casualty of this rule');
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
