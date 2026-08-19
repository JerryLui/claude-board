// This is the
// check that exists to prove the property the whole fix is about, the way
// disciplined testing demands -- against the real gesture, not
// the pieces underneath it.
//
// S1 (HIGH): `sandbox="allow-same-origin allow-scripts"` on the html-stage
// iframe kept the mock's browsing context SAME-ORIGIN with the daemon, so a
// `<script>` in agent-supplied `block.html` ran as first-party at the daemon's
// own origin -- reachable parent document, reachable cookies, reachable fetch
// with credentials. The exploit chain: fetch `/`, enumerate board ids, POST
// `/api/board/<id>/submit` for each, answering a DIFFERENT agent's blocked
// `ask()` with attacker-chosen text.
//
// This file proves the mechanism the fix relies on, end to end, through the
// real `renderHtmlBlock`/`stageAgentScript` (src/render.mjs) and the real `ui`
// (src/ui.mjs), run in test/dom-stand-in.mjs -- never a hand-summary of what
// they do:
//   1. the rendered sandbox attribute never carries `allow-same-origin`;
//   2. a `<script>` inside a mock, actually EXECUTED (test/dom-stand-in.mjs's
//      `runInlineScripts`, an extension to that file), cannot
//      reach the parent document -- neither by mutating it directly nor by
//      reading anything off `window.parent` beyond `postMessage`;
//   3. the parent's message listener validates origin, sender identity, and
//      message shape, and a hostile or malformed message from the stage is
//      silently ignored rather than acted on;
//   4. the archive's `<meta http-equiv="Content-Security-Policy">` (S2) is
//      present and carries the same policy the live daemon sends as a header.
//
// Every ablation below is run for real against the actual code, then reverted
// -- ablation discipline used throughout: this file's own comments record what
// a broken version of each property looks like and that check-stage-isolation.mjs
// actually catches it; the anchoring slice 10 log records the transcripts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage, CSP, STAGE_MARGIN_RESET } from '../src/render.mjs';
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

function loadBoard(pageHtml, protocol = 'http:') {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol };
  // 'EventSource' declared, never passed -- see QUIRKS.md "A `new Function` harness
  // inherits the host's globals".
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);
  return document;
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

// =================================================================================
// 1. The rendered sandbox attribute never carries allow-same-origin.
// =================================================================================

check('S1: the html-stage iframe never carries allow-same-origin -- sandbox is scoped to allow-scripts only', () => {
  const board = createBoard({
    title: 'isolation: sandbox attribute',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const pageHtml = renderBoardPage(board);
  const m = /<iframe class="html-stage" sandbox="([^"]*)"/.exec(pageHtml);
  assert.ok(m, 'setup failure: no .html-stage iframe found in the rendered page');
  assert.ok(!m[1].includes('allow-same-origin'), `sandbox must never carry allow-same-origin, got ${JSON.stringify(m[1])}`);
  assert.ok(m[1].includes('allow-scripts'), 'sandbox must still allow the mock (and the injected stage agent) to run script');
});

// =================================================================================
// 2. A <script> inside a mock cannot reach the parent document -- the property
//    this entire ticket exists to establish.
// =================================================================================

check('S1: a <script> inside a mock cannot reach the parent document, even though it genuinely executes', () => {
  const board = createBoard({
    title: 'isolation: hostile mock script',
    blocks: [{
      kind: 'html',
      // A real, EXECUTING payload (test/dom-stand-in.mjs's runInlineScripts runs
      // every <script> the stage document contains, an extension to
      // that file -- see its header comment) that tries every reach-out this
      // ticket exists to close: mutate the parent's title directly through
      // window.parent, read window.parent.document, and reach window.top.
      // Every attempt is recorded on the stage's OWN window (window.__report),
      // read back below via frame.contentWindow -- never trusted as a message,
      // since a hostile script could always lie in a postMessage payload; this
      // reads the actual, live state of the actual, live stage window instead.
      html: `<div class="mock"><button>Send</button></div><script>
        window.__report = { hasParentDocument: false, mutatedParentTitle: false, topThrew: false };
        try {
          if (typeof window.parent.document !== 'undefined') window.__report.hasParentDocument = true;
        } catch (e) { /* a real browser throws a SecurityError reading this cross-origin */ }
        try {
          window.parent.document.title = 'PWNED';
          window.__report.mutatedParentTitle = true;
        } catch (e) { /* expected: window.parent.document is not reachable */ }
        try {
          if (window.top && window.top.document) window.__report.hasParentDocument = true;
        } catch (e) { window.__report.topThrew = true; }
      </script>`,
    }, { kind: 'markdown', text: 'not a page board' }],
  });
  const pageHtml = renderBoardPage(board);
  const document = loadBoard(pageHtml);
  const originalTitle = document.title;

  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc(); // executes the mock's own <script>, alongside the injected agent

  const report = frame.contentWindow.__report;
  assert.ok(report, 'setup failure: the mock script never ran at all -- fix the fixture or test/dom-stand-in.mjs, not the isolation claim');
  assert.equal(report.hasParentDocument, false, 'a mock script must never observe a `.document` on window.parent (or window.top)');
  assert.equal(report.mutatedParentTitle, false, 'a mock script must never be able to mutate anything on the parent document');
  assert.equal(document.title, originalTitle, `the parent document's own title must be untouched by a hostile mock script, got ${JSON.stringify(document.title)}`);

  // And the ordinary gesture still works alongside a hostile script running in
  // the very same document -- isolation is not achieved by refusing to run the
  // mock's script at all.
  enableCommentMode(document);
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('click'));
  const blockId = board.blocks[0].id;
  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), true, 'the legitimate click-to-anchor gesture must still work in a stage that also runs a hostile script');
});

// Ablation record (run by hand, reverted immediately after -- ablation
// discipline): restoring `sandbox="allow-same-origin allow-scripts"` in
// src/render.mjs's renderHtmlBlock and re-running this file fails the very next
// check below (the message-protocol checks) differently -- with allow-same-origin
// back, a real browser would let the mock's script reach `window.parent.document`
// directly and this stand-in's `window.parent` restriction would no longer model
// what the sandbox actually enforces. This file's own first check above
// ("sandbox... never carries allow-same-origin") is what catches a REVERT of the
// fix textually, immediately, with no ablation needed to notice it: flip the
// literal string in renderHtmlBlock back and that check fails on its own.

// =================================================================================
// 3. Origin/identity/shape validation on the parent's receiving side.
// =================================================================================

check('S1: the parent ignores a message whose origin is not the opaque "null" an unprivileged srcdoc frame actually has', () => {
  const board = createBoard({
    title: 'isolation: origin check',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const stageWindow = frame.contentWindow;
  const blockId = board.blocks[0].id;

  // A real click, forged with a real (non-opaque) origin -- exactly what a
  // compromised same-origin script elsewhere on the page (or a browser
  // extension) could attempt, which an opaque-origin stage itself never could.
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'click', ref: '1.1', tag: 'BUTTON', text: 'Send' },
    origin: 'https://evil.example',
    source: stageWindow,
  });
  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), false, 'a message reporting a non-opaque origin must be ignored, even with a correct source and a well-formed payload');
});

check('S1: the parent ignores a message whose source is not a live, currently-mounted html-stage frame', () => {
  const board = createBoard({
    title: 'isolation: source identity check',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const blockId = board.blocks[0].id;

  // Correct origin, well-formed payload, but `source` is not this (or any)
  // stage's contentWindow -- an object no findStageFrame lookup will ever match.
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'click', ref: '1.1', tag: 'BUTTON', text: 'Send' },
    origin: 'null',
    source: {},
  });
  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), false, 'a message not sourced from a live html-stage frame must be ignored, even with the right origin and a well-formed payload');
});

