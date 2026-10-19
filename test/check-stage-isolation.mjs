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
import { styles } from '../src/styles.mjs';
import { StandInEvent, resolveComputedProperty, withFrameClock } from './dom-stand-in.mjs';
import { check, finish, pageHarness } from './support.mjs';

const { loadBoard, enableCommentMode, clickThemeToggle } = await pageHarness();

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

check('(stage half): the parent sends a stage the sent REF, never the hint, at ready and on every mode toggle -- and the stage paints a sent element inert and an ordinary one as a target', () => {
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
  assert.equal(button.classList.contains('cb-anchor-sent'), false,
    'leaving the sent element must clear its sent class too, or it stays de-affordanced for good');

  // The two classes the hover handler sets are the two the injected stylesheet
  // styles: a target gets an outline, a sent element only a not-allowed cursor
  // and no outline at all, so it reads as inert rather than as another target.
  const injected = stageDoc.head.children.filter(el => el.tagName === 'STYLE').map(el => el.textContent).join('\n');
  const hoverRule = /\.cb-anchor-hover \{([^}]*)\}/.exec(injected);
  const sentRule = /\.cb-anchor-sent \{([^}]*)\}/.exec(injected);
  assert.ok(hoverRule, 'the injected stylesheet must carry a rule for the hover class the handler sets');
  assert.match(hoverRule[1], /outline:/, 'and that rule must outline the target');
  assert.ok(sentRule, 'the injected stylesheet must carry a rule for the sent class the handler sets');
  assert.match(sentRule[1], /cursor: not-allowed/, 'the sent rule must set cursor: not-allowed');
  assert.doesNotMatch(sentRule[1], /outline/, 'a de-affordanced element must not carry an outline of any kind');

  // The other moment the parent tells a stage its sent refs: a stage wired while
  // comment mode is still off, which the toggle then turns on (broadcastStageMode).
  // The hover stylesheet is not injected until that moment.
  const late = loadBoard(renderBoardPage(board));
  const lateFrame = late.querySelector('.html-stage');
  lateFrame.loadSrcdoc();
  const lateStyles = () => lateFrame.contentDocument.head.children.filter(el => el.tagName === 'STYLE' && el.textContent.includes('cb-anchor-hover'));
  assert.equal(lateStyles().length, 0, 'no hover stylesheet may be injected before comment mode is on');
  late.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  assert.equal(lateStyles().length, 1, 'turning comment mode on injects the hover stylesheet once');
  const lateButton = lateFrame.contentDocument.querySelector('button');
  lateButton.dispatchEvent(new StandInEvent('mouseover'));
  assert.equal(lateButton.classList.contains('cb-anchor-sent'), true,
    'the mode toggle must carry the block\'s sent refs too, not an empty list that un-sends the element');
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
//    card (src/styles.mjs, computed in test/check-stage-lens.mjs), so a genuine,
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

// =================================================================================
// Stage sizing (ADR.md entry 119): every stage outside a page board fits the
// height it reports up to 600px and folds past it; the Show full height bar opens
// it in place. Driven through the real stageAgentScript where a measurement is
// the point, and through forged reports where the rule is: the stand-in has no
// layout, so a mock "is" whatever height its fixture declares (QUIRKS.md
// "scrollHeight and clientHeight model exactly one fact"), and the clock is
// turned by hand (withFrameClock).
// =================================================================================

// '.html-stage' draws a 1px border top and bottom and '* { box-sizing:
// border-box; }' counts it inside the height, so a box that shows N pixels of
// mock with no inner scrollbar is N + 2 tall.
const FRAME_EDGE = 2;

/** One mock, rendered in the two places a stage stands outside a variant card:
 * as a top-level block and inside a question's context. Two blocks, so the board
 * is not a page board. */
function placements(html) {
  const board = createBoard({
    title: 'stage sizing',
    blocks: [
      { kind: 'html', html },
      { kind: 'question', prompt: 'Which?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }], context: [{ kind: 'html', html }] },
    ],
  });
  const document = loadBoard(renderBoardPage(board));
  const top = document.querySelector('section.html-block .html-stage');
  const context = document.querySelector('.context-item.html-block .html-stage');
  assert.ok(top && context, 'setup failure: expected a top-level stage and a question-context stage');
  return { document, top, context };
}

function forgeStageHeight(document, frame, height) {
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'height', height },
    origin: 'null',
    source: frame.contentWindow,
  });
}

function blockOf(frame) { return frame.closest('.html-block'); }
function barOf(frame) { return blockOf(frame).querySelector('.stage-fold'); }
function toggleOf(frame) { return blockOf(frame).querySelector('.stage-fold-toggle'); }
function barShown(frame) { return resolveComputedProperty(styles, barOf(frame), true, 'display') !== 'none'; }

check('A forged "height" message from a live, correctly-addressed stage is clamped at the cap, never applied as reported past it, and a malformed one is silently ignored', () => {
  const board = variantsBoard(['<div class="mock"><button>A</button></div>']);
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  // Loaded before the clock is installed, so the real stageAgentScript books
  // no animation frame and reports nothing of its own: every height below is
  // one this check forged, which is the baseline every assertion moves from.
  frame.loadSrcdoc();
  assert.ok(!frame.style.height, 'setup failure: no height should be applied before any report');

  withFrameClock((clock) => {
    function forgeHeight(fields) {
      document.defaultView.dispatchEvent({
        type: 'message',
        data: { cb: 'cb-stage', type: 'height', ...fields },
        origin: 'null',
        source: frame.contentWindow,
      });
      clock.frames();
    }

    // A hostile, oversized report -- exactly what the stage's own script could
    // post directly (this file's header comment: 'cb: cb-stage' is a fixed,
    // public string, and origin/identity both pass BY CONSTRUCTION for a
    // message a stage forges about itself). Unclamped, a single option's card
    // could grow without limit and push every other option -- and the board's
    // own chrome -- off screen. Ablation: change applyStageHeight's fold
    // branch to take the reported height instead of STAGE_HEIGHT_CAP and this
    // fails.
    forgeHeight({ height: 999999 });
    assert.equal(frame.style.height, '600px', 'a hostile oversized height report must be clamped at the cap, never applied as reported');

    // Every shape a hostile or malformed report could take -- none may move the
    // frame off the clamped baseline the line above just set, however long it
    // is left to settle. Ablation: loosen handleStageHeight's guard from
    // '!Number.isFinite(data.height) || data.height <= 0' to just
    // '!data.height' and the zero/NaN/Infinity cases below still pass, but
    // weakening it further (e.g. dropping the sign check entirely) makes the
    // negative case fail.
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
      clock.elapse(5000);
      clock.frames();
      assert.equal(frame.style.height, '600px', `a malformed height report must be ignored, not applied: ${JSON.stringify(fields)}`);
    }

    // Sanity: a genuine, well-formed report under the cap still applies right
    // after a batch of hostile ones was refused -- the validation is a range
    // filter, not a latch that got stuck at the edge once it saw something
    // outside it.
    forgeHeight({ height: 450 });
    clock.elapse(5000);
    clock.frames();
    assert.equal(frame.style.height, `${450 + FRAME_EDGE}px`, 'a genuine height report under the cap must still apply after other reports were refused');
  });
});

check('stage sizing: a stage outside a variant card fits the height its own document reports, top-level and in a question\'s context alike, and not before its first layout (ablation 1: put back handleStageHeight\'s "if (!frame.closest(\'.choice-variant\')) return;" and both stay at the placeholder; ablation 2: make reportHeightAfterLayout call reportHeight() straight away and a height lands on the first frame)', () => {
  const { top, context } = placements('<body data-standin-scroll-height="450"><p>a short mock</p></body>');
  withFrameClock((clock) => {
    top.loadSrcdoc();
    context.loadSrcdoc();
    // A srcdoc frame's own script measures 0 until its document has been
    // through a layout pass, which the first animation frame does not promise
    // (QUIRKS.md "A sandboxed srcdoc frame's own script runs before its first
    // layout"): the measurement waits for the second.
    clock.frame();
    assert.ok(!top.style.height && !context.style.height,
      'nothing may apply before the stage has had its own first layout');
    clock.frames();
  });
  assert.equal(top.style.height, `${450 + FRAME_EDGE}px`, 'a top-level stage must take its content height');
  assert.equal(context.style.height, `${450 + FRAME_EDGE}px`, 'a question-context stage must take its content height too');
  assert.equal(barShown(top), false, 'a stage that fits shows no Show full height bar');
  assert.equal(barShown(context), false);
});

check('stage sizing: every stage holds the 320px placeholder until its first report -- top-level, in a question\'s context and in a variant option -- and none carries the drag grip (ablation: put "resize: vertical" back on .html-stage, or drop its "height: 320px")', () => {
  const { document, top, context } = placements('<p>a mock</p>');
  const variants = loadBoard(renderBoardPage(variantsBoard(['<p>a mock</p>'])));
  const variant = variants.querySelector('.choice-variant .html-stage');
  for (const [where, frame] of [['top-level', top], ['context', context], ['variant', variant]]) {
    assert.equal(resolveComputedProperty(styles, frame, true, 'height'), '320px', `${where}: the placeholder must be 320px, never lower`);
    assert.ok(!frame.style.height, `${where}: and nothing inline before a report`);
    assert.ok(['', 'none'].includes(resolveComputedProperty(styles, frame, true, 'resize')),
      `${where}: no stage carries a drag grip -- a stage the reader can drag is a stage whose height is no longer its content's`);
  }
  assert.equal(document.querySelectorAll('.stage-fold').length, 2, 'setup failure: both placements carry the Show full height bar');
});

