// The board provides its vendored mermaid engine to html stages that carry a
// mermaid marker, so a posted /explain or /visualize artifact shows a rendered
// diagram instead of raw source.
//
// Delivery is hybrid, and this file's job is everything about it a machine
// without a browser can actually see:
//
//   1. MARKUP SHAPE. A stage whose own bytes carry the mermaid class marker gets
//      the engine's bare sibling filename plus the facade prelude prepended to
//      its srcdoc, before any of its own content. A stage without the marker
//      gets a srcdoc byte-identical to the one it always got -- asserted against
//      the real composition (margin reset + html + agent script), not against a
//      hand-copied guess at it.
//   2. THE FACADE AND ITS PROTOCOL, END TO END. The DOM stand-in skips a
//      `<script src>` (it fetches nothing), which is exactly what the `file://`
//      archive surface does to that tag -- so driving a stage here drives the
//      archive path for real: the facade installs, an artifact-shaped loader
//      calls `initialize`/`run` on it, the request crosses the stage channel,
//      src/ui.mjs's render service draws it against a stub engine, and the SVG
//      comes back and lands in the figure.
//   3. THE TRUST BOUNDARY. Stage messages are hostile input. Malformed payloads,
//      over-cap batches and over-long sources are refused or nulled rather than
//      acted on; a reply reaches only the frame that asked; `securityLevel` is
//      never forwarded to the engine whatever the stage sends; and a stage's
//      config cannot bleed into the next board-level render.
//   4. HONEST DEGRADATION. An engine that cannot load leaves every figure
//      showing its raw source -- never a blank one -- and releases the node so a
//      later pass may still try.
//
// What is NOT here, deliberately: CSP inheritance, opaque-origin subresource
// rules and the `file:` local-resource rule are browser facts the stand-in
// cannot see at all (QUIRKS.md "The DOM stand-in's ceilings"). Those belong to
// the real-browser check.
//
// One more ceiling, measured while writing this file, because it decides the
// shape of every stage below. Every stage here is a FRAGMENT. The stand-in's
// `parseHTML` takes a full-document branch when the srcdoc's own bytes carry
// `<!doctype html><html>…` -- which is exactly what a real /explain artifact is
// -- and everything prepended ahead of that doctype is dropped, so the facade
// never installs and nothing here would be exercised at all. A real browser does
// not do that: measured in Chrome against this exact composition (a leading
// `<style>` + two `<script>`s, then a full-document artifact, inside a
// `sandbox="allow-scripts"` srcdoc under the page's own CSP), the prelude runs,
// the artifact's own end-of-body script sees `window.mermaid` already installed,
// and the document is still standards mode (`CSS1Compat`). The real-browser
// check is where that has to be pinned, against a real artifact rather than a
// fragment; nothing in this file can express it.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import {
  renderBoardPage, buildStageSrcdoc, stageCarriesMermaid, stageMermaidPrelude,
  stageAgentScript, STAGE_MARGIN_RESET,
} from '../src/render.mjs';
import { MERMAID_ASSET } from '../src/assets.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML } from './dom-stand-in.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** Lets an assertion run after the parent's own async chain (queueMermaidTask ->
 * the engine's awaits -> the reply post) has actually settled, rather than just
 * been kicked off. Same device as test/check-mermaid-theme.mjs's. */
function flush(ticks = 40) {
  return new Promise(resolve => {
    let n = 0;
    (function tick() {
      n++;
      if (n > ticks) { resolve(); return; }
      setTimeout(tick, 0);
    })();
  });
}

const DIAGRAM = 'flowchart LR\n  A[Start] --> B[End]';

/** An artifact-shaped stage: a `pre.mermaid` figure and an end-of-body loader
 * that behaves the way the /explain template's own `renderMermaidAll` does --
 * short-circuit on `window.mermaid` being present, then `initialize` with its
 * own palette followed by `run({ nodes, suppressErrors })`. The `securityLevel`
 * it asks for is the hostile half: no stage may ever set that. */
function artifactStage(source = DIAGRAM) {
  return `<div class="doc"><pre class="mermaid">${source}</pre></div>
<script>
  window.__loader = { sawEngine: false, fellBack: false };
  if (!window.mermaid) { window.__loader.fellBack = true; }
  else {
    window.__loader.sawEngine = true;
    window.mermaid.initialize({
      startOnLoad: false, theme: 'base', securityLevel: 'loose',
      themeVariables: { primaryColor: '#123456' }
    });
    window.mermaid.run({ nodes: document.querySelectorAll('pre.mermaid'), suppressErrors: true });
  }
</script>`;
}

