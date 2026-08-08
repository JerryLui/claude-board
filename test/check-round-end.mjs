// The round-end rail and the send bar's docking behaviour ("the end of a round" --
// see that section's own preamble: a round has a top but no bottom, and the send
// bar's scrim floats over content identically whether the round is three
// questions from over or none). Same rung as test/check-enter.mjs, which owns
// the Send button's arming behaviour -- this file never touches the Send
// button's label, click handler or arming behaviour, only the rail
// (renderRoundSection's .round-end) and the send bar's docked/floating state.
//
// Two shapes, matching the house idioms:
//   - test/check-pure.mjs's shape: rendered markup and exact CSS
//     rule wording, asserted directly against renderRoundSection/styles output.
//   - test/check-archive.mjs's shape for the rail's half: a real
//     rendered page written to a real temp file and read back with
//     location.protocol genuinely 'file:'.
//
// The docking toggle is the interesting part: setupSendBarDock
// (src/ui.mjs) drives it with an IntersectionObserver on the rail, and
// test/dom-stand-in.mjs had none at all before this file (QUIRKS.md "The
// stand-in has no layout"). StandInIntersectionObserver (added alongside this
// file) fakes the one fact src/ui.mjs's callback ever reads off an entry
// (isIntersecting) and gives a test a way to fire it directly, in BOTH
// directions -- proving the toggle actually flips the bar's class, not just that
// a listener got registered. A companion check drives the same page with NO
// IntersectionObserver defined at all, proving the guard around its absence
// (QUIRKS.md "The stand-in has no layout") holds for this observer too. Since
// ADR.md entry 42 turned rounds into pages, setupSendBarDock's is the ONLY
// IntersectionObserver this page can construct -- the round badge's own band
// observer went with the scrolling layout it measured -- which is why the
// observer-count assertions below read 1 and 0 rather than 2 and 1.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML, StandInIntersectionObserver, StandInEventSource, StandInEvent, resolveComputedProperty } from './dom-stand-in.mjs';

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

const Q1 = { kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const Q2 = { kind: 'question', prompt: 'Q2: pick another', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] };
const Q3 = { kind: 'question', prompt: 'Q3: pick a third', widget: 'single', options: [{ label: 'Alpha' }, { label: 'Beta' }] };

/** Answer a single-choice question by clicking the option carrying `label`, through
 * the real widget -- same idiom as test/check-send-guard.mjs's own answerSingle,
 * copied rather than imported across files (no shared test-helper module exists
 * here, and this file already carries its own loadBoard/loadBoardWithIntersectionObserver
 * pair rather than reaching into check-send-guard.mjs's). */
function answerSingle(block, label) {
  const opt = [...block.querySelectorAll('.choice-single')].find(el => el.textContent.trim() === label);
  assert.ok(opt, `setup failure: no "${label}" option rendered in this block`);
  opt.dispatchEvent(new StandInEvent('click'));
}

/** Defer a question through its real Defer button. */
function deferBlock(block) {
  const btn = block.querySelector('.btn-defer');
  assert.ok(btn, 'setup failure: no Defer button rendered in this block');
  btn.dispatchEvent(new StandInEvent('click'));
}

/** Parse `html` and run the real `ui` client script against it -- same idiom as
 * test/check-enter.mjs's loadBoard. */
