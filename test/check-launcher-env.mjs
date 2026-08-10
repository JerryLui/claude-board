// Proves the environment half of bin/launcher.c: that a real, compiled launcher builds
// the child's environment itself rather than forwarding its own, per the OVERRIDE_ENV /
// PASSTHROUGH_NAMES tables there.
//
// This is deliberately narrower than test/check-install.mjs and does not shell out to
// install.sh at all: it compiles bin/launcher.c directly against a hand-written
// launcher_paths.h pointed at a STUB "daemon" (a script that dumps its own environment
// and exits), so there is no real HTTP server, no real port lifecycle and no process to
// leak or clean up -- the launcher forks the stub, the stub prints and exits, the
// launcher's own waitpid returns, and this test reads the launcher's stdout. Never
// touches ~/Applications, ~/Library/LaunchAgents or any other real path: everything
// this file writes lives under one mkdtempSync workDir, cleaned up at the end.
//
// The two acceptance criteria this suite exists for:
//   - a `NODE_OPTIONS` entry poisoning the parent environment must not cause injected
//     code to run in the daemon -- proven with a harmless marker file, not merely by
//     checking that the string is absent, so a filter that stripped the value but left
//     some other loading path open would still be caught.
//   - the daemon receives only an explicitly named set of environment variables; any
//     variable not on that list is absent from process.env at daemon start, verified by
//     reading back what a real (stub) daemon actually saw.
//
// Skips gracefully (prints why, exits 0) if no C compiler is available -- the same
// non-fatal degradation install.sh itself uses when `cc` is missing, since a machine
// without Xcode Command Line Tools still gets a working install and this suite has
// nothing of its own to compile against.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';

// Bind port 0, read what the kernel picked, release it. Racy in principle, fine here:
// nothing else in this suite binds anything, and the alternative is hardcoding a port
// that collides with a developer's own running daemon.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherSrc = path.join(repoRoot, 'bin', 'launcher.c');
// The other half of the same binary (ADR.md entry 19): launcher.c calls cb_notify, so a
// build of launcher.c alone does not link. Compiled here for the same reason install.sh
// compiles it -- separately, because -fobjc-arc is an Objective-C flag and clang says so
// when it is handed a .c file alongside.
const notifySrc = path.join(repoRoot, 'bin', 'notify.m');
// The third half (ADR 72): launcher.c calls cb_menubar, so a build without this does not
// link either. It also means every launcher run below really does fork a second child --
// which is the point, since this suite's whole subject is what the launcher hands a child.
const menubarSrc = path.join(repoRoot, 'bin', 'menubar.m');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

