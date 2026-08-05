// Native pomodoro-boundary notification (SPEC_POMODORO.md criterion 5, ticket 02).
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE. Every check below stubs
// `osascript` with a fake executable placed first on PATH -- the exact shape
// test/check-install.mjs already uses for `claude` and `launchctl` (STUB_CLAUDE /
// STUB_LAUNCHCTL, and the fakeNvm PATH-prepend for `node`) -- so `execFile('osascript',
// ...)` in src/notify.mjs resolves to the stub, never to /usr/bin/osascript. The stub
// records its argv to a log file this check reads back; nothing here ever calls the
// real interpreter.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyBoundary } from '../src/notify.mjs';
import { startServer } from '../src/server.mjs';
import { writeDoc, localDateStr, DEFAULT_SETTINGS } from '../src/pomodoro.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-notify-check-'));

// Same pattern as test/check-install.mjs's STUB_CLAUDE/STUB_LAUNCHCTL: a tiny node
// script standing in for the real binary, recording every invocation's argv as one
// JSON line, exit code controllable via env so the non-zero-exit path is exercisable.
const STUB_OSASCRIPT = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_OSASCRIPT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.STUB_OSASCRIPT_EXIT || '0'));
`;

const stubDir = path.join(workDir, 'bin');
mkdirSync(stubDir, { recursive: true });
const stubPath = path.join(stubDir, 'osascript');
writeFileSync(stubPath, STUB_OSASCRIPT);
chmodSync(stubPath, 0o755);

// A directory that contains no `osascript` at all -- and, deliberately, nothing else
// either -- for the "absent from PATH entirely" check: PATH resolution must fail with
// ENOENT rather than falling through to a real interpreter found elsewhere.
const emptyBinDir = path.join(workDir, 'empty-bin');
mkdirSync(emptyBinDir, { recursive: true });

let logCounter = 0;
/** A fresh log path per check, so one check's invocation count can never be read as
 * another's. */
function freshLog() {
  logCounter++;
  return path.join(workDir, `osascript-invocations-${logCounter}.log`);
}

function readLines(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Poll until `logPath` holds at least `count` lines, or give up. Needed because
 * notifyBoundary is fire-and-forget (execFile, never awaited -- see src/notify.mjs's own
 * header on why): there is no promise to await here, only the stub's own disk write to
 * observe. */
async function waitForLines(logPath, count, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readLines(logPath).length >= count) return readLines(logPath);
    await new Promise(r => setTimeout(r, 20));
  }
  return readLines(logPath);
}

/** Run `fn` with PATH and the stub's own env vars set, restoring the previous values
 * (including "was absent") afterwards -- so one check's PATH manipulation can never
 * leak into the next. */
async function withStubEnv(patch, fn) {
  const keys = Object.keys(patch);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, patch);
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const withStubOnPath = (logPath, extra, fn) =>
  withStubEnv({ PATH: `${stubDir}:${process.env.PATH}`, STUB_OSASCRIPT_LOG: logPath, STUB_OSASCRIPT_EXIT: '0', ...extra }, fn);

async function main() {
  await check('a boundary fires exactly one osascript invocation naming the phase that just began', async () => {
    const log = freshLog();
    await withStubOnPath(log, {}, async () => {
      notifyBoundary('work', { notify: true, sound: false });
      const lines = await waitForLines(log, 1);
      assert.equal(lines.length, 1, 'exactly one osascript invocation');
      const [flag, script] = lines[0];
      assert.equal(flag, '-e');
      assert.match(script, /display notification/);
      assert.match(script, /work/i, 'the message must name the phase that just began');
    });
  });

  await check('notify: false fires nothing at all', async () => {
    const log = freshLog();
    await withStubOnPath(log, {}, async () => {
      notifyBoundary('work', { notify: false, sound: true });
      // No promise to await (notifyBoundary returns synchronously before ever touching
      // the subprocess on this path) -- a short settle is still worth it in case a
      // regression made this path async too.
      await new Promise(r => setTimeout(r, 200));
      assert.deepEqual(readLines(log), [], 'osascript must never be invoked when notify is false');
    });
  });

  await check('sound: true puts a sound name clause in the script, sound: false does not', async () => {
    const log = freshLog();
    await withStubOnPath(log, {}, async () => {
      notifyBoundary('break', { notify: true, sound: true });
      notifyBoundary('longBreak', { notify: true, sound: false });
      const lines = await waitForLines(log, 2);
      assert.equal(lines.length, 2);
      // Two independent subprocesses -- do not assume which finishes writing first.
      // 'Break started' (capital B) names the break phase; 'Long break started'
      // (lowercase b) is the only script that also contains 'Long'.
      const soundOnScript = lines.map(l => l[1]).find(s => /Break started/.test(s) && !/Long/.test(s));
      const soundOffScript = lines.map(l => l[1]).find(s => /Long break started/.test(s));
      assert.ok(soundOnScript, 'expected a script for the break phase');
      assert.ok(soundOffScript, 'expected a script for the longBreak phase');
      assert.match(soundOnScript, /sound name/, 'sound: true must include a sound name clause');
      assert.doesNotMatch(soundOffScript, /sound name/, 'sound: false must not include a sound name clause');
    });
  });

  await check('an unknown phase fires nothing (the closed-set guard)', async () => {
    const log = freshLog();
    await withStubOnPath(log, {}, async () => {
      notifyBoundary('lunch', { notify: true, sound: true });
      await new Promise(r => setTimeout(r, 200));
      assert.deepEqual(readLines(log), [], 'an unrecognised phase must never reach osascript');
    });
  });

  await check('osascript exiting non-zero throws nothing and does not crash the caller', async () => {
    const log = freshLog();
    let uncaught = null;
    const onUncaught = err => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      await withStubOnPath(log, { STUB_OSASCRIPT_EXIT: '1' }, async () => {
        assert.doesNotThrow(() => notifyBoundary('work', { notify: true, sound: false }));
        await waitForLines(log, 1); // let the async failure actually happen before asserting on it
        await new Promise(r => setTimeout(r, 100));
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.equal(uncaught, null, `a non-zero osascript exit must not raise: ${uncaught}`);
  });

  await check('osascript missing from PATH entirely throws nothing and does not crash the caller', async () => {
    let uncaught = null;
    const onUncaught = err => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      await withStubEnv({ PATH: emptyBinDir }, async () => {
        assert.doesNotThrow(() => notifyBoundary('work', { notify: true, sound: false }));
        await new Promise(r => setTimeout(r, 300)); // give the ENOENT time to surface async
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.equal(uncaught, null, `a missing osascript must not raise: ${uncaught}`);
  });

  await check('the real daemon path (startServer) actually reaches notifyBoundary, not just notifyBoundary called directly', async () => {
    // Every check above calls notifyBoundary(...) itself, which proves the function
    // works but proves nothing about whether src/server.mjs's startServer ever wires it
    // in -- a dropped `onBoundary:` at the createPomodoro call site would leave every
    // check above green while the daemon crossed every real boundary in silence. This
    // one goes through the actual production path: seed pomodoro.json with a timer
    // about to expire, boot a real server against a temp home, and wait for the stub to
    // observe an invocation it never called into directly.
    const log = freshLog();
    const home = mkdtempSync(path.join(tmpdir(), 'claude-board-notify-e2e-'));
    const now = Date.now();
    // 150ms out: enough margin over the write-then-listen gap between here and
    // startServer's own pomodoro.boot() call, short enough that waitForLines's 5s
    // budget below has no reason to be patient about it.
    writeDoc({
      settings: { ...DEFAULT_SETTINGS, notify: true, sound: false },
      cycle: 0,
      cycleDate: localDateStr(now),
      timer: { phase: 'work', deadline: now + 150, paused: false },
    }, home);

    await withStubOnPath(log, {}, async () => {
      // PATH must be stubbed BEFORE startServer, not just before the boundary: the
      // pomodoro clock is armed as part of startServer's own synchronous setup (boot()
      // runs before the returned promise resolves), and execFile reads process.env.PATH
      // at the moment it is actually called, which is later, inside this same scope.
      const { server } = await startServer({ home, port: 0 });
      try {
        const lines = await waitForLines(log, 1, 5000);
        assert.equal(lines.length, 1, 'exactly one osascript invocation reached through the real daemon path');
        const [, script] = lines[0];
        assert.match(script, /display notification/);
        // work -> break with the default settings (longEvery: 4, cycle starts at 0), so
        // the boundary reports the phase that just began: 'break'.
        assert.match(script, /break/i, 'the message must name the phase that just began (work -> break)');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
    rmSync(home, { recursive: true, force: true });
  });

  // The bundled path (ADR.md entry 19). Every check above exercises the osascript
  // fallback, because this suite imports src/notify.mjs from the clone and the clone is
  // not a bundle -- which is exactly the degraded install's situation, and is why the
  // fallback still has to work. The two checks below cover the other branch by building
  // the layout install.sh stages (Contents/Resources/src/notify.mjs beside
  // Contents/MacOS/<name>) around a COPY of the real file, so what is under test is the
  // shipped derivation rather than a restatement of it. The stub executable stands in for
  // the launcher's --notify mode; no real notification can fire from here either.
  const STUB_LAUNCHER = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_LAUNCHER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

  /** Stage a fake claude-board.app around a copy of src/notify.mjs and import it. Fresh
   * bundle name per call so two checks can never share a module instance -- APP_EXEC is
   * computed once at import, and node caches modules by URL. */
  async function importFromFakeBundle(name) {
    const appDir = path.join(workDir, `${name}.app`);
    mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(path.join(appDir, 'Contents', 'Resources', 'src'), { recursive: true });
    const exec = path.join(appDir, 'Contents', 'MacOS', name);
    writeFileSync(exec, STUB_LAUNCHER);
    chmodSync(exec, 0o755);
    const modPath = path.join(appDir, 'Contents', 'Resources', 'src', 'notify.mjs');
    writeFileSync(modPath, readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8'));
    return { exec, mod: await import(`file://${modPath}`) };
  }

  await check('inside a bundle, a boundary spawns the bundle executable and never osascript', async () => {
    const log = freshLog();
    const launcherLog = path.join(workDir, 'launcher-invocations-1.log');
    const { mod } = await importFromFakeBundle('claude-board');
    await withStubOnPath(log, { STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyBoundary('work', { notify: true, sound: false });
      const lines = await waitForLines(launcherLog, 1);
      assert.deepEqual(lines[0], ['--notify', 'work'],
        'the phase is passed as an argument, and no --sound without the setting');
      assert.deepEqual(readLines(log), [],
        'osascript must not be invoked at all when the bundle executable is present');
    });
  });

  await check('inside a bundle, sound: true adds --sound', async () => {
    const launcherLog = path.join(workDir, 'launcher-invocations-2.log');
    const { mod } = await importFromFakeBundle('claude-board-2');
    await withStubOnPath(freshLog(), { STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyBoundary('longBreak', { notify: true, sound: true });
      const lines = await waitForLines(launcherLog, 1);
      assert.deepEqual(lines[0], ['--notify', 'longBreak', '--sound']);
    });
  });

  await check('the launcher knows every phase src/notify.mjs will send it', async () => {
    // The two closed tables (MESSAGES in src/notify.mjs, MESSAGES in bin/launcher.c) are
    // the mechanism by which argv selects a sentence instead of supplying one, and they
    // are only that if they agree: a phase this file will send but the launcher does not
    // know is a boundary that silently notifies nothing on the bundled install.
    const c = readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8');
    const table = c.slice(c.indexOf('MESSAGES[] = {'), c.indexOf('enum { MESSAGES_N'));
    for (const phase of ['work', 'break', 'longBreak']) {
      assert.match(table, new RegExp(`"${phase}"`), `bin/launcher.c must know the '${phase}' phase`);
    }
  });

  await check('criterion 14: no audio file is tracked anywhere in the repo', async () => {
    const r = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const audioExt = /\.(aiff|wav|mp3|m4a|caf|aac|ogg)$/i;
    const files = r.stdout.trim().split('\n').filter(Boolean);
    const offenders = files.filter(f => audioExt.test(f));
    assert.deepEqual(offenders, [], 'no tracked file may carry an audio extension');
  });

  rmSync(workDir, { recursive: true, force: true });

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all check-notify checks ok');
}

await main();
