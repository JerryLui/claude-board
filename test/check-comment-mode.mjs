// Comment mode, and one anchoring model over the
// board's own rendered DOM. Extends the end-to-end DOM stand-in seam already
// built and turned green (test/dom-stand-in.mjs, test/check-click.mjs,
// test/check-click-pin.mjs) rather than adding another unit check over the pure
// module -- the whole point of this repo's testing strategy is that a check over
// src/anchor.mjs alone cannot see whether a listener is actually attached to a
// live document.
//
// Covers, against the REAL src/ui.mjs client script run in the stand-in:
//   - as ADR.md entry 28 leaves it: the generic page-scoped gesture
//     over the kinds that are still commentable -- a diagram, and a diagram
//     inside a compare side -- each clicked in comment mode, each opening its
//     block's comment form with a `dom` reference and a hint naming it.
//     Table-driven over the SAME rendered board. This table used to hold one row
//     per acceptance-criterion example (prose, a list item, a table cell, a line
//     of a code reference); entry 28 inverts those into the table
//     immediately below it, which drives the same gesture and asserts it mints
//     nothing. ("a question's own widget" was inverted the same way one ADR
//     earlier, by entry 28.)
//   - an `html` stage and a `mermaid` diagram are commentable
//     WHEREVER they appear -- including inside a question's `context` and inside
//     a compare side. Checked by driving the real gesture in each position, not
//     by reading the kind check.
//   - a `markdown` block and a `code` block offer no comment
//     control (no button, no form, no list, no pin-layer) and no click-to-anchor
//     gesture, at the top level or nested inside a wrapper.
//   - with comment mode on, hovering marks the exact element under
//     the cursor and never an ancestor.
//   - with comment mode OFF (the default -- these checks never touch
//     the toggle), the ordinary interactions the spec names by name still work:
//     choosing a single-select option, typing into a text answer, and pressing
//     Send (a stubbed global `fetch` captures what actually got posted, so this
//     is a real assertion on the collected answers, not just "it didn't throw").
//     Drag-to-rank and text-selection are the two interactions this repo's own
//     testing docs already carve out as not automatable in a headless DOM --
//     see this file's own note further down for
//     exactly what is and isn't covered here for that reason.
//   - the hint for a clicked element names both its own identity and
//     its containing context -- the concrete "Send button in the after stage"
//     case, via the html-stage's click gesture and a compare
//     block's two sides.
//   - one gesture, toggle-gated everywhere: a later product decision (not a
//     defect -- see this file's own section further down) retired the hand-
//     mocked stage's original always-on click/hover as a standing exception.
//     With comment mode off, clicking inside a stage now does nothing and no
//     hover outline appears; with it on, the stage behaves exactly as it did
//     before. test/check-click.mjs and test/check-click-pin.mjs cover "what
//     happens once the click lands" (unchanged); this file covers the toggle
//     itself gating that gesture.

import assert from 'node:assert/strict';
import { createBoard, applySubmit } from '../src/board.mjs';
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

// One board fixture covering every content kind called for, short of
// the diagram node and the hand-mocked stage on its own (already
// covered end to end by test/check-click.mjs / test/check-click-pin.mjs -- this
// file's own hint check below still exercises it, inside a compare side).
const BLOCK_SPEC = [
  {
      kind: 'markdown',
      text: [
        '# Findings',
        '',
        'A paragraph of prose to comment on.',
        '',
        'A paragraph with **bold text** inside.',
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
    // Two diagrams whose source cannot resolve. ADR.md entry 28 leaves `mermaid`
    // commentable, and an errored one is the shape whose `.resolve-error` note the
    // GENERIC page-scoped gesture can reach -- `pre.mermaid` and `.stage-wrap` are
    // chrome, and a click on a rendered node is the diagram's own gesture (covered
    // end to end in test/check-mermaid-anchor.mjs). Two of them, because several
    // checks below need two independent, simultaneously-live anchor targets.
    { kind: 'mermaid', source: { path: 'no-such-diagram-28a.mmd' } },
    { kind: 'mermaid', source: { path: 'no-such-diagram-28b.mmd' } },
    {
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'mermaid', source: { path: 'no-such-diagram-28c.mmd' } } },
      right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Send</button></div>' } },
    },
    { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  { kind: 'question', prompt: 'Explain', widget: 'text', options: [] },
];
const board = createBoard({ title: 'Ticket 03 -- any element takes a comment', blocks: BLOCK_SPEC });
const [mdBlock, codeBlock, diagramBlock, diagram2Block, compareBlock, choiceBlock, textBlock] = board.blocks;
for (const b of [diagramBlock, diagram2Block, compareBlock.left.block]) {
  assert.equal(typeof b.error, 'string',
    'setup failure: the diagram fixtures must actually fail to resolve, or they render no .resolve-error note to anchor against');
}

/** The one generic-gesture target a mermaid section offers: its resolve-error
 * note. Looked up by block id rather than by a wrapper class, so a layout change
 * around a question's context or a compare side cannot silently retarget it. */
function errorNoteFor(document, blockId) {
  return document.querySelector(`[data-block-id="${blockId}"] .resolve-error`);
}
const pageHtml = renderBoardPage(board);

/** Parse the page and run the real `ui` client script against it, exactly like
 * test/check-click.mjs's loadBoard -- a fresh document every call, so checks
 * never share mutated state. */
function loadBoard() {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** Turns comment mode on via the actual toggle button -- never by reaching in and
 * setting a variable, which would prove nothing about the gesture a reviewer
 * actually has (discoverable, visible chrome). */
function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle button rendered on the board page');
  assert.equal(toggle.classList.contains('active'), false, 'setup failure: comment mode must start off');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: clicking the toggle did not turn comment mode on');
  return toggle;
}

/** A fresh, standalone (no compare) html-stage board, loaded and run exactly like
 * loadBoard() -- kept separate from the shared `board` fixture above because the
 * checks below need to inspect the stage BEFORE and AFTER toggling comment mode,
 * which a shared, already-loaded document could leak between check() calls. */
function loadSoloStageBoard() {
  // A trailing markdown block keeps this an ORDINARY board (isPageRound
  // false): a lone `html` block is a page round (ADR.md entry 33) whose
  // comment gesture gates on being *awaited* (ADR.md
  // entry 46) -- and this file's own "comment mode off" checks specifically
  // need the gesture to be gateable by the TOGGLE alone, which an awaited page
  // round's AC 5 ("opens with comment mode on") would fight with. Staying
  // ordinary sidesteps both.
  const soloBoard = createBoard({
    title: 'Ticket 03 -- comment mode gates the stage too',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
      { kind: 'markdown', text: 'not a page board' },
    ],
  });
  const soloBlockId = soloBoard.blocks[0].id;
  const soloHtml = renderBoardPage(soloBoard);
  const document = parseHTML(soloHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return { document, blockId: soloBlockId };
}

// --- one content kind per acceptance-criterion example --------------------------

const KIND_CASES = [
  {
    name: 'a diagram',
    blockId: diagramBlock.id,
    find: doc => errorNoteFor(doc, diagramBlock.id),
    hintIncludes: ['could not resolve'],
  },
  {
    name: 'a diagram on one side of a comparison',
    blockId: compareBlock.left.block.id,
    find: doc => errorNoteFor(doc, compareBlock.left.block.id),
    // Inside a compare side, the hint also carries context -- the
    // note's own text as identity, "Before diagram" as context (this side's own
    // label plus the nested block's kind noun -- see src/anchor.mjs's design
    // comment).
    hintIncludes: ['could not resolve', 'before', 'diagram'],
  },
];

for (const kindCase of KIND_CASES) {
  check(`comment mode: clicking ${kindCase.name} opens its block's comment form with a dom reference and a hint naming it`, () => {
    const document = loadBoard();
    enableCommentMode(document);
    const el = kindCase.find(document);
    assert.ok(el, `setup failure: could not find the fixture element for "${kindCase.name}"`);

    el.dispatchEvent(new StandInEvent('click'));

    const form = document.getElementById('comment-form-' + kindCase.blockId);
    assert.ok(form, `setup failure: no comment-form for block ${kindCase.blockId}`);
    assert.equal(form.classList.contains('open'), true,
      `clicking "${kindCase.name}" in comment mode must open its block's comment form -- it did not`);
    assert.equal(form.getAttribute('data-anchor-kind'), 'dom',
      `expected a "dom" anchor kind for "${kindCase.name}", got ${JSON.stringify(form.getAttribute('data-anchor-kind'))}`);
    const ref = form.getAttribute('data-anchor-ref');
    assert.ok(ref && ref.length > 0, `expected a non-empty dom-path ref for "${kindCase.name}", got ${JSON.stringify(ref)}`);
    const hint = form.getAttribute('data-anchor-label');
    assert.ok(hint && hint.length > 0, `expected a non-empty, human-readable hint for "${kindCase.name}", got ${JSON.stringify(hint)}`);
    for (const needle of kindCase.hintIncludes) {
      assert.ok(hint.toLowerCase().indexOf(needle.toLowerCase()) !== -1,
        `expected the hint for "${kindCase.name}" (${JSON.stringify(hint)}) to mention ${JSON.stringify(needle)}`);
    }
  });
}

// --- markdown and code offer neither control nor gesture ------------------------
//
// The inverse of the table above, driven exactly the same way. Each of these was
// a POSITIVE row until ADR.md entry 28; keeping them as negatives is what stops
// the affordance quietly coming back on a kind the reviewer never wanted it on.

const NON_ANCHORABLE_KIND_CASES = [
  { name: 'prose', find: doc => doc.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1) },
  { name: 'a list item', find: doc => doc.querySelectorAll('.md-content li').find(el => el.textContent.trim() === 'alpha item') },
  { name: 'a table cell', find: doc => doc.querySelectorAll('.md-content td').find(el => el.textContent.trim() === '42') },
  { name: 'a heading', find: doc => doc.querySelector('.md-content h1') },
  { name: 'the body of a code reference', find: doc => doc.querySelector('.code-block pre') },
  { name: 'a line of a code reference', find: doc => doc.querySelector('.code-block code') },
];

