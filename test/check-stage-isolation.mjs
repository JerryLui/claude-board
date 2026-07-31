// Ticket 10 (DESIGN.md), the 2026-07-29 audit's S1 and S2: this is the
// check that exists to prove the property the whole ticket is about, the way
// DESIGN.md's Testing section demands -- against the real gesture, not
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
//      `runInlineScripts`, ticket 10's own extension to that file), cannot
//      reach the parent document -- neither by mutating it directly nor by
//      reading anything off `window.parent` beyond `postMessage`;
//   3. the parent's message listener validates origin, sender identity, and
//      message shape, and a hostile or malformed message from the stage is
//      silently ignored rather than acted on;
//   4. the archive's `<meta http-equiv="Content-Security-Policy">` (S2) is
//      present and carries the same policy the live daemon sends as a header.
//
// Every ablation below is run for real against the actual code, then reverted
// -- DESIGN.md's own standard ("ablation discipline used throughout the
// tickets file"): this file's own comments record what a broken version of
// each property looks like and that check-stage-isolation.mjs actually catches
// it; DESIGN.md's anchoring slice 10 log records the transcripts.

import assert from 'node:assert/strict';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage, CSP } from '../src/render.mjs';
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

function loadBoard(pageHtml, protocol = 'http:') {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
      // every <script> the stage document contains, ticket 10's own extension to
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
    }],
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

// Ablation record (run by hand, reverted immediately after -- DESIGN.md's
// ablation discipline): restoring `sandbox="allow-same-origin allow-scripts"` in
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }],
  });
  return { board, blockId: board.blocks[0].id };
}

check('criterion 12 (stage half): the parent sends a stage the sent REF, never the hint -- or the stage de-affordances nothing and a sent element still reads as a target', () => {
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }],
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
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>other</p></div>' }],
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
// 4. The archive's meta CSP (audit S2).
// =================================================================================

check('S2: renderBoardPage emits a <meta http-equiv="Content-Security-Policy"> carrying the exact same policy the live daemon sends as a header', () => {
  const board = createBoard({
    title: 'isolation: meta CSP',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
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
// hand, reverted immediately after (DESIGN.md's ablation discipline);
// the transcript is recorded in DESIGN.md's anchoring slice 10 log.

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall stage-isolation checks ok');
