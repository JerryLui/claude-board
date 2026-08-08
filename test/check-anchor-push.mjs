// Ticket 07 (DESIGN.md): audit finding V1, the SSE row -- the one the
// audit calls out as "the one that matters most" and "drivable today": deleting
// all three of src/ui.mjs's `wireRoot(...)` calls inside its SSE push handlers
// (`applyRoundPush`'s `wireRoot(wrap)` for a brand-new round and `wireRoot(frag)`
// for an amend, `applySubmittedPush`'s `wireRoot(replacement)`) left only TWO
// failures anywhere in the suite, and both were `ui.includes(...)` string
// assertions over the source text (test/check-pure.mjs) -- "SSE-pushed anchoring
// has no behavioural check at all, the exact anti-pattern this spec names as root
// cause."
//
// This file drives the real subscription src/ui.mjs itself opens: it stubs
// `EventSource` (test/dom-stand-in.mjs's `StandInEventSource`), runs the real `ui`
// script so it constructs one and registers its OWN `addEventListener('round', ...)`
// / `addEventListener('submitted', ...)` listeners, then fires the exact events a
// real server push would carry (built with the same functions src/server.mjs's own
// `buildRoundPushPayload`/the `submitted` broadcast use -- resolveComment,
// groupCommentsByBlock, renderRoundSection/renderBlock -- never a hand-shaped
// payload), and asserts the pushed content is ACTUALLY ANCHORABLE end to end:
// comment mode on, click the pushed element, a form opens, submitting it draws a
// pin. Never by calling applyRoundPush/applySubmittedPush directly -- that would
// prove nothing about whether the subscription is wired at all.

import assert from 'node:assert/strict';
import { createBoard, addRound, amendRound, applySubmit, resolveComment } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent, StandInEventSource } from './dom-stand-in.mjs';

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

/** The exact payload shape src/server.mjs's buildRoundPushPayload builds for a
 * live 'round' push -- reimplemented from the same three functions (not imported
 * from server.mjs, which is not a pure module and pulls in the HTTP/daemon
 * surface) so this test constructs a payload no different from what a real daemon
 * would broadcast. */
function buildRoundPushPayload(board, round, mode, blockIds) {
  const resolvedComments = board.comments.map(c => resolveComment(board, c));
  const commentsByBlock = groupCommentsByBlock(resolvedComments);
  const boardForClient = { ...board, comments: resolvedComments };
  const html = mode === 'new-round'
    ? renderRoundSection(board, round, commentsByBlock)
    : blockIds.map(id => {
      const block = board.blocks.find(b => b.id === id);
      return block ? renderBlock(block, board, commentsByBlock, false) : '';
    }).join('\n');
  return { round, mode, blockIds, html, board: boardForClient };
}

/** The exact payload shape src/server.mjs's handleSubmit builds for the
 * 'submitted' broadcast. */
function buildSubmittedPushPayload(board, round) {
  const resolvedComments = board.comments.map(c => resolveComment(board, c));
  const commentsByBlock = groupCommentsByBlock(resolvedComments);
  const boardForClient = { ...board, comments: resolvedComments };
  const html = renderRoundSection(board, round, commentsByBlock);
  return { round, board: boardForClient, html };
}