check('stage sizing: a stage goes under 320px only on two matching reports, and never under 120px (ablation 1: drop the __cbStageMatched test in applyStageHeight and a lone sliver shrinks the stage; ablation 2: drop STAGE_HEIGHT_MIN and a matched sliver lands at its own height)', () => {
  // The real stage, settling short: stageAgentScript posts a new height twice,
  // one full rendering update apart, so a mock that IS short says so twice.
  const { top } = placements('<body data-standin-scroll-height="150"><p>a short mock</p></body>');
  withFrameClock((clock) => {
    top.loadSrcdoc();
    clock.frames();
    assert.ok(!top.style.height, 'a shrink waits out the settle delay, even a confirmed one');
    clock.elapse(5000);
    clock.frames();
  });
  assert.equal(top.style.height, `${150 + FRAME_EDGE}px`, 'a short mock that reports the same height twice fits it');

  // Forged, to take the two reports apart.
  const { document, context } = placements('<p>a mock</p>');
  context.loadSrcdoc();
  withFrameClock((clock) => {
    const report = (h) => { forgeStageHeight(document, context, h); clock.frames(); clock.elapse(5000); clock.frames(); };
    report(150);
    assert.ok(!context.style.height, 'one report under 320px moves nothing: a mock laid out from the viewport reports a sliver');
    report(40);
    assert.ok(!context.style.height, 'nor does a different one after it -- two reports have to MATCH');
    report(40);
    assert.equal(context.style.height, '120px', 'two matching slivers shrink it, but never under the 120px floor');
    report(150);
    assert.equal(context.style.height, `${150 + FRAME_EDGE}px`, 'growth needs no second report');
    report(60);
    assert.equal(context.style.height, `${150 + FRAME_EDGE}px`, 'and a lone smaller report under 320px still moves nothing');
  });
});

check('stage sizing: past 600px a stage folds -- 600px tall, scrolling inside, with the Show full height bar under the frame -- top-level and in a question\'s context alike (ablation: give the fold branch of applyStageHeight a null state and no bar shows)', () => {
  const { top, context } = placements('<body data-standin-scroll-height="4000"><p>a tall mock</p></body>');
  withFrameClock((clock) => {
    top.loadSrcdoc();
    context.loadSrcdoc();
    clock.frames();
  });
  for (const [where, frame] of [['top-level', top], ['context', context]]) {
    assert.equal(frame.style.height, '600px', `${where}: a stage taller than the cap stands at the cap`);
    assert.equal(blockOf(frame).classList.contains('stage-folded'), true, `${where}: and is marked folded`);
    assert.equal(barShown(frame), true, `${where}: the Show full height bar shows under the frame`);
    const siblings = barOf(frame).parentElement.children;
    assert.equal(siblings[siblings.indexOf(barOf(frame)) - 1], frame.parentElement, `${where}: the bar sits right under the stage's own frame`);
    assert.equal(toggleOf(frame).textContent, 'Show full height');
    assert.equal(toggleOf(frame).getAttribute('aria-expanded'), 'false');
    assert.equal(frame.hasAttribute('scrolling'), false, `${where}: nothing stops the folded mock scrolling inside its frame, either way`);
  }
});

check('stage sizing: Show full height opens a folded stage in place to a one-time snapshot of its height, capped at 30,000px, and Show less folds it back to 600px (ablation: drop the snapshot test at the top of applyStageHeight and a later report moves an opened stage)', () => {
  const { document, top, context } = placements('<body data-standin-scroll-height="4000"><p>a tall mock</p></body>');
  // Loaded with no clock installed, so it reports nothing of its own and the
  // forged claim further down is the only height it ever has.
  context.loadSrcdoc();
  withFrameClock((clock) => {
    top.loadSrcdoc();
    clock.frames();
    toggleOf(top).dispatchEvent(new StandInEvent('click'));
    assert.equal(top.style.height, `${4000 + FRAME_EDGE}px`, 'opened, the stage shows its whole reported height');
    assert.equal(blockOf(top).classList.contains('stage-opened'), true);
    assert.equal(blockOf(top).classList.contains('stage-folded'), false);
    assert.equal(barShown(top), true, 'the bar stays, to fold it back');
    assert.equal(toggleOf(top).textContent, 'Show less');
    assert.equal(toggleOf(top).getAttribute('aria-expanded'), 'true');

    // A mock sized in viewport units grows with its own frame: opened at 4002,
    // it reports more, and would again at whatever it was given next.
    forgeStageHeight(document, top, 12000);
    clock.frames();
    clock.elapse(5000);
    clock.frames();
    assert.equal(top.style.height, `${4000 + FRAME_EDGE}px`, 'an opened stage takes its height once, on open, and never follows its frame');

    toggleOf(top).dispatchEvent(new StandInEvent('click'));
    assert.equal(top.style.height, '600px', 'Show less folds it back to the cap');
    assert.equal(blockOf(top).classList.contains('stage-folded'), true);
    assert.equal(toggleOf(top).textContent, 'Show full height');

    // The cap on an open: the report is the stage's own claim.
    forgeStageHeight(document, context, 999999);
    clock.frames();
    toggleOf(context).dispatchEvent(new StandInEvent('click'));
    assert.equal(context.style.height, '30000px', 'an open never takes more than 30,000px, whatever the stage claims');
  });
});

// A folded stage as a browser lays it out: the 600px frame, and under it the
// bar the reader pressed, 6px down ('.stage-fold' margin-top) and 28px tall.
const FOLDED_BAR_BOTTOM = 600 + 6 + 28;

/** Where the board's bottom chrome stands in a window `innerHeight` tall: the
 * sticky send bar stuck to the window's bottom edge, the questions-left pill
 * floating over it, the round pager's dock fixed just above the edge. */
function bottomChromeTops(innerHeight) {
  return { sendBar: innerHeight - 77, pill: innerHeight - 123, dock: innerHeight - 70 };
}

/** Declares that chrome the way a browser would measure it. One the page is
 * not `showing` has no box, as 'display: none' leaves it; the pill sits inside
 * the send bar and has a box only while it also carries 'visible', the one
 * class that turns its display on. */
function declareBottomChrome(document, innerHeight, showing) {
  const tops = bottomChromeTops(innerHeight);
  const none = rectAt(0, 0);
  const pill = document.querySelector('.questions-left-pill');
  const pillBox = rectAt(tops.pill, 34);
  const withSendBar = showing.includes('send bar');
  document.querySelector('.send-bar').getBoundingClientRect = withSendBar ? rectAt(tops.sendBar, 77) : none;
  document.querySelector('.round-pager-dock').getBoundingClientRect = showing.includes('dock') ? rectAt(tops.dock, 54) : none;
  pill.getBoundingClientRect = () => (withSendBar && pill.classList.contains('visible') ? pillBox() : none());
  return tops;
}

/** Show less, pressed on an opened stage over a board 5000px down. The
 * stand-in lays nothing out, so where the frame's top stands once its box is
 * back at 600px, and where the bar and the bottom chrome stand with it, is
 * declared, the way a browser would measure it. `pill` is the questions-left
 * pill at the press: 'showing'; 'hidden by the rail', as the round's closing
 * rail on screen leaves it with a question still open; or 'none left', the
 * round's one question answered. `frameTop` may be a function of the page's
 * --head-clear. Returns the board scrolls the press asked for, with that
 * clearance and the frame top it declared. */
function pressShowLess({ innerHeight, frameTop: declared, showing = ['send bar', 'dock'], pill = 'showing' }) {
  const { document, top: frame } = placements('<body data-standin-scroll-height="4000"><p>a tall mock</p></body>');
  const clear = headClear(document);
  const frameTop = typeof declared === 'function' ? declared(clear) : declared;
  const pillEl = document.querySelector('.questions-left-pill');
  let scrolls;
  withFrameClock((clock) => {
    frame.loadSrcdoc();
    clock.frames();
    toggleOf(frame).dispatchEvent(new StandInEvent('click'));
    assert.equal(blockOf(frame).classList.contains('stage-opened'), true, 'setup failure: Show full height opens a 4000px mock');
    if (pill === 'none left') {
      document.querySelector('.round-open .question-block .choice-single').dispatchEvent(new StandInEvent('click'));
    }
    assert.equal(pillEl.classList.contains('visible'), pill !== 'none left',
      'setup failure: the pill shows exactly while the round has a question left');
    if (pill === 'hidden by the rail') pillEl.classList.remove('visible');
    const pillShown = pillEl.classList.contains('visible');
    frame.getBoundingClientRect = rectAt(frameTop, 600);
    toggleOf(frame).getBoundingClientRect = rectAt(frameTop + FOLDED_BAR_BOTTOM - 28, 28);
    declareBottomChrome(document, innerHeight, showing);
    scrolls = stubWindowScroll(document, 5000, innerHeight);

    toggleOf(frame).dispatchEvent(new StandInEvent('click'));
    clock.frames();

    assert.equal(frame.style.height, '600px', 'setup failure: Show less folds the stage back to the cap');
    assert.equal(toggleOf(frame).scrollIntoViewCallCount, 0,
      'the bar itself is never scrolled to, which is what left it at the window\'s top edge, under the header');
    assert.equal(pillEl.classList.contains('visible'), pillShown, 'measuring the pill leaves it shown or hidden as the page had it');
  });
  return { scrolls, clear, frameTop };
}

