// test/support.mjs: the harness the check files share. The `check` runner and its trailer,
// the board and index page loaders, and the daemon, stub and launcher helpers used to be
// copied from file to file, and the copies drifted. They live here now. Each check file stays
// runnable alone (`node test/check-<name>.mjs`); this module is only ever imported.
//
// What importing it costs: node built-ins, plus src/secret.mjs (built-ins only), so a file
// that needs nothing but `check` loads nothing else. Everything that drives a page
// (test/dom-stand-in.mjs, src/ui.mjs, src/theme.mjs, src/styles.mjs, src/indexpage.mjs) loads
// on the first `await pageHarness()`, and the page helpers come back from that call.
//
// Two traps this module keeps shut for every caller. Each `new Function` declares
// 'EventSource' and passes it only when a caller supplies a stand-in (QUIRKS.md "A `new
// Function` harness inherits the host's globals"). Nothing here sleeps to let a page talk to a
// daemon: `loadIndexAgainstDaemon` settles through `fetchSettler` (QUIRKS.md "A fixed flush
// sleep is a bet on node's loopback latency"). No port is fixed, and every write lands under a
// directory the caller owns (test/run.mjs's header).

import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';

// --- the check runner ---------------------------------------------------------------------

let failures = 0;
let format = 'tap';
let finished = false;
// Each async check still in flight, mapped to its name.
const pending = new Map();

// The net under a file that never reaches `finish`: a check whose promise never settled (it
// awaited something nothing will ever resolve, and the event loop drained) is a failure, not
// a silent pass, and failures with no `finish` still exit 1. A file that counted its
// failures and exited 0 anyway once hid eight red checks from test/run.mjs.
process.on('exit', code => {
  if (finished) return;
  for (const name of pending.values()) {
    failures++;
    console.error(`FAIL - ${name} (never settled: the process exited with this check still awaiting)`);
  }
  if (failures && code === 0) {
    console.error(`\n${failures} check(s) failed, and the file exited without calling finish()`);
    process.exitCode = 1;
  }
});

/** `configure({ format })` picks how `check` prints. 'tap' (the default) is `ok - <name>`, or
 * `FAIL - <name>` and the error's stack; 'aligned' is `ok   <name>`, or `FAIL <name>` and the
 * error's message on an indented line (test/check-comments.mjs, test/check-skill-prose.mjs). */
export function configure({ format: chosen } = {}) {
  if (chosen) format = chosen;
}

function pass(name) {
  console.log(format === 'aligned' ? `ok   ${name}` : `ok - ${name}`);
}

/** `fail(name, err)` counts one failure that happened outside a check (a `main` that threw, a
 * file's own report path) and prints it the way a failed check prints. */
export function fail(name, err) {
  failures++;
  if (format === 'aligned') {
    console.error(`FAIL ${name}\n     ${err && err.message}`);
  } else {
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** `check(name, fn)` runs one check: a throw, or a rejection when `fn` is async, prints
 * `FAIL - <name>` and counts toward `finish`; otherwise it prints `ok - <name>`. A sync `fn`
 * reports before `check` returns. An async one reports when it settles, and `finish` waits for
 * it, so a check nobody awaited still counts. Returns a promise that settles once the check
 * has reported and never rejects. */
export function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    fail(name, err);
    return Promise.resolve();
  }
  if (result && typeof result.then === 'function') {
    const settled = Promise.resolve(result)
      .then(() => pass(name), err => fail(name, err))
      .finally(() => pending.delete(settled));
    pending.set(settled, name);
    return settled;
  }
  pass(name);
  return Promise.resolve();
}

/** `checkAsync` is `check` under its old name: `check` already awaits an async `fn`. */
export const checkAsync = check;

/** `failureCount()` is how many checks and `fail` calls have failed so far. */
export function failureCount() {
  return failures;
}

/** `finish(label, opts)` ends a check file. It waits for every check still in flight, then on
 * any failure prints `<lead><failText(n)>` to stderr and exits 1; otherwise it prints
 * `<okLead>all <label> checks ok` and lets the process end on its own (exit 0).
 * opts: `lead` ('\n'), `okLead` (defaults to `lead`), `failText` (n => `${n} check(s) failed`,
 * or null to exit 1 silently), `failStream` ('stderr', or 'stdout'). A null `label` prints no
 * ok line. */
export function finish(label, opts = {}) {
  if (pending.size) return Promise.allSettled([...pending.keys()]).then(() => finish(label, opts));
  finished = true;
  const { lead = '\n', okLead = lead, failText = n => `${n} check(s) failed`, failStream = 'stderr' } = opts;
  if (failures) {
    if (failText) (failStream === 'stdout' ? console.log : console.error)(`${lead}${failText(failures)}`);
    process.exit(1);
  }
  if (label != null) console.log(`${okLead}all ${label} checks ok`);
  return Promise.resolve();
}

