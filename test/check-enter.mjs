// Acceptance checks for Cmd+Enter board traversal (src/ui.mjs, search
// "Cmd+Enter board traversal"): one chord that walks a board's question notes
// and, on arriving at Send, does exactly what a click on Send would do right
// now. Same harness idiom as
// test/check-click.mjs and test/check-comment-mode.mjs -- drives the REAL
// src/ui.mjs client script, in the real DOM stand-in, through the actual
// keyboard gesture, and asserts on what a reviewer would actually see
// (focus, a scroll call, a relabelled button, a posted fetch body) rather
// than calling any internal function directly.
//
// One check per numbered acceptance criterion, named with its number so a
// failure names exactly what broke. Covered end to end:
//   1. Cmd+Enter in a note or answer textarea advances focus to the NEXT
//      question's note field and scrolls it into view (both entry points).
//   2. plain Enter is left alone everywhere.
//   3. arriving at Send with nothing outstanding submits on that press --
//      no relabel, no second press.
//   4. arriving at Send on a round with no question blocks at all also
//      submits on that press, the same rule with nothing to be outstanding.
//   5. arriving at Send with something outstanding arms exactly as a mouse
//      click on Send does -- same scroll, same ring, same label, same
//      send-status.
//   6. a second Cmd+Enter while armed (something was outstanding) submits,
//      byte-identical to what a second click on the armed button posts --
//      test/check-send-guard.mjs drives both routes and compares the bodies.
//   7. Escape while armed disarms fully -- label, ring, warning treatment
//      and send-status all restored, no submit.
//   8. Discuss has no keyboard path at all.
//   9. Cmd+Enter is inert in a file:// archive, and inert when no round is
//      open (the send bar already disabled).
//   10. a chord fired while a submit is in flight does not double-send.
//   11. no second armed appearance: criteria 3 and 5 hold the chord's arrival at
//      Send to the click's own behaviour, label included.
//
// What this file deliberately does NOT do, and why:
//   - It never asserts that a newline character was inserted by plain Enter.
//     test/dom-stand-in.mjs implements no real text-editing model (no caret,
//     no insertion) -- see criterion 2's own check for what is asserted
//     instead (ev.defaultPrevented === false), which is the actual
//     observable proof a real browser's own newline-insertion depends on.
//   - It never asserts on native browser suppression of events dispatched at
//     a disabled element (e.g. a real browser refusing to deliver a
//     dispatched keydown to a disabled textarea at all) -- the stand-in does
//     not model that (see test/dom-stand-in.mjs's own note on
//     Element.disabled), so criterion 10's check dispatches directly at the
//     target and asserts on the HANDLER's own guard instead.
//   - Drag-to-rank and text-selection are out of scope entirely -- Cmd+Enter
//     never touches either.

import assert from 'node:assert/strict';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { StandInEvent } from './dom-stand-in.mjs';
import { check, finish, pageHarness } from './support.mjs';

const { loadBoard, openBlocks, withFetchCapture } = await pageHarness();

