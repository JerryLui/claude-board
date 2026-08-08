// Ticket 04 (DESIGN.md): "Anchors survive re-render, and every older
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
//     commit 578f666 (the tip before DESIGN.md's tickets started;
//     test/fixtures/pre-ticket04-board.json, committed alongside this file, is
//     that commit's own createBoard/applySubmit output, not a hand-written
//     "old-shaped" anchor) -- still renders its comments and pins unchanged
//     under today's code (criterion 7, second half). ADR.md entry 28 narrowed
//     "unchanged" for exactly one part of that fixture: its `markdown` block
//     carries three stored comments and renders none of them, since a markdown
//     block has no comment surface any more. That is SPEC_COUNTS.md criterion
//     19, and it is checked here rather than in a file of its own, because this
//     fixture is the only genuinely-pre-existing archived board in the repo.
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

function enableCommentMode(document) {
  const toggle = document.querySelector('button#comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

function directChildPinLayer(section) {
  return Array.prototype.slice.call(section.children || [])
    .find(c => c.classList && c.classList.contains('pin-layer')) || null;
}

// --- a page-scoped dom anchor that no longer resolves: named, not vanished ----

// ADR.md entry 28 narrowed the page-scoped gesture to the two rendered kinds, so
// the block carrying this lost anchor is a `mermaid` one whose source failed to
// resolve -- its `.resolve-error` note is the one element of a mermaid section the
// generic gesture can reach, and the section still carries the direct-child
// pin-layer this check is about. It used to be a markdown block; markdown has no
// comment surface at all now.
const lostBoard = createBoard({
  title: 'Ticket 04 -- a lost page-scoped anchor',
  blocks: [
    { kind: 'mermaid', source: { path: 'no-such-diagram-04.mmd' } },
  ],
});
assert.equal(typeof lostBoard.blocks[0].error, 'string',
  'setup failure: the block must actually fail to resolve, or it renders no .resolve-error note to anchor against');
const lostBlockId = lostBoard.blocks[0].id;
// A `dom` anchor naming an element this block's content never had at this
// index -- the same "hand-edited/stale ref" shape every other anchor kind's
// existing lost-anchor check in this repo already uses (test/check-pure.mjs's
// '9.9' for an html stage, a heading slug that was never minted for `md`, a
// node id a diagram never declared for `mermaid`) -- see this ticket's own
// instructions: content is snapshotted at post time (DESIGN.md
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
  const section = document.querySelector('.mermaid-block');
  assert.ok(section, 'setup failure: no mermaid block section rendered');
  const layer = directChildPinLayer(section);
  assert.ok(layer, 'setup failure: the mermaid block has no page-scoped pin-layer');
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
    blocks: [{ kind: 'mermaid', source: { path: 'no-such-diagram-04b.mmd' } }],
  });
  const blockId = okBoard.blocks[0].id;
  // Minted through the REAL click gesture rather than hand-written, so the ref and
  // the hint are exactly what a reviewer's click produces -- the alternative
  // (spelling the error note's own text into a literal hint) would be a second
  // copy of extractHint's truncation rule waiting to drift.
  const mintDoc = loadBoard(renderBoardPage(okBoard));
  enableCommentMode(mintDoc);
  const note = mintDoc.querySelector('.mermaid-block .resolve-error');
  assert.ok(note, 'setup failure: no .resolve-error note to click');
  note.dispatchEvent(new StandInEvent('click'));
  const form = mintDoc.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: the click did not open the block\'s comment form');
  const anchor = {
    kind: form.getAttribute('data-anchor-kind'),
    ref: form.getAttribute('data-anchor-ref'),
    hint: form.getAttribute('data-anchor-label'),
  };
  assert.equal(anchor.kind, 'dom', 'setup failure: the generic page-scoped gesture must mint a dom anchor');

  applySubmit(okBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId, anchor, text: 'fine as is' }],
  }, 1);
  const packet = buildPacket(okBoard, 1, 'http://127.0.0.1/b/x');
  assert.equal(packet.comments[0].resolved, true);
  assert.equal(packet.comments[0].lost, undefined);
});

// --- a board archived before this ticket still renders unchanged --------------

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pre-ticket04-board.json');
const oldBoard = JSON.parse(readFileSync(fixturePath, 'utf8'));

