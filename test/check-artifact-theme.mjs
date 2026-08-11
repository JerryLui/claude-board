// "An artifact that sets no colours of its own matches the board it is
// posted to, in both light and dark." Two independent halves:
//
//   1. MECHANISM (section 1 below): a colour-less artifact, posted to the
//      board, genuinely ends up carrying the board's own resolved theme --
//      proved through the REAL applyTheme function (src/render.mjs's
//      stageAgentScript, run for real inside a srcdoc via
//      test/dom-stand-in.mjs's IframeElement), driven by the REAL client
//      script (src/ui.mjs's broadcastStageMode/handleStageReady) and the REAL
//      boot script (src/theme.mjs's themeBootScript) -- never a hand-summary
//      of what any of them do. This is the half that already worked before
//      this file existed (src/ui.mjs:998 posts `theme: activeTheme()`,
//      src/render.mjs's applyTheme sets `data-theme`/`color-scheme` on the
//      stage's own `<html>`) -- nothing in src/ changes for it; this is the
//      check that was missing.
//
//   2. DETECTOR (section 2 below): the board can go no further than handing
//      an artifact its resolved theme -- it never rewrites artifact bytes
//      (see the owning spec's Decisions), so an artifact that hardcodes a
//      colour instead of theming off `data-theme` overrides what it was
//      handed and there is no runtime fix for that. What IS checkable is
//      catching such an artifact at check time: findHardcodedColours below
//      scans an artifact's own markup for a colour declared with no
//      `[data-theme="..."]` conditioning at all, demonstrated against a
//      fixture that hardcodes (must be caught) and one that theme-conditions
//      correctly (must not be, even carrying the exact same literal values).
//
// Deliberately fixture-only, not a scan of examples/sample-board.mjs's own
// html blocks: those are legitimate rendered mockups (a kitchen-display
// screen, a ticket redesign) whose whole point is to look like a real
// product with its own fixed branding, not to blend into the reviewer's
// theme -- flagging them would be noise about content this ticket's
// acceptance criterion never covers ("an artifact that sets no colours of
// its own"), not a caught defect.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

// =================================================================================
// 1. MECHANISM: a colour-less artifact inherits the board's resolved theme,
//    in both light and dark, through the real applyTheme path.
// =================================================================================

// Genuinely sets no colour of its own: markup and layout only. Nothing here
// paints a pixel, which is exactly the class of artifact the acceptance
// criterion is about.
const COLOURLESS_ARTIFACT_HTML = '<div class="note"><h1>Status</h1><p>All green.</p></div>';

/** Same shape as test/check-mermaid-theme.mjs's own `loadBoard`: the head
 * boot script first (it owns THEME_CHANGE_EVENT's dispatch), then ui's own
 * deferred module script (whose listener re-broadcasts theme to every wired
 * stage on that event), then `finishParsing()` to actually wire the theme
 * control's click listener -- every check below that clicks it depends on
 * this having run. 'EventSource' is declared and never passed on both calls,
 * same reason as every other check in this suite (QUIRKS.md: "A `new
 * Function` harness inherits the host's globals"). */
function loadBoard(html) {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location, undefined);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location, undefined);
  document.finishParsing();
  return document;
}

function clickThemeToggle(document) {
  const btn = document.getElementById('theme-toggle');
  assert.ok(btn, 'setup failure: no #theme-toggle rendered');
  btn.dispatchEvent(new StandInEvent('click'));
}

/** An ORDINARY board -- one html block plus a trailing markdown block, same
 * convention test/check-stage-isolation.mjs already uses -- rather than a
 * page board (one html block alone, ADR.md entry 33): the mechanism this
 * file proves lives entirely in how a stage is themed, which is identical
 * either way, and a page board's own fullpage layout has nothing to do with
 * it. */
function boardWithArtifact(html) {
  return createBoard({
    title: 'artifact theme',
    blocks: [{ kind: 'html', html }, { kind: 'markdown', text: 'not a page board' }],
  });
}

check('a colour-less artifact matches the board the moment its stage announces ready -- dark, this stand-in\'s system default, before any click', () => {
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)));
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered');
  frame.loadSrcdoc(); // fires 'ready' for real -> handleStageReady -> postToStage(..., theme: activeTheme())

  const stageRoot = frame.contentDocument.documentElement;
  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the board itself must start in System (no explicit override)');
  assert.equal(stageRoot.getAttribute('data-theme'), 'dark',
    'setup failure: the board must resolve System to dark (this stand-in\'s system default) before any click');
  assert.equal(stageRoot.style.colorScheme, 'dark',
    'color-scheme must be set beside data-theme, or an artifact\'s own UA-default chrome (scrollbars, form controls) stays undecided');
});

