// Real-browser end-to-end proof for stage-mermaid (the marker-gated srcdoc
// injection in src/render.mjs, the parent render service in src/ui.mjs, the
// isOpenRoute exception in src/server.mjs). Everything the DOM stand-in
// cannot see at all -- CSP inheritance, opaque-origin subresource rules, the
// `file:` local-resource rule, real network traffic -- lives here instead of
// in test/check-mermaid-stage.mjs. See QUIRKS.md "The DOM stand-in's
// ceilings" and "Driving the real page in real Chrome".
//
// NOT wired into test/run.mjs's `checks` array on purpose: that suite has to
// pass on a machine with no Chrome installed, and run.mjs's list is an
// explicit array rather than a directory glob, so a file merely living in
// test/ never joins it by accident. Run this one by hand:
//
//   node test/browser-check-mermaid-stage.mjs
//   CLAUDE_BOARD_BROWSER_CHECK_ARTIFACT=/path/to/real-report.html \
//     CLAUDE_BOARD_BROWSER_CHECK_FIGURE_SELECTOR='#ark-3054 pre.mermaid' \
//     node test/browser-check-mermaid-stage.mjs
//
// Five things asserted, against a real headless Chrome over the DevTools
// Protocol (examples/screenshot.mjs's harness pattern -- Node's native
// WebSocket, zero npm dependencies):
//
//   1. SERVED: the board's stage frame shows a rendered <svg>, not raw
//      mermaid source.
//   2. ARCHIVE: the page plus its siblings, copied out of the store's
//      pages/ to a plain temp dir and opened over file://, renders the same
//      figure via the parent-render facade (the served surface's sibling
//      <script> tag can never load over file: -- Chrome's local-resource
//      rule refuses a file: subresource to an opaque-origin frame,
//      CSP-independent; QUIRKS.md "What a srcdoc stage can actually load").
//   3. NO EXTERNAL HOST: proven at the Chrome PROCESS level, not by racing
//      DevTools Protocol session attachment against a brand-new frame's own
//      first byte (see the proxy comment below for why that race is real).
//   4. DEGRADE: the engine sibling missing, and separately corrupt, both
//      leave the raw diagram source on screen -- never a blank figure.
//   5. A full-document artifact (`<!doctype html><html>…`, the one shape
//      test/check-mermaid-stage.mjs's own DOM stand-in cannot parse as a
//      fragment at all) stays standards-mode inside the stage frame and the
//      prelude still runs.
//
// The committed fixture (test/fixtures/mermaid-stage-artifact.html) is a
// minimal full-document artifact carrying the /explain template's exact
// loader shape (2026-08-18-nightly.html lines 806-829: window.mermaid
// short-circuit, same-origin sibling first, the CDN URL as a second
// fallback only, dataset.src reset before every re-run) -- not a copy of a
// real report, so this stays small enough to commit.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { assetsNamedBy, MERMAID_ASSET_NAME } from '../src/assets.mjs';
import { parseMermaidDomId, MERMAID_NODE_SELECTOR } from '../src/anchor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const CHROME = process.env.CLAUDE_BOARD_CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ARTIFACT_PATH = process.env.CLAUDE_BOARD_BROWSER_CHECK_ARTIFACT
  || path.join(HERE, 'fixtures', 'mermaid-stage-artifact.html');
const FIGURE_SELECTOR = process.env.CLAUDE_BOARD_BROWSER_CHECK_FIGURE_SELECTOR || 'pre.mermaid';

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
  return new Promise(r => setTimeout(r, ms));
}

