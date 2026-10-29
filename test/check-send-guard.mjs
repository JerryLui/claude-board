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
//   Discuss in chat posts the body Send would, differing only in its action.
//   a rank question is answered by the order it shows: neither the guard nor
//      the pill ever counts an untouched rank list, Send posts it as
//      'answered' with the rendered order as its choice, and Defer is the one
//      way to leave it open -- on a freshly loaded page, on a round pushed
//      over SSE, and never on a round already sent.
//   a sent round is never offered for sending again: a Send that lands keeps
//      the send bar disabled and only a failed one hands it back; the body
//      names the open round, and the daemon's 409 for a round already sent
//      reads as already sent, not as an error to retry.
//   what a re-render must keep: a Defer on a question an amend re-renders
//      unchanged, and the fold's safety valve re-measuring a pushed round
//      once it is attached.
//
// What this file deliberately does NOT do: re-litigate the Cmd+Enter
// traversal itself (advance-to-next-question, plain Enter, Discuss's dead
// keyboard path, the mid-submit double-send guard, or arriving at Send with
// nothing outstanding) -- all of that is test/check-enter.mjs's contract,
// and re-asserting it here would just be a second, driftable copy of the
// same checks.

import assert from 'node:assert/strict';
import { createBoard, addRound, amendRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
// The daemon's own push builder, as test/check-amend-integrity.mjs imports it: an
// amend payload rebuilt here would assert a local copy of the rule.
import { buildRoundPushPayload } from '../src/server.mjs';
import { StandInEvent } from './dom-stand-in.mjs';
import { check, checkAsync, finish, flush, pageHarness } from './support.mjs';

const { loadBoard, loadBoardWithEventSource, openBlocks, answerSingle, deferBlock, withFetchCapture } = await pageHarness();

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

// "A question is complete when it carries any status, answered or deferred
// alike; only unanswered counts as outstanding." The decision most likely to
// regress: a deferred question must never be the one Send arms on, and must
// never count toward the outstanding total.

check('a deferred question does not count as outstanding -- Send arms on the still-unanswered one instead, skipping the deferred one', () => {
  const document = loadBoard(pageHtml);
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

check('the flagged question is the FIRST one with no status, not merely any outstanding one', () => {
  const document = loadBoard(pageHtml);
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
  const docA = loadBoard(pageHtml);
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
  // click path calls (src/ui.mjs), the ground truth for
  // "exactly the same" (test/check-enter.mjs pins this route's own
  // contract). Proves the guard reuses submitBoard/collectAnswers rather
  // than posting its own, potentially divergent, body.
  const docB = loadBoard(pageHtml);
  const blocksB = openBlocks(docB);
  answerSingle(blocksB[0], 'Yes');
  deferBlock(blocksB[1]);
  const lastNoteB = blocksB[blocksB.length - 1].querySelector('[data-note-for]');
  const sendBtnB = docB.getElementById('send-btn');
  lastNoteB.focus();
  lastNoteB.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })); // arms (Q3 still outstanding)
  const callsB = withFetchCapture(() => sendBtnB.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true }))); // sends
  assert.equal(callsB.length, 1, 'setup failure: the Cmd+Enter route must still submit exactly once');

  for (const [calls, path] of [[callsA, 'click'], [callsB, 'Cmd+Enter']]) {
    assert.equal(calls[0].method, 'POST', `the ${path} route must POST`);
    assert.match(calls[0].url, /\/api\/board\/.+\/submit$/, `expected the ${path} route to hit the submit route, got ${JSON.stringify(calls[0].url)}`);
  }
  assert.deepEqual(callsA[0].body, callsB[0].body,
    'the click guard\'s second press must post the identical body the Cmd+Enter arm/send route posts for the same partial state');
  assert.deepEqual(callsA[0].body.answers.map(a => a.status), ['answered', 'deferred', 'unanswered'],
    'the partial round must go out exactly as filled in -- Q3 still unanswered, not silently completed by sending');
});

