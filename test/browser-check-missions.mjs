// Real-browser check for the Missions view with cards on it: the top bar lands on the same
// pixels on `/` (cards in every column, Comment on offer) as on `/boards`; the five columns
// lay out in one row across the bar's whole content width, at 1440 and 2560 wide, light
// and dark, with nothing scrolling sideways; and Stop, pressed with a real mouse, asks once
// and then sends its order. Layout and a real press, which the DOM stand-in has none of
// (QUIRKS.md "The DOM stand-in's ceilings"): test/check-missions-view.mjs holds the
// markup and the requests.
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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { sessionToken, SECRET_HEADER } from '../src/secret.mjs';
import { runMain, sleep, withTimeout, skipFile } from './support.mjs';
import { CHROME, guardRun, postJson, row, setSessionCookie, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-missions', `browser-check-missions: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

const WIDTHS = [1440, 2560];
const HEIGHT = 900;
const THEMES = ['light', 'dark'];
const BOARDS = 14; // enough rows that the boards list scrolls at HEIGHT
const COLUMNS = ['needs-you', 'working', 'waiting', 'stalled', 'landed'];

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
  return {
    parts: parts,
    content: bar ? { left: bar.getBoundingClientRect().left + parseFloat(cs.paddingLeft), width: bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) } : null,
    cols: cols,
    commentOn: !!document.querySelector('button#comment-mode-toggle:not([disabled])'),
    background: getComputedStyle(document.body).backgroundColor,
    docW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
  };
})()`;

/** A fresh tab at `width` x HEIGHT under `theme`, loaded and held still. Answers the
 * tab's own `sp`, `evalPage` and `close`. */
async function openTab(send, onEvent, url, cookie, { width, theme }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const sp = (method, params) => send(method, params, sessionId);
  const evalPage = expr => sp('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
    if (r.exceptionDetails) throw new Error(`page eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  });
  const close = () => send('Target.closeTarget', { targetId });
  try {
    const loadFired = new Promise(resolve => {
      const off = onEvent(msg => {
        if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { off(); resolve(); }
      });
    });
    await sp('Page.enable');
    await sp('Runtime.enable');
    await sp('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await sp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await setSessionCookie(sp, cookie);
    await sp('Page.navigate', { url });
    await withTimeout(loadFired, 20000, `page never fired load: ${url}`);
    const deadline = Date.now() + 15000;
    let last = null;
    let since = Date.now();
    for (;;) {
      await sleep(100);
      const now = JSON.stringify(await evalPage(MEASURE_EXPR));
      if (now !== last) { last = now; since = Date.now(); }
      else if (Date.now() - since >= 500) return { sp, evalPage, close, measured: JSON.parse(now) };
      if (Date.now() >= deadline) throw new Error(`layout never held still at ${width}px: ${url}`);
    }
  } catch (err) {
    await close();
    throw err;
  }
}

async function measure(send, onEvent, url, cookie, opts) {
  const tab = await openTab(send, onEvent, url, cookie, opts);
  await tab.close();
  return tab.measured;
}

/** Presses the element `selector` names with a real mouse, at its centre. */
async function press(tab, selector) {
  const at = await tab.evalPage(`(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(at, `nothing to press at ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await tab.sp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}

async function waitFor(tab, expr, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await tab.evalPage(expr);
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`${what} never happened`);
    await sleep(50);
  }
}

function getJson(port, route, secret) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { [SECRET_HEADER]: secret } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
}

