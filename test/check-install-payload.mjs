// The daemon's own code — bin/daemon.mjs and everything under src/ — used to live only
// in the clone: outside the signed bundle and outside the rebuild stamp, so anything that
// could write the clone owned the TCC grant with no recompile and no re-sign (SECURITY.md
// "Known limits of that"). install.sh now stages a copy of both into
// claude-board.app/Contents/Resources before codesign runs, and folds a deterministic
// digest of that copy into the rebuild stamp. This file proves the three acceptance
// criteria the task brief states verbatim, behaviourally rather than only structurally:
//
//   - editing the daemon's source in the clone and restarting the service does not
//     change what runs under the granted identity (proven by actually running the
//     compiled launcher and reading what it serves, before and after a reinstall);
//   - a reinstall that changed nothing is not rebuilt, so an already-granted user is not
//     re-prompted (test/check-install.mjs already covers the general case; this file adds
//     the payload-specific direction: editing the clone DOES force a rebuild);
//   - the payload digest itself is deterministic — independent of mtime and of the order
//     the filesystem happens to hand files back in.
//
// Everything here runs against a THROWAWAY CLONE built fresh under one mkdtempSync
// workDir, with $HOME itself pointed at a fake directory for the duration of every
// install.sh run and every launcher invocation — never this repo's own tree, and never
// the real ~/Applications, ~/Library/LaunchAgents or ~/.config/claude-board. See
// test/check-install.mjs's REAL_PATHS guard and its own header comment for why that
// discipline matters; this file follows the same rule without duplicating the guard,
// since it never touches a real path in the first place (HOME itself is fake, and every
// default install.sh would otherwise resolve — LaunchAgents, Applications, skills, the
// secret, the store — derives from HOME).
//
// Skips gracefully if no C compiler is available, the same non-fatal degradation
// test/check-launcher-env.mjs and install.sh itself use.

import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync,
  cpSync, readdirSync, utimesSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installScript = path.join(repoRoot, 'install.sh');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

