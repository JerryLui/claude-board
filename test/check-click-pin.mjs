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

const board = createBoard({
  title: 'the pin actually lands',
  blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
});
const blockId = board.blocks[0].id;
const pageHtml = renderBoardPage(board);

check('clicking an element, then submitting the opened comment form, draws a numbered pin into that block\'s .pin-layer, positioned from the real (loaded) stage document', () => {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);

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
  // comment), so the SAME formula src/ui.mjs's renderDomPins uses --
  // `elBox.left - stageBox.left`, `elBox.top - stageBox.top`, both relative to the
  // REAL (post-loadSrcdoc) stage body -- can be recomputed independently, here,
  // from the actual clicked element and actual stage root, and compared against
  // what the pin actually got. A hardcoded-garbage ablation fails this outright;
  // a stage root swapped for the about:blank placeholder (a different `left`/`top`
  // altogether) would fail it too.
  const expectedBox = button.getBoundingClientRect();
  const stageBox = stageDoc.body.getBoundingClientRect();
  const expectedLeft = expectedBox.left - stageBox.left;
  const expectedTop = expectedBox.top - stageBox.top;
  assert.equal(pin.style.left, expectedLeft + 'px', `expected the pin's left to be computed from the REAL stage document's own layout (${expectedLeft}px), got ${JSON.stringify(pin.style.left)}`);
  assert.equal(pin.style.top, expectedTop + 'px', `expected the pin's top to be computed from the REAL stage document's own layout (${expectedTop}px), got ${JSON.stringify(pin.style.top)}`);
});

check('two different elements inside the same stage get two different, independently correct pin positions -- not the same fallback offset, not each other\'s box', () => {
  const twoElBoard = createBoard({
    title: 'two elements, two distinguishable pin positions',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button><p>a caption</p></div>' }],
  });
  const twoElBlockId = twoElBoard.blocks[0].id;
  const twoElHtml = renderBoardPage(twoElBoard);

  const document = parseHTML(twoElHtml);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);

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

  const stageBox = stageDoc.body.getBoundingClientRect();
  const buttonBox = button.getBoundingClientRect();
  const pBox = p.getBoundingClientRect();
  const expectedButton = { left: (buttonBox.left - stageBox.left) + 'px', top: (buttonBox.top - stageBox.top) + 'px' };
  const expectedP = { left: (pBox.left - stageBox.left) + 'px', top: (pBox.top - stageBox.top) + 'px' };

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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall click-pin checks ok');
