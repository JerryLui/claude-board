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
// what makes a palette change a one-block edit
// no matter how many CSS rules end up referencing a token, and it is what lets
// test/check-contrast.mjs assert the contrast bar by importing these objects
// directly instead of regexing them back out of a CSS string. Every dark value
// below is byte-for-byte what shipped, except --muted: measured at
// 4.45:1 on --panel-2 and 4.03:1 on --panel-3 (both below the 4.5:1 bar, and
// --muted genuinely sits on both), so it moves to the minimal same-hue lift that
// clears 4.5:1 everywhere it's used.
const DARK = {
  // surfaces: bg is the page, surface climbs toward the viewer
  '--bg': '#0a0e15',
  '--bg-tint': '#101726',
  '--panel': '#131a27',
  '--panel-2': '#18202f',
  '--panel-3': '#1e2839',
  '--scrollbar-hover': '#2c3852',
  '--history-bg': 'rgba(19, 26, 39, 0.55)',
  // The tab mark's own rest-tile colour (src/styles.mjs's REST_SHAPES, below).
  // Not a page surface -- nothing in this file's CSS ever paints with it, and
  // it is read by name from the palette object in JS, the same way MARK_SHAPES
  // reads --warning and --accent-ink by name a little further down. Today's
  // value is byte-identical to --scrollbar-hover above, which is the color a
  // slate tile picked on chroma (not value) against Chrome's tab strip happens
  // to land on -- but the mark owns this name, not that one: a scrollbar
  // restyle changes --scrollbar-hover and leaves the tab mark exactly where it
  // is. The "declared and never wired up" trip-wire (test/check-contrast.mjs)
  // still watches this key because that check learns to scan palette-object
  // reads, not because the key borrows a CSS reference. See ADR.md entry 31.
  '--mark-rest-tile': '#2c3852',
  // The html stage's artboard ('.html-stage', '.stage-lens-frame'). Neutral and
  // per-palette, and not a page surface: a mock owns its own background, so this
  // is only ever what shows through one that paints none. Two constraints decide
  // the value and they pull opposite ways:
  //   - a srcdoc that paints no background sets no color either, so its text is
  //     the UA's black. The artboard has to stay light enough to read that
  //     (12.28:1 here) -- which is why the DARK palette's artboard is not dark.
  //   - the stage's hover outline (STAGE_ACCENT_HEX, src/render.mjs) is ONE
  //     literal for both palettes and has to clear 3:1 on each: 3.89:1 here.
  // Dimmed well below LIGHT's #e6e8ee, and a plain grey beside this palette's
  // blue-tinted surfaces (9.55:1 against --panel-2), so it reads as an inert
  // artboard rather than as a slab of content.
  '--stage-bg': '#c3c6cd',

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
// DARK: inverting reliably washes out accent text and near-invisible hairlines.
// Surfaces don't mirror DARK's monotonic climb
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
  // The key set must match DARK's (test/check-contrast.mjs), but the mark has
  // no light variant and never reads this
  // value -- it names DARK's '--mark-rest-tile' explicitly, exactly as it
  // names DARK's '--warning' rather than following prefers-color-scheme. Given
  // a light-theme reader anyway: LIGHT's own slate, the scrollbar-hover value
  // two lines up, so a light rest tile would separate from a light tab strip
  // by the same chroma logic DARK's does, if this ever grows a caller.
  '--mark-rest-tile': '#c9d0e2',
  // the artboard, one step BELOW --panel-2 (1.14:1) rather than at/near white,
  // so a mock that paints nothing reads as a recessed stage and not as another
  // card. Black srcdoc text 17.14:1, stage hover outline 5.43:1 -- DARK's own
  // --stage-bg comment has the full account of both bars.
  '--stage-bg': '#e6e8ee',

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
  // good/warning/critical: the prior
  // values (#146b3f, #8a5a00, #b32432) were tuned to clear 4.5:1 against the
  // full SURFACES cross product -- a self-imposed bar, never asked
  // for, since these three are used as fills/borders at least as often as
  // text, and it is what pushed them into a desaturated dark-green/brown/brick
  // family instead of the board's amber/green/red. Retuned against the bar --
  // 4.5:1 at each one's REAL text sites
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

// Exported so a later ticket (mermaid's themeVariables) can look the
// active theme's colors up instead of hand-maintaining a second copy of the palette.
export const palettes = { dark: DARK, light: LIGHT };

// The tab mark: a board -- two quiet rows and one emphasised row, the open
// question. Inline as a data URI, never an asset file, for the same reason the
// badge drawn over it is (PROTOCOL.md "Marking an already-open tab"): the page
// has to stay a single self-contained file, so the `file:` archive shows the
// same mark with the network off and the daemon gone.
//
// A favicon gets no CSS, so both colours are literals here rather than var()s --
// read straight off DARK so a palette edit stays a one-block edit. DARK's
// --warning in BOTH themes on purpose, and it is the one token that can be: amber
// is the only hue the palette carries at nearly the same value in either theme's
// usable range, so the mark needs no light variant to keep in sync. It must be
// named off DARK explicitly, though -- light's --warning is #805300, a brown tuned
// for contrast against text, which would turn the tile to mud. (An icon that
// followed prefers-color-scheme would vanish into whichever tab strip it matched.)
//
// Rows are 4.6/4.6/5.4, not the 3.4 this shipped with: below ~4 the two quiet bars
// merge into one after the browser's downsample to 16px, and 16px is the only size
// that matters. The open row is the only one at full opacity -- the single piece of
// hierarchy the mark carries. rx 9 rather than 8 to match the heavier bars.
//
// --warning is also how the product says "waiting on you" (.live-dot,
// .rounds-left-badge, .thread-item.live), but the pending badge in src/ui.mjs
// does not spend it a second way: the tile stays this same constant amber in
// every state, and ink mass is the signal instead of hue -- three hairline
// rows here already read as "some ink"; a pending round replaces them with a
// bold numeral drawn as canvas text over the same fill, "a lot more ink", the
// way peripheral vision reads a mass difference at 16px far more reliably than
// a value flip. No state ever paints a second tile colour. ADR.md records what
// that used to cost, back when it did.
const MARK_SHAPES =
  `<rect width="32" height="32" rx="9" fill="${DARK['--warning']}"/>`
  + `<rect x="7" y="6.6" width="18" height="4.6" rx="2.3" fill="${DARK['--accent-ink']}" opacity=".34"/>`
  + `<rect x="7" y="13.4" width="11" height="4.6" rx="2.3" fill="${DARK['--accent-ink']}" opacity=".34"/>`
  + `<rect x="7" y="20" width="18" height="5.4" rx="2.7" fill="${DARK['--accent-ink']}"/>`;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${MARK_SHAPES}</svg>`;

/** The same mark sized for the page rather than the tab: the board head's home
 * control (30, the slot it now fills outright) and the index title (36). Shares
 * MARK_SHAPES with the favicon so the tab and the page can never drift. No
 * `xmlns` -- this is inlined into HTML, not a standalone document. */
export const markSvg = (size) =>
  `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">${MARK_SHAPES}</svg>`;

/** The `<link rel="icon">` every page emits, href inlined. `encodeURIComponent`
 * rather than a hand-escaped string: `#` in a data URI would otherwise cut the
 * href off at the first colour. */
export const faviconLink =
  `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

// The rest mark: the board's own rows, stood up. On a break the index tab has
// nothing to ask for, so the three ink rows above collapse to two -- taller,
// upright, at rest -- on a tile that stops alerting. Same geometry as
// MARK_SHAPES (32x32, rx 9) and the same corner, so swapping one href for the
// other (a later ticket's job, not this one's) reads as the SAME mark turned
// down, not a different icon.
//
// The tile is DARK['--mark-rest-tile'], not DARK['--scrollbar-hover'] -- see
// that key's own comment, above, and ADR.md entry 31: the colour is
// load-bearing for a shipped drawing now, so it gets a name that says so.
// Picked on chroma, not value: Chrome's tab strip is a neutral grey, so a
// slate tile close to it in VALUE still separates by chroma, leaving the
// amber bars to supply the tile's value contrast from inside it rather than
// around it. No light variant, same reasoning as MARK_SHAPES above -- this
// names DARK explicitly and reads no CSS var().
//
// Bars, not rows: two vertical amber bars at 86% opacity read as a pause
// glyph, the same family as the work mark's ink rows, one register down. Two,
// not one -- a single rest bar at 16px is indistinguishable from a tile that
// failed to load after the browser's downsample; two survive the squint as
// something specific. Geometry is the design's own: x 10.4 and 17.2, y 8.6,
// 4.4 wide by 14.8 tall, rx 2.2.
const REST_SHAPES =
  `<rect width="32" height="32" rx="9" fill="${DARK['--mark-rest-tile']}"/>`
  + `<rect x="10.4" y="8.6" width="4.4" height="14.8" rx="2.2" fill="${DARK['--warning']}" opacity=".86"/>`
  + `<rect x="17.2" y="8.6" width="4.4" height="14.8" rx="2.2" fill="${DARK['--warning']}" opacity=".86"/>`;

const REST_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${REST_SHAPES}</svg>`;

/** The rest mark's href alone, not a whole `<link>` -- the page that wants it
 * already carries `faviconLink`'s tag and swaps this in as its `href`
 * (inline data URI, no asset file, no network fetch, no
 * canvas). `encodeURIComponent` for the same reason as `faviconLink`'s own:
 * a hand-escaped `#` would cut the href off at the first colour. */
export const restFaviconHref = `data:image/svg+xml,${encodeURIComponent(REST_FAVICON_SVG)}`;

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

  /* How far a scroll-to-anchor has to clear the sticky .board-head. Measured in
     Chrome: the header is 81.4px at ordinary widths, so 88px leaves a small gap
     -- but BELOW the 560px breakpoint .board-head becomes a column and grows to
     115.4px, and a hardcoded 88 then parks the target 27px BEHIND the header it
     was supposed to clear. One token, overridden in that same media query, so
     the two can never disagree again. Every scroll-margin-top on the page reads
     it: .round, whose top the pager scrolls to on every page flip, and
     .question-block, whose top the questions-left pill scrolls to. */
  --head-clear: 88px;
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

/* No trailing bottom padding: the send bar (.send-bar, sticky and in-flow, near
   the bottom of this file) is the shell's own last child, so its bottom edge
   IS the document's bottom edge -- a reviewer scrolled to the end sees the bar's
   lower edge flush with the page's, not a band of bare background sized for
   nothing. That is the rule wherever the bar is on screen holding the floor.
   Where it is not -- a sent round, and every archive, since body.readonly hides
   the bar outright -- the round pager's floating dock is what the last block
   runs under, and the reservation near '.round-pager-dock' below carves that
   room back out. Pinned by test/check-round-end.mjs, which fails if this
   padding grows a bottom value here and if the reservation there ever stops
   matching the expression the comment panel clears the dock with. */
.board-shell { position: relative; z-index: 1; max-width: 1120px; margin: 0 auto; padding: 0 var(--space-5); }

/* the board's identity stays on screen: a long board scrolls for a while, and
   "which board am I in, how many rounds deep" is the first thing you lose */
.board-head {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  margin-bottom: var(--space-5); padding: var(--space-4) 0 var(--space-3);
  background: linear-gradient(to bottom, var(--bg) 62%, var(--bg-fade-0));
  backdrop-filter: blur(10px);
  /* No border-bottom, deliberately. The gradient above already is the edge: it
     fades the header's own background out to transparent so content reads as
     passing UNDER it, and a hairline drawn across the bottom of that fade
     contradicts it -- a hard line where the treatment has just said there is
     none. One or the other; the fade is the one that survives the scroll. */
}
.board-head-title { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.board-head h1 { font-size: 20px; margin: 0; font-weight: 650; letter-spacing: -0.015em; }
.board-head .meta { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; margin-top: 2px; }
/* the one way back to the thread
   index. Absent under body.readonly -- a standalone file://
   archive has no daemon behind "/" to navigate to -- same idiom as
   .mode-toggle/.send-bar just above/below: kept in the markup (one
   byte-identical page, live or archived) and hidden structurally, not merely
   disabled.

   The slot holds the mark itself (markSvg, above), not an arrow in a framed
   button: it was already at favicon proportions, so brand and home became one
   control instead of two sitting side by side. That means no panel fill and no
   hairline -- a frame around the tile would read as a second, competing corner
   radius -- so hover is carried by value alone. The global :focus-visible
   outline near the top of this file still lands on it, keyboard reach unchanged. */
.back-to-index {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; border: 0; background: none;
  opacity: 0.88; transition: opacity var(--dur) var(--ease);
}
.back-to-index:hover { opacity: 1; }
body.readonly .back-to-index { display: none; }
/* font: inherit is not decoration -- this was turned from a <span> into a
   <button> (src/render.mjs), and a button does NOT inherit font-family from its
   ancestors: without this the badge renders in the UA's own default (measured in
   Chrome: Arial) beside a .round-label pill in Inter, so the two controls that
   are meant to read as the same object silently stopped matching. Every other
   button rule in this file already carries it; this one was missed at the
   span-to-button conversion. Same reason :hover is qualified with :not(:disabled)
   -- an archive hard-disables the badge (src/ui.mjs's readonly pass), and an
   unqualified :hover lights a dead control up as if it were live, exactly as
   .mode-toggle and .btn-send below already guard against. */
.board-head .round-badge {
  flex: none; font: inherit; color: var(--ink-2); font-size: 11.5px; font-weight: 550;
  letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); padding: 5px 12px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.board-head .round-badge:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }
.board-head-actions { flex: none; display: flex; align-items: center; gap: var(--space-3); }

/* AC 6, AC 8, AC 11: the page board's own pill/meta slot (ADR.md entry 49,
   "the pill may hold a label alone"). Sits in '.board-head-actions', which
   entry 40's condensing rule never touches (only 'h1'/'.meta' hide there), so
   ONE element renders in both the expanded header and the condensed pill with
   no second copy and no extra selector -- exactly AC 6's "in both the expanded
   header and the condensed pill". A muted figure, never a chip: entry 49
   corrects entry 40's assumption that this slot needed a real control, and a
   label alone is what the countdown and 'read-only' both are. Hidden on every
   board that is not laid out as a page board -- src/render.mjs renders it on
   every board (test/check-pure.mjs's emitter scan needs the class to appear
   somewhere), but only a page board has anywhere for it to mean anything. */
.round-meta { display: none; flex: none; font: inherit; color: var(--muted); font-size: 11.5px;
  font-weight: 550; letter-spacing: 0.02em; white-space: nowrap; }
body.page-board .round-meta { display: inline; }

/* the comment-mode toggle: visible chrome, not a held modifier -- this IS
   discoverability. Off by default, so the page behaves exactly as before until
   the reviewer turns it on (true by construction). */
.mode-toggle { display: inline-flex; align-items: center; gap: 6px; background: var(--panel-2);
  border: 1px solid var(--hairline); color: var(--ink-2); font-size: 11.5px; font-weight: 600;
  border-radius: var(--r-pill); padding: 6px 13px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.mode-toggle:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }
.mode-toggle.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
/* ADR.md entry 46: a page board nobody is listening to is uncommentable, so the
   control that turns commenting on is not on offer there either. Two classes
   rather than one because they are two different facts -- an archive is read-only
   whatever it holds, while 'page-uncommentable' is about this page's round in
   particular (src/render.mjs sets it at first paint, src/ui.mjs's
   refreshAwaitDisplay keeps it true against the clock). */
body.readonly .mode-toggle, body.page-uncommentable .mode-toggle { display: none; }

/* the theme control (src/theme.mjs): reuses .mode-toggle's chrome above rather
   than duplicating it, plus this icon-only modifier -- no visible label, so
   symmetric padding around a single glyph instead of text-plus-icon spacing. */
.mode-toggle-icon { padding: 7px; }
/* Unlike .mode-toggle, this control stays live in a read-only archive -- an
   archive reader is exactly who needs to switch theme. Same for an
   uncommentable page board: nothing there is answerable, but the theme of a
   full-viewport artifact is exactly what a reader still wants to change, so
   both of .mode-toggle's hiding gates above are carved out here. An id
   selector outranks body.readonly .mode-toggle's class selector regardless of
   source order, so that rule's own wording (asserted verbatim by
   test/check-archive.mjs) never has to change to carve this control out of it.
   Tag-qualified ('button#theme-toggle', not bare '#theme-toggle') because
   '#theme-toggle' is not reserved: src/markdown.mjs's slugify turns a heading
   '## Theme toggle' into a second id="theme-toggle" on an <h2>, and board
   content is exactly the input that gets to choose its own headings. The tag
   qualifier is what the real button has and
   a markdown-minted heading never can -- see src/ui.mjs's matching
   'button#theme-toggle' lookup and its own comment on the same collision. */
body.readonly button#theme-toggle, body.page-uncommentable button#theme-toggle { display: inline-flex; }

.readonly-banner { display: none; background: var(--warning-soft); border: 1px solid var(--warning-border);
  color: var(--warning-ink); font-size: 12.5px; padding: 10px 14px; border-radius: var(--r-md); margin-bottom: var(--space-4); }
body.readonly .readonly-banner { display: block; }
body.readonly .send-bar { display: none; }
/* none of this work's new chrome belongs in a frozen
   archive -- the send bar it would dock is already gone on the line above, and
   the rail loses its reason to exist alongside it (nothing left to arrive at). */
body.readonly .round-end { display: none; }
body.readonly input, body.readonly textarea, body.readonly button.card-choice { pointer-events: none; opacity: 0.7; }

/* A page already sent is read-only (ADR.md entry 42) -- the guarantee the
   deleted history rail carried, now carried by the pager: flipping back to a
   sent round puts this class on <body> (src/ui.mjs's goToRound), flipping off it
   takes it away. This is the THIRD lock on a sent round, not a replacement for
   either of the two that already exist (the server renders its widgets
   disabled, and markRoundHistory disables them live) -- it is the one that
   reaches what neither of those can: the send bar, whose buttons live OUTSIDE
   every round section and would otherwise still submit the open round from a
   page that is not it. Same two-rule idiom body.readonly uses just above, for
   the same reason (QUIRKS.md "Readonly is locked twice"). */
body.sent-page .send-bar { display: none; }
body.sent-page input, body.sent-page textarea, body.sent-page button.card-choice { pointer-events: none; opacity: 0.7; }

.blocks { display: flex; flex-direction: column; gap: var(--space-6); }

/* a round is a session-scoped batch, and a PAGE of this board (ADR.md entry 42):
   every round is rendered, exactly one carries .round-current, and only that one
   is displayed. The history rail this replaced stacked a sent round above the
   open one -- which a round that fills the viewport cannot do -- so the earlier
   pages absorb its job and .round-pager (below) is how you reach them.

   display:none rather than an off-screen position: nothing here is measured
   while it is hidden (the pins and the round badge are recomputed on every flip,
   src/ui.mjs's goToRound), and a hidden page must not add scroll height to the
   page that IS showing.

   scroll-margin-top clears the sticky .board-head when a flip scrolls the
   arriving page's top back under it. */
.round { display: none; flex-direction: column; gap: var(--space-4); scroll-margin-top: var(--head-clear); }
.round.round-current { display: flex; }
.round-label {
  align-self: flex-start;
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase;
  color: var(--ink-2); background: var(--panel-2);
  border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 4px 12px;
}
/* a sent page reads as settled rather than live -- the surface half of "a page
   already sent is read-only" (entry 42), alongside body.sent-page below. What
   went with the rail is its GEOMETRY (the indent, the left border, the gap that
   separated two stacked rounds); two rounds are never on screen together now, so
   there is nothing left to separate or step back from. */
.round-history .round-label { color: var(--muted); background: transparent; }
.round-history .block { background: var(--history-bg); box-shadow: none; }
.round-history .md-content, .round-history .question-prompt { opacity: 0.86; }
/* the round's own bottom -- a divider with a tag
   naming the round and its question count, so reaching it is a visible event
   rather than the absence of one (the round's top already has .round-label;
   this is the twin at the other end). Open rounds only -- see
   renderRoundSection's own comment. */
.round-end { display: flex; align-items: center; gap: var(--space-2); padding: 4px 0 var(--space-2); }
.round-end .line { flex: 1; height: 1px; background: var(--hairline-2); }
.round-end .tag {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--muted); padding: 0 var(--space-2);
}

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

