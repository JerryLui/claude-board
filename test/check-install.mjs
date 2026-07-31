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
// Never touches the real ~/Library/LaunchAgents, ~/Library/Logs, ~/.claude/commands,
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
const commandsDir = path.join(workDir, 'Commands');
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

const env = {
  ...process.env,
  CLAUDE_BOARD_SECRET_FILE: secretFile,
  CLAUDE_BOARD_LAUNCH_AGENTS_DIR: launchAgentsDir,
  CLAUDE_BOARD_LOG_DIR: logDir,
  CLAUDE_BOARD_COMMANDS_DIR: commandsDir,
  CLAUDE_BOARD_HOME: storeDir,
  CLAUDE_BOARD_MCP_CMD: claudeStub,
  CLAUDE_BOARD_LAUNCHCTL_CMD: launchctlStub,
  CLAUDE_BOARD_PORT: String(healthPort),
  STUB_CLAUDE_LOG: claudeLog,
  STUB_CLAUDE_STATE: claudeState,
  STUB_LAUNCHCTL_LOG: launchctlLog,
  STUB_LAUNCHCTL_STATE: launchctlState,
};

const commandFile = path.join(commandsDir, 'grill.md');

function runInstall() {
  return spawnSync('bash', [installScript], { env, encoding: 'utf8' });
}

