// The missions ledger (src/missions.mjs) and its routes under /api/mission and
// /api/missions: a daemon on a temp store, real child processes for a live and a dead
// session, and the store functions with an injected clock where a route cannot wait the
// fifteen minutes or the day a rule is about.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import { readBoard, readMission, writeMission, pruneStore, MISSION_RETENTION_MS } from '../src/store.mjs';
import {
  missionsOverview, launchMission, bindSession, upsertMission, deriveState, MAX_WORKING, MAX_ALIVE, STALL_SILENCE_MS, UNBOUND_GRACE_MS, LANDED_VISIBLE_MS,
} from '../src/missions.mjs';
import { check, rawRequest, runMain, secretFetch, secretHome, sessionCookieHeader, waitFor, writeHeaders } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-missions-');
const fetch = secretFetch(SECRET);
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);

let server, port, base;
const children = new Set();

/** A process that stays up until the check kills it: a session's live pid. */
function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(child);
  return child;
}

/** Kills `child` and resolves once it has exited, so its pid is gone. */
function endProcess(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  }).then(() => children.delete(child));
}

/** A pid that belonged to a process that has already exited. */
async function deadPid() {
  const child = liveProcess();
  await endProcess(child);
  return child.pid;
}

async function post(route, body, headers = writeHeaders(SECRET)) {
  const r = await rawRequest(port, 'POST', route, { headers, body: JSON.stringify(body) });
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}

async function getJson(route) {
  const r = await fetch(`${base}${route}`);
  return { status: r.status, body: await r.json() };
}

/** A separate store for the rules checked through the module, so their fixtures never
 * show up in the daemon's lists. */
