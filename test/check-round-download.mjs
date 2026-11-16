// Download round's markup and the pure half of the file it saves (src/round-export.mjs).
// The control sits at the right end of a question round's chip line, sent or not, rendered
// by src/render.mjs and left live by src/ui.mjs's markRoundHistory when a round goes sent
// under an open tab. A round drawn full page has no chip line: its control is the one in the
// top strip. The decisions table's pick text per widget, the Not sent line an unsent round's
// file opens on, the file of one mock or diagram, and the file's head escaped so no title or
// stylesheet text can open a script, and how far a printed page's height shrinks a mock. The
// saved file itself, its layout and its print are test/browser-check-download.mjs's, run by
// hand.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit, abandonOpenRounds } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { buildRoundPushPayload } from '../src/server.mjs';
import { decisionRows, exportDocument, exportFileName, printScale } from '../src/round-export.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { check, finish, pageHarness } from './support.mjs';

const { loadBoardWithEventSource } = await pageHarness();

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

check('one mock or diagram saved alone: the file is named for it, says which it is, and holds no decisions table', () => {
  assert.equal(exportFileName('Download fixture', 1, 'mock-h1'), 'download-fixture-round-1-mock-h1.html');
  assert.equal(exportFileName('Download fixture', 1), 'download-fixture-round-1.html', 'a whole round\'s name is unchanged');
  const one = parseHTML(exportDocument({ ...FILE, only: 'One mock', unsent: true, sentDate: '', rows: [{ question: 'Density?', pick: 'Compact', note: '' }] }));
  assert.deepEqual(texts(one, '.export-meta span'), ['Round 2 · Density', 'One mock']);
  assert.equal(one.querySelectorAll('table, h2.export-section, .export-empty, .export-unsent-note, .export-unsent').length, 0);
  assert.equal(one.querySelector('section.export-round').textContent.trim(), 'drawn');
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