for (const kindCase of NON_ANCHORABLE_KIND_CASES) {
  check(`clicking ${kindCase.name} in comment mode mints no comment and shows no hover affordance`, () => {
    const document = loadBoard();
    enableCommentMode(document);
    assertNotAnchorable(document, kindCase.find(document), kindCase.name);
  });
}

check('a markdown block and a code block render no comment button, no comment form, no comment list, no comment target and no pin-layer', () => {
  const document = loadBoard();
  for (const [name, blockId] of [['markdown', mdBlock.id], ['code', codeBlock.id]]) {
    const section = document.querySelector(`[data-block-id="${blockId}"]`);
    assert.ok(section, `setup failure: no ${name} section rendered`);
    assert.equal(section.querySelectorAll('.comment-btn').length, 0, `a ${name} block must render no comment button`);
    assert.equal(document.getElementById('comment-form-' + blockId), null, `a ${name} block must render no comment form`);
    assert.equal(document.getElementById('comment-list-' + blockId), null, `a ${name} block must render no comment list`);
    assert.equal(document.getElementById('comment-target-' + blockId), null, `a ${name} block must render no comment target`);
    assert.equal(section.querySelectorAll('.pin-layer').length, 0, `a ${name} block must render no pin-layer`);
  }
  // ...and the two kinds that DO keep the affordance still have all of it, in the
  // same document -- so this cannot pass against a page that lost it everywhere.
  const diagramSection = document.querySelector(`[data-block-id="${diagramBlock.id}"]`);
  assert.equal(diagramSection.querySelectorAll('.comment-btn').length, 1, 'a mermaid block must still render its comment button');
  assert.ok(document.getElementById('comment-form-' + diagramBlock.id), 'a mermaid block must still render its comment form');
  const stageId = compareBlock.right.block.id;
  assert.ok(document.getElementById('comment-form-' + stageId), 'an html block must still render its comment form');
});

check('comment mode: a numbered pin lands on the anchored element once the opened form is submitted, same as the html-stage gesture', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const el = errorNoteFor(document, diagramBlock.id);
  el.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + diagramBlock.id);
  const section = document.querySelector(`[data-block-id="${diagramBlock.id}"]`);
  const layer = section.children.find(c => c.classList && c.classList.contains('pin-layer'));
  assert.ok(layer, 'setup failure: the diagram block has no page-scoped pin-layer');
  assert.equal(layer.querySelectorAll('.anchor-pin').length, 0, 'setup failure: a pin already exists before anything was queued');

  const input = form.querySelector('input[type=text]');
  input.value = 'needs a citation';
  form.dispatchEvent(new StandInEvent('submit'));

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin after queueing one comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'a freshly-queued comment must not render as lost');
});

// --- hovering marks exactly the hovered element --------------------------------

// Driven inside a hand-mocked html stage rather than over markdown prose: ADR.md
// entry 28 left `html` and `mermaid` as the only commentable kinds, and a stage's
// own mock (`<div class="mock"><button>Send</button></div>`) is now the only
// NESTED anchorable markup on any board -- which is what "the exact element, never
// an ancestor" needs to be observable at all.
check('comment mode: hovering marks the exact (innermost) hovered element, never an ancestor', () => {
  const { document } = loadSoloStageBoard();
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');
  const wrapper = button.parentElement;
  assert.ok(wrapper, 'setup failure: the <button> has no parent element in the mock');

  button.dispatchEvent(new StandInEvent('mouseover'));

  assert.equal(button.classList.contains('cb-anchor-hover'), true,
    'the exact hovered element must be marked as the one that will be anchored');
  assert.equal(wrapper.classList.contains('cb-anchor-hover'), false,
    'the hovered element\'s ancestor must NOT also be marked -- hovering must name one element, not a chain');
});

check('comment mode off: hovering marks nothing at all (the affordance itself is part of the explicit mode, not ambient)', () => {
  const { document } = loadSoloStageBoard(); // comment mode never enabled here
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-hover'), false, 'hovering must do nothing while comment mode is off');
});

// --- comment mode OFF (never touched below) never steals an -------------------
// ordinary interaction. Driven end to end through the real client script, not
// argued -- an untested claim here is exactly how this
// spec's own defect shipped twice.
//
// NOT covered here, named rather than silently skipped: text selection, and the
// full drop-and-reorder gesture. test/dom-stand-in.mjs's own file comment states
// it implements no selection API at all, and 'dragover' (where the actual
// reordering happens, driven by a live pointer position) is not modelled either --
// both are pre-existing, documented ceilings of this stand-in, not new gaps this
// file introduces. The FULL
// drag-and-drop gesture is already carved out as unautomatable without a real browser for that
// reason.
//
// What IS reachable,
// and IS covered a few checks below, is the one thing this actually turns
// on for this widget -- the 'dragstart' handler's own `commentMode ||` guard
// (src/ui.mjs). This comment used to claim that coverage existed here without any
// check ever dispatching a 'dragstart'; that turned out to be the exact
// pattern this whole spec exists to eliminate (a criterion standing on an
// argument, with a comment vouching for a check that was never written), and
// `node test/run.mjs` stayed fully green with `commentMode ||` deleted from that
// guard. Fixed below, not just in this comment.