check('stage sizing: Show less keeps the folded stage in view: in a window that shows the folded frame and its bar together, a frame whose top the fold left above --head-clear (above the window, or under the sticky header) is brought down to it by one board scroll, rounded down, and a top already clear with its bar in sight leaves the board still (falsify: put the bar\'s scrollIntoView back in toggleStageFold; or drop the top test in keepFoldedStageInView and a clear stage moves)', () => {
  // A 900px window, the send bar, the pill and the dock all showing: the bar
  // under a frame standing at the clearance ends above all three.
  const rows = [
    { frameTop: -1450, board: clear => [[{ top: 5000 - 1450 - clear }]], what: 'above the window' },
    { frameTop: -606.3, board: clear => [[{ top: Math.floor(5000 - 606.3 - clear) }]], what: 'above the window, on a fraction of a pixel' },
    { frameTop: 40, board: clear => [[{ top: 5000 + 40 - clear }]], what: 'under the sticky header' },
    { frameTop: clear => clear, board: () => [], what: 'exactly at the clearance' },
    { frameTop: 120, board: () => [], what: 'below the header, its bar above the bottom chrome' },
  ];
  for (const row of rows) {
    const { scrolls, clear, frameTop } = pressShowLess({ innerHeight: 900, frameTop: row.frameTop });
    assert.ok(Math.max(frameTop, clear) + FOLDED_BAR_BOTTOM <= bottomChromeTops(900).pill,
      'setup failure: this window does not show the folded frame and its bar together');
    assert.deepEqual(scrolls, row.board(clear),
      `folded frame top ${frameTop}px down the window (${row.what}): the board moves only when the frame's top is above --head-clear (${clear}px), once, bringing that top down to it`);
  }
});

check('stage sizing: Show less keeps the bar the reader pressed in sight before the folded frame\'s top: in a window too short for both, one board scroll lands the bar\'s bottom on the top edge of the highest bottom chrome showing (the send bar, the questions-left pill, the pager dock; none: the window\'s bottom), rounded up, the frame\'s top left above --head-clear; the pill\'s place counts whenever the round has a question left, shown or not; a bar the chrome covers under a clear top comes up to that edge (falsify: drop the bar branch in keepFoldedStageInView and every row lands the frame\'s top at --head-clear or stays still; drop the pill\'s lift in boardFloor and the hidden-pill row lands the frame\'s top at --head-clear, its bar where the pill comes back; round the bar\'s landing down in scrollBoardSo and the fraction row leaves 0.6px of it under the dock)', () => {
  const rows = [
    { innerHeight: 813, frameTop: -1450, pill: 'showing', bar: tops => tops.pill, short: true,
      what: 'the pill showing: the bar stops above it' },
    { innerHeight: 813, frameTop: -1450, pill: 'hidden by the rail', bar: tops => tops.pill, short: true,
      what: 'the pill hidden at the press, a question still open: the move can bring it back, so its place is kept clear' },
    { innerHeight: 813, frameTop: -1450, pill: 'none left', frame: true,
      what: 'no question left, so no pill: the window shows both and the frame\'s top lands at the clearance' },
    { innerHeight: 700, frameTop: -1450, pill: 'none left', bar: tops => tops.sendBar, short: true,
      what: 'the send bar' },
    { innerHeight: 700, frameTop: -1450, showing: ['dock'], bar: tops => tops.dock, short: true,
      what: 'a sent round or an archive, no send bar: the pager dock' },
    { innerHeight: 700, frameTop: -1450.4, showing: ['dock'], bar: tops => tops.dock, short: true,
      what: 'on a fraction of a pixel: rounded up, so no fraction of the bar lands under the dock' },
    { innerHeight: 700, frameTop: -1450, showing: [], bar: () => 700, short: true,
      what: 'no bottom chrome showing: the window\'s own bottom edge' },
    { innerHeight: 700, frameTop: 700 - 70 - FOLDED_BAR_BOTTOM, showing: ['dock'], still: true,
      what: 'the bar already just above the dock, the frame\'s top above the clearance: nothing to gain' },
    { innerHeight: 700, frameTop: 200, pill: 'none left', bar: tops => tops.sendBar, short: true,
      what: 'a clear top with its bar under the send bar: the board moves up, the frame\'s top going under the header' },
    { innerHeight: 900, frameTop: 300, pill: 'showing', bar: tops => tops.pill,
      what: 'a clear top with its bar under the pill, in a window tall enough: the board moves up and both show' },
  ];
  for (const row of rows) {
    const tops = bottomChromeTops(row.innerHeight);
    const { scrolls, clear } = pressShowLess(row);
    const where = `a ${row.innerHeight}px window, folded frame top ${row.frameTop}px down it (${row.what})`;
    if (row.still) {
      assert.deepEqual(scrolls, [], `${where}: the board stays still`);
      continue;
    }
    if (row.frame) {
      assert.deepEqual(scrolls, [[{ top: 5000 + row.frameTop - clear }]], `${where}: one board scroll, the frame's top to --head-clear (${clear}px)`);
      continue;
    }
    const edge = row.bar(tops);
    // With the bar's bottom on that edge, the frame's top stands a frame and a
    // bar above it: over the clearance in a window too short for both.
    const landsAt = edge - FOLDED_BAR_BOTTOM;
    assert.equal(landsAt < clear, !!row.short,
      `setup failure: ${where} leaves the frame's top ${landsAt}px down, --head-clear ${clear}px`);
    assert.deepEqual(scrolls, [[{ top: Math.ceil(5000 + row.frameTop + FOLDED_BAR_BOTTOM - edge) }]],
      `${where}: one board scroll, the bar's bottom to ${edge}px down the window`);
  }
});