check('S1: the parent ignores malformed and hostile messages that DO carry a correct origin and a real stage as source', () => {
  const board = createBoard({
    title: 'isolation: shape validation',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const stageWindow = frame.contentWindow;
  const blockId = board.blocks[0].id;
  const form = document.getElementById('comment-form-' + blockId);

  const hostilePayloads = [
    null,
    'a bare string, not an object',
    42,
    ['array', 'not', 'object'],
    {},                                              // no cb marker, no type
    { cb: 'something-else', type: 'click', ref: '1.1' },   // wrong channel marker
    { cb: 'cb-stage' },                               // no type at all
    { cb: 'cb-stage', type: 'click' },                // click with no ref at all
    { cb: 'cb-stage', type: 'click', ref: '' },       // empty ref
    { cb: 'cb-stage', type: 'click', ref: { toString: () => '1.1' } }, // non-string ref, even one that WOULD stringify usefully
    { cb: 'cb-stage', type: 'click', ref: ['1', '1'] },
    { cb: 'cb-stage', type: 'positions', requestId: 'nope', positions: 'not-an-object' },
    { cb: 'cb-stage', type: 'positions', positions: {} },  // no requestId
    { cb: 'cb-stage', type: '__proto__' },
  ];

  for (const data of hostilePayloads) {
    form.classList.remove('open'); // reset between attempts
    document.defaultView.dispatchEvent({ type: 'message', data, origin: 'null', source: stageWindow });
    assert.equal(
      form.classList.contains('open'), false,
      `a hostile/malformed message must never open a comment form: ${JSON.stringify(data)}`,
    );
  }

  // And the parent's own document is provably unharmed by any of the above --
  // in particular the last one, an attempted __proto__ pollution of the
  // dispatch's own type-check chain, leaves Object.prototype untouched.
  assert.equal({}.polluted, undefined, 'a hostile message type must never pollute Object.prototype');

  // Sanity: a GENUINE, well-formed click from the SAME frame still works right
  // after all of the above -- the validation is a filter, not a latch that got
  // stuck rejecting everything once it saw something hostile.
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'a genuine click must still work after a batch of hostile messages was correctly ignored');
});

// =================================================================================
// 3b. What the parent TELLS a stage, and what it refuses to let a stage decide.
// =================================================================================

/** A board with one html stage holding a clickable `<button>` and an
 * uncommented `<p>` to check the negative against. */
function sentStageBoard() {
  const board = createBoard({
    title: 'isolation: sentRefs',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  return { board, blockId: board.blocks[0].id };
}

check('(stage half): the parent sends a stage the sent REF, never the hint -- or the stage de-affordances nothing and a sent element still reads as a target', () => {
  const { board, blockId } = sentStageBoard();
  // First, learn the real ref by clicking the button for real.
  const probeDoc = loadBoard(renderBoardPage(board));
  const probeToggle = probeDoc.getElementById('comment-mode-toggle');
  probeToggle.dispatchEvent(new StandInEvent('click'));
  const probeFrame = probeDoc.querySelector('.html-stage');
  probeFrame.loadSrcdoc();
  probeFrame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  const ref = probeDoc.getElementById('comment-form-' + blockId).getAttribute('data-anchor-ref');
  assert.ok(ref, 'setup failure: no ref minted by a real in-stage click');

  // Now send that exact anchor, with a hint that is nothing like the ref.
  applySubmit(board, {
    action: 'send',
    answers: [],
    // The hint must be the element's own text ('Send') or resolveComment
    // reports the anchor LOST and the parent correctly stops de-affordancing
    // for it -- see liveSentComments in src/ui.mjs. That the ref ('1.1') and
    // the hint ('Send') are nothing alike is the whole point: a parent that
    // sent hints instead of refs would leave the stage matching neither.
    comments: [{ blockId, anchor: { kind: 'dom', ref, hint: 'Send' }, text: 'already sent' }],
  }, 1);

  const document = loadBoard(renderBoardPage(board));
  document.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const stageDoc = frame.contentDocument;
  const button = stageDoc.querySelector('button');
  const other = stageDoc.querySelector('p');

  // Hovering the SENT element inside the stage must de-affordance it. The stage
  // decides this purely from the sentRefs array the parent posted, and compares
  // it against a ref IT mints -- so a parent that sent hints instead of refs
  // leaves this matching nothing and the element hovering as an ordinary target.
  button.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(button.classList.contains('cb-anchor-sent'), true,
    'an element carrying a sent comment must be de-affordanced on hover inside the stage');
  assert.equal(button.classList.contains('cb-anchor-hover'), false,
    'and must NOT also carry the ordinary "you can anchor here" outline');

  // The negative, so this cannot pass against a stage that marks everything.
  button.dispatchEvent(new StandInEvent('mouseout'));
  other.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(other.classList.contains('cb-anchor-hover'), true, 'an un-commented element must still hover as a target');
  assert.equal(other.classList.contains('cb-anchor-sent'), false, 'and must not be de-affordanced');
});

check('S5: a stage-supplied ref may MINT a comment but may never select an existing one to overwrite -- an agent must not be able to make the reviewer\'s next remark replace their feedback on its own block', () => {
  const board = createBoard({
    title: 'isolation: a forged click must not pick an edit target',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const blockId = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  document.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const stageWindow = frame.contentWindow;
  const form = document.getElementById('comment-form-' + blockId);

  // The reviewer queues a real comment through a real click.
  frame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  const ref = form.getAttribute('data-anchor-ref');
  form.querySelector('input[type=text]').value = 'this block is wrong and here is why';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup failure: nothing queued');

  // The stage now forges a click naming that same ref -- the attack: get the
  // form stamped as EDITING the reviewer's own critical comment, so whatever
  // they type next replaces it instead of joining it.
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'click', ref, tag: 'BUTTON', text: 'Send' },
    origin: 'null',
    source: stageWindow,
  });
  assert.equal(form.getAttribute('data-editing-id'), null,
    'a ref the STAGE chose must never select an edit target -- minting is forgeable by design, destroying an existing comment must not be');

  form.querySelector('input[type=text]').value = 'a totally different remark';
  form.dispatchEvent(new StandInEvent('submit'));
  const items = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(items.length, 2, `the original comment must survive: expected 2 queued comments, got ${items.length}`);
  assert.ok(items.map(i => String(i.textContent || '')).join('').includes('this block is wrong'),
    'the reviewer\'s original feedback must still be in the queue, word for word');
});

check('S5: a stage message never clobbers a draft the reviewer is part-way through typing', () => {
  const board = createBoard({
    title: 'isolation: a forged click must not interrupt composition',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const blockId = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  document.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const form = document.getElementById('comment-form-' + blockId);

  frame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  const anchoredOn = form.getAttribute('data-anchor-ref');
  form.querySelector('input[type=text]').value = 'half a sentence so f';

  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'click', ref: '9.9.9', tag: 'P', text: 'other' },
    origin: 'null',
    source: frame.contentWindow,
  });
  assert.equal(form.querySelector('input[type=text]').value, 'half a sentence so f',
    'an unsolicited stage message must not overwrite what the reviewer is typing');
  assert.equal(form.getAttribute('data-anchor-ref'), anchoredOn,
    'and must not silently repoint the open form at an anchor of the stage\'s choosing either');
});

// =================================================================================
// 4. The archive's meta CSP.
// =================================================================================

check('S2: renderBoardPage emits a <meta http-equiv="Content-Security-Policy"> carrying the exact same policy the live daemon sends as a header', () => {
  const board = createBoard({
    title: 'isolation: meta CSP',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const pageHtml = renderBoardPage(board);
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(pageHtml);
  assert.ok(m, 'renderBoardPage must emit a <meta http-equiv="Content-Security-Policy"> in <head>');
  // The attribute is HTML-escaped (escAttr): decode the handful of entities
  // escAttr can produce before comparing against the raw CSP string.
  const decoded = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  assert.equal(decoded, CSP, 'the meta CSP must be byte-identical to the exported CSP the header also sends -- one policy, not two independently maintained ones');
  assert.match(CSP, /default-src 'none'/);
  assert.match(CSP, /connect-src 'self'/);
  assert.match(CSP, /img-src 'self' data: blob:/);

  // It sits inside <head>, before </head> -- meta directives are only honoured
  // when they appear before any content they're meant to constrain.
  const headEnd = pageHtml.indexOf('</head>');
  assert.ok(headEnd !== -1 && m.index < headEnd, 'the meta CSP must be inside <head>');
});

// Ablation record: commenting out the `<meta http-equiv...>` line in
// src/render.mjs's renderBoardPage and re-running this file fails the check
// immediately above with "renderBoardPage must emit a <meta ...>" -- run by
// hand, reverted immediately after (ablation discipline);
// the transcript is recorded in the anchoring slice 10 log.

// =================================================================================
// 5. A stage nested inside a choose-between-
//    rendered-variants option must never be able to select itself.
//
//    An earlier version of this widget had the stage report every click over
//    postMessage -- a content-free 'select' message, posted unconditionally,
//    comment mode or not -- so a click landing on the visible mock content of
//    an html-kind option (not just the card's own chrome outside the iframe)
//    could pick that option. Reverted before this ticket merged: that message
//    is STAGE-AUTHORED input, no different in kind from the mock's own HTML
//    or the agent's own script inside it. Two paths made it unsafe, and
//    neither is exotic for /example's real callers (interactive rendered
//    mockups):
//
//      1. The stage's OWN script could dispatch a click on itself -- an
//         autoplaying demo, an animation, a mock that clicks its own button
//         -- with no reviewer involved at all.
//      2. `cb: 'cb-stage'` is a fixed, documented public string, and origin/
//         identity validation only prove a message came from SOME live,
//         correctly-addressed stage, never that a human acted on it -- so
//         any stage's own script could call
//         `window.parent.postMessage({cb:'cb-stage', type:'select'}, '*')`
//         directly, skipping stageAgentScript's click handling (and this
//         file's own checks above) entirely. Both parent-side checks this
//         file exists to defend -- origin 'null', source a live mounted
//         stage -- pass BY CONSTRUCTION for a message the stage forges about
//         itself; there is no third check that could catch it.
//
//    Guarding the message (an `ev.isTrusted` check on the stage's own click
//    listener, say) would have closed only path 1 -- path 2 forges the
//    message itself, upstream of any such guard. Fixed by deleting the
//    channel instead of guarding it: there is no 'select' message left at
//    all (data.type === 'select' matches no branch in src/ui.mjs's message
//    listener, same as any other unrecognised type), and an html option's
//    iframe is rendered `pointer-events: none` inside a '.choice-variant'
//    card (src/styles.mjs, asserted in test/check-pure.mjs), so a genuine,
//    trusted click over the visible mock can never reach the iframe at all --
//    it lands on the card in the parent document instead, which already
//    handles it. See ADR.md entry 78 for the fuller account.
// =================================================================================

function variantsBoard(mocks) {
  return createBoard({
    title: 'isolation: variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: mocks.map((html, i) => ({ label: 'Option ' + (i + 1), block: { kind: 'html', html } })),
    }],
  });
}

check('A stage cannot pick its own option -- a "select"-shaped message from a live, correctly-addressed mounted stage records no pick', () => {
  const board = variantsBoard(['<div class="mock"><button>A</button></div>']);
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const card = document.querySelector('.choice-variant');

  // Both parent-side checks the rest of this file exists to defend pass here
  // BY CONSTRUCTION: 'null' is exactly the origin an opaque srcdoc frame
  // reports, and frame.contentWindow is a REAL, live, currently-mounted
  // stage -- precisely what the stage's own script could forge directly.
  // What stops this is that there is no handler left for this message type
  // at all, not an origin or identity check -- ablation: reintroducing
  // `if (data.type === 'select') { var card = frame.closest('.choice-
  // variant'); if (card) selectVariant(card); }` in src/ui.mjs's message
  // listener makes this fail.
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'select' },
    origin: 'null',
    source: frame.contentWindow,
  });
  assert.equal(card.classList.contains('selected'), false,
    'a stage must never be able to select its own option -- the agent would be handing itself the answer to its own question');
});

