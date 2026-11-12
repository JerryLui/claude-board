// Real-browser check for Download round (src/round-export.mjs, src/ui.mjs's
// downloadRound): a sent round offers it at the right end of its chip line and an open
// round does not; the file it saves opens from disk with the network off and holds the
// board's title, the round's number and date, the decisions table first, every option
// with the pick marked, the diagram as SVG at full height, the mock at its full height
// with none of its scripts run, each comment under what it points at and every image as
// a data: URL, with no script anywhere in it; and under print media every card, diagram,
// stage and decisions row is kept whole and fits one page, a mock no taller than a page
// at its own size and a taller one scaled into its holder. A second board holds what is
// taller than a printed page: a sent artifact round (drawn full page, its Download round
// on a chip line of its own, its file listing every comment under the mock), a long text,
// a diagram, a question with many options and a long comment list; its files are
// paginated under print media and nothing that must stay whole sits across a page's edge. Layout, a real download and a file: page, none of which the DOM
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
const TALL_ROUND_2 = [
  { id: 'd2', kind: 'markdown', text: Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: ` + 'a sentence that runs on so the paragraph takes several printed lines. '.repeat(8)).join('\n\n') },
  { id: 'm2', kind: 'mermaid', text: 'flowchart TD\n' + Array.from({ length: 24 }, (_, i) => `  n${i}[Step ${i}] --> n${i + 1}[Step ${i + 1}]`).join('\n') },
  { id: 'q7', kind: 'question', prompt: 'Which of the many?', widget: 'single',
    options: Array.from({ length: 30 }, (_, i) => ({ label: `Option ${i}`, description: `What option ${i} would mean, in a sentence long enough to take a line of its own.` })) },
];
const TALL_COMMENTS = Array.from({ length: 30 }, (_, i) => ({ blockId: 'm2', anchor: { kind: 'block' },
  text: `Comment ${i} on the diagram, long enough that thirty of them run past a printed page.` }));

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
// option, a comment). Answers every such piece, how many pages each card runs over, and
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
        fragments: el.getClientRects().length };
    };
  }
  function all(sel, what) { return [].slice.call(document.querySelectorAll(sel)).map(piece(what)); }
  return {
    pieces: [].concat(all('section.export-round pre.mermaid svg', 'diagram'), all('section.export-round iframe', 'mock'),
      all('section.export-round .export-frame', 'frame'),
      all('section.export-round .card-choice', 'option'), all('section.export-round .comment-item', 'comment'),
      all('section.export-round .md-content > p', 'paragraph')),
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

/** Clicks round `n`'s Download round on the open board tab and answers the one file it
 * saved, into a directory of its own. */
async function downloadFrom(send, onEvent, tab, n) {
  const dir = scratchDir('cb-download-files-');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  const done = waitForDownload(onEvent, dir);
  await tab.evalPage(`document.querySelector('.round[data-round="${n}"] .round-download').click()`);
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
    await postJson(`${origin}/api/board`, { boardId: created.boardId, title: TITLE,
      blocks: [{ id: 'q6', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }] }] }, daemon.secret);
    const boardUrl = `${origin}${new URL(created.url).pathname}`;
    const downloads = scratchDir('cb-download-files-');

    const tall = await postJson(`${origin}/api/board`, { title: TALL_TITLE, blocks: TALL_ROUND_1 }, daemon.secret);
    await postJson(`${origin}/api/board/${tall.boardId}/submit`, { round: 1, action: 'send', answers: [],
      comments: TALL_PAGE_COMMENTS }, daemon.secret);
    await postJson(`${origin}/api/board`, { boardId: tall.boardId, title: TALL_TITLE, blocks: TALL_ROUND_2 }, daemon.secret);
    await postJson(`${origin}/api/board/${tall.boardId}/submit`, { round: 2, action: 'send',
      answers: [{ id: 'q7', status: 'answered', choice: 'Option 7', note: '' }], comments: TALL_COMMENTS }, daemon.secret);
    await postJson(`${origin}/api/board`, { boardId: tall.boardId, title: TALL_TITLE,
      blocks: [{ id: 'q8', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }] }] }, daemon.secret);
    const tallUrl = `${origin}${new URL(tall.url).pathname}`;

    await withChrome({ tag: 'cb-download', hideScrollbars: true }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const board = await openTab(send, onEvent, boardUrl, cookie, { width: 1280, height: 900, theme: 'dark',
        expr: `document.querySelector('.round-current').getAttribute('data-round')` });

      const open = await board.evalPage(`({ chips: !!document.querySelector('.round[data-round="2"] .round-chips'),
        download: document.querySelectorAll('.round[data-round="2"] .round-download').length })`);
      await row('an open round\'s chip line carries no Download round', () => {
        assert.equal(board.measured, '2', 'setup: the board opens on its open round');
        assert.equal(open.chips, true, 'setup: the open round has its chip line');
        assert.equal(open.download, 0);
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
      // A stage below the window's bottom reports nothing until it is scrolled to.
      await board.evalPage(`document.querySelector('[data-block-id="h3"]').scrollIntoView()`);
      await board.until(`document.querySelector('[data-block-id="h3"] iframe').__cbStageContentH >= ${WIDE_STAGE_PX}`, 'the wide stage reporting its height');

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

      const offline = async sp => { await sp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); };
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
      // An artifact round's report moves no box, so no DOM change re-reads an 'until': polled.
      const mockH = await tallTab.sp('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise(function (resolve) {
        var tries = 0;
        (function poll() {
          var h = document.querySelector('[data-block-id="h2"] iframe').__cbStageContentH;
          if (h || ++tries > 100) return resolve(h || 0);
          setTimeout(poll, 50);
        })();
      })` }).then(r => r.result.value);
      await tallTab.quiet();
      const page = await tallTab.evalPage(`(function () {
        function box(el) { var r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }
        var btn = document.querySelector('.round[data-round="1"] .round-download');
        var hit = btn && document.elementFromPoint((box(btn).left + box(btn).right) / 2, (box(btn).top + box(btn).bottom) / 2);
        return { btn: btn && box(btn), head: box(document.querySelector('.board-head')), hit: !!(hit && hit.closest('.round-download')) };
      })()`);
      await row('a sent artifact round, drawn full page, shows Download round under the header', note => {
        note(`header ends at ${page.head.bottom}, button ${page.btn && page.btn.top}..${page.btn && page.btn.bottom}`);
        assert.equal(tallTab.measured, '3', 'setup: the board opens on its open round');
        assert.ok(page.btn, 'the sent artifact round has the control');
        assert.ok(page.btn.top >= page.head.bottom - 0.5, 'below the header, not under it');
        assert.equal(page.hit, true, 'nothing covers it: a click lands on it');
      });

      const pageDownload = await downloadFrom(send, onEvent, tallTab, 1);
      await row('its Download round saves the artifact round as one HTML file, the mock at its full height', note => {
        note(`${pageDownload.files.join(', ')}; the artifact reported ${mockH}px`);
        assert.deepEqual(pageDownload.files, ['tall-fixture-round-1.html']);
        assert.ok(mockH >= TALL_MOCK_PX, 'setup: the board measured the whole artifact');
        assert.match(readFileSync(pageDownload.file, 'utf8'), new RegExp(`height: ${mockH + 2}px`), 'the frame is the artifact\'s own height');
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
      const tallDownload = await downloadFrom(send, onEvent, tallTab, 2);

      // Back on the artifact round, in a window too narrow for the header to condense:
      // the chip line stays drawn as the artifact scrolls under it.
      await tallTab.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await tallTab.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the flip back to the artifact round');
      await tallTab.sp('Emulation.setDeviceMetricsOverride', { width: 560, height: 800, deviceScaleFactor: 1, mobile: false });
      await tallTab.quiet();
      const buttonHit = `(function () {
        var chips = document.querySelector('.round-current .round-chips');
        var r = chips.querySelector('.round-download').getBoundingClientRect();
        var hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return { hit: !!(hit && hit.closest('.round-download')), opacity: getComputedStyle(chips).opacity,
          scrolled: document.body.classList.contains('stage-scrolled') };
      })()`;
      const narrowAtRest = await tallTab.evalPage(buttonHit);
      // The artifact is a frame of its own to the browser; this tab's is the only one open.
      const { targetInfos } = await send('Target.getTargets');
      for (const t of targetInfos.filter(t => t.type === 'iframe')) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await evalIn(send, sessionId, 'window.scrollTo(0, 200)');
      }
      await tallTab.until(`document.body.classList.contains('stage-scrolled')`, 'the artifact scrolling');
      const narrowScrolled = await tallTab.evalPage(buttonHit);
      await tallTab.close();
      await row('in a narrow window, where the chip line stays drawn over a scrolled artifact, its Download round still takes a click', () => {
        assert.deepEqual(narrowAtRest, { hit: true, opacity: '1', scrolled: false }, 'setup: at rest the control is drawn and live');
        assert.deepEqual(narrowScrolled, { hit: true, opacity: '1', scrolled: true });
      });

      // The board as a reader has it with no daemon behind it: opened from disk, read-only.
      const archive = copyArchive(path.join(daemon.home, 'pages'), tall.boardId, 'cb-download');
      const archived = await openTab(send, onEvent, archive.pageUrl, cookie, { width: 1280, height: 800, theme: 'dark',
        expr: `document.body.classList.contains('readonly')` });
      await archived.evalPage(`document.querySelector('.round-page[data-round="1"]').click()`);
      await archived.until(`document.body.classList.contains('page-board') && document.querySelector('.round[data-round="1"]').classList.contains('round-current')`, 'the archive\'s flip to the artifact round');
      await archived.quiet();
      const strip = await archived.evalPage(`(function () {
        var chips = document.querySelector('.round-current .round-chips');
        var mock = document.querySelector('.round-current iframe').getBoundingClientRect();
        var hit = document.elementFromPoint(mock.left + mock.width / 2, document.querySelector('.board-head').getBoundingClientRect().bottom + 12);
        return { chips: !!chips, height: chips ? chips.getBoundingClientRect().height : 0, overMock: !!(hit && hit.closest('.round-chips')) };
      })()`);
      await archived.close();
      await row('a read-only archive, which offers no Download round, draws no chip line over a sent artifact round', note => {
        note(`chip line ${strip.height}px tall`);
        assert.equal(archived.measured, true, 'setup: opened from disk, the board is read-only');
        assert.equal(strip.chips, true, 'setup: the sent artifact round carries its chip line');
        assert.deepEqual({ height: strip.height, overMock: strip.overMock }, { height: 0, overMock: false });
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
      await row('printed, a card taller than a page breaks only between its paragraphs, options and comments, each kept whole', note => {
        const items = printedTall.pieces.filter(p => p.what !== 'diagram');
        note(`pages per card: ${printedTall.cardPages.join(', ')}; ${items.length} paragraphs, options and comments`);
        assert.deepEqual(printedTall.cardPages.map(c => Number(c.split(' ')[1]) > 1), [true, true, true], 'setup: the text, the diagram\'s card and the question each run past a page');
        assert.equal(items.length, 72, 'setup: every paragraph, option and comment was found');
        assert.deepEqual(cutPieces(items), []);
      });
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
