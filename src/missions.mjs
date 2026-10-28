// The missions ledger: one record per piece of work, across its grill, direct and landing
// sessions, kept under <home>/missions/<key>.json (src/store.mjs owns the paths and the
// atomic write). Any agent writes one, Claude, Codex or OpenCode alike, so nothing here
// knows which agent a session runs.
//
// A record holds work names, phases, links and closing summaries, never case content:
// every field a caller may write is on `MISSION_FIELDS`, typed and capped below, and
// anything else is refused rather than stored.
//
// What a reader sees is a view, derived on every read and never stored: a session whose
// process is gone, or a working one silent past `STALL_SILENCE_MS`, reads stalled; a mission
// whose board holds a round still waiting on an answer reads needs-you. The derivation
// needs the board store and a process table, which is why it is computed here and not
// written by whoever last touched the record.

import { randomBytes } from 'node:crypto';
import { readBoard, boardHome, readMission, writeMission, listMissions, assertMissionKey, SAFE_MISSION_KEY, MISSION_RETENTION_MS } from './store.mjs';
import { questionBlocks } from './badge.mjs';

export { SAFE_MISSION_KEY, assertMissionKey, MISSION_RETENTION_MS };

export const PHASES = ['grill', 'direct', 'landing'];
export const STORED_STATES = ['needs-you', 'working', 'waiting', 'queued', 'landed'];
export const PR_STATES = ['draft', 'open', 'green', 'merged'];
export const ORDER_KINDS = ['stop', 'comment'];

/** The fields `POST /api/mission/:key` may write; anything else in its body is a 400. */
export const MISSION_FIELDS = ['title', 'cwd', 'phase', 'state', 'summary', 'waitingOn', 'next', 'prs', 'handoff', 'fire', 'queue', 'retiredAt'];

/** At most this many sessions work at once, and at most `MAX_ALIVE` are alive; past either,
 * a launch queues. A session waiting on the PM is alive but not working. */
export const MAX_WORKING = 6;
export const MAX_ALIVE = 12;

/** A working session silent this long reads stalled. */
export const STALL_SILENCE_MS = 15 * 60 * 1000;

/** A landed mission leaves the default list this long after `landedAt`. */
export const LANDED_VISIBLE_MS = 24 * 60 * 60 * 1000;

export const MAX_SUMMARY_CHARS = 280;
export const MAX_HANDOFF_BYTES = 4096;
const MAX_PHRASE_CHARS = 280;
const MAX_TITLE_CHARS = 200;
const MAX_NAME_CHARS = 200;
const MAX_PATH_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const MAX_TEXT_BYTES = 4096;
const MAX_PRS = 50;
const MAX_HISTORY = 200;
const MAX_ORDERS = 200;
const MAX_BOARDS = 200;

const iso = ms => new Date(ms).toISOString();

function refuse(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function notFound(key) {
  return refuse(`mission not found: ${key}`, 404);
}

/** True while a process with this pid exists. `EPERM` is a process this user cannot signal,
 * which still exists. */
export function pidAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// --- validation -----------------------------------------------------------------------

function assertObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse(`${what} must be an object`);
}

function assertOnly(obj, allowed, what) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw refuse(`${what} has an unknown field: ${k}`);
  }
}

function str(value, what, maxChars) {
  if (typeof value !== 'string') throw refuse(`${what} must be a string`);
  if (value.length > maxChars) throw refuse(`${what} is over ${maxChars} characters`);
  return value;
}