/** Races `promise` against a deadline without leaving an unhandled rejection
 * behind when `promise` wins: `Promise.race([p, sleep(ms).then(() => {throw})])`
 * looks equivalent but is not -- the loser's `.then` chain still runs to
 * completion and throws into nothing, which Node treats as an unhandled
 * rejection (fatal under this Node version's default). Racing the timer's OWN
 * promise, and clearing it once either side settles, has no loser left to
 * reject unobserved. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// The network witness. A per-target DevTools Protocol Network.enable races a
// brand-new OOPIF's own first resource load and loses: measured directly
// (probe kept out of this file) -- a sandboxed opaque-origin srcdoc iframe is
// its own Chrome TARGET (Target.attachedToTarget, type "iframe"), and the
// tag prepended at the very front of its srcdoc dispatches before this
// script's async attach-then-enable chain can land, even with
// waitForDebuggerOnStart. `Network.requestWillBeSent` for that exact request
// never arrives on any session, on any Chrome build tried.
//
// A forward proxy sidesteps the race entirely: Chrome's `--proxy-server`
// applies at the network-service level, uniformly, for every renderer
// process and every frame regardless of OOPIF boundaries or CDP session
// timing, so a request this proxy never sees is a request that never left
// the machine -- not a request this harness merely failed to observe in
// time. Confirmed against the same race case directly: an OOPIF srcdoc's own
// `<script src>` to an external host DOES show up here, first-byte and all.
//
// 127.0.0.1 traffic (the served surface's own daemon) is forwarded for
// real, because Chrome does not always route loopback destinations through
// a configured proxy (it appears to bypass them outright on this machine),
// but a version that did would need this to still work. Anything else is
// logged and refused -- the daemon it would have reached does not exist.
function createWitnessProxy() {
  const seen = [];
  const record = (kind, hostname, port, url) => seen.push({ kind, hostname, port, url, phase: currentPhase });
  let currentPhase = 'setup';

  // Chrome tears the raw socket down (ECONNRESET) the instant it reads a
  // refusal, on both paths below -- a 502 body it has no use for, or a
  // deliberately closed CONNECT tunnel. Every socket this proxy touches
  // therefore needs its own 'error' listener: Node's Socket is an
  // EventEmitter, and an 'error' event with nobody listening is fatal
  // (throws out of the event loop), not merely logged.
  const swallow = socket => socket && socket.on('error', () => {});

  const server = http.createServer((req, res) => {
    swallow(req.socket);
    swallow(res.socket);
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    record('http', target.hostname, target.port || '80', req.url);
    if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
      try { res.writeHead(502, { 'content-type': 'text/plain' }).end('witness proxy refuses non-loopback hosts'); } catch {}
      return;
    }
    const upstream = http.request({
      hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search,
      method: req.method, headers: req.headers,
    }, upstreamRes => {
      swallow(upstreamRes.socket);
      try { res.writeHead(upstreamRes.statusCode, upstreamRes.headers); } catch {}
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { try { res.writeHead(502).end(); } catch {} });
    req.pipe(upstream);
  });
  server.on('clientError', (err, socket) => { swallow(socket); try { socket.destroy(); } catch {} });

  server.on('connect', (req, clientSocket, head) => {
    swallow(clientSocket);
    const [hostname, portStr] = req.url.split(':');
    record('connect', hostname, portStr || '443', req.url);
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
      return;
    }
    const upstream = net.connect(Number(portStr) || 443, hostname, () => {
      try {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      } catch {}
    });
    swallow(upstream);
    upstream.on('error', () => clientSocket.destroy());
  });

  return {
    server,
    seen,
    setPhase(name) { currentPhase = name; },
    async listen() {
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      return server.address().port;
    },
    close() { return new Promise(res => server.close(res)); },
  };
}

// Chrome's own background chatter (safe browsing, component update pings,
// captive-portal probes) survives every `--disable-*` flag tried on this
// machine. Named explicitly rather than pattern-matched loosely, so a
// genuinely new host still fails the check instead of slipping through a
// vague wildcard -- and so this list is the one place that has to change if
// Chrome's own traffic shape does.
const CHROME_INFRA_SUFFIXES = ['.google.com', '.googleapis.com', '.gstatic.com', '.googleusercontent.com'];
function isChromeInfra(hostname) {
  return CHROME_INFRA_SUFFIXES.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Headless Chrome over CDP -- examples/screenshot.mjs's own harness pattern.
function launchChrome(proxyPort) {
  const profile = mkdtempSync(path.join(tmpdir(), 'cb-mermaid-browser-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900',
    `--proxy-server=127.0.0.1:${proxyPort}`,
    '--disable-background-networking', '--disable-sync', '--disable-default-apps',
    '--disable-component-update', '--no-first-run', '--no-default-browser-check',
    '--disable-domain-reliability',
    '--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication,NetworkTimeServiceQuerying',
    'about:blank',
  ], { stdio: 'ignore' });
  let chromeFailed = null;
  chrome.on('error', err => { chromeFailed = err; });

  async function endpoint() {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100; i++) {
      try {
        const [livePort, wsPath] = readFileSync(portFile, 'utf8').split('\n');
        if (livePort && wsPath) return `ws://127.0.0.1:${livePort.trim()}${wsPath.trim()}`;
      } catch { /* not written yet */ }
      if (chromeFailed) throw new Error(`could not start ${CHROME}: ${chromeFailed.message}`);
      if (chrome.exitCode !== null) throw new Error(`chrome exited with ${chrome.exitCode}`);
      await sleep(100);
    }
    throw new Error('chrome never came up');
  }

  async function cleanup() {
    const exited = chrome.exitCode !== null || chrome.signalCode !== null
      ? Promise.resolve()
      : new Promise(res => chrome.once('exit', res));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return { endpoint, cleanup };
}

