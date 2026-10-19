// Real-browser check for video in an html stage: the board's content policy
// admits media from `data:` and `blob:` only (src/render.mjs's CSP_CLAUSES), and a
// stage carrying `<video controls>` with an inlined source plays, pauses and
// scrubs on a live board and on its archived page opened from disk. The DOM
// stand-in the suite runs on decodes no video and enforces no policy (QUIRKS.md
// "The DOM stand-in's ceilings"), so the policy string's keepers live in
// test/check-pure.mjs and test/check-http.mjs and this file looks at what Chrome
// actually does with it.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass
// on a machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-video.mjs
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a
// scratch port and a scratch store, headless Chrome over the DevTools Protocol with
// Node's native WebSocket, zero npm dependencies, and its `createWitnessProxy` as
// the sink that records every request Chrome tries to send off the machine
// (QUIRKS.md "Two traps from driving the browser checks": CDP's own Network domain
// misses a new stage frame's first bytes).
//
// Three boards, each opened live and then as its archived page copied out of the
// store's pages/ with its siblings and opened over file://, six surfaces in all:
// an ordinary board (a markdown line plus one stage per source, so the stages sit
// in a column), a page board (one html block alone, carrying every source in
// its one stage; QUIRKS.md "A fixture board holding one html block and nothing
// else is a PAGE board"), and a page board whose one stage carries the mp4 padded
// to ~20 MB, a size an html stage may now reach (ADR 121). The sources: the
// committed mp4 (H.264) and webm (VP9) clips in test/fixtures/ as `data:` URIs, the
// mp4 again as a `blob:` URL the stage's own script builds, and two `<video>`
// elements whose src is an http and an https URL on a host that does not exist,
// which must load nothing.
//
// Playback is driven through the media element's own API from inside the stage's
// own Chrome target (each sandboxed srcdoc stage is one), with `userGesture` set on
// the evaluation so play() runs under user activation, as a click on the native
// controls would.
//
// A third board, opened live only (an archive has no comment mode), drives a video
// comment the way the reviewer makes one: a real CDP press on the native timeline of
// a paused video, aimed at the timeline Chrome itself draws in the video's
// user-agent shadow tree. A press on native controls never reaches the stage's
// document (QUIRKS.md "A press on a video's native controls never reaches the
// page"), so comment mode takes `controls` away, and these rows hold that it still
// does in this Chrome, and for controls the stage's own script adds while it is on.
//
// A last board, opened live only, holds a page carrying each stage once (src/render.mjs's
// boardForClient and holdStages): an awaited page board whose ~20 MB stage holds the
// mp4. Its rows read what the tab loads (the page's copy of the board and the tab's
// own catch-up read leave the stage out), then pause the clip, press Send, and measure
// the push the tab receives, recorded by name and length from the page's own
// EventSource, and whether the stage's frame and its paused second survive it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { check, repoRoot, runMain, sleep, withTimeout } from './support.mjs';
import {
  copyArchive, createWitnessProxy, evalIn, guardRun, isChromeInfra, postJson, requireChrome,
  row, setSessionCookie, startScratchDaemon, withChrome,
} from './browser-support.mjs';

const RUN_DEADLINE_MS = 240000;
guardRun('browser-check-video', { deadlineMs: RUN_DEADLINE_MS });

// ---------------------------------------------------------------------------
// The fixtures. Both clips are 3 s of ffmpeg's testsrc at 160x90, 15 fps, no audio:
//   ffmpeg -f lavfi -i testsrc=duration=3:size=160x90:rate=15 -c:v libx264 \
//     -pix_fmt yuv420p -profile:v baseline -crf 35 -movflags +faststart -an video-clip.mp4
//   ffmpeg -f lavfi -i testsrc=duration=3:size=160x90:rate=15 -c:v libvpx-vp9 \
//     -b:v 0 -crf 50 -an video-clip.webm
const CLIP_SECONDS = 3;
const MP4_B64 = readFileSync(path.join(repoRoot, 'test', 'fixtures', 'video-clip.mp4')).toString('base64');
const WEBM_B64 = readFileSync(path.join(repoRoot, 'test', 'fixtures', 'video-clip.webm')).toString('base64');
const MP4_URI = `data:video/mp4;base64,${MP4_B64}`;
const WEBM_URI = `data:video/webm;base64,${WEBM_B64}`;

// A host that resolves nowhere: the sink is the only place a request to it could
// ever be seen, and the control row at the end proves the sink does see one.
const NET_HOST = 'media.example.test';
const NET_SRCS = [`http://${NET_HOST}/clip.mp4`, `https://${NET_HOST}/clip.webm`];

