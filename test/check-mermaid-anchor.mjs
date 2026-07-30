// Ticket 05 (DESIGN.md): "A diagram node is anchored like anything
// else." Extends the end-to-end DOM stand-in seam ticket 01 built (this repo's
// standard for criterion 8: a check that drives the REAL src/ui.mjs client
// script, not just the pure module underneath it -- see DESIGN.md's own
// Testing section and this ticket's instructions for why that distinction is
// the whole point here). test/check-pure.mjs covers resolveMermaidAnchor's
// precedence as a pure function; this file covers the actual click gesture and
// the three render states a mermaid block can be in.
//
// Covers:
//   - criterion 1 (partial, completing it): clicking a diagram node in comment
//     mode opens its block's comment form with a `mermaid` anchor carrying a
//     node-id ref, a generic domRef, AND a hint naming the node -- the same
//     "reference plus human hint" shape every other element-level anchor
//     already carries (criterion 6).
//   - one gesture, toggle-gated everywhere (ticket 03's product decision,
//     extended to mermaid by this ticket): with comment mode off, clicking a
//     diagram node opens no comment form. The CSS half of "no hover, no pointer
//     cursor" is a pure :hover/:not() rule with no JS involved for mermaid
//     (unlike the html stage's or the generic listener's JS-tracked hover) --
//     test/check-pure.mjs asserts that rule's exact, comment-mode-gated text;
//     this stand-in has no CSS engine to re-derive that from, so it isn't
//     re-verified here, the same documented ceiling this repo already applies
//     to drag-to-rank and text selection (test/check-comment-mode.mjs's own
//     note).
//   - the three render states src/ui.mjs's renderMermaidBlocks/wireMermaidBlock
//     must behave sanely in: rendered (svg present, click works), CDN
//     unreachable (svg null, pins still drawn from the server's verdict), and a
//     node the anchor names gone from a still-rendered diagram (resolved/lost
//     styling, again from the server, never re-derived client-side).
//
// The mermaid CDN is never actually reached here (this stand-in has no
// network): a real `window.mermaid` is supplied as a plain mock object for the
// "rendered" tests (mermaid.run() is a black box from src/ui.mjs's point of
// view -- it only needs `.querySelector('svg')` to find something afterward,
// so the mock only has to leave that much behind), and simply left undefined
// for the "CDN unreachable" tests, exactly like test/check-anchor-rerender.mjs
// already relies on: a dynamic `import('https://...')` rejects immediately in
// this sandbox (no --experimental-network-imports), caught by
// renderMermaidBlocks' own try/catch, falling through to the raw-source
// fallback -- proven end to end here, not just asserted from server-rendered
// markup, because nothing before this ticket drove that fallback's DOM output
// (as opposed to its markup) through the real client script.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

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

/** Let renderMermaidBlocks' own async chain (one `await` deep: either
 * `mermaidMod.run(...)` or the rejected CDN `import(...)`) actually settle
 * before a check reaches into the DOM it produces. A macrotask tick, not just a
 * microtask one, so it flushes reliably regardless of how many promise hops
 * either branch takes internally. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** The id shape real mermaid emits, from test/fixtures/mermaid-real-ids.json --
 * ids recorded off mermaid@11 in an actual browser rather than imagined here.
 *
 * This mock used to emit a bare `id="flowchart-A-12"`, and that one wrong
 * assumption is what let the whole diagram gesture ship dead: mermaid 11
 * namespaces every node id with the diagram's own svg id
 * (`mermaid-<n>-flowchart-<node>-<seq>`), so the shipped `^flowchart-` prefix
 * matched nothing in any browser while this file stayed green. Deriving the mock's
 * ids from the recorded fixture is the binding that stops that recurring: to change
 * the shape these checks assume, you have to change a file that says, in its own
 * text, that it was copied out of a browser. */
const REAL = JSON.parse(readFileSync(new URL('./fixtures/mermaid-real-ids.json', import.meta.url), 'utf8'));
const SVG_ID = REAL.svgId;
/** Build the generated element id for a source-declared node id, mermaid 11 style.
 * The sequence number is mermaid's own, incremented globally across every diagram
 * on a real page -- deliberately never 0 here, so a check that hardcoded a `-0`
 * suffix would not quietly pass. */
const nodeDomId = (declared, seq) => `${SVG_ID}-flowchart-${declared}-${seq}`;

