// SPEC_STAGES criteria 3, 4, 12 and 13: the html-stage lens, driven end to end
// through the DOM stand-in the same way test/check-mermaid-anchor.mjs drives the
// diagram lens -- the real src/render.mjs markup, the real src/ui.mjs client
// script, a real click on the real control.
//
// Covers:
//   - criterion 3: every html stage carries an expand control that opens it in
//     the lens -- standalone and inside a variant option alike, and the control
//     is in the server-rendered markup rather than injected, so an archive
//     carries it in its own bytes.
//   - criterion 4: the stage in the lens receives real pointer input. What that
//     means for a check with no browser is set out at that check's own comment;
//     the half that is genuinely assertable here is that nothing on the parent's
//     side makes the frame inert, asserted against the REAL stylesheet through
//     the stand-in's cascade resolver rather than against a rule's spelling.
//   - criterion 12: Esc and a backdrop click both close the lens, and focus goes
//     back to the control that opened it.
//   - criterion 13: a standalone stage is otherwise untouched -- the inline frame
//     stays where it was rendered, stays the only '.html-stage' on the page while
//     the lens is open, and its own click-to-comment gesture still works after.
//
// The trust-boundary half of this feature -- the lens frame's sandbox attribute,
// and what happens when that frame speaks on the stage message channel -- lives
// in test/check-stage-isolation.mjs instead, next to the audit findings it
// belongs to.
//
// What this file cannot do, stated rather than faked (QUIRKS.md "The stand-in has
// no layout"): there is no scrolling, no hit-testing and no pointer-events
// enforcement here, so "the mock can be SCROLLED in the lens" is not directly
// observable. Criterion 4 is therefore checked as its preconditions -- a live
// frame carrying the same document, given a real box by the stylesheet, with no
// rule making it inert -- and the last mile belongs to a browser.

import assert from 'node:assert/strict';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderBlock } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML, StandInEvent, resolveComputedProperty } from './dom-stand-in.mjs';

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

// A mock that is taller than any stage will ever be and runs its own script --
// the two things criterion 4 is about (content that has somewhere to scroll to,
// and a document that is genuinely live rather than a picture of one).
const MOCK = '<div class="mock" style="height: 2000px"><button>Send</button>'
  + '<p>bottom of a very tall mock</p></div>'
  + '<script>window.__mockRan = (window.__mockRan || 0) + 1;</script>';

