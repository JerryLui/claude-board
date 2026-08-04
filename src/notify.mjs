// Native notification at each pomodoro boundary (SPEC_POMODORO.md criterion 5,
// ticket 02). `osascript -e 'display notification ...'` needs no browser, prompts for
// no Notification Center permission, and needs no app bundle change -- which is exactly
// why ADR.md entry 9 ("No menu bar item") accepts the notification attributing to
// "Script Editor" rather than to claude-board: fixing that attribution means touching
// the launcher bundle's signature, which costs the user their TCC Documents grant. That
// is not a defect this file exists to fix.
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

const TITLE = 'Pomodoro';
// A name out of /System/Library/Sounds, not a file this repo ships -- criterion 14 ("no
// audio file added to the repo") holds by construction, because this string is the only
// sound-related thing notifyBoundary ever sends anywhere.
const SOUND_NAME = 'Glass';

// Logged once per process, not once per failure: a reader who has Notification Center
// blocked, or who is on a machine with no osascript at all, would otherwise get one
// stderr line per interval boundary for as long as the daemon runs.
let warnedOnce = false;

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

  let script = `display notification ${appleScriptQuote(message)} with title ${appleScriptQuote(TITLE)}`;
  // settings.sound === true is the only thing that adds the clause. DEFAULT_SETTINGS
  // (src/pomodoro.mjs) ships sound: false, so anything else -- false, or absent from an
  // older document normalizeDoc hasn't back-filled -- must stay silent: erring toward
  // noise the reader never asked for is the wrong direction for a default to fail in.
  if (settings.sound === true) {
    script += ` sound name ${appleScriptQuote(SOUND_NAME)}`;
  }

  execFile('osascript', ['-e', script], err => {
    if (err && !warnedOnce) {
      warnedOnce = true;
      console.error(`notifyBoundary: osascript failed, notifications may not be appearing (further failures are not logged): ${err.message}`);
    }
  });
}
