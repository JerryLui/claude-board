// The sessions a watcher reports, held in memory: every agent session running on this Mac
// that no mission launched (a tab the PM started by hand, a background job), so the
// Missions view can show it as a tab card beside the missions (ADR 131).
//
// The board never finds a session itself. A watcher outside it (for Claude Code, one that
// reads Claude's own session list) posts a full snapshot to `POST /api/sessions` every
// `intervalMs`, and each snapshot replaces the last whole. That keeps the board
// agent-neutral, as the missions ledger is: nothing here reads an agent's folder or knows
// which agent a session runs, and any agent's watcher could post the same shape.
//
// Nothing here reaches disk. A session's `name` is its first prompt and may carry case
// content, and a blocked job's `reason` may too, so both live only in this process: never
// in the store, a board record, a missions record, a log line or a notification, and gone
// when the session leaves a snapshot or the daemon restarts. A refusal names the field and
// the entry's index, never a value. A tab's orders (Stop and comment from its card) are
// held the same way and go with their session.
//
// A watcher that stops posting reads down once two intervals pass with no snapshot,
// counted from the last one or from this list's creation (the daemon's start) when none
// came; the list is dropped then, so a dead watcher never leaves stale cards up.
//
// A round links to its session through the board it sits on: the post that minted it
// names its session by pid and process start (`session: { pid, procStart }`), and the
// daemon keeps `session: { pid, procStart, id }` on the board, `id` resolved here when one
// listed session matches both. A pid alone never matches: a pid the OS reuses has another
// start time, so it never inherits a round or revives a card.

import { randomBytes } from 'node:crypto';
import { ORDER_KINDS, roundWantsAnswer } from './missions.mjs';
import { questionBlocks } from './badge.mjs';
import { folderName } from './indexpage.mjs';

/** The interval assumed before any snapshot names one: a fresh daemon reads the watcher
 * down two of these after its start when nothing has posted. */
export const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 10 * 60 * 1000;

/** At most this many sessions in one snapshot; more is a 400. */
export const MAX_SESSIONS = 100;

/** A name or reason longer than this is cut to it rather than refused: both are the
 * agent's own text (a first prompt can run to pages), and refusing the snapshot for one
 * long prompt would blank every card. A card shows a line of either. */
export const MAX_NAME_CHARS = 200;
export const MAX_REASON_CHARS = 300;

const MAX_PATH_CHARS = 4096;
const MAX_TEXT_BYTES = 4096;
const MAX_ORDERS = 50;

export const SESSION_KINDS = ['interactive', 'bg'];
export const SESSION_STATUSES = ['busy', 'idle', 'blocked'];
const SESSION_FIELDS = ['id', 'pid', 'procStart', 'kind', 'jobId', 'cwd', 'login', 'name', 'status', 'reason'];

/** A session id rides in `/api/session/:id/...`, so it is held to a path-safe pattern, as a
 * board id and a mission key are. Claude's are UUIDs. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A process start as the watcher reads it: UTC, to the second, milliseconds allowed. */
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const iso = ms => new Date(ms).toISOString();

