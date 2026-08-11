// Acceptance checks for what an amend must NOT do to a live page — the cluster
// D26-D30 below, all of which are the same shape: a push lands, and something
// on screen goes on saying what was true before it.
//
// Harness idiom is test/check-anchor-push.mjs's, deliberately: 'EventSource' is
// declared as a named parameter of the `new Function` call that runs the real
// `ui` script, and a stubbed, captured instance is passed as its argument, so
// the real payloads can be dispatched at it afterward. `resync` additionally
// needs `fetch`, stubbed the way test/check-comment-mode.mjs already stubs it.
//
// Covered:
//   D26. a resync catching up on a NESTED change (a compare side re-minted by
//        an amend) re-renders the block that CONTAINS it, in place — never the
//        nested fragment on its own, appended at round level beside the stale
//        comparison it was meant to replace.
//   D27. a push disarms the send guard, so the armed button cannot go on naming
//        a count the page has since moved past.
//   D28. every push path closes the stage lens, not only the diagram lens.
//   D30. a context-nested html stage carries exactly ONE pin layer, so its
//        comments are drawn once, where the stage itself says they are.
//   ...and the two other pushes of the same shape, at the end of this file: a
//        'submitted' push renders what was SUBMITTED rather than the receiving
//        tab's own unsent draft, and a resync answered after a live push is
//        dropped rather than applied backwards over it.

import assert from 'node:assert/strict';
import { createBoard, addRound, amendRound, applySubmit, abandonOpenRounds, resolveComments } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock } from '../src/render.mjs';
import { ui, ROUND_ABANDONED_TITLE } from '../src/ui.mjs';
import { parseHTML, StandInEvent, StandInEventSource } from './dom-stand-in.mjs';

let failures = 0;
function report(name, err) {
  if (!err) { console.log(`ok - ${name}`); return; }
  failures++;
  console.error(`FAIL - ${name}`);
  console.error((err && err.stack) || err);
}
function check(name, fn) {
  try { fn(); report(name); } catch (err) { report(name, err); }
}
async function checkAsync(name, fn) {
  try { await fn(); report(name); } catch (err) { report(name, err); }
}

/** src/server.mjs's own buildRoundPushPayload, reimplemented rather than
 * imported (it is not exported) -- the same three calls in the same order. */
function buildRoundPushPayload(board, round, mode, blockIds) {
  const resolved = resolveComments(board, board.comments);
  const commentsByBlock = groupCommentsByBlock(resolved);
  const boardForClient = { ...board, comments: resolved };
  const html = mode === 'new-round'
    ? renderRoundSection(board, round, commentsByBlock)
    : blockIds.map(id => {
      const block = board.blocks.find(b => b.id === id);
      return block ? renderBlock(block, board, commentsByBlock, false) : '';
    }).join('\n');
  return { round, mode, blockIds, html, board: boardForClient };
}

// Declare-and-pass, the harness idiom this file's own header comment names:
// 'EventSource' is a named parameter of the `new Function` call, bound to a
// captured, stubbed instance, rather than left off and picked up from
// whatever the node process's own global happens to be.
function loadBoardWithEventSource(pageHtml) {
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, CapturingEventSource);
  assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
  return { document, es: captured };
}

/** The blocks a round shows as its OWN children -- what the reviewer reads as
 * "the round", as opposed to anything nested inside one of them. */
function topLevelBlocks(roundSection) {
  return Array.from(roundSection.children || []).filter(el => el.classList && el.classList.contains('block'));
}

const compareSpec = (leftText, rightText) => ({
  kind: 'compare',
  left: { label: 'A', block: { kind: 'markdown', text: leftText } },
  right: { label: 'B', block: { kind: 'markdown', text: rightText } },
});

// --- D26 ---------------------------------------------------------------------
//
// The window is the one applyResync's own comment names: the laptop sleeps, the
// agent amends, and the stream carries no replay. The amend replaces a compare
// block, whose two sides are re-minted with fresh ids (src/board.mjs), so the
// patch is {added: [the two new side ids], changed: []} -- the compare block
// itself is in neither list, since src/patch.mjs's ownContent drops left/right.

