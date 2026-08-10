// The banner a stranded round raises can be clicked (SPEC_STRANDED.md, ticket 04 in
// TICKETS_STRANDED.md; ADR.md entry 57). This file covers what that ticket owns:
//
//   - AC 14, the load-bearing half: the board-URL pattern lives in C, beside
//     is_safe_cue_name and is_safe_folder_name, and a URL that is not a board URL for
//     this daemon never reaches the notifier at all. Checked against the REAL compiled
//     bin/launcher.c -- a regex on the source would pass while the scanner itself was
//     wrong, and this is the one filter standing between argv and LaunchServices, which
//     will act on any scheme it can resolve.
//   - AC 13, its second sentence: no credential is passed on the command line at any
//     point. A `/auth/<token>` handoff URL is refused by both the C filter and
//     src/notify.mjs's mirror of it, so the click can only ever be a plain board URL
//     that the browser's own session authorizes -- and a browser holding none lands on
//     the refusal page src/render.mjs already renders (AC 13's first sentence, which is
//     that page's behaviour and not this file's to re-prove).
//   - AC 12's URL: the fragment the board page resolves to the round still waiting
//     (`#stranded-round`, src/ui.mjs) survives the filter, since a click that landed on
//     round 1 of a long thread would satisfy nothing. `#open-round` is the index's own
//     sentinel and means the NEWEST open round; both are here because this filter checks
//     a fragment's SHAPE and neither spelling is its business -- which is the point, the
//     daemon alone decides what it sends.
//   - The half of AC 15 this ticket owns: the spawned process is handed a lifetime it
//     cannot exceed, and the daemon is handed a ChildProcess to kill it with sooner.
//
// The real notification is never posted here and no banner may ever appear: the C half
// is linked against a STUB cb_notify that prints its arguments, and the JS half runs
// against the same stub-launcher-on-PATH scaffolding test/check-notify.mjs and
// test/check-notify-round.mjs already use.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ccCmd = process.env.CLAUDE_BOARD_CC || 'cc';

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-notify-click-'));

// --- The C filter, compiled for real -----------------------------------------------
//
// bin/launcher.c only, linked against a stub cb_notify rather than bin/notify.m: this
// suite must never reach UNUserNotificationCenter, and the stub is also what makes the
// filter's verdict readable -- it prints what the notifier WOULD have been handed.
// Same launcher_paths.h trick test/check-launcher-env.mjs uses, pointed at nothing that
// exists, since no path in the header is reached on the --notify branch.

const stubNotify = path.join(workDir, 'stub-notify.c');
writeFileSync(stubNotify, `#include <stdio.h>
int cb_notify(const char *title, const char *body, const char *cue_name, int use_default_sound,
              const char *board_url, int click_seconds) {
  printf("title=%s\\nbody=%s\\ncue=%s\\ndefault_sound=%d\\nurl=%s\\nseconds=%d\\n",
         title ? title : "(null)", body ? body : "(null)", cue_name ? cue_name : "(null)",
         use_default_sound, board_url ? board_url : "(null)", click_seconds);
  return 0;
}
/* The launcher's other two externs (ADR 72, bin/menubar.m), stubbed for the same reason
   cb_notify is: launcher.c does not link without them, and nothing on the --notify branch
   this file exercises ever calls either. */
int cb_menubar(void) { return 0; }
int cb_menubar_probe(void) { return 0; }
`);

const headerDir = path.join(workDir, 'header');
mkdirSync(headerDir, { recursive: true });
writeFileSync(path.join(headerDir, 'launcher_paths.h'), [
  '#define CLAUDE_BOARD_NODE "/nonexistent/node"',
  '#define CLAUDE_BOARD_DAEMON "/nonexistent/daemon.mjs"',
  '#define CLAUDE_BOARD_HOME_DIR "/nonexistent/home"',
  '#define CLAUDE_BOARD_PATH "/nonexistent/bin"',
  '#define CLAUDE_BOARD_STORE_DIR "/nonexistent/store"',
  '#define CLAUDE_BOARD_REF_ROOTS_VALUE "/nonexistent/roots"',
  '#define CLAUDE_BOARD_REPO_ROOT_VALUE "/nonexistent/repo"',
  '',
].join('\n'));

