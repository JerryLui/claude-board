// Headless HTTP round-trip check: starts a daemon on an ephemeral port against a
// temp CLAUDE_BOARD_HOME, posts a board, fetches the served page, submits answers
// over HTTP, asserts the blocked /wait call's packet and the store JSON, and asserts
// the loopback Host refusal. No browser, no real network beyond 127.0.0.1.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { SECRET_HEADER, SUBMIT_COOKIE } from '../src/secret.mjs';
import { startServer, activeWaitCount } from '../src/server.mjs';
import { readBoard, searchBoards } from '../src/store.mjs';
import { renderBoardPage } from '../src/render.mjs';
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

/** Strip the inlined <style> block, the #board-data JSON payload, and the client
 * <script type="module"> from a served page, leaving only the block markup that
 * renderBlock actually emitted. A block-kind-coverage assertion against the raw page
 * is unsafe: a class name like "compare-grid" or "mermaid-block" is also a CSS
 * selector in src/styles.mjs and a querySelector string literal in src/ui.mjs, and
 * any field value on a block (a label, a snippet of prose) is also present in the
 * JSON board.blocks the page inlines verbatim for hydration -- none of that proves
 * the corresponding renderBlock case ran. Stripping all three first means a needle
 * can only be found where the renderer actually put it. */
