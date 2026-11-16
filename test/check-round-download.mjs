// Download round's markup and the pure half of the file it saves (src/round-export.mjs).
// The control sits at the right end of a question round's chip line, sent or not, rendered
// by src/render.mjs and left live by src/ui.mjs's markRoundHistory when a round goes sent
// under an open tab. A round drawn full page has no chip line: its control is the one in the
// top strip. The decisions table's pick text per widget, the Not sent line an unsent round's
// file opens on, the file of one diagram, and the file's head escaped so no title or
// stylesheet text can open a script, and how far a printed page's height shrinks a mock. A
// mock saved alone is its own page (ADR.md entry 154): its source read back out of its stage
// as the stage holds it, under a head of its own whose policy admits no file on the reader's
// disk, with the diagram library written in where it draws a diagram; the page's own script
// saves that text from a mock's Pull-out and from a round drawn full page, and saves nothing
// in an archive. The saved file itself, opened, its layout and its print are
// test/browser-check-download.mjs's, run by hand.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit, abandonOpenRounds } from '../src/board.mjs';
import { renderBoardPage, buildStageSrcdoc, stageMermaidPrelude } from '../src/render.mjs';
import { buildRoundPushPayload } from '../src/server.mjs';
import { decisionRows, exportDocument, exportFileName, printScale, stageOwnSource, mockDocument, STAGE_MARGIN_RESET } from '../src/round-export.mjs';
import { MERMAID_ASSET, MERMAID_SOURCE } from '../src/vendor/mermaid/index.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';
import { check, finish, flush, pageHarness, waitFor } from './support.mjs';

const { loadBoard, loadBoardWithEventSource } = await pageHarness();

const Q1 = { kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const Q2 = { kind: 'question', prompt: 'Q2: pick another', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] };

const lastChild = el => el.children[el.children.length - 1];
const downloadsIn = (document, n) => document.querySelectorAll(`.round[data-round="${n}"] .round-download`);
const texts = (document, sel) => document.querySelectorAll(sel).map(el => el.textContent.trim());

check('a question round\'s chip line ends in Download round, live, whether the round is sent, abandoned or still open', () => {
  const board = createBoard({ title: 'Download - markup', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  abandonOpenRounds(board);
  addRound(board, { blocks: [{ ...Q2, prompt: 'Q3: still open' }] });
  assert.deepEqual(board.rounds.map(r => r.status), ['sent', 'abandoned', 'open'], 'setup: one round in each state');
  const document = parseHTML(renderBoardPage(board));

  for (const [n, state] of [[1, 'sent'], [2, 'abandoned'], [3, 'open']]) {
    const chips = document.querySelector(`.round[data-round="${n}"] .round-chips`);
    assert.ok(chips, `the ${state} round has its chip line`);
    const btn = lastChild(chips);
    assert.equal(btn.tagName, 'BUTTON', state);
    assert.equal(btn.className, 'round-download', state);
    assert.equal(btn.textContent.trim(), 'Download round', state);
    assert.equal(btn.hasAttribute('disabled'), false, `${state}: live, whatever the round's answers are`);
    assert.equal(downloadsIn(document, n).length, 1, state);
  }
});

check('a round open under the page\'s script, the same round gone sent under the open tab and the round pushed after it each keep one Download round at the right end of the chip line, live', () => {
  const board = createBoard({ title: 'Download - live', blocks: [Q1] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  // The round's one control, at the right end of its chip line, live, once the
  // page's own script has run over it.
  const liveAtTheEnd = (n, why) => {
    const live = downloadsIn(document, n);
    assert.equal(live.length, 1, why);
    assert.equal(lastChild(live[0].parentElement), live[0], `${why}: at the right end of the chip line`);
    assert.equal(live[0].textContent.trim(), 'Download round', why);
    assert.equal(live[0].disabled, false, `${why}: live`);
  };
  liveAtTheEnd(1, 'the round still open');

  // A new round's push, marking round 1 sent (src/ui.mjs's markRoundHistory).
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 2, 'new-round', [])));

  assert.equal(document.querySelector('.round[data-round="1"]').getAttribute('data-round-status'), 'sent', 'setup: round 1 went sent');
  liveAtTheEnd(1, 'the sent round, whose other controls go disabled');
  liveAtTheEnd(2, 'the round that just opened');
});

check('a round drawn full page draws no chip line, open, rendered sent or gone sent live: its Download round is the one in the top strip\'s controls', () => {
  const MOCK = { kind: 'html', html: '<div>Mock</div>' };
  const board = createBoard({ title: 'Download - page', blocks: [MOCK] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  const before = parseHTML(renderBoardPage(board));
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 2, 'new-round', [])));
  const rendered = parseHTML(renderBoardPage(board));
  for (const [how, doc] of [['open', before], ['rendered sent', rendered], ['gone sent under an open tab', document]]) {
    assert.equal(doc.querySelectorAll('.round[data-round="1"] .round-chips').length, 0, `${how}: no chip line over the artifact`);
    assert.equal(downloadsIn(doc, 1).length, 0, `${how}: none inside the round`);
    const inStrip = doc.querySelectorAll('header.board-head .board-head-actions button.head-download');
    assert.equal(inStrip.length, 1, `${how}: one control in the top strip's controls`);
    assert.equal(doc.querySelectorAll('.head-download').length, 1, `${how}: and nowhere else`);
    assert.equal(inStrip[0].textContent.trim(), 'Download round', how);
    assert.equal(inStrip[0].hasAttribute('disabled'), false, how);
  }
});

