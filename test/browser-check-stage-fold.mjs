// Real-browser check for the stage fold (ADR.md entry 119) and the in-page link
// hand-off that rides on it. A stage outside a page board fits its content, folds
// past 600px behind a Show full height bar, opens in place to its content height
// (capped at 30,000px), keeps a wide mock's sideways scroll, and hands an in-page
// link to the BOARD when its frame has nothing of its own to scroll. All of that is
// layout, and the DOM stand-in the suite runs on has none (QUIRKS.md "The DOM
// stand-in's ceilings"), so the keepers in test/check-stage-isolation.mjs drive the
// rules on declared numbers and this file looks at real ones.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass
// on a machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-stage-fold.mjs
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch
// port and a scratch store, headless Chrome over the DevTools Protocol with Node's
// native WebSocket, zero npm dependencies, classic scrollbars forced on. Every
// mock sits on ONE ordinary board twice, once in a question's context and once at
// top level (an ordinary board, not a page board: QUIRKS.md "A fixture board
// holding one html block and nothing else is a PAGE board"), and a tall and a
// short one sit once more in a rendered-variant option's card, for the Pull-out
// rows: where a frame scrolls inside, the Pull-out in its corner (ADR.md entry
// 120) has to stand clear of the scrollbar the frame draws.
//
// What is measured, never assumed: the frame's getBoundingClientRect in the board,
// and the frame document's own scrollingElement read inside the frame's own
// execution context (each sandboxed srcdoc stage is its own Chrome target).
// A capture-phase `message` listener and a MutationObserver installed before the
// board's own script runs log every height report a stage sends and every box the
// board writes, so the "320 until the first report, under 320 only after two
// matching reports" rule is read off the real sequence.
//
// After the fold rows, the default ink: a mock that sets no colour, on its own
// two boards (an ordinary one, for the stage and the Lens, and a page board),
// each loaded three times, under an emulated dark OS, under the Dark setting and
// under a light OS. Its text, link, input and button have to read 4.5:1 or
// better and its empty area has to show the artboard, all read off a
// screenshot's pixels. Beside it in each of the three loads, a mock that themes
// itself off data-theme: it has to draw the board's side of its own palette on
// its stage and in the Lens's copy, which the board tells the theme too.

import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { sessionToken } from '../src/secret.mjs';
import { THEME_STORAGE_KEY } from '../src/theme.mjs';
import { runMain, sleep, withTimeout } from './support.mjs';
import {
  evalIn, guardRun, postJson, requireChrome, row, setSessionCookie, startScratchDaemon, withChrome,
} from './browser-support.mjs';

// The numbers ADR.md entry 119 fixes, written out here rather than imported, so a
// drift in src/ui.mjs turns a row red instead of moving the expectation with it.
const PLACEHOLDER = 320;
const FLOOR = 120;
const CAP = 600;
const OPEN_CAP = 30000;
const BORDER = 2; // the frame's 1px border, top and bottom, inside its height

const RUN_DEADLINE_MS = 300000;
guardRun('browser-check-stage-fold', { deadlineMs: RUN_DEADLINE_MS });

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// The mocks. Each is wrapped in `data-mock="<kind>-<place>"` so the frame (by
// its srcdoc) and its Chrome target (by its DOM) can both be found by name.
const LOREM = 'A paragraph of ordinary prose, long enough to wrap onto a second line in a '
  + 'column the width of a board card, so the mock has a real text height.';
const MOCKS = {
  // Under the 320px placeholder, and opening on an h1 whose top margin collapses
  // through <body>: the stray-scrollbar shape the whole-document measure exists for.
  short: () => `<h1>Short mock</h1><p>${LOREM}</p><p>${LOREM}</p>`,
  // One line: the fit would be ~20px, so the 120px floor is what holds it.
  tiny: () => '<p style="margin:0">One line.</p>',
  tall: () => `<h1>Tall mock</h1>${[1, 2, 3, 4, 5, 6].map(n =>
    `<section style="height:300px;border-top:1px solid #ccc">Section ${n}</section>`).join('')}`,
  // Past the 30,000px open cap.
  huge: () => '<div style="height:40000px">Taller than the open cap</div>',
  wide: () => '<div style="width:2400px;height:1500px;background:linear-gradient(90deg,#eef,#fee)">Wide and tall</div>',
  // One viewport tall and wider than the frame: 100vh is innerHeight, which
  // already counts the sideways scrollbar, so counting the bar again grows it.
  widevh: () => '<style>body{min-height:100vh}</style><div style="width:2400px">Wide, one viewport tall</div>',
  // Sized in viewport units: every box the board gives it, it outgrows.
  vh: () => [1, 2, 3].map(n =>
    `<section style="height:100vh;box-sizing:border-box;border-bottom:1px solid #999">Screen ${n}</section>`).join(''),
  // Fits (between the placeholder and the cap), with a table of contents.
  linkfit: () => '<nav><a id="toc" href="#target">Jump to target</a></nav>'
    + '<div style="height:300px"></div><h2 id="target">Target</h2><p>After the target.</p>',
  // Folds, with a table of contents; opened for the opened case.
  linktall: () => '<nav><a id="toc" href="#target">Jump to target</a></nav>'
    + '<div style="height:1400px"></div><h2 id="target">Target</h2><div style="height:600px"></div>',
  // Folds, with its table of contents 300px down, so the link stays clickable
  // below the sticky header while the frame's own top sits under it.
  linkunder: () => '<div style="height:300px"></div><nav><a id="toc" href="#target">Jump to target</a></nav>'
    + '<div style="height:1400px"></div><h2 id="target">Target</h2><div style="height:600px"></div>',
  // Folds, with its target near the end: the frame's own scroll runs out before
  // the target reaches its top, so the target stops low in the frame.
  linkend: () => '<nav><a id="toc" href="#target">Jump to target</a></nav>'
    + '<div style="height:1400px"></div><h2 id="target">Target</h2><p>After the target.</p>',
  // An app shell: one viewport tall, its main pane scrolling on its own.
  shell: () => '<div style="display:flex;height:100vh"><nav style="width:160px;flex:none">'
    + '<a id="toc" href="#target">Jump to target</a></nav>'
    + '<main id="pane" style="flex:1;overflow-y:auto"><div style="height:1200px"></div>'
    + '<h2 id="target">Target</h2><div style="height:400px"></div></main></div>',
};
const CTX = ['linkfit', 'linktall', 'short', 'tall', 'wide', 'vh'];
const TOP = ['linkfit', 'linktall', 'shell', 'linkunder', 'linkend', 'short', 'tiny', 'tall', 'wide', 'widevh', 'vh', 'huge'];
// A rendered-variant option's card: its stage clips at the cap and never folds
// (ADR.md entry 22), so it scrolls inside with no fold class on its block, only
// the page's own mark that it scrolls inside.
const VAR = ['tall', 'short'];
const ALL = [...CTX.map(k => `${k}-ctx`), ...TOP.map(k => `${k}-top`), ...VAR.map(k => `${k}-var`)];
const mockHtml = (kind, place) => `<div data-mock="${kind}-${place}">${MOCKS[kind]()}</div>`;

function boardBody() {
  const filler = Array.from({ length: 60 }, (_, i) =>
    `Filler paragraph ${i + 1}: room under the last stage, so the board can scroll a target up under its header.`).join('\n\n');
  return {
    title: 'stage fold browser check',
    blocks: [
      { kind: 'markdown', text: "Every mock twice: in a question's context and at top level." },
      {
        kind: 'question', prompt: 'Context stages', widget: 'single',
        options: [{ label: 'A' }, { label: 'B' }],
        context: CTX.map(k => ({ kind: 'html', html: mockHtml(k, 'ctx') })),
      },
      ...TOP.map(k => ({ kind: 'html', html: mockHtml(k, 'top') })),
      // After every top-level stage, so none of them moves on the board.
      {
        kind: 'question', prompt: 'Variant stages', widget: 'choose-between-rendered-variants',
        options: VAR.map(k => ({ label: `Card ${k}`, block: { kind: 'html', html: mockHtml(k, 'var') } })),
      },
      { kind: 'markdown', text: filler },
    ],
  };
}

