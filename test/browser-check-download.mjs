// Real-browser check for Download round (src/round-export.mjs, src/ui.mjs's
// downloadRound): a question round offers it at the right end of its chip line, sent or
// not; the file a sent round saves opens from disk with the network off and holds the
// board's title, the round's number and date, the decisions table first, every option
// with the pick marked, the diagram as SVG at full height, the mock at its full height
// with none of its scripts run, each comment under what it points at and every image as
// a data: URL, with no script anywhere in it; and under print media every card, diagram,
// stage and decisions row is kept whole and fits one page, a mock no taller than a page
// at its own size and a taller one scaled into its holder. A round not yet sent saves a
// file that opens on a Not sent line and marks each pick so far as unsent. Pull-out's
// Download saves the one mock or diagram it shows, alone, as a file that opens offline.
// A second board holds what is
// taller than a printed page: a sent artifact round (drawn full page, its Download round
// in the top strip, its file listing every comment under the mock), a long text,
// a diagram, a question with many options, a long free-text answer under a long note and
// a long comment list; its files are
// paginated under print media and nothing that must stay whole sits across a page's edge.
// The top strip's Download round is read over a scrolled artifact, where it stays drawn
// and takes its click, in a window too narrow for the header to condense, on a third
// board whose one artifact round was never sent, and in the board's
// archive opened from disk, which shows none. Layout, a real download and a file: page, none of which the DOM
// stand-in has (test/check-round-download.mjs holds the markup).
//
// The fixture's images: one pasted on a note and one on a comment, sent with the round
// and served beside the board (src/images.mjs), and an option's preview off another
// host, which the page does not load and the file names in its place.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-download.mjs
//
// Without Chrome it prints a skip line and exits 0. CLAUDE_BOARD_DOWNLOAD_KEEP=<dir>
// copies the saved files there.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile, withTimeout } from './support.mjs';
import { CHROME, copyArchive, evalIn, guardRun, measureTab, openTab, postJson, row, scratchDir, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-download', `browser-check-download: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-download', { deadlineMs: 180000 });

const TITLE = 'Download fixture';
const STAGE_PX = 760; // past the board's 600px stage cap, so the page folds it and the file must not
const PRINT_W = 739; // Letter less Chrome's default 0.4in margins, at 96px an inch
const PRINT_H = 979;
const A4_W = 717; // A4 less the same margins: the narrower paper, where a mock fitted to anything wider loses its right edge
const FIT_H = 960; // the one page a mock taller than it is fitted to: Letter's height less a little
const WIDE_STAGE_PX = 1100; // taller than a page and, at the board's width, wider than a page in proportion: its width is what limits it
// Round 1's send time, set in the store: midday UTC is the same date in every zone the
// checks run in.
const SENT_AT = '2026-03-04T12:00:00.000Z';

// One line far wider than a printed page, among enough to pass the board's 480px code box.
const LONG_LINE = 'const settled = rounds.filter(r => r.status === "sent").map(r => r.n); '.repeat(4).trim();
const CODE_TEXT = Array.from({ length: 30 }, (_, i) => (i === 3 ? LONG_LINE : `const step${i} = ${i};`)).join('\n');
const ROUND_1 = [
  { id: 'd1', kind: 'markdown', text: '# Scope\n\nWhat this round settles.' },
  { id: 'm1', kind: 'mermaid', text: 'flowchart TD\n  ask[Ask] --> pick[Pick]\n  pick --> build[Build]\n  build --> ship[Ship]' },
  { id: 'h1', kind: 'html', title: 'Mock',
    html: `<div style="height:${STAGE_PX}px;box-sizing:border-box;border:4px solid #3251c9;background:#eef">Static mock</div><div id="late"></div><script>document.getElementById('late').textContent = 'ran';</script>` },
  { id: 'h3', kind: 'html', title: 'Wide mock',
    html: `<div style="height:${WIDE_STAGE_PX}px;box-sizing:border-box;border:4px solid #3251c9;background:#efe">Wide mock</div>` },
  { id: 'c1', kind: 'code', lang: 'js', text: CODE_TEXT },
  { id: 'd3', kind: 'markdown', text: '```\n' + LONG_LINE + '\n```\n\n| Part | State |\n| --- | --- |\n| Export | sent |\n| Print | open |' },
  { id: 'q1', kind: 'question', prompt: 'Which way?', widget: 'single',
    options: [{ label: 'Yes', description: 'go now' }, { label: 'No', description: 'not yet' }, { label: 'Later' }] },
  { id: 'q2', kind: 'question', prompt: 'Which parts?', widget: 'multi',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C', preview: 'http://images.invalid/elsewhere.png' }] },
  { id: 'q3', kind: 'question', prompt: 'Say why', widget: 'text' },
  { id: 'q4', kind: 'question', prompt: 'Order them', widget: 'rank', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] },
  { id: 'q5', kind: 'question', prompt: 'Park this?', widget: 'single', options: [{ label: 'Park' }, { label: 'Keep' }] },
];
// The second board: everything here is taller than a printed page.
const TALL_TITLE = 'Tall fixture';
const TALL_MOCK_PX = 2400;
const TALL_ROUND_1 = [
  { id: 'h2', kind: 'html', html: `<div style="height:${TALL_MOCK_PX}px;box-sizing:border-box;border:4px solid #3251c9;background:linear-gradient(#eef,#fee)">Tall mock</div>` },
];
// More than the board's comment rail shows at once: it scrolls past three.
const TALL_PAGE_COMMENTS = Array.from({ length: 5 }, (_, i) => ({ blockId: 'h2', anchor: { kind: 'block' }, text: `Mock comment ${i}` }));
// Its text items run several printed lines each and differ in length, so a page's edge
// falls inside one of every kind and only that kind's own print rule keeps it whole (the
// row checks that one did, contestedKinds below): two lines must stay either side of a
// break, so nothing under four lines can be split whatever the rules say.
const SENTENCE = 'A sentence that runs on so that its item takes several printed lines. ';
const TALL_ROUND_2 = [
  { id: 'd2', kind: 'markdown', text: [
    ...Array.from({ length: 8 }, (_, i) => `Paragraph ${i}: ${SENTENCE.repeat(16 + (i * 5) % 9)}`.trim()),
    Array.from({ length: 8 }, (_, i) => `- List item ${i}: ${SENTENCE.repeat(12 + (i * 3) % 7)}`.trim()).join('\n'),
  ].join('\n\n') },
  { id: 'm2', kind: 'mermaid', text: 'flowchart TD\n' + Array.from({ length: 24 }, (_, i) => `  n${i}[Step ${i}] --> n${i + 1}[Step ${i + 1}]`).join('\n') },
  { id: 'q7', kind: 'question', prompt: 'Which of the many?', widget: 'single',
    // An option's label and description are one box no page can part, so each carries a
    // snippet under them, which one can.
    options: Array.from({ length: 14 }, (_, i) => ({ label: `Option ${i}`, description: SENTENCE.repeat(2 + i % 3).trim(),
      preview: Array.from({ length: 6 + (i * 3) % 5 }, (_, k) => `option${i}.step(${k});`).join('\n') })) },
  { id: 'q9', kind: 'question', prompt: 'Why this one?', widget: 'text',
    explainer: Array.from({ length: 3 }, (_, i) => `Background ${i}: ${SENTENCE.repeat(6 + i)}`.trim()).join('\n\n') },
];
const TALL_COMMENTS = Array.from({ length: 14 }, (_, i) => ({ blockId: 'm2', anchor: { kind: 'block' },
  text: `Comment ${i} on the diagram. ${SENTENCE.repeat(6 + (i * 2) % 5)}`.trim() }));
