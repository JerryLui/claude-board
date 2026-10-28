// The daemon's eye on the missions ledger: a read of every mission's derived state every
// `missionWatchMs()`, which is what notices the changes no write makes. A session whose
// process died, or a working one gone silent past STALL_SILENCE_MS (src/missions.mjs),
// reads stalled without a byte changing on disk, so no route can announce it.
//
// It does two things with a change, and writes nothing to the store:
//
//  - a derived state that moved while the record did not (no write behind it, so no route
//    published it) goes out as `missions` on the daemon-wide stream, so the home page, the
//    status item and any agent watching the stream re-read;
//  - a mission turning needs-you, stalled or released joins a batch that speaks once,
//    BATCH_WINDOW_MS after its first entry, as one notification naming the work or
//    counting it ("2 missions need you, FRONT_AGENT released").
//
// The first read after start is the baseline and says nothing, so a restart never floods
// the screen with every mission already waiting. A mission that moves on before its batch
// speaks (a needs-you answered inside the window) leaves the batch. The Banner level's Off
// silences the batch (ADR 106); the other levels are about which board a reviewer is
// looking at, and a mission is not a board, so every On level speaks.
//
// A read is not a prune: ADR 71 forbids deleting on a schedule, and this deletes and
// writes nothing.

import { missionsOverview } from './missions.mjs';
import { notifyMissions, isSafeMissionLine, MAX_MISSION_LINE_LEN } from './notify.mjs';
import { readDoc as readPomodoroDoc, bannerLevel } from './pomodoro.mjs';
import { boardHome } from './store.mjs';

export const DEFAULT_MISSION_WATCH_MS = 30_000;
export const BATCH_WINDOW_MS = 60_000;

/** The derived states that speak, in the order a notification names them. */
export const SPOKEN_STATES = ['needs-you', 'stalled', 'released'];

/** The read interval. `CLAUDE_BOARD_MISSION_WATCH_MS` overrides it, the way
 * `CLAUDE_BOARD_STRANDED_GRACE_MS` overrides the stranded grace: test/run.mjs pushes it out
 * of reach so the suite's daemons never speak. */
export function missionWatchMs() {
  const v = Number(process.env.CLAUDE_BOARD_MISSION_WATCH_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MISSION_WATCH_MS;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const MAX_NAME_LEN = 40;

/** The work's name as a notification may show it: the title when it is a plain name,
 * else the key, else nothing (the mission is then counted, not named). Nothing else on a
 * mission reaches the screen. */
function nameOf(view) {
  for (const candidate of [view.title, view.key]) {
    if (typeof candidate === 'string' && candidate.length <= MAX_NAME_LEN && SAFE_NAME.test(candidate)) return candidate;
  }
  return null;
}

const VERBS = {
  'needs-you': { one: 'needs you', many: 'need you' },
  stalled: { one: 'stalled', many: 'stalled' },
  released: { one: 'released', many: 'released' },
};

function counted(n, state) {
  return n === 1 ? `1 mission ${VERBS[state].one}` : `${n} missions ${VERBS[state].many}`;
}

/** One line for a batch of `{ name, state }` entries: a group of one is named when it has
 * a name, a larger group is counted, groups in SPOKEN_STATES order, joined by commas. A
 * line past MAX_MISSION_LINE_LEN, or one the notifier's filter would refuse, falls back to
 * counts alone. */
export function missionsLine(entries) {
  const groups = SPOKEN_STATES.map(state => ({ state, members: entries.filter(e => e.state === state) }))
    .filter(g => g.members.length > 0);
  const named = groups.map(({ state, members }) => (members.length === 1 && members[0].name
    ? `${members[0].name} ${VERBS[state].one}`
    : counted(members.length, state))).join(', ');
  if (named.length < MAX_MISSION_LINE_LEN && isSafeMissionLine(named)) return named;
  return groups.map(({ state, members }) => counted(members.length, state)).join(', ');
}

/** The watch over `home`. Every collaborator is a parameter so a check can hand it a clock
 * and a notifier; production passes `home` and `broadcast` alone. `read(now)` answers the
 * mission views at `now`; `broadcast(key)` publishes `missions` for one mission;
 * `notify(line)` posts the notification; `level()` answers the Banner level. */
export function createMissionWatch({
  home = boardHome(),
  now = Date.now,
  read = t => missionsOverview({ home, now: t, all: true }).missions,
  broadcast = () => {},
  notify = notifyMissions,
  level = () => bannerLevel(readPomodoroDoc(home).settings),
  intervalMs = missionWatchMs(),
  windowMs = BATCH_WINDOW_MS,
} = {}) {
  let seen = null; // key -> { view, updatedAt }, null until the baseline read
  const batch = new Map(); // key -> { name, state }
  let dueAt = null;
  let flushTimer = null;
  let interval = null;
  let warned = false;

  function warnOnce(what, err) {
    if (warned) return;
    warned = true;
    console.error(`claude-board: the missions watch could not ${what} (further failures are not logged): ${(err && err.message) || err}`);
  }

  function flush() {
    const entries = [...batch.values()];
    batch.clear();
    dueAt = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (entries.length === 0) return;
    try {
      if (level() === 'off') return;
      notify(missionsLine(entries));
    } catch (err) {
      warnOnce('post its notification', err);
    }
  }

  function join(key, entry, t) {
    if (dueAt !== null && t >= dueAt) flush();
    batch.set(key, entry);
    if (dueAt === null) {
      dueAt = t + windowMs;
      // The timer's read closes the batch whatever the clock says: libuv arms it on its
      // cached loop time, which runs behind `now()`, so it can fire a hair before dueAt.
      flushTimer = setTimeout(() => tick({ closing: true }), windowMs);
      flushTimer.unref?.();
    }
  }

  /** One read: diff every mission's derived state against the last read, publish the
   * changes no write published, batch the ones that speak, and speak a batch whose window
   * has closed. `closing` is the batch timer's read, which speaks the batch even when
   * the read fails. Never throws: it runs from a timer on the daemon's one event loop. */
  function tick({ closing = false } = {}) {
    const t = now();
    let views;
    try {
      views = read(t);
    } catch (err) {
      warnOnce('read the missions', err);
      if (closing) flush();
      return;
    }
    const next = new Map(views.map(v => [v.key, { view: v.view, updatedAt: v.updatedAt }]));
    if (seen === null) {
      seen = next;
      return;
    }
    const joining = [];
    for (const v of views) {
      const prev = seen.get(v.key);
      if (prev && prev.view === v.view) continue;
      if (prev && prev.updatedAt === v.updatedAt) {
        try { broadcast(v.key); } catch (err) { warnOnce('publish a change', err); }
      }
      if (SPOKEN_STATES.includes(v.view)) joining.push(v);
      else batch.delete(v.key);
    }
    seen = next;
    for (const v of joining) join(v.key, { name: nameOf(v), state: v.view }, t);
    if (dueAt !== null && (closing || t >= dueAt)) flush();
  }

  return {
    /** The baseline read, then a read every `intervalMs`. */
    start() {
      tick();
      interval = setInterval(() => tick(), intervalMs);
      interval.unref?.();
    },
    tick: () => tick(),
    close() {
      if (interval) clearInterval(interval);
      if (flushTimer) clearTimeout(flushTimer);
      interval = null;
      flushTimer = null;
    },
  };
}
