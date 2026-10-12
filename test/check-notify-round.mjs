// The notification path generalised from "pomodoro boundary" to "the product's
// notifications" (ADR.md entry 58). This file covers the row shape and the
// folder-name filter: each MESSAGES row in src/notify.mjs (and its mirror in
// bin/launcher.c) now carries its own title, and a new 'round' row formats a project
// folder name behind a strict character filter, degrading to an unnamed sentence when
// the name is missing or unsafe (ADR.md entry 56) rather than losing the banner.
//
// The daemon now calls notifyRound on its own, from the stranded rule
// (createStrandedWatch, src/stranded.mjs) -- that path is test/check-stranded.mjs's to
// cover end to end. This file stays scoped to the message shape and the folder-name
// filter, so every check here still calls notifyRound directly, the same way
// test/check-notify.mjs's checks call notifyBoundary/notifyTest directly.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE, exactly as check-notify.mjs states
// of itself: osascript and the bundle executable are both stubs on PATH here too, never
// the real binaries.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { notifyBoundary, notifyRound } from '../src/notify.mjs';
import {
  check, runMain, repoRoot, writeStub, STUB_OSASCRIPT, readJsonLines, freshLog, sleep, waitForCount, withStubOnPath,
} from './support.mjs';

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-notify-round-check-'));

const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', STUB_OSASCRIPT);

// The bundled path (ADR.md entry 19), same staging trick check-notify.mjs uses: a copy
// of src/notify.mjs (plus cues.mjs, its one relative import) dropped into a fake
// Contents/Resources/src next to a stub Contents/MacOS/<name>, so APP_EXEC resolves and
// what is under test is the shipped derivation, not a restatement of it.
async function importFromFakeBundle(name, launcherSource) {
  const appDir = path.join(workDir, `${name}.app`);
  mkdirSync(path.join(appDir, 'Contents', 'Resources', 'src'), { recursive: true });
  const exec = writeStub(path.join(appDir, 'Contents', 'MacOS'), name, launcherSource);
  const modPath = path.join(appDir, 'Contents', 'Resources', 'src', 'notify.mjs');
  writeFileSync(modPath, readFileSync(path.join(repoRoot, 'src', 'notify.mjs'), 'utf8'));
  writeFileSync(
    path.join(appDir, 'Contents', 'Resources', 'src', 'cues.mjs'),
    readFileSync(path.join(repoRoot, 'src', 'cues.mjs'), 'utf8'),
  );
  return { exec, mod: await import(`file://${modPath}`) };
}

const STUB_LAUNCHER = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_LAUNCHER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

// A stand-in for a launcher binary compiled BEFORE this ticket -- its own MESSAGES table
// (bin/launcher.c) has no 'round' row, so a phase it does not recognise gets exactly
// what main() there has always done for one: a stderr line and a nonzero exit, nothing
// written anywhere a real notification could come from. Recognised phases still behave
// exactly as they always have, so this doubles as a control.
const STUB_LAUNCHER_PREDATING = `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const OLD_PHASES = ['work', 'break', 'longBreak', 'test'];
if (argv[0] === '--notify' && OLD_PHASES.includes(argv[1])) {
  fs.appendFileSync(process.env.STUB_LAUNCHER_LOG, JSON.stringify(argv) + '\\n');
  process.exit(0);
}
process.exit(1);
`;