const board = createBoard({
  title: 'SPEC_STAGES -- the stage lens',
  blocks: [{ kind: 'html', html: MOCK }],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

/** Parse a rendered page and run the real `ui` client script against it -- the
 * loader every DOM-stand-in check in this repo uses (test/check-click.mjs's is
 * the original). A fresh document per call, so no check inherits another's
 * lens state. */
function loadBoard(html = pageHtml, protocol = 'http:') {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

function expandControl(document) {
  return document.querySelector('.html-block .expand-btn');
}

/** Open the lens on the page's first html stage and hand back its parts. */
function openStageLens(document) {
  const btn = expandControl(document);
  assert.ok(btn, 'setup failure: no .expand-btn rendered on the html block');
  btn.dispatchEvent(new StandInEvent('click'));
  const dlg = document.querySelector('.stage-lens');
  assert.ok(dlg, 'clicking the expand control must open the stage lens dialog');
  assert.equal(dlg.hasAttribute('open'), true, 'the lens dialog must actually be open after the expand control is clicked');
  return {
    btn,
    dlg,
    body: document.querySelector('.stage-lens .stage-lens-body'),
    frame: document.querySelector('.stage-lens .stage-lens-frame'),
  };
}

/** A board whose question is a choose-between-rendered-variants with one html
 * option -- the case the whole spec exists for, where the inline stage is inert
 * by design and the lens is the only place it becomes usable. */
function variantBoard() {
  return createBoard({
    title: 'SPEC_STAGES -- a variant option opens in the lens',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [{ label: 'Card A', block: { kind: 'html', html: MOCK } }],
    }],
  });
}

// --- criterion 3 ---------------------------------------------------------------

check('criterion 3: a standalone html stage carries an expand control naming its own block, and clicking it opens the lens on that stage', () => {
  const document = loadBoard();
  const btn = expandControl(document);
  assert.ok(btn, 'an html block\'s kicker must carry an expand control');
  assert.equal(btn.getAttribute('data-expand-for'), blockId, 'the control must name the block it opens');
  // Built lazily, exactly like the diagram lens: nothing is in the document until
  // something asks for it.
  assert.equal(document.querySelectorAll('.stage-lens').length, 0, 'the lens must not exist before it is asked for');

  const lens = openStageLens(document);
  assert.ok(lens.frame, 'the lens must hold a frame');
  const inline = document.querySelector('.html-block .html-stage');
  assert.equal(lens.frame.getAttribute('srcdoc'), inline.getAttribute('srcdoc'),
    'the lens must show THIS stage -- same srcdoc, byte for byte, as the block\'s own frame');
});

check('criterion 3: a variant option\'s html stage carries the same control, and it opens the lens too -- the case the spec exists for', () => {
  const document = loadBoard(renderBoardPage(variantBoard()));
  const card = document.querySelector('.choice-variant');
  assert.ok(card, 'setup failure: no variant card rendered');
  const btn = card.querySelector('.expand-btn');
  assert.ok(btn, 'a variant option\'s html stage must carry an expand control too');

  btn.dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.stage-lens .stage-lens-frame');
  assert.ok(frame, 'the control on a variant option must open the lens on that option\'s stage');
  assert.equal(frame.getAttribute('srcdoc'), card.querySelector('.html-stage').getAttribute('srcdoc'),
    'and it must be that option\'s own mock, not some other block\'s');
});

check('criterion 3: the expand control is SERVER-rendered, so a standalone archive carries it without ever running the client script', () => {
  // Same reasoning as the diagram control's (src/render.mjs's expandButton): the
  // lens has to work from a file: archive's own bytes. Asserted on the rendered
  // markup, before any script runs, so an implementation that injected the button
  // from src/ui.mjs would fail here even though every behavioural check above
  // would still pass.
  assert.match(pageHtml, /<button type="button" class="expand-btn" data-expand-for="[^"]+" aria-label="Open this stage in the lens"/,
    'the rendered page must already contain the html stage\'s expand control');
});

check('criterion 3: an html block whose source failed to resolve carries NO expand control -- there is no stage to open', () => {
  // Same rule the diagram control already follows (src/ui.mjs's
  // wireDiagramExpand deletes it when mermaid left no SVG): a control that opens
  // an empty lens is worse than no control. Here it is decided server-side,
  // because renderHtmlBlock's error branch renders no stage at all.
  const errored = { ...board.blocks[0], html: '', error: 'cannot read nope.html: ENOENT' };
  const markup = renderBlock(errored, board, new Map(), false);
  assert.ok(markup.includes('cannot read nope.html'), 'setup failure: the error branch did not render');
  assert.ok(!markup.includes('expand-btn'), 'a block-level error must not leave an expand control behind');
  assert.ok(!markup.includes('html-stage'), 'setup failure: the error branch must render no stage either');
});

// --- criterion 4 ---------------------------------------------------------------

check('criterion 4: the lens frame is a live document running the mock\'s own script, not a picture of one', () => {
  const document = loadBoard();
  const lens = openStageLens(document);
  lens.frame.loadSrcdoc(); // the srcdoc navigation completing, as a browser would
  assert.equal(lens.frame.contentWindow.__mockRan, 1,
    'the mock\'s own script must run inside the lens frame -- a stage that cannot run script cannot respond to input either');
  assert.ok(lens.frame.contentDocument.querySelector('button'),
    'and the mock\'s own markup must be there to receive that input');
});

check('criterion 4: nothing in the stylesheet makes the lens frame inert, while a variant option\'s INLINE stage stays inert -- the trust boundary is untouched', () => {
  // The real cascade, over the real src/styles.mjs text (test/dom-stand-in.mjs's
  // resolveComputedProperty), not a match against a rule's spelling: this asks
  // what pointer-events each of the two frames actually computes to, which is the
  // question criterion 4 and criterion 9 are two halves of.
  const document = loadBoard(renderBoardPage(variantBoard()));
  const inline = document.querySelector('.choice-variant .html-stage');
  assert.ok(inline, 'setup failure: no inline stage inside the variant card');
  assert.equal(resolveComputedProperty(styles, inline, true, 'pointer-events'), 'none',
    'a variant option\'s inline stage must stay pointer-events: none -- criterion 9, and the spec\'s Decisions pin this rule verbatim');

  document.querySelector('.choice-variant .expand-btn').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.stage-lens .stage-lens-frame');
  assert.ok(frame, 'setup failure: the lens did not open');
  assert.notEqual(resolveComputedProperty(styles, frame, true, 'pointer-events'), 'none',
    'the same stage in the lens must NOT be inert -- the lens is where a stage becomes live');

  // And it is given a real box from this side: an iframe's intrinsic size is
  // 300x150 whatever it holds, so a frame with no CSS size has nowhere to scroll
  // even in a real browser.
  assert.equal(resolveComputedProperty(styles, frame, true, 'height'), '100%');
  assert.equal(resolveComputedProperty(styles, frame, true, 'width'), '100%');
});