/* scroll-margin-top clears the sticky .board-head when the questions-left pill
   scrolls a block's own top on screen (src/ui.mjs's goToQuestion), the same
   reason .round carries it for a page flip -- see --head-clear in :root. */
.question-block { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-5); align-items: start;
  scroll-margin-top: var(--head-clear); }
/* ADR.md entry 26: a question carrying a rendered stage (anywhere in its
   options or its context, src/render.mjs's questionCarriesStage) never emits
   a '.question-context' card at all -- its context renders as prose inside
   '.question-main' instead (see '.question-context-prose' below). That is
   the whole full-width mechanism: this ONE selector already collapsed a
   context-free question to one column before this entry existed, and a
   stage-carrying question now qualifies the same way, with no separate
   modifier class. A stage-free question keeps a real '.question-context'
   card exactly as before and is unaffected. */
.question-block:not(:has(.question-context)) { grid-template-columns: minmax(0, 1fr); }
/* the send guard's ring around the first outstanding question once a click on
   Send has armed instead of submitted -- toggled
   client-side by src/ui.mjs's armSendGuard/disarmSend, never present in
   server-rendered markup. Overrides .block's own border/box-shadow (this
   section carries that class too); every other question keeps .block's
   plain hairline. */
.question-block.flagged { border-color: var(--warning-border-strong); box-shadow: 0 0 0 3px var(--warning-soft); }
.question-main { min-width: 0; }
.question-context { min-width: 0; background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: var(--space-3) var(--space-4); }
/* The prose counterpart to '.question-context' above, for a question that
   carries a rendered stage (ADR.md entry 26): no background, no border, no
   padding -- just vertical stacking between the prompt and the widget, each
   context item in reading order. Each item supplies its own typography
   ('.md-content', '.mermaid-block', '.html-stage') exactly as it would
   top-level; only '.compare-side''s own card look is stripped below, since a
   compare nested here is still "context", not a card. */
.question-context-prose { display: flex; flex-direction: column; gap: var(--space-3); margin: 0 0 var(--space-3); }
.context-item .compare-side { background: none; border: none; padding: 0; }
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

