// Real-browser check for Download round (src/round-export.mjs, src/ui.mjs's
// downloadRound): a sent round offers it at the right end of its chip line and an open
// round does not; the file it saves opens from disk with the network off and holds the
// board's title, the round's number and date, the decisions table first, every option
// with the pick marked, the diagram as SVG at full height, the mock at its full height
// with none of its scripts run, each comment under what it points at and every image as
// a data: URL, with no script anywhere in it; and under print media every card, diagram,
// stage and decisions row is kept whole and fits one page. Layout, a real download and a
// file: page, none of which the DOM stand-in has (test/check-round-download.mjs holds
// the markup).
//
// The pasted images a round carries are whatever <img> it draws, so the fixture adds two
// to the drawn round before the download: one from a blob: URL (pixels the page may
// read back) and one off another host (pixels it may not).
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-download.mjs
//
// Without Chrome it prints a skip line and exits 0. CLAUDE_BOARD_DOWNLOAD_KEEP=<dir>
// copies the saved file there.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionToken } from '../src/secret.mjs';
import { exportDate } from '../src/round-export.mjs';
import { runMain, skipFile, withTimeout } from './support.mjs';
import { CHROME, guardRun, openTab, postJson, row, scratchDir, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-download', `browser-check-download: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-download', { deadlineMs: 180000 });

const TITLE = 'Download fixture';
const STAGE_PX = 760; // past the board's 600px stage cap, so the page folds it and the file must not
const PRINT_W = 739; // Letter less Chrome's default 0.4in margins, at 96px an inch
const PRINT_H = 979;

const ROUND_1 = [
  { id: 'd1', kind: 'markdown', text: '# Scope\n\nWhat this round settles.' },
  { id: 'm1', kind: 'mermaid', text: 'flowchart TD\n  ask[Ask] --> pick[Pick]\n  pick --> build[Build]\n  build --> ship[Ship]' },
  { id: 'h1', kind: 'html', title: 'Mock',
    html: `<div style="height:${STAGE_PX}px;box-sizing:border-box;border:4px solid #3251c9;background:#eef">Static mock</div><div id="late"></div><script>document.getElementById('late').textContent = 'ran';</script>` },
  { id: 'q1', kind: 'question', prompt: 'Which way?', widget: 'single',
    options: [{ label: 'Yes', description: 'go now' }, { label: 'No', description: 'not yet' }, { label: 'Later' }] },
  { id: 'q2', kind: 'question', prompt: 'Which parts?', widget: 'multi', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
  { id: 'q3', kind: 'question', prompt: 'Say why', widget: 'text' },
  { id: 'q4', kind: 'question', prompt: 'Order them', widget: 'rank', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] },
  { id: 'q5', kind: 'question', prompt: 'Park this?', widget: 'single', options: [{ label: 'Park' }, { label: 'Keep' }] },
];
const ANSWERS = [
  { id: 'q1', status: 'answered', choice: 'No', note: 'Hold for review' },
  { id: 'q2', status: 'answered', choice: ['A', 'C'], note: '' },
  { id: 'q3', status: 'answered', choice: 'Free text answer', note: '' },
  { id: 'q4', status: 'answered', choice: ['Z', 'X', 'Y'], note: '' },
  { id: 'q5', status: 'deferred', choice: null, note: '' },
];
const COMMENTS = [
  { blockId: 'm1', anchor: { kind: 'block' }, text: 'Diagram comment' },
  { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'pick' }, text: 'Pick node comment' },
  { blockId: 'h1', anchor: { kind: 'block' }, text: 'Mock comment' },
];

// A 3x2 red PNG: the bytes behind the fixture's blob: image.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAxMAAAA8kAgFzQfa2AAAAAElFTkSuQmCC';

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
    images: imgs.map(function (i) { return { data: /^data:image\\//.test(i.getAttribute('src') || ''), loaded: i.complete && i.naturalWidth > 0 }; }),
    missing: texts('.export-missing'),
    scripts: document.scripts.length,
    controls: document.querySelectorAll('button, textarea, input, form, .pin-layer, .round-download').length,
    fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return !/^data:/.test(n); }),
  };
})()`;

// Under print media at a printed page's width: every piece that must not be cut, with
// whether it asks to be kept whole and how tall it is.
const PRINT_EXPR = `(function () {
  return [].slice.call(document.querySelectorAll('section.export-round .block, section.export-round pre.mermaid, section.export-round .stage-wrap, table.export-decisions tr')).map(function (el) {
    return { what: (el.getAttribute('data-block-id') || el.className || el.tagName).toString().slice(0, 40),
      avoid: getComputedStyle(el).breakInside, height: el.getBoundingClientRect().height };
  });
})()`;

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
    await postJson(`${origin}/api/board`, { boardId: created.boardId, title: TITLE,
      blocks: [{ id: 'q6', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }] }] }, daemon.secret);
    const boardUrl = `${origin}${new URL(created.url).pathname}`;
    const downloads = scratchDir('cb-download-files-');

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

      // The fixture's images, drawn into the sent round's markdown card.
      await board.evalPage(`(function () {
        var bytes = Uint8Array.from(atob('${PNG_B64}'), function (c) { return c.charCodeAt(0); });
        var card = document.querySelector('[data-block-id="d1"]');
        var local = document.createElement('img');
        local.alt = 'pasted';
        local.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        var remote = document.createElement('img');
        remote.alt = 'elsewhere';
        remote.src = 'http://images.invalid/elsewhere.png';
        card.appendChild(local);
        card.appendChild(remote);
      })()`);
      await board.until(`document.querySelector('[data-block-id="d1"] img').naturalWidth > 0`, 'the blob: image loading');
      // The stage reports its own height a frame or two after it lays out.
      const stageH = await board.until(`document.querySelector('[data-block-id="h1"] iframe').__cbStageContentH`, 'the stage reporting its height');

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
        assert.deepEqual(m.meta, ['Round 1', `Sent ${exportDate(new Date().toISOString())}`]);
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

      await row('the round\'s images ride inline: one the page drew as a data: URL, one off another host named in its place', () => {
        assert.deepEqual(m.images, [{ data: true, loaded: true }]);
        assert.deepEqual(m.missing, ['Image not included: elsewhere']);
        assert.equal(m.scripts, 0);
      });

      await saved.sp('Emulation.setEmulatedMedia', { media: 'print', features: [] });
      await saved.sp('Emulation.setDeviceMetricsOverride', { width: PRINT_W, height: PRINT_H, deviceScaleFactor: 1, mobile: false });
      const pieces = await saved.evalPage(PRINT_EXPR);
      await saved.close();
      await row('printed, no card, diagram, stage or decisions row is cut across pages', note => {
        note(`${pieces.length} pieces, tallest ${Math.max(...pieces.map(p => Math.round(p.height)))}px of a ${PRINT_H}px page`);
        assert.ok(pieces.length >= 14, 'setup: the cards, the diagram, the stage and the rows were found');
        const cut = pieces.filter(p => p.avoid !== 'avoid' || p.height > PRINT_H).map(p => `${p.what}: ${p.avoid}, ${Math.round(p.height)}px`);
        assert.deepEqual(cut, []);
      });
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