// Three question blocks, so "next question" and "last question" are
// meaningfully distinct, and one of them is a 'text' widget (the one
// rendering the rows="8" .answer-textarea, src/render.mjs:309) so criterion
// 1's second entry point (from an answer textarea, not just a note field)
// has something real to click into.
const BLOCK_SPEC = [
  { kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  { kind: 'question', prompt: 'Q2: explain in your own words', widget: 'text', options: [] },
  { kind: 'question', prompt: 'Q3: pick another', widget: 'single', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
];
const board = createBoard({ title: 'Cmd+Enter board traversal', blocks: BLOCK_SPEC });
const pageHtml = renderBoardPage(board);

/** Fill in a real, distinguishable answer on every question -- two chosen
 * single-select cards and typed free text -- through the real widgets, not
 * by writing into `board.answers` directly. Used by criterion 3 so a board
 * with nothing outstanding is filled in through a real gesture, not merely
 * asserted to be empty. */
function fillAnswers(document) {
  const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.trim() === 'Yes');
  assert.ok(yes, 'setup failure: no "Yes" option rendered');
  yes.dispatchEvent(new StandInEvent('click'));
  const beta = document.querySelectorAll('.choice-single').find(el => el.textContent.trim() === 'Beta');
  assert.ok(beta, 'setup failure: no "Beta" option rendered');
  beta.dispatchEvent(new StandInEvent('click'));
  const textarea = document.querySelector('.answer-textarea');
  assert.ok(textarea, 'setup failure: no free-text answer textarea rendered');
  textarea.value = 'a filled-in free-text answer';
  textarea.dispatchEvent(new StandInEvent('input'));
}

const CMD_ENTER = { key: 'Enter', metaKey: true };

// === criterion 1 ================================================================
// "Cmd+Enter in any note or answer textarea moves keyboard focus to the next
// question's note textarea and scrolls it into view." Both halves asserted,
// both entry points covered.

check('criterion 1: Cmd+Enter in a note textarea moves focus to the NEXT question\'s note field and scrolls it into view', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  assert.equal(blocks.length, 3, 'setup failure: expected 3 question blocks in the round');
  const note0 = blocks[0].querySelector('[data-note-for]');
  const note1 = blocks[1].querySelector('[data-note-for]');
  assert.ok(note0 && note1, 'setup failure: missing note field(s)');
  note0.focus();
  assert.equal(document.activeElement, note0, 'setup failure: focusing the first note field did not take effect');
  assert.equal(note1.scrollIntoViewCallCount, 0, 'setup failure: the next note field must not already be scrolled to');

  note0.dispatchEvent(new StandInEvent('keydown', CMD_ENTER));

  assert.equal(document.activeElement, note1, 'Cmd+Enter from a note textarea must move focus to the NEXT question\'s note field, not stay put or jump elsewhere');
  assert.equal(note1.scrollIntoViewCallCount, 1, 'the newly-focused note field must be scrolled into view exactly once');
});

check('criterion 1: Cmd+Enter in the text-widget answer textarea also advances to the NEXT question\'s note field and scrolls it into view', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  const answerTA = blocks[1].querySelector('.answer-textarea'); // block[1] is the 'text' widget question
  assert.ok(answerTA, 'setup failure: no text-widget answer-textarea in the fixture');
  const note2 = blocks[2].querySelector('[data-note-for]');
  assert.ok(note2, 'setup failure: missing the third question\'s note field');
  answerTA.focus();
  assert.equal(document.activeElement, answerTA, 'setup failure: focusing the answer textarea did not take effect');

  answerTA.dispatchEvent(new StandInEvent('keydown', CMD_ENTER));

  assert.equal(document.activeElement, note2, 'Cmd+Enter from an answer textarea must move focus to the NEXT question\'s note field, exactly like from a note field');
  assert.equal(note2.scrollIntoViewCallCount, 1, 'the newly-focused note field must be scrolled into view');
});

// === criterion 2 ================================================================
// "Plain Enter in any textarea still inserts a newline and moves nothing."
// No real text-insertion model here (see file header), so what's asserted is
// what IS observable: nothing moved, nothing scrolled, nothing armed,
// nothing submitted, and -- the real proof a browser would insert the
// newline itself -- the handler never called preventDefault().

