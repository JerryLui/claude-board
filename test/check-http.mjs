// Headless HTTP round-trip check: starts a daemon on an ephemeral port against a
// temp CLAUDE_BOARD_HOME, posts a board, fetches the served page, submits answers
// over HTTP, asserts the blocked /wait call's packet and the store JSON, and asserts
// the loopback Host refusal. No browser, no real network beyond 127.0.0.1.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { HANDOFF_TOKEN_RE, recoveryCommand, repoRoot } from '../src/handoff.mjs';
import { startServer, activeWaitCount, buildPacketWithUndelivered, DEFAULT_WAIT_TIMEOUT_MS } from '../src/server.mjs';
import { DEFAULT_AWAIT_TIMEOUT_MS, STRANDED_BANNER, ANSWERS_DELIVERED, MAX_SUBMIT_COMMENTS, MAX_ANSWER_CHOICES, createBoard } from '../src/board.mjs';
// The one cap every by-value string on a board shares (src/resolve.mjs), read rather
// than restated so a check cannot pass against a number the product no longer uses.
import { MAX_REF_BYTES } from '../src/resolve.mjs';
import { readBoard, writeBoard, searchBoards } from '../src/store.mjs';
// Used only to ARRANGE fixture states the HTTP surface itself has no fast way to reach
// (a nonzero cycle, a timer already mid-break) -- every ASSERTION below still goes
// through the HTTP routes, never these directly. See the pomodoro checks near the
// bottom of this file.
import { readDoc as readPomodoroDoc, writeDoc as writePomodoroDoc } from '../src/pomodoro.mjs';
import { cueNames, NO_CUE } from '../src/cues.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { assetsNamedBy, MERMAID_ASSET, SCRIPT_ASSET, STYLE_ASSET } from '../src/assets.mjs';
import { isPageRound } from '../src/badge.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

// fetch()/undici refuse to let callers override the Host header (it's a forbidden
// header per the Fetch spec) — exactly like a browser. A DNS-rebinding attacker
// doesn't go through fetch()'s header allowlist either: the TCP connection lands on
// 127.0.0.1 while the Host header still names the attacker's domain. node:http.request
// has no such restriction, so it is what actually exercises the loopback Host check.
//
// It is also the only way to exercise the cross-origin write guard: `Origin` and
// `Sec-Fetch-Site` are forbidden headers for fetch() too — a browser sets them itself,
// which is precisely why they are trustworthy — so a check that wants to speak as a page
// on https://evil.example has to write the request by hand.
function rawRequest(port, method, pathName, host, { headers = {}, body = null } = {}) {
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

/** Strip the #board-data JSON payload from a served page, leaving only the block markup
 * that renderBlock actually emitted. A block-kind-coverage assertion against the raw page
 * is unsafe: any field value on a block (a label, a snippet of prose) is also present in
 * the JSON board.blocks the page inlines verbatim for hydration, and finding it there
 * proves nothing about whether the corresponding renderBlock case ran.
 *
 * This used to strip two more things, for the same reason: the inlined `<style>` block
 * (where a class name like "compare-grid" is also a CSS selector) and the inlined client
 * `<script type="module">` (where it is also a querySelector string literal). Since ADR 70
 * the page carries neither -- it names them as sibling files -- so the JSON payload is the
 * only haystack left that can produce a false positive. */
function renderedMarkup(html) {
  return html.replace(/<script id="board-data"[^>]*>[\s\S]*?<\/script>/, '');
}

/** Recursively hash every file under `dir`, keyed by path relative to `dir`. Used to
 * prove "answering mutates only the store JSON" -- a plain string-content diff
 * would miss a same-length overwrite, so this is a content hash, not just a size or
 * mtime check (mtime is included too, since a real write always bumps it, but the
 * hash is what the assertions key off). */
function snapshotTree(dir) {
  const out = new Map();
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const buf = readFileSync(full);
        out.set(path.relative(dir, full), {
          sha: createHash('sha256').update(buf).digest('hex'),
          bytes: buf,
        });
      }
    }
  }
  walk(dir);
  return out;
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

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-http-'));
process.env.CLAUDE_BOARD_HOME = home;

// The local secret, in this check's own temp dir — never ~/.config/claude-board. Set
// before startServer below, because the daemon reads it once at startup. Every route
// but /api/health requires a credential now: writes require a loopback Host check, an
// origin check, and a local secret; reads require gated read routes.
const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'a'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

/** Headers for a write: what the shim sends. Every POST below goes through this, so a
 * write route that stopped requiring the secret would still pass — which is why the
 * 401 checks near the bottom send requests that deliberately do not. */
function writeHeaders(extra) {
  return { 'content-type': 'application/json', [SECRET_HEADER]: SECRET, ...(extra || {}) };
}

/** `fetch`, shadowed for this module only, carrying the secret on every call.
 *
 * Reads are gated now, so a plain `fetch('/b/:id')` is refused — and
 * this check is a hundred-odd requests exercising rendering, waiting, SSE and the store,
 * none of which are about the credential. Rather than thread a header through every one,
 * the default here is "a caller that holds the secret", which is what the shim is.
 *
 * Everything that is about the credential deliberately does NOT go through here: the
 * gate checks below use `rawRequest` (which sends exactly the headers it is given) and
 * `rawFetch`, so they can speak as a caller holding nothing, or holding only a cookie.
 * An explicit header in `init` still wins, since it is spread last. */
const rawFetch = globalThis.fetch;
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { [SECRET_HEADER]: SECRET, ...(init.headers || {}) } });
}

/** The cookie an authorized browser sends back, as a Cookie header value. Derived from
 * the secret exactly as src/server.mjs derives it, so a check can act as a browser that
 * has already been through a handoff without doing one first. */
function sessionCookieHeader() {
  return `${SESSION_COOKIE}=${sessionToken(SECRET)}`;
}

// Out of reach, exactly as test/run.mjs pushes it for the whole suite and for the same
// reason: this file boots a daemon and posts awaited rounds into it that nobody ever
// looks at, which is precisely what the stranded rule announces. `??=` so the suite's
// own value still wins; what this adds is that running this check ALONE behaves the same
// way -- no real banners, and no stranded write landing on a board mid-check and moving
// the store under the walk-count assertions near the bottom of this file.
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS ??= String(24 * 60 * 60 * 1000);

// Short heartbeat so the SSE checks below can prove the stream survives past one
// (or several) heartbeat intervals without a multi-second sleep. Read live by
// src/server.mjs on every new connection, so setting it any time before opening a
// connection (even after startServer() below) takes effect.
const SSE_HEARTBEAT_MS = 40;
process.env.CLAUDE_BOARD_SSE_HEARTBEAT_MS = String(SSE_HEARTBEAT_MS);

// Source fixture files for reference-resolution checks, kept under the same temp
// root as the store rather than anywhere in the real filesystem.
const srcDir = path.join(home, 'src-fixtures');

/** A real, existing project directory to post as a board's `cwd`. A board's `cwd` is
 * the root every content reference is confined to (PROTOCOL.md "Reference confinement
 * and caps"), so it is validated at post time: it has to exist, be a directory, and not
 * be `/` or `$HOME`. Checks that only ever used it as an index/search LABEL therefore
 * cannot pass a made-up `/Users/tester/...` string any more -- they get a real
 * directory under the same temp root, which is also closer to what a session actually
 * sends. */