/** Load `pageHtml` through the real client script with a captured, stubbed
 * EventSource in place BEFORE the script runs (src/ui.mjs constructs it
 * synchronously, guarded only by `typeof EventSource !== 'undefined'`, so the
 * stub has to already be the global by the time this call happens -- exactly
 * like test/check-comment-mode.mjs already stubs `globalThis.fetch`). Returns
 * both the document and the constructed StandInEventSource instance so a check
 * can `.dispatch('round'|'submitted', JSON.stringify(payload))` on it. */
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
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource -- fix the fixture (readonly must be false), not this file');
    return { document, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

/** Click `button` (comment mode already on), submit the opened form, and return
 * the pin that landed in `layer` -- the full, real, end-to-end proof that
 * `button` is genuinely anchorable, not just present in the DOM. */
function anchorAndReturnPin(document, button, blockId, layer) {
  button.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'),
    `clicking the pushed element did not open block ${blockId}'s comment form -- the pushed content is not wired for anchoring at all`);
  const input = form.querySelector('input[type=text]');
  input.value = 'a comment on pushed content';
  form.dispatchEvent(new StandInEvent('submit'));
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin after queueing one comment on the pushed content, got ${pins.length}`);
  return pins[0];
}

// --- fixture: round 1 sent, so round 2 arrives entirely over the push below ----

function freshBoard() {
  const board = createBoard({
    title: 'Ticket 07 -- SSE push anchoring',
    blocks: [{ kind: 'markdown', text: 'round 1, nothing interesting' }],
  });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  return board;
}

// --- src/ui.mjs:1365 -- applyRoundPush's 'new-round' branch: wireRoot(wrap) ----

check('a brand-new round pushed over SSE (mode: new-round) is genuinely anchorable: click its html stage, submit the form, a pin lands (ablation: deleting applyRoundPush\'s wireRoot(wrap) call)', () => {
  const board = freshBoard();
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);
  enableCommentMode(document);
  assert.equal(document.querySelectorAll('.html-stage').length, 0, 'setup failure: round 1 must carry no html stage of its own');

  const round2 = addRound(board, { blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }] });
  const round2BlockId = board.blocks.find(b => b.round === round2).id;
  const payload = buildRoundPushPayload(board, round2, 'new-round', [round2BlockId]);

  es.dispatch('round', JSON.stringify(payload));

  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'the pushed round\'s html stage must actually be in the document after the push');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  const section = document.querySelector('.html-block');
  const layer = section.querySelector('.pin-layer');
  const pin = anchorAndReturnPin(document, button, round2BlockId, layer);
  assert.equal(pin.classList.contains('pin-lost'), false);
});

// --- src/ui.mjs:1382 -- applyRoundPush's 'amend' branch: wireRoot(frag) -------

check('a block amended into the still-open round over SSE (mode: amend) is genuinely anchorable (ablation: deleting applyRoundPush\'s wireRoot(frag) call)', () => {
  const board = freshBoard();
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: 'round 2, opened first' }] });
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);
  enableCommentMode(document);

  const { blockIds: amendedIds } = amendRound(board, { blocks: [{ kind: 'html', html: '<div class="mock"><button>Amend</button></div>' }] });
  const amendedBlockId = amendedIds[0];
  const payload = buildRoundPushPayload(board, round2, 'amend', amendedIds);

  es.dispatch('round', JSON.stringify(payload));

  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'the amended block\'s html stage must actually be in the document after the push');
  frame.loadSrcdoc();
  const button = frame.contentDocument.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage has no <button>');

  const section = document.querySelector(`[data-block-id="${amendedBlockId}"]`);
  assert.ok(section, 'setup failure: the amended block section is not in the document');
  const layer = section.querySelector('.pin-layer');
  const pin = anchorAndReturnPin(document, button, amendedBlockId, layer);
  assert.equal(pin.classList.contains('pin-lost'), false);
});

// --- src/ui.mjs:1418 -- applySubmittedPush: wireRoot(replacement) -------------
//
// The audit's own framing: "a round that just went out can still carry an html/
// mermaid stage whose EXISTING pins/comments are worth showing correctly." So
// this submits a comment on round 2's html block FIRST (through a real click, in
// a live session, same as every other check in this suite mints an anchor), then
// fires the 'submitted' push a second, already-subscribed tab would receive, and
// asserts that second tab's swapped-in (now-historical) stage still shows the
// pin -- which requires wireRoot(replacement) to have registered the 'load'
// listener that later draws it, since a freshly-parsed detached iframe starts out
// wired to nothing at all (see test/dom-stand-in.mjs's own file comment on why an
// iframe needs an explicit loadSrcdoc()).

check('a round that just went sent, pushed over SSE (\'submitted\'), still shows an existing comment\'s pin on its (now historical) html stage (ablation: deleting applySubmittedPush\'s wireRoot(replacement) call)', () => {
  const board = freshBoard();
  const round2 = addRound(board, { blocks: [{ kind: 'html', html: '<div class="mock"><button>Ship it</button></div>' }] });
  const round2BlockId = board.blocks.find(b => b.round === round2).id;

  // Mint the comment through a REAL client session first, exactly like
  // test/check-archive.mjs's own mint-then-submit pattern -- so the anchor fed
  // into applySubmit is one the real gesture actually produced, not a
  // hand-guessed index chain.
  const mintHtml = renderBoardPage(board);
  const mintDoc = parseHTML(mintHtml);
  new Function('document', 'window', 'location', ui)(mintDoc, mintDoc.defaultView, { protocol: 'http:' });
  enableCommentMode(mintDoc);
  const mintFrame = mintDoc.querySelectorAll('.html-stage')[0];
  mintFrame.loadSrcdoc();
  const mintButton = mintFrame.contentDocument.querySelector('button');
  mintButton.dispatchEvent(new StandInEvent('click'));
  const mintForm = mintDoc.getElementById('comment-form-' + round2BlockId);
  assert.ok(mintForm && mintForm.classList.contains('open'), 'setup failure: minting the comment through the real client did not open its form');
  const mintedAnchor = {
    kind: mintForm.getAttribute('data-anchor-kind'),
    ref: mintForm.getAttribute('data-anchor-ref'),
    hint: mintForm.getAttribute('data-anchor-label'),
  };

  applySubmit(board, { action: 'send', answers: [], comments: [{ blockId: round2BlockId, anchor: mintedAnchor, text: 'ship it, please' }] }, round2);

  // A second, already-open tab: opened at the same moment as the minting session
  // above (right after round 2 opened, before it was answered -- `mintHtml`,
  // already rendered), subscribed, and about to receive the 'submitted' push a
  // real second tab would get the instant the submit above landed.
  const { document, es } = loadBoardWithEventSource(mintHtml);
  enableCommentMode(document);

  const payload = buildSubmittedPushPayload(board, round2);
  es.dispatch('submitted', JSON.stringify(payload));

  const section = document.querySelector(`[data-block-id="${round2BlockId}"]`);
  assert.ok(section, 'setup failure: the submitted round\'s html block is not in the document after the push');
  const roundSection = document.querySelector('.round[data-round="' + round2 + '"]');
  assert.ok(roundSection, 'setup failure: no round section for round 2');
  assert.equal(roundSection.classList.contains('round-history'), true, 'a submitted push must collapse the round into history');

  const frame = section.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: the swapped-in section has no html-stage iframe');
  // The swapped-in iframe starts out wired to nothing (a freshly-parsed detached
  // node has never had a 'load' listener attached to it by anyone) -- exactly
  // like a real browser's about:blank placeholder, per test/dom-stand-in.mjs's
  // own file comment. Only wireRoot(replacement) having registered that listener
  // makes the srcdoc "navigation" below actually draw the pin.
  frame.loadSrcdoc();

  const layer = section.querySelector('.pin-layer');
  assert.ok(layer, 'setup failure: the swapped-in section has no pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected the pre-existing comment's pin to render on the swapped-in (historical) stage once its real document "loads", got ${pins.length} pin(s) -- if this is 0, the replacement was never wired for anchoring at all`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'the comment minted against this exact element moments earlier must not render as lost');
});

