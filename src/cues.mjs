// The cue vocabulary: which sounds exist, what a stored cue value may be, and where the
// file for one lives. See CONTEXT.md "Cue" for the term and ADR.md entry 20 for why the
// cue is the notification's own sound rather than something this daemon plays beside it.
//
// One directory, read once, shared by three readers that would otherwise drift apart:
// the picker's option list (src/pomodoro-widget.mjs), the validator that decides whether
// a saved value is a cue at all (src/pomodoro.mjs mergeSettings), and the preview player
// (src/server.mjs). Nothing is staged anywhere and install.sh is not involved: macOS
// resolves a bare name against this same directory itself, both from
// `UNNotificationSound soundNamed:` on the bundled path and from AppleScript's `sound
// name` on the clone path (QUIRKS.md, measured — the bundle's own Contents/Resources is
// in fact the one place soundNamed: does NOT look, which is why entry 20's original
// staging plan was dropped). So the picker cannot offer a name the notification cannot
// play: there are not two lists to keep in sync, there is one directory read by
// everybody. The path is stated once, here, and nowhere else in src/.
//
// Enumerated rather than hardcoded to a list of 14. A reader whose /System/Library/Sounds
// has been added to or pruned gets what is actually there — a fixed list would be right
// about a stock machine and wrong about theirs, and would be a list macOS disagreed with.

import { readdirSync } from 'node:fs';

export const SOUNDS_DIR = '/System/Library/Sounds';

/** The one value that means "cross this boundary silently". A string rather than null or
 * false because it is also an option in a `<select>`, and a select's value is a string;
 * one spelling for the whole system beats a null that has to be mapped at every edge. */
export const NO_CUE = 'None';

const EXT = '.aiff';

/** Conservative on purpose. Every name that survives this is interpolated into a
 * filesystem path (cuePath below) and handed to a player process, so the set is closed by
 * construction rather than by the caller remembering to check: a name macOS ships that
 * this refuses is a sound the picker does not offer, which is a missing option — a name
 * it wrongly accepts is an argument built out of a directory listing. The stock 14 are all
 * plain words. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

// Memoised on first use, not computed at import: the set cannot change under a running
// daemon (the bundle it resolves against is staged at install time), and a module that
// touches the filesystem the instant it is imported is one that cannot be imported by a
// check that wants to look at anything else in it first.
let cached = null;

/** Every value a cue setting may hold: `None` first, then the sounds macOS ships, sorted.
 * A directory that cannot be read yields `['None']` rather than throwing — a picker with
 * one option is a degraded surface, an unhandled throw at import is a dead daemon. */
export function cueNames() {
  if (cached) return cached;
  let names = [];
  try {
    names = readdirSync(SOUNDS_DIR)
      .filter(f => f.endsWith(EXT))
      .map(f => f.slice(0, -EXT.length))
      .filter(n => SAFE_NAME.test(n))
      .sort();
  } catch {
    names = [];
  }
  cached = Object.freeze([NO_CUE, ...names]);
  return cached;
}

export function isCue(v) {
  return typeof v === 'string' && cueNames().includes(v);
}

/** The absolute path of a cue's sound file, or null for `None` and for anything that is
 * not a cue. The null is what makes "play this" and "play nothing" the same code path
 * with no separate silence branch to forget. */
export function cuePath(name) {
  if (name === NO_CUE || !isCue(name)) return null;
  return `${SOUNDS_DIR}/${name}${EXT}`;
}

/** `preferred` if this machine has it, `None` otherwise. Used for the per-phase defaults
 * in src/pomodoro.mjs: a default naming a sound that is not on this machine would be a
 * document whose own values the validator refuses on the next save. */
export function pickCue(preferred) {
  return isCue(preferred) ? preferred : NO_CUE;
}
