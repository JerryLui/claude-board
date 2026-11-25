// Real-browser check for the round pager on a phone (ADR.md entry 42, amended for
// phones). At 560px wide or less the bottom pill reads this round of the board's
// rounds between two arrows, `‹ 11 / 14 ›`, on one line down to a 320px window and
// a three-digit count; the arrows flip a round; a dot sits on the count while
// another round waits for an answer; a press on the count opens every round number
// above the pill, and a press on one jumps there and closes them, on a live board
// and on a saved one; no caption and no edge arrows show, and at 390 by 844 every
// control stays at least 44px with the pill over no control of the round. At 1280
// the edge arrows, the numbered pager and its caption are as they were. All of that
// is layout and a real press, which the DOM stand-in has none of (QUIRKS.md "The DOM
// stand-in's ceilings"): test/check-round-pager.mjs holds the count's text, its dot
// and the list's open state.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass
// on a machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-round-pill.mjs
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch
// port and a scratch store, headless Chrome over the DevTools Protocol.

import assert from 'node:assert/strict';
import path from 'node:path';
import { abandonOpenRounds, addRound, applySubmit, createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { sessionToken } from '../src/secret.mjs';
import { writeBoard, writePage } from '../src/store.mjs';
import { runMain } from './support.mjs';
import {
  assertPhone, clickAt, copyArchive, guardRun, openTab, phoneFaults, requireChrome, row, startScratchDaemon, withChrome,
} from './browser-support.mjs';

guardRun('browser-check-round-pill', { deadlineMs: 180000 });

const TITLE = 'A board title long enough to take two lines of a phone window, and then some';
const QUESTION = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const PHONES = [{ width: 390, height: 844 }, { width: 320, height: 640 }];
const DESK = { width: 1280, height: 900 };

function rounds(count, waiting = []) {
  const board = createBoard({ title: TITLE, blocks: [QUESTION] });
  for (let n = 2; n <= count; n++) {
    if (waiting.includes(n - 1)) abandonOpenRounds(board);
    else applySubmit(board, { action: 'send', answers: [], comments: [] }, n - 1);
    addRound(board, { title: `Step ${n}`, blocks: [QUESTION] });
  }
  return board;
}

function pageThenQuestion() {
  const board = createBoard({ title: TITLE, blocks: [{ kind: 'html', html: '<div style="height:3000px">page</div>' }] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { title: 'Questions', blocks: [QUESTION] });
  return board;
}

const PILL_EXPR = `(function () {
  function box(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }
  function shown(sel) { return [].slice.call(document.querySelectorAll(sel)).filter(function (el) { return el.getClientRects().length > 0; }); }
  var pill = document.querySelector('.round-pill');
  var count = document.querySelector('#round-pill-count');
  var parts = shown('.round-pill > button');
  var nav = document.querySelector('nav#round-pager');
  return {
    round: document.querySelector('.round-current').getAttribute('data-round'),
    pill: pill && pill.getClientRects().length ? box(pill) : null,
    face: parts.map(function (el) { return el.textContent; }).join(' '),
    rows: parts.map(function (el) { return Math.round(el.getBoundingClientRect().top); }).filter(function (y, i, all) { return all.indexOf(y) === i; }).length,
    partH: parts.length ? box(parts[0]).h : 0,
    dot: !!count && getComputedStyle(count, '::after').content !== 'none',
    expanded: count && count.getAttribute('aria-expanded'),
    numbers: shown('.round-page').map(function (el) { return el.textContent; }).join(' '),
    entries: shown('.round-page').map(box), list: nav.getClientRects().length ? box(nav) : null,
    caption: shown('#round-pager-caption').length, flips: shown('.round-flip').map(box),
    docW: document.documentElement.clientWidth, scrollW: document.documentElement.scrollWidth,
  };
})()`;

async function main() {
  requireChrome('browser-check-round-pill');
  const daemon = await startScratchDaemon('cb-round-pill');
  try {
    const origin = `http://127.0.0.1:${await daemon.port()}`;
    const fourteen = rounds(14, [7]);
    const lastWaits = rounds(14);
    const hundreds = rounds(120);
    const page = pageThenQuestion();
    const six = rounds(6, [2]);
    for (const board of [fourteen, lastWaits, hundreds, page, six]) writeBoard(board, daemon.home);
    writePage(fourteen.id, renderBoardPage(fourteen), daemon.home);
    const urlOf = (board, n) => `${origin}/b/${board.id}${n ? `#round:${n}` : ''}`;

    await withChrome({ tag: 'cb-round-pill' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const open = (url, { width, height }) => openTab(send, onEvent, url, cookie, {
        width, height, theme: 'dark', expr: '1',
        prepare: width > 560 ? null : async sp => {
          await sp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
          await sp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        },
      });
      const look = async tab => { await tab.quiet(); return tab.evalPage(PILL_EXPR); };
      const press = async (tab, selector) => {
        const at = await tab.evalPage(`(function () { var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await clickAt(tab, at);
        return look(tab);
      };
      const within = (m, what) => {
        assert.ok(m.pill, `${what}: the pill is on the screen`);
        assert.equal(m.rows, 1, `${what}: the pill is one line`);
        assert.ok(m.pill.h <= m.partH + 12, `${what}: the pill is one row high, ${m.pill.h}px for ${m.partH}px buttons`);
        assert.ok(m.pill.x >= 0 && m.pill.r <= m.docW, `${what}: the pill is inside the window`);
        assert.equal(m.scrollW, m.docW, `${what}: the page scrolls sideways`);
        assert.deepEqual([m.caption, m.flips.length, m.numbers], [0, 0, ''], `${what}: no caption, no edge arrows, no numbers`);
      };

      for (const phone of PHONES) {
        await row(`at ${phone.width}px the pill reads this round of the board's rounds on one line, its arrows flip a round and the count wears a dot while another round waits`, async note => {
          const tab = await open(urlOf(fourteen, 11), phone);
          try {
            const m = await look(tab);
            note(`round ${m.round}: ${m.face}${m.dot ? ' with a dot' : ''}; pill ${Math.round(m.pill?.w)}x${Math.round(m.pill?.h)}`);
            assert.equal(m.face, '‹ 11 / 14 ›');
            within(m, 'round 11');
            assert.equal(m.dot, true, 'rounds 7 and 14 wait');
            const back = await press(tab, '#round-pill-prev');
            assert.deepEqual([back.round, back.face], ['10', '‹ 10 / 14 ›']);
            const on = await press(tab, '#round-pill-next');
            assert.deepEqual([on.round, on.face], ['11', '‹ 11 / 14 ›']);
          } finally { await tab.close(); }
          const only = await open(urlOf(lastWaits), phone);
          try {
            const last = await look(only);
            assert.deepEqual([last.face, last.dot], ['‹ 14 / 14 ›', false], 'the round on screen is the only one waiting');
            const before = await press(only, '#round-pill-prev');
            assert.deepEqual([before.face, before.dot], ['‹ 13 / 14 ›', true], 'round 14 waits');
          } finally { await only.close(); }
        });
      }

      await row('at 320px a three-digit count and a full-page round keep the pill on one line', async note => {
        for (const [board, face] of [[hundreds, '‹ 120 / 120 ›'], [page, '‹ 1 / 2 ›']]) {
          const tab = await open(urlOf(board, board === page ? 1 : 0), PHONES[1]);
          try {
            const m = await look(tab);
            note(`${m.face}: pill ${Math.round(m.pill?.w)}x${Math.round(m.pill?.h)}`);
            assert.equal(m.face, face);
            within(m, face);
          } finally { await tab.close(); }
        }
      });

      for (const phone of PHONES) {
        await row(`at ${phone.width}px a press on the count lists every round number above the pill, and a press on one jumps there and closes the list`, async note => {
          const tab = await open(urlOf(fourteen, 11), phone);
          try {
            const opened = await press(tab, '#round-pill-count');
            note(`open: ${opened.numbers}; list ${Math.round(opened.list?.w)}x${Math.round(opened.list?.h)}`);
            assert.equal(opened.expanded, 'true');
            assert.equal(opened.numbers, Array.from({ length: 14 }, (_, i) => i + 1).join(' '));
            assert.ok(opened.list.b <= opened.pill.y, 'the list stands above the pill');
            assert.ok(opened.list.x >= 0 && opened.list.r <= opened.docW, 'the list is inside the window');
            assert.deepEqual(opened.entries.filter(e => e.w < 44 || e.h < 44), [], 'each number is at least 44px');
            const picked = await press(tab, '.round-page[data-round="3"]');
            assert.deepEqual([picked.round, picked.face, picked.expanded, picked.numbers], ['3', '‹ 3 / 14 ›', 'false', '']);
          } finally { await tab.close(); }
        });
      }

      await row('on a saved board at phone width the count opens the numbers and a pick jumps there', async () => {
        const { pageUrl } = copyArchive(path.join(daemon.home, 'pages'), fourteen.id, 'cb-round-pill');
        const tab = await open(pageUrl, PHONES[0]);
        try {
          const opened = await press(tab, '#round-pill-count');
          assert.equal(opened.numbers.split(' ').length, 14);
          const picked = await press(tab, '.round-page[data-round="8"]');
          assert.deepEqual([picked.round, picked.face, picked.numbers], ['8', '‹ 8 / 14 ›', '']);
        } finally { await tab.close(); }
      });

      await row('at 390 by 844 every control stays at least 44px and the pill covers no control of the round, the list shut and open', async note => {
        const tab = await open(urlOf(fourteen, 14), PHONES[0]);
        try {
          for (const state of ['shut', 'open']) {
            if (state === 'open') await tab.evalPage(`document.querySelector('#round-pill-count').click()`);
            const expected = ['.round-pill-step', '.round-pill-count', '#send-btn', '#discuss-btn', ...(state === 'open' ? ['.round-page'] : [])];
            const faults = await phoneFaults(tab, expected);
            note(`${state}: ${faults.count} controls`);
            assertPhone(faults, expected);
          }
        } finally { await tab.close(); }
      });

      await row('at 1280 the edge arrows, the numbered pager and its caption are as they were, and the pill is not shown', async note => {
        const tab = await open(urlOf(six, 4), DESK);
        try {
          const m = await look(tab);
          note(`numbers ${m.numbers}; arrows at ${m.flips.map(f => `${Math.round(f.x)}..${Math.round(f.r)}`).join(', ')}`);
          assert.equal(m.pill, null);
          assert.equal(m.caption, 1);
          assert.equal(m.numbers, '1 2 3 4 5 6');
          assert.deepEqual(m.flips.map(f => [Math.round(f.x), Math.round(f.r), Math.round(f.w)]), [[0, 32, 32], [m.docW - 32, m.docW, 32]]);
        } finally { await tab.close(); }
      });
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
