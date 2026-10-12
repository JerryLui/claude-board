// What a stage's own document is told about the board's theme, and what it is
// not. The board tells every wired stage its resolved theme as `data-theme` on
// the stage's own `<html>`, so a template that conditions its colours on that
// attribute follows the board through Light, Dark and System. The attribute is
// all it is told: the stage's `color-scheme` is never set, and the frame it
// renders in resolves `color-scheme: light` in both themes, because the artboard
// behind it is a light neutral in both. So an artifact that sets no colour of
// its own draws the browser's light-scheme defaults (black text, the dark link
// blue, light form controls) on that artboard whatever the board's theme.
//
// Proved through the REAL applyTheme function (src/render.mjs's
// stageAgentScript, run for real inside a srcdoc via test/dom-stand-in.mjs's
// IframeElement), driven by the REAL client script (src/ui.mjs's
// broadcastStageMode/handleStageReady) and the REAL boot script
// (src/theme.mjs's themeBootScript), and the REAL stylesheet through the
// stand-in's cascade resolver. What Chrome then paints is a fact about pixels,
// which test/browser-check-stage-fold.mjs's default-ink rows read.
//
// The board never rewrites artifact bytes, so an artifact that hardcodes a
// colour instead of theming off `data-theme` overrides what it was handed;
// nothing in src/ checks for that, and nothing here does either.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { styles } from '../src/styles.mjs';
import { StandInEvent, resolveComputedProperty } from './dom-stand-in.mjs';
import { check, finish, inlineColorScheme, pageHarness } from './support.mjs';

// Every load below passes test/support.mjs's `loadBoard` both `theme` and
// `finish`: the head boot script runs first (it owns THEME_CHANGE_EVENT's
// dispatch), then ui's own deferred module script (whose listener
// re-broadcasts theme to every wired stage on that event), then
// `finishParsing()` wires the theme control's click listener -- every check
// below that clicks it depends on this having run.
const { loadBoard, clickThemeToggle } = await pageHarness();

// =================================================================================
// A stage's document is told the board's resolved theme, in both light and
// dark, through the real applyTheme path, and its colour scheme stays its own.
// =================================================================================

// Genuinely sets no colour of its own: markup and layout only. Nothing here
// paints a pixel, which is exactly the class of artifact the acceptance
// criterion is about.
const COLOURLESS_ARTIFACT_HTML = '<div class="note"><h1>Status</h1><p>All green.</p></div>';

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

check('a stage\'s document is told the board\'s theme as data-theme from the moment it announces ready -- dark, this stand-in\'s system default, before any click -- then follows it to Light and back to Dark through the real broadcastStageMode path, and its color-scheme is never set', () => {
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)), { theme: true, finish: true });
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered');
  frame.loadSrcdoc(); // fires 'ready' for real -> handleStageReady -> postToStage(..., theme: activeTheme())
  const stageRoot = frame.contentDocument.documentElement;

  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the board itself must start in System (no explicit override)');
  assert.equal(stageRoot.getAttribute('data-theme'), 'dark',
    'at ready, before any click, the stage must already carry the board\'s resolved System theme (dark, this stand-in\'s system default)');
  // Read by every way script can set it (test/support.mjs's inlineColorScheme):
  // the stand-in keeps a property write, a setProperty call and a style
  // attribute apart, so one read alone passes a stamp made through another.
  assert.deepEqual(inlineColorScheme(stageRoot), [],
    'color-scheme is not the board\'s to set on a stage: stamped dark, an artifact that sets no colour draws the UA\'s white ink on the light artboard');

  clickThemeToggle(document); // System -> Light
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the click must have set the board to Light');
  assert.equal(stageRoot.getAttribute('data-theme'), 'light', 'a stage must be told the board\'s theme, in Light');
  assert.deepEqual(inlineColorScheme(stageRoot), [], 'nor is it set on the way to Light');

  clickThemeToggle(document); // Light -> Dark
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'setup failure: the click must have set the board to Dark');
  assert.equal(stageRoot.getAttribute('data-theme'), 'dark', 'a stage must be told the board\'s theme, in Dark');
  assert.deepEqual(inlineColorScheme(stageRoot), [], 'nor under the explicit Dark setting');
});

check('a colour-less artifact whose stage announces ready AFTER the board is already Light hears the CURRENT theme, not a stale default', () => {
  // The other order handleStageReady exists for: a round pushed in later, or
  // an amend's fresh iframe, arriving after the reviewer already chose a
  // theme -- not just "announced before any click" (the check above).
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)), { theme: true, finish: true });
  clickThemeToggle(document); // System -> Light, before the stage has said anything at all
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc(); // 'ready' arrives only now
  assert.equal(frame.contentDocument.documentElement.getAttribute('data-theme'), 'light',
    'a stage that announces itself after the board already changed theme must be told the CURRENT theme, not whatever the board started as');
});

check('the frame a stage renders in resolves color-scheme: light whatever the board\'s setting and whatever the OS prefers -- an ordinary stage, a page board\'s stage and the Lens\'s frame', () => {
  // The artboard behind a stage is a light neutral in both palettes, and the
  // frame's scheme is what decides the default ink of a document that sets
  // none. Measured in real Chrome (test/browser-check-stage-fold.mjs): a frame
  // left on the dark page's scheme draws its light document on an opaque white
  // canvas in place of the artboard.
  const ordinary = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)), { theme: true, finish: true });
  ordinary.querySelector('.html-block .pull-out').dispatchEvent(new StandInEvent('click'));
  const page = loadBoard(renderBoardPage(createBoard({
    title: 'artifact theme, page board',
    blocks: [{ kind: 'html', html: COLOURLESS_ARTIFACT_HTML }],
  })), { theme: true, finish: true });
  const frames = [
    ['an ordinary stage', ordinary, ordinary.querySelector('.html-stage')],
    ['the Lens\'s frame', ordinary, ordinary.querySelector('.stage-lens-frame')],
    ['a page board\'s stage', page, page.querySelector('.html-stage')],
  ];
  for (const [what, document, frame] of frames) {
    assert.ok(frame, `setup failure: no frame for ${what}`);
    for (const setting of [null, 'light', 'dark']) {
      if (setting) document.documentElement.setAttribute('data-theme', setting);
      else document.documentElement.removeAttribute('data-theme');
      for (const osPrefersDark of [true, false]) {
        assert.equal(resolveComputedProperty(styles, frame, osPrefersDark, 'color-scheme'), 'light',
          `${what} must declare the light scheme with the board set to ${setting || 'System'} on a ${osPrefersDark ? 'dark' : 'light'} OS`);
      }
    }
  }
});

finish('artifact-theme');
