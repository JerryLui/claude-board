// Ticket 03 (DESIGN.md): comment mode, and one anchoring model over the
// board's own rendered DOM. Extends the end-to-end DOM stand-in seam ticket 01
// built and ticket 02 turned green (test/dom-stand-in.mjs, test/check-click.mjs,
// test/check-click-pin.mjs) rather than adding another unit check over the pure
// module -- the whole point of this repo's testing strategy is that a check over
// src/anchor.mjs alone cannot see whether a listener is actually attached to a
// live document (see DESIGN.md Decisions -> "Criterion 8 runs in a DOM
// stand-in", and its own Testing section).
//
// Covers, against the REAL src/ui.mjs client script run in the stand-in:
//   - criterion 1 (partial): one content kind per acceptance-criterion example --
//     prose, a list item, a table cell, a line of a code reference, one side of a
//     comparison, a question's own widget -- each clicked in comment mode, each
//     opening its block's comment form with a `dom` reference and a hint naming
//     it. Table-driven, over the SAME rendered board, rather than six near-copies
//     of check-click.mjs.
//   - criterion 2: with comment mode on, hovering marks the exact element under
//     the cursor and never an ancestor.
//   - criterion 3: with comment mode OFF (the default -- these checks never touch
//     the toggle), the ordinary interactions the spec names by name still work:
//     choosing a single-select option, typing into a text answer, and pressing
//     Send (a stubbed global `fetch` captures what actually got posted, so this
//     is a real assertion on the collected answers, not just "it didn't throw").
//     Drag-to-rank and text-selection are the two interactions this repo's own
//     testing docs already carve out as not automatable in a headless DOM
//     (DESIGN.md Testing) -- see this file's own note further down for
//     exactly what is and isn't covered here for that reason.
//   - criterion 6: the hint for a clicked element names both its own identity and
//     its containing context -- the concrete "Send button in the after stage"
//     case from the ticket, via the html-stage's click gesture and a compare
//     block's two sides.
//   - one gesture, toggle-gated everywhere: a later product decision (not a
//     defect -- see this file's own section further down) retired the hand-
//     mocked stage's original always-on click/hover as a standing exception.
//     With comment mode off, clicking inside a stage now does nothing and no
//     hover outline appears; with it on, the stage behaves exactly as ticket 02
//     left it. test/check-click.mjs and test/check-click-pin.mjs cover "what
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

// One board fixture covering every content kind criterion 1 asks for, short of
// the diagram node (ticket 05) and the hand-mocked stage on its own (already
// covered end to end by test/check-click.mjs / test/check-click-pin.mjs -- this
// file's own criterion-6 check below still exercises it, inside a compare side).
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
    {
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'markdown', text: 'the old copy, unchanged' } },
      right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Send</button></div>' } },
    },
    { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  { kind: 'question', prompt: 'Explain', widget: 'text', options: [] },
];
const board = createBoard({ title: 'Ticket 03 -- any element takes a comment', blocks: BLOCK_SPEC });
const [mdBlock, codeBlock, compareBlock, choiceBlock, textBlock] = board.blocks;
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
 * actually has (criterion 2: discoverable, visible chrome). */
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
  const soloBoard = createBoard({
    title: 'Ticket 03 -- comment mode gates the stage too',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
  });
  const soloBlockId = soloBoard.blocks[0].id;
  const soloHtml = renderBoardPage(soloBoard);
  const document = parseHTML(soloHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return { document, blockId: soloBlockId };
}

// --- criterion 1 (partial): one content kind per acceptance-criterion example --

