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
In its place, `bin/daemon.mjs` watches its own `src/` and `bin/` and exits the moment
either changes — the one thing that actually composes with `KeepAlive`, which then
brings it straight back up running whatever is now on disk. Opt-in via
`CLAUDE_BOARD_RELOAD_ON_CHANGE=1`, which only `install.sh`'s generated plist sets;
every other caller of `bin/daemon.mjs` (this check suite, a shim's own daemon spawns,
running it by hand) gets the old behaviour — no self-exit — because a daemon that
vanishes on any file event under an unrelated harness is a new flake source, not a fix.
launchd will not restart a job more than once per 10s, so two edits inside one 10s
window collapse into a single restart; the second edit's reload waits out the rest of
that window rather than happening immediately. `test/check-install.mjs` now spawns a
real daemon with the env var set, touches a file under a temp copy of `src/`, and
asserts the process actually exits — and asserts the negative (env var unset, no exit)
— rather than reading the plist. If you still want the daemon back on your own
schedule rather than waiting on a save:

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
diagram lens (SPEC_POLISH.md ticket 05) copied it. While a capture is active Chrome
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
  the round badge's position-tracking half, SPEC_POLISH.md ticket 04) guards on
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

`test/check-pure.mjs`'s check on `stageAgentScript()` (SPEC_POLISH.md ticket 02,
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

SPEC_POLISH.md ticket 02 added a second stage-side rule next to that one:
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

SPEC_POLISH.md ticket 05 added no third place: the diagram lens's own chrome is
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
