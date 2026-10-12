// The html-stage lens, driven end to end
// through the DOM stand-in the same way test/check-mermaid-anchor.mjs drives the
// diagram lens -- the real src/render.mjs markup, the real src/ui.mjs client
// script, a real click on the real control.
//
// Covers:
//   - the Pull-out (ADR.md entry 120): every stage and every diagram, wherever
//     it sits, carries exactly one in its frame's top-right corner, and it opens
//     the lens; a page board, a failed reference and a diagram that drew nothing
//     carry none; it stays live on a sent round and in an archive, a click on it
//     never mints a comment anchor, and comment mode hides it. It is in the
//     server-rendered markup rather than injected, so an archive carries it in
//     its own bytes. One row per placement, in the block headed "The Pull-out".
//   - the stage in the lens receives real pointer input. What that
//     means for a check with no browser is set out at that check's own comment;
//     the half that is genuinely assertable here is that nothing on the parent's
//     side makes the frame inert, asserted against the REAL stylesheet through
//     the stand-in's cascade resolver rather than against a rule's spelling.
//   - Esc and a backdrop click both close the lens, and focus goes
//     back to the control that opened it.
//   - a standalone stage is otherwise untouched -- the inline frame
//     stays where it was rendered, and its own click-to-comment gesture still
//     works after.
//
// The trust-boundary half of this feature -- the lens frame's sandbox attribute,
// that it never joins the page's '.html-stage' walk, and what happens when that
// frame speaks on the stage message channel -- lives in
// test/check-stage-isolation.mjs instead, next to the related checks it
// belongs with.
//
// What this file cannot do, stated rather than faked (QUIRKS.md "The stand-in has
// no layout"): there is no scrolling, no hit-testing and no pointer-events
// enforcement here, so "the mock can be SCROLLED in the lens" is not directly
// observable. This is therefore checked as its preconditions -- a live
// frame carrying the same document, given a real box by the stylesheet, with no
// rule making it inert -- and the last mile belongs to a browser.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, groupCommentsByBlock } from '../src/render.mjs';
import { styles } from '../src/styles.mjs';
import { parseHTML, StandInEvent, resolveComputedProperty, Element as StandInElement } from './dom-stand-in.mjs';
import { check, checkAsync, finish, flush, pageHarness } from './support.mjs';

// `checkAsync` is `check` under its old name. A row that has to wait for the
// page's mermaid pass to land (it is one await deep, src/ui.mjs's
// renderMermaidBlocks) is called with 'await', so the rows still run and report
// in file order.
const { loadBoard, loadBoardWithEventSource, enableCommentMode, click, clickThemeToggle, computed } = await pageHarness();

// A mock that is taller than any stage will ever be and runs its own script --
// the two things this is about (content that has somewhere to scroll to,
// and a document that is genuinely live rather than a picture of one).
const MOCK = '<div class="mock" style="height: 2000px"><button>Send</button>'
  + '<p>bottom of a very tall mock</p></div>'
  + '<script>window.__mockRan = (window.__mockRan || 0) + 1;</script>';

// The second block is load-bearing, not padding: a board whose blocks are ONE
// html block and nothing else is a page board (src/render.mjs's isPageBoard,
// ADR.md entry 33), which carries no kicker and no Pull-out at
// all -- the lens it would open is a copy of what already fills the
// viewport. This file is about the lens on an ORDINARY board's stage, so its
// fixture has to be an ordinary board. A fixture's shape decides which layout it
// exercises, the same way QUIRKS.md records it deciding which return path an
// `ask` fixture exercises.
const board = createBoard({
  title: 'SPEC_STAGES -- the stage lens',
  blocks: [{ kind: 'html', html: MOCK }, { kind: 'markdown', text: 'context, so this board is not a page board' }],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

function stagePullOut(document) {
  return document.querySelector('.html-block .pull-out');
}

/** Open the lens on the page's first html stage and hand back its parts. */
function openStageLens(document) {
  const btn = stagePullOut(document);
  assert.ok(btn, 'setup failure: no .pull-out rendered on the html block');
  btn.dispatchEvent(new StandInEvent('click'));
  const dlg = document.querySelector('.stage-lens');
  assert.ok(dlg, 'clicking the Pull-out must open the stage lens dialog');
  assert.equal(dlg.hasAttribute('open'), true, 'the lens dialog must actually be open after the Pull-out is clicked');
  return {
    btn,
    dlg,
    body: document.querySelector('.stage-lens .stage-lens-body'),
    frame: document.querySelector('.stage-lens .stage-lens-frame'),
  };
}

/** A board whose question is a choose-between-rendered-variants with one html
 * option -- the case the whole spec exists for, where the inline stage is inert
 * by design and the lens is the only place it becomes usable. */
function variantBoard() {
  return createBoard({
    title: 'SPEC_STAGES -- a variant option opens in the lens',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [{ label: 'Card A', block: { kind: 'html', html: MOCK } }],
    }],
  });
}

// -------------------------------------------------------------------------------

// ===============================================================================
// The Pull-out (ADR.md entry 120): one in the corner of every stage and diagram.
//
// One row per placement, over ONE fixture holding every placement at once, so a
// row cannot pass because its board happened to lack a neighbour that would have
// shown up as a second control. A Pull-out is found through the block it belongs
// to (the '.html-block'/'.mermaid-block' wrapper carrying the block id, which a
// top-level section and a context item both wear), never by document order. A
// page board, a failed reference and a diagram the engine drew nothing for are
// the three that carry none.
// ===============================================================================

const DIAGRAM = 'flowchart LR\n  A[Start] --> B[End]';

/** Every place a stage or a diagram can sit, on one ordinary board. */
function everyPlacementBoard() {
  const compare = () => ({
    kind: 'compare',
    left: { label: 'Before', block: { kind: 'html', html: MOCK } },
    right: { label: 'After', block: { kind: 'markdown', text: 'the after, in words' } },
  });
  return createBoard({
    title: 'the Pull-out, everywhere a stage or a diagram can sit',
    blocks: [
      { kind: 'html', html: MOCK },
      { kind: 'mermaid', text: DIAGRAM },
      compare(),
      {
        kind: 'question',
        prompt: 'Does this ride in the work?',
        widget: 'single',
        options: [{ label: 'Yes' }, { label: 'No' }],
        context: [{ kind: 'html', html: MOCK }, { kind: 'mermaid', text: DIAGRAM }, compare()],
      },
      {
        kind: 'question',
        prompt: 'Which mockup?',
        widget: 'choose-between-rendered-variants',
        options: [{ label: 'Card A', block: { kind: 'html', html: MOCK } }],
      },
    ],
  });
}

/** Each placement, what its frame holds, and where its block sits in the board
 * JSON. The first is the gap the decision started from: a stage inside a
 * question had no way into the lens at all. */
const PLACEMENTS = [
  { name: 'a stage in a question\'s context', kind: 'stage', id: b => b.blocks[3].context[0].id },
  { name: 'a top-level stage', kind: 'stage', id: b => b.blocks[0].id },
  { name: 'a stage on a top-level compare side', kind: 'stage', id: b => b.blocks[2].left.block.id },
  { name: 'a stage on a compare side in a question\'s context', kind: 'stage', id: b => b.blocks[3].context[2].left.block.id },
  { name: 'a rendered-variant option', kind: 'stage', id: b => b.blocks[4].options[0].block.id },
  { name: 'a top-level diagram', kind: 'diagram', id: b => b.blocks[1].id },
  { name: 'a diagram in a question\'s context', kind: 'diagram', id: b => b.blocks[3].context[1].id },
];
const STAGE_COUNT = PLACEMENTS.filter(p => p.kind === 'stage').length;