/** `runMain(label, main, opts)` runs an async `main` and then `finish`. A throw out of `main`
 * counts as `FAIL - unexpected error`; `opts.cleanup` (sync or async) runs after `main` either
 * way, before the trailer. Every other option goes to `finish`. */
export async function runMain(label, main, { cleanup, ...finishOpts } = {}) {
  try {
    await main();
  } catch (err) {
    fail('unexpected error', err);
  }
  if (cleanup) {
    try {
      await cleanup();
    } catch (err) {
      fail('cleanup', err);
    }
  }
  return finish(label, finishOpts);
}

/** `skipFile(label, why)` skips a whole file whose tool is missing: it prints
 * `==> skipping <why>` and `all <label> checks ok (skipped)`, then exits 0. */
export function skipFile(label, why) {
  console.log(`==> skipping ${why}`);
  console.log(`all ${label} checks ok (skipped)`);
  process.exit(0);
}

// --- paths and processes ------------------------------------------------------------------

/** `repoRoot` is the absolute path of the repository checkout this module sits in. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `mcpBin` is the stdio shim, bin/mcp.mjs, by absolute path. */
export const mcpBin = path.join(repoRoot, 'bin', 'mcp.mjs');

/** `execFileAsync` is `promisify(execFile)`. Use it, never `execFileSync`, against a daemon in
 * this process (QUIRKS.md "`execFileSync` deadlocks against an in-process daemon"). */
export const execFileAsync = promisify(execFile);

/** `CC` is the C compiler the launcher checks build with: `$CLAUDE_BOARD_CC`, else `cc`. */
export const CC = process.env.CLAUDE_BOARD_CC || 'cc';

/** `haveCc()` is whether `CC` runs at all. */
export function haveCc() {
  return !spawnSync(CC, ['--version']).error;
}

/** `listFiles(dir)` is every file under `dir`, recursively, as absolute paths in directory
 * order. */
export function listFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFiles(full));
    else out.push(full);
  }
  return out;
}

/** `projectFor(workDir, name)` makes `<workDir>/<name>` (parents included) and returns it: a
 * project folder of the caller's own for a board to belong to. */
export function projectFor(workDir, name) {
  const dir = path.join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- waiting ------------------------------------------------------------------------------

/** `sleep(ms)` resolves after `ms` milliseconds. Use it for a real duration (a grace window, a
 * poll interval), never to wait for a page to finish talking to a daemon. */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** `flush(ticks = 40)` hops `ticks` macrotasks, so a stubbed engine's promise chain (a mermaid
 * stand-in's `run`) lands. It counts hops, not milliseconds; a page waiting on a real fetch
 * settles through `fetchSettler` instead. */
export function flush(ticks = 40) {
  return new Promise(resolve => {
    let n = 0;
    (function hop() {
      n++;
      if (n > ticks) { resolve(); return; }
      setTimeout(hop, 0);
    })();
  });
}

/** `waitFor(fn, opts)` polls `fn` (sync or async) until it returns something truthy and
 * returns that. When `opts.timeoutMs` (5000) runs out it returns null, or throws
 * `timed out waiting for <what>` if `opts.what` is given. `opts.intervalMs` (25) spaces the
 * polls. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, what } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) {
      if (what) throw new Error(`timed out waiting for ${what}`);
      return null;
    }
    await sleep(intervalMs);
  }
}

/** `waitForCount(read, n, opts)` polls `read()` (sync, returning an array) until it holds at
 * least `n` entries or `opts.timeoutMs` (3000) runs out, then returns one last `read()` either
 * way, so the caller asserts on what actually arrived. `opts.intervalMs` (20) spaces the
 * polls. */
export async function waitForCount(read, n, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (read().length >= n) break;
    await sleep(intervalMs);
  }
  return read();
}

/** `withTimeout(promise, ms, message)` races `promise` against a timer that rejects with
 * `new Error(message)` after `ms`. The timer is cleared once the race settles, and is unref'd
 * so it never holds the process open. */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** `withEnv(patch, fn)` sets each `process.env` key in `patch` (an undefined value deletes the
 * key), awaits `fn`, and puts every key back as it was, deleting the ones that were unset
 * before. Returns what `fn` returns. */