check('ticket 04 / criterion 19: a board built with the actual pre-ticket-04 code (commit 578f666) still resolves every one of its comments, and its stored markdown comments no longer report a verdict of their own', () => {
  // The fixture's own comments, and what 578f666's OWN resolveComment decided
  // about them at build time: see .tmp-578f666/build-fixture.mjs's own choices.
  //
  // ADR.md entry 28 changed exactly one thing here, and only for the two `md`
  // comments (n:2 and n:5) on the markdown block `d1`: the `md` anchor kind is
  // gone, so resolveComment has no branch that knows how to judge one and they
  // fall through to the always-resolved default, the same place a `block` anchor
  // (n:1, on that same markdown block) has always landed. That is deliberately a
  // deletion rather than a new "unknown kind is lost" rule: `d1` renders no
  // comment list at all now, so there is nothing on the page for either verdict
  // to decorate -- which is criterion 19, checked directly in the next case. The
  // element-level anchors on the two kinds that ARE still commentable (n:3 on the
  // html stage, n:4 on the diagram) resolve exactly as they always did.
  const expected = [
    { n: 1, blockId: 'd1', kind: 'block', resolved: true },
    { n: 2, blockId: 'd1', kind: 'md', resolved: true },
    { n: 3, blockId: 'h1', kind: 'dom', resolved: true, hint: 'Send' },
    { n: 4, blockId: 'm1', kind: 'mermaid', resolved: true },
    { n: 5, blockId: 'd1', kind: 'md', resolved: true },
  ];
  assert.equal(oldBoard.comments.length, expected.length, 'setup failure: the fixture does not have the comments this check expects -- was it regenerated?');
  assert.ok(oldBoard.comments.some(c => c.anchor && c.anchor.kind === 'md'),
    'setup failure: this check exists to cover a STORED md anchor -- the fixture no longer carries one');

  const packet = buildPacket(oldBoard, 1, 'http://127.0.0.1/b/old');
  assert.equal(packet.comments.length, expected.length);
  expected.forEach((exp, i) => {
    const c = packet.comments[i];
    assert.equal(c.n, exp.n);
    assert.equal(c.blockId, exp.blockId);
    assert.equal(c.anchor.kind, exp.kind);
    assert.equal(c.resolved, exp.resolved, `comment #${exp.n} (${exp.kind} on ${exp.blockId}) resolved unexpectedly`);
    if (exp.hint) assert.equal(c.anchor.hint, exp.hint);
  });
});

check('criterion 19: an archived board carrying stored markdown comments renders without them and without error -- the html-stage and diagram comments on the same board are untouched', () => {
  // Renders at all: a stored comment on a block that no longer has anywhere to
  // put one must not throw on the way through commentArea/anchorTag/resolveComment.
  let pageHtml;
  assert.doesNotThrow(() => { pageHtml = renderBoardPage(oldBoard); },
    'a board carrying a stored markdown comment must still render');
  const document = loadBoard(pageHtml);

  // ...without them: the markdown block emits no comment surface at all, so none
  // of its three stored comments (whole-block, md-anchored, stale md-anchored)
  // appears anywhere on the page.
  const mdSection = document.querySelector('.markdown-block');
  assert.ok(mdSection, 'setup failure: the fixture\'s markdown block is not rendered at all');
  assert.equal(mdSection.querySelectorAll('.comment-item').length, 0, 'a markdown block must render no comment entries');
  assert.equal(mdSection.querySelectorAll('.comment-btn').length, 0, 'a markdown block must render no comment button');
  assert.equal(directChildPinLayer(mdSection), null, 'a markdown block must render no pin-layer');
  assert.equal(document.getElementById('comment-form-d1'), null, 'a markdown block must render no comment form');
  // Asserted over the RENDERED entries, not over the page bytes: the board's own
  // JSON is inlined into #board-data, so every stored comment's text is present
  // in the file either way. What criterion 19 is about is whether any of it is
  // rendered as a comment.
  const renderedComments = document.querySelectorAll('.comment-item').map(el => el.textContent);
  for (const gone of ['a whole-block comment, from before this spec', 'alpha item', 'findings-li9']) {
    assert.equal(renderedComments.some(t => t.indexOf(gone) !== -1), false,
      `a stored comment on the markdown block must not render anywhere on the page: ${gone}`);
  }
  assert.equal(renderedComments.length, 2,
    `only the html-stage and mermaid comments have anywhere left to render, got ${renderedComments.length} entries`);

  // The two rendered kinds on the SAME archived board are untouched -- this is
  // "commenting narrows", not "commenting breaks".
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered for the old board\'s html block');
  frame.loadSrcdoc();
  const section = document.querySelector('.html-block');
  const layer = section.querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin on the pre-existing html-stage comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'the pre-ticket-04 html-stage dom anchor must still resolve, unchanged');
  assert.ok(String(pins[0].title || '').indexOf('Send') !== -1, `expected the pin's title to carry the stored hint "Send", got ${JSON.stringify(pins[0].title)}`);

  // The mermaid node-id anchor: reachable once the diagram has "rendered" -- this
  // stand-in never loads mermaid's own CDN script, so it exercises the
  // CDN-unreachable/offline path (svg === null), which still draws pins from the
  // server's resolved/lost verdict. Asserted here through the block's own comment
  // list, which does not depend on the client script at all.
  const mermaidSection = document.querySelector('.mermaid-block');
  assert.ok(mermaidSection.querySelector('pre.mermaid'), 'setup failure: no pre.mermaid rendered for the old board\'s mermaid block');
  assert.ok(pageHtml.includes('#4 · A'), 'the mermaid node-id comment must render resolved (its node id, not "lost: ...")');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall anchor-rerender checks ok');
