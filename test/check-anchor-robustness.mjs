// `decodeEntities` used to raise
// `RangeError` on an out-of-range numeric entity (`&#1114112;`, one past Unicode's
// max; `&#x999999999;`, wildly larger), contradicting parseHtmlTree's own "Never
// throws" contract. The only reachable input is raw `block.html` on an `html`
// stage -- markdown escapes `&` before block parsing -- resolved server-side only
// when a `dom` comment anchored to that block is walked by resolveComment
// (src/board.mjs), which every submit does via renderBoardPage/writePage
// (src/server.mjs's handleSubmit).
//
// This file drives that exact path over real HTTP, the way check-http.mjs drives
// every other route: no unit call on decodeEntities anywhere here. Before the fix,
// this check's first `check()` failed the submit with a 500 (the throw happening
// inside `renderBoardPage` at src/server.mjs's old writeBoard-then-writePage
// ordering, AFTER the board was already durably written) and every GET/`/wait`
// after it also 500'd, forever.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';

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

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-anchor-robustness-'));
process.env.CLAUDE_BOARD_HOME = home;

const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'b'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

const SSE_HEARTBEAT_MS = 40;
process.env.CLAUDE_BOARD_SSE_HEARTBEAT_MS = String(SSE_HEARTBEAT_MS);

function writeHeaders(extra) {
  return { 'content-type': 'application/json', [SECRET_HEADER]: SECRET, ...(extra || {}) };
}

/** `fetch`, shadowed for this module only, carrying the secret on every call — reads are
 * gated too now, and nothing in this file is about the credential.
 * test/check-http.mjs owns the gate itself and does the same thing for the same reason. */
const rawFetch = globalThis.fetch;
function fetch(input, init = {}) {
  return rawFetch(input, { ...init, headers: { [SECRET_HEADER]: SECRET, ...(init.headers || {}) } });
}

/** Open a raw SSE connection and collect event frames, same helper as check-http.mjs. */
function openSseClient(port, boardId) {
  return new Promise((resolveOpen, rejectOpen) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET } },
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
            if (evLine && dataLine) events.push({ event: evLine.slice('event:'.length).trim(), data: JSON.parse(dataLine.slice('data:'.length).trim()) });
          }
        });
        resolveOpen({ req, res, events });
      },
    );
    req.on('error', rejectOpen);
    req.end();
  });
}

let server, port, base, sse;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  // The entities that used to raise RangeError inside String.fromCodePoint:
  // 0x110000 is exactly one past Unicode's max (0x10FFFF), and the hex form is an
  // arbitrarily large finite number nowhere near any valid code point -- both
  // Number.isFinite(code) and (pre-fix) that was the whole guard.
  const badHtml = '<div class="mock">bad entity &#1114112; and huge &#x999999999; entity <button>Send</button></div>';

  let boardId;

  await check('POST /api/board with an html block carrying an out-of-range numeric entity is accepted and rendered', async () => {
    const r = await fetch(`${base}/api/board`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({ title: 'V5a robustness', blocks: [{ kind: 'html', html: badHtml }] }),
    });
    assert.equal(r.status, 200, 'posting the board itself must not fail (the html is stored verbatim, never parsed at post time)');
    const j = await r.json();
    boardId = j.boardId;

    const page = await fetch(`${base}/b/${boardId}`);
    assert.equal(page.status, 200, 'the freshly-posted board must render (no comments yet, so resolveComment/decodeEntities is not even reached here)');
  });

  await check('a submit carrying a dom comment anchored to that html block does not 500, and the SSE "submitted" event still fires', async () => {
    sse = await openSseClient(port, boardId);
    await new Promise(resolve => setTimeout(resolve, 100));

    const board = readBoard(boardId, home);
    const htmlBlockId = board.blocks[0].id;

    const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        round: 1,
        action: 'send',
        answers: [],
        comments: [
          { blockId: htmlBlockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'this walks resolveDomAnchor -> parseHtmlTree(block.html) -> decodeEntities on the bad entity above' },
        ],
      }),
    });
    // Before the fix: decodeEntities threw RangeError deep inside renderBoardPage,
    // which handleSubmit called AFTER writeBoard already durably persisted the
    // submit -- so this assertion is the one that used to fail with a 500 while
    // the store already held the "sent" round underneath it.
    assert.equal(submitRes.status, 200, 'submit must succeed even though the anchored block carries an entity that cannot be decoded');

    await new Promise(resolve => setTimeout(resolve, 200));
    const submitted = sse.events.find(e => e.event === 'submitted');
    assert.ok(submitted, 'the "submitted" SSE broadcast must fire -- before the fix, the throw happened before sse.broadcast ever ran');
  });

  await check('the archive (pages/<id>.html) reflects the sent round, not a stale pre-submit snapshot', async () => {
    const pagePath = path.join(home, 'pages', `${boardId}.html`);
    assert.ok(existsSync(pagePath), 'page projection must exist');
    const html = readFileSync(pagePath, 'utf8');
    // The inlined #board-data JSON is the authoritative signal that writePage ran
    // against the POST-submit board, not the pre-submit one: before the fix,
    // writeBoard ran (the JSON store already said "sent") but writePage never did
    // (the throw happened before it), so the archive silently stayed a round
    // behind the JSON -- this is the assertion that catches exactly that gap.
    assert.match(html, /"status":"sent"|"state":"submitted"/, 'the archived page must show the round as sent, proving writePage ran after the submit, not before it threw');
  });

  await check('GET /b/:id and /wait keep working after the submit -- the board is not wedged forever', async () => {
    const page = await fetch(`${base}/b/${boardId}`);
    assert.equal(page.status, 200, 'a board that once carried an undecodable entity must not 500 on every future read');

    const waitRes = await fetch(`${base}/api/board/${boardId}/wait?round=1`);
    assert.equal(waitRes.status, 200);
    const packet = await waitRes.json();
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.comments.length, 1);
    // The comment may resolve or go lost depending on hint-match semantics (out
    // of scope here) -- what matters here is that resolving it never throws and
    // always comes back as a well-formed verdict: `lost` is either absent
    // (resolved) or a string naming what it lost, and the packet never carries
    // `resolved` at all (ADR 99).
    assert.equal('resolved' in packet.comments[0], false);
    assert.ok(packet.comments[0].lost === undefined || typeof packet.comments[0].lost === 'string');
  });

  if (sse) sse.req.destroy();
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (sse) sse.req.destroy();
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall anchor-robustness checks ok');
  });
