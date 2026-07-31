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
import { themeBootScript } from '../src/theme.mjs';
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

// --- SPEC_POLISH.md ticket 05: the diagram lens ------------------------------
//
// Criterion 10: "a mermaid block carries an expand control that opens the diagram
// in a full-viewport lens: drag pans, scroll zooms, with fit and 1:1 controls."
// Criterion 11: "a mermaid node can be commented on from inside the lens, and
// that comment is the same comment as one minted inline -- same anchor, and its
// pin appears on the inline diagram after Send."
//
// The pan/zoom ARITHMETIC is checked as pure functions in test/check-pure.mjs
// (src/lens.mjs); what is checked here is the half that has no meaning without a
// tree: that the control exists and opens the thing, that the lens genuinely
// CLONES the SVG (so this file's checks run under the same duplicate-id
// condition a browser is under -- asserted, not assumed), and that a click
// inside the lens mints byte-for-byte the anchor an inline click on the same
// node mints. That last one is the whole ticket: "same anchor" is checked by
// minting BOTH and comparing, not by re-deriving what the anchor ought to be.

/** The expand control src/render.mjs renders into every mermaid block's kicker. */
function findExpandControl(document) {
  return document.querySelector('.mermaid-block .expand-btn');
}

/** Open the lens on the page's only diagram and hand back its parts. */
function openLens(document) {
  const btn = findExpandControl(document);
  assert.ok(btn, 'setup failure: no .expand-btn rendered on the mermaid block');
  btn.dispatchEvent(new StandInEvent('click'));
  const dlg = document.querySelector('.diagram-lens');
  assert.ok(dlg, 'clicking the expand control must open the lens dialog');
  assert.equal(dlg.hasAttribute('open'), true, 'the lens dialog must actually be open after the expand control is clicked');
  return {
    dlg,
    canvas: document.querySelector('.diagram-lens .lens-canvas'),
    stage: document.querySelector('.diagram-lens .lens-stage'),
    svg: document.querySelector('.diagram-lens .lens-canvas svg'),
  };
}

/** The four attributes openCommentForm writes -- the entire minted anchor, as the
 * submit handler will read it back off the form. */
function anchorOnForm(document, blockId) {
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, 'setup failure: no comment-form for the block');
  return {
    open: form.classList.contains('open'),
    kind: form.getAttribute('data-anchor-kind'),
    ref: form.getAttribute('data-anchor-ref'),
    domRef: form.getAttribute('data-anchor-domref'),
    hint: form.getAttribute('data-anchor-label'),
  };
}

await check('criterion 10: a mermaid block carries an expand control, and clicking it opens a lens holding a CLONE of the diagram -- with fit and 1:1 controls', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  assert.equal(document.querySelectorAll('.diagram-lens').length, 0, 'the lens must not exist before it is asked for -- it is built lazily on the first expand');

  const lens = openLens(document);
  assert.ok(lens.svg, 'the lens canvas must hold an SVG');

  // The clone, asserted as a clone rather than assumed: the same generated node
  // id is now present TWICE in this document. That is the condition every
  // id-based lookup in the lens has to survive (the spec's named trap), so a
  // check that did not establish it would be testing an easier page than the
  // browser renders.
  const idA = nodeDomId('A', 12);
  assert.equal(document.querySelectorAll(`[id="${idA}"]`).length, 2,
    'with the lens open, a mermaid node id must exist twice in the document -- once inline, once in the clone');
  const inlineSvg = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.notEqual(lens.svg, inlineSvg, 'the lens must show a CLONE, never the live SVG moved out of the block');
  assert.ok(inlineSvg.querySelector(`[id="${idA}"]`), 'the inline diagram must still hold its own nodes -- the lens must not have stolen them');

  const actions = document.querySelectorAll('.diagram-lens .lens-btn').map(b => b.getAttribute('data-lens'));
  assert.deepEqual(actions, ['fit', 'one', 'close'], `criterion 10 names fit and 1:1 controls; got ${JSON.stringify(actions)}`);
  // The percentage readout comes from the applied view, so it doubles as proof
  // that a view was actually applied to the canvas on open.
  assert.equal(document.querySelector('.diagram-lens .lens-pct').textContent, '100%');
  assert.match(String(document.querySelector('.diagram-lens .lens-canvas').style.transform || ''), /^translate\(.*\) scale\(1\)$/);
});

await check('criterion 10: the expand control is the ONLY way in -- clicking the diagram itself never opens the lens, in either mode', async () => {
  // The spec's Decision: "the click gesture on a diagram keeps its current
  // meaning in both modes". /explain's lens opens on a diagram click, and
  // copying that would have silently taken the comment gesture's click away.
  const document = await loadBoard(pageHtml, mockMermaid());
  findNodeAClickTarget(document).dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelectorAll('.diagram-lens').length, 0, 'with comment mode off, clicking a diagram node must not open the lens');

  enableCommentMode(document);
  findNodeAClickTarget(document).dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelectorAll('.diagram-lens').length, 0, 'with comment mode on, clicking a diagram node must comment, not open the lens');
  assert.equal(anchorOnForm(document, blockId).open, true, 'and that click must still open the comment form, exactly as before this ticket');
});

