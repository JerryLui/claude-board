// "An artifact that sets no colours of its own matches the board it is
// posted to, in both light and dark." A colour-less artifact, posted to the
// board, genuinely ends up carrying the board's own resolved theme -- proved
// through the REAL applyTheme function (src/render.mjs's stageAgentScript,
// run for real inside a srcdoc via test/dom-stand-in.mjs's IframeElement),
// driven by the REAL client script (src/ui.mjs's broadcastStageMode/
// handleStageReady) and the REAL boot script (src/theme.mjs's
// themeBootScript) -- never a hand-summary of what any of them do
// (src/render.mjs's applyTheme sets `data-theme`/`color-scheme` on the
// stage's own `<html>`).
//
// The board never rewrites artifact bytes, so an artifact that hardcodes a
// colour instead of theming off `data-theme` overrides what it was handed;
// nothing in src/ checks for that, and nothing here does either.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { check, finish, pageHarness } from './support.mjs';

// Every load below passes test/support.mjs's `loadBoard` both `theme` and
// `finish`: the head boot script runs first (it owns THEME_CHANGE_EVENT's
// dispatch), then ui's own deferred module script (whose listener
// re-broadcasts theme to every wired stage on that event), then
// `finishParsing()` wires the theme control's click listener -- every check
// below that clicks it depends on this having run.
const { loadBoard, clickThemeToggle } = await pageHarness();

// =================================================================================
// A colour-less artifact inherits the board's resolved theme, in both light
// and dark, through the real applyTheme path.
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

check('a colour-less artifact matches the board from the moment its stage announces ready -- dark, this stand-in\'s system default, before any click -- then follows it to Light and back to Dark through the real broadcastStageMode path', () => {
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)), { theme: true, finish: true });
  const frame = document.querySelector('.html-stage');
  assert.ok(frame, 'setup failure: no .html-stage rendered');
  frame.loadSrcdoc(); // fires 'ready' for real -> handleStageReady -> postToStage(..., theme: activeTheme())
  const stageRoot = frame.contentDocument.documentElement;

  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the board itself must start in System (no explicit override)');
  assert.equal(stageRoot.getAttribute('data-theme'), 'dark',
    'at ready, before any click, the stage must already carry the board\'s resolved System theme (dark, this stand-in\'s system default)');
  assert.equal(stageRoot.style.colorScheme, 'dark',
    'color-scheme must be set beside data-theme, or an artifact\'s own UA-default chrome (scrollbars, form controls) stays undecided');

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
  const document = loadBoard(renderBoardPage(boardWithArtifact(COLOURLESS_ARTIFACT_HTML)), { theme: true, finish: true });
  clickThemeToggle(document); // System -> Light, before the stage has said anything at all
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc(); // 'ready' arrives only now
  assert.equal(frame.contentDocument.documentElement.getAttribute('data-theme'), 'light',
    'a stage that announces itself after the board already changed theme must be told the CURRENT theme, not whatever the board started as');
});

finish('artifact-theme');