check('a colour-less artifact follows the board to Light, then back to Dark, through the real broadcastStageMode path -- the acceptance criterion, proved end to end', () => {
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)));
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const stageRoot = frame.contentDocument.documentElement;

  clickThemeToggle(document); // System -> Light
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have set the board to Light');
  assert.equal(stageRoot.getAttribute('data-theme'), 'light', 'a colour-less artifact must match the board it is posted to, in Light');
  assert.equal(stageRoot.style.colorScheme, 'light');

  clickThemeToggle(document); // Light -> Dark
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'setup failure: the click must have set the board to Dark');
  assert.equal(stageRoot.getAttribute('data-theme'), 'dark', 'a colour-less artifact must match the board it is posted to, in Dark');
  assert.equal(stageRoot.style.colorScheme, 'dark');
});

check('a colour-less artifact whose stage announces ready AFTER the board is already Light hears the CURRENT theme, not a stale default', () => {
  // The other order handleStageReady exists for: a round pushed in later, or
  // an amend's fresh iframe, arriving after the reviewer already chose a
  // theme -- not just "announced before any click" (the check above).
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)));
  clickThemeToggle(document); // System -> Light, before the stage has said anything at all
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc(); // 'ready' arrives only now
  assert.equal(frame.contentDocument.documentElement.getAttribute('data-theme'), 'light',
    'a stage that announces itself after the board already changed theme must be told the CURRENT theme, not whatever the board started as');
});

// =================================================================================
// 2. DETECTOR: an artifact that hardcodes a colour -- declares it with no
//    `[data-theme="..."]` conditioning at all -- is caught. The escape hatch
//    is theming off the attribute the board actually hands the artifact
//    (`data-theme`), not any particular colour value: the same literal hex
//    passes when conditioned and fails when it isn't.
// =================================================================================

const COLOR_PROPS = /^(color|background|background-color|border(-[a-z]+)?-color|border|outline(-color)?|fill|stroke|box-shadow|text-shadow)$/;

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

/** Splits `css` into its top-level `{ header, body }` blocks -- an ordinary
 * rule (`selector { decls }`) or an at-rule (`@media (...) { ... }`) alike --
 * by brace depth alone. Not a CSS parser: no selector grammar, no value
 * grammar, just enough structure to tell "this declaration's rule carries
 * `[data-theme=...]` in its own selector" from "it does not", which is all
 * the detector below needs. */
function topLevelBlocks(css) {
  const blocks = [];
  let depth = 0, headerStart = 0, bodyStart = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        blocks.push({ header: css.slice(headerStart, bodyStart - 1).trim(), body: css.slice(bodyStart, i) });
        headerStart = i + 1;
      }
    }
  }
  return blocks;
}

/** A declared value that paints nothing of its own: no literal colour to
 * clash with the board either way. `var(--...)` is the one other CSS-native
 * escape hatch, same convention the board's own stylesheet uses for every
 * themed token (src/styles.mjs) -- an artifact that names a custom property
 * is deferring the actual colour to whatever defines it, not hardcoding one,
 * even though nothing in this sandboxed srcdoc ever defines `--anything` for
 * it (QUIRKS.md "Two stylesheets, one palette": the page's tokens never
 * reach the stage) -- that gap is the artifact author's problem to solve
 * with its OWN `:root` custom properties, not a hardcoded colour this
 * detector needs to catch. */
