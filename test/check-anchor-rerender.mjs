// Ticket 04 (SPEC_ANCHORING.md): "Anchors survive re-render, and every older
// board still renders." test/check-http.mjs's own new section proves the live,
// real-server half of criterion 4 (a page-scoped `dom` anchor round-trips through
// a real post/submit/re-render without going lost). This file covers the two
// halves that don't need a daemon:
//
//   - a LOST anchor reports what it lost -- visibly on the page (a pin drawn
//     `pin-lost`, a comment-list entry reading "lost: <hint>") and in what the
//     agent reads (buildPacket's own `resolved`/`lost` fields) -- rather than
//     silently vanishing (criterion 4, second half).
//   - a board archived BEFORE this ticket -- built with the actual code at
//     commit 578f666 (the tip before SPEC_ANCHORING.md's tickets started;
//     test/fixtures/pre-ticket04-board.json, committed alongside this file, is
//     that commit's own createBoard/applySubmit output, not a hand-written
//     "old-shaped" anchor) -- still renders its comments and pins unchanged
//     under today's code (criterion 7, second half).
//
// Both run against the real src/ui.mjs client script over test/dom-stand-in.mjs,
// not just resolveComment/renderBoardPage in isolation -- the whole lesson this
// spec's own Testing section states: resolution logic passing on its own proves
// nothing about the page a reviewer actually sees.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBoard, applySubmit, buildPacket, resolveComment } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** Parse a rendered page and run the real `ui` client script against it, exactly
 * like test/check-comment-mode.mjs's loadBoard -- a fresh document every call. */
function loadBoard(pageHtml) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

function directChildPinLayer(section) {
  return Array.prototype.slice.call(section.children || [])
    .find(c => c.classList && c.classList.contains('pin-layer')) || null;
}

// --- a page-scoped dom anchor that no longer resolves: named, not vanished ----

const lostBoard = createBoard({
  title: 'Ticket 04 -- a lost page-scoped anchor',
  blocks: [
    {
      kind: 'markdown',
      text: ['# Findings', '', 'A paragraph that will stay right where it is.'].join('\n'),
    },
  ],
});
const lostBlockId = lostBoard.blocks[0].id;
// A `dom` anchor naming an element this block's content never had at this
// index -- the same "hand-edited/stale ref" shape every other anchor kind's
// existing lost-anchor check in this repo already uses (test/check-pure.mjs's
// '9.9' for an html stage, a heading slug that was never minted for `md`, a
// node id a diagram never declared for `mermaid`) -- see this ticket's own
// instructions: content is snapshotted at post time (SPEC_ANCHORING.md
// Decisions -> "An anchor survives re-render, not editing"), so the only way a
// `dom` anchor goes lost is exactly this: a ref/hint that never matched what's
// actually stored, e.g. because the element it named at mint time is gone.
applySubmit(lostBoard, {
  action: 'send',
  answers: [],
  comments: [
    {
      blockId: lostBlockId,
      anchor: { kind: 'dom', ref: '2.9', hint: 'a sentence that used to live here' },
      text: 'this used to point at a real sentence',
    },
  ],
}, 1);

check('ticket 04: what the agent reads -- buildPacket reports a lost page-scoped dom anchor as unresolved, naming the stored hint, not dropping the comment', () => {
  const packet = buildPacket(lostBoard, 1, 'http://127.0.0.1/b/x');
  assert.equal(packet.comments.length, 1, 'the comment must still be IN the packet -- lost, not dropped');
  const c = packet.comments[0];
  assert.equal(c.resolved, false);
  assert.equal(c.lost, 'a sentence that used to live here', 'the stored hint is what survives when the element does not');
  assert.equal(c.text, 'this used to point at a real sentence', 'the comment text itself is untouched');
  assert.equal(c.blockId, lostBlockId);
});

check('ticket 04: resolveComment agrees, directly', () => {
  const resolved = resolveComment(lostBoard, lostBoard.comments[0]);
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.lost, 'a sentence that used to live here');
});

check('ticket 04: what the reviewer sees -- a lost page-scoped dom anchor draws a pin-lost pin and a "lost: <hint>" comment-list entry, never a silently missing comment', () => {
  const pageHtml = renderBoardPage(lostBoard);

  // Server-rendered markup: the comment list entry is emitted directly by
  // src/render.mjs (commentArea/anchorTag), independent of the client script.
  assert.ok(pageHtml.includes('lost: a sentence that used to live here'), 'the comment list must name what the anchor lost');
  assert.ok(pageHtml.includes('comment-lost'), 'the lost entry must carry the lost-styling class');

  // Client-rendered pin: wirePageDomPins draws it from board.comments' own
  // resolved/lost verdict (never re-derived client-side -- src/ui.mjs's own file
  // comment), so this is the SAME verdict buildPacket just reported above, drawn
  // on the actual page a reviewer opens.
  const document = loadBoard(pageHtml);
  const section = document.querySelector('.markdown-block');
  assert.ok(section, 'setup failure: no markdown block section rendered');
  const layer = directChildPinLayer(section);
  assert.ok(layer, 'setup failure: the markdown block has no page-scoped pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin (lost, but still drawn), got ${pins.length}`);
  const pin = pins[0];
  assert.equal(pin.classList.contains('pin-lost'), true, 'a lost anchor\'s pin must be styled lost, not indistinguishable from a resolved one');
  assert.ok(String(pin.title || '').indexOf('lost: a sentence that used to live here') !== -1,
    `expected the pin's title to name what it lost, got ${JSON.stringify(pin.title)}`);
});

// --- ablation-visible contrast: the SAME board, but the ref actually resolves -

check('ticket 04: contrast -- the same shape of board, but a ref/hint that DOES still match, resolves (proving the lost check above is discriminating, not just always-false)', () => {
  const okBoard = createBoard({
    title: 'Ticket 04 -- contrast, a page-scoped anchor that resolves',
    blocks: [{ kind: 'markdown', text: ['# Findings', '', 'A paragraph that will stay right where it is.'].join('\n') }],
  });
  const blockId = okBoard.blocks[0].id;
  // Section children: [kicker, md-content, pin-layer, comment-target, form, list].
  // md-content's children: [h1, p]. So "2.2" is the paragraph -- a real,
  // structurally-valid page-scoped ref, same shape ticket 03's own click gesture
  // mints.
  applySubmit(okBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId, anchor: { kind: 'dom', ref: '2.2', hint: 'A paragraph that will stay right where it is.' }, text: 'fine as is' }],
  }, 1);
  const packet = buildPacket(okBoard, 1, 'http://127.0.0.1/b/x');
  assert.equal(packet.comments[0].resolved, true);
  assert.equal(packet.comments[0].lost, undefined);
});