check('A forged "height" message from a live, correctly-addressed stage is clamped between the floor and the cap, never applied as reported outside that range, and a malformed one is silently ignored', () => {
  const board = variantsBoard(['<div class="mock"><button>A</button></div>']);
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  // The real stageAgentScript already reports once here, over the real
  // channel -- this mock declares no data-standin-scroll-height, so the
  // stand-in reports its (undeclared) scrollHeight as 0 and the parent's own
  // shape check (data.height <= 0) drops it, leaving frame.style.height unset.
  // That is the baseline every assertion below moves from.
  frame.loadSrcdoc();
  assert.ok(!frame.style.height, 'setup failure: the real, unrelated initial report should not have set a height');

  function forgeHeight(fields) {
    document.defaultView.dispatchEvent({
      type: 'message',
      data: { cb: 'cb-stage', type: 'height', ...fields },
      origin: 'null',
      source: frame.contentWindow,
    });
  }

  // A hostile, oversized report -- exactly what the stage's own script could
  // post directly (this file's header comment: 'cb: cb-stage' is a fixed,
  // public string, and origin/identity both pass BY CONSTRUCTION for a
  // message a stage forges about itself). Unclamped, a single option's card
  // could grow without limit and push every other option -- and the board's
  // own chrome -- off screen. Ablation: change handleStageHeight's
  // 'Math.min(data.height, STAGE_HEIGHT_CAP)' to just 'data.height' and this
  // fails.
  forgeHeight({ height: 999999 });
  assert.equal(frame.style.height, '600px', 'a hostile oversized height report must be clamped at the cap, never applied as reported');

  // Every shape a hostile or malformed report could take -- none may move the
  // frame off the clamped baseline the line above just set. Same discipline
  // as this file's own 'hostilePayloads' table further up. Ablation: loosen
  // handleStageHeight's guard from '!Number.isFinite(data.height) ||
  // data.height <= 0' to just '!data.height' and the zero/NaN/Infinity cases
  // below still pass, but weakening it further (e.g. dropping the sign check
  // entirely) makes the negative case fail.
  const hostile = [
    { height: -600 },       // negative
    { height: 0 },          // zero -- rejected, not "shrink to nothing"
    { height: Infinity },   // not finite
    { height: NaN },        // not finite
    { height: '600' },      // string, even one that would coerce usefully
    {},                     // no height field at all
  ];
  for (const fields of hostile) {
    forgeHeight(fields);
    assert.equal(frame.style.height, '600px', `a malformed height report must be ignored, not applied: ${JSON.stringify(fields)}`);
  }

  // A stage that sizes itself from the viewport rather than its own
  // content can report a collapsed height that never grows again -- a
  // sliver of label, nothing else. Unfloored, that report would lock the
  // card there permanently. Ablation: drop handleStageHeight's
  // Math.max(STAGE_HEIGHT_FLOOR, ...) wrapper and this fails.
  forgeHeight({ height: 40 });
  assert.equal(frame.style.height, '320px', 'a collapsed height report must floor at the 320px placeholder, never lock the card at the collapsed height it actually reported');

  // Sanity: a genuine, well-formed report between the floor and the cap
  // still applies right after a batch of hostile ones (and a collapsed one)
  // was correctly clamped -- the validation is a range filter, not a latch
  // that got stuck at either edge once it saw something outside it.
  forgeHeight({ height: 450 });
  assert.equal(frame.style.height, '450px', 'a genuine height report between the floor and the cap must still apply after other reports were clamped');
});