function blockEl(document, kind, id) {
  return document.querySelector(`${kind === 'stage' ? '.html-block' : '.mermaid-block'}[data-block-id="${id}"]`);
}

/** A stand-in mermaid engine that leaves an <svg> in every node it is asked to
 * draw, which is all src/ui.mjs reads back (test/check-mermaid-anchor.mjs's
 * mock, cut to that much). The svg names the block it was drawn for, so a lens
 * holding its clone can be traced back to the diagram that opened it. */
function drawingMermaid() {
  return {
    initialize() {},
    async run(opts) {
      (opts.nodes || []).forEach(n => {
        const owner = n.closest('[data-block-id]').getAttribute('data-block-id');
        n.innerHTML = `<svg data-drawn-for="${owner}"><g class="node"><rect></rect></g></svg>`;
      });
    },
  };
}

/** loadBoard, plus one macrotask tick for the page's mermaid pass to land
 * (src/ui.mjs's renderMermaidBlocks is one await deep). Takes loadBoard's own
 * options; with no `mermaid` engine there is none at all, and every diagram
 * degrades to raw source. */
async function loadSettled(html, opts = {}) {
  const document = loadBoard(html, opts);
  await flush(1);
  return document;
}

for (const placement of PLACEMENTS) {
  await checkAsync(`Pull-out: ${placement.name} carries exactly one, in its frame's top-right corner, and it opens the lens on that ${placement.kind}`, async () => {
    const placementBoard = everyPlacementBoard();
    const id = placement.id(placementBoard);
    const document = await loadSettled(renderBoardPage(placementBoard), { mermaid: drawingMermaid() });
    const el = blockEl(document, placement.kind, id);
    assert.ok(el, `setup failure: nothing rendered for ${placement.name}`);

    const controls = el.querySelectorAll('.pull-out');
    assert.equal(controls.length, 1, `${placement.name} must carry exactly one Pull-out, got ${controls.length}`);
    const control = controls[0];
    assert.equal(control.tagName, 'BUTTON', 'a real button: in the tab order, and pressable by keyboard and touch');

    // In the frame, never in a label row or a tools row: its parent is the
    // positioned wrapper around the iframe or the diagram itself.
    const wrap = control.parentElement;
    assert.equal(wrap.classList.contains('stage-wrap'), true, 'the Pull-out must sit in the frame\'s own wrapper');
    assert.ok(wrap.querySelector(placement.kind === 'stage' ? 'iframe.html-stage' : 'pre.mermaid'),
      'and that wrapper must be the one holding this block\'s frame');
    assert.equal(computed(wrap, 'position'), 'relative', 'the frame is the positioning root, so the corner is the frame\'s');
    assert.equal(computed(control, 'position'), 'absolute');
    assert.equal(computed(control, 'top'), '8px', 'top-right corner: 8px from the top');
    assert.equal(computed(control, 'right'), '8px', 'and 8px from the right');
    assert.notEqual(computed(control, 'display'), 'none', 'visible outside comment mode, with no hover needed');

    click(control);
    if (placement.kind === 'stage') {
      const dlg = document.querySelector('.stage-lens');
      assert.ok(dlg && dlg.hasAttribute('open'), 'clicking the Pull-out must open the stage lens');
      const frame = dlg.querySelector('.stage-lens-frame');
      assert.equal(frame.getAttribute('srcdoc'), el.querySelector('.html-stage').getAttribute('srcdoc'),
        'the lens must show THIS stage -- same srcdoc, byte for byte, as the block\'s own frame');
      // Full window size: the dialog covers the viewport and the frame fills it.
      assert.equal(computed(dlg, 'width'), '100vw');
      assert.equal(computed(dlg, 'height'), '100vh');
      assert.equal(computed(frame, 'width'), '100%');
      assert.equal(computed(frame, 'height'), '100%');
    } else {
      const dlg = document.querySelector('.diagram-lens');
      assert.ok(dlg && dlg.hasAttribute('open'), 'clicking the Pull-out must open the diagram lens');
      const svg = dlg.querySelector('.lens-canvas svg');
      assert.ok(svg, 'holding a diagram');
      assert.equal(svg.getAttribute('data-drawn-for'), id, 'and it must be THIS diagram, not another block\'s');
    }
  });
}

await checkAsync('Pull-out: a rendered-variant option\'s Pull-out opens the lens carrying the Pick control (ADR.md entry 22)', async () => {
  const placementBoard = everyPlacementBoard();
  const document = await loadSettled(renderBoardPage(placementBoard));
  const card = document.querySelector('.choice-variant');
  assert.ok(card, 'setup failure: no variant card rendered');
  click(card.querySelector('.pull-out'));
  assert.ok(document.querySelector('.stage-lens').hasAttribute('open'), 'setup failure: the lens did not open');
  const pick = document.querySelector('.stage-lens .lens-pick');
  assert.ok(pick, 'a lens opened from a variant option must carry the Pick control -- the card itself picks on click, so the lens is where the option is read whole and picked');
  assert.equal(pick.disabled, false, 'live on an open round outside comment mode');
});

check('Pull-out: server-rendered -- the page\'s own bytes carry exactly one per stage and diagram, naming its block, and none on any wrapper', () => {
  // A standalone archive has to carry the control in its own bytes. Parsed and
  // NOT run, so a Pull-out injected by src/ui.mjs would fail here even though
  // every behavioural row above still passed.
  const placementBoard = everyPlacementBoard();
  const document = parseHTML(renderBoardPage(placementBoard));
  const named = document.querySelectorAll('.pull-out').map(b => b.getAttribute('data-pull-out-for')).sort();
  assert.deepEqual(named, PLACEMENTS.map(p => p.id(placementBoard)).sort(),
    'one Pull-out per stage and diagram -- a compare, a question or a variant card carries none of its own');
});

check('Pull-out: a page board carries none -- its stage already fills the window', () => {
  const pageBoard = createBoard({ title: 'a page board', blocks: [{ kind: 'html', html: MOCK }] });
  const document = loadBoard(renderBoardPage(pageBoard));
  assert.equal(document.body.classList.contains('page-board'), true,
    'setup failure: one html block and nothing else must render as a page board');
  assert.equal(document.querySelectorAll('.pull-out').length, 0,
    'the lens a page board would open is a copy of what already fills the viewport');
});

check('Pull-out: a stage or a diagram whose reference failed carries none -- there is nothing to open', () => {
  // A reference that failed to resolve leaves 'error' on the block and renders
  // the error note where the frame would be, top level and in a context alike.
  const failed = everyPlacementBoard();
  const broken = [failed.blocks[0], failed.blocks[1], failed.blocks[3].context[0], failed.blocks[3].context[1]];
  for (const b of broken) {
    b.error = 'cannot read nope.html: ENOENT';
    if (b.kind === 'html') b.html = ''; else b.text = '';
  }
  const document = parseHTML(renderBoardPage(failed));
  for (const b of broken) {
    const el = blockEl(document, b.kind === 'html' ? 'stage' : 'diagram', b.id);
    assert.ok(el && el.querySelector('.resolve-error'), `setup failure: the failed ${b.kind} block did not render its error note`);
    assert.equal(el.querySelectorAll('.pull-out').length, 0, `a failed ${b.kind} reference must carry no Pull-out`);
  }
  assert.equal(document.querySelectorAll('.pull-out').length, PLACEMENTS.length - broken.length,
    'and only those lose it: every healthy stage beside them keeps its own');
});