const FILE = { title: 'Board', roundN: 2, roundTitle: 'Density', css: '', exportCss: '', contentHtml: '<p>drawn</p>' };

check('an unsent round\'s file opens on a Not sent line and heads its picks as unsent; a sent round\'s file, and one whose round asked nothing, carry no such line', () => {
  const rows = [{ question: 'Density?', pick: 'Compact', note: '' }];
  const unsent = parseHTML(exportDocument({ ...FILE, unsent: true, sentDate: '', rows }));
  const first = unsent.querySelector('main.export-doc').children[0];
  assert.equal(first.className, 'export-unsent-note', 'the first thing in the file');
  assert.equal(first.textContent, 'Not sent: these picks are a draft, not a decision.');
  assert.deepEqual(texts(unsent, '.export-meta span'), ['Round 2 · Density', 'Not sent']);
  assert.deepEqual(texts(unsent, 'h2.export-section'), ['Picks so far, not sent', 'Round content']);
  assert.deepEqual(texts(unsent, 'th'), ['Question', 'Pick, unsent', 'Note']);
  assert.ok(unsent.querySelector('section.export-round').classList.contains('export-unsent'), 'the round\'s content is marked unsent, for its picked options');

  const sent = parseHTML(exportDocument({ ...FILE, sentDate: '2026-11-11', rows }));
  assert.equal(sent.querySelectorAll('.export-unsent-note, .export-unsent').length, 0);
  assert.deepEqual(texts(sent, '.export-meta span'), ['Round 2 · Density', 'Sent 2026-11-11']);
  assert.deepEqual(texts(sent, 'h2.export-section'), ['Decisions', 'Round content']);
  assert.deepEqual(texts(sent, 'th'), ['Question', 'Pick', 'Note']);

  const shown = parseHTML(exportDocument({ ...FILE, unsent: true, sentDate: '', rows: [] }));
  assert.equal(shown.querySelectorAll('.export-unsent-note, .export-unsent').length, 0, 'nothing was asked, so nothing is a draft');
  assert.deepEqual(texts(shown, '.export-meta span'), ['Round 2 · Density']);
});

check('one mock or diagram saved alone is named for it; a diagram\'s file says which it is and holds no decisions table', () => {
  assert.equal(exportFileName('Download fixture', 1, 'mock-h1'), 'download-fixture-round-1-mock-h1.html');
  assert.equal(exportFileName('Download fixture', 1), 'download-fixture-round-1.html', 'a whole round\'s name is unchanged');
  const one = parseHTML(exportDocument({ ...FILE, only: 'One diagram', unsent: true, sentDate: '', rows: [{ question: 'Density?', pick: 'Compact', note: '' }] }));
  assert.deepEqual(texts(one, '.export-meta span'), ['Round 2 · Density', 'One diagram']);
  assert.equal(one.querySelectorAll('table, h2.export-section, .export-empty, .export-unsent-note, .export-unsent').length, 0);
  assert.equal(one.querySelector('section.export-round').textContent.trim(), 'drawn');
});

// What the board's own script opens with: a mock may quote it.
const AGENT_OPENING = "<script>(function () {\n  var CB = 'cb-stage';\n";
const DIAGRAM = '<pre class="mermaid">flowchart LR\n  a --> b</pre>';
const DRAWS = `<h1>Flow</h1>${DIAGRAM}<script>window.mermaid.run();</script>`;

