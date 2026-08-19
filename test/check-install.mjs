// Install-script check: runs install.sh TWICE against a temp
// CLAUDE_BOARD_LAUNCH_AGENTS_DIR / CLAUDE_BOARD_LOG_DIR and stub
// claude/launchctl executables, and asserts the second run is a no-op:
// exit 0 both times, exactly one plist (well-formed, absolute paths
// pointing at THIS clone, Label exactly "claude-board"), and exactly one
// MCP registration rather than two. Also runs uninstall.sh once, against
// the state the two install runs left behind, and asserts it undoes
// everything install.sh owns while leaving everything it does not.
//
// Never touches the real ~/Library/LaunchAgents, ~/Library/Logs,
// ~/Library/Application Support/claude-board, or Claude MCP config, and never calls
// the real `launchctl` — everything install.sh/uninstall.sh would otherwise touch
// outside the repo is redirected into a temp dir via the testing-seam env vars both
// scripts accept (see their header comments). No browser, no network.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync, statSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
// The installer writes the reference allowlist into the plist, and that value is the
// only place the shipped default exists -- src/resolve.mjs reads
// an absent variable as an empty allowlist on purpose. Imported rather than copied so
// the two cannot drift.
import { DEFAULT_REF_ROOTS } from '../src/resolve.mjs';
// Same reason, for the port install.sh falls back to when nothing else names one: the
// number lives in two files that must not drift.
import { DEFAULT_PORT } from '../src/handoff.mjs';

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
// The pid gate asks launchd which process it supervises; this stub starts nothing,
// so the answer is whatever pid the check says the "supervised" daemon has.
if (args[0] === 'print') {
  const jobPid = process.env.STUB_LAUNCHCTL_PRINT_PID;
  if (jobPid) process.stdout.write('\\tpid = ' + jobPid + '\\n');
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
// REPORT its path, and the whole point is that uninstall must never
// touch it. Pre-populated with a fake board so "the store survives uninstall" is a
// claim about real bytes on disk, not just a directory existing.
const storeDir = path.join(workDir, 'Store');
mkdirSync(path.join(storeDir, 'boards'), { recursive: true });
const storeBoardFile = path.join(storeDir, 'boards', 'fake-board.json');
const storeBoardContent = JSON.stringify({ id: 'fake-board', title: 'a board that must survive uninstall' });
writeFileSync(storeBoardFile, storeBoardContent);

// The pomodoro document (ADR.md entry 8): the ONE file inside the store
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
//
// It also has to say WHICH daemon it is. install.sh's health gate no longer accepts "something
// answered on the port": the answer must carry a digest of the program path of the daemon that
// run just pointed launchd at (src/server.mjs's DAEMON_ID), or a hand-run node makes a
// throttle-looping install report success. One stub stands in for every install this suite
// performs -- a different CLAUDE_BOARD_APP_DIR per check, plus the degraded ones that run a
// clone's own bin/daemon.mjs -- so it answers with every identity it could legitimately be,
// rescanned per request because those bundles and clones appear as the suite goes. A real daemon
// reports exactly one; the direction that matters (a listener that is NOT the installed daemon
// must fail the install) has its own check below, on its own port and its own stub.
const healthStub = path.join(binDir, 'health-stub.mjs');
writeFileSync(healthStub, `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const workDir = process.argv[3];
const repoRoot = process.argv[4];
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Every bin/daemon.mjs under the scanned roots, as install.sh would name it: the copy
 * staged inside a built bundle (Contents/Resources/bin/daemon.mjs) and the clone's own. */
function daemonPaths(dir, depth, out) {
  if (depth > 8) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) daemonPaths(full, depth + 1, out);
    else if (entry.isFile() && entry.name === 'daemon.mjs' && path.basename(dir) === 'bin') out.push(full);
  }
  return out;
}

http.createServer((req, res) => {
  if (req.url === '/api/health') {
    // The temp tree only: this repo's own bin/daemon.mjs is named directly rather than
    // walked to, so no request ever pays for a walk of the whole clone.
    const identities = [sha(path.join(repoRoot, 'bin', 'daemon.mjs'))];
    for (const p of daemonPaths(workDir, 0, [])) identities.push(sha(p));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 'stub', daemon: identities, pid: process.pid }));
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
const healthProc = spawn(process.execPath, [healthStub, String(healthPort), workDir, repoRoot], { stdio: 'ignore' });
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
  // Both scripts default this to a real path under ~/Library and delete what they
  // find there (marker-gated); the suite's runs stay inside workDir.
  CLAUDE_BOARD_CHECKOUT_DIR: path.join(workDir, 'checkout'),
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
  // What `launchctl print` reports as the job's pid: the health stub's own, so the
  // gate's descends-from-the-job check holds for every run that doesn't deliberately
  // break it.
  STUB_LAUNCHCTL_PRINT_PID: String(healthProc.pid),
};
// Never inherit this check process's own reference allowlist: the plist assertion
// below is about install.sh's resolved DEFAULT, and a developer who exports
// CLAUDE_BOARD_REF_ROOTS in their shell would otherwise fail a check about it.
delete env.CLAUDE_BOARD_REF_ROOTS;

function runInstall() {
  return spawnSync('bash', [installScript], { env, encoding: 'utf8' });
}

/** A throwaway $HOME for a check that needs install.sh to resolve every default somewhere
 * else. UNDER workDir rather than straight under tmpdir(), because the health stub above
 * answers with the identity of every daemon it can find below workDir -- and install.sh's
 * gate now requires the answer to name the daemon THIS run just installed, which for these
 * checks lives at $fakeHome/Applications/claude-board.app/.../bin/daemon.mjs. Removed by
 * its own check either way, and by workDir's teardown if that ever fails. */
function fakeHomeUnderWorkDir(prefix) {
  return mkdtempSync(path.join(workDir, prefix));
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
 * (typically CLAUDE_BOARD_REF_ROOTS) and nothing else from this process.
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
  // "A loopback Host check, an origin check, and a local
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
    // LSUIElement, not LSBackgroundOnly (ADR.md entry 75): a daemon must not take a Dock
    // icon at login, but it DOES need to be activatable so a stranded banner's click can
    // bring it to the front to serve the response -- LSBackgroundOnly declares an app
    // that may never be brought forward, and every click against it fails activation
    // with -600. Both assertions, not just the one on LSUIElement: both keys present is
    // the ambiguous state (LSBackgroundOnly is documented to win), so a future edit that
    // adds LSBackgroundOnly back next to LSUIElement must fail here rather than reopen
    // the -600 alert with a still-green suite.
    assert.equal(infoPlist.LSUIElement, true, 'the bundle must be an agent app so a banner click can activate it (ADR.md entry 75)');
    assert.equal(infoPlist.LSBackgroundOnly, undefined, 'LSBackgroundOnly must be gone, not merely false -- present at all is the ambiguous state the OS resolves in its favour');

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
      env: {
        ...process.env,
        CLAUDE_BOARD_PORT: String(healthPort), // already bound: the daemon exits, fast
        // ADR.md entry 76: the no-argument supervising path now refuses to fork at all
        // without this marker, which install.sh writes into the real plist's
        // EnvironmentVariables dict (asserted elsewhere in this suite);
        // this direct hand-launch stands in for launchd here on purpose, since the point
        // of this particular assertion is still "can it exec node", not the refusal
        // itself -- that has its own suite, test/check-launcher-refuses.mjs.
        CLAUDE_BOARD_LAUNCHD_MARKER: '1',
      },
    });
    assert.doesNotMatch(ran.stderr || '', /cannot exec/, `the launcher must be able to exec its compiled-in node:\n${ran.stderr}`);
  });

  await check('a bundle staged under a temp root is never registered with LaunchServices', async () => {
    // This suite installs into throwaway roots, and every such install stages a bundle
    // carrying the REAL bundle id. install.sh used to hand each one to lsregister, and
    // LaunchServices keeps those records forever: after a few weeks of runs this machine
    // held 6908 of them, nearly all naming paths that had long since been deleted and
    // some naming fixtures built corrupt on purpose (Applications-tamper below).
    // Notification Center resolves a banner by bundle id and picks whichever record it
    // likes, so a dead or tampered one is macOS raising "claude-board.app is damaged and
    // can't be opened", over and over, on a machine whose real install is perfectly fine.
    // The guard is a path test in install.sh, and this is the assertion that it holds:
    // appDir is under tmpdir() by construction (workDir, above).
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    if (!existsSync(lsregister)) return; // Apple moved it: nothing was registered either
    const appPath = path.join(appDir, 'claude-board.app');
    const dump = spawnSync(lsregister, ['-dump'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (dump.status !== 0) return; // no readable database, so nothing this can prove
    // Both spellings: LaunchServices records /private/var/... where tmpdir() says /var/...
    assert.ok(
      !dump.stdout.includes(appPath) && !dump.stdout.includes(path.join('/private', appPath)),
      `install.sh registered a temp-staged bundle with LaunchServices: ${appPath}`,
    );
  });

  await check('uninstall.sh withdraws the LaunchServices record, and skips the same temp roots', async () => {
    // The other end of the same trap. A bundle removed from disk with its record left
    // behind is a live bundle id pointing at nothing, which is the "damaged" dialog
    // arriving weeks after an uninstall. Asserted on the SOURCE rather than behaviourally:
    // this suite only ever uninstalls from a temp root, where by the check above nothing
    // was registered, so there is no record here whose disappearance could be observed.
    // Comment lines are stripped first: this file's header prose quotes both literals
    // while explaining them, so a match anywhere in the source would pass with the call
    // itself deleted.
    const code = src => src.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
    const uninstallCode = code(readFileSync(uninstallScript, 'utf8'));
    const withdraw = uninstallCode.indexOf('"$LSREGISTER" -u "$APP_PATH"');
    const remove = uninstallCode.indexOf('rm -rf "$APP_PATH"');
    assert.ok(withdraw !== -1, 'uninstall.sh must withdraw the record it is deleting the bundle for');
    assert.ok(remove !== -1, 'setup sanity: the rm this is ordered against must still be here');
    assert.ok(
      withdraw > remove,
      'and AFTER the rm: under `set -e` an rm that fails would otherwise abort with the record '
      + 'already gone, leaving a runnable bundle that can never notify (see uninstall.sh step 1b)',
    );
    // ...and OUTSIDE the branch that tests whether the bundle is still there. Nested inside
    // it, the ordinary way a person gets rid of an app -- drag it to the Trash, then run the
    // uninstaller -- left the record behind permanently: a live bundle id naming a path that
    // no longer exists, which macOS answers with "claude-board.app is damaged and can't be
    // opened" weeks later, on a machine with nothing installed. `lsregister -u` works fine on
    // an absent path, so there is nothing to gain from the condition. Structural, for the
    // same reason the rest of this check is: the suite only ever uninstalls from a temp root,
    // where nothing was registered to observe.
    const bundleBranch = uninstallCode.indexOf('if [ -d "$APP_PATH" ]');
    assert.ok(bundleBranch !== -1, 'setup sanity: the bundle-exists branch must still be here');
    const branchEnd = uninstallCode.indexOf('\nfi\n', bundleBranch);
    assert.ok(branchEnd !== -1, 'setup sanity: that branch must still be closed by a top-level fi');
    assert.ok(
      withdraw > branchEnd,
      'the withdrawal must run whether or not the bundle is still on disk -- a bundle trashed by '
      + 'hand before the uninstall is exactly the case that left a permanent "damaged app" record',
    );
    // `is_throwaway_bundle_path` is duplicated across the two scripts by necessity (neither
    // sources the other), so drift is the failure mode: a root install.sh refuses to
    // register but uninstall.sh happily unregisters is harmless; the reverse re-opens the
    // bug above. The WHOLE function is compared, not just its pattern list, because the
    // TMPDIR arm below carries as much of the decision as the patterns do.
    const fn = src => src.match(
      /# --- BEGIN throwaway-bundle test.*?\n(is_throwaway_bundle_path\(\) \{\n.*?\n\})\n/s,
    )?.[1];
    const installFn = fn(readFileSync(installScript, 'utf8'));
    const uninstallFn = fn(readFileSync(uninstallScript, 'utf8'));
    // Asserted to have MATCHED before being compared: a regex miss yields undefined on both
    // sides, and an equality alone would pass vacuously the moment either script is
    // reformatted -- precisely when this check is supposed to fire.
    assert.ok(installFn, 'install.sh must still carry is_throwaway_bundle_path where this can read it');
    assert.ok(uninstallFn, 'uninstall.sh must still carry is_throwaway_bundle_path where this can read it');
    assert.equal(uninstallFn, installFn, 'is_throwaway_bundle_path has drifted between the two scripts');
  });

  await check('is_throwaway_bundle_path answers correctly for every root it has to judge', async () => {
    // The function above is only ever run here with its verdict thrown away, so this runs
    // the real extracted text against the cases that matter. A wrong YES is the expensive
    // direction: the real install silently never registers, and never notifies again.
    const installFn = readFileSync(installScript, 'utf8').match(
      /# --- BEGIN throwaway-bundle test.*?\n(is_throwaway_bundle_path\(\) \{\n.*?\n\})\n/s,
    )?.[1];
    assert.ok(installFn, 'setup sanity: the function text must be extractable');

    const asks = async (appPath, env) => {
      const r = spawnSync('bash', ['-c', `set -euo pipefail\n${installFn}\nis_throwaway_bundle_path "$1"`, 'bash', appPath], {
        encoding: 'utf8', env: { HOME: '/Users/somebody', ...env },
      });
      assert.equal(r.stderr, '', `the function must not error on ${appPath}: ${r.stderr}`);
      return r.status === 0;
    };

    // Throwaway, in every spelling macOS uses. /var/folders is where os.tmpdir() points,
    // and lsregister -dump reports the /private spelling of all of them.
    for (const p of [
      '/tmp/x/claude-board.app',
      '/private/tmp/x/claude-board.app',
      '/var/tmp/x/claude-board.app',
      '/private/var/tmp/x/claude-board.app',
      '/var/folders/vc/abc/T/x/claude-board.app',
      '/private/var/folders/vc/abc/T/x/claude-board.app',
    ]) assert.equal(await asks(p, {}), true, `${p} is a throwaway root`);

    // A real install, under every TMPDIR that must not change the answer.
    const real = '/Users/somebody/Applications/claude-board.app';
    for (const TMPDIR of [undefined, '', '/', '/Users/somebody', '/Users/somebody/', '/var/folders/vc/abc/T/']) {
      assert.equal(
        await asks(real, TMPDIR === undefined ? {} : { TMPDIR }),
        false,
        `a real install must stay registerable with TMPDIR=${JSON.stringify(TMPDIR)} -- a wrong `
        + 'yes here costs it notifications permanently, with no error anywhere',
      );
    }

    // The gap this closes: a developer's own TMPDIR, which no hardcoded pattern names.
    assert.equal(
      await asks('/Users/somebody/tmp/x/claude-board.app', { TMPDIR: '/Users/somebody/tmp' }), true,
      'a bundle under a custom TMPDIR is still a throwaway one',
    );
    assert.equal(
      await asks('/Users/somebody/tmp/x/claude-board.app', { TMPDIR: '/Users/somebody/tmp/' }), true,
      'and the trailing slash macOS itself puts on TMPDIR must not change that',
    );
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
    // An exec wrapper, NOT a copy of the binary: homebrew's node links libnode
    // via @rpath (@loader_path/../lib), so a copied binary dies in dyld before
    // main and `--version` prints nothing (QUIRKS.md "A copied homebrew node
    // binary dies before main"). The test only needs a real node ANSWERING AT A
    // DIFFERENT PATH, which a wrapper is.
    const fakeNode = path.join(binDir, 'node-alias');
    writeFileSync(fakeNode, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
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
      // The launcher's other two halves (ADR.md entry 19, ADR 72), build inputs on the
      // same footing as launcher.c: install.sh copies all three into its staging directory
      // unconditionally, and launcher.c does not link without either of them. The icns is
      // deliberately NOT copied here -- it is the optional input, and a clone without one
      // must still build a bundle.
      writeFileSync(path.join(rogueDir, 'bin', 'notify.m'), readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8'));
      writeFileSync(path.join(rogueDir, 'bin', 'menubar.m'), readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8'));
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
      // Every warning goes to stderr now, so stdout carries only a run that is going well.
      assert.match(r.stderr, /launcher_paths\.h/, 'install.sh must name the leftover header and say it is being ignored');
      assert.doesNotMatch(r.stdout, /error/i, 'the warning must be non-fatal');
      assert.doesNotMatch(r.stdout, /launcher_paths\.h/, 'and must not also leak onto stdout');

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
    // Every warning goes to stderr now.
    assert.match(r.stderr, /no C compiler/, 'it must say why, in as many words');
    assert.match(r.stderr, /EPERM/, 'and name the symptom the user will otherwise hit with no explanation');
    assert.doesNotMatch(r.stdout, /no C compiler|EPERM/, 'and none of it may leak onto stdout');
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

    // With no launcher to bake CLAUDE_BOARD_REF_ROOTS/HOME into, node reads its
    // environment from the plist directly -- so on THIS path, unlike the launcher path
    // asserted elsewhere in this suite, the dict must still carry it exactly as it always
    // did. Losing it here would mean a degraded install silently references nothing, with
    // no allowlist reaching the daemon at all.
    assert.equal(
      fallbackPlist.EnvironmentVariables.CLAUDE_BOARD_REF_ROOTS,
      DEFAULT_REF_ROOTS.map(r => path.join(process.env.HOME, r.slice(2))).join(':'),
      'the degraded plist must carry the reference roots itself -- there is no launcher to bake them into',
    );
    // ADR.md entry 38: `/file/` and CLAUDE_BOARD_SERVE_ROOTS are deleted outright, not
    // merely defaulted -- so no plist, degraded or otherwise, ever carries this key again.
    assert.ok(!('CLAUDE_BOARD_SERVE_ROOTS' in fallbackPlist.EnvironmentVariables), 'the daemon serves boards and nothing else: no serve-roots key, ever');
  });

  await check('a launcher half that will not compile degrades the install rather than aborting it', async () => {
    // The same guarantee the missing-compiler check above makes, against the other way the
    // build can fail now that the launcher has three sources: one of them not compiling.
    // The whole build runs inside install.sh's `elif ! { ... }` condition, which is what
    // keeps `set -euo pipefail` from turning a broken bin/menubar.m into an install that
    // exits non-zero with no daemon and no plist. (Ablation: move any of the three `cc`
    // invocations out of that condition and this check's exit status becomes 1.)
    //
    // menubar.m is the one broken here because it is the newest and the likeliest to be
    // edited; what is being proved is the shape of the branch, which is shared by all
    // three.
    const brokenDir = path.join(workDir, 'clone-with-broken-menubar');
    const brokenAppDir = path.join(workDir, 'Applications-broken-menubar');
    try {
      mkdirSync(path.join(brokenDir, 'bin'), { recursive: true });
      mkdirSync(path.join(brokenDir, 'src'), { recursive: true });
      writeFileSync(path.join(brokenDir, 'bin', 'daemon.mjs'), '// stub, never executed by install.sh itself\n');
      writeFileSync(path.join(brokenDir, 'bin', 'mcp.mjs'), '// stub\n');
      writeFileSync(path.join(brokenDir, 'src', 'stub.mjs'), '// stub\n');
      writeFileSync(path.join(brokenDir, 'bin', 'launcher.c'), readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8'));
      writeFileSync(path.join(brokenDir, 'bin', 'notify.m'), readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8'));
      writeFileSync(path.join(brokenDir, 'bin', 'menubar.m'), 'this is not Objective-C, and clang will say so;\n');
      writeFileSync(path.join(brokenDir, 'install.sh'), readFileSync(installScript, 'utf8'));

      const r = spawnSync('bash', [path.join(brokenDir, 'install.sh')], {
        env: {
          ...env,
          CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(workDir, 'LaunchAgents-broken-menubar'),
          CLAUDE_BOARD_LOG_DIR: path.join(workDir, 'Logs-broken-menubar'),
          CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-broken-menubar', 'claude-board', 'secret'),
          CLAUDE_BOARD_APP_DIR: brokenAppDir,
          ...quietStubs('broken-menubar'),
        },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `a launcher that will not compile must not fail the install:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      // Every warning goes to stderr now, and the compiler's own captured output (clang's
      // real error about menubar.m not being Objective-C) is attributed to the launcher
      // step, not left to a vague "(output above)" that capturing now makes false.
      assert.match(r.stderr, /the launcher failed to compile/, 'it must say why, in as many words');
      assert.doesNotMatch(r.stdout, /the launcher failed to compile/, 'and must not leak onto stdout');
      assert.ok(!existsSync(path.join(brokenAppDir, 'claude-board.app')), 'a half-built bundle must not be installed');

      // ...and the daemon still runs, which is the whole of criterion 13: the fallback
      // plist runs node directly, exactly as it does on a machine with no compiler.
      const fallback = spawnSync('plutil', ['-convert', 'json', '-o', '-',
        path.join(workDir, 'LaunchAgents-broken-menubar', 'claude-board.plist')], { encoding: 'utf8' });
      assert.equal(fallback.status, 0, fallback.stderr);
      const args = JSON.parse(fallback.stdout).ProgramArguments;
      assert.equal(args.length, 2, 'the fallback plist runs node with the daemon script');
      assert.equal(args[1], path.join(brokenDir, 'bin', 'daemon.mjs'));
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
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
    // inert — the key only *starts* a job that is not running, and `KeepAlive` guarantees
    // this one always already is — so this fails on purpose if it comes back. So does
    // re-adding CLAUDE_BOARD_RELOAD_ON_CHANGE, which is the live mechanism that WAS
    // shipped and is now deliberately gone. `bin/daemon.mjs`'s header carries why.)
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

  await check('the plist carries the launchd marker the launcher requires before it will supervise (ADR.md entry 76)', async () => {
    // install.sh writes this into the real EnvironmentVariables dict so that only a real
    // launchd start of the launcher can ever carry it -- bin/launcher.c refuses to fork
    // node without it (test/check-launcher-refuses.mjs is the suite for that refusal
    // itself, compiled and run in isolation rather than through a real installed bundle).
    assert.ok(plist.EnvironmentVariables, 'the plist must carry an EnvironmentVariables dict');
    assert.equal(plist.EnvironmentVariables.CLAUDE_BOARD_LAUNCHD_MARKER, '1');
  });

  await check('when a launcher bundle is in use, the plist carries no roots or store at all -- the launcher bakes them in instead', async () => {
    // The reference allowlist (ADR.md entry 3) is the one knob that moves a security
    // boundary here (the serve allowlist is gone -- ADR.md entry 38), and
    // CLAUDE_BOARD_HOME decides where the store lives. Both used to be written into the
    // plist's EnvironmentVariables dict because a launchd job inherits nothing from the
    // shell that ran install.sh -- but with a launcher bundle in use, bin/launcher.c's
    // OVERRIDE_ENV builds the child's environment itself and ignores whatever the plist
    // says for these two (see launcher_paths.h and "the plist stops carrying what the
    // launcher now bakes" in install.sh's step 2). Leaving the keys in the plist anyway
    // would be a lie about what is actually in force, given anyone who can write that
    // world-readable, user-writable file could otherwise believe rewriting it moves the
    // boundary when it no longer does -- so install.sh omits them entirely once
    // USE_LAUNCHER is 1, which is this suite's ordinary path (see "the launcher bundle is
    // built, signed..." above).
    assert.ok(plist.EnvironmentVariables, 'the plist must still carry an EnvironmentVariables dict');
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in plist.EnvironmentVariables), 'the launcher carries the reference roots now, not the plist');
    assert.ok(!('CLAUDE_BOARD_SERVE_ROOTS' in plist.EnvironmentVariables), 'the daemon serves boards and nothing else: no serve-roots key, ever');
    assert.ok(!('CLAUDE_BOARD_HOME' in plist.EnvironmentVariables), 'the launcher carries the store now, not the plist');

    // What replaces "read it out of the plist": the resolved default is compiled into
    // the launcher as a literal C string (bin/launcher.c's CLAUDE_BOARD_REF_ROOTS_VALUE,
    // via launcher_paths.h) -- proven by reading the executable's own bytes, the same
    // way the CLAUDE_BOARD_NODE override check further below proves its baked-in path.
    // It is also the ONLY place that default exists:
    // src/resolve.mjs reads an absent variable as an empty allowlist, and it is written
    // against DEFAULT_REF_ROOTS rather than a second copy of the list, so the two cannot
    // drift apart silently. Three directories under ~/.claude, not that tree entire:
    // it also holds .credentials.json, settings.json, shell snapshots and
    // every project transcript. The fourth is the render directory (2026-08-05), the one
    // the render skills write into.
    const launcherExec = path.join(appDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board');
    const bakedIn = value => readFileSync(launcherExec).includes(Buffer.from(`${value}\0`, 'utf8'));
    assert.deepEqual(
      [...DEFAULT_REF_ROOTS],
      ['~/.claude/skills', '~/.claude/commands', '~/.claude/agents', '~/Documents/renders'],
    );
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
    // ADR.md entry 36: a migrated plist value is carried-forward the same as a record
    // file's, so it gets the identical treatment -- widened by whichever current default
    // it is missing. `preExisting` names none of DEFAULT_REF_ROOTS, so every default is
    // appended, and the widen is announced on the same run.
    const widenedRoots = `${preExisting}:${DEFAULT_REF_ROOTS.map(r => path.join(process.env.HOME, r.slice(2))).join(':')}`;
    assert.equal(readFileSync(path.join(migrateSecretDir, 'ref_roots'), 'utf8'), widenedRoots, 'the pre-existing plist value must be persisted into the new record file, widened by the current defaults it was missing');
    assert.match(r.stdout, /widened by the current defaults/, 'the widen must be printed, not silent');
    const launcherBytes = readFileSync(path.join(migrateAppDir, 'claude-board.app', 'Contents', 'MacOS', 'claude-board'));
    assert.ok(launcherBytes.includes(Buffer.from(`${widenedRoots}\0`, 'utf8')), 'and actually baked into the launcher, not just recorded');
  });

  await check('an upgrade widens a carried-forward record by whichever current default it is missing, and leaves everything else the operator narrowed alone', async () => {
    // ADR.md entry 36. install.sh used to carry a narrowed record forward unconditionally
    // and forever, which is exactly how a record written before `~/Documents/renders`
    // joined DEFAULT_REF_ROOTS stayed short of it on every later upgrade -- every artifact
    // a page board would show failed to resolve, on a machine that installed cleanly, with
    // nothing on screen saying why. The fix: a carried-forward record is checked against
    // today's defaults on every run, and any default it is missing is added back in and
    // named on screen. Narrowing still works, but only for directories the current
    // defaults do not name -- an operator who wants a genuinely short list now has to keep
    // asserting it with CLAUDE_BOARD_REF_ROOTS rather than relying on the record's
    // inertia (SECURITY.md).
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
    const defaultRoots = DEFAULT_REF_ROOTS.map(r => path.join(process.env.HOME, r.slice(2)));
    const customOnly = path.join(workDir, 'roots-custom-only');

    // 1. The operator narrows to a record that names none of today's defaults -- exactly
    //    the shape a pre-`~/Documents/renders` record has, or any deliberately narrow one.
    const narrowed = spawnSync('bash', [installScript], {
      env: { ...upgradeEnv, CLAUDE_BOARD_REF_ROOTS: customOnly }, encoding: 'utf8',
    });
    assert.equal(narrowed.status, 0, `stdout:\n${narrowed.stdout}\nstderr:\n${narrowed.stderr}`);
    assert.equal(rootsNow(), customOnly, 'an explicit value must be recorded exactly as given');

    // 2. ...and a plain upgrade (no env var -- the ordinary `git pull && ./install.sh`)
    //    carries the custom directory forward AND adds back every default it is missing.
    //    It must NOT stay narrowed to just the custom directory (criterion 13).
    const upgraded = spawnSync('bash', [installScript], { env: upgradeEnv, encoding: 'utf8' });
    assert.equal(upgraded.status, 0, `stdout:\n${upgraded.stdout}\nstderr:\n${upgraded.stderr}`);
    const widenedValue = `${customOnly}:${defaultRoots.join(':')}`;
    assert.equal(rootsNow(), widenedValue, 'the custom directory must survive, and every current default must be appended');
    assert.match(upgraded.stdout, /widened by the current defaults/, 'the widen must be printed, not silent -- the print is load-bearing (ADR.md entry 36)');
    for (const dir of defaultRoots) {
      assert.ok(upgraded.stdout.includes(dir), `the printed line must name what it widened, including ${dir}`);
    }
    assert.ok(bakedIn(widenedValue), 'the widened roots must be compiled into the rebuilt launcher, not just recorded');

    // 3. ...and a SECOND plain upgrade must not widen again: the record already names
    //    every default, so there is nothing left to add and nothing to print.
    const reupgraded = spawnSync('bash', [installScript], { env: upgradeEnv, encoding: 'utf8' });
    assert.equal(reupgraded.status, 0, `stdout:\n${reupgraded.stdout}\nstderr:\n${reupgraded.stderr}`);
    assert.equal(rootsNow(), widenedValue, 'a record that already names every default must not grow further');
    assert.doesNotMatch(reupgraded.stdout, /widened by the current defaults/, 'nothing left to widen means nothing printed');

    // 4. ...while an explicit value still wins over the carried-forward one outright, with
    //    NO widening applied to it -- an operator who just set the variable meant exactly
    //    what they typed, empty included.
    const explicit = path.join(workDir, 'roots-explicit-only');
    const rewidened = spawnSync('bash', [installScript], {
      env: { ...upgradeEnv, CLAUDE_BOARD_REF_ROOTS: explicit }, encoding: 'utf8',
    });
    assert.equal(rewidened.status, 0, `stdout:\n${rewidened.stdout}\nstderr:\n${rewidened.stderr}`);
    assert.equal(rootsNow(), explicit, 'an explicit value must not be widened by the defaults');
    assert.ok(bakedIn(explicit), 'and must reach the rebuilt launcher exactly as given');

    const emptied = spawnSync('bash', [installScript], {
      env: { ...upgradeEnv, CLAUDE_BOARD_REF_ROOTS: '' }, encoding: 'utf8',
    });
    assert.equal(emptied.status, 0, `stdout:\n${emptied.stdout}\nstderr:\n${emptied.stderr}`);
    assert.equal(rootsNow(), '', 'an explicitly empty value must be honoured as empty, not widened');

    // 5. ...and whichever of the runs happened, the resolved value is on screen, and the
    //    plist itself never carries this value at all, now that a launcher bundle is in
    //    use. The boundary moving is exactly the thing that must never be silent.
    for (const r of [narrowed, upgraded, reupgraded, rewidened, emptied]) {
      assert.match(r.stdout, /reference roots:/, 'the install summary must name the resolved roots');
    }
    assert.match(upgraded.stdout, /carried forward from/, 'and say where a carried-forward value came from');
    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    assert.ok(!('CLAUDE_BOARD_REF_ROOTS' in JSON.parse(asJson.stdout).EnvironmentVariables));
  });

  await check('the roots install.sh resolves and records confine a RUNNING daemon, not just its own printout', async () => {
    // The check above this one asserts the plist does NOT contain the key any more,
    // and the migration check proves the record file gets the right bytes -- both are
    // structurally the same shape as the old WatchPaths assertion: a green check sitting
    // on top of a dead mechanism, if nothing then reads that record file back and
    // enforces it. (Stated here rather than cited: the WatchPaths QUIRKS.md entry that
    // carried that phrase went when the mechanism did, and has no successor.)
    // So this one runs install.sh for real, reads back
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

  await check('criterion 8: posting a rendered artifact from ~/Documents/renders resolves on an install upgraded from an older one', async () => {
    // ADR.md entry 36's actual consequence, end to end. A machine installed before
    // `~/Documents/renders` joined DEFAULT_REF_ROOTS carries a record naming only the
    // three `~/.claude` directories -- exactly what install.sh itself used to write. Left
    // alone, that record would silently keep missing the render directory forever, on
    // every future `git pull && ./install.sh`, and every artifact a page board tries to
    // show would come back a "cannot read" error card despite the install looking clean.
    const fakeHome = fakeHomeUnderWorkDir('claude-board-oldrecord-');
    try {
      const secretDir = path.join(fakeHome, 'config', 'claude-board');
      mkdirSync(secretDir, { recursive: true, mode: 0o700 });
      // The pre-upgrade record: an old install's three directories, missing the render
      // default entirely -- written directly, standing in for whatever an install run
      // before this change actually left on disk.
      const oldRecord = ['skills', 'commands', 'agents'].map(d => path.join(fakeHome, '.claude', d)).join(':');
      writeFileSync(path.join(secretDir, 'ref_roots'), oldRecord);

      const rendersDir = path.join(fakeHome, 'Documents', 'renders');
      mkdirSync(rendersDir, { recursive: true });
      const artifact = path.join(rendersDir, 'report.html');
      writeFileSync(artifact, 'RENDERED-ARTIFACT-FROM-RENDERS-DIR\n', 'utf8');

      const projectDir = path.join(fakeHome, 'project');
      mkdirSync(projectDir, { recursive: true });

      const hEnv = {
        ...env,
        HOME: fakeHome,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(fakeHome, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(fakeHome, 'Logs'),
        CLAUDE_BOARD_APP_DIR: path.join(fakeHome, 'Applications'),
        CLAUDE_BOARD_HOME: path.join(fakeHome, 'Store'),
        CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
        STUB_CLAUDE_LOG: path.join(fakeHome, 'claude-invocations.log'),
        STUB_CLAUDE_STATE: path.join(fakeHome, 'claude-registrations.json'),
        STUB_LAUNCHCTL_LOG: path.join(fakeHome, 'launchctl-invocations.log'),
        STUB_LAUNCHCTL_STATE: path.join(fakeHome, 'launchctl-state.json'),
      };
      delete hEnv.CLAUDE_BOARD_REF_ROOTS; // the upgrade run must carry the record forward, not take an explicit value

      // The upgrade: no CLAUDE_BOARD_REF_ROOTS set, a pre-existing record on disk --
      // exactly `git pull && ./install.sh` on a machine installed some time ago.
      const upgraded = spawnSync('bash', [installScript], { env: hEnv, encoding: 'utf8' });
      assert.equal(upgraded.status, 0, `stdout:\n${upgraded.stdout}\nstderr:\n${upgraded.stderr}`);
      assert.match(upgraded.stdout, /widened by the current defaults/, 'the upgrade must announce widening the missing default');

      const recordedRoots = readFileSync(path.join(secretDir, 'ref_roots'), 'utf8');
      assert.ok(recordedRoots.split(':').includes(rendersDir), 'the widened record must include the render directory');

      // And the consequence found in use: a real daemon started with exactly that
      // widened, recorded value can now resolve a reference INTO the render directory,
      // which the pre-upgrade record could never have allowed.
      const daemon = await spawnDaemonWithEnv({ CLAUDE_BOARD_REF_ROOTS: recordedRoots });
      try {
        const posted = await fetch(`http://127.0.0.1:${daemon.port}/api/board`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-claude-board-secret': daemon.secret },
          body: JSON.stringify({
            title: 'artifact posted after an upgrade',
            cwd: projectDir,
            blocks: [{ kind: 'markdown', source: { path: artifact } }],
          }),
        });
        const postedBody = await posted.text();
        assert.equal(posted.status, 200, postedBody);
        const { boardId } = JSON.parse(postedBody);

        const page = await fetch(`http://127.0.0.1:${daemon.port}/b/${boardId}`, {
          headers: { 'x-claude-board-secret': daemon.secret },
        });
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.ok(
          html.includes('RENDERED-ARTIFACT-FROM-RENDERS-DIR'),
          'the artifact must resolve on an install upgraded from an older one, not only on a fresh install',
        );
        assert.ok(!html.includes('cannot read'), 'no unresolved-reference error card');
      } finally {
        daemon.cleanup();
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await check('criterion 24: upgrading removes the serve-root record an older install wrote, leaving no trace of it', async () => {
    // ADR.md entry 38: `/file/`, CLAUDE_BOARD_SERVE_ROOTS and its allowlist are deleted
    // outright. A machine installed before this change has a `serve_roots` file sitting
    // next to its secret that nothing will ever read again -- install.sh's job is to take
    // it away on the very next run, the same way it already does for a BOARD_HOME record
    // nobody chose (the `rm -f` beside the ref/board-home persistence step).
    const fakeHome = fakeHomeUnderWorkDir('claude-board-serveroots-');
    try {
      const secretDir = path.join(fakeHome, 'config', 'claude-board');
      mkdirSync(secretDir, { recursive: true, mode: 0o700 });
      const staleRecord = path.join(secretDir, 'serve_roots');
      writeFileSync(staleRecord, path.join(fakeHome, 'Documents', 'renders'));
      assert.ok(existsSync(staleRecord), 'the fixture must actually plant the stale record before the real assertion');

      const hEnv = {
        ...env,
        HOME: fakeHome,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(fakeHome, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(fakeHome, 'Logs'),
        CLAUDE_BOARD_APP_DIR: path.join(fakeHome, 'Applications'),
        CLAUDE_BOARD_HOME: path.join(fakeHome, 'Store'),
        CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
        // Isolated from the shared top-level `env`'s skillsDir on purpose: this check
        // runs uninstall.sh, whose job includes removing the installed manual, and the
        // suite's OWN install-copies-the-manual checks depend on that shared directory
        // still holding it. Without this override, this check's uninstall run deletes it
        // out from under them.
        CLAUDE_BOARD_SKILLS_DIR: path.join(fakeHome, 'skills'),
        STUB_CLAUDE_LOG: path.join(fakeHome, 'claude-invocations.log'),
        STUB_CLAUDE_STATE: path.join(fakeHome, 'claude-registrations.json'),
        STUB_LAUNCHCTL_LOG: path.join(fakeHome, 'launchctl-invocations.log'),
        STUB_LAUNCHCTL_STATE: path.join(fakeHome, 'launchctl-state.json'),
      };
      delete hEnv.CLAUDE_BOARD_REF_ROOTS;

      const upgraded = spawnSync('bash', [installScript], { env: hEnv, encoding: 'utf8' });
      assert.equal(upgraded.status, 0, `stdout:\n${upgraded.stdout}\nstderr:\n${upgraded.stderr}`);
      assert.ok(!existsSync(staleRecord), 'the upgrade must delete the stale serve-root record, not merely stop reading it');

      // And uninstall, run on the same machine afterwards, must not name a file that no
      // longer exists -- its job is only to stop claiming a record install.sh already took.
      const uninstalled = spawnSync('bash', [uninstallScript], { env: hEnv, encoding: 'utf8' });
      assert.equal(uninstalled.status, 0, `stdout:\n${uninstalled.stdout}\nstderr:\n${uninstalled.stderr}`);
      assert.ok(!uninstalled.stdout.includes('serve_roots'), 'uninstall must not name a serve-roots record: there is none left of it to name');
      assert.ok(!existsSync(staleRecord), 'and it must still not exist after uninstall');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await check('criterion 14 (fifth conjunct): uninstalling with no intervening install.sh still removes a stale serve-root record', async () => {
    // The check above proves the record is gone once install.sh has run -- but criterion
    // 14 says "uninstalling leaves nothing of them behind", and install.sh is not the only
    // path to an uninstall: a machine can go straight from an old install to
    // `git pull && ./uninstall.sh`, with no intervening `./install.sh` at all. Before this
    // fix, uninstall.sh's "left in place on purpose" loop named only ref_roots and
    // board_home, so a serve_roots record left by an old install was never removed and
    // never mentioned -- silent residue uninstall.sh's own header comment claims it does
    // not leave. Fixed by uninstall.sh's own step 2d, which removes the file outright
    // (it is not a preserved choice: the thing it configured, /file/, no longer exists).
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'claude-board-uninstallonly-'));
    try {
      const secretDir = path.join(fakeHome, 'config', 'claude-board');
      mkdirSync(secretDir, { recursive: true, mode: 0o700 });
      const staleRecord = path.join(secretDir, 'serve_roots');
      writeFileSync(staleRecord, path.join(fakeHome, 'Documents', 'renders'));
      assert.ok(existsSync(staleRecord), 'the fixture must actually plant the stale record before the real assertion');

      // Deliberately NOT running install.sh at all here -- uninstall.sh documents itself
      // as safe to run against a machine with nothing installed, and that is exactly the
      // shape of "an old install, never reinstalled, just uninstalled" this covers.
      const uEnv = {
        ...env,
        HOME: fakeHome,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(fakeHome, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(fakeHome, 'Logs'),
        CLAUDE_BOARD_APP_DIR: path.join(fakeHome, 'Applications'),
        CLAUDE_BOARD_HOME: path.join(fakeHome, 'Store'),
        CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
        CLAUDE_BOARD_SKILLS_DIR: path.join(fakeHome, 'skills'),
        // Isolated the same way every other one-off run in this suite is: the shared
        // top-level claudeLog/launchctlLog back the "exactly N adds/removes" counters
        // elsewhere in this file, and this run has nothing to do with those.
        ...quietStubs('uninstallonly'),
      };
      delete uEnv.CLAUDE_BOARD_REF_ROOTS;

      const uninstalled = spawnSync('bash', [uninstallScript], { env: uEnv, encoding: 'utf8' });
      assert.equal(uninstalled.status, 0, `stdout:\n${uninstalled.stdout}\nstderr:\n${uninstalled.stderr}`);
      assert.ok(!existsSync(staleRecord), 'uninstall.sh alone, with no install.sh in between, must remove the stale serve-root record');
      assert.doesNotMatch(uninstalled.stdout, /left in place on purpose:[\s\S]*serve_roots/, 'the record must not be listed as a preserved choice');
      assert.match(uninstalled.stdout, /removed .*serve_roots/, 'and the removal must be announced, not silent');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  await check('xml_escape is byte-safe: a non-UTF-8 byte in a path or a root does not abort the install', async () => {
    // Every value install.sh splices into the plist goes through xml_escape, and a
    // filename is bytes, not text. Under a UTF-8 locale BSD sed refuses input that is
    // not valid UTF-8 with "RE error: illegal byte sequence" and exits non-zero -- and
    // under `set -euo pipefail` that failing command substitution kills the whole
    // install part-way through, having already written a log directory and possibly
    // an MCP registration. One stray byte in a clone path or a reference root is
    // enough.
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
        // Without this the run pays install.sh's full TCC-dialog budget -- 480 tries,
        // two minutes -- waiting for a port nothing will ever bind. What is under test
        // is that the gate fails at all, not how patient it is with a human.
        CLAUDE_BOARD_HEALTH_TRIES: '4',
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

  // ADR.md entry 5: install.sh no longer installs `/grill` or any other
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
  // `command -v node` on a machine using a
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
    // Styled as a warned "manual" step now rather than a literal "warning:" line -- the
    // glyph and colour carry that now, so this checks the step is warned and named, not
    // the word itself.
    assert.match(r.stderr, /manual.*is missing/s, 'a missing manual must be announced, not silent');
  });

  // --- preflight: the three refusals that must cost nothing ---------------------
  //
  // A non-macOS host, a node older than package.json's engines floor, and a missing
  // `claude` CLI are the ways this machine cannot run the service at all. Each used to be
  // discovered late and under a false name -- the last of them at step 5 of 6, with the
  // plist written, a bundle signed and the daemon already running. What every check here
  // asserts alongside the exit code is that NOTHING was written: the whole per-run root
  // directory must still not exist, which is stronger than naming individual paths and
  // catches a future write that lands before the refusal.

  /** Env for a run expected to be refused, with every path install.sh could write under
   * one root of its own, and that root's path for the after-the-fact assertion. */
  function preflightRun(tag, extra) {
    const root = path.join(workDir, `preflight-${tag}`);
    return {
      root,
      env: {
        ...env,
        ...quietStubs(`preflight-${tag}`),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
        CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
        CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
        CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
        CLAUDE_BOARD_HOME: path.join(root, 'Store'),
        ...extra,
      },
    };
  }

  await check('preflight refuses a non-macOS host, naming the real cause, before writing anything', async () => {
    // `uname` is resolved through PATH, so a stub in front of it is the whole fixture --
    // no seam of its own, and the check exercises the exact line a Linux user would hit.
    const fakeUnameDir = path.join(workDir, 'fake-uname-bin');
    mkdirSync(fakeUnameDir, { recursive: true });
    const fakeUname = path.join(fakeUnameDir, 'uname');
    writeFileSync(fakeUname, '#!/bin/sh\necho Linux\n');
    chmodSync(fakeUname, 0o755);

    const { root, env: e } = preflightRun('os', { PATH: `${fakeUnameDir}:${process.env.PATH}` });
    const r = spawnSync('bash', [installScript], { env: e, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'a non-Darwin kernel must fail the install');
    assert.match(r.stderr, /macOS only/, 'and say so, rather than failing later inside launchctl');
    assert.match(r.stderr, /Linux/, 'naming what the host actually reported');
    assert.ok(!existsSync(root), 'a refused install must not have written anything at all');
  });

  await check('preflight refuses a node older than the engines floor, before writing anything', async () => {
    const oldNodeDir = path.join(workDir, 'old-node-bin');
    mkdirSync(oldNodeDir, { recursive: true });
    const oldNode = path.join(oldNodeDir, 'node');
    // Answers --version as an old node and is otherwise the real interpreter: the point is
    // that the refusal happens on the VERSION, before anything executes it for real.
    writeFileSync(oldNode, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v18.20.4"; exit 0; fi\nexec ${process.execPath} "$@"\n`);
    chmodSync(oldNode, 0o755);

    const { root, env: e } = preflightRun('old-node', { CLAUDE_BOARD_NODE: oldNode });
    const r = spawnSync('bash', [installScript], { env: e, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'node 18 must fail the install');
    assert.match(r.stderr, /too old/, 'and the message must name the real cause');
    assert.match(r.stderr, /v18\.20\.4/, 'including the version it actually found');
    assert.ok(!existsSync(root), 'a refused install must not have written anything at all');
  });

  await check('preflight refuses a missing claude CLI, before writing anything', async () => {
    const { root, env: e } = preflightRun('no-claude', { CLAUDE_BOARD_MCP_CMD: 'claude-board-no-such-cli' });
    const r = spawnSync('bash', [installScript], { env: e, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'no CLI to register with must fail the install');
    assert.match(r.stderr, /claude-board-no-such-cli/, 'the message must name the command it looked for');
    assert.match(r.stderr, /Claude Code/, 'and what that command is');
    assert.ok(
      !existsSync(root),
      'this is the one that used to fail at step 5 of 6, after the plist, the bundle and the daemon were already there',
    );
  });

  await check("install.sh's minimum node major is package.json's engines floor, not a number of its own", async () => {
    const declared = readFileSync(installScript, 'utf8').match(/^MIN_NODE_MAJOR=(\d+)$/m);
    assert.ok(declared, 'install.sh must still declare MIN_NODE_MAJOR as a plain assignment');
    const engines = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node;
    const floor = engines.match(/(\d+)/);
    assert.ok(floor, `package.json engines.node must carry a major version: ${engines}`);
    assert.equal(declared[1], floor[1], 'the installer refuses the same node package.json says it needs');
  });

  await check("the version-manager list covers mise, nodenv and fnm's real macOS roots, and nothing stable", async () => {
    // #28: nvm/volta/asdf/n were matched, so a mise, nodenv or fnm user got their moving
    // interpreter COMPILED INTO the signed launcher with nothing on screen -- and the next
    // `node` upgrade breaks launchd exec permanently, which no plist edit can repair.
    //
    // Each case runs install.sh only as far as the preflight: the CLI is deliberately
    // missing, so the run aborts a few lines after the interpreter is resolved. That keeps
    // this to milliseconds and writes nothing, while still exercising the real detection on
    // the real path shape rather than a regex lifted out of the script.
    const cases = [
      ['mise, versioned install', path.join('.local', 'share', 'mise', 'installs', 'node', '24.4.0', 'bin')],
      ['mise, shim', path.join('.local', 'share', 'mise', 'shims')],
      ['nodenv, versioned install', path.join('.nodenv', 'versions', '22.1.0', 'bin')],
      ['nodenv, shim', path.join('.nodenv', 'shims')],
      ['fnm, macOS default root', path.join('Library', 'Application Support', 'fnm', 'node-versions', 'v24.4.0', 'installation', 'bin')],
      ['fnm, per-shell multishell path', path.join('fnm_multishells', '4321_1700000000000', 'bin')],
    ];
    for (const [label, rel] of cases) {
      const dir = path.join(workDir, 'vm', label.replace(/[^a-z]+/gi, '-'), rel);
      mkdirSync(dir, { recursive: true });
      const shim = path.join(dir, 'node');
      writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
      chmodSync(shim, 0o755);

      const { root, env: e } = preflightRun(`vm-${label.replace(/[^a-z]+/gi, '-')}`, {
        PATH: `${dir}:${process.env.PATH}`,
        CLAUDE_BOARD_NODE: '',
        CLAUDE_BOARD_MCP_CMD: 'claude-board-no-such-cli',
      });
      const r = spawnSync('bash', [installScript], { env: e, encoding: 'utf8' });
      // Every warning goes to stderr now.
      assert.match(
        r.stderr, /version-managed/,
        `${label} must be recognised as version-managed -- either the substitution note or the warning, `
        + `never silence:\nstderr:\n${r.stderr}`,
      );
      assert.ok(!existsSync(root), `${label}: the aborted run must still have written nothing`);
    }

    // The other direction, on the same machinery: an ordinary directory is not a version
    // manager, and a false positive here would print a scary note on every stable install.
    const plainDir = path.join(workDir, 'vm-plain', 'bin');
    mkdirSync(plainDir, { recursive: true });
    const plainNode = path.join(plainDir, 'node');
    writeFileSync(plainNode, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(plainNode, 0o755);
    const { env: plainEnv } = preflightRun('vm-plain', {
      PATH: `${plainDir}:${process.env.PATH}`,
      CLAUDE_BOARD_NODE: '',
      CLAUDE_BOARD_MCP_CMD: 'claude-board-no-such-cli',
    });
    const plain = spawnSync('bash', [installScript], { env: plainEnv, encoding: 'utf8' });
    assert.doesNotMatch(plain.stderr, /version-managed/, 'a plain interpreter path must not be flagged');
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
    // Every warning goes to stderr now.
    if (stable) {
      assert.ok(bakedIn(stable), 'a stable interpreter must win over the version-managed one');
      assert.ok(!bakedIn(shim), 'and the version-managed path must not be what the launcher runs');
      assert.match(r.stderr, /version-managed/, 'the substitution must be announced, not silent');
    } else {
      // No stable interpreter anywhere: baking the version-managed path is the only
      // option left, but it must come with the warning that says why it may break.
      assert.ok(bakedIn(shim));
      assert.match(r.stderr, /only a version-managed node/);
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

  // --- the health gate: a proxy must not hide the daemon, a stranger must not pass for it ---

  await check('a proxy in the environment does not hide the local daemon, and the steps after the gate still run', async () => {
    // #11, the most expensive installer bug there was: on a corporate or VPN Mac,
    // ALL_PROXY/*_proxy with no loopback exemption made curl ask the proxy for 127.0.0.1.
    // The daemon was up and healthy; the probe simply never reached it, so install.sh
    // declared it dead and exited BEFORE the MCP registration and the manual -- a
    // genuinely broken install on a machine where nothing was wrong. The proxy address
    // here is a closed port, which is exactly what a wrong proxy behaves like.
    const root = path.join(workDir, 'proxy-run');
    const registrations = path.join(root, 'claude-registrations.json');
    const skills = path.join(root, 'skills');
    const dead = 'http://127.0.0.1:1/';
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        ALL_PROXY: dead, all_proxy: dead, HTTP_PROXY: dead, http_proxy: dead, HTTPS_PROXY: dead, https_proxy: dead,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
        CLAUDE_BOARD_SKILLS_DIR: skills,
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-proxy.log'),
        STUB_CLAUDE_STATE: registrations,
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-proxy.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-proxy.json'),
      },
      encoding: 'utf8',
    });
    // (Ablation: drop --noproxy from the probe and this exits 1 with "it is NOT running".)
    assert.equal(r.status, 0, `an install behind a proxy must succeed:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    // The two steps that come AFTER the gate, which are what the bug actually cost:
    assert.ok(
      JSON.parse(readFileSync(registrations, 'utf8'))['claude-board'],
      'the MCP registration must have run -- it is the step the failed gate used to skip',
    );
    assert.ok(existsSync(path.join(skills, 'claude-board', 'SKILL.md')), 'and the manual must have been copied');
    // ...and the command the reader is told to verify with must work in the shell they are
    // standing in, which the plain one does not.
    assert.match(r.stdout, /curl -s --noproxy/, 'the printed verify command must be the proxy-proof one');
  });

  await check('the health gate refuses a listener that is not the daemon this install just set up', async () => {
    // #29: the gate accepted anything that answered /api/health, so a hand-run
    // `node bin/daemon.mjs` -- or a daemon from another clone still holding the port --
    // made a launchd job that CANNOT bind (and is being throttled into a restart loop)
    // report "installed and running". This stub answers exactly like a healthy daemon
    // whose program path is somewhere else, which is what that hand-run node is.
    const foreignStub = path.join(binDir, 'foreign-health-stub.mjs');
    writeFileSync(foreignStub, `import http from 'node:http';
import crypto from 'node:crypto';
const other = crypto.createHash('sha256').update('/somewhere/else/bin/daemon.mjs', 'utf8').digest('hex');
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 'stub', daemon: other }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.argv[2]), '127.0.0.1');
`);
    const foreignPort = await freePort();
    const foreign = spawn(process.execPath, [foreignStub, String(foreignPort)], { stdio: 'ignore' });
    try {
      assert.ok(await waitForHealthy(foreignPort, 5000), 'setup: the foreign listener must be answering');
      const root = path.join(workDir, 'foreign-run');
      const registrations = path.join(root, 'claude-registrations.json');
      const r = spawnSync('bash', [installScript], {
        env: {
          ...env,
          CLAUDE_BOARD_PORT: String(foreignPort),
          CLAUDE_BOARD_HEALTH_TRIES: '4',
          CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
          CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
          CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
          STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-foreign.log'),
          STUB_CLAUDE_STATE: registrations,
          STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-foreign.log'),
          STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-foreign.json'),
        },
        encoding: 'utf8',
      });
      assert.notEqual(r.status, 0, 'a stranger on the port must fail the install');
      assert.match(r.stderr, /not the daemon\s+this install just set up/, 'and the message must say which problem this is');
      assert.doesNotMatch(r.stdout, /installed and running/);
      assert.ok(!existsSync(registrations), 'a failed install must not have rewritten the MCP registration');
    } finally {
      foreign.kill();
    }
  });

  await check('the health gate refuses a right-digest daemon that is not the launchd job', async () => {
    // The digest's one gap: a hand-run `node bin/daemon.mjs` beside a degraded install
    // is the same program at the same path, so its digest matches. Only the pid tells
    // them apart -- health names the answerer's, `launchctl print` names the job's, and
    // here they are made to disagree while the digest is exactly right.
    const root = path.join(workDir, 'samepath-run');
    const registrations = path.join(root, 'claude-registrations.json');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_HEALTH_TRIES: '4',
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
        CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-samepath.log'),
        STUB_CLAUDE_STATE: registrations,
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-samepath.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-samepath.json'),
        STUB_LAUNCHCTL_PRINT_PID: String(healthProc.pid + 1),
      },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, 'a right-digest wrong-pid listener must fail the install');
    assert.match(r.stderr, /not the daemon\s+this install just set up/, 'and be named as the foreign-listener problem');
    assert.ok(!existsSync(registrations), 'a failed install must not have rewritten the MCP registration');
  });

  await check('the health gate accepts the daemon the launchd job forked, not just the job itself', async () => {
    // The launcher path's actual shape, and the one an equality gate got wrong: the bundle
    // stub forks node instead of exec'ing it (bin/launcher.c, so the daemon keeps the
    // bundle's TCC identity), so launchd's pid is the stub's and health answers with the
    // child's -- never equal. Every launcher install hung at the health probe until the
    // budget ran out, then blamed a foreign listener. Here the job pid is this check
    // process, which is exactly what forked the health stub, so the answerer descends from
    // the job without being it.
    const root = path.join(workDir, 'forked-run');
    const registrations = path.join(root, 'claude-registrations.json');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_HEALTH_TRIES: '8',
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
        CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
        STUB_CLAUDE_LOG: path.join(workDir, 'claude-invocations-forked.log'),
        STUB_CLAUDE_STATE: registrations,
        STUB_LAUNCHCTL_LOG: path.join(workDir, 'launchctl-invocations-forked.log'),
        STUB_LAUNCHCTL_STATE: path.join(workDir, 'launchctl-state-forked.json'),
        STUB_LAUNCHCTL_PRINT_PID: String(process.pid),
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `a daemon forked by the launchd job must pass the gate\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /not the daemon/, 'and must not be mistaken for a foreign listener');
  });

  // --- carry-forward: the port is a choice, like the roots and the store ------------

  await check('a custom CLAUDE_BOARD_PORT survives a reinstall that never mentions it', async () => {
    // #27: the port had no record, so `git pull && ./install.sh` from a clean shell reverted
    // a custom port to the default -- whereupon the running daemon still held the custom one,
    // the new job tried a port it could not have, and KeepAlive throttled the restart loop
    // with nothing on screen naming the cause.
    const root = path.join(workDir, 'port-carry');
    const secretDir = path.join(root, 'config', 'claude-board');
    const record = path.join(secretDir, 'port');
    const agents = path.join(root, 'LaunchAgents');
    const plist = path.join(agents, 'claude-board.plist');
    const portOf = () => {
      const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
      assert.equal(asJson.status, 0, asJson.stderr);
      return JSON.parse(asJson.stdout).EnvironmentVariables.CLAUDE_BOARD_PORT;
    };
    const customPort = await freePort();
    // The gate is real, so the custom port needs a daemon of its own answering on it.
    const stub = spawn(process.execPath, [healthStub, String(customPort), workDir, repoRoot], { stdio: 'ignore' });
    try {
      assert.ok(await waitForHealthy(customPort, 5000), 'setup: the custom-port stub must be answering');
      const base = {
        ...env,
        ...quietStubs('port-carry'),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
        CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
        CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
        CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
        // The pid gate compares against the custom-port stub, not the main one.
        STUB_LAUNCHCTL_PRINT_PID: String(stub.pid),
      };

      const chosen = spawnSync('bash', [installScript], {
        env: { ...base, CLAUDE_BOARD_PORT: String(customPort) }, encoding: 'utf8',
      });
      assert.equal(chosen.status, 0, `stdout:\n${chosen.stdout}\nstderr:\n${chosen.stderr}`);
      assert.equal(portOf(), String(customPort), 'the chosen port must reach the plist');
      assert.equal(readFileSync(record, 'utf8'), String(customPort), 'and be recorded for the next run');

      // The reinstall: a clean shell, no variable, exactly `git pull && ./install.sh`.
      const carriedEnv = { ...base };
      delete carriedEnv.CLAUDE_BOARD_PORT;
      const carried = spawnSync('bash', [installScript], { env: carriedEnv, encoding: 'utf8' });
      assert.equal(carried.status, 0, `stdout:\n${carried.stdout}\nstderr:\n${carried.stderr}`);
      assert.equal(portOf(), String(customPort), 'a reinstall must not revert a custom port to the default');
      // The condensed header does not carry a port-provenance line by default -- only the
      // port itself, which cbs_header always shows because the verify command needs it.
      // --verbose restores the full header, provenance included, so the "never silently"
      // claim is checked there instead of on the bounded default run.
      const carriedVerbose = spawnSync('bash', [installScript, '--verbose'], { env: carriedEnv, encoding: 'utf8' });
      assert.equal(carriedVerbose.status, 0, `stdout:\n${carriedVerbose.stdout}\nstderr:\n${carriedVerbose.stderr}`);
      assert.match(carriedVerbose.stdout, /carried forward from/, 'and --verbose must say where the port came from, never silently');

      // And the one-time migration, for a machine whose plist predates the record: delete
      // the record, leave the plist, and the port still survives -- the same fallback
      // REF_ROOTS and CLAUDE_BOARD_HOME have.
      rmSync(record);
      const migrated = spawnSync('bash', [installScript], { env: carriedEnv, encoding: 'utf8' });
      assert.equal(migrated.status, 0, `stdout:\n${migrated.stdout}\nstderr:\n${migrated.stderr}`);
      assert.equal(portOf(), String(customPort), 'an install predating the record must migrate its port out of the plist');
      assert.equal(readFileSync(record, 'utf8'), String(customPort), 'and write the record so this happens once');
    } finally {
      stub.kill();
    }
  });

  await check("install.sh's default port is src/handoff.mjs's, not a number of its own", async () => {
    const declared = readFileSync(installScript, 'utf8').match(/^DEFAULT_PORT=(\d+)$/m);
    assert.ok(declared, 'install.sh must still declare DEFAULT_PORT as a plain assignment');
    assert.equal(Number(declared[1]), DEFAULT_PORT, 'the installer and the shim must agree on the default port');
  });

  // --- guards on the values that get baked in --------------------------------------

  await check('an empty CLAUDE_BOARD_HOME is refused, and a zero-byte record left by an older run heals itself', async () => {
    // #41: an empty variable used to bake CLAUDE_BOARD_STORE_DIR "" into the signed
    // launcher AND leave a zero-byte carry-forward record, which every later reinstall read
    // back and honoured -- a sticky wrong answer from a single stray `CLAUDE_BOARD_HOME=`.
    const { root, env: e } = preflightRun('empty-home', { CLAUDE_BOARD_HOME: '' });
    const r = spawnSync('bash', [installScript], { env: e, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'an empty store path must be refused, not baked');
    assert.match(r.stderr, /CLAUDE_BOARD_HOME is set but empty/);
    assert.ok(!existsSync(root), 'and refused before anything is written');

    // The other half: a machine that already carries the zero-byte record must recover on
    // its own, rather than needing the file deleted by hand.
    const home = fakeHomeUnderWorkDir('empty-record-');
    const secretDir = path.join(home, 'config', 'claude-board');
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const record = path.join(secretDir, 'board_home');
    writeFileSync(record, '');
    const healEnv = {
      ...env,
      ...quietStubs('empty-record'),
      HOME: home,
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(home, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(home, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(home, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(home, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
    };
    delete healEnv.CLAUDE_BOARD_HOME;
    const healed = spawnSync('bash', [installScript], { env: healEnv, encoding: 'utf8' });
    assert.equal(healed.status, 0, `stdout:\n${healed.stdout}\nstderr:\n${healed.stderr}`);
    assert.ok(!existsSync(record), 'a zero-byte store record must be taken away, not read back forever');
    // The condensed header prints only a value that differs from its built-in default, so
    // a healed, default store earns no line at all -- the old assertion pinned the exact
    // default-store line this change deletes on purpose.
    assert.doesNotMatch(healed.stdout, /store:/, 'and the run must resolve the default store silently, with no header line for it');
  });

  await check('a newline in any value the launcher bakes degrades the install instead of compiling it in', async () => {
    // #40: the guard covered the interpreter and daemon paths only, so a newline in $HOME,
    // the store or the reference roots reached the generated C header -- where it ends the
    // string literal early. Both cases below are values a launcher #define carries.
    for (const [label, extra] of [
      ['reference roots', { CLAUDE_BOARD_REF_ROOTS: `${workDir}/roots-a\n${workDir}/roots-b` }],
      ['the store', { CLAUDE_BOARD_HOME: `${workDir}/store-a\nstore-b` }],
    ]) {
      const root = path.join(workDir, `newline-${label.replace(/[^a-z]+/gi, '-')}`);
      const appDirHere = path.join(root, 'Applications');
      const r = spawnSync('bash', [installScript], {
        env: {
          ...env,
          ...quietStubs(`newline-${label.replace(/[^a-z]+/gi, '-')}`),
          CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
          CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
          CLAUDE_BOARD_APP_DIR: appDirHere,
          CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
          CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
          ...extra,
        },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `${label}: the install must degrade, not fail:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      // Named by the guard rather than discovered by the compiler: without the guard this
      // still degrades, but only after a wasted build and with "failed to compile" on
      // screen, which points the reader at their toolchain instead of at their value.
      // Every warning goes to stderr now.
      assert.match(r.stderr, /contains a newline/, `${label}: the newline must be named as the reason`);
      assert.ok(!existsSync(path.join(appDirHere, 'claude-board.app')), `${label}: no bundle may be built from it`);
    }
  });

  // --- plist XML injection --------------------------------
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
    // All three halves of the binary, since launcher.c calls into both of these (ADR.md
    // entry 19, ADR 72). The icns is left out on purpose here too: this clone builds a
    // bundle without one.
    writeFileSync(path.join(oddDir, 'bin', 'notify.m'), readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8'));
    writeFileSync(path.join(oddDir, 'bin', 'menubar.m'), readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8'));
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

  // --- ~/.claude/settings.json is not this repo's file --------------
  //
  // The half provable without a running Claude Code
  // session: install.sh reads and writes nothing under ~/.claude/settings.json.
  // uninstall.sh leaves the SessionStart hook snippet INSTALL.md
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
    const fakeHome = fakeHomeUnderWorkDir('claude-board-fakehome-');
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

  // --- uninstall ----------------------------------
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
    // uninstall exists to prevent.
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

  await check('uninstall removes pomodoro.json by exact name and nothing else in the store (ADR.md entry 8)', async () => {
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
    // The carry-forward records are choices, not residue, so they survive -- and a record
    // that survives unnamed is the residue this summary exists to prevent. The port joined
    // them when it became a carried choice of its own.
    for (const record of ['ref_roots', 'port']) {
      const p = path.join(path.dirname(secretFile), record);
      assert.ok(existsSync(p), `setup sanity: install.sh must have written ${record}`);
      assert.ok(uninstallResult.stdout.includes(p), `must name the ${record} record it left in place`);
    }
  });

  await check('uninstall prints through the same checklist vocabulary as install, and the keep-list still prints in full', async () => {
    // The install side of this criterion is proven where install.sh's own step lines are
    // asserted; this is uninstall's half. Each step this script performs must print
    // through the shared fence -- a ticked, two-space-indented, glyph-then-padded-name
    // line -- rather than falling back to a bare `==>` line the way every step used to.
    // `cleanup` (the stale serve_roots record) is deliberately excluded: this run's
    // fixture never plants that record, so the step is silent by design (see the
    // dedicated checks above for that case both ways).
    for (const step of ['job', 'plist', 'launcher', 'mcp', 'pomodoro', 'manual']) {
      assert.match(
        uninstallResult.stdout,
        new RegExp(`^  \\u2713  ${step}\\b`, 'm'),
        `the ${step} step must print through the shared checklist vocabulary (a ticked line), not a bare ==> line`,
      );
    }
    // The "left in place on purpose" list is the one thing the spec says must NOT
    // collapse the way the rest of the transcript does: full heading, every path, the
    // per-record loop, and both closing paragraphs, all still present.
    assert.match(uninstallResult.stdout, /left in place on purpose:/, 'the keep-list heading must survive');
    assert.ok(uninstallResult.stdout.includes(storeDir), 'the store path must still be named in full');
    assert.ok(uninstallResult.stdout.includes(secretFile), 'the secret path must still be named in full');
    assert.ok(uninstallResult.stdout.includes(logDir), 'the logs path must still be named in full');
    assert.match(uninstallResult.stdout, /Privacy & Security/, 'the Privacy & Security paragraph must survive');
    assert.match(uninstallResult.stdout, /SessionStart hook snippet/, 'the settings.json paragraph must survive');
  });

  await check('uninstall resolves a custom store from the board_home record rather than the default path', async () => {
    // #26: uninstall.sh read CLAUDE_BOARD_HOME from the environment only, so a machine
    // installed with a custom store -- recorded by install.sh precisely so a later run in a
    // clean shell can find it -- got its pomodoro.json left behind AND was told the DEFAULT
    // directory was "your review history", pointing the reader at a folder that is not theirs.
    const home = fakeHomeUnderWorkDir('uninstall-custom-store-');
    const secretDir = path.join(home, 'config', 'claude-board');
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const customStore = path.join(home, 'Elsewhere', 'boards');
    mkdirSync(path.join(customStore, 'boards'), { recursive: true });
    const keeper = path.join(customStore, 'boards', 'keep.json');
    const keeperContent = JSON.stringify({ id: 'keep', title: 'review history that must survive' });
    writeFileSync(keeper, keeperContent);
    const pomodoro = path.join(customStore, 'pomodoro.json');
    writeFileSync(pomodoro, JSON.stringify({ deadline: 1, cycles: 0 }));
    writeFileSync(path.join(secretDir, 'board_home'), customStore);

    const uEnv = {
      ...env,
      ...quietStubs('uninstall-custom-store'),
      HOME: home,
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(home, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(home, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(home, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(home, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'secret'),
    };
    // The whole point: the shell running the uninstall never says where the store is.
    delete uEnv.CLAUDE_BOARD_HOME;

    const r = spawnSync('bash', [uninstallScript], { env: uEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(!existsSync(pomodoro), 'the timer document in the CUSTOM store must be removed');
    assert.ok(existsSync(keeper), 'and the review history beside it must survive');
    assert.equal(readFileSync(keeper, 'utf8'), keeperContent, 'byte for byte');
    assert.ok(r.stdout.includes(customStore), 'the summary must name the store the user actually has');
    assert.ok(
      !r.stdout.includes(path.join(home, 'Library', 'Application Support', 'claude-board')),
      'and must not name the default one it does not use',
    );
  });

  // ADR.md entry 5: install.sh no longer installs `/grill` or any other
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
    // every other removal in uninstall.sh gets. Re-laid-out under the checklist: the
    // path now sits in its own dimmed column rather than glued onto the result text
    // with "at", so the two are asserted separately instead of as one contiguous phrase.
    assert.match(second.stdout, /no pomodoro state/, 'a second uninstall must report the timer file as already absent, not silently skip it');
    assert.ok(second.stdout.includes(pomodoroFile), 'and must still name the file it found absent');
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
        // The third: step 2e's default is the real plugin checkout under
        // ~/Library/Application Support, marker-gated but still not this suite's to
        // touch (audit 2026-08-12, the same seam class as the two above).
        CLAUDE_BOARD_CHECKOUT_DIR: path.join(freshWorkDir, 'checkout'),
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

  // --- the checklist transcript: line budget, capture-on-failure, --verbose -----------

  /** Runs install.sh twice against `lineCountEnv` and returns the second (already-current)
   * run's stdout line count. Shared by the default and non-default-store cases below. */
  function alreadyCurrentLineCount(lineCountEnv) {
    const first = spawnSync('bash', [installScript], { env: lineCountEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `first run must succeed:\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

    // The second run is an already-current bundle: nothing about it is new, and the
    // transcript is at its shortest for whatever config this run carries.
    const second = spawnSync('bash', [installScript], { env: lineCountEnv, encoding: 'utf8' });
    assert.equal(second.status, 0, `second run must succeed:\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /already current/, 'setup sanity: the second run must find the bundle already current');
    return second.stdout.replace(/\n$/, '').split('\n').length;
  }

  await check('a re-install with an already-current launcher bundle and the default config prints no more than 13 stdout lines', async () => {
    // No CLAUDE_BOARD_HOME or CLAUDE_BOARD_REF_ROOTS: the true out-of-the-box case the
    // render depicts, where every carried-forward value is still the built-in default and
    // earns no header line -- the roomiest case, and the tightest bound.
    const root = path.join(workDir, 'linecount-default-run');
    const lineCountEnv = {
      ...env,
      ...quietStubs('linecount-default'),
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
    };
    delete lineCountEnv.CLAUDE_BOARD_HOME;
    delete lineCountEnv.CLAUDE_BOARD_REF_ROOTS;

    const lineCount = alreadyCurrentLineCount(lineCountEnv);
    assert.ok(lineCount <= 13, `expected at most 13 stdout lines on the default config, got ${lineCount}`);
  });

  await check('a re-install with an already-current launcher bundle and a non-default store prints no more than 14 stdout lines', async () => {
    // The headline claim of the whole task, and the case that actually stresses the
    // budget rather than documenting a gap in it: a machine that ever set
    // CLAUDE_BOARD_HOME carries a board_home record forever, so its store line prints on
    // every later reinstall, and this is still "a successful re-install on a machine
    // whose launcher bundle is already current". A widen on top of a custom store would
    // be 15 and is a known, deliberate exception (ADR.md entry 36 makes the widen line
    // non-negotiable) -- out of scope for this bound.
    const root = path.join(workDir, 'linecount-store-run');
    const lineCountEnv = {
      ...env,
      ...quietStubs('linecount-store'),
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
      CLAUDE_BOARD_HOME: path.join(root, 'Store'),
    };
    delete lineCountEnv.CLAUDE_BOARD_REF_ROOTS;

    const lineCount = alreadyCurrentLineCount(lineCountEnv);
    assert.ok(lineCount <= 14, `expected at most 14 stdout lines with a non-default store, got ${lineCount}`);
  });

  await check('a failing MCP registration prints its captured output, attributed to the mcp step', async () => {
    // A stub standing in for `claude` that fails `mcp add` after printing to both of its
    // own streams -- cbs_run_captured merges them, so both must surface, and only on
    // install.sh's stderr, indented beneath the step that ran the command.
    const root = path.join(workDir, 'mcp-fail-run');
    const failingClaudeStub = path.join(root, 'bin', 'failing-claude.mjs');
    mkdirSync(path.dirname(failingClaudeStub), { recursive: true });
    writeFileSync(failingClaudeStub, [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args[0] === 'mcp' && args[1] === 'remove') process.exit(1);",
      "if (args[0] === 'mcp' && args[1] === 'add') {",
      "  process.stdout.write('CAPTURE-MARKER-STDOUT-LINE\\n');",
      "  process.stderr.write('CAPTURE-MARKER-STDERR-LINE\\n');",
      '  process.exit(1);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'));
    chmodSync(failingClaudeStub, 0o755);

    const mcpFailEnv = {
      ...env,
      ...quietStubs('mcp-fail'),
      CLAUDE_BOARD_MCP_CMD: failingClaudeStub,
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
    };
    const r = spawnSync('bash', [installScript], { env: mcpFailEnv, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'a failing MCP registration must fail the install');
    assert.match(r.stderr, /mcp add' failed/, 'the mcp step must be named as the one that failed');
    assert.match(r.stderr, /CAPTURE-MARKER-STDOUT-LINE/, "the failed command's own stdout must be captured and shown");
    assert.match(r.stderr, /CAPTURE-MARKER-STDERR-LINE/, 'and its stderr too -- cbs_run_captured merges both');
    assert.doesNotMatch(r.stdout, /CAPTURE-MARKER/, 'captured output must never reach stdout');
  });

  // --- plugin origin -------------------------------------------------------------
  // install.sh relocates a run that starts under the plugin cache root to a stable
  // checkout and re-execs from it (its "plugin origin" block says why: the cache is
  // versioned and swept on update, so nothing durable may name it). Staged under a fake
  // cache root via the CLAUDE_BOARD_PLUGIN_CACHE_ROOT seam -- the real root is under
  // $HOME/.claude, which this suite never touches.

  /** The exact entry set the relocation copies, staged at `dest`. One staged file is
   * made read-only on purpose: the relocation's `chmod -R u+w` exists for a hostile
   * source tree, and a stage with no read-only file would never exercise it. */
  function stagePluginTree(dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of ['install.sh', 'uninstall.sh', 'package.json', 'LICENSE', 'bin', 'src', 'skills']) {
      cpSync(path.join(repoRoot, entry), path.join(dest, entry), { recursive: true });
    }
    chmodSync(path.join(dest, 'skills', 'claude-board', 'SKILL.md'), 0o444);
  }

  /** Per-check roots for a run that must not share the suite-wide dirs. */
  function pluginEnv(root, tag, extra) {
    return {
      ...env,
      ...quietStubs(tag),
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills-dest'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
      ...extra,
    };
  }
  // Every spawn below gets a timeout: two of these checks exist to prove "refuses
  // instead of looping", and without a timeout a regression there hangs the suite
  // forever instead of failing it.
  const PLUGIN_SPAWN_OPTS = { encoding: 'utf8', timeout: 120_000 };

  await check('a plugin-origin run relocates to the checkout, twice, and nothing durable names the cache', async () => {
    const root = path.join(workDir, 'plugin-origin');
    const cacheRoot = path.join(root, 'plugins');
    const cacheCopy = path.join(cacheRoot, 'cache', 'claude-board', 'claude-board', 'deadbeef1234');
    const checkout = path.join(root, 'checkout');
    stagePluginTree(cacheCopy);
    const stubs = quietStubs('plugin-origin');
    // Trailing slash on the seam on purpose: the block normalises it, and without the
    // trim the tmp dir lands inside the old checkout and both are deleted (audit
    // 2026-08-12, reproduced).
    const runEnv = pluginEnv(root, 'plugin-origin', {
      ...stubs,
      CLAUDE_BOARD_PLUGIN_CACHE_ROOT: cacheRoot,
      CLAUDE_BOARD_CHECKOUT_DIR: `${checkout}/`,
      // The loop guard is argv-only: an exported variable must not pre-arm it and
      // refuse this perfectly legitimate first relocation (a `:-` default would).
      INSTALL_RELOCATED: '1',
    });
    const r = spawnSync('bash', [path.join(cacheCopy, 'install.sh')], { env: runEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(r.signal, null, 'the run must finish on its own, not on the timeout');
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /relocating/, 'the relocation must be announced, not silent');
    // The checkout is complete, marked, and owner-only -- not merely present.
    for (const f of ['install.sh', 'uninstall.sh', 'bin/daemon.mjs', 'bin/mcp.mjs', 'src/server.mjs', '.claude-board-checkout']) {
      assert.ok(existsSync(path.join(checkout, f)), `the checkout must carry ${f}`);
    }
    assert.equal(statSync(checkout).mode & 0o077, 0, 'the checkout must be owner-only');
    assert.ok(statSync(path.join(checkout, 'skills', 'claude-board', 'SKILL.md')).mode & 0o200,
      'the read-only staged file must have been made writable (chmod -R u+w)');
    assert.equal(readFileSync(path.join(root, 'config', 'claude-board', 'checkout'), 'utf8'), checkout,
      'the record beside the secret must name the real checkout');
    // Nothing durable names the cache: not the plist, not the MCP registration.
    const plistDir = path.join(root, 'LaunchAgents');
    const plists = readdirSync(plistDir).map(f => readFileSync(path.join(plistDir, f), 'utf8')).join('\n');
    assert.ok(!plists.includes(cacheCopy), 'the plist must not point into the plugin cache');
    const claudeLog = readFileSync(stubs.STUB_CLAUDE_LOG, 'utf8');
    assert.ok(!claudeLog.includes(cacheCopy), 'the MCP registration must not point into the plugin cache');
    assert.ok(claudeLog.includes(path.join(checkout, 'bin', 'mcp.mjs')),
      'the MCP registration must name the checkout shim');
    assert.ok(existsSync(path.join(root, 'skills-dest', 'claude-board', 'SKILL.md')),
      'the manual must land at its personal-skill home, plugin origin or not');
    // Second run: the headline idempotency claim holds on this path too, the swap
    // replaces the marked checkout it made, and the staging leaves no litter behind.
    const second = spawnSync('bash', [path.join(cacheCopy, 'install.sh')], { env: runEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(second.status, 0, `second run:\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.ok(existsSync(path.join(checkout, 'bin', 'daemon.mjs')), 'the checkout must survive a repeat install');
    const litter = readdirSync(root).filter(n => n.startsWith('checkout.tmp.') || n.startsWith('checkout.old.'));
    assert.deepEqual(litter, [], 'a completed swap must leave no tmp or old dirs beside the checkout');
  });

  await check('the relocation refuses rather than deletes: a looping checkout, and a dir that is not ours', async () => {
    const root = path.join(workDir, 'plugin-loop');
    const cacheRoot = path.join(root, 'plugins');
    const cacheCopy = path.join(cacheRoot, 'cache', 'claude-board', 'claude-board', 'deadbeef5678');
    stagePluginTree(cacheCopy);
    // A checkout under the cache root: refused BEFORE anything is copied or deleted --
    // the reactive form of this guard cost a full destructive relocation first (audit
    // 2026-08-12, reproduced).
    const nested = path.join(cacheRoot, 'cache', 'nested-checkout');
    const r = spawnSync('bash', [path.join(cacheCopy, 'install.sh')], {
      env: pluginEnv(root, 'plugin-loop', {
        CLAUDE_BOARD_PLUGIN_CACHE_ROOT: cacheRoot,
        CLAUDE_BOARD_CHECKOUT_DIR: nested,
      }),
      ...PLUGIN_SPAWN_OPTS,
    });
    assert.equal(r.signal, null, 'the refusal must not be the timeout');
    assert.notEqual(r.status, 0, 'a checkout inside the cache root must fail the install, not loop');
    assert.match(r.stderr, /CLAUDE_BOARD_CHECKOUT_DIR/, 'and the refusal must name the override that fixes it');
    assert.ok(!existsSync(nested), 'and must refuse before staging anything at the looping path');
    // A directory at the checkout path with no marker file is not ours: refused, kept.
    const foreign = path.join(root, 'foreign-checkout');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(path.join(foreign, 'precious.txt'), 'not a checkout');
    const r2 = spawnSync('bash', [path.join(cacheCopy, 'install.sh')], {
      env: pluginEnv(root, 'plugin-foreign', {
        CLAUDE_BOARD_PLUGIN_CACHE_ROOT: cacheRoot,
        CLAUDE_BOARD_CHECKOUT_DIR: foreign,
      }),
      ...PLUGIN_SPAWN_OPTS,
    });
    assert.notEqual(r2.status, 0, 'a marker-less directory at the checkout path must refuse the install');
    assert.ok(existsSync(path.join(foreign, 'precious.txt')), 'and must leave the directory exactly as it was');
  });

  await check('a clone install takes back a marked checkout, and only a marked one', async () => {
    const root = path.join(workDir, 'plugin-takeover');
    const checkout = path.join(root, 'stale-checkout');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, '.claude-board-checkout'), '');
    writeFileSync(path.join(checkout, 'leftover.mjs'), '// stale plugin code');
    const runEnv = pluginEnv(root, 'plugin-takeover', { CLAUDE_BOARD_CHECKOUT_DIR: checkout });
    // Clone origin: run from the repo itself, cache-root seam untouched.
    const r = spawnSync('bash', [installScript], { env: runEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /superseded/, 'the takeover must be announced');
    assert.ok(!existsSync(checkout), 'a clone install must take the stale checkout back');
    // The same path without the marker survives the same run untouched, silently.
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, 'precious.txt'), 'a real clone parked here');
    const r2 = spawnSync('bash', [installScript], { env: runEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(r2.status, 0);
    assert.ok(existsSync(path.join(checkout, 'precious.txt')), 'a marker-less directory is never ours to delete');
  });

  await check('uninstall removes a marked checkout via its record, and refuses a marker-less one', async () => {
    const root = path.join(workDir, 'plugin-uninstall');
    const cacheRoot = path.join(root, 'plugins');
    const cacheCopy = path.join(cacheRoot, 'cache', 'claude-board', 'claude-board', 'deadbeefabcd');
    const checkout = path.join(root, 'checkout');
    stagePluginTree(cacheCopy);
    const runEnv = pluginEnv(root, 'plugin-uninstall', {
      CLAUDE_BOARD_PLUGIN_CACHE_ROOT: cacheRoot,
      CLAUDE_BOARD_CHECKOUT_DIR: checkout,
    });
    const installed = spawnSync('bash', [path.join(cacheCopy, 'install.sh')], { env: runEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(installed.status, 0, `setup sanity:\n${installed.stdout}\n${installed.stderr}`);
    // The record, not the seam, is what a real uninstall has: drop the seam here.
    const { CLAUDE_BOARD_CHECKOUT_DIR: _dropped, ...uninstallEnv } = runEnv;
    const r = spawnSync('bash', [path.join(checkout, 'uninstall.sh')], { env: uninstallEnv, ...PLUGIN_SPAWN_OPTS });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(!existsSync(checkout), 'uninstall must remove the checkout the record names');
    assert.ok(!existsSync(path.join(root, 'config', 'claude-board', 'checkout')), 'and the record with it');
    // A marker-less dir at the checkout path is warned about and kept.
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, 'precious.txt'), 'not ours');
    const r2 = spawnSync('bash', [uninstallScript], {
      env: { ...uninstallEnv, CLAUDE_BOARD_CHECKOUT_DIR: checkout }, ...PLUGIN_SPAWN_OPTS,
    });
    assert.equal(r2.status, 0);
    assert.ok(existsSync(path.join(checkout, 'precious.txt')), 'a marker-less directory survives uninstall');
    assert.match(r2.stderr, /not removed/, 'and the refusal is said out loud, not silent');
  });

  await check('the plugin manifests name what exists, and bundle no MCP server and no second manual', async () => {
    // install.sh is the single registrar: the plugin delivers the tree and
    // /claude-board:install, nothing else. A plugin MCP server would rename the ask
    // tool (mcp__plugin_* prefix); a plugin copy of the manual would double-register it.
    const plugin = JSON.parse(readFileSync(path.join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, 'claude-board');
    assert.deepEqual(plugin.skills, ['./plugin-skills'], 'skills override must hide skills/ (the manual) from plugin discovery');
    assert.ok(!('mcpServers' in plugin), 'no inline plugin MCP server');
    assert.ok(!existsSync(path.join(repoRoot, '.mcp.json')), 'no .mcp.json at the plugin root');
    const skill = readFileSync(path.join(repoRoot, 'plugin-skills', 'install', 'SKILL.md'), 'utf8');
    assert.match(skill, /^name: install$/m, 'frontmatter name pins the invocation (cache dir names are version strings)');
    assert.match(skill, /^disable-model-invocation: true$/m);
    const marketplace = JSON.parse(readFileSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.name, 'claude-board');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'claude-board');
    assert.equal(marketplace.plugins[0].source, './');
  });

  await check('--verbose restores the full config header and the standing prose in full, even on a repeat run', async () => {
    const root = path.join(workDir, 'verbose-run');
    const verboseEnv = {
      ...env,
      ...quietStubs('verbose'),
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
    };
    // First run builds the bundle (LAUNCHER_IS_NEW=1); the second is the ordinary
    // reinstall that would otherwise collapse the standing prose to the pointer line.
    const first = spawnSync('bash', [installScript], { env: verboseEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

    const second = spawnSync('bash', [installScript, '--verbose'], { env: verboseEnv, encoding: 'utf8' });
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /already current/, 'setup sanity: the second run must find the bundle already current');
    assert.match(second.stdout, /repo:/, '--verbose must restore the full config header');
    assert.match(
      second.stdout, /Privacy & Security -> Files and Folders/,
      '--verbose must restore the standing prose in full, even though this bundle is not new',
    );
    assert.doesNotMatch(
      second.stdout, /macOS file access and notifications: README/,
      'and must not also print the collapsed pointer line on top of the full prose',
    );
  });

  await check('stripping ANSI from a real, coloured install.sh run reproduces the same install\'s plain run, line for line', async () => {
    // The transcript-styling block's own suite below proves this against a synthetic
    // driver script that calls the fence's functions directly -- useful for pinning the
    // mechanism, but "the same install" is the actual claim, and this is the one check
    // that runs bash install.sh itself, twice, against the same throwaway root.
    const root = path.join(workDir, 'colour-equivalence-run');
    // The "and on stderr too" setup sanity below needs the reinstall to write SOMETHING
    // to stderr, and the only thing a healthy reinstall writes there is install.sh's
    // version-managed-node warn (:568-588, fires whenever `command -v node` matches a
    // pattern like */.nvm/*). That is true on a machine whose own node happens to be
    // nvm-managed, and false on CI's hosted toolcache node -- so make it true on every
    // machine instead of relying on the one running this check: put a node under a fake
    // .nvm path first on PATH. Either warn branch (a stable node substituted, or the
    // version-managed one kept) writes to stderr, so this doesn't need to control which
    // one fires, only that `command -v node` resolves under the fake path.
    const fakeNvmDir = path.join(workDir, 'fake-nvm', '.nvm', 'versions', 'node', 'v1', 'bin');
    mkdirSync(fakeNvmDir, { recursive: true });
    symlinkSync(process.execPath, path.join(fakeNvmDir, 'node'));
    const colourEnv = {
      ...env,
      ...quietStubs('colour-equivalence'),
      PATH: `${fakeNvmDir}:${env.PATH}`,
      // Never inherit a developer's own CLAUDE_BOARD_NODE (nvm users are told to export
      // it, install.sh:578/SECURITY.md): set, it skips version-managed detection
      // entirely (install.sh:565's NODE_BIN starts non-empty), so no warn fires and the
      // stderr setup-sanity assertion below fails for a reason unrelated to the check.
      // Same guard as the sibling node-detection checks above.
      CLAUDE_BOARD_NODE: '',
      CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(root, 'LaunchAgents'),
      CLAUDE_BOARD_LOG_DIR: path.join(root, 'Logs'),
      CLAUDE_BOARD_APP_DIR: path.join(root, 'Applications'),
      CLAUDE_BOARD_SKILLS_DIR: path.join(root, 'skills'),
      CLAUDE_BOARD_SECRET_FILE: path.join(root, 'config', 'claude-board', 'secret'),
    };
    // First run builds the bundle; the second (compared below) is the ordinary,
    // already-current reinstall -- warned node line included, so both streams carry
    // something to compare.
    const first = spawnSync('bash', [installScript], { env: colourEnv, encoding: 'utf8' });
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

    const plain = spawnSync('bash', [installScript], { env: colourEnv, encoding: 'utf8' });
    assert.equal(plain.status, 0, `stdout:\n${plain.stdout}\nstderr:\n${plain.stderr}`);
    const coloured = spawnSync('bash', [installScript], {
      env: { ...colourEnv, CLAUDE_BOARD_COLOR: '1' }, encoding: 'utf8',
    });
    assert.equal(coloured.status, 0, `stdout:\n${coloured.stdout}\nstderr:\n${coloured.stderr}`);

    const ansi = /\x1b\[[0-9;]*m/g;
    const strip = s => s.replace(ansi, '');
    // install.sh's one genuinely time-dependent transcript token: the health step's
    // measured wait (install.sh:1528-1529, "${HEALTH_ELAPSED_SECONDS}s"). This check
    // runs three SEPARATE real installs, each polling /api/health afresh, so a run
    // whose wait straddles a second boundary prints a different digit than one that
    // doesn't -- a flake unrelated to anything a line-for-line comparison exists to
    // catch. Scoped to right after "responding" so nothing else on the transcript is
    // ever touched, and the match stops short of the trailing ANSI reset, so the
    // colour wrapped around the token survives normalization intact -- load-bearing
    // for the setup-sanity assertions just below, which still need a real difference
    // to prove colour was carried.
    const normalizeTiming = s => s.replace(/(responding\s+(?:\x1b\[\d+m)?)\d+s/g, '$1Ns');
    // Setup sanity first: if the coloured run carried no escapes at all, the equality
    // checks below would be proving nothing.
    assert.notEqual(normalizeTiming(coloured.stdout), normalizeTiming(plain.stdout), 'setup sanity: the coloured run must actually carry colour on stdout');
    assert.notEqual(normalizeTiming(coloured.stderr), normalizeTiming(plain.stderr), 'setup sanity: and on stderr too');
    assert.equal(normalizeTiming(strip(coloured.stdout)), normalizeTiming(plain.stdout), 'stripping ANSI from the coloured run\'s stdout must reproduce the plain run\'s, line for line');
    assert.equal(normalizeTiming(strip(coloured.stderr)), normalizeTiming(plain.stderr), 'and the same for stderr');
  });

  // --- the shared transcript-styling block (colour, step lines, header/banner/footer) ---
  //
  // install.sh and uninstall.sh each carry a byte-identical copy of this block (neither
  // sources the other, same reason and same convention as is_throwaway_bundle_path
  // above), so drift is the first thing to check for. The rest exercises the block's
  // colour mechanism directly -- a tiny driver script that extracts the block's own text
  // and calls its functions, in the same style as the is_throwaway_bundle_path checks
  // above, rather than a full install.sh run: nothing here needs a launcher, a plist or
  // a health gate, only the print vocabulary itself.

  /** Extracts the fence's contents from install.sh. Asserted non-null everywhere it is
   * used, so a regex miss fails loudly instead of quietly running an empty driver. */
  function extractCbsBlock() {
    const block = readFileSync(installScript, 'utf8').match(
      /# --- BEGIN transcript styling.*?\n([\s\S]*?)\n# --- END transcript styling ---/,
    )?.[1];
    assert.ok(block, 'setup sanity: the transcript-styling block text must be extractable from install.sh');
    return block;
  }

  // One call per documented function, covering every one of the seven palette
  // variables (CBS_STEP, CBS_BOLD, CBS_DIM, CBS_OK, CBS_WARN, CBS_ERR, CBS_RESET) at
  // least once, so a colour check against this probe's output is a claim about the
  // whole block, not one function some of them.
  const CBS_PROBE = [
    'cbs_header "claude-board" "7391"',
    'cbs_step_ok "secret" "already present"',
    'cbs_step_ok "launcher" "built and signed" "~/Applications/claude-board.app"',
    'cbs_step_warn "launcher" "no C compiler, installing without the bundle"',
    'cbs_detail "a reference into ~/Documents will fail with EPERM"',
    'cbs_step_fail "health" "never answered http://127.0.0.1:7391/api/health"',
    'cbs_detail "logs: ~/Library/Logs/claude-board/daemon.err.log"',
    'cbs_success "claude-board installed and running"',
    'cbs_footer_entry "verify" "curl -s http://127.0.0.1:7391/api/health"',
    'cbs_footer_entry "logs" "~/Library/Logs/claude-board/daemon.{out,err}.log"',
  ].join('\n');

  /** Runs CBS_PROBE against the real, extracted block text under `extraEnv`. Never
   * passes CLAUDE_BOARD_VERBOSE or a PATH -- every function CBS_PROBE calls is a bash
   * builtin (printf, case, test), so nothing here needs an external command resolved. */
  function runCbsProbe(extraEnv) {
    const driver = `set -euo pipefail\n${extractCbsBlock()}\n${CBS_PROBE}\n`;
    const r = spawnSync('bash', ['-c', driver], {
      encoding: 'utf8', env: { HOME: '/Users/somebody', ...extraEnv },
    });
    assert.equal(r.status, 0, `the probe script must exit 0\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    return r;
  }

  const CBS_ANSI = /\x1b\[[0-9;]*m/g;

  await check('transcript styling: the shared block is byte-identical in install.sh and uninstall.sh', async () => {
    const fn = src => src.match(
      /# --- BEGIN transcript styling.*?\n([\s\S]*?)\n# --- END transcript styling ---/,
    )?.[1];
    const installBlock = fn(readFileSync(installScript, 'utf8'));
    const uninstallBlock = fn(readFileSync(uninstallScript, 'utf8'));
    // Asserted to have MATCHED before being compared -- see the identical reasoning on
    // is_throwaway_bundle_path above: a regex miss on both sides would otherwise pass
    // an equality check vacuously.
    assert.ok(installBlock, 'install.sh must carry the transcript-styling block where this can read it');
    assert.ok(uninstallBlock, 'uninstall.sh must carry the transcript-styling block where this can read it');
    assert.equal(uninstallBlock, installBlock, 'the transcript-styling block has drifted between the two scripts');
  });

  await check('transcript styling: colour is present when CLAUDE_BOARD_COLOR forces it on over a piped stdout', async () => {
    // spawnSync's stdio is always a pipe, so [ -t 1 ] is false here exactly as it is in
    // every other check in this file -- this is the whole point of the forcing
    // variable: without it, the coloured path would be unreachable from this suite.
    const forced1 = runCbsProbe({ CLAUDE_BOARD_COLOR: '1' });
    assert.match(forced1.stdout, CBS_ANSI, 'CLAUDE_BOARD_COLOR=1 must put ANSI escapes on stdout despite piped stdio');
    assert.match(forced1.stderr, CBS_ANSI, 'and on stderr, where the warned/failed lines land');
    const forcedAlways = runCbsProbe({ CLAUDE_BOARD_COLOR: 'always' });
    assert.match(forcedAlways.stdout, CBS_ANSI, 'CLAUDE_BOARD_COLOR=always must do the same');
  });

  await check('transcript styling: colour is absent on a plain piped run, under NO_COLOR, and under TERM=dumb', async () => {
    const piped = runCbsProbe({});
    assert.doesNotMatch(piped.stdout, CBS_ANSI, 'a plain piped run must carry no ANSI escapes on stdout');
    assert.doesNotMatch(piped.stderr, CBS_ANSI, 'or on stderr');

    // NO_COLOR set to the EMPTY string, deliberately: it is the variable being set that
    // turns colour off, not any particular value it holds.
    const noColor = runCbsProbe({ NO_COLOR: '' });
    assert.doesNotMatch(noColor.stdout, CBS_ANSI, 'NO_COLOR (even empty) must turn colour off');

    const dumb = runCbsProbe({ TERM: 'dumb' });
    assert.doesNotMatch(dumb.stdout, CBS_ANSI, 'TERM=dumb must turn colour off');
  });

  await check('transcript styling: cbs_spinner_stop erases its line with plain spaces, never an ANSI escape', async () => {
    // The spinner itself only ever starts when stdout is a real terminal ([ -t 1 ]),
    // which spawnSync's piped stdio never is -- so cbs_spinner_start can never be
    // proven to actually draw a spinner from this suite. What CAN be proven here,
    // deterministically and without a pty, is the half that used to leak an escape
    // regardless of colour: cbs_spinner_stop's own erase. CBS_SPINNER_PID is forced to
    // a real, already-reaped child's pid, so the `[ -n "$CBS_SPINNER_PID" ]` guard is
    // entered exactly as it would be after a real spinner run -- kill/wait on an
    // already-reaped pid are harmless no-ops (the function's own `|| true` covers
    // both) -- reaching the erase printf without needing a terminal at all.
    const runErase = extraEnv => {
      const driver = `set -euo pipefail\n${extractCbsBlock()}\n`
        + 'sleep 0 &\nCBS_SPINNER_PID=$!\nwait "$CBS_SPINNER_PID" 2>/dev/null || true\n'
        + 'cbs_spinner_stop\nprintf "END"\n';
      const r = spawnSync('bash', ['-c', driver], {
        encoding: 'utf8', env: { HOME: '/Users/somebody', ...extraEnv },
      });
      assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      return r;
    };

    // Every env combination the erase should be indifferent to, TERM=dumb and NO_COLOR
    // included -- the fix moved the erase off ANSI entirely rather than special-casing
    // colour-off, so it must stay escape-free even when colour is forced ON.
    for (const extraEnv of [{}, { NO_COLOR: '1' }, { TERM: 'dumb' }, { CLAUDE_BOARD_COLOR: '1' }]) {
      const r = runErase(extraEnv);
      assert.doesNotMatch(
        r.stdout, /\x1b/,
        `cbs_spinner_stop must never write an ANSI escape byte (env: ${JSON.stringify(extraEnv)})`,
      );
      assert.match(
        r.stdout, /^\r {20}\rEND$/,
        `the erase must be a bare \\r, CBS_SPINNER_LINE_WIDTH plain spaces, then a second bare \\r (env: ${JSON.stringify(extraEnv)})`,
      );
    }
  });

  await check('transcript styling: the spinner is skipped outright under TERM=dumb, which cannot reposition a cursor', async () => {
    // Cannot be shown behaviourally from this suite either: cbs_spinner_start's very
    // first line already refuses under piped stdio ([ -t 1 ]), before TERM is ever
    // consulted, so a real terminal would be needed to watch the TERM=dumb branch fire
    // on its own. Checked structurally instead -- the guard has to exist in the
    // function's own source.
    const fnMatch = extractCbsBlock().match(/cbs_spinner_start\(\) \{([\s\S]*?)\n\}/);
    assert.ok(fnMatch, 'setup sanity: cbs_spinner_start must be extractable');
    assert.match(
      fnMatch[1], /\[\s*"\$\{TERM:-\}"\s*=\s*"dumb"\s*\]/,
      'cbs_spinner_start must refuse to start a spinner outright when TERM is dumb',
    );
  });

  await check('transcript styling: CLAUDE_BOARD_COLOR overrides NO_COLOR and TERM=dumb', async () => {
    // The forcing variable has to win over every OFF condition too, or a test running
    // under a CI environment that already sets NO_COLOR could never reach the coloured
    // path either.
    const r = runCbsProbe({ CLAUDE_BOARD_COLOR: '1', NO_COLOR: '1', TERM: 'dumb' });
    assert.match(r.stdout, CBS_ANSI, 'CLAUDE_BOARD_COLOR must beat NO_COLOR and TERM=dumb, not just an ordinary piped stdout');
  });

  await check('transcript styling: stripping ANSI from a coloured run reproduces the piped run line for line', async () => {
    const coloured = runCbsProbe({ CLAUDE_BOARD_COLOR: '1' });
    const plain = runCbsProbe({});
    const strip = s => s.replace(CBS_ANSI, '');
    // Setup sanity first: if the coloured run were identical to the plain one before
    // stripping, the equality checks below would be proving nothing.
    assert.notEqual(coloured.stdout, plain.stdout, 'setup sanity: the coloured run must actually carry colour');
    assert.equal(strip(coloured.stdout), plain.stdout, 'stdout must match the piped run line for line once colour is stripped');
    assert.equal(strip(coloured.stderr), plain.stderr, 'stderr must match the piped run line for line once colour is stripped');
  });

  await check('transcript styling: step, detail, header, banner and footer lines match the rendered checklist layout', async () => {
    // Pins the layer's own output against the exact bytes of the chosen rendering
    // (install-B-checklist.html), plain-run values only -- colour is proven separately
    // above. A regression here is a column width or a glyph moving under whichever of
    // the two scripts starts calling these functions for real.
    const r = runCbsProbe({});
    const stdoutLines = r.stdout.split('\n');
    assert.equal(stdoutLines[0], '  claude-board                                    port 7391');
    assert.ok(stdoutLines.includes('  ✓  secret     already present'));
    assert.ok(stdoutLines.includes('  ✓  launcher   built and signed        ~/Applications/claude-board.app'));
    assert.ok(stdoutLines.includes('  ●  claude-board installed and running'));
    assert.ok(stdoutLines.includes('     verify  curl -s http://127.0.0.1:7391/api/health'));
    assert.ok(stdoutLines.includes('     logs    ~/Library/Logs/claude-board/daemon.{out,err}.log'));

    const stderrLines = r.stderr.split('\n');
    assert.ok(stderrLines.includes('  !  launcher   no C compiler, installing without the bundle'));
    assert.ok(stderrLines.includes('        a reference into ~/Documents will fail with EPERM'));
    assert.ok(stderrLines.includes('  ✗  health     never answered http://127.0.0.1:7391/api/health'));
    assert.ok(stderrLines.includes('        logs: ~/Library/Logs/claude-board/daemon.err.log'));
  });

  await check('transcript styling: a warned or failed step and its detail lines go to stderr, never stdout', async () => {
    const r = runCbsProbe({});
    assert.doesNotMatch(r.stdout, /no C compiler/, 'a warned step must not appear on stdout');
    assert.doesNotMatch(r.stdout, /never answered/, 'a failed step must not appear on stdout');
    assert.doesNotMatch(r.stdout, /EPERM|daemon\.err\.log/, 'detail lines beneath a warned\/failed step must not appear on stdout either');
    assert.doesNotMatch(r.stderr, /already present|built and signed|installed and running/, 'and the good-path lines must never leak onto stderr');
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