check('stage sizing: a stage the server rendered opened (it holds a comment) takes its first report past the cap as its opened box, and one that fits drops the mark and fits, top-level and in a question\'s context alike (ablation: drop the stage-opened branch at the top of applyStageHeight and the tall one folds at 600px)', () => {
  for (const [height, box, opened] of [[4000, `${4000 + FRAME_EDGE}px`, true], [450, `${450 + FRAME_EDGE}px`, false]]) {
    const html = `<body data-standin-scroll-height="${height}"><p>a mock</p></body>`;
    const board = createBoard({
      title: 'opened by a comment',
      blocks: [
        { kind: 'html', html },
        { kind: 'question', prompt: 'Which?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }], context: [{ kind: 'html', html }] },
      ],
    });
    applySubmit(board, {
      action: 'send',
      answers: [],
      comments: [board.blocks[0].id, board.blocks[1].context[0].id].map(blockId => ({ blockId, anchor: { kind: 'block' }, text: 'about this mock' })),
    }, 1);
    const document = loadBoard(renderBoardPage(board));
    const frames = [['top-level', document.querySelector('section.html-block .html-stage')], ['context', document.querySelector('.context-item.html-block .html-stage')]];
    for (const [where, frame] of frames) {
      assert.equal(blockOf(frame).classList.contains('stage-opened'), true, `setup failure: ${where}: a stage holding a comment renders opened`);
    }
    withFrameClock((clock) => {
      for (const [, frame] of frames) frame.loadSrcdoc();
      clock.frames();
    });
    for (const [where, frame] of frames) {
      assert.equal(frame.style.height, box, opened
        ? `${where}: a ${height}px mock opens to its whole height on its first report, never folding at the cap first`
        : `${where}: a ${height}px mock fits under the cap, so it takes its own height`);
      assert.equal(blockOf(frame).classList.contains('stage-opened'), opened, `${where}: the mark stays only on a stage that would fold`);
      assert.equal(blockOf(frame).classList.contains('stage-folded'), false, `${where}: and neither one is folded`);
      assert.equal(toggleOf(frame).textContent, opened ? 'Show less' : 'Show full height');
      assert.equal(barShown(frame), opened, `${where}: the bar stays to fold an opened stage and goes with the mark`);
    }
  }
});

check('stage sizing: a mock sized in viewport units settles at one height and never grows on its own (ablation: drop the fold branch\'s cap and the loop never stops)', () => {
  // A '100vh' section under a heading: every report is the frame it was
  // measured in plus the heading, so every box it is given makes it report a
  // taller one. Played out against the real handler for as long as it keeps
  // asking.
  const { document, top } = placements('<p>a mock</p>');
  top.loadSrcdoc();
  const heights = [];
  withFrameClock((clock) => {
    for (let i = 0; i < 60; i++) {
      const box = parseInt(top.style.height || '320', 10);
      forgeStageHeight(document, top, box - FRAME_EDGE + 40);
      clock.frames();
      clock.elapse(5000);
      clock.frames();
      heights.push(top.style.height);
    }
  });
  assert.equal(heights[heights.length - 1], '600px', 'it folds at the cap');
  assert.deepEqual(new Set(heights.slice(-30)), new Set(['600px']), 'and stays there, folded, however long it keeps asking');
  assert.equal(blockOf(top).classList.contains('stage-folded'), true);
});

check('stage sizing: reports are applied at most once an animation frame -- the latest wins (ablation: call applyStageHeight straight from handleStageHeight and the box moves on every report)', () => {
  const { document, top } = placements('<p>a mock</p>');
  top.loadSrcdoc();
  withFrameClock((clock) => {
    forgeStageHeight(document, top, 400);
    forgeStageHeight(document, top, 450);
    forgeStageHeight(document, top, 500);
    assert.ok(!top.style.height, 'three reports inside one frame move nothing until the frame');
    assert.equal(clock.booked, 1, 'and book one frame between them, not three');
    clock.frame();
    assert.equal(top.style.height, `${500 + FRAME_EDGE}px`, 'the frame applies the latest');
    assert.equal(clock.booked, 0);
  });
});

check('stage sizing: growth applies at once, a shrink only after it has settled, and the fold bar does not flicker around 600px (ablation 1: drop STAGE_FOLD_SLACK and a dip under the cap unfolds it; ablation 2: apply a shrink without the settle timer and the 400 report lands before the growth that cancels it)', () => {
  const { document, top } = placements('<p>a mock</p>');
  top.loadSrcdoc();
  withFrameClock((clock) => {
    const report = (h) => { forgeStageHeight(document, top, h); clock.frames(); };
    report(500);
    assert.equal(top.style.height, `${500 + FRAME_EDGE}px`, 'growth applies at once');
    report(400);
    assert.equal(top.style.height, `${500 + FRAME_EDGE}px`, 'a shrink waits');
    report(520);
    assert.equal(top.style.height, `${520 + FRAME_EDGE}px`, 'growth in the meantime applies at once');
    clock.elapse(5000);
    clock.frames();
    assert.equal(top.style.height, `${520 + FRAME_EDGE}px`, 'and the shrink it overtook never lands');

    // Breathing either side of the cap: folded on the way up at once, and never
    // unfolded by a dip that stays close to it.
    const shown = [];
    for (const h of [610, 590, 612, 585, 605, 588]) {
      report(h);
      clock.elapse(5000);
      clock.frames();
      shown.push(barShown(top));
      assert.equal(top.style.height, '600px', `a mock breathing around the cap stays folded at 600px (report ${h})`);
    }
    assert.deepEqual(shown, [true, true, true, true, true, true], 'the bar never drops out between frames');

    report(400);
    assert.equal(top.style.height, '600px', 'a real drop waits out the settle delay');
    clock.elapse(5000);
    clock.frames();
    assert.equal(top.style.height, `${400 + FRAME_EDGE}px`, 'then unfolds and fits');
    assert.equal(barShown(top), false);
  });
});

check('stage sizing: a stage measures its whole document -- margins collapsed through the body and a sideways scrollbar included -- so a fitted stage shows no stray inner scrollbar (ablation: measure document.body.scrollHeight alone again)', () => {
  const { top, context } = placements('<body data-standin-scroll-height="400"><h1>a heading with a margin</h1></body>');
  withFrameClock((clock) => {
    top.loadSrcdoc();
    context.loadSrcdoc();
    // What the stand-in cannot lay out, declared: the heading's top margin has
    // collapsed through the body, so the root's box is taller than the body's.
    const root = top.contentDocument.documentElement;
    root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 437.5, width: 800, height: 437.5 });
    // And a mock wider than its frame: the viewport's sideways scrollbar takes
    // 15px out of the frame's height.
    const wideRoot = context.contentDocument.documentElement;
    wideRoot.setAttribute('data-standin-client-height', '305');
    context.contentWindow.innerHeight = 320;
    clock.frames();
  });
  assert.equal(top.style.height, `${438 + FRAME_EDGE}px`, 'the root\'s box, rounded up -- a fraction of a pixel short is still a scrollbar');
  assert.equal(context.style.height, `${400 + 15 + FRAME_EDGE}px`, 'the sideways scrollbar is added, so the mock keeps it with no vertical one beside it');
});

check('stage sizing: a variant option clips at 600px and never folds (ablation: let applyStageHeight fold a .choice-variant stage and it carries .stage-folded)', () => {
  // It renders no Show full height bar at all (test/check-stage-lens.mjs, "Fold
  // bar"): a click on its card picks it.
  const document = loadBoard(renderBoardPage(variantsBoard(['<body data-standin-scroll-height="4000"><p>a tall option</p></body>'])));
  const frame = document.querySelector('.choice-variant .html-stage');
  withFrameClock((clock) => {
    frame.loadSrcdoc();
    clock.frames();
  });
  assert.equal(frame.style.height, '600px', 'a variant option keeps its 600px clip');
  assert.equal(blockOf(frame).classList.contains('stage-folded'), false, 'and never folds');
  assert.equal(blockOf(frame).classList.contains('stage-opened'), false, 'nor opens');
});

// =================================================================================
// Stage sizing, the review fixes (ADR.md entry 119): a stage the server rendered
// opened keeps the mark through a mid-build sliver, and a mock laid out at its
// own viewport's height counts a sideways scrollbar once, not twice.
// =================================================================================

/** One mock in the two places a stage stands outside a variant card, each holding
 * a stored comment, so the server renders both opened. */
function commentedPlacements(html) {
  const board = createBoard({
    title: 'opened by a comment',
    blocks: [
      { kind: 'html', html },
      { kind: 'question', prompt: 'Which?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }], context: [{ kind: 'html', html }] },
    ],
  });
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [board.blocks[0].id, board.blocks[1].context[0].id].map(blockId => ({ blockId, anchor: { kind: 'block' }, text: 'about this mock' })),
  }, 1);
  const document = loadBoard(renderBoardPage(board));
  return {
    document,
    frames: [['top-level', document.querySelector('section.html-block .html-stage')], ['context', document.querySelector('.context-item.html-block .html-stage')]],
  };
}

check('stage sizing: a stage the server rendered opened keeps the mark through a short first report, so a sliver measured mid-build never lets the real height fold it (ablation: drop the two-matching-reports condition on the opened branch of applyStageHeight and the 900px report folds at 600px)', () => {
  // Each sequence is the reports a stage sends, in order; the stage's own script
  // posts every new height twice, so a mock that really is short says so twice.
  const SEQUENCES = [
    { reports: [200, 900], box: `${900 + FRAME_EDGE}px`, opened: true, why: 'a sliver, then the real height past the cap: it opens to the real height' },
    { reports: [200, 450], box: '', opened: true, why: 'two short reports that disagree: still building, so nothing moves' },
    { reports: [200, 450, 450], box: `${450 + FRAME_EDGE}px`, opened: false, why: 'two matching short reports: it fits, and the mark goes' },
  ];
  for (const { reports, box, opened, why } of SEQUENCES) {
    const { document, frames } = commentedPlacements('<p>a mock</p>');
    for (const [where, frame] of frames) {
      assert.equal(blockOf(frame).classList.contains('stage-opened'), true, `setup failure: ${where}: a stage holding a comment renders opened`);
      // Loaded before the clock, so the stage reports nothing of its own and
      // every height below is one this check forged.
      frame.loadSrcdoc();
    }
    withFrameClock((clock) => {
      for (const [, frame] of frames) {
        for (const h of reports) {
          forgeStageHeight(document, frame, h);
          clock.frames();
        }
      }
      clock.elapse(5000);
      clock.frames();
    });
    for (const [where, frame] of frames) {
      const after = `${where}, reports ${reports.join(' then ')} (${why})`;
      assert.equal(frame.style.height || '', box, `${after}: box ('' is the 320px placeholder, no box written)`);
      assert.equal(blockOf(frame).classList.contains('stage-opened'), opened, `${after}: opened mark`);
      assert.equal(blockOf(frame).classList.contains('stage-folded'), false, `${after}: never folded`);
      assert.equal(barShown(frame), opened, `${after}: the bar shows exactly while the mark stays`);
    }
  }
});

/** Lays the stage's document out against whatever box the board last gave its
 * frame, as a browser would, for a mock wider than the frame: a 15px sideways
 * scrollbar that 'innerHeight' counts and the root's 'clientHeight' does not.
 * 'content' is the document's height for a given viewport height. */
function layOutWideStage(frame, content) {
  const BAR = 15;
  const win = frame.contentWindow;
  const root = frame.contentDocument.documentElement;
  const body = frame.contentDocument.body;
  const view = () => parseInt(frame.style.height || '320', 10) - FRAME_EDGE;
  const own = (el, prop, get) => Object.defineProperty(el, prop, { configurable: true, get });
  own(win, 'innerHeight', view);
  own(root, 'clientHeight', () => view() - BAR);
  own(root, 'scrollHeight', () => Math.max(content(view()), view() - BAR));
  own(body, 'scrollHeight', () => content(view()));
  root.getBoundingClientRect = () => ({ left: 0, top: 0, right: 2400, bottom: content(view()), width: 2400, height: content(view()) });
}

