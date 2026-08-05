# QUIRKS

Tooling traps in this repo. Read before fighting something; append when something fights you.

## The stylesheet and the markup are checked against each other

`test/check-pure.mjs` ("every class the stylesheet rules on is a class something
actually emits") scans `src/styles.mjs` for every `.class-name` and fails if that
string does not appear in `src/render.mjs`, `src/ui.mjs`, `src/indexpage.mjs` or
`src/markdown.mjs`. So: no speculative CSS. A rule for a class nothing renders is a
test failure, not dead code. Attribute selectors (`[data-status="answered"]`) are
not scanned, which is the escape hatch when a state has no class.

Several rules are asserted by their exact text, not their effect —
`.readonly-banner { display: none;`, `body.readonly .send-bar { display: none; }`
and `body.readonly .stage-hint { … display: none`. Keep each of those on one line
and keep the wording; reformatting them breaks the checks.

Asserting a rule by its text is itself a trap, and the mermaid rules are why: they
used to be asserted as the literal string `g[id^="flowchart-"]`, which matched the
stylesheet perfectly while selecting nothing any browser ever rendered (see "Real
mermaid node ids are prefixed" below). Those two rules are now built from
`MERMAID_NODE_SELECTOR` (`src/anchor.mjs`) and checked by asking whether they would
select a REAL node id, not by matching their spelling. Prefer that shape for any new
rule whose whole job is to select something.

## Real mermaid node ids are prefixed, and `^=` will not see them

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

More generally: a mock of someone else's renderer is an assumption about their output,
and it is worth exactly as much as the last time someone checked it against the real
thing.

## `WatchPaths` never restarted the daemon — fixed by having the daemon exit itself

Historical record, kept because it is a real trap and a real instance of the pattern
below: the plist used to carry both `KeepAlive` true and `WatchPaths` on `src/` and
`bin/`, and the second one was inert. `WatchPaths` tells launchd to *start* a job when
a watched path changes; a job that is already running — which `KeepAlive` guarantees —
is simply not started again. Measured 2026-07-30: the daemon had 3h40m of uptime across
an in-place edit to `src/store.mjs`, and neither creating nor deleting a file under
`src/` moved its pid either. `test/check-install.mjs` asserted the plist *contains*
those `WatchPaths` entries, which was true and beside the point — the fourth recorded
instance on this project of a green check sitting on top of a dead mechanism, and the
second where the check asserted structure while the behaviour was absent.

**Fixed (SPEC_LAUNCH.md criterion 17):** `WatchPaths` is gone from the generated plist.

**And then reload-on-change went too (2026-08-01).** The replacement was
`bin/daemon.mjs` watching its own `src/` and `bin/` and exiting on a change, opt-in via
`CLAUDE_BOARD_RELOAD_ON_CHANGE=1` in the installed plist, with `KeepAlive` bringing the
new code up. It worked exactly as designed and was still wrong: a save during a review
dropped every open event stream and every held-open wait, editor temp files tripped it
(entry below), launchd's 10s restart throttle turned a burst of writes into a visible
outage, and an edit landing half-written took the daemon down for real. Nothing now
restarts the daemon on a code change — `./install.sh` does, when somebody runs it. The
variable is not read anywhere any more; a stale plist or an exported shell value does
nothing, which `test/check-install.mjs` pins by setting it and asserting the daemon
survives an edit to a temp copy of `src/`.

To restart the daemon on your own schedule:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

## Driving the real page in real Chrome

The check suite's DOM stand-in cannot see this class of defect, by construction. To
drive the actual page, Chrome is scriptable over the DevTools protocol with no
dependencies at all — Node 24 has a native `WebSocket`, so `chrome
--headless=new --remote-debugging-port=N` plus `Target.attachToTarget` /
`Input.dispatchMouseEvent` is enough to hover, click and read back the DOM. Keep such
a driver OUT of the repo (it is not part of the zero-dependency check suite); a
throwaway under `/tmp` is the right home. Two things that cost time:

- Measure element coordinates in a *separate* eval from the `scrollIntoView` that
  precedes it, with a settle delay between. Measuring across a scroll gives stale
  coordinates and clicks land somewhere unrelated.
- An iframe stage's mock content usually fills only a slice of the frame. Clicking
  the frame's empty area correctly anchors nothing, which reads exactly like a dead
  gesture. Probe several points before believing it.
- `Input.dispatchMouseEvent` with a `mousePressed`/`mouseReleased` pair does produce a
  real `click`, but if the page took a pointer capture in between, the `click` you
  get is not the one you meant — see the next entry.
- This Chrome version's `/json/new` HTTP endpoint (used to open a tab and get its
  `webSocketDebuggerUrl` without hand-rolling `Target.createTarget` over the browser
  socket) rejects a plain `GET` with "Using unsafe HTTP verb GET to invoke /json/new.
  This action supports only PUT verb." — a 200 response carrying an error STRING, not
  a 4xx, so a caller that does `resp.json()` unconditionally gets `SyntaxError:
  Unexpected token 'U', "Using unsa"... is not valid JSON` pointing nowhere near the
  real cause. Use `fetch(url, { method: 'PUT' })`.
- A race that depends on "the initial render is still in flight" (D1/D2, audit
  2026-07-31) needs the render to actually take measurable time. This machine's
  jsdelivr fetch of mermaid's CDN module was fast enough (sub-20ms, likely warm HTTP
  cache after the first hit) that 6-10 tiny flowcharts finished rendering in under
  100ms total — a "click again 200ms later" reproduction landed AFTER the page had
  already settled, every trial, and looked like the bug was fixed when it had simply
  never been exercised. Sampling `document.querySelectorAll('pre.mermaid svg').length`
  every 5ms after navigation (a throwaway timing probe, not a permanent check) is the
  fast way to confirm the window is wide enough before trusting a "0 corrupt" result;
  widening each diagram (more nodes, so dagre's layout pass actually costs
  milliseconds) is more reliable than guessing at a smaller click interval.

## `setPointerCapture` on pointerdown steals the click from what you clicked

Any drag-to-pan surface will reach for `element.setPointerCapture(ev.pointerId)` in
its `pointerdown` handler — `/explain`'s lens does exactly that, and this repo's
diagram lens (DESIGN.md polish ticket 05) copied it. While a capture is active Chrome
retargets **everything that follows** at the capture element: `pointerup`, `mouseup`
and, crucially, the `click` the pair produces. So a click handler on that same
surface sees `ev.target === theSurface`, not the thing under the pointer, and any
`ev.target.closest(...)` walk-up finds nothing. Measured in Chrome 150, 2026-07-31:
the lens's own comment gesture was dead for exactly this reason, while every check
in `test/check-mermaid-anchor.mjs` — which drives the whole gesture end to end
through the DOM stand-in — stayed green, because there is no such thing as pointer
capture in the stand-in.

