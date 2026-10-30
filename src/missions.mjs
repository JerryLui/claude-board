// The missions ledger: one record per piece of work, across its grill, direct and landing
// sessions, kept under <home>/missions/<key>.json (src/store.mjs owns the paths and the
// atomic write). Any agent writes one, Claude, Codex or OpenCode alike, so nothing here
// knows which agent a session runs.
//
// A record holds work names, phases, links and closing summaries, never case content:
// every field a caller may write is on `MISSION_FIELDS`, typed and capped below, and
// anything else is refused rather than stored.
//
// What a reader sees is a view, derived on every read and never stored: a mission whose
// board's newest round still waits on an answer reads needs-you, ahead of everything but
// released; else a session whose process is gone, a reservation no process bound within
// `UNBOUND_GRACE_MS`, or a working one silent past `STALL_SILENCE_MS`, reads stalled, and a
// gone one also carries `gone: { lastSeenAt }`. A PR's state and head commit are the facts
// the session watcher read from GitHub (`recordPrFacts`), never the session's own words.
// The derivation needs the board store and a process table, which is why it is computed
// here and not written by whoever last touched the record.

import { randomBytes } from 'node:crypto';
import { readBoard, boardHome, readMission, writeMission, listMissions, assertMissionKey, SAFE_MISSION_KEY, MISSION_RETENTION_MS } from './store.mjs';
import { questionBlocks } from './badge.mjs';

export { SAFE_MISSION_KEY, assertMissionKey, MISSION_RETENTION_MS };

export const PHASES = ['grill', 'direct', 'landing'];
export const STORED_STATES = ['needs-you', 'working', 'waiting', 'queued', 'released'];
/** A PR's state as the session watcher reads it from GitHub at the PR's head commit. */
export const PR_STATES = ['draft', 'open', 'green', 'red', 'merged'];
/** A listed PR's state in the view before the first fact for it arrives. */
export const PR_CHECKING = 'checking';
/** What an order asks: a card's Stop or comment (`CARD_ORDER_KINDS`, the only kinds a card or
 * a tab's card may post), or `pm`, the PM's own words the Master Chief carries to the bound
 * session word for word. */
export const ORDER_KINDS = ['stop', 'comment', 'pm'];
export const CARD_ORDER_KINDS = ['stop', 'comment'];

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

function prNumber(value, what) {
  if (!Number.isInteger(value) || value <= 0) throw refuse(`${what}.number must be a positive integer`);
  return value;
}

/** A PR a session lists names it, `{ repo, number, url }`. A `state` from a writer older
 * than the PR facts is still taken, checked, and dropped: the view's state is a fact. */
function validatePr(pr, i) {
  const what = `prs[${i}]`;
  assertObject(pr, what);
  assertOnly(pr, ['repo', 'number', 'url', 'state', 'order'], what);
  if (pr.order !== undefined && !Number.isFinite(pr.order)) throw refuse(`${what}.order must be a number`);
  if (pr.state !== undefined) oneOf(pr.state, PR_STATES, `${what}.state`);
  return {
    repo: str(pr.repo, `${what}.repo`, MAX_NAME_CHARS),
    number: prNumber(pr.number, what),
    url: str(pr.url, `${what}.url`, MAX_URL_CHARS),
    ...(pr.order !== undefined ? { order: pr.order } : {}),
  };
}

function validatePrFact(fact, i, now) {
  const what = `prs[${i}]`;
  assertObject(fact, what);
  assertOnly(fact, ['repo', 'number', 'state', 'head', 'checkedAt'], what);
  return {
    repo: str(fact.repo, `${what}.repo`, MAX_NAME_CHARS),
    number: prNumber(fact.number, what),
    state: oneOf(fact.state, PR_STATES, `${what}.state`),
    head: str(fact.head, `${what}.head`, MAX_NAME_CHARS),
    checkedAt: fact.checkedAt === undefined ? iso(now) : timestamp(fact.checkedAt, `${what}.checkedAt`),
  };
}

const prKey = pr => `${pr.repo}#${pr.number}`;

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
 * something stays open for good and asks nothing. A tab card reads needs-you by the same
 * rule (src/sessions.mjs). */
export function roundWantsAnswer(round, questions) {
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
  if (boardsNeedYou(linked())) return 'needs-you';
  if (sessionStalled(m, now, isAlive)) return 'stalled';
  return m.state;
}

/** `{ lastSeenAt }` while the session bound or reserved on `m` is gone (`sessionGone`) and
 * the mission has not recorded its end, `lastSeenAt` being its last heartbeat; else null. */
function goneOf(m, now, isAlive) {
  const s = currentSession(m);
  if (!s || sessionFinished(m) || !sessionGone(s, now, isAlive)) return null;
  return { lastSeenAt: s.seenAt ?? s.startedAt ?? null };
}

