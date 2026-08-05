// DESIGN.md round-end criteria 1, 2, and the rail's half of 6 ("the end of a round" --
// see that section's own preamble: a round has a top but no bottom, and the send
// bar's scrim floats over content identically whether the round is three
// questions from over or none). Same rung as test/check-enter.mjs, which owns
// criteria 3-5 and the arming half of 6 -- this file never touches the Send
// button's label, click handler or arming behaviour, only the rail
// (renderRoundSection's .round-end) and the send bar's docked/floating state.
//
// Two shapes, matching the house idioms named in this ticket:
//   - test/check-pure.mjs's shape for criterion 1: rendered markup and exact CSS
//     rule wording, asserted directly against renderRoundSection/styles output.
//   - test/check-archive.mjs's shape for the rail's half of criterion 6: a real
//     rendered page written to a real temp file and read back with
//     location.protocol genuinely 'file:'.
//
// Criterion 2 (the docking toggle) is the interesting part: setupSendBarDock
// (src/ui.mjs) drives it with an IntersectionObserver on the rail, and
// test/dom-stand-in.mjs had none at all before this file (QUIRKS.md "The
// stand-in has no layout"). StandInIntersectionObserver (added alongside this
// file) fakes the one fact src/ui.mjs's callback ever reads off an entry
// (isIntersecting) and gives a test a way to fire it directly, in BOTH
// directions -- proving the toggle actually flips the bar's class, not just that
// a listener got registered. A companion check drives the same page with NO
// IntersectionObserver defined at all, proving the guard around its absence
// (QUIRKS.md's own pattern for setupRoundObserver) holds for this observer too.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML, StandInIntersectionObserver, StandInEventSource, resolveComputedProperty } from './dom-stand-in.mjs';

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
 * script runs (src/ui.mjs constructs one synchronously, both for the round
 * badge's own setupRoundObserver and for setupSendBarDock, guarded only by
 * `typeof IntersectionObserver !== 'function'` -- the stub has to already be the
 * global by the time either call happens). Returns every constructed instance,
 * since setupRoundObserver's own (watching every .round section) and
 * setupSendBarDock's (watching the single .round-end rail) are both built at
 * hydrate -- a caller finds the one it wants by which target it is actually
 * observing, never by assuming a construction order. */
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
 * or the last, since which of setupRoundObserver's and setupSendBarDock's two
 * observers runs first is an implementation detail this file has no business
 * depending on. */
function observerWatching(observers, target) {
  return observers.find(o => o.targets.indexOf(target) !== -1) || null;
}

// =====================================================================================
// Criterion 1: "An open round renders a visible end after its last block, naming
// the round and how many questions it held."
// =====================================================================================

check('criterion 1: an open round renders a .round-end rail after its last block, naming the round and its (pluralized) question count', () => {
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

  // The mock's own shape (findings/round-end/c-terminator.html): a divider line
  // on either side of the tag, not just a bare label.
  assert.equal((html.match(/<span class="line"><\/span>/g) || []).length, 2,
    'expected two .line dividers flanking the .tag, matching the design\'s "end of round" rail');
});

check('criterion 1: a round with exactly one question renders "1 question", singular, not "1 questions"', () => {
  const board = createBoard({ title: 'Round end - singular', blocks: [Q1] });
  const html = renderRoundSection(board, 1, new Map());
  const tagMatch = html.match(/<span class="tag">([^<]*)<\/span>/);
  assert.ok(tagMatch, 'expected a .tag span carrying the rail\'s text');
  assert.equal(tagMatch[1], 'end of round 1 · 1 question');
});

check('criterion 1: a sent (historical) round renders NO .round-end -- the rail is for the round still asking for an answer', () => {
  const board = createBoard({ title: 'Round end - historical', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const html = renderRoundSection(board, 1, new Map());
  assert.ok(!html.includes('round-end'), 'a historical round must never carry a .round-end rail');
});

check('criterion 1 / out of scope: the round badge\'s own label is untouched -- this spec is about position WITHIN a round, not across rounds', () => {
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

check('the .round-end rail\'s CSS uses real design tokens (spacing/hairline/pill), not hand-picked pixel values', () => {
  assert.match(styles, /\.round-end\s*\{[^}]*display:\s*flex[^}]*\}/, 'expected a .round-end rule laying the rail out as a row');
  assert.match(styles, /\.round-end \.line\s*\{[^}]*background:\s*var\(--hairline-2\)[^}]*\}/, 'expected the divider lines to use --hairline-2, the same token .round-history already uses');
  assert.match(styles, /\.round-end \.tag\s*\{[^}]*border-radius:\s*var\(--r-pill\)[^}]*\}/, 'expected the tag to be a pill, using --r-pill like .round-label already does');
});

// =====================================================================================
// Criterion 2: "The send bar is visually docked, without its scrim, when the end
// of the round is on screen, and floating over content when it is not."
// =====================================================================================