check('Escape disarms the click-armed Send, restoring its label, color, and the ring, without submitting', () => {
  const document = loadBoard(pageHtml);
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
  const document = loadBoard(pageHtml);
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
  const document = loadBoard(pageHtml);
  const sendBtn = document.getElementById('send-btn');
  sendBtn.dispatchEvent(new StandInEvent('click')); // click-arms (outstanding questions present)
  assert.equal(sendBtn.classList.contains('warn'), true, 'setup failure: click must arm the guard state');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })));

  assert.equal(calls.length, 1, 'Cmd+Enter while click-armed must submit -- the SAME sendArmed flag, not a second arm');
});

check('one shared armed state: arming by Cmd+Enter, then a plain click on Send, sends -- it does not re-arm a second, independent state', () => {
  const document = loadBoard(pageHtml);
  const blocks = openBlocks(document);
  const lastNote = blocks[blocks.length - 1].querySelector('[data-note-for]');
  const sendBtn = document.getElementById('send-btn');
  lastNote.focus();
  lastNote.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })); // keyboard-arms (all three questions still outstanding)
  assert.equal(sendBtn.textContent, '3 questions unanswered — send anyway?', 'setup failure: Cmd+Enter must arm via the same guard label a click would show');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 1, 'a click on an already Cmd+Enter-armed Send must submit -- the SAME sendArmed flag, not a second arm');
});

// === the questions-left pill's own round-end agreement rule
// (NOT the read-only-archive case covered just below) ============================================
// "The count is live... and it reaches zero exactly when the send guard would no
// longer arm." This file owns the send guard's own outstanding-question rule, so
// this is where the agreement case belongs: one
// check driving BOTH the pill (src/ui.mjs's questions-left-pill, via
// outstandingBlocks()) and the guard (a real click on Send) off the identical
// board state at each step, asserting they agree -- not two independent
// assertions that a version reading two different notions of "outstanding" could
// each still individually satisfy.

check('the questions-left pill and the send guard read the identical outstanding set at every step, and the pill reaches zero at the EXACT point a click on Send stops arming and submits instead', () => {
  const document = loadBoard(pageHtml);
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
  // the pill's own matching rule must
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
  const document = loadBoard(pageHtml, { protocol: 'file:' });
  const blocks = openBlocks(document);
  const sendBtn = document.getElementById('send-btn');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 0, 'a read-only archive must never submit anything');
  assert.equal(sendBtn.textContent, 'Send', 'a read-only archive must never arm Send');
  assert.equal(sendBtn.classList.contains('warn'), false, 'a read-only archive must never apply the warning treatment');
  assert.equal(blocks.some(b => b.classList.contains('flagged')), false, 'a read-only archive must never ring any question');
});

// === Discuss in chat: the other way out, through the same submit ================
// Discuss returns "whatever is filled in", partial answers being the point, so a
// second, hand-copied submit path is how it would quietly come to carry less than
// Send. Two boards filled identically, one sent and one discussed: the bodies
// must differ in `action` alone.

check('Discuss posts exactly the body Send posts for the same filled-in board, queued comment included, differing only in action -- and posts nothing in a read-only archive', () => {
  const board = createBoard({
    title: 'Two ways out',
    blocks: [singleSpec(), { kind: 'html', html: '<p id="mock">the artifact</p>' }],
  });
  const htmlId = board.blocks[1].id;
  const html = renderBoardPage(board);
  function fillAndPress(buttonId, protocol = 'http:') {
    const document = loadBoard(html, { protocol });
    answerSingle(openBlocks(document)[0], 'Yes');
    document.querySelector(`.comment-btn[data-block-id="${htmlId}"]`).dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + htmlId);
    if (form) {
      form.querySelector('input[type=text]').value = 'a queued remark';
      form.dispatchEvent(new StandInEvent('submit'));
    }
    return withFetchCapture(() => document.getElementById(buttonId).dispatchEvent(new StandInEvent('click')));
  }
  const sent = fillAndPress('send-btn');
  const discussed = fillAndPress('discuss-btn');
  assert.equal(sent.length, 1, 'setup failure: a complete round must send on the first press');
  assert.equal(discussed.length, 1, 'Discuss must post once');
  assert.equal(sent[0].body.action, 'send');
  assert.equal(discussed[0].body.action, 'discuss', 'the posted body must carry the action the reviewer chose');
  assert.equal(discussed[0].method, sent[0].method);
  assert.equal(discussed[0].url, sent[0].url, 'both go to the one submit route');
  const { action: sentAction, ...sentRest } = sent[0].body;
  const { action: discussedAction, ...discussedRest } = discussed[0].body;
  assert.deepEqual(discussedRest, sentRest, 'everything but the action must be identical: answers, round and queued comments');
  assert.equal(discussedRest.comments.length, 1, 'setup failure: the queued comment must ride both');

  assert.deepEqual(fillAndPress('discuss-btn', 'file:'), [], 'Discuss must post nothing in a read-only archive');
});

