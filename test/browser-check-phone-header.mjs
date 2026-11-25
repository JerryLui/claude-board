// Real-browser check for the round page's phone header (ADR.md entries 40, 59, 152). At
// 560px wide and under nothing is fixed at the top but two buttons: the board's title,
// clamped to two lines, and the round's state line (its label, then its state, the
// deadline while it is awaited) are page text that scrolls away, the mark floats in the
// top left corner going where it always went, and a ⋯ button in the top right opens a
// menu holding Comment, the theme control, Download round and the board's and thread's
// ids, by keyboard as by touch. No countdown shows anywhere else, and nothing fixed lies
// over a card save the two buttons, the round pill, the send bar, Back to top and notices;
// a read-only page has no home button. A full-page round pads
// its mock under the two buttons, and they leave while the mock's own full-size view is
// open. At 1280 the header, its condensing pill and the round caption are as before.
//
// Layout, hit-testing and focus, which the DOM stand-in has none of (QUIRKS.md "The DOM
// stand-in's ceilings").
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-phone-header.mjs

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { repoRoot, runMain, sleep } from './support.mjs';
import { clickAt, copyArchive, evalIn, guardRun, openPhone, openTab, postJson, requireChrome, row, startScratchDaemon, withChrome } from './browser-support.mjs';

guardRun('browser-check-phone-header', { deadlineMs: 180000 });

const TITLE = 'Service agent doc batch: scope and the firm-wide hit list';
const ROUND_TITLE = 'Landing brief';
const MOCK = readFileSync(path.join(repoRoot, 'test', 'fixtures', 'lens-mock.html'), 'utf8');
const PARA = 'A paragraph long enough to wrap over several lines of a phone, so the round runs well past one screen. ';
const QUESTION = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const COUNTDOWN = /^\d+m left$/;
const KEYS = { Enter: [13, 36, '\r'], Tab: [9, 48, '\t'], Escape: [27, 53, '\u001b'] };

/** Presses `key` on whatever has the tab's focus, as a Mac keyboard does (QUIRKS.md "A
 * synthetic key with no character opens chrome://help"). */
async function pressKey(tab, key) {
  const [code, mac, text] = KEYS[key];
  const down = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: mac, text, unmodifiedText: text };
  await tab.sp('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...down });
  await tab.sp('Input.dispatchKeyEvent', { type: 'keyUp', ...down });
  await sleep(50);
}

/** Presses an arrow, Home or End key, which carries no character: no native key code, so
 * Chrome opens nothing in front (QUIRKS.md "A synthetic key with no character opens
 * chrome://help"). */
async function pressNavKey(tab, key) {
  const down = { key, code: key, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[key] };
  await tab.sp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...down });
  await tab.sp('Input.dispatchKeyEvent', { type: 'keyUp', ...down });
  await sleep(50);
}

/** Stands in for the clipboard, the page's one way out to the system: what the
 * clipboard API is given, or with `api` false no API and what `execCommand('copy')`
 * finds selected, lands in `window.__copied`. */
const CLIPBOARD_STAND_IN = api => `(function () {
  window.__copied = null;
  var clip = ${api} ? { writeText: function (text) { window.__copied = text; return Promise.resolve(); } } : undefined;
  Object.defineProperty(Navigator.prototype, 'clipboard', { get: function () { return clip; }, configurable: true });
  document.execCommand = function (cmd) {
    var f = document.activeElement;
    window.__copied = cmd + ': ' + f.value.slice(f.selectionStart, f.selectionEnd);
    return true;
  };
})()`;

/** A touch screen `width` by `height`, as openPhone opens 390 by 844. */
function openTouch(send, onEvent, url, cookie, { width, height, prepare = null }) {
  return openTab(send, onEvent, url, cookie, {
    width, height, theme: 'dark', expr: '1',
    prepare: async (sp, sessionId) => {
      await sp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
      await sp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      if (prepare) await prepare(sp, sessionId);
    },
  });
}

/** What the top of the page draws: the header, its title and state line, the two corner
 * buttons, the first card, and every element on screen whose own text is a countdown. */