// Records, from the stage's first parse, every policy violation and every media
// error in the stage's own document. A media element's `error` does not bubble, so
// the listener is on the capture phase.
const RECORDER = '<script>window.__cbEvents = [];'
  + "document.addEventListener('securitypolicyviolation', function (e) { window.__cbEvents.push({ kind: 'csp', directive: e.effectiveDirective, blocked: e.blockedURI }); });"
  + "document.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'VIDEO') window.__cbEvents.push({ kind: 'error', id: t.id, code: t.error && t.error.code }); }, true);"
  + '</script>';

const VIDEO = {
  mp4: `<video id="mp4" controls preload="auto" width="160" height="90" src="${MP4_URI}"></video>`,
  webm: `<video id="webm" controls preload="auto" width="160" height="90" src="${WEBM_URI}"></video>`,
  blob: '<video id="blob" controls preload="auto" width="160" height="90"></video>'
    + `<script>(function () { var s = atob(${JSON.stringify(MP4_B64)}), a = new Uint8Array(s.length);`
    + ' for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);'
    + " document.getElementById('blob').src = URL.createObjectURL(new Blob([a], { type: 'video/mp4' })); })();</script>",
  net: NET_SRCS.map((src, i) => `<video id="net${i}" controls preload="auto" width="160" height="90" src="${src}"></video>`).join(''),
};
const stageHtml = (name, kinds) => `<div data-mock="${name}">${RECORDER}${kinds.map(k => VIDEO[k]).join('')}</div>`;

/** `html` padded to `bytes` with an html comment after it, which loads nothing. */
const padStage = (html, bytes) => `${html}<!--${'A'.repeat(bytes - html.length - 7)}-->`;

const PLAYABLE = [
  { id: 'mp4', what: 'the mp4 data: source', uri: MP4_URI },
  { id: 'webm', what: 'the webm data: source', uri: WEBM_URI },
  { id: 'blob', what: 'the blob: source', uri: null },
];

const BOARDS = {
  ordinary: {
    body: {
      title: 'video browser check: ordinary board',
      blocks: [
        { kind: 'markdown', text: 'An ordinary board: this line keeps the stages below in a column.' },
        { kind: 'html', html: stageHtml('mp4', ['mp4']) },
        { kind: 'html', html: stageHtml('webm', ['webm']) },
        { kind: 'html', html: stageHtml('blob', ['blob']) },
        { kind: 'html', html: stageHtml('net', ['net']) },
      ],
    },
    // Which stage holds each video.
    stageOf: { mp4: 'mp4', webm: 'webm', blob: 'blob', net: 'net' },
  },
  page: {
    body: {
      title: 'video browser check: page board',
      blocks: [{ kind: 'html', html: stageHtml('page', ['mp4', 'webm', 'blob', 'net']) }],
    },
    stageOf: { mp4: 'page', webm: 'page', blob: 'page', net: 'page' },
    pageBoard: true,
  },
  // A stage far past the 512 KiB every other block keeps (ADR 121): the mp4 clip plus
  // inline padding to ~20 MB, the size of the evidence pages this cap was raised for,
  // and one html block alone, as those pages are.
  '~20 MB page': {
    body: {
      title: 'video browser check: ~20 MB stage',
      blocks: [{ kind: 'html', html: padStage(stageHtml('big', ['mp4']), 20_000_000) }],
    },
    stageOf: { mp4: 'big' },
    playable: [PLAYABLE[0]],
    pageBoard: true,
    stageBytes: 20_000_000,
  },
};

// The comment board: an ordinary board whose one stage holds a video large enough
// for Chrome to draw its full control bar (the timeline the press aims at), a video
// with no controls, and the stage's own script, which can wrap in a player carrying
// a `<video controls>` (and a bare one beside it) or put `controls` back on #clip,
// the way a player library does on loadedmetadata. The stage stands taller than
// the board's 320px placeholder, so its box only ever grows to fit: a shrink waits
// out a settle delay (src/ui.mjs's STAGE_SETTLE_MS) and would move the timeline
// under a press already aimed at it.
const COMMENT_STAGE = '<div data-mock="comment" style="min-height: 400px">'
  + `<video id="clip" aria-label="Criterion 2 clip" controls preload="auto" width="480" height="270" src="${MP4_URI}"></video>`
  + '<video id="bare" aria-label="Bare clip" width="160" height="90"></video>'
  + '<div id="player"></div>'
  + '<script>window.stageScript = {'
  + " addPlayer: function () { document.getElementById('player').insertAdjacentHTML('beforeend',"
  + " '<div class=\"wrap\"><video id=\"added\" controls width=\"160\" height=\"90\"></video><video id=\"added-bare\" width=\"160\" height=\"90\"></video></div>'); },"
  + " restoreControls: function () { document.getElementById('clip').controls = true; }"
  + '};</script></div>';