// Merge guard, not a criterion: `main` grew a document-level Cmd+Enter board
// traversal (test/check-enter.mjs) after this branch forked, and this widget's
// cards are the only new element on the branch with their own Enter handler.
// Both listeners fired on one chord -- the card's (which checked `ev.key`
// alone, never the modifiers) recorded a pick, and the document's then
// advanced off it -- so 'advance to the next question' silently committed an
// answer on whichever card held focus. Ablation: deleting the
// `if (ev.metaKey || ev.ctrlKey) return;` guard in src/ui.mjs's card keydown
// makes this fail.
check('Cmd+Enter: the modified chord traverses the board, it never picks the focused variant -- plain Enter still does', () => {
  const board = variantsBoard([
    '<div class="mock"><button>A</button></div>',
    '<div class="mock"><button>B</button></div>',
  ]);
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');

  for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
    const ev = new StandInEvent('keydown', { key: 'Enter', ...mod });
    cards[0].dispatchEvent(ev);
    assert.equal(cards[0].classList.contains('selected'), false,
      `Cmd/Ctrl+Enter (${Object.keys(mod)[0]}) on a focused variant card must never record a pick -- the chord belongs to board traversal`);
    // Consumed, but by the DOCUMENT listener (which prevents the chord on
    // every traversal branch), not by the card. This assertion cannot tell the
    // two apart on its own -- the 'selected' assertion above is the one that
    // discriminates -- it only pins that the chord never falls through to the
    // platform unhandled.
    assert.equal(ev.defaultPrevented, true,
      'the modified chord must be consumed by board traversal, not handed back to the browser');
  }

  // The card's own affordance is untouched -- this is what stops the guard
  // above from being "disable the keyboard path" by accident.
  cards[0].dispatchEvent(new StandInEvent('keydown', { key: 'Enter' }));
  assert.equal(cards[0].classList.contains('selected'), true,
    'plain Enter on a focused card must still select it');
});

check('A click landing inside a nested html stage never selects the option, however it got there -- the stage has no live channel back to a pick', () => {
  const board = variantsBoard([
    '<div class="mock"><button>A</button></div>',
    '<div class="mock"><button>B</button></div>',
  ]);
  const document = loadBoard(renderBoardPage(board));
  const frames = document.querySelectorAll('.html-stage');
  frames.forEach(f => f.loadSrcdoc());
  const cards = document.querySelectorAll('.choice-variant');

  // stageAgentScript's own listeners still run inside the mock's document --
  // this dispatch reaches them exactly as a genuine click (or the mock's own
  // script calling .click() on itself) would. test/dom-stand-in.mjs does not
  // model real pointer-events hit-testing (QUIRKS.md), so this cannot prove
  // a genuine mouse click never physically reaches the iframe in a real
  // browser -- that half is src/styles.mjs's `pointer-events: none` alone,
  // asserted structurally in test/check-pure.mjs. What this DOES prove is
  // the other half: even a click that somehow lands inside the stage's own
  // document carries no path back to a selection anymore.
  frames[0].contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), false, 'a click inside stage A\'s mock must never select option A');
  assert.equal(cards[1].classList.contains('selected'), false, 'and must not select option B either');

  frames[1].contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), false);
  assert.equal(cards[1].classList.contains('selected'), false, 'nor must a click inside stage B\'s mock ever select option B');
});

check('The existing element-level comment-anchor gesture into an html option\'s own stage still works exactly as before -- removing "select" did not collaterally break "click"', () => {
  const board = variantsBoard(['<div class="mock"><button>A</button></div>']);
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const card = document.querySelector('.choice-variant');
  const blockId = board.blocks[0].options[0].block.id;

  frame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), true, 'the pre-existing comment-anchor gesture must still work unchanged');
  assert.equal(card.classList.contains('selected'), false, 'and must never also pick the option');
});

// =================================================================================
// 5. The lens mounts a SECOND copy of a stage, and
//    everything above has to hold for that copy too.
//
//    The lens exists because a variant option's stage is inert in its card by
//    design and a reviewer still has to be able to use the mock. It gets that by
//    mounting the same srcdoc a second time inside a <dialog>, where no
//    'pointer-events: none' rule reaches it -- so this section asks the two
//    questions that mount raises: is the copy sandboxed exactly like the original
//    (a lens frame that gained 'allow-same-origin' would re-open S1 wholesale, at
//    the click of a control that is on EVERY stage), and does the copy have any
//    reach into the parent that the original does not.
//
//    The behavioural checks in test/check-stage-lens.mjs cover the rest of the
//    lens; these are the adversarial ones.
// =================================================================================

/** Render a one-stage board, run the client script, and open the lens on it.
 * The trailing markdown block keeps this an ORDINARY board: one html block and
 * nothing else is a page board (src/render.mjs's isPageBoard, ADR.md entry 33),
 * and a page board carries no expand control to open the lens with. */
