// Rounds are the board's pages (ADR.md entry 42, criteria 19/20/26): one round
// on screen at a time, flipped with the edge chevrons or jumped to by name from
// the pill at the bottom, landing on the newest; a page already sent is
// read-only; and both controls are always present.
//
// Driven for real: the pages, the layout switch and the read-only lock are
// asserted on renderBoardPage's own markup resolved through the stylesheet's
// real cascade (test/check-pure.mjs's idiom), and every flip is a genuine click
// or keydown against test/dom-stand-in.mjs running the real `ui` script
// (test/check-round-end.mjs's idiom, whose loaders these are copied from --
// there is no shared test-helper module in this repo, by convention).
//
// WHY A PAGE MODEL RATHER THAN A SCROLL MODEL, and what that costs. The round
// badge used to be driven by an IntersectionObserver over a band under the
// sticky header, and QUIRKS.md is blunt about what that meant for checks: the
// stand-in has no layout, no scroll position and no IntersectionObserver, so
// that machinery ran under no check at all. A pager driven by explicit state --
// one class, one variable, one function that writes them -- is checkable here in
// full, which is why the flips below assert what the reviewer would see rather
// than that a listener was registered.
//
// WHAT NO CHECK HERE CAN PROVE. That the chevrons actually sit at the viewport's
// edges and the pill at bottom centre, that a fixed-position control is not
// covered by the artifact's own frame, and that the flip's scroll animates: all
// of those are layout, and the stand-in has none. scrollIntoView is RECORDED
// here, not performed. The rules' values are asserted through the cascade, so
// what is proven is "the stylesheet says fixed/bottom/centre for this element",
// not "a browser painted it there".

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
import { roundPageLabel, roundNumberLabel } from '../src/badge.mjs';
import { styles } from '../src/styles.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent, StandInEventSource, resolveComputedProperty } from './dom-stand-in.mjs';

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

const ARTIFACT = '<style>.doc{font:14px system-ui}</style><div class="doc"><h1>Quarterly</h1></div>';
const Q = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };

