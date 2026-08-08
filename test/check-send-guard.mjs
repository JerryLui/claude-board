// Acceptance checks for the send guard (src/ui.mjs, search "the Send guard"):
// an incomplete round arms Send instead of sending it. Same harness idiom as
// test/check-enter.mjs, which this file sits beside and pattern-matches --
// drives the REAL src/ui.mjs client script, in the real DOM stand-in, through
// the actual click/keydown gestures, and asserts on what a reviewer would
// actually see (a scroll call, a ring, a relabelled button, a posted fetch
// body) rather than calling any internal function directly.
//
// Covered end to end:
//   3. a 'deferred' question counts as complete -- only 'unanswered' is
//      outstanding, so a deferred question is never the one Send flags.
//   4. a click on Send with any outstanding question arms instead of
//      submitting: it scrolls to and rings the FIRST outstanding question and
//      relabels the button (correctly singular at exactly one), without
//      posting anything.
//   5. a second click on the armed button submits the partial round, byte-
//      identical to what the Cmd+Enter arm/send route posts for the same
//      filled-in state (both call the identical armSendGuard, ADR.md entry
//      29); Escape disarms without submitting, restoring the label, the
//      button's color, and the ring.
//   one shared armed state: arming by click then confirming by Cmd+Enter (and
//      the reverse) sends on the second input, not a re-arm -- one sendArmed
//      flag, not two independently tracked ones.
//   6 (this chunk's half): the guard never engages in a read-only (file://)
//      archive -- a click on Send there posts nothing, arms nothing, rings
//      nothing.
//
// What this file deliberately does NOT do: re-litigate the Cmd+Enter
// traversal itself (advance-to-next-question, plain Enter, Discuss's dead
// keyboard path, the mid-submit double-send guard, or arriving at Send with
// nothing outstanding) -- all of that is test/check-enter.mjs's contract,
// and re-asserting it here would just be a second, driftable copy of the
// same checks.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
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

// Three question blocks -- same shape as check-enter.mjs's own fixture, so
// "the first outstanding one" and "deferred vs. unanswered" are meaningfully
// distinct positions rather than a single-question board where every rule
// collapses onto the same block.
const BLOCK_SPEC = [
  { kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  { kind: 'question', prompt: 'Q2: explain in your own words', widget: 'text', options: [] },
  { kind: 'question', prompt: 'Q3: pick another', widget: 'single', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
];
const board = createBoard({ title: 'Send guard', blocks: BLOCK_SPEC });
const pageHtml = renderBoardPage(board);

/** Parse the page and run the real `ui` client script against it -- identical
 * idiom to test/check-enter.mjs's loadBoard -- a fresh document every call,
 * so checks never share mutated state. */
function loadBoard(protocol) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: protocol || 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** The three question blocks in round order -- the exact set collectAnswers,
 * outstandingBlocks, and the guard itself all walk. */
function openBlocks(document) {
  return document.querySelectorAll('.round-open .question-block');
}

/** Answer a single-choice question by clicking the option carrying `label`,
 * through the real widget -- never by writing into board state directly. */
function answerSingle(block, label) {
  const opt = block.querySelectorAll('.choice-single').find(el => el.textContent.trim() === label);
  assert.ok(opt, `setup failure: no "${label}" option rendered in this block`);
  opt.dispatchEvent(new StandInEvent('click'));
}

/** Defer a question through its real Defer button. */
function deferBlock(block) {
  const btn = block.querySelector('.btn-defer');
  assert.ok(btn, 'setup failure: no Defer button rendered in this block');
  btn.dispatchEvent(new StandInEvent('click'));
}

/** Stub globalThis.fetch for the duration of `fn()`, capturing every posted
 * (url, method, JSON body) -- same idiom as check-enter.mjs's own
 * withFetchCapture. Restores the original fetch even if `fn` throws. */
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

// "A question is complete when it carries any status, answered or deferred
// alike; only unanswered counts as outstanding." The decision most likely to
// regress: a deferred question must never be the one Send arms on, and must
// never count toward the outstanding total.

check('a deferred question does not count as outstanding -- Send arms on the still-unanswered one instead, skipping the deferred one', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  answerSingle(blocks[0], 'Yes');       // Q1: answered
  deferBlock(blocks[1]);                // Q2: deferred, left blank -- must NOT count as outstanding
  // Q3: left entirely untouched -- the one and only outstanding question
  const sendBtn = document.getElementById('send-btn');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 0, 'a deferred + one truly unanswered question must still arm, not send');
  assert.equal(blocks[1].classList.contains('flagged'), false, 'the DEFERRED question must never be the one flagged');
  assert.equal(blocks[2].classList.contains('flagged'), true, 'the actually-unanswered question must be the one flagged');
  assert.equal(sendBtn.textContent, '1 question unanswered — send anyway?',
    'exactly one question (the deferred one does not count) must be reported as outstanding');
});