const KIND_CASES = [
  {
    name: 'prose',
    blockId: mdBlock.id,
    find: doc => doc.querySelectorAll('.md-content p')
      .find(el => el.textContent.indexOf('paragraph of prose') !== -1),
    hintIncludes: ['paragraph of prose'],
  },
  {
    name: 'a list item',
    blockId: mdBlock.id,
    find: doc => doc.querySelectorAll('.md-content li')
      .find(el => el.textContent.trim() === 'alpha item'),
    hintIncludes: ['alpha item'],
  },
  {
    name: 'a table cell',
    blockId: mdBlock.id,
    find: doc => doc.querySelectorAll('.md-content td')
      .find(el => el.textContent.trim() === '42'),
    hintIncludes: ['42'],
  },
  {
    name: 'a line of a code reference',
    blockId: codeBlock.id,
    find: doc => doc.querySelectorAll('.code-line')
      .find(el => el.textContent.trim() === 'const y = 2;'),
    hintIncludes: ['const y = 2;'],
  },
  {
    name: 'one side of a comparison',
    blockId: compareBlock.left.block.id,
    find: doc => doc.querySelectorAll('.compare-side .md-content p')
      .find(el => el.textContent.indexOf('old copy') !== -1),
    // Inside a compare side, the hint also carries context (criterion 6) -- "the
    // old copy" identity, "Before block" context (this side's own label plus the
    // nested block's kind noun -- see src/anchor.mjs's design comment).
    hintIncludes: ['old copy', 'before', 'block'],
  },
  {
    name: "a question's own widget",
    blockId: choiceBlock.id,
    find: doc => doc.querySelectorAll('.choice-single')
      .find(el => el.textContent.indexOf('Yes') !== -1),
    hintIncludes: ['yes'],
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

check('comment mode: a numbered pin lands on the anchored element once the opened form is submitted, same as the html-stage gesture', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const el = document.querySelectorAll('.md-content p').find(e => e.textContent.indexOf('paragraph of prose') !== -1);
  el.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + mdBlock.id);
  const section = document.querySelectorAll('.markdown-block')[0];
  const layer = section.children.find(c => c.classList && c.classList.contains('pin-layer'));
  assert.ok(layer, 'setup failure: the markdown block has no page-scoped pin-layer');
  assert.equal(layer.querySelectorAll('.anchor-pin').length, 0, 'setup failure: a pin already exists before anything was queued');

  const input = form.querySelector('input[type=text]');
  input.value = 'needs a citation';
  form.dispatchEvent(new StandInEvent('submit'));

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin after queueing one comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'a freshly-queued comment must not render as lost');
});

// --- criterion 2: hovering marks exactly the hovered element ------------------

check('comment mode: hovering marks the exact (innermost) hovered element, never an ancestor', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const strong = document.querySelectorAll('.md-content strong').find(el => el.textContent === 'bold text');
  assert.ok(strong, 'setup failure: no <strong> in the fixture markdown');
  const p = strong.parentElement;
  assert.ok(p, 'setup failure: the <strong> has no parent paragraph');

  strong.dispatchEvent(new StandInEvent('mouseover'));

  assert.equal(strong.classList.contains('cb-anchor-hover'), true,
    'the exact hovered element must be marked as the one that will be anchored');
  assert.equal(p.classList.contains('cb-anchor-hover'), false,
    'the hovered element\'s ancestor must NOT also be marked -- hovering must name one element, not a chain');
});

check('comment mode off: hovering marks nothing at all (the affordance itself is part of the explicit mode, not ambient)', () => {
  const document = loadBoard(); // comment mode never enabled here
  const strong = document.querySelectorAll('.md-content strong').find(el => el.textContent === 'bold text');
  strong.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(strong.classList.contains('cb-anchor-hover'), false, 'hovering must do nothing while comment mode is off');
});