// === a rank question is answered by the order it shows =========================
//
// A rank list always SHOWS an order, so there is no blank state for the reviewer
// to see: what is on screen is the answer from the moment it renders, and Defer
// is the one way to leave it open. What that has to mean for this file's own
// subject -- the guard, the pill, and the body a Send posts -- is asserted here
// through the real widgets, never by calling currentAnswer directly.
//
// Ablation for every check below: gate src/ui.mjs's rank branch on an
// interaction flag again ('answered: !!touched[qid]') and an untouched list
// goes back to 'unanswered', arming the guard and counting toward the pill.

/** Fresh block literals every call -- createBoard normalizes in place (it mints
 * ids onto the blocks it is handed), so one shared literal cannot seed two boards. */
function rankSpec(labels) {
  return { kind: 'question', prompt: 'Order these', widget: 'rank', options: labels.map(label => ({ label })) };
}

function singleSpec() {
  return { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
}

/** A rank question and a single-choice one, in that order: the rank is never
 * what the guard counts or rings, and the single-choice one is the question
 * that legitimately is. */
function loadRankAndSingle() {
  const board = createBoard({ title: 'Rank default', blocks: [rankSpec(['A', 'B', 'C']), singleSpec()] });
  return loadBoard(renderBoardPage(board));
}

check('an untouched rank list is answered by the order it shows: Send posts it as answered with the rendered order as its choice, and the guard neither counts nor rings it', () => {
  const document = loadRankAndSingle();
  const blocks = openBlocks(document);
  const sendBtn = document.getElementById('send-btn');
  const pill = document.getElementById('questions-left-pill');

  assert.equal(pill.textContent, '1 question left',
    'only the single-choice question is outstanding: the rank list already shows an order, so it is answered');

  const armed = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(armed.length, 0, 'setup failure: the untouched single-choice question must still arm the guard');
  assert.equal(sendBtn.textContent, '1 question unanswered — send anyway?',
    'the untouched rank must not be counted among the outstanding questions');
  assert.equal(blocks[0].classList.contains('flagged'), false, 'the rank question must never be the one the guard rings');
  assert.equal(blocks[1].classList.contains('flagged'), true, 'the single-choice question must be the one flagged');

  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'setup failure: the second press must submit');
  const [rank, single] = calls[0].body.answers;
  assert.equal(rank.status, 'answered', 'an untouched rank list goes out answered, never unanswered');
  assert.deepEqual(rank.choice, ['A', 'B', 'C'], 'and its choice is the exact order the reviewer was shown');
  assert.equal(single.status, 'unanswered', 'the genuinely blank question is still reported blank');
});

check('a round whose only question is a rank leaves nothing outstanding: the pill reads zero and the first press of Send submits', () => {
  const board = createBoard({ title: 'Rank only', blocks: [rankSpec(['A', 'B', 'C'])] });
  const document = loadBoard(renderBoardPage(board));
  const pill = document.getElementById('questions-left-pill');

  assert.equal(pill.textContent, '0 questions left', 'a rank question is never outstanding');
  assert.equal(pill.classList.contains('visible'), false, 'a count of zero must never be shown');

  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'nothing is outstanding, so the first press must submit rather than arm');
  assert.deepEqual(calls[0].body.answers.map(a => a.status), ['answered']);
});

check('Defer is the one way to leave a rank open: a deferred untouched rank posts as deferred, carrying the order it showed', () => {
  const document = loadRankAndSingle();
  const blocks = openBlocks(document);
  deferBlock(blocks[0]);
  answerSingle(blocks[1], 'Yes');

  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 1, 'a deferred rank counts as complete, so the first press submits');
  assert.equal(calls[0].body.answers[0].status, 'deferred',
    'defer must override the order-is-the-answer default -- it is the one way to leave a rank open');
  // The choice rides along: PROTOCOL.md pins that a caller reads `status` and
  // never infers from `choice`, precisely because a deferred answer may carry
  // one (src/board.mjs, normalizeStatus).
  assert.deepEqual(calls[0].body.answers[0].choice, ['A', 'B', 'C']);
});

