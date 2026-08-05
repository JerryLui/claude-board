// Install-script check: runs install.sh TWICE against a temp
// CLAUDE_BOARD_LAUNCH_AGENTS_DIR / CLAUDE_BOARD_LOG_DIR and stub
// claude/launchctl executables, and asserts the second run is a no-op:
// exit 0 both times, exactly one plist (well-formed, absolute paths
// pointing at THIS clone, Label exactly "claude-board"), and exactly one
// MCP registration rather than two. Also runs uninstall.sh once, against
// the state the two install runs left behind, and asserts it undoes
// everything install.sh owns while leaving everything it does not
// (SPEC_LAUNCH.md criteria 9 and 11).
//
// Never touches the real ~/Library/LaunchAgents, ~/Library/Logs,
// ~/Library/Application Support/claude-board, or Claude MCP config, and never calls
// the real `launchctl` — everything install.sh/uninstall.sh would otherwise touch
// outside the repo is redirected into a temp dir via the testing-seam env vars both
// scripts accept (see their header comments). No browser, no network.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
// The installer writes the reference allowlist into the plist, and that value is the
// only place the shipped default exists (audit S3, 2026-07-31 -- src/resolve.mjs reads
// an absent variable as an empty allowlist on purpose). Imported rather than copied so
// the two cannot drift.
import { DEFAULT_REF_ROOTS } from '../src/resolve.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installScript = path.join(repoRoot, 'install.sh');
const uninstallScript = path.join(repoRoot, 'uninstall.sh');

const STUB_CLAUDE = `#!/usr/bin/env node
// Test stub standing in for the real \`claude\` CLI. Records every invocation
// and simulates just enough of \`mcp add\`/\`mcp remove --scope user\` to prove
// install.sh reconciles rather than duplicates: a JSON object keyed by
// server label.
import fs from 'node:fs';

const logPath = process.env.STUB_CLAUDE_LOG;
const statePath = process.env.STUB_CLAUDE_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; }
}
function saveState(state) { fs.writeFileSync(statePath, JSON.stringify(state, null, 2)); }

if (args[0] === 'mcp' && args[1] === 'remove') {
  const label = args[2];
  const state = loadState();
  if (!(label in state)) process.exit(1); // nothing to remove, like the real CLI
  delete state[label];
  saveState(state);
  process.exit(0);
} else if (args[0] === 'mcp' && args[1] === 'add') {
  const label = args[2];
  const scopeIdx = args.indexOf('--scope');
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : null;
  const dashIdx = args.indexOf('--');
  const command = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];
  const state = loadState();
  state[label] = { scope, command };
  saveState(state);
  process.exit(0);
} else {
  process.exit(1);
}
`;

const STUB_LAUNCHCTL = `#!/usr/bin/env node
// Test stub standing in for the real launchctl. Records every invocation and
// never touches the real launchd session. This is the "skip or stub anything
// that would genuinely load a launchd job" seam.
//
// It does NOT always succeed, because the real thing does not: \`bootout\`
// returns as soon as the job is asked to stop, and a \`bootstrap\` landing while
// a KeepAlive job is still tearing down is refused (EBUSY, "service already
// loaded"). A stub that always exits 0 turns the idempotency proof into an
// artifact — the reinstall path it certifies is the one path that fails on a
// real machine. So: the first bootstrap after each bootout fails, exactly once.
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LAUNCHCTL_LOG, JSON.stringify(args) + '\\n');
const statePath = process.env.STUB_LAUNCHCTL_STATE;
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
const writeState = s => fs.writeFileSync(statePath, JSON.stringify(s));
if (args[0] === 'bootout') {
  writeState({ tearingDown: true });
  process.exit(0);
}
if (args[0] === 'bootstrap') {
  const state = readState();
  if (state.tearingDown) {
    writeState({ tearingDown: false });
    process.stderr.write('Bootstrap failed: 37: Operation already in progress\\n');
    process.exit(37);
  }
  process.exit(0);
}
process.exit(0);
`;

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-install-check-'));
const launchAgentsDir = path.join(workDir, 'LaunchAgents');
const logDir = path.join(workDir, 'Logs');
const binDir = path.join(workDir, 'bin');
// Where install.sh builds the launcher bundle. A seam like every other one here, and
// load-bearing for the same reason: without it these runs would build, sign and delete
// a real ~/Applications/claude-board.app on the machine running the suite -- and the
// uninstall check below would remove the developer's own working launcher along with
// the TCC grant attached to it.
const appDir = path.join(workDir, 'Applications');
mkdirSync(binDir, { recursive: true });

// The store: install.sh/uninstall.sh never write to it, but uninstall.sh has to
// REPORT its path, and the whole point of criterion 11 is that uninstall must never
// touch it. Pre-populated with a fake board so "the store survives uninstall" is a
// claim about real bytes on disk, not just a directory existing.
const storeDir = path.join(workDir, 'Store');
mkdirSync(path.join(storeDir, 'boards'), { recursive: true });
const storeBoardFile = path.join(storeDir, 'boards', 'fake-board.json');
const storeBoardContent = JSON.stringify({ id: 'fake-board', title: 'a board that must survive uninstall' });
writeFileSync(storeBoardFile, storeBoardContent);

// The pomodoro document (ADR.md entry 8, ticket 06): the ONE file inside the store
// uninstall.sh IS meant to remove, by exact name. Pre-populated with real bytes for
// the same reason storeBoardFile is -- "gone after uninstall" has to be a claim about
// a real file that really existed, not an absent-either-way accident.
const pomodoroFile = path.join(storeDir, 'pomodoro.json');
writeFileSync(pomodoroFile, JSON.stringify({ deadline: 1234567890, cycles: 2, workMinutes: 25 }));

const claudeStub = path.join(binDir, 'claude-stub.mjs');
const launchctlStub = path.join(binDir, 'launchctl-stub.mjs');
writeFileSync(claudeStub, STUB_CLAUDE);
writeFileSync(launchctlStub, STUB_LAUNCHCTL);
chmodSync(claudeStub, 0o755);
chmodSync(launchctlStub, 0o755);

const claudeLog = path.join(workDir, 'claude-invocations.log');
const claudeState = path.join(workDir, 'claude-registrations.json');
const launchctlLog = path.join(workDir, 'launchctl-invocations.log');
const launchctlState = path.join(workDir, 'launchctl-state.json');

// install.sh refuses to report success until the daemon answers /api/health, so the
// check has to stand something up on the port it will poll. Not the real daemon (the
// stub launchctl deliberately starts nothing) — just enough of the endpoint to prove
// the gate passes when something IS listening, and, on a closed port, that it fails.
//
// In its own process, not this one: every install run below is a spawnSync, which
// blocks this event loop for its whole duration, so an in-process listener would
// accept nothing exactly while the script is polling it.
const healthStub = path.join(binDir, 'health-stub.mjs');
writeFileSync(healthStub, `import http from 'node:http';
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 'stub' }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.argv[2]), '127.0.0.1');
`);

