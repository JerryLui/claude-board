// Real-browser check for Download round (src/round-export.mjs, src/ui.mjs's
// downloadRound): a sent question round offers it at the right end of its chip line (a
// round not yet sent, test/check-round-download.mjs); the file a sent round saves opens from disk with the network off and holds the
// board's title, the round's number and date, the decisions table first, every option
// with the pick marked, the diagram as SVG at full height, the mock at its full height
// with none of its scripts run, each comment under what it points at and every image as
// a data: URL, with no script anywhere in it; and under print media every card, diagram,
// stage and decisions row is kept whole and fits one page, a mock no taller than a page
// at its own size and a taller one scaled into its holder. A round not yet sent saves a
// file that opens on a Not sent line and marks each pick so far as unsent. Pull-out's
// Download saves the one mock or diagram it shows, alone, as a file that opens offline: a
// diagram as the picture the page drew, a mock as its own page (ADR.md entry 154), its
// scripts run, with the diagram library written in where it draws a diagram, under a
// policy that lets its script load no file off the disk it is opened from. A round
// drawn full page saves its one mock the same way. Two boards hold a mock that draws a
// diagram by its own script, each finding the library the way one of the two render
// templates does: saved, then opened from disk with the network off, each shows its
// diagram drawn and its own script's work, having reached for no address. A Download
// that cannot save (the board not handing over the diagram library, a full-page mock the
// tab does not hold) saves no file and says so under the control, which is live again.
// A second board holds what is
// taller than a printed page: a sent artifact round (drawn full page, its Download round
// in the top strip), a long text,
// a diagram, a question with many options, a long free-text answer under a long note and
// a long comment list; its question round's file is
// paginated under print media and nothing that must stay whole sits across a page's edge.
// The top strip's Download round is read over a scrolled artifact, where it stays drawn
// and takes its click, in a window too narrow for the header to condense, on a third
// board whose one artifact round was never sent, and in the board's
// archive opened from disk, which shows none. Over an awaited artifact scrolled under
// the condensed bar, light and dark, it is its icon alone between Comment and Theme. Layout, a real download and a file: page, none of which the DOM
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
// copies the saved files there, with the condensed bar's two shots.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionToken } from '../src/secret.mjs';
import { STAGE_MARGIN_RESET } from '../src/round-export.mjs';
import { MERMAID_SOURCE } from '../src/vendor/mermaid/index.mjs';
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
// Comments on the full-page mock, more than the board's rail shows at once: the round's
// saved file is the mock's own page and carries none of them.
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
// An awaited artifact, so the strip carries Comment beside Theme and Download round.
const ICON_TITLE = 'Icon fixture';
const ICON_ROUND_1 = [
  { id: 'h10', kind: 'html', html: '<div style="height:1800px;box-sizing:border-box;border:4px solid #3251c9;background:linear-gradient(#eef,#efe)">Icon mock</div>' },
];
// The fourth and fifth boards: a mock that draws a diagram by its own script. Each finds
// the diagram library the way one of the two render templates does, and notes in
// 'reached' every address it asks for one at. The first, in a question round, uses a
// library already on the window, else loads a file beside the page, else one off a CDN.
const DRAWN_TITLE = 'Drawn fixture';
const CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist';
const LOADER_MOCK = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Loader page</title>
<style>body { margin: 32px; font: 15px/1.5 system-ui, sans-serif; } figure { margin: 0; }</style>
</head><body>
<nav id="toc"></nav>
<h2 id="flow">The flow</h2>
<figure><pre class="mermaid">flowchart LR
  ask[Ask] --> pick[Pick]
  pick --> ship[Ship]</pre></figure>
<h2 id="quiz">The quiz</h2>
<button type="button" id="reveal">Reveal</button><p id="answer" hidden>Shipped</p>
<script>
var reached = [];
var MERMAID_SOURCES = ["assets/mermaid.min.js", "${CDN}/mermaid.min.js"];
var mermaidLoading = false;
function loadMermaid(i) {
  if (i >= MERMAID_SOURCES.length) { mermaidLoading = false; return; }
  var s = document.createElement("script");
  s.src = MERMAID_SOURCES[i];
  reached.push(MERMAID_SOURCES[i]);
  s.onload = function () { mermaidLoading = false; renderMermaidAll(); };
  s.onerror = function () { loadMermaid(i + 1); };
  document.head.appendChild(s);
}
function renderMermaidAll() {
  var engine = window.mermaid;
  if (!engine || !engine.run) {
    if (!mermaidLoading) { mermaidLoading = true; loadMermaid(0); }
    return;
  }
  engine.initialize({ startOnLoad: false, theme: "base" });
  engine.run({ nodes: document.querySelectorAll("pre.mermaid"), suppressErrors: true });
}
document.querySelectorAll("h2").forEach(function (h) {
  var a = document.createElement("a");
  a.href = "#" + h.id;
  a.textContent = h.textContent;
  document.getElementById("toc").appendChild(a);
});
document.getElementById("reveal").addEventListener("click", function () { document.getElementById("answer").hidden = false; });
renderMermaidAll();
</script></body></html>`;
// A mock that is a diagram's source and no script: on the board the board's stand-in draws
// it on load, saved the written-in library's own start does.
const BARE_MOCK = '<h2>Bare</h2><pre class="mermaid">flowchart LR\n  a[A] --> b[B]\n  b --> c[C]</pre>';
// A mock whose script, beside its own work, asks for a script and an image by file:
// address (reachMock below, once the two files exist): each load or refusal is noted in
// 'reach', with every refusal the page's policy reports.
const reachMock = (script, image) => `<p id="late"></p>
<pre class="mermaid">flowchart LR
  a[A] --> b[B]
  b --> c[C]</pre>
