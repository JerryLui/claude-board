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
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { buildSubmittedPushPayload } from '../src/server.mjs';
import { StandInEvent } from './dom-stand-in.mjs';
import { check, finish, flush, pageHarness } from './support.mjs';

const { loadBoard, loadBoardWithEventSource, openBlocks, withFetchCapture, enableCommentMode, answerSingle } = await pageHarness();

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

// === moving on after Send or Discuss (ADR 160) ===================================
// The PM's own Send or Discuss that went out shows its status for about a second,
// then flips to the oldest other round still waiting, with a note, or goes where the
// Home mark goes when none waits. A Send that did not go out, a 409, the deadline's
// own flush and a file:// archive stay where they are.

const ASK = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const ARTIFACT = '<div class="doc"><h1>Quarterly</h1><p id="lede">Numbers.</p></div>';

function twoWaitingRounds(second = [ASK]) {
  const board = createBoard({ title: 'Two waiting rounds', blocks: [ASK], wait: true });
  addRound(board, { title: 'Second ask', blocks: second, wait: true });
  return board;
}

function lastWaitingRound() {
  const board = createBoard({ title: 'One left', blocks: [ASK], wait: true });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Last ask', blocks: [ASK], wait: true });
  return board;
}

/** The daemon's 200 to a Send of `round` on `board`, carrying the 'submitted' push the
 * page asks for with `stages: 'held'`. */
function sentAnswer(board, round, action = 'send') {
  const after = structuredClone(board);
  applySubmit(after, { action, answers: [], comments: [] }, round);
  return { ok: true, status: 200, json: async () => ({ ok: true, board: board.id, round, submitted: buildSubmittedPushPayload(after, round) }) };
}

/** Runs `fn(clock)` with `fetch` answering `respond(call)` and every timer of half a second
 * or more held until `clock.elapse(ms)` passes its delay; shorter timers run as ever. */
async function withSendClock(respond, fn) {
  const real = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const posts = [];
  const held = [];
  let now = 0;
  globalThis.fetch = async (url, opts) => {
    const call = { url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null };
    if (call.method === 'POST') posts.push(call);
    return respond(call);
  };
  globalThis.setTimeout = (cb, ms, ...rest) => {
    if ((Number(ms) || 0) < 500) return real.setTimeout(cb, ms, ...rest);
    held.push({ cb, at: now + Number(ms) });
    return 0;
  };
  const clock = {
    posts,
    elapse(ms) {
      now += ms;
      for (const t of held.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.cb(); else held.push(t);
      }
    },
  };
  try {
    return await fn(clock);
  } finally {
    globalThis.fetch = real.fetch;
    globalThis.setTimeout = real.setTimeout;
  }
}

const pageOnScreen = document => document.querySelector('.round-current').getAttribute('data-round');
const sendStatusText = document => document.getElementById('send-status').textContent;
const roundSection = (document, n) => document.querySelector(`.round[data-round="${n}"]`);
const flipTo = (document, n) => document.querySelector(`.round-page[data-round="${n}"]`).dispatchEvent(new StandInEvent('click'));
const missionsHome = () => ({ getItem: () => null, setItem() {} });
const boardsHome = () => ({ getItem: key => (key === 'cb-home' ? '/boards' : null), setItem() {} });

await check('moving on: Send on a board with two waiting rounds shows "Sent.", then about a second later the other waiting round with "Round 1 still waits", its typed answer intact', async () => {
  const board = twoWaitingRounds();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  assert.equal(pageOnScreen(document), '2', 'setup failure: the page must open on the newest round');
  flipTo(document, 1);
  answerSingle(roundSection(document, 1), 'Yes');
  const note = roundSection(document, 1).querySelector('[data-note-for]');
  note.value = 'typed before the other round went out';
  note.dispatchEvent(new StandInEvent('input'));
  flipTo(document, 2);
  answerSingle(roundSection(document, 2), 'No');

  await withSendClock(() => sentAnswer(board, 2), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts.length, 1, 'setup failure: Send must post once');
    assert.equal(clock.posts[0].body.round, 2, 'setup failure: Send names the round on screen');
    assert.equal(sendStatusText(document), 'Sent.');
    clock.elapse(900);
    assert.equal(pageOnScreen(document), '2', 'the status must stay up for about a second before the page moves');
    clock.elapse(200);
  });

  assert.equal(pageOnScreen(document), '1', 'the page must flip to the round that still waits');
  assert.equal(sendStatusText(document), 'Round 1 still waits');
  assert.equal(location.href, undefined, 'a round still waits, so the page must not leave the board');
  const yes = [...roundSection(document, 1).querySelectorAll('.choice-single')].find(el => el.textContent.trim() === 'Yes');
  assert.equal(yes.classList.contains('selected'), true, 'the answer picked on round 1 before the Send must still be picked');
  assert.equal(roundSection(document, 1).querySelector('[data-note-for]').value, 'typed before the other round went out', 'the note typed on round 1 must still be there');
});