// "Pressing Send while questions are outstanding arms instead of submitting:
// it scrolls to the first question with no status, rings it, and relabels
// the button. It does not submit."

check('a click on Send with outstanding questions posts nothing and arms the button', () => {
  const document = loadBoard();
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.textContent, 'Send', 'setup failure: Send must start with its ordinary label');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 0, 'the first click on an incomplete round must not submit anything');
  assert.notEqual(sendBtn.textContent, 'Send', 'the first click must visibly relabel Send to show it is armed');
});

check('the flagged question is the FIRST one with no status, not merely any outstanding one', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  answerSingle(blocks[0], 'Yes'); // Q1: answered -- must never be flagged
  // Q2 and Q3 both left outstanding -- Q2 must be the one flagged, not Q3
  const sendBtn = document.getElementById('send-btn');

  sendBtn.dispatchEvent(new StandInEvent('click'));

  assert.equal(blocks[0].classList.contains('flagged'), false, 'an already-answered question must never be flagged');
  assert.equal(blocks[1].classList.contains('flagged'), true, 'the first outstanding question (Q2) must be flagged');
  assert.equal(blocks[2].classList.contains('flagged'), false, 'a LATER outstanding question (Q3) must not be flagged ahead of the first one');
  assert.equal(blocks[1].scrollIntoViewCallCount, 1, 'the flagged question must be scrolled into view');
  assert.equal(sendBtn.textContent, '2 questions unanswered — send anyway?', 'the label must count every outstanding question, plural at 2');
  assert.equal(document.getElementById('send-status').textContent, 'jumped to the first unanswered',
    'the send-status slot must say where the reviewer was sent');
});

// "A second press of the armed button submits the partial round exactly as
// today, and Escape disarms it, so a reviewer who genuinely wants a partial
// send never leaves the board."

