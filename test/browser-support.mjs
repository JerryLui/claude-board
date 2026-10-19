// The Chrome/CDP harness the four real-browser checks share:
// test/browser-check-stage-fold.mjs, test/browser-check-mermaid-stage.mjs,
// test/browser-check-video.mjs and test/browser-check-round-width.mjs. The branch's
// own bin/daemon.mjs on a scratch port and a scratch store, headless Chrome over the
// DevTools Protocol with Node's native WebSocket (zero npm dependencies), and a
// `--proxy-server` witness for the checks that assert what left the machine. A fix
// for a CDP trap lands here once.
//
// Not a check, and no browser check is on test/run.mjs's explicit list: that suite
// has to pass on a machine with no Chrome installed. Each browser check stays
// runnable alone, by hand.
//
// Where the copies this replaced had drifted, the drift that changes what a passing
// run does is a parameter (`withChrome`'s `proxyPort` and `hideScrollbars`,
// `guardRun`'s `deadlineMs`, `evalIn`'s `awaitPromise` and `gesture`); the drift
// that changed only how a broken run ends (a timeout on a DevTools reply, a SIGKILL
// after a Chrome that will not quit) took the stricter copy.

import { spawn } from 'node:child_process';
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { SECRET_HEADER, SESSION_COOKIE } from '../src/secret.mjs';
import { assetsNamedBy } from '../src/assets.mjs';
import { check, freePort, repoRoot, sleep, withTimeout } from './support.mjs';

export const CHROME = process.env.CLAUDE_BOARD_CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Exits 1 with a pointer at the override when there is no Chrome to drive. */
export function requireChrome(label) {
  if (existsSync(CHROME)) return;
  console.error(`${label}: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override).`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Every child a check starts through this file dies with it, on every exit path:
// the normal finally blocks, a thrown error, Ctrl-C, and the whole-run watchdog.
const children = new Set();
const scratchDirs = new Set();
function killAll() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  for (const d of scratchDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** Kills every child and removes every scratch dir on exit and on SIGINT/SIGTERM,
 * and, given `deadlineMs`, ends the whole run with a failure once it has run that
 * long, so a hung Chrome or daemon is a red run and not a stuck one. */
export function guardRun(label, { deadlineMs = null } = {}) {
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });
  if (deadlineMs == null) return;
  const watchdog = setTimeout(() => {
    console.error(`${label}: the whole run passed ${deadlineMs}ms; killing Chrome and the daemon`);
    process.exit(1);
  }, deadlineMs);
  watchdog.unref();
}

/** A fresh temp dir, removed on exit if nothing removed it first. */
export function scratchDir(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.add(d);
  return d;
}

/** One row through test/support.mjs's `check`, plus a `note(line)` handed to `fn`:
 * each note prints under the row's own line as `  # <line>`, pass or fail. A row
 * that measures a real browser reads numbers worth seeing beside a pass too. */
export async function row(name, fn) {
  const notes = [];
  await check(name, () => fn(line => notes.push(line)));
  for (const line of notes) console.log(`  # ${line}`);
}

// ---------------------------------------------------------------------------
// Headless Chrome over CDP. QUIRKS.md "The worktree hook refuses Chrome launched
// from the shell": it is spawned from node, never from a quoted shell path.
//
// Scrollbars follow the Mac's "Show scroll bars" setting (QUIRKS.md "Headless Chrome's
// scrollbars follow the Mac's Show scroll bars setting"), so a check that measures a
// bar picks one: `hideScrollbars` zeroes every bar; `classicScrollbars` draws classic
// 15px ones whatever the setting; with neither, the setting decides. `proxyPort`
// routes every request through the witness below and adds the flags that quiet the
// background traffic it would otherwise record.
//
// `classicScrollbars` is `-AppleShowScrollBars Always`, which macOS reads off any app's
// command line as a defaults override, in this Chrome only. Headless Chrome opens every
// bare argument as a page and refuses two, so `Always` replaces `about:blank` as the one
// it opens, and runs from the profile dir, where an empty file of that name makes the
// page a local file, not a lookup of the host `always`.
function launchChrome({ tag, proxyPort = null, hideScrollbars = false, classicScrollbars = false }) {
  if (hideScrollbars && classicScrollbars) throw new Error('withChrome: hideScrollbars and classicScrollbars contradict');
  const profile = scratchDir(`${tag}-profile-`);
  if (classicScrollbars) writeFileSync(path.join(profile, 'Always'), '');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu',
    ...(hideScrollbars ? ['--hide-scrollbars'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--window-size=1280,900',
    ...(proxyPort == null ? [] : [`--proxy-server=127.0.0.1:${proxyPort}`]),
    '--disable-background-networking', '--disable-sync', '--disable-default-apps',
    '--disable-component-update', '--no-first-run', '--no-default-browser-check',
    ...(proxyPort == null ? [] : [
      '--disable-domain-reliability',
      '--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication,NetworkTimeServiceQuerying',
    ]),
    ...(classicScrollbars ? ['-AppleShowScrollBars', 'Always'] : ['about:blank']),
  ], { stdio: 'ignore', cwd: classicScrollbars ? profile : undefined });
  children.add(chrome);
  let chromeFailed = null;
  chrome.on('error', err => { chromeFailed = err; });

  async function endpoint() {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const [livePort, wsPath] = readFileSync(portFile, 'utf8').split('\n');
        if (livePort && wsPath) return `ws://127.0.0.1:${livePort.trim()}${wsPath.trim()}`;
      } catch { /* not written yet */ }
      if (chromeFailed) throw new Error(`could not start ${CHROME}: ${chromeFailed.message}`);
      if (chrome.exitCode !== null) throw new Error(`chrome exited with ${chrome.exitCode}`);
      if (Date.now() >= deadline) throw new Error('chrome never came up');
      await sleep(100);
    }
  }

  async function cleanup() {
    const exited = chrome.exitCode !== null || chrome.signalCode !== null
      ? Promise.resolve()
      : new Promise(res => chrome.once('exit', res));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
    children.delete(chrome);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    scratchDirs.delete(profile);
  }

  return { endpoint, cleanup };
}

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
  const send = (method, params = {}, sessionId) => withTimeout(new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  }), 15000, `devtools ${method} never answered`);
  const onEvent = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  return { send, onEvent };
}