check('a rank arriving in a round pushed over SSE is answered by the order it shows too', () => {
  const board = createBoard({ title: 'Rank over SSE', blocks: [singleSpec()] });
  const { document, es: captured } = loadBoardWithEventSource(renderBoardPage(board));
  answerSingle(openBlocks(document)[0], 'Yes');

  const round2 = addRound(board, { blocks: [rankSpec(['D', 'E'])] });
  const pushedRankId = board.blocks[1].id;
  captured.dispatch('round', JSON.stringify({
    round: round2,
    mode: 'new-round',
    blockIds: [pushedRankId],
    html: renderRoundSection(board, round2, groupCommentsByBlock([])),
    board,
  }));

  assert.equal(document.getElementById('questions-left-pill').textContent, '0 questions left',
    'the pushed round is re-wired, so its rank list is answered by the order it shows and nothing is outstanding');

  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'nothing outstanding: the first press must submit');
  const pushedRank = calls[0].body.answers.find(a => a.id === pushedRankId);
  assert.ok(pushedRank, 'the pushed round\'s rank question must be collected at all');
  assert.equal(pushedRank.status, 'answered',
    'a rank that arrived over a push is answered by the order it shows, exactly like one that was on the page at load');
  assert.deepEqual(pushedRank.choice, ['D', 'E']);
});

check('a rank on a round already sent is never re-collected by a later Send', () => {
  const board = createBoard({ title: 'Sent rank', blocks: [rankSpec(['A', 'B', 'C'])] });
  const sentRank = board.blocks[0].id;
  applySubmit(board, { action: 'send', answers: [{ id: sentRank, status: 'deferred', choice: null, note: '' }], comments: [] }, 1);
  addRound(board, { blocks: [singleSpec()] });
  const document = loadBoard(renderBoardPage(board));

  answerSingle(openBlocks(document)[0], 'Yes');
  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));

  assert.equal(calls.length, 1, 'setup failure: the open round must submit on the first press');
  assert.equal(calls[0].body.answers.length, 1, 'only the OPEN round is collected -- the sent round\'s rank must not ride along');
  assert.equal(calls[0].body.answers.every(a => a.id !== sentRank), true,
    'a rank deferred on a sent round must never be silently rewritten to answered by a later Send');
});

// AC 4's sent-round half, here because this is the file that already drives a
// round from open to sent through the real client script. A round collapsing
// into history makes its ANSWERS immutable; it does not make its long context
// unreadable, and a settled round is precisely where someone re-reads one -- so
// the fold's control gets the same carve-out from the sent-round disable loop
// that the Pull-out has (src/ui.mjs's markRoundHistory). The
// server-side marking, and the archive half of the same rule, are pinned in
// test/check-pure.mjs and test/check-archive.mjs respectively.

check('the fold\'s Show more control stays live on a round that has just gone to history, while every other control in it is disabled', () => {
  const longProse = Array.from({ length: 20 }, (_, i) => `- a point worth reading, number ${i + 1}`).join('\n');
  const board = createBoard({
    title: 'Fold on a sent round',
    blocks: [{ ...singleSpec(), context: [{ kind: 'markdown', text: longProse }] }],
  });
  const { document, es: captured } = loadBoardWithEventSource(renderBoardPage(board));
  const round1 = document.querySelector('.round[data-round="1"]');
  const control = round1.querySelector('.fold-toggle');
  assert.ok(control, 'setup failure: the context item must be long enough to fold');
  assert.equal(control.disabled, false, 'setup failure: it must start live on the open round');

  // Round 1 goes to history live, exactly as a push does it -- markRoundHistory
  // is the loop the carve-out lives in.
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const round2 = addRound(board, { blocks: [singleSpec()] });
  captured.dispatch('round', JSON.stringify({
    round: round2,
    mode: 'new-round',
    blockIds: [board.blocks[1].id],
    html: renderRoundSection(board, round2, groupCommentsByBlock([])),
    board,
  }));
  assert.equal(round1.classList.contains('round-history'), true, 'setup failure: round 1 must have collapsed into history');

  assert.equal(round1.querySelector('.btn-defer').disabled, true, 'the sent round\'s own controls are disabled, as always');
  assert.equal(round1.querySelector('.choice-single').disabled, true);
  assert.equal(control.disabled, false, 'but the fold control survives the pass -- the same carve-out .pull-out gets');

  const item = control.parentElement;
  assert.equal(item.classList.contains('folded'), true, 'setup failure: the item must still be folded');
  control.dispatchEvent(new StandInEvent('click'));
  assert.equal(item.classList.contains('folded'), false, 'and it still opens: a settled round is where the context gets re-read');
  assert.equal(control.textContent, 'Show less');
  assert.equal(control.getAttribute('aria-expanded'), 'true');
});

