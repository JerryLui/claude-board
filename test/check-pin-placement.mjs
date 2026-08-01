// Ticket 09 (DESIGN.md): "every pin lands where it is named" -- criteria 4
// and 5 re-earned. Fixes audit findings C4 and U6; U3 is covered in
// test/check-anchor-push.mjs (it is specifically about SSE-pushed content).
//
// C4: three sections invited the click-to-anchor gesture but had no pin-layer to
// draw into -- a compare block's own `.compare-side`/`.compare-grid` chrome, a
// markdown block's `.resolve-error` branch, and a mermaid block's `.resolve-error`
// branch (a mermaid section's ONLY pin-layer used to be the stage-scoped one
// nested inside `.stage-wrap`, entirely absent when the block errored). A `dom`
// anchor rooted at any of these still resolved server-side (resolveDomAnchorInSection
// walks the whole section), so the comment recorded as `resolved: true` with no
// pin anywhere on the page -- ticket 09's own framing of the defect. Ticket 07's
// real layout model (test/dom-stand-in.mjs) is what makes "the pin lands where it
// is named" independently checkable here, not just "a pin exists somewhere": every
// check below recomputes the expected position the exact way src/ui.mjs's
// renderDomPins does (`elBox.left - stageBox.left`, `elBox.top - stageBox.top`)
// and compares it against what was actually drawn.
//
// U6: nextStackedOffset's per-layer counter used to live for the page's whole
// lifetime while `layer.innerHTML = ''` cleared the pins it was counting, so a
// lost pin's fallback position drifted further from the layer's top-left on every
// re-render -- walking off the section after enough pushes/resizes/queued
// comments. Checked here by forcing several independent re-renders of the SAME
// layer (via several unrelated comment submissions elsewhere on the page, each of
// which -- src/ui.mjs's comment-form submit handler -- calls refreshPins(document),
// which re-renders every page-scoped pin layer, this one included) and asserting
// the lost pin's fallback position is IDENTICAL every time, not walking outward.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
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

function loadBoard(pageHtml) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

/** The direct-child `.pin-layer` of a block section -- exactly what
 * directChildPinLayer (src/ui.mjs) itself walks, never a deep querySelector (a
 * compare section's nested sides each carry their OWN pin-layer too, and a deep
 * search from the outer section could find one of those instead). */
function directChildPinLayer(section) {
  return Array.prototype.slice.call(section.children).find(c => c.classList && c.classList.contains('pin-layer')) || null;
}