await check('criterion 11: an anchor minted from INSIDE the lens is byte-identical to one minted by clicking the same node inline -- ref, domRef and hint alike', async () => {
  // Both minted for real, from the same page, and compared. Nothing here
  // re-derives what the anchor "should" be, because that is precisely how a lens
  // anchor could end up self-consistently wrong (a domRef rooted at the lens
  // canvas resolves against nothing the server ever re-renders).
  const inlineDoc = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(inlineDoc);
  findNodeAClickTarget(inlineDoc).dispatchEvent(new StandInEvent('click'));
  const inlineAnchor = anchorOnForm(inlineDoc, blockId);
  assert.equal(inlineAnchor.open, true, 'setup failure: the inline click did not open the form');
  assert.ok(inlineAnchor.domRef && inlineAnchor.domRef.length, 'setup failure: the inline click minted no domRef to compare against');

  const lensDoc = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(lensDoc);
  const lens = openLens(lensDoc);
  const clonedRect = lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT');
  assert.ok(clonedRect, 'setup failure: node A did not survive into the clone');
  clonedRect.dispatchEvent(new StandInEvent('click'));

  const lensAnchor = anchorOnForm(lensDoc, blockId);
  assert.equal(lensAnchor.open, true, 'clicking a node inside the lens must open the block\'s comment form');
  assert.deepEqual(lensAnchor, inlineAnchor,
    'a lens-minted anchor must be the same anchor an inline click mints -- same kind, same node-id ref, same page-scoped domRef, same hint');
});

await check('criterion 11: the form a lens comment is typed into is the block\'s OWN form, moved into the lens -- one form, one submit handler, one queue', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const formBefore = document.getElementById('comment-form-' + blockId);
  openLens(document);
  const formDuring = document.getElementById('comment-form-' + blockId);
  assert.equal(formDuring, formBefore, 'the lens must host the same form element, not a copy of it');
  assert.equal(document.querySelectorAll('#comment-form-' + blockId).length, 1, 'exactly one form with that id may exist at a time');
  assert.ok(formDuring.closest('.diagram-lens'), 'while the lens is open the form must live inside it -- a showModal()d dialog makes everything behind it inert');

  document.querySelector('.diagram-lens .lens-btn[data-lens="close"]').dispatchEvent(new StandInEvent('click'));
  assert.equal(document.querySelector('.diagram-lens').hasAttribute('open'), false, 'the close control must close the lens');
  const formAfter = document.getElementById('comment-form-' + blockId);
  assert.equal(formAfter, formBefore, 'closing the lens must give the block back its own form element');
  assert.ok(formAfter.closest('.comment-area, .mermaid-block'), 'and put it back inside the block it came from');
  assert.equal(formAfter.closest('.diagram-lens'), null, 'the form must not be left stranded inside the closed dialog');
});

await check('criterion 11: a comment minted in the lens lands its pin on the INLINE diagram, positioned on the node that was clicked', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);
  lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'commented from inside the lens';
  form.dispatchEvent(new StandInEvent('submit'));

  // The pin on the block's own diagram -- the thing criterion 11 actually
  // promises ("its pin appears on the inline diagram"). Position recomputed
  // independently from the INLINE node A and the INLINE pin-layer, exactly as
  // the pre-existing inline-click check above does, so a pin drawn against the
  // clone's coordinates (or against the wrong node entirely) fails here.
  const section = document.querySelector('.mermaid-block');
  const layer = section.querySelector('.stage-wrap .pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin on the inline diagram, got ${pins.length}`);
  assert.equal(pins[0].classList.contains('pin-pending'), true, 'a queued comment\'s pin is hollow until it is sent, whichever surface queued it');

  const inlineHost = section.querySelector(`.stage-wrap [id="${nodeDomId('A', 12)}"]`);
  const hostBox = inlineHost.getBoundingClientRect();
  const wrapBox = layer.getBoundingClientRect();
  assert.equal(pins[0].style.left, (hostBox.left - wrapBox.left + hostBox.width / 2) + 'px');
  assert.equal(pins[0].style.top, (hostBox.top - wrapBox.top + hostBox.height / 2) + 'px');

  // ...and the queued comment is one comment, in the one queue, carrying the
  // mermaid anchor -- not a second parallel kind minted by a second path.
  const items = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(items.length, 1, `expected exactly one queued comment entry, got ${items.length}`);
  assert.equal(items[0].getAttribute('data-anchor-kind'), 'mermaid');
  assert.equal(items[0].getAttribute('data-anchor-ref'), 'A');
});