// --- criterion 3: comment mode OFF (never touched below) never steals an ------
// ordinary interaction. Driven end to end through the real client script, not
// argued -- DESIGN.md's own Testing section and this ticket's
// instructions both call out that an untested claim here is exactly how this
// spec's own defect shipped twice.
//
// NOT covered here, named rather than silently skipped: text selection, and the
// full drop-and-reorder gesture. test/dom-stand-in.mjs's own file comment states
// it implements no selection API at all, and 'dragover' (where the actual
// reordering happens, driven by a live pointer position) is not modelled either --
// both are pre-existing, documented ceilings of this stand-in, not new gaps this
// file introduces. DESIGN.md's Testing section already carves the FULL
// drag-and-drop gesture out as unautomatable without a real browser for that
// reason.
//
// Ticket 07 follow-up (DESIGN.md, audit finding C5): what IS reachable,
// and IS covered a few checks below, is the one thing criterion 3 actually turns
// on for this widget -- the 'dragstart' handler's own `commentMode ||` guard
// (src/ui.mjs). This comment used to claim that coverage existed here without any
// check ever dispatching a 'dragstart'; the audit caught that as the exact
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
  const form = document.getElementById('comment-form-' + choiceBlock.id);
  assert.equal(form.classList.contains('open'), false, 'choosing an option must not open a comment form when comment mode is off');
});