await checkAsync('Pull-out: a diagram that drew no picture carries none -- it would open an empty lens', async () => {
  const placementBoard = everyPlacementBoard();
  const document = await loadSettled(renderBoardPage(placementBoard)); // no engine at all
  for (const p of PLACEMENTS.filter(p => p.kind === 'diagram')) {
    const el = blockEl(document, 'diagram', p.id(placementBoard));
    assert.ok(el.querySelector('.missing'), `setup failure: ${p.name} must have degraded to its raw source`);
    assert.equal(el.querySelectorAll('.pull-out').length, 0, `${p.name} that drew nothing must lose its Pull-out`);
  }
  assert.equal(document.querySelectorAll('.html-block .pull-out').length, STAGE_COUNT,
    'while every stage keeps its own -- only a diagram depends on the engine');
});

await checkAsync('Pull-out: in a saved archive every one survives the readonly pass and opens the lens, and the click mints no comment anchor', async () => {
  const placementBoard = everyPlacementBoard();
  const document = await loadSettled(renderBoardPage(placementBoard), { protocol: 'file:', mermaid: drawingMermaid() });
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: a file: page must be readonly');
  assert.equal(document.querySelector('.comment-btn').disabled, true, 'setup failure: the readonly pass must have disabled the other buttons');
  const controls = document.querySelectorAll('.pull-out');
  assert.equal(controls.length, PLACEMENTS.length, 'setup failure: every placement must still carry its Pull-out');
  for (const c of controls) assert.equal(c.disabled, false, 'the Pull-out is the lens\'s way in, and the lens is view-only in an archive, not absent');

  click(blockEl(document, 'stage', PLACEMENTS[0].id(placementBoard)).querySelector('.pull-out'));
  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'it opens the lens from the archive\'s own bytes');
  assert.equal(document.querySelectorAll('.comment-form.open').length, 0, 'and opens no comment form');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queues no comment');
});

await checkAsync('Pull-out: on a sent round every one stays live and opens the lens, and a click on it mints no comment anchor even with comment mode on', async () => {
  const placementBoard = everyPlacementBoard();
  const { document, es } = loadBoardWithEventSource(renderBoardPage(placementBoard), { mermaid: drawingMermaid() });
  await flush(1);

  // Round 1 goes to history live, the way a push does it: markRoundHistory is
  // the disable loop the carve-out lives in. Round 2 carries a stage of its own,
  // so comment mode is a state the reviewer can genuinely be in there.
  applySubmit(placementBoard, { action: 'send', answers: [], comments: [] }, 1);
  const before = placementBoard.blocks.length;
  const round2 = addRound(placementBoard, {
    blocks: [{ kind: 'html', html: MOCK }, { kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  es.dispatch('round', JSON.stringify({
    round: round2,
    mode: 'new-round',
    blockIds: placementBoard.blocks.slice(before).map(b => b.id),
    html: renderRoundSection(placementBoard, round2, groupCommentsByBlock([])),
    board: placementBoard,
  }));
  const round1 = document.querySelector('.round[data-round="1"]');
  assert.equal(round1.classList.contains('round-history'), true, 'setup failure: round 1 must have gone to history');
  assert.equal(round1.querySelector('.btn-defer').disabled, true, 'setup failure: the sent-round pass must have disabled the round\'s own controls');

  const controls = round1.querySelectorAll('.pull-out');
  assert.equal(controls.length, PLACEMENTS.length, 'setup failure: every placement on the sent round must still carry its Pull-out');
  for (const c of controls) assert.equal(c.disabled, false, 'a settled round is where a stage or a diagram gets re-read');

  const stageControl = blockEl(document, 'stage', PLACEMENTS[0].id(placementBoard)).querySelector('.pull-out');
  click(stageControl);
  assert.equal(document.querySelector('.stage-lens').hasAttribute('open'), true, 'it opens the lens on the sent round');
  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));

  // The control is page chrome: even a click that reaches it with comment mode
  // on (it is hidden then, so only a forced one can) mints nothing.
  enableCommentMode(document);
  click(stageControl);
  click(blockEl(document, 'diagram', PLACEMENTS[5].id(placementBoard)).querySelector('.pull-out'));
  assert.equal(document.querySelectorAll('.comment-form.open').length, 0, 'a click on the Pull-out must open no comment form');
  assert.equal(document.querySelectorAll('.comment-item.comment-pending').length, 0, 'and queue no comment');
});

await checkAsync('Pull-out: comment mode hides every one, and turning it off shows them again', async () => {
  // Hidden so the artifact's own top-right corner stays a comment target while
  // the reviewer is commenting -- the lens is view-only, so nothing is lost.
  const placementBoard = everyPlacementBoard();
  const document = await loadSettled(renderBoardPage(placementBoard), { mermaid: drawingMermaid() });
  const controls = document.querySelectorAll('.pull-out');
  assert.equal(controls.length, PLACEMENTS.length, 'setup failure: every placement must carry its Pull-out');
  for (const c of controls) assert.notEqual(computed(c, 'display'), 'none', 'setup failure: visible before comment mode');

  enableCommentMode(document);
  for (const c of controls) assert.equal(computed(c, 'display'), 'none', 'hidden while comment mode is on');

  click(document.getElementById('comment-mode-toggle'));
  assert.equal(document.body.classList.contains('comment-mode'), false, 'setup failure: the toggle did not turn comment mode off');
  for (const c of controls) assert.notEqual(computed(c, 'display'), 'none', 'and back the moment comment mode is off');
});

// ===============================================================================
// The Pull-out and a frame's own scrollbar (ADR.md entry 120).
//
// A classic scrollbar takes its width out of the frame's right edge, which is
// where the Pull-out sits, so on a stage that scrolls inside its frame (its mock
// taller than its box: folded at the cap, a variant option clipped there, an
// opened stage its mock has outgrown) the control moves in by that width. The
// page marks that stage's block .stage-scrolls. The page cannot see into a
// sandboxed frame, so it measures a probe box of its own, and in a shadow root:
// the board restyles its own scrollbars ('::-webkit-scrollbar', 11px), and a box
// in the page itself reports that bar, not the one a frame draws.
//
// The stand-in lays nothing out and has no shadow roots, so for the length of a
// row it is TOLD the facts the probe reads, each one measured in Chrome 154
// (headless, classic bars): a scrolling box in a shadow root is 15px wider
// outside than inside, the same box in the page itself 11px, and a box in no
// document has no size at all. What these rows prove is what the page does with
// that reading and which Pull-outs the stylesheet moves by it. That the reading
// IS the bar a frame draws is test/browser-check-stage-fold.mjs's.
// ===============================================================================

const CLASSIC_BAR = 15; // a native classic scrollbar, as a stage's frame draws it
const BOARD_BAR = 11;   // the board's own restyled one, which a box in the page gets
const PROBE_BOX = 100;

/** Run `fn` with the stand-in told how wide a scrollbar is: `scrollbar.native`
 * in a shadow root (0 is an overlay bar), BOARD_BAR in the page itself, and no
 * box at all outside a document. `fn` may change `scrollbar.native` on the way,
 * as plugging in a mouse does on a Mac. */
async function withScrollbar(native, fn) {
  const proto = StandInElement.prototype;
  const scrollbar = { native };
  const hostOf = new WeakMap();
  const barOf = el => {
    const host = hostOf.get(el);
    if (!(host || el).isConnected) return null;
    return host ? scrollbar.native : BOARD_BAR;
  };
  proto.attachShadow = function () {
    const host = this;
    return { appendChild(node) { hostOf.set(node, host); return node; } };
  };
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return barOf(this) === null ? 0 : PROBE_BOX; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { const bar = barOf(this); return bar === null ? 0 : PROBE_BOX - bar; } });
  try {
    return await fn(scrollbar);
  } finally {
    delete proto.attachShadow;
    delete proto.offsetWidth;
    delete proto.clientWidth;
  }
}