// --- ticket 09 -- audit finding U3: the html-stage case above self-corrects  ----
// (the pin is (re)computed from the iframe's own 'load' event, which only ever
// fires once the frame is actually attached), so it cannot see U3's specific
// defect -- a PAGE-scoped pin has no such later event to hang a recompute off of.
// wireRoot(replacement) draws it once, synchronously, from inside wireRoot
// itself, BEFORE section.replaceWith(replacement) attaches the swapped-in
// section -- so without a post-attach refreshPins, the position it drew is
// computed from the element's ancestor-index chain as it sits under the
// still-detached `wrap` div, not as it sits under #blocks/body/html once
// attached. test/dom-stand-in.mjs's getBoundingClientRect derives its box purely
// from that chain (ticket 07), so the two are provably DIFFERENT, not merely
// unproven -- this check recomputes the same formula src/ui.mjs's renderDomPins
// uses, live, against the NOW-ATTACHED DOM, and compares it to what the pin
// actually got.

check('a round that just went sent, pushed over SSE (\'submitted\'), positions an existing PAGE-SCOPED comment\'s pin correctly on its (now historical) mermaid block -- not wherever wireRoot(replacement) computed while still detached (ablation: deleting applySubmittedPush\'s post-attach refreshPins call, ticket 09 audit finding U3)', () => {
  const board = freshBoard();
  // A mermaid block whose source failed to resolve: ADR.md entry 28 leaves
  // `mermaid` commentable and its `.resolve-error` note is the one part of the
  // section the generic page-scoped gesture can reach (`pre.mermaid` and
  // `.stage-wrap` are chrome). This used to be a markdown block with three list
  // items; markdown carries no page-scoped pin-layer at all now.
  const round2 = addRound(board, { blocks: [{ kind: 'mermaid', source: { path: 'no-such-diagram-u3.mmd' } }] });
  const round2Block = board.blocks.find(b => b.round === round2);
  const round2BlockId = round2Block.id;
  assert.equal(typeof round2Block.error, 'string', 'setup failure: the pushed block must actually fail to resolve');

  // Mint the comment through a REAL client session first, same pattern as the
  // html-stage check above.
  const mintHtml = renderBoardPage(board);
  const mintDoc = parseHTML(mintHtml);
  new Function('document', 'window', 'location', ui)(mintDoc, mintDoc.defaultView, { protocol: 'http:' });
  enableCommentMode(mintDoc);
  const mintTarget = mintDoc.querySelector(`[data-block-id="${round2BlockId}"] .resolve-error`);
  assert.ok(mintTarget, 'setup failure: no .resolve-error note in the minting session\'s mermaid block');
  mintTarget.dispatchEvent(new StandInEvent('click'));
  const mintForm = mintDoc.getElementById('comment-form-' + round2BlockId);
  assert.ok(mintForm && mintForm.classList.contains('open'), 'setup failure: minting the comment through the real client did not open its form');
  const mintedAnchor = {
    kind: mintForm.getAttribute('data-anchor-kind'),
    ref: mintForm.getAttribute('data-anchor-ref'),
    hint: mintForm.getAttribute('data-anchor-label'),
  };
  assert.equal(mintedAnchor.kind, 'dom', 'setup failure: the generic page-scoped gesture must mint a dom anchor');

  applySubmit(board, { action: 'send', answers: [], comments: [{ blockId: round2BlockId, anchor: mintedAnchor, text: 'what happened here' }] }, round2);

  // A second, already-open tab, about to receive the 'submitted' push.
  const { document, es } = loadBoardWithEventSource(mintHtml);
  enableCommentMode(document);

  const payload = buildSubmittedPushPayload(board, round2);
  es.dispatch('submitted', JSON.stringify(payload));

  const section = document.querySelector(`[data-block-id="${round2BlockId}"]`);
  assert.ok(section, 'setup failure: the submitted round\'s mermaid block is not in the document after the push');
  const roundSection = document.querySelector('.round[data-round="' + round2 + '"]');
  assert.equal(roundSection.classList.contains('round-history'), true, 'a submitted push must collapse the round into history');

  const layer = Array.prototype.slice.call(section.children).find(c => c.classList && c.classList.contains('pin-layer'));
  assert.ok(layer, 'setup failure: the swapped-in mermaid block has no page-scoped pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected the pre-existing comment's pin to render on the swapped-in (historical) mermaid block, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'the comment minted against this exact element moments earlier must not render as lost');

  const note = section.querySelector('.resolve-error');
  assert.ok(note, 'setup failure: no .resolve-error note in the swapped-in (second-tab) section');
  const noteBox = note.getBoundingClientRect();
  const sectionBox = section.getBoundingClientRect();
  const expectedLeft = noteBox.left - sectionBox.left;
  const expectedTop = noteBox.top - sectionBox.top;
  assert.equal(pins[0].style.left, expectedLeft + 'px', `expected the pin positioned at the ATTACHED .resolve-error note (${expectedLeft}px), got ${JSON.stringify(pins[0].style.left)} -- computed while wireRoot(replacement) still had the section detached under a bare wrapper div`);
  assert.equal(pins[0].style.top, expectedTop + 'px', `expected the pin positioned at the ATTACHED .resolve-error note (${expectedTop}px), got ${JSON.stringify(pins[0].style.top)} -- computed while wireRoot(replacement) still had the section detached under a bare wrapper div`);
});