check('comment mode off: typing into a text-answer widget still records the text', () => {
  const document = loadBoard();
  const textarea = document.querySelector('textarea[data-answer-for="' + textBlock.id + '"]');
  assert.ok(textarea, 'setup failure: no text-answer textarea rendered for the text-widget question');
  textarea.value = 'this is the reviewer\'s free-text answer';
  textarea.dispatchEvent(new StandInEvent('input'));

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

check('comment mode off: pressing Send posts the currently-filled-in answers to the submit route, exactly as before this ticket', () => {
  const document = loadBoard();
  const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
  yes.dispatchEvent(new StandInEvent('click'));

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

// --- src/ui.mjs's rank-list 'dragstart' guard (ticket 07 follow-up, audit -----
// finding C5): a standalone board, not the shared fixture above, since these two
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

// --- criterion 6: the hint carries both identity and containing context -------

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

check('ticket 02\'s plain html-stage hint is unchanged outside a compare (no context to add)', () => {
  const soloBoard = createBoard({
    title: 'Ticket 03 -- plain stage, no compare',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
    'outside a compare, the hint must stay exactly the clicked element\'s own text, unchanged from ticket 02');
});

// --- one gesture, toggle-gated everywhere: the user's decision on the ---------
// hand-mocked stage -------------------------------------------------------------
//
// A later product decision, not a defect: ticket 03 originally left the stage's
// click/hover always-on (the isolated mock has no ordinary interaction of its own
// to steal, so criterion 3 never required gating it). The user decided that was
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

check('comment mode off: hovering inside the hand-mocked stage adds no outline (an outline that leads nowhere is exactly what criterion 2 rules out)', () => {
  const { document } = loadSoloStageBoard();
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  button.dispatchEvent(new StandInEvent('mouseover'));

  assert.equal(button.classList.contains('cb-anchor-hover'), false,
    'with comment mode off, hovering an element inside the stage must not mark it as the one that will be anchored');
});

check('comment mode on: hovering, then clicking, inside the hand-mocked stage still marks and anchors the element, exactly as ticket 02 left it', () => {
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
// Ticket 07 (DESIGN.md): every ablation in the audit's V1 table must fail
// a NAMED check. Each block below is written against, and verified red against,
// the specific line(s) the audit names -- see this ticket's own log/report for the
// ablation output. Grouped here (rather than a new file) because every one of
// these reuses loadBoard/enableCommentMode/loadSoloStageBoard, and every one of
// them is about the SAME thing this whole file is already about: driving the real
// client script, not the pieces underneath it.
// =================================================================================

// --- src/ui.mjs:627 -- document.body.classList.toggle('comment-mode', ...) ----

check('comment mode: turning it on adds body.comment-mode -- every CSS rule behind criterion 2 (src/styles.mjs) keys off exactly this class, and the only checks that named it before ticket 07 asserted it absent (ablation: deleting the toggle() call)', () => {
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

check('comment mode: clicking a rendered link calls ev.preventDefault(), so it never navigates away mid-review (ablation: deleting ev.preventDefault())', () => {
  const linkBoard = createBoard({
    title: 'Ticket 07 -- preventDefault on an anchored click',
    blocks: [{ kind: 'markdown', text: 'a paragraph with a [link](https://example.com/) inside' }],
  });
  const linkHtml = renderBoardPage(linkBoard);
  const document = parseHTML(linkHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  enableCommentMode(document);

  const link = document.querySelectorAll('.md-content a').find(a => a.textContent === 'link');
  assert.ok(link, 'setup failure: no rendered link found in the markdown fixture');
  const event = new StandInEvent('click');
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true,
    'the generic comment-mode click listener must call ev.preventDefault(), or a clicked <a href> fires its own navigation alongside anchoring');
});

// --- src/ui.mjs:679, :688, :435 -- three separate hover-clears ----------------

check('comment mode: hovering a second element (with no intervening mouseout) still clears the first element\'s highlight (ablation: deleting clearAnchorHover() at the top of the generic mouseover handler, src/ui.mjs:679)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const prose = document.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1);
  const codeLine = document.querySelectorAll('.code-line').find(el => el.textContent.trim() === 'const y = 2;');
  assert.ok(prose && codeLine, 'setup failure: fixture elements not found');

  prose.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(prose.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering the first element did not mark it');

  codeLine.dispatchEvent(new StandInEvent('mouseover')); // no mouseout on `prose` first

  assert.equal(prose.classList.contains('cb-anchor-hover'), false,
    'moving the hover to a second element must clear the first element\'s highlight, even with no intervening mouseout -- criterion 2 names "that element, and not its ancestors", which a highlight trailing behind on the PREVIOUS element also violates');
  assert.equal(codeLine.classList.contains('cb-anchor-hover'), true, 'the newly-hovered element must still be marked');
});

check('comment mode: a mouseout with no specific next target clears the currently hovered element\'s highlight (ablation: deleting the document mouseout listener\'s clearAnchorHover() call, src/ui.mjs:688)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const prose = document.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1);
  assert.ok(prose, 'setup failure: fixture element not found');

  prose.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(prose.classList.contains('cb-anchor-hover'), true, 'setup failure: hovering did not mark the element');

  document.dispatchEvent(new StandInEvent('mouseout'));

  assert.equal(prose.classList.contains('cb-anchor-hover'), false,
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

// --- src/ui.mjs:623-625 -- aria-pressed and the visible label -----------------

check('comment mode: the toggle\'s aria-pressed attribute and visible label both agree with the ACTUAL state, in both directions (ablation: inverting either at src/ui.mjs:623-625)', () => {
  const document = loadBoard();
  const toggle = document.getElementById('comment-mode-toggle');
  const label = toggle.querySelector('.mode-toggle-label');
  assert.ok(label, 'setup failure: no .mode-toggle-label rendered');

  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'setup failure: must start aria-pressed="false"');
  assert.equal(label.textContent, 'Comment mode: off', 'setup failure: must start reading "off"');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'aria-pressed must read "true" once comment mode is actually ON');
  assert.equal(label.textContent, 'Comment mode: on', 'the visible label must read "on" once comment mode is actually ON -- an inverted label reads "off" while a click anchors, which criterion 2\'s "unambiguous" rules out');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'aria-pressed must read "false" once comment mode is actually OFF');
  assert.equal(label.textContent, 'Comment mode: off', 'the visible label must read "off" once comment mode is actually OFF');
});

// --- ANCHOR_CHROME_SELECTOR: each entry the audit named, dropped individually --

check('comment mode: clicking a block\'s own "comment" kicker chrome (not the button itself, which self-excludes via the anchorRootFor/el===root guard -- the surrounding .block-kicker div, which carries no data-block-id of its own) opens no comment form at all (ablation: dropping .block-kicker, .comment-btn from ANCHOR_CHROME_SELECTOR mints a dom anchor against it instead)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const btn = document.querySelector(`.comment-btn[data-block-id="${mdBlock.id}"]`);
  assert.ok(btn, 'setup failure: no comment-btn for the markdown block');
  const kicker = btn.closest('.block-kicker');
  assert.ok(kicker, 'setup failure: the comment button is not inside a .block-kicker');

  kicker.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + mdBlock.id);
  assert.equal(form.classList.contains('open'), false,
    'clicking the kicker chrome around the comment button (not the button itself) must not open any comment form -- with the kicker unexcluded, the generic listener mints a dom anchor against it instead, since the kicker itself carries no data-block-id to trip the self-guard the button has');
});

check('comment mode: clicking a compare side\'s own label opens no comment form -- it is structural chrome, not authored content. Its nearest [data-block-id] ancestor is the COMPARE block\'s own section (not either side\'s nested block), so an ablated selector mints a dom anchor there (ablation: dropping .compare-label from ANCHOR_CHROME_SELECTOR)', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const label = document.querySelector('.compare-label');
  assert.ok(label, 'setup failure: no .compare-label rendered');

  label.dispatchEvent(new StandInEvent('click'));

  const compareForm = document.getElementById('comment-form-' + compareBlock.id);
  const leftForm = document.getElementById('comment-form-' + compareBlock.left.block.id);
  const rightForm = document.getElementById('comment-form-' + compareBlock.right.block.id);
  assert.equal(compareForm.classList.contains('open'), false,
    'clicking a compare side\'s label must not open the outer compare block\'s own comment form -- .compare-label\'s nearest [data-block-id] ancestor is the compare block\'s SECTION, not either side, so this (not the side forms) is where an unexcluded click would mint a dom anchor');
  assert.equal(leftForm.classList.contains('open'), false);
  assert.equal(rightForm.classList.contains('open'), false);
});

// NOT independently observable through a click, and reported rather than papered
// over (this ticket's own hard constraint): `.round-label` sits directly inside
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

// --- the markdown anchor button (DESIGN.md polish criteria 1 and 12) -----------
//
// `.comment-btn[data-anchor-kind="md"]` -- the inline control injectAnchorButtons
// (src/render.mjs) puts after every markdown heading and list item -- is the ONLY
// producer of `md` anchors on the page, and it was the one anchor-minting path
// that never learned either of ticket 02's two rules (audit findings P1/P2): its
// handler called openCommentForm with four arguments, with no
// findPendingCommentForAnchor lookup and no isSentAnchor gate. So a second click
// on a heading queued a SECOND independent comment with a second pin, which is
// verbatim the Problem statement this batch exists to fix and is the alternative
// the spec's Decisions explicitly reject; and a heading carrying a SENT comment
// kept a live, unmarked control. Every other gesture (the generic dom click, the
// diagram node, the lens) was already covered; these close the last one.
//
// The `block`-kind button on the same page is checked alongside, because the
// distinction is deliberate rather than incidental: "several separate remarks on
// one block" stays legal, which is exactly why removePendingComment is keyed by
// entry id (src/anchor.mjs). A fix that made every .comment-btn edit would break
// that, and nothing else would notice.

/** The md-kind anchor button for `ref` (a heading/list-item id) on `mdBlock`. */
function mdAnchorButton(document, ref) {
  const btn = document.querySelectorAll(`.comment-btn[data-anchor-kind="md"][data-block-id="${mdBlock.id}"]`)
    .find(b => b.getAttribute('data-anchor-ref') === ref);
  assert.ok(btn, `setup failure: no md anchor button for ref ${JSON.stringify(ref)}`);
  return btn;
}

/** Every md ref the page actually rendered an anchor button for. */
function mdRefs(document) {
  return document.querySelectorAll(`.comment-btn[data-anchor-kind="md"][data-block-id="${mdBlock.id}"]`)
    .map(b => b.getAttribute('data-anchor-ref'));
}

check('criterion 1 (md): clicking a heading\'s anchor button twice reopens the comment already on it -- prefilled, stamped as an edit -- instead of queuing a second one', () => {
  const document = loadBoard();
  const refs = mdRefs(document);
  assert.ok(refs.length, 'setup failure: the markdown block rendered no anchor buttons at all');
  const ref = refs[0];

  mdAnchorButton(document, ref).dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + mdBlock.id);
  assert.equal(form.classList.contains('open'), true, 'setup failure: the first click did not open the form');
  assert.equal(form.getAttribute('data-editing-id'), null, 'a FIRST click has nothing to edit');
  form.querySelector('input[type=text]').value = 'the heading is wrong';
  form.dispatchEvent(new StandInEvent('submit'));

  const pinsAfterFirst = document.querySelectorAll('.anchor-pin').length;
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1);

  mdAnchorButton(document, ref).dispatchEvent(new StandInEvent('click'));
  const reopened = document.getElementById('comment-form-' + mdBlock.id);
  assert.ok(reopened.getAttribute('data-editing-id'),
    'the reopened form must be stamped with the queued entry it is editing -- without it, submit pushes a duplicate');
  assert.equal(reopened.querySelector('input[type=text]').value, 'the heading is wrong',
    'and prefilled with that comment\'s own text (criterion 1, verbatim)');

  reopened.querySelector('input[type=text]').value = 'the heading is fine, the table is wrong';
  reopened.dispatchEvent(new StandInEvent('submit'));

  const items = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(items.length, 1, `submitting must REPLACE, not add -- got ${items.length} queued comments`);
  assert.ok(String(items[0].textContent || '').indexOf('the table is wrong') !== -1, 'and carry the edited text');
  assert.equal(document.querySelectorAll('.anchor-pin').length, pinsAfterFirst,
    'criterion 1: "the pin count on the block does not change"');
});

check('criterion 1 (md): two DIFFERENT headings still get their own comments -- the edit rule keys on the anchor, not on the block', () => {
  const document = loadBoard();
  const refs = mdRefs(document);
  assert.ok(refs.length >= 2, `setup failure: need at least two anchored elements, got ${refs.length}`);

  for (const ref of [refs[0], refs[1]]) {
    mdAnchorButton(document, ref).dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + mdBlock.id);
    assert.equal(form.getAttribute('data-editing-id'), null, `a first click on ${ref} must not inherit the previous anchor's edit target`);
    form.querySelector('input[type=text]').value = 'about ' + ref;
    form.dispatchEvent(new StandInEvent('submit'));
  }

  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 2,
    'two distinct anchors are two distinct comments');
});

check('the whole-block "comment" button stays ADDITIVE -- several separate remarks on one block remain legal, which is why the edit rule is scoped to anchored kinds', () => {
  const document = loadBoard();
  const btn = document.querySelector(`.comment-btn[data-block-id="${codeBlock.id}"]`);
  assert.ok(btn, 'setup failure: no comment button on the code block');
  assert.equal(btn.getAttribute('data-anchor-kind'), 'block', 'setup failure: expected the whole-block button');

  for (const text of ['first remark', 'second, unrelated remark']) {
    btn.dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + codeBlock.id);
    assert.equal(form.getAttribute('data-editing-id'), null, 'a whole-block comment must never be treated as an edit of an earlier one');
    form.querySelector('input[type=text]').value = text;
    form.dispatchEvent(new StandInEvent('submit'));
  }

  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 2,
    'the whole-block gesture must still queue two independent comments');
});