const stageOf = html => buildStageSrcdoc({ kind: 'html', html });

check('a mock\'s own source comes back out of its stage as the stage holds it, with the name of the library file the board lent it, or none: a fragment, a page, one with its own scripts, one that opens on a script of its own, one that quotes the board\'s', () => {
  const rows = [
    ['a fragment', '<div>Mock</div>', null],
    ['an empty mock', '', null],
    ['a whole page', '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><p>Page</p></body></html>\n', null],
    ['a page that ends in its own script', '<p id="p"></p><script>document.getElementById("p").textContent = "ran";</script>', null],
    ['a page that draws a diagram', `<!DOCTYPE html><html><body>${DIAGRAM}<script>window.mermaid.run();</script></body></html>`, MERMAID_ASSET],
    ['a diagram and nothing after it', DIAGRAM, MERMAID_ASSET],
    ['a page that quotes the board\'s own script', `<pre>${AGENT_OPENING}</pre><p>after</p>`, null],
    ['a diagram page that quotes it too', `${DIAGRAM}${AGENT_OPENING}})();</script><p>after</p>`, MERMAID_ASSET],
    ['a page that opens on a script of its own', '<script>var own = 1;</script><p>after</p>', null],
    ['a page that opens on a library it names by web address', '<script src="https://cdn.example/mermaid.min.js"></script><script>var own = 1;</script><p>after</p>', null],
    ['a page that opens on a library file of another name beside it', '<script src="mermaid.min.js"></script><script>var own = 1;</script><p>after</p>', null],
    ['a diagram page that opens on a library it names by web address', `<script src="https://cdn.example/mermaid.min.js"></script>${DIAGRAM}`, MERMAID_ASSET],
  ];
  for (const [what, html, engine] of rows) {
    assert.deepEqual(stageOwnSource(stageOf(html), STAGE_MARGIN_RESET), { html, engine }, what);
  }
});

check('a stage written by another build of the board, its lent library under another name, gives its mock back with that name, the board\'s tag and stand-in taken off', () => {
  const OTHER = 'mermaid-0123456789abcdef.js';
  assert.notEqual(OTHER, MERMAID_ASSET, 'setup: not this build\'s name');
  const html = `<h1>Flow</h1>${DIAGRAM}<script>window.mermaid.run();</script>`;
  const stage = stageOf(html).replace(MERMAID_ASSET, OTHER);
  assert.ok(stage.startsWith(`${STAGE_MARGIN_RESET}<script src="${OTHER}"></script>`), 'setup: the stage names the other build\'s file');
  assert.deepEqual(stageOwnSource(stage, STAGE_MARGIN_RESET), { html, engine: OTHER });
});

check('text that is no stage the board wrote gives no source: no margin reset, no stage script at its end, a lent library that never closes, a stage the tab does not hold', () => {
  assert.equal(stageOwnSource('<div>Mock</div>', STAGE_MARGIN_RESET), null, 'no margin reset');
  assert.equal(stageOwnSource(null, STAGE_MARGIN_RESET), null, 'a stage the tab does not hold');
  assert.equal(stageOwnSource(STAGE_MARGIN_RESET + '<p>x</p>', STAGE_MARGIN_RESET), null, 'the reset and a mock, with no stage script after it');
  const prelude = stageMermaidPrelude();
  const cut = prelude.slice(0, prelude.lastIndexOf('</script>'));
  assert.ok(cut.startsWith(`<script src="${MERMAID_ASSET}"></script><script>`) && cut.length > 1000, 'setup: the lent library\'s tag and its stand-in, less the closing tag');
  assert.equal(stageOwnSource(STAGE_MARGIN_RESET + cut, STAGE_MARGIN_RESET), null, 'the lent library cut before its closing tag');
  assert.equal(stageOwnSource(STAGE_MARGIN_RESET + cut + '<p>x</p>' + AGENT_OPENING, STAGE_MARGIN_RESET), null, 'the lent library cut before its closing tag, then a mock and the opening of the board\'s own script, nothing closed');
});

// The first line of the board's stand-in for the library, as this build writes it, and as a
// build that named its channel otherwise would.
const STAND_IN_OPENING = "<script>(function () {\n  var CB = 'cb-stage', pending";
const REWORDED_OPENING = "<script>(function () {\n  var CHANNEL = 'cb-stage', pending";
const rewordedStage = html => stageOf(html).replace(STAND_IN_OPENING, REWORDED_OPENING);

