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
import { rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';
import { check, openSseClient, postBoard, runMain, secretFetch, secretHome, sleep, writeHeaders } from './support.mjs';

const { home, secret: SECRET } = secretHome('claude-board-anchor-robustness-', { secret: 'b'.repeat(64) });

const SSE_HEARTBEAT_MS = 40;
process.env.CLAUDE_BOARD_SSE_HEARTBEAT_MS = String(SSE_HEARTBEAT_MS);

/** `fetch`, shadowed for this module only, carrying the secret on every call — reads are
 * gated too now, and nothing in this file is about the credential.
 * test/check-http.mjs owns the gate itself and does the same thing for the same reason. */
const fetch = secretFetch(SECRET);

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

  await check('a submit carrying a dom comment anchored to an html block with out-of-range numeric entities does not 500, and the SSE "submitted" event still fires', async () => {
    // Setup: the post and a first render both succeed -- the html is stored verbatim and
    // the page escapes it into `srcdoc`, so neither reaches decodeEntities. The submit
    // below, which resolves a dom anchor against this block, is the first thing that does.
    ({ boardId } = await postBoard(port, SECRET, { title: 'V5a robustness', blocks: [{ kind: 'html', html: badHtml }] }));
    assert.equal((await fetch(`${base}/b/${boardId}`)).status, 200, 'setup failure: the freshly-posted board must render');

    sse = await openSseClient(port, boardId, { secret: SECRET, comments: false });
    await sleep(100);

    const board = readBoard(boardId, home);
    const htmlBlockId = board.blocks[0].id;

    const submitRes = await fetch(`${base}/api/board/${boardId}/submit`, {
      method: 'POST',
      headers: writeHeaders(SECRET),
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

    await sleep(200);
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

  await check('GET /b/:id and /wait keep working after the submit, and the anchor beside the undecodable entities still resolves', async () => {
    const page = await fetch(`${base}/b/${boardId}`);
    assert.equal(page.status, 200, 'a board that once carried an undecodable entity must not 500 on every future read');

    const waitRes = await fetch(`${base}/api/board/${boardId}/wait?round=1`);
    assert.equal(waitRes.status, 200);
    const packet = await waitRes.json();
    assert.equal(packet.status, 'submitted');
    assert.equal(packet.comments.length, 1);
    // decodeEntities leaves an out-of-range entity as its own text, so the tree walk
    // still sees `<div>` with the button as its first element child: ref 1.1, hint
    // "Send" is the ordinary resolved case, and the packet says so by carrying no
    // `lost` (ADR 99: and no `resolved` key either).
    assert.equal(packet.comments[0].lost, undefined, 'the out-of-range entities must not knock the dom anchor off the button it names');
  });

  if (sse) sse.req.destroy();
}

runMain('anchor-robustness', main, {
  cleanup: () => {
    if (sse) sse.req.destroy();
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
  },
});