/** A shape-valid stand-in for the vendored engine, on the PARENT window. Records
 * every `initialize` config it is handed and answers `render` with a marked SVG
 * so a check can tell a real answer from a coincidence. `fail` makes one render
 * throw the way an unparseable diagram does. */
function stubEngine({ fail = false } = {}) {
  const initCalls = [];
  const rendered = [];
  return {
    initCalls,
    rendered,
    initialize(config) { initCalls.push(config); },
    async run() { /* the board's own blocks never run in this file */ },
    async render(id, text) {
      rendered.push({ id, text });
      if (fail) throw new Error('parse error');
      return { svg: `<svg data-src="${text.split('\n')[0]}"><g id="${id}"></g></svg>` };
    },
  };
}

/** Render a board carrying `stages` html blocks, run the real client script over
 * it, and hand back the live document plus its frames. Nothing is loaded into a
 * frame here: `loadSrcdoc` models the srcdoc navigation finishing, which a real
 * browser only does after the page's own synchronous script has run.
 *
 * `deferClient` withholds the client script instead, handing back a `bootClient`
 * to run it later. That models the ordering the real page has no control over:
 * the parent's message listener lives in a DEFERRED script that cannot run until
 * the whole page has parsed, while a stage's own scripts run as soon as its
 * frame exists. */
function loadBoard(stages, engine, { deferClient = false } = {}) {
  const blocks = stages.map(html => ({ kind: 'html', html }));
  // A second kind keeps this off the full-page stage layout, which is a
  // different markup shape and not what this file is about.
  blocks.push({ kind: 'markdown', text: 'not a page board' });
  const board = createBoard({ title: 'stage mermaid', blocks });
  const pageHtml = renderBoardPage(board);
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  if (engine) window.mermaid = engine;
  const location = { protocol: 'file:' };
  const bootClient = () => {
    new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, undefined);
    document.finishParsing();
  };
  if (!deferClient) bootClient();
  return { document, window, bootClient, frames: document.querySelectorAll('.html-stage') };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =================================================================================
// 1. Markup shape: the marker decides, and nothing else changes.
// =================================================================================

await check('the marker test reads a mermaid CLASS, not the word mermaid anywhere in the bytes', () => {
  for (const yes of [
    '<pre class="mermaid">flowchart LR</pre>',
    "<pre class='mermaid'>flowchart LR</pre>",
    '<div class="figure mermaid dark">x</div>',
    '<div class = "mermaid">x</div>',
    '<div class="mermaid-figure mermaid">x</div>',
  ]) {
    assert.equal(stageCarriesMermaid(yes), true, `expected a marker in ${JSON.stringify(yes)}`);
  }
  for (const no of [
    '<p>we considered mermaid and chose graphviz</p>',
    '<div class="notmermaid">x</div>',
    '<div data-engine="mermaid">x</div>',
    '<div class="diagram" title="mermaid">x</div>',
    '',
  ]) {
    assert.equal(stageCarriesMermaid(no), false, `expected NO marker in ${JSON.stringify(no)}`);
  }
});

await check('a marked stage names the engine as a BARE SIBLING FILENAME and carries the facade before its own content', () => {
  const html = '<div><pre class="mermaid">flowchart LR</pre></div>';
  const srcdoc = buildStageSrcdoc({ html });
  const tag = `<script src="${MERMAID_ASSET}"></script>`;
  assert.ok(srcdoc.includes(tag), `the srcdoc must name the vendored engine as ${tag}`);
  // Bare: no separator, no scheme, no dot segment. The one form that resolves
  // both served (/b/<name>) and beside a Finder-opened archive.
  assert.ok(!MERMAID_ASSET.includes('/') && !MERMAID_ASSET.includes(':') && !MERMAID_ASSET.startsWith('.'),
    `the engine reference must be bare, got ${MERMAID_ASSET}`);
  assert.ok(srcdoc.indexOf(tag) < srcdoc.indexOf('<div>'),
    'the engine must be referenced before the stage\'s own content, so it is live before the stage\'s own scripts run');
  assert.ok(srcdoc.indexOf('window.mermaid = api') < srcdoc.indexOf('<div>'),
    'the facade prelude must also come before the stage\'s own content');
  assert.ok(srcdoc.startsWith(STAGE_MARGIN_RESET + stageMermaidPrelude()),
    'the margin reset and the prelude are the srcdoc\'s leading head-only run');
});