check('a stage that opens on a library file of the board\'s naming with anything after it but the stand-in this build knows gives no source: a stand-in another build reworded, under this build\'s name or another\'s, a tag written otherwise, a mock that draws no diagram and opens on such a tag itself', () => {
  const OTHER = 'mermaid-0123456789abcdef.js';
  const reworded = rewordedStage(DRAWS);
  assert.ok(reworded.startsWith(`${STAGE_MARGIN_RESET}<script src="${MERMAID_ASSET}"></script>${REWORDED_OPENING}`), 'setup: the board\'s tag, then a stand-in that opens otherwise');
  const rows = [
    ['a stand-in another build reworded', reworded],
    ['the same under another build\'s file name', reworded.replace(MERMAID_ASSET, OTHER)],
    ['the tag written with one more attribute', stageOf(DRAWS).replace(`${MERMAID_ASSET}">`, `${MERMAID_ASSET}" defer>`)],
    ['a mock that draws no diagram and opens on a script of the library\'s name', stageOf(`<script src="${MERMAID_ASSET}"></script><script>var own = 1;</script><p>after</p>`)],
    ['the same naming another build\'s file', stageOf(`<script src="${OTHER}"></script><p>after</p>`)],
  ];
  for (const [what, stage] of rows) {
    assert.notEqual(stage, stageOf(DRAWS), `setup: ${what}`);
    assert.equal(stageOwnSource(stage, STAGE_MARGIN_RESET), null, what);
  }
});

// The file's policy: inline, data:, blob: and https: sources, and none that matches a file on
// the disk the page is opened from (no file:, no 'self', no *). What it stops in a browser is
// test/browser-check-download.mjs's.
const POLICY = '<meta http-equiv="Content-Security-Policy" content="default-src \'unsafe-inline\' https: data: blob:">';
const HEAD = `<!DOCTYPE html>\n<meta charset="utf-8">\n${POLICY}\n${STAGE_MARGIN_RESET}\n`;

check('a saved mock is its own source under a UTF-8, standards-mode, margin-free head whose policy admits no file: source and sits ahead of every script in the file, the diagram library written in after it only where it is given', () => {
  const page = '<!DOCTYPE html><html><body><p>Page</p><script>go();</script></body></html>';
  assert.equal(mockDocument(page, null, STAGE_MARGIN_RESET), HEAD + page);
  assert.equal(mockDocument(page, 'window.mermaid = {};', STAGE_MARGIN_RESET), HEAD + '<script>window.mermaid = {};</script>\n' + page);
  assert.equal(mockDocument('', null, STAGE_MARGIN_RESET), HEAD);
});

check('the vendored diagram library can be written into a file as it is: a text holding a script tag, which would end the script early or swallow the page, is refused', () => {
  assert.ok(mockDocument('<p>after</p>', MERMAID_SOURCE, STAGE_MARGIN_RESET) === HEAD + '<script>' + MERMAID_SOURCE + '</script>\n<p>after</p>',
    'the head, the library whole inside one script, then the mock');
  for (const text of ['var a = "</script>";', 'var a = "</SCRIPT >";', 'var a = "<!--<script>";']) {
    assert.throws(() => mockDocument('<p>after</p>', text, STAGE_MARGIN_RESET), /script tag/, text);
  }
});

// The page's own script saving a mock, in node: what the tab hands the browser. `fetch` gives
// the diagram library's text for the name asked, `URL.createObjectURL` keeps each blob, the
// link the script clicks keeps the file's name, and the timer that drops a blob keeps its
// delay and never runs. Answers `{ saved, asked, restore }`.
function savingStubs(library) {
  const real = { fetch: globalThis.fetch, create: URL.createObjectURL, timeout: globalThis.setTimeout };
  const saved = [], asked = [];
  globalThis.fetch = async url => { asked.push(String(url)); return new Response(library, { status: 200 }); };
  URL.createObjectURL = blob => { saved.push({ blob }); return `blob:stub/${saved.length}`; };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000 && saved.length && saved[saved.length - 1].life === undefined) { saved[saved.length - 1].life = ms; return 0; }
    return real.timeout(fn, ms, ...rest);
  };
  return { saved, asked, restore() { globalThis.fetch = real.fetch; URL.createObjectURL = real.create; globalThis.setTimeout = real.timeout; } };
}

