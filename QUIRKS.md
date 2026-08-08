# QUIRKS

Tooling traps in this repo. Read before fighting something; append when something fights you.

- [The rendered page: stylesheets and client-script literals](#the-rendered-page-stylesheets-and-client-script-literals)
- [The DOM stand-in's ceilings, and what needs a real browser](#the-dom-stand-ins-ceilings-and-what-needs-a-real-browser)
- [The check suite's own shapes](#the-check-suites-own-shapes)
- [launchd, TCC and the app bundle](#launchd-tcc-and-the-app-bundle)
- [macOS notifications and sound](#macos-notifications-and-sound)
- [Shell, C and the filesystem](#shell-c-and-the-filesystem)

---

## The rendered page: stylesheets and client-script literals

### The stylesheet and the markup are checked against each other

`test/check-pure.mjs` ("every class the stylesheet rules on is a class something
actually emits") scans `src/styles.mjs` for every `.class-name` and fails if that
string does not appear in `src/render.mjs`, `src/ui.mjs`, `src/indexpage.mjs` or
`src/markdown.mjs`. So: no speculative CSS. A rule for a class nothing renders is a
test failure, not dead code. Attribute selectors (`[data-status="answered"]`) are
not scanned, which is the escape hatch when a state has no class.

Several rules are asserted by their exact text, not their effect —
`.readonly-banner { display: none;` and `body.readonly .send-bar { display: none; }`.
Keep each of those on one line and keep the wording; reformatting them breaks the
checks.

Asserting a rule by its text is itself a trap, and the mermaid rules are why: they
used to be asserted as the literal string `g[id^="flowchart-"]`, which matched the
stylesheet perfectly while selecting nothing any browser ever rendered (see "Real
mermaid node ids are prefixed"). Those two rules are now built from
`MERMAID_NODE_SELECTOR` (`src/anchor.mjs`) and checked by asking whether they would
select a REAL node id, not by matching their spelling. Prefer that shape for any new
rule whose whole job is to select something.

### No external assets, ever

`renderBoardPage` output must open from Finder with the network off. The page test
rejects any `<link rel=stylesheet>` or `<script src=>`, so: no web fonts (system
stack only), no icon fonts, no CDN CSS. Icons are inline SVG. Mermaid is the one
exception — it is imported at runtime from a CDN and degrades to raw source when it
cannot be reached.

### Two stylesheets, one palette

The html-stage iframe is sandboxed and the page's tokens never reach it, so
`stageAgentScript` (`src/render.mjs`) hand-maintains its own copies: the hover
outline as a literal hex, and `.cb-anchor-sent` (`cursor: not-allowed`) as the same
class name kept in step by convention and nothing else.

The hex tracks `--accent`'s **light** value in both themes, because the requirement
is not "matches the token" but "has contrast on the surface it renders on" — a
per-palette neutral artboard (`--stage-bg`: `#c3c6cd` dark, `#e6e8ee` light), which
must stay light in both, since a srcdoc painting no background renders the UA's black
text. `test/check-pure.mjs` asserts each part separately (the two `--stage-bg` values
differ; outline >= 3:1 against **each** surface; black text >= 4.5:1 on each;
equality with the light accent), so a palette change fails on the part it broke.

The stage is the only thing that has ever needed this. "Cannot link the stylesheet"
is not "cannot read the palette": the self-contained 401 refusal page drifted twice
from being treated as if it were the stage, and now emits both token blocks from
`palettes` at render time and paints through `var()`.

### A diagram lens holds a clone, and a theme change replaces what it cloned

`mermaidThemeVariables()` (`src/ui.mjs`) reads live computed style through
`MERMAID_TOKEN_MAP`, so nothing about mermaid's colours is hand-maintained — but
"downstream of the tokens" only holds at the moment a clone is taken. A theme change
runs `runMermaidRedrawPass`, which REPLACES each inline `<svg>`, and an already-open
lens goes on holding a clone of the replaced one (measured: dark diagram inside light
chrome). Only reachable through `src/theme.mjs`'s `matchMedia` listener, since a modal
`<dialog>` makes the theme control itself inert — i.e. the reader who leaves a diagram
open while macOS switches at sunset. `lensRetheme` re-clones from the fresh svg and
`test/check-mermaid-theme.mjs` fails when the call is removed.

### A CSS *comment* is shipped on the index page too, and one check reads its words

`src/styles.mjs` is one stylesheet, embedded whole by both `renderBoardPage` and
`renderIndexPage`. `test/check-pure.mjs`'s index-row check asserts the rendered index page
contains no ordinal wording — `assert.doesNotMatch(html, /\bround \d/i)` — over the WHOLE
page, comments included. So a CSS comment reading "a control that vanishes at round 1"
fails an index check that has nothing to do with the rule it sits above, and the failure
names the index row, not the stylesheet (reproduced; the rule was the round pager's
chevrons). Two consequences: prose in `src/styles.mjs` is shipped text, not a private
note, and a check that greps a whole rendered page will read your comments.

### A backtick inside a template-literal payload ends the whole file

`src/ui.mjs`'s `ui`, `src/styles.mjs`'s `styles`, `src/render.mjs`'s `stageAgentScript()`
and `src/theme.mjs`'s `themeBootScript` each carry their entire payload as one template
literal, so `render.mjs` can inline it verbatim. A markdown-style code span in a comment
*inside* that literal is a real backtick to the parser: it closes the literal early and
reopens at the next one, leaving whatever sat between them as invalid top-level JS.

How the break surfaces splits the four literals in two, and the difference is worth
knowing before you go looking. `src/styles.mjs` is mostly CSS, so a stray backtick in a
CSS comment usually leaves the *outer file* invalid too: `node --check src/styles.mjs`
fails and names the stray backtick's own line (reproduced). The other three —
`src/ui.mjs`'s `ui`, `src/render.mjs`'s `stageAgentScript()`, `src/theme.mjs`'s
`themeBootScript` — carry JS that stays plausible top-level JS after the literal closes
early, so the outer file still parses cleanly and `node --check` reports nothing. There
the break surfaces nowhere near the typo: `npm run check` fails a pile of unrelated checks
with `SyntaxError: Unexpected identifier` at whatever module imported the broken file
first, and only running the extracted string through
`new Function('document','window','location', ui)` (as every check in `test/` does) proves
the *client script itself* still parses. So: `node --check <file>` is the cheapest probe
and worth running first, but a clean result rules the typo out only for `styles`; edits
that passed it and failed the `new Function` round have happened repeatedly.

Quote identifiers with single quotes in comments inside these literals — the existing
convention in all four (`src/ui.mjs`'s own "'## Send btn' is exactly as mintable as
'## Board data'"). Backticks are fine outside the literal and inside real `${...}`.

### Readonly is locked twice — CSS and JS — and reusing chrome inherits both

`.mode-toggle` (`src/styles.mjs`/`src/ui.mjs`) is hidden in a read-only archive by
TWO independent mechanisms: `body.readonly .mode-toggle { display: none; }` in the
stylesheet, AND `src/ui.mjs`'s blanket `qsa('textarea, input, button').forEach(el =>
el.disabled = true)` readonly loop. The theme control reuses `.mode-toggle`'s chrome
by design but has to stay live in readonly, and carving it out of only one mechanism
produces a control that LOOKS fixed and isn't: out of the CSS alone leaves it visible
but `disabled` (and the stand-in's `dispatchEvent` does not model a browser's native
click-suppression on a disabled element, so a check that dispatches a click and reads
the result passes against a genuinely dead button); out of the JS loop alone leaves it
`display: none`.

Neither existing rule could be edited to add the exception — both are asserted by
exact literal text elsewhere in the suite (`qsa('textarea, input, button')` in
`test/check-pure.mjs`), so the fix in both places is an ADDITIONAL rule stated as an
override. Before reusing a control's class for one with different readonly semantics,
grep every place that class is gated on `body.readonly`: CSS and JS are not the same
gate.

---

## The DOM stand-in's ceilings, and what needs a real browser

### Real mermaid node ids are prefixed, and `^=` will not see them

Mermaid 11 (the CDN version the page pins) namespaces every flowchart node id with
the diagram's own generated svg id:

    mermaid-1785397890978-flowchart-shim-0     <- real
    flowchart-shim-0                           <- what the checks used to assume

Anything matching `^flowchart-` therefore matches **nothing** in a real browser. That
one assumption killed the entire diagram gesture — click walk-up, hover affordance,
pointer cursor and pin rendering all keyed off it — while a 380-line dedicated check
stayed green, because the check hand-wrote the unprefixed shape into its `window.mermaid`
mock. Use `MERMAID_NODE_SELECTOR` / `parseMermaidDomId` from `src/anchor.mjs`; both
accept the prefixed and bare forms. The real ids are recorded in
`test/fixtures/mermaid-real-ids.json`, copied out of a browser — if you need to change
what shape the checks assume, change that file, and re-record it from a browser rather
than reasoning about it.

### `setPointerCapture` on pointerdown steals the click from what you clicked

Any drag-to-pan surface will reach for `element.setPointerCapture(ev.pointerId)` in
its `pointerdown` handler, and this repo's diagram lens copied that shape. While a
capture is active Chrome retargets **everything that follows** at the capture element:
`pointerup`, `mouseup` and, crucially, the `click` the pair produces. So a click
handler on that same surface sees `ev.target === theSurface`, not the thing under the
pointer, and any `ev.target.closest(...)` walk-up finds nothing. Measured in Chrome
150: the lens's own comment gesture was dead for exactly this reason, while every check
in `test/check-mermaid-anchor.mjs` — which drives the whole gesture end to end through
the DOM stand-in — stayed green, because there is no such thing as pointer capture in
the stand-in.

The fix is to take the capture **only once the press has actually become a drag**
(past a few pixels of movement), never on the press itself: a plain click then never
has capture active and targets normally, and a genuine pan is captured before it can
leave the element. `test/check-pure.mjs` pins the shape of that, which is as far as a
check without a browser can go.

### The stand-in has no layout: no `IntersectionObserver`, no `scrollHeight`, no `clientHeight`

`test/dom-stand-in.mjs` is a DOM, not a browser: nothing in it lays anything out, so an
API whose whole job is reporting real layout is either absent or permanently zero.

- **`IntersectionObserver` is not defined at all.** Every construction site
  (`setupSendBarDock`, `src/ui.mjs`) guards on `typeof IntersectionObserver !== 'function'`
  and returns immediately when it is missing — by design, so the stand-in does not throw.
  Anything decided *inside* such an observer therefore runs under no check at all unless a
  check installs `StandInIntersectionObserver` and drives the callback itself.

  This is why the round pager is state-driven rather than scroll-driven. The round badge
  used to name "the round crossing the sticky header line", decided by an observer over a
  96px band, and its real defect (a 1px band that a smooth-scrolled section jumps clean
  over between two consecutive samples) could only be found by recreating the observer in
  real Chrome. Rounds are pages now (ADR 42): one class, one variable, one function that
  writes both — all of which this DOM can see, which is how `test/check-round-pager.mjs`
  asserts what the reviewer would actually be looking at. **Prefer explicit state over
  measured position for anything that has to be checkable here.**

- **The cascade resolver cannot see an interaction pseudo-class, so a rule gated on one is
  invisible to every check.** `resolveComputedProperty` deliberately makes any compound it
  cannot evaluate — `:hover`, `:disabled`, `:focus`, `::-webkit-scrollbar` — never match
  (its own comment says why: a correct answer beats a guess). The consequence is a blind
  spot with teeth: adding `.round-flip:disabled { display: none }` hides a chevron on every
  single-round board and at both ends of every other one, and left the WHOLE suite green
  (verified). Nothing computes a different value, because the rule never applies here.

  So an invariant of the form *"this control is never taken off the page"* cannot be
  asserted by computing a property — it needs a **structural scan over the stylesheet's
  rules**: parse out every rule whose selector mentions the control at all, whatever state
  it is gated on, and assert none of them sets `display: none` / `visibility: hidden` /
  `opacity: 0` (`test/check-round-pager.mjs`, "DISABLED is not hidden"). That is the
  inverse of the trap two entries up and safe for the same reason it is a trap there:
  asserting a rule EXISTS by its spelling can match a rule that selects nothing, while
  asserting a class of rule does NOT exist cannot. Keep computing the property as well for
  the states that DO have a class (`body.readonly`, `body.page-board`, `body.sent-page`) —
  those the resolver evaluates properly, and a scan keyed on the control's own class name
  would miss `body.sent-page nav { display: none }`.

- **`scrollHeight` and `clientHeight` model exactly one fact.** They read `0` for a node
  that is not in a document, and otherwise whatever the fixture declared via
  `data-standin-client-height` / `data-standin-scroll-height`. Nothing is computed: an
  undeclared connected element reading `0` means "this stand-in knows no box for this
  node", never "this node is 0px tall".

  That one fact is modelled because every push path turns on it. `wireRoot` runs against
  a **detached** subtree by design on all three of them, and a real browser also reports
  0/0 there — so anything that measures at wire time measures zero.
  `unlockCodeCapForDrag` (`src/ui.mjs`) used to claim its one-shot unlock marker *before*
  the comparison it guards, so the marker was burned with the unlock never having run and
  the post-attach re-measurement then skipped itself: every code block arriving over SSE
  was permanently undraggable. Confirmed in Chrome (0/0 detached, 480/4478 attached), and
  now driven by two checks in `test/check-anchor-push.mjs`. The second of those asserts a
  SHORT block is left alone, which is what stops the first being satisfied by a version
  that unlocks everything.

  Do not grow this into a layout model. Anything whose answer depends on real layout
  still belongs in a real browser.

- **Nothing scrolls, but a `scroll` LISTENER can still be driven.** There is no
  `scrollY`, no `scrollTop` that moves, and no gesture — so the page board's
  condensing header (ADR 40), whose whole trigger is the artifact being scrolled
  inside its frame, looks untestable. It is not: a check can set
  `frame.contentWindow.pageYOffset` (or an element's `scrollTop`) by hand and
  `frame.contentDocument.dispatchEvent({ type: 'scroll', target })`, which runs
  `stageAgentScript`'s own listener for real and produces the real message.
  Everything downstream — the shape check, the body class, the control, the frame's
  height staying put — is then ordinary. `test/check-page-board.mjs` does this.

  Dispatch on the DOCUMENT with an explicit `target`, not on the window: the real
  listener is a capture-phase one on `document` (see the scroller entry below), and
  this stand-in's `dispatchEvent` walks `parentElement` only — it has no capture
  path and no document in the ancestor chain, so nothing propagates to a document
  listener on its own. Driving the listener at its registration point is the honest
  substitute; that a capture listener genuinely sees an inner element's scroll is a
  browser fact, measured separately.

  Related trap in the same file, now fixed: `StandInWindow._setSystemPrefersDark`
  used to update each `MediaQueryList` and fire its `change` inside one loop, so a
  listener on `(prefers-color-scheme: dark)` that read `(prefers-color-scheme: light)`
  saw the OLD value and concluded the opposite theme. A real browser has every query
  consistent before any listener runs. It now updates all of them, then dispatches.

### A sandboxed `srcdoc` frame's own script runs before its first layout — `load` does not help

A variant option's stage self-reports its content height, since the parent cannot reach
`contentDocument` at all to measure it. Reading `document.body.scrollHeight` from
**inside** that frame's own script gives `0` — not only synchronously, but at
`DOMContentLoaded`, at `load`, and inside a zero-delay `setTimeout`. `load` firing early
is the sharpest part: a `srcdoc` document with no external subresource has nothing to
wait for, so `load` measurably fires before the frame has been given a rendering
opportunity at all. Reading the identical property from outside the frame (an
`allow-same-origin` variant, for diagnosis only) reads correctly, so the content does
lay out; the defect is entirely about *when* the frame's own script can observe it.
`reportHeightAfterLayout` (`src/render.mjs`) waits for two nested `requestAnimationFrame`
calls, since an rAF callback runs as part of the same per-frame step that performs
layout, unlike `load`.

The stand-in defines neither `requestAnimationFrame` nor `ResizeObserver`, so a check
driving `reportHeight()` directly against a fixture-declared box stays green whether or
not the deferral exists. The check that pins the fix stubs `requestAnimationFrame`
itself (`withCapturedRAF`, `test/check-pure.mjs`) to CAPTURE callbacks, asserts the
report is not yet applied after `loadSrcdoc()`, then drains the queue and asserts it is —
proving the deferral exists structurally, not that a browser's timing is what the fix
assumes.

Second measurement, worth carrying separately: in an automation-driven tab
`document.visibilityState` is stuck at `'hidden'` (`document.hasFocus()` can be forced
true with a synthetic click; visibility cannot), and in that state neither a bare
`requestAnimationFrame` nor a `ResizeObserver` callback fires at all — not merely late,
even 4s after a forced resize. That matches Chrome's documented background-tab
throttling: a board opened into a background tab will not get an accurate stage height
until the reviewer looks at the tab, and `src/styles.mjs`'s `.choice-variant .html-stage`
starting height (320px, deliberately equal to the fixed floor it replaces) is what they
see until then.

### A `display:none` iframe keeps its inner scroll offset and fires no event on the way back

Rounds are the board's pages and a page that is not current is `display:none`, not
removed — so every round's iframe stays mounted and running the whole time. What
that does to the frame's own scroll position is not guessable, and two independent
passes stalled on it; it took a real-browser probe to settle. Measured in Chrome 152
(Blink), against a probe mirroring `.round` / `.round-current` exactly:

    1 after scrollTo(800), visible: pageYOffset=800  innerH=657 contentH=4000 events=[]
    2 while display:none:           pageYOffset=0    innerH=657 contentH=657  events=[]
    3 after re-show (sync):         pageYOffset=800  innerH=657 contentH=4000 events=[]

Two facts, and the second is the one that bites. The offset is **restored** on
re-show, so the reader comes back exactly where they left the artifact. And **no
`scroll` event fires** anywhere across the whole hide/show cycle, so nothing
re-reports it — and `reportScroll` (`src/render.mjs`) would early-return on an
unchanged `top` even if one did. So anything the parent derived from a scroll report
(`src/ui.mjs`'s `stage-scrolled`, the back-to-top control) has to be **derived from a
remembered value on the way back in**, never cleared on the way out and waited on:
the stage will not speak again. `refreshStageChrome` is that derivation, and
`test/check-round-pager.mjs` drives a flip away and back to pin it.

Gecko/WebKit untested, though Gecko has explicit scroll save/restore across frame
reconstruction. A `visibility`-based hide would not have the problem at all; the code
uses `display`, because the page must not reserve the hidden round's box.

### `cloneNode` in the stand-in never hands back an `IframeElement`

`test/dom-stand-in.mjs`'s `Element.cloneNode` builds `new Element(this.tag)` — attributes
and children are copied faithfully, the CLASS is not. So a clone of an `<iframe>` is a
plain `Element`: no `contentDocument`, no `contentWindow`, no `loadSrcdoc()`, and
therefore nothing a check can run the stage-side agent script inside or forge a message
from. `document.createElement('iframe')` does give you a real `IframeElement`
(`StandInDocument.createElement` special-cases the tag), so page code that mints a frame
at runtime should build it with `createElement` plus explicit `setAttribute` rather than
`cloneNode(false)`. Not a correctness difference in a browser — but it decides whether
the result is testable here: the html-stage lens (`stageLensOpen`, `src/ui.mjs`) mounts
its copy that way, which is what lets `test/check-stage-isolation.mjs` prove a forged
message *from the lens frame* is inert.

### `readyState`'s default is not one fact, it's three, and only one of them should change

`test/dom-stand-in.mjs`'s `StandInDocument` used to hardcode `readyState = 'complete'`
unconditionally, so `src/theme.mjs`'s `themeBootScript` always took the `else { wire(); }`
branch — the one branch a real page (where this script runs inline in `<head>`, before
`<body>` exists) never takes. Fixing the DEFAULT to `'loading'` is one line; the trap is
that `StandInDocument` backs THREE different documents, only one of which should change:

- The outer page (`parseHTML`) — the one that needed the fix. A caller now calls
  `document.finishParsing()` (flips `readyState` to `'complete'`, dispatches a real
  `DOMContentLoaded`) at the point it wants to simulate the parser reaching the end of
  the document.
- The `about:blank` placeholder every `<iframe>` gets the instant it is parsed
  (`aboutBlankDocument`) — genuinely `'complete'` immediately in a real browser, and
  `test/check-click.mjs` already asserted this. Left at the old value by setting it
  explicitly after construction, not by leaving the class default alone.
- An html-stage's real `srcdoc` content once `loadSrcdoc()` "loads" it — nothing reads
  this one's `readyState`, but leaving it `'loading'` forever would be a lie the next
  reader inherits.

Get the split wrong and `test/check-click.mjs`'s about:blank assertion breaks for a
reason unrelated to the fix.

Separately, the real ordering is easy to get backwards: a `<script type="module">`
(`ui`, no `async`) is a DEFERRED script by spec, which runs AFTER parsing finishes but
BEFORE `DOMContentLoaded` fires — so a loader that wants both real scripts to have run
must call `themeBootScript`, then `ui`, then `finishParsing()`, in that order.

### The thing that scrolls a rendered artifact is often not its document

An html stage's own document is frequently *not* what scrolls. A page designed as a
page routinely ships an app-shell layout — a fixed sidebar beside a
`height: 100vh; overflow-y: auto` main pane — and in that shape, measured in Chrome
151:

    window.scrollY          0        <- while the frame visibly shows section three
    #main.scrollTop         700
    scroll events on window 0

So anything that reads the viewport reports `0` forever, anything that writes
`window.scrollTo` is a silent no-op, and a plain `window.addEventListener('scroll')`
never fires at all — an element's scroll event does **not** bubble. All three failed
together in `stageAgentScript`, which is how the page board's header stopped
condensing and its back-to-top control became a button that did nothing.

The fix generalises: let the element identify **itself**. A capture-phase listener
(`document.addEventListener('scroll', fn, true)`) sees both the viewport's own scroll
and any element's, and `ev.target` is the thing that moved; remember it, then read
and write *that*. Correct by construction rather than by scanning for scrollable
boxes, and the ordering is airtight — a control that only appears after a report
cannot be clicked before the target is known.

Two traps inside the fix. `try { el.scrollTo({...}) } catch` is **not** a guard
against this class of bug: a `scrollTo` that silently does nothing never throws, so
the catch never runs — feature-detect, and keep `scrollTop = n` as the floor.
And quirks mode is a red herring here: a srcdoc fragment with no doctype is
`CSS1Compat` anyway (the parser's synthetic wrapper carries one), `scrollingElement`
is `HTML`, and read and write agree fine — the problem was never the mode.

### Driving the real page in real Chrome

**Not every "real browser" is rendering.** A tab driven through the `claude-in-chrome`
extension reports `document.visibilityState === 'hidden'` and `hasFocus() === false`
permanently, and taking a screenshot does not change it. In that state Chrome runs no
rendering updates, so `requestAnimationFrame` never fires (already noted above) **and
neither do `scroll` events** — the offset changes, the event never dispatches — while
`setInterval` is clamped to ~1s. Measured that way, a perfectly working page-board
scroll looked like a total failure: no reports, no condensed header, `scrollTo` an
apparent no-op, and a `setInterval` probe returning values a second stale. Three
consecutive "findings" were all this. **Check `visibilityState` and whether a bare
`requestAnimationFrame` fires before believing any measurement about scrolling,
animation or timing.** `--headless=new` over CDP reports `visible` and does fire both,
which is why the driver below is the one to reach for.

To drive the actual page, Chrome is scriptable over the DevTools protocol with no
dependencies at all — Node 24 has a native `WebSocket`, so `chrome
--headless=new --remote-debugging-port=N` plus `Target.attachToTarget` /
`Input.dispatchMouseEvent` is enough to hover, click and read back the DOM. Keep such
a driver OUT of the repo (it is not part of the zero-dependency check suite); a
throwaway under `/tmp` is the right home. Things that cost time:

- Measure element coordinates in a *separate* eval from the `scrollIntoView` that
  precedes it, with a settle delay between. Measuring across a scroll gives stale
  coordinates and clicks land somewhere unrelated.
- An iframe stage's mock content usually fills only a slice of the frame. Clicking
  the frame's empty area correctly anchors nothing, which reads exactly like a dead
  gesture. Probe several points before believing it.
- `Input.dispatchMouseEvent` with a `mousePressed`/`mouseReleased` pair does produce a
  real `click`, but if the page took a pointer capture in between, the `click` you
  get is not the one you meant — see `setPointerCapture` above.
- This Chrome version's `/json/new` HTTP endpoint rejects a plain `GET` with "Using
  unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb." — a
  200 response carrying an error STRING, not a 4xx, so a caller doing `resp.json()`
  unconditionally gets `SyntaxError: Unexpected token 'U', "Using unsa"...` pointing
  nowhere near the cause. Use `fetch(url, { method: 'PUT' })`.
- A race that depends on "the initial render is still in flight" needs the render to
  actually take measurable time. A warm jsdelivr fetch of mermaid finished 6-10 tiny
  flowcharts in under 100ms total, so a "click again 200ms later" reproduction landed
  AFTER the page had settled every trial and looked like a fixed bug that had never
  been exercised. Sample `document.querySelectorAll('pre.mermaid svg').length` every
  5ms after navigation to confirm the window is wide enough before trusting a "0
  corrupt" result; widening each diagram (more nodes, so dagre's layout actually costs
  milliseconds) is more reliable than guessing at a smaller click interval.

### A harness that imports `src/` serves the code as it was at startup

The throwaway preview server imports `renderBoardPage` once, so `src/ui.mjs`'s
client-script template literal is captured at boot. Editing `src/` and re-running the CDP
driver silently re-tests the OLD page — it cost one agent two rounds of "the fix doesn't
work" against a fix that did. Restart the server after every `src/` edit.

Related: in headless Chrome a `fetch` from a tab that is not the focused one can stay
pending indefinitely. A driver that opens and closes several tabs should run any
fetch-dependent assertion first, or give it its own browser.

### Growing the viewport after load mis-positions anchor pins

`examples/screenshot.mjs` needs a viewport tall enough that no `html`/`mermaid` stage
is off-screen (`captureBeyondViewport` never paints one — see "Real mermaid node ids
are prefixed" and this file's own comments for the general shape). The obvious move is
`Emulation.setDeviceMetricsOverride` to grow the viewport to `document.documentElement.
scrollHeight` AFTER `Page.navigate` and the page has already wired itself up. That
silently mis-places every already-rendered anchor pin: growing the viewport changes
`window.innerHeight` (and, if a scrollbar disappears, the layout width by a few px too),
which fires a real `resize` DOM event, and `src/ui.mjs`'s `window.addEventListener
('resize', ...)` handler calls `refreshPins`, which recomputes every pin's position —
apparently before the resized layout has actually settled, since the result is not a
slightly-off position but a hardcoded `(10, 10)` fallback corner of the pin-layer for
every pin on the page. Measured directly: a mermaid pin anchored to the third node of a
four-node flowchart (`ref: 'Ready'`) reported `left: 433px; top: 32.75px` — dead center
of that exact node — before any resize, and `left: 10px; top: 10px` — the top-left
corner of the *first* node — after one. Visually this reads as "the pin is on the wrong
box," not as an error, so nothing about the symptom points at the resize.

The fix is to never call `setDeviceMetricsOverride` after the page has loaded at all:
set the final width/height/deviceScaleFactor once, BEFORE `Page.navigate`, so the page's
own initial layout and pin-wiring run once, correctly, with no resize event in the
picture. A generous fixed height costs nothing — captured clip regions are cheap
regardless of how tall the viewport nominally is — so `examples/screenshot.mjs`
gives the gallery round 20000, well past what that round needs, and the artifact
page its own 1000, the height a reviewer actually sees a full-frame page at.
Two heights means two full navigations, not one navigation plus a metrics change
partway through; the script reloads for the second shot for exactly that reason.

### Preview harness

There is no dev server for the rendered page. To eyeball UI changes, write a
throwaway script that calls `createBoard` / `addRound` / `renderBoardPage` and dumps
the HTML somewhere, then serve that directory over http — Chrome automation refuses
`file:` URLs. Do not serve out of `/tmp` on this machine: a stray `/tmp/inspect.py`
shadows the stdlib and breaks `python3 -m http.server`.

---

## The check suite's own shapes

### A client script that parses is not a client script that is on the page

`src/indexpage.mjs`'s `indexScript` used to be checked exactly one way: extract the
string, run it through `new Function('document', 'setInterval', indexScript)` against a
minimal stand-in, and confirm it parses and behaves once invoked directly. That proves
the script is valid in isolation — it proves nothing about whether `renderIndexPage` ever
puts it on the page. Deleting `<script type="module">${indexScript}</script>` from
`renderIndexPage`'s returned markup left every check in the file green. Fixed by a second,
separate check asserting the STRING IDENTITY of what `renderIndexPage` embeds against
`indexScript` itself, on top of (not instead of) the in-isolation one.

Worth checking on any file that exports a string meant to be *embedded* somewhere
(`indexScript`, `stageAgentScript()` in `src/render.mjs`, `ui` in `src/ui.mjs`): a check
that the string is well-formed is not a check that the assembly step uses it.

### `test/check-archive.mjs`'s own `loadBoard`/`loadArchive` never run `themeBootScript`

They run exactly one script — `src/ui.mjs`'s `ui` — against the real file bytes. That is
enough for every check that does not depend on `src/theme.mjs` (readonly, pins,
gestures). But `#theme-toggle`'s click handler and the pre-paint `data-theme` attribute
are both wired by `themeBootScript`, not `ui` — a real page runs the boot script first
(inline, pre-`<style>`) and `ui` second (the deferred module script), so a check that only
runs `ui` finds `#theme-toggle` in the markup and not disabled, and nothing happens when
it is clicked, since no listener was ever attached. Proving the theme control works *in
the archive* needs a loader that runs both scripts in that order (`loadArchiveThemed`).

### Finding the real `<style>` tag in rendered bytes

A check that wants to test the cascade against the ACTUAL bytes on disk (not the
in-memory `styles` export) has to locate the real `<style>...</style>` block inside a
fully rendered page first. The obvious `/<style>([\s\S]*?)<\/style>/` is unsafe: both
`src/theme.mjs`'s `themeBootScript` and `src/styles.mjs`'s own `styles` string contain the
literal words `<style>` inside their own comments, and both land, as rendered text,
BEFORE the one true opening tag — while there is exactly one real `</style>` in a page.
So a non-greedy regex from the first match captures the ENTIRE boot script and `ui`
module script as "CSS" (confirmed: ~43KB of client-script text, not ~7KB of real CSS).
`lastIndexOf('<style>', closeIdx)` is not safe either, because `styles`' own comment also
contains the substring, landing between the true opening tag and the close. What works:
locate the structural adjacency `src/render.mjs`/`src/indexpage.mjs` both emit,
`` </script>\n<style> `` — a shape no comment's prose reproduces. See `extractStyleBlock`
in `test/check-archive.mjs`.

### A block-comment stripper needs to know about regex literals, not just strings

`test/check-pure.mjs`'s orphan-class check used to substring-search raw emitter source
*including comments*, so a class named only in a doc comment satisfied it. The fix strips
comments first (`stripJsComments`), but a naive `//`/`/* */` scanner is unsafe here for
two independent reasons. These files ARE the client-script template literals (`ui`,
`stageAgentScript()`, `themeBootScript`) — real code, not comments, so a scanner blind to
string/template-literal boundaries could mistake a comment-shaped sequence inside one of
those strings for an actual comment and eat real code. And separately, `src/markdown.mjs`'s
bold/italic regex (`.replace(/\*\*([^*]+)\*\*/g, ...)`) has a body which, read blind to
regex syntax, contains escaped asterisks immediately followed by the regex's closing
slash: exactly the sequence that closes a block comment. `stripJsComments` tracks
string/template-literal boundaries AND uses the standard "does the previous significant
token complete a value" heuristic to tell a regex literal's opening `/` from division.

### A rendered page contains every comment's text twice, so "it must not render" cannot be grepped

`renderBoardPage` inlines the whole board as JSON in `<script id="board-data">` (that is
what the client hydrates from, and what makes an archive standalone). So the text of a
comment the page deliberately does NOT render is still in the page's bytes —
`pageHtml.includes('...')` is true either way, and an "it must not render" assertion
written that way passes before the change and fails after it, for the wrong reason. Assert
over the parsed DOM instead — `document.querySelectorAll('.comment-item')` and read
`textContent`. Applies to any "the page must not show X" check where X is carried in the
board document: block text, answer choices, notes, block ids.

### A fixture board holding one `html` block and nothing else is a PAGE board

`isPageBoard` (`src/render.mjs`, ADR.md entry 33) infers the page-board layout from the
board's shape, so the most natural "a board with a stage on it" fixture —
`createBoard({ blocks: [{ kind: 'html', html: MOCK }] })` — no longer renders a stage in
a column. It renders the artifact at viewport size with no kicker, and therefore with no
`.comment-btn` and no `.expand-btn` at all (entry 43), and with the send bar hidden.

That is what it looked like when the rule landed: eleven checks across
`test/check-stage-lens.mjs` and `test/check-stage-isolation.mjs` failed at
`document.querySelector('.html-block .expand-btn')` returning null — a null-dereference
in the *setup* of checks about the lens, pointing nowhere near the layout rule that
actually caused it. Any check about a stage's kicker, its lens, or the send bar beside it
needs a SECOND block in the fixture (a one-line `markdown` block is enough) to stay an
ordinary board. Same class of trap as the `check-mcp.mjs` entry below: a fixture's
*shape*, not its content, decides which code path it exercises.

### A `check-mcp.mjs` fixture with no question block no longer blocks on `/wait`

`ask`'s return condition is derived from the round's own blocks (PROTOCOL.md: a round
carrying a question block blocks until submit, a content-only round returns the instant the
post succeeds). So any check meant to exercise `blockingWait` — a timeout path, a
restart-reattach, a cancellation — MUST include at least one `kind: 'question'` block among
what it posts, or the call returns immediately with `status: 'posted'` before ever reaching
`/api/board/:id/wait`. This bit the wall-clock-timeout check directly: it posted
content-only blocks to prove the call still resolves after `CLAUDE_BOARD_TIMEOUT_MS`, and
the assertion on `result.status === 'timeout'` then failed for a reason having nothing to
do with the timeout mechanism. A fixture's *shape*, not just its content, decides which
return path a check exercises.

### Every read is gated, so every HTTP check needs a credential

Since the read gate landed (`SECURITY.md` "Every route requires a credential"), a plain
`fetch('/b/:id')` from a check gets 401. `test/check-http.mjs` and
`test/check-anchor-robustness.mjs` each shadow the global `fetch` at module scope with a
wrapper that adds the secret header, so the hundred-odd requests that are *not* about the
credential keep reading as they did. If you add a check that stands up a daemon, do the
same — or send `x-claude-board-secret` by hand.

Anything that deliberately speaks as an unauthorized caller must NOT go through that
wrapper: use `rawRequest`/`rawGet`, or `rawFetch`, which send exactly the headers they
are given. Raw `http.request` calls (SSE streams, the hang-up-mid-wait check) need the
header spelled out; there is no wrapper for them.

### `execFileSync` deadlocks against an in-process daemon

Several checks start the daemon with `startServer` inside the check's own process. A
synchronous spawn (`execFileSync`, `spawnSync`) that talks to that daemon blocks the
event loop the daemon needs to answer, so the child times out and the check fails with
"daemon is not reachable" — a message that names the wrong problem entirely. Use
`promisify(execFile)` and `await` it. `test/check-install.mjs` gets away with
`spawnSync` because its daemon is a separate process.

### `writeDoc` defaults to the REAL board home, so a check that calls it without one clobbers the reader's pomodoro state

`writeDoc(doc, home = boardHome())` (`src/pomodoro.mjs`). The second parameter is where the
whole safety of that function lives in a test: every check in `test/check-notify.mjs` that
uses it passes a `mkdtempSync` directory, and one that forgets writes straight into
`~/Library/Application Support/claude-board/pomodoro.json`, i.e. the reader's own settings
and whatever timer they had running.

It fails silently in both directions. Pass the wrong SHAPE too (a bare settings object
instead of `{ settings, cycle, cycleDate, timer }`, an easy slip since `DEFAULT_SETTINGS`
is exported right beside `writeDoc`) and nothing throws: the file is written, `readDoc`
cannot find a `settings` key, its normalise path hands back `defaultDoc()`, and the daemon
carries on looking healthy while every setting the reader chose is gone.

Two habits, either of which is enough: give every `writeDoc` in a check an explicit temp
`home`, and assert against `readDoc(home)` rather than trusting the write. If a check does
not need daemon state at all, prefer asserting the property structurally —
`notifyTest.length === 0` says "reads no settings" more directly than seeding a document
to prove it ignores one.

### A mutation helper that restores with `git checkout` eats uncommitted work

Ablation testing means mutate, run, restore — and the obvious restore is
`git checkout -- <files>`. That silently discards *any* uncommitted change to those
files, including the very edits under test. The failure is quiet and reads like a
result: the first mutation reports its expected failure, and every mutation after it
reports **nothing**, because the check file holding the new assertions was reverted
along with the source. "No output" looks like "no finding" rather than like "the
checks are gone".

Commit before mutating. Then `git checkout` restores to a tree that still contains
the work, and the helper is safe to loop. If the work genuinely cannot be committed
yet, copy the files aside and restore from the copies — never from git. Cheap tell
that this has happened: the ablations after the first all come back clean. Real
ablations rarely do.

### A block's id is kind-locked, permanently

`src/board.mjs`'s `resolveBlockId` rejects any incoming block whose `kind` doesn't
match its `id`'s own kind-letter prefix (`{id:'h1', kind:'markdown', ...}` throws
"does not start with the 'h' letter"), on every `normalizeBlock` path `amendRound`
uses. So "replace this block with a different kind at the same id" is NOT
constructible through `amendRound`/`addRound` at all — a block's kind is fixed
forever once minted. If a fixture needs that shape anyway (e.g. testing a
resolver's own defensive guard against it), splice a properly-normalised block
from a throwaway `createBoard` directly into `board.blocks[i]`, id overwritten by
hand — don't fight `amendRound` for it, it will always throw.

### A machine-identity sweep cannot be `includes(os.hostname())`

The obvious way to check a committed artifact for leaked machine identity is
`committedText.includes(os.hostname())`. It fails in both directions at once, and
`test/check-sample-board.mjs` was written that way first before both showed up.

False positives: a short hostname is an ordinary word. On a machine whose hostname
is the macOS default (three characters, vendor-shaped), an html-stage mock's CSS
font stack — `-apple-system, BlinkMacSystemFont, ...` — trips the sweep for
reasons unconnected to machine identity.

False negatives, the worse half: the check only ever runs where the identity it
looks for is the identity present. On CI the account is `runner` and the hostname
is the runner's, so an artifact carrying the author's name sails past — and
`os.hostname()` returns the fully-qualified `.local` form, which does not match
the bare ComputerName that a leak would actually carry.

So the sweep matches *shapes* instead (`test/check-sample-board.mjs`,
`IDENTITY_PATTERNS`): home-directory paths, `$HOME`, `/var/folders`, email
addresses, `.local` hostnames. Those are machine-independent, so the check means
the same thing on every machine, and the `.local` pattern catches any host's
hostname rather than only the one it is running on. The residual gap is a
hand-typed literal name in a fixture, and the byte-identity check next to it is
the real backstop for anything machine-derived: content that varies by machine
cannot survive a regeneration comparison anywhere but the machine that made it.

---

## launchd, TCC and the app bundle

### `WatchPaths` cannot restart a `KeepAlive` job, and nothing restarts this daemon on a source change

`WatchPaths` tells launchd to *start* a job when a watched path changes; a job already
running — which `KeepAlive` guarantees — is simply not started again. Measured: 3h40m of
uptime across an in-place edit to `src/store.mjs`, and neither creating nor deleting a file
under `src/` moved the pid. `test/check-install.mjs` asserted the plist *contained* the
`WatchPaths` entries, which was true and beside the point — a green check sitting on a dead
mechanism.

Its replacement (the daemon watching its own `src/` and exiting on a change) is gone too: a
save mid-review dropped every open event stream and held-open wait, editor temp files
tripped it, launchd's 10s restart throttle turned a burst of writes into an outage, and a
half-written edit took the daemon down for real. `CLAUDE_BOARD_RELOAD_ON_CHANGE` is read
nowhere now — `test/check-install.mjs` sets it and asserts the daemon survives an edit.
`./install.sh` is what takes a code change.

### macOS TCC gates the daemon by *application*, and launchd's application is not yours

A LaunchAgent gets no folder access by inheritance the way a process started from
Terminal does. If the plist runs `/opt/homebrew/bin/node bin/daemon.mjs`, then the
application macOS is deciding about is **node**, and every read under `~/Documents`,
`~/Desktop` or `~/Downloads` comes back **EPERM** — which surfaces on the board as
`cannot read <path>: EPERM` and looks exactly like a missing file. A clone that lives in
one of those three folders cannot even start: `bin/daemon.mjs` is itself a gated read.

Two traps inside the trap:

- **Granting node is not a fix.** It is a grant to every node program on the machine,
  and homebrew's node is ad-hoc signed under a versioned Cellar path, so `brew upgrade
  node` silently revokes it. Hence `bin/launcher.c` and the app bundle: TCC gets an
  application of ours to decide about, and the user grants that one folder to that one
  thing. The launcher must **fork** node, never `exec` it — TCC decides against the
  *responsible process*, a child inherits its parent's, and an exec would replace this
  identity with node's in the same pid and undo the entire arrangement.
- **The grant is pinned to the code signature.** Rebuild the bundle and the user is
  silently locked out again, with no error but the same EPERM. `install.sh` therefore
  stamps the inputs (`~/.config/claude-board/launcher.stamp`) and skips the rebuild when
  nothing that decides the bundle's bytes has changed — a routine `git pull &&
  ./install.sh` must not cost someone their grant. This is also why the bundle's
  `CFBundleVersion` is a fixed `1` rather than `package.json`'s version.

Diagnosing it: run the read from a throwaway LaunchAgent rather than from your shell.
The same node, the same flags and the same file behave differently under launchd than
under Terminal, and testing from the shell will tell you everything is fine.

`readdir` on `~/Library/Application Support/com.apple.TCC` is a cheap probe for whether
a process holds Full Disk Access — it is FDA-only, so EPERM there alongside a successful
read of `~/Documents` means the narrow folder grant is present and FDA is not.

### A missing launcher bundle wedges launchd at `exit 78` and `kickstart` cannot fix it

The LaunchAgent's `ProgramArguments` is a single path into a bundle the installer
compiles: `~/Applications/claude-board.app/Contents/MacOS/claude-board`. If the plist
exists but that bundle does not, launchd cannot exec anything and parks the job:

    state = spawn scheduled
    runs = 3
    last exit code = 78: EX_CONFIG

The cause, once: **running the check suite deleted it.** `test/check-install.mjs`
redirects everything install.sh/uninstall.sh touch into a temp dir through seam env vars,
and one env object was missing `CLAUDE_BOARD_APP_DIR`. `uninstall.sh` fell back to its
default, `$HOME/Applications`, and `rm -rf`'d the developer's own launcher bundle, killing
their daemon and the TCC grant pinned to that bundle's signature. The suite reported all
green. Fixed by adding the seam, plus a final check that asserts the real
`~/Applications/claude-board.app`, `~/Library/LaunchAgents/claude-board.plist` and
`~/.config/claude-board/secret` are exactly as they were before the suite ran — a guard on
the paths rather than on any one env object.

`EX_CONFIG` here is launchd's, not the daemon's. Do not go looking for it in
`bin/daemon.mjs`: that file never exits 78, and grepping for it wastes a pass. The
daemon's own logs are no help either — the last lines in
`~/Library/Logs/claude-board/daemon.err.log` will be an ordinary clean shutdown from
whenever it last ran successfully, which reads like a healthy service and is not.

`launchctl kickstart -k gui/$(id -u)/claude-board` does **not** revive it, and worse, it
blocks: it waits for a service that will never come up, so it looks like a hang. `runs`
does not increment. The fix is to re-run `./install.sh`, which rebuilds and ad-hoc signs
the bundle.

Diagnosing it takes three commands, in this order — the third is the one that actually
names the fault, and the first two only tell you something is wrong:

    curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7391/   # 000 = nothing listening
    launchctl print gui/$(id -u)/claude-board | grep -E "^\tstate|last exit|runs ="
    ls -la "$(launchctl print gui/$(id -u)/claude-board | grep -A2 'arguments = {' | tail -1 | xargs)"

Read the program path out of `launchctl print` rather than assuming it — the plist is
rewritten on every install and pointing at a stale path is the same failure with a
different cause.

Page-side, this presents as a bare **`Error: Failed to fetch`** in the board tab and as
an `ask` call that posts nothing. There is no clue in either that the problem is a
LaunchAgent, so treat "Failed to fetch" from a board as "check the daemon is running"
before anything else.

### A bare `kickstart` no longer picks up a source edit — only `./install.sh` does

`bin/daemon.mjs` used to run straight out of the clone, so a plain `launchctl kickstart -k
gui/$(id -u)/claude-board` was enough to pick up an edit. That stopped being true the
moment `install.sh` started staging a COPY of `bin/daemon.mjs` and all of `src/` into
`claude-board.app/Contents/Resources` and pointing the launcher at the copy (SECURITY.md
"the daemon's own code is now inside the signed bundle", ADR.md entry 15). A kickstart now
restarts the same already-built binary, which forks the same already-staged copy — an edit
to the clone underneath it changes nothing until `./install.sh` runs again, notices the
payload digest moved, rebuilds and re-signs the bundle.

The trap: the daemon still visibly restarts on a kickstart — same pid churn, same log
lines, same "daemon listening on 127.0.0.1:7391" — so nothing about the symptom says "you
are looking at old code." Compare behaviour against the file you just edited, not against
whether the process bounced. If you are iterating on `src/` or `bin/daemon.mjs`, the loop
is `./install.sh`, every time. (The degraded, no-launcher path is the one exception:
there, `bin/daemon.mjs` still runs straight out of the clone and a kickstart alone is
enough.) `test/check-install-payload.mjs` pins this directly: it edits a throwaway clone's
`src/server.mjs`, runs the ALREADY-BUILT launcher and asserts the old code is what answers,
then reinstalls and asserts the edit only takes effect after that.

### A carried-forward `ref_roots` record widens itself back to today's defaults on every install

`GET /file/<path>` and its separate `CLAUDE_BOARD_SERVE_ROOTS` allowlist are gone (ADR.md
entry 38) — a rendered artifact now only ever reaches a reviewer through a block reference,
`{ kind: 'html', source: { path } }`, resolved against `CLAUDE_BOARD_REF_ROOTS`
(`src/resolve.mjs`). That used to have a companion trap worth knowing about even though its
cause is gone: `~/Documents/renders` joined `DEFAULT_REF_ROOTS` after some installs already
existed, and a carried-forward record predating it stayed short of that default forever,
silently, on every later `git pull && ./install.sh` — referencing a rendered file produced
an empty option card (`resolvePath` refuses an absolute path outside every root and
resolves a relative one against the board's `cwd` only) with nothing to say why.

Fixed by ADR.md entry 36: `install.sh` now checks a carried-forward record against
`DEFAULT_REF_ROOTS` on every run and adds back whatever current default the record is
missing, printing the line naming what it widened. The trap this creates in its place —
worth knowing before relying on the old behaviour — is that narrowing the allowlist with
`CLAUDE_BOARD_REF_ROOTS= ./install.sh` is no longer a permanent choice: it survives for any
directory the *current* defaults do not name, but the next plain upgrade re-adds every
directory that IS a current default regardless. A genuinely narrow list has to be
reasserted with the explicit env var on every run that might otherwise widen it.

If a reference still 404s or comes back as an empty "Could not resolve" card, read the
posted board's own JSON (`~/Library/Application Support/claude-board/boards/<id>.json`)
after the round that carried it — the `error: cannot read <name>: no such file` field is
there, and it is the only place it is. Check the launcher's real environment before
assuming a root exists — the plist carries only `CLAUDE_BOARD_PORT`, so `strings` on the
binary named in `ProgramArguments.0` is what actually answers it (ADR.md entry 13).

---

## macOS notifications and sound

### The board's notification works; macOS Focus is what hides it

`notifyRound` (`src/ui.mjs`) fires on an SSE round push into a hidden or unfocused
tab. When a reviewer reports it "never fires", check the OS before the code — Chrome keeps
the receipts and they settle it in one read:

    ~/Library/Application Support/Google/Chrome/Default/Preferences

`profile.content_settings.exceptions.notifications` holds the grant per origin
(`"setting": 1` is allow), and `notification_interactions` holds a per-day
`display_count`. A nonzero `display_count` with no interactions means Chrome displayed the
notification and the reviewer never saw it — which is Focus, not JavaScript.

Focus config lives in `~/Library/DoNotDisturb/DB/`: `ModeConfigurations.json` for the
schedules, `ModeConfigurationsSecure.json` for the per-mode allow-list, and
`Assertions.json` for whether a mode is active *right now* (empty file = none active). A
mode in allow-list mode that does not list Google Chrome routes every board notification
straight to Notification Center with no banner and no sound.

Two things that will mislead you while chasing this:

- Permission is **per origin**. `http://127.0.0.1:7391`, `http://localhost:7391` and
  `http://board.localhost:7391` are three separate grants, and the daemon reflects the
  `Host` header into the board URL, so which one you get depends on how the tab was
  opened. It is also **per Chrome profile** — a grant on `Default` does nothing for
  `Profile 1`.
- `notifyRound` requests permission from the hidden/unfocused branch, the one moment
  Chrome will not raise a foreground prompt; Chrome queues it until the tab is next shown.
  A reviewer who dismisses that queued prompt is stuck at `default`.

Verifying it end to end takes a hidden tab: post a second round to an existing board while
the reviewer is in another app. A round pushed into a visible, focused tab correctly
notifies nothing, so testing with the board in front of you proves the wrong thing.

### A bundle's notification identity belongs to `CFBundleExecutable`, and to nothing else in it

`UNUserNotificationCenter` will not post from a binary that is not the bundle's own
`CFBundleExecutable` — not even one sitting inside `Contents/MacOS` of the same correctly
signed, correctly registered bundle. It fails at `requestAuthorizationWithOptions:` with
`Notifications are not allowed for this application`, no prompt, no row in System Settings,
nothing to indicate the problem is *which* binary rather than the bundle.

Measured on macOS 26.5 (ad-hoc signed bundle in `~/Applications`): the same compiled binary
posts fine as `Contents/MacOS/<CFBundleExecutable>` and is refused as
`Contents/MacOS/helper`, with only the filename changed between the two runs.

This is why the pomodoro notification is a `--notify` mode of `bin/launcher.c` rather than a
notifier binary next to it (ADR.md entry 19), and why "just add a small helper to the bundle"
is not available as a shape for anything else that needs to post. A second *bundle* works —
it has its own `CFBundleExecutable` — at the cost of a second everything else.

### A freshly installed app bundle cannot post a notification until LaunchServices knows about it

A bundle can be at `~/Applications/foo.app`, correctly signed, runnable, with a valid
`CFBundleIdentifier`, and still be refused with `Notifications are not allowed for this
application` — the identical error to the `CFBundleExecutable` trap above, from a completely
different cause. LaunchServices has not registered it yet. Its own scan of `~/Applications`
gets there eventually; "eventually" is not a thing the first pomodoro boundary after an
install can wait for.

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ~/Applications/claude-board.app
```

`install.sh` runs exactly that, guarded by `[ -x ]` because the path is private, before it
asks for authorization. **Order matters:** register first, then request. A request that
reaches a not-yet-registered bundle does not queue, retry or prompt later — and on the
install where this was found, it left the bundle recorded as *denied*
(`authorizationStatus == 1`), which no amount of re-running fixes, because macOS prompts once
per bundle identifier and then answers from its own record. The only way out is
System Settings > Notifications > claude-board.

Debugging this at all needs `getNotificationSettingsWithCompletionHandler:`, since
`requestAuthorization` reports "denied by the user long ago" and "you are not a registered
app" with the same string. A throwaway bundle carrying the same `CFBundleIdentifier` as the
one under test reads the real status without disturbing it.

### `soundNamed:` searches `/System/Library/Sounds` and does NOT search the app bundle — the documented search path is backwards

Apple documents the opposite. Measured on macOS 26.5 (25F84): a bare name resolves
against `/System/Library/Sounds`, a file existing only in the posting bundle does not
resolve at all, and on a collision the stock sound beats a `~/Library/Sounds` copy. So
staging sounds into the bundle does not work, and a reader-supplied sound is reachable
only under a name no stock sound uses. The extension is optional; an unresolvable name is
**silence**, not a default. Encoded in `src/cues.mjs`'s `SOUNDS_DIRS` order, so the
preview resolves to the same file the notification plays.

---

## Shell, C and the filesystem

### An apostrophe inside `${VAR:-...}` swallows the rest of a bash script

`echo "roots: ${REF_ROOTS:-(none — inside a board's project directory only)}"` is a
syntax accident, not a string: inside `${par:-word}` bash treats `'` as a quote character
even though the whole expansion is already inside double quotes. Everything up to the
next apostrophe — comments included, across any number of lines — becomes part of that
string. The symptom in `install.sh` was a chunk of comment block printed to stdout and
`xml_escape: command not found` forty lines later, neither of which points anywhere near
the real line. `bash -n` does **not** catch it (the file still parses). Write the branch
out with a plain `if` instead of reaching for a `:-` default.

### Sizing a C array from `sizeof(arr)/sizeof(arr[0])` held in `static const int` is a VLA

`bin/launcher.c` builds the child's `envp` from two tables, and the natural way to size it is
`char *envp[OVERRIDE_ENV_N + PASSTHROUGH_N + 1]` where `OVERRIDE_ENV_N` is
`(int)(sizeof(OVERRIDE_ENV) / sizeof(OVERRIDE_ENV[0]))`. If that division lives in a
`static const int`, clang accepts it but warns: `variable length array folded to constant
array as an extension [-Wgnu-folding-constant]`. A `const int` is not a compile-time constant
expression to a strict C compiler even when its initializer plainly is one, so using it to
size an array makes that array a VLA — silently accepted as a GNU/Clang extension, but a
warning `install.sh`'s `-Wall` build would carry forever. Fix: an
`enum { OVERRIDE_ENV_N = (int)(sizeof(...)/sizeof(...[0])) };` — an enum constant IS a real
compile-time constant, same value, zero warning. Only matters when the count sizes something;
a plain loop bound never triggers it.

### `DYLD_INSERT_LIBRARIES` (and friends) act on the process being loaded, not on what that process execs

Testing that `bin/launcher.c`'s execve-built environment drops `DYLD_INSERT_LIBRARIES`
before handing it to node, the obvious move is to spawn the compiled launcher with
`DYLD_INSERT_LIBRARIES=/tmp/does-not-exist.dylib` in its OWN environment. That crashes the
launcher itself, before a single line of `main()` runs:

    dyld[...]: terminating because inserted dylib '/tmp/does-not-exist.dylib' could not be
    loaded: tried: ... (no such file) ...

`DYLD_*` variables are read by `dyld` while loading whatever process they are set on. For
the test: point `DYLD_INSERT_LIBRARIES` at a dylib that exists and is harmless to load
(`/usr/lib/libgmalloc.dylib`) so dyld succeeds and the test is about `launcher.c`'s
filtering, not about dyld's refusal of a bad path.

The same fact is a gap in the real deployment: an attacker plist setting
`DYLD_INSERT_LIBRARIES` on the launcher itself would be honoured by dyld before `main()`
could build the filtered `envp`. Closing that means hardened-runtime signing, with its own
TCC consequences. The fix here is scoped to what the launcher hands node, not to what
launchd hands the launcher.

### Two open flags macOS will not accept together

`src/resolve.mjs` opens every reference with `O_NOFOLLOW_ANY` — Apple's "refuse if ANY
component is a symlink", `0x20000000` in `<sys/fcntl.h>`, which Node does not export.

- **`O_NOFOLLOW | O_NOFOLLOW_ANY` is `EINVAL`**, on every path including an ordinary
  regular file. They are alternatives, not belt and braces; passing both fails every
  open with an errno that says nothing about symlinks.
- Because the number is hardcoded, a check has to prove it still *does* something —
  `test/check-pure.mjs` swaps a directory component for a symlink between the check and
  the read and asserts the open is refused. Without that, a wrong or retired constant
  degrades silently into no protection at all.

`O_NONBLOCK` belongs in the same flag set for a different reason: `open` on a fifo with
no writer blocks forever, so without it the fifo guard never gets to run.

**A strong outer guard hides a weak inner one from your checks.** Both symlink-swap
checks were written first, and both are refused by `O_NOFOLLOW_ANY` at `openSync` — so
reverting `readFileSync(fd)` to `readFileSync(abs)`, and `fstatSync(fd)` to
`statSync(abs)`, left the whole suite green. The flag was masking the descriptor
entirely. Two guards that stop the same demo can defend quite different attacks (the
flag stops a symlink; only the descriptor stops `rename()`ing a plain regular file over
the name), and a check built on the demo pins whichever one runs first. If two mechanisms
are meant to be independent, each needs an attack the other cannot stop: here, a swap to
a regular file for the read, and a swap to a directory or an oversized file for the
guards.

### A temp dir's spelling is not its realpath, and path confinement compares realpaths

`mkdtempSync(path.join(tmpdir(), …))` hands back `/var/folders/…` on macOS, but `/var`
is a symlink to `/private/var`, so the same directory has two absolute spellings and
only one of them survives `realpathSync`. Anything in `src/resolve.mjs` that decides
containment compares canonical paths, so a check that builds a fixture root out of
`tmpdir()` and passes the *returned* path as an allowlisted root confines against
`/private/var/…` while the reference it then resolves is spelled `/var/…` — a
legitimate path refused, for a reason that has nothing to do with the code under test.
`realpathSync` the fixture root (and the file, when asserting the resolved path) before
using either in an assertion. The same trap is live outside the checks: a home
directory on an external volume is symlinked the same way, which is why the "does this
absolute path even name a place inside a root" test in `resolvePath` is decided on the
parent directory's realpath rather than on the path's spelling.

And realpath is not enough on its own for `$HOME`. It does **not** correct case on a
case-insensitive volume (`/users/you` canonicalises to itself), and APFS firmlinks give
`/System/Volumes/Data/Users/you` as a second, equally canonical path to the same
directory — so `realpathSync(a) === realpathSync(b)` is false for two names of one
directory, routinely, on a stock Mac. `src/resolve.mjs` compares `dev`+`ino` instead
(`isHomeOrAbove`), and keeps the string test only as a fast path. If you are writing any
"is this the same directory" test on this OS, assume the string answer is wrong.
