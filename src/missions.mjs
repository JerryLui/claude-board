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
// process is gone, a reservation no process bound within `UNBOUND_GRACE_MS`, or a working
// one silent past `STALL_SILENCE_MS`, reads stalled; a mission whose board's newest round
// still waits on an answer reads needs-you. The derivation needs the board store and a
// process table, which is why it is computed here and not written by whoever last touched
// the record.

import { randomBytes } from 'node:crypto';
import { readBoard, boardHome, readMission, writeMission, listMissions, assertMissionKey, SAFE_MISSION_KEY, MISSION_RETENTION_MS } from './store.mjs';
import { questionBlocks } from './badge.mjs';

export { SAFE_MISSION_KEY, assertMissionKey, MISSION_RETENTION_MS };

export const PHASES = ['grill', 'direct', 'landing'];
export const STORED_STATES = ['needs-you', 'working', 'waiting', 'queued', 'released'];
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

/** A session reserved at launch that no process has bound (no `pid`, no `id`) this long
 * after its reservation reads stalled: its start failed, and the mission may launch again.
 * A good start binds within seconds. */
export const UNBOUND_GRACE_MS = 5 * 60 * 1000;

/** A released mission leaves the default list this long after `releasedAt`. */
export const RELEASED_VISIBLE_MS = 24 * 60 * 60 * 1000;

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
  // `landed`, the name before released (ADR 130), is still taken, as released: a session
  // open since before the rename writes it.
  state: v => oneOf(v === 'landed' ? 'released' : v, STORED_STATES, 'state'),
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

/** Moves `phase` and `state`, appending to `history` when either changed, keeping
 * `releasedAt` to the moment the mission last became released, and dropping `waitingOn`
 * when the mission leaves needs-you, since what it waited on is past (ADR 130). */