await check('criterion 11: the lens draws that same pin too, inside the zoom transform and counter-scaled so it stays 20px on screen', async () => {
  // The spec's Decision: "Pins in the lens live inside the zoom transform,
  // counter-scaled. scale(1/s) on each pin keeps it 20px on screen while panning
  // and zooming move it for free." Both halves are structural and checkable
  // here: WHERE the layer sits, and WHAT transform each pin carries.
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);
  lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'pinned in the lens as well';
  form.dispatchEvent(new StandInEvent('submit'));

  const lensCanvas = document.querySelector('.diagram-lens .lens-canvas');
  const lensLayer = document.querySelector('.diagram-lens .lens-canvas .pin-layer');
  assert.ok(lensLayer, 'the lens must have a pin-layer of its own');
  assert.equal(lensLayer.parentElement, lensCanvas,
    'the lens pin-layer must be a DIRECT child of .lens-canvas -- INSIDE the transform, so a pan/zoom moves every pin for free rather than needing a pointer-move recompute');
  const lensPins = lensLayer.querySelectorAll('.anchor-pin');
  assert.equal(lensPins.length, 1, `expected the queued comment to be pinned in the lens too, got ${lensPins.length}`);
  assert.match(String(lensPins[0].style.transform || ''), /^translate\(-50%, -50%\) scale\([\d.]+\)$/,
    'every lens pin must carry its own counter-scale, or it grows with the diagram and buries the node it points at');
});

/** The `scale(s)` lensApply last wrote onto the canvas. */
function lensScale(document) {
  const t = String(document.querySelector('.diagram-lens .lens-canvas').style.transform || '');
  const m = /scale\((-?[\d.]+)\)/.exec(t);
  assert.ok(m, `expected a scale() on the lens canvas, got ${JSON.stringify(t)}`);
  return Number(m[1]);
}

// --- criterion 10's "scroll zooms", behaviourally ----------------------------
//
// Every existing lens check asserted `scale(1)`, which this stand-in produces no
// matter what lensDoFit does (its getBoundingClientRect is a fold over sibling
// indices, so stage and diagram measure the same and lensFit always returns 1).
// So "scroll zooms" and "double-click zooms" were both assertable only as
// `scale(1)` staying `scale(1)` -- i.e. three handlers could each be replaced by
// an empty body and the whole suite stayed green. What IS reachable here is the
// arithmetic those handlers run, which is what these drive: dispatch the event,
// read the scale back off the canvas, demand it moved in the right direction.

await check('criterion 10: a wheel event over the lens actually zooms -- the scale changes, and in the direction the wheel asked for', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  const lens = openLens(document);
  const start = lensScale(document);

  lens.stage.dispatchEvent(new StandInEvent('wheel', { deltaY: -100, clientX: 200, clientY: 200 }));
  const zoomedIn = lensScale(document);
  assert.ok(zoomedIn > start, `a wheel UP must zoom in: ${start} -> ${zoomedIn}`);
  assert.equal(document.querySelector('.diagram-lens .lens-pct').textContent, Math.round(zoomedIn * 100) + '%',
    'the percentage readout must follow the actual scale, not a remembered constant');

  lens.stage.dispatchEvent(new StandInEvent('wheel', { deltaY: 100, clientX: 200, clientY: 200 }));
  const zoomedBack = lensScale(document);
  assert.ok(zoomedBack < zoomedIn, `a wheel DOWN must zoom out: ${zoomedIn} -> ${zoomedBack}`);
  assert.ok(Math.abs(zoomedBack - start) < 1e-9, 'and one notch each way must land back where it started');
});

await check('criterion 10: a double-click on the lens zooms in by 2x about the cursor', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  const lens = openLens(document);
  const start = lensScale(document);
  lens.stage.dispatchEvent(new StandInEvent('dblclick', { clientX: 150, clientY: 90 }));
  assert.ok(Math.abs(lensScale(document) - start * 2) < 1e-9,
    `double-click must double the scale: ${start} -> ${lensScale(document)}`);
});

