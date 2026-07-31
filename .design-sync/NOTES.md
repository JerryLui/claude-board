# design-sync notes — claude-board

Synced to claude.ai/design project **Claude Board**
(`33c7d8a0-58b6-417d-9a6b-80ce1f3dedd3`). First sync: 2026-07-31.

## What this repo is, for sync purposes

claude-board is **not a React component library** — it renders HTML server-side from
template strings in `src/render.mjs`, with CSS as a template string in `src/styles.mjs`.
It therefore syncs on the converter's documented **tokens-only** path
(`lib/source-kit.mjs` → `[ZERO_MATCH] … treating as tokens-only DS`):

- `_ds_bundle.js` is **empty by design**. `window.ClaudeBoard` has no exports. This is
  correct, not a build failure — do not "fix" it by authoring React components. The
  skill is explicit that reimplementing components is out of scope.
- The value shipped is the 51 tokens, both palettes, and the 123-class stylesheet,
  plus `conventions.md` teaching the design agent to build with them.
- `components/` is empty and there are no preview cards to author or grade.

## The CSS has to be extracted before every build

There is no `.css` file on disk for `cfg.cssEntry` to point at. `.design-sync/extract-css.mjs`
imports `src/styles.mjs` and writes two files into the gitignored `.design-sync/css/`:

- `claude-board.css` — the full sheet, verbatim (`cfg.cssEntry`)
- `tokens.css` — token blocks only (`cfg.tokensGlob`)

**Run it before the converter, every time** — it is wired as `cfg.buildCmd`. The bytes
are the repo's own; the script is not a transform.

`tokens.css` lifts the shared non-color `:root` block (radii/spacing/motion) out of
`styles.mjs` by regex rather than restating the values, so they cannot drift. If that
block is ever renamed or its leading comment changed, the script prints a warning and
the token file silently loses radii/spacing/motion — **heed that warning.**

## The display cards

`.design-sync/make-boards.mjs` builds 5 sample board cards into
`ds-bundle/components/Boards/`. The **content is invented**; the **markup is not** —
each card is `renderBoardPage(createBoard(...))` with the head rebuilt, the client
script cut, and the uploaded `styles.css` linked instead of the inline `<style>`. So
the cards track `src/render.mjs`: change the board's markup and they change with it.

**Run order matters**: `package-build.mjs` wipes `--out`, so `make-boards.mjs` must run
*after* it, every time. The full sequence is in the script's header comment.

It patches three local files the converter owns, because 5 off-script cards exist that
the converter does not know about:

- `.ds-build-meta.json` `componentCount` → 5, or validate fails `count mismatch`.
- `.stories-map.json` `components` → the 5 entries, so validate's recompute pass
  actually checks them.
- `_ds_sync.json` `renderHashes` → computed with the converter's own `renderHashFor`,
  so a hand-edited or dropped card trips `[SYNC_STALE]` instead of the anchor silently
  vouching for output that no longer exists.

All three are dot-prefixed or local-only; **no claim about importable components
reaches the project**. `_ds_sync.json` does upload, and its hashes are honest — they
describe cards that really are there.

Cards are static by design: no hydration, no SSE, no mermaid CDN fetch, so the DS pane
gets no console errors. **Mermaid blocks are deliberately not used in any card** —
mermaid renders client-side, so without the script it would show raw diagram source.

## Setup quirks

- claude-board has **no `node_modules`** (zero runtime deps), but the converter requires
  `--node-modules`. Fix: the staged `.ds-sync/node_modules` holds the converter's own
  deps, and the repo is self-linked into it —
  `ln -sfn ../.. .ds-sync/node_modules/claude-board` — so `PKG_DIR` resolves to the repo.
  **Recreate this link on every fresh clone**; it is gitignored.
- `cfg.tokensGlob` is ignored unless `cfg.tokensPkg` is also set (see `lib/css.mjs`
  `copyTokens`: it returns early on `!tokensPkg`). Hence `"tokensPkg": "claude-board"` —
  the repo is its own tokens package via the self-link. Without it `tokens/` comes out
  empty and `styles.css` has only one `@import`.
- Shell cwd persists between tool calls; `cd .ds-sync` once and later relative paths
  break. Use absolute paths.

## Known warnings — both accepted, both expected

- **`[FONT_MISSING]` "JetBrains Mono"** — accepted by Jerry, 2026-07-31: ship no fonts,
  take the system fallback. This matches the repo's own standing policy (`src/styles.mjs:6`
  and QUIRKS.md "no external assets, ever") — the board must render identically from a
  `file:` archive with the network off. Consequence, accepted: designs in Claude Design
  render in the host's system fonts, which on a non-macOS host will not match SF Pro /
  SF Mono. Revisit only if designs look visibly wrong; the fix is `cfg.extraFonts` with
  Inter + JetBrains Mono woff2 (both SIL OFL).
- **`[RENDER_SKIPPED]`** — accepted by Jerry, 2026-07-31: playwright not installed
  (~200MB) because there are **zero previews to render** on a tokens-only sync. Validate
  still checks the bundle, the `styles.css` import closure, and token resolution. If this
  repo ever grows real components, install playwright and drop `--no-render-check`.

## Not a defect: emitted classes with no CSS rule

`src/render.mjs` emits several classes that `src/styles.mjs` never rules on —
`mode-toggle-label`, `choice-single` (JS selectors, see `src/ui.mjs`), and
`compare-block`, `code-line`, `markdown-block` (semantic wrappers). Their visual
styling comes from sibling classes (`.compare-side`, `.code-block`, `.md`,
`.card-choice`). `test/check-pure.mjs` enforces the *other* direction — no rule for a
class the markup never emits — so unstyled hook classes are expected. A card audit that
greps every emitted class against the CSS will flag these five; they are fine.

## Re-sync risks

- **`conventions.md` enumerates 72 class names and ~50 tokens by hand.** If `src/styles.mjs`
  renames or drops any of them, the header silently lies to the design agent and it will
  emit class names that resolve to nothing. **Re-run the name validation on every sync**
  (the one-liner is in the sync transcript: parse the header's token/class names, grep
  each against `ds-bundle/_ds_bundle.css` + `tokens/tokens.css`). A checker regex of
  `--[a-z0-9-]+` also matches markdown table rules (`---`) — that hit is a false positive.
- The class table is **curated, not exhaustive** — 72 of 123. Classes omitted are internal
  (`.e`, `.mjs`, `.cb-*`, `.has-pending`, `.zero`). Adding a genuinely new UI surface to
  the board means deciding whether it belongs in the table.
- `--head-clear` and `--scrollbar-hover` are deliberately undocumented in the header:
  internal mechanics, not design vocabulary.
- The converter's `[NO_DIST] synthesizing from 0 src files` line is expected — `src/` has
  no `.tsx`/`.jsx`, so the synthesized entry is empty and the bundle is empty. Not an error.
- Nothing here depends on network fetches at build time.
- **The cards depend on `renderBoardPage`'s page shape.** `make-boards.mjs` slices the
  body between `<body>` and `<script id="board-data"`. If `src/render.mjs` moves that
  script or renames it, the slice throws with a named error rather than emitting a
  broken card — but it *will* stop the sync until fixed. Same for the `PROMPTS` table:
  adding a board without an entry throws.
- The cards' `.prompt.md` files describe class recipes by hand. Same rot risk as
  `conventions.md` — re-read them against the markup if the renderer changes.