const launcherExec = path.join(workDir, 'launcher');
const haveCc = !spawnSync(ccCmd, ['--version']).error;
const build = haveCc
  ? spawnSync(ccCmd, ['-O2', '-Wall', '-Wextra', '-o', launcherExec, '-I', headerDir,
      path.join(repoRoot, 'bin', 'launcher.c'), stubNotify], { encoding: 'utf8' })
  : null;

/** Run the compiled launcher's --notify mode and read back what the filters let
 * through. Never spawns anything: the notify branch returns before main() forks. */
function notify(args) {
  const run = spawnSync(launcherExec, args, { encoding: 'utf8', timeout: 10_000 });
  const out = {};
  for (const line of (run.stdout || '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { ...out, status: run.status, stderr: run.stderr || '' };
}

const GOOD_ID = 'b_0123456789abcdef0123456789abcdef';
const PORT = 7391; // the daemon's own bound port, which every URL below is checked against

// Every one of these is a URL the daemon itself can build (src/server.mjs boardUrl()
// reflects the Host header, and isLoopbackHost there admits all four host forms), plus
// the `#open-round` sentinel src/indexpage.mjs already appends to a live row's href.
// Paired with the port the daemon would have been listening on when it built it.
const ACCEPTED = [
  // The one the daemon actually sends (src/stranded.mjs's announce), first because a
  // fixture list that never carries the shipping fragment proves the filter against
  // everything except the traffic.
  [`http://localhost:7391/b/${GOOD_ID}#stranded-round`, PORT],
  [`http://localhost:7391/b/${GOOD_ID}#open-round`, PORT],
  [`http://localhost:7391/b/${GOOD_ID}`, PORT],
  [`http://127.0.0.1:7391/b/${GOOD_ID}#open-round`, PORT],
  [`http://[::1]:7391/b/${GOOD_ID}#open-round`, PORT],
  [`http://board.localhost:7391/b/${GOOD_ID}#open-round`, PORT],
  [`http://localhost/b/${GOOD_ID}`, 80], // no port: the Host header carries none on port 80
  [`http://LOCALHOST:7391/b/${GOOD_ID}`, PORT], // Host is case-insensitive, and so is the check
  [`http://Board.LocalHost:7391/b/${GOOD_ID}`, PORT],
];

const REFUSED = [
  // Wrong scheme: LaunchServices resolves all of these, which is the point.
  [`https://localhost:7391/b/${GOOD_ID}`, PORT, 'https is not what this daemon serves'],
  ['file:///etc/passwd', PORT, 'a file URL must never reach the opener'],
  ['javascript:alert(1)', PORT, 'nor a javascript URL'],
  [`HTTP://localhost:7391/b/${GOOD_ID}`, PORT, 'the scheme this daemon emits is lowercase; tolerance here buys nothing'],
  [`http://localhost:7391/B/${GOOD_ID}`, PORT, 'and so is the path it serves boards on'],
  // Wrong host: the rebinding-shaped names src/server.mjs was tightened for.
  [`http://evil.com/b/${GOOD_ID}`, 80, 'a remote host is not this daemon'],
  [`http://localhost.evil.com/b/${GOOD_ID}`, 80, 'a prefix match on localhost is somebody else\'s domain'],
  [`http://[::1].evil.com/b/${GOOD_ID}`, 80, 'everything after ] must be a port or nothing'],
  [`http://user@localhost/b/${GOOD_ID}`, 80, 'userinfo makes the real host the part after @'],
  [`http://localhost:99999999/b/${GOOD_ID}`, PORT, 'a port that is not a port'],
  [`http://localhost:/b/${GOOD_ID}`, PORT, 'an empty port'],
  // The wrong port on the right host: loopback is shared by everything on this machine,
  // so this is the one that turns a genuine banner into somebody else's page.
  [`http://localhost:7392/b/${GOOD_ID}#open-round`, PORT, 'another loopback service is not this daemon'],
  [`http://127.0.0.1:1/b/${GOOD_ID}`, PORT, 'nor is a privileged port on the same host'],
  [`http://localhost/b/${GOOD_ID}`, PORT, 'an absent port means 80, not "whatever the daemon bound"'],
  [`http://localhost:7391/b/${GOOD_ID}`, 80, 'and the comparison runs the other way too'],
  // Wrong path: everything the daemon serves that is not a board page.
  [`http://localhost:7391/auth/${'a'.repeat(64)}`, PORT,
    'AC 13: a handoff URL carries a credential and must never be on a command line'],
  ['http://localhost:7391/api/health', PORT, 'not a board page'],
  ['http://localhost:7391/b/', PORT, 'no board id at all'],
  ['http://localhost:7391/b/../../etc/passwd', PORT, 'traversal'],
  [`http://localhost:7391/b/${GOOD_ID}?next=http://evil.com`, PORT, 'a query string is not part of a board URL'],
  [`http://localhost:7391/b/${GOOD_ID}/extra`, PORT, 'one path segment under /b/, not two'],
  // Shape: bytes that only appear when someone is trying something.
  [`http://localhost:7391/b/${GOOD_ID}#open round`, PORT, 'a space in a URL'],
  [`http://localhost:7391/b/${GOOD_ID}#`, PORT, 'an empty fragment'],
  [`http://localhost:7391/b/${GOOD_ID}" ; open -a Calculator`, PORT, 'shell metacharacters'],
  [`http://localhost:7391/b/${'a'.repeat(300)}`, PORT, 'over the length bound'],
  ['', PORT, 'the empty string'],
];

async function main() {
  if (!haveCc) {
    console.log(`==> skipping the compiled-C half of check-notify-click.mjs: no C compiler ('${ccCmd}')`);
  } else {
    await check('bin/launcher.c compiles clean with the URL filter in it (same flags install.sh uses, plus -Wextra)', async () => {
      assert.equal(build.status, 0, `stdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
      assert.equal((build.stderr || '').trim(), '', `unexpected compiler warning:\n${build.stderr}`);
      assert.ok(existsSync(launcherExec));
    });
    chmodSync(launcherExec, 0o755);

    await check('AC 12: a board URL of this daemon reaches the notifier whole, fragment included', async () => {
      for (const [url, port] of ACCEPTED) {
        const out = notify(['--notify', 'round', 'my-project', url, String(port)]);
        assert.equal(out.url, url, `must be accepted and passed through byte for byte: ${url}`);
        assert.equal(out.body, 'my-project: a round is waiting.', 'and the banner is unchanged by there being a click');
        assert.equal(out.title, 'Board');
      }
    });

    await check('AC 14: a URL that is not a board URL for this daemon, on this port, is not opened', async () => {
      for (const [url, port, why] of REFUSED) {
        const out = notify(['--notify', 'round', 'my-project', url, String(port)]);
        assert.equal(out.url, '(null)', `${why}: ${JSON.stringify(url)} must not reach the notifier`);
        // Refused, not rejected: the banner is the point, the click is the extra.
        assert.equal(out.body, 'my-project: a round is waiting.',
          'a URL the filter refuses must cost the click and nothing else -- the banner still fires');
        assert.equal(out.status, 0);
      }
    });

    await check('the port is required, and a port that is not a port refuses every URL', async () => {
      const url = `http://localhost:7391/b/${GOOD_ID}#open-round`;
      assert.equal(notify(['--notify', 'round', 'my-project', url]).url, '(null)',
        'no port argument at all means no click: there would be nothing to check the URL against');
      for (const junk of ['', '0', '-1', '65536', '99999', 'abc', '73 91', '7391x', '007391 ']) {
        assert.equal(notify(['--notify', 'round', 'my-project', url, junk]).url, '(null)',
          `a malformed port (${JSON.stringify(junk)}) must cost the click, not skip the check`);
      }
      assert.equal(notify(['--notify', 'round', 'my-project', url, '07391']).url, url,
        'a leading zero is still the same port number, and the daemon does not write one');
    });

    await check('a click target and an unsafe folder name are independent: either can degrade without the other', async () => {
      const url = `http://localhost:7391/b/${GOOD_ID}#open-round`;
      const out = notify(['--notify', 'round', 'bad; name', url, String(PORT)]);
      assert.equal(out.body, 'A round is waiting.', 'the unnamed sentence');
      assert.equal(out.url, url, 'and the click survives it');
      const empty = notify(['--notify', 'round', '', url, String(PORT)]);
      assert.equal(empty.body, 'A round is waiting.',
        'the empty-string placeholder src/notify.mjs sends when it has no folder but does have a URL');
      assert.equal(empty.url, url);
    });

    await check('AC 15 (this ticket\'s half): the lifetime is bounded, clamped and defaulted, never absent', async () => {
      const url = `http://localhost:7391/b/${GOOD_ID}`;
      const p = String(PORT);
      assert.equal(notify(['--notify', 'round', 'p', url, p, '60']).seconds, '60', 'a plain lifetime crosses as sent');
      assert.equal(notify(['--notify', 'round', 'p', url, p]).seconds, '2400',
        'absent falls back to the compiled-in default (the 40 minutes ADR.md entry 47 fixes a wait at), never to forever');
      assert.equal(notify(['--notify', 'round', 'p', url, p, '99999']).seconds, '3600', 'clamped to the cap');
      assert.equal(notify(['--notify', 'round', 'p', url, p, '0']).seconds, '1', 'a zero lifetime still runs the exit path once');
      for (const junk of ['abc', '-5', '12x', '999999', '']) {
        assert.equal(notify(['--notify', 'round', 'p', url, p, junk]).seconds, '2400',
          `an unparseable lifetime (${JSON.stringify(junk)}) falls back rather than becoming an unbounded process`);
      }
    });

    await check('a pomodoro banner has no click: the URL slot belongs to the format row alone', async () => {
      const url = `http://localhost:7391/b/${GOOD_ID}`;
      // argv[3] is a cue for a fixed-message row, so this passes a real cue and then the
      // same URL and port a round row would accept.
      const out = notify(['--notify', 'work', 'Glass', url, String(PORT)]);
      assert.equal(out.body, 'Work interval started');
      assert.equal(out.cue, 'Glass');
      assert.equal(out.url, '(null)', 'a boundary is an event, not a place: nothing for a click to open');
      assert.equal(out.default_sound, '0', 'and the cue picker still owns its sound');
    });
  }

  // The two filters are hand-mirrored, so the only thing that keeps them honest is
  // running both against one table. A whole-pattern /i on the JS side once made it
  // accept `HTTP://` and `/B/` where the C refuses -- invisible, because nothing ran the
  // JS half against the C half's own must-refuse list. Now it does.
  await check('the JS mirror agrees with the compiled C on every URL in both tables', async () => {
    const { isBoardUrl } = await import('../src/notify.mjs');
    for (const [url, port] of ACCEPTED) {
      assert.equal(isBoardUrl(url, port), true, `JS must accept what C accepts: ${url} on ${port}`);
    }
    for (const [url, port, why] of REFUSED) {
      assert.equal(isBoardUrl(url, port), false, `JS must refuse what C refuses (${why}): ${url} on ${port}`);
    }
    // The port argument itself, which has no C-side table above because it arrives there
    // as a string through parse_port.
    for (const port of [null, undefined, 0, -1, 65536, 1.5, NaN, '7391', {}]) {
      assert.equal(isBoardUrl(`http://localhost:7391/b/${GOOD_ID}`, port), false,
        `a port that is not an integer port must refuse: ${JSON.stringify(port)}`);
    }
  });

  // --- What src/notify.mjs sends -----------------------------------------------------

  const STUB_LAUNCHER = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_LAUNCHER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

  const stubDir = path.join(workDir, 'bin');
  mkdirSync(stubDir, { recursive: true });
  const osascriptStub = path.join(stubDir, 'osascript');
  writeFileSync(osascriptStub, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_OSASCRIPT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
  chmodSync(osascriptStub, 0o755);

  let bundleCounter = 0;
  async function inFakeBundle() {
    bundleCounter++;
    const name = `claude-board-click-${bundleCounter}`;
    const appDir = path.join(workDir, `${name}.app`);
    mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(path.join(appDir, 'Contents', 'Resources', 'src'), { recursive: true });
    const exec = path.join(appDir, 'Contents', 'MacOS', name);
    writeFileSync(exec, STUB_LAUNCHER);
    chmodSync(exec, 0o755);
    const modPath = path.join(appDir, 'Contents', 'Resources', 'src', 'notify.mjs');
    writeFileSync(modPath, readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8'));
    writeFileSync(
      path.join(appDir, 'Contents', 'Resources', 'src', 'cues.mjs'),
      readFileSync(path.join(repoRoot, 'src', 'cues.mjs'), 'utf8'),
    );
    const log = path.join(workDir, `launcher-${bundleCounter}.log`);
    return { mod: await import(`file://${modPath}`), log };
  }

  function readLines(logPath) {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  async function waitForLines(logPath, count, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (readLines(logPath).length >= count) break;
      await new Promise(r => setTimeout(r, 20));
    }
    return readLines(logPath);
  }

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

  // The sentinel is `#stranded-round`, not `#open-round`: a banner's click has to land
  // on the OLDEST round still waiting (criterion 12), where `#open-round` resolves to
  // the newest open one and belongs to the index's live-row links.
  const BOARD = `http://localhost:${PORT}/b/${GOOD_ID}#stranded-round`;

  await check('the daemon\'s URL, port and deadline cross as the three argv slots after the folder', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      mod.notifyRound('my-project', { url: BOARD, port: PORT, deadlineAt: Date.now() + 600_000 });
      const lines = await waitForLines(log, 1);
      assert.deepEqual(lines[0], ['--notify', 'round', 'my-project', BOARD, '7391', '600'],
        'folder, then click target, then the port that target must name, then the seconds left on the round\'s wait');
    });
  });

  await check('a URL with no port beside it never becomes a click', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      mod.notifyRound('my-project', { url: BOARD });
      mod.notifyRound('my-project', { url: BOARD, port: 7392 });
      mod.notifyRound('my-project', { url: BOARD, port: '7391' });
      const lines = await waitForLines(log, 3);
      for (const line of lines) {
        assert.deepEqual(line, ['--notify', 'round', 'my-project'],
          'the daemon must name the port it actually bound, as a number, or the banner is simply not clickable');
      }
    });
  });

  await check('a folder the filter refuses still carries the click, in the slot the launcher reads by position', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      mod.notifyRound(null, { url: BOARD, port: PORT, deadlineAt: Date.now() + 60_000 });
      mod.notifyRound('bad; name', { url: BOARD, port: PORT, deadlineAt: Date.now() + 60_000 });
      const lines = await waitForLines(log, 2);
      for (const line of lines) {
        assert.deepEqual(line, ['--notify', 'round', '', BOARD, String(PORT), '60'],
          'an empty placeholder, which is what the C filter refuses into the unnamed sentence');
      }
    });
  });

  await check('AC 13: a handoff URL is refused before it can become an argv entry', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      for (const url of [
        `http://localhost:7391/auth/${'a'.repeat(64)}`,
        `http://evil.com/b/${GOOD_ID}`,
        'javascript:alert(1)',
        null,
      ]) {
        mod.notifyRound('my-project', { url, port: PORT, deadlineAt: Date.now() + 60_000 });
      }
      const lines = await waitForLines(log, 4);
      assert.equal(lines.length, 4, 'the banner still fires for every one of them');
      for (const line of lines) {
        assert.deepEqual(line, ['--notify', 'round', 'my-project'],
          'no URL slot at all -- and no credential anywhere on the command line');
      }
    });
  });

  await check('a click with no bound to give it is no click at all -- not one the launcher will default', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      mod.notifyRound('my-project', { url: BOARD, port: PORT, deadlineAt: Date.now() - 60_000 }); // lapsed
      mod.notifyRound('my-project', { url: BOARD, port: PORT });                                  // no deadline at all
      mod.notifyRound('my-project', { url: BOARD, deadlineAt: Date.now() + 60_000 });             // no bound port
      const lines = await waitForLines(log, 3);
      for (const line of lines) {
        assert.deepEqual(line, ['--notify', 'round', 'my-project'],
          'the URL, the port and the lifetime cross together or not at all');
      }
    });
  });

  // Why that matters, recorded here rather than asserted: an omitted lifetime is not "no
  // click", it is the launcher's own compiled-in default (the `click_seconds_from(NULL)`
  // row in the lifetime table above proves the C side of it). `roundIsAwaitedOpen` reads
  // `status` and `awaited` only, and `closeLapsedAwaitedRounds` can sweep only a deadline
  // it can parse -- so a round with an unparseable `awaitDeadline` is awaited forever, and
  // omitting the slot bought it a forty-minute clickable banner with no bound at all.

  await check('a bare notifyRound(folder) is unchanged -- ticket 01\'s caller keeps working', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      mod.notifyRound('my-project');
      const lines = await waitForLines(log, 1);
      assert.deepEqual(lines[0], ['--notify', 'round', 'my-project']);
    });
  });

  await check('AC 15: the caller is handed the process, so it can kill it before the deadline does', async () => {
    const { mod, log } = await inFakeBundle();
    await withStubEnv({ STUB_LAUNCHER_LOG: log, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      const child = mod.notifyRound('my-project', { url: BOARD, port: PORT, deadlineAt: Date.now() + 600_000 });
      assert.ok(child && typeof child.pid === 'number' && child.pid > 0,
        'notifyRound must return the ChildProcess the daemon owns');
      assert.equal(typeof child.kill, 'function');
      child.kill('SIGTERM');
      await waitForLines(log, 1);
    });
  });

  await check('the osascript install keeps its unclickable banner (AC 19) and never sees a URL', async () => {
    const osaLog = path.join(workDir, 'osascript.log');
    const { notifyRound } = await import('../src/notify.mjs'); // from the clone: APP_EXEC is null
    await withStubEnv({ STUB_OSASCRIPT_LOG: osaLog, PATH: `${stubDir}:${process.env.PATH}` }, async () => {
      notifyRound('my-project', { url: BOARD, port: PORT, deadlineAt: Date.now() + 600_000 });
      const lines = await waitForLines(osaLog, 1);
      assert.equal(lines.length, 1, 'the banner still fires with no bundle to serve a click');
      assert.equal(lines[0][1], 'display notification "my-project: a round is waiting." with title "Board"');
      assert.doesNotMatch(lines[0][1], /localhost|b_/, 'and the URL reaches no script string');
    });
  });

  // --- Structural: the parts of the click no check here can exercise -----------------
  //
  // Nothing in this suite can post a real notification or click one, so these hold the
  // pieces ADR.md entry 57 names in place. Regexes, deliberately narrow, so that a
  // deletion is what fails them rather than a rewording.

  await check('bin/notify.m carries the category, the delegate, the withdrawal and the signal handling', async () => {
    const m = readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8');
    assert.match(m, /UNNotificationCategory/, 'an action category, per ADR.md entry 57');
    // Pinned as source-level reality, not as something the fix depends on: ADR.md entry
    // 75 is what stops the -600 alert (the bundle's LSUIElement, checked in
    // test/check-install.mjs), not this option. The option may ride along -- dropping it
    // is not the fix either -- but nothing here or in install.sh may come to rely on it,
    // so this only pins that the action still asks to come to the foreground; it asserts
    // no behaviour beyond the string being present.
    assert.match(m, /UNNotificationActionOptionForeground/,
      'the click action asks to bring the app forward -- LSUIElement is what lets that succeed');
    assert.match(m, /UNUserNotificationCenterDelegate/, 'and a delegate to receive the click');
    assert.match(m, /center\.delegate\s*=\s*delegate/, 'set on the center before the post');
    assert.match(m, /removeDeliveredNotificationsWithIdentifiers/,
      'the process withdraws its OWN delivered notification');
    assert.match(m, /removePendingNotificationRequestsWithIdentifiers/,
      'pending as well as delivered -- a request accepted but not yet on screen is what a stop mid-post leaves behind');
    assert.doesNotMatch(m, /removeAllDeliveredNotifications/,
      'and only its own -- a blanket withdrawal would take out an unread pomodoro banner');
    // The withdrawal is a pair of passes around a flush, because the withdrawal races
    // the delivery. Spelled out at each exit path, one of them got half of it and the
    // race stayed open on the path most likely to hit it. One call site is the guard:
    // an exit path cannot compose its own half of a sequence that exists in one place.
    assert.equal((m.match(/removeDeliveredNotificationsWithIdentifiers/g) || []).length, 1,
      'exactly one withdrawal call site, so no exit path can withdraw once and return');
    assert.match(m, /return stop_requested \? 0 : failed;/,
      'a stop the daemon asked for exits 0: reported as a failure it would burn src/notify.mjs\'s one-shot warning on a healthy path');
    assert.match(m, /SIGTERM/, 'the signal the daemon kills it with (AC 15)');
    assert.match(m, /sigaction/, 'installed, not left at its default disposition');
    assert.match(m, /NSWorkspace/, 'and the click opens the URL through LaunchServices');
  });

  await check('the launcher links AppKit, without which the delegate above is never called', async () => {
    const sh = readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
    assert.match(sh, /-framework Foundation -framework UserNotifications -framework AppKit/,
      'install.sh builds the shipped binary; a missing framework here is a link error at install time');
  });

  await check('the board-URL pattern lives in C, beside the other two argv filters, and there is exactly one of it', async () => {
    const c = readFileSync(path.join(repoRoot, 'bin', 'launcher.c'), 'utf8');
    // Not `static`, as of the menu bar item: the popover's rows open a board URL too,
    // over a URL read from GET /api/waiting rather than from argv, and they call THIS
    // function to decide whether they may. The `cb_` prefix is what the other cross-file
    // symbols in this binary carry (cb_notify, cb_menubar).
    assert.match(c, /^int cb_is_board_url\(/m, 'the pattern is checked in C (ADR.md entry 57)');
    assert.match(c, /is_safe_cue_name/, 'beside the cue filter');
    assert.match(c, /is_safe_folder_name/, 'and the folder filter');
    // One definition, and no second opinion in Objective-C: two scanners for "is this a
    // board URL" would drift the first time either was tightened, and the one that drifted
    // would be the one that hands a URL to LaunchServices.
    const m = readFileSync(path.join(repoRoot, 'bin', 'menubar.m'), 'utf8');
    assert.match(m, /extern int cb_is_board_url\(/, 'the menu bar client declares it rather than reimplementing it');
    assert.ok(!/^int cb_is_board_url\(/m.test(m), 'and does not define a second one');
  });

  rmSync(workDir, { recursive: true, force: true });

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all check-notify-click checks ok');
}

await main();
