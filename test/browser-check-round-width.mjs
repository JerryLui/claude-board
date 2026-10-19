// Real-browser check for how wide a question round lays out. On a window wider
// than the 1120px column the board used to cap at, a round's rendered blocks (an
// html stage, a mermaid diagram, a compare, a rendered-variant card, at top level
// and inside a question's context) take the extra width, while its prose (a
// markdown paragraph, heading or list item, a question prompt, an option label or
// description, a note or answer field, a rank item, a comment list) holds a
// reading measure of at most 80ch of its own font. An option's preview image or
// code sits in a card whose words hold that measure, and is never narrower than
// the old column drew it. A page board, one html block
// and nothing else, still fills the window. All of that is layout, and the DOM
// stand-in the suite runs on has none (QUIRKS.md "The DOM stand-in's ceilings"):
// test/check-pure.mjs holds the rules on declared values and this file looks at
// real ones.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass
// on a machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-round-width.mjs
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch
// port and a scratch store, headless Chrome over the DevTools Protocol with Node's
// native WebSocket, zero npm dependencies. Real scrollbars, not
// --hide-scrollbars: an ordinary board always has a document scrollbar, and
// the width it takes is part of what a round lays out in (QUIRKS.md "`100vw` is
// wider than the page whenever the page actually scrolls").
//
// One ordinary board carries every kind of block once at top level and once in a
// question's context, and each width opens it in a fresh tab whose viewport is
// fixed before the page loads. "Today's 1120px column" is the same board in a
// window whose document is exactly 1120px wide: the column capped there, so every
// wider window laid the board out the same way, and the 1280px rows compare
// against it as well. What is measured, never assumed: each element's
// getBoundingClientRect, and each prose element's `ch` read off a 100-zero probe
// set in that element's own computed font.

import assert from 'node:assert/strict';
import { sessionToken } from '../src/secret.mjs';
import { runMain, sleep, withTimeout } from './support.mjs';
import {
  guardRun, postJson, requireChrome, row, setSessionCookie, startScratchDaemon, withChrome,
} from './browser-support.mjs';

// The numbers this check holds the layout to, written out here rather than read
// from src/styles.mjs, so a drift there turns a row red instead of moving the
// expectation with it.
const OLD_COLUMN = 1120; // the column a round was capped at before it widened
const MEASURE_CH = 80; // the longest prose line, in `ch` of the element's own font
const WIDE = [1920, 2560];
const NARROW = 1280;
const HEIGHT = 1200;
const PAGE_BOARD_VIEWPORT = { width: 2560, height: 1440 };

// An option's preview image. A preview `<img>` may load from the page's own
// origin only and the daemon serves no images, so openAt answers this one
// request itself; 3000px wide, wider than any window here, so it draws as wide
// as its card lets it.
const PREVIEW_IMAGE_PATH = '/preview-wide.svg';
const PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="120" viewBox="0 0 3000 120">'
  + '<rect width="3000" height="120" fill="#7a8a9a"/></svg>';
const PREVIEW_CODE = 'const preview = renderOption(option);\nreturn preview.width;';

const RUN_DEADLINE_MS = 240000;
guardRun('browser-check-round-width', { deadlineMs: RUN_DEADLINE_MS });

const px = n => `${Math.round(n)}px`;

// ---------------------------------------------------------------------------
// The board. Long text everywhere a line can run long, so a prose element missing
// its measure fills whatever width it is given and shows it.
const LONG = 'A line of ordinary prose that keeps going well past the point where a reader would want it to wrap, '
  + 'so that the only thing deciding where it breaks is the width the board gives it and never the length of '
  + 'the sentence itself, which matters because a short line would pass a measure it was never held to, and '
  + 'this one is long enough to fill even the widest window this check opens.';

const mock = name => `<div data-mock="${name}" style="font:15px/1.5 sans-serif;padding:20px">`
  + `<h2 style="margin:0 0 8px">Mock ${name}</h2><p style="margin:0">${LONG}</p></div>`;

/** A left-to-right chain long enough that its natural width is wider than any
 * window here, so the diagram is scaled to its box and grows with it. */
const chain = prefix => ['flowchart LR',
  ...Array.from({ length: 16 }, (_, i) => `  ${prefix}${i}["${prefix} step ${i + 1}"]`),
  ...Array.from({ length: 15 }, (_, i) => `  ${prefix}${i} --> ${prefix}${i + 1}`)].join('\n');