function openLensOn(mockHtml) {
  const board = createBoard({
    title: 'isolation: the stage lens',
    blocks: [{ kind: 'html', html: mockHtml }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  const inline = document.querySelector('.html-stage');
  document.querySelector('.html-block .expand-btn').dispatchEvent(new StandInEvent('click'));
  return { board, blockId: board.blocks[0].id, document, inline, lens: document.querySelector('.stage-lens-frame') };
}

check('S1: the lens frame is sandboxed identically to the inline stage -- same attribute, and still no allow-same-origin', () => {
  const { inline, lens } = openLensOn('<div class="mock"><button>Send</button></div>');
  assert.ok(lens, 'setup failure: the expand control did not mount a lens frame');
  const sandbox = lens.getAttribute('sandbox');
  assert.equal(sandbox, inline.getAttribute('sandbox'),
    'the lens frame\'s sandbox must be byte-identical to the inline stage\'s -- it is copied off that frame, never re-spelled');
  assert.ok(!String(sandbox).includes('allow-same-origin'),
    `the lens frame must never carry allow-same-origin, got ${JSON.stringify(sandbox)}`);
  assert.ok(String(sandbox).includes('allow-scripts'),
    'and must still run script, or the mock in the lens is a picture rather than a stage');
});

check('S1: with no sandbox attribute to copy, the lens refuses to open at all rather than mounting an unsandboxed copy', () => {
  // Fail closed. The attribute is copied off a live element, so this asks what
  // happens if that element ever stops carrying one -- a future edit to
  // renderHtmlBlock, or anything in the document that strips it. Mounting
  // agent-authored srcdoc with no sandbox at all is same-origin script execution
  // in the daemon's own origin, i.e. S1 with the fix removed; opening nothing is
  // a visibly broken control, which is the direction to fail in.
  const board = createBoard({
    title: 'isolation: the lens fails closed',
    // Two blocks, so this is an ordinary board with an expand control -- see
    // openLensOn above.
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  document.querySelector('.html-stage').removeAttribute('sandbox');
  document.querySelector('.html-block .expand-btn').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelectorAll('.stage-lens').length, 0,
    'the lens must not even be built when there is no sandbox attribute to copy onto its frame');
});

check('S1: a forged message from the LENS frame is inert -- the copy is not one of the page\'s wired stages, and never becomes one', () => {
  // The identity check src/ui.mjs performs is "is event.source the contentWindow
  // of a currently-mounted .html-stage" (findStageFrame). The lens frame is
  // deliberately not one: it carries .stage-lens-frame and nothing else, so it is
  // outside that walk by construction rather than by a guard someone has to
  // remember. This forges the exact message a stage's own script can always send
  // (cb: 'cb-stage' is a fixed public string -- QUIRKS.md "A stage-posted message
  // is agent-authored input"), from a REAL, live, correctly-addressed lens frame.
  const { document, blockId, inline, lens } = openLensOn('<div class="mock"><button>Send</button></div>');
  enableCommentMode(document);
  inline.loadSrcdoc();
  lens.loadSrcdoc();
  const form = document.getElementById('comment-form-' + blockId);
  const payload = { cb: 'cb-stage', type: 'click', ref: '1.1', tag: 'BUTTON', text: 'Send' };

  // Asserted separately from the message below, and measured rather than
  // assumed: giving the lens frame the '.html-stage' class as well leaves the
  // message assertion GREEN, because the listener's next step (closest
  // '.html-block', which a frame inside the dialog does not have) drops it too.
  // Two guards that stop the same demo -- QUIRKS.md's own warning -- so the one
  // this check is named for gets its own assertion rather than riding on the
  // other's coattails.
  assert.equal(document.querySelectorAll('.html-stage').length, 1,
    'the lens frame must not join qsa(\'.html-stage\') -- that walk\'s whole premise is that each frame it finds is one block\'s inline stage');

  document.defaultView.dispatchEvent({ type: 'message', data: payload, origin: 'null', source: lens.contentWindow });
  assert.equal(form.classList.contains('open'), false,
    'a message from the lens frame must be dropped at the identity check, even with the opaque origin and a well-formed payload');

  // The same payload from the INLINE stage does open the form -- so the check
  // above proves the SENDER was rejected, not that the message was malformed.
  document.defaultView.dispatchEvent({ type: 'message', data: payload, origin: 'null', source: inline.contentWindow });
  assert.equal(form.classList.contains('open'), true,
    'setup failure: the same payload from the block\'s own stage must still be accepted');
});

check('S1: a real click inside the lens frame\'s own document is inert too -- the copy is never told comment mode is on, so its agent has no gesture to report', () => {
  const { document, blockId, inline, lens } = openLensOn('<div class="mock"><button>Send</button></div>');
  enableCommentMode(document);
  inline.loadSrcdoc();
  lens.loadSrcdoc();
  const form = document.getElementById('comment-form-' + blockId);

  // The lens frame's agent announced 'ready' when its script ran; the parent
  // dropped it (not a .html-stage), so no 'mode' message ever came back and the
  // agent's own `if (!commentMode) return` gate keeps it silent. Two independent
  // reasons the same click is inert, which is the point: the mount is a viewer.
  lens.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), false, 'a click inside the lens copy must not mint an anchor');

  // ... while the same click in the inline stage still does.
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'setup failure: the inline stage\'s own gesture must be unaffected');
});

// =================================================================================
// 5b. The lens's PICK CONTROL.
//
//     ADR.md 22: the recommendation was a view-only lens and the decision went the
//     other way, so this is the one place in the product where a control that
//     records an answer shares a screen with agent-authored content that is, in
//     the lens, live and scriptable. The terms the overrule was accepted on include
//     an adversarial one -- so these checks are attacks, not descriptions, and each
//     names the MECHANISM that defeats it rather than asserting the outcome and
//     stopping there.
//
//     The stage's own reach is unchanged by any of this: it is still inert inside
//     its card (shown above), still has no message that records a pick, and
//     in the lens it gains pointer input over its OWN document and nothing else.
// =================================================================================

/** A variants board with two html options and a standalone stage below them, run
 * through the real client script. One document, so "a variant lens has a pick
 * control, a standalone lens has none" can be asked of the SAME reused dialog --
 * which is also what pins the teardown that empties it. */
function pickBoard(mocks = ['<div class="mock"><button>A</button></div>', '<div class="mock"><button>B</button></div>'], labels = ['Card A', 'Card B']) {
  const board = createBoard({
    title: 'isolation: the lens pick control',
    blocks: [
      {
        kind: 'question', prompt: 'Which mockup?', widget: 'choose-between-rendered-variants',
        options: mocks.map((html, i) => ({ label: labels[i], block: { kind: 'html', html } })),
      },
      { kind: 'html', html: '<div class="mock"><p>standalone</p></div>' },
    ],
  });
  return board;
}

function expandOn(section) {
  const btn = section.querySelector('.expand-btn');
  assert.ok(btn, 'setup failure: no expand control on that stage');
  btn.dispatchEvent(new StandInEvent('click'));
  return btn;
}

function lensPick(document) { return document.querySelector('.stage-lens .lens-pick'); }

check('Activating the expand control on a variant option opens the lens and does not select that option', () => {
  // INHERITED, not newly built: the card's own click handler already stands
  // down for a click landing on any nested <button> ("a click landing on
  // interactive chrome nested inside this option's OWN rendered block keeps its
  // own meaning", src/ui.mjs), and the expand control is a <button>. It still
  // needs its own check, because nothing else in the suite would notice if that
  // exclusion list lost 'button' -- the comment button beside it would silently
  // start recording picks too. Ablation: drop 'button, ' from that closest(...)
  // list and this fails.
  const board = pickBoard();
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');
  expandOn(cards[0]);

  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'setup failure: the expand control did not open the lens');
  assert.equal(cards[0].classList.contains('selected'), false,
    'opening a variant option in the lens must not pick it -- looking at a mock full size is not choosing it');
  assert.equal(cards[1].classList.contains('selected'), false, 'and must not pick any other option either');
});

check('A lens opened from a variant option carries a pick control naming that option; one opened from a standalone stage carries none', () => {
  const board = pickBoard();
  const standaloneId = board.blocks[1].id;
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');

  expandOn(cards[1]);
  const pick = lensPick(document);
  assert.ok(pick, 'a lens opened from a variant option must carry a pick control');
  assert.match(pick.textContent, /Card B/, `the control must name the option it will pick, got ${JSON.stringify(pick.textContent)}`);
  assert.ok(!pick.textContent.includes('Card A'), 'and must not name any other option');
  assert.equal(pick.disabled, false, 'and must be live on a current round outside comment mode');

  // Same dialog, reused: the standalone open must not inherit the control the
  // variant open left behind. This is the case a lens built once and filled per
  // open gets wrong if teardown forgets to empty the slot.
  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  const standalone = document.querySelector(`.html-block[data-block-id="${standaloneId}"]`);
  assert.ok(standalone, 'setup failure: no standalone html block rendered');
  expandOn(standalone);
  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'setup failure: the standalone lens did not open');
  assert.equal(lensPick(document), null,
    'a lens opened from a standalone stage must carry no pick control -- there is no option to pick');
});

