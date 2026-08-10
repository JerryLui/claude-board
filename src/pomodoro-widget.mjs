// The pomodoro widget's server-rendered markup: a header control beside
// themeToggle() (src/theme.mjs is the model -- see that file's own header
// comment for the split this follows). All the actual countdown / start / pause
// / resume / reset / settings BEHAVIOUR lives in src/indexpage.mjs's
// `indexScript`, not here -- this file only emits the static shape that
// script wires up, the same split theme.mjs draws between `themeToggle()`
// (markup) and `themeBootScript` (behaviour).
//
// The three cue pickers follow the same split: the OPTION LIST
// is machine state, not daemon state (whatever src/cues.mjs's cueNames() reads
// off this machine's sound directories), so it belongs here, server-rendered
// per request -- a reader who drops an .aiff into ~/Library/Sounds gets it in
// the list on the next page load, since ADR.md entry 20 made that the way to
// add a cue and cueNames() caches only briefly for it. The SELECTED value is
// daemon state,
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
// The settings panel behind the cogwheel is no longer the pomodoro's (ADR 71):
// it is the index's GENERAL settings panel, sectioned with the hairline +
// caption device it already had -- Pomodoro, Banners, Cues, Store. Only the
// class and id prefixes still say `pomodoro-`, which is history rather than
// scope; the store control below carries `store-*` ids because nothing about
// it is the pomodoro's.
//
// test/check-pure.mjs's own class file allowlist (`emitters` in "every class
// the stylesheet rules on is a class something actually emits") includes this
// file alongside src/render.mjs/ui.mjs/indexpage.mjs/markdown.mjs/theme.mjs --
// every class name below has to stay on that list or the check goes red.

import { cueNames } from './cues.mjs';

// Stroke-based inline glyph, same family as src/theme.mjs's three theme icons
// and src/render.mjs's COMMENT_ICON. No external assets beyond the two bare
// sibling filenames QUIRKS.md now admits (ADR.md entry 70) -- an icon is not one of them
// (QUIRKS.md).
// The widget's name, drawn rather than written: the word "Pomodoro" used to
// prefix the status text, which cost header width on every reader's screen to
// repeat something the icon says once. `role="img"` + `<title>` is what keeps
// the name available to a screen reader now that no visible text carries it --
// the status span itself only ever says the phase and the clock.
export const TOMATO_ICON = '<svg class="pomodoro-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pomodoro"><title>Pomodoro</title><circle cx="12" cy="14.6" r="6.8"/><path d="M12 7.8V4.6"/><path d="M12 7.8 8.2 5.9M12 7.8l3.8-1.9"/></svg>';

/** The break glyph: the SAME circle as
 * TOMATO_ICON above -- identical cx/cy/r, identical outer <svg> attributes
 * (viewBox, size, stroke, role, aria-label, the "Pomodoro" title) -- so the
 * accessible name never changes and the swap reads as the same glyph turned
 * down, not a different icon. Two differences only: the stem
 * and leaves on top are gone ("a stemless circle"), and two short vertical
 * stems sit inside it where they were -- the pause-glyph family, and the same
 * "two bars, not one" call src/styles.mjs's REST_SHAPES already made for the
 * tab mark (a single rest stroke reads as a rendering failure at this size;
 * two read as deliberate). Exported alongside TOMATO_ICON so indexpage.mjs's
 * indexScript can splice both in as real values (JSON.stringify, the same
 * "real value, not a hand-copy" discipline formatCountdown.toString() already
 * gets there) rather than owning a second copy of either drawing.
 *
 * Colour is NOT baked in here: idle and paused keep this exact glyph but at
 * TOMATO_ICON's own muted weight (spec decision: "idle has nothing to turn up
 * for"), so the amber-vs-muted choice is a CSS class indexScript toggles on
 * whichever glyph is currently mounted (.pomodoro-icon-amber, src/styles.mjs),
 * never a colour attribute drawn into either string. */
export const REST_ICON = '<svg class="pomodoro-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Pomodoro"><title>Pomodoro</title><circle cx="12" cy="14.6" r="6.8"/><path d="M10 11v7.2M14 11v7.2"/></svg>';

const GEAR_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>';