function isBenignValue(value) {
  return /^(inherit|initial|unset|revert|transparent|currentcolor|none)$/i.test(value) || /var\(--/.test(value);
}

function collectDeclarations(css, out) {
  for (const block of topLevelBlocks(css)) {
    if (/^@/.test(block.header)) {
      // An at-rule -- @media, @supports, @keyframes, ... -- carries no
      // selector of its own to scope against. In particular, `@media
      // (prefers-color-scheme: ...)` reflects the OS, not the explicit
      // override activeTheme() actually resolves and hands the stage (see
      // that function's own comment in src/ui.mjs) -- an artifact guessing
      // at the OS preference independently is a second, disagreeing source
      // of truth, not "theming off the attribute the board hands it", so it
      // earns no exemption here. Whatever is nested inside still has to
      // earn its own [data-theme] scoping on its own selector.
      collectDeclarations(block.body, out);
      continue;
    }
    if (/\[data-theme\s*=/.test(block.header)) continue; // scoped: the escape hatch
    for (const m of block.body.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) {
      const prop = m[1].trim().toLowerCase();
      if (!COLOR_PROPS.test(prop)) continue;
      const value = m[2].trim();
      if (isBenignValue(value)) continue;
      out.push({ selector: block.header, property: prop, value });
    }
  }
}

/** Every colour declaration in `html` (an artifact's own markup, the same
 * string a board's `html` block carries as `block.html`) that is not
 * conditioned on `[data-theme="..."]` anywhere in its own selector chain, and
 * is not `var(--...)` or one of the values that paints nothing. Scans both
 * `<style>` blocks and inline `style="..."` attributes -- an inline
 * declaration can never be conditioned by any selector at all (inline style
 * always wins the cascade outright), so any colour it sets is caught
 * unconditionally, with no `[data-theme]` escape hatch to check for. */
function findHardcodedColours(html) {
  const out = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) collectDeclarations(stripComments(m[1]), out);
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    for (const d of m[1].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) {
      const prop = d[1].trim().toLowerCase();
      if (!COLOR_PROPS.test(prop)) continue;
      const value = d[2].trim();
      if (isBenignValue(value)) continue;
      out.push({ selector: '(inline style)', property: prop, value });
    }
  }
  return out;
}

const HARDCODED_ARTIFACT_HTML = `<style>
  body { margin: 0; background: #111827; color: #f9fafb; }
  .card { background: #1f2937; border: 1px solid #374151; }
</style>
<div class="card"><p>All green.</p></div>`;

check('a hardcoding artifact -- a literal colour with no [data-theme] conditioning at all -- is caught', () => {
  const findings = findHardcodedColours(HARDCODED_ARTIFACT_HTML);
  assert.ok(findings.length >= 4, `expected every unconditioned colour declaration to be caught, got ${JSON.stringify(findings)}`);
  assert.ok(findings.some(f => f.property === 'background' && f.value.includes('#111827')),
    `expected the body's own hardcoded background among the findings, got ${JSON.stringify(findings)}`);
  assert.ok(findings.some(f => f.property === 'border' && f.value.includes('#374151')),
    `a colour hiding inside a shorthand property (border) must be caught too, got ${JSON.stringify(findings)}`);
});

check('the SAME colour-less fixture the mechanism half proves against is never flagged -- no colour, nothing to catch', () => {
  assert.deepEqual(findHardcodedColours(COLOURLESS_ARTIFACT_HTML), []);
});

const THEME_AWARE_ARTIFACT_HTML = `<style>
  body { margin: 0; }
  [data-theme="dark"] body { background: #111827; color: #f9fafb; }
  [data-theme="light"] body { background: #ffffff; color: #111827; }
</style>
<div class="card"><p>All green.</p></div>`;

check('an artifact theming off [data-theme] -- the attribute the board actually hands it -- is not flagged, even carrying the exact same literal colours the hardcoding fixture above does', () => {
  const findings = findHardcodedColours(THEME_AWARE_ARTIFACT_HTML);
  assert.deepEqual(findings, [], `theme-conditioned colours must never be flagged, got ${JSON.stringify(findings)}`);
});

check('a var(--...) reference is treated as themed, not hardcoded -- the one other CSS-native escape hatch, same convention the board\'s own stylesheet uses for every token', () => {
  assert.deepEqual(findHardcodedColours('<style>body{background:var(--stage-bg)}</style><p>hi</p>'), []);
});

check('an inline style="" attribute can never be conditioned by any selector, so any colour it sets is caught unconditionally', () => {
  const findings = findHardcodedColours('<div style="background:#111827;color:#fff">hardcoded via inline style</div>');
  assert.equal(findings.length, 2, `expected both the inline background and color to be caught, got ${JSON.stringify(findings)}`);
  assert.ok(findings.every(f => f.selector === '(inline style)'));
});

check('a @media (prefers-color-scheme) condition alone does not excuse a colour -- it tracks the OS, not the explicit override activeTheme() actually resolves, so it earns no exemption here', () => {
  const findings = findHardcodedColours('<style>@media (prefers-color-scheme: dark) { body { background: #111827; } }</style><p>hi</p>');
  assert.ok(findings.length > 0, `a prefers-color-scheme-gated colour must still be caught -- it does not track data-theme, got ${JSON.stringify(findings)}`);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall artifact-theme checks ok');
