// Which mission a session is bound to (src/missions.mjs `bindingFor`), answered off the
// stored records alone: `GET /api/binding`, which a session's hook asks every minute, and a
// board post naming its session, which links the board to that session's mission (ADR 141).
//
// The records are kept here per file, by each file's size, mtime and inode, so a call
// re-reads only the records that moved since the last one: one readdir and a stat per
// record, nothing derived, no board read. A record that will not parse is skipped.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { boardHome, readMission } from './store.mjs';
import { bindingFor, endedHere } from './missions.mjs';

/** The index over `home`'s missions. `binding(ref)` answers `bindingFor` for `ref`
 * (`{ id?, pid?, procStart? }`); `ended(key, ref)` is true when mission `key` records `ref`
 * as its ended session (`endedHere`). */
export function createBindingIndex({ home = boardHome() } = {}) {
  const dir = path.join(home, 'missions');
  const files = new Map(); // file name -> { stamp, record }

  function records() {
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
      let record = null;
      try {
        record = readMission(f.slice(0, -'.json'.length), home);
      } catch {
        record = null;
      }
      files.set(f, { stamp, record });
    }
    for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
    return [...files.values()].map(e => e.record).filter(Boolean);
  }

  return {
    binding(ref) {
      return bindingFor(records(), ref);
    },
    ended(key, ref) {
      return records().some(m => m.key === key && endedHere(m, ref));
    },
  };
}