if (spawnSync(ccCmd, ['--version']).error) {
  console.log(`==> skipping check-install-payload.mjs: no C compiler ('${ccCmd}') found`);
  console.log('all install-payload checks ok (skipped)');
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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-install-payload-'));
// Every install.sh run and every launcher invocation below sees THIS as $HOME, so every
// default install.sh would otherwise resolve against the real one — LaunchAgents,
// Applications, ~/.claude/skills, ~/.config/claude-board/secret, the store — lands here
// instead. Overriding HOME alone (rather than each individual CLAUDE_BOARD_* directory
// seam) is deliberate: the launcher's own baked-in HOME override (bin/launcher.c,
// OVERRIDE_ENV) is fixed at BUILD time from install.sh's own $HOME, and never takes
// CLAUDE_BOARD_SECRET_FILE or CLAUDE_BOARD_HOME from a later env at all — so the only way
// to get a running launcher whose secret and store resolve somewhere this suite can reach
// (rather than colliding with, or reading, whatever the real machine has) is to control
// $HOME itself when install.sh runs.
const fakeHome = path.join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

const binDir = path.join(workDir, 'stub-bin');
mkdirSync(binDir, { recursive: true });

const STUB_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_CLAUDE_LOG, JSON.stringify(args) + '\\n');
process.exit(0);
`;
const STUB_LAUNCHCTL = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_LAUNCHCTL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;
const claudeStub = path.join(binDir, 'claude-stub.mjs');
const launchctlStub = path.join(binDir, 'launchctl-stub.mjs');
writeFileSync(claudeStub, STUB_CLAUDE);
writeFileSync(launchctlStub, STUB_LAUNCHCTL);
chmodSync(claudeStub, 0o755);
chmodSync(launchctlStub, 0o755);

// install.sh refuses to report success until the daemon answers /api/health, and
// launchctl is stubbed (starts nothing) -- so this stands in for it, exactly like
// test/check-install.mjs's own healthStub.
const healthStub = path.join(binDir, 'health-stub.mjs');
writeFileSync(healthStub, `import http from 'node:http';
http.createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
  res.writeHead(404); res.end();
}).listen(Number(process.argv[2]), '127.0.0.1');
`);

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

const installHealthPort = await freePort();
const healthProc = spawn(process.execPath, [healthStub, String(installHealthPort)], { stdio: 'ignore' });
if (!await waitForHealthy(installHealthPort, 5000)) {
  throw new Error('install-time health stub never came up');
}

// --- a throwaway clone, never this repo's own tree -----------------------------------
const cloneDir = path.join(workDir, 'clone');
cpSync(path.join(repoRoot, 'bin'), path.join(cloneDir, 'bin'), { recursive: true });
cpSync(path.join(repoRoot, 'src'), path.join(cloneDir, 'src'), { recursive: true });
writeFileSync(path.join(cloneDir, 'install.sh'), readFileSync(installScript));
chmodSync(path.join(cloneDir, 'install.sh'), 0o755);

const claudeLog = path.join(workDir, 'claude-invocations.log');
const launchctlLog = path.join(workDir, 'launchctl-invocations.log');

const installEnv = {
  ...process.env,
  HOME: fakeHome,
  CLAUDE_BOARD_MCP_CMD: claudeStub,
  CLAUDE_BOARD_LAUNCHCTL_CMD: launchctlStub,
  CLAUDE_BOARD_PORT: String(installHealthPort),
  STUB_CLAUDE_LOG: claudeLog,
  STUB_LAUNCHCTL_LOG: launchctlLog,
};
delete installEnv.CLAUDE_BOARD_REF_ROOTS;
delete installEnv.CLAUDE_BOARD_HOME;

function runInstall() {
  return spawnSync('bash', [path.join(cloneDir, 'install.sh')], { env: installEnv, encoding: 'utf8' });
}

const appPath = path.join(fakeHome, 'Applications', 'claude-board.app');
const execPath = path.join(appPath, 'Contents', 'MacOS', 'claude-board');
const resourcesBin = path.join(appPath, 'Contents', 'Resources', 'bin', 'daemon.mjs');
const resourcesSrc = path.join(appPath, 'Contents', 'Resources', 'src');

/** Run the ALREADY-BUILT launcher directly (never bin/daemon.mjs) on a free port,
 * wait for /api/health, and return a handle to talk to it. HOME is not passed here on
 * purpose -- the launcher's own HOME override is fixed at BUILD time (baked into the
 * binary from install.sh's own $HOME), so nothing this function passes can move it, and
 * that fixed HOME is what makes the secret install.sh generated the store it resolved
 * findable by this same running process. */
async function runBundledLauncher() {
  const port = await freePort();
  const child = spawn(execPath, [], {
    env: {
      PATH: process.env.PATH,
      CLAUDE_BOARD_PORT: String(port),
      // ADR.md entry 76 (SPEC_SIGNALS.md ticket 02): the no-argument supervising path
      // this helper exercises now refuses to fork without this marker, which install.sh
      // writes into the real plist's EnvironmentVariables dict. This direct hand-launch
      // stands in for launchd on purpose -- this suite is about the payload the launcher
      // serves, not about the refusal itself (test/check-launcher-refuses.mjs).
      CLAUDE_BOARD_LAUNCHD_MARKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', c => { out += c.toString(); });
  child.stderr.on('data', c => { err += c.toString(); });
  const healthy = await waitForHealthy(port, 8000);
  if (!healthy) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    throw new Error(`bundled launcher never answered /api/health\nstdout:\n${out}\nstderr:\n${err}`);
  }
  return {
    port,
    pid: child.pid,
    cleanup() {
      // Graceful first: the launcher forwards SIGTERM to BOTH children it forked
      // (bin/launcher.c -- node, and the `--menubar` item since ADR.md entry 72), and
      // they exit within bin/daemon.mjs's default 2s shutdown grace. A backstop SIGKILL
      // after that catches anything that doesn't -- fired without waiting for it, since
      // every port this suite uses afterward is a fresh ephemeral one rather than a
      // reused fixed port.
      //
      // The stray sweep is why this is not just two kills. Both children inherit the
      // `pipe` stdio opened for the launcher above, so one that outlives its parent holds
      // this check's stdout open and the process never exits -- and there are two of them
      // to outlive it now, where the shape below was written when there was one. Enumerate
      // the launcher's children BEFORE killing it, since a reaped parent leaves nothing to
      // enumerate from, then kill the strays and destroy the streams.
      let strays = [];
      try {
        strays = spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
          .stdout.split('\n').map(s => Number(s.trim())).filter(Boolean);
      } catch { /* pgrep absent or no children: the kills below are still correct */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const backstop = setTimeout(() => {
        for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* already closed */ }
      }, 3000);
      backstop.unref();
    },
  };
}

async function main() {
  const first = runInstall();
  await check('a throwaway clone installs: "built and signed" on the first run', async () => {
    assert.equal(first.status, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    assert.match(first.stdout, /built and signed/, first.stdout);
    assert.ok(existsSync(execPath), 'the launcher executable must exist');
  });

  await check('the bundle carries a byte-identical copy of the clone\'s bin/daemon.mjs and src/', async () => {
    assert.ok(
      readFileSync(resourcesBin).equals(readFileSync(path.join(cloneDir, 'bin', 'daemon.mjs'))),
      'bin/daemon.mjs must be byte-identical inside the bundle',
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
    const cloneSrc = path.join(cloneDir, 'src');
    const cloneFiles = listFiles(cloneSrc).map(f => path.relative(cloneSrc, f)).sort();
    const bundledFiles = listFiles(resourcesSrc).map(f => path.relative(resourcesSrc, f)).sort();
    assert.deepEqual(bundledFiles, cloneFiles, 'the bundle must carry exactly the clone\'s src/ file set');
    for (const rel of cloneFiles) {
      assert.ok(readFileSync(path.join(resourcesSrc, rel)).equals(readFileSync(path.join(cloneSrc, rel))), `src/${rel} must be byte-identical`);
    }
  });

  await check('the compiled-in daemon path is INSIDE the bundle, not the clone -- and CLAUDE_BOARD_REPO_ROOT names the clone', async () => {
    const launcher = readFileSync(execPath);
    assert.ok(
      launcher.includes(Buffer.from(`${resourcesBin}\0`, 'utf8')),
      'CLAUDE_BOARD_DAEMON must be the path inside Contents/Resources',
    );
    assert.ok(
      !launcher.includes(Buffer.from(`${path.join(cloneDir, 'bin', 'daemon.mjs')}\0`, 'utf8')),
      'the clone\'s own bin/daemon.mjs path must not be what is compiled in as CLAUDE_BOARD_DAEMON',
    );
    assert.ok(
      launcher.includes(Buffer.from(`${cloneDir}\0`, 'utf8')),
      'CLAUDE_BOARD_REPO_ROOT must carry the clone path -- src/handoff.mjs recoveryCommand() needs it to name bin/authorize.mjs correctly (see below)',
    );
  });

  await check('SPEC_MENUBAR criterion 10: the INSTALLED bundle, run the way launchd runs it, forks the status item beside the daemon', async () => {
    // The closest this suite gets to a login: a real bundle, built and signed by
    // install.sh, exec'd with no arguments at all -- which is exactly the invocation the
    // plist makes, and the plist already carries RunAtLoad. What a login would add is the
    // launchd session, and nothing in bin/launcher.c's fork path reads it.
    // test/check-launcher-menubar.mjs owns the supervision behaviour; this one owns the
    // claim that a real INSTALL produces it, which no compile-it-yourself check can make.
    const d = await runBundledLauncher();
    try {
      const listed = spawnSync('pgrep', ['-P', String(d.pid)], { encoding: 'utf8' });
      const kids = (listed.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
        .map(pid => (spawnSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).stdout || '').trim());
      // `ps -o args=` reports what a process was EXEC'd with, so this also says the item
      // is the bundle's own executable re-run -- not a fork that stayed in the launcher's
      // image, which is what CoreFoundation and the ObjC runtime refuse to be used from.
      assert.ok(kids.includes(`${execPath} --menubar`), `no --menubar child of the installed bundle; children were: ${JSON.stringify(kids)}`);
      assert.equal(kids.length, 2, `the bundle must run exactly the daemon and the item: ${JSON.stringify(kids)}`);
    } finally {
      d.cleanup();
    }
  });

  // --- an edit to the clone does not change what runs ----------------------------------

  const cloneServerPath = path.join(cloneDir, 'src', 'server.mjs');
  const originalServerText = readFileSync(cloneServerPath, 'utf8');
  const NEEDLE = 'return sendJson(res, 200, { ok: true, version: PKG_VERSION });';
  const REPLACEMENT = "return sendJson(res, 200, { ok: true, version: PKG_VERSION, marker: 'edited-clone-marker' });";
  await check('sanity: the health-response marker edit actually matches the real source text', async () => {
    assert.ok(originalServerText.includes(NEEDLE), 'src/server.mjs must still contain the exact health-response line this check edits');
  });
  writeFileSync(cloneServerPath, originalServerText.replace(NEEDLE, REPLACEMENT));

  await check('editing the clone\'s source does not change what the already-built bundle serves', async () => {
    // The launcher on disk right now was built from the PRE-EDIT clone. Running it
    // proves the acceptance criterion directly: a real compiled launcher, actually
    // exec'd, actually answering HTTP with the old code -- not an inference from file
    // timestamps.
    const d = await runBundledLauncher();
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
      const body = await res.json();
      assert.ok(!('marker' in body), `the running daemon must still be serving the pre-edit code, got: ${JSON.stringify(body)}`);
    } finally {
      d.cleanup();
    }
  });

  // --- the other direction: the edit DOES force a rebuild ------------------------------

  const second = runInstall();
  await check('...but the SAME edit makes the next install rebuild rather than report "already current"', async () => {
    assert.equal(second.status, 0, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`);
    assert.match(second.stdout, /built and signed/, 'an edited payload must be rebuilt');
    assert.doesNotMatch(second.stdout, /already current/, 'and must not be reported as unchanged');
  });

  await check('...and the rebuilt bundle serves the edited code', async () => {
    const d = await runBundledLauncher();
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
      const body = await res.json();
      assert.equal(body.marker, 'edited-clone-marker', `the rebuilt daemon must serve the new code, got: ${JSON.stringify(body)}`);
    } finally {
      d.cleanup();
    }
  });

  // --- the fix this task's own regression risk was: recoveryCommand() must still name
  // the CLONE's bin/authorize.mjs, not a path inside the bundle it cannot reach ---------

  await check('the "not authorized" refusal page names the clone\'s bin/authorize.mjs, not a path inside the bundle', async () => {
    const d = await runBundledLauncher();
    try {
      const res = await fetch(`http://127.0.0.1:${d.port}/`, { headers: { accept: 'text/html' } }); // no secret: deliberately unauthorized
      assert.equal(res.status, 401);
      const html = await res.text();
      const expectedCommand = `node ${path.join(cloneDir, 'bin', 'authorize.mjs')}`;
      assert.ok(html.includes(expectedCommand), `the refusal page must print the clone's recovery command; got:\n${html}`);
      assert.ok(!html.includes('Contents/Resources'), 'the refusal page must not print a path inside the bundle');
    } finally {
      d.cleanup();
    }
  });

  await check('the launcher stamp covers bin/menubar.m: editing it, and nothing else, forces a rebuild', async () => {
    // A source left out of install.sh's LAUNCHER_STAMP is a source whose edits never
    // rebuild the bundle -- silently, on every later `git pull && ./install.sh` -- and the
    // reader's only symptom is a status item that stays whatever it was. The stamp exists
    // because the OPPOSITE mistake is expensive too: a needless rebuild re-signs the
    // bundle and silently revokes the Documents grant pinned to the old signature. So both
    // directions are asserted here, in order: unchanged is "already current", and the one
    // edit is a rebuild.
    const noop = runInstall();
    assert.equal(noop.status, 0, `stdout:\n${noop.stdout}\nstderr:\n${noop.stderr}`);
    assert.match(noop.stdout, /already current/, 'nothing changed since the last run, so nothing may be rebuilt');

    const menubarInClone = path.join(cloneDir, 'bin', 'menubar.m');
    // A comment, so the edited source still compiles: what is under test is whether the
    // stamp NOTICES the file, not what happens when it will not build (that is
    // test/check-install.mjs's degraded-compile check).
    writeFileSync(menubarInClone, `${readFileSync(menubarInClone, 'utf8')}\n/* an edit the stamp has to notice */\n`);

    const after = runInstall();
    assert.equal(after.status, 0, `stdout:\n${after.stdout}\nstderr:\n${after.stderr}`);
    assert.match(after.stdout, /built and signed/, 'an edited bin/menubar.m must force a rebuild');
    assert.doesNotMatch(after.stdout, /already current/, 'and must not be reported as unchanged');
  });

  // --- the payload digest itself: deterministic, independent of mtime and walk order ---

  await check('payload_digest (install.sh) is deterministic across mtime and directory-walk order', async () => {
    const src = readFileSync(installScript, 'utf8');
    const fn = src.match(/^payload_digest\(\) \{\n[\s\S]*?^\}$/m);
    assert.ok(fn, 'install.sh must still define payload_digest as a top-level function');

    const probeDir = path.join(workDir, 'digest-probe');
    mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, 'probe.sh');
    writeFileSync(probe, [
      'set -euo pipefail',
      `NODE_BIN="${process.execPath}"`,
      fn[0],
      'payload_digest "$1"',
      '',
    ].join('\n'));

    function buildTree(root, order, mtimeBase) {
      mkdirSync(path.join(root, 'bin'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
      const files = {
        [path.join(root, 'bin', 'daemon.mjs')]: '// daemon\n',
        [path.join(root, 'src', 'a.mjs')]: '// a\n',
        [path.join(root, 'src', 'nested', 'b.mjs')]: '// b\n',
      };
      // Written in the caller-supplied order (reversed between the two trees below), and
      // each given a DIFFERENT mtime -- both are exactly what payload_digest must not
      // depend on for two trees carrying identical content to produce the same digest.
      order.forEach((f, i) => {
        writeFileSync(f, files[f]);
        const t = new Date(mtimeBase + i * 60_000);
        utimesSync(f, t, t);
      });
    }

    const treeA = path.join(workDir, 'digest-tree-a');
    const treeB = path.join(workDir, 'digest-tree-b');
    const treeC = path.join(workDir, 'digest-tree-c'); // one byte different, for a sanity check
    const filesInCreationOrder = root => [
      path.join(root, 'bin', 'daemon.mjs'),
      path.join(root, 'src', 'a.mjs'),
      path.join(root, 'src', 'nested', 'b.mjs'),
    ];
    buildTree(treeA, filesInCreationOrder(treeA), Date.now() - 100_000_000);
    buildTree(treeB, [...filesInCreationOrder(treeB)].reverse(), Date.now() - 5_000_000); // different order, different mtimes
    buildTree(treeC, filesInCreationOrder(treeC), Date.now() - 100_000_000);
    writeFileSync(path.join(treeC, 'src', 'a.mjs'), '// a (different)\n'); // one real content change

    const digestOf = root => {
      const r = spawnSync('bash', [probe, root], { encoding: 'utf8' });
      assert.equal(r.status, 0, `payload_digest must not fail:\n${r.stdout}\n${r.stderr}`);
      return r.stdout.trim();
    };

    const digestA = digestOf(treeA);
    const digestB = digestOf(treeB);
    const digestC = digestOf(treeC);
    assert.equal(digestA.length, 64, 'a sha256 hex digest');
    assert.equal(digestA, digestB, 'identical content in a different directory-walk order and with different mtimes must produce the same digest');
    assert.notEqual(digestA, digestC, 'sanity: a real content difference must change the digest');
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
    // Withdraw the LaunchServices record this file's own runs create, before the path it
    // names is deleted a line below. install.sh refuses to REGISTER a bundle under a
    // throwaway root (is_throwaway_bundle_path, and test/check-install.mjs asserts it) —
    // but macOS registers one itself the moment a process inside it becomes an
    // NSApplication, and since ADR 72 the launcher's --menubar child does exactly that
    // once its daemon answers. This file is the one place in the suite where that daemon
    // really does answer from a temp root, so this is the one place that has to take the
    // record back. Left behind it is permanent, shares the real bundle id, and names a
    // path that is about to stop existing — which is the "claude-board.app is damaged and
    // can't be opened" dialog arriving weeks later (QUIRKS.md, "`lsregister` records are
    // permanent"). Best-effort by design: a machine where Apple has moved lsregister has
    // no record to withdraw either.
    //
    // AFTER the rm, and in BOTH spellings, both borrowed from code that already learned
    // this the hard way. After, for uninstall.sh's own reason for withdrawing after its
    // rm: while the bundle is still on disk, any LaunchServices rescan in the window
    // re-registers exactly the record being removed, and `-u` works fine on a path that
    // no longer exists. Both spellings, because LaunchServices records `/private/var/...`
    // where `tmpdir()` says `/var/...` — the same two test/check-install.mjs's own
    // assertion searches for, and a withdrawal naming only one of them silently does
    // nothing at all. Measured: naming only the `/var/...` spelling left the record in
    // place.
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    const registeredApp = path.join(fakeHome, 'Applications', 'claude-board.app');
    rmSync(workDir, { recursive: true, force: true });
    if (existsSync(lsregister)) {
      for (const spelling of [registeredApp, path.join('/private', registeredApp)]) {
        spawnSync(lsregister, ['-u', spelling], { timeout: 30_000 });
      }
    }
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall install-payload checks ok');
  });
