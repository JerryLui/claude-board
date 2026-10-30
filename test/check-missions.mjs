// The missions ledger (src/missions.mjs) and its routes under /api/mission and
// /api/missions: a daemon on a temp store, real child processes for a live and a dead
// session, and the store functions with an injected clock where a route cannot wait the
// fifteen minutes or the day a rule is about.

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import { readBoard, readMission, writeBoard, writeMission, pruneStore, MISSION_RETENTION_MS } from '../src/store.mjs';
import { createBoard } from '../src/board.mjs';
import { createSessionList } from '../src/sessions.mjs';
import {
  missionsOverview, missionView, launchMission, bindSession, joinMission, leaveMission, upsertMission, deriveState, MAX_WORKING, MAX_ALIVE, STALL_SILENCE_MS, UNBOUND_GRACE_MS, RELEASED_VISIBLE_MS,
} from '../src/missions.mjs';
import { createMissionsCache, MISSIONS_CACHE_MS } from '../src/missions-cache.mjs';
import { check, deadPid, openSseClient, rawRequest, runMain, secretFetch, secretHome, sessionCookieHeader, waitFor, writeHeaders } from './support.mjs';

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

async function post(route, body, headers = writeHeaders(SECRET)) {
  const r = await rawRequest(port, 'POST', route, { headers, body: JSON.stringify(body) });
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}

async function getJson(route) {
  const r = await fetch(`${base}${route}`);
  return { status: r.status, body: await r.json() };
}

/** `GET /api/events` held open, once it has connected: `saw(key)` is whether a `missions`
 * event for `key` has arrived since. */