// A second artifact: its body is pinned to the window's height and its content spills
// out of it, so the room the board pads the body by is not all in the height it has.
const PINNED_PX = 3000;
const TALL_ROUND_3 = [
  { id: 'h4', kind: 'html', html: `<style>html, body { height: 100%; margin: 0; }</style><div style="height:${PINNED_PX}px;box-sizing:border-box;border:4px solid #3251c9;background:linear-gradient(#efe,#eef)">Pinned body, spilling content</div>` },
];
// The third board: one artifact, shown and never sent, since it asks nothing.
const SHOWN_TITLE = 'Shown fixture';
const SHOWN_ROUND_1 = [
  { id: 'h5', kind: 'html', html: '<div style="height:1800px;box-sizing:border-box;border:4px solid #3251c9;background:linear-gradient(#eef,#efe)">Shown mock</div>' },
];
// The first board's open round: one question picked on the page and one left alone.
const OPEN_ROUND = [
  { id: 'q6', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }, { label: 'Wait' }] },
  { id: 'q10', kind: 'question', prompt: 'And then?', widget: 'single', options: [{ label: 'Stop' }, { label: 'On' }] },
];
// A free-text answer and a note, each most of a page: under the question's explainer the
// answer does not fit the first page, nor the note the page the answer moves to.
const TALL_ANSWER = Array.from({ length: 40 }, (_, i) => `Reason ${i}, on a line of its own.`).join('\n');
const TALL_NOTE = Array.from({ length: 40 }, (_, i) => `Caveat ${i}, on a line of its own.`).join('\n');

// A 3x2 red PNG, pasted twice.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAxMAAAA8kAgFzQfa2AAAAAElFTkSuQmCC';
const ANSWERS = [
  { id: 'q1', status: 'answered', choice: 'No', note: 'Hold for review', images: [PNG] },
  { id: 'q2', status: 'answered', choice: ['A', 'C'], note: '' },
  { id: 'q3', status: 'answered', choice: 'Free text answer', note: '' },
  { id: 'q4', status: 'answered', choice: ['Z', 'X', 'Y'], note: '' },
  { id: 'q5', status: 'deferred', choice: null, note: '' },
];
const COMMENTS = [
  { blockId: 'm1', anchor: { kind: 'block' }, text: 'Diagram comment' },
  { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'pick' }, text: 'Pick node comment' },
  { blockId: 'h1', anchor: { kind: 'block' }, text: 'Mock comment', images: [PNG] },
];


const EXPORT_EXPR = `(function () {
  function texts(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)).map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); }); }
  function block(id) { return document.querySelector('[data-block-id="' + id + '"]'); }
  // Each comment listed in the card, as the text after its '#n · target' tag.
  function comments(id) {
    return [].slice.call(block(id).querySelectorAll('.comment-item')).map(function (c) {
      return c.textContent.slice(c.querySelector('.comment-anchor').textContent.length).trim();
    });
  }
  function options(id) {
    return [].slice.call(block(id).querySelectorAll('.card-choice')).map(function (o) {
      return { label: o.querySelector('.opt-label').textContent.trim(), picked: o.classList.contains('selected'),
        mark: getComputedStyle(o.querySelector('.opt-label'), '::before').content };
    });
  }
  var table = document.querySelector('table.export-decisions');
  var round = document.querySelector('section.export-round');
  var pre = block('m1').querySelector('pre.mermaid');
  var svg = pre && pre.querySelector('svg');
  var frame = block('h1').querySelector('iframe');
  var imgs = [].slice.call(document.images);
  return {
    title: document.querySelector('h1').textContent,
    meta: texts('.export-meta > span'),
    sections: texts('h2.export-section'),
    decisionsFirst: !!(table && round && (table.compareDocumentPosition(round) & Node.DOCUMENT_POSITION_FOLLOWING)),
    rows: [].slice.call(document.querySelectorAll('table.export-decisions tbody tr')).map(function (tr) { return texts('td', tr); }),
    q1: options('q1'), q2: options('q2'),
    rank: texts('[data-block-id="q4"] .rank-list li .opt-label'),
    text: texts('[data-block-id="q3"] .export-text'),
    note: [].slice.call(block('q1').querySelectorAll('.export-note-box')).map(function (b) {
      return { tag: b.querySelector('.export-note-tag').textContent, text: b.lastChild.textContent };
    }),
    svg: svg ? { height: svg.getBoundingClientRect().height, fill: getComputedStyle(svg.querySelector('.node rect, .node polygon, .node path')).fill } : null,
    preClipped: pre ? pre.scrollHeight > pre.clientHeight + 1 : null,
    frame: frame ? { sandbox: frame.getAttribute('sandbox'), height: frame.getBoundingClientRect().height, srcdoc: frame.getAttribute('srcdoc') } : null,
    wideFrameHeight: block('h3').querySelector('iframe').getBoundingClientRect().height,
    diagramComments: comments('m1'),
    mockComments: comments('h1'),
    images: imgs.map(function (i) {
      return { where: i.closest('.comment-item') ? 'comment ' + i.closest('[data-block-id]').getAttribute('data-block-id')
        : i.closest('.note-field') ? 'note ' + i.closest('[data-block-id]').getAttribute('data-block-id') : 'elsewhere',
        data: /^data:image\\//.test(i.getAttribute('src') || ''), width: i.naturalWidth };
    }),
    missing: texts('.export-missing'),
    scripts: document.scripts.length,
    controls: document.querySelectorAll('button, textarea, input, form, .pin-layer, .round-download').length,
    fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return !/^data:/.test(n); }),
  };
})()`;

// The artifact round's file as opened: each comment with whether it sits below the mock
// and whether a box that clips what leaves it hides it, and what is left of the board's
// controls.
const PAGE_FILE_EXPR = `(function () {
  var frameBottom = document.querySelector('section.export-round iframe').getBoundingClientRect().bottom;
  function hidden(el) {
    var r = el.getBoundingClientRect();
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      var box = p.getBoundingClientRect();
      if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) return true;
    }
    return false;
  }
  return {
    comments: [].slice.call(document.querySelectorAll('section.export-round .comment-item')).map(function (c) {
      return { text: c.textContent.slice(c.querySelector('.comment-anchor').textContent.length).trim(),
        below: c.getBoundingClientRect().top >= frameBottom, shown: !hidden(c) };
    }),
    controls: document.querySelectorAll('button, textarea, input, form, .pin-layer, .round-download').length,
    sendBars: document.querySelectorAll('.page-send-bar').length,
  };
})()`;

// An unsent round's file as opened: what it opens on, its head, its table and each option
// of the open round with what follows its label.
const UNSENT_EXPR = `(function () {
  function texts(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)).map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); }); }
  var note = document.querySelector('main.export-doc').firstElementChild;
  return {
    first: note.className, note: note.textContent.trim(),
    noteAboveHead: note.getBoundingClientRect().height > 0 && note.getBoundingClientRect().bottom <= document.querySelector('.export-head').getBoundingClientRect().top + 0.5,
    meta: texts('.export-meta > span'), sections: texts('h2.export-section'), heads: texts('table.export-decisions th'),
    rows: [].slice.call(document.querySelectorAll('table.export-decisions tbody tr')).map(function (tr) { return texts('td', tr); }),
    options: [].slice.call(document.querySelectorAll('.card-choice')).map(function (o) {
      var label = o.querySelector('.opt-label');
      return { label: label.textContent.trim(), picked: o.classList.contains('selected'), after: getComputedStyle(label, '::after').content };
    }),
    // Each question's state chip as drawn: its word and what follows it; '' for a chip not drawn.
    chips: [].slice.call(document.querySelectorAll('.answer-status')).map(function (c) {
      return getComputedStyle(c).display === 'none' ? '' : c.textContent.trim() + getComputedStyle(c, '::after').content.replace(/"/g, '');
    }),
    hints: document.querySelectorAll('.paste-hint, .thumb-remove').length,
    scripts: document.scripts.length,
    controls: document.querySelectorAll('button, textarea, input, form, .pin-layer, .round-download').length,
    fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return !/^data:/.test(n); }),
  };
})()`;