const COMMENT_BOARD = {
  title: 'video browser check: comment board',
  blocks: [
    { kind: 'markdown', text: 'An ordinary board, so a comment queues without waiting on the agent.' },
    { kind: 'html', html: COMMENT_STAGE },
  ],
};
// The paused second the press row comments on, and the label that second reads as.
const PAUSED_AT = 1.4;
const PAUSED_LABEL = 'Criterion 2 clip at 0:01';

// Installed in each stage's own target once it is found. Every method answers a
// plain object, so a CDP evaluation can hand it back by value.
const FRAME_DRIVER = `window.__cbV = {
  el: function (id) { var v = document.getElementById(id); if (!v) throw new Error('no video #' + id); return v; },
  state: function (id) {
    var v = this.el(id);
    return { t: v.currentTime, paused: v.paused, seeking: v.seeking, readyState: v.readyState, networkState: v.networkState,
      duration: v.duration, error: v.error ? v.error.code : null, src: v.getAttribute('src'), currentSrc: v.currentSrc };
  },
  ready: function (id) {
    var self = this, v = this.el(id);
    return new Promise(function (resolve) {
      function done() { resolve(self.state(id)); }
      if (v.readyState >= 1 || v.error) return done();
      v.addEventListener('loadedmetadata', done, { once: true });
      v.addEventListener('error', done, { once: true });
      setTimeout(done, 8000);
    });
  },
  play: function (id) {
    return this.el(id).play().then(function () { return { ok: true }; }, function (e) { return { ok: false, why: String(e) }; });
  },
  pause: function (id) { this.el(id).pause(); return this.state(id); },
  seek: function (id, to) {
    var self = this, v = this.el(id);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve({ seeked: false, state: self.state(id) }); }, 5000);
      v.addEventListener('seeked', function () { clearTimeout(timer); resolve({ seeked: true, state: self.state(id) }); }, { once: true });
      v.currentTime = to;
    });
  }
};`;

// Every evaluation here awaits a promise the expression may return (the driver's
// methods answer through one); `gesture` runs it under user activation.
const evalAwait = (send, sessionId, expression, { gesture = false } = {}) =>
  evalIn(send, sessionId, expression, { awaitPromise: true, gesture });

// ---------------------------------------------------------------------------
/** Opens `url` in a fresh target and finds each named stage's own Chrome target by
 * the `data-mock` its markup carries, installing the driver in each. `cookie` is
 * the live board's session cookie, derived from the scratch daemon's own secret
 * (test/browser-support.mjs's `setSessionCookie` says why that is the credential
 * model and not a bypass); an archive needs none. */