/** `prop` on `el` as a number of px, off the real stylesheet: each var() read
 * from where the page writes it (the body's inline style) or else its own
 * fallback, and a calc() of px terms summed. The stand-in computes no lengths,
 * so this is the arithmetic a browser would do on the one shape these rows need. */
function px(document, el, prop) {
  const declared = computed(el, prop);
  const resolved = declared.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+?)\s*)?\)/g,
    (whole, name, fallback) => document.body.style.getPropertyValue(name) || fallback || whole);
  const sum = /^calc\((.+)\)$/.exec(resolved.trim());
  const terms = (sum ? sum[1] : resolved).split('+').map(t => t.trim());
  for (const t of terms) assert.match(t, /^\d+(\.\d+)?px$/, `${prop}: ${declared} does not come to a length (${resolved})`);
  return terms.reduce((total, t) => total + parseFloat(t), 0);
}

/** One height report from `frame`'s own stage, the one source the page trusts.
 * With no requestAnimationFrame in the stand-in it applies at once. The frame
 * is loaded on its first report and not again, so a second report comes from
 * the same stage. */
const loadedStages = new WeakSet();
function reportHeight(frame, height) {
  if (!loadedStages.has(frame)) {
    frame.loadSrcdoc();
    loadedStages.add(frame);
  }
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'height', height }, '*');
}

const stageFrame = (document, b, name) =>
  blockEl(document, 'stage', PLACEMENTS.find(p => p.name === name).id(b)).querySelector('.html-stage');
const pullOutOf = frame => frame.closest('.stage-wrap').querySelector('.pull-out');
const measuredBar = document => document.body.style.getPropertyValue('--stage-scrollbar-w');

await checkAsync('Pull-out: the page measures the scrollbar a frame draws, in a shadow root its own scrollbar styling cannot reach, and writes the width to --stage-scrollbar-w; a resize measures again, and an overlay bar writes 0px (falsify: measure a box in the page itself and it writes the board\'s own 11px)', async () => {
  const html = renderBoardPage(everyPlacementBoard());
  // The same page where nothing can be measured (the stand-in as it comes), so
  // no probe is ever built: what the body holds when the page has added nothing.
  const bare = (await loadSettled(html)).body.children.length;
  await withScrollbar(CLASSIC_BAR, async scrollbar => {
    const document = await loadSettled(html);
    assert.equal(measuredBar(document), `${CLASSIC_BAR}px`, 'measured as the page boots, with no resize needed');
    assert.equal(document.body.children.length, bare, 'and the probe is gone again once it is read');

    // The reader unplugs the mouse and macOS goes back to overlay bars, which
    // take no width: the page reads that at its next resize.
    scrollbar.native = 0;
    document.defaultView.dispatchEvent(new StandInEvent('resize'));
    assert.equal(measuredBar(document), '0px');
    assert.equal(document.body.children.length, bare, 'each measure takes its own probe away');

    // A saved archive folds its stages too, so it measures like a live board.
    scrollbar.native = CLASSIC_BAR;
    const archive = await loadSettled(html, { protocol: 'file:' });
    assert.equal(archive.body.classList.contains('readonly'), true, 'setup failure: a file: page is the read-only archive');
    assert.equal(measuredBar(archive), `${CLASSIC_BAR}px`, 'an archive measures as it boots too');
  });
});

await checkAsync('Pull-out: a stage\'s block is marked .stage-scrolls exactly while its mock is taller than its box, folded or opened, and the Pull-out sits the scrollbar\'s width further in for exactly as long, top level and in a question\'s context; a report that moves no box moves the mark and writes no box (falsify: have markStageScrolls skip a block that is .stage-opened)', async () => {
  const FOLD_STATES = ['stage-folded', 'stage-opened'];
  await withScrollbar(CLASSIC_BAR, async () => {
    const b = everyPlacementBoard();
    const document = await loadSettled(renderBoardPage(b));
    for (const name of ['a top-level stage', 'a stage in a question\'s context']) {
      const frame = stageFrame(document, b, name);
      const control = pullOutOf(frame);
      const block = frame.closest('.html-block');
      const toggle = block.querySelector('.stage-fold-toggle');
      const report = height => () => reportHeight(frame, height);
      const pressBar = () => click(toggle);

      let writes = 0;
      let height = frame.style.height;
      Object.defineProperty(frame.style, 'height', { configurable: true, get: () => height, set: (v) => { writes++; height = v; } });

      // What happens, the box and fold state it must leave (both setup), and
      // whether the mock is then taller than that box. The frame's 2px border
      // counts inside the box, so a 2000px mock needs 2002px to show whole.
      const steps = [
        ['before any report', () => {}, '', null, false],
        ['fitted to a 400px mock', report(400), '402px', null, false],
        ['folded at the cap over a 2000px mock', report(2000), '600px', 'stage-folded', true],
        ['opened to the whole mock', pressBar, '2002px', 'stage-opened', false],
        ['opened, the mock grown past the height it opened to', report(2600), '2002px', 'stage-opened', true],
        ['opened, the mock back inside that height', report(2000), '2002px', 'stage-opened', false],
        ['folded again by Show less', pressBar, '600px', 'stage-folded', true],
        ['still folded, the mock shrunk into the slack under the cap', report(580), '600px', 'stage-folded', false],
        ['folded, the mock grown back', report(2000), '600px', 'stage-folded', true],
        ['folded over a mock past the 30,000px limit', report(40000), '600px', 'stage-folded', true],
        ['opened at the 30,000px limit with the rest of the mock under it', pressBar, '30000px', 'stage-opened', true],
      ];
      for (const [step, act, box, fold, scrolls] of steps) {
        const before = { writes, box: height || '' };
        act();
        const at = `${name}, ${step}`;
        assert.equal(height || '', box, `setup failure: ${at}: the box`);
        assert.deepEqual(FOLD_STATES.filter(c => block.classList.contains(c)), fold ? [fold] : [], `setup failure: ${at}: the fold state`);
        assert.equal(block.classList.contains('stage-scrolls'), scrolls,
          `${at}: ${scrolls ? 'the mock is taller than the box, so the block is marked' : 'the box holds the whole mock, so no mark'}`);
        assert.equal(px(document, control, 'right'), scrolls ? 8 + CLASSIC_BAR : 8,
          `${at}: ${scrolls ? `the frame scrolls inside, so 8px past its ${CLASSIC_BAR}px scrollbar` : 'the whole mock shows, so in the corner'}`);
        assert.equal(px(document, control, 'top'), 8, `${at}: still 8px from the top`);
        assert.equal(writes - before.writes, box === before.box ? 0 : 1, `${at}: the box is written when it changes and not otherwise`);
      }
    }
  });
});

