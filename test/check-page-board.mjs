// The page board, driven for real: a board whose blocks are one `html` block and
// nothing else renders that artifact at viewport size (src/render.mjs's
// isPageBoard -- ADR.md entries 32/33/34/43), and everything the reviewer can do
// to it still works.
//
// The pure half -- the inference rule and the layout as markup plus stylesheet --
// is asserted on renderBoardPage's own output in test/check-pure.mjs, and the
// standalone archive in test/check-archive.mjs. What is here is the half that
// needs a live document and the real client script: the artifact's own scripts
// executing inside the sandbox, the click-to-anchor gesture and its pin, the
// frame's height staying put against a stage that reports one, and the live
// transition when a round arrives and this stops being a page board at all.
//
// Everything runs against the real `renderBoardPage`, the real `stageAgentScript`
// and the real `ui`, through test/dom-stand-in.mjs -- never a hand-summary of
// what they do; same shape as test/check-stage-isolation.mjs and
// test/check-stage-lens.mjs, whose loaders this file's are copied from (there is
// no shared test-helper module in this repo, by convention).
//
// WHAT NO CHECK HERE CAN PROVE. Criterion 3 is "the artifact's own theme toggle,
// its table-of-contents scroll-spy, its quiz and its own diagram dialog all
// work". A DOM stand-in has no layout, no scroll, no IntersectionObserver and no
// <dialog> behaviour (QUIRKS.md), so what is provable at this level is that
// nothing about the page board stands between the artifact and the browser: the
// sandbox still carries allow-scripts, the srcdoc is byte-identical to the one an
// ordinary stage gets, the margin reset stays leading, and a script inside the
// artifact genuinely executes and can mutate its own document. Whether a real
// scroll-spy fires and a real <dialog> opens at 100vh is a real-browser question.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock, stageAgentScript, COMMENT_ICON } from '../src/render.mjs';
// The daemon's own push builder, imported rather than re-implemented: a check
// that rebuilt the payload locally would assert its own copy of the rule and
// stay green through any change to the real one (which is how the amend path's
// missing `fullpage` survived two other push checks).
import { buildRoundPushPayload } from '../src/server.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { PAGE_SEND_EXPIRED_LABEL, PAGE_SEND_EXPIRED_TITLE } from '../src/badge.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { parseHTML, StandInEvent, StandInEventSource, resolveComputedProperty } from './dom-stand-in.mjs';

// src/ui.mjs's reportStageBand falls back to hardcoded pixel figures when
// getComputedStyle cannot be trusted (this suite's DOM stand-in, see this
// file's own header comment, never implements it) -- figures chosen to match
// --space-4/--space-3's own declared values in src/styles.mjs. Read out of the
// already-imported `styles` string here rather than re-typed as bare numbers,
// so a change to either custom property in src/styles.mjs cannot leave this
// suite silently asserting a stale fallback.
const SPACE_4_FALLBACK = parseFloat(styles.match(/--space-4:\s*([\d.]+)px/)[1]);
const SPACE_3_FALLBACK = parseFloat(styles.match(/--space-3:\s*([\d.]+)px/)[1]);

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

/** A rendered artifact of the shape /visualize posts: its own <style>, its own
 * markup, and its own <script>, all inline (ADR.md entry 32 -- an opaque origin
 * resolves no relative URL, so a real artifact is one self-contained file). */
const ARTIFACT = '<style>.doc{font:14px system-ui}</style>'
  + '<div class="doc"><h1>Quarterly</h1><button id="theme">Toggle theme</button><p id="out">unrun</p></div>'
  + '<script>'
  + 'window.__artifactRan = (window.__artifactRan || 0) + 1;'
  + 'document.getElementById("out").textContent = "the artifact\'s own script ran";'
  + 'document.getElementById("theme").addEventListener("click", function () {'
  + '  document.getElementById("out").textContent = "themed";'
  + '});'
  + '</script>';

// `wait: true` (SPEC_AWAITED.md ticket 03): every existing check in this file
// predates *awaited* and exercises the page board's commenting/click-to-anchor
// surface, which ADR.md entry 46 now gates on the round actually being
// awaited -- so the default fixture here has to declare it, or every one of
// those checks would be proving something about a page nobody is waiting on.
// The non-awaited case (AC 8: no comment control at all) gets its own
// dedicated fixture and checks further down, rather than becoming this
// function's second, silently-different mode.
function pageBoard(html = ARTIFACT) {
  return createBoard({ title: 'Rendered artifact', blocks: [{ kind: 'html', html }], wait: true });
}

// AC 8: the same shape, deliberately posted WITHOUT `wait: true` -- a page
// board nobody is waiting on.
function nonAwaitedPageBoard(html = ARTIFACT) {
  return createBoard({ title: 'Rendered artifact, unawaited', blocks: [{ kind: 'html', html }] });
}

