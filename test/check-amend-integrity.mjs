// Acceptance checks for what an amend must NOT do to a live page — the cluster
// D26-D30 below, all of which are the same shape: a push lands, and something
// on screen goes on saying what was true before it.
//
// Harness idiom is test/check-anchor-push.mjs's, deliberately: a stubbed
// EventSource in place before the real `ui` script runs, then the real payloads
// dispatched at it. `resync` additionally needs `fetch`, stubbed the way
// test/check-comment-mode.mjs already stubs it.
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

import assert from 'node:assert/strict';
import { createBoard, amendRound, resolveComments } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
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

function loadBoardWithEventSource(pageHtml) {
  const originalES = globalThis.EventSource;
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  globalThis.EventSource = CapturingEventSource;
  try {
    const document = parseHTML(pageHtml);
    const window = document.defaultView;
    const location = { protocol: 'http:' };
    new Function('document', 'window', 'location', ui)(document, window, location);
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
    return { document, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
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

if (failures) process.exit(1);
console.log('\nall amend-integrity checks ok');
