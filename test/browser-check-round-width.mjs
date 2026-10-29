// Real-browser check for how wide a board page lays out. From a 1440px window
// every card on the page (text, question, compare, stage, diagram, an
// evidence-shaped compare), the board's title and its meta line sit in one 1100px
// column centred on the window, and at 2560px the window right of it is plain
// page. Inside a card the content fills it: text runs the card's width, long open
// text in two columns (short text and a folded preview in one), a question's
// options the card's left half and never under 523px with its note and Defer row
// exactly as wide under them and its context panel the right half, that panel's
// tables at their natural width, a question carrying a stage or rendered variants
// stacked at the card's full width with its context over its options, a compare's
// two sides each half, a diagram centred in its panel, and a picture carrying a
// corner control that opens it full size. At every width a card has 13px text,
// 14px by 16px of padding, 8px corners and 8px to the next card, a 13px semibold
// title, under a 20px board title. Under 1440px the column and the halves do not
// apply: the 1280px rows hold the board to the layout it had. A page board, one html block and
// nothing else, still fills the window. All of that is
// layout, and the DOM stand-in the suite runs on has none (QUIRKS.md "The DOM
// stand-in's ceilings"): test/check-pure.mjs holds the rules on declared values
// and this file looks at real ones.
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
// window whose document is exactly 1120px wide: the column capped there once, and
// the rows that ask whether a block gained width compare against it. A second,
// evidence-shaped board (a header, a criterion's before-and-after compare, a Not
// shown card) is measured beside it. What is measured, never assumed: each
// element's getBoundingClientRect, and each prose element's `ch` read off a
// 100-zero probe set in that element's own computed font.

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
const COLUMN = 1100; // every card's width, centred, from a 1440px window up
const OPTIONS_MIN = 523; // the narrowest a question's options column gets, from 1440px up
// A round-page card's type and spacing, at every width.
const CARD = { text: 13, padY: 14, padX: 16, radius: 8, between: 8, title: 13, titleWeight: 600, boardTitle: 20 };
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

/** Long enough to overflow the fold's clip of about ten lines at the reading
 * measure several times over, so it folds, and once opened it is long text. */
const LONG_READ = Array.from({ length: 5 }, () => LONG).join('\n\n');
const SHORT_TITLE = 'A short note';
const LONG_OPEN_TITLE = 'A long read, opened';
const LONG_FOLDED_TITLE = 'A long read, left folded';
/** Two nodes: far narrower than any panel here, so where it sits in its panel shows. */
const SMALL_DIAGRAM = 'flowchart TD\n  s1["small one"] --> s2["small two"]';
/** Short cells, so the table's natural width is far under its panel's. */
const TABLE_MD = '| Step | Undone by |\n| --- | --- |\n| app deploy | a redeploy |\n| secret | a new version |';