export async function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) {
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = String(patch[k]);
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- a daemon on loopback -----------------------------------------------------------------

/** `freePort()` binds port 0 on 127.0.0.1, reads the port the kernel picked, and releases it.
 * The port it resolves is closed by the time anyone reads it, so the same call also serves as
 * "a port nothing listens on". */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

/** `deadPid()` resolves a pid that belonged to a process that has already exited: a session
 * bound to it reads as gone, the way a crashed one does. */
export function deadPid() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('exit', () => resolve(child.pid));
  });
}

/** `secretHome(prefix, opts)` sets up a check's daemon home: a fresh `mkdtemp` directory under
 * the OS temp dir named from `prefix`, exported as `CLAUDE_BOARD_HOME` (unless
 * `opts.setHome` is false), with a `secret` file inside it holding `opts.secret`
 * ('a' x 64), exported as `CLAUDE_BOARD_SECRET_FILE`. Call it before starting a daemon: the
 * daemon reads both once, at startup. Returns `{ home, secret, secretFile }`. */
export function secretHome(prefix, { secret = 'a'.repeat(64), setHome = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  if (setHome) process.env.CLAUDE_BOARD_HOME = home;
  const secretFile = path.join(home, 'secret');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;
  return { home, secret, secretFile };
}

/** `secretFetch(secret, base = globalThis.fetch)` is a `fetch` that sends the secret header on
 * every call, so a check that is not about the credential reads through the gate (QUIRKS.md
 * "Every read is gated, so every HTTP check needs a credential"). A header the caller passes
 * still wins. Keep `base` around as the raw fetch for checks that speak as an unauthorized
 * caller. */
export function secretFetch(secret, base = globalThis.fetch) {
  return (input, init = {}) => base(input, { ...init, headers: { [SECRET_HEADER]: secret, ...(init.headers || {}) } });
}

/** `writeHeaders(secret, extra)` is the headers a write sends: JSON content type, the secret,
 * then `extra`. */
export function writeHeaders(secret, extra) {
  return { 'content-type': 'application/json', [SECRET_HEADER]: secret, ...(extra || {}) };
}

/** `sessionCookieHeader(secret)` is the Cookie header value an authorized browser sends back,
 * derived from `secret` by src/secret.mjs's own `sessionToken`. */
export function sessionCookieHeader(secret) {
  return `${SESSION_COOKIE}=${sessionToken(secret)}`;
}

/** `rawRequest(port, method, pathName, opts)` is one node:http request to 127.0.0.1:`port`
 * carrying exactly the headers given (no secret added), for a check that speaks as a caller
 * holding nothing, or holding only a cookie. opts: `host` (the Host header,
 * `127.0.0.1:<port>`), `headers`, `body` (a string). Resolves `{ status, headers, body }`. */
export function rawRequest(port, method, pathName, { host = `127.0.0.1:${port}`, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: { host, ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** `rawGet(url, headers)` is a GET of an absolute `url` carrying exactly `headers` (Host taken
 * from the url). Resolves `{ status, headers, body }`. */
export function rawGet(url, headers = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host: u.host, ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** `postBoard(port, secret, body)` posts `body` as JSON to `POST /api/board` on
 * 127.0.0.1:`port`, holding `secret`, and returns the daemon's parsed answer (`boardId`,
 * `round` and the rest). `body` is the route's own: `title` and `blocks` open a board, a
 * `boardId` adds a round to one. It is a check's setup, so anything but a 200 throws
 * `setup failure: posting "<title>" answered <status>` followed by the response body; a post
 * that is meant to be refused goes through `rawRequest` instead. It rides `rawRequest`, not
 * `globalThis.fetch`, so it reaches the daemon while a page has fetch stubbed. */
export async function postBoard(port, secret, body) {
  const r = await rawRequest(port, 'POST', '/api/board', { headers: writeHeaders(secret), body: JSON.stringify(body) });
  const what = body.title === undefined ? `a round on board ${body.boardId}` : `"${body.title}"`;
  assert.equal(r.status, 200, `setup failure: posting ${what} answered ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

/** `openSseClient(port, boardId, opts)` opens `GET /api/board/<boardId>/events` and collects
 * its frames. opts: `secret` (sends the secret header), `headers` (sent instead of that),
 * `comments` (true: a `: heartbeat`-style comment frame is collected as `{ comment }`; false:
 * skipped), `query` (appended to the path, as in '?stages=held'). Resolves
 * `{ req, res, events, status }` once the response head arrives; `events` keeps filling with
 * `{ event, data }` (data parsed as JSON). */
export function openSseClient(port, boardId, { secret, headers = secret ? { [SECRET_HEADER]: secret } : {}, comments = true, query = '' } = {}) {
  return new Promise((resolveOpen, rejectOpen) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events${query}`, headers: { host: `127.0.0.1:${port}`, ...headers } },
      res => {
        const events = [];
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = raw.split('\n');
            const evLine = lines.find(l => l.startsWith('event:'));
            const dataLine = lines.find(l => l.startsWith('data:'));
            if (evLine && dataLine) {
              events.push({ event: evLine.slice('event:'.length).trim(), data: JSON.parse(dataLine.slice('data:'.length).trim()) });
            } else if (comments) {
              const commentLine = lines.find(l => l.startsWith(':'));
              if (commentLine) events.push({ comment: commentLine.slice(1).trim() });
            }
          }
        });
        resolveOpen({ req, res, events, status: res.statusCode });
      },
    );
    req.on('error', rejectOpen);
    req.end();
  });
}