check('criterion 2: plain Enter in a textarea moves no focus, scrolls nothing, arms nothing, submits nothing, and leaves ev.defaultPrevented === false', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  const note0 = blocks[0].querySelector('[data-note-for]');
  const note1 = blocks[1].querySelector('[data-note-for]');
  note0.focus();

  const ev = new StandInEvent('keydown', { key: 'Enter' }); // no metaKey/ctrlKey
  const calls = withFetchCapture(() => note0.dispatchEvent(ev));

  assert.equal(document.activeElement, note0, 'plain Enter must not move focus');
  assert.equal(note1.scrollIntoViewCallCount, 0, 'plain Enter must not scroll anything');
  assert.equal(document.getElementById('send-btn').textContent, 'Send', 'plain Enter must not arm Send');
  assert.equal(calls.length, 0, 'plain Enter must not submit anything');
  // The load-bearing assertion for this criterion: src/ui.mjs's handler calls
  // ev.preventDefault() on every branch that arms, moves focus, or submits --
  // never on plain Enter, which returns immediately on the modifier check. A
  // real browser only performs its own default action (inserting the
  // newline) when the default has been left unprevented, so this is the real
  // proof plain Enter never entered any of those branches, not an argument
  // standing in for one.
  assert.equal(ev.defaultPrevented, false, 'plain Enter must leave the keydown\'s default action (newline insertion) unprevented');
});

// === criterion 3 ================================================================
// "Cmd+Enter on an open round with nothing
// outstanding submits it on that press, with no relabel and no second
// press." Every question is answered first, through the real widgets, so
// outstandingBlocks() reports nothing left.

check('criterion 3: Cmd+Enter arriving at Send with nothing outstanding submits on that press -- no relabel, no second press', () => {
  const document = loadBoard(pageHtml);
  fillAnswers(document);
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.textContent, 'Send', 'setup failure: Send must start with its ordinary label');
  lastNote.focus();

  const calls = withFetchCapture(() => lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 1, 'the single chord must submit the board immediately -- nothing was outstanding');
  assert.equal(sendBtn.textContent, 'Send', 'a round with nothing outstanding must never relabel Send on arrival');
  assert.equal(sendBtn.classList.contains('warn'), false, 'a round with nothing outstanding must never apply the warning treatment');
});

// === criterion 4 ================================================================
// The other half of that rule: "including on a round that
// carries no question at all." A round holding only a non-question block
// (a pointer post) still has an open, live send bar, but zero
// '.question-block' elements -- the blocks.length === 0 branch.

check('criterion 4: Cmd+Enter on a round with no question block at all submits immediately, the same rule with nothing to be outstanding', () => {
  const noQBoard = createBoard({ title: 'No questions here', blocks: [{ kind: 'markdown', text: 'Just a pointer, nothing to answer.' }] });
  const document = loadBoard(renderBoardPage(noQBoard));
  const sendBtn = document.getElementById('send-btn');
  assert.equal(openBlocks(document).length, 0, 'setup failure: this fixture must render no question blocks');
  assert.equal(sendBtn.disabled, false, 'setup failure: the round is open, so Send must not start disabled');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 1, 'Cmd+Enter on a question-less open round must submit on that single press');
  assert.equal(sendBtn.textContent, 'Send', 'a question-less round must never relabel Send on arrival');
});

// === criterion 5 ================================================================
// "Cmd+Enter on an open round with something
// outstanding arms exactly as a click on Send does: same scroll, same
// ring, same label, same Escape." Two independently loaded, identically
// unfilled boards -- every question outstanding -- one driven by the
// keyboard chord, one by a plain click, compared field by field.