check('criterion 4: the lens frame is not one of the page\'s wired stages -- it never joins the message-sender walk', () => {
  // src/ui.mjs's findStageFrame walks qsa('.html-stage', document) and assumes
  // every frame it finds is one block's INLINE stage (it reads the block id, the
  // pin layer and the sentRefs off that frame's '.html-block' ancestor). The lens
  // mounts a second frame for the same block, so it must stay out of that walk by
  // construction -- see src/ui.mjs's own design comment. Asserted structurally
  // here; that a message from it is actually inert is asserted adversarially in
  // test/check-stage-isolation.mjs.
  const document = loadBoard();
  assert.equal(document.querySelectorAll('.html-stage').length, 1, 'setup failure: expected exactly one stage before the lens opens');
  const lens = openStageLens(document);
  assert.equal(document.querySelectorAll('.html-stage').length, 1,
    'with the lens open there must still be exactly one .html-stage in the document -- the lens frame must not wear that class');
  assert.equal(lens.frame.classList.contains('html-stage'), false, 'the lens frame must not carry the .html-stage class');
});

// --- criterion 12 --------------------------------------------------------------
//
// Every close path is this page's own code rather than the browser's, and that is
// deliberate: the DOM stand-in has no showModal(), no native Esc handling for a
// dialog and no hit-testing for a backdrop, so a lens that leaned on the browser
// for any of the three would be uncheckable here (and, for Esc with focus inside
// a cross-origin frame, unreliable in a browser too -- see wireStageLensChrome's
// own comment).

check('criterion 12: Esc closes the lens and returns focus to the control that opened it', () => {
  const document = loadBoard();
  const lens = openStageLens(document);
  assert.notEqual(document.activeElement, lens.btn, 'setup failure: focus must not already be on the control, or the assertion below proves nothing');

  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'Esc must close the lens');
  assert.equal(document.activeElement, lens.btn, 'and focus must go back to the expand control that opened it');
});

check('criterion 12: a backdrop click closes the lens and returns focus -- both the dialog itself and the surround around the framed stage', () => {
  for (const targetName of ['dlg', 'body']) {
    const document = loadBoard();
    const lens = openStageLens(document);
    lens[targetName].dispatchEvent(new StandInEvent('click'));
    assert.equal(lens.dlg.hasAttribute('open'), false, `a click on the ${targetName} must close the lens`);
    assert.equal(document.activeElement, lens.btn, 'and focus must go back to the expand control');
  }
});

check('criterion 12: a click on the lens chrome is NOT a backdrop click -- the bar and its title leave the lens open', () => {
  // Without this, the "backdrop" test above would be satisfied by a lens that
  // closes on any click anywhere, which would make the pick control criteria 5-8
  // add unreachable.
  const document = loadBoard();
  const lens = openStageLens(document);
  document.querySelector('.stage-lens .lens-title').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), true, 'a click on the bar must not close the lens');
  document.querySelector('.stage-lens .lens-bar').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), true, 'nor a click on the bar itself');
});

check('criterion 12: the close control closes the lens, returns focus, and ends the copy\'s document rather than hiding it', () => {
  const document = loadBoard();
  const lens = openStageLens(document);
  document.querySelector('.stage-lens .lens-btn[data-lens="close"]').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'the close control must close the lens');
  assert.equal(document.activeElement, lens.btn, 'and focus must go back to the expand control');
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 0,
    'the frame must be dropped, not merely hidden -- a mock left mounted behind a closed dialog goes on running its own timers');
});