check('stage sizing: a wide mock counts its sideways scrollbar once -- one laid out at 100vh settles where it stands and never grows to the fold, one of fixed height settles at its content plus the bar (ablation: add the bar whatever the document\'s height, as before, and the 100vh mock grows 15px a report until it folds)', () => {
  const MOCKS = [
    // A 'min-height: 100vh' body: 100vh is innerHeight, sideways bar included,
    // so the document already fills the frame and the bar is inside it.
    { name: 'a 100vh mock', content: view => view, box: '', reports: [320 - FRAME_EDGE] },
    // Content of its own height: the bar takes 15px under it, so the frame
    // needs both to show it with no vertical scrollbar.
    { name: 'a 400px mock', content: () => 400, box: `${400 + 15 + FRAME_EDGE}px`, reports: [415] },
  ];
  for (const { name, content, box, reports } of MOCKS) {
    const { document, top } = placements('<p>a wide mock</p>');
    const seen = [];
    document.defaultView.addEventListener('message', (ev) => {
      if (ev.source === top.contentWindow && ev.data && ev.data.type === 'height') seen.push(ev.data.height);
    });
    withFrameClock((clock) => {
      top.loadSrcdoc();
      layOutWideStage(top, content);
      for (let i = 0; i < 5; i++) {
        clock.frames();
        clock.elapse(5000);
      }
      clock.frames();
    });
    assert.equal(top.style.height || '', box, `${name}: box after every report it sends ('' is the 320px placeholder, no box written)`);
    assert.deepEqual([...new Set(seen)], reports, `${name}: the heights it reports, the bar counted once`);
    assert.equal(blockOf(top).classList.contains('stage-folded'), false, `${name}: never folded`);
    assert.equal(barShown(top), false, `${name}: no Show full height`);
  }
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
  // computed through the cascade in test/check-stage-lens.mjs. What this DOES prove is
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
 * and a page board carries no Pull-out to open the lens with. */
function openLensOn(mockHtml) {
  const board = createBoard({
    title: 'isolation: the stage lens',
    blocks: [{ kind: 'html', html: mockHtml }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  const inline = document.querySelector('.html-stage');
  document.querySelector('.html-block .pull-out').dispatchEvent(new StandInEvent('click'));
  return { board, blockId: board.blocks[0].id, document, inline, lens: document.querySelector('.stage-lens-frame') };
}

check('S1: the lens frame is sandboxed identically to the inline stage -- same attribute, and still no allow-same-origin', () => {
  const { inline, lens } = openLensOn('<div class="mock"><button>Send</button></div>');
  assert.ok(lens, 'setup failure: the Pull-out did not mount a lens frame');
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
    // Two blocks, so this is an ordinary board with a Pull-out -- see
    // openLensOn above.
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
  });
  const document = loadBoard(renderBoardPage(board));
  document.querySelector('.html-stage').removeAttribute('sandbox');
  document.querySelector('.html-block .pull-out').dispatchEvent(new StandInEvent('click'));
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
  // dropped it (not a .html-stage), and the one 'mode' message the copy is sent
  // says comment mode is off (the next check), so the agent's own
  // `if (!commentMode) return` gate keeps it silent. Two independent reasons the
  // same click is inert, which is the point: the mount is a viewer.
  lens.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), false, 'a click inside the lens copy must not mint an anchor');

  // ... while the same click in the inline stage still does.
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'setup failure: the inline stage\'s own gesture must be unaffected');
});

check('S1: the lens copy is sent the board\'s theme and nothing else -- one mode message when it loads, comment mode off and no sent refs, while the block\'s own stage is told comment mode is on and which element is sent; a theme change sends the open copy the same shape again, and a closed lens\'s copy nothing (falsify: build the lens post from commentMode and sentDomRefsForBlock, as handleStageReady does)', () => {
  // The mock keeps everything its window is sent, which is all a real mock could
  // observe of the parent: the stand-in delivers a parent post to the stage
  // window's own 'message' listeners.
  const HEARS = '<script>window.__heard = []; window.addEventListener("message", function (e) { window.__heard.push(e.data); });</script>';
  const board = createBoard({
    title: 'isolation: what the lens copy is sent',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' + HEARS }, { kind: 'markdown', text: 'not a page board' }],
  });
  const blockId = board.blocks[0].id;

  // A sent comment on the mock's button, so the block's own stage has a sent ref
  // to be told: learn the ref from a real in-stage click, then send it.
  const probeDoc = loadBoard(renderBoardPage(board));
  enableCommentMode(probeDoc);
  const probeFrame = probeDoc.querySelector('.html-stage');
  probeFrame.loadSrcdoc();
  probeFrame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  const ref = probeDoc.getElementById('comment-form-' + blockId).getAttribute('data-anchor-ref');
  assert.ok(ref, 'setup failure: no ref minted by a real in-stage click');
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [{ blockId, anchor: { kind: 'dom', ref, hint: 'Send' }, text: 'already sent' }],
  }, 1);

  const document = loadBoard(renderBoardPage(board), { theme: true, finish: true });
  document.querySelector('.html-block .pull-out').dispatchEvent(new StandInEvent('click'));
  enableCommentMode(document);
  const inline = document.querySelector('.html-stage');
  const lens = document.querySelector('.stage-lens-frame');
  assert.ok(lens, 'setup failure: the Pull-out did not mount a lens frame');
  inline.loadSrcdoc();
  lens.loadSrcdoc();
  const told = theme => ({ cb: 'cb-stage', type: 'mode', commentMode: false, sentRefs: [], theme });

  // The control: the same board state reaches the block's own stage as comment
  // mode on and one sent ref, so a lens post built the same way would carry both.
  assert.deepEqual(inline.contentWindow.__heard.filter(m => m && m.type === 'mode'),
    [{ cb: 'cb-stage', type: 'mode', commentMode: true, sentRefs: [ref], sentTimes: [], theme: 'dark' }],
    'setup failure: the block\'s own stage must be told comment mode is on and which element is sent');
  const heard = lens.contentWindow.__heard;
  assert.deepEqual(heard, [told('dark')],
    'the lens copy must be sent exactly one message when it loads: the theme, with comment mode off and no sent refs');

  clickThemeToggle(document); // System -> Light, with the lens open
  assert.deepEqual(heard, [told('dark'), told('light')],
    'a theme change must send the open copy one more message of the same shape, and nothing besides');

  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), false, 'setup failure: the lens did not close');
  clickThemeToggle(document); // Light -> Dark, with the lens closed
  assert.equal(heard.length, 2, 'a closed lens\'s copy must be sent nothing');
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

function pullOutOn(section) {
  const btn = section.querySelector('.pull-out');
  assert.ok(btn, 'setup failure: no Pull-out on that stage');
  btn.dispatchEvent(new StandInEvent('click'));
  return btn;
}

function lensPick(document) { return document.querySelector('.stage-lens .lens-pick'); }

check('Activating the Pull-out on a variant option opens the lens and does not select that option', () => {
  // INHERITED, not newly built: the card's own click handler already stands
  // down for a click landing on any nested <button> ("a click landing on
  // interactive chrome nested inside this option's OWN rendered block keeps its
  // own meaning", src/ui.mjs), and the Pull-out is a <button>. It still
  // needs its own check, because nothing else in the suite would notice if that
  // exclusion list lost 'button' -- the comment button beside it would silently
  // start recording picks too. Ablation: drop 'button, ' from that closest(...)
  // list and this fails.
  const board = pickBoard();
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');
  pullOutOn(cards[0]);

  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'setup failure: the Pull-out did not open the lens');
  assert.equal(cards[0].classList.contains('selected'), false,
    'opening a variant option in the lens must not pick it -- looking at a mock full size is not choosing it');
  assert.equal(cards[1].classList.contains('selected'), false, 'and must not pick any other option either');
});

check('A lens opened from a variant option carries a pick control naming that option; one opened from a standalone stage carries none', () => {
  const board = pickBoard();
  const standaloneId = board.blocks[1].id;
  const document = loadBoard(renderBoardPage(board));
  const cards = document.querySelectorAll('.choice-variant');

  pullOutOn(cards[1]);
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
  pullOutOn(standalone);
  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'setup failure: the standalone lens did not open');
  assert.equal(lensPick(document), null,
    'a lens opened from a standalone stage must carry no pick control -- there is no option to pick');
});