check('The pick control is page chrome in the PARENT document, outside the framed stage, and the stage has no way to cover it', () => {
  const board = pickBoard();
  const document = loadBoard(renderBoardPage(board));
  expandOn(document.querySelectorAll('.choice-variant')[0]);
  const pick = lensPick(document);
  const frame = document.querySelector('.stage-lens-frame');
  const body = document.querySelector('.stage-lens-body');

  // Placement, structurally: in the bar, and NOT inside the element that holds
  // the frame. A control rendered inside the frame would be inside a document
  // the agent wrote; one inside the body could be overlapped by a taller stage.
  assert.ok(pick.closest('.lens-bar'), 'the pick control must live in the lens bar');
  assert.equal(pick.closest('.stage-lens-body'), null, 'never inside the element that frames the stage');
  assert.equal(pick.closest('.stage-lens-frame'), null, 'and never inside the frame itself');
  assert.equal(frame.closest('.lens-bar'), null, 'and the frame must not be inside the bar either');
  assert.notEqual(document.querySelector('.stage-lens .lens-bar'), null, 'setup failure: no bar');

  // Occlusion, against the REAL stylesheet (test/dom-stand-in.mjs's cascade
  // resolver): the only way flow content could end up drawn over the bar is by
  // leaving normal flow. Neither the body nor the frame is positioned or given
  // a stacking context, and the stage -- a cross-origin iframe -- paints only
  // inside its own box, so "outside the frame" is structural rather than a
  // z-order that could be lost. Ablation: give .stage-lens-frame
  // 'position: absolute' and this fails.
  for (const [name, el] of [['.stage-lens-body', body], ['.stage-lens-frame', frame]]) {
    assert.equal(resolveComputedProperty(styles, el, true, 'position'), '',
      `${name} must stay in normal flow -- positioning it is how the stage would get a chance to cover the pick control`);
    assert.equal(resolveComputedProperty(styles, el, true, 'z-index'), '',
      `${name} must not open a stacking context of its own`);
  }
});

check('An option label is agent-authored content and reaches the control as TEXT -- markup in a label can never become an element in this document', () => {
  // Board content is arbitrary agent-supplied text (src/markdown.mjs's
  // threat-model comment). The control sets it via textContent, so nothing is
  // parsed; this is the same property escHtml gives the card's own label, by a
  // different mechanism, and it needs its own check because this one is built at
  // runtime rather than rendered server-side.
  const label = '<img src=x onerror="window.__pwned = true"></button><b>Card A</b>';
  const board = pickBoard(['<div class="mock"><button>A</button></div>'], [label]);
  const document = loadBoard(renderBoardPage(board));
  expandOn(document.querySelector('.choice-variant'));
  const pick = lensPick(document);

  assert.ok(pick.textContent.includes(label), 'the label must reach the control verbatim, as its text');
  assert.deepEqual(pick.childNodes.filter(n => n.nodeType === 1), [],
    'and must produce no elements at all inside the control -- a parsed label is a script injection');
  assert.equal(globalThis.__pwned, undefined, 'nothing in a label may ever execute');
});

check('(adversarial): a hostile mock in the lens cannot reach, press or forge its way to the pick control -- only draw a fake one inside its own box', () => {
  // Every attempt a mock can actually make, made for real from inside the lens
  // frame's live document, with what stops each named on the assertion.
  const hostile = '<div class="mock"><button id="fake">Pick Card A</button></div><script>'
    + 'window.__report = { sawParentDocument: false, clickedRealPick: false, reachedTop: false };'
    + 'try { if (typeof window.parent.document !== "undefined") window.__report.sawParentDocument = true; } catch (e) {}'
    + 'try { window.parent.document.querySelector(".lens-pick").click(); window.__report.clickedRealPick = true; } catch (e) {}'
    + 'try { if (window.top && window.top.document) window.__report.reachedTop = true; } catch (e) {}'
    // The two message shapes a pick could plausibly travel on. Both are forged
    // from a real, live frame with the opaque origin the parent requires -- the
    // only thing that stops them is that no such handler exists at all.
    + 'try { window.parent.postMessage({ cb: "cb-stage", type: "pick", choice: "Card A" }, "*"); } catch (e) {}'
    + 'try { window.parent.postMessage({ cb: "cb-stage", type: "select", choice: "Card A" }, "*"); } catch (e) {}'
    + '</script>';
  const board = pickBoard([hostile, '<div class="mock"><button>B</button></div>']);
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');
  expandOn(cards[0]);
  const frame = document.querySelector('.stage-lens-frame');
  frame.loadSrcdoc(); // runs the hostile script inside the lens copy, for real

  const report = frame.contentWindow.__report;
  assert.ok(report, 'setup failure: the hostile script never ran -- fix the fixture, not the claim');
  assert.equal(report.sawParentDocument, false,
    'sandbox="allow-scripts" with no allow-same-origin gives the frame an opaque origin: window.parent.document is unreachable, so the control cannot be found');
  assert.equal(report.clickedRealPick, false, 'and therefore cannot be clicked through the DOM either');
  assert.equal(report.reachedTop, false, 'nor reached around through window.top');
  assert.equal(cards[0].classList.contains('selected'), false,
    'and neither forged message records a pick: there is no message type on this channel that selects an option');

  // Its own live pointer input, which in the lens it genuinely has
  // -- on its own fake chrome, which is all a click inside a frame can ever
  // reach. This is ADR 22's accepted residual risk: the fake button can be
  // DRAWN, and pressing it does nothing.
  frame.contentDocument.getElementById('fake').dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), false,
    'a click on the mock\'s own fake chrome must record nothing -- a click inside a frame is delivered in that frame\'s document and does not cross the boundary');
  assert.equal(cards[1].classList.contains('selected'), false, 'and must not pick any other option either');

  // The real control is still exactly where it was, and still works -- the
  // attacks are refused, not answered by disabling the feature.
  const pick = lensPick(document);
  assert.ok(pick, 'the real control must still be there after all of that');
  pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), true, 'and a real press on it must still record the pick');
});

check('(adversarial): a forged pick-shaped message from the INLINE stage records nothing either -- the channel has no handler for one, wherever it comes from', () => {
  // The lens copy is not in the '.html-stage' walk at all (section 5 above), so
  // the harder version of this attack is the message coming from the frame the
  // parent DOES recognise: correct opaque origin, correct live source, a block
  // this page really rendered.
  const board = pickBoard();
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();

  for (const data of [
    { cb: 'cb-stage', type: 'pick', choice: 'Card A' },
    { cb: 'cb-stage', type: 'select', choice: 'Card A' },
    { cb: 'cb-stage', type: 'pick', card: 0 },
    { cb: 'cb-stage', type: 'click', ref: '1.1', pick: true },
  ]) {
    document.defaultView.dispatchEvent({ type: 'message', data, origin: 'null', source: frame.contentWindow });
    assert.equal(cards[0].classList.contains('selected'), false,
      `no message a stage can send may ever record a pick: ${JSON.stringify(data)}`);
  }
});

// =================================================================================
// 6. The html-stage gutter ("kill the html-stage
//    gutter"): a bare-fragment `srcdoc` gets the UA default `body { margin:
//    8px }`, which shows `.html-stage`'s own painted background through an
//    8px gutter on every side. renderHtmlBlock (src/render.mjs) fixes this by
//    prepending STAGE_MARGIN_RESET -- a plain `<style>` reset, deliberately
//    NOT an explicit <html><head>...</head><body>...</body></html> wrapper --
//    ahead of block.html and stageAgentScript(). Checked here on the rendered
//    document string, no browser needed (this file's own remit): the srcdoc
//    text itself, never a layout measurement the stand-in cannot make.
// =================================================================================