function loadBoard(html, protocol) {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol: protocol || 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** loadBoard, plus a captured, stubbed EventSource in place before the script
 * runs -- test/check-anchor-push.mjs's own idiom, reused here to drive a real
 * 'round' SSE push and prove the live transition (markRoundHistory stripping
 * the rail) matches what the server would have rendered instead. */
function loadBoardWithEventSource(html) {
  const originalES = globalThis.EventSource;
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  globalThis.EventSource = CapturingEventSource;
  try {
    const document = loadBoard(html, 'http:');
    assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource');
    return { document, es: captured };
  } finally {
    globalThis.EventSource = originalES;
  }
}

/** loadBoard, plus a captured, stubbed IntersectionObserver in place before the
 * script runs (setupSendBarDock constructs one synchronously at hydrate, guarded
 * only by `typeof IntersectionObserver !== 'function'` -- the stub has to already
 * be the global by the time that call happens). Returns every constructed
 * instance, and a caller finds the one it wants by which target it is actually
 * observing, never by index: the count is 1 today (rounds became pages, so the
 * round badge no longer runs one), and a check that assumed a position would go
 * quietly wrong the day a second one is added back. */
function loadBoardWithIntersectionObserver(html, protocol) {
  const originalIO = globalThis.IntersectionObserver;
  const constructed = [];
  class CapturingIntersectionObserver extends StandInIntersectionObserver {
    constructor(callback) { super(callback); constructed.push(this); }
  }
  globalThis.IntersectionObserver = CapturingIntersectionObserver;
  try {
    const document = loadBoard(html, protocol);
    return { document, observers: constructed };
  } finally {
    globalThis.IntersectionObserver = originalIO;
  }
}

/** The observer among `observers` that is watching `target` -- never the first
 * or the last, since how many observers a hydrate happens to construct, and in
 * what order, is an implementation detail this file has no business depending
 * on (it was two before rounds became pages; it is one now). */
function observerWatching(observers, target) {
  return observers.find(o => o.targets.indexOf(target) !== -1) || null;
}

// =====================================================================================
// "An open round renders a visible end after its last block, naming
// the round and how many questions it held."
// =====================================================================================

check('an open round renders a .round-end rail after its last block, naming the round and its (pluralized) question count', () => {
  const board = createBoard({ title: 'Round end - plural', blocks: [
    Q1,
    { kind: 'markdown', text: 'Some context that is not a question.' },
    Q2,
  ] });
  const html = renderRoundSection(board, 1, new Map());

  const railIdx = html.indexOf('class="round-end"');
  assert.notEqual(railIdx, -1, 'expected a .round-end element in the round\'s markup');
  const lastBlockIdx = html.lastIndexOf('question-block');
  assert.ok(lastBlockIdx !== -1 && railIdx > lastBlockIdx, '.round-end must render AFTER the round\'s last block, not before it');

  const tagMatch = html.match(/<span class="tag">([^<]*)<\/span>/);
  assert.ok(tagMatch, 'expected a .tag span carrying the rail\'s text');
  assert.equal(tagMatch[1], 'end of round 1 · 2 questions',
    'the rail must name the round and its TOP-LEVEL question count -- the markdown block must not inflate it, and 2 must be pluralized');

  // The mock's own shape: a divider line
  // on either side of the tag, not just a bare label.
  assert.equal((html.match(/<span class="line"><\/span>/g) || []).length, 2,
    'expected two .line dividers flanking the .tag, matching the design\'s "end of round" rail');
});

check('a round with exactly one question renders "1 question", singular, not "1 questions"', () => {
  const board = createBoard({ title: 'Round end - singular', blocks: [Q1] });
  const html = renderRoundSection(board, 1, new Map());
  const tagMatch = html.match(/<span class="tag">([^<]*)<\/span>/);
  assert.ok(tagMatch, 'expected a .tag span carrying the rail\'s text');
  assert.equal(tagMatch[1], 'end of round 1 · 1 question');
});

check('a sent (historical) round renders NO .round-end -- the rail is for the round still asking for an answer', () => {
  const board = createBoard({ title: 'Round end - historical', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const html = renderRoundSection(board, 1, new Map());
  assert.ok(!html.includes('round-end'), 'a historical round must never carry a .round-end rail');
});

check('out of scope: the round badge\'s own label is untouched -- this spec is about position WITHIN a round, not across rounds', () => {
  const board = createBoard({ title: 'Round end - badge untouched', blocks: [Q1] });
  const html = renderBoardPage(board);
  assert.ok(html.includes('round 1 of 1'), 'the round badge must keep stating position and total across rounds, unrelated to this rail');
});

// =====================================================================================
// The rail's CSS: exact wording, matching QUIRKS.md's own convention for rules
// asserted by their text rather than their effect ("readonly is locked twice",
// the mermaid-id trap) -- this rule's whole job is to select the rail's own
// markup, so its wording is what actually matters here.
// =====================================================================================

check('the .round-end rail\'s CSS uses real design tokens (spacing/hairline), not hand-picked pixel values', () => {
  assert.match(styles, /\.round-end\s*\{[^}]*display:\s*flex[^}]*\}/, 'expected a .round-end rule laying the rail out as a row');
  assert.match(styles, /\.round-end \.line\s*\{[^}]*background:\s*var\(--hairline-2\)[^}]*\}/, 'expected the divider lines to use --hairline-2, the same token .round-history already uses');
  assert.match(styles, /\.round-end \.tag\s*\{[^}]*padding:\s*0 var\(--space-2\)[^}]*\}/, 'expected the tag to be bare text between the two lines, spaced with --space-2');
  assert.doesNotMatch(styles, /\.round-end \.tag\s*\{[^}]*border[^}]*\}/, 'the tag wears the rail\'s own lines, so a second outline around the words is chrome the rail already draws');
});

// =====================================================================================
// "The send bar is visually docked, without its scrim, when the end
// of the round is on screen, and floating over content when it is not."
// =====================================================================================

