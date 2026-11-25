// Real-browser end-to-end proof for stage-mermaid (the marker-gated srcdoc
// injection in src/render.mjs, the parent render service in src/ui.mjs, the
// isOpenRoute exception in src/server.mjs). Everything the DOM stand-in
// cannot see at all -- CSP inheritance, opaque-origin subresource rules, the
// `file:` local-resource rule, real network traffic -- lives here instead of
// in test/check-mermaid-stage.mjs. See QUIRKS.md "The DOM stand-in's
// ceilings" and "Driving the real page in real Chrome".
//
// NOT wired into test/run.mjs's `checks` array on purpose: that suite has to
// pass on a machine with no Chrome installed, and run.mjs's list is an
// explicit array rather than a directory glob, so a file merely living in
// test/ never joins it by accident. Run this one by hand:
//
//   node test/browser-check-mermaid-stage.mjs
//   CLAUDE_BOARD_BROWSER_CHECK_ARTIFACT=/path/to/real-report.html \
//     CLAUDE_BOARD_BROWSER_CHECK_FIGURE_SELECTOR='#ark-3054 pre.mermaid' \
//     node test/browser-check-mermaid-stage.mjs
//
// Five things asserted, against a real headless Chrome over the DevTools
// Protocol (test/browser-support.mjs's harness -- Node's native WebSocket, zero
// npm dependencies):
//
//   1. SERVED: the board's stage frame shows a rendered <svg>, not raw
//      mermaid source.
//   2. ARCHIVE: the page plus its siblings, copied out of the store's
//      pages/ to a plain temp dir and opened over file://, renders the same
//      figure via the parent-render facade (the served surface's sibling
//      <script> tag can never load over file: -- Chrome's local-resource
//      rule refuses a file: subresource to an opaque-origin frame,
//      CSP-independent; QUIRKS.md "What a srcdoc stage can actually load").
//   3. NO EXTERNAL HOST: proven at the Chrome PROCESS level, not by racing
//      DevTools Protocol session attachment against a brand-new frame's own
//      first byte (test/browser-support.mjs's `createWitnessProxy` says why
//      that race is real).
//   4. DEGRADE: the engine sibling missing, and separately corrupt, both
//      leave the raw diagram source on screen -- never a blank figure.
//   5. A full-document artifact (`<!doctype html><html>…`, the one shape
//      test/check-mermaid-stage.mjs's own DOM stand-in cannot parse as a
//      fragment at all) stays standards-mode inside the stage frame and the
//      prelude still runs.
//   6. TOUCH: a pulled-out diagram on a touch screen pinches around the
//      fingers' midpoint within the lens's zoom limits, pans under one finger,
//      keeps its zoom when a finger lifts mid-pinch, and zooms 2x on a
//      double-tap (CDP `Input.dispatchTouchEvent`; the stand-in has no touch).
//
// The committed fixture (test/fixtures/mermaid-stage-artifact.html) is a
// minimal full-document artifact carrying the /explain template's exact
// loader shape (2026-08-18-nightly.html lines 806-829: window.mermaid
// short-circuit, same-origin sibling first, the CDN URL as a second
// fallback only, dataset.src reset before every re-run) -- not a copy of a
// real report, so this stays small enough to commit.

import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { MERMAID_ASSET_NAME } from '../src/assets.mjs';
import { parseMermaidDomId, MERMAID_NODE_SELECTOR } from '../src/anchor.mjs';
import { check, repoRoot, runMain, sleep, withTimeout } from './support.mjs';
import {
  copyArchive, createWitnessProxy, evalIn, guardRun, isChromeInfra, openTab, postJson, requireChrome,
  setSessionCookie, startScratchDaemon, withChrome,
} from './browser-support.mjs';

// No whole-run deadline: this file never had one.
guardRun('browser-check-mermaid-stage');

const ARTIFACT_PATH = process.env.CLAUDE_BOARD_BROWSER_CHECK_ARTIFACT
  || path.join(repoRoot, 'test', 'fixtures', 'mermaid-stage-artifact.html');
const FIGURE_SELECTOR = process.env.CLAUDE_BOARD_BROWSER_CHECK_FIGURE_SELECTOR || 'pre.mermaid';