check('Every html-stage srcdoc opens with the exact margin/padding reset renderHtmlBlock exports as STAGE_MARGIN_RESET, immediately before the mock\'s own markup', () => {
  const board = createBoard({
    title: 'gutter: reset is present and leads',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  const srcdoc = document.querySelector('.html-stage').getAttribute('srcdoc');
  assert.ok(srcdoc, 'setup failure: no srcdoc on the rendered .html-stage frame');
  assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0,
    'the srcdoc must open with the exact exported STAGE_MARGIN_RESET string, not a hand-copied re-spelling of it');
  assert.equal(srcdoc.indexOf(board.blocks[0].html), STAGE_MARGIN_RESET.length,
    'the mock\'s own markup must immediately follow the reset, with nothing else between them');

  // Ablation record (run by hand, reverted immediately after -- restore via a
  // second edit, never `git checkout` on uncommitted work, per this repo's own
  // QUIRKS.md): deleting the `STAGE_MARGIN_RESET +` prefix in renderHtmlBlock's
  // `srcdocContent` assignment makes this check fail immediately, on the first
  // assertion above -- that assignment is the one place this string is ever
  // added, so there is no other path that could still satisfy it.
});

check('The reset carries no color of any kind -- html/body must stay transparent, so a mock that paints no background of its own lands on the parent-controlled --stage-bg, not on a color this file introduced', () => {
  assert.doesNotMatch(STAGE_MARGIN_RESET, /background|color|#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/,
    `STAGE_MARGIN_RESET must be a pure margin/padding reset, no paint of any kind: ${JSON.stringify(STAGE_MARGIN_RESET)}`);
  assert.match(STAGE_MARGIN_RESET, /margin\s*:\s*0/, 'the reset must actually zero the margin -- that is its whole job');
});

check('The reset is itself a leading head-only element, so it hoists out of document.body exactly like a mock\'s own leading <style> already does (the C2 fix) -- body\'s children, and therefore every dom-anchor ref index, are unaffected by its presence', () => {
  // The regression this check exists to catch: an earlier version of this fix
  // wrapped the srcdoc in an explicit <html><head>...</head><body>...</body>
  // </html> document instead of a bare leading <style>. Once <body> is
  // genuinely, explicitly open, the HTML parsing algorithm inserts a
  // SUBSEQUENT style/script tag as an ordinary child of body rather than
  // reopening head for it -- so a mock with its own leading <style> (the
  // ordinary case this fix exists to support -- see this file's C2-flavoured
  // checks below) got body.children shifted by one, and every dom-anchor ref
  // minted against it went off-by-one. Caught by test/check-click.mjs's own C2
  // check the first time this was tried; this is the same property, pinned
  // here on the stage-isolation side too.
  const board = createBoard({
    title: 'gutter: reset does not disturb the C2 hoist',
    blocks: [{ kind: 'html', html: '<style>.mock{font:14px system-ui}</style><div class="mock"><button>Send</button></div>' }],
  });
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();

  // Both the reset AND the mock's own leading <style> must have been hoisted
  // out of body -- so body has exactly two children: the mock's own div
  // (still FIRST, unaffected by either style tag), then the trailing injected
  // stage-agent <script>. Three or more would mean a style tag stayed in body.
  assert.equal(frame.contentDocument.body.children.length, 2,
    'both the reset and the mock\'s own leading <style> must hoist out of body, leaving only the mock\'s div and the trailing agent script');
  assert.equal(frame.contentDocument.body.children[0].tagName, 'DIV', 'the mock\'s own top-level element must still be body\'s first child');
  assert.equal(frame.contentDocument.body.children[1].tagName, 'SCRIPT', 'the injected stage agent must still be body\'s last child');

  // And the two hoisted <style> elements landed in head, in encounter order --
  // the reset first (it is prepended ahead of block.html), the mock's own
  // second.
  const headStyles = frame.contentDocument.head.children.filter(el => el.tagName === 'STYLE');
  assert.equal(headStyles.length, 2, 'both leading <style> tags must have hoisted into head');
  assert.match(headStyles[0].textContent, /margin\s*:\s*0/, 'the reset must be the FIRST hoisted style');
  assert.match(headStyles[1].textContent, /\.mock/, 'the mock\'s own style must be the second, still present and unaltered');
});

check('An html-kind variant option\'s clipped stage carries the same reset, ahead of that option\'s own mock -- the fix is not special-cased to a standalone stage', () => {
  const board = createBoard({
    title: 'gutter: variant option stage',
    blocks: [{
      kind: 'question', prompt: 'Which mockup?', widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', block: { kind: 'html', html: '<div class="mock">A</div>' } },
        { label: 'B', block: { kind: 'html', html: '<div class="mock">B</div>' } },
      ],
    }],
  });
  const document = loadBoard(renderBoardPage(board));
  const frames = document.querySelectorAll('.html-stage');
  assert.equal(frames.length, 2, 'setup failure: expected one stage per option');
  for (const frame of frames) {
    const srcdoc = frame.getAttribute('srcdoc');
    assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0, 'every variant option\'s stage must open with the same reset as a standalone stage');
  }
});

check('A compare side\'s html stage carries the same reset -- renderCompareSide/renderBlock share renderHtmlBlock, not a second srcdoc builder', () => {
  const board = createBoard({
    title: 'gutter: compare side stage',
    blocks: [{
      kind: 'compare',
      left: { label: 'Old', block: { kind: 'markdown', markdown: 'old copy' } },
      right: { label: 'New', block: { kind: 'html', html: '<div class="mock">new</div>' } },
    }],
  });
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.compare-side .html-stage');
  assert.ok(frame, 'setup failure: no html-stage rendered on the compare side');
  const srcdoc = frame.getAttribute('srcdoc');
  assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0, 'the compare side\'s stage must open with the same reset as a standalone stage');
});