function loadBoard(pageHtml, protocol = 'http:') {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** loadBoard with a captured, stubbed EventSource in place before the script runs
 * -- test/check-round-end.mjs's own idiom, reused to drive a real 'round' push. */
function loadBoardWithEventSource(pageHtml) {
  const originalES = globalThis.EventSource;
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  globalThis.EventSource = CapturingEventSource;
  try {
    const document = loadBoard(pageHtml);
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
    return { document, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
}

/** Run `fn` with a stubbed global fetch and hand back every call it made --
 * test/check-enter.mjs's own idiom, reused so "posts nothing" is asserted
 * against the actual request the page would have sent, not against a button's
 * attribute. */
function withFetchCapture(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    fn();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

// Idempotent (SPEC_AWAITED.md ticket 03, AC 5): an awaited page board now
// hydrates with comment mode already ON, so a bare unconditional click here
// would toggle it straight back OFF on exactly the fixture this file's checks
// mostly use. Only clicks when it still needs to.
function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  if (!toggle.classList.contains('active')) toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

/** Load a page board and bring its stage up exactly as a browser would: the
 * srcdoc navigation completes (the artifact's own script and the injected stage
 * agent both run), the agent posts 'ready', and the parent wires it. */
function openPageBoard(board = pageBoard()) {
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered');
  frame.loadSrcdoc();
  return { document, frame, blockId: board.blocks[0].id };
}

/** openPageBoard with BOTH real client scripts, in the order a real page runs
 * them: themeBootScript inline in <head>, then `ui` (a deferred module script,
 * so after parsing but before DOMContentLoaded), then the parser reaching the
 * end of the document -- which is what actually invokes themeBootScript's
 * `wire()` and attaches the theme control's click listener. QUIRKS.md
 * ("test/check-archive.mjs's own loadBoard never runs themeBootScript") is the
 * trap this avoids: with `ui` alone, #theme-toggle is in the markup, is not
 * disabled, and does nothing at all when clicked. */
function openPageBoardThemed(board = pageBoard(), protocol = 'http:') {
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', themeBootScript)(document, window, location);
  new Function('document', 'window', 'location', ui)(document, window, location);
  document.finishParsing();
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered');
  frame.loadSrcdoc();
  return { document, window, frame };
}

/** What a page board's stage reports as it is scrolled (ADR.md entry 40) --
 * forged from the stage's OWN window, which is the only source the parent's
 * listener trusts (origin 'null' plus event.source identity), i.e. exactly the
 * shape agent-authored markup can put on this channel. */
function reportScroll(frame, top) {
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top }, '*');
}

const condensed = (document) => document.body.classList.contains('stage-scrolled');
const backToTop = (document) => document.querySelector('button#back-to-top');
const computed = (el, prop) => resolveComputedProperty(styles, el, true, prop);

/** Every `scroll` report the BOARD's window receives, in order. Watched on the
 * board side because the stage's own `window.parent` is the narrow
 * postMessage-only handle the sandbox gives it (test/dom-stand-in.mjs models
 * that deliberately), so the receiving side is the only place to see these. */
function stageReports(document) {
  const reports = [];
  document.defaultView.addEventListener('message', (ev) => {
    if (ev.data && ev.data.cb === 'cb-stage' && ev.data.type === 'scroll') reports.push(ev.data);
  });
  return reports;
}

// =================================================================================
// Criterion 16: reading the artifact condenses the header, scrolling back expands
// it, and the frame's height never moves through any of it.
// =================================================================================

const progress = (document) => document.body.style.getPropertyValue('--stage-p');

check('criterion 16: a scroll report condenses the header into a centred floating pill, and scrolling back up expands it again', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  const ident = document.querySelector('.board-head-ident');

  assert.equal(condensed(document), false, 'setup: an unscrolled artifact leaves the header expanded');
  assert.equal(computed(head, 'left'), '0', 'setup: expanded, the header spans the viewport');

  reportScroll(frame, 800);
  assert.equal(condensed(document), true);
  assert.equal(progress(document), '1.000', 'well past the ramp, the condense is complete');

  // The header spans the viewport at EVERY progress and the pill is a centred
  // band drawn behind it (a ::before inset by a percentage of the header's own
  // width). That is what makes the condense animatable at all: 'left: 0' to
  // 'left: 50%' has no interpolable midpoint, an inset percentage does. So
  // "centred" is now a fact about the chrome, not about the header's box, and
  // asserting the old 'left: 50%' here would be asserting the bug.
  assert.equal(computed(head, 'left'), '0', 'the header itself never moves -- only the chrome inside it converges');
  assert.match(computed(head, 'padding-inline'), /--stage-p/, 'the controls walk into the band on the same progress');
  assert.equal(computed(head, 'background'), 'none', 'the expanded wash moves to its own layer so it can fade');
  assert.match(computed(ident, 'max-width'), /--stage-p/, 'the identity text collapses on the progress rather than being switched off');
  assert.notEqual(computed(ident, 'display'), 'none', 'and collapses by width, not by display -- a display flip is what cannot be animated');

  reportScroll(frame, 0);
  assert.equal(condensed(document), false, 'scrolling back to the top expands it again');
  assert.equal(progress(document), '0.000', 'and the progress genuinely returns to zero, not merely below a threshold');
});

check('criterion 16: the condense is a ramp with no threshold -- the pill forms continuously under the reader\'s own scroll', () => {
  const { document, frame } = openPageBoard();

  // The whole point of the ramp: a reader resting mid-gesture sits at a real
  // intermediate value rather than on a boundary that flips the entire header
  // on and off. The old 24px threshold is exactly what this must never become,
  // so the assertion is STRICTLY between, not merely "not zero".
  reportScroll(frame, 70);
  const mid = Number(progress(document));
  assert.ok(mid > 0 && mid < 1, `a half-scrolled artifact is half condensed, got ${mid}`);
  assert.equal(condensed(document), true, 'and it counts as reading from the first pixel');

  // Monotonic, and every step lands somewhere different: a ramp that quantised
  // to a few steps would still flicker, just at more places.
  const seen = [35, 70, 105, 140].map((top) => {
    reportScroll(frame, top);
    return Number(progress(document));
  });
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress only ever increases with the scroll offset');
  assert.equal(new Set(seen).size, seen.length, 'and each offset maps to its own value');
  assert.equal(seen[seen.length - 1], 1, 'the ramp completes exactly at the condense distance');

  // Past the end it saturates rather than overshooting: an opacity of 6 or a
  // padding past 50% would invert the pill on a long artifact.
  reportScroll(frame, 100000);
  assert.equal(progress(document), '1.000', 'a long artifact cannot push the progress past 1');
});

// What no stand-in can measure is a box, so this asserts the two shapes the
// geometry depends on rather than the pixels they produce. Measured in Chrome
// against this same render, the pill stops having one height at all and takes
// the one its controls ask for: 64.4px before, and after, 39.8px on an awaited
// page (the comment-mode chip is the tallest thing in it) or 34.4px on one
// that is not awaited (no chip, so the badge's own label sets it). 12px of air
// on both sides of the contents in either case.
//
// The identity block is the one that bit: collapsed to 'max-width: 0' at
// 'opacity: 0' it still contributed all 52.4px of its height, so the pill was
// sized by text nobody can see rather than by the controls it exists to carry.
// The mark is the other half -- a width that eased with the ramp would leave
// src/ui.mjs's measurePillHalf (which reads '.back-to-index'.offsetWidth, and
// re-measures only when '.board-head-actions' resizes) holding a figure for a
// mark size the header has already left.
check('criterion 16: the condensed pill is sized by the controls it carries -- the collapsed identity block gives up its height as well as its width, and the mark never eases', () => {
  const { document, frame } = openPageBoard();
  const ident = document.querySelector('.board-head-ident');
  const title = document.querySelector('.board-head-title');
  const brand = document.querySelector('.back-to-index');

  reportScroll(frame, 800);
  assert.equal(progress(document), '1.000', 'setup: fully condensed');

  assert.match(computed(ident, 'max-height'), /--stage-p/,
    'an invisible identity block that keeps its height sets the pill\'s height, which is what made the chrome read as rounder than its own contents');
  assert.match(computed(ident, 'max-width'), /--stage-p/, 'and it still collapses horizontally as before');
  assert.match(computed(title, 'gap'), /--stage-p/,
    'the gap that held the identity block off the mark goes with it, or the pill\'s contents sit left of their own band -- and measurePillHalf, which sums brand + the header\'s gap + actions, silently stops being the whole content width');
  assert.doesNotMatch(computed(brand, 'width'), /--stage-p/,
    'the mark is one constant width on a page board: an eased width is measured once and then wrong for every other progress on the ramp');
});

// The chrome the reviewer actually picked, as declared properties -- the one
// layer of this a stand-in can hold. What it cannot see is the box those
// properties produce; that stays a real-browser fact, measured and recorded in
// src/styles.mjs's own comments.
check('criterion 16: the pill wears a corner rather than a capsule, and holds one line of chrome rather than a chip beside a label', () => {
  const { document, frame } = openPageBoard();
  const meta = document.querySelector('span#round-meta');
  const head = document.querySelector('.board-head');
  reportScroll(frame, 800);

  // 'none', not '': the page board's own header rule states it outright (the
  // wash and the pill chrome are separate layers there, so the header's own box
  // must declare it away). On an ordinary board the declaration is simply gone,
  // which the resolver reports as '' -- both spellings of ADR.md entry 52.
  assert.equal(computed(head, 'border-bottom'), 'none',
    'a header that fades draws no hairline under the fade (ADR.md entry 52) -- the gradient is the edge');
  // ADR.md entry 61 deleted the round badge this check used to pin as "a
  // label, not a chip" (background/border: none) -- there is no chip left to
  // de-chip; the state label alone, with a hairline ahead of it, is what
  // survives.
  assert.match(computed(meta, 'border-left'), /var\(--hairline\)/,
    'a hairline is what separates the state label from the control before it, once neither wears a second round of chrome');
  // Asserted against the stylesheet text, not through the resolver: ':empty' is
  // a state the stand-in does not evaluate (QUIRKS.md, "the stand-in has no
  // layout" -- it has no live matching either). The fact being pinned is that
  // the rule exists at all, because an awaited page first paints with no
  // countdown in this slot (src/render.mjs leaves the wall-clock figure to
  // hydrate) and a divider with nothing after it is what the reviewer would see.
  assert.match(styles, /body\.page-board \.round-meta:empty \{ display: none; \}/,
    'the divider must not be drawn while the slot is still empty');
});

check('AC 9 (SPEC_HEADER.md): a page board\'s comment-mode toggle wears COMMENT_ICON\'s own glyph, at rest and condensed alike -- the same node, never redrawn or swapped', () => {
  const { document, frame } = openPageBoard();
  const commentPaths = [...COMMENT_ICON.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  assert.deepEqual([...toggle.querySelectorAll('path')].map(p => p.getAttribute('d')), commentPaths,
    'at rest, the toggle must render COMMENT_ICON\'s own path data');

  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup failure: the scroll must have condensed the header into the pill');
  // Condensing is a pure CSS change of box, never of markup (src/styles.mjs's
  // own comment: "there is still exactly ONE #comment-mode-toggle in the
  // document, condensed or not") -- so the SAME element, not a second one, is
  // what this re-reads.
  const stillToggle = document.getElementById('comment-mode-toggle');
  assert.equal(stillToggle, toggle, 'condensing must not swap in a second #comment-mode-toggle element');
  assert.deepEqual([...stillToggle.querySelectorAll('path')].map(p => p.getAttribute('d')), commentPaths,
    'condensed, the toggle must still render COMMENT_ICON\'s own path data');
});

check('AC 12 (SPEC_HEADER.md, ADR.md entry 61): a page board\'s header names no round, at rest or condensed', () => {
  const { document, frame } = openPageBoard();
  assert.equal(document.getElementById('round-badge'), null, 'setup: no #round-badge at rest');
  assert.equal(document.querySelectorAll('.round-badge').length, 0, 'setup: no .round-badge element at rest');

  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup failure: the scroll must have condensed the header into the pill');
  assert.equal(document.getElementById('round-badge'), null, 'condensing must not resurrect a #round-badge element');
  assert.equal(document.querySelectorAll('.round-badge').length, 0, 'condensing must not resurrect a .round-badge element');
});

check('criterion 16: the frame is untouched across a whole condense/expand cycle -- it floats OVER the frame, which stays a constant 100vh', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  assert.equal(frame.getAttribute('style'), null, 'setup: nothing has set an inline height');

  reportScroll(frame, 1200);
  reportScroll(frame, 40);
  reportScroll(frame, 0);
  reportScroll(frame, 900);

  assert.equal(frame.getAttribute('style'), null,
    'condensing must never write to the frame -- a frame that resized as the header did would reflow a long artifact under the reader mid-read, which is exactly what ADR.md entry 40 chose an overlay to prevent');
  assert.equal(computed(frame, 'height'), '100vh', 'and the stylesheet still gives it a constant viewport height');
  assert.doesNotMatch(computed(frame, 'height'), /--stage-p/,
    'a frame whose height read the condense progress would resize under the reader on every scroll -- the exact reflow ADR.md entry 40 chose an overlay to prevent');
  // The frame is structurally exempt from the one thing that CAN set an inline
  // height: handleStageHeight is gated on '.choice-variant', and a page board's
  // stage is not one. Proven directly by this file's own criterion-2 check
  // rather than re-proven here; what this asserts is that the NEW mechanism
  // adds no second way in.
  assert.equal(computed(head, 'position'), 'fixed',
    'the header stays out of flow in both states, so the frame never starts below it');
});

check('criterion 16: the report itself comes from the stage\'s own scroll listener -- the one place that can see the fact at all', () => {
  // Everything above forges the message. This drives the REAL reporting half:
  // a scroll event in the stage document, through the real stageAgentScript,
  // producing the message the parent then acts on. What a stand-in cannot
  // supply is the GESTURE -- it lays nothing out and scrolls nothing, so
  // `pageYOffset` is set here rather than moved. That the artifact genuinely
  // scrolls at 100vh, and that a real wheel/trackpad gesture fires this, is a
  // real-browser question; that the listener exists, reads the offset and
  // reports it in a shape the parent accepts is this one.
  const { document, frame } = openPageBoard();
  const stageWindow = frame.contentWindow;
  const stageDoc = frame.contentDocument;
  const reports = stageReports(document);

  stageWindow.pageYOffset = 640;
  // Dispatched on the stage DOCUMENT, which is where the real listener is
  // registered, with the document as the event's target -- exactly the shape a
  // browser delivers a viewport scroll in. What this stand-in cannot model is
  // the PROPAGATION (its dispatch walks parentElement, so it has no capture
  // path); that a capture listener on `document` genuinely sees both the
  // viewport's scroll and an inner pane's was measured in Chrome instead.
  stageDoc.dispatchEvent({ type: 'scroll', target: stageDoc });
  assert.deepEqual(reports, [{ cb: 'cb-stage', type: 'scroll', top: 640 }],
    'a scroll inside the artifact must report itself -- the parent can neither read this document nor observe it, which is why entry 40 makes this a message');
  assert.equal(condensed(document), true, 'and the report the stage actually sends is one the parent accepts');

  // Deduplicated on the last reported value: a scroll event that lands where
  // the last one did says nothing new, and this channel carries real work.
  stageDoc.dispatchEvent({ type: 'scroll', target: stageDoc });
  assert.equal(reports.length, 1, 'an unchanged offset must not re-post');

  stageWindow.pageYOffset = 0;
  stageDoc.dispatchEvent({ type: 'scroll', target: stageDoc });
  assert.equal(reports.length, 2);
  assert.equal(condensed(document), false, 'and scrolling back to the top expands the header again');
});

check('criteria 16 and 18: an artifact whose SCROLLER is an inner pane, not the document -- the read, the write and the listener all name that pane', () => {
  // The defect this pins, measured in Chrome 151 against an app-shell artifact
  // (a fixed sidebar beside a `height: 100vh; overflow-y: auto` pane -- an
  // ordinary shape for a page designed as a page): the document never scrolls,
  // so `window.scrollY` stayed 0 and no `scroll` event ever reached `window`
  // while the frame visibly showed its third section. Nothing was ever
  // reported, so the header never condensed and the control never appeared;
  // and an inbound request moved nothing, because `window.scrollTo` does not
  // touch an inner pane. Read, write and listener have to name the SAME
  // element, and the element identifies itself by being the scroll event's
  // target.
  //
  // No layout needed to prove any of that: `scrollTop` is set here rather than
  // reached by a gesture, which is the same concession the viewport check above
  // makes. What needed a browser was establishing that the pane, not the
  // document, is what moves in this shape at all.
  const { document, frame } = openPageBoard();
  const stageDoc = frame.contentDocument;
  const reports = stageReports(document);

  const pane = stageDoc.getElementById('out');
  assert.ok(pane, 'setup failure: no element in the artifact to stand in for the scrolling pane');
  // The document itself is NOT where the offset lives in this shape.
  frame.contentWindow.pageYOffset = 0;
  pane.scrollTop = 700;
  stageDoc.dispatchEvent({ type: 'scroll', target: pane });

  assert.deepEqual(reports, [{ cb: 'cb-stage', type: 'scroll', top: 700 }],
    'the report must carry the PANE\'s offset -- reading the document here reports 0 forever, and a header that never condenses is what that looks like');
  assert.equal(condensed(document), true, 'so the header condenses on an artifact that scrolls an inner pane, exactly as on one that scrolls its document');
  assert.equal(backToTop(document).classList.contains('visible'), true);

  // And the write goes to the same element the read came from. The stand-in's
  // elements have no `scrollTo`, so the agent's own floor (`scrollTop = top`)
  // is what runs -- which is the assertion: something moved the PANE.
  const windowScrollCalls = [];
  frame.contentWindow.scrollTo = (...args) => { windowScrollCalls.push(args); };
  backToTop(document).dispatchEvent(new StandInEvent('click'));

  assert.equal(pane.scrollTop, 0, 'back-to-top must return the PANE the reviewer was reading');
  assert.deepEqual(windowScrollCalls, [],
    'and must not scroll the document instead -- that is the no-op the reviewer sees as a dead control');
});

check('criterion 16: a malformed scroll report is inert, and an ordinary board\'s stage cannot condense anything at all', () => {
  const { document, frame } = openPageBoard();
  const bad = [
    { cb: 'cb-stage', type: 'scroll', top: '800' },      // a string, not a number
    { cb: 'cb-stage', type: 'scroll', top: NaN },
    { cb: 'cb-stage', type: 'scroll', top: Infinity },
    { cb: 'cb-stage', type: 'scroll' },                   // no offset at all
    { cb: 'cb-stage', type: 'scroll', top: { valueOf: () => 800 } },
    { cb: 'not-ours', type: 'scroll', top: 800 },         // not this channel
  ];
  bad.forEach((msg) => {
    frame.contentWindow.parent.postMessage(msg, '*');
    assert.equal(condensed(document), false, `a stage is agent-authored input: ${JSON.stringify(msg)} must be rejected, not acted on`);
    assert.equal(backToTop(document).classList.contains('visible'), false);
  });
  // And the well-formed one still works, so the check above is rejecting the
  // messages rather than the mechanism being dead.
  reportScroll(frame, 800);
  assert.equal(condensed(document), true);

  // stageAgentScript is the SAME script in every stage, so an ordinary board's
  // stage reports its own internal scrolling too. Acting on that would condense
  // a header that is not floating and float a control over a page with its own
  // scrollbar -- the parent's page-board gate is what stops it.
  const ordinary = createBoard({
    title: 'artifact + a note',
    blocks: [{ kind: 'html', html: ARTIFACT }, { kind: 'markdown', text: 'a second block' }],
  });
  const doc2 = loadBoard(renderBoardPage(ordinary));
  const frame2 = doc2.querySelector('.html-stage');
  frame2.loadSrcdoc();
  assert.equal(doc2.body.classList.contains('page-board'), false, 'setup: two blocks is an ordinary board');
  reportScroll(frame2, 800);
  assert.equal(condensed(doc2), false, 'an ordinary board\'s header never condenses');
  assert.equal(backToTop(doc2).classList.contains('visible'), false, 'and it grows no back-to-top control');
});

// =================================================================================
// Criterion 17: the condensed pill carries the comment-mode toggle.
// =================================================================================

check('criterion 17: the condensed pill carries the comment-mode toggle -- one control, still in the header, still shown', () => {
  const { document, frame } = openPageBoard();
  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup: the header is condensed');

  // Exactly ONE, condensed or not. Condensing hides the header's identity text
  // rather than moving a control into a second copy of it: two
  // #comment-mode-toggle elements could disagree about .active/aria-pressed,
  // and src/ui.mjs's setCommentMode writes to one element.
  assert.equal(document.querySelectorAll('#comment-mode-toggle').length, 1,
    'there must be exactly one comment-mode control in the document at any moment');
  const toggle = document.querySelector('button#comment-mode-toggle');
  assert.ok(toggle.closest('.board-head'), 'and it must be inside the header that condensed, not left behind above it');
  assert.equal(computed(toggle, 'display'), 'inline-flex',
    'a pill that hid the one control it exists to carry would be decoration');
  assert.equal(computed(document.querySelector('button#theme-toggle'), 'display'), 'inline-flex',
    'and the theme control rides along -- entry 40 changes the header\'s state, never its contents');
});

check('criterion 17: comment mode can be switched on AND off while condensed, without scrolling back to the top', () => {
  const { document, frame } = openPageBoard();
  const heard = [];
  frame.contentWindow.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'mode') heard.push(ev.data.commentMode);
  });

  reportScroll(frame, 800);
  const toggle = document.querySelector('button#comment-mode-toggle');

  // SPEC_AWAITED.md ticket 03, AC 5: this awaited page board hydrates with
  // comment mode already ON -- that is itself the starting state under test
  // here, not something this check has to switch on first.
  assert.equal(toggle.classList.contains('active'), true, 'setup: an awaited page board opens with comment mode on (AC 5)');
  assert.equal(condensed(document), true, 'setup: the header is condensed');

  // The gesture the mode exists for works from the condensed pill straight
  // away: a click inside the artifact anchors a comment, with no toggle press
  // needed first.
  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelector('.comment-form').classList.contains('open'), true,
    'the mode that opened the page on is a real mode, not just a lit-up button');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), false, 'mid-read, the toggle turns comment mode off, still without scrolling back');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(document.body.classList.contains('comment-mode'), false);
  assert.equal(condensed(document), true, 'and switching mode does not un-condense the header');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'and back on again, still without scrolling back');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(heard, [false, true],
    'the stage hears both transitions -- its own hover/click gesture lives in a document no body class of ours reaches');
});

