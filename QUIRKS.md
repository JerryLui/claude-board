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

## No external assets, ever

`renderBoardPage` output must open from Finder with the network off. The page test
rejects any `<link rel=stylesheet>` or `<script src=>`, so: no web fonts (system
stack only), no icon fonts, no CDN CSS. Icons are inline SVG. Mermaid is the one
exception — it is imported at runtime from a CDN and degrades to raw source when it
cannot be reached.

## Two stylesheets, one palette

The html-stage iframe is sandboxed and the page's tokens deliberately do not reach
into it. Its hover-highlight rule is built with a hardcoded hex, and mermaid's
`themeVariables` are hardcoded too. Both must be updated by hand when `--accent` /
the surface tokens change in `src/styles.mjs`. Ticket 10 (SPEC_ANCHORING.md)
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

## Preview harness

There is no dev server for the rendered page. To eyeball UI changes, write a
throwaway script that calls `createBoard` / `addRound` / `renderBoardPage` and dumps
the HTML somewhere, then serve that directory over http — Chrome automation refuses
`file:` URLs. Do not serve out of `/tmp` on this machine: a stray `/tmp/inspect.py`
shadows the stdlib and breaks `python3 -m http.server`.