async function main() {
  // --- What it says (AC 10, 11) — osascript fallback, i.e. an install with no app
  // bundle (AC 19): every check in this file up to the bundle section imports
  // src/notify.mjs plain, from the clone, exactly as check-notify.mjs's own osascript
  // checks do, so APP_EXEC is null and fire() always takes the osascript branch.

  await check('a round names the session by its folder: titled Board, body "<folder>: a round is waiting."', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      notifyRound('my-project');
      const lines = await waitForCount(() => readJsonLines(log), 1);
      assert.equal(lines.length, 1, 'exactly one osascript invocation: a banner was raised (AC 19, no app bundle here)');
      const [flag, script] = lines[0];
      assert.equal(flag, '-e');
      assert.equal(
        script,
        'display notification "my-project: a round is waiting." with title "Board"',
        'AC 10: titled Board, body "<folder>: a round is waiting."',
      );
    });
  });

  await check('a missing, unsafe or over-long folder degrades to the unnamed sentence, and still raises a banner', async () => {
    for (const [folder, why] of [
      [null, 'a missing folder: the banner still fires, it just says less'],
      // Semicolons, slashes and quotes are exactly the AppleScript-interpreter-facing
      // bytes the character filter exists to keep out (ADR.md entry 56), not just a
      // convenient example -- a folder called `foo"; do shell script "rm -rf ~"` must
      // never reach the script string this file builds.
      ['foo"; do shell script "rm -rf ~"', 'an unsafe name must never reach the script -- not escaped, not truncated, just refused'],
      // src/notify.mjs's own MAX_FOLDER_NAME_LEN is 80, and a name must be shorter.
      ['a'.repeat(80), 'a name exactly at the length bound is refused'],
    ]) {
      const log = freshLog(workDir);
      await withStubOnPath(stubDir, log,{}, async () => {
        notifyRound(folder);
        const lines = await waitForCount(() => readJsonLines(log), 1);
        assert.equal(lines.length, 1, `exactly one banner: ${why}`);
        assert.equal(lines[0][1], 'display notification "A round is waiting." with title "Board"', why);
      });
    }
  });

  await check('a folder name inside the accepted set, including spaces, underscores and hyphens, crosses whole', async () => {
    const log = freshLog(workDir);
    await withStubOnPath(stubDir, log,{}, async () => {
      notifyRound('My Project_v2-final');
      const lines = await waitForCount(() => readJsonLines(log), 1);
      assert.equal(lines.length, 1);
      assert.equal(lines[0][1], 'display notification "My Project_v2-final: a round is waiting." with title "Board"');
    });
  });

  // --- Pomodoro stays exactly as it reads today (constraint: "Pomodoro banner text and
  // title must be byte-identical to today"). Byte-for-byte, not just a substring match,
  // across every phase, cueless -- the shape most likely to shift silently if the title
  // stopped being the one global constant it used to be.

  const POMODORO_MESSAGE = {
    work: 'Work interval started',
    break: 'Break started',
    longBreak: 'Long break started',
  };

  for (const phase of Object.keys(POMODORO_MESSAGE)) {
    await check(`pomodoro '${phase}' banner text and title are byte-identical to before this generalisation`, async () => {
      const log = freshLog(workDir);
      await withStubOnPath(stubDir, log,{}, async () => {
        notifyBoundary(phase, { notify: true, cueWork: 'None', cueBreak: 'None', cueLongBreak: 'None' });
        const lines = await waitForCount(() => readJsonLines(log), 1);
        assert.equal(lines.length, 1);
        const [flag, script] = lines[0];
        assert.equal(flag, '-e');
        assert.equal(
          script,
          `display notification "${POMODORO_MESSAGE[phase]}" with title "Pomodoro"`,
          'per-row titles must not have changed a single byte of what a pomodoro boundary displays',
        );
      });
    });
  }

  // --- The bundle path (AC 10, 11, 19 again, from the other install shape).

  await check('inside a bundle, a round crosses the folder as the format slot, and never osascript', async () => {
    const log = freshLog(workDir);
    const launcherLog = path.join(workDir, 'launcher-invocations-1.log');
    const { mod } = await importFromFakeBundle('claude-board-round-1', STUB_LAUNCHER);
    await withStubOnPath(stubDir, log,{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyRound('my-project');
      const lines = await waitForCount(() => readJsonLines(launcherLog), 1);
      assert.deepEqual(lines[0], ['--notify', 'round', 'my-project']);
      assert.deepEqual(readJsonLines(log), [], 'osascript must not be invoked when the bundle executable is present');
    });
  });

  await check('inside a bundle, a missing or unsafe folder crosses no third argument at all', async () => {
    const launcherLog = path.join(workDir, 'launcher-invocations-2.log');
    const { mod } = await importFromFakeBundle('claude-board-round-2', STUB_LAUNCHER);
    await withStubOnPath(stubDir, freshLog(workDir),{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
      mod.notifyRound(null);
      mod.notifyRound('bad; name');
      const lines = await waitForCount(() => readJsonLines(launcherLog), 2);
      assert.deepEqual(lines, [['--notify', 'round'], ['--notify', 'round']],
        'an absent or unsafe folder must reach the launcher exactly like a phase with no cue does -- absent, never an empty string or a sentinel');
    });
  });

  // --- AC 20: an install predating this work raises no banner, not a malformed one.

  await check('a launcher that predates the round row is sent --notify round and raises nothing, silently, while its old phases still raise', async () => {
    const launcherLog = path.join(workDir, 'launcher-invocations-4.log');
    const { mod } = await importFromFakeBundle('claude-board-round-4', STUB_LAUNCHER_PREDATING);
    let uncaught = null;
    const onUncaught = err => { uncaught = err; };
    process.on('uncaughtException', onUncaught);
    try {
      await withStubOnPath(stubDir, freshLog(workDir),{ STUB_LAUNCHER_LOG: launcherLog }, async () => {
        assert.doesNotThrow(() => mod.notifyRound('my-project'));
        // No promise to await -- give the async spawn+exit time to actually happen
        // before asserting the log stayed empty.
        await sleep(300);
        assert.deepEqual(readJsonLines(launcherLog), [],
          'an old launcher rejecting an unrecognised phase must leave no banner content anywhere, not an empty or malformed one');
        // The control that keeps the assertion above from passing on a stub that can log
        // nothing at all: a phase the old launcher already knew still reaches it.
        mod.notifyBoundary('work', { notify: true, cueWork: 'None' });
        assert.deepEqual(await waitForCount(() => readJsonLines(launcherLog), 1), [['--notify', 'work']],
          'a phase the old launcher already knew must be unaffected, and the round row must still have left nothing');
      });
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    assert.equal(uncaught, null, `a launcher rejecting --notify round must not raise: ${uncaught}`);
  });

  // --- Structural: bin/notify.m, which no check here compiles or runs. The C row it is
  // handed (title, format, folder filter) is compiled and exercised for real by
  // test/check-notify-click.mjs.

  await check('bin/notify.m composes the title from an argument, not a compiled-in constant', async () => {
    const m = readFileSync(path.join(repoRoot, 'bin', 'notify.m'), 'utf8');
    assert.doesNotMatch(m, /kTitle/, 'the old single-title constant must be gone');
    assert.match(m, /content\.title\s*=\s*\[NSString stringWithUTF8String:title\]/,
      'the title must come from the per-call argument cb_notify now takes');
  });

  rmSync(workDir, { recursive: true, force: true });
}

await runMain('check-notify-round', main, { lead: '' });
