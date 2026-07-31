// Page CSS for the board, exported as a string so render.mjs can inline it and the
// page stays a single self-contained file. A calm review surface: one accent,
// layered surfaces, hairline borders, and motion only where it explains a state
// change. Dark by default; a light palette (designed against the accent, not a
// mechanical inversion) takes over under `prefers-color-scheme: light` — see the
// DARK/LIGHT objects below. No web fonts and no external assets — the standalone
// `file:` archive has to look identical with the network off (see src/render.mjs).
//
// Everything is driven by the tokens in `:root`. Rules below reference tokens, never
// a raw hex or rgba literal, so a palette change is a one-block edit (enforced by
// test/check-pure.mjs, which fails the build if one leaks back in). Note that
// test/check-pure.mjs also asserts every class ruled on here is a class the markup
// actually emits — a rule for a class nothing renders is a failure, not dead code.

import { MERMAID_NODE_SELECTOR } from './anchor.mjs';

/** Scope the shared mermaid-node selector list under a prefix. The selector is two
 * alternatives (mermaid 11's prefixed ids and mermaid 10's bare ones), so it cannot
 * simply be concatenated onto a prefix — each alternative needs its own full rule.
 * Single-sourced from src/anchor.mjs so the CSS that draws the affordance and the JS
 * that handles the click can never again disagree about what a node looks like. */
const mermaidNodeRule = (prefix, suffix = '') =>
  MERMAID_NODE_SELECTOR.split(',').map(s => `${prefix}${s.trim()}${suffix}`).join(',\n');

// Both palettes are plain data: the same key set, one color value each. That is
// what makes a palette change a one-block edit (DESIGN.md acceptance criterion 6)
// no matter how many CSS rules end up referencing a token, and it is what lets
// test/check-contrast.mjs assert the contrast bar by importing these objects
// directly instead of regexing them back out of a CSS string. Every dark value
// below is byte-for-byte what ticket 01 shipped, except --muted: measured at
// 4.45:1 on --panel-2 and 4.03:1 on --panel-3 (both below the 4.5:1 bar, and
// --muted genuinely sits on both), so it moves to the minimal same-hue lift that
// clears 4.5:1 everywhere it's used (acceptance criterion 2).
const DARK = {
  // surfaces: bg is the page, surface climbs toward the viewer
  '--bg': '#0a0e15',
  '--bg-tint': '#101726',
  '--panel': '#131a27',
  '--panel-2': '#18202f',
  '--panel-3': '#1e2839',
  '--scrollbar-hover': '#2c3852',
  '--history-bg': 'rgba(19, 26, 39, 0.55)',
  '--stage-bg': '#fff',

  // bg at partial alpha, for the two gradient masks that fade content into --bg.
  // Plain CSS can't derive these from var(--bg) portably (no color-mix() here --
  // this page has to render identically in whatever browser opens a file:// copy
  // of it), so they're their own tokens, tracked by hand alongside --bg.
  '--bg-fade-0': 'rgba(10, 14, 21, 0)',
  '--bg-fade-80': 'rgba(10, 14, 21, 0.8)',

  // ink
  '--ink': '#eaeef6',
  '--ink-2': '#b6bfd0',
  '--muted': '#8690a2',
  '--code-ink': '#cfd8ea',

  // lines: alpha, so they read correctly on every surface level
  '--hairline': 'rgba(255, 255, 255, 0.075)',
  '--hairline-2': 'rgba(255, 255, 255, 0.14)',

  // one accent, plus semantic status colors
  '--accent': '#7c9cff',
  '--accent-hi': '#a5b9ff',
  '--accent-soft': 'rgba(124, 156, 255, 0.13)',
  '--accent-glow': 'rgba(124, 156, 255, 0.06)',
  '--accent-underline': 'rgba(124, 156, 255, 0.4)',
  '--accent-select': 'rgba(124, 156, 255, 0.3)',
  '--accent-ink': '#0a1020',
  '--good': '#56d68a',
  '--warning': '#e5b04d',
  '--warning-soft': 'rgba(229, 176, 77, 0.12)',
  '--warning-ink': '#f0cd8c',
  '--warning-border': 'rgba(229, 176, 77, 0.35)',
  '--warning-line': 'rgba(229, 176, 77, 0.4)',
  '--warning-border-strong': 'rgba(229, 176, 77, 0.45)',
  '--warning-ring': 'rgba(229, 176, 77, 0.5)',
  '--warning-fade': 'rgba(229, 176, 77, 0)',
  '--critical': '#f0757a',
  '--critical-soft': 'rgba(240, 117, 122, 0.08)',
  '--critical-border': 'rgba(240, 117, 122, 0.25)',

  // elevation (--shadow-3 existed pre-ticket-01 and pre-dates this feature too --
  // no rule anywhere ever referenced it. test/check-contrast.mjs's orphan-token
  // check catches exactly this shape of drift, so it's dropped here rather than
  // carried into two palettes.)
  '--shadow-1': '0 1px 2px rgba(0, 0, 0, 0.4)',
  '--shadow-2': '0 6px 20px -6px rgba(0, 0, 0, 0.55)',
  '--ring': '0 0 0 3px rgba(124, 156, 255, 0.28)',
};