The fix is to take the capture **only once the press has actually become a drag**
(past a few pixels of movement), never on the press itself: a plain click then never
has capture active and targets normally, and a genuine pan is captured before it can
leave the element. `test/check-pure.mjs` pins the shape of that ("the lens takes
pointer capture only once a press has become a pan"), which is as far as a check
without a browser can go — the behaviour itself rests on driving real Chrome.

This is the same family as the two entries above it: a gesture that is dead in every
browser under a green suite, because the suite's model of the browser is missing the
one mechanism that breaks it.

## The stand-in has no layout: no `IntersectionObserver`, no `scrollHeight`, no `clientHeight`

`test/dom-stand-in.mjs` is a DOM, not a browser: nothing in it lays anything out, so an
API whose whole job is reporting real layout is either absent or permanently zero. Two
different consequences follow from that, worth telling apart.

- **`IntersectionObserver` is not defined at all.** `setupRoundObserver` (`src/ui.mjs`,
  the round badge's position-tracking half, DESIGN.md polish ticket 04) guards on
  `typeof IntersectionObserver !== 'function'` and returns immediately when it is
  missing -- by design, so the stand-in does not throw, but it also means the half of
  the round badge that decides which round number to show as you scroll runs under no
  check at all. This one was caught by hand, not by the audit: the long comment above
  `setupRoundObserver` records a real defect found by recreating the observer in real
  Chrome (a 1px root-margin band that a smooth-scrolled section can jump clean over
  between two consecutive samples), since fixed. Not a gap the suite happened to miss;
  a mechanism the suite cannot see at all short of embedding an actual browser.

- **`scrollHeight` and `clientHeight` model exactly one fact, and nothing more.** They
  read `0` for a node that is not in a document, and otherwise whatever the fixture
  declared via `data-standin-client-height` / `data-standin-scroll-height`. Nothing is
  computed: content, CSS and size stay unrelated, and an undeclared connected element
  reading `0` means "this stand-in knows no box for this node", never "this node is 0px
  tall".

  That one fact is modelled because every push path turns on it. `wireRoot` runs against
  a **detached** subtree by design on all three of them, and a real browser also reports
  0/0 there -- so anything that measures at wire time measures zero. `unlockCodeCapForDrag`
  (`src/ui.mjs`) used to claim its one-shot unlock marker *before* the comparison it
  guards, so the marker was burned with the unlock never having run and the post-attach
  re-measurement then skipped itself: every code block arriving over SSE was permanently
  undraggable, and criterion 5 held only for blocks present at first load. Found by the
  audit reading the function, confirmed in Chrome (0/0 detached, 480/4478 attached), and
  now driven end to end by two checks in `test/check-anchor-push.mjs` that fail against
  three separate breakages of the guard. The second of those two checks asserts a SHORT
  block is left alone, which is what stops the first being satisfied by a version that
  unlocks everything and quietly takes criterion 6 away.

  Do not grow this into a layout model. Anything whose answer depends on real layout --
  where a box actually is, how tall content renders -- still belongs in the Chrome drive.

Same rule as `setPointerCapture` above for `IntersectionObserver`: a check that needs it
has to come from a real browser.

## A harness that imports `src/` serves the code as it was at startup

The throwaway preview server imports `renderBoardPage` once, so `src/ui.mjs`'s
client-script template literal is captured at boot. Editing `src/` and re-running the CDP
driver silently re-tests the OLD page -- it cost one agent two rounds of "the fix doesn't
work" against a fix that did. Restart the server after every `src/` edit.

Related, same session: in headless Chrome a `fetch` from a tab that is not the focused one
can stay pending indefinitely. A driver that opens and closes several tabs should run any
fetch-dependent assertion first, or give it its own browser.

## Criterion 12's html-stage half is checked by reading its source, not by running it

`test/check-pure.mjs`'s check on `stageAgentScript()` (DESIGN.md polish ticket 02,
"a SENT element is de-affordanced on hover, in the html stage too") extracts the
client script as a string and asserts against it with regexes: that `SENT_CLASS` is
declared once, that the hover handler's body contains a check against `sentRefs`, that
`clearHover` removes the class again. None of that ever runs the script -- no DOM, no
dispatched `mouseover`, no read-back of a real `classList`. The mermaid half of the
same criterion, in `test/check-mermaid-anchor.mjs`, is the opposite: it builds a real
board with a sent comment, loads the page into the DOM stand-in, dispatches a real
click, and asserts on the resulting `classList` state.

Not a caught defect (the html-stage half has not been shown to be wrong) -- an audit
finding about the check's own shape, flagged as a trap the mermaid entry above already
names by example: an assertion on spelling proves the source says the right thing, not
that a browser running it does the right thing. If this half is ever rewritten,
prefer driving it in a DOM the way the mermaid check already does over adding another
regex.

## A client script that parses is not a client script that is on the page

`src/indexpage.mjs`'s `indexScript` used to be checked exactly one way: extract the
string, run it through `new Function('document', 'setInterval', indexScript)` against a
minimal stand-in, and confirm it parses and behaves once invoked directly. That proves
the script is valid and does what it claims in isolation -- it proves nothing about
whether `renderIndexPage` ever puts it on the page at all. Deleting
`<script type="module">${indexScript}</script>` from `renderIndexPage`'s returned markup
left every check in the file green: the relative-time feature could ship completely
disconnected from the page that is supposed to carry it, and nothing would say so. Caught
by an audit reading the check, not by hand verification -- nobody has watched a stripped
build fail to update in a real tab, only read that the wiring itself had no check pinning
it. Fixed by a second, separate check that asserts the STRING IDENTITY of what
`renderIndexPage` embeds against `indexScript` itself, on top of (not instead of) the
in-isolation one.

Same shape as this file's mermaid-id trap ("Real mermaid node ids are prefixed" above),
one layer out: that one was a mock of a renderer's output diverging from the real thing;
this one is a tested unit whose presence on the assembled page was never itself asserted.
Worth checking on any file that
exports a string meant to be *embedded* somewhere (`indexScript` here, `stageAgentScript()`
in `src/render.mjs`, `ui` in `src/ui.mjs`): a check that the string is well-formed is not
a check that the assembly step actually uses it.

## No external assets, ever

`renderBoardPage` output must open from Finder with the network off. The page test
rejects any `<link rel=stylesheet>` or `<script src=>`, so: no web fonts (system
stack only), no icon fonts, no CDN CSS. Icons are inline SVG. Mermaid is the one
exception — it is imported at runtime from a CDN and degrades to raw source when it
cannot be reached.

## Two stylesheets, one palette

The html-stage iframe is sandboxed and the page's tokens deliberately do not reach
into it. Its hover-highlight rule is built with a hardcoded hex, updated by hand
when `--accent` / the surface tokens change in `src/styles.mjs`.

**That hex tracks `--accent`'s LIGHT value, not dark, and the reason generalises.**
The stage renders on `--stage-bg`, which is `#fff` in *both* palettes — an
agent-authored mock assumes a white canvas, so the stage deliberately does not
follow the page. The outline is therefore theme-*independent*: there is no light
variant to add, only a right and a wrong colour for white. It was pinned to the
dark accent for as long as the stage existed, which put it at 2.61:1 on white,
under the 3:1 WCAG floor for non-text UI — on the only per-element targeting
feedback the stage gives. `src/styles.mjs`'s own LIGHT palette comment had
already rejected that exact colour on white ("#7c9cff on white is ~2.3:1") when
it moved `--accent` to the mid-blues; nothing connected the two, because the
stage's own comment described the requirement as "stay in step with `--accent`"
without saying *which* palette or *why*. `test/check-pure.mjs` now asserts the
premise (both palettes' `--stage-bg` identical), the requirement (contrast >= 3:1
against it) and the drift guard (equality with the light accent) separately, so a
palette change that breaks any one of them fails on the one it broke.

The lesson worth carrying: on a surface that does not follow the theme, "matches
the token" is not the requirement — "has contrast on the surface it actually
renders on" is, and only one of those two is worth writing a check for.

**The 401 refusal page used to be filed under this entry, and should never have
been.** `renderRefusalPage` is self-contained by design — no stylesheet link, no
script, no network, so it renders under the same locked-down CSP a board does —
and that was read as "therefore its colours are hand-maintained, like the
stage's". It drifted twice in two days. First it shipped dark-only, six literals
and no light variant, so a light-mode reader got a black slab on the one page
they reach holding nothing else (2026-07-31 audit, R5). Then the light variant
was added by hand, which fixed the half that had just been looked at and left
the dark half on its original six — none of them a value in *either* palette —
so the page went on mismatching every dark board it fronted, and the check
written at the time asserted only the light values, so nothing caught it.

The distinction the stage earns and this page does not: the stage is injected
into a sandboxed `srcdoc` the page's tokens never reach, *and* a custom property
is the one mechanism that would reach through that boundary anyway (properties
inherit, so agent-authored HTML could declare its own `--accent`). The refusal
page renders in the page's own document, on the page's own background. So it now
emits both token blocks from `palettes` at render time and paints through
`var()`: self-containment ruled out *linking* `src/styles.mjs`, never reading the
same data out of it. `test/check-pure.mjs` runs the raw-literal check against
this stylesheet as well as `styles` now.

Before hand-maintaining a second copy of a colour, check which of the two
properties actually applies — "cannot link the stylesheet" is not "cannot read
the palette", and only the stage has ever needed the stronger one.

Mermaid's
`themeVariables` no longer are: `mermaidThemeVariables()` (`src/ui.mjs`) now reads
live computed style through a mermaid-variable -> CSS-token map
(`MERMAID_TOKEN_MAP`), so a palette change reaches it with nothing to update by
hand. Ticket 10 (DESIGN.md)
dropped `allow-same-origin` from the iframe and moved the hover rule from
`wireHtmlStage` (`src/ui.mjs`, since deleted — the parent can no longer reach
`contentDocument` at all) into `stageAgentScript` (`src/render.mjs`), the
stage-side agent injected into every html block's `srcdoc`. The hex lives there
now; the "update by hand" trap is unchanged, only the address moved.

DESIGN.md polish ticket 02 added a second stage-side rule next to that one:
`.cb-anchor-sent` (`cursor: not-allowed`, no outline at all), for an element that
already carries a *sent* comment — no hex to keep in step this time, just a
`cursor` value, but it is hand-maintained in the same sense: `stageAgentScript`
cannot read `src/styles.mjs`'s `.cb-anchor-sent` rule any more than it could read
`--accent`, so the two are two independent places asserting the same idea, kept
in sync by convention (same class name) rather than by any shared source. The
stage cannot know which of its own elements are "already sent" on its own —
that fact lives in `board.comments`, in the parent document only — so the
parent's `mode` postMessage (`src/ui.mjs`'s `handleStageReady` and
`setCommentMode`) now carries a `sentRefs` array alongside `commentMode`,
recomputed from `board.comments` on every stage-ready and every toggle. Still
one message type, not a new one: sent-ness is exactly the kind of fact that
matters precisely when mode changes.