await checkAsync('Pull-out: a variant option\'s stage held at the cap with more mock under it is marked .stage-scrolls, never folded, and its Pull-out sits the scrollbar\'s width further in; one whose mock fits, or comes back to exactly the cap, carries no mark and keeps the corner (falsify: drop the markStageScrolls call from applyStageHeight and the mark outlives a mock that came back to the cap)', async () => {
  // A variant option never folds (a click on its card picks it), so its block
  // never carries .stage-folded: the mark cannot ride on a fold state.
  const VARIANT = 'a rendered-variant option';
  const MARKS = ['stage-scrolls', 'stage-folded', 'stage-opened'];
  await withScrollbar(CLASSIC_BAR, async () => {
    const b = everyPlacementBoard();
    const document = await loadSettled(renderBoardPage(b));
    const frame = stageFrame(document, b, VARIANT);
    const block = frame.closest('.html-block');
    const control = pullOutOf(frame);
    const marks = () => MARKS.filter(c => block.classList.contains(c));
    assert.ok(frame.closest('.choice-variant'), 'setup failure: this stage must sit in a variant option\'s card');
    assert.deepEqual(marks(), [], 'setup failure: unmarked before any report');

    reportHeight(frame, 2000);
    assert.equal(frame.style.height, '600px', 'setup failure: a 2000px report must hold the option at the cap');
    assert.deepEqual(marks(), ['stage-scrolls'], 'held at the cap with more mock under it: it scrolls inside, and is neither folded nor opened');
    assert.equal(block.querySelector('.stage-fold'), null, 'and still no Show full height bar');
    assert.equal(px(document, control, 'right'), 8 + CLASSIC_BAR, `clipped at the cap: 8px past the frame's ${CLASSIC_BAR}px scrollbar`);
    assert.equal(px(document, control, 'top'), 8, 'and still 8px from the top');

    // The same height again changes nothing, so nothing is written: a mock
    // that reports every frame must not have its box rewritten every frame.
    let writes = 0;
    let height = frame.style.height;
    Object.defineProperty(frame.style, 'height', { configurable: true, get: () => height, set: (v) => { writes++; height = v; } });
    reportHeight(frame, 2000);
    assert.equal(writes, 0, 'a clipped stage reporting the same height again must not rewrite its box');

    // 598px of mock and the frame's 2px border come to exactly the cap: the
    // box stays where it is, with nothing under it left to scroll to.
    reportHeight(frame, 598);
    assert.equal(frame.style.height, '600px', 'setup failure: a mock exactly the cap tall keeps the 600px box');
    assert.deepEqual(marks(), [], 'exactly the cap tall: it fits, so the mark goes');
    assert.equal(px(document, control, 'right'), 8, 'and the control is back in the corner');
    assert.equal(writes, 0, 'and the box, which did not move, is not rewritten to say so');
  });

  await withScrollbar(CLASSIC_BAR, async () => {
    const b = everyPlacementBoard();
    const document = await loadSettled(renderBoardPage(b));
    const frame = stageFrame(document, b, VARIANT);
    reportHeight(frame, 400);
    assert.equal(frame.style.height, '402px', 'setup failure: a 400px report must fit the option to it');
    assert.deepEqual(MARKS.filter(c => frame.closest('.html-block').classList.contains(c)), [], 'a variant option that fits carries no mark');
    assert.equal(px(document, pullOutOf(frame), 'right'), 8, 'and its Pull-out keeps the corner');
  });
});

await checkAsync('Pull-out: with an overlay scrollbar, or in a browser that cannot measure one, it stays 8px from the top and right on a stage that scrolls inside; so it does on a stage that fits, a stage rendered opened and a diagram beside a classic bar', async () => {
  // Overlay bars take no width, so there is nothing to clear.
  await withScrollbar(0, async () => {
    const b = everyPlacementBoard();
    const document = await loadSettled(renderBoardPage(b));
    const frame = stageFrame(document, b, 'a top-level stage');
    reportHeight(frame, 2000);
    assert.equal(frame.closest('.html-block').classList.contains('stage-scrolls'), true, 'setup failure: the stage must be marked as scrolling inside');
    assert.equal(measuredBar(document), '0px', 'setup failure: an overlay bar measures 0');
    assert.equal(px(document, pullOutOf(frame), 'right'), 8, 'scrolling inside, beside an overlay bar');
  });

  // The stand-in as it comes: no shadow root, so the page measures nothing and
  // writes nothing. The rule's own fallback is what keeps the corner.
  {
    const b = everyPlacementBoard();
    const document = await loadSettled(renderBoardPage(b));
    const frame = stageFrame(document, b, 'a top-level stage');
    reportHeight(frame, 2000);
    assert.equal(frame.closest('.html-block').classList.contains('stage-scrolls'), true, 'setup failure: the stage must be marked as scrolling inside');
    assert.equal(measuredBar(document), '', 'setup failure: nothing measured, nothing written');
    assert.equal(px(document, pullOutOf(frame), 'right'), 8, 'scrolling inside, with no measure at all');
  }

  // A classic bar, and three frames with no scrollbar of their own to clear.
  await withScrollbar(CLASSIC_BAR, async () => {
    const commented = PLACEMENTS.find(p => p.name === 'a stage in a question\'s context');
    const b = everyPlacementBoard();
    applySubmit(b, { action: 'send', answers: [], comments: [{ blockId: commented.id(b), anchor: { kind: 'block' }, text: 'about this stage' }] }, 1);
    const document = await loadSettled(renderBoardPage(b), { mermaid: drawingMermaid() });
    assert.equal(measuredBar(document), `${CLASSIC_BAR}px`, 'setup failure: a classic bar must be measured');

    const fitted = stageFrame(document, b, 'a top-level stage');
    reportHeight(fitted, 400);
    assert.equal(fitted.style.height, '402px', 'setup failure: a 400px report must fit the stage to it');
    assert.equal(px(document, pullOutOf(fitted), 'right'), 8, 'a stage that fits');

    const opened = stageFrame(document, b, commented.name);
    assert.equal(opened.closest('.html-block').classList.contains('stage-opened'), true, 'setup failure: a stage holding a comment renders opened');
    assert.equal(px(document, pullOutOf(opened), 'right'), 8, 'a stage rendered opened');

    for (const p of PLACEMENTS.filter(p => p.kind === 'diagram')) {
      const control = blockEl(document, 'diagram', p.id(b)).querySelector('.pull-out');
      assert.ok(control, `setup failure: ${p.name} must have drawn and kept its Pull-out`);
      assert.equal(px(document, control, 'right'), 8, p.name);
      assert.equal(px(document, control, 'top'), 8, `${p.name}, from the top`);
    }
  });
});

// -------------------------------------------------------------------------------

check('the lens frame is a live document running the mock\'s own script, not a picture of one', () => {
  const document = loadBoard(pageHtml);
  const lens = openStageLens(document);
  lens.frame.loadSrcdoc(); // the srcdoc navigation completing, as a browser would
  assert.equal(lens.frame.contentWindow.__mockRan, 1,
    'the mock\'s own script must run inside the lens frame -- a stage that cannot run script cannot respond to input either');
  assert.ok(lens.frame.contentDocument.querySelector('button'),
    'and the mock\'s own markup must be there to receive that input');
});

check('the lens\'s copy carries the board\'s theme as data-theme once it has loaded, a lens opened after a theme change starts on the current theme, and a change while it is open reaches the copy (falsify: drop the post from stageLensOpen\'s load listener and the copy carries no data-theme; drop tellStageLensTheme from the theme-change listener and the open copy keeps the old one)', () => {
  // A mock that keys its palette on data-theme and falls back to
  // prefers-color-scheme draws its fallback in a copy that was never told, and
  // that fallback reads light in every stage frame: dark in its block, light in
  // the lens, on a dark board. What Chrome then paints is
  // test/browser-check-stage-fold.mjs's self-themed rows; this is the attribute.
  const document = loadBoard(pageHtml, { theme: true, finish: true });
  const themeOf = frame => frame.contentDocument.documentElement.getAttribute('data-theme');

  const first = openStageLens(document);
  first.frame.loadSrcdoc(); // the copy's document loading, as a browser would
  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the board must start in System');
  assert.equal(themeOf(first.frame), 'dark',
    'the copy must carry the board\'s resolved theme once it has loaded: System, on this stand-in\'s dark OS');

  // A change with the lens closed has no copy to tell, and must not throw.
  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  clickThemeToggle(document); // System -> Light
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have set the board to Light');

  const second = openStageLens(document);
  second.frame.loadSrcdoc();
  assert.equal(themeOf(second.frame), 'light', 'a lens opened after the board changed theme must start on the current one');

  clickThemeToggle(document); // Light -> Dark, with the lens open
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'setup failure: the click must have set the board to Dark');
  assert.equal(themeOf(second.frame), 'dark', 'a theme change while the lens is open must reach its copy');
});

