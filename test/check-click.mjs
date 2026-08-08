// End-to-end click check: drives the REAL src/ui.mjs
// client script, in a minimal in-repo DOM stand-in (test/dom-stand-in.mjs), through
// the actual gesture a reviewer performs -- click an element inside a hand-mocked
// html stage -- and asserts a comment form opens with the anchor filled in.
//
// This check exists because "a check fails if the click path breaks end to end,
// exercising the real gesture rather than the pieces underneath it." Every check in
// test/check-pure.mjs and test/check-http.mjs passed while this gesture was dead --
// they exercise src/anchor.mjs's pure resolution logic and the rendered markup, but
// none of them ever attaches a listener to a live document and clicks it. This file
// is the first thing in the suite that does.
//
// It is written against the CURRENT, broken src/ui.mjs and is expected to fail here
// (see the second check below) -- its own credibility is established first by the
// check above it, which pins the exact browser behaviour the defect turns on (an
// iframe's about:blank placeholder document, not the real srcdoc content, being what
// is live the moment the page's own script runs). An ablation log records the
// proof that this check goes green once the gesture is fixed (temporarily
// dropping the synchronous `readyState === 'complete'` wiring call in src/ui.mjs and
// re-running this file) -- fixing it for real is a separate job, not this file's.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { resolveDomAnchor } from '../src/anchor.mjs';
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