check('The pick control is page chrome in the PARENT document, outside the framed stage, and the stage has no way to cover it', () => {
  const board = pickBoard();
  const document = loadBoard(renderBoardPage(board));
  pullOutOn(document.querySelectorAll('.choice-variant')[0]);
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
  pullOutOn(document.querySelector('.choice-variant'));
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
  pullOutOn(cards[0]);
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

check('Every html-stage srcdoc -- a standalone stage, each variant option\'s, a compare side\'s -- opens with the exact STAGE_MARGIN_RESET renderHtmlBlock exports, immediately followed by that stage\'s own markup', () => {
  // One builder, three call sites (renderBlock, the variant option card,
  // renderCompareSide all go through renderHtmlBlock): a surface that grew a
  // second srcdoc builder without the reset fails its own row here.
  const surfaces = [
    {
      name: 'standalone stage',
      selector: '.html-stage',
      mocks: ['<div class="mock"><button>Send</button></div>'],
      board: createBoard({
        title: 'gutter: standalone stage',
        blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }, { kind: 'markdown', text: 'not a page board' }],
      }),
    },
    {
      name: 'variant option stage',
      selector: '.choice-variant .html-stage',
      mocks: ['<div class="mock">A</div>', '<div class="mock">B</div>'],
      board: createBoard({
        title: 'gutter: variant option stage',
        blocks: [{
          kind: 'question', prompt: 'Which mockup?', widget: 'choose-between-rendered-variants',
          options: [
            { label: 'A', block: { kind: 'html', html: '<div class="mock">A</div>' } },
            { label: 'B', block: { kind: 'html', html: '<div class="mock">B</div>' } },
          ],
        }],
      }),
    },
    {
      name: 'compare side stage',
      selector: '.compare-side .html-stage',
      mocks: ['<div class="mock">new</div>'],
      board: createBoard({
        title: 'gutter: compare side stage',
        blocks: [{
          kind: 'compare',
          left: { label: 'Old', block: { kind: 'markdown', markdown: 'old copy' } },
          right: { label: 'New', block: { kind: 'html', html: '<div class="mock">new</div>' } },
        }],
      }),
    },
  ];
  for (const { name, selector, mocks, board } of surfaces) {
    const frames = loadBoard(renderBoardPage(board)).querySelectorAll(selector);
    assert.equal(frames.length, mocks.length, `setup failure: expected one ${name} per html block, got ${frames.length}`);
    frames.forEach((frame, i) => {
      const srcdoc = frame.getAttribute('srcdoc');
      assert.ok(srcdoc, `setup failure: no srcdoc on the ${name}`);
      assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0,
        `${name}: the srcdoc must open with the exact exported STAGE_MARGIN_RESET string, not a hand-copied re-spelling of it`);
      assert.equal(srcdoc.indexOf(mocks[i]), STAGE_MARGIN_RESET.length,
        `${name}: its own markup must immediately follow the reset, with nothing else between them`);
    });
  }
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

check('the thirteen live types are exactly ready/hover/click/link/positions/height/scroll/mermaid/scrollBy/mode/locate/band/diagrams', () => {
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
  //
  // 'link' is the newest, and it is stage-to-parent only: a link the reviewer
  // clicked inside the frame, handed over because the frame itself can neither
  // navigate (the page CSP refuses it) nor open a tab (no 'allow-popups').
  // There is deliberately no answer type -- what the board does with an
  // address is the board's decision, and the stage is never told (ADR 113).
  // An in-page anchor the frame cannot scroll to itself rides the same type
  // ('top' in place of 'url'), so the board scrolling to it added no type.
  const live = liveMessageTypes(renderSrcText, uiSrcText);
  assert.deepEqual([...live].sort(),
    ['band', 'click', 'diagrams', 'height', 'hover', 'link', 'locate', 'mermaid', 'mode', 'positions', 'ready', 'scroll', 'scrollBy'].sort());
  // The deleted 'select' type (ADR.md entry 78) is absent from the live set
  // above, and PROTOCOL.md must not grow a table row for it either: the
  // "There is no `select` message" passage names it only in prose, and a row
  // would document a channel deleted for security as live. The check above
  // only ever compares live against documented, never the reverse.
  assert.ok(!documentedMessageTypes(protocolText).has('select'),
    'PROTOCOL.md must not document the deleted \'select\' type as a live message');
});

// =================================================================================
// 5. Links inside a stage (ADR 113).
//
// A stage is a `srcdoc` frame, so a relative href in it -- an in-page `#anchor`
// included -- resolves against the BOARD's own address and a click's default
// action is a frame navigation the page CSP refuses (Chrome's blocked page).
// The stage script owns the click instead: an anchor scrolls inside the frame
// when the frame has somewhere to scroll, and otherwise (a stage that fits its
// content, or one opened by Show full height, ADR 119) the board scrolls to it;
// an http/https address is posted to the board, and the board opens it in a new
// tab at once.
//
// The stand-in has no layout, so each fixture declares the geometry a browser
// would measure: the stage's own viewport (its root's scroll and client
// height), where the frame sits in the board's window, and where the target
// sits in the frame.
// =================================================================================

const ANCHOR_MOCK = '<nav><a id="toc" href="#s2"><span id="inner">Section two</span></a>'
  + ' <a id="dead" href="#nowhere">nowhere</a></nav>'
  + '<section id="s1">one</section><section id="s2">two</section>';

/** A board carrying one html stage. With `pageBoard` false a second, markdown
 * block rides along, which is what makes the board an ordinary in-column one
 * (QUIRKS.md: a board holding one html block and nothing else IS a page
 * board) -- criterion 1 names both surfaces, and this is the whole difference
 * between them here. */
function linkBoard(mock, pageBoard) {
  const blocks = [{ kind: 'html', html: mock }];
  if (!pageBoard) blocks.push({ kind: 'markdown', text: 'not a page board' });
  return createBoard({ title: 'stage links', blocks });
}

function mountStage(board) {
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  return { document, frame };
}

/** Every tab the board page opened, in order, as the argument lists it passed.
 * The board's whole outbound path is one `window.open` call now (ADR.md entry
 * 113): nothing is shown or confirmed first, so there is nothing in the
 * document left to read the outcome off, and a stub on the window the page
 * script was handed is what the checks below assert against. Returns null, as
 * a real `noopener` open does. */
function stubWindowOpen(document) {
  const opens = [];
  document.defaultView.open = (...args) => { opens.push(args); return null; };
  return opens;
}

/** The stage's own viewport, as a browser would measure it: how tall its
 * document is, and how much of it the frame shows. Set on the stage's root
 * after load, since the stand-in drops an explicit '<html>' inside a srcdoc. */
function declareStageViewport(frame, scrollHeight, clientHeight) {
  const root = frame.contentDocument.documentElement;
  root.setAttribute('data-standin-scroll-height', String(scrollHeight));
  root.setAttribute('data-standin-client-height', String(clientHeight));
}

function rectAt(top, height) {
  return () => ({ left: 0, top, right: 800, bottom: top + height, width: 800, height });
}

/** Every window scroll the board page asked for, as argument lists, from a
 * board already scrolled `pageYOffset` down in a window `innerHeight` tall. */
function stubWindowScroll(document, pageYOffset, innerHeight = 900) {
  const win = document.defaultView;
  const scrolls = [];
  win.pageYOffset = pageYOffset;
  win.innerHeight = innerHeight;
  win.scrollTo = (...args) => { scrolls.push(args); };
  return scrolls;
}

/** The board's own clearance under its sticky header, read off the stylesheet:
 * the same token every other scroll-to on the page lands by. */
function headClear(document) {
  return parseFloat(resolveComputedProperty(styles, document.documentElement, true, '--head-clear'));
}

/** A stage holding ANCHOR_MOCK in a document `height` tall, mounted on an
 * ordinary board, its real script reporting that height under the frame clock
 * so the board fits or folds it exactly as it would live. */
function mountReportingStage(height) {
  const board = linkBoard(`<body data-standin-scroll-height="${height}">${ANCHOR_MOCK}</body>`, false);
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  withFrameClock((clock) => {
    frame.loadSrcdoc();
    clock.frames();
  });
  return { board, document, frame, stageDoc: frame.contentDocument };
}

check('criterion 1: an in-page anchor inside a stage that scrolls inside -- a page board, a folded stage -- scrolls the FRAME\'s own scrolling box, below the board\'s own header band, never through scrollIntoView, leaves the board\'s window still, and never navigates (falsify: put scrollIntoView back in scrollToAnchor)', () => {
  for (const pageBoard of [true, false]) {
    const where = pageBoard ? 'page board' : 'folded in-column stage';
    let board, document, frame;
    if (pageBoard) {
      board = linkBoard(ANCHOR_MOCK, true);
      ({ document, frame } = mountStage(board));
      declareStageViewport(frame, 4000, 900);
    } else {
      ({ board, document, frame } = mountReportingStage(4000));
      assert.equal(blockOf(frame).classList.contains('stage-folded'), true, 'setup failure: a 4000px mock folds');
      declareStageViewport(frame, 4000, 600 - FRAME_EDGE);
    }
    const opens = stubWindowOpen(document);
    const scrolls = stubWindowScroll(document, 1000);
    const stageDoc = frame.contentDocument;
    const target = stageDoc.getElementById('s2');
    // The frame's own scrolling box (the stand-in has no 'scrollingElement',
    // so the root, as a browser's standards-mode document has), already 200px
    // down, and every scroll asked of it. The target sits 700px down the
    // frame's viewport.
    const root = stageDoc.documentElement;
    root.scrollTop = 200;
    const frameScrolls = [];
    root.scrollTo = (...args) => { frameScrolls.push(args); };
    target.getBoundingClientRect = rectAt(700, 18);

    // What the board tells the stage its own floating chrome covers, the same
    // 'band' message ADR 59 already sends on every refresh. Posted directly
    // rather than measured off a rendered header because this stand-in has no
    // layout at all (QUIRKS.md) -- what this check is about is the stage
    // landing the target below WHATEVER figure the parent reported, which is
    // the same figure its own body padding clears.
    frame.contentWindow.postMessage({ cb: 'cb-stage', type: 'band', top: 64, bottom: 40 });

    // The click lands on a <span> INSIDE the link, exactly as a real one does
    // on a styled table-of-contents entry: the handler has to find the <a> the
    // browser's own default action would have followed, not just ev.target.
    const ev = new StandInEvent('click');
    stageDoc.getElementById('inner').dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, true,
      `${where}: the click must be cancelled -- an uncancelled one navigates this frame to the board's own address plus the fragment, which the page CSP refuses (the blocked page this whole feature exists to remove)`);
    assert.deepEqual(frameScrolls, [[{ top: 200 + 700 - 64, behavior: 'smooth' }]],
      `${where}: the frame's own box scrolls once, landing the target BELOW the board's header band by the figure the parent reported, never one invented in the stage`);
    assert.equal(target.scrollIntoViewCallCount, 0,
      `${where}: never scrollIntoView -- Chrome carries a frame's scroll-into-view on into the board, a second scroll that leaves the target under the header`);
    assert.deepEqual(scrolls, [], `${where}: a frame that scrolls to its own target leaves the board's window where it was`);

    // A fragment naming nothing scrolls nothing, and still never navigates.
    const dead = new StandInEvent('click');
    stageDoc.getElementById('dead').dispatchEvent(dead);
    assert.equal(dead.defaultPrevented, true, `${where}: a fragment naming nothing must still be cancelled`);
    assert.equal(frameScrolls.length, 1, `${where}: a fragment naming nothing must scroll nothing`);

    // While comment mode is on the same click mints a comment anchor as it
    // always did, and neither scrolls nor opens anything. Asserted on the
    // in-column fixture alone: on a page board comment mode is additionally
    // gated on the round still being awaited (pageRoundCommentsAllowed,
    // src/ui.mjs), which is a different rule with checks of its own -- a stage
    // told mode is off is a stage where a link click legitimately scrolls.
    if (pageBoard) continue;
    enableCommentMode(document);
    const inMode = new StandInEvent('click');
    stageDoc.getElementById('inner').dispatchEvent(inMode);
    const form = document.getElementById('comment-form-' + board.blocks[0].id);
    assert.equal(inMode.defaultPrevented, true, `${where}: comment mode must not let a link navigate either`);
    assert.equal(frameScrolls.length, 1, `${where}: a click in comment mode must not scroll the stage`);
    assert.deepEqual(opens, [], `${where}: a click in comment mode must open nothing`);
    assert.ok(form && form.classList.contains('open'), `${where}: a click in comment mode must mint a comment anchor, exactly as it does today`);
  }
});