// --- reload on change (SPEC_LAUNCH.md criterion 17) -------------------------------
//
// The structural plist check above only proves install.sh ASKS for reload-on-change.
// This is the check that proves the mechanism it asks for exists at all: a real
// bin/daemon.mjs, spawned with CLAUDE_BOARD_RELOAD_ON_CHANGE=1, watching a real src/
// directory and exiting when a file under it changes -- and, with the env var unset
// (the default, and the state every OTHER caller of this file runs under, including
// the rest of this suite), NOT doing that on the identical edit. That negative is as
// load-bearing as the positive: a daemon that self-exits on any file event under an
// unrelated harness is a new flake source, which is exactly why the mechanism is
// opt-in rather than always-on.
//
// Runs against a TEMP COPY of src/ and bin/, never this repo's own tree -- touching a
// tracked file to prove a watcher fires would be a side effect on the actual worktree,
// and "revert it afterwards" is one uncaught exception away from leaving a dirty tree
// behind. bin/daemon.mjs only imports from '../src/*.mjs' and nothing outside that
// pair (checked: no src/*.mjs file reads anything by a path outside src/ except
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
async function spawnReloadDaemon(reloadOnChange) {
  // Everything from here down is wrapped so ANY failure -- a full disk on cpSync, a
  // port race in freePort(), spawn() itself throwing -- still removes rWorkDir and
  // kills whatever child made it as far as spawning, rather than leaking either. The
  // alternative (only cleaning up the "never got healthy" case) misses exactly the
  // failures that are least expected, which is the shape of leak that turns into a
  // pile of /tmp/claude-board-reload-* directories nobody notices until disk pressure.
  const rWorkDir = mkdtempSync(path.join(tmpdir(), 'claude-board-reload-'));
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
    delete rEnv.CLAUDE_BOARD_RELOAD_ON_CHANGE; // never inherit this check process's own env
    if (reloadOnChange) rEnv.CLAUDE_BOARD_RELOAD_ON_CHANGE = '1';

    child = spawn(process.execPath, [daemonCopy], { env: rEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', c => { out += c.toString(); });
    child.stderr.on('data', c => { err += c.toString(); });

    const healthy = await waitForHealthy(port, 8000);
    if (!healthy) {
      throw new Error(`reload-check daemon never answered /api/health\nstdout:\n${out}\nstderr:\n${err}`);
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

  await check('ProgramArguments points node at this clone\'s bin/daemon.mjs, by absolute path', async () => {
    assert.equal(plist.ProgramArguments.length, 2);
    assert.ok(path.isAbsolute(plist.ProgramArguments[0]), 'node interpreter path must be absolute');
    assert.equal(plist.ProgramArguments[1], path.join(repoRoot, 'bin', 'daemon.mjs'));
  });

  await check('RunAtLoad and KeepAlive are set', async () => {
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.KeepAlive, true);
  });

  await check('the plist sets the reload env var and does not carry WatchPaths (SPEC_LAUNCH.md criterion 17)', async () => {
    // Secondary, structural guard only. The real assertion — that the mechanism this
    // env var turns on actually works — lives in the "reload on change" section below,
    // which spawns a real daemon and watches it exit.
    //
    // (Ablation: reintroducing a `WatchPaths` array here beside `KeepAlive: true` is
    // exactly the dead-mechanism claim criterion 17 forbids — see QUIRKS.md
    // "WatchPaths does not restart the daemon" — so this fails on purpose if it comes
    // back.)
    assert.ok(!('WatchPaths' in plist), 'WatchPaths is inert beside KeepAlive and must not be in the generated plist');
    assert.ok(plist.EnvironmentVariables, 'the plist must carry an EnvironmentVariables dict');
    assert.equal(plist.EnvironmentVariables.CLAUDE_BOARD_RELOAD_ON_CHANGE, '1', 'install.sh must opt the installed daemon into reload-on-change');
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

  // --- the /grill command file (SPEC_LAUNCH.md criterion 9) --------------------
  //
  // The two install() runs above already installed it into `commandsDir` -- confirmed
  // first here. Then the trickier half, which needs the shipped copy itself to change
  // between runs: a THROWAWAY clone (its own bin/daemon.mjs + bin/mcp.mjs, never
  // executed -- launchctl is stubbed and the claude stub only logs its args -- and its
  // own commands/grill.md) so a "new version shipped" can be simulated without ever
  // touching this repo's own tracked commands/grill.md.

  await check('the command file is installed after both runs, matching the shipped copy', async () => {
    assert.ok(existsSync(commandFile), 'install.sh must install commands/grill.md to CLAUDE_BOARD_COMMANDS_DIR');
    const shipped = readFileSync(path.join(repoRoot, 'commands', 'grill.md'), 'utf8');
    assert.equal(readFileSync(commandFile, 'utf8'), shipped, 'the installed file must match the repo copy install.sh shipped');
  });

  const grillCloneDir = path.join(workDir, 'grill-clone');
  mkdirSync(path.join(grillCloneDir, 'bin'), { recursive: true });
  mkdirSync(path.join(grillCloneDir, 'commands'), { recursive: true });
  writeFileSync(path.join(grillCloneDir, 'bin', 'daemon.mjs'), '// stub\n');
  writeFileSync(path.join(grillCloneDir, 'bin', 'mcp.mjs'), '// stub\n');
  writeFileSync(path.join(grillCloneDir, 'install.sh'), readFileSync(installScript, 'utf8'));
  const grillSrc = path.join(grillCloneDir, 'commands', 'grill.md');
  const GRILL_V1 = '# grill v1\nshipped content, version 1\n';
  const GRILL_V2 = '# grill v2\nshipped content, version 2 -- a fix landed\n';
  writeFileSync(grillSrc, GRILL_V1);

  const grillAgents = path.join(workDir, 'LaunchAgents-grillclone');
  const grillLogs = path.join(workDir, 'Logs-grillclone');
  const grillCommands = path.join(workDir, 'Commands-grillclone');
  const grillInstalledFile = path.join(grillCommands, 'grill.md');
  // Isolated from the shared secretFile too: the hash record lives beside the secret
  // (CLAUDE_BOARD_SECRET_FILE), and this clone's grill.md content is deliberately
  // different from the real repo's, so its hash record must never share a file with
  // (and overwrite the record for) the shared commandFile the checks above installed.
  const grillSecretFile = path.join(workDir, 'config-grillclone', 'claude-board', 'secret');

  function runGrillCloneInstall() {
    return spawnSync('bash', [path.join(grillCloneDir, 'install.sh')], {
      env: {
        ...env,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: grillAgents,
        CLAUDE_BOARD_LOG_DIR: grillLogs,
        CLAUDE_BOARD_COMMANDS_DIR: grillCommands,
        CLAUDE_BOARD_SECRET_FILE: grillSecretFile,
      },
      encoding: 'utf8',
    });
  }

  const firstGrillRun = runGrillCloneInstall();
  await check('a fresh install writes the shipped command file and says so', async () => {
    assert.equal(firstGrillRun.status, 0, `stdout:\n${firstGrillRun.stdout}\nstderr:\n${firstGrillRun.stderr}`);
    assert.equal(readFileSync(grillInstalledFile, 'utf8'), GRILL_V1);
    assert.match(firstGrillRun.stdout, /installed/i);
  });

  // The shipped copy changes (this throwaway clone's own file -- never the real
  // repo's) and install runs again: the previously-installed copy was never touched
  // by a user, so it must be replaced. This is how a user gets fixes.
  writeFileSync(grillSrc, GRILL_V2);
  const secondGrillRun = runGrillCloneInstall();
  await check('an unmodified installed copy IS updated when the shipped copy changes', async () => {
    assert.equal(secondGrillRun.status, 0, `stdout:\n${secondGrillRun.stdout}\nstderr:\n${secondGrillRun.stderr}`);
    // (Ablation: an install.sh that only ever writes when the target is MISSING --
    // i.e. drops the "matches shipped OR matches the recorded hash" reconciliation --
    // leaves v1 here forever, which fails this exact assertion.)
    assert.equal(readFileSync(grillInstalledFile, 'utf8'), GRILL_V2, 'the unmodified copy must pick up the new shipped version');
  });

  // Now the user edits their installed copy by hand. A THIRD reinstall (shipped copy
  // unchanged from v2) must leave it exactly alone, exit 0, and say what it skipped.
  const userEdit = GRILL_V2 + '\n<!-- I added my own note here -->\n';
  writeFileSync(grillInstalledFile, userEdit);
  const thirdGrillRun = runGrillCloneInstall();
  await check('a user-modified command file is NOT clobbered, and install still exits 0 and says what it skipped', async () => {
    assert.equal(thirdGrillRun.status, 0, `install must not die on a modified command file\nstdout:\n${thirdGrillRun.stdout}\nstderr:\n${thirdGrillRun.stderr}`);
    // (Ablation: one of the brief's two headline assertions -- dropping the
    // hash-comparison guard in install.sh's command-file step and always
    // overwriting makes this fail: the file below reverts to the shipped v2 text.)
    assert.equal(readFileSync(grillInstalledFile, 'utf8'), userEdit, 'a user edit must survive a reinstall untouched');
    assert.match(thirdGrillRun.stdout, /(local edits|leaving it)/i, 'install must say it skipped the file, not stay silent');
  });

  // --- the interpreter baked into the plist ------------------------------------
  //
  // Raised by ticket 08 and settled here: `command -v node` on a machine using a
  // version manager resolves to a versioned directory (~/.nvm/versions/node/vX/bin),
  // and the next upgrade deletes it. launchd then points at a path that no longer
  // exists, which surfaces as "daemon is not reachable" in every session, with
  // nothing naming the cause. install.sh prefers a stable interpreter and says so.

  await check('a version-managed node on PATH is not baked into the plist when a stable one exists', async () => {
    const fakeNvm = path.join(workDir, 'home', '.nvm', 'versions', 'node', 'v0.0.0', 'bin');
    mkdirSync(fakeNvm, { recursive: true });
    const shim = path.join(fakeNvm, 'node');
    // A real interpreter under a version-managed path: install.sh executes NODE_BIN
    // (it mints the secret with it), so this has to actually run node.
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(shim, 0o755);

    const agents = path.join(workDir, 'LaunchAgents-nvm');
    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        PATH: `${fakeNvm}:${process.env.PATH}`,
        CLAUDE_BOARD_NODE: '',
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
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

    const asJson = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(agents, 'claude-board.plist')], { encoding: 'utf8' });
    assert.equal(asJson.status, 0, asJson.stderr);
    const baked = JSON.parse(asJson.stdout).ProgramArguments[0];

    const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find(p => existsSync(p));
    if (stable) {
      assert.equal(baked, stable, 'a stable interpreter must win over the version-managed one');
      assert.match(r.stdout, /version-managed/, 'the substitution must be announced, not silent');
    } else {
      // No stable interpreter anywhere: baking the version-managed path is the only
      // option left, but it must come with the warning that says why it may break.
      assert.equal(baked, shim);
      assert.match(r.stdout, /warning: only a version-managed node/);
    }
  });

  await check('CLAUDE_BOARD_NODE overrides the interpreter, in the plist and the registration alike', async () => {
    const agents = path.join(workDir, 'LaunchAgents-override');
    const chosen = path.join(workDir, 'home', 'chosen-node');
    writeFileSync(chosen, `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
    chmodSync(chosen, 0o755);
    const registrations = path.join(workDir, 'claude-registrations-override.json');

    const r = spawnSync('bash', [installScript], {
      env: {
        ...env,
        CLAUDE_BOARD_NODE: chosen,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: agents,
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
    assert.equal(JSON.parse(asJson.stdout).ProgramArguments[0], chosen);
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
    mkdirSync(path.join(oddDir, 'commands'), { recursive: true });
    writeFileSync(path.join(oddDir, 'bin', 'daemon.mjs'), '// stub\n');
    writeFileSync(path.join(oddDir, 'bin', 'mcp.mjs'), '// stub\n');
    writeFileSync(path.join(oddDir, 'commands', 'grill.md'), '# stub grill\n');
    writeFileSync(path.join(oddDir, 'install.sh'), readFileSync(installScript, 'utf8'));

    const oddAgents = path.join(workDir, 'LaunchAgents-odd');
    const oddLogs = path.join(workDir, 'Logs-odd');
    // Isolated CLAUDE_BOARD_COMMANDS_DIR and CLAUDE_BOARD_SECRET_FILE (the hash record
    // lives beside the secret), same as the LaunchAgents/Logs isolation above -- this
    // clone's own commands/grill.md is unrelated stub content, and must never be
    // reconciled against (or overwrite) the real repo copy the checks above this one
    // already installed into the shared commandsDir.
    const r = spawnSync('bash', [path.join(oddDir, 'install.sh')], {
      env: {
        ...env,
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: oddAgents,
        CLAUDE_BOARD_LOG_DIR: oddLogs,
        CLAUDE_BOARD_COMMANDS_DIR: path.join(workDir, 'Commands-odd'),
        CLAUDE_BOARD_SECRET_FILE: path.join(workDir, 'config-odd', 'claude-board', 'secret'),
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
    assert.equal(oddPlistJson.ProgramArguments[1], path.join(oddDir, 'bin', 'daemon.mjs'));
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

  // --- reload on change: the behaviour, not the plist key ----------------------

  await check('CLAUDE_BOARD_RELOAD_ON_CHANGE=1: editing a file under src/ makes the daemon exit', async () => {
    const d = await spawnReloadDaemon(true);
    try {
      // A harmless content edit to the TEMP COPY made by spawnReloadDaemon -- never
      // the real src/store.mjs -- shaped like an editor's atomic save landing a line.
      writeFileSync(d.srcFile, '\n// touched by check-install.mjs reload check\n', { flag: 'a' });
      const exited = await waitForExit(d.child, 5000);
      // (Ablation: this is the assertion the brief asks to prove genuinely fails --
      // revert bin/daemon.mjs's watchForReload/the CLAUDE_BOARD_RELOAD_ON_CHANGE branch
      // and this check times out and fails, because nothing is watching src/ anymore.)
      assert.ok(exited, `daemon must exit within 5s of a src/ change under CLAUDE_BOARD_RELOAD_ON_CHANGE=1\nstderr:\n${d.stderr()}`);
      assert.match(d.stderr(), /exiting to reload/, 'the daemon must log why it is exiting');
      assert.match(d.stderr(), /store\.mjs/, 'the log line must name the file that triggered the exit');
    } finally {
      d.cleanup();
    }
  });

  await check('CLAUDE_BOARD_RELOAD_ON_CHANGE unset: the identical edit does NOT make the daemon exit', async () => {
    const d = await spawnReloadDaemon(false);
    try {
      writeFileSync(d.srcFile, '\n// touched by check-install.mjs reload check\n', { flag: 'a' });
      const exited = await waitForExit(d.child, 2500);
      // (Ablation: making the watcher unconditional -- dropping the env-var gate in
      // bin/daemon.mjs -- flips this to true, which is exactly the new flake source the
      // brief calls out: every OTHER caller of bin/daemon.mjs, including the rest of
      // this suite and check-mcp.mjs, spawns it without this var set.)
      assert.ok(!exited, 'the daemon must not self-exit on a src/ change when the reload env var is unset');
    } finally {
      d.cleanup();
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

  const uninstallResult = spawnSync('bash', [uninstallScript], { env, encoding: 'utf8' });

  await check('uninstall exits 0', async () => {
    assert.equal(uninstallResult.status, 0, `stdout:\n${uninstallResult.stdout}\nstderr:\n${uninstallResult.stderr}`);
  });

  await check('uninstall removes the plist', async () => {
    assert.ok(!existsSync(plistPath), 'the plist must be gone after uninstall');
  });

  await check('uninstall removes the MCP registration', async () => {
    const state = existsSync(claudeState) ? JSON.parse(readFileSync(claudeState, 'utf8')) : {};
    assert.ok(!('claude-board' in state), 'the MCP registration must be removed');
  });

  await check('uninstall removes the (unmodified) installed command file', async () => {
    assert.ok(!existsSync(commandFile), 'an unmodified command file must be removed by uninstall');
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

  await check('uninstall names what it deliberately left behind: the store, the secret and the logs, by path', async () => {
    assert.ok(uninstallResult.stdout.includes(storeDir), 'must name the store path');
    assert.ok(uninstallResult.stdout.includes(secretFile), 'must name the secret path');
    assert.ok(uninstallResult.stdout.includes(logDir), 'must name the logs path');
  });

  await check('uninstall is safe to run twice', async () => {
    const second = spawnSync('bash', [uninstallScript], { env, encoding: 'utf8' });
    assert.equal(second.status, 0, `a second uninstall must not fail\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
  });

  await check('uninstall is safe to run on a machine with nothing installed', async () => {
    const freshWorkDir = mkdtempSync(path.join(tmpdir(), 'claude-board-uninstall-fresh-'));
    try {
      const freshEnv = {
        ...process.env,
        CLAUDE_BOARD_SECRET_FILE: path.join(freshWorkDir, 'config', 'claude-board', 'secret'),
        CLAUDE_BOARD_LAUNCH_AGENTS_DIR: path.join(freshWorkDir, 'LaunchAgents'),
        CLAUDE_BOARD_LOG_DIR: path.join(freshWorkDir, 'Logs'),
        CLAUDE_BOARD_COMMANDS_DIR: path.join(freshWorkDir, 'Commands'),
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
