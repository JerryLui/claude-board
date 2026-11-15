// Real-browser check for a mock's own full-size diagram view on a board page: the modal
// dialog a rendered page opens over itself, inside its stage frame, with a bar of
// buttons along its top edge (zoom out, zoom in, fit, 1:1, close). Every button takes a
// real click wherever the mock sits: filling the page under the board's top strip, sent
// or not, in a board opened from disk, and in a question's context, there also with the
// board scrolled so the bar lies under the strip. Over a full-page mock the strip leaves
// while the view is open and is back, taking clicks, once it closes; and with no view
// open, a click on the strip's empty part lands in the mock under it. A small dialog the
// mock opens clear of the strip leaves the strip where it is.
//
// Hit-testing through the board's own layers into a sandboxed frame, which the DOM
// stand-in cannot do (QUIRKS.md "The DOM stand-in's ceilings"): each click is a real
// input event at the button's place in the board's window, and what it did is read from
// the stage's own document.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-mock-lens.mjs
//
// Without Chrome it prints a skip line and exits 0.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { repoRoot, runMain, skipFile, sleep } from './support.mjs';
import { CHROME, copyArchive, evalIn, guardRun, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-mock-lens', `browser-check-mock-lens: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-mock-lens', { deadlineMs: 180000 });

const WIDTH = 1280;
const HEIGHT = 900;
// The mock: its lens bar is the rendered templates' own, button for button.
const MOCK = readFileSync(path.join(repoRoot, 'test', 'fixtures', 'lens-mock.html'), 'utf8');
const NEXT = [{ id: 'q2', kind: 'question', prompt: 'Next?', widget: 'single', options: [{ label: 'Go' }] }];
const QUESTION = [
  { kind: 'markdown', text: 'A question with a mock in its context.' },
  { id: 'q1', kind: 'question', prompt: 'Which one?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }],
    context: [{ kind: 'html', html: MOCK }] },
];

// The bar's buttons in the order pressed, each with the zoom figure the bar shows after
// it; `fit` shows the figure the view opened at, and `close` leaves no view.
const PRESSES = [
  ['one', '1:1', () => '100%'],
  ['out', 'zoom out', () => '71%'],
  ['in', 'zoom in', () => '100%'],
  ['fit', 'fit', opened => opened],
  ['close', 'close', () => null],
];

/** Polls `read()` until `ok(value)`, answering the last value read either way. */
async function settle(read, ok, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() >= deadline) return value;
    await sleep(50);
  }
}

/** One real left click at a point of the board's window. */
async function clickAt(tab, at) {
  await tab.sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await tab.sp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await tab.sp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
}

/** What the board's own document has on top at a point of its window. */
const onTop = (tab, at) => tab.evalPage(`(function () {
  var el = document.elementFromPoint(${at.x}, ${at.y});
  if (!el) return 'nothing';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
})()`);

/** Opens `url`, flips to `round` when given, and finds the mock's own frame target.
 * Answers the tab plus `inStage(expr)`, `origin()` (where the stage's own coordinates
 * start in the board's window, once the stage holds still) and `spot(selector)` (the
 * centre of one stage element, in the board's window). */