// Bind an ephemeral port, note it, release it — then hand that port to the stub.
const healthPort = await new Promise(resolve => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const healthProc = spawn(process.execPath, [healthStub, String(healthPort)], { stdio: 'ignore' });
// Wait until it is actually answering, so no install run below races its startup.
for (let i = 0; i < 50; i++) {
  if (spawnSync('curl', ['-fsS', '--max-time', '1', `http://127.0.0.1:${healthPort}/api/health`]).status === 0) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}

// The local secret install.sh generates, redirected into this temp dir. Load-bearing:
// without this seam every run below would create (and, if the idempotency guarantee
// ever broke, rotate) the REAL ~/.config/claude-board/secret on this machine.
const secretFile = path.join(workDir, 'config', 'claude-board', 'secret');

// install.sh step 6 copies the board's manual into a personal skills directory. Seamed
// for the same reason the secret above is: without it, every run of this suite would
// write into the real ~/.claude/skills on the developer's machine.
const skillsDir = path.join(workDir, 'skills');
const installedSkill = path.join(skillsDir, 'claude-board', 'SKILL.md');

const env = {
  ...process.env,
  CLAUDE_BOARD_SKILLS_DIR: skillsDir,
  CLAUDE_BOARD_SECRET_FILE: secretFile,
  CLAUDE_BOARD_LAUNCH_AGENTS_DIR: launchAgentsDir,
  CLAUDE_BOARD_LOG_DIR: logDir,
  CLAUDE_BOARD_APP_DIR: appDir,
  CLAUDE_BOARD_HOME: storeDir,
  CLAUDE_BOARD_MCP_CMD: claudeStub,
  CLAUDE_BOARD_LAUNCHCTL_CMD: launchctlStub,
  CLAUDE_BOARD_PORT: String(healthPort),
  STUB_CLAUDE_LOG: claudeLog,
  STUB_CLAUDE_STATE: claudeState,
  STUB_LAUNCHCTL_LOG: launchctlLog,
  STUB_LAUNCHCTL_STATE: launchctlState,
};
// Never inherit this check process's own reference allowlist: the plist assertion
// below is about install.sh's resolved DEFAULT, and a developer who exports
// CLAUDE_BOARD_REF_ROOTS in their shell would otherwise fail a check about it.
delete env.CLAUDE_BOARD_REF_ROOTS;

function runInstall() {
  return spawnSync('bash', [installScript], { env, encoding: 'utf8' });
}

/** Stub log/state paths of a check's own, for an install run that exists to prove
 * something else entirely. The reconciliation checks below count `mcp add` and `bootout`
 * invocations in the SHARED logs and assert exactly one per install run, so any extra
 * run sharing those files turns a real guarantee into an arithmetic accident. */
function quietStubs(tag) {
  return {
    STUB_CLAUDE_LOG: path.join(workDir, `claude-invocations-${tag}.log`),
    STUB_CLAUDE_STATE: path.join(workDir, `claude-registrations-${tag}.json`),
    STUB_LAUNCHCTL_LOG: path.join(workDir, `launchctl-invocations-${tag}.log`),
    STUB_LAUNCHCTL_STATE: path.join(workDir, `launchctl-state-${tag}.json`),
  };
}

// --- a source edit must not restart the daemon --------------------------------
//
// This section used to prove the opposite: a daemon spawned with
// CLAUDE_BOARD_RELOAD_ON_CHANGE=1 watching src/ and exiting on a change there. That
// mechanism is gone (see the check below and bin/daemon.mjs), and what is proved here
// now is that a real bin/daemon.mjs stays up when its own source changes underneath it,
// even with the old env var set.
//
// Runs against a TEMP COPY of src/ and bin/, never this repo's own tree -- touching a
// tracked file to prove anything about a watcher would be a side effect on the actual
// worktree, and "revert it afterwards" is one uncaught exception away from leaving a
// dirty tree behind. bin/daemon.mjs only imports from '../src/*.mjs' and nothing outside
// that pair (checked: no src/*.mjs file reads anything by a path outside src/ except
// server.mjs's own-version read of package.json, which is wrapped in try/catch and
// defaults to '0.0.0' when absent), so the copy is a fully working daemon on its own.

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

/** Poll GET /api/health until it answers or `deadlineMs` runs out. */
async function waitForHealthy(port, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** Resolves `true` if `child` exits within `deadlineMs`, `false` if it is still
 * running (left running either way -- the caller kills it). Never rejects: a check
 * that hangs here is the one thing test/run.mjs's process-group kill exists to catch,
 * but this file should not depend on that backstop when a plain timeout does the job.
 *
 * Waits for 'close', not 'exit': 'exit' fires as soon as the process is gone but does
 * not guarantee its stdio has finished delivering, and every caller reads accumulated
 * stderr the instant this resolves to assert on the daemon's own log line. 'close'
 * is the event node documents as waiting for the stdio streams too. */
function waitForExit(child, deadlineMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, deadlineMs);
    timer.unref();
    child.once('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A fresh temp copy of src/ + bin/, and a fresh bin/daemon.mjs spawned from it on its
 * own ephemeral port, CLAUDE_BOARD_HOME and CLAUDE_BOARD_SECRET_FILE -- isolated from
 * every other check in this suite and from the real repo tree. Resolves once
 * /api/health answers; throws (after cleaning up) if it never does. */
async function spawnSourceEditDaemon() {
  // Everything from here down is wrapped so ANY failure -- a full disk on cpSync, a
  // port race in freePort(), spawn() itself throwing -- still removes rWorkDir and
  // kills whatever child made it as far as spawning, rather than leaking either. The
  // alternative (only cleaning up the "never got healthy" case) misses exactly the
  // failures that are least expected, which is the shape of leak that turns into a
  // pile of /tmp/claude-board-srcedit-* directories nobody notices until disk pressure.
  const rWorkDir = mkdtempSync(path.join(tmpdir(), 'claude-board-srcedit-'));
  let child;
  try {
    cpSync(path.join(repoRoot, 'src'), path.join(rWorkDir, 'src'), { recursive: true });
    cpSync(path.join(repoRoot, 'bin'), path.join(rWorkDir, 'bin'), { recursive: true });
    const daemonCopy = path.join(rWorkDir, 'bin', 'daemon.mjs');
    const home = path.join(rWorkDir, 'home');
    mkdirSync(home, { recursive: true });
    const rSecretFile = path.join(rWorkDir, 'secret');
    writeFileSync(rSecretFile, 'f'.repeat(64), { mode: 0o600 });
    const port = await freePort();

    const rEnv = {
      ...process.env,
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_SECRET_FILE: rSecretFile,
      CLAUDE_BOARD_PORT: String(port),
    };
    // Set, not deleted: the point of the check this feeds is that the variable the
    // daemon once honoured is inert now, wherever it survives -- a stale plist, a
    // developer's exported shell env.
    rEnv.CLAUDE_BOARD_RELOAD_ON_CHANGE = '1';

    child = spawn(process.execPath, [daemonCopy], { env: rEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { err += c.toString(); });

    const healthy = await waitForHealthy(port, 8000);
    if (!healthy) {
      throw new Error(`source-edit-check daemon never answered /api/health\nstdout:\n${out}\nstderr:\n${err}`);
    }

    return {
      child,
      srcFile: path.join(rWorkDir, 'src', 'store.mjs'),
      stderr: () => err,
      cleanup() {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        rmSync(rWorkDir, { recursive: true, force: true });
      },
    };
  } catch (caught) {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    rmSync(rWorkDir, { recursive: true, force: true });
    throw caught;
  }
}

/** Spawn a real `bin/daemon.mjs` with whatever extra environment the caller passes
 * (typically CLAUDE_BOARD_REF_ROOTS/SERVE_ROOTS) and nothing else from this process.
 * Used to prove that src/resolve.mjs actually enforces a given roots value against a
 * real running daemon and a real HTTP request -- independent of HOW that value reaches
 * the daemon at runtime. On the degraded (no-launcher) path that delivery mechanism is
 * still the plist directly; with a launcher bundle in use it is bin/launcher.c's
 * compiled-in OVERRIDE_ENV instead (install.sh no longer writes these into the plist at
 * all -- see "the plist stops carrying what the launcher now bakes"), and THAT half of
 * the chain -- the launcher actually delivering the right value and nothing else -- is
 * proven separately, in full isolation, by test/check-launcher-env.mjs.
 *
 * Only three things are added on top of the caller's env, and each for a reason that is
 * not about the value under test: PATH (launchd/the launcher supplies one), the
 * store/secret testing seams (so this never touches the real ~/Library/Application
 * Support or the real secret), and a free port (the plist's port belongs to this suite's
 * health stub, which is already bound).
 *
 * Resolves once /api/health answers, with the secret the caller needs to speak to it. */
async function spawnDaemonWithEnv(extraEnv) {
  const dWork = mkdtempSync(path.join(tmpdir(), 'claude-board-envcheck-'));
  let child;
  try {
    const home = path.join(dWork, 'home');
    mkdirSync(home, { recursive: true });
    const dSecretFile = path.join(dWork, 'secret');
    const secret = 'b'.repeat(64);
    writeFileSync(dSecretFile, secret, { mode: 0o600 });
    const port = await freePort();

    const dEnv = {
      ...extraEnv,
      PATH: process.env.PATH,
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_SECRET_FILE: dSecretFile,
      CLAUDE_BOARD_PORT: String(port),
    };

    child = spawn(process.execPath, [path.join(repoRoot, 'bin', 'daemon.mjs')], {
      env: dEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', c => { err += c.toString(); });

    if (!await waitForHealthy(port, 8000)) {
      throw new Error(`env-check daemon never answered /api/health\nstderr:\n${err}`);
    }
    return {
      port,
      secret,
      cleanup() {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        rmSync(dWork, { recursive: true, force: true });
      },
    };
  } catch (caught) {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    rmSync(dWork, { recursive: true, force: true });
    throw caught;
  }
}

// What this machine's OWN installation looks like before a single script runs, so the
// last check in main() can prove the suite left it alone. A seam that is merely
// DOCUMENTED is not a seam that holds: one env object below forgot
// CLAUDE_BOARD_APP_DIR, uninstall.sh fell back to $HOME/Applications, and running the
// check suite deleted the developer's own launcher bundle — taking their daemon
// (launchd: "Missing executable", exit 78) and the TCC grant pinned to that bundle's
// signature with it. Nothing in the suite failed; it reported all green. The guard is
// deliberately about the real paths rather than about any one env object, so the NEXT
// spawn that forgets a seam is caught by the same assertion, whichever seam it forgets.
const REAL_PATHS = [
  path.join(process.env.HOME || '/nonexistent', 'Applications', 'claude-board.app'),
  path.join(process.env.HOME || '/nonexistent', 'Library', 'LaunchAgents', 'claude-board.plist'),
  path.join(process.env.HOME || '/nonexistent', '.config', 'claude-board', 'secret'),
  // Added with install.sh step 6, and immediately earned: the first run of the suite
  // after that step landed deleted this developer's real manual, because the
  // "nothing installed" uninstall below was spawned without CLAUDE_BOARD_SKILLS_DIR and
  // fell back to ~/.claude/skills. Exactly the APP_DIR incident of 2026-08-01, one seam
  // later. A new seam belongs on this list the moment it exists, not after it bites.
  path.join(process.env.HOME || '/nonexistent', '.claude', 'skills', 'claude-board', 'SKILL.md'),
];
const realPathsBefore = REAL_PATHS.map(p => existsSync(p));

async function main() {
  const first = runInstall();
  await check('first run exits 0', async () => {
    if (first.status !== 0) {
      throw new Error(`exit ${first.status}\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    }
  });

  // Captured between the two runs: the whole point of the assertion below is that the
  // SECOND run leaves this exact byte string alone.
  const secretAfterFirst = existsSync(secretFile) ? readFileSync(secretFile, 'utf8') : null;

  const second = runInstall();
  await check('second run exits 0 (idempotent)', async () => {
    if (second.status !== 0) {
      throw new Error(`exit ${second.status}\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    }
  });

  // --- the local secret -------------------------------------------------------
  //
  // DESIGN.md Decisions -> "A loopback Host check, an origin check, and a local
  // secret". install.sh owns generating it, because it is the one place that runs once
  // per machine and can set the modes before anything is written into the file.

  await check('install generates a local secret with real entropy, 0600, in a 0700 directory', async () => {
    assert.ok(existsSync(secretFile), 'install.sh must generate the local secret the daemon requires for writes');
    const raw = readFileSync(secretFile, 'utf8');
    const secret = raw.trim();
    // 32 bytes of crypto.randomBytes as hex. (Ablation: a date/pid-derived "secret" is
    // guessable by any local process, which is exactly the caller this gate exists to
    // exclude; the length assertion is what stops that being a one-line substitution.)
    assert.ok(/^[0-9a-f]{64,}$/.test(secret), `the secret must be at least 32 random bytes rendered as hex, got ${JSON.stringify(secret.slice(0, 16))}...`);
    assert.ok(Buffer.from(secret, 'hex').length >= 32, 'at least 32 bytes of entropy');
    // (Ablation: dropping the `umask 077` / chmod pair gives 0644 under the usual
    // umask -- world-readable, i.e. handing the credential to the process it excludes.)
    assert.equal(statSync(secretFile).mode & 0o777, 0o600, 'the secret file must be owner-read/write only');
    assert.equal(statSync(path.dirname(secretFile)).mode & 0o777, 0o700, 'its directory must be owner-only too');
  });

  await check('a second install does NOT rotate an existing secret (every live session would 401)', async () => {
    assert.ok(secretAfterFirst, 'the first run must have created it');
    const secretAfterSecond = readFileSync(secretFile, 'utf8');
    // (Ablation: generate unconditionally -- drop the `if [ -s "$SECRET_FILE" ]` guard
    // -- and these differ, which on a real machine means every shim already running
    // holds a stale credential and every `ask` in flight starts failing with 401.)
    assert.equal(secretAfterSecond, secretAfterFirst, 'a reinstall must leave an existing secret byte-for-byte alone');
  });

  await check('exactly one plist is written', async () => {
    const files = existsSync(launchAgentsDir) ? readdirSync(launchAgentsDir) : [];
    assert.deepEqual(files, ['claude-board.plist']);
  });

  const plistPath = path.join(launchAgentsDir, 'claude-board.plist');

  await check('plutil -lint accepts the plist', async () => {
    const r = spawnSync('plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  let plist;
  await check('plist converts to JSON', async () => {
    const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    plist = JSON.parse(r.stdout);
  });

  await check('Label is exactly "claude-board" (the shim\'s revive command depends on this)', async () => {
    assert.equal(plist.Label, 'claude-board');
  });

  await check('ProgramArguments runs the launcher bundle, by absolute path and with no arguments', async () => {
    // The bundle is what macOS attributes the daemon's file reads to, so the plist has
    // to name it rather than node -- see install.sh step 1b and bin/launcher.c. One
    // element, not two: the daemon path is compiled into the launcher precisely so that
    // rewriting this plist cannot retarget an application the user granted a folder to.
    assert.equal(plist.ProgramArguments.length, 1, `expected just the launcher, got ${JSON.stringify(plist.ProgramArguments)}`);
    assert.ok(path.isAbsolute(plist.ProgramArguments[0]), 'the launcher path must be absolute');
    assert.equal(plist.ProgramArguments[0], path.join(appDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'));
  });

  await check('the launcher bundle is built, signed, and actually starts this clone\'s daemon', async () => {
    const appPath = path.join(appDir, 'claude-board.app');
    const exec = path.join(appPath, 'Contents', 'MacOS', 'claude-board');
    assert.ok(existsSync(exec), 'install.sh must build the launcher executable');

    const info = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' });
    assert.equal(info.status, 0, info.stderr);
    const infoPlist = JSON.parse(info.stdout);
    assert.equal(infoPlist.CFBundleIdentifier, 'io.github.jerrylui.claude-board', 'the bundle id IS the name of the TCC grant; changing it silently costs every user their grant');
    assert.equal(infoPlist.LSBackgroundOnly, true, 'a daemon must not take a Dock icon at login');

    // Ad-hoc signed, and verifiably so: an unsigned bundle gets no stable TCC identity
    // at all, which is the entire reason this bundle exists.
    const verify = spawnSync('codesign', ['--verify', '--verbose', appPath], { encoding: 'utf8' });
    assert.equal(verify.status, 0, `the bundle must verify:\n${verify.stderr}`);
    const display = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
    assert.match(display.stderr, /Identifier=io\.github\.jerrylui\.claude-board/, 'the signed identifier must be the bundle id, not a name derived from the file');

    // And it must really run the daemon: the launcher forks node (never execs it -- see
    // bin/launcher.c) and the compiled-in path has to be this clone's. Proven by
    // running it, rather than by reading the binary: CLAUDE_BOARD_PORT=0 would have the
    // real daemon bind an ephemeral port, so instead this asserts on the one thing a
    // wrong path produces, which is the launcher's own exec failure.
    const ran = spawnSync(exec, [], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CLAUDE_BOARD_PORT: String(healthPort) }, // already bound: the daemon exits, fast
    });
    assert.doesNotMatch(ran.stderr || '', /cannot exec/, `the launcher must be able to exec its compiled-in node:\n${ran.stderr}`);
  });

  await check('the bundle carries a byte-identical copy of bin/daemon.mjs and src/, staged before signing', async () => {
    // The payload half of the hole this task closes: bin/daemon.mjs and everything under
    // src/ used to live only in the clone, outside the signature and outside the rebuild
    // stamp. install.sh now copies both into Contents/Resources before codesign runs
    // (see install.sh step 1b), so this asserts the copy is complete and exact against
    // THIS repo's own real files -- runInstall() above ran install.sh with REPO_DIR set
    // to this actual clone, not a throwaway one.
    const appPath = path.join(appDir, 'claude-board.app');
    const resourcesBin = path.join(appPath, 'Contents', 'Resources', 'bin', 'daemon.mjs');
    const resourcesSrc = path.join(appPath, 'Contents', 'Resources', 'src');
    assert.ok(
      readFileSync(resourcesBin).equals(readFileSync(path.join(repoRoot, 'bin', 'daemon.mjs'))),
      'the bundled bin/daemon.mjs must be byte-identical to the clone\'s',
    );

    function listFiles(dir) {
      let out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out = out.concat(listFiles(full));
        else out.push(full);
      }
      return out;
    }
    const realSrcDir = path.join(repoRoot, 'src');
    const realSrcFiles = listFiles(realSrcDir).map(f => path.relative(realSrcDir, f)).sort();
    const bundledSrcFiles = listFiles(resourcesSrc).map(f => path.relative(resourcesSrc, f)).sort();
    assert.deepEqual(bundledSrcFiles, realSrcFiles, 'the bundle must carry exactly the same set of files under src/ as the clone -- not a subset, not extras');
    for (const rel of realSrcFiles) {
      assert.ok(
        readFileSync(path.join(resourcesSrc, rel)).equals(readFileSync(path.join(realSrcDir, rel))),
        `src/${rel} must be byte-identical inside the bundle`,
      );
    }

    // Not staged, deliberately: bin/mcp.mjs and bin/authorize.mjs are the shim,
    // registered with Claude Code (or invoked by a user) at THIS clone's own absolute
    // path and never run through the launcher, so a copy inside the bundle would be dead
    // weight nothing points at; bin/launcher.c is a build input, never executed as itself.
    for (const notStaged of ['mcp.mjs', 'authorize.mjs', 'launcher.c']) {
      assert.ok(!existsSync(path.join(appPath, 'Contents', 'Resources', 'bin', notStaged)), `bin/${notStaged} must not be staged into the bundle`);
    }
  });

  await check('a reinstall leaves an unchanged launcher bundle byte-identical (a rebuild would reset its TCC grant)', async () => {
    // The whole point of the stamp in install.sh step 1b. macOS pins a Files-and-Folders
    // grant to the code signature, so rebuilding the bundle on a run that changed
    // nothing would silently revoke the user's grant -- on every routine `git pull &&
    // ./install.sh`, which is the ordinary way to take an update.
    //
    // (Ablation: delete the stamp comparison and rebuild unconditionally, and the
    // digest below changes between the two runs this suite already made.)
    const exec = path.join(appDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    const before = readFileSync(exec);
    // The payload's own mtime, not just its content: "already current" must not even
    // RE-COPY bin/daemon.mjs and src/ into an unchanged bundle -- a copy that happened to
    // reproduce the same bytes would still be indistinguishable from a rebuild by content
    // alone, but not by mtime. (Ablation: run stage_daemon_payload unconditionally,
    // outside the already-current branch, and this mtime moves even though the bytes
    // read back identical.)
    const payloadFile = path.join(appDir, 'claude-board.app', 'Contents', 'Resources', 'bin', 'daemon.mjs');
    const payloadMtimeBefore = statSync(payloadFile).mtimeMs;
    const r = spawnSync('bash', [installScript], { env: { ...env, ...quietStubs('rebuild-noop') }, encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.deepEqual(readFileSync(exec), before, 'a no-op reinstall must not rewrite the launcher');
    assert.match(r.stdout, /already current/, 'and it must say so, rather than rebuilding silently');
    assert.equal(statSync(payloadFile).mtimeMs, payloadMtimeBefore, 'a no-op reinstall must not even re-copy the payload into an unchanged bundle');
  });

  await check('a launcher built from different inputs IS rebuilt', async () => {
    // The other half of the same rule: the stamp must not be a way to get stuck on a
    // stale binary. A changed node path is a changed launcher, because the path is
    // compiled in.
    const exec = path.join(appDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    const before = readFileSync(exec);
    const fakeNode = path.join(binDir, 'node-alias');
    cpSync(process.execPath, fakeNode);
    chmodSync(fakeNode, 0o755);
    const r = spawnSync('bash', [installScript], { env: { ...env, ...quietStubs('rebuild-node'), CLAUDE_BOARD_NODE: fakeNode }, encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.notDeepEqual(readFileSync(exec), before, 'a launcher whose baked-in node path changed must be rebuilt');
    // Put the bundle back the way the rest of the suite expects to find it.
    spawnSync('bash', [installScript], { env: { ...env, ...quietStubs('rebuild-restore') }, encoding: 'utf8' });
  });

  // --- a rogue launcher_paths.h next to bin/launcher.c must not reach the build --------
  //
  // bin/launcher.c pulls in its generated header with a QUOTED #include, and a quoted
  // include searches the including file's own directory before any -I/-iquote path.
  // Compiling bin/launcher.c in place, straight out of the clone, would mean that search
  // starts in bin/ -- so a launcher_paths.h planted there (an attacker's, or a leftover
  // from an older install.sh that used to generate the header in place) shadows the real
  // one this script writes into its build directory, and the shadow's paths are what get
  // compiled into a bundle macOS then trusts with the Documents grant. The fix in
  // install.sh step 1b is structural: the source is copied into the same staging
  // directory as the real header and compiled from there with -iquote (no -I back into
  // the clone), so the quoted include's own-directory search lands on the real header no
  // matter what sits beside bin/launcher.c.
  await check('a rogue header placed next to the launcher source cannot influence the built binary', async () => {
    // A full, throwaway clone under workDir -- not this repo's own bin/, which must stay
    // clean -- holding just what install.sh needs to find (bin/daemon.mjs, bin/mcp.mjs,
    // bin/launcher.c) plus install.sh itself.
    const rogueDir = path.join(workDir, 'clone-with-rogue-header');
    try {
      mkdirSync(path.join(rogueDir, 'bin'), { recursive: true });
      writeFileSync(path.join(rogueDir, 'bin', 'daemon.mjs'), '// stub, never executed by install.sh itself\n');
      writeFileSync(path.join(rogueDir, 'bin', 'mcp.mjs'), '// stub\n');
      // install.sh now requires src/ to exist and stages it into the bundle -- a stub is
      // enough, since this clone's daemon is never actually run.
      mkdirSync(path.join(rogueDir, 'src'), { recursive: true });
      writeFileSync(path.join(rogueDir, 'src', 'stub.mjs'), '// stub\n');
      writeFileSync(path.join(rogueDir, 'bin', 'launcher.c'), readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8'));
      // The launcher's other half (ADR.md entry 19), a build input on the same footing as
      // launcher.c: install.sh copies both into its staging directory unconditionally, and
      // launcher.c does not link without it. The icns is deliberately NOT copied here --
      // it is the optional input, and a clone without one must still build a bundle.
      writeFileSync(path.join(rogueDir, 'bin', 'notify.m'), readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8'));
      writeFileSync(path.join(rogueDir, 'install.sh'), readFileSync(installScript, 'utf8'));

      const rogueNodePath = '/tmp/rogue-node-must-never-be-baked-in';
      const rogueDaemonPath = '/tmp/rogue-daemon-must-never-be-baked-in';
      writeFileSync(path.join(rogueDir, 'bin', 'launcher_paths.h'), [
        '/* planted next to bin/launcher.c -- must have zero effect on the build */',
        `#define CLAUDE_BOARD_NODE "${rogueNodePath}"`,
        `#define CLAUDE_BOARD_DAEMON "${rogueDaemonPath}"`,
        '',
      ].join('\n'));

      const rogueAgents = path.join(workDir, 'LaunchAgents-rogue');
      const rogueAppDir = path.join(workDir, 'Applications-rogue');
      const rogueStubs = quietStubs('rogue-header');
      const r = spawnSync('bash', [path.join(rogueDir, 'install.sh')], {
        env: {
          ...env,
          CLAUDE_BOARD_LAUNCH_AGENTS_DIR: rogueAgents,
          CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-rogue'),
          CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-rogue', 'claude-board', 'secret'),
          CLAUDE_BOARD_APP_DIR: rogueAppDir,
          ...rogueStubs,
        },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `install must still succeed with a rogue header present:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      assert.match(r.stdout, /warning:.*launcher_paths\.h/, 'install.sh must name the leftover header and say it is being ignored');
      assert.doesNotMatch(r.stdout, /error/i, 'the warning must be non-fatal');

      const builtExec = path.join(rogueAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
      assert.ok(existsSync(builtExec), 'the launcher must still build');
      const built = readFileSync(builtExec);

      // The real paths: the BUNDLED copy of this throwaway clone's bin/daemon.mjs (not
      // the clone's own path -- CLAUDE_BOARD_DAEMON now names the copy staged into
      // Contents/Resources), and whichever node interpreter install.sh actually resolved
      // for it (read back from the quiet stub's own MCP registration, which records
      // exactly what install.sh chose).
      const realDaemonPath = path.join(rogueAppDir, 'claude-board.app', 'Contents', 'Resources', 'bin', 'daemon.mjs');
      const rogueState = JSON.parse(readFileSync(rogueStubs.STUB_CLAUDE_STATE, 'utf8'));
      const realNodePath = rogueState['claude-board'].command[0];
      assert.ok(path.isAbsolute(realNodePath));

      assert.ok(built.includes(Buffer.from(`${realDaemonPath}\0`, 'utf8')), 'the built binary must carry the real, compiled-in daemon path');
      assert.ok(built.includes(Buffer.from(`${realNodePath}\0`, 'utf8')), 'the built binary must carry the real, compiled-in node path');
      assert.ok(!built.includes(Buffer.from(rogueDaemonPath, 'utf8')), 'the rogue daemon path must not appear anywhere in the built binary');
      assert.ok(!built.includes(Buffer.from(rogueNodePath, 'utf8')), 'the rogue node path must not appear anywhere in the built binary');
      // And the payload itself actually landed, byte-identical -- the rogue header must
      // have zero effect on this half of the build either.
      assert.equal(
        readFileSync(path.join(rogueAppDir, 'claude-board.app', 'Contents', 'Resources', 'src', 'stub.mjs'), 'utf8'),
        '// stub\n',
      );
    } finally {
      rmSync(rogueDir, { recursive: true, force: true });
    }
  });

  // --- the stamp must cover the produced binary, not just its inputs -------------------

  await check('re-running the installer after the bundle\'s executable has been altered rebuilds it instead of reporting it as already current', async () => {
    // Isolated from every other run in this suite: its own LaunchAgents, Applications,
    // secret and logs, so the assertions below are about this one bundle's lifecycle
    // and nothing shared with the rest of main().
    const tAgents = path.join(workDir, 'LaunchAgents-tamper');
    const tAppDir = path.join(workDir, 'Applications-tamper');
    const tEnv = {
      ...env,
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: tAgents,
      CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-tamper'),
      CLAUDE_BOARD_APP_DIR: tAppDir,
      CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-tamper', 'claude-board', 'secret'),
    };
    const exec = path.join(tAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');

    // 1. a fresh install builds the bundle.
    const first = spawnSync('bash', [installScript], { env: { ...tEnv, ...quietStubs('tamper-1') }, encoding: 'utf8' });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    assert.match(first.stdout, /built and signed/, 'the first run must build the bundle');
    assert.ok(existsSync(exec), 'the executable must exist after the first run');

    // 2. an untouched reinstall is the no-re-prompt guarantee the whole task exists to
    // protect: "already current", and nothing rewritten.
    const untouched = readFileSync(exec);
    const second = spawnSync('bash', [installScript], { env: { ...tEnv, ...quietStubs('tamper-2') }, encoding: 'utf8' });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /already current/, 'an untouched reinstall must report the bundle as already current');
    assert.doesNotMatch(second.stdout, /built and signed/, 'and must not rebuild');
    assert.deepEqual(readFileSync(exec), untouched, 'an untouched reinstall must not rewrite the executable');

    // 3. the executable is altered directly -- none of install.sh's own INPUTS changed,
    // only the bytes it produced last time -- and the next run must rebuild rather than
    // trust a stamp that no longer describes what is actually on disk.
    const tampered = Buffer.concat([untouched, Buffer.from([0])]);
    writeFileSync(exec, tampered);
    const third = spawnSync('bash', [installScript], { env: { ...tEnv, ...quietStubs('tamper-3') }, encoding: 'utf8' });
    assert.equal(third.status, 0, `stdout:\n${third.stdout}\nstderr:\n${third.stderr}`);
    assert.match(third.stdout, /built and signed/, 'an altered executable must be rebuilt');
    assert.doesNotMatch(third.stdout, /already current/, 'and must not be reported as already current');
    // The rebuild is deterministic (same inputs as run 1), so the fixed point to check
    // against is the tampered bytes, not the pre-tamper original -- a rebuild that
    // reproduces the original exactly is exactly what "rebuilt" should mean here.
    assert.notDeepEqual(readFileSync(exec), tampered, 'the rebuilt executable must differ from the tampered one');
    assert.deepEqual(readFileSync(exec), untouched, 'and, since nothing else changed, must reproduce the original bytes exactly');
  });

  await check('install still succeeds without a compiler, degrading loudly instead of failing', async () => {
    // A machine with no Xcode Command Line Tools must still get a working daemon --
    // just one that cannot read a reference out of ~/Documents. Loud, and not fatal.
    const noCcAppDir = path.join(workDir, 'Applications-nocc');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_APP_DIR: noCcAppDir,
        CLAUDE_BOARD_CC: path.join(binDir, 'definitely-not-a-compiler'),
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-nocc', 'claude-board', 'secret'),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(workDir, 'LaunchAgents-nocc'),
        ...quietStubs('nocc'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `a missing compiler must not fail the install:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /warning: no C compiler/, 'it must say why, in as many words');
    assert.match(r.stdout, /EPERM/, 'and name the symptom the user will otherwise hit with no explanation');
    assert.ok(!existsSync(path.join(noCcAppDir, 'claude-board.app')), 'no bundle should have been built');

    // ...and the plist it wrote falls back to running node directly, so the daemon
    // still comes up.
    const fallback = spawnSync('plutil', ['-convert', 'json', '-o', '-',
      path.join(workDir, 'LaunchAgents-nocc', 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(fallback.status, 0, fallback.stderr);
    const fallbackPlist = JSON.parse(fallback.stdout);
    const args = fallbackPlist.ProgramArguments;
    assert.equal(args.length, 2, 'the fallback plist runs node with the daemon script');
    assert.equal(args[1], path.join(repoRoot, 'bin', 'daemon.mjs'));

    // With no launcher to bake CLAUDE_BOARD_REF_ROOTS/SERVE_ROOTS/HOME into, node reads
    // its environment from the plist directly -- so on THIS path, unlike the launcher
    // path asserted elsewhere in this suite, the dict must still carry them exactly as
    // it always did. Losing them here would mean a degraded install silently serves
    // nothing and references nothing, with no allowlist reaching the daemon at all.
    assert.equal(
      fallbackPlist.EnvironmentVariables.CLAUDE_BOARD_REF_ROOTS,
      DEFAULT_REF_ROOTS.map(r => path.join(process.env.HOME, r.slice(2))).join(':'),
      'the degraded plist must carry the reference roots itself -- there is no launcher to bake them into',
    );
    assert.ok('CLAUDE_BOARD_SERVE_ROOTS' in fallbackPlist.EnvironmentVariables, 'and the serve roots too');
  });

  await check('RunAtLoad and KeepAlive are set', async () => {
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.KeepAlive, true);
  });

  await check('the plist asks for no automatic reload at all: no WatchPaths, no reload env var', async () => {
    // Structural half of the decision that the installed daemon only restarts when
    // somebody asks it to (./install.sh, or a kickstart). The behavioural half — that
    // a running daemon does NOT die when src/ changes underneath it — is the check
    // further below, which spawns a real daemon over a temp copy and edits it.
    //
    // (Ablation: reintroducing a `WatchPaths` array here beside `KeepAlive: true` is
    // the dead-mechanism claim SPEC_LAUNCH.md criterion 17 forbids — see QUIRKS.md
    // "WatchPaths does not restart the daemon" — so this fails on purpose if it comes
    // back. So does re-adding CLAUDE_BOARD_RELOAD_ON_CHANGE, which is the live
    // mechanism that WAS shipped and is now deliberately gone.)
    assert.ok(!('WatchPaths' in plist), 'WatchPaths is inert beside KeepAlive and must not be in the generated plist');
    assert.ok(plist.EnvironmentVariables, 'the plist must carry an EnvironmentVariables dict');
    assert.ok(!('CLAUDE_BOARD_RELOAD_ON_CHANGE' in plist.EnvironmentVariables), 'the installed daemon must not be opted into reload-on-change: a restart mid-review drops every SSE stream and every held-open wait');
  });

  await check('stdout/stderr are redirected to absolute log paths', async () => {
    assert.ok(path.isAbsolute(plist.StandardOutPath));
    assert.ok(path.isAbsolute(plist.StandardErrorPath));
  });

  await check('exactly one MCP registration exists after two runs, pointing at this clone', async () => {
    const state = JSON.parse(readFileSync(claudeState, 'utf8'));
    const labels = Object.keys(state);
    assert.deepEqual(labels, ['claude-board']);
    const reg = state['claude-board'];
    assert.equal(reg.scope, 'user');
    assert.equal(reg.command.length, 2);
    assert.ok(path.isAbsolute(reg.command[0]), 'node interpreter path must be absolute');
    assert.equal(reg.command[1], path.join(repoRoot, 'bin', 'mcp.mjs'));
  });

  await check('install.sh reconciles rather than errors: remove is attempted before every add', async () => {
    const lines = readFileSync(claudeLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const adds = lines.filter(l => l[0] === 'mcp' && l[1] === 'add');
    const removes = lines.filter(l => l[0] === 'mcp' && l[1] === 'remove');
    assert.equal(adds.length, 2, 'one add per install.sh run');
    assert.equal(removes.length, 2, 'one reconciling remove attempt per install.sh run');
  });

  await check('launchd is (re)loaded idempotently: bootout/bootstrap/enable/kickstart each run, never the real launchctl', async () => {
    const lines = readFileSync(launchctlLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const verbs = lines.map(l => l[0]);
    assert.equal(verbs.filter(v => v === 'bootout').length, 2, 'one bootout per install.sh run');
    assert.equal(verbs.filter(v => v === 'kickstart').length, 2);
    assert.ok(lines.every(l => l.every(arg => !arg.includes('/System/'))), 'never touches a real system domain');
  });

  await check('a bootstrap refused because the previous KeepAlive job is still tearing down is retried, not fatal', async () => {
    // The stub launchctl fails the first bootstrap after each bootout, which is what
    // the real one does on the reinstall path. (Ablation: with the retry loop replaced
    // by a bare `launchctl bootstrap`, `set -e` kills the script on that first failure
    // and BOTH runs above exit non-zero — the idempotency claim evaporates.)
    const lines = readFileSync(launchctlLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const bootstraps = lines.filter(l => l[0] === 'bootstrap');
    assert.equal(bootstraps.length, 4, 'each run must retry its refused bootstrap exactly once more (2 runs x 2 attempts)');
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
  });

  await check('CLAUDE_BOARD_PORT is wired into the plist rather than only echoed', async () => {
    // install.sh reads and prints this port; if it never reaches the daemon's
    // environment, `CLAUDE_BOARD_PORT=9000 ./install.sh` exits 0 printing a verify
    // command for :9000 that can never succeed, and every later `ask` gets
    // ECONNREFUSED once the user exports it too.
    assert.ok(plist.EnvironmentVariables, 'the plist must carry an EnvironmentVariables dict');
    assert.equal(plist.EnvironmentVariables.CLAUDE_BOARD_PORT, String(healthPort));
  });

  await check('when a launcher bundle is in use, the plist carries no roots or store at all -- the launcher bakes them in instead', async () => {
    // The reference allowlist (ADR.md entry 3) and the serve allowlist are the two
    // knobs that move a security boundary, and CLAUDE_BOARD_HOME decides where the
    // store lives. All three used to be written into the plist's EnvironmentVariables
    // dict because a launchd job inherits nothing from the shell that ran install.sh --
    // but with a launcher bundle in use, bin/launcher.c's OVERRIDE_ENV builds the
    // child's environment itself and ignores whatever the plist says for these three
    // (see launcher_paths.h and "the plist stops carrying what the launcher now bakes"
    // in install.sh's step 2). Leaving the keys in the plist anyway would be a lie about
    // what is actually in force, given anyone who can write that world-readable,
    // user-writable file could otherwise believe rewriting it moves the boundary when it
    // no longer does -- so install.sh omits them entirely once USE_LAUNCHER is 1, which
    // is this suite's ordinary path (see "the launcher bundle is built, signed..." above).
    assert.ok(plist.EnvironmentVariables, 'the plist must still carry an EnvironmentVariables dict');
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in plist.EnvironmentVariables), 'the launcher carries the reference roots now, not the plist');
    assert.ok(!('CLAUDE_BOARD_SERVE_ROOTS' in plist.EnvironmentVariables), 'the launcher carries the serve roots now, not the plist');
    assert.ok(!('CLAUDE_BOARD_HOME' in plist.EnvironmentVariables), 'the launcher carries the store now, not the plist');

    // What replaces "read it out of the plist": the resolved default is compiled into
    // the launcher as a literal C string (bin/launcher.c's CLAUDE_BOARD_REF_ROOTS_VALUE,
    // via launcher_paths.h) -- proven by reading the executable's own bytes, the same
    // way the CLAUDE_BOARD_NODE override check further below proves its baked-in path.
    // It is also the ONLY place that default exists (audit S3, 2026-07-31):
    // src/resolve.mjs reads an absent variable as an empty allowlist, and it is written
    // against DEFAULT_REF_ROOTS rather than a second copy of the list, so the two cannot
    // drift apart silently. Three directories, not ~/.claude entire (audit S1): that
    // tree also holds .credentials.json, settings.json, shell snapshots and every
    // project transcript.
    const launcherExec = path.join(appDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    const bakedIn = value => readFileSync(launcherExec).includes(Buffer.from(`${value}\0`, 'utf8'));
    assert.deepEqual([...DEFAULT_REF_ROOTS], ['~/.claude/skills', '~/.claude/commands', '~/.claude/agents']);
    const defaultRefRoots = DEFAULT_REF_ROOTS.map(r => path.join(process.env.HOME, r.slice(2))).join(':');
    assert.ok(bakedIn(defaultRefRoots), 'the resolved default reference roots must be compiled into the launcher');

    // ...and an explicit value is baked in too, colon-separated list and all -- in place
    // of a plist entry, which must still be absent.
    const agents = path.join(workDir, 'LaunchAgents-refroots');
    const refAppDir = path.join(workDir, 'Applications-refroots');
    const chosen = `${path.join(workDir, 'roots-a')}:${path.join(workDir, 'roots-b')}`;
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_REF_ROOTS: chosen,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_APP_DIR: refAppDir,
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-refroots'),
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-refroots', 'claude-board', 'secret'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-refroots.log'),
        STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-refroots.json'),
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-refroots.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-refroots.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in JSON.parse(asJson.stdout).EnvironmentVariables), 'an explicit value must not land in the plist either');
    const chosenLauncherExec = path.join(refAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    assert.ok(readFileSync(chosenLauncherExec).includes(Buffer.from(`${chosen}\0`, 'utf8')), 'the chosen roots must be compiled into the launcher instead');
  });

  await check('a plist from before the record file existed is read once, as a migration, and then persisted', async () => {
    // Today's carry-forward mechanism (see the checks below) reads a record file next
    // to the secret rather than the plist, because the plist stops carrying these values
    // once a launcher bundle is in use. That would silently reset anyone who customised
    // CLAUDE_BOARD_REF_ROOTS before this change and has no record file yet -- so
    // install.sh still reads a pre-existing plist as a ONE-TIME migration, then writes
    // what it found into the record file so this branch never has to fire again.
    const agents = path.join(workDir, 'LaunchAgents-migrate');
    const migrateAppDir = path.join(workDir, 'Applications-migrate');
    const migrateSecretDir = path.join(workDir, 'config-migrate', 'claude-board');
    const migrateSecretFile = path.join(migrateSecretDir, 'secret');
    mkdirSync(agents, { recursive: true });
    mkdirSync(migrateSecretDir, { recursive: true });
    // A secret already on disk, so this run looks like the upgrade it is meant to
    // simulate rather than a fresh install, and a hand-written plist carrying a
    // customised CLAUDE_BOARD_REF_ROOTS in exactly the shape install.sh itself used to
    // write one -- with no ref_roots record file sitting beside the secret yet.
    writeFileSync(migrateSecretFile, 'c'.repeat(64), { mode: 0o600 });
    const preExisting = path.join(workDir, 'migrate-roots');
    writeFileSync(path.join(agents, 'claude-board.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>Label</key><string>claude-board</string>',
      '\t<key>EnvironmentVariables</key>',
      '\t<dict>',
      '\t\t<key>CLAUDE_BOARD_PORT</key><string>7391</string>',
      `\t\t<key>CLAUDE_BOARD_REF_ROOTS</key><string>${preExisting}</string>`,
      '\t</dict>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));

    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_APP_DIR: migrateAppDir,
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-migrate'),
        CLAUDE_BOARD_SECRET_FILE: migrateSecretFile,
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-migrate.log'),
        STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-migrate.json'),
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-migrate.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-migrate.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /carried forward from .*\(migrated/, 'the migration must be announced, not silent');
    assert.equal(readFileSync(path.join(migrateSecretDir, 'ref_roots'), 'utf8'), preExisting, 'the pre-existing plist value must be persisted into the new record file');
    const launcherBytes = readFileSync(path.join(migrateAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'));
    assert.ok(launcherBytes.includes(Buffer.from(`${preExisting}\0`, 'utf8')), 'and actually baked into the launcher, not just recorded');
  });

  await check('an upgrade carries the recorded reference roots forward instead of silently re-widening them', async () => {
    // SECURITY.md tells the operator to narrow this boundary with
    // `CLAUDE_BOARD_REF_ROOTS= ./install.sh`. install.sh used to rewrite the plist
    // unconditionally and never read the old one back, so the ordinary upgrade -- `git
    // pull && ./install.sh` from a clean shell, the variable long since out of the
    // environment -- restored the default and rebooted the job with it, with nothing on
    // screen saying so (audit NEW-2, 2026-07-31). The carry-forward mechanism has since
    // moved from the plist to a record file beside the secret (the plist no longer
    // carries this value at all once a launcher bundle is in use), but the guarantee
    // under test is the same one: an upgrade must not silently re-widen a narrowing.
    // Ablation: go back to `REF_ROOTS="${CLAUDE_BOARD_REF_ROOTS-$DEFAULT_REF_ROOTS}"`
    // and step 2 comes back holding the default.
    const agents = path.join(workDir, 'LaunchAgents-upgrade');
    const upgradeAppDir = path.join(workDir, 'Applications-upgrade');
    const upgradeSecretDir = path.join(workDir, 'config-upgrade', 'claude-board');
    const upgradeEnv = {
      ...env,
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
      CLAUDE_BOARD_APP_DIR: upgradeAppDir,
      CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-upgrade'),
      CLAUDE_BOARD_SECRET_FILE: path.join(upgradeSecretDir, 'secret'),
      STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-upgrade.log'),
      STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-upgrade.json'),
      STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-upgrade.log'),
      STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-upgrade.json'),
    };
    const recordFile = path.join(upgradeSecretDir, 'ref_roots');
    const rootsNow = () => readFileSync(recordFile, 'utf8');
    const launcherExec = path.join(upgradeAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    const bakedIn = value => readFileSync(launcherExec).includes(Buffer.from(`${value}\0`, 'utf8'));

    // 1. the operator narrows, explicitly, exactly as SECURITY.md says to.
    const narrowed = spawnSync('bash', [installScript], {
      env: { ...upgradeEnv, CLAUDE_BOARD_REF_ROOTS: '' }, encoding: 'utf8',
    });
    assert.equal(narrowed.status, 0, `stdout:\n${narrowed.stdout}\nstderr:\n${narrowed.stderr}`);
    assert.equal(rootsNow(), '', 'an explicitly empty value must be recorded as empty');

    // 2. ...and an upgrade from a clean shell leaves that decision standing.
    const upgraded = spawnSync('bash', [installScript], { env: upgradeEnv, encoding: 'utf8' });
    assert.equal(upgraded.status, 0, `stdout:\n${upgraded.stdout}\nstderr:\n${upgraded.stderr}`);
    assert.equal(rootsNow(), '', 'an upgrade must not restore the default over an explicit narrowing');

    // 3. ...while an explicit value still wins over the carried-forward one, or the
    //    knob would be a one-way door -- and it must actually reach the rebuilt
    //    launcher, not just a record file nothing then reads.
    const widened = path.join(workDir, 'roots-upgrade');
    const rewidened = spawnSync('bash', [installScript], {
      env: { ...upgradeEnv, CLAUDE_BOARD_REF_ROOTS: widened }, encoding: 'utf8',
    });
    assert.equal(rewidened.status, 0, `stdout:\n${rewidened.stdout}\nstderr:\n${rewidened.stderr}`);
    assert.equal(rootsNow(), widened);
    assert.ok(bakedIn(widened), 'the re-widened roots must be compiled into the launcher');

    // 4. ...and whichever of the three happened, the resolved value is on screen. The
    //    boundary moving is exactly the thing that must never be silent.
    for (const r of [narrowed, upgraded, rewidened]) {
      assert.match(r.stdout, /reference roots:/, 'the install summary must name the resolved roots');
    }
    assert.match(upgraded.stdout, /carried forward from/, 'and say where the value came from');

    // 5. ...and the plist itself never carries this value at all, on any of the three
    //    runs above, now that a launcher bundle is in use.
    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in JSON.parse(asJson.stdout).EnvironmentVariables));
  });

  await check('the roots install.sh resolves and records confine a RUNNING daemon, not just its own printout', async () => {
    // The check above this one asserts the plist does NOT contain the key any more,
    // and the migration check proves the record file gets the right bytes -- both are
    // structurally the same shape as the WatchPaths assertion QUIRKS.md records as "a
    // green check sitting on top of a dead mechanism" if nothing then reads that record
    // file back and enforces it. So this one runs install.sh for real, reads back
    // exactly what it persisted into the record file (the plist no longer carries this
    // value at all -- see above), and hands THAT to a real bin/daemon.mjs, asking it to
    // resolve two references over its own gated HTTP route: one inside the configured
    // root and one outside every root.
    //
    // What this does NOT cover: bin/launcher.c actually delivering that same value at
    // runtime while filtering everything else out of a poisoned parent environment --
    // that half of the chain is proven separately, in full isolation, by
    // test/check-launcher-env.mjs, which compiles the real launcher against a stub
    // daemon rather than running the production one against a live port.
    const rootDir = path.join(workDir, 'live-root');
    const outsideDir = path.join(workDir, 'live-outside');
    const projectDir = path.join(workDir, 'live-project');
    for (const d of [rootDir, outsideDir, projectDir]) mkdirSync(d, { recursive: true });
    const allowed = path.join(rootDir, 'SKILL.md');
    const forbidden = path.join(outsideDir, 'private.md');
    writeFileSync(allowed, 'CONTENT-INSIDE-THE-CONFIGURED-ROOT\n', 'utf8');
    writeFileSync(forbidden, 'CONTENT-OUTSIDE-EVERY-ROOT\n', 'utf8');

    const agents = path.join(workDir, 'LaunchAgents-live');
    const liveSecretDir = path.join(workDir, 'config-live', 'claude-board');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_REF_ROOTS: rootDir,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-live'),
        CLAUDE_BOARD_SECRET_FILE: path.join(liveSecretDir, 'secret'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-live.log'),
        STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-live.json'),
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-live.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-live.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const recordedRoots = readFileSync(path.join(liveSecretDir, 'ref_roots'), 'utf8');
    assert.equal(recordedRoots, rootDir, 'install.sh must persist exactly the roots it resolved');

    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in JSON.parse(asJson.stdout).EnvironmentVariables), 'the plist itself must not carry this value');

    const daemon = await spawnDaemonWithEnv({ CLAUDE_BOARD_REF_ROOTS: recordedRoots });
    try {
      const posted = await fetch(`http://127.0.0.1:${daemon.port}/api/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-board-secret': daemon.secret },
        body: JSON.stringify({
          title: 'recorded roots round trip',
          cwd: projectDir,
          blocks: [
            { kind: 'markdown', source: { path: allowed } },
            { kind: 'markdown', source: { path: forbidden } },
          ],
        }),
      });
      const postedBody = await posted.text(); // read once: the failure message needs it too
      assert.equal(posted.status, 200, postedBody);
      const { boardId } = JSON.parse(postedBody);

      const page = await fetch(`http://127.0.0.1:${daemon.port}/b/${boardId}`, {
        headers: { 'x-claude-board-secret': daemon.secret },
      });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(
        html.includes('CONTENT-INSIDE-THE-CONFIGURED-ROOT'),
        'the root install.sh resolved and recorded must be an allowlisted root in the running daemon',
      );
      assert.ok(
        !html.includes('CONTENT-OUTSIDE-EVERY-ROOT'),
        'and it must be the ONLY thing it widened -- a reference outside every root is still refused',
      );
    } finally {
      daemon.cleanup();
    }
  });

  await check('xml_escape is byte-safe: a non-UTF-8 byte in a path or a root does not abort the install', async () => {
    // Every value install.sh splices into the plist goes through xml_escape, and a
    // filename is bytes, not text. Under a UTF-8 locale BSD sed refuses input that is
    // not valid UTF-8 with "RE error: illegal byte sequence" and exits non-zero -- and
    // under `set -euo pipefail` that failing command substitution kills the whole
    // install part-way through, having already written a log directory and possibly
    // an MCP registration. One stray byte in a clone path or a reference root is
    // enough (audit S9, 2026-07-31).
    //
    // Node cannot put such a byte into a child's environment (env values are UTF-8
    // strings), so the function is lifted out of install.sh and exercised directly,
    // under an explicitly UTF-8 locale so the trap is armed. Ablation: drop the
    // LC_ALL=C from xml_escape and this exits 1 with sed's complaint on stderr.
    const src = readFileSync(installScript, 'utf8');
    const fn = src.match(/^xml_escape\(\) \{\n[\s\S]*?^\}$/m);
    assert.ok(fn, 'install.sh must still define xml_escape as a top-level function');

    const probe = path.join(workDir, 'xml-escape-probe.sh');
    writeFileSync(probe, [
      'set -euo pipefail',
      fn[0],
      "V=\"$(printf 'a\\xffb&c')\"",
      'xml_escape "$V" | od -An -tx1 | tr -d " \\n"',
      '',
    ].join('\n'), 'utf8');

    const r = spawnSync('bash', [probe], {
      encoding: 'utf8',
      env: { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    assert.equal(r.status, 0, `xml_escape must not abort on a non-UTF-8 byte:\n${r.stderr}`);
    const expected = Buffer.concat([
      Buffer.from('a', 'latin1'), Buffer.from([0xff]), Buffer.from('b&amp;c', 'latin1'),
    ]).toString('hex');
    assert.equal(r.stdout.trim(), expected, 'the byte must survive untouched, with & still escaped');
  });

  await check('install refuses to report success when the daemon never answers /api/health', async () => {
    // Nothing is listening on this port: launchctl is stubbed, so "wrote a plist and
    // called launchctl" is all that happened -- which is precisely the state the old
    // script called "installed and running". (Ablation: without the health gate this
    // exits 0 and prints that line.)
    const deadPort = healthPort + 1; // nothing bound here; the poll below has a short budget
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_PORT: String(deadPort),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(workDir, 'LaunchAgents-nohealth'),
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-nohealth'),
        STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-nohealth.json'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-nohealth.log'),
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-nohealth.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-nohealth.json'),
      },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, 'a daemon that never bound must fail the install');
    assert.match(r.stderr, /NOT running/);
    assert.doesNotMatch(r.stdout, /installed and running/);
    // ...and the MCP registration it does not own was never touched on the way out.
    assert.ok(!existsSync(path.join(workDir, 'claude-registrations-nohealth.json')), 'a failed install must not have rewritten the MCP registration');
  });

  await check('the log directory is owner-only (it carries whatever the daemon prints about boards)', async () => {
    assert.equal(statSync(logDir).mode & 0o777, 0o700);
  });

  // Ticket 04 / ADR.md entry 5: install.sh no longer installs `/grill` or any other
  // command file -- that whole step, and the hash-comparison guard that decided
  // whether to overwrite a user's edited copy, is gone. What used to be asserted here
  // (a fresh install writes the shipped file, an unmodified copy is updated when the
  // shipped copy changes, a user edit is never clobbered) had no mechanism left to test
  // it against, so it went with the step rather than surviving as dead assertions.

  await check("install.sh no longer ships a command file (ADR.md entry 5): no GRILL_SRC/COMMAND_FILE machinery remains", async () => {
    const installSrc = readFileSync(installScript, 'utf8');
    assert.doesNotMatch(installSrc, /GRILL_SRC/, 'install.sh must not resolve a commands/grill.md source path');
    assert.doesNotMatch(installSrc, /COMMAND_FILE/, 'install.sh must not resolve a command-file install target');
    assert.doesNotMatch(installSrc, /commands\/grill\.md/, 'install.sh must not reference commands/grill.md at all');
  });

  // --- the interpreter baked into the plist ------------------------------------
  //
  // Raised by ticket 08 and settled here: `command -v node` on a machine using a
  // version manager resolves to a versioned directory (~/.nvm/versions/node/vX/bin),
  // and the next upgrade deletes it. launchd then points at a path that no longer
  // exists, which surfaces as "daemon is not reachable" in every session, with
  // nothing naming the cause. install.sh prefers a stable interpreter and says so.

  // ADR.md entry 11: the manual is the one file install.sh puts under ~/.claude, and it
  // is repo-owned rather than user-owned -- which is exactly what entry 5 refused for
  // `/grill`. The distinction the two checks below bind: this file is a copy, kept
  // byte-identical to the clone's, and an edit to the copy is overwritten rather than
  // detected and preserved. No hash record, no did-they-edit-it branch -- the machinery
  // entry 5 deleted stays deleted, and prose that quietly stops matching the shim is the
  // failure this step exists to prevent.
  await check('install copies the board manual into the skills directory, byte-identical to the clone\'s', async () => {
    assert.ok(existsSync(installedSkill), `install.sh must write ${installedSkill}`);
    const shipped = readFileSync(path.join(repoRoot, 'skills', 'claude-board', 'SKILL.md'), 'utf8');
    assert.equal(readFileSync(installedSkill, 'utf8'), shipped, 'the installed manual must be a byte-for-byte copy of the clone\'s');
  });

  await check('a reinstall overwrites an edited copy of the manual rather than preserving it', async () => {
    writeFileSync(installedSkill, '# drifted\n');
    const r = spawnSync('bash', [installScript], { env: { ...env, ...quietStubs('skill-overwrite') }, encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const shipped = readFileSync(path.join(repoRoot, 'skills', 'claude-board', 'SKILL.md'), 'utf8');
    assert.equal(readFileSync(installedSkill, 'utf8'), shipped, 'an edited copy must be replaced by the clone\'s');
  });

  await check('a missing manual warns without failing the install', async () => {
    // The daemon and the registration are the install. A clone with no skills/ directory
    // (an old checkout, a partial copy) must still produce a working board.
    const emptyClone = path.join(workDir, 'clone-without-skill');
    mkdirSync(emptyClone, { recursive: true });
    for (const entry of ['bin', 'src', 'package.json']) {
      cpSync(path.join(repoRoot, entry), path.join(emptyClone, entry), { recursive: true });
    }
    cpSync(installScript, path.join(emptyClone, 'install.sh'));
    const r = spawnSync('bash', [path.join(emptyClone, 'install.sh')], {
      env: { ...env, ...quietStubs('skill-missing'), CLAUDE_BOARD_SKILLS_DIR: path.join(workDir, 'skills-missing') },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `a clone with no manual must still install:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /warning/i, 'a missing manual must be announced, not silent');
  });

  await check('a version-managed node on PATH is not baked into the plist when a stable one exists', async () => {
    const fakeNvm = path.join(workDir, 'home', '.nvm', 'versions', 'node', 'v0.0.0', 'bin');
    mkdirSync(fakeNvm, { recursive: true });
    const shim = path.join(fakeNvm, 'node');
    // A real interpreter under a version-managed path: install.sh executes NODE_BIN
    // (it mints the secret with it), so this has to actually run node.
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(shim, 0o755);

    const agents = path.join(workDir, 'LaunchAgents-nvm');
    const nvmAppDir = path.join(workDir, 'Applications-nvm');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        PATH: `${fakeNvm}:${process.env.PATH}`,
        CLAUDE_BOARD_NODE: '',
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_APP_DIR: nvmAppDir,
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-nvm'),
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-nvm', 'claude-board', 'secret'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-nvm.log'),
        STUB_CLAUDE_STATE: path.join(workDir, 'claude-registrations-nvm.json'),
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-nvm.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-nvm.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `install must succeed with only a version-managed node on PATH\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    // "Baked in" now means compiled into the launcher rather than written into the
    // plist -- the plist names the bundle, and the bundle holds the interpreter path as
    // a C string literal (bin/launcher.c). Same guarantee, one indirection further
    // along: read the bytes of the thing launchd will actually run.
    const launcher = readFileSync(path.join(nvmAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'));
    const bakedIn = p => launcher.includes(Buffer.from(`${p}\0`, 'utf8'));

    const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find(p => existsSync(p));
    if (stable) {
      assert.ok(bakedIn(stable), 'a stable interpreter must win over the version-managed one');
      assert.ok(!bakedIn(shim), 'and the version-managed path must not be what the launcher runs');
      assert.match(r.stdout, /version-managed/, 'the substitution must be announced, not silent');
    } else {
      // No stable interpreter anywhere: baking the version-managed path is the only
      // option left, but it must come with the warning that says why it may break.
      assert.ok(bakedIn(shim));
      assert.match(r.stdout, /warning: only a version-managed node/);
    }
  });

  await check('CLAUDE_BOARD_NODE overrides the interpreter, in the launcher and the registration alike', async () => {
    const agents = path.join(workDir, 'LaunchAgents-override');
    const overrideAppDir = path.join(workDir, 'Applications-override');
    const chosen = path.join(workDir, 'home', 'chosen-node');
    writeFileSync(chosen, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(chosen, 0o755);
    const registrations = path.join(workDir, 'claude-registrations-override.json');

    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_NODE: chosen,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_APP_DIR: overrideAppDir,
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-override'),
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-override', 'claude-board', 'secret'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-override.log'),
        STUB_CLAUDE_STATE: registrations,
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-override.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-override.json'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.equal(JSON.parse(asJson.stdout).ProgramArguments[0],
      path.join(overrideAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'),
      'the plist names the launcher; the interpreter override lands inside it');
    const launcher = readFileSync(path.join(overrideAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'));
    assert.ok(launcher.includes(Buffer.from(`${chosen}\0`, 'utf8')), 'the override must be the interpreter the launcher execs');
    assert.equal(JSON.parse(readFileSync(registrations, 'utf8'))['claude-board'].command[0], chosen);
  });

  // --- audit fix round: L6, plist XML injection --------------------------------
  //
  // `&`, `<` and `>` are all legal in a macOS path and all significant in XML. A clone
  // in ~/Documents/work & play produced a plist that plutil rejects outright while
  // install.sh still exited 0 and reported the service running.

  await check('a clone path containing XML metacharacters still produces a plist launchd can parse, and install exits 0', async () => {
    const oddDir = path.join(workDir, 'clone & <play>');
    mkdirSync(path.join(oddDir, 'bin'), { recursive: true });
    writeFileSync(path.join(oddDir, 'bin', 'daemon.mjs'), '// stub\n');
    writeFileSync(path.join(oddDir, 'bin', 'mcp.mjs'), '// stub\n');
    // install.sh now requires src/ to exist (it is staged into the bundle) -- a stub is
    // enough, since nothing here actually runs this clone's daemon.
    mkdirSync(path.join(oddDir, 'src'), { recursive: true });
    writeFileSync(path.join(oddDir, 'src', 'stub.mjs'), '// stub\n');
    // The real launcher source: this clone's path is the one with `&` and `<>` in it, so
    // it is also the case that proves c_escape holds up where xml_escape does -- the
    // same bytes have to survive into a C string literal and compile.
    writeFileSync(path.join(oddDir, 'bin', 'launcher.c'), readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8'));
    // Both halves of the binary, since launcher.c calls into this one (ADR.md entry 19).
    // The icns is left out on purpose here too: this clone builds a bundle without one.
    writeFileSync(path.join(oddDir, 'bin', 'notify.m'), readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8'));
    writeFileSync(path.join(oddDir, 'install.sh'), readFileSync(installScript, 'utf8'));

    const oddAgents = path.join(workDir, 'LaunchAgents-odd');
    const oddLogs = path.join(workDir, 'Logs-odd');
    // Isolated CLAUDE_BOARD_SECRET_FILE, same as the LaunchAgents/Logs isolation above.
    const r = spawnSync('bash', [path.join(oddDir, 'install.sh')], {
      env: {
        ...env,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: oddAgents,
        CLAUDE_BOARD_LOG_DIR: oddLogs,
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-odd', 'claude-board', 'secret'),
        CLAUDE_BOARD_APP_DIR: path.join(workDir, 'Applications-odd'),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `install must succeed from a path containing & and <>\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const oddPlist = path.join(oddAgents, 'claude-board.plist');
    // (Ablation: splicing the paths in unescaped makes plutil report "Encountered
    // unknown ampersand-escape sequence at line ..." and both of these fail.)
    const lint = spawnSync('plutil', ['-lint', oddPlist], { encoding: 'utf8' });
    assert.equal(lint.status, 0, `plutil must accept the generated plist: ${lint.stdout}${lint.stderr}`);

    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', oddPlist], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    const oddPlistJson = JSON.parse(asJson.stdout);
    // escaped on the way in, and back to the literal path on the way out -- not mangled
    assert.equal(oddPlistJson.WorkingDirectory, oddDir);

    // The daemon path is no longer in the plist at all -- it is compiled into the
    // launcher -- so the same "survived escaping intact" claim is made against the
    // binary's bytes. This is c_escape's assertion, and the ablation is the same shape:
    // splice the path into launcher_paths.h unescaped and a clone under a path with a
    // quote or backslash in it produces a header that will not compile.
    const oddAppPath = path.join(workDir, 'Applications-odd', 'claude-board.app');
    assert.ok(existsSync(oddAppPath),
      `the launcher must build from a path with XML metacharacters in it:\n${r.stdout}`);
    const oddLauncher = readFileSync(path.join(oddAppPath, 'Contents', 'MacOS', 'claude-board'));
    // CLAUDE_BOARD_DAEMON is the path INSIDE the bundle now (the odd clone's own
    // bin/daemon.mjs is staged there, never executed from the clone directly), so that is
    // where the odd bytes have to reach unmangled.
    assert.ok(oddLauncher.includes(Buffer.from(`${path.join(oddAppPath, 'Contents', 'Resources', 'bin', 'daemon.mjs')}\0`, 'utf8')),
      'the bundled daemon path must reach the launcher intact');
    // CLAUDE_BOARD_REPO_ROOT carries the odd CLONE path itself (see src/handoff.mjs
    // repoRoot()), so this is the other half of the same c_escape claim: the clone path,
    // odd bytes and all, still has to survive into the compiled binary.
    assert.ok(oddLauncher.includes(Buffer.from(`${oddDir}\0`, 'utf8')),
      'the odd clone path must reach the launcher intact via CLAUDE_BOARD_REPO_ROOT');
    // And the payload itself: the odd clone's own stub source, copied byte-identical.
    assert.equal(
      readFileSync(path.join(oddAppPath, 'Contents', 'Resources', 'src', 'stub.mjs'), 'utf8'),
      '// stub\n',
      'the payload must be staged into the bundle even from an odd clone path',
    );
  });

  await check('install fails loudly rather than exiting 0 when the generated plist does not lint', async () => {
    const failingPlutil = path.join(binDir, 'plutil-fail.mjs');
    writeFileSync(failingPlutil, '#!/usr/bin/env node\nprocess.exit(1);\n');
    chmodSync(failingPlutil, 0o755);
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_PLUTIL_CMD: failingPlutil,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(workDir, 'LaunchAgents-lintfail'),
        CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-lintfail'),
      },
      encoding: 'utf8',
    });
    // (Ablation: without the lint gate this exits 0 and tells the user the service is
    // running, while launchd has nothing loadable to load.)
    assert.notEqual(r.status, 0, 'a plist plutil rejects must fail the install');
    assert.match(r.stderr, /not valid/);
  });

  // --- a source edit does not restart the daemon: the behaviour, not the plist key ---

  await check('editing a file under src/ does NOT make a running daemon exit, with or without the old reload env var', async () => {
    // The daemon used to watch src/ and bin/ and exit on a write there, and that is
    // what this section proved. It is gone: a save should never cost a restart, which
    // drops every SSE stream and every held-open wait mid-review, and an edit landing
    // half-written could take the daemon down for real and leave launchd throttling a
    // crash loop. Updates go through ./install.sh instead.
    //
    // The old opt-in variable is set here on purpose: a leftover
    // CLAUDE_BOARD_RELOAD_ON_CHANGE=1 in somebody's shell, or in a plist installed
    // before this change, must now do nothing at all rather than quietly resurrect the
    // behaviour. (Ablation: restoring watchForReload in bin/daemon.mjs fails this.)
    const d = await spawnSourceEditDaemon();
    try {
      // A harmless content edit to the TEMP COPY -- never the real src/store.mjs --
      // shaped like an editor's atomic save landing a line.
      writeFileSync(d.srcFile, '\n// touched by check-install.mjs source-edit check\n', { flag: 'a' });
      const exited = await waitForExit(d.child, 2500);
      assert.ok(!exited, `the daemon must stay up when src/ changes underneath it\nstderr:\n${d.stderr()}`);
      assert.doesNotMatch(d.stderr(), /exiting to reload/, 'and must not log a reload exit it no longer performs');
    } finally {
      d.cleanup();
    }
  });

  // --- ~/.claude/settings.json is not this repo's file (ticket 06) --------------
  //
  // SPEC_POMODORO.md criterion 11 (the half provable without a running Claude Code
  // session): install.sh reads and writes nothing under ~/.claude/settings.json.
  // Criterion 12: uninstall.sh leaves the SessionStart hook snippet INSTALL.md
  // documents for that file untouched -- this repo did not install it, so
  // uninstall.sh has no more business deleting it than it does a command file it
  // never shipped (ADR.md entry 5).
  //
  // There is no env var seam pointing either script at a fake settings.json, and
  // there deliberately is not one added here either: a seam whose only purpose is
  // to let a test redirect a file the scripts never touch would invent exactly the
  // coupling this criterion forbids. So this proves it two ways instead: a
  // source-level check that the scripts' own text never references the path except
  // in a comment or an echoed message (nothing that could open it), and a real run
  // of both scripts with $HOME itself pointed at a temp directory holding a fake
  // settings.json, asserting the file survives byte-identical.

  await check('install.sh and uninstall.sh mention settings.json only in a comment or an echo, never in a file operation', async () => {
    // (Ablation: add `rm -f "$HOME/.claude/settings.json"` or `> "$HOME/.claude/settings.json"`
    // anywhere in either script and its line fails this -- it is neither a comment
    // nor an echo statement.)
    for (const [name, file] of [['install.sh', installScript], ['uninstall.sh', uninstallScript]]) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const hits = lines.filter(l => l.includes('settings.json'));
      assert.ok(hits.length > 0, `${name} should still document why it stays out of settings.json`);
      for (const line of hits) {
        const trimmed = line.trim();
        assert.ok(
          trimmed.startsWith('#') || trimmed.startsWith('echo'),
          `${name}: every mention of settings.json must be a comment or an echoed message, found: ${line}`,
        );
      }
    }
  });

  await check('a SessionStart hook in ~/.claude/settings.json survives install.sh and uninstall.sh byte-identical', async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'claude-board-fakehome-'));
    try {
      const claudeDir = path.join(fakeHome, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      // Shaped like a real settings.json carrying a hook this repo did not add and must
      // not disturb -- an unrelated command, a matcher, ordinary indentation.
      const settingsContent = JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '', hooks: [{ type: 'command', command: 'some-other-tool --on-session-start' }] },
          ],
        },
      }, null, 2) + '\n';
      writeFileSync(settingsPath, settingsContent);
      const before = readFileSync(settingsPath);

      // Every OTHER seam is still redirected into fresh temp paths of its own, same as
      // every other isolated run in this suite -- only HOME itself is new here, and
      // only because it is the one thing settings.json's real path is resolved from.
      const hEnv = {
        ...env,
        HOME: fakeHome,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(fakeHome, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(fakeHome, 'Logs'),
        CLAUDE_BOARD_APP_DIR: path.join(fakeHome, 'Applications'),
        CLAUDE_BOARD_HOME: path.join(fakeHome, 'Store'),
        CLAUDE_BOARD_SECRET_FILE: path.join(fakeHome, 'config', 'claude-board', 'secret'),
        STUB_CLAUDE_LOG: path.join(fakeHome, 'claude-invocations.log'),
        STUB_CLAUDE_STATE: path.join(fakeHome, 'claude-registrations.json'),
        STUB_LAUNCHCTL_LOG: path.join(fakeHome, 'launchctl-invocations.log'),
        STUB_LAUNCHCTL_STATE: path.join(fakeHome, 'launchctl-state.json'),
      };

      const installRun = spawnSync('bash', [installScript], { env: hEnv, encoding: 'utf8' });
      assert.equal(installRun.status, 0, `install must succeed\nstdout:\n${installRun.stdout}\nstderr:\n${installRun.stderr}`);

      const uninstallRun = spawnSync('bash', [uninstallScript], { env: hEnv, encoding: 'utf8' });
      assert.equal(uninstallRun.status, 0, `uninstall must succeed\nstdout:\n${uninstallRun.stdout}\nstderr:\n${uninstallRun.stderr}`);

      const after = readFileSync(settingsPath);
      // (Ablation: any rewrite of settings.json -- even one that happens to preserve
      // the hook, e.g. a parse-modify-reformat round trip -- changes these bytes and
      // fails this. Byte-identical is the point: "the hook survives" is not enough.)
      assert.ok(before.equals(after), 'the settings.json bytes must be identical after install.sh and uninstall.sh both ran');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  // --- uninstall (SPEC_LAUNCH.md criterion 11) ----------------------------------
  //
  // Runs against the SAME workDir/env the two install() runs at the top of this file
  // used, deliberately last: the launchd job, the plist, the MCP registration and the
  // still-unmodified command file they installed all still exist at this point, so
  // "removes what install put there" is checked against real state rather than a
  // freshly-faked one. Nothing above this point re-reads claudeLog/claudeState/
  // launchctlLog/launchctlState for counting, so appending more invocations here (the
  // way the odd-path and lint-fail installs above already do) is safe.

  // Dropped beside the manual before uninstall runs, so the assertion below can tell
  // "removed the file we wrote" from "removed the directory it happened to sit in".
  const neighbourSkillFile = path.join(skillsDir, 'claude-board', 'notes.md');
  const neighbourSkillContent = 'mine, not the installer\'s\n';
  mkdirSync(path.dirname(neighbourSkillFile), { recursive: true });
  writeFileSync(neighbourSkillFile, neighbourSkillContent);

  const uninstallResult = spawnSync('bash', [uninstallScript], { env, encoding: 'utf8' });

  await check('uninstall exits 0', async () => {
    assert.equal(uninstallResult.status, 0, `stdout:\n${uninstallResult.stdout}\nstderr:\n${uninstallResult.stderr}`);
  });

  await check('uninstall removes the plist', async () => {
    assert.ok(!existsSync(plistPath), 'the plist must be gone after uninstall');
  });

  await check('uninstall removes the launcher bundle and its build record', async () => {
    // install.sh authored this bundle outright, so unlike the store, the secret and the
    // logs it is uninstall's to take away -- leaving a signed launchd binary in
    // ~/Applications pointing at a daemon that is gone is the kind of leftover
    // criterion 11 exists to prevent.
    assert.ok(!existsSync(path.join(appDir, 'claude-board.app')), 'the launcher bundle must be gone after uninstall');
    assert.ok(!existsSync(path.join(path.dirname(secretFile), 'launcher.stamp')), 'the stamp recording what it was built from must go with it');
    // The TCC entry it may have left in System Settings cannot be removed by any
    // script, so the one honest thing to do is say so.
    assert.match(uninstallResult.stdout, /Privacy & Security/, 'uninstall must tell the user about the settings entry it cannot remove');
  });

  await check('uninstall removes the manual it installed, and only that', async () => {
    // Symmetric with the launcher bundle above: what install.sh authored at that path,
    // uninstall takes back. The directory itself is not this repo's, so a neighbour file
    // must survive -- and does, because the rmdir is the non-forcing kind.
    assert.ok(!existsSync(installedSkill), 'the installed manual must be gone after uninstall');
    assert.ok(existsSync(neighbourSkillFile), 'a file the user put beside it must survive');
    assert.equal(readFileSync(neighbourSkillFile, 'utf8'), neighbourSkillContent, 'and be untouched');
  });

  await check('uninstall removes the MCP registration', async () => {
    const state = existsSync(claudeState) ? JSON.parse(readFileSync(claudeState, 'utf8')) : {};
    assert.ok(!('claude-board' in state), 'the MCP registration must be removed');
  });

  await check('uninstall leaves the store untouched -- directory and contents survive', async () => {
    // This is the brief's OTHER headline assertion, alongside the modified-file
    // refusal above. (Ablation: an uninstall.sh that `rm -rf`s CLAUDE_BOARD_HOME "to
    // clean up after itself" makes both of these fail -- and per the brief, an
    // uninstall that silently destroys a review archive is a far worse bug than one
    // that leaves too much.)
    assert.ok(existsSync(storeDir), 'the store directory must still exist after uninstall');
    assert.ok(existsSync(storeBoardFile), 'a board file in the store must survive uninstall');
    assert.equal(readFileSync(storeBoardFile, 'utf8'), storeBoardContent, 'the store content must be byte-for-byte untouched');
  });

  await check('uninstall removes pomodoro.json by exact name and nothing else in the store (ADR.md entry 8 / ticket 06)', async () => {
    // The other half of the same brief, pointed the other way: pomodoro.json is
    // configuration this repo authored, not review history, so it is the ONE file in
    // the store uninstall.sh is supposed to take back. (Ablation: reverting the step
    // 2b block in uninstall.sh leaves this file behind and fails the first assertion;
    // reverting it to `rm -rf "$STORE_DIR"` instead would fail the store-survival
    // check just above, which is the point of testing both directions.)
    assert.ok(!existsSync(pomodoroFile), 'pomodoro.json must be gone after uninstall');
    // And the removal must have been surgical -- the board file one directory over,
    // asserted again here rather than trusted from the check above, so this check
    // alone still catches a regression that deletes the whole store to get rid of
    // pomodoro.json.
    assert.ok(existsSync(storeBoardFile), 'removing pomodoro.json must not take boards/ with it');
    assert.equal(readFileSync(storeBoardFile, 'utf8'), storeBoardContent, 'and must not modify what it did not remove');
  });

  await check('uninstall names what it deliberately left behind: the store, the secret and the logs, by path', async () => {
    assert.ok(uninstallResult.stdout.includes(storeDir), 'must name the store path');
    assert.ok(uninstallResult.stdout.includes(secretFile), 'must name the secret path');
    assert.ok(uninstallResult.stdout.includes(logDir), 'must name the logs path');
  });

  // Ticket 04 / ADR.md entry 5: install.sh no longer installs `/grill` or any other
  // command file, so uninstall.sh has nothing of its own to take back at
  // ~/.claude/commands -- deleting anything there now would mean destroying a file the
  // user owns, not one this repo put there. The old checks here (an unmodified command
  // file is removed, an edited one survives with its hash record, an orphaned hash
  // record is cleaned up) all tested the hash-comparison guard that shipped that
  // deletion; with the guard gone, this proves the negative instead: a file sitting at
  // the path install.sh used to manage is left completely alone, and uninstall.sh's own
  // source has no code path that could reach it.

  await check("uninstall.sh does not touch a file at the path install.sh used to manage (ADR.md entry 5)", async () => {
    const formerCommandFile = path.join(workDir, 'Commands', 'grill.md');
    mkdirSync(path.dirname(formerCommandFile), { recursive: true });
    const untouchedContent = '# not this repo\'s file anymore\n';
    writeFileSync(formerCommandFile, untouchedContent);

    const r = spawnSync('bash', [uninstallScript], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `uninstall must succeed\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(existsSync(formerCommandFile), 'uninstall must not delete a file at the old command-file path');
    assert.equal(readFileSync(formerCommandFile, 'utf8'), untouchedContent, 'and must not modify it either');

    rmSync(formerCommandFile, { force: true });
  });

  await check("uninstall.sh's own source carries no command-file removal machinery to claim it does not use", async () => {
    const uninstallSrc = readFileSync(uninstallScript, 'utf8');
    assert.doesNotMatch(uninstallSrc, /GRILL_SRC/, 'uninstall.sh must not reference a commands/grill.md source path');
    assert.doesNotMatch(uninstallSrc, /COMMAND_FILE/, 'uninstall.sh must not reference an installed command-file target');
    assert.doesNotMatch(uninstallSrc, /grill\.sha256/, 'uninstall.sh must not reference the retired hash record');
  });

  await check('uninstall is safe to run twice', async () => {
    const second = spawnSync('bash', [uninstallScript], { env, encoding: 'utf8' });
    assert.equal(second.status, 0, `a second uninstall must not fail\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    // pomodoro.json is already gone from the run above -- the second run must say so
    // rather than erroring on a missing file, the same "already absent" idempotency
    // every other removal in uninstall.sh gets.
    assert.match(second.stdout, /no pomodoro state at/, 'a second uninstall must report the timer file as already absent, not silently skip it');
    assert.doesNotMatch(second.stdout, /removed .*pomodoro\.json/, 'and must not claim to have removed it again');
  });

  await check('uninstall is safe to run on a machine with nothing installed', async () => {
    const freshWorkDir = mkdtempSync(path.join(tmpdir(), 'claude-board-uninstall-fresh-'));
    try {
      const freshEnv = {
        ...process.env,
        CLAUDE_BOARD_SECRET_FILE: path.join(freshWorkDir, 'config', 'claude-board', 'secret'),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(freshWorkDir, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(freshWorkDir, 'Logs'),
        // The seam this env object was missing, and the damage was not hypothetical:
        // uninstall.sh defaults APP_DIR to $HOME/Applications and `rm -rf`s the bundle
        // it finds there, so THIS check -- "safe to run on a machine with nothing
        // installed" -- deleted the real ~/Applications/claude-board.app of whoever ran
        // the suite. Their daemon then died with launchd's "Missing executable" (exit
        // 78, and a `kickstart` that hangs rather than saying why), and the TCC grant
        // pinned to that bundle's signature went with it. Observed on this machine
        // 2026-08-01. Every other seam was already here; this one is the only one that
        // reaches outside the temp dir when omitted, because it is the only one whose
        // fallback is a path the developer actually uses.
        CLAUDE_BOARD_APP_DIR: path.join(freshWorkDir, 'Applications'),
        // The second seam with that property: uninstall.sh defaults SKILLS_DIR to
        // $HOME/.claude/skills and removes the manual it finds there, so omitting this
        // deletes the real one. It did, on the first suite run after step 6 shipped.
        CLAUDE_BOARD_SKILLS_DIR: path.join(freshWorkDir, 'skills'),
        CLAUDE_BOARD_HOME: path.join(freshWorkDir, 'Store'),
        CLAUDE_BOARD_MCP_CMD: claudeStub, // still stubbed -- never touches the real `claude`
        CLAUDE_BOARD_LAUNCHCTL_CMD: launchctlStub,
        STUB_CLAUDE_LOG: path.join(freshWorkDir, 'claude-invocations.log'),
        STUB_CLAUDE_STATE: path.join(freshWorkDir, 'claude-registrations.json'),
        STUB_LAUNCHCTL_LOG: path.join(freshWorkDir, 'launchctl-invocations.log'),
        STUB_LAUNCHCTL_STATE: path.join(freshWorkDir, 'launchctl-state.json'),
      };
      const r = spawnSync('bash', [uninstallScript], { env: freshEnv, encoding: 'utf8' });
      // (Ablation: an uninstall.sh that lets a failing `launchctl bootout`/`claude mcp
      // remove` propagate under `set -e` -- rather than branching on their exit code --
      // fails this on a machine that has never seen install.sh.)
      assert.equal(r.status, 0, `uninstall on a machine with nothing installed must still exit 0\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    } finally {
      rmSync(freshWorkDir, { recursive: true, force: true });
    }
  });

  // Last, so it sees the state every check above left behind. See REAL_PATHS.
  await check('the suite left this machine\'s own installation exactly as it found it', async () => {
    REAL_PATHS.forEach((p, i) => {
      assert.equal(existsSync(p), realPathsBefore[i],
        `${p} ${realPathsBefore[i] ? 'existed before this suite ran and must still exist' : 'did not exist before this suite ran and must not have been created'} -- a spawn of install.sh or uninstall.sh above is missing a testing-seam env var and reached the real machine`);
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
    healthProc.kill();
    rmSync(workDir, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall install checks ok');
  });