/* choose-between-rendered-variants: each option wraps a fully
   rendered block instead of living inside a <button> -- an iframe cannot nest
   inside one. .options-variants overrides .options' single-column flex layout
   (source order after it decides the tie, same specificity) with a grid, since
   this widget's options are rendered content meant to sit side by side, not a
   list of short labels. .variant-card is the div src/ui.mjs wires by hand for
   the click + keyboard contract .card-choice gets from a real <button>;
   :focus-visible's outline (near the top of this file) already covers its
   keyboard-focus ring for free, the same way it does for every other
   focusable element here. */
.options-variants { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); }
/* an 'html'-kind option (src/render.mjs's
   renderVariantOption stamps this modifier only on that kind -- see its own
   comment) spans every auto-fit column .options-variants currently has,
   whatever that count is at the page's current width, which is what makes
   this "one per row at full width" rather than a hardcoded column count.
   Every other option kind is untouched: no modifier class, so
   .options-variants' plain grid keeps deciding their layout exactly as it
   did before this existed. */
.variant-card--stage { grid-column: 1 / -1; }
.variant-card { display: block; cursor: pointer; background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-md); padding: var(--space-3) var(--space-4);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
.variant-card:hover { border-color: var(--hairline-2); background: var(--panel-3); }
.variant-card.selected { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
/* the div equivalent of .card-choice:disabled above -- a plain <div> has no
   native disabled state, so src/render.mjs stamps this attribute instead (see
   renderVariantOption's own comment) and this is its only visual expression.
   An attribute selector, deliberately: QUIRKS.md's "every .class-name..." is
   the escape hatch for a state with no class of its own. */
.variant-card[aria-disabled="true"] { cursor: default; opacity: 0.75; }
.variant-label { margin-bottom: var(--space-2); }
.variant-label .opt-label { font-weight: 600; font-size: 13.5px; }
.variant-label .opt-desc { color: var(--muted); font-size: 12.5px; margin-top: 2px; line-height: 1.45; display: block; }
/* the nested block renders through the same renderBlock dispatch a compare
   side's own block does, and is stripped of its own card chrome for exactly
   the same reason .compare-side .block is (below): without this, an option
   would render as a card nested inside a card. */
.variant-card .block { border: none; background: none; padding: 0; box-shadow: none; }
.variant-card .block:hover { box-shadow: none; }
/* SECURITY, not polish: an
   option's rendered block is untrusted, agent-authored content -- exactly
   like any other block on the page, EXCEPT that here a click deciding which
   option gets picked is a decision only the reviewer may make. An 'html'
   option is a sandboxed iframe that can run the agent's own script
   (renderHtmlBlock), and that script can dispatch a click on itself with no
   human involved at all -- an autoplaying demo, an animation, a mock that
   clicks its own button, all ordinary content for /example's real mockups.
   'pointer-events: none' makes the iframe unreachable by any real pointer
   input, so a genuine, trusted click over the visible mock can never land
   inside it -- it falls through to the card underneath in the parent
   document instead (the same one a click on the option's label already
   selects), which is the ONLY thing that can ever record a pick. See
   src/render.mjs's stageAgentScript design comment ("NO 'select' MESSAGE,
   DELIBERATELY") for the two paths this closes and why guarding a message
   instead of deleting the channel would not have been enough. */
.choice-variant .html-stage { pointer-events: none; }
/* a SEPARATE rule from the one immediately
   above rather than folded into it -- that one is a trust boundary
   and stays exactly as written, on
   its own line, byte for byte. '.html-stage''s own floor (min-height: 320px,
   resize: vertical, further down this file) is for a STANDALONE stage only
   (a different chunk's territory); a variant option's stage
   overrides all three: 'min-height: 0' lifts the floor, 'resize: none' drops
   a drag handle 'pointer-events: none' already made ungrabbable here, and
   'overflow: hidden' is the clip -- deliberately with no added
   "there is more below" marker, the same fault this whole feature exists to
   fix, one level down; the expand control another chunk is landing is the
   way to the rest.
   'height: 320px' is NOT an arbitrary starting number -- it is the exact
   value of the floor this whole rule replaces. Measured in real Chrome
   (src/render.mjs's stageAgentScript, "WHEN this runs" comment above
   reportHeight): a stage's first accurate report is deferred (two nested
   requestAnimationFrame calls, waiting for this document's own first layout
   pass), and either that or ResizeObserver's own first delivery can in
   principle be late or, on a sufficiently old or unusual browser, never
   arrive at all. A lower placeholder here (200px shipped in an earlier cut
   of this rule, before that measurement) would leave a variant option's
   stage WORSE than the fixed floor it was meant to improve on for as long as
   -- or, in the never-arrives case, for as often as -- that gap lasts. 320px
   makes "no report yet" cost nothing next to today's behaviour; a real
   report still grows or shrinks the box exactly as intended the
   moment it lands. 'max-height' is a CSS backstop for the same cap
   handleStageHeight enforces in JS (STAGE_HEIGHT_CAP, src/ui.mjs) --
   hand-kept at the same value, the way QUIRKS.md's "Two stylesheets, one
   palette" already documents for this file's stage-side hex, since neither
   file can read a value out of the other; the clamp that actually matters
   against a hostile report is the one in JS, which runs before a value ever
   reaches this box's inline style. */
.choice-variant .html-stage { min-height: 0; height: 320px; max-height: 600px; resize: none; overflow: hidden; }

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
/* the diagram's expand control. Same
   pill chrome as the comment button beside it in the kicker, written out rather
   than folded into the selector above so neither rule's exact text moves (several
   rules in this file are asserted by their text -- QUIRKS.md). It deliberately
   does NOT also carry .comment-btn: that class is what wireRoot binds the
   "open a block-level comment form" click handler to. */
.expand-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent;
  border: 1px solid var(--hairline); color: var(--muted); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; border-radius: var(--r-pill); padding: 4px 10px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease); }
.expand-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }

.comment-list { margin-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.comment-item { position: relative; font-size: 12.5px; color: var(--ink-2); background: var(--panel-2);
  border: 1px solid var(--hairline); border-left: 2px solid var(--hairline-2);
  border-radius: var(--r-sm); padding: 8px 12px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease); }
/* queued locally, not yet sent -- matches the hollow .pin-pending badge.
   Only a PENDING entry ever carries a delete control
   (a sent comment has none), so only it reserves gutter space
   for one. */
.comment-item.comment-pending { border-style: dashed; border-color: var(--accent); border-left-color: var(--accent); padding-right: 30px; }
.comment-item .comment-anchor { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; margin-right: 8px; }
.comment-item .comment-lost { color: var(--critical); }
/* the "x" on a queued comment's own
   list entry -- removes that one entry, its hollow pin, and (src/ui.mjs's
   refreshPendingCommentItems) renumbers whatever queued comments are left so
   the sequence stays contiguous. */
.comment-delete { position: absolute; top: 6px; right: 6px; background: transparent; border: none;
  color: var(--muted); font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: var(--r-sm);
  cursor: pointer; }
.comment-delete:hover { color: var(--critical); background: var(--panel-3); }

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

/* code: a file plus a line range or section, no syntax highlighting. A reference
 * can run to hundreds of lines and previously had
 * no height cap at all, pushing everything below it off-screen -- capped at
 * ~480px (roughly 24 lines at this font-size/line-height) with overflow: auto
 * and resize: vertical. NOT quite the idiom '.html-stage' below uses, despite
 * the family resemblance and despite what the spec that ordered this said: that
 * one is FLOORED (min-height: 320px) and resizable, which is a different thing
 * from capped and resizable, and the difference is the whole reason the next
 * paragraph exists. A min-height leaves the resize handle free to move the box
 * in both directions; a max-height does not.
 * A short block's natural height never reaches the cap, so it renders untouched
 * (max-height only ever caps, never pads a shorter box out to it) -- but a
 * genuinely long one needs one more thing THIS rule alone cannot give it:
 * max-height clamps the box even against the explicit height its own resize
 * handle sets while dragging, so a capped block would otherwise be undraggable.
 * src/ui.mjs's unlockCodeCapForDrag converts the cap to a plain height, once,
 * the moment a block is confirmed to actually be capped -- see its own comment. */
.code-block pre { background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-md);
  padding: 12px 14px; overflow: auto; margin: 0; max-height: 480px; resize: vertical; }
.code-block pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.55; color: var(--code-ink); }

/* html stage: sandboxed iframe so a hand-mocked preview never leaks into the page */
.html-stage { display: block; width: 100%; min-height: 320px; resize: vertical; overflow: auto;
  border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--stage-bg); }

/* element-level anchoring: pin-layer overlays the html-stage iframe or
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

/* Both stage kinds are clickable at element level, and both read as pictures with no
   built-in cue of their own -- the comment-mode toggle is the one thing on the page
   that says so now (ADR.md 21 deleted the kicker's own per-stage hint: repeated once
   per variant option, in the place vertical space is scarcest, saying what the toggle
   was already visible chrome to say). A mermaid node highlights under the cursor (the
   html stage's equivalent is injected into the iframe's own document by src/ui.mjs,
   since this stylesheet deliberately does not reach inside it). Neither applies in a
   standalone file: archive, where nothing is clickable. One gesture,
   toggle-gated everywhere -- a diagram node is no longer a standing exception either,
   so both rules below also require body.comment-mode, the same class setCommentMode
   (src/ui.mjs) toggles for every other anchoring rule. */
${mermaidNodeRule('body.comment-mode:not(.readonly) .mermaid-block svg g')} { cursor: pointer; }
${mermaidNodeRule('body.comment-mode:not(.readonly) .mermaid-block svg g', ':hover')} { outline: 2px solid var(--accent); outline-offset: 3px; }
/* a node that already carries a SENT
   comment is no longer a comment target at all while comment mode is on --
   de-affordanced (not-allowed cursor, no hover outline) rather than marked
   permanently, riding this same body.comment-mode class rather than a
   standing state.
   .cb-anchor-sent is stamped onto the live SVG node by src/ui.mjs's
   wireMermaidBlock, from board.comments -- placed after the two rules above
   so its equal-specificity override wins by source order. */
body.comment-mode:not(.readonly) .mermaid-block svg g.cb-anchor-sent { cursor: not-allowed; }
body.comment-mode:not(.readonly) .mermaid-block svg g.cb-anchor-sent:hover { outline: none; }

/* --- the diagram lens ----------
   A full-viewport <dialog> src/ui.mjs builds once, lazily, and reuses: drag pans,
   scroll zooms, fit and 1:1 reset the view. Modelled on /explain's lens
   (~/.claude/skills/explain/template.html), with two differences that are the
   whole reason this one exists -- it is opened only by the explicit .expand-btn
   (never by clicking the diagram, which keeps its comment meaning), and its
   contents are commentable.

   Every value below is a token from :root, and so, now, is the mermaid diagram
   INSIDE the lens: this comment used to say those colours were 'hardcoded' in
   src/ui.mjs, which was true when this shipped and stopped being true when
   the light theme landed -- 'mermaidThemeVariables()' reads the live computed
   value of a CSS token per mermaid variable through MERMAID_TOKEN_MAP (QUIRKS.md
   "Two stylesheets, one palette", which records the same correction; only the
   html stage's own injected stylesheet still carries a literal hex, and it is
   one value for two stage surfaces because it clears 3:1 on both, not because
   the stage is one colour). The lens clones an already-rendered SVG, so it
   inherits whatever the ACTIVE palette produced and adds no colour of its own --
   but that also means a clone taken before a theme switch is stale, which is what
   src/ui.mjs's lensRetheme exists to fix. */