/** Runs `fn({ send, onEvent })` against a brand-new, single-purpose Chrome
 * process, torn down afterward. Measured directly: REUSING one Chrome
 * process across several navigations (attach to page A, work with it, then
 * navigate a second target to page B in the SAME browser) made the archive
 * open behave noticeably worse back when the outcome still depended on a
 * startup race -- a DevTools client already attached to ANY target in a
 * browser process appears to change that process's own scheduling broadly,
 * not just for the specifically instrumented target. The race itself is gone
 * (the facade repeats its request until answered), so this is no longer
 * load-bearing for the archive result; it is kept because one process per
 * file:// page also keeps each phase's proxy witness cleanly separated. */
async function withFreshChrome(proxyPort, fn) {
  const chrome = launchChrome(proxyPort);
  let ws;
  try {
    ws = new WebSocket(await chrome.endpoint());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('devtools websocket failed to open')), { once: true });
    });
    const { send, onEvent } = connectDevtools(ws);
    return await fn({ send, onEvent });
  } finally {
    if (ws) { try { ws.close(); } catch {} }
    await chrome.cleanup();
  }
}

// There was a `withRetries(attempts, fn)` helper here, wrapping the archive
// render wait in up to eight independent fresh-Chrome attempts. It is gone,
// with the defect it was papering over: the facade sent its render request
// once and never again, so whenever the stage's inline script beat the
// parent's DEFERRED client script to registering a `message` listener, the
// request was lost outright and that figure was stuck on raw source for the
// rest of the page's life. The measurements that helper's comment recorded
// (five headless recipes, split results on identical bytes) were real, and
// they were the symptom of that ordering, not of this harness: they are
// summarised at the archive check's own call site, which now runs exactly
// once. A retry loop over a race is a way of not noticing it.

function connectDevtools(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const failAll = reason => {
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };
  ws.addEventListener('close', () => failAll('devtools socket closed before the reply arrived'));
  ws.addEventListener('error', () => failAll('devtools socket errored'));
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  return { send, onEvent };
}

/** Opens `url` in a fresh top-level target, waits for the load event, and
 * resolves the stage's own OOPIF session once Chrome attaches it (a
 * sandboxed opaque-origin srcdoc iframe is always its own Chrome target --
 * see the witness-proxy comment above). Throws if no stage attaches within
 * the timeout, which is exactly the failure a board without an html-stage
 * (a wiring regression, not this check's fixture) should produce.
 *
 * `cookie`, when given, is set on the profile's cookie jar before navigating
 * -- every read route past `/api/health` is credential-gated now (reads need
 * `cb_session`, writes need the secret header), and this harness has no real
 * reviewer's browser to hand it one through the ordinary single-use
 * `/auth/:token` handoff. It holds the daemon's own secret already (this is
 * ITS scratch daemon), and `cb_session` is DERIVED from that secret
 * (src/secret.mjs `sessionToken`) rather than randomly minted, so minting
 * the identical cookie here is not a bypass of the credential model -- it is
 * the credential model, applied by a caller that already holds the one
 * secret that makes it valid. */
