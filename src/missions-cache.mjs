// One cache in front of `missionsOverview` (src/missions.mjs), shared by every reader in
// one daemon: `GET /`, `GET /api/missions`, the mission counts on `GET /api/waiting` (the
// status item's 15 s poll) and the missions watch. An overview reads every mission record
// and every board each one links, so each reader paying for its own walk is the cost
// `createWaitingCache` (src/server.mjs) exists to avoid for the waiting list.
//
// An answer is reused while both stores look the same and it is younger than its bound:
//
//  - a write, by this daemon or anyone else: the boards' `storeFingerprint` plus the same
//    readdir-and-stat over the missions directory, nothing parsed;
//  - a change no write makes (a session's process dying, a silence passing
//    STALL_SILENCE_MS, a round's wait lapsing): the bound, MISSIONS_CACHE_MS, cut to the
//    watch's own interval when that is shorter, so the watch still notices a change
//    within one interval.
//
// A read that throws is not cached: the next caller reads again.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { missionsOverview } from './missions.mjs';
import { missionWatchMs } from './mission-watch.mjs';
import { boardHome, storeFingerprint } from './store.mjs';

export const MISSIONS_CACHE_MS = 5_000;

/** The missions directory's shape, as `storeFingerprint` reads the boards': every record's
 * name, size, mtime and inode (a temp-and-rename write always lands a new inode). An
 * unreadable directory answers a print that matches nothing, so nothing is reused. */
function missionsFingerprint(home) {
  try {
    const dir = path.join(home, 'missions');
    const parts = [];
    for (const f of readdirSync(dir).filter(n => n.endsWith('.json') && !n.includes('.tmp-')).sort()) {
      const s = statSync(path.join(dir, f));
      parts.push(`${f}:${s.size}:${s.mtimeMs}:${s.ino}`);
    }
    return parts.join('|');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    return `unreadable:${Date.now()}:${Math.random()}`;
  }
}

/** The cache over `home`. `overview({ all })` answers what `missionsOverview` would, one
 * entry per `all`. `now` is the clock the bound and the overview read. */
export function createMissionsCache({ home = boardHome(), now = Date.now } = {}) {
  const boundMs = Math.min(MISSIONS_CACHE_MS, missionWatchMs());
  const entries = new Map(); // all -> { print, at, value }
  return {
    overview({ all = false } = {}) {
      const t = now();
      const print = `${storeFingerprint(home)}#${missionsFingerprint(home)}`;
      const hit = entries.get(all);
      if (hit && hit.print === print && t - hit.at < boundMs) return hit.value;
      const value = missionsOverview({ home, now: t, all });
      entries.set(all, { print, at: t, value });
      return value;
    },
  };
}
