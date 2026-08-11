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
// at all; `--menubar --probe url <candidate>` runs the board-URL validator alone;
// `--menubar --probe open <candidate>` runs ADR 93's decision -- raise the tab a board is
// already open in, or open one -- against the real browsers on this machine with a stubbed
// osascript; and `--menubar --probe icons` reports the bounding box of each icon the
// popover draws, which is the one observable the SVG path-data walker has. The popover's
// rows are printed by the
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
// And one criterion belonging to a different spec entirely, because this is the only place
// bin/notify.m and bin/menubar.m are both genuinely compiled: "a Banner click for a board
// already open in a scriptable browser raises that tab and opens no duplicate", and its
// twin for a waiting row. Both surfaces make one call into one C function, so one seam
// covers both -- see the ADR 93 section far below for what that seam does and does not
// reach.
//
// Two later decisions are pinned here as well. ADR 88 narrows ADR 83: the menu bar TITLE
// stays empty while paused and the glyph keeps its paused shape (ADR 83's own point,
// untouched), but the popover's status LINE no longer drops to the phase name alone --
// it mirrors the index page's own line (renderPomodoro, src/indexpage.mjs), cycle
// position and countdown included, with "(paused)" named at the end. ADR 84, one signal
// one dimension: the tomato silhouette in every state, a ring for time remaining, one
// flat bar for a break, two vertical bars for paused, and opacity meaning only that the
// daemon has gone quiet. Those live on `cb_display` as `ring` and `mark` FOR THIS REASON
// -- a decision the derivation records is checkable, and a condition rediscovered inside
// the drawing code is not.
//
// The popover's own row set is the same story one step further. Its words are all reported
// (`status`, `stateword`, `caption`, `row`), so "the word paused appears in exactly the two
// places ADR 88 leaves it" is a behavioural assertion rather than a screenshot; and every
// glyph it draws is a byte copy of src/pomodoro-widget.mjs's, so "no glyph is invented for
// this surface" is a comparison of two files rather than a promise.
//
// The arrangement used to be entirely uncheckable -- which row is above which, that the
// gear is on the right, that a waiting row has no bezel -- and criterion 13 closes the
// first two of those. `--menubar --probe layout` builds -rebuild's OWN row/stack
// construction (never a second copy that could quietly drift from what ships -- see
// -buildContentWithDisplay:waiting: in bin/menubar.m), forces Auto Layout to resolve it
// with no NSApplication anywhere near it, and prints every arranged subview's resolved
// frame, its class, and which row each named control actually sits in (`rowindex=`). So
// the checks below assert, from real numbers rather than a screenshot: every row spans
// the PANEL's own known content width (not merely agrees with its siblings, which a fault
// that moves every row together would still do); the panel's documented row order and
// kind (a status row, a control row, a divider, a caption, in that order); that the gear
// and the switch specifically -- not whichever control happens to be in a well-formed row
// -- are the ones in the status row, and the forward button in the control row; that the
// gear's and the forward button's right edges sit at the panel's own right content edge,
// including under the longest status string cb_status_label ever produces; and that a
// waiting row (and the overflow row) spans the panel too. What remains uncheckable:
// whether any of it is legible, keyboard-reachable or correct in dark mode, and whether a
// waiting row's bezel is really absent on screen.
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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { defaultDoc, writeDoc, pomodoroDay, formatCountdown } from '../src/pomodoro.mjs';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { renderIndexPage, indexScript } from '../src/indexpage.mjs';
import { parseHTML } from './dom-stand-in.mjs';

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