// === a sent round is never offered for sending again ============================
//
// #send-btn lives in .send-bar, OUTSIDE any round section, so markRoundHistory
// (which disables everything inside the round it collapses) never reaches it and
// no CSS hides it. With the old unconditional re-enable in .finally(), a plain
// double-click posted twice: the second landed on an already-sent round, and its
// comments were appended again with fresh numbers -- duplicate pins for one
// comment.

/** Press Send on a complete round with fetch answering `respond()`, and let the
 * submit's .then chain land. Returns what was posted. */
async function pressSendAndLand(document, respond) {
  const original = globalThis.fetch;
  const posted = [];
  globalThis.fetch = (url, opts) => { posted.push(JSON.parse(opts.body)); return respond(); };
  try {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush(1); // a macrotask drains the whole .then chain
  } finally {
    globalThis.fetch = original;
  }
  return posted;
}

await checkAsync('a Send that lands leaves the send bar disabled, and only a failed one hands it back for a retry', async () => {
  for (const [outcome, respond, disabledAfter, statusText] of [
    ['landed', () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }), true, 'Sent.'],
    ['refused with a 500', () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }), false, 'Error: submit failed: 500'],
    ['lost on the wire', () => Promise.reject(new Error('network down')), false, 'Error: network down'],
  ]) {
    const document = loadBoard(renderBoardPage(createBoard({ title: 'Send once', blocks: [singleSpec()] })));
    answerSingle(openBlocks(document)[0], 'Yes');
    const posted = await pressSendAndLand(document, respond);
    assert.equal(posted.length, 1, `setup failure (${outcome}): a complete round must submit on the first press`);
    assert.equal(document.getElementById('send-btn').disabled, disabledAfter,
      disabledAfter
        ? 'a Send that landed must leave Send disabled: the round is out, and a second press would post it again'
        : `a Send ${outcome} sent nothing, so Send must come back for a retry`);
    assert.equal(document.getElementById('discuss-btn').disabled, disabledAfter, `Discuss follows Send (${outcome})`);
    assert.equal(document.getElementById('send-status').textContent, statusText);
  }
});

await checkAsync('Send names the open round in its body, and a 409 for a round already sent reads as already sent: no error, and no Send offering it again', async () => {
  const board = createBoard({ title: 'Already sent', blocks: [singleSpec()] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [singleSpec()] });
  const document = loadBoard(renderBoardPage(board));
  answerSingle(openBlocks(document)[0], 'Yes');

  const posted = await pressSendAndLand(document, () => Promise.resolve({ ok: false, status: 409, json: async () => ({}) }));
  assert.equal(posted.length, 1, 'setup failure: the open round must submit on the first press');
  assert.equal(posted[0].round, 2, 'the body must name the round it is for, or the daemon cannot refuse a stale submit');
  assert.equal(document.getElementById('send-status').textContent, 'Already sent.',
    'a 409 means the round already went out -- not a red error the reviewer clears by pressing Send again');
  assert.equal(document.getElementById('send-btn').disabled, true, 'and Send stays disabled, as on a Send that landed');
});

// === Send covers the page on screen ==============================================
// The daemon stores only the answers of the round a submit names, so the check,
// the count, the ask and the posted answers are the page on screen's alone: an
// earlier page still open keeps what was typed on it and its pager dot, and
// sends from its own page.