check('comment mode off: choosing a single-select option still selects it (and does not open a comment form)', () => {
  const document = loadBoard();
  const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
  assert.ok(yes, 'setup failure: no "Yes" option rendered');
  assert.equal(yes.classList.contains('selected'), false, 'setup failure: nothing should be pre-selected');

  yes.dispatchEvent(new StandInEvent('click'));

  assert.equal(yes.classList.contains('selected'), true, 'clicking an option with comment mode off must still select it');
  // Per ADR "Commenting is confined to content blocks"
  // (src/render.mjs): a question block renders no comment-form of its own any
  // more at all, so there is no single element left to ask "did THIS one stay
  // closed". Proven instead the same way the wrapper-gating checks further
  // down this file prove it -- driving the real gesture and checking its
  // effect on the page as a whole, not on markup that may or may not exist:
  // no comment form anywhere ends up open, and nothing gets queued.
  assert.equal(document.querySelectorAll('.comment-form.open').length, 0,
    'choosing an option must not open any comment form when comment mode is off');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0,
    'choosing an option must mint no comment when comment mode is off');
});

check('comment mode off: typing into a text-answer widget still records the text', () => {
  const document = loadBoard();
  const textarea = document.querySelector('textarea[data-answer-for="' + textBlock.id + '"]');
  assert.ok(textarea, 'setup failure: no text-answer textarea rendered for the text-widget question');
  textarea.value = 'this is the reviewer\'s free-text answer';
  textarea.dispatchEvent(new StandInEvent('input'));
  // The shared fixture's OTHER question (choiceBlock) also needs an answer here:
  // the round-end send guard (test/check-send-guard.mjs owns its own contract)
  // arms Send instead of submitting while any question is outstanding, and this
  // check's own subject is whether typed text reaches the submit body, not the
  // guard -- so the round is filled out completely, exactly the state a plain
  // click on Send is still expected to submit immediately.
  document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1)
    .dispatchEvent(new StandInEvent('click'));

  // Answers are read generically off the widget at Send time (src/ui.mjs
  // collectAnswers/currentAnswer), so proving the typed text actually reaches
  // Send is the same proof this repo already prefers over reaching into private
  // state (see the 'pressing Send' check just below, which reads it back exactly
  // that way).
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ board }) });
  };
  try {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'setup failure: clicking Send never called fetch');
  const answer = captured.body.answers.find(a => a.id === textBlock.id);
  assert.ok(answer, 'setup failure: the text question was not in the collected answers');
  assert.equal(answer.choice, 'this is the reviewer\'s free-text answer', 'the typed text must reach the submit body unchanged');
  assert.equal(answer.status, 'answered');
});

check('comment mode off: pressing Send posts the currently-filled-in answers to the submit route, exactly as before', () => {
  const document = loadBoard();
  const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
  yes.dispatchEvent(new StandInEvent('click'));
  // The shared fixture's OTHER question (textBlock) also needs an answer: see
  // the identical note on the check just above -- the send guard arms on an
  // outstanding question rather than submitting, so the round is filled out
  // completely here too, leaving this check's own subject (does a plain click
  // still submit immediately once the round is complete) untouched.
  document.querySelector('textarea[data-answer-for="' + textBlock.id + '"]').value = 'a filled-in free-text answer';
  document.querySelector('textarea[data-answer-for="' + textBlock.id + '"]').dispatchEvent(new StandInEvent('input'));

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url, method: opts.method, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ board }) });
  };
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.disabled, false, 'setup failure: Send should not start disabled');
  try {
    sendBtn.dispatchEvent(new StandInEvent('click'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(captured, 'pressing Send must still call the submit route');
  assert.equal(captured.method, 'POST');
  assert.match(captured.url, /\/api\/board\/.+\/submit$/, `expected the submit route, got ${JSON.stringify(captured.url)}`);
  assert.equal(captured.body.action, 'send');
  assert.equal(captured.body.round, 1);
  const choiceAnswer = captured.body.answers.find(a => a.id === choiceBlock.id);
  assert.ok(choiceAnswer, 'the choice question must be in the collected answers');
  assert.equal(choiceAnswer.choice, 'Yes', 'the option chosen before Send must be what gets posted');
});

// --- src/ui.mjs's rank-list 'dragstart' guard: a standalone board, not the ----
// shared fixture above, since these two
// checks need to inspect the widget both with comment mode on and off, exactly
// the same reason loadSoloStageBoard is kept separate from `board`.

function loadSoloRankBoard() {
  const rankBoard = createBoard({
    title: 'Ticket 07 follow-up -- the dragstart guard, for real',
    blocks: [{ kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }] }],
  });
  const rankQid = rankBoard.blocks[0].id;
  const rankHtml = renderBoardPage(rankBoard);
  const document = parseHTML(rankHtml);
  const window = { addEventListener() {}, removeEventListener() {} };
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return { document, qid: rankQid };
}

check('comment mode off: a dragstart on a rank item proceeds normally -- the ordinary interaction is not stolen', () => {
  const { document } = loadSoloRankBoard();
  const li = document.querySelector('.rank-list li');
  assert.ok(li, 'setup failure: no rank-list item rendered');
  assert.equal(li.classList.contains('dragging'), false, 'setup failure: nothing should start mid-drag');

  li.dispatchEvent(new StandInEvent('dragstart'));

  assert.equal(li.classList.contains('dragging'), true,
    'with comment mode off, starting to drag a rank item must proceed exactly as it did before comment mode existed -- the drag must not be stolen');
});

check('comment mode on: a dragstart on a rank item is stood down by the SAME guard every other widget already proves (ablation: deleting "commentMode ||" from src/ui.mjs\'s rank-list dragstart handler)', () => {
  const { document } = loadSoloRankBoard();
  enableCommentMode(document);
  const li = document.querySelector('.rank-list li');
  assert.ok(li, 'setup failure: no rank-list item rendered');

  li.dispatchEvent(new StandInEvent('dragstart'));

  assert.equal(li.classList.contains('dragging'), false,
    'with comment mode on, a dragstart on a rank item must be stood down, exactly like choosing an option or pressing Defer -- a click mid-drag must anchor, not reorder');
});

// --- the hint carries both identity and containing context --------------------

check('the hint for a clicked element reads "<identity> in <context>": a "Send" button inside the compare\'s "After" html stage', () => {
  const document = loadBoard();
  // One gesture, toggle-gated everywhere (the user's later decision -- see the
  // "comment mode gates the hand-mocked stage too" section below): the stage
  // click needs comment mode on now, exactly like every other content kind.
  enableCommentMode(document);
  const frame = document.querySelectorAll('.html-stage')[0];
  assert.ok(frame, 'setup failure: no .html-stage iframe on the rendered page (the compare\'s "After" side)');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('click'));

  const rightBlockId = compareBlock.right.block.id;
  const form = document.getElementById('comment-form-' + rightBlockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: clicking the stage button did not open its comment form');
  const hint = form.getAttribute('data-anchor-label');
  // Both halves, not just non-empty: the element's own identity ("Send button")
  // AND its containing context ("After stage" -- this compare side's own label
  // plus the containing block's kind noun).
  assert.match(hint, /send/i, `expected the hint to name the clicked element, got ${JSON.stringify(hint)}`);
  assert.match(hint, /button/i, `expected the hint to carry the element's role, got ${JSON.stringify(hint)}`);
  assert.match(hint, /after/i, `expected the hint to carry the compare side's own label, got ${JSON.stringify(hint)}`);
  assert.match(hint, /stage/i, `expected the hint to carry the containing block's kind, got ${JSON.stringify(hint)}`);
  assert.equal(hint, 'Send button in After stage', `expected the exact "identity in context" hint, got ${JSON.stringify(hint)}`);
});

