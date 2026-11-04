#!/usr/bin/env node
// The answer watch (ADR 146). A Claude Code session whose wait on a round ended unanswered
// runs the command its `timeout` packet names as one background call; the call's exit is
// what wakes the session, so a late Send reaches it within a poll for up to a day.
//
//   node bin/watch.mjs --board <id> --round <n> [--hours <h>]
//     0    round n was sent: prints its packet on one line, { board, thread, title, round,
//          status, answers, comments, url, relayed?, delivered }, and the daemon has spent
//          the round, so no later packet carries it. `delivered: true`: a packet had already
//          carried it (the thread's next one), so the session acted on it there.
//     2    the round was abandoned, or the board or the round is gone: prints `abandoned`
//          or `gone`
//     3    the board did not answer twice in a row: prints `board down`
//     124  the bound passed with the round still open: prints `timeout`
//     64   usage
//
// --hours defaults to the wait ceiling, 24, and is clamped to it. One
// `POST /api/board/:id/collect` per poll, every 30 s (CLAUDE_BOARD_WATCH_INTERVAL_MS
// overrides, for checks); the last poll lands on the bound itself. Both numbers are
// src/handoff.mjs's, which the shim's text about the watch reads too. Port and credential as
// the shim's: `daemonPort()` and the local secret (src/secret.mjs).

import http from 'node:http';
import { readSecret, daemonPort, SECRET_HEADER } from '../src/secret.mjs';
import { SAFE_BOARD_ID, WAIT_CEILING_MS, WATCH_INTERVAL_MS } from '../src/handoff.mjs';

const MAX_HOURS = WAIT_CEILING_MS / 3_600_000;
const INTERVAL_MS = Number(process.env.CLAUDE_BOARD_WATCH_INTERVAL_MS) || WATCH_INTERVAL_MS;
const REQUEST_TIMEOUT_MS = 10_000;
const USAGE = 'usage: node bin/watch.mjs --board <id> --round <n> [--hours <h>]';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--board') opts.board = value;
    else if (flag === '--round') opts.round = value;
    else if (flag === '--hours') opts.hours = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!SAFE_BOARD_ID.test(opts.board ?? '')) throw new Error('--board needs a board id');
  const round = Number(opts.round);
  if (!Number.isInteger(round) || round < 1) throw new Error('--round needs a positive integer');
  const hours = opts.hours === undefined ? MAX_HOURS : Number(opts.hours);
  if (!(hours > 0)) throw new Error('--hours must be a positive number');
  return { board: opts.board, round, hours: Math.min(hours, MAX_HOURS) };
}

/** One collect call. Resolves `{ status, json }` for any HTTP answer; rejects when the
 * daemon cannot be reached or does not answer in time. */
function collect(port, board, round) {
  return new Promise((resolve, reject) => {
    const secret = readSecret();
    const body = JSON.stringify({ round });
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/board/${board}/collect`,
      method: 'POST',
      agent: false,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(secret ? { [SECRET_HEADER]: secret } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${REQUEST_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function watch({ board, round, hours }) {
  const port = daemonPort();
  const deadline = Date.now() + hours * 3_600_000;
  process.stderr.write(`watch: board ${board} round ${round}, every ${INTERVAL_MS / 1000}s, until ${new Date(deadline).toISOString()}\n`);
  let downs = 0;
  for (;;) {
    let answer = null;
    let why;
    try {
      answer = await collect(port, board, round);
      if (answer.status === 200 && typeof answer.json?.status !== 'string') why = 'the daemon answered no round status';
      else if (answer.status !== 200 && answer.status !== 404) why = `the daemon answered ${answer.status}${answer.json?.error ? `: ${answer.json.error}` : ''}`;
    } catch (err) {
      why = err.message;
    }
    if (why) {
      downs += 1;
      if (downs >= 2) return { code: 3, out: 'board down', err: why };
    } else if (answer.status === 404) {
      return { code: 2, out: 'gone', err: `board ${board} round ${round}: ${answer.json?.error ?? 'not found'}` };
    } else {
      downs = 0;
      const { status } = answer.json;
      if (status === 'abandoned') return { code: 2, out: 'abandoned' };
      // Any other status is the sent round's own: `submitted` or `discuss`.
      if (status !== 'open') return { code: 0, out: JSON.stringify(answer.json) };
    }
    const left = deadline - Date.now();
    if (left <= 0) return { code: 124, out: 'timeout' };
    await sleep(Math.min(INTERVAL_MS, left));
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`watch: ${err.message}\n${USAGE}\n`);
    return 64;
  }
  const result = await watch(opts);
  if (result.err) process.stderr.write(`watch: ${result.err}\n`);
  process.stdout.write(`${result.out}\n`);
  return result.code;
}

main().then(
  code => { process.exitCode = code; },
  err => {
    process.stderr.write(`watch: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  },
);
