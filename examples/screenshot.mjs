// Regenerates the two committed PNGs (examples/sample-board.png,
// examples/sample-board-comments.png) and the committed session GIF
// (examples/sample-board-session.gif) from the committed examples/sample-board.html.
// Zero dependencies: Node 22+'s global WebSocket/fetch drive headless Chrome over the
// DevTools Protocol directly. Run with `node examples/screenshot.mjs`.
//
// The board has two rounds one pager flip apart (commit 82fee7c): round 1 is a page
// board -- one html block filling the viewport, no card -- and round 2 is the block
// gallery, and is what the page opens on. Neither shot can show the other's shape, so
// this script takes two: the gallery on load (sample-board.png), and round 1 reached
// by driving the pager, with its pinned comment visible (sample-board-comments.png).
// The third artifact is neither, and is not a still at all: the gallery is taller
// than any readable image, so the hero crops after the first question and four of
// the five question widgets go unpictured -- and no still of any round can show the
// one thing the product IS, which is a reviewer answering it. sample-board-session.gif
// is a driven session: a drawn cursor comments on the diagram, answers all five
// widgets (including a live rank drag) and parks on Send. It is shot against an
// open round built at capture time (openRoundPage), never the committed sent page,
// and ffmpeg (brew install ffmpeg) encodes it -- the only artifact here with an
// external tool in its path.
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderBoardPage } from '../src/render.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const heroOut = path.join(examplesDir, 'sample-board.png');
const pageOut = path.join(examplesDir, 'sample-board-comments.png');
const sessionOut = path.join(examplesDir, 'sample-board-session.gif');