if (spawnSync(ccCmd, ['--version']).error) {
  console.log(`==> skipping check-launcher-env.mjs: no C compiler ('${ccCmd}') found`);
  console.log('all launcher-env checks ok (skipped)');
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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-launcher-env-'));

// The stub CLAUDE_BOARD_DAEMON: dumps its own environment as JSON and exits immediately.
// No server, no port, nothing for this suite to leak or have to kill afterward -- the
// launcher forks it, it prints and exits, the launcher's own waitpid returns, and the
// whole tree is gone before spawnSync here even returns.
const stubDaemon = path.join(workDir, 'stub-daemon.mjs');
writeFileSync(stubDaemon, "console.log(JSON.stringify(process.env));\n");

// The NODE_OPTIONS payload: a harmless marker, not a payload that could itself do
// damage if the filter this suite exists to check ever regressed. Written as a
// CommonJS preload (`--require` synchronously requires it, and a `.cjs` file loads the
// same way under every Node version this repo supports, unlike an ESM preload). Its
// only effect is to create MARKER_FILE -- proof that injected code RAN, not just that a
// string reached the child's argv or env.
const markerScript = path.join(workDir, 'marker.cjs');
const markerFile = path.join(workDir, 'marker-should-not-exist');
writeFileSync(markerScript, [
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(markerFile)}, 'poisoned\\n');`,
  '',
].join('\n'));

// The compiled-in values: all under this test's own workDir, so a launcher built here
// can never resolve to a real ~/Documents, ~/Library or ~/.config path even if
// something in this test goes wrong.
const compiledHome = path.join(workDir, 'compiled-home');
const compiledStore = path.join(workDir, 'compiled-home', 'Library', 'Application Support', 'claude-board');
const compiledRefRoots = path.join(workDir, 'compiled-home', '.claude', 'skills');
const compiledPath = '/usr/bin:/bin:/usr/sbin:/sbin';
// Not a security boundary (see bin/launcher.c's OVERRIDE_ENV comment) but baked in on the
// same footing as the other four: src/handoff.mjs's recoveryCommand() needs the real
// clone path once CLAUDE_BOARD_DAEMON points inside the bundle instead.
const compiledRepoRoot = path.join(workDir, 'compiled-repo');

// Mirrors install.sh's c_escape: backslash and double-quote are the only two bytes that
// would otherwise end a C string literal early. This test's own paths are all plain
// mkdtemp-generated ASCII, so this is a belt-and-braces match of the real function
// rather than a scenario this suite expects to exercise.
function cEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const headerDir = path.join(workDir, 'header');
mkdirSync(headerDir, { recursive: true });
const headerPath = path.join(headerDir, 'launcher_paths.h');
writeFileSync(headerPath, [
  `#define CLAUDE_BOARD_NODE "${cEscape(process.execPath)}"`,
  `#define CLAUDE_BOARD_DAEMON "${cEscape(stubDaemon)}"`,
  `#define CLAUDE_BOARD_HOME_DIR "${cEscape(compiledHome)}"`,
  `#define CLAUDE_BOARD_PATH "${cEscape(compiledPath)}"`,
  `#define CLAUDE_BOARD_STORE_DIR "${cEscape(compiledStore)}"`,
  `#define CLAUDE_BOARD_REF_ROOTS_VALUE "${cEscape(compiledRefRoots)}"`,
  `#define CLAUDE_BOARD_REPO_ROOT_VALUE "${cEscape(compiledRepoRoot)}"`,
  '',
].join('\n'));

const launcherExec = path.join(workDir, 'launcher');
const notifyObj = path.join(workDir, 'notify.o');
const menubarObj = path.join(workDir, 'menubar.o');
const objBuilds = [[notifySrc, notifyObj], [menubarSrc, menubarObj]]
  .map(([src, obj]) => spawnSync(ccCmd,
    ['-O2', '-Wall', '-Wextra', '-fobjc-arc', '-c', '-o', obj, src], { encoding: 'utf8' }));
// Only linked if both objects compiled: a link attempted on top of a failed compile
// reports a missing symbol, which names the wrong problem.
const builds = objBuilds.some(b => b.status !== 0) ? objBuilds : [...objBuilds, spawnSync(ccCmd,
  ['-O2', '-Wall', '-Wextra', '-o', launcherExec, '-I', headerDir, launcherSrc, notifyObj, menubarObj,
   // AppKit joins the two frameworks UNUserNotificationCenter needs because the click
   // -serving mode becomes an NSApplication to receive its own notification's response
   // (ADR.md entry 57, bin/notify.m). install.sh links the same three.
   '-framework', 'Foundation', '-framework', 'UserNotifications', '-framework', 'AppKit'], { encoding: 'utf8' })];