// --- ticket 04, criterion 8: the round badge used to be written server-side ---
// only, and the SSE round-push path never touched it -- stale until reload on a
// live tab, invisible on a fresh load because a reload always renders the
// current total. Drives the same subscription every other check in this file
// drives (never applyRoundPush directly, for the same reason the file header
// gives: that would prove nothing about whether the badge is wired to the
// subscription at all), and reads #round-badge's own text back.

check('a round arriving over SSE updates M in the badge immediately, with no reload (ablation: deleting applyRoundPush\'s renderBadge() call)', () => {
  const board = freshBoard();
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);

  const badge = document.getElementById('round-badge');
  assert.ok(badge, 'setup failure: no #round-badge rendered');
  assert.equal(badge.textContent, 'round 1 of 1', 'setup failure: expected the one-round board\'s initial label');

  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: 'round 2, pushed live' }] });
  const round2BlockId = board.blocks.find(b => b.round === round2).id;
  const payload = buildRoundPushPayload(board, round2, 'new-round', [round2BlockId]);

  es.dispatch('round', JSON.stringify(payload));

  assert.equal(badge.textContent, 'round 1 of 2',
    'M must update the instant the round push lands -- no reload, and N (this stand-in has no IntersectionObserver, so it never moves off the hydrate default) is untouched by a round arriving further down the page');
});

