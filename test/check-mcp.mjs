// MCP protocol check: drives bin/mcp.mjs with a scripted stdio JSON-RPC client
// (no MCP SDK, hand-rolled newline-delimited JSON) against a daemon started
// in-process on an ephemeral port. No browser (CLAUDE_BOARD_NO_OPEN=1 stands in
// for `open`), no network beyond loopback. Writes only inside a temp
// CLAUDE_BOARD_HOME.
//
// Covers: initialize/tools-list shapes, tools/call on `ask`, progress
// notifications flowing throughout a held-open wait (cadence shortened via
// CLAUDE_BOARD_PROGRESS_MS rather than sleeping for real time), the result
// packet shape, the discuss path, the wall-clock timeout path, the
// unreachable-daemon error (names the revive command, writes nothing), and
// the non-interactive refusal (fails before posting, writes nothing).
//
// Also covers the things a single call with a single token cannot see, which is
// most of what actually breaks a live session:
//   * two CONCURRENT `ask` calls over one shim connection — auto-backgrounding
//     makes this the normal case, not an edge case — each keeping their own
//     progress stream, and minting exactly one thread between them;
//   * two SEQUENTIAL `ask` calls pushing round 2 into the same board;
//   * a wait surviving a real daemon restart (a separate bin/daemon.mjs process,
//     SIGTERMed and restarted underneath the shim);
//   * bin/daemon.mjs exiting promptly on SIGTERM with an SSE stream open;
//   * a daemon 4xx reported as a rejection rather than as a dead service;
//   * a later round never opening a tab, even with no client connected to the board.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { SECRET_HEADER } from '../src/secret.mjs';
import { recoveryCommand } from '../src/handoff.mjs';
import { startServer } from '../src/server.mjs';
// The product's own spawn of the shim (src/prose-check.mjs ships from src/ so a caller
// outside this repo can import it): the other side of the same stdio seam this file
// drives by hand, and the one a partial install breaks.
import { getLiveTools } from '../src/prose-check.mjs';
import { runCheck } from './run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpBin = path.join(here, '..', 'bin', 'mcp.mjs');
const daemonBin = path.join(here, '..', 'bin', 'daemon.mjs');

// The local secret, in this check's own temp dir — never ~/.config/claude-board. Set on
// this process's env before any server or shim starts: the daemon reads it once at
// startup, and every shim spawned below inherits the seam and reads the same file, which
// is what makes the end-to-end path (shim -> daemon write) work at all now that writes
// require it.
const secretDir = mkdtempSync(path.join(tmpdir(), 'claude-board-secret-'));
const SECRET_FILE = path.join(secretDir, 'secret');
const SECRET = 'e'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

/** Headers for a write made directly by this check, standing in for the served page. */
function writeHeaders() {
  return { 'content-type': 'application/json', [SECRET_HEADER]: SECRET };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Scripted JSON-RPC 2.0 client over a child process's stdio: writes
 * newline-delimited requests/notifications to stdin, and demuxes stdout lines
 * into resolved request promises vs. a running list of server-initiated
 * notifications (progress, in particular). */
class McpClient {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    child.stdout.on('data', chunk => this._onData(chunk));
    child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray non-protocol output would be a bug, but don't crash the test on it
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pend = this.pending.get(msg.id);
        if (pend) {
          this.pending.delete(msg.id);
          pend(msg);
        }
      } else {
        this.notifications.push(msg);
      }
    }
  }

  request(method, params) {
    return this.requestWithId(method, params).promise;
  }

  /** Same, but hands back the JSON-RPC id too — needed to cancel a call, and to
   * assert that a cancelled call is never answered. */
  requestWithId(method, params) {
    const id = this.nextId++;
    const promise = new Promise(resolve => this.pending.set(id, resolve));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return { id, promise };
  }

  answered(id) {
    return !this.pending.has(id);
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill(); } catch { /* already dead */ }
  }
}

/** Merge `overrides` onto the real process env, actually deleting a key when
 * its override value is `undefined` — a plain `{ ...process.env, ...overrides }`
 * spread can't unset a key (an absent key in `overrides` just leaves the
 * inherited value in place), which matters here: this suite's own process
 * runs inside an interactive Claude Code session, so CLAUDE_CODE_ENTRYPOINT is
 * already set in process.env and must be explicitly deleted to test the
 * "absent" refusal path rather than silently inheriting `cli`. */
function spawnShim(overrides, { cwd } = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // `cwd` is not decoration: the shim posts `cwd: process.cwd()` with the board, and that
  // is what the daemon resolves every by-path block against. A check about a referenced
  // FILE has to put the shim in the directory that file lives in.
  const child = spawn(process.execPath, [mcpBin], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  return new McpClient(child);
}

function listBoardIds(home) {
  const dir = path.join(home, 'boards');
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.tmp-')).map(f => f.slice(0, -'.json'.length))
  );
}

/** Poll the store for a board file that was not already present in `knownIds`
 * — several checks share one CLAUDE_BOARD_HOME, so "the board file appeared"
 * has to mean *this* call's board, not a leftover from an earlier check. */
async function waitForNewBoardFile(home, knownIds, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const id of listBoardIds(home)) {
      if (!knownIds.has(id)) return id;
    }
    await sleep(20);
  }
  throw new Error('timed out waiting for a new board file to appear in the store');
}

function countBoardFiles(home) {
  return listBoardIds(home).size;
}

/** Never let a concurrency check hang: a broken shim leaves a call unanswered
 * forever, and a hang reads as "still running" instead of as a failure. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms).unref()),
  ]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const spawnedDaemons = new Set();
const tempDirs = [];

function tempHome(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `claude-board-${tag}-`));
  tempDirs.push(dir);
  return dir;
}

/** Start bin/daemon.mjs as a real child process (not startServer in-process): the
 * restart and shutdown checks are about process lifecycle, which an in-process
 * server cannot exercise. Resolves once the daemon says it is listening. */
function startDaemonProcess(port, daemonHome, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [daemonBin], {
      env: { ...process.env, CLAUDE_BOARD_HOME: daemonHome, CLAUDE_BOARD_PORT: String(port), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedDaemons.add(child);
    child.on('exit', () => spawnedDaemons.delete(child));
    let out = '';
    let stderr = '';
    child.stderr.on('data', c => { stderr += c.toString(); });
    const timer = setTimeout(() => reject(new Error(`daemon never reported listening: ${out}${stderr}`)), 8000);
    timer.unref();
    child.stdout.on('data', c => {
      out += c.toString();
      if (out.includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', code => reject(new Error(`daemon exited early with ${code}: ${out}${stderr}`)));
  });
}

/** SIGTERM the daemon and report how long it took to actually go away. Returns
 * null if it outlived `ms` (in which case it is SIGKILLed, so the suite still
 * finishes). */
function terminateDaemon(child, ms) {
  const start = Date.now();
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(null);
    }, ms);
    timer.unref();
    child.once('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ elapsed: Date.now() - start, code, signal });
    });
    child.kill('SIGTERM');
  });
}

/** One GET, following no redirect and reading no cookie jar — which is exactly what a
 * browser's FIRST fetch of a handoff URL is. `fetch` would follow the 302 and hide both
 * the Location and the Set-Cookie this needs to assert on. */
function rawGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: u.host, ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Hold an SSE subscription open the way a real board tab does, so shutdown has a
 * connection that never ends on its own to deal with. Carries the secret because reads
 * are gated now; a real tab carries the session cookie instead. */
function openSseStream(port, boardId) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } },
      res => {
        res.once('data', () => resolve({ req, res }));
        res.on('error', () => { /* torn down at shutdown; that is the point */ });
      }
    );
    req.on('error', reject);
  });
}

/** Stop an in-process daemon a single check stood up for itself. `close()` alone waits for
 * every open connection and an SSE stream never ends, so the connections go too -- the same
 * shape bin/daemon.mjs uses, and what makes the stranded watch this server owns stop with
 * it rather than announcing the check's own boards a grace period later. */
function stopLocalServer(s) {
  s.close();
  s.closeIdleConnections?.();
  s.closeAllConnections?.();
}

/** Whatever is listening on the port need not be the daemon: during a restart
 * window any local process can bind it first. This one answers a POST with a
 * board id and a `url` of the test's choosing, and a /wait that returns at once —
 * with `waitStatus` as the packet's status, which is also how a status no shim has a
 * branch for gets in front of one. */
function startHostileDaemon({ boardId, url, waitStatus = 'submitted' }) {
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://internal');
    if (req.method === 'POST' && u.pathname === '/api/board') {
      req.resume();
      req.on('end', () => send(res, 200, { boardId, thread: 'th_hostile', round: 1, url }));
      return;
    }
    if (req.method === 'GET' && u.pathname.endsWith('/wait')) {
      return send(res, 200, {
        board: boardId, thread: 'th_hostile', title: 'hostile', round: 1,
        status: waitStatus, answers: [], comments: [], url,
      });
    }
    return send(res, 404, { error: 'not found' });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

/** A daemon that takes its time answering the THREAD-CREATING post and answers every
 * later one at once. That is the shape of a lost first response: the board is created,
 * the caller just never hears which one it is — a shim inactivity timeout, a kickstart, an
 * ./install.sh taking an update mid-request. Records the body of every post it received,
 * which is the only place "did this shim ask for a second board?" can be read. */
function startSlowCreateDaemon({ delayMs, boardId = 'slow-board-1' }) {
  const posts = [];
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://internal');
    if (req.method === 'POST' && u.pathname === '/api/board') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* recorded as {} */ }
        posts.push(body);
        const answer = () => send(res, 200, {
          boardId, thread: 'th_slow', round: body.boardId ? 2 : 1,
          url: `/b/${boardId}`, clients: 0, awaited: false,
        });
        if (body.boardId) return answer();
        setTimeout(answer, delayMs).unref();
      });
      return;
    }
    return send(res, 404, { error: 'not found' });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, posts, close: () => srv.close() }));
  });
}

/** The same lost first response, but with the REAL daemon behind it: a transparent proxy
 * that holds the thread-creating post's response back by `delayMs` and passes everything
 * else straight through. The board really is created, in a real store, with a real dedupe
 * gate on the other side — which a stub daemon cannot stand in for. */
function startSlowCreateProxy(targetPort, delayMs) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let parsed = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { /* not JSON: no delay */ }
      const slow = req.method === 'POST' && req.url === '/api/board' && !parsed.boardId;
      const upstream = http.request(
        {
          hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
        },
        up => {
          const outChunks = [];
          up.on('data', c => outChunks.push(c));
          up.on('end', () => {
            const send = () => {
              res.writeHead(up.statusCode, up.headers);
              res.end(Buffer.concat(outChunks));
            };
            if (slow) setTimeout(send, delayMs).unref();
            else send();
          });
        }
      );
      upstream.on('error', () => { res.writeHead(502); res.end('{}'); });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