.diagram-lens { width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh;
  margin: 0; padding: 0; border: none; background: var(--bg); color: var(--ink); overflow: hidden; }
.diagram-lens[open] { display: flex; flex-direction: column; }
.diagram-lens::backdrop { background: var(--bg); }
.lens-bar { display: flex; align-items: center; gap: var(--space-2); flex: none;
  padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--hairline);
  background: var(--panel); font-size: 11px; }
.lens-title { letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600;
  color: var(--accent); margin-right: auto; }
.lens-hint { color: var(--muted); font-style: italic; }
.lens-pct { color: var(--ink-2); min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
.lens-btn { background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink-2);
  border-radius: var(--r-sm); padding: 4px 11px; font: inherit; font-size: 11px; font-weight: 600;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
.lens-btn:hover { border-color: var(--accent); color: var(--accent); }
/* The block's OWN comment form is moved in here while the lens is open (src/ui.mjs
   lensAdopt) rather than duplicated -- "the same comment as one
   minted inline" is then true of the markup, not just of the anchor: one <form>,
   one submit handler, one pendingComments queue. Collapses to nothing while the
   form is closed, which is its state until a node is actually clicked. */
.lens-form-host { flex: none; padding: 0 var(--space-4); background: var(--panel); }
.lens-form-host .comment-form { margin: var(--space-2) 0; }
.lens-form-host .comment-target { margin-top: var(--space-2); }
.lens-stage { flex: 1; position: relative; overflow: hidden; cursor: grab;
  touch-action: none; user-select: none; }
.lens-stage.lens-dragging { cursor: grabbing; }
/* transform-origin at the top-left is what makes src/lens.mjs's view math mean
   what it says: a canvas-local point p renders at x + s * p, with no half-size
   correction anywhere. The pins live INSIDE this transform (src/ui.mjs's
   renderLensPins) and are counter-scaled per pin, so panning and zooming move
   them for free while each stays 20px on screen. */
.lens-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.lens-canvas svg { display: block; max-width: none; }
${mermaidNodeRule('body.comment-mode:not(.readonly) .lens-canvas svg g')} { cursor: pointer; }
${mermaidNodeRule('body.comment-mode:not(.readonly) .lens-canvas svg g', ':hover')} { outline: 2px solid var(--accent); outline-offset: 3px; }
/* the clone carries whatever .cb-anchor-sent stamps wireMermaidBlock put on the
   live diagram, so a node with a sent comment is de-affordanced in the lens for
   exactly the same reason and by exactly the same mechanism as it is inline */
body.comment-mode:not(.readonly) .lens-canvas svg g.cb-anchor-sent { cursor: not-allowed; }
body.comment-mode:not(.readonly) .lens-canvas svg g.cb-anchor-sent:hover { outline: none; }

/* --- the html-stage lens --------------------
   The second lens src/ui.mjs builds, wearing the first one's chrome ('.lens-bar',
   '.lens-title', '.lens-btn' above are shared verbatim) and none of its view
   maths: what it frames is a live iframe, which scrolls and lays itself out on
   its own, not a cloned SVG on a pannable canvas. Hence no cursor: grab, no
   touch-action and no user-select here -- every one of those would fight the
   mock's own pointer input, which is the whole point.

   Three things this layout is load-bearing for, none of them decoration:
   - 'min-height: 0' on the body. A flex child's default min-height is auto, i.e.
     'never smaller than my content' -- and an iframe's content is a whole
     document, so without this the body grows past the dialog and the frame
     scrolls the PAGE instead of scrolling itself.
   - the body's padding is the lens's clickable surround. src/ui.mjs closes on a
     click landing on the dialog or on this element (the backdrop
     half); a dialog that filled the viewport edge to edge with the frame would
     leave nothing outside the stage to aim at.
   - the frame is sized in CSS, not by the stage. An iframe's intrinsic size is
     300x150 regardless of what it holds, so 'a mock with its own scrollable
     content can be scrolled here' needs a real box given from this side. */
.stage-lens { width: 100vw; height: 100vh; max-width: 100vw; max-height: 100vh;
  margin: 0; padding: 0; border: none; background: var(--bg); color: var(--ink); overflow: hidden; }
.stage-lens[open] { display: flex; flex-direction: column; }
.stage-lens::backdrop { background: var(--bg); }
.stage-lens-body { flex: 1; min-height: 0; padding: var(--space-4); background: var(--bg); }
.stage-lens-frame { display: block; width: 100%; height: 100%; border: 1px solid var(--hairline);
  border-radius: var(--r-md); background: var(--stage-bg); }
/* the pick control's slot, between the title (which
   carries 'margin-right: auto') and close. Note what is NOT in the two rules
   above, and is load-bearing for this one: neither the body nor the frame is
   positioned or given a z-index, so the framed stage stays in normal flow BELOW
   this bar and a mock has no way to paint over the one control that records an
   answer. The stage is a cross-origin iframe -- it renders only inside its own
   box -- so "outside the frame" is a structural guarantee here rather than a
   stacking-order race. */
.lens-actions { display: inline-flex; align-items: center; gap: var(--space-2); }
/* the one control in either lens that RECORDS something, so it does not wear the
   same quiet chrome as 'close' beside it: accent-filled, the same visual weight
   .btn-primary gives Send. Disabled when the pick would be refused anyway (a
   historical round, comment mode -- src/ui.mjs's stageLensPick), which has to
   look unavailable rather than merely unresponsive. */
.lens-pick { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.lens-pick:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-ink); filter: brightness(1.08); }
.lens-pick:disabled { background: var(--panel-2); border-color: var(--hairline); color: var(--muted); cursor: not-allowed; }

/* the generic comment-mode hover outline ("before
   committing the reviewer can see exactly which element will be anchored"). Set
   from JS (src/ui.mjs) on the innermost element under the cursor, never via a
   :hover rule -- that would outline every ancestor in the chain at once. The
   iframe's own copy of this same outline (wireHtmlStage) is a hardcoded hex
   injected into the sandboxed document's own <style>, since this stylesheet
   deliberately does not reach in there -- see QUIRKS.md "two stylesheets, one
   palette". */
.cb-anchor-hover { outline: 2px solid var(--accent); outline-offset: 2px; cursor: pointer; }
/* applied INSTEAD OF .cb-anchor-hover
   the moment an element already carries a sent comment -- no outline, and a
   cursor that says clicking here does nothing.

   Gated on body.comment-mode, and that gate is the whole rule rather than a
   tidy-up. The class reaches this selector two ways with opposite lifetimes:
   src/ui.mjs's mouseover listener adds it transiently, and only ever while
   comment mode is on (the listener returns immediately otherwise), so the gate
   costs that path nothing; but wireMermaidBlock and the .comment-btn wiring
   STAMP it permanently, at wire time, on a diagram node and on a heading's
   anchor button. Unscoped, those permanent stamps put a not-allowed cursor on
   the READING view of a settled board -- the state most pins are in -- which
   is exactly what the spec's Decision rules out: "de-affordanced in comment
   mode only ... the reading view stays unmarked". The two mermaid-specific
   rules above already carried this gate; this generic one did not. */
body.comment-mode .cb-anchor-sent { cursor: not-allowed; }
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
/* the scrim's whole job is telling the reviewer content
   still runs on underneath the bar -- at the round's own end (.round-end on screen,
   src/ui.mjs's setupSendBarDock) that stops being true, so the scrim goes with it and
   the bar docks flush instead, a plain opaque panel.
   No hairline of its own, and that is the point of the condition: '.docked' means
   the closing rail is on screen, and that rail IS a full-width line, drawn a
   couple of rows above. A border here put a second horizontal rule under the
   first, so the foot of a fully scrolled round read as two dividers separating
   nothing. Undocked there is no rail on screen and no border either -- the
   gradient scrim above is what separates the bar from the content running on
   underneath it. */
.send-bar.docked { background: var(--bg); backdrop-filter: none; }
/* the questions-left pill (ADR.md entry 27): a
   live, additive count of the open round's still-unanswered questions, floating
   centered above the send bar. Nested INSIDE .send-bar itself rather than beside
   it -- position: absolute against the bar's own sticky positioning is exactly
   "floating over the content, centered above the send bar" with no separate
   fixed-position layer or z-index of its own to reason about, and it inherits
   body.readonly .send-bar { display: none } for free (QUIRKS.md "Readonly is
   locked twice" -- here nesting buys the second mechanism at no cost, rather than
   needing one hand-written). Hidden by default -- no .visible class -- rather than
   the 'hidden' attribute (QUIRKS.md "el.hidden does nothing when a class in our
   own stylesheet sets display"): .visible is the only rule that ever turns
   display on, so there is exactly one place deciding it, in src/ui.mjs's
   updateQuestionsLeftPill. Grey, not the send guard's warning amber -- amber
   stays "you got into a state", this is the ordinary unanswered-mid-round case. */
.questions-left-pill { display: none; position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%);
  margin-bottom: var(--space-3); background: var(--panel-2); color: var(--ink-2);
  border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 7px 16px;
  font: inherit; font-size: 12.5px; font-weight: 600; box-shadow: var(--shadow-2);
  cursor: pointer; white-space: nowrap;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
.questions-left-pill.visible { display: inline-flex; align-items: center; }
.questions-left-pill:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }
/* AC 11 (second half): the ordinary board's own half of the waiting signal --
   the page-board pill's '.round-meta' above is the other half of the same
   rule. A muted, always-visible figure beside the send bar's own status text,
   never a second colour: the open round's countdown is informational, not a
   state the reviewer needs to act on. Hidden by default, the same
   single-decider idiom '.questions-left-pill'/'.back-to-top' already use --
   src/ui.mjs turns it on only while the open round is genuinely awaited. */
.round-countdown { display: none; color: var(--muted); font-size: 12.5px; align-self: center; white-space: nowrap; }
.round-countdown.visible { display: inline; }

/* --- the round pager: the board's pages, always both controls (ADR.md entry 42,
   criterion 26) ---------------------------------------------------------------

   Two positions, per the spec's decision: the pill sits bottom-centre and the
   chevrons at the two edges. Both are position: fixed and both are siblings in
   the markup rather than dock-wraps-chevrons -- the dock's own centring
   transform would otherwise make it the containing block for anything fixed
   inside it, pinning the chevrons to the dock instead of the viewport.

   Never hidden, on any page: the pager is how a page board's reader reaches the
   question round and how a question round's reader gets back to the artifact, so
   unlike the send bar it survives body.page-board, body.sent-page and
   body.readonly (an archive's rounds are pages too). Above the send bar's own
   z-index, since on an ordinary round it sits in the bar's otherwise empty
   left/centre -- the bar's contents are right-aligned. */