/** `waitForHealthy(port, deadlineMs)` polls `GET /api/health` on 127.0.0.1:`port` every 100ms
 * until it answers ok (true) or `deadlineMs` passes (false). */
export async function waitForHealthy(port, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

/** `renderedMarkup(html)` is a served page minus its `board-data` script, the one place a
 * board's raw text sits verbatim, so "it must not render" can be asserted on what remains. */
export function renderedMarkup(html) {
  return html.replace(/<script id="board-data"[^>]*>[\s\S]*?<\/script>/, '');
}

/** `boardDataOf(page)` is the text of the `#board-data` script `page` inlines, the page's own
 * copy of the board. Asserts there is one. */
export function boardDataOf(page) {
  const m = /<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(m, 'setup failure: the page inlines no #board-data');
  return m[1];
}

// --- the MCP shim -------------------------------------------------------------------------

/** `McpClient` speaks newline-delimited JSON-RPC to a spawned shim. `request` resolves with
 * the whole response message, `requestWithId` hands back the id too (to cancel a call),
 * `answered(id)` says whether a response came, `notify` sends a notification, `notifications`
 * collects what the shim sent unprompted, `stderr` collects its stderr, and `close` ends stdin
 * and kills the child. Once the shim has exited, every request still pending rejects, and so
 * does any made after: the shim exits on stdin close without answering what it holds
 * (bin/mcp.mjs), so a request awaited across that exit would otherwise never settle. */
export class McpClient {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.exited = null;
    this.responded = new Set();
    child.stdout.on('data', chunk => this._onData(chunk));
    child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    // 'close', not 'exit': it fires after stdout has drained, so a response the shim wrote
    // just before it exited still resolves its request rather than losing to the rejection.
    child.on('close', (code, signal) => {
      this.exited = `the shim exited (code ${code}, signal ${signal})`;
      for (const [id, pend] of this.pending) pend.reject(new Error(`${this.exited} before answering request ${id} (${pend.method})`));
      this.pending.clear();
    });
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
        continue; // stray non-protocol output would be a bug, but it must not crash the check
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pend = this.pending.get(msg.id);
        if (pend) {
          this.pending.delete(msg.id);
          this.responded.add(msg.id);
          pend.resolve(msg);
        }
      } else {
        this.notifications.push(msg);
      }
    }
  }

  request(method, params) {
    return this.requestWithId(method, params).promise;
  }

  requestWithId(method, params) {
    const id = this.nextId++;
    const promise = this.exited
      ? Promise.reject(new Error(`${this.exited} before request ${id} (${method}) was sent`))
      : new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    // Marked handled here so a check that closes a shim over a request it never awaits is
    // not failed by an unhandled rejection; a caller that awaits still sees the rejection.
    promise.catch(() => {});
    if (this.exited) return { id, promise };
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return { id, promise };
  }

  answered(id) {
    return this.responded.has(id);
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill(); } catch { /* already dead */ }
  }
}

/** `spawnShim(env, opts)` spawns bin/mcp.mjs with this process's environment patched by `env`
 * (an undefined value deletes the key) in `opts.cwd`, and returns its `McpClient`. `cwd`
 * matters: the shim posts `process.cwd()` with a board, and the daemon resolves every by-path
 * block against it. */
export function spawnShim(env = {}, { cwd } = {}) {
  const childEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const child = spawn(process.execPath, [mcpBin], { env: childEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  return new McpClient(child);
}

/** `makeOpenRecorder(dir)` writes `<dir>/fake-open.sh`, an opener that appends each url it is
 * handed to `$CLAUDE_BOARD_OPEN_LOG`. Point `CLAUDE_BOARD_OPEN_CMD` at `script` and
 * `CLAUDE_BOARD_OPEN_LOG` at `log`; `opened()` reads the urls back, and
 * `waitForOpens(n, timeoutMs = 10000)` polls until `n` have arrived (the opener runs detached,
 * so its write lands whenever it lands) and returns what did. */
export function makeOpenRecorder(dir) {
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
    waitForOpens(n, timeoutMs = 10_000) {
      return waitForCount(() => this.opened(), n, { timeoutMs, intervalMs: 25 });
    },
  };
}

// --- stub binaries ------------------------------------------------------------------------

/** `writeStub(dir, name, source)` writes an executable (mode 755) `<dir>/<name>`, making `dir`
 * if needed, and returns its path. */
export function writeStub(dir, name, source) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}