const TOP_EXPR = `(function () {
  document.documentElement.style.scrollBehavior = 'auto';
  function box(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height), shown: el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true }),
      position: getComputedStyle(el).position };
  }
  var h1 = document.querySelector('.board-head h1');
  var lh = parseFloat(getComputedStyle(h1).lineHeight);
  var counting = [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
    var own = [].slice.call(el.childNodes).filter(function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join('').trim();
    if (!/^\\d+m left$/.test(own) || !el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })) return false;
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.width > 0;
  }).map(function (el) { return el.className || el.tagName; });
  var fixedTop = [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    var r = el.getBoundingClientRect();
    return r.top < 60 && r.height > 0 && r.width > 0 && el.checkVisibility({ checkVisibilityCSS: true });
  }).map(function (el) { return el.className; });
  return {
    innerW: innerWidth, scrollW: document.documentElement.scrollWidth, scrollY: scrollY,
    head: box(document.querySelector('header.board-head')),
    title: Object.assign(box(h1), { lines: Math.round(h1.getBoundingClientRect().height / lh), clipped: h1.scrollHeight > h1.clientHeight + 1 }),
    line: box(document.querySelector('.head-round')),
    label: document.querySelector('.head-round-label').textContent,
    state: document.querySelector('.head-round-state').textContent,
    home: box(document.querySelector('a.back-to-index')),
    homeHref: document.querySelector('a.back-to-index').getAttribute('href'),
    more: box(document.querySelector('button.corner-more-btn')),
    card: box(document.querySelector('.round-current .block')),
    counting: counting, fixedTop: fixedTop,
  };
})()`;

/** The ⋯ menu as it stands: open or not, the focused element, and each item a screen
 * reader is offered (role, name, checked state). */
const MENU_EXPR = `(function () {
  var menu = document.querySelector('div.corner-menu');
  var focus = document.activeElement;
  return {
    open: !menu.hidden && menu.checkVisibility({ checkVisibilityCSS: true }),
    expanded: document.querySelector('button.corner-more-btn').getAttribute('aria-expanded'),
    role: menu.getAttribute('role'),
    focus: focus ? (focus.matches('button.corner-more-btn') ? 'more' : (focus.closest('.corner-menu') ? focus.textContent.replace(/\\s+/g, ' ').trim() : focus.tagName.toLowerCase())) : null,
    items: [].slice.call(menu.querySelectorAll('[role^="menuitem"]')).filter(function (el) {
      return el.checkVisibility({ checkVisibilityCSS: true });
    }).map(function (el) {
      var r = el.getBoundingClientRect();
      return { role: el.getAttribute('role'), name: el.textContent.replace(/\\s+/g, ' ').trim(), checked: el.getAttribute('aria-checked'), h: Math.round(r.height), inWindow: r.left >= 0 && r.right <= innerWidth };
    }),
    theme: document.documentElement.getAttribute('data-theme') || 'system',
    commenting: document.body.classList.contains('comment-mode'),
  };
})()`;

/** The first class of every outermost fixed or sticky element drawn over a card of the
 * round in view, at the page's scroll as it stands. */
const OVER_CARDS_EXPR = `(function () {
  var cards = [].slice.call(document.querySelectorAll('.round-current .block')).map(function (el) { return el.getBoundingClientRect(); });
  function pinned(el) { var p = getComputedStyle(el).position; return p === 'fixed' || p === 'sticky'; }
  return [].slice.call(document.querySelectorAll('body *')).filter(function (el) {
    if (!pinned(el) || !el.checkVisibility({ checkVisibilityCSS: true, opacityProperty: true })) return false;
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) if (pinned(p)) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= innerHeight) return false;
    return cards.some(function (c) { return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top; });
  }).map(function (el) { return el.classList[0] || el.tagName.toLowerCase(); });
})()`;
const OVER_CARDS_ALLOWED = ['back-to-index', 'corner-more-btn', 'round-pager-dock', 'send-bar', 'back-to-top', 'notice'];