// ---------------------------------------------------------------------------
// Headless Chrome over CDP, routed through the witness proxy, scrollbars hidden.
/** Runs `fn({ send, onEvent })` against a brand-new, single-purpose Chrome
 * process, torn down afterward. Measured directly: REUSING one Chrome
 * process across several navigations (attach to page A, work with it, then
 * navigate a second target to page B in the SAME browser) made the archive
 * open behave noticeably worse back when the outcome still depended on a
 * startup race -- a DevTools client already attached to ANY target in a
 * browser process appears to change that process's own scheduling broadly,
 * not just for the specifically instrumented target. The race itself is gone
 * (the facade repeats its request until answered), so this is no longer
 * load-bearing for the archive result; it is kept because one process per
 * file:// page also keeps each phase's proxy witness cleanly separated. */
function withFreshChrome(proxyPort, fn) {
  return withChrome({ tag: 'cb-mermaid-browser', proxyPort, hideScrollbars: true }, fn);
}

// There was a `withRetries(attempts, fn)` helper here, wrapping the archive
// render wait in up to eight independent fresh-Chrome attempts. It is gone,
// with the defect it was papering over: the facade sent its render request
// once and never again, so whenever the stage's inline script beat the
// parent's DEFERRED client script to registering a `message` listener, the
// request was lost outright and that figure was stuck on raw source for the
// rest of the page's life. The measurements that helper's comment recorded
// (five headless recipes, split results on identical bytes) were real, and
// they were the symptom of that ordering, not of this harness: they are
// summarised at the archive check's own call site, which now runs exactly
// once. A retry loop over a race is a way of not noticing it.

/** Opens `url` in a fresh top-level target, waits for the load event, and
 * resolves the stage's own OOPIF session once Chrome attaches it (a
 * sandboxed opaque-origin srcdoc iframe is always its own Chrome target --
 * see test/browser-support.mjs's `createWitnessProxy`). Throws if no stage attaches within
 * the timeout, which is exactly the failure a board without an html-stage
 * (a wiring regression, not this check's fixture) should produce.
 *
 * `cookie`, when given, is set on the profile's cookie jar before navigating
 * (test/browser-support.mjs's `setSessionCookie` says why that is the
 * credential model and not a bypass). */
async function openBoardPage(send, onEvent, url, { cookie } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);

  let stageSessionId = null;
  const stageAttached = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
        stageSessionId = msg.params.sessionId;
        off();
        resolve(stageSessionId);
      }
    });
  });
  const loadFired = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { off(); resolve(); }
    });
  });

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  if (cookie) await setSessionCookie(s, cookie);
  await s('Page.navigate', { url });
  await withTimeout(loadFired, 20000, `page never fired load: ${url}`);

  const stageId = await withTimeout(stageAttached, 10000, `no html-stage iframe ever attached for ${url}`);
  await send('Runtime.enable', {}, stageId);
  return { pageSessionId: sessionId, stageSessionId: stageId, s };
}

/** Opens a `file://` archive with every CDP domain deliberately enabled as
 * late as possible, rather than `openBoardPage`'s recipe (Runtime/Page
 * enabled and auto-attach armed BEFORE Page.navigate). The difference is
 * historical, and worth keeping: `openBoardPage`'s recipe against a freshly
 * archived page lost the archive/facade startup race on EVERY trial (both
 * against this file's own fixture and the real 2026-08-18-nightly.html
 * reproducer) back when the facade posted its 'mermaid' request once and
 * never again, because the parent's `message` listener (registered by its
 * own DEFERRED `ui-*.js`, which by spec cannot run until the ENTIRE document
 * finishes parsing) had not registered yet and the request was simply never
 * answered. That is fixed at the source now -- the request repeats until it
 * is answered -- so this recipe is no longer what decides the outcome. It
 * stays because instrumenting as late as possible is the least invasive way
 * to read a sandboxed cross-origin frame's live DOM, which CDP is the only
 * channel for, and because a check that watches a page should disturb its
 * scheduling as little as it can. */
async function openArchivePage(send, onEvent, url, { settleMs = 6000 } = {}) {
  const { targetId } = await send('Target.createTarget', { url });
  await sleep(settleMs); // no CDP domain enabled yet, on purpose -- see header comment
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Runtime.enable');

  let stageSessionId = null;
  const stageAttached = new Promise(resolve => {
    const off = onEvent(msg => {
      if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
        stageSessionId = msg.params.sessionId;
        off();
        resolve(stageSessionId);
      }
    });
  });
  // Retroactive: the iframe target already exists by now, and enabling
  // auto-attach still attaches to every currently-matching target, not only
  // future ones -- confirmed directly, not assumed.
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const stageId = await withTimeout(stageAttached, 5000, `no html-stage iframe ever (retroactively) attached for ${url}`);
  await send('Runtime.enable', {}, stageId);
  return { pageSessionId: sessionId, stageSessionId: stageId, s };
}

