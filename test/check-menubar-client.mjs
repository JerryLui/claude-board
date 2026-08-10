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
// The popover widened that seam rather than opening a second one. `--menubar --probe
// <action>` performs ONE of the popover's five actions through the same cb_perform its
// controls call and then reports, which is what makes "every one takes effect" checkable
// at all; `--menubar --probe url <candidate>` runs the board-URL validator alone; and
// `--menubar --probe icons` reports the bounding box of each icon the popover draws, which
// is the one observable the SVG path-data walker has. The popover's rows are printed by the
// plain probe, because the rules that decide them — five at most, the overflow's
// arithmetic, the row's wording, which action the switch performs and which word sits
// beside it — are pure C functions sitting next to cb_derive for exactly this reason. What
// is NOT covered, and cannot be: whether any of it is on screen, legible,
// keyboard-reachable or correct in dark mode. No assertion below would survive
// bin/menubar.m's popover being deleted wholesale, and none pretends to.
//
// The acceptance criteria this file exists for:
//
//   - 1, "shows the current phase and the remaining time, and both track the daemon within
//     one second of the widget": the countdown the probe derives is compared against the
//     one node computes from the same daemon's own response.
//   - 2, "the phase is legible": what the derivation tells apart is what anything can draw
//     differently, so the phase, the ring and the centre mark are all pinned here. The icon
//     is a template image, so there is no colour in it to check at all and the system owns
//     the ink in both appearances. Whether the states LOOK different is the half no check
//     can reach.
//   - 3, "how much of the interval is left": the ring's fraction at a known remaining time.
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
//
// Two later decisions are pinned here as well, and both are about the glyph rather than the
// HTTP. ADR 83, paused says so with shape and not a number: the menu bar title is empty and
// the status line names the phase alone. ADR 84, one signal one dimension: the tomato
// silhouette in every state, a ring for time remaining, one flat bar for a break, two
// vertical bars for paused, and opacity meaning only that the daemon has gone quiet. Those
// live on `cb_display` as `ring` and `mark` FOR THIS REASON -- a decision the derivation
// records is checkable, and a condition rediscovered inside the drawing code is not.
//
// The popover's own row set is the same story one step further. Its words are all reported
// (`status`, `stateword`, `caption`, `row`), so "the word paused appears exactly once in
// the whole popover" is a behavioural assertion rather than a screenshot; and every glyph
// it draws is a byte copy of src/pomodoro-widget.mjs's, so "no glyph is invented for this
// surface" is a comparison of two files rather than a promise. What remains uncheckable is
// everything about the arrangement: which row is above which, that the gear is on the
// right, that a waiting row has no bezel.
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
import { spawnSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
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
  const state = { elapsedMs: Date.now() - started, code, signal, stderr, stdout, rows: [], icons: [] };
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
    // `icons` prints one bare-word line per icon, so it parses like the first line does --
    // one entry per icon rather than keys on the report, there being three of them.
    if (line.startsWith('icon=')) {
      const icon = {};
      for (const pair of line.split(' ')) {
        const at = pair.indexOf('=');
        if (at > 0) icon[pair.slice(0, at)] = pair.slice(at + 1);
      }
      state.icons.push(icon);
      continue;
    }
    if (line.startsWith('row=')) state.rows.push(line.slice(4));
    else if (line.startsWith('morerow=')) state.morerow = line.slice(8);
    else if (line.startsWith('caption=')) state.caption = line.slice(8);
    else if (line.startsWith('status=')) state.status = line.slice(7);
    else if (line.startsWith('url=')) state.url = line.slice(4);
    // `--menubar --probe stream` (ticket 01): `stream=connected|refused` first, then
    // `event=<name>|timeout` once the wait is over -- see cb_stream_probe's own comment.
    else if (line.startsWith('stream=')) state.stream = line.slice(7);
    else if (line.startsWith('event=')) state.event = line.slice(6);
    // `--menubar --probe live` (ticket 02): `stream=` as above, then `live=pushed|timeout`
    // -- see cb_menubar_probe_live's own comment.
    else if (line.startsWith('live=')) state.live = line.slice(5);
    // `--menubar --probe run` (ticket 03): `run=polled|timeout` first, no `stream=` line --
    // see cb_menubar_probe_run's own comment for why.
    else if (line.startsWith('run=')) state.run = line.slice(4);
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
    // `server` is exposed for ticket 03's own checks, which need to kill this daemon out
    // from under a live client and restart one on the same port -- every other caller here
    // only ever reads daemonHome/probeHome/port/secret and can go on ignoring it.
    await fn({ daemonHome, probeHome, port, secret, server });
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
    // The two breaks DRAW the same glyph (ADR 84 spent the last dimension that told them
    // apart), but they are still two phases on the wire and the popover still names them in
    // words. A derivation that collapsed them here would take that away too, and the
    // boundary logic would have nothing to say which break just ended.
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

  await check('the switch says the state it is IN, where its accessible name says what a press DOES -- and the two are never the same word', async () => {
    // A switch needs both, and they answer different questions. `primary` is the action
    // ("Pause"), which is what a screen reader hears and what the widget's aria-label says;
    // `stateword` is the state ("Running"), which is what the reader sees beside the knob.
    // A control whose only word is an instruction leaves the state to be read off the knob
    // alone, and one whose only word is a state cannot be operated by voice.
    //
    // "Off" and not "Idle" while there is no timer: the status line beside it already says
    // Idle, and a row that says the same word twice is a row that has said nothing twice.
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      const idle = await probe({ home: probeHome, port });
      assert.equal(idle.stateword, 'Off', 'idle');
      assert.equal(idle.status, 'Idle', 'and the line above it is the one that says Idle');
      assert.notEqual(idle.stateword, idle.primary, 'the state and the action are two words, never one');

      await probe({ home: probeHome, port, args: ['start'] });
      const running = await probe({ home: probeHome, port });
      assert.equal(running.stateword, 'Running');
      assert.equal(running.primary, 'Pause', 'the action a press performs is the OTHER word');

      await probe({ home: probeHome, port, args: ['pause'] });
      const paused = await probe({ home: probeHome, port });
      assert.equal(paused.stateword, 'Paused');
      assert.equal(paused.primary, 'Resume');
    });
  });

  await check('ADR 83: the word "paused" appears EXACTLY ONCE in the whole popover, beside the switch -- in every phase, and nowhere at all otherwise', async () => {
    // Every word the popover shows is reported by the probe: the status line, the switch's
    // state word, the waiting caption and each waiting row. So "exactly once" is countable
    // rather than a thing to eyeball, which is the only reason it is a check at all.
    //
    // It is a real constraint in both directions. Once it is said beside the switch, the
    // status line must not repeat it (ADR 83's own point: a fact stated twice); and if a
    // later edit dropped it from the switch to "tidy up", a paused Timer would say so
    // nowhere in words at all, the countdown having gone with it.
    // Occurrences of the WORD, not rows containing it: "exactly once" is a claim about how
    // many times a reader's eye lands on it, and a row that said it twice would be the same
    // duplication read in one line instead of two.
    const wordsOf = state => [state.status, state.stateword, state.caption, ...state.rows];
    const countPaused = state => (wordsOf(state).join(' ').match(/paused/gi) || []).length;

    for (const phase of ['work', 'break', 'longBreak']) {
      await withDaemon(runningDoc({ phase, paused: true, remainingMs: 90_000 }),
        async ({ probeHome, port }) => {
          const state = await probe({ home: probeHome, port });
          assert.equal(state.stateword, 'Paused', `a paused ${phase} says so beside the switch`);
          assert.equal(countPaused(state), 1,
            `and exactly once in the whole popover: ${JSON.stringify(wordsOf(state))}`);
        });
    }
    // And never at all when nothing is paused -- which is what makes the count above a
    // count of one thing rather than of a word that is simply always there.
    for (const timer of [null, { phase: 'work', deadline: Date.now() + 5 * 60_000, paused: false }]) {
      await withDaemon(runningDoc(timer), async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(countPaused(state), 0,
          `nothing that is not paused may say so: ${JSON.stringify(wordsOf(state))}`);
      });
    }
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
        // "Long break", not the wire's `longBreak` -- and this line is now the ONLY place
        // the two breaks are told apart at all, the glyph having stopped trying (ADR 84).
        assert.match((await probe({ home: probeHome, port })).status, /^Long break · \d{2}:\d{2}$/);
      });
  });

  // -------------------------------------------------------------------------------------
  // Paused says so with SHAPE, not a number (ADR 83).
  // -------------------------------------------------------------------------------------

  await check('paused: no time in the status line and no title on the menu bar button -- the phase name alone, and not the word "paused" either', async () => {
    // A frozen countdown reads as a clock that has stopped working rather than one
    // deliberately stopped, and it states twice what the two bars in the glyph already say.
    // So the menu bar title goes (`countdown=no`, which is what empties it) and the status
    // line keeps the phase and drops the clock.
    //
    // The word "paused" is NOT here on purpose: the switch beside this line carries it, and
    // the popover says it exactly once. A status line that said it too would be the second
    // time, which is the thing ADR 83 is about.
    for (const [phase, expected] of [['work', 'Work'], ['break', 'Short break'], ['longBreak', 'Long break']]) {
      await withDaemon(runningDoc({ phase, paused: true, remainingMs: 90_000 }),
        async ({ probeHome, port }) => {
          const state = await probe({ home: probeHome, port });
          assert.equal(state.status, expected, `a paused ${phase} names its phase and stops there`);
          assert.ok(!/paused/i.test(state.status), `and never says "paused" itself: ${state.status}`);
          assert.equal(state.countdown, 'no', 'and no digits reach the menu bar button');
          // Still DERIVED, though -- the suppression is a display decision, which is what
          // lets resume put the digits straight back with no refetch.
          assert.equal(state.text, '01:30');
        });
    }
    // The countdown comes back the moment it is running again, so the check above is
    // pinning "paused" rather than a countdown that quietly stopped being computed.
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 90_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.countdown, 'yes');
        assert.match(state.status, /^Work · \d{2}:\d{2}$/, 'a running phase keeps its time');
      });
  });

  // -------------------------------------------------------------------------------------
  // The glyph vocabulary: one signal, one dimension (ADR 84).
  //
  // The paint is not checkable and never will be, so the DECISION is: cb_derive sets `ring`
  // and `mark` on the display struct and cb_draw is a switch over them, which is what makes
  // "a paused Timer draws two bars and no ring" an assertion instead of a screenshot. What
  // is still uncovered is whether the two fields reach pixels that look like anything.
  // -------------------------------------------------------------------------------------

  await check('the glyph vocabulary, state by state: the silhouette always, a ring only while running, and one centre mark at a time', async () => {
    const now = Date.now();
    // Every state the item can be in, and what each one draws. The silhouette is not in
    // this table because it has no field: it is drawn unconditionally, which is the whole
    // point of it -- there is no state in which the tomato is not a tomato.
    const cases = [
      { name: 'idle', timer: null, ring: 'no', mark: 'none' },
      { name: 'running work', timer: { phase: 'work', deadline: now + 5 * 60_000, paused: false }, ring: 'yes', mark: 'none' },
      { name: 'paused work', timer: { phase: 'work', paused: true, remainingMs: 90_000 }, ring: 'no', mark: 'paused' },
      { name: 'running short break', timer: { phase: 'break', deadline: now + 3 * 60_000, paused: false }, ring: 'yes', mark: 'rest' },
      { name: 'running long break', timer: { phase: 'longBreak', deadline: now + 9 * 60_000, paused: false }, ring: 'yes', mark: 'rest' },
      { name: 'paused short break', timer: { phase: 'break', paused: true, remainingMs: 60_000 }, ring: 'no', mark: 'paused' },
      { name: 'paused long break', timer: { phase: 'longBreak', paused: true, remainingMs: 60_000 }, ring: 'no', mark: 'paused' },
    ];
    for (const c of cases) {
      await withDaemon(runningDoc(c.timer), async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.ring, c.ring, `${c.name}: ring`);
        assert.equal(state.mark, c.mark, `${c.name}: centre mark`);
      });
    }
    // And the daemon that has gone quiet, which is not a timer state at all: no ring and no
    // mark, because there is nothing to say. The dimming is the only thing that changes,
    // and the dimming is alpha -- asserted structurally below, there being no pixel here.
    const dead = await (async () => {
      const { createServer } = await import('node:net');
      return new Promise((resolve, reject) => {
        const socket = createServer();
        socket.on('error', reject);
        socket.listen(0, '127.0.0.1', () => {
          const bound = socket.address().port;
          socket.close(() => resolve(bound));
        });
      });
    })();
    const stale = await probe({ home: makeProbeHome(randomBytes(32).toString('hex')), port: dead });
    assert.equal(stale.answered, 'no');
    assert.equal(stale.ring, 'no', 'a silent daemon draws no ring -- there is no live fraction to draw');
    assert.equal(stale.mark, 'none', 'nor a centre mark: silence is not a phase and it is not paused');
  });

  await check('the two vertical bars mean PAUSED and nothing else, and short break and long break draw one identical glyph', async () => {
    // Two claims that are each an absence-shaped thing, and both are what ADR 84 bought by
    // giving every signal one dimension. If a later edit gave the bars back to `break` --
    // the meaning they carried before -- a paused break and a running break would draw the
    // same picture again, and the first assertion is what notices.
    const now = Date.now();
    const marks = {};
    const runningTimers = {
      idle: null,
      work: { phase: 'work', deadline: now + 5 * 60_000, paused: false },
      break: { phase: 'break', deadline: now + 3 * 60_000, paused: false },
      longBreak: { phase: 'longBreak', deadline: now + 9 * 60_000, paused: false },
    };
    for (const [name, timer] of Object.entries(runningTimers)) {
      await withDaemon(runningDoc(timer), async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        marks[name] = `${state.ring}/${state.mark}`;
        assert.notEqual(state.mark, 'paused', `nothing that is not paused may draw the paused bars: ${name} did`);
      });
    }
    assert.equal(marks.break, marks.longBreak,
      `a short break and a long break are ONE glyph now -- the long break's filled disc is retired: ${marks.break} vs ${marks.longBreak}`);
    assert.notEqual(marks.work, marks.break, 'a running break is still not a running work interval');
    assert.notEqual(marks.idle, marks.work, 'and idle is still not a running work interval');
  });

  await check('opacity carries exactly one fact -- the daemon has stopped answering -- and the file has no second weight left to spend', async () => {
    // Structural, and it has to be: alpha is a pixel value, the paint has no headless
    // observer, and "varies for one reason only" is a claim about what the code CAN do
    // rather than about one observed frame. Same technique as the reset-route check below.
    //
    // Two things pin it. cb_ink_alpha may branch on `answered` and on nothing else, and the
    // set of alpha constants is closed at two: full, and the dimmed one. The muted weight
    // that idle and paused used to draw at is gone, and so is the long break's part-alpha
    // disc -- both were alpha saying a second thing, and both are shapes now.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    const constants = [...source.matchAll(/^static const CGFloat (CB_ALPHA_[A-Z_]+)/gm)].map(m => m[1]).sort();
    assert.deepEqual(constants, ['CB_ALPHA_FULL', 'CB_ALPHA_STALE'],
      'a third alpha constant is a second meaning for opacity, which is the thing ADR 84 forbids');
    const body = source.match(/static CGFloat cb_ink_alpha\(cb_display d\) \{([\s\S]*?)\n\}/);
    assert.ok(body, 'cb_ink_alpha must still be the one place an alpha is chosen');
    const fields = [...new Set([...body[1].matchAll(/\bd\.([a-z_]+)/g)].map(m => m[1]))];
    assert.deepEqual(fields, ['answered'],
      `the ink's weight may read one field and it is \`answered\`; it read ${JSON.stringify(fields)}`);
  });

  // -------------------------------------------------------------------------------------
  // The popover's icons: the widget's own, byte for byte.
  //
  // "Every glyph in the popover is one the index page already draws, and none is invented
  // for this surface" is a claim about two files agreeing. Objective-C cannot import a
  // JavaScript string, so bin/menubar.m holds a COPY -- and a copy that nothing compares is
  // a copy that drifts on the first widget edit. These two checks are the comparison and
  // the proof that the copy is actually drawn: one reads both files, the other walks the
  // path data in the built binary and looks at what came out.
  // -------------------------------------------------------------------------------------

  await check('every icon the popover draws is src/pomodoro-widget.mjs\'s own path data, copied verbatim rather than transcribed', async () => {
    // The widget's three module-private icons, and the menu bar's copies of them. A
    // transcription into NSBezierPath calls could not be compared at all -- which is the
    // reason bin/menubar.m walks the `d` string itself, and the reason this check can be
    // this blunt: the strings are either identical or they are not.
    const widget = readFileSync(path.join(repoRoot, 'src', 'pomodoro-widget.mjs'), 'utf8');
    const menubar = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    const attr = (icon, name) => {
      const declaration = widget.match(new RegExp(`const ${icon} = '([^']*)'`));
      assert.ok(declaration, `src/pomodoro-widget.mjs must still declare ${icon}`);
      const found = [...declaration[1].matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map(m => m[1]);
      assert.ok(found.length > 0, `${icon} must still carry a ${name}`);
      return found;
    };
    // The gear is the one that matters most: a dozen elliptical arcs nobody can check by
    // eye, and the whole reason the copy is a byte copy.
    for (const [icon, name] of [['GEAR_ICON', 'd'], ['RESTART_ICON', 'd'], ['RESTART_ICON', 'points'],
                                ['FORWARD_ICON', 'points']]) {
      for (const value of attr(icon, name)) {
        assert.ok(menubar.includes(`"${value}"`),
          `bin/menubar.m must carry ${icon}'s ${name} verbatim -- missing:\n${value}`);
      }
    }
    // The tomato and the rest bar are the OTHER discipline, quoted in a comment beside the
    // AppKit calls that draw them, because ADR 84's glyph is a composition (silhouette,
    // ring, centre mark) rather than any one of the widget's strings. Pinned here so the
    // two disciplines cannot both quietly lapse at once.
    for (const fragment of ['M12 7.8V4.6', 'M9.4 14.6h5.2']) {
      assert.ok(menubar.includes(fragment), `bin/menubar.m must still quote ${fragment}`);
      assert.ok(widget.includes(fragment), `and src/pomodoro-widget.mjs must still draw it`);
    }
  });

  await check('the path-data walker actually draws them: each icon\'s ink lands where the widget\'s viewBox says it should', async () => {
    // The one observable a drawing has without a screen. Both realistic failures of an SVG
    // arc converter show up here: a command the walker does not understand drops a subpath
    // and shrinks the box, and a missing radius correction (the gear's `a2 2 0 1 1-2.83
    // 2.83` asks a radius-2 circle to span 4.002 units) puts a NaN in it.
    //
    // The numbers are read off the icons themselves, in SVG units: Feather draws to a
    // 24-unit box with the ink inset by one, the rotate-ccw arc is a radius-9 circle
    // centred at 12, and skip-forward is a triangle from x 5 to 15 with its bar at 19.
    const state = await probe({ home: makeProbeHome(null), port: 1, args: ['icons'] });
    assert.equal(state.code, 0, `the icons report must exit 0: ${state.stderr}`);
    const boxes = Object.fromEntries(state.icons.map(i => [i.icon, i]));
    assert.deepEqual(Object.keys(boxes).sort(), ['forward', 'gear', 'restart'],
      'three icons, and the popover draws no fourth of its own');
    for (const [name, box] of Object.entries(boxes)) {
      for (const key of ['x', 'y', 'w', 'h']) {
        assert.ok(Number.isFinite(Number(box[key])),
          `${name}: ${key} is ${box[key]} -- a NaN here is an arc the converter could not solve`);
      }
      assert.ok(Number(box.elements) > 0, `${name}: the walk produced no path at all`);
      assert.ok(Number(box.x) >= 0 && Number(box.y) >= 0, `${name}: ink outside the viewBox`);
      assert.ok(Number(box.x) + Number(box.w) <= 24 && Number(box.y) + Number(box.h) <= 24,
        `${name}: ink outside the viewBox`);
    }
    const near = (actual, expected, what) =>
      assert.ok(Math.abs(Number(actual) - expected) < 0.1, `${what}: expected ~${expected}, got ${actual}`);
    // The gear fills the box symmetrically: x and y both run 1..23.
    near(boxes.gear.x, 1, 'gear x'); near(boxes.gear.y, 1, 'gear y');
    near(boxes.gear.w, 22, 'gear width'); near(boxes.gear.h, 22, 'gear height');
    // Restart: the polyline starts at x 1, and the radius-9 arc reaches x 21.
    near(boxes.restart.x, 1, 'restart x'); near(boxes.restart.w, 20, 'restart width');
    // Forward: the polygon's 5..15 plus the bar at 19, and the polygon's own 4..20.
    near(boxes.forward.x, 5, 'forward x'); near(boxes.forward.w, 14, 'forward width');
    near(boxes.forward.h, 16, 'forward height');
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
    // check that catches the plausible future edit -- a sixth row added to
    // CB_ACTION_PATHS "for symmetry with the widget" -- which no behavioural check would
    // notice until somebody's cycle was zeroed.
    // Quoted STRING LITERALS, not the raw text: a comment naming the route it must not
    // reach is exactly what that file should say, and an assertion that forbade the words
    // would forbid the explanation too.
    //
    // /api/pomodoro/settings left this list with the popover's "Hide from menu bar" row.
    // Hiding the item is the index page's to do now, so the menu bar posts no SETTING at
    // all -- which is a stronger form of "nothing is editable from the menu bar" than the
    // row set alone, and one this assertion is what keeps.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    const routes = [...new Set([...source.matchAll(/"(\/api\/[a-zA-Z/]*)"/g)].map(m => m[1]))].sort();
    assert.ok(!routes.includes('/api/pomodoro/reset'), 'the reset route must not be a string this client can post to');
    assert.deepEqual(routes, [
      '/api/events',              // ticket 01's stream probe -- --menubar --probe stream
      '/api/pomodoro',            // the poll
      '/api/pomodoro/ensure',     // start
      '/api/pomodoro/forward',
      '/api/pomodoro/pause',
      '/api/pomodoro/restart',
      '/api/pomodoro/resume',
      '/api/waiting',             // the waiting rows
    ], 'every route this process can reach: the five Timer actions, and two reads');
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
    // The index page's pomodoro settings hide the item and bring it back, and both halves
    // of that are this one boolean arriving on every poll. Reported, never acted on by
    // exiting: an item that exited when hidden would leave nothing for the settings panel
    // to reach. The item itself never WRITES this key -- there is no route to it from
    // bin/menubar.m at all (see the closed route set above), which is why the popover has
    // no "Hide from menu bar" row and the way back is never behind the door it closed.
    await withDaemon(runningDoc(null, { menubarHidden: true }), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).hidden, 'yes');
    });
    await withDaemon(runningDoc(null, { menubarHidden: false }), async ({ probeHome, port }) => {
      assert.equal((await probe({ home: probeHome, port })).hidden, 'no');
    });
  });

  await check('the item can no longer hide itself: `hide` is refused like any other word this file does not know', async () => {
    // The popover used to carry a "Hide from menu bar" row, which was a one-way door: it
    // removed the only surface a reader could use to undo it. The row is gone, and so is
    // the action behind it -- and this is the assertion that the DELETION is real rather
    // than a row that stopped being built while the code that hid the item stayed one
    // caller away from coming back.
    //
    // Same shape as the reset refusal above, and for the same reason: an absence cannot be
    // checked by driving a UI.
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 10 * 60_000, paused: false }),
      async ({ probeHome, port, secret }) => {
        const doc = async () => (await fetch(`http://127.0.0.1:${port}/api/pomodoro`, {
          headers: { [SECRET_HEADER]: secret },
        })).json();
        assert.equal((await doc()).settings.menubarHidden, false, 'setup: visible to begin with');

        const refused = await probe({ home: probeHome, port, args: ['hide'] });
        assert.notEqual(refused.code, 0, 'an action this file cannot perform must not exit 0');
        assert.equal(refused.signal, null, 'and must be a refusal rather than a crash');
        assert.match(refused.stderr, /unrecognised menu bar action/);

        const after = await doc();
        assert.equal(after.settings.menubarHidden, false, 'and nothing was written: the item is still on the bar');
        assert.equal(after.timer.phase, 'work', 'nor was the timer touched');

        // The way to hide it is the index page's own panel, and it still works -- which is
        // the half that had to survive this deletion. It is exactly what the widget's
        // "Show in menu bar" checkbox posts, inverted.
        await fetch(`http://127.0.0.1:${port}/api/pomodoro/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
          body: JSON.stringify({ menubarHidden: true }),
        });
        assert.equal((await probe({ home: probeHome, port })).hidden, 'yes',
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
    for (const action of ['start', 'pause', 'resume', 'forward', 'restart']) {
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
  // Ticket 01: the daemon-wide stream, and the probe seam widened to hold
  // it open. No acceptance criterion of its own -- it is the prefactor tickets 02 and 03
  // build on -- so what is pinned here is narrower than the criterion-numbered checks
  // above: the stream exists, is reachable from this exact seam, carries a real push
  // across real loopback, and reports honestly when nothing arrives or nothing answers.
  // -------------------------------------------------------------------------------------

  /** Spawn `--menubar --probe <args>` and resolve as soon as its FIRST line lands, never
   * on a sleep: `execFileAsync` (the `probe()` helper above) cannot be used for the
   * positive-push checks below, because it does not resolve until the child EXITS, and
   * this child deliberately stays alive, mid-report, until a push arrives or the window
   * closes. Resolves with the accumulated stdout/stderr (kept live) and a `waitForExit()`
   * the caller awaits once it has done whatever it wanted the still-open stream to
   * observe. Shared by `openStreamProbe` (ticket 01, `stream <seconds>`) and
   * `openLiveProbe` (ticket 02, `live <seconds>`) below -- both modes' first fflush is
   * always `stream=connected` or `stream=refused`, so both resolve on the same signal. */
  function spawnHeldProbe(args, { home, port }) {
    const child = spawn(launcherExec, ['--menubar', '--probe', ...args], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_BOARD_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { stdout: '', stderr: '' };
    child.stdout.on('data', c => { state.stdout += c; });
    child.stderr.on('data', c => { state.stderr += c; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.stdout.removeListener('data', onData);
        reject(new Error(`the probe never printed a first line within 5s:\nstdout: ${state.stdout}\nstderr: ${state.stderr}`));
      }, 5000);
      const onData = () => {
        if (!state.stdout.includes('\n')) return;
        child.stdout.removeListener('data', onData);
        clearTimeout(timer);
        resolve({ ...state, waitForExit: async () => ({ ...(await exited), stdout: state.stdout, stderr: state.stderr }) });
      };
      child.stdout.on('data', onData);
    });
  }

  function openStreamProbe({ home, port, seconds = 5 }) {
    return spawnHeldProbe(['stream', String(seconds)], { home, port });
  }

  /** Ticket 02's own held probe: `--menubar --probe live <seconds>` (`cb_menubar_probe_live`).
   * Same shape as `openStreamProbe` -- resolves once `stream=connected` or `stream=refused`
   * lands, leaving the child alive to observe whatever the caller triggers next. */
  function openLiveProbe({ home, port, seconds = 5 }) {
    return spawnHeldProbe(['live', String(seconds)], { home, port });
  }

  await check("ticket 01: the stream probe holds GET /api/events open and reports a pomodoro settings write pushed while it waits -- not a poll picking it up later", async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const opened = await openStreamProbe({ home: probeHome, port, seconds: 5 });
      assert.equal(opened.stdout.trim(), 'stream=connected', `setup: the probe must connect before this check can mean anything:\n${opened.stdout}\n${opened.stderr}`);

      // The daemon-side change, straight over HTTP and never through the probe itself --
      // the probe's one thread is busy holding the stream open on the very connection
      // that has to observe this write.
      const res = await fetch(`http://127.0.0.1:${port}/api/pomodoro/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({ workMin: 42 }),
      });
      assert.equal(res.status, 200, 'setup: the settings write must land');

      const { code, signal, stdout, stderr } = await opened.waitForExit();
      assert.equal(signal, null, `the probe must exit on its own, never be signalled: ${stderr}`);
      assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
      assert.match(stdout, /^event=pomodoro$/m, `a settings write must reach this probe as a 'pomodoro' event on the stream it already had open, not a timeout:\n${stdout}`);
    });
  });

  await check('ticket 01: a board becoming newly awaited pushes a \'waiting\' event to the same stream', async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const opened = await openStreamProbe({ home: probeHome, port, seconds: 5 });
      assert.equal(opened.stdout.trim(), 'stream=connected');

      await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title: 'ticket 01 waiting push',
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      });

      const { code, stdout, stderr } = await opened.waitForExit();
      assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
      assert.match(stdout, /^event=waiting$/m, `a newly-awaited board must reach this probe as a 'waiting' event:\n${stdout}`);
    });
  });

  await check('ticket 01: with nothing pushed, the probe reports a timeout rather than hanging or inventing an event -- the ablation for the two checks above', async () => {
    // Without this, the two checks above could pass for the wrong reason: a probe that
    // printed `event=pomodoro` unconditionally, having never actually parsed the stream,
    // would satisfy both. This is what proves `event=` is read off the wire and not
    // fabricated -- the same reasoning criterion 9's negative cases carry for the poll.
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      const started = Date.now();
      const state = await probe({ home: probeHome, port, args: ['stream', '1'] });
      assert.equal(state.code, 0, `a timeout is a reported outcome, not a failure: ${state.stderr}`);
      assert.equal(state.stream, 'connected');
      assert.equal(state.event, 'timeout');
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 900, `must actually wait out the window, not return early: ${elapsed}ms`);
      assert.ok(elapsed < 10_000, `must not overrun the window it was given: ${elapsed}ms`);
    });
  });

  await check('ticket 01: an absent daemon is `stream=refused`, promptly, with no event line and no hang', async () => {
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
    const started = Date.now();
    const state = await probe({ home, port, args: ['stream', '5'] });
    assert.equal(state.code, 0);
    assert.equal(state.stream, 'refused');
    assert.equal(state.event, undefined, 'no wait was ever entered, so there is nothing to report about one');
    assert.ok(Date.now() - started < 10_000, 'a connection nothing answers must not be waited out to the stream window');
  });

  // -------------------------------------------------------------------------------------
  // Ticket 02, criteria 1-3: a push reaches the exact state cb_tick draws from and
  // -rebuild lists -- not merely the wire, which ticket 01's checks above already pin.
  // `--menubar --probe live` (cb_menubar_probe_live) exercises the SAME cb_stream_start /
  // cb_poll_once pair the real run loop wires together, with no periodic poll armed in
  // this mode: nothing else could have moved cb_state_*, so a report that differs from
  // the unanswered defaults is proof the push -- and only the push -- did it.
  // -------------------------------------------------------------------------------------

  await check("ticket 02, criterion 1: a pomodoro settings write changes the item's derived state through the stream alone, with no periodic poll armed to have found it another way", async () => {
    const now = Date.now();
    // A running work interval under the OLD 25-minute default, so the arc has a value the
    // push could plausibly disturb: 15 of 25 minutes left is a 0.6 fraction.
    await withDaemon(runningDoc({ phase: 'work', deadline: now + 15 * 60_000, paused: false }, { workMin: 25 }),
      async ({ probeHome, port, secret }) => {
        const opened = await openLiveProbe({ home: probeHome, port, seconds: 5 });
        assert.equal(opened.stdout.trim(), 'stream=connected', `setup: the probe must connect before this check can mean anything:\n${opened.stdout}\n${opened.stderr}`);

        const res = await fetch(`http://127.0.0.1:${port}/api/pomodoro/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
          body: JSON.stringify({ workMin: 30 }),
        });
        assert.equal(res.status, 200, 'setup: the settings write must land');

        const { code, signal, stdout, stderr } = await opened.waitForExit();
        assert.equal(signal, null, `the probe must exit on its own, never be signalled: ${stderr}`);
        assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
        assert.match(stdout, /^live=pushed$/m, `the settings write must be observed as a push, not timed out:\n${stdout}`);
        assert.match(stdout, /\banswered=yes\b/, stdout);
        const fraction = Number((stdout.match(/\bfraction=([\d.]+)\b/) || [])[1]);
        // The interval's own deadline is untouched by a settings write (mergeSettings
        // never retargets a running timer), so 15 minutes remaining against the NEW
        // 30-minute setting is 0.5 -- against the OLD 25-minute one it would still read
        // 0.6, which is what pins this to the pushed settings rather than a coincidence.
        assert.ok(Math.abs(fraction - 0.5) < 0.01, `expected an arc near 0.5 under the newly-pushed 30-minute setting, got ${fraction}`);
      });
  });

  await check("ticket 02, criteria 2 and 3: a board becoming newly awaited reaches the item's cached waiting rows through the stream alone", async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const opened = await openLiveProbe({ home: probeHome, port, seconds: 5 });
      assert.equal(opened.stdout.trim(), 'stream=connected');

      await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title: 'ticket 02 waiting push',
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      });

      const { code, signal, stdout, stderr } = await opened.waitForExit();
      assert.equal(signal, null, `the probe must exit on its own, never be signalled: ${stderr}`);
      assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
      assert.match(stdout, /^live=pushed$/m, `the newly-awaited board must be observed as a push, not timed out:\n${stdout}`);
      // The `waiting` event carries no rows of its own (just a count) -- this is what
      // proves the push triggered a real re-check of GET /api/waiting rather than merely
      // being noticed and dropped.
      assert.match(stdout, /^waiting=1 total=1 more=0$/m, `the fresh row must be in the item's cache by the time the probe exits, not merely available for a poll to find later:\n${stdout}`);
      assert.match(stdout, /^row=ticket 02 waiting push · round 1$/m);
    });
  });

  await check("ticket 02, criterion 2 (the being-answered half): a round being submitted reaches the item's cached waiting rows through the stream alone -- the row disappears, not merely fails to reappear", async () => {
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const posted = await (await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title: 'ticket 02 answered push',
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      })).json();

      // Setup, asserted directly against the daemon rather than through the client under
      // test, and BEFORE the probe below ever opens: there really is one board waiting,
      // so a report of `waiting=0` after the answer is a genuine disappearance and not a
      // client whose cache was simply never populated in the first place. (The probe's
      // own cache starts at zero regardless -- it connects after this board's own
      // `waiting` push already fired, and a stream carries no replay -- which is exactly
      // why this has to be checked here rather than through the probe's report.)
      const waitingBefore = await (await fetch(`http://127.0.0.1:${port}/api/waiting`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      assert.equal(waitingBefore.total, 1, 'setup: the board is awaited before the probe opens');

      const opened = await openLiveProbe({ home: probeHome, port, seconds: 5 });
      assert.equal(opened.stdout.trim(), 'stream=connected');

      const res = await fetch(`http://127.0.0.1:${port}/api/board/${posted.boardId}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({ round: posted.round, action: 'send', answers: [], comments: [] }),
      });
      assert.equal(res.status, 200, 'setup: the submit must land');

      const { code, signal, stdout, stderr } = await opened.waitForExit();
      assert.equal(signal, null, `the probe must exit on its own, never be signalled: ${stderr}`);
      assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
      assert.match(stdout, /^live=pushed$/m, `the answer must be observed as a push, not timed out:\n${stdout}`);
      // handleSubmit broadcasts 'waiting' the same way handlePostBoard does (both call
      // broadcastWaiting), so this is the SAME code path the check above already proved
      // reaches cb_state_waiting -- what's new here is the daemon-reported total actually
      // going back to zero once the round this probe's one push was about is answered.
      assert.match(stdout, /^waiting=0 total=0 more=0$/m, `the row must be gone from the item's cache once the answer's push lands:\n${stdout}`);
      assert.ok(!/^row=/m.test(stdout), `no row may survive the answer:\n${stdout}`);
    });
  });

  await check('ticket 02: with nothing pushed, the live probe reports a timeout rather than a change from nowhere -- the ablation for the two checks above', async () => {
    // Without this, the two checks above could pass for the wrong reason: a probe that
    // reported updated state unconditionally, having never actually wired the stream to
    // cb_poll_once, would satisfy both. This is what proves the report is read off a real
    // push and not fabricated -- the same reasoning ticket 01's own ablation carries.
    await withDaemon(runningDoc(null), async ({ probeHome, port }) => {
      const started = Date.now();
      const state = await probe({ home: probeHome, port, args: ['live', '1'] });
      assert.equal(state.code, 0, `a timeout is a reported outcome, not a failure: ${state.stderr}`);
      assert.equal(state.stream, 'connected');
      assert.equal(state.live, 'timeout');
      assert.equal(state.answered, 'no', 'nothing was ever pushed, so the item never got its first answer');
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 900, `must actually wait out the window, not return early: ${elapsed}ms`);
      assert.ok(elapsed < 10_000, `must not overrun the window it was given: ${elapsed}ms`);
    });
  });

  await check('ticket 02: an absent daemon is `stream=refused` for the live probe too, promptly, with no hang', async () => {
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
    const started = Date.now();
    const state = await probe({ home, port, args: ['live', '5'] });
    assert.equal(state.code, 0);
    assert.equal(state.stream, 'refused');
    assert.equal(state.live, undefined, 'no wait was ever entered, so there is nothing to report about one');
    assert.ok(Date.now() - started < 10_000, 'a connection nothing answers must not be waited out to the push window');
  });

  await check('ticket 02: the poll is untouched -- CB_POLL_S, its queue and cb_poll_once are still exactly what they were', async () => {
    // A structural pin rather than a behavioural one: the spec is explicit that the
    // stream lives BESIDE the existing poll, never in place of it, and ticket 03 needs
    // the poll to still be there to fall back on. The easiest way for that constraint to
    // quietly break is an edit that "simplifies" cb_menubar by folding the poll into the
    // stream -- which would pass every check above (a live daemon always has a stream to
    // push through) while failing ticket 03's whole premise.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    assert.match(source, /static const double CB_POLL_S = 15\.0;/, 'the poll period is untouched');
    assert.match(source, /dispatch_source_create\(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, cb_poll_queue\)/, 'the poll is still a timer source on the poll queue');
    assert.match(source, /dispatch_source_set_event_handler\(poll, \^\{ cb_poll_once\(\); \}\);/, 'the poll still calls cb_poll_once on its own timer');
  });

  // -------------------------------------------------------------------------------------
  // Ticket 03: a dead stream is invisible. Criteria 4-6 -- a daemon killed and restarted
  // recovers with no user action, a drop reconnects without ever showing stale data as
  // fresh, and a stream that is unavailable for any reason leaves the ordinary poll
  // updating the item regardless. The ticket itself says to be ruthless about the last
  // one: prove it by actually preventing the stream from opening, not by reading the code.
  // -------------------------------------------------------------------------------------

  /** A reverse proxy in front of a real daemon that behaves normally for every route except
   * `GET /api/events`, which it refuses outright by destroying the connection the instant
   * the request line arrives -- no response, no 4xx, no hang for the client's own timeout
   * to save it from, just a dead socket, the way a firewall or a daemon that has never
   * heard of this route would look from here. This is what makes criterion 6 checkable for
   * real: everything else (`/api/pomodoro`, `/api/waiting`) is forwarded untouched, so a
   * client behind this proxy has a perfectly healthy POLL and a stream that can never open
   * -- the one combination `--menubar --probe run` (bin/menubar.m) exists to be pointed
   * at. `eventsAttempts` lets a check confirm the client actually TRIED the route it was
   * meant to be refused on, rather than this proving nothing because nobody asked. */
  function startBlockingProxy(targetPort) {
    let eventsAttempts = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/api/events') {
        eventsAttempts++;
        req.socket.destroy();
        return;
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, port: server.address().port, get eventsAttempts() { return eventsAttempts; } });
      });
    });
  }

  await check('ticket 03, structurally: cb_state_answered_at is written in exactly one place -- inside cb_poll_once, on an actual fetch -- so a reconnect or a push can never advance freshness by itself', async () => {
    // Criterion 5 in one grep: the only way this file can make the item look "fresh" is a
    // real fetch landing inside cb_poll_once. A reconnect or a pushed event can only ever
    // ask for one of those (cb_stream_handle_event, and now the reconnect's own catch-up
    // poll) -- neither may touch the timestamp directly, which is what this pins.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    // Excludes the file-scope declaration itself (`static double cb_state_answered_at =
    // 0.0;`), which is a definition with an initializer, not a write against a live item.
    const assignments = (source.match(/^(?!static double).*\bcb_state_answered_at\s*=/gm) || []);
    assert.equal(assignments.length, 1, `expected exactly one write to cb_state_answered_at, found ${assignments.length}:\n${assignments.join('\n')}`);
    const start = source.indexOf('static void cb_poll_once(void) {');
    const end = source.indexOf('static int cb_current_display');
    assert.ok(start > 0 && end > start, 'setup: cb_poll_once must still be findable by name');
    assert.match(source.slice(start, end), /cb_state_answered_at\s*=\s*cb_now_ms\(\);/, 'the one write must be inside cb_poll_once itself');
  });

  await check('ticket 03, criteria 4 and 5: the daemon is killed and restarted on the same port -- the stream reconnects on its own, and the item\'s next report is a REAL fetch of the new daemon rather than the old one replayed', async () => {
    const now = Date.now();
    await withDaemon(runningDoc({ phase: 'work', deadline: now + 20 * 60_000, paused: false }, { workMin: 25 }),
      async ({ daemonHome, probeHome, port, secret, server }) => {
        const opened = await openLiveProbe({ home: probeHome, port, seconds: 10 });
        assert.equal(opened.stdout.trim(), 'stream=connected', `setup: the probe must connect before this check can mean anything:\n${opened.stdout}\n${opened.stderr}`);

        // Kill the daemon the way a crash or a supervised restart does: every fd it held,
        // including the open SSE connection the probe above is on, closes out from under
        // the client -- not a polite server.close(), which would just wait forever for
        // that connection to finish on its own (it never does; that is the whole point of
        // an SSE stream).
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));

        // A beat with nobody on the port at all -- long enough that the client's own first
        // reconnect attempt, if it fired instantly, would find no daemon there, which is
        // exactly the restart window this criterion is about.
        await new Promise(resolve => setTimeout(resolve, 500));

        // Back on the SAME port, with a DIFFERENT document: a report matching THIS one and
        // not the pre-kill one is what proves the reconnect fetched fresh data rather than
        // replaying what the item already had.
        writeDoc(runningDoc({ phase: 'break', deadline: Date.now() + 3 * 60_000, paused: false }, { breakMin: 5 }), daemonHome);
        const restarted = await startServer({ home: daemonHome, port, secret });
        try {
          const { code, signal, stdout, stderr } = await opened.waitForExit();
          assert.equal(signal, null, `the probe must exit on its own, never be signalled: ${stderr}`);
          assert.equal(code, 0, `the probe must report success:\n${stdout}\n${stderr}`);
          assert.match(stdout, /^live=pushed$/m, `the reconnect after a daemon restart must be observed as a push, not a timeout:\n${stdout}`);
          assert.match(stdout, /\banswered=yes\b/, stdout);
          assert.match(stdout, /\bphase=break\b/, `the report must reflect the RESTARTED daemon's own document, not the one from before the kill:\n${stdout}`);
        } finally {
          await new Promise(resolve => restarted.server.close(resolve));
        }
      });
  });

  await check('ticket 03, criterion 6: with GET /api/events refused outright, the item still updates on the ordinary poll -- proven by actually breaking the route, not by reading the code', async () => {
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 10 * 60_000, paused: false }), async ({ probeHome, port }) => {
      const proxy = await startBlockingProxy(port);
      try {
        const state = await probe({ home: probeHome, port: proxy.port, args: ['run', '5'] });
        assert.equal(state.code, 0, `run must report, not crash: ${state.stderr}`);
        assert.equal(state.run, 'polled', `the periodic poll must land within the window even though the stream can never open:\n${state.stdout}\n${state.stderr}`);
        assert.equal(state.answered, 'yes');
        assert.equal(state.phase, 'work');
        assert.ok(proxy.eventsAttempts >= 1, 'setup: the client must actually have tried GET /api/events for this to prove anything');
      } finally {
        await new Promise(resolve => proxy.server.close(resolve));
      }
    });
  });

  await check('ticket 03, criterion 6 ablation: an entirely absent daemon is `run=timeout answered=no`, not a fabricated poll -- the ablation for the check above', async () => {
    // Without this, the check above could pass for the wrong reason: a `run` mode that
    // printed `run=polled answered=yes` unconditionally, having never actually wired the
    // real poll in, would satisfy it just as well. Same reasoning every other ablation in
    // this file carries.
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
    const started = Date.now();
    const state = await probe({ home, port, args: ['run', '3'] });
    assert.equal(state.code, 0);
    assert.equal(state.run, 'timeout');
    assert.equal(state.answered, 'no', 'nothing ever answered, so the item never got its first answer');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 * 3, `must actually wait out the window, not return early: ${elapsed}ms`);
    assert.ok(elapsed < 15_000, `must not overrun the window it was given: ${elapsed}ms`);
  });

  await check('ticket 03: a stream that cannot connect backs off rather than hammering the port -- a bounded, growing-interval retry, not a tight loop', async () => {
    // A bare TCP stand-in, not an HTTP one: every connection this process makes to open
    // `GET /api/events` shows up as a `connection` event here regardless of what it sends,
    // and destroying the socket at once (never answering) is what forces a fast, repeated
    // failure -- the shape a reconnect-with-backoff has to survive without spinning.
    const attempts = [];
    const { createServer } = await import('node:net');
    const stub = createServer(socket => {
      attempts.push(Date.now());
      socket.destroy();
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    const port = stub.address().port;
    const home = makeProbeHome(randomBytes(32).toString('hex'));
    try {
      // `live` alone: it arms no periodic poll of its own, so every connection this stand-in
      // sees is the STREAM's own reconnect and nothing else. Its first wait is hardcoded to
      // CB_REQUEST_TIMEOUT_S (5s) regardless of the argument here, which is what bounds this
      // check without needing a longer-lived probe mode.
      await probe({ home, port, args: ['live', '1'] });

      // Measured: NSURLSession makes more than one raw TCP connection per LOGICAL attempt
      // against a peer that resets instantly (three, consistently, on this stack) -- not
      // this file's own retry loop, which only ever calls cb_stream_start once per backoff
      // wait. So it is CLUSTER boundaries -- attempts more than 200ms apart -- that reflect
      // this file's own schedule; folding anything closer than that into one cluster is
      // what keeps this check about OUR backoff instead of the platform's own connection
      // handling underneath it.
      const clusters = [];
      for (const t of attempts) {
        if (clusters.length === 0 || t - clusters[clusters.length - 1] > 200) clusters.push(t);
      }
      assert.ok(clusters.length >= 2, `must actually retry, not give up after the first failure: ${clusters.length} attempt(s), raw=${attempts.length}`);
      const gaps = clusters.slice(1).map((t, i) => t - clusters[i]);
      assert.ok(gaps.every(g => g >= 400), `must not hammer the port -- retries must be spaced out, not immediate: gaps ${gaps.join(',')}ms`);
      if (gaps.length >= 2) {
        assert.ok(gaps[gaps.length - 1] > gaps[0] * 1.3, `the interval between retries must grow, not stay constant: gaps ${gaps.join(',')}ms`);
      }
    } finally {
      stub.close();
    }
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