check('criterion 12 (md): a heading that already carries a SENT comment is not a comment target -- the button does nothing and is marked, while its neighbours stay live', () => {
  // A separate board, because this one has to be rendered with the comment
  // already SENT -- server-side, through applySubmit, so board.comments carries
  // the resolveComment verdict the page actually embeds.
  const sentBoard = createBoard({
    title: 'criterion 12 -- a sent md comment is immutable',
    blocks: [{ kind: 'markdown', text: '# Alpha\n\ntext\n\n# Beta\n\nmore text' }],
  });
  const sentBlockId = sentBoard.blocks[0].id;
  const anchors = sentBoard.blocks[0].anchors || [];
  assert.ok(anchors.length >= 2, `setup failure: expected two md anchors, got ${anchors.length}`);
  const sentRef = anchors[0].ref;
  const liveRef = anchors[1].ref;
  applySubmit(sentBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId: sentBlockId, anchor: { kind: 'md', ref: sentRef, label: anchors[0].label }, text: 'already sent' }],
  }, 1);

  const document = parseHTML(renderBoardPage(sentBoard));
  const window = document.defaultView;
  new Function('document', 'window', 'location', ui)(document, window, { protocol: 'http:' });
  enableCommentMode(document);

  const buttons = document.querySelectorAll(`.comment-btn[data-anchor-kind="md"][data-block-id="${sentBlockId}"]`);
  const sentBtn = buttons.find(b => b.getAttribute('data-anchor-ref') === sentRef);
  const liveBtn = buttons.find(b => b.getAttribute('data-anchor-ref') === liveRef);
  assert.ok(sentBtn && liveBtn, 'setup failure: expected an anchor button for each heading');

  // "visibly not a comment target": the same de-affordance class every other
  // surface uses, whose stylesheet rule is gated on body.comment-mode so the
  // reading view stays unmarked (the spec's Decision).
  assert.equal(sentBtn.classList.contains('cb-anchor-sent'), true,
    'a heading with a sent comment must be visibly de-affordanced');
  assert.equal(liveBtn.classList.contains('cb-anchor-sent'), false,
    'a heading with no sent comment must not be');

  sentBtn.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + sentBlockId);
  assert.equal(form.classList.contains('open'), false, 'criterion 12: "clicking it does nothing"');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queues nothing');

  // The negative, so this cannot pass against a dead button: the OTHER heading
  // is still perfectly clickable.
  liveBtn.dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'an un-commented heading must still open the form');
  assert.equal(form.getAttribute('data-anchor-ref'), liveRef);
});