// One artifact's file as opened: its head, the one mock or diagram it holds and whatever
// else of the round or the board came along.
const ONE_EXPR = `(function () {
  function texts(sel) { return [].slice.call(document.querySelectorAll(sel)).map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); }); }
  var frame = document.querySelector('iframe');
  var svg = document.querySelector('pre.mermaid svg');
  return {
    title: document.querySelector('h1').textContent, meta: texts('.export-meta > span'),
    frames: document.querySelectorAll('iframe').length,
    frame: frame ? { sandbox: frame.getAttribute('sandbox'), height: frame.getBoundingClientRect().height, srcdoc: frame.getAttribute('srcdoc') } : null,
    svgs: document.querySelectorAll('svg').length,
    svg: svg ? { width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, nodes: svg.querySelectorAll('.node').length } : null,
    rest: document.querySelectorAll('table, h2, .export-empty, .export-unsent-note, .question-block, .comment-item, .md-content, .card-head').length,
    scripts: document.scripts.length,
    controls: document.querySelectorAll('button, textarea, input, form, .pin-layer, .round-download').length,
    fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return !/^data:/.test(n); }),
  };
})()`;

// The top strip's Download round on a full-page round: whether it is drawn, inside the
// window, and what a click at its middle lands on, with whether the artifact has
// scrolled under the header.
const STRIP_EXPR = `(function () {
  var btn = document.querySelector('header.board-head .board-head-actions .head-download');
  if (!btn) return { present: false };
  var r = btn.getBoundingClientRect();
  var cs = getComputedStyle(btn);
  var hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return { hit: !!(hit && hit.closest('.head-download')),
    drawn: r.width > 0 && r.height > 0 && cs.visibility === 'visible' && cs.opacity === '1',
    inWindow: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    scrolled: document.body.classList.contains('stage-scrolled') };
})()`;
const ROUND_CLICK = n => `document.querySelector('.round[data-round="${n}"] .round-download').click()`;
const STRIP_CLICK = `document.querySelector('header.board-head .board-head-actions .head-download').click()`;

// Under print media at a printed page's width: every piece that must not be cut, with
// whether it asks to be kept whole and how tall it is.
const PRINT_EXPR = `(function () {
  return [].slice.call(document.querySelectorAll('section.export-round .block, section.export-round pre.mermaid, section.export-round .stage-wrap, table.export-decisions tr, section.export-round .md-content tr')).map(function (el) {
    return { what: (el.getAttribute('data-block-id') || el.className || el.tagName).toString().slice(0, 40),
      avoid: getComputedStyle(el).breakInside, height: el.getBoundingClientRect().height };
  });
})()`;

// The file under print media, paginated: the body becomes a column set one printed page
// wide and one page tall, so Chrome's own fragmentation lays each page out as a column
// (the engine paged media uses). A piece is cut when it leaves its column's top or bottom
// edge (a diagram or a frame, which cannot be split) or lies in more than one fragment (an
// option, a comment). Each piece carries its card and the page it begins on. Answers
// every such piece, how many pages each card runs over, and
// each mock as printed beside as laid out: its frame's box before the print scales it
// ('drawn'), the box it prints in, how far its right edge passes its holder's, and the
// holder's own box; and each block of code with how much of its text lies past its box,
// across and down, where print shows none of it.
const pagesExpr = width => `(function () {
  var style = document.createElement('style');
  style.textContent = 'html, body.round-export { margin: 0; padding: 0; } body.round-export { height: ${PRINT_H}px; column-width: ${width}px; column-gap: 0; column-fill: auto; }';
  document.head.appendChild(style);
  var bodyTop = document.body.getBoundingClientRect().top;
  function piece(what) {
    return function (el) {
      var r = el.getBoundingClientRect();
      return { what: what, top: Math.round(r.top - bodyTop), bottom: Math.round(r.bottom - bodyTop), height: Math.round(r.height),
        fragments: el.getClientRects().length, page: Math.floor(r.left / ${width}),
        block: el.closest('[data-block-id]').getAttribute('data-block-id') };
    };
  }
  function all(sel, what) { return [].slice.call(document.querySelectorAll(sel)).map(piece(what)); }
  return {
    pieces: [].concat(all('section.export-round pre.mermaid svg', 'diagram'), all('section.export-round iframe', 'mock'),
      all('section.export-round .export-frame', 'frame'),
      all('section.export-round .card-choice', 'option'), all('section.export-round .comment-item', 'comment'),
      all('section.export-round .md-content > p', 'paragraph'), all('section.export-round .md-content li', 'list item'),
      all('section.export-round .export-text', 'answer'), all('section.export-round .export-note-box', 'note')),
    cardPages: [].slice.call(document.querySelectorAll('section.export-round .block')).map(function (b) {
      return b.getAttribute('data-block-id') + ' ' + b.getClientRects().length; }),
    code: [].slice.call(document.querySelectorAll('section.export-round pre:not(.mermaid)')).map(function (el) {
      return el.closest('[data-block-id]').getAttribute('data-block-id') + ': ' + (el.scrollWidth - el.clientWidth) + 'px across, '
        + (el.scrollHeight - el.clientHeight) + 'px down';
    }),
    mocks: [].slice.call(document.querySelectorAll('section.export-round iframe')).map(function (f) {
      var r = f.getBoundingClientRect(), holder = f.parentElement.getBoundingClientRect();
      return { id: f.closest('[data-block-id]').getAttribute('data-block-id'), drawnW: f.offsetWidth, drawnH: f.offsetHeight,
        w: r.width, h: r.height, pastHolder: r.right - holder.right, holderW: holder.width, holderH: holder.height };
    }),
  };
})()`;

/** One of pagesExpr's mocks as a line of text. */
const mockLine = m => `${m.id}: drawn ${m.drawnW}x${m.drawnH}, printed ${Math.round(m.w)}x${Math.round(m.h)} in a holder ${Math.round(m.holderW)}x${Math.round(m.holderH)}`;
/** Whether a printed mock kept its drawn proportions. */
const keepsAspect = m => Math.abs(m.w / m.h - m.drawnW / m.drawnH) < 0.002;

/** Each piece pagesExpr found that is cut across a page's edge, as text. */
function cutPieces(pieces) {
  return pieces.filter(p => p.top < 0 || p.bottom > PRINT_H || p.fragments > 1)
    .map(p => `${p.what}: ${p.top}..${p.bottom} (${p.height}px), ${p.fragments} fragment(s)`);
}

// What a page must have left for an item to be split there: two of its lines and its
// own padding, with room to spare.
const SPLIT_ROOM = 80;

/** The kinds of piece a page's edge fell inside: one that begins a page though the page
 * before it, in the same card, ended with room for a split and too little for the whole
 * piece. Such a piece moved because it is kept whole; nothing else moves one. */
function contestedKinds(pieces) {
  const kinds = new Set();
  for (const p of pieces) {
    const inCard = pieces.filter(o => o.block === p.block);
    const before = inCard.filter(o => o.page === p.page - 1);
    if (!before.length || inCard.some(o => o.page === p.page && o.top < p.top)) continue;
    const left = PRINT_H - Math.max(...before.map(o => o.bottom));
    if (left >= SPLIT_ROOM && left < p.height) kinds.add(p.what);
  }
  return [...kinds].sort();
}

/** Runs `click`, a press of some Download on the open board tab, and answers the one file
 * it saved, into a directory of its own. */