/** `STUB_OSASCRIPT` stands in for osascript: it appends its argv to `$STUB_OSASCRIPT_LOG` as
 * one JSON line and exits with `$STUB_OSASCRIPT_EXIT` (0). */
export const STUB_OSASCRIPT = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_OSASCRIPT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.STUB_OSASCRIPT_EXIT || '0'));
`;

/** `STUB_OSASCRIPT_LINGERING` stands in for an osascript whose banner is still up: each row in
 * `$STUB_OSASCRIPT_LOG` is `[what, ...argv]`, first `spawn`, then, when
 * `$STUB_OSASCRIPT_LINGER_MS` is above 0, the signal that ended it or `deadline`. */
export const STUB_OSASCRIPT_LINGERING = `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const log = process.env.STUB_OSASCRIPT_LOG;
const say = what => fs.appendFileSync(log, JSON.stringify([what, ...argv]) + '\\n');
say('spawn');
const linger = Number(process.env.STUB_OSASCRIPT_LINGER_MS || '0');
if (linger > 0) {
  const bye = sig => { say(sig); process.exit(0); };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
  setTimeout(() => { say('deadline'); process.exit(0); }, linger);
}
`;

/** `STUB_OPEN` stands in for open(1): it appends its argv to `$STUB_OPEN_LOG` as one JSON
 * line. */
export const STUB_OPEN = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_OPEN_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;

/** `readJsonLines(file)` is the JSON value of each non-empty line of `file`, or [] when the
 * file does not exist yet. */
export function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

let logCounter = 0;

/** `freshLog(dir, stem = 'osascript-invocations')` is a log path in `dir` no earlier call
 * returned (`<stem>-<n>.log`), so one check's invocations never read as another's. */
export function freshLog(dir, stem = 'osascript-invocations') {
  logCounter++;
  return path.join(dir, `${stem}-${logCounter}.log`);
}

/** `withStubOnPath(stubDir, logPath, extra, fn)` runs `fn` under `withEnv` with `stubDir`
 * first on PATH, the `STUB_OSASCRIPT` log at `logPath`, its exit code 0, then `extra`. */
export function withStubOnPath(stubDir, logPath, extra, fn) {
  return withEnv({ PATH: `${stubDir}:${process.env.PATH}`, STUB_OSASCRIPT_LOG: logPath, STUB_OSASCRIPT_EXIT: '0', ...extra }, fn);
}

/** `BANNER(folder)` is the osascript line the daemon runs to post a waiting round's banner
 * for the project folder named `folder`. */
export const BANNER = folder => `display notification "${folder}: a round is waiting." with title "Board"`;

/** `rowsFor(log, folder)` is every row `STUB_OSASCRIPT_LINGERING` wrote to `log` for
 * `folder`'s banner, so one board's banner is never counted as another's. */
export function rowsFor(log, folder) {
  const body = BANNER(folder);
  return readJsonLines(log).filter(r => r[r.length - 1] === body);
}

/** `spawnsFor(log, folder)` is the `spawn` rows among `rowsFor`: one per banner posted. */
export function spawnsFor(log, folder) {
  return rowsFor(log, folder).filter(r => r[0] === 'spawn');
}

// --- the compiled launcher ----------------------------------------------------------------

/** `cEscape(value)` escapes backslash and double quote, the two bytes that would end a C
 * string literal early: install.sh's own c_escape. */
export function cEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** `buildLauncher(workDir, opts)` builds bin/launcher.c into `<workDir>/launcher` the way
 * install.sh does, against a `<workDir>/header/launcher_paths.h` written from `opts`: `node`
 * (process.execPath), `daemon`, `home`, `path` (/usr/bin:/bin:/usr/sbin:/sbin), `store`,
 * `refRoots`, `repoRoot`, each defaulting to a path under `workDir`. By default it compiles
 * bin/notify.m and bin/menubar.m to objects and links all three with Foundation,
 * UserNotifications and AppKit, linking only when both objects compiled. `opts.link` (a list
 * of sources or objects) links launcher.c against those instead, in one invocation and with
 * no frameworks. Returns `{ exec, headerDir, headerPath, builds, build }`: `builds` is every
 * spawnSync result in order, `build` the first that failed, else the last. */
export function buildLauncher(workDir, opts = {}) {
  const defines = [
    ['NODE', opts.node ?? process.execPath],
    ['DAEMON', opts.daemon ?? path.join(workDir, 'never-run.mjs')],
    ['HOME_DIR', opts.home ?? path.join(workDir, 'compiled-home')],
    ['PATH', opts.path ?? '/usr/bin:/bin:/usr/sbin:/sbin'],
    ['STORE_DIR', opts.store ?? path.join(workDir, 'store')],
    ['REF_ROOTS_VALUE', opts.refRoots ?? path.join(workDir, 'roots')],
    ['REPO_ROOT_VALUE', opts.repoRoot ?? path.join(workDir, 'repo')],
  ];
  const headerDir = path.join(workDir, 'header');
  mkdirSync(headerDir, { recursive: true });
  const headerPath = path.join(headerDir, 'launcher_paths.h');
  writeFileSync(headerPath, [...defines.map(([k, v]) => `#define CLAUDE_BOARD_${k} "${cEscape(v)}"`), ''].join('\n'));

  const exec = path.join(workDir, 'launcher');
  const launcherSrc = path.join(repoRoot, 'bin', 'launcher.c');
  const cc = args => spawnSync(CC, ['-O2', '-Wall', '-Wextra', ...args], { encoding: 'utf8' });
  let builds;
  if (opts.link) {
    builds = [cc(['-o', exec, '-I', headerDir, launcherSrc, ...opts.link])];
  } else {
    const objects = ['notify', 'menubar'].map(name => path.join(workDir, `${name}.o`));
    builds = ['notify', 'menubar'].map((name, i) =>
      cc(['-fobjc-arc', '-c', '-o', objects[i], path.join(repoRoot, 'bin', `${name}.m`)]));
    if (builds.every(b => b.status === 0)) {
      builds.push(cc(['-o', exec, '-I', headerDir, launcherSrc, ...objects,
        '-framework', 'Foundation', '-framework', 'UserNotifications', '-framework', 'AppKit']));
    }
  }
  const build = builds.find(b => b.status !== 0) || builds[builds.length - 1];
  return { exec, headerDir, headerPath, builds, build };
}