// =================================================================================
// Criterion 18: back to the top.
// =================================================================================

check('criterion 18: a back-to-top control appears once the artifact is scrolled, and goes away again at the top', () => {
  const { document, frame } = openPageBoard();
  const btn = backToTop(document);
  assert.ok(btn, 'the control is rendered on every board and turned on by .visible alone');
  assert.equal(btn.classList.contains('visible'), false, 'setup: an unscrolled artifact needs no way back up');
  assert.equal(computed(btn, 'display'), 'none', 'and .visible is the only rule that ever turns display on');

  reportScroll(frame, 800);
  assert.equal(btn.classList.contains('visible'), true);
  assert.equal(computed(btn, 'display'), 'inline-flex');
  // Two bottom controls, two positions: the round pager takes bottom-centre, so
  // this one is bottom-RIGHT and must not centre itself onto the pager.
  assert.equal(computed(btn, 'position'), 'fixed', 'it floats over the frame like every other page-board control');
  assert.equal(computed(btn, 'right'), 'var(--space-5)');
  assert.equal(computed(btn, 'bottom'), 'var(--space-5)');
  assert.equal(computed(btn, 'left'), '', 'bottom-right, never bottom-centre -- that position belongs to the round pager');

  reportScroll(frame, 0);
  assert.equal(btn.classList.contains('visible'), false, 'and it leaves once there is nowhere to go');
});

check('criterion 18: clicking back-to-top returns the artifact to the top -- over the channel, since the parent cannot scroll a sandboxed frame', () => {
  const { document, frame } = openPageBoard();
  const calls = [];
  // The stage's own window is what actually scrolls; a real browser gives the
  // parent no way to reach it, which is why this is a message at all.
  frame.contentWindow.scrollTo = (...args) => { calls.push(args); };

  reportScroll(frame, 800);
  backToTop(document).dispatchEvent(new StandInEvent('click'));

  assert.equal(calls.length, 1, 'the click must reach the stage document that actually scrolls');
  assert.deepEqual(calls[0], [{ top: 0, left: 0, behavior: 'smooth' }], 'and take it to the top');
});

check('the INBOUND half of the channel is shape-checked too -- the stage refuses a malformed or unaddressed message from the parent', () => {
  // The outbound direction (stage -> board) is driven hard by the checks above
  // and by test/check-stage-isolation.mjs. The inbound one had never been driven
  // by anything but a real UI action, so every guard in stageAgentScript's own
  // listener -- the source-identity check, the channel token, and the per-type
  // shape checks -- ran under no runtime assertion at all; test/check-pure.mjs
  // regex-matches their presence in the source, which pins the spelling and not
  // the behaviour.
  //
  // It is not a symmetric threat, and that is exactly why it is worth pinning:
  // the parent is trusted, so what these guards actually defend against is a
  // message that is NOT from the parent (a sibling frame, the lens's own copy of
  // this stage) and a parent-shaped message carrying a value that would be handed
  // straight to scrollTo or to setAttribute.
  const { document, frame } = openPageBoardThemed();
  const stageWindow = frame.contentWindow;
  const root = frame.contentDocument.documentElement;
  const scrolls = [];
  stageWindow.scrollTo = (...args) => { scrolls.push(args); };
  // Everything this stage says back, so a rejected 'locate' can be seen to have
  // produced no answer at all rather than an empty one.
  const posted = [];
  document.defaultView.addEventListener('message', (ev) => {
    if (ev.source === stageWindow && ev.data && ev.data.type === 'positions') posted.push(ev.data);
  });

  const themeBefore = root.getAttribute('data-theme');
  assert.equal(themeBefore, 'dark', 'setup: the stage starts painted in the board\'s theme');
  // SPEC_HEADER.md ADR 59: the 'band' handler's own guards (applyBand's
  // Math.max is never reached at all unless both fields pass the same
  // finite/non-negative shape check 'scroll''s top does) had never run under a
  // check either -- everything below asserts padding stays exactly where
  // setup left it across the whole malformed batch.
  const paddingBefore = { top: frame.contentDocument.body.style.paddingTop, bottom: frame.contentDocument.body.style.paddingBottom };

  const bad = [
    null,
    'a string, not an object',
    { type: 'scroll', top: 0 },                                  // no channel token
    { cb: 'not-ours', type: 'scroll', top: 0 },                  // the wrong channel
    { cb: 'cb-stage' },                                          // no type at all
    { cb: 'cb-stage', type: 42 },                                // a type that is not a string
    { cb: 'cb-stage', type: 'scroll', top: '0' },                // a string offset
    { cb: 'cb-stage', type: 'scroll', top: NaN },
    { cb: 'cb-stage', type: 'scroll', top: Infinity },
    { cb: 'cb-stage', type: 'scroll' },                          // no offset
    { cb: 'cb-stage', type: 'scroll', top: { valueOf: () => 0 } },
    { cb: 'cb-stage', type: 'mode', commentMode: true, theme: 'evil' },
    { cb: 'cb-stage', type: 'mode', commentMode: true, theme: 'DARK' },  // not the two literals
    { cb: 'cb-stage', type: 'locate', requestId: 7, refs: [] },  // a non-string request id
    { cb: 'cb-stage', type: 'locate', requestId: 'r1', refs: 'nope' },
    { cb: 'cb-stage', type: 'locate', requestId: 'r1' },         // no refs at all
    { cb: 'cb-stage', type: 'band', top: '0', bottom: 0 },       // a string top
    { cb: 'cb-stage', type: 'band', top: 0, bottom: '0' },       // a string bottom
    { cb: 'cb-stage', type: 'band', top: NaN, bottom: 0 },
    { cb: 'cb-stage', type: 'band', top: 0, bottom: NaN },
    { cb: 'cb-stage', type: 'band', top: Infinity, bottom: 0 },
    { cb: 'cb-stage', type: 'band', top: 0, bottom: Infinity },
    { cb: 'cb-stage', type: 'band', top: -1, bottom: 0 },        // negative
    { cb: 'cb-stage', type: 'band', top: 0, bottom: -1 },
    { cb: 'cb-stage', type: 'band', top: 0 },                    // no bottom at all
    { cb: 'cb-stage', type: 'band', bottom: 0 },                 // no top at all
    { cb: 'cb-stage', type: 'nonsense' },
  ];
  for (const data of bad) {
    stageWindow.postMessage(data);
    assert.deepEqual(scrolls, [], `a malformed parent message must never reach scrollTo: ${JSON.stringify(data)}`);
    assert.equal(root.getAttribute('data-theme'), themeBefore,
      `nor repaint the artifact: ${JSON.stringify(data)}`);
    assert.deepEqual(
      { top: frame.contentDocument.body.style.paddingTop, bottom: frame.contentDocument.body.style.paddingBottom },
      paddingBefore,
      `nor touch the band padding: ${JSON.stringify(data)}`);
  }
  assert.equal(root.style.colorScheme, 'dark', 'and none of them may have moved color-scheme either');

  // A well-formed message from something that is NOT this frame's parent -- the
  // lens holds a second copy of this same stage, and a sibling frame can address
  // one by name. `event.source === window.parent` is the whole of what refuses it.
  const stranger = { postMessage() {} };
  stageWindow.dispatchEvent({ type: 'message', data: { cb: 'cb-stage', type: 'scroll', top: 900 }, origin: 'null', source: stranger });
  stageWindow.dispatchEvent({ type: 'message', data: { cb: 'cb-stage', type: 'mode', commentMode: true, theme: 'light' }, origin: 'null', source: stranger });
  assert.deepEqual(scrolls, [], 'a well-formed message from anything but this frame\'s own parent must be inert');
  assert.equal(root.getAttribute('data-theme'), 'dark', 'including one that would have repainted the artifact');

  // And the real thing still works, so the batch above rejected the messages
  // rather than the mechanism being dead.
  stageWindow.postMessage({ cb: 'cb-stage', type: 'scroll', top: 0 });
  assert.deepEqual(scrolls, [[{ top: 0, left: 0, behavior: 'smooth' }]], 'a well-formed request from the parent must still scroll the artifact');
  stageWindow.postMessage({ cb: 'cb-stage', type: 'mode', commentMode: false, theme: 'light' });
  assert.equal(root.getAttribute('data-theme'), 'light', 'and a well-formed theme must still repaint it');
  assert.deepEqual(posted, [],
    'and no refused "locate" may have answered: a reply to a request the guards rejected is the guard leaking a document geometry read');
});