/** With CLAUDE_BOARD_PHONE_HEADER_KEEP set to a folder, a screenshot of the tab there. */
async function keep(tab, name) {
  const dir = process.env.CLAUDE_BOARD_PHONE_HEADER_KEEP;
  if (!dir) return;
  const { data } = await tab.sp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

function assertCorners(m, note, what) {
  note(`${what}: home ${m.home.w}x${m.home.h} at ${m.home.x},${m.home.y}; ⋯ ${m.more.w}x${m.more.h} at ${m.more.x},${m.more.y}`);
  for (const [name, b] of [['home', m.home], ['⋯', m.more]]) {
    assert.equal(b.position, 'fixed', `${name} floats`);
    assert.equal(b.shown, true, `${name} shows`);
    assert.ok(b.w >= 44 && b.h >= 44, `${name} is at least 44px square`);
    assert.ok(b.y >= 0 && b.y <= 16, `${name} sits in the top edge`);
  }
  assert.ok(m.home.x <= 16, 'home sits in the left corner');
  assert.ok(m.more.r >= m.innerW - 16 && m.more.r <= m.innerW, '⋯ sits in the right corner');
}

async function main() {
  requireChrome('browser-check-phone-header');
  const daemon = await startScratchDaemon('cb-phone-header');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    const urlOf = created => `${origin}${new URL(created.url).pathname}`;

    const first = await post({ title: TITLE, blocks: [QUESTION] });
    await postJson(`${origin}/api/board/${first.boardId}/submit`, { round: 1, action: 'send', answers: [], comments: [] }, daemon.secret);
    const round = await post({
      boardId: first.boardId, title: ROUND_TITLE, wait: true,
      blocks: [
        { kind: 'markdown', text: PARA.repeat(6) },
        { kind: 'html', html: '<p style="padding:12px">A stage, so the round is commentable.</p>' },
        QUESTION,
        { kind: 'markdown', text: PARA.repeat(12) },
      ],
    });
    const roundUrl = urlOf(round);
    const page = await post({ title: TITLE, wait: true, blocks: [{ id: 'h1', kind: 'html', html: MOCK }] });
    const pageUrl = urlOf(page);

    await withChrome({ tag: 'cb-phone-header' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);

      for (const [what, open] of [
        ['390 by 844', () => openPhone(send, onEvent, roundUrl, cookie)],
        ['320 by 640', () => openTouch(send, onEvent, roundUrl, cookie, { width: 320, height: 640 })],
      ]) {
        await row(`at ${what} the round page has no fixed header: the title and the round's state line scroll away, home and ⋯ float in the top corners, and no countdown shows but the state line's`, async note => {
          const tab = await open();
          try {
            const rest = await tab.evalPage(TOP_EXPR);
            note(`at rest: title ${rest.title.lines} line(s)${rest.title.clipped ? ', clamped' : ''}; state line "${rest.label}", "${rest.state}"; first card at ${rest.card.y}px; fixed at the top: ${rest.fixedTop.join(', ')}`);
            assert.equal(rest.scrollW, rest.innerW, 'the page scrolls nothing sideways');
            assert.equal(rest.head.position, 'static', 'the header is page text');
            assert.deepEqual(rest.fixedTop.sort(), ['back-to-index', 'corner-more-btn'], 'nothing else is fixed at the top');
            assert.equal(rest.title.lines, 2, 'the title takes two lines');
            assert.equal(rest.title.clipped, rest.innerW === 320, 'setup: the title wraps to two lines at 390, and is clamped to them at 320');
            assert.ok(rest.title.x >= rest.home.r && rest.title.r <= rest.more.x, 'the title sits between the corner buttons');
            assert.deepEqual([rest.label, COUNTDOWN.test(rest.state)], [`Round 2 · ${ROUND_TITLE}`, true], 'the round\'s label joins its state, the deadline');
            await keep(tab, `round-${rest.innerW}-rest`);
            assert.equal(rest.line.shown, true);
            assert.deepEqual(rest.counting, ['head-round-state'], 'the state line is the one countdown on screen');
            assert.equal(rest.homeHref, '/', 'home goes where the logo goes');
            assertCorners(rest, note, 'at rest');
            if (rest.innerW === 390) assert.ok(rest.card.y <= 130, `the first card starts within 130px of the top (at ${rest.card.y}px)`);

            await tab.evalPage('window.scrollTo(0, 600)');
            await tab.quiet();
            const down = await tab.evalPage(TOP_EXPR);
            note(`scrolled to ${down.scrollY}px: title bottom ${down.title.b}px, state line bottom ${down.line.b}px`);
            assert.equal(down.scrollY, 600, 'setup: the round scrolls');
            assert.ok(down.title.b < 0 && down.line.b < 0, 'the title and the state line scrolled away');
            assert.deepEqual(down.counting, [], 'no countdown shows once the state line is gone');
            assertCorners(down, note, 'scrolled');
            await keep(tab, `round-${rest.innerW}-scrolled`);
            assert.deepEqual([down.home.x, down.home.y, down.more.x, down.more.y], [rest.home.x, rest.home.y, rest.more.x, rest.more.y], 'the corner buttons stay put');
          } finally {
            await tab.close();
          }
        });
      }

      await row('at 390 by 844 nothing fixed lies over the round\'s cards save the two corner buttons, the pill, the send bar, Back to top and notices', async note => {
        const tab = await openPhone(send, onEvent, roundUrl, cookie);
        try {
          const seen = new Set();
          const height = await tab.evalPage(`document.documentElement.style.scrollBehavior = 'auto'; document.documentElement.scrollHeight`);
          for (let y = 0; y < height; y += 300) {
            await tab.evalPage(`window.scrollTo(0, ${y})`);
            await tab.quiet();
            for (const name of await tab.evalPage(OVER_CARDS_EXPR)) seen.add(name);
          }
          note(`scrolled through ${height}px; over the cards: ${[...seen].join(', ')}`);
          assert.ok(seen.has('round-pager-dock') && seen.has('back-to-index') && seen.has('corner-more-btn'), 'setup: the pill and the corner buttons lie over the cards somewhere');
          assert.deepEqual([...seen].filter(name => !OVER_CARDS_ALLOWED.includes(name)), [], 'nothing else fixed lies over a card');
        } finally {
          await tab.close();
        }
      });

      await row('at 390 a round\'s file opened from disk floats a live ⋯ offering the board and thread ids, and no home button, having no home to go to', async note => {
        const { pageUrl: savedUrl } = copyArchive(path.join(daemon.home, 'pages'), round.boardId, 'cb-phone-header');
        const tab = await openPhone(send, onEvent, savedUrl, cookie);
        try {
          const m = await tab.evalPage(TOP_EXPR);
          assert.equal(await tab.evalPage(`document.body.classList.contains('readonly')`), true, 'setup: the saved copy is read-only');
          assert.deepEqual([m.home.shown, m.more.shown], [false, true]);
          await clickAt(tab, { x: m.more.x + m.more.w / 2, y: m.more.y + m.more.h / 2 });
          const opened = await tab.evalPage(MENU_EXPR);
          note(`items: ${opened.items.map(i => i.name).join(', ')}`);
          assert.equal(opened.open, true, 'a press on ⋯ opens the menu');
          const thread = await tab.evalPage(`JSON.parse(document.querySelector('script#board-data').textContent).thread`);
          assert.deepEqual(opened.items.slice(-2).map(i => i.name), [`Board ${round.boardId}`, `Thread ${thread}`]);
        } finally {
          await tab.close();
        }
      });

      await row('at 390 the ⋯ menu holds Comment, the theme control, Download round and the board and thread ids, reached by Tab and Enter, with menu roles, walked by the arrows, Home and End, copies an id on Enter with or without the clipboard API, and closes on Escape or a press outside', async note => {
        const tab = await openPhone(send, onEvent, roundUrl, cookie);
        try {
          await tab.evalPage(`document.activeElement && document.activeElement.blur()`);
          const path = [];
          for (let n = 0; n < 4; n++) {
            await pressKey(tab, 'Tab');
            const at = (await tab.evalPage(MENU_EXPR)).focus;
            path.push(at);
            if (at === 'more') break;
          }
          note(`Tab from the top: ${path.join(' -> ')}`);
          assert.equal(path[path.length - 1], 'more', 'Tab reaches ⋯');

          await pressKey(tab, 'Enter');
          const opened = await tab.evalPage(MENU_EXPR);
          note(`items: ${opened.items.map(i => `${i.role} "${i.name}"`).join(', ')}`);
          assert.deepEqual([opened.open, opened.expanded, opened.role], [true, 'true', 'menu'], 'Enter opens it as a menu');
          assert.deepEqual(opened.items.map(i => [i.role, i.name]), [
            ['menuitemcheckbox', 'Comment'],
            ['menuitem', 'Theme: System'],
            ['menuitem', 'Download round'],
            ['menuitem', `Board ${round.boardId}`],
            ['menuitem', `Thread ${await tab.evalPage(`JSON.parse(document.querySelector('script#board-data').textContent).thread`)}`],
          ]);
          assert.ok(opened.items.every(i => i.h >= 44 && i.inWindow), 'each item at least 44px tall and inside the window');
          assert.equal(opened.focus, 'Comment', 'the first item takes the focus');
          await keep(tab, 'menu-open');

          const visited = [opened.focus];
          for (let n = 1; n < opened.items.length; n++) {
            await pressKey(tab, 'Tab');
            visited.push((await tab.evalPage(MENU_EXPR)).focus);
          }
          assert.deepEqual(visited, opened.items.map(i => i.name), 'Tab walks every item in order');

          await pressKey(tab, 'Escape');
          const closed = await tab.evalPage(MENU_EXPR);
          assert.deepEqual([closed.open, closed.expanded, closed.focus], [false, 'false', 'more'], 'Escape closes it and hands the focus back to ⋯');

          await pressKey(tab, 'Enter');
          await pressKey(tab, 'Enter');
          const commenting = await tab.evalPage(MENU_EXPR);
          assert.deepEqual([commenting.commenting, commenting.open], [true, false], 'Enter on Comment turns comment mode on and closes the menu');
          await pressKey(tab, 'Enter');
          const reopened = await tab.evalPage(MENU_EXPR);
          assert.equal(reopened.items[0].checked, 'true', 'Comment reads checked');

          await tab.evalPage(`document.querySelector('.corner-menu [data-mirror]').focus()`);
          await pressKey(tab, 'Enter');
          const themed = await tab.evalPage(MENU_EXPR);
          note(`theme: ${opened.theme} -> ${themed.theme}, item "${themed.items[1].name}"`);
          assert.notEqual(themed.theme, opened.theme, 'Enter on the theme item switches the theme');
          assert.equal(themed.items[1].name, `Theme: ${themed.theme[0].toUpperCase()}${themed.theme.slice(1)}`, 'and it names the new one');
          assert.equal(themed.open, true, 'the menu stays open for another switch');

          const keyed = [];
          for (const key of ['End', 'Home', 'ArrowDown', 'ArrowUp']) {
            await pressNavKey(tab, key);
            keyed.push((await tab.evalPage(MENU_EXPR)).focus);
          }
          const names = themed.items.map(i => i.name);
          assert.deepEqual(keyed, [names[4], names[0], names[1], names[0]], 'End, Home and the arrows move through the items');

          await tab.evalPage(CLIPBOARD_STAND_IN(true));
          await pressNavKey(tab, 'End');
          await pressNavKey(tab, 'ArrowUp');
          await pressKey(tab, 'Enter');
          const copiedBoard = await tab.evalPage(MENU_EXPR);
          assert.equal(copiedBoard.items[3].name, `Copied ${round.boardId}`, 'Enter on the Board item says Copied');
          assert.equal(await tab.evalPage('window.__copied'), round.boardId, 'and the clipboard is given the board id');
          await sleep(1300);
          assert.equal((await tab.evalPage(MENU_EXPR)).items[3].name, `Board ${round.boardId}`, 'the label comes back');

          await tab.evalPage(CLIPBOARD_STAND_IN(false));
          await pressNavKey(tab, 'ArrowDown');
          await pressKey(tab, 'Enter');
          const copiedThread = await tab.evalPage(MENU_EXPR);
          const thread = await tab.evalPage(`JSON.parse(document.querySelector('script#board-data').textContent).thread`);
          assert.equal(copiedThread.items[4].name, `Copied ${thread}`, 'with no clipboard API the Thread item still says Copied');
          assert.equal(await tab.evalPage('window.__copied'), `copy: ${thread}`, 'and its fallback copies the thread id, selected');

          await clickAt(tab, { x: 195, y: 600 });
          const outside = await tab.evalPage(MENU_EXPR);
          assert.deepEqual([outside.open, outside.expanded], [false, 'false'], 'a press outside closes it');
        } finally {
          await tab.close();
        }
      });

      await row('at 390 a full-page round pads its mock under the corner buttons, its title leaves as the mock scrolls, and the buttons leave while the mock\'s full-size view is open', async note => {
        const frames = [];
        const tab = await openPhone(send, onEvent, pageUrl, cookie);
        try {
          await tab.sp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
          const { targetInfos } = await send('Target.getTargets');
          for (const t of targetInfos.filter(t => t.type === 'iframe')) {
            const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
            if (await evalIn(send, sessionId, `!!document.querySelector('[data-mock="lens"]')`)) frames.push(sessionId);
          }
          assert.equal(frames.length, 1, 'setup: one stage holds the mock');
          const stage = expr => evalIn(send, frames[0], expr);
          await tab.until(`document.body.classList.contains('page-board')`, 'the page board');
          let mockTop = 0;
          for (let n = 0; n < 40 && mockTop < 1; n++) {
            mockTop = await stage(`parseFloat(getComputedStyle(document.body).paddingTop)`);
            if (mockTop < 1) await sleep(100);
          }
          const firstTop = await stage(`Math.round(document.body.firstElementChild.getBoundingClientRect().top)`);
          const frameTop = await tab.evalPage(`Math.round(document.querySelector('.round-current iframe.html-stage').getBoundingClientRect().top)`);
          const rest = await tab.evalPage(TOP_EXPR);
          note(`the mock pads ${mockTop}px; its first element at ${frameTop + firstTop}px; the corner buttons end at ${Math.max(rest.home.b, rest.more.b)}px; state line "${rest.label}", "${rest.state}"`);
          assertCorners(rest, note, 'at rest');
          await keep(tab, 'page-rest');
          assert.ok(frameTop + firstTop >= Math.max(rest.home.b, rest.more.b), 'the mock starts below the corner buttons');
          assert.equal(rest.title.shown, true, 'the title shows at rest');
          assert.deepEqual(rest.counting, ['head-round-state'], 'the state line is the one countdown on screen');

          await stage('window.scrollTo(0, 300)');
          await tab.until(`document.body.classList.contains('stage-scrolled')`, 'the mock scrolling');
          await sleep(400);
          const scrolled = await tab.evalPage(TOP_EXPR);
          assert.deepEqual([scrolled.title.shown, scrolled.line.shown], [false, false], 'the title and the state line leave as the mock scrolls');
          assertCorners(scrolled, note, 'scrolled');
          await stage('window.scrollTo(0, 0)');
          await tab.until(`!document.body.classList.contains('stage-scrolled')`, 'the mock back at its top');

          await stage(`document.getElementById('lens').showModal()`);
          await tab.until(`document.querySelector('.round-current .html-block.stage-modal')`, 'the board hearing of the full-size view');
          const hidden = await tab.evalPage(TOP_EXPR);
          assert.deepEqual([hidden.home.shown, hidden.more.shown], [false, false], 'both buttons leave while the view is open');
          await stage(`document.getElementById('lens').close()`);
          await tab.until(`!document.querySelector('.round-current .html-block.stage-modal')`, 'the board hearing the view closed');
          const back = await tab.evalPage(TOP_EXPR);
          assert.deepEqual([back.home.shown, back.more.shown], [true, true], 'and come back once it closes');
        } finally {
          await tab.close();
        }
      });

      await row('at 1280 the header, its condensing pill and the round caption are as before', async note => {
        const tab = await openTab(send, onEvent, roundUrl, cookie, { width: 1280, height: 900, theme: 'dark', expr: '1' });
        try {
          const read = () => tab.evalPage(`(function () {
            function shown(sel) { var el = document.querySelector(sel); return !!el && el.checkVisibility({ checkVisibilityCSS: true }); }
            return {
              position: getComputedStyle(document.querySelector('header.board-head')).position,
              controls: ['button#comment-mode-toggle', 'button#theme-toggle', '.board-head .meta', '.round-current .round-chips', '.round-pager-caption'].map(shown),
              phone: ['.head-round', '.corner-more', 'div.corner-menu'].map(shown),
              home: document.querySelector('a.back-to-index').getBoundingClientRect().width,
              condensed: document.body.classList.contains('stage-scrolled'),
            };
          })()`);
          const rest = await read();
          await tab.evalPage(`document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 800)`);
          await tab.quiet();
          const down = await read();
          note(`at rest ${JSON.stringify(rest)}; scrolled ${JSON.stringify(down)}`);
          assert.equal(rest.position, 'sticky', 'the header is sticky');
          assert.deepEqual(rest.controls, [true, true, true, true, true], 'its controls, ids, the chip line and the caption show');
          assert.deepEqual(rest.phone, [false, false, false], 'the phone\'s state line and ⋯ do not');
          assert.equal(rest.home, 30, 'the mark is the strip\'s own');
          assert.deepEqual([rest.condensed, down.condensed], [false, true], 'scrolling condenses it into the pill');
          assert.deepEqual(down.phone, [false, false, false]);
        } finally {
          await tab.close();
        }
      });
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
