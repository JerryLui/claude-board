// The answer watch (ADR 146): bin/watch.mjs run as a process against a daemon started
// in-process on an ephemeral port, the way a Claude Code session runs the command a
// `timeout` packet names. Covers its exits and its output, and the collect route under it:
// a round the watch collected is spent, so the thread's next packet carries none of it, and
// a round the next packet carried first comes back `delivered: true`. No browser, no network
// beyond loopback; everything is written under a temp CLAUDE_BOARD_HOME.

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.mjs';
import { ANSWERS_DELIVERED } from '../src/board.mjs';
import { readBoard } from '../src/store.mjs';
import { WAIT_CEILING_MS } from '../src/handoff.mjs';
import {
  check, freePort, rawRequest, repoRoot, runMain, secretFetch, secretHome, sessionCookieHeader, sleep, writeHeaders,
} from './support.mjs';

const watchBin = path.join(repoRoot, 'bin', 'watch.mjs');
const { home, secret: SECRET } = secretHome('claude-board-watch-', { secret: 'c'.repeat(64) });
const fetch = secretFetch(SECRET);
// This file posts awaited rounds nobody looks at, which is what the stranded rule announces.
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);

const INTERVAL_MS = 100;
let server, port, base;

/** Start bin/watch.mjs with `args`. `exited` is whether it has ended yet; `done` resolves
 * `{ code, stdout, stderr, elapsed }`, or kills it and rejects past `limitMs`. */
