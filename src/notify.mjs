// Native notification at each pomodoro boundary (SPEC_POMODORO.md criterion 5,
// ticket 02).
//
// Two ways out, and which one is used is decided by where THIS FILE is running from, not
// by configuration. A daemon running out of claude-board.app/Contents/Resources spawns
// the bundle's own executable in its `--notify` mode (bin/launcher.c, bin/notify.m), and
// the notification then carries claude-board's name and icon, and gets its own row in
// System Settings > Notifications where the reader can set it to Alerts so it stays on
// screen until dismissed. A daemon running out of the clone -- the no-launcher install,
// which has no bundle at all -- falls back to `osascript`, exactly as this file did
// before ADR.md entry 19, and gets Script Editor's name and icon along with it. The
// fallback is not a nicety: it is the only path a degraded install has, and it is also
// the path every check in test/check-notify.mjs takes, since the suite imports this file
// from the clone.
//
// Async only -- execFile, never execFileSync (see QUIRKS.md "execFileSync deadlocks
// against an in-process daemon"). This fires from inside src/pomodoro.mjs's own
// setTimeout callback, on the daemon's one event loop; a synchronous spawn would stall
// every other request behind however long osascript takes to start. Every failure --
// osascript missing, a non-zero exit, Notification Center itself refusing -- is
// swallowed. A reader's OS settings must never be a way to take the clock down, and
// test/check-notify.mjs calls this hundreds of times against a stub: it must never
// throw, and never actually raise a banner.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A closed-set lookup, not a template. `phase` reaches here as settleBoundary's own
// `boundary.phase` (src/pomodoro.mjs), typed 'work' | 'break' | 'longBreak' -- but that
// is a property of TODAY's one caller, not of this function's contract, and the trust
// boundary is the AppleScript interpreter on the other end of the string built below.
// Every value that can reach that string is therefore a LITERAL out of this table, never
// `phase` itself: an unrecognised phase has no entry and fires nothing, rather than
// falling back to some `` `${phase} started` `` template a future caller could shape.
// Do not add that fallback -- it is the one line that would turn this from "closed set"
// into "free text with extra steps".
const MESSAGES = {
  work: 'Work interval started',
  break: 'Break started',
  longBreak: 'Long break started',
};

// The bundle's own executable, or null when this file is not running from inside a
// bundle. Derived from import.meta.url and from nothing else -- never from an environment
// variable, and never from a path the launchd plist could name: this spawns a binary that
// holds the reader's TCC Documents grant, and bin/launcher.c exists precisely so that
// holding that grant is not the same as being able to point it at something. The layout
// it is reading is install.sh's own staging (Contents/Resources/src/notify.mjs, next to
// Contents/MacOS/<CFBundleExecutable>), so the two move together or not at all.
//
// Computed once at import rather than per boundary: it cannot change under a running
// daemon without that daemon being replaced, and a boundary should not pay an existsSync
// to re-learn it.
const APP_EXEC = (() => {
  try {
    const here = fileURLToPath(import.meta.url); // .../Contents/Resources/src/notify.mjs
    const m = here.match(/^(.*\/([^/]+)\.app)\/Contents\/Resources\/src\/notify\.mjs$/);
    if (!m) return null;
    // CFBundleExecutable is the bundle's own name, install.sh's $LABEL -- taken from the
    // .app's filename here rather than hardcoded, so a rename of the bundle cannot leave
    // this pointing at a binary that is not there.
    const exec = `${m[1]}/Contents/MacOS/${m[2]}`;
    return existsSync(exec) ? exec : null;
  } catch {
    return null; // an unreadable path is a fallback to osascript, never a throw.
  }
})();

const TITLE = 'Pomodoro';
// A name out of /System/Library/Sounds, not a file this repo ships -- criterion 14 ("no
// audio file added to the repo") holds by construction, because this string is the only
// sound-related thing notifyBoundary ever sends anywhere.
const SOUND_NAME = 'Glass';

// Logged once per process, not once per failure: a reader who has Notification Center
// blocked, or who is on a machine with no osascript at all, would otherwise get one
// stderr line per interval boundary for as long as the daemon runs.
let warnedOnce = false;

/** The execFile callback both paths share. Swallows everything -- see the file header --
 * and names neither binary, because which one ran is decided by APP_EXEC below and the
 * message would otherwise have to be duplicated to stay true. */
function warnOnFailure(err) {
  if (err && !warnedOnce) {
    warnedOnce = true;
    console.error(`notifyBoundary: notification failed, notifications may not be appearing (further failures are not logged): ${err.message}`);
  }
}

/** Quote a string for AppleScript's double-quoted string syntax. Belt-and-suspenders
 * alongside the closed-set table above -- MESSAGES's own values need no escaping today
 * -- so that a later edit widening the table does not quietly become an injection the
 * moment it does. */
function appleScriptQuote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Fire the native notification for a boundary that just happened. `phase` is the phase
 * that just STARTED (settleBoundary's own `boundary.phase`); `settings` is the pomodoro
 * document's settings, read fresh by the caller on every boundary rather than captured
 * once at daemon boot, so a toggle flipped mid-day takes effect on the very next
 * interval rather than the next restart. Never throws, never awaits the subprocess --
 * see the file header for why. */
export function notifyBoundary(phase, settings) {
  if (!settings || settings.notify === false) return;
  const message = MESSAGES[phase];
  if (!message) return; // unrecognised phase: no notification, see MESSAGES above.

  if (APP_EXEC) {
    // `phase` itself crosses here, where every other path in this file passes only
    // literals -- and it is safe for the same reason it is safe on the other side: the
    // launcher's MESSAGES table (bin/launcher.c) is a closed set too, so this argument
    // selects a sentence rather than supplying one, and an unrecognised value selects
    // nothing. It has also already been checked against this file's own MESSAGES two
    // lines above, so a phase that got here is one both tables know. No shell is
    // involved either way: execFile, not exec.
    const args = ['--notify', phase];
    if (settings.sound === true) args.push('--sound');
    execFile(APP_EXEC, args, warnOnFailure);
    return;
  }

  let script = `display notification ${appleScriptQuote(message)} with title ${appleScriptQuote(TITLE)}`;
  // settings.sound === true is the only thing that adds the clause. DEFAULT_SETTINGS
  // (src/pomodoro.mjs) ships sound: false, so anything else -- false, or absent from an
  // older document normalizeDoc hasn't back-filled -- must stay silent: erring toward
  // noise the reader never asked for is the wrong direction for a default to fail in.
  if (settings.sound === true) {
    script += ` sound name ${appleScriptQuote(SOUND_NAME)}`;
  }

  execFile('osascript', ['-e', script], warnOnFailure);
}