await check('an unmarked stage\'s srcdoc is exactly what it was before any of this existed', () => {
  const html = '<div class="mock"><button>Send</button></div>';
  assert.equal(buildStageSrcdoc({ html }), STAGE_MARGIN_RESET + html + stageAgentScript(),
    'a diagram-free stage must not gain a single byte');
});

await check('a board with no marked stage never names the engine anywhere in its page bytes', () => {
  const board = createBoard({
    title: 'diagram-free',
    blocks: [{ kind: 'html', html: '<div class="mock">no diagram here</div>' }, { kind: 'markdown', text: 'x' }],
  });
  const html = renderBoardPage(board);
  assert.doesNotMatch(html, /mermaid-[0-9a-f]{16}\.js/, 'a diagram-free board must name no engine');
  assert.ok(!html.includes('window.mermaid = api'), 'a diagram-free board must carry no facade');
});

await check('a question-NESTED stage takes the same injection as a top-level one -- one builder, two call sites', () => {
  const board = createBoard({
    title: 'nested stage',
    blocks: [{
      kind: 'question',
      prompt: 'Which?',
      widget: 'single',
      options: [{ label: 'A' }],
      context: [{ kind: 'html', html: '<div><pre class="mermaid">flowchart LR</pre></div>' }],
    }],
  });
  const html = renderBoardPage(board);
  const srcdocs = [...html.matchAll(/srcdoc="([^"]*)"/g)].map(m => m[1]);
  assert.equal(srcdocs.length, 1, `setup failure: expected exactly one stage, found ${srcdocs.length}`);
  assert.ok(srcdocs[0].includes(MERMAID_ASSET), 'a context-nested stage must get the engine too');
});

// =================================================================================
// 2. The facade and the render protocol, driven end to end.
// =================================================================================

await check('archive path: the facade installs, the artifact\'s own loader short-circuits on it, and the parent-rendered SVG lands in the figure', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard([artifactStage()], engine);
  assert.equal(frames.length, 1, 'setup failure: no stage frame rendered');
  frames[0].loadSrcdoc();
  await flush();

  const stageWindow = frames[0].contentWindow;
  assert.equal(stageWindow.__loader.sawEngine, true,
    'the artifact\'s own `if (!window.mermaid)` must short-circuit -- that is what keeps its CDN fallback from ever firing');
  assert.equal(stageWindow.__loader.fellBack, false, 'the artifact must never reach its own loader chain');

  assert.equal(engine.rendered.length, 1, `the parent must have drawn exactly one diagram, drew ${engine.rendered.length}`);
  assert.equal(engine.rendered[0].text, DIAGRAM, 'the parent must be handed the figure\'s own source');

  const pre = frames[0].contentDocument.querySelector('pre.mermaid');
  const svg = pre.querySelector('svg');
  assert.ok(svg, 'the figure must hold the returned SVG');
  assert.equal(svg.getAttribute('data-src'), 'flowchart LR', 'and it must be THIS figure\'s own SVG');
  assert.equal(pre.getAttribute('data-processed'), 'true', 'a drawn figure stays claimed, so a second pass leaves it alone');
});

await check('the archive render survives the parent listening LATE -- the request is repeated until it is answered', async () => {
  // The ordering the real page cannot control, and the one this fix exists for:
  // the stage's facade sends before the parent's deferred client script has run,
  // so the first send reaches a window with no 'message' listener on it at all
  // and is simply lost. (Ablation: drop the resend timer from
  // stageMermaidPrelude -- keep the single `post` in `ask` -- and this check
  // fails with the figure still on raw source, while every other check in this
  // file stays green, because every one of them boots the client first.)
  const engine = stubEngine();
  const { frames, bootClient } = loadBoard([artifactStage()], engine, { deferClient: true });
  frames[0].loadSrcdoc();
  await flush();
  const pre = frames[0].contentDocument.querySelector('pre.mermaid');
  assert.equal(engine.rendered.length, 0,
    'setup failure: the parent must not have heard the first send -- its listener does not exist yet');
  assert.equal(pre.getAttribute('data-processed'), 'true', 'setup failure: the facade claimed the figure before posting');

  bootClient();
  // Real time, not a chained microtask flush: the resend is a wall-clock
  // interval, so nothing short of actually waiting one can deliver it.
  await sleep(400);
  await flush();
  assert.equal(engine.rendered.length, 1,
    'the repeated request must reach the parent once its listener finally exists');
  assert.ok(pre.querySelector('svg'), 'and the figure must end up rendered, not stuck on raw source');
});

