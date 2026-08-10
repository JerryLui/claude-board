// Proves the supervision half of bin/launcher.c now that it holds TWO children: the node
// daemon it has always forked, and the macOS status item it forks beside it as
// `claude-board --menubar` (ADR 72, bin/menubar.m).
//
// The acceptance criteria this file exists for, from SPEC_MENUBAR.md:
//
//   - 10, "the item is present after a login with no manual step": the LaunchAgent already
//     carries RunAtLoad, so what is left to prove here is that an argv-LESS invocation of
//     the launcher -- exactly the invocation launchd makes -- produces the item child with
//     nothing else asked of anyone. A real login session is not reachable from a check;
//     what is asserted instead is the whole of what the login would do differently, which
//     is nothing. test/check-install-payload.mjs carries the same assertion against a real
//     INSTALLED bundle, which is the closest this suite gets to the launchd path.
//   - 15, "killing the status item does not stop the daemon, and does not stop the Timer":
//     the item is SIGKILLed and the daemon is then asked, over HTTP, both whether it is
//     still there and whether its own interval clock advanced across the kill.
//
// Deliberately narrow, and it does not shell out to install.sh at all: bin/launcher.c is
// compiled here against a hand-written launcher_paths.h pointed at a STUB daemon (a small
// HTTP server with a tick counter and an exit route), so there is no bundle, no code
// signature, no plist and no launchctl anywhere in this file. Everything it writes lives
// under one mkdtempSync workDir. The one thing it cannot stub is the launcher's own second
// child, which really is this compiled binary re-exec'ing itself -- which is the point.
//
// Skips gracefully (prints why, exits 0) if no C compiler is available, the same non-fatal
// degradation install.sh itself uses when `cc` is missing.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherSrc = path.join(repoRoot, 'bin', 'launcher.c');
const notifySrc = path.join(repoRoot, 'bin', 'notify.m');
const menubarSrc = path.join(repoRoot, 'bin', 'menubar.m');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