/* The dock is the fixed, centred box, not the pill inside it: the caption sits
   above the numerals and shares their centre line, and stacking both in one
   fixed column is what holds that with no measured offset between them.

   Its real rendered height also drives '--round-pager-dock-h' (see
   '.page-comments' below, ticket 02 SPEC_AWAITED.md): setupPagerDockHeightTracking
   (src/ui.mjs) measures this box with a ResizeObserver and writes that
   custom property, so a panel that has to clear the dock reads its actual
   height off the browser's own layout -- whatever that ends up being, one
   row, two rows, or a third row nobody has drawn yet -- instead of a number
   someone typed once and nobody re-measured.

   CSS anchor positioning ('anchor-name'/'anchor()') was tried here first and
   reverted: it requires the anchor to precede the positioned element in tree
   order, which '.page-comments' does not (it is nested inside the page
   board's own '.block.html-block', rendered well before this dock in
   src/render.mjs), and moving it earlier in the DOM ran into a second,
   separate containing-block problem on top of that -- confirmed wrong in a
   real Chrome (getComputedStyle().bottom computed to 'auto', not the
   anchored value), which this repo's DOM stand-in cannot see at all
   (QUIRKS.md, "The stand-in has no layout") and did not catch. */
.round-pager-dock { position: fixed; z-index: 40; left: 50%; bottom: var(--space-4); transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  max-width: min(560px, calc(100vw - 2 * var(--space-6))); }
/* ...and the floor the dock floats over has to end above it. On an open round
   the send bar holds that space: it is sticky, it is the last thing in the
   shell, and the dock sits in the bar's own empty left/centre (see the dock
   comment above). A round that has been sent hides that bar -- so the last
   question's own controls ran on to the very bottom of the document and the
   dock's caption printed straight over them.
   The reservation is the same expression '.page-comments' clears the dock with,
   token for token, so the two can never drift: the dock's own bottom offset,
   plus its measured height, plus a gap.
   An archive needs it for a wider reason than a sent round does: body.readonly
   hides the send bar on EVERY archive, open round or not, so the floor is
   missing there whether or not the last round was ever sent -- which is why
   'body.readonly' reserves on its own and not only in company with
   'body.sent-page'. It reserves unconditionally because the dock renders
   unconditionally: renderRoundPager (src/render.mjs) prints it for a
   one-round board too, so there is no archive whose last block is not under
   it. '.board-shell''s own comment near the top of this file used to pin an
   archive flush ("one rule answers both endings"); that promise was written
   before this dock existed and is rewritten with this rule, in that comment
   and in test/check-round-end.mjs together.
   One board stays carved out, and the carve-out is load-bearing:
   'body.page-board' has a fixed 100vh frame that must not grow, and its
   floating comment panel already clears the dock by this exact formula. */
body.sent-page:not(.page-board) .board-shell,
body.readonly:not(.page-board) .board-shell {
  padding-bottom: calc(var(--space-4) + var(--round-pager-dock-h, 84px) + var(--space-3)); }
/* The one place the pager still spends a title: the round the reviewer is
   actually on, named in full. Ellipsed rather than wrapped, so an agent-supplied
   title of any length costs one line and never reflows the dock. */
.round-pager-caption { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-size: 11.5px; font-weight: 600; color: var(--muted); pointer-events: none; }
.round-pager { display: flex; align-items: center; gap: 2px; max-width: 100%;
  overflow-x: auto; background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); padding: 4px; box-shadow: var(--shadow-2); }
/* "Rounds" said once, over the row, instead of on every entry. */
.round-pager-lede { flex: none; padding: 5px 10px 5px 12px; font-size: 10px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.round-page { background: none; border: none; border-radius: var(--r-pill); padding: 5px 11px;
  font: inherit; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer;
  min-width: 30px; text-align: center; white-space: nowrap;
  transition: color var(--dur) var(--ease); }
.round-page:hover { color: var(--ink); }
.round-page-current { background: var(--panel); color: var(--ink); box-shadow: var(--shadow-1); }
/* the dot on the round that still owes an answer -- the mark's amber, the hue
   this board already spends on "waiting on you" (ADR.md entry 12). */
.round-page-owed::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 6px;
  border-radius: 50%; background: var(--accent); vertical-align: middle; }
.round-flip { position: fixed; z-index: 40; top: 50%; transform: translateY(-50%);
  width: 32px; height: 64px; display: flex; align-items: center; justify-content: center;
  background: var(--panel-2); color: var(--ink-2); border: 1px solid var(--hairline);
  font: inherit; font-size: 20px; line-height: 1; cursor: pointer; box-shadow: var(--shadow-2);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease); }
.round-flip:hover:not(:disabled) { color: var(--ink); border-color: var(--hairline-2); }
/* the ends of the board are dead ends, shown rather than hidden: a control that
   vanishes at the first page is one the reviewer has to find again on the next.
   (No digit after the word "round" anywhere in this stylesheet -- the index page
   embeds it, and test/check-pure.mjs reads the whole page when it checks that a
   row's round segment is a count and never an ordinal.) */
.round-flip:disabled { opacity: 0.25; cursor: default; }
.round-flip-prev { left: 0; border-left: none; border-radius: 0 var(--r-md) var(--r-md) 0; }
.round-flip-next { right: 0; border-right: none; border-radius: var(--r-md) 0 0 var(--r-md); }
.btn-send { background: var(--accent); color: var(--accent-ink); border: 1px solid transparent; border-radius: var(--r-md);
  padding: 11px 24px; font: inherit; font-size: 13.5px; font-weight: 650; box-shadow: var(--shadow-2);
  transition: filter var(--dur) var(--ease), transform var(--dur) var(--ease); }
.btn-send:hover:not(:disabled) { filter: brightness(1.08); }
.btn-send:active:not(:disabled) { transform: translateY(1px); }
/* the send guard's armed state: Send wears this
   only while armSendGuard has it armed because questions are still
   outstanding -- never for the plain Cmd+Enter arm at the end of a fully
   traversed round, which keeps the ordinary accent color and its own label
   (test/check-enter.mjs criterion 3 pins that one unchanged). */
.btn-send.warn { background: var(--warning-soft); color: var(--warning-ink); border-color: var(--warning-border-strong); box-shadow: none; }
.btn-send.warn:hover:not(:disabled) { filter: none; }
/* the second way out: returns the
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
/* align-items: center, not flex-start. The lockup used to be two stacked lines
   (title over a subtitle) and the actions row a single line, so top-aligning
   them was the only thing that put the controls level with the TITLE rather
   than floating in the middle of a taller block. With the subtitle gone both
   sides are one line each, and flex-start left the controls visibly riding
   above the title's optical centre. */
.index-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--hairline); }
/* The mark leads the index title rather than taking a control over: this page has
   no back control to absorb it, and it is the one page whose h1 IS the product
   name, so the two belong in a single lockup. */
.index-head-titles { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.index-head-titles > svg { flex: none; }
/* the gap separates the pomodoro widget from the theme toggle beside it */
.index-head-actions { flex: none; display: flex; align-items: center; gap: var(--space-3); }
/* 30px, up from 22px: the subtitle it used to sit above is gone, and the title
   takes that vertical space back rather than leaving the row short. Sized to
   fill the 36px mark's height without exceeding it, and margin: 0 with a
   line-height of 1 so the lockup's own centring has nothing to fight. */
.index-head h1 { font-size: 30px; line-height: 1; margin: 0; font-weight: 650; letter-spacing: -0.02em;
  min-width: 0; }

/* the pomodoro widget: src/pomodoro-widget.mjs
   is the markup, src/indexpage.mjs's indexScript is the behaviour -- see that
   module's own header comment for the split, the same one theme.mjs draws
   between themeToggle() and themeBootScript. */
.pomodoro-widget { display: flex; align-items: center; gap: var(--space-2); position: relative; }
/* the tomato stands in for the word "Pomodoro" -- same muted weight the status
   text beside it carries, so the pair reads as one label, not an icon plus a
   sentence */
.pomodoro-icon { color: var(--muted); flex: none; }
/* Invisible to the flex box -- src/pomodoro-widget.mjs
   wraps TOMATO_ICON/REST_ICON in this span so indexScript's renderPomodoro has a
   stable element to swap the glyph's MARKUP into (never the 'hidden' property,
   which .pomodoro-icon's own author 'display' rule already defeats -- see that
   rule's own history). 'display: contents' drops the wrapper out of the box tree
   entirely, so the glyph inside it still lays out as a direct child of
   .pomodoro-widget, gap and alignment unchanged from having no wrapper at all. */
.pomodoro-icon-slot { display: contents; }
/* Work only: a running, unpaused work interval turns the tomato
   up to the product's own amber, off the same --warning token the tab mark and
   the "waiting on you" surfaces already spend. Idle and paused stay at
   .pomodoro-icon's plain muted weight -- no class here at all -- because a
   break dropping to muted only reads as "turned down" if the running state was
   turned up, and idle was never turned up to begin with (spec decision).
   Two classes, not a lone modifier, so this can never outrank .pomodoro-icon
   itself on specificity regardless of declaration order. */
.pomodoro-icon.pomodoro-icon-amber { color: var(--warning); }
/* user-select: none on the status text alone -- the rest of the widget is
   buttons, which never need it, and the settings panel's inputs and labels sit
   outside this element entirely and stay selectable. Denies a double-click or a
   drag across a string that repaints every second from ever landing a selection
   on it. */
.pomodoro-status { font-size: 11.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap;
  user-select: none; }
/* Break/long break only: the status text drops to the SAME muted
   weight the rest glyph sits at, so the pair reads as one quiet state rather
   than a glyph that went quiet beside text that didn't. Two classes, same
   specificity reasoning as .pomodoro-icon-amber above. */
.pomodoro-status.pomodoro-status-rest { color: var(--muted); }

/* The start/pause/resume control: a real switch, knob left for off, knob right
   for on -- NOT the .mode-toggle pill it used to borrow. Two reasons it could
   not stay that pill: it carried no state a reader could see except the word on
   it, and it tried to hide itself with the 'hidden' property against
   .mode-toggle's own 'display: inline-flex', which is an author rule and so
   beats the UA sheet's '[hidden] { display: none }' outright -- it never hid,
   and showed as an empty pill with nothing to act on. This control is never
   hidden; when idle it starts a pomodoro.

   40x22 is deliberately under the 44px touch minimum, matching every other
   control in this header (.mode-toggle is ~28px tall): this page is a local
   desktop dashboard driven by a mouse, and sizing one control for touch while
   its neighbours stay small would look broken without helping anyone. If the
   header ever gets a real narrow-viewport treatment, that is where the 44px
   target belongs, applied to the whole row at once. */
.pomodoro-switch { display: inline-flex; align-items: center; justify-content: flex-start;
  width: 40px; height: 22px; flex: none; padding: 2px; box-sizing: border-box;
  background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-pill);
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
.pomodoro-switch:hover { border-color: var(--hairline-2); }
.pomodoro-switch-knob { width: 16px; height: 16px; border-radius: 50%; background: var(--muted);
  /* transform, never 'margin-left'/'left' -- the animation rules
     name animating layout properties as the anti-pattern; a transform stays off
     the layout path entirely. */
  transform: translateX(0);
  transition: transform var(--dur) var(--ease), background var(--dur) var(--ease); }
.pomodoro-switch[aria-checked="true"] { background: var(--accent-soft); border-color: var(--accent); }
/* 18px = the track's inner width (40 - 2*2 padding - 2*1 border = 34) minus the
   16px knob. Knob flush left when off, flush right when on. */
.pomodoro-switch[aria-checked="true"] .pomodoro-switch-knob { background: var(--accent); transform: translateX(18px); }
@media (prefers-reduced-motion: reduce) {
  .pomodoro-switch-knob { transition: none; }
}

/* Restart/Forward: one
   segmented pill between the status text and the switch, round two's picked
   variant -- panel background, hairline
   border, height matched to the 22px switch beside it so the row stays one
   visual line. overflow: hidden is what lets the two buttons' square corners
   sit flush against the pill's own rounded ends. */
.pomodoro-ctl-group { display: inline-flex; align-items: stretch; height: 22px; box-sizing: border-box;
  background: var(--panel-2); border: 1px solid var(--hairline); border-radius: var(--r-pill); overflow: hidden; }
/* Icon-only, no background/border of its own -- the group above carries both,
   and a second border here would double the hairline at the pill's own edge.
   Hover only brightens the icon (background stays the group's own panel-2 --
   a hover background here would be a no-op on top of it). */
.pomodoro-ctl { background: none; border: none; display: inline-flex; align-items: center;
  justify-content: center; width: 24px; color: var(--ink-2);
  transition: color var(--dur) var(--ease); }
.pomodoro-ctl:hover { color: var(--ink); }
/* The hairline divider between the two controls -- an adjacent-sibling border,
   not a third element, so there is nothing between them a screen reader could
   stumble on. */
.pomodoro-ctl + .pomodoro-ctl { border-left: 1px solid var(--hairline); }

/* The settings control is the cogwheel, not the words "Pomodoro settings":
   the header row is a row of controls, and a text link among them read as
   prose. Icon-only, so it carries an aria-label and a title (accessibility
   priority 1: an icon-only button without a label is the named
   anti-pattern) -- see src/pomodoro-widget.mjs for both.
   'display: flex' is what removes the native disclosure triangle in Firefox;
   'list-style: none' and the ::-webkit-details-marker rule cover the rest. */
.pomodoro-settings-summary { list-style: none; cursor: pointer; color: var(--muted);
  display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;
  border-radius: var(--r-sm); transition: color var(--dur) var(--ease), background var(--dur) var(--ease); }
.pomodoro-settings-summary::-webkit-details-marker { display: none; }
.pomodoro-settings-summary::marker { content: ''; }
.pomodoro-settings-summary:hover { color: var(--ink); background: var(--panel-2); }
.pomodoro-settings[open] .pomodoro-settings-summary { color: var(--ink); background: var(--panel-2); }
/* a native <details>/<summary> needs no JS to open or close -- the spec's own
   "lazy correct answer" for a settings panel collapsed by default. Popover
   positioning, not inline: opening it must not shove the countdown/theme
   controls sideways in the same header row. */
.pomodoro-settings-form { position: absolute; right: 0; top: 100%; margin-top: 6px; z-index: 5;
  display: flex; flex-direction: column; gap: var(--space-2); min-width: 220px;
  background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--r-md);
  padding: var(--space-3); box-shadow: var(--shadow-2); }
