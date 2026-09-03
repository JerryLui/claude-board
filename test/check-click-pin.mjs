// A numbered pin actually lands after the click.
//
// test/check-click.mjs proves the click gesture opens the right
// comment form with the right anchor filled in, but stops there -- it never
// submits the form, so it never observes the other half of the acceptance
// criterion: "a numbered pin lands on it". Per src/ui.mjs's file comment, a pin
// is drawn the moment a comment is QUEUED (on submit), not merely when the form
// opens, so this check drives one step further than check-click.mjs: click the
// element, fill in the opened form, submit it, and assert a numbered
// `.anchor-pin` now exists inside that block's `.pin-layer`, positioned from the
// REAL (post-loadSrcdoc) stage document -- not the about:blank placeholder.
//
// Deliberately a separate file rather than an addition to test/check-click.mjs:
// the goal is not to edit that file's existing assertions.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
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

// A trailing markdown block keeps this an ORDINARY board (isPageRound false):
// a lone `html` block is a page round (ADR.md entry 33) whose comment gesture
// (ADR.md entry 46) gates on being *awaited*, and
// this file is about pin placement, not awaited-ness -- see test/check-click.mjs's
// own identical fix for the fuller reasoning.
const board = createBoard({
  title: 'the pin actually lands',
  blocks: [
    { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
    { kind: 'markdown', text: 'not a page board' },
  ],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

check('clicking an element, then submitting the opened comment form, draws a numbered pin into that block\'s .pin-layer, positioned from the real (loaded) stage document', () => {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  // 'EventSource' declared, never passed -- see QUIRKS.md "A `new Function` harness
  // inherits the host's globals" for why.
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);

  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage iframe on the rendered page');

  // The stage click is gated on comment mode now, same as everywhere
  // else -- turn it on through the real toggle before driving the click (see
  // check-click.mjs's own comment on the same change).
  const modeToggle = document.getElementById('comment-mode-toggle');
  assert.ok(modeToggle, 'setup failure: no comment-mode toggle rendered on the board page');
  modeToggle.dispatchEvent(new StandInEvent('click'));

  // Same ordering as check-click.mjs: the synchronous wiring pass already ran
  // against the about:blank placeholder by the time we get here; only now does
  // the real srcdoc document arrive and fire 'load'.
  frame.loadSrcdoc();

  const stageDoc = frame.contentDocument;
  const button = stageDoc.querySelector('button');
  assert.ok(button, 'setup failure: the loaded stage document has no <button>');

  button.dispatchEvent(new StandInEvent('click'));

  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form && form.classList.contains('open'), 'setup failure: the click did not open the comment form (see check-click.mjs for that gesture on its own)');

  const section = document.querySelector('.html-block');
  assert.ok(section, 'setup failure: no .html-block section on the rendered page');
  const layer = section.querySelector('.pin-layer');
  assert.ok(layer, 'setup failure: the html block has no .pin-layer');
  assert.equal(layer.querySelectorAll('.anchor-pin').length, 0, 'setup failure: a pin already exists before anything was ever queued');

  // Fill in the opened form and submit it -- the queueing gesture that actually
  // draws the pin (src/ui.mjs: a comment gets its pin the moment it is queued).
  const input = form.querySelector('input[type=text]');
  assert.ok(input, 'setup failure: the comment form has no text input');
  input.value = 'nice button';
  form.dispatchEvent(new StandInEvent('submit'));

  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, `expected exactly one pin in the block's pin-layer after queueing one comment, got ${pins.length}`);
  const pin = pins[0];
  assert.equal(pin.textContent, '1', `expected the pin to be numbered "1" (the first comment on this board), got ${JSON.stringify(pin.textContent)}`);
  assert.equal(pin.classList.contains('pin-lost'), false, 'a freshly-queued comment anchored to the element that was actually clicked must not render as lost');
  assert.ok(String(pin.title || '').indexOf('Send') !== -1, `expected the pin's title to name the clicked element ("Send"), got ${JSON.stringify(pin.title)}`);

  // V1: test/dom-stand-in.mjs's
  // getBoundingClientRect used to return an unconditional all-zero box, so this
  // check's own name -- "positioned from the real (loaded) stage document" -- was
  // never actually true: the director confirmed that replacing BOTH of
  // src/ui.mjs's position computations with a hardcoded {left:9999, top:-4242}
  // caused zero check failures anywhere in the suite. The stand-in now derives a
  // deterministic, per-element box (see Element.getBoundingClientRect's own
  // comment), so the stage's own answer -- the element's client rect, frame
  // viewport coordinates (PROTOCOL.md 'positions') -- can be recomputed
  // independently, here, from the actual clicked element, and compared against
  // what the pin actually got. A hardcoded-garbage ablation fails this outright;
  // a stage root swapped for the about:blank placeholder (a different `left`/`top`
  // altogether) would fail it too.
  const expectedBox = button.getBoundingClientRect();
  const expectedLeft = expectedBox.left;
  const expectedTop = expectedBox.top;
  assert.equal(pin.style.left, expectedLeft + 'px', `expected the pin's left to be computed from the REAL stage document's own layout (${expectedLeft}px), got ${JSON.stringify(pin.style.left)}`);
  assert.equal(pin.style.top, expectedTop + 'px', `expected the pin's top to be computed from the REAL stage document's own layout (${expectedTop}px), got ${JSON.stringify(pin.style.top)}`);
});

