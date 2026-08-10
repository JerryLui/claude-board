// Proves ADR.md entry 76 / SPEC_SIGNALS.md ticket 02: bin/launcher.c's no-argument
// supervising path refuses to fork node unless CLAUDE_BOARD_LAUNCHD_MARKER=1 is present
// in its own environment -- the signal install.sh writes into the real plist's
// EnvironmentVariables dict (see install.sh step 2, and test/check-install.mjs's "the
// plist carries the launchd marker" check for the other half: that install.sh actually
// writes it). Only launchd ever reads that plist and injects its EnvironmentVariables
// dict into the process it execs, so a stray LaunchServices launch of the bundle -- a
// double-click, or the activation macOS attempts after a notification click finds no
// serving process (ADR.md entry 75) -- can never carry it, and must therefore start no
// daemon, write nothing anywhere, and show nothing on screen.
//
// Pattern-matched on test/check-launcher-env.mjs: compiles bin/launcher.c directly
// against a hand-written launcher_paths.h pointed at a stub "daemon" that proves it ran
// two ways -- a marker FILE on disk (the acceptance criterion's "writes nothing to the
// store" stand-in: absence of this file is not "didn't print", it is "never executed at
// all") and its own environment dump on stdout (proving a real launchd start still
// supervises exactly as before). No real installed bundle, no ~/Applications, no
// ~/Library/LaunchAgents -- everything lives under one mkdtempSync workDir.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherSrc = path.join(repoRoot, 'bin', 'launcher.c');
const notifySrc = path.join(repoRoot, 'bin', 'notify.m');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

if (spawnSync(ccCmd, ['--version']).error) {
  console.log(`==> skipping check-launcher-refuses.mjs: no C compiler ('${ccCmd}') found`);
  console.log('all launcher-refuses checks ok (skipped)');
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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-launcher-refuses-'));

// The stub CLAUDE_BOARD_DAEMON: proof of having run, written two ways -- a file on disk
// (what "started a daemon / wrote to the store" would look like from outside, the thing
// the acceptance criterion says must never happen for a stray launch) and its own
// environment on stdout (so a run that DOES supervise is provably the same launcher path
// test/check-launcher-env.mjs already exercises, not some other one).
const stubDaemon = path.join(workDir, 'stub-daemon.mjs');
const ranMarkerFile = path.join(workDir, 'daemon-ran-marker');
writeFileSync(stubDaemon, [
  "import { writeFileSync } from 'node:fs';",
  `writeFileSync(${JSON.stringify(ranMarkerFile)}, 'the daemon ran\\n');`,
  'console.log(JSON.stringify(process.env));',
  '',
].join('\n'));

const compiledHome = path.join(workDir, 'compiled-home');
const compiledStore = path.join(workDir, 'compiled-home', 'Library', 'Application Support', 'claude-board');
const compiledRefRoots = path.join(workDir, 'compiled-home', '.claude', 'skills');
const compiledPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const compiledRepoRoot = path.join(workDir, 'compiled-repo');

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
const notifyBuild = spawnSync(ccCmd,
  ['-O2', '-Wall', '-Wextra', '-fobjc-arc', '-c', '-o', notifyObj, notifySrc], { encoding: 'utf8' });
const build = notifyBuild.status !== 0 ? notifyBuild : spawnSync(ccCmd,
  ['-O2', '-Wall', '-Wextra', '-o', launcherExec, '-I', headerDir, launcherSrc, notifyObj,
   '-framework', 'Foundation', '-framework', 'UserNotifications', '-framework', 'AppKit'], { encoding: 'utf8' });

async function main() {
  await check('the launcher compiles clean against the generated header', async () => {
    assert.equal(build.status, 0, `stdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
    assert.ok(existsSync(launcherExec), 'the launcher binary must exist after a clean build');
  });
  chmodSync(launcherExec, 0o755);

  // --- a no-argument launch WITHOUT the launchd marker: the stray-LaunchServices case ---

  await check('acceptance criterion: no-argument launch, no launchd marker -- starts no daemon', async () => {
    // Deliberately not process.env: a from-scratch object, so this is never accidentally
    // hidden by a marker this suite's own shell happens to carry.
    const run = spawnSync(launcherExec, [], { env: {}, encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, `a stray launch must exit cleanly, not crash: status ${run.status}, signal ${run.signal}\nstderr:\n${run.stderr}`);
    assert.equal(run.signal, null, 'a stray launch must not be killed by a signal');
    // The real proof, not just "printed nothing": the stub never ran at all, so it never
    // wrote its marker file -- the stand-in for "starts no daemon, writes nothing to the
    // store". (Ablation: delete the check in launcher.c's main() and this file exists.)
    assert.ok(!existsSync(ranMarkerFile), 'the daemon must never run for a stray launch -- no file it would have written may exist');
    assert.equal(run.stdout, '', 'nothing the stub daemon would have printed may appear -- it never ran');
  });

  await check('the refusal is silent: no alarming stderr, nothing that looks like a crash or a dialog trigger', async () => {
    const run = spawnSync(launcherExec, [], { env: {}, encoding: 'utf8', timeout: 10_000 });
    // "A log line the reviewer would only see if they went looking is fine" (the spec's
    // own words) -- so stderr may say something, but it must not be the exec-failure
    // line (which would read as a broken install) or anything implying a crash.
    assert.doesNotMatch(run.stderr || '', /cannot exec/, 'a stray launch must not look like a broken node install');
    assert.doesNotMatch(run.stderr || '', /Segmentation|Abort|Bus error/i, 'a stray launch must not look like a crash');
  });

  await check('a wrong-value marker is treated the same as a missing one -- exact match, not mere presence', async () => {
    for (const wrong of ['0', 'true', '', '2', 'launchd']) {
      const run = spawnSync(launcherExec, [], { env: { CLAUDE_BOARD_LAUNCHD_MARKER: wrong }, encoding: 'utf8', timeout: 10_000 });
      assert.equal(run.status, 0, `marker=${JSON.stringify(wrong)}: expected a clean refusal, got status ${run.status}`);
      assert.ok(!existsSync(ranMarkerFile), `marker=${JSON.stringify(wrong)}: the daemon must not have run`);
      rmSync(ranMarkerFile, { force: true }); // in case a bug let it through -- keep the next iteration honest
    }
  });

  // --- the SAME launch WITH the marker: the real-launchd case must be unaffected ---

  await check('acceptance criterion: the identical no-argument launch, WITH the launchd marker, still supervises', async () => {
    const run = spawnSync(launcherExec, [], {
      env: { CLAUDE_BOARD_LAUNCHD_MARKER: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.ok(existsSync(ranMarkerFile), 'a real launchd start must still start the daemon');
    let childEnv;
    assert.doesNotThrow(() => { childEnv = JSON.parse(run.stdout); }, 'the stub daemon\'s stdout must parse as the JSON environment dump it was told to print');
    assert.equal(childEnv.HOME, compiledHome, 'and it must be the SAME supervising path -- the compiled-in overrides still apply');
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
    console.log('\nall launcher-refuses checks ok');
  });
