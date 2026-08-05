// The pomodoro widget's server-rendered markup: a header control beside
// themeToggle() (src/theme.mjs is the model -- see that file's own header
// comment for the split this follows). All the actual countdown / start / pause
// / resume / reset / settings BEHAVIOUR lives in src/indexpage.mjs's
// `indexScript`, not here -- this file only emits the static shape that
// script wires up, the same split theme.mjs draws between `themeToggle()`
// (markup) and `themeBootScript` (behaviour). Ticket 04 (SPEC_POMODORO.md).
//
// The three cue pickers (SPEC_CUES.md) follow the same split: the OPTION LIST
// is static per machine (whatever src/cues.mjs's cueNames() reads off this
// machine's /System/Library/Sounds, memoised there), so it belongs here,
// server-rendered once per request -- but the SELECTED value is daemon state,
// so it is never set in this markup at all, exactly like every other settings
// field below. indexpage.mjs's pomodoroSyncForm fills it in on first fetch.
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

import { cueNames } from './cues.mjs';

// Stroke-based inline glyph, same family as src/theme.mjs's three theme icons
// and src/render.mjs's COMMENT_ICON/MODE_ICON. No external assets, ever
// (QUIRKS.md).
// The widget's name, drawn rather than written: the word "Pomodoro" used to
// prefix the status text, which cost header width on every reader's screen to
// repeat something the icon says once. `role="img"` + `<title>` is what keeps
// the name available to a screen reader now that no visible text carries it --
// the status span itself only ever says the phase and the clock.
const TOMATO_ICON = '<svg class="pomodoro-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pomodoro"><title>Pomodoro</title><circle cx="12" cy="14.6" r="6.8"/><path d="M12 7.8V4.6"/><path d="M12 7.8 8.2 5.9M12 7.8l3.8-1.9"/></svg>';

const GEAR_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>';

/** The option list every one of the three cue `<select>`s shares -- built fresh
 * per render (never at module load: cueNames() is call-time-lazy on purpose,
 * see src/cues.mjs's own header comment) but cheap either way, since cueNames()
 * memoises the directory read on its own first call. No `selected` attribute
 * on any option: the selected VALUE is daemon state and is never known here
 * (see this file's header comment). Every name cueNames() returns has already
 * passed its SAFE_NAME filter, so plain interpolation into both the attribute
 * and the text node is safe -- none of `< > & "` can survive that filter. */
function cueOptionsHtml() {
  return cueNames().map(name => `<option value="${name}">${name}</option>`).join('');
}

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
  const cueOptions = cueOptionsHtml();
  return `<div class="pomodoro-widget" id="pomodoro-widget">
  ${TOMATO_ICON}
  <span class="pomodoro-status" id="pomodoro-status">…</span>
  <button type="button" class="pomodoro-switch" id="pomodoro-toggle" role="switch" aria-checked="false" aria-label="Start pomodoro" title="Start pomodoro"><span class="pomodoro-switch-knob" aria-hidden="true"></span></button>
  <details class="pomodoro-settings" id="pomodoro-settings">
    <summary class="pomodoro-settings-summary" role="button" aria-label="Pomodoro settings" title="Pomodoro settings">${GEAR_ICON}</summary>
    <form class="pomodoro-settings-form" id="pomodoro-settings-form">
      <label class="pomodoro-field">Work (min)<input type="number" name="workMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Short break (min)<input type="number" name="breakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break (min)<input type="number" name="longBreakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break every<input type="number" name="longEvery" min="1" max="100" step="1"></label>
      <label class="pomodoro-field pomodoro-field-check">Notify<input type="checkbox" name="notify"></label>
      <!-- The 'sound' checkbox is gone (SPEC_CUES.md: retired, not kept as a
           master mute) -- Cues below is its replacement, three independent
           pickers rather than one on/off switch. A hairline + caption, not a
           fold or a tab: everything the panel can do is visible the moment it
           opens (the spec's own placement decision). -->
      <hr class="pomodoro-settings-divider">
      <div class="pomodoro-settings-caption">Cues</div>
      <!-- aria-label on each select, carrying the visible row label plus the word the
           caption above supplies visually. The caption is a plain div: it is announced
           in a screen reader's browse mode but NOT while tabbing control to control,
           and tabbing is how this panel is actually operated -- so without these, a
           reader hears "Work, combo box" straight after "Work (min), spin button" and
           has nothing but the role to tell the cue row from the duration row. Each
           label still CONTAINS its visible text ("Work" inside "Work cue"), which is
           what keeps voice control working: WCAG 2.5.3 label-in-name is about a spoken
           "click Work" still matching. The visible text stays exactly what the spec
           chose -- Work / Short break / Long break -- and is not changed to suit this. -->
      <label class="pomodoro-field">Work<select name="cueWork" aria-label="Work cue">${cueOptions}</select></label>
      <label class="pomodoro-field">Short break<select name="cueBreak" aria-label="Short break cue">${cueOptions}</select></label>
      <label class="pomodoro-field">Long break<select name="cueLongBreak" aria-label="Long break cue">${cueOptions}</select></label>
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