async function downloadFrom(send, onEvent, tab, click) {
  const dir = scratchDir('cb-download-files-');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const done = waitForDownload(onEvent, dir);
  await tab.evalPage(click);
  const files = await done;
  const file = path.join(dir, files[0]);
  if (process.env.CLAUDE_BOARD_DOWNLOAD_KEEP) copyFileSync(file, path.join(process.env.CLAUDE_BOARD_DOWNLOAD_KEEP, files[0]));
  return { files, file };
}

/** Opens a saved file from disk, offline, at a printed page's size under print media,
 * and answers pagesExpr's reading of it. */
async function paginate(send, onEvent, file, cookie, width = PRINT_W) {
  const offline = async sp => {
    await sp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sp('Emulation.setEmulatedMedia', { media: 'print', features: [] });
  };
  const tab = await openTab(send, onEvent, pathToFileURL(file).href, cookie, { width, height: PRINT_H, theme: 'light', expr: '1', prepare: offline });
  await tab.sp('Emulation.setEmulatedMedia', { media: 'print', features: [] });
  const read = await tab.evalPage(pagesExpr(width));
  await tab.close();
  return read;
}

/** The height the artifact in block `id` reports, once it has reported one. An artifact
 * round's report moves no box, so no DOM change re-reads an 'until': polled. */