check('two different elements inside the same stage get two different, independently correct pin positions -- not the same fallback offset, not each other\'s box', () => {
  // Same reasoning as `board` above: a trailing markdown block keeps this out
  // of page-board layout.
  const twoElBoard = createBoard({
    title: 'two elements, two distinguishable pin positions',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button><p>a caption</p></div>' },
      { kind: 'markdown', text: 'not a page board' },
    ],
  });
  const twoElBlockId = twoElBoard.blocks[0].id;
  const twoElHtml = renderBoardPage(twoElBoard);

  const document = parseHTML(twoElHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  // 'EventSource' declared, never passed -- see QUIRKS.md "A `new Function` harness
  // inherits the host's globals" for why.
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);

  const frame = document.querySelector('.html-stage');
  const modeToggle = document.getElementById('comment-mode-toggle');
  modeToggle.dispatchEvent(new StandInEvent('click'));
  frame.loadSrcdoc();
  const stageDoc = frame.contentDocument;
  const button = stageDoc.querySelector('button');
  const p = stageDoc.querySelector('p');
  assert.ok(button && p, 'setup failure: the loaded stage is missing the button or the paragraph');

  button.dispatchEvent(new StandInEvent('click'));
  let form = document.getElementById('comment-form-' + twoElBlockId);
  let input = form.querySelector('input[type=text]');
  input.value = 'about the button';
  form.dispatchEvent(new StandInEvent('submit'));

  p.dispatchEvent(new StandInEvent('click'));
  form = document.getElementById('comment-form-' + twoElBlockId);
  input = form.querySelector('input[type=text]');
  input.value = 'about the caption';
  form.dispatchEvent(new StandInEvent('submit'));

  const layer = document.querySelector('.html-block').querySelector('.pin-layer');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 2, `expected two pins after queueing two comments, got ${pins.length}`);

  const buttonBox = button.getBoundingClientRect();
  const pBox = p.getBoundingClientRect();
  const expectedButton = { left: buttonBox.left + 'px', top: buttonBox.top + 'px' };
  const expectedP = { left: pBox.left + 'px', top: pBox.top + 'px' };

  assert.notEqual(expectedButton.left + ',' + expectedButton.top, expectedP.left + ',' + expectedP.top,
    'setup failure: the two fixture elements must have distinguishable positions under the stand-in\'s layout model, or this check cannot tell them apart');

  // The pin's title carries the anchor's HINT (the clicked element's own text --
  // "Send" for the button, "a caption" for the paragraph), never the comment text
  // itself (src/ui.mjs's placePin), so that is what distinguishes them here.
  const buttonPin = pins.find(pin => String(pin.title || '').indexOf('Send') !== -1);
  const pPin = pins.find(pin => String(pin.title || '').indexOf('a caption') !== -1);
  assert.ok(buttonPin && pPin, 'setup failure: could not tell the two pins apart by their title');

  assert.equal(buttonPin.style.left, expectedButton.left, 'the button\'s pin must be positioned at the button\'s own box, not a fallback or the paragraph\'s');
  assert.equal(buttonPin.style.top, expectedButton.top);
  assert.equal(pPin.style.left, expectedP.left, 'the paragraph\'s pin must be positioned at the paragraph\'s own box, not the button\'s');
  assert.equal(pPin.style.top, expectedP.top);
});

