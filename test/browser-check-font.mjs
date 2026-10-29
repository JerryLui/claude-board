// Real-browser check that every surface renders in the Inter the stylesheet carries, with
// no request for it: the home page's two views and a board page served by the daemon,
// and a saved copy of that board opened over file:// with Chrome's network off. Font
// loading and text measurement are layout, which the DOM stand-in has none of (QUIRKS.md
// "The DOM stand-in's ceilings"); test/check-pure.mjs holds the stylesheet's side, that
// every url() in it is an inlined data: URL.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-font.mjs
//
// Without Chrome it prints a skip line and exits 0.
//
// Chrome's offline emulation refuses loopback too (a served page itself fails with
// ERR_INTERNET_DISCONNECTED), so the served rows cut the network at everything but the
// daemon's own origin instead: every other request is failed as disconnected and
// recorded. The saved copy needs no daemon, so it loads fully offline.
//
// `document.fonts.check('13px Inter')` answers true when no face named Inter exists at
// all, so it proves nothing here: the rows read the FontFace set itself and measure a
// text run against the fallback stack.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile } from './support.mjs';
import { CHROME, copyArchive, guardRun, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-font', `browser-check-font: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-font', { deadlineMs: 120000 });

const SAMPLE = 'The quick brown fox jumps over the lazy dog 0123456789';

// Read once the tab is quiet (its fonts are in): the faces the page loaded on its own,
// then a 13px run in body's own font, in Inter named alone, and in body's stack with
// Inter dropped. A run in a face the page never loaded would measure the fallback.
const MEASURE_EXPR = `(async function () {
  await document.fonts.ready;
  var faces = [];
  document.fonts.forEach(function (f) {
    faces.push({ family: f.family.replace(/["']/g, ''), weight: f.weight, status: f.status });
  });
  await document.fonts.load('400 13px Inter');
  var stack = getComputedStyle(document.body).fontFamily;
  var probe = document.createElement('span');
  probe.textContent = ${JSON.stringify(SAMPLE)};
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;font-size:13px;font-weight:400;font-style:normal;letter-spacing:normal';
  document.body.appendChild(probe);
  function width(family) { probe.style.fontFamily = family; return probe.getBoundingClientRect().width; }
  var asBody = width('');
  var asInter = width('Inter');
  var asFallback = width(stack.split(',').slice(1).join(','));
  probe.remove();
  return { faces: faces, stack: stack, asBody: asBody, asInter: asInter, asFallback: asFallback,
    scheme: getComputedStyle(document.documentElement).colorScheme };
})()`;

/** Every request a tab makes, and a cut at everything outside `allowedOrigin` (null:
 * nothing is let through, as with Chrome's own offline emulation, which the caller then
 * also turns on). Answers the recorded requests and the `prepare` hook openTab runs
 * before it navigates. */
function networkWitness(onEvent, allowedOrigin) {
  const seen = { requests: [], refused: [] };
  let off = () => {};
  const prepare = async (sp, sessionId) => {
    off = onEvent(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.requestWillBeSent') {
        seen.requests.push({ url: msg.params.request.url, type: msg.params.type || '' });
      } else if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        const allowed = request.url.startsWith('data:') || (allowedOrigin && new URL(request.url).origin === allowedOrigin);
        if (allowed) {
          sp('Fetch.continueRequest', { requestId }).catch(() => {});
        } else {
          seen.refused.push(request.url);
          sp('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }).catch(() => {});
        }
      }
    });
    await sp('Network.enable');
    if (allowedOrigin) {
      await sp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    } else {
      await sp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  };
  return { seen, prepare, stop: () => off() };
}

const short = url => (url.startsWith('data:') ? `${url.slice(0, 40)}...` : url);

async function main() {
  const daemon = await startScratchDaemon('cb-font');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const posted = await postJson(`${origin}/api/board`, {
      title: 'A round to read in Inter',
      blocks: [
        { kind: 'markdown', text: '## Context\n\nA paragraph of **ordinary** prose, set in the body font.' },
        { kind: 'question', prompt: 'Which one?', widget: 'single', options: [{ label: 'This one' }, { label: 'That one' }] },
      ],
    }, daemon.secret);
    assert.ok(posted.boardId && posted.url, `daemon did not return a board: ${JSON.stringify(posted)}`);
    const archive = copyArchive(path.join(daemon.home, 'pages'), posted.boardId, 'cb-font');
    const cookie = sessionToken(daemon.secret);

    // Each render in the one theme it is drawn in: Missions and Boards dark, the round page light.
    const surfaces = [
      { label: 'the home page, Missions (served, network cut but for the daemon)', url: `${origin}/`, theme: 'dark', allowedOrigin: origin },
      { label: 'the home page, Boards (served, network cut but for the daemon)', url: `${origin}/boards`, theme: 'dark', allowedOrigin: origin },
      { label: 'a board page (served, network cut but for the daemon)', url: `${origin}${new URL(posted.url).pathname}`, theme: 'light', allowedOrigin: origin },
      { label: 'a saved copy of that board (file://, network offline)', url: archive.pageUrl, theme: 'light', allowedOrigin: null },
    ];

    await withChrome({ tag: 'cb-font', hideScrollbars: true }, async ({ send, onEvent }) => {
      for (const surface of surfaces) {
        const witness = networkWitness(onEvent, surface.allowedOrigin);
        let m;
        try {
          const tab = await openTab(send, onEvent, surface.url, cookie, {
            width: 1280, height: 900, theme: surface.theme, expr: 'true', prepare: witness.prepare,
          });
          m = await tab.sp('Runtime.evaluate', { expression: MEASURE_EXPR, awaitPromise: true, returnByValue: true })
            .then(r => {
              if (r.exceptionDetails) throw new Error(`measure threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
              return r.result.value;
            });
          await tab.close();
        } finally {
          witness.stop();
        }
        const { requests, refused } = witness.seen;

        await row(`${surface.label}: holds a loaded Inter face, and asked the network for no font`, note => {
          const inter = m.faces.filter(f => f.family === 'Inter');
          note(`Inter faces: ${inter.map(f => `${f.weight} ${f.status}`).join(', ') || 'none'}`);
          note(`${requests.length} requests, ${refused.length} refused: ${refused.map(short).join(', ') || 'none'}`);
          assert.ok(inter.some(f => f.status === 'loaded'), 'a FontFace whose family is Inter has loaded');
          const fontFetches = requests.filter(r => r.type === 'Font' && !r.url.startsWith('data:'));
          assert.deepEqual(fontFetches.map(r => r.url), [], 'no font came over the network');
          assert.deepEqual(refused.map(short), [], 'nothing reached for a host the page cannot have offline');
        });

        await row(`${surface.label}: a 13px run in body's font measures Inter's width, not the fallback stack's`, note => {
          note(`body stack ${m.stack}; drawn ${m.scheme}`);
          note(`13px widths: body ${m.asBody.toFixed(2)}, Inter ${m.asInter.toFixed(2)}, fallback ${m.asFallback.toFixed(2)}`);
          assert.equal(m.stack.split(',')[0].replace(/["']/g, '').trim(), 'Inter', 'body\'s stack opens on Inter');
          assert.equal(m.asBody, m.asInter, 'body text measures as Inter does');
          assert.notEqual(m.asBody, m.asFallback, 'and not as the system stack behind it does');
        });
      }
    });
  } finally {
    await daemon.stop();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