check('AC 14: an in-page anchor inside a stage that fits its content scrolls the BOARD\'s window to the target, under the header, and the frame -- with nothing to scroll -- does not try (ablation: make frameScrollBoxes always hold the root and the window stays still)', () => {
  const { document, frame, stageDoc } = mountReportingStage(450);
  assert.equal(frame.style.height, `${450 + FRAME_EDGE}px`, 'setup failure: a 450px mock fits');
  assert.equal(blockOf(frame).classList.contains('stage-folded') || blockOf(frame).classList.contains('stage-opened'), false,
    'setup failure: a fitted stage carries no fold state');
  declareStageViewport(frame, 450, 450);
  frame.getBoundingClientRect = rectAt(300, 450 + FRAME_EDGE);
  const target = stageDoc.getElementById('s2');
  target.getBoundingClientRect = rectAt(380, 18);
  const scrolls = stubWindowScroll(document, 1000);

  const ev = new StandInEvent('click');
  stageDoc.getElementById('inner').dispatchEvent(ev);

  assert.equal(ev.defaultPrevented, true, 'the click must still never navigate the frame');
  assert.deepEqual(scrolls, [[{ top: 1000 + 300 + 380 - headClear(document), behavior: 'smooth' }]],
    'the board scrolls once, putting the target (380px down a frame 300px down the window, on a board already 1000px down) right under the header');
  assert.equal(target.scrollIntoViewCallCount, 0, 'a frame with nothing to scroll leaves the move to the board');
});

check('AC 14: an in-page anchor inside a stage opened by Show full height scrolls the BOARD\'s window to the target, under the header (falsify: return early from handleStageAnchor in src/ui.mjs and this goes red)', () => {
  const { document, frame, stageDoc } = mountReportingStage(4000);
  assert.equal(blockOf(frame).classList.contains('stage-folded'), true, 'setup failure: a 4000px mock folds');
  toggleOf(frame).dispatchEvent(new StandInEvent('click'));
  assert.equal(blockOf(frame).classList.contains('stage-opened'), true, 'setup failure: Show full height opens it');
  assert.equal(frame.style.height, `${4000 + FRAME_EDGE}px`, 'setup failure: opened to its whole height');
  declareStageViewport(frame, 4000, 4000);
  frame.getBoundingClientRect = rectAt(200, 4000 + FRAME_EDGE);
  const target = stageDoc.getElementById('s2');
  target.getBoundingClientRect = rectAt(2500, 18);
  const scrolls = stubWindowScroll(document, 1000);

  stageDoc.getElementById('inner').dispatchEvent(new StandInEvent('click'));

  assert.deepEqual(scrolls, [[{ top: 1000 + 200 + 2500 - headClear(document), behavior: 'smooth' }]],
    'an opened stage shows its whole document, so the board scrolls to the target, 2500px down the frame');
  assert.equal(target.scrollIntoViewCallCount, 0, 'and the opened frame, with nothing left to scroll, does not try');
});

check('AC 14: the board scrolls for an in-page anchor only on a well-formed message from a genuine stage, never for a page board\'s, and only ever to a point inside the frame\'s own box', () => {
  const { document, frame } = mountStage(linkBoard(ANCHOR_MOCK, false));
  frame.getBoundingClientRect = rectAt(300, 452);
  const scrolls = stubWindowScroll(document, 1000);
  const clear = headClear(document);
  const send = (data, origin = 'null', source = frame.contentWindow) => document.defaultView.dispatchEvent({
    type: 'message', data: Object.assign({ cb: 'cb-stage', type: 'link' }, data), origin, source,
  });

  // Not a genuine stage: the same two gates every type on this channel passes.
  send({ top: 100 }, 'https://evil.example');
  send({ top: 100 }, 'null', {});
  assert.deepEqual(scrolls, [], 'an anchor message from anything but a live stage frame moves nothing');

  // A genuine stage, malformed 'top'.
  for (const data of [{}, { top: NaN }, { top: Infinity }, { top: -Infinity }, { top: '100' }, { top: null },
    { top: [100] }, { top: { valueOf: () => 100 } }]) {
    send(data);
    assert.deepEqual(scrolls, [], `a malformed anchor message moves nothing: ${JSON.stringify(data)}`);
  }

  // A forged position past either edge lands on that edge of the frame's own
  // box: a stage can bring a point inside itself to the top, nothing else.
  send({ top: 999999 });
  send({ top: -5000 });
  assert.deepEqual(scrolls, [
    [{ top: 1000 + 300 + 452 - clear, behavior: 'smooth' }],
    [{ top: 1000 + 300 - clear, behavior: 'smooth' }],
  ], 'a position past the frame is clamped to the frame\'s own box');

  // A page board's stage fills the window and the page under it does not
  // scroll: nothing it sends moves the board.
  const page = mountStage(linkBoard(ANCHOR_MOCK, true));
  page.frame.getBoundingClientRect = rectAt(0, 900);
  const pageScrolls = stubWindowScroll(page.document, 0);
  page.document.defaultView.dispatchEvent({
    type: 'message', data: { cb: 'cb-stage', type: 'link', top: 400 }, origin: 'null', source: page.frame.contentWindow,
  });
  assert.deepEqual(pageScrolls, [], 'a page board\'s stage never scrolls the board');
});

// --- 5b. A folded stage whose target lands hidden ----------------------------
//
// Off a page board no band reaches a stage, so a frame that scrolls to its own
// target lands it at the frame's own top. When the reader has scrolled that top
// above the window, or under the header, the target would land hidden; the
// board then moves just far enough to bring it down to --head-clear. A target
// near the document's end stops lower, where the frame's scroll runs out, and
// in a frame that reaches past the window's bottom edge that can be off screen
// too; the board then brings it up to --head-clear. A target landing between
// --head-clear and the same clearance above the window's bottom leaves the
// board still.

check('AC 14: a link in a folded stage scrolls the frame toward the target, then the board once, bringing a target that landed above --head-clear or within --head-clear of the window\'s bottom (or past it) to --head-clear under the window top; a target landing between the two leaves the board still (falsify: drop either edge of the band in handleStageAnchor)', () => {
  // A 900px window over a board already 1000px down. The frame shows 598px of a
  // 4000px document from 200px down, so its own scroll stops at 4000 - 598.
  const frameMax = 4000 - (600 - FRAME_EDGE);
  // A target 3500px down the viewport would need the frame at 3700: it stops at
  // its end and the target sits this far down the frame.
  const nearEnd = 3500 - (frameMax - 200);
  const rows = [
    { frameTop: -120, board: clear => [[{ top: 1000 - 120 - clear, behavior: 'smooth' }]], what: 'above the window' },
    { frameTop: 40, board: clear => [[{ top: 1000 + 40 - clear, behavior: 'smooth' }]], what: 'under the header' },
    { frameTop: clear => clear, board: () => [], what: 'exactly at the clearance' },
    { frameTop: 150, board: () => [], what: 'well below the header' },
    { frameTop: 700, targetAt: 3500, board: clear => [[{ top: 1000 + 700 + nearEnd - clear, behavior: 'smooth' }]],
      what: 'a target near the end, landing past the window\'s bottom edge' },
    { frameTop: 560, targetAt: 3500, board: clear => [[{ top: 1000 + 560 + nearEnd - clear, behavior: 'smooth' }]],
      what: 'a target near the end, landing in the window\'s last --head-clear px' },
    { frameTop: clear => 900 - clear - nearEnd, targetAt: 3500, board: () => [],
      what: 'a target near the end, landing exactly --head-clear above the window\'s bottom' },
    { frameTop: 150, targetAt: 3500, board: () => [], what: 'a target near the end, landing inside the window' },
  ];
  for (const row of rows) {
    const { document, frame, stageDoc } = mountReportingStage(4000);
    assert.equal(blockOf(frame).classList.contains('stage-folded'), true, 'setup failure: a 4000px mock folds');
    const clear = headClear(document);
    const frameTop = typeof row.frameTop === 'function' ? row.frameTop(clear) : row.frameTop;
    const targetAt = row.targetAt ?? 700;
    const where = `frame top ${frameTop}px down the window, target ${targetAt}px down the frame (${row.what})`;
    declareStageViewport(frame, 4000, 600 - FRAME_EDGE);
    frame.getBoundingClientRect = rectAt(frameTop, 600);
    // The frame's own viewport, 200px down, and the target `targetAt` down it.
    const root = stageDoc.documentElement;
    root.scrollTop = 200;
    const frameScrolls = [];
    root.scrollTo = (...args) => { frameScrolls.push(args); };
    stageDoc.getElementById('s2').getBoundingClientRect = rectAt(targetAt, 18);
    const scrolls = stubWindowScroll(document, 1000, 900);

    stageDoc.getElementById('inner').dispatchEvent(new StandInEvent('click'));

    assert.deepEqual(frameScrolls, [[{ top: Math.min(200 + targetAt, frameMax), behavior: 'smooth' }]],
      `${where}: the frame brings the target toward its own top as far as it scrolls, once (no band off a page board)`);
    assert.deepEqual(scrolls, row.board(clear),
      `${where}: the board moves only when the target landed above --head-clear (${clear}px) or below 900 - ${clear}px`);
  }
});

