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
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
// The daemon's own push builder, imported rather than re-implemented: a check
// that rebuilt the payload locally would assert its own copy of the rule and
// stay green through any change to the real one (which is how the amend path's
// missing `fullpage` survived two other push checks).
import { buildRoundPushPayload } from '../src/server.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { parseHTML, StandInEvent, StandInEventSource, resolveComputedProperty } from './dom-stand-in.mjs';

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

function pageBoard(html = ARTIFACT) {
  return createBoard({ title: 'Rendered artifact', blocks: [{ kind: 'html', html }] });
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

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
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

check('criterion 16: a scroll report condenses the header into a centred floating pill, and scrolling back up expands it again', () => {
  const { document, frame } = openPageBoard();
  const head = document.querySelector('.board-head');
  const h1 = document.querySelector('.board-head h1');
  const meta = document.querySelector('.board-head .meta');

  assert.equal(condensed(document), false, 'setup: an unscrolled artifact leaves the header expanded');
  assert.equal(computed(head, 'left'), '0', 'setup: expanded, the header spans the viewport');
  assert.equal(computed(h1, 'display'), '', 'setup: expanded, the board\'s title is on screen');

  reportScroll(frame, 800);
  assert.equal(condensed(document), true);
  // Computed through the real cascade over the real stylesheet, not by matching
  // a rule's spelling (QUIRKS.md) -- every rule here is an override of one the
  // page-board layout already set, so which one wins IS the property under test.
  assert.equal(computed(head, 'left'), '50%', 'condensed, the header is centred');
  assert.equal(computed(head, 'transform'), 'translateX(-50%)', 'and genuinely centred on its own width, not merely offset');
  assert.equal(computed(head, 'right'), 'auto', 'it must stop spanning the viewport, or "pill" is only a border-radius');
  assert.equal(computed(head, 'border-radius'), 'var(--r-pill)');
  assert.equal(computed(h1, 'display'), 'none', 'the board\'s title condenses away');
  assert.equal(computed(meta, 'display'), 'none', 'and so does the thread/id line');

  reportScroll(frame, 0);
  assert.equal(condensed(document), false, 'scrolling back to the top expands it again');
  assert.equal(computed(head, 'left'), '0');
  assert.equal(computed(h1, 'display'), '', 'the title comes back -- condensing is a state, not a deletion');
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

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'mid-read, the toggle turns comment mode on');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(document.body.classList.contains('comment-mode'), true);
  assert.equal(condensed(document), true, 'and switching mode does not un-condense the header');

  // The gesture the mode exists for still works from the condensed pill: a
  // click inside the artifact anchors a comment.
  frame.contentDocument.getElementById('theme').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelector('.comment-form').classList.contains('open'), true,
    'the mode switched from the pill is a real mode, not just a lit-up button');

  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), false, 'and off again, still without scrolling back');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(heard, [true, false],
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
    { cb: 'cb-stage', type: 'nonsense' },
  ];
  for (const data of bad) {
    stageWindow.postMessage(data);
    assert.deepEqual(scrolls, [], `a malformed parent message must never reach scrollTo: ${JSON.stringify(data)}`);
    assert.equal(root.getAttribute('data-theme'), themeBefore,
      `nor repaint the artifact: ${JSON.stringify(data)}`);
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

  // A theme change with comment mode OFF, then a mode change with a theme
  // already chosen: whichever fact moved, the stage is told BOTH, so it can
  // never be left holding a stale value of the one the caller did not care
  // about (ADR.md entry 39: one channel, one message shape).
  document.querySelector('button#theme-toggle').dispatchEvent(new StandInEvent('click'));
  document.querySelector('button#comment-mode-toggle').dispatchEvent(new StandInEvent('click'));

  assert.equal(heard.length, 2, 'both changes go over the mode message, not a second message type');
  assert.deepEqual(heard.map(m => [m.commentMode, m.theme, Array.isArray(m.sentRefs)]),
    [[false, 'light', true], [true, 'light', true]],
    'a theme change carries the current mode, and a mode change carries the current theme');
  assert.equal(stageTheme(frame).attr, 'light', 'and turning comment mode on did not repaint the artifact back to the default');
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

if (failures) {
  console.error(`\n${failures} page-board check(s) failed`);
  process.exit(1);
}
console.log('\nall page-board checks ok');