async function openSurface(send, onEvent, url, cookie, { round = null } = {}) {
  const frames = [];
  const tab = await openTab(send, onEvent, url, cookie, { width: WIDTH, height: HEIGHT, theme: 'light', expr: 'true',
    prepare: async (sp, sessionId) => {
      onEvent(msg => {
        if (msg.method === 'Target.attachedToTarget' && msg.sessionId === sessionId && msg.params.targetInfo.type === 'iframe') frames.push(msg.params.sessionId);
      });
      await sp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    } });
  try {
    if (round != null) {
      await tab.evalPage(`document.querySelector('.round-page[data-round="${round}"]').click()`);
      await tab.until(`document.querySelector('.round[data-round="${round}"]').classList.contains('round-current')`, `the flip to round ${round}`);
      await tab.quiet();
    }
    let stage = null;
    await settle(async () => {
      for (const sid of frames) {
        try {
          if (await evalIn(send, sid, `!!document.querySelector('[data-mock="lens"]')`)) stage = sid;
        } catch { /* not parsed yet */ }
      }
      return stage;
    }, Boolean, 15000);
    assert.ok(stage, `setup: no stage target holding the mock on ${url}`);
    const inStage = expr => evalIn(send, stage, expr);
    const box = () => tab.evalPage(`(function () {
      var f = document.querySelector('.round-current iframe.html-stage');
      var r = f.getBoundingClientRect();
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop, h: r.height, page: document.body.classList.contains('page-board'), fitted: f.style.height !== '' };
    })()`);
    const origin = async () => {
      let last = '';
      let same = 0;
      const held = await settle(async () => {
        const now = await box();
        same = JSON.stringify(now) === last ? same + 1 : 0;
        last = JSON.stringify(now);
        return now;
      }, now => (now.page || now.fitted) && same >= 3, 8000);
      assert.ok(held.page || held.fitted, 'setup: the stage never took its height');
      return held;
    };
    const spot = async selector => {
      const o = await origin();
      const c = await inStage(`(function () { var r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      return { x: o.x + c.x, y: o.y + c.y };
    };
    return { tab, inStage, origin, spot };
  } catch (err) {
    await tab.close();
    throw err;
  }
}

/** The middle of the widest stretch of `selector`'s box that no box it holds covers, at
 * the height those boxes sit at: a point of the strip that is none of its controls. */
const emptySpot = (tab, selector) => tab.evalPage(`(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  var r = el.getBoundingClientRect();
  var held = [].slice.call(el.children).map(function (c) { return c.getBoundingClientRect(); })
    .filter(function (c) { return c.width > 0 && c.height > 0; }).sort(function (a, b) { return a.left - b.left; });
  var y = r.top + r.height / 2;
  if (held.length) y = (Math.min.apply(null, held.map(function (c) { return c.top; })) + Math.max.apply(null, held.map(function (c) { return c.bottom; }))) / 2;
  var best = { x: null, width: 0 };
  var from = r.left;
  held.concat([{ left: r.right, right: r.right }]).forEach(function (c) {
    if (c.left - from > best.width) best = { x: (from + c.left) / 2, width: c.left - from };
    from = Math.max(from, c.right);
  });
  return { x: best.x, y: y, width: best.width };
})()`);

const lensState = surface => surface.inStage(`(function () {
  var d = document.getElementById('lens');
  return d.open ? document.getElementById('lens-pct').textContent : null;
})()`);

/** Opens the mock's full-size view with a click on its diagram, presses every button of
 * its bar and answers the buttons that did nothing, each with what the board had on top
 * of it. `underStrip` first scrolls the board until the bar lies under the top strip. */
async function pressEveryButton(surface, note, { underStrip = false } = {}) {
  const { tab } = surface;
  await clickAt(tab, await surface.spot('#diagram'));
  const opened = await settle(() => lensState(surface), Boolean);
  assert.ok(opened, 'setup: a click on the diagram opens the full-size view');
  note(`opened at ${opened}`);
  if (underStrip) {
    const strip = await tab.evalPage(`(function () { var r = document.querySelector('header.board-head').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
    const bar = await surface.spot('[data-lens="close"]');
    await tab.evalPage(`(function () { document.documentElement.style.scrollBehavior = 'auto'; window.scrollBy(0, ${bar.y - (strip.top + strip.bottom) / 2}); })()`);
    await tab.quiet();
    const now = await tab.evalPage(`(function () { var r = document.querySelector('header.board-head').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, scrollY: window.scrollY }; })()`);
    const at = await surface.spot('[data-lens="close"]');
    note(`board scrolled to ${now.scrollY}px: strip ${now.top} to ${now.bottom}px, the bar's buttons at ${Math.round(at.y)}px`);
    assert.ok(at.y > now.top && at.y < now.bottom, 'setup: the bar lies under the top strip');
  }
  const dead = [];
  let before = opened;
  for (const [act, name, want] of PRESSES) {
    const at = await surface.spot(`[data-lens="${act}"]`);
    const top = await onTop(tab, at);
    await clickAt(tab, at);
    const after = await settle(() => lensState(surface), s => s !== before, 1500);
    note(`${name} at ${Math.round(at.x)},${Math.round(at.y)}: the board has ${top} on top; the view read ${before}, then ${after}`);
    if (after === before) dead.push(`${name} (under ${top})`);
    else assert.equal(after, want(opened), `${name} did something else`);
    before = after;
  }
  return dead;
}

async function main() {
  const daemon = await startScratchDaemon('cb-mock-lens');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    const submit = (id, answers) => postJson(`${origin}/api/board/${id}/submit`, { round: 1, action: 'send', answers, comments: [] }, daemon.secret);
    const urlOf = created => `${origin}${new URL(created.url).pathname}`;

    const page = await post({ title: 'A full-page mock', blocks: [{ id: 'h1', kind: 'html', html: MOCK }] });
    const sentPage = await post({ title: 'A full-page mock, sent', blocks: [{ id: 'h1', kind: 'html', html: MOCK }] });
    await submit(sentPage.boardId, []);
    await post({ boardId: sentPage.boardId, title: 'A full-page mock, sent', blocks: NEXT });
    const asked = await post({ title: 'A mock in a question', blocks: QUESTION });
    const sentAsked = await post({ title: 'A mock in a question, sent', blocks: QUESTION });
    await submit(sentAsked.boardId, [{ id: 'q1', status: 'answered', choice: 'A', note: '' }]);
    await post({ boardId: sentAsked.boardId, title: 'A mock in a question, sent', blocks: NEXT });

    await withChrome({ tag: 'cb-mock-lens' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const archive = copyArchive(path.join(daemon.home, 'pages'), sentPage.boardId, 'cb-mock-lens');
      const surfaces = [
        ['a full-page round', urlOf(page), {}],
        ['a full-page round already sent, read-only', urlOf(sentPage), { round: 1 }],
        ['a full-page round in a board opened from disk, read-only', archive.pageUrl, { round: 1 }],
        ['a question\'s context', urlOf(asked), {}],
        ['a question\'s context, the board scrolled so the bar lies under the top strip', urlOf(asked), { underStrip: true }],
        ['a question\'s context in a round already sent, read-only', urlOf(sentAsked), { round: 1 }],
        ['a question\'s context in a round already sent, the bar under the top strip', urlOf(sentAsked), { round: 1, underStrip: true }],
      ];
      for (const [label, url, { round = null, underStrip = false }] of surfaces) {
        await row(`${label}: every button of the mock's full-size view takes its click (1:1, zoom out, zoom in, fit, close)`, async note => {
          const surface = await openSurface(send, onEvent, url, cookie, { round });
          try {
            const state = await surface.tab.evalPage(`document.body.className`);
            note(`body: ${state}`);
            assert.deepEqual(await pressEveryButton(surface, note, { underStrip }), []);
            if (!state.split(' ').includes('page-board')) return;
            // The strip left for the view and is back with it closed: its theme control works.
            const read = `(document.documentElement.getAttribute('data-theme') || 'none')`;
            const theme = await surface.tab.evalPage(read);
            const control = await surface.tab.evalPage(`(function () { var r = document.querySelector('header.board-head button#theme-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            await clickAt(surface.tab, control);
            const then = await settle(() => surface.tab.evalPage(read), t => t !== theme, 1500);
            note(`view closed: the strip's theme control took the page from ${theme} to ${then}`);
            assert.notEqual(then, theme, 'with the view closed the strip is back and its theme control takes a click');
          } finally {
            await surface.tab.close();
          }
        });
      }

      await row('a full-page round: a small dialog the mock opens clear of the top strip leaves the strip in place, taking clicks', async note => {
        const surface = await openSurface(send, onEvent, urlOf(page), cookie);
        try {
          await clickAt(surface.tab, await surface.spot('#ask'));
          const shown = await settle(() => surface.inStage(`(function () {
            var d = document.getElementById('small');
            return d.matches(':modal') && Math.round(d.getBoundingClientRect().top);
          })()`), Boolean);
          const strip = await surface.tab.evalPage(`Math.round(document.querySelector('header.board-head').getBoundingClientRect().bottom)`);
          note(`the dialog opens ${shown}px down the mock; the strip ends at ${strip}px`);
          assert.ok(shown > strip, 'setup: the dialog is open as a modal, below the strip');
          const read = `(document.documentElement.getAttribute('data-theme') || 'none')`;
          const theme = await surface.tab.evalPage(read);
          const control = await surface.tab.evalPage(`(function () { var r = document.querySelector('header.board-head button#theme-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          await clickAt(surface.tab, control);
          const then = await settle(() => surface.tab.evalPage(read), t => t !== theme, 1500);
          note(`the strip's theme control took the page from ${theme} to ${then}`);
          assert.notEqual(then, theme, 'the strip stays and its theme control takes a click');
        } finally {
          await surface.tab.close();
        }
      });

      const strips = [
        ['a full-page round', urlOf(page), {}, [['the top strip', 'header.board-head']]],
        ['a full-page round already sent', urlOf(sentPage), { round: 1 }, [['the top strip', 'header.board-head'], ['the chip line under it', '.round-current .round-chips']]],
      ];
      for (const [label, url, { round = null }, parts] of strips) {
        await row(`${label}: a click on the empty part of ${parts.map(p => p[0]).join(', and of ')} lands in the mock under it`, async note => {
          const surface = await openSurface(send, onEvent, url, cookie, { round });
          try {
            await surface.origin();
            await surface.inStage(`(function () { window.__cbClicks = 0; document.addEventListener('click', function () { window.__cbClicks++; }, true); })()`);
            let landed = 0;
            for (const [name, selector] of parts) {
              const at = await emptySpot(surface.tab, selector);
              assert.ok(at.x !== null && at.width > 40, `setup: ${name} has an empty stretch`);
              const top = await onTop(surface.tab, at);
              await clickAt(surface.tab, at);
              const got = await settle(() => surface.inStage('window.__cbClicks'), n => n > landed, 1500);
              note(`${name} at ${Math.round(at.x)},${Math.round(at.y)}, ${Math.round(at.width)}px clear: the board has ${top} on top; the mock has heard ${got} click(s)`);
              assert.equal(got, landed + 1, `the click on ${name} never reached the mock: the board has ${top} on top`);
              landed = got;
            }
          } finally {
            await surface.tab.close();
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