function clickAndSubmit(document, el, blockId, text) {
  el.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'), `setup failure: clicking the target element did not open block ${blockId}'s comment form`);
  const input = form.querySelector('input[type=text]');
  input.value = text;
  form.dispatchEvent(new StandInEvent('submit'));
  return form;
}

// --- C4 (retired by ADR.md entry 6): a compare side's own chrome ----------------
//
// This check used to prove that clicking a compare side's own chrome (not the
// content nested inside it) minted a page-scoped `dom` anchor into the OUTER
// compare section's own pin-layer. ADR.md entry 6, "Commenting is confined to
// content blocks" (2026-08-01), reverses that: `compare` is a wrapper, not
// content, and loses the comment affordance entirely, including this outer
// pin-layer -- src/render.mjs's renderCompareBlock no longer renders one at
// all -- and the click-to-anchor gesture over the wrapper's own surfaces,
// which src/ui.mjs's isNonAnchorableRoot now stands down. The exact case this
// check exercised -- a compare side's own chrome being anchorable, button or
// no button -- is named in the ADR as "the middle position on `compare`
// (button gone, side-level clicks kept)... rejected as the one option
// inconsistent with every other wrapper". Nothing in the old assertion
// survives as a positive case, so it is retired outright (same style as
// ADR.md entry 5's retirement of test/check-grill.mjs's assertions) and
// replaced below with a check that the new behaviour actually holds, plus a
// re-pointed case proving the wrapper's own nested content did NOT lose the
// guarantee this file exists to protect.

check('C4 (retired by ADR.md entry 6): a compare block renders no page-scoped pin-layer of its own, and clicking a side\'s own chrome mints no comment at all', () => {
  const board = createBoard({
    title: 'Ticket 09 / ADR entry 6 -- a compare wrapper has no comment affordance of its own',
    blocks: [{
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'markdown', text: 'old copy' } },
      right: { label: 'After', block: { kind: 'markdown', text: 'new copy' } },
    }],
  });
  const compareBlockId = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);

  const section = document.querySelector('.compare-block');
  assert.ok(section, 'setup failure: no .compare-block section rendered');
  const side = document.querySelectorAll('.compare-side')[0];
  assert.ok(side, 'setup failure: no .compare-side rendered');

  assert.equal(directChildPinLayer(section), null, 'a compare block must no longer carry a direct-child page-scoped pin-layer of its own (ADR.md entry 6)');
  assert.equal(document.getElementById('comment-form-' + compareBlockId), null, 'a compare block must no longer carry a comment-form of its own');

  // Click the side's own chrome -- its label, structural not authored --
  // rather than anything nested inside it.
  const label = side.querySelector('.compare-label');
  assert.ok(label, 'setup failure: no .compare-label rendered');
  label.dispatchEvent(new StandInEvent('click'));

  assert.equal(document.getElementById('comment-form-' + compareBlockId), null, 'clicking a compare side\'s own chrome must mint no comment form -- the gesture is inert over the wrapper\'s own surfaces');
  assert.equal(document.querySelectorAll('.anchor-pin').length, 0, 'clicking a compare side\'s own chrome must draw no pin anywhere on the page');
});

check('C4, re-pointed: a block NESTED inside a compare side is still genuinely anchorable in ITS OWN pin-layer -- gating the compare wrapper did not take its child with it', () => {
  const board = createBoard({
    title: 'Ticket 09 -- a compare side\'s nested content block stays commentable',
    blocks: [{
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'markdown', text: 'old copy' } },
      right: { label: 'After', block: { kind: 'markdown', text: 'new copy' } },
    }],
  });
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);

  const compareSection = document.querySelector('.compare-block');
  assert.ok(compareSection, 'setup failure: no .compare-block section rendered');
  const nestedSection = compareSection.querySelector('.markdown-block');
  assert.ok(nestedSection, 'setup failure: no nested .markdown-block rendered inside the compare side');
  const nestedBlockId = nestedSection.getAttribute('data-block-id');
  assert.notEqual(nestedBlockId, board.blocks[0].id, 'setup failure: the nested block must carry its OWN id, not the compare wrapper\'s');

  const layer = directChildPinLayer(nestedSection);
  assert.ok(layer, 'setup failure: the nested markdown block has no direct-child page-scoped pin-layer of its own');
  assert.equal(layer.querySelectorAll('.anchor-pin').length, 0, 'setup failure: a pin already exists before anything was queued');

  const content = nestedSection.querySelector('.md-content');
  assert.ok(content, 'setup failure: no .md-content rendered inside the nested markdown block');

  clickAndSubmit(document, content, nestedBlockId, 'a comment on the nested block itself');

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin in the nested block's OWN pin-layer, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false);

  const elBox = content.getBoundingClientRect();
  const sectionBox = nestedSection.getBoundingClientRect();
  const expectedLeft = elBox.left - sectionBox.left;
  const expectedTop = elBox.top - sectionBox.top;
  assert.equal(pins[0].style.left, expectedLeft + 'px', `expected the pin positioned at the nested content itself (${expectedLeft}px), got ${JSON.stringify(pins[0].style.left)}`);
  assert.equal(pins[0].style.top, expectedTop + 'px', `expected the pin positioned at the nested content itself (${expectedTop}px), got ${JSON.stringify(pins[0].style.top)}`);

  // And the OUTER compare section still has no pin-layer of its own -- the
  // nested block's pin is not mistakenly attributed to the wrapper.
  assert.equal(directChildPinLayer(compareSection), null, 'the compare wrapper must still carry no page-scoped pin-layer of its own even once its nested content has a live pin');
});

// --- C4: a markdown block's own resolve-error branch -----------------------------

check('C4: a markdown block that failed to resolve is still anchorable -- clicking its .resolve-error note draws a correctly positioned pin', () => {
  const board = createBoard({
    title: 'Ticket 09 -- a broken markdown reference is still commentable',
    blocks: [{ kind: 'markdown', source: { path: 'no-such-file-09.md' } }],
  });
  const blockId = board.blocks[0].id;
  assert.equal(typeof board.blocks[0].error, 'string', 'setup failure: the block must actually fail to resolve');
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);

  const section = document.querySelector('.markdown-block');
  assert.ok(section, 'setup failure: no .markdown-block section rendered');
  const errorNote = section.querySelector('.resolve-error');
  assert.ok(errorNote, 'setup failure: no .resolve-error note rendered');

  const layer = directChildPinLayer(section);
  assert.ok(layer, 'setup failure: an errored markdown block has no page-scoped pin-layer -- C4 is unfixed');

  clickAndSubmit(document, errorNote, blockId, 'what happened to this file?');

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false);

  const elBox = errorNote.getBoundingClientRect();
  const sectionBox = section.getBoundingClientRect();
  assert.equal(pins[0].style.left, (elBox.left - sectionBox.left) + 'px');
  assert.equal(pins[0].style.top, (elBox.top - sectionBox.top) + 'px');
});

// --- C4: a mermaid block's own resolve-error branch ------------------------------

check('C4: a mermaid block that failed to resolve is still anchorable -- clicking its .resolve-error note draws a correctly positioned pin, even though the block has no stage-wrap/live-svg at all', () => {
  const board = createBoard({
    title: 'Ticket 09 -- a broken mermaid reference is still commentable',
    blocks: [{ kind: 'mermaid', source: { path: 'no-such-diagram-09.mmd' } }],
  });
  const blockId = board.blocks[0].id;
  assert.equal(typeof board.blocks[0].error, 'string', 'setup failure: the block must actually fail to resolve');
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);

  const section = document.querySelector('.mermaid-block');
  assert.ok(section, 'setup failure: no .mermaid-block section rendered');
  assert.equal(section.querySelectorAll('.stage-wrap').length, 0, 'setup failure: this check must exercise the errored, no-stage-wrap path');
  const errorNote = section.querySelector('.resolve-error');
  assert.ok(errorNote, 'setup failure: no .resolve-error note rendered');

  const layer = directChildPinLayer(section);
  assert.ok(layer, 'setup failure: an errored mermaid block has no page-scoped pin-layer -- C4 is unfixed');

  clickAndSubmit(document, errorNote, blockId, 'what happened to this diagram?');

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false);

  const elBox = errorNote.getBoundingClientRect();
  const sectionBox = section.getBoundingClientRect();
  assert.equal(pins[0].style.left, (elBox.left - sectionBox.left) + 'px');
  assert.equal(pins[0].style.top, (elBox.top - sectionBox.top) + 'px');
});

// --- U6: the stacked offset must not drift across repeated re-renders -----------

check('U6: a lost pin\'s fallback stacked position stays put across repeated re-renders of its layer, never walking outward (ablation: dropping resetStackedOffset next to layer.innerHTML = \'\' makes this fail after the second re-render)', () => {
  const board = createBoard({
    title: 'Ticket 09 -- stacked offset must not drift',
    blocks: [{ kind: 'markdown', text: 'stale content, about to be sent' }],
  });
  const staleBlockId = board.blocks[0].id;
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: '# H\n\n- alpha\n- beta\n- gamma' }] });
  const openBlockId = board.blocks.find(b => b.round === round2).id;

  // A comment whose ref no longer resolves to anything -- server-verdict lost,
  // client draws it via the stacked-offset fallback (position === null).
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [{ blockId: staleBlockId, anchor: { kind: 'dom', ref: '999.999', hint: 'a stale reference' }, text: 'this is now lost' }],
  }, 1);

  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);

  const staleSection = document.querySelector(`[data-block-id="${staleBlockId}"]`);
  const staleLayer = directChildPinLayer(staleSection);
  assert.ok(staleLayer, 'setup failure: the stale block has no page-scoped pin-layer');

  function lostPinPosition() {
    const lostPins = staleLayer.querySelectorAll('.anchor-pin.pin-lost');
    assert.equal(lostPins.length, 1, `expected exactly one lost pin throughout, got ${lostPins.length}`);
    return { left: lostPins[0].style.left, top: lostPins[0].style.top };
  }

  const baseline = lostPinPosition();
  assert.ok(baseline.left && baseline.top, 'setup failure: the lost pin has no fallback position at all');

  // Trigger several independent, unrelated refreshPins(document) passes -- each
  // comment queued anywhere on the page re-renders EVERY page-scoped pin layer
  // (src/ui.mjs's comment-form submit handler), the stale block's included, same
  // as a real reviewer queueing several comments, a window resize, or a follow-up
  // SSE push all would.
  const openSection = document.querySelector(`[data-block-id="${openBlockId}"]`);
  const items = openSection.querySelectorAll('.md-content li');
  assert.ok(items.length >= 3, 'setup failure: need at least 3 distinct click targets in the open round');

  for (let i = 0; i < items.length; i++) {
    clickAndSubmit(document, items[i], openBlockId, 'comment #' + i);
    const now = lostPinPosition();
    assert.equal(now.left, baseline.left, `after re-render #${i + 1}, the lost pin's fallback left drifted from ${baseline.left} to ${now.left} -- the stacked-offset counter was not reset with its layer`);
    assert.equal(now.top, baseline.top, `after re-render #${i + 1}, the lost pin's fallback top drifted from ${baseline.top} to ${now.top} -- the stacked-offset counter was not reset with its layer`);
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pin-placement checks ok');
