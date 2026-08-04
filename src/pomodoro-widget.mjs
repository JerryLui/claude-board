// The pomodoro widget's server-rendered markup: a header control beside
// themeToggle() (src/theme.mjs is the model -- see that file's own header
// comment for the split this follows). All the actual countdown / start / pause
// / resume / reset / settings BEHAVIOUR lives in src/indexpage.mjs's
// `indexScript`, not here -- this file only emits the static shape that
// script wires up, the same split theme.mjs draws between `themeToggle()`
// (markup) and `themeBootScript` (behaviour). Ticket 04 (SPEC_POMODORO.md).
//
// No countdown text is ever rendered server-side: `GET /` (src/server.mjs)
// never reads pomodoro.json -- ADR.md entry 8 ("the daemon owns the pomodoro
// clock") says who owns the clock, not that every route has to consult it --
// so every reader's first paint shows this calm, static placeholder and
// indexScript's own first fetch (run synchronously as the script loads, before
// its poll/tick timers) fills in the real state within one round trip. A
// timer-shaped flash-of-wrong-content is not a concern here the way
// dark-then-light is for theme (QUIRKS.md): unlike colour, a blank countdown
// is not wrong, just not yet known.
//
// test/check-pure.mjs's own class file allowlist (`emitters` in "every class
// the stylesheet rules on is a class something actually emits") includes this
// file alongside src/render.mjs/ui.mjs/indexpage.mjs/markdown.mjs/theme.mjs --
// every class name below has to stay on that list or the check goes red.

// Stroke-based inline glyph, same family as src/theme.mjs's three theme icons
// and src/render.mjs's COMMENT_ICON/MODE_ICON. No external assets, ever
// (QUIRKS.md).
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>';

/** IDs, not classes, are what indexScript's client code looks elements up by
 * (`document.getElementById`) -- exactly like `#theme-toggle` in
 * src/theme.mjs. Classes below exist only for styling.
 *
 * The one control is a SWITCH, not the old Pause/Resume button, and it is never
 * hidden: idle turns it on (POST /api/pomodoro/ensure), running turns it off
 * (pause), paused turns it back on (resume). Its predecessor tried to disappear
 * itself with the `hidden` PROPERTY while wearing `.mode-toggle`, whose
 * `display: inline-flex` is an author rule and therefore beats the UA
 * stylesheet's `[hidden] { display: none }` outright -- so it never actually
 * hid, and rendered as an empty pill that could not do anything, there being no
 * timer for it to pause. Nothing here relies on `hidden` any more.
 *
 * `role="switch"` + `aria-checked`, not a bare button: the control has an on/off
 * state a screen reader has to be able to read, and the knob's position is the
 * only thing that conveys it visually. indexScript owns both `aria-checked` and
 * `aria-label` (the label names the ACTION a click performs -- Start / Pause /
 * Resume -- which is what makes an icon-only control usable, priority 1 in the
 * ui-ux-pro-max accessibility rules). The server-rendered values below state the
 * honest pre-fetch truth: nothing known yet, so off. */
export function pomodoroWidget() {
  return `<div class="pomodoro-widget" id="pomodoro-widget">
  <span class="pomodoro-status" id="pomodoro-status">Pomodoro: …</span>
  <button type="button" class="pomodoro-switch" id="pomodoro-toggle" role="switch" aria-checked="false" aria-label="Start pomodoro" title="Start pomodoro"><span class="pomodoro-switch-knob" aria-hidden="true"></span></button>
  <details class="pomodoro-settings" id="pomodoro-settings">
    <summary class="pomodoro-settings-summary" role="button" aria-label="Pomodoro settings" title="Pomodoro settings">${GEAR_ICON}</summary>
    <form class="pomodoro-settings-form" id="pomodoro-settings-form">
      <label class="pomodoro-field">Work (min)<input type="number" name="workMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Break (min)<input type="number" name="breakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break (min)<input type="number" name="longBreakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break every<input type="number" name="longEvery" min="1" max="100" step="1"></label>
      <label class="pomodoro-field pomodoro-field-check">Notify<input type="checkbox" name="notify"></label>
      <label class="pomodoro-field pomodoro-field-check">Sound<input type="checkbox" name="sound"></label>
      <div class="pomodoro-settings-actions">
        <button type="submit" class="pomodoro-btn pomodoro-btn-primary">Save</button>
        <!-- Reset ends the whole loop (src/pomodoro.mjs resetTimer), not just the
             running interval, so it must not sit one click away from the switch
             the way a plain button would. A confirm() dialog was rejected on
             purpose -- it is a blocking modal, and no client script in this repo
             ever opens one; the diagram lens and every other confirmation here is
             inline chrome instead. This is a two-step BUTTON, not a dialog: one
             click arms it (indexScript relabels it "Really reset?" and reverts
             after a few seconds), a second click within that window is what
             actually posts /api/pomodoro/reset. Housed inside the settings panel,
             not beside the switch, as the spec's own placement decision. -->
        <button type="button" class="pomodoro-btn pomodoro-reset-btn" id="pomodoro-reset">Reset</button>
      </div>
    </form>
  </details>
</div>`;
}
