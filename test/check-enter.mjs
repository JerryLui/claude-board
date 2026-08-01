// Acceptance checks for Cmd+Enter board traversal (src/ui.mjs, search
// "Cmd+Enter board traversal"): one chord that walks a board's question notes
// and, on the last question, arms then sends. Same harness idiom as
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
//   3. Cmd+Enter on the last question arms Send (focus + relabel), no submit.
//   4. a second Cmd+Enter while armed submits, byte-identical to a mouse
//      click on Send given the same filled-in answers.
//   5. Escape while armed disarms, restoring the label, no submit.
//   6. Discuss has no keyboard path at all.
//   7. Cmd+Enter is inert in a file:// archive, and inert when no round is
//      open (the send bar already disabled).
//   8. a chord fired while a submit is in flight does not double-send.
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
//     Element.disabled), so criterion 6's check dispatches directly at the
//     target and asserts on the HANDLER's own guard instead.
//   - Drag-to-rank and text-selection are out of scope entirely -- Cmd+Enter
//     never touches either.

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

/** Parse the page and run the real `ui` client script against it -- same
 * idiom as test/check-click.mjs's loadBoard -- a fresh document every call,
 * so checks never share mutated state. `protocol` selects the live
 * ('http:') vs. read-only archive ('file:') path, exactly like src/ui.mjs's
 * own `readonly = location.protocol === 'file:'` check. */
function loadBoard(protocol) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: protocol || 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** The three question blocks in round order, the exact set and order
 * `.round-open .question-block` -- what both collectAnswers and the
 * traversal handler itself walk. */
function openBlocks(document) {
  return document.querySelectorAll('.round-open .question-block');
}

/** Fill in a real, distinguishable answer on every question -- two chosen
 * single-select cards and typed free text -- through the real widgets, not
 * by writing into `board.answers` directly. Used by criterion 4 so the
 * keyboard-armed submit and a plain mouse-click submit are compared with
 * identically-filled boards, not two empty ones (which could accidentally
 * match even if collectAnswers were broken). */
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

/** Stub globalThis.fetch for the duration of `fn()`, capturing the single
 * (url, JSON body) pair a submit posts -- same idiom
 * test/check-comment-mode.mjs:307-318 uses to observe whether a submit
 * actually went out. Restores the original fetch even if `fn` throws. */
function withFetchCapture(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    fn();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

const CMD_ENTER = { key: 'Enter', metaKey: true };

// === criterion 1 ================================================================
// "Cmd+Enter in any note or answer textarea moves keyboard focus to the next
// question's note textarea and scrolls it into view." Both halves asserted,
// both entry points covered.

check('criterion 1: Cmd+Enter in a note textarea moves focus to the NEXT question\'s note field and scrolls it into view', () => {
  const document = loadBoard();
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
  const document = loadBoard();
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
  const document = loadBoard();
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
// "Cmd+Enter on the last question focuses #send-btn and visibly relabels it
// to indicate it is armed; the board is not submitted."

check('criterion 3: Cmd+Enter on the last question focuses #send-btn and relabels it armed, without submitting', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.textContent, 'Send', 'setup failure: Send must start with its ordinary label');
  lastNote.focus();

  const calls = withFetchCapture(() => lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(document.activeElement, sendBtn, 'Cmd+Enter on the last question must move focus to #send-btn');
  assert.equal(sendBtn.textContent, 'Press Enter again to send', 'Send must be visibly relabelled to show it is armed');
  assert.equal(calls.length, 0, 'the first chord on the last question must NOT submit the board');
});

// === criterion 4 ================================================================
// "A second Cmd+Enter while Send is armed submits the board, identically to
// a mouse click on Send." The strongest form: compare the actual posted
// body from the armed second chord against the body a plain click produces,
// from two independently but identically filled-in boards.

check('criterion 4: a second Cmd+Enter while armed submits, posting the exact same body a mouse click on Send would', () => {
  // Path A: fill in answers, then arm and fire via two keyboard chords.
  const docA = loadBoard();
  fillAnswers(docA);
  const blocksA = openBlocks(docA);
  const lastNoteA = blocksA[blocksA.length - 1].querySelector('[data-note-for]');
  const sendBtnA = docA.getElementById('send-btn');
  lastNoteA.focus();
  lastNoteA.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // arms
  assert.equal(sendBtnA.textContent, 'Press Enter again to send', 'setup failure: first chord must arm Send');
  const callsA = withFetchCapture(() => sendBtnA.dispatchEvent(new StandInEvent('keydown', CMD_ENTER))); // sends
  assert.equal(callsA.length, 1, 'the second chord while armed must submit exactly once');

  // Path B: fill in the SAME answers on an independent, freshly-loaded
  // board, then submit via the ordinary mouse gesture.
  const docB = loadBoard();
  fillAnswers(docB);
  const callsB = withFetchCapture(() => docB.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));
  assert.equal(callsB.length, 1, 'setup failure: a plain click on Send must submit exactly once');

  assert.equal(callsA[0].method, 'POST');
  assert.match(callsA[0].url, /\/api\/board\/.+\/submit$/, `expected the submit route, got ${JSON.stringify(callsA[0].url)}`);
  assert.deepEqual(callsA[0].body, callsB[0].body,
    'the body posted by the armed second chord must be identical to the body a mouse click on Send posts, given the same filled-in board');
});

// === criterion 5 ================================================================
// "Escape while Send is armed disarms it, restoring the button's label, with
// nothing submitted."

check('criterion 5: Escape while armed disarms Send, restoring its original label, without submitting', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // arm
  assert.equal(sendBtn.textContent, 'Press Enter again to send', 'setup failure: Send must be armed before Escape is tested');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' })));

  assert.equal(sendBtn.textContent, 'Send', 'Escape must restore Send\'s original label');
  assert.equal(calls.length, 0, 'Escape must not submit the board');
});