check('a stored dom ref on a CONTEXT diagram is dropped rather than walked: the pin stacks in the item\'s own layer instead of landing on whatever the re-based index now hits', () => {
  // ADR.md entry 110 dropped the kicker from every context item, which re-bases
  // every child index a comment minted against the old card shape: a ref that
  // named the diagram's own stage now names the control group beside it. The
  // server's verdict is no help -- resolveComment walks the block RE-RENDERED
  // through renderBlock, a full card with its kicker still first, so it and this
  // page are not even looking at the same tree. Dropped on read: the pin stacks,
  // the way a lost anchor's already does. A comment on a diagram NODE is a
  // 'mermaid' anchor carrying the node's own id and is unaffected.
  const contextBoard = createBoard({
    title: 'a stale index on a context diagram',
    blocks: [{
      kind: 'question',
      prompt: 'Does the flow look right?',
      widget: 'single',
      options: [{ label: 'Yes' }, { label: 'No' }],
      context: [{ kind: 'mermaid', text: 'flowchart LR\n  A --> B' }],
    }],
  });
  const diagramId = contextBoard.blocks[0].context[0].id;
  // "2" addressed the stage under the old card shape (kicker first); under the
  // panel it addresses the control group, a real element with a real box.
  contextBoard.comments.push({
    n: 1, blockId: diagramId, text: 'about the diagram', round: 1,
    createdAt: new Date().toISOString(),
    anchor: { kind: 'dom', ref: '2', hint: 'flowchart LR A --> B' },
  });

  const document = parseHTML(renderBoardPage(contextBoard));
  const window = document.defaultView;
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, { protocol: 'http:' });

  const item = document.querySelector('.context-item.mermaid-block');
  assert.ok(item, 'setup failure: no context diagram item on the page');
  const tools = item.querySelector('.context-tools');
  assert.ok(tools, 'setup failure: the item must carry the control group the stale index now addresses');
  const toolsBox = tools.getBoundingClientRect();
  assert.notEqual(toolsBox.left + ',' + toolsBox.top, '10,10',
    'setup failure: the wrongly-addressed element must be distinguishable from the stacked fallback, or this check cannot tell them apart');

  // The item's OWN layer, a direct child -- not the stage-scoped one nested
  // inside .stage-wrap, which a deep querySelector finds first and which only
  // ever holds 'mermaid'-kind pins (src/ui.mjs's directChildPinLayer).
  const layer = item.children.find(el => (el.getAttribute('class') || '').split(' ').includes('pin-layer'));
  assert.ok(layer, 'setup failure: the context item has no pin-layer of its own');
  const pins = layer.querySelectorAll('.anchor-pin');
  assert.equal(pins.length, 1, 'the comment is still shown -- dropped means "not trusted for a position", never "not shown"');
  assert.equal(pins[0].style.left, '10px', 'the pin stacks at the layer\'s own offset');
  assert.equal(pins[0].style.top, '10px');
  assert.notEqual(pins[0].style.left, toolsBox.left + 'px',
    'and never at the control group the re-based index happens to hit (ablation: drop the .context-item guard from renderDomPins and it lands here)');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall click-pin checks ok');
