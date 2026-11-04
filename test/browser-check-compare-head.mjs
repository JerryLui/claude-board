// Real-browser check for a compare card's side heads. Each side holding a stage or a
// diagram carries its Comment button on its BEFORE or AFTER label row, a titled
// side's title sits on that row too, and the two pictures start at the same height,
// straight under the label rows: for html and mermaid sides, untitled, titled, and
// one side titled. All of that is layout, which the DOM stand-in the suite runs on
// has none of (QUIRKS.md "The DOM stand-in's ceilings"): test/check-comment-mode.mjs
// holds the button's wiring.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass
// on a machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-compare-head.mjs [--shot=<file.png>]
//
// `--shot` also writes the board at a 1440px window as a PNG, from its header down to
// the last compare card.
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch
// port and a scratch store, headless Chrome over the DevTools Protocol. What is
// measured, never assumed: each label's, button's, title's and picture's
// getBoundingClientRect. A picture is a side's `.stage-wrap`, the frame its stage or
// diagram draws in.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { runMain, sleep } from './support.mjs';
import { guardRun, openTab, postJson, requireChrome, row, startScratchDaemon, withChrome } from './browser-support.mjs';

const WIDTHS = [1280, 1440];
const SHOT_WIDTH = 1440;
// Tall enough that the whole board is on screen at once, so the shot shows every frame drawn.
const HEIGHT = 2400;
const SHOT_MARGIN = 24;
// The gap under a side's label row, before its picture: what the label's own margin
// gave before the Comment button moved onto the row. Written out here, not read from
// src/styles.mjs, so a drift there turns a row red.
const ROW_GAP = 8;
const TOLERANCE = 1;

guardRun('browser-check-compare-head', { deadlineMs: 180000 });

const shotArg = process.argv.find(a => a.startsWith('--shot='));
const SHOT_FILE = shotArg ? shotArg.slice('--shot='.length) : null;

const px = n => `${Math.round(n * 10) / 10}px`;

// ---------------------------------------------------------------------------
// The board: one compare card per case, each named by its own title.
const mock = (text, tint) => `<div style="height:180px;display:flex;align-items:center;justify-content:center;`
  + `font:600 16px/1.4 sans-serif;color:#2d3a4f;background:${tint}">${text}</div>`;
const diagram = prefix => `flowchart LR\n  ${prefix}1["${prefix} one"] --> ${prefix}2["${prefix} two"] --> ${prefix}3["${prefix} three"]`;

const CASES = [
  { name: 'html sides, untitled', kind: 'html', titles: [null, null] },
  { name: 'html sides, titled', kind: 'html', titles: ['The sign-in today', 'The sign-in after'] },
  { name: 'html sides, one titled', kind: 'html', titles: ['The sign-in today', null] },
  { name: 'mermaid sides, untitled', kind: 'mermaid', titles: [null, null] },
  { name: 'mermaid sides, titled', kind: 'mermaid', titles: ['The flow today', 'The flow after'] },
  { name: 'mermaid sides, one titled', kind: 'mermaid', titles: [null, 'The flow after'] },
];

function sideOf(kind, label, title, n) {
  const content = kind === 'html'
    ? { html: mock(`${label} picture`, label === 'Before' ? '#dbe3f1' : '#dcefdf') }
    : { text: diagram(`${label[0]}${n}`) };
  return { label, block: { kind, ...(title ? { title } : {}), ...content } };
}

const boardBody = () => ({
  title: 'compare head browser check',
  blocks: CASES.map((c, n) => ({
    kind: 'compare', title: c.name,
    left: sideOf(c.kind, 'Before', c.titles[0], n),
    right: sideOf(c.kind, 'After', c.titles[1], n),
  })),
});

// Each compare card by its title: per side, its label, every Comment button, every
// title and its picture.
const MEASURE_EXPR = `(function () {
  function box(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  return [].slice.call(document.querySelectorAll('.round-current > .compare-block')).map(function (b) {
    var title = b.querySelector(':scope > .card-head > .card-title');
    return {
      name: title ? title.textContent.trim() : '',
      sides: [].slice.call(b.querySelectorAll(':scope > .compare-grid > .compare-side')).map(function (s) {
        var label = s.querySelector('.compare-label');
        return {
          label: label ? label.textContent.trim() : '',
          labelBox: box(label),
          buttons: [].slice.call(s.querySelectorAll('.comment-btn')).map(box),
          titles: [].slice.call(s.querySelectorAll('.card-title')).map(function (t) {
            return { text: t.textContent.trim(), box: box(t) };
          }),
          picture: box(s.querySelector('.stage-wrap')),
        };
      }),
    };
  });
})()`;

// Every diagram drawn, then the layout held still for half a second.
async function settle(tab, width) {
  await tab.until(`[].slice.call(document.querySelectorAll('.round-current pre.mermaid'))
    .every(function (p) { return !!p.querySelector('svg'); })`, `every diagram drawn at ${width}px`);
  let last = null;
  let since = Date.now();
  const deadline = Date.now() + 20000;
  for (;;) {
    await sleep(100);
    const now = JSON.stringify(await tab.evalPage(MEASURE_EXPR));
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 500) return JSON.parse(now);
    if (Date.now() >= deadline) throw new Error(`layout never held still at ${width}px`);
  }
}

const overlapsRow = (b, row) => b.top < row.bottom && b.bottom > row.top;

/** The bottom of a side's label row: the lowest of the label and whatever sits on
 * its line (a box that overlaps the label top to bottom). */