check('the plain html-stage hint is unchanged outside a compare (no context to add)', () => {
  // A trailing markdown block, same reasoning as loadSoloStageBoard above.
  const soloBoard = createBoard({
    title: 'Ticket 03 -- plain stage, no compare',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
      { kind: 'markdown', text: 'not a page board' },
    ],
  });
  const soloBlockId = soloBoard.blocks[0].id;
  const soloHtml = renderBoardPage(soloBoard);
  const document = parseHTML(soloHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);

  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + soloBlockId);
  assert.equal(form.getAttribute('data-anchor-label'), 'Send',
    'outside a compare, the hint must stay exactly the clicked element\'s own text, unchanged from before');
});

// --- one gesture, toggle-gated everywhere: the user's decision on the ---------
// hand-mocked stage -------------------------------------------------------------
//
// A later product decision, not a defect: this originally left the stage's
// click/hover always-on (the isolated mock has no ordinary interaction of its own
// to steal, so nothing required gating it). The user decided that was
// still two gestures on one page and asked for exactly one, toggle-gated
// everywhere -- so the stage now obeys `commentMode` exactly like the generic
// page listener. test/check-click.mjs and test/check-click-pin.mjs now turn
// comment mode on before driving the click and keep proving every assertion
// about what happens once it lands; the checks below cover the toggle itself.

check('comment mode off: clicking inside the hand-mocked stage opens no comment form', () => {
  const { document, blockId } = loadSoloStageBoard();
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), false,
    'with comment mode off, clicking an element inside the stage must not open a comment form -- the stage is no longer a standing exception');
});

check('comment mode off: hovering inside the hand-mocked stage adds no outline (an outline that leads nowhere is exactly the kind of affordance this rules out)', () => {
  const { document } = loadSoloStageBoard();
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('mouseover'));

  assert.equal(button.classList.contains('cb-anchor-hover'), false,
    'with comment mode off, hovering an element inside the stage must not mark it as the one that will be anchored');
});

check('comment mode on: hovering, then clicking, inside the hand-mocked stage still marks and anchors the element, exactly as before', () => {
  const { document, blockId } = loadSoloStageBoard();
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-hover'), true,
    'with comment mode on, hovering an element inside the stage must mark it as the one that will be anchored');

  button.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), true,
    'with comment mode on, clicking an element inside the stage must still open its comment form');
});

check('comment mode: turning it off mid-hover clears an already-applied stage hover outline, so nothing stays highlighted with no live gesture behind it', () => {
  const { document } = loadSoloStageBoard();
  const toggle = enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering did not mark the button');

  toggle.dispatchEvent(new StandInEvent('click')); // turn comment mode back off, without ever firing 'mouseout'

  assert.equal(button.classList.contains('cb-anchor-hover'), false,
    'turning comment mode off must clear an in-progress stage hover, not leave a highlighted element with no gesture behind it');
});

// =================================================================================
// Every ablation that was tried must fail a NAMED check. Each block below is
// written against, and verified red against, the specific line(s) that ablation
// touches. Grouped here (rather than a new file) because every one of
// these reuses loadBoard/enableCommentMode/loadSoloStageBoard, and every one of
// them is about the SAME thing this whole file is already about: driving the real
// client script, not the pieces underneath it.
// =================================================================================

// --- src/ui.mjs:627 -- document.body.classList.toggle('comment-mode', ...) ----

check('comment mode: turning it on adds body.comment-mode -- every CSS rule behind this (src/styles.mjs) keys off exactly this class, and the only checks that named it before asserted it absent (ablation: deleting the toggle() call)', () => {
  const document = loadBoard();
  assert.equal(document.body.classList.contains('comment-mode'), false, 'setup failure: body must not start with comment-mode');
  const toggle = enableCommentMode(document);
  assert.equal(document.body.classList.contains('comment-mode'), true,
    'turning comment mode on must add body.comment-mode');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(document.body.classList.contains('comment-mode'), false,
    'turning comment mode back off must remove body.comment-mode');
});

// --- src/ui.mjs:700 -- ev.preventDefault() in the generic click listener ------

// The target used to be a rendered markdown link, the most legible case of "an
// anchoring click must not ALSO do the element's own thing". ADR.md entry 28 left
// no anchorable link on any page, so the ablation is driven on the one target the
// generic gesture still has -- the assertion is on preventDefault itself, which is
// element-agnostic.
check('comment mode: an anchoring click calls ev.preventDefault(), so an element\'s own default action never fires alongside it mid-review (ablation: deleting ev.preventDefault())', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const note = errorNoteFor(document, diagramBlock.id);
  assert.ok(note, 'setup failure: no anchorable element found in the fixture');
  const event = new StandInEvent('click');
  note.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true,
    'the generic comment-mode click listener must call ev.preventDefault(), or a clicked <a href> fires its own navigation alongside anchoring');
});

// --- src/ui.mjs:679, :688, :435 -- three separate hover-clears ----------------

check('comment mode: hovering a second element (with no intervening mouseout) still clears the first element\'s highlight (ablation: deleting clearAnchorHover() at the top of the generic mouseover handler, src/ui.mjs:679)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const first = errorNoteFor(document, diagramBlock.id);
  const second = errorNoteFor(document, diagram2Block.id);
  assert.ok(first && second, 'setup failure: fixture elements not found');

  first.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(first.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering the first element did not mark it');

  second.dispatchEvent(new StandInEvent('mouseover')); // no mouseout on `first` first

  assert.equal(first.classList.contains('cb-anchor-hover'), false,
    'moving the hover to a second element must clear the first element\'s highlight, even with no intervening mouseout -- "that element, and not its ancestors" is the rule, and a highlight trailing behind on the PREVIOUS element also violates it');
  assert.equal(second.classList.contains('cb-anchor-hover'), true, 'the newly-hovered element must still be marked');
});

check('comment mode: a mouseout with no specific next target clears the currently hovered element\'s highlight (ablation: deleting the document mouseout listener\'s clearAnchorHover() call, src/ui.mjs:688)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const note = errorNoteFor(document, diagramBlock.id);
  assert.ok(note, 'setup failure: fixture element not found');

  note.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(note.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering did not mark the element');

  document.dispatchEvent(new StandInEvent('mouseout'));

  assert.equal(note.classList.contains('cb-anchor-hover'), false,
    'mousing out (the pointer leaving the page\'s anchorable content entirely) must clear the currently-hovered element\'s highlight');
});

check('comment mode: mousing out of a hovered element inside a hand-mocked stage clears its highlight too (ablation: deleting the stage\'s own doc.body mouseout listener, src/ui.mjs:435)', () => {
  const { document } = loadSoloStageBoard();
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering inside the stage did not mark the button');

  button.dispatchEvent(new StandInEvent('mouseout'));

  assert.equal(button.classList.contains('cb-anchor-hover'), false,
    'mousing out of an element inside the hand-mocked stage must clear its highlight -- this is the stage\'s OWN mouseout listener (a separate document from the page\'s), not the generic page-level one');
});

// --- src/ui.mjs's setCommentMode -- aria-pressed, .active, and the static label ---