// Designed against --accent's own hue (periwinkle, ~226°), not an inversion of
// DARK: inverting reliably washes out accent text and near-invisible hairlines
// (DESIGN.md "Palette origin"). Surfaces don't mirror DARK's monotonic climb
// either -- panel/panel-2 sit at/near white (they carry cards, inputs, code
// blocks), and panel-3 is the one *deeper* than panel-2, because it is the
// hover/scrollbar-thumb/inline-code surface and there is nothing lighter than
// white left to climb to. Every value here is verified by
// test/check-contrast.mjs against every surface token it can land on, not by eye.
const LIGHT = {
  // surfaces
  '--bg': '#eef1f7',
  '--bg-tint': '#f7f9fc',
  '--panel': '#ffffff',
  '--panel-2': '#f5f6fb',
  '--panel-3': '#e2e6f0',
  '--scrollbar-hover': '#c9d0e2',
  '--history-bg': 'rgba(255, 255, 255, 0.55)',
  '--stage-bg': '#fff',

  // must track --bg exactly (same rgb triple) or the two fade masks show a seam
  '--bg-fade-0': 'rgba(238, 241, 247, 0)',
  '--bg-fade-80': 'rgba(238, 241, 247, 0.8)',

  // ink
  '--ink': '#171c2a',
  '--ink-2': '#3c4459',
  '--muted': '#515c76',
  '--code-ink': '#3a4c78',

  // lines: rgba(255,255,255,…) inverted to rgba(0,0,0,…) reads far too weak at
  // DARK's alphas on a light surface, so these are relit by eye, not inverted
  '--hairline': 'rgba(0, 0, 0, 0.1)',
  '--hairline-2': 'rgba(0, 0, 0, 0.18)',

  // accent: has to clear 4.5:1 on near-white as body/link text (#7c9cff on white
  // is ~2.3:1), so it lands in the mid-blues, same hue family as DARK's. --accent-hi
  // is the hover state and moves further from the background (darker), not lighter.
  '--accent': '#3251c9',
  '--accent-hi': '#2a46b8',
  '--accent-soft': 'rgba(50, 81, 201, 0.13)',
  '--accent-glow': 'rgba(50, 81, 201, 0.06)',
  '--accent-underline': 'rgba(50, 81, 201, 0.4)',
  '--accent-select': 'rgba(50, 81, 201, 0.3)',
  '--accent-ink': '#f5f8ff',
  // good/warning/critical (2026-07-31 audit, criterion 7 amendment): the prior
  // values (#146b3f, #8a5a00, #b32432) were tuned to clear 4.5:1 against the
  // full SURFACES cross product -- a self-imposed bar criterion 7 never asked
  // for, since these three are used as fills/borders at least as often as
  // text, and it is what pushed them into a desaturated dark-green/brown/brick
  // family instead of the board's amber/green/red. Retuned against the bar
  // criterion 7 actually states -- 4.5:1 at each one's REAL text sites
  // (test/check-contrast.mjs's TEXT_SITES, the tightest of which is each
  // color composited under its own *-soft background) -- with room to spare,
  // not sitting on the boundary: light --warning on --warning-soft measures
  // 4.96:1, light --good on --history-bg 5.54:1, light --critical on
  // --critical-soft 5.07:1. warning-soft/border/line/border-strong/ring/fade
  // and critical-soft/border share --warning's/--critical's own RGB triple at
  // varying alpha, same convention as DARK above; --warning-ink is untouched
  // (still clears 5.58:1 on the new --warning-soft).
  '--good': '#007530',
  '--warning': '#805300',
  '--warning-soft': 'rgba(128, 83, 0, 0.12)',
  '--warning-ink': '#7a4a00',
  '--warning-border': 'rgba(128, 83, 0, 0.35)',
  '--warning-line': 'rgba(128, 83, 0, 0.4)',
  '--warning-border-strong': 'rgba(128, 83, 0, 0.45)',
  '--warning-ring': 'rgba(128, 83, 0, 0.5)',
  '--warning-fade': 'rgba(128, 83, 0, 0)',
  '--critical': '#b81b1b',
  '--critical-soft': 'rgba(184, 27, 27, 0.08)',
  '--critical-border': 'rgba(184, 27, 27, 0.25)',

  // elevation: much softer/tighter than DARK's heavy black shadows, or a light
  // page reads muddy
  '--shadow-1': '0 1px 2px rgba(16, 24, 40, 0.06)',
  '--shadow-2': '0 6px 20px -6px rgba(16, 24, 40, 0.12)',
  '--ring': '0 0 0 3px rgba(50, 81, 201, 0.28)',
};

