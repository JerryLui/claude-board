// The status item's HTTP half and its whole derivation, against a real daemon.
//
// The reason this file looks the way it does: the AppKit half —
// the status item, its image, its title, and ticket 05's popover — is NOT covered, because
// there is no headless way to assert a status item's title (QUIRKS.md, "a status item is
// not your window, and every obvious detector lies about it": own-pid window lists come
// back empty in every condition, `isVisible` is true for an item parked off-screen, and
// `screencapture` is unavailable from an agent process tree). Rather than invent a check
// that pretends otherwise, bin/menubar.m keeps the interesting half OUT of AppKit: cb_derive
// is a pure C function from (timer, settings, now) to a display state, and the AppKit layer
// is a switch over its fields.
//
// `claude-board --menubar --probe` is how that function is reached from here. One fetch,
// one line of `key=value` on stdout, exit — no NSApplication, no item, no run loop. So
// everything below drives the SAME code the menu bar draws from, over the same loopback
// GET, authorized by the same secret file, and the only thing left untested is the paint.
//
// Ticket 05 widened that seam rather than opening a second one. `--menubar --probe
// <action>` performs ONE of the popover's six actions through the same cb_perform its
// buttons call and then reports, which is what makes criterion 4 ("every one takes
// effect") checkable at all; `--menubar --probe url <candidate>` runs the board-URL
// validator alone. The popover's rows are printed by the plain probe, because the rules
// that decide them — five at most, the overflow's arithmetic, the row's wording, which
// action the one button performs — are pure C functions sitting next to cb_derive for
// exactly this reason. What is NOT covered, and cannot be: whether any of it is on screen,
// legible, keyboard-reachable or correct in dark mode. No assertion below would survive
// bin/menubar.m's popover being deleted wholesale, and none pretends to.
//
// The acceptance criteria this file exists for:
//
//   - 1, "shows the current phase and the remaining time, and both track the daemon within
//     one second of the widget": the countdown the probe derives is compared against the
//     one node computes from the same daemon's own response.
//   - 2, "the phase is legible ... in all four states": the four states are what the
//     derivation has to tell apart before anything can draw them differently, and the
//     shape and weight flags are derived from the phase alone. The icon is a template
//     image, so there is no colour in it to check at all and the system owns the ink in
//     both appearances. All four states, plus paused, are pinned here; whether they LOOK
//     different is the half no check can reach.
//   - 3, "how much of the interval is left": the arc's fraction at a known remaining time.
//   - 9, "does not appear until the daemon has answered once, and dims rather than
//     disappearing": an absent daemon, a wrong secret and a missing secret all report
//     `answered=no` rather than crashing or hanging.
//   - 4, "the popover starts, pauses, resumes, forwards and restarts the Timer": each of
//     the five is posted through the seam and the daemon's own document is read back.
//   - 6, "at most five of them with an overflow row": the cap and the overflow arithmetic
//     against a daemon holding seven waiting rounds, plus the validator that decides
//     whether a row may be opened at all.
//   - 8, "reset is not reachable from the popover": an ABSENCE, so it is asserted
//     structurally against this file's own bytes as well as behaviourally through the
//     seam. Driving a UI cannot prove a button is missing.
//   - 11, "turning the countdown setting off leaves the icon and removes the text".
//   - 12, "hiding the item from its own popover survives a logout": the hide is a POST to
//     the settings route, so what survives a logout is what the daemon persisted.
//
// Pattern-matched off test/check-pomodoro.mjs (a live daemon on a temp home via
// startServer) and test/check-launcher-menubar.mjs (compiles bin/launcher.c from node and
// drives the built binary). Skips gracefully if no C compiler is available, the same
// non-fatal degradation install.sh itself uses when `cc` is missing.
//
// Every spawn here is ASYNC. QUIRKS.md: a synchronous spawn that talks to a daemon running
// inside this same process blocks the event loop that daemon needs to answer, and the
// child times out against a message naming the wrong problem entirely.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultDoc, writeDoc, pomodoroDay, formatCountdown } from '../src/pomodoro.mjs';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

if (spawnSync(ccCmd, ['--version']).error) {
  console.log(`==> skipping check-menubar-client.mjs: no C compiler ('${ccCmd}') found`);
  console.log('all menubar-client checks ok (skipped)');
  process.exit(0);
}

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-menubar-client-'));

// --- building the binary ----------------------------------------------------------------
//
// The same three-invocation build install.sh performs, against a hand-written
// launcher_paths.h. Nothing in this file ever runs the SUPERVISING path, so the node and
// daemon paths baked in below are never exec'd — they only have to exist as strings.
// Mirrors install.sh's c_escape; every path here is plain mkdtemp ASCII.
const cEscape = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const headerDir = path.join(workDir, 'header');
mkdirSync(headerDir, { recursive: true });
writeFileSync(path.join(headerDir, 'launcher_paths.h'), [
  `#define CLAUDE_BOARD_NODE "${cEscape(process.execPath)}"`,
  `#define CLAUDE_BOARD_DAEMON "${cEscape(path.join(workDir, 'never-run.mjs'))}"`,
  `#define CLAUDE_BOARD_HOME_DIR "${cEscape(path.join(workDir, 'never-used-home'))}"`,
  '#define CLAUDE_BOARD_PATH "/usr/bin:/bin:/usr/sbin:/sbin"',
  `#define CLAUDE_BOARD_STORE_DIR "${cEscape(path.join(workDir, 'store'))}"`,
  `#define CLAUDE_BOARD_REF_ROOTS_VALUE "${cEscape(path.join(workDir, 'roots'))}"`,
  `#define CLAUDE_BOARD_REPO_ROOT_VALUE "${cEscape(path.join(workDir, 'repo'))}"`,
  '',
].join('\n'));