.pomodoro-field { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  font-size: 11.5px; color: var(--ink-2); }
.pomodoro-field-check { justify-content: flex-start; }
.pomodoro-field input[type="number"] { width: 60px; background: var(--panel-2); border: 1px solid var(--hairline);
  color: var(--ink); border-radius: var(--r-sm); padding: 4px 6px; font: inherit; }
/* The three cue pickers -- same field row, a <select> instead
   of a number input. Wider than the duration inputs above: a cue's value
   ("Submarine", "None") needs more than 60px, and unlike a duration there is
   no natural max-width to hold it to, so this caps rather than fixes it. */
.pomodoro-field select { max-width: 120px; background: var(--panel-2); border: 1px solid var(--hairline);
  color: var(--ink); border-radius: var(--r-sm); padding: 4px 6px; font: inherit; }
/* The Cues section's own hairline + caption -- no fold, no tab, everything the
   panel can do is visible the moment it opens (the spec's own placement
   decision). Caption styled like .note-field label's own small-caps treatment,
   not a second, competing type scale. */
.pomodoro-settings-divider { border: none; border-top: 1px solid var(--hairline); margin: 2px 0; }
.pomodoro-settings-caption { font-size: 10.5px; font-weight: 600; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--muted); }
.pomodoro-settings-actions { display: flex; gap: var(--space-2); margin-top: var(--space-1); }
.pomodoro-btn { background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink-2);
  font-size: 11px; font-weight: 600; border-radius: var(--r-pill); padding: 6px 12px; font: inherit;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
.pomodoro-btn:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }
/* Save is the panel's one primary action, so it wears the accent the way
   .search-btn and .btn-send already do, rather than sitting at the same visual
   weight as Reset beside it. Same filter: brightness(1.08) hover those two use,
   so all three primaries behave identically. */
.pomodoro-btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 650; }
.pomodoro-btn-primary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-ink); filter: brightness(1.08); }
/* the reset button's armed ("Really reset?") state -- indexScript toggles this
   class alongside the label swap, on the same element the two-step confirm
   already relabels, never a second control. */
.pomodoro-reset-btn.armed { border-color: var(--critical); color: var(--critical); }

.search-form { display: flex; gap: var(--space-2); margin: 0 0 var(--space-5); }
.search-input { flex: 1; min-width: 0; background: var(--panel-2); border: 1px solid var(--hairline); color: var(--ink);
  border-radius: var(--r-md); padding: 10px 14px; font: inherit;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.search-btn { background: var(--accent); color: var(--accent-ink); border: none; border-radius: var(--r-md);
  padding: 10px 20px; font: inherit; font-weight: 650; transition: filter var(--dur) var(--ease); }
.search-btn:hover { filter: brightness(1.08); }

/* No '.search-results' / '.result-*' rules any more: the box filters the thread
   list in place (src/indexpage.mjs filterThreads) instead of rendering a second
   set of block-level result cards beneath it, so the rows a query produces are
   .thread-item rows and are already styled below. */

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
/* headline: the board title (or, title-less, the project folder name) — was .thread-cwd,
   which held the full path as the bold headline; the path is now demoted to .thread-path */
.thread-title { display: flex; align-items: center; gap: var(--space-2); font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; }
.thread-path { color: var(--muted); font-size: 12.5px; }
.thread-meta { color: var(--muted); font-size: 12px; }
.thread-status { display: flex; align-items: center; gap: var(--space-3); flex: none; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warning); display: inline-block;
  box-shadow: 0 0 0 0 var(--warning-ring); animation: cb-pulse 2.4s var(--ease) infinite; }
@keyframes cb-pulse {
  70% { box-shadow: 0 0 0 7px var(--warning-fade); }
  100% { box-shadow: 0 0 0 0 var(--warning-fade); }
}
/* Only ever rendered when count > 0 (ADR.md entry 25) -- there is no zero state
   to style, so the amber "waiting on you" treatment is the whole rule. */
.rounds-left-badge { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--warning); background: var(--warning-soft); border: 1px solid var(--warning-border-strong);
  border-radius: var(--r-pill); padding: 4px 12px; }

/* --- the page board: one rendered artifact, filling the viewport -------------
   A board whose blocks are one html block and nothing else (src/render.mjs's
   isPageBoard -- ADR.md entry 33, inferred from the board's shape, never
   declared) renders the artifact edge to edge instead of in a porthole. Nothing
   here is a new component: every rule below overrides a value the ordinary board
   already sets, on one class src/render.mjs puts on <body> and src/ui.mjs takes
   off again the moment a live round makes this an ordinary board.

   Two geometry decisions carry the whole layout:

   - the header FLOATS (position: fixed) rather than sticking. A sticky header is
     in flow, so it would push a 100vh frame down by its own height and put the
     artifact's last 80px below the fold with nothing able to scroll to it. Fixed
     takes it out of flow, so the frame starts at the top of the viewport and the
     document's height is exactly the frame's (ADR.md entry 40, whose condensing
     behaviour lands on top of this).
   - the frame is a CONSTANT 100vh and scrolls its own content; the page itself
     does not scroll at all (ADR.md entry 34). Not min-height, not a height
     grown from what the artifact reports: the rendered templates use
     position: sticky and their own full-viewport <dialog>, and both of those
     mean something only against a viewport-sized box. 'resize: none' drops the
     drag handle for the same reason -- a frame the reviewer can resize is a
     frame whose height changes while it is read.

   The comment surface is what has to move (.page-comments, emitted only by the
   page-board branch of renderHtmlBlock): a form under a 100vh frame is a form
   below the fold on a page that cannot scroll, so it floats over the artifact
   instead, bottom centre. Its panel only appears when it holds something -- the
   form is display: none until a click inside the stage opens it, and a page
   board's comment list is empty until a later round's submit -- so an empty
   surround is never painted over the artifact. */
body.page-board { overflow: hidden; }
/* The artifact keeps the whole viewport, and the header floats over it -- ADR.md
   entry 40's overlay, unchanged. A band reserved at the top instead (tried, and
   reverted at the reviewer's call) fixed the overlap by charging the artifact
   for it permanently: 80px of every page, at every scroll position, spent on
   chrome that is only 40px tall and only in the way at the very top. The air
   the pill needs is air ABOVE the pill (its margin-top, further down), not a
   strip taken out of somebody's rendered page. */
body.page-board .board-shell { max-width: none; padding: 0; }
body.page-board .board-head { position: fixed; top: 0; left: 0; right: 0;
  margin-bottom: 0; padding: var(--space-3) var(--space-5); }
body.page-board .blocks { gap: 0; }
body.page-board .round { gap: 0; }
/* no card: the artifact is the surface, so the block's panel, hairline, radius,
   padding and hover lift all go (the hover selector is repeated rather than
   trusted to inherit -- '.round-open .block:hover' outranks a plain
   'body.page-board .block'). */
body.page-board .block, body.page-board .block:hover {
  background: none; border: none; border-radius: 0; padding: 0; box-shadow: none; }
body.page-board .html-stage { height: 100vh; min-height: 0; border: none; border-radius: 0; resize: none; }
/* ADR.md entry 35: a page board is not sendable. Same idiom, same guarantee as
   'body.readonly .send-bar' above -- the bar stays in the markup because a round
   arriving over SSE turns this board into an ordinary one in place (src/ui.mjs's
   applyRoundPush drops the class), and a queued comment needs it to leave on. */
body.page-board .send-bar { display: none; }
/* the archive's banner is in flow above the header, which would push the frame
   off the bottom of a viewport that cannot scroll -- floated into the corner the
   comment panel and the header both leave free. */
body.page-board .readonly-banner { position: fixed; left: var(--space-5); bottom: var(--space-5);
  z-index: 30; margin-bottom: 0; max-width: 320px; }