check('criterion 18: the control is live in a read-only archive, where the artifact is exactly what a reader scrolls', () => {
  // QUIRKS.md "Readonly is locked twice": src/ui.mjs's blanket
  // qsa('textarea, input, button') disable loop would leave this control
  // visible and dead, which is worse than absent. There is no matching CSS gate
  // to carve out -- no body.readonly rule ever hid it -- so the JS carve-out is
  // the whole fix, and this is what fails if it is dropped.
  const document = loadBoard(renderBoardPage(pageBoard()), 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup: file: is a read-only archive');
  assert.equal(backToTop(document).disabled, false,
    'an archived page board still scrolls, so the way back up still has to work');

  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const calls = [];
  frame.contentWindow.scrollTo = (...args) => { calls.push(args); };
  reportScroll(frame, 800);
  assert.equal(backToTop(document).classList.contains('visible'), true);
  backToTop(document).dispatchEvent(new StandInEvent('click'));
  assert.equal(calls.length, 1, 'and it must actually scroll, not merely look enabled');
});

// =================================================================================
// Criterion 15 (the board's half): the theme control drives the artifact.
// =================================================================================

/** The theme the stage is currently painted in, as the stage itself recorded it
 * (src/render.mjs's applyTheme). */
function stageTheme(frame) {
  const root = frame.contentDocument.documentElement;
  return { attr: root.getAttribute('data-theme'), colorScheme: root.style.colorScheme };
}

check('criterion 15: a stage is painted in the board\'s theme the moment it announces itself, before any toggle', () => {
  const { frame } = openPageBoardThemed();
  assert.deepEqual(stageTheme(frame), { attr: 'dark', colorScheme: 'dark' },
    'the artifact must be told the current theme at "ready" -- a stage that only heard about CHANGES would paint its first frame in whatever its own markup guessed');
});

check('criterion 15: the board\'s theme control drives the artifact through the whole three-state cycle, resolved to a concrete light/dark', () => {
  const { document, frame } = openPageBoardThemed();
  const toggle = document.querySelector('button#theme-toggle');

  // System -> Light -> Dark -> System (src/theme.mjs's nextState).
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(stageTheme(frame).attr, 'light', 'choosing Light on the board paints the artifact light');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(stageTheme(frame).attr, 'dark', 'and Dark, dark');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(document.documentElement.getAttribute('data-theme'), null,
    'setup: back to System, which on the BOARD is the attribute being absent');
  // The awkward third state: "system" is not a thing a sandboxed frame can be
  // told. The parent resolves it against the OS before sending, so the stage
  // only ever handles two values and needs no media query, no listener of its
  // own, and no second source of truth for one fact.
  assert.equal(stageTheme(frame).attr, 'dark',
    'System must reach the stage RESOLVED -- the stand-in\'s OS prefers dark, matching this repo\'s own dark-first default');
  assert.notEqual(stageTheme(frame).attr, 'system', 'never the literal third state, which no stage could act on');
});

check('criterion 15: an OS light/dark flip while the board is in System repaints the artifact too', () => {
  const { document, window, frame } = openPageBoardThemed();
  assert.equal(document.documentElement.getAttribute('data-theme'), null, 'setup: System, no override in force');
  assert.equal(stageTheme(frame).attr, 'dark');

  // The one theme change the control itself never sees (src/theme.mjs's own
  // matchMedia listener) -- e.g. macOS switching at sunset while the reviewer
  // is mid-artifact.
  window._setSystemPrefersDark(false);
  assert.deepEqual(stageTheme(frame), { attr: 'light', colorScheme: 'light' },
    'the artifact follows the OS exactly as the board around it does');

  window._setSystemPrefersDark(true);
  assert.equal(stageTheme(frame).attr, 'dark', 'and back');
});

check('criterion 15: the theme still reaches the artifact in a read-only archive -- the one control an archive keeps', () => {
  // An archive opened from Finder with the network off: no daemon, no storage
  // (file: is storage-free by decision), every other control disabled. The
  // theme control stays live, and a rendered artifact inside it has no theme
  // control of its own to fall back on -- so the push is the only thing there.
  const { document, frame } = openPageBoardThemed(pageBoard(), 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup: this is an archive');
  const toggle = document.querySelector('button#theme-toggle');
  assert.equal(toggle.disabled, false, 'setup: the theme control is the one control an archive keeps');
  assert.equal(stageTheme(frame).attr, 'dark', 'and the artifact is painted at load, with no network involved');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(stageTheme(frame).attr, 'light',
    'switching theme in an archive must reach the artifact -- nothing else in it can');
});

check('criterion 15: theme rides the message that already carries comment mode, and neither field ever clobbers the other', () => {
  const { document, frame } = openPageBoardThemed();
  const heard = [];
  frame.contentWindow.addEventListener('message', (ev) => {
    if (ev.data && ev.data.cb === 'cb-stage' && ev.data.type === 'mode') heard.push(ev.data);
  });

  // A theme change with comment mode ON (SPEC_AWAITED.md ticket 03, AC 5:
  // this awaited page board hydrates that way already), then a mode change
  // with a theme already chosen: whichever fact moved, the stage is told
  // BOTH, so it can never be left holding a stale value of the one the
  // caller did not care about (ADR.md entry 39: one channel, one message
  // shape).
  document.querySelector('button#theme-toggle').dispatchEvent(new StandInEvent('click'));
  document.querySelector('button#comment-mode-toggle').dispatchEvent(new StandInEvent('click'));

  assert.equal(heard.length, 2, 'both changes go over the mode message, not a second message type');
  assert.deepEqual(heard.map(m => [m.commentMode, m.theme, Array.isArray(m.sentRefs)]),
    [[true, 'light', true], [false, 'light', true]],
    'a theme change carries the current mode, and a mode change carries the current theme');
  assert.equal(stageTheme(frame).attr, 'light', 'and turning comment mode off did not repaint the artifact back to the default');
});

// =================================================================================
// Criterion 3, as far as a stand-in can take it: the artifact's own scripts run.
// =================================================================================

check('criterion 3: the artifact\'s own script genuinely executes inside the page board\'s frame, and can drive its own controls', () => {
  const { frame } = openPageBoard();

  // The attribute, first, and on the PAGE-BOARD path specifically. The
  // execution assertions below cannot stand in for it: test/dom-stand-in.mjs
  // runs a srcdoc's <script> elements whatever the sandbox says (it models no
  // sandbox at all), so `sandbox=""` -- which kills every script in a real
  // browser and would turn this whole feature into a screenshot -- leaves the
  // rest of this file green. This is the one line that fails on it, and it is
  // deliberately in the file that CLAIMS criterion 3 rather than only in a
  // markup check elsewhere.
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts',
    'a page board\'s frame must carry exactly allow-scripts -- the browser is what enforces this, and nothing in a stand-in can observe it being wrong');

  assert.equal(frame.contentWindow.__artifactRan, 1,
    'the artifact\'s own <script> must actually run -- allow-scripts is what this layout keeps, and a page board that neutered it would be a picture of a page');
  assert.equal(frame.contentDocument.getElementById('out').textContent, 'the artifact\'s own script ran');

  // Its own controls keep working -- the artifact's theme toggle, its quiz and
  // its diagram dialog are all this: a listener the artifact registered on its
  // own element, in its own document.
  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
  assert.equal(frame.contentDocument.getElementById('out').textContent, 'themed',
    'a control the artifact wired itself must still respond inside a page board');
});

check('criterion 3: the injected stage agent runs alongside it -- both scripts, one document, and the parent hears the stage announce itself', () => {
  const { document, frame, blockId } = openPageBoard();
  // 'ready' is the stage's first message; the parent answers it with the current
  // comment mode. If the page board's markup had dropped .html-block (the class
  // src/ui.mjs's listener finds a stage's block by), every stage message would be
  // silently discarded and this is the cheapest place that shows.
  assert.ok(frame.closest('.html-block'), 'the stage must still sit inside an .html-block section, or every message from it is dropped at the parent\'s lookup');
  assert.equal(frame.closest('.html-block').getAttribute('data-block-id'), blockId);
  assert.ok(document.querySelector('.stage-wrap .pin-layer'), 'and its pin layer must still sit over the frame');
  assert.equal(frame.contentWindow.__artifactRan, 1, 'the artifact\'s script and the agent\'s share one document and both run');
  // Both scripts live at the mercy of one attribute, so it is asserted on the
  // frame they actually ran in, not inferred from the fact that they ran.
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.ok(!frame.getAttribute('sandbox').includes('allow-same-origin'),
    'and never allow-same-origin: a same-origin artifact could script the board page and answer its own questions (ADR.md entry 32)');
});

// =================================================================================
// Criterion 5: the comment gesture, and the pin over the right element.
// =================================================================================

check('criterion 5: clicking an element inside a page board\'s artifact anchors a comment to that element', () => {
  const { document, frame, blockId } = openPageBoard();
  enableCommentMode(document);

  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, 'setup failure: the page board must still render the block\'s comment form');
  assert.equal(form.classList.contains('open'), true,
    'clicking an element inside the artifact must open that block\'s comment form -- the whole gesture ADR.md entry 32 chose a snapshotted stage to keep');
  assert.equal(form.getAttribute('data-anchor-kind'), 'dom', 'and must anchor to the ELEMENT, not to the whole block');
  assert.ok(form.getAttribute('data-anchor-ref'), 'with a real ref minted from the clicked element');
  const target = document.getElementById('comment-target-' + blockId);
  assert.match(target.textContent, /Toggle theme/,
    'and must name what was clicked, from the text the stage reported');
});