function roundBody(origin) {
  const previewImage = `${origin}${PREVIEW_IMAGE_PATH}`;
  return {
    title: 'round width browser check',
    blocks: [
      { kind: 'markdown', text: `${LONG}\n\n- ${LONG}\n- A short item.\n\n##### ${LONG}\n\n###### ${LONG}` },
      { kind: 'html', html: mock('top') },
      { kind: 'mermaid', text: chain('Top') },
      {
        kind: 'compare',
        left: { label: 'Before, top level', block: { kind: 'html', html: mock('before') } },
        right: { label: 'After, top level', block: { kind: 'html', html: mock('after') } },
      },
      {
        // No stage anywhere in it, so its context sits in the panel beside the options.
        kind: 'question', prompt: `Beside a panel: ${LONG}`, explainer: LONG, widget: 'single',
        options: [{ label: `Option one: ${LONG}`, description: LONG }, { label: 'Option two', preview: PREVIEW_CODE }],
        context: [
          { kind: 'markdown', text: LONG },
          { kind: 'mermaid', text: chain('Ctx') },
          {
            kind: 'compare',
            left: { label: 'Before, in context', block: { kind: 'markdown', text: LONG } },
            right: { label: 'After, in context', block: { kind: 'markdown', text: LONG } },
          },
        ],
      },
      {
        // A stage in its context, so the context renders full width under the prompt.
        kind: 'question', prompt: `Over a stage: ${LONG}`, widget: 'multi',
        options: [{ label: `First: ${LONG}` }, { label: `Second: ${LONG}`, description: LONG, preview: PREVIEW_CODE }],
        context: [{ kind: 'html', html: mock('ctx') }],
      },
      {
        // No context, so one column: in the old column each card, and the
        // preview in it, ran the column's whole width.
        kind: 'question', prompt: 'Pick by its preview', widget: 'single',
        options: [
          { label: `Pictured: ${LONG}`, description: LONG, preview: previewImage },
          { label: `Coded: ${LONG}`, preview: PREVIEW_CODE },
        ],
      },
      {
        kind: 'question', prompt: `Between mocks: ${LONG}`, widget: 'choose-between-rendered-variants',
        options: [
          { label: `Mock A: ${LONG}`, description: LONG, block: { kind: 'html', html: mock('var-a') } },
          { label: 'Mock B', block: { kind: 'html', html: mock('var-b') } },
        ],
      },
      {
        kind: 'question', prompt: 'Between drawings', widget: 'choose-between-rendered-variants',
        options: [
          { label: 'Drawing A', block: { kind: 'mermaid', text: 'flowchart LR\n  a1["one"] --> a2["two"]' } },
          { label: 'Drawing B', block: { kind: 'markdown', text: LONG } },
        ],
      },
      { kind: 'question', prompt: `In your words: ${LONG}`, widget: 'text' },
      { kind: 'question', prompt: 'In order', widget: 'rank', options: [{ label: LONG }, { label: 'Last' }] },
    ],
  };
}

const pageBody = () => ({ title: 'page board width', blocks: [{ kind: 'html', html: mock('page') }] });

// Every kind of prose element the board carries, by what a reader sees.
const PROSE = [
  ['markdown paragraph', '.md-content p'],
  ['markdown list item', '.md-content li'],
  ['markdown heading 5', '.md-content h5'],
  ['markdown heading 6', '.md-content h6'],
  ['question prompt', '.question-prompt'],
  ['option label', '.opt-label'],
  ['option description', '.opt-desc'],
  ['note field', '.note-field textarea'],
  ['answer field', '.answer-textarea'],
  ['rank item', '.rank-list li'],
  ['comment list', '.comment-list'],
];

