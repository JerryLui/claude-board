// Native pomodoro-boundary notification.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE. Every check below stubs
// `osascript` with a fake executable placed first on PATH -- the exact shape
// test/check-install.mjs already uses for `claude` and `launchctl` (STUB_CLAUDE /
// STUB_LAUNCHCTL, and the fakeNvm PATH-prepend for `node`) -- so `execFile('osascript',
// ...)` in src/notify.mjs resolves to the stub, never to /usr/bin/osascript. The stub
// records its argv to a log file this check reads back; nothing here ever calls the
// real interpreter.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { notifyBoundary, notifyTest, notifyRound, parseElapsedTime, mayWithdrawPid, withdrawClickChild } from '../src/notify.mjs';
import { startServer } from '../src/server.mjs';
import { writeDoc, pomodoroDay, DEFAULT_SETTINGS } from '../src/pomodoro.mjs';
import { cueNames, NO_CUE } from '../src/cues.mjs';
import { readSecret, SECRET_HEADER } from '../src/secret.mjs';
// execFileAsync (promisify(execFile)), never execFileSync: QUIRKS.md records that a
// synchronous subprocess call deadlocks against an in-process daemon, and two checks below
// boot one.
import {
  check, runMain, repoRoot, execFileAsync, secretHome, writeStub, STUB_OSASCRIPT,
  readJsonLines, freshLog, sleep, waitForCount, withEnv, withStubOnPath,
} from './support.mjs';

// Real names off THIS machine's /System/Library/Sounds (src/cues.mjs's own
// "enumerated rather than hardcoded" rule, extended to the checks: a fixed
// ['Glass', 'Sosumi', ...] list would be right about a stock Mac and wrong about a
// reader's pruned one). Three distinct real cues are what "three phases set to three
// different sounds produce three different sounds" needs to tell apart;
// NO_CUE ('None') is imported separately since it is never one of these.
const REAL_CUES = cueNames().filter(n => n !== NO_CUE);
assert.ok(REAL_CUES.length >= 3, 'this machine needs at least 3 real sounds in /System/Library/Sounds for this check to tell three phases apart');
const [CUE_WORK, CUE_BREAK, CUE_LONG_BREAK] = REAL_CUES;

// The local secret, in this check's own temp dir -- never ~/.config/claude-board. Set
// before any check below boots a real daemon (startServer/readSecret both resolve
// CLAUDE_BOARD_SECRET_FILE via src/secret.mjs's secretPath() seam, so this must land in
// process.env before either one is called). CLAUDE_BOARD_HOME stays unset: each check that
// boots a daemon hands startServer a home of its own.
const { home: workDir } = secretHome('claude-board-notify-check-', { setHome: false });

// The stub records every invocation's argv as one JSON line to the log each check names
// (read back through `readJsonLines`, awaited through `waitForCount` because notifyBoundary
// is fire-and-forget: there is no promise to await, only the stub's own disk write to
// observe), and its exit code is set from the environment, so the non-zero-exit path is
// exercisable.
const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', STUB_OSASCRIPT);

// A directory that contains no `osascript` at all -- and, deliberately, nothing else
// either -- for the "absent from PATH entirely" check: PATH resolution must fail with
// ENOENT rather than falling through to a real interpreter found elsewhere.
const emptyBinDir = path.join(workDir, 'empty-bin');
mkdirSync(emptyBinDir, { recursive: true });