check('The stage lens opens on the exact same srcdoc, reset included -- it is a copy of the live attribute, never a second render', () => {
  // Two blocks: an ordinary board, so the stage has an expand control at all
  // (see openLensOn above).
  const board = createBoard({
    title: 'gutter: the lens',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  const inline = document.querySelector('.html-stage');
  document.querySelector('.html-block .expand-btn').dispatchEvent(new StandInEvent('click'));
  const lens = document.querySelector('.stage-lens-frame');
  assert.ok(lens, 'setup failure: the expand control did not mount a lens frame');
  assert.equal(lens.getAttribute('srcdoc'), inline.getAttribute('srcdoc'),
    'the lens frame\'s srcdoc must be byte-identical to the inline stage\'s -- including the reset, since it is copied off that frame rather than rebuilt');
  assert.equal(lens.getAttribute('srcdoc').indexOf(STAGE_MARGIN_RESET), 0, 'and must therefore also open with the reset');
});

// =================================================================================
// 7. Every live message type is documented in src/render.mjs's own design
//    comment (the "MESSAGES." section, above stageAgentScript) -- a drift check,
//    not a behavioural one. That comment has fallen behind twice already
//    (this chunk added the third missing type, 'band', on top of two others
//    nobody had caught): a type gets added at a send/receive site and the prose
//    describing the channel is never touched, because nothing forces it to be.
//    This makes the omission a red `npm run check` instead of a silent gap.
// =================================================================================

const RENDER_SRC_PATH = fileURLToPath(new URL('../src/render.mjs', import.meta.url));
const UI_SRC_PATH = fileURLToPath(new URL('../src/ui.mjs', import.meta.url));
const PROTOCOL_PATH = fileURLToPath(new URL('../PROTOCOL.md', import.meta.url));
const renderSrcText = readFileSync(RENDER_SRC_PATH, 'utf8');
const uiSrcText = readFileSync(UI_SRC_PATH, 'utf8');
const protocolText = readFileSync(PROTOCOL_PATH, 'utf8');

/** Every `type:` string either half of the channel actually sends, read off the
 * real message literals rather than off any hand-kept list -- an object literal
 * whose first key is `type`, in either file's raw source text, so a type
 * introduced on either side is caught the same way.
 *
 * This used to match the CALL shapes instead (`post({ type: 'x', ... })`,
 * `postToStage(frame, { type: 'x', ... })`), and that was too narrow the moment a
 * message had to be built before it was sent: the stage's mermaid facade keeps
 * its request object so it can RESEND it until the parent answers
 * (src/render.mjs's stageMermaidPrelude), so its literal no longer sits inside
 * the parenthesis and the extractor stopped seeing a type that is very much
 * live. Matching the literal is not looser in practice -- checked against both
 * files, every `{ type: '...' }` in either of them exists to be posted -- and it
 * survives the next message that needs to be held before it is sent. It still
 * deliberately does NOT match
 * on `data.type === 'x'` (a receive branch): the design comment's own contract is
 * "every message this channel SENDS", and 'select' is discussed at length in
 * prose (src/render.mjs's no-'select' passage, ADR.md entry 78) without ever being sent
 * by a real `post`/`postToStage` call -- matching receives as well as sends would
 * require this checker to also know that passage is describing a DELETED type
 * rather than a live one, which is exactly the judgment a regex should not need
 * to make. Sends are the ground truth for "is this type live" on a channel where
 * every receiver already has to tolerate an unrecognised type (shape validation,
 * this file's own section 3) -- nothing here reaches the parent or the stage
 * without first being posted. */
function liveMessageTypes(renderSrc, uiSrc) {
  const types = new Set();
  for (const src of [renderSrc, uiSrc]) {
    for (const m of src.matchAll(/\{\s*type:\s*'(\w+)'/g)) types.add(m[1]);
  }
  return types;
}

/** Every `'type'` PROTOCOL.md documents, read off its own tables rather than off
 * a hand-kept list of what they OUGHT to say. The two tables live under
 * "## Stage postMessage channel" and the section is read to the next `## ` -- the
 * same "walk until the shape breaks" idiom `parseBlockShapes` (src/prose-check.mjs)
 * already uses on this file, so the section can grow without an end marker here
 * going stale.
 *
 * A message-type entry is a table row whose FIRST cell is a lone backticked name,
 * nothing else in the section is shaped that way. That is what keeps the
 * "There is no `select` message" subsection inert: it names 'select' repeatedly in
 * prose but never as a row's leading cell, so a deleted type is discussed at
 * length without registering as documented -- correct, since nothing sends it
 * (liveMessageTypes above), and a check that accepted "mentioned anywhere in
 * prose" would wave through a stray reference exactly like the deleted type's
 * own name.
 *
 * Reads PROTOCOL.md, not src/render.mjs: the message tables moved there when the
 * 291-line design comment was replaced by a pointer. The binding is the point --
 * the tables are only load-bearing for as long as something fails when the code
 * outgrows them, so the extractor follows the content rather than the file. */
function documentedMessageTypes(protocolSrc) {
  const heading = '## Stage postMessage channel';
  const start = protocolSrc.indexOf(heading);
  assert.ok(start >= 0, `setup failure: "${heading}" not found in PROTOCOL.md`);
  const types = new Set();
  for (const line of protocolSrc.slice(start + heading.length).split('\n')) {
    if (line.startsWith('## ')) break; // the section ends where the next one opens
    const m = /^\|\s*`(\w+)`\s*\|/.exec(line);
    if (m) types.add(m[1]);
  }
  return types;
}

check('every live message type (a real post()/postToStage() call site) has an entry in PROTOCOL.md', () => {
  const live = liveMessageTypes(renderSrcText, uiSrcText);
  const documented = documentedMessageTypes(protocolText);
  const missing = [...live].filter(t => !documented.has(t));
  assert.deepEqual(missing, [], `undocumented live message type(s): ${missing.join(', ')}`);
});

check('the twelve live types are exactly ready/hover/click/positions/height/scroll/mermaid/scrollBy/mode/locate/band/diagrams', () => {
  // Pinned by hand once, so a type silently renamed (not just added) is also
  // caught: the check above only ever notices ADDITIONS relative to the
  // comment, never a live type and its comment entry drifting to two
  // different names in lockstep.
  //
  // 'mermaid'/'diagrams' are the newest pair: a diagram-bearing stage asking
  // this page to draw its figures, and the page answering with the SVGs. The
  // stage half is sent from the engine facade src/render.mjs prepends to such a
  // stage's srcdoc, through the same `post({ type: ... })` shape the agent
  // script uses -- which is exactly what keeps it visible to the extractor
  // above rather than being a send this drift check cannot see.
  const live = liveMessageTypes(renderSrcText, uiSrcText);
  assert.deepEqual([...live].sort(),
    ['band', 'click', 'diagrams', 'height', 'hover', 'locate', 'mermaid', 'mode', 'positions', 'ready', 'scroll', 'scrollBy'].sort());
});

check('the deleted \'select\' type is not live, and is not required to be documented', () => {
  const live = liveMessageTypes(renderSrcText, uiSrcText);
  assert.ok(!live.has('select'), '\'select\' must never be sent by a real post()/postToStage() call');
  // documentedMessageTypes is free to not know about 'select' at all -- the
  // "There is no `select` message, deliberately" passage does not open a line
  // with `'select'` as a table cell, so it
  // never lands in the documented set either. Asserting that here pins the
  // negative: a documented set that DID somehow pick up 'select' would still
  // pass the drift check above (an extra documented entry is harmless), so
  // this is the only place that would notice the parser drifting the wrong way.
  const documented = documentedMessageTypes(protocolText);
  assert.ok(!documented.has('select'), 'the "There is no `select` message" passage must not parse as a documentation entry');
});

check('the drift check actually fails when a type is added to the code and not to PROTOCOL.md (proved, not assumed)', () => {
  // The regression this whole section exists to catch, reproduced directly:
  // splice in a real-shaped send for a brand new type nowhere in the design
  // comment, and confirm the same comparison the check above runs actually
  // flags it. Proves the extractor is live, not a check that only ever passes.
  const mutatedRenderSrc = renderSrcText.replace(
    "post({ type: 'ready' });",
    "post({ type: 'ready' });\n  post({ type: 'zzzUndocumented' });",
  );
  assert.notEqual(mutatedRenderSrc, renderSrcText, 'setup failure: the splice point ("post({ type: \'ready\' });") was not found');
  const live = liveMessageTypes(mutatedRenderSrc, uiSrcText);
  const documented = documentedMessageTypes(protocolText);
  const missing = [...live].filter(t => !documented.has(t));
  assert.deepEqual(missing, ['zzzUndocumented'], 'adding an undocumented send did not trip the drift check');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall stage-isolation checks ok');