/** A three-round board: round 1 sent, round 2 sent, round 3 open and asking. */
function threeRounds() {
  const board = createBoard({ title: 'Three rounds', blocks: [Q] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Second thoughts', blocks: [Q] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 2);
  addRound(board, { title: 'Last call', blocks: [Q] });
  return board;
}

/** A board whose first round is a rendered artifact and whose second asks a
 * question -- ADR.md entry 42's own example: "a page-board round is one page,
 * filling the viewport; a question round is another, carrying the send bar". */
function artifactThenQuestion() {
  const board = createBoard({ title: 'Artifact', blocks: [{ kind: 'html', html: ARTIFACT }] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Any changes', blocks: [Q] });
  return board;
}

/** Two artifact rounds: both pages lay out as page boards, so the page NOT on
 * screen still has a live, running, reporting stage of its own. Rounds are pages
 * in one document (ADR.md entry 42) and a hidden page is display:none, not
 * removed -- which is the whole reason a report has to be attributed to the
 * frame that sent it rather than to whatever page happens to be showing. */
function twoArtifacts() {
  const board = createBoard({ title: 'Artifact', blocks: [{ kind: 'html', html: ARTIFACT }] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Revision', blocks: [{ kind: 'html', html: ARTIFACT }] });
  return board;
}

/** A round carrying an artifact AND a question: NOT a page round (isPageRound is
 * "exactly one html block"), so its stage keeps the expand control a page board
 * drops and the lens is openable from it. */
function questionThenArtifactWithQuestion() {
  const board = createBoard({ title: 'Mixed', blocks: [Q] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Have a look', blocks: [{ kind: 'html', html: ARTIFACT }, Q] });
  return board;
}

function loadBoard(html, protocol) {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol: protocol || 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

function loadBoardWithEventSource(html) {
  const originalES = globalThis.EventSource;
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  globalThis.EventSource = CapturingEventSource;
  try {
    const document = loadBoard(html);
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
    return { document, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
}

const click = el => el.dispatchEvent(new StandInEvent('click'));
const currentPage = document => {
  const els = [...document.querySelectorAll('.round-current')];
  assert.equal(els.length, 1, 'exactly one round section may be the current page at any moment');
  return els[0].getAttribute('data-round');
};
const pagerLabels = document => [...document.querySelectorAll('.round-page')].map(b => b.textContent);
const owedRounds = document => [...document.querySelectorAll('.round-page-owed')].map(b => b.getAttribute('data-round'));

/** Answer a single-choice question through the real widget -- test/check-round-end.mjs's
 * own answerSingle, copied rather than imported (no shared test-helper module here). */
function answerSingle(block, label) {
  const opt = [...block.querySelectorAll('.choice-single')].find(el => el.textContent.trim() === label);
  assert.ok(opt, `setup failure: no "${label}" option rendered in this block`);
  click(opt);
}

/** What a page board's stage reports as it is scrolled (ADR.md entry 40) --
 * forged from the stage's OWN window, the only source the parent's listener
 * trusts. test/check-page-board.mjs's own reportScroll, same reason as above. */
function reportScroll(frame, top) {
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top }, '*');
}

const condensed = document => document.body.classList.contains('stage-scrolled');
const backToTopVisible = document => {
  const el = document.querySelector('button#back-to-top');
  assert.ok(el, 'setup failure: no back-to-top control rendered');
  return el.classList.contains('visible');
};

function keydown(document, key, target) {
  const ev = new StandInEvent('keydown');
  ev.key = key;
  if (target) ev.target = target;
  document.dispatchEvent(ev);
  return ev;
}

// =====================================================================================
// Criterion 19: rounds are pages -- one on screen, flipped, named, opened on the newest.
// =====================================================================================

check('criterion 19: every round renders, exactly one is the current page, and it is the NEWEST -- with the stylesheet showing that one alone', () => {
  const document = parseHTML(renderBoardPage(threeRounds()));
  const sections = [...document.querySelectorAll('.round')];
  assert.equal(sections.length, 3, 'every round is still rendered -- a page is hidden, never dropped, or an earlier round would be unreachable');
  assert.equal(currentPage(document), '3', 'a board opens on its newest round');

  // The showing/hiding is the stylesheet's, resolved through the real cascade
  // rather than by matching a rule's spelling.
  const hidden = sections[0];
  const shown = sections[2];
  assert.equal(resolveComputedProperty(styles, hidden, true, 'display'), 'none', 'a round that is not the current page is not on screen at all');
  assert.equal(resolveComputedProperty(styles, shown, true, 'display'), 'flex', 'and the current one is');

  // No JS has run here: the first paint is already on the right page, so a board
  // never flashes round 1 before settling on the newest.
});

check('criterion 19: the chevrons flip one round at a time, and the page and the layout move together', () => {
  const document = loadBoard(renderBoardPage(threeRounds()));
  const prev = document.querySelector('button#round-prev');
  const next = document.querySelector('button#round-next');

  assert.equal(currentPage(document), '3');
  assert.equal(next.disabled, true, 'there is no round after the newest');
  assert.equal(prev.disabled, false);

  click(prev);
  assert.equal(currentPage(document), '2', 'the previous chevron steps exactly one round');
  assert.equal(next.disabled, false, 'both ends are reachable again from the middle');

  click(prev);
  assert.equal(currentPage(document), '1');
  assert.equal(prev.disabled, true, 'the first page is a dead end -- disabled, never hidden');
  click(prev);
  assert.equal(currentPage(document), '1', 'and a click on a dead end goes nowhere rather than wrapping around');

  click(next);
  click(next);
  assert.equal(currentPage(document), '3');

  // The arriving page is scrolled to its own top: an ordinary round can be
  // taller than the viewport, so a flip that kept the old scroll offset would
  // land the reviewer halfway down a round they have not seen the top of.
  const page3 = document.querySelector('.round[data-round="3"]');
  assert.ok(page3.scrollIntoViewCallCount > 0, 'a flip must bring the arriving page\'s top on screen');
  assert.deepEqual(page3.scrollIntoViewLastOptions, { block: 'start' });
});

check('criterion 19: the pill numbers every round on its face, names each one to a screen reader and a hover, captions the one the reviewer is on, and jumps straight to one', () => {
  const board = threeRounds();
  const document = loadBoard(renderBoardPage(board));
  const named = board.rounds.map(r => roundPageLabel(r.n, r.title || ''));

  assert.deepEqual(pagerLabels(document), board.rounds.map(r => String(r.n)),
    'the entries print the bare numeral: an agent-supplied title of any length turns the pager into a row of ellipsed stubs, and the clipping eats the owed dot with it');
  assert.deepEqual([...document.querySelectorAll('.round-page')].map(b => b.getAttribute('aria-label')), named,
    'a numeral is not a name -- every entry carries its full label as its accessible name, since that face says nothing to a screen reader');
  assert.deepEqual([...document.querySelectorAll('.round-page')].map(b => b.getAttribute('title')), named,
    'and as its hover title, the same shared helper src/render.mjs prints each round\'s own label with');
  assert.equal(document.querySelector('div#round-pager-caption').textContent, named[2],
    'the caption names the round on screen -- the board opens on its newest');

  // A jump is not a step: round 3 to round 1 in one click.
  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(currentPage(document), '1');
  assert.equal(document.querySelector('.round-page[data-round="1"]').getAttribute('aria-current'), 'page');
  assert.equal(document.querySelector('.round-page[data-round="3"]').getAttribute('aria-current'), null,
    'exactly one entry is the current page for a screen reader too');
});

check('criterion 19: the pill dots the round that still owes an answer, and only that one', () => {
  const document = parseHTML(renderBoardPage(threeRounds()));
  assert.deepEqual(owedRounds(document), ['3'], 'the open, asking round is dotted; the two sent ones are not');

  // A round nobody is being asked to answer is never dotted -- an artifact round
  // is open forever (nothing sends it), and dotting it would accuse the reviewer
  // of holding up something that was never a question.
  const artifactOnly = parseHTML(renderBoardPage(createBoard({ title: 'Artifact', blocks: [{ kind: 'html', html: ARTIFACT }] })));
  assert.deepEqual(owedRounds(artifactOnly), [], 'a round that asks nothing owes nothing');

  // And the dot is live: answering does not clear it (the round is still owed
  // until it is sent), but SENDING it does -- driven here through a real push.
  const board = createBoard({ title: 'Owed live', blocks: [Q] });
  const { document: doc, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.deepEqual(owedRounds(doc), ['1']);
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  es.dispatch('submitted', JSON.stringify({
    round: 1, board, html: renderRoundSection(board, 1, groupCommentsByBlock([])),
  }));
  assert.deepEqual(owedRounds(doc), [], 'a round that has gone out no longer owes an answer');
});

check('criterion 19: the arrow keys are the chevrons\' keyboard twin -- and never fire while the caret is in a field', () => {
  const document = loadBoard(renderBoardPage(threeRounds()));
  assert.equal(currentPage(document), '3');

  keydown(document, 'ArrowLeft');
  assert.equal(currentPage(document), '2', 'ArrowLeft steps back one round');
  keydown(document, 'ArrowRight');
  assert.equal(currentPage(document), '3', 'ArrowRight steps forward');

  // A note field is exactly where an unmodified arrow key means "move the
  // caret". Nothing on this page had ever needed that guard before the pager.
  const note = document.querySelector('[data-note-for]');
  assert.ok(note, 'setup failure: the open round must render a note field');
  keydown(document, 'ArrowLeft', note);
  assert.equal(currentPage(document), '3', 'an arrow key inside a textarea moves the caret, never the page');

  // Modified arrows belong to the platform (back/forward, word-wise motion).
  const ev = new StandInEvent('keydown');
  ev.key = 'ArrowLeft';
  ev.metaKey = true;
  document.dispatchEvent(ev);
  assert.equal(currentPage(document), '3', 'Cmd+ArrowLeft is the browser\'s, not ours');
});

check('criterion 19: a round arriving over SSE becomes the page for a reviewer at the front, and leaves a reviewer reading an earlier page where they are', () => {
  // At the front: the ordinary case -- the board opened on its newest round, the
  // reviewer answered it, and the next round is what they are waiting for.
  const board = createBoard({ title: 'Live arrival', blocks: [Q] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(currentPage(document), '1');

  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Next', blocks: [Q] });
  es.dispatch('round', JSON.stringify({
    round: 2, mode: 'new-round', blockIds: [],
    html: renderRoundSection(board, 2, groupCommentsByBlock([])),
    board,
  }));
  assert.equal(currentPage(document), '2', 'the round the reviewer is waiting for becomes the page they are on');
  assert.deepEqual(owedRounds(document), ['2'], 'and the pill\'s dot moves with it');

  // Reading an earlier page: not yanked off it. The tab mark and the pager's own
  // new entry are how the arrival is announced instead.
  const board2 = threeRounds();
  const { document: doc2, es: es2 } = loadBoardWithEventSource(renderBoardPage(board2));
  click(doc2.querySelector('.round-page[data-round="1"]'));
  assert.equal(currentPage(doc2), '1');
  applySubmit(board2, { action: 'send', answers: [], comments: [] }, 3);
  addRound(board2, { title: 'Fourth', blocks: [Q] });
  es2.dispatch('round', JSON.stringify({
    round: 4, mode: 'new-round', blockIds: [],
    html: renderRoundSection(board2, 4, groupCommentsByBlock([])),
    board: board2,
  }));
  assert.equal(currentPage(doc2), '1', 'a reviewer who deliberately flipped back keeps the page they chose');
  assert.equal(pagerLabels(doc2).length, 4, 'the new round is in the pill the moment it lands');
  assert.deepEqual(owedRounds(doc2), ['4'], 'dotted, which is how the arrival announces itself');
});

check('criterion 19 + ADR 42: the layout follows the PAGE -- an artifact round fills the viewport, the question round next door is an ordinary board', () => {
  const document = loadBoard(renderBoardPage(artifactThenQuestion()));
  assert.equal(currentPage(document), '2');
  assert.equal(document.body.classList.contains('page-board'), false,
    'a board opens on its newest round, and this one is an ordinary question round');

  click(document.querySelector('button#round-prev'));
  assert.equal(currentPage(document), '1');
  assert.equal(document.body.classList.contains('page-board'), true,
    'flipping to the artifact page puts the full-viewport layout back -- the page-board class follows the page, not the board');
  assert.equal(document.querySelectorAll('.round[data-round="1"] .block-kicker').length, 0,
    'and that page is still the one that was RENDERED as a page: no kicker over a full-viewport artifact, before or after a round arrived');

  click(document.querySelector('button#round-next'));
  assert.equal(document.body.classList.contains('page-board'), false, 'and flipping back takes it away again');
});

// =====================================================================================
// Criterion 20: a page already sent is read-only.
// =====================================================================================

check('criterion 20: flipping back to a sent page takes the send bar away, and returning to the open round brings it back', () => {
  const document = loadBoard(renderBoardPage(threeRounds()));
  const sendBtn = document.querySelector('button#send-btn');
  const discussBtn = document.querySelector('button#discuss-btn');
  const sendBar = document.querySelector('.send-bar');
  assert.equal(sendBtn.disabled, false, 'setup: the open round\'s own page can be sent');

  click(document.querySelector('.round-page[data-round="2"]'));
  assert.equal(document.body.classList.contains('sent-page'), true);
  assert.equal(resolveComputedProperty(styles, sendBar, true, 'display'), 'none',
    'the send bar is hidden on a sent page the same way body.readonly hides it -- one rule, the whole bar');
  assert.equal(sendBtn.disabled, true,
    'and hard-disabled as well: the bar lives OUTSIDE every round section, so nothing that disables a sent round\'s widgets reaches it (QUIRKS.md "Readonly is locked twice")');
  assert.equal(discussBtn.disabled, true, 'Discuss is irreversible, so it gets the same lock');

  click(document.querySelector('.round-page[data-round="3"]'));
  assert.equal(document.body.classList.contains('sent-page'), false);
  assert.notEqual(resolveComputedProperty(styles, sendBar, true, 'display'), 'none');
  assert.equal(sendBtn.disabled, false, 'the open round is still sendable -- the lock is about the PAGE, not about the board');
});

check('criterion 20: the keyboard path cannot send from a sent page either', () => {
  const document = loadBoard(renderBoardPage(threeRounds()));
  click(document.querySelector('.round-page[data-round="1"]'));

  const ev = new StandInEvent('keydown');
  ev.key = 'Enter';
  ev.metaKey = true;
  document.dispatchEvent(ev);
  assert.equal(document.querySelector('.send-status').textContent, '',
    'Cmd+Enter on a sent page must not start a submit -- the chord\'s own guard is "the send button is disabled", which the page lock is what makes true here');
});

check('criterion 20: a sent page\'s own controls are inert -- three independent locks, none of them removed', () => {
  const board = threeRounds();
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const sentPage = document.querySelector('.round[data-round="1"]');

  // 1. server-side, in the markup: every widget in a sent round renders disabled
  const choice = sentPage.querySelector('.card-choice');
  assert.equal(choice.disabled, true, 'the server renders a sent round\'s widgets disabled (unchanged by this work)');

  // 2. the stylesheet, while that page is the one showing
  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(resolveComputedProperty(styles, choice, true, 'pointer-events'), 'none',
    'and body.sent-page makes the page itself inert, the same shape body.readonly uses');

  // 3. the client's own live collapse, for a round that goes sent without a
  // re-render -- proved elsewhere (markRoundHistory), asserted here only as
  // "still called", since removing it would leave a live tab editable.
  assert.ok(ui.includes('function markRoundHistory'), 'the live collapse must still exist -- the page lock is a THIRD lock, not a replacement');
});

check('criterion 20: a round going sent under the reviewer locks the page they are standing on, with no flip and no reload', () => {
  const board = createBoard({ title: 'Sent under you', blocks: [Q] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(document.querySelector('button#send-btn').disabled, false);

  // Another tab (or this one) sent it: the server pushes 'submitted'.
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  es.dispatch('submitted', JSON.stringify({
    round: 1, board, html: renderRoundSection(board, 1, groupCommentsByBlock([])),
  }));

  assert.equal(currentPage(document), '1', 'the reviewer stays where they were');
  assert.equal(document.body.classList.contains('sent-page'), true, 'and the page turns read-only underneath them');
  assert.equal(document.querySelector('button#send-btn').disabled, true,
    'which is the double-submit hole closed at the page level as well: a second press cannot reach a round that is already out');
});

check('criterion 20: a submit already in the air survives a page flip -- flipping away and back is not a way to re-arm it', () => {
  // The gap this closes is a real one that shipped once already:
  // setSendBarEnabled's own comment records a plain double-click submitting an
  // already-sent round, duplicating its comments and their pin numbers, because
  // the send bar sits outside every round section and nothing round-scoped
  // reaches it. Rounds-as-pages added a NEW way into that gap: refreshPager
  // decides the bar's state purely from "is the open round the page you are on",
  // and a flip away and back is two refreshPagers -- so without the
  // submitInFlight latch the second one hands the button back while the first
  // submit is still in flight. Driven here, rather than pinned by a source-text
  // regex, because the regex form of this check stayed green when the latch was
  // set to `false` (verified).
  const board = threeRounds();
  const document = loadBoard(renderBoardPage(board));
  const sendBtn = document.querySelector('button#send-btn');

  // Answer the open round, so pressing Send submits rather than arming the guard.
  answerSingle(document.querySelector('.round[data-round="3"] .question-block'), 'Yes');
  assert.equal(sendBtn.disabled, false, 'setup: the open round is sendable');

  const originalFetch = globalThis.fetch;
  let calls = 0;
  // A submit that never settles is exactly "in flight": the real one is in this
  // state for as long as the daemon takes to answer, which is the whole window
  // this latch exists for.
  globalThis.fetch = () => { calls++; return new Promise(() => {}); };
  try {
    click(sendBtn);
    assert.equal(calls, 1, 'setup: the click must actually have started a submit');
    assert.equal(sendBtn.disabled, true, 'setup: submitBoard disables the bar for the duration');

    click(document.querySelector('.round-page[data-round="1"]'));
    assert.equal(currentPage(document), '1');
    assert.equal(sendBtn.disabled, true, 'a sent page never offers Send anyway');

    click(document.querySelector('.round-page[data-round="3"]'));
    assert.equal(currentPage(document), '3', 'setup: back on the open round\'s own page');
    assert.equal(sendBtn.disabled, true,
      'and the button must STAY disabled: the round is already in the air, and a second press would post it twice');
    assert.equal(calls, 1, 'nothing may have submitted a second time on the way');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

check('criterion 19 + ADR 40: the condensed chrome belongs to the page that earned it -- a flip clears it, a repaint does not', () => {
  // The condensed header and the back-to-top control are downstream of ONE
  // page's stage reporting its own scroll, so flipping away has to drop them:
  // otherwise a condensed pill floats over an ordinary board whose header is not
  // fixed, and a control offers to scroll a frame that is no longer what
  // scrolls. But the clearing must live in the FLIP, not in refreshPager --
  // that function is a repaint, run on hydrate and on every SSE arrival too, and
  // clearing there wipes the condensed header out from under a reviewer who is
  // still reading the artifact and has not flipped anywhere. Both failures
  // (clearing in the repaint, and not clearing at all) left the whole suite
  // green before this check existed.
  const board = artifactThenQuestion();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));

  // Onto the artifact page, and read into it until the chrome condenses.
  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: the artifact page is laid out as a page board');
  const frame = document.querySelector('.round[data-round="1"] .html-stage');
  assert.ok(frame, 'setup failure: no stage on the artifact page');
  frame.loadSrcdoc();
  reportScroll(frame, 640);
  assert.equal(condensed(document), true, 'setup: reading the artifact condenses the header (ADR.md entry 40)');
  assert.equal(backToTopVisible(document), true, 'setup: and floats the back-to-top control');

  // A repaint that is NOT a flip: a third round lands while the reviewer is
  // reading page 1, so applyRoundPush restates the page it is already on.
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 2);
  addRound(board, { title: 'Third', blocks: [Q] });
  es.dispatch('round', JSON.stringify({
    round: 3, mode: 'new-round', blockIds: [],
    html: renderRoundSection(board, 3, groupCommentsByBlock([])),
    board,
  }));
  assert.equal(currentPage(document), '1', 'setup: the reviewer was not following the arrival, so the page did not move');
  assert.equal(condensed(document), true,
    'a round arriving elsewhere must not expand the header under a reviewer who is still scrolled into the artifact');
  assert.equal(backToTopVisible(document), true, 'nor take away the control that gets them back to its top');

  // An actual flip: the chrome goes with the page that earned it.
  click(document.querySelector('.round-page[data-round="2"]'));
  assert.equal(currentPage(document), '2');
  assert.equal(condensed(document), false,
    'flipping to another page must expand the header again -- a condensed pill over an ordinary board floats over nothing');
  assert.equal(backToTopVisible(document), false,
    'and the back-to-top control must go with it, or it offers to scroll a frame that is no longer what scrolls');
});

check('ADR 40: the chrome answers to the page ON SCREEN -- a stage on another page neither condenses the header nor is moved by the back-to-top control', () => {
  // Both directions of one mistake. Every round is mounted in ONE document and
  // hidden with display:none, so every round's stage is loaded and running at all
  // times -- and a stage is agent-authored, explicitly assumed hostile by
  // stageAgentScript's own design comment. Inbound, the report was gated on a
  // body class, which describes the page on screen and cannot tell the sending
  // stage from any other, so a stage on a page nobody has opened could take the
  // board's own title and thread line off the page the reviewer IS reading
  // (src/styles.mjs hides them when condensed). Outbound, back-to-top was
  // broadcast to every stage in the document, so a reviewer asking to get back to
  // the top of the artifact in front of them also reset the scroll position of an
  // artifact on another page. "A page board has exactly one stage" was a fact
  // about the page being applied to a document-wide query, and it stopped being
  // true the moment rounds became pages.
  const { document } = loadBoardWithEventSource(renderBoardPage(twoArtifacts()));
  assert.equal(currentPage(document), '2', 'setup: the board opens on its newest page');
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: and that page is an artifact page');

  const offPage = document.querySelector('.round[data-round="1"] .html-stage');
  const onPage = document.querySelector('.round[data-round="2"] .html-stage');
  assert.ok(offPage && onPage, 'setup failure: both artifact pages must have a stage');
  offPage.loadSrcdoc();
  onPage.loadSrcdoc();

  // Inbound: the hidden page's stage claims to have been read all the way down.
  reportScroll(offPage, 9999);
  assert.equal(condensed(document), false,
    'a stage on a page the reviewer has not opened must not condense the header of the page they are reading -- that header is where the board says which board it is');
  assert.equal(backToTopVisible(document), false,
    'nor float a control offering to scroll a frame that is not on screen');

  // The current page's own stage still works, so the gate above is scoping and
  // not a switch that turned the feature off.
  reportScroll(onPage, 800);
  assert.equal(condensed(document), true, 'the page on screen reporting its own scroll still condenses the header');
  assert.equal(backToTopVisible(document), true, 'and still offers the way back up');

  // Outbound: the request to go back to the top reaches that page's stage alone.
  const heard = { off: [], on: [] };
  offPage.contentWindow.addEventListener('message', ev => { if (ev.data && ev.data.type === 'scroll') heard.off.push(ev.data.top); });
  onPage.contentWindow.addEventListener('message', ev => { if (ev.data && ev.data.type === 'scroll') heard.on.push(ev.data.top); });
  click(document.querySelector('button#back-to-top'));
  assert.deepEqual(heard.on, [0], 'back-to-top must reach the stage the reviewer is actually looking at');
  assert.deepEqual(heard.off, [],
    'and must reach no other -- resetting an off-page artifact throws away a reading position the reviewer never asked to lose');
});

check('ADR 40: flipping back to a half-read artifact returns its condensed header and its way back up', () => {
  // The chrome is derived from the arriving page's own last report, not cleared
  // on the flip, and the difference is only visible on the way BACK. A
  // display:none iframe keeps its inner scroll offset and fires no scroll event
  // when it is shown again (measured in Chrome 152 -- QUIRKS.md), so the reader
  // returns to exactly where they left the artifact while nothing re-reports it:
  // a clear-on-flip left them mid-document under an expanded fixed header
  // overlaying the top of the content, with no back-to-top, until they happened
  // to scroll again.
  const { document } = loadBoardWithEventSource(renderBoardPage(artifactThenQuestion()));

  click(document.querySelector('.round-page[data-round="1"]'));
  const frame = document.querySelector('.round[data-round="1"] .html-stage');
  assert.ok(frame, 'setup failure: no stage on the artifact page');
  frame.loadSrcdoc();
  reportScroll(frame, 640);
  assert.equal(condensed(document), true, 'setup: reading the artifact condenses the header');

  click(document.querySelector('.round-page[data-round="2"]'));
  assert.equal(condensed(document), false, 'setup: and flipping away expands it again');
  assert.equal(backToTopVisible(document), false, 'setup: taking the back-to-top control with it');

  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(currentPage(document), '1');
  assert.equal(condensed(document), true,
    'coming back to an artifact the reviewer left half-read must condense the header again -- the frame is still at that offset and will never say so unprompted');
  assert.equal(backToTopVisible(document), true, 'and hand back the control that gets them to its top');

  // Not a latch: an artifact left at the top comes back with the header expanded,
  // which is what stops the assertion above being satisfied by "once condensed,
  // always condensed".
  reportScroll(frame, 0);
  assert.equal(condensed(document), false, 'setup: scrolling back to the top expands the header');
  click(document.querySelector('.round-page[data-round="2"]'));
  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(condensed(document), false, 'and returning to an artifact left at ITS top must not condense anything');
});

check('ADR 42: an arrow key does not flip the page out from under an open lens', () => {
  // showModal() does not stop a keydown bubbling to the document -- this file's
  // own lens Esc handler is registered there for exactly that reason -- and
  // showModal puts focus on the lens's close <button>, which sails straight
  // through the INPUT/TEXTAREA/SELECT guard. No flip path closes a lens, so the
  // page underneath changed while the reviewer went on reading the block they
  // had opened, and the lens was left showing a block belonging to a page that
  // is no longer on screen.
  //
  // Driven through the stage lens: the diagram lens is the same guard in the
  // same expression, but its control is deleted when mermaid leaves no SVG, and
  // the stand-in has no mermaid (see test/check-stage-lens.mjs).
  const { document } = loadBoardWithEventSource(renderBoardPage(questionThenArtifactWithQuestion()));
  assert.equal(currentPage(document), '2', 'setup: the board opens on its newest page');

  const expand = document.querySelector('.html-block .expand-btn');
  assert.ok(expand, 'setup failure: a round carrying an artifact AND a question is not a page round, so its stage must keep the expand control');
  click(expand);
  const dlg = document.querySelector('.stage-lens');
  assert.ok(dlg && dlg.hasAttribute('open'), 'setup failure: the expand control did not open the lens');

  // Where showModal actually leaves focus, and the exact case the guard above it
  // does not cover.
  const closeBtn = dlg.querySelector('button');
  assert.ok(closeBtn, 'setup failure: the lens has no button to hold focus');
  keydown(document, 'ArrowLeft', closeBtn);
  assert.equal(currentPage(document), '2', 'an arrow key with the lens open must not flip the page underneath it');
  keydown(document, 'ArrowLeft');
  assert.equal(currentPage(document), '2', 'nor one with focus anywhere else in the parent document');
  assert.equal(dlg.hasAttribute('open'), true, 'and the key must be refused, not turned into a lens close -- an arrow is the reviewer reading, not leaving');

  // Closing the lens hands the arrow keys back: the guard is scoped to the lens
  // being open, not a permanent disabling of the keyboard path.
  keydown(document, 'Escape');
  assert.equal(dlg.hasAttribute('open'), false, 'setup: Esc closes the lens');
  keydown(document, 'ArrowLeft');
  assert.equal(currentPage(document), '1', 'with the lens shut, an arrow key flips again');
});

// =====================================================================================
// Criterion 26: both controls, always.
// =====================================================================================

check('criterion 26: both controls are present on every kind of board -- single round, page board, and a read-only archive', () => {
  const boards = {
    'a single-round board': createBoard({ title: 'One', blocks: [Q] }),
    'a page board': createBoard({ title: 'Artifact', blocks: [{ kind: 'html', html: ARTIFACT }] }),
    'a three-round board': threeRounds(),
  };
  for (const [what, board] of Object.entries(boards)) {
    const document = parseHTML(renderBoardPage(board));
    assert.ok(document.querySelector('button#round-prev'), `${what} must render the previous chevron`);
    assert.ok(document.querySelector('button#round-next'), `${what} must render the next chevron`);
    assert.ok(document.querySelector('nav#round-pager'), `${what} must render the pill`);
    assert.equal(document.querySelectorAll('.round-page').length, board.rounds.length,
      `${what} must name every one of its rounds in the pill`);
  }

  // A one-round board has both ends disabled and still shows both: the chevrons
  // are a fixed pair of affordances, not something that appears once there is
  // somewhere to go.
  const one = parseHTML(renderBoardPage(boards['a single-round board']));
  assert.equal(one.querySelector('button#round-prev').hasAttribute('disabled'), true);
  assert.equal(one.querySelector('button#round-next').hasAttribute('disabled'), true);
});

check('criterion 26: DISABLED is not hidden -- no rule in the stylesheet takes a round control off the page, in any state', () => {
  // "Disabled at the ends, never hidden: a control that disappears at round 1 is
  // a control the reviewer has to find again at round 2" (src/styles.mjs). The
  // check above proves the buttons are rendered and disabled at the ends, and
  // the one below proves their computed display in every body state the cascade
  // resolver can evaluate -- but neither could see the one rule that breaks this
  // outright: `.round-flip:disabled { display: none }` hides a chevron on every
  // single-round board and at both ends of every other, and left the WHOLE suite
  // green (verified). test/dom-stand-in.mjs's resolver has no interaction state,
  // so a `:disabled` compound deliberately never matches and the rule is
  // invisible to it (QUIRKS.md "The stand-in has no layout" / its own comment on
  // dynamic pseudo-classes).
  //
  // So this asserts the invariant STRUCTURALLY, over every rule whose selector
  // mentions a round control at all, whatever state it is gated on: none of them
  // may take one off the page. That is the opposite of the trap QUIRKS.md warns
  // about (asserting a rule EXISTS by its spelling, which is how the mermaid
  // selector matched a rule that selected nothing) -- asserting that a class of
  // rule does NOT exist is exactly what a text scan is good for, and here it is
  // the only mechanism available.
  const stripped = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
  assert.ok(rules.length > 100, 'setup failure: the stylesheet did not parse into rules');

  const CONTROL = /\.round-flip|\.round-pager|\.round-page/;
  const HIDING = [
    [/display\s*:\s*none/, 'display: none'],
    [/visibility\s*:\s*hidden/, 'visibility: hidden'],
    [/content-visibility\s*:\s*hidden/, 'content-visibility: hidden'],
    [/opacity\s*:\s*0(?![.\d])/, 'opacity: 0'],
  ];
  for (const rule of rules) {
    if (!CONTROL.test(rule.selector)) continue;
    for (const [pattern, what] of HIDING) {
      assert.ok(!pattern.test(rule.body),
        `"${rule.selector}" sets ${what}, which takes a round control off the page. Both controls are always present (criterion 26): the ends are DISABLED, never hidden, and a page board / a sent page / an archive all keep the pager, since it is the only way off the page they are on.`);
    }
  }

  // The scan is only worth something if a control is actually in its net.
  assert.ok(rules.some(r => /\.round-flip/.test(r.selector)), 'setup failure: no .round-flip rule found to scan');
  assert.ok(rules.some(r => /\.round-pager/.test(r.selector)), 'setup failure: no .round-pager rule found to scan');
});

check('criterion 26: the pager is displayed under every body state the cascade can evaluate -- page board, sent page, and a read-only archive', () => {
  // The states that DO have a class to key off, resolved through the real
  // cascade rather than scanned: body.page-board hides the send bar, body.readonly
  // hides it too and hard-disables every button, body.sent-page hides it again --
  // and the pager survives all three, because it is how the reviewer leaves the
  // page those states describe.
  const document = parseHTML(renderBoardPage(threeRounds()));
  const pager = document.querySelector('.round-pager');
  const prev = document.querySelector('.round-flip-prev');
  const entry = document.querySelector('.round-page');
  const sendBar = document.querySelector('.send-bar');

  for (const state of ['', 'page-board', 'sent-page', 'readonly', 'page-board sent-page']) {
    document.body.className = state;
    const named = state || '(no state)';
    for (const [what, el] of [['the pill', pager], ['a chevron', prev], ['a pill entry', entry]]) {
      assert.notEqual(resolveComputedProperty(styles, el, true, 'display'), 'none', `${what} must stay on the page under body.${named}`);
      assert.notEqual(resolveComputedProperty(styles, el, true, 'visibility'), 'hidden', `${what} must stay visible under body.${named}`);
    }
  }

  // The send bar is the control that IS state-gated, asserted here as the
  // counterweight: this check would pass vacuously if nothing in the stylesheet
  // ever hid anything under these classes.
  document.body.className = 'sent-page';
  assert.equal(resolveComputedProperty(styles, sendBar, true, 'display'), 'none',
    'setup failure: body.sent-page must hide the send bar, or this check proves nothing about the pager surviving it');
});

check('criterion 26: the pager survives the read-only archive\'s blanket disable, and still flips there', () => {
  // file:// hydrates read-only and hard-disables every button on the page. An
  // archive's rounds are still pages, and flipping between them is navigation,
  // not editing -- the same carve-out the diagram's expand control has.
  const document = loadBoard(renderBoardPage(threeRounds()), 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: expected file:// to hydrate read-only');

  const prev = document.querySelector('button#round-prev');
  assert.equal(prev.disabled, false, 'the chevron must survive the blanket disable');
  assert.equal(document.querySelector('.round-page[data-round="1"]').disabled, false, 'and so must every pill entry');

  click(prev);
  assert.equal(currentPage(document), '2', 'an archived board still pages');
  click(document.querySelector('.round-page[data-round="1"]'));
  assert.equal(currentPage(document), '1');
});

check('criterion 26: the two controls are two positions -- the dock bottom-centre, the chevrons at the left and right edges', () => {
  const document = parseHTML(renderBoardPage(threeRounds()));
  const dock = document.querySelector('.round-pager-dock');
  const prev = document.querySelector('.round-flip-prev');
  const next = document.querySelector('.round-flip-next');

  assert.equal(resolveComputedProperty(styles, dock, true, 'position'), 'fixed');
  assert.equal(resolveComputedProperty(styles, dock, true, 'left'), '50%');
  assert.equal(resolveComputedProperty(styles, dock, true, 'transform'), 'translateX(-50%)', 'centred on the bottom edge');
  assert.equal(resolveComputedProperty(styles, prev, true, 'position'), 'fixed');
  assert.equal(resolveComputedProperty(styles, prev, true, 'left'), '0');
  assert.equal(resolveComputedProperty(styles, next, true, 'right'), '0');

  // The caption and the pill are ONE fixed box, so they share a centre line with
  // no offset measured between them, and the pill is not separately fixed.
  assert.equal(document.querySelector('.round-pager').closest('.round-pager-dock'), dock);
  assert.equal(document.querySelector('div#round-pager-caption').closest('.round-pager-dock'), dock);

  // The chevrons are SIBLINGS of the dock, not children of it: the dock's own
  // centring transform would otherwise become their containing block and pin
  // them to the dock instead of the viewport -- a real-browser-only failure
  // this DOM can only guard structurally.
  assert.equal(prev.closest('.round-pager-dock'), null, 'a chevron must never be nested inside the transformed dock');
  assert.equal(next.closest('.round-pager-dock'), null);
});

check('the page board\'s comment panel clears the round pager by reading its REAL measured height, not a guessed number -- SOURCE ONLY, see note below', () => {
  // 2379f12 turned the dock into a two-row box (a caption line above the
  // pill), and .page-comments went on clearing a hardcoded '44px' sized for
  // the old one-row pill -- so the panel started sitting under the dock
  // instead of above it, on every page board, at every comment count.
  //
  // A CSS-only fix (anchor-name/anchor()) was tried first and reverted: a
  // real Chrome computed .page-comments's 'bottom' to 'auto', not the
  // anchored value, because the anchor must precede the positioned element
  // in DOM order and .round-pager-dock does not (see src/styles.mjs's own
  // comment on .round-pager-dock for the full account) -- a failure this
  // stand-in's check for the earlier version of this check could not see,
  // because it only ever asserted the CSS SOURCE referenced an anchor, never
  // that a browser resolved it. Recorded here so the same mistake is not
  // repeated: a check that can only read source text cannot certify a
  // mechanism whose whole behaviour lives in the layout engine.
  //
  // The fix instead measures the dock with a ResizeObserver
  // (setupPagerDockHeightTracking, src/ui.mjs) and writes its real height to
  // '--round-pager-dock-h', which .page-comments's 'bottom' reads
  // (src/styles.mjs) -- independent of DOM order or nesting, since a
  // ResizeObserver measures the element's actual box wherever it sits.
  //
  // WHAT THIS CHECK CAN PROVE, and no more: that the CSS declares 'bottom' in
  // terms of '--round-pager-dock-h' rather than a bare pixel literal, and
  // that the client script text actually defines and CALLS a ResizeObserver
  // that observes '.round-pager-dock' and writes exactly that property (not
  // merely that such a function exists somewhere unused -- QUIRKS.md, "A
  // client script that parses is not a client script that is on the page").
  // test/dom-stand-in.mjs has no ResizeObserver and no layout engine at all
  // (QUIRKS.md, "The stand-in has no layout"), so nothing here runs the
  // observer or reads a real pixel gap -- that half was verified by hand
  // against a real Chrome (see this file's own header comment on what no
  // check here can prove).
  const board = createBoard({ title: 'Rendered artifact', blocks: [{ kind: 'html', html: '<p>hello</p>' }] });
  const document = parseHTML(renderBoardPage(board));
  const dock = document.querySelector('.round-pager-dock');
  const panel = document.querySelector('.page-comments');
  assert.ok(dock, 'setup failure: expected a round pager dock');
  assert.ok(panel, 'setup failure: expected a page board to render .page-comments');

  const bottom = resolveComputedProperty(styles, panel, true, 'bottom');
  assert.ok(bottom.includes('var(--round-pager-dock-h'),
    'the panel\'s bottom must read the dock\'s MEASURED height custom property, not a fixed offset');
  assert.doesNotMatch(bottom, /^\s*calc\(var\(--space-5\) \+ \d+px\)\s*$/,
    'the exact bug this ticket fixes: a bare pixel height sized for today\'s dock, quietly wrong the next time the dock\'s own shape changes');

  // The client script must actually run the measurement, not just define it
  // (the trap QUIRKS.md's indexScript entry names): setupPagerDockHeightTracking
  // has to both exist and be CALLED against .round-pager-dock, observed by a
  // real ResizeObserver, writing the exact property the CSS above reads.
  assert.match(ui, /function setupPagerDockHeightTracking\s*\(\s*\)\s*\{[\s\S]*?\}/,
    'the tracking function must be defined in the real client script');
  const fnBody = ui.match(/function setupPagerDockHeightTracking\s*\(\s*\)\s*\{([\s\S]*?)\n  \}/)[1];
  // Tag qualifier optional, and preferred: board content mints its own ids and
  // classes (src/markdown.mjs's slugify), so this file's own convention is
  // 'div.round-pager-dock' over a bare class. What this asserts is that the
  // measurement reads the REAL dock, whichever way the selector spells it.
  assert.match(fnBody, /querySelector\(['"](?:div)?\.round-pager-dock['"]\)/, 'it must measure the real dock element');
  assert.match(fnBody, /new ResizeObserver\(/, 'it must be a live observer, not a one-shot read at load');
  assert.match(fnBody, /setProperty\(['"]--round-pager-dock-h['"]/, 'and it must write the exact property .page-comments reads');
  assert.match(ui, /setupPagerDockHeightTracking\(\);/, 'the function must actually be CALLED on the page, not merely defined and left unused');
});

if (failures) {
  console.error(`\n${failures} round-pager check(s) failed`);
  process.exit(1);
}
console.log('\nall round-pager checks ok');