/** Runs `fn({ send, onEvent })` against one Chrome process started for it, torn
 * down afterward however `fn` ends. `send(method, params, sessionId)` answers a
 * DevTools command (15s, then it rejects); `onEvent(listener)` hears every event
 * and hands back its own unsubscribe. `tag` names the profile's temp dir. */
export async function withChrome({ tag, proxyPort = null, hideScrollbars = false, classicScrollbars = false }, fn) {
  const chrome = launchChrome({ tag, proxyPort, hideScrollbars, classicScrollbars });
  let ws;
  try {
    ws = new WebSocket(await chrome.endpoint());
    await withTimeout(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('devtools websocket failed to open')), { once: true });
    }), 10000, 'devtools websocket never opened');
    return await fn(connectDevtools(ws));
  } finally {
    if (ws) { try { ws.close(); } catch {} }
    await chrome.cleanup();
  }
}

/** Evaluates `expression` in one target's execution context and answers its value.
 * `awaitPromise` waits on a promise the expression returns; `gesture` runs it under
 * user activation, as a click would (a media element's play() asks for one). */
export async function evalIn(send, sessionId, expression, { awaitPromise = false, gesture = false } = {}) {
  const params = { expression, returnByValue: true };
  if (awaitPromise) params.awaitPromise = true;
  if (gesture) params.userGesture = true;
  const { result, exceptionDetails } = await send('Runtime.evaluate', params, sessionId);
  if (exceptionDetails) throw new Error(`eval threw: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
}

/** Puts the live board's session cookie in the profile's jar before a navigation:
 * every read route past `/api/health` needs `cb_session`, and a check has no
 * reviewer's browser to hand it one through the single-use `/auth/:token` handoff.
 * `cookie` is `sessionToken(daemon.secret)`, derived from the scratch daemon's own
 * secret (src/secret.mjs), so minting it here is the credential model applied by a
 * caller that already holds the one secret that makes it valid, not a way round it.
 * `sp(method, params)` sends to the page's own session. */
export async function setSessionCookie(sp, cookie) {
  await sp('Network.enable');
  await sp('Network.setCookie', {
    name: SESSION_COOKIE, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict',
  });
}

// ---------------------------------------------------------------------------
// Daemon: the branch's own bin/daemon.mjs, scratch port, scratch store, and an
// osascript stub first on PATH (QUIRKS.md "Any check that boots a daemon will raise
// real banners"). test/support.mjs's `freePort` picks the port: QUIRKS.md
// "`CLAUDE_BOARD_PORT=0` silently becomes 7391".
export async function startScratchDaemon(tag) {
  const home = scratchDir(`${tag}-home-`);
  const secretFile = path.join(home, 'secret');
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  const stubDir = path.join(home, 'stub-bin');
  mkdirSync(stubDir);
  writeFileSync(path.join(stubDir, 'osascript'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(stubDir, 'osascript'), 0o755);
  const wantPort = await freePort();

  const child = spawn(process.execPath, [path.join(repoRoot, 'bin', 'daemon.mjs')], {
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_SECRET_FILE: secretFile,
      CLAUDE_BOARD_PORT: String(wantPort),
      CLAUDE_BOARD_STRANDED_GRACE_MS: String(24 * 60 * 60 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
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
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(res => child.once('exit', res)), sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    children.delete(child);
    rmSync(home, { recursive: true, force: true });
    scratchDirs.delete(home);
  }

  return { home, secret, port, stop };
}

export function postJson(urlStr, body, secret) {
  return withTimeout(new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), [SECRET_HEADER]: secret },
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
  }), 10000, 'POST /api/board never answered');
}

/** The page plus every sibling it names, copied out of the scratch store's pages/
 * into a plain temp dir: the file set a reviewer has when they open an archived
 * board from Finder, with no daemon behind it. */
export function copyArchive(pagesDir, boardId, tag) {
  const dest = scratchDir(`${tag}-archive-`);
  const pageBytes = readFileSync(path.join(pagesDir, `${boardId}.html`), 'utf8');
  const siblings = assetsNamedBy(pageBytes);
  copyFileSync(path.join(pagesDir, `${boardId}.html`), path.join(dest, `${boardId}.html`));
  for (const name of siblings) copyFileSync(path.join(pagesDir, name), path.join(dest, name));
  return { dest, pageUrl: `file://${path.join(dest, `${boardId}.html`)}`, pageBytes, siblings };
}

// ---------------------------------------------------------------------------
// The network witness. A per-target DevTools Protocol Network.enable races a
// brand-new OOPIF's own first resource load and loses (QUIRKS.md "CDP
// `Network.enable` misses a brand-new OOPIF's first bytes"): a sandboxed
// opaque-origin srcdoc iframe is its own Chrome TARGET, and a tag at the very front
// of its srcdoc dispatches before an async attach-then-enable chain can land, even
// with waitForDebuggerOnStart. `Network.requestWillBeSent` for that request never
// arrives on any session, on any Chrome build tried.
//
// A forward proxy sidesteps the race: Chrome's `--proxy-server` applies at the
// network-service level, for every renderer process and every frame regardless of
// OOPIF boundaries or CDP session timing, so a request this proxy never sees is a
// request that never left the machine, not one the harness failed to observe in
// time. An OOPIF srcdoc's own `<script src>` to an external host does show up here,
// first byte and all.
//
// 127.0.0.1 traffic (a live board's own daemon) is forwarded for real, because
// Chrome does not always route loopback through a configured proxy (it bypasses it
// on this machine) but a version that did would need this to still work. Anything
// else is recorded and refused: the host it would have reached does not exist.
export function createWitnessProxy() {
  const seen = [];
  const record = (kind, hostname, port, url) => seen.push({ kind, hostname, port, url, phase: currentPhase });
  let currentPhase = 'setup';

  // Chrome tears the raw socket down (ECONNRESET) the instant it reads a refusal,
  // on both paths below: a 502 body it has no use for, or a deliberately closed
  // CONNECT tunnel. Every socket this proxy touches therefore needs its own
  // 'error' listener: an 'error' event with nobody listening is fatal, not logged.
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
// captive-portal probes) survives every `--disable-*` flag tried on this machine.
// Named explicitly rather than matched loosely, so a genuinely new host still fails
// a check instead of slipping through a vague wildcard, and so this list is the one
// place that changes if Chrome's own traffic does.
const CHROME_INFRA_SUFFIXES = ['.google.com', '.googleapis.com', '.gstatic.com', '.googleusercontent.com'];
export function isChromeInfra(hostname) {
  return CHROME_INFRA_SUFFIXES.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}