function mockMermaid() {
  return {
    initialize() {},
    async run(opts) {
      (opts.nodes || []).forEach(n => {
        n.innerHTML = ''
          + `<svg id="${SVG_ID}">`
          + `<g class="node" id="${nodeDomId('A', 12)}"><rect></rect><text class="nodeLabel">Start</text></g>`
          + `<g class="node" id="${nodeDomId('B', 13)}"><rect></rect><text class="nodeLabel">End</text></g>`
          + '</svg>';
      });
    },
  };
}

/** Parse `pageHtml` and run the real `ui` client script against it, exactly
 * like every other DOM-stand-in check in this repo (test/check-click.mjs's
 * loadBoard is the original) -- a fresh document every call, plus an optional
 * `window.mermaid` and a flush() so renderMermaidBlocks' async work has
 * actually landed before the caller touches the result. */
async function loadBoard(pageHtml, mermaidMock) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  if (mermaidMock) window.mermaid = mermaidMock;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  await flush();
  return document;
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle button rendered on the board page');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: clicking the toggle did not turn comment mode on');
}

const DIAGRAM_SOURCE = 'flowchart LR\n  A[Start] --> B[End]';

const board = createBoard({
  title: 'Ticket 05 -- a diagram node takes a comment',
  blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

/** The rendered mock diagram's node A -- the element a click should land on
 * (its own <rect>, not the <g> itself, to prove the click handler's
 * MERMAID_NODE_SELECTOR walk-up actually runs, not just a direct hit). */
function findNodeAClickTarget(document) {
  // Scoped to pre.mermaid specifically, not just '.mermaid-block svg': the
  // block-kicker's own comment-button icon (src/render.mjs's COMMENT_ICON) is
  // ALSO an inline <svg>, and sits earlier in document order than the diagram.
  const svg = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(svg, 'setup failure: the mermaid mock did not leave an <svg> behind');
  // By exact generated id: looking it up the way the shipped selector does would
  // make this helper agree with a broken selector by construction.
  const g = svg.querySelector(`[id="${nodeDomId('A', 12)}"]`);
  assert.ok(g, 'setup failure: no node A rendered by the mermaid mock');
  const rect = g.children.find(c => c.tagName === 'RECT');
  return rect || g;
}

// --- criterion 1 (partial) / criterion 6: the click gesture, end to end -------

await check('comment mode: clicking a diagram node opens its block\'s comment form with a mermaid anchor carrying a node-id ref, a generic domRef, and a hint naming the node', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const target = findNodeAClickTarget(document);

  target.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, 'setup failure: no comment-form for the mermaid block');
  assert.equal(form.classList.contains('open'), true, 'clicking a diagram node in comment mode must open its block\'s comment form');
  assert.equal(form.getAttribute('data-anchor-kind'), 'mermaid');

  const ref = form.getAttribute('data-anchor-ref');
  assert.equal(ref, 'A', 'the node-id ref must be recovered from the clicked node\'s own generated id (mermaid 11 prefixes it with the diagram\'s svg id), via its closest MERMAID_NODE_SELECTOR ancestor');

  const domRef = form.getAttribute('data-anchor-domref');
  assert.ok(domRef && domRef.length > 0, `expected a non-empty generic dom-path ref alongside the node id, got ${JSON.stringify(domRef)}`);

  const hint = form.getAttribute('data-anchor-label');
  assert.ok(hint && hint.length > 0, `expected a non-empty, human-readable hint naming the clicked node, got ${JSON.stringify(hint)}`);
  assert.match(hint, /start/i, `expected the hint to name node A's own label, got ${JSON.stringify(hint)}`);
});

await check('comment mode: submitting the opened form drops a numbered, non-lost pin into the diagram\'s pin-layer, same as every other element-level gesture', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const target = findNodeAClickTarget(document);
  target.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  const input = form.querySelector('input[type=text]');
  input.value = 'rename this node';
  form.dispatchEvent(new StandInEvent('submit'));

  const section = document.querySelector('.mermaid-block');
  const layer = section.querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin after queueing one comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'a freshly-queued comment must not render as lost');

  // Ticket 07 (DESIGN.md), audit finding V1: position asserted, not just
  // presence -- renderMermaidPins' formula (`hostBox.left - wrapBox.left +
  // hostBox.width / 2`, `... + hostBox.height / 2`, src/ui.mjs) recomputed here
  // independently from the actual clicked node and the actual pin-layer, using
  // the same real (if not pixel-real) getBoundingClientRect the stand-in gives
  // every element -- see test/dom-stand-in.mjs's own comment on that method.
  // `host` is the node ANCESTOR the click handler's own `target.closest(...)`
  // resolves to (src/ui.mjs's wireMermaidBlock), not `target` itself --
  // findNodeAClickTarget deliberately clicks the node's <rect>, one level below
  // that, to prove the walk-up actually runs.
  const host = target.closest(`[id="${nodeDomId('A', 12)}"]`);
  assert.ok(host, 'setup failure: the clicked node has no generated-id ancestor');
  const hostBox = host.getBoundingClientRect();
  const wrapBox = layer.getBoundingClientRect();
  const expectedLeft = hostBox.left - wrapBox.left + hostBox.width / 2;
  const expectedTop = hostBox.top - wrapBox.top + hostBox.height / 2;
  assert.equal(pins[0].style.left, expectedLeft + 'px', `expected the pin's left to be computed from node A's own box, got ${JSON.stringify(pins[0].style.left)}`);
  assert.equal(pins[0].style.top, expectedTop + 'px', `expected the pin's top to be computed from node A's own box, got ${JSON.stringify(pins[0].style.top)}`);
});