check('comment mode: the toggle\'s aria-pressed attribute and .active class both agree with the ACTUAL state, in both directions (ablation: inverting either in setCommentMode)', () => {
  const document = loadBoard();
  const toggle = document.getElementById('comment-mode-toggle');
  const label = toggle.querySelector('.mode-toggle-label');
  assert.ok(label, 'setup failure: no .mode-toggle-label rendered');

  // On/off is carried by `.active` and `aria-pressed`
  // alone -- the label is the static word `Comment` and must never change,
  // in either direction, so a reader mid-toggle sees the control's own chrome
  // move rather than reading two different sentences.
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'setup failure: must start aria-pressed="false"');
  assert.equal(toggle.classList.contains('active'), false, 'setup failure: must start without .active');
  assert.equal(label.textContent, 'Comment', 'setup failure: the label must read the static word "Comment"');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'aria-pressed must read "true" once comment mode is actually ON');
  assert.equal(toggle.classList.contains('active'), true, '.active must be set once comment mode is actually ON');
  assert.equal(label.textContent, 'Comment', 'the label must not change when comment mode turns on -- state is carried by .active/aria-pressed, not by the words');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'aria-pressed must read "false" once comment mode is actually OFF');
  assert.equal(toggle.classList.contains('active'), false, '.active must be cleared once comment mode is actually OFF');
  assert.equal(label.textContent, 'Comment', 'the label must still read the static word "Comment" once comment mode is off again');
});

// --- ANCHOR_CHROME_SELECTOR: each entry, dropped individually -------------------

check('comment mode: clicking a block\'s own "comment" kicker chrome (not the button itself, which self-excludes via the anchorRootFor/el===root guard -- the surrounding .block-kicker div, which carries no data-block-id of its own) opens no comment form at all (ablation: dropping .block-kicker, .comment-btn from ANCHOR_CHROME_SELECTOR mints a dom anchor against it instead)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const btn = document.querySelector(`.comment-btn[data-block-id="${diagramBlock.id}"]`);
  assert.ok(btn, 'setup failure: no comment-btn for the diagram block');
  const kicker = btn.closest('.block-kicker');
  assert.ok(kicker, 'setup failure: the comment button is not inside a .block-kicker');

  kicker.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + diagramBlock.id);
  assert.equal(form.classList.contains('open'), false,
    'clicking the kicker chrome around the comment button (not the button itself) must not open any comment form -- with the kicker unexcluded, the generic listener mints a dom anchor against it instead, since the kicker itself carries no data-block-id to trip the self-guard the button has');
});

// Ablation note (per ADR "Commenting is confined to content blocks"):
// dropping `.compare-label` from ANCHOR_CHROME_SELECTOR used to be the thing
// that made this check fail -- .compare-label's nearest [data-block-id]
// ancestor is the compare block's own OUTER section (it sits inside
// .compare-side, which carries no data-block-id of its own), so an unexcluded
// click there minted a dom anchor against the compare block itself. That
// ablation is now dead: `isNonAnchorableRoot` (src/ui.mjs) excludes any click
// whose resolved root's own data-block-kind is `compare` (or `question`)
// regardless of ANCHOR_CHROME_SELECTOR, so a click on `.compare-label` still
// mints nothing even with the selector entry removed -- confirmed by actually
// running that ablation against this check: nothing in the
// suite goes red. Reported rather than silently dropped, exactly like the
// `.round-label` finding a few checks below (which was already dead for an
// unrelated reason -- anchorRootFor finding no block there at all). What IS
// checked below is the real, current, correct behaviour, proved the same way
// the wrapper-gating checks further down this file do: driving the gesture
// and checking the page as a whole, not a specific block's form (the compare
// block itself renders no comment-form any more either).
check('comment mode: clicking a compare side\'s own label opens no comment form anywhere on the page and mints no comment', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const label = document.querySelector('.compare-label');
  assert.ok(label, 'setup failure: no .compare-label rendered');

  label.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(label.classList.contains('cb-anchor-hover'), false,
    'hovering a compare side\'s label must show no hover affordance');

  label.dispatchEvent(new StandInEvent('click'));

  const anyOpen = document.querySelectorAll('.comment-form').some(f => f.classList.contains('open'));
  assert.equal(anyOpen, false,
    'clicking a compare side\'s label must not open any block\'s comment form');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0,
    'clicking a compare side\'s label must mint no comment at all');
});

// NOT independently observable through a click, and reported rather than papered
// over (a hard constraint): `.round-label` sits directly inside
// the round `<section class="round">`, which itself carries no `data-block-id` --
// nor does anything between it and `<body>`. `anchorRootFor` (`el.closest('[data-
// block-id]')`) therefore already returns null for a click anywhere on or inside
// it, and the generic listener's `if (!root || el === root) return;` guard bails
// out on that alone, BEFORE the chrome-exclusion question has any effect either
// way. Dropping `.round-label` from ANCHOR_CHROME_SELECTOR changes nothing this
// check (or any other) can observe -- confirmed by running the ablation: no check
// in the suite goes red from that one deletion in isolation. This is a genuine
// finding, not a gap in this check: `.round-label`'s membership in the selector is
// currently dead for the click-to-anchor gesture specifically (it may still do
// something for a future page-chrome click site anchorRootFor doesn't yet reach a
// block from) -- worth a product decision (prune it, or leave it as defence in
// depth), not something to fix here. What IS checked below is the actual current
// (correct) behaviour: clicking it opens nothing.
check('comment mode: clicking the round\'s own label opens no comment form anywhere on the page (current, correct behaviour -- see this file\'s own comment just above: dropping .round-label from ANCHOR_CHROME_SELECTOR alone is not observable through any click, because anchorRootFor already finds no block there)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const label = document.querySelector('.round-label');
  assert.ok(label, 'setup failure: no .round-label rendered');

  label.dispatchEvent(new StandInEvent('click'));

  const anyOpen = document.querySelectorAll('.comment-form').some(f => f.classList.contains('open'));
  assert.equal(anyOpen, false, 'clicking the round\'s own label must not open any block\'s comment form');
});

check('comment mode: clicking the html-stage iframe element itself (the outer-document frame, not a click inside its content) opens no page-scoped dom anchor against the block section (ablation: dropping pre.mermaid, .html-stage from ANCHOR_CHROME_SELECTOR)', () => {
  const { document, blockId } = loadSoloStageBoard();
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no iframe rendered');

  // Deliberately NOT loadSrcdoc()'d, and the click lands on the FRAME element in
  // the outer document -- not inside its (cross-document) content, which has its
  // own, separate, always-relevant click handling (wireHtmlStage).
  frame.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), false,
    'clicking the iframe element itself must not ALSO open a page-scoped dom-anchor form via the generic page-wide listener');
});

// --- the whole-block comment button ---------------------------------------------
//
// This section used to be about `.comment-btn[data-anchor-kind="md"]` -- the
// inline control injectAnchorButtons, since deleted with the kind, put after every markdown
// heading and list item, the ONLY producer of `md` anchors on the page, and the
// one anchor-minting path that never learned either of two rules
// (no findPendingCommentForAnchor lookup, no isSentAnchor
// gate, so a second click on a heading queued a second independent comment).
// ADR.md entry 28 deletes that control and the `md` anchor kind with it, and
// those two checks go with them -- the editing and sent-gate rules they covered
// still hold for the gestures that survive (`dom` and `mermaid`), which have
// their own checks in this file and in test/check-mermaid-anchor.mjs.
//
// What is left is the deliberate contrast: `commentButton` now emits exactly one
// shape, and it is ADDITIVE. "Several separate remarks on one block" stays legal,
// which is exactly why removePendingComment is keyed by entry id
// (src/anchor.mjs).

