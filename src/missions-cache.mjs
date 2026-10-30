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
// A read that throws is not cached: the next caller reads again. `drop()` forgets the
// answer outright, for a reader who asks to see a change no write makes now rather than
// up to a bound later (a card's Check again, `POST /api/mission/:key/recheck`).
//
// A bound session's liveness reads the session list's latest snapshot beside its heartbeats
// (src/missions.mjs `missionView`, ADR 36): the overview is given `listed()`, and the list's
// `version` in the print below re-reads it on a snapshot that changed what it lists.
//
// The overview also carries the tab cards (src/sessions.mjs `deriveTabs`) when a session
// list is given: `tabs`, and each tab counted in its column's `counts` entry as the
// Missions view counts its cards (`live`, which the launch caps read, never counts one).
// The list's `version` joins the print, so a snapshot, an order or the watcher going down
// is read on the next call rather than up to a bound later. With no session listed nothing
// more is read. With some, the tabs take the mission records the overview already read
// (a retired mission's session is still not a tab) and a board index (`createBoardLinks`)
// that re-reads only the board files that moved since it last looked, so a miss never
// parses the whole store. Records and tabs are read once per print and bound, for the
// `all` and the plain answer alike.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { missionsOverview } from './missions.mjs';
import { boardLink, deriveTabs } from './sessions.mjs';
import { missionWatchMs } from './mission-watch.mjs';
import { boardHome, storeFingerprint, listMissions, readBoard } from './store.mjs';

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

/** Every board's `boardLink`, kept per file by its size, mtime and inode: `links(print)`
 * re-stats the boards directory only when the store's print moved since the last call, and
 * re-reads only a file whose stat moved. A file that will not parse is skipped, warned once
 * per file in this process. */
function createBoardLinks(home) {
  const dir = path.join(home, 'boards');
  const files = new Map(); // file name -> { stamp, link }
  const warned = new Set();
  let lastPrint = null;
  let links = [];
  return {
    links(print) {
      if (print === lastPrint) return links;
      let names;
      try {
        names = readdirSync(dir);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
        names = [];
      }
      const seen = new Set();
      for (const f of names) {
        if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
        let stat;
        try {
          stat = statSync(path.join(dir, f));
        } catch {
          continue; // gone between the readdir and the stat
        }
        seen.add(f);
        const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
        if (files.get(f)?.stamp === stamp) continue;
        let link = null;
        try {
          link = boardLink(readBoard(f.slice(0, -'.json'.length), home));
        } catch (err) {
          if (!warned.has(f)) {
            warned.add(f);
            console.warn(`claude-board: skipping unreadable store file boards/${f}: ${(err && err.message) || err}`);
          }
        }
        files.set(f, { stamp, link });
      }
      for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
      links = [...files.values()].map(e => e.link).filter(Boolean);
      lastPrint = print;
      return links;
    },
  };
}

/** `overview` with its tab cards: `tabs`, each counted in its column's `counts` entry. */
function withTabs(overview, tabs) {
  const counts = { ...overview.counts };
  for (const t of tabs) {
    const col = t.state === 'needs-you' ? 'needsYou' : t.state;
    counts[col] = (counts[col] || 0) + 1;
  }
  return { ...overview, tabs, counts };
}

/** The cache over `home`. `overview({ all })` answers what `missionsOverview` would, with
 * `tabs` when `sessions` (src/sessions.mjs `createSessionList`) is given; `drop()` makes
 * the next `overview` read afresh. `now` is the clock the bound and the overview read. */
export function createMissionsCache({ home = boardHome(), now = Date.now, sessions = null } = {}) {
  const boundMs = Math.min(MISSIONS_CACHE_MS, missionWatchMs());
  const boardLinks = createBoardLinks(home);
  let read = null; // { print, at, records, tabs, answers: Map(all -> value) }
  return {
    overview({ all = false } = {}) {
      const t = now();
      const boardsPrint = storeFingerprint(home);
      const print = `${boardsPrint}#${missionsFingerprint(home)}#${sessions ? sessions.version : ''}`;
      if (!read || read.print !== print || t - read.at >= boundMs) {
        const records = listMissions(home);
        const entries = sessions ? sessions.entries() : [];
        const tabs = entries.length === 0 ? [] : deriveTabs({ sessions: entries, missions: records, boards: boardLinks.links(boardsPrint) });
        read = { print, at: t, records, tabs, answers: new Map() };
      }
      if (read.answers.has(all)) return read.answers.get(all);
      const plain = missionsOverview({ home, now: t, all, records: read.records, listed: sessions ? sessions.listed() : null });
      const value = sessions ? withTabs(plain, read.tabs) : plain;
      read.answers.set(all, value);
      return value;
    },
    drop() {
      read = null;
    },
  };
}