check('criterion 5: arriving at Send with something outstanding arms exactly as a click on Send does -- same scroll, same ring, same label', () => {
  const docA = loadBoard(pageHtml);
  const blocksA = openBlocks(docA);
  const lastNoteA = blocksA[blocksA.length - 1].querySelector('[data-note-for]');
  const sendBtnA = docA.getElementById('send-btn');
  lastNoteA.focus();
  const callsA = withFetchCapture(() => lastNoteA.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  const docB = loadBoard(pageHtml);
  const blocksB = openBlocks(docB);
  const sendBtnB = docB.getElementById('send-btn');
  const callsB = withFetchCapture(() => sendBtnB.dispatchEvent(new StandInEvent('click')));

  assert.equal(callsA.length, 0, 'arriving with something outstanding must not submit');
  assert.equal(callsB.length, 0, 'setup failure: a click with something outstanding must not submit either');
  assert.equal(sendBtnA.textContent, sendBtnB.textContent, 'the keyboard arm must show the identical label a click arm shows');
  assert.equal(sendBtnA.textContent, '3 questions unanswered — send anyway?', 'setup failure: all three questions are untouched, so the count must be 3');
  assert.equal(sendBtnA.classList.contains('warn'), sendBtnB.classList.contains('warn'), 'the keyboard arm must carry the identical warning ring as a click arm');
  assert.equal(blocksA[0].classList.contains('flagged'), blocksB[0].classList.contains('flagged'), 'the keyboard arm must flag the same (first outstanding) question a click arm flags');
  assert.equal(blocksA[0].scrollIntoViewCallCount, blocksB[0].scrollIntoViewCallCount, 'the keyboard arm must scroll the flagged question exactly as many times as a click arm does');
  assert.equal(docA.getElementById('send-status').textContent, docB.getElementById('send-status').textContent, 'the keyboard arm must set the identical send-status text a click arm sets');
});

// === criterion 7 ================================================================
// "Escape while Send is armed disarms it fully, restoring the button's
// label, ring and warning treatment, and clearing send-status, with
// nothing submitted."

check('criterion 7: Escape while armed disarms Send fully -- label, ring, warning treatment and send-status all restored, without submitting', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // arm (something outstanding)
  assert.notEqual(sendBtn.textContent, 'Send', 'setup failure: Send must be armed before Escape is tested');
  const flagged = blocks.find(b => b.classList.contains('flagged'));
  assert.ok(flagged, 'setup failure: some question must be flagged before Escape is tested');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' })));

  assert.equal(sendBtn.textContent, 'Send', 'Escape must restore Send\'s original label');
  assert.equal(sendBtn.classList.contains('warn'), false, 'Escape must remove the warning treatment');
  assert.equal(flagged.classList.contains('flagged'), false, 'Escape must remove the ring from the flagged question');
  assert.equal(document.getElementById('send-status').textContent, '', 'Escape must clear the "jumped to" status the arm set');
  assert.equal(calls.length, 0, 'Escape must not submit the board');
});

// === criterion 8 ================================================================
// "No keyboard path reaches #discuss-btn. Tabbing to it and pressing
// Cmd+Enter does not fire it."

check('criterion 8: tabbing to #discuss-btn and pressing Cmd+Enter does not fire it -- Discuss has no keyboard path at all', () => {
  const document = loadBoard(pageHtml);
  const discussBtn = document.getElementById('discuss-btn');
  const sendBtn = document.getElementById('send-btn');
  assert.ok(discussBtn, 'setup failure: no #discuss-btn rendered');
  discussBtn.focus(); // "tabbing to it"
  assert.equal(document.activeElement, discussBtn, 'setup failure: focusing Discuss did not take effect');

  const ev = new StandInEvent('keydown', CMD_ENTER);
  const calls = withFetchCapture(() => discussBtn.dispatchEvent(ev));

  assert.equal(calls.length, 0, 'Cmd+Enter targeting #discuss-btn must never fire a submit (of either action)');
  assert.equal(document.activeElement, discussBtn, 'focus must not move off Discuss -- this keyboard path is dead, not merely redirected');
  assert.equal(sendBtn.textContent, 'Send', 'Cmd+Enter on Discuss must not arm Send either');
  // The assertion that actually makes this criterion true in a browser, and the
  // one whose absence hid a real hole: the three above
  // only prove the HANDLER does not itself submit. #discuss-btn is a real
  // <button>, and a browser's default action for Enter on a focused button is to
  // activate it -- modifiers do not suppress that. So a guard that returned bare,
  // as this one first did, passed all three assertions above while the platform
  // went on to fire the button's own click listener and post
  // submitBoard('discuss'). This stand-in models no native activation (see its
  // header), so suppressing the default is the only observable proof available
  // here that the chord is genuinely dead rather than merely unhandled.
  assert.equal(ev.defaultPrevented, true, 'the handler must preventDefault on Discuss -- otherwise the browser natively activates the focused button and fires the irreversible Discuss submit');
});

