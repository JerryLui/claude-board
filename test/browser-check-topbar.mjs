// Real-browser check for the one top bar Missions (`/`) and Boards (`/boards`) share:
// every box in it (the bar, the mark, the title, each tab, the timer, Comment, theme)
// lands on the same pixels on both views, at 1440 and 2560 wide, light and dark; the
// boards list and its filter run the bar's whole content width; and an ordinary board
// page's own header sits on the same edges. Layout, which the DOM stand-in has none of
// (QUIRKS.md "The DOM stand-in's ceilings"): test/check-topbar.mjs holds the markup.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-topbar.mjs
//
// Without Chrome it prints a skip line and exits 0.
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch port
// and a scratch store, headless Chrome over the DevTools Protocol. Run twice, with
// classic scrollbars and with whatever the Mac draws by default (QUIRKS.md "Headless
// Chrome's scrollbars follow the Mac's Show scroll bars setting"): the boards list here
// is long enough to scroll while Missions is not, and a bar that shifted by a
// scrollbar's width between the two is exactly the move this check is for. On an
// overlay-scrollbar Mac the board's restyled bar still takes 11px once a page scrolls.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile } from './support.mjs';
import { CHROME, guardRun, measureTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-topbar', `browser-check-topbar: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

const WIDTHS = [1440, 2560];
const HEIGHT = 900;
const THEMES = ['light', 'dark'];
const BOARDS = 60; // enough that the boards scroll at HEIGHT, six a row at 2560, with Missions empty

guardRun('browser-check-topbar', { deadlineMs: 180000 });

const px = n => `${Math.round(n * 100) / 100}px`;

// Every box the bar holds, by what a reader sees, plus the boards view's list and form.
const MEASURE_EXPR = `(function () {
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  var bar = document.querySelector('header.board-head');
  var cs = bar ? getComputedStyle(bar) : null;
  var tabs = [].slice.call(document.querySelectorAll('a.view-tab'));
  var parts = {
    bar: box('header.board-head'),
    mark: box('header.board-head a.back-to-index'),
    title: box('header.board-head h1'),
    'timer': box('header.board-head div#pomodoro-widget'),
    'Comment': box('header.board-head button#comment-mode-toggle'),
    'theme': box('header.board-head button#theme-toggle'),
    'waiting count': box('header.board-head span#waiting-count'),
  };
  tabs.forEach(function (t) { var r = t.getBoundingClientRect(); parts['tab ' + t.textContent.replace(/\\d+ waiting$/, '').trim()] = { left: r.left, top: r.top, width: r.width, height: r.height }; });
  return {
    parts: parts,
    content: bar ? { left: bar.getBoundingClientRect().left + parseFloat(cs.paddingLeft), width: bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) } : null,
    list: box('div.thread-list'),
    form: box('form.search-form'),
    background: getComputedStyle(document.body).backgroundColor,
    scrolls: document.documentElement.scrollHeight > window.innerHeight,
    docW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  };
})()`;

/** A tab at `width` x HEIGHT under `theme`, held still on MEASURE_EXPR (openTab's options,
 * test/browser-support.mjs). */
const tabAt = (width, theme) => ({ width, height: HEIGHT, theme, expr: MEASURE_EXPR });

async function main() {
  const daemon = await startScratchDaemon('cb-topbar');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    for (let i = 0; i < BOARDS; i++) {
      await post({ title: `Session ${i + 1}`, blocks: [{ kind: 'markdown', text: `Board ${i + 1}` }] });
    }
    // One round waiting, so the Boards tab carries its count.
    await post({ title: 'Waiting session', wait: true,
      blocks: [{ kind: 'question', prompt: 'Ready?', widget: 'single', options: [{ label: 'Yes' }] }] });
    const longBoard = await post({ title: 'An ordinary board',
      blocks: Array.from({ length: 30 }, (_, i) => ({ kind: 'markdown', text: `Paragraph ${i + 1}.\n\nMore text, to scroll.` })) });
    const boardUrl = `${origin}${new URL(longBoard.url).pathname}`;

    for (const [mode, classicScrollbars] of [['classic scrollbars', true], ['default scrollbars', false]]) {
    await withChrome({ tag: 'cb-topbar', classicScrollbars }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const at = {};
      for (const width of WIDTHS) {
        for (const theme of THEMES) {
          at[`${width} ${theme}`] = {
            missions: await measureTab(send, onEvent, `${origin}/`, cookie, tabAt(width, theme)),
            boards: await measureTab(send, onEvent, `${origin}/boards`, cookie, tabAt(width, theme)),
            board: await measureTab(send, onEvent, boardUrl, cookie, tabAt(width, theme)),
          };
        }
      }

      for (const width of WIDTHS) {
        await row(`${mode}, setup at ${width}px: light and dark really differ, the boards list scrolls and Missions does not`, note => {
          const light = at[`${width} light`];
          const dark = at[`${width} dark`];
          note(`background light ${light.boards.background}, dark ${dark.boards.background}`);
          assert.notEqual(light.boards.background, dark.boards.background);
          for (const m of [light, dark]) {
            assert.equal(m.boards.scrolls, true, 'the boards list scrolls');
            assert.equal(m.missions.scrolls, false, 'Missions does not');
            assert.ok(m.missions.parts['waiting count'].width > 0, 'the Boards tab shows its count');
          }
        });
      }

      for (const [key, m] of Object.entries(at)) {
        await row(`${mode}, at ${key}: every box in the top bar is the same on Missions and on Boards`, note => {
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

        await row(`${mode}, at ${key}: the boards list and its filter run the bar's whole content width`, note => {
          const { content, list, form } = m.boards;
          note(`bar content ${px(content.left)} + ${px(content.width)}; list ${px(list.left)} + ${px(list.width)}; filter ${px(form.left)} + ${px(form.width)}`);
          for (const [name, b] of [['list', list], ['filter', form]]) {
            assert.ok(Math.abs(b.left - content.left) <= 0.5, `${name} starts where the bar's content does`);
            assert.ok(Math.abs(b.width - content.width) <= 0.5, `${name} is the bar's content width`);
          }
        });

        await row(`${mode}, at ${key}: an ordinary board page's header sits on the bar's edges`, note => {
          const bar = m.boards.parts.bar;
          const head = m.board.parts.bar;
          note(`bar ${px(bar.left)} + ${px(bar.width)}; board header ${px(head.left)} + ${px(head.width)}`);
          assert.ok(m.board.scrolls, 'setup: the board scrolls, as an ordinary board does');
          assert.ok(Math.abs(head.left - bar.left) <= 0.5 && Math.abs(head.width - bar.width) <= 0.5);
        });
      }

      await row(`${mode}: no view scrolls sideways`, note => {
        const wrong = [];
        for (const [key, m] of Object.entries(at)) {
          for (const view of ['missions', 'boards']) {
            const v = m[view];
            if (v.scrollW > v.docW) wrong.push(`${key} ${view}: ${v.scrollW}px of content in a ${v.docW}px document`);
          }
        }
        note(`${Object.keys(at).length * 2} pages`);
        assert.deepEqual(wrong, []);
      });

      await row(`${mode}: at 2560px the bar runs the window, less the shell's gutters`, note => {
        const m = at['2560 light'].boards;
        note(`window ${m.innerW}px, document ${m.docW}px, bar ${px(m.parts.bar.width)}`);
        assert.ok(Math.abs(m.parts.bar.width - (m.docW - 48)) <= 0.5, 'the document width less the shell\'s two 24px gutters');
      });
    });
    }
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
