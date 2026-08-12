// Regenerates the two committed PNGs (examples/sample-board.png,
// examples/sample-board-comments.png) from the committed examples/sample-board.html.
// Zero dependencies: Node 22+'s global WebSocket/fetch drive headless Chrome over the
// DevTools Protocol directly. Run with `node examples/screenshot.mjs`.
//
// The board has two rounds one pager flip apart (commit 82fee7c): round 1 is a page
// board -- one html block filling the viewport, no card -- and round 2 is the block
// gallery, and is what the page opens on. Neither shot can show the other's shape, so
// this script takes two: the gallery on load (sample-board.png), and round 1 reached
// by driving the pager, with its pinned comment visible (sample-board-comments.png).
// Each shot is its OWN full reload (loadFresh) rather than one load with a live flip
// in between -- see the viewport point below for why a live resize is the trap, and a
// live click is not: it never touches Emulation.setDeviceMetricsOverride.
//
// The page is served over LOCAL HTTP, not opened as file:// -- and that choice is
// what the images are FOR. body.readonly keys on `location.protocol === 'file:'`
// (src/ui.mjs), and readonly is a whole different skin: an amber banner, a
// "read-only" pill, the brand mark hidden (src/styles.mjs `body.readonly
// .back-to-index`). A file:// shot faithfully depicts the opened-from-disk
// fallback, which is precisely not the product the README is showing. Over http
// the page looks exactly as the daemon serves it; its EventSource/resync calls
// against the static server fail silently by design (src/ui.mjs swallows both),
// so no daemon is needed and no error chrome appears.
//
// The recipe (each point fixes a trap that silently produces a wrong image, not an
// error -- see QUIRKS.md "Growing the viewport after load mis-positions anchor pins"):
//   - Force light theme with Emulation.setEmulatedMedia BEFORE navigating -- the
//     shot must not depend on the OS appearance of whichever machine regenerates it.
//   - Wait after Page.navigate for mermaid's renderer (a separate vendored asset,
//     imported async) to arrive; the diagram is absent from anything captured
//     immediately.
//   - Set the viewport to a generous fixed height BEFORE Page.navigate, and never
//     touch Emulation.setDeviceMetricsOverride again after that. Two different bugs
//     share this one fix: captureBeyondViewport never paints an off-screen iframe (so
//     every html stage below the fold comes back an empty grey box unless it is
//     already inside the viewport at first paint), and growing the viewport with a
//     SECOND setDeviceMetricsOverride call after the page has already wired itself up
//     fires a synthetic 'resize' DOM event that the page's own anchor-pin refresh
//     logic mishandles -- every pin snaps to a (10, 10) fallback corner instead of
//     staying on the element it is pinned to. Doing it once, before the first layout,
//     avoids both. A round flip doesn't touch this at all: goToRound (src/ui.mjs)
//     recomputes pins itself off a plain class toggle -- though a pin over an html
//     stage lands one iframe round-trip later, which is why the flipped shot waits
//     on the pin (waitFor) instead of on the settle sleep alone.
//
// Deliberately NOT committed as a byte-identity check (unlike sample-board.html,
// which is a pure function of JSON): a screenshot is a function of the installed
// Chrome build and its fonts, so it will never be byte-stable across machines. This script is the regeneration guarantee instead.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const heroOut = path.join(examplesDir, 'sample-board.png');
const pageOut = path.join(examplesDir, 'sample-board-comments.png');