await check('moving on: Send on the board\'s last waiting round goes where the Home mark goes, Missions when Missions was last used', async () => {
  const board = lastWaitingRound();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  await withSendClock(() => sentAnswer(board, 2), async clock => {
    answerSingle(roundSection(document, 2), 'Yes');
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(sendStatusText(document), 'Sent.');
    assert.equal(location.href, undefined, 'the page must not leave before the status has been up for about a second');
    clock.elapse(1100);
  });
  assert.equal(location.href, '/');
});

await check('moving on: Discuss shows "Handed over to chat.", then flips to the other waiting round with its note', async () => {
  const board = twoWaitingRounds();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  await withSendClock(() => sentAnswer(board, 2, 'discuss'), async clock => {
    document.getElementById('discuss-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts[0].body.action, 'discuss', 'setup failure: Discuss must post a discuss');
    assert.equal(sendStatusText(document), 'Handed over to chat.');
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '1');
  assert.equal(sendStatusText(document), 'Round 1 still waits');
  assert.equal(location.href, undefined);
});

await check('moving on: Discuss on the last waiting round goes to Boards when Boards was last used', async () => {
  const board = lastWaitingRound();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: boardsHome() });
  await withSendClock(() => sentAnswer(board, 2, 'discuss'), async clock => {
    document.getElementById('discuss-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(sendStatusText(document), 'Handed over to chat.');
    clock.elapse(1100);
  });
  assert.equal(location.href, '/boards');
});

await check('moving on: a page round\'s own Send says "Sent." in its send bar, then flips to the question round still waiting', async () => {
  const board = twoWaitingRounds([{ kind: 'html', html: ARTIFACT }]);
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  await withSendClock(() => sentAnswer(board, 2), async clock => {
    document.querySelector('.page-send-btn[data-round="2"]').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts.length, 1, 'setup failure: the page round\'s Send must post once');
    assert.equal(roundSection(document, 2).querySelector('.page-send-bar .send-status').textContent, 'Sent.');
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '1');
  assert.equal(sendStatusText(document), 'Round 1 still waits');
  assert.equal(location.href, undefined);
});

const pill = document => document.getElementById('round-pill-count');

await check('moving on: the pill\'s dot lights for an awaited page round that asks nothing, and Send flips to it with "Round 2 still waits" in its send bar', async () => {
  const board = twoWaitingRounds([{ kind: 'html', html: ARTIFACT }]);
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  flipTo(document, 1);
  assert.equal(pill(document).classList.contains('round-pill-count-owed'), true, 'the awaited page round waits, so the count must carry the dot');
  assert.equal(pill(document).getAttribute('aria-label'), 'Round 1 of 2, another round waits for an answer. Show all rounds');
  answerSingle(roundSection(document, 1), 'Yes');
  await withSendClock(() => sentAnswer(board, 1), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts[0].body.round, 1, 'setup failure: Send names round 1');
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.equal(roundSection(document, 2).querySelector('.page-send-bar .send-status').textContent, 'Round 2 still waits');
  assert.equal(location.href, undefined);
});

await check('moving on: with two rounds still waiting, Send flips to the oldest', async () => {
  const board = twoWaitingRounds();
  addRound(board, { title: 'Third ask', blocks: [ASK], wait: true });
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  answerSingle(roundSection(document, 3), 'Yes');
  await withSendClock(() => sentAnswer(board, 3), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '1');
  assert.equal(sendStatusText(document), 'Round 1 still waits');
});

/** Round 1 shows two mocks and asks nothing, so nothing waits on it; round 2 asks. */
function mocksThenAsk() {
  const board = createBoard({ title: 'Mocks, then a question', blocks: [{ kind: 'html', html: ARTIFACT }, { kind: 'html', html: ARTIFACT }] });
  addRound(board, { title: 'The ask', blocks: [ASK], wait: true });
  return board;
}

/** Opens the comment form on round 1's first mock, on screen. */
function openMockComment(document, board) {
  flipTo(document, 1);
  const blockId = board.blocks.find(b => b.round === 1).id;
  document.querySelector(`.comment-btn[data-block-id="${blockId}"]`).dispatchEvent(new StandInEvent('click'));
  return document.getElementById('comment-form-' + blockId);
}

async function sendRoundTwo(document, board) {
  flipTo(document, 2);
  answerSingle(roundSection(document, 2), 'Yes');
  await withSendClock(() => sentAnswer(board, 2), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(sendStatusText(document), 'Sent.', 'setup failure: the Send must go out');
    clock.elapse(1100);
  });
}