function moveTo(m, { phase = m.phase, state = m.state }, now) {
  const changed = phase !== m.phase || state !== m.state;
  if (m.state === 'needs-you' && state !== 'needs-you') delete m.waitingOn;
  if (state === 'released' && (m.state !== 'released' || !m.releasedAt)) m.releasedAt = iso(now);
  if (state !== 'released') delete m.releasedAt;
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

/** The session bound or reserved on `m`, or null. A launch that queued leaves a record
 * holding only `ended`, the session it replaced: that is no session. */
function currentSession(m) {
  const s = m.session;
  return s && (s.pid != null || s.id != null || s.startedAt) ? s : null;
}

/** The bound process is gone, or a reservation no process bound within `UNBOUND_GRACE_MS`:
 * nothing holds the mission any more. */
function sessionGone(s, now, isAlive) {
  if (s.pid != null && !isAlive(s.pid)) return true;
  if (s.pid != null || s.id != null) return false;
  const reserved = Date.parse(s.startedAt);
  return !Number.isFinite(reserved) || now - reserved > UNBOUND_GRACE_MS;
}

/** A working session that has not heartbeat for `STALL_SILENCE_MS`. */
function sessionSilent(m, now) {
  if (m.state !== 'working') return false;
  const seen = Date.parse(m.session.seenAt);
  return !Number.isFinite(seen) || now - seen > STALL_SILENCE_MS;
}

/** The mission recorded the end of its session: a grill answered Fire records `fire` and
 * stops, and a released mission's session has closed. Its process may linger, idle, but it
 * holds neither the mission nor a slot. */
function sessionFinished(m) {
  return m.state === 'released' || (m.phase === 'grill' && !!m.fire);
}

/** A session that should be running and is not heard from: gone, or silent while working.
 * A session whose mission recorded its end is expected to stop, so it never stalls. */
function sessionStalled(m, now, isAlive) {
  const s = currentSession(m);
  if (!s || sessionFinished(m)) return false;
  return sessionGone(s, now, isAlive) || sessionSilent(m, now);
}

/** `s` still holds its mission, whatever the mission recorded: not gone, and bound by a pid
 * or heard from inside `STALL_SILENCE_MS`. */
function sessionHolds(m, s, now, isAlive) {
  if (sessionGone(s, now, isAlive)) return false;
  return s.pid != null || !sessionSilent(m, now);
}

/** True while a session holds `m`: bound or reserved, its mission has not recorded its end,
 * and it is not gone. A reservation counts before any process binds to it, for
 * `UNBOUND_GRACE_MS`. Silence alone frees the mission only when no pid is bound: a session
 * whose process lives still holds it while it reads stalled (a long turn, or a director idle
 * while its owners run), so a successor never runs beside it. */
function hasLiveSession(m, now, isAlive) {
  const s = currentSession(m);
  return !!s && !sessionFinished(m) && sessionHolds(m, s, now, isAlive);
}

/** Each linked board that reads, once, with its question blocks. */
function linkedBoards(m, home) {
  const linked = [];
  for (const link of m.boards || []) {
    let board;
    try {
      board = readBoard(link.id, home);
    } catch {
      continue;
    }
    if (board) linked.push({ board, questions: questionBlocks(board) });
  }
  return linked;
}

/** A round still waiting on the PM: open (neither sent nor abandoned) and one that asks for
 * an answer, by a question in it or by a wait it was minted with. A round that only shows
 * something stays open for good and asks nothing. */
function roundWantsAnswer(round, questions) {
  if (round.status !== 'open') return false;
  if (round.awaitDeadline) return true;
  return questions.some(q => q.round === round.n);
}

/** The round of `board` that can hold its mission at needs you: its newest, when that one
 * still wants an answer. An older page left open is answered from its own page on the
 * board, and never holds the mission there. */
function waitingRound({ board, questions }) {
  const rounds = board.rounds || [];
  const newest = rounds[rounds.length - 1];
  return newest && roundWantsAnswer(newest, questions) ? newest : null;
}

function boardsNeedYou(linked) {
  return linked.some(entry => waitingRound(entry) !== null);
}

function actionsOf(linked) {
  const actions = [];
  for (const entry of linked) {
    const round = waitingRound(entry);
    if (!round) continue;
    const { board, questions } = entry;
    for (const q of questions) {
      if (q.round !== round.n || !q.action || q.widget !== 'single' || !q.options?.length) continue;
      actions.push({ kind: q.action, board: board.id, round: round.n, question: q.id, choice: q.options[0].label });
    }
  }
  return actions;
}

/** The buttons `m`'s card offers: one per question carrying an `action` (Fire or Merge)
 * in a linked board's newest round while it waits on the PM, as `waitingRound` reads it. A
 * click answers `question` in `round` of `board` with option 0, whose label is `choice`. A
 * sent or abandoned round, or an older one, offers none. */
export function missionActions(m, { home = boardHome() } = {}) {
  return actionsOf(linkedBoards(m, home));
}

function viewState(m, linked, now, isAlive) {
  if (m.state === 'released') return 'released';
  if (sessionStalled(m, now, isAlive)) return 'stalled';
  if (boardsNeedYou(linked())) return 'needs-you';
  return m.state;
}

/** The column `m` shows in: released stays released; a stalled session wins over everything
 * else; then a board waiting on the PM; else the stored state. */
export function deriveState(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  return viewState(m, () => linkedBoards(m, home), now, isAlive);
}

/** The record as a reader gets it: every stored field, plus `view` (the derived state),
 * `live` (a session holds the mission, `hasLiveSession`) and `actions` (`missionActions`). */
export function missionView(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  const linked = linkedBoards(m, home);
  return {
    ...m,
    view: viewState(m, () => linked, now, isAlive),
    live: hasLiveSession(m, now, isAlive),
    actions: actionsOf(linked),
  };
}

function liveCounts(views) {
  const live = { working: 0, alive: 0 };
  for (const v of views) {
    if (!v.live) continue;
    live.alive += 1;
    // A live session reading stalled is one silent while working: it still works.
    if (v.view === 'working' || v.view === 'stalled') live.working += 1;
  }
  return live;
}

function releasedLongAgo(m, now) {
  if (m.state !== 'released') return false;
  const at = Date.parse(m.releasedAt || m.updatedAt);
  return Number.isFinite(at) && now - at >= RELEASED_VISIBLE_MS;
}

/** `GET /api/missions`: the views, newest change first, with per-column counts over the
 * missions listed and `live` counts over every mission. A released mission is listed until
 * `RELEASED_VISIBLE_MS` after it was released, or always with `all`. */
export function missionsOverview({ home = boardHome(), now = Date.now(), all = false, isAlive = pidAlive } = {}) {
  const views = listMissions(home).map(m => missionView(m, { home, now, isAlive }));
  const missions = (all ? views : views.filter(v => !releasedLongAgo(v, now)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const counts = { needsYou: 0, working: 0, waiting: 0, stalled: 0, released: 0, queued: 0 };
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
  // The move first, so a `waitingOn` the same patch sets outlives the one the move drops.
  moveTo(m, { phase, state }, now);
  for (const [field, value] of Object.entries(rest)) {
    if (value === null) delete m[field];
    else m[field] = value;
  }
  touch(m, now);
  return writeMission(m, home);
}

/** `POST /api/mission/:key/launch`: the one check that keeps a mission to one live session.
 * A live session already bound throws a 409 carrying it, and `silent: true` when it reads
 * stalled by silence with its process alive. Past `MAX_WORKING` working or
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
    const silent = sessionSilent(m, now);
    throw Object.assign(refuse('live', 409), { session: m.session, ...(silent ? { silent } : {}) });
  }
  // The session this launch replaces is over, finished or gone or silent, yet its process
  // may still run: its pid and id never bind the next one. A record that is only `ended`
  // passes its own on.
  const ended = m.session ? endedSession(m.session) ?? m.session.ended ?? null : null;
  const others = listMissions(home).filter(o => o.key !== key).map(o => missionView(o, { home, now, isAlive }));
  const live = liveCounts(others);
  const at = iso(now);
  let answer;
  if (live.working >= MAX_WORKING || live.alive >= MAX_ALIVE) {
    m.queue = { phase, prompt: prompt ?? '', ...(login !== undefined ? { login } : {}), at };
    // A queued mission has no session: one kept here would read live and never dequeue.
    m.session = ended ? { ended } : null;
    moveTo(m, { phase, state: 'queued' }, now);
    answer = { queued: true };
  } else {
    m.session = { startedAt: at, seenAt: at, ...(login !== undefined ? { login } : {}), ...(ended ? { ended } : {}) };
    delete m.queue;
    moveTo(m, { phase, state: 'working' }, now);
    answer = { launch: true };
  }
  touch(m, now);
  writeMission(m, home);
  return answer;
}

/** The `pid` and `id` of a session that ended, kept on the session launched after it. */
function endedSession(s) {
  const ended = { ...(s.pid != null ? { pid: s.pid } : {}), ...(s.id != null ? { id: s.id } : {}) };
  return Object.keys(ended).length ? ended : null;
}

/** `POST /api/mission/:key/session`: binds a session, or heartbeats the one bound
 * (`seenAt` now); the bound pid under a new id is a heartbeat that takes the id. A
 * different pid, or a different id when the bound session has no pid, while the bound one
 * still holds the mission (`sessionHolds`) is a second live session and throws a 409
 * carrying the bound one; once the bound one is gone, or silent with no pid, it starts a
 * fresh session. The pid or id of the session that ended before this launch is a 409 too:
 * that process lingers, and must not take its successor's place. Answers the stored record. */
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
  const bound = currentSession(m);
  const ended = m.session?.ended;
  const otherPid = bound && bound.pid != null && given.pid !== undefined && given.pid !== bound.pid;
  // A session bound by pid is that process: its own bind under a new id (after a /clear)
  // is its heartbeat. Only a session bound by id alone is told apart by its id.
  const otherId = bound && bound.pid == null && bound.id != null && given.id !== undefined && given.id !== bound.id;
  const endedOne = ended
    && ((given.pid !== undefined && given.pid === ended.pid) || (given.id !== undefined && given.id === ended.id));
  if (endedOne || ((otherPid || otherId) && sessionHolds(m, bound, now, isAlive))) {
    throw Object.assign(refuse('live', 409), { session: m.session });
  }
  m.session = !bound || otherPid || otherId
    ? { ...given, startedAt: at, seenAt: at, ...(ended ? { ended } : {}) }
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

/** True when `round` of `board`, as just submitted, answered a `single` question carrying
 * `action: 'fire'` with option 0. Any other pick, or a round with no such question, fires
 * nothing. */
export function roundFired(board, round) {
  return questionBlocks(board).some(q => {
    if (q.round !== round || q.action !== 'fire' || q.widget !== 'single' || !q.options?.length) return false;
    const answer = board.answers?.[q.id];
    return !!answer && answer.status === 'answered' && answer.choice === q.options[0].label;
  });
}

/** A submit that fired its round (`roundFired`): records `fire: { at, by }` on the board's
 * mission, `by` being `'card'` for a click on the mission's card and `'round'` for a Send or
 * a relay. The board writes it itself, so a Fire lands on the mission whether or not the
 * grill session that asked is still there to copy it. Answers the stored record, or null
 * when the round fired nothing or the board has no mission. */
export function recordFire(board, round, by, { home = boardHome(), now = Date.now() } = {}) {
  if (!board.mission || !roundFired(board, round)) return null;
  return upsertMission(board.mission, { fire: { by } }, { home, now });
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