await check('the dialog\'s own close event tears the lens down -- Esc must not strand the block\'s comment form inside a hidden dialog, permanently', async () => {
  // The failure this rules out is unrecoverable without a reload, which is why
  // it gets a check of its own: Esc is handled by the BROWSER, which closes the
  // <dialog> and only then fires 'close'. With no listener on that event,
  // lens.open stays true, lensReturnAdopted() never runs, the block's
  // .comment-form and .comment-target are left behind a now-hidden dialog with
  // a bare <span class="lens-slot"> standing where they belong -- and lensOpen's
  // own 'if (l.open) return' re-entry guard then makes the expand control dead
  // for the rest of the page's life. Every other lens check drove the CLOSE
  // BUTTON, which calls lensTeardown directly and so passes either way.
  const document = await loadBoard(pageHtml, mockMermaid());
  const formBefore = document.getElementById('comment-form-' + blockId);
  const lens = openLens(document);
  assert.ok(formBefore.closest('.diagram-lens'), 'setup failure: the form was not adopted into the lens');
  assert.equal(document.querySelectorAll('.lens-slot').length, 2, 'setup failure: expected a placeholder for each adopted element');

  // Exactly what the browser does for Esc: hide the dialog itself, then fire
  // 'close' -- never lensClose(), which is the path the close BUTTON takes.
  lens.dlg.removeAttribute('open');
  lens.dlg.dispatchEvent(new StandInEvent('close'));

  const formAfter = document.getElementById('comment-form-' + blockId);
  assert.equal(formAfter, formBefore, 'the block must get its own form element back');
  assert.equal(formAfter.closest('.diagram-lens'), null, 'and it must not be left stranded inside the dialog');
  assert.equal(document.querySelectorAll('.lens-slot').length, 0, 'every placeholder must have been replaced by the element it stood for');

  // ...and the lens is genuinely reusable afterwards, which is the half the
  // re-entry guard would otherwise silently take away.
  const reopened = openLens(document);
  assert.equal(reopened.dlg.hasAttribute('open'), true, 'the expand control must still open the lens after an Esc close');
  assert.ok(document.getElementById('comment-form-' + blockId).closest('.diagram-lens'),
    'and the form must be adopted again, exactly as on the first open');
});

// --- the pan threshold, BEHAVIOURALLY (audit finding D5) ---------------------
//
// test/check-pure.mjs already pins the SHAPE of this handler -- that the pointer
// capture is taken from pointermove and only after `lensDragMoved = true`. That
// check was green throughout, and the gesture was still broken in Chrome, which
// is the entire reason these three live here instead: the defect was not in
// which statements the handler contains but in WHICH QUANTITY its threshold
// measures. `drag.x/y` was reassigned on every move, so `dx/dy` was the delta
// since the PREVIOUS EVENT and the 3px gate asked "did this one frame move more
// than 3px" rather than "has the pointer left the press point". A 120px pan
// delivered as sixty 2px moves -- an ordinary slow drag, and what a trackpad
// actually emits -- never crossed it: no dragging state, no pointer capture
// (same dead branch), and the click at the end opened the comment form on a node
// the pan had merely travelled past. Dispatched here as the real event sequence,
// with the assertion on the OUTCOME.
//
// What this stand-in still cannot see is named rather than implied: it has no
// pointer capture, so the capture half of that branch remains structural-only
// (QUIRKS.md's entry on what a capture steals is the record of why it matters),
// and no hit-testing, so the final click is dispatched at the node directly
// rather than derived from where the pointer stopped. Neither is what D5 turned
// on. The accumulated arithmetic is, and that is now driven for real.

/** The `translate(Xpx, Ypx)` half of whatever lensApply last wrote onto the
 * canvas -- the lens's current pan, read back out of the DOM rather than out of
 * an internal the client script never exposes. */