// Restart/forward controls (round 2's
// picked visual variant, the segmented
// pair). Icon-only, so both buttons carry an aria-label AND a title, same
// reasoning as the settings cogwheel above: the label names the ACTION a
// click performs, which is what makes an icon-only control usable
// (accessibility priority 1). Glyphs are stroke-based icons
// picked to read as "restart" and "forward" without a label -- rotate-ccw
// (restart) and skip-forward, a play triangle plus a bar (forward) -- the
// same family as TOMATO_ICON/GEAR_ICON above. Neither icon is itself the
// accessible name; both carry aria-hidden, exactly like GEAR_ICON.
const RESTART_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
const FORWARD_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19"/></svg>';

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
 * accessibility rules). The server-rendered values below state the
 * honest pre-fetch truth: nothing known yet, so off.
 *
 * The Restart/Forward pill sits between the status text and the switch
 * (round two's picked variant), two real `<button>`s so both are
 * keyboard-reachable with no extra tabindex plumbing. Unlike the switch, this
 * pair never changes shape with the timer's state -- "always
 * present", and an idle click is already a server-side no-op
 * (forwardTimer/restartTimer in src/pomodoro.mjs both return `doc` unchanged
 * against `!doc.timer`), so there is no idle-disabled state to render either. */
export function pomodoroWidget() {
  const cueOptions = cueOptionsHtml();
  // The icon sits in its own slot, not bare, so indexScript's renderPomodoro can
  // swap the whole glyph (TOMATO_ICON <-> REST_ICON) by replacing this ONE
  // stable element's innerHTML -- a real markup swap, never the `hidden`
  // property (see this function's own doc comment above, on the same trap).
  // `display: contents` (src/styles.mjs) is what keeps this wrapper invisible
  // to the flex layout -- the icon still lays out as a direct child of
  // .pomodoro-widget, gap and all, exactly as when it had no wrapper.
  return `<div class="pomodoro-widget" id="pomodoro-widget">
  <span class="pomodoro-icon-slot" id="pomodoro-icon-slot">${TOMATO_ICON}</span>
  <span class="pomodoro-status" id="pomodoro-status">…</span>
  <span class="pomodoro-ctl-group">
    <button type="button" class="pomodoro-ctl" id="pomodoro-restart" aria-label="Restart interval" title="Restart interval">${RESTART_ICON}</button>
    <button type="button" class="pomodoro-ctl" id="pomodoro-forward" aria-label="Forward to next interval" title="Forward to next interval">${FORWARD_ICON}</button>
  </span>
  <button type="button" class="pomodoro-switch" id="pomodoro-toggle" role="switch" aria-checked="false" aria-label="Start pomodoro" title="Start pomodoro"><span class="pomodoro-switch-knob" aria-hidden="true"></span></button>
  <details class="pomodoro-settings" id="pomodoro-settings">
    <summary class="pomodoro-settings-summary" role="button" aria-label="Settings" title="Settings">${GEAR_ICON}</summary>
    <form class="pomodoro-settings-form" id="pomodoro-settings-form">
      <div class="pomodoro-settings-caption">Pomodoro</div>
      <label class="pomodoro-field">Work (min)<input type="number" name="workMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Short break (min)<input type="number" name="breakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break (min)<input type="number" name="longBreakMin" min="1" max="1440" step="1"></label>
      <label class="pomodoro-field">Long break every<input type="number" name="longEvery" min="1" max="100" step="1"></label>
      <hr class="pomodoro-settings-divider">
      <div class="pomodoro-settings-caption">Banners</div>
      <label class="pomodoro-field pomodoro-field-check">Notify<input type="checkbox" name="notify"></label>
      <!-- Round banners' own tick, independent of Notify above (ADR.md entry 58;
           CONTEXT.md's Banner) -- Notify gates a pomodoro boundary's banner, this one
           gates a Stranded round's, and unlike the pickers below it fires no test
           banner of its own on the way on: that audition stays Notify's alone
           (src/indexpage.mjs's onPomodoroNotifyChange), so this checkbox's 'change'
           reaches no handler beyond the ordinary sync/submit every other field here
           already gets. It is what earns this section its own caption rather than
           sitting under Pomodoro: it gates a Stranded ROUND's banner, which has nothing
           to do with the clock. -->
      <label class="pomodoro-field pomodoro-field-check">Round banners<input type="checkbox" name="notifyRounds"></label>
      <!-- The 'sound' checkbox is gone (retired, not kept as a
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
        <button type="button" class="pomodoro-btn pomodoro-reset-btn" id="pomodoro-reset" aria-label="Reset the pomodoro timer">Reset</button>
      </div>
      <!-- The store section (ADR 71), LAST and below Save/Reset on purpose: those two
           belong to everything above them (Save writes the settings document, Reset ends
           the pomodoro loop), and neither touches the store. Nothing here is part of the
           settings document either -- the window below is never saved, never synced and
           never defaulted.

           Ids here are store-scoped, not pomodoro-scoped, because this control is not
           the pomodoro's; the surrounding pomodoro- names are the panel's history, kept
           because renaming markup nobody sees buys nothing. What the READER sees is now
           a general settings panel: the cogwheel is named "Settings", and every section
           in it -- Pomodoro, Banners, Cues, Store -- says which it is.

           Inside the same form as the fields above, which has one consequence worth
           naming: Enter in the window field submits the form, i.e. SAVES SETTINGS. It
           cannot prune -- the button below is type="button", so it is unreachable
           without a real click on it -- so the worst outcome is a save the reader did
           not ask for, never a deletion. -->
      <hr class="pomodoro-settings-divider">
      <div class="pomodoro-settings-caption">Store</div>
      <!-- No value, no placeholder number, and nothing ever fills it in: the window has
           no default (ADR 71), so an untouched field means "no window named" and the
           click below refuses. A prefilled 30 would make the one number that decides
           what dies something the reader accepted rather than chose.
           aria-label carrying the caption's word, for the reason the cue pickers above
           carry theirs: the caption is a plain div, read in browse mode but not while
           tabbing, and tabbing is how this panel is operated. Both still contain their
           visible text, so voice control still matches (WCAG 2.5.3). -->
      <label class="pomodoro-field">Older than (days)<input type="number" name="pruneDays" id="store-prune-days" min="1" max="3650" step="1" aria-label="Store: older than (days)"></label>
      <div class="pomodoro-settings-actions">
        <!-- One click, no arming -- deliberately unlike Reset directly above it, which
             does arm. Weighed and chosen (ADR 71): the window is named deliberately at
             the call, so the click is not the deliberate part. The critical colour is
             worn permanently rather than on an armed state, since there is no armed
             state to show. -->
        <button type="button" class="pomodoro-btn pomodoro-btn-danger" id="store-prune" aria-label="Store: delete boards">Delete boards</button>
        <span class="pomodoro-settings-status" id="store-prune-status" role="status" aria-live="polite"></span>
      </div>
    </form>
  </details>
</div>`;
}