// Serves sample-board.html and the shared assets beside it -- see the header
// comment for why the shots must come over http. Loopback only, port 0, and only
// the three extensions the page actually names: this is a screenshot fixture,
// not a file server. Correct JS/CSS types are load-bearing (module scripts are
// MIME-checked); everything else, including the page's own /api and /b probes,
// gets a silent 404.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  const type = MIME[path.extname(name)];
  if (!type) { res.writeHead(404).end(); return; }
  try {
    const body = readFileSync(path.join(examplesDir, name));
    res.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(res => server.listen(0, '127.0.0.1', res));
const pageUrl = `http://127.0.0.1:${server.address().port}/sample-board.html`;

// Comfortably taller than round 2, the block gallery (~4,600 CSS px), so no mermaid
// diagram is ever off-screen at first paint, however the page's content settles.
const GALLERY_VIEWPORT_HEIGHT = 20000;

// Round 1, the page board, is a different shape: one html block at 100vh plus a
// handful of position:fixed chrome pinned to the viewport's own edges (the header,
// the pinned comment's floating panel, the round pager). Those sit N px from the
// viewport's bottom by construction, so a TALL viewport pushes them further down the
// image and opens a growing dead-space gap above them instead of tucking them under
// the artifact -- the opposite of what GALLERY_VIEWPORT_HEIGHT is for. A viewport
// close to the page's own designed size (probed: content bottoms out around 984px at
// 1440x1000) keeps the shot the size a reviewer would actually see.
const PAGE_VIEWPORT_HEIGHT = 1000;

const profile = mkdtempSync(path.join(tmpdir(), 'cb-screenshot-profile-'));
const chrome = spawn(CHROME, [
  // Port 0 means "pick a free one and write it to DevToolsActivePort in the
  // profile". Picking a port ourselves and then probing 127.0.0.1 for it trusts
  // whatever answers to be the Chrome we just spawned, and Chrome does NOT exit
  // when its debugging port is already taken -- it just runs without a debug
  // listener, so the probe succeeds against the squatter, and every reply after
  // that (screenshot bytes we commit, the page URL we send) crosses to a
  // browser we do not own. Reading the port back out of our OWN profile
  // directory binds the channel to the process we actually started.
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

// spawn reports a missing binary asynchronously, as an 'error' event. With no
// listener Node rethrows it as an uncaught exception, which kills the process
// before main()'s finally runs -- so the profile directory created one line above
// leaks, which is the exact thing that cleanup exists to prevent. Turning it into
// a rejection keeps the cleanup path and says which binary was missing.
let chromeFailed = null;
chrome.on('error', err => { chromeFailed = err; });

async function endpoint() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    // Written atomically by Chrome once the listener is up: port on line 1, the
    // browser's own ws path on line 2.
    try {
      const [livePort, wsPath] = readFileSync(portFile, 'utf8').split('\n');
      if (livePort && wsPath) return `ws://127.0.0.1:${livePort.trim()}${wsPath.trim()}`;
    } catch { /* not written yet */ }
    if (chromeFailed) throw new Error(`could not start ${CHROME}: ${chromeFailed.message}`);
    if (chrome.exitCode !== null) throw new Error(`chrome exited with ${chrome.exitCode}`);
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('chrome never came up');
}

function connect(ws) {
  let nextId = 0;
  const pending = new Map();
  // A browser that dies mid-run closes the socket without answering. Node's global
  // WebSocket is EventTarget-based, so an unhandled close/error throws nothing and
  // every outstanding send() would stay pending forever: main() never settles, the
  // finally never fires, and the run ends either hung with the profile still on disk
  // or silently at exit 0 having regenerated nothing. Failing the in-flight calls is
  // what turns that into an error the operator sees.
  const failAll = reason => {
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };
  ws.addEventListener('close', () => failAll('devtools socket closed before the reply arrived'));
  ws.addEventListener('error', () => failAll('devtools socket errored'));
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

/** getBoundingClientRect() of `selector`, in page (not viewport) coordinates, or
 * throws if nothing matches -- a wrong selector should fail loud, not hand back an
 * empty clip that silently screenshots the wrong thing.
 *
 * A zero-area rect throws too, and that half is what catches the round-1 shot
 * landing on the wrong round: a round that is not the current one is
 * `display: none` (src/styles.mjs), so everything inside it is PRESENT and
 * measures 0x0 rather than being absent. Without this, a flip that silently did
 * not happen reads as pin 0,0,0,0 / panel 0,0,0,0 and the fit check below still
 * passes, because the only other box it measures -- the pager -- is fixed to the
 * viewport and identical on both rounds. The script then writes round 2's
 * gallery into the page-board shot and exits 0. */
async function rectOf(s, selector) {
  const { result } = await s('Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
    returnByValue: true,
  });
  if (!result.value) throw new Error(`selector matched nothing: ${selector}`);
  const r = result.value;
  if (!r.width && !r.height) {
    throw new Error(`selector matched a zero-area element (hidden, or on a round that is not showing): ${selector}`);
  }
  return r;
}

/** Set the emulated viewport, THEN navigate -- see this file's header comment for
 * why the order matters. Waits for mermaid's async-imported renderer and one settle
 * pass after that before returning. */
async function loadFresh(s, deviceScaleFactor, height) {
  await s('Emulation.setDeviceMetricsOverride', {
    width: 1440, height, deviceScaleFactor, mobile: false,
  });
  await s('Page.navigate', { url: pageUrl });
  await new Promise(r => setTimeout(r, 4000)); // mermaid imports and runs its renderer async
  await new Promise(r => setTimeout(r, 1500)); // settle pass
}

/** Throws unless the mermaid diagram actually rendered.
 *
 * The wait above is a sleep, and a sleep has no post-condition. When the
 * renderer import fails or is still in flight, src/ui.mjs swallows it and either replaces
 * the diagram with a raw-source fallback or leaves the bare source standing --
 * both of which still satisfy every other selector this script measures, so the
 * hero is written showing a code listing where the README promises a flowchart,
 * and the process exits 0. `pre.mermaid svg` is the discriminating selector, the
 * same one src/ui.mjs uses to re-read a live diagram; `.mermaid-block svg` is
 * NOT -- it also matches the block's own comment and expand button icons, so it
 * is non-zero in both failure modes. */
async function assertMermaidRendered(s) {
  await rectOf(s, 'pre.mermaid svg');
}

/** Polls until `selector` matches something with a non-zero box, or gives up.
 *
 * An anchor pin over an html stage is not painted by the flip that reveals it:
 * refreshPins (src/ui.mjs) asks the sandboxed iframe where the element is and
 * builds the pin when the stage's agent script answers, so the pin arrives one
 * postMessage round-trip after goToRound returns. A fixed settle sleep covers
 * that on an idle machine and loses the race on a busy one -- observed as
 * `selector matched nothing: .pin-layer[data-block-id="h1"] .anchor-pin` on one
 * run and a clean pin on the next, same bytes. Waiting on the post-condition
 * instead of on a duration is the whole fix; the throw at the end keeps the
 * fail-loud stance for a pin that genuinely never comes. */
async function waitFor(s, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await rectOf(s, selector);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

/** Click `selector` in the page, throwing loudly if nothing matches -- same
 * fail-loud stance as rectOf, for the same reason: a selector that silently
 * clicks nothing leaves the page on whatever round it was already showing, and
 * the screenshot that follows would look plausible right up until someone
 * compared it to the alt text. */
async function click(s, selector) {
  const { result } = await s('Runtime.evaluate', {
    expression: `(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return false; e.click(); return true; })()`,
    returnByValue: true,
  });
  if (!result.value) throw new Error(`selector matched nothing to click: ${selector}`);
}

async function main() {
  const ws = new WebSocket(await endpoint());
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const send = connect(ws);

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');
  // Must precede every Page.navigate below -- forcing the media feature after load
  // does not retroactively flip the page's own prefers-color-scheme read at boot.
  await s('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });

  // --- hero shot: the block gallery (round 2), what the board opens on -------------
  // Crops through the first answered question (q1), which is a clean lower edge --
  // a whole block, not a torn one -- and carries markdown, mermaid, code, compare
  // and one answered widget into a single image without dragging in all five
  // questions, which would make the hero as tall as the whole round.
  await loadFresh(s, 1, GALLERY_VIEWPORT_HEIGHT);
  await assertMermaidRendered(s);
  const shell = await rectOf(s, '.board-shell');
  const firstQuestion = await rectOf(s, '[data-block-id="q1"]');
  const heroClip = {
    x: Math.max(0, shell.x - 16),
    y: 0,
    width: shell.width + 32,
    height: firstQuestion.y + firstQuestion.height + 16,
    scale: 1,
  };
  const hero = await s('Page.captureScreenshot', { format: 'png', clip: heroClip });
  writeFileSync(heroOut, Buffer.from(hero.data, 'base64'));
  console.log(`wrote ${heroOut}`);

  // --- page shot: round 1, the page board, with its pinned comment -----------------
  // A full reload rather than flipping the hero's already-loaded page: each shot gets
  // its own loadFresh so the two never share viewport state (GALLERY_VIEWPORT_HEIGHT
  // above is 20x taller than this shot wants). The round-1 flip itself -- the click
  // below -- happens AFTER that fresh load, same as a reviewer would drive it, and
  // never touches Emulation.setDeviceMetricsOverride, so it is not the resize this
  // script's recipe warns about.
  // deviceScaleFactor 1, matching the hero. 2x was worth it when this shot was a
  // tight crop of a single pin; it is a full-viewport capture now, and the pair
  // reading at two different densities makes the PRIMARY README image the soft one.
  await loadFresh(s, 1, PAGE_VIEWPORT_HEIGHT);
  await click(s, 'nav#round-pager .round-page[data-round="1"]');
  // Settles the round's 160ms CSS transitions (the header's fixed/pill states, the
  // pager's current-entry state). The pin over this round's html stage is NOT covered
  // by this sleep -- goToRound (src/ui.mjs) re-asks the sandboxed iframe for the
  // anchor's box and builds the pin when the answer comes back -- so waitFor below
  // waits on the pin itself rather than trusting a duration.
  await new Promise(r => setTimeout(r, 1000));
  // The flip is asserted, not assumed. `click()` proves only that the selector
  // matched -- a disabled button or an unwired nav swallows the click and returns
  // true either way -- and `body.page-board` is what the layout itself keys on
  // (src/ui.mjs toggles it per current round), so it is the honest post-condition.
  const onPageBoard = await s('Runtime.evaluate', {
    expression: `document.body.classList.contains('page-board')`,
    returnByValue: true,
  });
  if (!onPageBoard.result.value) {
    throw new Error('flip to round 1 did not take: <body> is not .page-board, so this would have shot the wrong round');
  }
  // waitFor throws if the pin is missing OR zero-area once its deadline is up;
  // asserting its bottom edge separately below catches the shot cropping a real
  // pin out of frame instead.
  const pin = await waitFor(s, '.pin-layer[data-block-id="h1"] .anchor-pin');
  const commentPanel = await rectOf(s, '.page-comments');
  const pager = await rectOf(s, 'nav#round-pager');
  const pageBottom = Math.max(
    pin.y + pin.height, commentPanel.y + commentPanel.height, pager.y + pager.height,
  );
  // Guard the CLIP, not the content. The old form admitted `pageBottom <= H - 8`
  // and then asked for `pageBottom + 16` rows -- up to 8px past the emulated
  // viewport, a region Chrome paints as a blank band because the page is
  // `overflow: hidden` over a 100vh stage. Comparing the number actually
  // requested against the viewport is the same check without the gap.
  const pageClipHeight = Math.ceil(pageBottom + 16);
  if (pageClipHeight > PAGE_VIEWPORT_HEIGHT) {
    throw new Error(
      `page-board content (clip ${pageClipHeight}) no longer fits PAGE_VIEWPORT_HEIGHT `
      + `(${PAGE_VIEWPORT_HEIGHT}) -- raise the constant`,
    );
  }
  const pageClip = { x: 0, y: 0, width: 1440, height: pageClipHeight, scale: 1 };
  const pageShot = await s('Page.captureScreenshot', { format: 'png', clip: pageClip });
  writeFileSync(pageOut, Buffer.from(pageShot.data, 'base64'));
  console.log(`wrote ${pageOut}`);

  ws.close();
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Wait for the process to actually be gone before removing its profile: Chrome
    // is still flushing that directory when kill() returns, and rmSync races it into
    // an ENOTEMPTY. A throwaway profile is ~13MB, so without the removal every
    // regeneration leaves another one behind in the temp dir, forever.
    const exited = chrome.exitCode !== null || chrome.signalCode !== null
      ? Promise.resolve()
      : new Promise(res => chrome.once('exit', res));
    chrome.kill();
    await exited;
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