// --- pages in the DOM stand-in ------------------------------------------------------------

/** `inlineColorScheme(el)` lists every `color-scheme` set on `el` itself, one entry per way
 * script can set it: the `style.colorScheme` property, `style.setProperty`, `style.cssText`
 * and a `style` attribute. A browser folds the four into one declaration; the stand-in keeps
 * them apart (test/dom-stand-in.mjs's `makeStyle`), so a check that reads one of them passes
 * a regression that writes through another. Empty when none is set:
 *
 *   assert.deepEqual(inlineColorScheme(stageRoot), []);
 */
export function inlineColorScheme(el) {
  const found = [];
  const style = el.style || {};
  if (style.colorScheme) found.push(`style.colorScheme: ${style.colorScheme}`);
  const viaSetProperty = typeof style.getPropertyValue === 'function' ? style.getPropertyValue('color-scheme') : '';
  if (viaSetProperty) found.push(`style.setProperty: ${viaSetProperty}`);
  if (/color-scheme/i.test(String(style.cssText || ''))) found.push(`style.cssText: ${style.cssText}`);
  const attr = el.getAttribute('style');
  if (/color-scheme/i.test(String(attr || ''))) found.push(`style attribute: ${attr}`);
  return found;
}

let harness = null;

/** `pageHarness()` loads test/dom-stand-in.mjs and the real client scripts once, and resolves
 * the page helpers, each synchronous from then on:
 *
 *   const { loadBoard, answerSingle } = await pageHarness();
 *
 * Kept behind this call so a file that never drives a page never loads them. */
export function pageHarness() {
  if (!harness) harness = buildPageHarness();
  return harness;
}