check('a second click on the armed button submits, posting exactly what the Cmd+Enter arm/send route posts for the same partial state', () => {
  // Path A: the click guard. Answer Q1, defer Q2, leave Q3 outstanding,
  // click Send twice -- arm, then confirm.
  const docA = loadBoard();
  const blocksA = openBlocks(docA);
  answerSingle(blocksA[0], 'Yes');
  deferBlock(blocksA[1]);
  const sendBtnA = docA.getElementById('send-btn');
  sendBtnA.dispatchEvent(new StandInEvent('click')); // arms
  assert.equal(sendBtnA.textContent, '1 question unanswered — send anyway?', 'setup failure: first click must arm on the one outstanding question');
  const callsA = withFetchCapture(() => sendBtnA.dispatchEvent(new StandInEvent('click'))); // sends
  assert.equal(callsA.length, 1, 'the second click while armed must submit exactly once');

  // Path B: the SAME partial answers on an independent board, submitted via
  // the Cmd+Enter arm/send pair -- arriving at Send with something
  // outstanding now arms through the identical armSendGuard function the
  // click path calls (src/ui.mjs, ADR.md entry 29), the ground truth for
  // "exactly the same" (test/check-enter.mjs pins this route's own
  // contract). Proves the guard reuses submitBoard/collectAnswers rather
  // than posting its own, potentially divergent, body.
  const docB = loadBoard();
  const blocksB = openBlocks(docB);
  answerSingle(blocksB[0], 'Yes');
  deferBlock(blocksB[1]);
  const lastNoteB = blocksB[blocksB.length - 1].querySelector('[data-note-for]');
  const sendBtnB = docB.getElementById('send-btn');
  lastNoteB.focus();
  lastNoteB.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })); // arms (Q3 still outstanding)
  const callsB = withFetchCapture(() => sendBtnB.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true }))); // sends
  assert.equal(callsB.length, 1, 'setup failure: the Cmd+Enter route must still submit exactly once');

  assert.equal(callsA[0].method, 'POST');
  assert.match(callsA[0].url, /\/api\/board\/.+\/submit$/, `expected the submit route, got ${JSON.stringify(callsA[0].url)}`);
  assert.deepEqual(callsA[0].body, callsB[0].body,
    'the click guard\'s second press must post the identical body the Cmd+Enter arm/send route posts for the same partial state');
  assert.deepEqual(callsA[0].body.answers.map(a => a.status), ['answered', 'deferred', 'unanswered'],
    'the partial round must go out exactly as filled in -- Q3 still unanswered, not silently completed by sending');
});

check('Escape disarms the click-armed Send, restoring its label, color, and the ring, without submitting', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const sendBtn = document.getElementById('send-btn');
  sendBtn.dispatchEvent(new StandInEvent('click')); // arm
  assert.equal(sendBtn.classList.contains('warn'), true, 'setup failure: Send must be armed before Escape is tested');
  const flagged = blocks.find(b => b.classList.contains('flagged'));
  assert.ok(flagged, 'setup failure: some question must be flagged before Escape is tested');

  const calls = withFetchCapture(() => document.body.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' })));

  assert.equal(sendBtn.textContent, 'Send', 'Escape must restore Send\'s original label');
  assert.equal(sendBtn.classList.contains('warn'), false, 'Escape must remove the warning treatment');
  assert.equal(flagged.classList.contains('flagged'), false, 'Escape must remove the ring from the flagged question');
  assert.equal(document.getElementById('send-status').textContent, '', 'Escape must clear the "jumped to" status the guard set');
  assert.equal(calls.length, 0, 'Escape must not submit the board');
});

check('a third state is not reachable: after Escape disarms, Send behaves exactly like an unarmed board again (arms, does not send)', () => {
  const document = loadBoard();
  const sendBtn = document.getElementById('send-btn');
  sendBtn.dispatchEvent(new StandInEvent('click')); // arm
  document.body.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' })); // disarm

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click'))); // must re-arm, not send

  assert.equal(calls.length, 0, 'a click after Escape must arm again, not fall through to a send');
  assert.notEqual(sendBtn.textContent, 'Send', 'the re-click must re-arm the button');
});

// === one shared armed state (not two independently tracked ones) ===============
// "Two independent 'armed' flags on the same button is the failure mode to
// avoid: Escape must disarm whichever way it was armed, and an arm from
// either path must be visible to the other."

check('one shared armed state: arming by click, then confirming with Cmd+Enter, sends -- it does not re-arm a second, independent state', () => {
  const document = loadBoard();
  const sendBtn = document.getElementById('send-btn');
  sendBtn.dispatchEvent(new StandInEvent('click')); // click-arms (outstanding questions present)
  assert.equal(sendBtn.classList.contains('warn'), true, 'setup failure: click must arm the guard state');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })));

  assert.equal(calls.length, 1, 'Cmd+Enter while click-armed must submit -- the SAME sendArmed flag, not a second arm');
});

