// "Mermaid diagrams are drawn in the active theme after a switch, and
// comment pins already placed on a diagram still point at the same nodes
// afterwards." This file covers the FIRST half -- the diagram itself
// following the theme -- end to end through the real src/theme.mjs boot
// script and the real src/ui.mjs client script running together, exactly as
// they do on a real page (one script in <head>, one deferred module script
// near the end of <body>). The SECOND half (pin survival across the redraw)
// is covered in test/check-mermaid-anchor.mjs, the file that already owns
// every other mermaid-anchoring assertion -- see the section appended
// there.
//
// Covers:
//   - mermaid's themeVariables are read from LIVE computed style (not
//     reintroduced hardcoded literals) and actually differ between the two
//     themes, checked against the palette objects src/styles.mjs exports so a
//     palette edit cannot silently desynchronize the diagram from the page.
//   - darkMode flips with the theme rather than staying pinned true.
//   - every pre.mermaid on the page is re-run on a switch, not just the
//     first -- the specific bug shape a source-restore/marker-clear mistake
//     that only touched nodes[0] would produce.
//   - cycling the theme control repeatedly does not stack click handlers on a
//     diagram (QUIRKS.md's "every resize would stack another click handler"
//     hazard, from a different trigger), asserted directly against the
//     listener count AND behaviourally (one click still queues exactly one
//     comment after six switches).
//
// About the mermaid mock (read test/check-mermaid-anchor.mjs's own header
// comment too): mockMermaidThemeAware below emits real-shaped, PREFIXED ids
// (test/fixtures/mermaid-real-ids.json) exactly like that file's mockMermaid,
// but additionally has to behave correctly across MULTIPLE renders of the
// SAME node -- the one new thing a theme switch actually exercises. It skips
// a node already marked 'data-processed' (proving src/ui.mjs clears that
// marker before a redraw, not just that something runs) and refuses to render
// a node whose text isn't real diagram source (proving src/ui.mjs restores
// the stashed original source first -- a node still carrying its own
// rendered-SVG-derived text, e.g. "StartEnd", fails this the same way a real
// mermaid parse error would). A mock that always redraws unconditionally
// would stay green even if src/ui.mjs never restored anything.
//
// The mock above this comment used to be
// `async` in name only -- its body was a fully synchronous forEach, so it
// could never interleave two calls, and every check up to this point in the
// file drives exactly one `click(); await flush();` at a time. That is
// EXACTLY the shape that let D1 (concurrent redraws corrupt a diagram) and D2
// (a redraw overlapping the initial render permanently drops a diagram to a
// '.missing' fallback) ship green: nothing in this file could ever express
// "two passes in flight at once". mockMermaidThemeAware below now yields for
// real between (and mid-) node, the same two places real mermaid 11 does --
// claiming 'data-processed' before its own per-node await, and clearing
// innerHTML before ITS first await -- so a test that fires two clicks with NO
// await between them can actually land one pass's write inside the other's
// gap, the way a real double-tap does. The sections below "D1/D2" exercise
// exactly that.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoard, addRound, applySubmit, resolveComment } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock } from '../src/render.mjs';
import { ui, MERMAID_TOKEN_MAP } from '../src/ui.mjs';
import { themeBootScript, THEME_CHANGE_EVENT } from '../src/theme.mjs';
import { palettes } from '../src/styles.mjs';
import { MERMAID_NODE_SELECTOR, parseMermaidDomId } from '../src/anchor.mjs';
import { parseHTML, StandInEvent, StandInEventSource, Element } from './dom-stand-in.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** See test/check-mermaid-anchor.mjs's own comment on why this exists: lets a
 * check's async assertions run after renderMermaidBlocks'/redrawMermaidForTheme's
 * own async chain (mermaidMod.run(), or the theme-switch redraw it triggers)
 * has actually settled, not just been kicked off. Now that mockMermaidThemeAware
 * (below) yields for real between and mid-node -- and src/ui.mjs's own
 * queueMermaidTask defers a whole pass's start until every earlier one has
 * resolved -- a single macrotask tick is no longer enough for a multi-node,
 * possibly multi-pass chain to fully settle; this chains many ticks instead
 * of guessing one long delay, so it resolves as soon as everything is
 * actually idle regardless of how many nodes or overlapping passes a given
 * check exercises. */
function flush(ticks = 40) {
  return new Promise(resolve => {
    let n = 0;
    (function tick() {
      n++;
      if (n > ticks) { resolve(); return; }
      setTimeout(tick, 0);
    })();
  });
}

const REAL = JSON.parse(readFileSync(new URL('./fixtures/mermaid-real-ids.json', import.meta.url), 'utf8'));
const BASE_TS = Number(REAL.svgId.match(/\d+$/)[0]);

const DIAGRAM_SOURCE = 'flowchart LR\n  A[Start] --> B[End]';