async function openBoardPage(send, onEvent, url, { cookie } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);

  let stageSessionId = null;
  const stageAttached = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
        stageSessionId = msg.params.sessionId;
        off();
        resolve(stageSessionId);
      }
    });
  });
  const loadFired = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { off(); resolve(); }
    });
  });

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  if (cookie) {
    await s('Network.enable');
    await s('Network.setCookie', {
      name: SESSION_COOKIE, value: cookie, domain: '127.0.0.1', path: '/',
      httpOnly: true, sameSite: 'Strict',
    });
  }
  await s('Page.navigate', { url });
  await withTimeout(loadFired, 20000, `page never fired load: ${url}`);

  const stageId = await withTimeout(stageAttached, 10000, `no html-stage iframe ever attached for ${url}`);
  await send('Runtime.enable', {}, stageId);
  return { pageSessionId: sessionId, stageSessionId: stageId, s };
}

/** Opens a `file://` archive with every CDP domain deliberately enabled as
 * late as possible, rather than `openBoardPage`'s recipe (Runtime/Page
 * enabled and auto-attach armed BEFORE Page.navigate). The difference is
 * historical, and worth keeping: `openBoardPage`'s recipe against a freshly
 * archived page lost the archive/facade startup race on EVERY trial (both
 * against this file's own fixture and the real 2026-08-18-nightly.html
 * reproducer) back when the facade posted its 'mermaid' request once and
 * never again, because the parent's `message` listener (registered by its
 * own DEFERRED `ui-*.js`, which by spec cannot run until the ENTIRE document
 * finishes parsing) had not registered yet and the request was simply never
 * answered. That is fixed at the source now -- the request repeats until it
 * is answered -- so this recipe is no longer what decides the outcome. It
 * stays because instrumenting as late as possible is the least invasive way
 * to read a sandboxed cross-origin frame's live DOM, which CDP is the only
 * channel for, and because a check that watches a page should disturb its
 * scheduling as little as it can. */
async function openArchivePage(send, onEvent, url, { settleMs = 6000 } = {}) {
  const { targetId } = await send('Target.createTarget', { url });
  await sleep(settleMs); // no CDP domain enabled yet, on purpose -- see header comment
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Runtime.enable');

  let stageSessionId = null;
  const stageAttached = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
        stageSessionId = msg.params.sessionId;
        off();
        resolve(stageSessionId);
      }
    });
  });
  // Retroactive: the iframe target already exists by now, and enabling
  // auto-attach still attaches to every currently-matching target, not only
  // future ones -- confirmed directly, not assumed.
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const stageId = await withTimeout(stageAttached, 5000, `no html-stage iframe ever (retroactively) attached for ${url}`);
  await send('Runtime.enable', {}, stageId);
  return { pageSessionId: sessionId, stageSessionId: stageId, s };
}

async function evalIn(send, sessionId, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, sessionId);
  if (exceptionDetails) throw new Error(`eval threw: ${exceptionDetails.text || JSON.stringify(exceptionDetails)}`);
  return result.value;
}