check('one shared armed state: arming by Cmd+Enter, then a plain click on Send, sends -- it does not re-arm a second, independent state', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })); // keyboard-arms (all three questions still outstanding)
  assert.equal(sendBtn.textContent, '3 questions unanswered — send anyway?', 'setup failure: Cmd+Enter must arm via the same guard label a click would show');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 1, 'a click on an already Cmd+Enter-armed Send must submit -- the SAME sendArmed flag, not a second arm');
});

// === the questions-left pill's own round-end agreement rule (ADR.md entry 27 --
// NOT the read-only-archive case covered just below) ============================================
// "The count is live... and it reaches zero exactly when the send guard would no
// longer arm." This file owns the send guard's own outstanding-question rule, so
// this is where the agreement case belongs: one
// check driving BOTH the pill (src/ui.mjs's questions-left-pill, via
// outstandingBlocks()) and the guard (a real click on Send) off the identical
// board state at each step, asserting they agree -- not two independent
// assertions that a version reading two different notions of "outstanding" could
// each still individually satisfy.

check('the questions-left pill and the send guard read the identical outstanding set at every step, and the pill reaches zero at the EXACT point a click on Send stops arming and submits instead', () => {
  const document = loadBoard();
  const blocks = openBlocks(document);
  const pill = document.getElementById('questions-left-pill');
  const sendBtn = document.getElementById('send-btn');
  assert.ok(pill, 'setup failure: no questions-left pill rendered');

  // All three outstanding: the guard arms on Q1 (first), and the pill already
  // agrees on the count before a single click is made.
  assert.equal(pill.textContent, '3 questions left');
  let calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 0, 'setup check: three outstanding must arm, not send');
  assert.equal(blocks[0].classList.contains('flagged'), true, 'setup check: the guard must flag Q1 first');
  document.body.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' })); // disarm, back to a clean slate

  // Answer Q1 -- two left. The guard now flags Q2 (the new first outstanding
  // question), and the pill's count agrees.
  answerSingle(blocks[0], 'Yes');
  assert.equal(pill.textContent, '2 questions left');
  calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 0);
  assert.equal(blocks[1].classList.contains('flagged'), true, 'the guard must now flag Q2');
  document.body.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));

  // Defer Q2 -- one left (Q3). The "deferred counts as complete" rule and
  // the pill's own matching rule (ADR.md entry 27) must
  // agree: neither the guard nor the pill count it.
  deferBlock(blocks[1]);
  assert.equal(pill.textContent, '1 question left', 'a deferred question must not count toward the pill\'s own outstanding total, exactly as it does not for the guard');
  calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 0);
  assert.equal(blocks[2].classList.contains('flagged'), true, 'the guard must skip the deferred Q2 and flag Q3');
  document.body.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));

  // Answer Q3 -- nothing left. The pill must read zero and hide itself, and
  // THIS is the exact moment the guard stops arming: a click on Send now
  // submits on the first press rather than arming a second time.
  answerSingle(blocks[2], 'Alpha');
  assert.equal(pill.textContent, '0 questions left', 'the pill must reach zero at the exact point nothing remains outstanding');
  assert.equal(pill.classList.contains('visible'), false, 'a count of zero must never be shown');
  calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'the guard must no longer arm once the pill reads zero -- a click now submits on the first press, exactly the moment the count reaches zero');
});

// === the read-only-archive case (this chunk's half) ============================================
// "None of this appears in a read-only archive opened from disk."

check('the send guard never engages in a read-only (file://) archive', () => {
  const document = loadBoard('file:');
  const blocks = openBlocks(document);
  const sendBtn = document.getElementById('send-btn');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 0, 'a read-only archive must never submit anything');
  assert.equal(sendBtn.textContent, 'Send', 'a read-only archive must never arm Send');
  assert.equal(sendBtn.classList.contains('warn'), false, 'a read-only archive must never apply the warning treatment');
  assert.equal(blocks.some(b => b.classList.contains('flagged')), false, 'a read-only archive must never ring any question');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall send-guard checks ok');