// --- ticket 05's own precedence, proven by POSITION, not just by which ref -----
// wins (src/anchor.mjs's "ticket 05 design" comment: the generic domRef is tried
// FIRST for positioning, against the live SVG; the node-id/[id^="flowchart-"] scan
// is a fallback). Ordinary fixtures never distinguish the two paths, because a
// unique id only ever finds one candidate either way -- audit finding V1: deleting
// ui.mjs:485-491's whole "try domRef first" branch caused ZERO check failures.
// Mermaid is known to reuse an id across a repeated subgraph/cluster shape in real
// diagrams, so this constructs exactly that: two live nodes sharing the SAME
// generated id, at two different (and therefore, under the stand-in's layout
// model, two DIFFERENT) tree positions. Only the domRef path can land on the
// specific one that was actually clicked; the id-scan fallback always finds
// whichever comes first in document order, which here is the WRONG one.

function mockMermaidDuplicateIds() {
  return {
    initialize() {},
    async run(opts) {
      (opts.nodes || []).forEach(n => {
        n.innerHTML = ''
          + `<svg id="${SVG_ID}">`
          + `<g class="node" id="${nodeDomId('A', 12)}"><rect></rect><text class="nodeLabel">Start-outer</text></g>`
          + `<g class="cluster"><g class="node" id="${nodeDomId('A', 12)}"><rect></rect><text class="nodeLabel">Start-inner</text></g></g>`
          + '</svg>';
      });
    },
  };
}

