// One board per mission (ADR 150): a daemon on a temp store, sessions named by real live
// processes, posting the way the shim does. Every session bound to a mission posts on the
// mission's one board, each round its own: its own folder, its own boundaries, and on a
// takeover the giver's open round handed to the taker. A hand-over reopens in place the
// rounds the last session left unanswered (ADR 151). The last check drives the real shim.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { SECRET_HEADER } from '../src/secret.mjs';
import { WAIT_CEILING_MS } from '../src/handoff.mjs';
import { readBoard, readMission, writeBoard } from '../src/store.mjs';
import { linkBoard } from '../src/missions.mjs';
import { abandonOpenRounds, addRound, createBoard } from '../src/board.mjs';
import { processStartUtc } from '../src/proc-start.mjs';
import { McpClient, check, mcpBin, openSseClient, rawRequest, repoRoot, runMain, secretFetch, secretHome, waitFor, writeHeaders } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-mission-board-');
const fetch = secretFetch(SECRET);
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);
// One wait, pinned: a reopened round's deadline is asserted against it.
const WAIT_MS = 2_400_000;
process.env.CLAUDE_BOARD_TIMEOUT_MS = String(WAIT_MS);
const START = '2026-11-11T08:00:00Z';

let server, port, base;
const children = new Set();

/** A live process whose pid names one session, at the made-up start `START`. */
function sessionProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(child);
  return { child, ref: { pid: child.pid, procStart: START } };
}

async function post(route, body) {
  const r = await rawRequest(port, 'POST', route, { headers: writeHeaders(SECRET), body: JSON.stringify(body) });
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}