There is a third hand-maintained place, and it is not a stage at all:
`renderRefusalPage` (`src/render.mjs`), the "this browser is not authorized" page.
It is deliberately self-contained — no stylesheet link, no script, so it renders
under the same locked-down CSP as a board and reveals nothing — which means it can
reach neither `src/styles.mjs`'s tokens nor the reviewer's saved theme (that lives
behind a script). It shipped dark-only: six hardcoded hex, a black slab on every
light-mode machine, for as long as the credential gate has existed. The OS
preference via `@media (prefers-color-scheme: light)` is the only theme signal it
can act on, and the right one for a page reached by a browser that by definition
holds nothing of ours. Its light values are hand-copied from the LIGHT palette and
`test/check-pure.mjs` asserts each against the real token, so a palette change
fails there rather than quietly leaving this page on the old colours.

DESIGN.md polish ticket 05 added no third place: the diagram lens's own chrome is
written entirely against `:root`'s tokens (no hex anywhere in `.diagram-lens` and
friends), and the diagram *inside* it is a `cloneNode(true)` of the already-rendered
SVG, so it simply inherits whatever mermaid's `themeVariables` produced.

That paragraph used to end "the lens is downstream of those variables, so updating
them by hand updates the lens for free — there is nothing extra to keep in step",
and both halves of that were written before the light theme landed. Neither
survived it. The variables are not hand-updated any more (`mermaidThemeVariables()`
reads live computed style), and "downstream" is only true at the moment the clone
is taken: a theme change runs `runMermaidRedrawPass`, which REPLACES each inline
`<svg>` with a new element, and an already-open lens goes on holding a clone of the
one that was replaced. Measured in Chrome 2026-07-31, System mode with the OS
flipping to light: the lens's node rects stayed `rgb(24, 32, 47)` with
`rgb(234, 238, 246)` labels — a dark diagram inside light chrome — while the inline
diagram behind the dialog had correctly become `rgb(245, 246, 251)` /
`rgb(23, 28, 42)`. Note the trigger: a modal `<dialog>` makes the rest of the page
inert, so the theme *control* cannot be clicked while the lens is open — this is
reachable only through `src/theme.mjs`'s `matchMedia` listener, i.e. the reader who
leaves a diagram open while macOS switches at sunset. `lensRetheme` (`src/ui.mjs`)
re-clones from the fresh svg, keeps the pan/zoom, and redraws the pins;
`test/check-mermaid-theme.mjs` drives it end to end and fails when the call is
removed.

The general shape is the one this file keeps recording: a value copied out of a
live source is correct exactly until the source changes, and "there is nothing to
keep in step" is a claim about a snapshot, not about a mechanism.

## A backtick inside `export const ui = \`...\`;` ends the client script early

`src/ui.mjs` exports its whole client script as one template-literal string.
A stray literal backtick anywhere between that opening `` ` `` and the closing
`` `; `` — including inside a `//` or `/** */` comment quoting a code
identifier the way this codebase's prose usually does (`` `wireRoot(root)` ``)
— terminates the string early and turns the rest of the file into a syntax
error, often pointing the error at an unrelated later line. `node --check
src/ui.mjs` catches the outer file being unparseable, but only running the
extracted string through `new Function('document','window','location', ui)`
(as every check in `test/` already does) proves the *client script itself*
still parses — the failure mode ticket 10 hit repeatedly was edits that passed
the former but not the latter. Same trap applies to `src/render.mjs`'s
`stageAgentScript()`, a second, separate template-literal client script. Use a
single quote for an inline code reference inside either string; save backticks
for outside them.

It is not limited to the three *client scripts* (`src/ui.mjs`'s `ui`,
`src/render.mjs`'s `stageAgentScript()`, `src/theme.mjs`'s `themeBootScript`)
— `src/styles.mjs`'s whole `export const styles = \`...\`;` is the identical
shape for CSS, and a backtick inside one of ITS `/* ... */` comments ends that
string just as early (2026-07-31 audit fix, hit directly while editing a
comment above `body.readonly button#theme-toggle`). Unlike the client
scripts, this one usually IS loud: whatever CSS text follows the premature
close brace rarely also parses as JS, so `node --check src/styles.mjs` throws
straight away (verified: `.foo { color: red; }` after a truncated `styles`
assignment fails with `Unexpected identifier`, pointing at the stray backtick's
own line). Loud is not the same as easy to read, though — the reported error
points at the CSS content, not the word "backtick" that actually caused it, so
the fix is the same as ever: single quotes for an inline code reference inside
CSS comments too, and don't assume "the file still parses" means nothing
downstream broke.