// --- the osascript stub, and why the compiled-in PATH is the seam that reaches it -------
//
// ADR 93 has a board-opening click ask the scriptable browsers whether one of them is
// already showing that board, through `osascript`, which bin/launcher.c resolves against
// the launcher's COMPILED-IN PATH rather than against the environment (install.sh's
// LAUNCHER_CHILD_PATH -- an inherited PATH would let anything that can rewrite the
// world-writable plist choose what runs when a banner is clicked).
//
// That closes the usual stubbing door: no `PATH=` in front of a spawn can reach a real
// bundle. It opens a better one here, because this file COMPILES ITS OWN BINARY -- so the
// header below points the compiled-in PATH at a directory this check owns, and the
// `osascript` in it is the one the binary under test finds. Nothing else in this file
// spawns anything through that PATH (the supervising path is never run here), so pointing
// it at a stub dir costs no other check anything.
//
// The stub answers from a FILE beside itself rather than from its environment, and takes
// its interpreter by absolute path in the shebang, for one reason each: bin/launcher.c
// hands the script a two-variable environment it builds itself (PATH and HOME, both
// compiled in), so neither an env var nor `#!/usr/bin/env node` can reach it.
const stubDir = path.join(workDir, 'stub-bin');
mkdirSync(stubDir, { recursive: true });
const osascriptStub = path.join(stubDir, 'osascript');
const osascriptLog = path.join(stubDir, 'log');
const osascriptAnswer = path.join(stubDir, 'answer');
writeFileSync(osascriptStub, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(process.argv[1]);
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const answer = fs.existsSync(path.join(dir, 'answer'))
  ? fs.readFileSync(path.join(dir, 'answer'), 'utf8').trim()
  : 'none';
// 'fail' is an osascript that ran and refused -- a denied Automation grant, a browser that
// went away mid-script. 'slow' is one that answers, late: proof the caller polls for an
// answer rather than assuming the first read is the whole of it.
if (answer === 'fail') process.exit(3);
if (answer === 'slow') {
  setTimeout(() => { process.stdout.write('none\\n'); }, 700);
} else {
  process.stdout.write(answer + '\\n');
}
`);
chmodSync(osascriptStub, 0o755);

writeFileSync(path.join(headerDir, 'launcher_paths.h'), [
  `#define CLAUDE_BOARD_NODE "${cEscape(process.execPath)}"`,
  `#define CLAUDE_BOARD_DAEMON "${cEscape(path.join(workDir, 'never-run.mjs'))}"`,
  `#define CLAUDE_BOARD_HOME_DIR "${cEscape(path.join(workDir, 'never-used-home'))}"`,
  `#define CLAUDE_BOARD_PATH "${cEscape(stubDir)}"`,
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

// --- a browser that is running, and nothing else about it ---------------------------------
//
// ADR 93's gate is "only browsers already running are asked", and bin/launcher.c decides
// that by looking for a process with the browser's own executable name -- so the way to
// make a browser running, for a check, is to run a process with that name. This compiles
// one: it does nothing, holds no window, and exists only to carry its filename into the
// process table.
//
// That is the whole seam, and it is a real one rather than a stub: no env var, no
// compile-time switch, nothing in bin/launcher.c that only exists for a test. What the
// checks below assert is a SET COMPARISON -- the browsers consulted against the table
// browsers actually running, computed independently here from `ps` -- which is what keeps
// them honest on a reader's machine with Safari and Chrome open, where a check that
// asserted an exact log would be flaky and one that asserted nothing would be worthless.
const sleeperSrc = path.join(workDir, 'sleeper.c');
writeFileSync(sleeperSrc, '#include <unistd.h>\nint main(void) { for (;;) pause(); return 0; }\n');
const fakeAppDir = path.join(workDir, 'fake-apps');
mkdirSync(fakeAppDir, { recursive: true });

/** Every table browser in bin/launcher.c's BROWSERS, read out of its own bytes so this
 * list cannot drift from the shipped one, paired with the dialect the file assigns it. */
function browserTable() {
  const c = readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8');
  const start = c.indexOf('} BROWSERS[] = {');
  const end = c.indexOf('};', start);
  assert.ok(start > 0 && end > start, 'setup: bin/launcher.c must still declare a BROWSERS table');
  return [...c.slice(start, end).matchAll(/\{\s*"([^"]+)",\s*"([^"]+)",\s*([01])\s*\}/g)]
    .map(m => ({ process: m[1], app: m[2], chromium: m[3] === '1' }));
}

/** Which of them are running RIGHT NOW, named the way the script addresses them. */
function runningBrowsers() {
  const names = processNames();
  return browserTable().filter(b => names.has(b.process)).map(b => b.app).sort();
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
  const state = { elapsedMs: Date.now() - started, code, signal, stderr, stdout, rows: [], icons: [], frames: {}, rowIndex: {} };
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
    // `--menubar --probe layout` (criterion 13): one `frame=<name> x=.. y=.. w=.. h=..
    // [class=..]` line per view -- `row0`, `row1`, … for the vertical stack's own
    // arranged subviews in order (each carrying a trailing `class=`, the row's own
    // Objective-C class name), and named lines (`glyph`, `gear`, `forward`, …) for the
    // specific controls criteria 2 and 3 are about. Every `.frame` in AppKit is relative
    // to the view's OWN superview, never to the panel -- bin/menubar.m's own comment on
    // the seam says so -- so `gear`/`forward`'s x/y are relative to their ROW, not to the
    // panel, and the checks below read them that way rather than assuming one shared
    // coordinate space. `class` is kept as a string; every other field is a number.
    if (line.startsWith('frame=')) {
      const [nameToken, ...rest] = line.split(' ');
      const name = nameToken.slice(6);
      const frame = {};
      for (const pair of rest) {
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const key = pair.slice(0, at);
        const value = pair.slice(at + 1);
        frame[key] = key === 'class' ? value : Number(value);
      }
      state.frames[name] = frame;
      continue;
    }
    // `rowindex=<name> <N>` (criterion 13): which top-level row (an index into `row0`,
    // `row1`, …) actually holds the named control -- see cb_row_index_of's own comment
    // for why a frame alone cannot answer "which row", only "flush with A row".
    if (line.startsWith('rowindex=')) {
      const [nameToken, indexToken] = line.split(' ');
      state.rowIndex[nameToken.slice(9)] = Number(indexToken);
      continue;
    }
    if (line.startsWith('row=')) state.rows.push(line.slice(4));
    else if (line.startsWith('morerow=')) state.morerow = line.slice(8);
    else if (line.startsWith('caption=')) state.caption = line.slice(8);
    else if (line.startsWith('status=')) state.status = line.slice(7);
    else if (line.startsWith('url=')) state.url = line.slice(4);
    // `--menubar --probe open` (ADR 93): `open=raised|opened|refused` -- see the branch's
    // own comment in bin/menubar.m for why `opened` is a decision rather than an open.
    else if (line.startsWith('open=')) state.open = line.slice(5);
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

// --- reading the stub osascript back -----------------------------------------------------

/** What the stub is to answer for the next probe, and a fresh log to read it against.
 * `raised` and `none` are the two things a real script returns; `fail` is a nonzero exit
 * (a denied Automation grant); `slow` answers `none` after a beat. */
function armOsascript(answer) {
  writeFileSync(osascriptAnswer, `${answer}\n`);
  rmSync(osascriptLog, { force: true });
}

/** Every osascript invocation since the last `armOsascript`, as what it was actually asked:
 * which application, which dialect, and the URL the script matches tabs against. Read out
 * of the script text rather than out of a side channel, because the script text IS what
 * crosses to the browser -- a check that trusted a summary line could not catch a URL
 * spliced in wrong. */
function osascriptCalls() {
  if (!existsSync(osascriptLog)) return [];
  return readFileSync(osascriptLog, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const argv = JSON.parse(line);
    assert.equal(argv[0], '-e', `osascript must be handed one -e script, got ${JSON.stringify(argv)}`);
    const script = argv[1];
    const app = (script.match(/^if application "([^"]+)" is not running then return "none"$/m) || [])[1];
    const base = (script.match(/^set b to "([^"]*)"$/m) || [])[1];
    return {
      argv,
      script,
      app,
      base,
      // The one line that differs between the dialects, and the one that would raise the
      // wrong thing if a browser were given the other file's script.
      dialect: /^set active tab index of w to n$/m.test(script) ? 'chromium'
        : /^set current tab of w to t$/m.test(script) ? 'safari' : 'unknown',
    };
  });
}

/** Every process name on this machine right now, by the accounting name `ps -c` prints --
 * which is the same name proc_name reports and the same one bin/launcher.c matches on. */
function processNames() {
  const ps = spawnSync('ps', ['-Ac', '-o', 'comm='], { encoding: 'utf8' });
  return new Set((ps.stdout || '').split('\n').map(s => s.trim()));
}

/** Runs `fn` with a process named `name` on the machine, so bin/launcher.c's "is this
 * browser running" scan finds one. Killed on the way out however `fn` ends -- a leaked
 * process named after a browser would poison every later check in this file. */
async function withProcessNamed(name, fn) {
  const exe = path.join(fakeAppDir, name);
  const built = spawnSync(ccCmd, ['-O2', '-o', exe, sleeperSrc], { encoding: 'utf8' });
  assert.equal(built.status, 0, `setup: the stand-in browser must compile:\n${built.stderr}`);
  const child = spawn(exe, [], { stdio: 'ignore' });
  try {
    // A process carries its own name only once it has actually exec'd.
    for (let i = 0; i < 100 && !processNames().has(name); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(processNames().has(name), `setup: a process named ${name} must be running for this check to mean anything`);
    await fn();
  } finally {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  }
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

// -----------------------------------------------------------------------------------------
// Criterion 13's ground truth: the panel's own numbers, and why they are hardcoded here
// rather than read back from anything the build under test produces.
// -----------------------------------------------------------------------------------------

/** bin/menubar.m's own `CB_POPOVER_W` and the 14pt left/right of its `stack.edgeInsets`
 * literal (`NSEdgeInsetsMake(12.0, 14.0, 12.0, 14.0)`) -- hardcoded independently here,
 * never read back from the running probe or parsed out of bin/menubar.m's own source.
 *
 * That distinction is the whole point of these two constants. A fault that only ever
 * removes the constraint pinning the vertical stack to its content view
 * (bin/menubar.m:2311-2312, confirmed by review) leaves every row still perfectly
 * self-consistent with its SIBLINGS -- x=14 w=151 instead of x=14 w=236, every row
 * agreeing with every other row -- and invisible to any check that only ever compares
 * rows against each other. Reading `CB_POPOVER_W` (or the inset) out of bin/menubar.m's
 * own text at test time would not help either: the same source edit that breaks the
 * layout could just as easily be the one that changes the number this file would then
 * read back and trust. The only check that catches "the panel shrank" is one that knows,
 * independently, what the panel's content width is supposed to be. */
const PANEL_WIDTH = 264;
const PANEL_INSET = 14;

/** Every frame in `rows` must span the panel's own content width -- x === PANEL_INSET,
 * x + w === PANEL_WIDTH - PANEL_INSET -- not merely agree with its siblings (see
 * PANEL_WIDTH's own comment for why that distinction matters). `tolerance` defaults to a
 * few points: QUIRKS.md's "Auto Layout resolves off-window, but `.frame` and the
 * constraint it satisfies can disagree by a few points" entry measured a plain
 * NSTextField's alignment rect (what a leading/trailing constraint actually pins) sitting
 * a couple of points OUTSIDE its own paint frame on each side, so the waiting caption
 * reads a few points WIDER and starting further LEFT than an NSStackView or NSBox row
 * even once every row is correctly pinned to the panel's own content edges. The fault
 * this check exists to catch moves rows by TENS of points (measured, before this ticket:
 * a 264pt panel's own rows landed as far apart as x=14 and x=153), so a few points of
 * slack loses none of the check's power to catch it. */
function assertRowsSpanPanel(rows, label, tolerance = 3) {
  const left = PANEL_INSET;
  const right = PANEL_WIDTH - PANEL_INSET;
  rows.forEach((row, i) => {
    assert.ok(Math.abs(row.x - left) <= tolerance,
      `${label} ${i}: left edge ${row.x} != the panel's own ${left} -- a row that has drifted off the panel's content edge, however self-consistent with its siblings, is exactly the fault this exists to catch`);
    assert.ok(Math.abs((row.x + row.w) - right) <= tolerance,
      `${label} ${i}: right edge ${row.x + row.w} != the panel's own ${right}`);
  });
}

// -----------------------------------------------------------------------------------------
// The two surfaces, compared rather than each pinned to a hand copy.
// -----------------------------------------------------------------------------------------

/** Loads the REAL `renderIndexPage()` markup and runs the REAL `indexScript` against it,
 * with `fetch` rewritten to reach the given daemon over real HTTP, authorised the way a
 * genuine browser tab is -- a session cookie, never the native secret header `probe()`
 * above uses. Pattern-matched off test/check-pomodoro-page.mjs's own
 * `loadIndexAgainstDaemon`, narrowed to the one element this file needs
 * (`#pomodoro-status`); the settings-panel and SSE-stream halves that file already covers
 * are none of this chunk's business.
 *
 * This is what makes criteria 4-6 checkable as a comparison rather than a hand copy. ADR
 * 88 says the popover's status line is "the index page's own string, in every state" --
 * and a check that pins BOTH surfaces to a THIRD, hand-typed reproduction of
 * pomodoroCyclePosition's formula cannot catch the two drifting apart from each other,
 * which is exactly how a popover that said "Short break" where the index page said
 * "Break" reached this suite unnoticed (both sides of that check agreed with themselves).
 * Running the actual client script closes that gap: whatever `renderPomodoro` computes IS
 * what the reader's index tab shows, not a reconstruction of what it is believed to
 * compute. */
const REAL_FETCH = globalThis.fetch;
function loadIndexAgainstDaemon(port, secret) {
  const document = parseHTML(renderIndexPage({ threads: [] }));
  const cookie = `${SESSION_COOKIE}=${sessionToken(secret)}`;
  globalThis.fetch = (url, opts) =>
    REAL_FETCH(`http://127.0.0.1:${port}${url}`, { ...opts, headers: { ...(opts && opts.headers), cookie } });
  // No interval is ever fired: fetchPomodoro().then(renderPomodoro) runs once,
  // unconditionally, at script init (src/indexpage.mjs:1111) -- before either
  // setInterval(tickPomodoro, ...) or setInterval(fetchPomodoro, POMODORO_POLL_MS) is
  // even registered -- so a stub that never calls back is enough to read the first real
  // render. 'EventSource' is declared and never passed, the same reason
  // test/check-pomodoro-page.mjs leaves it unbound: this harness has no live stream to
  // open, and an unflagged Node would otherwise hand initIndexStream a real constructor.
  new Function('document', 'setInterval', 'window', 'location', 'EventSource', indexScript)(
    document, () => 0, document.defaultView, { hash: '' });
  return {
    /** Waits out the real network round trip (a stubbed microtask would prove nothing
     * about the actual fetch/render this check is here to observe) and reads back
     * #pomodoro-status's own textContent -- 50ms, the same generous, still-fast margin
     * test/check-pomodoro-page.mjs's own flush() uses. */
    async statusText() {
      await new Promise(resolve => setTimeout(resolve, 50));
      const status = document.querySelector('span#pomodoro-status');
      return status ? status.textContent : null;
    },
    restoreFetch() { globalThis.fetch = REAL_FETCH; },
  };
}

/** Split a status line into the half that has to match ACROSS the two surfaces exactly and
 * the countdown that cannot.
 *
 * The two surfaces are two processes reading the same running deadline at two different
 * instants -- a spawned probe, then a real HTTP round trip and a 50ms settle -- so their
 * countdowns are computed from two different `now`s. `formatCountdown` rounds to the
 * nearest second, so any gap at all can land the two on different sides of a rounding
 * boundary, and a gap of a second or more (which is what four checks running at once
 * costs) puts them a whole second apart every time. Compared with a strict equal, that is
 * a flake at rest and a PERSISTENT failure under load -- a check that fails for a reason
 * it was never about, on a suite whose whole value is that green means something.
 *
 * What it is about survives intact here: the phase word, the cycle position, the
 * separator, the "(paused)" suffix and the shape of the countdown are all in `fixed` and
 * still compared exactly (that is the half a real divergence -- "Short break" against
 * "Break" -- lives in), and the countdown itself is compared as a NUMBER against the gap
 * the caller actually measured. */
function splitStatusLine(text) {
  const match = /^(.*·\s)(\d+):(\d{2})(.*)$/.exec(text || '');
  if (!match) return { fixed: text, seconds: null };
  return {
    fixed: `${match[1]}<countdown>${match[4]}`,
    seconds: Number(match[2]) * 60 + Number(match[3]),
  };
}

/** `spanMs` is the real wall-clock time between the two readings, so the tolerance is
 * whatever the machine actually cost rather than a constant chosen on an idle one. Plus
 * one second for the rounding boundary the two are allowed to fall either side of. */
function assertSameStatusLine(popoverText, indexText, spanMs, label) {
  const popover = splitStatusLine(popoverText);
  const index = splitStatusLine(indexText);
  assert.equal(popover.fixed, index.fixed,
    `${label}: popover said ${JSON.stringify(popoverText)}, the index page said ${JSON.stringify(indexText)}`);
  if (popover.seconds === null || index.seconds === null) return;
  const slack = Math.ceil(spanMs / 1000) + 1;
  assert.ok(Math.abs(popover.seconds - index.seconds) <= slack,
    `${label}: the two countdowns are ${Math.abs(popover.seconds - index.seconds)}s apart, more than the ${slack}s that separated the two readings -- ` +
    `popover ${JSON.stringify(popoverText)}, index ${JSON.stringify(indexText)}`);
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

  await check('criterion 3: a break\'s fraction is measured against breakMin, not against the work length', async () => {
    // A break draws no ring, so this fraction reaches no pixel -- it pins the phase-to-
    // duration mapping itself, which the digits and any future reader of `fraction` share,
    // and it is the check that would notice cb_phase_length_ms losing the break case.
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

  await check('ADR 88 narrows ADR 83: "paused" is named in EXACTLY the two places it leaves it -- the status line\'s own "(paused)" and the word beside the switch -- and nowhere else', async () => {
    // Every word the popover shows is reported by the probe: the status line, the switch's
    // state word, the waiting caption and each waiting row. So "exactly two" is countable
    // rather than a thing to eyeball, which is the only reason it is a check at all.
    //
    // Two, not the one ADR 83 originally named: the status line used to drop the word
    // entirely (ADR 83's own point, a fact that must not be stated twice) and now mirrors
    // the index page's own line instead, which names the state itself. A reader with the
    // index page open in another window already reads "paused" there beside the same
    // frozen countdown, so saying it once more here is not the duplication ADR 83 was
    // refusing -- it is two different controls each naming the state they are next to.
    // Occurrences of the WORD, not rows containing it: "exactly two" is a claim about how
    // many times a reader's eye lands on it.
    const wordsOf = state => [state.status, state.stateword, state.caption, ...state.rows];
    const countPaused = state => (wordsOf(state).join(' ').match(/paused/gi) || []).length;

    for (const phase of ['work', 'break', 'longBreak']) {
      await withDaemon(runningDoc({ phase, paused: true, remainingMs: 90_000 }),
        async ({ probeHome, port }) => {
          const state = await probe({ home: probeHome, port });
          assert.equal(state.stateword, 'Paused', `a paused ${phase} says so beside the switch`);
          assert.match(state.status, /\(paused\)$/, `and again, at the end of its own sentence: ${state.status}`);
          assert.equal(countPaused(state), 2,
            `and in exactly those two places, nowhere else: ${JSON.stringify(wordsOf(state))}`);
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

  // -------------------------------------------------------------------------------------
  // ADR 88: the popover's status line is "the index page's own string, in every state" --
  // checked here by running the REAL index page against the SAME daemon and comparing,
  // never by pinning both surfaces to a hand-typed reproduction of
  // pomodoroCyclePosition's formula (loadIndexAgainstDaemon's own comment says why that
  // third copy is exactly how a real divergence -- 'Short break' vs 'Break' -- once
  // reached this suite unnoticed).
  // -------------------------------------------------------------------------------------

  await check('the cross-surface comparison tolerates the gap between two readings and NOTHING else -- a divergence in any word still fails', () => {
    // The comparison below is the one place in this file where two independently produced
    // strings are held against each other, and it was a strict equal across two instants
    // that round differently -- a flake at rest and a persistent failure under a loaded
    // suite. The tolerance it grew is the reason to pin what it will and will not accept
    // here, in four lines, rather than trust that a future "simplification" of
    // assertSameStatusLine keeps its reach: a whole second of clock is forgiven, and every
    // other difference is still a failure. Otherwise the flake fix quietly becomes the
    // coverage loss it was meant to avoid.
    assertSameStatusLine('Work 1/4 · 07:30', 'Work 1/4 · 07:29', 1_100, 'a second of real gap');
    assert.throws(() => assertSameStatusLine('Break · 03:00', 'Long break · 03:00', 1_100, 'a phase word'),
      /Break/, 'a divergent phase word is exactly what this comparison exists to catch');
    assert.throws(() => assertSameStatusLine('Work 1/4 · 07:30', 'Work 2/4 · 07:30', 1_100, 'a position'),
      /1\/4/, 'and so is a divergent cycle position');
    assert.throws(() => assertSameStatusLine('Work 1/4 · 07:30', 'Work 1/4 · 07:30 (paused)', 1_100, 'a suffix'),
      /paused/, 'and a suffix one surface names and the other does not');
    assert.throws(() => assertSameStatusLine('Work 1/4 · 07:30', 'Work 1/4 · 06:30', 1_100, 'a real drift'),
      /apart/, 'a minute of drift is a real disagreement, not the gap between two readings');
  });

  await check('criteria 4 and 6: a running phase\'s popover status line is the SAME string the real index page renders from the same daemon', async () => {
    // Idle is compared like any other state. It used to be carved out: the index page
    // said "Idle (25 min)" where the popover said "Idle", and the gap was an open
    // question. The PM closed it toward the popover -- a duration that is not counting
    // down reads as a countdown that has stopped -- so there is nothing left to exempt.
    // The literal 'Idle' is pinned as well as compared, so the two surfaces cannot drift
    // together into some third string and still agree with each other.
    const now = Date.now();
    for (const [phase, deadline] of [
      [null, null],
      ['work', now + 7 * 60_000 + 30_000],
      ['break', now + 3 * 60_000],
      ['longBreak', now + 9 * 60_000],
    ]) {
      const doc = phase === null ? runningDoc(null) : runningDoc({ phase, deadline, paused: false });
      await withDaemon(doc, async ({ probeHome, port, secret }) => {
        // Both readings are timed, because the running countdown inside these two strings
        // is read at two different instants and the tolerance is that gap -- see
        // assertSameStatusLine for why a strict equal here is a persistent failure under
        // a loaded suite rather than an occasional flake.
        const readingsStartedAt = Date.now();
        const popoverState = await probe({ home: probeHome, port });
        const tab = loadIndexAgainstDaemon(port, secret);
        try {
          const indexText = await tab.statusText();
          const spanMs = Date.now() - readingsStartedAt;
          assert.ok(indexText, `setup: the index page must render a status text for phase ${phase}`);
          assertSameStatusLine(popoverState.status, indexText, spanMs, `phase ${phase}`);
          if (phase === null) {
            assert.equal(indexText, 'Idle',
              'an absent timer is the bare word on both surfaces -- no duration, since nothing is counting down');
          }
        } finally {
          tab.restoreFetch();
        }
      });
    }
    // Criterion 6, asserted directly against the ground truth rather than inferred from
    // the comparison above: a long break carries no cycle position AT ALL on the real
    // index page, full stop -- so the popover cannot be agreeing with it by both having
    // dropped the position the same wrong way.
    await withDaemon(runningDoc({ phase: 'longBreak', deadline: now + 9 * 60_000, paused: false }),
      async ({ probeHome, port, secret }) => {
        const tab = loadIndexAgainstDaemon(port, secret);
        try {
          const indexText = await tab.statusText();
          assert.doesNotMatch(indexText, /\d+\/\d+/, `the index page's own long break line must carry no position: ${JSON.stringify(indexText)}`);
          assert.match(indexText, /^Long break/, `and must still name the phase: ${JSON.stringify(indexText)}`);
        } finally {
          tab.restoreFetch();
        }
      });
  });

  await check('criterion 5: a paused interval\'s popover status line is the SAME string the real index page renders, and criterion 7 keeps the menu bar digits empty regardless', async () => {
    for (const phase of ['work', 'break', 'longBreak']) {
      await withDaemon(runningDoc({ phase, paused: true, remainingMs: 90_000 }),
        async ({ probeHome, port, secret }) => {
          const popoverState = await probe({ home: probeHome, port });
          const tab = loadIndexAgainstDaemon(port, secret);
          try {
            const indexText = await tab.statusText();
            assert.ok(indexText, `setup: the index page must render a status text for a paused ${phase}`);
            assert.match(indexText, /\(paused\)$/, `setup: the index page's own paused line must name the state too: ${JSON.stringify(indexText)}`);
            // STRICT here, unlike the running comparison above, and deliberately so: a
            // paused timer carries a frozen `remainingMs` rather than a deadline, so both
            // surfaces render the same number no matter how far apart they read it. There
            // is no gap to tolerate, so tolerating one would only lose a whole second of
            // this check's reach.
            assert.equal(popoverState.status, indexText,
              `a paused ${phase}: popover said ${JSON.stringify(popoverState.status)}, the index page said ${JSON.stringify(indexText)}`);
            // Criterion 7, unaffected by any of the above: the menu bar TITLE (the digits
            // beside the icon) still empties while paused -- a display decision entirely
            // separate from the popover's own status line, which is why resume can put the
            // title's digits straight back with no refetch while the popover shows them the
            // whole time regardless.
            assert.equal(popoverState.countdown, 'no', 'criterion 7: the menu bar digits still empty while paused');
          } finally {
            tab.restoreFetch();
          }
        });
    }
    // The countdown comes back the moment it is running again, so the checks above are
    // pinning "paused" rather than a countdown that quietly stopped being computed.
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 90_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.countdown, 'yes');
        assert.match(state.status, /^Work \d+\/\d+ · \d{2}:\d{2}$/, 'a running phase keeps its time and position');
      });
  });

  // -------------------------------------------------------------------------------------
  // Criterion 13: the popover's arrangement, through `--menubar --probe layout`.
  //
  // Every `.frame` AppKit hands back is relative to the view's OWN superview, never to the
  // panel -- an ordinary NSView fact, not a quirk of this seam -- so a control nested inside
  // one of the popover's horizontal rows (the gear, the switch, the forward button) reports
  // ROW-relative coordinates, and a top-level row (`row0`, `row1`, …, the vertical stack's
  // own arranged subviews) reports PANEL-relative ones. The checks below read each frame in
  // whichever space it actually came in rather than assuming one shared origin.
  //
  // Two things a first pass at this seam got wrong, both found on review and fixed here:
  //
  //   - Rows were only ever compared to EACH OTHER, never against the panel's own known
  //     numbers (PANEL_WIDTH/PANEL_INSET, above). A fault that moves or shrinks every row
  //     TOGETHER -- measured: dropping the constraint pinning the vertical stack to its
  //     content view leaves every row at a consistent x=14 w=151 instead of w=236, still
  //     perfectly agreeing with each other -- was invisible to that comparison. Every row
  //     check below goes through assertRowsSpanPanel, against the panel's own numbers.
  //   - A control's ROW-relative frame proves it is flush with the trailing edge of
  //     WHATEVER row holds it, not that it is in the RIGHT row -- every row is the same
  //     width, so a fault that swaps the status and control rows, or puts the gear in the
  //     control row and the forward button in the status row, produces identical-looking
  //     "flush with my row" frames. `state.rowIndex` (from the probe's own `rowindex=`
  //     lines) is the fact that is not relative to anything else that could have moved,
  //     and the checks below pin controls to a SPECIFIC row index, not merely a
  //     well-formed one.
  //
  // The tolerance QUIRKS.md's "Auto Layout resolves off-window..." entry explains: a plain
  // NSTextField's alignment rect (what a leading/trailing constraint actually pins) sits a
  // couple of points OUTSIDE its own paint frame on each side, so the waiting caption reads
  // a few points WIDER and starting further LEFT than an NSStackView or NSBox row even once
  // every row is correctly pinned to the panel's own content edges. The fault this seam
  // exists to catch moves rows by TENS of points (measured, before this ticket: a 264pt
  // panel's own rows landed as far apart as x=14 and x=153), so a few points of slack loses
  // none of the check's power to catch it.
  // -------------------------------------------------------------------------------------

  await check('criterion 1 and 13: every popover row -- the status row, the control row, the divider, the waiting caption -- spans the PANEL\'s own content width', async () => {
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port, args: ['layout'] });
        const rowNames = Object.keys(state.frames).filter(name => /^row\d+$/.test(name))
          .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
        assert.ok(rowNames.length >= 4, `expected at least 4 top-level rows, got ${rowNames.length}: ${rowNames.join(', ')}`);
        assertRowsSpanPanel(rowNames.map(name => state.frames[name]), 'row');
      });
  });

  await check('criterion 13: the panel\'s documented row order -- a status row, a control row, a divider, a caption, each a known kind, each in its own place', async () => {
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port, args: ['layout'] });
        const rowNames = Object.keys(state.frames).filter(name => /^row\d+$/.test(name))
          .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
        const rows = rowNames.map(name => state.frames[name]);

        // The DOCUMENTED sequence of row KINDS (bin/menubar.m's own section comment, "The
        // layout, top to bottom"): a horizontal stack for the status row, a horizontal
        // stack for the control row, a box for the divider, a text field for the caption.
        // Two consecutive NSStackViews cannot be told apart by class alone -- a swap
        // between them reads identically here -- which is exactly why the rowIndex
        // assertions below exist too.
        assert.deepEqual(rows.slice(0, 4).map(row => row.class),
          ['NSStackView', 'NSStackView', 'NSBox', 'NSTextField'],
          `the first four rows must be, in order, the status row, the control row, the divider and the waiting caption; got ${JSON.stringify(rows.slice(0, 4).map(row => row.class))}`);

        // Row order is vertical order too -- AppKit's y grows upward, so each row must
        // sit below (a strictly smaller y than) the one before it in the array. On its
        // own this only proves the rows are stacked top-to-bottom in WHATEVER order the
        // array holds them (true of any vertical NSStackView, reordered or not); it is
        // the class sequence and the rowIndex checks either side of it that prove the
        // array itself holds the DOCUMENTED order.
        for (let i = 1; i < rows.length; i++) {
          assert.ok(rows[i].y < rows[i - 1].y,
            `row ${i} (y=${rows[i].y}) must sit below row ${i - 1} (y=${rows[i - 1].y})`);
        }

        // Row IDENTITY for the two controls criteria 2 and 3 are about: not merely "some
        // row, and that row is well-formed" (every row is the same width, so a control in
        // the WRONG row still reads as "flush with my row's own trailing edge"), but the
        // SPECIFIC row the panel is documented to hold it in.
        assert.equal(state.rowIndex.glyph, 0, 'the phase glyph must be in the FIRST row (the status row)');
        assert.equal(state.rowIndex.statusline, 0, 'the status line must be in the FIRST row (the status row)');
        assert.equal(state.rowIndex.gear, 0, 'the gear must be in the status row, not the control row');
        assert.equal(state.rowIndex.toggle, 1, 'the switch must be in the SECOND row (the control row)');
        assert.equal(state.rowIndex.stateword, 1, 'the state word must be in the SECOND row (the control row)');
        assert.equal(state.rowIndex.forward, 1, 'the forward button must be in the control row, not the status row');
      });
  });

  await check('criterion 1: the phase glyph and the switch both begin at their own row\'s left edge', async () => {
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port, args: ['layout'] });
        // Row-relative: the glyph is the FIRST view in the status row and the switch is the
        // FIRST view in the control row, so "begins at the left edge" is "x == 0" in each
        // one's own row, not a shared panel-relative number.
        assert.ok(Math.abs(state.frames.glyph.x) <= 0.5, `the phase glyph must begin at its row's own left edge, got x=${state.frames.glyph.x}`);
        assert.ok(Math.abs(state.frames.toggle.x) <= 0.5, `the switch must begin at its row's own left edge, got x=${state.frames.toggle.x}`);
      });
  });

  await check('criterion 2 and 13: the gear\'s right edge and the forward button\'s right edge hold the PANEL\'s own right content edge -- and the two rows share a right column', async () => {
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port, args: ['layout'] });
        const statusRow = state.frames.row0;
        const controlRow = state.frames.row1;
        const panelRight = PANEL_WIDTH - PANEL_INSET;
        // Row-relative (gear.x/w) converted to panel-relative by adding its own row's
        // panel-relative origin, then compared against the panel's own known right edge
        // directly -- criterion 2's literal claim, not merely "flush with A row" (see the
        // section comment above for why that used to be all this proved).
        const gearRight = statusRow.x + state.frames.gear.x + state.frames.gear.w;
        const forwardRight = controlRow.x + state.frames.forward.x + state.frames.forward.w;
        assert.ok(Math.abs(gearRight - panelRight) <= 3,
          `the gear's right edge (${gearRight}) must sit at the panel's own content edge (${panelRight})`);
        assert.ok(Math.abs(forwardRight - panelRight) <= 3,
          `the forward button's right edge (${forwardRight}) must sit at the panel's own content edge (${panelRight})`);
      });
  });

  await check('criterion 1, waiting rows: each waiting row -- and the overflow row -- spans the panel\'s content width too', async () => {
    // Criterion 1 names "each waiting row" explicitly, and they are the only rows built
    // from cb_row_button rather than cb_row/cb_caption -- a fixture with nothing waiting
    // (every check above) never builds one at all, so the layout probe had never actually
    // seen one until this check. Seven boards, the same fixture criterion 6's own
    // row-count check builds: five capped rows plus the overflow row.
    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port, secret }) => {
        for (let i = 1; i <= 7; i++) {
          await fetch(`http://127.0.0.1:${port}/api/board`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
            body: JSON.stringify({
              title: `WAITING_${i}`,
              blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
            }),
          });
        }
        const state = await probe({ home: probeHome, port, args: ['layout'] });
        const rowNames = Object.keys(state.frames).filter(name => /^row\d+$/.test(name))
          .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
        // 4 fixed rows (status, control, divider, caption) + 5 capped waiting rows + 1
        // overflow row.
        assert.equal(rowNames.length, 10,
          `expected 4 fixed rows, 5 waiting rows and 1 overflow row, got ${rowNames.length}: ${rowNames.join(', ')}`);
        const rows = rowNames.map(name => state.frames[name]);
        assertRowsSpanPanel(rows, 'row');
        // Every waiting row and the overflow row is a real NSButton (cb_row_button), not
        // some other control repurposed for the section.
        for (let i = 4; i < 10; i++) {
          assert.equal(rows[i].class, 'NSButton', `row ${i} (a waiting or overflow row) must be an NSButton`);
        }
      });
  });

  await check('criterion 3: the phase glyph keeps its own size, and the gear never moves, even when the status line is the longest string it ever shows', async () => {
    // The true worst case cb_status_label ever produces: a paused work interval at the
    // maximum reachable cycle position -- settings.longEvery's own validated ceiling
    // (MAX_LONG_EVERY=100, src/pomodoro.mjs, not exported; writeDoc bypasses validation
    // the same way every other fixture in this file does) -- gives 'Work 100/100 · 25:00
    // (paused)', 29 characters: longer than 'No answer from the daemon' (25, this check's
    // comparator until review) and longer than any other reachable phase/position/
    // countdown/paused combination cb_status_label can produce. A check titled "the
    // longest string it ever shows" has to actually reach for it.
    const longDoc = { ...runningDoc({ phase: 'work', paused: true, remainingMs: 25 * 60_000 }, { longEvery: 100 }), cycle: 99 };
    let long;
    await withDaemon(longDoc, async ({ probeHome, port }) => {
      long = await probe({ home: probeHome, port, args: ['layout'] });
    });
    assert.equal(long.status, 'Work 100/100 · 25:00 (paused)',
      'setup: this must be the longest status string, or the comparison below proves nothing');

    await withDaemon(runningDoc({ phase: 'work', deadline: Date.now() + 7 * 60_000 + 30_000, paused: false }),
      async ({ probeHome, port }) => {
        const short = await probe({ home: probeHome, port, args: ['layout'] });
        // Same glyph size regardless of which status string is on screen beside it -- the
        // slack a long string needs is absorbed by the label compressing (cb_fill_with's
        // own low compression resistance), never by the glyph growing or shrinking.
        assert.equal(short.frames.glyph.w, long.frames.glyph.w,
          `the phase glyph's width must not depend on the status text's length: ${short.frames.glyph.w} (short text) vs ${long.frames.glyph.w} (the longest text)`);
        // And the gear stays flush with the PANEL's own right content edge either way --
        // a long status string truncates (cb_fill_with's NSLineBreakByTruncatingTail)
        // rather than pushing the gear off the panel, which is criterion 3's literal
        // claim.
        const gearRight = long.frames.row0.x + long.frames.gear.x + long.frames.gear.w;
        assert.ok(Math.abs(gearRight - (PANEL_WIDTH - PANEL_INSET)) <= 3,
          `the gear must still hold the panel's own right content edge under the longest status string, got ${gearRight}`);
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

  await check('the glyph vocabulary, state by state: the silhouette always, a ring only while WORK runs, and one centre mark at a time', async () => {
    const now = Date.now();
    // Every state the item can be in, and what each one draws. The silhouette is not in
    // this table because it has no field: it is drawn unconditionally, which is the whole
    // point of it -- there is no state in which the tomato is not a tomato.
    const cases = [
      { name: 'idle', timer: null, ring: 'no', mark: 'none' },
      { name: 'running work', timer: { phase: 'work', deadline: now + 5 * 60_000, paused: false }, ring: 'yes', mark: 'none' },
      { name: 'paused work', timer: { phase: 'work', paused: true, remainingMs: 90_000 }, ring: 'no', mark: 'paused' },
      // No ring on either break: the ring is work's alone now -- see cb_derive's own
      // account of why an arc a tenth of a point inside the outline was not worth the ink
      // next to the rest bar. The digits still carry a break's remaining time.
      { name: 'running short break', timer: { phase: 'break', deadline: now + 3 * 60_000, paused: false }, ring: 'no', mark: 'rest' },
      { name: 'running long break', timer: { phase: 'longBreak', deadline: now + 9 * 60_000, paused: false }, ring: 'no', mark: 'rest' },
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
  // Two hardening items on the client's own edges: what it does with a number the wire
  // should never have carried, and which queue its one un-serialized request went out on.
  // -------------------------------------------------------------------------------------

  await check('a hand-edited `cycle` outside any real range is BOUNDED at the wire -- the popover\'s OWN position is never negative and never past the cycle length, whatever the document says', async () => {
    // A hand-edited `cycle` reaches this client intact whatever it says: `Number.isInteger`
    // is true of `1e300` and of `-3` alike, so `normalizeDoc` (src/pomodoro.mjs) keeps it
    // and the route serves it. Converting that to `int` in C is undefined behaviour rather
    // than a wraparound with a defined answer, and the reported symptom was a NEGATIVE
    // position in the popover's own line.
    //
    // Asserted DIRECTLY on the popover's own numbers, and on values chosen so that neither
    // of the two things that were already absorbing the fault can absorb these. Both are
    // real, and both made the first version of this check vacuous:
    //
    //   - arm64 SATURATES the cast, so `1e300` becomes INT_MAX, and cb_derive's
    //     pre-existing `if (position > every) position = every` then clamps that back to a
    //     perfectly sane 4/4. Every large POSITIVE cycle is absorbed that way. The negative
    //     values below are not: that clamp only ever pulls the position DOWN, so a negative
    //     one walks straight through it and out to the status line.
    //   - comparing against the real index page cannot pin this either, because JS clamps
    //     the same document independently (`Math.min(cycle + 1, longEvery)`) and arrives at
    //     its own sane answer with no help from this client at all.
    const now = Date.now();
    const running = runningDoc({ phase: 'work', deadline: now + 5 * 60_000, paused: false });
    for (const [label, cycle] of [
      ['far past what an int can hold, upwards', 1e300],
      ['far past what an int can hold, downwards', -1e300],
      ['a plain negative, small enough that no saturation is involved at all', -3],
    ]) {
      await withDaemon({ ...running, cycle }, async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.phase, 'work', `${label}: setup -- the interval must still be the running one`);
        const position = /^Work (-?\d+)\/(-?\d+) · \d{2}:\d{2}$/.exec(state.status);
        assert.ok(position, `${label}: the popover's line must still be well formed: ${JSON.stringify(state.status)}`);
        const [, num, denom] = position.map(Number);
        assert.equal(denom, 4, `${label}: the denominator is the document's own longEvery`);
        assert.ok(num >= 1 && num <= denom,
          `${label}: the position must sit inside the cycle it is measured against, got ${num}/${denom} from ${JSON.stringify(state.status)}`);
        assert.ok(Number(state.remaining) >= 0, `${label}: and no negative countdown: ${state.remaining}`);
      });
    }

    // Agreement with the real index page is claimed only where the page HAS a sane answer
    // of its own: at `1e300` both clamp to 4/4, and that the two arrive there together is
    // still worth pinning. At a negative cycle they part company on purpose -- the page
    // prints `Math.min(cycle + 1, longEvery)` unguarded and this client refuses to print a
    // negative at all, which is the fix rather than a divergence to reconcile.
    await withDaemon({ ...running, cycle: 1e300 }, async ({ probeHome, port, secret }) => {
      const readingsStartedAt = Date.now();
      const state = await probe({ home: probeHome, port });
      const tab = loadIndexAgainstDaemon(port, secret);
      try {
        const indexText = await tab.statusText();
        assert.match(indexText, /^Work 4\/4 · /, `setup: the index page clamps the same absurd cycle to 4/4: ${JSON.stringify(indexText)}`);
        assertSameStatusLine(state.status, indexText, Date.now() - readingsStartedAt, 'an absurd cycle');
      } finally {
        tab.restoreFetch();
      }
    });
  });

  await check('an absurd deadline, remainder or longEvery is bounded too -- the countdown, the arc and the position stay well-formed numbers', async () => {
    // The other three wire values that cross into a fixed-width type or into `llround`.
    // None is checked against the index page: the JS side carries doubles all the way to
    // the string, so the two genuinely disagree about how to spell 1e300, and the claim
    // worth making about this client is only that it prints a well-formed, in-range answer
    // instead of stepping into undefined behaviour.
    for (const [label, timer, settings] of [
      ['a deadline past the end of time', { phase: 'break', deadline: 1e300, paused: false }, {}],
      ['a frozen remainder past the end of time', { phase: 'work', paused: true, remainingMs: 1e300 }, {}],
      ['a longEvery past the end of time', { phase: 'work', deadline: Date.now() + 60_000, paused: false }, { longEvery: 1e300 }],
    ]) {
      await withDaemon(runningDoc(timer, settings), async ({ probeHome, port }) => {
        const state = await probe({ home: probeHome, port });
        assert.equal(state.answered, 'yes', `${label}: the client must still answer`);
        assert.match(state.text, /^\d+:\d{2}$/, `${label}: the countdown must still be digits: ${state.text}`);
        const remaining = Number(state.remaining);
        assert.ok(Number.isFinite(remaining) && remaining >= 0, `${label}: remaining=${state.remaining}`);
        const fraction = Number(state.fraction);
        assert.ok(Number.isFinite(fraction) && fraction >= 0 && fraction <= 1, `${label}: fraction=${state.fraction}`);
        assert.doesNotMatch(state.status, /-\d/, `${label}: no negative may reach the popover's line: ${JSON.stringify(state.status)}`);
      });
    }
  });

  await check('structurally: every request this process makes goes out on the ONE serial queue -- including the zero-crossing re-fetch, which used to take a concurrent one', async () => {
    // Structural, and it has to be. The zero-crossing re-fetch lives in `cb_tick`, which
    // runs only inside the real AppKit run loop -- it creates the status item -- and there
    // is no headless way to reach that; the whole reason this file drives `--menubar
    // --probe` is that the AppKit half cannot be checked at all (see this file's own
    // header). What IS checkable is the property the fix consists of, and it is a property
    // of the file rather than of one call: cb_poll_queue is serial precisely so a POST and
    // the poll that reads its effect back cannot be in flight at once, and a re-fetch
    // dispatched onto a global CONCURRENT queue opted out of that at the worst possible
    // moment -- the countdown has just hit zero, so the popover is open and Restart is
    // under the cursor, and a GET that started before the POST can land after it and write
    // the pre-restart document back over it.
    const source = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    assert.equal(/dispatch_get_global_queue/.test(source), false,
      'no request in this file may go out on a concurrent queue -- cb_poll_queue is the only queue requests are allowed on');

    // Every dispatch that runs a poll, wherever it is, names the serial queue. The main
    // queue is left alone on purpose: the one dispatch onto it is an AppKit activation,
    // which is the queue that work genuinely belongs on and touches no request.
    const pollDispatches = [...source.matchAll(/dispatch_(?:async|after)\(([^;]*?)\^\{[^}]*cb_poll_once\(\)/g)];
    assert.ok(pollDispatches.length >= 4, `setup: the poll dispatches must still be findable, found ${pollDispatches.length}`);
    for (const [, args] of pollDispatches) {
      assert.match(args, /cb_poll_queue/, `a poll dispatched onto something other than cb_poll_queue: ${args.trim()}`);
    }

    // And the zero-crossing one specifically, by name, so a future edit cannot satisfy the
    // count above while moving this exact caller back off the queue. Matched on the two
    // identifiers and nothing between them: pinning the line's exact spacing would make a
    // reformat a failing check with the behaviour untouched, which is a check that has
    // stopped being about what it says it is about.
    const tickStart = source.indexOf('static void cb_tick(void) {');
    const tickEnd = source.indexOf('/* --- Entry points', tickStart);
    assert.ok(tickStart > 0 && tickEnd > tickStart, 'setup: cb_tick must still be findable by name');
    assert.match(source.slice(tickStart, tickEnd), /dispatch_async\(\s*cb_poll_queue\s*,[^;]*?cb_poll_once\s*\(\s*\)/,
      'the boundary re-fetch must be dispatched onto the serial poll queue');
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
  // ADR 93 -- a click surfaces the existing tab. Spec criteria 5 and 6.
  //
  // Both surfaces make the same call: bin/notify.m's banner delegate and this file's
  // -pressRow: each ask cb_surface_tab (bin/launcher.c) whether a scriptable browser is
  // already showing that board, and open only when none is. So one seam covers both --
  // `--menubar --probe open <url>` runs that exact function against the real browsers on
  // this machine, with `osascript` answered by the stub the compiled-in PATH points at.
  //
  // Where these stop, stated once: the seam reports the DECISION and does not perform the
  // fallback open, because that open is +[NSWorkspace openURL:] and would put a browser tab
  // on the reader's screen on every suite run. "The fallback fires exactly once" is
  // therefore two assertions in two places -- the decision, behaviourally here, and the one
  // guarded call site per surface, structurally at the end of this section. That is the
  // same split criterion 8's "reset is not reachable" already lives with, and for the same
  // reason: driving AppKit is not available to this file.
  // -------------------------------------------------------------------------------------

  const CLICK_PORT = 7391;
  const CLICK_BOARD = 'b_0123456789abcdef0123456789abcdef';
  const CLICK_URL = `http://localhost:${CLICK_PORT}/b/${CLICK_BOARD}#stranded-round`;
  /** The `open` decision, with no daemon anywhere: the branch answers from the validator
   * and the surfacer alone and never reaches a fetch. */
  const clickVerdict = async (url = CLICK_URL) =>
    (await probe({ home: makeProbeHome(null), port: CLICK_PORT, args: url === null ? ['open'] : ['open', url] })).open;

  await check('AC 5 and 6: a browser already showing the board raises its tab, and nothing is opened', async () => {
    // A stand-in named Safari, because Safari is the FIRST row of the table: with the stub
    // answering `raised`, the search stops at the first running browser, so this is the one
    // arrangement in which the number of invocations is exactly one however many browsers
    // the reader happens to have open. That is what makes "and opens no duplicate" provable
    // here rather than merely likely.
    await withProcessNamed('Safari', async () => {
      armOsascript('raised');
      assert.equal(await clickVerdict(), 'raised', 'a matching tab is raised, so the click opens nothing');
      const calls = osascriptCalls();
      assert.equal(calls.length, 1, `exactly one browser is asked once the tab is found:\n${calls.map(c => c.app).join(', ')}`);
      assert.equal(calls[0].app, 'Safari');
      assert.equal(calls[0].dialect, 'safari', 'Safari is asked in Safari\'s dialect, not a Chromium\'s');
      // The fragment is cut off before the script is built, and this is why: the tab is
      // very likely sitting at `#stranded-round` (where a previous banner's click landed
      // it) while the URL this click carries need not be. The script matches the base and
      // then either a `#` or a `?` after it, so `...#stranded-round` matches and
      // `.../b_abc1` does not match `.../b_abc`.
      assert.equal(calls[0].base, `http://localhost:${CLICK_PORT}/b/${CLICK_BOARD}`,
        'the script matches on the board page\'s own URL, fragment and query cut away');
      assert.match(calls[0].script, /if u is b or u starts with \(b & "#"\) or u starts with \(b & "\?"\) then/,
        'and matches the whole URL, never a bare board id inside somebody else\'s page');
      assert.ok(!calls[0].script.includes('#stranded-round'), 'the fragment reaches no script string');
    });
  });

  await check('AC 5 and 6: with no tab on this board anywhere, the click falls through to opening it', async () => {
    armOsascript('none');
    assert.equal(await clickVerdict(), 'opened', 'nothing was showing it, so the URL is opened as before ADR 93');
    const calls = osascriptCalls();
    assert.deepEqual(calls.map(c => c.app).sort(), runningBrowsers(),
      'and every running browser was asked before giving up -- no early exit on the first "none"');
  });

  await check('AC 5: a Chromium is asked in the Chromium dialect, never in Safari\'s', async () => {
    // The two dialects are the whole of ADR 93's "Safari and Chromium": one names the tab
    // (`set current tab of w to t`), the other names its index (`set active tab index of w
    // to n`). Handing either script to the other browser raises nothing, silently, forever.
    await withProcessNamed('Chromium', async () => {
      armOsascript('none');
      assert.equal(await clickVerdict(), 'opened');
      const chromium = osascriptCalls().find(c => c.app === 'Chromium');
      assert.ok(chromium, 'setup: a running Chromium must have been asked at all');
      assert.equal(chromium.dialect, 'chromium');
      assert.match(chromium.script, /^tell application "Chromium"$/m, 'and addressed by its own name');
    });
  });

  await check('AC 5 and 6: only browsers already running are asked -- one that is not is never launched', async () => {
    // The point of the running check, and the reason it happens before anything is spawned:
    // `tell application "Safari"` LAUNCHES Safari when it is not, and asking a browser
    // nobody opened is also how a reviewer collects an Automation prompt for an app they
    // were not using. Asserted as a SET COMPARISON against `ps`, computed here rather than
    // read back from the binary under test, so the reader's own open browsers move both
    // sides together and neither this check's power nor its stability depends on them.
    armOsascript('none');
    await clickVerdict();
    const before = osascriptCalls().map(c => c.app).sort();
    assert.deepEqual(before, runningBrowsers(), 'the browsers asked are exactly the table browsers running');

    // Whichever table browser this machine is NOT running, so the delta below is a delta
    // rather than a no-op -- chosen at run time because the reader's own open browsers are
    // none of this check's business.
    const spare = browserTable().map(b => b.app).find(app => !before.includes(app));
    assert.ok(spare, 'setup: this machine is running every browser in the table, so nothing can be started');

    await withProcessNamed(spare, async () => {
      armOsascript('none');
      await clickVerdict();
      const during = osascriptCalls().map(c => c.app).sort();
      assert.deepEqual(during, [...before, spare].sort(), `starting one (${spare}) adds exactly that one`);
    });

    armOsascript('none');
    await clickVerdict();
    assert.deepEqual(osascriptCalls().map(c => c.app).sort(), before, 'and stopping it takes exactly that one away');
  });

  await check('AC 5 and 6: an osascript that is missing, refuses or answers late still leaves a click that opens', async () => {
    // Every way this can fail costs a duplicate tab and none of them costs the click --
    // which is the whole reason the surfacing returns a verdict rather than taking over the
    // open. A dead click is the one outcome ADR 93 must not be able to produce.
    armOsascript('fail');
    assert.equal(await clickVerdict(), 'opened', 'a script that exits nonzero -- a denied Automation grant looks exactly like this');

    armOsascript('slow');
    const started = Date.now();
    assert.equal(await clickVerdict(), 'opened', 'a script that answers after a beat is still read to the end');
    assert.ok(Date.now() - started >= 600, 'setup: the slow answer must actually have been waited for');

    chmodSync(osascriptStub, 0o644); // present, not executable: the same as absent to the resolver
    try {
      armOsascript('raised');
      assert.equal(await clickVerdict(), 'opened', 'no osascript on the compiled-in PATH at all');
      assert.equal(osascriptCalls().length, 0, 'and nothing ran');
    } finally {
      chmodSync(osascriptStub, 0o755);
    }
  });

  await check('AC 6: a URL the validator refuses is neither surfaced nor opened, and no script is run for it', async () => {
    // The order matters and this is what pins it: a URL that may not be opened may not be
    // ASKED ABOUT either. Otherwise `file:///etc/passwd` would reach an AppleScript string
    // literal on its way to being refused.
    for (const bad of [
      `https://localhost:${CLICK_PORT}/b/${CLICK_BOARD}`,
      `http://evil.com/b/${CLICK_BOARD}`,
      `http://localhost:${CLICK_PORT + 1}/b/${CLICK_BOARD}`,
      'file:///etc/passwd',
      `http://localhost:${CLICK_PORT}/b/${CLICK_BOARD}" & (do shell script "id") & "`,
      '',
    ]) {
      armOsascript('raised');
      assert.equal(await clickVerdict(bad), 'refused', `must be refused: ${JSON.stringify(bad)}`);
      assert.equal(osascriptCalls().length, 0, `and must reach no script at all: ${JSON.stringify(bad)}`);
    }
    armOsascript('raised');
    assert.equal(await clickVerdict(null), 'refused', 'and no URL at all is not a click either');
  });

  await check('AC 6: the URL GET /api/waiting actually builds is one the surfacing acts on', async () => {
    // Every URL above is spelled by this check. This one is the route's own, so a row that
    // opened a URL the surfacer could not parse -- a trailing slash, a host spelling, a
    // fragment nobody expected -- fails here rather than shipping as "it just never raises".
    await withDaemon(runningDoc(null), async ({ probeHome, port, secret }) => {
      const posted = await (await fetch(`http://127.0.0.1:${port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
        body: JSON.stringify({
          title: 'SURFACE_FIXTURE',
          blocks: [{ kind: 'question', prompt: 'Waiting?', widget: 'single', options: [{ label: 'Yes' }] }],
        }),
      })).json();
      const listed = await (await fetch(`http://127.0.0.1:${port}/api/waiting`, {
        headers: { [SECRET_HEADER]: secret },
      })).json();
      const entry = listed.waiting.find(e => e.boardId === posted.boardId);
      assert.ok(entry, 'setup: the board is waiting');

      await withProcessNamed('Safari', async () => {
        armOsascript('raised');
        const state = await probe({ home: probeHome, port, args: ['open', entry.url] });
        assert.equal(state.open, 'raised', `the route's own URL must be surfaceable: ${entry.url}`);
        const calls = osascriptCalls();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].base, entry.url.split('#')[0].split('?')[0],
          'and the script matches the page that URL names, byte for byte');
      });
    });
  });

  await check('ADR 93, structurally: both board-opening clicks are guarded by the one surfacer, and the index page is not', async () => {
    // The half the seam above cannot reach. Three things have to be true and none of them
    // is observable from a probe: bin/notify.m's delegate asks before it opens, -pressRow:
    // asks before it opens, and -pressIndex:/-pressSettings: do not ask at all (the index
    // is a page, not a board a reviewer is sitting in front of -- raising some other tab
    // for it would be a surprise, and ADR 93 is about boards).
    const notify = readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8');
    const menubar = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    const launcher = readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8');

    assert.match(launcher, /^int cb_surface_tab\(/m, 'one definition, in C, beside cb_is_board_url');
    for (const [file, source] of [['bin/notify.m', notify], ['bin/menubar.m', menubar]]) {
      assert.match(source, /extern int cb_surface_tab\(/, `${file} declares it rather than reimplementing it`);
      assert.ok(!/^int cb_surface_tab\(/m.test(source), `${file} must not define a second one`);
    }

    // The banner's click: the surfacing is what decides whether NSWorkspace is reached at
    // all, and the early return is the "opens no duplicate" half of AC 5.
    assert.match(notify, /if \(cb_surface_tab\(\[self\.boardURL UTF8String\]\)\) \{\s*\n\s*self\.served = YES;\s*\n\s*return;/,
      'bin/notify.m returns without opening when a tab was raised');
    assert.ok(notify.indexOf('cb_surface_tab') < notify.indexOf('[[NSWorkspace sharedWorkspace] openURL:url'),
      'and asks before it opens, not after');

    // The row's click: the same call, and the open only on the other branch of it.
    assert.match(menubar, /if \(cb_surface_tab\(\[target UTF8String\]\)\) return;\s*\n\s*dispatch_async\(dispatch_get_main_queue\(\), \^\{\s*\n\s*cb_open_url/,
      '-pressRow: opens only when nothing was raised');

    // And the two index opens are plain, which is only visible as an absence.
    for (const method of ['pressIndex', 'pressSettings']) {
      const start = menubar.indexOf(`- (void)${method}:(id)sender`);
      assert.ok(start > 0, `setup: -${method}: must still exist`);
      const body = menubar.slice(start, menubar.indexOf('\n}', start));
      assert.ok(!body.includes('cb_surface_tab'), `-${method}: opens the index page plainly, without surfacing`);
      assert.ok(body.includes('cb_open_url'), `-${method}: still opens it`);
    }
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
  // No redirect is ever followed, at any of the three sites in bin/menubar.m that speak
  // HTTP -- an unhandled 302 is exactly how a process that squats the daemon's port ahead
  // of the real one (loopback is trusted here; owning port 7391 first is not) could
  // otherwise launder the secret header to a host of its own choosing.
  // -------------------------------------------------------------------------------------

  /** Two stubs: one standing in for the daemon's own port -- which legitimately sees the
   * secret header on its first hop, same as the real daemon would, since nothing on this
   * side can tell a hijacked port apart from a live one before it answers -- and a second,
   * wholly separate server the first's `302 Location:` points at. The second is the actual
   * assertion surface: if any request site below ever followed the redirect, the secret
   * would show up THERE, on a connection the fix has to make sure never opens at all. A
   * real second server rather than an unreachable `https://elsewhere/` is deliberate: an
   * unresolvable host "passes" whether the client tried and failed to reach it or never
   * tried at all, proving nothing, while a live target that counts its own requests tells
   * the two apart. */
  function startRedirectStub() {
    let redirectRequests = 0;
    let targetRequests = 0;
    let targetSawSecret = false;
    const target = http.createServer((req, res) => {
      targetRequests++;
      if (req.headers[SECRET_HEADER]) targetSawSecret = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    return new Promise((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', () => {
        const targetPort = target.address().port;
        const stub = http.createServer((req, res) => {
          redirectRequests++;
          res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/` });
          res.end();
        });
        stub.once('error', reject);
        stub.listen(0, '127.0.0.1', () => {
          resolve({
            port: stub.address().port,
            get redirectRequests() { return redirectRequests; },
            get targetRequests() { return targetRequests; },
            get targetSawSecret() { return targetSawSecret; },
            close: () => Promise.all([
              new Promise(r => stub.close(r)),
              new Promise(r => target.close(r)),
            ]),
          });
        });
      });
    });
  }

  await check('the menu bar sends no credential to a redirecting host, and never follows the redirect at all -- checked at each of the three request sites', async () => {
    const stub = await startRedirectStub();
    try {
      const home = makeProbeHome(randomBytes(32).toString('hex'));
      // Three sites, three ways to observe "refused": cb_request (the plain probe) folds a
      // redirect into the same `answered=no` every other non-200 answer gets; cb_stream_probe
      // and cb_stream_start (the one-shot `stream` probe and the held-open `live` probe) both
      // report it as `stream=refused`, exactly as they would for any daemon that never
      // answered with a 200 at all.
      const cases = [
        { name: 'cb_request (the plain probe)', args: [],
          assertRefused: state => assert.equal(state.answered, 'no', 'a redirect must read exactly like any other non-200 answer -- refused, not followed') },
        { name: 'cb_stream_probe (`--probe stream`)', args: ['stream', '1'],
          assertRefused: state => assert.equal(state.stream, 'refused') },
        { name: 'cb_stream_start (`--probe live`)', args: ['live', '1'],
          assertRefused: state => assert.equal(state.stream, 'refused') },
      ];
      for (const c of cases) {
        const before = stub.targetRequests;
        const state = await probe({ home, port: stub.port, args: c.args });
        assert.equal(state.code, 0, `${c.name} must report, not crash: ${state.stderr}`);
        c.assertRefused(state);
        assert.equal(stub.targetRequests, before,
          `${c.name}: the redirect target must receive zero requests -- "not followed at all" means the connection to it never even opens`);
      }
      assert.ok(stub.redirectRequests >= cases.length,
        'setup: the stub standing in for the daemon must actually have been asked by all three sites, or this proves nothing');
      assert.equal(stub.targetSawSecret, false, 'the secret header must never reach the redirect target, under any of the three sites');
    } finally {
      await stub.close();
    }
  });

  // -------------------------------------------------------------------------------------
  // cb_cached_secret is read and written from more than one GCD queue: the poll queue
  // (every cb_request call) and, separately, CBEventStream's own private delegate queue
  // (didCompleteWithError's cb_forget_secret(), on the SSE session's own queue -- not the
  // poll queue, since cb_stream_schedule_reconnect only serializes the RECONNECT ATTEMPT
  // onto it, not the drop notification that precedes that attempt). Two independent serial
  // queues that never rendezvous, both touching one unguarded static object pointer, is a
  // real data race: an assignment retains the new value and releases the old one, and two
  // threads racing the same assignment can double-release a value the other still holds --
  // a crash in the one process holding the reader's TCC identity.
  //
  // A black-box test cannot reliably force that race to fire in a bounded window -- it is
  // the classic shape of bug that stays invisible until the wrong two nanoseconds line up,
  // the same reasoning ticket 03's own structural pin (`cb_state_answered_at is written in
  // exactly one place`, above) already applies to a different shared field. This pins the
  // STRUCTURAL property that removes the race instead of trying to reproduce it: every
  // touch of the shared pointer goes through one lock, and nothing touches it any other way.
  // -------------------------------------------------------------------------------------

  /** A minimal comment-and-string-aware stripper, local to this one check: block comments,
   * line comments and `"..."` string literals are all dropped, so a plain identifier search
   * below cannot be fooled by this file's own prose mentioning `cb_cached_secret` by name
   * (as the block comment above cb_secret_lock does) into thinking that is a live touch of
   * the pointer. Objective-C has no regex literals to confuse a scanner the way QUIRKS.md's
   * `stripJsComments` entry warns a JS one can be -- a plain character walk is enough here. */
  function stripObjCComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const two = text.slice(i, i + 2);
      if (two === '/*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        continue;
      }
      if (two === '//') {
        const end = text.indexOf('\n', i + 2);
        i = end === -1 ? text.length : end;
        continue;
      }
      if (text[i] === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\') j++;
          j++;
        }
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += text[i];
      i++;
    }
    return out;
  }

  await check('the cb_cached_secret accessor is lock-guarded, and it is the only place the shared secret pointer is ever touched -- the fix for a data race between the poll queue and the stream\'s own delegate queue', async () => {
    const source = stripObjCComments(readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8'));
    assert.match(source, /static NSLock \*cb_secret_lock\(void\)/, 'a lock guarding the secret cache must exist');

    const secretStart = source.indexOf('static NSString *cb_secret(void) {');
    const secretEnd = source.indexOf('\n}', secretStart) + 2;
    const forgetStart = source.indexOf('static void cb_forget_secret(void) {');
    const forgetEnd = source.indexOf('\n}', forgetStart) + 2;
    const declarationStart = source.indexOf('static NSString *cb_cached_secret = nil;');
    assert.ok(declarationStart > 0 && secretStart > declarationStart && forgetStart > secretStart,
      'setup: the declaration and both accessors must still be findable by name, in order');
    const declarationEnd = source.indexOf(';', declarationStart) + 1;

    // Every occurrence of the identifier, comments and string literals excluded, must fall
    // inside its own declaration or one of the two accessor bodies -- proving nothing else
    // in the file reaches around them to touch the pointer directly.
    const occurrences = [...source.matchAll(/\bcb_cached_secret\b/g)].map(m => m.index);
    assert.ok(occurrences.length >= 4,
      `setup: expected at least a declaration plus one read and one write in each accessor, found ${occurrences.length}`);
    for (const at of occurrences) {
      const insideDeclaration = at >= declarationStart && at < declarationEnd;
      const insideSecret = at >= secretStart && at < secretEnd;
      const insideForget = at >= forgetStart && at < forgetEnd;
      assert.ok(insideDeclaration || insideSecret || insideForget,
        `cb_cached_secret touched outside its declaration and its two lock-guarded accessors, at offset ${at} -- exactly the unguarded access the fix closes`);
    }

    // And inside each accessor, the touch is actually bracketed by the lock -- finding the
    // lock nearby is not the same as the read or write happening inside it.
    for (const [name, body] of [['cb_secret', source.slice(secretStart, secretEnd)], ['cb_forget_secret', source.slice(forgetStart, forgetEnd)]]) {
      assert.match(body, /\[cb_secret_lock\(\) lock\]/, `${name} must lock before touching the cache`);
      assert.match(body, /\[cb_secret_lock\(\) unlock\]/, `${name} must unlock after`);
    }

    // cb_request's own session is a second process-lifetime shared resource reachable from
    // more than one queue at once: the timer-driven poll on cb_poll_queue, and -- via
    // cb_poll_once, from the zero-crossing re-fetch -- the global concurrent queue. A plain
    // lazily-assigned module-level static here is the exact same race in a new spot: two
    // threads racing an `== nil` check both assign, and ARC releases the loser's session
    // while it is still in use. Pinned the same way cb_secret_lock is pinned above --
    // dispatch_once is the only allowed gate, and a hand-rolled check-then-assign must never
    // come back.
    assert.doesNotMatch(source, /static NSURLSession \*cb_request_session\s*=\s*nil;/,
      'cb_request_session must never be a plain lazily-assigned module-level static -- that is the race this fix closes');
    assert.doesNotMatch(source, /cb_request_session\s*==\s*nil/,
      'nothing may check-then-assign cb_request_session by hand; dispatch_once is the only allowed gate');
    const requestSessionStart = source.indexOf('static NSURLSession *cb_request_session(void) {');
    assert.ok(requestSessionStart > 0, 'setup: cb_request_session must still be findable as a function, not a bare static');
    const requestSessionEnd = source.indexOf('\n}', requestSessionStart) + 2;
    assert.match(source.slice(requestSessionStart, requestSessionEnd), /dispatch_once\(&once,/,
      'cb_request_session must create its session exactly once via dispatch_once, the same guard cb_secret_lock uses');
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