await check('moving on: a newest round that asks nothing and is not awaited, holding a queued comment, takes the page with the comment still queued', async () => {
  const board = createBoard({ title: 'A question, then mocks', blocks: [ASK], wait: true });
  addRound(board, { title: 'Mocks', blocks: [{ kind: 'html', html: ARTIFACT }, { kind: 'html', html: ARTIFACT }] });
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  const blockId = board.blocks.find(b => b.round === 2).id;
  document.querySelector(`.comment-btn[data-block-id="${blockId}"]`).dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'queued on the mock';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup failure: one comment queued');
  flipTo(document, 1);
  answerSingle(roundSection(document, 1), 'Yes');
  await withSendClock(() => sentAnswer(board, 1), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts[0].body.comments.length, 0, 'setup failure: the mock\'s comment rides its own round\'s Send, not round 1\'s');
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.equal(sendStatusText(document), 'Round 2 still waits');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1);
  assert.equal(location.href, undefined);
});

globalThis.FileReader ??= class {
  readAsDataURL(file) {
    file.arrayBuffer().then(b => { this.result = `data:${file.type};base64,${Buffer.from(b).toString('base64')}`; this.onload(); });
  }
};
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

for (const [what, fill] of [
  ['typed text', async input => { input.value = 'typed, never added'; }],
  ['a pasted image', async input => {
    input.dispatchEvent(new StandInEvent('paste', { clipboardData: { files: [new File([PNG], 'clip', { type: 'image/png' })] } }));
    await flush();
  }],
]) {
  await check(`moving on: a comment box holding ${what} it never added takes the page like a queued comment, never home`, async () => {
    const board = mocksThenAsk();
    const location = { protocol: 'http:' };
    const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
    const form = openMockComment(document, board);
    const input = form.querySelector('input[type=text]');
    await fill(input);
    await sendRoundTwo(document, board);
    assert.equal(pageOnScreen(document), '1');
    assert.equal(sendStatusText(document), 'Round 1 still waits');
    assert.equal(location.href, undefined, 'leaving the board would lose the unadded comment');
    assert.equal(form.querySelector('input[type=text]').value, input.value);
    assert.equal(form.querySelectorAll('.thumb-row img').length, what === 'a pasted image' ? 1 : 0);
  });
}

await check('moving on: a PM who flipped to another round during the second stays on it', async () => {
  const board = lastWaitingRound();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  answerSingle(roundSection(document, 2), 'Yes');
  await withSendClock(() => sentAnswer(board, 2), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(sendStatusText(document), 'Sent.', 'setup failure: the Send must go out');
    flipTo(document, 1);
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '1');
  assert.equal(location.href, undefined);
});