async function waitForTruthy(send, sessionId, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evalIn(send, sessionId, expression);
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`condition never became true (${expression})`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Archive copies: the page plus every shared sibling it names, out of the
// scratch store's pages/ into a plain temp dir -- exactly the file set a
// reviewer would get by copying the folder Finder shows next to a
// double-clicked archive.
function copyMermaidArchive(pagesDir, boardId, { dropMermaid = false, corruptMermaid = false } = {}) {
  const { dest, pageUrl, pageBytes, siblings } = copyArchive(pagesDir, boardId, 'cb-mermaid-browser');
  const copiedSiblings = [];
  for (const name of siblings) {
    const isMermaid = MERMAID_ASSET_NAME.test(name);
    if (isMermaid && dropMermaid) { rmSync(path.join(dest, name)); continue; } // simulate a missing engine sibling
    copiedSiblings.push(name);
    if (isMermaid && corruptMermaid) {
      // Shape-invalid but syntactically valid: a real corrupt download can
      // truncate mid-token, but what both consumers (the stage's own
      // `shaped()` check and the parent's `looksLikeMermaidEngine`) actually
      // key on is API SHAPE, not parse success -- this is the deterministic
      // version of "the file arrived, but it's not the engine".
      writeFileSync(path.join(dest, name), 'window.mermaid = { corrupted: true };\n');
    }
  }
  return { dest, pageUrl, copiedSiblings, pageBytes };
}

// ---------------------------------------------------------------------------
// The pulled-out diagram under touch.
const TOUCH_DIAGRAM = `flowchart LR
  a["start"] --> b["read"] --> c["check"] --> d["write"]
  b --> e["fall back"] --> d`;

async function touchLensChecks(daemonPort, secret, proxyPort) {
  const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, {
    title: 'pulled-out diagram under touch',
    blocks: [{ kind: 'mermaid', text: TOUCH_DIAGRAM }],
  }, secret);
  const url = `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`;
  await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
    const tab = await openTab(send, onEvent, url, sessionToken(secret), {
      width: 390, height: 844, theme: 'dark', expr: '1',
      prepare: async sp => {
        await sp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await sp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      },
    });
    try {
      await tab.until(`document.querySelector('.mermaid-block .pull-out')`, 'the Pull-out');
      await tab.evalPage(`document.querySelector('.mermaid-block .pull-out').click()`);
      await tab.until(`document.querySelector('dialog[open] .lens-canvas svg')`, 'the open lens');

      const frame = () => tab.sp('Runtime.evaluate', {
        expression: 'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); })',
        awaitPromise: true,
      });
      const view = async () => {
        await frame();
        return tab.evalPage(`(function () {
          var st = document.querySelector('dialog[open] .lens-stage').getBoundingClientRect();
          var t = document.querySelector('dialog[open] .lens-canvas').style.transform.split(/[(), ]+/).map(parseFloat);
          return { left: st.left, top: st.top, cx: st.left + st.width / 2, cy: st.top + st.height / 2, x: t[1], y: t[2], s: t[4] };
        })()`);
      };
      const touch = (type, pts) => tab.sp('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })),
      });
      const fit = async () => {
        await tab.evalPage(`document.querySelector('dialog[open] .lens-btn[data-lens="fit"]').click()`);
        return view();
      };
      const pinch = async (cx, cy, from, to, steps = 10) => {
        await touch('touchStart', [[cx - from, cy, 0]]);
        await touch('touchStart', [[cx - from, cy, 0], [cx + from, cy, 1]]);
        for (let i = 1; i <= steps; i++) {
          const half = from + (to - from) * i / steps;
          await touch('touchMove', [[cx - half, cy, 0], [cx + half, cy, 1]]);
        }
        await touch('touchEnd', []);
      };
      const near = (got, want) => got.every((g, i) => Math.abs(g - want[i]) <= 0.01 + Math.abs(want[i]) * 1e-4);
      const screenOf = (v, d) => ({ x: v.left + v.x + v.s * d.x, y: v.top + v.y + v.s * d.y });
      const diagramAt = (v, x, y) => ({ x: (x - v.left - v.x) / v.s, y: (y - v.top - v.y) / v.s });

      await check('TOUCH: a two-finger pinch zooms the pulled-out diagram, the point under the fingers\' midpoint staying put', async () => {
        const before = await fit();
        const mid = { x: before.cx + 17, y: before.cy - 23 };
        const under = diagramAt(before, mid.x, mid.y);
        await pinch(mid.x, mid.y, 30, 90);
        const after = await view();
        assert.ok(Math.abs(after.s / before.s - 3) < 0.05, `fingers spread 3x, scale went ${before.s} -> ${after.s}`);
        const moved = screenOf(after, under);
        assert.ok(Math.hypot(moved.x - mid.x, moved.y - mid.y) < 3,
          `the diagram point under the midpoint drifted to ${JSON.stringify(moved)} from ${JSON.stringify(mid)}`);
      });

      await check('TOUCH: a pinch clamps at the lens\'s zoom limits, 8x and 0.1x', async () => {
        const start = await fit();
        for (let i = 0; i < 4; i++) await pinch(start.cx, start.cy, 30, 150);
        assert.ok(near([(await view()).s], [8]), 'pinched out past the ceiling');
        for (let i = 0; i < 6; i++) await pinch(start.cx, start.cy, 150, 30);
        assert.ok(near([(await view()).s], [0.1]), 'pinched in past the floor');
      });

      await check('TOUCH: one finger pans the pulled-out diagram without zooming it', async () => {
        const before = await fit();
        await touch('touchStart', [[before.cx, before.cy, 0]]);
        for (let i = 1; i <= 10; i++) await touch('touchMove', [[before.cx + 6 * i, before.cy + 3 * i, 0]]);
        await touch('touchEnd', []);
        const after = await view();
        assert.ok(near([after.x - before.x, after.y - before.y, after.s], [60, 30, before.s]), `one finger moved 60,30: ${JSON.stringify([before, after])}`);
      });

      await check('TOUCH: lifting one finger mid-pinch keeps the zoom and pans with the finger left', async () => {
        const before = await fit();
        const { cx, cy } = before;
        await touch('touchStart', [[cx - 40, cy, 0]]);
        await touch('touchStart', [[cx - 40, cy, 0], [cx + 40, cy, 1]]);
        for (let i = 1; i <= 8; i++) await touch('touchMove', [[cx - 40 - 5 * i, cy, 0], [cx + 40 + 5 * i, cy, 1]]);
        const pinched = await view();
        assert.ok(Math.abs(pinched.s / before.s - 2) < 0.05, `setup: the pinch doubled the scale, ${before.s} -> ${pinched.s}`);
        await touch('touchEnd', [[cx + 80, cy, 1]]);
        const lifted = await view();
        assert.ok(near([lifted.x, lifted.y, lifted.s], [pinched.x, pinched.y, pinched.s]), `the lift itself moved the view: ${JSON.stringify([pinched, lifted])}`);
        for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 80 + 5 * i, cy + 2 * i, 0]]);
        await touch('touchEnd', []);
        const after = await view();
        assert.ok(near([after.x - pinched.x, after.y - pinched.y, after.s], [50, 20, pinched.s]), `the finger left moved 50,20: ${JSON.stringify([pinched, after])}`);
      });

      await check('TOUCH: a double-tap zooms 2x around the tap, as a double-click does', async () => {
        const before = await fit();
        const at = { x: before.cx - 31, y: before.cy + 19 };
        const under = diagramAt(before, at.x, at.y);
        for (let i = 0; i < 2; i++) {
          await touch('touchStart', [[at.x, at.y, 0]]);
          await touch('touchEnd', []);
        }
        const after = await view();
        assert.ok(Math.abs(after.s / before.s - 2) < 1e-4, `a double-tap took the scale ${before.s} -> ${after.s}`);
        const moved = screenOf(after, under);
        assert.ok(Math.hypot(moved.x - at.x, moved.y - at.y) < 1, `the tapped point drifted to ${JSON.stringify(moved)}`);
      });
    } finally {
      await tab.close();
    }
  });
}