check('nothing in the stylesheet makes the lens frame inert, while a variant option\'s INLINE stage stays inert -- the trust boundary is untouched', () => {
  // The real cascade, over the real src/styles.mjs text (test/dom-stand-in.mjs's
  // resolveComputedProperty), not a match against a rule's spelling: this asks
  // what pointer-events each of the two frames actually computes to -- the
  // property that decides whether a stage is live or inert.
  const document = loadBoard(renderBoardPage(variantBoard()));
  const inline = document.querySelector('.choice-variant .html-stage');
  assert.ok(inline, 'setup failure: no inline stage inside the variant card');
  assert.equal(resolveComputedProperty(styles, inline, true, 'pointer-events'), 'none',
    'a variant option\'s inline stage must stay pointer-events: none -- this rule is pinned verbatim, not merely implied');

  document.querySelector('.choice-variant .pull-out').dispatchEvent(new StandInEvent('click'));
  const frame = document.querySelector('.stage-lens .stage-lens-frame');
  assert.ok(frame, 'setup failure: the lens did not open');
  assert.notEqual(resolveComputedProperty(styles, frame, true, 'pointer-events'), 'none',
    'the same stage in the lens must NOT be inert -- the lens is where a stage becomes live');

  // And it is given a real box from this side: an iframe's intrinsic size is
  // 300x150 whatever it holds, so a frame with no CSS size has nowhere to scroll
  // even in a real browser.
  assert.equal(resolveComputedProperty(styles, frame, true, 'height'), '100%');
  assert.equal(resolveComputedProperty(styles, frame, true, 'width'), '100%');
});

// -------------------------------------------------------------------------------
//
// Every close path is this page's own code rather than the browser's, and that is
// deliberate: the DOM stand-in has no showModal(), no native Esc handling for a
// dialog and no hit-testing for a backdrop, so a lens that leaned on the browser
// for any of the three would be uncheckable here (and, for Esc with focus inside
// a cross-origin frame, unreliable in a browser too -- see wireStageLensChrome's
// own comment).

check('Esc closes the lens and returns focus to the control that opened it', () => {
  const document = loadBoard(pageHtml);
  const lens = openStageLens(document);
  assert.notEqual(document.activeElement, lens.btn, 'setup failure: focus must not already be on the control, or the assertion below proves nothing');

  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'Esc must close the lens');
  assert.equal(document.activeElement, lens.btn, 'and focus must go back to the Pull-out that opened it');
});

check('a backdrop click closes the lens and returns focus -- both the dialog itself and the surround around the framed stage', () => {
  for (const targetName of ['dlg', 'body']) {
    const document = loadBoard(pageHtml);
    const lens = openStageLens(document);
    lens[targetName].dispatchEvent(new StandInEvent('click'));
    assert.equal(lens.dlg.hasAttribute('open'), false, `a click on the ${targetName} must close the lens`);
    assert.equal(document.activeElement, lens.btn, 'and focus must go back to the Pull-out');
  }
});

check('a click on the lens chrome is NOT a backdrop click -- the bar and its title leave the lens open', () => {
  // Without this, the "backdrop" test above would be satisfied by a lens that
  // closes on any click anywhere, which would make the pick control checks
  // below unreachable.
  const document = loadBoard(pageHtml);
  const lens = openStageLens(document);
  document.querySelector('.stage-lens .lens-title').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), true, 'a click on the bar must not close the lens');
  document.querySelector('.stage-lens .lens-bar').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), true, 'nor a click on the bar itself');
});

check('the close control closes the lens, returns focus, and ends the copy\'s document rather than hiding it', () => {
  const document = loadBoard(pageHtml);
  const lens = openStageLens(document);
  document.querySelector('.stage-lens .lens-btn[data-lens="close"]').dispatchEvent(new StandInEvent('click'));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'the close control must close the lens');
  assert.equal(document.activeElement, lens.btn, 'and focus must go back to the Pull-out');
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 0,
    'the frame must be dropped, not merely hidden -- a mock left mounted behind a closed dialog goes on running its own timers');
});

check('closing and reopening works, and a second open while already open is refused rather than stacking frames', () => {
  const document = loadBoard(pageHtml);
  const first = openStageLens(document);
  first.btn.dispatchEvent(new StandInEvent('click')); // already open
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 1, 'a second open must not mount a second frame');
  assert.equal(document.querySelectorAll('.stage-lens').length, 1, 'and must never build a second dialog');

  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  const second = openStageLens(document);
  assert.equal(second.dlg, first.dlg, 'the lens is built once and reused');
  assert.ok(second.frame, 'and reopening must mount the stage again');
});

// -------------------------------------------------------------------------------

check('the standalone stage stays where it was rendered while the lens is open, and its own click-to-comment gesture works before and after a trip through the lens', () => {
  const document = loadBoard(pageHtml);
  enableCommentMode(document);
  const inline = document.querySelector('.html-block .html-stage');
  inline.loadSrcdoc();

  const form = document.getElementById('comment-form-' + blockId);
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'setup failure: the inline gesture must work to begin with');
  const refBefore = form.getAttribute('data-anchor-ref');

  // While the lens is open the block keeps its own frame where it was
  // rendered: the lens shows a second mount, it never moves this one.
  const lens = openStageLens(document);
  assert.equal(document.querySelector('.html-block .html-stage'), inline, 'the block must keep its own frame -- the lens must not move it');
  assert.ok(inline.closest('.stage-wrap'), 'and it must still sit in its own .stage-wrap, beside its pin layer');
  assert.equal(inline.closest('.stage-lens'), null, 'the block\'s frame must never end up inside the dialog');
  assert.notEqual(lens.frame, inline, 'the lens shows a second mount, never the block\'s own frame');
  document.dispatchEvent(new StandInEvent('keydown', { key: 'Escape' }));
  assert.equal(lens.dlg.hasAttribute('open'), false, 'setup failure: the lens did not close');

  form.classList.remove('open');
  inline.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), true, 'the inline gesture must still work after the lens has been opened and closed');
  assert.equal(form.getAttribute('data-anchor-ref'), refBefore, 'and mint the same anchor it did before');
});

// -------------------------------------------------------------------------------
//
// "Picking from the lens records the answer and closes the lens in one act."
// RECORDS is asserted the way this repo already prefers over reaching into
// private state (test/check-comment-mode.mjs's own note): press Send with a
// stubbed global fetch and read the answer out of the body that actually gets
// posted. That is also what proves the pick went through the ONE path every
// other pick goes through -- selections/collectAnswers -- rather than through a
// second notion of what is selected that only the lens knows about.

/** A two-option variants board, both options html so either can be opened. */
function twoOptionBoard() {
  return createBoard({
    title: 'SPEC_STAGES -- picking from the lens',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Card A', block: { kind: 'html', html: MOCK } },
        { label: 'Card B', block: { kind: 'html', html: MOCK } },
      ],
    }],
  });
}

/** Press Send with a stubbed `fetch` and hand back the posted body.
 *
 * Presses twice when the first press only armed the button: the round-end send
 * guard arms instead of submitting while any question still carries no status,
 * and the forced-press check below needs its
 * round to stay deliberately incomplete -- that a forced press records nothing
 * IS its subject, so answering the round to get past the guard would delete the
 * thing it measures. The second press is the guard's own "send anyway", which is
 * how a reviewer submits a partial round too. A press that neither submits nor
 * arms is still a setup failure. */