await checkAsync('Send on the newest page covers that page alone: an earlier open page\'s blank neither counts nor asks, keeps its typed note and its dot, and asks about its blank from its own page', async () => {
  const q = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = createBoard({ title: 'Two open pages', blocks: [q('P1: ship it?'), q('P1: rename it?')] });
  const round2 = addRound(board, { title: 'Second page', blocks: [q('P2: merge it?'), q('P2: tag it?'), q('P2: announce it?')] });
  const [p1a, p1b, p2a, p2b, p2c] = board.blocks.map(b => b.id);
  const { document, es: captured } = loadBoardWithEventSource(renderBoardPage(board));
  const block = id => document.querySelector(`.question-block[data-block-id="${id}"]`);
  const page = n => document.querySelector(`.round-page[data-round="${n}"]`);
  const sendBtn = document.getElementById('send-btn');
  const pill = document.getElementById('questions-left-pill');
  const press = () => withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));

  assert.equal(pill.textContent, '3 questions left', 'the pill counts the page on screen, not the earlier page\'s two');
  page(1).dispatchEvent(new StandInEvent('click'));
  assert.equal(pill.textContent, '2 questions left', 'flipped to page 1, the pill counts page 1');
  answerSingle(block(p1a), 'Yes');
  const note = block(p1a).querySelector('textarea[data-note-for]');
  note.value = 'keep this note';
  note.dispatchEvent(new StandInEvent('input'));
  assert.equal(pill.textContent, '1 question left');

  page(round2).dispatchEvent(new StandInEvent('click'));
  answerSingle(block(p2a), 'Yes');
  answerSingle(block(p2b), 'No');
  deferBlock(block(p2c));
  assert.equal(pill.textContent, '0 questions left', 'page 2 is complete; page 1\'s blank is not on screen');
  const sent = press();
  assert.equal(sent.length, 1, 'Send on a complete page posts on the first press, with no ask about another page');
  assert.equal(sendBtn.textContent, 'Send', 'and never relabels to the unanswered ask');
  assert.equal(block(p1b).classList.contains('flagged'), false, 'nor rings the earlier page\'s blank');
  assert.equal(sent[0].body.round, round2, 'the body names the page on screen');
  assert.deepEqual(sent[0].body.answers.map(a => [a.id, a.status, a.choice]),
    [[p2a, 'answered', 'Yes'], [p2b, 'answered', 'No'], [p2c, 'deferred', null]], 'only that page\'s answers are posted');

  applySubmit(board, { action: 'send', answers: sent[0].body.answers, comments: [] }, round2);
  captured.dispatch('submitted', JSON.stringify({ round: round2, board, html: renderRoundSection(board, round2, groupCommentsByBlock([])) }));
  await flush(1);
  assert.equal(page(1).classList.contains('round-page-owed'), true, 'the earlier page keeps its dot');
  assert.equal(page(round2).classList.contains('round-page-owed'), false);

  page(1).dispatchEvent(new StandInEvent('click'));
  assert.equal(block(p1a).querySelector('textarea[data-note-for]').value, 'keep this note', 'the earlier page keeps its typed note');
  assert.equal(sendBtn.disabled, false, 'an earlier unsent page sends from its own page');
  assert.equal(press().length, 0, 'its own Send asks about its blank');
  assert.equal(sendBtn.textContent, '1 question unanswered — send anyway?');
  assert.equal(block(p1b).classList.contains('flagged'), true);
  const confirmed = press();
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].body.round, 1);
  assert.deepEqual(confirmed[0].body.answers.map(a => [a.id, a.status, a.choice, a.note]),
    [[p1a, 'answered', 'Yes', 'keep this note'], [p1b, 'unanswered', null, '']]);
});

check('an armed Send does not carry across a page flip: Send on the arriving page runs its own check', () => {
  const q = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = createBoard({ title: 'Armed flip', blocks: [q('P1: ship it?')] });
  addRound(board, { blocks: [q('P2: merge it?')] });
  const document = loadBoard(renderBoardPage(board));
  const sendBtn = document.getElementById('send-btn');
  sendBtn.dispatchEvent(new StandInEvent('click'));
  assert.equal(sendBtn.textContent, '1 question unanswered — send anyway?', 'setup: page 2\'s blank arms Send');
  document.querySelector('.round-page[data-round="1"]').dispatchEvent(new StandInEvent('click'));
  assert.equal(sendBtn.textContent, 'Send', 'leaving the page disarms');
  const calls = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 0, 'page 1\'s own blank arms instead of sending');
  assert.equal(document.querySelector(`.question-block[data-block-id="${board.blocks[0].id}"]`).classList.contains('flagged'), true);
});