function scratchHome(name) {
  const dir = path.join(home, 'scratch', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a mission record straight to `dir`'s store, for a state no route can reach fast. */
function seed(dir, key, fields) {
  const at = new Date(fields.now ?? Date.now()).toISOString();
  const { now: _now, ...rest } = fields;
  return writeMission({
    key, title: key, phase: 'direct', state: 'working', prs: [], boards: [], session: null, orders: [],
    history: [], createdAt: at, updatedAt: at, ...rest,
  }, dir);
}

const minutes = n => n * 60 * 1000;
const iso = ms => new Date(ms).toISOString();

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  // --- the launch check ---------------------------------------------------------

  await check('a second launch is refused 409 while the first session\'s pid is alive, and allowed once that pid is gone', async () => {
    const first = await post('/api/mission/LAUNCH_TWICE/launch', { phase: 'direct', prompt: '/direct' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { launch: true });

    const reserved = await post('/api/mission/LAUNCH_TWICE/launch', { phase: 'direct' });
    assert.equal(reserved.status, 409, 'a reserved session no process has bound yet is already live');
    assert.equal(reserved.body.error, 'live');

    const session = liveProcess();
    const bound = await post('/api/mission/LAUNCH_TWICE/session', { pid: session.pid, id: 'sess-1' });
    assert.equal(bound.status, 200);
    assert.equal(bound.body.session.pid, session.pid);

    const second = await post('/api/mission/LAUNCH_TWICE/launch', { phase: 'direct' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'live');
    assert.equal(second.body.session.pid, session.pid, 'the refusal names the session that is live');

    await endProcess(session);
    const again = await post('/api/mission/LAUNCH_TWICE/launch', { phase: 'direct' });
    assert.deepEqual(again.body, { launch: true }, `a mission whose session's process is gone launches again: ${JSON.stringify(again.body)}`);
    const record = readMission('LAUNCH_TWICE', home);
    assert.equal(record.session.pid, undefined, 'the new launch reserves a fresh session');
    assert.equal(record.state, 'working');
  });

  await check('a session bind naming a second pid while the bound one is alive is refused 409', async () => {
    await post('/api/mission/BIND_TWICE/launch', { phase: 'grill' });
    const a = liveProcess();
    const b = liveProcess();
    try {
      assert.equal((await post('/api/mission/BIND_TWICE/session', { pid: a.pid })).status, 200);
      const heartbeat = await post('/api/mission/BIND_TWICE/session', { pid: a.pid });
      assert.equal(heartbeat.status, 200, 'the bound pid heartbeats');
      const other = await post('/api/mission/BIND_TWICE/session', { pid: b.pid });
      assert.equal(other.status, 409);
      assert.equal(other.body.session.pid, a.pid);
    } finally {
      await endProcess(a);
      await endProcess(b);
    }
  });

  await check(`a reserved session no process binds is live for ${UNBOUND_GRACE_MS / 60000} minutes, then stalls and frees its mission and its slot`, () => {
    const dir = scratchHome('unbound');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    const live = { status: 409, message: 'live' };
    assert.deepEqual(launchMission('FAILED_START', { phase: 'direct' }, { home: dir, now: t0 }), { launch: true });
    // A stub's stored state never stalls by silence: the reservation alone must lapse.
    upsertMission('FAILED_START', { state: 'waiting' }, { home: dir, now: t0 });

    const inside = t0 + UNBOUND_GRACE_MS - 1000;
    assert.throws(() => launchMission('FAILED_START', { phase: 'direct' }, { home: dir, now: inside, isAlive: alive }), live);
    assert.deepEqual(missionsOverview({ home: dir, now: inside, isAlive: alive }).live, { working: 0, alive: 1 });

    const past = t0 + UNBOUND_GRACE_MS + 1000;
    const lapsed = missionsOverview({ home: dir, now: past, isAlive: alive });
    assert.deepEqual(launchMission('FAILED_START', { phase: 'direct' }, { home: dir, now: past, isAlive: alive }), { launch: true });
    assert.deepEqual(lapsed.live, { working: 0, alive: 0 }, 'a lapsed reservation holds no slot');
    assert.equal(lapsed.missions[0].view, 'stalled', 'the failed start shows, so the Master Chief sees it');
    assert.deepEqual(readMission('FAILED_START', dir).session, { startedAt: iso(past), seenAt: iso(past) }, 'the new launch re-reserves');
    assert.deepEqual(missionsOverview({ home: dir, now: past, isAlive: alive }).live, { working: 1, alive: 1 });
  });

  await check('a session bound by id alone stays live past the unbound grace', () => {
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const dir = scratchHome('bound-by-id');
    launchMission('BOUND_BY_ID', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('BOUND_BY_ID', { id: 'sess-1' }, { home: dir, now: t0 + 1000 });
    const past = t0 + UNBOUND_GRACE_MS + 60_000;
    assert.throws(() => launchMission('BOUND_BY_ID', { phase: 'direct' }, { home: dir, now: past }), { status: 409, message: 'live' });
    const overview = missionsOverview({ home: dir, now: past });
    assert.deepEqual(overview.live, { working: 1, alive: 1 });
    assert.equal(overview.missions[0].view, 'working');
  });

  await check(`a launch queues at ${MAX_WORKING} working sessions, and launches at one fewer`, () => {
    const dir = scratchHome('working-cap');
    const now = Date.now();
    const alive = () => true;
    for (let i = 0; i < MAX_WORKING - 1; i++) {
      seed(dir, `W${i}`, { session: { pid: 1000 + i, startedAt: iso(now), seenAt: iso(now) } });
    }
    assert.deepEqual(launchMission('UNDER_CAP', { phase: 'direct' }, { home: dir, now, isAlive: alive }), { launch: true });
    // UNDER_CAP's reserved session is the sixth working one.
    const answer = launchMission('OVER_CAP', { phase: 'direct', prompt: '/direct X', login: 'work' }, { home: dir, now, isAlive: alive });
    assert.deepEqual(answer, { queued: true });
    const queued = readMission('OVER_CAP', dir);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.session, null, 'a queued mission has no session');
    assert.deepEqual(queued.queue, { phase: 'direct', prompt: '/direct X', login: 'work', at: iso(now) });
    const overview = missionsOverview({ home: dir, now, isAlive: alive });
    assert.deepEqual(overview.live, { working: MAX_WORKING, alive: MAX_WORKING });
    assert.equal(overview.counts.queued, 1);
  });

  await check(`a launch queues at ${MAX_ALIVE} alive sessions with fewer than ${MAX_WORKING} working`, () => {
    const dir = scratchHome('alive-cap');
    const now = Date.now();
    const alive = () => true;
    for (let i = 0; i < MAX_WORKING - 1; i++) {
      seed(dir, `W${i}`, { session: { pid: 1000 + i, startedAt: iso(now), seenAt: iso(now) } });
    }
    for (let i = 0; i < MAX_ALIVE - MAX_WORKING; i++) {
      seed(dir, `P${i}`, { state: 'waiting', session: { pid: 2000 + i, startedAt: iso(now), seenAt: iso(now - minutes(600)) } });
    }
    assert.deepEqual(missionsOverview({ home: dir, now, isAlive: alive }).live, { working: MAX_WORKING - 1, alive: MAX_ALIVE - 1 });
    assert.deepEqual(launchMission('TWELFTH', { phase: 'grill' }, { home: dir, now, isAlive: alive }), { launch: true });
    assert.deepEqual(launchMission('THIRTEENTH', { phase: 'grill' }, { home: dir, now, isAlive: alive }), { queued: true });
  });

  await check('a mission waiting on the PM is alive but not working, so it holds no working slot', () => {
    const dir = scratchHome('waiting-on-pm');
    const now = Date.now();
    const alive = () => true;
    for (let i = 0; i < MAX_WORKING - 1; i++) {
      seed(dir, `W${i}`, { session: { pid: 1000 + i, startedAt: iso(now), seenAt: iso(now) } });
    }
    // Stored working, but its board holds an unanswered question: it reads needs-you.
    const boardId = 'b_waitingonpm';
    mkdirSync(path.join(dir, 'boards'), { recursive: true });
    writeFileSync(path.join(dir, 'boards', `${boardId}.json`), JSON.stringify({
      id: boardId, thread: 't', title: 'q', cwd: null, createdAt: iso(now), updatedAt: iso(now), state: 'open',
      rounds: [{ n: 1, postedAt: iso(now), status: 'open', sentAt: null, title: 'q', awaited: true, awaitDeadline: iso(now + minutes(40)) }],
      blocks: [{ id: 'q1', kind: 'question', round: 1, prompt: 'Fire?', widget: 'single', options: [{ label: 'Yes' }] }],
      answers: {}, comments: [],
    }));
    seed(dir, 'ASKING', { boards: [{ id: boardId, url: 'http://x/b/' + boardId, at: iso(now) }], session: { pid: 3000, startedAt: iso(now), seenAt: iso(now) } });
    seed(dir, 'PARKED', { state: 'waiting', session: { pid: 3001, startedAt: iso(now), seenAt: iso(now) } });
    const overview = missionsOverview({ home: dir, now, isAlive: alive });
    assert.equal(overview.missions.find(m => m.key === 'ASKING').view, 'needs-you');
    assert.deepEqual(overview.live, { working: MAX_WORKING - 1, alive: MAX_WORKING + 1 });
    assert.deepEqual(launchMission('NEXT', { phase: 'direct' }, { home: dir, now, isAlive: alive }), { launch: true },
      'five working and two waiting on the PM leave a working slot');
  });

  // --- the view -------------------------------------------------------------------

  await check('a mission shows stalled when its session\'s process is gone', async () => {
    const gonePid = await deadPid();
    await post('/api/mission/DEAD_PID/launch', { phase: 'direct' });
    // Bound while the stand-in is alive, then gone.
    const session = liveProcess();
    await post('/api/mission/DEAD_PID/session', { pid: session.pid });
    assert.equal((await getJson('/api/mission/DEAD_PID')).body.view, 'working');
    await endProcess(session);
    const view = (await getJson('/api/mission/DEAD_PID')).body;
    assert.equal(view.view, 'stalled');
    assert.equal(view.live, false);
    assert.equal(view.state, 'working', 'stalled is derived, never stored');
    // And the same through the module, for a waiting mission: a gone process stalls any state.
    const m = { key: 'K', state: 'waiting', boards: [], session: { pid: gonePid, startedAt: iso(0), seenAt: iso(Date.now()) } };
    assert.equal(deriveState(m, { home }), 'stalled');
  });

  await check('a working mission silent past fifteen minutes shows stalled; a waiting one does not', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    const at = silentFor => ({ key: 'K', state: 'working', boards: [], session: { pid: 1, startedAt: iso(now - minutes(60)), seenAt: iso(now - silentFor) } });
    assert.equal(deriveState(at(STALL_SILENCE_MS + 1000), { home, now, isAlive: alive }), 'stalled');
    assert.equal(deriveState(at(STALL_SILENCE_MS - 1000), { home, now, isAlive: alive }), 'working');
    assert.equal(deriveState({ ...at(minutes(600)), state: 'waiting' }, { home, now, isAlive: alive }), 'waiting');
    assert.equal(deriveState({ ...at(minutes(600)), state: 'landed' }, { home, now, isAlive: () => false }), 'landed', 'a landed mission stays landed after its session ends');
  });

  await check('a landed mission leaves the list 24 hours after it landed, and ?all=1 keeps it', async () => {
    const dir = scratchHome('landed');
    const now = Date.parse('2026-10-28T12:00:00Z');
    upsertMission('LANDED_OLD', { state: 'landed' }, { home: dir, now: now - LANDED_VISIBLE_MS - 1000 });
    upsertMission('LANDED_NEW', { state: 'landed' }, { home: dir, now: now - LANDED_VISIBLE_MS + 60_000 });
    const keys = o => o.missions.map(m => m.key).sort();
    assert.deepEqual(keys(missionsOverview({ home: dir, now })), ['LANDED_NEW']);
    assert.deepEqual(keys(missionsOverview({ home: dir, now, all: true })), ['LANDED_NEW', 'LANDED_OLD']);
    assert.equal(readMission('LANDED_OLD', dir).landedAt, iso(now - LANDED_VISIBLE_MS - 1000));

    // The same over the route, on the daemon's store.
    seed(home, 'ROUTE_LANDED', { state: 'landed', landedAt: iso(Date.now() - LANDED_VISIBLE_MS - 60_000) });
    const listed = (await getJson('/api/missions')).body.missions.map(m => m.key);
    const all = (await getJson('/api/missions?all=1')).body.missions.map(m => m.key);
    assert.ok(!listed.includes('ROUTE_LANDED'));
    assert.ok(all.includes('ROUTE_LANDED'));
  });

  await check('a prune deletes a mission record 30 days after its retiredAt, and keeps a younger or unretired one', () => {
    const dir = scratchHome('prune');
    const now = Date.parse('2026-10-28T12:00:00Z');
    seed(dir, 'RETIRED_OLD', { retiredAt: iso(now - MISSION_RETENTION_MS - 1000) });
    seed(dir, 'RETIRED_NEW', { retiredAt: iso(now - MISSION_RETENTION_MS + 60_000) });
    seed(dir, 'OPEN', {});
    const result = pruneStore(365, dir, now);
    assert.deepEqual(result.missions, ['RETIRED_OLD']);
    assert.deepEqual(readdirSync(path.join(dir, 'missions')).sort(), ['OPEN.json', 'RETIRED_NEW.json']);
  });

  // --- the record -----------------------------------------------------------------

  await check('POST /api/mission/:key writes the whitelisted fields and answers the view, with history on a phase or state change only', async () => {
    const fields = {
      title: 'Front agent', cwd: '/tmp/x', phase: 'grill', state: 'working', summary: 'The Master Chief fronts sessions.',
      waitingOn: 'nothing', next: 'direct', prs: [{ repo: 'claude-board', number: 7, url: 'https://github.com/x/y/pull/7', state: 'open' }],
      handoff: 'Handoff\n- step', fire: { by: 'card' }, retiredAt: '2026-10-01T00:00:00Z',
    };
    const r = await post('/api/mission/WHITELIST', fields);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'fire') continue;
      assert.deepEqual(r.body[k], v, `${k} is stored as written`);
    }
    assert.equal(r.body.fire.by, 'card');
    assert.equal(r.body.view, 'working');
    assert.equal((await post('/api/mission/WHITELIST', { summary: 'reworded' })).status, 200);
    assert.equal(readMission('WHITELIST', home).history.length, 1, 'a summary change appends no history');
    await post('/api/mission/WHITELIST', { phase: 'direct' });
    await post('/api/mission/WHITELIST', { cwd: null });
    const record = readMission('WHITELIST', home);
    assert.deepEqual(record.history.map(h => [h.phase, h.state]), [['grill', 'working'], ['direct', 'working']]);
    assert.equal(record.cwd, undefined, 'null clears an optional field');
  });

  await check('an unknown field, or a field over its cap, is a 400 that writes nothing', async () => {
    for (const body of [
      { title: 'x', boards: [] }, { session: { pid: 1 } }, { orders: [] }, { caseText: 'x' },
      { summary: 'x'.repeat(281) }, { handoff: 'é'.repeat(2049) }, { phase: 'deploy' }, { state: 'stalled' },
      { prs: [{ repo: 'r', number: 1, url: 'u', state: 'open', body: 'x' }] }, { title: null },
    ]) {
      const r = await post('/api/mission/REFUSED', body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} is refused`);
      assert.equal(typeof r.body.error, 'string');
    }
    assert.equal(readMission('REFUSED', home), null);
    assert.equal((await post('/api/mission/OK_SIZES', { summary: 'x'.repeat(280), handoff: 'x'.repeat(4096) })).status, 200);
  });

  await check('a key off the pattern is a 400, and an absent mission is a 404', async () => {
    assert.equal((await post('/api/mission/bad.key', { title: 'x' })).status, 400);
    assert.equal((await post(`/api/mission/${'K'.repeat(81)}`, { title: 'x' })).status, 400);
    const absent = await getJson('/api/mission/NO_SUCH_MISSION');
    assert.equal(absent.status, 404);
    assert.match(absent.body.error, /mission not found/);
    assert.equal((await post('/api/mission/NO_SUCH_MISSION/session', { pid: 1 })).status, 404);
    assert.equal((await post('/api/mission/NO_SUCH_MISSION/order', { kind: 'stop' })).status, 404);
  });

  await check('an order is appended, and its ack sets relayedAt once', async () => {
    await post('/api/mission/ORDERS', { title: 'Orders' });
    const stop = await post('/api/mission/ORDERS/order', { kind: 'stop' });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.order.kind, 'stop');
    assert.equal(stop.body.order.by, 'card');
    assert.equal((await post('/api/mission/ORDERS/order', { kind: 'comment' })).status, 400, 'a comment needs its text');
    const ack = await post(`/api/mission/ORDERS/order/${stop.body.order.id}/ack`, {});
    assert.equal(ack.status, 200);
    assert.ok(ack.body.order.relayedAt);
    const again = await post(`/api/mission/ORDERS/order/${stop.body.order.id}/ack`, {});
    assert.equal(again.body.order.relayedAt, ack.body.order.relayedAt);
    assert.equal((await post('/api/mission/ORDERS/order/o_nope/ack', {})).status, 404);
  });

  // --- boards -----------------------------------------------------------------------

  await check('a board posted with mission: <key> is linked to that mission, which reads needs-you until the round is answered', async () => {
    const posted = await post('/api/board', {
      title: 'A grill round', mission: 'LINKED',
      blocks: [{ kind: 'question', prompt: 'Fire?', widget: 'single', options: [{ label: 'Yes' }] }],
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    assert.equal(readBoard(posted.body.boardId, home).mission, 'LINKED', 'the board records its mission');
    const view = (await getJson('/api/mission/LINKED')).body;
    assert.deepEqual(view.boards.map(b => [b.id, b.url]), [[posted.body.boardId, posted.body.url]], 'the link is the post\'s own reply');
    assert.equal(view.view, 'needs-you');
    const qid = readBoard(posted.body.boardId, home).blocks[0].id;
    const sent = await post(`/api/board/${posted.body.boardId}/submit`, {
      round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: '' }], comments: [],
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((await getJson('/api/mission/LINKED')).body.view, 'waiting', 'answered, it reads its stored state again');
  });

  await check('a board post with a bad mission key is a 400 that writes no board', async () => {
    const before = readdirSync(path.join(home, 'boards')).length;
    const r = await post('/api/board', { title: 'x', mission: '../etc', blocks: [{ kind: 'markdown', text: 'x' }] });
    assert.equal(r.status, 400);
    assert.equal(readdirSync(path.join(home, 'boards')).length, before);
  });

  // --- the relay --------------------------------------------------------------------

  /** A one-question board, answered by nobody yet: its id and the question's id. */
  async function openQuestionBoard(title) {
    const posted = await post('/api/board', {
      title, blocks: [{ kind: 'question', prompt: 'Merge?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    return { boardId: posted.body.boardId, qid: readBoard(posted.body.boardId, home).blocks[0].id };
  }

  await check('a relay with the cookie alone, or no credential, is a 401 that leaves the round open', async () => {
    const { boardId, qid } = await openQuestionBoard('cookie relay');
    const body = JSON.stringify({ round: 1, answers: [{ id: qid, status: 'answered', choice: 'Yes', note: '' }], words: 'yes, merge it' });
    const cookie = sessionCookieHeader(SECRET);
    for (const headers of [{ 'content-type': 'application/json', cookie }, { 'content-type': 'application/json' }]) {
      const r = await rawRequest(port, 'POST', `/api/board/${boardId}/relay`, { headers, body });
      assert.equal(r.status, 401);
    }
    assert.equal(readBoard(boardId, home).rounds[0].status, 'open');
  });

  await check('a relay with no words, or words over 1 KB, is a 400 that leaves the round open', async () => {
    const { boardId, qid } = await openQuestionBoard('wordless relay');
    const answers = [{ id: qid, status: 'answered', choice: 'Yes', note: '' }];
    for (const words of [undefined, '   ', 'é'.repeat(513)]) {
      const r = await post(`/api/board/${boardId}/relay`, { round: 1, answers, words });
      assert.equal(r.status, 400, `words ${JSON.stringify(words)?.slice(0, 20)}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(readBoard(boardId, home).rounds[0].status, 'open');
    const fits = await post(`/api/board/${boardId}/relay`, { round: 1, answers, words: 'a'.repeat(1024) });
    assert.equal(fits.status, 200, '1024 bytes is inside the cap');
  });

  await check('a relay on an abandoned round is a 409 that records nothing', async () => {
    const { boardId, qid } = await openQuestionBoard('abandoned relay');
    assert.equal((await post(`/api/board/${boardId}/abandon`, {})).status, 200);
    const answers = [{ id: qid, status: 'answered', choice: 'Yes', note: '' }];
    const r = await post(`/api/board/${boardId}/relay`, { round: 1, answers, words: 'yes' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    const stored = readBoard(boardId, home).rounds[0];
    assert.equal(stored.status, 'abandoned');
    assert.equal(stored.relayed, undefined);
  });

  // --- the stream -------------------------------------------------------------------

  await check('the daemon-wide stream emits missions on a mission write and on a linked board\'s post', async () => {
    const events = [];
    let pending = '';
    let raw = '';
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
        pending += chunk;
        const frames = pending.split('\n\n');
        pending = frames.pop();
        for (const frame of frames) {
          const name = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (name && data) events.push({ name: name[1], data: JSON.parse(data[1]) });
        }
      });
    });
    req.on('error', () => {});
    req.end();
    try {
      await waitFor(() => raw.includes(': connected'), { what: 'the stream opened' });
      await post('/api/mission/STREAMED', { summary: 'changed' });
      await waitFor(() => events.some(e => e.name === 'missions' && e.data.key === 'STREAMED'), { what: 'a missions event for the write' });
      await post('/api/board', { title: 'streamed board', mission: 'STREAMED_BOARD', blocks: [{ kind: 'markdown', text: 'x' }] });
      await waitFor(() => events.some(e => e.name === 'missions' && e.data.key === 'STREAMED_BOARD'), { what: 'a missions event for the board post' });
    } finally {
      req.destroy();
    }
  });

  // --- the gates --------------------------------------------------------------------

  await check('the cookie may read the list and post an order, and may not write, launch, bind, ack or read one mission', async () => {
    await post('/api/mission/COOKIE', { title: 'Cookie' });
    const cookie = sessionCookieHeader(SECRET);
    const asCookie = { 'content-type': 'application/json', cookie };
    const list = await rawRequest(port, 'GET', '/api/missions', { headers: { cookie } });
    assert.equal(list.status, 200);
    assert.ok(JSON.parse(list.body).missions.some(m => m.key === 'COOKIE'));
    const order = await rawRequest(port, 'POST', '/api/mission/COOKIE/order', { headers: asCookie, body: JSON.stringify({ kind: 'comment', text: 'look at the PR' }) });
    assert.equal(order.status, 200, order.body);
    const orderId = JSON.parse(order.body).order.id;
    for (const [method, route, body] of [
      ['POST', '/api/mission/COOKIE', { summary: 'forged' }],
      ['POST', '/api/mission/COOKIE/launch', { phase: 'direct' }],
      ['POST', '/api/mission/COOKIE/session', { pid: 1 }],
      ['POST', `/api/mission/COOKIE/order/${orderId}/ack`, {}],
      ['GET', '/api/mission/COOKIE', null],
    ]) {
      const r = await rawRequest(port, method, route, { headers: asCookie, body: body && JSON.stringify(body) });
      assert.equal(r.status, 401, `${method} ${route} with the cookie alone is refused`);
    }
    assert.equal(readMission('COOKIE', home).summary, undefined);
    for (const route of ['/api/missions', '/api/mission/COOKIE']) {
      assert.equal((await rawRequest(port, 'GET', route)).status, 401, `${route} with no credential is refused`);
    }
    assert.equal((await rawRequest(port, 'POST', '/api/mission/COOKIE/order', { headers: { 'content-type': 'application/json' }, body: '{"kind":"stop"}' })).status, 401);
  });

  await check('GET /api/missions answers missions, counts, live and now', async () => {
    const r = await getJson('/api/missions');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['counts', 'live', 'missions', 'now']);
    assert.deepEqual(Object.keys(r.body.counts).sort(), ['landed', 'needsYou', 'queued', 'stalled', 'waiting', 'working']);
    assert.deepEqual(Object.keys(r.body.live).sort(), ['alive', 'working']);
    const total = Object.values(r.body.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, r.body.missions.length, 'every listed mission is counted in one column');
  });
}

await runMain('missions', main, {
  cleanup: async () => {
    for (const child of children) await endProcess(child);
    if (server) await new Promise(resolve => server.close(resolve));
  },
});