async function openSurface(send, onEvent, url, names, { cookie = null, preload = null } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const sp = (method, params) => send(method, params, sessionId);

  const frameSessions = [];
  const offAttach = onEvent(msg => {
    if (msg.method === 'Target.attachedToTarget' && msg.sessionId === sessionId && msg.params.targetInfo.type === 'iframe') {
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
  await sp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  if (cookie) await setSessionCookie(sp, cookie);
  // Runs in the board's own document before any of its scripts (sendRows' recorder).
  if (preload) await sp('Page.addScriptToEvaluateOnNewDocument', { source: preload });
  await sp('Page.navigate', { url });
  await withTimeout(loadFired, 20000, `page never fired load: ${url}`);

  const stages = new Map();
  const deadline = Date.now() + 20000;
  while (stages.size < names.length) {
    for (const sid of frameSessions) {
      if ([...stages.values()].includes(sid)) continue;
      let name = null;
      try {
        name = await evalAwait(send, sid, `(function () { var el = document.querySelector('[data-mock]'); return el ? el.getAttribute('data-mock') : null; })()`);
      } catch { /* not parsed yet, or gone */ }
      if (name && names.includes(name)) {
        await evalAwait(send, sid, FRAME_DRIVER);
        stages.set(name, sid);
      }
    }
    if (stages.size === names.length) break;
    if (Date.now() >= deadline) {
      throw new Error(`only ${stages.size} of ${names.length} stage targets found on ${url} (${[...stages.keys()].join(', ')})`);
    }
    await sleep(200);
  }
  offAttach();

  const evalPage = expr => evalAwait(send, sessionId, expr);
  /** Scrolls the board so the named stage sits mid-window: a stage below the fold
   * may be throttled (QUIRKS.md "A stage below the fold may send no height"). */
  const intoView = name => evalPage(`(function () {
    var f = Array.from(document.querySelectorAll('iframe.html-stage')).find(function (x) {
      return (x.getAttribute('srcdoc') || '').indexOf('data-mock="${name}"') !== -1;
    });
    if (!f) return false;
    document.documentElement.style.scrollBehavior = 'auto';
    f.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  const close = () => send('Target.closeTarget', { targetId });
  const pageBoard = await evalPage("document.body.classList.contains('page-board')");
  return { sessionId, stages, intoView, evalPage, close, pageBoard };
}

/** Polls `read()` until `ok(value)` holds and answers that value; past `timeoutMs`
 * it throws with the last value read. Not test/support.mjs's `waitFor`, which
 * polls for a truthy value and names no last value. */
async function waitUntil(read, ok, { timeoutMs = 8000, everyMs = 100, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${what} never happened (last ${JSON.stringify(value)})`);
    await sleep(everyMs);
  }
}

/** The rows for one opened surface: each playable source plays, pauses and scrubs;
 * the data: sources arrive byte for byte; the http(s) sources, on a board that has
 * them, load nothing. */
async function surfaceRows({ send, sink, label, surface, stageOf, playable = PLAYABLE, stageBytes = 0 }) {
  const drive = (videoId, call, opts) => evalAwait(send, surface.stages.get(stageOf[videoId]), `window.__cbV.${call}`, opts);

  for (const v of playable) {
    await check(`${label}: ${v.what} plays (currentTime advances), pauses (stays put) and scrubs (a seek lands)`, async () => {
      assert.ok(await surface.intoView(stageOf[v.id]), `${label}: no stage frame named ${stageOf[v.id]}`);
      const ready = await drive(v.id, `ready(${JSON.stringify(v.id)})`);
      assert.equal(ready.error, null, `${v.what} failed to load (MediaError code ${ready.error}); a policy that names no media source refuses it`);
      assert.ok(ready.readyState >= 1, `${v.what} never reached its metadata: ${JSON.stringify(ready)}`);
      assert.ok(Math.abs(ready.duration - CLIP_SECONDS) < 0.2, `${v.what} reads a duration of ${ready.duration}s, the clip is ${CLIP_SECONDS}s`);

      const played = await drive(v.id, `play(${JSON.stringify(v.id)})`, { gesture: true });
      assert.ok(played.ok, `${v.what}: play() refused: ${played.why}`);
      const moving = await waitUntil(() => drive(v.id, `state(${JSON.stringify(v.id)})`), s => s.t >= 0.5,
        { what: `${v.what}'s currentTime passing 0.5s` });
      assert.equal(moving.paused, false);

      const held = await drive(v.id, `pause(${JSON.stringify(v.id)})`);
      assert.equal(held.paused, true, `${v.what} did not pause`);
      await sleep(700);
      const later = await drive(v.id, `state(${JSON.stringify(v.id)})`);
      assert.equal(later.t, held.t, `${v.what} kept moving after pause: ${held.t}s then ${later.t}s`);

      const target = held.t < 1.5 ? 2.2 : 0.8;
      const seek = await drive(v.id, `seek(${JSON.stringify(v.id)}, ${target})`);
      assert.ok(seek.seeked, `${v.what}: a seek to ${target}s never fired seeked: ${JSON.stringify(seek.state)}`);
      assert.ok(Math.abs(seek.state.t - target) < 0.05, `${v.what}: a seek to ${target}s landed at ${seek.state.t}s`);
      assert.equal(seek.state.paused, true, 'a scrub while paused leaves it paused');
    });
  }

  await check(`${label}: the rendered stage carries each posted data: URI byte for byte${playable.some(v => !v.uri) ? ', and the blob: source plays from a blob: URL' : ''}${stageBytes ? `, in a stage of ${stageBytes.toLocaleString('en-US')} bytes` : ''}`, async () => {
    for (const v of playable) {
      const s = await drive(v.id, `state(${JSON.stringify(v.id)})`);
      if (v.uri) {
        assert.ok(s.src === v.uri, `${v.what}: the stage's src is ${s.src.length} chars against the posted ${v.uri.length}, or differs in its bytes`);
        assert.ok(s.currentSrc === v.uri, `${v.what}: the element plays something other than the posted URI`);
      } else {
        assert.match(s.currentSrc, /^blob:/, `${v.what}: currentSrc is ${s.currentSrc}`);
      }
    }
    if (stageBytes) {
      // The padding arrived too: the stage's own document is the whole posted stage.
      const held = await evalAwait(send, surface.stages.get(stageOf.mp4), 'document.documentElement.outerHTML.length');
      assert.ok(held >= stageBytes, `the stage's document holds ${held} chars, the posted stage ${stageBytes}`);
    }
  });

  if (!stageOf.net) return;
  await check(`${label}: a stage <video> with an http or https src loads nothing (a media-src violation, a media error, and no request at the sink)`, async () => {
    sink.setPhase(label);
    assert.ok(await surface.intoView(stageOf.net), `${label}: no stage frame named ${stageOf.net}`);
    const sid = surface.stages.get(stageOf.net);
    for (const [i, src] of NET_SRCS.entries()) {
      const s = await waitUntil(() => drive('net', `state('net${i}')`), x => x.error !== null || x.networkState === 3,
        { what: `${src} giving up` });
      assert.equal(s.readyState, 0, `${src} loaded data: ${JSON.stringify(s)}`);
    }
    const events = await evalAwait(send, sid, 'window.__cbEvents');
    for (const src of NET_SRCS) {
      assert.ok(events.some(e => e.kind === 'csp' && e.directive === 'media-src' && String(e.blocked).startsWith(src.split('/clip')[0])),
        `no media-src violation for ${src}: ${JSON.stringify(events)}`);
    }
    for (const i of NET_SRCS.keys()) {
      assert.ok(events.some(e => e.kind === 'error' && e.id === `net${i}`), `no error event on #net${i}: ${JSON.stringify(events)}`);
    }
    const reached = sink.seen.filter(e => e.hostname === NET_HOST);
    assert.deepEqual(reached, [], `a request for ${NET_HOST} reached the sink`);
  });
}

// ---------------------------------------------------------------------------
/** The point `fraction` of the way along the native timeline Chrome draws for the
 * stage video `videoId`, in the stage's own coordinates. The timeline lives in the
 * video's user-agent shadow tree, which no page script can read; DOM.getDocument
 * with `pierce` reaches it from the stage's own target. */
async function timelineSpot(send, sid, videoId, fraction) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, sid);
  const attr = (n, name) => {
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
    return null;
  };
  const find = (n, ok) => {
    if (ok(n)) return n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) {
      const hit = find(c, ok);
      if (hit) return hit;
    }
    return null;
  };
  const video = find(root, n => n.nodeName === 'VIDEO' && attr(n, 'id') === videoId);
  assert.ok(video, `no #${videoId} in the stage's DOM`);
  const timeline = find(video, n => attr(n, 'pseudo') === '-webkit-media-controls-timeline');
  assert.ok(timeline, `#${videoId} carries no native timeline: Chrome drew no controls for it`);
  const { model } = await send('DOM.getBoxModel', { nodeId: timeline.nodeId }, sid);
  const [x0, y0, x1, , , y2] = model.content;
  return { x: x0 + (x1 - x0) * fraction, y: (y0 + y2) / 2 };
}