// --- a board archived before this ticket still renders unchanged --------------

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pre-ticket04-board.json');
const oldBoard = JSON.parse(readFileSync(fixturePath, 'utf8'));

check('ticket 04: a board built with the actual pre-ticket-04 code (commit 578f666) still resolves every one of its comments exactly as that code resolved them', () => {
  // The fixture's own comments, and what 578f666's OWN resolveComment (identical
  // logic to today's for every one of these kinds -- block/md/dom-on-html/
  // mermaid) already decided about them at build time: see
  // .tmp-578f666/build-fixture.mjs's own choices, captured here as the expected
  // shape rather than re-derived, so this check is pinned to what the OLD board
  // actually contains, not to whatever today's code happens to compute.
  const expected = [
    { n: 1, blockId: 'd1', kind: 'block', resolved: true },
    { n: 2, blockId: 'd1', kind: 'md', resolved: true },
    { n: 3, blockId: 'h1', kind: 'dom', resolved: true, hint: 'Send' },
    { n: 4, blockId: 'm1', kind: 'mermaid', resolved: true },
    { n: 5, blockId: 'd1', kind: 'md', resolved: false, lost: 'findings-li9' },
  ];
  assert.equal(oldBoard.comments.length, expected.length, 'setup failure: the fixture does not have the comments this check expects -- was it regenerated?');

  const packet = buildPacket(oldBoard, 1, 'http://127.0.0.1/b/old');
  assert.equal(packet.comments.length, expected.length);
  expected.forEach((exp, i) => {
    const c = packet.comments[i];
    assert.equal(c.n, exp.n);
    assert.equal(c.blockId, exp.blockId);
    assert.equal(c.anchor.kind, exp.kind);
    assert.equal(c.resolved, exp.resolved, `comment #${exp.n} (${exp.kind} on ${exp.blockId}) must resolve exactly as it did under the pre-ticket-04 code`);
    if (exp.lost) assert.equal(c.lost, exp.lost);
    if (exp.hint) assert.equal(c.anchor.hint, exp.hint);
  });
});

check('ticket 04: the pre-ticket-04 board\'s pins land in the same places on today\'s rendered page: the block comment, the md list-item comment, the html-stage dom comment, all resolved, and the stale md comment reported lost', () => {
  const pageHtml = renderBoardPage(oldBoard);
  const document = loadBoard(pageHtml);

  // The whole-block and md-heading/list-item comments: rendered in the
  // markdown block's own comment list, unchanged code paths.
  assert.ok(pageHtml.includes('a whole-block comment, from before this spec'));
  assert.ok(pageHtml.includes('#2 · alpha item'));
  assert.ok(pageHtml.includes('#5 · lost: findings-li9'), 'the stale md anchor must still report lost by its ref, exactly as before this ticket (md anchors were never affected by ticket 04\'s hint-vs-ref change)');
  assert.ok(pageHtml.includes('comment-lost'));

  // The html-stage dom anchor: block.kind === 'html' resolution is UNCHANGED
  // code (this ticket only added a NEW branch for every other block kind), so
  // the pin lands exactly as ticket 02 left it -- via the real client script,
  // once the stage's real srcdoc document has "loaded".
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered for the old board\'s html block');
  frame.loadSrcdoc();
  const section = document.querySelector('.html-block');
  const layer = section.querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin on the pre-existing html-stage comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'the pre-ticket-04 html-stage dom anchor must still resolve, unchanged');
  assert.ok(String(pins[0].title || '').indexOf('Send') !== -1, `expected the pin's title to carry the stored hint "Send", got ${JSON.stringify(pins[0].title)}`);

  // The mermaid node-id anchor: also entirely unchanged code, reachable once
  // the diagram has "rendered" -- this stand-in never loads mermaid's own CDN
  // script, so it exercises the CDN-unreachable/offline path (svg === null),
  // which src/ui.mjs's own comment states still draws pins from the server's
  // resolved/lost verdict.
  const mermaidSection = document.querySelector('.mermaid-block');
  const mermaidPre = mermaidSection.querySelector('pre.mermaid');
  assert.ok(mermaidPre, 'setup failure: no pre.mermaid rendered for the old board\'s mermaid block');
  // wireMermaidBlock is invoked by src/ui.mjs's own mermaid-loading path, which
  // this stand-in does not simulate (no CDN); assert the packet-level verdict
  // instead, already proven server-rendered above via buildPacket, and confirm
  // the block's comment list (which does not depend on the client script at
  // all) already names it resolved, not lost.
  assert.ok(pageHtml.includes('#4 · A'), 'the mermaid node-id comment must render resolved (its node id, not "lost: ...")');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall anchor-rerender checks ok');