check('criterion 5: the pin is drawn over the right element after a re-render, not at the layer\'s fallback corner', () => {
  const { document, frame, blockId } = openPageBoard();
  enableCommentMode(document);

  const el = frame.contentDocument.getElementById('theme');
  el.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'this control needs a label';
  // Submitting queues the comment and calls refreshPins(document), which re-asks
  // every wired stage for fresh positions -- the "after a re-render" half.
  form.dispatchEvent(new StandInEvent('submit'));

  const layer = document.querySelector('.stage-wrap .pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, 'a queued comment on a page board gets its pin immediately, exactly as one on an ordinary board does');

  // Recomputed independently, the way the stage agent itself does it
  // (element box minus body box, both from test/dom-stand-in.mjs's deterministic
  // per-element boxes) -- so this asserts the pin is over the ELEMENT that was
  // clicked, not merely that some pin exists somewhere.
  const bodyBox = frame.contentDocument.body.getBoundingClientRect();
  const elBox = el.getBoundingClientRect();
  const expected = { left: (elBox.left - bodyBox.left) + 'px', top: (elBox.top - bodyBox.top) + 'px' };
  assert.deepEqual({ left: pins[0].style.left, top: pins[0].style.top }, expected,
    'the pin must land on the element the comment names');
  assert.notDeepEqual({ left: pins[0].style.left, top: pins[0].style.top }, { left: '10px', top: '10px' },
    'and never at the stacked-fallback corner, which is what "the stage answered nothing" looks like');
});

// =================================================================================
// Criterion 2, live: the frame's height never changes while it is read.
// =================================================================================

check('criterion 2: a page board\'s frame never takes an inline height from a report -- not the artifact\'s own, and not a forged one', () => {
  // A stage that measures itself against the viewport reports a huge height, and
  // stageAgentScript has no way to know which kind of card it is in (its own
  // comment) -- so every stage sends this message and the parent decides. A page
  // board's frame is a constant 100vh (ADR.md entry 34); a report that moved it
  // would reflow a long artifact under the reader mid-read.
  const { frame } = openPageBoard();
  assert.ok(!frame.style.height, 'setup: nothing has set a height yet');

  // Forged from the stage's own window, which is the only thing the parent's
  // listener trusts (origin 'null' + event.source identity) -- i.e. exactly what
  // a hostile or merely enthusiastic artifact can send.
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'height', height: 4000 }, '*');
  assert.ok(!frame.style.height, 'a page board\'s frame must never be resized by a height report');
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'height', height: 120 }, '*');
  assert.ok(!frame.style.height, 'including a SHORT one -- a collapsed report must not shrink a viewport-sized page either');
});

// =================================================================================
// SPEC_HEADER.md, criteria 1-6: the board clears its own chrome band, the artifact
// does not (ADR.md entry 59). src/ui.mjs's reportStageBand measures the header's
// band at rest and the round pager dock's band, and posts them to the CURRENT
// page board's stage over the same channel 'mode'/'scroll'/'height' already use;
// src/render.mjs's stageAgentScript tops its own body padding up to whichever is
// larger of that report and whatever the artifact's own markup already gave it.
//
// Numbered distinctly from this file's own "criterion 2"/"criterion 3"/etc. above
// -- those are SPEC_AWAITED.md's numbering; every check below is prefixed
// "SPEC_HEADER.md criterion N" to keep the two specs' numbers from colliding.
//
// What no check here can prove: the artifact's OWN declared padding, read via
// applyBand's `getComputedStyle(document.body)` (src/render.mjs). test/dom-stand-in.mjs
// has no box model or cascade engine for an arbitrary document (QUIRKS.md "The
// stand-in has no layout"), and stageAgentScript reads that API as a bare,
// unqualified identifier -- exactly like every other real-layout read in this
// codebase (measurePillHalf's own `getComputedStyle`, reportHeightAfterLayout's
// `requestAnimationFrame`) -- which Node's own global scope never defines, so the
// baseline-capture branch never runs here and the artifact's own baseline is
// always 0 in this suite, same as it would genuinely be for an artifact that
// really pads nothing. What every check below CAN and does prove: the band is
// applied as padding and nothing else (criterion 4), a fresh artifact gets
// exactly the reported band (criterion 1, the same scenario the stand-in's
// baseline-of-0 happens to model correctly), the bottom band clears the dock
// (criterion 3), a repeated report never stacks a second band on top of the
// first (the half of criterion 2 that does not depend on cascade CSS), and a
// resize re-measures and re-sends (criterion 5).

const stageBody = (frame) => frame.contentDocument.body;

check('SPEC_HEADER.md criterion 1: a page board whose artifact pads nothing is topped up to exactly the header\'s own band, so its first element renders in full at scroll top', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  const expectedTop = head.getBoundingClientRect().height;
  assert.ok(expectedTop > 0, 'setup: the header must measure to something real');
  assert.equal(stageBody(frame).style.paddingTop, expectedTop + 'px',
    'an artifact with no padding of its own must be topped up to exactly the header\'s own band -- never left at zero');
});

check('SPEC_HEADER.md criterion 3: the bottom edge is topped up to clear the round pager dock, with its own breathing room beyond the bare dock height', () => {
  const { document, frame } = openPageBoard();
  const dock = document.querySelector('.round-pager-dock');
  const dockHeight = dock.getBoundingClientRect().height;
  assert.ok(dockHeight > 0, 'setup: the dock must measure to something real');
  const appliedBottom = parseFloat(stageBody(frame).style.paddingBottom);
  assert.ok(appliedBottom > dockHeight,
    'the bottom band must clear more than the bare dock -- .page-comments\' own bottom offset (--space-4 + dock + --space-3, src/styles.mjs) is the same reservation this reuses, and both extra terms are positive');

  // The dock's real height passes straight through, 1:1 -- proof the bottom
  // band is genuinely MEASURED, not a number picked to fit today's dock.
  dock.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: dockHeight + 40 });
  document.defaultView.dispatchEvent(new StandInEvent('resize'));
  const appliedBottom2 = parseFloat(stageBody(frame).style.paddingBottom);
  assert.equal(appliedBottom2 - appliedBottom, 40,
    'a dock that grows 40px taller must grow the bottom band by exactly 40px -- the extra clearance beyond the dock is a constant, not a second measurement that also moved');
});

check('SPEC_HEADER.md criterion 3 (the comment rail): a rail carrying chrome is cleared on top of the dock, not merely the gap the dock alone leaves', () => {
  // openPageBoard's default fixture is awaited (SPEC_AWAITED.md ticket 03: a
  // send control at every comment count), so '.page-comments' carries real
  // chrome -- a '.page-send-bar' -- from the very first paint, with zero
  // comments queued. '.page-comments' is 'position: fixed' with its own
  // 'max-height' (src/styles.mjs), floating ABOVE the dock's own offset --
  // the dock-only figure clears the GAP below the rail, never the rail
  // itself, so an artifact's last element sits under the rail whenever the
  // rail holds anything at all.
  const { document, frame } = openPageBoard();
  const dock = document.querySelector('.round-pager-dock');
  const rail = document.querySelector('.round-current .page-comments');
  assert.ok(rail, 'setup: the page board must render its comment rail');
  assert.ok(rail.querySelector('.page-send-bar'),
    'setup: an awaited page board\'s rail carries a send control at every comment count (SPEC_AWAITED.md ticket 03), so it has real chrome from the first paint');

  // The same fallback space4/space3 this whole section's other checks rely on
  // (this suite's bare, unqualified `getComputedStyle` is never a function in
  // Node -- see this section's own header comment -- so src/ui.mjs's
  // reportStageBand always falls back to SPACE_4_FALLBACK/SPACE_3_FALLBACK here).
  const dockOnlyBand = dock.getBoundingClientRect().height + SPACE_4_FALLBACK + SPACE_3_FALLBACK;
  const railHeight = rail.getBoundingClientRect().height;
  assert.ok(railHeight > 0, 'setup: the rail must measure to something real');
  const appliedBottom = parseFloat(stageBody(frame).style.paddingBottom);
  assert.equal(appliedBottom, dockOnlyBand + railHeight,
    'the bottom band must clear the rail\'s own height ON TOP OF the dock\'s clearance -- clearing only the dock leaves the rail itself floating over the artifact');
});

check('SPEC_HEADER.md criterion 3 (the comment rail): a rail carrying nothing adds no extra clearance -- only the dock\'s own applies', () => {
  // The "never awaited" branch of renderPageCommentPanel (src/render.mjs):
  // no compose form, no hint, no send control, and an empty comment-list --
  // '.page-comments' is still emitted (so a later push can still find it) but
  // matches none of '.comment-form.open' / '.comment-item' / '.page-send-bar',
  // the same three the stylesheet's own ':has()' rule gates its chrome on.
  const { document, frame } = openPageBoard(nonAwaitedPageBoard());
  const dock = document.querySelector('.round-pager-dock');
  const rail = document.querySelector('.round-current .page-comments');
  assert.ok(rail, 'setup: the wrapper div is still rendered');
  assert.equal(rail.querySelector('.comment-form.open, .comment-item, .page-send-bar'), null,
    'setup: a page board nobody is waiting on, with nothing queued, renders a rail with no chrome-triggering child');

  const dockOnlyBand = dock.getBoundingClientRect().height + SPACE_4_FALLBACK + SPACE_3_FALLBACK;
  const appliedBottom = parseFloat(stageBody(frame).style.paddingBottom);
  assert.equal(appliedBottom, dockOnlyBand,
    'a rail carrying nothing must not widen the bottom band -- only the dock\'s own clearance applies, exactly as before the rail was ever considered');
});

check('SPEC_HEADER.md criterion 4: the clearance is padding only -- no background, colour or border ever reaches the stage from the board', () => {
  const { frame } = openPageBoard();
  const body = stageBody(frame);
  assert.ok(body.style.paddingTop, 'setup: the band mechanism did run');
  // The stand-in's inline style is a plain object (test/dom-stand-in.mjs
  // makeStyle): a property nothing ever wrote reads back `undefined`, not a
  // real CSSStyleDeclaration's `''` -- `!x` covers both spellings of "unset".
  assert.ok(!body.style.background, 'the board must never paint the stage\'s own body');
  assert.ok(!body.style.backgroundColor, 'the board must never paint the stage\'s own body');
  assert.ok(!body.style.border, 'nor draw a border into it');
  assert.ok(!body.style.borderTop, 'nor draw a border into it');
  assert.ok(!body.style.color, 'nor set a text colour');
  // Structural, not just behavioural: applyBand (src/render.mjs) must have no
  // OTHER style write in it at all, or a future edit could add one this
  // fixture's plain artifact would never exercise.
  const script = stageAgentScript();
  const applyBandBody = script.slice(script.indexOf('function applyBand'), script.indexOf('function applyBand') + 900);
  assert.doesNotMatch(applyBandBody, /\.style\.(background|border|color)/,
    'applyBand must only ever write paddingTop/paddingBottom -- any other style property is exactly the wash entry 40 already ruled out');
});