async function main() {
  await check('notify: false fires nothing at all (notify is a master switch over the cue too)', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      notifyBoundary('work', { notify: false, cueWork: CUE_WORK });
      // No promise to await (notifyBoundary returns synchronously before ever touching
      // the subprocess on this path) -- a short settle is still worth it in case a
      // regression made this path async too.
      await sleep(200);
      assert.deepEqual(readJsonLines(log), [], 'osascript must never be invoked when notify is false, cue included');
    });
  });

  await check('notifyTest takes no settings at all -- the tick that asks for it has not been saved yet', async () => {
    // Structural, not stateful: the reader has only just ticked the box, so the stored
    // document still says notifications are off. `notifyTest` fires anyway, and the way
    // it guarantees that is by taking no settings argument and reading no document --
    // asserted on the function itself rather than by writing a doc to disk, which is
    // both a weaker claim (it would pass on a version that read the doc and happened to
    // find notify: true) and a check with a side effect on the reader's real state.
    assert.equal(notifyTest.length, 0, 'notifyTest must take no arguments');
    const src = readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export function notifyTest'), src.indexOf('function fire('));
    assert.doesNotMatch(body, /settings|readDoc/, 'notifyTest must not consult the saved settings');
  });

  await check('each phase crosses ITS OWN cue by name, and three different phases play three different sounds', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      const settings = { notify: true, cueWork: CUE_WORK, cueBreak: CUE_BREAK, cueLongBreak: CUE_LONG_BREAK };
      notifyBoundary('work', settings);
      notifyBoundary('break', settings);
      notifyBoundary('longBreak', settings);
      const lines = await waitForCount(() => readJsonLines(log), 3);
      assert.equal(lines.length, 3);
      // Three independent subprocesses -- do not assume which finishes writing first.
      // 'Work interval started' names work; 'Break started' (capital B, no 'Long') names
      // break; 'Long break started' names longBreak.
      const scripts = lines.map(l => l[1]);
      const workScript = scripts.find(s => /Work interval started/.test(s));
      const breakScript = scripts.find(s => /Break started/.test(s) && !/Long/.test(s));
      const longBreakScript = scripts.find(s => /Long break started/.test(s));
      assert.ok(workScript, 'expected a script for the work phase');
      assert.ok(breakScript, 'expected a script for the break phase');
      assert.ok(longBreakScript, 'expected a script for the longBreak phase');
      assert.match(workScript, new RegExp(`sound name "${CUE_WORK}"`), 'work must cross cueWork, not another phase\'s cue');
      assert.match(breakScript, new RegExp(`sound name "${CUE_BREAK}"`), 'break must cross cueBreak, not another phase\'s cue');
      assert.match(longBreakScript, new RegExp(`sound name "${CUE_LONG_BREAK}"`), 'longBreak must cross cueLongBreak, not another phase\'s cue');
      // The whole point of a per-phase cue (ADR.md entry 20's problem statement): the
      // three clauses must actually differ, not just be present.
      const names = [CUE_WORK, CUE_BREAK, CUE_LONG_BREAK];
      assert.equal(new Set(names).size, 3, 'the three picked cues must be distinct, or this check proves nothing');
    });
  });

  await check('a phase set to None crosses no sound argument at all', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      notifyBoundary('break', { notify: true, cueWork: CUE_WORK, cueBreak: NO_CUE, cueLongBreak: CUE_LONG_BREAK });
      const lines = await waitForCount(() => readJsonLines(log), 1);
      assert.equal(lines.length, 1);
      const [, script] = lines[0];
      assert.match(script, /Break started/);
      assert.doesNotMatch(script, /sound name/, 'cueBreak: None must not add a sound name clause');
    });
  });

  await check('a cue value the closed set does not recognise crosses nothing, same as None', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      // Not a validity check on the HTTP boundary (src/pomodoro.mjs owns that) -- this is
      // notifyBoundary's OWN defensive posture as a pure function of whatever settings
      // handed it, exactly as an unrecognised phase already gets no MESSAGES entry.
      notifyBoundary('work', { notify: true, cueWork: 'definitely; not a real sound' });
      const lines = await waitForCount(() => readJsonLines(log), 1);
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines[0][1], /sound name/, 'a value isCue() refuses must never reach the script string');
    });
  });

  await check('an unknown phase fires nothing (the closed-set guard)', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      notifyBoundary('lunch', { notify: true, cueWork: CUE_WORK });
      await sleep(200);
      assert.deepEqual(readJsonLines(log), [], 'an unrecognised phase must never reach osascript');
    });
  });

  // Ahead of every check below that makes osascript fail, and that placement is
  // load-bearing: warnOnFailure warns once per process, so a failure earlier in this file
  // would burn the warning and leave this check passing on nothing.
  await check('killing a round banner\'s click child with SIGTERM is not reported as a notification failure', async () => {
    // Node hands `killed: true, signal: 'SIGTERM'` to execFile's callback when we kill a
    // child on purpose -- which is every return-to-board (src/stranded.mjs's `terminate`).
    // Unexempted, that printed "notifications may not be appearing" on the happy path AND
    // burned the one-shot warning, so a genuinely broken notifier later in the same run
    // said nothing at all. Real `notifyRound` here, against a stub that stays alive long
    // enough to be killed.
    const lingerDir = path.join(workDir, 'linger-bin');
    writeStub(lingerDir, 'osascript', '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 3000);\n');
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    try {
      await withEnv({ PATH: `${lingerDir}:${process.env.PATH}` }, async () => {
        const child = notifyRound('kill-me');
        await sleep(120);
        child.kill('SIGTERM');
        await sleep(250);
      });
    } finally {
      console.error = realError;
    }
    assert.deepEqual(said, [], `killing our own click-serving child must say nothing: ${said.join(' | ')}`);
  });

  await check('mayWithdrawPid refuses the parent, this process and every non-pid, and passes an ordinary pid', async () => {
    // The start-time gate used to do this job: the launchd supervisor shares APP_EXEC
    // exactly (install.sh puts that path in ProgramArguments) and its SIGTERM is relayed
    // to node, but it has run since login, so "started before the record was written"
    // excluded it. That stopped being true the moment a graceful stop began leaving
    // records standing -- the SUCCESSOR supervisor starts AFTER `at`. A record naming a
    // pid this daemon itself killed, plus a pid space that has wrapped over half an hour
    // of builds, is a SIGTERM to our own supervisor and every blocked `ask` dying with it.
    assert.equal(mayWithdrawPid(process.ppid), false, 'the parent is the one death that is catastrophic');
    assert.equal(mayWithdrawPid(process.pid), false, 'and signalling ourselves is never the answer either');
    for (const bad of [0, 1, -1, 1.5, NaN, null, undefined, '4242']) {
      assert.equal(mayWithdrawPid(bad), false, `${JSON.stringify(bad)} is not a pid this may signal`);
    }
    // An ordinary pid that is neither still passes, or the guard would have eaten the
    // feature rather than protected it.
    const ordinary = [process.pid, process.ppid].includes(999_99) ? 99_998 : 99_999;
    assert.equal(mayWithdrawPid(ordinary), true);
  });

  await check('parseElapsedTime reads every ps etime shape, withdrawClickChild asks ps for etime before comm, and its guards refuse without throwing', async () => {
    // `ps -o comm=` alone cannot discriminate: every claude-board process prints the same
    // path, including the launchd job that SUPERVISES this daemon (install.sh puts that
    // exact string in ProgramArguments), whose SIGTERM is relayed to node. So a stale
    // record naming a recycled pid could take the whole daemon down, or withdraw another
    // board's banner while its round was still awaited. The start time is what excludes
    // them: anything running since before the record was written is not what it names.
    assert.equal(parseElapsedTime('05:23'), 323_000, 'mm:ss');
    assert.equal(parseElapsedTime('   05:23  '), 323_000, 'ps pads its columns');
    assert.equal(parseElapsedTime('01:05:23'), 3_923_000, 'hh:mm:ss');
    assert.equal(parseElapsedTime('2-01:05:23'), 176_723_000, 'dd-hh:mm:ss, i.e. the supervisor');
    for (const junk of ['', 'x', '5', '1:2:3:4', null, undefined]) {
      assert.equal(parseElapsedTime(junk), null, `${JSON.stringify(junk)} must refuse rather than guess`);
    }

    // Measured against the real thing rather than assumed: this process's own etime must
    // be a shape the parser accepts, and must place its start in the past.
    const { stdout } = await execFileAsync('ps', ['-o', 'etime=', '-p', String(process.pid)]);
    const elapsed = parseElapsedTime(stdout);
    assert.ok(elapsed !== null, `macOS ps -o etime= must parse, got ${JSON.stringify(stdout)}`);
    assert.ok(elapsed >= 0 && elapsed < 86_400_000, `and be a sane elapsed time, got ${elapsed}`);

    // The COLUMN ORDER is load-bearing and was wrong once, silently. macOS clamps `comm`
    // to MAXCOMLEN (16 bytes) whenever it is not the final column -- so with
    // `-o comm=,etime=` the path comparison in withdrawClickChild could never match on
    // any real install, where APP_EXEC runs past 60 characters, and the recorded-pid
    // path was inert for the one case it exists for. Asserted against a path of that
    // length rather than against this process's own, which on a short-path install would
    // pass either way and prove nothing.
    // Two things about this setup are load-bearing.
    //
    // The path is NOT shaped `claude-board.app/Contents/MacOS/claude-board`, which is what
    // it used to be. Exec'ing an unsigned binary from inside a bundle makes macOS evaluate
    // that bundle: it SIGKILLs the process, registers the bundle with LaunchServices
    // permanently, and puts "claude-board.app is damaged and can't be opened" on screen --
    // under the real install's name, from a suite run, with the real install perfectly
    // fine (QUIRKS.md, "A copied platform binary is SIGKILLed on exec from inside a
    // `.app`, wherever the copy lives" for the kill and the symlink remedy below, and
    // "`lsregister` records are permanent" for the registration that outlives it).
    // Only the LENGTH matters
    // here, so this mirrors the real APP_EXEC's depth with no bundle anywhere in it.
    //
    // And the process at that path is a SYMBOLIC LINK to `process.execPath`, not a copy.
    // `ps` reports the path a process was started from, not the path a link resolves to,
    // so the link proves the same fact a copy would -- at no disk cost, with nothing to
    // clean up but the link itself.
    //
    // The link points at NODE, not `/bin/sleep`. A link to `/bin/sleep` would run the real
    // system binary just fine -- a link carries none of a copy's signature problem -- but
    // `process.execPath` is the one binary certain to exist here: it's the interpreter
    // already running this check, which is why the `-e` flag passed to it below means
    // anything at all.
    const longExec = path.join(workDir, 'launcher-exec-path-over-maxcomlen', 'claude-board');
    mkdirSync(path.dirname(longExec), { recursive: true });
    symlinkSync(process.execPath, longExec);
    assert.ok(longExec.length > 16, 'setup sanity: the path has to exceed MAXCOMLEN to prove anything');
    assert.ok(!longExec.includes('.app/'), 'and must NOT be bundle-shaped: exec\'ing out of one raises the damaged dialog');
    // 30s, not the 5s this started at: nothing waits for the deadline (the `finally` below
    // kills the child the moment the measurements are done), so the only thing a short one
    // bought was a race with `ps` on a machine booting other checks' daemons in parallel.
    const sleeper = spawn(longExec, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    // A spawn that fails (noexec TMPDIR, a dangling link) emits 'error' asynchronously,
    // and an unhandled one on a ChildProcess throws out of the event loop rather than into
    // the try below -- taking the whole file down instead of failing this one check.
    sleeper.on('error', () => {});
    try {
      await sleep(300);
      // Name the child, not `ps`, when setup itself failed: `sleeper.on('error', ...)`
      // above swallows a failed spawn and leaves `pid` undefined, and the child's own
      // deadline can lapse before the two `ps` calls below run on a machine already busy
      // booting daemons in parallel. Either way `ps -p` finds nothing, prints nothing, and
      // exits 1 -- which execFileAsync turns into a rejected "Command failed: ps" that
      // names the wrong culprit.
      //
      // Asserted before EACH `ps` call rather than once at the top: the second call is two
      // awaits after the first, and that gap is itself a window the deadline can lapse in,
      // so a single check at the top leaves the second call able to reject with exactly the
      // misattributed message the guard exists to remove.
      assert.ok(Number.isInteger(sleeper.pid), 'setup failure: the long-path sleeper never got a pid -- spawn failed, not a ps problem');
      const stillAlive = which => assert.doesNotThrow(() => process.kill(sleeper.pid, 0),
        `setup failure: the long-path sleeper exited before the ${which} ps could measure it -- not a ps problem`);
      stillAlive('first');
      const both = await execFileAsync('ps', ['-o', 'etime=,comm=', '-p', String(sleeper.pid)]);
      const line = both.stdout.trim();
      const cut = line.indexOf(' ');
      assert.equal(line.slice(cut + 1).trim(), longExec,
        'etime first, comm last: the full executable path must survive, or the pid gate never fires');
      assert.ok(parseElapsedTime(line.slice(0, cut)) !== null,
        'and the first column must still be an etime the parser accepts');

      stillAlive('second');
      const truncated = await execFileAsync('ps', ['-o', 'comm=,etime=', '-p', String(sleeper.pid)]);
      assert.ok(!truncated.stdout.includes(longExec),
        'and the other order really does truncate -- if macOS ever stops doing this, the comment above is what needs correcting, not this check');
    } finally {
      sleeper.kill();
    }

    // And that withdrawClickChild ASKS for that order. The two assertions above prove a
    // fact about macOS; this one proves the code depends on the right side of it. A
    // behavioural check cannot reach here -- withdrawClickChild returns early without a
    // bundle, so outside one it is unobservable by construction -- and the cost of
    // getting this wrong is not a wrong answer but silence: the gate simply never fires,
    // which is exactly how it shipped.
    const notifySrc = readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8');
    assert.match(notifySrc, /'-o',\s*'etime=,comm='/,
      "withdrawClickChild must ask ps for etime FIRST -- with comm first macOS clamps it to 16 bytes and the path comparison can never match an APP_EXEC-length path");
    assert.doesNotMatch(notifySrc, /'comm=,etime='/,
      'and must not ask for the truncating order anywhere');

    // The guards refuse rather than throw, on a path where throwing would reach a timer.
    for (const args of [[0, Date.now()], [-1, Date.now()], [1, Date.now()], [12345, NaN], [12345, undefined]]) {
      assert.doesNotThrow(() => withdrawClickChild(...args), `withdrawClickChild(${args}) must be a silent no-op`);
    }
  });

  await check('osascript exiting non-zero throws nothing and does not crash the caller', async () => {
    const log = freshLog(workDir);
    let uncaught = null;
    const onUncaught = err => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      await withStubOnPath(stubDir, log,{ STUB_OSASCRIPT_EXIT: '1' }, async () => {
        assert.doesNotThrow(() => notifyBoundary('work', { notify: true, cueWork: CUE_WORK }));
        await waitForCount(() => readJsonLines(log), 1); // let the async failure actually happen before asserting on it
        await sleep(100);
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
      await withEnv({ PATH: emptyBinDir }, async () => {
        assert.doesNotThrow(() => notifyBoundary('work', { notify: true, cueWork: CUE_WORK }));
        await sleep(300); // give the ENOENT time to surface async
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
    const log = freshLog(workDir);
    const home = mkdtempSync(path.join(tmpdir(), 'claude-board-notify-e2e-'));
    const now = Date.now();
    // 150ms out: enough margin over the write-then-listen gap between here and
    // startServer's own pomodoro.boot() call, short enough that the 5s wait below has no
    // reason to be patient about it.
    writeDoc({
      // enabled: true (ADR 105 shipped the Master switch off by default) -- without it
      // readDoc nulls the timer before the boundary ever gets a chance to fire.
      settings: { ...DEFAULT_SETTINGS, enabled: true, notify: true, cueWork: CUE_WORK, cueBreak: CUE_BREAK, cueLongBreak: CUE_LONG_BREAK },
      cycle: 0,
      cycleDate: pomodoroDay(now),
      timer: { phase: 'work', deadline: now + 150, paused: false },
    }, home);

    await withStubOnPath(stubDir, log,{}, async () => {
      // PATH must be stubbed BEFORE startServer, not just before the boundary: the
      // pomodoro clock is armed as part of startServer's own synchronous setup (boot()
      // runs before the returned promise resolves), and execFile reads process.env.PATH
      // at the moment it is actually called, which is later, inside this same scope.
      const { server } = await startServer({ home, port: 0 });
      try {
        const lines = await waitForCount(() => readJsonLines(log), 1, { timeoutMs: 5000 });
        assert.equal(lines.length, 1, 'exactly one osascript invocation reached through the real daemon path');
        const [, script] = lines[0];
        assert.match(script, /display notification/);
        // work -> break with the default settings (longEvery: 4, cycle starts at 0), so
        // the boundary reports the phase that just began: 'break'.
        assert.match(script, /break/i, 'the message must name the phase that just began (work -> break)');
        assert.match(script, new RegExp(`sound name "${CUE_BREAK}"`), 'the cue that crosses through the real daemon path must be the BREAK phase\'s own cue, not cueWork');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
    rmSync(home, { recursive: true, force: true });
  });

  await check('the real daemon path: POST /api/pomodoro/notifyTest fires the test banner, with notifications saved OFF', async () => {
    // The route the Notify tick calls (src/indexpage.mjs). It lives here rather than in
    // test/check-http.mjs for the reason that file states about itself: it stubs no PATH,
    // so the only thing keeping it silent is `notify: false` in the seeded document --
    // and this route deliberately ignores that value, which is the whole point of it.
    // Seeded off below for exactly that reason: a green result proves the test banner is
    // not gated on the setting the reader has ticked but not yet saved.
    //
    // notifyRounds seeded off too (ticket 03, ADR.md entry 58, criterion 18): the round
    // banner's own tick lives in the same settings document now, and this route must
    // remain wholly indifferent to it -- exactly one banner, never zero (gated on the
    // wrong toggle) and never two (one per kind), regardless of what either tick says.
    const log = freshLog(workDir);
    const home = mkdtempSync(path.join(tmpdir(), 'claude-board-notifytest-e2e-'));
    writeDoc({ settings: { ...DEFAULT_SETTINGS, notify: false, notifyRounds: false }, cycle: 0, cycleDate: null, timer: null }, home);

    await withStubOnPath(stubDir, log,{}, async () => {
      const { server } = await startServer({ home, port: 0 });
      try {
        const { port } = server.address();
        const r = await fetch(`http://127.0.0.1:${port}/api/pomodoro/notifyTest`, {
          method: 'POST',
          headers: { [SECRET_HEADER]: readSecret() },
        });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { ok: true });
        const lines = await waitForCount(() => readJsonLines(log), 1, { timeoutMs: 5000 });
        assert.equal(lines.length, 1, 'exactly one osascript invocation reached through the route -- one banner, not one per kind, and not gated on either toggle');
        const [flag, script] = lines[0];
        assert.equal(flag, '-e');
        assert.match(script, /display notification/);
        assert.match(script, /Notifications are working/, 'the test banner says what it is');
        // Silent on purpose: auditioning a SOUND is the cue pickers' job, and a test
        // banner that also plays something makes it ambiguous which one just worked.
        assert.doesNotMatch(script, /sound name/, 'the test banner stays silent through the route too');
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    });
    rmSync(home, { recursive: true, force: true });
  });

  // The bundled path (ADR.md entry 19). Every check above exercises the osascript
  // fallback, because this suite imports src/notify.mjs from the clone and the clone is
  // not a bundle -- which is exactly the degraded install's situation, and is why the
  // fallback still has to work. The checks below cover the other branch by building
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
    mkdirSync(path.join(appDir, 'Contents', 'Resources', 'src'), { recursive: true });
    const exec = writeStub(path.join(appDir, 'Contents', 'MacOS'), name, STUB_LAUNCHER);
    const modPath = path.join(appDir, 'Contents', 'Resources', 'src', 'notify.mjs');
    writeFileSync(modPath, readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8'));
    // notify.mjs's own `import { isCue, NO_CUE } from './cues.mjs'` resolves relative to
    // ITS location once copied, so the copy needs cues.mjs sitting beside it too, or the
    // dynamic import below throws ERR_MODULE_NOT_FOUND before this check ever runs.
    writeFileSync(
      path.join(appDir, 'Contents', 'Resources', 'src', 'cues.mjs'),
      readFileSync(path.join(repoRoot, 'src', 'cues.mjs'), 'utf8'),
    );
    return { exec, mod: await import(`file://${modPath}`) };
  }

  await check('inside a bundle, a boundary with no cue spawns the bundle executable with just the phase, and never osascript', async () => {
    const log = freshLog(workDir);
    const launcherLog = path.join(workDir, 'launcher-invocations-1.log');
    const { mod } = await importFromFakeBundle('claude-board');
    await withStubOnPath(stubDir, log,{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyBoundary('work', { notify: true, cueWork: NO_CUE });
      const lines = await waitForCount(() => readJsonLines(launcherLog), 1);
      assert.deepEqual(lines[0], ['--notify', 'work'],
        'the phase is passed as an argument, and no third argument when the cue is None');
      assert.deepEqual(readJsonLines(log), [],
        'osascript must not be invoked at all when the bundle executable is present');
    });
  });

  await check('inside a bundle, each phase crosses its OWN cue -- not another phase\'s', async () => {
    const launcherLog = path.join(workDir, 'launcher-invocations-3.log');
    const { mod } = await importFromFakeBundle('claude-board-3');
    const settings = { notify: true, cueWork: CUE_WORK, cueBreak: CUE_BREAK, cueLongBreak: CUE_LONG_BREAK };
    await withStubOnPath(stubDir, freshLog(workDir),{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyBoundary('work', settings);
      mod.notifyBoundary('break', settings);
      mod.notifyBoundary('longBreak', settings);
      const lines = await waitForCount(() => readJsonLines(launcherLog), 3);
      assert.deepEqual(lines.find(l => l[1] === 'work'), ['--notify', 'work', CUE_WORK]);
      assert.deepEqual(lines.find(l => l[1] === 'break'), ['--notify', 'break', CUE_BREAK]);
      assert.deepEqual(lines.find(l => l[1] === 'longBreak'), ['--notify', 'longBreak', CUE_LONG_BREAK]);
    });
  });

  await check('inside a bundle, a cue value the closed set does not recognise crosses no third argument', async () => {
    const launcherLog = path.join(workDir, 'launcher-invocations-4.log');
    const { mod } = await importFromFakeBundle('claude-board-4');
    await withStubOnPath(stubDir, freshLog(workDir),{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyBoundary('work', { notify: true, cueWork: 'not a real sound at all' });
      const lines = await waitForCount(() => readJsonLines(launcherLog), 1);
      assert.deepEqual(lines[0], ['--notify', 'work']);
    });
  });

  await check('the launcher knows every phase src/notify.mjs will send it', async () => {
    // The two closed tables (MESSAGES in src/notify.mjs, MESSAGES in bin/launcher.c) are
    // the mechanism by which argv selects a sentence instead of supplying one, and they
    // are only that if they agree: a phase this file will send but the launcher does not
    // know is a boundary that silently notifies nothing on the bundled install.
    const c = readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8');
    const table = c.slice(c.indexOf('MESSAGES[] = {'), c.indexOf('enum { MESSAGES_N'));
    // Read the phases out of src/notify.mjs rather than listing them here. A hardcoded
    // list is exactly how this check goes quietly stale: it passed for the three phases
    // it named while a fourth ('test', 2026-08-05) could have been added on one side
    // only, which is the drift this exists to catch.
    const js = readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8');
    const jsTable = js.slice(js.indexOf('const MESSAGES = {'), js.indexOf('const CUE_KEYS'));
    // Each row is `phase: { ... }` since ADR.md entry 58 generalised MESSAGES to carry
    // a per-row title -- was `phase: 'message'` before.
    const phases = [...jsTable.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]);
    assert.ok(phases.length >= 5, `expected to parse src/notify.mjs's MESSAGES keys, got ${JSON.stringify(phases)}`);
    for (const phase of phases) {
      assert.match(table, new RegExp(`"${phase}"`), `bin/launcher.c must know the '${phase}' phase`);
    }
  });

  await check('no audio file is tracked anywhere in the repo', async () => {
    const r = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const audioExt = /\.(aiff|wav|mp3|m4a|caf|aac|ogg)$/i;
    const files = r.stdout.trim().split('\n').filter(Boolean);
    const offenders = files.filter(f => audioExt.test(f));
    assert.deepEqual(offenders, [], 'no tracked file may carry an audio extension');
  });

  // Withdraw every fake bundle this file staged before the directory goes. `notifyBoundary`
  // has to SPAWN the bundle executable for these checks to prove anything, and exec'ing out
  // of a `.app` is itself a permanent LaunchServices registration -- no `lsregister -f`
  // anywhere, and `install.sh`'s temp-root guard cannot help, because install.sh never ran.
  // Left alone these accumulate one dead record per suite run under the real install's own
  // bundle name, which is macOS raising "claude-board.app is damaged and can't be opened"
  // on a machine whose install is fine (QUIRKS.md, "`lsregister` records are permanent").
  // Best-effort and never fatal: a machine where lsregister has moved just keeps the
  // records, which is where this started, not a worse place.
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (existsSync(lsregister)) {
    for (const staged of readdirSync(workDir).filter(n => n.endsWith('.app'))) {
      spawnSync(lsregister, ['-u', path.join(workDir, staged)], { timeout: 10_000 });
    }
  }
  rmSync(workDir, { recursive: true, force: true });
}

await runMain('check-notify', main, { lead: '' });