await check('comment mode: a pin\'s position comes from the SPECIFIC element clicked (via domRef), not just the first live node sharing its node id -- proves ticket 05\'s "try domRef first" branch actually does something (ablation: deleting it makes this fail)', async () => {
  const dupBoard = createBoard({
    title: 'Ticket 07 -- domRef precedence, proven by position',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const dupBlockId = dupBoard.blocks[0].id;
  const dupHtml = renderBoardPage(dupBoard);

  const document = await loadBoard(dupHtml, mockMermaidDuplicateIds());
  enableCommentMode(document);

  const svg = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(svg, 'setup failure: the mermaid mock did not leave an <svg> behind');
  const candidates = svg.querySelectorAll(`[id="${nodeDomId('A', 12)}"]`);
  assert.equal(candidates.length, 2, 'setup failure: expected two nodes sharing the same generated id');
  const [outerG, innerG] = candidates;
  const outerBox = outerG.getBoundingClientRect();
  const innerBox = innerG.getBoundingClientRect();
  assert.notEqual(outerBox.top, innerBox.top, 'setup failure: the two duplicate-id nodes must sit at distinguishable positions under the stand-in\'s layout model');

  // Click the SECOND (nested/cluster) node specifically -- its own <rect>, to
  // prove the click handler's own closest() walk-up lands on it, not the first.
  const innerRect = innerG.children.find(c => c.tagName === 'RECT');
  innerRect.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + dupBlockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: clicking the inner node did not open the comment form');
  const input = form.querySelector('input[type=text]');
  input.value = 'about the inner node specifically';
  form.dispatchEvent(new StandInEvent('submit'));

  const layer = document.querySelector('.mermaid-block .pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1);

  const wrapBox = layer.getBoundingClientRect();
  const expectedLeft = innerBox.left - wrapBox.left + innerBox.width / 2;
  const expectedTop = innerBox.top - wrapBox.top + innerBox.height / 2;
  const wrongLeft = outerBox.left - wrapBox.left + outerBox.width / 2; // what the id-scan fallback alone would produce
  assert.notEqual(expectedLeft, wrongLeft, 'setup failure: the two candidate positions must differ, or this check cannot distinguish them');
  assert.equal(pins[0].style.left, expectedLeft + 'px', `the pin must be positioned at the SPECIFIC (inner) node that was clicked, not the first node sharing its id, got ${JSON.stringify(pins[0].style.left)}`);
  assert.equal(pins[0].style.top, expectedTop + 'px');
});

// --- one gesture, toggle-gated everywhere (ticket 03's decision, extended) ----

await check('comment mode off: clicking a diagram node opens no comment form -- a diagram node is no longer a standing exception', async () => {
  const document = await loadBoard(pageHtml, mockMermaid()); // comment mode never enabled
  const target = findNodeAClickTarget(document);

  target.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.classList.contains('open'), false,
    'with comment mode off, clicking a diagram node must not open a comment form');
});

// --- the three render states -----------------------------------------------

await check('rendered: an already-persisted, resolved mermaid comment draws its pin once the (mocked) diagram renders', async () => {
  const resolvedBoard = createBoard({
    title: 'Ticket 05 -- an existing resolved mermaid comment, rendered state',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const resolvedBlockId = resolvedBoard.blocks[0].id;
  applySubmit(resolvedBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId: resolvedBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'pre-existing comment on node A' }],
  }, 1);
  const html = renderBoardPage(resolvedBoard);

  const document = await loadBoard(html, mockMermaid());
  const section = document.querySelector('.mermaid-block');
  const layer = section.querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin for the pre-existing comment, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-lost'), false, 'a still-resolving mermaid anchor must not render as lost');
});

await check('CDN unreachable: pins still render from the server\'s verdict, resolved and lost alike, with no live SVG to position against', async () => {
  const cdnBoard = createBoard({
    title: 'Ticket 05 -- CDN unreachable still shows pins',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const cdnBlockId = cdnBoard.blocks[0].id;
  applySubmit(cdnBoard, {
    action: 'send',
    answers: [],
    comments: [
      { blockId: cdnBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'still resolves by node id' },
      { blockId: cdnBlockId, anchor: { kind: 'mermaid', ref: 'Ghost', domRef: '99.99', hint: 'a node this diagram never declared' }, text: 'lost both ways' },
    ],
  }, 1);
  const html = renderBoardPage(cdnBoard);

  // No window.mermaid supplied: the dynamic import of the CDN module rejects in
  // this sandbox (no network), exercising the exact fallback path
  // DESIGN.md requires src/ui.mjs to behave sanely in.
  const document = await loadBoard(html, null);

  const section = document.querySelector('.mermaid-block');
  assert.ok(section, 'setup failure: no mermaid block rendered');
  // Scoped past the block-kicker's own comment-button icon (also an inline
  // <svg>, see findNodeAClickTarget's comment above) -- the diagram itself
  // must have rendered nothing live to query here.
  assert.equal(section.querySelectorAll('.stage-wrap svg').length, 0, 'setup failure: this check must exercise the NO-live-svg path');
  const missing = section.querySelector('.missing');
  assert.ok(missing, 'the CDN-unreachable fallback must show the raw-source note, not render nothing');

  const layer = section.querySelector('.pin-layer');
  assert.ok(layer, 'setup failure: the mermaid block has no pin-layer even without a live diagram');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 2, `expected both comments to still get a pin with no live SVG, got ${pins.length}`);
  const lostPins = pins.filter(p => p.classList.contains('pin-lost'));
  assert.equal(lostPins.length, 1, 'exactly one of the two anchors must render lost -- the one whose node id was never declared');
  assert.ok(String(lostPins[0].title || '').indexOf('a node this diagram never declared') !== -1,
    `expected the lost pin's title to carry the stored hint, got ${JSON.stringify(lostPins[0].title)}`);
});

await check('rendered, but the node the anchor names is gone from THIS diagram: still draws a lost pin from the server\'s verdict, not a live-DOM guess', async () => {
  const goneBoard = createBoard({
    title: 'Ticket 05 -- node the anchor names is gone',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const goneBlockId = goneBoard.blocks[0].id;
  applySubmit(goneBoard, {
    action: 'send',
    answers: [],
    // A node id this diagram's source never declared -- as if the node this
    // comment named was renamed/removed since the comment was minted.
    comments: [{ blockId: goneBlockId, anchor: { kind: 'mermaid', ref: 'Removed' }, text: 'this node used to exist' }],
  }, 1);
  const html = renderBoardPage(goneBoard);

  const document = await loadBoard(html, mockMermaid()); // the mock only ever renders nodes A and B
  const section = document.querySelector('.mermaid-block');
  const layer = section.querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].classList.contains('pin-lost'), true, 'a comment naming a node no longer in the diagram must render lost');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mermaid-anchor checks ok');