// --- criterion 2: the delete control, driven rather than asserted into ---------
//
// Nothing exercised this gesture end to end: `.comment-delete` could be removed
// from renderPendingCommentItem entirely and the whole suite stayed green, which
// is how criterion 2's only affordance came to have no behavioural cover at all.
// Driven here through the real listener, on three queued comments so the
// renumbering half ("the remaining provisional pins stay contiguous") is
// observable rather than merely claimed -- deleting the MIDDLE one is the case
// that distinguishes a real renumber from an append-only list.

check('criterion 2: a queued comment\'s delete control removes it, its pin, and renumbers everything after it', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const lines = document.querySelectorAll('.code-block .code-line');
  assert.ok(lines.length >= 2, 'setup failure: need at least two code lines to anchor on');

  // Three queued comments: two dom-anchored on the code block (so they draw
  // pins), one whole-block on the markdown block (so renumbering is observed to
  // cross block boundaries, which is exactly what the shared sequence means).
  lines[0].dispatchEvent(new StandInEvent('click'));
  let form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-alpha';
  form.dispatchEvent(new StandInEvent('submit'));

  lines[1].dispatchEvent(new StandInEvent('click'));
  form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-beta';
  form.dispatchEvent(new StandInEvent('submit'));

  document.querySelector(`.comment-btn[data-block-id="${mdBlock.id}"][data-anchor-kind="block"]`).dispatchEvent(new StandInEvent('click'));
  form = document.querySelector('.comment-form.open');
  form.querySelector('input[type=text]').value = 'remark-gamma';
  form.dispatchEvent(new StandInEvent('submit'));

  // Sorted, because entries live in their OWN block's list and document order
  // is therefore block order, not queue order -- what criterion 2 promises is
  // that the numbers stay a contiguous 1..n run, not where they sit on the page.
  const numbers = () => document.querySelectorAll('.comment-item.comment-pending .comment-anchor')
    .map(el => Number(/#(\d+)/.exec(el.textContent)[1])).sort((a, b) => a - b);
  const itemFor = text => document.querySelectorAll('.comment-item.comment-pending')
    .find(i => String(i.textContent || '').includes(text));
  const numberOf = text => Number(/#(\d+)/.exec(itemFor(text).textContent)[1]);
  assert.deepEqual(numbers(), [1, 2, 3], 'setup failure: three queued comments must number 1, 2, 3');
  assert.equal(numberOf('remark-gamma'), 3, 'setup failure: the third comment queued must be numbered 3');
  assert.equal(document.querySelectorAll('.code-block .anchor-pin.pin-pending').length, 2,
    'setup failure: the two dom-anchored comments must each have drawn a pin');

  // Delete the MIDDLE one (by queue number, not by document position -- entries
  // live in their own block's list), through its own control.
  const del = itemFor('remark-beta').querySelector('.comment-delete');
  assert.ok(del, 'criterion 2: every queued comment\'s list entry must carry a delete control');
  del.dispatchEvent(new StandInEvent('click'));

  const remaining = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(remaining.length, 2, `deleting one entry must leave two, got ${remaining.length}`);
  assert.equal(remaining.map(i => String(i.textContent || '')).join('').includes('remark-beta'), false,
    'the deleted comment\'s text must be gone from the page');
  assert.deepEqual(numbers(), [1, 2],
    'criterion 2: the remaining provisional numbers must stay contiguous after a deletion, with no gap where #2 was');
  assert.equal(numberOf('remark-gamma'), 2,
    'criterion 2: deleting #2 must renumber the comment that was #3 down to #2 -- and it lives on a DIFFERENT block, so the renumber has to be board-wide');
  assert.equal(document.querySelectorAll('.code-block .anchor-pin.pin-pending').length, 1,
    'the deleted comment\'s hollow pin must be gone too, and the surviving one must remain');
});

check('criterion 12 (page-scoped half): an element carrying a SENT dom comment is not a comment target, and its neighbours still are', () => {
  // The generic comment-mode click listener's own isSentAnchor gate -- deleting
  // it left the whole suite green before this check existed. The ref is minted
  // by a REAL click first (never hardcoded), then sent, then the page reloaded
  // with that comment in board.comments, so this asserts against exactly the
  // anchor shape the gesture itself produces.
  const probe = loadBoard();
  enableCommentMode(probe);
  const probeLines = probe.querySelectorAll('.code-block .code-line');
  probeLines[0].dispatchEvent(new StandInEvent('click'));
  const probeForm = probe.querySelector('.comment-form.open');
  const sentRef = probeForm.getAttribute('data-anchor-ref');
  const sentHint = probeForm.getAttribute('data-anchor-label');
  assert.ok(sentRef, 'setup failure: the probe click minted no ref');

  const sentBoard = createBoard({ title: 'Ticket 03 -- any element takes a comment', blocks: BLOCK_SPEC });
  const sentCodeId = sentBoard.blocks[1].id;
  applySubmit(sentBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId: sentCodeId, anchor: { kind: 'dom', ref: sentRef, hint: sentHint }, text: 'already sent' }],
  }, 1);
  assert.equal(sentBoard.comments.length, 1, 'setup failure: the comment was not stored');

  const document = parseHTML(renderBoardPage(sentBoard));
  new Function('document', 'window', 'location', ui)(document, document.defaultView, { protocol: 'http:' });
  enableCommentMode(document);
  const lines = document.querySelectorAll('.code-block .code-line');

  // Hover first: criterion 12 is "visibly not a comment target" as well as inert.
  lines[0].dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(lines[0].classList.contains('cb-anchor-sent'), true,
    'the element carrying a sent comment must be de-affordanced on hover, not marked as an ordinary target');
  assert.equal(lines[0].classList.contains('cb-anchor-hover'), false, 'and must not carry the ordinary outline as well');

  lines[0].dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + sentCodeId);
  assert.equal(form.classList.contains('open'), false, 'criterion 12: clicking it must do nothing');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queue nothing');

  // The negative: the very next line is still an ordinary target, so this cannot
  // pass against a listener that is simply dead.
  lines[1].dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(lines[1].classList.contains('cb-anchor-hover'), true, 'a neighbouring line must still hover as a target');
  lines[1].dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'and must still open the comment form when clicked');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall comment-mode checks ok');