function sendAndCapture(document) {
  const originalFetch = globalThis.fetch;
  const sendBtn = document.getElementById('send-btn');
  let captured = null;
  globalThis.fetch = (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    sendBtn.dispatchEvent(new StandInEvent('click'));
    if (!captured) sendBtn.dispatchEvent(new StandInEvent('click'));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'setup failure: clicking Send never called fetch');
  return captured.body;
}

function openVariantLens(document, index) {
  const cards = document.querySelectorAll('.choice-variant');
  const btn = cards[index].querySelector('.pull-out');
  assert.ok(btn, 'setup failure: no Pull-out on that option');
  btn.dispatchEvent(new StandInEvent('click'));
  return { cards, card: cards[index], btn, pick: document.querySelector('.stage-lens .lens-pick') };
}

check('picking from the lens records the answer -- it reaches the submit body as that option, through the same path every other pick uses', () => {
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  const { card, pick } = openVariantLens(document, 1);
  assert.ok(pick, 'setup failure: no pick control on a variant option\'s lens');

  pick.dispatchEvent(new StandInEvent('click'));

  assert.equal(card.classList.contains('selected'), true, 'the option must be selected in the card, exactly as a direct click on it would leave it');
  const answer = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.ok(answer, 'setup failure: the variant question was not in the collected answers');
  assert.equal(answer.choice, 'Card B', 'the answer that gets sent must be the option the lens picked');
  assert.equal(answer.status, 'answered');
});

check('picking closes the lens in the same act, and hands focus back to the control that opened it', () => {
  const board = twoOptionBoard();
  const document = loadBoard(renderBoardPage(board));
  const { btn, pick } = openVariantLens(document, 0);
  pick.dispatchEvent(new StandInEvent('click'));

  const dlg = document.querySelector('.stage-lens');
  assert.equal(dlg.hasAttribute('open'), false, 'picking must close the lens -- one act, not "pick, then find the close button"');
  assert.equal(document.querySelectorAll('.stage-lens .stage-lens-frame').length, 0, 'and must end the stage copy, like every other close path');
  assert.equal(document.activeElement, btn, 'and return focus to the Pull-out, the same as every other close path');
  assert.equal(document.querySelectorAll('.stage-lens .lens-pick').length, 0, 'the control must not outlive the lens that carried it');
});

check('there is ONE selection per question -- picking B from its lens after A moves the answer rather than adding one', () => {
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));

  const first = openVariantLens(document, 0);
  first.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(first.cards[0].classList.contains('selected'), true, 'setup failure: the first pick did not register');

  const second = openVariantLens(document, 1);
  second.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(second.cards[0].classList.contains('selected'), false, 'the earlier option must be deselected');
  assert.equal(second.cards[1].classList.contains('selected'), true, 'and the newly picked one selected');

  const answer = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.equal(answer.choice, 'Card B', 'exactly one choice reaches the submit body, and it is the last one picked');
});

check('the lens control is a caller, not an authority -- comment mode disables it, and a forced press records nothing', () => {
  // selectVariant refuses in comment mode, the same as it does for a direct
  // click on the card (every widget handler in src/ui.mjs stands down while
  // comment mode is on). The control mirrors that refusal so it never reads as
  // live while being inert -- and the press is driven anyway here, because the
  // DOM stand-in does not model a browser refusing to fire a click on a
  // disabled button (test/check-archive.mjs's own note), which makes this the
  // one place that difference could hide a real defect.
  const board = twoOptionBoard();
  const qid = board.blocks[0].id;
  const document = loadBoard(renderBoardPage(board));
  enableCommentMode(document);
  const { card, pick } = openVariantLens(document, 0);
  assert.ok(pick, 'the control must still be present in comment mode -- absent would read as a missing feature');
  assert.equal(pick.disabled, true, 'and must be disabled, since a pick would be refused');

  pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(card.classList.contains('selected'), false, 'a forced press must record nothing');
  const answers = sendAndCapture(document).answers.find(a => a.id === qid);
  assert.ok(!answers || answers.status !== 'answered', 'and nothing may reach the submit body as an answer');
});

check('a historical option\'s lens carries a disabled control, and a read-only archive\'s carries none at all', () => {
  const board = twoOptionBoard();
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const pageHtml = renderBoardPage(board);

  // Historical: the card itself is aria-disabled and refuses clicks; the
  // control says so rather than pretending.
  const live = loadBoard(pageHtml);
  const historical = openVariantLens(live, 0);
  assert.ok(historical.pick, 'a historical option\'s lens still carries the control');
  assert.equal(historical.pick.disabled, true, 'disabled, because the round is sent and the card refuses a pick too');
  historical.pick.dispatchEvent(new StandInEvent('click'));
  assert.equal(historical.card.classList.contains('selected'), false, 'and a forced press records nothing');

  // Read-only (a standalone file: archive): no control at all. There is no
  // answer to record there -- the send bar is gone and every input is
  // hard-disabled -- and the diagram lens sets the same precedent by hosting no
  // comment form in an archive.
  const archive = loadBoard(pageHtml, { protocol: 'file:' });
  const cards = archive.querySelectorAll('.choice-variant');
  cards[0].querySelector('.pull-out').dispatchEvent(new StandInEvent('click'));
  assert.equal(archive.querySelector('.stage-lens').hasAttribute('open'), true,
    'the archive\'s lens must still open -- it is a viewer there, not absent');
  assert.equal(archive.querySelector('.stage-lens .lens-pick'), null, 'but it must carry no pick control');
});

// =================================================================================
// The Show full height bar: live on a sent round and in an archive, and never a
// comment anchor (ADR.md entry 119). Its own block, beside the lens rows above:
// the bar is the fold's control, not the lens's. Fit, fold and open themselves
// are pinned in test/check-stage-isolation.mjs ("stage sizing"); here a stage is
// folded by a forged report from its own window, the one source the parent
// trusts, since the stand-in lays nothing out.
// =================================================================================

/** Fold the page's first top-level stage and hand back its parts. With no
 * requestAnimationFrame in the stand-in the report applies at once. */
function foldFirstStage(document) {
  const frame = document.querySelector('section.html-block .html-stage');
  assert.ok(frame, 'setup failure: no top-level html stage');
  frame.loadSrcdoc();
  frame.contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'height', height: 2000 }, '*');
  const block = frame.closest('.html-block');
  assert.equal(block.classList.contains('stage-folded'), true, 'setup failure: a 2000px report must fold the stage');
  return { frame, block, toggle: block.querySelector('.stage-fold-toggle'), bar: block.querySelector('.stage-fold') };
}

check('Show full height stays live in a read-only archive: not disabled, and it opens and folds the stage (ablation: drop the stage-fold-toggle carve-out from staysLive and the readonly pass disables it)', () => {
  const document = loadBoard(pageHtml, { protocol: 'file:' });
  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: a file: page is the read-only archive');
  const { frame, block, toggle } = foldFirstStage(document);
  assert.equal(toggle.disabled, false, 'an archive reader is exactly who can read a long mock no other way');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(block.classList.contains('stage-opened'), true, 'and pressing it opens the stage');
  assert.equal(frame.style.height, '2002px');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(frame.style.height, '600px', 'and Show less folds it back');
});