/** A distinct, real-shaped ('mermaid-<digits>') svg id per (render call,
 * node-within-that-call) pair -- every diagram on the page gets its own id
 * even within a single run() call (mirroring real mermaid: each diagram is
 * independently generated), and every id changes again on the NEXT render
 * call, which is the fact test C below depends on. */
function svgIdFor(call, nodeIndex) {
  return 'mermaid-' + (BASE_TS + call * 1000 + nodeIndex);
}

/** A real macrotask yield -- the async boundary a concurrent, un-awaited pass
 * can land inside, the same way real mermaid's own internal awaits do. */
function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Unlike the ORIGINAL version of this mock (an
 * `async` function whose body was a fully synchronous forEach, so `run()`
 * always resolved within the same microtask turn it was called in, and two
 * calls could therefore never interleave), this one processes nodes ONE AT A
 * TIME with a real `await tick()` in two places per node -- exactly where
 * real mermaid 11 yields: AFTER claiming 'data-processed' but before doing
 * any drawing, and AFTER clearing innerHTML but before writing the final
 * svg. Both are read/write seams a differently-scheduled call can land
 * inside if src/ui.mjs does not serialize its own callers first.
 *
 * Also unlike the original, an unparseable node (no 'flowchart' substring --
 * either genuinely invalid source, or D1's corruption: a concurrent pass's
 * un-awaited write handing this one rendered SVG markup to parse) is no
 * longer silently skipped. Real mermaid does not throw past suppressErrors
 * for that -- it draws ITS OWN error graphic in the node and moves on,
 * permanently, with no further signal. Marked with `data-mermaid-error`
 * so a check can tell "a real diagram" apart from "mermaid's error graphic"
 * without re-parsing markup, the same way a real check would have to inspect
 * the rendered svg's shape. */
function mockMermaidThemeAware() {
  let renderCount = 0;
  const initCalls = [];
  return {
    initCalls,
    svgIdFor,
    initialize(opts) { initCalls.push(opts); },
    async run(opts) {
      renderCount++;
      const call = renderCount;
      const nodes = opts.nodes || [];
      for (let idx = 0; idx < nodes.length; idx++) {
        const n = nodes[idx];
        if (n.getAttribute('data-processed') === 'true') continue; // real mermaid: already-processed node, no-op, no yield
        // Real mermaid 11: claims the node BEFORE its own per-node await.
        n.setAttribute('data-processed', 'true');
        await tick();
        // Real mermaid's render(): reads the node's CURRENT text fresh right
        // here, not a value captured back when run() was first called.
        const source = String(n.textContent || '');
        const svgId = svgIdFor(call, idx);
        if (source.indexOf('flowchart') === -1) {
          n.innerHTML = '<svg id="' + svgId + '" class="mermaid-error-mock" data-mermaid-error="true"></svg>';
          continue;
        }
        // Real mermaid's render(): innerHTML = '' happens before ITS OWN
        // first await -- the exact seam D1's corruption depends on.
        n.innerHTML = '';
        await tick();
        n.innerHTML = ''
          + `<svg id="${svgId}">`
          + `<g class="node" id="${svgId}-flowchart-A-12"><rect></rect><text class="nodeLabel">Start</text></g>`
          + `<g class="node" id="${svgId}-flowchart-B-13"><rect></rect><text class="nodeLabel">End</text></g>`
          + '</svg>';
      }
    },
  };
}

/** Runs the REAL boot script and the REAL client script together, in the same
 * order a real page executes them (the head boot script first -- it owns
 * THEME_CHANGE_EVENT's dispatch -- then ui's own deferred module script,
 * which listens for it), against a freshly parsed document. A freshly parsed
 * document now starts `readyState === 'loading'`, so
 * `document.finishParsing()` (dom-stand-in.mjs) is needed after both scripts
 * have run to simulate the parser reaching the end of the document -- that is
 * what actually wires the theme control's click listener (themeBootScript's
 * `wire()`, deferred behind a `DOMContentLoaded` listener registered because
 * `readyState` was still 'loading' when it ran); every check below that
 * clicks the control depends on this having happened first.
 *
 * Neither script gets a real EventSource here -- nothing in this file's
 * theme-switch checks dispatches over a stream, only loadBoardWithEventSource
 * further down does that. 'EventSource' is still declared as a named
 * parameter of both `new Function` calls and simply never passed, so each
 * script sees no subscription rather than reaching past its declared scope
 * for whatever the node process itself carries under that name. */
async function loadBoard(pageHtml, mermaidMock) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  if (mermaidMock) window.mermaid = mermaidMock;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location, undefined);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, undefined);
  document.finishParsing();
  await flush();
  return document;
}

function clickThemeToggle(document) {
  const btn = document.getElementById('theme-toggle');
  assert.ok(btn, 'setup failure: no #theme-toggle rendered');
  btn.dispatchEvent(new StandInEvent('click'));
}