check('a round going sent over SSE (\'submitted\') leaves the badge total unchanged, but still re-renders rather than being special-cased away', () => {
  const board = freshBoard();
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: 'round 2, opened first' }] });
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);
  const badge = document.getElementById('round-badge');
  assert.equal(badge.textContent, 'round 1 of 2', 'setup failure: expected the two-round board\'s initial label');

  applySubmit(board, { action: 'send', answers: [], comments: [] }, round2);
  const payload = buildSubmittedPushPayload(board, round2);
  es.dispatch('submitted', JSON.stringify(payload));

  assert.equal(badge.textContent, 'round 1 of 2', 'a submit never changes board.rounds.length, so M is unchanged');
});

// --- the code cap's once-only marker (DESIGN.md polish, audit finding D1) -------
//
// Same family as every check above it, and the same push paths: something that
// runs during `wireRoot(wrap)`/`wireRoot(frag)` sees a DETACHED subtree.
// `unlockCodeCapForDrag` is the one thing in that pass which MEASURES rather
// than merely wiring -- it converts a `max-height`-capped <pre> to a plain
// inline height so the native resize handle can move it (criterion 5), but only
// for a block that is genuinely capped, which it decides from
// `scrollHeight > clientHeight`. Both are 0 on a detached node, so the
// once-only marker being claimed BEFORE that test settled the question as
// "0 > 0, false" and remembered it forever: every code block arriving over SSE
// was permanently undraggable, and the post-attach `refreshPins(document)` that
// exists precisely to redo detached work found the marker set and did nothing.
//
// This drives the real thing -- a real 'round' payload through the real
// EventSource listener, so `wireRoot` runs detached and `refreshPins` runs after
// the attach, exactly as in a browser. The fixture DECLARES the two box metrics
// on the pushed <pre> (test/dom-stand-in.mjs reports them only once the node is
// in a document, and 0 before that), which is the one browser fact this bug
// turns on; the numbers are the ones measured in Chrome 150 for a capped 200-line
// block, 480 visible against 4478 total.