await check('a resend of a batch already in flight is dropped, never drawn twice and never answered twice', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>'], engine);
  frames[0].loadSrcdoc();
  const replies = recordReplies(frames[0]);
  // Five copies of ONE request, the shape a facade resending across a slow
  // parent produces. (Ablation: drop `__cbMermaidInFlight` from
  // handleStageMermaid and the engine draws five times, four of the five
  // answers carry nulls, and whichever null lands first latches failure onto a
  // figure that was about to be drawn.)
  for (let i = 0; i < 5; i++) {
    postAsStage(window, frames[0], {
      cb: 'cb-stage', type: 'mermaid', requestId: 'same', sources: [DIAGRAM],
    });
  }
  await flush();
  assert.equal(engine.rendered.length, 1, `one batch, drawn once, drew ${engine.rendered.length} times`);
  const answers = replies.filter(m => m.type === 'diagrams');
  assert.equal(answers.length, 1, `one batch, answered once, got ${answers.length} answers`);
  assert.ok(typeof answers[0].svgs[0] === 'string', 'and the one answer is the real one, not a refusal');

  // The id is released once answered, so an honest later batch reusing it is
  // not refused forever.
  postAsStage(window, frames[0], { cb: 'cb-stage', type: 'mermaid', requestId: 'same', sources: [DIAGRAM] });
  await flush();
  assert.equal(engine.rendered.length, 2, 'a request reusing a completed id must still be drawn');
});

await check('the stage renders a batch in one round trip, and every figure gets its OWN svg', async () => {
  const engine = stubEngine();
  const stage = `<pre class="mermaid">flowchart LR\n  A --> B</pre><pre class="mermaid">flowchart TD\n  C --> D</pre>
<script>window.mermaid.run({ nodes: document.querySelectorAll('pre.mermaid') });</script>`;
  const { frames } = loadBoard([stage], engine);
  frames[0].loadSrcdoc();
  await flush();
  assert.equal(engine.rendered.length, 2, 'both figures must be drawn');
  const pres = frames[0].contentDocument.querySelectorAll('pre.mermaid');
  assert.equal(pres[0].querySelector('svg').getAttribute('data-src'), 'flowchart LR', 'the first figure must hold the first diagram\'s svg');
  assert.equal(pres[1].querySelector('svg').getAttribute('data-src'), 'flowchart TD', 'the second figure must hold the second diagram\'s svg');
});

await check('startOnLoad: a stage that never calls run still gets its diagrams drawn on load, the way the real engine does', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard(['<pre class="mermaid">flowchart LR\n  A --> B</pre>'], engine);
  frames[0].loadSrcdoc();
  // No artifact script at all: contentLoaded is the only thing that can fire.
  frames[0].contentWindow.mermaid.contentLoaded();
  await flush();
  assert.equal(engine.rendered.length, 1, 'startOnLoad must draw a figure nobody asked for explicitly');
  assert.equal(frames[0].contentWindow.mermaid.startOnLoad, true, 'the facade\'s default matches the engine\'s own');
});

await check('startOnLoad: an artifact that turns it off through initialize is never drawn twice', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard([artifactStage()], engine);
  frames[0].loadSrcdoc();
  await flush();
  assert.equal(engine.rendered.length, 1, 'setup failure: the artifact\'s own run must have drawn once');
  assert.equal(frames[0].contentWindow.mermaid.startOnLoad, false, 'initialize({startOnLoad:false}) must be honoured');
  frames[0].contentWindow.mermaid.contentLoaded();
  await flush();
  assert.equal(engine.rendered.length, 1, 'the load-time pass must not redraw what the artifact already drew');
});

