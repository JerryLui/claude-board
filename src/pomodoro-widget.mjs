// The pomodoro widget's server-rendered markup: a header control beside
// themeToggle() (src/theme.mjs is the model -- see that file's own header
// comment for the split this follows). All the actual countdown / pause /
// resume / reset / settings BEHAVIOUR lives in src/indexpage.mjs's
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

/** IDs, not classes, are what indexScript's client code looks elements up by
 * (`document.getElementById`) -- exactly like `#theme-toggle` in
 * src/theme.mjs. Classes below exist only for styling. */
export function pomodoroWidget() {
  return `<div class="pomodoro-widget" id="pomodoro-widget">
  <span class="pomodoro-status" id="pomodoro-status">Pomodoro: …</span>
  <button type="button" class="mode-toggle" id="pomodoro-toggle" hidden></button>
  <details class="pomodoro-settings" id="pomodoro-settings">
    <summary class="pomodoro-settings-summary">Pomodoro settings</summary>
    <form class="pomodoro-settings-form" id="pomodoro-settings-form">
      <label class="pomodoro-field">Work (min)<input type="number" name="workMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Break (min)<input type="number" name="breakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break (min)<input type="number" name="longBreakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break every<input type="number" name="longEvery" min="1" max="100" step="1"></label>
      <label class="pomodoro-field pomodoro-field-check">Notify<input type="checkbox" name="notify"></label>
      <label class="pomodoro-field pomodoro-field-check">Sound<input type="checkbox" name="sound"></label>
      <div class="pomodoro-settings-actions">
        <button type="submit" class="pomodoro-btn">Save</button>
        <!-- Reset ends the whole loop (src/pomodoro.mjs resetTimer), not just the
             running interval, so it must not sit one click away from Pause/Resume
             the way a plain button would. A confirm() dialog was rejected on
             purpose -- it is a blocking modal, and no client script in this repo
             ever opens one; the diagram lens and every other confirmation here is
             inline chrome instead. This is a two-step BUTTON, not a dialog: one
             click arms it (indexScript relabels it "Really reset?" and reverts
             after a few seconds), a second click within that window is what
             actually posts /api/pomodoro/reset. Housed inside the settings panel,
             not beside Pause, as the spec's own placement decision. -->
        <button type="button" class="pomodoro-btn pomodoro-reset-btn" id="pomodoro-reset">Reset</button>
      </div>
    </form>
  </details>
</div>`;
}