async function main() {
  await check('every half of the launcher compiles clean against the generated header (no warnings, same flags install.sh uses plus -Wextra)', async () => {
    // All three invocations, not just the link: a warning in notify.m or menubar.m is a
    // warning install.sh's own -Wall build would carry forever, and checking only the
    // last command run would never see it.
    for (const build of builds) {
      assert.equal(build.status, 0, `stdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
      assert.equal(build.stdout.trim(), '', `unexpected compiler output:\n${build.stdout}`);
      assert.equal(build.stderr.trim(), '', `unexpected compiler warning:\n${build.stderr}`);
    }
    assert.ok(existsSync(launcherExec), 'the launcher binary must exist after a clean build');
  });
  chmodSync(launcherExec, 0o755);

  // Run the launcher once, with a parent environment poisoned every way this suite can
  // think of, plus every passthrough name set to a value distinct from anything else in
  // this test (so a mixed-up assignment inside launcher.c would show up as a wrong
  // value, not just a present/absent flip). Run synchronously: the stub daemon exits
  // immediately, so the launcher (which waits on it) does too -- there is no server to
  // wait for and no process left running once spawnSync returns.
  const junkMarkerPath = markerScript; // NODE_OPTIONS below references this by absolute path
  const poisonedParentEnv = {
    // Deliberately NOT process.env -- a from-scratch object, so this test is not
    // accidentally relying on (or hidden by) whatever happens to be in this suite's own
    // shell. PATH is required for the launcher/cc/exec machinery itself to find nothing
    // it needs to find (the launcher execs by absolute path), so it is left out on
    // purpose too, to prove PATH is baked in rather than needed from the parent.
    NODE_OPTIONS: `--require ${junkMarkerPath}`,
    // ADR.md entry 76: the supervising path this suite exercises refuses to fork at all
    // unless this exact marker is present --
    // install.sh writes it into the plist's own EnvironmentVariables dict, standing in
    // here for "this run came from launchd" the same way the rest of this object stands
    // in for a poisoned parent shell. test/check-launcher-refuses.mjs is the suite for
    // the refusal itself; this one is unaffected by it and needs the marker only to keep
    // reaching the code it already tests.
    CLAUDE_BOARD_LAUNCHD_MARKER: '1',
    CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'poison-secret'),
    CLAUDE_BOARD_REF_ROOTS: '/',
    // ADR.md entry 38: `/file/` and its allowlist are gone, so this name is neither an
    // override nor a passthrough any more -- set here anyway, to prove a parent that
    // still carries it (an operator's old shell export, a stale plist) cannot make it
    // reach the daemon.
    CLAUDE_BOARD_SERVE_ROOTS: '/',
    CLAUDE_BOARD_HOME: '/tmp/poison-store',
    // A real, existing dylib -- not a nonexistent path. dyld reads DYLD_INSERT_LIBRARIES
    // for the process it is loading (this launcher binary itself, via spawnSync below)
    // before a single line of launcher.c's main() runs, so a nonexistent target aborts
    // the launcher at dyld's hands, not this test's. Using one dyld can actually load
    // keeps the test about what launcher.c does with the variable (nothing -- it must
    // not appear in the child's environment) rather than about dyld's own behaviour.
    DYLD_INSERT_LIBRARIES: '/usr/lib/libgmalloc.dylib',
    NODE_PATH: '/tmp/poison-node-modules',
    A_TOTALLY_UNRELATED_JUNK_VARIABLE: 'hello',
    // The passthrough allowlist, every entry, each a value nothing else in this test
    // could produce by accident.
    CLAUDE_BOARD_PORT: '48123',
    CLAUDE_BOARD_SHUTDOWN_MS: '4242',
    CLAUDE_BOARD_SSE_HEARTBEAT_MS: '5353',
    CLAUDE_BOARD_STRANDED_GRACE_MS: '8686',
    CLAUDE_BOARD_ATTENDED_WINDOW_MS: '9797',
    CLAUDE_BOARD_TIMEOUT_MS: '6464',
    CLAUDE_BOARD_HANDOFF_TTL_MS: '7575',
    TMPDIR: path.join(workDir, 'poison-tmpdir'),
  };

  const run = spawnSync(launcherExec, [], { env: poisonedParentEnv, encoding: 'utf8', timeout: 10_000 });

  await check('the launcher runs the stub daemon and it prints its environment', async () => {
    assert.equal(run.status, 0, `launcher exited ${run.status} (signal ${run.signal})\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.doesNotMatch(run.stderr || '', /cannot exec/, 'the launcher must be able to exec the stub daemon');
  });

  let childEnv;
  await check('the stub daemon\'s stdout parses as the JSON environment dump it was told to print', async () => {
    childEnv = JSON.parse(run.stdout);
  });

  await check('acceptance criterion: a NODE_OPTIONS entry does not cause injected code to run in the daemon', async () => {
    // The real proof, not just "the string is gone": the --require target never ran, so
    // it never wrote its marker file. (Ablation: pass NODE_OPTIONS through unfiltered
    // and this marker file exists after the run above.)
    assert.ok(!existsSync(markerFile), 'NODE_OPTIONS must never reach node -- injected code must not run');
    assert.ok(!('NODE_OPTIONS' in childEnv), 'and the variable itself must be absent from the child\'s environment');
  });

  await check('acceptance criterion: the daemon receives only the explicitly named set of variables -- everything else is absent', async () => {
    const expectedNames = [
      'HOME', 'PATH',
      'CLAUDE_BOARD_HOME', 'CLAUDE_BOARD_REF_ROOTS',
      'CLAUDE_BOARD_REPO_ROOT',
      'CLAUDE_BOARD_PORT', 'CLAUDE_BOARD_SHUTDOWN_MS', 'CLAUDE_BOARD_SSE_HEARTBEAT_MS',
      'CLAUDE_BOARD_STRANDED_GRACE_MS', 'CLAUDE_BOARD_ATTENDED_WINDOW_MS',
      'CLAUDE_BOARD_TIMEOUT_MS', 'CLAUDE_BOARD_HANDOFF_TTL_MS', 'TMPDIR',
    ].sort();
    // TMPDIR is the one passthrough name macOS also sets on its own account in some
    // configurations (__CF_USER_TEXT_ENCODING is another; observed added by the OS
    // itself independent of anything execve was given, so it is excluded from this
    // comparison by name rather than assumed away silently).
    const actualNames = Object.keys(childEnv).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort();
    assert.deepEqual(actualNames, expectedNames, `the child's environment must be exactly the allowlisted set (plus __CF_USER_TEXT_ENCODING, which macOS adds on its own):\ngot: ${actualNames.join(',')}`);

    // Named absences, called out individually rather than only through the set
    // comparison above, so a failure here says exactly which poison got through.
    // CLAUDE_BOARD_SERVE_ROOTS is named here rather than among the overrides below: it is
    // gone from the daemon's environment altogether (ADR.md entry 38), so a parent that
    // still sets it (poisoned above, deliberately) must never see it reach the child.
    for (const poisoned of ['CLAUDE_BOARD_SECRET_FILE', 'CLAUDE_BOARD_SERVE_ROOTS', 'DYLD_INSERT_LIBRARIES', 'NODE_PATH', 'A_TOTALLY_UNRELATED_JUNK_VARIABLE']) {
      assert.ok(!(poisoned in childEnv), `${poisoned} must be absent from the daemon's environment`);
    }
  });

  await check('the compiled-in overrides hold their baked values -- the poisoned inherited ones never took', async () => {
    assert.equal(childEnv.HOME, compiledHome, 'HOME must be the compiled-in value, not inherited');
    assert.equal(childEnv.PATH, compiledPath, 'PATH must be the compiled-in fixed literal');
    assert.equal(childEnv.CLAUDE_BOARD_HOME, compiledStore, 'CLAUDE_BOARD_HOME must be the compiled-in store, not the poisoned "/tmp/poison-store"');
    assert.equal(childEnv.CLAUDE_BOARD_REF_ROOTS, compiledRefRoots, 'CLAUDE_BOARD_REF_ROOTS must be the compiled-in value, not the poisoned "/"');
    assert.equal(childEnv.CLAUDE_BOARD_REPO_ROOT, compiledRepoRoot, 'CLAUDE_BOARD_REPO_ROOT must be the compiled-in clone path -- src/handoff.mjs recoveryCommand() needs it once CLAUDE_BOARD_DAEMON points inside the bundle');
  });

  await check('the passthrough allowlist is honoured verbatim from the parent', async () => {
    assert.equal(childEnv.CLAUDE_BOARD_PORT, '48123');
    assert.equal(childEnv.CLAUDE_BOARD_SHUTDOWN_MS, '4242');
    assert.equal(childEnv.CLAUDE_BOARD_SSE_HEARTBEAT_MS, '5353');
    // The stranded grace (PROTOCOL.md's "The stranded banner" documents it as an
    // override): a bundled install that dropped it here would leave the shipped fifteen
    // seconds the only value reachable under a real install.
    assert.equal(childEnv.CLAUDE_BOARD_STRANDED_GRACE_MS, '8686');
    // The look-away window (ADR.md entry 73), for the same reason as the grace beside it:
    // PROTOCOL.md documents it as an override, and a bundled install that dropped it here
    // would leave the shipped two minutes the only value reachable under a real install --
    // a doc and a binary contradicting each other, silently, since a plist entry for a name
    // that is not on this list is not refused, it is ignored.
    assert.equal(childEnv.CLAUDE_BOARD_ATTENDED_WINDOW_MS, '9797');
    assert.equal(childEnv.CLAUDE_BOARD_TIMEOUT_MS, '6464');
    assert.equal(childEnv.CLAUDE_BOARD_HANDOFF_TTL_MS, '7575');
    assert.equal(childEnv.TMPDIR, path.join(workDir, 'poison-tmpdir'));
  });

  await check('a passthrough name absent from the parent stays absent from the child -- it is not defaulted to empty', async () => {
    const runWithoutOnePassthrough = spawnSync(launcherExec, [], {
      env: {
        CLAUDE_BOARD_LAUNCHD_MARKER: '1', // ADR.md entry 76 -- see the comment above
        CLAUDE_BOARD_PORT: '1',
        CLAUDE_BOARD_SHUTDOWN_MS: '2',
        // CLAUDE_BOARD_SSE_HEARTBEAT_MS deliberately omitted.
        CLAUDE_BOARD_TIMEOUT_MS: '3',
        CLAUDE_BOARD_HANDOFF_TTL_MS: '4',
        TMPDIR: '/tmp',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(runWithoutOnePassthrough.status, 0, `stdout:\n${runWithoutOnePassthrough.stdout}\nstderr:\n${runWithoutOnePassthrough.stderr}`);
    const env2 = JSON.parse(runWithoutOnePassthrough.stdout);
    assert.ok(!('CLAUDE_BOARD_SSE_HEARTBEAT_MS' in env2), 'an unset passthrough knob must not appear at all, empty string included');
  });

  // The checks above read a STUB daemon's own dump of process.env, which proves what the
  // launcher hands a child but says nothing about the line bin/daemon.mjs prints. That
  // line is the seam asked for ("a check that reads the
  // daemon's own resolved environment back out of its log line"), and a seam nothing
  // reads is a seam that can drift silently into lying -- print values instead of names,
  // or fall behind a debug flag -- while every other check here still passes. So: boot
  // the real daemon once, with a known environment, and hold its line to what it got.
  await check('the real daemon\'s own "claude-board env:" line names exactly the variables it was given', async () => {
    const port = await freePort();
    const daemonHome = mkdtempSync(path.join(workDir, 'daemon-home-'));
    const given = {
      HOME: daemonHome,
      PATH: process.env.PATH,
      CLAUDE_BOARD_HOME: daemonHome,
      CLAUDE_BOARD_PORT: String(port),
      CLAUDE_BOARD_SECRET_FILE: path.join(daemonHome, 'secret'),
    };
    const daemon = spawn(process.execPath, [path.join(repoRoot, 'bin', 'daemon.mjs')], {
      env: given,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`no "claude-board env:" line within 10s; got:\n${buf}`)), 10_000);
        daemon.stdout.on('data', chunk => {
          buf += chunk;
          const found = buf.split('\n').find(l => l.startsWith('claude-board env: '));
          if (found) { clearTimeout(timer); resolve(found); }
        });
        daemon.on('error', err => { clearTimeout(timer); reject(err); });
      });

      const reported = line.slice('claude-board env: '.length).trim().split(',').filter(Boolean);
      // macOS adds __CF_USER_TEXT_ENCODING to any process it starts; it is not ours to
      // account for, and the same allowance the stub-daemon checks above make.
      const ours = reported.filter(name => name !== '__CF_USER_TEXT_ENCODING');
      assert.deepEqual(ours, Object.keys(given).sort(),
        'the daemon must report exactly the variables it was handed, sorted -- no more, no fewer');
      assert.ok(!line.includes(daemonHome),
        'names only, never values: the line must not leak a path, and HOME\'s value is a path we know');
      assert.ok(!line.includes('secret'),
        'the secret file path must not appear -- this line goes to a log that is not private');
    } finally {
      daemon.kill('SIGTERM');
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
    console.log('\nall launcher-env checks ok');
  });