/** The board-viewport point where the stage `mockName`'s own coordinates start,
 * read once the board has stopped moving it: the stage holds its 320px placeholder
 * until its height report lands, and the board reflows (and may scroll) when it does. */
async function stageOrigin(surface, mockName) {
  const read = () => surface.evalPage(`(function () {
    var f = Array.from(document.querySelectorAll('iframe.html-stage')).find(function (x) {
      return (x.getAttribute('srcdoc') || '').indexOf('data-mock="${mockName}"') !== -1;
    });
    var r = f.getBoundingClientRect();
    return { x: r.left + f.clientLeft, y: r.top + f.clientTop, h: r.height, scroll: scrollY, fitted: f.style.height !== '' };
  })()`);
  let last = JSON.stringify(await read());
  let same = 0;
  const settled = await waitUntil(async () => {
    const now = await read();
    same = JSON.stringify(now) === last ? same + 1 : 0;
    last = JSON.stringify(now);
    return now;
  }, now => now.fitted && same >= 3, { everyMs: 150, what: `the ${mockName} stage fitted and holding still in the board` });
  return { x: settled.x, y: settled.y };
}

/** One press of the left button at the stage `mockName`'s own point `spot`,
 * preceded by the move a hand makes to get there, sent to the board's own target as
 * a real input event at that point's place in the board. */
async function press(send, surface, mockName, spot) {
  const origin = await stageOrigin(surface, mockName);
  const at = { x: origin.x + spot.x, y: origin.y + spot.y };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, surface.sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 }, surface.sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 }, surface.sessionId);
  return at;
}

/** The rows for the comment board: a press on a paused video's timeline in comment
 * mode comments on its second instead of seeking, and controls the stage's own
 * script gives a video while comment mode is on are taken too. */
