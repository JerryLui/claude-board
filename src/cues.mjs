// The cue vocabulary: which sounds exist, what a stored cue value may be, and where the
// file for one lives. See ADR.md entry 20 for why the
// cue is the notification's own sound rather than something this daemon plays beside it.
//
// The directories macOS resolves a bare sound name against, read here and shared by three
// readers that would otherwise drift apart: the picker's option list
// (src/pomodoro-widget.mjs), the validator that decides whether a saved value is a cue at
// all (src/pomodoro.mjs mergeSettings), and the preview player (src/server.mjs). Nothing is
// staged anywhere and install.sh is not involved: macOS resolves a bare name against these
// same directories itself, both from `UNNotificationSound soundNamed:` on the bundled path
// and from AppleScript's `sound name` on the clone path (QUIRKS.md, measured: the bundle's
// own Contents/Resources is in fact the one place soundNamed: does NOT look, which is why
// entry 20's original staging plan was dropped). So the picker cannot offer a name the
// notification cannot play. There are still not two lists to keep in sync: there is one
// enumeration, of the very directories macOS itself searches, read by everybody. Entry 23
// added the second directory, so a reader can supply a cue macOS does not ship; the paths
// are stated once, here, and nowhere else in src/.
//
// Enumerated rather than hardcoded to a list of 14. A reader whose sound directories have
// been added to or pruned gets what is actually there. A fixed list would be right about a
// stock machine and wrong about theirs, and would be a list macOS disagreed with.

import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

/** The two directories macOS resolves a bare sound name against, in the order macOS itself
 * picks a winner when a name is in both. That order is measured, not assumed, and it is NOT
 * the order Apple's Library search path implies: `/System/Library/Sounds` wins, and a
 * `~/Library/Sounds` file sharing a stock sound's name is simply never heard (QUIRKS.md).
 * Listing it the other way round would have made the preview play a file the notification
 * would not. `~/Library/Sounds` is the drop-in point for sounds macOS does not ship, and it
 * IS searched, which is what makes a reader-supplied cue possible at all. ADR.md entry 20
 * refused to *write* into that namespace, since it is shared with every other app's picker
 * and uninstall would have to tell its own files from the reader's; entry 20 only reads it,
 * which carries none of that cost. */
export const SOUNDS_DIRS = ['/System/Library/Sounds', `${homedir()}/Library/Sounds`];

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

// Cached with a short TTL rather than forever, and never computed at import. Not at import
// because a module that touches the filesystem the instant it is imported cannot be
// imported by a check that wants to look at anything else in it first. Not forever because
// the set now *can* change under a running daemon: dropping a file into ~/Library/Sounds is
// the whole way a reader adds a cue, and a cue that needs a daemon restart to appear in the
// picker is a feature nobody finds. ponytail: a time-based re-read, not a watcher, because
// two small readdirs a few seconds apart cost nothing next to an fs.watch and its teardown.
// The ceiling is the window itself: a just-dropped file can take up to TTL_MS to show up.
// Upgrade path if that ever matters: fs.watch both directories and clear `cached`.
let cached = null;
let cachedAt = 0;
const TTL_MS = 5000;

/** Every value a cue setting may hold: `None` first, then the sounds this machine can
 * actually play, sorted and de-duplicated across the search path. A directory that cannot
 * be read contributes nothing rather than throwing: `~/Library/Sounds` does not exist on a
 * stock machine, and even both being unreadable should degrade to a one-option picker
 * rather than take the daemon down. */
export function cueNames() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  const names = new Set();
  for (const dir of SOUNDS_DIRS) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(EXT)) continue;
      const n = f.slice(0, -EXT.length);
      if (SAFE_NAME.test(n)) names.add(n);
    }
  }
  cached = Object.freeze([NO_CUE, ...[...names].sort()]);
  cachedAt = Date.now();
  return cached;
}

export function isCue(v) {
  return typeof v === 'string' && cueNames().includes(v);
}

/** The absolute path of a cue's sound file, or null for `None`, for anything that is not a
 * cue, and for a cue whose file vanished between the listing and this call. The null is
 * what makes "play this" and "play nothing" the same code path with no separate silence
 * branch to forget. Walks SOUNDS_DIRS in the measured order, so the preview plays the same
 * file the notification will even when a reader's file shares a stock sound's name. */
export function cuePath(name) {
  if (name === NO_CUE || !isCue(name)) return null;
  for (const dir of SOUNDS_DIRS) {
    const p = `${dir}/${name}${EXT}`;
    if (existsSync(p)) return p;
  }
  return null;
}

/** `preferred` if this machine has it, `None` otherwise. Used for the per-phase defaults
 * in src/pomodoro.mjs: a default naming a sound that is not on this machine would be a
 * document whose own values the validator refuses on the next save. */
export function pickCue(preferred) {
  return isCue(preferred) ? preferred : NO_CUE;
}