check('criterion 12: closing and reopening works, and a second open while already open is refused rather than stacking frames', () => {
  const document = loadBoard();
  const first = openStageLens(document);
  first.btn.dispatchEvent(new StandInEvent('click')); // already open
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 1, 'a second open must not mount a second frame');
  assert.equal(document.querySelectorAll('.stage-lens').length, 1, 'and must never build a second dialog');

  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  const second = openStageLens(document);
  assert.equal(second.dlg, first.dlg, 'the lens is built once and reused');
  assert.ok(second.frame, 'and reopening must mount the stage again');
});

// --- criterion 13 --------------------------------------------------------------

check('criterion 13: opening the lens leaves the standalone block\'s own stage exactly where it was rendered', () => {
  const document = loadBoard();
  const inlineBefore = document.querySelector('.html-block .html-stage');
  const lens = openStageLens(document);
  const inlineDuring = document.querySelector('.html-block .html-stage');
  assert.equal(inlineDuring, inlineBefore, 'the block must keep its own frame -- the lens must not move it');
  assert.ok(inlineDuring.closest('.stage-wrap'), 'and it must still sit in its own .stage-wrap, beside its pin layer');
  assert.equal(inlineBefore.closest('.stage-lens'), null, 'the block\'s frame must never end up inside the dialog');
  assert.notEqual(lens.frame, inlineBefore, 'the lens shows a second mount, never the block\'s own frame');
});

check('criterion 13: the standalone stage\'s own click-to-comment gesture still works, before and after a trip through the lens', () => {
  const document = loadBoard();
  enableCommentMode(document);
  const inline = document.querySelector('.html-block .html-stage');
  inline.loadSrcdoc();

  const form = document.getElementById('comment-form-' + blockId);
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'setup failure: the inline gesture must work to begin with');
  const refBefore = form.getAttribute('data-anchor-ref');

  const lens = openStageLens(document);
  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'setup failure: the lens did not close');

  form.classList.remove('open');
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'the inline gesture must still work after the lens has been opened and closed');
  assert.equal(form.getAttribute('data-anchor-ref'), refBefore, 'and mint the same anchor it did before');
});

// --- criterion 8 ---------------------------------------------------------------
//
// "Picking from the lens records the answer and closes the lens in one act."
// RECORDS is asserted the way this repo already prefers over reaching into
// private state (test/check-comment-mode.mjs's own note): press Send with a
// stubbed global fetch and read the answer out of the body that actually gets
// posted. That is also what proves the pick went through the ONE path every
// other pick goes through -- selections/collectAnswers -- rather than through a
// second notion of what is selected that only the lens knows about.

/** A two-option variants board, both options html so either can be opened. */
function twoOptionBoard() {
  return createBoard({
    title: 'SPEC_STAGES -- picking from the lens',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Card A', block: { kind: 'html', html: MOCK } },
        { label: 'Card B', block: { kind: 'html', html: MOCK } },
      ],
    }],
  });
}

/** Press Send with a stubbed `fetch` and hand back the posted body.
 *
 * Presses twice when the first press only armed the button: the round-end send
 * guard (DESIGN.md round-end criteria 4-5) arms instead of submitting while any
 * question still carries no status, and the forced-press check below needs its
 * round to stay deliberately incomplete -- that a forced press records nothing
 * IS its subject, so answering the round to get past the guard would delete the
 * thing it measures. The second press is the guard's own "send anyway", which is
 * how a reviewer submits a partial round too. A press that neither submits nor
 * arms is still a setup failure. */