await check('render(): the promise API answers with the svg, and rejects rather than resolving empty when the board cannot draw', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard(['<div class="mermaid">placeholder</div>'], engine);
  frames[0].loadSrcdoc();
  const stageWindow = frames[0].contentWindow;
  const ok = stageWindow.mermaid.render('x', 'flowchart LR\n  A --> B');
  await flush();
  const out = await ok;
  assert.ok(out.svg.includes('<svg'), 'render() resolves with the svg the parent drew');

  const failing = stubEngine({ fail: true });
  const second = loadBoard(['<div class="mermaid">placeholder</div>'], failing);
  second.frames[0].loadSrcdoc();
  const rejected = second.frames[0].contentWindow.mermaid.render('x', 'not a diagram').then(
    () => 'resolved',
    () => 'rejected',
  );
  await flush();
  assert.equal(await rejected, 'rejected', 'a diagram the board could not draw must reject, never resolve with nothing');
});

// =================================================================================
// 3. Honest degradation: raw source, never a blank figure.
// =================================================================================

await check('an unparseable diagram keeps its raw source on screen and releases its claim, so a later pass may still try', async () => {
  const engine = stubEngine({ fail: true });
  const { frames } = loadBoard([artifactStage()], engine);
  frames[0].loadSrcdoc();
  await flush();
  const pre = frames[0].contentDocument.querySelector('pre.mermaid');
  assert.equal(pre.textContent.trim(), DIAGRAM, 'the figure must still read as its own raw source');
  assert.equal(pre.querySelector('svg'), null, 'nothing must have been swapped in -- a blank figure is the one outcome this must never produce');
  assert.equal(pre.getAttribute('data-processed'), null, 'a failed figure releases its claim');
});

await check('an engine that cannot load at all degrades to raw source -- the stage is still ANSWERED, so nothing waits forever', async () => {
  // No engine on the parent window, and the on-demand load errors the way a
  // missing or corrupt sibling does. Driven by failing the inserted script
  // element, which is the one thing a real browser does here that this stand-in
  // does not do on its own.
  const { document, frames } = loadBoard([artifactStage()]);
  const realAppend = document.head.appendChild.bind(document.head);
  document.head.appendChild = el => {
    const out = realAppend(el);
    if (el.tagName === 'SCRIPT') setTimeout(() => el.dispatchEvent({ type: 'error' }), 0);
    return out;
  };
  frames[0].loadSrcdoc();
  await flush();
  const pre = frames[0].contentDocument.querySelector('pre.mermaid');
  assert.equal(pre.textContent.trim(), DIAGRAM, 'the figure must still read as its own raw source');
  assert.equal(pre.getAttribute('data-processed'), null,
    'the reply must have arrived with nulls and released the claim -- an unanswered stage leaves its figures claimed forever');
});

await check('an IMPOSTOR window.mermaid on the stage does not stop the facade installing', async () => {
  const engine = stubEngine();
  // A DOM element carrying id="mermaid" is window.mermaid for free, which is
  // exactly the shape the facade's guard has to see through.
  const stage = '<div id="mermaid"></div><pre class="mermaid">flowchart LR\n  A --> B</pre>' +
    '<script>window.mermaid = document.getElementById("mermaid");</script>' +
    '<script>window.mermaid.run({ nodes: document.querySelectorAll("pre.mermaid") });</script>';
  const { frames } = loadBoard([stage], engine);
  frames[0].loadSrcdoc();
  await flush();
  // The stage's own second script overwrote the facade with the element, so
  // nothing can render -- but the FIRST script ran against a facade that was
  // genuinely installed, which is what this asserts.
  assert.ok(typeof frames[0].contentWindow.mermaid !== 'undefined', 'setup failure');
  const clean = loadBoard(['<div id="mermaid"></div><pre class="mermaid">flowchart LR\n  A --> B</pre>'], stubEngine());
  clean.frames[0].loadSrcdoc();
  assert.equal(typeof clean.frames[0].contentWindow.mermaid.run, 'function',
    'the facade must install over an element that merely happens to be named mermaid');
});

// =================================================================================
// 4. The trust boundary.
// =================================================================================

/** Post a raw payload at the parent AS a given stage would -- the exact shape
 * the stand-in's own frame wiring delivers, so nothing here is more privileged
 * than a real stage message. */
function postAsStage(window, frame, data) {
  window.dispatchEvent({ type: 'message', data, origin: 'null', source: frame.contentWindow });
}

/** Records everything the parent posts back into a frame. */
function recordReplies(frame) {
  const seen = [];
  const real = frame.contentWindow.postMessage;
  frame.contentWindow.postMessage = function (data) {
    seen.push(data);
    return real.call(this, data);
  };
  return seen;
}