async function commentRows({ send, surface, chrome }) {
  const sid = surface.stages.get('comment');
  const inStage = expr => evalAwait(send, sid, expr);
  const drive = call => inStage(`window.__cbV.${call}`);
  const controlsOn = ids => inStage(`(function () { var o = {}; ${JSON.stringify(ids)}.forEach(function (id) {
    o[id] = document.getElementById(id).hasAttribute('controls'); }); return o; })()`);
  // Every 'mode' message the stage hears, recorded after the stage's own listener
  // (registered at parse, so it runs first) has acted on it.
  await inStage(`window.__cbModes = []; window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'mode') window.__cbModes.push(!!e.data.commentMode); });`);
  /** Presses the board's Comment toggle until it reads `on`, and waits for the
   * stage to hear it. */
  const commentMode = async on => {
    const heard = await inStage('window.__cbModes.length');
    const pressed = await surface.evalPage(`(function () {
      var b = document.querySelector('button#comment-mode-toggle');
      if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) { b.click(); return true; }
      return false;
    })()`);
    if (!pressed) return;
    await waitUntil(() => inStage('window.__cbModes'), m => m.length > heard && m[m.length - 1] === on,
      { what: `the stage hearing comment mode ${on ? 'on' : 'off'}` });
  };
  const openForm = () => surface.evalPage(`(function () {
    var f = document.querySelector('form.comment-form.open');
    if (!f) return null;
    var t = document.querySelector('div#comment-target-' + f.getAttribute('data-block-id'));
    return { label: f.getAttribute('data-anchor-label'), time: f.getAttribute('data-anchor-time'), target: t && t.textContent };
  })()`);

  await row(`live comment board: with comment mode on, a CDP press on a paused video's timeline leaves currentTime where it was paused and opens the comment form at that second (with it off, the same press seeks)`, async note => {
    note(chrome);
    assert.ok(await surface.intoView('comment'), 'setup failure: no stage frame named comment');
    const ready = await drive("ready('clip')");
    assert.ok(ready.readyState >= 1 && ready.error === null, `setup failure: #clip never loaded: ${JSON.stringify(ready)}`);
    const paused = await drive(`seek('clip', ${PAUSED_AT})`);
    assert.ok(paused.seeked && paused.state.paused, `setup failure: #clip did not pause at ${PAUSED_AT}s: ${JSON.stringify(paused)}`);
    const spot = await timelineSpot(send, sid, 'clip', 0.8);

    // The control: the spot is on the timeline, so with comment mode off the press seeks.
    const at = await press(send, surface, 'comment', spot);
    const sought = await waitUntil(() => drive("state('clip')"), s => Math.abs(s.t - PAUSED_AT) > 0.5,
      { what: `a press at (${at.x}, ${at.y}) with comment mode off seeking #clip off ${PAUSED_AT}s` });
    note(`comment mode off: the press at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}) moved currentTime ${PAUSED_AT} -> ${sought.t}`);
    const back = await drive(`seek('clip', ${PAUSED_AT})`);
    assert.ok(back.seeked && Math.abs(back.state.t - PAUSED_AT) < 0.05, `setup failure: #clip did not return to ${PAUSED_AT}s: ${JSON.stringify(back)}`);

    await commentMode(true);
    const before = (await drive("state('clip')")).t;
    await press(send, surface, 'comment', spot);
    // A press that seeks opens no form, so a form that never opens reads as null and
    // the second's assertion below says what the press did instead.
    const form = await waitUntil(openForm, f => f !== null, { timeoutMs: 3000, what: 'the comment form opening' }).catch(() => null);
    await sleep(300);
    const after = await drive("state('clip')");
    note(`comment mode on: the form reads ${JSON.stringify(form)}; currentTime ${before} before the press, ${after.t} after`);
    assert.equal(after.t, before, 'a comment-mode press on the timeline must not move the video off the second it was paused at');
    assert.equal(after.paused, true, 'a comment-mode press on the timeline must not play the video');
    assert.deepEqual(form, { label: PAUSED_LABEL, time: '1', target: `commenting on: ${PAUSED_LABEL}` },
      'the form must open on the video at the second it was paused at');
    await commentMode(false);
  });

  await row(`live comment board: a <video controls> the stage's own script adds, and controls it puts back on a video, while comment mode is on lose them; comment mode ending gives controls back to exactly the videos that had them`, async () => {
    await commentMode(true);
    assert.deepEqual(await controlsOn(['clip', 'bare']), { clip: false, bare: false },
      'setup failure: comment mode on must have taken #clip\'s controls');
    await inStage('window.stageScript.addPlayer(); window.stageScript.restoreControls();');
    assert.deepEqual(await controlsOn(['clip', 'added', 'added-bare', 'bare']), { clip: false, added: false, 'added-bare': false, bare: false },
      'a video the stage\'s script gives controls while comment mode is on must lose them before a press can land, or the press seeks');
    await commentMode(false);
    assert.deepEqual(await controlsOn(['clip', 'added', 'added-bare', 'bare']), { clip: true, added: true, 'added-bare': false, bare: false },
      'comment mode ending must give controls back to each video that had them, and to none that had none');
  });
}