/* Raised clear of the round pager, which owns the bottom-centre strip on every
   page (ADR.md entry 42). Ticket 03 (SPEC_AWAITED.md) puts a send control
   inside this panel at every comment count, so it can no longer be sized by
   a number picked to fit today's content -- '2379f12' already broke exactly
   that once, when the pager grew a caption row above its pill and this
   panel's hardcoded '44px' (sized for the old single-row pill) started
   sitting under it instead of above it.

   '--round-pager-dock-h' is not a second copy of a number: it is written by
   setupPagerDockHeightTracking (src/ui.mjs), a ResizeObserver on the real
   '.round-pager-dock' element, so this 'bottom' tracks whatever that box's
   ACTUAL rendered height is -- at any viewport height, at every comment
   count, and through any future change to the dock's own shape -- with no
   value here to fall out of step. The var()'s own fallback (84px) is a
   deliberately generous floor for the window before that observer's first
   callback lands (a real Chrome does not guarantee that callback is
   synchronous with layout -- see setupPagerDockHeightTracking's own comment)
   and for a browser without ResizeObserver at all -- wrong by construction
   (it cannot know the dock's real height either) but wrong on the safe
   side, clear of even a three-line dock.

   Confirmed 2026-08-07 against a real Chrome (127.0.0.1, examples/sample-board.html,
   not this repo's DOM stand-in, which cannot see any of this -- QUIRKS.md,
   "The stand-in has no layout"): with the dock actually measured at
   63.4px tall, '--round-pager-dock-h' resolved to '63.40625px' and this
   'bottom' computed to '91.4062px' -- exactly var(--space-4) [16px] +
   that measurement + var(--space-3) [12px], not the fallback. With the
   panel given real content (0, 4, then 20 queued comments, the last one
   911px tall and overflowing off the TOP of the viewport) its measured
   rect bottom stayed exactly 12px above the dock's measured rect top in
   every case, because the panel grows upward, away from the dock -- the
   clearance is a property of the DOCK's height alone, not the panel's. */
/* SPEC_AWAITED.md ticket 03: the panel used to grow upward with NO ceiling --
   fine while it only ever held the compose form and a short list, wrong the
   moment ticket 03 put a send control inside it (AC 4) that has to stay
   reachable at every comment count. Measured against the merged branch on a
   357px-tall viewport before this change: at 12 comments the panel's own TOP
   edge sat at -338px, at 30 comments -1130px -- reachable at zero comments and
   unreachable everywhere past a handful. 'max-height' below puts a ceiling on
   the panel itself, tied to the SAME '--round-pager-dock-h' the 'bottom' value
   already reads (no second number to keep in sync): whatever the dock's real
   height is, the panel's own height is capped at "the rest of the viewport,
   minus this panel's own bottom offset, minus 72px of headroom for the
   condensed header pill (ADR.md entry 40) plus its own gap" -- so the panel's
   top edge can never rise above that fixed distance from the viewport's top,
   at ANY comment count. '.comment-list-wrap' is what actually absorbs the
   overflow: 'flex: 1 1 auto; min-height: 0' lets it shrink below its content's
   natural height and scroll internally, while the compose form and
   '.page-send-bar' below it stay 'flex: none' -- their own natural size,
   never scrolled, always the last thing on screen no matter how long the list
   above them grows. The hint rides inside '.page-send-bar' now rather than
   sitting beside it (see its own rule below), so it is carried by the bar's
   'flex: none' rather than carrying one of its own. 'overflow: hidden' on the panel itself is a backstop, not
   the mechanism: the inner scroll is what is meant to absorb every case, this
   only guards against a measurement this comment did not anticipate. */
.page-comments { position: fixed; z-index: 30; left: 50%;
  bottom: calc(var(--space-4) + var(--round-pager-dock-h, 84px) + var(--space-3));
  max-height: calc(100vh - (var(--space-4) + var(--round-pager-dock-h, 84px) + var(--space-3)) - 72px);
  transform: translateX(-50%); width: min(640px, calc(100vw - 2 * var(--space-6)));
  display: flex; flex-direction: column; overflow: hidden; }
.page-comments:has(.comment-form.open), .page-comments:has(.comment-item), .page-comments:has(.page-send-bar) {
  background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--r-lg);
  box-shadow: var(--shadow-2);
  /* one inset on all four sides, the same --space-3 the condensed header pill
     insets its controls by HORIZONTALLY: these are the two surfaces that float
     over the artifact, at the top and the bottom of the same viewport, and they
     now share a radius (--r-lg), a shadow and a side inset. The old
     8px/16px/16px asymmetry read as a different object at the other end of the
     screen. The pill's own vertical inset is 6px rather than 12px, and that is
     not a mismatch to fix: the pill holds one row of controls and is sized by
     them (see its padding-block), while this panel stacks a list, a form and a
     bar, which need the room. */
  padding: var(--space-3); }
/* The scrollable half: only the LIST of already-left comments grows without
   bound and scrolls internally once it outgrows the panel's own max-height
   above -- the hint, the compose form and the send control are none of them
   inside this box, so they never scroll out of reach regardless of how many
   comments are queued. */