// A real board page, rendered exactly as the daemon would serve it: one hand-mocked
// html stage, nothing else, so the only thing the DOM stand-in has to model is the
// one seam this ticket is about (see test/dom-stand-in.mjs's file comment for what
// it does and deliberately does not implement).
const board = createBoard({
  title: 'Ticket 01 -- the dead click',
  blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

/** Parse the page and run the real `ui` client script against it, exactly as a
 * browser would inline and execute it (src/render.mjs embeds this exact string in a
 * `<script type="module">`), returning the stand-in `document` for assertions. A
 * fresh document every call, so the two checks below never share mutated state. */
function loadBoard() {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' }; // not 'file:' -- this is the live, non-readonly path
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

// --- credibility: pin the one browser behaviour this check exists to reproduce --
//
// The leading
// hypothesis for the defect is an iframe's initial (about:blank) document being what
// gets wired up, instead of the real one. Before trusting the click check below,
// this pins that the stand-in actually reproduces that shape: the iframe's
// contentDocument is already present, 'complete', and empty the moment the page is
// parsed -- BEFORE the client script runs and BEFORE the real srcdoc content ever
// loads. A stand-in that instead handed the real document straight to the client
// script would make the check below pass for the wrong reason ("a stand-in that
// models the browser wrongly is exactly how this feature
// shipped dead twice").

check('a fresh .html-stage iframe starts out wired to an about:blank-shaped placeholder document, not the real srcdoc content -- the exact browser behaviour the defect turns on', () => {
  const document = parseHTML(pageHtml);
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: the rendered page has no .html-stage iframe -- fix the board/page fixture, not src/ui.mjs');
  assert.equal(frame.contentDocument.readyState, 'complete', 'about:blank must already report readyState "complete", same as a real browser, before any srcdoc navigation has happened');
  assert.ok(frame.contentDocument.body, 'the placeholder document must have a real <body>, same as a real about:blank document');
  assert.equal(frame.contentDocument.body.children.length, 0, 'the placeholder body must be empty -- it must not already contain the mocked <button>, or this stand-in is not reproducing about:blank at all');
  assert.equal(frame.getAttribute('srcdoc').includes('Send'), true, 'setup failure: the real (not-yet-loaded) srcdoc content should carry the mocked button -- fix the fixture');
});

// --- the actual gesture: click an element inside the stage, end to end ----------

check('clicking an element inside a hand-mocked html stage opens that block\'s comment form with a dom anchor filled in (ref + hint) -- the real click gesture, not the anchor logic underneath it', () => {
  const document = loadBoard();
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage iframe on the rendered page');

  // One gesture, toggle-gated
  // everywhere, means the stage click no longer fires on its own -- comment mode
  // has to be turned on first, through the actual toggle button, exactly the way
  // a reviewer would. test/check-comment-mode.mjs's own checks cover comment
  // mode OFF leaving this click inert; this file keeps proving what happens once
  // the click lands, same as before.
  const modeToggle = document.getElementById('comment-mode-toggle');
  assert.ok(modeToggle, 'setup failure: no comment-mode toggle rendered on the board page');
  modeToggle.dispatchEvent(new StandInEvent('click'));

  // The synchronous wiring pass inside wireRoot(document) has already run by the
  // time loadBoard() returns above -- against whatever frame.contentDocument WAS AT
  // THAT MOMENT, which per the credibility check above is the about:blank
  // placeholder, not the real content. Only now, mirroring a real browser's
  // asynchronous srcdoc navigation completing after the page's own script has
  // already run once, does the real document arrive and fire 'load'.
  frame.loadSrcdoc();

  const stageDoc = frame.contentDocument;
  const button = stageDoc.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage document has no <button> -- fix the fixture, not src/ui.mjs');

  // The real gesture: a bubbling click landing on an element inside the stage, with
  // a target -- not a call into any of wireHtmlStage's internals.
  button.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, 'setup failure: the board page has no comment-form for the html block');
  assert.equal(
    form.classList.contains('open'), true,
    'clicking an element inside the html stage must open that block\'s comment form -- it did not (the "open" class was never added), meaning no click listener ever fired on the REAL stage document; the click gesture is dead',
  );
  assert.equal(form.getAttribute('data-anchor-kind'), 'dom', `expected the opened form's anchor kind to be "dom", got ${JSON.stringify(form.getAttribute('data-anchor-kind'))}`);
  const ref = form.getAttribute('data-anchor-ref');
  assert.ok(ref && ref.length > 0, `expected a non-empty dom-path ref on the opened form, got ${JSON.stringify(ref)}`);
  const hint = form.getAttribute('data-anchor-label');
  assert.ok(hint && hint.length > 0, `expected a non-empty, human-readable hint on the opened form, got ${JSON.stringify(hint)}`);
  assert.equal(hint, 'Send', `expected the hint to name the clicked element's own text ("Send"), got ${JSON.stringify(hint)}`);

  const target = document.getElementById('comment-target-' + blockId);
  assert.ok(target, 'setup failure: no comment-target element for the html block');
  assert.equal(target.classList.contains('open'), true, 'the "commenting on:" label must also be shown once the click has anchored a comment');
  assert.equal(target.textContent, 'commenting on: Send', `expected the "commenting on:" label to name what was clicked, got ${JSON.stringify(target.textContent)}`);
});

// --- a mock that inlines its own <style> ------------------
//
// A hand-mocked stage carrying its own styling is the ordinary case -- it is
// what the isolation model makes an author do, since the
// page's tokens deliberately never reach into the sandboxed srcdoc. A real
// browser hoists that leading <style> into <head>, so `document.body`'s first
// child is the mock's own top-level element, not the style tag. This check
// proves BOTH halves of the fix agree, not just one in isolation: the stand-in
// mints the ref the same way a real browser's `frame.contentDocument.body`
// would (test/dom-stand-in.mjs's parseHTML, sharing HEAD_ONLY_TAGS with
// src/anchor.mjs), and the server-side resolver (src/anchor.mjs's
// resolveDomAnchor) accepts exactly that ref -- if either side hoisted and the
// other didn't, this would fail even though each side's own unit checks (this
// file's fixture-free ones, test/check-pure.mjs's) could still pass alone.
const styledBoard = createBoard({
  title: 'Ticket 08 -- a mock that styles itself',
  blocks: [{ kind: 'html', html: '<style>.mock{font:14px system-ui}</style><div class="mock"><button>Send</button></div>' }],
});
const styledBlockId = styledBoard.blocks[0].id;
const styledPageHtml = renderBoardPage(styledBoard);

check('C2: clicking an element in a mock whose srcdoc opens with its own <style> mints a ref the server actually resolves, not an off-by-one', () => {
  const document = parseHTML(styledPageHtml);
  // A real, working `window` here, not a
  // throwaway `{ addEventListener() {} }` stub -- src/ui.mjs's own
  // `window.addEventListener('message', ...)` (the parent's half of the
  // postMessage protocol the html-stage click now goes over) has to reach a
  // window the stage can actually deliver to, which `document.defaultView`
  // (auto-wired by parseHTML) is and a no-op stub is not. Every other check in
  // this suite already made this switch; this one is new, and
  // needs the same fix.
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);

  document.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();

  // Every html-stage srcdoc now carries a trailing, injected
  // `<script>` (the stage-side agent -- src/render.mjs's `stageAgentScript`,
  // appended AFTER the mock's own markup, never before it -- see that
  // function's own comment on why). A real browser hoists only a LEADING run
  // of head-only elements (HEAD_ONLY_TAGS) into `<head>`; a `<script>` that
  // comes after the mock's own body content is an ordinary, un-hoisted body
  // child, exactly like any script tag placed at the end of a real page's
  // `<body>`. So `document.body` now has TWO children -- the mock's own div,
  // still first, and the agent script, after it -- not one; the div staying
  // FIRST is what keeps the minted ref (`1.1`, asserted below) unchanged by
  // the agent script's presence.
  assert.equal(frame.contentDocument.body.children.length, 2,
    'setup failure: the stand-in must hoist the leading <style> out of body (same as a real browser) while leaving the mock div and the trailing injected stage-agent <script> as body\'s two ordinary children');
  assert.equal(frame.contentDocument.body.children[0].tagName, 'DIV', 'the mock\'s own div must still be body\'s FIRST child');
  const button = frame.contentDocument.querySelector('button');
  button.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + styledBlockId);
  const ref = form.getAttribute('data-anchor-ref');
  const hint = form.getAttribute('data-anchor-label');
  assert.equal(ref, '1.1', `the mock div is body's only child and the button is its only child, so the browser-minted ref must be "1.1", got ${JSON.stringify(ref)}`);
  assert.equal(hint, 'Send');

  // The server-side half: exactly what src/board.mjs's resolveComment calls at
  // packet-assembly/re-render time, against the ORIGINAL srcdoc string (not
  // the stand-in's parsed tree) -- proving the two independent
  // HEAD_ONLY_TAGS-hoisting implementations (src/anchor.mjs's own, and this
  // file's) actually agree on the ref a real click mints.
  assert.equal(resolveDomAnchor(styledBoard.blocks[0].html, ref, hint), true,
    'the server must resolve the exact ref/hint a real click mints against a self-styling mock');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall click checks ok');