function reportedHeight(tab, id) {
  return tab.sp('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise(function (resolve) {
    var tries = 0;
    (function poll() {
      var h = document.querySelector('[data-block-id="${id}"] iframe').__cbStageContentH;
      if (h || ++tries > 100) return resolve(h || 0);
      setTimeout(poll, 50);
    })();
  })` }).then(r => r.result.value);
}

/** A DevTools session on the artifact whose text holds `marker`: to the browser a stage
 * is a frame of its own, with a target of its own. */
async function artifactSession(send, marker) {
  const { targetInfos } = await send('Target.getTargets');
  for (const t of targetInfos.filter(t => t.type === 'iframe')) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    if (await evalIn(send, sessionId, `document.body.textContent.indexOf(${JSON.stringify(marker)}) >= 0`)) return sessionId;
  }
  throw new Error(`no artifact frame holds "${marker}"`);
}

/** The room the board pads an artifact by for its header, dock and comment
 * rail, top and bottom together, read in the artifact itself (neither fixture artifact
 * pads its own body). */
const BAND_EXPR = `(function () {
  var cs = getComputedStyle(document.body);
  return parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
})()`;

/** How tall a saved file draws its mock: its frame's height less the frame's own edge. */
function savedMockHeight(file) {
  const m = /<iframe[^>]*style="height: (\d+)px/.exec(readFileSync(file, 'utf8'));
  return m ? Number(m[1]) - 2 : null;
}

async function waitForDownload(onEvent, dir) {
  return withTimeout(new Promise((resolve, reject) => {
    const off = onEvent(msg => {
      if (msg.method !== 'Browser.downloadProgress') return;
      if (msg.params.state === 'completed') { off(); resolve(readdirSync(dir).filter(f => !f.endsWith('.crdownload'))); }
      if (msg.params.state === 'canceled') { off(); reject(new Error('the download was canceled')); }
    });
  }), 30000, 'the download never completed');
}

async function main() {
  const daemon = await startScratchDaemon('cb-download');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const created = await postJson(`${origin}/api/board`, { title: TITLE, blocks: ROUND_1 }, daemon.secret);
    await postJson(`${origin}/api/board/${created.boardId}/submit`, { round: 1, action: 'send', answers: ANSWERS, comments: COMMENTS }, daemon.secret);
    // Before round 2's post, which writes the page from the stored board.
    const stored = path.join(daemon.home, 'boards', `${created.boardId}.json`);
    const doc = JSON.parse(readFileSync(stored, 'utf8'));
    doc.rounds[0].sentAt = SENT_AT;
    writeFileSync(stored, JSON.stringify(doc));
    await postJson(`${origin}/api/board`, { boardId: created.boardId, title: TITLE, blocks: OPEN_ROUND }, daemon.secret);
    const boardUrl = `${origin}${new URL(created.url).pathname}`;
    const downloads = scratchDir('cb-download-files-');

    const tall = await postJson(`${origin}/api/board`, { title: TALL_TITLE, blocks: TALL_ROUND_1 }, daemon.secret);
    await postJson(`${origin}/api/board/${tall.boardId}/submit`, { round: 1, action: 'send', answers: [],
      comments: TALL_PAGE_COMMENTS }, daemon.secret);
    await postJson(`${origin}/api/board`, { boardId: tall.boardId, title: TALL_TITLE, blocks: TALL_ROUND_2 }, daemon.secret);
    await postJson(`${origin}/api/board/${tall.boardId}/submit`, { round: 2, action: 'send',
      answers: [{ id: 'q7', status: 'answered', choice: 'Option 7', note: '' },
        { id: 'q9', status: 'answered', choice: TALL_ANSWER, note: TALL_NOTE }], comments: TALL_COMMENTS }, daemon.secret);
    await postJson(`${origin}/api/board`, { boardId: tall.boardId, title: TALL_TITLE, blocks: TALL_ROUND_3 }, daemon.secret);
    await postJson(`${origin}/api/board/${tall.boardId}/submit`, { round: 3, action: 'send', answers: [], comments: [] }, daemon.secret);
    await postJson(`${origin}/api/board`, { boardId: tall.boardId, title: TALL_TITLE,
      blocks: [{ id: 'q8', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }] }] }, daemon.secret);
    const tallUrl = `${origin}${new URL(tall.url).pathname}`;
    const shown = await postJson(`${origin}/api/board`, { title: SHOWN_TITLE, blocks: SHOWN_ROUND_1 }, daemon.secret);
    const shownUrl = `${origin}${new URL(shown.url).pathname}`;

    await withChrome({ tag: 'cb-download', hideScrollbars: true }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const board = await openTab(send, onEvent, boardUrl, cookie, { width: 1280, height: 900, theme: 'dark',
        expr: `document.querySelector('.round-current').getAttribute('data-round')` });

      const offline = async sp => { await sp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); };

      const open = await board.evalPage(`(function () {
        var round = document.querySelector('.round[data-round="2"]');
        var chips = round.querySelector('.round-chips');
        var btn = chips && chips.querySelector('.round-download');
        return { status: round.getAttribute('data-round-status'), text: btn && btn.textContent.trim(),
          last: !!btn && chips.lastElementChild === btn, disabled: btn && btn.disabled };
      })()`);
      await row('a round not yet sent shows Download round at the right end of its chip line, live, as a sent round does', () => {
        assert.equal(board.measured, '2', 'setup: the board opens on its open round');
        assert.deepEqual(open, { status: 'open', text: 'Download round', last: true, disabled: false });
      });

      await board.evalPage(`document.querySelector('[data-block-id="q6"] .card-choice').click()`);
      await board.until(`document.querySelector('[data-block-id="q6"] .card-choice.selected')`, 'the pick on the open round');
      const unsentDownload = await downloadFrom(send, onEvent, board, ROUND_CLICK(2));
      const unsent = await measureTab(send, onEvent, pathToFileURL(unsentDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', expr: UNSENT_EXPR, prepare: offline });
      await row('an unsent round\'s file opens offline on a Not sent line, above its head, and names the round unsent', note => {
        note(`${unsentDownload.files.join(', ')}: ${unsent.note} | ${unsent.meta} | ${unsent.sections.join(' > ')}`);
        assert.deepEqual(unsentDownload.files, ['download-fixture-round-2.html']);
        assert.equal(unsent.first, 'export-unsent-note', 'the first thing in the file');
        assert.equal(unsent.note, 'Not sent: these picks are a draft, not a decision.');
        assert.equal(unsent.noteAboveHead, true, 'drawn, above the board\'s title');
        assert.deepEqual(unsent.meta, ['Round 2', 'Not sent']);
        assert.deepEqual(unsent.sections, ['Picks so far, not sent', 'Round content']);
        assert.deepEqual({ scripts: unsent.scripts, controls: unsent.controls, fetched: unsent.fetched }, { scripts: 0, controls: 0, fetched: [] });
      });
      await row('the unsent file shows the pick made on the page so far, marked unsent, and the question left alone as unanswered', () => {
        assert.deepEqual(unsent.heads, ['Question', 'Pick, unsent', 'Note']);
        assert.deepEqual(unsent.rows, [['Next?', 'Go', ''], ['And then?', 'No answer', '']]);
        assert.deepEqual(unsent.options.map(o => `${o.label}${o.picked ? ' (picked)' : ''}`), ['Go (picked)', 'Wait', 'Stop', 'On']);
        assert.match(unsent.options[0].after, /picked, unsent/, 'the picked option says so after its label');
        assert.deepEqual(unsent.options.slice(1).map(o => o.after), ['none', 'none', 'none'], 'no other option does');
        assert.deepEqual(unsent.chips, ['Answered, unsent', ''], 'the picked question\'s state chip says unsent too');
        assert.equal(unsent.hints, 0, 'the page\'s paste hint stays on the page');
      });

      await board.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await board.until(`document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the flip to round 1');
      await board.quiet();
      const line = await board.evalPage(`(function () {
        function box(el) { var r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, mid: r.top + r.height / 2 }; }
        var chips = document.querySelector('.round[data-round="1"] .round-chips');
        var btn = chips.querySelector('.round-download');
        return { text: btn && btn.textContent.trim(), last: chips.lastElementChild === btn, disabled: btn && btn.disabled,
          chips: box(chips), btn: btn && box(btn), label: box(chips.querySelector('.round-label')),
          card: box(document.querySelector('.round[data-round="1"] > .block')) };
      })()`);
      await row('a sent round shows Download round at the right end of its chip line', note => {
        note(`chip line ${line.chips.left}..${line.chips.right}, button ${line.btn && line.btn.left}..${line.btn && line.btn.right}, cards end at ${line.card.right}`);
        assert.equal(line.text, 'Download round');
        assert.equal(line.last, true, 'the control closes the chip line');
        assert.equal(line.disabled, false, 'live on the sent round');
        assert.ok(Math.abs(line.btn.right - line.card.right) <= 0.5, 'its right edge is the round\'s own right edge');
        assert.ok(Math.abs(line.btn.mid - line.label.mid) <= 1, 'on the label\'s line');
      });

      // The stage reports its own height a frame or two after it lays out.
      const stageH = await board.until(`document.querySelector('[data-block-id="h1"] iframe').__cbStageContentH`, 'the stage reporting its height');
      // The wide mock sits below the window's bottom and is never scrolled to: the browser
      // lays out no frame it does not show, so the board has heard no height from it.
      const unseen = await board.evalPage(`(function () {
        var frame = document.querySelector('[data-block-id="h3"] iframe');
        return { top: frame.getBoundingClientRect().top, windowBottom: window.innerHeight, reported: frame.__cbStageContentH || 0 };
      })()`);

      // Pull-out, the full-window view of one mock or one diagram, and its own Download.
      const barOf = lens => `[].slice.call(document.querySelectorAll('dialog.${lens} .lens-bar .lens-btn')).map(function (b) { return b.textContent.trim(); })`;
      await board.evalPage(`document.querySelector('[data-block-id="h1"] .pull-out').click()`);
      await board.until(`document.querySelector('dialog.stage-lens[open] iframe')`, 'the mock pulled out');
      const mockBar = await board.evalPage(barOf('stage-lens'));
      const mockDownload = await downloadFrom(send, onEvent, board, `document.querySelector('dialog.stage-lens [data-lens="download"]').click()`);
      await board.evalPage(`document.querySelector('dialog.stage-lens [data-lens="close"]').click()`);
      await board.until(`!document.querySelector('dialog.stage-lens[open]')`, 'the mock\'s Pull-out closed');
      await board.until(`document.querySelector('[data-block-id="m1"] pre.mermaid svg')`, 'the diagram drawn');
      await board.evalPage(`document.querySelector('[data-block-id="m1"] .pull-out').click()`);
      await board.until(`document.querySelector('dialog.diagram-lens[open] svg')`, 'the diagram pulled out');
      const diagramBar = await board.evalPage(barOf('diagram-lens'));
      const diagramDownload = await downloadFrom(send, onEvent, board, `document.querySelector('dialog.diagram-lens [data-lens="download"]').click()`);
      await board.evalPage(`document.querySelector('dialog.diagram-lens [data-lens="close"]').click()`);
      await board.until(`!document.querySelector('dialog.diagram-lens[open]')`, 'the diagram\'s Pull-out closed');
      const oneMock = await measureTab(send, onEvent, pathToFileURL(mockDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', expr: ONE_EXPR, prepare: offline });
      const oneDiagram = await measureTab(send, onEvent, pathToFileURL(diagramDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', expr: ONE_EXPR, prepare: offline });
      const quiet = m => ({ scripts: m.scripts, controls: m.controls, fetched: m.fetched, rest: m.rest });
      await row('Pull-out on a mock has a Download beside close, which saves that mock alone as one file that opens offline, at its full height, script-free', note => {
        const bytes = readFileSync(mockDownload.file, 'utf8');
        note(`${mockBar.join(' | ')}; ${mockDownload.files.join(', ')}, ${bytes.length} bytes, the mock ${oneMock.frame && oneMock.frame.height}px tall`);
        assert.deepEqual(mockBar.slice(-2), ['download', 'close']);
        assert.deepEqual(mockDownload.files, ['download-fixture-round-1-mock-h1.html']);
        assert.doesNotMatch(bytes, /<script/i);
        assert.doesNotMatch(bytes, /allow-scripts/);
        assert.equal(oneMock.title, TITLE);
        assert.deepEqual(oneMock.meta, ['Round 1', 'One mock']);
        assert.deepEqual({ frames: oneMock.frames, svgs: oneMock.svgs }, { frames: 1, svgs: 0 }, 'the mock and no diagram');
        assert.equal(oneMock.frame.sandbox, '', 'sandboxed with nothing allowed');
        assert.ok(oneMock.frame.height >= STAGE_PX, `as tall as the mock, not the ${oneMock.frame.height}px the board folds it to`);
        assert.match(oneMock.frame.srcdoc, /Static mock/);
        assert.deepEqual(quiet(oneMock), { scripts: 0, controls: 0, fetched: [], rest: 0 }, 'no script, no control, nothing fetched, nothing else of the round');
      });
      await row('Pull-out on a diagram has the same Download, which saves that diagram alone, drawn, as one file that opens offline', note => {
        const bytes = readFileSync(diagramDownload.file, 'utf8');
        note(`${diagramBar.join(' | ')}; ${diagramDownload.files.join(', ')}, ${bytes.length} bytes, the diagram ${oneDiagram.svg && Math.round(oneDiagram.svg.width)}x${oneDiagram.svg && Math.round(oneDiagram.svg.height)}`);
        assert.deepEqual(diagramBar.slice(-4), ['fit', '1:1', 'download', 'close']);
        assert.deepEqual(diagramDownload.files, ['download-fixture-round-1-diagram-m1.html']);
        assert.doesNotMatch(bytes, /<script/i);
        assert.deepEqual(oneDiagram.meta, ['Round 1', 'One diagram']);
        assert.deepEqual({ frames: oneDiagram.frames, svgs: oneDiagram.svgs }, { frames: 0, svgs: 1 }, 'the diagram and no mock');
        assert.ok(oneDiagram.svg.width > 50 && oneDiagram.svg.height > 100, 'drawn at a size to read');
        assert.equal(oneDiagram.svg.nodes, 4, 'all four of its nodes');
        assert.deepEqual(quiet(oneDiagram), { scripts: 0, controls: 0, fetched: [], rest: 0 }, 'no script, no control, nothing fetched, nothing else of the round');
      });

      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
      const done = waitForDownload(onEvent, downloads);
      await board.evalPage(`document.querySelector('.round[data-round="1"] .round-download').click()`);
      const files = await done;
      await board.close();

      await row('Download round saves one HTML file named for the board and the round', note => {
        note(files.join(', '));
        assert.deepEqual(files, ['download-fixture-round-1.html']);
      });
      const file = path.join(downloads, files[0]);
      if (process.env.CLAUDE_BOARD_DOWNLOAD_KEEP) copyFileSync(file, path.join(process.env.CLAUDE_BOARD_DOWNLOAD_KEEP, files[0]));
      const bytes = readFileSync(file, 'utf8');

      await row('the file carries no script, no allow-scripts and no address off the page', note => {
        note(`${bytes.length} bytes`);
        assert.doesNotMatch(bytes, /<script/i);
        assert.doesNotMatch(bytes, /allow-scripts/);
        assert.doesNotMatch(bytes, /src="(?!data:)/, 'every src is a data: URL');
      });

      const saved = await openTab(send, onEvent, pathToFileURL(file).href, cookie, { width: 1280, height: 900, theme: 'dark', expr: EXPORT_EXPR, prepare: offline });
      const m = saved.measured;

      await row('opened from disk with the network off, it heads with the title, the round and its date, then the decisions table', note => {
        note(`${m.title} | ${m.meta} | ${m.sections.join(' > ')}`);
        assert.equal(m.title, TITLE);
        assert.deepEqual(m.meta, ['Round 1', 'Sent 2026-03-04']);
        assert.deepEqual(m.sections, ['Decisions', 'Round content']);
        assert.equal(m.decisionsFirst, true);
        assert.deepEqual(m.fetched, [], 'nothing asked of the network or the disk');
      });

      await row('the decisions table names each question, its pick and its note', () => {
        assert.deepEqual(m.rows, [
          ['Which way?', 'No', 'Hold for review'],
          ['Which parts?', 'A, C', ''],
          ['Say why', 'Free text answer', ''],
          ['Order them', '1. Z, 2. X, 3. Y', ''],
          ['Park this?', 'Deferred', ''],
        ]);
      });

      await row('each question keeps every option, the pick marked', () => {
        const picks = opts => opts.filter(o => o.picked).map(o => o.label);
        assert.deepEqual(m.q1.map(o => o.label), ['Yes', 'No', 'Later']);
        assert.deepEqual(picks(m.q1), ['No']);
        assert.deepEqual(m.q2.map(o => o.label), ['A', 'B', 'C']);
        assert.deepEqual(picks(m.q2), ['A', 'C']);
        for (const o of [...m.q1, ...m.q2]) assert.equal(o.mark.includes('✓'), o.picked, `${o.label}: a check mark exactly on a pick`);
        assert.deepEqual(m.rank, ['Z', 'X', 'Y']);
        assert.deepEqual(m.text, ['Free text answer']);
        assert.deepEqual(m.note, [{ tag: 'Note', text: 'Hold for review' }]);
        assert.equal(m.controls, 0, 'no control is left in the file');
      });

      await row('the diagram is SVG, whole, in the light palette', note => {
        note(`svg ${m.svg && m.svg.height}px tall, node fill ${m.svg && m.svg.fill}`);
        assert.ok(m.svg && m.svg.height > 100, 'drawn, not raw source');
        assert.equal(m.preClipped, false, 'not cut by its box');
        assert.equal(m.svg.fill, 'rgb(245, 246, 251)', 'the light palette\'s --panel-2, though the board was dark');
      });

      await row('the mock is drawn at its full height with none of its scripts run', note => {
        note(`stage reported ${stageH}px on the board; file frame ${m.frame && m.frame.height}px, sandbox="${m.frame && m.frame.sandbox}"`);
        assert.ok(stageH >= STAGE_PX, 'setup: the board measured the mock');
        assert.equal(m.frame.sandbox, '');
        assert.equal(m.frame.height, stageH + 2, 'the stage\'s own height plus its frame edge, past the board\'s 600px fold');
        assert.ok(m.frame.srcdoc.includes('Static mock'), 'the mock\'s markup rides');
        assert.ok(!/<script/i.test(m.frame.srcdoc), 'its script does not');
      });

      await row('a mock below the window\'s bottom, never scrolled to, is saved at its full height too', note => {
        note(`on the board its frame began at ${unseen.top}px of a ${unseen.windowBottom}px window, reported ${unseen.reported}px; file frame ${m.wideFrameHeight}px`);
        assert.ok(unseen.top > unseen.windowBottom, 'setup: the mock is below the window\'s bottom');
        assert.equal(unseen.reported, 0, 'setup: the board has heard no height from it');
        assert.equal(m.wideFrameHeight, WIDE_STAGE_PX + 2, 'its own height plus its frame edge, not the placeholder a stage holds until its first report');
      });

      await row('each comment is listed under what it points at', () => {
        assert.deepEqual(m.diagramComments, ['Diagram comment', 'Pick node comment']);
        assert.deepEqual(m.mockComments, ['Mock comment']);
      });

      await row('the round\'s images ride inline: each pasted one as a data: URL under its note or comment, one off another host named in its place', () => {
        assert.deepEqual(m.images, [
          { where: 'comment h1', data: true, width: 3 },
          { where: 'note q1', data: true, width: 3 },
        ]);
        assert.deepEqual(m.missing, ['Image not included']);
        assert.equal(m.scripts, 0);
      });

      await saved.sp('Emulation.setEmulatedMedia', { media: 'print', features: [] });
      await saved.sp('Emulation.setDeviceMetricsOverride', { width: PRINT_W, height: PRINT_H, deviceScaleFactor: 1, mobile: false });
      const pieces = await saved.evalPage(PRINT_EXPR);
      await saved.close();
      await row('printed, no card, diagram, stage, decisions row or table row is cut across pages', note => {
        note(`${pieces.length} pieces, tallest ${Math.max(...pieces.map(p => Math.round(p.height)))}px of a ${PRINT_H}px page`);
        assert.ok(pieces.length >= 14, 'setup: the cards, the diagram, the stage and the rows were found');
        assert.equal(pieces.filter(p => p.what === 'TR').length, 9, 'setup: the decisions table\'s six rows and the markdown table\'s three were found');
        const cut = pieces.filter(p => p.avoid !== 'avoid' || p.height > PRINT_H).map(p => `${p.what}: ${p.avoid}, ${Math.round(p.height)}px`);
        assert.deepEqual(cut, []);
      });

      const printedFirst = await paginate(send, onEvent, file, cookie, A4_W);
      const frames = printedFirst.pieces.filter(p => p.what === 'frame');
      const [small, wide] = ['h1', 'h3'].map(id => printedFirst.mocks.find(k => k.id === id));
      await row('printed, a mock not taller than a page prints at its own size', note => {
        note(mockLine(small));
        assert.equal(small.drawnH, stageH + 2, 'setup: the mock is shorter than a page');
        assert.ok(small.drawnH < FIT_H);
        assert.deepEqual({ w: small.w, h: small.h }, { w: small.drawnW, h: small.drawnH }, 'not scaled');
        assert.ok(small.pastHolder <= 0.5, `its right edge is inside its holder, not ${small.pastHolder}px past it`);
      });
      await row('printed, a wide mock taller than a page is fitted to its holder\'s width, its right edge inside', note => {
        note(mockLine(wide));
        assert.ok(wide.drawnH > FIT_H && wide.drawnW / wide.drawnH > A4_W / FIT_H, 'setup: taller than a page, and its width limits it');
        assert.ok(wide.pastHolder <= 0.5, `its right edge is inside its holder, not ${wide.pastHolder}px past it`);
        assert.ok(Math.abs(wide.w - wide.holderW) <= 1, 'as wide as its holder, no smaller');
        assert.ok(keepsAspect(wide), 'in its drawn proportions');
        assert.ok(Math.abs(wide.holderH - wide.h) <= 1, 'its holder is as tall as it prints');
        assert.equal(frames.length, 2, 'setup: both holders were found');
        assert.deepEqual(cutPieces(frames), []);
      });

      await row('printed, a block of code shows every line whole: none below its box, none off its right edge', () => {
        assert.deepEqual(printedFirst.code, ['c1: 0px across, 0px down', 'd3: 0px across, 0px down']);
      });

      const tallTab = await openTab(send, onEvent, tallUrl, cookie, { width: 1280, height: 800, theme: 'dark',
        expr: `document.querySelector('.round-current').getAttribute('data-round')` });
      await tallTab.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await tallTab.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the flip to the artifact round');
      await reportedHeight(tallTab, 'h2');
      await tallTab.quiet();
      const page = await tallTab.evalPage(`(function () {
        function box(el) { var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }
        var btn = document.querySelector('header.board-head .board-head-actions .head-download');
        return { btn: btn && box(btn), text: btn && btn.textContent.trim(), head: box(document.querySelector('.board-head')),
          status: document.querySelector('.round-current').getAttribute('data-round-status'),
          chips: document.querySelectorAll('.round-current .round-chips, .round-current .round-download').length,
          frameTop: box(document.querySelector('.round-current iframe')).top };
      })()`);
      const stripAtRest = await tallTab.evalPage(STRIP_EXPR);
      const tallFrame = await artifactSession(send, 'Tall mock');
      const padTop = await evalIn(send, tallFrame, 'parseFloat(getComputedStyle(document.body).paddingTop)');
      await row('a sent artifact round, drawn full page, shows Download round in the top strip, among its controls', note => {
        note(`header ${page.head.top}..${page.head.bottom}, button ${page.btn && page.btn.top}..${page.btn && page.btn.bottom}`);
        assert.equal(tallTab.measured, '4', 'setup: the board opens on its open round');
        assert.equal(page.status, 'sent', 'setup: the artifact round is sent');
        assert.ok(page.btn, 'the top strip has the control');
        assert.equal(page.text, 'Download round');
        assert.ok(page.btn.top >= page.head.top && page.btn.bottom <= page.head.bottom, 'inside the strip');
        assert.deepEqual(stripAtRest, { hit: true, drawn: true, inWindow: true, scrolled: false }, 'drawn, and a click lands on it');
        assert.equal(page.chips, 0, 'and no chip line or second control over the artifact');
      });

      await row('the artifact is padded down to the top strip\'s bottom and no further, so the strip covers none of it', note => {
        note(`the strip ends at ${page.head.bottom}, the artifact's own top padding is ${padTop}px in a frame at ${page.frameTop}`);
        assert.ok(Math.abs(page.frameTop + padTop - page.head.bottom) <= 0.5, 'the artifact begins where the strip ends');
      });

      await evalIn(send, tallFrame, 'window.scrollTo(0, 400)');
      await tallTab.until(`document.body.classList.contains('stage-scrolled')`, 'the artifact scrolling under the header');
      await tallTab.quiet();
      const stripScrolled = await tallTab.evalPage(STRIP_EXPR);
      const scrolledDownload = await downloadFrom(send, onEvent, tallTab, STRIP_CLICK);
      await evalIn(send, tallFrame, 'window.scrollTo(0, 0)');
      await tallTab.until(`!document.body.classList.contains('stage-scrolled')`, 'the artifact back at its top');
      await tallTab.quiet();
      await row('once the artifact has scrolled under the header, the strip\'s Download round is still drawn and its click still saves the round', note => {
        note(scrolledDownload.files.join(', '));
        assert.deepEqual(stripScrolled, { hit: true, drawn: true, inWindow: true, scrolled: true });
        assert.deepEqual(scrolledDownload.files, ['tall-fixture-round-1.html']);
      });

      const mockBand = await evalIn(send, tallFrame, BAND_EXPR);
      const pageDownload = await downloadFrom(send, onEvent, tallTab, STRIP_CLICK);
      await row('its Download round saves the artifact round as one HTML file, the mock at its full height', note => {
        const saved = savedMockHeight(pageDownload.file);
        note(`${pageDownload.files.join(', ')}; the artifact is ${TALL_MOCK_PX}px tall, padded ${mockBand}px on the board; the file draws it ${saved}px tall, ${saved - TALL_MOCK_PX}px of that past its end`);
        assert.deepEqual(pageDownload.files, ['tall-fixture-round-1.html']);
        assert.ok(mockBand > 0, 'setup: the board pads the artifact for its own chrome');
        assert.ok(saved >= TALL_MOCK_PX, 'no shorter than the artifact, which would cut its end off');
        assert.ok(saved <= TALL_MOCK_PX + Math.ceil(mockBand), 'and no taller than the artifact with the room the board pads it by');
      });

      const pageFile = await measureTab(send, onEvent, pathToFileURL(pageDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', expr: PAGE_FILE_EXPR, prepare: offline });
      await row('the artifact round\'s file lists every comment below the mock, none hidden in a scroll box, with no control or send bar left', note => {
        note(pageFile.comments.map(c => `${c.text}: ${c.below ? 'below' : 'over'} the mock, ${c.shown ? 'shown' : 'hidden'}`).join('; '));
        assert.deepEqual(pageFile.comments, TALL_PAGE_COMMENTS.map(c => ({ text: c.text, below: true, shown: true })));
        assert.equal(pageFile.controls, 0, 'no control is left in the file');
        assert.equal(pageFile.sendBars, 0, 'the board\'s send bar stays on the board');
      });

      await tallTab.evalPage(`document.querySelector('.round-page[data-round="2"]').click()`);
      await tallTab.until(`document.querySelector('.round[data-round="2"]').classList.contains('round-current')`, 'the flip to round 2');
      await tallTab.until(`document.querySelector('[data-block-id="m2"] pre.mermaid svg')`, 'the tall diagram drawn');
      const tallDownload = await downloadFrom(send, onEvent, tallTab, ROUND_CLICK(2));

      await tallTab.evalPage(`document.querySelector('.round-page[data-round="3"]').click()`);
      await tallTab.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="3"]').classList.contains('round-current')`, 'the flip to the pinned artifact round');
      await reportedHeight(tallTab, 'h4');
      await tallTab.quiet();
      const pinnedFrame = await artifactSession(send, 'Pinned body');
      const pinnedBand = await evalIn(send, pinnedFrame, BAND_EXPR);
      const pinnedDownload = await downloadFrom(send, onEvent, tallTab, STRIP_CLICK);
      await row('an artifact whose content spills out of a body pinned to the window is saved at the content\'s full height', note => {
        const saved = savedMockHeight(pinnedDownload.file);
        note(`the artifact is ${PINNED_PX}px tall, padded ${pinnedBand}px on the board; the file draws it ${saved}px tall, ${saved - PINNED_PX}px of that past its end`);
        assert.ok(pinnedBand > 0, 'setup: the board pads the artifact for its own chrome');
        assert.ok(saved >= PINNED_PX, 'no shorter than the artifact, which would cut its end off');
        assert.ok(saved <= PINNED_PX + Math.ceil(pinnedBand), 'and no taller than the artifact with the room the board pads it by');
      });

      // Measured again with the reader at its end. A measure that took the board's padding
      // off for the read would leave the document shorter than where the reader is.
      const atEnd = await evalIn(send, pinnedFrame, `(function () {
        window.scrollTo(0, document.documentElement.scrollHeight);
        // Added after the stage's own listener, so read once that has measured.
        window.__afterAsk = new Promise(function (resolve) {
          window.addEventListener('message', function (ev) { if (ev.data && ev.data.type === 'height') resolve(window.scrollY); });
        });
        return window.scrollY;
      })()`);
      await tallTab.evalPage(`document.querySelector('[data-block-id="h4"] iframe').contentWindow.postMessage({ cb: 'cb-stage', type: 'height' }, '*')`);
      const afterAsk = await evalIn(send, pinnedFrame, 'window.__afterAsk', { awaitPromise: true });
      await evalIn(send, pinnedFrame, 'window.scrollTo(0, 0)');
      await tallTab.until(`!document.body.classList.contains('stage-scrolled')`, 'the pinned artifact back at its top');
      await row('measuring an artifact leaves a reader at its end where they were', note => {
        note(`at ${atEnd}px before the board asked its height, ${afterAsk}px after`);
        assert.ok(atEnd > PINNED_PX - 800, 'setup: the reader is further down than the artifact reaches without the board\'s padding');
        assert.equal(afterAsk, atEnd);
      });

      // Back on the artifact round, in a window too narrow for the header to condense.
      await tallTab.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await tallTab.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the flip back to the artifact round');
      await tallTab.sp('Emulation.setDeviceMetricsOverride', { width: 560, height: 800, deviceScaleFactor: 1, mobile: false });
      await tallTab.quiet();
      const narrowAtRest = await tallTab.evalPage(STRIP_EXPR);
      await evalIn(send, await artifactSession(send, 'Tall mock'), 'window.scrollTo(0, 200)');
      await tallTab.until(`document.body.classList.contains('stage-scrolled')`, 'the artifact scrolling');
      const narrowScrolled = await tallTab.evalPage(STRIP_EXPR);
      await tallTab.close();
      await row('in a narrow window the strip\'s Download round is drawn inside the window and takes a click, at rest and over a scrolled artifact', () => {
        assert.deepEqual(narrowAtRest, { hit: true, drawn: true, inWindow: true, scrolled: false });
        assert.deepEqual(narrowScrolled, { hit: true, drawn: true, inWindow: true, scrolled: true });
      });

      // An artifact that asks nothing is never sent: its round offers the same control.
      const shownTab = await openTab(send, onEvent, shownUrl, cookie, { width: 1280, height: 800, theme: 'dark',
        expr: `document.body.classList.contains('page-board') && document.querySelector('.round-current').getAttribute('data-round-status')` });
      await reportedHeight(shownTab, 'h5');
      await shownTab.quiet();
      const shownAtRest = await shownTab.evalPage(STRIP_EXPR);
      await evalIn(send, await artifactSession(send, 'Shown mock'), 'window.scrollTo(0, 400)');
      await shownTab.until(`document.body.classList.contains('stage-scrolled')`, 'the unsent artifact scrolling under the header');
      await shownTab.quiet();
      const shownScrolled = await shownTab.evalPage(STRIP_EXPR);
      const shownDownload = await downloadFrom(send, onEvent, shownTab, STRIP_CLICK);
      await shownTab.close();
      const shownFile = await measureTab(send, onEvent, pathToFileURL(shownDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', prepare: offline, expr: `({
          meta: [].slice.call(document.querySelectorAll('.export-meta > span')).map(function (e) { return e.textContent.trim(); }),
          unsentNotes: document.querySelectorAll('.export-unsent-note').length,
          empty: (document.querySelector('.export-empty') || {}).textContent, frames: document.querySelectorAll('iframe').length })` });
      await row('an artifact round never sent shows the same Download round in the top strip, at rest and scrolled, and it saves the round', note => {
        note(shownDownload.files.join(', '));
        assert.equal(shownTab.measured, 'open', 'setup: drawn full page, and not sent');
        assert.deepEqual(shownAtRest, { hit: true, drawn: true, inWindow: true, scrolled: false });
        assert.deepEqual(shownScrolled, { hit: true, drawn: true, inWindow: true, scrolled: true });
        assert.deepEqual(shownDownload.files, ['shown-fixture-round-1.html']);
        assert.deepEqual(shownFile, { meta: ['Round 1'], unsentNotes: 0, empty: 'This round asked no questions.', frames: 1 },
          'the mock, and no Not sent line: nothing was asked, so nothing is a draft');
      });

      // The board as a reader has it with no daemon behind it: opened from disk, read-only.
      const archive = copyArchive(path.join(daemon.home, 'pages'), tall.boardId, 'cb-download');
      const archived = await openTab(send, onEvent, archive.pageUrl, cookie, { width: 1280, height: 800, theme: 'dark',
        expr: `document.body.classList.contains('readonly')` });
      await archived.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await archived.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the archive\'s flip to the artifact round');
      await archived.quiet();
      const strip = await archived.evalPage(`(function () {
        var btn = document.querySelector('header.board-head .head-download');
        return { present: !!btn, display: btn && getComputedStyle(btn).display,
          chips: document.querySelectorAll('.round-current .round-chips').length };
      })()`);
      await archived.close();
      await row('a read-only archive, which cannot save a round, shows no Download round in its top strip and no chip line over the artifact', () => {
        assert.equal(archived.measured, true, 'setup: opened from disk, the board is read-only');
        assert.deepEqual(strip, { present: true, display: 'none', chips: 0 });
      });

      const printedPage = await paginate(send, onEvent, pageDownload.file, cookie, A4_W);
      await row('printed, a mock taller than a page is scaled to fit one, never cut', note => {
        note(`${printedPage.mocks.map(mockLine).join(', ')}; ${printedPage.pieces.map(p => `${p.what} ${p.top}..${p.bottom}`).join(', ')}`);
        assert.equal(printedPage.mocks.length, 1, 'setup: the mock was found');
        const [mock] = printedPage.mocks;
        assert.ok(Math.abs(mock.h - FIT_H) <= 1, `one page tall, not ${mock.h}px`);
        assert.ok(keepsAspect(mock), 'in its drawn proportions');
        assert.ok(mock.pastHolder <= 0.5, `its right edge is inside its holder, not ${mock.pastHolder}px past it`);
        assert.ok(Math.abs(mock.holderH - mock.h) <= 1, 'its holder is as tall as it prints');
        assert.deepEqual(cutPieces(printedPage.pieces), [], 'the mock, its holder and the comments under it');
      });

      const printedTall = await paginate(send, onEvent, tallDownload.file, cookie);
      await row('printed, a diagram taller than a page is drawn to fit one, never cut', note => {
        const svgs = printedTall.pieces.filter(p => p.what === 'diagram');
        note(svgs.map(p => `diagram ${p.top}..${p.bottom} (${p.height}px)`).join(', '));
        assert.equal(svgs.length, 1, 'setup: the diagram was found');
        assert.deepEqual(cutPieces(svgs), []);
      });
      await row('printed, a card taller than a page breaks only between its paragraphs, list items, options, comments, answer and note, each kept whole', note => {
        const items = printedTall.pieces.filter(p => p.what !== 'diagram');
        const counts = {};
        for (const p of items) counts[p.what] = (counts[p.what] || 0) + 1;
        const contested = contestedKinds(printedTall.pieces);
        note(`pages per card: ${printedTall.cardPages.join(', ')}; a page's edge fell inside: ${contested.join(', ')}`);
        assert.deepEqual(printedTall.cardPages.map(c => Number(c.split(' ')[1]) > 1), [true, true, true, true], 'setup: the text, the diagram\'s card and both questions each run past a page');
        assert.deepEqual(counts, { option: 14, comment: 14, paragraph: 11, 'list item': 8, answer: 1, note: 1 }, 'setup: every item was found');
        assert.deepEqual(cutPieces(items), []);
        assert.deepEqual(contested, ['answer', 'comment', 'list item', 'note', 'option', 'paragraph'],
          'a page\'s edge fell inside an item of every kind: each was kept whole by its own rule, none by where the edges happened to fall');
      });
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