check('the .send-bar.docked rule drops the gradient scrim AND the blur, and draws no rule of its own', () => {
  assert.match(styles, /\.send-bar\.docked \{ background: var\(--bg\); backdrop-filter: none; \}/,
    'expected the docked rule to replace the scrim with a flat background and no blur');
  // '.docked' means the closing rail is on screen, and the rail is already a
  // full-width line two rows up: a border here drew a second horizontal rule
  // under the first, at the one moment the first is guaranteed to be visible.
  assert.doesNotMatch(styles, /\.send-bar\.docked \{[^}]*border[^}]*\}/,
    'the docked bar must not add a hairline -- .round-end\'s own rule is the line at the foot of a fully scrolled round');
});

check('the send bar starts floating (no .docked class) on an ordinary hydrate, before any intersection has been reported', () => {
  const board = createBoard({ title: 'Round end - dock initial', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const { document } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  assert.ok(sendBar, 'setup failure: no .send-bar rendered');
  assert.equal(sendBar.classList.contains('docked'), false, 'the bar must not start docked -- nothing has reported the rail on screen yet');
});

check('the send bar docks when the rail comes on screen, and floats again when it leaves -- both directions', () => {
  const board = createBoard({ title: 'Round end - dock toggle', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  const rail = document.querySelector('.round-end');
  assert.ok(rail, 'setup failure: no .round-end rendered for the open round');
  const dockObserver = observerWatching(observers, rail);
  assert.ok(dockObserver, 'setup failure: no observer is watching the .round-end rail -- setupSendBarDock must call observe() on it');

  dockObserver._setIntersecting(rail, true);
  assert.equal(sendBar.classList.contains('docked'), true, 'the rail coming on screen must dock the send bar');

  dockObserver._setIntersecting(rail, false);
  assert.equal(sendBar.classList.contains('docked'), false, 'the rail leaving the screen must float the send bar again');

  dockObserver._setIntersecting(rail, true);
  assert.equal(sendBar.classList.contains('docked'), true, 'toggling back on must re-dock it -- not a one-shot latch');
});

check('with no open round at all (every round sent), there is no rail to observe and the bar is never docked', () => {
  const board = createBoard({ title: 'Round end - no open round', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  assert.equal(document.querySelector('.round-end'), null, 'setup failure: a fully-sent board must render no .round-end anywhere');
  assert.equal(sendBar.classList.contains('docked'), false);
  // No observer at all is constructed: setupSendBarDock's "no rail" branch
  // returns before ever building one, and since rounds became pages (ADR.md
  // entry 42) the round badge no longer runs one either -- this is now the only
  // IntersectionObserver the page can construct.
  assert.equal(observers.length, 0, 'setupSendBarDock must not construct an IntersectionObserver when there is no rail to watch');
});

check('guarded for absence -- with no IntersectionObserver defined at all, the page still hydrates and the bar simply stays floating', () => {
  const original = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  try {
    assert.equal(typeof globalThis.IntersectionObserver, 'undefined', 'setup failure: IntersectionObserver must be genuinely absent for this check');
    const board = createBoard({ title: 'Round end - no observer', blocks: [Q1, Q2] });
    const html = renderBoardPage(board);
    let document;
    assert.doesNotThrow(() => { document = loadBoard(html); }, 'the client script must not throw when IntersectionObserver is missing');
    const sendBar = document.querySelector('.send-bar');
    assert.ok(sendBar, 'setup failure: no .send-bar rendered');
    assert.equal(sendBar.classList.contains('docked'), false, 'with no way to observe the rail, the bar must default to floating, not throw or dock unconditionally');
  } finally {
    globalThis.IntersectionObserver = original;
  }
});

check('the rail moves live over SSE -- the round a push collapses into history loses its rail, the round it opens gets its own, matching server markup for each', () => {
  const board = createBoard({ title: 'Round end - SSE parity', blocks: [Q1] });
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);
  const round1Rail = () => document.querySelector('.round[data-round="1"] .round-end');
  assert.ok(round1Rail(), 'setup failure: round 1 must render its own rail while open');

  // Real submit + real addRound (src/board.mjs, no HTTP) -- then the exact
  // payload shape src/server.mjs's own buildRoundPushPayload sends for a
  // brand-new round (test/check-anchor-push.mjs's own construction).
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  const commentsByBlock = groupCommentsByBlock([]);
  const payload = { round: 2, mode: 'new-round', blockIds: [], html: renderRoundSection(board, 2, commentsByBlock), board: { ...board, comments: [] } };
  es.dispatch('round', JSON.stringify(payload));

  assert.equal(round1Rail(), null,
    'round 1 must lose its .round-end the moment markRoundHistory collapses it live -- server markup for a historical round never carries one, and the live transition must match (QUIRKS.md: server markup and its live-transition twin must never disagree)');
  assert.ok(document.querySelector('.round[data-round="2"] .round-end'), 'round 2, now the open round, must carry its own .round-end');
});

// =====================================================================================
// Rider fix, unrelated to the timer: the send bar's
// post-submit status message ("Sent." / "This round has been sent. Waiting
// for the next one.") must clear the moment a new round lands, and must never
// show beside an open round. src/render.mjs already gets the SERVER-rendered
// half right (span#send-status is only ever seeded with that text when
// hasOpenRound(board) is false), so this drives the live half: a page loaded
// with every round already sent (the message present, exactly as a reviewer
// who reloaded after sending would see it) that then receives a brand-new
// round over SSE, same payload shape as the SSE-parity check just above.
// =====================================================================================

check('rider fix: the send bar\'s post-submit status message clears the moment a new round lands, and never sits beside the freshly-opened round', () => {
  const board = createBoard({ title: 'Round end - status clears on push', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const pageHtml = renderBoardPage(board);
  const { document, es } = loadBoardWithEventSource(pageHtml);
  const sendStatus = document.getElementById('send-status');
  assert.equal(sendStatus.textContent, 'This round has been sent. Waiting for the next one.',
    'setup failure: with every round sent and none open, the server must render the post-submit status message');

  addRound(board, { blocks: [Q2] });
  const commentsByBlock = groupCommentsByBlock([]);
  const payload = { round: 2, mode: 'new-round', blockIds: [], html: renderRoundSection(board, 2, commentsByBlock), board: { ...board, comments: [] } };
  es.dispatch('round', JSON.stringify(payload));

  assert.equal(sendStatus.textContent, '',
    'the stale post-submit status must clear the instant a new round lands (src/ui.mjs applyRoundPush) -- it must never sit beside the freshly-opened round');
  assert.equal(document.getElementById('send-btn').disabled, false, 'setup check: the send bar must also be re-enabled for the new open round');
});

// =====================================================================================
// "... none of this appears in a read-only archive
// opened from disk." Same rigor as test/check-archive.mjs's own .mode-toggle/
// .back-to-index checks: the CSS rule's exact wording, plus proof the rail is
// structurally PRESENT in the archive's markup (one page, live or archived --
// readonly hides by CSS, never by omitting server-side) rather than computing a
// cascade the stand-in cannot run for an arbitrary selector (QUIRKS.md "The
// stand-in's getComputedStyle has no CSS engine behind it").
// =====================================================================================

check('body.readonly hides .round-end by exact rule, and a real file:// archive still carries the rail structurally', () => {
  assert.match(styles, /body\.readonly \.round-end \{ display: none; \}/, 'expected an exact body.readonly rule hiding .round-end, alongside the .send-bar one right next to it');

  const board = createBoard({ title: 'Round end - archive', blocks: [Q1] });
  const html = renderBoardPage(board);
  assert.ok(html.includes('class="round-end"'), 'setup failure: the live page must render the rail for its still-open round');

  const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-round-end-archive-'));
  const file = path.join(dir, 'board.html');
  writeFileSync(file, html, 'utf8');
  const fileBytes = readFileSync(file, 'utf8');
  const document = loadBoard(fileBytes, 'file:');

  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');
  assert.ok(document.querySelector('.round-end'), 'the rail must still be IN the archive\'s DOM -- readonly hides it by CSS (asserted above), never by omitting it server-side');
});

check('the docking observer never runs in a read-only archive -- belt and suspenders alongside .send-bar\'s own display:none', () => {
  const board = createBoard({ title: 'Round end - archive dock', blocks: [Q1] });
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html, 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: expected file:// to produce a readonly document');
  const rail = document.querySelector('.round-end');
  assert.equal(observerWatching(observers, rail), null, 'setupSendBarDock must bail out under readonly -- no observer should ever be attached to the rail in an archive');
  assert.equal(observers.length, 0, 'no observer at all should exist under readonly -- setupSendBarDock must return before constructing one, and the round badge stopped running one when rounds became pages');
});

// =====================================================================================
// "The page ends where the last control is." Root cause:
// .board-shell used to carry a 128px bottom padding, so at full scroll the sticky
// .send-bar (the shell's own last child) rested 128px above the document's actual
// bottom edge -- a band of bare background below the one control that should have
// been flush with the page's own end. Under body.readonly the send bar is
// display:none (asserted above) and the same padding left the identical band below
// the last block instead. Fix: src/styles.mjs's .board-shell rule, see its own
// comment. These checks use resolveComputedProperty (test/dom-stand-in.mjs), the
// same real-cascade resolver test/check-stage-lens.mjs and
// test/check-stage-isolation.mjs already use for a property the stand-in's own
// getComputedStyle stub does not cover, rather than a hand-rolled regex against the
// rule's spelling (QUIRKS.md's own warning about that shape).
// =====================================================================================

check('.board-shell carries no bottom padding -- reverting to a trailing px value (e.g. the old 128px) must fail this check', () => {
  const board = createBoard({ title: 'Flush bottom - open round', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const shell = document.querySelector('.board-shell');
  assert.ok(shell, 'setup failure: no .board-shell rendered');
  const padding = resolveComputedProperty(styles, shell, true, 'padding');
  assert.equal(padding, '0 var(--space-5)',
    'expected .board-shell\'s padding to carry no bottom value -- a trailing px reopens the band below the send bar (or, in readonly, below the last block)');
});

check('.send-bar is .board-shell\'s own last element child -- nothing rendered after it that would sit in the flush-bottom padding\'s place', () => {
  const board = createBoard({ title: 'Flush bottom - last child', blocks: [Q1] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const shell = document.querySelector('.board-shell');
  const children = shell.children;
  const last = children[children.length - 1];
  assert.ok(last && last.classList.contains('send-bar'),
    '.send-bar must be .board-shell\'s last element child for a zero bottom padding to actually land the bar\'s own lower edge on the document\'s lower edge');
});

// This check used to forbid an archive ANY bottom padding ("one rule answers
// both endings, live and archived"). That promise predated the round pager's
// floating dock, and outlived its own truth: body.readonly hides the send bar
// on every archive, and renderRoundSection prints the dock on every board --
// including a one-round one -- so what "flush" bought an archive was its last
// block underneath a fixed box, not a clean bottom edge. The invariant is
// rewritten rather than dropped: an archive reserves, and reserves BY THE SAME
// EXPRESSION the comment panel clears the dock with, so the two can never
// drift apart into a gap or an overlap.
check('a read-only file:// archive (send bar hidden, dock still on screen) reserves the dock\'s own measured height -- by the same expression .page-comments clears it with, not a number of its own', () => {
  const board = createBoard({ title: 'Flush bottom - archive', blocks: [Q1] });
  const html = renderBoardPage(board);
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-flush-bottom-archive-'));
  const file = path.join(dir, 'board.html');
  writeFileSync(file, html, 'utf8');
  const fileBytes = readFileSync(file, 'utf8');
  const document = loadBoard(fileBytes, 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');
  const shell = document.querySelector('.board-shell');
  assert.ok(shell, 'setup failure: no .board-shell in the archive\'s DOM');
  // Setup, and the reason this reservation is unconditional: one round, no
  // round ever sent, and the dock is on the page regardless.
  assert.ok(document.querySelector('.round-pager-dock'),
    'setup failure: the dock must render on a one-round archive too -- if it stopped, this reservation is dead weight and should go with it');

  // The longhand, directly. The shorthand cannot see this rule: it arrives from
  // a different selector and the resolver does not fold longhands into the
  // shorthand -- which is exactly how the band this check once forbade got back
  // on screen with the old assertion still green.
  const reserved = resolveComputedProperty(styles, shell, true, 'padding-bottom');
  assert.ok(reserved.includes('var(--round-pager-dock-h'),
    'the archive must clear the dock by its MEASURED height, not a pixel literal sized for today\'s dock');

  // The anti-drift assertion, and the point of the whole check: token for token
  // the same expression as the panel's, read off the page board's own rendered
  // panel rather than copied into this file as a string.
  const pageBoard = parseHTML(renderBoardPage(createBoard({ title: 'Rendered artifact', blocks: [{ kind: 'html', html: '<p>hello</p>' }] })));
  const panel = pageBoard.querySelector('.page-comments');
  assert.ok(panel, 'setup failure: expected a page board to render .page-comments');
  assert.equal(reserved, resolveComputedProperty(styles, panel, true, 'bottom'),
    'the shell\'s reservation and the panel\'s clearance must stay the same expression -- if one grows a term the other does not, an archive gets a gap or an overlap');

  document.body.classList.add('sent-page');
  assert.equal(resolveComputedProperty(styles, shell, true, 'padding-bottom'), reserved,
    'an archived board whose round in view is sent carries both classes, and both selectors must land the same value -- not one stacked on the other');
});

check('a live board with its round still open keeps the flush bottom -- the send bar is the floor there, so reserving on top of it would band the page', () => {
  const board = createBoard({ title: 'Flush bottom - open round', blocks: [Q1] });
  const document = loadBoard(renderBoardPage(board));
  const shell = document.querySelector('.board-shell');
  // Empty, not '0': the resolver reports what a rule DECLARES and does not fold
  // the shorthand into longhands, so "no rule sets padding-bottom here" reads
  // as ''. A reservation leaking onto the open round would resolve to its calc().
  assert.equal(resolveComputedProperty(styles, shell, true, 'padding-bottom'), '',
    'nothing may reserve below an open round: .send-bar is in flow as the shell\'s last child and its own edge is the document\'s');
});

// =====================================================================================
// The questions-left pill (round-end decisions / ADR.md entry 27). Its own
// agreement-with-the-guard case lives in test/check-send-guard.mjs; a
// regression guard is already pinned above, untouched by this work. A live,
// additive count of the open round's still-unanswered questions, floating grey
// and centered above the send bar, on screen exactly while the round's own
// closing rail is not: the SAME IntersectionObserver that already docks the
// send bar, reused rather than duplicated, and it
// never touches the send guard.
// =====================================================================================

// === rendered while the round has unanswered questions, reading
// "N question(s) left" ===================================================

check('the open round\'s pill renders with the live count, pluralized, and starts VISIBLE -- the rail is assumed off screen until an observer says otherwise, same default as the bar\'s own undocked start', () => {
  const board = createBoard({ title: 'Pill - initial count', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  assert.match(html, /<button type="button" class="questions-left-pill visible" id="questions-left-pill">2 questions left<\/button>/,
    'expected a visible pill naming both outstanding questions at first paint');
});

check('singular at exactly one outstanding question', () => {
  const board = createBoard({ title: 'Pill - singular', blocks: [Q1] });
  const html = renderBoardPage(board);
  assert.match(html, /class="questions-left-pill visible" id="questions-left-pill">1 question left</);
});

check('the pill is grey (--panel-2/--ink-2, the same chrome .round-badge and .mode-toggle already use), never the send guard\'s warning amber, and floats centered above the send bar', () => {
  assert.match(styles, /\.questions-left-pill\s*\{[^}]*background:\s*var\(--panel-2\)[^}]*color:\s*var\(--ink-2\)[^}]*\}/,
    'expected the pill\'s base rule to use the same grey chrome tokens as .round-badge/.mode-toggle');
  assert.match(styles, /\.questions-left-pill\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*bottom:\s*100%[^}]*transform:\s*translateX\(-50%\)[^}]*\}/,
    'expected the pill centered (left: 50%, translateX(-50%)) and floating above the send bar (bottom: 100%, i.e. its OWN bottom edge sits at the bar\'s top edge)');
});

// === "answering a question lowers it with no reload...
// a deferred question counts as complete, matching the guard's rule." (The
// half proving this can never disagree with the send guard's own arming rule
// lives in test/check-send-guard.mjs, driving both off the one shared
// outstandingBlocks() rather than two independent assertions.) ===============

check('the count lowers with no reload as questions are answered, and a deferred question counts as complete', () => {
  const board = createBoard({ title: 'Pill - live count', blocks: [Q1, Q2, Q3] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const pill = document.getElementById('questions-left-pill');
  const blocks = [...document.querySelectorAll('.round-open .question-block')];
  assert.equal(pill.textContent, '3 questions left', 'setup failure: expected all three outstanding at hydrate');

  answerSingle(blocks[0], 'Yes');
  assert.equal(pill.textContent, '2 questions left', 'answering one question must lower the count immediately, no reload');

  deferBlock(blocks[1]);
  assert.equal(pill.textContent, '1 question left', 'a deferred question must count as complete, exactly like the send guard\'s own rule');

  answerSingle(blocks[2], 'Alpha');
  assert.equal(pill.textContent, '0 questions left', 'the last question answered must bring the count to zero');
  assert.equal(pill.classList.contains('visible'), false, 'a count of zero must never be shown, even with the rail still off screen');
});

// === clicking (or activating by keyboard) moves the reviewer to the
// first still-outstanding question -- the send guard's own target
// (outstandingBlocks()[0]), never a second notion of "next question" -- and the
// button's own visible text is its accessible name. ==========================

check('clicking the pill lands on the FIRST still-outstanding question\'s own TOP -- the exact block armSendGuard would flag, not merely any outstanding one, and not its note field a screen further down', () => {
  const board = createBoard({ title: 'Pill - click target', blocks: [Q1, Q2, Q3] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const blocks = [...document.querySelectorAll('.round-open .question-block')];
  answerSingle(blocks[0], 'Yes'); // Q1 answered -- Q2 must be the target, not Q1 and not Q3
  const pill = document.getElementById('questions-left-pill');

  pill.dispatchEvent(new StandInEvent('click'));

  const target = blocks[1];
  assert.equal(target.scrollIntoViewCallCount >= 1, true, 'the target question BLOCK must be scrolled into view');
  assert.deepEqual(target.scrollIntoViewLastOptions, { block: 'start' },
    'the block must be aligned to its own top -- \'center\' or a note field would put the question\'s first line off screen');
  assert.equal(target.querySelector('[data-note-for]').scrollIntoViewCallCount, 0,
    'the note field sits at the END of a question; scrolling it is exactly what this landing replaced');
  assert.equal(document.activeElement, target,
    'focus must move to the block itself, so keyboard and screen-reader users continue from the question rather than from the pill');
  assert.equal(target.getAttribute('tabindex'), '-1',
    'the block must be a legal script-focus target without joining the Tab order');
});

check('the pill is a native <button> in the ordinary tab order -- no custom role or tabindex substituting for it', () => {
  const board = createBoard({ title: 'Pill - keyboard', blocks: [Q1] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const pill = document.getElementById('questions-left-pill');
  assert.equal(pill.tagName, 'BUTTON', 'the pill must be a real <button>, not a div wearing role="button"');
  assert.equal(pill.hasAttribute('tabindex'), false, 'no tabindex override -- a native button is already reachable by Tab');
});

check('the pill carries no separate aria-label -- its own visible text IS the accessible name, so it can never say a different count than what is on screen', () => {
  const board = createBoard({ title: 'Pill - accessible name', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const pill = document.getElementById('questions-left-pill');
  assert.equal(pill.hasAttribute('aria-label'), false);
  assert.equal(pill.textContent, '2 questions left');
});

// === the pill leaves the screen the instant the round's closing
// rail is on screen -- the SAME observer that already docks the send bar, never
// a second one -- and it is never shown at a count of zero.
//
// What this proves and what it cannot: StandInIntersectionObserver
// fakes the one fact src/ui.mjs's callback ever reads off an entry
// (isIntersecting) and lets a check fire it directly, in both directions --
// proving the DECISION ("given the rail is reported intersecting, is the pill
// shown") is wired to the identical observer instance that docks the bar, and
// that a zero count overrides it either way. It cannot prove that a real
// .round-end rail crossing a real viewport at a real scroll position actually
// fires that callback at the right moment -- that is real layout (QUIRKS.md
// "The stand-in has no layout: no IntersectionObserver, no scrollHeight, no
// clientHeight"), and this feature rests on the exact same construction
// the docking checks above already trust rather than re-proving it:
// one IntersectionObserver, on the one .round-end element, feeding both
// consumers. Nothing in this file drives a real browser.
// =====================================================================================

check('the pill and the send bar\'s dock are driven by the SAME observer instance -- toggling it flips both, in both directions', () => {
  const board = createBoard({ title: 'Pill - shared observer', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  const pill = document.getElementById('questions-left-pill');
  const rail = document.querySelector('.round-end');
  assert.ok(rail, 'setup failure: no .round-end rendered for the open round');
  const dockObserver = observerWatching(observers, rail);
  assert.ok(dockObserver, 'setup failure: no observer is watching the rail');
  assert.equal(observers.length, 1,
    'expected exactly one observer on this page: setupSendBarDock\'s single shared one -- never a second, pill-only observer (the round badge\'s own band observer went with the scrolling layout it measured, ADR.md entry 42)');

  assert.equal(pill.classList.contains('visible'), true, 'setup failure: the pill must start visible -- two outstanding questions, rail not yet reported on screen');

  dockObserver._setIntersecting(rail, true);
  assert.equal(sendBar.classList.contains('docked'), true, 'setup failure: the rail coming on screen must dock the bar, unchanged by this work');
  assert.equal(pill.classList.contains('visible'), false, 'the rail coming on screen must hide the pill, in the SAME callback that docks the bar');

  dockObserver._setIntersecting(rail, false);
  assert.equal(sendBar.classList.contains('docked'), false);
  assert.equal(pill.classList.contains('visible'), true, 'the rail leaving the screen must show the pill again, symmetrically with the bar undocking');
});

check('never shown at a count of zero, even while the rail is reported off screen', () => {
  const board = createBoard({ title: 'Pill - never at zero', blocks: [Q1] });
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html);
  const blocks = [...document.querySelectorAll('.round-open .question-block')];
  const pill = document.getElementById('questions-left-pill');
  const rail = document.querySelector('.round-end');
  const dockObserver = observerWatching(observers, rail);
  dockObserver._setIntersecting(rail, false); // rail explicitly off screen
  assert.equal(pill.classList.contains('visible'), true, 'setup failure: expected the pill visible with one outstanding question and the rail off screen');

  answerSingle(blocks[0], 'Yes');

  assert.equal(pill.classList.contains('visible'), false, 'a count of zero must never be shown, even though the rail is still off screen');
  assert.equal(pill.textContent, '0 questions left');
});

check('guarded for absence -- with no IntersectionObserver at all, the pill still renders (assuming the rail is permanently off screen, matching the send bar\'s own floating fallback) and its count still tracks live answers', () => {
  const original = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  try {
    const board = createBoard({ title: 'Pill - no observer', blocks: [Q1, Q2] });
    const html = renderBoardPage(board);
    let document;
    assert.doesNotThrow(() => { document = loadBoard(html); }, 'the client script must not throw when IntersectionObserver is missing');
    const pill = document.getElementById('questions-left-pill');
    const blocks = [...document.querySelectorAll('.round-open .question-block')];
    assert.equal(pill.classList.contains('visible'), true, 'with no way to observe the rail, the pill must default to shown, matching the send bar\'s own permanently-floating default');
    answerSingle(blocks[0], 'Yes');
    assert.equal(pill.textContent, '1 question left', 'the count must still update live from the answer handlers even with no IntersectionObserver at all');
  } finally {
    globalThis.IntersectionObserver = original;
  }
});

// === no pill on a historical (sent) round, and none in a
// read-only (file://) archive. ===============================================

check('a board with every round already sent renders the pill at zero, never visible', () => {
  const board = createBoard({ title: 'Pill - sent round', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const html = renderBoardPage(board);
  assert.match(html, /class="questions-left-pill" id="questions-left-pill" disabled>0 questions left</,
    'a fully-sent board must render the pill with no outstanding count and no .visible class');
});

check('a round that asks nothing renders the pill at zero, never visible -- matching the send guard, which also never arms on such a round', () => {
  const board = createBoard({ title: 'Pill - no questions this round', blocks: [{ kind: 'markdown', text: 'Just an FYI, nothing to answer.' }] });
  const html = renderBoardPage(board);
  assert.match(html, /class="questions-left-pill" id="questions-left-pill">0 questions left</);
});

check('the pill never appears in a read-only (file://) archive -- structurally present (readonly hides it by CSS, same convention as .round-end), hard-disabled, and inert to a click', () => {
  const board = createBoard({ title: 'Pill - archive', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  assert.ok(html.includes('id="questions-left-pill"'), 'setup failure: the live page must render the pill for its still-open round');

  const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-pill-archive-'));
  const file = path.join(dir, 'board.html');
  writeFileSync(file, html, 'utf8');
  const fileBytes = readFileSync(file, 'utf8');
  const document = loadBoard(fileBytes, 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');

  const pill = document.querySelector('#questions-left-pill');
  assert.ok(pill, 'the pill must still be IN the archive\'s DOM -- readonly hides it by CSS, never by omitting it server-side');
  assert.ok(pill.closest('.send-bar'), 'the pill must be nested inside .send-bar, so it inherits body.readonly .send-bar { display: none } for free rather than needing a second rule (QUIRKS.md "Readonly is locked twice")');
  assert.equal(pill.disabled, true, 'the readonly blanket-disable loop (qsa(\'textarea, input, button\')) must reach the pill too, exactly as it reaches every other button');

  const activeBefore = document.activeElement;
  assert.doesNotThrow(() => pill.dispatchEvent(new StandInEvent('click')));
  assert.equal(document.activeElement, activeBefore, 'a click in a read-only archive must never move focus anywhere -- the pill\'s own readonly guard must hold, belt-and-suspenders alongside the disabled attribute (QUIRKS.md: a stand-in dispatchEvent does not model native click-suppression on a disabled element, so the guard is what actually earns this)');
});

// === SPEC_AWAITED.md ticket 03: a sent awaited page round is read-only like
// any other sent round (this file's own Testing note in the spec). ==========

check('an awaited page round that has been sent renders its comment surface exactly like any other sent round -- disabled, not dropped, and the pill reads "read-only"', () => {
  const board = createBoard({ title: 'Sent page round', blocks: [{ kind: 'html', html: '<div class="mock"></div>' }], wait: true });
  applySubmit(board, { action: 'send', answers: [], comments: [{ blockId: board.blocks[0].id, anchor: { kind: 'block' }, text: 'looks good' }] }, 1);
  const html = renderBoardPage(board);
  const document = loadBoard(html);

  const roundSection = document.querySelector('.round[data-round="1"]');
  assert.ok(roundSection, 'setup failure: no round 1 section rendered');
  assert.equal(roundSection.classList.contains('round-history'), true, 'a sent round renders as history, exactly like any other');

  const form = document.querySelector('.comment-form');
  assert.ok(form, 'the compose form must still be rendered -- read-only, not removed, matching every other sent block\'s comment form');
  assert.equal(form.querySelector('input[type=text]').disabled, true);
  assert.equal(form.querySelector('button[type=submit]').disabled, true);

  const sendBtn = document.querySelector('.page-send-btn');
  const discussBtn = document.querySelector('.page-discuss-btn');
  assert.ok(sendBtn && discussBtn, 'the send control must still be rendered on a sent page round too, disabled rather than gone');
  assert.equal(sendBtn.disabled, true);
  assert.equal(discussBtn.disabled, true);
  assert.equal(sendBtn.textContent, 'Send 1 comment', 'the label still names what WAS sent');

  const item = document.querySelector('.comment-item');
  assert.ok(item, 'the sent comment must still be visible in the list');
  assert.match(item.textContent, /looks good/);

  const meta = document.querySelector('span#round-meta');
  assert.equal(meta.textContent, 'read-only', 'a sent round\'s pill falls back exactly like a never-awaited one\'s (AC 8, AC 11)');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall round-end checks ok');
