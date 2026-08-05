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
import { isCue, NO_CUE } from './cues.mjs';

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
  // Not a phase the clock can ever settle on: `test` is what `notifyTest` below fires
  // when the reader ticks Notify, so that "did that do anything?" is answered by a
  // banner rather than by waiting out an interval. It lives in this table with the
  // real phases because that is what the table IS -- the closed set of sentences this
  // file can put on screen -- and adding a row is the sanctioned way to extend it. The
  // rule the header states still holds: no entry, no notification, and never a template.
  test: 'Notifications are working',
};

// Phase -> the settings key holding THAT phase's cue (src/pomodoro.mjs's cueWork/
// cueBreak/cueLongBreak, one row per phase in the settings popover -- CONTEXT.md
// "Cue", ADR.md entry 20). A closed table beside MESSAGES above, for the identical
// reason: `phase` selects which settings field to read, it is never interpolated
// into one.
const CUE_KEYS = {
  work: 'cueWork',
  break: 'cueBreak',
  longBreak: 'cueLongBreak',
};

// Unlike `phase` and the two tables above, a cue name is CALLER-SUPPLIED: it started
// life as a JSON value on disk (settings.cueWork et al.), not as a literal this file
// wrote. `isCue` (src/cues.mjs) is what keeps the same "closed set, not free text"
// property true one layer further out -- it is a set built once from
// /System/Library/Sounds and filtered through a conservative name pattern, closed by
// construction the same way MESSAGES is closed by hand. A settings value that is not
// in that set -- absent, `None`, or garbage from a hand-edited pomodoro.json --
// resolves to NO_CUE here, which both call sites below already treat as "cross
// nothing": there is no separate silence branch to forget, exactly as cuePath's own
// comment in cues.mjs describes for the file-path case.
function cueFor(phase, settings) {
  const key = CUE_KEYS[phase];
  const value = key && settings[key];
  return isCue(value) ? value : NO_CUE;
}

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
  fire(phase, cueFor(phase, settings));
}

/** Fire the one notification whose whole job is to prove notifications arrive, for the
 * reader who has just ticked Notify (src/indexpage.mjs). Deliberately NOT gated on
 * `settings.notify` the way `notifyBoundary` is: the tick that asks for this has not
 * been saved yet, and a test that stays silent until after a Save answers the question
 * backwards. Silent, too -- no cue argument -- because auditioning a SOUND already has
 * its own control beside this one (the cue pickers, `playPreview` in src/server.mjs),
 * and a test banner that also plays something makes it ambiguous which of the two just
 * worked. Never throws and never awaits the subprocess, exactly like its sibling. */
export function notifyTest() {
  fire('test', NO_CUE);
}

/** The spawn both entry points share: the bundle's own executable when this file is
 * running from inside one, `osascript` otherwise (see the file header for why that
 * fallback is load-bearing rather than a nicety). Split out of `notifyBoundary` when
 * `notifyTest` arrived, so the two can never drift into two different ideas of which
 * binary to use or how to quote what it says. */
function fire(phase, cue) {
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
    //
    // The cue name is a THIRD argument, appended only when it is not NO_CUE -- absent
    // entirely rather than an empty string or a "None" token, so bin/launcher.c's own
    // argv parsing (argc >= 4) is what decides whether a cue was named at all, with no
    // sentinel value for it to mistake for a real sound. cueFor above has already
    // reduced whatever settings held to either a name isCue() accepts or NO_CUE, so
    // what crosses here is never free text -- see cueFor's own comment.
    const args = ['--notify', phase];
    if (cue !== NO_CUE) args.push(cue);
    execFile(APP_EXEC, args, warnOnFailure);
    return;
  }

  let script = `display notification ${appleScriptQuote(message)} with title ${appleScriptQuote(TITLE)}`;
  // Only a resolved cue (cueFor already collapsed "not a cue" and NO_CUE to the same
  // NO_CUE) adds the clause -- crossing into a phase set to None must stay silent, and
  // so must a phase whose settings key is missing or holds something isCue() refuses.
  // appleScriptQuote is belt-and-suspenders here exactly as it already is for MESSAGES/
  // TITLE above: isCue() is the actual boundary (src/cues.mjs's SAFE_NAME pattern is
  // what makes the closed set closed), so nothing reaches this string that was not
  // already a name macOS ships.
  if (cue !== NO_CUE) {
    script += ` sound name ${appleScriptQuote(cue)}`;
  }

  execFile('osascript', ['-e', script], warnOnFailure);
}