/** A stand-in for `open`: records the URLs it is handed, one per line. */
function makeOpenRecorder(dir) {
  const script = path.join(dir, 'fake-open.sh');
  const log = path.join(dir, 'opened.log');
  writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$CLAUDE_BOARD_OPEN_LOG"\n', { mode: 0o755 });
  return {
    script,
    log,
    opened() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    },
    async waitForOpens(n, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (this.opened().length >= n) return this.opened();
        await sleep(25);
      }
      return this.opened();
    },
  };
}

function progressCount(client, token) {
  return client.notifications.filter(
    n => n.method === 'notifications/progress' && n.params.progressToken === token
  ).length;
}

/** Poll until `n` progress notifications have landed for `token`, rather than
 * sleeping exactly n cadences and asserting on the count: one interval of margin
 * flakes on any GC pause or loaded machine. Returns the count actually seen. */
async function waitForProgress(client, token, n, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (progressCount(client, token) >= n) break;
    await sleep(25);
  }
  return progressCount(client, token);
}

/** Submit as the page would. A submit must NAME the round it is answering
 * (PROTOCOL.md "HTTP surface"; the server 400s without it and 409s on a stale one),
 * so this reads the currently-open round off the stored board rather than assuming
 * round 1 -- several checks below are submitting round 2. Callers can still pin
 * `round` explicitly to exercise the stale-client refusals. */
async function submitBoard(baseUrl, boardId, body, boardHome = home) {
  const stored = JSON.parse(readFileSync(path.join(boardHome, 'boards', `${boardId}.json`), 'utf8'));
  const open = stored.rounds.find(r => r.status === 'open');
  const res = await fetch(`${baseUrl}/api/board/${boardId}/submit`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      action: 'send',
      answers: [],
      comments: [],
      round: open ? open.n : stored.rounds.length,
      ...body,
    }),
  });
  assert.equal(res.status, 200, `submit must succeed (got ${res.status}: ${await res.clone().text()})`);
  return res.json();
}