<script>
document.getElementById("late").textContent = "ran";
var reach = { script: "pending", image: "pending", refused: [] };
document.addEventListener("securitypolicyviolation", function (e) { reach.refused.push(e.effectiveDirective + " " + e.blockedURI); });
var s = document.createElement("script");
s.onload = function () { reach.script = window.__fromDisk ? "loaded" : "loaded, empty"; };
s.onerror = function () { reach.script = "refused"; };
s.src = ${JSON.stringify(script)};
document.head.appendChild(s);
var img = new Image();
img.onload = function () { reach.image = "loaded"; };
img.onerror = function () { reach.image = "refused"; };
img.src = ${JSON.stringify(image)};
window.mermaid.initialize({ startOnLoad: false });
window.mermaid.run({ nodes: document.querySelectorAll("pre.mermaid") });
</script>`;
const DRAWN_ROUND_1 = [
  { id: 'h6', kind: 'html', title: 'Loader page', html: LOADER_MOCK },
  { id: 'h8', kind: 'html', title: 'Bare diagram', html: BARE_MOCK },
  { id: 'q11', kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
];
// The second, drawn full page, mints its diagram's node from a source it carries and
// uses a library already on the window, else a file beside the page, else imports a
// module off the CDN.
const DRAWN_PAGE_TITLE = 'Drawn page fixture';
const IMPORTER_MOCK = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Importer page</title>
<style>body { margin: 0; padding: 32px; font: 15px/1.5 system-ui, sans-serif; }</style>
</head><body>
<nav id="toc"></nav>
<main id="hero"></main>
<button type="button" id="reveal">Reveal</button><p id="answer" hidden>Checked</p>
<section class="src" data-name="Map"><script type="text/plain">flowchart TD
  spec[Spec] --> build[Build]
  build --> check[Check]</script></section>
<script>
var reached = [];
let mermaidMod = null;
async function renderMermaid(root) {
  const nodes = root.querySelectorAll('pre.mermaid');
  if (!nodes.length) return;
  try {
    if (!mermaidMod) {
      if (!window.mermaid) {
        reached.push('assets/mermaid.min.js');
        await new Promise(res => {
          const s = document.createElement('script');
          s.src = 'assets/mermaid.min.js';
          s.onload = s.onerror = res;
          document.head.appendChild(s);
        });
      }
      if (!window.mermaid) reached.push('${CDN}/mermaid.esm.min.mjs');
      mermaidMod = window.mermaid || (await import('${CDN}/mermaid.esm.min.mjs')).default;
    }
    mermaidMod.initialize({ startOnLoad: false, theme: 'neutral' });
    await mermaidMod.run({ nodes, suppressErrors: true });
  } catch (e) { /* no library: the source stays */ }
}
document.querySelectorAll('section.src').forEach(function (src) {
  const a = document.createElement('a');
  a.textContent = src.dataset.name;
  document.getElementById('toc').appendChild(a);
  const holder = document.createElement('div');
  holder.innerHTML = '<pre class="mermaid"></pre>';
  holder.firstChild.textContent = src.querySelector('script').textContent;
  document.getElementById('hero').appendChild(holder);
});
document.getElementById('reveal').addEventListener('click', function () { document.getElementById('answer').hidden = false; });
renderMermaid(document);
</script></body></html>`;
const DRAWN_PAGE_ROUND_1 = [{ id: 'h7', kind: 'html', html: IMPORTER_MOCK }];
// What a saved mock opens with, ahead of its own source: a standards-mode, UTF-8 page
// under a policy that admits what the file holds and https: addresses and no file on the
// disk, with no page margin, as a stage is on the board.
const SAVED_HEAD = '<!DOCTYPE html>\n<meta charset="utf-8">\n'
  + '<meta http-equiv="Content-Security-Policy" content="default-src \'unsafe-inline\' https: data: blob:">\n'
  + STAGE_MARGIN_RESET + '\n';