// ---------------------------------------------------------------------------
// The Send board: a page board the agent waits on (an evidence page's shape), whose
// one stage carries the mp4 padded to ~20 MB. A page carries each stage once
// (src/render.mjs's boardForClient and holdStages): its own copy of the board leaves
// the stage out, and the push a Send brings back sends the stage held, so the tab
// keeps the frame it has.
const SEND_BOARD = {
  title: 'video browser check: Send beside a ~20 MB stage',
  wait: true,
  blocks: [{ kind: 'html', html: padStage(stageHtml('send', ['mp4']), 20_000_000) }],
};
// Installed before the board's own scripts: every SSE event the page's EventSource
// hands a listener, by name and by the length of its data.
const PUSH_RECORDER = `(function () {
  window.__cbPushes = [];
  var ES = window.EventSource;
  if (!ES) return;
  var add = ES.prototype.addEventListener;
  ES.prototype.addEventListener = function (type, fn, opts) {
    return add.call(this, type, function (ev) {
      window.__cbPushes.push({ type: type, bytes: typeof ev.data === 'string' ? ev.data.length : 0 });
      return fn.apply(this, arguments);
    }, opts);
  };
})();`;

/** The Send board's rows: the page loads once, and a reviewer who pauses the clip
 * and presses Send has the round the daemon pushes back turn sent around a stage
 * frame that never reloads. */
async function sendRows({ send, surface, boardId }) {
  const drive = call => evalAwait(send, surface.stages.get('send'), `window.__cbV.${call}`);

  await row('live ~20 MB Send board: the page loads once -- its #board-data carries no stage, and the tab\'s own catch-up read of the board, made as its event stream connects, is under 1 MB', async note => {
    const loaded = await waitUntil(() => surface.evalPage(`(function () {
      var data = document.querySelector('script#board-data[type="application/json"]');
      var reads = performance.getEntriesByType('resource').filter(function (e) {
        return e.initiatorType === 'fetch' && e.name.indexOf('/b/${boardId}') !== -1;
      }).map(function (e) { return e.encodedBodySize; });
      return { boardData: data.textContent.length, page: document.documentElement.outerHTML.length, reads: reads };
    })()`), s => s.reads.length > 0, { what: 'the tab\'s catch-up read of the board' });
    note(`page as parsed: ${loaded.page.toLocaleString('en-US')} chars, #board-data ${loaded.boardData.toLocaleString('en-US')} chars, the catch-up read ${loaded.reads.map(n => n.toLocaleString('en-US')).join(', ')} bytes`);
    assert.ok(loaded.boardData < 1_000_000, `#board-data holds ${loaded.boardData} chars: the page's copy of the board carries no stage`);
    assert.ok(loaded.reads.every(n => n < 1_000_000), `the catch-up read ${loaded.reads.join(', ')} bytes: a tab that holds its stages reads none of them again`);
  });

  await row('live ~20 MB Send board: the push the tab receives after a Send is under 1 MB, and the stage\'s frame is the same element afterwards, its video still paused at the second it was paused at', async note => {
    assert.ok(await surface.intoView('send'), 'setup failure: no stage frame named send');
    const ready = await drive("ready('mp4')");
    assert.ok(ready.readyState >= 1 && ready.error === null, `setup failure: the clip never loaded: ${JSON.stringify(ready)}`);
    const paused = await drive(`seek('mp4', ${PAUSED_AT})`);
    assert.ok(paused.seeked && paused.state.paused, `setup failure: the clip did not pause at ${PAUSED_AT}s: ${JSON.stringify(paused)}`);
    const frames = await surface.evalPage(`(function () {
      window.__cbFrame = document.querySelector('iframe.html-stage');
      return document.querySelectorAll('iframe.html-stage').length;
    })()`);
    assert.equal(frames, 1, 'setup failure: the board must hold its one stage');

    const pressed = await surface.evalPage("(function () { var b = document.querySelector('.page-send-btn'); if (!b || b.disabled) return false; b.click(); return true; })()");
    assert.ok(pressed, 'setup failure: the page board offers no live Send control');
    const push = await waitUntil(() => surface.evalPage("window.__cbPushes.filter(function (p) { return p.type === 'submitted'; })"),
      pushes => pushes.length > 0, { timeoutMs: 30000, what: 'the Send\'s push reaching the tab' });
    note(`the Send's push: ${push[0].bytes.toLocaleString('en-US')} chars`);
    const after = await waitUntil(() => surface.evalPage(`(function () {
      var round = document.querySelector('.round[data-round="1"]');
      var frame = document.querySelector('iframe.html-stage');
      return { sent: !!round && round.classList.contains('round-history'), same: frame === window.__cbFrame,
        frames: document.querySelectorAll('iframe.html-stage').length };
    })()`), s => s.sent, { what: 'round 1 turning sent' });
    assert.ok(push[0].bytes < 1_000_000, `the Send's push carried ${push[0].bytes} chars: a Send re-sends no stage`);
    assert.equal(after.frames, 1, 'the sent round holds its one stage');
    assert.ok(after.same, 'the stage\'s frame must be the element it was before the Send: a frame replaced, or taken out and put back, reloads its mock');
    let state;
    try {
      state = await drive("state('mp4')");
    } catch (err) {
      assert.fail(`the stage's document is gone after the Send (${err.message}): its frame reloaded`);
    }
    note(`the clip after the Send: ${state.t}s, paused ${state.paused}`);
    assert.equal(state.paused, true, 'the clip must still be paused');
    assert.ok(Math.abs(state.t - paused.state.t) < 0.01, `the clip must still be at ${paused.state.t}s, the second it was paused at; it reads ${state.t}s`);
  });
}