// ---------------------------------------------------------------------------
async function main() {
  requireChrome('browser-check-mermaid-stage');

  const artifactHtml = readFileSync(ARTIFACT_PATH, 'utf8');
  const diagramSourceHint = 'flowchart'; // present verbatim in every fixture/nightly diagram's raw text

  const witness = createWitnessProxy();
  const proxyPort = await witness.listen();
  const daemon = await startScratchDaemon('cb-mermaid-browser');

  let boardId;
  let daemonPort;
  let pagesDir;

  try {
    daemonPort = await daemon.port();
    pagesDir = path.join(daemon.home, 'pages');

    const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, {
      title: 'mermaid stage browser check',
      blocks: [{ kind: 'html', html: artifactHtml }],
    }, daemon.secret);
    boardId = posted.boardId;
    assert.ok(boardId, 'daemon did not return a boardId');

    // SERVED: one Chrome process, all three assertions against the same
    // opened tab. No cross-frame startup race here (the sibling <script>
    // loads inside the stage itself), so one shared process is fine.
    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      let servedStage = null;

      await check('SERVED: stage frame shows a rendered <svg>, not raw source', async () => {
        witness.setPhase('served');
        const boardUrl = `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`;
        servedStage = await openBoardPage(send, onEvent, boardUrl, { cookie: sessionToken(daemon.secret) });
        await waitForTruthy(
          send, servedStage.stageSessionId,
          `!!(document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}) && document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}).querySelector('svg'))`,
        );
        const nodeIds = await evalIn(
          send, servedStage.stageSessionId,
          `Array.from(document.querySelectorAll(${JSON.stringify(MERMAID_NODE_SELECTOR)})).map(function (e) { return e.id; })`,
        );
        assert.ok(Array.isArray(nodeIds) && nodeIds.length > 0, 'no real (prefixed) mermaid node ids found in the rendered SVG');
        const refs = nodeIds.map(parseMermaidDomId).filter(Boolean);
        assert.ok(refs.length > 0, `node ids present but none parsed back to a source ref: ${JSON.stringify(nodeIds)}`);
      });

      await check('SERVED: full-document artifact stays standards mode and the prelude ran', async () => {
        const compatMode = await evalIn(send, servedStage.stageSessionId, 'document.compatMode');
        assert.equal(compatMode, 'CSS1Compat', `expected standards mode, got ${compatMode}`);
        // window.mermaid exists with the shape the artifact's own loader checks
        // for (either the real engine's sibling <script> landed first, or the
        // facade installed) -- proof the prelude ran ahead of the artifact's own
        // end-of-body script, which is the whole point of prepending it.
        const shaped = await evalIn(
          send, servedStage.stageSessionId,
          `!!(window.mermaid && typeof window.mermaid.run === 'function' && typeof window.mermaid.initialize === 'function')`,
        );
        assert.ok(shaped, 'window.mermaid missing or wrong-shaped on the served surface');
      });

      await check('AC4 (served): the CDN fallback and the sibling assets/ fallback never fire', async () => {
        const badTags = await evalIn(
          send, servedStage.stageSessionId,
          `Array.from(document.querySelectorAll('script')).map(function (s) { return s.src || ''; })`
            + `.filter(function (src) { return src.indexOf('jsdelivr') !== -1 || src.indexOf('assets/mermaid.min.js') !== -1; })`,
        );
        assert.deepEqual(badTags, [], `loader appended a fallback <script>: ${JSON.stringify(badTags)}`);
      });
    });

    // ARCHIVE and both DEGRADE passes: each gets its OWN fresh Chrome
    // process -- see withFreshChrome's header comment for why that is load
    // bearing here and not merely tidy.
    const archive = copyMermaidArchive(pagesDir, boardId);
    await check('ARCHIVE: page + siblings copied to a plain temp dir render via the facade over file://', async () => {
      witness.setPhase('archive');
      const mermaidSiblings = archive.copiedSiblings.filter(n => MERMAID_ASSET_NAME.test(n));
      assert.equal(mermaidSiblings.length, 1, `expected exactly one mermaid-*.js sibling, got ${JSON.stringify(archive.copiedSiblings)}`);
      assert.ok(
        archive.pageBytes.includes(mermaidSiblings[0]),
        `the copied page's own bytes do not name its mermaid sibling (${mermaidSiblings[0]})`,
      );
      // ONE attempt, no retry -- and that is the assertion, not a detail of how
      // it is run. This wait used to be wrapped in up to eight independent
      // fresh-Chrome attempts, because the facade sent its render request once
      // and never again: the parent's `message` listener belongs to a DEFERRED
      // script that cannot run until the whole board page has parsed, the
      // stage's inline script runs as soon as its frame exists, nothing orders
      // the two, and whenever the stage won the request was lost and the figure
      // stayed on raw source forever. Measured intermittent here across five
      // headless recipes (fully CDP-instrumented, late-attach, uninstrumented
      // `--screenshot` with and without a virtual-time budget, and a
      // 15-real-second deferred attach) with no source change between runs.
      // The facade now repeats every request until it is answered and the parent
      // drops a duplicate already in flight (src/render.mjs's
      // stageMermaidPrelude, src/ui.mjs's handleStageMermaid), so the ordering
      // cannot decide the outcome any more. Retrying would hide exactly that
      // regression coming back; if this ever needs an attempt loop again, the
      // resend is broken and the loop is the wrong fix.
      await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
        const archiveStage = await openArchivePage(send, onEvent, archive.pageUrl);
        await waitForTruthy(
          send, archiveStage.stageSessionId,
          `!!(document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}) && document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}).querySelector('svg'))`,
          20000,
        );
      });
    });
    rmSync(archive.dest, { recursive: true, force: true });

    await check('AC4 (archive): no non-file: request left the machine, ever', async () => {
      // Covers everything observed so far (served + archive): the witness
      // proxy is a single long-lived process the check itself owns, so this
      // is cumulative across every Chrome process by construction.
      const offenders = witness.seen.filter(e => !isChromeInfra(e.hostname));
      assert.deepEqual(offenders, [], `witness proxy saw a non-loopback, non-Chrome-infra request: ${JSON.stringify(offenders, null, 2)}`);
      const jsdelivr = witness.seen.filter(e => /jsdelivr/i.test(e.hostname) || /jsdelivr/i.test(e.url || ''));
      assert.deepEqual(jsdelivr, [], `the CDN fallback actually reached the network: ${JSON.stringify(jsdelivr)}`);
    });

    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      await check('DEGRADE: engine sibling missing -> raw diagram source, never blank', async () => {
        witness.setPhase('degrade-missing');
        const missing = copyMermaidArchive(pagesDir, boardId, { dropMermaid: true });
        assert.ok(!missing.copiedSiblings.some(n => MERMAID_ASSET_NAME.test(n)), 'mermaid sibling was copied despite dropMermaid');
        const stage = await openArchivePage(send, onEvent, missing.pageUrl);
        // No positive condition to poll for here -- openArchivePage's own
        // settle window is the honest wait; nothing further to wait on.
        const svgCount = await evalIn(send, stage.stageSessionId, `document.querySelectorAll('svg').length`);
        const figureText = await evalIn(send, stage.stageSessionId, `(function () { var el = document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}); return el ? el.textContent : null; })()`);
        assert.equal(svgCount, 0, 'a diagram rendered despite the engine sibling being missing');
        assert.ok(typeof figureText === 'string' && figureText.includes(diagramSourceHint), `figure is not showing raw diagram source: ${JSON.stringify(figureText)}`);
        rmSync(missing.dest, { recursive: true, force: true });
      });
    });

    await withFreshChrome(proxyPort, async ({ send, onEvent }) => {
      await check('DEGRADE: engine sibling corrupt -> raw diagram source, never blank', async () => {
        witness.setPhase('degrade-corrupt');
        const corrupt = copyMermaidArchive(pagesDir, boardId, { corruptMermaid: true });
        const stage = await openArchivePage(send, onEvent, corrupt.pageUrl);
        const svgCount = await evalIn(send, stage.stageSessionId, `document.querySelectorAll('svg').length`);
        const figureText = await evalIn(send, stage.stageSessionId, `(function () { var el = document.querySelector(${JSON.stringify(FIGURE_SELECTOR)}); return el ? el.textContent : null; })()`);
        assert.equal(svgCount, 0, 'a diagram rendered despite a corrupt engine sibling');
        assert.ok(typeof figureText === 'string' && figureText.includes(diagramSourceHint), `figure is not showing raw diagram source: ${JSON.stringify(figureText)}`);
        rmSync(corrupt.dest, { recursive: true, force: true });
      });
    });

    await touchLensChecks(daemonPort, daemon.secret, proxyPort);

    await check('AC4 (final): still nothing non-loopback across the whole run, including both degrade passes', async () => {
      const offenders = witness.seen.filter(e => !isChromeInfra(e.hostname));
      assert.deepEqual(offenders, [], `witness proxy saw a non-loopback, non-Chrome-infra request: ${JSON.stringify(offenders, null, 2)}`);
    });
  } finally {
    await daemon.stop();
    await witness.close();
  }

  console.log(`\nartifact: ${ARTIFACT_PATH}`);
  console.log(`witness proxy observed ${witness.seen.length} request(s) total (loopback + Chrome infra included):`);
  for (const e of witness.seen) console.log(`  [${e.phase}] ${e.kind} ${e.hostname}:${e.port} ${e.url}`);
}

await runMain(null, main, { failText: n => `${n} assertion group(s) FAILED` });
console.log('\nall assertions ok');