.comment-list-wrap { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
/* ADR.md entry 48: the click-to-comment gesture's own hint, back in exactly
   one place -- the awaited page board's empty comment panel, because comment
   mode already starts ON there (src/ui.mjs), so the mode toggle itself is no
   longer what reveals the gesture the way it is everywhere else.

   It rides the send bar's own row, at its left end: one short line does not
   need a row to itself, and the panel floats over somebody's artifact, so every
   row it does not spend is artifact the reader can still see. 'margin-right:
   auto' is what keeps the two buttons at the right end of that row without the
   bar having to change its own 'justify-content' -- and when the hint goes at
   the first queued comment (src/ui.mjs sets display:none), the buttons stay
   exactly where they were. */
.page-comment-hint { flex: 0 1 auto; min-width: 0; font-size: 11.5px; font-style: italic;
  color: var(--muted); margin: 0 auto 0 0; }
/* AC 4: one send control at every comment count, Discuss beside it -- the same
   '.btn-send'/'.btn-discuss' chrome the ordinary send bar uses, just inside
   this panel instead. 'flex: none' keeps it out of '.comment-list-wrap''s own
   scroll region (see this file's own comment on '.page-comments' above).

   'flex-wrap' is the narrow-window floor: the hint plus both buttons fit the
   640px panel comfortably, but on a phone-width board there is no row wide
   enough for all three, and wrapping puts the hint back on a line of its own
   rather than squeezing the controls. */
.page-send-bar { flex: none; display: flex; align-items: center; justify-content: flex-end;
  flex-wrap: wrap; gap: var(--space-3); padding-top: var(--space-2); }
/* AC 12: a wait that dies mid-read reverts the page to read-only WITHOUT
   throwing away anything already on screen -- src/ui.mjs adds this class the
   moment it learns the round's deadline has passed (a periodic client-side
   check, and an immediate nudge over the 'awaitExpired' SSE event) and removes
   none of the panel's existing '.comment-item' entries when it does. Locked
   twice, same discipline QUIRKS.md's "Readonly is locked twice" already
   documents for body.readonly: this hides the compose surface, and src/ui.mjs
   additionally disables the same elements' 'disabled' attribute, since a CSS
   rule alone leaves a control that looks gone but is not. */
.page-comments.expired .comment-form,
.page-comments.expired .page-comment-hint { display: none; }
/* The send bar itself STAYS, holding one frozen control that names where the
   comments went (badge.mjs's PAGE_SEND_EXPIRED_LABEL). Everything that could
   still start something goes: Discuss opens a second route to an agent that is
   no longer there. The button is disabled in the same sweep that adds this
   class, so this rule is presentation for a control that is already inert --
   not the lock itself. */
.page-comments.expired .page-discuss-btn { display: none; }
.page-comments.expired .page-send-btn { opacity: 1; cursor: default; font-style: italic;
  background: transparent; border-color: var(--border); color: var(--muted); }

/* --- chrome that gets out of the way (ADR.md entry 40) -----------------------
   Reading the artifact condenses the header into a single pill, centred at the
   top and floating over the page; scrolling back up expands it again.

   The condense has NO THRESHOLD. It is driven continuously by '--stage-p', a
   0-to-1 progress src/ui.mjs writes on <body> from the scroll offset a page
   board's stage reports -- the parent cannot see inside an opaque-origin frame,
   so the offset arrives over the stage channel (src/render.mjs's
   stageAgentScript) rather than being observed here. Every rule below is a
   'calc()' on that one number, so the pill forms and un-forms under the
   reader's own finger and there is no snap point to sit on. The threshold this
   replaced (one boolean flipped at 24px) made a reader parked on the boundary
   flap the whole header on and off, which is the failure a dead zone would only
   have narrowed rather than removed.

   'stage-scrolled' survives as a plain "is it off zero" flag, since the
   back-to-top control still needs a discrete 'display' switch (below) and a
   'display' cannot be interpolated at all.

   Everything condensing does is a change of BOX, never of flow: the header is
   already 'position: fixed' above, so the frame under it stays a constant 100vh
   through the whole cycle and a long artifact can never reflow mid-read. That
   is the entire reason entry 40 chose an overlay over a header that pushes.

   What condenses is the header's IDENTITY TEXT, not its controls. The title and
   the thread/id line go; the mark, the comment-mode toggle, the theme control
   and the round badge stay, so the pill is never decorative -- entry 40's
   "the pill keeps the comment-mode toggle, so the mode is switched mid-read
   rather than being suspended by the scroll". Collapsing those two elements
   rather than moving any control means there is still exactly ONE
   #comment-mode-toggle in the document, condensed or not: a second copy could
   disagree with the first about .active/aria-pressed, and src/ui.mjs's
   setCommentMode writes to one element by design.

   How the box moves without interpolating an intrinsic width. The header stays
   full-bleed at every progress and the pill is drawn by a ::before behind it,
   inset from both edges by a percentage of the header's OWN width -- so
   'inset-inline: calc(50% - var(--pill-half))' at p=1 is a centred band exactly
   one pill wide. The content converges on that same band through a matching
   'padding-inline', so chrome and controls arrive together. Percentages and
   plain lengths interpolate everywhere; 'width: 100vw' to 'width: fit-content'
   does not, which is what made an animation here look impossible before.

   --pill-half is measured once by src/ui.mjs (half the width of the controls
   that survive the condense) rather than hardcoded, because the round badge's
   label and the read-only slot both change width at runtime.

   --head-clear (see :root) is untouched on purpose. It is a scroll-margin for
   anchor jumps down a scrolling DOCUMENT, and a page board's document does not
   scroll at all ('body.page-board { overflow: hidden }' above) -- the artifact
   scrolls inside the frame. Nothing on a page board reads the token, so the
   header's height changing here cannot make it wrong. */
/* Both defaults live on <body> rather than on the header, because <body> is
   where src/ui.mjs writes them and because .back-to-top (further down, a
   sibling of the header) reads --stage-p too: declared on the header, it would
   shadow the written value there and be invisible everywhere else. */
body.page-board { --stage-p: 0; --pill-half: 120px; }
body.page-board .board-head {
  /* two terms: the header's own edge padding easing from --space-5 to the
     pill's tighter --space-3, plus the inset that walks the content into the
     centred band. --pill-half is measured to match this exact arithmetic
     (src/ui.mjs measurePillHalf), so the controls land with --space-3 of air
     inside the band and no more. */
  padding-inline: calc(var(--space-5) + var(--stage-p) * (var(--space-3) - var(--space-5))
    + var(--stage-p) * (50% - var(--pill-half)));
  /* 6px is not a token on purpose: the condensed pill is the one box on the
     surface whose height is set by nothing but its own contents (see the mark
     and badge rules below), and --space-2 left it 4px taller than the tallest
     thing in it. Every other progress reads --space-3 as before.
     "Its own contents" is literal, so the pill has no one height: measured in
     Chrome, 34.4px on a page board that is not awaited (the badge's 22.4px label is
     the tallest thing there) and 39.8px on an awaited one, where the
     comment-mode chip is 27.8px. Both are the box the controls ask for, which
     is the whole point -- what it is no longer is 64.4px, the figure it was
     held at by an identity block nobody can see. */
  padding-block: calc(var(--space-3) + var(--stage-p) * (6px - var(--space-3)));
  /* the air the floating pill sits in, and the only vertical space this header
     ever costs the artifact: it arrives with the pill (nothing at p=0, where
     the header is a full-bleed wash flush to the top edge) and it is --space-4
     rather than --space-3 so the pill reads as floating over the page rather
     than clipped to its top edge. */
  margin-top: calc(var(--stage-p) * var(--space-4));
  gap: calc(var(--space-4) + var(--stage-p) * (var(--space-3) - var(--space-4)));
  /* the expanded wash and the pill chrome are two layers, faded past each other.
     A gradient does not interpolate into a flat panel colour, and a
     'border-bottom' does not interpolate into a full pill border, so neither
     tries to: each lives on its own pseudo-element at its own opacity. */
  background: none; border-bottom: none;
  /* the blur belongs to the wash, not to the header's own box: left here it
     would frost a full-viewport band across the top of the artifact while the
     visible chrome is a 240px pill */
  backdrop-filter: none;
}
body.page-board .board-head::before,
body.page-board .board-head::after {
  content: ""; position: absolute; z-index: -1; pointer-events: none;
}
/* the pill: a centred band that grows out of the full-bleed header */
body.page-board .board-head::before {
  inset-block: 0; inset-inline: calc(var(--stage-p) * (50% - var(--pill-half)));
  background: var(--panel); border: 1px solid var(--hairline);
  /* --r-lg, not --r-pill: a stadium's lobes are half the box tall, so at the
     64.4px this used to draw they were taller than every label inside them and
     the chrome read as rounder than its own contents. Height was the cause and
     the radius the symptom -- the rules below hand the box back to its controls
     (34.4px to 39.8px, see the padding-block comment above), and a 14px corner
     on either is a corner rather than a capsule. */
  border-radius: var(--r-lg); box-shadow: var(--shadow-2);
  opacity: var(--stage-p);
}
/* the expanded header's own wash, leaving as the pill arrives. No border-bottom
   here either, for '.board-head''s own reason above: the wash IS the edge, and
   over an artifact the contradiction is sharper still -- the hairline drew a
   full-width rule across somebody's rendered page while the gradient underneath
   it was busy saying the page runs on. */
body.page-board .board-head::after {
  inset: 0;
  background: linear-gradient(to bottom, var(--bg) 62%, var(--bg-fade-0));
  backdrop-filter: blur(10px);
  opacity: calc(1 - var(--stage-p));
}
/* the identity text collapses horizontally, which is what lets the header's
   content reach the pill's width without anything being clipped mid-word. Ink
   leaves faster than the box does (the 1.8 multiplier): text at 10% opacity
   squeezed into 30px reads as a rendering fault, where an empty box reads as a
   box.

   It collapses VERTICALLY too, and that is not symmetry for its own sake:
   measured in Chrome, a title plus thread/id line is 52.4px tall, and a box at
   'max-width: 0' with 'opacity: 0' still contributes every one of those pixels
   to the header's height. That invisible column, not the mark or any control,
   was what made the condensed pill 64px tall around 22px of ink -- the reason
   the shape read as far rounder than its contents. The ceiling is a plain
   length so it interpolates, and the size of that ceiling is the whole trade:
   too low and the box starts clipping while the text is still legible, too high
   and the collapse is a jump at the very end of the ramp. 160px against a
   measured 52.4px identity block starts the squeeze around p=0.67, comfortably
   after the ink reaches zero (0.556 on the 1.8 multiplier above), and still
   leaves a block half again as tall as this one collapsing unseen. */
body.page-board .board-head-ident {
  min-width: 0; overflow: hidden;
  max-width: calc((1 - var(--stage-p)) * 60vw);
  max-height: calc((1 - var(--stage-p)) * 160px);
  opacity: calc(1 - var(--stage-p) * 1.8);
}
/* ...and the gap that held the collapsed block off the mark goes with it. At
   p=1 the identity block is a zero-by-zero box, so this gap was 12px of dead
   air between the mark and everything else -- the pill's contents sat visibly
   left-of-centre inside their own band. It also makes src/ui.mjs's
   measurePillHalf true: that function sums brand + the HEADER's gap + actions,
   which is the whole content width only once this inner gap is gone. */
body.page-board .board-head-title { gap: calc((1 - var(--stage-p)) * var(--space-3)); }
body.page-board .board-head h1,
body.page-board .board-head .meta { white-space: nowrap; }

/* What sets the condensed pill's height. Nothing here is a page-board layout
   rule in the sense of the ones above -- it is the three surviving controls
   being sized for a floating pill instead of a full-width header.

   The mark was the whole 46px: 30px of tile with 8px of air over and under it,
   wrapped around labels whose own line box is 18px. It is 22px at EVERY
   progress on a page board rather than easing 30 -> 22 with the ramp, because
   src/ui.mjs's measurePillHalf reads '.back-to-index'.offsetWidth and its
   ResizeObserver watches '.board-head-actions' alone: a width that moved with
   the ramp would leave --pill-half measured for a mark the header has already
   left, i.e. a band a few px wider than the contents it is drawn to fit.
   Observing the brand as well would re-measure on every scroll frame, forcing a
   layout inside the ramp and feeding --pill-half's own padding-inline change
   back into the observer that caused it. The cost of the constant is 8px of
   mark in the EXPANDED page-board header, where the mark is not what sets the
   height anyway (the title and thread/id lines are). */
body.page-board .back-to-index { width: 22px; height: 22px; }
/* markSvg writes width/height ATTRIBUTES, which a flex item keeps at its
   intrinsic size unless the box is told otherwise -- without this the 30px
   drawing simply overflows the 22px slot. */
body.page-board .back-to-index svg { width: 100%; height: 100%; }
/* The badge stops being a chip AS THE PILL ARRIVES, not on a page board as
   such: its stadium is a second round shape arguing with the pill's own, and
   its 5px of padding-block puts the box above the mark again -- both of which
   are complaints about the condensed pill. The expanded header has the room and
   reads thin without the chip, so the chip leaves on the ramp instead of being
   gone before the header has moved.
   'border: none' rather than a transparent border-colour is what lets
   '.board-head .round-badge:hover' stand -- that rule outranks this one on
   specificity, but a border-colour on a zero-width border draws nothing, so the
   hover survives as the colour lift alone and the control stays a control.
   The chrome moves to a ::before for the reason the header's own pill and wash
   use pseudo-elements: an opacity on the ramp is the only way this stylesheet
   can fade a colour at all (no color-mix() here -- see the token block at the
   top of this file: an archive has to render in whatever browser opens a
   file:// copy of it), and fading the badge itself would take its text with it.
   Only padding-BLOCK rides the ramp. Padding-inline is a constant 10px because
   measurePillHalf (src/ui.mjs) sums '.board-head-actions'.offsetWidth, and its
   ResizeObserver delivers after layout: an inline padding that moved with the
   ramp would leave --pill-half one frame stale, drawing the band a few px off
   the contents it is measured to fit -- the same trap the constant 22px mark
   above avoids, answered the same way. */
body.page-board .board-head .round-badge {
  position: relative; background: none; border: none;
  padding: calc(2px + (1 - var(--stage-p)) * 3px) 10px;
}
body.page-board .board-head .round-badge::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: var(--panel-2); border: 1px solid var(--hairline);
  border-radius: var(--r-pill); opacity: calc(1 - var(--stage-p));
}
/* ...which leaves the badge and the read-only note as two runs of text with no
   chrome between them. A hairline rule is the divider, so the pill reads as one
   toolbar rather than as a label that happens to have a word after it. */
body.page-board .round-meta { border-left: 1px solid var(--hairline); padding-left: var(--space-3); }
/* ...but not while the slot is empty, which on an awaited page board is exactly
   how it first paints: src/render.mjs leaves the countdown out at render time
   on purpose (a wall-clock figure only src/ui.mjs may compute) and fills it at
   hydrate. Without this the pill opens carrying a divider with nothing after it
   and 24px of air holding the space. */
body.page-board .round-meta:empty { display: none; }

/* the back-to-top control (ADR.md entry 40), in the questions-left pill's own
   shape -- one visual object for "a pill floating at the bottom of the board",
   deliberately not a second treatment. Two differences it has to have: it is
   'position: fixed' rather than absolute inside .send-bar (the bar is
   display:none on a page board AND in an archive, and this control has to
   outlive both), and it sits bottom-RIGHT, because bottom-CENTRE belongs to the
   round pager and two controls stacked on one point is a collision, not a
   layout.

   Hidden by default and turned on by '.visible' alone, the same single-decider
   idiom as .questions-left-pill -- and for the same reason (QUIRKS.md: the
   'hidden' attribute does nothing against our own stylesheet's display).

   '.visible' is the only part of this control that is still a boolean, and it
   has to be: 'display' has no interpolable midpoint, so something must flip it.
   It flips the instant the artifact leaves zero, and the control is at zero
   opacity there -- the FADE is driven by '--stage-p' like the header pill, over
   the last 40% of the ramp, so the two arrive as one gesture with the
   back-to-top trailing. Ordering it that way is deliberate: the reader is told
   "you are reading" first and offered the way back second. */
.back-to-top { display: none; position: fixed; z-index: 30;
  right: var(--space-5); bottom: var(--space-5);
  background: var(--panel-2); color: var(--ink-2);
  border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 7px 16px;
  font: inherit; font-size: 12.5px; font-weight: 600; box-shadow: var(--shadow-2);
  cursor: pointer; white-space: nowrap;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
.back-to-top.visible { display: inline-flex; align-items: center; }
body.page-board .back-to-top.visible {
  opacity: clamp(0, (var(--stage-p) - 0.6) * 2.5, 1);
  transform: translateY(calc((1 - var(--stage-p)) * var(--space-2))); }
.back-to-top:hover:not(:disabled) { border-color: var(--hairline-2); color: var(--ink); }

/* --- responsive: the board is a laptop surface first, but it has to survive a
   phone-width window without a horizontal scrollbar or a two-column squeeze --- */
@media (max-width: 860px) {
  .question-block { grid-template-columns: minmax(0, 1fr); }
  .compare-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  /* the header stacks here and grows from 81.4px to 115.4px (measured in
     Chrome), so every scroll-to-anchor target has to clear that much more --
     see --head-clear's own comment in :root */
  :root { --head-clear: 124px; }
  .board-shell, .index-shell { padding-left: var(--space-4); padding-right: var(--space-4); }
  .board-head { flex-direction: column; align-items: flex-start; gap: var(--space-2); }
  .block { padding: var(--space-4); border-radius: var(--r-md); }
  .send-bar { flex-wrap: wrap; }
  .send-status { width: 100%; margin-bottom: var(--space-2); }
  .btn-send, .btn-discuss { flex: 1; }
  .search-form { flex-wrap: wrap; }
}
`;