// === what a re-render must keep ================================================

check('a Defer survives an amend that re-renders its question unchanged: the fresh button shows it, matching what Send posts', () => {
  const q = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = createBoard({ title: 'Defer across an amend', blocks: [q('Q1: ship it?'), q('Q2: rename it?')] });
  const [q1, q2] = board.blocks.map(b => b.id);
  const { document, es: captured } = loadBoardWithEventSource(renderBoardPage(board));
  const block = id => document.querySelector(`.question-block[data-block-id="${id}"]`);
  const before = block(q1).querySelector('.btn-defer');
  deferBlock(block(q1));
  assert.equal(before.classList.contains('active'), true, 'setup failure: the Defer press must show on the button');

  // The agent re-posts the round with Q1 as it was and Q2 reworded: both are
  // re-rendered, but only Q2 changed, so only Q2's field state is cleared.
  amendRound(board, { blocks: [{ id: q1, ...q('Q1: ship it?') }, { id: q2, ...q('Q2: rename it to what?') }] });
  captured.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 1, 'amend', [q1, q2])));
  const after = block(q1).querySelector('.btn-defer');
  assert.notEqual(after, before, 'setup failure: the amend must have re-rendered Q1');
  assert.equal(after.classList.contains('active'), true,
    'the re-rendered Defer button must show the Defer the tab still holds, or the reviewer sees an open question Send reports deferred');

  answerSingle(block(q2), 'Yes');
  const calls = withFetchCapture(() => document.getElementById('send-btn').dispatchEvent(new StandInEvent('click')));
  assert.equal(calls.length, 1, 'setup failure: Q1 deferred and Q2 answered, so the first press must submit');
  assert.equal(calls[0].body.answers.find(a => a.id === q1).status, 'deferred', 'and Send posts it deferred, as the button says');
});

check('a fold that settles once a pushed round is attached is dropped then, while one that still overflows stays folded', () => {
  // The push wires its fragment DETACHED, where the safety valve measures 0/0 and
  // keeps the server's marking (QUIRKS.md: "`scrollHeight` and `clientHeight`
  // model exactly one fact"), so only the re-measure after attaching can drop a
  // fold that turns out to fit. The heights are declared on the pushed markup,
  // read only once it is in the document.
  const longProse = n => Array.from({ length: 20 }, (_, i) => `- point ${n}.${i + 1}`).join('\n');
  const board = createBoard({ title: 'Fold valve on a push', blocks: [singleSpec()] });
  const { document, es: captured } = loadBoardWithEventSource(renderBoardPage(board));
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: longProse(1) }, { kind: 'markdown', text: longProse(2) }, singleSpec()] });
  const [fits, overflows] = [board.blocks[1].id, board.blocks[2].id];
  const declare = (html, id, client, scroll) => html.replace(`id="fold-${id}"`,
    `id="fold-${id}" data-standin-client-height="${client}" data-standin-scroll-height="${scroll}"`);
  let html = renderRoundSection(board, round2, groupCommentsByBlock([]));
  html = declare(declare(html, fits, 300, 300), overflows, 300, 900);
  assert.ok(html.includes('data-standin-scroll-height="900"') && html.includes('data-standin-scroll-height="300"'),
    'setup failure: both pushed blocks must fold');
  captured.dispatch('round', JSON.stringify({ round: round2, mode: 'new-round', blockIds: board.blocks.slice(1).map(b => b.id), html, board }));

  const item = id => document.querySelector(`.block[data-block-id="${id}"]`);
  assert.equal(item(fits).classList.contains('folded'), false, 'a fold whose body fits once attached must be dropped by the push path');
  assert.equal(item(fits).querySelector('.fold-toggle'), null, 'taking its Show more control with it');
  assert.equal(item(overflows).classList.contains('folded'), true, 'a body that still overflows keeps its fold');
  assert.ok(item(overflows).querySelector('.fold-toggle'), 'and its control');
});

finish('send-guard');