/** A post shaped as the shim sends it: its folder, and its session's process. */
async function ask(session, folder, blocks, extra = {}) {
  const r = await post('/api/board', { title: 'Round', blocks, cwd: folder, noWait: true, session: session.ref, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const join = (key, id, session, extra = {}) => post(`/api/mission/${key}/join`, { id, ...session.ref, ...extra });
const leave = (key, id, session) => post(`/api/mission/${key}/leave`, { id, ...session.ref });
/** Binds `session` to mission `key` by its heartbeat, with no join: the rounds the session
 * before it left unanswered are handed at a join alone (ADR 153), so they stay that one's. */
const bind = (key, id, session) => post(`/api/mission/${key}/session`, { id, ...session.ref });
/** What `GET /api/binding` answers session `id`. */
const binding = async (id, session) => (await fetch(`${base}/api/binding?${new URLSearchParams({ id, pid: String(session.ref.pid), procStart: session.ref.procStart })}`)).json();
const question = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
const note = text => ({ kind: 'markdown', text });

/** A folder holding `notes.txt` with `text`, the file a round names by path. */
function folderWith(name, text) {
  const dir = path.join(home, 'work', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'notes.txt'), text);
  return realpathSync(dir);
}

/** The real shim, run in `folder` under its own shell, so its parent process, the session it
 * names, is not this one. `call` answers a tool call's result, refused on an error; `env`
 * adds to the shim's environment. */
async function sessionShim(folder, env = {}) {
  const child = spawn('/bin/sh', ['-c', `"${process.execPath}" "${mcpBin}"; exit $?`], {
    cwd: folder,
    env: { ...process.env, CLAUDE_BOARD_HOME: home, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_NO_OPEN: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const shim = new McpClient(child);
  await shim.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-mission-board', version: '0' } });
  shim.notify('notifications/initialized', {});
  assert.ok(processStartUtc(child.pid), 'the shell\'s start reads');
  const call = async (name, args) => {
    const r = await shim.request('tools/call', { name, arguments: args });
    assert.equal(r.result && r.result.isError, false, JSON.stringify(r));
    return r.result;
  };
  return { child, shim, call };
}

/** The daemon-wide stream the Boards page holds, once the daemon has it: `events` is every
 * event since, as `{ event, data }`, and `named(event)` the data of each one so named. */
function openIndexStream() {
  return new Promise((resolve, reject) => {
    const events = [];
    let pending = '';
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } }, res => {
      res.setEncoding('utf8');
      res.on('data', chunk => {
        pending += chunk;
        const frames = pending.split('\n\n');
        pending = frames.pop();
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.*)$/m.exec(frame);
          if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
        }
      });
      resolve({ events, named: name => events.filter(e => e.event === name).map(e => e.data), close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

/** A daemon that is not the board's: whatever holds its port answers `POST route` with
 * `answer`, and anything else 404. */
function startPeer(route, answer) {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const hit = req.method === 'POST' && req.url === route;
      const body = JSON.stringify(hit ? answer : { error: 'not found' });
      res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => { srv.close(); srv.closeAllConnections?.(); } }));
  });
}

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  await check('a mission\'s first round makes its board; a second session bound later, from another folder, posts on that board with round numbers continuing, its first question a round of its own, and each round reads its file from its poster\'s folder; the mission links that one board, a newer round from B leaves A\'s question holding it at needs you, and the answer on A\'s round rides none of B\'s packets', async () => {
    const a = sessionProcess();
    const b = sessionProcess();
    const grill = folderWith('grill', 'from the grill folder\n');
    const worktree = folderWith('worktree', 'from the worktree folder\n');
    assert.equal((await join('SHARED', 'sess-a', a)).status, 200);
    const first = await ask(a, grill, [{ kind: 'code', source: { path: 'notes.txt' } }, question('Grill it?')]);
    assert.equal(first.round, 1);
    assert.equal(readBoard(first.boardId, home).mission, 'SHARED');
    assert.equal((await leave('SHARED', 'sess-a', a)).status, 200);

    assert.equal((await bind('SHARED', 'sess-b', b)).status, 200);
    const second = await ask(b, worktree, [{ kind: 'code', source: { path: 'notes.txt' } }, question('Build it?')]);
    assert.deepEqual([second.boardId, second.round, second.moved], [first.boardId, 2, true]);

    const board = readBoard(first.boardId, home);
    const code = n => board.blocks.find(x => x.round === n && x.kind === 'code').text;
    assert.deepEqual([code(1), code(2)], ['from the grill folder\n', 'from the worktree folder\n']);
    assert.deepEqual(board.rounds.map(r => [r.n, r.status, r.session.pid, r.cwd]), [[1, 'open', a.ref.pid, grill], [2, 'open', b.ref.pid, worktree]]);
    // B's question answered, its content round is the board's newest; A's question still holds
    // the mission at needs you.
    const answer = (n, choice) => {
      const id = readBoard(first.boardId, home).blocks.find(x => x.round === n && x.kind === 'question').id;
      return post(`/api/board/${first.boardId}/submit`, { round: n, action: 'send', answers: [{ id, status: 'answered', choice, note: '' }], comments: [] });
    };
    assert.equal((await answer(2, 'Yes')).status, 200);
    assert.equal((await ask(b, worktree, [note('the plan, to read')])).round, 3);
    const listed = await (await fetch(`${base}/api/missions`)).json();
    const card = listed.missions.find(m => m.key === 'SHARED');
    assert.deepEqual(card.boards.map(x => x.id), [first.boardId], 'the card links the one board');
    assert.equal(card.view, 'needs-you');

    // The answer the PM sends on A's round rides none of B's packets.
    assert.equal((await answer(1, 'No')).status, 200);
    assert.deepEqual((await ask(b, worktree, [note('carrying on')])).answers, []);
    assert.equal((await leave('SHARED', 'sess-b', b)).status, 200);
  });

  await check('a session that posted on a board before it was bound to a mission moves to the mission\'s board for its next round, and closes only its own round left on the board it moved from, where another session\'s round stays open', async () => {
    const a = sessionProcess();
    const b = sessionProcess();
    const c = sessionProcess();
    const folder = folderWith('mover', 'x\n');
    assert.equal((await join('MOVE_TO', 'mover-a', a)).status, 200);
    const missionBoard = await ask(a, folder, [question('First?')]);
    assert.equal((await leave('MOVE_TO', 'mover-a', a)).status, 200);
    const own = await ask(b, folder, [note('before it was bound')]);
    assert.notEqual(own.boardId, missionBoard.boardId);
    assert.equal(readBoard(own.boardId, home).mission ?? null, null, 'an unbound session\'s board is its own');
    assert.equal((await ask(c, folder, [question('Another session on that board')], { boardId: own.boardId })).round, 2);

    assert.equal((await bind('MOVE_TO', 'mover-b', b)).status, 200);
    const next = await ask(b, folder, [question('After it was bound?')], { boardId: own.boardId });
    assert.deepEqual([next.boardId, next.round, next.moved], [missionBoard.boardId, 2, true]);
    assert.deepEqual(readBoard(own.boardId, home).rounds.map(r => r.status), ['abandoned', 'open']);
    assert.deepEqual(readBoard(missionBoard.boardId, home).rounds.map(r => r.status), ['open', 'open'], 'the other session\'s round stays open');
    assert.equal((await leave('MOVE_TO', 'mover-b', b)).status, 200);
  });

  await check('an unbound session keeps its own board: its rounds continue there, and a later post makes no board of another', async () => {
    const u = sessionProcess();
    const folder = folderWith('loose', 'x\n');
    const first = await ask(u, folder, [note('one')]);
    const again = await ask(u, folder, [note('two')], { boardId: first.boardId });
    assert.deepEqual([again.boardId, again.round, again.moved], [first.boardId, 2, undefined]);
    assert.equal(readBoard(first.boardId, home).mission ?? null, null);
  });

  await check('on a shared board a fresh post and a scoped abandon close only the rounds of the session that sent them, and an abandon naming no session (a shim from before) closes none a session posted', async () => {
    const a = sessionProcess();
    const b = sessionProcess();
    const folder = folderWith('scoped', 'x\n');
    assert.equal((await join('SCOPED', 'scoped-a', a)).status, 200);
    const first = await ask(a, folder, [question('A asks')]);
    assert.equal((await leave('SCOPED', 'scoped-a', a)).status, 200);
    assert.equal((await bind('SCOPED', 'scoped-b', b)).status, 200);
    await ask(b, folder, [question('B asks')]);
    const tab = await openSseClient(port, first.boardId, { secret: SECRET, comments: false });
    let fresh;
    try {
      fresh = await ask(b, folder, [question('B asks again, after a /clear')], { fresh: true });
      await waitFor(() => tab.events.some(e => e.event === 'awaitExpired'), { what: 'the closed round\'s awaitExpired on the open tab' });
      assert.deepEqual(tab.events.filter(e => e.event === 'awaitExpired').map(e => e.data), [{ round: 2 }]);
    } finally {
      tab.req.destroy();
    }
    assert.deepEqual([fresh.boardId, fresh.round], [first.boardId, 3]);
    assert.deepEqual(readBoard(first.boardId, home).rounds.map(r => r.status), ['open', 'abandoned', 'open']);

    const closed = await post(`/api/board/${first.boardId}/abandon`, { session: b.ref });
    assert.deepEqual([closed.status, closed.body.closed], [200, [3]]);
    assert.deepEqual(readBoard(first.boardId, home).rounds.map(r => r.status), ['open', 'abandoned', 'abandoned']);

    const bare = await rawRequest(port, 'POST', `/api/board/${first.boardId}/abandon`, { headers: writeHeaders(SECRET) });
    assert.deepEqual([bare.status, JSON.parse(bare.body).closed], [200, []]);
    assert.equal(readBoard(first.boardId, home).rounds[0].status, 'open');
    assert.equal((await leave('SCOPED', 'scoped-b', b)).status, 200);
  });

  await check('a takeover hands over only rounds the giver posted: a question a caller naming no session left on the mission\'s board stays no one\'s, though the giver posted there after it', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const folder = folderWith('orphan', 'x\n');
    // The board as the store holds it then: round 1 a question posted naming no session, round 2
    // the giver's, and the board's session the giver's, set by its post.
    const board = createBoard({ title: 'Orphan', blocks: [question('Asked by no session')], cwd: folder, mission: 'ORPHAN' });
    addRound(board, { blocks: [question('Asked by the giver')], session: giver.ref });
    board.session = { ...giver.ref, id: null };
    writeBoard(board, home);
    linkBoard('ORPHAN', { id: board.id, url: `${base}/b/${board.id}` }, { home });
    assert.equal((await join('ORPHAN', 'orphan-giver', giver)).status, 200);
    assert.equal((await join('ORPHAN', 'orphan-taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('ORPHAN', 'orphan-giver', giver)).status, 200);
    const [round, givers] = readBoard(board.id, home).rounds;
    assert.deepEqual([round.session, round.handedFrom], [undefined, undefined]);
    assert.deepEqual([givers.session.pid, givers.handedFrom], [taker.ref.pid, 'orphan-giver']);
    assert.equal((await leave('ORPHAN', 'orphan-taker', taker)).status, 200);
  });

  await check('a session moving to its mission\'s board from a board whose file no longer parses still posts there, once', async () => {
    const s = sessionProcess();
    const folder = folderWith('unreadable', 'x\n');
    const own = await ask(s, folder, [question('On my own board')]);
    writeFileSync(path.join(home, 'boards', `${own.boardId}.json`), '{"rounds": [');
    assert.equal((await join('UNREADABLE', 'unreadable', s)).status, 200);
    const moved = await ask(s, folder, [question('On the mission\'s')], { boardId: own.boardId });
    assert.equal(moved.moved, true);
    assert.deepEqual(readMission('UNREADABLE', home).boards.map(b => b.id), [moved.boardId]);
    assert.equal((await leave('UNREADABLE', 'unreadable', s)).status, 200);
    rmSync(path.join(home, 'boards', `${own.boardId}.json`));
  });

  await check('a takeover hands the giver\'s open rounds to the taker: its live question reopened with a fresh clock and named in the taker\'s binding, its open round that asks nothing handed with no wait, its closed one that asks nothing left the giver\'s; the answer the PM sends on the question rides the taker\'s next packet', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const folder = folderWith('takeover', 'x\n');
    assert.equal((await join('TAKEN', 'giver', giver)).status, 200);
    const asked = await ask(giver, folder, [note('closed at the next conversation')]);
    await ask(giver, folder, [note('left open')], { fresh: true });
    assert.equal((await ask(giver, folder, [question('Which way?')])).round, 3);
    assert.equal((await join('TAKEN', 'taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('TAKEN', 'giver', giver)).status, 200);
    const [closed, open, live] = readBoard(asked.boardId, home).rounds;
    const told = r => [r.status, r.awaited, r.awaitDeadline == null, r.reopenedAt == null, r.session.id, r.session.pid, r.handedFrom];
    assert.deepEqual(told(closed), ['abandoned', false, true, true, null, giver.ref.pid, undefined]);
    assert.deepEqual(told(open), ['open', false, true, true, 'taker', taker.ref.pid, 'giver']);
    assert.deepEqual(told(live), ['open', true, false, false, 'taker', taker.ref.pid, 'giver']);
    assert.equal(Date.parse(live.awaitDeadline) - Date.parse(live.reopenedAt), WAIT_MS);
    assert.deepEqual((await binding('taker', taker)).reopened, [{ board: asked.boardId, round: 3, awaitDeadline: live.awaitDeadline }]);

    const qid = readBoard(asked.boardId, home).blocks.find(x => x.kind === 'question').id;
    const sent = await post(`/api/board/${asked.boardId}/submit`, { round: 3, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: '' }], comments: [] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const next = await ask(taker, folder, [note('picking up')]);
    assert.equal(next.boardId, asked.boardId);
    assert.deepEqual(next.answers.map(x => [x.id, x.choice]), [[qid, 'Yes']]);
    assert.equal((await leave('TAKEN', 'taker', taker)).status, 200);
  });

  await check('a taker in another folder than the giver asks its own question while the handed round waits: a round of its own, reading from the taker\'s folder', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const giverFolder = folderWith('giver-wt', 'from the giver\n');
    const takerFolder = folderWith('taker-wt', 'from the taker\n');
    assert.equal((await join('ACROSS', 'across-giver', giver)).status, 200);
    const asked = await ask(giver, giverFolder, [{ kind: 'code', source: { path: 'notes.txt' } }, question('Giver asks')]);
    assert.equal((await join('ACROSS', 'across-taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('ACROSS', 'across-giver', giver)).status, 200);
    const own = await ask(taker, takerFolder, [{ kind: 'code', source: { path: 'notes.txt' } }, question('Taker asks')]);
    assert.deepEqual([own.boardId, own.round], [asked.boardId, 2]);
    const board = readBoard(asked.boardId, home);
    assert.deepEqual(board.rounds.map(r => [r.n, r.status, r.session.pid, r.cwd]), [[1, 'open', taker.ref.pid, giverFolder], [2, 'open', taker.ref.pid, takerFolder]]);
    assert.deepEqual(board.blocks.filter(x => x.kind === 'code').map(x => x.text), ['from the giver\n', 'from the taker\n']);
    assert.equal((await leave('ACROSS', 'across-taker', taker)).status, 200);
  });

  await check('a shim whose folder was removed (a worktree, after its merge) still posts: on its own board it continues there, and once it joins a mission its round lands on the mission\'s board, reading from the board\'s folder', async () => {
    const first = sessionProcess();
    const main = folderWith('removed-main', 'x\n');
    const gone = folderWith('removed-wt', 'x\n');
    assert.equal((await join('REMOVED', 'removed-first', first)).status, 200);
    const missionBoard = await ask(first, main, [note('the mission\'s first round')]);
    assert.equal((await leave('REMOVED', 'removed-first', first)).status, 200);
    const { shim, call } = await sessionShim(gone);
    try {
      const own = (await call('ask', { title: 'Own', blocks: [note('before the removal')] })).structuredContent.board;
      rmSync(gone, { recursive: true });
      const again = (await call('ask', { title: 'Own', blocks: [note('after it')] })).structuredContent;
      assert.deepEqual([again.board, again.round], [own, 2]);

      await call('mission', { action: 'join', key: 'REMOVED', session: 'removed-shim' });
      const joined = (await call('ask', { title: 'Joined', blocks: [note('on the mission\'s board')] })).structuredContent;
      assert.deepEqual([joined.board, joined.round], [missionBoard.boardId, 2]);
      assert.deepEqual(readBoard(missionBoard.boardId, home).rounds.map(r => r.cwd), [main, undefined]);
      await call('mission', { action: 'leave', key: 'REMOVED', session: 'removed-shim' });
    } finally {
      shim.close();
    }
  });

  await check('a session resumed in a new process (the same id, as the watcher lists it) still owns its rounds: its next question amends its open one, and its scoped abandon closes it', async () => {
    const before = sessionProcess();
    const after = sessionProcess();
    const folder = folderWith('resumed', 'x\n');
    const listed = s => post('/api/sessions', { intervalMs: 30_000, sessions: [{ id: 'resumed', pid: s.ref.pid, procStart: s.ref.procStart, kind: 'interactive', jobId: null, cwd: folder, login: null, name: null, status: 'idle', reason: null }] });
    try {
      assert.equal((await listed(before)).status, 200);
      assert.equal((await join('RESUMED', 'resumed', before)).status, 200);
      const first = await ask(before, folder, [question('Before the resume?')]);
      assert.equal((await listed(after)).status, 200);
      const again = await ask(after, folder, [question('After it?')]);
      assert.deepEqual([again.boardId, again.round], [first.boardId, 1]);
      const closed = await post(`/api/board/${first.boardId}/abandon`, { session: after.ref });
      assert.deepEqual([closed.status, closed.body.closed], [200, [1]]);
      assert.equal((await leave('RESUMED', 'resumed', after)).status, 200);
    } finally {
      await post('/api/sessions', { intervalMs: 30_000, sessions: [] });
    }
  });

  await check('a session that joins after the bound one went (its process gone, no leave) is asked the gone session\'s open rounds on every board the mission links, so the answer the PM sends on one rides its next packet', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('crashed', 'x\n');
    // An older board the mission links, holding a question of the gone session's, and the
    // newer one its next round lands on.
    const older = createBoard({ title: 'Older', blocks: [question('Asked on the older board')], cwd: folder, mission: 'CRASHED', session: gone.ref });
    const newer = createBoard({ title: 'Newer', blocks: [note('the newer board')], cwd: folder, mission: 'CRASHED' });
    for (const b of [older, newer]) {
      writeBoard(b, home);
      linkBoard('CRASHED', { id: b.id, url: `${base}/b/${b.id}` }, { home });
    }
    assert.equal((await join('CRASHED', 'crashed-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Asked before the crash')]);
    assert.deepEqual([asked.boardId, asked.round], [newer.id, 2]);
    gone.child.kill('SIGKILL');
    await new Promise(resolve => gone.child.once('exit', resolve));
    assert.equal((await join('CRASHED', 'crashed-next', next)).status, 200);
    const round = readBoard(asked.boardId, home).rounds[1];
    assert.deepEqual([round.status, round.session.pid, round.handedFrom], ['open', next.ref.pid, 'crashed-gone']);
    const [olderRound] = readBoard(older.id, home).rounds;
    assert.deepEqual([olderRound.status, olderRound.session.pid, olderRound.handedFrom], ['open', next.ref.pid, 'crashed-gone']);

    const qid = readBoard(asked.boardId, home).blocks.find(x => x.kind === 'question').id;
    const sent = await post(`/api/board/${asked.boardId}/submit`, { round: 2, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'No', note: '' }], comments: [] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const after = await ask(next, folder, [note('picking up')]);
    assert.deepEqual(after.answers.map(x => [x.id, x.choice]), [[qid, 'No']]);
    assert.equal((await leave('CRASHED', 'crashed-next', next)).status, 200);
  });

  // Reopening in place (ADR 151). `send` is the PM's Send on round `n`, `lapse` a wait that
  // ran out, `wait` the wait a reopened round was given, by its own stamps.
  const questionId = (boardId, n) => readBoard(boardId, home).blocks.find(x => x.round === n && x.kind === 'question').id;
  const send = (boardId, n, choice) => post(`/api/board/${boardId}/submit`, { round: n, action: 'send', answers: [{ id: questionId(boardId, n), status: 'answered', choice, note: '' }], comments: [] });
  const lapse = (boardId, n) => {
    const board = readBoard(boardId, home);
    Object.assign(board.rounds[n - 1], { awaited: true, awaitDeadline: new Date(Date.now() - 60_000).toISOString() });
    writeBoard(board, home);
  };
  const wait = round => Date.parse(round.awaitDeadline) - Date.parse(round.reopenedAt);
  const kill = async session => {
    session.child.kill('SIGKILL');
    await new Promise(resolve => session.child.once('exit', resolve));
  };
  const state = (boardId, n) => {
    const r = readBoard(boardId, home).rounds[n - 1];
    return [r.status, r.awaited, r.session.pid];
  };
  /** The session watcher's list, holding `session`'s process under `id` and no other session. */
  const watcherLists = (session, folder, id) => post('/api/sessions', { intervalMs: 30_000, sessions: [{ id, pid: session.ref.pid, procStart: session.ref.procStart, kind: 'interactive', jobId: null, cwd: folder, login: null, name: null, status: 'idle', reason: null }] });

  await check('a join after the mission\'s session went reopens in place each round it left unanswered, one closed by its clear and one lapsed: the same number, nothing on the board moved but the round\'s state, a fresh 40-minute clock, the new session\'s; the join names each, the PM\'s Send on one answers the answer watch\'s collect and read, and on the other rides the new session\'s next packet', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('reopen', 'x\n');
    assert.equal((await join('REOPEN', 'reopen-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Left at its clear?')]);
    await ask(gone, folder, [question('Left to lapse?')], { fresh: true, title: 'Second' });
    lapse(asked.boardId, 2);
    const before = readBoard(asked.boardId, home);
    assert.deepEqual(before.rounds.map(r => [r.n, r.status, r.awaited]), [[1, 'abandoned', false], [2, 'open', false]]);
    await kill(gone);

    const joined = await join('REOPEN', 'reopen-next', next);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const after = readBoard(asked.boardId, home);
    assert.deepEqual(after.rounds.map(r => [r.n, r.status, r.awaited, r.session.pid, r.handedFrom, r.abandonedAt]), [
      [1, 'open', true, next.ref.pid, 'reopen-gone', undefined],
      [2, 'open', true, next.ref.pid, 'reopen-gone', undefined],
    ]);
    assert.deepEqual(after.rounds.map(wait), [WAIT_MS, WAIT_MS]);
    assert.deepEqual({ ...after, rounds: null, updatedAt: null }, { ...before, rounds: null, updatedAt: null }, 'in place: the blocks, the comments and all else stand as they were');
    assert.deepEqual(joined.body.reopened, after.rounds.map(r => ({ board: asked.boardId, round: r.n, title: r.title, url: `${base}/b/${asked.boardId}`, awaitDeadline: r.awaitDeadline })));
    assert.deepEqual(joined.body.reopened.map(r => r.title), ['Round', 'Second']);

    assert.equal((await send(asked.boardId, 1, 'Yes')).status, 200);
    const read = await (await fetch(`${base}/api/board/${asked.boardId}/read`)).json();
    assert.deepEqual(read.answers.filter(x => x.round === 1).map(x => [x.id, x.choice]), [[questionId(asked.boardId, 1), 'Yes']]);
    const collected = await post(`/api/board/${asked.boardId}/collect`, { round: 1, session: next.ref });
    assert.deepEqual([collected.body.status, collected.body.delivered, collected.body.answers.map(x => x.choice)], ['submitted', false, ['Yes']]);
    assert.equal((await send(asked.boardId, 2, 'No')).status, 200);
    const packet = await ask(next, folder, [note('picking up')]);
    assert.deepEqual(packet.answers.map(x => [x.id, x.choice]), [[questionId(asked.boardId, 2), 'No']]);
    assert.equal((await leave('REOPEN', 'reopen-next', next)).status, 200);
  });

  await check('a reopened round shows under Waiting on you on the Boards page and takes the PM\'s Send; a round the PM already sent stays sent and refuses another, and a round an earlier session left unanswered stays closed and unnamed', async () => {
    const earlier = sessionProcess();
    const gone = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('waiting', 'x\n');
    // Round 1 an earlier session left closed, before the mission's last one bound.
    const board = createBoard({ title: 'Earlier', blocks: [question('Asked by an earlier session')], cwd: folder, mission: 'WAITING', session: earlier.ref });
    assert.deepEqual(abandonOpenRounds(board, { session: earlier.ref }), [1]);
    writeBoard(board, home);
    linkBoard('WAITING', { id: board.id, url: `${base}/b/${board.id}` }, { home });
    assert.equal((await join('WAITING', 'waiting-gone', gone)).status, 200);
    assert.equal((await ask(gone, folder, [question('Answered in time?')])).round, 2);
    assert.equal((await send(board.id, 2, 'Yes')).status, 200);
    assert.equal((await ask(gone, folder, [question('Left unanswered?')])).round, 3);
    lapse(board.id, 3);
    await kill(gone);
    const waitingRows = async () => (await (await fetch(`${base}/api/waiting`)).json()).waiting.filter(r => r.boardId === board.id).map(r => r.round);
    const row = async () => (await (await fetch(`${base}/api/index/rows`)).json()).html.split('<a ').find(a => a.includes(`data-thread-id="${board.thread}"`));
    assert.deepEqual(await waitingRows(), []);
    assert.match(await row(), /data-live="false"/);

    const joined = await join('WAITING', 'waiting-next', next);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual(joined.body.reopened.map(r => r.round), [3]);
    assert.deepEqual(readBoard(board.id, home).rounds.map(r => [r.status, r.session.pid]), [['abandoned', earlier.ref.pid], ['sent', gone.ref.pid], ['open', next.ref.pid]]);
    assert.deepEqual(await waitingRows(), [3]);
    assert.match(await row(), /data-rounds-left="1" data-live="true"/);

    assert.equal((await send(board.id, 2, 'No')).status, 409, 'a sent round takes no second Send');
    assert.equal((await send(board.id, 3, 'Yes')).status, 200);
    assert.deepEqual(await waitingRows(), []);
    assert.equal((await leave('WAITING', 'waiting-next', next)).status, 200);
  });

  await check('a fresh ask by the new session closes its own open round and leaves a reopened one waiting, its plain question opens a round of its own beside it, and it closes a reopened round it does not want by number: that round stays closed at the next join, where the rounds it left itself reopen', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const third = sessionProcess();
    const folder = folderWith('declined', 'x\n');
    assert.equal((await join('DECLINED', 'declined-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Still wanted?')]);
    await kill(gone);
    assert.deepEqual((await join('DECLINED', 'declined-next', next)).body.reopened.map(r => r.round), [1]);

    assert.equal((await ask(next, folder, [question('The new session\'s own')])).round, 2, 'a reopened round is not amended');
    assert.equal((await ask(next, folder, [question('After its /clear')], { fresh: true })).round, 3);
    assert.deepEqual([1, 2, 3].map(n => state(asked.boardId, n)), [['open', true, next.ref.pid], ['abandoned', false, next.ref.pid], ['open', true, next.ref.pid]]);

    const closed = await post(`/api/board/${asked.boardId}/abandon`, { session: next.ref, round: 1 });
    assert.deepEqual([closed.status, closed.body.closed], [200, [1]]);
    assert.deepEqual([1, 3].map(n => state(asked.boardId, n).slice(0, 2)), [['abandoned', false], ['open', true]]);
    await kill(next);
    assert.deepEqual((await join('DECLINED', 'declined-third', third)).body.reopened.map(r => r.round), [2, 3]);
    assert.deepEqual([1, 2, 3].map(n => state(asked.boardId, n)), [['abandoned', false, next.ref.pid], ['open', true, third.ref.pid], ['open', true, third.ref.pid]]);
    assert.equal((await leave('DECLINED', 'declined-third', third)).status, 200);
  });

  // A session that left its mission on purpose (a leave with no takeover pending) gives its
  // rounds at the next join as one that went does, while its own process runs on.
  const leaverCases = {
    'still waiting, to the next session that joins': {},
    'closed since, as its next ask elsewhere closes it': { closedSince: true },
    'still waiting, to the session that joins the mission a launch reserved after the leave': { launched: true },
    'still waiting, to a session its heartbeat bound to the mission before its join': { beatFirst: true },
    'still waiting, to the session a launch reserved the mission for, its heartbeat there before its join': { launched: true, beatFirst: true },
  };
  for (const [i, [how, { closedSince = false, launched = false, beatFirst = false }]] of Object.entries(leaverCases).entries()) {
    await check(`a join after the mission's session left it with no takeover reopens in place the round the leaver left unanswered, under the session that joined: the same number, a fresh 40-minute clock, named in the join and under Waiting on you, and the PM's Send on it answers that session's collect and not the leaver's; the round the PM had sent stays sent and the leaver's, and the mission's record names the leaver no longer: ${how}`, async () => {
      const key = `LEFT_${i}`;
      const leaver = sessionProcess();
      const next = sessionProcess();
      const folder = folderWith(key.toLowerCase(), 'x\n');
      assert.equal((await join(key, `${key}-leaver`, leaver)).status, 200);
      const asked = await ask(leaver, folder, [question('Answered before it left?')]);
      assert.equal((await send(asked.boardId, 1, 'Yes')).status, 200);
      assert.equal((await ask(leaver, folder, [question('Left unanswered?')])).round, 2);
      const left = await leave(key, `${key}-leaver`, leaver);
      assert.deepEqual([left.status, left.body], [200, { left: true, session: null }]);
      if (closedSince) assert.deepEqual((await post(`/api/board/${asked.boardId}/abandon`, { session: leaver.ref })).body.closed, [2]);
      assert.deepEqual(state(asked.boardId, 2), closedSince ? ['abandoned', false, leaver.ref.pid] : ['open', true, leaver.ref.pid]);
      if (launched) assert.deepEqual((await post(`/api/mission/${key}/launch`, { phase: 'direct' })).body, { launch: true });
      if (beatFirst) assert.equal((await bind(key, `${key}-next`, next)).status, 200);
      const before = readBoard(asked.boardId, home);

      const joined = await join(key, `${key}-next`, next);
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      const after = readBoard(asked.boardId, home);
      assert.deepEqual(after.rounds.map(r => [r.n, r.status, r.session.pid, r.handedFrom, r.abandonedAt]), [
        [1, 'sent', leaver.ref.pid, undefined, undefined],
        [2, 'open', next.ref.pid, `${key}-leaver`, undefined],
      ]);
      assert.deepEqual([after.rounds[1].awaited, wait(after.rounds[1])], [true, WAIT_MS]);
      assert.deepEqual({ ...after, rounds: null, updatedAt: null }, { ...before, rounds: null, updatedAt: null }, 'in place: the blocks, the comments and all else stand as they were');
      assert.deepEqual(joined.body.reopened, [{ board: asked.boardId, round: 2, title: 'Round', url: `${base}/b/${asked.boardId}`, awaitDeadline: after.rounds[1].awaitDeadline }]);
      const waiting = (await (await fetch(`${base}/api/waiting`)).json()).waiting.filter(r => r.boardId === asked.boardId).map(r => r.round);
      assert.deepEqual(waiting, [2]);
      const { ended, left: gave } = readMission(key, home).session;
      assert.deepEqual([ended, gave], [undefined, undefined], 'the leaver is not the mission\'s ended session, and gives once');

      assert.equal((await send(asked.boardId, 2, 'No')).status, 200);
      const collect = async session => {
        const r = await post(`/api/board/${asked.boardId}/collect`, { round: 2, session });
        return [r.status, r.body.status, r.body.answers.map(x => x.choice)];
      };
      assert.deepEqual(await collect(leaver.ref), [200, 'abandoned', []], 'the leaver\'s watch reads as a takeover giver\'s');
      assert.deepEqual(await collect(next.ref), [200, 'submitted', ['No']]);
      assert.equal((await leave(key, `${key}-next`, next)).status, 200);
    });
  }

  await check('a hand-over that fails on one of the mission\'s boards keeps the leaver on the mission\'s record, in no join\'s answer: the join reopens the leaver\'s round on the board that reads, and that session\'s next join, the other board reading again, reopens the round there and names the leaver no longer', async () => {
    const leaver = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('left-failed', 'x\n');
    const older = createBoard({ title: 'Older', blocks: [question('Left on the older board?')], cwd: folder, mission: 'LEFT_FAILED', session: leaver.ref });
    const newer = createBoard({ title: 'Newer', blocks: [note('the newer board')], cwd: folder, mission: 'LEFT_FAILED' });
    for (const b of [older, newer]) {
      writeBoard(b, home);
      linkBoard('LEFT_FAILED', { id: b.id, url: `${base}/b/${b.id}` }, { home });
    }
    assert.equal((await join('LEFT_FAILED', 'left-failed-leaver', leaver)).status, 200);
    const asked = await ask(leaver, folder, [question('Left on the newer board?')]);
    assert.deepEqual([asked.boardId, asked.round], [newer.id, 2]);
    assert.equal((await leave('LEFT_FAILED', 'left-failed-leaver', leaver)).status, 200);
    // The older board's file no longer parses while the next session joins.
    const olderFile = path.join(home, 'boards', `${older.id}.json`);
    const stored = readFileSync(olderFile);
    writeFileSync(olderFile, '{"rounds": [');
    const first = await join('LEFT_FAILED', 'left-failed-next', next);
    writeFileSync(olderFile, stored);

    const named = r => (r.body.reopened || []).map(x => [x.board, x.round]);
    assert.deepEqual([first.status, named(first), first.body.session.left], [200, [[newer.id, 2]], undefined]);
    assert.deepEqual(readMission('LEFT_FAILED', home).session.left, { id: 'left-failed-leaver', ...leaver.ref });
    assert.deepEqual(readBoard(older.id, home).rounds.map(r => [r.status, r.session.pid, r.handedFrom]), [['open', leaver.ref.pid, undefined]]);

    const again = await join('LEFT_FAILED', 'left-failed-next', next);
    assert.deepEqual([again.status, named(again)], [200, [[older.id, 1], [newer.id, 2]]]);
    const [round] = readBoard(older.id, home).rounds;
    assert.deepEqual([round.status, round.awaited, wait(round), round.session.pid, round.handedFrom], ['open', true, WAIT_MS, next.ref.pid, 'left-failed-leaver']);
    assert.equal(readMission('LEFT_FAILED', home).session.left, undefined);
    assert.equal((await leave('LEFT_FAILED', 'left-failed-next', next)).status, 200);
  });

  for (const [i, cleared] of [false, true].entries()) {
    const how = cleared
      ? 'under a new id, after a /clear, is asked it again: reopened in place under that id, named in the join'
      : 'under the id it left with is given nothing: the round waits on as it was, named in no join, and is the next session\'s once the leaver has left again';
    await check(`the session that left its mission, joining it again while its round still waits, ${how}`, async () => {
      const key = `LEFT_BACK_${i}`;
      const leaver = sessionProcess();
      const next = sessionProcess();
      const folder = folderWith(key.toLowerCase(), 'x\n');
      assert.equal((await join(key, `${key}-leaver`, leaver)).status, 200);
      const asked = await ask(leaver, folder, [question('Still its own?')]);
      assert.equal((await leave(key, `${key}-leaver`, leaver)).status, 200);
      const before = readBoard(asked.boardId, home);

      const back = await join(key, cleared ? `${key}-cleared` : `${key}-leaver`, leaver);
      assert.equal(back.status, 200, JSON.stringify(back.body));
      if (cleared) {
        const [round] = readBoard(asked.boardId, home).rounds;
        assert.deepEqual([round.status, round.awaited, wait(round), round.session.id, round.session.pid, round.handedFrom], ['open', true, WAIT_MS, `${key}-cleared`, leaver.ref.pid, `${key}-leaver`]);
        assert.deepEqual(back.body.reopened.map(r => r.round), [1]);
        assert.equal((await leave(key, `${key}-cleared`, leaver)).status, 200);
        return;
      }
      assert.equal(back.body.reopened, undefined);
      assert.deepEqual(readBoard(asked.boardId, home), before);
      assert.equal((await leave(key, `${key}-leaver`, leaver)).status, 200);
      assert.deepEqual((await join(key, `${key}-next`, next)).body.reopened.map(r => r.round), [1]);
      assert.deepEqual(state(asked.boardId, 1), ['open', true, next.ref.pid]);
      assert.equal((await leave(key, `${key}-next`, next)).status, 200);
    });
  }

  await check('a session that left its mission under the id a /clear gave it while it was bound, joining again under that id, is asked again the round it asked under the id it was bound with, and keeps the round it asked since as it was: handed from no one, on the clock it had', async () => {
    const s = sessionProcess();
    const folder = folderWith('left-cleared', 'x\n');
    try {
      assert.equal((await watcherLists(s, folder, 'left-cleared-before')).status, 200);
      assert.equal((await join('LEFT_CLEARED', 'left-cleared-before', s)).status, 200);
      const asked = await ask(s, folder, [question('Before the /clear?')]);
      assert.equal((await watcherLists(s, folder, 'left-cleared-after')).status, 200);
      assert.equal((await ask(s, folder, [question('After it?')], { fresh: true })).round, 2);
      assert.equal((await leave('LEFT_CLEARED', 'left-cleared-after', s)).status, 200);
      const since = readBoard(asked.boardId, home).rounds[1];
      assert.equal(since.session.id, 'left-cleared-after');

      const back = await join('LEFT_CLEARED', 'left-cleared-after', s);
      assert.deepEqual([back.status, (back.body.reopened || []).map(r => r.round)], [200, [1]]);
      const rounds = readBoard(asked.boardId, home).rounds;
      assert.deepEqual([rounds[0].status, rounds[0].awaited, rounds[0].session.id, rounds[0].handedFrom], ['open', true, 'left-cleared-after', 'left-cleared-before']);
      assert.deepEqual(rounds[1], since);
      assert.equal((await leave('LEFT_CLEARED', 'left-cleared-after', s)).status, 200);
    } finally {
      await post('/api/sessions', { intervalMs: 30_000, sessions: [] });
    }
  });

  for (const [i, went] of ['left it too', 'went, its process gone'].entries()) {
    await check(`only the mission's last session gives its rounds: after one session left, and the next, bound by its heartbeat with no join, ${went}, the join after reopens the second one's round and leaves the first leaver's as it was`, async () => {
      const key = `LEFT_TWICE_${i}`;
      const first = sessionProcess();
      const second = sessionProcess();
      const third = sessionProcess();
      const folder = folderWith(key.toLowerCase(), 'x\n');
      assert.equal((await join(key, `${key}-first`, first)).status, 200);
      const asked = await ask(first, folder, [question('The first leaver\'s?')]);
      assert.equal((await leave(key, `${key}-first`, first)).status, 200);
      assert.equal((await bind(key, `${key}-second`, second)).status, 200);
      const own = await ask(second, folder, [question('The second one\'s?')]);
      assert.deepEqual([own.boardId, own.round], [asked.boardId, 2]);
      const firstRound = readBoard(asked.boardId, home).rounds[0];
      if (i === 0) assert.equal((await leave(key, `${key}-second`, second)).status, 200);
      else await kill(second);

      const joined = await join(key, `${key}-third`, third);
      assert.deepEqual([joined.status, (joined.body.reopened || []).map(r => r.round)], [200, [2]]);
      const rounds = readBoard(asked.boardId, home).rounds;
      assert.deepEqual(rounds[0], firstRound);
      assert.deepEqual([rounds[1].session.pid, rounds[1].handedFrom], [third.ref.pid, `${key}-second`]);
      assert.equal((await leave(key, `${key}-third`, third)).status, 200);
    });
  }

  for (const [i, taker] of ['the leaver itself, back to take the mission over', 'a third session'].entries()) {
    await check(`a takeover of a session bound by its heartbeat after another left: asking for it leaves the leaver on the mission's record, and the bound session's leave, binding ${taker}, drops it, handing over the bound session's round and leaving the leaver's as it was`, async () => {
      const key = `LEFT_TAKEN_${i}`;
      const first = sessionProcess();
      const second = sessionProcess();
      const third = i === 0 ? first : sessionProcess();
      const thirdId = i === 0 ? `${key}-first` : `${key}-third`;
      const folder = folderWith(key.toLowerCase(), 'x\n');
      assert.equal((await join(key, `${key}-first`, first)).status, 200);
      const asked = await ask(first, folder, [question('The leaver\'s?')]);
      assert.equal((await leave(key, `${key}-first`, first)).status, 200);
      assert.equal((await bind(key, `${key}-second`, second)).status, 200);
      assert.equal((await ask(second, folder, [question('The bound session\'s?')])).round, 2);
      const firstRound = readBoard(asked.boardId, home).rounds[0];

      assert.equal((await join(key, thirdId, third, { takeover: true })).status, 202);
      assert.deepEqual(readMission(key, home).session.left, { id: `${key}-first`, ...first.ref });
      const left = await leave(key, `${key}-second`, second);
      assert.deepEqual([left.status, left.body.session.id, left.body.session.left], [200, thirdId, undefined]);
      const { ended, left: kept } = readMission(key, home).session;
      assert.deepEqual([ended, kept], [{ id: `${key}-second`, ...second.ref }, undefined]);
      const rounds = readBoard(asked.boardId, home).rounds;
      assert.deepEqual(rounds[0], firstRound);
      assert.deepEqual([rounds[1].session.pid, rounds[1].handedFrom], [third.ref.pid, `${key}-second`]);
      assert.equal((await leave(key, thirdId, third)).status, 200);
    });
  }

  await check('a takeover reopens the giver\'s lapsed round under the taker, whose binding names it by board, round and deadline, as the mission record holds it, with no title or url; its next join names it with both while the round waits, and no longer once it is sent', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const folder = folderWith('taken-lapsed', 'x\n');
    assert.equal((await join('LAPSED', 'lapsed-giver', giver)).status, 200);
    const asked = await ask(giver, folder, [question('Lapsed before the takeover?')]);
    lapse(asked.boardId, 1);
    assert.equal((await join('LAPSED', 'lapsed-taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('LAPSED', 'lapsed-giver', giver)).status, 200);
    const round = readBoard(asked.boardId, home).rounds[0];
    assert.deepEqual([round.status, round.awaited, round.session.id, round.handedFrom], ['open', true, 'lapsed-taker', 'lapsed-giver']);
    assert.equal(wait(round), WAIT_MS);

    // The mission record, and the binding read off it, hold the round by number alone: no
    // title, which is the round's own text, and no url.
    const stored = [{ board: asked.boardId, round: 1, awaitDeadline: round.awaitDeadline }];
    assert.deepEqual(readMission('LAPSED', home).session.reopened, stored);
    const bound = await binding('lapsed-taker', taker);
    assert.deepEqual([bound.key, bound.reopened], ['LAPSED', stored]);
    const named = [{ ...stored[0], title: 'Round', url: `${base}/b/${asked.boardId}` }];
    assert.deepEqual((await join('LAPSED', 'lapsed-taker', taker)).body.reopened, named);
    assert.deepEqual(readMission('LAPSED', home).session.reopened, stored);
    assert.equal((await send(asked.boardId, 1, 'Yes')).status, 200);
    assert.equal((await join('LAPSED', 'lapsed-taker', taker)).body.reopened, undefined);
    assert.equal((await leave('LAPSED', 'lapsed-taker', taker)).status, 200);
  });

  await check('a join that reopens rounds tells a tab already open on the board of each one: a deadline event naming the round, its new deadline and that it reopened, which the tab re-reads the board on; and it tells the Boards page\'s stream of each one, a deadline event naming the board, the round and its new deadline, with one waiting count that holds them', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('open-tab', 'x\n');
    assert.equal((await join('OPENTAB', 'opentab-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Closed at its clear?')]);
    await ask(gone, folder, [question('Left to lapse?')], { fresh: true });
    lapse(asked.boardId, 2);
    await kill(gone);
    const waitingBefore = (await (await fetch(`${base}/api/waiting`)).json()).waiting;
    assert.deepEqual(waitingBefore.filter(r => r.boardId === asked.boardId), [], 'neither round waits before the join');
    const tab = await openSseClient(port, asked.boardId, { secret: SECRET, comments: false });
    const index = await openIndexStream();
    try {
      assert.equal((await join('OPENTAB', 'opentab-next', next)).status, 200);
      const told = () => tab.events.filter(e => e.event === 'deadline').map(e => e.data);
      await waitFor(() => told().length === 2, { what: 'a deadline event for each reopened round on the open tab' });
      const rounds = readBoard(asked.boardId, home).rounds;
      assert.deepEqual(told(), rounds.map(r => ({ round: r.n, awaitDeadline: r.awaitDeadline, reopened: true })));
      await waitFor(() => index.named('waiting').length > 0, { what: 'the waiting count on the Boards page\'s stream' });
      assert.deepEqual(index.named('deadline'), rounds.map(r => ({ board: asked.boardId, round: r.n, awaitDeadline: r.awaitDeadline })));
      assert.deepEqual(index.named('waiting').map(w => w.total), [waitingBefore.length + 2]);
    } finally {
      tab.req.destroy();
      index.close();
    }
    assert.equal((await leave('OPENTAB', 'opentab-next', next)).status, 200);
  });

  // A /clear gives the bound process a new id. Its shim's heartbeat (a `mission write` sends
  // one) may reach the mission before its join does, and takes the new id there.
  for (const [key, order, beatFirst] of [['CLEARED', 'its join comes first', false], ['CLEARED_BEAT', 'its heartbeat took the new id before its join', true]]) {
    await check(`the bound session joining again under a new id (after a /clear) has the round its earlier id left closed reopened, and not the round it asked since: ${order}`, async () => {
      const s = sessionProcess();
      const folder = folderWith(key.toLowerCase(), 'x\n');
      const listed = id => watcherLists(s, folder, id);
      try {
        assert.equal((await listed('cleared-before')).status, 200);
        assert.equal((await join(key, 'cleared-before', s)).status, 200);
        const asked = await ask(s, folder, [question('Before the /clear?')]);
        assert.equal((await listed('cleared-after')).status, 200);
        assert.equal((await ask(s, folder, [question('After it?')], { fresh: true })).round, 2);
        assert.deepEqual([1, 2].map(n => state(asked.boardId, n).slice(0, 2)), [['abandoned', false], ['open', true]]);
        if (beatFirst) {
          const beat = await post(`/api/mission/${key}/session`, { id: 'cleared-after', ...s.ref, beat: true });
          assert.deepEqual([beat.status, beat.body.session.id], [200, 'cleared-after']);
        }

        const joined = await join(key, 'cleared-after', s);
        assert.deepEqual([joined.status, (joined.body.reopened || []).map(r => r.round)], [200, [1]]);
        const rounds = readBoard(asked.boardId, home).rounds;
        assert.deepEqual(rounds.map(r => [r.status, r.awaited, r.session.id, r.handedFrom]), [['open', true, 'cleared-after', 'cleared-before'], ['open', true, 'cleared-after', undefined]]);
        assert.equal((await leave(key, 'cleared-after', s)).status, 200);
      } finally {
        await post('/api/sessions', { intervalMs: 30_000, sessions: [] });
      }
    });
  }

  await check('a round a hand-over gave another session answers only that session\'s collect: the departed session\'s, naming itself or no session, is answered as on a round abandoned and spends nothing, so the answer still reaches the session that holds the round, undelivered', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const folder = folderWith('departed', 'x\n');
    assert.equal((await join('DEPARTED', 'departed-giver', giver)).status, 200);
    const asked = await ask(giver, folder, [question('Whose answer?')]);
    assert.equal((await join('DEPARTED', 'departed-taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('DEPARTED', 'departed-giver', giver)).status, 200);
    assert.equal((await send(asked.boardId, 1, 'Yes')).status, 200);

    const collect = body => post(`/api/board/${asked.boardId}/collect`, { round: 1, ...body });
    const told = r => [r.status, r.body.status, r.body.delivered, r.body.answers.map(x => x.choice)];
    assert.deepEqual(told(await collect({ session: giver.ref })), [200, 'abandoned', false, []]);
    assert.deepEqual(told(await collect({})), [200, 'abandoned', false, []]);
    assert.deepEqual(readBoard(asked.boardId, home).answersDelivered, [], 'a refused collect spends nothing');
    assert.deepEqual(told(await collect({ session: taker.ref })), [200, 'submitted', false, ['Yes']]);
    assert.equal((await leave('DEPARTED', 'departed-taker', taker)).status, 200);
  });

  // The answer watch as a session runs it, polling every 100 ms.
  const watchBin = path.join(repoRoot, 'bin', 'watch.mjs');
  const env = { ...process.env, CLAUDE_BOARD_HOME: home, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_WATCH_INTERVAL_MS: '100' };
  /** A watch `child` to its exit: `{ code, out }`, its exit code and what it printed. */
  const run = (child, limitMs = 10_000) => new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', c => { out += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the watch was still running')); }, limitMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });

  await check('the answer watch names the processes it runs under: started by the session a reopened round was handed to, it prints the round\'s answer, and started by any other, abandoned', async () => {
    const gone = sessionProcess();
    const folder = folderWith('watched', 'x\n');
    // The session that takes the round: a shell that starts the watch on the board it reads
    // from its stdin, as a session starts one in the background.
    const shell = spawn('/bin/sh', ['-c', `read board; "${process.execPath}" "${watchBin}" --board "$board" --round 1; exit $?`], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(shell);
    const taker = { ref: { pid: shell.pid, procStart: processStartUtc(shell.pid) } };
    assert.ok(taker.ref.procStart, 'the shell\'s start reads');

    assert.equal((await join('WATCHED', 'watched-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Sent after the hand-over?')]);
    await kill(gone);
    assert.deepEqual((await join('WATCHED', 'watched-taker', taker)).body.reopened.map(r => r.round), [1]);
    assert.equal((await send(asked.boardId, 1, 'No')).status, 200);

    const stray = spawn(process.execPath, [watchBin, '--board', asked.boardId, '--round', '1'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    children.add(stray);
    assert.deepEqual(await run(stray), { code: 2, out: 'abandoned' });
    const watched = run(shell);
    shell.stdin.end(`${asked.boardId}\n`);
    const { code, out } = await watched;
    assert.equal(code, 0, out);
    const packet = JSON.parse(out);
    assert.deepEqual([packet.round, packet.status, packet.delivered, packet.answers.map(x => x.choice)], [1, 'submitted', false, ['No']]);
    assert.equal((await leave('WATCHED', 'watched-taker', taker)).status, 200);
  });

  await check('an answer watch a session started before its /clear is refused the round its join after the /clear reopened: it prints abandoned and spends nothing, and the watch the session starts after that join prints the answer; a start that is no time is refused', async () => {
    const folder = folderWith('cleared-watch', 'x\n');
    // The session: a shell that starts a watch on the board it reads from its stdin, says how
    // that one ended, and starts another once it is told to go on.
    const watch = `"${process.execPath}" "${watchBin}" --board "$board" --round 1`;
    const shell = spawn('/bin/sh', ['-c', `read board; ${watch}; echo "exit $?"; read go; ${watch}; exit $?`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(shell);
    let err = '';
    shell.stderr.on('data', c => { err += c; });
    const ended = run(shell);
    ended.catch(() => {}); // a failing assertion below is the report
    let out = '';
    shell.stdout.on('data', c => { out += c; });
    const s = { ref: { pid: shell.pid, procStart: processStartUtc(shell.pid) } };
    assert.ok(s.ref.procStart, 'the shell\'s start reads');
    const listed = id => post('/api/sessions', { intervalMs: 30_000, sessions: id ? [{ id, pid: s.ref.pid, procStart: s.ref.procStart, kind: 'interactive', jobId: null, cwd: folder, login: null, name: null, status: 'idle', reason: null }] : [] });
    try {
      assert.equal((await listed('watch-before')).status, 200);
      assert.equal((await join('CLEARED_WATCH', 'watch-before', s)).status, 200);
      const asked = await ask(s, folder, [question('Sent after the /clear?')]);
      shell.stdin.write(`${asked.boardId}\n`);
      // The first watch says the bound it runs to, a day from its start; the join comes later.
      await waitFor(() => /until \S+\n/.test(err), { what: 'the first watch to start' });
      const started = Date.parse(/until (\S+)/.exec(err)[1]) - WAIT_CEILING_MS;
      await waitFor(() => Date.now() > started, { intervalMs: 1, what: 'the clock to pass the watch\'s start' });

      assert.equal((await listed('watch-after')).status, 200);
      assert.deepEqual((await join('CLEARED_WATCH', 'watch-after', s)).body.reopened.map(r => r.round), [1]);
      assert.deepEqual(state(asked.boardId, 1), ['open', true, s.ref.pid], 'the round was open through the /clear, and is the same process\'s');
      assert.equal((await send(asked.boardId, 1, 'Yes')).status, 200);
      await waitFor(() => /exit \d+\n/.test(out), { what: 'the first watch to end' });
      assert.equal(out, 'abandoned\nexit 2\n');
      assert.deepEqual(readBoard(asked.boardId, home).answersDelivered, [], 'a refused collect spends nothing');
      const unread = await post(`/api/board/${asked.boardId}/collect`, { round: 1, session: s.ref, startedAt: 'before the /clear' });
      assert.deepEqual([unread.status, unread.body], [400, { error: 'collect "startedAt" must be the time the caller\'s watch started, as an ISO string' }]);

      shell.stdin.end('go\n');
      const { code, out: all } = await ended;
      assert.equal(code, 0, all);
      const packet = JSON.parse(all.split('\n').pop());
      assert.deepEqual([packet.round, packet.status, packet.delivered, packet.answers.map(x => x.choice)], [1, 'submitted', false, ['Yes']]);
      assert.equal((await leave('CLEARED_WATCH', 'watch-after', s)).status, 200);
    } finally {
      await listed(null);
    }
  });

  await check('close by number closes only a round a hand-over reopened under the session that names it: for a round that session asked itself, and for a round reopened under another session, it answers closed: [] and the round stays open; naming a round and no session is refused', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const stranger = sessionProcess();
    const folder = folderWith('close-by-number', 'x\n');
    assert.equal((await join('BY_NUMBER', 'by-number-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Reopened?')]);
    await kill(gone);
    assert.deepEqual((await join('BY_NUMBER', 'by-number-next', next)).body.reopened.map(r => r.round), [1]);
    assert.equal((await ask(next, folder, [question('Its own, never reopened')])).round, 2);

    const close = body => post(`/api/board/${asked.boardId}/abandon`, body);
    const open = () => [1, 2].map(n => state(asked.boardId, n).slice(0, 2));
    const own = await close({ session: next.ref, round: 2 });
    assert.deepEqual([own.status, own.body.closed], [200, []]);
    const others = await close({ session: stranger.ref, round: 1 });
    assert.deepEqual([others.status, others.body.closed], [200, []]);
    const unnamed = await close({ round: 1 });
    assert.deepEqual([unnamed.status, unnamed.body], [400, { error: 'round needs the session that closes it' }]);
    assert.deepEqual(open(), [['open', true], ['open', true]]);
    assert.equal(readBoard(asked.boardId, home).rounds[1].declined, undefined);
    assert.equal((await leave('BY_NUMBER', 'by-number-next', next)).status, 200);
  });

  await check('a session whose next ask lands on a newer board of its mission closes its own rounds on the board it posted on before, and leaves a round a hand-over reopened under it there waiting, as its scoped abandon of that board does', async () => {
    const gone = sessionProcess();
    const next = sessionProcess();
    const folder = folderWith('newer-board', 'x\n');
    assert.equal((await join('NEWER', 'newer-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Reopened on the older board?')]);
    await kill(gone);
    assert.deepEqual((await join('NEWER', 'newer-next', next)).body.reopened.map(r => r.round), [1]);
    assert.equal((await ask(next, folder, [question('Its own, on the older board')])).round, 2);
    // A newer board the mission links since, as a post naming the mission makes one.
    const newer = createBoard({ title: 'Newer', blocks: [note('the newer board')], cwd: folder, mission: 'NEWER' });
    writeBoard(newer, home);
    linkBoard('NEWER', { id: newer.id, url: `${base}/b/${newer.id}` }, { home });

    const moved = await ask(next, folder, [question('On the newer board')], { boardId: asked.boardId });
    assert.deepEqual([moved.boardId, moved.moved], [newer.id, true]);
    const older = () => [1, 2].map(n => state(asked.boardId, n).slice(0, 2));
    assert.deepEqual(older(), [['open', true], ['abandoned', false]]);
    const closed = await post(`/api/board/${asked.boardId}/abandon`, { session: next.ref });
    assert.deepEqual([closed.status, closed.body.closed], [200, []]);
    assert.deepEqual(older(), [['open', true], ['abandoned', false]]);
    assert.equal((await leave('NEWER', 'newer-next', next)).status, 200);
  });

  const watchOf = (boardId, n) => new RegExp(`^CLAUDE_BOARD_PORT=${port} node \\S*watch\\.mjs\\S* --board ${boardId} --round ${n}$`);

  await check('the shim\'s join names each reopened round with its answer watch, and its close closes the one named of two, marked declined, and leaves the other waiting', async () => {
    const gone = sessionProcess();
    const folder = folderWith('shim-reopen', 'x\n');
    assert.equal((await join('SHIM_REOPEN', 'shim-reopen-gone', gone)).status, 200);
    const asked = await ask(gone, folder, [question('Left at its clear, for the shim\'s session?')]);
    assert.equal((await ask(gone, folder, [question('Left when it went?')], { fresh: true })).round, 2);
    await kill(gone);
    const { shim, call } = await sessionShim(folder);
    try {
      const joined = (await call('mission', { action: 'join', key: 'SHIM_REOPEN', session: 'shim-reopen-next' })).structuredContent;
      assert.deepEqual(joined.reopened.map(r => [r.board, r.round]), [[asked.boardId, 1], [asked.boardId, 2]]);
      for (const r of joined.reopened) assert.match(r.watch, watchOf(asked.boardId, r.round));
      const closed = (await call('mission', { action: 'close', board: asked.boardId, round: 2 })).structuredContent;
      assert.deepEqual(closed.closed, [2]);
      assert.deepEqual(readBoard(asked.boardId, home).rounds.map(r => [r.n, r.status, r.declined]), [[1, 'open', undefined], [2, 'abandoned', true]]);
      await call('mission', { action: 'leave', key: 'SHIM_REOPEN', session: 'shim-reopen-next' });
    } finally {
      shim.close();
    }
  });

  await check('a taker reads the round its takeover reopened from the shim\'s binding: with its answer watch, and the board\'s url, which the daemon\'s binding does not carry', async () => {
    const giver = sessionProcess();
    const folder = folderWith('shim-takeover', 'x\n');
    assert.equal((await join('SHIM_TAKEN', 'shim-taken-giver', giver)).status, 200);
    const asked = await ask(giver, folder, [question('Lapsed before the shim took over?')]);
    lapse(asked.boardId, 1);
    const { shim, call } = await sessionShim(folder);
    try {
      const pending = (await call('mission', { action: 'join', key: 'SHIM_TAKEN', session: 'shim-taken-taker', takeover: true })).structuredContent;
      assert.equal(pending.takeover, 'pending');
      assert.equal((await leave('SHIM_TAKEN', 'shim-taken-giver', giver)).status, 200);
      const binding = (await call('mission', { action: 'binding', session: 'shim-taken-taker' })).structuredContent;
      assert.deepEqual([binding.key, binding.reopened.map(r => [r.board, r.round])], ['SHIM_TAKEN', [[asked.boardId, 1]]]);
      assert.match(binding.reopened[0].watch, watchOf(asked.boardId, 1));
      assert.equal(binding.reopened[0].url, `${base}/b/${asked.boardId}`);
      await call('mission', { action: 'leave', key: 'SHIM_TAKEN', session: 'shim-taken-taker' });
    } finally {
      shim.close();
    }
  });

  await check('the shim builds each reopened round\'s url itself and relays none a join answered: this shim\'s own for the entry\'s board, null when that is no board id, and the answer watch only on an entry naming a board and a round', async () => {
    const folder = folderWith('shim-peer', 'x\n');
    const theirs = '/Applications/Evil.app';
    const named = { board: 'b_peer_round', round: 1, title: 'Round', awaitDeadline: '2026-11-15T10:40:00.000Z' };
    const peer = await startPeer('/api/mission/PEER/join', { bound: true, session: { id: 'peer-session' }, reopened: [
      { ...named, url: theirs },
      { board: `-a ${theirs}`, round: 2, url: theirs },
      { board: 'b_peer_round', round: 'two', url: theirs },
    ] });
    const { shim, call } = await sessionShim(folder, { CLAUDE_BOARD_PORT: String(peer.port) });
    try {
      const joined = (await call('mission', { action: 'join', key: 'PEER', session: 'peer-session' })).structuredContent;
      const own = `http://127.0.0.1:${peer.port}/b/b_peer_round`;
      const { watch, ...first } = joined.reopened[0];
      assert.match(watch, new RegExp(`^CLAUDE_BOARD_PORT=${peer.port} node \\S*watch\\.mjs\\S* --board b_peer_round --round 1$`));
      assert.deepEqual([first, ...joined.reopened.slice(1)], [
        { ...named, url: own },
        { board: `-a ${theirs}`, round: 2, url: null },
        { board: 'b_peer_round', round: 'two', url: own },
      ]);
    } finally {
      shim.close();
      peer.close();
    }
  });

  await check('a shim that cannot read its parent process\'s start, so names no session, refuses mission close, and the round stays open', async () => {
    const s = sessionProcess();
    const folder = folderWith('shim-no-session', 'x\n');
    const asked = await ask(s, folder, [question('Closed by a shim naming no session?')]);
    // A `ps` that answers nothing, first on the shim's PATH.
    const bin = path.join(home, 'no-ps');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { shim } = await sessionShim(folder, { PATH: `${bin}:${process.env.PATH}` });
    try {
      const r = await shim.request('tools/call', { name: 'mission', arguments: { action: 'close', board: asked.boardId, round: 1 } });
      assert.equal(r.result.isError, true, JSON.stringify(r));
      assert.equal(r.result.content[0].text, 'mission close cannot name this session: its process\'s start did not read. Nothing was closed.');
      assert.equal(readBoard(asked.boardId, home).rounds[0].status, 'open');
    } finally {
      shim.close();
    }
  });

  await check('a session moving onto its mission\'s board is told whether to open a tab as things stand now: suppressed while any board has a watcher, not as the board was decided when it was made', async () => {
    const first = sessionProcess();
    const folder = folderWith('suppressed', 'x\n');
    assert.equal((await join('SUPPRESSED', 'suppressed-first', first)).status, 200);
    const missionBoard = await ask(first, folder, [note('made with no watcher')]);
    assert.equal(missionBoard.suppressed, false);
    assert.equal((await leave('SUPPRESSED', 'suppressed-first', first)).status, 200);

    const mover = sessionProcess();
    const own = await ask(mover, folder, [note('its own board')]);
    assert.equal((await join('SUPPRESSED', 'suppressed-mover', mover)).status, 200);
    const tab = await openSseClient(port, own.boardId, { secret: SECRET, comments: false });
    try {
      const moved = await ask(mover, folder, [note('moving')], { boardId: own.boardId });
      assert.deepEqual([moved.boardId, moved.moved, moved.suppressed], [missionBoard.boardId, true, true]);
    } finally {
      tab.req.destroy();
    }
    assert.equal((await leave('SUPPRESSED', 'suppressed-mover', mover)).status, 200);
  });

  await check('a mission linking several boards posts on its latest one still stored: the newest, and once that is pruned the one before it', async () => {
    const s = sessionProcess();
    const folder = folderWith('several', 'x\n');
    const older = createBoard({ title: 'Older', blocks: [note('older')], cwd: folder, mission: 'SEVERAL' });
    const newer = createBoard({ title: 'Newer', blocks: [note('newer')], cwd: folder, mission: 'SEVERAL' });
    for (const b of [older, newer]) {
      writeBoard(b, home);
      linkBoard('SEVERAL', { id: b.id, url: `${base}/b/${b.id}` }, { home });
    }
    assert.equal((await join('SEVERAL', 'several', s)).status, 200);
    assert.deepEqual((await ask(s, folder, [question('Which board?')])).boardId, newer.id);
    rmSync(path.join(home, 'boards', `${newer.id}.json`));
    assert.deepEqual((await ask(s, folder, [question('And now?')])).boardId, older.id);
    assert.equal((await leave('SEVERAL', 'several', s)).status, 200);
  });

  await check('a round posts within one second on a mission board the size of the largest real mission\'s boards merged (34 rounds, 418 blocks, 4.4 MB)', async () => {
    const s = sessionProcess();
    const folder = folderWith('large', 'x\n');
    // One block normalised for real, copied per id: 418 blocks of about 10.5 KB over 34 rounds.
    const text = `${'A paragraph of a long round, '.repeat(360)}\n`;
    const board = createBoard({ title: 'Large', blocks: [note(text)], cwd: folder, mission: 'LARGE' });
    const [block] = board.blocks;
    board.rounds = Array.from({ length: 34 }, (_, i) => ({ n: i + 1, postedAt: board.createdAt, status: 'sent', sentAt: board.createdAt, title: `Round ${i + 1}`, awaited: false, awaitDeadline: null }));
    board.blocks = Array.from({ length: 418 }, (_, i) => ({ ...block, id: `d${i + 1}`, round: 1 + (i % 34) }));
    writeBoard(board, home);
    linkBoard('LARGE', { id: board.id, url: `${base}/b/${board.id}` }, { home });
    assert.ok(statSync(path.join(home, 'boards', `${board.id}.json`)).size > 4_300_000);
    assert.equal((await join('LARGE', 'large', s)).status, 200);
    // The fastest of three posts, each a round of its own, so one stall on a loaded machine is
    // not read as a slow board. Measured about 150 ms on the PM's Mac.
    const times = [];
    for (const n of [35, 36, 37]) {
      const started = performance.now();
      const posted = await ask(s, folder, [note(`round ${n}`), question(`Still quick at ${n}?`)], { fresh: true });
      times.push(Math.round(performance.now() - started));
      assert.deepEqual([posted.boardId, posted.round], [board.id, n]);
    }
    console.log(`  posting on the large mission board took ${times.join(', ')} ms`);
    assert.ok(Math.min(...times) < 1000, `the posts took ${times.join(', ')} ms`);
    assert.equal((await leave('LARGE', 'large', s)).status, 200);
  });

  await check('the shim follows its session onto the mission\'s board: a join lands its next ask there, fresh closes only its own rounds, and after a leave its next ask makes a board of its own and closes its rounds on the mission\'s', async () => {
    const other = sessionProcess();
    const folder = folderWith('shim', 'x\n');
    assert.equal((await join('SHIM', 'other', other)).status, 200);
    const missionBoard = await ask(other, folder, [note('the other session\'s round')]);
    assert.equal((await leave('SHIM', 'other', other)).status, 200);
    // A session between, bound and gone again: the shim's join is handed that one's rounds,
    // and the other session's stays its own.
    const between = sessionProcess();
    assert.equal((await bind('SHIM', 'between', between)).status, 200);
    assert.equal((await leave('SHIM', 'between', between)).status, 200);

    const { child, shim, call } = await sessionShim(folder);
    try {
      const askShim = (blocks, extra = {}) => call('ask', { title: 'Shim round', blocks, ...extra });

      await askShim([note('before the join')]);
      await call('mission', { action: 'join', key: 'SHIM', session: 'shim-session' });
      await askShim([note('after the join')]);
      const fresh = await askShim([note('after a /clear')], { fresh: true });
      assert.doesNotMatch(fresh.content[0].text, /Abandoned board/, 'a fresh ask landing back on the mission\'s board names no board abandoned');
      let rounds = readBoard(missionBoard.boardId, home).rounds;
      assert.deepEqual(rounds.map(r => [r.status, r.session.pid]), [['open', other.ref.pid], ['abandoned', child.pid], ['open', child.pid]]);

      await call('mission', { action: 'leave', key: 'SHIM', session: 'shim-session' });
      await askShim([note('after the leave')]);
      rounds = readBoard(missionBoard.boardId, home).rounds;
      assert.deepEqual(rounds.map(r => r.status), ['open', 'abandoned', 'abandoned'], 'the leave closes the shim\'s rounds and no other');
      assert.equal(readMission('SHIM', home).boards.length, 1);
    } finally {
      shim.close();
    }
  });

  await check('a shim that took its mission\'s board\'s thread, once that board is pruned and the mission released, makes a board of its own rather than one in that thread, which reads from another session\'s folder', async () => {
    const first = sessionProcess();
    const firstFolder = folderWith('pruned-first', 'x\n');
    const shimFolder = folderWith('pruned-shim', 'x\n');
    assert.equal((await join('PRUNED', 'pruned-first', first)).status, 200);
    const missionBoard = await ask(first, firstFolder, [note('the mission\'s first round')]);
    assert.equal((await leave('PRUNED', 'pruned-first', first)).status, 200);
    const { shim, call } = await sessionShim(shimFolder);
    try {
      await call('ask', { title: 'Own', blocks: [note('before the join')] });
      await call('mission', { action: 'join', key: 'PRUNED', session: 'pruned-shim' });
      assert.equal((await call('ask', { title: 'Moved', blocks: [note('on the mission\'s board')] })).structuredContent.board, missionBoard.boardId);
      const thread = readBoard(missionBoard.boardId, home).thread;
      assert.equal((await post('/api/mission/PRUNED', { state: 'released' })).status, 200);
      // The first session's own board in that thread, made after the prune.
      const kept = await post('/api/board', { title: 'Kept', blocks: [note('kept')], cwd: firstFolder, thread, noWait: true });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      rmSync(path.join(home, 'boards', `${missionBoard.boardId}.json`));

      const own = (await call('ask', { title: 'After the prune', blocks: [note('a board of its own')] })).structuredContent.board;
      const board = readBoard(own, home);
      assert.notEqual(board.thread, thread);
      assert.equal(board.cwd, shimFolder);
    } finally {
      shim.close();
    }
  });
}

await runMain('mission board', main, {
  cleanup: async () => {
    for (const c of children) c.kill('SIGKILL');
    if (server) await new Promise(resolve => server.close(resolve));
  },
});