check('the whole-block "comment" button stays ADDITIVE -- several separate remarks on one block remain legal, which is why the edit rule is scoped to anchored kinds', () => {
  const document = loadBoard();
  const btn = document.querySelector(`.comment-btn[data-block-id="${diagramBlock.id}"]`);
  assert.ok(btn, 'setup failure: no comment button on the diagram block');
  assert.equal(btn.getAttribute('data-anchor-kind'), 'block', 'setup failure: expected the whole-block button');

  for (const text of ['first remark', 'second, unrelated remark']) {
    btn.dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + diagramBlock.id);
    assert.equal(form.getAttribute('data-editing-id'), null, 'a whole-block comment must never be treated as an edit of an earlier one');
    form.querySelector('input[type=text]').value = text;
    form.dispatchEvent(new StandInEvent('submit'));
  }

  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 2,
    'the whole-block gesture must still queue two independent comments');
});

// --- the delete control, driven rather than asserted into -----------------------
//
// Nothing exercised this gesture end to end: `.comment-delete` could be removed
// from renderPendingCommentItem entirely and the whole suite stayed green, which
// is how this only affordance came to have no behavioural cover at all.
// Driven here through the real listener, on three queued comments so the
// renumbering half ("the remaining provisional pins stay contiguous") is
// observable rather than merely claimed -- deleting the MIDDLE one is the case
// that distinguishes a real renumber from an append-only list.

check('a queued comment\'s delete control removes it, its pin, and renumbers everything after it', () => {
  const document = loadBoard();
  enableCommentMode(document);
  // Three queued comments: two dom-anchored on the first diagram's neighbouring
  // sections (so they draw pins), one whole-block on a THIRD block (so
  // renumbering is observed to cross block boundaries, which is exactly what the
  // shared sequence means).
  const targets = [errorNoteFor(document, diagramBlock.id), errorNoteFor(document, diagram2Block.id)];
  assert.ok(targets[0] && targets[1], 'setup failure: need two independent anchor targets');

  targets[0].dispatchEvent(new StandInEvent('click'));
  let form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-alpha';
  form.dispatchEvent(new StandInEvent('submit'));

  targets[1].dispatchEvent(new StandInEvent('click'));
  form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-beta';
  form.dispatchEvent(new StandInEvent('submit'));

  document.querySelector(`.comment-btn[data-block-id="${compareBlock.right.block.id}"][data-anchor-kind="block"]`).dispatchEvent(new StandInEvent('click'));
  form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-gamma';
  form.dispatchEvent(new StandInEvent('submit'));

  // Sorted, because entries live in their OWN block's list and document order
  // is therefore block order, not queue order -- what this promises is
  // that the numbers stay a contiguous 1..n run, not where they sit on the page.
  const numbers = () => document.querySelectorAll('.comment-item.comment-pending .comment-anchor')
    .map(el => Number(/#(\d+)/.exec(el.textContent)[1])).sort((a, b) => a - b);
  const itemFor = text => document.querySelectorAll('.comment-item.comment-pending')
    .find(i => String(i.textContent || '').includes(text));
  const numberOf = text => Number(/#(\d+)/.exec(itemFor(text).textContent)[1]);
  assert.deepEqual(numbers(), [1, 2, 3], 'setup failure: three queued comments must number 1, 2, 3');
  assert.equal(numberOf('remark-gamma'), 3, 'setup failure: the third comment queued must be numbered 3');
  assert.equal(document.querySelectorAll('.mermaid-block .anchor-pin.pin-pending').length, 2,
    'setup failure: the two dom-anchored comments must each have drawn a pin');

  // Delete the MIDDLE one (by queue number, not by document position -- entries
  // live in their own block's list), through its own control.
  const del = itemFor('remark-beta').querySelector('.comment-delete');
  assert.ok(del, 'every queued comment\'s list entry must carry a delete control');
  del.dispatchEvent(new StandInEvent('click'));

  const remaining = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(remaining.length, 2, `deleting one entry must leave two, got ${remaining.length}`);
  assert.equal(remaining.map(i => String(i.textContent || '')).join('').includes('remark-beta'), false,
    'the deleted comment\'s text must be gone from the page');
  assert.deepEqual(numbers(), [1, 2],
    'the remaining provisional numbers must stay contiguous after a deletion, with no gap where #2 was');
  assert.equal(numberOf('remark-gamma'), 2,
    'deleting #2 must renumber the comment that was #3 down to #2 -- and it lives on a DIFFERENT block, so the renumber has to be board-wide');
  assert.equal(document.querySelectorAll('.mermaid-block .anchor-pin.pin-pending').length, 1,
    'the deleted comment\'s hollow pin must be gone too, and the surviving one must remain');
});

check('an element carrying a SENT dom comment is not a comment target, and its neighbours still are', () => {
  // The generic comment-mode click listener's own isSentAnchor gate -- deleting
  // it left the whole suite green before this check existed. The ref is minted
  // by a REAL click first (never hardcoded), then sent, then the page reloaded
  // with that comment in board.comments, so this asserts against exactly the
  // anchor shape the gesture itself produces.
  const probe = loadBoard();
  enableCommentMode(probe);
  errorNoteFor(probe, diagramBlock.id).dispatchEvent(new StandInEvent('click'));
  const probeForm = probe.querySelector('.comment-form.open');
  const sentRef = probeForm.getAttribute('data-anchor-ref');
  const sentHint = probeForm.getAttribute('data-anchor-label');
  assert.ok(sentRef, 'setup failure: the probe click minted no ref');

  const sentBoard = createBoard({ title: 'Ticket 03 -- any element takes a comment', blocks: BLOCK_SPEC });
  const sentDiagramId = sentBoard.blocks[2].id;
  const liveDiagramId = sentBoard.blocks[3].id;
  applySubmit(sentBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId: sentDiagramId, anchor: { kind: 'dom', ref: sentRef, hint: sentHint }, text: 'already sent' }],
  }, 1);
  assert.equal(sentBoard.comments.length, 1, 'setup failure: the comment was not stored');

  const document = parseHTML(renderBoardPage(sentBoard));
  new Function('document', 'window', 'location', ui)(document, document.defaultView, { protocol: 'http:' });
  enableCommentMode(document);
  const sentNote = errorNoteFor(document, sentDiagramId);
  const liveNote = errorNoteFor(document, liveDiagramId);
  assert.ok(sentNote && liveNote, 'setup failure: both diagram sections must render a .resolve-error note');

  // Hover first: the rule is "visibly not a comment target" as well as inert.
  sentNote.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(sentNote.classList.contains('cb-anchor-sent'), true,
    'the element carrying a sent comment must be de-affordanced on hover, not marked as an ordinary target');
  assert.equal(sentNote.classList.contains('cb-anchor-hover'), false, 'and must not carry the ordinary outline as well');

  sentNote.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + sentDiagramId);
  assert.equal(form.classList.contains('open'), false, 'clicking it must do nothing');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queue nothing');

  // The negative: the neighbouring block's own note is still an ordinary target,
  // so this cannot pass against a listener that is simply dead.
  liveNote.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(liveNote.classList.contains('cb-anchor-hover'), true, 'a neighbouring element must still hover as a target');
  liveNote.dispatchEvent(new StandInEvent('click'));
  assert.equal(document.getElementById('comment-form-' + liveDiagramId).classList.contains('open'), true,
    'and must still open its own block\'s comment form when clicked');
});