if (spawnSync(ccCmd, ['--version']).error) {
  console.log(`==> skipping check-launcher-menubar.mjs: no C compiler ('${ccCmd}') found`);
  console.log('all launcher-menubar checks ok (skipped)');
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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-launcher-menubar-'));

// --- the stub daemon ------------------------------------------------------------------
//
// Stands in for bin/daemon.mjs: it binds the port the launcher passes through, counts
// ticks off an interval of its own, and exits with a code on request. The tick counter is
// what makes "does not stop the Timer" a real assertion rather than a liveness one -- the
// real Timer is an interval inside the daemon, and an interval that stopped advancing
// while the process stayed up would be exactly the failure criterion 15 names and exactly
// the one a pid check cannot see.
//
// SIGTERM is handled and exits 0, mirroring bin/daemon.mjs's own clean shutdown, so the
// exit status the launcher reports for a stopped job is 0 rather than a signal.
const stubDaemon = path.join(workDir, 'stub-daemon.mjs');
writeFileSync(stubDaemon, `import http from 'node:http';
let ticks = 0;
setInterval(() => { ticks++; }, 25);
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  if (req.url === '/ticks') { res.writeHead(200); res.end(String(ticks)); return; }
  if (req.url.startsWith('/exit/')) {
    res.writeHead(200); res.end('bye');
    // After the response is on the wire, so the caller is never left with a dead socket
    // it has to tell apart from a crash.
    setTimeout(() => process.exit(Number(req.url.slice('/exit/'.length))), 20);
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.CLAUDE_BOARD_PORT), '127.0.0.1');
`);

const compiledHome = path.join(workDir, 'compiled-home');
mkdirSync(compiledHome, { recursive: true });

// Mirrors install.sh's c_escape; every path here is plain mkdtemp ASCII, so this is a
// match of the real function rather than a case this file exercises.
const cEscape = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const headerDir = path.join(workDir, 'header');
mkdirSync(headerDir, { recursive: true });
writeFileSync(path.join(headerDir, 'launcher_paths.h'), [
  `#define CLAUDE_BOARD_NODE "${cEscape(process.execPath)}"`,
  `#define CLAUDE_BOARD_DAEMON "${cEscape(stubDaemon)}"`,
  `#define CLAUDE_BOARD_HOME_DIR "${cEscape(compiledHome)}"`,
  '#define CLAUDE_BOARD_PATH "/usr/bin:/bin:/usr/sbin:/sbin"',
  `#define CLAUDE_BOARD_STORE_DIR "${cEscape(path.join(workDir, 'store'))}"`,
  `#define CLAUDE_BOARD_REF_ROOTS_VALUE "${cEscape(path.join(workDir, 'roots'))}"`,
  `#define CLAUDE_BOARD_REPO_ROOT_VALUE "${cEscape(path.join(workDir, 'repo'))}"`,
  '',
].join('\n'));

const launcherExec = path.join(workDir, 'launcher');
const builds = [[notifySrc, path.join(workDir, 'notify.o')], [menubarSrc, path.join(workDir, 'menubar.o')]]
  .map(([src, obj]) => spawnSync(ccCmd, ['-O2', '-Wall', '-Wextra', '-fobjc-arc', '-c', '-o', obj, src], { encoding: 'utf8' }));
if (builds.every(b => b.status === 0)) {
  builds.push(spawnSync(ccCmd, ['-O2', '-Wall', '-Wextra', '-o', launcherExec, '-I', headerDir,
    launcherSrc, path.join(workDir, 'notify.o'), path.join(workDir, 'menubar.o'),
    '-framework', 'Foundation', '-framework', 'UserNotifications', '-framework', 'AppKit'], { encoding: 'utf8' }));
}

// --- process inspection ---------------------------------------------------------------

/** Bind port 0, read what the kernel picked, release it. Racy in principle, fine here --
 * test/run.mjs runs checks concurrently, so a hardcoded port is the thing that would
 * actually collide. */
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

/** Every live child of `pid`, with the argv each was started with. `ps -o args=` reports
 * the command line a process was EXEC'd with, which is what makes it the right instrument
 * here: a launcher that forked and CALLED cb_menubar instead of exec'ing would show a
 * child carrying the launcher's own argv, with no `--menubar` in it anywhere. */
function childrenOf(pid) {
  const listed = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  const pids = (listed.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  return pids.map(child => {
    const args = spawnSync('ps', ['-o', 'args=', '-p', child], { encoding: 'utf8' });
    return { pid: Number(child), args: (args.stdout || '').trim() };
  }).filter(c => c.args !== '');
}

/** `ps` knows the difference between a process that is gone and one that is a zombie
 * waiting to be reaped; `kill(pid, 0)` does not, and answers "still there" for both. That
 * distinction is the whole of the "a second child left unreaped becomes a zombie" hazard,
 * so it is the one this file asks about. Returns '' for a pid that no longer exists. */
function processState(pid) {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(what, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Start the compiled launcher and wait until its stub daemon is answering. `args` is
 * normally empty on purpose: an argv-less invocation is what launchd makes, and it is the
 * only one criterion 10 is about.
 *
 * CLAUDE_BOARD_LAUNCHD_MARKER is set for the same reason install.sh writes it into the
 * plist (ADR.md entry 76): the supervising path refuses an argv-less launch that did not
 * come from launchd, so a check standing in for launchd has to say so. Without it every
 * assertion below fails at "the launcher exited before its daemon came up", which names
 * the wrong problem entirely. */
async function startLauncher(args = []) {
  const port = await freePort();
  const child = spawn(launcherExec, args, {
    env: { PATH: process.env.PATH, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_LAUNCHD_MARKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { err += c; });
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });

  const handle = {
    child, port,
    get stderr() { return err; },
    get stdout() { return out; },
    get exit() { return exit; },
    ticks: () => fetch(`http://127.0.0.1:${port}/ticks`).then(r => r.text()).then(Number),
    exitDaemon: code => fetch(`http://127.0.0.1:${port}/exit/${code}`).then(r => r.text()),
    waitForExit: (timeoutMs = 10_000) => waitFor('the launcher to exit', () => exit, timeoutMs),
    // Teardown for a scenario that did NOT end by itself. The children are enumerated
    // FIRST and killed second: SIGKILLing the launcher is the one stop it cannot clean up
    // after, so anything still listed as its child after that is already reparented to
    // launchd and unfindable. Getting this backwards leaves the daemon and the item
    // running -- and, because they still hold the stdio pipes this spawn created, leaves
    // node itself unable to exit, which presents as the whole check file hanging rather
    // than as anything about processes.
    stop() {
      const strays = childrenOf(child.pid);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      for (const c of strays) {
        try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
  await waitFor('the stub daemon to answer', async () => {
    if (exit) throw new Error(`the launcher exited before its daemon came up\nstdout:\n${out}\nstderr:\n${err}`);
    try { return (await handle.ticks()) >= 0; } catch { return false; }
  });
  return handle;
}

const isItem = c => c.args.includes('--menubar');

async function main() {
  await check('every half of the launcher compiles clean (-Wall -Wextra, the flags install.sh uses plus one)', async () => {
    for (const build of builds) {
      assert.equal(build.status, 0, `stdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
      assert.equal(build.stdout.trim(), '', `unexpected compiler output:\n${build.stdout}`);
      assert.equal(build.stderr.trim(), '', `unexpected compiler warning:\n${build.stderr}`);
    }
    assert.ok(existsSync(launcherExec), 'the launcher binary must exist after a clean build');
  });
  chmodSync(launcherExec, 0o755);

  await check('criterion 10: an argv-less launcher forks TWO children -- the daemon, and its own executable re-exec\'d as `--menubar`', async () => {
    const d = await startLauncher();
    try {
      const kids = await waitFor('two children', () => {
        const found = childrenOf(d.child.pid);
        return found.length === 2 ? found : null;
      });
      const item = kids.find(isItem);
      assert.ok(item, `no --menubar child among ${JSON.stringify(kids)}`);
      // The exact argv, not a substring: it proves the child was reached by execve of THIS
      // binary's own path. A fork-and-call would carry the launcher's own (argv-less)
      // command line -- which is fatal rather than untidy, because CoreFoundation and the
      // ObjC runtime are documented-unsafe in a forked child that has not exec'd, and
      // ticket 04 puts AppKit in this process. A launcher that took the path from argv[0]
      // instead of _NSGetExecutablePath would also fail here, since spawn() above sets
      // argv[0] to the same absolute path only by coincidence of how node spawns.
      assert.equal(item.args, `${launcherExec} --menubar`);
      const daemon = kids.find(c => !isItem(c));
      assert.ok(daemon.args.includes(stubDaemon), `the other child must be the daemon, got: ${daemon.args}`);
      assert.ok(daemon.args.startsWith(process.execPath), `and it must be node: ${daemon.args}`);
    } finally {
      d.stop();
    }
  });

  await check('the item is handed the same built environment the daemon is: HOME and the port reach it, the parent\'s NODE_OPTIONS does not', async () => {
    // Not decoration: ticket 04's client finds the local secret under HOME and the daemon
    // under CLAUDE_BOARD_PORT, and it is one word's difference in bin/launcher.c between
    // handing this child the built envp and handing it the environment launchd supplied --
    // which is the environment a user-writable plist controls, and which the daemon has
    // never been given (bin/launcher.c's OVERRIDE_ENV / PASSTHROUGH_NAMES).
    const port = await freePort();
    const child = spawn(launcherExec, [], {
      env: {
        PATH: process.env.PATH,
        CLAUDE_BOARD_PORT: String(port),
        CLAUDE_BOARD_LAUNCHD_MARKER: '1',
        NODE_OPTIONS: '--require /tmp/definitely-not-loaded.cjs',
        HOME: path.join(workDir, 'a-home-that-must-not-be-inherited'),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      const item = await waitFor('the --menubar child', () => childrenOf(child.pid).find(isItem));
      // `ps -Eww` prints a process's environment after its arguments.
      const dump = spawnSync('ps', ['-Eww', '-o', 'args=', '-p', String(item.pid)], { encoding: 'utf8' }).stdout || '';
      assert.ok(dump.includes(`HOME=${compiledHome}`), `the item must get the compiled-in HOME, not the inherited one:\n${dump}`);
      assert.ok(dump.includes(`CLAUDE_BOARD_PORT=${port}`), `the item must get the daemon's port:\n${dump}`);
      assert.ok(!dump.includes('NODE_OPTIONS'), `NODE_OPTIONS must not reach the item either:\n${dump}`);
    } finally {
      for (const c of childrenOf(child.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  await check('criterion 15: SIGKILLing the item leaves the daemon serving and its clock ticking, leaves the launcher supervising, and reaps rather than zombifies the item', async () => {
    const d = await startLauncher();
    try {
      const item = await waitFor('the --menubar child', () => childrenOf(d.child.pid).find(isItem));
      const ticksBefore = await d.ticks();
      process.kill(item.pid, 'SIGKILL');

      // Reaped, not left as a zombie: waiting on the daemon's pid alone (which is what the
      // launcher did before it had two children) leaves this one unreaped for the life of
      // the job. `ps` is the only instrument that tells the two apart.
      await waitFor('the item to be reaped', () => processState(item.pid) === '');

      assert.equal(d.exit, null, `the launcher must still be running:\nstdout:\n${d.stdout}\nstderr:\n${d.stderr}`);
      assert.ok(processState(d.child.pid) !== '', 'the launcher process must still exist');

      // "does not stop the Timer": the daemon's own interval must have ADVANCED across the
      // kill, not merely have left a process behind that answers.
      const ticksAfter = await waitFor('the daemon\'s clock to advance', async () => {
        const now = await d.ticks();
        return now > ticksBefore ? now : null;
      });
      assert.ok(ticksAfter > ticksBefore, `the daemon's clock must keep advancing: ${ticksBefore} -> ${ticksAfter}`);

      // ADR 72: a --menubar child that dies is not restarted. A launcher that respawned it
      // would turn a crash loop in menu bar code into a fork bomb beside the daemon.
      await sleep(1000);
      assert.deepEqual(childrenOf(d.child.pid).filter(isItem), [], 'the item must not be restarted');
      assert.equal(childrenOf(d.child.pid).length, 1, 'the daemon must be the only child left');
      assert.match(d.stderr, /menu bar item exited/, 'and the launcher must say so, rather than losing a child silently');
    } finally {
      d.stop();
    }
  });

  await check('the launcher\'s exit status stays the DAEMON\'s: a SIGKILLed item does not become the job\'s exit code', async () => {
    // launchd reads this status, so an item killed by signal reporting 137 in the
    // launcher's place would look to launchd exactly like the daemon crashing.
    const d = await startLauncher();
    try {
      const item = await waitFor('the --menubar child', () => childrenOf(d.child.pid).find(isItem));
      process.kill(item.pid, 'SIGKILL');
      await waitFor('the item to be reaped', () => processState(item.pid) === '');
      await d.exitDaemon(3);
      const exit = await d.waitForExit();
      assert.deepEqual(exit, { code: 3, signal: null }, `the launcher must report the daemon's own exit code:\nstderr:\n${d.stderr}`);
    } finally {
      d.stop();
    }
  });

  await check('the launcher exiting takes the item with it -- a bootout leaves nothing on the menu bar', async () => {
    // The item outliving its supervisor is a status item nothing is behind and no job to
    // boot out a second time; it is reparented to launchd and stays until the reader finds
    // it in Activity Monitor.
    const d = await startLauncher();
    try {
      const item = await waitFor('the --menubar child', () => childrenOf(d.child.pid).find(isItem));
      await d.exitDaemon(0);
      const exit = await d.waitForExit();
      assert.deepEqual(exit, { code: 0, signal: null }, `stderr:\n${d.stderr}`);
      await waitFor('the item to go away with its launcher', () => processState(item.pid) === '');
    } finally {
      d.stop();
    }
  });

  await check('SIGTERM to the launcher stops both children and the launcher itself', async () => {
    const d = await startLauncher();
    try {
      const item = await waitFor('the --menubar child', () => childrenOf(d.child.pid).find(isItem));
      const daemon = childrenOf(d.child.pid).find(c => !isItem(c));
      d.child.kill('SIGTERM');
      const exit = await d.waitForExit();
      assert.deepEqual(exit, { code: 0, signal: null }, `a forwarded SIGTERM must let the daemon shut down cleanly:\nstderr:\n${d.stderr}`);
      await waitFor('both children to go', () => processState(item.pid) === '' && processState(daemon.pid) === '');
    } finally {
      d.stop();
    }
  });

  await check('`--menubar` on its own is a run loop: it supervises nothing, and it exits 0 when signalled', async () => {
    // The mode the fork above enters, exercised directly. Exits 0 rather than dying by
    // signal, which is what keeps a `bootout` out of the error log; and forks NOTHING,
    // which is what says the argv dispatch caught it rather than falling through to the
    // supervising path and starting a second daemon against a bound port.
    const child = spawn(launcherExec, ['--menubar'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    let exit = null;
    child.on('exit', (code, signal) => { exit = { code, signal }; });
    await sleep(1000);
    assert.equal(exit, null, `--menubar must stay running until it is signalled:\nstderr:\n${err}`);
    assert.deepEqual(childrenOf(child.pid), [], '--menubar must fork nothing at all');
    child.kill('SIGTERM');
    const seen = await waitFor('the run loop to exit', () => exit);
    assert.deepEqual(seen, { code: 0, signal: null }, `a signalled run loop must exit 0, not die by signal:\nstderr:\n${err}`);
  });

  await check('an UNRECOGNISED argument still supervises the daemon, item and all', async () => {
    // bin/launcher.c's deliberate rule, and one worth pinning now that argv has a third
    // arm: launchd's invocation must never depend on argv parsing, so anything the
    // dispatch does not recognise falls through to supervising node rather than being
    // refused. A dispatch rewritten to reject unknown flags would take the daemon down on
    // any future plist that passed one.
    const d = await startLauncher(['--not-a-mode-this-binary-knows']);
    try {
      const kids = await waitFor('two children', () => {
        const found = childrenOf(d.child.pid);
        return found.length === 2 ? found : null;
      });
      assert.ok(kids.some(isItem), `the item must be forked on the fallthrough path too: ${JSON.stringify(kids)}`);
    } finally {
      d.stop();
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
    console.log('\nall launcher-menubar checks ok');
  });