check('Show full height stays live on a round that has just gone to history, while the round\'s answers lock (ablation: drop the stage-fold-toggle carve-out from staysLive and the sent-round pass disables it)', () => {
  const board = createBoard({
    title: 'a stage on a sent round',
    blocks: [{ kind: 'html', html: MOCK }, { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const { document, es: source } = loadBoardWithEventSource(renderBoardPage(board));
  const { frame, block, toggle } = foldFirstStage(document);

  // Round 1 goes to history live, exactly as a push does it.
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: 'next' }] });
  source.dispatch('round', JSON.stringify({
    round: round2,
    mode: 'new-round',
    blockIds: [board.blocks[2].id],
    html: renderRoundSection(board, round2, groupCommentsByBlock([])),
    board,
  }));
  const round1 = document.querySelector('.round[data-round="1"]');
  assert.equal(round1.classList.contains('round-history'), true, 'setup failure: round 1 must have collapsed into history');
  assert.equal(round1.querySelector('.choice-single').disabled, true, 'the sent round\'s answers lock, as always');
  assert.equal(toggle.disabled, false, 'but Show full height survives the pass: a settled round is where a mock gets re-read');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(block.classList.contains('stage-opened'), true, 'and it still opens the stage');
  assert.equal(frame.style.height, '2002px');
});

check('a click on the Show full height bar in comment mode mints no anchor -- on the pill or beside it -- and the pill still opens the stage (ablation: drop .stage-fold from ANCHOR_CHROME_SELECTOR and the click opens a comment form against the html block)', () => {
  const document = loadBoard(pageHtml);
  enableCommentMode(document);
  const { block, toggle, bar } = foldFirstStage(document);
  const form = document.getElementById(`comment-form-${blockId}`);
  assert.ok(form, 'setup failure: the html block has no comment form');

  bar.dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), false, 'a click beside the pill must mint nothing: the bar is chrome this page drew');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(form.classList.contains('open'), false, 'nor a click on the pill itself');
  assert.equal(block.classList.contains('stage-opened'), true, 'which still opens the stage: reading a mock is not commenting on it');
});

// =================================================================================
// A stage holding a comment renders opened (ADR.md entry 119), decided by the
// server: the browser knows where a stage folds only from its height report, and
// a board in a background tab gets none. One row per stage placement over the
// everyPlacementBoard fixture with the comment on that placement's stage alone, so
// each row also proves every other stage on the same page renders without it.
// Parsed and NOT run: the mark has to be in the server's own bytes. What the page
// then does with the mark is a sizing rule, in test/check-stage-isolation.mjs.
// =================================================================================

const STAGE_PLACEMENTS = PLACEMENTS.filter(p => p.kind === 'stage');
const UNOPENED = { opened: false, label: 'Show full height', expanded: 'false' };
const OPENED = { opened: true, label: 'Show less', expanded: 'true' };
// A variant option's stage clips at the cap and never folds, so it has no bar.
const NO_BAR = { opened: false, label: null, expanded: null };
const IN_CARD = 'a rendered-variant option';

/** everyPlacementBoard with one comment on `placement`'s stage and on no other,
 * stored the way a Send stores it, then rendered and parsed without the client. */
function commentedPlacementPage(placement, anchor = { kind: 'block' }) {
  const b = everyPlacementBoard();
  const id = placement.id(b);
  applySubmit(b, { action: 'send', answers: [], comments: [{ blockId: id, anchor, text: 'about this stage' }] }, 1);
  return { board: b, id, document: parseHTML(renderBoardPage(b)) };
}

/** What the server rendered for one stage: the mark on its own '.html-block',
 * and its bar's label and aria-expanded. */
function renderedFold(document, id) {
  const el = blockEl(document, 'stage', id);
  const toggle = el.querySelector('.stage-fold-toggle');
  return {
    opened: el.classList.contains('stage-opened'),
    label: toggle ? toggle.textContent : null,
    expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
  };
}

for (const placement of STAGE_PLACEMENTS) {
  const inCard = placement.name === IN_CARD;
  check(inCard
    ? `Opened with a comment: ${placement.name} holding a comment still renders unopened -- it clips at the cap and never folds (ablation: drop the folds argument renderVariantOption passes and it renders opened)`
    : `Opened with a comment: ${placement.name} holding a comment renders opened, its bar showing Show less, and every other stage on the page renders without it (ablation: make stageRendersOpened's condition false)`, () => {
    const { board: b, id, document } = commentedPlacementPage(placement);
    assert.ok(blockEl(document, 'stage', id).querySelector(`.comment-item[data-block-id="${id}"]`),
      'setup failure: the stored comment must render in the stage\'s own comment list');
    assert.deepEqual(renderedFold(document, id), inCard ? NO_BAR : OPENED,
      inCard ? 'a variant option\'s stage never opens: a click on its card picks it' : 'the stage the comment is on renders opened');
    if (!inCard) {
      assert.notEqual(computed(blockEl(document, 'stage', id).querySelector('.stage-fold'), 'display'), 'none',
        'its bar shows before any height report, so Show less is there to fold it');
    }
    for (const other of STAGE_PLACEMENTS.filter(p => p !== placement)) {
      assert.deepEqual(renderedFold(document, other.id(b)), other.name === IN_CARD ? NO_BAR : UNOPENED, `${other.name}, holding no comment, renders without the mark`);
    }
  });
}

check('Opened with a comment: a comment on an element in the stage opens it the same as a whole-block one (ablation: count only whole-block anchors in stageRendersOpened)', () => {
  const top = STAGE_PLACEMENTS.find(p => p.name === 'a top-level stage');
  const { id, document } = commentedPlacementPage(top, { kind: 'dom', ref: '1.1', hint: 'Send' });
  const item = blockEl(document, 'stage', id).querySelector('.comment-item');
  assert.equal(item.getAttribute('data-anchor-kind'), 'dom', 'setup failure: the comment must be stored on an element');
  assert.equal(item.querySelector('.comment-lost'), null, 'setup failure: and its element must still be in the mock');
  assert.deepEqual(renderedFold(document, id), OPENED);
});

check('Opened with a comment: a page board\'s stage holding a comment renders no mark -- it already fills the window', () => {
  const pageBoard = createBoard({ title: 'a page board', blocks: [{ kind: 'html', html: MOCK }] });
  applySubmit(pageBoard, { action: 'send', answers: [], comments: [{ blockId: pageBoard.blocks[0].id, anchor: { kind: 'block' }, text: 'about the page' }] }, 1);
  const document = parseHTML(renderBoardPage(pageBoard));
  assert.equal(document.body.classList.contains('page-board'), true, 'setup failure: one html block and nothing else is a page board');
  assert.equal(document.querySelectorAll('.stage-opened').length, 0);
});

// =================================================================================
// The fold bar in the server's own bytes (ADR.md entry 119): one under every stage
// that can fold, so an archive carries the control, and none in a variant option's
// card, whose stage clips at the cap because a click on the card picks it. Parsed
// and NOT run, over the everyPlacementBoard fixture holding every placement at once.
// =================================================================================

check('Fold bar: server-rendered under every stage that can fold, and absent from a variant option\'s stage -- no hidden markup where the stage cannot fold (ablation: emit stageFoldBar in renderHtmlBlock whatever folds says and the variant option carries one)', () => {
  const b = everyPlacementBoard();
  const document = parseHTML(renderBoardPage(b));
  const bars = document.querySelectorAll('.stage-fold').map(bar => bar.closest('.html-block').getAttribute('data-block-id')).sort();
  assert.deepEqual(bars, STAGE_PLACEMENTS.filter(p => p.name !== IN_CARD).map(p => p.id(b)).sort(),
    'one bar per stage outside a variant card');
  const card = blockEl(document, 'stage', STAGE_PLACEMENTS.find(p => p.name === IN_CARD).id(b));
  assert.ok(card && card.closest('.choice-variant'), 'setup failure: the variant option\'s stage must render in its card');
  assert.equal(card.querySelector('.stage-fold, .stage-fold-toggle'), null, 'a variant option\'s stage carries no bar at all');
});

finish('stage-lens', { failText: n => `${n} stage-lens check(s) failed` });