// =================================================================================
// ADR "Commenting is confined to content blocks" (2026-08-01): `question` and
// `compare` render no content of their own -- a card around a widget, a grid
// around two nested blocks. With comment mode on, THEIR OWN surfaces must stop
// inviting a click or minting a comment: no hover affordance, no anchor. A block
// nested one level in -- a question's `context` entry, a compare side's content
// -- renders through the same renderBlock dispatch as every other block and
// keeps its own [data-block-id]/[data-block-kind], so it is judged on its OWN
// kind, before the wrapper is ever reached.
//
// ADR.md entry 28 is what decides that judgement now, and this is the
// claim these nested checks carry: an `html` stage and a `mermaid` diagram are
// commentable WHEREVER they appear, a question's context and a compare side
// included, while `markdown` and `code` are inert in exactly those same
// positions. Both directions are driven below, in the same document, so neither
// can pass by the gesture simply being dead.
//
// Driven the same way as the rest of this file: the real click/mouseover
// gesture through the real src/ui.mjs, never the gating logic underneath it.
// =================================================================================

const WRAPPER_BOARD = createBoard({
  title: 'Ticket 02 -- question/compare are wrappers, not content',
  blocks: [
    {
      kind: 'question',
      prompt: 'Pick a favorite',
      widget: 'single',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      // An html stage inside a question's `context`. Its own kind
      // is what decides, so it is exactly as commentable here as at the top
      // level. The markdown entry beside it is the contrast:
      // same slot, same wrapper, no affordance.
      context: [
        { kind: 'html', html: '<div class="mock"><button>Ship</button></div>' },
        // A diagram in the same slot. `mermaid` is not a "stage" for the
        // full-width rule (blockCarriesStage, src/render.mjs), so it only ever
        // reaches the prose context path alongside something that IS one -- which
        // makes this the case that would go unnoticed if the affordance were
        // restored for `html` alone.
        { kind: 'mermaid', source: { path: 'no-such-diagram-28e.mmd' } },
        { kind: 'markdown', text: 'Some supporting prose.' },
      ],
    },
    {
      kind: 'question',
      prompt: 'Order these',
      widget: 'rank',
      options: [{ label: 'First' }, { label: 'Second' }, { label: 'Third' }],
    },
    {
      kind: 'compare',
      // Another position for the same rule: a mermaid diagram in a compare side.
      left: { label: 'Left', block: { kind: 'mermaid', source: { path: 'no-such-diagram-28d.mmd' } } },
      right: { label: 'Right' }, // no `block` -- "a side that carries no content block"
    },
  ],
});
const [wrapperChoiceBlock, wrapperRankBlock, wrapperCompareBlock] = WRAPPER_BOARD.blocks;
const wrapperContextStage = wrapperChoiceBlock.context[0];
const wrapperContextDiagram = wrapperChoiceBlock.context[1];
const wrapperContextProse = wrapperChoiceBlock.context[2];
assert.equal(typeof wrapperContextDiagram.error, 'string',
  'setup failure: the context diagram must actually fail to resolve, or it renders no .resolve-error note to anchor against');
const wrapperCompareLeftBlock = wrapperCompareBlock.left.block;
assert.equal(typeof wrapperCompareLeftBlock.error, 'string',
  'setup failure: the compare side\'s diagram must actually fail to resolve, or it renders no .resolve-error note to anchor against');

/** Fresh document/window for WRAPPER_BOARD, same pattern as loadBoard() -- never
 * shared across checks. */
function loadWrapperBoard() {
  const document = parseHTML(renderBoardPage(WRAPPER_BOARD));
  const window = document.defaultView;
  new Function('document', 'window', 'location', ui)(document, window, { protocol: 'http:' });
  return document;
}

/** Hovers then clicks `el` in comment mode and asserts BOTH halves of "mints no
 * comment and shows no hover affordance": no cb-anchor-hover class from the
 * hover, and no comment minted from the click. Checked over the page as a
 * whole (no comment-form anywhere ends up open, no comment gets queued) rather
 * than by looking up a specific block's own comment-form element -- question
 * and compare blocks render none at all any more (ADR
 * "Commenting is confined to content blocks"), so a blockId-keyed lookup would
 * find null on exactly the wrapper surfaces this helper exists to check. */
function assertNotAnchorable(document, el, name) {
  assert.ok(el, `setup failure: could not find the fixture element for "${name}"`);

  el.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(el.classList.contains('cb-anchor-hover'), false,
    `hovering "${name}" in comment mode must show no hover affordance`);

  el.dispatchEvent(new StandInEvent('click'));
  const anyOpen = document.querySelectorAll('.comment-form').some(f => f.classList.contains('open'));
  assert.equal(anyOpen, false,
    `clicking "${name}" in comment mode must not open any comment form`);
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0,
    `clicking "${name}" in comment mode must mint no comment at all`);
}

// --- a question block's own surface: prompt, option card, note field, status --
// line, rank item, answer textarea (the six the ADR names by name) -------------

const QUESTION_WRAPPER_CASES = [
  { name: "a question's prompt", find: doc => doc.querySelector('.question-prompt') },
  {
    name: 'an option card',
    find: doc => doc.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Red') !== -1),
  },
  { name: 'the note field', find: doc => doc.querySelector('textarea[data-note-for]') },
  { name: 'the status line', find: doc => doc.querySelector('.answer-status') },
];

for (const c of QUESTION_WRAPPER_CASES) {
  check(`comment mode: clicking a question block's own ${c.name} mints no comment and shows no hover affordance`, () => {
    const document = loadWrapperBoard();
    enableCommentMode(document);
    assertNotAnchorable(document, c.find(document), c.name);
  });
}

check("comment mode: clicking a question block's own rank item mints no comment and shows no hover affordance", () => {
  const document = loadWrapperBoard();
  enableCommentMode(document);
  assertNotAnchorable(document, document.querySelector('.rank-list li'), 'a rank item');
});

check("comment mode: clicking a question block's own answer textarea mints no comment and shows no hover affordance", () => {
  const document = loadBoard(); // the shared fixture's text-widget question
  enableCommentMode(document);
  const textarea = document.querySelector('textarea[data-answer-for="' + textBlock.id + '"]');
  assertNotAnchorable(document, textarea, 'the answer textarea');
});

// --- a compare block's own wrapper: kicker, grid, a side's label, a side with --
// no content block --------------------------------------------------------------

const COMPARE_WRAPPER_CASES = [
  { name: 'the kicker', find: doc => doc.querySelectorAll('.compare-block .block-kicker')[0] },
  { name: 'the grid', find: doc => doc.querySelector('.compare-grid') },
  { name: "a side's label", find: doc => doc.querySelectorAll('.compare-label')[0] },
  { name: 'a side that carries no content block', find: doc => doc.querySelectorAll('.compare-side .unsupported-widget')[0] },
];

for (const c of COMPARE_WRAPPER_CASES) {
  check(`comment mode: clicking a compare block's own ${c.name} mints no comment and shows no hover affordance`, () => {
    const document = loadWrapperBoard();
    enableCommentMode(document);
    assertNotAnchorable(document, c.find(document), c.name);
  });
}

// --- nested blocks stay fully live one level in --------------------------------

