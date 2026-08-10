// Binds INSTALL.md's session-start hook prose to the mechanism it describes.
//
// The original suggestion was to bind this with src/prose-check.mjs --
// wrong tool: that module binds prose to the MCP shim's live `tools/list` schema
// (getLiveTools / toolName 'ask' / inputSchema.properties) and has no way to express
// "this shell command hits this HTTP route". Instead this check extracts the ACTUAL
// hook JSON out of INSTALL.md's fenced code block and runs the ACTUAL command against
// a real in-process daemon -- so the document is the single source of truth, and a
// snippet edited in prose is the snippet under test.
//
// Never touches ~/.config/claude-board/secret or the real CLAUDE_BOARD_HOME: the
// daemon here runs against a temp home with a temp secret (see QUIRKS.md "Every read
// is gated, so every HTTP check needs a credential"), and the extracted command is run
// with HOME overridden to a second temp directory holding a matching secret file at
// $HOME/.config/claude-board/secret -- the exact path the command itself reads. Uses
// promisify(execFile), never execFileSync (QUIRKS.md "execFileSync deadlocks against
// an in-process daemon") -- although the command backgrounds and detaches on its own,
// so this would likely be safe either way; async is what the rest of the suite does
// and costs nothing here.
//
// That install.sh never reads or writes ~/.claude/settings.json is already
// proved twice in test/check-install.mjs ("mention settings.json only in a comment or
// an echo" and the byte-identical-survival run) -- not duplicated here.
//
// The unattended-session marker (ADR.md entry 68) is bound here for the same reason the
// route is: the guard is a fragment of the shell command itself, so the only honest way
// to check it is to run the documented command with and without
// CLAUDE_BOARD_NO_POMODORO in its environment. Note that runHookAgainstPort STRIPS that
// variable from the inherited environment rather than merely not setting it -- the whole
// point of the marker is that a session can carry it, so a suite run from inside such a
// session would otherwise watch every "starts a work interval" check below pass by doing
// nothing at all.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import { DEFAULT_PORT } from '../src/handoff.mjs';
import { readDoc as readPomodoroDoc, writeDoc as writePomodoroDoc } from '../src/pomodoro.mjs';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installMdPath = path.join(repoRoot, 'INSTALL.md');

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

/** Pull every ```json fenced block out of INSTALL.md and return the one shaped like a
 * settings.json hook entry with the ensure route in it. Anything else in the file --
 * the ```jsonc before/after settings.json illustrations, the ```sh readable form --
 * uses a different fence language and is never a candidate. */
function extractHookEntry(markdown) {
  const fenceRe = /```json\n([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(markdown))) {
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (parsed && parsed.type === 'command' && typeof parsed.command === 'string' && parsed.command.includes('pomodoro/ensure')) {
      return parsed;
    }
  }
  return null;
}

/** An address with nothing listening on it, for the "daemon is down" case. Bind to
 * port 0 to get a free ephemeral port from the OS, then close immediately -- a small
 * window where something else could grab it before the check runs, same tradeoff
 * every "closed port" test at this scale accepts. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs, intervalMs }) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// --- fixtures ---------------------------------------------------------------------

const daemonHome = mkdtempSync(path.join(tmpdir(), 'claude-board-installdoc-home-'));
// A SEPARATE temp dir stands in for $HOME when running the extracted command: the
// command hardcodes "$HOME/.config/claude-board/secret" (it has no
// CLAUDE_BOARD_SECRET_FILE seam of its own -- that env var is a Node-side testing
// seam, see src/secret.mjs), so the daemon's own CLAUDE_BOARD_SECRET_FILE is pointed
// at that exact path rather than the real ~/.config/claude-board/secret.
const childHome = mkdtempSync(path.join(tmpdir(), 'claude-board-installdoc-childhome-'));
const secretDir = path.join(childHome, '.config', 'claude-board');
mkdirSync(secretDir, { recursive: true });
const SECRET = 'e'.repeat(64);
const secretFile = path.join(secretDir, 'secret');
writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });

process.env.CLAUDE_BOARD_HOME = daemonHome;
process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;

let server, port;

function runHookAgainstPort(targetPort, extraEnv) {
  // CLAUDE_BOARD_NO_POMODORO is dropped out of the inherited environment here (see the
  // header): a check that means "the hook starts an interval" must not be satisfiable by
  // the hook standing down. Anything wanting it back passes it in extraEnv.
  const { CLAUDE_BOARD_NO_POMODORO: _unattended, ...inherited } = process.env;
  return execFileP('bash', ['-c', hookEntry.command], {
    env: { ...inherited, HOME: childHome, CLAUDE_BOARD_PORT: String(targetPort), ...extraEnv },
    timeout: 5000,
  });
}

async function pomodoroDoc() {
  const r = await fetch(`http://127.0.0.1:${port}/api/pomodoro`, { headers: { [SECRET_HEADER]: SECRET } });
  assert.equal(r.status, 200, 'GET /api/pomodoro must succeed for the check\'s own authenticated client');
  return r.json();
}