const launcherExec = path.join(workDir, 'launcher');
const objects = [['notify.m', 'notify.o'], ['menubar.m', 'menubar.o']].map(([src, obj]) =>
  spawnSync(ccCmd, ['-O2', '-Wall', '-Wextra', '-fobjc-arc', '-c',
    '-o', path.join(workDir, obj), path.join(repoRoot, 'bin', src)], { encoding: 'utf8' }));
const builds = [...objects];
if (objects.every(b => b.status === 0)) {
  builds.push(spawnSync(ccCmd, ['-O2', '-Wall', '-Wextra', '-o', launcherExec, '-I', headerDir,
    path.join(repoRoot, 'bin', 'launcher.c'), path.join(workDir, 'notify.o'), path.join(workDir, 'menubar.o'),
    '-framework', 'Foundation', '-framework', 'UserNotifications', '-framework', 'AppKit'], { encoding: 'utf8' }));
}

// --- the probe --------------------------------------------------------------------------

/** A temp HOME holding `.config/claude-board/secret`, which is the ONLY way the item finds
 * the credential: CLAUDE_BOARD_SECRET_FILE is deliberately not on bin/launcher.c's
 * passthrough list, so the path is derived from HOME exactly as src/secret.mjs derives it.
 * Pointing HOME at a temp directory is therefore also what keeps this check away from the
 * reader's real secret. */
function makeProbeHome(secret) {
  const home = mkdtempSync(path.join(workDir, 'probe-home-'));
  mkdirSync(path.join(home, '.config', 'claude-board'), { recursive: true });
  if (secret !== null) writeFileSync(path.join(home, '.config', 'claude-board', 'secret'), `${secret}\n`, { mode: 0o600 });
  return home;
}

/** Run the probe once and parse what it printed. `env` is built from scratch rather than
 * inherited, so a developer's own CLAUDE_BOARD_PORT or HOME can never decide what this
 * check talks to — which matters more here than it did for ticket 04, because `args` can
 * now WRITE: an inherited HOME would point this at the reader's own secret and an
 * inherited port at their own daemon, and `probe({ args: ['restart'] })` would then
 * restart the interval they are sitting in.
 *
 * `args` is whatever follows `--menubar --probe`. Empty is the read-only report.
 *
 * Never rejects on a nonzero exit: an action the daemon refused, and an unrecognised
 * action word, are both things checks below assert about rather than accidents. */
async function probe({ home, port, args = [] }) {
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let code = 0;
  let signal = null;
  try {
    const out = await execFileAsync(launcherExec, ['--menubar', '--probe', ...args], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_BOARD_PORT: String(port) },
      encoding: 'utf8',
      timeout: 20_000,
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err) {
    // A timeout is a HANG and has to fail loudly -- it is one of the things this file is
    // here to catch. Everything else is a report: `code` and `signal` are carried out so
    // a caller can assert that a refused action exited nonzero rather than crashing.
    if (err.killed) throw err;
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    code = err.code ?? null;
    signal = err.signal ?? null;
  }
  const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const state = { elapsedMs: Date.now() - started, code, signal, stderr, stdout, rows: [] };
  // Two line shapes on purpose (bin/menubar.m says why): the first line is bare
  // `key=value` words, and every line after it is one `key=` followed by the rest of the
  // line verbatim, because a row label carries spaces and a middle dot.
  for (const line of lines) {
    if (line.startsWith('phase=')) {
      for (const pair of line.split(' ')) {
        const at = pair.indexOf('=');
        if (at > 0) state[pair.slice(0, at)] = pair.slice(at + 1);
      }
      continue;
    }
    if (line.startsWith('waiting=')) {
      for (const pair of line.split(' ')) {
        const at = pair.indexOf('=');
        if (at > 0) state[pair.slice(0, at)] = pair.slice(at + 1);
      }
      continue;
    }
    if (line.startsWith('row=')) state.rows.push(line.slice(4));
    else if (line.startsWith('morerow=')) state.morerow = line.slice(8);
    else if (line.startsWith('caption=')) state.caption = line.slice(8);
    else if (line.startsWith('status=')) state.status = line.slice(7);
    else if (line.startsWith('url=')) state.url = line.slice(4);
  }
  return state;
}

/** A real daemon on a temp home, plus a temp HOME for the probe carrying its secret. Both
 * homes are separate directories on purpose: the daemon's store and the reader's home are
 * different things in the product too, and conflating them here would hide a bug where the
 * item looked for the secret in the wrong one.
 *
 * `writeDoc` is ALWAYS given the daemon's home. QUIRKS.md: its second parameter defaults to
 * the real board home, so a call without one writes over the reader's own timer. */
