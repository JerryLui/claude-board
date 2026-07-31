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

## `WatchPaths` does not restart the daemon, and never has

The plist carries both `KeepAlive` true and `WatchPaths` on `src/` and `bin/`, and the
second one is inert. `WatchPaths` tells launchd to *start* a job when a watched path
changes; a job that is already running — which `KeepAlive` guarantees — is simply not
started again. Measured 2026-07-30: the daemon had 3h40m of uptime across an in-place
edit to `src/store.mjs`, and neither creating nor deleting a file under `src/` moved its
pid either. So editing code does **not** reload the service, and a stale daemon is
indistinguishable from a working one until you read the page it serves.

After any edit under `src/` or `bin/`, restart it yourself:

```sh
launchctl kickstart -k gui/$(id -u)/claude-board
```

`test/check-install.mjs` asserts the plist *contains* those `WatchPaths` entries, which
is true and beside the point. That is the fourth recorded instance on this project of a
green check sitting on top of a dead mechanism, and the second where the check asserted
structure while the behaviour was absent.

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

## No external assets, ever

`renderBoardPage` output must open from Finder with the network off. The page test
rejects any `<link rel=stylesheet>` or `<script src=>`, so: no web fonts (system
stack only), no icon fonts, no CDN CSS. Icons are inline SVG. Mermaid is the one
exception — it is imported at runtime from a CDN and degrades to raw source when it
cannot be reached.

## Two stylesheets, one palette

The html-stage iframe is sandboxed and the page's tokens deliberately do not reach
into it. Its hover-highlight rule is built with a hardcoded hex, updated by hand
when `--accent` / the surface tokens change in `src/styles.mjs`. Mermaid's
`themeVariables` no longer are: `mermaidThemeVariables()` (`src/ui.mjs`) now reads
live computed style through a mermaid-variable -> CSS-token map
(`MERMAID_TOKEN_MAP`), so a palette change reaches it with nothing to update by
hand. Ticket 10 (DESIGN.md)
dropped `allow-same-origin` from the iframe and moved the hover rule from
`wireHtmlStage` (`src/ui.mjs`, since deleted — the parent can no longer reach
`contentDocument` at all) into `stageAgentScript` (`src/render.mjs`), the
stage-side agent injected into every html block's `srcdoc`. The hex lives there
now; the "update by hand" trap is unchanged, only the address moved.

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