const SAVED_LIBRARY = '<script>' + MERMAID_SOURCE + '</script>\n';
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

// A saved mock as opened, once each diagram in it is drawn and each file: address it asked
// for has loaded or been refused, or five seconds have passed:
// each diagram as its node count, or its source's first line where it is not drawn; the
// contents list its script built; whether its Reveal control, pressed here, showed its
// answer; each address the page asked for a diagram library at, and each the browser
// fetched; what an earlier script of its own wrote; what came of the file: addresses it
// asked for; and the page's own box.
const SAVED_PAGE_EXPR = `new Promise(function (resolve) {
  var tries = 0;
  (function poll() {
    var pres = [].slice.call(document.querySelectorAll('pre.mermaid'));
    var waiting = pres.some(function (p) { return !p.querySelector('svg'); })
      || (window.reach && (window.reach.script === 'pending' || window.reach.image === 'pending'));
    if (waiting && ++tries < 100) return setTimeout(poll, 50);
    var reveal = document.getElementById('reveal'), answer = document.getElementById('answer'), late = document.getElementById('late');
    if (reveal) reveal.click();
    var cs = getComputedStyle(document.body);
    resolve({
      diagrams: pres.map(function (p) {
        var svg = p.querySelector('svg');
        return svg ? svg.querySelectorAll('.node').length + ' nodes' : 'source: ' + p.textContent.trim().split('\\n')[0];
      }),
      contents: [].slice.call(document.querySelectorAll('#toc a')).map(function (a) { return a.textContent; }),
      revealed: answer ? !answer.hidden : null,
      reached: window.reached || null,
      fetched: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (n) { return !/^data:/.test(n); }),
      late: late ? late.textContent : null,
      reach: window.reach || null,
      text: document.body.textContent.trim().slice(0, 40),
      frames: document.querySelectorAll('iframe').length,
      height: document.documentElement.scrollHeight,
      pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      mode: document.compatMode,
    });
  })();
})`;

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