check('SPEC_HEADER.md criterion 2: a repeated band report never stacks a second band on top of the first', () => {
  const { frame } = openPageBoard();
  const body = stageBody(frame);
  const before = body.style.paddingTop;
  assert.ok(parseFloat(before) > 0, 'setup: a band was already applied');

  // The identical report again -- the shape a resize that measured no real
  // change would produce. Forged directly on the stage's own window, the same
  // idiom every other inbound-channel check in this file already uses.
  frame.contentWindow.postMessage({ cb: 'cb-stage', type: 'band', top: parseFloat(before), bottom: parseFloat(body.style.paddingBottom) });
  assert.equal(body.style.paddingTop, before,
    'a second report at the same height must leave the padding exactly where it was, not add a second band on top');

  // And a SMALLER report tops down to the new, smaller value -- proving the
  // mechanism recomputes max(baseline, band) fresh every time rather than
  // ratcheting up against whatever it last applied (which is what "add"
  // instead of "top-up" would look like from the outside).
  frame.contentWindow.postMessage({ cb: 'cb-stage', type: 'band', top: 1, bottom: 1 });
  assert.equal(body.style.paddingTop, '1px',
    'the baseline in this suite is always 0 (see this section\'s own header comment), so a smaller report must be honoured, not floored at the earlier, larger one');
});

check('SPEC_HEADER.md criterion 5: resizing the viewport re-measures the header and the artifact\'s clearance follows it, up or down', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');

  head.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 40 });
  document.defaultView.dispatchEvent(new StandInEvent('resize'));
  assert.equal(stageBody(frame).style.paddingTop, '40px',
    'a resize that leaves the header shorter must shrink the artifact\'s own clearance to match');

  head.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 130 });
  document.defaultView.dispatchEvent(new StandInEvent('resize'));
  assert.equal(stageBody(frame).style.paddingTop, '130px',
    'and a resize that grows it (a title wrapping to two lines) must grow the clearance to match');
});

check('the top band is measured only while the header is genuinely at rest -- a header shortened by scrolling, not by a real resize, must never shrink the artifact\'s clearance mid-read', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  const restBand = stageBody(frame).style.paddingTop;

  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup: the header is condensed');
  // The condensed header's own box is shorter than its resting one (the pill
  // is smaller than the expanded wash) -- exactly the height a naive
  // ResizeObserver-on-the-header would see and wrongly report as a resize.
  head.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 20 });
  document.defaultView.dispatchEvent(new StandInEvent('resize'));
  assert.equal(stageBody(frame).style.paddingTop, restBand,
    'the artifact\'s clearance must not follow a height change caused by condensing -- ADR.md entry 40 chose an overlay specifically so nothing reflows mid-scroll, and a shrinking padding here would be exactly that');
});

check('SPEC_HEADER.md criteria 1 and 5: a genuine resize taken WHILE condensed still re-measures the header once the reader returns to rest', () => {
  // The gate the check just above this one pins ("skip the header's box while
  // condensed") is correct and stays -- src/styles.mjs really does shrink
  // '.board-head''s own box as it condenses, so measuring mid-scroll would
  // pull the padding out from under the reader. What that gate does NOT do on
  // its own is THAW: nothing re-measures on the way back to rest, so a real
  // viewport resize taken while scrolled (the header's own rest height
  // genuinely changing underneath the skip) left the artifact padded for a
  // stale number for the rest of the session -- reproduced directly: 76px at
  // rest, scroll away, the header's rest height becomes 100px (unmeasured,
  // by the gate above's own design), scroll back to the top, and the stage
  // stayed padded for the stale 76 with nothing to ever correct it. Fixed by
  // applyStageProgress (src/ui.mjs) calling reportStageBand exactly on the
  // 'stage-scrolled' present -> absent edge -- the one place that knows the
  // transition happened at all.
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  const restBand = stageBody(frame).style.paddingTop;

  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup: the header is condensed');

  // No resize event is dispatched here on purpose -- a real viewport resize
  // taken while scrolled changes the header's box without the DOM stand-in
  // (or a real browser) ever telling this code apart from condensing itself,
  // which is exactly the case the gate above has to stay blind to. The stale
  // value has to be corrected on the scroll transition, not on a resize this
  // code cannot trust while condensed.
  head.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 100 });
  assert.equal(stageBody(frame).style.paddingTop, restBand, 'setup: still stale while condensed, same as the check above');

  reportScroll(frame, 0);
  assert.equal(condensed(document), false, 'setup: back at rest');
  assert.equal(stageBody(frame).style.paddingTop, '100px',
    'returning to rest must re-measure the header and thaw the artifact\'s clearance -- staying at the stale pre-scroll value is 24px of the artifact\'s own first element left under the header, for the rest of the session');
});

check('SPEC_HEADER.md criterion 5: the band is re-sent when a round is flipped to, so a page board arrived at over the pager is topped up too', () => {
  // Round 2, not round 1, renders '.round-current' at hydrate (renderRoundSection:
  // "const current = lastRound.n === roundN") -- so the page board has to be round
  // 1 here for "not current yet" to be the genuine starting state this checks.
  const board = createBoard({
    title: 'two rounds',
    blocks: [{ kind: 'html', html: ARTIFACT }],
  });
  addRound(board, { blocks: [{ kind: 'markdown', text: 'round two' }] });
  const document = loadBoard(renderBoardPage(board));
  const frame1 = document.querySelector('.round[data-round="1"] .html-stage');
  assert.ok(frame1, 'setup: round 1 must render its own stage');
  frame1.loadSrcdoc();
  assert.equal(document.body.classList.contains('page-board'), false, 'setup: round 2 (markdown) is current at hydrate, not the page board');
  assert.equal(stageBody(frame1).style.paddingTop, undefined,
    'setup: a round that is not current yet gets no band -- reportStageBand only ever targets .round-current');

  const head = document.querySelector('.board-head');
  const expectedTop = head.getBoundingClientRect().height;
  document.querySelector('button#round-prev').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: round 1 is now current, and it is a page board');
  assert.equal(stageBody(frame1).style.paddingTop, expectedTop + 'px',
    'flipping to a page board round must top its stage up immediately, not wait for a resize or a scroll');
});

// =================================================================================
// Criterion 11 and its seam: no way to send, and what happens when a round lands.
// =================================================================================
check('criterion 11: a page board hydrates with nothing to send -- no open question, no count, and the pill never turns itself on', () => {
  const { document } = openPageBoard();
  assert.equal(document.querySelectorAll('.round-open .question-block').length, 0,
    'there is nothing on a page board to answer');
  const pill = document.getElementById('questions-left-pill');
  assert.equal(pill.classList.contains('visible'), false,
    'and the live count (src/ui.mjs\'s updateQuestionsLeftPill, which runs at hydrate) must leave the pill off');
});

check('criterion 11: Cmd+Enter on a page board posts nothing -- the keyboard path to Send is closed too, not just the visible one', () => {
  // The hole this pins: the send bar is CSS-hidden on a page board, never
  // dropped (renderBoardPage's own comment says why -- a queued comment needs it
  // when a later round turns this into an ordinary board). Hiding a control does
  // not disable it, and the document-level chord handler gates on
  // `sendBtn.disabled` and nothing else -- so on a page board, where a round IS
  // open and there are no question blocks to traverse, one Cmd+Enter fell
  // straight through to submitBoard('send'): the round closed and every queued
  // comment flushed into a submit no agent is waiting on, which is exactly what
  // ADR.md entry 35 exists to prevent. QUIRKS.md's "Readonly is locked twice"
  // records the same shape for body.readonly: CSS and JS are not the same gate.
  const { document } = openPageBoard();
  const sendBtn = document.querySelector('button#send-btn');
  assert.ok(sendBtn, 'setup: the send bar is still in the markup on a page board -- that is the point of this check');
  assert.equal(sendBtn.disabled, true,
    'a page board is not sendable, so Send must be genuinely disabled and not merely painted out of the way');

  const calls = withFetchCapture(() => {
    document.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true }));
    document.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', ctrlKey: true }));
  });
  assert.deepEqual(calls, [], 'Cmd/Ctrl+Enter on a page board must post nothing at all');

  // And a click on the (hidden, disabled) button is inert for the same reason --
  // the stand-in does not model a browser's native click suppression on a
  // disabled element (QUIRKS.md), so this is asserted through the same fetch
  // capture rather than trusted to the attribute.
  const clicked = withFetchCapture(() => sendBtn.dispatchEvent(new StandInEvent('click')));
  assert.deepEqual(clicked, [], 'and neither must a forced press on it');
});

check('criterion 11: the refusal is a property of the PAGE, so flipping to a question round hands Send back', () => {
  // The guard belongs in setSendBarEnabled rather than in the chord handler
  // precisely so it cannot be routed around -- and it must be exactly as narrow:
  // a thread whose first round is an artifact and whose second asks something
  // has one page of each (ADR.md entry 42), and only the artifact page refuses.
  const board = pageBoard();
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'question', prompt: 'Anything to change?', widget: 'text' }] });
  const document = loadBoard(renderBoardPage(board));

  // A board opens on its newest round (entry 42), which here is the question.
  assert.equal(document.body.classList.contains('page-board'), false, 'setup: the newest page is the question round');
  assert.equal(document.querySelector('button#send-btn').disabled, false, 'a question page carries a live Send');

  // Flip back to the artifact page: the same Send goes dead again.
  document.dispatchEvent(new StandInEvent('keydown', { key: 'ArrowLeft' }));
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: flipped back to the artifact page');
  assert.equal(document.querySelector('button#send-btn').disabled, true,
    'the artifact page is not sendable, whichever page the reviewer arrived from');
  const calls = withFetchCapture(() => document.dispatchEvent(new StandInEvent('keydown', { key: 'Enter', metaKey: true })));
  assert.deepEqual(calls, [], 'and the chord posts nothing there either');
});

// =================================================================================
// The live push and the page it would reload as have to be the same markup.
// =================================================================================

check('an amend push of a page-board block renders it as a PAGE, byte-identical to what a reload of the same board renders', () => {
  // src/server.mjs's buildRoundPushPayload derives `fullpage` for the
  // 'new-round' branch by going through renderRoundSection, which computes it
  // itself -- but the amend branch renders bare blocks with no round wrapper, so
  // it has to derive it too. Passing nothing meant `false`: the pushed fragment
  // came back as an ORDINARY stage, and applyRoundPush replaces the block
  // outright, so a page board picked up a kicker and an expand control over its
  // 100vh frame (criteria 1 and 25) and lost `.page-comments`, dropping the
  // comment form below the fold of a page that cannot scroll (criterion 5).
  // Nothing repaired it short of a reload -- and the reload rendered something
  // different, which is exactly what that function's contract forbids.
  const board = pageBoard();
  const blockId = board.blocks[0].id;
  const payload = buildRoundPushPayload(board, 1, 'amend', [blockId]);

  const reloaded = renderRoundSection(board, 1, groupCommentsByBlock([]));
  // The block's own section out of each, so the round wrapper renderRoundSection
  // adds around it is not what this compares. An html block section nests no
  // other <section>, so its first closing tag is its own.
  const section = (html) => {
    const start = html.indexOf('<section class="block html-block"');
    assert.notEqual(start, -1, 'setup failure: no html block section in this markup');
    const end = html.indexOf('</section>', start);
    assert.notEqual(end, -1, 'setup failure: unclosed block section');
    return html.slice(start, end + '</section>'.length);
  };
  assert.equal(section(payload.html).trim(), section(reloaded).trim(),
    'the amend fragment and the reload must be the same block markup -- one board cannot render two ways');

  assert.ok(!payload.html.includes('block-kicker'), 'no kicker over a full-viewport artifact');
  assert.ok(!payload.html.includes('expand-btn'), 'and no expand control (ADR.md entry 43)');
  assert.ok(payload.html.includes('page-comments'), 'and the comment surface still floats over the frame');

  // And the same call for an ORDINARY board's stage is untouched: this derives
  // the layout from the round's own shape, it does not impose one.
  const ordinary = createBoard({
    title: 'artifact + note',
    blocks: [{ kind: 'html', html: ARTIFACT }, { kind: 'markdown', text: 'a stats line' }],
  });
  const ordinaryPush = buildRoundPushPayload(ordinary, 1, 'amend', [ordinary.blocks[0].id]);
  assert.ok(ordinaryPush.html.includes('block-kicker'), 'an ordinary stage keeps its kicker on the same path');
  assert.ok(ordinaryPush.html.includes('expand-btn'), 'and its lens control');
});