function bytes(value, what, maxBytes) {
  if (typeof value !== 'string') throw refuse(`${what} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw refuse(`${what} is over ${maxBytes} bytes`);
  return value;
}

function oneOf(value, allowed, what) {
  if (!allowed.includes(value)) throw refuse(`${what} must be one of ${allowed.join(', ')}`);
  return value;
}

function timestamp(value, what) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw refuse(`${what} must be an ISO-8601 timestamp`);
  return value;
}

function validatePr(pr, i) {
  const what = `prs[${i}]`;
  assertObject(pr, what);
  assertOnly(pr, ['repo', 'number', 'url', 'state', 'order'], what);
  if (!Number.isInteger(pr.number) || pr.number <= 0) throw refuse(`${what}.number must be a positive integer`);
  if (pr.order !== undefined && !Number.isFinite(pr.order)) throw refuse(`${what}.order must be a number`);
  return {
    repo: str(pr.repo, `${what}.repo`, MAX_NAME_CHARS),
    number: pr.number,
    url: str(pr.url, `${what}.url`, MAX_URL_CHARS),
    state: oneOf(pr.state, PR_STATES, `${what}.state`),
    ...(pr.order !== undefined ? { order: pr.order } : {}),
  };
}

/** One validator per writable field; each answers the value to store, or throws a 400.
 * `null` clears an optional field and is refused on a required one. */
const FIELD_RULES = {
  title: v => {
    str(v, 'title', MAX_TITLE_CHARS);
    if (!v.trim()) throw refuse('title must not be empty');
    return v;
  },
  cwd: v => str(v, 'cwd', MAX_PATH_CHARS),
  phase: v => oneOf(v, PHASES, 'phase'),
  state: v => oneOf(v, STORED_STATES, 'state'),
  summary: v => str(v, 'summary', MAX_SUMMARY_CHARS),
  waitingOn: v => str(v, 'waitingOn', MAX_PHRASE_CHARS),
  next: v => str(v, 'next', MAX_PHRASE_CHARS),
  prs: v => {
    if (!Array.isArray(v)) throw refuse('prs must be an array');
    if (v.length > MAX_PRS) throw refuse(`prs holds over ${MAX_PRS} entries`);
    return v.map(validatePr);
  },
  handoff: v => bytes(v, 'handoff', MAX_HANDOFF_BYTES),
  fire: (v, now) => {
    assertObject(v, 'fire');
    assertOnly(v, ['at', 'by'], 'fire');
    return { at: v.at === undefined ? iso(now) : timestamp(v.at, 'fire.at'), by: oneOf(v.by, ['round', 'card'], 'fire.by') };
  },
  queue: (v, now) => {
    assertObject(v, 'queue');
    assertOnly(v, ['phase', 'prompt', 'login', 'at'], 'queue');
    return {
      phase: oneOf(v.phase, PHASES, 'queue.phase'),
      prompt: bytes(v.prompt, 'queue.prompt', MAX_TEXT_BYTES),
      ...(v.login !== undefined ? { login: str(v.login, 'queue.login', MAX_NAME_CHARS) } : {}),
      at: v.at === undefined ? iso(now) : timestamp(v.at, 'queue.at'),
    };
  },
  retiredAt: v => timestamp(v, 'retiredAt'),
};

const REQUIRED_FIELDS = new Set(['title', 'phase', 'state', 'prs']);

function validatePatch(patch, now) {
  assertObject(patch, 'the body');
  assertOnly(patch, MISSION_FIELDS, 'the body');
  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      if (REQUIRED_FIELDS.has(field)) throw refuse(`${field} cannot be cleared`);
      out[field] = null;
    } else {
      out[field] = FIELD_RULES[field](value, now);
    }
  }
  return out;
}

// --- the record -----------------------------------------------------------------------

function newMission(key, now, { phase = 'grill', state = 'waiting' } = {}) {
  const at = iso(now);
  return {
    key,
    title: key,
    phase,
    state,
    prs: [],
    boards: [],
    session: null,
    orders: [],
    history: [{ at, phase, state }],
    createdAt: at,
    updatedAt: at,
  };
}

/** Moves `phase` and `state`, appending to `history` when either changed and keeping
 * `landedAt` to the moment the mission last became landed. */
function moveTo(m, { phase = m.phase, state = m.state }, now) {
  const changed = phase !== m.phase || state !== m.state;
  if (state === 'landed' && (m.state !== 'landed' || !m.landedAt)) m.landedAt = iso(now);
  if (state !== 'landed') delete m.landedAt;
  m.phase = phase;
  m.state = state;
  if (changed) {
    m.history = [...(m.history || []), { at: iso(now), phase, state }].slice(-MAX_HISTORY);
  }
}

function touch(m, now) {
  m.updatedAt = iso(now);
}

// --- the view -------------------------------------------------------------------------

function sessionStalled(m, now, isAlive) {
  const s = m.session;
  if (!s) return false;
  if (s.pid != null && !isAlive(s.pid)) return true;
  if (m.state !== 'working') return false;
  const seen = Date.parse(s.seenAt);
  return !Number.isFinite(seen) || now - seen > STALL_SILENCE_MS;
}

/** True while a session is bound to `m` and has not stalled. A session reserved at launch
 * counts from its reservation, before any process binds to it. */
function hasLiveSession(m, now, isAlive) {
  return !!m.session && !sessionStalled(m, now, isAlive);
}

/** A round still waiting on the PM: open (neither sent nor abandoned) and one that asks for
 * an answer, by a question in it or by a wait it was minted with. A round that only shows
 * something stays open for good and asks nothing. */
function roundWantsAnswer(board, round) {
  if (round.status !== 'open') return false;
  if (round.awaitDeadline) return true;
  return questionBlocks(board).some(q => q.round === round.n);
}

function boardsNeedYou(m, home) {
  for (const link of m.boards || []) {
    let board;
    try {
      board = readBoard(link.id, home);
    } catch {
      continue;
    }
    if (board && (board.rounds || []).some(r => roundWantsAnswer(board, r))) return true;
  }
  return false;
}

/** The column `m` shows in: landed stays landed; a stalled session wins over everything
 * else; then a board waiting on the PM; else the stored state. */
export function deriveState(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  if (m.state === 'landed') return 'landed';
  if (sessionStalled(m, now, isAlive)) return 'stalled';
  if (boardsNeedYou(m, home)) return 'needs-you';
  return m.state;
}

/** The record as a reader gets it: every stored field, plus `view` (the derived state) and
 * `live` (a session is bound and has not stalled). */
export function missionView(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  return { ...m, view: deriveState(m, { home, now, isAlive }), live: hasLiveSession(m, now, isAlive) };
}

function liveCounts(views) {
  const live = { working: 0, alive: 0 };
  for (const v of views) {
    if (!v.live) continue;
    live.alive += 1;
    if (v.view === 'working') live.working += 1;
  }
  return live;
}

function landedLongAgo(m, now) {
  if (m.state !== 'landed') return false;
  const at = Date.parse(m.landedAt || m.updatedAt);
  return Number.isFinite(at) && now - at >= LANDED_VISIBLE_MS;
}

/** `GET /api/missions`: the views, newest change first, with per-column counts over the
 * missions listed and `live` counts over every mission. A landed mission is listed until
 * `LANDED_VISIBLE_MS` after it landed, or always with `all`. */
export function missionsOverview({ home = boardHome(), now = Date.now(), all = false, isAlive = pidAlive } = {}) {
  const views = listMissions(home).map(m => missionView(m, { home, now, isAlive }));
  const missions = (all ? views : views.filter(v => !landedLongAgo(v, now)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const counts = { needsYou: 0, working: 0, waiting: 0, stalled: 0, landed: 0, queued: 0 };
  for (const v of missions) counts[v.view === 'needs-you' ? 'needsYou' : v.view] += 1;
  return { missions, counts, live: liveCounts(views), now: iso(now) };
}

/** `GET /api/mission/:key`: the view, or a 404. */
export function getMissionView(key, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  return missionView(m, { home, now, isAlive });
}

// --- writes ---------------------------------------------------------------------------

/** `POST /api/mission/:key`: writes the whitelisted fields, creating the mission when it is
 * new (phase `grill`, state `waiting`, titled by its key, until the patch says otherwise).
 * Answers the stored record. */
export function upsertMission(key, patch, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  const fields = validatePatch(patch, now);
  const m = readMission(key, home) || newMission(key, now, {
    phase: fields.phase || 'grill',
    state: fields.state || 'waiting',
  });
  const { phase, state, ...rest } = fields;
  for (const [field, value] of Object.entries(rest)) {
    if (value === null) delete m[field];
    else m[field] = value;
  }
  moveTo(m, { phase, state }, now);
  touch(m, now);
  return writeMission(m, home);
}

/** `POST /api/mission/:key/launch`: the one check that keeps a mission to one live session.
 * A live session already bound throws a 409 carrying it. Past `MAX_WORKING` working or
 * `MAX_ALIVE` alive sessions across the other missions, the mission queues with its launch
 * recorded in `queue` and answers `{ queued: true }`; else a session is reserved, the
 * mission moves to working in `phase`, and it answers `{ launch: true }`. */
export function launchMission(key, body, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['phase', 'login', 'prompt'], 'the body');
  const phase = oneOf(body.phase, PHASES, 'phase');
  const login = body.login === undefined ? undefined : str(body.login, 'login', MAX_NAME_CHARS);
  const prompt = body.prompt === undefined ? undefined : bytes(body.prompt, 'prompt', MAX_TEXT_BYTES);

  const m = readMission(key, home) || newMission(key, now, { phase });
  if (hasLiveSession(m, now, isAlive)) {
    throw Object.assign(refuse('live', 409), { session: m.session });
  }
  const others = listMissions(home).filter(o => o.key !== key).map(o => missionView(o, { home, now, isAlive }));
  const live = liveCounts(others);
  const at = iso(now);
  let answer;
  if (live.working >= MAX_WORKING || live.alive >= MAX_ALIVE) {
    m.queue = { phase, prompt: prompt ?? '', ...(login !== undefined ? { login } : {}), at };
    moveTo(m, { phase, state: 'queued' }, now);
    answer = { queued: true };
  } else {
    m.session = { startedAt: at, seenAt: at, ...(login !== undefined ? { login } : {}) };
    delete m.queue;
    moveTo(m, { phase, state: 'working' }, now);
    answer = { launch: true };
  }
  touch(m, now);
  writeMission(m, home);
  return answer;
}

/** `POST /api/mission/:key/session`: binds a session, or heartbeats the one bound
 * (`seenAt` now). A different pid while the bound one is still alive is a second live
 * session and throws a 409 carrying the bound one; a different pid after the bound one died
 * starts a fresh session. Answers the stored record. */
export function bindSession(key, body, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['pid', 'id', 'name', 'login'], 'the body');
  if (body.pid !== undefined && (!Number.isInteger(body.pid) || body.pid <= 0)) throw refuse('pid must be a positive integer');
  const given = { ...(body.pid !== undefined ? { pid: body.pid } : {}) };
  for (const f of ['id', 'name', 'login']) {
    if (body[f] !== undefined) given[f] = str(body[f], f, MAX_NAME_CHARS);
  }
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const at = iso(now);
  const bound = m.session;
  const otherPid = bound && bound.pid != null && given.pid !== undefined && given.pid !== bound.pid;
  if (otherPid && isAlive(bound.pid)) {
    throw Object.assign(refuse('live', 409), { session: bound });
  }
  m.session = !bound || otherPid
    ? { ...given, startedAt: at, seenAt: at }
    : { ...bound, ...given, seenAt: at };
  touch(m, now);
  return writeMission(m, home);
}

/** `POST /api/mission/:key/order`: appends a stop or comment order from the mission's card,
 * and answers it. A comment needs its `text`. */
export function addOrder(key, body, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['kind', 'text'], 'the body');
  const kind = oneOf(body.kind, ORDER_KINDS, 'kind');
  const text = body.text === undefined ? undefined : bytes(body.text, 'text', MAX_TEXT_BYTES);
  if (kind === 'comment' && !(text && text.trim())) throw refuse('a comment order needs its text');
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const order = { id: `o_${randomBytes(8).toString('hex')}`, kind, ...(text !== undefined ? { text } : {}), at: iso(now), by: 'card' };
  m.orders = [...(m.orders || []), order].slice(-MAX_ORDERS);
  touch(m, now);
  writeMission(m, home);
  return order;
}

/** `POST /api/mission/:key/order/:id/ack`: marks an order relayed, once; a repeat keeps the
 * first `relayedAt`. Answers the order. */
export function ackOrder(key, id, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const order = (m.orders || []).find(o => o.id === id);
  if (!order) throw refuse(`order not found: ${id}`, 404);
  if (!order.relayedAt) {
    order.relayedAt = iso(now);
    touch(m, now);
    writeMission(m, home);
  }
  return order;
}

/** A board posted with `mission: <key>`: appends `{ id, url, at }` to the mission's `boards`
 * (a board already listed moves to the end, so the last entry is the latest board), making
 * a stub mission when there is none. Answers the stored record. */
export function linkBoard(key, { id, url }, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  const m = readMission(key, home) || newMission(key, now);
  m.boards = [...(m.boards || []).filter(b => b.id !== id), { id, url, at: iso(now) }].slice(-MAX_BOARDS);
  touch(m, now);
  return writeMission(m, home);
}
