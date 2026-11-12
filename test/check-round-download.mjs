// Download round's markup and the pure half of the file it saves (src/round-export.mjs).
// The control sits at the right end of a SENT round's chip line, rendered by
// src/render.mjs and added by src/ui.mjs's markRoundHistory when a round goes sent under
// an open tab; a round still open or abandoned offers none. The decisions table's pick
// text per widget, and the file's head escaped so no title or stylesheet text can open a
// script. The saved file itself, its layout and its print are
// test/browser-check-download.mjs's, run by hand.

import assert from 'node:assert/strict';
import { createBoard, addRound, applySubmit, abandonOpenRounds } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { buildRoundPushPayload } from '../src/server.mjs';
import { decisionRows, exportDocument } from '../src/round-export.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { check, finish, pageHarness } from './support.mjs';

const { loadBoardWithEventSource } = await pageHarness();

const Q1 = { kind: 'question', prompt: 'Q1: pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const Q2 = { kind: 'question', prompt: 'Q2: pick another', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] };

const lastChild = el => el.children[el.children.length - 1];
const downloadsIn = (document, n) => document.querySelectorAll(`.round[data-round="${n}"] .round-download`);

check('a sent round\'s chip line ends in Download round; an open round\'s and an abandoned round\'s carry none', () => {
  const board = createBoard({ title: 'Download - markup', blocks: [Q1] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  abandonOpenRounds(board);
  addRound(board, { blocks: [{ ...Q2, prompt: 'Q3: still open' }] });
  assert.deepEqual(board.rounds.map(r => r.status), ['sent', 'abandoned', 'open'], 'setup: one round in each state');
  const document = parseHTML(renderBoardPage(board));

  const chips = document.querySelector('.round[data-round="1"] .round-chips');
  assert.ok(chips, 'the sent round has its chip line');
  const btn = lastChild(chips);
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.className, 'round-download');
  assert.equal(btn.textContent.trim(), 'Download round');
  assert.equal(btn.hasAttribute('disabled'), false, 'live, though the round\'s answers are not');
  assert.equal(downloadsIn(document, 1).length, 1);
  assert.equal(downloadsIn(document, 2).length, 0, 'an abandoned round still takes a Send, so it is not settled');
  assert.equal(downloadsIn(document, 3).length, 0, 'an open round');
});

check('a round that goes sent under an open tab gains Download round, live, as a reload would draw it', () => {
  const board = createBoard({ title: 'Download - live', blocks: [Q1] });
  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  assert.equal(downloadsIn(document, 1).length, 0, 'setup: the open round offers none');

  // A new round's push, marking round 1 sent (src/ui.mjs's markRoundHistory).
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 2, 'new-round', [])));

  const live = downloadsIn(document, 1);
  assert.equal(live.length, 1);
  assert.equal(lastChild(live[0].parentElement), live[0], 'at the right end of the chip line');
  assert.equal(live[0].disabled, false, 'the sent round\'s controls go disabled; this one does not');
  assert.equal(downloadsIn(document, 2).length, 0, 'the round that just opened offers none');
});

check('a sent artifact round, drawn full page, offers Download round on a chip line of its own, rendered sent or gone sent live; an open one offers none', () => {
  const MOCK = { kind: 'html', html: '<div>Mock</div>' };
  const board = createBoard({ title: 'Download - page', blocks: [MOCK] });
  const before = parseHTML(renderBoardPage(board));
  assert.equal(before.querySelectorAll('.round[data-round="1"] .round-chips').length, 0, 'the open artifact round draws no chip line');
  assert.equal(downloadsIn(before, 1).length, 0);

  const { document, es } = loadBoardWithEventSource(renderBoardPage(board));
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [Q2] });
  es.dispatch('round', JSON.stringify(buildRoundPushPayload(board, 2, 'new-round', [])));
  const rendered = parseHTML(renderBoardPage(board));
  for (const [how, doc] of [['rendered sent', rendered], ['gone sent under an open tab', document]]) {
    const chips = doc.querySelectorAll('.round[data-round="1"] .round-chips');
    assert.equal(chips.length, 1, `${how}: one chip line`);
    assert.equal(chips[0].children.length, 2, `${how}: the label and the button, nothing else`);
    assert.equal(chips[0].children[0].textContent, 'Round 1 · Download - page · sent', how);
    assert.equal(lastChild(chips[0]).className, 'round-download', how);
    assert.equal(lastChild(chips[0]).textContent.trim(), 'Download round', how);
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

finish('round-download');