function roundBody(origin) {
  const previewImage = `${origin}${PREVIEW_IMAGE_PATH}`;
  return {
    title: 'round width browser check',
    blocks: [
      { kind: 'markdown', text: `${LONG}\n\n- ${LONG}\n- A short item.\n\n##### ${LONG}\n\n###### ${LONG}` },
      { kind: 'markdown', title: SHORT_TITLE, text: 'Two short lines of prose.\n\nThat is all there is.' },
      { kind: 'markdown', title: LONG_OPEN_TITLE, summary: LONG, text: LONG_READ },
      { kind: 'markdown', title: LONG_FOLDED_TITLE, text: LONG_READ },
      { kind: 'html', title: 'A picture', html: mock('top') },
      { kind: 'mermaid', text: chain('Top') },
      { kind: 'mermaid', title: 'A small diagram', text: SMALL_DIAGRAM },
      {
        kind: 'compare', title: 'A compare', status: { tone: 'good', label: 'Met' },
        left: { label: 'Before, top level', block: { kind: 'html', html: mock('before') } },
        right: { label: 'After, top level', block: { kind: 'html', html: mock('after') } },
      },
      {
        // No stage anywhere in it, so its context sits in the panel beside the options.
        kind: 'question', prompt: `Beside a panel: ${LONG}`, explainer: LONG, widget: 'single',
        options: [{ label: `Option one: ${LONG}`, description: LONG }, { label: 'Option two', preview: PREVIEW_CODE }],
        context: [
          { kind: 'markdown', text: LONG },
          { kind: 'markdown', text: TABLE_MD },
          { kind: 'mermaid', text: chain('Ctx') },
          { kind: 'mermaid', text: SMALL_DIAGRAM },
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

/** The evidence page's shape: a header card, one criterion as a titled compare
 * of two screenshots with its verdict chip, summary and folded details, and the
 * Not shown card. */
const evidenceBody = () => ({
  title: 'evidence width',
  blocks: [
    { kind: 'markdown', title: 'Cited rows tint and scroll into view', text: 'client #2151, service #2691: 1 met, 3 not shown.' },
    {
      kind: 'compare', title: 'A cited spreadsheet row is tinted', status: { tone: 'good', label: 'Met' },
      summary: 'The cited cell is tinted green and already in view after the fix.',
      left: { label: 'Before', block: { kind: 'html', html: mock('ev-before') } },
      right: { label: 'After', block: { kind: 'html', html: mock('ev-after') } },
      details: 'Shot at 1440px from the branch.',
    },
    {
      kind: 'markdown', title: 'Not shown', status: { tone: 'neutral', label: '3 items' },
      text: '**AC 4, CSV row:** no reachable CSV file.\n\n**AC 7, upload copy:** no file drop.', details: 'Where the shots came from.',
    },
  ],
});

/** How a question lays out from 1440px, by its prompt's opening words: options
 * the card's left half with the note under them, or (a rendered-variant question,
 * and one carrying a stage in its context, ADR.md entry 26) stacked at the card's
 * full width, its context over its options. */
const HALF_QUESTIONS = ['Beside a panel', 'Pick by its preview', 'In your words', 'In order'];
const STACKED_QUESTIONS = ['Over a stage', 'Between mocks', 'Between drawings'];

// Read in any board page: where each top-level card sits against the column and
// the header, what lies right of the cards, and inside them the questions' columns,
// the compares' sides, the diagrams' placement, the context tables' widths and how
// many columns each titled text runs in. Shared by both boards, so it asks only for
// what it finds.
const LAYOUT_FN = `function (chOf) {
  function box(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width };
  }
  function inner(el) {
    var cs = getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }
  function titleOf(el) {
    var t = el.querySelector(':scope > .card-head > .card-title');
    return t ? t.textContent.trim() : null;
  }
  var shell = document.querySelector('.board-shell'), shellCs = getComputedStyle(shell);
  var shellBox = shell.getBoundingClientRect();
  var column = { left: shellBox.left + parseFloat(shellCs.paddingLeft), w: inner(shell) };
  var cards = [].slice.call(document.querySelectorAll('.round-current > .block')).map(function (b, i) {
    var name = b.getAttribute('data-block-kind') + ' #' + (i + 1) + (titleOf(b) ? ' "' + titleOf(b).slice(0, 30) + '"' : '');
    var cs = getComputedStyle(b), title = b.querySelector(':scope > .card-head > .card-title, :scope > .question-head > .card-head > .card-title');
    var tcs = title && getComputedStyle(title);
    return { name: name, box: box(b), inner: inner(b),
      look: { text: parseFloat(cs.fontSize), padT: parseFloat(cs.paddingTop), padB: parseFloat(cs.paddingBottom),
        padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), radius: parseFloat(cs.borderTopLeftRadius),
        title: tcs ? parseFloat(tcs.fontSize) : null, titleWeight: tcs ? Number(tcs.fontWeight) : null } };
  });
  // Every paragraph a top-level text card sets straight in one column, with its card's inside.
  var paragraphs = [].slice.call(document.querySelectorAll('.round-current > .markdown-block > .md-content:not(.card-summary) > p'))
    .filter(function (p) { return getComputedStyle(p.parentElement).columnCount === 'auto'; })
    .map(function (p) { return { w: p.getBoundingClientRect().width, card: inner(p.closest('.block')) }; });
  var h1 = document.querySelector('.board-head h1');
  // Every box in the cards' column, the send bar included, to find the rightmost.
  var reach = 0;
  [].slice.call(document.querySelectorAll('.blocks, .blocks *, .send-bar, .send-bar *')).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width && r.height && r.right > reach) reach = r.right;
  });
  // What a reader would hit right of the cards, at each card's middle on screen.
  var beyond = [];
  var cardsRight = cards.reduce(function (a, c) { return Math.max(a, c.box.right); }, 0);
  cards.forEach(function (c) {
    var y = (Math.max(c.box.top, 0) + Math.min(c.box.bottom, innerHeight)) / 2;
    if (y <= 0 || y >= innerHeight || c.box.bottom <= 0 || c.box.top >= innerHeight) return;
    [cardsRight + 40, innerWidth - 40].forEach(function (x) {
      if (x <= cardsRight) return;
      var hit = document.elementFromPoint(x, y);
      beyond.push({ at: Math.round(x) + ',' + Math.round(y), hit: hit ? (hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ').join('.') : '')) : 'nothing' });
    });
  });
  var questions = [].slice.call(document.querySelectorAll('.round-current > .question-block')).map(function (q) {
    var main = q.querySelector(':scope > .question-main');
    var note = q.querySelector(':scope > .note-field');
    var table = q.querySelector(':scope > .question-context .md-content table');
    var natural = null;
    if (table) {
      var was = table.style.width;
      table.style.width = 'max-content';
      natural = table.getBoundingClientRect().width;
      table.style.width = was;
    }
    return {
      prompt: q.querySelector('.question-prompt').textContent,
      inner: inner(q), left: q.getBoundingClientRect().left + q.clientLeft + parseFloat(getComputedStyle(q).paddingLeft),
      gap: parseFloat(getComputedStyle(q).columnGap),
      options: box(main.lastElementChild), context: box(q.querySelector(':scope > .question-context')),
      prose: box(main.querySelector(':scope > .question-context-prose')),
      note: box(note), defer: box(note.querySelector('.note-head')),
      textarea: box(note.querySelector('textarea')),
      table: table ? { w: table.getBoundingClientRect().width, natural: natural } : null,
    };
  });
  var compares = [].slice.call(document.querySelectorAll('.round-current .compare-grid')).map(function (g) {
    var sides = [].slice.call(g.children);
    return { label: g.querySelector('.compare-label').textContent, w: g.getBoundingClientRect().width,
      gap: parseFloat(getComputedStyle(g).columnGap), sides: sides.map(function (s) { return s.getBoundingClientRect().width; }) };
  });
  var diagrams = [].slice.call(document.querySelectorAll('.round-current pre.mermaid')).filter(function (p) {
    return p.textContent.indexOf('small one') !== -1;
  }).map(function (p) {
    return { where: p.closest('.question-context') ? "in a question's context" : 'top level', panel: box(p), drawing: box(p.querySelector('svg')) };
  });
  // Where the lines of the elements under 'selector' start, and how many lines there are.
  function linesUnder(b, selector) {
    var lefts = [], lines = 0;
    [].slice.call(b.querySelectorAll(selector)).forEach(function (el) {
      var range = document.createRange();
      range.selectNodeContents(el);
      lines += new Set([].slice.call(range.getClientRects()).filter(function (r) { return r.width; })
        .map(function (r) { return Math.round(r.left) + ',' + Math.round(r.top); })).size;
      el.getClientRects && [].slice.call(el.getClientRects()).forEach(function (r) {
        var l = Math.round(r.left);
        if (r.width && lefts.indexOf(l) === -1) lefts.push(l);
      });
    });
    lefts.sort(function (a, z) { return a - z; });
    return { lefts: lefts, lines: lines };
  }
  var texts = [].slice.call(document.querySelectorAll('.round-current > .markdown-block')).filter(titleOf).map(function (b) {
    // The card's summary is a '.md-content' too, so the body is the other one.
    var body = b.querySelector(':scope > .md-content:not(.card-summary)');
    var summary = b.querySelector(':scope > .card-summary') ? linesUnder(b, ':scope > .card-summary > *') : null;
    return { title: titleOf(b), folded: b.classList.contains('folded'),
      lefts: linesUnder(b, ':scope > .md-content:not(.card-summary) > *').lefts, summary: summary,
      w: body.clientWidth, card: inner(b), gap: parseFloat(getComputedStyle(body).columnGap) || 0 };
  });
  var pullOuts = [].slice.call(document.querySelectorAll('.round-current > .html-block > .stage-wrap')).map(function (w) {
    return { wrap: box(w), control: box(w.querySelector(':scope > .pull-out')) };
  });
  return { column: column, head: box(document.querySelector('.board-head')),
    title: box(h1), meta: box(document.querySelector('.board-head .meta')),
    boardTitle: parseFloat(getComputedStyle(h1).fontSize), paragraphs: paragraphs,
    label: box(document.querySelector('.round-current > .round-label')), cards: cards, reach: reach, beyond: beyond,
    questions: questions, compares: compares, diagrams: diagrams, texts: texts, pullOuts: pullOuts };
}`;

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
      // Its widest box: a paragraph running on into a text's second column is
      // two boxes, each one column wide, and its bounding box spans both.
      var w = [].slice.call(el.getClientRects()).reduce(function (a, r) { return Math.max(a, r.width); }, 0);
      if (!w) return; // hidden: a closed form, a collapsed card
      prose[kind[0] + ' #' + (i + 1)] = { w: w, ch: chOf(el) };
    });
  });
  var previews = {};
  [].slice.call(document.querySelectorAll('.round-current .opt-preview')).forEach(function (p) {
    var option = p.closest('.card-choice').getAttribute('data-choice').split(':')[0];
    var image = p.tagName === 'IMG';
    var card = p.closest('.card-choice'), cardCs = getComputedStyle(card);
    previews[(image ? 'preview image' : 'preview code') + ' of option "' + option + '"'] =
      { w: w(p), loaded: !image || (p.complete && p.naturalWidth > 0),
        room: card.clientWidth - parseFloat(cardCs.paddingLeft) - parseFloat(cardCs.paddingRight) };
  });
  var root = document.documentElement;
  return { blocks: blocks, shared: shared, prose: prose, previews: previews, docW: root.clientWidth,
    scrollW: root.scrollWidth, innerW: window.innerWidth, layout: (${LAYOUT_FN})(chOf) };
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
  // Open the one long text the rows read as opened; every other fold stays shut.
  await evalPage(`[].slice.call(document.querySelectorAll('.round-current > .markdown-block.folded')).forEach(function (b) {
    var t = b.querySelector(':scope > .card-head > .card-title');
    var btn = b.querySelector(':scope > .fold-toggle');
    if (t && btn && t.textContent.trim() === ${JSON.stringify(LONG_OPEN_TITLE)}) btn.click();
  })`);
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
    const evidenceUrl = await boardUrl(evidenceBody());

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
      const evidence = {};
      for (const width of [NARROW, ...WIDE]) {
        evidence[width] = await measureAt(viewport => openAt(send, onEvent, evidenceUrl, cookie, viewport), { width, height: HEIGHT });
      }
      await runRows({
        column, at, evidence, scrollbar,
        pageBoard: () => openAt(send, onEvent, pageUrl, cookie, PAGE_BOARD_VIEWPORT),
        round: viewport => openRound(viewport),
      });
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

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const isCapped = width => width >= 1440;

async function runRows({ column, at, evidence, scrollbar, pageBoard, round }) {
  // --- one card width -------------------------------------------------------
  for (const [board, byWidth] of [['the round board', at], ['the evidence board', evidence]]) {
    await row(`at a ${NARROW}px window, every card on ${board} is one width, the column's, uncapped, its left edge on the header's`, note => {
      const l = byWidth[NARROW].layout;
      assert.ok(l.cards.length >= 3 && l.head && l.label, `setup: the header, the round label and the cards found on ${board}`);
      const expect = l.column.w;
      note(`column ${px(l.column.w)} from x=${l.column.left}; header from x=${l.head.left}; round label from x=${l.label.left}; ${l.cards.length} cards, ${px(expect)} each expected`);
      const wrong = [];
      if (!near(l.head.left, l.column.left)) wrong.push(`header from x=${l.head.left}`);
      if (!near(l.label.left, l.column.left)) wrong.push(`round label from x=${l.label.left}`);
      for (const c of l.cards) {
        if (!near(c.box.w, expect) || !near(c.box.left, l.column.left)) wrong.push(`${c.name}: ${px(c.box.w)} from x=${c.box.left}`);
      }
      assert.deepEqual(wrong, []);
    });
    for (const width of WIDE) {
      await row(`at a ${width}px window, every card on ${board}, the board's title and its meta line are ${COLUMN}px wide with equal space left and right`, note => {
        const m = byWidth[width], l = m.layout;
        assert.ok(l.cards.length >= 3 && l.title && l.meta && l.label, `setup: the title, the meta line, the round label and the cards found on ${board}`);
        const wrong = [];
        const centred = (name, b) => {
          const left = b.left, right = m.docW - b.right;
          note(`${name}: ${px(b.w)}, ${px(left)} left and ${px(right)} right`);
          if (!near(b.w, COLUMN, 1) || !near(left, right, 1)) wrong.push(`${name}: ${px(b.w)}, ${left} left and ${right} right`);
        };
        centred('board title', l.title);
        centred('meta line', l.meta);
        for (const c of l.cards) centred(c.name, c.box);
        if (!near(l.label.left, l.cards[0].box.left)) wrong.push(`round label from x=${l.label.left}, the cards from x=${l.cards[0].box.left}`);
        assert.deepEqual(wrong, []);
      });
    }
  }

  // --- a card's type and spacing ----------------------------------------------
  for (const width of [NARROW, ...WIDE]) {
    await row(`at a ${width}px window, every card has ${CARD.text}px text, ${CARD.padY}px by ${CARD.padX}px of padding, ${CARD.radius}px corners and ${CARD.between}px to the next, a ${CARD.title}px semibold title, under a ${CARD.boardTitle}px board title`, note => {
      const wrong = [];
      for (const [board, m] of [['round board', at[width]], ['evidence board', evidence[width]]]) {
        const l = m.layout;
        note(`${board}: board title ${l.boardTitle}px; first card ${JSON.stringify(l.cards[0].look)}`);
        if (l.boardTitle !== CARD.boardTitle) wrong.push(`${board}: board title ${l.boardTitle}px`);
        l.cards.forEach((c, i) => {
          const k = c.look;
          const got = [k.text, k.padT, k.padB, k.padL, k.padR, k.radius];
          if (JSON.stringify(got) !== JSON.stringify([CARD.text, CARD.padY, CARD.padY, CARD.padX, CARD.padX, CARD.radius])) wrong.push(`${board} ${c.name}: text, padding and corner ${got.join(', ')}`);
          if (k.title !== null && (k.title !== CARD.title || k.titleWeight !== CARD.titleWeight)) wrong.push(`${board} ${c.name}: title ${k.title}px at ${k.titleWeight}`);
          const next = l.cards[i + 1];
          if (next && !near(next.box.top - c.box.bottom, CARD.between)) wrong.push(`${board} ${c.name}: ${Math.round(next.box.top - c.box.bottom)}px to the next card`);
        });
        assert.ok(l.cards.filter(c => c.look.title !== null).length >= 3, `setup: titled cards found on the ${board}`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  await row(`at a ${WIDE[1]}px window, the window right of the cards is plain page, on both boards`, note => {
    const wrong = [];
    for (const [board, m] of [['round board', at[WIDE[1]]], ['evidence board', evidence[WIDE[1]]]]) {
      const l = m.layout;
      const right = Math.max(...l.cards.map(c => c.box.right));
      assert.ok(right < m.docW - 200 && l.beyond.length > 0, `setup: the ${board}'s cards stop short of the window, and a point right of them was probed`);
      note(`${board}: cards end at x=${right}, nothing in the column or the send bar reaches past x=${l.reach}; ${l.beyond.length} points probed right of them`);
      if (l.reach > right + 0.5) wrong.push(`${board}: something reaches x=${l.reach}`);
      for (const b of l.beyond) if (!/^(html|body|div\.board-shell)$/.test(b.hit)) wrong.push(`${board}: ${b.hit} at ${b.at}`);
    }
    assert.deepEqual(wrong, []);
  });

  // --- inside a card --------------------------------------------------------
  const question = (m, name) => {
    const q = m.layout.questions.find(x => x.prompt.startsWith(name));
    assert.ok(q && q.options && q.note && q.defer, `setup: question "${name}" with its options, note and Defer row found at a ${m.innerW}px window`);
    return q;
  };
  for (const width of WIDE) {
    const m = at[width];
    await row(`at a ${width}px window, a question's options take the card's left half and never under ${OPTIONS_MIN}px, its note field and Defer row exactly as wide right under them, its context the right half`, note => {
      const wrong = [];
      for (const name of HALF_QUESTIONS) {
        const q = question(m, name);
        const half = Math.max(OPTIONS_MIN, (q.inner - q.gap) / 2);
        note(`${name}: ${px(q.inner)} inside the card; options ${px(q.options.w)} from x=${q.options.left} (half: ${px(half)} from x=${q.left}); note ${px(q.note.w)}, Defer row ${px(q.defer.w)}, box ${px(q.textarea.w)}; context ${q.context ? px(q.context.w) : 'none'}`);
        if (q.options.w < OPTIONS_MIN - 0.5 || !near(q.options.w, half, 1) || !near(q.options.left, q.left, 1)) wrong.push(`${name}: options ${px(q.options.w)} from x=${q.options.left}, the left half is ${px(half)} from x=${q.left}`);
        for (const [part, b] of [['note field', q.note], ['Defer row', q.defer], ['note box', q.textarea]]) {
          if (!near(b.w, q.options.w) || !near(b.left, q.options.left)) wrong.push(`${name}: ${part} ${px(b.w)} from x=${b.left}, options ${px(q.options.w)} from x=${q.options.left}`);
        }
        const under = q.note.top - q.options.bottom;
        if (under < 0 || under > 40) wrong.push(`${name}: the note starts ${Math.round(under)}px under its options`);
        if (q.context && (!near(q.context.w, q.inner - q.gap - q.options.w, 1) || !near(q.context.left, q.options.right + q.gap, 1))) {
          wrong.push(`${name}: context ${px(q.context.w)} from x=${q.context.left}, the rest is ${px(q.inner - q.gap - q.options.w)} from x=${q.options.right + q.gap}`);
        }
      }
      assert.ok(question(m, HALF_QUESTIONS[0]).context, `setup: "${HALF_QUESTIONS[0]}" has its context panel`);
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, a question whose options are rendered variants, or whose context holds a stage, stacks its context over its options at the card's full width, its note too`, note => {
      const wrong = [];
      for (const name of STACKED_QUESTIONS) {
        const q = question(m, name);
        note(`${name}: ${px(q.inner)} inside the card; options ${px(q.options.w)}, note ${px(q.note.w)}${q.prose ? `, context ${px(q.prose.w)} ending at y=${Math.round(q.prose.bottom)}, options from y=${Math.round(q.options.top)}` : ''}`);
        for (const [part, b] of [['options', q.options], ['note', q.note], ...(q.prose ? [['context', q.prose]] : [])]) {
          if (!near(b.w, q.inner, 1) || !near(b.left, q.left, 1)) wrong.push(`${name}: ${part} ${px(b.w)} from x=${b.left}, the card's inside ${px(q.inner)} from x=${q.left}`);
        }
        if (q.prose && q.prose.bottom > q.options.top + 0.5) wrong.push(`${name}: its context ends at y=${q.prose.bottom}, under its options' top y=${q.options.top}`);
      }
      assert.ok(question(m, STACKED_QUESTIONS[0]).prose, `setup: "${STACKED_QUESTIONS[0]}" carries its context over its options`);
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, a table in a question's context panel is at its natural width`, note => {
      const q = question(m, HALF_QUESTIONS[0]);
      assert.ok(q.table && q.context && q.table.natural < q.context.w - 200, 'setup: a context table whose natural width is well under its panel');
      note(`table ${px(q.table.w)}, natural ${px(q.table.natural)}, panel ${px(q.context.w)}`);
      assert.ok(near(q.table.w, q.table.natural, 1), `table ${px(q.table.w)} against its natural ${px(q.table.natural)}`);
    });

    await row(`at a ${width}px window, a compare's or an evidence card's before and after are each half the card`, note => {
      const wrong = [];
      const all = [...m.layout.compares, ...evidence[width].layout.compares];
      assert.ok(all.length >= 3, 'setup: the compares found');
      for (const c of all) {
        const half = (c.w - c.gap) / 2;
        note(`"${c.label}": ${c.sides.map(px).join(' and ')} in ${px(c.w)}`);
        if (c.sides.length !== 2 || c.sides.some(w => !near(w, half))) wrong.push(`"${c.label}": ${c.sides.map(px).join(', ')}, half is ${px(half)}`);
      }
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, a diagram narrower than its panel is centred in it`, note => {
      const wrong = [];
      const ds = m.layout.diagrams;
      assert.deepEqual(ds.map(d => d.where).sort(), ["in a question's context", 'top level'], 'setup: the small diagram found at top level and in a context');
      for (const d of ds) {
        assert.ok(d.drawing && d.drawing.w < d.panel.w - 200, `setup: the ${d.where} drawing is well under its panel`);
        const off = (d.drawing.left + d.drawing.right) / 2 - (d.panel.left + d.panel.right) / 2;
        note(`${d.where}: drawing ${px(d.drawing.w)} in ${px(d.panel.w)}, centre off by ${off.toFixed(1)}px`);
        if (Math.abs(off) > 1) wrong.push(`${d.where}: centre off by ${off.toFixed(1)}px`);
      }
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, an opened long text flows into two columns, each half its card; its summary, a short text and a folded preview stay one column`, note => {
      const texts = Object.fromEntries(m.layout.texts.map(t => [t.title, t]));
      const open = texts[LONG_OPEN_TITLE], folded = texts[LONG_FOLDED_TITLE], short = texts[SHORT_TITLE];
      assert.ok(open && folded && short, 'setup: the three titled texts found');
      assert.ok(!open.folded && folded.folded, 'setup: the long read is opened, its twin still folded');
      for (const t of [open, folded, short]) note(`"${t.title}": lines start at x=${t.lefts.join(', ')}`);
      const step = (open.w - open.gap) / 2 + open.gap;
      note(`"${open.title}": body ${px(open.w)} in a card ${px(open.card)} inside`);
      assert.ok(near(open.w, open.card, 1), `the opened text's body ${px(open.w)} runs its card's ${px(open.card)}`);
      assert.equal(open.lefts.length, 2, 'the opened long text runs in two columns');
      assert.ok(near(open.lefts[1] - open.lefts[0], step, 1), `its second column starts ${open.lefts[1] - open.lefts[0]}px after the first, half the body and a gap is ${px(step)}`);
      assert.equal(folded.lefts.length, 1, 'the folded preview stays one column');
      assert.equal(short.lefts.length, 1, 'the short text stays one column');
      note(`"${open.title}" summary: ${open.summary && open.summary.lines} lines starting at x=${open.summary && open.summary.lefts.join(', ')}`);
      assert.ok(open.summary && open.summary.lines >= 2, 'setup: the opened text carries a summary of several lines');
      assert.deepEqual(open.summary.lefts, [open.lefts[0]], 'its summary stays one column, on the body\'s first');
    });
  }

  await row(`at a ${WIDE[1]}px window, a picture carries a control in its corner that opens it full size`, async note => {
    const l = at[WIDE[1]].layout;
    assert.ok(l.pullOuts.length >= 1, 'setup: a top-level picture found');
    const wrong = [];
    for (const { wrap, control } of l.pullOuts) {
      if (!control) { wrong.push('a picture has no corner control'); continue; }
      const fromRight = wrap.right - control.right, fromTop = control.top - wrap.top;
      note(`control ${Math.round(fromRight)}px from the picture's right edge, ${Math.round(fromTop)}px from its top`);
      if (fromRight < 0 || fromRight > 24 || fromTop < 0 || fromTop > 24) wrong.push(`control ${Math.round(fromRight)}px from the right, ${Math.round(fromTop)}px from the top`);
    }
    const page = await round({ width: WIDE[1], height: HEIGHT });
    try {
      await page.evalPage(`document.querySelector('.round-current > .html-block > .stage-wrap > .pull-out').click()`);
      let lens = null;
      const deadline = Date.now() + 5000;
      while (!lens && Date.now() < deadline) {
        lens = await page.evalPage(`(function () {
          var f = document.querySelector('.stage-lens[open] .stage-lens-frame');
          if (!f) return null;
          var r = f.getBoundingClientRect(), s = document.querySelector('.round-current > .html-block .html-stage').getBoundingClientRect();
          return { w: r.width, h: r.height, stageW: s.width, innerW: innerWidth, innerH: innerHeight };
        })()`);
        if (!lens) await sleep(100);
      }
      assert.ok(lens, 'pressing the control opens the lens');
      note(`lens frame ${px(lens.w)} x ${px(lens.h)} in a ${lens.innerW} x ${lens.innerH} window; the picture on the card ${px(lens.stageW)}`);
      if (!(lens.w > lens.stageW && lens.w >= lens.innerW - 64 && lens.h >= lens.innerH - 160)) wrong.push(`lens frame ${px(lens.w)} x ${px(lens.h)}`);
    } finally { await page.close(); }
    assert.deepEqual(wrong, []);
  });

  // --- the rendered blocks and the prose --------------------------------------
  for (const width of WIDE) {
    const m = at[width];
    await row(`at a ${width}px window, no rendered block in the round is narrower than in the ${OLD_COLUMN}px column`, note => {
      setupColumn(column, scrollbar, note);
      setupBlocks(column);
      setupBlocks(m);
      const wrong = [];
      for (const group of ['blocks', 'shared']) {
        for (const [name, w] of Object.entries(m[group])) {
          const was = column[group][name];
          const line = `${name}: ${px(w)} (${px(was)} in the column)`;
          note(line);
          if (w < was - 0.5) wrong.push(line);
        }
      }
      assert.deepEqual(wrong, []);
    });

    await row(`at a ${width}px window, a text card's paragraphs run the card's width`, note => {
      const ps = m.layout.paragraphs;
      assert.ok(ps.length >= 3, 'setup: the text cards\' paragraphs found');
      const wrong = [];
      for (const [i, p] of ps.entries()) if (!near(p.w, p.card, 1)) wrong.push(`paragraph #${i + 1}: ${px(p.w)} in a card ${px(p.card)} inside`);
      note(`${ps.length} paragraphs; widest ${px(Math.max(...ps.map(p => p.w)))}, in cards ${px(ps[0].card)} inside`);
      assert.deepEqual(wrong, []);
    });
  }

  await row(`every rendered block is as wide at a ${WIDE[1]}px window as at ${WIDE[0]}px: both are in the ${COLUMN}px column`, note => {
    setupBlocks(at[WIDE[0]]);
    setupBlocks(at[WIDE[1]]);
    const wrong = [];
    for (const group of ['blocks', 'shared']) {
      for (const [name, w] of Object.entries(at[WIDE[1]][group])) {
        const was = at[WIDE[0]][group][name];
        if (!near(w, was)) wrong.push(`${name}: ${px(w)} against ${px(was)}`);
      }
    }
    note(`${Object.keys(at[WIDE[1]].blocks).length + Object.keys(at[WIDE[1]].shared).length} blocks compared`);
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

  await row(`at a ${NARROW}px window the wide layout is not in force: a question's note spans its row past its options, and an opened long text stays one column`, note => {
    const q = question(at[NARROW], HALF_QUESTIONS[0]);
    const open = at[NARROW].layout.texts.find(t => t.title === LONG_OPEN_TITLE);
    assert.ok(open && !open.folded, 'setup: the long read is opened');
    note(`${HALF_QUESTIONS[0]}: options ${px(q.options.w)}, note ${px(q.note.w)}; the opened long text's lines start at x=${open.lefts.join(', ')}`);
    assert.ok(q.note.w > q.options.w + 100, `the note ${px(q.note.w)} runs past its options' ${px(q.options.w)}`);
    assert.equal(open.lefts.length, 1);
  });

  // An option's preview is rendered content in a card whose words hold the
  // measure. Below 1440px the card's cap must not take the preview narrower
  // than the old column drew it; from 1440px an option is half its card, and
  // its preview fills it where that is narrower than the column drew it.
  for (const width of [NARROW, ...WIDE]) {
    const rule = isCapped(width) ? `as wide as the ${OLD_COLUMN}px column drew them, or the whole of their option` : `at least as wide as in the ${OLD_COLUMN}px column`;
    await row(`at a ${width}px window, every option's preview image and code are ${rule}`, note => {
      const m = at[width];
      setupColumn(column, scrollbar, note);
      setupPreviews(column);
      setupPreviews(m);
      const wrong = [];
      for (const [name, { w: was }] of Object.entries(column.previews)) {
        const now = m.previews[name];
        const floor = now && isCapped(width) ? Math.min(was, now.room) : was;
        const line = `${name}: ${now ? px(now.w) : 'missing'} (${px(was)} in the column${now && isCapped(width) ? `, ${px(now.room)} inside its option` : ''})`;
        note(line);
        if (!now || now.w < floor - 0.5) wrong.push(line);
      }
      assert.deepEqual(wrong, []);
    });
  }

  await row('no window scrolls a board sideways', note => {
    const wrong = [];
    for (const m of [column, ...Object.values(at), ...Object.values(evidence)]) {
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