// Serves sample-board.html and the shared assets beside it -- see the header
// comment for why the shots must come over http. Loopback only, port 0, and only
// the three extensions the page actually names: this is a screenshot fixture,
// not a file server. Correct JS/CSS types are load-bearing (module scripts are
// MIME-checked); everything else, including the page's own /api and /b probes,
// gets a silent 404.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
// The scratch dir is searched first and holds exactly one file: the open-round
// page the session is driven against (see openRoundPage below). Everything
// else -- the committed page and the three shared assets both pages name --
// comes from examples/, so the open page costs one HTML file and no asset copies.
const scratch = mkdtempSync(path.join(tmpdir(), 'cb-screenshot-open-'));
const server = createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  const type = MIME[path.extname(name)];
  if (!type) { res.writeHead(404).end(); return; }
  const scratchPath = path.join(scratch, name);
  const file = existsSync(scratchPath) ? scratchPath : path.join(examplesDir, name);
  try {
    res.writeHead(200, { 'content-type': type }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(res => server.listen(0, '127.0.0.1', res));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}/sample-board.html`;
const openUrl = `${origin}/sample-board-open.html`;

/** The same board, rewound to the moment before the reviewer touched it: round 2
 * still open, nothing answered, no comments. Written to the scratch dir rather
 * than committed, because it is not an artifact -- it is the only state in which
 * a session can be driven at all. The committed page is a SENT round, and every
 * input on a sent round renders `disabled` (src/render.mjs's `historical`), so a
 * cursor clicking through it would be a cursor clicking through nothing.
 *
 * Everything the round-2 submit produced comes off together -- `status`,
 * `sentAt`, the answers, and the comments that rode that packet -- because a
 * round that is not sent cannot have carried them. `status` is the one that
 * actually decides the page: src/render.mjs reads it (not `sentAt`) for the
 * `sent-page` body class, and that class is what hides the send bar and the
 * comment-mode toggle the session drives.
 *
 * Each question is seeded `unanswered` rather than left missing, which is what
 * mintRound itself writes when a round is posted. The await deadline is restamped
 * from the real clock for the same kind of reason: the committed literal is a
 * pinned July timestamp, long expired by any later run, and an expired round
 * paints its own timeout chrome over every frame. */
function openRoundPage() {
  const board = JSON.parse(readFileSync(path.join(examplesDir, 'sample-board.json'), 'utf8'));
  board.comments = [];
  const round2 = board.rounds[board.rounds.length - 1];
  round2.status = 'open';
  round2.sentAt = null;
  round2.awaitDeadline = new Date(Date.now() + 40 * 60 * 1000).toISOString();
  board.answers = {};
  for (const block of board.blocks) {
    if (block.kind === 'question' && block.round === round2.n) {
      board.answers[block.id] = { id: block.id, status: 'unanswered', choice: null, note: '' };
    }
  }
  writeFileSync(path.join(scratch, 'sample-board-open.html'), renderBoardPage(board), 'utf8');
}

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

// The session (sample-board-session.gif) is shot at a viewport a reviewer would
// actually have, because the whole point of it is what a reviewer's own pass
// looks like: the sticky header condensing, a widget answering under the
// cursor. That is also why it is NOT one tall capture panned in post -- a
// 20,000px viewport has nothing sticky to show and never condenses anything.
const SESSION_VIEWPORT_HEIGHT = 900;
const SESSION_FPS = 16;
const SESSION_SCROLL_FRAMES = 12;  // one eased glide between two blocks
const SESSION_MOVE_FRAMES = 8;     // one eased cursor move
const SESSION_GIF_WIDTH = 880;     // downscaled from 1440: a GIF at full width is several MB heavier for no legibility
// Every frame's own hold. A scroll or a cursor move plays at the frame rate; a
// beat is what a still frame is worth when something just happened on it.
const BEAT = { frame: 1 / SESSION_FPS, tick: 0.1, click: 0.28, read: 0.65, settle: 1.1 };

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
async function loadFresh(s, deviceScaleFactor, height, url = pageUrl) {
  await s('Emulation.setDeviceMetricsOverride', {
    width: 1440, height, deviceScaleFactor, mobile: false,
  });
  await s('Page.navigate', { url });
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

/** Cubic ease-in-out: a scroll leaves one block and arrives at the next at rest,
 * and the cursor does the same between targets. That is what makes both read as
 * deliberate rather than as a jump cut; linear motion over a page this dense is
 * unreadable at any speed. */
function ease(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

/** The pointer the reviewer appears to be holding. Headless Chrome composites no
 * OS cursor into a screenshot -- a session shot without this is a page answering
 * itself -- so the capture injects one and drives it in lockstep with the real
 * Input events. Deliberately not the platform arrow: a drawn pointer with a halo
 * that pulses on click reads at GIF frame rates, where a 12px system arrow over
 * a light panel does not.
 *
 * `pointer-events: none` is load-bearing twice over -- it keeps the overlay out
 * of the hit-testing of the very clicks it is illustrating, and out of the
 * board's own `:hover` chrome. */
/** The page ships `html { scroll-behavior: smooth }` (src/styles.mjs), which
 * makes every `scrollTo` an ANIMATION the browser runs on its own clock. The
 * tween below drives the scroll position frame by frame and then measures the
 * element it is about to click, so a scroll still gliding underneath that
 * measurement hands back coordinates that are already wrong -- observed as the
 * cursor arriving on the wrong control entirely (a click meant for the answer
 * box landing in the note field one row below it, and the typing that followed
 * going with it). Turning it off makes each step's scroll land before the same
 * step measures anything. */
const INSTANT_SCROLL_JS = `document.documentElement.style.scrollBehavior = 'auto'`;

const CURSOR_JS = `(() => {
  const wrap = document.createElement('div');
  wrap.id = 'demo-cursor';
  wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;'
    + 'width:26px;height:30px;transition:none;will-change:transform';
  wrap.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30">'
    + '<circle class="halo" cx="4" cy="3" r="0" fill="rgba(50,81,201,0.28)"/>'
    + '<path d="M3 2 L3 21 L8.2 16.2 L11.6 23.6 L14.9 22.1 L11.6 15 L18.6 14.6 Z"'
    + ' fill="#171c2a" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(wrap);
  const halo = wrap.querySelector('.halo');
  window.__cursor = (x, y) => { wrap.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };
  window.__press = (r) => { halo.setAttribute('r', String(r)); };
  window.__cursor(-40, -40);
})()`;

/** The click, the keystroke and the drag, each as the page's own event rather
 * than as a shortcut through its JavaScript.
 *
 * Real CDP input where the browser supplies it (Input.dispatchMouseEvent,
 * Input.insertText): a synthetic `el.click()` skips hover, focus and the
 * pointer-event order the widgets are actually wired to, so it would prove
 * nothing about the board and would not paint the states this GIF exists to
 * show. The one exception is the rank drag, which HTML5 drag-and-drop puts out
 * of CDP's reach without a drag interception dance; there the DragEvents are
 * constructed in the page. src/ui.mjs's rank handlers read nothing but
 * `ev.target` and `ev.clientY`, so a constructed event drives the same code
 * path the mouse would.
 *
 * `capture` is passed in rather than closed over so this stays a driver and not
 * a second copy of the frame bookkeeping. */
function makeDriver(s, capture) {
  const at = { x: -40, y: -40 };
  const evaluate = (expression) => s('Runtime.evaluate', { expression, returnByValue: true });

  /** Viewport (not page) coordinates: what Input.dispatchMouseEvent takes, and
   * what the injected cursor's `position: fixed` transform takes. */
  async function box(selector, nth = 0) {
    const { result } = await evaluate(`(() => {
      const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom }; })()`);
    if (!result.value) throw new Error(`selector matched nothing: ${selector} [${nth}]`);
    // Same fail-loud stance as rectOf, and here it is the one that matters most:
    // a collapsed element (a comment form that never opened, a widget on a round
    // that is not showing) measures 0x0, and clicking its centre puts a real
    // mouse event at (0, 0) -- top-left of the viewport, on whatever happens to
    // be there -- while every later frame looks plausible.
    if (!result.value.width && !result.value.height) {
      throw new Error(`selector matched a zero-area element (collapsed or hidden): ${selector} [${nth}]`);
    }
    return result.value;
  }

  async function place(x, y) {
    at.x = x; at.y = y;
    await evaluate(`__cursor(${Math.round(x)}, ${Math.round(y)})`);
  }

  /** Eased glide to a point, one captured frame per step. A move that would not
   * move (the cursor is already there) still costs its frames, and should: the
   * held frames read as the pause before a click, not as a stall. */
  async function moveTo(x, y, frames = SESSION_MOVE_FRAMES) {
    const from = { ...at };
    for (let f = 1; f <= frames; f++) {
      const t = ease(f / frames);
      await place(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await capture(BEAT.frame);
    }
  }

  async function moveToSelector(selector, nth = 0, dx = 0.5, dy = 0.5) {
    const b = await box(selector, nth);
    await moveTo(b.x + b.width * dx, b.y + b.height * dy);
    return b;
  }

  /** Press, release, and the halo that says so. The two mouse events are the
   * real ones; the halo is three frames of feedback around them, because at
   * 16fps an instantaneous state flip is indistinguishable from a cut. */
  async function click() {
    const p = { x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 };
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await evaluate('__press(9)');
    await capture(BEAT.frame);
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', ...p });
    await evaluate('__press(13)');
    await capture(BEAT.frame);
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p });
    await evaluate('__press(0)');
    await capture(BEAT.click);
  }

  async function clickOn(selector, nth = 0, dx = 0.5, dy = 0.5) {
    await moveToSelector(selector, nth, dx, dy);
    await click();
  }

  /** Types into whatever the click before it focused, in small runs so the text
   * arrives at a readable speed instead of appearing whole. Insert-text, not
   * per-key events: the widgets listen for `input`, which is what this fires,
   * and a 60-character note typed key by key is 60 round trips and 60 frames. */
  async function type(text, run = 4) {
    for (let i = 0; i < text.length; i += run) {
      await s('Input.insertText', { text: text.slice(i, i + run) });
      await capture(BEAT.tick);
    }
  }

  /** Drags the nth rank row onto the mth row's line, cursor riding the grip.
   * The dragover events are what actually reorder the list (src/ui.mjs moves the
   * row on each one), so they are stepped and captured rather than sent as a
   * single jump -- the reorder IS the animation. */
  async function dragRank(from, to) {
    const list = '.rank-list li';
    const grip = await box(list, from);
    const target = await box(list, to);
    await moveTo(grip.x + 26, grip.y + grip.height / 2);
    await evaluate(`(() => {
      const li = document.querySelectorAll('.rank-list li')[${from}];
      li.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    })()`);
    await evaluate('__press(11)');
    await capture(BEAT.click);
    const startY = grip.y + grip.height / 2;
    const endY = target.y + target.height / 2;
    for (let f = 1; f <= SESSION_MOVE_FRAMES; f++) {
      const y = startY + (endY - startY) * ease(f / SESSION_MOVE_FRAMES);
      await evaluate(`(() => {
        const list = document.querySelector('.rank-list');
        list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: ${Math.round(y)} }));
      })()`);
      await place(at.x, y);
      await capture(BEAT.frame);
    }
    await evaluate(`(() => {
      document.querySelector('.rank-list .dragging').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    })()`);
    await evaluate('__press(0)');
    await capture(BEAT.read);
  }

  /** Eased scroll to put `selector` under the sticky header, cursor held where
   * it is (it is `position: fixed`, so it stays put on screen exactly as a real
   * pointer does while the page moves under it). */
  async function scrollTo(selector, nth = 0) {
    const { result } = await evaluate(`(() => {
      const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
      if (!e) return null;
      const head = document.querySelector('.board-head');
      const clear = (head ? head.getBoundingClientRect().height : 0) + 20;
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      return { from: scrollY, to: Math.min(max, Math.max(0, e.getBoundingClientRect().top + scrollY - clear)) };
    })()`);
    if (!result.value) throw new Error(`selector matched nothing to scroll to: ${selector} [${nth}]`);
    const { from, to } = result.value;
    if (Math.abs(to - from) < 8) return;
    for (let f = 1; f <= SESSION_SCROLL_FRAMES; f++) {
      await evaluate(`scrollTo(0, ${Math.round(from + (to - from) * ease(f / SESSION_SCROLL_FRAMES))})`);
      await capture(BEAT.frame);
    }
  }

  async function scrollToBottom() {
    const { result } = await evaluate('({ from: scrollY, to: document.documentElement.scrollHeight - innerHeight })');
    const { from, to } = result.value;
    for (let f = 1; f <= SESSION_SCROLL_FRAMES; f++) {
      await evaluate(`scrollTo(0, ${Math.round(from + (to - from) * ease(f / SESSION_SCROLL_FRAMES))})`);
      await capture(BEAT.frame);
    }
  }

  return { box, place, moveTo, moveToSelector, click, clickOn, type, dragRank, scrollTo, scrollToBottom };
}

/** Frames -> GIF, via ffmpeg's concat demuxer so a held stop costs one frame
 * and one duration rather than 22 identical captures. Two-pass palette
 * (palettegen/paletteuse) rather than the default web-safe 216: the board's
 * whole surface is near-white panels a few points apart, and the default
 * palette posterizes them into visible bands. */
async function encodeGif(frames, outPath) {
  const listPath = path.join(path.dirname(frames[0].file), 'frames.txt');
  const lines = frames.map(f => `file '${f.file}'\nduration ${f.duration}`);
  // The concat demuxer ignores the last entry's duration, so the last frame is
  // named twice -- otherwise the final stop flashes past in 1/20s.
  lines.push(`file '${frames[frames.length - 1].file}'`);
  writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');
  const filter = `fps=${SESSION_FPS},scale=${SESSION_GIF_WIDTH}:-1:flags=lanczos,`
    + 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-filter_complex', filter, '-loop', '0', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  const code = await new Promise((resolve, reject) => {
    ff.on('error', err => reject(new Error(`ffmpeg could not be run (brew install ffmpeg): ${err.message}`)));
    ff.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
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

  // --- session: a reviewer answering round 2, cursor and all ------------------------
  // What the hero PNG cannot be. The hero crops after the first question on
  // purpose (an image tall enough for all five is unreadable at README width),
  // which leaves multi, text, rank and the rendered-variant compare with no
  // picture at all -- and no still of any kind can show the part that matters
  // most, which is that the page answers back.
  //
  // Driven against the OPEN round (openRoundPage above), never the committed
  // sent one, and driven with the browser's own input events, so every state
  // that lands on a frame is the board's real response to a real click.
  //
  // Captures are viewport-sized (no `clip`, so no captureBeyondViewport) and every
  // stage is scrolled into the real viewport before its frame is taken -- which is
  // exactly the condition the header comment's iframe trap needs, met by construction
  // rather than by a tall viewport.
  openRoundPage();
  await loadFresh(s, 1, SESSION_VIEWPORT_HEIGHT, openUrl);
  await assertMermaidRendered(s);
  await s('Runtime.evaluate', { expression: INSTANT_SCROLL_JS });
  await s('Runtime.evaluate', { expression: CURSOR_JS });
  const frameDir = mkdtempSync(path.join(tmpdir(), 'cb-session-frames-'));
  const frames = [];
  const capture = async (duration) => {
    const shot = await s('Page.captureScreenshot', { format: 'png' });
    const file = path.join(frameDir, `f${String(frames.length).padStart(4, '0')}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    frames.push({ file, duration });
  };
  const d = makeDriver(s, capture);

  // Opening on the round as posted, before anything is touched.
  await capture(BEAT.settle);

  // A comment on the diagram first, because the diagram is above the questions
  // and a reviewer reads down. The comment queues client-side (src/ui.mjs's
  // pendingComments) and only travels on Send, so it renders its pin and its
  // list entry here with no daemon behind the page.
  //
  // Comment mode is a real mode, and the session goes through it rather than
  // around it: the per-block comment buttons are `display: none` until the
  // header toggle turns them on, and while they are on the answer widgets are
  // deliberately locked (src/ui.mjs's raiseLockedNotice). So the toggle goes off
  // again before a single question is answered -- which is also the honest
  // depiction of the flow.
  await d.scrollTo('.mermaid-block');
  await d.clickOn('#comment-mode-toggle');
  await d.clickOn('.mermaid-block .comment-btn');
  await d.clickOn('.mermaid-block .comment-form input[type=text]');
  await d.type('Should Ready branch to a Recall state on a remake?');
  await capture(BEAT.read);
  await d.clickOn('.mermaid-block .comment-form button[type=submit]');
  await capture(BEAT.settle);
  await d.clickOn('#comment-mode-toggle');
  await capture(BEAT.read);

  // Then the five widgets, in the order the round posts them.
  await d.scrollTo('.question-block', 0);
  await d.clickOn('[data-question-id="q1"].choice-single', 1);
  await capture(BEAT.read);
  await d.clickOn('textarea[data-note-for="q1"]', 0, 0.5, 0.35);
  await d.type('Add a Recall step from Ready back to Prepping for remakes.');
  await capture(BEAT.read);

  await d.scrollTo('.question-block', 1);
  await d.clickOn('[data-question-id="q2"].choice-multi', 0);
  await d.clickOn('[data-question-id="q2"].choice-multi', 2);
  await capture(BEAT.read);

  await d.scrollTo('.question-block', 2);
  await d.clickOn('textarea[data-answer-for="q3"]', 0, 0.5, 0.25);
  await d.type('Make sure Recall resets the rush-bonus timer.');
  await capture(BEAT.read);

  await d.scrollTo('.question-block', 3);
  await d.dragRank(2, 1); // Monochrome up over Pastel: the numbers renumber live
  await capture(BEAT.read);

  await d.scrollTo('.question-block', 4);
  await d.clickOn('[data-question-id="q5"].choice-variant', 0);
  await capture(BEAT.settle);

  // Parked on Send, not pressing it: this page is a static fixture with no
  // daemon behind it, and a Send that errors is the one frame this must not end on.
  await d.scrollToBottom();
  await d.moveToSelector('button#send-btn');
  await capture(BEAT.settle);

  await encodeGif(frames, sessionOut);
  rmSync(frameDir, { recursive: true, force: true });
  console.log(`wrote ${sessionOut} (${frames.length} frames)`);

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