function deadPid() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('exit', () => resolve(child.pid));
  });
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
    await live('FILETYPE_FOLLOWUP', { title: 'File types, part 2', summary: 'Wave 2 of 3, 4 owners', next: 'wave 3',
      prs: [{ repo: 'service', number: 1866, url: 'https://github.com/o/service/pull/1866', state: 'draft' }] });
    await live('ANNOUNCEMENTS', { title: 'In-app announcements', summary: 'Wave 1 of 2, 3 owners' });
    await post('/api/mission/SCHEDULED', { title: 'Scheduled steps', phase: 'landing', state: 'waiting', waitingOn: 'checks on service #1880' });
    await post('/api/mission/PAGE_READ_ROLLOUT', { title: 'Page reading rollout', phase: 'direct', state: 'queued', next: 'starts when a slot frees' });
    await post('/api/mission/SMALL_FIXES', { title: 'Security small fixes', phase: 'direct', state: 'working', summary: 'Silent since its last step' });
    await post('/api/mission/SMALL_FIXES/session', { pid: await deadPid() });
    await post('/api/mission/ESTATE_GOLDENS', { title: 'Estate case goldens', phase: 'landing', state: 'landed', summary: 'Landed, nothing left',
      prs: [{ repo: 'service', number: 1862, url: 'https://github.com/o/service/pull/1862', state: 'merged' }] });

    const counts = Object.fromEntries(COLUMNS.map(c => [c, 0]));
    for (const m of (await getJson(port, '/api/missions', daemon.secret)).missions) counts[m.view === 'queued' ? 'waiting' : m.view] += 1;

    for (const [mode, classicScrollbars] of [['classic scrollbars', true], ['default scrollbars', false]]) {
      await withChrome({ tag: 'cb-missions', classicScrollbars }, async ({ send, onEvent }) => {
        const cookie = sessionToken(daemon.secret);
        const at = {};
        for (const width of WIDTHS) {
          for (const theme of THEMES) {
            at[`${width} ${theme}`] = {
              missions: await measure(send, onEvent, `${origin}/`, cookie, { width, theme }),
              boards: await measure(send, onEvent, `${origin}/boards`, cookie, { width, theme }),
            };
          }
        }

        for (const width of WIDTHS) {
          await row(`${mode}, setup at ${width}px: light and dark differ, every column holds its cards, Comment is on offer`, note => {
            const light = at[`${width} light`];
            const dark = at[`${width} dark`];
            note(`background light ${light.missions.background}, dark ${dark.missions.background}`);
            assert.notEqual(light.missions.background, dark.missions.background);
            for (const m of [light, dark]) {
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

        await row(`${mode}: no view scrolls sideways`, note => {
          const wrong = [];
          for (const [key, m] of Object.entries(at)) {
            for (const view of ['missions', 'boards']) {
              if (m[view].scrollW > m[view].docW) wrong.push(`${key} ${view}: ${m[view].scrollW}px in ${m[view].docW}px`);
            }
          }
          note(`${Object.keys(at).length * 2} pages`);
          assert.deepEqual(wrong, []);
        });
      });
    }

    await withChrome({ tag: 'cb-missions-stop' }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      await row('Stop, pressed with a mouse, asks once, then sends the order and says so on the card', async note => {
        const tab = await openTab(send, onEvent, `${origin}/`, cookie, { width: 1440, theme: 'light' });
        try {
          const card = 'article.mission-card[data-mission-key="ANNOUNCEMENTS"]';
          await press(tab, `${card} button.mission-stop`);
          const asked = await waitFor(tab, `(document.querySelector('${card} p.mission-confirm-text') || {}).textContent`, 'the Stop question');
          note(asked);
          assert.deepEqual((await getJson(port, '/api/mission/ANNOUNCEMENTS', daemon.secret)).orders, [], 'the first press only asks');
          const focused = await tab.evalPage(`document.activeElement && document.activeElement.textContent`);
          assert.equal(focused, 'Stop session', 'the question takes the focus to its own Stop');

          await press(tab, `${card} button.mission-stop-confirm`);
          const said = await waitFor(tab, `(document.querySelector('${card} p.mission-order') || {}).textContent`, 'the order line');
          note(said);
          assert.equal(said, 'Stop asked: waiting for the Master Chief to relay it');
          const orders = (await getJson(port, '/api/mission/ANNOUNCEMENTS', daemon.secret)).orders;
          assert.deepEqual(orders.map(o => o.kind), ['stop']);
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