// Read in the board page. Every rendered block by what it carries, every prose
// element by kind, each with its own font's `ch`, and every option preview by
// the option it belongs to.
const MEASURE_EXPR = `(function () {
  function w(el) { return el ? el.getBoundingClientRect().width : null; }
  function frameBy(name) {
    return [].slice.call(document.querySelectorAll('.round-current iframe.html-stage'))
      .find(function (f) { return (f.getAttribute('srcdoc') || '').indexOf('data-mock="' + name + '"') !== -1; });
  }
  function compareBy(label) {
    return [].slice.call(document.querySelectorAll('.round-current .compare-grid'))
      .find(function (g) { return g.querySelector('.compare-label').textContent === label; });
  }
  function diagramBy(prefix) {
    return [].slice.call(document.querySelectorAll('.round-current pre.mermaid'))
      .find(function (p) { return p.textContent.indexOf(prefix + ' step 1') !== -1; });
  }
  function variantBy(label) {
    return [].slice.call(document.querySelectorAll('.round-current .variant-card'))
      .find(function (c) { return c.getAttribute('data-choice').indexOf(label) === 0; });
  }
  var top = diagramBy('Top'), ctx = diagramBy('Ctx');
  var blocks = {
    'html stage, top level': w(frameBy('top')),
    "html stage, in a question's context": w(frameBy('ctx')),
    'compare (html sides), top level': w(compareBy('Before, top level')),
    "compare, in a question's context": w(compareBy('Before, in context')),
    'mermaid diagram box, top level': w(top),
    "mermaid diagram box, in a question's context": w(ctx),
    'mermaid drawing (svg), top level': w(top && top.querySelector('svg')),
    "mermaid drawing (svg), in a question's context": w(ctx && ctx.querySelector('svg')),
    'rendered-variant card (html), Mock A': w(variantBy('Mock A')),
    'rendered-variant card (html), Mock B': w(variantBy('Mock B')),
  };
  // A card that shares its row with another (a non-html option) is held to its
  // own 1120-column width only: two of them side by side are each half a row.
  var shared = {
    'rendered-variant card (mermaid), sharing its row': w(variantBy('Drawing A')),
    'rendered-variant card (markdown), sharing its row': w(variantBy('Drawing B')),
  };
  function chOf(el) {
    var cs = getComputedStyle(el), s = document.createElement('span');
    s.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;letter-spacing:0;text-transform:none';
    s.style.fontFamily = cs.fontFamily; s.style.fontSize = cs.fontSize; s.style.fontWeight = cs.fontWeight;
    s.style.fontStyle = cs.fontStyle; s.style.fontStretch = cs.fontStretch;
    s.textContent = new Array(101).join('0');
    document.body.appendChild(s);
    var one = s.getBoundingClientRect().width / 100;
    s.remove();
    return one;
  }
  var PROSE = ${JSON.stringify(PROSE)};
  var prose = {};
  PROSE.forEach(function (kind) {
    [].slice.call(document.querySelectorAll('.round-current ' + kind[1])).forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      if (!r.width) return; // hidden: a closed form, a collapsed card
      prose[kind[0] + ' #' + (i + 1)] = { w: r.width, ch: chOf(el) };
    });
  });
  var previews = {};
  [].slice.call(document.querySelectorAll('.round-current .opt-preview')).forEach(function (p) {
    var option = p.closest('.card-choice').getAttribute('data-choice').split(':')[0];
    var image = p.tagName === 'IMG';
    previews[(image ? 'preview image' : 'preview code') + ' of option "' + option + '"'] =
      { w: w(p), loaded: !image || (p.complete && p.naturalWidth > 0) };
  });
  var root = document.documentElement;
  return { blocks: blocks, shared: shared, prose: prose, previews: previews, docW: root.clientWidth,
    scrollW: root.scrollWidth, innerW: window.innerWidth };
})()`;

// ---------------------------------------------------------------------------
/** Opens `url` in a fresh tab whose viewport is `width` x `height` before the
 * page loads, waits until every diagram has drawn and the layout has held still
 * for half a second, and hands back a page evaluator plus `close`. */