// === criterion 6 ================================================================
// "No keyboard path reaches #discuss-btn. Tabbing to it and pressing
// Cmd+Enter does not fire it."

check('criterion 6: tabbing to #discuss-btn and pressing Cmd+Enter does not fire it -- Discuss has no keyboard path at all', () => {
  const document = loadBoard();
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
  // one whose absence hid a real hole (director /check finding): the three above
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

// === criterion 7 ================================================================
// "Cmd+Enter does nothing at all in a read-only (file://) archive and
// nothing on a board with no open round (the send bar is already disabled
// there)." Two separate cases.

// Director-verified ablation, recorded here because it is not self-evident from
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
// element-level lock has documented exceptions (.expand-btn, the theme control)
// that a future one could easily extend to the send bar.
check('criterion 7a: Cmd+Enter does nothing at all in a read-only (file://) archive', () => {
  const document = loadBoard('file:');
  const before = document.activeElement;
  assert.equal(before, document.body, 'setup failure: nothing should be focused yet');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 0, 'Cmd+Enter must never submit anything in a read-only archive');
  assert.equal(document.activeElement, before, 'Cmd+Enter must not move focus in a read-only archive');
  assert.equal(document.getElementById('send-btn').textContent, 'Send', 'Cmd+Enter must not arm Send in a read-only archive');
});

check('criterion 7b: Cmd+Enter does nothing on a board with no open round (send-btn is rendered disabled, the real production mechanism)', () => {
  // A separate board, sent server-side through applySubmit exactly like the
  // daemon would once a round goes out, so renderBoardPage itself emits the
  // bare `disabled` attribute on #send-btn (src/render.mjs:1053-1056,
  // hasOpenRound) -- driving the REAL rendered attribute, not a hand-set
  // `.disabled = true` property.
  const sentBoard = createBoard({ title: 'Cmd+Enter -- no open round', blocks: BLOCK_SPEC });
  applySubmit(sentBoard, { action: 'send', answers: [], comments: [] }, 1);
  const document = parseHTML(renderBoardPage(sentBoard));
  new Function('document', 'window', 'location', ui)(document, document.defaultView, { protocol: 'http:' });
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.disabled, true, 'setup failure: send-btn must render disabled once its only round has been sent');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)));

  assert.equal(calls.length, 0, 'Cmd+Enter must do nothing when the send bar is already disabled (no open round)');
  assert.equal(sendBtn.textContent, 'Send', 'Cmd+Enter must not arm an already-disabled Send button');
});

// === criterion 8 ================================================================
// "Cmd+Enter on the last question of a board that is mid-submit does not
// double-send." Mid-submit: submitBoard has already run
// setSendBarEnabled(false), but the fetch has not resolved yet.

check('criterion 8: a Cmd+Enter chord fired while a submit is still in flight does not double-send', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', CMD_ENTER)); // arm

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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall Cmd+Enter checks ok');