## A block's id is kind-locked, permanently

`src/board.mjs`'s `resolveBlockId` rejects any incoming block whose `kind` doesn't
match its `id`'s own kind-letter prefix (`{id:'h1', kind:'markdown', ...}` throws
"does not start with the 'h' letter"), on every `normalizeBlock` path `amendRound`
uses. So "replace this block with a different kind at the same id" is NOT
constructible through `amendRound`/`addRound` at all -- a block's kind is fixed
forever once minted. If a fixture needs that shape anyway (e.g. testing a
resolver's own defensive guard against it), splice a properly-normalised block
from a throwaway `createBoard` directly into `board.blocks[i]`, id overwritten by
hand -- don't fight `amendRound` for it, it will always throw.

## Readonly is locked twice -- CSS and JS -- and reusing chrome inherits both

`.mode-toggle` (the comment-mode toggle's chrome, `src/styles.mjs`/`src/ui.mjs`)
is hidden in a read-only archive by TWO independent, unrelated mechanisms:
`body.readonly .mode-toggle { display: none; }` in the stylesheet, AND
`src/ui.mjs`'s blanket `qsa('textarea, input, button').forEach(el => el.disabled
= true)` readonly loop, which disables it a second time regardless of the CSS.
Ticket 03's theme control reuses `.mode-toggle`'s chrome (by design -- one set of
button rules, not two) but, unlike every other control that ever wore that
class, has to stay live in readonly. Carving it out of only one of the two
mechanisms produces a control that LOOKS fixed and isn't: excluding it from the
CSS selector alone leaves it visible but still `disabled` (silently unclickable,
and the stand-in's `EventTarget.dispatchEvent` doesn't model a browser's native
click-suppression on a disabled element either -- see test/check-archive.mjs's
own comment on that -- so a check that only dispatches a click and checks the
result can pass against a genuinely `disabled` button); excluding it from the JS
loop alone leaves it `display: none`. Both had to be carved out, independently,
and neither existing rule could just be edited to add the exception: both are
asserted by exact literal text elsewhere in the suite (`body.readonly
.mode-toggle { display: none` in test/check-archive.mjs; `qsa('textarea, input,
button')` in test/check-pure.mjs), so the fix in both places is an ADDITIONAL
rule/line stated as an override, not a rewrite of the existing one. The general
lesson: before reusing an existing control's class for a new one with different
readonly semantics, grep for every place that class is gated on `body.readonly`
-- CSS and JS are not the same gate, and a control can pass a check that only
looks at one of them while still being broken by the other.

## Preview harness

There is no dev server for the rendered page. To eyeball UI changes, write a
throwaway script that calls `createBoard` / `addRound` / `renderBoardPage` and dumps
the HTML somewhere, then serve that directory over http — Chrome automation refuses
`file:` URLs. Do not serve out of `/tmp` on this machine: a stray `/tmp/inspect.py`
shadows the stdlib and breaks `python3 -m http.server`.

## `test/check-archive.mjs`'s own `loadBoard`/`loadArchive` never run `themeBootScript`

They run exactly one script — `src/ui.mjs`'s `ui` — against the real file bytes.
That is enough for every check that existed before ticket 05 (readonly, pins,
gestures), because none of it depends on `src/theme.mjs`. But `#theme-toggle`'s
click handler and the pre-paint `data-theme` attribute are both wired by
`themeBootScript`, not `ui` — a real page runs the boot script first (inline,
pre-`<style>`) and `ui` second (the deferred module script), and a check that
only runs `ui` against the archive bytes will find `#theme-toggle` in the
markup (`ui`'s readonly loop re-enables it by id) but nothing will happen when
it's clicked, since no listener was ever attached. Proving the theme control
actually works *in the archive* — not just that it's present and not
disabled — needs a second loader that runs both scripts in that same order
(`loadArchiveThemed` in `test/check-archive.mjs`), the same way
`test/check-theme.mjs`'s own readonly check already combines them on an
in-memory page. Same lesson as the mermaid-id trap above: a helper that only
exercises *one* of the page's real scripts is not "the real page" for
anything the other script owns.

## The stand-in's `getComputedStyle` has no CSS engine behind it

`test/dom-stand-in.mjs`'s `getComputedStyle` never reads `src/styles.mjs`'s `styles`
string. It reimplements, in plain JS from the imported `palettes` object, the one
precedence decision the real cascade encodes: an explicit `data-theme` attribute
wins outright, and only when it is absent does `prefers-color-scheme` decide. Every
check that reads a token through `getComputedStyle` — `test/check-mermaid-theme.mjs`,
`test/check-archive.mjs`'s themed loader — is therefore comparing the stand-in's OWN
copy of that precedence against itself, never against the CSS `tokenBlock()`
(`src/styles.mjs`) actually emits.

A mutation that breaks the real cascade but leaves this hand-written copy of it
intact is invisible to the whole suite. Concretely: nesting the explicit
`:root[data-theme="light"]` override *inside* the `@media (prefers-color-scheme:
light)` block at `src/styles.mjs:176-180` means a reader on a dark-OS machine who
clicks the control to Light gets a page that stays entirely dark — the one thing
this feature exists to do — while `node test/run.mjs` reports every check green,
because the stand-in never looked at the media query or the nesting at all.

The general lesson: a green check here proves the JS that CONSUMES a computed style
is correct for whatever the stand-in decides that style is, not that the stylesheet
produces it under a real cascade. Nothing in this harness parses CSS — a check that
wants to defend the cascade itself needs a small resolver over the `styles` string
(evaluate the media query, match selectors by specificity/source order), which does
not exist yet.

**Resolved 2026-07-31** (audit findings C1/H3): `getComputedStyle` now runs a real,
if small, cascade resolver (`resolveComputedProperty`, `test/dom-stand-in.mjs`) over
the actual `styles` text — see the next two entries for what building and calling it
correctly took.

## Finding the real `<style>` tag in rendered bytes: `<style>` and `</style>` are not reserved words in this codebase's own prose

A check that wants to test the cascade against the ACTUAL bytes on disk (not the
in-memory `styles` export, in case `src/render.mjs` ever diverged from it) has to
locate the real `<style>...</style>` block inside a fully rendered page first. The
obvious `/<style>([\s\S]*?)<\/style>/` is unsafe: both `src/theme.mjs`'s
`themeBootScript` and `src/styles.mjs`'s own `styles` string contain the literal
words `<style>` inside their own comments (`themeBootScript`: "before `<style>` is
even parsed"; the `.cb-anchor-hover` comment in `styles`: "injected into the
sandboxed document's own `<style>`") — both land, as rendered text, BEFORE the one
true opening tag, and there is exactly one real `</style>` in a page (client-script
text never closes a tag it never opened). A non-greedy regex from the first `<style>`
match up to that one real `</style>` therefore captures the ENTIRE boot script and
`ui` module script as "CSS" (confirmed: ~43KB of client-script text, not ~7KB of
real CSS) — and even `lastIndexOf('<style>', closeIdx)` is not safe either, because
`styles`' own comment ALSO contains the substring, landing between the true opening
tag and the close, so "last occurrence before the real close" still lands inside the
stylesheet's own prose rather than at the top of it. What actually works: locate the
structural adjacency `src/render.mjs`/`src/indexpage.mjs` both emit,
`` </script>\n<style> `` (the boot script's closing tag immediately followed by the
real style tag opening) — a shape no comment's prose reproduces. See
`extractStyleBlock` in `test/check-archive.mjs`.

## A block-comment stripper needs to know about regex literals, not just strings

`test/check-pure.mjs`'s orphan-class check used to substring-search raw emitter
source *including comments*, so a class named only in a doc comment (never in real
markup) satisfied it — audit finding M5, `.mode-toggle-icon` named in a comment
above `themeToggle()` (`src/theme.mjs`) but not (after a mutation) in the button's
own `class="..."` string. The fix strips comments from the emitter source before
searching (`stripJsComments`), but a naive `//`/`/* */` scanner is unsafe on this
codebase for two independent reasons: these five files ARE the client-script
template literals (`ui`, `stageAgentScript()`, `themeBootScript`) — real code, not
comments, so a scanner blind to string/template-literal boundaries could mistake a
comment-shaped sequence inside one of THOSE strings for an actual comment and eat
real code — and separately, `src/markdown.mjs`'s bold/italic regex
(`.replace(/\*\*([^*]+)\*\*/g, ...)`) has a regex literal whose own body, read blind
to regex syntax, contains a run of escaped asterisks immediately followed by the
regex's closing slash: exactly the two-character sequence that closes a block
comment. A scanner that does not know it is inside a regex literal at that point
would treat the regex's own middle as `*/`, closing a "comment" that was never open
and mis-scanning everything after it as normal code (or, depending on what came
before, silently eating real code it thought WAS a comment). `stripJsComments`
tracks string/template-literal boundaries AND uses the standard "does the previous
significant token complete a value" heuristic to tell a regex literal's opening `/`
apart from division, specifically to survive both hazards.

## `readyState`'s default is not one fact, it's three, and only one of them should change

Audit finding H2: `test/dom-stand-in.mjs`'s `StandInDocument` used to hardcode
`readyState = 'complete'` unconditionally, so `src/theme.mjs`'s `themeBootScript`
always took the `else { wire(); }` branch — the one branch a real page (where this
script runs inline in `<head>`, before `<body>` exists) never takes. Fixing the
DEFAULT to `'loading'` is one line; the trap is that `StandInDocument` backs THREE
different documents in this file, only one of which should change:

- The outer page (`parseHTML`, run through a check's own loader) — this is the one
  that needed the fix. A caller now calls the new `document.finishParsing()`
  (flips `readyState` to `'complete'`, dispatches a real `DOMContentLoaded`) at the
  point it wants to simulate the parser reaching the end of the document, AFTER
  running the boot script and (per spec: module/deferred scripts run before
  `DOMContentLoaded`) AFTER running `ui` too.
- The `about:blank` placeholder every `<iframe>` gets the instant it's parsed
  (`aboutBlankDocument`) — genuinely `'complete'` immediately in a real browser,
  unrelated to this fix; `test/check-click.mjs` already asserted this. Left at the
  old default by setting it explicitly right after construction, not by leaving the
  class default alone (there is only one class).
- An html-stage's real `srcdoc` content, once `IframeElement.loadSrcdoc()` "loads"
  it — nothing currently reads this one's `readyState`, but leaving it `'loading'`
  forever after the method's own doc comment says navigation has ALREADY finished
  would be a lie the next thing that reads it inherits; set to `'complete'`
  immediately for fidelity, not because anything failed without it.

Get this split wrong (e.g. changing the class default and stopping there) and
`test/check-click.mjs`'s about:blank assertion breaks for a reason that has nothing
to do with the actual fix — exactly the "run the WHOLE suite, understand why before
adjusting it" case: a fix to one document's realistic default looks, from inside the
one shared class, like a fix to all three.

Separately, the real ordering matters and is easy to get backwards: a
`<script type="module">` (`ui`, no `async`) is a DEFERRED script by spec, which runs
AFTER parsing finishes but BEFORE `DOMContentLoaded` fires — so a loader that wants
both real scripts to have run by the time it hands back a document must run
`themeBootScript`, then `ui`, then call `finishParsing()`, in that order. Calling
`finishParsing()` between the two (a plausible first guess, "boot script pre-body,
`ui` post-body") wires the theme control before `ui` runs, which nothing in this
suite currently depends on being wrong, but is not what a real page does.

## Every read is gated, so every HTTP check needs a credential

Since the read gate landed (`SPEC_LAUNCH.md`), a plain `fetch('/b/:id')` from a check
gets 401. `test/check-http.mjs` and `test/check-anchor-robustness.mjs` each shadow the
global `fetch` at module scope with a wrapper that adds the secret header, so the
hundred-odd requests that are *not* about the credential keep reading as they did. If
you add a check that stands up a daemon, do the same — or send
`x-claude-board-secret` by hand.

Anything that deliberately speaks as an unauthorized caller must NOT go through that
wrapper: use `rawRequest`/`rawGet`, or `rawFetch`, which send exactly the headers they
are given. Raw `http.request` calls (SSE streams, the hang-up-mid-wait check) need the
header spelled out; there is no wrapper for them.

## `execFileSync` deadlocks against an in-process daemon

Several checks start the daemon with `startServer` inside the check's own process. A
synchronous spawn (`execFileSync`, `spawnSync`) that talks to that daemon blocks the
event loop the daemon needs to answer, so the child times out and the check fails with
"daemon is not reachable" — a message that names the wrong problem entirely. Use
`promisify(execFile)` and `await` it. `test/check-install.mjs` gets away with
`spawnSync` because its daemon is a separate process.

## A temp dir's spelling is not its realpath, and path confinement compares realpaths

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

## Two open flags macOS will not accept together

`src/resolve.mjs` opens every reference with `O_NOFOLLOW_ANY` — Apple's "refuse if ANY
component is a symlink", `0x20000000` in `<sys/fcntl.h>`, which Node does not export.
Two things about it:

- **`O_NOFOLLOW | O_NOFOLLOW_ANY` is `EINVAL`**, on every path including an ordinary
  regular file. They are alternatives, not a belt and braces; passing both fails every
  open with an errno that says nothing about symlinks.
- Because the number is hardcoded, a check has to prove it still *does* something —
  `test/check-pure.mjs` swaps a directory component for a symlink between the check and
  the read and asserts the open is refused. Without that, a wrong or retired constant
  degrades silently into no protection at all, which is the same failure shape as the
  `WatchPaths` entry above.

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
guards. Mutation-test anything layered like this — one green suite is not evidence that
both layers exist.

## An apostrophe inside `${VAR:-...}` swallows the rest of a bash script

`echo "roots: ${REF_ROOTS:-(none — inside a board's project directory only)}"` is a
syntax accident, not a string: inside `${par:-word}` bash treats `'` as a quote character
even though the whole expansion is already inside double quotes. Everything up to the
next apostrophe — comments included, across any number of lines — becomes part of that
string. The symptom in `install.sh` was a chunk of comment block printed to stdout and
`xml_escape: command not found` forty lines later, neither of which points anywhere near
the real line. `bash -n` does **not** catch it (the file still parses). Write the branch
out with a plain `if` instead of reaching for a `:-` default.

## A mutation helper that restores with `git checkout` eats uncommitted work

Ablation testing means mutate, run, restore — and the obvious restore is
`git checkout -- <files>`. That silently discards *any* uncommitted change to those
files, including the very edits under test. The failure is quiet and reads like a
result: the first mutation reports its expected failure, and every mutation after it
reports **nothing**, because the check file holding the new assertions was reverted
along with the source. "No output" looks like "no finding" rather than like "the
checks are gone", so a run that destroyed the work can be mistaken for a run that
cleared it.

Commit before mutating. Then `git checkout` restores to a tree that still contains
the work, and the helper is safe to loop. If the work genuinely cannot be committed
yet, copy the files aside and restore from the copies — never from git.

Cheap tell that this has happened: the ablations after the first all come back
clean. Real ablations rarely do.

## macOS TCC gates the daemon by *application*, and launchd's application is not yours

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

## A missing launcher bundle wedges launchd at `exit 78` and `kickstart` cannot fix it

The LaunchAgent's `ProgramArguments` is a single path into a bundle the installer
compiles: `~/Applications/claude-board.app/Contents/MacOS/claude-board`. If the plist
exists but that bundle does not, launchd cannot exec anything and parks the job:

    state = spawn scheduled
    runs = 3
    last exit code = 78: EX_CONFIG

**The cause, found 2026-08-01: running the check suite deleted it.**
`test/check-install.mjs` redirects everything install.sh/uninstall.sh touch into a temp
dir through seam env vars, and one env object — the "uninstall is safe to run on a
machine with nothing installed" check — was missing `CLAUDE_BOARD_APP_DIR`.
`uninstall.sh` fell back to its default, `$HOME/Applications`, and `rm -rf`'d the
developer's own launcher bundle, killing their daemon and the TCC grant pinned to that
bundle's signature. The suite reported all green. A narrow interrupted-install window
can produce the same state, but it is not what did. Fixed by adding the seam, plus a
final check that asserts the real `~/Applications/claude-board.app`,
`~/Library/LaunchAgents/claude-board.plist` and `~/.config/claude-board/secret` are
exactly as they were before the suite ran — a guard on the paths rather than on any one
env object, so the next spawn that forgets a seam is caught whichever seam it forgets.

`EX_CONFIG` here is launchd's, not the daemon's. Do not go looking for it in
`bin/daemon.mjs`: that file never exits 78, and grepping for it wastes a pass. The
daemon's own logs are no help either — the last lines in
`~/Library/Logs/claude-board/daemon.err.log` will be an ordinary clean shutdown from
whenever it last ran successfully, which reads like a healthy service and is not.

`launchctl kickstart -k gui/$(id -u)/claude-board` does **not** revive it, and worse, it
blocks: it waits for a service that will never come up, so it looks like a hang. `runs`
does not increment. The fix is to re-run `./install.sh`, which rebuilds and ad-hoc signs
the bundle (`install.sh:383-462`).

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

## A bare `kickstart` no longer picks up a source edit — only `./install.sh` does

Before 2026-08-04, `bin/daemon.mjs` ran straight out of the clone, so a plain
`launchctl kickstart -k gui/$(id -u)/claude-board` — no reinstall, no rebuild — was
enough to pick up an edit: kickstart just restarts the same `node` process pointed at
the same clone path, and node re-reads the file from disk on every start. That stopped
being true the moment `install.sh` started staging a COPY of `bin/daemon.mjs` and all of
`src/` into `claude-board.app/Contents/Resources` and pointing the launcher at the copy
(see SECURITY.md "Fixed 2026-08-04: the daemon's own code is now inside the signed
bundle" and ADR.md entry 15). A kickstart now restarts the same already-built binary,
which forks the same already-staged copy — an edit to the clone underneath it changes
nothing until `./install.sh` runs again, notices the payload digest moved, rebuilds and
re-signs the bundle, and only THEN does a fresh copy land in Resources.

The trap: this is easy to miss because the daemon still visibly restarts on a kickstart —
same pid churn, same log lines, same "daemon listening on 127.0.0.1:7391" — so nothing
about the symptom says "you are looking at old code." The tell is comparing behaviour
against the file you just edited, not against whether the process bounced. If you are
iterating on `src/` or `bin/daemon.mjs`, the loop is `./install.sh`, every time — not
`launchctl kickstart`, which is now only good for reviving a daemon that crashed or
hung on the code it already has. (The degraded, no-launcher path is the one exception:
there, `bin/daemon.mjs` still runs straight out of the clone, exactly as before, and a
kickstart alone is enough — see `install.sh` step 1b.)

`test/check-install-payload.mjs` pins the fixed behaviour directly: it edits a
throwaway clone's `src/server.mjs`, runs the ALREADY-BUILT launcher and asserts the old
code is what answers, then reinstalls and asserts the edit only takes effect after that.

## Reload-on-change fired on editor temp files, not just source edits (removed)

Historical, and part of why the mechanism is gone (entry above). Under
`CLAUDE_BOARD_RELOAD_ON_CHANGE=1` the daemon exited on any write beneath `src/` or
`bin/`, not just on a tracked source file, so atomic-save temp files tripped it. Real
lines from `daemon.err.log`:

    claude-board daemon exiting to reload: src/.!77431!render.mjs changed
    claude-board daemon exiting to reload: src/XXck9Zx4 changed
    claude-board daemon exiting to reload: bin/mcp.mjs.tmp.83112.78f737854daf changed

A single logical save bounced the daemon two or three times, and an `install.sh` run —
which stages through temp files inside the repo — bounced it repeatedly while it worked.
If you are reading an old `daemon.err.log`, that is what those lines are; a current
daemon never writes them.

## The board's notification works; macOS Focus is what hides it

`notifyRound` (`src/ui.mjs:3069`) fires on an SSE round push into a hidden or unfocused
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
- `notifyRound` requests permission only from the hidden/unfocused branch, the one moment
  Chrome will not raise a foreground prompt. Chrome queues it until the tab is next shown,
  so it does eventually appear — but a reviewer who dismisses that queued prompt is stuck
  at `default` with no other request site in the codebase. See `SPEC_NOTIFY.md`.

Verifying it end to end takes a hidden tab: post a second round to an existing board while
the reviewer is in another app. A round pushed into a visible, focused tab correctly
notifies nothing, so testing with the board in front of you proves the wrong thing.

## A `check-mcp.mjs` fixture with no question block no longer blocks on `/wait` (ticket 01)

Since `ask`'s return condition is derived from the round's own blocks (SPEC_MIGRATION.md
criterion 1: a round carrying a question block blocks until submit, a content-only round
returns the instant the post succeeds), any check that means to exercise `blockingWait` —
a timeout path, a restart-reattach, a cancellation, anything that expects the call to still
be pending after the post — MUST include at least one `kind: 'question'` block among what it
posts, or the call returns immediately with `status: 'posted'` before ever reaching
`/api/board/:id/wait`. This bit the wall-clock-timeout check directly: it posted
`blocks: [{ kind: 'markdown', text: '# never answered' }]` (content only, no question) to
prove the call still resolves after `CLAUDE_BOARD_TIMEOUT_MS`, and after ticket 01 that call
now resolves near-instantly with `status: 'posted'` instead — the timeout path was never
reached, and the assertion on `result.status === 'timeout'` failed for a reason that has
nothing to do with the timeout mechanism itself. Fixed by adding `QUESTION` to that fixture's
blocks. The general form: a fixture's *shape*, not just its content, can be load-bearing for
which return path a check exercises — same family as this file's other "the check's own
model of the system stopped matching reality" entries, just one level more mundane.

## A function declared inside `wireRoot` is invisible from a page-scoped listener, and the failure is silent

Historical record of a real trap, kept even though the specific code that surfaced it is gone
(see the next entry for why it went): `src/ui.mjs`'s `window.addEventListener('message', ...)`
(the parent's half of the html-stage postMessage protocol) is registered ONCE, at the client
script's outer scope — deliberately outside `wireRoot(root)`, since a stage's `'ready'` can
arrive at any time, not just at a `wireRoot` pass (see that listener's own comment). `wireRoot`
itself is a separate, nested function, re-run on every hydrate and every SSE push. An earlier
version of the `choose-between-rendered-variants` widget (SPEC_MIGRATION.md criterion 2) had a
stage-reported message call `selectVariant`, the widget's shared selection path — and since
BOTH the message listener and something inside `wireRoot` needed to call it, it had to be
declared at the OUTER scope too, or the message listener's own call to it throws
`ReferenceError: selectVariant is not defined`. Declaring it inside `wireRoot` alongside the
`.choice-variant` click/keydown wiring (the natural-looking place, since that was its other
caller at the time) compiled fine and the plain-click/keyboard paths worked perfectly — only
the stage-message path was broken, and silently: `stageAgentScript`'s (`src/render.mjs`)
`post()` helper wraps every `window.parent.postMessage(...)` call in a `try/catch` meant for
"no parent reachable", but `test/dom-stand-in.mjs`'s postMessage delivery is **synchronous**
(dispatched inline, not queued — same as a real same-process `srcdoc` frame), so the parent
listener's `ReferenceError` unwound straight back through `postMessage` into that same `catch`,
several stack frames away from where it was thrown, and vanished with no trace. The symptom was
not a crash: a real click inside a nested html stage's mock simply selected nothing, no error
anywhere, while the identical plain click directly on the card's own chrome worked correctly —
caught only by running the actual end-to-end gesture and bisecting with `console.log`
statements planted on both sides of the suspected call, since nothing in the failure pointed at
scope. A regex-only structural check (asserting the call site's source text, never executing
it) would not have caught this at all. The general lesson, one layer past QUIRKS.md's own
"Criterion 12's html-stage half is checked by reading its source" entry above, survives the
feature that taught it: a helper shared between a page-scoped listener and `wireRoot`'s
per-pass wiring has to live at the scope BOTH of them can reach, and the one caller that's easy
to forget is the one registered furthest from where the helper naturally reads like it belongs.
`selectVariant` itself is back inside `wireRoot` now (its only caller once the entry below took
the stage-message path away), so nothing in the current code demonstrates this trap directly —
the next feature that shares a helper between `wireRoot` and a page-scoped listener will.

## A stage-posted message is agent-authored input, never evidence a human did anything

Directly downstream of the entry above, and the reason its own feature no longer exists: the
`selectVariant` call the previous entry describes was reachable from `window.addEventListener
('message', ...)` because an earlier version of `choose-between-rendered-variants`
(SPEC_MIGRATION.md criterion 2) had `stageAgentScript` (`src/render.mjs`) report every click
inside an html-kind option's mock over `postMessage`, unconditionally, so a click on the
visible mock content — not just the card's own chrome outside the iframe — could pick that
option. Caught in director review before the ticket merged, not by any check: every message on
this channel is content the AGENT authored (the mock's own HTML, and the script this project
deliberately lets it run — `sandbox="allow-scripts"`), so the html stage's own script can
dispatch a click on itself with no reviewer involved at all (an autoplaying demo, an animation,
a mock that clicks its own button — ordinary content for `/example`'s real interactive
mockups), and separately, `cb: 'cb-stage'` is a fixed, documented public string, so the stage's
own script can call `window.parent.postMessage({cb:'cb-stage', type:'select'}, '*')` directly,
skipping the click handler entirely. This project's whole origin/identity validation
(`src/render.mjs`'s "ORIGIN VALIDATION" design comment) proves a message came from a live,
correctly-addressed stage — it was never designed to, and cannot, prove a human clicked
anything; an `ev.isTrusted` check on the stage's OWN click listener would have closed only the
first path, since the second forges the message itself, upstream of any such guard. The fix was
to delete the channel rather than guard it: there is no message type left that could ever
select an option, and an html option's iframe is rendered `pointer-events: none` inside a
`.choice-variant` card (`src/styles.mjs`) so a genuine, trusted click over the visible mock
lands on the card in the parent document instead, which is the only thing that can ever record
a pick. `test/check-stage-isolation.mjs` proves a forged message from a live, correctly-
addressed stage — the exact shape that would have exploited this — is now inert. The general
form, worth carrying into anything this project ever lets a stage report to the parent: a
message's ORIGIN and IDENTITY being provably a real stage says nothing about WHETHER A HUMAN
ACTED — those are orthogonal questions, and only the second one decides whether a message may
ever be allowed to make a decision (an answer, a selection) rather than merely propose one (a
comment anchor a human still has to submit, geometry, a hover hint).

## `git tag <name>` fails with "no tag message?" — `tag.gpgsign` is on

A bare, lightweight `git tag backup/pre-squash-main main` dies with `fatal: no tag message?`
even though no `-a`/`-m` was passed. The cause is global config `tag.gpgsign true`: signing
forces the tag to be an annotated object, and an annotated tag with no message is an error.
The message names the missing message, never the config, so it reads like a syntax mistake.
Either pass `-m` (`git tag -m 'why' <name> <commit>`), or — for a throwaway safety ref before
a history rewrite — use `git branch <name> <commit>` instead, which takes no message and is
just as easy to delete afterwards.

## Sizing a C array from `sizeof(arr)/sizeof(arr[0])` held in `static const int` is a VLA

`bin/launcher.c` builds the child's `envp` from two tables, and the natural way to size it is
`char *envp[OVERRIDE_ENV_N + PASSTHROUGH_N + 1]` where `OVERRIDE_ENV_N` is
`(int)(sizeof(OVERRIDE_ENV) / sizeof(OVERRIDE_ENV[0]))`. If that division lives in a
`static const int` (the same pattern the file already used for `FORWARDED_N`, which is fine
there because `FORWARDED_N` is only ever a loop bound), clang accepts it but warns:
`variable length array folded to constant array as an extension [-Wgnu-folding-constant]`. A
`const int` is not a compile-time constant expression to a strict C compiler even when its
initializer plainly is one, so using it to size an array makes that array a VLA — silently
accepted here as a GNU/Clang extension, but a warning `install.sh`'s `-Wall` build would then
carry forever. Fix: an `enum { OVERRIDE_ENV_N = (int)(sizeof(...)/sizeof(...[0])) };` instead —
an enum constant IS a real compile-time constant, same value, zero warning. Only matters when
the count is used to size something; a plain loop bound (`for (int i = 0; i < FORWARDED_N; i++)`)
never triggers this and does not need the enum treatment.

## `DYLD_INSERT_LIBRARIES` (and friends) act on the process being loaded, not on what that process execs

Testing that `bin/launcher.c`'s new execve-built environment drops `DYLD_INSERT_LIBRARIES`
before handing it to node, the obvious move is to spawn the compiled launcher with
`DYLD_INSERT_LIBRARIES=/tmp/does-not-exist.dylib` in its OWN environment and check the string
never reaches the child. That crashes the launcher itself instead, before a single line of its
`main()` runs:

    dyld[...]: terminating because inserted dylib '/tmp/does-not-exist.dylib' could not be
    loaded: tried: ... (no such file) ...

`DYLD_*` variables are read by `dyld` while loading whatever process they are set on — here,
the launcher binary the test harness spawns — not by that process's own code, and not only by
whatever it later `exec`s. There is no C code in `launcher.c` that runs before dyld has already
either honoured or refused the variable against the launcher's own image. This is also, in the
real deployment, a gap this fix does not close: if an attacker's plist set
`DYLD_INSERT_LIBRARIES` on the launcher itself (`ProgramArguments` names the launcher, and
launchd would apply `EnvironmentVariables` to the process it execs, which is the launcher, not
node), dyld would act on it before `main()` ever got a chance to build the filtered `envp` this
fix is about — closing that would mean hardened-runtime signing the bundle, a signing change
out of scope here and with its own TCC/entitlement consequences. The fix in this repo is scoped
to what the launcher hands node, not to what launchd (or anything else) hands the launcher.
For the test: point `DYLD_INSERT_LIBRARIES` at a dylib that actually exists and is harmless to
load (e.g. `/usr/lib/libgmalloc.dylib` — present on every macOS install, loads without
incident) so dyld succeeds and the test is about `launcher.c`'s filtering, not about dyld's
own refusal of a bad path.

## `el.hidden = true` does nothing when a class in our own stylesheet sets `display`

The pomodoro Pause/Resume button was `class="mode-toggle" hidden`, and `renderPomodoro` flipped
`toggleBtn.hidden` to hide it whenever no timer was running. It never hid. `[hidden] { display:
none }` lives in the **UA stylesheet**, and author styles beat UA styles outright regardless of
specificity — `.mode-toggle { display: inline-flex; }` (`src/styles.mjs`) wins every time. The
button rendered as an empty accent-less pill with no label, and clicking it did nothing, because
the click handler bailed on `!pomodoroDoc.timer`. It looked like a dead control, and it was
reported as "the toggle isn't working"; nothing in the JS was wrong at all.

The trap is that `hidden` reads like a property with its own force, the way `disabled` has. It
has none: it is a plain attribute whose entire effect is one low-priority UA rule that any
author `display` declaration silently overrides. It bites specifically when a component wearing
a shared chrome class (`.mode-toggle`, `.btn`, anything with `display: flex`/`inline-flex`)
later grows a "sometimes hidden" state — the class predates the state, so nobody rereads it.

Three ways out, in order of preference here: (1) don't have a hidden state — give the control
something to do in every state, which is what the switch that replaced this one does; (2) add
`[hidden] { display: none !important; }` to the stylesheet once, globally; (3) toggle a class
of your own rather than the attribute. What must NOT be done is trusting a check that asserts
`el.hidden === true`: the DOM property round-trips perfectly while the element stays on screen,
so such a check passes against a control the user can plainly see. `test/dom-stand-in.mjs`
models the property, not the cascade, so it cannot catch this either — the assertion that does
is on the emitted markup and on the fact that nothing relies on `hidden` at all.

## A bundle's notification identity belongs to `CFBundleExecutable`, and to nothing else in it

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

## A freshly installed app bundle cannot post a notification until LaunchServices knows about it

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

## `soundNamed:` searches `/System/Library/Sounds` and does NOT search the app bundle — the documented search path is backwards

Apple documents `[UNNotificationSound soundNamed:]` as resolving a bare name against the
posting app's own `Contents/Resources` and against `Library/Sounds`, and explicitly not
against `/System/Library/Sounds`. On macOS 26.5 it is the other way round, in both halves:
a bare name resolves against `/System/Library/Sounds`, and a file that exists *only* in the
posting bundle's `Contents/Resources` does not resolve at all. Copying the system sounds into
a bundle to make them nameable is therefore not merely unnecessary, it does not work.

The trap has teeth because the documented behaviour is the conservative-sounding one, so a
design that assumes it looks safe and costs megabytes for nothing. ADR.md entry 20 was written
on that assumption and this measurement is what it was waiting on.

**How it was measured.** A throwaway ad-hoc-signed bundle (`CBSoundProbe.app`, its own
`CFBundleIdentifier`, `LSBackgroundOnly`, one ObjC binary that is the bundle's own
`CFBundleExecutable` — the entry two above says why it has to be) posting one notification per
run with `content.sound = [UNNotificationSound soundNamed:argv[1]]`.

Two things about the rig, both of which cost a run to find. The probe cannot live in `/tmp`:
LaunchServices registers a bundle there — `lsregister -f` succeeds and `lsregister -dump`
shows the record — but never binds it, and `usernoted` then fails the client with
`Failed to find or validate client of identifier ...`, surfacing to the caller as the same
`Notifications are not allowed for this application` string as the two traps above. Moving the
identical bundle to `~/Applications` fixed it. And `NotificationCenter` rate-limits sounds
(`Can't play sound, played a sound 0.17s ago`), so variants posted back to back silence each
other; leave a few seconds between them.

**The observable, no ears required.** `systemsoundserverd` logs the absolute path of the file
it is handed, and the byte count, so the log says which file played and not merely that one
did:

```sh
log stream --level debug --style compact \
  --predicate 'process == "usernoted" OR process == "NotificationCenter" OR eventMessage CONTAINS[c] "aiff"'
```

```
NotificationCenter [com.apple.unc:sound] Playing notification sound { nam: Glass } for com.example.cbsoundprobe
NotificationCenter [com.apple.unc:sound] Playing sound Glass.aiff for 3B8423D3
systemsoundserverd [com.apple.coreaudio:sss] SSServerImp.cpp:1510 clientPID 873(NotificationCent), ssid 4104,
  audio data size 475278, audio file path /System/Library/Sounds/Glass.aiff
```

**What each variant did**, on macOS 26.5 (25F84), sounds unmuted, no Focus:

| `soundNamed:` argument | `Contents/Resources` | played |
| --- | --- | --- |
| `Glass.aiff` | empty | `/System/Library/Sounds/Glass.aiff` |
| `Glass` | empty | `/System/Library/Sounds/Glass.aiff` |
| `Glass.aiff` | **`Basso.aiff` copied in as `Glass.aiff`** | `/System/Library/Sounds/Glass.aiff` |
| `Glass` | same decoy staged | `/System/Library/Sounds/Glass.aiff` |
| `OnlyInBundle.aiff` | that file, and only there | **nothing** |
| `NoSuchSoundAtAll.aiff` | empty | **nothing** |

The decoy row is the one that makes this a measurement rather than an inference: the bundle
held a file with the requested name and lost anyway, and the logged size (475278 bytes, exactly
`/System/Library/Sounds/Glass.aiff`; the decoy is 221376) says which file won without anyone
having to listen. `~/Library/Sounds` was checked separately and *is* searched — a file dropped
there resolved by name and logged its own path.

**The extension is optional and is not part of the name.** `Glass` and `Glass.aiff` both play
`/System/Library/Sounds/Glass.aiff`; `unc:sound` logs the argument verbatim (`{ nam: Glass }`)
and then logs `Glass.aiff` one line later, so macOS appends the suffix itself. Either spelling
is safe, which also means a picker that stores names with the extension and one that stores
them without are equally correct — pick one and be consistent, because nothing downstream will
complain about the other.

**An unresolvable name is silence, not the default sound.** Resolution goes through
ToneLibrary, which answers with `Tone with identifier '<name>' is neither in of the collections
for system or iTunes tones` and `-toneWithIdentifierIsValid: Returning NO`; no
`systemsoundserverd` call follows. The banner still appears, correctly, with no sound at all.
So a typo'd or removed sound name degrades to a silent notification and logs one error line
nobody is watching — which is why the name offered to a reader has to come from reading
`/System/Library/Sounds` rather than from a list typed out by hand.