/** The PRs `m` lists, each with the `state`, `head` and `checkedAt` of its latest fact,
 * or `checking` and nulls before the first. */
function prsOf(m) {
  const facts = new Map((m.prFacts || []).map(f => [prKey(f), f]));
  return (m.prs || []).map(({ state: _said, ...pr }) => {
    const fact = facts.get(prKey(pr));
    return { ...pr, state: fact ? fact.state : PR_CHECKING, head: fact ? fact.head : null, checkedAt: fact ? fact.checkedAt : null };
  });
}

/** The column `m` shows in: released stays released; then a board's round waiting on the
 * PM, whatever its session is doing; then a stalled session; else the stored state. */
export function deriveState(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  return viewState(m, () => linkedBoards(m, home), now, isAlive);
}

/** The record as a reader gets it: every stored field, `prs` with each PR's facts
 * (`prsOf`), plus `view` (the derived state), `gone` (`goneOf`), `live` (a session holds
 * the mission, `hasLiveSession`) and `actions` (`missionActions`). */
export function missionView(m, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  const linked = linkedBoards(m, home);
  return {
    ...m,
    prs: prsOf(m),
    view: viewState(m, () => linked, now, isAlive),
    gone: goneOf(m, now, isAlive),
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
 * `RELEASED_VISIBLE_MS` after it was released, or always with `all`. `records` are the
 * stored records when the caller has read them already (src/missions-cache.mjs). */
export function missionsOverview({ home = boardHome(), now = Date.now(), all = false, isAlive = pidAlive, records = null } = {}) {
  const views = (records ?? listMissions(home)).map(m => missionView(m, { home, now, isAlive }));
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

/** `POST /api/mission/:key/facts`: the session watcher's reading of the mission's PRs on
 * GitHub, `{ prs: [{ repo, number, state, head, checkedAt }] }`. Each fact replaces the one
 * held for its repo and number; a fact for a PR the mission does not list is dropped, and
 * so is a held one for a PR it no longer lists. `updatedAt` stays: a reading is not a
 * change the mission made. Answers the stored record. */
export function recordPrFacts(key, body, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['prs'], 'the body');
  if (!Array.isArray(body.prs)) throw refuse('prs must be an array');
  if (body.prs.length > MAX_PRS) throw refuse(`prs holds over ${MAX_PRS} entries`);
  const given = body.prs.map((f, i) => validatePrFact(f, i, now));
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const listed = new Set((m.prs || []).map(prKey));
  const facts = new Map((m.prFacts || []).filter(f => listed.has(prKey(f))).map(f => [prKey(f), f]));
  for (const f of given) if (listed.has(prKey(f))) facts.set(prKey(f), f);
  m.prFacts = [...facts.values()];
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
  // A session that left (`leaveMission`) went back to being a tab: its own `ended` is not
  // carried, so it never reads as this mission's again.
  const ended = m.session ? endedSession(m.session) ?? (m.session.leftAt ? null : m.session.ended) ?? null : null;
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
  assertOnly(body, ['pid', 'procStart', 'id', 'name', 'login', 'typed'], 'the body');
  if (body.typed !== undefined && typeof body.typed !== 'boolean') throw refuse('typed must be a boolean');
  const given = sessionRef(body, { needId: false });
  for (const f of ['name', 'login']) {
    if (body[f] !== undefined) given[f] = str(body[f], f, MAX_NAME_CHARS);
  }
  if (body.typed) given.typedAt = iso(now);
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

// --- binding by session id (ADR 141) ---------------------------------------------------

/** A session as a caller names itself: `id` (its agent session id, which a `/clear`
 * changes), and its process as `pid` and `procStart` (which a `/clear` keeps). */
function sessionRef(body, { needId }) {
  const ref = {};
  if (body.id !== undefined || needId) ref.id = str(body.id, 'id', MAX_NAME_CHARS);
  if (needId && !ref.id) throw refuse('id must not be empty');
  if (body.pid !== undefined) {
    if (!Number.isInteger(body.pid) || body.pid <= 0) throw refuse('pid must be a positive integer');
    ref.pid = body.pid;
  }
  if (body.procStart !== undefined) ref.procStart = timestamp(body.procStart, 'procStart');
  return ref;
}

/** Two process starts name one second: a watcher's reading and a shim's may differ in their
 * milliseconds (src/sessions.mjs reads them the same way). */
function sameStart(a, b) {
  return Math.floor(Date.parse(a) / 1000) === Math.floor(Date.parse(b) / 1000);
}

/** `ref` names the session `s`: by its id, or by its process, the same pid with no process
 * start telling them apart (a pid the OS reused has another start). */
export function sessionMatches(s, ref) {
  if (!s || !ref) return false;
  if (s.id != null && ref.id != null && s.id === ref.id) return true;
  if (s.pid == null || ref.pid == null || s.pid !== ref.pid) return false;
  return s.procStart == null || ref.procStart == null || sameStart(s.procStart, ref.procStart);
}

/** A reservation `launchMission` made that no process has bound yet. */
const isReservation = s => s.pid == null && s.id == null;

function boundFrom(ref, at, previous) {
  const ended = previous ? endedSession(previous) ?? (previous.leftAt ? null : previous.ended) ?? null : null;
  return { ...ref, startedAt: at, seenAt: at, ...(ended ? { ended } : {}) };
}

/** A join or leave refused: 409 with its own answer. */
function conflict(answer) {
  return Object.assign(refuse(answer.error, 409), { answer });
}

/** `POST /api/mission/:key/join`: a session names itself (`id`, its process as `pid` and
 * `procStart`) the one working the mission, creating the mission when it is new. It binds,
 * answering `{ status: 200, bound: true, session }`, when no session holds the mission
 * (`hasLiveSession`), when the bound one is this session (its id, or its process under a new
 * id after a `/clear`, which takes the id), or when the mission holds only a launch's
 * reservation. Another live session bound is a 409 `{ error: 'live', session }`; with
 * `takeover: true` it is recorded as `takeover: { by, at }` and answers
 * `{ status: 202, takeover: 'pending', session }`, the bound session told through
 * `bindingFor` to finish its step and leave. A fresh bind moves the mission to working, in
 * `phase` when given, and clears any takeover. */
export function joinMission(key, body, { home = boardHome(), now = Date.now(), isAlive = pidAlive } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['id', 'pid', 'procStart', 'phase', 'takeover'], 'the body');
  const ref = sessionRef(body, { needId: true });
  const phase = body.phase === undefined ? undefined : oneOf(body.phase, PHASES, 'phase');
  if (body.takeover !== undefined && typeof body.takeover !== 'boolean') throw refuse('takeover must be a boolean');
  const m = readMission(key, home) || newMission(key, now, { phase: phase || 'grill', state: 'working' });
  const at = iso(now);
  const bound = currentSession(m);
  let answer;
  if (bound && !isReservation(bound) && sessionMatches(bound, ref)) {
    m.session = { ...bound, ...ref, seenAt: at };
    if (phase && phase !== m.phase) moveTo(m, { phase }, now);
    answer = { status: 200, bound: true, session: m.session };
  } else if (bound && isReservation(bound) && hasLiveSession(m, now, isAlive)) {
    m.session = { ...bound, ...ref, seenAt: at };
    delete m.takeover;
    moveTo(m, { phase: phase || m.phase, state: 'working' }, now);
    answer = { status: 200, bound: true, session: m.session };
  } else if (bound && hasLiveSession(m, now, isAlive)) {
    if (!body.takeover) throw conflict({ error: 'live', session: m.session });
    // The latest asker is the one bound at the leave; one asking again keeps its first `at`.
    const since = m.takeover?.by === ref.id ? m.takeover.at : at;
    m.takeover = { by: ref.id, ...(ref.pid !== undefined ? { pid: ref.pid } : {}), ...(ref.procStart !== undefined ? { procStart: ref.procStart } : {}), at: since };
    answer = { status: 202, takeover: 'pending', session: m.session };
  } else {
    m.session = boundFrom(ref, at, m.session);
    delete m.takeover;
    delete m.queue;
    moveTo(m, { phase: phase || m.phase, state: 'working' }, now);
    answer = { status: 200, bound: true, session: m.session };
  }
  touch(m, now);
  writeMission(m, home);
  return answer;
}

/** `POST /api/mission/:key/leave`: the bound session lets the mission go. With a takeover
 * pending, the session that asked for it is bound in its place and `takeover` cleared,
 * answering `{ left: true, session }` with the new session; else the mission holds
 * `session: { ended, leftAt }` and, stored working, moves to waiting, answering
 * `{ left: true, session: null }`. A session that left is no longer the mission's: it reads
 * as a tab again (src/sessions.mjs `deriveTabs`). Any other session is a 409
 * `{ error: 'not bound', session }`. */
export function leaveMission(key, body, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['id', 'pid', 'procStart'], 'the body');
  const ref = sessionRef(body, { needId: true });
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const bound = currentSession(m);
  if (!bound || isReservation(bound) || !sessionMatches(bound, ref)) throw conflict({ error: 'not bound', session: m.session ?? null });
  const at = iso(now);
  const t = m.takeover;
  if (t) {
    const next = { id: t.by, ...(t.pid !== undefined ? { pid: t.pid } : {}), ...(t.procStart !== undefined ? { procStart: t.procStart } : {}) };
    m.session = boundFrom(next, at, bound);
    delete m.takeover;
    moveTo(m, { state: 'working' }, now);
  } else {
    m.session = { ended: endedSession(bound), leftAt: at };
    if (m.state === 'working') moveTo(m, { state: 'waiting' }, now);
  }
  touch(m, now);
  writeMission(m, home);
  return { left: true, session: t ? m.session : null };
}

/** The pm orders on `m` its session has not marked seen, oldest first. */
const unseenOrders = m => (m.orders || []).filter(o => o.kind === 'pm' && !o.ackedAt);

/** `GET /api/binding`: the mission `ref` (`{ id, pid?, procStart? }`) is bound to among the
 * stored `records`, with its pending `takeover` (`{ by, at }`), its pm orders not yet seen and
 * its `handoff`; all null and empty when it is bound to none. A released mission, a launch's
 * bare reservation and a session that left bind no one. A plain scan of the records, nothing
 * derived: a hook asks it every minute (src/bindings.mjs keeps the records). */
export function bindingFor(records, ref) {
  let hit = null;
  for (const m of records) {
    const s = currentSession(m);
    if (!s || isReservation(s) || m.state === 'released' || !sessionMatches(s, ref)) continue;
    if (!hit || String(s.seenAt) > String(currentSession(hit).seenAt)) hit = m;
  }
  if (!hit) return { key: null, takeover: null, orders: [], handoff: null };
  return {
    key: hit.key,
    takeover: hit.takeover ? { by: hit.takeover.by, at: hit.takeover.at } : null,
    orders: unseenOrders(hit),
    handoff: hit.handoff ?? null,
  };
}

/** `POST /api/mission/:key/order`: appends an order and answers it. A card posts a stop or
 * a comment (`by: 'card'`); the Master Chief posts `pm`, the PM's words for the session
 * (`by: 'master-chief'`). A comment and a pm order need their `text`. */
export function addOrder(key, body, { home = boardHome(), now = Date.now() } = {}) {
  assertMissionKey(key);
  assertObject(body, 'the body');
  assertOnly(body, ['kind', 'text'], 'the body');
  const kind = oneOf(body.kind, ORDER_KINDS, 'kind');
  const text = body.text === undefined ? undefined : bytes(body.text, 'text', MAX_TEXT_BYTES);
  if (kind !== 'stop' && !(text && text.trim())) throw refuse(`a ${kind} order needs its text`);
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const by = kind === 'pm' ? 'master-chief' : 'card';
  const order = { id: `o_${randomBytes(8).toString('hex')}`, kind, ...(text !== undefined ? { text } : {}), at: iso(now), by };
  m.orders = [...(m.orders || []), order].slice(-MAX_ORDERS);
  touch(m, now);
  writeMission(m, home);
  return order;
}

/** Sets `field` on order `id` of mission `key` to now, once; a repeat keeps the first. `check`
 * runs on the record before the write. Answers the order. */
function markOrder(key, id, field, { home, now, check = () => {} }) {
  assertMissionKey(key);
  const m = readMission(key, home);
  if (!m) throw notFound(key);
  const order = (m.orders || []).find(o => o.id === id);
  if (!order) throw refuse(`order not found: ${id}`, 404);
  check(m);
  if (!order[field]) {
    order[field] = iso(now);
    touch(m, now);
    writeMission(m, home);
  }
  return order;
}

/** `POST /api/mission/:key/order/:id/ack`: the Master Chief relayed the order; sets
 * `relayedAt` once. Answers the order. */
export function ackOrder(key, id, { home = boardHome(), now = Date.now() } = {}) {
  return markOrder(key, id, 'relayedAt', { home, now });
}

/** `POST /api/mission/:key/order/:id/seen`: the bound session acknowledges the order, by its
 * id or its process; sets `ackedAt` once, the mark the card shows. Another session is a 409
 * `{ error: 'not bound', session }`. Answers the order. */
export function seenOrder(key, id, body, { home = boardHome(), now = Date.now() } = {}) {
  assertObject(body, 'the body');
  assertOnly(body, ['id', 'pid', 'procStart'], 'the body');
  const ref = sessionRef(body, { needId: true });
  return markOrder(key, id, 'ackedAt', {
    home, now,
    check: m => {
      const s = currentSession(m);
      if (!s || isReservation(s) || !sessionMatches(s, ref)) throw conflict({ error: 'not bound', session: m.session ?? null });
    },
  });
}

/** `POST /api/mission/:key/order/:id/resent`: the Master Chief sent an unseen order once
 * more; sets `resentAt` once, so it is never sent a third time. Answers the order. */
export function resentOrder(key, id, { home = boardHome(), now = Date.now() } = {}) {
  return markOrder(key, id, 'resentAt', { home, now });
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