function rowBottom(side) {
  const onRow = [...side.buttons, ...side.titles.map(t => t.box)].filter(b => overlapsRow(b, side.labelBox));
  return Math.max(side.labelBox.bottom, ...onRow.map(b => b.bottom));
}

// ---------------------------------------------------------------------------
async function main() {
  requireChrome('browser-check-compare-head');

  const daemon = await startScratchDaemon('cb-compare-head');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const posted = await postJson(`${origin}/api/board`, boardBody(), daemon.secret);
    assert.ok(posted.url, `daemon did not return a board url: ${JSON.stringify(posted)}`);
    const url = `${origin}${new URL(posted.url).pathname}`;

    await withChrome({ tag: 'cb-compare-head' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const at = {};
      for (const width of WIDTHS) {
        const tab = await openTab(send, onEvent, url, cookie, { width, height: HEIGHT, theme: 'light', expr: 'true' });
        try {
          at[width] = await settle(tab, width);
          if (SHOT_FILE && width === SHOT_WIDTH) {
            // The header down to the last compare card: the send bar and the pager sit
            // at the window's foot, under it.
            const bottom = await tab.evalPage(`[].slice.call(document.querySelectorAll('.round-current > .compare-block'))
              .reduce(function (a, b) { return Math.max(a, b.getBoundingClientRect().bottom); }, 0)`);
            assert.ok(bottom > 0 && bottom + SHOT_MARGIN <= HEIGHT, `setup: every compare card is in the ${HEIGHT}px window for the shot`);
            const shot = await tab.sp('Page.captureScreenshot', {
              format: 'png', clip: { x: 0, y: 0, width, height: Math.ceil(bottom + SHOT_MARGIN), scale: 1 },
            });
            writeFileSync(SHOT_FILE, Buffer.from(shot.data, 'base64'));
            console.log(`wrote ${SHOT_FILE}`);
          }
        } finally { await tab.close(); }
      }
      await runRows(at);
    });
  } finally {
    await daemon.stop();
  }
}

async function runRows(at) {
  for (const width of WIDTHS) {
    for (const c of CASES) {
      const card = at[width].find(m => m.name === c.name);
      const where = `at a ${width}px window, ${c.name}`;
      const setup = () => {
        assert.ok(card, `setup: the "${c.name}" compare card found`);
        assert.deepEqual(card.sides.map(s => s.label), ['Before', 'After'], 'setup: both sides and their labels found');
        for (const s of card.sides) assert.ok(s.labelBox && s.picture, `setup: the ${s.label} side's label and picture found`);
      };

      await row(`${where}: each side's Comment button sits on its label row, right of the label`, note => {
        setup();
        const wrong = [];
        for (const s of card.sides) {
          note(`${s.label}: label ${px(s.labelBox.top)} to ${px(s.labelBox.bottom)}; `
            + `${s.buttons.length} Comment button(s)${s.buttons.map(b => ` at ${px(b.top)} to ${px(b.bottom)}, x ${px(b.left)}`).join(',')}`);
          if (s.buttons.length !== 1) { wrong.push(`${s.label}: ${s.buttons.length} Comment buttons`); continue; }
          const [b] = s.buttons;
          if (!overlapsRow(b, s.labelBox)) wrong.push(`${s.label}: the button is off the label's row`);
          if (b.left <= s.labelBox.right) wrong.push(`${s.label}: the button starts at x ${px(b.left)}, not right of the label`);
        }
        assert.deepEqual(wrong, []);
      });

      if (c.titles.some(Boolean)) {
        await row(`${where}: a titled side's title sits on its label row, between the label and the button`, note => {
          setup();
          const wrong = [];
          for (const [i, s] of card.sides.entries()) {
            const want = c.titles[i];
            note(`${s.label}: ${s.titles.length ? s.titles.map(t => `"${t.text.slice(0, 24)}" at ${px(t.box.top)} to ${px(t.box.bottom)}, x ${px(t.box.left)} to ${px(t.box.right)}`).join('; ') : 'no title'}`);
            if (!want) { if (s.titles.length) wrong.push(`${s.label}: an untitled side shows a title`); continue; }
            if (s.titles.length !== 1 || s.titles[0].text !== want) { wrong.push(`${s.label}: title ${JSON.stringify(s.titles.map(t => t.text))}`); continue; }
            const t = s.titles[0].box;
            if (!overlapsRow(t, s.labelBox)) wrong.push(`${s.label}: the title is off the label's row`);
            if (t.left <= s.labelBox.right) wrong.push(`${s.label}: the title starts at x ${px(t.left)}, not right of the label`);
            if (s.buttons[0] && t.right > s.buttons[0].left) wrong.push(`${s.label}: the title runs under the button`);
          }
          assert.deepEqual(wrong, []);
        });
      }

      await row(`${where}: the two pictures start at the same height, ${ROW_GAP}px under the label rows`, note => {
        setup();
        const [l, r] = card.sides;
        const under = Math.max(rowBottom(l), rowBottom(r));
        note(`pictures' tops: Before ${px(l.picture.top)}, After ${px(r.picture.top)}; label rows end at ${px(under)}`);
        assert.ok(Math.abs(l.picture.top - r.picture.top) <= TOLERANCE,
          `the pictures start ${px(Math.abs(l.picture.top - r.picture.top))} apart`);
        for (const s of card.sides) {
          const gap = s.picture.top - under;
          assert.ok(Math.abs(gap - ROW_GAP) <= TOLERANCE, `the ${s.label} picture starts ${px(gap)} under the label rows`);
        }
      });
    }
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