check('the seam for ticket 05: a round arriving over SSE ends the page-board layout in place, and the comment queued on the artifact survives to ride it', () => {
  const board = pageBoard();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: this page is laid out as a page board');

  // The reviewer leaves a comment on the artifact first -- ADR.md entry 35's
  // whole scenario: `ask` returned the instant the artifact landed, so this
  // comment has nowhere to go until a round asks something.
  enableCommentMode(document);
  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + board.blocks[0].id);
  form.querySelector('input[type=text]').value = 'this control needs a label';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup: the comment is queued');

  // Then the agent posts a round that asks something. Same payload shape
  // src/server.mjs's buildRoundPushPayload sends (test/check-round-end.mjs's own
  // construction), rendered through the ordinary, non-fullpage path -- which is
  // what the server always sends.
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'question', prompt: 'Anything to change?', widget: 'text' }] });
  es.dispatch('round', JSON.stringify({
    round: 2, mode: 'new-round', blockIds: [],
    html: renderRoundSection(board, 2, groupCommentsByBlock([])),
    board: { ...board, comments: [] },
  }));

  assert.equal(document.body.classList.contains('page-board'), false,
    'a board holding a question is not a page board, so the layout that made the artifact fill the viewport -- and hid the send bar under it -- must go, or the round below a 100vh frame is unreachable on a page that cannot scroll');
  assert.ok(document.querySelector('.round[data-round="2"] .question-block'), 'the round itself must have landed');
  assert.equal(document.querySelector('button#send-btn').disabled, false,
    'and the send bar must be live again -- it was only ever CSS-hidden, never dropped, precisely so a queued comment has a way out');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1,
    'the comment queued on the artifact must still be queued -- it rides this round\'s submit (ADR.md entry 35), so nothing here may throw it away');
});

// =================================================================================
// SPEC_AWAITED.md ticket 03: the page board's two states.
// =================================================================================
//
// Everything above this line predates *awaited* (ADR.md entries 45-49) and now
// runs against an AWAITED page board by default (pageBoard()'s own header
// comment says why). What follows is what ticket 03 itself adds: the send
// control inside the comment panel (AC 4), the click-to-comment hint (AC 5),
// the header pill's countdown/read-only slot (AC 6, AC 8, AC 11), and the
// live SSE-driven revert when a wait dies (AC 12).

/** Click `el` (comment mode already on), fill the opened form with `text`, and
 * submit it -- the same three-step gesture test/check-click-pin.mjs already
 * drives, factored out here because this section queues several comments in a
 * row. */
function queueComment(document, el, blockId, text) {
  el.dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: the click did not open the comment form');
  form.querySelector('input[type=text]').value = text;
  form.dispatchEvent(new StandInEvent('submit'));
}

const pageSendBtn = document => document.querySelector('.page-send-btn');
const pageDiscussBtn = document => document.querySelector('.page-discuss-btn');
const pageCommentHint = document => document.querySelector('.page-comment-hint');
const roundMeta = document => document.querySelector('span#round-meta');

// =================================================================================
// AC 4: one send control at every comment count, labelled for what it sends,
// Discuss beside it.
// =================================================================================

check('AC 4: an awaited page board carries exactly one send control, labelled "Nothing to add" at zero comments, with Discuss beside it', () => {
  const { document } = openPageBoard();
  const sendBtn = pageSendBtn(document);
  const discussBtn = pageDiscussBtn(document);
  assert.equal(document.querySelectorAll('.page-send-btn').length, 1, 'exactly one send control, not zero and not two');
  assert.ok(sendBtn, 'setup failure: no .page-send-btn rendered on an open, awaited page round');
  assert.ok(discussBtn, 'Discuss must sit beside it');
  assert.equal(sendBtn.textContent, 'Nothing to add', 'zero comments: the control names what it will send, which is nothing');
  assert.equal(sendBtn.disabled, false, 'still a real, clickable control -- "nothing to add" is a label, not a disabled state');
  assert.equal(sendBtn.getAttribute('data-round'), '1', 'the control names its OWN round, not "whichever is latest"');
  assert.equal(discussBtn.getAttribute('data-round'), '1');
});

check('AC 4: the label counts up as comments are queued, singular at one, plural above it, and stays the one control throughout', () => {
  const { document, frame, blockId } = openPageBoard();
  enableCommentMode(document);
  const button = frame.contentDocument.getElementById('theme');

  queueComment(document, button, blockId, 'first remark');
  assert.equal(document.querySelectorAll('.page-send-btn').length, 1, 'still exactly one control after the first comment');
  assert.equal(pageSendBtn(document).textContent, 'Send 1 comment', 'singular at exactly one');

  // Reopen the same element to queue a second, independent remark -- the same
  // "several separate remarks share one block anchor" shape commentButton's own
  // comment (src/render.mjs) describes for a whole-block comment.
  queueComment(document, button, blockId, 'second remark');
  assert.equal(document.querySelectorAll('.page-send-btn').length, 1, 'still exactly one control after a second comment');
  assert.equal(pageSendBtn(document).textContent, 'Send 2 comments', 'plural above one');
});

// =================================================================================
// AC 5: opens with comment mode on, and the empty panel teaches the gesture.
// =================================================================================

check('AC 5: an awaited page board opens with comment mode already on, and its empty panel carries a hint line teaching the click-to-comment gesture', () => {
  const { document } = openPageBoard();
  const toggle = document.getElementById('comment-mode-toggle');
  assert.equal(toggle.classList.contains('active'), true, 'comment mode must already be on at hydrate, with no click needed');
  assert.equal(document.body.classList.contains('comment-mode'), true);
  const hint = pageCommentHint(document);
  assert.ok(hint, 'the empty panel must carry a hint element');
  assert.match(hint.textContent, /click/i, 'the hint must teach the click-to-comment gesture in words');
  assert.notEqual(hint.style.display, 'none', 'and it must actually be visible, not merely present in the markup');
});

check('AC 5: the hint disappears once a comment is queued, and would come back if the queue emptied out again', () => {
  const { document, frame, blockId } = openPageBoard();
  assert.notEqual(pageCommentHint(document).style.display, 'none', 'setup: the hint starts visible');
  const button = frame.contentDocument.getElementById('theme');
  queueComment(document, button, blockId, 'a remark');
  assert.equal(pageCommentHint(document).style.display, 'none', 'the hint must step aside once there is something to show instead');

  // Delete the just-queued comment back to zero -- updatePageSendControls
  // (src/ui.mjs) runs off the same refreshPins call a delete goes through.
  const del = document.querySelector('.comment-item.comment-pending .comment-delete');
  assert.ok(del, 'setup failure: the queued comment has no delete control');
  del.dispatchEvent(new StandInEvent('click'));
  assert.equal(pageSendBtn(document).textContent, 'Nothing to add', 'setup: back to zero comments');
  assert.notEqual(pageCommentHint(document).style.display, 'none', 'and the hint returns once the panel is empty again');
});

// =================================================================================
// AC 6: the header pill carries the round's countdown, explained on hover, in
// both the expanded header and the condensed pill.
// =================================================================================

check('AC 6: the header pill carries the round\'s countdown as a muted figure, with a hover title explaining it, in both the expanded header and the condensed pill', () => {
  const board = createBoard({
    title: 'countdown',
    blocks: [{ kind: 'html', html: ARTIFACT }],
    wait: true,
    awaitTimeoutMs: 38 * 60_000,
  });
  const { document, frame } = openPageBoard(board);
  const meta = roundMeta(document);
  assert.ok(meta, 'setup failure: no #round-meta rendered');
  assert.match(meta.textContent, /^(37|38)m left$/, `expected a minutes-left figure close to 38, got ${JSON.stringify(meta.textContent)}`);
  assert.ok(meta.title && meta.title.length > 0, 'the figure must carry an explanatory hover title');
  assert.notEqual(meta.title, meta.textContent, 'the title must EXPLAIN the figure, not just repeat it');

  // Expanded: computed through the real cascade, same idiom every other
  // criterion-16 check in this file already uses.
  assert.notEqual(computed(meta, 'display'), 'none', 'the pill slot must be visible while the header is expanded');

  reportScroll(frame, 800);
  assert.equal(condensed(document), true, 'setup: the header is condensed');
  assert.notEqual(computed(meta, 'display'), 'none', 'and still visible once the header condenses into the pill -- AC 6\'s "in both" states');
  assert.equal(meta.textContent, roundMeta(document).textContent, 'condensing must not have touched the pill\'s own text -- it is the same element, not a second copy');
});

// =================================================================================
// AC 8: a non-awaited page offers no comment control and no click-to-anchor
// gesture at all, and the pill slot reads "read-only".
// =================================================================================

check('AC 8: a page board nobody is waiting on offers no comment control at all, and the pill\'s slot reads "read-only"', () => {
  const board = nonAwaitedPageBoard();
  assert.equal(board.rounds[0].awaited, false, 'setup: posted without wait: true');
  const document = loadBoard(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();

  assert.equal(document.querySelector('.comment-form'), null, 'no compose form anywhere for this block');
  assert.equal(document.querySelector('.page-send-bar'), null, 'no send control');
  assert.equal(document.querySelector('.page-comment-hint'), null, 'no hint -- there is nothing to teach the gesture for');
  // The comment-list div itself may still render (empty) -- see
  // renderPageCommentPanel's own comment on why -- but it must carry nothing.
  assert.equal(document.querySelectorAll('.comment-item').length, 0);

  const meta = roundMeta(document);
  assert.ok(meta, 'setup failure: no #round-meta rendered');
  assert.equal(meta.textContent, 'read-only');
  assert.ok(meta.title && meta.title.length > 0, 'the fallback text still carries an explanatory title');

  // The click-to-anchor gesture itself. The toggle is hidden here now (ADR 46,
  // asserted on its own below) but hiding is structural, not omission -- the
  // element is still in the markup, so this drives it directly: even forced on,
  // it must not make the stage anchorable. Belt and braces, the same "locked
  // twice" discipline QUIRKS.md states for every other read-only surface.
  const toggle = document.getElementById('comment-mode-toggle');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup: comment mode is on');
  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelectorAll('.comment-form.open').length, 0, 'no form may open anywhere -- there is no comment control to open one');
});

