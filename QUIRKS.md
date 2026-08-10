# QUIRKS

Tooling traps in this repo. Read before fighting something; append when something fights you.

- [The rendered page: stylesheets and client-script literals](#the-rendered-page-stylesheets-and-client-script-literals)
- [The DOM stand-in's ceilings, and what needs a real browser](#the-dom-stand-ins-ceilings-and-what-needs-a-real-browser)
- [The check suite's own shapes](#the-check-suites-own-shapes)
- [launchd, TCC and the app bundle](#launchd-tcc-and-the-app-bundle)
- [macOS notifications and sound](#macos-notifications-and-sound)
- [Shell, C and the filesystem](#shell-c-and-the-filesystem)
- [Worktrees, the shared checkout, and two files with the same tail](#worktrees-the-shared-checkout-and-two-files-with-the-same-tail)
- [Vendoring a CJS-shaped npm package under `"type": "module"`](#vendoring-a-cjs-shaped-npm-package-under-type-module)
- [Shapes the page-board stage is pinned to](#shapes-the-page-board-stage-is-pinned-to)

---

## The rendered page: stylesheets and client-script literals

- [The stylesheet and the markup are checked against each other](#the-stylesheet-and-the-markup-are-checked-against-each-other)
- [No external assets, ever](#no-external-assets-ever)
- [Two stylesheets, one palette](#two-stylesheets-one-palette)
- [A diagram lens holds a clone, and a theme change replaces what it cloned](#a-diagram-lens-holds-a-clone-and-a-theme-change-replaces-what-it-cloned)
- [A CSS *comment* is shipped on the index page too, and one check reads its words](#a-css-comment-is-shipped-on-the-index-page-too-and-one-check-reads-its-words)
- [A backtick inside a template-literal payload ends the whole file](#a-backtick-inside-a-template-literal-payload-ends-the-whole-file)
- [Readonly is locked twice — CSS and JS — and reusing chrome inherits both](#readonly-is-locked-twice--css-and-js--and-reusing-chrome-inherits-both)
- [`100vw` is wider than the page whenever the page actually scrolls](#100vw-is-wider-than-the-page-whenever-the-page-actually-scrolls)

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

Asserting a rule by its text is itself a trap: it can match a rule that selects
nothing any browser ever renders (see "Real mermaid node ids are prefixed"). The two
mermaid rules are built from `MERMAID_NODE_SELECTOR` (`src/anchor.mjs`) and checked
by asking whether they would select a REAL node id, not by matching their spelling —
prefer that shape for any new rule whose whole job is to select something.

### No external assets — except two bare sibling filenames

`renderBoardPage` output must open from Finder with the network off. So: no web fonts
(system stack only), no icon fonts, no CDN CSS. Icons are inline SVG. Mermaid is the
one exception — imported at runtime from a CDN, degrading to raw source when it cannot
be reached.

This used to read "no external assets, ever", and the page test rejected any `<link
rel=stylesheet>` or `<script src=>` outright. ADR 70 supersedes that: the client script
and the stylesheet are now referenced, not inlined, because 438KB of byte-identical
payload per board was 16MB of an 18MB `pages/`. The rule that replaces it is narrower
and stricter, and `test/check-pure.mjs` now enforces exactly it:

- The reference is a **bare sibling filename** — `href="styles-<hash>.css"`. An absolute
  path, a URL, a protocol-relative `//host/...` and a subdirectory must all still fail.
  That one form is the only one that resolves identically served (`/b/<name>`, the
  daemon's single static route) and opened in Finder (the file next to the page).
- The name is **content-addressed** and the file is **never rewritten or overwritten**,
  so a page keeps loading the exact bytes it was written against forever. A payload
  change mints a new name and leaves the old file alone.
- The script tag is a **deferred classic script**, never `type="module"`: Chrome
  CORS-blocks module scripts over `file:`, so a module reference silently breaks the
  Finder surface. `defer` is what preserves a module tag's execution timing.

The cost, accepted in ADR 70: an archive is a file plus its folder, not one mailable
file. `examples/sample-board.html` is committed with its two siblings for that reason.

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

The stage is the only thing that has ever needed this. The self-contained 401
refusal page is a separate case — "cannot link the stylesheet" is not "cannot read
the palette" — and emits both token blocks from `palettes` at render time, painting
through `var()` instead.

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

Two more literals have the same trap without carrying a client script:
`src/indexpage.mjs`'s `indexScript` (its own header comment states the ban) and
`src/pomodoro-widget.mjs`'s `pomodoroWidget()` return, which is HTML — so the comments
that break it are `<!-- ... -->` ones, where a backticked identifier reads as perfectly
ordinary prose. That one surfaces like `styles` does: the outer module fails to parse and
`node --check src/pomodoro-widget.mjs` names the line (reproduced, 2026-08-10). Write the
identifier bare, or in single quotes.

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

### `100vw` is wider than the page whenever the page actually scrolls

The classic full-bleed-inside-a-centred-column trick (`left: 50%; transform:
translateX(-50%); width: 100vw`) breaks the instant the page it's on has a real
vertical scrollbar: `vw` units are defined against the viewport's full width,
scrollbar included, while the space a scrollbar-bearing page actually has to paint
into is narrower by however wide that scrollbar is. A box sized in `vw` therefore
overflows the true content width by the scrollbar's own width — on a page that had
no horizontal scrollbar before, this trick is what gives it one.

It presented extending `body.page-board`'s full-bleed header wash (`src/styles.mjs`,
`body.page-board .board-head::after`, `inset: 0`) to an ORDINARY board's sticky
header, which sits inside a centred 1120px column rather than covering the whole
viewport — a live bug there, since it is the document itself that scrolls.
`test/dom-stand-in.mjs` cannot catch it at all: it has no layout, so no scrollbar,
so no width to overflow, which is why the whole suite stayed green while a real
Chrome, scrolled far enough for a real scrollbar to appear, showed the seam.

Use `document.documentElement.clientWidth` instead, which excludes the scrollbar by
definition: write it to a custom property (`--doc-w`, `measureDocWidth`,
`src/ui.mjs`) and use THAT in place of `100vw` (the re-measure trigger and its
cosmetic-gap tradeoff are commented at the call site). Verify anything using this
trick in a real browser, on a page long enough to actually need a scrollbar — the
one case that matters is also the one no automated check here can produce.

---

## The DOM stand-in's ceilings, and what needs a real browser

- [`ResizeObserver` does not necessarily deliver an initial observation](#resizeobserver-does-not-necessarily-deliver-an-initial-observation)
- [Real mermaid node ids are prefixed, and `^=` will not see them](#real-mermaid-node-ids-are-prefixed-and--will-not-see-them)
- [`setPointerCapture` on pointerdown steals the click from what you clicked](#setpointercapture-on-pointerdown-steals-the-click-from-what-you-clicked)
- [The stand-in has no layout: no `IntersectionObserver`](#the-stand-in-has-no-layout-no-intersectionobserver)
- [`.code-row` is an inline box, and `display: block` double-spaces the copy](#code-row-is-an-inline-box-and-display-block-double-spaces-the-copy)
- [CSS `anchor()` needs its anchor earlier in the DOM, and failure computes `bottom: auto`](#css-anchor-needs-its-anchor-earlier-in-the-dom-and-failure-computes-bottom-auto)
- [The cascade resolver cannot see an interaction pseudo-class](#the-cascade-resolver-cannot-see-an-interaction-pseudo-class)
- [`scrollHeight` and `clientHeight` model exactly one fact](#scrollheight-and-clientheight-model-exactly-one-fact)
- [Nothing scrolls, but a `scroll` listener can still be driven](#nothing-scrolls-but-a-scroll-listener-can-still-be-driven)
- [A sandboxed `srcdoc` frame's own script runs before its first layout — `load` does not help](#a-sandboxed-srcdoc-frames-own-script-runs-before-its-first-layout--load-does-not-help)
- [A `display:none` iframe keeps its inner scroll offset and fires no event on the way back](#a-displaynone-iframe-keeps-its-inner-scroll-offset-and-fires-no-event-on-the-way-back)
- [`cloneNode` in the stand-in never hands back an `IframeElement`](#clonenode-in-the-stand-in-never-hands-back-an-iframeelement)
- [`readyState`'s default is not one fact, it's three, and only one of them should change](#readystates-default-is-not-one-fact-its-three-and-only-one-of-them-should-change)
- [The thing that scrolls a rendered artifact is often not its document](#the-thing-that-scrolls-a-rendered-artifact-is-often-not-its-document)
- [Driving the real page in real Chrome](#driving-the-real-page-in-real-chrome)
- [The `claude-in-chrome` extension's own coordinate system, and its window resize](#the-claude-in-chrome-extensions-own-coordinate-system-and-its-window-resize)
- [A harness that imports `src/` serves the code as it was at startup](#a-harness-that-imports-src-serves-the-code-as-it-was-at-startup)
- [Growing the viewport after load mis-positions anchor pins](#growing-the-viewport-after-load-mis-positions-anchor-pins)
- [Preview harness](#preview-harness)

### `ResizeObserver` does not necessarily deliver an initial observation

The spec has `observe()` queue a first record, and nearly every write-up says so, so
"observe it and let the first delivery be the initial measurement" reads like the tidy
version. Measured in Chrome 152 against `.board-head-actions`, an element already laid
out at page load and never resized again: the callback fired **zero** times. The pill's
`--pill-half` (ADR entry 40's amended condense) was therefore never written for the
whole session, and the header sat at the stylesheet's rough default with nothing on the
console to say why.

Call the measurement yourself, then observe for later changes. The explicit call costs
one line; relying on the initial delivery costs a silent wrong value on first paint,
which is exactly the state a reader spends most of their time in.

The stand-in cannot catch this class at all: it has no box model and no
`getComputedStyle`, so any layout measurement is browser-only by construction. Anything
in `src/ui.mjs` that measures is written to feature-detect and return early, which is
what keeps the checks green while leaving the real answer to a real browser.

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

### The stand-in has no layout: no `IntersectionObserver`

`test/dom-stand-in.mjs` never defines `IntersectionObserver` at all, so any code built
on one runs under no check unless a check drives it by hand.

It presents as silence, not failure: every construction site (`setupSendBarDock`,
`src/ui.mjs`) guards on `typeof IntersectionObserver !== 'function'` and returns
immediately when it's missing — which keeps the stand-in from throwing, but also means
anything decided *inside* the callback is untested by default.

Prefer explicit state over measured position for anything that has to be checkable
here — rounds are pages now (ADR 42), decided by one class and one variable rather
than an observed scroll position, which is what lets `test/check-round-pager.mjs`
assert directly. When an observer is unavoidable, install `StandInIntersectionObserver`
and fire its callback yourself, in both directions.

### `.code-row` is an inline box, and `display: block` double-spaces the copy

A gutter-numbered code block joins its rows on the newline bytes already in the
text, under `white-space: pre` -- each of those newlines is a real line break in
its own right. Make the row `display: block` as well (the road taken by an
absolutely positioned gutter, which needs the row as its containing block) and
every line breaks twice: the row's own block break, plus the newline between two
rows forming an anonymous block. Measured in Chrome against
`examples/sample-board.html`: a 19.38px row box on a 41.77px row-to-row delta,
and a selection read back over a five-line block returning 8 newlines for the 4
in its text. Every gutter-numbered block rendered and copied double-spaced alike.

The suite cannot see it: the copy promise is about what the browser's selection
yields, and the checks assert `textContent` -- a different string, correct
throughout. Keep the row inline, keep exactly one line-break mechanism, and
reserve the gutter with an in-flow `inline-block` `::before`; the full trade-off
is written above the `.code-row` rules in `src/styles.mjs`.

### CSS `anchor()` needs its anchor earlier in the DOM, and failure computes `bottom: auto`

`anchor()` positioning requires the anchor to precede the positioned element in
DOM order. The round pager's dock renders after `.blocks`, and the floating
comment panel is nested inside a block within `.blocks`, so the panel can never
anchor to the dock -- and with that worked around it still failed on a separate
containing-block requirement, the computed value quietly falling back to
`bottom: auto`. Confirmed in a real browser; the stand-in has no layout, so
every check stays green while the panel sits in the wrong place.

The shape that survives is the `ResizeObserver` entry above, applied: measure
the dock's real box yourself, write it to `--round-pager-dock-h`, and let the
live custom property recompute `bottom` (`setupPagerDockHeightTracking`,
`src/ui.mjs`).

### The cascade resolver cannot see an interaction pseudo-class

`resolveComputedProperty` (the stand-in's `getComputedStyle` substitute) deliberately
makes any compound it can't evaluate — `:hover`, `:disabled`, `:focus`,
`::-webkit-scrollbar` — never match, so a rule gated on one of those is invisible to
every check that reads a computed value.

It presented as a chevron that stayed on the page: adding
`.round-flip:disabled { display: none }` hid it on every single-round board and at
both ends of every other one, and left the whole suite green (verified) — nothing
computes a different value, because the rule never applies in the stand-in.

Assert the invariant structurally instead of by computed value: parse every rule
whose selector mentions the control at all, whatever state it's gated on, and assert
none sets `display: none` / `visibility: hidden` / `opacity: 0`
(`test/check-round-pager.mjs`, "DISABLED is not hidden") — the inverse of asserting a
rule exists by its spelling, which can match a rule that selects nothing (see the
mermaid-selector entry above): asserting a class of rule does NOT exist can't be
fooled the same way. Keep computing the property too for states that DO have a class
(`body.readonly`, `body.page-board`, `body.sent-page`), which the resolver evaluates
correctly and a structural scan keyed on the control's class would miss.

### `scrollHeight` and `clientHeight` model exactly one fact

The stand-in reads `0` for any node not in a document, and otherwise whatever a
fixture declared via `data-standin-client-height` / `data-standin-scroll-height`.
Nothing is computed — an undeclared connected element reading `0` means "this stand-in
knows no box for this node", never "this node is 0px tall".

It presents as a value that is silently right most of the time: `wireRoot` runs
against a detached subtree on every push path, and a real browser also reports 0/0
there — so anything that measures at wire time measures zero, matching the stand-in
by coincidence. `unlockCodeCapForDrag` (`src/ui.mjs`) once claimed its one-shot unlock
marker *before* the comparison it guards, so the marker burned with the unlock never
having run: every code block arriving over SSE was permanently undraggable, and the
match against real Chrome's own 0/0 detached reading meant nothing here caught it.

Don't grow this into a layout model — anything whose answer depends on real layout
still belongs in a real browser. Pin the fact you found by hand with a check that
declares both a detached and an attached height, the way
`test/check-anchor-push.mjs` does (0/0 detached, 480/4478 attached), so a short block
left alone is what stops a version that "fixes" this by unlocking everything.

### Nothing scrolls, but a `scroll` listener can still be driven

There's no `scrollY`, no `scrollTop` that moves, and no gesture in the stand-in, so
anything gated on the artifact being scrolled inside its frame — the page board's
condensing header (ADR 40) — looks untestable.

It is not: a check can set `frame.contentWindow.pageYOffset` (or an element's
`scrollTop`) by hand and dispatch `{ type: 'scroll', target }` on the frame's
DOCUMENT, which runs `stageAgentScript`'s own listener for real and produces the real
message (`test/check-page-board.mjs`). Dispatching on the window instead does
nothing: the stand-in's `dispatchEvent` walks `parentElement` only, so it has no
capture path and no document in the ancestor chain to reach a document listener.

Dispatch on the document with an explicit `target`, matching the real listener's own
registration (a capture-phase one on `document`) — driving the listener at its
registration point is the honest substitute; that a capture listener genuinely sees
an inner element's scroll is a browser fact, measured separately.

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
that does to the frame's own scroll position is not guessable from spec reading; it
needs a real-browser probe. Measured in Chrome 152 (Blink), against a probe
mirroring `.round` / `.round-current` exactly:

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

`test/dom-stand-in.mjs`'s `StandInDocument` backs THREE different documents, and only
one of them should default `readyState` to `'loading'` rather than `'complete'`:

- The outer page (`parseHTML`) needs to start `'loading'`: a real page (where this
  script runs inline in `<head>`, before `<body>` exists) never takes the
  `else { wire(); }` branch `src/theme.mjs`'s `themeBootScript` falls into when
  `readyState` reads `'complete'` too early. A caller calls `document.finishParsing()`
  (flips `readyState` to `'complete'`, dispatches a real `DOMContentLoaded`) at the
  point it wants to simulate the parser reaching the end of the document.
- The `about:blank` placeholder every `<iframe>` gets the instant it is parsed
  (`aboutBlankDocument`) — genuinely `'complete'` immediately in a real browser, and
  `test/check-click.mjs` already asserts this. Set it explicitly to `'complete'`
  after construction; the class default (`'loading'`) is wrong for this one.
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
permanently, even after a screenshot. Chrome then runs no rendering updates, so
`requestAnimationFrame` and `scroll` events never fire and `setInterval` is clamped to
~1s — a perfectly working page-board scroll then looks like a total failure. **Check
`visibilityState` and whether a bare `requestAnimationFrame` fires before believing any
measurement about scrolling, animation or timing.** `--headless=new` over CDP reports
`visible` and fires both.

Chrome is scriptable over the DevTools protocol with no dependencies — Node 24's native
`WebSocket` plus `chrome --headless=new --remote-debugging-port=N`,
`Target.attachToTarget` and `Input.dispatchMouseEvent` is enough to hover, click and
read the DOM.

Once driving it, each of these silently produces a wrong measurement rather than an error:

- **The page board's condense needs a real wheel event over the stage**, not
  `window.scrollTo` on the parent (which moves nothing) — the stage is a sandboxed
  opaque origin, so `frame.contentWindow` throws. `Input.dispatchMouseEvent { type:
  'mouseWheel' }` at the frame's centre is what scrolls it.
- **`<html>` carries `scroll-behavior: smooth`.** Set
  `documentElement.style.scrollBehavior = 'auto'` before measuring, assert you're
  actually at the bottom (`scrollHeight - scrollY - innerHeight < 2`), and re-measure
  coordinates in a separate eval after any `scrollIntoView` settles — a mid-scroll
  read is stale and the click lands unrelated.
- An iframe stage's mock content usually fills only a slice of the frame; clicking the
  empty area anchors nothing and reads like a dead gesture. Probe several points.
- A pointer capture taken between a dispatched `mousePressed`/`mouseReleased` pair
  retargets the resulting `click` — see `setPointerCapture` above.
- `/json/new` rejects a plain `GET` with a 200 response carrying an error STRING, so
  `resp.json()` fails pointing nowhere near the cause. Use `{ method: 'PUT' }`.
- A race that only exists "while the render is in flight" needs the render to take
  measurable time, or the probe lands after the page has settled and reads as a pass.
  Sample the DOM every few ms after navigation to confirm the window is wide enough first.

### The `claude-in-chrome` extension's own coordinate system, and its window resize

Driving a page through the `claude-in-chrome` MCP tools (`computer`/`find`/
`javascript_tool`) rather than a raw CDP driver has two traps of its own.

`resize_window` called on an already-navigated tab changes `outerWidth`/
`outerHeight` but leaves `window.innerWidth`/`innerHeight` (the CSS viewport
the page's own layout uses) untouched — resize BEFORE navigating instead, on
a freshly created tab; `innerWidth`/`innerHeight` then do reflect the request
(not always exactly — treat the resulting size as approximate, read it back
with `javascript_tool` rather than trusting the requested numbers).

`computer`'s `left_click` with a `coordinate: [x, y]` does not reliably land on
the intended element, in either the raw CSS-pixel coordinate space or the
screenshot's own (larger, DPR-scaled) pixel space — a click that should have
hit a specific button can produce no DOM effect and no network request at
all, silently, with nothing to say the click missed. `find` (which returns a
`ref_N` against the real accessibility tree) plus `computer`'s own `ref`
parameter lands correctly instead, confirmed by a genuine resulting `fetch`
showing up in `read_network_requests` — prefer `find` + `ref` over raw
coordinates for anything where "the click either did something or didn't"
matters, and treat a coordinate click that doesn't error but also doesn't
change anything as a probe that missed, not as proof of a dead control.
`find` does not reach inside a cross-origin sandboxed `srcdoc` iframe (an
html stage's own content, `allow-scripts` only) — nothing in that
accessibility tree is reachable, by the same isolation
`test/check-stage-isolation.mjs` exists to prove.

### A harness that imports `src/` serves the code as it was at startup

The throwaway preview server imports `renderBoardPage` once, so `src/ui.mjs`'s
client-script template literal is captured at boot. Editing `src/` and re-running the CDP
driver silently re-tests the OLD page, with nothing on screen to say so. Restart the
server after every `src/` edit.

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

- [A client script that parses is not a client script that is on the page](#a-client-script-that-parses-is-not-a-client-script-that-is-on-the-page)
- [`test/check-archive.mjs`'s own `loadBoard`/`loadArchive` never run `themeBootScript`](#testcheck-archivemjss-own-loadboardloadarchive-never-run-themebootscript)
- [Finding the real `<style>` tag in rendered bytes](#finding-the-real-style-tag-in-rendered-bytes)
- [A block-comment stripper needs to know about regex literals, not just strings](#a-block-comment-stripper-needs-to-know-about-regex-literals-not-just-strings)
- [A rendered page contains every comment's text twice, so "it must not render" cannot be grepped](#a-rendered-page-contains-every-comments-text-twice-so-it-must-not-render-cannot-be-grepped)
- [A fixture board holding one `html` block and nothing else is a PAGE board](#a-fixture-board-holding-one-html-block-and-nothing-else-is-a-page-board)
- [A `check-mcp.mjs` fixture with no question block no longer blocks on `/wait`](#a-check-mcpmjs-fixture-with-no-question-block-no-longer-blocks-on-wait)
- [Every read is gated, so every HTTP check needs a credential](#every-read-is-gated-so-every-http-check-needs-a-credential)
- [`execFileSync` deadlocks against an in-process daemon](#execfilesync-deadlocks-against-an-in-process-daemon)
- [`writeDoc` defaults to the REAL board home, so a check that calls it without one clobbers the reader's pomodoro state](#writedoc-defaults-to-the-real-board-home-so-a-check-that-calls-it-without-one-clobbers-the-readers-pomodoro-state)
- [A mutation helper that restores with `git checkout` eats uncommitted work](#a-mutation-helper-that-restores-with-git-checkout-eats-uncommitted-work)
- [A block's id is kind-locked, permanently](#a-blocks-id-is-kind-locked-permanently)
- [A machine-identity sweep cannot be `includes(os.hostname())`](#a-machine-identity-sweep-cannot-be-includesoshostname)
- [A comment-only edit to src/ui.mjs can still break check-sample-board.mjs](#a-comment-only-edit-to-srcuimjs-can-still-break-check-sample-boardmjs)

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
(inline, ahead of the stylesheet `<link>`) and `ui` second (the deferred sibling script,
ADR.md entry 70), so a check that only
runs `ui` finds `#theme-toggle` in the markup and not disabled, and nothing happens when
it is clicked, since no listener was ever attached. Proving the theme control works *in
the archive* needs a loader that runs both scripts in that order (`loadArchiveThemed`).

### Finding the real stylesheet in rendered bytes

**Superseded by ADR.md entry 70, and kept only as the reason the current shape is easy.**
A page no longer carries its CSS at all: it names a bare sibling stylesheet, so a check
that wants the real bytes reads that file beside the archive rather than digging a
`<style>` block out of the HTML. `extractStyleBlock` is deleted. What follows is why the
old extraction was hard, so nobody reinvents it for a page written before the change.



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
locate the structural adjacency `src/render.mjs`/`src/indexpage.mjs` both emitted,
`` </script>\n<style> `` — a shape no comment's prose reproduces. Only `src/indexpage.mjs`
still emits it; a board page written since entry 70 has no `<style>` block to find.

### A block-comment stripper needs to know about regex literals, not just strings

`stripJsComments` strips comments from raw emitter source before `test/check-pure.mjs`'s
orphan-class check runs (a class named only in a doc comment must not satisfy it), but a
naive `//`/`/* */` scanner is unsafe here for two independent reasons. These files ARE
the client-script template literals (`ui`,
`stageAgentScript()`, `themeBootScript`) — real code, not comments, so a scanner blind to
string/template-literal boundaries could mistake a comment-shaped sequence inside one of
those strings for an actual comment and eat real code. And separately,
`test/fixtures/markdown-pre-marked.mjs`'s bold/italic regex
(`.replace(/\*\*([^*]+)\*\*/g, ...)` — the pre-`marked` scanner this repo used to ship
in `src/markdown.mjs`, before ADR 62 vendored a real parser) has a body which, read
blind to regex syntax, contains escaped asterisks immediately followed by the regex's
closing slash: exactly the sequence that closes a block comment. `stripJsComments` tracks
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
`.comment-btn` and no `.expand-btn` at all, and with the send bar hidden.

This presents as a null-dereference in the *setup* of checks about the lens
(`document.querySelector('.html-block .expand-btn')` returning null), pointing nowhere
near the layout rule that actually causes it. Any check about a stage's kicker, its
lens, or the send bar beside it needs a SECOND block in the fixture (a one-line
`markdown` block is enough) to stay an ordinary board. Same class of trap as the
`check-mcp.mjs` entry below: a fixture's *shape*, not its content, decides which code
path it exercises.

### A `check-mcp.mjs` fixture with no question block no longer blocks on `/wait`

`ask`'s return condition is derived from the round's own blocks (PROTOCOL.md: a round
carrying a question block blocks until submit, a content-only round returns the instant the
post succeeds). So any check meant to exercise `blockingWait` — a timeout path, a
restart-reattach, a cancellation — MUST include at least one `kind: 'question'` block among
what it posts, or the call returns immediately with `status: 'posted'` before ever reaching
`/api/board/:id/wait`, and an assertion on `result.status === 'timeout'` (or any other
blocking-path outcome) fails for a reason having nothing to do with the mechanism under
test. A fixture's *shape*, not just its content, decides which return path a check
exercises.

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

### An orphaned grandchild holding a `spawn`'s pipes makes the whole check file hang, silently

A check that `spawn`s a process which itself forks children — `test/check-launcher-menubar.mjs`
runs `bin/launcher.c`, which forks node and the `--menubar` item — has to kill the
grandchildren, and has to enumerate them BEFORE killing their parent. SIGKILL is the one
stop the launcher cannot clean up after, so anything still listed as its child a moment
later has already been reparented to launchd and is unfindable by `pgrep -P`.

The symptom is not a stray process, which would at least be visible. It is node itself
refusing to exit: the orphans still hold the stdout/stderr pipes the `spawn` created, so
those streams never see EOF, they stay as active handles, and the check file hangs after its
last assertion — under `test/run.mjs` that is a 180s timeout, and run alone with output
piped anywhere it is a command that produces **no output at all**, because the pipe never
closes. Nothing in that presentation points at processes. Enumerate, kill the parent, kill
the enumerated strays, and `destroy()` both streams for good measure.

`kill(pid, 0)` cannot help here either: it answers "still there" for a zombie as happily as
for a live process, so a check asserting that a child was *reaped* has to ask `ps -o stat=`
and compare against `''`, not `'Z'`. (Ablation, measured: revert `bin/launcher.c`'s
`waitpid(-1, …)` to `waitpid(pid, …)`, kill the item, and `ps` reports `Z` for as long as the
job runs.)

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

### A pomodoro fixture dated with `localDateStr` passes all day and fails before dawn

`cycleDate` names the **pomodoro day** (05:00 to 05:00 local, ADR 67), not the calendar
date, and `readDoc` rolls anything belonging to a day that has ended: timer to `null`,
cycle to `0`. So a fixture seeded `cycleDate: localDateStr(Date.now())` — the obvious
spelling, and what every pomodoro check used before that ADR — is a document from
*yesterday* for the five hours after midnight, and the check that reads it back finds no
timer. Between 05:00 and midnight it is correct, which is to say the suite is green every
time anybody looks at it. Seed `cycleDate: pomodoroDay(now)` instead.

The same trap with a longer fuse: a check that seeds a document and then asserts against
`readDoc` at the real `Date.now()` is fine unless the suite happens to straddle 05:00.
Anything driving an injected clock should pass it to `readDoc(home, now)` as well —
that parameter exists so a check's "now" is one value, not two.

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

### `POST /api/board` into an open question round amends it, so a check cannot mint round 2

`handlePostBoard` amends the latest round in place when it is still `open` AND asks
something (a question block anywhere in it, nested included). So the obvious way to
build a two-round board in a check —

```js
const { boardId } = await postRound(port, { title, blocks: [QUESTION('a?')], cwd });
await postRound(port, { boardId, blocks: [QUESTION('b?')] });   // still round 1
```

leaves the board with ONE round and a second question glued into it. Nothing fails;
the response even comes back `{ round: 1 }`, which is easy to read past. Every
assertion about "a different round" then quietly asserts nothing.

To mint real round numbers, open the board with an **awaited page round** instead —
one `html` block plus `wait: true` (ADR entry 45). It is Awaited (so it strands, and
counts on the index) but asks no question, so the next post takes the `addRound` branch
and becomes round 2. `test/check-stranded.mjs`'s `waitingArtifactBoard` is that helper.
Note `wait: true` alone is not enough: `mintAwait` requires `isPageRound`, which is one
`html` block and nothing else — a markdown block with `wait: true` is not awaited at all
and strands nothing.

### A machine-identity sweep cannot be `includes(os.hostname())`

The obvious way to check a committed artifact for leaked machine identity is
`committedText.includes(os.hostname())`. It fails in both directions at once.

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

### A comment-only edit to src/ui.mjs can still break check-sample-board.mjs

`ui` (src/ui.mjs's export) is the parent-side script's own source, embedded
verbatim into every rendered board page inside a `<script>` tag — not
recompiled, not summarized, the literal file text. `examples/sample-board.html`
is a committed byte-identity fixture built from that same render path, so a
change to src/ui.mjs that touches not one line of *behaviour* — adding a
sentence to a comment, say — still changes the committed HTML's bytes and
fails `check-sample-board.mjs`'s "byte-identical to the committed sample" check.
src/render.mjs's design comment (the one this file's own `stageAgentScript`
lives under) is NOT embedded the same way — only the returned template literal
is — so a comment edit there is inert for this purpose. The fix, same as any
other genuine drift: `node examples/sample-board.mjs`, then diff the result to
confirm the only change is the one you made.

---

## launchd, TCC and the app bundle

- [macOS TCC gates the daemon by *application*, and launchd's application is not yours](#macos-tcc-gates-the-daemon-by-application-and-launchds-application-is-not-yours)
- [A missing launcher bundle wedges launchd at `exit 78` and `kickstart` cannot fix it](#a-missing-launcher-bundle-wedges-launchd-at-exit-78-and-kickstart-cannot-fix-it)
- [A bare `kickstart` no longer picks up a source edit — only `./install.sh` does](#a-bare-kickstart-no-longer-picks-up-a-source-edit--only-installsh-does)
- [A carried-forward `ref_roots` record widens itself back to today's defaults on every install](#a-carried-forward-ref_roots-record-widens-itself-back-to-todays-defaults-on-every-install)
- [Where the clone lives silently sets the installer's health budget, and the checks pay it](#where-the-clone-lives-silently-sets-the-installers-health-budget-and-the-checks-pay-it)
- [`lsregister` records are permanent, share a bundle id, and a dead one is a "damaged app" dialog on repeat](#lsregister-records-are-permanent-share-a-bundle-id-and-a-dead-one-is-a-damaged-app-dialog-on-repeat)
- [A copied platform binary is SIGKILLed on exec from inside a `.app`, wherever the copy lives](#a-copied-platform-binary-is-sigkilled-on-exec-from-inside-a-app-wherever-the-copy-lives)

### macOS TCC gates the daemon by *application*, and launchd's application is not yours

A LaunchAgent gets no folder access by inheritance the way a process started from
Terminal does. If the plist runs `/opt/homebrew/bin/node bin/daemon.mjs`, the
application macOS is deciding about is **node**, and every read under `~/Documents`,
`~/Desktop` or `~/Downloads` comes back **EPERM** — which surfaces on the board as
`cannot read <path>: EPERM` and looks exactly like a missing file. A clone that lives
in one of those three folders cannot even start: `bin/daemon.mjs` is itself a gated
read. (`./install.sh` is what takes a code change here, kickstart or no — see "A bare
`kickstart` no longer picks up a source edit" below.)

Why the daemon runs from a signed app bundle rather than granting node directly, the
fork-not-exec requirement, and the rebuild-revokes-the-grant trap are all `SECURITY.md`'s
territory now — "What the launcher bundle is for" through "The code the bundle runs". Read
those first.

Two probes worth keeping here:

- **Diagnose from a throwaway LaunchAgent, not your shell.** The same node, the same
  flags and the same file behave differently under launchd than under Terminal, and
  testing from the shell will tell you everything is fine.
- **`readdir` on `~/Library/Application Support/com.apple.TCC`** is a cheap probe for
  whether a process holds Full Disk Access — it is FDA-only, so EPERM there alongside
  a successful read of `~/Documents` means the narrow folder grant is present and FDA
  is not.

### A missing launcher bundle wedges launchd at `exit 78` and `kickstart` cannot fix it

The LaunchAgent's `ProgramArguments` is a single path into a bundle the installer
compiles: `~/Applications/claude-board.app/Contents/MacOS/claude-board`. If the plist
exists but that bundle does not, launchd cannot exec anything and parks the job:

    state = spawn scheduled
    runs = 3
    last exit code = 78: EX_CONFIG

`EX_CONFIG` here is launchd's, not the daemon's — do not go looking for it in
`bin/daemon.mjs`, which never exits 78. The daemon's own logs are no help either: the
last lines in `~/Library/Logs/claude-board/daemon.err.log` are an ordinary clean
shutdown from whenever it last ran successfully, which reads like a healthy service
and is not. Page-side, this presents as a bare **`Error: Failed to fetch`** in the
board tab and an `ask` call that posts nothing — treat "Failed to fetch" from a board
as "check the daemon is running" before anything else.

`launchctl kickstart -k gui/$(id -u)/claude-board` does **not** revive it, and worse,
it blocks: it waits for a service that will never come up, so it looks like a hang,
and `runs` does not increment. The fix is `./install.sh`, which rebuilds and re-signs
the bundle.

Diagnose with three commands, in this order — the third is the one that actually
names the fault, the first two only tell you something is wrong:

    curl -s -m 3 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7391/   # 000 = nothing listening
    launchctl print gui/$(id -u)/claude-board | grep -E "^\tstate|last exit|runs ="
    ls -la "$(launchctl print gui/$(id -u)/claude-board | grep -A2 'arguments = {' | tail -1 | xargs)"

Read the program path out of `launchctl print` rather than assuming it — the plist is
rewritten on every install, and a stale path is the same failure with a different
cause. `test/check-install.mjs` now asserts the real bundle, plist and secret survive
the check suite untouched, which is what closed the way this used to happen.

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

`install.sh` checks a carried-forward `ref_roots` record against `DEFAULT_REF_ROOTS` on
every run and adds back whatever current default the record is missing (ADR.md entry 36),
printing the line naming what it widened. The trap: narrowing the allowlist with
`CLAUDE_BOARD_REF_ROOTS= ./install.sh` is **not a permanent choice**. It survives for any
directory the *current* defaults do not name, but the next plain upgrade re-adds every
directory that IS a current default regardless. A genuinely narrow list has to be
reasserted with the explicit env var on every run that might otherwise widen it.

### Where the clone lives silently sets the installer's health budget, and the checks pay it

`install.sh` waits for `/api/health` 20 times at 0.25s — unless the launcher was built by
this run *and* the clone sits under `~/Documents`, `~/Desktop` or `~/Downloads`, in which
case the budget becomes 480 tries. That is deliberate: a freshly built launcher has no TCC
grant yet, so reading `bin/daemon.mjs` out of a protected directory raises a dialog against
the launchd job, and two minutes is a person's budget to notice it and click Allow.

Nothing about that is visible from the check suite, and a clone in `~/Documents` is the
normal case. A health-gate check that points the installer at a port nothing will ever
bind could wait out the whole 480 tries — comfortably past `test/run.mjs`'s 180s
per-check ceiling, for a wait no human was ever going to answer.
`test/check-install.mjs`'s own health-gate check avoids exactly this with
`CLAUDE_BOARD_HEALTH_TRIES`, which overrides the resolved count (set to 4 there) after
both branches of the conditional, so neither real-world default moves. If a check that
shells out to `install.sh` is inexplicably slow, this is the first thing to measure —
and note it will NOT reproduce for anyone whose clone lives outside those three
directories.

### `lsregister` records are permanent, share a bundle id, and a dead one is a "damaged app" dialog on repeat

`install.sh` registers the bundle with LaunchServices so macOS will let it post a
notification at all. LaunchServices keeps every record forever, keyed by bundle id —
so any throwaway bundle a check builds under the same real bundle id (fakehomes,
`CLAUDE_BOARD_APP_DIR` overrides, fixtures built corrupt on purpose) leaves behind a
record indistinguishable from the real install's own. Notification Center resolves a
banner by bundle id and picks whichever record it likes, so the symptom is macOS
raising *"claude-board.app is damaged and can't be opened"* over and over while the
real install is fine and the board is up and serving.

The same dialog has a second, unrelated cause that needs no `lsregister` call at all —
see the next entry before assuming a stale record is what you are looking at.

`test/check-notify.mjs` cannot take the next entry's way out — `importFromFakeBundle` stages a real
`<name>.app` because `notifyBoundary` spawning the bundle executable is the behaviour
under test, and one of those is named `claude-board.app` exactly. So `install.sh` skips
registration for a bundle staged under a throwaway root (`is_throwaway_bundle_path`,
carried byte-identical in both scripts — `test/check-install.mjs` asserts they have not
drifted), and `uninstall.sh` withdraws the record *after* removing the bundle, so a
failed `rm` under `set -e` cannot leave the record gone and the bundle unable to ever
notify again. **A check that stages a bundle owes the same teardown**, visible only via
`lsregister -dump | grep -c 'claude-board.*\.app'` before and after the file runs.

Cleanup on macOS 26: `lsregister -kill -r` **no longer exists** (prints a removal
notice and exits 0, silently doing nothing — check `Date Initialized` in `-dump` to
confirm a rebuild happened instead). `lsregister -u <path>` does work, even on a path
that no longer exists, and takes many paths per invocation — `-dump` piped through
`xargs -n 200 lsregister -u` clears thousands of records in seconds. `-dump` prints
`/private/var/...` where `tmpdir()` says `/var/...`; check both spellings.

### A copied platform binary is SIGKILLed on exec from inside a `.app`, wherever the copy lives

Exec'ing a binary from inside a `.app` makes macOS evaluate that bundle, and an invalidly
signed binary is SIGKILLed on the spot. `/bin/sleep` and friends are platform binaries whose
signature is only valid on the SIP volume, so a *copy* of one is always invalid. The symptom is
the same *"claude-board.app is damaged and can't be opened"* dialog as a stale `lsregister`
record, but raised immediately by the exec rather than by Notification Center — and moving the
copy elsewhere does not help, because this is not Gatekeeper's path.

When a check needs a throwaway long-lived executable, `symlinkSync` a long path at
`process.execPath` rather than copying it: `ps` reports the path a process was started from, not
what the link resolves to, so the link proves what a copy would, and costs no disk where the copy
costs 115 MB a run.

### `XPC_SERVICE_NAME` does not tell you a process was started by launchd

The common lore — check `getenv("XPC_SERVICE_NAME")` against the job's `Label` to tell a
LaunchAgent start apart from a Terminal or Finder one — does not hold on this machine.
Measured on macOS 26 both ways: an interactive zsh in Terminal.app and a throwaway
LaunchAgent bootstrapped with `launchctl bootstrap gui/$UID` and a plist naming a real
`Label`, dumping `env` from inside the job. Both show `XPC_SERVICE_NAME=0` and
`XPC_FLAGS=0x0`. The variable is apparently only populated to the job's label for
services with a `MachServices` stanza a process connects to over XPC — an ordinary
LaunchAgent plist like this repo's, with no `MachServices` key, gets the same `"0"`
either way. Do not reach for it as a "was I started by launchd" signal without adding
`MachServices` and paying for the XPC machinery that comes with it.

What ADR.md entry 76 uses instead: an entry in the plist's own `EnvironmentVariables`
dict (`CLAUDE_BOARD_LAUNCHD_MARKER`), which launchd injects into the process it execs
because that dict is part of the job description launchd itself reads — and which a
stray LaunchServices launch of the same bundle can never carry, because that launch path
never consults `~/Library/LaunchAgents/claude-board.plist` at all. `getppid()` was
considered and rejected too: on this same machine a Finder double-click and a launchd
bootstrap both report launchd as the parent, since ordinary app launches also route
through launchd's own "generic launch" job spawning — so the parent pid does not
discriminate either.

---

## macOS notifications and sound

- [The board's banner works; macOS Focus is what hides it](#the-boards-banner-works-macos-focus-is-what-hides-it)
- [A top-level board field you add is served into the page, so `writeBoard` without `writePage` breaks the archive](#a-top-level-board-field-you-add-is-served-into-the-page-so-writeboard-without-writepage-breaks-the-archive)
- [Any check that boots a daemon will raise real banners unless the stranded grace is pushed out of reach](#any-check-that-boots-a-daemon-will-raise-real-banners-unless-the-stranded-grace-is-pushed-out-of-reach)
- [A bundle's notification identity belongs to `CFBundleExecutable`, and to nothing else in it](#a-bundles-notification-identity-belongs-to-cfbundleexecutable-and-to-nothing-else-in-it)
- [A freshly installed app bundle cannot post a notification until LaunchServices knows about it](#a-freshly-installed-app-bundle-cannot-post-a-notification-until-launchservices-knows-about-it)
- [`soundNamed:` searches `/System/Library/Sounds` and does NOT search the app bundle — the documented search path is backwards](#soundnamed-searches-systemlibrarysounds-and-does-not-search-the-app-bundle--the-documented-search-path-is-backwards)

### The board's banner works; macOS Focus is what hides it

`notifyRound` (`src/notify.mjs`) fires on the daemon's own stranded rule: a round left
awaited with no Watcher looking at its board, after the fifteen-second grace (ADR.md
entries 55, 58; CONTEXT.md "Stranded"). When a reviewer reports it "never fires", check the
OS before the code.

Focus config lives in `~/Library/DoNotDisturb/DB/`: `ModeConfigurations.json` for the
schedules, `ModeConfigurationsSecure.json` for the per-mode allow-list, and
`Assertions.json` for whether a mode is active *right now* (empty file = none active). A
mode in allow-list mode that does not list the notifying app routes every board banner
straight to Notification Center with no banner and no sound — indistinguishable from the
banner never having fired at all unless you go look.

One thing that will mislead you while chasing this: which app belongs on that allow-list
depends on which path fired. A daemon running from an installed bundle posts as
claude-board's own `CFBundleExecutable` and gets its own row in System Settings >
Notifications; a daemon running from the clone (no bundle) falls back to `osascript` and
posts as Script Editor instead (`src/notify.mjs`, `bin/notify.m` — see "A bundle's
notification identity belongs to `CFBundleExecutable`" below). Allow-listing one does
nothing for the other, and there is no longer a per-origin or per-browser-profile grant
to chase (ADR.md entry 58).

Verifying it end to end takes a board nobody is Attending: post a round to a board with no tab open
on it, or close the only tab watching one, then wait past the fifteen-second grace. A board
a reviewer is actually looking at correctly raises nothing, so testing with the board in
front of you proves the wrong thing.

### A top-level board field you add is served into the page, so `writeBoard` without `writePage` breaks the archive

`renderBoardPage` spreads the whole board into `<script id="board-data">`, and
`test/check-http.mjs` pins that the served page, `pages/<id>.html` on disk and a fresh
render of the stored JSON are all byte-identical — which is what makes an archived board
open from Finder with no daemon. So a field written by anything that does NOT also
re-render the page silently breaks that invariant: the served markup grows a key the
file on disk does not have.

The stranded rule hit this (`strandedBanner`, written from a timer callback, where
re-rendering a multi-megabyte page board would be absurd). The fix is `stripDaemonOnly`
in `src/board.mjs` — a daemon-only field is removed from the client payload at both
places one is built (`renderBoardPage`, and `resolveBoardComments` for the SSE pushes).
Add a durable field the daemon writes outside a request and you want the same treatment,
or `writePage` beside every `writeBoard`.

The trap is that the suite will not tell you: `test/run.mjs` pushes the stranded grace out
of reach for every other check, so `npm run check` stays green and only
`node test/check-http.mjs` run alone with a live grace fails.

### Any check that boots a daemon will raise real banners unless the stranded grace is pushed out of reach

Since the stranded rule landed (`createStrandedWatch`, `src/stranded.mjs`), a board with an
open awaited round and nobody watching it is announced with a real `osascript` banner after
fifteen seconds — and "post an awaited round, then walk away" is what almost every check
that boots a daemon does. Measured, not assumed: `node test/check-http.mjs` on its own, with
a 200ms grace and a stub counting invocations, produced **nine** banners.

`test/run.mjs` therefore sets `CLAUDE_BOARD_STRANDED_GRACE_MS` to a day for the whole suite,
so `npm run check` is silent. **A check run on its own does not get that**, so a single
`node test/check-<whatever>.mjs` that keeps a daemon alive past fifteen seconds will put
banners on your screen. The checks that mean to exercise the rule
(`check-stranded.mjs`, `check-notify-round.mjs`, `check-notify-click.mjs`) set the variable
themselves and stand a fake `osascript` ahead of the real one on `PATH`; anything else that
grows a daemon and a long life wants the same two lines.

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
reaches a not-yet-registered bundle does not queue, retry or prompt later — it leaves the
bundle recorded as *denied* (`authorizationStatus == 1`), which no amount of re-running
fixes, because macOS prompts once per bundle identifier and then answers from its own
record. The only way out is System Settings > Notifications > claude-board.

Debugging this at all needs `getNotificationSettingsWithCompletionHandler:`, since
`requestAuthorization` reports "denied by the user long ago" and "you are not a registered
app" with the same string. A throwaway bundle carrying the same `CFBundleIdentifier` as the
one under test reads the real status without disturbing it.

### macOS 26 refits and masks a legacy `.icns` itself, so the artwork's own padding and corners are invisible

Measured on macOS 26.5 (25F84) with a throwaway bundle whose icon is a **full bleed, opaque,
sharp cornered square**: `-[NSWorkspace iconForFile:]` returns it as a 412×412 body centred in
a 512 tile (0.80 of the canvas) with a squircle corner about 31 px in on the diagonal, plus the
system shadow. Identical numbers, to the pixel, for Bruno, Linear, Ghostty, Calculator, and for
this repo's icon before *and* after it was redrawn to the 0.80 grid. Fresh bundle identifiers
were used, so this is live compositing rather than an Icon Services cache.

Two consequences. Padding the artwork to four fifths and rounding its corners is a no-op on
this OS, since the system does both regardless, and a body already inset would be double-inset if it
refitted the *canvas*, which it does not; it refits the opaque bounds. And "the icon does not
fill its tile, the system drops it on a grey plate" is not reproducible here through this path:
a wrong-shaped legacy icns comes out of it looking correct. Keep the padded artwork anyway, it
is what older macOS and any non-IconServices consumer expect, but do not spend a rebuild on
icon geometry alone on macOS 26 without first measuring the surface that looks wrong.

The probe is four lines of AppKit (draw `iconForFile:` into an `NSBitmapImageRep`, scan for the
alpha bounding box, sample the corner) and is worth rewriting over trusting a screenshot: the
Finder, System Settings and Quick Look surfaces all read this same composited image. `qlmanage
-t` is not a substitute: it hung past two minutes on a bundle with no code signature.

### `rsvg-convert` refuses an XML comment containing `--`, silently taking down every size in the loop

Regenerating `bin/claude-board.icns` (comment above `LAUNCHER_ICON_SRC` in `install.sh`) runs
`rsvg-convert -w N -h N mark-grid.svg -o icon_NxN.png` once per size. An SVG comment that
contains a literal `--` (a plain-English aside, an em-dash rendered as two hyphens, "cost
the -- extra" style prose) makes libxml refuse the whole document with `XML parse error:
... Double hyphen within comment`, and every invocation in the loop fails the same way —
`rsvg-convert`'s own error mentions the file, not the comment, so the first instinct is to
suspect the geometry rather than the prose sitting above it. This is standard XML (`--`
is disallowed inside a comment body by spec); most browsers and other SVG tools tolerate
it anyway, which is why a comment written and eyeballed in a browser can still trip this
tool later. Write comments in `.svg` sources the same way you would inside a genuine XML
document — no `--`, spell it out or use a single `-` — since this is the one file type
here that is generated through a strict parser rather than displayed by a lenient one.

### `soundNamed:` searches `/System/Library/Sounds` and does NOT search the app bundle — the documented search path is backwards

Apple documents the opposite. Measured on macOS 26.5 (25F84): a bare name resolves
against `/System/Library/Sounds`, a file existing only in the posting bundle does not
resolve at all, and on a collision the stock sound beats a `~/Library/Sounds` copy. So
staging sounds into the bundle does not work, and a reader-supplied sound is reachable
only under a name no stock sound uses. The extension is optional; an unresolvable name is
**silence**, not a default. Encoded in `src/cues.mjs`'s `SOUNDS_DIRS` order, so the
preview resolves to the same file the notification plays.

---

## The menu bar status item

### A status item is not your window, and every obvious detector lies about it

`NSStatusItem`'s button window is composited by **ControlCenter**, not by the process that
created it. Measured while verifying ADR 72, every one of these is a false negative or a
false positive:

- `CGWindowListCopyWindowInfo` filtered to your own pid returns nothing in **every**
  condition, including for a plain `NSApplicationActivationPolicyRegular` app. A detector
  built on own-pid windows reports failure always, and has told you nothing.
- `button.window.windowNumber` is `4294967296` (2^32), not a real window-server number.
- `button.window.isVisible` is `1` even with `statusItem.visible = NO` and the window parked
  off-screen at `(0,-17 61x22)`. Worthless as a signal.
- The frame is height-zero for the first 1-2 seconds, so a synchronous check straight after
  `statusItemWithLength:` says "not in the menu bar" about an item that is working. Sample at
  t ≥ 2s.

The one detector that survived its own must-fail control: take `button.window.frame`, flip it
to CoreGraphics top-left (`screenHeight - (y + h)`), and search the **global** on-screen
window list for a layer-25 window at those bounds. It needs no Screen Recording grant — only
`kCGWindowName` is redacted without one. Two instances at once land in distinct adjacent slots,
which is how you know the geometry is a real allocation rather than computed hope.

### `LSBackgroundOnly` does not block a status item, and the activation policy is not why

A forked-and-exec'd child of the bundle executable shows a visible status item under
`LSBackgroundOnly=true` with no `LSUIElement`, from a shell and from launchd alike — and it
does so **with the `setActivationPolicy:` call omitted entirely**, policy left at `Prohibited`.
Keep the call to match `bin/notify.m`, but do not build a design on the belief that it is what
makes the item appear. Also: `-[NSApp setActivationPolicy:]` returns `NO` when the policy
already matches, because the BOOL means "did it change", not "did it succeed". Do not
error-check on it.

### Becoming an `NSApplication` inside a bundle registers that bundle with LaunchServices

Measured while landing `bin/menubar.m`: `+[NSApplication sharedApplication]` (plus
`setActivationPolicy:` / `finishLaunching`) from a process inside a `.app` adds an
`lsregister` record for that bundle **on the spot** — no window, no status item, no
daemon, nothing on screen. Withdraw with `lsregister -u`, re-run, and it comes straight
back.

That is correct and wanted for the real install, which `install.sh` registers deliberately
anyway. It is a slow disaster for a THROWAWAY bundle, and the check suite stages and runs
those: records are permanent, share the one bundle id, and a stale one naming a deleted
path is the "damaged and can't be opened" dialog (see "`lsregister` records are permanent"
above — 6908 of them once). `install.sh`'s `is_throwaway_bundle_path` guard does not help,
because macOS is doing the registering, not the installer.

Two things keep it closed, and they cover different cases:

- `bin/menubar.m` does not become an application until the daemon has answered once
  (`cb_ensure_item`), so a bundle whose daemon never answers registers nothing. That is
  what `test/check-install.mjs` relies on: it runs the launcher against an already-bound
  port, so the daemon exits and the item child never reaches AppKit at all. Structural —
  moving those three AppKit calls back to the top of `cb_menubar` re-opens it silently.
- `test/check-install-payload.mjs` boots a *working* install from a temp root, so its item
  really does appear and really does register. It withdraws the record itself, after its
  own `rm` and **in both spellings**: LaunchServices stores `/private/var/…` where
  `tmpdir()` says `/var/…`, and `lsregister -u` given only the second one silently does
  nothing (measured — the record survived).

`uninstall.sh` skips the withdrawal for a throwaway root, and its stated reason ("install.sh
skips REGISTERING one there") is now only half the story: it is true of the installer and
not of macOS. It is still correct in practice only because of the first bullet.

### A main-queue `dispatch_after` never fires while a status item menu is tracking

Menu tracking runs the loop in `NSEventTrackingRunLoopMode`, which a plain main-queue block
does not reach — a watchdog scheduled that way hangs past any timeout you gave it. Any timer
in the menu bar process must be scheduled in the tracking mode too, or live off the main
thread. This is the trap waiting for the once-a-second countdown tick.

### Activating an accessory app for a popover: every obvious call is deprecated or too new

A status item's `NSPopover` cannot become key — so it cannot be driven from the keyboard at
all — unless the app is active. The two calls that come to hand both fail this repo's
warning-free build check (`test/check-launcher-menubar.mjs` asserts empty compiler stderr):
`-[NSApplication activateIgnoringOtherApps:]` is `API_DEPRECATED(macos(10.0, 14.0))`, and its
named replacement `-[NSApplication activate]` does not exist before macOS 14, so an unguarded
call to it will not build on an older SDK.

What compiles clean on both: `[[NSRunningApplication currentApplication]
activateWithOptions:NSApplicationActivateAllWindows]`. Only the *option*
`NSApplicationActivateIgnoringOtherApps` was deprecated in 14; the method was not.

### The once-a-second tick really does survive a popover being open

Measured while landing ticket 05, as the positive control for the trap above: with the tick
registered in `NSRunLoopCommonModes` and the popover shown, the countdown kept advancing
(`Work · 24:57` → `24:56` with `popover.shown == 1`), and an action dispatched onto the poll
queue from a button landed and repainted the popover's own line inside one second. The
registration is what buys that; a default-mode timer would have frozen there.

### `screencapture` is unavailable from an agent process tree

"could not create image from rect", sandboxed or not, for want of a Screen Recording grant.
Visual verification of anything on screen has to go through the window-list geometry above.

### A run loop with no input source does not wait — `runMode:beforeDate:` returns instantly

`-[NSRunLoop runMode:beforeDate:]` returns `NO` **immediately** when the loop has no input
source or timer attached, whatever date you hand it. The obvious long-lived idiom —
`while (!stop_requested) [[NSRunLoop currentRunLoop] runMode:… beforeDate:now+0.25]` — is
therefore not a quarter-second wait but a spin that burns a core until the signal arrives,
and nothing on screen or in the logs says so. `bin/notify.m`'s `flush_run_loop` has the same
shape and gets away with it because it runs for 0.25s total; `bin/menubar.m` lives for a
login session and cannot.

The fix is one line — `[[NSRunLoop currentRunLoop] addPort:[NSPort port]
forMode:NSDefaultRunLoopMode]`, a Mach port nothing ever sends to — and it is worth keeping
even once the status item installs sources of its own, so the loop's correctness does not
depend on which AppKit object happens to be alive. Measured after: 0.0% CPU, `0:00.00` of
CPU time across three seconds.

Pace the loop with `beforeDate:` rather than with whatever the source is, too: a timer-paced
loop notices a stop only when the timer next fires, which couples "how fast does this shut
down" to a number chosen for something else entirely.

---

## Shell, C and the filesystem

- [An apostrophe inside `${VAR:-...}` swallows the rest of a bash script](#an-apostrophe-inside-var--swallows-the-rest-of-a-bash-script)
- [Sizing a C array from `sizeof(arr)/sizeof(arr[0])` held in `static const int` is a VLA](#sizing-a-c-array-from-sizeofarrsizeofarr0-held-in-static-const-int-is-a-vla)
- [`DYLD_INSERT_LIBRARIES` (and friends) act on the process being loaded, not on what that process execs](#dyld_insert_libraries-and-friends-act-on-the-process-being-loaded-not-on-what-that-process-execs)
- [Two open flags macOS will not accept together](#two-open-flags-macos-will-not-accept-together)
- [A temp dir's spelling is not its realpath, and path confinement compares realpaths](#a-temp-dirs-spelling-is-not-its-realpath-and-path-confinement-compares-realpaths)
- [Two processes racing the same timeout: the daemon loses by its own poll interval](#two-processes-racing-the-same-timeout-the-daemon-loses-by-its-own-poll-interval)

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

### Two processes racing the same timeout: the daemon loses by its own poll interval

The shim and the daemon both read `CLAUDE_BOARD_TIMEOUT_MS` and default to the same 40
minutes, and only the daemon's side of that race does anything: its timeout branch is
what broadcasts `awaitExpired`, closes the lapsed round and returns the timeout packet.
The shim wins that race by default twice over. Its deadline starts at `blockingWait`
entry while the daemon's starts after connect and parse, and `waitForRound`
(`src/server.mjs`) polls the store every 120ms, so the daemon can only notice its own
deadline at the next tick after it. A margin sized for request latency is therefore not
enough: `WAIT_GRACE_MS` (`bin/mcp.mjs`) is floored at 250ms for the poll interval, not
for the network. If you shorten the poll interval or add a second waiter, that floor is
the thing to re-check — and the symptom of getting it wrong is silent, since both sides
report `status: 'timeout'` either way. The check that catches it runs a daemon and a
shim on one shared cap and asserts the ROUND was closed on disk.

---

## Worktrees, the shared checkout, and two files with the same tail

- [The same absolute-looking path can name two different checkouts](#the-same-absolute-looking-path-can-name-two-different-checkouts)
- [Scratch probe scripts belong in the worktree, not `/tmp`](#scratch-probe-scripts-belong-in-the-worktree-not-tmp)

### The same absolute-looking path can name two different checkouts

A worktree agent's own tracked files live under `.claude/worktrees/<name>/...`, but
this repo's `SPEC_*.md`/`TICKETS_*.md` are gitignored and only exist in the SHARED
checkout (`/Users/jerry/Documents/claude-board/SPEC_*.md`), read/edited there on
purpose. That trains a reasonable habit — "this repo's absolute path is
`/Users/jerry/Documents/claude-board/...`" — that is wrong for every TRACKED file:
the shared checkout and a worktree are two separate git checkouts, so the same
filename under each root is two different files, and nothing about `Read`ing the
former warns you it isn't the one your `Bash` commands (which default to the
worktree's cwd) are operating on.

It presents as a stale-looking read that is not a cache bug: the shared checkout's
copy of a tracked file can sit behind whatever commit it last had checked out
(a merge the worktree branch picked up was never applied to the shared checkout's
own working tree), indistinguishable from staleness until you check which checkout
the path you typed actually resolves to.

Once a task hands you a shared-checkout path for the gitignored spec/tickets files,
do not let that path's PREFIX leak into where you read or edit anything else —
every tracked file's path starts with the worktree's own root, spelled out in full.
If a `Read` result ever looks implausibly behind what `git log`/`grep` say the
branch contains, check which checkout the path resolves to before doubting the tool.

### A worktree can already hold ANOTHER ticket's uncommitted work, so a red suite is not necessarily yours

Two slices of one spec handed out at the same time can land in the SAME worktree
directory — the second brief says "your own worktree" and means it, but the path it
resolves to is one another agent is already editing. Nothing announces this: `git status`
is the only tell, and it reads like your own mess until you notice the modified files have
nothing to do with your ticket.

Measured: `npm run check` on ticket 01's finished work came back with four red files, three
of them (`check-launcher-env`, `check-notify-click`, `check-install`) failing on
`Undefined symbols: _cb_menubar` — ticket 03's half-wired `bin/menubar.m`, uncommitted in
the shared tree. Every minute spent reading those is spent on someone else's in-flight
edit.

What settles it in one step, and is worth doing before touching anything on a suite you
did not expect to be red: `git worktree add --detach <path> <branch>`, apply ONLY your own
files' diff there (`git diff -- <your files> > p && git apply p`), and run the suite in
that. It answers "is this mine" and "is the branch itself red" at once. Then
`git worktree remove --force` it. The same tree-sharing also means `git commit -a` sweeps
up the other agent's work: name your files explicitly on `git add`, every time.

### Scratch probe scripts belong in the worktree, not `/tmp`

A worktree-isolated session refuses shell commands it cannot statically prove
stay inside the worktree, and a heredoc redirect (`cat > /tmp/probe.mjs <<'EOF'`)
is one of them — it is rejected before it runs, however harmless. Write throwaway
probe scripts to the worktree root with the `Write` tool and delete them before
committing; `node probe.mjs` from the worktree cwd then resolves `./src/*.mjs`
relatively, which is also the one import path that cannot accidentally reach the
SHARED checkout's copy of a tracked file (see above).

---

## Vendoring a CJS-shaped npm package under `"type": "module"`

- [`prismjs` has no ESM build, and its component files assume a shared global, not a module system](#prismjs-has-no-esm-build-and-its-component-files-assume-a-shared-global-not-a-module-system)
- [`marked`'s own emphasis/strikethrough tokenizer is quadratic on unclosed delimiter runs](#markeds-own-emphasisstrikethrough-tokenizer-is-quadratic-on-unclosed-delimiter-runs----the-exact-class-of-bug-adr-62s-ceiling-asked-to-close)
- [No `timeout`/`gtimeout` on a bare macOS box](#no-timeoutgtimeout-on-a-bare-macos-box----use-perl--e-alarm-n-exec-argv-cmd-to-bound-a-hanging-command)

### `prismjs` has no ESM build, and its component files assume a shared global, not a module system

`prismjs` ships no ESM build: `components/prism-core.js` is a UMD script that assigns
`module.exports` and `global.Prism`, and every one of the 22 grammar files this repo needs
references a bare, UNDECLARED `Prism`. The ecosystem assumes either a `<script>` tag or
sequential CJS `require()`, both of which supply that identifier as a shared global.

It presents as a silent no-op followed by a `ReferenceError`. Under this repo's root
`"type": "module"`, importing `prism-core.js` unmodified as a `.js` file parses it as
an ES module: nothing throws, but nothing is exported either, and every grammar file that
follows fails with `ReferenceError: Prism is not defined` — ESM is always strict mode, so it
never falls back to an implicit global the way a sloppy-mode `<script>` or CJS wrapper does.

Give every vendored prismjs file a `.cjs` extension instead of `.js`, and load them with
`createRequire(import.meta.url)` from an `.mjs` loader (`src/vendor/prism/index.mjs`). Node
decides a module's type from a `.cjs`/`.mjs` extension outright, ignoring the nearest
`package.json`'s `"type"`, so the files run as CommonJS regardless of the rest of the repo and
their global-sharing works as upstream intended — zero bytes of upstream changed, which is what
keeps the recorded digest meaningful. Require the grammars **in dependency order** (bases before
what extends them: `clike` before `javascript`, `markup` before `jsx`/`markdown`). A grammar
file existing on disk with the right sha256 is not evidence it loads, so
`test/check-vendor-digest.mjs` calls `Prism.tokenize` against a real sample per language.

Check a future vendor drop's own npm dist for an ESM build (as `marked` ships) before reaching
for `.cjs` + `createRequire`: it is the right tool only when upstream is genuinely CJS/UMD-shaped
and rewriting it byte-for-byte is off the table.

### `marked`'s own emphasis/strikethrough tokenizer is quadratic on unclosed delimiter runs -- the exact class of bug ADR 62's ceiling asked to close

`Tokenizer.emStrong` (matches `_.._`, `__.._`, `*.._`, `**.._`) and `Tokenizer.del`
(GFM `~~.._`) are both called once per character position by marked's inline scan
loop; on failure to find a closer, each rescans forward to the end of the remaining
string before giving up. That's O(n) work per failed position and O(n) failed
positions on content shaped like `' _a'.repeat(N)` (never closes) -- O(n^2) overall,
reproducing on board-content scale (an untrusted file, not a hand-typed one) the
exact DoS class this repo vendored a real parser to close in the first place.

The vendored bytes cannot be patched (ADR 62 pins them to a recorded sha256
`test/check-vendor-digest.mjs` asserts offline, deliberately, so the digest check
catches drift). The fix is a targeted `marked.use({tokenizer: {emStrong, del}})`
override with a linear replacement, memoizing "no closing run exists in the searched
suffix" per delimiter key -- since the scan loop only ever shrinks its remaining
string as it advances, one failed full-length scan proves every shorter (later)
suffix closer-less too, for free. `marked.use({tokenizer:{...}})` falls back to the
ORIGINAL (quadratic) method only when the override returns the literal value
`false`; returning `undefined` for "no match" is what keeps the slow path from ever
running.

The memo's correctness argument is scoped to ONE pass over ONE string, and nothing
about a module-level `Map` enforces that: a SUCCESSFUL match calls `Lexer.lexInline`
on the emphasis content, which fires the same hook, resets the memo and leaves its
own bounds in it. The outer scan then inherits a bound derived from an unrelated
string -- which both deletes emphasis silently (history-dependent within one
paragraph) and voids the linear-time bound itself, since every successful match
wipes what the failing ones learned. A homogeneous perf fixture (never matching)
can't catch this -- it never nests -- so the N2 fixtures need an INTERLEAVED shape
too. `src/markdown.mjs` saves and restores the memo around the nested lex
(`lexNested`); anything else that reaches back into marked's inline lexer from
inside a tokenizer override needs the same treatment.

### No `timeout`/`gtimeout` on a bare macOS box -- use `perl -e 'alarm N; exec @ARGV' <cmd>` to bound a hanging command

Diagnosing the quadratic-marked issue above needed a hard wall-clock cap on a
command that might genuinely hang forever (an adversarial input against an
unknown-complexity tokenizer). GNU `timeout` doesn't exist on stock macOS, and
`coreutils`' `gtimeout` isn't installed on this machine either. `perl` is
always present (system Perl ships with the OS) and `alarm(N); exec(@ARGV)`
sends SIGALRM to the exec'd process after N seconds, killing it if it hasn't
exited -- a one-liner that needs no install and works for any command, not
just ones with their own timeout flag. Background-and-poll (`run_in_background`
+ waiting) works too but costs a full round trip per attempt; `perl -e 'alarm
N; exec @ARGV' node ...` gets a bounded answer synchronously, which is what
bisecting "how many reps until this blows up" actually wants.

---

## Shapes the page-board stage is pinned to

- [The stage is a constant `100vh` box, not a box that grows to its content](#the-stage-is-a-constant-100vh-box-not-a-box-that-grows-to-its-content)
- [`handleStageHeight` has a floor as well as a cap](#handlestageheight-has-a-floor-as-well-as-a-cap)
- [The mermaid CDN fallback is pinned to the version the board CSP names](#the-mermaid-cdn-fallback-is-pinned-to-the-version-the-board-csp-names)

Three constraints that look arbitrary at the call site. Each was settled deliberately; none
is load-bearing enough for `.agents/adr/`, and all three break silently if changed.

### The stage is a constant `100vh` box, not a box that grows to its content

The rendered templates use `position: sticky` and their own full-viewport `<dialog>`, neither of
which survives a frame sized to its content. So a page board's stage is a constant `100vh` box
that scrolls internally. Sizing it to the document breaks the artifact's own chrome, not the board's.

### `handleStageHeight` has a floor as well as a cap

The floor is the 320px placeholder, beside the existing 600px cap. Without it a stage that sizes
itself from the viewport reports its collapsed height on first paint and locks its card there.

### The mermaid CDN fallback is pinned to the version the board CSP names

The renderer templates pin it, and keep the vendored `assets/` copy — that copy is what answers
when a page is opened from Finder rather than through a board. Bumping one without the other
gives a page that renders in exactly one of the two places. The templates live in the renderer
skills under `~/.claude/skills`, outside this repo; only the CSP pin is here.
