// One board per mission (ADR 150): a daemon on a temp store, sessions named by real live
// processes, posting the way the shim does. Every session bound to a mission posts on the
// mission's one board, each round its own: its own folder, its own boundaries, and on a
// takeover the giver's open round handed to the taker. The last check drives the real shim.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { readBoard, readMission, writeBoard } from '../src/store.mjs';
import { linkBoard } from '../src/missions.mjs';
import { createBoard } from '../src/board.mjs';
import { processStartUtc } from '../src/proc-start.mjs';
import { McpClient, check, mcpBin, rawRequest, runMain, secretFetch, secretHome, writeHeaders } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-mission-board-');
const fetch = secretFetch(SECRET);
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);
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
const question = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
const note = text => ({ kind: 'markdown', text });

/** A folder holding `notes.txt` with `text`, the file a round names by path. */
function folderWith(name, text) {
  const dir = path.join(home, 'work', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'notes.txt'), text);
  return realpathSync(dir);
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

    assert.equal((await join('SHARED', 'sess-b', b, { phase: 'direct' })).status, 200);
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

  await check('a session that posted on a board of its own before it joined moves to the mission\'s board for its next round, and closes only its own round left on the board it moved from', async () => {
    const a = sessionProcess();
    const b = sessionProcess();
    const folder = folderWith('mover', 'x\n');
    assert.equal((await join('MOVE_TO', 'mover-a', a)).status, 200);
    const missionBoard = await ask(a, folder, [question('First?')]);
    assert.equal((await leave('MOVE_TO', 'mover-a', a)).status, 200);
    const own = await ask(b, folder, [note('before the join')]);
    assert.notEqual(own.boardId, missionBoard.boardId);
    assert.equal(readBoard(own.boardId, home).mission ?? null, null, 'an unbound session\'s board is its own');

    assert.equal((await join('MOVE_TO', 'mover-b', b)).status, 200);
    const next = await ask(b, folder, [question('After the join?')], { boardId: own.boardId });
    assert.deepEqual([next.boardId, next.round, next.moved], [missionBoard.boardId, 2, true]);
    assert.deepEqual(readBoard(own.boardId, home).rounds.map(r => r.status), ['abandoned']);
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

  await check('on a shared board a fresh post and a scoped abandon close only the rounds of the session that sent them', async () => {
    const a = sessionProcess();
    const b = sessionProcess();
    const folder = folderWith('scoped', 'x\n');
    assert.equal((await join('SCOPED', 'scoped-a', a)).status, 200);
    const first = await ask(a, folder, [question('A asks')]);
    assert.equal((await leave('SCOPED', 'scoped-a', a)).status, 200);
    assert.equal((await join('SCOPED', 'scoped-b', b)).status, 200);
    await ask(b, folder, [question('B asks')]);
    const fresh = await ask(b, folder, [question('B asks again, after a /clear')], { fresh: true });
    assert.deepEqual([fresh.boardId, fresh.round], [first.boardId, 3]);
    assert.deepEqual(readBoard(first.boardId, home).rounds.map(r => r.status), ['open', 'abandoned', 'open']);

    const closed = await post(`/api/board/${first.boardId}/abandon`, { session: b.ref });
    assert.deepEqual([closed.status, closed.body.closed], [200, [3]]);
    assert.deepEqual(readBoard(first.boardId, home).rounds.map(r => r.status), ['open', 'abandoned', 'abandoned']);
    assert.equal((await leave('SCOPED', 'scoped-b', b)).status, 200);
  });

  await check('a takeover hands the giver\'s open round to the taker, so the answer the PM sends on it rides the taker\'s next packet', async () => {
    const giver = sessionProcess();
    const taker = sessionProcess();
    const folder = folderWith('takeover', 'x\n');
    assert.equal((await join('TAKEN', 'giver', giver)).status, 200);
    const asked = await ask(giver, folder, [question('Which way?')]);
    assert.equal((await join('TAKEN', 'taker', taker, { takeover: true })).status, 202);
    assert.equal((await leave('TAKEN', 'giver', giver)).status, 200);
    const round = readBoard(asked.boardId, home).rounds[0];
    assert.deepEqual([round.session.id, round.session.pid, round.handedFrom], ['taker', taker.ref.pid, 'giver']);

    const qid = readBoard(asked.boardId, home).blocks.find(x => x.kind === 'question').id;
    const sent = await post(`/api/board/${asked.boardId}/submit`, { round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: '' }], comments: [] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const next = await ask(taker, folder, [note('picking up')]);
    assert.equal(next.boardId, asked.boardId);
    assert.deepEqual(next.answers.map(x => [x.id, x.choice]), [[qid, 'Yes']]);
    assert.equal((await leave('TAKEN', 'taker', taker)).status, 200);
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
    const started = performance.now();
    const posted = await ask(s, folder, [note('one more round'), question('Still quick?')]);
    const ms = performance.now() - started;
    assert.deepEqual([posted.boardId, posted.round], [board.id, 35]);
    assert.ok(ms < 1000, `the post took ${Math.round(ms)} ms`);
    assert.equal((await leave('LARGE', 'large', s)).status, 200);
  });

  await check('the shim follows its session onto the mission\'s board: a join lands its next ask there, fresh closes only its own rounds, and after a leave its next ask makes a board of its own and closes its rounds on the mission\'s', async () => {
    const other = sessionProcess();
    const folder = folderWith('shim', 'x\n');
    assert.equal((await join('SHIM', 'other', other)).status, 200);
    const missionBoard = await ask(other, folder, [note('the other session\'s round')]);
    assert.equal((await leave('SHIM', 'other', other)).status, 200);

    // Under its own shell, so the shim's parent process, the session it names, is not this one.
    const child = spawn('/bin/sh', ['-c', `"${process.execPath}" "${mcpBin}"; exit $?`], {
      cwd: folder,
      env: { ...process.env, CLAUDE_BOARD_HOME: home, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_NO_OPEN: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    const shim = new McpClient(child);
    try {
      await shim.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-mission-board', version: '0' } });
      shim.notify('notifications/initialized', {});
      const call = async (name, args) => {
        const r = await shim.request('tools/call', { name, arguments: args });
        assert.equal(r.result && r.result.isError, false, JSON.stringify(r));
        return r.result.structuredContent;
      };
      assert.ok(processStartUtc(child.pid), 'the shell\'s start reads');
      const askShim = async (blocks, extra = {}) => (await call('ask', { title: 'Shim round', blocks, ...extra })).boardId ?? null;

      await askShim([note('before the join')]);
      await call('mission', { action: 'join', key: 'SHIM', session: 'shim-session' });
      await askShim([note('after the join')]);
      await askShim([note('after a /clear')], { fresh: true });
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
}

await runMain('mission board', main, {
  cleanup: async () => {
    for (const c of children) c.kill('SIGKILL');
    if (server) await new Promise(resolve => server.close(resolve));
  },
});
