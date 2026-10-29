// Real-browser check for the Missions view with cards on it: the top bar lands on the same
// pixels on `/` (cards in every column, Comment on offer) as on `/boards`; the five columns
// lay out in one row across the bar's whole content width, at 1440 and 2560 wide, light
// and dark, with nothing scrolling sideways; every mission card at rest, a tab card's too,
// is as tall as its own text, in a list's density, its long fields cut short with an
// ellipsis under one fold that shows them whole; a click on a card or Enter on it opens
// its board, and its Stop shows only on its hover or focus; the Boards view is one grouped
// list at 1280, 1440 and 2560, a 38px line a board under "Waiting on you" and "Earlier",
// the whole line a link and the filter narrowing both groups; and Stop, pressed with a
// real mouse, plain or
// with Ctrl, Shift or Alt held, asks once and then sends its order, its Stop and Keep on
// one line, while a Cmd double-press sends one order with no question. Layout and a real press, which the DOM stand-in has none of (QUIRKS.md "The DOM
// stand-in's ceilings"): test/check-missions-view.mjs holds the markup and the requests.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-missions.mjs
//
// Without Chrome it prints a skip line and exits 0.
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch port
// and a scratch store, headless Chrome over the DevTools Protocol, with classic scrollbars
// and with whatever the Mac draws by default (QUIRKS.md "Headless Chrome's scrollbars
// follow the Mac's Show scroll bars setting"). A live session is this process's own pid.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { deadPid, runMain, skipFile, sleep } from './support.mjs';
import { CHROME, getJson, guardRun, measureTab, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-missions', `browser-check-missions: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

const WIDTHS = [1440, 2560];
const HEIGHT = 900;
const THEMES = ['light', 'dark'];
const BOARDS = 14; // enough rows that the boards list scrolls at HEIGHT
const COLUMNS = ['needs-you', 'working', 'waiting', 'stalled', 'released'];
const NARROW = 1280; // the Boards view is measured here too, so it is checked at every width
const LINE = 38; // a board's line on the Boards view
const LONG = 'LONG_CARD'; // every field at the store's longest
const LONG_TAB = 'tab:tab-long'; // a tab card with its name and blocked reason at their longest (ADR 131)
// The lines each long field stops at, and the class that draws it.
const CUTS = { title: ['b.mission-title', 2], summary: ['p.mission-summary', 2], 'waiting on': ['p.mission-waiting', 2], next: ['p.mission-next', 1] };
const TITLE_ONLY = 'TITLE_ONLY'; // a title and its key line, nothing else
const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const longText = (max, seed) => words(200, seed).slice(0, max);
const LONG_BOARD = longText(400, 'boardtitle'); // a board title far wider than its line

guardRun('browser-check-missions', { deadlineMs: 240000 });

const px = n => `${Math.round(n * 100) / 100}px`;

const MEASURE_EXPR = `(function () {
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function box(sel) { return rect(document.querySelector(sel)); }
  var bar = document.querySelector('header.board-head');
  var cs = bar ? getComputedStyle(bar) : null;
  var parts = {
    bar: box('header.board-head'),
    mark: box('header.board-head a.back-to-index'),
    title: box('header.board-head h1'),
    'timer': box('header.board-head div#pomodoro-widget'),
    'Comment': box('header.board-head button#comment-mode-toggle'),
    'theme': box('header.board-head button#theme-toggle'),
    'waiting count': box('header.board-head span#waiting-count'),
  };
  [].slice.call(document.querySelectorAll('a.view-tab')).forEach(function (t) {
    parts['tab ' + t.textContent.replace(/\\d+ waiting$/, '').trim()] = rect(t);
  });
  var cols = {};
  [].slice.call(document.querySelectorAll('section.mission-col')).forEach(function (c) {
    cols[c.getAttribute('data-col')] = Object.assign(rect(c), { cards: c.querySelectorAll('article.mission-card').length });
  });
  var cards = [].slice.call(document.querySelectorAll('article.mission-card')).map(function (c) {
    var list = [].slice.call(c.parentNode.children);
    var fold = c.querySelector('details.mission-more');
    var s = getComputedStyle(c);
    var r = c.getBoundingClientRect();
    // The last child the card lays out, and how far its bottom sits above the card's padding edge.
    var flow = [].slice.call(c.children).filter(function (k) {
      var ks = getComputedStyle(k);
      return ks.position !== 'absolute' && ks.display !== 'none';
    });
    var last = flow[flow.length - 1];
    var title = c.querySelector('b.mission-title');
    var ident = c.querySelector('span.mission-key');
    var stop = c.querySelector('button.mission-stop');
    return Object.assign(rect(c), { key: c.getAttribute('data-mission-key'), index: list.indexOf(c),
      col: c.closest('section.mission-col').getAttribute('data-col'),
      fold: fold ? getComputedStyle(fold).display : null,
      footGap: r.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom) - last.getBoundingClientRect().bottom,
      pad: s.paddingTop + ' ' + s.paddingRight + ' ' + s.paddingBottom + ' ' + s.paddingLeft,
      radius: s.borderRadius, shadow: s.boxShadow,
      title: title ? getComputedStyle(title).fontSize + ' ' + getComputedStyle(title).fontWeight : null,
      ident: ident ? getComputedStyle(ident).fontSize : null,
      stop: stop ? getComputedStyle(stop).visibility : null,
      openButtons: [].slice.call(c.querySelectorAll('a, button')).filter(function (b) { return /Open (board|round)/.test(b.textContent); }).length });
  });
  var long = document.querySelector('article.mission-card[data-mission-key=${JSON.stringify(LONG)}]');
  var longTab = document.querySelector('article.mission-card[data-mission-key=${JSON.stringify(LONG_TAB)}]');
  var tabCuts = {};
  [['title', 'b.mission-title'], ['reason', 'p.mission-summary']].forEach(function (e) {
    var el = longTab && longTab.querySelector(e[1]);
    if (!el) return;
    var s = getComputedStyle(el);
    tabCuts[e[0]] = { clamp: s.webkitLineClamp, lineHeight: parseFloat(s.lineHeight), client: el.clientHeight, scroll: el.scrollHeight };
  });
  var cuts = {};
  ${JSON.stringify(Object.entries(CUTS))}.forEach(function (e) {
    var el = long && long.querySelector(e[1][0]);
    if (!el) return;
    var s = getComputedStyle(el);
    cuts[e[0]] = { clamp: s.webkitLineClamp, lineHeight: parseFloat(s.lineHeight), client: el.clientHeight, scroll: el.scrollHeight };
  });
  return {
    parts: parts,
    content: bar ? { left: bar.getBoundingClientRect().left + parseFloat(cs.paddingLeft), width: bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) } : null,
    cols: cols,
    cards: cards,
    cuts: cuts,
    longFolds: long ? long.querySelectorAll('details.mission-more').length : 0,
    tabCuts: tabCuts,
    longTabFolds: longTab ? longTab.querySelectorAll('details.mission-more').length : 0,
    boardList: (function () {
      var lists = document.querySelectorAll('div.thread-list');
      if (!lists.length) return null;
      var long = [].slice.call(document.querySelectorAll('div.thread-title')).filter(function (t) { return t.textContent === ${JSON.stringify(LONG_BOARD)}; })[0];
      var ls = long && getComputedStyle(long);
      return {
        panels: lists.length,
        list: rect(lists[0]),
        form: rect(document.querySelector('form.search-form')),
        groups: [].slice.call(document.querySelectorAll('div.thread-group')).map(function (g) {
          var head = g.querySelector('h2.thread-group-head');
          var count = head.querySelector('.thread-group-count').textContent;
          return { key: g.getAttribute('data-group'), label: head.textContent.slice(0, -count.length).trim(), count: Number(count), head: rect(head),
            lines: [].slice.call(g.querySelectorAll('a.thread-item')).map(function (a) { return Object.assign(rect(a), { live: a.getAttribute('data-live') }); }) };
        }),
        longTitle: long ? { whiteSpace: ls.whiteSpace, textOverflow: ls.textOverflow, lineHeight: parseFloat(ls.lineHeight), height: long.getBoundingClientRect().height, client: long.clientWidth, scroll: long.scrollWidth } : null,
      };
    })(),
    commentOn: !!document.querySelector('button#comment-mode-toggle:not([disabled])'),
    background: getComputedStyle(document.body).backgroundColor,
    docW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
  };
})()`;

/** A tab at `width` x HEIGHT under `theme`, held still on MEASURE_EXPR (openTab's options). */
const tabAt = (width, theme) => ({ width, height: HEIGHT, theme, expr: MEASURE_EXPR });

/** Presses the element `selector` names with a real mouse, at its centre, with the
 * DevTools `modifiers` bitmask held (1 Alt, 2 Ctrl, 4 Cmd, 8 Shift), `times` presses in
 * a row on the same spot as a double-click lands them. */
async function press(tab, selector, modifiers = 0, times = 1) {
  const at = await tab.evalPage(`(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(at, `nothing to press at ${selector}`);
  await tab.sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'left', modifiers, clickCount: 0 });
  for (let n = 1; n <= times; n++) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await tab.sp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', modifiers, clickCount: n });
    }
  }
}

/** The path the tab's top frame has gone to once it leaves the Missions page (`/`), or
 * '/' when it has not left within five seconds. A read that lands mid-swap ("Not attached
 * to an active page") is read again. */
async function landedAt(tab) {
  let path = '/';
  for (let i = 0; i < 100 && path === '/'; i++) {
    try {
      const { currentIndex, entries } = await tab.sp('Page.getNavigationHistory');
      path = new URL(entries[currentIndex].url).pathname;
    } catch (err) {
      if (!/Not attached to an active page/.test(err.message)) throw err;
    }
    if (path === '/') await new Promise(r => setTimeout(r, 50));
  }
  return path;
}

/** Presses `key` ('Enter' or 'Tab') on whatever has the tab's focus, as a keyboard does.
 * Enter is its key-down alone: the page may already be navigating away by its key-up. */
async function pressKey(tab, key) {
  const code = { Enter: 13, Tab: 9 }[key];
  const down = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  if (key === 'Enter') { await tab.sp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...down }); return; }
  await tab.sp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...down });
  await tab.sp('Input.dispatchKeyEvent', { type: 'keyUp', ...down });
}

/** The stop orders `key`'s card has sent from this tab, once every request the press
 * started, and the repaint after it, has landed (openTab's `quiet`). */
async function ordersSent(tab, key) {
  await tab.quiet();
  return tab.evalPage(`window.__cbNet.requests.filter(function (r) { return r === 'POST /api/mission/${key}/order'; }).length`);
}

async function main() {
  const daemon = await startScratchDaemon('cb-missions');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = (route, body) => postJson(`${origin}${route}`, body, daemon.secret);
    for (let i = 0; i < BOARDS; i++) {
      await post('/api/board', { title: `Session ${i + 1}`, blocks: [{ kind: 'markdown', text: `Board ${i + 1}` }] });
    }
    await post('/api/board', { title: LONG_BOARD, blocks: [{ kind: 'markdown', text: 'A title wider than its line' }] });
    await post('/api/board', { title: 'Invoice reminders: notes', blocks: [{ kind: 'markdown', text: 'Settled, beside the waiting grill board' }] });
    const live = async (key, fields) => {
      await post(`/api/mission/${key}`, { phase: 'direct', state: 'working', ...fields });
      await post(`/api/mission/${key}/session`, { pid: process.pid, id: `sess-${key}` });
    };
    await live('INVOICE_REMINDERS', { title: 'Invoice reminder emails', phase: 'grill', summary: 'Grill closed, spec ready' });
    await post('/api/board', { title: 'Invoice reminders: grill', mission: 'INVOICE_REMINDERS', wait: true, blocks: [
      { kind: 'question', prompt: 'Fire /direct on the spec?', widget: 'single', action: 'fire', options: [{ label: 'Fire' }, { label: 'Not yet' }] },
    ] });
    await live('MODEL_MAP', { title: 'Model vendors dashboard', phase: 'landing', waitingOn: 'your merge yes', prs: [
      { repo: 'service', number: 1874, url: 'https://github.com/o/service/pull/1874', state: 'green' },
      { repo: 'admin', number: 312, url: 'https://github.com/o/admin/pull/312', state: 'green' },
    ] });
    await post('/api/board', { title: 'Model vendors: merge', mission: 'MODEL_MAP', blocks: [
      { kind: 'question', prompt: 'Merge both PRs?', widget: 'single', action: 'merge', options: [{ label: 'Merge' }, { label: 'Hold' }] },
    ] });
    // A board after the merge round: the card still opens the round waiting on the PM.
    await post('/api/board', { title: 'Model vendors: notes', mission: 'MODEL_MAP', blocks: [{ kind: 'markdown', text: 'Notes' }] });
    await live('FILETYPE_FOLLOWUP', { title: 'File types, part 2', summary: 'Wave 2 of 3, 4 owners', next: 'wave 3',
      prs: [{ repo: 'service', number: 1866, url: 'https://github.com/o/service/pull/1866', state: 'draft' }] });
    await post('/api/board', { title: 'File types: wave 2', mission: 'FILETYPE_FOLLOWUP', blocks: [{ kind: 'markdown', text: 'Wave 2' }] });
    await live(TITLE_ONLY, { title: 'Release notes' });
    await live('ANNOUNCEMENTS', { title: 'In-app announcements', summary: 'Wave 1 of 2, 3 owners' });
    await live('BANK_EXPORT', { title: 'Bank export', summary: 'Wave 1 of 1, 1 owner' });
    await post('/api/board', { title: 'Bank export: plan', mission: 'BANK_EXPORT', blocks: [{ kind: 'markdown', text: 'Plan' }] });
    await post('/api/mission/SCHEDULED', { title: 'Scheduled steps', phase: 'landing', state: 'waiting', waitingOn: 'checks on service #1880' });
    await post('/api/mission/PAGE_READ_ROLLOUT', { title: 'Page reading rollout', phase: 'direct', state: 'queued', next: 'starts when a slot frees' });
    await post('/api/mission/SMALL_FIXES', { title: 'Security small fixes', phase: 'direct', state: 'working', summary: 'Silent since its last step' });
    await post('/api/mission/SMALL_FIXES/session', { pid: await deadPid() });
    await post(`/api/mission/${LONG}`, { title: longText(200, 'title'), phase: 'direct', state: 'waiting',
      summary: longText(280, 'summary'), waitingOn: longText(280, 'waiting'), next: longText(280, 'next') });
    await post('/api/mission/ESTATE_GOLDENS', { title: 'Estate case goldens', phase: 'landing', state: 'released', summary: 'Released, nothing left',
      prs: [{ repo: 'service', number: 1862, url: 'https://github.com/o/service/pull/1862', state: 'merged' }] });

    const tabSession = (id, fields) => ({ id, pid: null, procStart: null, kind: 'interactive', jobId: null, cwd: '/Users/pm/work/tab-repo',
      login: '/Users/pm/.claude-a', name: null, status: 'busy', reason: null, ...fields });
    await post('/api/sessions', { intervalMs: 600000, sessions: [
      tabSession('tab-long', { kind: 'bg', jobId: 'job-long', name: longText(200, 'tabname'), status: 'blocked', reason: longText(300, 'reason') }),
      tabSession('tab-short', { pid: 61002, procStart: '2026-10-29T11:10:15Z', name: '/grill' }),
    ] });

    const counts = Object.fromEntries(COLUMNS.map(c => [c, 0]));
    const overview = await getJson(`${origin}/api/missions`, daemon.secret);
    for (const m of overview.missions) counts[m.view === 'queued' ? 'waiting' : m.view] += 1;
    for (const t of overview.tabs) counts[t.state] += 1;
    assert.deepEqual(overview.tabs.map(t => `${t.id} ${t.state}`).sort(), ['tab-long needs-you', 'tab-short working'], 'setup: both tabs listed');
    const byKey = Object.fromEntries(overview.missions.map(m => [m.key, m]));
    // Where a click on a card lands: the round waiting on the PM, else the latest board.
    const target = {
      MODEL_MAP: `/b/${byKey.MODEL_MAP.actions[0].board}`,
      FILETYPE_FOLLOWUP: `/b/${byKey.FILETYPE_FOLLOWUP.boards.at(-1).id}`,
    };
    assert.notEqual(target.MODEL_MAP, `/b/${byKey.MODEL_MAP.boards.at(-1).id}`, 'setup: MODEL_MAP posted a board after its merge round');
    // The cards Stop is offered on: a live session with no stop on its way, and every tab.
    const stoppable = [...overview.missions.filter(m => m.live).map(m => m.key), ...overview.tabs.map(t => `tab:${t.id}`)].sort();

    for (const [mode, classicScrollbars] of [['classic scrollbars', true], ['default scrollbars', false]]) {
      await withChrome({ tag: 'cb-missions', classicScrollbars }, async ({ send, onEvent }) => {
        const cookie = sessionToken(daemon.secret);
        const at = {};
        const narrow = {};
        for (const width of WIDTHS) {
          for (const theme of THEMES) {
            at[`${width} ${theme}`] = {
              missions: await measureTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme)),
              boards: await measureTab(send, onEvent, `${origin}/boards`, cookie, tabAt(width, theme)),
            };
          }
        }
        for (const theme of THEMES) narrow[theme] = await measureTab(send, onEvent, `${origin}/boards`, cookie, tabAt(NARROW, theme));

        for (const width of WIDTHS) {
          await row(`${mode}, setup at ${width}px: light and dark differ, every column holds its cards, Comment is on offer`, note => {
            const light = at[`${width} light`];
            const dark = at[`${width} dark`];
            note(`background light ${light.missions.background}, dark ${dark.missions.background}`);
            assert.notEqual(light.missions.background, dark.missions.background);
            for (const m of [light, dark]) {
              assert.deepEqual(Object.keys(m.missions.cols), COLUMNS, 'the five columns, in state order, and no other');
              assert.deepEqual(Object.fromEntries(COLUMNS.map(c => [c, m.missions.cols[c]?.cards])), counts);
              assert.equal(m.missions.commentOn, true);
            }
          });
        }

        for (const [key, m] of Object.entries(at)) {
          await row(`${mode}, at ${key}: every box in the top bar is the same on Missions with cards and on Boards`, note => {
            const wrong = [];
            for (const [name, b] of Object.entries(m.missions.parts)) {
              assert.ok(b && b.width > 0, `setup: ${name} found on Missions`);
              const o = m.boards.parts[name];
              const line = `${name}: ${px(b.left)},${px(b.top)} ${px(b.width)}x${px(b.height)}`;
              note(line);
              if (!o || ['left', 'top', 'width', 'height'].some(k => Math.abs(o[k] - b[k]) > 0.01)) {
                wrong.push(`${line} on Missions, ${o ? `${px(o.left)},${px(o.top)} ${px(o.width)}x${px(o.height)}` : 'missing'} on Boards`);
              }
            }
            assert.deepEqual(Object.keys(m.boards.parts).sort(), Object.keys(m.missions.parts).sort());
            assert.deepEqual(wrong, []);
          });

          await row(`${mode}, at ${key}: the five columns sit in one row across the bar's content width`, note => {
            const { content, cols } = m.missions;
            const boxes = COLUMNS.map(c => cols[c]);
            note(`bar content ${px(content.left)} + ${px(content.width)}; columns ${boxes.map(b => `${px(b.left)}+${px(b.width)}`).join(', ')}`);
            for (const b of boxes) {
              assert.ok(Math.abs(b.top - boxes[0].top) <= 0.5, 'one row');
              assert.ok(Math.abs(b.width - boxes[0].width) <= 0.5, 'equal widths');
              assert.ok(b.width >= 250, 'at least 250px each');
            }
            for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].left > boxes[i - 1].left + boxes[i - 1].width, 'in state order, apart');
            assert.ok(Math.abs(boxes[0].left - content.left) <= 0.5, 'the first starts where the bar\'s content does');
            const last = boxes[boxes.length - 1];
            assert.ok(Math.abs(last.left + last.width - (content.left + content.width)) <= 0.5, 'the last ends where it does');
          });
        }

        for (const [key, m] of Object.entries(at)) {
          await row(`${mode}, at ${key}: every mission card and tab card is as tall as its own text, 6px apart in its column`, note => {
            const { cards } = m.missions;
            const long = cards.find(c => c.key === LONG);
            const short = cards.find(c => c.key === TITLE_ONLY);
            assert.ok(long && short, 'setup: the long and the title-only cards are on the page');
            note(`title-only ${px(short.height)}, long ${px(long.height)}; foot gaps ${[...new Set(cards.map(c => px(c.footGap)))].join(', ')}`);
            assert.ok(short.height < long.height, 'a title-only card is shorter than one with every field');
            assert.deepEqual(cards.filter(c => Math.abs(c.footGap) > 1).map(c => `${c.key} ${px(c.footGap)}`), [],
              'no card has room between its last line and its foot');
            const apart = [];
            for (const col of COLUMNS) {
              const list = cards.filter(c => c.col === col).sort((a, b) => a.index - b.index);
              for (let i = 1; i < list.length; i++) apart.push(`${list[i].key} ${px(list[i].top - list[i - 1].top - list[i - 1].height)}`);
            }
            note(`apart: ${apart.join(', ')}`);
            assert.ok(apart.length > 0, 'setup: a column holds two cards');
            assert.deepEqual(apart.filter(a => a.split(' ')[1] !== '6px'), []);
          });

          await row(`${mode}, at ${key}: every card is padded 10 by 12 with 8px corners and no shadow, its title 13px medium, its key line 12px, no Open board button`, note => {
            const { cards } = m.missions;
            note(`${cards[0].pad}, ${cards[0].radius}, ${cards[0].shadow}, title ${cards[0].title}, key line ${cards[0].ident}`);
            const wrong = cards.filter(c => c.pad !== '10px 12px 10px 12px' || c.radius !== '8px' || c.shadow !== 'none'
              || c.title !== '13px 500' || (c.ident !== null && c.ident !== '12px') || c.openButtons !== 0);
            assert.deepEqual(wrong.map(c => `${c.key}: ${c.pad}, ${c.radius}, ${c.shadow}, ${c.title}, ${c.ident}, ${c.openButtons} open buttons`), []);
          });

          await row(`${mode}, at ${key}: Stop is offered only where a session can be stopped, and hidden at rest`, note => {
            const { cards } = m.missions;
            const offered = cards.filter(c => c.stop !== null);
            note(`Stop on ${offered.length} of ${cards.length} cards: ${[...new Set(offered.map(c => c.stop))].join(', ')}`);
            assert.deepEqual(offered.map(c => c.key).sort(), stoppable);
            assert.deepEqual(offered.filter(c => c.stop !== 'hidden').map(c => c.key), []);
          });

          await row(`${mode}, at ${key}: the long card cuts its title, summary and waiting on at two lines and next at one, with an ellipsis, under one fold`, note => {
            const { cuts, longFolds, cards } = m.missions;
            for (const [field, [, lines]] of Object.entries(CUTS)) {
              const c = cuts[field];
              assert.ok(c, `setup: the long card shows its ${field}`);
              note(`${field}: ${px(c.client)} shown of ${px(c.scroll)}, line-clamp ${c.clamp}`);
              assert.equal(String(c.clamp), String(lines), `${field} is clamped, which draws the ellipsis`);
              assert.ok(Math.abs(c.client - lines * c.lineHeight) <= 1, `${field} shows ${lines} line(s)`);
              assert.ok(c.scroll > c.client + 1, `${field} has more than it shows`);
            }
            assert.equal(longFolds, 1, 'one fold on the card');
            assert.equal(cards.find(c => c.key === LONG).fold, 'block', 'the fold shows while text is cut');
            const short = cards.find(c => c.key === 'BANK_EXPORT');
            assert.equal(short.fold, 'none', 'a card whose text all fits shows no fold, and keeps no room for it');
          });

          await row(`${mode}, at ${key}: the long tab card cuts its name and blocked reason at two lines, with an ellipsis, under one fold`, note => {
            const { tabCuts, longTabFolds, cards } = m.missions;
            for (const field of ['title', 'reason']) {
              const c = tabCuts[field];
              assert.ok(c, `setup: the long tab card shows its ${field}`);
              note(`${field}: ${px(c.client)} shown of ${px(c.scroll)}, line-clamp ${c.clamp}`);
              assert.equal(String(c.clamp), '2', `${field} is clamped, which draws the ellipsis`);
              assert.ok(Math.abs(c.client - 2 * c.lineHeight) <= 1, `${field} shows 2 lines`);
              assert.ok(c.scroll > c.client + 1, `${field} has more than it shows`);
            }
            assert.equal(longTabFolds, 1, 'one fold on the tab card');
            assert.equal(cards.find(c => c.key === LONG_TAB).fold, 'block', 'the fold shows while text is cut');
            assert.equal(cards.find(c => c.key === 'tab:tab-short').fold, null, 'a short tab card has no fold');
          });
        }

        const boardsAt = [
          ...Object.entries(at).map(([key, m]) => [key, m.boards]),
          ...Object.entries(narrow).map(([theme, m]) => [`${NARROW} ${theme}`, m]),
        ];
        for (const [key, m] of boardsAt) {
          await row(`${mode}, at ${key}: the Boards view is one list in one panel under the filter, a ${LINE}px line a board, Waiting on you over Earlier, each header with its count`, note => {
            const { content, boardList: b } = m;
            assert.ok(b, 'setup: the Boards view has its list');
            assert.equal(b.panels, 1, 'one panel');
            note(`list ${px(b.list.left)} + ${px(b.list.width)} at ${px(b.list.top)}; filter ends at ${px(b.form.top + b.form.height)}; content ${px(content.left)} + ${px(content.width)}`);
            assert.ok(b.form.top + b.form.height <= b.list.top, 'the filter sits above the list');
            assert.ok(Math.abs(b.list.left - content.left) <= 0.5 && Math.abs(b.list.width - content.width) <= 0.5, 'the list runs the bar\'s content width');
            note(b.groups.map(g => `${g.label} ${g.count}: ${g.lines.length} lines`).join('; '));
            assert.deepEqual(b.groups.map(g => [g.key, g.label]), [['waiting', 'Waiting on you'], ['earlier', 'Earlier']]);
            const lines = b.groups.flatMap(g => g.lines);
            assert.ok(lines.length >= BOARDS + 2, 'setup: every board is on the view');
            for (const g of b.groups) {
              assert.equal(g.count, g.lines.length, `${g.label} counts its own lines`);
              assert.ok(g.lines.every(l => l.live === (g.key === 'waiting' ? 'true' : 'false')), `${g.label} holds exactly the boards ${g.key === 'waiting' ? 'with' : 'without'} a round waiting`);
              assert.ok(g.head.top + g.head.height <= g.lines[0].top + 0.5, `${g.label}'s header sits above its boards`);
            }
            const lastWaiting = b.groups[0].lines[b.groups[0].lines.length - 1];
            assert.ok(lastWaiting.top + lastWaiting.height <= b.groups[1].head.top + 0.5, 'Earlier starts under the last waiting board');
            const heights = [...new Set(lines.map(l => px(l.height)))];
            note(`line heights ${heights.join(', ')}`);
            assert.ok(lines.every(l => Math.abs(l.height - LINE) <= 1), `every line ${LINE}px tall, within 1px`);
            for (let i = 1; i < lines.length; i++) assert.ok(lines[i].top >= lines[i - 1].top + lines[i - 1].height - 0.5, 'one board a line');
            assert.ok(lines.every(l => l.left >= b.list.left && l.left + l.width <= b.list.left + b.list.width + 0.5), 'every line inside the one panel');
            const t = b.longTitle;
            assert.ok(t, 'setup: the long-titled board is on the view');
            note(`long title: ${px(t.client)} shown of ${px(t.scroll)}, ${px(t.height)} tall at line-height ${px(t.lineHeight)}`);
            assert.deepEqual([t.whiteSpace, t.textOverflow], ['nowrap', 'ellipsis'], 'cut on one line with an ellipsis');
            assert.ok(t.scroll > t.client + 1, 'the title has more than it shows');
            assert.ok(t.height <= t.lineHeight + 1, 'one line tall');
          });
        }

        await row(`${mode}: no view scrolls sideways`, note => {
          const wrong = [];
          for (const [key, m] of Object.entries(at)) {
            for (const view of ['missions', 'boards']) {
              if (m[view].scrollW > m[view].docW) wrong.push(`${key} ${view}: ${m[view].scrollW}px in ${m[view].docW}px`);
            }
          }
          for (const [theme, m] of Object.entries(narrow)) {
            if (m.scrollW > m.docW) wrong.push(`${NARROW} ${theme} boards: ${m.scrollW}px in ${m.docW}px`);
          }
          note(`${Object.keys(at).length * 2 + Object.keys(narrow).length} pages`);
          assert.deepEqual(wrong, []);
        });
      });
    }

    await withChrome({ tag: 'cb-missions-stop' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      await row('Stop, double-pressed with Cmd held, sends one stop order with no question, says so on the card, and opens no board', async note => {
        const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(1440, 'light'));
        try {
          const card = 'article.mission-card[data-mission-key="BANK_EXPORT"]';
          assert.ok(await tab.evalPage(`document.querySelector('${card}').getAttribute('data-href')`), 'setup: the card opens a board');
          await tab.evalPage(`window.__opened = []; window.open = function (u) { window.__opened.push(u); return null; }`);
          await press(tab, `${card} button.mission-stop`, 4, 2);
          const said = await tab.until(`(document.querySelector('${card} p.mission-order') || {}).textContent`, 'the order line');
          note(said);
          assert.equal(said, 'Stop asked: waiting for the Master Chief to relay it');
          assert.equal(await ordersSent(tab, 'BANK_EXPORT'), 1, 'one order left the tab for the two presses');
          assert.equal(await tab.evalPage(`!!document.querySelector('${card} div.mission-confirm')`), false, 'no question');
          assert.deepEqual(await tab.evalPage('window.__opened'), [], 'the second press opens no board');
          const orders = (await getJson(`${origin}/api/mission/BANK_EXPORT`, daemon.secret)).orders;
          note(`orders: ${orders.map(o => o.kind).join(', ')}`);
          assert.deepEqual(orders.map(o => o.kind), ['stop']);
        } finally {
          await tab.close();
        }
      });

      await row('Stop, pressed plain or with Ctrl, Shift or Alt held, only asks, and Keep shuts the question', async note => {
        const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(1440, 'light'));
        try {
          const card = 'article.mission-card[data-mission-key="ANNOUNCEMENTS"]';
          for (const [held, modifiers] of [['plain', 0], ['Ctrl', 2], ['Shift', 8], ['Alt', 1]]) {
            await press(tab, `${card} button.mission-stop`, modifiers);
            await tab.until(`!!document.querySelector('${card} div.mission-confirm')`, `the Stop question on a ${held} press`);
            assert.equal(await ordersSent(tab, 'ANNOUNCEMENTS'), 0, `${held}: no order left the tab`);
            assert.deepEqual((await getJson(`${origin}/api/mission/ANNOUNCEMENTS`, daemon.secret)).orders, [], `${held}: nothing is posted`);
            await press(tab, `${card} button.mission-stop-cancel`);
            await tab.until(`!document.querySelector('${card} div.mission-confirm')`, `Keep after a ${held} press`);
            note(`${held}: asked, nothing posted`);
          }
        } finally {
          await tab.close();
        }
      });

      for (const width of WIDTHS) {
        for (const theme of THEMES) {
          await row(`Stop and Keep sit side by side on one line, at ${width}px ${theme}`, async note => {
            const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme));
            try {
              const card = 'article.mission-card[data-mission-key="FILETYPE_FOLLOWUP"]';
              await press(tab, `${card} button.mission-stop`);
              const boxes = await tab.until(`(function () {
                var stop = document.querySelector('${card} button.mission-stop-confirm');
                var keep = document.querySelector('${card} button.mission-stop-cancel');
                if (!stop || !keep) return null;
                var s = stop.getBoundingClientRect(), k = keep.getBoundingClientRect();
                return { stop: { text: stop.textContent, top: s.top, right: s.right }, keep: { text: keep.textContent, top: k.top, left: k.left } };
              })()`, 'the Stop question');
              note(`${boxes.stop.text} top ${px(boxes.stop.top)}, ${boxes.keep.text} top ${px(boxes.keep.top)}`);
              assert.deepEqual([boxes.stop.text, boxes.keep.text], ['Stop', 'Keep']);
              assert.ok(Math.abs(boxes.stop.top - boxes.keep.top) <= 2, 'one line');
              assert.ok(boxes.keep.left > boxes.stop.right, 'Keep beside Stop, after it');
              await press(tab, `${card} button.mission-stop-cancel`);
            } finally {
              await tab.close();
            }
          });
        }
      }

      await row('Stop, pressed with a mouse, asks once, then sends the order and says so on the card', async note => {
        const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(1440, 'light'));
        try {
          const card = 'article.mission-card[data-mission-key="ANNOUNCEMENTS"]';
          await press(tab, `${card} button.mission-stop`);
          const asked = await tab.until(`(document.querySelector('${card} p.mission-confirm-text') || {}).textContent`, 'the Stop question');
          note(asked);
          assert.equal(await ordersSent(tab, 'ANNOUNCEMENTS'), 0, 'the first press sends no order');
          assert.deepEqual((await getJson(`${origin}/api/mission/ANNOUNCEMENTS`, daemon.secret)).orders, [], 'the first press only asks');
          const focused = await tab.evalPage(`document.activeElement && document.activeElement.textContent`);
          assert.equal(focused, 'Stop', 'the question takes the focus to its own Stop');

          await press(tab, `${card} button.mission-stop-confirm`);
          const said = await tab.until(`(document.querySelector('${card} p.mission-order') || {}).textContent`, 'the order line');
          note(said);
          assert.equal(said, 'Stop asked: waiting for the Master Chief to relay it');
          const orders = (await getJson(`${origin}/api/mission/ANNOUNCEMENTS`, daemon.secret)).orders;
          assert.deepEqual(orders.map(o => o.kind), ['stop']);
        } finally {
          await tab.close();
        }
      });

      for (const width of WIDTHS) {
        for (const theme of THEMES) {
          await row(`a click on a card's body opens its latest board, at ${width}px ${theme}`, async note => {
            const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme));
            try {
              // The release that clicks may answer from a page already navigating away.
              await press(tab, 'article.mission-card[data-mission-key="FILETYPE_FOLLOWUP"] b.mission-title').catch(err => {
                if (!/Not attached to an active page/.test(err.message)) throw err;
              });
              const landed = await landedAt(tab);
              note(`landed on ${landed}`);
              assert.equal(landed, target.FILETYPE_FOLLOWUP);
            } finally {
              await tab.close();
            }
          });

          await row(`Enter on a focused card opens the round waiting on the PM, not its later board, at ${width}px ${theme}`, async note => {
            const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme));
            try {
              await tab.evalPage(`document.querySelector('article.mission-card[data-mission-key="MODEL_MAP"]').focus()`);
              await pressKey(tab, 'Enter');
              const landed = await landedAt(tab);
              note(`landed on ${landed}`);
              assert.equal(landed, target.MODEL_MAP);
            } finally {
              await tab.close();
            }
          });

          await row(`Stop shows on a card's keyboard focus, takes the next Tab, and shows on its hover, at ${width}px ${theme}`, async note => {
            const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme));
            const seen = sel => tab.evalPage(`getComputedStyle(document.querySelector('${sel} button.mission-stop')).visibility`);
            try {
              const focused = 'article.mission-card[data-mission-key="tab:tab-short"]';
              const hovered = `article.mission-card[data-mission-key="${TITLE_ONLY}"]`;
              assert.deepEqual([await seen(focused), await seen(hovered)], ['hidden', 'hidden'], 'setup: both at rest');
              await tab.evalPage(`document.querySelector('${focused}').focus()`);
              const onFocus = await seen(focused);
              await pressKey(tab, 'Tab');
              const next = await tab.evalPage(`document.activeElement === document.querySelector('${focused} button.mission-stop')`);
              note(`focus: ${onFocus}, the next Tab on Stop: ${next}`);
              assert.equal(onFocus, 'visible');
              assert.equal(next, true);
              await tab.evalPage('document.activeElement.blur()');
              const at = await tab.evalPage(`(function () {
                var el = document.querySelector('${hovered} b.mission-title');
                el.scrollIntoView({ block: 'center' });
                var r = el.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              })()`);
              assert.equal(await seen(hovered), 'hidden', 'setup: the mouse is not on it yet');
              await tab.sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none', modifiers: 0, clickCount: 0 });
              const onHover = await seen(hovered);
              note(`hover: ${onHover}`);
              assert.equal(onHover, 'visible');
            } finally {
              await tab.close();
            }
          });
        }
      }

      await row('Show the rest opens the long card\'s every field whole, grows only that card, and stays open across a repaint', async note => {
        const tab = await openTab(send, onEvent, `${origin}/`, cookie, tabAt(1440, 'light'));
        try {
          const card = `article.mission-card[data-mission-key="${LONG}"]`;
          const heights = `(function () {
            var out = {};
            [].slice.call(document.querySelectorAll('article.mission-card')).forEach(function (c) { out[c.getAttribute('data-mission-key')] = c.getBoundingClientRect().height; });
            return out;
          })()`;
          const before = await tab.evalPage(heights);
          await press(tab, `${card} details.mission-more > summary`);
          const whole = `(function () {
            var c = document.querySelector('${card}');
            if (!c || !c.querySelector('details.mission-more[open]')) return null;
            var shown = {};
            ${JSON.stringify(Object.entries(CUTS))}.forEach(function (e) {
              var el = c.querySelector(e[1][0]);
              shown[e[0]] = { text: el.textContent, client: el.clientHeight, scroll: el.scrollHeight, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)) };
            });
            return shown;
          })()`;
          const shown = await tab.until(whole, 'the fold opening');
          const after = await tab.evalPage(heights);
          for (const [field, [, lines]] of Object.entries(CUTS)) {
            note(`${field}: ${shown[field].lines} lines, ${shown[field].text.length} characters`);
            assert.ok(shown[field].scroll <= shown[field].client + 1, `${field} shows whole`);
            assert.ok(shown[field].lines > lines, `${field} runs past its ${lines} line(s)`);
          }
          note(`card ${px(before[LONG])} to ${px(after[LONG])}`);
          assert.ok(after[LONG] > before[LONG], 'the open card grows');
          assert.deepEqual(Object.keys(after).filter(k => k !== LONG && Math.abs(after[k] - before[k]) > 0.5), [], 'no other card moves its height');

          const next = longText(280, 'later');
          await post(`/api/mission/${LONG}`, { phase: 'direct', state: 'waiting', next });
          await tab.until(`(document.querySelector('${card} p.mission-next') || {}).textContent === ${JSON.stringify('Next' + next)}`, 'the repaint');
          assert.equal(await tab.evalPage(`!!document.querySelector('${card} details.mission-more[open]')`), true, 'still open after the repaint');
        } finally {
          await tab.close();
        }
      });
    });

    await withChrome({ tag: 'cb-missions-boards' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const groupsExpr = `[].slice.call(document.querySelectorAll('div.thread-group')).map(function (g) {
        var head = g.querySelector('h2.thread-group-head');
        var count = head.querySelector('.thread-group-count').textContent;
        return head.textContent.slice(0, -count.length).trim() + ' ' + count + ': '
          + [].slice.call(g.querySelectorAll('div.thread-title')).map(function (t) { return t.textContent; }).sort().join(', ');
      })`;
      for (const width of [NARROW, ...WIDTHS]) {
        await row(`at ${width}px: the filter narrows both groups and leaves an emptied group out`, async note => {
          const filtered = {};
          for (const q of ['invoice reminders', 'session 1']) {
            const tab = await openTab(send, onEvent, `${origin}/boards?q=${encodeURIComponent(q)}`, cookie, { width, height: HEIGHT, theme: 'dark', expr: groupsExpr });
            try {
              filtered[q] = tab.measured;
              note(`${q}: ${tab.measured.join('; ')}`);
            } finally {
              await tab.close();
            }
          }
          assert.deepEqual(filtered['invoice reminders'], ['Waiting on you 1: Invoice reminders: grill', 'Earlier 1: Invoice reminders: notes']);
          assert.deepEqual(filtered['session 1'], ['Earlier 6: Session 1, Session 10, Session 11, Session 12, Session 13, Session 14'], 'no Waiting on you header with nothing waiting');
        });

        await row(`at ${width}px: a press anywhere on a board's line opens that board, its far end included`, async note => {
          const tab = await openTab(send, onEvent, `${origin}/boards`, cookie, { width, height: HEIGHT, theme: 'dark', expr: '1' });
          try {
            const target = await tab.evalPage(`(function () {
              var a = [].slice.call(document.querySelectorAll('a.thread-item')).filter(function (l) {
                return l.querySelector('div.thread-title').textContent === 'Session 3';
              })[0];
              a.scrollIntoView({ block: 'center' });
              var r = a.getBoundingClientRect();
              return { href: a.getAttribute('href'), x: r.right - 6, y: r.top + r.height / 2 };
            })()`);
            note(`press at ${px(target.x)},${px(target.y)}, the line's last 6px`);
            await tab.sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'left', clickCount: 0 });
            for (const type of ['mousePressed', 'mouseReleased']) {
              await tab.sp('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
            }
            let at = null;
            for (let i = 0; i < 50 && at !== target.href; i++) {
              await sleep(100);
              at = await tab.evalPage('location.pathname + location.hash').catch(() => null);
            }
            note(`landed on ${at}`);
            assert.equal(at, target.href, 'the board the line names opened');
          } finally {
            await tab.close();
          }
        });
      }
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