check("an html stage nested inside a question's context is commentable exactly as it is anywhere else, even though the question's own prompt (a sibling in the same section) is not", () => {
  const document = loadWrapperBoard();
  enableCommentMode(document);

  // Looked up by block id, never by a wrapper class: a question's context is
  // being re-laid-out in a sibling change, and this check is about the comment
  // rule, not about where the context sits on the page.
  const stageSection = document.querySelector(`[data-block-id="${wrapperContextStage.id}"]`);
  assert.ok(stageSection, "setup failure: the question's context stage did not render");
  const frame = stageSection.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: the nested html block rendered no stage iframe');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-hover'), true,
    "an html stage inside a question's context must show the ordinary hover affordance -- position is not part of the rule");

  button.dispatchEvent(new StandInEvent('click'));
  const nestedForm = document.getElementById('comment-form-' + wrapperContextStage.id);
  assert.ok(nestedForm, "setup failure: the question's own context stage must render its own comment form");
  assert.equal(nestedForm.classList.contains('open'), true,
    "clicking inside a question's context stage must mint a comment against that NESTED block's own id");
  assert.equal(nestedForm.getAttribute('data-anchor-kind'), 'dom');
  assert.ok(String(nestedForm.getAttribute('data-anchor-label') || '').indexOf('Ship') !== -1,
    'and carry a hint naming what was clicked');

  // Same slot: the markdown entry beside it carries no affordance
  // at all, and the wrapper's own prompt is inert -- in the SAME document, in the
  // same click sequence, so neither result can be "the gesture is dead".
  assert.equal(document.getElementById('comment-form-' + wrapperContextProse.id), null,
    "a markdown block in a question's context must render no comment form");
  const contextParagraph = document.querySelectorAll('.md-content p')
    .find(el => el.textContent.indexOf('supporting prose') !== -1);
  assert.ok(contextParagraph, 'setup failure: the context prose did not render');
  contextParagraph.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(contextParagraph.classList.contains('cb-anchor-hover'), false,
    "a markdown block in a question's context must show no hover affordance");

  const prompt = document.querySelector('.question-prompt');
  prompt.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(prompt.classList.contains('cb-anchor-hover'), false,
    "the question's own prompt must show no hover affordance, in the same document where its context stage just did");
  prompt.dispatchEvent(new StandInEvent('click'));
  const openForms = document.querySelectorAll('.comment-form.open');
  assert.equal(openForms.length, 1,
    "clicking the question's own prompt, or its markdown context, must not open any additional comment form");
  assert.equal(openForms[0].id, nestedForm.id,
    "the only open form afterward must still be the nested stage's own");
});

check("a mermaid diagram in the SAME prose context keeps its affordance too -- the prose path is a layout, not a second comment rule", () => {
  const document = loadWrapperBoard();
  enableCommentMode(document);

  const section = document.querySelector(`[data-block-id="${wrapperContextDiagram.id}"]`);
  assert.ok(section, "setup failure: the question's context diagram did not render");
  const note = section.querySelector('.resolve-error');
  assert.ok(note, 'setup failure: no .resolve-error note in the context diagram');

  // The whole-block button first: the affordance is there at all.
  const btn = section.querySelector('.comment-btn');
  assert.ok(btn, 'a mermaid diagram in a question\'s context must render its comment button');

  note.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(note.classList.contains('cb-anchor-hover'), true,
    'a mermaid diagram in a question\'s context must show the ordinary hover affordance');

  note.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + wrapperContextDiagram.id);
  assert.ok(form, "setup failure: the context diagram must render its own comment form");
  assert.equal(form.classList.contains('open'), true, 'clicking it must mint a comment against that nested block');
  assert.equal(form.getAttribute('data-anchor-kind'), 'dom');

  // ...and the pin actually lands, in that item's own layer -- the half a
  // markup-only check cannot see (an anchorable surface with no
  // layer to draw into resolves to a comment with no pin anywhere on the page).
  const layer = Array.prototype.slice.call(section.children).find(c => c.classList && c.classList.contains('pin-layer'));
  assert.ok(layer, 'a mermaid context item must carry a page-scoped pin-layer of its own');
  form.querySelector('input[type=text]').value = 'this diagram never loaded';
  form.dispatchEvent(new StandInEvent('submit'));
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin in the context diagram's own layer, got ${pins.length}`);
});

check("a mermaid diagram nested inside a compare side is commentable exactly as it is anywhere else, even though the compare's own kicker/grid (a sibling in the same section) is not", () => {
  const document = loadWrapperBoard();
  enableCommentMode(document);

  const sideNote = document.querySelector(`[data-block-id="${wrapperCompareLeftBlock.id}"] .resolve-error`);
  assert.ok(sideNote, "setup failure: no anchorable element found inside the compare side's nested diagram");

  sideNote.dispatchEvent(new StandInEvent('click'));
  const nestedForm = document.getElementById('comment-form-' + wrapperCompareLeftBlock.id);
  assert.ok(nestedForm, "setup failure: the compare side's own nested diagram must render its own comment form");
  assert.equal(nestedForm.classList.contains('open'), true,
    "clicking inside a compare side's own diagram must mint a comment against that NESTED block's own id");

  // The compare wrapper renders no comment-form of its own at all any more
  // (ADR.md entry 28), so this is checked the same way the wrapper-gating
  // checks above do: no hover affordance, and no ADDITIONAL open form/queued
  // comment appears anywhere on the page beyond the nested one that already
  // opened -- proving the grid's click did nothing, not that a particular
  // element is missing.
  const grid = document.querySelector('.compare-grid');
  grid.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(grid.classList.contains('cb-anchor-hover'), false,
    "the compare block's own grid must show no hover affordance, in the same document where its left side just did");
  grid.dispatchEvent(new StandInEvent('click'));
  const openForms = document.querySelectorAll('.comment-form.open');
  assert.equal(openForms.length, 1,
    "clicking the compare block's own grid must not open any additional comment form");
  assert.equal(openForms[0].id, nestedForm.id,
    "the only open form afterward must still be the compare side's own nested block -- the grid minted nothing");
});

// --- a round of only question blocks: no anchorable content anywhere, but -----
// answering and sending it (and toggling comment mode itself) behave exactly as
// before -----------------------------------------------------------------------

check('a round with only question blocks: the comment-mode toggle still renders and still toggles, and answering/sending behaves exactly as before', () => {
  const onlyQuestionsBoard = createBoard({
    title: 'Ticket 02 -- an all-question round',
    blocks: [
      { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
      { kind: 'question', prompt: 'Say something', widget: 'text', options: [] },
    ],
  });
  const [qChoice, qText] = onlyQuestionsBoard.blocks;
  const document = parseHTML(renderBoardPage(onlyQuestionsBoard));
  const window = document.defaultView;
  new Function('document', 'window', 'location', ui)(document, window, { protocol: 'http:' });

  // The toggle is page-global chrome, never conditional on what the board can
  // anchor -- it must render and flip both ways even here.
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'the comment-mode toggle must render even on a board with no anchorable content');
  enableCommentMode(document); // asserts inside the helper that clicking it actually turns comment mode on
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), false,
    'the toggle must still turn back off on a board with no anchorable content');

  // Answering and sending proceed exactly as they did before.
  const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
  yes.dispatchEvent(new StandInEvent('click'));
  assert.equal(yes.classList.contains('selected'), true, 'choosing an option must still work on an all-question board');

  const textarea = document.querySelector('textarea[data-answer-for="' + qText.id + '"]');
  textarea.value = 'a free-text answer';
  textarea.dispatchEvent(new StandInEvent('input'));

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url, method: opts.method, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ board: onlyQuestionsBoard }) });
  };
  try {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'pressing Send must still call the submit route on an all-question board');
  assert.equal(captured.method, 'POST');
  assert.match(captured.url, /\/api\/board\/.+\/submit$/);
  assert.equal(captured.body.action, 'send');
  const choiceAnswer = captured.body.answers.find(a => a.id === qChoice.id);
  assert.ok(choiceAnswer, 'the choice question must be in the collected answers');
  assert.equal(choiceAnswer.choice, 'Yes');
  const textAnswer = captured.body.answers.find(a => a.id === qText.id);
  assert.ok(textAnswer, 'the text question must be in the collected answers');
  assert.equal(textAnswer.choice, 'a free-text answer');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall comment-mode checks ok');