await check('a malformed mermaid message is inert: no engine call, no reply, no throw', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>'], engine);
  frames[0].loadSrcdoc();
  const replies = recordReplies(frames[0]);
  const cb = 'cb-stage';
  const hostile = [
    { cb, type: 'mermaid' },
    { cb, type: 'mermaid', requestId: 'a' },
    { cb, type: 'mermaid', requestId: 7, sources: ['flowchart LR'] },
    { cb, type: 'mermaid', requestId: '', sources: ['flowchart LR'] },
    { cb, type: 'mermaid', requestId: 'x'.repeat(65), sources: ['flowchart LR'] },
    { cb, type: 'mermaid', requestId: 'a', sources: [] },
    { cb, type: 'mermaid', requestId: 'a', sources: 'flowchart LR' },
    { cb, type: 'mermaid', requestId: 'a', sources: new Array(33).fill('flowchart LR') },
  ];
  for (const data of hostile) postAsStage(window, frames[0], data);
  await flush();
  assert.equal(engine.rendered.length, 0, `no malformed message may reach the engine, ${engine.rendered.length} did`);
  assert.equal(replies.length, 0, 'a refused message is answered with silence, not with a reply an attacker can time');
});

await check('an over-long source is nulled in place, so a batch\'s indices never shift under the stage', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>'], engine);
  frames[0].loadSrcdoc();
  const replies = recordReplies(frames[0]);
  postAsStage(window, frames[0], {
    cb: 'cb-stage',
    type: 'mermaid',
    requestId: 'r1',
    sources: ['x'.repeat(50001), 'flowchart LR\n  A --> B', 12, 'y'.repeat(50000)],
  });
  await flush();
  const reply = replies.find(m => m.type === 'diagrams');
  assert.ok(reply, 'a well-formed request is always answered');
  assert.equal(reply.requestId, 'r1', 'the reply echoes the request it answers');
  assert.equal(reply.svgs.length, 4, 'the reply carries one slot per requested source');
  assert.equal(reply.svgs[0], null, 'an over-cap source is refused');
  assert.ok(reply.svgs[1].includes('<svg'), 'a legal source beside a refused one is still drawn');
  assert.equal(reply.svgs[2], null, 'a non-string source is refused');
  assert.equal(engine.rendered.length, 2, 'only the legal sources reach the engine');
});

await check('the reply goes to the frame that asked and to no other stage on the page', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard([artifactStage(), '<div class="mermaid">other</div>'], engine);
  assert.equal(frames.length, 2, 'setup failure: expected two stages');
  frames[0].loadSrcdoc();
  frames[1].loadSrcdoc();
  const other = recordReplies(frames[1]);
  const mine = recordReplies(frames[0]);
  postAsStage(window, frames[0], { cb: 'cb-stage', type: 'mermaid', requestId: 'r1', sources: [DIAGRAM] });
  await flush();
  assert.ok(mine.some(m => m.type === 'diagrams'), 'the asking frame is answered');
  assert.equal(other.filter(m => m.type === 'diagrams').length, 0, 'no other stage hears the answer');
});

await check('securityLevel is never forwarded, whatever the stage asks for', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard([artifactStage()], engine);
  frames[0].loadSrcdoc();
  await flush();
  assert.ok(engine.initCalls.length >= 1, 'the engine must be initialized for the batch');
  for (const config of engine.initCalls) {
    assert.equal('securityLevel' in config, false,
      `a stage must never reach mermaid's own sanitizer switch, got ${JSON.stringify(config)}`);
  }
  const forwarded = engine.initCalls[engine.initCalls.length - 1];
  assert.equal(forwarded.themeVariables.primaryColor, '#123456',
    'the presentational half of a stage\'s config IS forwarded -- that is why an artifact\'s diagram matches its own palette');
  assert.equal(forwarded.startOnLoad, false, 'the parent fixes startOnLoad itself');
});

await check('a stage cannot smuggle anything past the config allowlist', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>'], engine);
  frames[0].loadSrcdoc();
  postAsStage(window, frames[0], {
    cb: 'cb-stage',
    type: 'mermaid',
    requestId: 'r1',
    sources: ['flowchart LR\n  A --> B'],
    config: {
      securityLevel: 'loose',
      maxTextSize: 1e9,
      htmlLabels: true,
      arrowMarkerAbsolute: true,
      theme: 'not-a-real-theme',
      fontFamily: 'z'.repeat(500),
      themeVariables: { primaryColor: '#fff', 'bad key': 'x', nested: { deep: 1 }, huge: 'v'.repeat(200) },
    },
  });
  await flush();
  const config = engine.initCalls[engine.initCalls.length - 1];
  for (const key of ['securityLevel', 'maxTextSize', 'htmlLabels', 'arrowMarkerAbsolute', 'fontFamily']) {
    assert.equal(key in config, false, `${key} must not survive the allowlist`);
  }
  assert.equal(config.theme, 'base', 'an unknown theme name falls back to the board\'s own default');
  assert.deepEqual(config.themeVariables, { primaryColor: '#fff' },
    'only short scalar themeVariables under a plain identifier survive');
});