check('the .send-bar.docked rule drops both the gradient scrim AND the blur, and adds a top hairline', () => {
  assert.match(styles, /\.send-bar\.docked \{ background: var\(--bg\); backdrop-filter: none; border-top: 1px solid var\(--hairline-2\); \}/,
    'expected the docked rule to replace the scrim with a flat background and no blur');
});

check('criterion 2: the send bar starts floating (no .docked class) on an ordinary hydrate, before any intersection has been reported', () => {
  const board = createBoard({ title: 'Round end - dock initial', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const { document } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  assert.ok(sendBar, 'setup failure: no .send-bar rendered');
  assert.equal(sendBar.classList.contains('docked'), false, 'the bar must not start docked -- nothing has reported the rail on screen yet');
});

check('criterion 2: the send bar docks when the rail comes on screen, and floats again when it leaves -- both directions', () => {
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

check('criterion 2: with no open round at all (every round sent), there is no rail to observe and the bar is never docked', () => {
  const board = createBoard({ title: 'Round end - no open round', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html);
  const sendBar = document.querySelector('.send-bar');
  assert.equal(document.querySelector('.round-end'), null, 'setup failure: a fully-sent board must render no .round-end anywhere');
  assert.equal(sendBar.classList.contains('docked'), false);
  // Only the round badge's own observer (watching .round sections) exists --
  // setupSendBarDock's "no rail" branch returns before ever constructing one.
  assert.equal(observers.length, 1, 'setupSendBarDock must not construct an IntersectionObserver when there is no rail to watch');
});

check('criterion 2: guarded for absence -- with no IntersectionObserver defined at all, the page still hydrates and the bar simply stays floating', () => {
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

check('criterion 2: the rail moves live over SSE -- the round a push collapses into history loses its rail, the round it opens gets its own, matching server markup for each', () => {
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
// Rider fix, unrelated to the timer (spec criterion 8): the send bar's
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
// Criterion 6 (rail's half): "... none of this appears in a read-only archive
// opened from disk." Same rigor as test/check-archive.mjs's own .mode-toggle/
// .back-to-index checks: the CSS rule's exact wording, plus proof the rail is
// structurally PRESENT in the archive's markup (one page, live or archived --
// readonly hides by CSS, never by omitting server-side) rather than computing a
// cascade the stand-in cannot run for an arbitrary selector (QUIRKS.md "The
// stand-in's getComputedStyle has no CSS engine behind it").
// =====================================================================================

check('criterion 6 (rail half): body.readonly hides .round-end by exact rule, and a real file:// archive still carries the rail structurally', () => {
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

check('criterion 6 (docking half): the docking observer never runs in a read-only archive -- belt and suspenders alongside .send-bar\'s own display:none', () => {
  const board = createBoard({ title: 'Round end - archive dock', blocks: [Q1] });
  const html = renderBoardPage(board);
  const { document, observers } = loadBoardWithIntersectionObserver(html, 'file:');
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: expected file:// to produce a readonly document');
  const rail = document.querySelector('.round-end');
  assert.equal(observerWatching(observers, rail), null, 'setupSendBarDock must bail out under readonly -- no observer should ever be attached to the rail in an archive');
  assert.equal(observers.length, 1, 'only the round badge\'s own observer should exist under readonly -- setupSendBarDock must return before constructing one at all');
});

// =====================================================================================
// "The page ends where the last control is" (spec chunk, 2026-08-05). Root cause:
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

check('criterion 1/8: .board-shell carries no bottom padding -- reverting to a trailing px value (e.g. the old 128px) must fail this check', () => {
  const board = createBoard({ title: 'Flush bottom - open round', blocks: [Q1, Q2] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const shell = document.querySelector('.board-shell');
  assert.ok(shell, 'setup failure: no .board-shell rendered');
  const padding = resolveComputedProperty(styles, shell, true, 'padding');
  assert.equal(padding, '0 var(--space-5)',
    'expected .board-shell\'s padding to carry no bottom value -- a trailing px reopens the band below the send bar (or, in readonly, below the last block)');
});

check('criterion 1: .send-bar is .board-shell\'s own last element child -- nothing rendered after it that would sit in the flush-bottom padding\'s place', () => {
  const board = createBoard({ title: 'Flush bottom - last child', blocks: [Q1] });
  const html = renderBoardPage(board);
  const document = loadBoard(html);
  const shell = document.querySelector('.board-shell');
  const children = shell.children;
  const last = children[children.length - 1];
  assert.ok(last && last.classList.contains('send-bar'),
    '.send-bar must be .board-shell\'s last element child for a zero bottom padding to actually land the bar\'s own lower edge on the document\'s lower edge');
});

check('criterion 3: a read-only file:// archive (send bar hidden) shares the same zero-bottom-padding .board-shell rule -- no separate readonly override reintroduces the band below the last block', () => {
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
  const padding = resolveComputedProperty(styles, shell, true, 'padding');
  assert.equal(padding, '0 var(--space-5)',
    'the archive shares .board-shell\'s rule with the live page -- readonly must never carry its own bottom-padding override');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall round-end checks ok');