await check('moving on: with no round waiting, a comment still queued only in this tab keeps the page on the board', async () => {
  const board = createBoard({ title: 'Mock and ask', blocks: [{ kind: 'html', html: ARTIFACT }, ASK], wait: true });
  addRound(board, { title: 'Second ask', blocks: [ASK], wait: true });
  const location = { protocol: 'http:' };
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board), { location, storage: missionsHome() });
  flipTo(document, 1);
  const blockId = board.blocks.find(b => b.round === 1 && b.kind === 'html').id;
  document.querySelector(`.comment-btn[data-block-id="${blockId}"]`).dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'queued before another tab sent round 1';
  form.dispatchEvent(new StandInEvent('submit'));
  flipTo(document, 2);
  answerSingle(roundSection(document, 2), 'Yes');
  const bothSent = structuredClone(board);
  applySubmit(bothSent, { action: 'send', answers: [], comments: [] }, 2);
  applySubmit(bothSent, { action: 'send', answers: [], comments: [] }, 1);
  await withSendClock(call => (call.method === 'POST' ? sentAnswer(board, 2) : { ok: false, status: 503, json: async () => ({}) }), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(sendStatusText(document), 'Sent.', 'setup failure: the Send must go out');
    es.dispatch('submitted', JSON.stringify(buildSubmittedPushPayload(bothSent, 1)));
    await flush();
    clock.elapse(1100);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.equal(location.href, undefined, 'going home would destroy the comment queued only in this tab');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1);
});

await check('moving on: a failed Send or Discuss stays on the round with its error', async () => {
  const board = twoWaitingRounds();
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  await withSendClock(() => ({ ok: false, status: 500, json: async () => ({}) }), async clock => {
    document.getElementById('discuss-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    clock.elapse(5000);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.equal(sendStatusText(document), 'Error: submit failed: 500');
  assert.equal(location.href, undefined);
});

await check('moving on: a 409 (sent in another tab) stays on the round, its queued comment kept', async () => {
  const board = twoWaitingRounds([{ kind: 'html', html: ARTIFACT }, ASK]);
  const location = { protocol: 'http:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  const frame = roundSection(document, 2).querySelector('.html-stage');
  frame.loadSrcdoc();
  enableCommentMode(document);
  const blockId = board.blocks.find(b => b.round === 2 && b.kind === 'html').id;
  frame.contentDocument.getElementById('lede').dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'queued before the other tab sent';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup failure: one comment queued');

  await withSendClock(() => ({ ok: false, status: 409, json: async () => ({}) }), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    await flush();
    assert.equal(clock.posts.length, 1, 'setup failure: the armed Send must post once');
    clock.elapse(5000);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.match(sendStatusText(document), /^Already sent by another tab/);
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'the queued comment must still be on the round');
  assert.equal(location.href, undefined);
});

await check('moving on: the deadline\'s own flush of a page round\'s queued comment stays on the round', async () => {
  const board = createBoard({ title: 'A mock at its deadline', blocks: [{ kind: 'html', html: ARTIFACT }], wait: true });
  const location = { protocol: 'http:' };
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board), { location, storage: missionsHome() });
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  frame.contentDocument.getElementById('lede').dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + board.blocks[0].id);
  form.querySelector('input[type=text]').value = 'left before the wait died';
  form.dispatchEvent(new StandInEvent('submit'));

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 51 * 60_000;
    await withSendClock(call => (call.method === 'POST' ? sentAnswer(board, 1) : { ok: false, status: 503, json: async () => ({}) }), async clock => {
      es.dispatch('awaitExpired', JSON.stringify({ round: 1 }));
      await flush();
      assert.equal(clock.posts.length, 1, 'setup failure: the deadline must flush the queued comment');
      clock.elapse(5000);
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(pageOnScreen(document), '1');
  assert.equal(location.href, undefined, 'the deadline\'s flush is no press of Send: the page must stay');
});

await check('moving on: a round opened from disk never navigates', async () => {
  const board = lastWaitingRound();
  const location = { protocol: 'file:' };
  const document = loadBoard(renderBoardPage(board), { location, storage: missionsHome() });
  await withSendClock(() => sentAnswer(board, 2), async clock => {
    document.getElementById('send-btn').dispatchEvent(new StandInEvent('click'));
    document.getElementById('discuss-btn').dispatchEvent(new StandInEvent('click'));
    document.body.dispatchEvent(new StandInEvent('keydown', CMD_ENTER));
    await flush();
    clock.elapse(5000);
    assert.equal(clock.posts.length, 0);
  });
  assert.equal(pageOnScreen(document), '2');
  assert.equal(location.href, undefined);
});

finish('Cmd+Enter');