function lensPan(document) {
  const t = String(document.querySelector('.diagram-lens .lens-canvas').style.transform || '');
  const m = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(t);
  assert.ok(m, `expected a translate() on the lens canvas, got ${JSON.stringify(t)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

const PRESS = { clientX: 200, clientY: 200, pointerId: 7, button: 0 };

await check('finding D5: a slow 120px pan (sixty 2px moves) is understood as a DRAG from the moment it leaves the press point, not per frame', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);
  const before = lensPan(document);

  lens.stage.dispatchEvent(new StandInEvent('pointerdown', PRESS));
  assert.equal(lens.stage.classList.contains('lens-dragging'), false, 'a press on its own is not yet a pan');

  // Move one step at a time so the exact moment the threshold flips is
  // observable. Cumulative travel after step n is 2n px, so 3px is passed at
  // step 2 -- while NO single step ever moves more than 2px, which is precisely
  // what the per-event version could not see.
  const seen = [];
  for (let i = 1; i <= 60; i++) {
    lens.stage.dispatchEvent(new StandInEvent('pointermove', { clientX: 200 + i * 2, clientY: 200, pointerId: 7 }));
    seen.push(lens.stage.classList.contains('lens-dragging'));
  }
  assert.equal(seen[0], false, 'after one 2px move the pointer has travelled 2px -- still a click');
  assert.equal(seen[1], true, 'after two 2px moves it has travelled 4px -- past the 3px threshold, so this is a pan');
  assert.equal(seen[59], true, 'and it must still be a pan 120px later');

  const after = lensPan(document);
  assert.equal(after.x - before.x, 120,
    'the canvas must pan by the whole accumulated travel -- each frame contributes its own delta, so the pan and the threshold read two different quantities and both must be right');
  assert.equal(after.y - before.y, 0, 'a purely horizontal pan must not drift vertically');
});

await check('finding D5: the click that ends a slow pan must not queue a comment on the node it merely dragged past', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);

  lens.stage.dispatchEvent(new StandInEvent('pointerdown', PRESS));
  for (let i = 1; i <= 60; i++) {
    lens.stage.dispatchEvent(new StandInEvent('pointermove', { clientX: 200 + i * 2, clientY: 200, pointerId: 7 }));
  }
  lens.stage.dispatchEvent(new StandInEvent('pointerup', { pointerId: 7 }));
  assert.equal(lens.stage.classList.contains('lens-dragging'), false, 'releasing must end the dragging state');

  // The click a real browser fires after that pointerdown/pointerup pair, on
  // whatever the pointer ended up over -- here a node the pan travelled past.
  lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));

  assert.equal(anchorOnForm(document, blockId).open, false,
    'a pan that happens to end over a node must open no comment form -- this is the defect, dispatched exactly as Chrome delivered it');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and must queue nothing');
});

await check('finding D5: a press that only jitters is still a CLICK -- the threshold must suppress pans without swallowing the comment gesture', async () => {
  // The other direction, and the reason the fix is a threshold rather than "any
  // movement at all is a drag": a real click almost always carries a pixel or
  // two of pointer movement between press and release.
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);

  lens.stage.dispatchEvent(new StandInEvent('pointerdown', PRESS));
  lens.stage.dispatchEvent(new StandInEvent('pointermove', { clientX: 201, clientY: 202, pointerId: 7 }));
  lens.stage.dispatchEvent(new StandInEvent('pointermove', { clientX: 202, clientY: 201, pointerId: 7 }));
  lens.stage.dispatchEvent(new StandInEvent('pointerup', { pointerId: 7 }));
  assert.equal(lens.stage.classList.contains('lens-dragging'), false, '2px of jitter is not a pan');

  lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));
  assert.equal(anchorOnForm(document, blockId).ref, 'A',
    'a click with a couple of pixels of jitter must still comment on the node it landed on');
});

await check('criterion 11 + ticket 02 criterion 1: a second click on the same node inside the lens reopens the queued comment instead of adding a duplicate', async () => {
  const document = await loadBoard(pageHtml, mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);
  const clonedRect = () => lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT');

  clonedRect().dispatchEvent(new StandInEvent('click'));
  const form = document.getElementById('comment-form-' + blockId);
  form.querySelector('input[type=text]').value = 'first thought';
  form.dispatchEvent(new StandInEvent('submit'));
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 1);

  clonedRect().dispatchEvent(new StandInEvent('click'));
  const reopened = document.getElementById('comment-form-' + blockId);
  assert.ok(reopened.getAttribute('data-editing-id'), 'the reopened form must be stamped with the queued entry it is editing');
  assert.equal(reopened.querySelector('input[type=text]').value, 'first thought', 'and prefilled with what was already written');
  reopened.querySelector('input[type=text]').value = 'second thought';
  reopened.dispatchEvent(new StandInEvent('submit'));

  const items = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(items.length, 1, `editing must replace, not add -- got ${items.length} queued comments`);
  assert.ok(String(items[0].textContent || '').indexOf('second thought') !== -1, 'the queued comment must carry the edited text');
});

await check('criterion 11 + ticket 02 criterion 12: a node that already carries a SENT comment is inert in the lens, exactly as it is inline', async () => {
  const sentBoard = createBoard({
    title: 'Ticket 05 -- a sent comment is immutable in the lens too',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const sentBlockId = sentBoard.blocks[0].id;
  applySubmit(sentBoard, {
    action: 'send',
    answers: [],
    comments: [{ blockId: sentBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'already sent' }],
  }, 1);

  const document = await loadBoard(renderBoardPage(sentBoard), mockMermaid());
  enableCommentMode(document);
  const lens = openLens(document);

  // The de-affordance class rides into the lens on the clone itself -- stamped
  // on the live diagram by wireMermaidBlock, and copied by cloneNode -- rather
  // than being recomputed by a second code path in here.
  const clonedA = lens.svg.querySelector(`[id="${nodeDomId('A', 12)}"]`);
  assert.equal(clonedA.classList.contains('cb-anchor-sent'), true,
    'the cloned node must carry the sent-comment de-affordance class the live one carries');

  clonedA.children.find(c => c.tagName === 'RECT').dispatchEvent(new StandInEvent('click'));
  assert.equal(anchorOnForm(document, sentBlockId).open, false, 'clicking a node with a sent comment must do nothing, in the lens as inline');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queue nothing');

  // Node B has no sent comment, so it is still a target -- otherwise this check
  // would pass just as well against a lens whose click handler was dead.
  lens.svg.querySelector(`[id="${nodeDomId('B', 13)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));
  assert.equal(anchorOnForm(document, sentBlockId).ref, 'B', 'an un-commented node must still be clickable in the lens');
});

await check('the cloned-id trap: with two nodes sharing one generated id, a lens click anchors the node ACTUALLY clicked -- resolved against the lens root, never the document', async () => {
  // The spec names this trap rather than leaving it to be discovered: a clone
  // carries duplicate element ids, so an id lookup against `document` is
  // ambiguous between the two copies. Here the ambiguity is quadrupled on
  // purpose -- the diagram itself declares node A twice (mermaid does this for a
  // repeated subgraph shape), so with the lens open the SAME id names four live
  // elements. Only a structural, root-scoped path can name the right one.
  const dupBoard = createBoard({
    title: 'Ticket 05 -- the lens and duplicate node ids',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const dupBlockId = dupBoard.blocks[0].id;
  const dupHtml = renderBoardPage(dupBoard);

  // The inline answer to compare against: click the INNER duplicate inline.
  const inlineDoc = await loadBoard(dupHtml, mockMermaidDuplicateIds());
  enableCommentMode(inlineDoc);
  const inlineCandidates = inlineDoc.querySelectorAll(`.mermaid-block pre.mermaid svg [id="${nodeDomId('A', 12)}"]`);
  assert.equal(inlineCandidates.length, 2, 'setup failure: expected two inline nodes sharing one generated id');
  inlineCandidates[1].children.find(c => c.tagName === 'RECT').dispatchEvent(new StandInEvent('click'));
  const inlineAnchor = anchorOnForm(inlineDoc, dupBlockId);
  assert.ok(inlineAnchor.domRef, 'setup failure: no domRef minted inline');

  const lensDoc = await loadBoard(dupHtml, mockMermaidDuplicateIds());
  enableCommentMode(lensDoc);
  const lens = openLens(lensDoc);
  assert.equal(lensDoc.querySelectorAll(`[id="${nodeDomId('A', 12)}"]`).length, 4,
    'setup failure: this check is only meaningful while four elements share one id');
  const lensCandidates = lens.svg.querySelectorAll(`[id="${nodeDomId('A', 12)}"]`);
  assert.equal(lensCandidates.length, 2, 'setup failure: both duplicates must have survived into the clone');
  lensCandidates[1].children.find(c => c.tagName === 'RECT').dispatchEvent(new StandInEvent('click'));

  const lensAnchor = anchorOnForm(lensDoc, dupBlockId);
  assert.deepEqual(lensAnchor, inlineAnchor,
    'clicking the SECOND duplicate in the lens must mint the same anchor as clicking the second duplicate inline -- if the id were resolved against the document, or the step-path built from the lens canvas, this is where it goes wrong');

  // And the pin lands on the second inline node, not the first -- the same
  // by-position proof the inline duplicate-id check above uses.
  const form = lensDoc.getElementById('comment-form-' + dupBlockId);
  form.querySelector('input[type=text]').value = 'the inner one specifically';
  form.dispatchEvent(new StandInEvent('submit'));
  const layer = lensDoc.querySelector('.mermaid-block .stage-wrap .pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1);
  const wrapBox = layer.getBoundingClientRect();
  const innerBox = inlineCandidates[1].getBoundingClientRect();
  const outerBox = inlineCandidates[0].getBoundingClientRect();
  assert.notEqual(innerBox.left, outerBox.left, 'setup failure: the two duplicates must sit at distinguishable positions');
  assert.equal(pins[0].style.left, (innerBox.left - wrapBox.left + innerBox.width / 2) + 'px',
    'the pin must land on the node the lens click actually landed on');
});

await check('CDN unreachable: the expand control removes itself rather than offering to open an empty lens', async () => {
  const document = await loadBoard(pageHtml, null); // no window.mermaid, no network
  assert.ok(document.querySelector('.mermaid-block .missing'), 'setup failure: this check must exercise the raw-source fallback');
  assert.equal(findExpandControl(document), null, 'with no rendered SVG there is nothing to expand, so the control must be gone');
});

// --- readonly: view-only, per the spec's own Decision --------------------------
// "The lens is view-only under body.readonly. Pan and zoom work in a standalone
// archive (pure JS, no network, consistent with the archive's guarantee); the
// comment gesture inside it is gated exactly like every other comment gesture."

async function loadReadonlyBoard(html, mermaidMock) {
  const document = parseHTML(html);
  const window = document.defaultView;
  if (mermaidMock) window.mermaid = mermaidMock;
  new Function('document', 'window', 'location', ui)(document, window, { protocol: 'file:' });
  await flush();
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: the page did not enter readonly mode');
  return document;
}

await check('readonly: the expand control survives the hard-disable pass every other button gets, and still opens the lens', async () => {
  const document = await loadReadonlyBoard(pageHtml, mockMermaid());
  const btn = findExpandControl(document);
  assert.ok(btn, 'the expand control must still be rendered in a standalone archive');
  assert.equal(btn.disabled, false,
    'readonly hard-disables every input-capable element; the expand control is the one deliberate exception, because pan and zoom must work in an archive');
  // Every other button on the page still IS disabled -- so this is an exception,
  // not a hole in the readonly pass.
  assert.equal(document.querySelector('.comment-btn').disabled, true);

  btn.dispatchEvent(new StandInEvent('click'));
  const dlg = document.querySelector('.diagram-lens');
  assert.ok(dlg && dlg.hasAttribute('open'), 'the lens must open in a standalone archive');
  assert.ok(document.querySelector('.diagram-lens .lens-canvas svg'), 'and show the diagram');
  assert.deepEqual(
    document.querySelectorAll('.diagram-lens .lens-btn').map(b => b.getAttribute('data-lens')),
    ['fit', 'one', 'close'],
    'fit and 1:1 are view controls, so they stay available in readonly',
  );
});

await check('readonly: clicking a node inside the lens comments on nothing, and the block\'s form is never moved in there at all', async () => {
  const document = await loadReadonlyBoard(pageHtml, mockMermaid());
  findExpandControl(document).dispatchEvent(new StandInEvent('click'));
  const lensSvg = document.querySelector('.diagram-lens .lens-canvas svg');
  assert.ok(lensSvg, 'setup failure: the readonly lens did not render the diagram');

  assert.equal(document.querySelector('.diagram-lens .lens-form-host').children.length, 0,
    'there is no comment gesture to host a form for in readonly, so nothing is moved into the lens');
  const form = document.getElementById('comment-form-' + blockId);
  assert.equal(form.closest('.diagram-lens'), null, 'the block keeps its own form where it was rendered');

  lensSvg.querySelector(`[id="${nodeDomId('A', 12)}"]`).children.find(c => c.tagName === 'RECT')
    .dispatchEvent(new StandInEvent('click'));
  assert.equal(anchorOnForm(document, blockId).open, false, 'a click inside a readonly lens must open no comment form');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queue no comment');
});

await check('readonly: an archived board still PINS its sent comments inside the lens -- view-only means the gesture is gone, not the record', async () => {
  const archived = createBoard({
    title: 'Ticket 05 -- an archived board opens its diagram in the lens',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const archivedBlockId = archived.blocks[0].id;
  applySubmit(archived, {
    action: 'send',
    answers: [],
    comments: [{ blockId: archivedBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'a comment from when this board was live' }],
  }, 1);

  const document = await loadReadonlyBoard(renderBoardPage(archived), mockMermaid());
  findExpandControl(document).dispatchEvent(new StandInEvent('click'));
  const lensPins = document.querySelectorAll('.diagram-lens .lens-canvas .pin-layer .anchor-pin');
  assert.equal(lensPins.length, 1, `an archived comment must still be pinned inside the lens, got ${lensPins.length}`);
  assert.equal(lensPins[0].classList.contains('pin-pending'), false, 'a sent comment\'s pin is solid, not hollow');
  assert.equal(lensPins[0].textContent, '1', 'and carries the server\'s own comment number');
});

// --- ticket 04 (light theme): pin survival across a theme-driven redraw -----
//
// DESIGN.md's spec decision names this criterion 8's RISKY half: "diagram
// anchors key on the source-declared node id and already strip mermaid's
// unstable generated prefix, so a re-render of unchanged source should
// preserve them. Confirm this rather than assume it." A theme switch
// (src/theme.mjs's THEME_CHANGE_EVENT, src/ui.mjs's redrawMermaidForTheme)
// redraws the SAME diagram from the SAME source into a brand-new <svg> --
// mermaid namespaces every node id with that svg's own generated id (see
// parseMermaidDomId's own comment in src/anchor.mjs), so node A's id after
// the switch is NOT node A's id before it. This section proves a pin placed
// before the switch still resolves after it, with the generated id
// DELIBERATELY different across the two renders, never coincidentally equal.

/** A second, real-shaped ('mermaid-<digits>') svg id, deliberately different
 * from SVG_ID above -- the fact this whole section exists to exercise. */
const SVG_ID_2 = 'mermaid-' + (Number(SVG_ID.match(/\d+$/)[0]) + 1);
const nodeDomId2 = (declared, seq) => `${SVG_ID_2}-flowchart-${declared}-${seq}`;

/** A theme-aware mermaid mock, local to this section: renders with
 * SVG_ID/nodeDomId the FIRST time, and -- on a second call only, i.e. the
 * redraw a theme switch triggers -- with SVG_ID_2/nodeDomId2 instead. Unlike
 * mockMermaid() above (a single static render), this one also has to behave
 * correctly across a SECOND render of the SAME node, which is the one new
 * thing a theme switch actually exercises: it skips a node already marked
 * 'data-processed' (proving src/ui.mjs clears that marker before a redraw,
 * not just that something runs) and refuses to render a node whose text
 * isn't real diagram source (proving src/ui.mjs restores the stashed
 * original source first -- a node still carrying its own rendered-SVG-derived
 * text, e.g. "StartEnd", fails this the same way a real mermaid parse error
 * would). */
function mockMermaidRedrawable() {
  let renderCount = 0;
  return {
    initialize() {},
    async run(opts) {
      renderCount++;
      const id = renderCount === 1 ? nodeDomId : nodeDomId2;
      const svgId = renderCount === 1 ? SVG_ID : SVG_ID_2;
      (opts.nodes || []).forEach(n => {
        if (n.getAttribute('data-processed') === 'true') return;
        if (String(n.textContent || '').indexOf('flowchart') === -1) return;
        n.innerHTML = ''
          + `<svg id="${svgId}">`
          + `<g class="node" id="${id('A', 12)}"><rect></rect><text class="nodeLabel">Start</text></g>`
          + `<g class="node" id="${id('B', 13)}"><rect></rect><text class="nodeLabel">End</text></g>`
          + '</svg>';
        n.setAttribute('data-processed', 'true');
      });
    },
  };
}

/** Like loadBoard above, but also runs the REAL src/theme.mjs boot script
 * first -- exactly the order a real page executes them in (the head boot
 * script, which owns THEME_CHANGE_EVENT's dispatch, before ui's own deferred
 * module script, which listens for it). loadBoard itself is left untouched:
 * every other check in this file neither needs nor exercises the theme
 * control, and this file's convention (see mockMermaidDuplicateIds above) is
 * a specialised local helper for a specialised local section, not a
 * broadened shared one. */
async function loadBoardWithTheme(pageHtml, mermaidMock) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  if (mermaidMock) window.mermaid = mermaidMock;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', themeBootScript)(document, window, location);
  new Function('document', 'window', 'location', ui)(document, window, location);
  // Audit 2026-07-31 (H2): a freshly parsed document now starts `readyState
  // === 'loading'`, so the theme control's click listener is not wired until
  // `document.finishParsing()` simulates the parser reaching the end of the
  // document (test/dom-stand-in.mjs) -- every check below that clicks the
  // control depends on this having run first.
  document.finishParsing();
  await flush();
  return document;
}

await check('ticket 04: a comment pin placed on a diagram node still resolves to the same anchor after a theme switch, even though the redraw gives the svg a genuinely different generated id -- criterion 8\'s risky half, confirmed rather than assumed', async () => {
  const themeBoard = createBoard({
    title: 'Ticket 04 -- pin survival across a theme switch',
    blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }],
  });
  const themeBlockId = themeBoard.blocks[0].id;
  const pageHtml = renderBoardPage(themeBoard);

  const document = await loadBoardWithTheme(pageHtml, mockMermaidRedrawable());
  enableCommentMode(document);

  const svgBefore = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(svgBefore, 'setup failure: no svg from the first render');
  const hostABefore = svgBefore.querySelector(`[id="${nodeDomId('A', 12)}"]`);
  assert.ok(hostABefore, 'setup failure: node A not found in the first render');
  const rectBefore = hostABefore.children.find(c => c.tagName === 'RECT') || hostABefore;
  rectBefore.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + themeBlockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: clicking node A did not open the comment form');
  assert.equal(form.getAttribute('data-anchor-ref'), 'A');
  const input = form.querySelector('input[type=text]');
  input.value = 'this must still point at node A after a theme switch';
  form.dispatchEvent(new StandInEvent('submit'));

  const layer = document.querySelector('.mermaid-block .pin-layer');
  const pinBefore = layer.querySelector('.anchor-pin');
  assert.ok(pinBefore, 'setup failure: no pin after queueing the comment');
  assert.equal(pinBefore.classList.contains('pin-lost'), false, 'setup failure: the freshly-queued pin must not be lost');

  // Switch the theme (System -> Light), which redraws the diagram via
  // mockMermaidRedrawable's SECOND call.
  const themeToggle = document.getElementById('theme-toggle');
  assert.ok(themeToggle, 'setup failure: no #theme-toggle rendered');
  themeToggle.dispatchEvent(new StandInEvent('click'));
  await flush();

  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have switched the page to light');

  const svgAfter = document.querySelector('.mermaid-block pre.mermaid svg');
  assert.ok(svgAfter, 'the diagram must still be a live svg after the switch');
  assert.notEqual(svgAfter.getAttribute('id'), svgBefore.getAttribute('id'),
    'setup failure: the redraw must produce a genuinely different generated svg id, or this check proves nothing');

  const hostAAfter = svgAfter.querySelector(`[id="${nodeDomId2('A', 12)}"]`);
  assert.ok(hostAAfter, 'setup failure: node A not found in the SECOND render');
  assert.notEqual(hostAAfter.getAttribute('id'), hostABefore.getAttribute('id'),
    'setup failure: node A\'s own generated id must differ across the two renders too');

  const pinAfter = layer.querySelector('.anchor-pin');
  assert.ok(pinAfter, 'the pin must still be there after the theme switch redrew the diagram');
  assert.equal(pinAfter.classList.contains('pin-lost'), false,
    'criterion 8: a comment pin placed before a theme switch must still resolve after it, even though the svg\'s generated id changed');
  assert.notEqual(pinAfter, pinBefore,
    'the pin layer must have been rebuilt fresh against the NEW svg (renderMermaidPins run again), not left as a stale reference from before the switch');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall mermaid-anchor checks ok');