// One diagram's file as opened: its head, the one diagram it holds and whatever else of
// the round or the board came along.
const ONE_EXPR = `(function () {
  function texts(sel) { return [].slice.call(document.querySelectorAll(sel)).map(function (e) { return e.textContent.replace(/\\s+/g, ' ').trim(); }); }
  var svg = document.querySelector('pre.mermaid svg');
  return {
    meta: texts('.export-meta > span'),
    frames: document.querySelectorAll('iframe').length,
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
// The strip's drawn buttons, left to right, with Download round's and Theme's boxes,
// Download round's title, and whether a click at its middle lands on it.
const BAR_EXPR = `(function () {
  var named = { 'comment-mode-toggle': 'Comment', 'theme-toggle': 'Theme' };
  var drawn = [].slice.call(document.querySelectorAll('header.board-head .board-head-actions button')).map(function (b) {
    var r = b.getBoundingClientRect();
    return { name: b.classList.contains('head-download') ? 'Download' : named[b.id], left: r.left, w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(function (c) { return c.w > 0; }).sort(function (a, b) { return a.left - b.left; });
  function box(name) { var c = drawn.filter(function (d) { return d.name === name; })[0]; return c && { w: c.w, h: c.h }; }
  var btn = document.querySelector('header.board-head .head-download');
  var r = btn.getBoundingClientRect();
  var hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
  return { order: drawn.map(function (c) { return c.name; }), download: box('Download'), theme: box('Theme'),
    title: btn.getAttribute('title'), hit: !!(hit && hit.closest('.head-download')),
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
  // A press that saved nothing says why on the page: carried into the failure.
  const files = await done.catch(async err => {
    const said = await tab.evalPage(`[].slice.call(document.querySelectorAll('.download-note')).map(function (n) { return n.textContent; }).join(' | ')`).catch(() => '');
    throw new Error(`${err.message}${said ? `; the page said: ${said}` : ''} (${click})`);
  });
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

/** The accessible name Chrome computes for what `selector` picks on the tab's page. */
async function accessibleName(tab, selector) {
  const { root } = await tab.sp('DOM.getDocument', { depth: 0 });
  const { nodeId } = await tab.sp('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { nodes } = await tab.sp('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  return nodes[0]?.name?.value ?? null;
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

/** Opens a saved mock from disk under `prepare` (the network cut) and answers
 * SAVED_PAGE_EXPR's reading of it. */
async function openSaved(send, onEvent, file, cookie, prepare) {
  const tab = await openTab(send, onEvent, pathToFileURL(file).href, cookie, { width: 1280, height: 900, theme: 'dark', expr: '1', prepare });
  try {
    const r = await tab.sp('Runtime.evaluate', { expression: SAVED_PAGE_EXPR, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`the saved mock's read threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  } finally {
    await tab.close();
  }
}

/** A Download that saves nothing: presses `control` (a selector) on the open board tab,
 * waits for the control to be live again and answers what it then shows (`note` null where
 * it says nothing), with every file the press saved. */
async function failedDownload(send, tab, control) {
  const dir = scratchDir('cb-download-files-');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  await tab.evalPage(`document.querySelector(${JSON.stringify(control)}).click()`);
  await tab.until(`!document.querySelector(${JSON.stringify(control)}).disabled`, 'the pressed Download coming live again');
  const shown = await tab.evalPage(`(function () {
    var btn = document.querySelector(${JSON.stringify(control)}), note = btn.querySelector('.download-note');
    if (!note) return { note: null, label: btn.getAttribute('aria-label'), live: !btn.disabled, drawn: false, under: false };
    var r = note.getBoundingClientRect(), b = btn.getBoundingClientRect(), cs = getComputedStyle(note);
    return { note: note.textContent, label: btn.getAttribute('aria-label'), live: !btn.disabled,
      drawn: r.width > 0 && r.height > 0 && cs.visibility === 'visible' && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      under: r.top >= b.bottom && Math.abs(r.right - b.right) <= 1 };
  })()`);
  return { ...shown, files: readdirSync(dir) };
}

/** Whether the note of a Download that saved nothing is still under `control`. */
const noteGone = (tab, control) => tab.evalPage(`!document.querySelector(${JSON.stringify(control + ' .download-note')})`);

/** Blocks, on `tab`, every request whose address matches one of `urls`; none with []. */
const blockRequests = (tab, urls) => tab.sp('Network.setBlockedURLs', { urls });

const LENS_DOWNLOAD = 'dialog.stage-lens [data-lens="download"]';
const STRIP_DOWNLOAD = 'header.board-head .board-head-actions .head-download';

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
    const icon = await postJson(`${origin}/api/board`, { title: ICON_TITLE, wait: true, blocks: ICON_ROUND_1 }, daemon.secret);
    const iconUrl = `${origin}${new URL(icon.url).pathname}`;
    // Two files on the disk the saved mock is opened from, for its script to ask for.
    const disk = scratchDir('cb-download-disk-');
    writeFileSync(path.join(disk, 'other.js'), 'window.__fromDisk = true;');
    writeFileSync(path.join(disk, 'other.png'), Buffer.from(PNG.split(',')[1], 'base64'));
    const REACH_MOCK = reachMock(pathToFileURL(path.join(disk, 'other.js')).href, pathToFileURL(path.join(disk, 'other.png')).href);
    const drawn = await postJson(`${origin}/api/board`, { title: DRAWN_TITLE,
      blocks: [...DRAWN_ROUND_1.slice(0, 2), { id: 'h9', kind: 'html', title: 'Reaching page', html: REACH_MOCK }, ...DRAWN_ROUND_1.slice(2)] }, daemon.secret);
    const drawnUrl = `${origin}${new URL(drawn.url).pathname}`;
    const drawnPage = await postJson(`${origin}/api/board`, { title: DRAWN_PAGE_TITLE, blocks: DRAWN_PAGE_ROUND_1 }, daemon.secret);
    const drawnPageUrl = `${origin}${new URL(drawnPage.url).pathname}`;

    await withChrome({ tag: 'cb-download', hideScrollbars: true }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const board = await openTab(send, onEvent, boardUrl, cookie, { width: 1280, height: 900, theme: 'dark',
        expr: `document.querySelector('.round-current').getAttribute('data-round')` });

      const offline = async sp => { await sp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); };
      // The type of each blob the page hands the browser to save, in order.
      await board.evalPage(`(function () {
        var real = URL.createObjectURL;
        window.__savedTypes = [];
        URL.createObjectURL = function (blob) { window.__savedTypes.push(blob.type); return real.call(URL, blob); };
      })()`);

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
      const oneMock = await openSaved(send, onEvent, mockDownload.file, cookie, offline);
      const oneDiagram = await measureTab(send, onEvent, pathToFileURL(diagramDownload.file).href, cookie,
        { width: 1280, height: 900, theme: 'dark', expr: ONE_EXPR, prepare: offline });
      await row('Pull-out on a mock has a Download beside close, which saves the mock alone as its own page: its source under a head of its own, its script run when opened offline', note => {
        const bytes = readFileSync(mockDownload.file, 'utf8');
        note(`${mockBar.join(' | ')}; ${mockDownload.files.join(', ')}, ${bytes.length} bytes; its script wrote "${oneMock.late}"`);
        assert.deepEqual(mockBar.slice(-2), ['download', 'close']);
        assert.deepEqual(mockDownload.files, ['download-fixture-round-1-mock-h1.html']);
        assert.ok(bytes === SAVED_HEAD + ROUND_1.find(b => b.id === 'h1').html, 'the mock\'s source as posted: no diagram, so no library, and nothing of the board\'s');
        assert.equal(oneMock.late, 'ran', 'its own script ran');
        assert.deepEqual({ frames: oneMock.frames, mode: oneMock.mode, fetched: oneMock.fetched }, { frames: 0, mode: 'CSS1Compat', fetched: [] },
          'the page itself, in standards mode as on the board, nothing fetched');
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
        assert.deepEqual({ scripts: oneDiagram.scripts, controls: oneDiagram.controls, fetched: oneDiagram.fetched, rest: oneDiagram.rest },
          { scripts: 0, controls: 0, fetched: [], rest: 0 }, 'no script, no control, nothing fetched, nothing else of the round');
      });

      await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
      const done = waitForDownload(onEvent, downloads);
      await board.evalPage(`document.querySelector('.round[data-round="1"] .round-download').click()`);
      const files = await done;
      const savedTypes = await board.evalPage('window.__savedTypes');
      await board.close();
      await row('a mock\'s own file is handed to the browser as plain bytes, so its address saves and draws no page at the board\'s origin, and it still saves under its .html name and opens as a page; a round\'s file and a diagram\'s stay text/html', note => {
        note(savedTypes.join(' | '));
        assert.deepEqual(savedTypes, ['text/html;charset=utf-8', 'application/octet-stream', 'text/html;charset=utf-8', 'text/html;charset=utf-8'],
          'the unsent round, the mock, the diagram, the sent round');
        assert.deepEqual(mockDownload.files, ['download-fixture-round-1-mock-h1.html']);
        assert.deepEqual({ late: oneMock.late, mode: oneMock.mode }, { late: 'ran', mode: 'CSS1Compat' }, 'opened from disk it is a page, its script run');
      });

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
      const railComments = await tallTab.evalPage(`[].slice.call(document.querySelectorAll('.round-current .page-comments .comment-item')).length`);
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
      await row('once the artifact has scrolled under the header, the strip\'s Download round is still drawn and its click still saves the mock as its own page', note => {
        note(scrolledDownload.files.join(', '));
        assert.deepEqual(stripScrolled, { hit: true, drawn: true, inWindow: true, scrolled: true });
        assert.deepEqual(scrolledDownload.files, ['tall-fixture-round-1.html']);
      });

      const mockBand = await evalIn(send, tallFrame, BAND_EXPR);
      const pageDownload = await downloadFrom(send, onEvent, tallTab, STRIP_CLICK);
      const pageFile = await openSaved(send, onEvent, pageDownload.file, cookie, offline);
      await row('a sent full-page mock round\'s Download saves the mock as its own page, as tall as the mock, with none of the room the board pads it by and none of the comments made on it', note => {
        const bytes = readFileSync(pageDownload.file, 'utf8');
        note(`${pageDownload.files.join(', ')}, ${bytes.length} bytes; the artifact is ${TALL_MOCK_PX}px tall, padded ${mockBand}px on the board under ${railComments} comments; the file's page is ${pageFile.height}px tall, padded ${pageFile.pad}px`);
        assert.deepEqual(pageDownload.files, ['tall-fixture-round-1.html']);
        assert.ok(mockBand > 0, 'setup: the board pads the artifact for its own chrome');
        assert.equal(railComments, TALL_PAGE_COMMENTS.length, 'setup: the board lists the comments made on the mock');
        assert.ok(bytes === SAVED_HEAD + TALL_ROUND_1[0].html, 'the mock\'s source as posted, and nothing of the board\'s: no comment, no stage script');
        assert.deepEqual({ height: pageFile.height, pad: pageFile.pad, frames: pageFile.frames }, { height: TALL_MOCK_PX, pad: 0, frames: 0 });
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
      // Measured with the reader at its end. A measure that took the board's padding
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
      // The mock held, as a push leaves a stage this tab does not hold: no source in the
      // frame until the page is read for it. First with that read refused, then allowed.
      await shownTab.evalPage(`(function () {
        var frame = document.querySelector('.round-current iframe.html-stage');
        frame.setAttribute('data-held', '');
        frame.removeAttribute('srcdoc');
      })()`);
      await blockRequests(shownTab, ['*stages=*']);
      const heldRefused = await failedDownload(send, shownTab, STRIP_DOWNLOAD);
      await blockRequests(shownTab, []);
      const heldDownload = await downloadFrom(send, onEvent, shownTab, STRIP_CLICK);
      const heldAfter = await shownTab.evalPage(`(function () {
        var frame = document.querySelector('.round-current iframe.html-stage');
        return { held: frame.hasAttribute('data-held'), noteGone: !document.querySelector('.head-download .download-note'),
          label: document.querySelector('.head-download').getAttribute('aria-label'), text: document.querySelector('.head-download').textContent.trim() };
      })()`);
      heldAfter.name = await accessibleName(shownTab, '.head-download');
      await shownTab.close();
      const shownFile = await openSaved(send, onEvent, shownDownload.file, cookie, offline);
      await row('an artifact round never sent shows the same Download round in the top strip, at rest and scrolled, and it saves the mock as its own page', note => {
        note(shownDownload.files.join(', '));
        assert.equal(shownTab.measured, 'open', 'setup: drawn full page, and not sent');
        assert.deepEqual(shownAtRest, { hit: true, drawn: true, inWindow: true, scrolled: false });
        assert.deepEqual(shownScrolled, { hit: true, drawn: true, inWindow: true, scrolled: true });
        assert.deepEqual(shownDownload.files, ['shown-fixture-round-1.html']);
        assert.deepEqual({ text: shownFile.text, frames: shownFile.frames }, { text: 'Shown mock', frames: 0 }, 'the mock as its own page');
      });

      await row('a full-page mock the tab does not hold, its read refused, saves no file: Download round says so under itself and is live again', note => {
        note(`${heldRefused.note} | files: ${heldRefused.files.join(', ') || 'none'}`);
        assert.deepEqual(heldRefused.files, []);
        assert.match(String(heldRefused.note), /did not load, so nothing was saved/);
        assert.equal(heldRefused.label, heldRefused.note, 'the control\'s own label says the same');
        assert.deepEqual({ live: heldRefused.live, drawn: heldRefused.drawn, under: heldRefused.under }, { live: true, drawn: true, under: true });
      });
      await row('pressed again with the read allowed, Download round reads the held mock in, saves it as its own page and says nothing more', note => {
        note(heldDownload.files.join(', '));
        assert.deepEqual(heldDownload.files, ['shown-fixture-round-1.html']);
        assert.ok(readFileSync(heldDownload.file, 'utf8') === SAVED_HEAD + SHOWN_ROUND_1[0].html, 'the mock\'s source as posted');
        assert.deepEqual(heldAfter, { held: false, noteGone: true, label: null, text: 'Download round', name: 'Download round' });
      });

      // The condensed rules hold no size, order or icon that depends on the theme: dark is
      // drawn only for its evidence shot.
      const bars = {};
      for (const theme of process.env.CLAUDE_BOARD_DOWNLOAD_KEEP ? ['light', 'dark'] : ['light']) {
        const iconTab = await openTab(send, onEvent, iconUrl, cookie, { width: 1280, height: 800, theme,
          expr: `document.body.classList.contains('page-board') && !document.body.classList.contains('page-uncommentable')` });
        await reportedHeight(iconTab, 'h10');
        await iconTab.quiet();
        const atRest = await iconTab.evalPage(BAR_EXPR);
        await evalIn(send, await artifactSession(send, 'Icon mock'), 'window.scrollTo(0, 400)');
        await iconTab.until(`document.body.style.getPropertyValue('--stage-p') === '1.000'`, 'the header fully condensed');
        await iconTab.quiet();
        const condensed = await iconTab.evalPage(BAR_EXPR);
        condensed.name = await accessibleName(iconTab, 'header.board-head .head-download');
        let shot = null;
        if (process.env.CLAUDE_BOARD_DOWNLOAD_KEEP) {
          const clip = await iconTab.evalPage(`(function () {
            var a = document.querySelector('header.board-head .back-to-index').getBoundingClientRect();
            var b = document.querySelector('header.board-head .board-head-actions').getBoundingClientRect();
            var h = document.querySelector('header.board-head').getBoundingClientRect();
            return { x: Math.max(0, a.left - 32), y: 0, width: b.right - a.left + 64, height: h.bottom + 16, scale: 2 };
          })()`);
          shot = path.join(process.env.CLAUDE_BOARD_DOWNLOAD_KEEP, `condensed-bar-${theme}.png`);
          writeFileSync(shot, Buffer.from((await iconTab.sp('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
        }
        await iconTab.sp('Emulation.setDeviceMetricsOverride', { width: 560, height: 800, deviceScaleFactor: 1, mobile: false });
        await iconTab.quiet();
        const narrow = await iconTab.evalPage(BAR_EXPR);
        await iconTab.close();
        bars[theme] = { atRest, condensed, narrow, shot };
      }
      {
        const { atRest, condensed, narrow } = bars.light;
        const shots = Object.values(bars).map(b => b.shot).filter(Boolean);
        await row('over a scrolled full-page mock the condensed bar draws Download round as its icon alone, between Comment and Theme, named "Download round"', note => {
          note(`at rest ${atRest.order.join(', ')}, Download ${atRest.download.w}x${atRest.download.h}; condensed ${condensed.order.join(', ')}, Download ${condensed.download.w}x${condensed.download.h}, Theme ${condensed.theme.w}x${condensed.theme.h}${shots.length ? `; ${shots.join(', ')}` : ''}`);
          assert.deepEqual(atRest.order, ['Comment', 'Theme', 'Download'], 'the full header keeps it after Theme');
          assert.ok(atRest.download.w > atRest.theme.w + 40, 'with its label');
          assert.equal(condensed.scrolled, true, 'setup: the artifact scrolled under the header');
          assert.deepEqual(condensed.order, ['Comment', 'Download', 'Theme']);
          assert.deepEqual(condensed.download, condensed.theme, 'the box of the icon-only Theme beside it');
          assert.deepEqual({ name: condensed.name, title: condensed.title, hit: condensed.hit }, { name: 'Download round', title: 'Download round', hit: true });
        });
        await row('in a window too narrow for the header to condense, a scrolled mock\'s Download round keeps its label after Theme', () => {
          assert.equal(narrow.scrolled, true, 'setup: still scrolled');
          assert.deepEqual(narrow.order, ['Comment', 'Theme', 'Download']);
          assert.ok(narrow.download.w > narrow.theme.w + 40);
        });
      }

      // A mock that draws a diagram by its own script, saved from its Pull-out in a question round.
      const drawnTab = await openTab(send, onEvent, drawnUrl, cookie, { width: 1280, height: 900, theme: 'dark',
        expr: `document.querySelector('.round-current').getAttribute('data-round')` });
      await drawnTab.evalPage(`document.querySelector('[data-block-id="h6"] .pull-out').click()`);
      await drawnTab.until(`document.querySelector('dialog.stage-lens[open] iframe')`, 'the diagram-drawing mock pulled out');
      // First with the board not handing over its diagram library, then with it.
      await blockRequests(drawnTab, ['*/mermaid-*.js']);
      const libraryRefused = await failedDownload(send, drawnTab, LENS_DOWNLOAD);
      await blockRequests(drawnTab, []);
      const loaderDownload = await downloadFrom(send, onEvent, drawnTab, `document.querySelector('${LENS_DOWNLOAD}').click()`);
      const libraryNoteGone = await noteGone(drawnTab, LENS_DOWNLOAD);
      const pullOutAndSave = async (id, what) => {
        // Until the dialog's own 'close' has been heard: it lands a task after the press, and
        // the page tears the lens down on it, a lens opened again meanwhile included.
        await drawnTab.sp('Runtime.evaluate', { awaitPromise: true, expression: `new Promise(function (resolve) {
          document.querySelector('dialog.stage-lens').addEventListener('close', function () { setTimeout(resolve, 0); }, { once: true });
          document.querySelector('dialog.stage-lens [data-lens="close"]').click();
        })` });
        await drawnTab.evalPage(`document.querySelector('[data-block-id="${id}"] .pull-out').click()`);
        await drawnTab.until(`document.querySelector('dialog.stage-lens[open] iframe')`, `${what} pulled out`);
        return downloadFrom(send, onEvent, drawnTab, `document.querySelector('${LENS_DOWNLOAD}').click()`);
      };
      const bareDownload = await pullOutAndSave('h8', 'the bare diagram');
      const reachDownload = await pullOutAndSave('h9', 'the reaching mock');
      await drawnTab.close();
      const bareFile = await openSaved(send, onEvent, bareDownload.file, cookie, offline);
      const reachFile = await openSaved(send, onEvent, reachDownload.file, cookie, offline);
      await row('with the board not handing over its diagram library, Download on a diagram-drawing mock\'s Pull-out saves no file, says so under itself and is live again; pressed again once the library is back, it saves and the note is gone', note => {
        note(`${libraryRefused.note} | files: ${libraryRefused.files.join(', ') || 'none'}`);
        assert.deepEqual(libraryRefused.files, []);
        assert.match(String(libraryRefused.note), /diagram library, so nothing was saved/);
        assert.equal(libraryRefused.label, libraryRefused.note, 'the control\'s own label says the same');
        assert.deepEqual({ live: libraryRefused.live, drawn: libraryRefused.drawn, under: libraryRefused.under }, { live: true, drawn: true, under: true });
        assert.deepEqual(loaderDownload.files, ['drawn-fixture-round-1-mock-h6.html']);
        assert.equal(libraryNoteGone, true);
      });
      await row('a saved mock\'s script that asks for a script and an image by file: address loads neither, while its own inline script ran and its diagram is drawn, nothing else asked for', note => {
        const r = reachFile.reach || {};
        note(`script ${r.script}, image ${r.image}; refused: ${(r.refused || []).join(', ') || 'nothing'}; diagrams: ${reachFile.diagrams.join(', ')}; fetched: ${reachFile.fetched.join(', ') || 'nothing'}`);
        assert.deepEqual({ script: r.script, image: r.image }, { script: 'refused', image: 'refused' }, 'neither file on the disk loads');
        assert.deepEqual((r.refused || []).map(line => line.split(' ')[0]).sort(), ['img-src', 'script-src-elem'], 'each refused by the file\'s own policy');
        assert.ok(readFileSync(reachDownload.file, 'utf8') === SAVED_HEAD + SAVED_LIBRARY + REACH_MOCK, 'the policy ahead of the library, then the mock as posted');
        // The browser lists a refused address among the page's requests too.
        assert.deepEqual({ late: reachFile.late, diagrams: reachFile.diagrams, fetched: reachFile.fetched.filter(url => !url.startsWith(pathToFileURL(disk).href)) },
          { late: 'ran', diagrams: ['3 nodes'], fetched: [] }, 'its own script ran and its diagram is drawn from the library written in');
      });
      await row('a mock that is a diagram\'s source and no script, saved from its Pull-out and opened offline, is drawn by the written-in library\'s own start, nothing fetched', note => {
        note(`${bareDownload.files.join(', ')}; diagrams: ${bareFile.diagrams.join(', ') || 'none'}`);
        assert.deepEqual(bareDownload.files, ['drawn-fixture-round-1-mock-h8.html']);
        assert.ok(readFileSync(bareDownload.file, 'utf8') === SAVED_HEAD + SAVED_LIBRARY + BARE_MOCK, 'the head, the library, the diagram\'s source: no script of the board\'s');
        assert.deepEqual({ diagrams: bareFile.diagrams, fetched: bareFile.fetched, frames: bareFile.frames }, { diagrams: ['3 nodes'], fetched: [], frames: 0 });
      });
      const loaderFile = await openSaved(send, onEvent, loaderDownload.file, cookie, offline);
      const savedLine = (download, file) => `${download.files.join(', ')}, ${readFileSync(download.file, 'utf8').length} bytes; diagrams: ${file.diagrams.join(', ') || 'none'}; contents: ${file.contents.join(', ') || 'none'}; reached for: ${(file.reached || []).join(', ') || 'nothing'}`;
      await row('a mock that draws a diagram, saved from its Pull-out and opened offline, shows the diagram drawn, its contents list filled and its control live, having asked no address for the library', note => {
        note(savedLine(loaderDownload, loaderFile));
        assert.deepEqual(loaderDownload.files, ['drawn-fixture-round-1-mock-h6.html']);
        assert.deepEqual(loaderFile.diagrams, ['3 nodes'], 'drawn by the mock\'s own script');
        assert.deepEqual(loaderFile.contents, ['The flow', 'The quiz']);
        assert.equal(loaderFile.revealed, true, 'its Reveal control answers a click');
        assert.deepEqual({ reached: loaderFile.reached, fetched: loaderFile.fetched, frames: loaderFile.frames }, { reached: [], fetched: [], frames: 0 });
      });
      await row('that file is the mock\'s source as posted, under the board\'s diagram library written in as one script, and nothing else', () => {
        assert.ok(readFileSync(loaderDownload.file, 'utf8') === SAVED_HEAD + SAVED_LIBRARY + LOADER_MOCK,
          'the head, the vendored library whole in one script, then the mock: no script of the board\'s, no address of its daemon');
      });

      // The same from the top strip of a round drawn full page.
      const drawnPageTab = await openTab(send, onEvent, drawnPageUrl, cookie, { width: 1280, height: 800, theme: 'dark',
        expr: `document.body.classList.contains('page-board')` });
      const importerDownload = await downloadFrom(send, onEvent, drawnPageTab, STRIP_CLICK);
      await drawnPageTab.close();
      const importerFile = await openSaved(send, onEvent, importerDownload.file, cookie, offline);
      await row('a full-page mock that mints its diagram and would import the library, saved from the top strip and opened offline, shows it drawn the same way', note => {
        note(savedLine(importerDownload, importerFile));
        assert.equal(drawnPageTab.measured, true, 'setup: the mock is drawn full page');
        assert.deepEqual(importerDownload.files, ['drawn-page-fixture-round-1.html']);
        assert.deepEqual(importerFile.diagrams, ['3 nodes'], 'drawn by the mock\'s own script');
        assert.deepEqual(importerFile.contents, ['Map']);
        assert.equal(importerFile.revealed, true, 'its Reveal control answers a click');
        assert.deepEqual({ reached: importerFile.reached, fetched: importerFile.fetched, frames: importerFile.frames }, { reached: [], fetched: [], frames: 0 });
        assert.ok(readFileSync(importerDownload.file, 'utf8') === SAVED_HEAD + SAVED_LIBRARY + IMPORTER_MOCK, 'the head, the library, then the mock');
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
