# claude-board

A review surface: the agent posts questions and rendered context, the human answers
them all on one page and submits once. Calm, dense, dark-first. One accent, layered
surfaces, hairline borders, motion only where it explains a state change.

## There are no importable components

`window.ClaudeBoard` is **empty by design**. claude-board renders its HTML server-side
from template strings, so this design system ships **tokens and a stylesheet, not a
React library**. Do not try to import components from it — there are none.

Build with ordinary JSX/HTML elements and style them from the vocabulary below. No
provider, no wrapper, no theme setup: the tokens live on `:root` in `styles.css`, so
anything under it is already themed.

## Style from tokens, never raw values

Every rule in this system reads a `var(--*)` token — the repo enforces it in CI
(`test/check-pure.mjs` fails the build if a hex or rgba literal leaks into a rule).
Follow the same discipline: **no raw colors, radii, spacing, or durations.**

**Surfaces** (climb toward the viewer): `--bg` `--bg-tint` `--panel` `--panel-2`
`--panel-3`. Plus `--history-bg` (collapsed past rounds), `--stage-bg` (the embedded
HTML stage's artboard: a neutral, per-palette surface — a mock owns its own
background, and this is only what shows through one that paints none),
`--bg-fade-0` / `--bg-fade-80` (gradient masks).

**Ink**: `--ink` (primary) `--ink-2` (secondary) `--muted` (tertiary) `--code-ink`.

**Lines**: `--hairline` `--hairline-2` — alpha-based, so they read correctly on every
surface level. Borders are `1px solid var(--hairline)`, near-universally.

**Accent** (one, used sparingly): `--accent` `--accent-hi` `--accent-soft`
`--accent-glow` `--accent-underline` `--accent-select` `--accent-ink` (text ON accent).

**Status**: `--good`; `--warning` with `--warning-soft` `--warning-ink`
`--warning-border` `--warning-line` `--warning-border-strong` `--warning-ring`
`--warning-fade`; `--critical` with `--critical-soft` `--critical-border`.

**Elevation**: `--shadow-1` `--shadow-2` `--ring` (focus).

**Radii**: `--r-sm` 6px, `--r-md` 10px, `--r-lg` 14px, `--r-pill` 999px.

**Spacing** (dense end of standard — this is a working surface): `--space-1` 4px,
`--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-5` 24px, `--space-6` 32px.

**Motion**: `--dur` 160ms, `--ease` `cubic-bezier(0.16, 1, 0.3, 1)`. Transition only
the properties that changed; never `all`.

## Theming

Dark is the default (`:root`). Light takes over under `@media (prefers-color-scheme:
light)` and can be forced with `<html data-theme="light">`; `data-theme="dark"` pins
dark. The light palette is designed against the accent, **not** a mechanical inversion.
Both are defined in `tokens/tokens.css`; every token exists in both, so reading tokens
is all it takes to be theme-correct.

## Type

Body: `14px/1.6 "Inter var", Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text",
ui-sans-serif, system-ui, sans-serif` with `font-feature-settings: "cv05" 1, "ss01" 1`.
Mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`.
**No web fonts ship** — the board must render identically offline, so these resolve
against the host. Interactive elements set `font: inherit` (a `<button>` does not
inherit family on its own).

## Class vocabulary

These are the board's real classes, in `_ds_bundle.css`. Reuse them when you are
building the surface they belong to; write your own class names for layout glue, styled
from the tokens above.

| Family | Classes |
|---|---|
| Shell | `board-shell` (max-width 1120px, centered) `board-head` (sticky) `board-head-title` `board-head-actions` `index-shell` `index-head` |
| Round | `round` `round-badge` `round-label` `round-open` `round-history` |
| Question | `question-block` (2-col grid: prompt / context) `question-main` `question-prompt` `question-context` `question-footer` |
| Blocks | `block` `block-kicker` `blocks` `md` `md-content` `code-block` `html-stage` `mermaid-block` |
| Choice | `options` `opt-label` `opt-main` `opt-desc` `opt-check` `card-choice` `choice-multi` `opt-preview` `opt-preview-code` `opt-preview-img` |
| Rank | `rank-list` `rank-grip` `rank-index` `dragging` |
| Text answer | `answer-textarea` `answer-status` `note-field` |
| Buttons | `btn-send` (accent, the primary action) `btn-discuss` (secondary) `btn-defer` (pill) `send-bar` `send-status` |
| Comments | `comment-btn` `comment-form` `comment-list` `comment-item` `comment-anchor` `comment-pending` `comment-delete` `anchor-pin` `anchor-target` |
| Lens | `lens-stage` `lens-bar` `lens-btn` `lens-canvas` `lens-pct` `lens-hint` `diagram-lens` |
| State | `empty-state` (dashed border) `pending-badge` `live` `live-dot` `readonly` `readonly-banner` `selected` `active` `open` `missing` |

## Read the real thing

`styles.css` and its imports (`tokens/tokens.css`, `_ds_bundle.css`) are the truth —
read them before styling anything non-obvious. They carry the exact values and the
comments explaining why each one is what it is.

## Idiomatic snippet

```jsx
<div className="board-shell">
  <div className="block">
    <div className="block-kicker">Context</div>
    <p className="md-content">Which migration order should we take?</p>
  </div>
  <div
    style={{
      display: 'flex',
      gap: 'var(--space-3)',
      padding: 'var(--space-4)',
      background: 'var(--panel)',
      border: '1px solid var(--hairline)',
      borderRadius: 'var(--r-md)',
    }}
  >
    <button className="btn-send">Send</button>
    <button className="btn-discuss">Discuss in chat</button>
  </div>
</div>
```