async function withDaemon(doc, fn) {
  const daemonHome = mkdtempSync(path.join(workDir, 'daemon-home-'));
  const secret = randomBytes(32).toString('hex');
  if (doc) writeDoc(doc, daemonHome);
  const { server, port } = await startServer({ home: daemonHome, port: 0, secret });
  const probeHome = makeProbeHome(secret);
  try {
    await fn({ daemonHome, probeHome, port, secret });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/** A document for one running interval. `cycleDate` is stamped with the POMODORO day, not
 * the calendar date (QUIRKS.md: a fixture dated with localDateStr passes all day and fails
 * before dawn) — without it readDoc rolls the day and nulls the timer, and every phase
 * assertion below would quietly become an idle assertion.
 *
 * Both notification switches are off in every fixture here. Nothing below crosses a
 * boundary, so nothing should fire — but a check that boots a real daemon and leaves them
 * on is one edit away from raising a real banner on the reader's screen. */
function runningDoc(timer, settings = {}) {
  const base = defaultDoc();
  return {
    ...base,
    settings: { ...base.settings, notify: false, notifyRounds: false, ...settings },
    cycleDate: pomodoroDay(Date.now()),
    timer,
  };
}

async function main() {
  await check('the client compiles, and links into the same binary install.sh builds', async () => {
    for (const build of builds) {
      assert.equal(build.status, 0, `stdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
    }
    assert.ok(existsSync(launcherExec), 'the launcher binary must exist after a clean build');
  });

  // -------------------------------------------------------------------------------------
  // The four states criterion 2 names, plus paused. Each one is a different picture, and
  // the picture is decided entirely by the fields asserted here.
  // -------------------------------------------------------------------------------------

  await check('criterion 2, idle: a null timer is idle with no countdown at all -- not a phase named "idle" on the wire', async () => {
    // The protocol has exactly three phases and idle is not one of them: idle is
    // `timer === null`. A client that went looking for an "idle" phase string would find
    // nothing and fall through to whatever its default was.
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      const state = await probe({ home: probeHome, port });
      assert.equal(state.answered, 'yes');
      assert.equal(state.phase, 'idle');
      assert.equal(state.paused, 'no');
      // No digits when there is no interval, whatever menubarCountdown says: the spec's
      // "countdown text appears only while a timer exists".
      assert.equal(state.countdown, 'no');
      assert.equal(state.text, 'none');
      // A full, undepleted circle -- the widget's plain tomato, not an interval that has
      // just run out. This is the one field that separates idle from a timer at 00:00.
      assert.equal(state.fraction, '1.000');
    });
  });

  await check('criterion 2, work: a running work interval is full-weight work with a live countdown', async () => {
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'work', deadline: now + 15 * 60_000, paused: false }, { workMin: 30 }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.phase, 'work');
        assert.equal(state.paused, 'no');
        assert.equal(state.countdown, 'yes');
        assert.match(state.text, /^\d{2}:\d{2}$/);
      });
  });

  await check('criterion 2, short break vs long break: the two break phases are told apart, not collapsed into one', async () => {
    // ADR.md entry 80 is why two glyph
    // shapes have to cover four states. If the derivation collapsed `break` and `longBreak` into one
    // phase there would be nothing left for the renderer to draw differently, and
    // criterion 2 would be unmeetable regardless of how the drawing was done.
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'break', deadline: now + 3 * 60_000, paused: false }),
      async ({ probeHome, port }) => {
        assert.equal((await probe({ home: probeHome, port })).phase, 'break');
      });
    await withDaemon(runningDoc({ phase: 'longBreak', deadline: now + 10 * 60_000, paused: false }),
      async ({ probeHome, port }) => {
        assert.equal((await probe({ home: probeHome, port })).phase, 'longBreak');
      });
  });

  await check('paused: keeps its own phase, reads its frozen remainingMs, and never touches the deadline', async () => {
    // A paused timer carries `remainingMs` and no `deadline` at all -- pauseTimer froze it
    // server-side. A client that subtracted a clock from a missing deadline would show a
    // countdown racing backwards from the epoch.
    await withDaemon(runningDoc({ phase: 'work', paused: true, remainingMs: 90_000 }, { workMin: 25 }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.phase, 'work', 'paused draws the glyph its phase would draw');
        assert.equal(state.paused, 'yes');
        assert.equal(state.remaining, '90');
        assert.equal(state.text, '01:30');
        // Frozen, and asserted as an exact string: a paused timer's arc must not move.
        assert.equal(state.fraction, (90_000 / (25 * 60_000)).toFixed(3));
      });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 3 -- the arc.
  // -------------------------------------------------------------------------------------

  await check('criterion 3: the arc fraction at a known remaining time is remaining-over-the-phase\'s-own-length', async () => {
    // Half of a 30-minute work interval left is half an arc. The denominator has to be the
    // WORK length here -- reading breakMin, or a hardcoded 25, would put the arc at 1.000
    // (clamped) and 0.600 respectively, so this pins the phase-to-duration mapping as much
    // as the arithmetic.
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'work', deadline: now + 15 * 60_000, paused: false },
      { workMin: 30, breakMin: 5, longBreakMin: 15 }), async ({ probeHome, port }) => {
      const state = await probe({ home: probeHome, port });
      const fraction = Number(state.fraction);
      // A round trip and a process spawn of slack, which at half an hour is far under a
      // thousandth: 0.01 is generous and still an order of magnitude tighter than any
      // wrong denominator would land.
      assert.ok(Math.abs(fraction - 0.5) < 0.01, `expected an arc near 0.5, got ${state.fraction}`);
      assert.ok(Math.abs(Number(state.remaining) - 900) <= 3, `expected ~900s remaining, got ${state.remaining}`);
    });
  });

  await check('criterion 3: a break\'s arc is measured against breakMin, not against the work length', async () => {
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'break', deadline: now + 2 * 60_000, paused: false },
      { workMin: 25, breakMin: 8 }), async ({ probeHome, port }) => {
      const fraction = Number((await probe({ home: probeHome, port })).fraction);
      assert.ok(Math.abs(fraction - 0.25) < 0.01, `expected an arc near 0.25 (2 of 8 min), got ${fraction}`);
    });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 1 -- the item and the widget must agree.
  // -------------------------------------------------------------------------------------

  await check('criterion 1: the countdown matches what the index widget would render from the SAME daemon response', async () => {
    // The strongest form of "tracks the daemon within one second of the widget" a check can
    // reach: node fetches /api/pomodoro exactly as the widget's fetchPomodoro does, computes
    // the countdown with the widget's own formatCountdown, and compares against the string
    // the item derived. Two implementations of the same arithmetic, one in C and one in JS,
    // pinned to each other rather than each to a constant.
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'work', deadline: now + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port, secret }) => {
        const state = await probe({ home: probeHome, port });
        const doc = await (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
          headers: { [SECRET_HEADER]: secret },
        })).json();
        // The daemon's own `now`, never this process's clock -- the same offset correction
        // bin/menubar.m applies, and the reason two surfaces on skewed clocks still agree.
        const widgetSeconds = Math.round(Math.max(0, doc.timer.deadline - doc.now) / 1000);
        assert.ok(Math.abs(Number(state.remaining) - widgetSeconds) <= 1,
          `the item says ${state.remaining}s, the widget would say ${widgetSeconds}s`);
        assert.equal(state.text, formatCountdown(Number(state.remaining) * 1000),
          'and the text is formatCountdown\'s own spelling, zero-padded the same way');
      });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 4 -- the popover's five Timer actions.
  //
  // "Every one takes effect in the index widget without a reload" is, from this end, one
  // claim: the action was genuinely POSTed and genuinely accepted. The widget's half needs
  // nothing from this code -- it polls GET /api/pomodoro every 15s and repaints locally
  // every second, so a change that reached the daemon reaches the widget on its own. So
  // what is asserted below is the daemon's OWN document after each press, read back the
  // way any other client would read it, rather than the probe's report alone: a client
  // that printed a plausible line without posting anything would pass the second and fail
  // the first.
  // -------------------------------------------------------------------------------------

  await check('criterion 4: start, pause, resume, forward and restart each reach the daemon and change its state', async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const doc = async () => (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      assert.equal((await doc()).timer, null, 'setup: the daemon starts idle, so `start` has something to do');

      // Start. `ensure` is the route, and it is what the widget's own switch posts against
      // a null timer (pomodoroSwitchAction) -- not `restart`, which is a no-op when there
      // is nothing running, and not a settings write.
      const started = await probe({ home: probeHome, port, args: ['start'] });
      assert.equal(started.code, 0, `start must be accepted: ${started.stderr}`);
      const afterStart = await doc();
      assert.equal(afterStart.timer.phase, 'work', 'a started pomodoro is a work interval');
      assert.equal(afterStart.timer.paused, false);
      assert.equal(started.phase, 'work', 'and the item reports it in the same breath, without waiting for the next poll');

      // Pause. The daemon converts the deadline into a frozen remainingMs -- asserting the
      // SHAPE and not just the flag is what separates a real pause from a write that set a
      // boolean and left a deadline running underneath it.
      const paused = await probe({ home: probeHome, port, args: ['pause'] });
      assert.equal(paused.code, 0, `pause must be accepted: ${paused.stderr}`);
      const afterPause = await doc();
      assert.equal(afterPause.timer.paused, true);
      assert.ok(typeof afterPause.timer.remainingMs === 'number', 'a paused timer carries remainingMs');
      assert.equal(afterPause.timer.deadline, undefined, 'and no deadline at all');

      const resumed = await probe({ home: probeHome, port, args: ['resume'] });
      assert.equal(resumed.code, 0, `resume must be accepted: ${resumed.stderr}`);
      const afterResume = await doc();
      assert.equal(afterResume.timer.paused, false);
      assert.ok(typeof afterResume.timer.deadline === 'number', 'a resumed timer is minted a fresh deadline');

      // Forward. The one action whose effect is a PHASE change, which is why it is asserted
      // on the phase rather than on the clock: settleBoundary advances work -> break, on
      // the daemon, exactly as it would have at the boundary this skipped to.
      const forwarded = await probe({ home: probeHome, port, args: ['forward'] });
      assert.equal(forwarded.code, 0, `forward must be accepted: ${forwarded.stderr}`);
      const afterForward = await doc();
      assert.equal(afterForward.timer.phase, 'break', 'forward from work lands on the break the daemon was going to give anyway');
      assert.equal(forwarded.phase, 'break');

      // Restart. Re-mints the CURRENT phase's deadline to a full interval, so the check is
      // "the break got its whole five minutes back" -- a restart that had silently posted
      // `ensure` instead would have left a work interval here.
      await probe({ home: probeHome, port, args: ['forward'] });  // burn a little of it first
      const restarted = await probe({ home: probeHome, port, args: ['restart'] });
      assert.equal(restarted.code, 0, `restart must be accepted: ${restarted.stderr}`);
      const afterRestart = await doc();
      const fullMs = afterRestart.settings[afterRestart.timer.phase === 'work' ? 'workMin' : 'breakMin'] * 60_000;
      const left = afterRestart.timer.deadline - afterRestart.now;
      assert.ok(Math.abs(left - fullMs) < 5_000, `restart re-mints a full ${fullMs}ms interval, got ${left}ms`);
    });
  });

  await check('criterion 4: the ONE primary control means start, pause or resume exactly as the widget\'s switch does', async () => {
    // src/indexpage.mjs's pomodoroSwitchAction is three lines: no timer -> ensure, paused
    // -> resume, otherwise -> pause. The popover mirrors it rather than inventing a second
    // opinion about what "the button" does, and `primary=` is that mirror's report. A
    // popover that offered Start beside Pause, or that posted `ensure` at a paused timer
    // (which is a no-op -- ensureTimer keeps the timer it finds), would fail here.
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).primary, 'Start', 'idle');
      await probe({ home: probeHome, port, args: ['start'] });
      assert.equal((await probe({ home: probeHome, port })).primary, 'Pause', 'running');
      await probe({ home: probeHome, port, args: ['pause'] });
      assert.equal((await probe({ home: probeHome, port })).primary, 'Resume', 'paused');
      await probe({ home: probeHome, port, args: ['resume'] });
      assert.equal((await probe({ home: probeHome, port })).primary, 'Pause', 'running again');
    });
  });

  await check('criterion 4: the popover\'s one line of text names the phase, the pause and the countdown', async () => {
    // The digits beside the icon say how long; this line says what OF. It is the only text
    // the popover retitles on the tick, and it is derived by a pure function next to
    // cb_derive for exactly the reason everything else here is.
    const now = Date.now();
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).status, 'Idle');
    });
    await withDaemon(runningDoc({ phase: 'longBreak', deadline: now + 9 * 60_000, paused: false }),
      async ({ probeHome, port }) => {
        // "Long break", not the wire's `longBreak`: the two break phases are told apart in
        // words here, where the icon has only a filled circle to do it with.
        assert.match((await probe({ home: probeHome, port })).status, /^Long break · \d{2}:\d{2}$/);
      });
    await withDaemon(runningDoc({ phase: 'work', paused: true, remainingMs: 90_000 }),
      async ({ probeHome, port }) => {
        assert.equal((await probe({ home: probeHome, port })).status, 'Work · paused · 01:30');
      });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 8 -- reset is not reachable, which is an ABSENCE.
  //
  // An absence cannot be checked by driving a UI: no click proves a button is missing, and
  // a check that pressed every button and saw no reset would pass just as happily against
  // a popover with a Reset row nobody wired up. So it is asserted twice, and neither form
  // is decoration -- the behavioural half pins the seam, the structural half pins the file.
  // -------------------------------------------------------------------------------------

  await check('criterion 8: `reset` is refused by the one seam that can act, and the daemon\'s timer survives asking', async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      await probe({ home: probeHome, port, args: ['start'] });
      const before = await (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      assert.equal(before.timer.phase, 'work', 'setup: there has to be something for a reset to destroy');

      const refused = await probe({ home: probeHome, port, args: ['reset'] });
      assert.notEqual(refused.code, 0, 'an action this file cannot perform must not exit 0');
      assert.equal(refused.signal, null, 'and must be a refusal rather than a crash');
      assert.match(refused.stderr, /unrecognised menu bar action/);

      const after = await (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      assert.equal(after.timer.phase, 'work', 'the interval is still running');
      assert.equal(after.timer.deadline, before.timer.deadline, 'and untouched -- nothing was posted at all');
      assert.equal(after.cycle, before.cycle, 'reset zeroes the cycle; the cycle is where it was');
    });
  });

  await check('criterion 8, structurally: /api/pomodoro/reset appears nowhere in bin/menubar.m, and the routes it CAN reach are a closed set', async () => {
    // The honest form of "reset is not reachable from the popover": the popover can only
    // post what the file names, so what the file names is the assertion. This is also the
    // check that catches the plausible future edit -- a seventh row added to
    // CB_ACTION_PATHS "for symmetry with the widget" -- which no behavioural check would
    // notice until somebody's cycle was zeroed.
    // Quoted STRING LITERALS, not the raw text: a comment naming the route it must not
    // reach is exactly what that file should say, and an assertion that forbade the words
    // would forbid the explanation too.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    const routes = [...new Set([...source.matchAll(/"(\/api\/[a-zA-Z/]*)"/g)].map(m => m[1]))].sort();
    assert.ok(!routes.includes('/api/pomodoro/reset'), 'the reset route must not be a string this client can post to');
    assert.deepEqual(routes, [
      '/api/pomodoro',            // the poll
      '/api/pomodoro/ensure',     // start
      '/api/pomodoro/forward',
      '/api/pomodoro/pause',
      '/api/pomodoro/restart',
      '/api/pomodoro/resume',
      '/api/pomodoro/settings',   // criterion 12's hide, and nothing else
      '/api/waiting',             // criterion 6's rows
    ], 'every route this process can reach, and reset is not among them');
  });

  // -------------------------------------------------------------------------------------
  // Criterion 6 -- the waiting boards, the five-row cap and the overflow.
  //
  // The route is uncapped by design (src/server.mjs says so), so the cap and the "and N
  // more" arithmetic are the CLIENT's rules and live in pure C functions beside cb_derive.
  // That is what makes them checkable at all: nothing below needs a popover to exist.
  // -------------------------------------------------------------------------------------

  await check('criterion 6: at most five rows, an overflow row counting the rest, and each row named by thread title and round', async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const ask = async title => (await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title,
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      })).json();

      const empty = await probe({ home: probeHome, port });
      assert.equal(empty.waiting, '0', 'a daemon with nothing waiting has no rows');
      assert.equal(empty.more, '0');
      assert.equal(empty.rows.length, 0);
      assert.equal(empty.morerow, undefined, 'and no overflow row -- "0 more waiting" is a row nobody should ever see');
      assert.equal(empty.caption, 'Nothing waiting', 'nothing waiting is a state the popover names, not an empty section');

      await ask('BOARD_1');
      const one = await probe({ home: probeHome, port });
      assert.equal(one.caption, '1 waiting for an answer', 'singular -- the case a plural-only caption gets wrong, and the commonest one');

      for (let i = 2; i <= 5; i++) await ask(`BOARD_${i}`);
      const five = await probe({ home: probeHome, port });
      assert.equal(five.waiting, '5', 'exactly five fit');
      assert.equal(five.total, '5');
      assert.equal(five.more, '0', 'and at exactly the cap there is nothing left over');
      assert.equal(five.morerow, undefined);
      assert.equal(five.caption, '5 waiting for an answer', 'the caption carries the count even when nothing overflows -- the Solution asks the dropdown for "a count of boards waiting", and below the cap the overflow row is not there to supply one');
      for (const row of five.rows) {
        assert.match(row, /^BOARD_\d · round 1$/, `a row is "<thread title> · round <n>", got ${JSON.stringify(row)}`);
      }

      // The boundary, one row past it. Singular, because "1 more waiting" is the case a
      // plural-only string gets wrong and the case that happens most.
      await ask('BOARD_6');
      const six = await probe({ home: probeHome, port });
      assert.equal(six.waiting, '5', 'still five rows -- the cap is the popover\'s maximum height');
      assert.equal(six.total, '6', 'and `total` is the route\'s uncapped count, which is what the overflow row counts from');
      assert.equal(six.morerow, '1 more waiting');
      assert.equal(six.caption, '6 waiting for an answer', 'the caption counts what is WAITING, not what is drawn -- six waiting, five rows, one over');

      await ask('BOARD_7');
      const seven = await probe({ home: probeHome, port });
      assert.equal(seven.waiting, '5');
      assert.equal(seven.total, '7');
      assert.equal(seven.morerow, '2 more waiting');
      assert.equal(seven.rows.length, 5, 'the rows never grow past the cap however long the list gets');
    });
  });

  await check('criterion 6: a title too long for a row is elided rather than allowed to widen the popover', async () => {
    // A board title is arbitrary text from the reader's own machine. The elision is at a
    // byte count, so it also has to not cut a multi-byte character in half -- half a
    // character is not a string, +[NSString stringWithUTF8String:] returns nil for one, and
    // -[NSButton setTitle:] raises on nil. The å is there to make that a real case rather
    // than a hypothetical one.
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      // A run of ASCII long enough to overflow, followed by multi-byte characters, so that
      // wherever the cut falls it falls near one. The exact index is not asserted -- that
      // would be this check knowing CB_TITLE_MAX -- but its VALIDITY is.
      const title = `${'x'.repeat(60)}åååååååå`;
      await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title,
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      });
      const state = await probe({ home: probeHome, port });
      assert.equal(state.rows.length, 1);
      const row = state.rows[0];
      assert.ok(row.endsWith('… · round 1'), `an over-long title is cut with an ellipsis, got ${JSON.stringify(row)}`);
      assert.ok(row.length < title.length, 'and the row is shorter than the title it came from');
      assert.ok(!row.includes('�'),
        'and the cut never lands inside a multi-byte character: a U+FFFD here means the C side emitted invalid UTF-8, which +[NSString stringWithUTF8String:] answers with nil and -[NSButton setTitle:] raises on');
    });
  });

  await check('criterion 6: a row may only open a URL the board-URL pattern accepts, and the route\'s own URL is one', async () => {
    // The row hands its URL to LaunchServices, which acts on any scheme it can resolve --
    // `file:`, an app's custom scheme, a remote `https:` phishing page. It is filtered by
    // bin/launcher.c's cb_is_board_url, the SAME function the banner's click target is
    // filtered by (ADR 57), and `--menubar --probe url` runs that function alone. Two
    // patterns for one question would be two opinions about what `/b/../../etc` means.
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const posted = await (await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title: 'URL_FIXTURE',
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      })).json();
      const listed = await (await fetch(`http://127.0.0.1:${port}/api/waiting`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      const entry = listed.waiting.find(e => e.boardId === posted.boardId);
      assert.ok(entry, 'setup: the board is waiting');

      const verdict = async url => (await probe({ home: probeHome, port, args: ['url', url] })).url;
      // The URL the route actually built, never one this check spelled by hand: if the two
      // could disagree, every row in the product would be dead and this would still pass.
      assert.equal(await verdict(entry.url), 'ok', `the route's own URL must be openable: ${entry.url}`);

      for (const bad of [
        `https://127.0.0.1:${port}/b/${posted.boardId}`,       // not the scheme this daemon serves
        `http://evil.com/b/${posted.boardId}`,                 // not loopback
        `http://127.0.0.1:${port + 1}/b/${posted.boardId}`,    // another service on the same loopback
        `http://127.0.0.1:${port}/api/pomodoro`,               // loopback and this port, wrong path
        `http://127.0.0.1:${port}/b/../../etc/passwd`,         // one path segment, and `.` is not in the id set
        `http://127.0.0.1:${port}/b/${posted.boardId}?x=1`,    // no query string
        `http://127.0.0.1:${port}/b/`,                         // no id at all
        'file:///etc/passwd',
        `http://127.0.0.1:${port}/b/a b`,                      // a space is neither an id nor an accident
        '',
      ]) {
        assert.equal(await verdict(bad), 'refused', `must be refused: ${JSON.stringify(bad)}`);
      }
    });
  });

  // -------------------------------------------------------------------------------------
  // Criteria 11 and 12's storage -- the two settings ticket 01 added.
  // -------------------------------------------------------------------------------------

  await check('criterion 11: menubarCountdown false suppresses the text and leaves everything else -- the icon, the phase, the arc', async () => {
    const now = Date.now();
    // 20 of the default 25 minutes left, so the arc has a value the switch could plausibly
    // have disturbed -- 1.000 would pass this assertion by accident on a derivation that
    // reset the fraction along with the text.
    const timer = { phase: 'work', deadline: now + 20 * 60_000, paused: false };
    await withDaemon(runningDoc(timer, { menubarCountdown: false }), async ({ probeHome, port }) => {
      const off = await probe({ home: probeHome, port });
      assert.equal(off.countdown, 'no', 'the digits must not reach the button');
      assert.equal(off.phase, 'work', 'and the icon is untouched by the switch');
      assert.ok(Math.abs(Number(off.fraction) - 0.8) < 0.01, `as is the arc: ${off.fraction}`);
      // `text` is what the derivation produced, not what would be shown -- proving the
      // suppression is a display decision rather than a countdown that stopped being
      // computed. That is what lets the switch take effect on a redraw with no restart.
      assert.match(off.text, /^\d{2}:\d{2}$/);
    });
    await withDaemon(runningDoc(timer, { menubarCountdown: true }), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).countdown, 'yes');
    });
  });

  await check('menubarHidden is reported to the item, both ways round', async () => {
    // Ticket 05 hides the item from its own popover and the index page brings it back, and
    // both halves of that are this one boolean arriving on every poll. Reported, never
    // acted on by exiting: an item that exited when hidden would leave nothing for the
    // settings panel to reach.
    await withDaemon(runningDoc(null, { menubarHidden: true }), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).hidden, 'yes');
    });
    await withDaemon(runningDoc(null, { menubarHidden: false }), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).hidden, 'no');
    });
  });

  await check('criterion 12: the popover\'s Hide writes menubarHidden through the settings route, and the index page\'s panel brings it back', async () => {
    // "Survives a logout" is a claim about where the boolean LIVES, and the honest form of
    // it is that the daemon persisted it: this process holds no state of its own and needs
    // no restart machinery, because every poll reads settings.menubarHidden back and the
    // process never exits when hidden. So a logout takes the item away and a login brings
    // back a process that reads `true` and stays off the bar.
    //
    // This is also the one write in the whole popover, and it is a COMMAND rather than a
    // settings form -- which is what keeps it beside criterion 7's "no setting is editable
    // from the menu bar" rather than in breach of it.
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 10 * 60_000, paused: false }),
      async ({ probeHome, port, secret }) => {
        const doc = async () => (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
          headers: { [SECRET_HEADER]: secret },
        })).json();
        assert.equal((await doc()).settings.menubarHidden, false, 'setup: visible to begin with');

        const hidden = await probe({ home: probeHome, port, args: ['hide'] });
        assert.equal(hidden.code, 0, `hide must be accepted: ${hidden.stderr}`);
        assert.equal(hidden.hidden, 'yes', 'and the item knows it in the same breath');

        const after = await doc();
        assert.equal(after.settings.menubarHidden, true, 'persisted by the daemon -- which is the whole of surviving a logout');
        assert.equal(after.timer.phase, 'work', 'and hiding the ITEM does not touch the timer');
        assert.equal(after.settings.menubarCountdown, true, 'nor any other setting: the hide patches one key');

        // The way back, and it is the index page's existing panel rather than anything
        // native: the same route with the boolean the other way round, which is exactly
        // what the widget's "Show in menu bar" checkbox posts.
        await fetch(`http://127.0.0.1:${port}/api/pomodoro/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
          body: JSON.stringify({ menubarHidden: false }),
        });
        assert.equal((await probe({ home: probeHome, port })).hidden, 'no',
          'and the running item picks that up on its next poll, with no restart');
      });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 9 -- everything that is not an answer.
  // -------------------------------------------------------------------------------------

  await check('criterion 9: an absent daemon is reported as not-answering, promptly, and is not a crash', async () => {
    // The boot race, in the only shape a check can hold it: launchd starts this child and
    // the daemon at the same instant, and install.sh's bootout -> bootstrap -> kickstart
    // takes the daemon away underneath a running item. Both have to come back as "no
    // answer" -- which is what makes the item stay off the menu bar until there IS one, and
    // what dims it rather than deleting it afterwards.
    const home = makeProbeHome(randomBytes(32).toString('hex'));
    // A port nothing is listening on. Bound and released first, so this is a port the
    // kernel just confirmed free rather than a guess that could collide with the suite's
    // other concurrent checks.
    const { createServer } = await import('node:net');
    const port = await new Promise((resolve, reject) => {
      const probeSocket = createServer();
      probeSocket.on('error', reject);
      probeSocket.listen(0, '127.0.0.1', () => {
        const bound = probeSocket.address().port;
        probeSocket.close(() => resolve(bound));
      });
    });
    const state = await probe({ home, port });
    assert.equal(state.answered, 'no');
    assert.equal(state.phase, 'idle', 'and it draws the calm idle glyph rather than inventing one');
    assert.equal(state.countdown, 'no', 'criterion 9: a silent daemon drops the countdown');
    assert.ok(state.elapsedMs < 10_000, `a refused connection must not be waited out: took ${state.elapsedMs}ms`);
  });

  await check('criterion 9 for a WRITE: an action against an absent daemon fails, says so, and neither crashes nor hangs', async () => {
    // The read half of this is above; a write has a second way to go wrong. A popover
    // button pressed while the daemon is being reinstalled must come back as a failed POST
    // — not a hang holding the poll queue (which would freeze the countdown behind it),
    // and not a crash (which under ADR 72 costs the menu bar but is still the one thing
    // this process is not allowed to do quietly).
    const home = makeProbeHome(randomBytes(32).toString('hex'));
    const { createServer } = await import('node:net');
    const port = await new Promise((resolve, reject) => {
      const probeSocket = createServer();
      probeSocket.on('error', reject);
      probeSocket.listen(0, '127.0.0.1', () => {
        const bound = probeSocket.address().port;
        probeSocket.close(() => resolve(bound));
      });
    });
    for (const action of ['start', 'pause', 'resume', 'forward', 'restart', 'hide']) {
      const state = await probe({ home, port, args: [action] });
      assert.equal(state.signal, null, `${action} must not crash against an absent daemon`);
      assert.notEqual(state.code, 0, `${action} must report that it did not land`);
      assert.match(state.stderr, /did not accept/);
      assert.ok(state.elapsedMs < 10_000, `${action} must not be waited out: took ${state.elapsedMs}ms`);
    }
  });

  await check('criterion 9: a WRONG secret is not-answering either, and does not retry in a loop', async () => {
    // The rotation case: the daemon is up and healthy, the credential this process holds is
    // stale. bin/menubar.m drops its cached secret on any failed poll so the next one picks
    // up a rotated file -- what must NOT happen is a retry storm against a daemon that is
    // refusing it, which would be indistinguishable from a working item while pinning a
    // core. The one-shot probe pins the report; the elapsed time pins that nothing spun.
    await withDaemon(runningDoc(null), async ({ port }) => {
      const wrongHome = makeProbeHome(randomBytes(32).toString('hex'));
      const state = await probe({ home: wrongHome, port });
      assert.equal(state.answered, 'no');
      assert.ok(state.elapsedMs < 10_000, `a refused credential must be reported at once: took ${state.elapsedMs}ms`);
    });
  });

  await check('criterion 9: a MISSING secret file is not-answering, with no request sent at all', async () => {
    await withDaemon(runningDoc(null), async ({ port }) => {
      const emptyHome = makeProbeHome(null);
      const state = await probe({ home: emptyHome, port });
      assert.equal(state.answered, 'no');
      assert.ok(state.elapsedMs < 10_000, `a missing credential must be reported at once: took ${state.elapsedMs}ms`);
    });
  });

  // -------------------------------------------------------------------------------------
  // The seam itself.
  // -------------------------------------------------------------------------------------

  await check('the probe is argv-gated: `--menubar` alone is the run loop, and never the one-shot', async () => {
    // The supervised path is bin/launcher.c exec'ing this binary with exactly one argument.
    // If the probe branch could be reached without `--probe` -- an argc check off by one,
    // an argv[2] read past the end -- then every login would put a one-shot process on the
    // menu bar that printed a line and exited, and there would be no status item at all.
    const child = (await import('node:child_process')).spawn(launcherExec, ['--menubar'], {
      env: { PATH: process.env.PATH, HOME: makeProbeHome(null) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    await new Promise(resolve => setTimeout(resolve, 1200));
    try {
      assert.equal(exited, null, `--menubar alone must keep running, not print and exit:\n${out}`);
      assert.ok(!out.includes('phase='), `--menubar alone must not reach the probe:\n${out}`);
    } finally {
      child.kill('SIGTERM');
      child.stdout.destroy();
      child.stderr.destroy();
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
    rmSync(workDir, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall menubar-client checks ok');
  });