// =================================================================================
// `wait` on a round that already asks something. Left undecided when this ticket
// landed, decided now: IGNORED, not refused. Such a round is already awaited by
// construction, so `wait: true` asks for the state it is already in -- there is
// nothing to refuse and nothing to add, and a refusal would fail a call whose
// only sin is saying out loud what the round already does. The two routes into
// `awaited` stay the two in CONTEXT.md's glossary; this check exists so a later
// change cannot quietly make `wait` a third one, in either direction.
// =================================================================================

check('`wait: true` on a round that already asks something is ignored, not refused -- the round is awaited by its question either way, and the deadline is the same either way', () => {
  const blocks = [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }];
  const withWait = createBoard({ title: 'wait on a question round', blocks, wait: true, awaitTimeoutMs: 38 * 60_000 });
  const without = createBoard({ title: 'wait on a question round', blocks, awaitTimeoutMs: 38 * 60_000 });
  assert.equal(withWait.rounds[0].awaited, true, 'a question round is awaited whether or not the caller said wait');
  assert.equal(without.rounds[0].awaited, true, 'setup: and awaited without it too -- that is the point');
  // The deadline is minted from the round's own postedAt, so two boards created
  // a tick apart differ in the instant but must not differ in the OFFSET.
  const offset = b => Date.parse(b.rounds[0].awaitDeadline) - Date.parse(b.rounds[0].postedAt);
  assert.equal(offset(withWait), offset(without),
    '`wait` must not lengthen, shorten or otherwise touch a question round\'s deadline');

  // Same answer on a later round, which mints through addRound rather than
  // createBoard -- the two call sites of mintAwait, both pinned.
  const board = createBoard({ title: 'wait on a later question round', blocks: [{ kind: 'html', html: ARTIFACT }] });
  addRound(board, { blocks, wait: true });
  assert.equal(board.rounds[1].awaited, true, 'a later question round is awaited by its question, wait or no wait');
  assert.equal(board.rounds[0].awaited, false, 'and the page round it followed is untouched -- wait was never passed to it');
});

// =================================================================================
// AC 11 (second half): every open awaited round shows the time left, on a page
// board and on an ordinary board alike; a sent/timed-out/archived round shows
// none, and a page board's pill falls back to read-only.
// =================================================================================

check('AC 11: an ordinary board\'s open, awaited round shows the countdown beside the send bar; once sent, it shows none', () => {
  const board = createBoard({
    title: 'ordinary board countdown',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  assert.equal(board.rounds[0].awaited, true, 'setup: a question round is awaited by construction (ticket 01)');
  const document = loadBoard(renderBoardPage(board));
  const cd = document.querySelector('span#round-countdown');
  assert.ok(cd, 'setup failure: no #round-countdown rendered');
  assert.equal(cd.classList.contains('visible'), true, 'an open, awaited round\'s countdown must be visible');
  assert.match(cd.textContent, /^\d+m left$/, `expected a minutes-left figure, got ${JSON.stringify(cd.textContent)}`);

  // Sent: no countdown at all, on the same board, same element.
  applySubmit(board, { action: 'send', answers: [{ id: board.blocks[0].id, status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  const sentDocument = loadBoard(renderBoardPage(board));
  const sentCd = sentDocument.querySelector('span#round-countdown');
  assert.ok(sentCd, 'setup failure: no #round-countdown rendered on the sent board');
  assert.equal(sentCd.classList.contains('visible'), false, 'a sent round must show no countdown');
  assert.equal(sentCd.textContent, '', 'and the figure itself must be empty, not stale');
});

check('AC 11: a page board\'s pill falls back to "read-only" once its round is sent, exactly like AC 8\'s never-awaited case', () => {
  const board = pageBoard();
  const document = loadBoard(renderBoardPage(board));
  assert.equal(roundMeta(document).textContent.endsWith('m left'), true, 'setup: open and awaited, so a countdown shows');

  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const sentDocument = loadBoard(renderBoardPage(board));
  assert.equal(roundMeta(sentDocument).textContent, 'read-only', 'a sent round\'s pill falls back exactly like a never-awaited one\'s');
});

// =================================================================================
// AC 12: when a wait dies while the page is open, the page is told over SSE --
// it reverts to read-only, and comments already left stay on screen.
// =================================================================================

check('AC 12: an "awaitExpired" SSE push reverts the page to read-only, leaving comments already queued on screen', () => {
  const board = pageBoard();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const blockId = board.blocks[0].id;

  // Comment mode is already on (AC 5); queue one comment before the wait dies.
  const button = frame.contentDocument.getElementById('theme');
  queueComment(document, button, blockId, 'left before the wait died');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1, 'setup: one comment queued');
  assert.equal(pageSendBtn(document).disabled, false, 'setup: the send control is still live');
  assert.equal(roundMeta(document).textContent.endsWith('m left'), true, 'setup: still showing a countdown');

  // src/ui.mjs recomputes "is this round currently awaited" from board.rounds'
  // own awaitDeadline against Date.now() -- refreshAwaitDisplay never mutates
  // board state itself (badge.mjs's own header comment on the split). So
  // reproducing "the wait actually died" here means moving the clock, not
  // just firing the event: a real server only ever broadcasts this once its
  // OWN wall clock has genuinely crossed the deadline. Patched globally and
  // restored in `finally` -- this file's own DOM stand-in has no fake timer
  // seam to reach for instead.
  const realNow = Date.now;
  let flushCalls;
  try {
    Date.now = () => realNow() + 41 * 60_000; // one minute past the 40-minute default
    // The queue's last exit before the freeze (src/ui.mjs's flushPendingOnExpiry).
    // Captured rather than allowed to hit the real global fetch: what is being
    // asserted is that the comment LEFT the tab, and the tab's own memory is the
    // only place it existed.
    flushCalls = withFetchCapture(() => es.dispatch('awaitExpired', JSON.stringify({ round: 1 })));
    assert.equal(flushCalls.length, 1, 'the queued comment must be flushed to the board on the way into the freeze, not frozen with it');
    assert.match(flushCalls[0].url, /\/submit$/);
    assert.equal(flushCalls[0].body.round, 1);
    assert.deepEqual(flushCalls[0].body.comments.map(c => c.text), ['left before the wait died'],
      'the flush carries exactly the comment that was still only in page memory');

    assert.equal(roundMeta(document).textContent, 'read-only', 'the pill must fall back the instant the push lands');
    const panel = document.querySelector('.page-comments');
    assert.equal(panel.classList.contains('expired'), true, 'the panel must be marked expired');
    assert.equal(pageSendBtn(document).disabled, true, 'the send control must be genuinely disabled, not merely hidden (QUIRKS.md "Readonly is locked twice")');
    assert.equal(pageDiscussBtn(document).disabled, true);
    assert.equal(document.querySelector('.comment-form').querySelector('input[type=text]').disabled, true);

    // The comment left before the wait died is still on screen -- AC 12's own
    // words. It is on its way to the board by now (the flush above) rather than
    // stranded in page memory, and the drain is what carries it to the next agent
    // that asks (drainUndeliveredComments, src/server.mjs, now that a lapsed round
    // stops swallowing its own comments); either way nothing is removed from the
    // panel by the freeze itself.
    assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1,
      'a comment already left must stay on screen -- AC 12\'s own words');
    assert.equal(document.querySelector('.comment-item.comment-pending').textContent.includes('left before the wait died'), true);

    // The click-to-anchor gesture itself must also be gone, not merely the
    // panel's own controls: broadcastStageMode re-tells the stage its mode the
    // moment refreshAwaitDisplay runs (src/ui.mjs).
    frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
    assert.equal(document.querySelectorAll('.comment-form.open').length, 0, 'no click may open the form once the round has reverted to read-only');
  } finally {
    Date.now = realNow;
  }

  // And the reversion is STICKY even once the clock is back to "normal": one-
  // directional by construction (a deadline never un-expires,
  // refreshAwaitDisplay's own header comment) -- a real repaint (another
  // 'awaitExpired' nudge, exactly as a second, redundant broadcast would be)
  // must not un-mark the panel just because Date.now() no longer looks
  // expired from here.
  es.dispatch('awaitExpired', JSON.stringify({ round: 1 }));
  assert.equal(document.querySelector('.page-comments').classList.contains('expired'), true,
    'the expired panel must stay expired -- a deadline crossing is one-directional');

  // Frozen, but not mute. The control that can no longer be pressed is where the
  // reviewer finds out their comments were not lost with the round.
  const frozen = pageSendBtn(document);
  assert.equal(frozen.textContent, PAGE_SEND_EXPIRED_LABEL, 'the frozen send control names where the comments went');
  assert.equal(frozen.title, PAGE_SEND_EXPIRED_TITLE);
  assert.equal(frozen.disabled, true, 'saying so is not the same as being pressable');
});

check('AC 12: a page round that expires with an EMPTY queue posts nothing at all -- the freeze is a display change, not a submit', () => {
  const board = pageBoard();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  document.querySelector('.html-stage').loadSrcdoc();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 41 * 60_000;
    const calls = withFetchCapture(() => es.dispatch('awaitExpired', JSON.stringify({ round: 1 })));
    assert.deepEqual(calls, [], 'nothing was queued, so nothing may be sent -- a page nobody wrote on must not close its own round');
  } finally {
    Date.now = realNow;
  }
  assert.equal(document.querySelector('.page-comments').classList.contains('expired'), true, 'and it still freezes');
});

check('AC 8/ADR 46: the comment-mode toggle is gone on a page board nobody is listening to, both at first paint and the moment a wait dies', () => {
  // The third of ADR 46's three things such a page must not have -- the branch
  // used to ship two: the only rule hiding the toggle was body.readonly, which a
  // LIVE non-awaited page board never carries, so the header still offered
  // "Comment mode: off" and still flipped it on over an artifact where every
  // click is swallowed.
  const never = createBoard({ title: 'not awaited', blocks: [{ kind: 'html', html: '<!doctype html><html><body><h1>NO_TOGGLE</h1></body></html>' }] });
  assert.equal(never.rounds[0].awaited, false, 'setup: posted without wait: true');
  const neverDoc = loadBoard(renderBoardPage(never));
  assert.equal(neverDoc.body.classList.contains('page-uncommentable'), true,
    'a page board nobody is listening to carries the class that hides the toggle');
  // Computed, not matched against the stylesheet source: a CSS-source assertion is
  // exactly how this branch once certified a mechanism that resolved to `auto` in a
  // real browser (QUIRKS.md). This asks what the rule actually resolves to on the
  // element, with the class in place.
  assert.equal(computed(neverDoc.getElementById('comment-mode-toggle'), 'display'), 'none',
    'and it really is hidden -- the rule must win against .mode-toggle\'s own inline-flex');

  // An awaited page board keeps the toggle while the wait is alive, and loses it
  // the moment the wait dies under the reviewer -- the clock-driven half.
  const { document, es } = loadBoardWithEventSource(renderBoardPage(pageBoard()));
  document.querySelector('.html-stage').loadSrcdoc();
  assert.equal(document.body.classList.contains('page-uncommentable'), false, 'setup: still awaited, so the toggle stays');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 41 * 60_000;
    withFetchCapture(() => es.dispatch('awaitExpired', JSON.stringify({ round: 1 })));
    assert.equal(document.body.classList.contains('page-uncommentable'), true,
      'the wait died, so the control that turns commenting on goes with it');
  } finally {
    Date.now = realNow;
  }
});

if (failures) {
  console.error(`\n${failures} page-board check(s) failed`);
  process.exit(1);
}
console.log('\nall page-board checks ok');