async function missionsStream() {
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
  await waitFor(() => raw.includes(': connected'), { what: 'the stream opened' });
  return {
    saw: key => events.some(e => e.name === 'missions' && e.data.key === key),
    close: () => req.destroy(),
  };
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

  await check('a launch refused by a silent live session answers 409 with silent: true, and a heartbeat drops the flag', async () => {
    const session = liveProcess();
    try {
      const now = Date.now();
      seed(home, 'SILENT_HTTP', {
        now: now - minutes(30),
        session: { pid: session.pid, startedAt: iso(now - minutes(30)), seenAt: iso(now - minutes(16)) },
      });
      const silent = await post('/api/mission/SILENT_HTTP/launch', { phase: 'direct' });
      assert.equal(silent.status, 409);
      assert.equal(silent.body.error, 'live');
      assert.equal(silent.body.session.pid, session.pid);
      assert.equal(silent.body.silent, true, `the body says the live session is silent: ${JSON.stringify(silent.body)}`);

      assert.equal((await post('/api/mission/SILENT_HTTP/session', { pid: session.pid })).status, 200);
      const heard = await post('/api/mission/SILENT_HTTP/launch', { phase: 'direct' });
      assert.equal(heard.status, 409);
      assert.equal('silent' in heard.body, false, `a session just heard from is not silent: ${JSON.stringify(heard.body)}`);
    } finally {
      await endProcess(session);
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

  await check('a working session silent fifteen minutes reads stalled, yet keeps its mission and its slot while its pid lives, and its heartbeat clears the silence', () => {
    const dir = scratchHome('silent');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    launchMission('SILENT', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('SILENT', { pid: 4242 }, { home: dir, now: t0 + 1000, isAlive: alive });
    const silent = t0 + minutes(16);

    const overview = missionsOverview({ home: dir, now: silent, isAlive: alive });
    assert.equal(overview.missions[0].view, 'stalled');
    assert.deepEqual(overview.live, { working: 1, alive: 1 }, 'a silent session whose process lives still holds its slots');
    assert.throws(() => launchMission('SILENT', { phase: 'direct' }, { home: dir, now: silent, isAlive: alive }),
      err => err.status === 409 && err.message === 'live' && err.silent === true && err.session.pid === 4242);

    bindSession('SILENT', { pid: 4242 }, { home: dir, now: silent, isAlive: alive });
    assert.equal(missionsOverview({ home: dir, now: silent, isAlive: alive }).missions[0].view, 'working');

    launchMission('SILENT_GONE', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('SILENT_GONE', { pid: 4343 }, { home: dir, now: t0 + 1000, isAlive: alive });
    const gone = pid => pid !== 4343;
    assert.deepEqual(launchMission('SILENT_GONE', { phase: 'direct' }, { home: dir, now: silent, isAlive: gone }), { launch: true },
      'a silent session whose process is gone frees its mission');
  });

  await check('a session whose mission recorded its end (a grill answered Fire, or released) holds neither the mission nor a slot, and its pid cannot take the next session', () => {
    const dir = scratchHome('finished');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    launchMission('FIRED', { phase: 'grill' }, { home: dir, now: t0 });
    bindSession('FIRED', { pid: 5151 }, { home: dir, now: t0 + 1000, isAlive: alive });
    upsertMission('FIRED', { state: 'waiting', fire: { by: 'round' } }, { home: dir, now: t0 + 2000 });
    launchMission('RELEASED', { phase: 'landing' }, { home: dir, now: t0 });
    bindSession('RELEASED', { pid: 5252 }, { home: dir, now: t0 + 1000, isAlive: alive });
    upsertMission('RELEASED', { state: 'released' }, { home: dir, now: t0 + 2000 });

    const now = t0 + minutes(1);
    const overview = missionsOverview({ home: dir, now, isAlive: alive });
    assert.deepEqual(overview.missions.map(m => [m.key, m.live]).sort(), [['FIRED', false], ['RELEASED', false]]);
    assert.deepEqual(overview.live, { working: 0, alive: 0 });

    assert.deepEqual(launchMission('FIRED', { phase: 'direct' }, { home: dir, now, isAlive: alive }), { launch: true });
    const record = readMission('FIRED', dir);
    assert.equal(record.phase, 'direct');
    assert.equal(record.state, 'working');
    assert.equal(record.session.pid, undefined, 'the direct launch reserves a fresh session');
    assert.throws(() => bindSession('FIRED', { pid: 5151 }, { home: dir, now, isAlive: alive }), { status: 409, message: 'live' },
      'the ended grill, still running, cannot bind to the direct session');
    assert.equal(bindSession('FIRED', { pid: 6161 }, { home: dir, now, isAlive: alive }).session.pid, 6161);
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

  await check('a launch queued behind the cap ends the session it replaces: the mission holds no slot, dequeues on the next launch, and that pid cannot bind', () => {
    const dir = scratchHome('queued-after-fire');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    launchMission('GRILLED', { phase: 'grill' }, { home: dir, now: t0 });
    bindSession('GRILLED', { pid: 7171 }, { home: dir, now: t0 + 1000, isAlive: alive });
    upsertMission('GRILLED', { state: 'waiting', fire: { by: 'round' } }, { home: dir, now: t0 + 2000 });
    for (let i = 0; i < MAX_WORKING; i++) {
      seed(dir, `W${i}`, { now: t0, session: { pid: 1000 + i, startedAt: iso(t0), seenAt: iso(t0) } });
    }
    const now = t0 + minutes(1);
    assert.deepEqual(launchMission('GRILLED', { phase: 'direct' }, { home: dir, now, isAlive: alive }), { queued: true });
    const overview = missionsOverview({ home: dir, now, isAlive: alive });
    const queued = overview.missions.find(m => m.key === 'GRILLED');
    assert.equal(queued.view, 'queued');
    assert.equal(queued.live, false, 'the fired grill, still running, no longer holds the mission');
    assert.deepEqual(overview.live, { working: MAX_WORKING, alive: MAX_WORKING });

    writeMission({ ...readMission('W0', dir), session: null, state: 'waiting' }, dir);
    assert.deepEqual(launchMission('GRILLED', { phase: 'direct' }, { home: dir, now, isAlive: alive }), { launch: true });
    assert.throws(() => bindSession('GRILLED', { pid: 7171 }, { home: dir, now, isAlive: alive }), { status: 409, message: 'live' },
      'the ended grill cannot take the dequeued session');
    assert.equal(bindSession('GRILLED', { pid: 8181 }, { home: dir, now, isAlive: alive }).session.pid, 8181);
  });

  await check('a session its mission expects to have stopped never reads stalled: a fired grill whose pid is gone, and a dead mission relaunched into a full queue', () => {
    const dir = scratchHome('expected-stop');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    launchMission('FIRED_GONE', { phase: 'grill' }, { home: dir, now: t0 });
    bindSession('FIRED_GONE', { pid: 9191 }, { home: dir, now: t0 + 1000, isAlive: alive });
    upsertMission('FIRED_GONE', { state: 'waiting', fire: { by: 'round' } }, { home: dir, now: t0 + 2000 });
    launchMission('DIED', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('DIED', { pid: 9292 }, { home: dir, now: t0 + 1000, isAlive: alive });
    for (let i = 0; i < MAX_WORKING; i++) {
      seed(dir, `W${i}`, { now: t0, session: { pid: 10000 + i, startedAt: iso(t0), seenAt: iso(t0) } });
    }
    const now = t0 + minutes(1);
    const deadGrillAndDied = pid => pid !== 9191 && pid !== 9292;
    assert.deepEqual(launchMission('DIED', { phase: 'direct' }, { home: dir, now, isAlive: deadGrillAndDied }), { queued: true });

    const overview = missionsOverview({ home: dir, now, isAlive: deadGrillAndDied });
    assert.equal(overview.missions.find(m => m.key === 'FIRED_GONE').view, 'waiting');
    assert.equal(overview.missions.find(m => m.key === 'DIED').view, 'queued');
    assert.equal(overview.counts.stalled, 0);
    assert.equal(overview.counts.queued, 1);
  });

  await check('a silent session bound by id alone, replaced by a relaunch, cannot bind again, and its successor binds and holds against any other id', () => {
    const dir = scratchHome('silent-id');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    launchMission('CODEX', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('CODEX', { id: 'sess-a' }, { home: dir, now: t0 + 1000 });
    const silent = t0 + minutes(16);
    assert.deepEqual(launchMission('CODEX', { phase: 'direct' }, { home: dir, now: silent }), { launch: true });

    const live = { status: 409, message: 'live' };
    assert.throws(() => bindSession('CODEX', { id: 'sess-a' }, { home: dir, now: silent + 1000 }), live,
      'the replaced session cannot take its successor\'s reservation');
    assert.equal(bindSession('CODEX', { id: 'sess-b' }, { home: dir, now: silent + 2000 }).session.id, 'sess-b');
    assert.throws(() => bindSession('CODEX', { id: 'sess-a' }, { home: dir, now: silent + 3000 }), live,
      'nor displace the successor once it is bound');
    assert.throws(() => bindSession('CODEX', { id: 'sess-c' }, { home: dir, now: silent + 4000 }), live,
      'a second id while the bound one is heard from is a second live session');
    assert.equal(readMission('CODEX', dir).session.id, 'sess-b');
  });

  await check('a bind from the bound pid under a new session id (a /clear) is its heartbeat and takes the id, while another pid is still a 409', () => {
    const dir = scratchHome('same-pid-new-id');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const alive = () => true;
    launchMission('CLEARED', { phase: 'direct' }, { home: dir, now: t0 });
    bindSession('CLEARED', { pid: 7272, id: 'sess-a' }, { home: dir, now: t0 + 1000, isAlive: alive });

    const later = t0 + minutes(2);
    const rebound = bindSession('CLEARED', { pid: 7272, id: 'sess-b' }, { home: dir, now: later, isAlive: alive });
    assert.equal(rebound.session.id, 'sess-b');
    assert.equal(rebound.session.pid, 7272);
    assert.equal(rebound.session.seenAt, iso(later));
    assert.equal(rebound.session.startedAt, iso(t0), 'the same session, not a fresh one');
    assert.equal(bindSession('CLEARED', { pid: 7272 }, { home: dir, now: later + 60_000, isAlive: alive }).session.seenAt, iso(later + 60_000),
      'its pid-only heartbeats keep landing');

    assert.throws(() => bindSession('CLEARED', { pid: 7373, id: 'sess-b' }, { home: dir, now: later + 61_000, isAlive: alive }),
      { status: 409, message: 'live' }, 'another pid while the bound one lives is a second live session');
    assert.equal(readMission('CLEARED', dir).session.pid, 7272);
  });

  // --- binding by session id (ADR 141) ---------------------------------------------

  await check('a join by a second live session is refused 409; with takeover it is pending, told to the bound session, until that one leaves, and then it is bound', async () => {
    const a = liveProcess();
    const b = liveProcess();
    const start = '2026-10-30T08:00:00Z';
    try {
      const first = await post('/api/mission/JOIN_TWO/join', { id: 'sess-a', pid: a.pid, procStart: start, phase: 'direct' });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.bound, true);
      assert.deepEqual([first.body.session.id, first.body.session.pid], ['sess-a', a.pid]);
      const created = readMission('JOIN_TWO', home);
      assert.deepEqual([created.phase, created.state], ['direct', 'working'], 'a join creates the mission it names, working');

      const second = await post('/api/mission/JOIN_TWO/join', { id: 'sess-b', pid: b.pid, procStart: start });
      assert.equal(second.status, 409);
      assert.equal(second.body.error, 'live');
      assert.equal(second.body.session.id, 'sess-a', 'the refusal names the bound session');
      assert.equal(readMission('JOIN_TWO', home).takeover, undefined, 'a plain join records no takeover');

      const asked = await post('/api/mission/JOIN_TWO/join', { id: 'sess-b', pid: b.pid, procStart: start, takeover: true });
      assert.equal(asked.status, 202);
      assert.equal(asked.body.takeover, 'pending');
      assert.equal(asked.body.session.id, 'sess-a');
      const pending = readMission('JOIN_TWO', home);
      assert.equal(pending.session.id, 'sess-a', 'the bound session keeps the mission while the takeover is pending');
      assert.equal(pending.takeover.by, 'sess-b');
      const told = (await getJson('/api/binding?id=sess-a')).body;
      assert.deepEqual([told.key, told.takeover], ['JOIN_TWO', { by: 'sess-b', at: pending.takeover.at }]);
      assert.equal((await getJson('/api/binding?id=sess-b')).body.key, null, 'the asking session is bound to nothing yet');

      assert.equal((await post('/api/mission/JOIN_TWO/leave', { id: 'sess-b' })).status, 409, 'only the bound session leaves');
      const left = await post('/api/mission/JOIN_TWO/leave', { id: 'sess-a' });
      assert.equal(left.status, 200, JSON.stringify(left.body));
      const after = readMission('JOIN_TWO', home);
      assert.deepEqual([after.session.id, after.session.pid], ['sess-b', b.pid], 'the leave binds the session that asked');
      assert.deepEqual(after.session.ended, { pid: a.pid, id: 'sess-a' });
      assert.equal(after.takeover, undefined);
      assert.equal((await getJson('/api/binding?id=sess-b')).body.key, 'JOIN_TWO');
      assert.equal((await getJson('/api/binding?id=sess-a')).body.key, null);
      assert.equal((await post('/api/mission/JOIN_TWO/join', { id: 'sess-b', pid: b.pid, procStart: start })).status, 200, 'its next join is its own');
    } finally {
      await endProcess(a);
      await endProcess(b);
    }
  });

  await check('a join from the bound process under a new id (a /clear) rebinds the id; a launch\'s reservation is bound by the first join; a session gone with a takeover pending is replaced by the next join', () => {
    const dir = scratchHome('join-rules');
    const t0 = Date.parse('2026-10-30T09:00:00Z');
    const alive = new Set([5151, 5252]);
    const isAlive = pid => alive.has(pid);
    const start = '2026-10-30T08:59:00Z';

    launchMission('JOINED', { phase: 'direct', login: '/Users/pm/.claude-a' }, { home: dir, now: t0 });
    const reserved = joinMission('JOINED', { id: 'sess-a', pid: 5151, procStart: start }, { home: dir, now: t0 + 1000, isAlive });
    assert.equal(reserved.status, 200);
    assert.deepEqual([reserved.session.id, reserved.session.login, reserved.session.startedAt], ['sess-a', '/Users/pm/.claude-a', iso(t0)],
      'the reservation is bound in place, its launch\'s login and start kept');

    const cleared = joinMission('JOINED', { id: 'sess-a2', pid: 5151, procStart: start }, { home: dir, now: t0 + 2000, isAlive });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.session.id, cleared.session.startedAt], ['sess-a2', iso(t0)], 'the same process under a new id is the same session');
    assert.throws(() => joinMission('JOINED', { id: 'sess-x', pid: 5151, procStart: '2026-10-30T08:00:00Z' }, { home: dir, now: t0 + 3000, isAlive }),
      { status: 409 }, 'the same pid with another process start is another process');

    assert.equal(joinMission('JOINED', { id: 'sess-b', pid: 5252, procStart: start, takeover: true }, { home: dir, now: t0 + 4000, isAlive }).status, 202);
    alive.delete(5151);
    const c = joinMission('JOINED', { id: 'sess-c', pid: 5252, procStart: start }, { home: dir, now: t0 + 5000, isAlive });
    assert.deepEqual([c.status, c.session.id], [200, 'sess-c'], 'with the bound process gone, the next join binds');
    assert.equal(readMission('JOINED', dir).takeover, undefined, 'and the takeover is over');
  });

  await check('a leave with no takeover pending lets the mission go: session { ended, leftAt }, working moves to waiting, and the left session\'s heartbeat is refused while its join binds again', () => {
    const dir = scratchHome('leave');
    const t0 = Date.parse('2026-10-30T10:00:00Z');
    const isAlive = () => true;
    joinMission('LEFT', { id: 'sess-a', pid: 6161 }, { home: dir, now: t0, isAlive });
    assert.throws(() => leaveMission('LEFT', { id: 'sess-z', pid: 6262 }, { home: dir, now: t0 + 1000 }), { status: 409, message: 'not bound' });
    assert.deepEqual(leaveMission('LEFT', { id: 'sess-a' }, { home: dir, now: t0 + 2000 }), { left: true, session: null });
    const m = readMission('LEFT', dir);
    assert.deepEqual(m.session, { ended: { pid: 6161, id: 'sess-a' }, leftAt: iso(t0 + 2000) });
    assert.equal(m.state, 'waiting');
    assert.throws(() => bindSession('LEFT', { id: 'sess-a', pid: 6161 }, { home: dir, now: t0 + 3000, isAlive }), { status: 409 },
      'a hook of the session that left cannot bind it back');
    assert.equal(joinMission('LEFT', { id: 'sess-a', pid: 6161 }, { home: dir, now: t0 + 4000, isAlive }).status, 200, '/mission run again joins');
    assert.equal(readMission('LEFT', dir).state, 'working');
  });

  await check('a heartbeat with typed: true records when the PM typed in the session', () => {
    const dir = scratchHome('typed');
    const t0 = Date.parse('2026-10-30T11:00:00Z');
    joinMission('TYPED', { id: 'sess-a', pid: 7171 }, { home: dir, now: t0, isAlive: () => true });
    const beat = bindSession('TYPED', { id: 'sess-a', pid: 7171 }, { home: dir, now: t0 + 1000, isAlive: () => true });
    assert.equal(beat.session.typedAt, undefined);
    const typed = bindSession('TYPED', { id: 'sess-a', pid: 7171, typed: true }, { home: dir, now: t0 + 2000, isAlive: () => true });
    assert.deepEqual([typed.session.typedAt, typed.session.seenAt], [iso(t0 + 2000), iso(t0 + 2000)]);
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

  await check('needs you and the card\'s Fire come only from a board\'s newest round: an older page left asking holds neither', () => {
    const dir = scratchHome('newest-page');
    const now = Date.now();
    const fireQ = (id, round) => ({ id, kind: 'question', round, prompt: 'Fire?', widget: 'single', action: 'fire', options: [{ label: 'Fire /direct' }, { label: 'Not yet' }] });
    const roundOf = (n, status) => ({ n, postedAt: iso(now), status, sentAt: status === 'sent' ? iso(now) : null, title: `p${n}` });
    for (const [key, statuses, view, actionRounds] of [
      ['OLDER_ASKS', ['open', 'sent'], 'working', []],
      ['NEWEST_ASKS', ['sent', 'open'], 'needs-you', [2]],
      ['BOTH_ASK', ['open', 'open'], 'needs-you', [2]],
    ]) {
      const boardId = `b_${key.toLowerCase()}`;
      mkdirSync(path.join(dir, 'boards'), { recursive: true });
      writeFileSync(path.join(dir, 'boards', `${boardId}.json`), JSON.stringify({
        id: boardId, thread: 't', title: 'q', cwd: null, createdAt: iso(now), updatedAt: iso(now), state: 'open',
        rounds: statuses.map((status, i) => roundOf(i + 1, status)),
        blocks: statuses.map((_, i) => fireQ(`q${i + 1}`, i + 1)),
        answers: {}, comments: [],
      }));
      seed(dir, key, { boards: [{ id: boardId, url: 'http://x/b/' + boardId, at: iso(now) }] });
      const v = missionsOverview({ home: dir, now }).missions.find(m => m.key === key);
      assert.equal(v.view, view, `${key}: rounds ${statuses.join(', ')}`);
      assert.deepEqual(v.actions.map(a => [a.round, a.question]), actionRounds.map(n => [n, `q${n}`]), `${key}: the card's buttons`);
    }
  });

  // --- the view -------------------------------------------------------------------

  await check(`the overview cache answers from one read for ${MISSIONS_CACHE_MS / 1000} s, and a write to the missions store is read at once`, () => {
    const dir = scratchHome('cache');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    seed(dir, 'SILENT', { now: t0, session: { pid: process.pid, id: 's', startedAt: iso(t0 - minutes(60)), seenAt: iso(t0 - STALL_SILENCE_MS + 1000) } });
    const clock = { t: t0 };
    const cache = createMissionsCache({ home: dir, now: () => clock.t });
    const viewOf = (key, overview = cache.overview()) => overview.missions.find(m => m.key === key)?.view;
    assert.equal(viewOf('SILENT'), 'working');
    clock.t = t0 + 2000;
    assert.equal(viewOf('SILENT', missionsOverview({ home: dir, now: clock.t })), 'stalled', 'a fresh read at this instant says stalled');
    assert.equal(viewOf('SILENT'), 'working', 'inside the bound, the first read answers');
    clock.t = t0 + MISSIONS_CACHE_MS;
    assert.equal(viewOf('SILENT'), 'stalled', 'past the bound, a fresh read');
    upsertMission('WRITTEN', { title: 'Written' }, { home: dir, now: clock.t });
    clock.t += 1;
    assert.equal(viewOf('WRITTEN'), 'waiting', 'a record written inside the bound is read');
  });

  await check('with sessions listed, the overview counts each tab in its column and never in the caps; a tab\'s rounds follow board writes and removals, a board file is read again only once it moved, and an unreadable one warns once', () => {
    const dir = scratchHome('cache-tabs');
    const start = '2026-10-29T11:00:00Z';
    const tab = (id, pid, status) => ({ id, pid, procStart: start, kind: 'interactive', jobId: null, cwd: '/Users/pm/work/repo', login: null, name: null, status, reason: null });
    const sessions = createSessionList();
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      sessions.replace({
        intervalMs: 60_000,
        sessions: [tab('asks', 7001, 'idle'), tab('busy-1', 7002, 'busy'), tab('busy-2', 7003, 'busy'), tab('busy-3', 7004, 'busy'), tab('idle', 7005, 'idle')],
      });
      const asking = createBoard({ title: 'a tab asks', blocks: [{ kind: 'question', prompt: 'Go?', widget: 'single', options: [{ label: 'Yes' }] }] });
      asking.session = { pid: 7001, procStart: start, id: 'asks' };
      writeBoard(asking, dir);
      writeFileSync(path.join(dir, 'boards', 'broken.json'), '{');
      const clock = { t: Date.parse('2026-10-29T12:00:00Z') };
      const cache = createMissionsCache({ home: dir, now: () => clock.t, sessions });
      const stateOf = (overview, id) => overview.tabs.find(t => t.id === id).state;

      const first = cache.overview();
      assert.deepEqual(first.counts, { needsYou: 1, working: 3, waiting: 1, stalled: 0, released: 0, queued: 0 });
      assert.deepEqual(first.live, { working: 0, alive: 0 }, 'the launch caps count no tab');
      assert.deepEqual(first.tabs.find(t => t.id === 'asks').rounds, [{ board: asking.id, round: 1 }]);

      // A board that has not moved is not read again: one this process can no longer open
      // keeps its round when another board's write sends the next call to the store.
      const boardFile = path.join(dir, 'boards', `${asking.id}.json`);
      const unreadable = typeof process.getuid !== 'function' || process.getuid() !== 0;
      if (unreadable) chmodSync(boardFile, 0o000);
      writeBoard(createBoard({ title: 'another', blocks: [{ kind: 'markdown', text: 'x' }] }), dir);
      clock.t += 1;
      try {
        assert.equal(stateOf(cache.overview({ all: true }), 'asks'), 'needs-you');
      } finally {
        if (unreadable) chmodSync(boardFile, 0o644);
      }
      sessions.replace({ intervalMs: 60_000, sessions: [tab('asks', 7001, 'idle')] });
      clock.t += 1;
      assert.equal(stateOf(cache.overview(), 'asks'), 'needs-you');

      rmSync(boardFile);
      clock.t += 1;
      const after = cache.overview();
      assert.equal(stateOf(after, 'asks'), 'waiting', 'a removed board takes its round with it');
      assert.equal(after.counts.needsYou, 0);
      assert.equal(warnings.filter(w => w.includes('broken.json')).length, 1, `warned once: ${JSON.stringify(warnings)}`);
    } finally {
      console.warn = warn;
      sessions.close();
    }
  });

  await check('a mission shows stalled when its session\'s process is gone', async () => {
    const gonePid = await deadPid();
    await post('/api/mission/DEAD_PID/launch', { phase: 'direct' });
    // Bound while the stand-in is alive, then gone.
    const session = liveProcess();
    await post('/api/mission/DEAD_PID/session', { pid: session.pid });
    const alive = (await getJson('/api/mission/DEAD_PID')).body;
    assert.deepEqual([alive.view, alive.gone], ['working', null]);
    await endProcess(session);
    const view = (await getJson('/api/mission/DEAD_PID')).body;
    assert.equal(view.view, 'stalled');
    assert.deepEqual(view.gone, { lastSeenAt: readMission('DEAD_PID', home).session.seenAt }, 'gone, with its last heartbeat');
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
    assert.equal(deriveState({ ...at(minutes(600)), state: 'released' }, { home, now, isAlive: () => false }), 'released', 'a released mission stays released after its session ends');
  });

  await check('a round asking for the PM reads needs-you ahead of stalled, whether the session is gone, silent or still there', () => {
    const dir = scratchHome('ahead-of-stalled');
    const now = Date.parse('2026-10-28T12:00:00Z');
    const boardId = 'b_aheadofstalled';
    mkdirSync(path.join(dir, 'boards'), { recursive: true });
    writeFileSync(path.join(dir, 'boards', `${boardId}.json`), JSON.stringify({
      id: boardId, thread: 't', title: 'q', cwd: null, createdAt: iso(now), updatedAt: iso(now), state: 'open',
      // No wait on it: the session that asked has stopped waiting, and the round still asks.
      rounds: [{ n: 1, postedAt: iso(now - minutes(90)), status: 'open', sentAt: null, title: 'q' }],
      blocks: [{ id: 'q1', kind: 'question', round: 1, prompt: 'Merge?', widget: 'single', options: [{ label: 'Merge' }] }],
      answers: {}, comments: [],
    }));
    const linked = [{ id: boardId, url: 'http://x/b/' + boardId, at: iso(now) }];
    for (const [what, seenAgo, isAlive, unlinked] of [
      ['its process gone', minutes(1), () => false, 'stalled'],
      ['silent past the stall', STALL_SILENCE_MS + minutes(1), () => true, 'stalled'],
      ['still heard from', minutes(1), () => true, 'working'],
    ]) {
      const m = { key: 'K', state: 'working', boards: linked, session: { pid: 4242, startedAt: iso(now - minutes(120)), seenAt: iso(now - seenAgo) } };
      assert.equal(deriveState(m, { home: dir, now, isAlive }), 'needs-you', `${what}, with the round open`);
      assert.equal(deriveState({ ...m, boards: [] }, { home: dir, now, isAlive }), unlinked, `${what}, with no round`);
    }
  });

  await check('a view carries gone with its last heartbeat while its bound process is gone or its reservation lapsed, and none once the mission recorded its end', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const seenAt = iso(now - minutes(42));
    const bound = { pid: 4343, id: 's', startedAt: iso(now - minutes(60)), seenAt };
    const viewOf = (fields, isAlive) => missionView({ key: 'K', state: 'working', phase: 'direct', boards: [], ...fields }, { home, now, isAlive });
    assert.deepEqual(viewOf({ session: bound }, () => false).gone, { lastSeenAt: seenAt });
    assert.equal(viewOf({ session: bound }, () => true).gone, null);
    const reserved = { startedAt: iso(now - UNBOUND_GRACE_MS - 1000), seenAt: iso(now - UNBOUND_GRACE_MS - 1000) };
    assert.deepEqual(viewOf({ session: reserved }, () => true).gone, { lastSeenAt: reserved.seenAt }, 'a start no process bound');
    assert.equal(viewOf({ session: bound, state: 'released' }, () => false).gone, null, 'a released mission\'s session is expected to end');
    assert.equal(viewOf({ session: bound, phase: 'grill', fire: { at: seenAt, by: 'round' } }, () => false).gone, null, 'a fired grill too');
    assert.equal(viewOf({ session: null }, () => false).gone, null);
  });

  await check('POST /api/mission/:key/facts sets each listed PR\'s state and head in the view, replacing by repo and number, and drops a fact for a PR not listed', async () => {
    const pr = (repo, number) => ({ repo, number, url: `https://github.com/o/${repo}/pull/${number}` });
    await post('/api/mission/FACTS', { title: 'Facts', prs: [{ ...pr('service', 12), state: 'merged' }, pr('admin', 7)] });
    const first = await post('/api/mission/FACTS/facts', { prs: [
      { repo: 'service', number: 12, state: 'red', head: 'abc123', checkedAt: '2026-10-30T10:00:00.000Z' },
      { repo: 'client', number: 3, state: 'green', head: 'fff000', checkedAt: '2026-10-30T10:00:00.000Z' },
    ] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.prs.map(p => [p.repo, p.number, p.state, p.head, p.checkedAt]), [
      ['service', 12, 'red', 'abc123', '2026-10-30T10:00:00.000Z'],
      ['admin', 7, 'checking', null, null],
    ], 'the session\'s merged is not the view\'s; a PR with no fact yet is checking; client #3 is not listed');
    const updatedAt = readMission('FACTS', home).updatedAt;

    await post('/api/mission/FACTS/facts', { prs: [{ repo: 'service', number: 12, state: 'green', head: 'def456', checkedAt: '2026-10-30T10:02:00.000Z' }] });
    const view = (await getJson('/api/mission/FACTS')).body;
    assert.deepEqual(view.prs.map(p => [p.repo, p.state, p.head]), [['service', 'green', 'def456'], ['admin', 'checking', null]]);
    const record = readMission('FACTS', home);
    assert.deepEqual(record.prFacts, [{ repo: 'service', number: 12, state: 'green', head: 'def456', checkedAt: '2026-10-30T10:02:00.000Z' }]);
    assert.equal(record.updatedAt, updatedAt, 'a reading is not a change the mission made');

    for (const body of [
      { prs: [{ repo: 'service', number: 12, state: 'passing', head: 'x' }] },
      { prs: [{ repo: 'service', number: 12, state: 'green' }] },
      { prs: [{ repo: 'service', number: 12, state: 'green', head: 'x', checkedAt: 'soon' }] },
      { prs: [{ repo: 'service', number: 12, state: 'green', head: 'x', url: 'u' }] },
      { prs: {} }, { facts: [] },
    ]) {
      assert.equal((await post('/api/mission/FACTS/facts', body)).status, 400, `${JSON.stringify(body)} is refused`);
    }
    assert.deepEqual(readMission('FACTS', home).prFacts, record.prFacts, 'a refused post writes nothing');
    assert.equal((await post('/api/mission/NO_SUCH_MISSION/facts', { prs: [] })).status, 404);
  });

  await check('a card\'s recheck, by the cookie, drops the cached overview and answers the fresh view, so a gone session shows at once', async () => {
    await post('/api/mission/RECHECK/launch', { phase: 'direct' });
    const session = liveProcess();
    await post('/api/mission/RECHECK/session', { pid: session.pid });
    const viewIn = async () => (await getJson('/api/missions')).body.missions.find(m => m.key === 'RECHECK');
    assert.deepEqual([(await viewIn()).view, (await viewIn()).gone], ['working', null], 'setup: the cached overview holds it working');
    await endProcess(session);
    const cookie = sessionCookieHeader(SECRET);
    const r = await rawRequest(port, 'POST', '/api/mission/RECHECK/recheck', { headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    assert.equal(r.status, 200, r.body);
    const answer = JSON.parse(r.body);
    assert.deepEqual([answer.view, answer.gone], ['stalled', { lastSeenAt: readMission('RECHECK', home).session.seenAt }]);
    const listed = await viewIn();
    assert.deepEqual([listed.view, listed.gone], [answer.view, answer.gone], 'the list reads it fresh, not from the cache');
    assert.equal((await post('/api/mission/NO_SUCH_MISSION/recheck', {})).status, 404);
  });

  await check('a mission leaving needs-you drops its waitingOn, unless the same write sets one; staying in needs-you keeps it', () => {
    const dir = scratchHome('waiting-on');
    const t0 = Date.parse('2026-10-28T12:00:00Z');
    const waitingOn = key => readMission(key, dir).waitingOn;
    for (const key of ['MERGED', 'NEXT_WAIT', 'STILL_ASKING']) {
      upsertMission(key, { phase: 'landing', state: 'needs-you', waitingOn: 'the merge yes' }, { home: dir, now: t0 });
    }

    upsertMission('MERGED', { state: 'working' }, { home: dir, now: t0 + 1000 });
    assert.equal(waitingOn('MERGED'), undefined, 'working after the merge yes waits on nothing');
    upsertMission('MERGED', { state: 'released' }, { home: dir, now: t0 + 2000 });
    assert.equal(waitingOn('MERGED'), undefined);

    upsertMission('NEXT_WAIT', { state: 'working', waitingOn: 'the deploy' }, { home: dir, now: t0 + 1000 });
    assert.equal(waitingOn('NEXT_WAIT'), 'the deploy');

    upsertMission('STILL_ASKING', { summary: 'Merge is green' }, { home: dir, now: t0 + 1000 });
    upsertMission('STILL_ASKING', { state: 'needs-you' }, { home: dir, now: t0 + 2000 });
    assert.equal(waitingOn('STILL_ASKING'), 'the merge yes');
  });

  await check('a released mission leaves the list 24 hours after it was released, and ?all=1 keeps it', async () => {
    const dir = scratchHome('released');
    const now = Date.parse('2026-10-28T12:00:00Z');
    upsertMission('RELEASED_OLD', { state: 'released' }, { home: dir, now: now - RELEASED_VISIBLE_MS - 1000 });
    upsertMission('RELEASED_NEW', { state: 'released' }, { home: dir, now: now - RELEASED_VISIBLE_MS + 60_000 });
    const keys = o => o.missions.map(m => m.key).sort();
    assert.deepEqual(keys(missionsOverview({ home: dir, now })), ['RELEASED_NEW']);
    assert.deepEqual(keys(missionsOverview({ home: dir, now, all: true })), ['RELEASED_NEW', 'RELEASED_OLD']);
    assert.equal(readMission('RELEASED_OLD', dir).releasedAt, iso(now - RELEASED_VISIBLE_MS - 1000));

    // The same over the route, on the daemon's store.
    seed(home, 'ROUTE_RELEASED', { state: 'released', releasedAt: iso(Date.now() - RELEASED_VISIBLE_MS - 60_000) });
    const listed = (await getJson('/api/missions')).body.missions.map(m => m.key);
    const all = (await getJson('/api/missions?all=1')).body.missions.map(m => m.key);
    assert.ok(!listed.includes('ROUTE_RELEASED'));
    assert.ok(all.includes('ROUTE_RELEASED'));
  });

  await check('a record stored landed, from before ADR 130, reads as released through readMission and missionsOverview, and the read leaves the file as stored', () => {
    const dir = scratchHome('read-shim');
    const landedAt = '2026-10-28T11:00:00.000Z';
    const now = Date.parse('2026-10-28T12:00:00Z');
    seed(dir, 'RAW_LANDED', {
      phase: 'landing', state: 'landed', landedAt, now: Date.parse(landedAt),
      history: [{ at: '2026-10-28T10:00:00.000Z', phase: 'landing', state: 'working' }, { at: landedAt, phase: 'landing', state: 'landed' }],
    });
    const file = path.join(dir, 'missions', 'RAW_LANDED.json');
    const stored = readFileSync(file, 'utf8');

    const record = readMission('RAW_LANDED', dir);
    assert.deepEqual([record.state, record.releasedAt, 'landedAt' in record], ['released', landedAt, false]);
    assert.deepEqual(record.history.map(h => h.state), ['working', 'released']);

    const overview = missionsOverview({ home: dir, now, isAlive: () => false });
    assert.deepEqual(overview.missions.map(m => [m.key, m.state, m.view, m.releasedAt]), [['RAW_LANDED', 'released', 'released', landedAt]]);
    assert.equal(overview.counts.released, 1);
    assert.equal(readFileSync(file, 'utf8'), stored, 'a read never writes');
  });

  await check('a record stored landed, from before ADR 130, is rewritten released once the daemon holds its port, its landedAt as releasedAt; a start that cannot bind and a second start rewrite nothing', async () => {
    const dir = scratchHome('migrate');
    const landedAt = '2026-10-27T09:30:00.000Z';
    seed(dir, 'OLD_LANDED', {
      phase: 'landing', state: 'landed', landedAt, now: Date.parse('2026-10-27T09:30:00Z'),
      history: [{ at: '2026-10-27T08:00:00.000Z', phase: 'landing', state: 'working' }, { at: landedAt, phase: 'landing', state: 'landed' }],
    });
    seed(dir, 'STILL_WORKING', { state: 'working' });
    const file = key => path.join(dir, 'missions', `${key}.json`);
    // A rewrite is a temp-and-rename, so it always lands a new inode.
    const inode = key => statSync(file(key)).ino;
    const untouched = inode('STILL_WORKING');

    // A start that cannot bind, as beside an older daemon still holding the port, migrates nothing.
    const holder = http.createServer();
    await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
    const stored = readFileSync(file('OLD_LANDED'), 'utf8');
    try {
      await assert.rejects(startServer({ home: dir, port: holder.address().port }), { code: 'EADDRINUSE' });
    } finally {
      await new Promise(resolve => holder.close(resolve));
    }
    assert.equal(readFileSync(file('OLD_LANDED'), 'utf8'), stored, 'a failed bind leaves the record stored landed');

    const first = await startServer({ home: dir, port: 0 });
    try {
      const onDisk = JSON.parse(readFileSync(file('OLD_LANDED'), 'utf8'));
      assert.equal(onDisk.state, 'released');
      assert.equal(onDisk.releasedAt, landedAt, 'the moment it landed is kept as the moment it was released');
      assert.equal('landedAt' in onDisk, false);
      assert.deepEqual(onDisk.history.map(h => h.state), ['working', 'released']);
      assert.equal(inode('STILL_WORKING'), untouched, 'a record with nothing to move is not rewritten');
      const r = await rawRequest(first.port, 'GET', '/api/mission/OLD_LANDED', { headers: { [SECRET_HEADER]: SECRET } });
      const view = JSON.parse(r.body);
      assert.deepEqual([view.state, view.view, view.releasedAt], ['released', 'released', landedAt]);
    } finally {
      await new Promise(resolve => first.server.close(resolve));
    }
    const migrated = inode('OLD_LANDED');
    const second = await startServer({ home: dir, port: 0 });
    await new Promise(resolve => second.server.close(resolve));
    assert.equal(inode('OLD_LANDED'), migrated, 'a second start finds nothing to move');
  });

  await check('a POST carrying state landed, from a session open before ADR 130, stores released and stamps releasedAt', async () => {
    const r = await post('/api/mission/POST_LANDED', { title: 'Shipped before the rename', phase: 'landing', state: 'landed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const record = readMission('POST_LANDED', home);
    assert.equal(record.state, 'released');
    assert.ok(Number.isFinite(Date.parse(record.releasedAt)), `releasedAt is stamped: ${record.releasedAt}`);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'missions', 'POST_LANDED.json'), 'utf8')).state, 'released', 'stored as released on disk');
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

  await check('POST /api/mission/:key writes the whitelisted fields and answers the view, with history on a phase or state change only; a PR\'s state the session sends is dropped', async () => {
    const fields = {
      title: 'Front agent', cwd: '/tmp/x', phase: 'grill', state: 'working', summary: 'The Master Chief fronts sessions.',
      waitingOn: 'nothing', next: 'direct', prs: [{ repo: 'claude-board', number: 7, url: 'https://github.com/x/y/pull/7', state: 'open' }],
      handoff: 'Handoff\n- step', fire: { by: 'card' }, retiredAt: '2026-10-01T00:00:00Z',
    };
    const r = await post('/api/mission/WHITELIST', fields);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'fire' || k === 'prs') continue;
      assert.deepEqual(r.body[k], v, `${k} is stored as written`);
    }
    assert.equal(r.body.fire.by, 'card');
    assert.deepEqual(readMission('WHITELIST', home).prs, [{ repo: 'claude-board', number: 7, url: 'https://github.com/x/y/pull/7' }],
      'a PR is stored by its name alone');
    assert.deepEqual(r.body.prs, [{ repo: 'claude-board', number: 7, url: 'https://github.com/x/y/pull/7', state: 'checking', head: null, checkedAt: null }],
      'the view says checking until a fact arrives, whatever the session said');
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
      { prs: [{ repo: 'r', number: 1, url: 'u', state: 'open', body: 'x' }] }, { prs: [{ repo: 'r', number: 1, url: 'u', state: 'passing' }] }, { title: null },
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

  await check('a pm order is the Master Chief\'s, listed on the bound session\'s binding until that session marks it seen; seen by another session is a 409, and seen and resent each set once', async () => {
    assert.equal((await post('/api/mission/PM_ORDERS/join', { id: 'pm-sess', pid: 9191 })).status, 200);
    assert.equal((await post('/api/mission/PM_ORDERS/order', { kind: 'pm' })).status, 400, 'a pm order needs its text');
    const words = 'Hold the merge until the dashboard is green.';
    const order = (await post('/api/mission/PM_ORDERS/order', { kind: 'pm', text: words })).body.order;
    assert.deepEqual([order.kind, order.text, order.by], ['pm', words, 'master-chief']);
    assert.match(order.id, /^o_[0-9a-f]{16}$/);
    const stop = (await post('/api/mission/PM_ORDERS/order', { kind: 'stop' })).body.order;
    const binding = (await getJson('/api/binding?id=pm-sess')).body;
    assert.deepEqual(binding.orders.map(o => [o.id, o.text]), [[order.id, words]], 'the binding lists the pm orders, not a card\'s');
    assert.equal(binding.handoff, null);

    const other = await post(`/api/mission/PM_ORDERS/order/${order.id}/seen`, { id: 'not-bound', pid: 9292 });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, 'not bound');
    const seen = await post(`/api/mission/PM_ORDERS/order/${order.id}/seen`, { id: 'pm-sess' });
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.ok(seen.body.order.ackedAt);
    assert.equal((await post(`/api/mission/PM_ORDERS/order/${order.id}/seen`, { id: 'pm-sess' })).body.order.ackedAt, seen.body.order.ackedAt);
    assert.deepEqual((await getJson('/api/binding?id=pm-sess')).body.orders, [], 'a seen order leaves the binding');
    assert.equal((await getJson('/api/binding?pid=9191')).body.key, 'PM_ORDERS', 'the process alone names the session too');

    const resent = await post(`/api/mission/PM_ORDERS/order/${stop.id}/resent`, {});
    assert.ok(resent.body.order.resentAt);
    assert.equal((await post(`/api/mission/PM_ORDERS/order/${stop.id}/resent`, {})).body.order.resentAt, resent.body.order.resentAt);
    assert.equal((await post('/api/mission/PM_ORDERS/order/o_nope/seen', { id: 'pm-sess' })).status, 404);
    assert.equal((await getJson('/api/binding')).status, 400, 'a binding names its session');
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

  await check('a board posted by a session bound to a mission, naming none, links to that mission; once the session leaves, its next board links to none', async () => {
    const tab = liveProcess();
    const start = '2026-10-30T07:00:00Z';
    try {
      assert.equal((await post('/api/mission/BOUND_POSTS/join', { id: 'poster', pid: tab.pid, procStart: start })).status, 200);
      const ask = { blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }], session: { pid: tab.pid, procStart: start } };
      const linked = await post('/api/board', { title: 'Bound round', ...ask });
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(readBoard(linked.body.boardId, home).mission, 'BOUND_POSTS');
      assert.deepEqual(readMission('BOUND_POSTS', home).boards.map(b => b.id), [linked.body.boardId]);

      assert.equal((await post('/api/mission/BOUND_POSTS/leave', { id: 'poster' })).status, 200);
      const loose = await post('/api/board', { title: 'Hand tab round', ...ask });
      assert.equal(readBoard(loose.body.boardId, home).mission ?? null, null);
      assert.deepEqual(readMission('BOUND_POSTS', home).boards.map(b => b.id), [linked.body.boardId]);
    } finally {
      await endProcess(tab);
    }
  });

  await check('a board post with a bad mission key is a 400 that writes no board', async () => {
    const before = readdirSync(path.join(home, 'boards')).length;
    const r = await post('/api/board', { title: 'x', mission: '../etc', blocks: [{ kind: 'markdown', text: 'x' }] });
    assert.equal(r.status, 400);
    assert.equal(readdirSync(path.join(home, 'boards')).length, before);
  });

  await check('a board post whose body is not a JSON object is a 400 that writes no board', async () => {
    const before = readdirSync(path.join(home, 'boards')).length;
    for (const body of ['null', '5', '[]']) {
      const r = await rawRequest(port, 'POST', '/api/board', { headers: writeHeaders(SECRET), body });
      assert.equal(r.status, 400, `${body}: ${r.body}`);
      assert.deepEqual(JSON.parse(r.body), { error: 'the body must be a JSON object' });
    }
    assert.equal(readdirSync(path.join(home, 'boards')).length, before);
  });

  await check('a board post whose mission record cannot be read or written still answers 200 and pushes its round; the record is left as it was', async () => {
    const record = path.join(home, 'missions', 'UNREADABLE.json');
    writeFileSync(record, '{"key":"UNREA');
    let sse;
    try {
      const blocks = [{ kind: 'markdown', text: 'x' }];
      const first = await post('/api/board', { title: 'unlinked', mission: 'UNREADABLE', blocks });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(readBoard(first.body.boardId, home).mission, 'UNREADABLE');
      sse = await openSseClient(port, first.body.boardId, { secret: SECRET });
      const second = await post('/api/board', { boardId: first.body.boardId, mission: 'UNREADABLE', requestId: 'unreadable-2', blocks });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.round, 2);
      await waitFor(() => sse.events.some(e => e.event === 'round'), { what: 'the second round pushed to the open board' });
      assert.equal(readFileSync(record, 'utf8'), '{"key":"UNREA');
    } finally {
      sse?.res.destroy();
      rmSync(record, { force: true });
    }
  });

  // --- Fire ---------------------------------------------------------------------------

  /** A grill mission whose session's process is gone, and its board holding one round: a
   * `single` question carrying `action`, with its two labels. */
  async function grillRound(key, action, labels) {
    assert.equal((await post(`/api/mission/${key}`, { title: key, phase: 'grill', state: 'waiting' })).status, 200);
    assert.equal((await post(`/api/mission/${key}/session`, { pid: await deadPid(), id: `grill-${key}` })).status, 200);
    const posted = await post('/api/board', {
      title: `${key} grill`, mission: key,
      blocks: [{ kind: 'question', prompt: 'Go?', widget: 'single', action, options: labels.map(label => ({ label })) }],
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    return { boardId: posted.body.boardId, qid: readBoard(posted.body.boardId, home).blocks[0].id };
  }

  for (const [key, action, pick, route, fired] of [
    ['FIRE_SENT', 'fire', 0, 'submit', true],
    ['FIRE_RELAYED', 'fire', 0, 'relay', true],
    ['FIRE_NOT_YET', 'fire', 1, 'submit', false],
    ['MERGE_SENT', 'merge', 0, 'submit', false],
  ]) {
    const label = fired ? `records fire by 'round' on its mission` : 'records no fire';
    await check(`a ${action} round answered with option ${pick} through ${route}, its grill session gone, ${label} and publishes missions`, async () => {
      const labels = action === 'fire' ? ['Fire /direct', 'Not yet'] : ['Merge', 'Hold'];
      const { boardId, qid } = await grillRound(key, action, labels);
      const stream = await missionsStream();
      try {
        const before = Date.now();
        const answers = [{ id: qid, status: 'answered', choice: labels[pick], note: '' }];
        const body = route === 'relay' ? { round: 1, answers, words: 'fire it' } : { round: 1, action: 'send', answers, comments: [] };
        const sent = await post(`/api/board/${boardId}/${route}`, body);
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        await waitFor(() => stream.saw(key), { what: `a missions event for ${key}` });
        const { fire } = readMission(key, home);
        if (!fired) return assert.equal(fire, undefined);
        assert.equal(fire.by, 'round');
        assert.ok(Date.parse(fire.at) >= before - 1000, `fire.at is the submit's moment: ${fire.at}`);
        const view = (await getJson(`/api/mission/${key}`)).body;
        assert.deepEqual([view.live, view.view, view.actions], [false, 'waiting', []], 'the fired grill holds the mission no more and offers no Fire');
      } finally {
        stream.close();
      }
    });
  }

  await check('a second Fire on the sent round is a 409 that leaves the first fire as it was', async () => {
    const { boardId, qid } = await grillRound('FIRE_TWICE', 'fire', ['Fire /direct', 'Not yet']);
    const body = { round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Fire /direct', note: '' }], comments: [] };
    assert.equal((await post(`/api/board/${boardId}/submit`, body)).status, 200);
    const first = readMission('FIRE_TWICE', home).fire;
    assert.equal((await post(`/api/board/${boardId}/submit`, { ...body, via: 'card' })).status, 409);
    assert.deepEqual(readMission('FIRE_TWICE', home).fire, first);
  });

  await check('a Fire whose mission record cannot be read or written still answers 200 and sends the round; the record is left as it was', async () => {
    const { boardId, qid } = await grillRound('FIRE_UNREADABLE', 'fire', ['Fire /direct', 'Not yet']);
    const record = path.join(home, 'missions', 'FIRE_UNREADABLE.json');
    writeFileSync(record, '{"key":"FIRE_UN');
    try {
      const sent = await post(`/api/board/${boardId}/submit`, {
        round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Fire /direct', note: '' }], comments: [],
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(readBoard(boardId, home).rounds[0].status, 'sent');
      assert.equal(readFileSync(record, 'utf8'), '{"key":"FIRE_UN');
    } finally {
      rmSync(record, { force: true });
    }
  });

  await check('an unreadable missions store draws the home page with empty columns, and GET /api/missions answers an error', async () => {
    const dir = path.join(home, 'missions');
    chmodSync(dir, 0o000);
    try {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      const list = await getJson('/api/missions');
      assert.equal(list.status, 500);
      assert.match(list.body.error, /^the missions could not be read: EACCES/);
    } finally {
      chmodSync(dir, 0o755);
    }
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
    const stream = await missionsStream();
    try {
      await post('/api/mission/STREAMED', { summary: 'changed' });
      await waitFor(() => stream.saw('STREAMED'), { what: 'a missions event for the write' });
      await post('/api/board', { title: 'streamed board', mission: 'STREAMED_BOARD', blocks: [{ kind: 'markdown', text: 'x' }] });
      await waitFor(() => stream.saw('STREAMED_BOARD'), { what: 'a missions event for the board post' });
    } finally {
      stream.close();
    }
  });

  // --- the gates --------------------------------------------------------------------

  await check('the cookie may read the list and post a card\'s order, and may not write, launch, join, leave, bind, post a pm order, ack, mark seen or resent, post PR facts, or read one mission or a binding', async () => {
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
      ['POST', '/api/mission/COOKIE/join', { id: 'forged' }],
      ['POST', '/api/mission/COOKIE/leave', { id: 'forged' }],
      ['POST', '/api/mission/COOKIE/order', { kind: 'pm', text: 'forged words' }],
      ['POST', `/api/mission/COOKIE/order/${orderId}/ack`, {}],
      ['POST', `/api/mission/COOKIE/order/${orderId}/seen`, { id: 'forged' }],
      ['POST', `/api/mission/COOKIE/order/${orderId}/resent`, {}],
      ['POST', '/api/mission/COOKIE/facts', { prs: [] }],
      ['GET', '/api/mission/COOKIE', null],
      ['GET', '/api/binding?id=forged', null],
    ]) {
      const r = await rawRequest(port, method, route, { headers: asCookie, body: body && JSON.stringify(body) });
      assert.equal(r.status, 401, `${method} ${route} with the cookie alone is refused`);
    }
    const cookieRecord = readMission('COOKIE', home);
    assert.equal(cookieRecord.summary, undefined);
    assert.equal(cookieRecord.session, null);
    assert.deepEqual(cookieRecord.orders.map(o => o.kind), ['comment'], 'no pm order was stored');
    for (const route of ['/api/missions', '/api/mission/COOKIE']) {
      assert.equal((await rawRequest(port, 'GET', route)).status, 401, `${route} with no credential is refused`);
    }
    assert.equal((await rawRequest(port, 'POST', '/api/mission/COOKIE/order', { headers: { 'content-type': 'application/json' }, body: '{"kind":"stop"}' })).status, 401);
  });

  await check('GET /api/missions answers missions, tab cards, counts, live, now and the session watcher', async () => {
    const r = await getJson('/api/missions');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['counts', 'live', 'missions', 'now', 'tabs', 'watcher']);
    assert.deepEqual(Object.keys(r.body.watcher).sort(), ['lastAt', 'up']);
    assert.deepEqual(Object.keys(r.body.counts).sort(), ['needsYou', 'queued', 'released', 'stalled', 'waiting', 'working']);
    assert.deepEqual(Object.keys(r.body.live).sort(), ['alive', 'working']);
    const total = Object.values(r.body.counts).reduce((a, b) => a + b, 0);
    const tabsNeedingYou = r.body.tabs.filter(t => t.state === 'needs-you').length;
    assert.equal(total, r.body.missions.length + tabsNeedingYou, 'every listed mission is counted in one column, and a tab only in Needs you');
  });
}

await runMain('missions', main, {
  cleanup: async () => {
    for (const child of children) await endProcess(child);
    if (server) await new Promise(resolve => server.close(resolve));
  },
});