function renderedMarkup(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<script id="board-data"[^>]*>[\s\S]*?<\/script>/, '')
    .replace(/<script type="module">[\s\S]*?<\/script>/, '');
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
// before startServer below, because the daemon reads it once at startup. Every write
// route requires it (DESIGN.md Decisions -> "A loopback Host check, an origin
// check, and a local secret"); read routes deliberately do not.
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
function openSseClient(port, boardId) {
  return new Promise((resolveOpen, rejectOpen) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}` } },
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
    assert.equal(stored.blocks[1].kind, 'question');
    assert.equal(stored.blocks[1].id, 'q1');
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
          { blockId: 'd1', anchor: { kind: 'md', ref: 'acceptance-criteria-li2', label: 'two' }, text: 'criterion 2 comment' },
          { blockId: 'd1', anchor: { kind: 'md', ref: 'acceptance-criteria-li9', label: 'ghost' }, text: 'stale anchor comment' },
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
    const resolved = packet.comments.find(c => c.anchor.ref === 'acceptance-criteria-li2');
    assert.equal(resolved.resolved, true);
    const lost = packet.comments.find(c => c.anchor.ref === 'acceptance-criteria-li9');
    assert.equal(lost.resolved, false);
    assert.equal(lost.lost, 'acceptance-criteria-li9');
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

  // --- ticket 04: SSE round pushes into a live thread --------------------------

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
    const created = await (await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'Amend target', blocks: [{ kind: 'markdown', text: '# Original\n\noriginal text' }] }),
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
    assert.equal(stored.blocks.length, 1, 'the amend replaces the block in place rather than appending a duplicate');
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
    // Audit finding: amendRound matched an incoming id against ALL board.blocks,
    // not just the currently open round's, so an "amend" naming a sent round's
    // block id would move that block into the open round -- silently re-opening
    // an already-answered, already-disabled question for edit, and leaving its
    // real round's history rail rendering as if it had never been asked.
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
    // Audit finding: a caller-supplied raw.id reaches src/ui.mjs's amend-lookup
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
    assert.ok(submittedEvent.data.html.includes('class="round round-history" data-round="1" data-round-status="sent"'));
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
    // Merge-resolution fix (ticket 04 x ticket 06): src/render.mjs's
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
        blocks: [{ kind: 'markdown', text: '# Notes\n\n- one\n- two' }],
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
          { blockId: md1, anchor: { kind: 'md', ref: 'notes-li1', label: 'one' }, text: 'still resolves' },
          { blockId: md1, anchor: { kind: 'md', ref: 'notes-li9', label: 'ghost' }, text: 'never resolves' },
        ],
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 150));

    const submittedEvent = client.events.find(e => e.event === 'submitted');
    assert.ok(submittedEvent, 'expected a submitted event');
    const comments = submittedEvent.data.board.comments;
    assert.equal(comments.length, 2);
    const resolvedOne = comments.find(c => c.anchor && c.anchor.ref === 'notes-li1');
    const lostOne = comments.find(c => c.anchor && c.anchor.ref === 'notes-li9');
    assert.ok(resolvedOne, 'expected the still-resolvable comment in the pushed board.comments');
    assert.equal(resolvedOne.resolved, true, 'a resolvable comment in an SSE payload must carry resolved:true (ablation: sending the raw stored board leaves this field undefined)');
    assert.ok(lostOne);
    assert.equal(lostOne.resolved, false, 'an unresolvable comment in an SSE payload must carry resolved:false, exactly like a fresh page load would show');
    assert.equal(lostOne.lost, 'notes-li9');
    // resolveComment's output CARRIES round and createdAt rather than dropping them
    // (audit M4): without them nothing downstream -- the packet, the history rail, a
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

  // --- ticket 07: thread index, concurrent sessions, archive search ------------

  /** Pull the single `<a class="thread-item...">...</a>` element for one thread out
   * of the index page, so an assertion about its pending count or live/settled
   * class can only be satisfied by that thread's own row, not by some other
   * thread's markup or the inlined stylesheet (thread-item is also a CSS selector
   * in src/styles.mjs, so matching on the bare class name alone proves nothing). */
  function threadRowFor(html, threadId) {
    const re = new RegExp(`<a class="thread-item[^"]*" href="[^"]*" data-thread-id="${threadId}"[\\s\\S]*?</a>`);
    const m = re.exec(html);
    return m ? m[0] : null;
  }

  await check('the index lists a posted thread with its actual pending count, live vs settled', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        title: 'Index pending count',
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
    assert.match(rowBefore, /data-pending="2"/, 'two unanswered questions must render as pending count 2, not a placeholder');
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
    assert.match(rowAfter, /data-pending="0"/, 'answering both questions must drop the rendered pending count to 0');
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
    assert.match(rowA, /data-pending="3"/);
    assert.match(rowB, /data-pending="2"/);

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
    assert.match(threadRowFor(idxAfterA, postA.thread), /data-pending="0"/);
    assert.match(threadRowFor(idxAfterA, postB.thread), /data-pending="2"/, 'session B\'s pending count must be independent of session A\'s submit');

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

    // surfaced in the index UI itself, not just the JSON API
    const uiHtml = await (await fetch(`${base}/?q=${encodeURIComponent('checkout redesign')}`)).text();
    assert.ok(uiHtml.includes('Should we ship the checkout redesign?'), 'the index page must render the matching search result inline');
    assert.ok(uiHtml.includes(`href="/b/${posted.boardId}"`), 'the index search result must link to the board');
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
    assert.ok(markup.includes('const answer = 42;'));
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

  // --- ticket 06: element-level anchoring (dom, mermaid) round-trips through submit --
  //
  // The click gesture itself needs a browser (DESIGN.md Testing puts it out of
  // automated scope); what's asserted here is the data shape: a comment carrying a
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

    const domOk = packet.comments.find(c => c.anchor.kind === 'dom' && c.anchor.ref === '1.1');
    assert.equal(domOk.resolved, true);
    assert.equal(domOk.blockKind, 'html');
    assert.equal(domOk.anchor.hint, 'Send'); // hint survives the round trip verbatim
    assert.equal(domOk.lost, undefined);
    assert.equal(domOk.text, 'move this button left');

    const domLost = packet.comments.find(c => c.anchor.kind === 'dom' && c.anchor.ref === '9.9');
    assert.equal(domLost.resolved, false);
    // Ticket 04: a lost `dom` anchor's `.lost` names the stored HINT ("Launch"),
    // not the opaque index-chain ref ("9.9") -- the hint is what a human or an
    // agent reading the packet can recognise as "what this comment was about"
    // once the element is gone (DESIGN.md ticket 04: "the stored hint is
    // what survives when the element does not"). `c.anchor.ref` still carries
    // the raw ref for anything that wants it.
    assert.equal(domLost.lost, 'Launch');
    assert.equal(domLost.anchor.ref, '9.9');

    const mermaidOk = packet.comments.find(c => c.anchor.kind === 'mermaid' && c.anchor.ref === 'A');
    assert.equal(mermaidOk.resolved, true);
    assert.equal(mermaidOk.blockKind, 'mermaid');
    assert.equal(mermaidOk.text, 'rename the start node');
    assert.equal(mermaidOk.lost, undefined);

    const mermaidLost = packet.comments.find(c => c.anchor.kind === 'mermaid' && c.anchor.ref === 'Ghost');
    assert.equal(mermaidLost.resolved, false);
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

  // --- ticket 04: a page-scoped `dom` anchor survives a real post/submit/     ---
  // re-render round trip -----------------------------------------------------
  //
  // The gap this closes: src/board.mjs's resolveComment used to resolve a `dom`
  // anchor ONLY when block.kind === 'html' (the stage case ticket 02 built). A
  // page-scoped `dom` anchor -- ticket 03's generic model, rooted at the
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
  await check('ticket 04: a page-scoped dom anchor on several content kinds survives post -> submit -> re-render, and every pin returns to the element it named', async () => {
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
            left: { label: 'Before', block: { kind: 'markdown', text: 'the old copy, unchanged' } },
            right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Send</button></div>' } },
          },
          { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
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
    const questionId = rrStored.blocks[3].id;

    /** Loads a served page through the real client script, exactly like
     * check-comment-mode.mjs's loadBoard -- a fresh document per call. */
    function loadBoard(html) {
      const document = parseHTML(html);
      const window = document.defaultView;
      const location = { protocol: 'http:' };
      new Function('document', 'window', 'location', ui)(document, window, location);
      return document;
    }

    function enableCommentMode(document) {
      const toggle = document.getElementById('comment-mode-toggle');
      toggle.dispatchEvent(new StandInEvent('click'));
    }

    /** Click `el` (comment mode already on) and read back the anchor the real
     * client script minted onto `blockId`'s comment form -- the SAME mechanism
     * test/check-comment-mode.mjs proves criterion 1/6 with, reused here to feed
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

    const prose = doc1.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1);
    const listItem = doc1.querySelectorAll('.md-content li').find(el => el.textContent.trim() === 'alpha item');
    const tableCell = doc1.querySelectorAll('.md-content td').find(el => el.textContent.trim() === '42');
    const codeLine = doc1.querySelectorAll('.code-line').find(el => el.textContent.trim() === 'const y = 2;');
    const compareProse = doc1.querySelectorAll('.compare-side .md-content p').find(el => el.textContent.indexOf('old copy') !== -1);
    const option = doc1.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
    assert.ok(prose && listItem && tableCell && codeLine && compareProse && option, 'setup failure: could not find every fixture element on the first-rendered page');

    const pairs = [
      captureAnchor(doc1, prose, mdBlockId),
      captureAnchor(doc1, listItem, mdBlockId),
      captureAnchor(doc1, tableCell, mdBlockId),
      captureAnchor(doc1, codeLine, codeBlockId),
      captureAnchor(doc1, compareProse, compareLeftId),
      captureAnchor(doc1, option, questionId),
    ];
    // The html-stage side of the compare, still element (2) of ticket 03's TWO
    // roots (DESIGN.md / src/anchor.mjs's design comment) -- included so
    // this same round trip also proves block.kind === 'html' resolution is
    // unchanged by this ticket, not just the new page-scoped path.
    const frame = doc1.querySelector('.html-stage');
    frame.loadSrcdoc();
    const stageButton = frame.contentDocument.querySelector('button');
    pairs.push(captureAnchor(doc1, stageButton, compareRightId));

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
    // lost -- this is the exact packet buildPacket hands back over /wait.
    const packet = await (await fetch(`${base}/api/board/${rrBoardId}/wait?round=1`)).json();
    assert.equal(packet.comments.length, pairs.length);
    for (const c of packet.comments) {
      assert.equal(c.resolved, true, `comment on block ${c.blockId} (ref ${JSON.stringify(c.anchor.ref)}) must resolve after a real submit + re-render, not report lost`);
    }

    // Re-render from the stored JSON (a plain GET /b/:id always re-renders from
    // the store -- src/server.mjs) and drive the REAL client script over it
    // again: the seam that proves a pin actually lands on the page, not just
    // that resolveComment returned true in isolation.
    const secondPageHtml = await (await fetch(`${base}/b/${rrBoardId}`)).text();
    const doc2 = loadBoard(secondPageHtml);
    const frame2 = doc2.querySelector('.html-stage');
    frame2.loadSrcdoc(); // the html-stage pin layer only wires for real once "loaded"

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

  // --- ticket 05: snapshot and standalone archive -----------------------------------

  await check('the served page, the pages/ file on disk, and a fresh renderBoardPage() of the stored JSON are all byte-identical', async () => {
    const served = await (await fetch(`${base}/b/${boardId}`)).text();
    const onDisk = readFileSync(path.join(home, 'pages', `${boardId}.html`), 'utf8');
    const freshlyRendered = renderBoardPage(readBoard(boardId, home));
    assert.equal(served, onDisk, 'served page must match the pages/ file exactly -- that file is what Finder opens standalone');
    assert.equal(served, freshlyRendered, 're-rendering the stored JSON must reproduce the served page exactly');
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

    // no file was added or removed by answering
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());

    // every file except the board's own JSON and its emitted page projection is
    // byte-identical -- answering touches nothing else on disk. (Ablation: writing
    // any stray file during submit, or touching an unrelated board, fails this.)
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

  // --- audit fix round: cross-origin writes, round finality, wait liveness ---------

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

    // The forgery the audit reproduced live: re-submitting after the round was sent
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
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: `/api/board/${created.boardId}/wait?round=1`, headers: { host: `127.0.0.1:${port}` } }, res => res.resume());
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
      assert.ok(indexHtml.includes('Should we ship the checkout redesign?'), 'every readable board must still be listed and searchable');

      const searchRes = await fetch(`${base}/api/search?q=${encodeURIComponent('checkout redesign')}`);
      assert.equal(searchRes.status, 200, 'a corrupt board file must not 500 archive search');
      assert.ok((await searchRes.json()).results.length > 0);

      // L4: the corrupt file is logged once per store walk, so the warning count is a
      // direct count of how many times `GET /?q=` walked the store. (Ablation: calling
      // searchBoards(query, home) instead of passing the already-read boards array in
      // makes this 3 -- two walks for the index request, one for the search request.)
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
      assert.ok(csp.includes("form-action 'none'"));
      // ...and still allow what the page genuinely needs, or the whole UI is dead:
      assert.ok(/script-src[^;]*'unsafe-inline'/.test(csp), 'the page inlines its own module script');
      assert.ok(/script-src[^;]*cdn\.jsdelivr\.net/.test(csp), 'mermaid is a dynamic import from the CDN');
      assert.ok(/connect-src[^;]*'self'/.test(csp), 'submit and the SSE stream are same-origin fetches');
    }
  });

  // --- the local secret ---------------------------------------------------------
  //
  // DESIGN.md Decisions -> "A loopback Host check, an origin check, and a local
  // secret". The Host check closes the network and the origin check closes the browser;
  // neither can see a local process, which is what these cover. Every write above sends
  // the secret (writeHeaders), so the ones here that deliberately do not are what make
  // the gate provable.

  await check('SEC: a write with no secret, and a write with the wrong secret, are both 401 with no body and change nothing', async () => {
    const before = readdirSync(path.join(home, 'boards')).filter(f => f.endsWith('.json')).length;
    const body = JSON.stringify({ title: 'Unauthenticated probe', blocks: [{ kind: 'markdown', text: '# planted' }] });

    // (Ablation: drop isAuthorizedWrite from createRequestHandler and every case below
    // returns 200 -- which is the audit's gadget: a local process posts its own board
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

  await check('SEC: read routes stay open without the secret -- the reviewer\'s browser cannot hold one', async () => {
    // This is the deliberate shape of the fix, not an oversight: the archive stays
    // readable by any local process, and only writing (and with it file resolution) is
    // gated. A check that asserted 401 here would be asserting a broken product.
    const index = await rawRequest(port, 'GET', '/', `127.0.0.1:${port}`);
    assert.equal(index.status, 200, 'the thread index must render without a secret');

    const page = await rawRequest(port, 'GET', `/b/${boardId}`, `127.0.0.1:${port}`);
    assert.equal(page.status, 200, 'the served board page must render without a secret');
    assert.ok(page.body.includes('id="board-data"'));

    const search = await rawRequest(port, 'GET', '/api/search?q=trip', `127.0.0.1:${port}`);
    assert.equal(search.status, 200, 'archive search must work without a secret');

    const sse = await openSseClient(port, boardId);
    try {
      assert.equal(sse.status, 200, 'the SSE stream must open without a secret');
    } finally {
      sse.req.destroy();
    }
  });

  await check('SEC: the served page submits with the board-scoped cookie GET /b/:id sets, and that cookie authorises nothing else', async () => {
    // The browser has no way to read a 0600 file, so GET /b/:id hands it an HMAC of the
    // board id under the secret instead (src/secret.mjs submitToken) -- enough to answer
    // THAT board, never enough to create one or name a `cwd`.
    const created = JSON.parse((await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ title: 'Cookie submit', blocks: [{ kind: 'question', prompt: 'Ok?', widget: 'single', options: [{ label: 'Yes' }] }] }),
    })).body);
    const cid = created.boardId;
    const qid = readBoard(cid, home).blocks[0].id;

    const served = await rawRequest(port, 'GET', `/b/${cid}`, `127.0.0.1:${port}`);
    const setCookie = [].concat(served.headers['set-cookie'] || []).join('; ');
    assert.match(setCookie, new RegExp(`${SUBMIT_COOKIE}=[0-9a-f]{64}`), 'the served page must be handed a submit token');
    assert.match(setCookie, /HttpOnly/, 'script on any page must not be able to read it');
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, new RegExp(`Path=/api/board/${cid}/submit`), 'the token must be scoped to this board\'s submit route alone');
    const cookie = setCookie.split(';')[0];
    const token = cookie.split('=')[1];

    // Exactly what the page's own fetch() sends: same-origin headers, the cookie, no secret.
    const sent = await rawRequest(port, 'POST', `/api/board/${cid}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', cookie },
      body: JSON.stringify({ round: 1, action: 'send', answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'from the page' }], comments: [] }),
    });
    // (Ablation: drop the cookie arm of isAuthorizedWrite and this is 401 -- i.e. no
    // reviewer can ever press Send, which is the entire product.)
    assert.equal(sent.status, 200, 'the reviewer must be able to answer the board from the browser');
    assert.equal(readBoard(cid, home).answers[qid].note, 'from the page');

    // The cookie is a submit credential for ONE board, not a substitute for the secret.
    const asSecret = await rawRequest(port, 'POST', '/api/board', `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: token },
      body: JSON.stringify({ title: 'Escalation attempt', cwd: home, blocks: [{ kind: 'markdown', text: '# no' }] }),
    });
    assert.equal(asSecret.status, 401, 'a submit token must not be usable as the secret');

    const otherBoard = await rawRequest(port, 'POST', `/api/board/${boardId}/submit`, `127.0.0.1:${port}`, {
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
    });
    assert.equal(otherBoard.status, 401, 'one board\'s submit token must not answer another board');
  });

  await check('SEC: a daemon with no secret on disk refuses writes rather than falling open', async () => {
    // The fail-closed half. (Ablation: `if (!secret) return true` in isAuthorizedWrite
    // -- a plausible-looking "don't break machines that never installed" concession --
    // and a machine with no secret file is exactly as exposed as before this fix.)
    const bareHome = mkdtempSync(path.join(tmpdir(), 'claude-board-nosecret-'));
    // ...and says so, once, on stderr where launchd keeps it: a daemon silently
    // refusing every write with no explanation is the same support call either way.
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
      const readable = await rawRequest(barePort, 'GET', '/', `127.0.0.1:${barePort}`);
      assert.equal(readable.status, 200, 'reads must still work: the daemon refuses writes, it does not shut down');
    } finally {
      bare.close();
      rmSync(bareHome, { recursive: true, force: true });
    }
  });

  // --- thread-level cwd binding (audit C2, the call site) -------------------------

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