function sendAndCapture(document) {
  const originalFetch = globalThis.fetch;
  const sendBtn = document.getElementById('send-btn');
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    sendBtn.dispatchEvent(new StandInEvent('click'));
    if (!captured) sendBtn.dispatchEvent(new StandInEvent('click'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'setup failure: clicking Send never called fetch');
  return captured.body;
}

function openVariantLens(document, index) {
  const cards = document.querySelectorAll('.choice-variant');
  const btn = cards[index].querySelector('.expand-btn');
  assert.ok(btn, 'setup failure: no expand control on that option');
  btn.dispatchEvent(new StandInEvent('click'));
  return { cards, card: cards[index], btn, pick: document.querySelector('.stage-lens .lens-pick') };
}

check('criterion 8: picking from the lens records the answer -- it reaches the submit body as that option, through the same path every other pick uses', () => {
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  const { card, pick } = openVariantLens(document, 1);
  assert.ok(pick, 'setup failure: no pick control on a variant option\'s lens');

  pick.dispatchEvent(new StandInEvent('click'));

  assert.equal(card.classList.contains('selected'), true, 'the option must be selected in the card, exactly as a direct click on it would leave it');
  const answer = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.ok(answer, 'setup failure: the variant question was not in the collected answers');
  assert.equal(answer.choice, 'Card B', 'the answer that gets sent must be the option the lens picked');
  assert.equal(answer.status, 'answered');
});

check('criterion 8: picking closes the lens in the same act, and hands focus back to the control that opened it', () => {
  const board = twoOptionBoard();
  const document = loadBoard(renderBoardPage(board));
  const { btn, pick } = openVariantLens(document, 0);
  pick.dispatchEvent(new StandInEvent('click'));

  const dlg = document.querySelector('.stage-lens');
  assert.equal(dlg.hasAttribute('open'), false, 'picking must close the lens -- one act, not "pick, then find the close button"');
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 0, 'and must end the stage copy, like every other close path');
  assert.equal(document.activeElement, btn, 'and return focus to the expand control, the same as every other close path');
  assert.equal(document.querySelectorAll('.stage-lens .lens-pick').length, 0, 'the control must not outlive the lens that carried it');
});

check('criterion 8: there is ONE selection per question -- picking B from its lens after A moves the answer rather than adding one', () => {
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));

  const first = openVariantLens(document, 0);
  first.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(first.cards[0].classList.contains('selected'), true, 'setup failure: the first pick did not register');

  const second = openVariantLens(document, 1);
  second.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(second.cards[0].classList.contains('selected'), false, 'the earlier option must be deselected');
  assert.equal(second.cards[1].classList.contains('selected'), true, 'and the newly picked one selected');

  const answer = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.equal(answer.choice, 'Card B', 'exactly one choice reaches the submit body, and it is the last one picked');
});

check('criterion 8: the lens control is a caller, not an authority -- comment mode disables it, and a forced press records nothing', () => {
  // selectVariant refuses in comment mode, the same as it does for a direct
  // click on the card (every widget handler in src/ui.mjs stands down while
  // comment mode is on). The control mirrors that refusal so it never reads as
  // live while being inert -- and the press is driven anyway here, because the
  // DOM stand-in does not model a browser refusing to fire a click on a
  // disabled button (test/check-archive.mjs's own note), which makes this the
  // one place that difference could hide a real defect.
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const { card, pick } = openVariantLens(document, 0);
  assert.ok(pick, 'the control must still be present in comment mode -- absent would read as a missing feature');
  assert.equal(pick.disabled, true, 'and must be disabled, since a pick would be refused');

  pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(card.classList.contains('selected'), false, 'a forced press must record nothing');
  const answers = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.ok(!answers || answers.status !== 'answered', 'and nothing may reach the submit body as an answer');
});

check('criterion 8: a historical option\'s lens carries a disabled control, and a read-only archive\'s carries none at all', () => {
  const board = twoOptionBoard();
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const pageHtml = renderBoardPage(board);

  // Historical: the card itself is aria-disabled and refuses clicks; the
  // control says so rather than pretending.
  const live = loadBoard(pageHtml);
  const historical = openVariantLens(live, 0);
  assert.ok(historical.pick, 'a historical option\'s lens still carries the control');
  assert.equal(historical.pick.disabled, true, 'disabled, because the round is sent and the card refuses a pick too');
  historical.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(historical.card.classList.contains('selected'), false, 'and a forced press records nothing');

  // Read-only (a standalone file: archive): no control at all. There is no
  // answer to record there -- the send bar is gone and every input is
  // hard-disabled -- and the diagram lens sets the same precedent by hosting no
  // comment form in an archive.
  const archive = loadBoard(pageHtml, 'file:');
  const cards = archive.querySelectorAll('.choice-variant');
  cards[0].querySelector('.expand-btn').dispatchEvent(new StandInEvent('click'));
  assert.equal(archive.querySelector('.stage-lens').hasAttribute('open'), true,
    'the archive\'s lens must still open -- it is a viewer there, not absent');
  assert.equal(archive.querySelector('.stage-lens .lens-pick'), null, 'but it must carry no pick control');
});

if (failures) {
  console.error(`\n${failures} stage-lens check(s) failed`);
  process.exit(1);
}
console.log('\nall stage-lens checks ok');