check('AC 14: a stage\'s already-scrolled anchor message moves the board only to a point inside the frame\'s own box, only when "scrolled" is exactly true, and never on a page board', () => {
  const { document, frame } = mountStage(linkBoard(ANCHOR_MOCK, false));
  frame.getBoundingClientRect = rectAt(-120, 600);
  const scrolls = stubWindowScroll(document, 1000);
  const clear = headClear(document);
  const send = (doc, source, data) => doc.defaultView.dispatchEvent({
    type: 'message', data: Object.assign({ cb: 'cb-stage', type: 'link' }, data), origin: 'null', source,
  });

  for (const scrolled of ['true', 1, null, {}, [true], false]) {
    send(document, frame.contentWindow, { top: 0, scrolled });
    assert.deepEqual(scrolls, [], `a malformed "scrolled" moves nothing: ${JSON.stringify(scrolled)}`);
  }

  // Past the top edge: clamped to the frame's top, 120px above the window.
  send(document, frame.contentWindow, { top: -5000, scrolled: true });
  // Past the bottom edge: clamped to the frame's bottom, 480px down a 900px
  // window and so already inside its visible band.
  send(document, frame.contentWindow, { top: 999999, scrolled: true });
  assert.deepEqual(scrolls, [[{ top: 1000 - 120 - clear, behavior: 'smooth' }]],
    'a position past the frame lands on that edge of the frame\'s own box, and a clear one moves nothing');

  const page = mountStage(linkBoard(ANCHOR_MOCK, true));
  page.frame.getBoundingClientRect = rectAt(0, 900);
  const pageScrolls = stubWindowScroll(page.document, 0);
  send(page.document, page.frame.contentWindow, { top: 0, scrolled: true });
  assert.deepEqual(pageScrolls, [], 'a page board\'s stage, whose top sits at the window top, never scrolls the board');
});

const OUTBOUND_MOCK ='<a id="out" href="https://example.com/a?x=1">out</a>'
  + '<a id="out2" href="http://example.org/second">second</a>'
  + '<a id="js" href="javascript:alert(1)">js</a>'
  + '<a id="file" href="file:///etc/passwd">file</a>'
  + '<a id="data" href="data:text/plain,hi">data</a>'
  + '<a id="rel" href="/b/another-board">relative</a>';

check('criterion 2: an http/https link opens a new tab with no opener at once, and every other scheme opens and navigates nothing', () => {
  const { document, frame } = mountStage(linkBoard(OUTBOUND_MOCK, false));
  const stageDoc = frame.contentDocument;
  const opens = stubWindowOpen(document);
  const chromeBefore = document.body.children.length;

  // Every other scheme: nothing opened, nothing navigated.
  for (const id of ['js', 'file', 'data', 'rel']) {
    const ev = new StandInEvent('click');
    stageDoc.getElementById(id).dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, `a ${id}: link must not navigate the frame either`);
    assert.deepEqual(opens, [], `a ${id}: link must open nothing at all`);
  }

  // An http/https one: one tab, the whole address, no opener, and no board
  // chrome in between (ADR.md entry 113 -- the address is not shown or
  // confirmed first, so a reviewer's click is a click, not two).
  const ev = new StandInEvent('click');
  stageDoc.getElementById('out').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'the frame itself must never navigate -- the board opens the tab, or nothing does');
  assert.equal(opens.length, 1, 'an http/https link must open exactly one tab, on the click that asked for it');
  assert.equal(opens[0][0], 'https://example.com/a?x=1', 'the tab goes to the address the link carried, whole');
  assert.equal(opens[0][1], '_blank', 'a new tab, never the board page itself');
  assert.ok(/\bnoopener\b/.test(String(opens[0][2] || '')),
    'the open must carry noopener -- the opened page must not reach back through window.opener into a board holding every answer on it');
  assert.equal(document.body.children.length, chromeBefore,
    'the board page stays as it was: no address panel to read, nothing to dismiss');

  // A second link opens at once too. The confirmation this feature used to
  // carry made a second click ignorable while the first was still up; with no
  // confirmation there is nothing to answer and nothing to queue behind.
  stageDoc.getElementById('out2').dispatchEvent(new StandInEvent('click'));
  assert.equal(opens.length, 2, 'a second link must open at once as well');
  assert.equal(opens[1][0], 'http://example.org/second', 'and go to the address asked for THIS time');
});

check('criterion 3: the sandbox stays allow-scripts alone, and the parent takes an open request only from a genuine stage frame and only for an address it can parse as http/https', () => {
  // The rejected alternative, pinned: opening from inside the frame would have
  // needed 'allow-popups' on these three attributes. All three still read
  // exactly 'allow-scripts', and no sandbox token is added anywhere.
  const sandboxValues = [...renderSrcText.matchAll(/sandbox="([^"]*)"/g)].map(m => m[1]);
  assert.ok(sandboxValues.length >= 3, `setup failure: src/render.mjs has ${sandboxValues.length} sandbox attributes, expected the three stage sites at least`);
  assert.deepEqual([...new Set(sandboxValues)], ['allow-scripts'],
    'no sandbox attribute in src/render.mjs may name anything but allow-scripts -- \'allow-popups\' is exactly the alternative the board opening the tab itself exists so none of them needs');

  const { document, frame } = mountStage(linkBoard(OUTBOUND_MOCK, false));
  const opens = stubWindowOpen(document);
  const stageWindow = frame.contentWindow;
  const good = { cb: 'cb-stage', type: 'link', url: 'https://example.com/ok' };

  // Not a genuine stage: a real (non-opaque) origin, or a source no live
  // '.html-stage' frame's contentWindow matches. Same two gates every other
  // type on this channel goes through, before any shape check runs.
  document.defaultView.dispatchEvent({ type: 'message', data: good, origin: 'https://evil.example', source: stageWindow });
  assert.deepEqual(opens, [], 'an open request reporting a real origin must be ignored');
  document.defaultView.dispatchEvent({ type: 'message', data: good, origin: 'null', source: {} });
  assert.deepEqual(opens, [], 'an open request not sourced from a live stage frame must be ignored');

  // Genuine stage, hostile payload. Every one of these opens nothing at all.
  const hostile = [
    {},
    { url: 42 },
    { url: '' },
    { url: { toString: () => 'https://example.com/x' } },
    { url: 'javascript:alert(1)' },
    { url: 'data:text/html,<script>alert(1)</' + 'script>' },
    { url: 'file:///etc/passwd' },
    { url: 'not a url at all' },
    { url: '/b/another-board' },
    { url: 'https://example.com/' + 'a'.repeat(5000) }, // longer than any real link carries, so refused outright
  ];
  for (const payload of hostile) {
    document.defaultView.dispatchEvent({
      type: 'message',
      data: Object.assign({ cb: 'cb-stage', type: 'link' }, payload),
      origin: 'null',
      source: stageWindow,
    });
    assert.deepEqual(opens, [], `a hostile open request must open nothing: ${JSON.stringify(payload)}`);
  }
  assert.equal({}.polluted, undefined, 'a hostile open request must never pollute Object.prototype');

  // A markup-shaped address opens as the URL parser leaves it: the tab goes to
  // the PARSED string, never to the bytes the stage typed.
  document.defaultView.dispatchEvent({
    type: 'message',
    data: { cb: 'cb-stage', type: 'link', url: 'https://example.com/<img src=x onerror=alert(1)>' },
    origin: 'null',
    source: stageWindow,
  });
  assert.equal(opens.length, 1, 'a parseable http address still opens, however it is dressed');
  assert.ok(!opens[0][0].includes('<img'), 'what opens is what new URL made of it, escaped');

  // And a genuine, well-formed request still works right after all of that --
  // the validation is a filter, not a latch.
  document.defaultView.dispatchEvent({ type: 'message', data: good, origin: 'null', source: stageWindow });
  assert.equal(opens.length, 2, 'a genuine open request must still work after a batch of hostile ones');
  assert.equal(opens[1][0], 'https://example.com/ok');
});

finish('stage-isolation');