// === criterion 9 ================================================================
// "Cmd+Enter does nothing at all in a read-only (file://) archive and
// nothing on a board with no open round (the send bar is already disabled
// there)." Two separate cases.

// An ablation recorded here because it is not self-evident from
// the assertions below: deleting the handler's own `if (readonly) return;` line
// leaves EVERY check in this file green. That is not a hole in this check, it is
// readonly being locked twice on purpose -- src/ui.mjs's hydrate-time blanket
// `qsa('textarea, input, button').forEach(el => el.disabled = true)` (see its own
// 'belt and suspenders' comment, and QUIRKS.md 'Readonly is locked twice -- CSS
// and JS') has already disabled #send-btn by the time any chord arrives, so the
// handler's `sendBtn.disabled` guard returns first and the readonly guard never
// gets a turn. There is no reachable state in production where readonly is true
// and the send button is live, so isolating that one line would mean asserting
// against a state the page cannot be in. Keep the line anyway: every other
// mutation handler in src/ui.mjs carries the same redundant guard, and the
// element-level lock has documented exceptions (.pull-out, the theme control)
// that a future one could easily extend to the send bar.
check('criterion 9a: Cmd+Enter does nothing at all in a read-only (file://) archive', () => {
  const document = loadBoard(pageHtml, { protocol: 'file:' });
  const before = document.activeElement;
  assert.equal(before, document.body, 'setup failure: nothing should be focused yet');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 0, 'Cmd+Enter must never submit anything in a read-only archive');
  assert.equal(document.activeElement, before, 'Cmd+Enter must not move focus in a read-only archive');
  assert.equal(document.getElementById('send-btn').textContent, 'Send', 'Cmd+Enter must not arm Send in a read-only archive');
});

check('criterion 9b: Cmd+Enter does nothing on a board with no open round (send-btn is rendered disabled, the real production mechanism)', () => {
  // A separate board, sent server-side through applySubmit exactly like the
  // daemon would once a round goes out, so renderBoardPage itself emits the
  // bare `disabled` attribute on #send-btn (src/render.mjs:1053-1056,
  // hasOpenRound) -- driving the REAL rendered attribute, not a hand-set
  // `.disabled = true` property.
  const sentBoard = createBoard({ title: 'Cmd+Enter -- no open round', blocks: BLOCK_SPEC });
  applySubmit(sentBoard, { action: 'send', answers: [], comments: [] }, 1);
  const document = loadBoard(renderBoardPage(sentBoard));
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.disabled, true, 'setup failure: send-btn must render disabled once its only round has been sent');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 0, 'Cmd+Enter must do nothing when the send bar is already disabled (no open round)');
  assert.equal(sendBtn.textContent, 'Send', 'Cmd+Enter must not arm an already-disabled Send button');
});

// === criterion 10 ===============================================================
// "Cmd+Enter on the last question of a board that is mid-submit does not
// double-send." Mid-submit: submitBoard has already run
// setSendBarEnabled(false), but the fetch has not resolved yet.

check('criterion 10: a Cmd+Enter chord fired while a submit is still in flight does not double-send', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // arm (nothing is filled in, so something is outstanding)

  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  // Never resolves: submitBoard's first act is setSendBarEnabled(false), so
  // #send-btn stays disabled for the whole window this check probes -- the
  // exact "mid-submit" state the criterion describes.
  globalThis.fetch = () => { fetchCallCount++; return new Promise(() => {}); };
  try {
    sendBtn.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // second chord: the real send
    assert.equal(fetchCallCount, 1, 'setup failure: the second chord must have actually sent once');
    assert.equal(sendBtn.disabled, true, 'setup failure: submitBoard must disable the send bar synchronously, before the fetch resolves');

    sendBtn.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // third chord, fired mid-flight
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCallCount, 1, 'a Cmd+Enter fired while the send bar is disabled (mid-submit) must not fire a second submit');
});

finish('Cmd+Enter');