/** `loadBoard`, with each link the page's script makes given a click that keeps its name. */
function loadSaving(html, stubs, opts = {}) {
  const document = loadBoard(html, opts);
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const el = create(tag);
    if (String(tag).toLowerCase() === 'a') el.click = () => { stubs.saved[stubs.saved.length - 1].name = el.download; };
    return el;
  };
  return document;
}

const press = el => { assert.ok(el, 'setup: the control is on the page'); el.dispatchEvent(new StandInEvent('click')); };
const LIBRARY = 'window.mermaid = { run: function () {} };';

await check('Pull-out\'s Download on a mock saves the mock\'s own page: its source under the head, the diagram library the stage names read from the board and written in, as plain bytes under an .html name, dropped after a few seconds', async () => {
  const board = createBoard({ title: 'Saved mock', blocks: [{ kind: 'html', title: 'Flow', html: DRAWS }, Q1] });
  const stubs = savingStubs(LIBRARY);
  try {
    const document = loadSaving(renderBoardPage(board), stubs);
    const id = document.querySelector('.html-block').getAttribute('data-block-id');
    press(document.querySelector('.html-block .pull-out'));
    assert.ok(document.querySelector('.stage-lens').hasAttribute('open'), 'setup: the mock is pulled out');
    press(document.querySelector('.stage-lens [data-lens="download"]'));
    await waitFor(() => stubs.saved.length && stubs.saved[0].name, { what: 'the mock\'s file' });
    assert.equal(stubs.saved.length, 1);
    assert.deepEqual(stubs.asked, [MERMAID_ASSET], 'one read: the library, by the name the stage carries');
    assert.equal(await stubs.saved[0].blob.text(), HEAD + '<script>' + LIBRARY + '</script>\n' + DRAWS);
    assert.equal(stubs.saved[0].name, `saved-mock-round-1-mock-${id}.html`);
    assert.equal(stubs.saved[0].blob.type, 'application/octet-stream', 'plain bytes: its address saves, and draws no page at the board\'s origin');
    assert.ok(stubs.saved[0].life >= 1000 && stubs.saved[0].life <= 5000, `dropped after a few seconds, not ${stubs.saved[0].life}ms`);
    assert.equal(document.querySelector('.stage-lens [data-lens="download"]').disabled, false, 'the control is live again');
  } finally {
    stubs.restore();
  }
});

await check('Download round on a round drawn full page saves its one mock\'s own page, named for the round, with nothing read where the mock draws no diagram', async () => {
  const html = '<main><h1>Page</h1><script>document.title = "ran";</script></main>';
  const board = createBoard({ title: 'Saved page', blocks: [{ kind: 'html', html }] });
  const stubs = savingStubs(LIBRARY);
  try {
    const document = loadSaving(renderBoardPage(board), stubs);
    press(document.querySelector('header.board-head .head-download'));
    await waitFor(() => stubs.saved.length && stubs.saved[0].name, { what: 'the page\'s file' });
    assert.equal(stubs.saved.length, 1);
    assert.deepEqual(stubs.asked, []);
    assert.equal(await stubs.saved[0].blob.text(), HEAD + html);
    assert.equal(stubs.saved[0].name, 'saved-page-round-1.html');
    assert.equal(stubs.saved[0].blob.type, 'application/octet-stream');
  } finally {
    stubs.restore();
  }
});

const UNREAD_NOTE = 'This page is older than the board that sent this mock, so nothing was saved. Reload the page, then press again.';

await check('a mock whose stage a newer build of the board wrote, its stand-in for the library opening as this page does not know, saves no file and reads no library: Download round says the page is older than the board, in its label and in a note under itself, live again', async () => {
  const board = createBoard({ title: 'Newer board', blocks: [{ kind: 'html', html: DRAWS }] });
  const stubs = savingStubs(LIBRARY);
  try {
    const document = loadSaving(renderBoardPage(board), stubs);
    const frame = document.querySelector('.round-current iframe.html-stage');
    assert.equal(frame.getAttribute('srcdoc'), stageOf(DRAWS), 'setup: the page holds the stage as this build writes it');
    frame.setAttribute('srcdoc', rewordedStage(DRAWS));
    const btn = document.querySelector('header.board-head .head-download');
    press(btn);
    await waitFor(() => btn.querySelector('.download-note'), { what: 'the note under the control' });
    assert.deepEqual({ saved: stubs.saved.length, asked: stubs.asked }, { saved: 0, asked: [] });
    assert.equal(btn.querySelector('.download-note').textContent, UNREAD_NOTE);
    assert.deepEqual({ label: btn.getAttribute('aria-label'), title: btn.getAttribute('title') }, { label: UNREAD_NOTE, title: UNREAD_NOTE });
    assert.equal(btn.disabled, false, 'live again');
  } finally {
    stubs.restore();
  }
});