async function waitForTruthy(send, sessionId, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evalIn(send, sessionId, expression);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`condition never became true (${expression})`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Daemon: the branch's own bin/daemon.mjs, on a scratch port against a
// scratch CLAUDE_BOARD_HOME -- never the real store, never the real secret.
/** A free loopback port, picked by asking the OS for one (`listen(0)`) and
 * releasing it immediately. `CLAUDE_BOARD_PORT=0` cannot be used to ask
 * `bin/daemon.mjs` for an ephemeral port the way `startServer({port: 0})`
 * can in-process (test/check-http.mjs's own route): src/server.mjs reads the
 * env var through `Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT`,
 * and `0` is falsy in JS, so `CLAUDE_BOARD_PORT=0` silently falls through to
 * the real default port (7391) instead -- observed directly (EADDRINUSE
 * against this machine's own real daemon). Out of scope to fix (src/
 * feature code); picking a real, already-free port before spawning is the
 * workaround, with the ordinary narrow TOCTOU a throwaway check accepts. */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startScratchDaemon() {
  const home = mkdtempSync(path.join(tmpdir(), 'cb-mermaid-browser-home-'));
  const secretFile = path.join(home, 'secret');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  const wantPort = await getFreePort();

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'daemon.mjs')], {
    env: {
      ...process.env,
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_SECRET_FILE: secretFile,
      CLAUDE_BOARD_PORT: String(wantPort),
      CLAUDE_BOARD_STRANDED_GRACE_MS: String(24 * 60 * 60 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });

  async function port() {
    const deadline = Date.now() + 15000;
    for (;;) {
      const m = /claude-board daemon listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) return Number(m[1]);
      if (child.exitCode !== null) throw new Error(`daemon exited early (${child.exitCode}):\n${out}`);
      if (Date.now() >= deadline) throw new Error(`daemon never reported its port:\n${out}`);
      await sleep(100);
    }
  }

  async function stop() {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(res => child.once('exit', res)),
      sleep(3000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  return { home, secret, port, stop };
}

function postJson(urlStr, body, secret) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        [SECRET_HEADER]: secret,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`daemon responded ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`invalid JSON: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// ---------------------------------------------------------------------------
// Archive copies: the page plus every shared sibling it names, out of the
// scratch store's pages/ into a plain temp dir -- exactly the file set a
// reviewer would get by copying the folder Finder shows next to a
// double-clicked archive.
function copyArchive(pagesDir, boardId, { dropMermaid = false, corruptMermaid = false } = {}) {
  const dest = mkdtempSync(path.join(tmpdir(), 'cb-mermaid-browser-archive-'));
  const pageBytes = readFileSync(path.join(pagesDir, `${boardId}.html`), 'utf8');
  const siblings = assetsNamedBy(pageBytes);
  copyFileSync(path.join(pagesDir, `${boardId}.html`), path.join(dest, `${boardId}.html`));
  const copiedSiblings = [];
  for (const name of siblings) {
    const isMermaid = MERMAID_ASSET_NAME.test(name);
    if (isMermaid && dropMermaid) continue; // simulate a missing engine sibling
    copyFileSync(path.join(pagesDir, name), path.join(dest, name));
    copiedSiblings.push(name);
    if (isMermaid && corruptMermaid) {
      // Shape-invalid but syntactically valid: a real corrupt download can
      // truncate mid-token, but what both consumers (the stage's own
      // `shaped()` check and the parent's `looksLikeMermaidEngine`) actually
      // key on is API SHAPE, not parse success -- this is the deterministic
      // version of "the file arrived, but it's not the engine".
      writeFileSync(path.join(dest, name), 'window.mermaid = { corrupted: true };\n');
    }
  }
  return { dest, pageUrl: `file://${path.join(dest, `${boardId}.html`)}`, copiedSiblings, pageBytes };
}

// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(CHROME)) {
    console.error(`browser-check-mermaid-stage: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override).`);
    process.exit(1);
  }

  const artifactHtml = readFileSync(ARTIFACT_PATH, 'utf8');
  const diagramSourceHint = 'flowchart'; // present verbatim in every fixture/nightly diagram's raw text

  const witness = createWitnessProxy();
  const proxyPort = await witness.listen();
  const daemon = await startScratchDaemon();

  let boardId;
  let daemonPort;
  let pagesDir;

  try {
    daemonPort = await daemon.port();
    pagesDir = path.join(daemon.home, 'pages');

    const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, {
      title: 'mermaid stage browser check',
      blocks: [{ kind: 'html', html: artifactHtml }],
    }, daemon.secret);
    boardId = posted.boardId;
    assert.ok(boardId, 'daemon did not return a boardId');

    // SERVED: one Chrome process, all three assertions against the same
    // opened tab. No cross-frame startup race here (the sibling <script>
    // loads inside the stage itself), so one shared process is fine.
    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      let servedStage = null;

      await check('SERVED: stage frame shows a rendered <svg>, not raw source', async () => {
        witness.setPhase('served');
        const boardUrl = `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`;
        servedStage = await openBoardPage(send, onEvent, boardUrl, { cookie: sessionToken(daemon.secret) });
        await waitForTruthy(
          send, servedStage.stageSessionId,
          `!!(document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}) && document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}).querySelector('svg'))`,
        );
        const nodeIds = await evalIn(
          send, servedStage.stageSessionId,
          `Array.from(document.querySelectorAll(${JSON.stringify(MERMAID_NODE_SELECTOR)})).map(function (e) { return e.id; })`,
        );
        assert.ok(Array.isArray(nodeIds) && nodeIds.length > 0, 'no real (prefixed) mermaid node ids found in the rendered SVG');
        const refs = nodeIds.map(parseMermaidDomId).filter(Boolean);
        assert.ok(refs.length > 0, `node ids present but none parsed back to a source ref: ${JSON.stringify(nodeIds)}`);
      });

      await check('SERVED: full-document artifact stays standards mode and the prelude ran', async () => {
        const compatMode = await evalIn(send, servedStage.stageSessionId, 'document.compatMode');
        assert.equal(compatMode, 'CSS1Compat', `expected standards mode, got ${compatMode}`);
        // window.mermaid exists with the shape the artifact's own loader checks
        // for (either the real engine's sibling <script> landed first, or the
        // facade installed) -- proof the prelude ran ahead of the artifact's own
        // end-of-body script, which is the whole point of prepending it.
        const shaped = await evalIn(
          send, servedStage.stageSessionId,
          `!!(window.mermaid && typeof window.mermaid.run === 'function' && typeof window.mermaid.initialize === 'function')`,
        );
        assert.ok(shaped, 'window.mermaid missing or wrong-shaped on the served surface');
      });

      await check('AC4 (served): the CDN fallback and the sibling assets/ fallback never fire', async () => {
        const badTags = await evalIn(
          send, servedStage.stageSessionId,
          `Array.from(document.querySelectorAll('script')).map(function (s) { return s.src || ''; })`
            + `.filter(function (src) { return src.indexOf('jsdelivr') !== -1 || src.indexOf('assets/mermaid.min.js') !== -1; })`,
        );
        assert.deepEqual(badTags, [], `loader appended a fallback <script>: ${JSON.stringify(badTags)}`);
      });
    });

    // ARCHIVE and both DEGRADE passes: each gets its OWN fresh Chrome
    // process -- see withFreshChrome's header comment for why that is load
    // bearing here and not merely tidy.
    const archive = copyArchive(pagesDir, boardId);
    await check('ARCHIVE: page + siblings copied to a plain temp dir render via the facade over file://', async () => {
      witness.setPhase('archive');
      const mermaidSiblings = archive.copiedSiblings.filter(n => MERMAID_ASSET_NAME.test(n));
      assert.equal(mermaidSiblings.length, 1, `expected exactly one mermaid-*.js sibling, got ${JSON.stringify(archive.copiedSiblings)}`);
      assert.ok(
        archive.pageBytes.includes(mermaidSiblings[0]),
        `the copied page's own bytes do not name its mermaid sibling (${mermaidSiblings[0]})`,
      );
      // ONE attempt, no retry -- and that is the assertion, not a detail of how
      // it is run. This wait used to be wrapped in up to eight independent
      // fresh-Chrome attempts, because the facade sent its render request once
      // and never again: the parent's `message` listener belongs to a DEFERRED
      // script that cannot run until the whole board page has parsed, the
      // stage's inline script runs as soon as its frame exists, nothing orders
      // the two, and whenever the stage won the request was lost and the figure
      // stayed on raw source forever. Measured intermittent here across five
      // headless recipes (fully CDP-instrumented, late-attach, uninstrumented
      // `--screenshot` with and without a virtual-time budget, and a
      // 15-real-second deferred attach) with no source change between runs.
      // The facade now repeats every request until it is answered and the parent
      // drops a duplicate already in flight (src/render.mjs's
      // stageMermaidPrelude, src/ui.mjs's handleStageMermaid), so the ordering
      // cannot decide the outcome any more. Retrying would hide exactly that
      // regression coming back; if this ever needs an attempt loop again, the
      // resend is broken and the loop is the wrong fix.
      await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
        const archiveStage = await openArchivePage(send, onEvent, archive.pageUrl);
        await waitForTruthy(
          send, archiveStage.stageSessionId,
          `!!(document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}) && document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}).querySelector('svg'))`,
          20000,
        );
      });
    });
    rmSync(archive.dest, { recursive: true, force: true });

    await check('AC4 (archive): no non-file: request left the machine, ever', async () => {
      // Covers everything observed so far (served + archive): the witness
      // proxy is a single long-lived process the check itself owns, so this
      // is cumulative across every Chrome process by construction.
      const offenders = witness.seen.filter(e => !isChromeInfra(e.hostname));
      assert.deepEqual(offenders, [], `witness proxy saw a non-loopback, non-Chrome-infra request: ${JSON.stringify(offenders, null, 2)}`);
      const jsdelivr = witness.seen.filter(e => /jsdelivr/i.test(e.hostname) || /jsdelivr/i.test(e.url || ''));
      assert.deepEqual(jsdelivr, [], `the CDN fallback actually reached the network: ${JSON.stringify(jsdelivr)}`);
    });

    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      await check('DEGRADE: engine sibling missing -> raw diagram source, never blank', async () => {
        witness.setPhase('degrade-missing');
        const missing = copyArchive(pagesDir, boardId, { dropMermaid: true });
        assert.ok(!missing.copiedSiblings.some(n => MERMAID_ASSET_NAME.test(n)), 'mermaid sibling was copied despite dropMermaid');
        const stage = await openArchivePage(send, onEvent, missing.pageUrl);
        // No positive condition to poll for here -- openArchivePage's own
        // settle window is the honest wait; nothing further to wait on.
        const svgCount = await evalIn(send, stage.stageSessionId, `document.querySelectorAll('svg').length`);
        const figureText = await evalIn(send, stage.stageSessionId, `(function () { var el = document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}); return el ? el.textContent : null; })()`);
        assert.equal(svgCount, 0, 'a diagram rendered despite the engine sibling being missing');
        assert.ok(typeof figureText === 'string' && figureText.includes(diagramSourceHint), `figure is not showing raw diagram source: ${JSON.stringify(figureText)}`);
        rmSync(missing.dest, { recursive: true, force: true });
      });
    });

    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      await check('DEGRADE: engine sibling corrupt -> raw diagram source, never blank', async () => {
        witness.setPhase('degrade-corrupt');
        const corrupt = copyArchive(pagesDir, boardId, { corruptMermaid: true });
        const stage = await openArchivePage(send, onEvent, corrupt.pageUrl);
        const svgCount = await evalIn(send, stage.stageSessionId, `document.querySelectorAll('svg').length`);
        const figureText = await evalIn(send, stage.stageSessionId, `(function () { var el = document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}); return el ? el.textContent : null; })()`);
        assert.equal(svgCount, 0, 'a diagram rendered despite a corrupt engine sibling');
        assert.ok(typeof figureText === 'string' && figureText.includes(diagramSourceHint), `figure is not showing raw diagram source: ${JSON.stringify(figureText)}`);
        rmSync(corrupt.dest, { recursive: true, force: true });
      });
    });

    await check('AC4 (final): still nothing non-loopback across the whole run, including both degrade passes', async () => {
      const offenders = witness.seen.filter(e => !isChromeInfra(e.hostname));
      assert.deepEqual(offenders, [], `witness proxy saw a non-loopback, non-Chrome-infra request: ${JSON.stringify(offenders, null, 2)}`);
    });
  } finally {
    await daemon.stop();
    rmSync(daemon.home, { recursive: true, force: true });
    await witness.close();
  }

  console.log(`\nartifact: ${ARTIFACT_PATH}`);
  console.log(`witness proxy observed ${witness.seen.length} request(s) total (loopback + Chrome infra included):`);
  for (const e of witness.seen) console.log(`  [${e.phase}] ${e.kind} ${e.hostname}:${e.port} ${e.url}`);

  if (failures) {
    console.error(`\n${failures} assertion group(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall assertions ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