/** Declare the box metrics of the nth `<pre>` in a pushed HTML fragment -- a
 * code block's own `<pre><code>`, never `pre.mermaid`, which carries a class. */
function declarePreBox(html, client, scroll, nth = 0) {
  let seen = -1;
  return html.replace(/<pre><code>/g, m => {
    seen++;
    return seen === nth
      ? `<pre data-standin-client-height="${client}" data-standin-scroll-height="${scroll}"><code>`
      : m;
  });
}

check('a CAPPED code block arriving over SSE gets its cap unlocked once it is attached -- the once-only marker must not be claimed while the subtree is still detached and measures 0 (ablation: moving `pre.__cbCapUnlocked = true` above the clientHeight guard in src/ui.mjs)', () => {
  const board = freshBoard();
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);

  const round2 = addRound(board, { blocks: [{ kind: 'code', text: 'const a = 1;\nconst b = 2;', lang: 'javascript' }] });
  const codeBlockId = board.blocks.find(b => b.round === round2).id;
  const payload = buildRoundPushPayload(board, round2, 'new-round', [codeBlockId]);
  payload.html = declarePreBox(payload.html, 480, 4478);

  es.dispatch('round', JSON.stringify(payload));

  const section = document.querySelector(`[data-block-id="${codeBlockId}"]`);
  assert.ok(section, 'setup failure: the pushed code block is not in the document');
  const pre = section.querySelector('pre');
  assert.ok(pre, 'setup failure: the pushed code block has no <pre>');
  assert.equal(pre.clientHeight, 480, 'setup failure: the fixture\'s declared box did not reach the attached node');
  assert.equal(pre.scrollHeight, 4478, 'setup failure: the fixture\'s declared box did not reach the attached node');

  assert.equal(pre.__cbCapUnlocked, true,
    'the pushed <pre> must have been measured and marked AFTER it was attached -- a marker claimed during the detached wiring pass is never revisited');
  assert.equal(pre.style.maxHeight, 'none',
    'a capped block that arrived by push must have its max-height lifted, or the reviewer\'s resize drag is clamped and the block is undraggable for the life of the page (criterion 5)');
  // The height's VALUE comes from getBoundingClientRect, which this stand-in
  // derives structurally rather than from layout -- so what is asserted is that
  // an explicit inline height was set at all, which is the part that removes the
  // ceiling. The value is verified in real Chrome, not here.
  assert.match(String(pre.style.height || ''), /^\d+(\.\d+)?px$/,
    'unlocking must replace the cap with an explicit inline height, not merely delete the cap');
});

check('...and a SHORT code block arriving the same way is left completely alone -- the unlock must stay conditional, not become "always unlock once attached"', () => {
  // The negative half, so the check above cannot be satisfied by a version that
  // simply unlocks everything: criterion 6 is that a block under the cap renders
  // at its natural height with no handle-induced empty space, which an
  // unconditional inline height would take away.
  const board = freshBoard();
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);

  const round2 = addRound(board, { blocks: [{ kind: 'code', text: 'const a = 1;', lang: 'javascript' }] });
  const codeBlockId = board.blocks.find(b => b.round === round2).id;
  const payload = buildRoundPushPayload(board, round2, 'new-round', [codeBlockId]);
  // Content shorter than the cap: scrollHeight === clientHeight, which is what a
  // browser reports for a box with nothing to scroll.
  payload.html = declarePreBox(payload.html, 96, 96);

  es.dispatch('round', JSON.stringify(payload));

  const pre = document.querySelector(`[data-block-id="${codeBlockId}"] pre`);
  assert.ok(pre, 'setup failure: the pushed code block has no <pre>');
  assert.equal(pre.clientHeight, 96, 'setup failure: the fixture\'s declared box did not reach the attached node');
  assert.equal(pre.style.maxHeight, undefined, 'a short block\'s cap must never be lifted -- it is not capped in the first place');
  assert.equal(pre.style.height, undefined, 'a short block must never be given an explicit height');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall anchor-push checks ok');