await checkAsync('a resync catching up on an amended compare side re-renders the comparison in place, with no orphan appended at round level (ablation: drop applyResync\'s ownerOf mapping and the round keeps the withdrawn comparison, with two stray markdown blocks below it)', async () => {
  const board = createBoard({ title: 'Amend integrity', blocks: [compareSpec('the withdrawn left', 'the withdrawn right')] });
  const compareId = board.blocks[0].id;
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));

  let roundSection = document.querySelector('.round[data-round="1"]');
  assert.equal(topLevelBlocks(roundSection).length, 1, 'setup failure: the round should start with exactly the comparison');
  assert.match(roundSection.textContent, /the withdrawn left/, 'setup failure: the original content is not on screen');

  amendRound(board, { blocks: [{ id: compareId, ...compareSpec('the replacement left', 'the replacement right') }] });
  const sides = [board.blocks[0].left.block.id, board.blocks[0].right.block.id];

  const freshPage = renderBoardPage(board);
  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => freshPage });
  // resync reads the served page as a data envelope. Stubbed locally, the same
  // way fetch is: the stand-in has no DOMParser of its own, and resync's own
  // .catch would swallow the ReferenceError into a silent no-op -- which is
  // exactly what a check must not mistake for "the catch-up did nothing".
  globalThis.DOMParser = class { parseFromString(text) { return parseHTML(text); } };
  try {
    es.dispatch('open', '');
    // resync is a fetch, a .text() and two .then hops deep -- a macrotask turn
    // drains all of it, where counting microtasks by hand would not.
    await new Promise(r => setTimeout(r, 0));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.DOMParser = originalParser;
  }

  roundSection = document.querySelector('.round[data-round="1"]');
  const top = topLevelBlocks(roundSection);
  assert.equal(top.length, 1, `the round must still hold exactly the comparison, got ${top.length} top-level blocks: ${top.map(el => el.getAttribute('data-block-kind')).join(', ')}`);
  assert.equal(top[0].getAttribute('data-block-id'), compareId, 'and it must be the comparison itself, re-rendered in place');
  assert.match(roundSection.textContent, /the replacement left/, 'the comparison on screen must show the amended content');
  assert.doesNotMatch(roundSection.textContent, /the withdrawn left/, 'the withdrawn content must be gone, not merely joined by its replacement');
  sides.forEach(id => {
    const el = roundSection.querySelector(`[data-block-id="${id}"]`);
    assert.ok(el, `the re-minted side ${id} must be on the page`);
    assert.ok(el.closest('.compare-block'), `side ${id} must render INSIDE the comparison, never as a round-level orphan`);
  });
});

// --- D26, second half: the amend branch's append path ------------------------