// No explicit id: ids are minted per board, so two concurrent posts get q1/q2
// rather than the second silently replacing the first.
const QUESTION = { kind: 'question', prompt: 'Looks right?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };

// Content only, so the call returns the instant the post lands rather than blocking on
// /wait — what a check about the POST itself wants (see QUIRKS.md, "a check-mcp.mjs
// fixture with no question block no longer blocks on /wait").
const NOTE = { kind: 'markdown', text: 'Nothing here to answer.' };

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-mcp-'));
let server, port, base;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  const baseEnv = {
    CLAUDE_BOARD_HOME: home,
    CLAUDE_BOARD_PORT: String(port),
    CLAUDE_BOARD_NO_OPEN: '1', // stand-in for `open`: no real browser, ever
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_BOARD_PROGRESS_MS: '80', // shortened cadence instead of real 20s waits
  };

  // --- initialize + tools/list shapes -------------------------------------

  let client = spawnShim(baseEnv);

  await check('initialize returns MCP protocol/server info', async () => {
    const res = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'check-mcp', version: '0.0.0' },
    });
    assert.ok(res.result, 'expected a result, not an error');
    assert.equal(res.result.serverInfo.name, 'claude-board');
    assert.ok(res.result.capabilities.tools, 'must advertise the tools capability');
  });
  client.notify('notifications/initialized', {});

  await check('tools/list exposes exactly the single ask tool', async () => {
    const res = await client.request('tools/list', {});
    assert.equal(res.result.tools.length, 1);
    const tool = res.result.tools[0];
    assert.equal(tool.name, 'ask');
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.inputSchema.properties.title);
    assert.ok(tool.inputSchema.properties.blocks);
    assert.ok(tool.inputSchema.required.includes('title'));
    assert.ok(tool.inputSchema.required.includes('blocks'));
  });

  // --- tools/call ask: blocking wait, progress flowing, result shape -----

  await check('tools/call ask posts a board, blocks, keeps sending progress, and returns on submit', async () => {
    const knownIds = listBoardIds(home);
    const callPromise = client.request('tools/call', {
      name: 'ask',
      arguments: {
        title: 'MCP check',
        blocks: [
          { kind: 'markdown', text: '# Notes\n\nsome context' },
          { kind: 'question', prompt: 'Looks right?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      },
      _meta: { progressToken: 'tok-normal' },
    });

    const boardId = await waitForNewBoardFile(home, knownIds);

    // Simulate the board sitting past the MCP idle window: let several
    // progress notifications land before anyone submits. Polled with a generous
    // deadline rather than sleeping exactly three cadences, which flakes.
    const seen = await waitForProgress(client, 'tok-normal', 3);
    assert.ok(seen >= 3, `expected several progress notifications while waiting, got ${seen}`);
    const progressSoFar = client.notifications.filter(
      n => n.method === 'notifications/progress' && n.params.progressToken === 'tok-normal'
    );
    for (const n of progressSoFar) {
      assert.equal(typeof n.params.progress, 'number');
      assert.equal(typeof n.params.total, 'number');
    }

    const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'lgtm' }],
        comments: [],
      }),
    });
    assert.equal(submitRes.status, 200);

    // A submit arriving after the idle window still returns normally.
    const res = await callPromise;
    assert.ok(res.result, 'expected a tool result, not a protocol error');
    const result = res.result;

    assert.equal(result.isError, false);
    assert.ok(Array.isArray(result.content) && result.content[0].type === 'text');
    assert.equal(result.status, 'submitted');
    assert.equal(result.board, boardId);
    assert.equal(result.round, 1);
    assert.equal(result.title, 'MCP check');
    assert.ok(result.url && result.url.includes(boardId), 'the board URL must be in the result');
    assert.ok(result.content[0].text.includes(result.url), 'the board URL must also be in the text summary');
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0].id, 'q1');
    assert.equal(result.answers[0].status, 'answered');
    assert.equal(result.answers[0].choice, 'Yes');
    assert.equal(result.answers[0].note, 'lgtm');
    assert.equal(result.comments.length, 0);

    // progress notifications did not stop before the submit actually landed
    const progressAfter = client.notifications.filter(
      n => n.method === 'notifications/progress' && n.params.progressToken === 'tok-normal'
    );
    assert.ok(progressAfter.length >= progressSoFar.length, 'progress must keep flowing right up to the submit');
  });

  client.close();

  // --- a round with no question blocks returns as soon as the post lands ---
  // No mode flag, no "no questions" guard: whether `ask`
  // waits is derived entirely from whether the round's blocks contain a `kind: 'question'`
  // block anywhere. A round of content blocks only has nothing a human needs to submit, so
  // there is nothing left to wait for. On the unmodified shim this call blocks on
  // /api/board/:id/wait exactly like a question round does -- nobody ever submits a board
  // nobody was asked to answer, so it would sit past the 5s budget below and time out.

  await check('a round with no question blocks returns as soon as the post succeeds, without waiting', async () => {
    const knownIds = listBoardIds(home);
    const contentClient = spawnShim(baseEnv);
    try {
      const start = Date.now();
      const res = await withTimeout(contentClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'Content-only round',
          blocks: [
            { kind: 'markdown', text: '# Dashboard\n\nsome rendered artifact, nothing to answer' },
            { kind: 'html', html: '<div>rendered artifact</div>' },
          ],
        },
      }), 5000, 'a content-only round must return promptly, not block for the wall clock');
      const elapsed = Date.now() - start;

      const boardId = await waitForNewBoardFile(home, knownIds);
      assert.ok(elapsed < 3000, `must return as soon as the post lands, took ${elapsed}ms`);

      const result = res.result;
      assert.equal(result.isError, false);
      assert.equal(result.status, 'posted', 'a no-question round is packet status "posted", not "submitted"');
      assert.equal(result.board, boardId);
      assert.equal(result.round, 1);
      assert.deepEqual(result.answers, []);
      assert.deepEqual(result.comments, []);
      assert.ok(result.url && result.url.includes(boardId), 'the board URL must still be reported');
      assert.match(result.content[0].text, /nothing awaited/i);
    } finally {
      contentClient.close();
    }
  });

  await check('wait: true on a page board whose html reference cannot resolve returns at once -- the daemon\'s own verdict, not the shim\'s guess at it', async () => {
    // The two sides used to disagree about exactly this shape. `isPageRoundShape`
    // (bin/mcp.mjs) reads the RAW blocks and cannot know that a `source` failed to
    // resolve; `mintAwait` (src/board.mjs) reads the normalized ones and marks the
    // round not-awaited, so no packet would ever be built -- and the call sat out
    // the full wall-clock cap on a round nothing could answer. The post response
    // now carries the minted round's own `awaited`, and the shim agrees with it.
    const knownIds = listBoardIds(home);
    const brokenClient = spawnShim(baseEnv);
    try {
      const start = Date.now();
      const res = await withTimeout(brokenClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'Page board with a broken reference',
          blocks: [{ kind: 'html', source: 'definitely-not-here.html' }],
          wait: true,
        },
      }), 5000, 'a round the daemon minted not-awaited must return promptly, not block for the wall clock');
      const elapsed = Date.now() - start;
      const boardId = await waitForNewBoardFile(home, knownIds);
      assert.ok(elapsed < 3000, `must return as soon as the post lands, took ${elapsed}ms`);
      assert.equal(res.result.status, 'posted', 'nothing is awaited on it, so the packet says posted');
      assert.match(res.result.content[0].text, /nothing awaited/i);
      const round = JSON.parse(readFileSync(path.join(home, 'boards', `${boardId}.json`), 'utf8')).rounds[0];
      assert.equal(round.awaited, false, 'setup: the daemon really did mint it not-awaited');
    } finally {
      brokenClient.close();
    }
  });

  // --- ADR.md entry 45: `wait: true` on a page board blocks and returns the
  // round's own comments, not through the ADR 35 undelivered path -----------------

  await check('wait: true on a page board (one html block) blocks until the reviewer submits, and the packet carries that round\'s own comments', async () => {
    const knownIds = listBoardIds(home);
    const awaitedClient = spawnShim(baseEnv);
    try {
      const start = Date.now();
      const callPromise = awaitedClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'Awaited page board',
          blocks: [{ kind: 'html', html: '<div>AWAITED_ARTIFACT</div>' }],
          wait: true,
        },
      });

      const boardId = await waitForNewBoardFile(home, knownIds, 5000);
      // Still blocked at 1s in: the unmodified shim would have already returned
      // (a page board with no question posts and returns at once), so this is
      // what proves `wait: true` actually reached the blocking path rather than
      // being silently ignored.
      const stillPending = await Promise.race([callPromise.then(() => 'resolved'), sleep(1000).then(() => 'pending')]);
      assert.equal(stillPending, 'pending', 'wait: true must keep the call blocked on a page board round');

      const h1 = JSON.parse(readFileSync(path.join(home, 'boards', `${boardId}.json`), 'utf8')).blocks[0].id;
      const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({
          round: 1,
          action: 'send',
          answers: [],
          comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'AWAITED_COMMENT' }],
        }),
      });
      assert.equal(submitRes.status, 200);

      const res = await withTimeout(callPromise, 5000, 'the call must resolve promptly once the round is submitted');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `must resolve once submitted, not ride out the wall clock, took ${elapsed}ms`);

      const result = res.result;
      assert.equal(result.isError, false);
      assert.equal(result.status, 'submitted');
      assert.equal(result.board, boardId);
      assert.equal(result.round, 1);
      assert.deepEqual(result.answers, [], 'a page board round asks nothing, so there is nothing to answer');
      assert.equal(result.comments.length, 1, 'this round\'s own comment must come back in this same packet');
      assert.equal(result.comments[0].text, 'AWAITED_COMMENT');
      assert.equal(result.comments[0].round, 1);
    } finally {
      awaitedClient.close();
    }
  });

  await check('wait: true on a page board sent with no comments returns an empty comments array -- a valid outcome, not an error', async () => {
    const knownIds = listBoardIds(home);
    const awaitedClient = spawnShim(baseEnv);
    try {
      const callPromise = awaitedClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'Awaited page board, nothing to add',
          blocks: [{ kind: 'html', html: '<div>AWAITED_EMPTY</div>' }],
          wait: true,
        },
      });
      const boardId = await waitForNewBoardFile(home, knownIds, 5000);
      await sleep(150);
      const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
      });
      assert.equal(submitRes.status, 200);

      const res = await withTimeout(callPromise, 5000, 'the call must resolve once submitted');
      const result = res.result;
      assert.equal(result.isError, false, 'zero comments must not be reported as an error');
      assert.equal(result.status, 'submitted');
      assert.deepEqual(result.comments, []);
    } finally {
      awaitedClient.close();
    }
  });

  await check('wait: true on a page board honours the wall-clock timeout, same as a question round', async () => {
    const timeoutClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_TIMEOUT_MS: '150', CLAUDE_BOARD_PROGRESS_MS: '40' });
    const start = Date.now();
    const res = await timeoutClient.request('tools/call', {
      name: 'ask',
      arguments: {
        title: 'Awaited page board, never answered',
        blocks: [{ kind: 'html', html: '<div>AWAITED_TIMEOUT</div>' }],
        wait: true,
      },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `timeout must return promptly, took ${elapsed}ms`);
    const result = res.result;
    assert.equal(result.isError, false);
    assert.equal(result.status, 'timeout');
    assert.match(result.content[0].text, /no response/i);
    assert.ok(result.url, 'timeout result must still carry the board URL to recover the tab');

    timeoutClient.close();
  });

  await check('when both processes share one cap -- what a shipped install has -- the DAEMON times out first and records that the wait died', async () => {
    // The shim and the daemon read the same CLAUDE_BOARD_TIMEOUT_MS and default to
    // the same 40 minutes; install.sh writes it to neither. The shim's deadline
    // starts at blockingWait entry and the daemon's only after connect and parse, so
    // the shim always won by the request latency, aborted, and the daemon returned
    // early on a dead client -- leaving its entire timeout branch (the expiry
    // broadcast, the round closure, the timeout packet's own drain) unreachable in
    // every shipped configuration. The check above deliberately runs a 150ms shim
    // against a 40-minute daemon, which is the one arrangement where the shim SHOULD
    // win; this is the shipped one, and the closed round on disk is the proof.
    const dhome = tempHome('shared-cap');
    const dport = await freePort();
    const daemon = await startDaemonProcess(dport, dhome, { CLAUDE_BOARD_TIMEOUT_MS: '400' });
    const sharedClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_HOME: dhome,
      CLAUDE_BOARD_PORT: String(dport),
      CLAUDE_BOARD_TIMEOUT_MS: '400',
      CLAUDE_BOARD_PROGRESS_MS: '100',
    });
    try {
      const res2 = await withTimeout(sharedClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'One cap, both processes',
          blocks: [{ kind: 'html', html: '<div>SHARED_CAP</div>' }],
          wait: true,
        },
      }), 8000, 'the call must still end at the cap');
      assert.equal(res2.result.status, 'timeout');
      const round = JSON.parse(readFileSync(path.join(dhome, 'boards', `${res2.result.board}.json`), 'utf8')).rounds[0];
      assert.equal(round.awaited, false, 'the daemon that gave up must have recorded that the wait died');
      assert.ok(round.awaitDeadline, 'and left the deadline behind as the record of when');
      assert.equal(round.status, 'open', 'recording a dead wait is not sending or archiving the round');
    } finally {
      sharedClient.close();
      try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // --- discuss path: returns immediately with partial answers ------------

  await check('discuss-in-chat returns immediately with partial answers and a stop-posting status', async () => {
    const knownIds = listBoardIds(home);
    const discussClient = spawnShim(baseEnv);
    const callPromise = discussClient.request('tools/call', {
      name: 'ask',
      arguments: {
        title: 'Discuss check',
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    });

    const boardId = await waitForNewBoardFile(home, knownIds, 5000);

    await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'discuss',
        answers: [{ id: 'q1', status: 'deferred', choice: null, note: 'want to talk it through' }],
        comments: [],
      }),
    });

    const res = await callPromise;
    const result = res.result;
    assert.equal(result.isError, false);
    assert.equal(result.status, 'discuss');
    assert.equal(result.answers[0].status, 'deferred');
    assert.ok(result.url, 'discuss result must still carry the board URL');
    assert.match(result.content[0].text, /stop/i);
    assert.match(result.content[0].text, /discuss/i);

    discussClient.close();
  });

  // --- wall-clock timeout: explicit no-response, not a hang ---------------

  await check('the wall-clock cap returns an explicit timeout status rather than hanging', async () => {
    const timeoutClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_TIMEOUT_MS: '150', CLAUDE_BOARD_PROGRESS_MS: '40' });
    const start = Date.now();
    // Must carry a question block: a content-only round now returns as soon as the post
    // succeeds and never reaches the wait this test means to exercise.
    const res = await timeoutClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'Timeout check', blocks: [{ kind: 'markdown', text: '# never answered' }, QUESTION] },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `timeout must return promptly, took ${elapsed}ms`);
    const result = res.result;
    assert.equal(result.isError, false);
    assert.equal(result.status, 'timeout');
    assert.match(result.content[0].text, /no response/i);
    assert.ok(result.url, 'timeout result must still carry the board URL to recover the tab');

    timeoutClient.close();
  });

  // --- unreachable daemon: names the revive command, writes nothing ------

  await check('an unreachable daemon reports the revive command and writes nothing', async () => {
    const { server: throwaway, port: deadPort } = await startServer({ home: mkdtempSync(path.join(tmpdir(), 'claude-board-dead-')), port: 0 });
    await new Promise(resolve => throwaway.close(resolve)); // now nothing listens on deadPort

    const before = countBoardFiles(home);
    const deadClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_PORT: String(deadPort) });
    const res = await deadClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'Unreachable check', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const result = res.result;

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /launchctl kickstart -k gui\/\$\(id -u\)\/claude-board/);
    assert.match(result.content[0].text, /install\.sh/);
    assert.equal(countBoardFiles(home), before, 'an unreachable daemon must write nothing to the store');

    deadClient.close();
  });

  // --- the local secret: the shim holds it, or refuses ----------------------

  await check('a shim with no local secret refuses before posting, names ./install.sh, and writes nothing', async () => {
    // Every other check in this file proves the end-to-end path WITH the secret: the
    // shim reads it, the daemon requires it on every write, and boards get posted and
    // answered. This is the other half. (Ablation: drop the SECRET guard from askTool
    // and the shim posts anyway, gets a bare 401 from the daemon, and reports it as
    // "the daemon rejected this board" -- a message that sends the user to fix their
    // blocks rather than to run the installer.)
    const before = countBoardFiles(home);
    // Pointed at a port with NOTHING on it, deliberately: that is what makes this bind
    // on the guard rather than on the daemon's 401. With the guard, the shim never
    // opens a socket and says "local secret"; without it, the very next thing that
    // happens is ECONNREFUSED and the message becomes "the daemon is not reachable...
    // kickstart", which sends the user to restart a service that is not the problem.
    const deadPort = await freePort();
    const noSecretClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(deadPort),
      CLAUDE_BOARD_POST_TIMEOUT_MS: '2000',
      CLAUDE_BOARD_SECRET_FILE: path.join(secretDir, 'does-not-exist'),
    });
    const start = Date.now();
    const res = await noSecretClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'No secret', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `refusal must be immediate, took ${elapsed}ms`);
    const result = res.result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /refused/i);
    assert.match(result.content[0].text, /local secret/);
    assert.match(result.content[0].text, /install\.sh/, 'the message must name the fix');
    assert.doesNotMatch(result.content[0].text, /kickstart/, 'nothing was even contacted: this must not read as a dead daemon');
    assert.doesNotMatch(result.content[0].text, /not reachable/, 'the shim must refuse before it opens a socket at all');
    assert.equal(countBoardFiles(home), before, 'a shim with no secret must post nothing');

    noSecretClient.close();
  });

  await check('a shim holding the WRONG secret reports the 401 as a credential problem, not as a bad board', async () => {
    const before = countBoardFiles(home);
    const wrongFile = path.join(secretDir, 'wrong-secret');
    writeFileSync(wrongFile, 'f'.repeat(64), { mode: 0o600 });
    const wrongClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_SECRET_FILE: wrongFile });
    const res = await wrongClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'Wrong secret', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const result = res.result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /local secret/);
    assert.match(result.content[0].text, /install\.sh/);
    assert.equal(countBoardFiles(home), before, 'a 401 must leave the store untouched');

    wrongClient.close();
  });

  // --- non-interactive refusal: fails before posting, writes nothing -----

  await check('a non-interactive session (sdk-cli entrypoint) is refused, not parked', async () => {
    const before = countBoardFiles(home);
    const headlessClient = spawnShim({ ...baseEnv, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
    const start = Date.now();
    const res = await headlessClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'Headless check', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `refusal must be immediate, took ${elapsed}ms`);
    const result = res.result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /refused/i);
    assert.equal(countBoardFiles(home), before, 'a refused non-interactive session must write nothing');

    headlessClient.close();
  });

  await check('CLAUDE_BOARD_HEADLESS=1 forces refusal even with an interactive entrypoint', async () => {
    const before = countBoardFiles(home);
    const forcedClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_HEADLESS: '1' });
    const res = await forcedClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'Forced headless check', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const result = res.result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /CLAUDE_BOARD_HEADLESS/);
    assert.equal(countBoardFiles(home), before, 'a forced-headless refusal must write nothing');

    forcedClient.close();
  });

  // --- the third refusal trigger: the daemon cannot open a tab (the VPS case) -------------------------------------------------------
  // SSH onto a machine with no display passes the interactive-entrypoint check and
  // reaches a live daemon -- neither of the first two refusal triggers fires -- but
  // openBoardTab silently no-ops on a non-darwin platform with no CLAUDE_BOARD_OPEN_CMD
  // configured. CLAUDE_BOARD_ASSUME_PLATFORM stands in for a second OS (checks only,
  // never set by a user): there is no real non-darwin machine to run this suite on.

  await check('a session that cannot open a tab is refused up front (assumed non-darwin, no opener configured)', async () => {
    const before = countBoardFiles(home);
    const vpsClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_ASSUME_PLATFORM: 'linux',
      CLAUDE_BOARD_NO_OPEN: undefined, // opening is NOT suppressed here -- this IS the "cannot" case
      CLAUDE_BOARD_OPEN_CMD: undefined,
    });
    const start = Date.now();
    const res = await vpsClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'VPS check', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `refusal must be immediate, took ${elapsed}ms`);
    const result = res.result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /refused/i);
    assert.match(result.content[0].text, /cannot open a browser tab/i);
    assert.doesNotMatch(result.content[0].text, /kickstart/, 'nothing was contacted: this must not read as a dead daemon');
    assert.doesNotMatch(result.content[0].text, /local secret/i, 'this is not a credential problem');
    assert.equal(countBoardFiles(home), before, 'a refused session must post nothing');

    vpsClient.close();
  });

  await check('CLAUDE_BOARD_OPEN_CMD alone satisfies the cannot-open-a-tab check, regardless of platform', async () => {
    const dir = tempHome('vps-opener');
    const recorder = makeOpenRecorder(dir);
    const knownIds = listBoardIds(home);
    const vpsOpenerClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_ASSUME_PLATFORM: 'linux',
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const call = vpsOpenerClient.request('tools/call', {
        name: 'ask', arguments: { title: 'VPS with opener', blocks: [QUESTION] },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      assert.equal((await recorder.waitForOpens(1, 10_000)).length, 1, 'a configured opener must still be used, even assumed non-darwin');
      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }] });
      const res = await withTimeout(call, 8000, 'the call must return normally, not be refused');
      assert.equal(res.result.isError, false, 'a configured opener means this is not the "cannot open a tab" case');
      assert.equal(res.result.status, 'submitted');
    } finally {
      vpsOpenerClient.close();
    }
  });

  await check('CLAUDE_BOARD_NO_OPEN=1 suppresses the cannot-open-a-tab refusal too (suppressed, not absent)', async () => {
    const knownIds = listBoardIds(home);
    const suppressedClient = spawnShim({
      ...baseEnv, // baseEnv already carries CLAUDE_BOARD_NO_OPEN: '1'
      CLAUDE_BOARD_ASSUME_PLATFORM: 'linux',
      CLAUDE_BOARD_OPEN_CMD: undefined,
    });
    try {
      const call = suppressedClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Suppressed not absent', blocks: [QUESTION] },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }] });
      const res = await withTimeout(call, 8000, 'a NO_OPEN=1 session must proceed normally, not be refused');
      assert.equal(res.result.isError, false);
      assert.equal(res.result.status, 'submitted');
    } finally {
      suppressedClient.close();
    }
  });

  // --- two concurrent asks: each call keeps ITS OWN progress stream ---------
  // Auto-backgrounding means a session stays interactive while an `ask` blocks, so
  // a second `ask` while the first is still waiting is the designed flow. If the
  // progress sink lives on the session instead of on the call, the second call
  // redirects the first call's notifications to its own progressToken; the first
  // call then has nothing holding the MCP idle-abort timer off and dies with its
  // board still open. One call with one token cannot see that.

  await check('two concurrent asks each keep receiving progress on their own token', async () => {
    const knownIds = listBoardIds(home);
    const client2 = spawnShim(baseEnv);
    try {
      const callA = client2.request('tools/call', {
        name: 'ask',
        arguments: { title: 'Concurrent A', blocks: [QUESTION] },
        _meta: { progressToken: 'tok-A' },
      });
      // Same tick as A would also be legal; a beat later is the realistic shape
      // (the agent gets control back, then asks again).
      await sleep(120);
      const callB = client2.request('tools/call', {
        name: 'ask',
        arguments: { title: 'Concurrent B', blocks: [QUESTION] },
        _meta: { progressToken: 'tok-B' },
      });

      const boardId = await waitForNewBoardFile(home, knownIds);
      const countFor = tok => progressCount(client2, tok);

      // Let both calls sit past several progress ticks with B definitely running.
      await waitForProgress(client2, 'tok-B', 3);
      await waitForProgress(client2, 'tok-A', 3);
      const aWhileBRuns = countFor('tok-A');
      const bWhileBRuns = countFor('tok-B');
      assert.ok(
        aWhileBRuns >= 3,
        `call A must keep its own progress stream while a second ask runs, got ${aWhileBRuns} notification(s) on tok-A`
      );
      assert.ok(
        bWhileBRuns >= 3,
        `call B must have its own progress stream, got ${bWhileBRuns} notification(s) on tok-B`
      );

      // The board URL is the fallback that cannot fail: it has to reach the human
      // while the call is still blocked, not only in the final result.
      const aNote = client2.notifications.find(
        n => n.method === 'notifications/progress' && n.params.progressToken === 'tok-A'
      );
      assert.match(aNote.params.message, new RegExp(`/b/${boardId}`), 'progress must carry the board URL');

      await submitBoard(base, boardId, {
        answers: [
          { id: 'q1', status: 'answered', choice: 'Yes', note: '' },
          { id: 'q2', status: 'answered', choice: 'No', note: '' },
        ],
      });

      const [resA, resB] = await withTimeout(Promise.all([callA, callB]), 8000, 'both concurrent asks must return');
      assert.equal(resA.result.status, 'submitted', 'call A must return normally, not die waiting');
      assert.equal(resB.result.status, 'submitted');

      // Progress kept flowing for BOTH right up to the submit.
      assert.ok(countFor('tok-A') >= aWhileBRuns, 'tok-A progress must not stop when a second ask starts');
      assert.ok(countFor('tok-B') >= bWhileBRuns);
    } finally {
      client2.close();
    }
  });

  // --- two concurrent asks mint exactly ONE thread (no double-post race) -----

  await check('two asks fired in the same tick mint one board, not two', async () => {
    const knownIds = listBoardIds(home);
    const raceClient = spawnShim(baseEnv);
    try {
      // Both requests written before either can be answered: `session.boardId` is
      // read before an await and written after one, so without an in-flight guard
      // both calls see null, both POST a brand-new board, and one shim ends up
      // owning two threads.
      const callA = raceClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Race A', blocks: [QUESTION] }, _meta: { progressToken: 'race-A' },
      });
      const callB = raceClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Race B', blocks: [QUESTION] }, _meta: { progressToken: 'race-B' },
      });

      const boardId = await waitForNewBoardFile(home, knownIds);
      await sleep(400); // ample time for a second board file to show up if one is coming

      const fresh = [...listBoardIds(home)].filter(id => !knownIds.has(id));
      assert.deepEqual(fresh, [boardId], `one shim is one thread: expected exactly one new board, got ${fresh.length}`);

      await submitBoard(base, boardId, {
        answers: [
          { id: 'q1', status: 'answered', choice: 'Yes', note: '' },
          { id: 'q2', status: 'answered', choice: 'Yes', note: '' },
        ],
      });

      const [resA, resB] = await withTimeout(Promise.all([callA, callB]), 8000, 'both racing asks must return');
      assert.equal(resA.result.board, boardId);
      assert.equal(resB.result.board, boardId, 'the racing call must land in the same thread, not a second one');
    } finally {
      raceClient.close();
    }
  });

  // --- a boundary declared beside a concurrent ask still mints ONE board ------
  // The guard above is read before an await and written after one, so reading it once —
  // on the way in — was not enough: `fresh` awaits the boundary declaration, and a
  // concurrent call slips into that gap, sees no board and no guard, and starts minting.
  // The first call then wakes up, still sees no board, and mints a second one: two
  // threads, two tabs, and whichever board the reviewer does not open sits awaited
  // forever.

  await check('an ask declaring a boundary beside a concurrent ask mints one board, not two', async () => {
    const knownIds = listBoardIds(home);
    const boundaryClient = spawnShim(baseEnv);
    try {
      const callA = boundaryClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Fresh A', blocks: [QUESTION], fresh: true }, _meta: { progressToken: 'fresh-A' },
      });
      const callB = boundaryClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Plain B', blocks: [QUESTION] }, _meta: { progressToken: 'fresh-B' },
      });

      const boardId = await waitForNewBoardFile(home, knownIds);
      await sleep(400); // ample time for a second board file to show up if one is coming

      const minted = [...listBoardIds(home)].filter(id => !knownIds.has(id));
      assert.deepEqual(
        minted, [boardId],
        `a boundary declared beside a concurrent ask must not mint a second board (got ${minted.length})`
      );

      await submitBoard(base, boardId, {
        answers: [
          { id: 'q1', status: 'answered', choice: 'Yes', note: '' },
          { id: 'q2', status: 'answered', choice: 'Yes', note: '' },
        ],
      });
      const [resA, resB] = await withTimeout(Promise.all([callA, callB]), 8000, 'both asks must return');
      assert.equal(resA.result.board, boardId);
      assert.equal(resB.result.board, boardId, 'both calls belong to the one board this conversation has');
    } finally {
      boundaryClient.close();
    }
  });

  // ...and in the other order, which the guard alone does not cover. The plain ask mints
  // first; the `fresh` one waits that mint out, and then declared its boundary against the
  // board it had just been handed — closing a live round under the call still blocked on
  // it and minting a second board for one conversation. `fresh` means "this conversation
  // has posted no board", and a board minted milliseconds ago by a concurrent ask on this
  // same shim IS this conversation.

  await check('a boundary declared after a concurrent ask joins that board instead of abandoning it', async () => {
    const knownIds = listBoardIds(home);
    const reverseClient = spawnShim(baseEnv);
    try {
      const plain = reverseClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Plain first', blocks: [QUESTION] }, _meta: { progressToken: 'rev-plain' },
      });
      const declaring = reverseClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Fresh second', blocks: [QUESTION], fresh: true }, _meta: { progressToken: 'rev-fresh' },
      });

      const boardId = await waitForNewBoardFile(home, knownIds);
      await sleep(400);

      const minted = [...listBoardIds(home)].filter(id => !knownIds.has(id));
      assert.deepEqual(minted, [boardId], `one conversation, one board (got ${minted.length})`);

      const stored = JSON.parse(readFileSync(path.join(home, 'boards', `${boardId}.json`), 'utf8'));
      assert.equal(stored.rounds[0].status, 'open', 'the live round must not be abandoned by the call that joined it');

      await submitBoard(base, boardId, {
        answers: [
          { id: 'q1', status: 'answered', choice: 'Yes', note: '' },
          { id: 'q2', status: 'answered', choice: 'No', note: '' },
        ],
      });
      const [resPlain, resFresh] = await withTimeout(Promise.all([plain, declaring]), 8000, 'both asks must return');
      assert.equal(
        resPlain.result.status, 'submitted',
        'the first call must still get its reviewer, not an abandoned board pulled out from under it'
      );
      assert.equal(resPlain.result.board, boardId);
      assert.equal(resFresh.result.board, boardId, 'and the declaring call belongs to that same board');
    } finally {
      reverseClient.close();
    }
  });

  // --- a lost FIRST response does not become a second board ------------------
  // The thread-creating post is the one post with no board id to scope an idempotency key
  // to, so a response lost after the body went out leaves a board this shim cannot name.
  // Abandoning that post is what made the retry — which the failure message itself invites
  // — mint a second board, thread and tab, and leave the first orphaned on a live round.

  await check('a first post whose response is lost is joined by the retry, not doubled', async () => {
    const slow = await startSlowCreateDaemon({ delayMs: 1500 });
    const slowClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(slow.port),
      CLAUDE_BOARD_POST_TIMEOUT_MS: '200',   // this call's patience
      CLAUDE_BOARD_CREATE_TIMEOUT_MS: '9000', // the post's own, deliberately longer
    });
    try {
      const first = await withTimeout(slowClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Lost response', blocks: [NOTE] },
      }), 8000, 'the first ask must fail on its own deadline rather than hang');
      assert.equal(first.result.isError, true, 'a post nobody answered in time is a failure, not a silent success');
      assert.doesNotMatch(
        first.result.content[0].text, /Nothing was posted or written/,
        'the body went out and the daemon is synchronous after it: that sentence would be false'
      );
      assert.match(
        first.result.content[0].text, /still running/i,
        'the agent has to be told the post is still live, and that a retry joins it'
      );
      assert.doesNotMatch(
        first.result.content[0].text, /launchctl kickstart/,
        'the daemon is slow, not dead — restarting it would kill the very post that is still going'
      );

      // The retry, exactly as the message invites it: same title, same blocks.
      const second = await withTimeout(slowClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Lost response', blocks: [NOTE] },
      }), 15000, 'the retry must return');
      assert.equal(second.result.isError, false, `the retry must succeed: ${second.result.content[0].text}`);
      assert.equal(second.result.board, 'slow-board-1', 'and land on the board the lost post actually made');

      const creates = slow.posts.filter(p => !p.boardId);
      assert.equal(creates.length, 1, 'exactly one board may ever be asked for: a retry is not a second thread');
      assert.deepEqual(
        slow.posts.filter(p => p.boardId), [],
        'and the retry posts nothing at all: the answer to the request it is repeating was already in hand'
      );
    } finally {
      slowClient.close();
      slow.close();
    }
  });

  // --- the same retry, with the REAL dedupe gate behind it -------------------
  // The daemon recognises a retry by the round's RESOLVED content, not by the request
  // body: a by-path block whose file was regenerated in between is a genuinely NEW round
  // to it, which is exactly what makes re-posting the retry unsafe. The artifact loop the
  // manual prescribes — post a rendered file, regenerate it, re-issue the identical ask —
  // drifts on purpose, so this is the ordinary case rather than an exotic one. A retry
  // that reposts here lands round 2 and leaves round 1 open behind it; the join has the
  // answer already and must use it.

  await check('a retry of a lost first post adds no round even when the file it references drifted', async () => {
    const stageDir = tempHome('drift-retry');
    const stagePath = path.join(stageDir, 'stage.html');
    const page = marker => `<!doctype html><html><body><h1>${marker}</h1></body></html>`;
    writeFileSync(stagePath, page('ARTIFACT_V1'), 'utf8');

    const proxy = await startSlowCreateProxy(port, 1200);
    const ask = { title: 'Rendered artifact', blocks: [{ kind: 'html', source: { path: 'stage.html' } }] };
    const knownIds = listBoardIds(home);
    // cwd, not just env: the shim posts `cwd: process.cwd()` and the daemon resolves
    // `stage.html` against it.
    const driftClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(proxy.port),
      CLAUDE_BOARD_POST_TIMEOUT_MS: '200',
      CLAUDE_BOARD_CREATE_TIMEOUT_MS: '9000',
    }, { cwd: stageDir });
    try {
      const first = await withTimeout(driftClient.request('tools/call', {
        name: 'ask', arguments: ask,
      }), 8000, 'the first ask must fail on its own deadline');
      assert.equal(first.result.isError, true, 'setup: the first call gives up before its answer arrives');

      // The file is regenerated while the post nobody heard from is still running.
      writeFileSync(stagePath, page('ARTIFACT_V2'), 'utf8');

      const retry = await withTimeout(driftClient.request('tools/call', {
        name: 'ask', arguments: ask,
      }), 15000, 'the retry must return');
      assert.equal(retry.result.isError, false, `the retry must succeed: ${retry.result.content[0].text}`);
      assert.equal(retry.result.round, 1, 'the retry is the same round, not the next one');

      const boardId = retry.result.board;
      assert.deepEqual(
        [...listBoardIds(home)].filter(id => !knownIds.has(id)), [boardId],
        'one board for the two calls'
      );
      const afterRetry = JSON.parse(readFileSync(path.join(home, 'boards', `${boardId}.json`), 'utf8'));
      assert.equal(
        afterRetry.rounds.length, 1,
        'a retry that re-posts is a duplicate round here: the drift gate cannot recognise it, and round 1 is left open behind it'
      );

      // And the key the first post carried still works once it HAS landed: same call, same
      // bytes on disk, so the daemon answers it as the retry it is rather than minting a
      // second round. (This is the path the join above cannot cover — the post is over.)
      writeFileSync(stagePath, page('ARTIFACT_V1'), 'utf8');
      const late = await withTimeout(driftClient.request('tools/call', {
        name: 'ask', arguments: ask,
      }), 15000, 'the late retry must return');
      assert.equal(late.result.round, 1, 'still round 1: the first post carried a key the daemon can recognise it by');
      const afterLate = JSON.parse(readFileSync(path.join(home, 'boards', `${boardId}.json`), 'utf8'));
      assert.equal(afterLate.rounds.length, 1, 'and no round was added');
    } finally {
      driftClient.close();
      proxy.close();
    }
  });

  // --- a stringized boolean is refused, never read as truthy -----------------
  // `wait` and `fresh` are booleans in the schema, but nothing enforces a caller's types
  // and a model that emits the string 'false' reads as TRUE to a bare truthiness test. On
  // `fresh` that abandons every round still open on the live board: the reviewer's
  // question closed under them, mid-answer, and a second board minted in its place.

  await check('a stringized fresh:\'false\' / wait:\'true\' is refused, not read as true', async () => {
    const knownIds = listBoardIds(home);
    const stringClient = spawnShim(baseEnv);
    const readBoardFile = id => JSON.parse(readFileSync(path.join(home, 'boards', `${id}.json`), 'utf8'));
    try {
      const live = stringClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Live board', blocks: [QUESTION] }, _meta: { progressToken: 'string-live' },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await sleep(150); // the board is fully written before anything is compared against it
      const before = readBoardFile(boardId);

      const refused = await withTimeout(stringClient.request('tools/call', {
        // Content only, so that a shim which reads the string as TRUE gets all the way to
        // a posted round and fails the assertions below on what it DID, rather than
        // blocking on a board it should never have minted and failing on a deadline.
        name: 'ask', arguments: { title: 'Stringized flag', blocks: [NOTE], fresh: 'false' },
      }), 8000, 'a refused ask must return at once');
      assert.equal(refused.result.isError, true, 'a string is not a boolean: refuse it');
      assert.match(refused.result.content[0].text, /"fresh"/, 'name the argument that is wrong');
      assert.match(refused.result.content[0].text, /boolean/i, 'and what it should have been');

      // The same rule on the same trust boundary for `wait`, which the acceptance names
      // beside `fresh`: a string there blocks a round that has nothing to wait for.
      const refusedWait = await withTimeout(stringClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Stringized wait', blocks: [NOTE], wait: 'true' },
      }), 8000, 'a refused ask must return at once');
      assert.equal(refusedWait.result.isError, true, 'a string is not a boolean here either');
      assert.match(refusedWait.result.content[0].text, /"wait"/, 'name the argument that is wrong');

      assert.deepEqual(
        [...listBoardIds(home)].filter(id => !knownIds.has(id)), [boardId],
        'a refused ask must not mint a board'
      );
      const stored = readBoardFile(boardId);
      assert.equal(stored.rounds[0].status, 'open', 'and must not close the round the reviewer is looking at');
      assert.equal(stored.rounds.length, before.rounds.length, 'nor add a round');
      assert.equal(stored.blocks.length, before.blocks.length, 'nor append its blocks to the round the reviewer is reading');

      // The proof the live call was never abandoned: it is still waiting, and the
      // reviewer's answer still reaches it.
      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'still mine' }] });
      const liveRes = await withTimeout(live, 8000, 'the live call must still be waiting for its reviewer');
      assert.equal(liveRes.result.status, 'submitted', 'the round a string flag would have abandoned still answers its own call');
      assert.equal(liveRes.result.answers[0].note, 'still mine');
    } finally {
      stringClient.close();
    }
  });

  // --- a board abandoned under a blocked ask ends AS abandoned ---------------
  // The daemon answers a blocked /wait at once when the board is abandoned under it, with
  // its own terminal status. With no branch for it the shim fell through to "Board
  // submitted." and read a round of synthesised `unanswered` back as the reviewer's
  // decisions: honest data under false prose, and the prose is the half the agent reads.

  await check('a board abandoned under a blocked ask returns as abandoned, not as a submit', async () => {
    const knownIds = listBoardIds(home);
    const abandonClient = spawnShim(baseEnv);
    try {
      const call = abandonClient.request('tools/call', {
        name: 'ask',
        arguments: { title: 'Abandoned under the call', blocks: [QUESTION] },
        _meta: { progressToken: 'tok-abandon' },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await sleep(250); // the wait GET is established and held open

      const abandoned = await fetch(`${base}/api/board/${boardId}/abandon`, { method: 'POST', headers: writeHeaders() });
      assert.equal(abandoned.status, 200, `the abandon must land (got ${abandoned.status})`);

      const done = await withTimeout(call, 8000, 'an abandoned board must release the blocked ask promptly');
      const result = done.result;
      assert.equal(result.isError, false, 'an abandoned board is an outcome, not a failure');
      assert.equal(result.status, 'abandoned', 'the status the daemon sent must survive to the agent');
      const text = result.content[0].text;
      assert.match(text, /abandoned/i, 'the text the agent actually reads must name what happened');
      assert.doesNotMatch(text, /submitted/i, 'nobody submitted anything: that word here reports a decision that was never made');
      assert.doesNotMatch(text, /no response needed/i, 'a round closed under the caller is not a round with nothing to answer');
      assert.doesNotMatch(text, /reopen it/i, 'and it never reopens, so the timeout advice would send the agent nowhere');
    } finally {
      abandonClient.close();
    }
  });

  // --- and a status this shim has never heard of is named, not dressed up -----
  // `abandoned` arrived as a daemon-side addition to a shim that had no branch for it, and
  // fell through to "Board submitted." with a round of synthesised `unanswered` reported
  // as the reviewer's decisions. Fixing that one status leaves the next one to repeat it,
  // so the fall-through itself is the defect: the submitted prose belongs to `submitted`.

  await check('a packet status this shim does not know is reported by name, not as a submit', async () => {
    const unknown = await startHostileDaemon({ boardId: 'b_unknown_status', url: `${base}/b/b_unknown_status`, waitStatus: 'quantum' });
    const unknownClient = spawnShim({ ...baseEnv, CLAUDE_BOARD_PORT: String(unknown.port) });
    try {
      const res = await withTimeout(unknownClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Unknown status', blocks: [QUESTION] },
      }), 8000, 'an unknown status must still end the call');
      const text = res.result.content[0].text;
      assert.equal(res.result.status, 'quantum', 'the packet is relayed as it arrived: the data was never the problem');
      assert.match(text, /quantum/, 'the prose has to name the status it could not interpret');
      assert.doesNotMatch(text, /^Board submitted\./, 'an unrecognised ending is not a submit');
      assert.match(text, /not a decision|do not read/i, 'and the answers below it must be disowned, not presented as the reviewer\'s');
    } finally {
      unknownClient.close();
      unknown.close();
    }
  });

  // --- session continuity: the second ask pushes ROUND 2 into the same board -

  await check('a second ask on the same connection pushes round 2 into the same board', async () => {
    const knownIds = listBoardIds(home);
    const seqClient = spawnShim(baseEnv);
    try {
      const first = seqClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Round one', blocks: [QUESTION] },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }] });
      const firstRes = await withTimeout(first, 8000, 'first ask must return');
      assert.equal(firstRes.result.round, 1);

      const afterFirst = listBoardIds(home);
      const second = seqClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Round two', blocks: [QUESTION] },
      });
      await sleep(400);
      assert.deepEqual(
        [...listBoardIds(home)].filter(id => !afterFirst.has(id)), [],
        'a later ask must push a round into the live board, never mint a second one'
      );

      await submitBoard(base, boardId, { answers: [{ id: 'q2', status: 'answered', choice: 'No', note: 'round two' }] });
      const secondRes = await withTimeout(second, 8000, 'second ask must return');
      assert.equal(secondRes.result.board, boardId, 'the same thread, by board id');
      assert.equal(secondRes.result.round, 2, 'the second ask must be round 2');
      assert.equal(secondRes.result.thread, firstRes.result.thread, 'one thread per shim process');
    } finally {
      seqClient.close();
    }
  });

  // --- a daemon 4xx is a rejection, not a dead service ----------------------

  await check('a daemon refusal reports the reason without a revive command', async () => {
    const before = countBoardFiles(home);
    const badClient = spawnShim(baseEnv);
    try {
      const res = await withTimeout(badClient.request('tools/call', {
        name: 'ask',
        arguments: { title: 'Typo check', blocks: [{ kind: 'markdwon', text: '# oops' }] },
      }), 8000, 'a rejected board must return promptly');
      const result = res.result;
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /rejected/i, 'the daemon answered: say so');
      assert.match(result.content[0].text, /markdwon/, 'relay the daemon\'s own reason verbatim');
      assert.doesNotMatch(
        result.content[0].text, /launchctl kickstart/,
        'a healthy daemon that refused a bad board must not be reported as needing a restart'
      );
      assert.doesNotMatch(result.content[0].text, /not reachable/i);
      assert.equal(countBoardFiles(home), before, 'a rejected board writes nothing');
    } finally {
      badClient.close();
    }
  });

  // --- the wait reattaches across a real daemon restart ---------------------
  // A restart is routine: KeepAlive restarts on crash, ./install.sh boots the job out
  // and back in to take an update, and the revive command in every unreachable message
  // is a kickstart. The board stays open on disk
  // throughout, so the wait must reattach by board id rather than report a failure
  // and strand whatever the reviewer submits next.

  await check('the blocking wait reattaches after the daemon restarts underneath it', async () => {
    const dhome = tempHome('restart');
    const dport = await freePort();
    let daemon = await startDaemonProcess(dport, dhome);
    const dbase = `http://127.0.0.1:${dport}`;
    const restartClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_HOME: dhome,
      CLAUDE_BOARD_PORT: String(dport),
      CLAUDE_BOARD_RETRY_MS: '50',
      CLAUDE_BOARD_RETRY_MAX_MS: '200',
    });
    try {
      const call = restartClient.request('tools/call', {
        name: 'ask',
        arguments: { title: 'Restart check', blocks: [QUESTION] },
        _meta: { progressToken: 'tok-restart' },
      });
      const boardId = await waitForNewBoardFile(dhome, new Set());
      await sleep(250); // the wait GET is established and held open

      const ended = await terminateDaemon(daemon, 6000);
      assert.ok(ended, 'the daemon must exit on SIGTERM even with a wait held open');
      daemon = await startDaemonProcess(dport, dhome);

      // The reviewer submits after the restart, on a board that never stopped
      // being open. The call must still return the packet, normally.
      await submitBoard(dbase, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'after restart' }] }, dhome);

      const res = await withTimeout(call, 20000, 'the reattached wait must return the packet');
      const result = res.result;
      assert.equal(result.isError, false, `a restart must not surface as a failure: ${result.content[0].text}`);
      assert.equal(result.status, 'submitted', 'the wait must resolve normally after reattaching');
      assert.equal(result.board, boardId);
      assert.equal(result.answers[0].note, 'after restart');
      assert.match(restartClient.stderr, /reattach/i, 'the reattach must be logged to stderr, not silent');
    } finally {
      restartClient.close();
      try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // --- the daemon exits promptly on SIGTERM with an SSE stream open ---------
  // server.close() waits for open connections and an SSE stream never ends, so
  // without an explicit teardown launchd SIGKILLs after ExitTimeOut (~20s), which
  // is ~20s of total outage on every restart -- including a reload-on-change exit,
  // which sends itself a normal shutdown, not a signal -- and an unclean kill that
  // can land mid-write.

  await check('the daemon exits on SIGTERM while a board tab holds an SSE stream open', async () => {
    const dhome = tempHome('shutdown');
    const dport = await freePort();
    const daemon = await startDaemonProcess(dport, dhome);
    let stream;
    try {
      const posted = await fetch(`http://127.0.0.1:${dport}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ title: 'Shutdown check', blocks: [QUESTION] }),
      }).then(r => r.json());

      stream = await openSseStream(dport, posted.boardId); // exactly what an open tab holds

      const ended = await terminateDaemon(daemon, 8000);
      assert.ok(ended, 'the daemon must not have to be SIGKILLed: an open SSE stream never ends on its own');
      assert.ok(ended.elapsed < 5000, `shutdown must be prompt, took ${ended.elapsed}ms`);
      assert.equal(ended.signal, null, `the daemon must exit on its own, not by signal (got ${ended.signal})`);
      assert.equal(ended.code, 0, 'a clean exit code');
    } finally {
      try { stream?.req.destroy(); } catch { /* already gone */ }
      try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // --- a later round never opens a tab, connected or not (ADR 55) -----------
  // The forced reopen is deleted: the daemon announces a stranded round on its own
  // now (test/check-stranded.mjs), so the shim's only remaining tab-opening occasion
  // is a thread's first board (covered elsewhere in this file, e.g. "CLAUDE_BOARD_OPEN_CMD
  // alone satisfies..." above). This proves the negative even with no client connected
  // to the board at all -- the one case the old reopen would have fired on.

  await check('a later round never opens a tab, even with no client connected to the board', async () => {
    const dir = tempHome('no-reopen');
    const recorder = makeOpenRecorder(dir);
    const knownIds = listBoardIds(home);
    const openClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_NO_OPEN: undefined, // let it "open" for real, into the recorder
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const first = openClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Round 1', blocks: [QUESTION] },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      assert.equal((await recorder.waitForOpens(1, 10_000)).length, 1, 'the first board always opens the tab');
      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }] });
      await withTimeout(first, 8000, 'round 1 must return');

      // No client has ever connected to this board -- the old reopen's clearest
      // trigger case -- and round 2 must still not open a second tab.
      const second = openClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Round 2', blocks: [QUESTION] },
      });
      await sleep(500);
      assert.equal(recorder.opened().length, 1, 'a later round must never open a tab, connected or not');
      await submitBoard(base, boardId, { answers: [{ id: 'q2', status: 'answered', choice: 'Yes', note: '' }] });
      await withTimeout(second, 8000, 'round 2 must return');
    } finally {
      openClient.close();
    }
  });

  // --- a fresh board defers to an open tab (ADR 91) ------------------------
  // Two halves of one claim, and the first is the second's control: the same call, the
  // same recorded opener, differing only in whether a real event stream stands open
  // somewhere on the daemon. Suppression is the DAEMON's decision (it is the only process
  // that can see every board on the machine), so the only faithful stand-in for "a
  // reviewer already has a board open" is a real `/api/board/:id/events` subscription --
  // what an open tab holds -- and not a flag this check sets for itself.
  //
  // Each half gets its own in-process daemon, on its own home and port. The shared one
  // above serves a dozen later checks that expect a tab to open, and a Watcher standing on
  // it would silently suppress every one of them.

  await check('a fresh board with no board tab connected anywhere opens its tab, exactly as before', async () => {
    const dhome = tempHome('open-unwatched');
    const local = await startServer({ home: dhome, port: 0 });
    const recorder = makeOpenRecorder(dhome);
    const client = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_HOME: dhome,
      CLAUDE_BOARD_PORT: String(local.port),
      CLAUDE_BOARD_NO_OPEN: undefined, // let it "open" for real, into the recorder
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      // Content-only, so `ask` returns the instant the post lands (QUIRKS.md: a fixture
      // with no question block never reaches /wait) -- what is being counted here is tabs,
      // not packets.
      await withTimeout(client.request('tools/call', {
        name: 'ask', arguments: { title: 'Fresh and unwatched', blocks: [{ kind: 'markdown', text: 'nothing asked' }] },
      }), 10_000, 'the ask must return');
      assert.equal((await recorder.waitForOpens(1, 10_000)).length, 1,
        'nothing is watching any board on this daemon, so the first board opens its tab as it always has');
      await sleep(300);
      assert.equal(recorder.opened().length, 1, 'and exactly one tab, not two');
    } finally {
      client.close();
      stopLocalServer(local.server);
    }
  });

  await check('a fresh board opens no tab while ANOTHER board on the same daemon has a Watcher', async () => {
    const dhome = tempHome('open-watched');
    const local = await startServer({ home: dhome, port: 0 });
    const recorder = makeOpenRecorder(dhome);
    // Somebody else's board, in somebody else's thread, with a real stream on it. Posted
    // straight over HTTP rather than through a second shim: what suppresses is the
    // Watcher, and this board only has to be something for one to be watching.
    const watched = await fetch(`http://127.0.0.1:${local.port}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Already open', blocks: [QUESTION] }),
    }).then(r => r.json());
    const tab = await openSseStream(local.port, watched.boardId);
    const client = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_HOME: dhome,
      CLAUDE_BOARD_PORT: String(local.port),
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const res = await withTimeout(client.request('tools/call', {
        name: 'ask', arguments: { title: 'Fresh but deferring', blocks: [{ kind: 'markdown', text: 'nothing asked' }] },
      }), 10_000, 'the ask must return');
      assert.equal(res.result.isError, false, 'suppressing the tab must not turn the call into a failure');
      // The opener is spawned detached and this check never learns whether a browser
      // appeared, so "no tab" can only be counted after giving one time to be recorded.
      await sleep(500);
      assert.deepEqual(recorder.opened(), [],
        'any board, any project, focused or not: a tab standing anywhere is what this board defers to');
    } finally {
      client.close();
      tab.req.destroy();
      stopLocalServer(local.server);
    }
  });

  await check('a fresh board opens no tab despite the round-banner switch being off', async () => {
    const dhome = tempHome('open-banners-off');
    // The reviewer's own switch (the index settings panel) silences ordinary round
    // Banners; it does not un-suppress the open. The Banner suppression owes ignores the
    // switch (src/stranded.mjs), so the shim holding the tab back here can never leave
    // the board unannounced -- and the reviewer who switched Banners off does not buy
    // back the focus theft ADR.md entry 91 removes.
    writeFileSync(path.join(dhome, 'pomodoro.json'), JSON.stringify({ settings: { notifyRounds: false } }));
    const local = await startServer({ home: dhome, port: 0 });
    const recorder = makeOpenRecorder(dhome);
    const watched = await fetch(`http://127.0.0.1:${local.port}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Already open', blocks: [QUESTION] }),
    }).then(r => r.json());
    const tab = await openSseStream(local.port, watched.boardId);
    const client = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_HOME: dhome,
      CLAUDE_BOARD_PORT: String(local.port),
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      await withTimeout(client.request('tools/call', {
        name: 'ask', arguments: { title: 'Fresh, banners off', blocks: [{ kind: 'markdown', text: 'nothing asked' }] },
      }), 10_000, 'the ask must return');
      await sleep(500);
      assert.equal(recorder.opened().length, 0,
        'the Watcher suppresses the open with or without the Banner switch');
    } finally {
      client.close();
      tab.req.destroy();
      stopLocalServer(local.server);
    }
  });

  // --- comments have to survive on the channel no client can drop ----------
  // A client is free to keep only `content`, `isError` and `structuredContent` and
  // drop unrecognised top-level keys. If the text summary says "2 comment(s)." the
  // whole comment feature conveys nothing at all — silently — even though
  // commands/grill.md tells the agent to address comments as their own input.

  await check('comments reach the agent through structuredContent AND the text summary', async () => {
    const knownIds = listBoardIds(home);
    const commentClient = spawnShim(baseEnv);
    try {
      const call = commentClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'Comment check',
          blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  Start --> End' }, QUESTION],
        },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await submitBoard(base, boardId, {
        answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }],
        comments: [
          { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'End' }, text: 'this heading overstates it' },
          { blockId: 'q1', anchor: { kind: 'block' }, text: 'ask this differently' },
        ],
      });

      const res = await withTimeout(call, 8000, 'the comment board must return');
      const result = res.result;

      assert.ok(result.structuredContent, 'the packet must also be nested under structuredContent');
      assert.equal(result.structuredContent.board, boardId);
      assert.equal(result.structuredContent.comments.length, 2);
      assert.equal(result.structuredContent.comments[0].blockId, 'm1');
      assert.equal(result.structuredContent.comments[0].text, 'this heading overstates it');

      // The guaranteed channel, on its own, must name each comment's block, its
      // anchor and its words.
      const text = result.content[0].text;
      assert.match(text, /m1/, 'the text must name the commented block');
      assert.match(text, /mermaid:End/, 'the text must name the anchor');
      assert.match(text, /this heading overstates it/, 'the text must carry the comment itself');
      assert.match(text, /q1/);
      assert.match(text, /ask this differently/);
    } finally {
      commentClient.close();
    }
  });

  // --- formatAnchor (bin/mcp.mjs) has to name the element, not just the ref -----
  //
  // src/render.mjs's anchorTag prefers a dom/mermaid anchor's hint over its bare
  // ref; formatAnchor used to agree for `dom` but not `mermaid` (it rendered
  // `mermaid:${ref}` unconditionally), so the ONE channel guaranteed to survive
  // the MCP client (this file's own doc comment on packetResult) told the agent
  // "mermaid:B" instead of "End" for a diagram comment. Comments are
  // posted straight through submitBoard with hand-built anchors -- each one a
  // shape `applySubmit`'s own `sanitizeAnchor` accepts as-is (nothing
  // else is accepted) -- so
  // every kind, hint-present/absent and resolved/lost combination is exercised
  // directly, without depending on the click-to-anchor client wiring covered
  // elsewhere.
  await check('formatAnchor names the element for every anchor kind, hint or no hint, resolved or lost', async () => {
    const knownIds = listBoardIds(home);
    const anchorClient = spawnShim(baseEnv);
    try {
      const call = anchorClient.request('tools/call', {
        name: 'ask',
        arguments: {
          title: 'formatAnchor check',
          blocks: [
            { kind: 'markdown', text: '# Notes\n\nsome context' }, // renders, but is not commentable (ADR.md entry 28)
            QUESTION,
            { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
            { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
          ],
        },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      await submitBoard(base, boardId, {
        answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }],
        comments: [
          // block: no ref/hint at all.
          { blockId: 'q1', anchor: { kind: 'block' }, text: 'whole-block comment' },
          // dom: ref + hint, resolves against the html block's live markup.
          { blockId: 'h1', anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'dom comment with hint' },
          // dom: ref only, no hint — degrades to the bare ref either way.
          { blockId: 'h1', anchor: { kind: 'dom', ref: '1.1' }, text: 'dom comment without hint' },
          // mermaid: ref + hint — this is the one that regressed.
          { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'B', hint: 'End' }, text: 'mermaid comment with hint' },
          // mermaid: ref only (the older shape, no hint/domRef minted) — must
          // degrade to the bare ref, not crash on the missing field.
          { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'B' }, text: 'mermaid comment without hint' },
          // dom, lost: a ref that resolves against nothing in the html block.
          { blockId: 'h1', anchor: { kind: 'dom', ref: '9.9', hint: 'Never there' }, text: 'lost dom comment' },
        ],
      });

      const res = await withTimeout(call, 8000, 'the formatAnchor board must return');
      const text = res.result.content[0].text;

      assert.match(text, /whole-block comment/);
      assert.match(text, /\bblock\b.*whole-block comment/, 'kind "block" must format as "whole block"');

      assert.match(text, /dom:1\.1 \("Send"\).*dom comment with hint/, 'dom prefers the hint alongside its ref');
      assert.match(text, /dom:1\.1(?! \(").*dom comment without hint/, 'dom with no hint degrades to the bare ref');

      assert.match(text, /mermaid:B \("End"\).*mermaid comment with hint/, 'mermaid must prefer the hint, like the dom case and like anchorTag in src/render.mjs');
      assert.match(text, /mermaid:B(?! \(").*mermaid comment without hint/, 'a pre-ticket-05 mermaid anchor with no hint must degrade to the bare ref, not drop the line or throw');

      assert.match(text, /dom:9\.9 \("Never there"\).*lost dom comment/, 'a lost anchor still names what it lost via formatAnchor');
      assert.match(text, /lost dom comment.*\[anchor no longer resolves\]|\[anchor no longer resolves\].*lost dom comment/s, 'a lost anchor is flagged as unresolved');
    } finally {
      anchorClient.close();
    }
  });

  // --- a cancelled call stops waiting, polling and notifying ----------------

  await check('notifications/cancelled stops the wait, the progress and the response', async () => {
    const knownIds = listBoardIds(home);
    const cancelClient = spawnShim(baseEnv);
    try {
      const { id, promise } = cancelClient.requestWithId('tools/call', {
        name: 'ask',
        arguments: { title: 'Cancel check', blocks: [QUESTION] },
        _meta: { progressToken: 'tok-cancel' },
      });
      promise.catch(() => { /* a cancelled call is never answered; nothing awaits this */ });

      await waitForNewBoardFile(home, knownIds);
      await waitForProgress(cancelClient, 'tok-cancel', 2);

      cancelClient.notify('notifications/cancelled', { requestId: id, reason: 'user pressed escape' });
      await sleep(300);
      const atCancel = progressCount(cancelClient, 'tok-cancel');
      await sleep(500); // several more cadences at CLAUDE_BOARD_PROGRESS_MS=80

      assert.equal(
        progressCount(cancelClient, 'tok-cancel'), atCancel,
        'progress notifications must stop when the call is cancelled, not run for the full wall clock'
      );
      assert.equal(cancelClient.answered(id), false, 'MCP: a cancelled request gets no response');
      assert.match(cancelClient.stderr, /cancel/i, 'the cancellation must be acted on, not silently ignored');

      // The shim itself is unharmed and still serving.
      const ping = await withTimeout(cancelClient.request('ping', {}), 3000, 'the shim must survive a cancellation');
      assert.ok(ping.result, 'the shim must still answer after a cancelled call');
    } finally {
      cancelClient.close();
    }
  });

  // --- the tab lands already authorized ------------------------------------
  // Reads are gated, so the URL the shim hands `open` cannot be the
  // board URL: a browser with no cookie would land on the refusal page instead of the
  // board. The shim is the only participant holding the secret, so it is the one that
  // asks for the handoff.

  await check('the first board opens on a one-time handoff that lands the browser already authorized', async () => {
    const dir = tempHome('handoff');
    const recorder = makeOpenRecorder(dir);
    const knownIds = listBoardIds(home);
    const client = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const call = client.request('tools/call', {
        name: 'ask', arguments: { title: 'Handoff open', blocks: [QUESTION] },
      });
      const boardId = await waitForNewBoardFile(home, knownIds);
      // A longer budget than the 3s default: opening a tab now costs one extra
      // round-trip (the handoff mint) on a single-threaded daemon that, by this point in
      // the file, is also servicing several held-open /wait polls.
      const opened = await recorder.waitForOpens(1, 10_000);
      assert.equal(opened.length, 1, 'the first board opens exactly one tab');
      assert.match(opened[0], new RegExp(`^${base}/auth/[0-9a-f]{64}$`), 'and it opens on a handoff, not on the board URL');

      // Follow it exactly as the browser does: one GET, no redirect following.
      const landed = await rawGet(opened[0]);
      assert.equal(landed.status, 302, 'the handoff redirects rather than rendering');
      assert.equal(landed.headers.location, `/b/${boardId}`, 'onto this call\'s board, at a URL carrying no credential');
      const cookie = [].concat(landed.headers['set-cookie'] || []).join('; ').split(';')[0];
      assert.match(cookie, /^cb_session=[0-9a-f]{64}$/, 'having been handed the session cookie on the way');

      const page = await rawGet(`${base}/b/${boardId}`, { cookie });
      assert.equal(page.status, 200, 'the bookmarkable URL renders for the authorized browser');

      const replay = await rawGet(opened[0]);
      assert.equal(replay.status, 401, 'and the handoff is dead the moment the browser used it');

      await submitBoard(base, boardId, { answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }] });
      await withTimeout(call, 8000, 'the ask must return');
    } finally {
      client.close();
    }
  });

  await check('a daemon that will not mint a handoff makes the shim name the recovery command rather than open a tab that fails silently', async () => {
    // Degrading honestly: the tab still opens (a browser authorized on some earlier day
    // holds a long-lived cookie and is fine), but a browser that is NOT authorized will
    // land on the refusal page — so the session is told, in the same words the refusal
    // page uses, what to run. A message that named the wrong fix here costs the reviewer
    // the whole session.
    const dir = tempHome('handoff-refused');
    const recorder = makeOpenRecorder(dir);
    const hostile = await startHostileDaemon({ boardId: 'b_nohandoff', url: `http://127.0.0.1:1/b/x` });
    const client = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(hostile.port),
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      await withTimeout(client.request('tools/call', {
        name: 'ask', arguments: { title: 'No handoff', blocks: [QUESTION] },
      }), 8000, 'the call must still return');

      const opened = await recorder.waitForOpens(1, 10_000);
      assert.equal(opened[0], `http://127.0.0.1:${hostile.port}/b/b_nohandoff`, 'it falls back to the board URL rather than opening nothing');
      assert.ok(
        client.stderr.includes(recoveryCommand()),
        `the shim must print the exact recovery command (${recoveryCommand()}); got: ${client.stderr.slice(-400)}`
      );
      assert.match(client.stderr, /not authorized/i, 'and say what symptom it is the fix for');
    } finally {
      client.close();
      hostile.close();
    }
  });

  // --- `open` is never handed a peer-supplied string ------------------------
  // The daemon's `url` field is data from whatever answered on the port. During a
  // restart window that need not be the daemon, and `open` launches a GUI app with
  // no prompt. The URL to open is rebuilt locally from this process's own base URL.

  await check('the tab is opened on a locally built URL, never the daemon-supplied one', async () => {
    const dir = tempHome('hostile');
    const recorder = makeOpenRecorder(dir);
    const hostile = await startHostileDaemon({ boardId: 'b_hostile', url: '/Applications/Evil.app' });
    const hostileClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(hostile.port),
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const res = await withTimeout(hostileClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Hostile url', blocks: [QUESTION] },
      }), 8000, 'the hostile-daemon call must return');

      const opened = await recorder.waitForOpens(1);
      assert.equal(opened.length, 1, 'exactly one open');
      assert.equal(
        opened[0], `http://127.0.0.1:${hostile.port}/b/b_hostile`,
        'the opened URL must be rebuilt locally from the shim\'s own base URL'
      );
      assert.ok(!opened.some(u => u.includes('Evil.app')), 'a daemon-supplied path must never reach `open`');
      assert.ok(!String(res.result.url).includes('Evil.app'), 'nor be reported as the board URL');
    } finally {
      hostileClient.close();
      hostile.close();
    }
  });

  await check('a board id that is not a board id opens nothing at all', async () => {
    const dir = tempHome('hostile-id');
    const recorder = makeOpenRecorder(dir);
    const hostile = await startHostileDaemon({ boardId: '-a /Applications/Evil.app', url: 'http://127.0.0.1:1/b/x' });
    const hostileClient = spawnShim({
      ...baseEnv,
      CLAUDE_BOARD_PORT: String(hostile.port),
      CLAUDE_BOARD_NO_OPEN: undefined,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    });
    try {
      const res = await withTimeout(hostileClient.request('tools/call', {
        name: 'ask', arguments: { title: 'Hostile id', blocks: [QUESTION] },
      }), 8000, 'the hostile-id call must return');
      await sleep(300);
      assert.equal(recorder.opened().length, 0, 'nothing may be handed to `open`');
      assert.equal(res.result.isError, true, 'and the shim must say so rather than carry on');
    } finally {
      hostileClient.close();
      hostile.close();
    }
  });

  // --- a second daemon on a taken port fails by name, not by stack trace ----

  await check('a daemon that cannot bind reports EADDRINUSE plainly and exits', async () => {
    const dhome = tempHome('addrinuse');
    const dport = await freePort();
    const first = await startDaemonProcess(dport, dhome);
    try {
      const second = spawn(process.execPath, [daemonBin], {
        env: { ...process.env, CLAUDE_BOARD_HOME: dhome, CLAUDE_BOARD_PORT: String(dport) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      second.stderr.on('data', c => { stderr += c.toString(); });
      const exit = await withTimeout(
        new Promise(resolve => second.on('exit', (code, signal) => resolve({ code, signal }))),
        8000, 'the second daemon must exit rather than hang'
      );

      assert.equal(exit.code, 1, 'a daemon that cannot serve must exit non-zero');
      assert.match(stderr, /cannot start/i, 'it must say, in words, that it could not start');
      assert.match(stderr, /EADDRINUSE/, 'and name the actual cause');
      assert.match(stderr, new RegExp(String(dport)), 'and the port');
      assert.doesNotMatch(
        stderr, /node:internal|ERR_UNHANDLED_REJECTION|at async/,
        'an unhandled rejection stack trace is not a report; a crash-looping service needs the one-line cause'
      );
    } finally {
      try { first.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // --- a partial install fails the caller instead of hanging it -------------
  // The other side of this stdio seam: the product's own spawn of the shim
  // (src/prose-check.mjs `getLiveTools`, which any installed clone can be asked for). A
  // shim that is missing or cannot run answers nothing, and a client that waits for an
  // answer with no deadline and no exit listener waits forever — no output, no exit code,
  // nothing to read. That hang is what stranded a load test of this very suite.

  await check('a missing or broken shim fails the caller by name instead of hanging', async () => {
    const dir = tempHome('partial-install');

    const absent = path.join(dir, 'bin', 'mcp.mjs');
    await assert.rejects(
      withTimeout(getLiveTools({ mcpPath: absent }), 6000, 'a missing shim must fail, not hang'),
      /no claude-board shim at .*mcp\.mjs/,
      'name the path that is not there and the install that is incomplete'
    );

    // Present but unrunnable — the other half of a partial install. `node` itself exists,
    // so the spawn succeeds and the failure is an exit code with a stack on stderr.
    const broken = path.join(dir, 'broken-mcp.mjs');
    writeFileSync(broken, "throw new Error('half-installed shim');\n");
    await assert.rejects(
      withTimeout(getLiveTools({ mcpPath: broken }), 8000, 'a broken shim must fail, not hang'),
      err => {
        assert.match(err.message, /exited/, 'a child that dies without answering must reject the call it left pending');
        assert.match(err.message, /half-installed shim/, 'and carry its stderr: that is the only statement of the cause');
        return true;
      }
    );
  });

  await check('a shim that starts but never answers fails on a deadline', async () => {
    const dir = tempHome('silent-shim');
    const silent = path.join(dir, 'silent-mcp.mjs');
    // Starts, holds stdin open, answers nothing: a wedged shim is the one failure no exit
    // code reports, so only a deadline can end it.
    writeFileSync(silent, 'process.stdin.resume();\n');

    const started = Date.now();
    await assert.rejects(
      withTimeout(getLiveTools({ mcpPath: silent, timeoutMs: 400 }), 6000, 'a silent shim must fail on its deadline'),
      /did not answer initialize within 400ms/,
      'the deadline must name the call it gave up on'
    );
    assert.ok(Date.now() - started < 5000, `the deadline must actually fire, took ${Date.now() - started}ms`);
  });

  // --- the suite runner enforces its own deadline --------------------------
  // A check that hangs must be a named failure, not a job that never ends — and it
  // must not orphan the shims and daemons it spawned.

  await check('test/run.mjs kills a hung check and its children instead of hanging', async () => {
    const dir = tempHome('runner');
    const hangCheck = path.join(dir, 'hang-check.mjs');
    const pidFile = path.join(dir, 'grandchild.pid');
    writeFileSync(hangCheck, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);', // the hang itself: exactly what an unanswerable wait looks like
    ].join('\n'));

    const result = await withTimeout(runCheck(hangCheck, 700), 8000, 'runCheck must enforce its own deadline');
    assert.equal(result.timedOut, true, 'a check past its deadline must be reported as timed out');
    assert.ok(result.elapsed < 5000, `the deadline must actually fire, took ${result.elapsed}ms`);

    await sleep(300);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(
      () => process.kill(grandchild, 0),
      /ESRCH/,
      'a timed-out check must take its child processes (shims, daemons, wait loops) with it'
    );
  });

  // test/run.mjs runs checks concurrently, so it reads each one's output through a pipe
  // and replays it in one piece rather than letting four checks interleave their lines
  // into an unattributable transcript. A silent hole in that path would cost the suite
  // its entire failure diagnosis while every check still passed, which is exactly the
  // kind of green nothing this file exists to refuse.
  await check('runCheck({ capture: true }) returns the check\'s output instead of dropping it', async () => {
    const dir = tempHome('runner-capture');
    const noisy = path.join(dir, 'noisy-check.mjs');
    // The last line is written immediately before exit: that is the byte 'exit' loses and
    // 'close' waits for, and on a real failing check it is the line naming the failure.
    writeFileSync(noisy, [
      "process.stdout.write('ok - to stdout\\n');",
      "process.stderr.write('diagnostic - to stderr\\n');",
      "process.stdout.write('the-last-line-before-exit\\n');",
    ].join('\n'));

    const result = await withTimeout(runCheck(noisy, 8000, { capture: true }), 12_000, 'a capturing run must still finish');
    assert.equal(result.code, 0);
    assert.match(result.output, /ok - to stdout/, 'stdout must survive the pipe');
    // Deliberately not the word "FAILED": the non-capture assertion below streams this
    // fixture straight to the terminal, and a suite transcript should not contain a
    // failure word that belongs to no failure.
    assert.match(result.output, /diagnostic - to stderr/, 'stderr must too — it carries the assertion message');
    assert.match(result.output, /the-last-line-before-exit/, 'output written just before exit must not be lost to the exit/close race');

    // ...and the default is still live streaming, so running one check alone is unchanged.
    const streamed = await withTimeout(runCheck(noisy, 8000), 12_000, 'an inheriting run must still finish');
    assert.equal(streamed.code, 0);
    assert.equal(streamed.output, '', 'without capture nothing is buffered; the check owns the terminal');
  });

  await check('an absent CLAUDE_CODE_ENTRYPOINT is refused (fails closed)', async () => {
    const before = countBoardFiles(home);
    const noEntrypointClient = spawnShim({ ...baseEnv, CLAUDE_CODE_ENTRYPOINT: undefined });
    const res = await noEntrypointClient.request('tools/call', {
      name: 'ask',
      arguments: { title: 'No entrypoint check', blocks: [{ kind: 'markdown', text: '# x' }] },
    });
    const result = res.result;
    assert.equal(result.isError, true);
    assert.equal(countBoardFiles(home), before);

    noEntrypointClient.close();
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (server) server.close();
    for (const child of spawnedDaemons) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(home, { recursive: true, force: true });
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall mcp checks ok');
  });