// Exported so a later ticket (mermaid's themeVariables, ticket 04) can look the
// active theme's colors up instead of hand-maintaining a second copy of the palette.
export const palettes = { dark: DARK, light: LIGHT };

/** Render a palette object as one `selector { ... }` rule's custom-property
 * declarations, plus `color-scheme` so the browser's own chrome (native form
 * controls, the default scrollbar when the webkit one above doesn't apply)
 * matches too. Prior art: mermaidNodeRule above, the same "generate a CSS rule
 * from JS data" shape for a different axis (selector fan-out instead of a
 * palette swap). This is also exactly what test/check-pure.mjs's raw-literal
 * check now means by "a token block": a rule whose declarations are all custom
 * properties (plus this one `color-scheme` line). */
const tokenBlock = (selector, palette, scheme) => `${selector} {
  color-scheme: ${scheme};
${Object.entries(palette).map(([name, value]) => `  ${name}: ${value};`).join('\n')}
}`;

export const styles = `
${tokenBlock(':root', DARK, 'dark')}

@media (prefers-color-scheme: light) {
${tokenBlock(':root:not([data-theme="dark"])', LIGHT, 'light')}
}

${tokenBlock(':root[data-theme="light"]', LIGHT, 'light')}

:root {
  /* non-color tokens: theme-independent, so they live in one shared block rather
     than being duplicated into both DARK and LIGHT */

  /* radii */
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 14px;
  --r-pill: 999px;

  /* spacing scale (dense end of standard: this is a working surface) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  /* motion */
  --dur: 160ms;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font: 14px/1.6 "Inter var", Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", ui-sans-serif, system-ui, sans-serif;
  font-feature-settings: "cv05" 1, "ss01" 1;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
/* one soft light source behind the content column; costs nothing and stops the
   page reading as a flat sheet of #0a0e15 */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(900px 520px at 50% -10%, var(--bg-tint), transparent 70%),
    radial-gradient(700px 420px at 100% 0%, var(--accent-glow), transparent 65%);
}
code, pre { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-ligatures: none; }
a { color: var(--accent); text-decoration-color: var(--accent-underline); text-underline-offset: 2px; }
a:hover { color: var(--accent-hi); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
button { cursor: pointer; }
button:disabled { cursor: default; }
svg { flex: none; }
::selection { background: var(--accent-select); }
::-webkit-scrollbar { width: 11px; height: 11px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--panel-3); border: 3px solid transparent; background-clip: content-box; border-radius: var(--r-pill); }
::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-hover); background-clip: content-box; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; animation: none !important; }
}

.board-shell { position: relative; z-index: 1; max-width: 1120px; margin: 0 auto; padding: 0 var(--space-5) 128px; }

/* the board's identity stays on screen: a long board scrolls for a while, and
   "which board am I in, how many rounds deep" is the first thing you lose */
.board-head {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  margin-bottom: var(--space-5); padding: var(--space-4) 0 var(--space-3);
  background: linear-gradient(to bottom, var(--bg) 62%, var(--bg-fade-0));
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--hairline);
}
.board-head h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -0.015em; }
.board-head .meta { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; margin-top: 2px; }
.board-head .round-badge {
  flex: none; color: var(--ink-2); font-size: 11.5px; font-weight: 550;
  letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); padding: 5px 12px;
}
.board-head-actions { flex: none; display: flex; align-items: center; gap: var(--space-3); }

/* the comment-mode toggle (DESIGN.md "The gesture is an explicit comment
   mode"): visible chrome, not a held modifier -- this IS criterion 2's
   discoverability. Off by default, so the page behaves exactly as before until
   the reviewer turns it on (criterion 3, true by construction). */
.mode-toggle { display: inline-flex; align-items: center; gap: 6px; background: var(--panel-2);
  border: 1px solid var(--hairline); color: var(--ink-2); font-size: 11.5px; font-weight: 600;
  border-radius: var(--r-pill); padding: 6px 13px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.mode-toggle:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }
.mode-toggle.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
body.readonly .mode-toggle { display: none; }

/* the theme control (src/theme.mjs): reuses .mode-toggle's chrome above rather
   than duplicating it, plus this icon-only modifier -- no visible label, so
   symmetric padding around a single glyph instead of text-plus-icon spacing. */
.mode-toggle-icon { padding: 7px; }
/* Unlike .mode-toggle, this control stays live in a read-only archive -- an
   archive reader is exactly who needs to switch theme (DESIGN.md). An id
   selector outranks body.readonly .mode-toggle's class selector regardless of
   source order, so that rule's own wording (asserted verbatim by
   test/check-archive.mjs) never has to change to carve this control out of it.
   Tag-qualified ('button#theme-toggle', not bare '#theme-toggle') because
   '#theme-toggle' is not reserved: src/markdown.mjs's slugify turns a heading
   '## Theme toggle' into a second id="theme-toggle" on an <h2>, and board
   content is exactly the input that gets to choose its own headings (audit
   2026-07-31, finding L1). The tag qualifier is what the real button has and
   a markdown-minted heading never can -- see src/ui.mjs's matching
   'button#theme-toggle' lookup and its own comment on the same collision. */
body.readonly button#theme-toggle { display: inline-flex; }

.readonly-banner { display: none; background: var(--warning-soft); border: 1px solid var(--warning-border);
  color: var(--warning-ink); font-size: 12.5px; padding: 10px 14px; border-radius: var(--r-md); margin-bottom: var(--space-4); }
body.readonly .readonly-banner { display: block; }
body.readonly .send-bar { display: none; }
body.readonly input, body.readonly textarea, body.readonly button.card-choice { pointer-events: none; opacity: 0.7; }

.blocks { display: flex; flex-direction: column; gap: var(--space-6); }

/* a round is a session-scoped batch: open rounds render live, a sent round
   collapses into a history rail -- still fully readable, never a second place to
   edit the same answer (see PROTOCOL.md "Board document", ticket 04) */
.round { display: flex; flex-direction: column; gap: var(--space-4); }
.round-label {
  align-self: flex-start;
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--ink-2); background: var(--panel-2);
  border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 4px 12px;
}
/* a sent round steps back a layer instead of just fading: same readability, no
   competition with the round that is actually asking for an answer */
.round-history { position: relative; padding-left: var(--space-4); border-left: 2px solid var(--hairline-2); }
.round-history .round-label { color: var(--muted); background: transparent; }
.round-history .block { background: var(--history-bg); box-shadow: none; }
.round-history .md-content, .round-history .question-prompt { opacity: 0.86; }
.round + .round { padding-top: var(--space-5); }

.block {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--hairline);
  border-radius: var(--r-lg);
  padding: var(--space-4) var(--space-5) var(--space-5);
  box-shadow: var(--shadow-1);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.round-open .block:hover { border-color: var(--hairline-2); box-shadow: var(--shadow-2); }
.block .block-kicker {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2);
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--muted); margin-bottom: var(--space-3);
}

.md-content h1, .md-content h2, .md-content h3, .md-content h4 { font-weight: 650; line-height: 1.3; letter-spacing: -0.01em; margin: 1.1em 0 0.5em; }
.md-content > :first-child { margin-top: 0; }
.md-content h1 { font-size: 19px; }
.md-content h2 { font-size: 16.5px; }
.md-content h3, .md-content h4 { font-size: 14px; }
.md-content p { margin: 0.65em 0; color: var(--ink-2); }
.md-content ul, .md-content ol { padding-left: 1.35em; color: var(--ink-2); }
.md-content li { margin: 0.3em 0; }
.md-content li::marker { color: var(--muted); }
.md-content strong { color: var(--ink); font-weight: 600; }
.md-content code { background: var(--panel-3); color: var(--code-ink); padding: 0.12em 0.4em; border-radius: var(--r-sm); font-size: 12.5px; }
.md-content pre { background: var(--panel-2); border: 1px solid var(--hairline); padding: 12px 14px;
  border-radius: var(--r-md); overflow-x: auto; font-size: 12.5px; line-height: 1.55; }
.md-content pre code { background: none; padding: 0; font-size: inherit; }
.md-content blockquote { margin: 0.8em 0; padding: 2px 14px; border-left: 2px solid var(--accent);
  color: var(--ink-2); background: var(--accent-soft); border-radius: 0 var(--r-sm) var(--r-sm) 0; }
.md-content blockquote p { color: inherit; }
.md-content table { border-collapse: separate; border-spacing: 0; margin: 0.8em 0; width: 100%;
  border: 1px solid var(--hairline); border-radius: var(--r-md); overflow: hidden; }
.md-content th, .md-content td { border-bottom: 1px solid var(--hairline); padding: 7px 12px; font-size: 13px; text-align: left; }
.md-content th { background: var(--panel-2); color: var(--ink); font-weight: 600; font-size: 11.5px;
  letter-spacing: 0.05em; text-transform: uppercase; }
.md-content tr:last-child td { border-bottom: none; }
.md-content hr { border: none; border-top: 1px solid var(--hairline); margin: 1.4em 0; }
/* clears the sticky .board-head when a comment jumps to its anchor */
.md-content [id] { scroll-margin-top: 88px; }
/* applied by src/ui.mjs to the heading/list item a comment is anchored to, when
   that comment's list entry is clicked -- exactly one element carries it at a time */
.md-content [id].anchor-target { background: var(--accent-soft); box-shadow: 0 0 0 4px var(--accent-soft);
  border-radius: var(--r-sm); }

.question-block { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-5); align-items: start; }
.question-block:not(:has(.question-context)) { grid-template-columns: minmax(0, 1fr); }
.question-main { min-width: 0; }
.question-context { min-width: 0; background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: var(--space-3) var(--space-4); }
.question-prompt { font-size: 16px; font-weight: 600; line-height: 1.4; letter-spacing: -0.01em; margin: 0 0 var(--space-3); }

.options { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.card-choice {
  display: block; width: 100%; min-height: 44px; text-align: left;
  background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink);
  border-radius: var(--r-md); padding: 11px 14px; font: inherit;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.card-choice:hover:not(:disabled) { border-color: var(--hairline-2); background: var(--panel-3); }
.card-choice:active:not(:disabled) { transform: scale(0.995); }
.card-choice.selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.card-choice:disabled { opacity: 0.75; }
.card-choice .opt-label { font-weight: 600; font-size: 13.5px; }
.card-choice .opt-desc { color: var(--muted); font-size: 12.5px; margin-top: 2px; line-height: 1.45; }
.card-choice.selected .opt-desc { color: var(--ink-2); }

.unsupported-widget { color: var(--warning); font-size: 12.5px; font-style: italic; }
.resolve-error { color: var(--critical); font-size: 12.5px; background: var(--critical-soft);
  border: 1px solid var(--critical-border); border-radius: var(--r-sm); padding: 8px 12px; margin: 0; }

/* multi-select: same card, plus a checkbox glyph */
.opt-check { position: relative; display: inline-block; flex: none; width: 16px; height: 16px; margin-right: 10px;
  margin-top: 1px; border: 1.5px solid var(--hairline-2); border-radius: 4px; background: var(--panel);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
.opt-check::after { content: ""; position: absolute; left: 4.5px; top: 1px; width: 4px; height: 8px;
  border: solid var(--accent-ink); border-width: 0 2px 2px 0; transform: rotate(45deg) scale(0);
  transition: transform var(--dur) var(--ease); }
.choice-multi.selected .opt-check { background: var(--accent); border-color: var(--accent); }
.choice-multi.selected .opt-check::after { transform: rotate(45deg) scale(1); }
.choice-multi { display: flex; align-items: flex-start; }
.opt-main { display: inline-flex; flex-direction: column; flex: 1; min-width: 0; }

.opt-preview { display: block; margin-top: var(--space-2); max-width: 100%; border-radius: var(--r-sm); }
.opt-preview-img { border: 1px solid var(--hairline); }
.opt-preview-code { background: var(--panel); border: 1px solid var(--hairline); padding: 8px 10px;
  font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }

/* free text: a comfortable writing surface, not a cramped input */
.answer-textarea { width: 100%; min-height: 220px; resize: vertical; background: var(--panel-2);
  border: 1px solid var(--hairline); color: var(--ink); border-radius: var(--r-md); padding: 14px 16px;
  font: inherit; font-size: 14px; line-height: 1.65; margin-bottom: var(--space-3);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.answer-textarea::placeholder, .note-field textarea::placeholder, .search-input::placeholder,
.comment-form input[type=text]::placeholder { color: var(--muted); }
.answer-textarea:focus, .note-field textarea:focus, .comment-form input[type=text]:focus, .search-input:focus {
  outline: none; border-color: var(--accent); box-shadow: var(--ring); }

/* drag-to-rank */
.rank-list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.rank-list li { display: flex; align-items: center; gap: var(--space-3); background: var(--panel-2);
  border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 10px 14px; cursor: grab;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease); }
.rank-list li:hover { border-color: var(--hairline-2); background: var(--panel-3); }
.rank-list li:active { cursor: grabbing; }
.rank-list li.dragging { opacity: 0.45; border-style: dashed; border-color: var(--accent); }
.rank-list .rank-index { color: var(--accent); font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums;
  width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: var(--r-sm); background: var(--accent-soft); }
.rank-list .rank-grip { color: var(--muted); display: inline-flex; }

.note-field { width: 100%; }
.note-field label { display: block; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--muted); margin-bottom: var(--space-1); }
.note-field textarea { width: 100%; min-height: 56px; resize: vertical; background: var(--panel-2);
  border: 1px solid var(--hairline); color: var(--ink); border-radius: var(--r-md); padding: 9px 12px; font: inherit;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }

.question-footer { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-3); }
.btn-defer { background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink-2);
  font-size: 11.5px; font-weight: 550; border-radius: var(--r-pill); padding: 6px 14px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.btn-defer:hover:not(:disabled) { border-color: var(--warning); color: var(--ink); }
.btn-defer.active { background: var(--warning-soft); border-color: var(--warning-ring); color: var(--warning); }

/* the status line reads at a glance instead of being scanned as text: the dot is
   coloured from data-status, which src/render.mjs emits alongside the same word */
.answer-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); }
.answer-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.answer-status[data-status="answered"] { color: var(--good); }
.answer-status[data-status="deferred"] { color: var(--warning); }

.comment-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent;
  border: 1px solid var(--hairline); color: var(--muted); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border-radius: var(--r-pill); padding: 4px 10px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.comment-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
/* the compact glyph-only variant injected after an anchored heading/list item
   (src/render.mjs commentButton, inline = true) -- the class name here must stay
   the one the markup emits; it once named a class the markup never used, so these
   buttons silently fell back to base styling (see test/check-pure.mjs) */
/* render.mjs injects it directly after the anchored element's opening tag, i.e.
   before its text, so left inline it pushed every anchored heading and list item
   sideways by a glyph's width. Lifted into the block's left gutter instead: no
   layout shift, and it appears on hover of the line it belongs to. */
.md-content h1, .md-content h2, .md-content h3, .md-content h4, .md-content li { position: relative; }
.inline-anchor-btn { position: absolute; left: -22px; top: 0.15em; border-color: transparent;
  padding: 2px 4px; opacity: 0; transition: opacity var(--dur) var(--ease); }
.md-content li:hover > .inline-anchor-btn, .md-content h1:hover > .inline-anchor-btn,
.md-content h2:hover > .inline-anchor-btn, .md-content h3:hover > .inline-anchor-btn,
.md-content h4:hover > .inline-anchor-btn, .inline-anchor-btn:focus-visible { opacity: 1; }
/* discoverability floor: on a touch/coarse pointer there is no hover to reveal them */
@media (hover: none) { .inline-anchor-btn { opacity: 0.5; } }

.comment-list { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.comment-item { font-size: 12.5px; color: var(--ink-2); background: var(--panel-2);
  border: 1px solid var(--hairline); border-left: 2px solid var(--hairline-2);
  border-radius: var(--r-sm); padding: 8px 12px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease); }
/* an entry whose anchor is an element in this very page: clicking it highlights
   that element (.anchor-target below), wired in src/ui.mjs */
.comment-item[data-anchor-kind="md"] { cursor: pointer; }
.comment-item[data-anchor-kind="md"]:hover { border-color: var(--accent); background: var(--panel-3); }
/* queued locally, not yet sent -- matches the hollow .pin-pending badge */
.comment-item.comment-pending { border-style: dashed; border-color: var(--accent); border-left-color: var(--accent); }
.comment-item .comment-anchor { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; margin-right: 8px; }
.comment-item .comment-lost { color: var(--critical); }

/* "commenting on: <anchor>" -- src/render.mjs emits one per block, always, so it
   MUST be hidden until a comment is actually being composed on that block; without
   a rule it fell back to a visible block-level element and a six-block board
   showed six stray lines each claiming a comment was in progress. src/ui.mjs
   adds .open alongside the comment form's own .open, and removes it on submit. */
.comment-target { display: none; margin-top: var(--space-3); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
.comment-target.open { display: block; }

.comment-form { margin-top: var(--space-2); display: none; gap: var(--space-2); }
.comment-form.open { display: flex; }
.comment-form input[type=text] { flex: 1; min-width: 0; background: var(--panel-2); border: 1px solid var(--hairline);
  color: var(--ink); border-radius: var(--r-md); padding: 8px 12px; font: inherit;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.comment-form button { background: var(--accent); color: var(--accent-ink); border: none; font-weight: 600;
  border-radius: var(--r-md); padding: 8px 16px; font: inherit; transition: filter var(--dur) var(--ease); }
.comment-form button:hover:not(:disabled) { filter: brightness(1.08); }
.comment-form button:disabled { opacity: 0.5; }

/* mermaid: client-rendered SVG from the CDN; pre.mermaid holds raw source until then */
.mermaid-block pre.mermaid { background: none; border: none; overflow-x: auto; margin: 0; }
.mermaid-block pre.mermaid svg { max-width: 100%; height: auto; }
.mermaid-block .missing { color: var(--warning); font-size: 12.5px; }

/* code: a file plus a line range or section, no syntax highlighting */
.code-block pre { background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-md);
  padding: 12px 14px; overflow-x: auto; margin: 0; }
.code-block pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; color: var(--code-ink); }

/* html stage: sandboxed iframe so a hand-mocked preview never leaks into the page */
.html-stage { display: block; width: 100%; min-height: 320px; resize: vertical; overflow: auto;
  border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--stage-bg); }

/* element-level anchoring (ticket 06): pin-layer overlays the html-stage iframe or
 * the rendered mermaid SVG exactly, and src/ui.mjs positions numbered .anchor-pin
 * badges inside it once the element they point at is resolvable in the live DOM. */
.stage-wrap { position: relative; }
.pin-layer { position: absolute; inset: 0; pointer-events: none; }
.anchor-pin { position: absolute; transform: translate(-50%, -50%); pointer-events: auto;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent);
  color: var(--accent-ink); font-size: 11px; font-weight: 700; line-height: 20px; text-align: center;
  font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px var(--panel), var(--shadow-1); cursor: default; }
.anchor-pin.pin-lost { background: var(--critical); }
/* a comment queued but not yet sent: the pin appears the moment it is queued (the
   batching is the win), drawn hollow so it never reads as an already-sent one --
   src/ui.mjs mints its number provisionally, continuing the server's sequence */
.anchor-pin.pin-pending { background: var(--panel); color: var(--accent);
  border: 1px dashed var(--accent); line-height: 18px; }

/* Both stage kinds are clickable at element level, and both read as pictures until
   something says so. The kicker carries the note; a mermaid node highlights under the
   cursor (the html stage's equivalent is injected into the iframe's own document by
   src/ui.mjs, since this stylesheet deliberately does not reach inside it). Neither
   applies in a standalone file: archive, where nothing is clickable. Ticket 05: one
   gesture, toggle-gated everywhere -- a diagram node is no longer a standing
   exception either, so both rules below also require body.comment-mode, the same
   class setCommentMode (src/ui.mjs) toggles for every other anchor-target rule. */
.stage-hint { font-size: 10.5px; letter-spacing: 0.04em; text-transform: none; color: var(--muted); font-style: italic; }
body.readonly .stage-hint { display: none; }
${mermaidNodeRule('body.comment-mode:not(.readonly) .mermaid-block svg g')} { cursor: pointer; }
${mermaidNodeRule('body.comment-mode:not(.readonly) .mermaid-block svg g', ':hover')} { outline: 2px solid var(--accent); outline-offset: 3px; }

/* the generic comment-mode hover outline (DESIGN.md anchoring criterion 2: "before
   committing the reviewer can see exactly which element will be anchored"). Set
   from JS (src/ui.mjs) on the innermost element under the cursor, never via a
   :hover rule -- that would outline every ancestor in the chain at once. The
   iframe's own copy of this same outline (wireHtmlStage) is a hardcoded hex
   injected into the sandboxed document's own <style>, since this stylesheet
   deliberately does not reach in there -- see QUIRKS.md "two stylesheets, one
   palette". */
.cb-anchor-hover { outline: 2px solid var(--accent); outline-offset: 2px; cursor: pointer; }
body.comment-mode .blocks { cursor: crosshair; }

/* compare: the side-by-side stage inherited from /example */
.compare-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.compare-side { background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-md); padding: var(--space-3) var(--space-4); }
.compare-label { font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
  margin-bottom: var(--space-2); }
.compare-side .block { border: none; background: none; padding: 0; box-shadow: none; }
.compare-side .block:hover { box-shadow: none; }

/* the action bar is the one thing that must never scroll away */
.send-bar { position: sticky; bottom: 0; z-index: 20; margin-top: var(--space-6); padding: var(--space-4) 0;
  background: linear-gradient(to top, var(--bg) 55%, var(--bg-fade-80) 85%, var(--bg-fade-0));
  backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.btn-send { background: var(--accent); color: var(--accent-ink); border: 1px solid transparent; border-radius: var(--r-md);
  padding: 11px 24px; font: inherit; font-size: 13.5px; font-weight: 650; box-shadow: var(--shadow-2);
  transition: filter var(--dur) var(--ease), transform var(--dur) var(--ease); }
.btn-send:hover:not(:disabled) { filter: brightness(1.08); }
.btn-send:active:not(:disabled) { transform: translateY(1px); }
/* the second way out (DESIGN.md "Two ways out, plus a wall clock"): returns the
   call now with whatever is filled in. Secondary weight -- Send stays the primary
   action -- but it sits in the same bar, so body.readonly hides both together. */
.btn-discuss { background: var(--panel-2); color: var(--ink-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: 11px 20px; font: inherit; font-size: 13.5px; font-weight: 600;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.btn-discuss:hover:not(:disabled) { border-color: var(--hairline-2); background: var(--panel-3); color: var(--ink); }
.btn-send:disabled, .btn-discuss:disabled { opacity: 0.5; box-shadow: none; }
.send-status { color: var(--muted); font-size: 12.5px; align-self: center; margin-right: auto; }

/* thread index (src/indexpage.mjs) — same tokens, its own layout */
.index-shell { position: relative; z-index: 1; max-width: 900px; margin: 0 auto; padding: var(--space-6) var(--space-5) 96px; }
.index-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);
  margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--hairline); }
.index-head-titles { min-width: 0; }
.index-head-actions { flex: none; display: flex; align-items: center; }
.index-head h1 { font-size: 22px; margin: 0 0 var(--space-1); font-weight: 650; letter-spacing: -0.02em; }
.index-head .meta { color: var(--muted); font-size: 12.5px; }

.search-form { display: flex; gap: var(--space-2); margin: 0 0 var(--space-5); }
.search-input { flex: 1; min-width: 0; background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink);
  border-radius: var(--r-md); padding: 10px 14px; font: inherit;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.search-btn { background: var(--accent); color: var(--accent-ink); border: none; border-radius: var(--r-md);
  padding: 10px 20px; font: inherit; font-weight: 650; transition: filter var(--dur) var(--ease); }
.search-btn:hover { filter: brightness(1.08); }

.search-results { margin-bottom: var(--space-6); padding-bottom: var(--space-5); border-bottom: 1px solid var(--hairline); }
.result-list { display: flex; flex-direction: column; gap: var(--space-3); }
.result-item { background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--r-md);
  padding: var(--space-3) var(--space-4); box-shadow: var(--shadow-1); }
.result-kind { font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.result-text { margin: var(--space-1) 0; color: var(--ink); }
.result-meta { color: var(--muted); font-size: 12px; }
.result-meta a { color: var(--accent); }

.empty-state { color: var(--muted); font-size: 13px; background: var(--panel); border: 1px dashed var(--hairline);
  border-radius: var(--r-md); padding: var(--space-5); text-align: center; }

.thread-list { display: flex; flex-direction: column; gap: var(--space-3); }
.thread-item { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--r-lg);
  padding: var(--space-4) var(--space-5); text-decoration: none; color: var(--ink); box-shadow: var(--shadow-1);
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.thread-item:hover { border-color: var(--hairline-2); transform: translateY(-1px); box-shadow: var(--shadow-2); }
/* a thread with an open round is the one thing on this page asking for something */
.thread-item.live { border-color: var(--warning-line); background:
  linear-gradient(to right, var(--warning-soft), transparent 45%), var(--panel); }
.thread-item.live:hover { border-color: var(--warning); }
.thread-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.thread-cwd { display: flex; align-items: center; gap: var(--space-2); font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; }
.thread-meta { color: var(--muted); font-size: 12px; }
.thread-status { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warning); display: inline-block;
  box-shadow: 0 0 0 0 var(--warning-ring); animation: cb-pulse 2.4s var(--ease) infinite; }
@keyframes cb-pulse {
  70% { box-shadow: 0 0 0 7px var(--warning-fade); }
  100% { box-shadow: 0 0 0 0 var(--warning-fade); }
}
.pending-badge { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ink-2);
  background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 4px 12px; }
.pending-badge.zero { color: var(--muted); }
.pending-badge.has-pending { color: var(--warning); border-color: var(--warning-border-strong); background: var(--warning-soft); }

/* --- responsive: the board is a laptop surface first, but it has to survive a
   phone-width window without a horizontal scrollbar or a two-column squeeze --- */
@media (max-width: 860px) {
  .question-block { grid-template-columns: minmax(0, 1fr); }
  .compare-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .board-shell, .index-shell { padding-left: var(--space-4); padding-right: var(--space-4); }
  .board-head { flex-direction: column; align-items: flex-start; gap: var(--space-2); }
  .block { padding: var(--space-4); border-radius: var(--r-md); }
  .send-bar { flex-wrap: wrap; }
  .send-status { width: 100%; margin-bottom: var(--space-2); }
  .btn-send, .btn-discuss { flex: 1; }
  .search-form { flex-wrap: wrap; }
}
`;