// ---------------------------------------------------------------------------
// Installed in the board before its own script runs. Passive: it reads, logs and
// never stops an event, so the board's own listener sees every message as before.
const PARENT_PROBE = `(function () {
  if (window !== window.top) return;
  var seq = 0;
  var log = window.__cbLog = { reports: [], boxes: [], scrolls: [] };
  window.__cbSeq = function () { return seq; };
  function mockOf(f) { var m = /data-mock="([^"]+)"/.exec(f.getAttribute('srcdoc') || ''); return m ? m[1] : null; }
  window.__cbFrame = function (name) {
    var all = document.querySelectorAll('iframe.html-stage');
    for (var i = 0; i < all.length; i++) if (mockOf(all[i]) === name) return all[i];
    return null;
  };
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.cb !== 'cb-stage' || d.type !== 'height') return;
    var all = document.querySelectorAll('iframe.html-stage');
    for (var i = 0; i < all.length; i++) {
      if (all[i].contentWindow !== ev.source) continue;
      log.reports.push({ seq: ++seq, mock: mockOf(all[i]), h: d.height, boxBefore: all[i].getBoundingClientRect().height });
      return;
    }
  }, true);
  new MutationObserver(function (records) {
    records.forEach(function (r) {
      var f = r.target;
      if (f.tagName !== 'IFRAME') return;
      var name = mockOf(f);
      if (name) log.boxes.push({ seq: ++seq, mock: name, style: f.style.height, rectH: f.getBoundingClientRect().height });
    });
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'] });
  document.addEventListener('scroll', function (ev) {
    if (ev.target === document) log.scrolls.push({ seq: ++seq, y: window.scrollY });
  }, true);
})();`;

const parentStateExpr = name => `(function () {
  var f = window.__cbFrame(${JSON.stringify(name)});
  if (!f) return null;
  var block = f.closest('.html-block');
  var r = f.getBoundingClientRect();
  var btn = block && block.querySelector('.stage-fold-toggle');
  var br = btn ? btn.getBoundingClientRect() : null;
  return {
    top: r.top, left: r.left, h: r.height, w: r.width, bottom: r.bottom,
    styleH: f.style.height, edgeTop: f.clientTop, edgeLeft: f.clientLeft,
    folded: !!block && block.classList.contains('stage-folded'),
    opened: !!block && block.classList.contains('stage-opened'),
    bar: btn ? { text: btn.textContent, shown: br.height > 0 && br.width > 0, top: br.top, left: br.left,
      w: br.width, h: br.height, expanded: btn.getAttribute('aria-expanded') } : null,
    scrollY: window.scrollY, innerH: window.innerHeight,
    headClear: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head-clear')),
  };
})()`;

// Installed in each stage's own document, through its own Chrome target.
// `contentH` is an independent reading of how tall the mock is: the lowest
// margin edge of anything in it, so a collapsed bottom margin counts.
const FRAME_PROBE = `window.__cbFP = {
  m: function () {
    var se = document.scrollingElement || document.documentElement;
    var bottom = 0;
    var all = document.body.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.position === 'fixed') continue;
      var r = el.getBoundingClientRect();
      bottom = Math.max(bottom, r.bottom + window.scrollY + (parseFloat(cs.marginBottom) || 0));
    }
    return { scrollHeight: se.scrollHeight, clientHeight: se.clientHeight, scrollWidth: se.scrollWidth,
      clientWidth: se.clientWidth, scrollTop: se.scrollTop, scrollLeft: se.scrollLeft,
      innerHeight: window.innerHeight, innerWidth: window.innerWidth, contentH: bottom,
      overflowX: getComputedStyle(se).overflowX };
  },
  rect: function (sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, w: r.width, h: r.height, bottom: r.bottom };
  },
  pane: function () {
    var p = document.getElementById('pane');
    return p ? { scrollTop: p.scrollTop, top: p.getBoundingClientRect().top } : null;
  },
};
true`;

// ---------------------------------------------------------------------------
// The board page, opened with the probe installed, and every stage's own target
// found by the name its mock carries.
async function openBoard(send, onEvent, url, cookie, { names = ALL, os = null, setting = null } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const sp = (method, params) => send(method, params, sessionId);

  const frameSessions = [];
  onEvent(msg => {
    if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
      frameSessions.push(msg.params.sessionId);
    }
  });
  const loadFired = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { off(); resolve(); }
    });
  });

  await sp('Page.enable');
  await sp('Runtime.enable');
  await sp('Page.addScriptToEvaluateOnNewDocument', { source: PARENT_PROBE });
  // The colour scheme the OS asks for and the board's own stored setting, both
  // fixed before the page loads: the board reads each in its head.
  if (os) {
    await sp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: os }] });
    await sp('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
      if (window !== window.top) return;
      try {
        if (${JSON.stringify(setting)}) window.localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)}, ${JSON.stringify(setting)});
        else window.localStorage.removeItem(${JSON.stringify(THEME_STORAGE_KEY)});
      } catch (e) {}
    })();` });
  }
  await sp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await setSessionCookie(sp, cookie);
  await sp('Page.navigate', { url });
  await withTimeout(loadFired, 20000, `page never fired load: ${url}`);

  // Name every stage's target; a target attached before its srcdoc parsed answers
  // null until it has.
  const stages = new Map();
  const deadline = Date.now() + 20000;
  while (stages.size < names.length) {
    for (const sid of frameSessions) {
      if ([...stages.values()].includes(sid)) continue;
      const name = await mockNameIn(send, sid);
      if (name && names.includes(name)) {
        await evalIn(send, sid, FRAME_PROBE);
        stages.set(name, sid);
      }
    }
    if (stages.size === names.length) break;
    if (Date.now() >= deadline) {
      throw new Error(`only ${stages.size} of ${names.length} stage targets found (${[...stages.keys()].join(', ')}); `
        + `${frameSessions.length} iframe targets attached`);
    }
    await sleep(200);
  }
  return { sp, stages, frameSessions, targetId, sessionId };
}

/** The name the mock in one frame target carries, or null while its srcdoc has
 * not parsed or once the target has gone. */
async function mockNameIn(send, sid) {
  try {
    return await evalIn(send, sid, `(function () { var el = document.querySelector('[data-mock]'); return el ? el.getAttribute('data-mock') : null; })()`);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
async function main() {
  requireChrome('browser-check-stage-fold');

  const daemon = await startScratchDaemon('cb-stage-fold');
  try {
    const daemonPort = await daemon.port();
    const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, boardBody(), daemon.secret);
    assert.ok(posted.url, `daemon did not return a board url: ${JSON.stringify(posted)}`);
    const boardUrl = `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`;

    // Classic scrollbars, whatever the Mac's "Show scroll bars" setting: the Pull-out
    // rows measure the one a frame draws, and the wide 100vh row counts its sideways one.
    await withChrome({ tag: 'cb-stage-fold', classicScrollbars: true }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);
      const { sp, stages } = await openBoard(send, onEvent, boardUrl, cookie);
      await runRows({ send, sp, stages });
      await runInkRows({
        send,
        open: async (body, opts) => {
          const made = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, body, daemon.secret);
          return openBoard(send, onEvent, `http://127.0.0.1:${daemonPort}${new URL(made.url).pathname}`, cookie, opts);
        },
      });
    });
  } finally {
    await daemon.stop();
  }
}