async function openAt(send, onEvent, url, cookie, { width, height }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const sp = (method, params) => send(method, params, sessionId);
  const evalPage = expr => sp('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
    if (r.exceptionDetails) throw new Error(`page eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  });
  const loadFired = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { off(); resolve(); }
    });
  });
  // The option preview image's request, answered here (PREVIEW_IMAGE_PATH).
  const offPreview = onEvent(msg => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== sessionId) return;
    sp('Fetch.fulfillRequest', {
      requestId: msg.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }],
      body: Buffer.from(PREVIEW_SVG).toString('base64'),
    }).catch(() => {});
  });
  await sp('Fetch.enable', { patterns: [{ urlPattern: `*${PREVIEW_IMAGE_PATH}` }] });
  await sp('Page.enable');
  await sp('Runtime.enable');
  await sp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await setSessionCookie(sp, cookie);
  await sp('Page.navigate', { url });
  await withTimeout(loadFired, 20000, `page never fired load: ${url}`);

  const deadline = Date.now() + 20000;
  for (;;) {
    const drawn = await evalPage(`[].slice.call(document.querySelectorAll('.round-current pre.mermaid'))
      .every(function (p) { return !!p.querySelector('svg'); })`);
    if (drawn) break;
    if (Date.now() >= deadline) throw new Error(`diagrams never drew at ${width}px`);
    await sleep(100);
  }
  let last = null;
  let since = Date.now();
  for (;;) {
    await sleep(100);
    const now = JSON.stringify(await evalPage(MEASURE_EXPR));
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since >= 500) break;
    if (Date.now() >= deadline) throw new Error(`layout never held still at ${width}px`);
  }
  return { evalPage, close: () => { offPreview(); return send('Target.closeTarget', { targetId }); } };
}

async function measureAt(open, viewport) {
  const page = await open(viewport);
  try { return await page.evalPage(MEASURE_EXPR); } finally { await page.close(); }
}

// ---------------------------------------------------------------------------
async function main() {
  requireChrome('browser-check-round-width');

  const daemon = await startScratchDaemon('cb-round-width');
  try {
    const daemonPort = await daemon.port();
    const boardUrl = async body => {
      const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, body, daemon.secret);
      assert.ok(posted.url, `daemon did not return a board url: ${JSON.stringify(posted)}`);
      return `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`;
    };
    const roundUrl = await boardUrl(roundBody(`http://127.0.0.1:${daemonPort}`));
    const pageUrl = await boardUrl(pageBody());

    await withChrome({ tag: 'cb-round-width' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const openRound = viewport => openAt(send, onEvent, roundUrl, cookie, viewport);

      // The document scrollbar's width, so the column window's document is
      // exactly the old column wide.
      const probe = await measureAt(openRound, { width: NARROW, height: HEIGHT });
      const scrollbar = probe.innerW - probe.docW;
      const column = await measureAt(openRound, { width: OLD_COLUMN + scrollbar, height: HEIGHT });
      const at = { [NARROW]: probe };
      for (const width of WIDE) at[width] = await measureAt(openRound, { width, height: HEIGHT });
      await runRows({ column, at, scrollbar, pageBoard: () => openAt(send, onEvent, pageUrl, cookie, PAGE_BOARD_VIEWPORT) });
    });
  } finally {
    await daemon.stop();
  }
}

// The facts a row's comparison stands on, asserted inside each row that uses
// them: a missing element would otherwise compare as nothing and pass.
function setupColumn(column, scrollbar, note) {
  note(`document scrollbar ${scrollbar}px; column window document ${column.docW}px`);
  assert.equal(column.docW, OLD_COLUMN, `setup: the column window's document is ${OLD_COLUMN}px wide`);
}
function setupBlocks(m) {
  for (const [name, width] of Object.entries({ ...m.blocks, ...m.shared })) {
    assert.ok(width > 0, `setup: ${name} not found or zero wide at a ${m.innerW}px window`);
  }
}
function setupProse(m) {
  const missing = PROSE.map(([kind]) => kind).filter(kind => !Object.keys(m.prose).some(name => name.startsWith(`${kind} #`)));
  assert.deepEqual(missing, [], `setup: prose kinds not found at a ${m.innerW}px window`);
}
function setupPreviews(m) {
  const names = Object.keys(m.previews);
  assert.ok(names.some(n => n.startsWith('preview image')) && names.some(n => n.startsWith('preview code')),
    `setup: an image and a code preview were found at a ${m.innerW}px window (found: ${names.join(', ') || 'none'})`);
  for (const [name, { w, loaded }] of Object.entries(m.previews)) {
    assert.ok(loaded && w > 0, `setup: ${name} loaded and drew at a ${m.innerW}px window`);
  }
}

async function runRows({ column, at, scrollbar, pageBoard }) {
  for (const width of WIDE) {
    const m = at[width];
    await row(`at a ${width}px window, every rendered block in the round is wider than in the ${OLD_COLUMN}px column and wider than ${OLD_COLUMN}px`, note => {
      setupColumn(column, scrollbar, note);
      setupBlocks(column);
      setupBlocks(m);
      const wrong = [];
      for (const [name, w] of Object.entries(m.blocks)) {
        const was = column.blocks[name];
        const line = `${name}: ${px(w)} (${px(was)} in the column)`;
        note(line);
        if (!(w > was + 1 && w > OLD_COLUMN)) wrong.push(line);
      }
      for (const [name, w] of Object.entries(m.shared)) {
        const was = column.shared[name];
        const line = `${name}: ${px(w)} (${px(was)} in the column)`;
        note(line);
        if (!(w > was + 1)) wrong.push(line);
      }
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, every prose element measures at most ${MEASURE_CH}ch of its own font`, note => {
      setupProse(m);
      const wrong = [];
      const widest = {};
      for (const [name, { w, ch }] of Object.entries(m.prose)) {
        const inCh = w / ch;
        const kind = name.replace(/ #\d+$/, '');
        if (!widest[kind] || inCh > widest[kind].inCh) widest[kind] = { inCh, w };
        if (w > MEASURE_CH * ch + 0.5) wrong.push(`${name}: ${px(w)} = ${inCh.toFixed(1)}ch`);
      }
      for (const [kind, { inCh, w }] of Object.entries(widest)) note(`widest ${kind}: ${px(w)} = ${inCh.toFixed(1)}ch`);
      assert.deepEqual(wrong, []);
    });
  }

  await row(`at a ${WIDE[1]}px window every rendered block is at least as wide as at ${WIDE[0]}px: the extra width is used, not capped`, note => {
    setupBlocks(at[WIDE[0]]);
    setupBlocks(at[WIDE[1]]);
    const wrong = [];
    for (const [name, w] of Object.entries(at[WIDE[1]].blocks)) {
      const was = at[WIDE[0]].blocks[name];
      if (w < was - 0.5) wrong.push(`${name}: ${px(w)} against ${px(was)}`);
    }
    note(`${Object.keys(at[WIDE[1]].blocks).length} blocks compared`);
    assert.deepEqual(wrong, []);
  });

  await row(`at a ${NARROW}px window nothing is narrower than in the ${OLD_COLUMN}px column, block or prose`, note => {
    const m = at[NARROW];
    setupColumn(column, scrollbar, note);
    setupBlocks(column);
    setupProse(column);
    const wrong = [];
    for (const group of ['blocks', 'shared']) {
      for (const [name, w] of Object.entries(m[group])) {
        note(`${name}: ${px(w)} (${px(column[group][name])} in the column)`);
        if (w < column[group][name] - 0.5) wrong.push(`${name}: ${px(w)} against ${px(column[group][name])}`);
      }
    }
    for (const [name, { w }] of Object.entries(m.prose)) {
      const was = column.prose[name];
      if (!was) { wrong.push(`${name}: not in the column window`); continue; }
      if (w < was.w - 0.5) wrong.push(`${name}: ${px(w)} against ${px(was.w)}`);
    }
    const widest = Object.entries(m.prose).reduce((a, [, { w, ch }]) => Math.max(a, w / ch), 0);
    note(`widest prose ${widest.toFixed(1)}ch (column window: ${Object.values(column.prose).reduce((a, { w, ch }) => Math.max(a, w / ch), 0).toFixed(1)}ch)`);
    assert.deepEqual(wrong, []);
  });

  // An option's preview is rendered content in a card whose words hold the
  // measure: the card's cap must not take the preview narrower than the old
  // column drew it.
  for (const width of [NARROW, ...WIDE]) {
    await row(`at a ${width}px window, every option's preview image and code are at least as wide as in the ${OLD_COLUMN}px column`, note => {
      const m = at[width];
      setupColumn(column, scrollbar, note);
      setupPreviews(column);
      setupPreviews(m);
      const wrong = [];
      for (const [name, { w: was }] of Object.entries(column.previews)) {
        const now = m.previews[name];
        const line = `${name}: ${now ? px(now.w) : 'missing'} (${px(was)} in the column)`;
        note(line);
        if (!now || now.w < was - 0.5) wrong.push(line);
      }
      assert.deepEqual(wrong, []);
    });
  }

  await row('no window scrolls the board sideways', note => {
    const wrong = [];
    for (const m of [column, ...Object.values(at)]) {
      note(`${m.innerW}px window: document ${m.docW}px, content ${m.scrollW}px`);
      if (m.scrollW > m.docW) wrong.push(`${m.innerW}px window: ${m.scrollW}px of content in a ${m.docW}px document`);
    }
    assert.deepEqual(wrong, []);
  });

  await row(`a page board's stage frame fills a ${PAGE_BOARD_VIEWPORT.width}x${PAGE_BOARD_VIEWPORT.height} window exactly`, async note => {
    const page = await pageBoard();
    try {
      const m = await page.evalPage(`(function () {
        var f = document.querySelector('iframe.html-stage'), r = f.getBoundingClientRect();
        return { paged: document.body.classList.contains('page-board'), left: r.left, top: r.top, w: r.width, h: r.height,
          innerW: window.innerWidth, innerH: window.innerHeight };
      })()`);
      note(`frame ${px(m.w)} x ${px(m.h)} at (${m.left}, ${m.top}); window ${m.innerW} x ${m.innerH}`);
      assert.ok(m.paged, 'setup: one html block alone is a page board');
      assert.deepEqual([m.left, m.top, m.w, m.h], [0, 0, m.innerW, m.innerH]);
      assert.deepEqual([m.innerW, m.innerH], [PAGE_BOARD_VIEWPORT.width, PAGE_BOARD_VIEWPORT.height]);
    } finally { await page.close(); }
  });
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