function refuse(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validPid(value) {
  return Number.isInteger(value) && value > 0;
}

function validProcStart(value) {
  return typeof value === 'string' && UTC_ISO.test(value) && Number.isFinite(Date.parse(value));
}

/** Two process starts name one second (`...:15Z`, `...:15.000Z` and `...:15.400Z` alike):
 * the contract allows milliseconds, and the board tool's post sends whole seconds. */
function sameStart(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return Math.floor(Date.parse(a) / 1000) === Math.floor(Date.parse(b) / 1000);
}

// --- validation -----------------------------------------------------------------------

function optionalString(value, what, maxChars, { cut = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw refuse(`${what} must be a string or null`);
  if (value.length <= maxChars) return value;
  if (cut) return value.slice(0, maxChars);
  throw refuse(`${what} is over ${maxChars} characters`);
}

function validateEntry(entry, i) {
  const what = `sessions[${i}]`;
  if (!isObject(entry)) throw refuse(`${what} must be an object`);
  for (const k of Object.keys(entry)) {
    if (!SESSION_FIELDS.includes(k)) throw refuse(`${what} has an unknown field`);
  }
  if (typeof entry.id !== 'string' || !SAFE_SESSION_ID.test(entry.id)) throw refuse(`${what}.id must match ${SAFE_SESSION_ID}`);
  const processId = entry.pid ?? null;
  const procStart = entry.procStart ?? null;
  if (processId !== null && !validPid(processId)) throw refuse(`${what}.pid must be a positive integer or null`);
  if (procStart !== null && !validProcStart(procStart)) throw refuse(`${what}.procStart must be a UTC ISO-8601 timestamp or null`);
  if ((processId === null) !== (procStart === null)) throw refuse(`${what}.pid and procStart are both set or both null`);
  if (!SESSION_KINDS.includes(entry.kind)) throw refuse(`${what}.kind must be one of ${SESSION_KINDS.join(', ')}`);
  if (!SESSION_STATUSES.includes(entry.status)) throw refuse(`${what}.status must be one of ${SESSION_STATUSES.join(', ')}`);
  // A session with no process is a background job still blocked on its reason; anything
  // else without one has ended and is no card.
  if (processId === null && !(entry.kind === 'bg' && entry.status === 'blocked')) throw refuse(`${what}.pid may be null only for a blocked bg job`);
  const jobId = entry.jobId ?? null;
  if (jobId !== null && (typeof jobId !== 'string' || !SAFE_JOB_ID.test(jobId))) throw refuse(`${what}.jobId must match ${SAFE_JOB_ID} or be null`);
  if (typeof entry.cwd !== 'string' || !entry.cwd.startsWith('/') || entry.cwd.length > MAX_PATH_CHARS) {
    throw refuse(`${what}.cwd must be an absolute path of at most ${MAX_PATH_CHARS} characters`);
  }
  return {
    id: entry.id,
    pid: processId,
    procStart,
    kind: entry.kind,
    jobId,
    cwd: entry.cwd,
    login: optionalString(entry.login, `${what}.login`, MAX_PATH_CHARS),
    name: optionalString(entry.name, `${what}.name`, MAX_NAME_CHARS, { cut: true }),
    status: entry.status,
    reason: optionalString(entry.reason, `${what}.reason`, MAX_REASON_CHARS, { cut: true }),
  };
}

/** `POST /api/sessions`'s body as the list holds it, or a 400 naming what is wrong and
 * never a value: `{ intervalMs, sessions }`, at most `MAX_SESSIONS`, ids unique. */
export function validateSnapshot(body) {
  if (!isObject(body)) throw refuse('the body must be an object');
  for (const k of Object.keys(body)) {
    if (k !== 'intervalMs' && k !== 'sessions') throw refuse('the body has an unknown field');
  }
  const { intervalMs, sessions } = body;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw refuse(`intervalMs must be an integer from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS}`);
  }
  if (!Array.isArray(sessions)) throw refuse('sessions must be an array');
  if (sessions.length > MAX_SESSIONS) throw refuse(`sessions holds over ${MAX_SESSIONS} entries`);
  const entries = sessions.map(validateEntry);
  const ids = new Set();
  entries.forEach((e, i) => {
    if (ids.has(e.id)) throw refuse(`sessions[${i}].id repeats an earlier entry's`);
    ids.add(e.id);
  });
  return { intervalMs, sessions: entries };
}

/** A board post's `session`, `{ pid, procStart }` and nothing else, or a 400. */
export function validateSessionRef(value) {
  if (!isObject(value)) throw refuse('session must be an object');
  for (const k of Object.keys(value)) {
    if (k !== 'pid' && k !== 'procStart') throw refuse('session has an unknown field');
  }
  if (!validPid(value.pid)) throw refuse('session.pid must be a positive integer');
  if (!validProcStart(value.procStart)) throw refuse('session.procStart must be a UTC ISO-8601 timestamp');
  return { pid: value.pid, procStart: value.procStart };
}

// --- the board's session --------------------------------------------------------------

/** Records the posting session on `board`, from a post's validated `ref` and the `id` the
 * list resolved for it (null when no listed session matched). A board keeps the session
 * that first posted to it:
 *
 *  - a board with none takes `{ pid, procStart, id }`;
 *  - a board whose session has no id yet takes one from a later post by the same process
 *    (same pid and start), once the watcher lists it;
 *  - a board whose session has an id takes a new pid and start from a post resolved to that
 *    same id (the session resumed in a new process), and a new id from a post by the same
 *    process (the session resumed in place, `/resume` inside one process);
 *  - any other post leaves it as it was. The post itself still lands: which session a board
 *    belongs to is the card's business, never a reason to refuse a round. */
export function bindBoardSession(board, ref, id) {
  const held = board.session;
  if (!isObject(held)) {
    board.session = { pid: ref.pid, procStart: ref.procStart, id: id ?? null };
    return;
  }
  if (held.id == null) {
    if (id && held.pid === ref.pid && sameStart(held.procStart, ref.procStart)) held.id = id;
    return;
  }
  if (!id) return;
  if (id === held.id) {
    held.pid = ref.pid;
    held.procStart = ref.procStart;
  } else if (held.pid === ref.pid && sameStart(held.procStart, ref.procStart)) {
    held.id = id;
  }
}

// --- the list -------------------------------------------------------------------------

/** The in-memory list, one per daemon (per request handler, as everything else there).
 * `now` is its clock. `onChange` runs when what a reader sees moved: the sessions a
 * snapshot lists, an order, or the watcher going down; never for a snapshot that repeats
 * the last one.
 *
 * `version` moves with every such change, for the missions cache's fingerprint. */
export function createSessionList({ now = Date.now, onChange = () => {} } = {}) {
  const startedAt = now();
  let lastAt = null;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let sessions = [];
  let orders = new Map(); // session id -> [order]
  let version = 0;
  let timer = null;
  let lastPrint = '[]';
  let downPublished = false;

  const downAt = () => (lastAt ?? startedAt) + 2 * intervalMs;
  const isUp = () => now() < downAt();

  const changed = () => {
    version += 1;
    onChange();
  };

  /** Drops the list once the watcher reads down, publishing that once. */
  function sweep() {
    if (isUp() || downPublished) return;
    downPublished = true;
    sessions = [];
    orders = new Map();
    lastPrint = '[]';
    changed();
  }

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      sweep();
    }, Math.max(0, downAt() - now()) + 5);
    timer.unref?.();
  }
  arm();

  function live() {
    if (!isUp()) return [];
    return sessions;
  }

  function find(id) {
    if (typeof id !== 'string' || !SAFE_SESSION_ID.test(id)) throw refuse('no such session', 404);
    const s = live().find(e => e.id === id);
    if (!s) throw refuse('no such session', 404);
    return s;
  }

  return {
    get version() { return version; },

    /** Replaces the list with a validated snapshot; a session still listed keeps its orders.
     * Answers `{ sessions, watcher }`, `sessions` being the count. */
    replace(body) {
      const snapshot = validateSnapshot(body);
      const wasUp = isUp();
      downPublished = false;
      lastAt = now();
      intervalMs = snapshot.intervalMs;
      sessions = snapshot.sessions;
      const kept = new Map();
      for (const s of sessions) if (orders.has(s.id)) kept.set(s.id, orders.get(s.id));
      const dropped = kept.size !== orders.size;
      orders = kept;
      arm();
      const print = JSON.stringify(sessions);
      if (print !== lastPrint || !wasUp || dropped) {
        lastPrint = print;
        changed();
      }
      return { sessions: sessions.length, watcher: this.watcher() };
    },

    /** `{ up, lastAt }`: up until two intervals pass with no snapshot; `lastAt` is the
     * last snapshot's time, or null when none came since the daemon started. */
    watcher() {
      return { up: isUp(), lastAt: lastAt === null ? null : iso(lastAt) };
    },

    /** The listed sessions, each with its orders; none while the watcher reads down. */
    entries() {
      return live().map(s => ({ ...s, orders: (orders.get(s.id) || []).map(o => ({ ...o })) }));
    },

    /** The id of the one listed session with this pid and process start, else null. */
    matchId(pid, procStart) {
      const hits = live().filter(s => s.pid === pid && sameStart(s.procStart, procStart));
      return hits.length === 1 ? hits[0].id : null;
    },

    /** `POST /api/session/:id/order`: a stop or comment from the tab's card, as a mission's
     * card orders (src/missions.mjs `addOrder`). A comment needs its text. Answers it. */
    addOrder(id, body) {
      if (!isObject(body)) throw refuse('the body must be an object');
      for (const k of Object.keys(body)) {
        if (k !== 'kind' && k !== 'text') throw refuse('the body has an unknown field');
      }
      if (!ORDER_KINDS.includes(body.kind)) throw refuse(`kind must be one of ${ORDER_KINDS.join(', ')}`);
      let text;
      if (body.text !== undefined) {
        if (typeof body.text !== 'string') throw refuse('text must be a string');
        if (Buffer.byteLength(body.text, 'utf8') > MAX_TEXT_BYTES) throw refuse(`text is over ${MAX_TEXT_BYTES} bytes`);
        text = body.text;
      }
      if (body.kind === 'comment' && !(text && text.trim())) throw refuse('a comment order needs its text');
      const s = find(id);
      const order = { id: `o_${randomBytes(8).toString('hex')}`, kind: body.kind, ...(text !== undefined ? { text } : {}), at: iso(now()) };
      orders.set(s.id, [...(orders.get(s.id) || []), order].slice(-MAX_ORDERS));
      changed();
      return { ...order };
    },

    /** `POST /api/session/:id/order/:oid/ack`: marks the order relayed, once; a repeat keeps
     * the first `relayedAt`. Answers the order. */
    ackOrder(id, oid) {
      const s = find(id);
      const order = (orders.get(s.id) || []).find(o => o.id === oid);
      if (!order) throw refuse('no such order', 404);
      if (!order.relayedAt) {
        order.relayedAt = iso(now());
        changed();
      }
      return { ...order };
    },

    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// --- the view -------------------------------------------------------------------------

/** The sessions a mission holds or held, by id and by pid: its bound session's and the one
 * its last launch ended. A session a mission launched is that mission's card, never a tab,
 * even once the mission has moved on while its process lingers; the pid covers it under a
 * new id before its next beat binds that (a `/clear`). */
function missionSessions(missions) {
  const ids = new Set();
  const pids = new Set();
  const add = s => {
    if (typeof s.id === 'string' && s.id) ids.add(s.id);
    if (validPid(s.pid)) pids.add(s.pid);
  };
  for (const m of missions) {
    const s = m && m.session;
    if (!isObject(s)) continue;
    add(s);
    if (isObject(s.ended)) add(s.ended);
  }
  return { ids, pids };
}

/** What a tab card needs of one board, or null for a board no session posted: its id, the
 * session it holds (`bindBoardSession`), the mission it belongs to, and the rounds still
 * waiting on the PM (src/missions.mjs `roundWantsAnswer`), every one of them: a mission's
 * own needs-you reads that rule on each board's newest round only (ADR 134). It reads nothing off the clock, so it holds for as long as the board's
 * file does: src/missions-cache.mjs keeps one per file and re-reads only a file that
 * moved. */
export function boardLink(board) {
  const bs = board && board.session;
  if (!isObject(bs)) return null;
  const questions = questionBlocks(board);
  return {
    id: board.id,
    session: { pid: bs.pid ?? null, procStart: bs.procStart ?? null, id: bs.id ?? null },
    mission: board.mission ?? null,
    open: (board.rounds || []).filter(r => roundWantsAnswer(r, questions)).map(r => r.n),
  };
}

const sameProcess = (s, ref) => s.pid != null && s.pid === ref.pid && sameStart(s.procStart, ref.procStart);

/** `/word` at the head of a session's name (its first prompt), else null: the slash
 * command a tab runs, the one part of its name a reader can tell tabs apart by at a
 * glance. */
export function commandOf(name) {
  if (typeof name !== 'string') return null;
  const m = /^\s*(\/[A-Za-z0-9][\w:.-]*)/.exec(name);
  return m ? m[1] : null;
}

/** The tab cards for `sessions` (the list's `entries()`): every listed session but a
 * mission's. A session is a mission's when a mission record holds or held it, by its id,
 * its pid, or its job id being a held id's first 8 characters (a background job's id is
 * its session's short form); or when it posted a board that belongs to a mission (a
 * launch reserves a session before it knows its pid or id). `missions` are the stored
 * records, every one, retired or not; `boards` are `boardLink`s of every board in the
 * store. A card reads:
 *
 *  - needs-you: a round still waiting on the PM sits on a board this session posted that
 *    belongs to no mission (a mission's round is its own card's), or the session is a
 *    blocked job;
 *  - working: busy;
 *  - waiting: idle, with `yourTurn`.
 *
 * A board links to the listed session with the id it recorded; with no id recorded, or an
 * id no listed session has (resumed in place under a new one), to the one with its pid and
 * process start together. `rounds` are `{ board, round }`; the caller adds each one's
 * `url`, which takes the request's host. */
export function deriveTabs({ sessions, missions = [], boards = [] }) {
  const links = boards.filter(Boolean);
  const ownerOf = bs => (bs.id != null && sessions.find(s => s.id === bs.id)) || sessions.find(s => sameProcess(s, bs)) || null;
  const held = missionSessions(missions);
  for (const link of links) {
    if (link.mission == null) continue;
    const owner = ownerOf(link.session);
    if (owner) held.ids.add(owner.id);
  }
  const heldJobs = new Set([...held.ids].map(id => id.slice(0, 8)));
  const isMissions = s => held.ids.has(s.id) || (s.pid != null && held.pids.has(s.pid)) || (s.jobId && heldJobs.has(s.jobId));
  const tabs = sessions.filter(s => !isMissions(s));
  const rounds = new Map(tabs.map(t => [t.id, []]));
  for (const link of links) {
    if (link.mission != null) continue;
    const owner = ownerOf(link.session);
    if (!owner || !rounds.has(owner.id)) continue;
    for (const n of link.open) rounds.get(owner.id).push({ board: link.id, round: n });
  }
  return tabs.map(t => {
    const linked = rounds.get(t.id);
    const state = linked.length > 0 || t.status === 'blocked' ? 'needs-you' : t.status === 'busy' ? 'working' : 'waiting';
    return {
      id: t.id,
      kind: t.kind,
      jobId: t.jobId,
      cwd: t.cwd,
      folder: folderName(t.cwd),
      login: t.login,
      name: t.name,
      command: commandOf(t.name),
      state,
      yourTurn: state === 'waiting',
      reason: t.status === 'blocked' ? t.reason : null,
      rounds: linked,
      orders: t.orders || [],
    };
  });
}