async function buildPageHarness() {
  const [dom, { ui }, { themeBootScript }, { styles }, { renderIndexPage, indexScript }] = await Promise.all([
    import('./dom-stand-in.mjs'),
    import('../src/ui.mjs'),
    import('../src/theme.mjs'),
    import('../src/styles.mjs'),
    import('../src/indexpage.mjs'),
  ]);
  const { parseHTML, StandInEvent, StandInEventSource, resolveComputedProperty, fetchSettler } = dom;
  const realFetch = globalThis.fetch;
  const clickOn = el => el.dispatchEvent(new StandInEvent('click'));

  /** `loadBoard(html, opts)` parses `html` and runs the real `ui` script against it, returning
   * the document: a fresh one per call, so checks never share state. opts: `protocol`
   * ('http:'; 'file:' is the read-only archive), `location` (an object used as-is, instead of
   * `{ protocol }`), `EventSource` (a stand-in class for the declared name; left undefined, the
   * client's own `typeof` guard skips the stream), `theme` (run src/theme.mjs's
   * `themeBootScript` first, as the page does), `finish` (call `document.finishParsing()` after,
   * which wires anything waiting for the document to finish loading), `mermaid` (set as
   * `window.mermaid`), `storage` (set as `window.localStorage`), `script` (run instead of
   * `ui`). */
  function loadBoard(html, opts = {}) {
    // A positional protocol ('file:') would destructure to nothing and load the LIVE page.
    assert.ok(opts && typeof opts === 'object', 'loadBoard takes an options object, as in loadBoard(html, { protocol: \'file:\' })');
    const { protocol = 'http:', location, EventSource, theme = false, finish = false, mermaid, storage, script = ui } = opts;
    const document = parseHTML(html);
    const window = document.defaultView;
    if (mermaid) window.mermaid = mermaid;
    if (storage) window.localStorage = storage;
    const loc = location || { protocol };
    if (theme) new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, loc, undefined);
    new Function('document', 'window', 'location', 'EventSource', script)(document, window, loc, EventSource);
    if (finish) document.finishParsing();
    return document;
  }

  /** `loadBoardWithEventSource(html, opts)` is `loadBoard` with a capturing EventSource stand-in
   * passed for the declared name, so a check can dispatch a real push ('round', 'amend') into
   * the listeners the client registered. Asserts the client constructed one. Takes
   * `loadBoard`'s options except `EventSource`, and returns `{ document, window, location, es }`. */
  function loadBoardWithEventSource(html, opts = {}) {
    assert.ok(opts && typeof opts === 'object', 'loadBoardWithEventSource takes an options object, as in loadBoardWithEventSource(html, { protocol: \'http:\' })');
    let es = null;
    class CapturingEventSource extends StandInEventSource {
      constructor(url) { super(url); es = this; }
    }
    const location = opts.location || { protocol: opts.protocol || 'http:' };
    const document = loadBoard(html, { ...opts, location, EventSource: CapturingEventSource });
    assert.ok(es, 'setup failure: the real ui script never constructed an EventSource -- fix the fixture (readonly must be false), not this file');
    return { document, window: document.defaultView, location, es };
  }

  /** `loadArchiveThemed(html, { storage })` loads `html` as a file:// archive the way the page
   * boots, theme script first and parsing finished, with `globalThis.fetch` rejecting
   * ('the archive must never call fetch') until `restore()` is called, so a fetch from any
   * later click fails too. Returns `{ document, restore }`; call `restore()` in a finally. */
  function loadArchiveThemed(html, { storage } = {}) {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('the archive must never call fetch'));
    try {
      const document = loadBoard(html, { protocol: 'file:', theme: true, finish: true, storage });
      return { document, restore() { globalThis.fetch = original; } };
    } catch (err) {
      globalThis.fetch = original;
      throw err;
    }
  }

  /** `enableCommentMode(document)` turns comment mode on through the real toggle and returns
   * the toggle. Idempotent: it clicks only when the mode is off, since a page board can start
   * with it on and a second click would turn it off. */
  function enableCommentMode(document) {
    const toggle = document.getElementById('comment-mode-toggle');
    assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
    if (!toggle.classList.contains('active')) clickOn(toggle);
    assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
    return toggle;
  }

  /** `click(el)` dispatches a click at `el`, asserting first that there is one. */
  function click(el) {
    assert.ok(el, 'setup failure: element to click is missing');
    clickOn(el);
  }

  /** `clickThemeToggle(document)` clicks the real #theme-toggle. */
  function clickThemeToggle(document) {
    const btn = document.getElementById('theme-toggle');
    assert.ok(btn, 'setup failure: no #theme-toggle rendered');
    clickOn(btn);
  }

  /** `answerSingle(block, label)` answers a single-choice question by clicking the option
   * labelled `label` through the real widget. */
  function answerSingle(block, label) {
    const opt = [...block.querySelectorAll('.choice-single')].find(el => el.textContent.trim() === label);
    assert.ok(opt, `setup failure: no "${label}" option rendered in this block`);
    clickOn(opt);
  }

  /** `deferBlock(block)` defers a question through its real Defer button. */
  function deferBlock(block) {
    const btn = block.querySelector('.btn-defer');
    assert.ok(btn, 'setup failure: no Defer button rendered in this block');
    clickOn(btn);
  }

  /** `openBlocks(document)` is the open round's question blocks in order, the set the client's
   * collectAnswers and the send guard both walk. */
  function openBlocks(document) {
    return document.querySelectorAll('.round-open .question-block');
  }

  /** `withFetchCapture(fn)` stubs `globalThis.fetch` while `fn` runs (sync), recording each
   * call as `{ url, method, body }` (body parsed as JSON, or null) and answering each
   * `{ ok: true, status: 200, json }`. Restores fetch even if `fn` throws; returns the calls. */
  function withFetchCapture(fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (url, opts) => {
      calls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    };
    try {
      fn();
    } finally {
      globalThis.fetch = original;
    }
    return calls;
  }

  /** `directChildPinLayer(section)` is the `.pin-layer` that is a direct child of `section`, or
   * null. */
  function directChildPinLayer(section) {
    return Array.prototype.slice.call(section.children || [])
      .find(c => c.classList && c.classList.contains('pin-layer')) || null;
  }

  /** `reportScroll(frame, top)` forges a page board stage's scroll report from the stage's own
   * window, the only source the parent's listener trusts. */
  function reportScroll(frame, top) {
    frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top }, '*');
  }

  /** `condensed(document)` is whether the header is in its condensed, stage-scrolled state. */
  function condensed(document) {
    return document.body.classList.contains('stage-scrolled');
  }

  /** `progress(document)` is the body's `--stage-p` value as the client last wrote it. */
  function progress(document) {
    return document.body.style.getPropertyValue('--stage-p');
  }

  /** `computed(el, prop)` is `prop` for `el` resolved through src/styles.mjs's real cascade,
   * with the system preferring dark. */
  function computed(el, prop) {
    return resolveComputedProperty(styles, el, true, prop);
  }

  /** `loadIndexAgainstDaemon(port, opts)` renders the real index page and runs `indexScript`
   * against a daemon on 127.0.0.1:`port`: `globalThis.fetch` is pointed at it, carrying the
   * session cookie for `opts.secret`, and every request is tracked by a `fetchSettler`.
   * opts: `secret` (required), `page` (renderIndexPage's argument, `{ threads: [] }`), `html`
   * (a page as the daemon served it, loaded in place of rendering `page`), `hash`
   * (location.hash, ''), `noCookieFor` (urls sent without the cookie, to fail a write), `stream`
   * (pass a capturing EventSource stand-in; off, the declared name stays undefined), `settler`
   * (share one across loads). Returns `{ document, intervals, location, history, stream,
   * settle, restoreFetch }`: `intervals` records each setInterval and fires none, `location`
   * counts `reload()` calls, `history` records each `replaceState` url and applies its hash,
   * `settle()` drains every request in flight. Call `restoreFetch()` when done. */
  function loadIndexAgainstDaemon(port, { secret, page = { threads: [] }, html = null, hash = '', noCookieFor = [], stream = false, settler = fetchSettler() } = {}) {
    assert.ok(secret, 'setup failure: loadIndexAgainstDaemon needs the daemon secret for its session cookie');
    const document = parseHTML(html ?? renderIndexPage(page));
    const cookie = sessionCookieHeader(secret);
    globalThis.fetch = (url, opts) => {
      const headers = { ...(opts && opts.headers), ...(noCookieFor.includes(url) ? {} : { cookie }) };
      return settler.track(realFetch(`http://127.0.0.1:${port}${url}`, { ...opts, headers }));
    };
    const intervals = [];
    const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
    const location = { hash, pathname: '/', search: '', reloadCount: 0, reload() { this.reloadCount++; } };
    const history = {
      calls: [],
      replaceState(state, title, url) {
        this.calls.push(url);
        const hashIdx = url.indexOf('#');
        location.hash = hashIdx === -1 ? '' : url.slice(hashIdx);
      },
    };
    let captured = null;
    class CapturingEventSource extends StandInEventSource {
      constructor(url) { super(url); captured = this; }
    }
    new Function('document', 'setInterval', 'window', 'location', 'history', 'EventSource', indexScript)(
      document, fakeSetInterval, document.defaultView, location, history, stream ? CapturingEventSource : undefined);
    return {
      document,
      intervals,
      location,
      history,
      get stream() { return captured; },
      settle: () => settler.settle(),
      restoreFetch() { globalThis.fetch = realFetch; },
    };
  }

  return {
    loadBoard,
    loadBoardWithEventSource,
    loadArchiveThemed,
    enableCommentMode,
    click,
    clickThemeToggle,
    answerSingle,
    deferBlock,
    openBlocks,
    withFetchCapture,
    directChildPinLayer,
    reportScroll,
    condensed,
    progress,
    computed,
    loadIndexAgainstDaemon,
  };
}
