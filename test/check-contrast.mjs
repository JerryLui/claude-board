// Contrast check: proves the light and dark palettes in src/styles.mjs are
// actually readable (WCAG 2.x, >= 4.5:1) rather than eyeballed. No network, no
// daemon, no DOM -- imports the palette objects directly.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { styles, palettes } from '../src/styles.mjs';

// src/styles.mjs's own source text, for the palette-object-read scan below --
// a handful of tokens (the tab mark's colours) are drawn straight from JS,
// never through a CSS var(), so `styles` alone can't see them referenced.
const STYLES_SOURCE = readFileSync(new URL('../src/styles.mjs', import.meta.url), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack || err);
  }
}

// --- WCAG 2.x relative luminance and contrast ratio -------------------------------

function parseColor(v) {
  v = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(v);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  throw new Error(`not a plain #hex or rgba() color token: ${v}`);
}

// sRGB channel -> linear-light, then the WCAG weighted sum.
function relativeLuminance({ r, g, b }) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// An alpha color has no luminance of its own -- composite it over the opaque
// surface it's being measured against first. Every surface token this file uses
// is itself opaque, so a single flat composite (not a recursive one) is enough.
function compositeOver(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

function contrastRatio(fgToken, bgToken) {
  const bg = parseColor(bgToken);
  const fg = compositeOver(parseColor(fgToken), bg);
  const L1 = relativeLuminance(fg), L2 = relativeLuminance(bg);
  const lighter = Math.max(L1, L2), darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** A surface token's OPAQUE rendered color: itself, if it's already opaque, or
 * composited over the page's own `--bg` if it's an alpha value (`--accent-soft`,
 * `--history-bg`, `--warning-soft`, `--critical-soft` -- every alpha surface a
 * body/accent text or a status color is measured against below). Mirrors what a
 * browser actually paints: an alpha background is never rendered against
 * nothing, and every alpha surface this file measures against sits, directly or
 * through further opaque layers, over the page's own `--bg` (`compositeOver`
 * above already does the arithmetic; this just picks its two arguments). */
function resolveSurface(palette, token) {
  const c = parseColor(palette[token]);
  if (c.a >= 1) return palette[token];
  const composited = compositeOver(c, parseColor(palette['--bg']));
  return `rgb(${composited.r}, ${composited.g}, ${composited.b})`;
}

// --- the bar ------------------------------------------------------------------

const MIN_RATIO = 4.5;
// Criterion 7: "Body text, muted text and accent text each clear 4.5:1 against
// every surface token they are used on." `--accent-soft` (`.md-content
// blockquote`, `.mode-toggle.active`, `.comment-btn:hover`) and
// `--history-bg` (`.round-history .block`) are two more surfaces body/accent
// text demonstrably sits on that this list used to omit -- a coverage gap, not
// a live failure (2026-07-31 audit: all pairs already clear the bar, worst is
// light `--accent` on `--accent-soft` at 4.87:1). Both are alpha, so
// resolveSurface above composites them over `--bg` first.
const SURFACES = ['--bg', '--bg-tint', '--panel', '--panel-2', '--panel-3', '--accent-soft', '--history-bg'];
const BODY_TEXT_TOKENS = ['--ink', '--ink-2', '--muted', '--accent'];

function assertClears(themeName, palette, textToken, surfaceToken) {
  const ratio = contrastRatio(palette[textToken], resolveSurface(palette, surfaceToken));
  assert.ok(ratio >= MIN_RATIO,
    `${themeName}: ${textToken} on ${surfaceToken}: ${ratio.toFixed(2)}:1, need ${MIN_RATIO}:1`);
}

// 2026-07-31 audit: criterion 7 only ever asked for body/muted/accent text
// against every surface (the cross product above) -- it never named
// --accent-hi/--code-ink/--good/--warning/--warning-ink/--critical, which are
// used as FILLS and BORDERS at least as often as text. The suite used to hold
// all six to the same full cross-product bar anyway (a self-imposed rule, not
// the spec's), and that over-tight bar is why the light palette shipped
// --warning: #8a5a00 (dark brown) and --good: #146b3f instead of anything in
// the board's amber/green family -- the actual, narrower requirement is that
// each one clears 4.5:1 everywhere it is genuinely rendered AS TEXT. TEXT_SITES
// below is that real list, found by grepping src/styles.mjs for
// `color: var(--<token>)` (not guessed): every [token, surface] pair is one
// actual CSS rule and the actual background behind it (an ambient `.block`/
// `.round-history .block`, or the rule's own explicit alpha background,
// resolved the same way SURFACES' alpha entries are, above).
const TEXT_SITES = [
  // `a:hover` is unscoped -- every surface prose/links can render on: an
  // ordinary block, a compare-side/question-context panel, a blockquote, and
  // a sent round's history rail.
  ['--accent-hi', '--panel'],
  ['--accent-hi', '--panel-2'],
  ['--accent-hi', '--accent-soft'],
  ['--accent-hi', '--history-bg'],
  // `.md-content code` (its own --panel-3 background) and `.code-block pre
  // code` (background: none, inheriting `.code-block pre`'s own --panel-2).
  ['--code-ink', '--panel-3'],
  ['--code-ink', '--panel-2'],
  // `.answer-status[data-status="answered"]` -- an answer stays visible (and
  // its status color with it) in a sent round's history rail, not just live.
  ['--good', '--panel'],
  ['--good', '--history-bg'],
  // `.unsupported-widget` (a compare side with no content: always its own
  // --panel-2, compare-side's own explicit background).
  ['--warning', '--panel-2'],
  // `.answer-status[data-status="deferred"]`, `.mermaid-block .missing`.
  ['--warning', '--panel'],
  ['--warning', '--history-bg'],
  // `.btn-defer.active`, `.rounds-left-badge` -- both are text
  // directly on their own --warning-soft background.
  ['--warning', '--warning-soft'],
  // `.readonly-banner` -- text directly on its own --warning-soft background.
  ['--warning-ink', '--warning-soft'],
  // `.resolve-error` -- text directly on its own --critical-soft background.
  ['--critical', '--critical-soft'],
  // `.comment-item .comment-lost` -- comment-item's own --panel-2 background.
  ['--critical', '--panel-2'],
];

for (const [themeName, palette] of Object.entries(palettes)) {
  // Deliberately the full cross product, not a hand-maintained list of which text
  // sits on which surface (criterion 7 only requires the latter): the cross
  // product is mechanical and can't rot as rules move a text token onto a surface
  // it wasn't originally styled for. Both palettes are expected to pass it.
  check(`${themeName}: body/muted/accent text clears ${MIN_RATIO}:1 against every surface token`, () => {
    for (const text of BODY_TEXT_TOKENS) for (const surface of SURFACES) assertClears(themeName, palette, text, surface);
  });

  check(`${themeName}: accent-hi, code-ink, good, warning, warning-ink, critical clear ${MIN_RATIO}:1 everywhere they are actually rendered as text`, () => {
    for (const [text, surface] of TEXT_SITES) assertClears(themeName, palette, text, surface);
  });

  // A real text-on-fill pair: the checkbox tick and .choice-multi.selected
  // .opt-check are --accent-ink drawn on an --accent-filled background.
  check(`${themeName}: --accent-ink clears ${MIN_RATIO}:1 on --accent`, () => {
    assertClears(themeName, palette, '--accent-ink', '--accent');
  });
}

check('dark and light palettes declare exactly the same key set', () => {
  const darkKeys = Object.keys(palettes.dark).sort();
  const lightKeys = Object.keys(palettes.light).sort();
  assert.deepEqual(lightKeys, darkKeys,
    `key sets differ -- dark only: [${darkKeys.filter(k => !lightKeys.includes(k))}], ` +
    `light only: [${lightKeys.filter(k => !darkKeys.includes(k))}]`);
});

check('every palette token is referenced somewhere in the stylesheet, or by another token', () => {
  // A token declared in one theme and forgotten to be wired up anywhere is the
  // single most likely way this feature rots -- this is a mechanical trip-wire
  // for that, not a claim about which rule uses which token.
  const varRefs = new Set();
  for (const m of styles.matchAll(/var\((--[\w-]+)/g)) varRefs.add(m[1]);
  for (const palette of Object.values(palettes)) {
    for (const value of Object.values(palette)) {
      for (const m of String(value).matchAll(/var\((--[\w-]+)/g)) varRefs.add(m[1]);
    }
  }
  // The tab mark (src/styles.mjs, beside MARK_SHAPES/REST_SHAPES) draws
  // straight from the DARK object in JS -- a favicon gets no CSS, so it can
  // carry no var() -- so a token read as DARK['--x'] there looks orphaned to
  // the scan above even though it is wired up, just not through CSS. Scanning
  // styles.mjs's own source text for that bracket-read shape closes the gap
  // without loosening the check: a key nothing reads either way still shows up
  // as an orphan below, same as before this scan existed.
  for (const m of STYLES_SOURCE.matchAll(/\b(?:DARK|LIGHT)\[(['"])(--[\w-]+)\1\]/g)) varRefs.add(m[2]);
  const orphans = Object.keys(palettes.dark).filter(k => !varRefs.has(k));
  assert.deepEqual(orphans, [], `declared in the palette but never referenced anywhere: ${orphans.join(', ')}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall contrast checks ok');
