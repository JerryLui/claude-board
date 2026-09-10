// "A diagram on a round that is not the page on screen is drawn by the flip
// that shows it, never while hidden." Rounds are pages (ADR.md entry 42) and a
// page that is not current is display:none; mermaid measures its labels inside
// the node it draws into, so a diagram drawn there comes out blank and stays
// blank -- 'data-processed' set, nothing to retry. Seen for real on 2026-09-10:
// five figures on round 1, every one an empty card once round 2 existed.
//
// Driven the way test/check-mermaid-theme.mjs drives its redraws: the real
// src/theme.mjs boot script and the real src/ui.mjs client script against
// test/dom-stand-in.mjs, with a mock engine that behaves like mermaid 11 on the
// two facts that matter here -- it claims 'data-processed' on every node it is
// handed, and it draws whatever it is handed, hidden or not, because a mock has
// no layout to measure. So the assertion is on what src/ui.mjs HANDS it: a
// hidden round's node must never reach run(), and the flip that shows the round
// must hand it over exactly then. The loaders are copied, not shared -- there
// is no shared test-helper module in this repo, by convention.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit } from '../src/board.mjs';
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

const DIAGRAM_SOURCE = 'flowchart LR\n  A[Start] --> B[End]';

/** Draws every node it is handed and records which -- the whole point is what
 * it is NOT handed. Claims 'data-processed' first, like mermaid 11, and skips a
 * node already carrying it, so a repeated pass over a drawn node is a no-op
 * here as it is for real. */
function mockMermaid() {
  const drawn = [];
  return {
    drawn,
    initialize() {},
    async run(opts) {
      for (const n of opts.nodes || []) {
        if (n.getAttribute('data-processed') === 'true') continue;
        n.setAttribute('data-processed', 'true');
        drawn.push(n.closest('.round').getAttribute('data-round'));
        n.innerHTML = '<svg id="mermaid-1"><g class="node" id="mermaid-1-flowchart-A-1"><rect></rect></g></svg>';
      }
    },
  };
}

async function loadBoard(pageHtml, mermaid) {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  window.mermaid = mermaid;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location, undefined);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, undefined);
  document.finishParsing();
  await flush();
  return document;
}

/** Round 1 sent and carrying a diagram, round 2 open and carrying another: the
 * page lands on round 2, so round 1 is the hidden page at load. */
function twoDiagramRounds() {
  const board = createBoard({ title: 'Figures', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'More figures', blocks: [{ kind: 'mermaid', text: DIAGRAM_SOURCE }] });
  return board;
}

function preOfRound(document, n) {
  return document.querySelector(`.round[data-round="${n}"] pre.mermaid`);
}

function click(el) {
  assert.ok(el, 'setup failure: element to click is missing');
  el.dispatchEvent(new StandInEvent('click'));
}

await check('load draws only the page on screen; the hidden round keeps its source, unclaimed', async () => {
  const mermaid = mockMermaid();
  const document = await loadBoard(renderBoardPage(twoDiagramRounds()), mermaid);
  assert.deepEqual(mermaid.drawn, ['2'], 'only the current round is handed to mermaid at load');
  assert.ok(preOfRound(document, 2).querySelector('svg'), 'the current round is drawn');
  const hidden = preOfRound(document, 1);
  assert.equal(hidden.querySelector('svg'), null, 'the hidden round is not drawn');
  assert.equal(hidden.getAttribute('data-processed'), null, 'the hidden round is not claimed either');
  assert.equal(hidden.textContent, DIAGRAM_SOURCE, 'the hidden round still carries its source');
});

await check('the flip that shows a round draws it, and a second flip draws nothing twice', async () => {
  const mermaid = mockMermaid();
  const document = await loadBoard(renderBoardPage(twoDiagramRounds()), mermaid);
  click(document.querySelector('.round-page[data-round="1"]'));
  await flush();
  assert.deepEqual(mermaid.drawn, ['2', '1'], 'the flip hands the arriving round to mermaid');
  assert.ok(preOfRound(document, 1).querySelector('svg'), 'round 1 is drawn once shown');
  click(document.querySelector('.round-page[data-round="2"]'));
  await flush();
  click(document.querySelector('.round-page[data-round="1"]'));
  await flush();
  assert.deepEqual(mermaid.drawn, ['2', '1'], 'flipping back and forth redraws nothing');
});

await check('a theme switch redraws the page on screen and puts the hidden page back to source for its next flip', async () => {
  const mermaid = mockMermaid();
  const document = await loadBoard(renderBoardPage(twoDiagramRounds()), mermaid);
  click(document.querySelector('.round-page[data-round="1"]'));
  await flush();
  click(document.getElementById('theme-toggle'));
  await flush();
  assert.deepEqual(mermaid.drawn, ['2', '1', '1'], 'the switch redraws the round on screen only');
  const hidden = preOfRound(document, 2);
  assert.equal(hidden.querySelector('svg'), null, 'the hidden round is back to source, not redrawn blind');
  assert.equal(hidden.textContent, DIAGRAM_SOURCE, 'its source is intact');
  click(document.querySelector('.round-page[data-round="2"]'));
  await flush();
  assert.deepEqual(mermaid.drawn, ['2', '1', '1', '2'], 'the flip back draws it in the live theme');
  assert.ok(preOfRound(document, 2).querySelector('svg'), 'round 2 is drawn again');
});

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