// Returns the REALPATH, because that is what the board stores: the value is
// canonicalised when it is bound, so what the board records is the actual directory its
// content came from (on macOS /var is a symlink to /private/var, which is exactly the
// kind of difference that makes an un-canonicalised cwd useless as an audit record).
function projectDir(name) {
  const dir = path.join(home, 'projects', name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/** Open a raw SSE connection (no EventSource in node:http) to
 * /api/board/:id/events and parse `event:`/`data:` frames plus bare `:` comment
 * lines (heartbeats) out of the byte stream as they arrive. Returns immediately
 * with handles to the live request/response and a running `events` array the
 * caller polls; the caller is responsible for destroying `req` when done. */
function openSseClient(port, boardId, { headers = { [SECRET_HEADER]: SECRET } } = {}) {
  return new Promise((resolveOpen, rejectOpen) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}`, ...headers } },
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
            } else {
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

let server, port, base;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  await check('health check responds ok', async () => {
    const r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });

  let boardId, boardUrl;

  await check('POST /api/board writes the board to the store', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'HTTP round trip',
        blocks: [
          { kind: 'markdown', text: '# Acceptance Criteria\n\n- one\n- two\n\n## Notes\n\nprose here' },
          // ADR.md entry 28 leaves `mermaid` and `html` as the only commentable
          // kinds, so the comments submitted below are anchored here rather than on
          // the markdown block above.
          { kind: 'mermaid', text: 'flowchart LR\n  one --> two' },
          {
            kind: 'question',
            prompt: 'Ship ticket 01?',
            widget: 'single',
            options: [{ label: 'Yes', description: 'looks solid' }, { label: 'No' }],
            context: [{ kind: 'markdown', text: '# Context\n\nsome supporting prose' }],
          },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.boardId, /^b_[0-9a-f]{32}$/);
    assert.equal(j.round, 1);
    assert.ok(j.url.includes(j.boardId));
    boardId = j.boardId;
    boardUrl = j.url;

    const stored = readBoard(boardId, home);
    assert.ok(stored, 'board must be written to the store as JSON');
    assert.equal(stored.title, 'HTTP round trip');
    assert.equal(stored.blocks[0].kind, 'markdown');
    assert.ok(stored.blocks[0].anchors.some(a => a.ref === 'acceptance-criteria-li1'));
    assert.equal(stored.blocks[1].kind, 'mermaid');
    assert.equal(stored.blocks[2].kind, 'question');
    assert.equal(stored.blocks[2].id, 'q1');
  });

  await check('GET /b/:id serves the page with anchors and inlined JSON', async () => {
    const r = await fetch(`${base}/b/${boardId}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('id="board-data"'));
    assert.ok(html.includes(JSON.stringify(boardId)));
    assert.ok(html.includes('id="acceptance-criteria"'));
    assert.ok(html.includes('id="acceptance-criteria-li1"'));
    assert.ok(html.includes('id="acceptance-criteria-li2"'));
    assert.ok(html.includes('data-choice="Yes"'));
  });

  await check('the emitted page projection is also written to pages/', async () => {
    const pagePath = path.join(home, 'pages', `${boardId}.html`);
    assert.ok(existsSync(pagePath), 'page projection must be written under pages/');
    const html = readFileSync(pagePath, 'utf8');
    assert.ok(html.includes('id="board-data"'));
  });

  await check('/wait blocks until the round is sent, then resolves with the packet', async () => {
    const waitPromise = fetch(`${base}/api/board/${boardId}/wait?round=1`).then(r => r.json());

    // give the wait a moment to actually start blocking before we submit
    await new Promise(resolve => setTimeout(resolve, 150));

    const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'ship it' }],
        comments: [
          { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'two' }, text: 'criterion 2 comment' },
          { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'ghost' }, text: 'stale anchor comment' },
        ],
      }),
    });
    assert.equal(submitRes.status, 200);

    const packet = await waitPromise;
    assert.equal(packet.board, boardId);
    assert.equal(packet.round, 1);
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.url, boardUrl);

    assert.equal(packet.answers.length, 1);
    assert.equal(packet.answers[0].id, 'q1');
    assert.equal(packet.answers[0].status, 'answered');
    assert.equal(packet.answers[0].choice, 'Yes');
    assert.equal(packet.answers[0].note, 'ship it');

    assert.equal(packet.comments.length, 2);
    // ADR 99: the packet carries no `resolved` key at all -- `lost` alone tells
    // a resolved comment from a lost one.
    for (const c of packet.comments) assert.equal('resolved' in c, false);
    const resolved = packet.comments.find(c => c.anchor.ref === 'two');
    assert.equal(resolved.lost, undefined);
    const lost = packet.comments.find(c => c.anchor.ref === 'ghost');
    assert.equal(lost.lost, 'ghost');
  });

  await check('the store JSON reflects the submit: answers, comments, sent round', async () => {
    const stored = readBoard(boardId, home);
    assert.equal(stored.state, 'submitted');
    assert.equal(stored.rounds[0].status, 'sent');
    assert.ok(stored.rounds[0].sentAt);
    assert.equal(stored.answers.q1.status, 'answered');
    assert.equal(stored.answers.q1.choice, 'Yes');
    assert.equal(stored.comments.length, 2);
    assert.equal(stored.comments[0].n, 1);
    assert.equal(stored.comments[1].n, 2);
  });

  await check('a second round pushed into the live thread continues ids and rounds', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId,
        blocks: [{ kind: 'markdown', text: '# Round Two\n\n- a\n- b' }],
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.round, 2);
    const stored = readBoard(boardId, home);
    assert.equal(stored.rounds.length, 2);
    assert.equal(stored.rounds[1].status, 'open');
    const newBlock = stored.blocks.find(b => b.round === 2);
    assert.equal(newBlock.id, 'd3'); // d1 (top-level md), d2 (nested question context) already minted
  });

  await check('a request whose Host header is not loopback is refused with 403 and no body', async () => {
    const r = await rawRequest(port, 'GET', '/api/health', 'evil.example.com');
    assert.equal(r.status, 403);
    assert.equal(r.body, '');
  });

  await check('a non-loopback Host is refused on every route, not just health', async () => {
    const routes = [
      ['GET', '/'],
      ['GET', `/b/${boardId}`],
      ['POST', '/api/board'],
      ['GET', `/api/board/${boardId}/wait?round=1`],
      ['GET', `/api/board/${boardId}/events`],
      ['POST', `/api/board/${boardId}/submit`],
    ];
    for (const [method, pathName] of routes) {
      const r = await rawRequest(port, method, pathName, 'attacker.test');
      assert.equal(r.status, 403, `${method} ${pathName} must refuse a non-loopback Host`);
      assert.equal(r.body, '', `${method} ${pathName} must send no body on refusal`);
    }
  });

  await check('a loopback Host with an explicit port is still accepted', async () => {
    const r = await rawRequest(port, 'GET', '/api/health', `127.0.0.1:${port}`);
    assert.equal(r.status, 200);
  });

  // --- SSE round pushes into a live thread --------------------------

  await check('POST /api/board reports how many browsers have the board open, from the real subscriber set', async () => {
    // `clients` stays published protocol even though the shim's forced reopen that
    // once read it is gone (ADR 55): the daemon computes this count anyway, for the
    // stranded rule's own use (test/check-stranded.mjs), so deleting the field would
    // be a protocol change bought for nothing.
    // Ablation: delete the `clients` field from handlePostBoard's response and this reds.
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Client count', blocks: [{ kind: 'markdown', text: '# One' }] }),
    })).json();
    assert.equal(created.clients, 0, 'a board nobody has open reports zero, not null and not absent');

    const watcher = await openSseClient(port, created.boardId);
    const withOne = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: created.boardId, title: 'Client count', blocks: [{ kind: 'markdown', text: '# Two' }] }),
    })).json();
    assert.equal(withOne.clients, 1, 'an open stream is one connected client');

    watcher.res.destroy();
    // The unsubscribe runs on the socket's close event, not synchronously with destroy().
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterClose = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: created.boardId, title: 'Client count', blocks: [{ kind: 'markdown', text: '# Three' }] }),
    })).json();
    assert.equal(afterClose.clients, 0, 'a closed tab drops back to zero, which is what the stranded rule watches for');
  });

  await check('a retried post carrying the same requestId is applied once, not appended twice', async () => {
    // The daemon applies the round and broadcasts before the
    // response is sent, so a socket that dies in between leaves the round landed and the
    // caller told it failed. The retry used to amend a second copy of every block into
    // the open round -- the reviewer saw the same question twice.
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Idempotent', blocks: [{ kind: 'markdown', text: '# One' }] }),
    })).json();
    await fetch(`${base}/api/board/${created.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });

    const round2 = { boardId: created.boardId, title: 'Idempotent', blocks: [{ kind: 'question', prompt: 'Ship?', widget: 'single', options: [{ label: 'Yes' }] }], requestId: 'abc123' };
    const first = await (await fetch(`${base}/api/board`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(round2) })).json();
    const retry = await (await fetch(`${base}/api/board`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(round2) })).json();

    assert.equal(retry.deduped, true, 'the daemon must say it recognised the retry rather than silently reapplying');
    assert.equal(retry.round, first.round, 'a retry does not advance the round');
    const board = JSON.parse(readFileSync(path.join(home, 'boards', `${created.boardId}.json`), 'utf8'));
    const prompts = board.blocks.filter(b => b.kind === 'question' && b.round === first.round);
    assert.equal(prompts.length, 1, `the retried round must hold ONE question, not two (got ${prompts.length})`);
    // A genuinely different round still lands: dedupe is on the id, not on "any repeat".
    const round3 = { ...round2, requestId: 'def456', blocks: [{ kind: 'question', prompt: 'Ship now?', widget: 'single', options: [{ label: 'Yes' }] }] };
    const third = await (await fetch(`${base}/api/board`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(round3) })).json();
    assert.notEqual(third.deduped, true, 'a different requestId is a different request');
  });

  await check('GET /api/board/:id/events streams a new-round push to two clients, additively -- only the new round, not the whole board', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'SSE round push', blocks: [{ kind: 'markdown', text: '# Round One\n\nfirst round prose' }] }),
    })).json();
    const sseBoardId = created.boardId;

    // round 1 must be sent before a push counts as a brand-new round rather than
    // an amend of the still-open one (see the amend check below).
    await fetch(`${base}/api/board/${sseBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });

    const clientA = await openSseClient(port, sseBoardId);
    const clientB = await openSseClient(port, sseBoardId);
    assert.equal(clientA.status, 200);
    assert.equal(clientA.res.headers['content-type'], 'text/event-stream; charset=utf-8');

    // Let several heartbeat intervals elapse with nothing pushed, proving the
    // connection survives idle time rather than a proxy/timer dropping it. The
    // initial `: connected` comment sent at subscribe time is deliberately NOT
    // what this counts -- that would pass even with the interval itself removed.
    // What's asserted is repeated `: heartbeat` comments arriving over time, which
    // can only come from the recurring interval.
    await new Promise(resolve => setTimeout(resolve, SSE_HEARTBEAT_MS * 5));
    const heartbeats = clientA.events.filter(e => e.comment === 'heartbeat');
    assert.ok(heartbeats.length >= 2, `expected at least 2 interval heartbeats over ${SSE_HEARTBEAT_MS * 5}ms at a ${SSE_HEARTBEAT_MS}ms cadence, got ${heartbeats.length} (ablation: disabling the interval's write, while still opening the connection, drops this to 0)`);
    assert.ok(!clientA.res.destroyed, 'the SSE connection must still be open after surviving several heartbeat intervals');

    const pushRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: sseBoardId, blocks: [{ kind: 'markdown', text: '# Round Two\n\nsecond round prose' }] }),
    });
    assert.equal(pushRes.status, 200);
    const pushed = await pushRes.json();
    assert.equal(pushed.round, 2);

    await new Promise(resolve => setTimeout(resolve, 200));

    for (const client of [clientA, clientB]) {
      const roundEvent = client.events.find(e => e.event === 'round');
      assert.ok(roundEvent, 'every connected client must receive the round push');
      assert.equal(roundEvent.data.round, 2);
      assert.equal(roundEvent.data.mode, 'new-round');
      assert.deepEqual(roundEvent.data.blockIds, ['d2']); // d1 is round 1's markdown; the new block continues the sequence
      assert.ok(roundEvent.data.html.includes('second round prose'), 'the pushed fragment must carry the new round\'s content');
      // The core additivity proof: the fragment must be ONLY the new round.
      // (Ablation: broadcasting the full renderBoardPage() output, or even the
      // full board's rendered blocks, here would include "first round prose" and
      // fail this.)
      assert.ok(!roundEvent.data.html.includes('first round prose'), 'the pushed fragment must not include round 1\'s content -- proves an additive push, not a wholesale re-render');
      assert.equal(roundEvent.data.board.rounds.length, 2);
      assert.equal(roundEvent.data.board.rounds[0].status, 'sent');
      assert.equal(roundEvent.data.board.rounds[1].status, 'open');
    }

    const stored = readBoard(sseBoardId, home);
    assert.equal(stored.rounds.length, 2);
    assert.equal(stored.blocks[1].round, 2);

    clientA.req.destroy();
    clientB.req.destroy();
  });

  await check('POST /api/board pushed while the round is still open amends that round in place instead of minting a new one, and streams only the changed block', async () => {
    // The question block is what makes this round AMENDABLE at all: a round that
    // asks nothing is complete the moment it lands and a later post opens a new
    // round beside it instead (PROTOCOL.md "POST /api/board", and the two-ask
    // check further down). "The agent is still assembling this round" is the
    // situation the amend rule exists for, and it is the situation this fixture
    // now actually describes.
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Amend target',
        blocks: [
          { kind: 'markdown', text: '# Original\n\noriginal text' },
          { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      }),
    })).json();
    const amendBoardId = created.boardId;
    const originalBlockId = readBoard(amendBoardId, home).blocks[0].id;

    const client = await openSseClient(port, amendBoardId);
    await new Promise(resolve => setTimeout(resolve, 60)); // let the subscription land before pushing

    // The round is still open (never submitted): this must amend round 1 in place.
    const amendRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: amendBoardId, blocks: [{ id: originalBlockId, kind: 'markdown', text: '# Amended\n\nreplaced text' }] }),
    });
    assert.equal(amendRes.status, 200);
    const amended = await amendRes.json();
    assert.equal(amended.round, 1, 'amending the still-open round must not mint round 2');

    const stored = readBoard(amendBoardId, home);
    assert.equal(stored.rounds.length, 1, 'no new round is created by an amend');
    assert.equal(stored.blocks.length, 2, 'the amend replaces the block in place rather than appending a duplicate (the round\'s own question is the other one)');
    assert.ok(stored.blocks[0].text.includes('replaced text'));

    await new Promise(resolve => setTimeout(resolve, 200));
    const roundEvent = client.events.find(e => e.event === 'round');
    assert.ok(roundEvent, 'the connected client must receive the amend as a round event too');
    assert.equal(roundEvent.data.mode, 'amend');
    assert.equal(roundEvent.data.round, 1);
    assert.deepEqual(roundEvent.data.blockIds, [originalBlockId]);
    assert.ok(roundEvent.data.html.includes('replaced text'));
    // an amend fragment carries no round wrapper -- src/ui.mjs slots it into the
    // EXISTING round-1 section rather than appending a second one.
    assert.ok(!roundEvent.data.html.includes('class="round '));

    client.req.destroy();
  });

  await check('an amend cannot hijack a block out of an already-sent round by reusing its id', async () => {
    // amendRound matched an incoming id against ALL board.blocks,
    // not just the currently open round's, so an "amend" naming a sent round's
    // block id would move that block into the open round -- silently re-opening
    // an already-answered, already-disabled question for edit, and leaving its
    // real round's page rendering as if it had never been asked.
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Cross-round amend guard',
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }),
    })).json();
    const guardBoardId = created.boardId;
    const q1 = readBoard(guardBoardId, home).blocks[0].id;

    // round 1 answered and sent
    await fetch(`${base}/api/board/${guardBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q1, status: 'answered', choice: 'Yes', note: 'shipped' }], comments: [] }),
    });
    // round 2 opened
    await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: guardBoardId, blocks: [{ kind: 'markdown', text: '# Round Two' }] }),
    });

    // amend round 2, but reuse round 1's already-sent question id
    const hijackRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: guardBoardId, blocks: [{ id: q1, kind: 'question', prompt: 'Wipe the database?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }] }),
    });
    assert.equal(hijackRes.status, 400, 'an amend targeting a block id from a different (already-sent) round must be rejected, not silently applied');

    const stored = readBoard(guardBoardId, home);
    const storedQ1 = stored.blocks.find(b => b.id === q1);
    assert.equal(storedQ1.round, 1, 'the sent round\'s block must stay in round 1');
    assert.equal(storedQ1.prompt, 'Ship it?', 'the sent question\'s prompt must be untouched by the rejected hijack attempt');
    assert.equal(stored.answers[q1].choice, 'Yes', 'the already-recorded answer must survive the rejected hijack attempt');
  });

  await check('a block id that is not a well-formed minted id (e.g. carrying characters that would break a DOM selector) is rejected at post time', async () => {
    // A caller-supplied raw.id reaches src/ui.mjs's amend-lookup
    // DOM selector unescaped; rejecting anything that isn't the `letter+digits`
    // shape src/board.mjs itself mints closes that off at the source rather than
    // leaving every DOM-query call site responsible for re-deriving the guard.
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Malformed id rejected',
        blocks: [{ id: 'd1"], .block[data-block-id="x', kind: 'markdown', text: '# hostile id' }],
      }),
    });
    assert.equal(r.status, 400);
  });

  await check('POST /api/board/:id/submit broadcasts a "submitted" event so another connected client sees the round collapse into history without reloading', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Submit broadcast',
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }),
    })).json();
    const submitBoardId = created.boardId;
    const qid = readBoard(submitBoardId, home).blocks[0].id;

    const client = await openSseClient(port, submitBoardId);
    await new Promise(resolve => setTimeout(resolve, 60));

    const waitPromise = fetch(`${base}/api/board/${submitBoardId}/wait?round=1`).then(r => r.json());
    await fetch(`${base}/api/board/${submitBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'go' }], comments: [] }),
    });
    await waitPromise;

    await new Promise(resolve => setTimeout(resolve, 200));
    const submittedEvent = client.events.find(e => e.event === 'submitted');
    assert.ok(submittedEvent, 'a submit must broadcast a "submitted" event to connected clients');
    assert.equal(submittedEvent.data.round, 1);
    assert.equal(submittedEvent.data.board.rounds[0].status, 'sent');
    assert.equal(submittedEvent.data.board.answers[qid].choice, 'Yes');
    // The event must carry the round RE-RENDERED FROM THE SENT ANSWER, not merely
    // a hint to disable whatever a non-submitting client happened to have on
    // screen: another connected client (which never touched this board's
    // question at all) must be able to render the *actual* choice/note that went
    // out purely from this payload. (Ablation: a client that only received
    // `{round, board}` with no `html` would have nothing to render the correct
    // "Yes"/"go" state from, and would be left showing whatever -- if anything --
    // was already in its own DOM.)
    assert.equal(typeof submittedEvent.data.html, 'string');
    // 'round-current' rides along here because this board's only round is also
    // its newest (ADR.md entry 42: a board opens on its newest page, and
    // renderRoundSection derives that from the board, so a pushed fragment and a
    // fresh load say the same thing). The client re-asserts its own page on
    // arrival, so the class in the payload is a statement, not an instruction.
    assert.ok(submittedEvent.data.html.includes('class="round round-history round-current" data-round="1" data-round-status="sent"'));
    assert.ok(/class="card-choice choice-single selected"[^>]*data-choice="Yes"/.test(submittedEvent.data.html));
    assert.ok(submittedEvent.data.html.includes('go')); // the note that was actually sent
    assert.ok(submittedEvent.data.html.includes('disabled'), 'the re-rendered history fragment must carry disabled controls, same as a fresh page load');

    client.req.destroy();
  });

  await check('a client that disconnects is dropped from the broadcast list rather than leaking', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Disconnect cleanup', blocks: [{ kind: 'markdown', text: '# One' }] }),
    })).json();
    const cleanupBoardId = created.boardId;
    await fetch(`${base}/api/board/${cleanupBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });

    const doomed = await openSseClient(port, cleanupBoardId);
    await new Promise(resolve => setTimeout(resolve, 60));
    doomed.req.destroy();
    await new Promise(resolve => setTimeout(resolve, 60));

    // Pushing a round with the disconnected client's subscription still registered
    // would previously throw inside broadcast() trying to write to a dead socket;
    // asserting the post itself still succeeds is the externally-observable proof
    // that a torn-down connection doesn't wedge later broadcasts.
    const pushRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: cleanupBoardId, blocks: [{ kind: 'markdown', text: '# Two' }] }),
    });
    assert.equal(pushRes.status, 200);
  });

  await check('SSE payloads embed board.comments already run through resolveComment, matching what the initial page hydrates from', async () => {
    // Merge-resolution fix: src/render.mjs's
    // renderBoardPage swaps the raw stored `board.comments` for the
    // resolveComment-run-once shape before embedding #board-data, specifically so
    // src/ui.mjs's pin rendering can read `.resolved`/`.lost` directly without
    // re-deriving them. Before this fix, an SSE push sent the RAW board object --
    // once any push landed, the client's local `board` variable would silently
    // switch shape mid-session and every pin placed after that would read
    // `.resolved` as `undefined`. This proves the SSE payload's `board.comments`
    // carries the same resolved shape the initial page does, for both a
    // resolvable and an unresolvable anchor.
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'SSE resolved comments',
        blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  one --> two' }],
      }),
    })).json();
    const sseBoardId = created.boardId;
    const md1 = readBoard(sseBoardId, home).blocks[0].id;

    const client = await openSseClient(port, sseBoardId);
    await new Promise(resolve => setTimeout(resolve, 60));

    await fetch(`${base}/api/board/${sseBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [
          { blockId: md1, anchor: { kind: 'mermaid', ref: 'one' }, text: 'still resolves' },
          { blockId: md1, anchor: { kind: 'mermaid', ref: 'ghost' }, text: 'never resolves' },
        ],
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 150));

    const submittedEvent = client.events.find(e => e.event === 'submitted');
    assert.ok(submittedEvent, 'expected a submitted event');
    const comments = submittedEvent.data.board.comments;
    assert.equal(comments.length, 2);
    const resolvedOne = comments.find(c => c.anchor && c.anchor.ref === 'one');
    const lostOne = comments.find(c => c.anchor && c.anchor.ref === 'ghost');
    assert.ok(resolvedOne, 'expected the still-resolvable comment in the pushed board.comments');
    assert.equal(resolvedOne.resolved, true, 'a resolvable comment in an SSE payload must carry resolved:true (ablation: sending the raw stored board leaves this field undefined)');
    assert.ok(lostOne);
    assert.equal(lostOne.resolved, false, 'an unresolvable comment in an SSE payload must carry resolved:false, exactly like a fresh page load would show');
    assert.equal(lostOne.lost, 'ghost');
    // resolveComment's output CARRIES round and createdAt rather than dropping them:
    // without them nothing downstream -- the packet, an earlier page, a
    // second tab diffing its own copy -- can tell this round's feedback from a
    // settled earlier round's.
    assert.equal(resolvedOne.round, 1);
    assert.equal(typeof resolvedOne.createdAt, 'string');

    client.req.destroy();
  });

  await check('GET /api/board/:id/events on an unknown board reports 404 rather than opening a stream', async () => {
    const r = await fetch(`${base}/api/board/b_deadbeef/events`);
    assert.equal(r.status, 404);
  });

  // --- thread index, concurrent sessions, archive search ------------

  /** Pull the single `<a class="thread-item...">...</a>` element for one thread out
   * of the index page, so an assertion about its rounds-left count or live/settled
   * class can only be satisfied by that thread's own row, not by some other
   * thread's markup or the inlined stylesheet (thread-item is also a CSS selector
   * in src/styles.mjs, so matching on the bare class name alone proves nothing). */
  function threadRowFor(html, threadId) {
    const re = new RegExp(`<a class="thread-item[^"]*" href="[^"]*" data-thread-id="${threadId}"[\\s\\S]*?</a>`);
    const m = re.exec(html);
    return m ? m[0] : null;
  }

  await check('the index lists a posted thread with its actual rounds-left count, live vs settled', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Index rounds-left count',
        cwd: projectDir('index-project'),
        blocks: [
          { kind: 'question', prompt: 'Q1?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
          { kind: 'question', prompt: 'Q2?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      }),
    });
    const { boardId: idxBoardId, thread: idxThread } = await r.json();

    const before = await (await fetch(`${base}/`)).text();
    const rowBefore = threadRowFor(before, idxThread);
    assert.ok(rowBefore, 'the posted thread must appear in the index');
    // Two question BLOCKS, but one open ROUND that asks something -- the badge
    // counts trips back to the board, never question blocks.
    assert.match(rowBefore, /data-rounds-left="1"/, 'one open round, regardless of how many questions it carries');
    assert.match(rowBefore, /data-live="true"/);
    assert.match(rowBefore, /class="thread-item live"/, 'a thread with an open round must be visually distinct (the "live" class)');

    const [q1, q2] = (await (await fetch(`${base}/b/${idxBoardId}`)).text())
      .match(/data-question-id="([a-z]\d+)"/g)
      .map(s => s.match(/"([a-z]\d+)"/)[1])
      .filter((v, i, arr) => arr.indexOf(v) === i);

    await fetch(`${base}/api/board/${idxBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [
          { id: q1, status: 'answered', choice: 'Yes', note: '' },
          { id: q2, status: 'answered', choice: 'No', note: '' },
        ],
        comments: [],
      }),
    });

    const after = await (await fetch(`${base}/`)).text();
    const rowAfter = threadRowFor(after, idxThread);
    assert.ok(rowAfter);
    assert.match(rowAfter, /data-rounds-left="0"/, 'sending the only open round must drop the rendered count to 0');
    assert.match(rowAfter, /data-live="false"/);
    assert.doesNotMatch(rowAfter, /class="thread-item live"/, 'a settled thread must not carry the live class any more');
  });

  await check('two sessions with live boards in the SAME project directory do not collide', async () => {
    const sameCwd = projectDir('shared-project');

    const postA = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Session A',
        cwd: sameCwd,
        blocks: [
          { kind: 'question', prompt: 'A1?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
          { kind: 'question', prompt: 'A2?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
          { kind: 'question', prompt: 'A3?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      }),
    })).json();

    const postB = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Session B',
        cwd: sameCwd,
        blocks: [
          { kind: 'question', prompt: 'B1?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
          { kind: 'question', prompt: 'B2?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      }),
    })).json();

    assert.notEqual(postA.boardId, postB.boardId);
    assert.notEqual(postA.thread, postB.thread, 'two independent posts to the same cwd must mint two distinct threads');

    const idxHtml = await (await fetch(`${base}/`)).text();
    const rowA = threadRowFor(idxHtml, postA.thread);
    const rowB = threadRowFor(idxHtml, postB.thread);
    assert.ok(rowA && rowB, 'both same-cwd threads must be listed as separate rows');
    // Each thread has exactly one open round -- A's carries three question blocks,
    // B's carries two, and the count must read 1 for both regardless.
    assert.match(rowA, /data-rounds-left="1"/);
    assert.match(rowB, /data-rounds-left="1"/);

    // B's waiter is up before A gets answered, to prove answering A cannot unblock it.
    let bResolved = false;
    const waitB = fetch(`${base}/api/board/${postB.boardId}/wait?round=1`)
      .then(r => r.json())
      .then(packet => { bResolved = true; return packet; });

    await new Promise(resolve => setTimeout(resolve, 150));

    const boardA = readBoard(postA.boardId, home);
    const idsA = boardA.blocks.filter(b => b.kind === 'question').map(b => b.id);
    const submitA = await fetch(`${base}/api/board/${postA.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: idsA.map(id => ({ id, status: 'answered', choice: 'Yes', note: '' })),
        comments: [],
      }),
    });
    assert.equal(submitA.status, 200);

    // give B's waiter every chance to (wrongly) resolve before asserting it hasn't
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(bResolved, false, 'answering session A must not unblock session B\'s waiter');

    const boardBOnDisk = readBoard(postB.boardId, home);
    assert.equal(boardBOnDisk.state, 'open', 'session B\'s board must be untouched by session A\'s submit');
    assert.equal(boardBOnDisk.rounds[0].status, 'open');

    const idxAfterA = await (await fetch(`${base}/`)).text();
    assert.match(threadRowFor(idxAfterA, postA.thread), /data-rounds-left="0"/);
    assert.match(threadRowFor(idxAfterA, postB.thread), /data-rounds-left="1"/, 'session B\'s rounds-left count must be independent of session A\'s submit');

    // now answer B and confirm its own waiter (and only its own) resolves
    const idsB = boardBOnDisk.blocks.filter(b => b.kind === 'question').map(b => b.id);
    const submitB = await fetch(`${base}/api/board/${postB.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: idsB.map(id => ({ id, status: 'answered', choice: 'No', note: '' })),
        comments: [],
      }),
    });
    assert.equal(submitB.status, 200);
    const packetB = await waitB;
    assert.equal(packetB.board, postB.boardId);
    assert.equal(bResolved, true);
  });

  await check('archived boards are searchable: what was asked, what was answered, and when', async () => {
    const searchCwd = projectDir('search-project');
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Checkout redesign',
        cwd: searchCwd,
        blocks: [
          {
            kind: 'question',
            prompt: 'Should we ship the checkout redesign?',
            widget: 'single',
            options: [{ label: 'Ship it now' }, { label: 'Hold off for a beta' }],
          },
        ],
      }),
    })).json();

    const [qid] = readBoard(posted.boardId, home).blocks.filter(b => b.kind === 'question').map(b => b.id);
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qid, status: 'answered', choice: 'Ship it now', note: 'validated in staging beforehand' }],
        comments: [],
      }),
    });

    // what was asked, and when — the question prompt
    const askedRes = await (await fetch(`${base}/api/search?q=${encodeURIComponent('checkout redesign')}`)).json();
    const asked = askedRes.results.find(r => r.boardId === posted.boardId && r.kind === 'question');
    assert.ok(asked, 'searching a substring of the question prompt must surface it');
    assert.equal(asked.thread, posted.thread);
    assert.equal(asked.cwd, searchCwd);
    assert.ok(Number.isFinite(Date.parse(asked.at)), 'a search result must carry a real timestamp');
    assert.ok(asked.url.includes(posted.boardId), 'a search result must link to its board');

    // what was asked — an option label
    const optionRes = await (await fetch(`${base}/api/search?q=${encodeURIComponent('beta')}`)).json();
    const option = optionRes.results.find(r => r.boardId === posted.boardId && r.kind === 'option');
    assert.ok(option, 'searching an option label must surface it');
    assert.ok(option.text.includes('Hold off for a beta'));

    // what was answered — the chosen value
    const choiceRes = await (await fetch(`${base}/api/search?q=${encodeURIComponent('Ship it now')}`)).json();
    const choice = choiceRes.results.find(r => r.boardId === posted.boardId && r.kind === 'answer');
    assert.ok(choice, 'searching the chosen answer value must surface it');

    // what was answered — the note
    const noteRes = await (await fetch(`${base}/api/search?q=${encodeURIComponent('validated in staging')}`)).json();
    const note = noteRes.results.find(r => r.boardId === posted.boardId && r.kind === 'note');
    assert.ok(note, 'searching the answer note must surface it');
    assert.ok(note.text.includes('validated in staging beforehand'));

    // a query matching nothing must not fabricate a result
    const emptyRes = await (await fetch(`${base}/api/search?q=${encodeURIComponent('completely-unrelated-xyz')}`)).json();
    assert.equal(emptyRes.results.filter(r => r.boardId === posted.boardId).length, 0);

    // The index UI is a FILTER over the session list, not a second view of the
    // full-text results above: `GET /` matches on session identity only (title,
    // project folder, cwd, thread id) and narrows the thread rows in place. The
    // full-text surface asserted above lives entirely at /api/search.
    const uiHtml = await (await fetch(`${base}/?q=${encodeURIComponent('checkout redesign')}`)).text();
    assert.ok(uiHtml.includes(`data-thread-id="${posted.thread}"`), 'a query matching a session title must leave that session in the filtered list');
    assert.ok(uiHtml.includes(`href="/b/${posted.boardId}"`), 'the surviving row must still link to the board');
    assert.ok(!uiHtml.includes('Should we ship the checkout redesign?'), 'the index must NOT render block-level result cards any more -- what was asked inside a session is /api/search\'s answer, not this list\'s');

    // ...and identity-only means identity-only: a phrase that appears only INSIDE
    // the board (this one is the answer note) is a hit at /api/search and must not
    // be one here. Ablation: restore the old searchBoards call behind GET / and
    // this row comes back.
    const insideHtml = await (await fetch(`${base}/?q=${encodeURIComponent('validated in staging')}`)).text();
    assert.ok(!insideHtml.includes(`data-thread-id="${posted.thread}"`), 'matching on a board\'s CONTENTS must not filter the session list -- the box names sessions, not what was said in them');
    assert.ok(insideHtml.includes('No sessions match'), 'a query that matches no session must say so, rather than falling back to the empty-store message');

    // ...and the box a REAL browser uses to get here must actually submit. Every
    // assertion above fetches `/?q=` directly, which is not what a user does and does
    // not feel the CSP at all -- under `form-action 'none'` the whole search UI was
    // dead in the browser ("violates the following Content Security Policy directive")
    // while all of the above still passed. Ablation: put 'none' back on GET / and this
    // check fails (along with the per-path form-action assertion further down).
    const indexRes = await fetch(`${base}/`);
    const indexHtml = await indexRes.text();
    const form = indexHtml.match(/<form class="search-form"[^>]*>/);
    assert.ok(form, 'the index must ship a search form');
    const action = form[0].match(/action="([^"]*)"/);
    assert.ok(action && action[1].startsWith('/'), 'the search form must post same-origin');
    const formAction = (indexRes.headers.get('content-security-policy') || '')
      .split(';').map(c => c.trim()).find(c => c.startsWith('form-action'));
    assert.ok(
      formAction && !formAction.includes("'none'"),
      `the index CSP must let its own search form submit, got: ${formAction}`,
    );
  });

  let widgetsBoardId;

  await check('POST /api/board carrying all four widget kinds writes them, and the served page renders every one', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'All four widgets',
        blocks: [
          { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] },
          { kind: 'question', prompt: 'Pick some', widget: 'multi', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
          { kind: 'question', prompt: 'Say something', widget: 'text', options: [] },
          { kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    widgetsBoardId = j.boardId;

    const stored = readBoard(widgetsBoardId, home);
    assert.deepEqual(stored.blocks.map(b => b.widget), ['single', 'multi', 'text', 'rank']);

    const markup = renderedMarkup(await (await fetch(`${base}/b/${widgetsBoardId}`)).text());
    assert.ok(markup.includes('data-widget="single"'));
    assert.ok(markup.includes('data-widget="multi"'));
    assert.ok(markup.includes('data-widget="text"'));
    assert.ok(markup.includes('data-widget="rank"'));
    assert.ok(markup.includes('class="card-choice choice-multi"'));
    assert.ok(markup.includes('data-answer-for='));
    assert.ok(markup.includes('class="rank-list"'));
    assert.ok(markup.includes('class="btn-defer"'));
  });

  await check('submitting all four widgets returns each status/choice/note in the packet, unanswered and deferred included', async () => {
    const [single, multi, text, rank] = readBoard(widgetsBoardId, home).blocks.map(b => b.id);
    const waitPromise = fetch(`${base}/api/board/${widgetsBoardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));

    const submitRes = await fetch(`${base}/api/board/${widgetsBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [
          { id: single, status: 'deferred', choice: null, note: 'need more time' },
          { id: multi, status: 'answered', choice: ['A', 'C'], note: '' },
          { id: text, status: 'answered', choice: 'a considered written answer', note: 'see attached' },
          // rank deliberately absent -> must come back explicit unanswered
        ],
        comments: [],
      }),
    });
    assert.equal(submitRes.status, 200);

    const packet = await waitPromise;
    const byId = Object.fromEntries(packet.answers.map(a => [a.id, a]));
    assert.equal(byId[single].status, 'deferred');
    assert.equal(byId[single].choice, null);
    assert.equal(byId[single].note, 'need more time');
    assert.deepEqual(byId[multi].choice, ['A', 'C']);
    assert.equal(byId[text].choice, 'a considered written answer');
    assert.equal(byId[text].note, 'see attached');
    assert.equal(byId[rank].status, 'unanswered');
    assert.equal(byId[rank].choice, null);
    assert.equal(byId[rank].note, '');
  });

  // Found by using this for real: a round came back
  // carrying a `deferred` question whose `choice` WAS populated. Every check here and
  // in check-mcp.mjs had only ever exercised `deferred` with `choice: null`, so the
  // suite quietly encoded "deferred means no choice" — an assumption the reviewer
  // disproved by picking an option and marking it revisit-later in the same breath,
  // which is a perfectly reasonable thing to do and the more useful signal of the two.
  //
  // The contract is that `status` alone says whether a question was decided (see
  // PROTOCOL.md "Packet"). This pins it, so a caller reading `choice` without branching
  // on `status` fails here rather than in someone's session, silently recording a
  // decision the reviewer explicitly declined to make.
  await check('a deferred answer keeps its choice: status alone says whether a question was decided', async () => {
    const post = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Deferred with a lean',
        blocks: [{ kind: 'question', prompt: 'which way?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    });
    const { boardId } = await post.json();
    const qid = readBoard(boardId, home).blocks.find(b => b.kind === 'question').id;

    const waitPromise = fetch(`${base}/api/board/${boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qid, status: 'deferred', choice: 'A', note: 'leaning A, want to sit with it' }],
        comments: [],
      }),
    });
    assert.equal(submitRes.status, 200);

    const answer = (await waitPromise).answers.find(a => a.id === qid);
    assert.equal(answer.status, 'deferred', 'a deferred answer must stay deferred, not get promoted by carrying a choice');
    assert.equal(answer.choice, 'A', 'the tentative lean must survive: discarding it loses the more useful half of the signal');
    assert.equal(answer.note, 'leaning A, want to sit with it');

    // The same thing on the stored board, not just in the packet -- the board is the
    // durable record, and a lean that only lived in one packet would be gone by round 2.
    assert.equal(readBoard(boardId, home).answers[qid].status, 'deferred');
    assert.equal(readBoard(boardId, home).answers[qid].choice, 'A');
  });

  await check('POST /api/board carrying all five context kinds renders every block on the served page', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'All five context kinds',
        blocks: [
          { kind: 'markdown', text: '# Prose\n\nsome supporting prose' },
          { kind: 'code', text: 'const answer = 42;', lang: 'javascript' },
          { kind: 'mermaid', text: 'flowchart LR\n  A --> B' },
          { kind: 'html', html: '<div class="mock"><button>Ship it</button></div>' },
          {
            kind: 'compare',
            left: { label: 'Before', block: { kind: 'markdown', text: '# Before\n\nold copy' } },
            right: { label: 'After', block: { kind: 'markdown', text: '# After\n\nnew copy' } },
          },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    // Stripped of the inlined <style>, the #board-data JSON, and the client
    // <script>: every needle below can only be satisfied by markup renderBlock
    // actually emitted. (Verified: replacing the compare arm of the render dispatch
    // with `return ''` makes this check fail, as it must.)
    const markup = renderedMarkup(await (await fetch(`${base}/b/${j.boardId}`)).text());

    assert.ok(markup.includes('some supporting prose'));
    assert.ok(markup.includes('class="block code-block"'));
    // javascript is a vendored grammar (ADR.md entry 62), so `const` and `42` are
    // now wrapped in their own tok-* spans rather than sitting in one literal run --
    // assert the pieces highlighting actually leaves intact.
    assert.ok(markup.includes('<span class="tok-keyword">const</span> answer = <span class="tok-number">42</span>;'));
    assert.ok(markup.includes('class="block mermaid-block"'));
    assert.ok(markup.includes('<pre class="mermaid">flowchart LR'));
    assert.ok(markup.includes('class="block html-block"'));
    assert.ok(markup.includes('class="html-stage"'));
    assert.ok(markup.includes('&lt;button&gt;Ship it&lt;/button&gt;'));
    assert.ok(markup.includes('class="block compare-block"'));
    assert.ok(markup.includes('class="compare-grid"'));
    assert.ok(markup.includes('<div class="compare-label">Before</div>'));
    assert.ok(markup.includes('<div class="compare-label">After</div>'));
    assert.ok(markup.includes('old copy'));
    assert.ok(markup.includes('new copy'));
  });

  // --- element-level anchoring (dom, mermaid) round-trips through submit --
  //
  // The click gesture itself needs a browser, which puts it out of
  // automated scope; what's asserted here is the data shape: a comment carrying a
  // `dom` anchor and one carrying a `mermaid` anchor, posted exactly as src/ui.mjs's
  // click handlers would construct them, come back out of the blocked /wait call's
  // packet with their ref/hint intact, and an anchor that never matched anything
  // real reports what it lost rather than vanishing -- same contract as `md`
  // anchors already proven above, extended to the two element-level kinds.

  await check('a dom anchor and a mermaid anchor round-trip through submit into the packet with ref/hint intact, and an unresolvable one reports what it lost', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Element-level anchoring',
        blocks: [
          { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
          { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const { boardId: anchorBoardId } = await r.json();
    const stored = readBoard(anchorBoardId, home);
    const htmlBlockId = stored.blocks.find(b => b.kind === 'html').id;
    const mermaidBlockId = stored.blocks.find(b => b.kind === 'mermaid').id;

    const waitPromise = fetch(`${base}/api/board/${anchorBoardId}/wait?round=1`).then(r2 => r2.json());
    await new Promise(resolve => setTimeout(resolve, 150));

    const submitRes = await fetch(`${base}/api/board/${anchorBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [
          { blockId: htmlBlockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'move this button left' },
          { blockId: htmlBlockId, anchor: { kind: 'dom', ref: '9.9', hint: 'Launch' }, text: 'a hint that was never in this stage' },
          { blockId: mermaidBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'rename the start node' },
          { blockId: mermaidBlockId, anchor: { kind: 'mermaid', ref: 'Ghost' }, text: 'a node id this diagram never declared' },
        ],
      }),
    });
    assert.equal(submitRes.status, 200);

    const packet = await waitPromise;
    assert.equal(packet.comments.length, 4);
    // ADR 99: no comment in the packet carries a `resolved` key -- `lost` alone
    // tells a resolved comment from a lost one.
    for (const c of packet.comments) assert.equal('resolved' in c, false);

    const domOk = packet.comments.find(c => c.anchor.kind === 'dom' && c.anchor.ref === '1.1');
    assert.equal(domOk.blockKind, 'html');
    assert.equal(domOk.anchor.hint, 'Send'); // hint survives the round trip verbatim
    assert.equal(domOk.lost, undefined);
    assert.equal(domOk.text, 'move this button left');

    const domLost = packet.comments.find(c => c.anchor.kind === 'dom' && c.anchor.ref === '9.9');
    // A lost `dom` anchor's `.lost` names the stored HINT ("Launch"),
    // not the opaque index-chain ref ("9.9") -- the hint is what a human or an
    // agent reading the packet can recognise as "what this comment was about"
    // once the element is gone: the stored hint is
    // what survives when the element does not. `c.anchor.ref` still carries
    // the raw ref for anything that wants it.
    assert.equal(domLost.lost, 'Launch');
    assert.equal(domLost.anchor.ref, '9.9');

    const mermaidOk = packet.comments.find(c => c.anchor.kind === 'mermaid' && c.anchor.ref === 'A');
    assert.equal(mermaidOk.blockKind, 'mermaid');
    assert.equal(mermaidOk.text, 'rename the start node');
    assert.equal(mermaidOk.lost, undefined);

    const mermaidLost = packet.comments.find(c => c.anchor.kind === 'mermaid' && c.anchor.ref === 'Ghost');
    assert.equal(mermaidLost.lost, 'Ghost');

    // and the store JSON carries the same shapes verbatim -- the packet isn't
    // reshaping anything resolveComment didn't already see on disk.
    const storedAfter = readBoard(anchorBoardId, home);
    assert.deepEqual(
      storedAfter.comments.map(c => c.anchor),
      [
        { kind: 'dom', ref: '1.1', hint: 'Send' },
        { kind: 'dom', ref: '9.9', hint: 'Launch' },
        { kind: 'mermaid', ref: 'A' },
        { kind: 'mermaid', ref: 'Ghost' },
      ],
    );
  });

  // --- a page-scoped `dom` anchor survives a real post/submit/     ---
  // re-render round trip -----------------------------------------------------
  //
  // The gap this closes: src/board.mjs's resolveComment used to resolve a `dom`
  // anchor ONLY when block.kind === 'html' (the stage case already built). A
  // page-scoped `dom` anchor -- the generic model, rooted at the
  // anchored block's own section rather than an iframe -- looked right in the
  // tab that minted it (src/ui.mjs's commentsWithPending marks a freshly-queued
  // comment resolved unconditionally, client-side, before any server round
  // trip) but reported `lost` the moment the SAME board was re-rendered from its
  // stored JSON, which is exactly what a real submit + reload does. A check that
  // only calls resolveComment/renderBoardPage in isolation cannot see that gap
  // (nothing forces it through an actual store-then-reload cycle); this drives
  // the real daemon end to end and then drives the REAL client script
  // (test/dom-stand-in.mjs, same seam as check-comment-mode.mjs) over the
  // freshly re-fetched page, so it proves the pin a reviewer would actually see,
  // not just a JSON verdict.
  await check('a page-scoped dom anchor on several content kinds survives post -> submit -> re-render, and every pin returns to the element it named', async () => {
    const postRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Ticket 04 -- page-scoped anchors round-trip',
        blocks: [
          {
            kind: 'markdown',
            text: [
              '# Findings',
              '',
              'A paragraph of prose to comment on.',
              '',
              '- alpha item',
              '- beta item',
              '',
              '| Col A | Col B |',
              '| --- | --- |',
              '| Total | 42 |',
            ].join('\n'),
          },
          { kind: 'code', text: 'const x = 1;\nconst y = 2;', lang: 'javascript' },
          {
            kind: 'compare',
            // ADR.md entry 28: a compare SIDE is judged on its own kind, so a
            // diagram here keeps the affordance. Sourced from a path that cannot
            // resolve, because a mermaid section's `.resolve-error` note is the one
            // element the generic page-scoped gesture can reach.
            left: { label: 'Before', block: { kind: 'mermaid', source: { path: 'no-such-diagram-rr.mmd' } } },
            right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Send</button></div>' } },
          },
          {
            kind: 'question',
            prompt: 'Pick one',
            widget: 'single',
            options: [{ label: 'Yes' }, { label: 'No' }],
            // ADR.md entry 28 ("Only the rendered kinds can be commented on",
            // 2026-08-06): the question wrapper itself (its prompt, its
            // options, its note field) lost the comment affordance entirely.
            // A rendered `context` entry did not -- it goes through the same
            // renderBlock dispatch as any other block, with its own id and
            // its own comment area, so an anchor rooted here is exactly the
            // still-live case that still needs covering. Entry 28 draws that line on
            // KIND: an html stage keeps it, the prose beside it does not.
            context: [{ kind: 'html', html: '<div class="mock"><button>Confirm</button></div>' }],
          },
        ],
      }),
    });
    assert.equal(postRes.status, 200);
    const { boardId: rrBoardId } = await postRes.json();
    const rrStored = readBoard(rrBoardId, home);
    const mdBlockId = rrStored.blocks[0].id;
    const codeBlockId = rrStored.blocks[1].id;
    const compareLeftId = rrStored.blocks[2].left.block.id;
    const compareRightId = rrStored.blocks[2].right.block.id;
    const questionContextId = rrStored.blocks[3].context[0].id;
    assert.equal(typeof rrStored.blocks[2].left.block.error, 'string',
      'setup failure: the compare side\'s diagram must actually fail to resolve');

    /** Loads a served page through the real client script, exactly like
     * check-comment-mode.mjs's loadBoard -- a fresh document per call. */
    function loadBoard(html) {
      const document = parseHTML(html);
      const window = document.defaultView;
      const location = { protocol: 'http:' };
      // 'EventSource' declared, never passed -- see QUIRKS.md "A `new Function` harness
      // inherits the host's globals".
      new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);
      return document;
    }

    function enableCommentMode(document) {
      const toggle = document.getElementById('comment-mode-toggle');
      toggle.dispatchEvent(new StandInEvent('click'));
    }

    /** Click `el` (comment mode already on) and read back the anchor the real
     * client script minted onto `blockId`'s comment form -- the SAME mechanism
     * test/check-comment-mode.mjs already proves, reused here to feed
     * genuine refs/hints into a real HTTP submit rather than hand-writing them. */
    function captureAnchor(document, el, blockId) {
      el.dispatchEvent(new StandInEvent('click'));
      const form = document.getElementById('comment-form-' + blockId);
      assert.ok(form && form.classList.contains('open'), `setup failure: clicking did not open block ${blockId}'s comment form`);
      return {
        blockId,
        anchor: {
          kind: form.getAttribute('data-anchor-kind'),
          ref: form.getAttribute('data-anchor-ref'),
          hint: form.getAttribute('data-anchor-label'),
        },
      };
    }

    const firstPageHtml = await (await fetch(`${base}/b/${rrBoardId}`)).text();
    const doc1 = loadBoard(firstPageHtml);
    enableCommentMode(doc1);

    // ADR.md entry 28: markdown and code carry no comment surface at all now, so
    // the round trip is driven over the kinds that do -- a diagram in a compare
    // side (page-scoped root) and two html stages (iframe-body root), one of them
    // inside a question's context.
    const compareDiagram = doc1.querySelector(`[data-block-id="${compareLeftId}"] .resolve-error`);
    assert.ok(compareDiagram, 'setup failure: could not find every fixture element on the first-rendered page');
    assert.equal(doc1.querySelector(`[data-block-id="${mdBlockId}"] .pin-layer`), null,
      'setup failure: a markdown block must carry no comment surface (ADR.md entry 28)');
    assert.equal(doc1.querySelector(`[data-block-id="${codeBlockId}"] .pin-layer`), null,
      'setup failure: a code block must carry no comment surface (ADR.md entry 28)');

    const pairs = [captureAnchor(doc1, compareDiagram, compareLeftId)];
    // The two html stages, still element (2) of the TWO roots documented in
    // DESIGN.md, "### Entry 28 — element anchoring" -- included so this same round trip also
    // proves block.kind === 'html' resolution is unchanged, not just the
    // page-scoped path, and that it is unchanged inside a question's context too.
    for (const blockId of [compareRightId, questionContextId]) {
      const frame = doc1.querySelector(`[data-block-id="${blockId}"] .html-stage`);
      assert.ok(frame, `setup failure: no html stage rendered for block ${blockId}`);
      frame.loadSrcdoc();
      pairs.push(captureAnchor(doc1, frame.contentDocument.querySelector('button'), blockId));
    }

    for (const p of pairs) {
      assert.equal(p.anchor.kind, 'dom');
      assert.ok(p.anchor.ref, `setup failure: empty ref minted for block ${p.blockId}`);
    }

    const submitRes = await fetch(`${base}/api/board/${rrBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: pairs.map(p => ({ blockId: p.blockId, anchor: p.anchor, text: `comment on ${p.blockId}` })),
      }),
    });
    assert.equal(submitRes.status, 200);

    // What the agent reads: every one of these must come back resolved, not
    // lost -- this is the exact packet buildPacket hands back over /wait. ADR 99:
    // the packet carries no `resolved` key at all, so "resolved" is `lost` being
    // absent, not a field to read.
    const packet = await (await fetch(`${base}/api/board/${rrBoardId}/wait?round=1`)).json();
    assert.equal(packet.comments.length, pairs.length);
    for (const c of packet.comments) {
      assert.equal('resolved' in c, false, `comment on block ${c.blockId} must carry no resolved key`);
      assert.equal(c.lost, undefined, `comment on block ${c.blockId} (ref ${JSON.stringify(c.anchor.ref)}) must resolve after a real submit + re-render, not report lost`);
    }

    // Re-render from the stored JSON (a plain GET /b/:id always re-renders from
    // the store -- src/server.mjs) and drive the REAL client script over it
    // again: the seam that proves a pin actually lands on the page, not just
    // that resolveComment returned true in isolation.
    const secondPageHtml = await (await fetch(`${base}/b/${rrBoardId}`)).text();
    const doc2 = loadBoard(secondPageHtml);
    // the html-stage pin layers only wire for real once "loaded"
    doc2.querySelectorAll('.html-stage').forEach(f => f.loadSrcdoc());

    function pinLayerFor(blockId) {
      const section = doc2.querySelector(`[data-block-id="${blockId}"]`);
      assert.ok(section, `setup failure: no section for block ${blockId} on the re-rendered page`);
      const layer = Array.prototype.slice.call(section.children).find(c => c.classList && c.classList.contains('pin-layer'))
        || section.querySelector('.pin-layer');
      assert.ok(layer, `setup failure: block ${blockId} has no pin-layer`);
      return layer;
    }

    const layersToCheck = new Set(pairs.map(p => p.blockId));
    for (const blockId of layersToCheck) {
      const layer = pinLayerFor(blockId);
      const pins = layer.querySelectorAll('.anchor-pin');
      assert.ok(pins.length > 0, `expected at least one pin in block ${blockId}'s pin-layer after re-render, got 0`);
      for (const pin of pins) {
        assert.equal(pin.classList.contains('pin-lost'), false,
          `every pin re-rendered from a real submit for block ${blockId} must land resolved, not lost (title: ${JSON.stringify(pin.title)})`);
      }
    }
  });

  await check('C2: the live exfil PoC is refused end to end -- neither an absolute source path nor an unbounded cwd reads a file outside the project', async () => {
    // The coordinator's reproduction, run against the real daemon. Both halves have to
    // hold: the per-reference confinement (an absolute `source.path`) AND the cwd
    // binding (a caller-chosen `cwd: '/'` that would make confinement vacuous).
    const secretDir = mkdtempSync(path.join(tmpdir(), 'claude-board-secret-'));
    try {
      const secretFile = path.join(secretDir, 'private.md');
      writeFileSync(secretFile, '# Private\n\nTHE-SECRET-STRING', 'utf8');

      // 1. absolute source.path, cwd naming the secret's own directory
      const absPost = await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({
          title: 'exfil',
          cwd: secretDir,
          blocks: [{ kind: 'code', source: { path: secretFile } }],
        }),
      });
      assert.equal(absPost.status, 200, 'the post itself still succeeds: a bad reference is a block-level error');
      const absBoard = (await absPost.json()).boardId;
      const absPage = await (await fetch(`${base}/b/${absBoard}`)).text();
      assert.ok(!absPage.includes('THE-SECRET-STRING'), 'an absolute source.path must not reach the served page');
      assert.match(readBoard(absBoard, home).blocks[0].error, /absolute/);

      // 2. cwd:'/' plus a relative path -- confinement is vacuous if the caller picks cwd
      const rootPost = await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({
          title: 'exfil',
          cwd: '/',
          blocks: [{ kind: 'code', source: { path: secretFile.replace(/^\//, '') } }],
        }),
      });
      assert.equal(rootPost.status, 400, 'a cwd of / must be refused at post time, not stored');
      assert.match((await rootPost.json()).error, /filesystem root/);

      // 3. a legitimate cwd, but a ../ climb out of it to the same secret
      const project = projectDir('confined');
      const climbPost = await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({
          title: 'exfil',
          cwd: project,
          blocks: [{ kind: 'code', source: { path: path.relative(project, secretFile) } }],
        }),
      });
      const climbBoard = (await climbPost.json()).boardId;
      const climbPage = await (await fetch(`${base}/b/${climbBoard}`)).text();
      assert.ok(!climbPage.includes('THE-SECRET-STRING'), 'a ../ climb must not reach the served page');
      assert.match(readBoard(climbBoard, home).blocks[0].error, /outside the board's project directory/);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  await check('C2: a second round posted into a live board cannot change its cwd', async () => {
    const projectA = projectDir('round-bind-a');
    const projectB = projectDir('round-bind-b');
    writeFileSync(path.join(projectA, 'a.md'), '# A\n\nfrom A', 'utf8');
    writeFileSync(path.join(projectB, 'b.md'), '# B\n\nSECRET-FROM-B', 'utf8');

    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Bound once',
        cwd: projectA,
        blocks: [{ kind: 'markdown', source: { path: 'a.md' } }],
      }),
    })).json();

    const retarget = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: created.boardId,
        title: 'Bound once',
        cwd: projectB,
        blocks: [{ kind: 'markdown', source: { path: 'b.md' } }],
      }),
    });
    // Either the server never forwards `cwd` on a board-id post (it currently does not),
    // or src/board.mjs refuses it -- both are the same guarantee from the reviewer's
    // side, and this asserts the guarantee rather than the mechanism: the board's cwd
    // does not move, and project B's content never appears on it.
    const stored = readBoard(created.boardId, home);
    assert.equal(stored.cwd, projectA, 'the board must still be bound to the directory it was created with');
    if (retarget.status === 200) {
      const page = await (await fetch(`${base}/b/${created.boardId}`)).text();
      assert.ok(!page.includes('SECRET-FROM-B'), 'a later round must not read out of a different project directory');
      const added = stored.blocks[stored.blocks.length - 1];
      assert.match(added.error, /outside the board's project directory|cannot read/);
    } else {
      assert.equal(retarget.status, 400);
    }
  });

  await check('a code block resolved by reference (line range) snapshots the file text and sha at post time', async () => {
    mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, 'add.js');
    writeFileSync(srcFile, ['function add(a, b) {', '  return a + b;', '}', ''].join('\n'), 'utf8');

    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Code by reference',
        blocks: [{ kind: 'code', source: { path: 'add.js', lines: [1, 2] } }],
        cwd: srcDir,
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    const stored = readBoard(j.boardId, home);
    const block = stored.blocks[0];
    assert.equal(block.text, 'function add(a, b) {\n  return a + b;');
    assert.equal(block.lang, 'javascript');
    assert.equal(typeof block.sha, 'string');
    assert.equal(block.sha.length, 64);

    // rewriting the source after post must not change the already-resolved snapshot
    writeFileSync(srcFile, 'rewritten entirely\n', 'utf8');
    const restored = readBoard(j.boardId, home);
    assert.equal(restored.blocks[0].text, 'function add(a, b) {\n  return a + b;');
  });

  await check('a markdown block resolved by reference (section) snapshots just that section', async () => {
    mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, 'contract.md');
    writeFileSync(srcFile, '# Contract\n\n## Notes\n\nresolved by reference\n\n## Other\n\nunrelated', 'utf8');

    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Markdown by reference',
        blocks: [{ kind: 'markdown', source: { path: 'contract.md', section: 'notes' } }],
        cwd: srcDir,
      }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    const stored = readBoard(j.boardId, home);
    const block = stored.blocks[0];
    assert.ok(block.text.includes('resolved by reference'));
    assert.ok(!block.text.includes('unrelated'));
    assert.equal(block.error, undefined);
  });

  await check('a reference to a missing file fails the block, not the whole post, and is reported not dropped', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Broken reference over HTTP',
        blocks: [{ kind: 'code', source: { path: path.join(srcDir, 'does-not-exist.js') } }],
      }),
    });
    assert.equal(r.status, 200); // the post itself succeeds
    const j = await r.json();
    const stored = readBoard(j.boardId, home);
    assert.equal(stored.blocks.length, 1);
    assert.equal(typeof stored.blocks[0].error, 'string');

    const markup = renderedMarkup(await (await fetch(`${base}/b/${j.boardId}`)).text());
    assert.ok(markup.includes('class="resolve-error"'));
    assert.ok(markup.includes('Could not resolve'));
  });

  // --- snapshot and standalone archive -----------------------------------

  await check('the served page, the pages/ file on disk, and a fresh renderBoardPage() of the stored JSON are all byte-identical', async () => {
    const served = await (await fetch(`${base}/b/${boardId}`)).text();
    const onDisk = readFileSync(path.join(home, 'pages', `${boardId}.html`), 'utf8');
    const freshlyRendered = renderBoardPage(readBoard(boardId, home));
    assert.equal(served, onDisk, 'served page must match the pages/ file exactly -- that file is what Finder opens standalone');
    assert.equal(served, freshlyRendered, 're-rendering the stored JSON must reproduce the served page exactly');
    // The read gate lives entirely in headers and cookies, never in markup, which is
    // what keeps the three equal above -- and what makes an archived board still open
    // from disk with the daemon stopped and no credential anywhere.
    // (Ablation: inline the session token or a handoff into the page and this fails,
    // because renderBoardPage's output would stop being a function of the board JSON.)
    for (const leak of [SESSION_COOKIE, sessionToken(SECRET), SECRET, SECRET_HEADER, '/auth/']) {
      assert.ok(!served.includes(leak), `the rendered page must not carry ${leak}`);
    }
  });

  await check('"archives already on disk stay dark": a pages/*.html frozen before this feature shipped is never rewritten, and GET /b/:id always serves a fresh, themed render regardless of what the frozen file contains', async () => {
    // Stand in for an archive written by an earlier daemon, before this feature existed: hand-written
    // directly to pages/, bypassing writePage entirely, carrying none of
    // src/theme.mjs's machinery (no themeBootScript, no #theme-toggle, no light
    // media query) -- exactly what every archive predating this change looks
    // like, forever, per the spec's own "no migration, no re-render sweep on
    // upgrade" decision.
    const pagePath = path.join(home, 'pages', `${boardId}.html`);
    // This check overwrites the SHARED pages/<boardId>.html
    // fixture and previously never restored it, leaving it corrupted for the
    // rest of the run -- green only by accident, because the next check that
    // touches this board posts a different one first. Captured up front and
    // restored in a `finally`, same discipline as this file's other
    // real-file-on-disk checks.
    const originalPageContents = readFileSync(pagePath, 'utf8');
    const staleHtml = '<!doctype html><html><head><title>stale pre-theme archive</title></head><body><p>a pre-ticket-05 archive: dark-only, no theme machinery at all</p></body></html>';
    try {
      writeFileSync(pagePath, staleHtml, 'utf8');
      assert.equal(readFileSync(pagePath, 'utf8'), staleHtml, 'setup failure: could not stand the page file in as a stale pre-theme archive');

      // Reopening this board through the daemon -- a plain GET, exactly what a
      // reviewer's browser does -- must serve a FRESH, themed render, proving GET
      // never reads pages/*.html to answer a request; it only ever re-renders the
      // stored board JSON (src/server.mjs's handleGetPage).
      const served = await (await fetch(`${base}/b/${boardId}`)).text();
      assert.ok(served.includes('id="theme-toggle"'), 'GET /b/:id must serve a freshly rendered, themed page even though the file on disk is a stale, pre-theme archive');
      assert.notEqual(served, staleHtml, 'the served page must not be the stale bytes sitting on disk');

      // And the frozen file itself must be untouched by that GET: no migration, no
      // re-render sweep, ever -- an archive is a snapshot of what was posted, and
      // rewriting an old one would contradict that.
      const onDiskAfter = readFileSync(pagePath, 'utf8');
      assert.equal(onDiskAfter, staleHtml, 'a GET must never rewrite pages/*.html -- an old archive stays exactly as it was written, forever (ablation: this is what would break if a migration/re-render sweep were ever added on startup or on read)');
    } finally {
      writeFileSync(pagePath, originalPageContents, 'utf8');
    }
  });

  await check('answering mutates only the store JSON on disk; any regenerated page is a full re-render of that JSON, never an in-place edit', async () => {
    const postRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Mutation isolation',
        blocks: [
          { kind: 'markdown', text: '# Notes\n\n- alpha\n- beta' },
          { kind: 'question', prompt: 'Proceed?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
        ],
      }),
    });
    const { boardId: id } = await postRes.json();

    const before = snapshotTree(home);
    const boardPathRel = path.join('boards', `${id}.json`);
    const pagePathRel = path.join('pages', `${id}.html`);
    assert.ok(before.has(boardPathRel));
    assert.ok(before.has(pagePathRel));

    const waitPromise = fetch(`${base}/api/board/${id}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${id}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'go' }], comments: [] }),
    });
    assert.equal(submitRes.status, 200);
    await waitPromise;

    const after = snapshotTree(home);

    // Nothing is ever removed by answering, and the only thing that may APPEAR is a
    // shared asset the regenerated page actually names -- src/store.mjs's writePage puts
    // the two content-addressed siblings down before the page that references them (ADR
    // 70), so a submit landing the first time this daemon has ever written a given
    // payload legitimately adds a file. Anything else appearing is still a failure: this
    // check is what says a submit writes no scratch file, no lock, no backup, no
    // second board.
    const added = [...after.keys()].filter(rel => !before.has(rel));
    const removed = [...before.keys()].filter(rel => !after.has(rel));
    assert.deepEqual(removed, [], 'answering must never remove a file from the store');
    const namedByPage = assetsNamedBy(after.get(pagePathRel).bytes.toString('utf8'));
    for (const rel of added) {
      assert.ok(path.dirname(rel) === 'pages' && namedByPage.includes(path.basename(rel)),
        `answering added ${rel}, which is not a shared asset the regenerated page names`);
    }

    // every file except the board's own JSON, its emitted page projection and any asset
    // just added is byte-identical -- answering touches nothing else on disk, and in
    // particular never REWRITES a shared asset (the name is the hash: a file that exists
    // already holds exactly those bytes). (Ablation: writing any stray file during
    // submit, or touching an unrelated board, fails this.)
    for (const rel of before.keys()) {
      if (rel === boardPathRel || rel === pagePathRel) continue;
      assert.equal(after.get(rel).sha, before.get(rel).sha, `${rel} must be untouched by a submit`);
    }

    // the store JSON did change -- that's the one thing answering is allowed to mutate.
    assert.notEqual(after.get(boardPathRel).sha, before.get(boardPathRel).sha);

    // the emitted page changed too (expected: the daemon regenerates it on submit),
    // but it must be a REGENERATION from the new JSON, not a hand-patch of the old
    // HTML: its bytes must equal a fresh renderBoardPage() of the board as it now
    // reads from the store, byte for byte -- not "looks similar". (Ablation: patching
    // just the answer's data-choice attribute in place instead of a full re-render
    // would leave the inlined #board-data payload stale and fail this equality.)
    assert.notEqual(after.get(pagePathRel).sha, before.get(pagePathRel).sha);
    const storedAfter = readBoard(id, home);
    const freshRender = renderBoardPage(storedAfter);
    assert.equal(after.get(pagePathRel).bytes.toString('utf8'), freshRender);

    // and the *old* page, from before the submit, must equal a render of the *old*
    // JSON too -- pinning down that every snapshot here was a pure render of its own
    // JSON state, not an accumulation of incremental in-place edits.
    const storedBefore = JSON.parse(before.get(boardPathRel).bytes.toString('utf8'));
    assert.equal(before.get(pagePathRel).bytes.toString('utf8'), renderBoardPage(storedBefore));
  });

  await check('a board whose referenced source was rewritten, then deleted, still re-renders through the server with the original snapshot', async () => {
    mkdirSync(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, 'archived-doc.md');
    writeFileSync(srcFile, '# Archived\n\nthis was on screen when it was answered', 'utf8');

    const postRes = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Archive survives source churn',
        blocks: [{ kind: 'markdown', source: { path: 'archived-doc.md' } }],
        cwd: srcDir,
      }),
    });
    const { boardId: id } = await postRes.json();

    const original = readBoard(id, home);
    const originalText = original.blocks[0].text;
    const originalSha = original.blocks[0].sha;
    assert.ok(originalText.includes('this was on screen when it was answered'));

    // submit an (empty) answer -- exercises "answering only touches the JSON" on
    // this board too, and leaves us a submitted board to re-render below.
    const waitPromise = fetch(`${base}/api/board/${id}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${id}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });
    await waitPromise;

    // rewrite the source entirely -- the spec's own words: "post a board, rewrite
    // the source file, re-render, assert the page is unchanged".
    writeFileSync(srcFile, '# Archived\n\nCOMPLETELY DIFFERENT, written after the fact', 'utf8');
    const pageAfterRewrite = await (await fetch(`${base}/b/${id}`)).text();
    const markupAfterRewrite = renderedMarkup(pageAfterRewrite);
    assert.ok(markupAfterRewrite.includes('this was on screen when it was answered'));
    assert.ok(!markupAfterRewrite.includes('COMPLETELY DIFFERENT'));
    assert.ok(pageAfterRewrite.includes(JSON.stringify(originalSha)));

    // delete the source outright -- re-render must still succeed (200, not a
    // resolve-error) and still carry the original snapshot: resolution never re-runs
    // at render time, only once at post time (src/resolve.mjs is not imported by
    // src/render.mjs at all).
    unlinkSync(srcFile);
    const pageAfterDeleteRes = await fetch(`${base}/b/${id}`);
    assert.equal(pageAfterDeleteRes.status, 200);
    const pageAfterDelete = await pageAfterDeleteRes.text();
    const markupAfterDelete = renderedMarkup(pageAfterDelete);
    assert.ok(markupAfterDelete.includes('this was on screen when it was answered'));
    assert.ok(!markupAfterDelete.includes('class="resolve-error"'));
    assert.ok(pageAfterDelete.includes(JSON.stringify(originalSha)));

    // and re-rendering directly from the store JSON -- the actual mechanism this
    // ticket delivers -- is byte-identical to what the server just served, with the
    // source both rewritten and gone.
    const storedNow = readBoard(id, home);
    assert.equal(storedNow.blocks[0].text, originalText);
    assert.equal(storedNow.blocks[0].sha, originalSha);
    assert.equal(pageAfterDelete, renderBoardPage(storedNow));
  });

  // --- cross-origin writes, round finality, wait liveness ---------

  const boardsDirPath = path.join(home, 'boards');
  const storeFileCount = () => readdirSync(boardsDirPath).filter(f => f.endsWith('.json')).length;
  const newBoardBody = JSON.stringify({ title: 'Cross-origin probe', blocks: [{ kind: 'markdown', text: '# planted' }] });

  await check('C1: a cross-origin POST is refused even though its Host header is loopback', async () => {
    // The browser sets Host itself on `fetch('http://127.0.0.1:<port>/api/board')` from
    // ANY page, so the loopback Host check passes and cannot see this. What a page
    // cannot forge is Origin/Sec-Fetch-Site. (Ablation: without the isSameOriginWrite
    // gate every case below returns 200 and plants a board in the store.)
    const before = storeFileCount();

    const withOrigin = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: newBoardBody,
    });
    assert.equal(withOrigin.status, 403, 'a POST carrying a foreign Origin must be refused');
    assert.equal(withOrigin.body, '');

    const withFetchSite = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: newBoardBody,
    });
    assert.equal(withFetchSite.status, 403, 'a POST whose Sec-Fetch-Site is not same-origin must be refused');

    // ...and the same guard covers submit, not just board creation.
    const submitCrossOrigin = await rawRequest(port, 'POST', `/api/board/${boardId}/submit`, `127.0.0.1:${port}`, {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: 'q1', choice: 'forged' }], comments: [] }),
    });
    assert.equal(submitCrossOrigin.status, 403);

    assert.equal(storeFileCount(), before, 'a refused cross-origin write must not have created a board');
    assert.equal(readBoard(boardId, home).answers.q1.choice, 'Yes', 'the refused cross-origin submit must not have touched the recorded answer');
  });

  await check('C1: a POST whose content-type is not application/json is refused (CORS simple requests need no preflight)', async () => {
    const before = storeFileCount();
    const r = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'text/plain', [SECRET_HEADER]: SECRET },
      body: newBoardBody,
    });
    assert.equal(r.status, 415, 'text/plain is a CORS simple request: it must not be accepted as a board post');
    assert.equal(storeFileCount(), before, 'the text/plain post must not have created a board');

    const formEncoded = await rawRequest(port, 'POST', `/api/board/${boardId}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', [SECRET_HEADER]: SECRET },
      body: newBoardBody,
    });
    assert.equal(formEncoded.status, 415);
  });

  await check('C1: a same-origin write still succeeds -- the guard is not a blanket refusal of headered requests', async () => {
    // The served page's own fetch() carries exactly these headers; if the guard rejected
    // them the whole UI would be dead, so this is the other half of the ablation.
    const r = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        [SECRET_HEADER]: SECRET,
      },
      body: JSON.stringify({ title: 'Same-origin write', blocks: [{ kind: 'markdown', text: '# fine' }] }),
    });
    assert.equal(r.status, 200);
    assert.match(JSON.parse(r.body).boardId, /^b_[0-9a-f]{32}$/);
  });

  await check('C3/M1: a submit against a board with no open round is refused with 409, leaving the sent round untouched', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Round finality',
        blocks: [{ kind: 'question', prompt: 'Force push?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }),
    })).json();
    const finalId = created.boardId;
    const qid = readBoard(finalId, home).blocks[0].id;

    const firstSubmit = await fetch(`${base}/api/board/${finalId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qid, status: 'answered', choice: 'No', note: 'absolutely not' }],
        comments: [{ blockId: qid, anchor: { kind: 'block' }, text: 'no force pushing' }],
      }),
    });
    assert.equal(firstSubmit.status, 200);
    const afterFirst = readBoard(finalId, home);
    const sentAt = afterFirst.rounds[0].sentAt;

    // The forgery: re-submitting after the round was sent
    // rewrote the human's answer, its note, and sentAt itself, with no trace.
    const rewrite = await fetch(`${base}/api/board/${finalId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'go ahead, force push' }],
        comments: [{ blockId: qid, anchor: { kind: 'block' }, text: 'no force pushing' }],
      }),
    });
    assert.equal(rewrite.status, 409, 'a submit with no open round must be refused, not applied to the last sent round');

    const afterRewrite = readBoard(finalId, home);
    assert.equal(afterRewrite.answers[qid].choice, 'No', 'the answer the human actually sent must survive a re-submit');
    assert.equal(afterRewrite.answers[qid].note, 'absolutely not');
    assert.equal(afterRewrite.rounds[0].sentAt, sentAt, 'sentAt must not be rewritten by a later submit');
    // M1: the same 409 is what makes a client retry safe -- a duplicated submit must not
    // duplicate the comment (and with it the pin number PROTOCOL.md renders).
    assert.equal(afterRewrite.comments.length, 1, 'a repeated submit must not duplicate comments');
    assert.equal(afterRewrite.comments[0].n, 1);
  });

  await check('H1: a /wait whose client disconnects stops polling instead of leaking a permanent loop', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Abandoned wait', blocks: [{ kind: 'markdown', text: '# nobody answers this' }] }),
    })).json();

    const before = activeWaitCount();
    // node:http rather than fetch: the point is to hang up mid-request, which needs a
    // handle on the socket. The round is never submitted, so the loop's only way out is
    // noticing the client left.
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/board/${created.boardId}/wait?round=1`, headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } }, res => res.resume());
    req.on('error', () => { /* the hang-up below is the point */ });
    req.end();

    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(activeWaitCount(), before + 1, 'the wait must actually be polling before we hang up on it');

    req.destroy();
    await new Promise(resolve => setTimeout(resolve, 400));
    // (Ablation: with the abort flag removed, waitForRound's `for(;;)` never returns,
    // its finally never runs, and this stays at before+1 forever.)
    assert.equal(activeWaitCount(), before, 'a disconnected client must leave no polling loop behind');
  });

  await check('H1: /wait has a server-side wall-clock ceiling and returns an explicit timeout packet', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Wait ceiling',
        blocks: [{ kind: 'question', prompt: 'Answer me?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();

    const previous = process.env.CLAUDE_BOARD_TIMEOUT_MS;
    process.env.CLAUDE_BOARD_TIMEOUT_MS = '250'; // read per call, so this applies to the wait below only
    try {
      // The check gives up after 5s of its own, so that a daemon with no ceiling fails
      // this assertion loudly instead of hanging the suite. (Ablation: with the
      // deadline check removed, nothing ever submits this round, the request never
      // resolves, and `status` comes back 'client-gave-up'.)
      const abort = new AbortController();
      const started = Date.now();
      const packet = await Promise.race([
        fetch(`${base}/api/board/${created.boardId}/wait?round=1`, { signal: abort.signal })
          .then(r => r.json())
          .catch(err => ({ status: `request failed: ${err.message}` })),
        new Promise(resolve => setTimeout(() => resolve({ status: 'client-gave-up' }), 5000)),
      ]);
      abort.abort();
      const elapsed = Date.now() - started;
      assert.equal(packet.status, 'timeout', `the wait must give up at its own ceiling and report an explicit no-response, per PROTOCOL.md "Packet" (got "${packet.status}" after ${elapsed}ms)`);
      assert.ok(elapsed < 5000, `the wait must return at its ceiling, took ${elapsed}ms`);
      assert.equal(packet.board, created.boardId);
      assert.equal(packet.answers[0].status, 'unanswered');
      assert.equal(activeWaitCount(), 0, 'a capped wait must not leave its loop running either');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_BOARD_TIMEOUT_MS;
      else process.env.CLAUDE_BOARD_TIMEOUT_MS = previous;
    }
  });

  await check('M2/L4: one corrupt store file is skipped rather than 500ing the index and search, and the index reads the store exactly once', async () => {
    const corruptPath = path.join(boardsDirPath, 'b_deadbe11.json');
    writeFileSync(corruptPath, '{"id":"b_deadbe11","blocks":[{"kind":"mark', 'utf8'); // truncated, as an unclean kill mid-write leaves it
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      // (Ablation: without the try/catch in listBoards, JSON.parse throws straight out
      // of the handler and both of these are 500s -- the closed-tab recovery path and
      // archive search both dead until someone deletes the file by hand.)
      const indexRes = await fetch(`${base}/?q=${encodeURIComponent('checkout redesign')}`);
      assert.equal(indexRes.status, 200, 'a corrupt board file must not 500 the index');
      const indexHtml = await indexRes.text();
      assert.ok(indexHtml.includes('Checkout redesign'), 'every readable board must still be listed and filterable');

      const searchRes = await fetch(`${base}/api/search?q=${encodeURIComponent('checkout redesign')}`);
      assert.equal(searchRes.status, 200, 'a corrupt board file must not 500 archive search');
      assert.ok((await searchRes.json()).results.length > 0);

      // L4: the corrupt file is logged once per store walk, so the warning count is a
      // direct count of how many times `GET /?q=` walked the store. Two here: one for
      // the index request, one for the separate /api/search request. The index's own
      // count is what matters -- it is 1 whether or not a query is present, since the
      // filter reads what buildThreadIndex already extracted and never re-walks.
      const indexWarnings = warnings.filter(w => w.includes('b_deadbe11.json'));
      assert.equal(indexWarnings.length, 2, `GET /?q= must walk the store once (plus once for the separate /api/search request), got ${indexWarnings.length} walks`);
    } finally {
      console.warn = realWarn;
      unlinkSync(corruptPath);
    }
  });

  await check('L4: searchBoards uses an already-read store walk when it is given one', async () => {
    const boards = [{
      id: 'b_inmemory', thread: 'th_inmemory', cwd: null, title: 'In-memory only', createdAt: new Date().toISOString(),
      rounds: [], blocks: [], answers: {}, comments: [],
    }];
    // Nothing on disk matches this title, so a result can only come from the array
    // passed in. (Ablation: dropping the parameter makes searchBoards re-walk the store
    // and return nothing here.)
    const results = searchBoards('In-memory only', home, boards);
    assert.equal(results.length, 1);
    assert.equal(results[0].boardId, 'b_inmemory');
  });

  await check('a body split mid-character across socket chunks is decoded intact, not turned into replacement characters', async () => {
    // A 70KB html stage arrives as several socket chunks, and a chunk boundary falls
    // wherever the kernel put it -- routinely inside a multi-byte character. This
    // splits the body at exactly such a boundary rather than hoping for one.
    const stage = `<div class="mock"><p>${'é'.repeat(40)} café ☃ naïve ${'ü'.repeat(40)}</p></div>`;
    const payload = Buffer.from(JSON.stringify({ title: 'Chunked UTF-8', blocks: [{ kind: 'html', html: stage }] }), 'utf8');
    const eAcute = payload.indexOf(Buffer.from('é', 'utf8'));
    assert.ok(eAcute > 0);
    const splitAt = eAcute + 1; // between the two bytes of a single 'é'

    const responseBody = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/board',
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', [SECRET_HEADER]: SECRET, 'content-length': payload.length },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.write(payload.subarray(0, splitAt));
      setTimeout(() => req.end(payload.subarray(splitAt)), 30); // two distinct 'data' events
    });

    const j = JSON.parse(responseBody);
    assert.match(j.boardId || '', /^b_[0-9a-f]{32}$/, `the split body must still parse as JSON: ${responseBody}`);
    const stored = readBoard(j.boardId, home);
    // (Ablation: with `data += chunk`, each Buffer is stringified on its own and the
    // straddling character becomes U+FFFD -- stored corrupt, 200 returned, no error
    // anywhere. That is "a rendered board is always a faithful view of its source"
    // failing silently.)
    assert.ok(!stored.blocks[0].html.includes('�'), 'no character may be replaced by U+FFFD');
    assert.equal(stored.blocks[0].html, stage, 'the stored block must be byte-for-byte what was posted');
  });

  await check('a submit naming a round that is not the open one is refused with 409, and a submit naming no round at all is a 400', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Stale client',
        blocks: [{ kind: 'question', prompt: 'Round one question', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    })).json();
    const staleId = created.boardId;
    const q = readBoard(staleId, home).blocks[0].id;

    await fetch(`${base}/api/board/${staleId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'A', note: 'first answer' }], comments: [] }),
    });
    await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: staleId, blocks: [{ kind: 'markdown', text: '# Round Two' }] }),
    });

    // A tab that slept through round 2 (EventSource has no replay), a second tab, or a
    // plain double-click on Send: all of them re-post round 1's answers.
    const stale = await fetch(`${base}/api/board/${staleId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'B', note: 'stale answer' }], comments: [] }),
    });
    assert.equal(stale.status, 409, 'a submit naming a round that is not open must be refused');
    assert.equal((await stale.json()).round, 2, 'the refusal must name the round that IS open, so a client can resync');

    const after = readBoard(staleId, home);
    // (Ablation: without the round check the server applies this to whatever it thinks
    // is open -- q1 flips to "B" and round 2 is marked sent with everything unanswered.)
    assert.equal(after.answers[q].choice, 'A', "round 1's recorded answer must survive a stale client");
    assert.equal(after.answers[q].note, 'first answer');
    assert.equal(after.rounds[1].status, 'open', 'round 2 must not be marked sent by a submit meant for round 1');
    assert.equal(after.rounds[0].status, 'sent');

    const noRound = await fetch(`${base}/api/board/${staleId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ action: 'send', answers: [], comments: [] }),
    });
    assert.equal(noRound.status, 400, 'a submit that names no round at all cannot be applied to a guessed one');
    assert.equal(readBoard(staleId, home).rounds[1].status, 'open');
  });

  await check('a Host header with anything trailing a bracketed IPv6 literal is refused; a loopback name is matched case-insensitively', async () => {
    // isLoopbackHost dropped everything after `]` unchecked. Not browser-reachable, but
    // the header is reflected verbatim into boardUrl() -- which becomes the URL in the
    // agent's packet and the URL the shim hands to `open`.
    for (const host of ['[::1]@evil.example', '[::1].evil.example', '[::1]junk', '[::1', '[::1]:80x']) {
      const r = await rawRequest(port, 'GET', '/api/health', host);
      assert.equal(r.status, 403, `Host "${host}" must not pass as loopback`);
    }
    for (const host of [`[::1]:${port}`, '[::1]', `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
      const r = await rawRequest(port, 'GET', '/api/health', host);
      assert.equal(r.status, 200, `Host "${host}" is loopback and must be accepted`);
    }
  });

  await check('a subdomain of the reserved .localhost TLD is loopback; a name that merely ends in the letters is not', async () => {
    // `.localhost` is never delegated in the public root, so the mapping behind one of
    // these is always the user's own (browser short-circuit or /etc/hosts) and never an
    // attacker's DNS -- which is what makes it admissible where evil.example is not.
    for (const host of [`board.localhost:${port}`, 'board.localhost', `BOARD.LOCALHOST:${port}`, `a.b.localhost:${port}`]) {
      const r = await rawRequest(port, 'GET', '/api/health', host);
      assert.equal(r.status, 200, `Host "${host}" is under .localhost and must be accepted`);
    }
    // (Ablation: a bare endsWith('localhost') accepts the first three of these, and
    // `notlocalhost` IS an ownable public name.)
    for (const host of ['notlocalhost', 'evil-localhost', 'localhost.evil.example', '.localhost', `board.localhost@evil.example:${port}`]) {
      const r = await rawRequest(port, 'GET', '/api/health', host);
      assert.equal(r.status, 403, `Host "${host}" must not pass as loopback`);
    }
  });

  await check('every HTML response refuses to be framed and carries a CSP', async () => {
    // The index sorts live-first then newest, so a board posted through a CSRF hole is
    // deterministically the top row, with an attacker-chosen cwd as its label -- one
    // clickjacked click from loading a board whose html stage runs at this origin.
    for (const pathName of ['/', `/b/${boardId}`]) {
      const r = await fetch(`${base}${pathName}`);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', `${pathName} must not be framable`);
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp, `${pathName} must carry a CSP`);
      assert.ok(csp.includes("frame-ancestors 'none'"), 'the CSP must forbid framing too');
      assert.ok(csp.includes("default-src 'none'"), 'the CSP must be deny-by-default');
      // A board page's html stage is untrusted content and may not post a form anywhere.
      // The index is the daemon's own chrome and its search box IS a same-origin GET
      // form, so it gets 'self' -- 'none' there is not "stricter", it is a dead search
      // box (the browser refuses the submit outright). See render.mjs INDEX_CSP.
      assert.ok(
        csp.includes(pathName === '/' ? "form-action 'self'" : "form-action 'none'"),
        `${pathName} carries the wrong form-action: ${csp}`,
      );
      // ...and still allow what the page genuinely needs, or the whole UI is dead:
      assert.ok(/script-src[^;]*'unsafe-inline'/.test(csp), 'the page inlines its own module script');
      // Mermaid is vendored (a digest-pinned file under src/vendor/mermaid/, loaded the
      // same content-addressed, same-origin way as the page's other two siblings -- see
      // src/ui.mjs), so no clause may name an external host for it or anything else.
      // A closed set of allowed source expressions rather than a test for the one host
      // that used to be here: a CSP host source needs no scheme, so a literal
      // `cdn.jsdelivr.net` test (or an `https?:` one) would pass `unpkg.com/npm/...`
      // straight through. This is the served header, so it is the last place a host
      // could reach a real browser -- see test/check-pure.mjs for the same gate on the
      // policy strings themselves.
      const allowedCspSources = new Set(["'none'", "'self'", "'unsafe-inline'", 'data:', 'blob:']);
      for (const clause of csp.split(';')) {
        const [directive, ...sources] = clause.trim().split(/\s+/).filter(Boolean);
        if (!directive) continue;
        for (const src of sources) {
          assert.ok(allowedCspSources.has(src),
            `the served ${directive} names ${src}, which is not an allowed source expression -- no external host may reach the header, however it is spelled. Got: ${csp}`);
        }
      }
      assert.ok(/connect-src[^;]*'self'/.test(csp), 'submit and the SSE stream are same-origin fetches');
    }
  });

  // --- the local secret ---------------------------------------------------------
  //
  // "A loopback Host check, an origin check, and a local
  // secret". The Host check closes the network and the origin check closes the browser;
  // neither can see a local process, which is what these cover. Every write above sends
  // the secret (writeHeaders), so the ones here that deliberately do not are what make
  // the gate provable.

  await check('SEC: a write with no secret, and a write with the wrong secret, are both 401 with no body and change nothing', async () => {
    const before = readdirSync(path.join(home, 'boards')).filter(f => f.endsWith('.json')).length;
    const body = JSON.stringify({ title: 'Unauthenticated probe', blocks: [{ kind: 'markdown', text: '# planted' }] });

    // (Ablation: drop isAuthorizedWrite from createRequestHandler and every case below
    // returns 200 -- which is the gadget: a local process posts its own board
    // naming any `cwd` it likes and reads that directory off the served page.)
    const none = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(none.status, 401, 'a write with no secret must be refused');
    assert.equal(none.body, '', '401 carries no body: an unauthorised caller learns nothing');

    const wrong = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: 'b'.repeat(64) },
      body,
    });
    assert.equal(wrong.status, 401, 'a wrong secret of the RIGHT LENGTH must still be refused');

    const short = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: 'a' },
      body,
    });
    assert.equal(short.status, 401, 'a wrong secret of a different length must be refused, not throw');

    // ...and the same gate covers submit, not just board creation.
    const submit = await rawRequest(port, 'POST', `/api/board/${boardId}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: 'q1', choice: 'forged' }], comments: [] }),
    });
    assert.equal(submit.status, 401);

    assert.equal(
      readdirSync(path.join(home, 'boards')).filter(f => f.endsWith('.json')).length, before,
      'no unauthenticated write may have created a board',
    );
    assert.equal(readBoard(boardId, home).answers.q1.choice, 'Yes', 'the recorded answer must be untouched');
  });

  await check('SEC: the right secret still succeeds -- the gate is not a blanket refusal', async () => {
    const r = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ title: 'Authenticated write', blocks: [{ kind: 'markdown', text: '# fine' }] }),
    });
    assert.equal(r.status, 200, 'the shim holds the secret and must still be able to post');
    assert.match(JSON.parse(r.body).boardId, /^b_[0-9a-f]{32}$/);
  });

  // --- the read gate --------------------------------
  //
  // THIS is the ablation site for the read gate. Delete the `isAuthorizedRead` block
  // from createRequestHandler and every assertion in this section fails while the rest
  // of the suite — and the rest of this file — stays green.

  const BROWSER_NAV = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

  await check('SEC: index, board page, search and the event stream are all refused with no credential', async () => {
    // The overturned decision: these four used to answer 200 to anything
    // that could open a socket, which handed every local process the source excerpts,
    // questions and answers of every board in the store.
    const index = await rawRequest(port, 'GET', '/', `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(index.status, 401, 'the thread index must not render without a credential');

    const page = await rawRequest(port, 'GET', `/b/${boardId}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(page.status, 401, 'the served board page must not render without a credential');
    assert.ok(!page.body.includes('id="board-data"'), 'and must not leak the board JSON in the refusal');

    const search = await rawRequest(port, 'GET', '/api/search?q=trip', `127.0.0.1:${port}`);
    assert.equal(search.status, 401, 'archive search must not answer without a credential');

    const waiting = await rawRequest(port, 'GET', `/api/board/${boardId}/wait?round=1`, `127.0.0.1:${port}`);
    assert.equal(waiting.status, 401, '/wait must not answer without a credential');

    const sse = await openSseClient(port, boardId, { headers: {} });
    try {
      assert.equal(sse.status, 401, 'the SSE stream must not open without a credential');
    } finally {
      sse.req.destroy();
    }

    // The one deliberate exception, and the reason it is one: install.sh polls it with
    // plain curl to decide whether the service came up.
    const health = await rawRequest(port, 'GET', '/api/health', `127.0.0.1:${port}`);
    assert.equal(health.status, 200, '/api/health stays open — install.sh has no credential to offer');
  });

  await check('SEC: the vendored mermaid engine is the ONE asset a credential-less GET may have, and ui/styles still are not', async () => {
    // The stage that fetches it is sandboxed with no `allow-same-origin`, so it runs at
    // an opaque origin and its subresource request carries no cookie at all — gated, the
    // engine 401s and every diagram inside every posted artifact stays raw source. What
    // the exception discloses is a third-party library's own bytes under a name that is a
    // digest of them; see src/server.mjs's `isOpenRoute` for the full argument.
    const engine = await rawRequest(port, 'GET', `/b/${MERMAID_ASSET}`, `127.0.0.1:${port}`);
    assert.equal(engine.status, 200, 'a stage holds no credential, so the engine must answer without one');
    assert.match(engine.headers['content-type'] || '', /javascript/, 'and answer as script');

    // The exception is name-shaped and nothing else rides on it. (Ablation: widen
    // `isOpenRoute`'s test to `ASSET_NAME` and both of these turn 200.)
    const script = await rawRequest(port, 'GET', `/b/${SCRIPT_ASSET}`, `127.0.0.1:${port}`);
    assert.equal(script.status, 401, 'the client script is this board\'s own behaviour and stays gated');
    const style = await rawRequest(port, 'GET', `/b/${STYLE_ASSET}`, `127.0.0.1:${port}`);
    assert.equal(style.status, 401, 'the stylesheet stays gated');

    // A name that merely starts the right way is not the right shape.
    for (const name of ['mermaid-0123456789abcde.js', 'mermaid-0123456789abcdefg.js', 'mermaid-0123456789ABCDEF.js', 'mermaid-0123456789abcdef.css']) {
      const bad = await rawRequest(port, 'GET', `/b/${name}`, `127.0.0.1:${port}`);
      assert.equal(bad.status, 401, `"${name}" is not the engine's name shape and must stay behind the gate`);
    }
    // A hash-shaped name that is simply not on disk is still open, and says nothing:
    // 404, the same answer a credential-holding caller gets.
    const absent = await rawRequest(port, 'GET', '/b/mermaid-0123456789abcdef.js', `127.0.0.1:${port}`);
    assert.equal(absent.status, 404, 'an engine version this store never wrote is a plain 404');
  });

  await check('SEC: the refusal a browser navigation gets is a page naming the recovery command, not a bare status', async () => {
    const refused = await rawRequest(port, 'GET', `/b/${boardId}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(refused.status, 401);
    assert.match(refused.headers['content-type'] || '', /text\/html/, 'a navigation gets a page');
    // The page renders to any TAB that lands here -- a cross-origin-shaped navigation
    // among them -- so unlike the JSON `recover` field below (read by something that
    // already holds a terminal on this machine) it must not name this reader's home
    // directory or the account it belongs to. It gets the RELATIVE recovery command,
    // never the absolute one `recoveryCommand()` defaults to (Low: refusal-page
    // path/username disclosure).
    const pageCommand = recoveryCommand(undefined, { absolute: false });
    assert.ok(refused.body.includes(pageCommand), `the refusal must name the exact command: ${pageCommand}`);
    assert.match(refused.body, /node bin\/authorize\.mjs/, 'a bare relative command, actionable from inside the reader\'s own clone');
    assert.ok(!refused.body.includes(repoRoot()), 'the refusal page must not disclose the absolute clone path');
    assert.doesNotMatch(refused.body, /\/Users\//, 'nor, inside it, the username');
    assert.doesNotMatch(
      String(refused.headers['www-authenticate'] || ''), /./,
      'no WWW-Authenticate: a browser password prompt in front of the page explaining the fix is worse than no page at all'
    );

    // An API/XHR caller gets the status and no markup. Same code, so "no credential" is
    // one number everywhere and PROTOCOL.md can document one number. This caller
    // already holds a terminal on the machine (curl, the shim), so its JSON body keeps
    // the fully pasteable absolute command -- this low is scoped to the rendered page.
    const api = await rawRequest(port, 'GET', '/api/search?q=trip', `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(api.status, 401, 'the same status for an API caller');
    assert.doesNotMatch(api.headers['content-type'] || '', /text\/html/, 'but not a page of markup');
    assert.equal(JSON.parse(api.body).recover, recoveryCommand(), 'it still names the fix, as one JSON field, in its pasteable absolute form');
  });

  await check('SEC: a handoff authorizes a browser exactly once, and lands it on a clean URL', async () => {
    const minted = JSON.parse((await rawRequest(port, 'POST', '/api/handoff', `127.0.0.1:${port}`, {
      headers: writeHeaders(),
      body: JSON.stringify({ boardId }),
    })).body);
    assert.match(minted.token, HANDOFF_TOKEN_RE, 'the handoff token is 32 random bytes as hex');

    const redeemed = await rawRequest(port, 'GET', `/auth/${minted.token}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(redeemed.status, 302, 'redeeming a handoff redirects rather than rendering');
    assert.equal(redeemed.headers.location, `/b/${boardId}`, 'to the board it was minted for');
    assert.doesNotMatch(redeemed.headers.location, /auth|token|secret|cb_session/, 'and the URL left in the address bar carries no credential');

    const setCookie = [].concat(redeemed.headers['set-cookie'] || []).join('; ');
    assert.match(setCookie, new RegExp(`${SESSION_COOKIE}=[0-9a-f]{64}`), 'the browser is handed the session cookie');
    assert.match(setCookie, /HttpOnly/, 'page script must not be able to read it');
    assert.match(setCookie, /SameSite=Strict/, 'no other origin may cause it to be sent');
    assert.match(setCookie, /Path=\//, 'it covers every read route, not one board');
    assert.doesNotMatch(setCookie, /Domain=/i, 'host-only: no Domain attribute, so no sibling host can claim it');
    // Both halves, because they pull against each other and only one of them used to be
    // pinned. Long enough that bookmark-days-later works; SHORT enough that
    // the exposure — cookies are not port-scoped, so any other
    // loopback server the reviewer visits receives this value — expires while expiring it
    // is still worth something. An unbounded upper end is how this sat at 400 days.
    const maxAge = Number((setCookie.match(/Max-Age=(\d+)/) || [])[1]);
    assert.ok(maxAge > 7 * 24 * 3600, `the cookie must outlive the browser session (Max-Age=${maxAge}s) — a bookmark opened days later still has to work`);
    assert.ok(maxAge <= 90 * 24 * 3600, `the cookie must not be effectively permanent (Max-Age=${maxAge}s) — it reaches every other server on this host`);

    // The cookie alone, with no handoff and no secret, is
    // what makes reloading and bookmarking work.
    const cookie = setCookie.split(';')[0];
    const reload = await rawRequest(port, 'GET', `/b/${boardId}`, `127.0.0.1:${port}`, { headers: { ...BROWSER_NAV, cookie } });
    assert.equal(reload.status, 200, 'the authorized browser renders the board');
    assert.ok(reload.body.includes('id="board-data"'));
    assert.equal(reload.headers['set-cookie'], undefined, 'the board page hands out no credential of its own — its bytes stay a pure function of the board JSON');

    // Single-use. The replay is what a process that read the URL out of
    // `ps` would attempt, and it gains nothing.
    const replay = await rawRequest(port, 'GET', `/auth/${minted.token}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(replay.status, 401, 'a handoff is single-use: replaying it is refused');
    assert.equal([].concat(replay.headers['set-cookie'] || []).length, 0, 'and hands out no cookie');
    assert.ok(replay.body.includes(recoveryCommand(undefined, { absolute: false })), 'the replay refusal is the same page as any other refusal');

    // Never-existed is the same answer as already-used: a poller must not learn that it
    // found a real token and merely arrived late.
    const forged = await rawRequest(port, 'GET', `/auth/${'f'.repeat(64)}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(forged.status, replay.status, 'a forged token and a spent one are refused identically');
    assert.equal(forged.body, replay.body, 'byte-identical: the refusal must not distinguish them');
  });

  await check('SEC: a handoff expires, and an expired one is refused exactly like a spent one', async () => {
    // Its own daemon, with a TTL short enough to watch elapse. The TTL seam exists for
    // this: asserting expiry against the 30s default would mean a 30s check.
    const ttlHome = mkdtempSync(path.join(tmpdir(), 'claude-board-ttl-'));
    const prev = process.env.CLAUDE_BOARD_HANDOFF_TTL_MS;
    process.env.CLAUDE_BOARD_HANDOFF_TTL_MS = '60';
    let ttlServer, ttlPort;
    try {
      ({ server: ttlServer, port: ttlPort } = await startServer({ home: ttlHome, port: 0, secret: SECRET }));
      const minted = JSON.parse((await rawRequest(ttlPort, 'POST', '/api/handoff', `127.0.0.1:${ttlPort}`, {
        headers: writeHeaders(), body: JSON.stringify({}),
      })).body);
      await new Promise(r => setTimeout(r, 200));
      const late = await rawRequest(ttlPort, 'GET', `/auth/${minted.token}`, `127.0.0.1:${ttlPort}`, { headers: BROWSER_NAV });
      assert.equal(late.status, 401, 'an expired handoff is refused');
      assert.equal([].concat(late.headers['set-cookie'] || []).length, 0, 'and sets no cookie');
    } finally {
      if (ttlServer) ttlServer.close();
      if (prev === undefined) delete process.env.CLAUDE_BOARD_HANDOFF_TTL_MS;
      else process.env.CLAUDE_BOARD_HANDOFF_TTL_MS = prev;
      rmSync(ttlHome, { recursive: true, force: true });
    }
  });

  await check('SEC: minting a handoff needs the secret — a browser cannot mint itself a second credential', async () => {
    const none = await rawRequest(port, 'POST', '/api/handoff', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(none.status, 401, 'no credential mints nothing');

    const asBrowser = await rawRequest(port, 'POST', '/api/handoff', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie: sessionCookieHeader() },
      body: '{}',
    });
    assert.equal(asBrowser.status, 401, 'the session cookie is accepted on submit and nowhere else — least of all on the route that mints credentials');
  });

  await check('SEC: a process holding neither credential can neither read a board nor forge an answer on it', async () => {
    // Written to match the requirement's exact wording: attempt both, from a caller that cannot read
    // the secret file and was never handed the browser cookie. This is the whole shape
    // of the hole that was closed, in one check.
    const target = JSON.parse((await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Criterion 5', blocks: [{ kind: 'question', prompt: 'Ship?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }] }),
    })).body);
    const tid = target.boardId;
    const qid = readBoard(tid, home).blocks[0].id;

    // Attempt one: read it.
    const read = await rawRequest(port, 'GET', `/b/${tid}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(read.status, 401, 'reading the board is refused');
    assert.ok(!read.body.includes('Ship?'), 'and the question text does not appear in the refusal');

    // Attempt two: forge an answer on it, speaking exactly as the page's own fetch does
    // (same-origin headers, JSON content type) but with no cookie and no secret.
    const forge = await rawRequest(port, 'POST', `/api/board/${tid}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'forged' }], comments: [] }),
    });
    assert.equal(forge.status, 401, 'forging an answer is refused');
    assert.equal(forge.body, '', 'a write refusal still carries no body');
    assert.equal(readBoard(tid, home).rounds[0].status, 'open', 'and the round is untouched');
    assert.equal(readBoard(tid, home).answers[qid], undefined, 'no answer was recorded');

    // The board-scoped fallback the old design accepted here is gone: there is no
    // weaker credential left to try. Anything derived per board is now just wrong.
    const oldStyle = await rawRequest(port, 'POST', `/api/board/${tid}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', cookie: `cb_submit=${'0'.repeat(64)}` },
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });
    assert.equal(oldStyle.status, 401, 'the deleted board-scoped submit cookie must not have been left accepted anywhere');
  });

  await check('SEC: the authorized browser can press Send, and its cookie is not a substitute for the secret', async () => {
    const created = JSON.parse((await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Cookie submit', blocks: [{ kind: 'question', prompt: 'Ok?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).body);
    const cid = created.boardId;
    const qid = readBoard(cid, home).blocks[0].id;
    const cookie = sessionCookieHeader();

    // Exactly what the page's own fetch() sends: same-origin headers, the cookie, no secret.
    // (Ablation: drop the cookie arm of isAuthorizedWrite and this is 401 -- i.e. no
    // reviewer can ever press Send, which is the entire product.)
    const sent = await rawRequest(port, 'POST', `/api/board/${cid}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie },
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'from the page' }], comments: [] }),
    });
    assert.equal(sent.status, 200, 'the reviewer must be able to answer the board from the browser');
    assert.equal(readBoard(cid, home).answers[qid].note, 'from the page');

    // The session cookie reads and answers. It is refused in the secret header, so it
    // can never reach the one route that resolves a file.
    const token = cookie.split('=')[1];
    const asSecret = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: token },
      body: JSON.stringify({ title: 'Escalation attempt', cwd: home, blocks: [{ kind: 'markdown', text: '# no' }] }),
    });
    assert.equal(asSecret.status, 401, 'the session cookie must not be usable as the secret');

    const asBoardPost = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie },
      body: JSON.stringify({ title: 'Escalation attempt 2', cwd: home, blocks: [{ kind: 'markdown', text: '# no' }] }),
    });
    assert.equal(asBoardPost.status, 401, 'nor to create a board — the route that resolves a file stays behind the secret alone');
  });

  await check('S1: a cross-origin-shaped GET /wait carrying only the cookie is refused, and drains nothing', async () => {
    // AC 3's exact wording: a cross-origin-shaped GET /wait with a cookie must leave
    // `delivered` flags and the board document unchanged. `handleWait` writes on its
    // timeout branch and always spends undelivered comments (marks them `delivered:
    // true`) once the response lands (see its own comments and drainUndeliveredComments'
    // above) -- exactly the two things this proves untouched.
    //
    // "Cross-origin-shaped" means the one case isSameOriginRead cannot see through: NO
    // Origin and NO Sec-Fetch-Site at all -- what an old browser sends on a genuinely
    // cross-origin request (a modern one sets Sec-Fetch-Site: cross-site, which
    // isSameOriginRead already refuses; see its own comment on why absence has to pass
    // for the ordinary bookmark case). A daemon that cannot tell that shape apart from a
    // legitimate same-origin GET is exactly why the MUTATION needs its own gate rather
    // than a stronger read check -- this is the residual the audit named MEDIUM.
    //
    // Setup follows the ADR 35 pattern above: an artifact round submitted with a comment
    // of its own (not awaited, so it is a drain candidate) and a question round in the
    // SAME thread to wait on.
    const html = '<!doctype html><html><body><h1>S1 page</h1></body></html>';
    const artifact = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'S1 artifact', blocks: [{ kind: 'html', html }] }),
    })).json();
    const artifactBlock = readBoard(artifact.boardId, home).blocks[0].id;
    await fetch(`${base}/api/board/${artifact.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1, action: 'send', answers: [],
        comments: [{ blockId: artifactBlock, anchor: { kind: 'block' }, text: 'S1_UNDELIVERED' }],
      }),
    });

    const asking = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'S1 question',
        thread: artifact.thread,
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const askQid = readBoard(asking.boardId, home).blocks[0].id;

    const cookie = sessionCookieHeader();
    const before = snapshotTree(home);

    // The exploitable shape: only the cookie, no Origin, no Sec-Fetch-Site. `fetch()`
    // cannot forge these anyway (see rawRequest's own comment), so a bare cookie is
    // already indistinguishable from cross-origin without them.
    const bareCookie = await rawRequest(port, 'GET', `/api/board/${asking.boardId}/wait?round=1`, `127.0.0.1:${port}`, {
      headers: { cookie },
    });
    assert.equal(bareCookie.status, 401, 'a GET /wait carrying only the cookie, with nothing to prove same-origin, must be refused');
    assert.equal(bareCookie.body, '', 'a write-gated refusal carries no body, same as any other write refusal');

    // Even a well-formed SAME-origin cookie request must be refused: no browser page
    // ever legitimately calls this route (bin/mcp.mjs holds the secret and sends it on
    // every request, reads included -- see its own comment), so `wait` stays
    // deliberately off every cookie-write allowlist rather than being added to one.
    const sameOriginCookie = await rawRequest(port, 'GET', `/api/board/${asking.boardId}/wait?round=1`, `127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie },
    });
    assert.equal(sameOriginCookie.status, 401, 'a same-origin GET /wait carrying only the cookie must also be refused -- this route is secret-only');

    assert.notEqual(readBoard(artifact.boardId, home).comments[0].delivered, true,
      'the pending comment must still be undelivered -- neither forged /wait may spend it');
    const after = snapshotTree(home);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file may be added or removed by either forged /wait');
    for (const rel of before.keys()) {
      assert.equal(after.get(rel).sha, before.get(rel).sha, `${rel} must be byte-identical -- a forged /wait must write nothing`);
    }

    // The budget: the secret-holding caller this route exists for still works exactly
    // as before, and still delivers the comment neither forged attempt above could
    // spend -- this is a gate on the credential, not a blanket refusal of /wait.
    await fetch(`${base}/api/board/${asking.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: askQid, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet = await (await fetch(`${base}/api/board/${asking.boardId}/wait?round=1`)).json();
    assert.equal(packet.status, 'submitted', 'the legitimate secret-holding wait still resolves normally');
    assert.deepEqual(packet.comments.map(c => c.text), ['S1_UNDELIVERED'], 'and still drains the pending comment -- the fix gates the credential, not the feature');
    assert.equal(readBoard(artifact.boardId, home).comments[0].delivered, true, 'now delivered, by the authorized caller');
  });

  await check('SEC: the documented recovery command re-authorizes a browser that holds nothing', async () => {
    // Run as the user runs it: the actual command the refusal page prints,
    // spawned as a real process against this check's daemon. --print rather than the
    // default so no browser is ever launched by the suite.
    const authorizeBin = fileURLToPath(new URL('../bin/authorize.mjs', import.meta.url));
    assert.ok(recoveryCommand().includes(authorizeBin), 'the refusal page must name this exact file');

    // execFile, never execFileSync: the daemon it talks to is in THIS process, so a
    // synchronous spawn would block the event loop that has to answer it.
    const out = (await promisify(execFile)(process.execPath, [authorizeBin, '--print', boardId], {
      env: { ...process.env, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_SECRET_FILE: SECRET_FILE },
      encoding: 'utf8',
    })).stdout.trim();
    assert.match(out, new RegExp(`^http://127\\.0\\.0\\.1:${port}/auth/[0-9a-f]{64}$`), 'it prints one pasteable handoff URL and nothing else');

    // A fresh cookie jar — a second profile, a different browser — follows it and is
    // authorized. Nothing was reinstalled, nothing restarted, the store untouched.
    const beforeBoards = readdirSync(path.join(home, 'boards')).length;
    const token = out.slice(out.lastIndexOf('/') + 1);
    const redeemed = await rawRequest(port, 'GET', `/auth/${token}`, `127.0.0.1:${port}`, { headers: BROWSER_NAV });
    assert.equal(redeemed.status, 302);
    assert.equal(redeemed.headers.location, `/b/${boardId}`, 'and lands on the board that was asked for');
    const cookie = [].concat(redeemed.headers['set-cookie'] || []).join('; ').split(';')[0];
    const page = await rawRequest(port, 'GET', `/b/${boardId}`, `127.0.0.1:${port}`, { headers: { ...BROWSER_NAV, cookie } });
    assert.equal(page.status, 200, 'the newly-authorized browser reads the board');
    assert.equal(readdirSync(path.join(home, 'boards')).length, beforeBoards, 'authorizing touches no board in the store');
  });

  await check('SEC: a daemon with no secret on disk refuses everything gated rather than falling open', async () => {
    // The fail-closed half. (Ablation: `if (!secret) return true` in isAuthorizedWrite
    // or isAuthorizedRead -- a plausible-looking "don't break machines that never
    // installed" concession -- and a machine with no secret file is wide open.)
    const bareHome = mkdtempSync(path.join(tmpdir(), 'claude-board-nosecret-'));
    // ...and says so, once, on stderr where launchd keeps it: a daemon silently
    // refusing everything with no explanation is the same support call either way.
    const said = [];
    const realError = console.error;
    console.error = (...args) => said.push(args.join(' '));
    let bare, barePort;
    try {
      ({ server: bare, port: barePort } = await startServer({ home: bareHome, port: 0, secret: null }));
    } finally {
      console.error = realError;
    }
    assert.ok(said.some(l => /no local secret at/.test(l) && /install\.sh/.test(l)), 'a daemon with no secret must say so plainly on stderr');
    try {
      const r = await rawRequest(barePort, 'POST', '/api/board', `127.0.0.1:${barePort}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No secret anywhere', blocks: [] }),
      });
      assert.equal(r.status, 401);
      const readable = await rawRequest(barePort, 'GET', '/', `127.0.0.1:${barePort}`, { headers: BROWSER_NAV });
      assert.equal(readable.status, 401, 'reads fail closed too: with no secret there is no cookie the daemon could honestly accept');
      const health = await rawRequest(barePort, 'GET', '/api/health', `127.0.0.1:${barePort}`);
      assert.equal(health.status, 200, 'but the daemon has not shut down — install.sh can still see it came up');
    } finally {
      bare.close();
      rmSync(bareHome, { recursive: true, force: true });
    }
  });

  // --- thread-level cwd binding, the call site -------------------------

  await check('C2: a NEW board in an EXISTING thread cannot name a different cwd', async () => {
    const projectA = projectDir('thread-bound-a');
    const projectB = projectDir('thread-bound-b');
    writeFileSync(path.join(projectB, 'private.md'), '# the other project\n');

    const first = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Thread board 1', cwd: projectA, blocks: [{ kind: 'markdown', text: '# one' }] }),
    })).json();
    assert.equal(readBoard(first.boardId, home).cwd, projectA);

    const before = readdirSync(path.join(home, 'boards')).filter(f => f.endsWith('.json')).length;
    // A second board in the SAME thread, naming somewhere else entirely. src/board.mjs
    // has refused this since the C2 fix -- but only when the server tells it what the
    // thread is bound to. (Ablation: drop `threadCwd` from the createBoard call in
    // handlePostBoard and this returns 200, storing cwd=projectB, so a reviewer
    // following the thread lands on a board reading a directory the thread never chose.)
    const retarget = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Thread board 2',
        thread: first.thread,
        cwd: projectB,
        blocks: [{ kind: 'markdown', source: { path: 'private.md' } }],
      }),
    });
    assert.equal(retarget.status, 400, 'a second board in the thread must not be able to move its project directory');
    assert.match((await retarget.json()).error, /cannot retarget thread/);
    assert.equal(
      readdirSync(path.join(home, 'boards')).filter(f => f.endsWith('.json')).length, before,
      'the refused post must not have created a board',
    );

    // Agreeing with the bound directory is not a retarget, and omitting it inherits.
    const agreeing = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Thread board 3', thread: first.thread, cwd: projectA, blocks: [{ kind: 'markdown', text: '# three' }] }),
    })).json();
    assert.equal(readBoard(agreeing.boardId, home).cwd, projectA);

    const inherited = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Thread board 4', thread: first.thread, blocks: [{ kind: 'markdown', text: '# four' }] }),
    })).json();
    assert.equal(readBoard(inherited.boardId, home).cwd, projectA, 'a board that names no cwd inherits the thread\'s');
  });

  // --- per-round title -----------------------------------------------------------

  await check('a later round\'s title reaches the rendered round label instead of being dropped', async () => {
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'feat/round-one-branch',
        blocks: [{ kind: 'question', prompt: 'First?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const tid = created.boardId;
    const q = readBoard(tid, home).blocks[0].id;

    await fetch(`${base}/api/board/${tid}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });

    const second = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: tid, title: 'fix/round-two-branch', blocks: [{ kind: 'markdown', text: '# second round' }] }),
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).round, 2);

    const stored = readBoard(tid, home);
    assert.equal(stored.rounds[1].title, 'fix/round-two-branch', 'the round must carry its own title');
    assert.equal(stored.title, 'feat/round-one-branch', 'the board title is round 1\'s and is not rewritten');

    // Asserted against the RENDERED markup with the <style> block, the #board-data
    // payload and the client script stripped: the title is also a value in the inlined
    // board JSON, so a bare .includes() on the raw page would pass even with the label
    // still reading a bare "Round 2".
    const markup = renderedMarkup(await (await fetch(`${base}/b/${tid}`)).text());
    // (Ablation: drop `title` from addRound's round object, or from the label in
    // renderRoundSection, and this fails while everything else stays green -- which is
    // exactly the state this feature was in.)
    assert.match(markup, /<div class="round-label">Round 2 · fix\/round-two-branch<\/div>/);
    assert.match(markup, /<div class="round-label">Round 1 · feat\/round-one-branch · sent<\/div>/, 'a sent round keeps its title alongside the sent marker');
  });

  // --- a fixture round trip per migrated shape ------
  // Three shapes, not five: the visual-choice board (/example), the artifact-only board
  // that returns without an answer (/visualize, /explain, /gamify), and the single-
  // question-with-map-context board (/wayfind). Same cycle as the round trip above
  // (:284, :325) -- post, render, answer where the shape has one, read the packet back
  // -- against a payload in the exact shape each real caller now posts (PROTOCOL.md's
  // `choose-between-rendered-variants` section; the `/visualize` skill's "Post to
  // the board"; `/wayfind`'s Mode: Work step 1 -- both of those live in ~/.claude, not
  // here, so neither is written as a path). Every assertion below is on
  // the resolved, rendered, read-back result, never on a bare 200 -- see the next check's
  // own comment for why that distinction is the entire point.

  await check('visual-choice round trip (/example\'s shape): post a choose-between-rendered-variants question, render both options\' own rendered blocks, pick one, and read the pick back off the packet', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Which mockup?',
        blocks: [{
          kind: 'question',
          prompt: 'Which mockup should we build?',
          widget: 'choose-between-rendered-variants',
          options: [
            { label: 'Sidebar nav', description: 'nav rail on the left', block: { kind: 'markdown', text: '# Sidebar nav\n\nNav rail pinned to the left edge.' } },
            { label: 'Top nav', description: 'nav bar across the top', block: { kind: 'html', html: '<div class="mock"><nav>Top nav mockup</nav></div>' } },
          ],
        }],
      }),
    });
    assert.equal(r.status, 200);
    const posted = await r.json();
    const variantBoardId = posted.boardId;

    const stored = readBoard(variantBoardId, home);
    const qBlock = stored.blocks.find(b => b.kind === 'question');
    assert.equal(qBlock.widget, 'choose-between-rendered-variants');
    assert.equal(qBlock.options.length, 2);
    // Each option's block minted a real, unique id through the same path a compare
    // side's own block does (PROTOCOL.md) -- not an inert string.
    assert.notEqual(qBlock.options[0].block.id, qBlock.options[1].block.id);

    // render: both options' own rendered content is on the page, not just their labels.
    const markup = renderedMarkup(await (await fetch(`${base}/b/${variantBoardId}`)).text());
    assert.match(markup, /data-choice="Sidebar nav"/);
    assert.match(markup, /data-choice="Top nav"/);
    assert.ok(markup.includes('Nav rail pinned to the left edge.'), 'the markdown option\'s own rendered block must be on the page');
    assert.ok(markup.includes('Top nav mockup'), 'the html option\'s own mock content must be on the page');

    // answer: pick one, following the same /wait + /submit shape as the round trip above.
    const waitPromise = fetch(`${base}/api/board/${variantBoardId}/wait?round=1`).then(res => res.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${variantBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qBlock.id, status: 'answered', choice: 'Top nav', note: '' }],
        comments: [],
      }),
    });
    assert.equal(submitRes.status, 200);

    // read the packet back: the pick is reported, not just the post.
    const packet = await waitPromise;
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.answers.length, 1);
    assert.equal(packet.answers[0].id, qBlock.id);
    assert.equal(packet.answers[0].choice, 'Top nav', 'the packet must report which rendered option was picked');
  });

  await check('artifact-only round trip (/visualize + /explain + /gamify\'s shape): post an html-only board with no question, render the artifact, and prove the packet a caller reads back reports the post rather than an answer nobody was ever asked for', async () => {
    const html = '<!doctype html><html><body><h1>ARTIFACT_ONLY_MARKER dashboard</h1></body></html>';
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Rendered dashboard',
        blocks: [{ kind: 'html', html }],
      }),
    });
    assert.equal(r.status, 200);
    const posted = await r.json();
    const artifactBoardId = posted.boardId;

    // render: the artifact itself, byte for byte, inside a sandboxed stage.
    const stored = readBoard(artifactBoardId, home);
    assert.equal(stored.blocks[0].kind, 'html');
    assert.equal(stored.blocks[0].html, html, 'the stored block must be byte-for-byte what was posted');
    // Stripped, not raw: the raw page also embeds `block.html` verbatim inside the
    // #board-data JSON payload for client hydration, so a bare .includes() on raw
    // markup would pass even if the iframe's own srcdoc never carried the content at
    // all -- the same needle-must-be-found-where-the-renderer-put-it trap this file's
    // own renderedMarkup() exists for (see its doc comment above).
    const markup = renderedMarkup(await (await fetch(`${base}/b/${artifactBoardId}`)).text());
    assert.ok(markup.includes('<iframe class="html-stage" sandbox="allow-scripts" srcdoc="'), 'the artifact must render as a sandboxed html stage');
    assert.ok(markup.includes('ARTIFACT_ONLY_MARKER'), 'the artifact\'s own content must be on the page, inside the rendered iframe\'s srcdoc');

    // no answer: this is the no-question caller -- a round with no question
    // block anywhere in it has nothing a human is ever asked to submit. Prove that from
    // the STORED, normalized board, not the raw payload: no question block exists
    // anywhere on this round, and nothing has ever been answered.
    assert.equal(stored.blocks.filter(b => b.kind === 'question').length, 0);
    assert.deepEqual(stored.answers, {}, 'nothing was ever answered -- there was no question to answer');

    // read the packet back: everything a caller needs to report the post is already in
    // the POST response alone -- board id, round, url, thread -- with no /wait required.
    // This is the exact packet bin/mcp.mjs's askTool constructs for this shape
    // (packetResult, status 'posted'), reconstructed here from nothing but that response.
    const packet = {
      board: posted.boardId,
      thread: posted.thread,
      round: posted.round,
      status: 'posted',
      answers: [],
      comments: [],
      url: posted.url,
    };
    assert.equal(packet.status, 'posted', 'the packet must report the post, not an answer nobody was ever asked for');
    assert.equal(packet.answers.length, 0);

    // and prove the negative directly, the same technique H1's hang-up-mid-wait check
    // above uses (node:http, not fetch, to get a handle on the socket): /wait genuinely
    // starts polling this round -- it is not somehow pre-closed -- and nothing ever
    // resolves it, because nothing here ever submits. A round with no question is never
    // implicitly "answered" by the server; it simply has nothing that will ever complete
    // a wait, which is exactly why a caller for this shape must not wait at all.
    const before = activeWaitCount();
    const waitReq = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${artifactBoardId}/wait?round=1`, headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } },
      res => res.resume(),
    );
    waitReq.on('error', () => { /* the hang-up below is the point */ });
    waitReq.end();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(activeWaitCount(), before + 1, 'a caller who does choose to wait must still find something real to poll');
    waitReq.destroy();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(activeWaitCount(), before, 'no submit ever landed on this round -- the only way out was the client leaving');
  });

  await check('the flow the manual prescribes: post an artifact, then ask about it, and the question is a SECOND round beside it -- the artifact keeps its own page, and that page is still a page board', async () => {
    // The exact two calls bin/mcp.mjs makes: the first has no boardId, the
    // second carries the session's boardId and nothing else new. Nothing here
    // submits anything in between, because nothing can -- an artifact round asks
    // nothing, so `ask` returns the instant it lands (the check above) and the
    // board's own send bar refuses to send it (ADR.md entry 35).
    //
    // What this pins is the amend rule: "the latest round is open, so amend it"
    // was written for an agent still assembling a round the reviewer has not
    // answered. An artifact round is open forever, so that rule swallowed every
    // later ask -- the question landed INSIDE the artifact's round, the artifact
    // stopped being a page round, and the two rounds a reviewer flips between
    // (ADR.md entry 42) were unreachable through the shipped tool. There is no
    // client involved in this at all: it is the daemon's own routing.
    const artifact = '<!doctype html><html><body><h1>TWO_ASK_ARTIFACT</h1></body></html>';
    const first = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Rendered dashboard', blocks: [{ kind: 'html', html: artifact }] }),
    })).json();
    assert.equal(first.round, 1);

    const second = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: first.boardId,
        title: 'Anything to change?',
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }),
    })).json();
    assert.equal(second.round, 2, 'the question must open a round of its own -- a round nobody can answer is not a round to amend');

    const stored = readBoard(first.boardId, home);
    assert.equal(stored.rounds.length, 2, 'two rounds, so two pages');
    assert.deepEqual(stored.blocks.filter(b => b.round === 1).map(b => b.kind), ['html'],
      'round 1 must still hold the artifact and nothing else -- that is what keeps it a page');
    assert.deepEqual(stored.blocks.filter(b => b.round === 2).map(b => b.kind), ['question']);
    assert.equal(isPageRound(stored.blocks.filter(b => b.round === 1)), true,
      'the artifact round is still a page round after the question lands beside it');
    assert.equal(isPageRound(stored.blocks.filter(b => b.round === 2)), false);

    // A third post now amends -- round 2 asks something, so it IS the round the
    // agent is still assembling. It must land on round 2 and leave the artifact's
    // round alone: with two rounds open at once, "the open round" taken as the
    // FIRST one would normalise these blocks into round 1, appending a question
    // to the page the reviewer is reading and never touching the round the
    // caller meant.
    const third = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: first.boardId,
        title: 'Anything to change?',
        blocks: [{ kind: 'markdown', text: 'one more thing to weigh' }],
      }),
    })).json();
    assert.equal(third.round, 2, 'an amend must land on the LATEST open round, not the artifact round still open behind it');
    const afterThird = readBoard(first.boardId, home);
    assert.equal(afterThird.rounds.length, 2, 'and must not mint a third round');
    assert.deepEqual(afterThird.blocks.filter(b => b.round === 1).map(b => b.kind), ['html'],
      'the artifact\'s own round is untouched by an amend of the round after it');
    assert.equal(isPageRound(afterThird.blocks.filter(b => b.round === 1)), true,
      'so it is still a page -- an amend that landed here would have knocked it out of its own layout');
    assert.deepEqual(afterThird.blocks.filter(b => b.round === 2).map(b => b.kind), ['question', 'markdown']);

    // And the page agrees: round 1 renders as a page (no kicker, no expand
    // control, its comment surface floating over the frame), round 2 as an
    // ordinary round in the column.
    const markup = renderedMarkup(await (await fetch(`${base}/b/${first.boardId}`)).text());
    const r1 = markup.indexOf('data-round="1"');
    const r2 = markup.indexOf('data-round="2"');
    assert.ok(r1 !== -1 && r2 > r1, 'setup failure: the page must render both round sections, in order');
    const page1 = markup.slice(r1, r2);
    const page2 = markup.slice(r2);
    assert.ok(page1.includes('TWO_ASK_ARTIFACT'), 'setup failure: the artifact is not in round 1\'s markup');
    assert.ok(!page1.includes('block-kicker'), 'the artifact\'s page carries no kicker');
    assert.ok(!page1.includes('expand-btn'), 'and no expand control');
    assert.ok(page1.includes('page-comments'), 'and its comment surface floats over the frame');
    assert.ok(page2.includes('question-block'), 'round 2 renders as an ordinary question round on its own page');

    // The reviewer can actually answer that second round. Two rounds are open at
    // once here -- the artifact's, which nothing will ever send, and the
    // question's -- so "the open round" has to mean the LATEST one on every
    // route: the page's Send names round 2 (src/ui.mjs's openRoundNumber), and a
    // server that answered "the open round is 1" would 409 it forever.
    const q = stored.blocks.find(b => b.kind === 'question').id;
    // Abortable: a server that answered "the open round is 1" refuses this
    // submit with a 409, and the wait below would then hang for its full two
    // hours -- a check that fails by never finishing names nothing. The abort
    // turns that into the assertion immediately under it.
    const ac = new AbortController();
    const waitPromise = fetch(`${base}/api/board/${first.boardId}/wait?round=2`, { signal: ac.signal })
      .then(r => r.json())
      .catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${first.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    if (submitRes.status !== 200) ac.abort();
    assert.equal(submitRes.status, 200, 'the question round must be submittable while the artifact round is still open');
    const packet = await waitPromise;
    assert.ok(packet, 'setup failure: the wait never returned a packet');
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.round, 2);
    assert.equal(packet.answers[0].choice, 'Yes');
    assert.equal(readBoard(first.boardId, home).rounds[0].status, 'open',
      'and the artifact\'s own round stays open -- it is read, not answered, and comment mode has to keep working on it (ADR.md entry 35)');
  });

  await check('ADR 35: a comment left on a round that is NOT AWAITED rides the next packet the same thread returns, resolved against its OWN board, and comes back only once', async () => {
    // Round 1: a page board posted WITHOUT `wait: true` -- same shape as the
    // artifact-only check above -- so `round.awaited` is `false`
    // (`drainUndeliveredComments` keys on that flag, not on "no question block",
    // but an unawaited page board is exactly the shape that still makes it false
    // either way). A real caller's ask() would never call /wait at all
    // (bin/mcp.mjs). This check submits it anyway, to model the comment landing in
    // the store with nobody ever polling for its packet -- exactly the case ADR 35
    // exists for.
    //
    // That the submit SUCCEEDS is deliberate: ADR.md entry 44 keeps "a page board is
    // never sent" in the browser and leaves the daemon accepting any open round. This
    // check is the one entry 44 names as having to change with it, if that is ever
    // revisited.
    const html = '<!doctype html><html><body><h1>UNDELIVERED_MARKER page</h1></body></html>';
    const posted1 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Page board', blocks: [{ kind: 'html', html }] }),
    })).json();
    const board1 = posted1.boardId;
    const thread = posted1.thread;
    const h1 = readBoard(board1, home).blocks[0].id;
    assert.equal(readBoard(board1, home).rounds[0].awaited, false, 'posted without wait: true, so this round is not awaited');
    assert.equal(readBoard(board1, home).rounds[0].awaitDeadline, null);

    const submit1 = await fetch(`${base}/api/board/${board1}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'UNDELIVERED_COMMENT' }],
      }),
    });
    assert.equal(submit1.status, 200);
    assert.equal(readBoard(board1, home).comments[0].delivered, undefined, 'not delivered yet -- nothing has asked for a packet');

    // Round 2: a SECOND board in the SAME thread (the traps this ticket calls out --
    // a carried-forward comment belongs to a different board than the one answering),
    // carrying a real question so /wait actually resolves.
    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Follow-up question',
        thread,
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const board2 = posted2.boardId;
    assert.notEqual(board2, board1, 'this check is only proving something if the comment and the collecting round are on different boards');
    const q = readBoard(board2, home).blocks[0].id;

    const waitPromise = fetch(`${base}/api/board/${board2}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submit2 = await fetch(`${base}/api/board/${board2}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    assert.equal(submit2.status, 200);

    const packet = await waitPromise;
    assert.equal(packet.comments.length, 1, 'the undelivered comment must ride this packet -- it carries none of its own');
    const carried = packet.comments[0];
    assert.equal(carried.text, 'UNDELIVERED_COMMENT');
    assert.equal(carried.blockId, h1, 'resolved against the block on ITS OWN board, not board2');
    assert.equal(carried.blockKind, 'html');
    assert.equal(carried.round, 1, 'the comment still carries the round it was actually left in, not the collecting round');
    // ADR 99: no `resolved` key, on a carried-forward comment either -- this is
    // the path that concatenates onto buildPacket's own comments AFTER it runs
    // (drainUndeliveredComments), so it is its own proof the drop covers both.
    assert.equal('resolved' in carried, false);
    assert.equal(carried.lost, undefined);

    assert.equal(readBoard(board1, home).comments[0].delivered, true, 'the mark persists on the board the comment actually lives on');

    // A second round on the SAME thread must not see it again.
    const posted3 = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: board2, blocks: [{ kind: 'question', prompt: 'Also this?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    });
    assert.equal(posted3.status, 200);
    assert.equal((await posted3.json()).round, 2);
    const q2 = readBoard(board2, home).blocks.find(b => b.round === 2).id;

    const waitPromise2 = fetch(`${base}/api/board/${board2}/wait?round=2`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${board2}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [{ id: q2, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet2 = await waitPromise2;
    assert.equal(packet2.comments.length, 0, 'a comment already collected must not come back a second time');
  });

  // --- `wait: true` on a page board round (ADR.md entry 45) --------------------
  // the round is minted `awaited`, its own submit carries its own comments back
  // in ITS OWN packet (never through the ADR 35 undelivered path), and the
  // default clock is 40 minutes. Driven at the HTTP layer (no shim) the way the
  // rest of this file proves the daemon's own contract.

  await check('AC 1/2/11: a page board posted with wait: true is minted awaited, with a 40-minute deadline off its own postedAt', async () => {
    const html = '<!doctype html><html><body><h1>AWAITED_HTTP_MARKER</h1></body></html>';
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited page board', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const round = readBoard(posted.boardId, home).rounds[0];
    assert.equal(round.awaited, true, 'wait: true on a page board round must mint it awaited');
    assert.ok(round.awaitDeadline, 'an awaited round must carry a deadline');
    const deadlineMs = Date.parse(round.awaitDeadline) - Date.parse(round.postedAt);
    assert.equal(deadlineMs, DEFAULT_WAIT_TIMEOUT_MS, 'the default deadline is exactly the wall-clock cap /wait itself enforces');
    assert.equal(DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_AWAIT_TIMEOUT_MS, 'one clock: the two defaults (src/server.mjs, src/board.mjs) must agree');
    assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 40 * 60 * 1000, 'ADR.md entry 47: 40 minutes, not the old 2h default');
  });

  await check('wait: true is refused on every shape that is not a page board -- the flag is declared, but it is not a way to make any round awaited', async () => {
    // ADR.md entry 45 gives ONE shape a second way in. Every fixture in this file
    // posts the clean single-html-block case, so the negative side -- the shapes
    // where `wait` must have no effect at all -- was never pinned, and a mintAwait
    // that quietly honoured it anywhere would have gone unnoticed.
    const html = '<!doctype html><html><body><h1>NOT_A_PAGE_BOARD</h1></body></html>';
    const shapes = [
      ['two blocks, so not a page board', [{ kind: 'html', html }, { kind: 'markdown', text: 'beside it' }]],
      ['content only, no html block at all', [{ kind: 'markdown', text: 'just prose' }]],
      ['one html block whose reference cannot resolve', [{ kind: 'html', source: 'no-such-file.html' }]],
    ];
    for (const [what, blocks] of shapes) {
      const posted = await (await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ title: `wait on ${what}`, blocks, wait: true }),
      })).json();
      const round = readBoard(posted.boardId, home).rounds[0];
      assert.equal(round.awaited, false, `wait: true must not make a round awaited -- ${what}`);
      assert.equal(round.awaitDeadline, null, `and no deadline is stamped -- ${what}`);
    }
  });

  await check('AC 1/2: wait: true makes /wait actually block on a page board round, and its own submit resolves it with status submitted and its own comments -- an empty comments array included', async () => {
    const html = '<!doctype html><html><body><h1>AWAITED_BLOCKS</h1></body></html>';
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited page board', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const h1 = readBoard(posted.boardId, home).blocks[0].id;

    // Proves the wait is really blocking, not resolving instantly the way a
    // non-awaited page board's /wait would if a caller mistakenly polled it:
    // race the wait against a short timer BEFORE submitting anything.
    const ac = new AbortController();
    const early = await Promise.race([
      fetch(`${base}/api/board/${posted.boardId}/wait?round=1`, { signal: ac.signal }).then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 300)),
    ]);
    assert.equal(early, 'pending', 'the wait must still be open with nothing submitted yet');

    const waitPromise = fetch(`${base}/api/board/${posted.boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'AWAITED_OWN_COMMENT' }],
      }),
    });
    assert.equal(submitRes.status, 200);
    ac.abort();

    const packet = await waitPromise;
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.round, 1);
    assert.deepEqual(packet.answers, [], 'a page board round asks nothing');
    assert.equal(packet.comments.length, 1, 'this round\'s own comment comes back in its own packet, not through the undelivered path');
    assert.equal(packet.comments[0].text, 'AWAITED_OWN_COMMENT');
    assert.equal(packet.comments[0].round, 1);

    // A second such round, sent with NOTHING left on it: an empty array is the
    // normal outcome, not an error (AC 2's own wording).
    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: posted.boardId, title: 'Nothing to add', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    assert.equal(posted2.round, 2, 'a page board round is never amended (ADR.md entry 35), so this must mint round 2');
    const waitPromise2 = fetch(`${base}/api/board/${posted.boardId}/wait?round=2`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes2 = await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [], comments: [] }),
    });
    assert.equal(submitRes2.status, 200);
    const packet2 = await waitPromise2;
    assert.equal(packet2.status, 'submitted');
    assert.deepEqual(packet2.comments, [], 'zero comments is a valid, ordinary outcome');
  });

  await check('AC 3: comments delivered in an awaited page round\'s own packet are never redelivered through the ADR 35 undelivered path on a later round', async () => {
    const html = '<!doctype html><html><body><h1>AWAITED_NO_REDELIVER</h1></body></html>';
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited page board', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const h1 = readBoard(posted.boardId, home).blocks[0].id;

    const waitPromise = fetch(`${base}/api/board/${posted.boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'NO_REDELIVER_COMMENT' }],
      }),
    });
    const packet1 = await waitPromise;
    assert.equal(packet1.comments.length, 1, 'setup: the comment must have come back in round 1\'s own packet');

    // A later round on the SAME thread (a real question, so /wait actually
    // resolves) must not see it again -- the exact "ablation" ADR 35's
    // drainUndeliveredComments guards against, now keyed on `awaited` rather
    // than on the round's block shape.
    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: posted.boardId,
        title: 'Follow-up question',
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const q = readBoard(posted.boardId, home).blocks.find(b => b.round === 2).id;
    const waitPromise2 = fetch(`${base}/api/board/${posted.boardId}/wait?round=2`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet2 = await waitPromise2;
    assert.equal(packet2.comments.length, 0, 'the comment already delivered in round 1\'s own packet must not ride round 2\'s too');
  });

  await check('an awaited page round still receives its own submit even after a second round opens beside it (concurrent asks can post one before the first is answered)', async () => {
    // handleSubmit used to target only the LATEST open round, which is exactly
    // right while a board holds one round anyone can submit -- but an awaited
    // page round (round 1) can now be posted, still open and unsubmitted, while a
    // SECOND ask() call (the shim explicitly supports concurrent calls) posts a
    // question round beside it.
    // Round 1 must still be submittable; the old "must be the single latest open
    // round" gate 409'd it forever, leaving the first call's /wait to time out
    // with the reviewer's answer sitting right there in the request it refused.
    const html = '<!doctype html><html><body><h1>TWO_OPEN_AWAITED</h1></body></html>';
    const posted1 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited page board', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const h1 = readBoard(posted1.boardId, home).blocks[0].id;

    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: posted1.boardId,
        title: 'A second, concurrent round',
        blocks: [{ kind: 'question', prompt: 'Also this?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    assert.equal(posted2.round, 2, 'setup: round 1 (a page board) is never amendable, so this must mint round 2');
    assert.deepEqual(
      readBoard(posted1.boardId, home).rounds.filter(r => r.status === 'open').map(r => r.n),
      [1, 2],
      'setup: both rounds must be open at once'
    );

    const submitRound1 = await fetch(`${base}/api/board/${posted1.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'STILL_SUBMITTABLE' }],
      }),
    });
    assert.equal(submitRound1.status, 200, 'round 1 must still be submittable while round 2 is open beside it');
    assert.equal(readBoard(posted1.boardId, home).rounds[0].status, 'sent');
    assert.equal(readBoard(posted1.boardId, home).rounds[1].status, 'open', 'round 2 must be untouched by round 1\'s submit');

    // Round 2 is still independently submittable afterward -- the fix must not
    // have traded "round 1 unreachable" for "round 2 unreachable".
    const q2 = readBoard(posted1.boardId, home).blocks.find(b => b.round === 2).id;
    const submitRound2 = await fetch(`${base}/api/board/${posted1.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [{ id: q2, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    assert.equal(submitRound2.status, 200);
  });

  // --- a wait that DIED, rather than one that was answered ---------------------
  //
  // `mintAwait` stamps `awaited: true` when a round is born; these three prove the
  // other half exists -- that the flag comes back off the moment the round's own
  // deadline passes, and that every surface keyed on it follows. Set up by writing
  // a lapsed deadline straight to the store (writeBoard does not sweep; readBoard
  // does), because the alternative is a check that waits out a real 40 minutes.

  await check('a wait that died stops being awaited on the next read, deadline intact, and its comments become drain candidates again', async () => {
    const html = '<!doctype html><html><body><h1>LAPSED_DRAIN</h1></body></html>';
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited page board', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const stored = readBoard(posted.boardId, home);
    const h1 = stored.blocks[0].id;
    assert.equal(stored.rounds[0].awaited, true, 'setup: minted awaited');

    // A comment left while the wait was still alive, submitted with no /wait
    // connected -- the exact shape that used to reach nobody, ever: the round
    // stayed awaited forever, and the drain skips an awaited round on the grounds
    // that its own packet carries its comments. No packet was ever built.
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'STRANDED_BY_A_DEAD_WAIT' }],
      }),
    });

    // Kill the wait: rewind the deadline past now, straight to disk.
    const raw = JSON.parse(readFileSync(path.join(home, 'boards', `${posted.boardId}.json`), 'utf8'));
    raw.rounds[0].awaited = true; // the submit closed the round; re-open the awaited state to isolate the deadline
    raw.rounds[0].status = 'open';
    raw.rounds[0].awaitDeadline = new Date(Date.now() - 1000).toISOString();
    writeFileSync(path.join(home, 'boards', `${posted.boardId}.json`), JSON.stringify(raw, null, 2));

    const swept = readBoard(posted.boardId, home);
    assert.equal(swept.rounds[0].awaited, false, 'a round whose deadline has passed reads back not awaited');
    assert.equal(swept.rounds[0].awaitDeadline, raw.rounds[0].awaitDeadline, 'the deadline itself survives as the record of when the wait died');

    // A later round on the same thread now carries the stranded comment (ADR 35,
    // AC 12), which is only reachable because round 1 stopped being awaited.
    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        boardId: posted.boardId,
        title: 'The round after the dead one',
        blocks: [{ kind: 'question', prompt: 'Carry on?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const waitPromise = fetch(`${base}/api/board/${posted.boardId}/wait?round=${posted2.round}`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const q = readBoard(posted.boardId, home).blocks.find(b => b.round === posted2.round).id;
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: posted2.round, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet = await waitPromise;
    assert.deepEqual(
      packet.comments.map(c => c.text),
      ['STRANDED_BY_A_DEAD_WAIT'],
      'the comment stranded by the dead wait rides the thread\'s next packet exactly once'
    );
  });

  await check('the requestId dedupe refuses a round whose wait has already died, and mints a fresh one with a live deadline instead', async () => {
    // The livelock this closes: the same artifact re-posted after a timeout was
    // answered as a retry ON THE DEAD ROUND, so the caller's fresh /wait ran
    // against a deadline already in the past while the reviewer faced a read-only
    // panel -- and the timeout text telling the agent to post a fresh round landed
    // straight back here.
    const html = '<!doctype html><html><body><h1>DEDUPE_LAPSED</h1></body></html>';
    const body = JSON.stringify({ title: 'Same artifact, twice', blocks: [{ kind: 'html', html }], wait: true, requestId: 'lapsed-dedupe-1' });
    const first = await (await fetch(`${base}/api/board`, { method: 'POST', headers: writeHeaders(), body })).json();

    // Identical re-post while the wait is still alive: still a retry, unchanged.
    const retry = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...JSON.parse(body), boardId: first.boardId }),
    })).json();
    assert.equal(retry.deduped, true, 'a live round still answers its own retry -- that guard is what stops a double-posted round');

    const boardFile = path.join(home, 'boards', `${first.boardId}.json`);
    const raw = JSON.parse(readFileSync(boardFile, 'utf8'));
    raw.rounds[0].awaitDeadline = new Date(Date.now() - 1000).toISOString();
    writeFileSync(boardFile, JSON.stringify(raw, null, 2));

    const afterDeath = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...JSON.parse(body), boardId: first.boardId }),
    })).json();
    assert.ok(!afterDeath.deduped, 'a lapsed round can never hand an agent anything again, so it is never the answer to a retry');
    assert.equal(afterDeath.round, 2, 'the post falls through and mints the next round');
    const round2 = readBoard(first.boardId, home).rounds[1];
    assert.equal(round2.awaited, true, 'and the fresh round is awaited');
    assert.ok(Date.parse(round2.awaitDeadline) > Date.now(), 'against a deadline that is actually in the future -- the whole point');
  });

  await check('the requestId dedupe keys on RESOLVED CONTENT: re-posting the same artifact after its referenced file was regenerated surfaces the new file, not a deduped 200 pointing at the old one', async () => {
    // The loop the board manual actually prescribes: post an artifact that REFERENCES a
    // rendered file, regenerate that file, re-issue the identical `ask`. `requestId` is a
    // hash of the raw blocks (bin/mcp.mjs) and a raw block names the file by PATH, so the
    // second call arrives byte-identical -- and a body-keyed dedupe answered it
    // `deduped: 200`. The reviewer went on reading v1 while the agent believed v2 had
    // landed, and a content-only round is never `sent`, so nothing ever broke the cycle.
    const stageDir = projectDir('regenerated-artifact');
    const stagePath = path.join(stageDir, 'stage.html');
    const page = marker => `<!doctype html><html><body><h1>${marker}</h1></body></html>`;
    writeFileSync(stagePath, page('ARTIFACT_V1'), 'utf8');

    const ask = { title: 'Rendered artifact', blocks: [{ kind: 'html', source: { path: 'stage.html' } }], requestId: 'regen-artifact-1' };
    const first = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...ask, cwd: stageDir }),
    })).json();
    assert.equal(first.round, 1);
    assert.ok(readBoard(first.boardId, home).blocks[0].html.includes('ARTIFACT_V1'), 'setup: round 1 snapshotted v1');

    // Same body, same bytes on disk: still a retry, and it has to stay one -- this is the
    // lost-response case the dedupe exists for, and a content check that reported drift
    // here would mint a duplicate artifact round on every dropped response.
    const retry = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...ask, boardId: first.boardId }),
    })).json();
    assert.equal(retry.deduped, true, 'an identical re-post against unchanged content is the retry the dedupe is for');
    assert.equal(retry.round, 1);

    writeFileSync(stagePath, page('ARTIFACT_V2'), 'utf8');
    const regenerated = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...ask, boardId: first.boardId }),
    })).json();
    // (Ablation: with the resolved-content gate removed this comes back `deduped: true`,
    // round 1, and every assertion below fails on a board still holding only v1.)
    assert.ok(!regenerated.deduped, 'the same request naming a file whose bytes changed is not the request that was already applied');
    assert.equal(regenerated.round, 2, 'it mints the next round instead');

    const stored = readBoard(first.boardId, home);
    assert.ok(stored.blocks.find(b => b.round === 2).html.includes('ARTIFACT_V2'), 'and that round carries what the file says NOW');
    assert.ok(stored.blocks.find(b => b.round === 1).html.includes('ARTIFACT_V1'), 'while round 1 keeps the snapshot it was posted with');
    assert.notEqual(stored.blocks.find(b => b.round === 1).sha, stored.blocks.find(b => b.round === 2).sha);
  });

  await check('the resolved-content gate holds at the AMEND gate too: a retry naming a regenerated file mints round 2 instead of appending a second artifact and a duplicate question into the live round', async () => {
    // The shape `ask` actually posts, and the one the check above does not reach: the
    // artifact and the question ABOUT it in one round. Refusing the retry at the dedupe
    // gate is only half the fix -- what it refuses lands on the amend gate one branch
    // down, which says yes to any open round that asks something, and `amendRound`
    // APPENDS. The reviewer was left reading round 1 holding [stale artifact, question,
    // fresh artifact, duplicate question], and `buildPacket` reported two answers for the
    // one question that was actually asked.
    const stageDir = projectDir('regenerated-artifact-question');
    const stagePath = path.join(stageDir, 'stage.html');
    const page = marker => `<!doctype html><html><body><h1>${marker}</h1></body></html>`;
    writeFileSync(stagePath, page('AMEND_V1'), 'utf8');

    const ask = {
      title: 'Artifact and the question about it',
      blocks: [
        { kind: 'html', source: { path: 'stage.html' } },
        { kind: 'question', prompt: 'Ship this render?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
      requestId: 'regen-amend-1',
    };
    const first = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...ask, cwd: stageDir }),
    })).json();
    assert.equal(first.round, 1);
    assert.equal(first.awaited, true, 'setup: the round asks something, so it is genuinely amendable -- that is what makes this the dangerous shape');

    writeFileSync(stagePath, page('AMEND_V2'), 'utf8');
    const regenerated = await (await fetch(`${base}/api/board`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...ask, boardId: first.boardId }),
    })).json();
    // (Ablation: with the drift gate on the dedupe branch alone, this comes back round 1
    // -- amended -- and every assertion below fails on a doubled round.)
    assert.ok(!regenerated.deduped, 'the bytes changed, so this is not the request already applied');
    assert.equal(regenerated.round, 2, 'and a retry the dedupe refused is not therefore an amendment of the round it refused');

    const stored = readBoard(first.boardId, home);
    const round1 = stored.blocks.filter(b => b.round === 1);
    const round2 = stored.blocks.filter(b => b.round === 2);
    assert.deepEqual(round1.map(b => b.kind), ['html', 'question'], 'round 1 is exactly what was posted into it, with nothing appended');
    assert.deepEqual(round2.map(b => b.kind), ['html', 'question'], 'and the whole new post is round 2');
    assert.ok(round1[0].html.includes('AMEND_V1'), 'round 1 keeps its own snapshot');
    assert.ok(round2[0].html.includes('AMEND_V2'), 'round 2 carries what the file says now');

    // What the reviewer and the agent actually experience: round 1 asked ONE question, so
    // answering it reports one answer -- not a second one against a duplicate prompt
    // nobody was ever shown a control for.
    const waitPromise = fetch(`${base}/api/board/${first.boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${first.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: round1[1].id, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet = await waitPromise;
    assert.equal(packet.answers.length, 1, `one question was asked, so the packet reports one answer (got ${packet.answers.length})`);
    assert.equal(packet.answers[0].choice, 'Yes');
  });

  await check('a comment left on an awaited round that no /wait was listening to still reaches the next packet -- `awaited` is a mint-time flag, not a record that a packet left', async () => {
    // The permanent loss ADR 35 exists to prevent, in its commonest shape: a round born
    // awaited, answered by the reviewer at a moment when no /wait happened to be
    // connected. `applySubmit` marks it `sent` and leaves `awaited: true` (only
    // `closeLapsedAwaitedRounds` clears it, and only while `open`), so the round is
    // `sent + awaited` for the rest of its life -- and a drain keyed on that flag filtered
    // its comment out of every future packet on the thread, forever.
    const html = '<!doctype html><html><body><h1>AWAITED_THEN_SENT</h1></body></html>';
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Awaited, answered unheard', blocks: [{ kind: 'html', html }], wait: true }),
    })).json();
    const h1 = readBoard(posted.boardId, home).blocks[0].id;
    assert.equal(readBoard(posted.boardId, home).rounds[0].awaited, true, 'setup: minted awaited');

    // No /wait anywhere: the reviewer answers a board nobody is currently polling.
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'ANSWERED_WITH_NOBODY_LISTENING' }],
      }),
    });
    const afterSubmit = readBoard(posted.boardId, home).rounds[0];
    assert.equal(afterSubmit.status, 'sent');
    assert.equal(afterSubmit.awaited, true, 'the state this is about: sent AND still flagged awaited');
    assert.equal(readBoard(posted.boardId, home).comments[0].delivered, undefined, 'nothing has asked for a packet, so nothing is delivered');

    // The next round on the thread must carry it. (Ablation: keying the drain on
    // `roundIsAwaited` instead of on `delivered` makes this packet empty -- and every
    // packet after it, for the life of the board.)
    const second = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: posted.boardId, title: 'Follow-up', blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).json();
    const q = readBoard(posted.boardId, home).blocks.find(b => b.round === second.round).id;
    const waitPromise = fetch(`${base}/api/board/${posted.boardId}/wait?round=${second.round}`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: second.round, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet = await waitPromise;
    assert.deepEqual(packet.comments.map(c => c.text), ['ANSWERED_WITH_NOBODY_LISTENING'], 'the comment nobody heard rides the thread\'s next packet');

    // Exactly once, still: a packet leaving round 2 marks round 2's own comments as well
    // as the ones it drained, so a third round sees neither.
    const third = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: posted.boardId, blocks: [{ kind: 'question', prompt: 'Anything else?', widget: 'single', options: [{ label: 'No' }] }] }),
    })).json();
    const q3 = readBoard(posted.boardId, home).blocks.find(b => b.round === third.round).id;
    const waitPromise3 = fetch(`${base}/api/board/${posted.boardId}/wait?round=${third.round}`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: third.round, action: 'send', answers: [{ id: q3, status: 'answered', choice: 'No', note: '' }], comments: [] }),
    });
    assert.equal((await waitPromise3).comments.length, 0, 'and never a second time');
  });

  await check('a follow-up question posted after the wait cap mints a NEW live round -- it is never appended to the lapsed one, and the caller is not told nothing is awaited', async () => {
    // The amend gate tested `status === 'open'` only. A wait-lapsed question round stays
    // `open` forever (only submit and abandon move `status`), so the daemon's own timeout
    // advice -- "post a fresh round to continue" -- landed the agent's next question
    // INSIDE the dead round. `ask` then answered `awaited: false`, the shim reported "no
    // response needed", nothing waited, and the reviewer's Send answered into a void.
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Lapsed question round', blocks: [{ kind: 'question', prompt: 'First question?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).json();
    assert.equal(posted.awaited, true, 'setup: a question round is awaited');

    const boardFile = path.join(home, 'boards', `${posted.boardId}.json`);
    const raw = JSON.parse(readFileSync(boardFile, 'utf8'));
    raw.rounds[0].awaitDeadline = new Date(Date.now() - 1000).toISOString();
    writeFileSync(boardFile, JSON.stringify(raw, null, 2));
    assert.equal(readBoard(posted.boardId, home).rounds[0].status, 'open', 'the round the agent is about to post into is still `open` -- that is the whole trap');

    // Exactly what the timeout text tells the agent to do next.
    const followUp = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId: posted.boardId, title: 'Lapsed question round', blocks: [{ kind: 'question', prompt: 'Second question?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).json();
    // (Ablation: without the lapse gate on the amend branch this is round 1,
    // `awaited: false`, and the new question is glued into the dead round.)
    assert.equal(followUp.round, 2, 'a lapsed round is not the home of a follow-up question');
    assert.equal(followUp.awaited, true, 'and the caller is told to wait on it, not that no response is needed');

    const stored = readBoard(posted.boardId, home);
    assert.deepEqual(
      stored.blocks.filter(b => b.round === 1).map(b => b.prompt),
      ['First question?'],
      'nothing was appended to the lapsed round'
    );
    assert.deepEqual(stored.blocks.filter(b => b.round === 2).map(b => b.prompt), ['Second question?']);
    assert.ok(Date.parse(stored.rounds[1].awaitDeadline) > Date.now(), 'the new round waits against a deadline that has not already passed');
  });

  await check('an abandoned round releases a blocked /wait at once, named for what happened -- and the Send it refuses afterwards says abandoned, not submitted', async () => {
    // `POST /abandon` invents a third terminal round state (ADR 69, the ordinary
    // `fresh: true` path after a context compaction). `waitForRound` only recognised
    // `sent`, so a call already blocked on that round polled a corpse for the full
    // forty-minute cap and was then handed a `timeout` saying the board is "still open".
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Abandoned mid-wait', blocks: [{ kind: 'question', prompt: 'Still there?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).json();

    const started = Date.now();
    // A ceiling of the check's own, and an abort behind it: a daemon that cannot see the
    // abandon has to fail this assertion loudly rather than leave a /wait polling a dead
    // round for forty minutes and holding this whole check file open behind it (the same
    // discipline the wall-clock-ceiling check further up uses).
    const abort = new AbortController();
    const waitPromise = Promise.race([
      fetch(`${base}/api/board/${posted.boardId}/wait?round=1`, { signal: abort.signal })
        .then(r => r.json())
        .catch(err => ({ status: `request failed: ${err.message}` })),
      new Promise(resolve => setTimeout(() => resolve({ status: 'check-gave-up' }), 5000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 150));

    const abandoned = await (await fetch(`${base}/api/board/${posted.boardId}/abandon`, { method: 'POST', headers: writeHeaders() })).json();
    assert.deepEqual(abandoned.closed, [1]);

    const packet = await waitPromise;
    const elapsed = Date.now() - started;
    abort.abort();
    assert.equal(packet.status, 'abandoned', `the blocked call is released and told what actually happened (got "${packet.status}" after ${elapsed}ms)`);
    assert.ok(elapsed < 5000, `promptly, not at the wall-clock cap -- took ${elapsed}ms`);
    assert.equal(packet.board, posted.boardId);
    assert.equal(packet.answers[0].status, 'unanswered', 'carrying whatever the store holds, like every other terminal packet');
    assert.equal(activeWaitCount(), 0, 'and leaving no polling loop behind');

    // A /wait that arrives AFTER the abandon is answered the same way rather than
    // starting a fresh forty minutes on a round that is already over.
    const late = await fetch(`${base}/api/board/${posted.boardId}/wait?round=1`).then(r => r.json());
    assert.equal(late.status, 'abandoned');

    // The reviewer's tab is still open and its Send bar still live. It is refused --
    // correctly -- but it used to be refused with a sentence claiming somebody had
    // answered this board.
    const send = await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });
    assert.equal(send.status, 409);
    const refusal = (await send.json()).error;
    assert.match(refusal, /abandoned/, `the refusal names the abandon rather than inventing a submit: ${refusal}`);
    assert.ok(!/already been submitted/.test(refusal), 'nobody submitted anything');
  });

  await check('a submit is bounded on every axis a reviewer can repeat: comment text, comment count, and choices per answer -- an over-cap send persists nothing', async () => {
    // `POST /submit` is reachable with the session COOKIE alone, comments are append-only
    // with no in-product removal, and prune is age-only -- so one over-cap send used to
    // leave a permanently degraded board document that every later read re-parsed on the
    // daemon's one thread. Measured by the audit: a 19.6 MB body -> a 156 MB board.
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Submit caps',
        blocks: [
          { kind: 'mermaid', text: 'flowchart LR\n  a --> b' },
          { kind: 'question', prompt: 'Rank these', widget: 'rank', options: [{ label: 'One' }, { label: 'Two' }] },
        ],
      }),
    })).json();
    const stored0 = readBoard(posted.boardId, home);
    const target = stored0.blocks[0].id;
    const q = stored0.blocks[1].id;
    const submit = body => fetch(`${base}/api/board/${posted.boardId}/submit`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) });
    const unchanged = () => {
      const now = readBoard(posted.boardId, home);
      assert.equal(now.comments.length, 0, 'a refused submit stores no comment');
      assert.equal(now.rounds[0].status, 'open', 'and does not close the round it was refusing');
    };

    const oversize = await submit({ round: 1, action: 'send', answers: [], comments: [{ blockId: target, text: 'x'.repeat(MAX_REF_BYTES + 1) }] });
    assert.equal(oversize.status, 400, 'comment text is bounded by the same cap every other by-value string on a board is');
    unchanged();

    const tooMany = await submit({
      round: 1, action: 'send', answers: [],
      comments: Array.from({ length: MAX_SUBMIT_COMMENTS + 1 }, () => ({ blockId: target, text: 'x' })),
    });
    assert.equal(tooMany.status, 400, 'the number of comments in one send is capped, not just each one\'s length');
    assert.match((await tooMany.json()).error, new RegExp(String(MAX_SUBMIT_COMMENTS)), 'and the refusal names the cap');
    unchanged();

    const tooManyChoices = await submit({
      round: 1, action: 'send', comments: [],
      answers: [{ id: q, status: 'answered', choice: Array.from({ length: MAX_ANSWER_CHOICES + 1 }, (_, i) => `opt${i}`), note: '' }],
    });
    assert.equal(tooManyChoices.status, 400, 'an answer\'s choice array is capped the same way');
    unchanged();

    // A non-string text is coerced at the door rather than persisted verbatim: the packet
    // contract says `text` is a string, and every reader downstream assumed it.
    const coerced = await submit({ round: 1, action: 'send', answers: [], comments: [{ blockId: target, text: { nope: 1 } }] });
    assert.equal(coerced.status, 200);
    const afterCoerce = readBoard(posted.boardId, home);
    assert.equal(afterCoerce.comments.length, 1);
    assert.equal(typeof afterCoerce.comments[0].text, 'string', 'stored as a string, whatever arrived');
  });

  await check('a compare side\'s label is bounded like every sibling label on a block', async () => {
    // `normalizeCompareSide` was the one by-value string on a posted block that skipped
    // `byValueText`, so a compare label's only ceiling was the 25 MB body limit -- and it
    // is persisted, re-rendered on every read, and shown as a heading.
    const oversize = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Compare label cap',
        blocks: [{ kind: 'compare', left: { label: 'x'.repeat(MAX_REF_BYTES + 1), block: { kind: 'markdown', text: 'left' } }, right: { label: 'After', block: { kind: 'markdown', text: 'right' } } }],
      }),
    });
    assert.equal(oversize.status, 400);
    assert.match((await oversize.json()).error, /compare side label/, 'the 400 names the field, like every other capped one');

    const ordinary = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Compare label cap',
        blocks: [{ kind: 'compare', left: { label: 'Before', block: { kind: 'markdown', text: 'left' } }, right: { label: 'After', block: { kind: 'markdown', text: 'right' } } }],
      }),
    });
    assert.equal(ordinary.status, 200, 'the cap is a ceiling, not a blanket refusal');
    assert.equal(readBoard((await ordinary.json()).boardId, home).blocks[0].left.label, 'Before');
  });

  await check('ADR 35: re-issuing the IDENTICAL /wait URL on an already-answered round returns the same packet, and drains nothing a second time', async () => {
    // Non-redelivery had only ever been proven by moving on -- a later round, or a
    // later board. This is the case that does not move on: the exact same URL,
    // asked again. It is not hypothetical. bin/mcp.mjs's reattach exists for a
    // daemon that restarted mid-wait ("a crash under KeepAlive, a kickstart from
    // the revive command, an install taking an update") and its recovery IS to
    // re-issue this request, so "comes back once" has to survive the retry that
    // the deferred-commit fix was itself built for.
    const html = '<!doctype html><html><body><h1>REISSUE_MARKER page</h1></body></html>';
    const artifact = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Re-issue page board', blocks: [{ kind: 'html', html }] }),
    })).json();
    const artifactBlock = readBoard(artifact.boardId, home).blocks[0].id;
    await fetch(`${base}/api/board/${artifact.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: artifactBlock, anchor: { kind: 'block' }, text: 'REISSUE_DRAINED' }],
      }),
    });

    // A question round in the same thread, with a comment of its OWN: the packet
    // therefore carries one comment that belongs to the round (a plain read, which
    // MUST repeat) and one that was drained into it (which must not).
    const asking = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Re-issue question',
        thread: artifact.thread,
        blocks: [
          { kind: 'markdown', text: 'something to comment on' },
          { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] },
        ],
      }),
    })).json();
    const asked = readBoard(asking.boardId, home);
    const md = asked.blocks.find(b => b.kind === 'markdown').id;
    const q = asked.blocks.find(b => b.kind === 'question').id;

    const waitUrl = `${base}/api/board/${asking.boardId}/wait?round=1`;
    const firstWait = fetch(waitUrl).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${asking.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }],
        comments: [{ blockId: md, anchor: { kind: 'block' }, text: 'REISSUE_OWN' }],
      }),
    });
    const first = await firstWait;
    assert.deepEqual(first.comments.map(c => c.text).sort(), ['REISSUE_DRAINED', 'REISSUE_OWN'],
      'setup: the first packet carries this round\'s own comment and the drained one');

    // The identical URL, asked again. The round is already sent, so this resolves
    // straight away rather than blocking.
    const second = await (await fetch(waitUrl)).json();
    assert.equal(second.status, 'submitted', 'a wait on an already-sent round answers immediately, it does not block or 409');
    assert.equal(second.round, 1);
    assert.deepEqual(second.answers.map(a => [a.status, a.choice]), first.answers.map(a => [a.status, a.choice]),
      'the answers are a read of the stored round, so they repeat verbatim');
    assert.deepEqual(second.comments.map(c => c.text), ['REISSUE_OWN'],
      'the round\'s own comment repeats -- it is a read -- but the drained one must NOT come back: "once" means once across retries of the same request, not once per distinct round');
    assert.equal(readBoard(artifact.boardId, home).comments[0].delivered, true,
      'and it stays marked delivered on the board it lives on');

    // A third time, to prove the second was not simply the last one the store had
    // not caught up with yet.
    const third = await (await fetch(waitUrl)).json();
    assert.deepEqual(third.comments.map(c => c.text), ['REISSUE_OWN'], 'and again on a third identical request');
  });

  await check('ADR 35 does not redeliver a comment that a normal, question-carrying round already handed back -- the ordinary "round 6 does not redeliver rounds 1-5" case', async () => {
    // No page board involved: an ordinary two-round board where round 1 both carries a
    // question AND gets waited on directly, the everyday shape. Its comment is
    // delivered by buildPacket's own round-scoped filter, not by the drain -- the
    // drain must therefore never see it as a candidate at all, on round 2 or any round
    // after.
    const posted1 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Ordinary two-round board',
        blocks: [
          { kind: 'mermaid', text: 'flowchart LR\n  one --> two' },
          { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] },
        ],
      }),
    })).json();
    const boardId = posted1.boardId;
    const stored1 = readBoard(boardId, home);
    const m1 = stored1.blocks.find(b => b.kind === 'mermaid').id;
    const q1 = stored1.blocks.find(b => b.kind === 'question').id;

    const wait1 = fetch(`${base}/api/board/${boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: q1, status: 'answered', choice: 'Yes', note: '' }],
        comments: [{ blockId: m1, anchor: { kind: 'block' }, text: 'hello' }],
      }),
    });
    const packet1 = await wait1;
    assert.equal(packet1.comments.length, 1, 'round 1\'s own comment must come back in round 1\'s own packet');
    assert.equal(packet1.comments[0].text, 'hello');

    // Round 2, same board, carries no new comment.
    const posted2 = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ boardId, blocks: [{ kind: 'question', prompt: 'Also this?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    });
    assert.equal((await posted2.json()).round, 2);
    const q2 = readBoard(boardId, home).blocks.find(b => b.round === 2).id;

    const wait2 = fetch(`${base}/api/board/${boardId}/wait?round=2`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 2, action: 'send', answers: [{ id: q2, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet2 = await wait2;
    // (Ablation: this is exactly what the first cut of drainUndeliveredComments got
    // wrong -- its predicate was "not yet marked delivered", and nothing on the normal
    // round-scoped delivery path ever marked one, so round 1's "hello" reappeared here.)
    assert.equal(packet2.comments.length, 0, 'a comment already delivered by its own round\'s ordinary packet must not be redelivered on a later round');
  });

  await check('a drained comment is not marked delivered until the packet is known to have left -- commit is deferred, not eager (audit finding 4)', async () => {
    // The audit reproduced this over a real socket by destroying the client mid-wait at
    // swept millisecond offsets -- 5 permanent losses in 130 trials, because the old
    // code flipped `delivered` and wrote it as part of COMPUTING the packet, before the
    // response had gone anywhere. A loopback request in this process flushes far too
    // fast to reliably land a check inside that same few-millisecond window, so this
    // drives the seam directly: `buildPacketWithUndelivered` is exported for exactly
    // this (like `activeWaitCount`), returning `{ packet, commit }` rather than a bare
    // packet so the two moments -- "the packet is computed" and "the mark is persisted"
    // -- are independently observable without racing anything.
    const html = '<!doctype html><html><body><h1>DEFERRED_MARKER page</h1></body></html>';
    const posted1 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Deferred-commit page board', blocks: [{ kind: 'html', html }] }),
    })).json();
    const board1 = posted1.boardId;
    const thread = posted1.thread;
    const h1 = readBoard(board1, home).blocks[0].id;
    await fetch(`${base}/api/board/${board1}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'DEFERRED_COMMENT' }],
      }),
    });

    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Collecting round',
        thread,
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const board2 = readBoard(posted2.boardId, home);

    // First build: the comment is in the packet, but the response has not "left" --
    // nothing has been written yet. This is the exact assertion finding 4 falsifies
    // against the eager version.
    const first = buildPacketWithUndelivered(board2, 1, 'http://test.invalid/', home);
    assert.equal(first.packet.comments.length, 1, 'the packet must carry the undelivered comment');
    assert.equal(first.packet.comments[0].text, 'DEFERRED_COMMENT');
    assert.equal(
      readBoard(board1, home).comments[0].delivered, undefined,
      'building the packet must not itself persist the mark -- the response has not gone anywhere yet',
    );

    // Simulate the response never reaching the client: this build's `commit` is simply
    // never called (an aborted connection or a daemon restart before res.on('finish')
    // fires). A second, independent build -- standing in for a LATER wait -- must still
    // find the comment: nothing was lost by computing a packet that never shipped.
    const second = buildPacketWithUndelivered(board2, 1, 'http://test.invalid/', home);
    assert.equal(second.packet.comments.length, 1, 'an uncommitted drain must not have consumed the comment -- it is still there for the next attempt');
    assert.equal(
      readBoard(board1, home).comments[0].delivered, undefined,
      'still nothing on disk -- two computed packets, zero commits, zero writes',
    );

    // Now simulate the response that DOES make it out: commit runs, after the fact,
    // the way `handleWait` wires it to `res.once('finish', commit)`.
    second.commit();
    assert.equal(readBoard(board1, home).comments[0].delivered, true, 'commit is what persists the mark, and only commit');

    // A later build (standing in for a later round's wait) must not redeliver it --
    // same "comes back once" guarantee as the check above, now proven at the seam that
    // actually decides it.
    const third = buildPacketWithUndelivered(board2, 1, 'http://test.invalid/', home);
    assert.equal(third.packet.comments.length, 0, 'once committed, the comment is truly gone from future packets');
  });

  await check('commit does not clobber a stranded banner written by a second writer in the window between capture and commit (ticket 09)', async () => {
    // `commit` captures whole board objects when `buildPacketWithUndelivered` is called,
    // but only runs on the response's own `finish` event (`res.once('finish', commit)` in
    // handleWait) -- a strictly LATER macrotask. In that window the stranded rule's timer
    // callback (`persist`, src/stranded.mjs) can land a fresh STRANDED_BANNER record on the
    // very same board `commit` is holding a stale copy of. The old `commit` wrote that
    // stale copy back wholesale, silently erasing whatever the second writer had just
    // recorded -- `persist` already defends its own field against exactly this writer, by
    // name, in its own comment; this proves the reverse direction is closed too.
    const html = '<!doctype html><html><body><h1>RACE_MARKER page</h1></body></html>';
    const posted1 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Raced page board', blocks: [{ kind: 'html', html }] }),
    })).json();
    const board1 = posted1.boardId;
    const thread = posted1.thread;
    const h1 = readBoard(board1, home).blocks[0].id;
    await fetch(`${base}/api/board/${board1}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [{ blockId: h1, anchor: { kind: 'block' }, text: 'RACED_COMMENT' }],
      }),
    });

    const posted2 = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Collecting round',
        thread,
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();
    const board2 = readBoard(posted2.boardId, home);

    // Capture, the way handleWait does before wiring `res.once('finish', commit)` -- at
    // this instant `commit`'s closure is holding board1 with no STRANDED_BANNER on it.
    const { packet, commit } = buildPacketWithUndelivered(board2, 1, 'http://test.invalid/', home);
    assert.equal(packet.comments.length, 1, 'the packet must carry the undelivered comment');

    // Simulate the stranded rule's timer firing in the window between capture and
    // `commit()` -- a genuine second writer, through readBoard/writeBoard exactly like
    // `persist` uses, not a hand-rolled JSON poke.
    const rec = { at: new Date().toISOString(), round: 1, pid: null, until: new Date(Date.now() + 60_000).toISOString() };
    const racedBoard = readBoard(board1, home);
    racedBoard[STRANDED_BANNER] = rec;
    writeBoard(racedBoard, home);

    // Now the response "finishes" and commit runs, against the now-stale captured board1.
    commit();

    assert.deepEqual(
      readBoard(board1, home)[STRANDED_BANNER], rec,
      'the stranded banner recorded between capture and commit must survive commit -- commit owns only the delivered marks, not the whole document',
    );
    assert.equal(
      readBoard(board1, home).comments[0].delivered, true,
      'commit must still do its own job: the comment it drained is marked delivered',
    );
  });

  // --- ADR 107: a submitted round's answers ride the next packet, once -------------
  //
  // The same rule as ADR 35 above, generalised from comments to answers, so these
  // checks are deliberately shaped like the ones they sit under: the same two-board
  // thread for the cross-board case, and the same exported `buildPacketWithUndelivered`
  // seam for the deferred-commit half, which no loopback request flushes slowly enough
  // to race honestly.
  //
  // What is NOT shared is the trigger. A comment goes undelivered when its round returned
  // no packet at all; a round's ANSWERS go undelivered when the packet that did leave
  // could not have carried them, because at the moment it left the round had not been
  // submitted. That is the timeout shape, and it is the one every fixture below builds:
  // let round 1's wall clock fire, then submit it anyway (ADR 50 leaves a lapsed round
  // `open`, so the submit lands and is persisted where nothing can ever hand it back).

  /** `lapse` lets one round's wait die on the wall clock and hands back its packet.
   * `CLAUDE_BOARD_TIMEOUT_MS` is read per call (`waitTimeoutMs`, src/server.mjs), so the
   * override applies to this one wait and is restored either way -- a leaked 250ms cap
   * would silently turn every later blocking check in this file into a timeout. */
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

  /** `askRound` posts a round carrying exactly one question and hands back the board id,
   * the thread and the question block's own id -- which is only knowable by reading the
   * board back, since the daemon mints it. `into` names an existing board (a further
   * round on it) or a thread (a second board in it); omitted, it opens a fresh thread. */
  async function askRound(prompt, into = {}) {
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: prompt,
        ...into,
        blocks: [{ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }),
    })).json();
    const stored = readBoard(posted.boardId, home);
    const qid = stored.blocks.filter(b => b.kind === 'question' && b.round === posted.round).map(b => b.id)[0];
    return { ...posted, qid };
  }

  /** `answer` submits one round, as the page's Send button does. */
  function answer(boardId, round, qid, choice, note = '') {
    return fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round, action: 'send', answers: [{ id: qid, status: 'answered', choice, note }], comments: [] }),
    });
  }

  /** `askAndAnswer` waits on a round and answers it -- the ordinary shape every packet
   * below arrives through. The wait has to be in flight before the submit lands, or
   * `waitForRound` returns on its first poll and proves nothing about a blocked call. */
  async function askAndAnswer(boardId, round, qid, choice, note = '') {
    const waiting = fetch(`${base}/api/board/${boardId}/wait?round=${round}`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitted = await answer(boardId, round, qid, choice, note);
    assert.equal(submitted.status, 200, `setup: round ${round} must be submittable`);
    return waiting;
  }

  await check('ADR 107 AC 1/2: a round whose wait died and which was then submitted late rides the next packet the thread returns, naming its own round -- and rides it exactly once', async () => {
    const r1 = await askRound('LATE_SUBMIT_Q1');
    const timedOut = await lapse(r1.boardId);
    assert.equal(timedOut.status, 'timeout', 'setup: round 1 must actually lapse');
    assert.equal(timedOut.answers[0].status, 'unanswered',
      'and its packet claims an explicit no-response -- the claim the late submit is about to falsify');
    assert.ok(!(readBoard(r1.boardId, home)[ANSWERS_DELIVERED] || []).includes(1),
      'nothing is marked delivered by that packet: at the instant it left, the round was still open and had no answers to carry');

    // ADR 50 leaves a lapsed round `open`, so this lands -- and lands nowhere any packet
    // could ever reach it from, which is the whole defect.
    assert.equal((await answer(r1.boardId, 1, r1.qid, 'No', 'answered 39 minutes late')).status, 200);
    assert.equal(readBoard(r1.boardId, home).answers[r1.qid].choice, 'No', 'setup: the late answer really is on the board');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [], 'and still nothing has carried it');

    const r2 = await askRound('SECOND_ROUND_Q', { boardId: r1.boardId });
    assert.equal(r2.round, 2);
    const packet2 = await askAndAnswer(r1.boardId, 2, r2.qid, 'Yes');

    assert.equal(packet2.answers.length, 2, 'round 2\'s packet carries its own answer plus the one round 1 was owed');
    assert.equal(packet2.answers[0].round, 2, 'the packet\'s own round comes first -- owed entries are appended, never spliced in');
    const owed = packet2.answers[1];
    assert.equal(owed.round, 1, 'the owed entry names the round that owes it, not the round in hand');
    assert.equal(owed.id, r1.qid);
    assert.equal(owed.prompt, 'LATE_SUBMIT_Q1');
    assert.equal(owed.status, 'answered');
    assert.equal(owed.choice, 'No');
    assert.equal(owed.note, 'answered 39 minutes late');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [1, 2], 'both rounds are marked once that packet has left');

    // Once, ever. A third round on the same thread must carry its own answer and nothing
    // else -- the ablation is `delivered.has(r.n)` removed from the drain, which turns
    // every later packet into a growing replay of the whole thread.
    const r3 = await askRound('THIRD_ROUND_Q', { boardId: r1.boardId });
    const packet3 = await askAndAnswer(r1.boardId, 3, r3.qid, 'Yes');
    assert.deepEqual(packet3.answers.map(a => a.round), [3], 'an already-delivered round must not come back a second time');
  });

  await check('ADR 107 AC 5: a round whose own packet left normally is never redelivered, and no packet carries the same answer entry twice', async () => {
    // The other direction of the same mark, and the one that keeps "one packet is one
    // round" true everywhere but the two documented exceptions: round 1 here is answered
    // through its own blocked `/wait`, so its answers left in its own packet.
    const r1 = await askRound('NORMAL_ROUND_Q');
    const packet1 = await askAndAnswer(r1.boardId, 1, r1.qid, 'Yes');
    assert.deepEqual(packet1.answers.map(a => a.round), [1], 'setup: round 1 gets its own answer in its own packet, once');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [1], 'and that packet leaving is what marks it');

    const r2 = await askRound('NORMAL_ROUND_Q2', { boardId: r1.boardId });
    const packet2 = await askAndAnswer(r1.boardId, 2, r2.qid, 'No');
    assert.deepEqual(packet2.answers.map(a => a.round), [2], 'round 2 does not redeliver round 1');
    assert.equal(new Set(packet2.answers.map(a => a.id)).size, packet2.answers.length,
      'and no packet ever carries the same answer entry twice -- the waited round is marked by this drain but never drained by it');
  });

  await check('ADR 107 AC 3: the delivered mark stays unpersisted until commit -- deferred, not eager, provable without winning a socket race', async () => {
    // Byte-for-byte the argument the ADR 35 deferred-commit check above makes, and driven
    // at the same exported seam for the same reason: a loopback response flushes far too
    // fast to land an assertion inside the window where the packet is computed and the
    // response has not gone anywhere. Marking eagerly here does not merely re-deliver, it
    // LOSES the answers -- the round can never hand out a packet again.
    const r1 = await askRound('DEFERRED_ANSWER_Q');
    assert.equal((await lapse(r1.boardId)).status, 'timeout');
    assert.equal((await answer(r1.boardId, 1, r1.qid, 'Yes', 'DEFERRED_ANSWER_NOTE')).status, 200);

    const r2 = await askRound('DEFERRED_COLLECTOR_Q', { thread: r1.thread });
    assert.notEqual(r2.boardId, r1.boardId, 'this check is only proving something if the collecting round is its own board');
    const collector = readBoard(r2.boardId, home);

    const first = buildPacketWithUndelivered(collector, 1, 'http://test.invalid/', home);
    assert.equal(first.packet.answers.filter(a => a.note === 'DEFERRED_ANSWER_NOTE').length, 1, 'the packet must carry the owed answer');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [],
      'building the packet must not itself persist the mark -- the response has not gone anywhere yet');

    // The response never reaches the client: this build's `commit` is simply never called,
    // exactly as `res.once('finish', commit)` never fires for a socket that died. A second,
    // independent build -- a later wait -- must still find the answers.
    const second = buildPacketWithUndelivered(collector, 1, 'http://test.invalid/', home);
    assert.equal(second.packet.answers.filter(a => a.note === 'DEFERRED_ANSWER_NOTE').length, 1,
      'an uncommitted drain must not have consumed the answers -- they are still there for the next attempt');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [], 'still nothing on disk -- two computed packets, zero commits');

    second.commit();
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [1], 'commit is what persists the mark, and only commit');

    const third = buildPacketWithUndelivered(collector, 1, 'http://test.invalid/', home);
    assert.equal(third.packet.answers.filter(a => a.note === 'DEFERRED_ANSWER_NOTE').length, 0, 'once committed, the answers are gone from future packets');
  });

  await check('ADR 107 AC 6: owed answers ride across boards of the same thread, resolved against their own board', async () => {
    // A thread's rounds span boards (`ask` opens a new one whenever the reviewer has
    // closed the last), so the owing round and the collecting round routinely live on
    // different documents -- and a question id is per-BOARD, so `q1` on one is a
    // different question from `q1` on the other. Resolving against the wrong board would
    // hand the agent the collecting board's own prompt with the other board's answer
    // attached, which reads as a plausible answer to a question nobody asked.
    const owing = await askRound('CROSS_BOARD_OWING_Q');
    assert.equal((await lapse(owing.boardId)).status, 'timeout');
    assert.equal((await answer(owing.boardId, 1, owing.qid, 'No', 'left on the first board')).status, 200);

    const collecting = await askRound('CROSS_BOARD_COLLECTING_Q', { thread: owing.thread });
    assert.notEqual(collecting.boardId, owing.boardId, 'setup: the two rounds must be on different boards');
    assert.equal(collecting.qid, owing.qid, 'setup: and their question ids must COLLIDE, or own-board resolution is not being tested');

    const packet = await askAndAnswer(collecting.boardId, 1, collecting.qid, 'Yes');
    assert.equal(packet.answers.length, 2);
    assert.equal(packet.answers[0].prompt, 'CROSS_BOARD_COLLECTING_Q', 'the packet\'s own round is this board\'s question');
    assert.equal(packet.answers[1].prompt, 'CROSS_BOARD_OWING_Q', 'and the owed entry is the OTHER board\'s question, resolved there');
    assert.equal(packet.answers[1].note, 'left on the first board');
    assert.deepEqual(readBoard(owing.boardId, home)[ANSWERS_DELIVERED], [1], 'the mark persists on the board the round actually lives on');

    // And it never crosses into a thread it does not belong to: a board in a DIFFERENT
    // thread must not see it, which is the same containment the undelivered-comment
    // checks below assert for comments.
    const stranger = await askRound('DIFFERENT_THREAD_Q');
    const strangerPacket = await askAndAnswer(stranger.boardId, 1, stranger.qid, 'Yes');
    assert.deepEqual(strangerPacket.answers.map(a => a.prompt), ['DIFFERENT_THREAD_Q'], 'another thread\'s packet must carry nothing of this one');
  });

  await check('ADR 107 AC 4: owed answers ride whatever packet comes next -- a timeout packet and an abandoned one included', async () => {
    // `buildPacketWithUndelivered` is the single seam every `/wait` leaves through, so
    // this is really a check that no branch of `handleWait` grew its own packet builder.
    // It matters most on exactly these two: a `timeout` packet is documented as carrying
    // "an explicit no-response", and an `abandoned` round never reopens -- so a packet
    // that dropped what it was owed on either branch would drop it permanently.
    const owing = await askRound('RIDES_A_TIMEOUT_Q');
    assert.equal((await lapse(owing.boardId)).status, 'timeout');
    assert.equal((await answer(owing.boardId, 1, owing.qid, 'Yes', 'owed to whatever comes next')).status, 200);

    const nextRound = await askRound('TIMEOUT_CARRIER_Q', { boardId: owing.boardId });
    const timeoutPacket = await lapse(owing.boardId, nextRound.round);
    assert.equal(timeoutPacket.status, 'timeout');
    assert.equal(timeoutPacket.answers.filter(a => a.round === 1).length, 1, 'a timeout packet carries what the thread is owed as readily as any other');
    assert.equal(timeoutPacket.answers.find(a => a.round === 1).note, 'owed to whatever comes next');

    // Now the abandoned branch, with a second owing round: the one above has been
    // delivered, so it is no longer a candidate for anything.
    assert.equal((await answer(owing.boardId, nextRound.round, nextRound.qid, 'No', 'owed on the abandon path')).status, 200);
    assert.ok(!(readBoard(owing.boardId, home)[ANSWERS_DELIVERED] || []).includes(nextRound.round),
      'setup: the second round lapsed and was submitted late too, so nothing has carried it');

    const carrier = await askRound('ABANDON_CARRIER_Q', { thread: owing.thread });
    const abandonedPacket = fetch(`${base}/api/board/${carrier.boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${carrier.boardId}/abandon`, { method: 'POST', headers: writeHeaders() });
    const packet = await abandonedPacket;
    assert.equal(packet.status, 'abandoned');
    assert.equal(packet.answers.filter(a => a.note === 'owed on the abandon path').length, 1,
      'an abandoned round is the last packet this caller will ever get, so it carries what it is owed too');
  });

  await check('ADR 107: the delivery ledger is daemon-only -- it never reaches a client, and the served page stays byte-identical to the archive on disk', async () => {
    // The reason the mark is a board-level ledger rather than a flag on each round.
    // `renderBoardPage` spreads `board.rounds` into `<script id="board-data">` verbatim,
    // and `commit` runs on a response's `finish` with no re-render beside it -- so a
    // per-round flag would make `GET /b/:id` serve markup `pages/<id>.html` does not
    // have, breaking the invariant that makes an archived board open from Finder with no
    // daemon. Same argument and same treatment as the check `STRANDED_BANNER` gets in
    // test/check-stranded.mjs, made here because this field is spent on every wait.
    const r1 = await askRound('LEDGER_IS_DAEMON_ONLY_Q');
    await askAndAnswer(r1.boardId, 1, r1.qid, 'Yes');
    assert.deepEqual(readBoard(r1.boardId, home)[ANSWERS_DELIVERED], [1], 'the ledger really is on the stored board');

    const served = await (await fetch(`${base}/b/${r1.boardId}`)).text();
    const onDisk = readFileSync(path.join(home, 'pages', `${r1.boardId}.html`), 'utf8');
    assert.equal(served, onDisk, 'served page must match the pages/ file exactly, after a wait has spent its marks');
    assert.equal(served, renderBoardPage(readBoard(r1.boardId, home)),
      're-rendering the stored JSON must reproduce it too -- the ledger is stripped, not merely absent from one of the three');
    assert.ok(!served.includes(ANSWERS_DELIVERED), 'and the field name appears nowhere in the markup');
  });

  await check('ADR 107: a board written before the ledger existed adopts its already-sent rounds rather than paying its whole history out at once', async () => {
    // The migration, and the only reason "no ledger" and "an empty ledger" are different
    // facts. Stand in for a board archived by an earlier daemon by deleting the field
    // from one this daemon has already finished with -- which is exactly what such a
    // board looks like on disk, since nothing else writes it.
    const legacy = await askRound('LEGACY_ROUND_1_Q');
    await askAndAnswer(legacy.boardId, 1, legacy.qid, 'Yes', 'answered before the rule existed');
    const stripped = readBoard(legacy.boardId, home);
    delete stripped[ANSWERS_DELIVERED];
    writeBoard(stripped, home);
    assert.equal(readBoard(legacy.boardId, home)[ANSWERS_DELIVERED], undefined, 'setup: the board carries no ledger at all');

    const r2 = await askRound('LEGACY_ROUND_2_Q', { boardId: legacy.boardId });
    const packet = await askAndAnswer(legacy.boardId, 2, r2.qid, 'No');
    assert.deepEqual(packet.answers.map(a => a.round), [2],
      'a legacy board\'s settled history must not be handed back on the first wait after an upgrade -- that is the "round 6 redelivers rounds 1-5" damage this rule exists beside, not a case of it');
    assert.deepEqual(readBoard(legacy.boardId, home)[ANSWERS_DELIVERED], [1, 2],
      'it is adopted instead, and the ledger is written, so the board joins the rule from here on');

    // And the adoption is a one-time amnesty, not a permanent exemption: a round that
    // lapses and is submitted late AFTER the ledger exists rides normally.
    const r3 = await askRound('LEGACY_ROUND_3_Q', { boardId: legacy.boardId });
    assert.equal((await lapse(legacy.boardId, 3)).status, 'timeout');
    assert.equal((await answer(legacy.boardId, 3, r3.qid, 'Yes', 'late, after adoption')).status, 200);
    const r4 = await askRound('LEGACY_ROUND_4_Q', { boardId: legacy.boardId });
    const packet4 = await askAndAnswer(legacy.boardId, 4, r4.qid, 'Yes');
    assert.deepEqual(packet4.answers.map(a => a.round), [4, 3], 'the round that lapsed after adoption is owed exactly as any other is');
  });

  await check('map-context question round trip (/wayfind\'s shape): post one question whose context references a map section by its heading SLUG, render it, answer it, and prove the referenced content actually resolved -- not merely that the post returned 200', async () => {
    // The trap this migration already got bitten by once:
    // `section` is the heading's SLUG, never its text. Get it wrong and the block is
    // minted with an `error` and resolves to nothing while the POST still returns 200 --
    // a silently empty context box the reviewer sees with no error anywhere in chat. So
    // every assertion below is on the RESOLVED, stored content, never on the status code.
    const mapDir = projectDir('wayfind-map');
    writeFileSync(path.join(mapDir, 'MAP_ROUTING.md'), [
      '# MAP: Routing investigation',
      '',
      '## Destination',
      'Ship one router for the SPA.',
      '',
      '## Open questions',
      '- [ ] Which router library should the SPA use?',
      '',
      '## Not yet specified',
      'fog',
      '',
    ].join('\n'), 'utf8');

    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'MAP: Routing investigation',
        cwd: mapDir,
        blocks: [{
          kind: 'question',
          prompt: 'Which router library should the SPA use?',
          widget: 'single',
          options: [{ label: 'react-router' }, { label: 'tanstack-router' }],
          context: [{ kind: 'markdown', source: { path: 'MAP_ROUTING.md', section: 'open-questions' } }],
        }],
      }),
    });
    assert.equal(r.status, 200);
    const posted = await r.json();
    const mapBoardId = posted.boardId;

    const stored = readBoard(mapBoardId, home);
    const qBlock = stored.blocks.find(b => b.kind === 'question');
    const contextBlock = qBlock.context[0];
    assert.equal(contextBlock.error, undefined, `the map section must resolve cleanly, not fall back to an error (got: ${contextBlock.error})`);
    assert.ok(contextBlock.text.length > 0, 'the resolved context must carry real text, not an empty snapshot');
    assert.ok(contextBlock.text.includes('Which router library should the SPA use?'), 'the resolved section must be the actual "Open questions" content');
    assert.ok(!contextBlock.text.includes('Ship one router'), 'the resolved section must be scoped to "Open questions", not the whole file');

    // render: the resolved map section is really on the page, not just in the store.
    const markup = renderedMarkup(await (await fetch(`${base}/b/${mapBoardId}`)).text());
    assert.ok(markup.includes('Which router library should the SPA use?'), 'the rendered page must carry the resolved map context, not an empty or errored box');

    // answer: pick one, same /wait + /submit shape as the round trip above.
    const waitPromise = fetch(`${base}/api/board/${mapBoardId}/wait?round=1`).then(res => res.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    const submitRes = await fetch(`${base}/api/board/${mapBoardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [{ id: qBlock.id, status: 'answered', choice: 'tanstack-router', note: 'newer, typesafe' }],
        comments: [],
      }),
    });
    assert.equal(submitRes.status, 200);

    // read the packet back.
    const packet = await waitPromise;
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.answers[0].choice, 'tanstack-router');
    assert.equal(packet.answers[0].note, 'newer, typesafe');
  });

  await check('L5: store directories are 0700 and store files 0600', async () => {
    // The store holds every question, answer, note and snapshotted source file from
    // every project, indefinitely; it must not rely on its parent directory's mode.
    // (Ablation: dropping the mode options gives 0755/0644 under the usual umask.)
    const mode = p => statSync(p).mode & 0o777;
    assert.equal(mode(path.join(home, 'boards')), 0o700);
    assert.equal(mode(path.join(home, 'pages')), 0o700);
    assert.equal(mode(path.join(home, 'boards', `${boardId}.json`)), 0o600);
    assert.equal(mode(path.join(home, 'pages', `${boardId}.html`)), 0o600);
  });

  // --- GET /api/waiting: the boards waiting for an answer ---------------
  //
  // The one route a client with no DOM has for "which boards owe the reviewer a trip"
  // (ADR.md entry 72: the status item is a second process, a pure client reading the
  // daemon over loopback). "Waiting" is `roundIsAwaitedOpen` -- the round has an OPEN
  // WAIT -- and the three checks below are the three ways that differs from the readings
  // next to it: an answered round drops out, a round whose wait LAPSED drops out while
  // staying open, and neither depends on anyone being attached to the board.
  //
  // Every assertion is scoped to a board this section posted itself, never to `total` or
  // to the length of the list: this file runs one daemon over one store for its whole
  // length, and a good half of the checks above leave awaited rounds behind in it.

  await check('WAITING: GET /api/waiting is gated exactly like every other read, and answers the secret and the cookie alike', async () => {
    // It hands back a title and a project folder for every live thread in the store,
    // which is the same harvest the read gate exists to refuse -- so `isOpenRoute` must
    // not grow an entry for it. (Ablation: add `/api/waiting` to isOpenRoute and the
    // first assertion here fails while nothing else in the suite notices.)
    const none = await rawRequest(port, 'GET', '/api/waiting', `127.0.0.1:${port}`);
    assert.equal(none.status, 401, 'the waiting list must not answer a caller holding nothing');
    assert.ok(!none.body.includes('boardId'), 'and the refusal must not leak a single entry');

    const withSecret = await rawRequest(port, 'GET', '/api/waiting', `127.0.0.1:${port}`, { headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(withSecret.status, 200, 'the secret header alone is enough -- what a native client sends');
    assert.match(withSecret.headers['content-type'] || '', /application\/json/);

    // The browser's own credential works too, so the index page could read this route
    // without a second kind of authorization being invented for it.
    const withCookie = await rawRequest(port, 'GET', '/api/waiting', `127.0.0.1:${port}`, { headers: { cookie: sessionCookieHeader() } });
    assert.equal(withCookie.status, 200, 'the session cookie alone must read it, same as every other GET');
  });

  await check('WAITING: a round with an open wait is listed by board, thread, title and round number -- and answering it takes it off the list', async () => {
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'WAITING_FIXTURE',
        cwd: projectDir('waiting-titled'),
        blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();

    // A second board with NO title at all: what the entry falls back to is decided here
    // rather than by each client, because the only other candidate -- the folder name --
    // would mean handing out an absolute path from the reader's machine to derive it.
    const folder = 'waiting-untitled';
    const untitled = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        cwd: projectDir(folder),
        blocks: [{ kind: 'question', prompt: 'And this one?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();

    const before = Date.now();
    const body = await (await fetch(`${base}/api/waiting`)).json();
    const after = Date.now();

    // Same clock-offset contract GET /api/pomodoro carries, for the same reason: a client
    // computing "how long is left" must not be doing it against its own wall clock.
    assert.ok(typeof body.now === 'number' && body.now >= before && body.now <= after, `now (${body.now}) must be the server's own clock, taken at response time (window ${before}-${after})`);
    assert.equal(body.total, body.waiting.length, 'total describes what was actually sent -- the route caps nothing, so the two can never differ');

    const entry = body.waiting.find(e => e.boardId === posted.boardId);
    assert.ok(entry, 'a question round posted seconds ago is waiting for an answer by construction');
    assert.equal(entry.thread, posted.thread, 'the thread, so a client can group a session\'s boards the way the index does');
    assert.equal(entry.title, 'WAITING_FIXTURE');
    assert.equal(entry.round, 1, 'the round NUMBER -- what "thread title, round N" is rendered from');
    assert.equal(entry.url, `http://127.0.0.1:${port}/b/${posted.boardId}`, 'and a URL that opens the board, so no client has to know how to build one');

    const untitledEntry = body.waiting.find(e => e.boardId === untitled.boardId);
    assert.ok(untitledEntry, 'a title-less board is still waiting for an answer');
    assert.equal(untitledEntry.title, folder, 'a board with no title falls back to its project folder, exactly as the index row does');

    // Answered: the round closes, and a closed round is not waiting for anything. No
    // /wait is connected here on purpose -- whether an agent is listening is not what
    // this list is about.
    const q = readBoard(posted.boardId, home).blocks.find(b => b.kind === 'question').id;
    await fetch(`${base}/api/board/${posted.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });

    const afterAnswer = await (await fetch(`${base}/api/waiting`)).json();
    assert.ok(!afterAnswer.waiting.some(e => e.boardId === posted.boardId), 'an answered round must leave the list');
    assert.ok(afterAnswer.waiting.some(e => e.boardId === untitled.boardId), 'and the board nobody answered must still be on it');
  });

  await check('WAITING: a round whose wait has LAPSED is off the list, even though the round is still open', async () => {
    // The distinction that makes this list worth having: "waiting" is an open WAIT, not
    // an unanswered round. A lapsed round is still `status: 'open'` on disk forever -- it
    // is `readBoard`'s sweep (closeLapsedAwaitedRounds) that clears `awaited`, which is
    // why the route needs no clock of its own. (Ablation: filter on `status === 'open'`
    // instead of roundIsAwaitedOpen and only this check fails.)
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'WAITING_LAPSED',
        blocks: [{ kind: 'question', prompt: 'Too late?', widget: 'single', options: [{ label: 'Yes' }] }],
      }),
    })).json();

    const listedWhileAlive = await (await fetch(`${base}/api/waiting`)).json();
    assert.ok(listedWhileAlive.waiting.some(e => e.boardId === posted.boardId), 'setup: it has to be on the list before the deadline is moved, or this proves nothing');

    // Rewind the deadline past now, straight to disk -- the same way the lapsed-wait
    // checks above reach a state that would otherwise cost a real 40-minute wait.
    const boardFile = path.join(home, 'boards', `${posted.boardId}.json`);
    const raw = JSON.parse(readFileSync(boardFile, 'utf8'));
    raw.rounds[0].awaitDeadline = new Date(Date.now() - 1000).toISOString();
    writeFileSync(boardFile, JSON.stringify(raw, null, 2));

    const afterLapse = await (await fetch(`${base}/api/waiting`)).json();
    assert.ok(!afterLapse.waiting.some(e => e.boardId === posted.boardId), 'a wait that has died is not something the reviewer can still answer');
    assert.equal(readBoard(posted.boardId, home).rounds[0].status, 'open', 'and it left the list without the round being closed -- an open, unanswered round it is simply too late to answer');
  });

  /** Run `fn` with a live count of how many times the daemon walked the WHOLE store.
   *
   * `listBoards` (src/store.mjs) warns once per unreadable file per walk, so a
   * deliberately corrupt board document turns "did this handler re-parse every board"
   * into a number the check can assert on -- the same instrument the index's own
   * walk-count check further up this file uses. `fn` is handed a `count()` it may call at
   * any point; the corrupt file is planted before it runs and removed after, so the store
   * is exactly as it was either side. */
  async function withStoreWalkCount(fn) {
    const corruptPath = path.join(boardsDirPath, 'b_walkcount.json');
    writeFileSync(corruptPath, '{"id":"b_walkcount","blocks":[{"kind":"mark', 'utf8');
    const realWarn = console.warn;
    let walks = 0;
    console.warn = (...args) => { if (args.join(' ').includes('b_walkcount.json')) walks++; };
    try {
      return await fn(() => walks);
    } finally {
      console.warn = realWarn;
      unlinkSync(corruptPath);
    }
  }

  await check('WAITING: a repeat poll, and a round posted into a live board, answer from the store fingerprint instead of re-parsing every board', async () => {
    // `GET /api/waiting` is the status item's fixed fifteen-second poll and the waiting
    // count rides every post -- both were a synchronous readFileSync + JSON.parse of
    // EVERY board in the store, on the daemon's one thread, ahead of every blocked /wait
    // and every SSE heartbeat, for a store nothing bounds the growth of (the audit
    // measured ~39 ms at 200 boards, ~200 ms at 1000). The fingerprint cache that fixes
    // it already existed at GET /api/index/rows and was simply never wired to these.
    const posted = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'WAITING_CACHE',
        blocks: [{ kind: 'html', html: '<!doctype html><html><body><h1>WAITING_CACHE</h1></body></html>' }],
        wait: true,
      }),
    })).json();

    await withStoreWalkCount(async count => {
      // Cold: planting the counter's own file changed the store, so this poll walks --
      // which is the point of a fingerprint, not a failure of one.
      const first = await (await fetch(`${base}/api/waiting`)).json();
      const cold = count();
      assert.equal(cold, 1, `the first poll after a store change reads it once (got ${cold})`);
      assert.ok(first.waiting.some(w => w.boardId === posted.boardId && w.round === 1), 'setup: the awaited round is on the list');

      await fetch(`${base}/api/waiting`);
      await fetch(`${base}/api/waiting`);
      // (Ablation: drop the cache and each of these adds a full walk -- four by the end
      // of this check, on a poll that runs forever every fifteen seconds.)
      assert.equal(count(), cold, 'a poll against an unchanged store parses nothing at all');

      const second = await (await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ boardId: posted.boardId, blocks: [{ kind: 'question', prompt: 'Ship?', widget: 'single', options: [{ label: 'Yes' }] }] }),
      })).json();
      assert.equal(second.round, 2);
      assert.equal(count(), cold, 'a round posted into a live board publishes its waiting count off the document it just wrote, not off a fresh walk');

      const after = await (await fetch(`${base}/api/waiting`)).json();
      assert.equal(count(), cold, 'and the poll behind it still reads the cache');
      assert.ok(after.waiting.some(w => w.boardId === posted.boardId && w.round === 2), 'which has to be RIGHT, not merely cheap: the round that post opened is listed');
      assert.equal(after.total, after.waiting.length);
    });
  });

  await check('THREADS: a minted thread id is drawn against the ids the store already holds, so two unrelated sessions cannot share one', async () => {
    // Thread ids stopped being labels once `drainUndeliveredComments` began routing
    // undelivered comments by thread across every board in the store: on a collision,
    // session A's /wait drains a comment written about session B's project (a
    // cross-project content leak) and B's agent never receives it (a permanent loss).
    // The width is unchanged and short on purpose -- nothing is authorised by knowing a
    // thread id -- so the store itself is what makes a collision impossible.

    // A collision is not reproducible by drawing, so the taken set is what stands in for
    // one: it CLAIMS the first two ids it is shown and keeps them. The observable is the
    // board that comes back -- its thread is not an id this store holds. A mint that drew
    // once and shipped whatever it got hands back a claimed one.
    const claimed = new Set();
    let shown = 0;
    const takenThreads = { has: id => (shown++ < 2 ? (claimed.add(id), true) : claimed.has(id)) };
    const board = createBoard({ title: 'rigged mint', blocks: [], takenThreads });
    assert.equal(claimed.size, 2, 'a mint that never asks the store cannot avoid a collision: nothing consulted the taken set');
    assert.ok(!claimed.has(board.thread), 'a board never carries a thread id another session already holds');

    // At the seam: a create consults the store, and does it in ONE walk shared with the
    // thread's bound-directory lookup rather than two.
    const before = new Set(readdirSync(boardsDirPath)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(path.join(boardsDirPath, f), 'utf8')).thread; } catch { return null; } })
      .filter(Boolean));
    assert.ok(before.size > 0, 'setup: the store has to hold threads for this to mean anything');
    const walks = await withStoreWalkCount(async count => {
      const created = await (await fetch(`${base}/api/board`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ title: 'Fresh session', blocks: [{ kind: 'markdown', text: '# fresh' }] }),
      })).json();
      assert.ok(!before.has(created.thread), 'the minted thread is not one another session is already using');
      return count();
    });
    assert.equal(walks, 1, `a create reads the store once, for both the taken-thread set and the thread's bound cwd (got ${walks})`);
  });

  await check('THREADS: an undelivered comment never crosses into another thread\'s packet', async () => {
    // The damage a collision does, asserted directly rather than inferred from the id
    // width: the drain is thread-scoped, so a comment left in one session must be
    // invisible to a wait resolving in an unrelated one.
    const leaky = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Project A', blocks: [{ kind: 'html', html: '<!doctype html><html><body><h1>PROJECT_A</h1></body></html>' }] }),
    })).json();
    const aBlock = readBoard(leaky.boardId, home).blocks[0].id;
    await fetch(`${base}/api/board/${leaky.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [{ blockId: aBlock, anchor: { kind: 'block' }, text: 'PROJECT_A_SECRET' }] }),
    });
    assert.equal(readBoard(leaky.boardId, home).comments[0].delivered, undefined, 'setup: the comment is undelivered, so it IS a drain candidate somewhere');

    const other = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Project B', blocks: [{ kind: 'question', prompt: 'Unrelated?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).json();
    assert.notEqual(other.thread, leaky.thread, 'two independent posts are two independent threads');

    const q = readBoard(other.boardId, home).blocks[0].id;
    const waitPromise = fetch(`${base}/api/board/${other.boardId}/wait?round=1`).then(r => r.json());
    await new Promise(resolve => setTimeout(resolve, 150));
    await fetch(`${base}/api/board/${other.boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: q, status: 'answered', choice: 'Yes', note: '' }], comments: [] }),
    });
    const packet = await waitPromise;
    assert.deepEqual(packet.comments, [], 'a wait in one thread carries nothing written in another');
    assert.equal(readBoard(leaky.boardId, home).comments[0].delivered, undefined, 'and leaves it undelivered for the thread it actually belongs to');
  });

  // --- the pomodoro HTTP surface ---------------------------------------
  //
  // GET /api/pomodoro, POST /api/pomodoro/{ensure,pause,resume,reset,settings}. See
  // src/server.mjs `handlePomodoro`, PROTOCOL.md "HTTP surface", and src/pomodoro.mjs's
  // pauseTimer/resumeTimer/resetTimer/mergeSettings for the pure logic these routes
  // wrap. test/check-pomodoro.mjs already covers that pure logic and createPomodoro's
  // impure methods in isolation; everything below is specifically about the ROUTES —
  // auth, request/response shape, and persistence across a real daemon restart.

  const POMODORO_WRITE_ACTIONS = ['ensure', 'pause', 'resume', 'reset', 'settings'];

  await check('POMODORO: every route refuses a request carrying no credential at all, with the status the rest of the surface uses', async () => {
    const getR = await rawRequest(port, 'GET', '/api/pomodoro', `127.0.0.1:${port}`);
    assert.equal(getR.status, 401, 'GET /api/pomodoro must be gated exactly like every other read');

    for (const action of POMODORO_WRITE_ACTIONS) {
      const r = await rawRequest(port, 'POST', `/api/pomodoro/${action}`, `127.0.0.1:${port}`);
      assert.equal(r.status, 401, `POST /api/pomodoro/${action} must refuse a request with no credential`);
      assert.equal(r.body, '', `POST /api/pomodoro/${action} must send no body on refusal, same as every other write`);
    }
  });

  await check('POMODORO: GET returns the whole document plus the server\'s own clock', async () => {
    const before = Date.now();
    const doc = await (await fetch(`${base}/api/pomodoro`)).json();
    const after = Date.now();
    assert.ok(
      'settings' in doc && 'cycle' in doc && 'cycleDate' in doc && 'timer' in doc,
      'the whole document (settings, cycle, cycleDate, timer) must be present',
    );
    // `now` lets the page compute a client/server clock offset ONCE rather than trusting
    // the browser's own Date.now() against a server-minted deadline (see sendPomodoro's
    // comment in src/server.mjs). Bounded against a before/after window taken around the
    // call rather than pinned to one instant, since this is a real network round trip.
    assert.ok(typeof doc.now === 'number' && doc.now >= before && doc.now <= after, `now (${doc.now}) must be the server's own clock, taken at response time (window ${before}-${after})`);
  });

  await check('POMODORO: the cookie alone can ensure, pause, resume, reset and write settings, and nothing beyond those five', async () => {
    const cookie = sessionCookieHeader();
    const cookieHeaders = { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie };

    const pauseC = await rawRequest(port, 'POST', '/api/pomodoro/pause', `127.0.0.1:${port}`, { headers: cookieHeaders });
    assert.equal(pauseC.status, 200, 'the cookie alone must be able to pause');
    const resumeC = await rawRequest(port, 'POST', '/api/pomodoro/resume', `127.0.0.1:${port}`, { headers: cookieHeaders });
    assert.equal(resumeC.status, 200, 'the cookie alone must be able to resume');
    const settingsC = await rawRequest(port, 'POST', '/api/pomodoro/settings', `127.0.0.1:${port}`, {
      headers: { ...cookieHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ workMin: 20 }),
    });
    assert.equal(settingsC.status, 200, 'the cookie alone must be able to write settings');
    const resetC = await rawRequest(port, 'POST', '/api/pomodoro/reset', `127.0.0.1:${port}`, { headers: cookieHeaders });
    assert.equal(resetC.status, 200, 'the cookie alone must be able to reset');

    // ensure IS in the cookie's list, as of the index widget's switch: starting a
    // pomodoro by hand is a browser doing it, and startWork is a no-op against a timer
    // that already exists, so the reach it adds is smaller than reset's -- which the
    // cookie already had. See POMODORO_COOKIE_ACTIONS in src/server.mjs.
    const ensureC = await rawRequest(port, 'POST', '/api/pomodoro/ensure', `127.0.0.1:${port}`, { headers: cookieHeaders });
    assert.equal(ensureC.status, 200, 'the cookie alone must be able to start a pomodoro');

    // ...and the list stays CLOSED. A pomodoro write that is not one of the five named
    // actions must still be refused to a cookie, or POMODORO_COOKIE_ACTIONS has
    // silently become a `parts[1] === 'pomodoro'` prefix match. (Ablation: swap the Set
    // membership test for a prefix match and this becomes a 404, not a 401.)
    const unknownC = await rawRequest(port, 'POST', '/api/pomodoro/skip', `127.0.0.1:${port}`, { headers: cookieHeaders });
    assert.equal(unknownC.status, 401, 'a pomodoro action outside the named five must stay secret-only, even one that does not exist yet');

    // The secret does all five, ensure included.
    for (const action of ['pause', 'resume', 'reset', 'ensure']) {
      const r = await fetch(`${base}/api/pomodoro/${action}`, { method: 'POST', headers: writeHeaders() });
      assert.equal(r.status, 200, `the secret header alone must be able to ${action}`);
    }
    const settingsS = await fetch(`${base}/api/pomodoro/settings`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ breakMin: 7 }),
    });
    assert.equal(settingsS.status, 200, 'the secret header alone must be able to write settings');
  });

  await check('POMODORO: a bodyless POST /api/pomodoro/ensure with only the secret header succeeds -- the exact shape a session-start hook\'s curl sends', async () => {
    // No content-type, no body: readJsonBody is never called on the ensure branch of
    // handlePomodoro (src/server.mjs), which is what lets this succeed instead of the
    // 415 a real bodyless curl would get from any route that DOES read a JSON body.
    // Master switch defaults off (ADR 105); ensure needs it on to actually start anything.
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }) });
    await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() });
    const r = await rawRequest(port, 'POST', '/api/pomodoro/ensure', `127.0.0.1:${port}`, { headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(r.status, 200, 'ensure must not require a content-type or a body');
    const body = JSON.parse(r.body);
    assert.ok(body.timer, 'ensure must have started a timer from the reset, empty state');
    assert.equal(body.timer.phase, 'work');
  });

  await check('POMODORO: pause freezes the remaining time across a real wait, and resume continues from where it froze rather than restarting the interval', async () => {
    // A short work interval (the validator's floor is 1 minute) so a real, meaningful
    // slice of it can elapse inside a check that still runs in about a second: if resume
    // wrongly minted a FRESH deadline (`now + workMin*60_000`) instead of continuing from
    // the frozen remainder, the resulting deadline would land ~700ms later than expected
    // -- comfortably outside the assertion's tolerance below.
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ workMin: 1, enabled: true }) });
    await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() });
    const started = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(started.timer.phase, 'work');

    await new Promise(resolve => setTimeout(resolve, 700));

    const paused = await (await fetch(`${base}/api/pomodoro/pause`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(paused.timer.paused, true);
    assert.equal(paused.timer.deadline, undefined, 'a paused timer carries remainingMs, not a deadline');
    const remainingAtPause = paused.timer.remainingMs;
    assert.ok(remainingAtPause > 0 && remainingAtPause < 60_000, `remainingMs (${remainingAtPause}) must reflect real elapsed time, not a fresh 60000ms interval`);

    await new Promise(resolve => setTimeout(resolve, 300));

    // Still paused: the remaining time must not have shrunk at all across that wait.
    const stillPaused = await (await fetch(`${base}/api/pomodoro`)).json();
    assert.equal(stillPaused.timer.paused, true);
    assert.equal(stillPaused.timer.remainingMs, remainingAtPause, 'remaining time must not shrink while paused');

    const resumed = await (await fetch(`${base}/api/pomodoro/resume`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(resumed.timer.paused, false);
    assert.equal(resumed.timer.remainingMs, undefined, 'a running timer carries a deadline, not remainingMs');
    const expectedDeadline = resumed.now + remainingAtPause;
    assert.ok(
      Math.abs(resumed.timer.deadline - expectedDeadline) < 400,
      `resume must continue from the frozen remainder (expected close to ${expectedDeadline}, got ${resumed.timer.deadline}) -- ` +
      `(ablation: minting deadline = now + settings.workMin*60_000 on resume instead lands ~700ms later, well outside this tolerance)`,
    );
  });

  // Poll GET /api/pomodoro (never reconciled server-side -- see handlePomodoro's own
  // comment) until `timer.phase` reaches `wantPhase` or `timeoutMs` elapses. Returns the
  // phase actually observed at the end, so a caller can assert it directly rather than
  // asserting a boolean and losing what the poll actually saw on a failure.
  async function pollPomodoroPhase(wantPhase, timeoutMs) {
    const deadlineAt = Date.now() + timeoutMs;
    let phase = null;
    do {
      const d = await (await fetch(`${base}/api/pomodoro`)).json();
      phase = d.timer && d.timer.phase;
      if (phase === wantPhase) return phase;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadlineAt);
    return phase;
  }

  await check('POMODORO: resume actually RE-ARMS the live timer -- a resumed interval reaches its next boundary on its own, not merely a document that looks correct', async () => {
    // The state-level check above (pause freezes / resume continues) asserts only on the
    // PERSISTED document -- deadline, paused, remainingMs. A resume that writes a
    // perfectly correct-looking deadline but forgets to re-arm the live setTimeout passes
    // every one of those assertions: the document is right, GET renders a countdown a
    // page would happily draw ticking toward zero, and nothing ever fires. That gap is
    // exactly why this check exists: it proves a real setTimeout, not just a value on
    // disk.
    //
    // Seeded directly with a short `remainingMs` -- reaching a near-zero remainder
    // through a real pause would mean waiting out nearly a full work interval first,
    // which is what the state-level check above already covers at a duration long enough
    // to prove the FREEZE half; this check is only about what resume does next.
    // `notify: false` is load-bearing, not tidiness. This check deliberately drives a REAL
    // boundary on a real daemon, and startServer wires onBoundary to src/notify.mjs -- so
    // with the default `notify: true` this would shell out to the actual osascript and pop
    // an actual banner on the machine running the suite. The rule
    // is explicit: "No notification ever actually fires during the suite." check-http.mjs
    // stubs no PATH (it has no other reason to), so the toggle is what keeps that true here;
    // test/check-notify.mjs owns notification coverage and stubs osascript properly.
    // Master switch defaults off (ADR 105); resume is a no-op while off, so the seeded
    // settings need enabled: true too.
    const doc = readPomodoroDoc(home);
    writePomodoroDoc({ ...doc, cycle: 0, settings: { ...doc.settings, longEvery: 4, notify: false, enabled: true }, timer: { phase: 'work', paused: true, remainingMs: 150 } }, home);

    const resumed = await (await fetch(`${base}/api/pomodoro/resume`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(resumed.timer.paused, false);
    assert.ok(resumed.timer.deadline - resumed.now < 1000, `the resumed deadline must be the ~150ms remainder, not a fresh interval (got ${resumed.timer.deadline - resumed.now}ms out)`);

    // (Ablation: delete `arm(next, now);` from createPomodoro's `resume` method in
    // src/pomodoro.mjs, leaving the `writeDoc` call intact -- every assertion above this
    // line still passes, and this poll times out with `phase` stuck at 'work'.)
    const phase = await pollPomodoroPhase('break', 5000);
    assert.equal(phase, 'break', 'a resumed interval must actually reach its next boundary within a few seconds -- resume must re-arm the live setTimeout, not just persist a correct-looking deadline');
  });

  await check('POMODORO: ensure actually RE-ARMS the live timer too -- a freshly started interval reaches its boundary on its own', async () => {
    // Same gap as the resume check above, for ensureTimer's `arm` call instead of
    // resume's. `workMin` is seeded far below the settings validator's 1-minute floor --
    // directly on disk, bypassing mergeSettings entirely (that validator is already
    // covered by its own checks above) -- purely so this interval reaches its boundary in
    // test time rather than a real 60+ seconds.
    // `notify: false` for the same reason as the resume check above -- this crosses a real
    // boundary on a real daemon, and no notification may fire during the suite.
    // Master switch defaults off (ADR 105); startWork (behind ensure) is a no-op while
    // off, so the seeded settings need enabled: true too.
    const doc = readPomodoroDoc(home);
    writePomodoroDoc({ ...doc, cycle: 0, settings: { ...doc.settings, workMin: 150 / 60_000, longEvery: 4, notify: false, enabled: true }, timer: null }, home);

    const started = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(started.timer.phase, 'work');
    assert.equal(started.timer.paused, false);

    // (Ablation: delete `arm(next, now);` from createPomodoro's `ensureTimer` method --
    // the started document above still looks right, and this poll times out.)
    const phase = await pollPomodoroPhase('break', 5000);
    assert.equal(phase, 'break', 'a freshly started interval must actually reach its boundary within a few seconds -- ensure must re-arm the live setTimeout, not just persist a correct-looking deadline');
  });

  await check('POMODORO: reset clears the timer to null and the cycle to 0', async () => {
    // Seeded directly with a NONZERO cycle -- reaching one through real boundary
    // crossings would mean waiting out several real work/break intervals, which is
    // exactly what test/check-pomodoro.mjs already proves at the pure-function level.
    // This is proving the ROUTE clears a genuinely nonzero value, not that 0 stays 0.
    const doc = readPomodoroDoc(home);
    writePomodoroDoc({ ...doc, cycle: 3, timer: { phase: 'work', paused: false, deadline: Date.now() + 5 * 60_000 } }, home);

    const reset = await (await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(reset.timer, null, 'reset must clear the timer');
    assert.equal(reset.cycle, 0, 'reset must zero the cycle too -- reset ends the loop the cycle was counting');

    const after = await (await fetch(`${base}/api/pomodoro`)).json();
    assert.equal(after.timer, null);
    assert.equal(after.cycle, 0);
  });

  await check('POMODORO: ensure starts a work interval when none exists, and is a no-op against a running, paused, or mid-break timer -- a mid-break ensure leaves the break deadline untouched', async () => {
    await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() });
    // Master switch defaults off (ADR 105); ensure needs it on to actually start anything.
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }) });

    const started = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.ok(started.timer, 'ensure must start a timer where there was none');
    assert.equal(started.timer.phase, 'work');
    assert.equal(started.timer.paused, false);

    const runningDeadline = started.timer.deadline;
    const stillRunning = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(stillRunning.timer.deadline, runningDeadline, 'ensure against a running timer must be a no-op (a second session, a /clear, a resume)');

    await fetch(`${base}/api/pomodoro/pause`, { method: 'POST', headers: writeHeaders() });
    const pausedBefore = await (await fetch(`${base}/api/pomodoro`)).json();
    const stillPaused = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(stillPaused.timer.paused, true);
    assert.equal(stillPaused.timer.remainingMs, pausedBefore.timer.remainingMs, 'ensure against a paused timer must not resume or restart it');

    // Mid-break, seeded directly: a real work interval reaching a break naturally would
    // take up to workMin minutes. What's being proved is the exact wording --
    // "a session starting mid-break does not cut the break short" -- so the break's own
    // deadline must survive ensure UNCHANGED, to the millisecond.
    const seeded = readPomodoroDoc(home);
    const breakDeadline = Date.now() + 4 * 60_000;
    writePomodoroDoc({ ...seeded, timer: { phase: 'break', paused: false, deadline: breakDeadline } }, home);
    const midBreak = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(midBreak.timer.phase, 'break', 'starting mid-break must not switch the phase to work');
    assert.equal(midBreak.timer.deadline, breakDeadline, 'the break deadline must be untouched, to the millisecond');
  });

  await check('POMODORO: the settings validator rejects each bad shape with a 400 naming the offending field, and writes nothing', async () => {
    const before = (await (await fetch(`${base}/api/pomodoro`)).json()).settings;

    const cases = [
      [{ workMin: 0 }, /workMin/, 'zero is not a valid duration'],
      [{ workMin: -5 }, /workMin/, 'negative is not a valid duration'],
      [{ workMin: '25' }, /workMin/, 'a numeric-looking string is still not a number'],
      [{ breakMin: 1.5 }, /breakMin/, 'a non-integer minute count is rejected'],
      [{ longBreakMin: 100000 }, /longBreakMin/, 'an absurdly large duration is rejected'],
      [{ longEvery: 0 }, /longEvery/, 'zero would divide by zero in settleBoundary'],
      [{ longEvery: -1 }, /longEvery/, 'a negative longEvery is meaningless'],
      [{ notify: 'yes' }, /notify/, 'a truthy non-boolean is still rejected'],
      // The Master switch is validated exactly the same way, and must name ITS OWN
      // field too -- same reasoning as bannerLevel just below.
      [{ enabled: 'yes' }, /enabled/, 'a truthy non-boolean is rejected on the Master switch too'],
      // The round-banner level (ADR.md entry 58, ADR 106) is validated the same way,
      // and must name ITS OWN field, not "notify" -- a shared regex here would pass
      // even if the two settings were validated by the same code path with the wrong
      // key baked into the message. It is a closed set of four strings, not a boolean,
      // so the bad value is an unrecognized string rather than a non-boolean.
      [{ bannerLevel: 'sometimes' }, /bannerLevel/, 'an unknown Banner level is rejected, named in the message (criterion 7)'],
      [{ cueWork: 'Sosumi ' }, /cueWork/, 'a name outside the closed set (trailing space) is rejected'],
      [{ cueBreak: 'NotASound' }, /cueBreak/, 'a name macOS does not ship is rejected'],
      [{ cueLongBreak: 1 }, /cueLongBreak/, 'a non-string cue value is rejected'],
      [{ cueWork: '' }, /cueWork/, 'the empty string is not "None" and is rejected'],
      [{ cueBreak: null }, /cueBreak/, 'null is not a valid cue value'],
    ];
    for (const [patch, expectedField, why] of cases) {
      const r = await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(patch) });
      assert.equal(r.status, 400, `${why}: ${JSON.stringify(patch)} must be rejected with 400`);
      const body = await r.json();
      assert.match(body.error, expectedField, `the 400 must name the offending field for ${JSON.stringify(patch)}`);
    }

    // A body that is not even an object (a JSON array parses fine but is not the shape
    // mergeSettings expects) must also be refused rather than read as if its numeric
    // indices were setting keys.
    const arrayPatch = await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify([1, 2, 3]) });
    assert.equal(arrayPatch.status, 400, 'a JSON array body must be rejected, not silently treated as an empty patch');

    // Nothing above was ever partially applied.
    const after = (await (await fetch(`${base}/api/pomodoro`)).json()).settings;
    assert.deepEqual(after, before, 'every rejected patch above must have left settings byte-for-byte unchanged');
  });

  await check('POMODORO: each cue picker accepts every sound the picker may offer, plus None, and nothing outside that set', async () => {
    for (const key of ['cueWork', 'cueBreak', 'cueLongBreak']) {
      for (const name of cueNames()) {
        const r = await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ [key]: name }) });
        assert.equal(r.status, 200, `${key}: ${JSON.stringify(name)} is in the closed set and must be accepted`);
        const body = await r.json();
        assert.equal(body.settings[key], name);
      }
    }
  });

  await check('POMODORO: sound is retired -- a patch carrying it is silently dropped, not rejected, and stores nothing', async () => {
    // "sound leaves TOGGLE_KEYS": an unknown key is dropped, same as any other key
    // this module has never heard of -- it must NOT come back as a 400 (that would be
    // treating a key it used to recognise differently from one it never did), and it
    // must not resurrect a `sound` field in the stored document either.
    const before = (await (await fetch(`${base}/api/pomodoro`)).json()).settings;
    const r = await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ sound: true }) });
    assert.equal(r.status, 200, 'a patch containing only a retired key must not be rejected');
    const body = await r.json();
    assert.equal('sound' in body.settings, false, 'the stored document must never regain a sound key');
    assert.deepEqual(body.settings, before, 'a sound-only patch must change nothing at all');
  });

  await check('POMODORO: settings persist across a daemon restart', async () => {
    const sounds = cueNames().filter(n => n !== NO_CUE);
    assert.ok(sounds.length >= 2, 'this machine must ship at least two real sounds for this check to mean anything');
    const [soundA, soundB] = sounds;
    const patch = { workMin: 33, breakMin: 6, longBreakMin: 21, longEvery: 5, notify: false, bannerLevel: 'off', cueWork: soundA, cueBreak: soundB, cueLongBreak: NO_CUE };
    const written = await (await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(patch) })).json();
    assert.equal(written.settings.workMin, 33, 'the write itself must reflect the patch');

    // Close THIS daemon and start a second one against the exact same CLAUDE_BOARD_HOME.
    // A second startServer() call is what actually re-reads pomodoro.json off disk --
    // proving persistence against the same in-process daemon would not rule out an
    // in-memory value nothing ever wrote back (QUIRKS.md "A harness that imports `src/`
    // serves the code as it was at startup" is the adjacent trap this avoids: a fresh
    // startServer call, not a fresh import, is what a real restart actually is).
    await new Promise(resolve => server.close(resolve));
    ({ server, port } = await startServer({ home, port: 0 }));
    base = `http://127.0.0.1:${port}`;

    const reread = await (await fetch(`${base}/api/pomodoro`)).json();
    assert.equal(reread.settings.workMin, 33, 'workMin must survive a daemon restart');
    assert.equal(reread.settings.breakMin, 6, 'breakMin must survive a daemon restart');
    assert.equal(reread.settings.longBreakMin, 21, 'longBreakMin must survive a daemon restart');
    assert.equal(reread.settings.longEvery, 5, 'longEvery must survive a daemon restart');
    assert.equal(reread.settings.notify, false, 'the notify toggle must survive a daemon restart');
    assert.equal(reread.settings.bannerLevel, 'off', 'the round-banner level must survive a daemon restart, independently of notify');
    assert.equal(reread.settings.cueWork, soundA, 'cueWork must survive a daemon restart');
    assert.equal(reread.settings.cueBreak, soundB, 'cueBreak must survive a daemon restart');
    assert.equal(reread.settings.cueLongBreak, NO_CUE, 'cueLongBreak must survive a daemon restart');
    assert.equal('sound' in reread.settings, false, 'the retired sound key must never reappear');
  });

  // --- the Master switch (`enabled`) ------------------------------------
  //
  // Route-level coverage for "Pomodoro made optional": the wire shape GET reports once
  // off, the settings write actually flipping it (clearing a running Timer Rollover-
  // style and refusing a subsequent ensure), and persistence across a restart -- the
  // pure semantics (mergeSettings, normalizeDoc, startWork, the armed setTimeout
  // actually being cancelled) are already covered in test/check-pomodoro.mjs; this is
  // specifically about the HTTP surface those pure functions sit behind.

  await check('POMODORO: GET keeps answering once the Master switch is off, and reports the disabled state -- no timer rides the wire', async () => {
    await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() });
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }) });
    const started = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.ok(started.timer, 'sanity: a real interval is running before the switch flips');

    const off = await (await fetch(`${base}/api/pomodoro/settings`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(off.settings.enabled, false, 'the write itself reports the flipped switch');
    assert.equal(off.timer, null, 'and the cleared Timer, in the same response');

    const doc = await (await fetch(`${base}/api/pomodoro`)).json();
    assert.equal(doc.settings.enabled, false, 'GET keeps answering, and reports the disabled state');
    assert.equal(doc.timer, null, 'no timer is present on the wire while off');
    assert.ok('settings' in doc && 'cycle' in doc && 'cycleDate' in doc, 'the rest of the document rides the wire exactly as it does while on');

    // Restore for the checks that follow.
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }) });
  });

  await check('POMODORO: the settings write flips the Master switch, clears a running Timer Rollover-style, and refuses ensure while off', async () => {
    await fetch(`${base}/api/pomodoro/reset`, { method: 'POST', headers: writeHeaders() });
    const started = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(started.timer.phase, 'work', 'sanity: a real interval is running before the switch flips');

    const off = await (await fetch(`${base}/api/pomodoro/settings`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(off.settings.enabled, false);
    assert.equal(off.timer, null, 'flipping off clears the running Timer');
    assert.equal(off.cycle, 0, 'and resets the Cycle, same as a Rollover');

    const ensureWhileOff = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(ensureWhileOff.timer, null, 'ensure is refused while off -- the exact seam the session-start hook\'s curl reaches, safe without the hook changing');

    const on = await (await fetch(`${base}/api/pomodoro/settings`, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }),
    })).json();
    assert.equal(on.settings.enabled, true);
    assert.equal(on.timer, null, 'flipping back on starts idle -- nothing is restored (ADR 90)');

    // And idle-while-on can start a real interval again, proving the disable/re-enable
    // round trip left no residue behind.
    const restarted = await (await fetch(`${base}/api/pomodoro/ensure`, { method: 'POST', headers: writeHeaders() })).json();
    assert.equal(restarted.timer.phase, 'work');
  });

  await check('POMODORO: the Master switch survives a daemon restart, same as every other toggle', async () => {
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: false }) });

    await new Promise(resolve => server.close(resolve));
    ({ server, port } = await startServer({ home, port: 0 }));
    base = `http://127.0.0.1:${port}`;

    const reread = await (await fetch(`${base}/api/pomodoro`)).json();
    assert.equal(reread.settings.enabled, false, 'the Master switch must survive a daemon restart');
    assert.equal(reread.timer, null, 'and the off state must still carry no timer after the restart');

    // Restore for the checks that follow -- nothing past this point is about pomodoro.
    await fetch(`${base}/api/pomodoro/settings`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ enabled: true }) });
  });

  await check('GET /file no longer exists: the daemon serves boards and nothing else', () => {
    // ADR.md entry 38: `/file/`, its allowlist and CLAUDE_BOARD_SERVE_ROOTS are deleted
    // outright, not merely defaulted to empty. A page board embeds a rendered document as
    // a snapshotted stage now, so the reason the route existed (markdown cannot link to
    // file://) is gone, and leaving it standing would be a second way to reach the same
    // artifact plus a second allowlist to keep straight. This has to 404 the same
    // way any unrecognized path does -- not a "route recognized, nothing configured"
    // response -- and it has to do that even when CLAUDE_BOARD_SERVE_ROOTS is still set,
    // proving the daemon does not read that variable at all any more (a leftover from an
    // install predating this change must not silently reopen the route).
    const serveDir = path.join(home, 'serve-fixtures-gone');
    mkdirSync(serveDir, { recursive: true });
    writeFileSync(path.join(serveDir, 'doc.html'), '<!doctype html><h1>render</h1>');

    return (async () => {
      process.env.CLAUDE_BOARD_SERVE_ROOTS = serveDir;
      try {
        const r = await fetch(`${base}/file/doc.html`);
        assert.equal(r.status, 404, '/file/ must 404 even with CLAUDE_BOARD_SERVE_ROOTS pointed at a real file');

        const bogus = await fetch(`${base}/some-other-unrecognized-path`);
        assert.equal(r.status, bogus.status, '/file/ gets no special-cased handling: it is just an unrecognized path');
      } finally {
        delete process.env.CLAUDE_BOARD_SERVE_ROOTS;
      }
    })();
  });

  // ===================================================================================
  // POST /api/pomodoro/preview -- the picker's "audition a sound before
  // saving" route (ADR.md entry 20). New section, appended at the very end
  // of the check sequence on purpose: the settings checks elsewhere in this file are
  // owned by a different slice of this work and are not touched here.
  //
  // The rule ("no check in it ever makes an audible sound") applies here exactly as
  // it does in test/check-notify.mjs: `afplay` is stubbed first on PATH, the exact
  // pattern that file already uses for `osascript`, so src/server.mjs's
  // `execFile('afplay', [filePath], ...)` resolves to the stub and nothing here ever
  // reaches the real player.
  // ===================================================================================

  // Two real names off THIS machine's /System/Library/Sounds (src/cues.mjs's own
  // "enumerated rather than hardcoded" rule, same reasoning test/check-notify.mjs
  // applies) -- two, not one, because the chorus check below needs to tell "the first
  // preview" and "the second preview" apart by which file each one named.
  const PREVIEW_CUES = cueNames().filter(n => n !== NO_CUE);
  assert.ok(PREVIEW_CUES.length >= 2, 'this machine needs at least 2 real sounds in /System/Library/Sounds for the preview checks');
  const [PREVIEW_CUE_A, PREVIEW_CUE_B] = PREVIEW_CUES;

  const STUB_AFPLAY = `#!/usr/bin/env node
import fs from 'node:fs';
const log = process.env.STUB_AFPLAY_LOG;
fs.appendFileSync(log, 'start:' + JSON.stringify(process.argv.slice(2)) + '\\n');
process.on('SIGTERM', () => {
  fs.appendFileSync(log, 'term:' + JSON.stringify(process.argv.slice(2)) + '\\n');
  process.exit(0);
});
setTimeout(() => process.exit(0), Number(process.env.STUB_AFPLAY_DURATION_MS || '0'));
`;

  const previewStubDir = mkdtempSync(path.join(tmpdir(), 'claude-board-preview-stub-'));
  // { mode: 0o755 } at creation -- no separate chmod call needed, same effect.
  writeFileSync(path.join(previewStubDir, 'afplay'), STUB_AFPLAY, { mode: 0o755 });

  let previewLogCounter = 0;
  function freshPreviewLog() {
    previewLogCounter++;
    return path.join(previewStubDir, `afplay-invocations-${previewLogCounter}.log`);
  }
  function readPreviewLines(logPath) {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  }
  async function waitForPreviewLines(logPath, count, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (readPreviewLines(logPath).length >= count) return readPreviewLines(logPath);
      await new Promise(r => setTimeout(r, 20));
    }
    return readPreviewLines(logPath);
  }
  /** PATH-stub the same way test/check-notify.mjs's withStubOnPath does, restoring
   * whatever was there before (including "was absent") afterwards. */
  async function withAfplayStub(logPath, durationMs, fn) {
    const savedPath = process.env.PATH;
    const savedLog = process.env.STUB_AFPLAY_LOG;
    const savedDuration = process.env.STUB_AFPLAY_DURATION_MS;
    process.env.PATH = `${previewStubDir}:${process.env.PATH}`;
    process.env.STUB_AFPLAY_LOG = logPath;
    process.env.STUB_AFPLAY_DURATION_MS = String(durationMs);
    try {
      await fn();
    } finally {
      process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.STUB_AFPLAY_LOG; else process.env.STUB_AFPLAY_LOG = savedLog;
      if (savedDuration === undefined) delete process.env.STUB_AFPLAY_DURATION_MS; else process.env.STUB_AFPLAY_DURATION_MS = savedDuration;
    }
  }

  await check('PREVIEW: a valid cue answers 200 {ok:true} and plays that cue\'s file directly, bypassing Notification Center entirely', async () => {
    const log = freshPreviewLog();
    await withAfplayStub(log, 200, async () => {
      const r = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: PREVIEW_CUE_A }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
      const lines = await waitForPreviewLines(log, 1);
      assert.equal(lines.length, 1, 'exactly one afplay invocation');
      const [argv] = JSON.parse(lines[0].slice('start:'.length));
      assert.equal(argv, `/System/Library/Sounds/${PREVIEW_CUE_A}.aiff`, 'the file played must be the named cue\'s own file');
    });
  });

  await check('PREVIEW: cue "None" answers 200 {ok:true} and plays nothing', async () => {
    const log = freshPreviewLog();
    await withAfplayStub(log, 200, async () => {
      const r = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: NO_CUE }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(readPreviewLines(log), [], 'afplay must never be invoked for None');
    });
  });

  await check('PREVIEW: a value isCue() refuses is a 400 naming the "cue" field, matching the shape a bad duration is refused in', async () => {
    const log = freshPreviewLog();
    await withAfplayStub(log, 200, async () => {
      const cases = [
        [{ cue: 'definitely not a real sound' }, 'a name off the closed set'],
        [{ cue: 'none' }, 'wrong case is not the same string as None'],
        [{}, 'cue missing entirely'],
        [{ cue: 123 }, 'a non-string cue'],
        [{ cue: null }, 'a null cue'],
      ];
      for (const [body, why] of cases) {
        const r = await fetch(`${base}/api/pomodoro/preview`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) });
        assert.equal(r.status, 400, `${why}: ${JSON.stringify(body)} must be rejected with 400`);
        const j = await r.json();
        assert.match(j.error, /cue/, `the 400 must name the "cue" field for ${JSON.stringify(body)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(readPreviewLines(log), [], 'no rejected body may ever reach afplay');
    });
  });

  await check('PREVIEW: reads and writes nothing -- pomodoro.json is byte-for-byte unchanged across a preview', async () => {
    const before = readPomodoroDoc(home);
    const log = freshPreviewLog();
    await withAfplayStub(log, 200, async () => {
      const r = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: PREVIEW_CUE_B }),
      });
      assert.equal(r.status, 200);
      await waitForPreviewLines(log, 1);
    });
    const after = readPomodoroDoc(home);
    assert.deepEqual(after, before, 'a preview must never touch pomodoro.json -- it is an audition, not a setting');
  });

  await check('PREVIEW: plays even with settings.notify off -- the notify toggle gates the boundary cue, never the picker\'s own audition', async () => {
    const doc = readPomodoroDoc(home);
    writePomodoroDoc({ ...doc, settings: { ...doc.settings, notify: false } }, home);
    const log = freshPreviewLog();
    try {
      await withAfplayStub(log, 200, async () => {
        const r = await fetch(`${base}/api/pomodoro/preview`, {
          method: 'POST',
          headers: writeHeaders(),
          body: JSON.stringify({ cue: PREVIEW_CUE_A }),
        });
        assert.equal(r.status, 200, 'notify: false must not refuse a preview');
        const lines = await waitForPreviewLines(log, 1);
        assert.equal(lines.length, 1, 'notify: false must not silence a preview -- only the boundary cue is gated by it');
      });
    } finally {
      // Restore, so a later check in this file that reads settings.notify is not left
      // looking at a value THIS check changed.
      writePomodoroDoc({ ...readPomodoroDoc(home), settings: { ...readPomodoroDoc(home).settings, notify: doc.settings.notify } }, home);
    }
  });

  await check('PREVIEW: the cookie alone may preview, joining POMODORO_COOKIE_ACTIONS (src/server.mjs)', async () => {
    const cookie = sessionCookieHeader();
    const cookieHeaders = {
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      cookie,
      'content-type': 'application/json',
    };
    const log = freshPreviewLog();
    await withAfplayStub(log, 200, async () => {
      const r = await rawRequest(port, 'POST', '/api/pomodoro/preview', `127.0.0.1:${port}`, {
        headers: cookieHeaders,
        body: JSON.stringify({ cue: PREVIEW_CUE_A }),
      });
      assert.equal(r.status, 200, 'the cookie alone must be able to preview a cue');
      await waitForPreviewLines(log, 1);
    });
  });

  await check('PREVIEW: POST /api/pomodoro/preview refuses a request with no credential at all', async () => {
    const r = await rawRequest(port, 'POST', '/api/pomodoro/preview', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cue: PREVIEW_CUE_A }),
    });
    assert.equal(r.status, 401, 'a preview request holding no credential must be refused, exactly like every other pomodoro write');
  });

  await check('NOTIFY TEST: POST /api/pomodoro/notifyTest refuses a request with no credential at all', async () => {
    // Only the refusal is checked here, deliberately. The 200 path raises a real banner
    // -- notifyTest ignores settings.notify by design, so this file's usual `notify:
    // false` guard cannot keep it silent, and this file stubs no PATH. That half lives
    // in test/check-notify.mjs, which stubs osascript properly. A 401 is decided before
    // the handler runs, so nothing fires from here.
    const r = await rawRequest(port, 'POST', '/api/pomodoro/notifyTest', `127.0.0.1:${port}`, {});
    assert.equal(r.status, 401, 'an uncredentialled request must never be able to raise a banner on the reader\'s machine');
  });

  await check('PREVIEW: a rapid second preview kills the first rather than overlapping into a chorus', async () => {
    const log = freshPreviewLog();
    // A generous duration -- long enough that if the kill below silently stopped
    // happening, the first stub would still be alive (and this check would catch it via
    // the missing 'term:' line) rather than coincidentally having already exited on its
    // own and passing for the wrong reason.
    await withAfplayStub(log, 1500, async () => {
      const first = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: PREVIEW_CUE_A }),
      });
      assert.equal(first.status, 200);
      await waitForPreviewLines(log, 1); // the first stub is confirmed running before the second fires

      const second = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: PREVIEW_CUE_B }),
      });
      assert.equal(second.status, 200);

      const lines = await waitForPreviewLines(log, 3, 3000); // start:A, term:A, start:B
      assert.ok(lines.some(l => l.startsWith('term:') && l.includes(PREVIEW_CUE_A)),
        `the FIRST preview (${PREVIEW_CUE_A}) must have been killed once the second one started -- got: ${JSON.stringify(lines)}`);
      assert.ok(lines.some(l => l.startsWith('start:') && l.includes(PREVIEW_CUE_B)),
        `the SECOND preview (${PREVIEW_CUE_B}) must have started -- got: ${JSON.stringify(lines)}`);
      assert.ok(!lines.some(l => l.startsWith('term:') && l.includes(PREVIEW_CUE_B)),
        'the second preview must still be the one considered "in flight" -- nothing has killed IT yet');

      // Cleanup: kill the still-running second stub too, via the same mechanism (any
      // preview call kills whatever is playing first) rather than leaving a 1.5s stub
      // process outliving this check and delaying the suite's own exit.
      const cleanup = await fetch(`${base}/api/pomodoro/preview`, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ cue: NO_CUE }),
      });
      assert.equal(cleanup.status, 200);
      const finalLines = await waitForPreviewLines(log, 4, 2000); // + term:B
      assert.ok(finalLines.some(l => l.startsWith('term:') && l.includes(PREVIEW_CUE_B)), 'cleanup must have killed the second stub in turn');
    });
  });

  rmSync(previewStubDir, { recursive: true, force: true });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall http checks ok');
  });