let hookEntry;

async function main() {
  const markdown = readFileSync(installMdPath, 'utf8');
  hookEntry = extractHookEntry(markdown);

  await check('INSTALL.md contains a fenced ```json hook entry with the documented shape', async () => {
    assert.ok(hookEntry, 'INSTALL.md must have a ```json fenced block parsing to { type: "command", command } naming pomodoro/ensure');
    assert.equal(hookEntry.type, 'command', 'Claude Code SessionStart hooks are type "command"');
    assert.equal(typeof hookEntry.command, 'string');
    assert.ok(hookEntry.command.includes(SECRET_HEADER), 'must carry the secret in the header src/secret.mjs actually defines (SECRET_HEADER), not a hand-typed string that could drift from it');
    assert.ok(hookEntry.command.includes('/api/pomodoro/ensure'), 'must call ensure, never pause/resume/reset/settings -- those take the cookie, not the secret, and this is a shell script');
    assert.ok(hookEntry.command.includes('CLAUDE_BOARD_PORT'), 'must respect a CLAUDE_BOARD_PORT override');
    assert.ok(hookEntry.command.includes(String(DEFAULT_PORT)), 'the fallback port must be src/handoff.mjs DEFAULT_PORT (7391), not a value that could drift from it');
    assert.ok(hookEntry.command.includes('CLAUDE_BOARD_NO_POMODORO'), 'must carry the unattended-session guard (ADR.md entry 68) -- the crontab lines that set it are hand-written against this exact spelling, so a rename here silently un-guards them');
  });

  ({ server, port } = await startServer({ home: daemonHome, port: 0 }));

  await check('the extracted hook, run against a live daemon with no timer, starts a work interval', async () => {
    const before = await pomodoroDoc();
    assert.equal(before.timer, null, 'fixture daemon must start with no timer at all');

    const { stdout, stderr } = await runHookAgainstPort(port);
    assert.equal(stdout, '', 'the hook must print nothing on stdout -- SessionStart stdout can become additionalContext fed back into the session');
    assert.equal(stderr, '', 'the hook must print nothing on stderr either');

    const doc = await waitFor(async () => {
      const d = await pomodoroDoc();
      return d.timer ? d : null;
    }, { timeoutMs: 3000, intervalMs: 50 });
    assert.ok(doc, 'a work interval must exist after the hook runs (the request is backgrounded, so this polls rather than asserting immediately)');
    assert.equal(doc.timer.phase, 'work');
    assert.equal(doc.timer.paused, false);
    assert.ok(Number.isFinite(doc.timer.deadline) && doc.timer.deadline > Date.now(), 'the deadline must be a real point in the future');
  });

  await check('running the hook again against the running timer leaves its deadline unchanged to the millisecond (a second session, a /clear, a resume)', async () => {
    const before = await pomodoroDoc();
    assert.ok(before.timer, 'must already be running, from the previous check');
    const deadlineBefore = before.timer.deadline;

    const { stdout, stderr } = await runHookAgainstPort(port);
    assert.equal(stdout, '');
    assert.equal(stderr, '');

    // Settle-then-sample, not a single read right after spawn returns: the request is
    // fire-and-forget (that's the whole point -- see INSTALL.md), so the wrapping
    // command returns before curl has necessarily even connected. Sampling repeatedly
    // across a window long enough for a loopback request to land, and asserting the
    // deadline never moves at ANY sample, is what actually proves "no-op" rather than
    // "hadn't happened yet when I looked".
    const start = Date.now();
    let samples = 0;
    while (Date.now() - start < 1000) {
      const doc = await pomodoroDoc();
      assert.equal(doc.timer.deadline, deadlineBefore, 'ensure against a running timer must be a true no-op');
      samples++;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(samples >= 5, 'sanity: the sampling window must actually have sampled more than once');
  });

  await check('running the hook against a mid-break timer leaves the break deadline untouched (does not cut the break short)', async () => {
    // Seeded directly, the same ARRANGE-only pattern test/check-http.mjs uses for this
    // exact fixture state (a real work interval reaching a break naturally takes up to
    // workMin minutes) -- every ASSERTION below still goes through the HTTP route via
    // the extracted hook and pomodoroDoc(), never readPomodoroDoc/writePomodoroDoc.
    const current = readPomodoroDoc(daemonHome);
    const breakDeadline = Date.now() + 4 * 60_000;
    writePomodoroDoc({ ...current, timer: { phase: 'break', paused: false, deadline: breakDeadline } }, daemonHome);

    const { stdout, stderr } = await runHookAgainstPort(port);
    assert.equal(stdout, '');
    assert.equal(stderr, '');

    const start = Date.now();
    while (Date.now() - start < 1000) {
      const doc = await pomodoroDoc();
      assert.equal(doc.timer.phase, 'break', 'starting mid-break must not switch the phase to work');
      assert.equal(doc.timer.deadline, breakDeadline, 'the break deadline must be untouched, to the millisecond');
      await new Promise(r => setTimeout(r, 50));
    }
  });

  await check('running the hook with nothing listening on the port still exits 0 and prints nothing (the property that protects the editor)', async () => {
    const deadPort = await closedPort();
    const startedAt = Date.now();
    const { stdout, stderr } = await runHookAgainstPort(deadPort);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(stdout, '', 'must print nothing on stdout even with nothing listening');
    assert.equal(stderr, '', 'must print nothing on stderr even with nothing listening');
    assert.ok(elapsedMs < 1500, `the wrapping command must return almost immediately, because it backgrounds and detaches the request rather than waiting on it (took ${elapsedMs}ms)`);
  });

  await check('running the hook with no secret file at all still exits 0 and prints nothing', async () => {
    // A distinct HOME with no ~/.config/claude-board/secret whatsoever -- the "missing
    // secret file" case, separate from "wrong secret" and separate from "nothing
    // listening" above. Routed through runHookAgainstPort for its env strip, with HOME
    // overridden on top of the helper's own: this case is about the missing file, and it
    // would read as passing for the wrong reason if an inherited marker made the command
    // exit before it ever looked for one.
    const noSecretHome = mkdtempSync(path.join(tmpdir(), 'claude-board-installdoc-nosecret-'));
    try {
      const { stdout, stderr } = await runHookAgainstPort(port, { HOME: noSecretHome });
      assert.equal(stdout, '');
      assert.equal(stderr, '');
    } finally {
      rmSync(noSecretHome, { recursive: true, force: true });
    }
  });

  // Criteria 9 and 10 (SPEC_ROLLOVER.md) as a matched pair: same command, same arranged
  // state, one environment variable between them. Both arrange a document with NO timer,
  // because that is the only state in which an unguarded hook provably writes -- against
  // a running or a mid-break timer `ensure` is already a no-op (the two checks above), so
  // "nothing moved" there would stay green with the guard deleted outright.
  const pomodoroFile = path.join(daemonHome, 'pomodoro.json');

  await check('criterion 9: the documented hook, run with CLAUDE_BOARD_NO_POMODORO set, leaves pomodoro.json byte-identical', async () => {
    writePomodoroDoc({ ...readPomodoroDoc(daemonHome), timer: null }, daemonHome);
    const before = readFileSync(pomodoroFile);

    const { stdout, stderr } = await runHookAgainstPort(port, { CLAUDE_BOARD_NO_POMODORO: '1' });
    assert.equal(stdout, '', 'an early exit that echoes anything is still stdout SessionStart turns into additionalContext');
    assert.equal(stderr, '');

    // Settle-then-sample, for the same reason as the no-op check above: the command
    // backgrounds and detaches, so a single read taken the instant bash returns is green
    // whether the guard exists or not. Compared as BYTES, and read straight off disk
    // rather than through GET /api/pomodoro -- the criterion is that no part of the
    // document moved, settings and cycle included, and a read through the daemon is
    // itself a chance for something to rewrite the file.
    const start = Date.now();
    let samples = 0;
    while (Date.now() - start < 1000) {
      const now = readFileSync(pomodoroFile);
      assert.ok(now.equals(before), `an unattended session must leave pomodoro.json byte-identical; it became:\n${now}`);
      samples++;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(samples >= 5, 'sanity: the sampling window must actually have sampled more than once');
  });

  await check('criterion 10: the same command with the variable unset starts a work interval, exactly as it does today', async () => {
    writePomodoroDoc({ ...readPomodoroDoc(daemonHome), timer: null }, daemonHome);
    const before = await pomodoroDoc();
    assert.equal(before.timer, null, 'the arrangement must be criterion 9\'s to the field, so that the variable is the only difference');

    const { stdout, stderr } = await runHookAgainstPort(port);
    assert.equal(stdout, '');
    assert.equal(stderr, '');

    const doc = await waitFor(async () => {
      const d = await pomodoroDoc();
      return d.timer ? d : null;
    }, { timeoutMs: 3000, intervalMs: 50 });
    assert.ok(doc, 'the guard must cost an ordinary session nothing -- without the marker the hook starts an interval as it always did');
    assert.equal(doc.timer.phase, 'work');
    assert.equal(doc.timer.paused, false);
    assert.ok(Number.isFinite(doc.timer.deadline) && doc.timer.deadline > Date.now(), 'the deadline must be a real point in the future');
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(daemonHome, { recursive: true, force: true });
    rmSync(childHome, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall install-doc checks ok');
  });