async function runRows({ send, sp, stages }) {
  // Page-side and frame-side readers.
  const evalPage = expr => sp('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
    if (r.exceptionDetails) throw new Error(`page eval threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  });
  const frame = (name, expr) => evalIn(send, stages.get(name), expr);
  const state = name => evalPage(parentStateExpr(name));
  const metrics = name => frame(name, 'window.__cbFP.m()');
  const frameRect = (name, sel) => frame(name, `window.__cbFP.rect(${JSON.stringify(sel)})`);
  const getLog = () => evalPage('window.__cbLog');
  const seqNow = () => evalPage('window.__cbSeq()');

  async function instantScrollTo(y) {
    return evalPage(`(function () {
      var root = document.documentElement, was = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.scrollTo(0, Math.max(0, ${y}));
      root.style.scrollBehavior = was;
      return window.scrollY;
    })()`);
  }

  /** Waits until `read()` returns the same value for `stableMs`, polling, and
   * throws past `deadlineMs`. */
  async function waitStable(read, { stableMs = 1000, deadlineMs = 15000, everyMs = 100, what = 'value' } = {}) {
    const deadline = Date.now() + deadlineMs;
    let last = await read();
    let since = Date.now();
    for (;;) {
      await sleep(everyMs);
      const now = await read();
      if (JSON.stringify(now) !== JSON.stringify(last)) { last = now; since = Date.now(); }
      else if (Date.now() - since >= stableMs) return last;
      if (Date.now() >= deadline) throw new Error(`${what} never settled within ${deadlineMs}ms (last ${JSON.stringify(last)})`);
    }
  }

  /** Scrolls the board so the stage's top sits `at` px under the window's top,
   * then waits until it has reported twice and its box has held for a second
   * (past the 300ms settle a shrink waits out). */
  async function focusStage(name, at = 100) {
    const s = await state(name);
    await instantScrollTo(s.top + s.scrollY - at);
    await settle(name);
  }

  async function settle(name) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const log = await getLog();
      if (log.reports.filter(r => r.mock === name).length >= 2) break;
      if (Date.now() >= deadline) throw new Error(`${name} never sent two height reports`);
      await sleep(100);
    }
    await waitStable(async () => (await state(name)).h, { what: `${name}'s box` });
  }

  async function clickAt(x, y) {
    await sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async function wheelAt(x, y, deltaX, deltaY) {
    await sp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  }

  /** A real click on the stage's Show full height / Show less bar. */
  async function clickBar(name) {
    await evalPage(`(function () {
      var root = document.documentElement, was = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.__cbFrame(${JSON.stringify(name)}).closest('.html-block').querySelector('.stage-fold-toggle').scrollIntoView({ block: 'center' });
      root.style.scrollBehavior = was;
    })()`);
    const s = await state(name);
    assert.ok(s.bar && s.bar.shown, `${name}: no visible bar to click`);
    await clickAt(s.bar.left + s.bar.w / 2, s.bar.top + s.bar.h / 2);
    await waitStable(async () => (await state(name)).h, { what: `${name}'s box after the bar` });
  }

  /** A real click on an element inside the stage, at its centre. */
  async function clickInStage(name, sel) {
    const s = await state(name);
    const r = await frameRect(name, sel);
    assert.ok(r, `${name}: no ${sel} in the mock`);
    const x = s.left + s.edgeLeft + r.left + r.w / 2;
    const y = s.top + s.edgeTop + r.top + r.h / 2;
    assert.ok(y > 0 && y < s.innerH, `${name}: ${sel} is off screen (y ${y})`);
    await clickAt(x, y);
  }

  async function sampleHeights(name, ms) {
    const out = [];
    const end = Date.now() + ms;
    while (Date.now() < end) { out.push((await state(name)).h); await sleep(100); }
    return out;
  }

  // Before any stage is scrolled into view: how many had reported at all. Printed,
  // not asserted: Chrome may throttle rendering in an off-screen cross-origin
  // frame, and a stage reports from an animation frame, so the count varies run
  // to run (QUIRKS.md "A stage below the fold may send no height").
  await sleep(1500);
  {
    const log = await getLog();
    const reported = ALL.filter(n => log.reports.some(r => r.mock === n));
    console.log(`# ${reported.length} of ${ALL.length} stages reported a height before any was scrolled to `
      + `(${reported.join(', ') || 'none'})`);
  }

  // --- AC 7: a short stage fits ----------------------------------------------
  for (const place of ['top', 'ctx']) {
    const name = `short-${place}`;
    await row(`AC7 (${place}): a short mock renders at its content height with no inner vertical scrollbar`, async note => {
      await focusStage(name);
      const s = await state(name);
      const m = await metrics(name);
      const hbar = m.innerHeight - m.clientHeight;
      const want = Math.ceil(m.contentH + hbar) + BORDER;
      note(`frame ${s.h}px (style ${s.styleH}); content ${m.contentH}px + horizontal bar ${hbar}px + border ${BORDER} = ${want}; `
        + `inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}`);
      assert.ok(m.contentH + BORDER < PLACEHOLDER, `fixture is not short: content ${m.contentH}px`);
      assert.ok(near(s.h, want), `frame ${s.h}px is not its content height ${want}px`);
      assert.ok(m.scrollHeight <= m.clientHeight, `inner vertical scroll: scrollHeight ${m.scrollHeight} > clientHeight ${m.clientHeight}`);
      assert.ok(!s.folded && !s.opened, `a fitting stage carries a fold state (folded ${s.folded}, opened ${s.opened})`);
      assert.ok(s.bar && !s.bar.shown, 'the Show full height bar shows under a stage that fits');
      const log = await getLog();
      const reps = log.reports.filter(r => r.mock === name);
      const boxes = log.boxes.filter(b => b.mock === name);
      const firstLow = boxes.find(b => b.rectH < PLACEHOLDER);
      note(`reports ${reps.map(r => r.h).join(', ')}; boxes ${boxes.map(b => b.rectH).join(', ')}`);
      assert.ok(firstLow, 'the box never went under the 320px placeholder');
      const before = reps.filter(r => r.seq < firstLow.seq);
      assert.ok(before.length >= 2 && before.at(-1).h === before.at(-2).h,
        `went under 320 to ${firstLow.rectH}px after reports [${before.map(r => r.h).join(', ')}]: the last two do not match`);
    });
  }

  await row('AC7 (top): a one-line mock stops at the 120px floor', async note => {
    const name = 'tiny-top';
    await focusStage(name);
    const s = await state(name);
    const m = await metrics(name);
    note(`frame ${s.h}px; content ${m.contentH}px; inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}`);
    assert.ok(m.contentH + BORDER < FLOOR, `fixture is not under the floor: content ${m.contentH}px`);
    assert.equal(s.h, FLOOR);
    assert.ok(m.scrollHeight <= m.clientHeight, 'inner vertical scroll on a floored stage');
  });

  // --- The Pull-out and the frame's own scrollbar (ADR.md entry 120) ----------
  // This Chrome draws classic scrollbars (`classicScrollbars` in main), which take
  // their width out of the frame's right edge, just inside its border; an overlay
  // bar takes none. The bar's width is read inside the frame itself, and the
  // Pull-out's place off the frame's own box in the board, so nothing here is the
  // board's word for it.
  // `marked` is the board's own word, that this frame scrolls inside
  // (.stage-scrolls on the stage's block), read beside the geometry it explains.
  const pullOut = name => evalPage(`(function () {
    var f = window.__cbFrame(${JSON.stringify(name)});
    var btn = f && f.closest('.stage-wrap').querySelector('.pull-out');
    if (!btn) return null;
    var r = btn.getBoundingClientRect(), fr = f.getBoundingClientRect();
    return { top: r.top - fr.top, right: fr.right - r.right, w: r.width, h: r.height,
      marked: f.closest('.html-block').classList.contains('stage-scrolls'),
      measured: getComputedStyle(document.body).getPropertyValue('--stage-scrollbar-w').trim() };
  })()`);

  /** A stage scrolling inside its frame, whatever holds its box there: the
   * Pull-out stands clear of the bar. Returns the stage's state, for the row to
   * say which box that is. */
  async function pullOutClearsBar(name, note) {
    await focusStage(name);
    const s = await state(name);
    const m = await metrics(name);
    const p = await pullOut(name);
    const bar = m.innerWidth - m.clientWidth;
    assert.ok(p, `${name}: no Pull-out in the frame's wrapper`);
    note(`${name}: frame ${s.h}px, inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}, `
      + `vertical scrollbar ${bar}px inside a ${s.edgeLeft}px border; the board measured "${p.measured}"; `
      + `Pull-out ${p.w}x${p.h}, ${p.top}px from the top, ${p.right}px from the right`);
    assert.ok(m.scrollHeight > m.clientHeight, `${name}: fixture does not scroll inside`);
    assert.ok(bar > 0, `${name}: this Chrome drew no classic scrollbar, so the row proves nothing`);
    assert.ok(p.marked, `${name}: the frame scrolls inside and its block is not marked .stage-scrolls`);
    assert.ok(p.right >= s.edgeLeft + bar,
      `${name}: the Pull-out covers ${s.edgeLeft + bar - p.right}px of the frame's ${bar}px scrollbar track`);
    assert.equal(p.measured, `${bar}px`, `${name}: the board's measure is not the bar the frame draws`);
    assert.ok(near(p.right, 8 + bar, 0.5), `${name}: ${p.right}px from the right, not 8px past the ${bar}px bar`);
    assert.ok(near(p.top, 8, 0.5), `${name}: ${p.top}px from the top, not 8px`);
    return s;
  }

  /** A stage that fits: the Pull-out is where it has always been. */
  async function pullOutInCorner(name, note) {
    await focusStage(name);
    const s = await state(name);
    const m = await metrics(name);
    const p = await pullOut(name);
    assert.ok(p, `${name}: no Pull-out in the frame's wrapper`);
    note(`${name}: frame ${s.h}px, inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}; `
      + `Pull-out ${p.top}px from the top, ${p.right}px from the right`);
    assert.ok(m.scrollHeight <= m.clientHeight && !s.folded, `${name}: fixture does not fit`);
    assert.ok(!p.marked, `${name}: nothing scrolls inside and its block is marked .stage-scrolls`);
    assert.ok(near(p.right, 8, 0.5), `${name}: ${p.right}px from the right, not 8px`);
    assert.ok(near(p.top, 8, 0.5), `${name}: ${p.top}px from the top, not 8px`);
  }

  await row('Pull-out: on a folded stage it stands clear of the frame\'s classic vertical scrollbar, 8px past the track, and on a stage that fits it sits 8px from the frame\'s top and right', async note => {
    for (const name of ['tall-top', 'tall-ctx']) {
      const s = await pullOutClearsBar(name, note);
      assert.ok(s.folded && s.h === CAP, `${name}: fixture is not folded at the cap (folded ${s.folded}, ${s.h}px)`);
    }
    await pullOutInCorner('short-top', note);
  });

  await row('Pull-out: in a rendered-variant option clipped at the cap, never folded, it stands clear of the scrollbar too, and in one that fits it sits 8px from the top and right', async note => {
    const s = await pullOutClearsBar('tall-var', note);
    assert.equal(s.h, CAP, 'tall-var: fixture is not held at the cap');
    assert.ok(!s.folded && !s.opened, `tall-var: a variant option's stage carries a fold state (folded ${s.folded}, opened ${s.opened})`);
    await pullOutInCorner('short-var', note);
  });

  // An opened stage scrolls inside too, wherever its mock is taller than the box
  // it opened to. 'huge' is past the 30,000px an open stops at, so it opens with
  // 10,000px still under it. 'vh' is three 100vh sections: it opens to the
  // height it reported folded, and each section then grows to the opened frame.
  // Show less afterwards, so the rows below find both stages folded.
  await row('Pull-out: on an opened stage that still scrolls inside it stands clear of the frame\'s scrollbar: one opened at the 30,000px limit over a taller mock, and one whose 100vh mock has outgrown the height it opened to', async note => {
    for (const [name, limit] of [['huge-top', OPEN_CAP], ['vh-top', null]]) {
      await focusStage(name);
      await clickBar(name);
      try {
        const s = await pullOutClearsBar(name, note);
        assert.ok(s.opened && !s.folded, `${name}: fixture is not opened (folded ${s.folded}, opened ${s.opened})`);
        if (limit) assert.equal(s.h, limit, `${name}: fixture did not open to the limit`);
      } finally {
        await clickBar(name);
      }
    }
  });

  // --- AC 8: a tall stage folds, opens, folds back ----------------------------
  for (const place of ['top', 'ctx']) {
    const name = `tall-${place}`;
    await row(`AC8 (${place}): a tall mock folds at 600 behind Show full height, opens to its content height, Show less returns 600`, async note => {
      await focusStage(name);
      let s = await state(name);
      const m = await metrics(name);
      note(`folded: frame ${s.h}px; inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}; content ${m.contentH}px; `
        + `bar "${s.bar && s.bar.text}" top ${s.bar && s.bar.top} vs frame bottom ${s.bottom}`);
      assert.equal(s.h, CAP, 'folded box');
      assert.ok(s.folded && !s.opened, `fold state (folded ${s.folded}, opened ${s.opened})`);
      assert.ok(m.scrollHeight > m.clientHeight, 'a folded stage does not scroll inside');
      assert.ok(s.bar && s.bar.shown && s.bar.text === 'Show full height' && s.bar.expanded === 'false', `bar ${JSON.stringify(s.bar)}`);
      assert.ok(s.bar.top >= s.bottom - 0.5, `bar top ${s.bar.top} is not under the frame (bottom ${s.bottom})`);

      // It scrolls inside: a real wheel over the frame moves the mock.
      await wheelAt(s.left + s.w / 2, s.top + s.h / 2, 0, 400);
      const moved = await waitStable(async () => (await metrics(name)).scrollTop, { stableMs: 400, deadlineMs: 4000, what: 'inner scroll' });
      note(`a 400px wheel over the folded frame: inner scrollTop ${moved}`);
      assert.ok(moved > 0, 'a wheel over the folded frame did not scroll the mock');
      await frame(name, 'window.scrollTo(0, 0); true');

      const hbar = m.innerHeight - m.clientHeight;
      const full = Math.min(Math.ceil(m.contentH + hbar) + BORDER, OPEN_CAP);
      await clickBar(name);
      s = await state(name);
      const mo = await metrics(name);
      note(`opened: frame ${s.h}px (want ${full}); inner scrollHeight ${mo.scrollHeight} / clientHeight ${mo.clientHeight}; bar "${s.bar.text}"`);
      assert.ok(near(s.h, full), `opened box ${s.h}px is not the content height ${full}px`);
      assert.ok(s.opened && !s.folded, `fold state after opening (folded ${s.folded}, opened ${s.opened})`);
      assert.ok(mo.scrollHeight <= mo.clientHeight, 'an opened stage still scrolls inside');
      assert.ok(s.bar.shown && s.bar.text === 'Show less' && s.bar.expanded === 'true', `bar ${JSON.stringify(s.bar)}`);

      await clickBar(name);
      s = await state(name);
      note(`Show less: frame ${s.h}px; bar "${s.bar.text}"`);
      assert.equal(s.h, CAP, 'Show less box');
      assert.ok(s.folded && !s.opened && s.bar.text === 'Show full height', 'fold state after Show less');
    });
  }

  await row('AC8 (top): an opened stage stops at 30,000px', async note => {
    const name = 'huge-top';
    await focusStage(name);
    let s = await state(name);
    assert.equal(s.h, CAP, 'folded box');
    await clickBar(name);
    s = await state(name);
    const m = await metrics(name);
    note(`opened: frame ${s.h}px; inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}`);
    assert.equal(s.h, OPEN_CAP, 'opened box');
    assert.ok(s.opened, 'not marked opened');
    await clickBar(name);
    s = await state(name);
    assert.equal(s.h, CAP, 'Show less box');
  });

  // Show less is pressed at the foot of an opened stage, so the frame's top is
  // far above the window and, folded, all of the frame would be. The board
  // moves once. The bar just pressed ends in sight, above whatever bottom
  // chrome the page is showing, and the folded frame's top comes down to
  // --head-clear where the window has room for both; where it has not, the
  // bar stops on the chrome's top edge and the frame's top stays above the
  // clearance by what the window is short.
  for (const place of ['top', 'ctx']) {
    const name = `tall-${place}`;
    await row(`AC8 (${place}): Show less at the foot of an opened stage leaves its bar in sight, below the header and above the bottom chrome with nothing drawn over it, the folded frame's top at --head-clear or above it by what the window is short, the board moving up once`, async note => {
      await focusStage(name);
      await clickBar(name);
      const opened = await state(name);
      assert.ok(opened.opened && opened.h > CAP, `setup failure: fixture did not open (${opened.h}px)`);
      // The board scrolled down to the bar, the way a reader gets there: the
      // bar at mid-window, the stage's top a long way above it.
      await instantScrollTo(opened.scrollY + opened.bar.top + opened.bar.h / 2 - opened.innerH / 2);
      const s0 = await state(name);
      const headBottom = await evalPage(`document.querySelector('.board-head').getBoundingClientRect().bottom`);
      assert.ok(s0.top < 0, `setup failure: the opened frame's top (${s0.top}px) is not above the window`);
      assert.ok(s0.bar.top > headBottom && s0.bar.top + s0.bar.h < s0.innerH, `setup failure: the bar (top ${s0.bar.top}px) is not in the window to press`);
      const seq0 = await seqNow();
      await clickAt(s0.bar.left + s0.bar.w / 2, s0.bar.top + s0.bar.h / 2);
      await sleep(150);
      await waitStable(async () => { const s = await state(name); return [s.scrollY, s.h]; },
        { stableMs: 800, deadlineMs: 6000, what: 'the board after Show less' });
      const s1 = await state(name);
      const steps = (await getLog()).scrolls.filter(e => e.seq > seq0).map(e => e.y);
      const oneWay = steps.every((y, i) => i === 0 || y <= steps[i - 1]);
      const barBottom = s1.bar.top + s1.bar.h;
      // What a press on the bar would reach, at its centre and along its
      // lower edge: the bar itself, unless some sticky chrome is drawn over it.
      const onTop = await evalPage(`(function () {
        function at(y) {
          var el = document.elementFromPoint(${s1.bar.left + s1.bar.w / 2}, y);
          return el ? el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '') : null;
        }
        return { centre: at(${s1.bar.top + s1.bar.h / 2}), foot: at(${barBottom - 1}) };
      })()`);
      // The bottom chrome the page is showing, each box where it stands.
      const chrome = await evalPage(`['.send-bar', '.questions-left-pill', '.round-pager-dock'].map(function (sel) {
        var el = document.querySelector(sel);
        var r = el ? el.getBoundingClientRect() : null;
        return r && r.height > 0 ? { sel: sel, top: r.top } : null;
      }).filter(Boolean)`);
      const floor = Math.min(s1.innerH, ...chrome.map(c => c.top));
      // Where the frame's top belongs: at the clearance, or as far down as the
      // bar under it can come before the chrome is drawn over it.
      const roomy = floor - (barBottom - s1.top) >= s1.headClear;
      const wantTop = roomy ? s1.headClear : floor - (barBottom - s1.top);
      note(`opened ${s0.h}px, Show less pressed ${s0.bar.top}px down a ${s0.innerH}px window with the frame's top at ${s0.top}px; `
        + `folded: frame ${s1.h}px, top ${s1.top}px under the window top (--head-clear ${s1.headClear}), `
        + `bar "${s1.bar.text}" ${s1.bar.top}px to ${barBottom}px (topmost at its centre: ${onTop.centre}, at its foot: ${onTop.foot}), header ends at ${headBottom}px; `
        + `bottom chrome showing: ${chrome.map(c => `${c.sel} from ${c.top}px`).join(', ') || 'none'}; `
        + `${roomy ? 'the window shows the frame and its bar together' : `the window is ${s1.headClear - wantTop}px short of showing both, the bar wins`}; `
        + `board scrollY ${s0.scrollY} -> ${s1.scrollY}; ${steps.length} board scroll events, ${oneWay ? 'one direction' : 'direction reversed'}`);
      assert.ok(s1.folded && !s1.opened && s1.h === CAP, `Show less did not fold the stage (${s1.h}px, folded ${s1.folded})`);
      assert.ok(s1.bar.shown && s1.bar.top >= headBottom, `the bar (top ${s1.bar.top}px) is under the header (bottom ${headBottom}px)`);
      assert.ok(barBottom <= s1.innerH, `the bar (bottom ${barBottom}px) is below the ${s1.innerH}px window`);
      assert.ok(barBottom <= floor, `the bar (bottom ${barBottom}px) is under the bottom chrome, which starts ${floor}px down`);
      assert.ok(/^button\.stage-fold-toggle/.test(onTop.centre) && /^button\.stage-fold-toggle/.test(onTop.foot),
        `something is drawn over the bar: ${onTop.centre} at its centre, ${onTop.foot} at its foot`);
      assert.ok(s1.top <= s1.headClear + 2, `the folded frame's top is ${s1.top}px under the window top, lower than --head-clear ${s1.headClear}`);
      assert.ok(near(s1.top, wantTop, 2), roomy
        ? `the folded frame's top is ${s1.top}px under the window top, not ${s1.headClear}`
        : `the bar (bottom ${barBottom}px) stopped short of the bottom chrome at ${floor}px: the frame's top is ${s1.top}px down, not ${wantTop}`);
      if (roomy) assert.ok(s1.top >= s1.headClear, `the folded frame's top is ${s1.top}px under the window top, above --head-clear ${s1.headClear}`);
      assert.ok(s1.scrollY < s0.scrollY, `the board did not move up: ${s0.scrollY} -> ${s1.scrollY}`);
      assert.ok(steps.length > 0 && oneWay, `not one board scroll: ${steps.join(', ')}`);
    });
  }

  // --- AC 9: a viewport-unit mock settles -------------------------------------
  for (const place of ['top', 'ctx']) {
    const name = `vh-${place}`;
    await row(`AC9 (${place}): a 100vh mock settles at one height folded and opened, and never grows on its own`, async note => {
      await focusStage(name);
      let s = await state(name);
      const folded = await sampleHeights(name, 2000);
      const m = await metrics(name);
      note(`folded: frame ${s.h}px, held ${[...new Set(folded)].join('/')} over 2s; inner scrollHeight ${m.scrollHeight} / clientHeight ${m.clientHeight}`);
      assert.ok(s.folded, 'a 100vh mock past the cap is not folded');
      assert.deepEqual([...new Set(folded)], [CAP], 'the folded box moved on its own');

      const hbar = m.innerHeight - m.clientHeight;
      const snapshot = Math.min(m.scrollHeight + hbar + BORDER, OPEN_CAP);
      await clickBar(name);
      const opened = await sampleHeights(name, 2000);
      s = await state(name);
      const mo = await metrics(name);
      note(`opened: frame ${s.h}px, held ${[...new Set(opened)].join('/')} over 2s (snapshot at open ${snapshot}); `
        + `inner scrollHeight now ${mo.scrollHeight}`);
      assert.ok(s.opened, 'not marked opened');
      assert.equal(new Set(opened).size, 1, `the opened box moved on its own: ${opened.join(', ')}`);
      assert.ok(near(opened[0], snapshot), `opened box ${opened[0]}px is not the height reported at open, ${snapshot}px`);

      await clickBar(name);
      const back = await sampleHeights(name, 1000);
      assert.deepEqual([...new Set(back)], [CAP], 'Show less did not settle back at the cap');
    });
  }

  // --- AC 13: a wide mock keeps its sideways scroll --------------------------
  for (const place of ['top', 'ctx']) {
    const name = `wide-${place}`;
    await row(`AC13 (${place}): a wide mock keeps its sideways scroll, folded and opened`, async note => {
      async function sideways(label) {
        const s = await state(name);
        const m = await metrics(name);
        await frame(name, 'window.scrollTo(0, window.scrollY); document.scrollingElement.scrollLeft = 0; true');
        const y = Math.min(Math.max(s.top + 100, 20), s.innerH - 20);
        await wheelAt(s.left + s.w / 2, y, 300, 0);
        const left = await waitStable(async () => (await metrics(name)).scrollLeft, { stableMs: 400, deadlineMs: 4000, what: 'sideways scroll' });
        note(`${label}: frame ${s.h}px; scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth}; overflow-x ${m.overflowX}; `
          + `horizontal bar ${m.innerHeight - m.clientHeight}px; a 300px sideways wheel: scrollLeft ${left}`);
        assert.ok(m.scrollWidth > m.clientWidth, `${label}: nothing to scroll sideways`);
        assert.ok(left > 0, `${label}: a sideways wheel did not move the mock`);
        await frame(name, 'document.scrollingElement.scrollLeft = 0; true');
        return { s, m };
      }
      await focusStage(name);
      const { s, m } = await sideways('folded');
      assert.ok(s.folded && s.h === CAP, `not folded at the cap (${s.h}px)`);
      await clickBar(name);
      await focusStage(name);
      const opened = await sideways('opened');
      const hbar = m.innerHeight - m.clientHeight;
      assert.ok(opened.s.opened && near(opened.s.h, Math.ceil(m.contentH + hbar) + BORDER),
        `opened box ${opened.s.h}px, want ${Math.ceil(m.contentH + hbar) + BORDER}`);
      assert.ok(opened.m.scrollHeight <= opened.m.clientHeight, 'the opened wide mock still scrolls vertically inside');
      await clickBar(name);
    });
  }

  // --- A wide 100vh mock counts its sideways scrollbar once ------------------
  await row('Wide 100vh (top): a mock one viewport tall and wider than its frame settles at one height under 600, with no Show full height', async note => {
    const name = 'widevh-top';
    await focusStage(name);
    const held = await sampleHeights(name, 2000);
    const s = await state(name);
    const m = await metrics(name);
    const reports = (await getLog()).reports.filter(r => r.mock === name).map(r => r.h);
    note(`frame ${s.h}px, held ${[...new Set(held)].join('/')} over 2s; reports ${reports.join(', ')}; `
      + `innerHeight ${m.innerHeight} / clientHeight ${m.clientHeight} (sideways bar ${m.innerHeight - m.clientHeight}px); `
      + `scrollWidth ${m.scrollWidth} / clientWidth ${m.clientWidth}`);
    assert.ok(m.innerHeight - m.clientHeight > 0, 'setup failure: no classic sideways scrollbar to count');
    assert.ok(m.scrollWidth > m.clientWidth, 'setup failure: the mock is not wider than its frame');
    assert.equal(new Set(held).size, 1, `the box moved on its own: ${held.join(', ')}`);
    assert.ok(held[0] < CAP, `settled at ${held[0]}px, at the fold`);
    assert.ok(!s.folded && !s.opened, `marked ${s.folded ? 'folded' : 'opened'}`);
    assert.ok(!(s.bar && s.bar.shown), 'Show full height shows');
  });

  // --- AC 14: an in-page link -------------------------------------------------
  /** Clicks the mock's table-of-contents link with the board scrolled so the
   * stage's top sits `at` px down (150 unless given), and reports what moved. A
   * stage that scrolls to its own target puts it at the top of the box that
   * scrolls: the header band it would land under is reported to a page board's
   * stage alone (src/ui.mjs's reportStageBand), so on this ordinary board it is
   * 0. */
  async function followToc(name, at = 150) {
    await focusStage(name, at);
    const s0 = await state(name);
    const t0 = await frameRect(name, '#target');
    const m0 = await metrics(name);
    const seq0 = await seqNow();
    await clickInStage(name, '#toc');
    // Wait for whatever moves to stop: the board, the frame, and a pane inside it.
    const read = async () => {
      const [s, m, p] = await Promise.all([state(name), metrics(name), frame(name, 'window.__cbFP.pane()')]);
      return [s.scrollY, m.scrollTop, p && p.scrollTop];
    };
    await sleep(150);
    await waitStable(read, { stableMs: 800, deadlineMs: 6000, what: 'the scroll after the link' });
    const s1 = await state(name);
    const t1 = await frameRect(name, '#target');
    const m1 = await metrics(name);
    const scrolls = (await getLog()).scrolls.filter(e => e.seq > seq0).map(e => e.y);
    return { s0, t0, m0, s1, t1, m1, scrolls };
  }

  function assertOneBoardScroll(r, note) {
    const want = r.s0.scrollY + (r.s0.top + r.s0.edgeTop + r.t0.top) - r.s1.headClear;
    const landed = r.s1.top + r.s1.edgeTop + r.t1.top;
    const steps = r.scrolls;
    const monotonic = steps.every((y, i) => i === 0 || y >= steps[i - 1]);
    note(`board scrollY ${r.s0.scrollY} -> ${r.s1.scrollY} (want ${want}); target lands ${landed}px under the window top `
      + `(--head-clear ${r.s1.headClear}); frame scrollTop ${r.m0.scrollTop} -> ${r.m1.scrollTop}; `
      + `${steps.length} board scroll events, ${monotonic ? 'one direction' : 'direction reversed'}`);
    assert.ok(r.s0.scrollY > 0, 'the board was not scrolled partway before the click');
    assert.ok(near(landed, r.s1.headClear, 2), `target landed ${landed}px under the top, not ${r.s1.headClear}`);
    assert.ok(near(r.s1.scrollY, want, 2), `board scrollY ${r.s1.scrollY}, want ${want}`);
    assert.equal(r.m1.scrollTop, 0, 'the frame scrolled too');
    assert.ok(steps.length > 0 && monotonic, `not one board scroll: ${steps.join(', ')}`);
  }

  for (const place of ['top', 'ctx']) {
    await row(`AC14 (${place}): a link in a fitted stage scrolls the board, target under the header, frame at 0, one scroll`, async note => {
      const name = `linkfit-${place}`;
      const r = await followToc(name);
      assert.ok(!r.s0.folded && !r.s0.opened && r.s0.h < CAP, `fixture does not fit (${r.s0.h}px, folded ${r.s0.folded})`);
      assert.ok(r.m0.scrollHeight <= r.m0.clientHeight, 'fixture frame scrolls inside');
      assertOneBoardScroll(r, note);
    });
  }

  for (const place of ['top', 'ctx']) {
    const name = `linktall-${place}`;
    await row(`AC14 (${place}): a link in a folded stage scrolls the frame and not the board`, async note => {
      const r = await followToc(name);
      note(`board scrollY ${r.s0.scrollY} -> ${r.s1.scrollY}; frame scrollTop ${r.m0.scrollTop} -> ${r.m1.scrollTop}; `
        + `target ${r.t1.top}px under the frame top, ${r.s1.top + r.s1.edgeTop + r.t1.top}px under the window top `
        + `(--head-clear ${r.s1.headClear}); board scroll events ${r.scrolls.length}`);
      assert.ok(r.s0.folded && r.s0.h === CAP, `fixture is not folded (${r.s0.h}px)`);
      assert.ok(r.m1.scrollTop > 0, 'the frame did not scroll');
      assert.ok(near(r.t1.top, 0, 2), `target sits ${r.t1.top}px under the frame top, want 0`);
      assert.ok(near(r.s1.scrollY, r.s0.scrollY), `the board moved: ${r.s0.scrollY} -> ${r.s1.scrollY}`);
      assert.equal(r.scrolls.length, 0, `board scroll events: ${r.scrolls.join(', ')}`);
    });

    await row(`AC14 (${place}): a link in an opened stage scrolls the board, target under the header, frame at 0, one scroll`, async note => {
      await focusStage(name);
      await clickBar(name);
      const opened = await state(name);
      assert.ok(opened.opened && opened.h > CAP, `fixture did not open (${opened.h}px)`);
      const r = await followToc(name);
      assert.ok(r.m0.scrollHeight <= r.m0.clientHeight, 'opened frame scrolls inside');
      assertOneBoardScroll(r, note);
      await clickBar(name);
    });
  }

  await row('AC14 (top): a link in a fitted 100vh app shell scrolls its own pane, not the board', async note => {
    const name = 'shell-top';
    const r = await followToc(name);
    const pane = await frame(name, 'window.__cbFP.pane()');
    note(`frame ${r.s0.h}px (folded ${r.s0.folded}); pane scrollTop ${pane.scrollTop}; target ${r.t1.top - pane.top}px under the pane top, `
      + `${r.s1.top + r.s1.edgeTop + r.t1.top}px under the window top (--head-clear ${r.s1.headClear}); `
      + `board scrollY ${r.s0.scrollY} -> ${r.s1.scrollY}; frame scrollTop ${r.m1.scrollTop}; board scroll events ${r.scrolls.length}`);
    assert.ok(!r.s0.folded && !r.s0.opened, 'fixture is not a fitted stage');
    assert.ok(pane.scrollTop > 0, 'the pane did not scroll');
    assert.ok(near(r.t1.top - pane.top, 0, 2), `target is ${r.t1.top - pane.top}px under the pane top, want 0`);
    assert.ok(near(r.s1.scrollY, r.s0.scrollY), `the board moved: ${r.s0.scrollY} -> ${r.s1.scrollY}`);
    assert.equal(r.scrolls.length, 0, `board scroll events: ${r.scrolls.join(', ')}`);
    assert.equal(r.m1.scrollTop, 0, 'the frame document scrolled');
  });

  // --- AC 14: a folded stage whose top is under the sticky header -------------
  // Off a page board the frame lands its target at its own top, so with that top
  // under the header the board has to bring it down to --head-clear, in one
  // direction, and the frame still does its own part.
  await row('AC14 (top): a link in a folded stage whose top is under the sticky header lands the target --head-clear under the window top, the board moving up once', async note => {
    const name = 'linkunder-top';
    const r = await followToc(name, 20);
    const headBottom = await evalPage(`document.querySelector('.board-head').getBoundingClientRect().bottom`);
    const landed = r.s1.top + r.s1.edgeTop + r.t1.top;
    const steps = r.scrolls;
    const oneWay = steps.every((y, i) => i === 0 || y <= steps[i - 1]);
    note(`frame top ${r.s0.top}px down the window under a header ending at ${headBottom}px (--head-clear ${r.s1.headClear}); `
      + `board scrollY ${r.s0.scrollY} -> ${r.s1.scrollY}; frame scrollTop ${r.m0.scrollTop} -> ${r.m1.scrollTop}; `
      + `target ${r.t1.top}px under the frame top, ${landed}px under the window top; `
      + `${steps.length} board scroll events, ${oneWay ? 'one direction' : 'direction reversed'}`);
    assert.ok(r.s0.folded && r.s0.h === CAP, `fixture is not folded (${r.s0.h}px)`);
    assert.ok(r.s0.top + r.s0.edgeTop < headBottom, `the frame's top (${r.s0.top}px) is not under the header (bottom ${headBottom}px)`);
    assert.ok(r.m1.scrollTop > 0, 'the frame did not scroll');
    assert.ok(near(r.t1.top, 0, 2), `target sits ${r.t1.top}px under the frame top, want 0`);
    assert.ok(landed >= r.s1.headClear, `target landed ${landed}px under the window top, above --head-clear ${r.s1.headClear}`);
    assert.ok(near(landed, r.s1.headClear, 2), `target landed ${landed}px under the top, not ${r.s1.headClear}: the board moved more than it had to`);
    assert.ok(r.s1.scrollY < r.s0.scrollY, `the board did not move up: ${r.s0.scrollY} -> ${r.s1.scrollY}`);
    assert.ok(steps.length > 0 && oneWay, `not one board scroll: ${steps.join(', ')}`);
  });

  // --- AC 14: a folded stage whose target stops below the window -------------
  // A folded stage low in the window, its frame reaching past the window's
  // bottom edge, and a target near its document's end: the frame scrolls as far
  // as it can and the target stops low in it, below the window. The board then
  // brings it up to --head-clear, in one direction.
  await row('AC14 (top): a link in a folded stage low in the window, to a target near its end, lands the target inside the window, --head-clear under its top, the board moving down once', async note => {
    const name = 'linkend-top';
    const r = await followToc(name, 450);
    const frameMax = r.m1.scrollHeight - r.m1.clientHeight;
    const alone = r.s0.top + r.s0.edgeTop + r.t1.top;
    const landed = r.s1.top + r.s1.edgeTop + r.t1.top;
    const steps = r.scrolls;
    const oneWay = steps.every((y, i) => i === 0 || y >= steps[i - 1]);
    note(`frame top ${r.s0.top}px down a ${r.s0.innerH}px window, ${r.s0.h}px tall; frame scrollTop ${r.m0.scrollTop} -> ${r.m1.scrollTop} `
      + `(max ${frameMax}); target ${r.t1.top}px under the frame top, so ${alone}px under the window top had the board stayed; `
      + `board scrollY ${r.s0.scrollY} -> ${r.s1.scrollY}; target lands ${landed}px under the window top (--head-clear ${r.s1.headClear}); `
      + `${steps.length} board scroll events, ${oneWay ? 'one direction' : 'direction reversed'}`);
    assert.ok(r.s0.folded && r.s0.h === CAP, `fixture is not folded (${r.s0.h}px)`);
    assert.ok(r.s0.top + r.s0.h > r.s0.innerH, `setup failure: the frame's bottom (${r.s0.top + r.s0.h}px) is inside the window`);
    assert.ok(near(r.m1.scrollTop, frameMax), `setup failure: the frame stopped at ${r.m1.scrollTop}, short of its end ${frameMax}`);
    assert.ok(alone > r.s0.innerH, `setup failure: the frame alone left the target at ${alone}px, inside the ${r.s0.innerH}px window`);
    assert.ok(landed >= r.s1.headClear, `target landed ${landed}px under the window top, above --head-clear ${r.s1.headClear}`);
    assert.ok(landed < r.s1.innerH, `target landed ${landed}px under the window top, below the ${r.s1.innerH}px window`);
    assert.ok(near(landed, r.s1.headClear, 2), `target landed ${landed}px under the top, not ${r.s1.headClear}`);
    assert.ok(r.s1.scrollY > r.s0.scrollY, `the board did not move down: ${r.s0.scrollY} -> ${r.s1.scrollY}`);
    assert.ok(steps.length > 0 && oneWay, `not one board scroll: ${steps.join(', ')}`);
  });

  // --- AC 7 across the whole board -------------------------------------------
  await row('AC7 (every stage): 320 until the first report, never under 120, under 320 only after two matching reports', async note => {
    const log = await getLog();
    const problems = [];
    for (const name of ALL) {
      const reps = log.reports.filter(r => r.mock === name);
      const boxes = log.boxes.filter(b => b.mock === name);
      if (!reps.length) { problems.push(`${name}: never reported`); continue; }
      if (reps[0].boxBefore !== PLACEHOLDER) problems.push(`${name}: ${reps[0].boxBefore}px at its first report`);
      const early = boxes.filter(b => b.seq < reps[0].seq);
      if (early.length) problems.push(`${name}: box written before its first report (${early.map(b => b.rectH).join(', ')})`);
      const low = boxes.filter(b => b.rectH < FLOOR);
      if (low.length) problems.push(`${name}: under ${FLOOR}px (${low.map(b => b.rectH).join(', ')})`);
      let prevH = PLACEHOLDER;
      for (const b of boxes) {
        if (b.rectH < PLACEHOLDER && prevH >= PLACEHOLDER) {
          const before = reps.filter(r => r.seq < b.seq);
          if (!(before.length >= 2 && before.at(-1).h === before.at(-2).h)) {
            problems.push(`${name}: under 320 (${b.rectH}px) after reports [${before.map(r => r.h).join(', ')}]`);
          }
        }
        prevH = b.rectH;
      }
    }
    note(`${log.reports.length} height reports and ${log.boxes.length} box writes across ${ALL.length} stages`);
    assert.deepEqual(problems, []);
  });
}

// ---------------------------------------------------------------------------
// The default ink. The artboard behind a stage is a light neutral in both
// palettes, so a mock that sets no colour has to draw the browser's light-scheme
// defaults on it in a dark board too: black text, the dark link blue, light form
// controls. Whether it does is a fact about what Chrome painted, and no computed
// style says whether a frame's canvas went opaque, so every number here is read
// off a screenshot's pixels.
//
// The probes are set in a 40px bold face (a size, never a colour) so each stroke
// has a solid core: inside a probe's box the commonest colour is what is drawn
// behind it and the second commonest is its ink.
const INK_FACE = 'font:700 40px/1.5 sans-serif';
const INK_PROBE_MARKUP = `<p id="ink-body" style="margin:0;${INK_FACE}">Body text</p>`
  + `<p style="margin:0;${INK_FACE}"><a id="ink-link" href="#ink-body">A link</a></p>`
  + `<p style="margin:0"><input id="ink-input" value="Input text" style="${INK_FACE}"></p>`
  + `<p style="margin:0"><button id="ink-button" style="${INK_FACE}">A button</button></p>`
  // Centred and narrow: clear of the pager chevrons a page board floats over its
  // stage's left and right edges.
  + '<div id="ink-empty" style="height:120px;width:400px;margin:0 auto"></div>';
const INK_MOCK = `<div data-mock="ink">${INK_PROBE_MARKUP}</div>`;

// The self-themed mock: one that themes itself the way a template written for the
// board does. It reads data-theme first, paints a dark palette and declares
// color-scheme: dark under it, paints a light one otherwise, and falls back to
// prefers-color-scheme while the attribute is absent. A background is all it
// paints, so its text, link and controls are the browser's own ink for the scheme
// the mock declared: the same probes as above, read against the mock's own
// background. Which side it drew is the colour of its empty area.
//
// The fallback is what makes it a probe for whether a document was told: inside a
// stage frame prefers-color-scheme reads light whatever the board's theme (both
// frames are declared color-scheme: light), so a copy with no data-theme draws
// the light side on a dark board.
const SELF_SIDES = { dark: '#14161a', light: '#f4f1ea' };
const SELF_MOCK = '<div data-mock="self"><style>'
  + `:root{color-scheme:light;background:${SELF_SIDES.light}}`
  + `@media (prefers-color-scheme:dark){:root:not([data-theme]){color-scheme:dark;background:${SELF_SIDES.dark}}}`
  + `:root[data-theme="dark"]{color-scheme:dark;background:${SELF_SIDES.dark}}`
  + `</style>${INK_PROBE_MARKUP}</div>`;
const INK_PROBES = [
  { id: 'ink-body', what: 'body text' },
  { id: 'ink-link', what: 'an unstyled link' },
  { id: 'ink-input', what: "an unstyled text input's text" },
  { id: 'ink-button', what: "an unstyled button's text" },
];
const INK_PASSES = [
  { label: 'dark, System on a dark OS', os: 'dark', setting: null, theme: 'dark' },
  { label: 'dark, the Dark setting on a light OS', os: 'light', setting: 'dark', theme: 'dark' },
  { label: 'light, System on a light OS', os: 'light', setting: null, theme: 'light' },
];
const INK_SURFACES = { stage: 'an ordinary stage', lens: 'the Lens', page: "a page board's stage" };
// How long a read of the Lens's copy waits for the board to tell it the theme
// before reading what it drew untold.
const LENS_TOLD_WITHIN_MS = 5000;

/** An 8-bit RGB or RGBA, non-interlaced PNG (what Page.captureScreenshot writes)
 * as a pixel reader. */
function decodePng(buf) {
  let width = 0, height = 0, bpp = 0;
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.ok(data[8] === 8 && (data[9] === 2 || data[9] === 6) && data[12] === 0,
        `screenshot PNG is not 8-bit RGB(A), non-interlaced (depth ${data[8]}, colour type ${data[9]}, interlace ${data[12]})`);
      bpp = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[from + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * bpp; return (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]; } };
}

const hex = rgb => `#${rgb.toString(16).padStart(6, '0')}`;
function luminance(rgb) {
  const lin = v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb >> 16) + 0.7152 * lin((rgb >> 8) & 255) + 0.0722 * lin(rgb & 255);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Every colour inside one box of a screenshot (window px, scaled to the PNG's),
 * commonest first. */
function coloursIn(png, scale, box) {
  const counts = new Map();
  let total = 0;
  for (let y = Math.ceil(box.top * scale); y < Math.floor(box.bottom * scale); y++) {
    for (let x = Math.ceil(box.left * scale); x < Math.floor(box.right * scale); x++) {
      const c = png.at(x, y);
      counts.set(c, (counts.get(c) || 0) + 1);
      total++;
    }
  }
  return { total, ranked: [...counts.entries()].sort((p, q) => q[1] - p[1]) };
}

/** One framed stage, read: each probe's ink and what is behind it, the empty
 * area's colours, and what the frame's own document was told. `frameSel` names
 * the iframe in the board, `sid` its own Chrome target.
 *
 * By default the document must have been told its theme before it is read, and
 * one that never is fails the read. `toldWithin` (ms) is for a document whose
 * being told is the thing under test: the read waits that long for it, then
 * reads what was drawn anyway, so an untold document reports `told: null` and
 * its colours. */
async function readSurface({ send, sp, evalPage }, frameSel, sid, { toldWithin = null } = {}) {
  const ids = [...INK_PROBES.map(p => p.id), 'ink-empty'];
  const inFrame = () => evalIn(send, sid, `(function () {
    var boxes = {};
    ${JSON.stringify(ids)}.forEach(function (id) {
      var r = document.getElementById(id).getBoundingClientRect();
      boxes[id] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    return { boxes: boxes, told: document.documentElement.getAttribute('data-theme') };
  })()`);
  const inBoard = () => evalPage(`(function () {
    var f = document.querySelector(${JSON.stringify(frameSel)});
    if (!f) return null;
    var r = f.getBoundingClientRect();
    var root = getComputedStyle(document.documentElement);
    return { left: r.left + f.clientLeft, top: r.top + f.clientTop, h: r.height, innerW: window.innerWidth,
      scheme: root.colorScheme, stageBg: root.getPropertyValue('--stage-bg').trim() };
  })()`);

  // Settled: the frame's box and its document have held for a second, and the
  // document has been told its theme, or `toldWithin` has run out waiting.
  const started = Date.now();
  const deadline = started + 15000;
  let last = null, since = Date.now();
  for (;;) {
    const now = JSON.stringify([await inBoard(), await inFrame().catch(() => null)]);
    const doc = JSON.parse(now)[1];
    const awaitTold = toldWithin == null || Date.now() - started < toldWithin;
    if (now !== last) { last = now; since = Date.now(); }
    else if (doc && (doc.told || !awaitTold) && Date.now() - since >= 1000) break;
    if (Date.now() >= deadline) throw new Error(`${frameSel} never settled (last ${last})`);
    await sleep(100);
  }
  const [board, inner] = JSON.parse(last);

  const { data } = await sp('Page.captureScreenshot', { format: 'png' });
  const png = decodePng(Buffer.from(data, 'base64'));
  const scale = png.width / board.innerW;
  const boxOf = id => {
    const b = inner.boxes[id];
    // 4px in from each edge: clear of a control's own border.
    return { left: board.left + b.left + 4, top: board.top + b.top + 4,
      right: board.left + b.right - 4, bottom: board.top + b.bottom - 4 };
  };
  // Nothing of the board's own may lie over a box that is about to be read.
  for (const id of ids) {
    const b = boxOf(id);
    const covered = await evalPage(`(function () {
      var f = document.querySelector(${JSON.stringify(frameSel)});
      return ${JSON.stringify([[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]])}
        .filter(function (p) { return document.elementFromPoint(p[0], p[1]) !== f; }).length;
    })()`);
    assert.equal(covered, 0, `fixture: ${frameSel}'s #${id} is not wholly on screen and uncovered`);
  }

  const probes = {};
  for (const { id } of INK_PROBES) {
    const { total, ranked } = coloursIn(png, scale, boxOf(id));
    assert.ok(ranked.length >= 2 && ranked[1][1] >= total / 100,
      `fixture: #${id} drew no solid ink (${ranked.length} colours over ${total}px)`);
    probes[id] = { behind: hex(ranked[0][0]), ink: hex(ranked[1][0]), ratio: contrast(ranked[0][0], ranked[1][0]) };
  }
  const empty = coloursIn(png, scale, boxOf('ink-empty'));
  return { probes, empty: { px: empty.total, colours: empty.ranked.map(([c]) => hex(c)) },
    stageBg: board.stageBg.toLowerCase(), scheme: board.scheme, told: inner.told };
}

/** One mock on an ordinary board, read under a pass's OS scheme and board
 * setting: its stage, then the Lens opened from it. `name` is the mock's
 * data-mock. Closes the board's tab. */
async function readStageAndLens({ send, open }, pass, { title, mock, name }) {
  const read = {};
  const ordinary = await open({
    title,
    // The lead block keeps this an ordinary board, with a Pull-out to press.
    blocks: [{ kind: 'markdown', text: 'One mock, on an ordinary board.' }, { kind: 'html', html: mock }],
  }, { names: [name], os: pass.os, setting: pass.setting });
  const tools = { send, sp: ordinary.sp, evalPage: expr => evalIn(send, ordinary.sessionId, expr) };
  const stageSid = ordinary.stages.get(name);
  read.stage = await readSurface(tools, 'iframe.html-stage', stageSid);

  // The Lens: a real click on the stage's Pull-out, then the copy's own target.
  const at = await tools.evalPage(`(function () {
    var r = document.querySelector('.html-block .pull-out').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await ordinary.sp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await ordinary.sp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await ordinary.sp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  let lensSid = null;
  for (const deadline = Date.now() + 15000; !lensSid;) {
    for (const sid of ordinary.frameSessions) {
      if (sid !== stageSid && await mockNameIn(send, sid) === name) lensSid = sid;
    }
    if (lensSid) break;
    if (Date.now() >= deadline) throw new Error('the Lens never opened a copy of the stage');
    await sleep(200);
  }
  // The copy is findable as soon as its markup has parsed, and the board tells it
  // the theme only when its frame fires load, which a busy Chrome can deliver
  // more than a settling second later. So the read waits for the theme, but only
  // so long: a copy that is never told has to come back as "told null" beside the
  // colours it drew, not as a timeout.
  read.lens = await readSurface(tools, 'iframe.stage-lens-frame', lensSid, { toldWithin: LENS_TOLD_WITHIN_MS });
  await send('Target.closeTarget', { targetId: ordinary.targetId });
  return read;
}

/** One pass of the mock that sets no colour: the ordinary board's stage, the Lens
 * opened from it, then a page board's stage. */
async function readInkPass({ send, open }, pass) {
  const read = await readStageAndLens({ send, open }, pass, { title: 'default ink browser check', mock: INK_MOCK, name: 'ink' });
  const opts = { names: ['ink'], os: pass.os, setting: pass.setting };

  // One html block and nothing else is a page board.
  const page = await open({ title: 'default ink browser check, page board', blocks: [{ kind: 'html', html: INK_MOCK }] }, opts);
  const isPage = await evalIn(send, page.sessionId, `!!document.querySelector('.page-comments')`);
  assert.ok(isPage, 'fixture: the one-block board did not render as a page board');
  read.page = await readSurface({ send, sp: page.sp, evalPage: expr => evalIn(send, page.sessionId, expr) },
    'iframe.html-stage', page.stages.get('ink'));
  await send('Target.closeTarget', { targetId: page.targetId });
  return read;
}

async function runInkRows({ send, open }) {
  for (const pass of INK_PASSES) {
    let read = null, failed = null;
    try { read = await readInkPass({ send, open }, pass); } catch (err) { failed = err; }
    const surfaces = () => {
      if (failed) throw failed;
      for (const [key, m] of Object.entries(read)) {
        assert.equal(m.scheme, pass.theme, `fixture: the board behind ${INK_SURFACES[key]} is not in the ${pass.theme} theme`);
        // Whether the Lens's copy was told is the self-themed rows' to say: a
        // mock that sets no colour draws the same either way.
        if (key !== 'lens') assert.equal(m.told, pass.theme, `fixture: the document on ${INK_SURFACES[key]} was not told the ${pass.theme} theme`);
      }
      return Object.entries(read);
    };

    for (const probe of INK_PROBES) {
      await row(`Default ink (${pass.label}): on a mock that sets no colour, ${probe.what} reads 4.5:1 or better against what is drawn behind it, on an ordinary stage, in the Lens and on a page board's stage`, async note => {
        const low = [];
        for (const [key, m] of surfaces()) {
          const p = m.probes[probe.id];
          const line = `${INK_SURFACES[key]}: ${p.ink} on ${p.behind}, ${p.ratio.toFixed(2)}:1`;
          note(line);
          if (!(p.ratio >= 4.5)) low.push(line);
        }
        assert.deepEqual(low, []);
      });
    }

    await row(`Artboard (${pass.label}): the empty area of a mock that paints nothing shows --stage-bg, never an opaque white or black canvas, on an ordinary stage, in the Lens and on a page board's stage`, async note => {
      const wrong = [];
      for (const [key, m] of surfaces()) {
        const line = `${INK_SURFACES[key]}: ${m.empty.colours.join(', ')} over ${m.empty.px}px; --stage-bg is ${m.stageBg}`;
        note(line);
        const [only] = m.empty.colours;
        if (m.empty.colours.length !== 1 || only !== m.stageBg || only === '#ffffff' || only === '#000000') wrong.push(line);
      }
      assert.deepEqual(wrong, []);
    });

    // The self-themed mock, on its own board: one row for its stage and one for
    // the Lens's copy, so a copy that was not told is that row and no other.
    let self = null, selfFailed = null;
    try {
      self = await readStageAndLens({ send, open }, pass, { title: 'self-themed mock browser check', mock: SELF_MOCK, name: 'self' });
    } catch (err) { selfFailed = err; }
    const own = SELF_SIDES[pass.theme];
    for (const [key, where] of [['stage', 'on an ordinary stage'], ['lens', 'in the Lens']]) {
      await row(`Self-themed (${pass.label}): a mock that paints a dark palette and declares color-scheme: dark under [data-theme="dark"], a light one otherwise, falling back to prefers-color-scheme, is told the ${pass.theme} theme ${where} and draws its ${pass.theme} side there, its body text, unstyled link and unstyled control text 4.5:1 or better against what is drawn behind them`, async note => {
        if (selfFailed) throw selfFailed;
        const m = self[key];
        assert.equal(m.scheme, pass.theme, `fixture: the board is not in the ${pass.theme} theme`);
        const wrong = [];
        const drew = `told ${m.told}; its own background ${m.empty.colours.join(', ')} over ${m.empty.px}px, its ${pass.theme} side being ${own}`;
        note(drew);
        if (m.told !== pass.theme || m.empty.colours.length !== 1 || m.empty.colours[0] !== own) wrong.push(drew);
        for (const probe of INK_PROBES) {
          const p = m.probes[probe.id];
          const line = `${probe.what}: ${p.ink} on ${p.behind}, ${p.ratio.toFixed(2)}:1`;
          note(line);
          // Text and a link sit straight on the mock's background; a control
          // draws its own fill behind its text.
          const onOwn = probe.id === 'ink-body' || probe.id === 'ink-link';
          if (!(p.ratio >= 4.5) || (onOwn && p.behind !== own)) wrong.push(line);
        }
        assert.deepEqual(wrong, []);
      });
    }
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