await check('a stage cannot queue unbounded work on the page\'s own render chain, and a refused batch is still ANSWERED', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>', '<div class="mermaid">y</div>'], engine);
  frames[0].loadSrcdoc();
  frames[1].loadSrcdoc();
  const replies = recordReplies(frames[0]);
  // Every one of these lands before a single queued task has run, so they all
  // compete for the same ceiling -- exactly the shape a stage looping on
  // postMessage produces.
  for (let i = 0; i < 40; i++) {
    postAsStage(window, frames[0], {
      cb: 'cb-stage', type: 'mermaid', requestId: `r${i}`, sources: ['flowchart LR\n  A --> B'],
    });
  }
  await flush();
  assert.equal(engine.rendered.length, 4,
    `the flood must be cut at the queue ceiling, ${engine.rendered.length} batches got through`);
  assert.equal(replies.filter(m => m.type === 'diagrams').length, 40,
    'every batch is answered, refused ones included -- an unanswered batch leaves its figures claimed forever');
  assert.equal(replies.filter(m => m.type === 'diagrams' && m.svgs[0] === null).length, 36,
    'and a refused batch answers with nulls, which is what releases them');

  // The ceiling is per stage, not per page: a board carrying several
  // diagram-bearing stages is the author's own doing, and one stage flooding
  // must not cost another one its diagrams.
  const other = recordReplies(frames[1]);
  postAsStage(window, frames[1], { cb: 'cb-stage', type: 'mermaid', requestId: 'n1', sources: [DIAGRAM] });
  await flush();
  const answer = other.find(m => m.type === 'diagrams');
  assert.ok(answer && typeof answer.svgs[0] === 'string',
    'a second stage must still be drawn while the first is being throttled');
});

await check('a request that never left the frame releases its figures, rather than leaving them claimed forever', async () => {
  const engine = stubEngine();
  const { frames } = loadBoard(['<pre class="mermaid">flowchart LR\n  A --> B</pre>'], engine);
  frames[0].loadSrcdoc();
  const stageWindow = frames[0].contentWindow;
  // What a real browser does when the artifact's own config carries something
  // structured-clone cannot copy: postMessage throws and nothing is ever sent.
  stageWindow.parent.postMessage = () => { throw new Error('could not be cloned'); };
  await stageWindow.mermaid.run();
  await flush();
  const pre = frames[0].contentDocument.querySelector('pre.mermaid');
  assert.equal(engine.rendered.length, 0, 'setup failure: nothing must have reached the parent');
  assert.equal(pre.textContent.trim(), 'flowchart LR\n  A --> B', 'the figure keeps its own raw source');
  assert.equal(pre.getAttribute('data-processed'), null,
    'and releases its claim -- a figure claimed by a request that never left could never be drawn again');
});

await check('a stage\'s config cannot bleed into the next render -- every batch initializes for itself', async () => {
  const engine = stubEngine();
  const { window, frames } = loadBoard(['<div class="mermaid">x</div>'], engine);
  frames[0].loadSrcdoc();
  postAsStage(window, frames[0], {
    cb: 'cb-stage',
    type: 'mermaid',
    requestId: 'r1',
    sources: ['flowchart LR\n  A --> B'],
    config: { theme: 'forest', themeVariables: { primaryColor: '#ff0000' } },
  });
  await flush();
  postAsStage(window, frames[0], {
    cb: 'cb-stage',
    type: 'mermaid',
    requestId: 'r2',
    sources: ['flowchart LR\n  C --> D'],
  });
  await flush();
  const second = engine.initCalls[engine.initCalls.length - 1];
  assert.equal(second.theme, 'base', 'the second batch must not inherit the first stage\'s theme');
  assert.deepEqual(second.themeVariables, {}, 'nor its palette');
});

process.exit(failures ? 1 : 0);