// ---------------------------------------------------------------------------
async function main() {
  requireChrome('browser-check-video');

  const sink = createWitnessProxy();
  const proxyPort = await sink.listen();
  const daemon = await startScratchDaemon('cb-video');
  try {
    const daemonPort = await daemon.port();
    const pagesDir = path.join(daemon.home, 'pages');
    await withChrome({ tag: 'cb-video', proxyPort, hideScrollbars: true }, async ({ send, onEvent }) => {
      const cookie = sessionToken(daemon.secret);

      for (const [kind, board] of Object.entries(BOARDS)) {
        const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, board.body, daemon.secret);
        assert.ok(posted.boardId && posted.url, `daemon did not return a board: ${JSON.stringify(posted)}`);
        const names = [...new Set(Object.values(board.stageOf))];
        const opens = [
          { label: `live ${kind} board`, url: `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`, cookie },
          { label: `archived ${kind} board over file://`, url: copyArchive(pagesDir, posted.boardId, 'cb-video').pageUrl, cookie: null },
        ];
        for (const open of opens) {
          sink.setPhase(open.label);
          const surface = await openSurface(send, onEvent, open.url, names, { cookie: open.cookie });
          try {
            // The layout follows the board's shape, not its title (QUIRKS.md "A fixture
            // board holding one html block and nothing else is a PAGE board").
            assert.equal(surface.pageBoard, !!board.pageBoard, `${open.label} rendered in the wrong layout`);
            await surfaceRows({ send, sink, label: open.label, surface, stageOf: board.stageOf, playable: board.playable, stageBytes: board.stageBytes });
          } finally {
            await surface.close();
          }
        }
      }

      {
        const { product } = await send('Browser.getVersion');
        const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, COMMENT_BOARD, daemon.secret);
        assert.ok(posted.boardId && posted.url, `daemon did not return a board: ${JSON.stringify(posted)}`);
        sink.setPhase('live comment board');
        const surface = await openSurface(send, onEvent, `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`, ['comment'], { cookie });
        try {
          await commentRows({ send, surface, chrome: product });
        } finally {
          await surface.close();
        }
      }

      {
        const posted = await postJson(`http://127.0.0.1:${daemonPort}/api/board`, SEND_BOARD, daemon.secret);
        assert.ok(posted.boardId && posted.url, `daemon did not return a board: ${JSON.stringify(posted)}`);
        sink.setPhase('live ~20 MB Send board');
        const surface = await openSurface(send, onEvent, `http://127.0.0.1:${daemonPort}${new URL(posted.url).pathname}`, ['send'],
          { cookie, preload: PUSH_RECORDER });
        try {
          await sendRows({ send, surface, boardId: posted.boardId });
        } finally {
          await surface.close();
        }
      }

      await check('no request left the machine for any host but Chrome\'s own, across every surface', async () => {
        const offenders = sink.seen.filter(e => !isChromeInfra(e.hostname) && e.hostname !== '127.0.0.1' && e.hostname !== 'localhost');
        assert.deepEqual(offenders, [], `the sink saw: ${JSON.stringify(offenders, null, 2)}`);
      });

      // The sink is only a witness if a request to that host would reach it. A
      // top-level navigation carries no board policy, so this one must.
      await check(`control: a top-level navigation to ${NET_HOST} does reach the sink`, async () => {
        sink.setPhase('control');
        const { targetId } = await send('Target.createTarget', { url: `http://${NET_HOST}/control` });
        try {
          await waitUntil(async () => sink.seen.filter(e => e.phase === 'control' && e.hostname === NET_HOST).length, n => n > 0,
            { what: `the control request reaching the sink` });
        } finally {
          await send('Target.closeTarget', { targetId });
        }
      });
    });
  } finally {
    await daemon.stop();
    await sink.close();
  }
}

await runMain(null, main, { failText: n => `${n} row(s) FAILED` });
console.log('\nall rows ok');