// =================================================================================
// 0. The stand-in's getComputedStyle now runs a real cascade
//    resolver over the ACTUAL styles text (test/dom-stand-in.mjs), not a
//    hand-copied precedence rule built from `palettes` -- so this asserts the
//    full {OS dark, OS light} x {no attribute, data-theme="light",
//    data-theme="dark"} matrix, keyed against `palettes`, reading the SAME
//    `styles` string src/render.mjs embeds verbatim on every real page.
//    Nesting the explicit override inside the media query
//    (src/styles.mjs:191-195) breaks exactly the (OS dark, data-theme="light")
//    cell -- the one case this whole feature exists for (a dark-OS reader
//    clicking the control to Light) -- and only THIS check, which reads the
//    stylesheet's own text, can notice.
// =================================================================================

check('cascade: every (OS preference, data-theme) combination resolves to the intended palette, read from the real styles text', () => {
  const board = createBoard({ title: 'Cascade matrix', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  const document = parseHTML(html);
  const window = document.defaultView;
  const docEl = document.documentElement;

  const cases = [
    { systemDark: true, attr: null, expect: 'dark' },
    { systemDark: true, attr: 'light', expect: 'light' },
    { systemDark: true, attr: 'dark', expect: 'dark' },
    { systemDark: false, attr: null, expect: 'light' },
    { systemDark: false, attr: 'light', expect: 'light' },
    { systemDark: false, attr: 'dark', expect: 'dark' },
  ];
  for (const { systemDark, attr, expect } of cases) {
    window._systemPrefersDark = systemDark;
    if (attr) docEl.setAttribute('data-theme', attr); else docEl.removeAttribute('data-theme');
    const got = window.getComputedStyle(docEl).getPropertyValue('--panel-2');
    assert.equal(got, palettes[expect]['--panel-2'],
      `OS ${systemDark ? 'dark' : 'light'} + data-theme=${attr || '(none)'} must resolve to ${expect}'s --panel-2, got "${got}"`);
  }
});

// =================================================================================
// 1. themeVariables read from LIVE computed style, differing between themes.
// =================================================================================

await check('mermaid: themeVariables are read from live computed style and differ between themes -- primaryColor is the light --panel-2 after a switch, not the dark one', async () => {
  const board = createBoard({ title: 'Theme-aware diagram', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  assert.equal(mock.initCalls.length, 1, 'setup failure: initialize must run once at first render');
  assert.equal(mock.initCalls[0].themeVariables.primaryColor, palettes.dark['--panel-2'],
    'setup failure: the page must start dark (this stand-in\'s system default) before any click');

  clickThemeToggle(document); // System -> Light
  await flush();

  assert.equal(mock.initCalls.length, 2, 'a theme switch must call initialize again with fresh variables');
  const lightVars = mock.initCalls[1].themeVariables;
  assert.equal(lightVars.primaryColor, palettes.light['--panel-2'], 'after switching to light, primaryColor must be the LIGHT --panel-2');
  assert.notEqual(lightVars.primaryColor, palettes.dark['--panel-2'], 'and must not still be the dark value');
  // A second mapped token, so this isn't one coincidental match: primaryBorderColor -> --accent.
  assert.equal(lightVars.primaryBorderColor, palettes.light['--accent']);
  assert.equal(lightVars.lineColor, palettes.light['--muted']);
});

// =================================================================================
// 2. darkMode flips.
// =================================================================================

await check('mermaid: darkMode flips with the theme, not pinned true', async () => {
  const board = createBoard({ title: 'darkMode flip', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  assert.equal(mock.initCalls[0].themeVariables.darkMode, true, 'setup failure: page must start dark by this stand-in\'s system default');

  clickThemeToggle(document); // System -> Light
  await flush();
  assert.equal(mock.initCalls[mock.initCalls.length - 1].themeVariables.darkMode, false, 'darkMode must be false once the page is explicitly light');

  clickThemeToggle(document); // Light -> Dark
  await flush();
  assert.equal(mock.initCalls[mock.initCalls.length - 1].themeVariables.darkMode, true, 'darkMode must be true again once the page is explicitly dark');
});

// =================================================================================
// 3. Every pre.mermaid on the page is re-run, not just the first.
// =================================================================================

await check('mermaid: every pre.mermaid on the page is re-run after a switch, not just the first', async () => {
  const board = createBoard({
    title: 'Two diagrams',
    blocks: [
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
    ],
  });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  const svgsBefore = document.querySelectorAll('pre.mermaid svg').map(svg => svg.getAttribute('id'));
  assert.equal(svgsBefore.length, 2, 'setup failure: both diagrams must render before any switch');
  assert.notEqual(svgsBefore[0], svgsBefore[1], 'setup failure: the two diagrams must start with distinguishable generated ids');

  clickThemeToggle(document);
  await flush();

  const svgsAfter = document.querySelectorAll('pre.mermaid svg').map(svg => svg.getAttribute('id'));
  assert.equal(svgsAfter.length, 2, 'both diagrams must still be live SVGs after the switch');
  assert.notEqual(svgsAfter[0], svgsBefore[0], 'the FIRST diagram must have been redrawn with a new generated id');
  assert.notEqual(svgsAfter[1], svgsBefore[1], 'the SECOND diagram must ALSO have been redrawn -- not just the first');
});

// =================================================================================
// 4. Cycling the control repeatedly does not stack click handlers.
// =================================================================================

await check('mermaid: cycling the theme control repeatedly does not stack click handlers on a diagram', async () => {
  const board = createBoard({ title: 'No stacking', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const blockId = board.blocks[0].id;
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  const preEl = document.querySelector('.mermaid-block pre.mermaid');
  assert.ok(preEl, 'setup failure: no pre.mermaid rendered');
  assert.equal(preEl.listeners.get('click').length, 1, 'setup failure: exactly one click listener must attach on the first render');

  // Six state changes (System -> Light -> Dark -> System -> Light -> Dark),
  // six redraws -- each one calls wireMermaidBlock again for the SAME preEl.
  for (let i = 0; i < 6; i++) {
    clickThemeToggle(document);
    await flush();
  }

  assert.equal(preEl.listeners.get('click').length, 1,
    'six theme switches must still leave exactly ONE click listener on the diagram, not one stacked per switch');

  // Behavioural proof, not just a structural count: enable comment mode,
  // click a node ONCE, submit, and confirm exactly one pin/comment results.
  // Three stacked handlers would open (and, once filled in and submitted)
  // queue the comment three times over from that single click.
  const commentToggle = document.getElementById('comment-mode-toggle');
  assert.ok(commentToggle, 'setup failure: no comment-mode toggle rendered');
  commentToggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(commentToggle.classList.contains('active'), true, 'setup failure: comment mode did not turn on');

  const svg = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(svg, 'setup failure: no live svg after cycling');
  const candidates = svg.querySelectorAll(MERMAID_NODE_SELECTOR);
  const hostA = candidates.find(el => parseMermaidDomId(el.getAttribute('id')) === 'A');
  assert.ok(hostA, 'setup failure: node A not found in the post-cycle svg');
  const rectA = hostA.children.find(c => c.tagName === 'RECT') || hostA;
  rectA.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'), 'clicking node A once must open the comment form exactly as normal, even after six theme cycles');
  const input = form.querySelector('input[type=text]');
  input.value = 'one click, one comment';
  form.dispatchEvent(new StandInEvent('submit'));

  const layer = document.querySelector('.mermaid-block .pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `a single click after six theme cycles must queue exactly one comment, got ${pins.length} pins`);
});

// =================================================================================
// 5. MERMAID_TOKEN_MAP is a real, checked mapping -- not a second unchecked
//    copy of the palette's key set (M2's root cause).
// =================================================================================

await check('mermaid: every MERMAID_TOKEN_MAP value names a real key of BOTH palettes.dark and palettes.light -- a renamed/removed token must fail HERE, not just resolve to \'\' at runtime', async () => {
  const keys = Object.keys(MERMAID_TOKEN_MAP);
  assert.ok(keys.length >= 12, 'setup failure: MERMAID_TOKEN_MAP must still carry its documented mermaid variables');
  keys.forEach(key => {
    const token = MERMAID_TOKEN_MAP[key];
    assert.ok(Object.prototype.hasOwnProperty.call(palettes.dark, token),
      `MERMAID_TOKEN_MAP.${key} names '${token}', which is not a key of palettes.dark`);
    assert.ok(Object.prototype.hasOwnProperty.call(palettes.light, token),
      `MERMAID_TOKEN_MAP.${key} names '${token}', which is not a key of palettes.light`);
  });
});

// =================================================================================
// 6. D1: two redraws started before the first settles
//    never corrupt a diagram.
// =================================================================================

await check('mermaid (D1): two redraws started before the first settles leave every diagram correctly themed, never holding SVG-as-source or mermaid\'s error graphic', async () => {
  const board = createBoard({
    title: 'D1 -- concurrent redraws',
    blocks: [
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
    ],
  });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  assert.equal(document.querySelectorAll('pre.mermaid svg').length, 2, 'setup failure: both diagrams must render before either click');

  // Two clicks with NO await between them -- the worst-case compression of
  // the measured 40-200ms window: System -> Light -> Dark.
  clickThemeToggle(document);
  clickThemeToggle(document);
  await flush();

  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'setup failure: two clicks (System -> Light -> Dark) must land on dark');

  const nodes = document.querySelectorAll('pre.mermaid');
  assert.equal(nodes.length, 2, 'D1/D2: neither diagram may be replaced with a .missing fallback by an overlapping pass');
  const calls = Array.from(nodes).map((n, i) => {
    const svg = n.querySelector('svg');
    assert.ok(svg, `diagram ${i} must hold a live svg after two overlapping redraws settle`);
    assert.notEqual(svg.getAttribute('data-mermaid-error'), 'true',
      `diagram ${i} settled on mermaid's error graphic -- D1's exact corruption: a concurrent pass's un-awaited write handed the OTHER pass rendered SVG markup to parse as if it were diagram source`);
    assert.equal(n.getAttribute('data-processed'), 'true');
    const m = (svg.getAttribute('id') || '').match(/^mermaid-(\d+)$/);
    assert.ok(m, `diagram ${i} svg id "${svg.getAttribute('id')}" is not the expected real-shaped id`);
    return Math.floor((Number(m[1]) - BASE_TS) / 1000);
  });
  assert.equal(calls[0], calls[1],
    'D1: both diagrams must be drawn by the SAME (the latest) redraw pass -- one left on an earlier, superseded pass\'s output is exactly D1\'s "stuck on a stale palette" shape');
});

await check('mermaid (D1): three theme clicks queued back to back before any settle coalesce into ONE redraw pass, not three', async () => {
  const board = createBoard({ title: 'D1 -- coalescing', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  const initCallsBefore = mock.initCalls.length; // 1, from the initial render
  clickThemeToggle(document); // System -> Light
  clickThemeToggle(document); // Light -> Dark
  clickThemeToggle(document); // Dark -> System
  await flush();

  assert.equal(document.documentElement.getAttribute('data-theme'), null, 'setup failure: three clicks (System -> Light -> Dark -> System) must land back on System');
  assert.equal(mock.initCalls.length, initCallsBefore + 1,
    `three theme clicks queued before any settled must coalesce into exactly ONE redraw pass, not one per click -- got ${mock.initCalls.length - initCallsBefore} redraw pass(es)`);
});

// =================================================================================
// 7. D2: a redraw overlapping the initial render never
//    drops a diagram that DID render to a .missing fallback.
// =================================================================================

await check('mermaid (D2): a redraw overlapping the initial render never replaces a diagram that successfully rendered with the .missing fallback', async () => {
  const board = createBoard({
    title: 'D2 -- redraw during initial render',
    blocks: [
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
    ],
  });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = parseHTML(html);
  const window = document.defaultView;
  window.mermaid = mock;
  const location = { protocol: 'http:' };
  // Inlined rather than calling loadBoard: this check needs to click BEFORE
  // the `await flush()` loadBoard itself does, to land squarely inside the
  // still-in-flight initial render. 'EventSource' declared and unpassed on
  // both calls for the same reason as loadBoard's own -- see that function's
  // comment.
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location, undefined);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, undefined);
  // Wires the theme control's click listener (see
  // loadBoard's own comment) -- synchronous, so it does not disturb the
  // still-in-flight mermaid render this check depends on below.
  document.finishParsing();
  // The initial renderMermaidBlocks(document) call the script just kicked off
  // is still mid-flight here (fire-and-forget, not yet past its own first
  // internal yield) -- click NOW, before any flush, to land a redraw request
  // squarely inside it: an ordinary reader double-tap on the control while
  // diagrams are still appearing, D2's real trigger.
  clickThemeToggle(document);
  await flush();

  const nodes = document.querySelectorAll('pre.mermaid');
  assert.equal(nodes.length, 2, 'D2: a diagram that successfully rendered must never be replaceWith()\'d out to a .missing fallback because a redraw landed mid-render');
  assert.equal(document.querySelectorAll('.missing').length, 0, 'no .missing fallback may appear for either diagram');
  nodes.forEach((n, i) => {
    const svg = n.querySelector('svg');
    assert.ok(svg, `diagram ${i} must end up with a live svg`);
    assert.notEqual(svg.getAttribute('data-mermaid-error'), 'true', `diagram ${i} must not have settled on mermaid's error graphic`);
  });
});

// =================================================================================
// 8. M1: initialize runs before EVERY run(), not just the
//    very first ever.
// =================================================================================

/** Same shape as test/check-anchor-push.mjs's own helper of the same name --
 * reimplemented locally (this file has no reason to import a sibling check
 * file) so a check here can push a follow-up round exactly the way a real
 * server broadcast does. */
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

/** Like loadBoard above, but declares 'EventSource' as a named parameter of the
 * `ui` call and passes it a captured, stubbed instance (test/check-anchor-push.mjs's
 * loadBoardWithEventSource, reimplemented locally for the same reason as
 * buildRoundPushPayload above) so a check can `.dispatch('round', ...)` a
 * follow-up round. themeBootScript never reads the name at all, so its own
 * call still declares 'EventSource' but never passes anything for it, same as
 * loadBoard above. Does not flush -- callers control that themselves. */
function loadBoardWithEventSource(pageHtml, mermaidMock) {
  let captured = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); captured = this; }
  }
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  if (mermaidMock) window.mermaid = mermaidMock;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location, undefined);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, CapturingEventSource);
  document.finishParsing(); // see loadBoard's own comment
  assert.ok(captured, 'setup failure: the real ui script never constructed an EventSource -- fix the fixture (readonly must be false), not this file');
  return { document, es: captured, window };
}

await check('mermaid (M1): initialize runs before EVERY run(), not just the very first ever -- a round pushed after a theme switch, with nothing in between to redraw, still gets the CURRENT palette', async () => {
  // Round 1: a real diagram, rendered by the mock -- mermaidMod is set and
  // initialize runs ONCE with the page's starting (dark) palette. Critically,
  // this makes mermaidMod non-null going forward, which is exactly the
  // condition the old '!mermaidMod'-gated initialize used to treat as
  // "already configured, never again".
  const board = createBoard({ title: 'M1', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const mock = mockMermaidThemeAware();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board), mock);
  await flush();

  assert.ok(document.querySelector('pre.mermaid svg'), 'setup failure: round 1\'s diagram must actually render');
  assert.equal(mock.initCalls.length, 1, 'setup failure: initialize must run once at first render');
  assert.equal(mock.initCalls[0].themeVariables.primaryColor, palettes.dark['--panel-2'], 'setup failure: round 1 must be drawn dark');

  // Now the diagram leaves the page by some route OTHER than a mermaid
  // failure (an amend, a resolve error, anything) -- a parse failure is one
  // concrete scenario, but the mechanism this test
  // isolates is simpler and more general: WHATEVER the reason, once zero
  // pre.mermaid remain, a theme switch has no redraw work to do, and mermaidMod
  // is already non-null.
  document.querySelector('pre.mermaid').replaceWith();
  assert.equal(document.querySelectorAll('pre.mermaid').length, 0, 'setup failure: the diagram must be gone from the page');

  // Reader switches to Light. redrawMermaidForTheme's qsa finds zero
  // pre.mermaid and returns immediately -- correct; M1 is fixed by round 2's
  // OWN render pass below re-initializing, not by this early return doing
  // anything different.
  clickThemeToggle(document);
  await flush();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have switched the page to light');
  assert.equal(mock.initCalls.length, 1, 'setup failure: the redraw must have found nothing to do and not called initialize again');

  // Round 2 arrives over SSE with a fresh valid diagram -- applyRoundPush's
  // 'new-round' branch calls renderMermaidBlocks on just the inserted node.
  // mermaidMod is STILL the same, already-non-null engine from round 1.
  const round2 = addRound(board, { blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const round2BlockId = board.blocks.find(b => b.round === round2).id;
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, round2, 'new-round', [round2BlockId])));
  await flush();

  const svg = document.querySelector('pre.mermaid svg');
  assert.ok(svg, 'setup failure: round 2\'s valid diagram must actually render');
  assert.equal(mock.initCalls.length, 2,
    'M1: round 2\'s render pass must call initialize AGAIN even though mermaidMod already existed from round 1 -- gating initialize behind "only the first time the engine loads" is the exact bug');
  const liveVars = mock.initCalls[mock.initCalls.length - 1].themeVariables;
  assert.equal(liveVars.primaryColor, palettes.light['--panel-2'],
    'M1: round 2 must be initialized (and therefore drawn) with the CURRENT light palette');
  assert.notEqual(liveVars.primaryColor, palettes.dark['--panel-2'],
    'M1\'s exact failure: a round arriving with nothing in between to trigger a redraw drawn in the STALE palette from whenever the engine first loaded');
});

// =================================================================================
// AC 6 (security lows): the window.mermaid clobber must not PERMANENTLY poison
// mermaidMod. test/check-mermaid-anchor.mjs's own clobber check proves round 1
// degrades honestly (no crash, the raw-source fallback); this proves the sharper
// half M1 (above) already exercises the machinery for -- mermaidMod is cached
// across rounds, so accepting a clobber by truthiness (the OLD `window.mermaid
// || ...` shape) would have wedged EVERY later round's diagram too, silently,
// for the rest of the page's life, on an element that has nothing to do with
// mermaid. The fix (looksLikeMermaidEngine, src/ui.mjs) means round 1 rejecting
// the clobber must leave mermaidMod exactly as able to pick up a real engine
// later as if round 1 had never run at all.
// =================================================================================

await check('the window.mermaid clobber does not permanently poison mermaidMod -- a later round, once the slot holds a real engine, still renders', async () => {
  const board = createBoard({ title: 'AC 6 -- clobber must not wedge later rounds', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  // A real Element, exactly the shape test/check-mermaid-anchor.mjs's own
  // clobber check uses -- truthy, no run/initialize.
  const clobber = new Element('div');
  clobber.setAttribute('id', 'mermaid');
  const { document, es, window } = loadBoardWithEventSource(renderBoardPage(board), clobber);
  await flush();

  assert.ok(document.querySelector('.mermaid-block .missing'), 'setup failure: round 1 must take the engine-unavailable fallback against a clobbering element');
  assert.equal(document.querySelectorAll('pre.mermaid svg').length, 0, 'setup failure: round 1 must not have rendered a live diagram');

  // The slot now holds a REAL (mocked) engine -- standing in for whatever
  // legitimately ends up there later on a real page (the vendored script's own
  // load, which this stand-in cannot simulate settling -- see
  // test/dom-stand-in.mjs's own comment on why a dynamically inserted <script
  // src> always fails here). Round 2 arrives over SSE with its own fresh
  // diagram, exactly like M1's push above.
  const mock = mockMermaidThemeAware();
  window.mermaid = mock;
  const round2 = addRound(board, { blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const round2BlockId = board.blocks.find(b => b.round === round2).id;
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, round2, 'new-round', [round2BlockId])));
  await flush();

  const svg = document.querySelector('pre.mermaid svg');
  assert.ok(svg, 'round 2 must render a real diagram -- if round 1\'s clobber had been cached as "the engine" (the old truthy-only shape), this render would still be reaching for a DOM element\'s own nonexistent .initialize/.run, exactly as it did in round 1');
  assert.equal(mock.initCalls.length, 1, 'the real engine must have been initialized for round 2 -- proving round 2 actually drove the real mock, not silently no-oping against whatever round 1 left in mermaidMod');
});

// =================================================================================
// 9. M2: an unresolvable token aborts the redraw BEFORE
//    the destructive restore -- diagrams stay live SVGs, never stripped to
//    raw source.
// =================================================================================

await check('mermaid (M2): an unresolvable/renamed token aborts the redraw before touching the DOM -- diagrams stay live SVGs, never stripped to raw source', async () => {
  const board = createBoard({
    title: 'M2 -- unresolved token',
    blocks: [
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
      { kind: 'mermaid', text: DIAGRAM_SOURCE },
    ],
  });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);

  const svgIdsBefore = document.querySelectorAll('pre.mermaid svg').map(svg => svg.getAttribute('id'));
  assert.equal(svgIdsBefore.length, 2, 'setup failure: both diagrams must render before the simulated rename');
  const initCallsBefore = mock.initCalls.length;

  // Simulate MERMAID_TOKEN_MAP naming a custom property src/styles.mjs no
  // longer defines: getComputedStyle keeps working for every OTHER token,
  // but '--accent' (primaryBorderColor AND nodeBorder both map to it)
  // resolves to '' -- exactly what an unresolved custom property does.
  const window = document.defaultView;
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = function (el) {
    const real = realGetComputedStyle(el);
    return {
      getPropertyValue(prop) {
        if (prop === '--accent') return '';
        return real.getPropertyValue(prop);
      },
    };
  };

  clickThemeToggle(document); // would normally redraw both diagrams System -> Light
  await flush();

  assert.equal(mock.initCalls.length, initCallsBefore,
    'M2: initialize must NOT be called with an unresolved token -- the redraw must abort before it, not throw inside it');
  const nodes = document.querySelectorAll('pre.mermaid');
  assert.equal(nodes.length, 2);
  nodes.forEach((n, i) => {
    assert.equal(n.getAttribute('data-processed'), 'true',
      `M2: diagram ${i}'s data-processed must not have been cleared -- that is the destructive restore this abort exists to skip`);
    assert.ok(n.querySelector('svg'), `M2: diagram ${i} must still hold its live (old-palette) svg, never stripped back to raw source`);
  });
  const svgIdsAfter = document.querySelectorAll('pre.mermaid svg').map(svg => svg.getAttribute('id'));
  assert.deepEqual(svgIdsAfter, svgIdsBefore, 'M2: an aborted redraw must not have touched the diagrams at all');
});

// =================================================================================
// 10. H4: the System branch is exercised for real -- a live
//     OS preference flip while System is in force re-applies the theme (via
//     the real cascade, not a hand-copied one) and fires THEME_CHANGE_EVENT
//     exactly once, driving a mermaid redraw; the same flip is correctly
//     IGNORED while an explicit override is in force. Uses the existing,
//     previously-uncalled scaffolding (StandInWindow._setSystemPrefersDark)
//     -- test/dom-stand-in.mjs needed no changes for this, only a caller.
// =================================================================================

await check('mermaid (H4): the OS preference flipping while System is in force fires the theme-change event exactly once and redraws every diagram in the new palette', async () => {
  const board = createBoard({ title: 'H4 -- system flip', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);
  const window = document.defaultView;

  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the page must start in System mode');
  assert.equal(mock.initCalls[0].themeVariables.primaryColor, palettes.dark['--panel-2'], 'setup failure: System defaults to the stand-in\'s dark OS preference');

  let changeFired = 0;
  window.addEventListener(THEME_CHANGE_EVENT, () => { changeFired++; });

  window._setSystemPrefersDark(false); // a live OS flip to light, System still in force
  await flush();

  assert.equal(changeFired, 1, 'the OS flip must fire the theme-change event exactly once');
  const lastVars = mock.initCalls[mock.initCalls.length - 1].themeVariables;
  assert.equal(lastVars.primaryColor, palettes.light['--panel-2'], 'the mermaid redraw must follow the OS flip to the new (light) palette');
  assert.notEqual(lastVars.primaryColor, palettes.dark['--panel-2']);
  assert.equal(lastVars.darkMode, false, 'darkMode must flip too, not stay pinned to the page\'s starting value');
});

await check('mermaid (H4): the OS preference flipping is correctly ignored while an explicit override is in force -- no event, no redraw, override untouched', async () => {
  const board = createBoard({ title: 'H4 -- ignored while override', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);
  const window = document.defaultView;

  clickThemeToggle(document); // System -> Light: an explicit override now in force
  await flush();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have set an explicit override');
  const initCallsBefore = mock.initCalls.length;

  let changeFired = 0;
  window.addEventListener(THEME_CHANGE_EVENT, () => { changeFired++; });
  window._setSystemPrefersDark(true); // the OS flips to dark -- must be ignored while Light is explicit

  assert.equal(changeFired, 0, 'the OS flip must be ignored entirely while an explicit override is in force -- no theme-change event');
  assert.equal(mock.initCalls.length, initCallsBefore, 'and therefore no redraw either');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'the explicit override must remain in force, untouched by the OS');
});

// =================================================================================
// 8. An OPEN diagram lens rethemes with the page.
//
//    The lens holds a cloneNode(true) of the inline
//    svg, and a redraw REPLACES that svg with a new element. The two features
//    were built on separate branches, so nothing connected them: measured in
//    Chrome, switching to Light with the lens open left the lens's
//    node rects at rgb(24, 32, 47) with rgb(234, 238, 246) labels -- a dark
//    diagram inside light chrome -- while the inline diagram behind the dialog
//    had correctly become light. Fixed by lensRetheme (src/ui.mjs).
//
//    Reachable without the control: a modal <dialog> makes it inert, but
//    src/theme.mjs also dispatches on a live OS switch while System is in force,
//    which is what `_setSystemPrefersDark` drives below.
// =================================================================================

await check('the lens: a theme switch while the lens is OPEN re-clones the redrawn diagram, keeps the view, and keeps the pins', async () => {
  const board = createBoard({ title: 'Lens retheme', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  const blockId = board.blocks[0].id;
  // A SENT comment on node A, so the lens has a real pin to lose.
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [{ blockId, anchor: { kind: 'mermaid', ref: 'A', hint: 'Start' }, text: 'this node needs a name' }],
  }, 1);
  const html = renderBoardPage(board);
  const mock = mockMermaidThemeAware();
  const document = await loadBoard(html, mock);
  const window = document.defaultView;

  const inlineBefore = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(inlineBefore, 'setup failure: the diagram never rendered');

  const expand = document.querySelector('.mermaid-block .expand-btn');
  assert.ok(expand, 'setup failure: no .expand-btn rendered');
  expand.dispatchEvent(new StandInEvent('click'));
  const canvas = document.querySelector('.diagram-lens .lens-canvas');
  assert.ok(canvas, 'setup failure: the lens did not open');
  assert.equal(canvas.querySelector('svg').getAttribute('id'), inlineBefore.getAttribute('id'),
    'setup failure: the lens must open holding a clone of the CURRENT inline svg');
  const pinsBefore = document.querySelectorAll('.diagram-lens .anchor-pin');
  assert.equal(pinsBefore.length, 1, 'setup failure: the sent comment must pin inside the lens before any switch');
  const transformBefore = canvas.style.transform;
  const pctBefore = document.querySelector('.diagram-lens .lens-pct').textContent;
  assert.ok(transformBefore, 'setup failure: the lens must have applied a view transform on open');

  // The OS flips while System is in force -- the one path that reaches an open,
  // modal lens at all.
  // The stand-in starts dark, so a flip to LIGHT is the one that actually
  // changes anything -- and it is also the direction the defect was found in.
  window._setSystemPrefersDark(false);
  await flush();

  const inlineAfter = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.notEqual(inlineAfter.getAttribute('id'), inlineBefore.getAttribute('id'),
    'setup failure: the switch must actually have redrawn the inline diagram');

  const lensSvgs = document.querySelectorAll('.diagram-lens .lens-canvas svg');
  assert.equal(lensSvgs.length, 1, `the lens canvas must hold exactly one diagram after a retheme, got ${lensSvgs.length}`);
  assert.equal(lensSvgs[0].getAttribute('id'), inlineAfter.getAttribute('id'),
    'the open lens is still showing a clone of the svg the redraw replaced -- it must be re-cloned from the freshly redrawn one, or the reviewer sees a dark diagram inside light chrome');

  assert.equal(canvas.style.transform, transformBefore,
    'the reviewer\'s pan/zoom must survive a retheme they did not ask for -- the source is unchanged, so the layout is unchanged and there is nothing to refit');
  assert.equal(document.querySelector('.diagram-lens .lens-pct').textContent, pctBefore,
    'and the zoom readout must agree with the transform it reports');

  const layer = document.querySelector('.diagram-lens .pin-layer');
  assert.ok(layer && layer.parentElement === canvas,
    'the pin layer must still be a child of the canvas -- re-cloning must not orphan it inside the replaced svg\'s place');
  assert.equal(document.querySelectorAll('.diagram-lens .anchor-pin').length, 1,
    'the pin must be redrawn against the NEW clone: renderLensPins measures positions off the very element the retheme just replaced');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mermaid-theme checks ok');