function startWatch(args, { env = {}, limitMs = 10_000 } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [watchBin, ...args], {
    env: { ...process.env, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_WATCH_INTERVAL_MS: String(INTERVAL_MS), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const run = { exited: false };
  run.done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the watch was still running after ${limitMs}ms:\n${stderr}`));
    }, limitMs);
    child.on('close', code => {
      clearTimeout(timer);
      run.exited = true;
      resolve({ code, stdout, stderr, elapsed: Date.now() - started });
    });
  });
  return run;
}

/** `askRound` posts a round of one question; `into` names a board to add it to. */
async function askRound(prompt, into = {}) {
  const posted = await (await fetch(`${base}/api/board`, {
    method: 'POST',
    headers: writeHeaders(SECRET),
    body: JSON.stringify({
      title: prompt,
      ...into,
      blocks: [{ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }),
  })).json();
  const qid = readBoard(posted.boardId, home).blocks.find(b => b.kind === 'question' && b.round === posted.round).id;
  return { ...posted, qid };
}

/** `lapse` lets the round's wait die on a 250 ms cap and hands back its `timeout` packet,
 * the packet a session holds when it starts the watch. */
async function lapse(boardId, round = 1) {
  const previous = process.env.CLAUDE_BOARD_TIMEOUT_MS;
  process.env.CLAUDE_BOARD_TIMEOUT_MS = '250';
  try {
    return await (await fetch(`${base}/api/board/${boardId}/wait?round=${round}`)).json();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BOARD_TIMEOUT_MS;
    else process.env.CLAUDE_BOARD_TIMEOUT_MS = previous;
  }
}

/** `answer` sends one round as the page's Send does, with a comment on its question when
 * `comment` is given. */
async function answer(boardId, round, qid, choice, note, comment) {
  const res = await fetch(`${base}/api/board/${boardId}/submit`, {
    method: 'POST',
    headers: writeHeaders(SECRET),
    body: JSON.stringify({
      round,
      action: 'send',
      answers: [{ id: qid, status: 'answered', choice, note }],
      comments: comment ? [{ blockId: qid, anchor: { kind: 'block' }, text: comment }] : [],
    }),
  });
  assert.equal(res.status, 200, `setup: round ${round} must take the Send`);
}

/** `askAndAnswer` holds a wait on the round, answers it, and hands back that wait's packet. */
async function askAndAnswer(boardId, round, qid, choice) {
  const waiting = fetch(`${base}/api/board/${boardId}/wait?round=${round}`).then(r => r.json());
  await sleep(150);
  await answer(boardId, round, qid, choice, '');
  return waiting;
}

const watchArgs = (boardId, round) => ['--board', boardId, '--round', String(round)];

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  await check('a late Send ends the watch with 0, printing that round\'s answers and comments, and spends them: the next round\'s packet carries none of them', async () => {
    const r1 = await askRound('WATCHED_Q1');
    assert.equal((await lapse(r1.boardId)).status, 'timeout', 'setup: round 1\'s wait must end unanswered');

    const watch = startWatch(watchArgs(r1.boardId, 1));
    await sleep(INTERVAL_MS * 4);
    assert.equal(watch.exited, false, 'the watch keeps polling while the round is open');
    await answer(r1.boardId, 1, r1.qid, 'No', 'sent an hour late', 'LATE_COMMENT');
    const { code, stdout } = await watch.done;

    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.board, r1.boardId);
    assert.equal(out.round, 1);
    assert.equal(out.status, 'submitted');
    assert.equal(out.delivered, false, 'no packet had carried the round');
    assert.deepEqual(out.answers.map(a => [a.round, a.id, a.prompt, a.status, a.choice, a.note]),
      [[1, r1.qid, 'WATCHED_Q1', 'answered', 'No', 'sent an hour late']]);
    assert.deepEqual(out.comments.map(c => [c.round, c.blockId, c.text]), [[1, r1.qid, 'LATE_COMMENT']]);

    const r2 = await askRound('WATCHED_Q2', { boardId: r1.boardId });
    assert.equal(r2.round, 2, 'setup: the next round is round 2 of the same board');
    const packet2 = await askAndAnswer(r1.boardId, 2, r2.qid, 'Yes');
    assert.deepEqual(packet2.answers.map(a => a.round), [2], 'round 2\'s packet carries none of round 1\'s answers');
    assert.deepEqual(packet2.comments.map(c => c.text), [], 'nor round 1\'s comment');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [1, 2]);
  });

  await check('with the next round\'s packet first, the watch reports delivered: true, still naming the round\'s answers', async () => {
    const r1 = await askRound('CARRIED_FIRST_Q1');
    assert.equal((await lapse(r1.boardId)).status, 'timeout');
    await answer(r1.boardId, 1, r1.qid, 'Yes', 'late, before round 2');
    const r2 = await askRound('CARRIED_FIRST_Q2', { boardId: r1.boardId });
    const packet2 = await askAndAnswer(r1.boardId, 2, r2.qid, 'No');
    assert.deepEqual(packet2.answers.map(a => a.round), [2, 1], 'setup: round 2\'s packet carried round 1\'s late answer');

    const { code, stdout } = await startWatch(watchArgs(r1.boardId, 1)).done;
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.delivered, true);
    assert.deepEqual(out.answers.map(a => [a.round, a.choice, a.note]), [[1, 'Yes', 'late, before round 2']]);
  });

  await check('an abandoned round, a board that is gone and a round not on its board end the watch with 2', async () => {
    const abandoned = await askRound('ABANDONED_WATCH_Q');
    assert.equal((await lapse(abandoned.boardId)).status, 'timeout');
    const unknownRound = await askRound('UNKNOWN_ROUND_Q');
    const rows = [
      { name: 'abandoned', args: watchArgs(abandoned.boardId, 1), out: 'abandoned',
        act: () => fetch(`${base}/api/board/${abandoned.boardId}/abandon`, { method: 'POST', headers: writeHeaders(SECRET) }) },
      { name: 'board gone', args: watchArgs('b_no_such_board', 1), out: 'gone' },
      { name: 'round not on the board', args: watchArgs(unknownRound.boardId, 7), out: 'gone' },
    ];
    for (const row of rows) {
      // A bound the row would hit if it ever kept polling, so a miss reads as 124, not a hang.
      const watch = startWatch([...row.args, '--hours', '0.001']);
      if (row.act) {
        await sleep(INTERVAL_MS * 2);
        await row.act();
      }
      const { code, stdout } = await watch.done;
      assert.deepEqual([code, stdout.trim()], [2, row.out], row.name);
    }
  });

  await check('past its bound with the round still open the watch exits 124, and its polls wrote nothing to the board', async () => {
    const r = await askRound('NEVER_SENT_Q');
    assert.equal((await lapse(r.boardId)).status, 'timeout');
    const boardFile = path.join(home, 'boards', `${r.boardId}.json`);
    const before = readFileSync(boardFile, 'utf8');
    const { code, stdout, elapsed } = await startWatch([...watchArgs(r.boardId, 1), '--hours', '0.0003']).done;
    assert.equal(code, 124);
    assert.equal(stdout.trim(), 'timeout');
    assert.ok(elapsed >= 1080, `not before the bound of 1.08 s: ${elapsed}ms`);
    assert.equal(readFileSync(boardFile, 'utf8'), before, 'a poll on an open round marks nothing');
  });

  await check('the watch is bounded by the wait ceiling the daemon and the shim enforce: by default, and however many --hours it is asked for', async () => {
    for (const extra of [[], ['--hours', '48']]) {
      const before = Date.now();
      const { code, stderr } = await startWatch([...watchArgs('b_no_such_board', 1), ...extra]).done;
      const after = Date.now();
      assert.equal(code, 2, 'setup: a board that is gone ends the watch at its first poll');
      const until = Date.parse(/until (\S+)/.exec(stderr)?.[1]);
      assert.ok(until >= before + WAIT_CEILING_MS && until <= after + WAIT_CEILING_MS,
        `${JSON.stringify(extra)}: bound ${until - before - WAIT_CEILING_MS}ms past the ceiling`);
    }
  });

  await check('a daemon that does not answer twice in a row ends the watch with 3', async () => {
    const deadPort = await freePort();
    const { code, stdout } = await startWatch(watchArgs('b_anything', 1), { env: { CLAUDE_BOARD_PORT: String(deadPort) } }).done;
    assert.deepEqual([code, stdout.trim()], [3, 'board down']);
  });

  await check('a command line the watch cannot read exits 64', async () => {
    const rows = [
      [],
      ['--board', 'b_x'],
      ['--board', 'b_x', '--round', '0'],
      ['--board', '../x', '--round', '1'],
      ['--board', 'b_x', '--round', '1', '--hours', '-2'],
      ['--board', 'b_x', '--round', '1', '--interval', '5'],
    ];
    for (const args of rows) {
      const { code, stdout } = await startWatch(args).done;
      assert.deepEqual([code, stdout], [64, ''], JSON.stringify(args));
    }
  });

  await check('collect takes the secret alone: a browser holding the cookie is refused and spends nothing', async () => {
    const r = await askRound('COOKIE_COLLECT_Q');
    assert.equal((await lapse(r.boardId)).status, 'timeout');
    await answer(r.boardId, 1, r.qid, 'Yes', '');
    const refused = await rawRequest(port, 'POST', `/api/board/${r.boardId}/collect`, {
      headers: {
        'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin',
        cookie: sessionCookieHeader(SECRET),
      },
      body: JSON.stringify({ round: 1 }),
    });
    assert.equal(refused.status, 401);
    assert.deepEqual(readBoard(r.boardId, home)[ANSWERS_DELIVERED], [], 'the round is still owed');
  });
}

runMain('watch', main, {
  cleanup: () => {
    if (server) {
      server.close();
      server.closeAllConnections?.();
    }
    rmSync(home, { recursive: true, force: true });
  },
});