check('an amend fragment naming a block the pushed board does not carry at top level is dropped, not appended to the round (ablation: restore the bare roundSection.appendChild and the round grows a block that belongs inside another one)', () => {
  const board = createBoard({ title: 'Orphan guard', blocks: [compareSpec('left', 'right')] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const nestedId = board.blocks[0].left.block.id;

  const payload = buildRoundPushPayload(board, 1, 'amend', []);
  // A fragment carrying the NESTED side on its own -- exactly what the resync
  // path used to build, and what any future caller building fragments from
  // flattened patch ids would build again.
  payload.html = renderBlock(board.blocks[0].left.block, board, {}, false);
  es.dispatch('round', JSON.stringify(payload));

  const roundSection = document.querySelector('.round[data-round="1"]');
  const top = topLevelBlocks(roundSection);
  assert.equal(top.length, 1, `a nested block must not land as a round child; round now holds ${top.length} top-level blocks`);
  assert.equal(top[0].getAttribute('data-block-id'), board.blocks[0].id);
  assert.equal(roundSection.querySelectorAll(`[data-block-id="${nestedId}"]`).length, 1, 'and the nested block must still appear exactly once, inside its owner');
});

check('a genuinely new TOP-LEVEL block from an amend is inserted before the round\'s closing rail, not after it (ablation: swap insertBefore back for appendChild and the block renders outside the round it belongs to)', () => {
  const board = createBoard({ title: 'Amend adds a block', blocks: [{ kind: 'markdown', text: 'first' }] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));

  const { blockIds } = amendRound(board, { blocks: [{ kind: 'markdown', text: 'added by the amend' }] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 1, 'amend', blockIds)));

  const roundSection = document.querySelector('.round[data-round="1"]');
  const kids = Array.from(roundSection.children);
  const added = kids.findIndex(el => el.getAttribute && el.getAttribute('data-block-id') === blockIds[0]);
  const rail = kids.findIndex(el => el.classList && el.classList.contains('round-end'));
  assert.notEqual(added, -1, 'the amend\'s new block must actually land in the round');
  assert.notEqual(rail, -1, 'setup failure: an open round renders a closing rail');
  assert.ok(added < rail, 'the new block must sit above the rail that closes the round');
});

// --- D27 ---------------------------------------------------------------------

check('a push disarms the send guard, so the button can never keep naming a count the board has moved past (ablation: delete disarmSend() from applyRoundPush)', () => {
  const board = createBoard({
    title: 'Send guard vs. amend',
    blocks: [{ kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.textContent, 'Send', 'setup failure: Send must start with its ordinary label');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    sendBtn.dispatchEvent(new StandInEvent('click'));
    assert.equal(sendBtn.textContent, '1 question unanswered — send anyway?', 'setup failure: the click should have armed the guard');

    const { blockIds } = amendRound(board, {
      blocks: [{ kind: 'question', prompt: 'Q2: and another', widget: 'single', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
    });
    es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 1, 'amend', blockIds)));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sendBtn.textContent, 'Send', 'the amend added a question, so the armed label is a lie: it must be back to its ordinary state');
  assert.equal(sendBtn.classList.contains('warn'), false, 'and the warning treatment must go with it');
  assert.equal(document.querySelectorAll('.flagged').length, 0, 'and the ring on the question it flagged');
});

// --- D28 ---------------------------------------------------------------------

check('all three push paths close the stage lens, not just the diagram lens (ablation: drop stageLensClose() from any of them and a pick control stays bound to a card the push replaced)', () => {
  ['applyRoundPush', 'applySubmittedPush', 'applyResync'].forEach(name => {
    const start = ui.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `setup failure: ${name} not found in the client script`);
    const head = ui.slice(start, start + 1200);
    assert.match(head, /lensClose\(\);/, `${name} must close the diagram lens`);
    assert.match(head, /stageLensClose\(\);/, `${name} must close the stage lens too -- it holds a pick control bound to a card the push is about to replace`);
  });
});

// --- D30 ---------------------------------------------------------------------

check('a context-nested html stage carries exactly one pin layer, like the same stage at top level (ablation: emit pageDomPinLayer unconditionally in renderContextItem and every stage comment is drawn a second time, at a fabricated position)', () => {
  const board = createBoard({
    title: 'Context stage',
    blocks: [{
      kind: 'question',
      prompt: 'Which of these?',
      widget: 'text',
      options: [],
      context: [{ kind: 'html', html: '<p id="mock">a mock</p>' }],
    }],
  });
  const document = parseHTML(renderBoardPage(board));
  const item = document.querySelector('.context-item.html-block');
  assert.ok(item, 'setup failure: the context stage did not render');
  assert.equal(item.querySelectorAll('.pin-layer').length, 1,
    'two layers means wirePageDomPins finds a second one and redraws every stage-scoped comment from refs that cannot resolve outside the frame');
  assert.ok(item.querySelector('.stage-wrap .pin-layer'), 'and the one layer must be the stage\'s own, where the frame reports its positions');

  // The error path is the reason a page-level layer exists at all: there is no
  // stage, and the .resolve-error note IS anchorable.
  const errBoard = createBoard({
    title: 'Context stage that failed to resolve',
    blocks: [{ kind: 'question', prompt: 'p', widget: 'text', options: [], context: [{ kind: 'html', source: { path: 'nope.html' } }] }],
  });
  const errItem = parseHTML(renderBoardPage(errBoard)).querySelector('.context-item.html-block');
  assert.equal(errItem.querySelectorAll('.pin-layer').length, 1, 'a failed reference still needs somewhere to draw a pin');
});

// --- D29, D31: the stage channel's own bookkeeping ---------------------------
//
// Neither is reachable through this file's harness: both live behind
// findStageFrame, which only ever returns a frame for a message a real browser
// sourced from one. Asserted on the script text instead, the way the readonly
// and defer contracts already are elsewhere in this suite.

check('a stage cannot grow the pending-locate table without bound, and cannot name a prototype key on it (D29, D31)', () => {
  const request = ui.slice(ui.indexOf('function requestStagePositions('));
  assert.match(request.slice(0, 1200), /if \(layer\.__cbLocateId\) delete pendingLocates\[layer\.__cbLocateId\];/,
    'a new request must free the one it supersedes -- a stage posts "ready" as often as it likes, and every one of them lands here');

  const positions = ui.slice(ui.indexOf('function handleStagePositions('));
  assert.match(positions.slice(0, 900), /Object\.prototype\.hasOwnProperty\.call\(pendingLocates, data\.requestId\)/,
    "requestId is a string the stage chooses: a bare lookup hands 'toString' a function, sails past the !pending guard and throws out of the message listener");
});

// --- a submitted round shows what was SUBMITTED, not this tab's draft --------
//
// Same family, different push. Two tabs are open on one board; one of them
// presses Send. The daemon broadcasts 'submitted' carrying the round re-rendered
// from the now-authoritative board -- "the actual answers/notes/choices that were
// sent", as src/server.mjs's own comment beside that broadcast puts it, precisely
// so that the OTHER tab's unsent state is not frozen into the record as if it
// were what went out. The client then undid that on arrival: it wired the
// replacement (which re-applies this tab's live selections/notes onto whatever it
// wires) BEFORE clearing them, so the second tab painted its own private draft
// over the immutable record of someone else's answer.

check('a just-sent round shows what was submitted, never this tab\'s unsent draft (ablation: move applySubmittedPush\'s clearFieldState back below wireRoot and the second tab repaints its own selection onto the record)', () => {
  const board = createBoard({
    title: 'Two tabs, one Send',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const qid = board.blocks[0].id;
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));

  // THIS tab's private, unsent state: a different choice and a note nobody else
  // has ever seen, entered through the real widgets.
  const pick = label => Array.from(document.querySelectorAll('.choice-single')).find(el => el.textContent.indexOf(label) !== -1);
  pick('No').dispatchEvent(new StandInEvent('click'));
  const draftNote = document.querySelector(`textarea[data-note-for="${qid}"]`);
  draftNote.value = 'my private draft, never sent';
  draftNote.dispatchEvent(new StandInEvent('input'));
  assert.equal(pick('No').classList.contains('selected'), true, 'setup failure: the draft choice was not recorded');

  // The OTHER tab answers differently and sends. Everything from here is the
  // daemon's own payload, built the way handleSubmit builds it.
  applySubmit(board, {
    action: 'send',
    answers: [{ id: qid, status: 'answered', choice: 'Yes', note: 'what actually went out' }],
    comments: [],
  }, 1);
  const resolved = resolveComments(board, board.comments);
  const html = renderRoundSection(board, 1, groupCommentsByBlock(resolved));
  es.dispatch('submitted', JSON.stringify({ round: 1, board: { ...board, comments: resolved }, html }));

  const section = document.querySelector('.round[data-round="1"]');
  const selected = Array.from(section.querySelectorAll('.choice-single.selected'));
  assert.equal(selected.length, 1, `the record must show exactly one choice, got ${selected.length}`);
  assert.equal(selected[0].getAttribute('data-choice'), 'Yes',
    'and it must be the choice that was actually submitted, not the one this tab had merely picked');

  const noteEl = section.querySelector(`textarea[data-note-for="${qid}"]`);
  assert.equal(noteEl.textContent, 'what actually went out', 'the server rendered the note that was sent');
  // The stand-in never seeds `.value` from a textarea's markup (a documented
  // ceiling -- see its own header), so `.value` here is exactly "what the client
  // script wrote into this field", and the answer must be: nothing.
  assert.equal(noteEl.value, '',
    'the client must not write this tab\'s draft note over the note that was submitted');
});

// --- a stale resync must not revert what the reviewer just typed -------------
//
// resync fetches a snapshot describing the board as it is NOW; by the time it
// lands, a live push may have described it as it is later. computeBoardPatch is a
// symmetric diff, so the older snapshot reports the push's own block as "changed"
// just as convincingly -- and applyRoundPush then re-renders it from the stale
// markup and clears the field state, taking the reviewer's answer with it.

await checkAsync('a resync answered after a live amend is dropped, not applied backwards over it (ablation: delete resync\'s generation guard and the amended question reverts, taking the answer just given with it)', async () => {
  const board = createBoard({
    title: 'Stale resync',
    blocks: [{ kind: 'question', prompt: 'Q1: the original prompt', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const qid = board.blocks[0].id;
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  // The snapshot the daemon is about to serve: taken BEFORE the amend, which is
  // the whole point -- the reconnect and the amend crossed on the wire.
  const stalePage = renderBoardPage(board);

  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  let release = null;
  globalThis.fetch = () => new Promise(resolve => {
    release = () => resolve({ ok: true, status: 200, text: async () => stalePage });
  });
  globalThis.DOMParser = class { parseFromString(text) { return parseHTML(text); } };
  try {
    es.dispatch('open', ''); // the reconnect: resync is now in flight, unanswered
    assert.ok(release, 'setup failure: the subscription never issued its catch-up fetch');

    // The amend lands while that fetch is still in the air.
    amendRound(board, {
      blocks: [{ id: qid, kind: 'question', prompt: 'Q1: the amended prompt', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
    });
    es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 1, 'amend', [qid])));
    const yes = Array.from(document.querySelectorAll('.choice-single')).find(el => el.textContent.indexOf('Yes') !== -1);
    assert.ok(yes, 'setup failure: the amended question did not render its options');
    yes.dispatchEvent(new StandInEvent('click')); // and the reviewer answers it

    release(); // ...and only now does the pre-amend snapshot arrive
    await new Promise(r => setTimeout(r, 0));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.DOMParser = originalParser;
  }

  const section = document.querySelector('.round[data-round="1"]');
  assert.match(section.textContent, /the amended prompt/, 'the amend must still be on screen');
  assert.doesNotMatch(section.textContent, /the original prompt/, 'the withdrawn prompt must not come back');
  const selected = Array.from(section.querySelectorAll('.choice-single.selected'));
  assert.equal(selected.length, 1, 'the answer given after the amend must survive the stale catch-up');
  assert.equal(selected[0].getAttribute('data-choice'), 'Yes');
});

// The same rule, between two catch-ups rather than between a catch-up and a push.
// Two are genuinely in the air now: the 'awaitExpired' handler re-reads the board
// on every nudge, and closing a board sends one nudge per round it closes. Neither
// sibling is a push, so the push counter cannot separate them -- and the daemon is
// single-threaded, so the one ISSUED first is the one whose snapshot was read
// first, whichever order the two responses reach the tab in.
//
// What the older sibling would do on arrival TODAY is early-return: a strictly
// older snapshot carries the same blocks and no status the newer one has not
// already moved past, so computeBoardPatch reports nothing. That is why this is
// asserted where the decision is made -- the snapshot is dropped unread -- rather
// than through a reverted widget. The abandoned-round branch just below is the
// first branch to act on a status change alone (no applyRoundPush, so nothing
// bumps the push counter), and it is exactly that shape of branch that turns "the
// older sibling reaches applyResync" into a visible revert; the ordering rule is
// pinned here so the next one cannot reintroduce it quietly.

await checkAsync('of two catch-ups in flight, the older one answering last is dropped unread, not applied over the fresher one that already landed (ablation: delete the issue-order half of resync\'s guard and the stale snapshot is parsed and handed to applyResync)', async () => {
  const q = n => ({ kind: 'question', prompt: `Q${n}: pick one`, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] });
  const board = createBoard({ title: 'Two nudges', blocks: [q(1)], wait: true });
  addRound(board, { blocks: [q(2)], wait: true });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const sendBtn = document.getElementById('send-btn');
  assert.equal(sendBtn.disabled, false, 'setup: two open rounds, so the newest is submittable');

  // The two snapshots: what the daemon had before it closed the board, and what
  // it has after. The first nudge's read is the slow one here -- the failure the
  // guard is about is precisely that it can answer last.
  const stalePage = renderBoardPage(board);
  const closed = abandonOpenRounds(board);
  assert.deepEqual(closed, [1, 2], 'setup: both open rounds close, so the daemon nudges twice');
  const freshPage = renderBoardPage(board);

  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  const parsed = [];
  const pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  globalThis.DOMParser = class { parseFromString(text) { parsed.push(text); return parseHTML(text); } };
  try {
    es.dispatch('awaitExpired', JSON.stringify({ round: 1 }));
    es.dispatch('awaitExpired', JSON.stringify({ round: 2 }));
    assert.equal(pending.length, 2, 'setup: one catch-up per nudge, both in the air at once');

    pending[1]({ ok: true, status: 200, text: async () => freshPage }); // the fresher answers first
    await new Promise(r => setTimeout(r, 0));
    assert.equal(parsed.length, 1, 'setup: the fresher snapshot was read');
    assert.equal(sendBtn.disabled, true, 'setup: ...and applied -- the board is closed, so Send is gone');

    pending[0]({ ok: true, status: 200, text: async () => stalePage }); // the older answers last
    await new Promise(r => setTimeout(r, 0));
    assert.equal(parsed.length, 1,
      'the older snapshot must be dropped where it is decided, not read and handed to applyResync to be diffed against a board it predates');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.DOMParser = originalParser;
  }

  assert.equal(sendBtn.disabled, true, 'and the closed board stays closed');
});

// --- an abandoned board, on an ORDINARY board's surface ----------------------
//
// The page board's half of this is test/check-page-board.mjs's (its floating
// panel is its own compose surface). This is the same close seen from the
// ordinary send bar: a conversation declared a boundary, abandonOpenRounds closed
// the round, and the daemon nudged every open tab with the same 'awaitExpired'
// it sends for a wait that merely lapsed.

await checkAsync('an ordinary board whose round was abandoned stops counting down, takes Send away, and says why the queued comments never left (ablation: delete roundsClosedUnsent/adoptClosedRounds and the bar stays live over a board that answers every submit 409)', async () => {
  const board = createBoard({
    title: 'Boundary declared',
    blocks: [
      { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
      { kind: 'html', html: '<p id="mock">the artifact</p>' },
    ],
    wait: true,
  });
  const htmlId = board.blocks[1].id;
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));

  // A comment queued through the block's own "Add comment" affordance -- it lives
  // nowhere but this tab's memory until a Send carries it.
  document.querySelector(`.comment-btn[data-block-id="${htmlId}"]`).dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + htmlId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: the comment form did not open');
  form.querySelector('input[type=text]').value = 'a remark with nowhere to go';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup failure: nothing was queued');

  const countdown = document.querySelector('span#round-countdown');
  assert.equal(countdown.textContent.endsWith('m left'), true, 'setup: the round is awaited, so the bar counts down');
  assert.equal(document.getElementById('send-btn').disabled, false, 'setup: Send is live');

  abandonOpenRounds(board);
  const freshPage = renderBoardPage(board);
  const originalFetch = globalThis.fetch;
  const originalParser = globalThis.DOMParser;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => freshPage });
  globalThis.DOMParser = class { parseFromString(text) { return parseHTML(text); } };
  try {
    es.dispatch('awaitExpired', JSON.stringify({ round: 1 }));
    await new Promise(r => setTimeout(r, 0));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.DOMParser = originalParser;
  }

  assert.equal(countdown.textContent, '', 'the countdown must stop -- nobody is waiting on this round any more');
  assert.equal(countdown.classList.contains('visible'), false);
  assert.equal(document.getElementById('send-btn').disabled, true, 'Send must go, rather than stay live over a submit the daemon answers 409');
  assert.equal(document.getElementById('discuss-btn').disabled, true);
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1,
    'the queued comment stays on screen -- it is the reviewer\'s, and nothing here may throw it away');
  assert.equal(document.querySelector('span#send-status').textContent, ROUND_ABANDONED_TITLE,
    'and the one line beside the dead button has to say why it will never go out');
});

if (failures) process.exit(1);
console.log('\nall amend-integrity checks ok');