await check('a read-only archive saves nothing and reads nothing, from the top strip\'s Download round or from a mock\'s Pull-out', async () => {
  const page = createBoard({ title: 'Archived page', blocks: [{ kind: 'html', html: DRAWS }] });
  const mixed = createBoard({ title: 'Archived mock', blocks: [{ kind: 'html', title: 'Flow', html: DRAWS }, Q1] });
  const stubs = savingStubs(LIBRARY);
  try {
    const paged = loadSaving(renderBoardPage(page), stubs, { protocol: 'file:' });
    press(paged.querySelector('header.board-head .head-download'));
    const document = loadSaving(renderBoardPage(mixed), stubs, { protocol: 'file:' });
    press(document.querySelector('.html-block .pull-out'));
    assert.ok(document.querySelector('.stage-lens').hasAttribute('open'), 'setup: an archive still pulls a mock out');
    press(document.querySelector('.stage-lens [data-lens="download"]'));
    await flush();
    assert.deepEqual({ saved: stubs.saved.length, asked: stubs.asked }, { saved: 0, asked: [] });
  } finally {
    stubs.restore();
  }
});

check('the decisions table names each question\'s pick in words, per widget and state, with its note', () => {
  const questions = [
    { id: 'q1', prompt: 'One', widget: 'single' },
    { id: 'q2', prompt: 'Many', widget: 'multi' },
    { id: 'q3', prompt: 'Order', widget: 'rank' },
    { id: 'q4', prompt: 'Words', widget: 'text' },
    { id: 'q5', prompt: 'Later', widget: 'single' },
    { id: 'q6', prompt: 'Skipped', widget: 'single' },
    { id: 'q7', prompt: 'Never asked', widget: 'variant' },
  ];
  const answers = {
    q1: { status: 'answered', choice: 'No', note: 'not this week' },
    q2: { status: 'answered', choice: ['A', 'C'], note: '' },
    q3: { status: 'answered', choice: ['Z', 'X'], note: '' },
    q4: { status: 'answered', choice: 'Two lines\nof text', note: '' },
    q5: { status: 'deferred', choice: null, note: 'ask again' },
    q6: { status: 'unanswered', choice: null, note: '' },
  };
  assert.deepEqual(decisionRows(questions, answers), [
    { question: 'One', pick: 'No', note: 'not this week' },
    { question: 'Many', pick: 'A, C', note: '' },
    { question: 'Order', pick: '1. Z, 2. X', note: '' },
    { question: 'Words', pick: 'Two lines\nof text', note: '' },
    { question: 'Later', pick: 'Deferred', note: 'ask again' },
    { question: 'Skipped', pick: 'No answer', note: '' },
    { question: 'Never asked', pick: 'No answer', note: '' },
  ]);
});

check('the file\'s head escapes the title, the round\'s name and every table cell, and no stylesheet text closes its style', () => {
  const hostile = '</title><script>alert(1)</script>';
  const html = exportDocument({
    title: hostile, roundN: 2, roundTitle: hostile, sentDate: '2026-11-11',
    rows: [{ question: hostile, pick: hostile, note: hostile }],
    css: `.a { color: red; }</style><script>alert(2)</script><style>`, exportCss: '', contentHtml: '<p>drawn</p>',
  });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<\/style><script/i);
  const document = parseHTML(html);
  assert.equal(document.querySelector('h1').textContent, hostile);
  assert.deepEqual(document.querySelectorAll('td').map(td => td.textContent), [hostile, hostile, hostile]);
});

check('a printed page\'s height shrinks only a mock taller than the page, to that one page, and never enlarges one', () => {
  const rows = [
    [320, 1], [960, 1], [1920, 0.5], [2880, 1 / 3],
    [0, 1], [NaN, 1], [undefined, 1],
  ];
  for (const [height, scale] of rows) assert.equal(printScale(height), scale, `a mock ${height}px tall`);
});

finish('round-download');
