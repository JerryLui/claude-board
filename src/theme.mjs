// Client-side theme selection: the single source of truth for how a reader's
// theme preference is stored, applied, and controlled. See ADR.md entry 1 for
// why this is entirely client-side (the server never learns the preference, so
// the served page / the pages/ file on disk / a fresh renderBoardPage() stay
// byte-identical -- test/check-http.mjs's standing guard) and the ticket's
// spec decisions ("Three states, not two", "The control's affordance", "file:
// is storage-free by decision") for the product calls this module carries out.
//
// Both src/render.mjs (the board page) and src/indexpage.mjs (the index) import
// from here, so the boot script and the control's markup are each written
// exactly once and both pages emit byte-identical copies of both -- the same
// discipline src/ui.mjs's embedded computeBoardPatch/composeHint already use
// for a server/client pair, applied here to a page/page pair instead.
//
// QUIRKS.md "a backtick inside a template-literal client script ends it early"
// applies a third time here (src/ui.mjs's `ui` and src/render.mjs's
// `stageAgentScript()` are the other two): `themeBootScript` below is one more
// giant template literal holding real, standalone JavaScript. No literal
// backtick appears anywhere inside it, including in prose -- single quotes
// only for an inline code reference. `node --check src/theme.mjs` only proves
// this OUTER file parses; test/check-theme.mjs proves the EXTRACTED script
// parses, by running it through
// `new Function('document', 'window', 'location', themeBootScript)`, the same
// technique every check in test/ already uses for `ui`.

/** The `localStorage` key an explicit override is stored under. Only 'light' or
 * 'dark' is ever written -- System is the ABSENCE of this key (removed with
 * `removeItem`, never a stored 'system' sentinel), so returning to System
 * leaves nothing behind to be residue. */
export const THEME_STORAGE_KEY = 'cb-theme';

/** Dispatched on `window`, by `themeBootScript` below, every time it applies a
 * new theme state -- a click on the control (System -> Light -> Dark ->
 * System), or (this file's own `matchMedia` listener, further down) a live OS
 * light/dark preference change while System is in force. src/ui.mjs's client
 * script -- a SEPARATE `<script>` on the page, with no shared scope this file
 * could call into directly -- listens for this to redraw every mermaid diagram
 * in whatever the new active palette is ("Mermaid.
 * Re-initialize and re-run every diagram on a switch"). Named in the repo's
 * `cb-`-prefixed style, matching `cb-stage` in src/render.mjs's
 * `stageAgentScript`/src/ui.mjs's own `STAGE_CB`. */
export const THEME_CHANGE_EVENT = 'cb-theme-change';

const STATE_LABEL = {
  system: 'Theme: System',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
};

// Three inline glyphs, one per state -- no external assets ever (QUIRKS.md),
// same stroke-based style as src/render.mjs's COMMENT_ICON. Declared
// once here and spliced into BOTH themeToggle()'s server-rendered markup and
// themeBootScript's client-side icon swap below, via template interpolation --
// never a second, hand-copied set of paths that could drift from the first.
const SYSTEM_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const LIGHT_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.6" y2="6.6"/><line x1="17.4" y1="17.4" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.6" y2="17.4"/><line x1="17.4" y1="6.6" x2="19.1" y2="4.9"/></svg>';
const DARK_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';

/** The control's markup: an icon-only button reusing `.mode-toggle`'s chrome
 * (src/styles.mjs) plus `.mode-toggle-icon`, an icon-only modifier -- never a
 * second, duplicated set of button rules. Always renders the System glyph and
 * label: that is the truthful state before any script has run, and stays
 * correct even if script never runs at all, since no `data-theme` attribute
 * is ever set either in that case. `themeBootScript` below corrects the
 * label/icon to the actually-stored state (if any) the moment it wires up --
 * well after the attribute that drives colour, which is set synchronously,
 * pre-paint (see that export's own comment).
 *
 * Unlike `.mode-toggle` (hidden AND disabled in a read-only archive --
 * src/styles.mjs, src/ui.mjs), this control stays fully live there: an
 * archive reader is exactly who needs to switch theme, and `file:` is
 * storage-free by decision, not by disabling the control (see
 * themeBootScript's own protocol gate below). `body.readonly
 * button#theme-toggle` in src/styles.mjs overrides the `.mode-toggle`
 * readonly-hide rule by id, specifically so that rule's own exact wording
 * (asserted verbatim by test/check-archive.mjs) never has to change to carve
 * this control out of it; src/ui.mjs's readonly disable-loop re-enables the
 * same element by id for the same reason. Both the CSS and the two JS
 * lookups (here and src/ui.mjs) are tag-qualified, not bare `#theme-toggle`
 * -- a heading `## Theme toggle` mints a second `id="theme-toggle"` on an
 * `<h2>` (src/markdown.mjs's slugify), and `button#theme-toggle` is what the
 * real control has that a heading never can. */
export function themeToggle() {
  return `<button type="button" id="theme-toggle" class="mode-toggle mode-toggle-icon" aria-label="${STATE_LABEL.system}" title="${STATE_LABEL.system}">${SYSTEM_ICON}</button>`;
}

/** The whole pre-paint boot script, as a plain string of real JavaScript --
 * never wrapped in `<script>` tags here. Both src/render.mjs and
 * src/indexpage.mjs do that at the call site (`<script>${themeBootScript}
 * </script>`), exactly like src/ui.mjs's `ui`, so this string can be run
 * directly through `new Function('document', 'window', 'location',
 * themeBootScript)` -- see this file's header comment. An ES5-flavoured IIFE,
 * matching src/render.mjs's `stageAgentScript()` in code style: `var`,
 * function expressions, no arrow functions / template literals /
 * destructuring -- this runs standalone in the reader's browser with no build
 * step, exactly like every other client script this repo ships.
 *
 * Four jobs, strictly in order:
 *
 * 1. SYNCHRONOUSLY, before anything else runs -- read any stored override and
 *    set (or remove) `data-theme` on `document.documentElement`. This has to
 *    happen before `<style>` is even parsed (see the call sites: this script
 *    is placed before the `<style>` element in both pages' `<head>`), because
 *    the CSS selector structure it drives (src/styles.mjs: a plain `:root`
 *    block for dark, `@media (prefers-color-scheme: light) {
 *    :root:not([data-theme="dark"]) { ... } }` for the OS-light default, and
 *    a plain, unconditional `:root[data-theme="light"]` for an explicit
 *    override) reads this attribute the very first time the stylesheet is
 *    evaluated -- there is no second pass. Setting it a tick later, after
 *    paint, is exactly what produces the dark-then-light flash this
 *    rules out. In System mode (no stored override) NO attribute is ever set
 *    at all, which is what makes "no residue" real: the CSS
 *    media query alone then drives the page's own colors, no JS listener
 *    needed for THAT. A live OS preference change still needs one for a
 *    different reason -- job 3 below.
 *
 * 2. Once the document has a `<body>` (on 'DOMContentLoaded', or immediately
 *    if the document has already finished parsing by the time this runs --
 *    it normally has not, since this script's own position in `<head>` is
 *    before everything else) -- find the control (`#theme-toggle`, emitted
 *    by `themeToggle()` above on both pages), give it the label / tooltip /
 *    icon matching whatever state actually won step 1, and wire its click to
 *    cycle System -> Light -> Dark -> System.
 *
 * 3. Notify the REST of the page that the active
 *    theme may just have changed. A mermaid diagram is rendered once,
 *    client-side, into a fixed set of colors baked into its SVG at render
 *    time (src/ui.mjs) -- CSS custom properties do nothing for content that
 *    is no longer CSS. `src/ui.mjs`'s own `<script type="module">` is a
 *    SEPARATE script with no shared scope this one could call into directly,
 *    so the two talk via `THEME_CHANGE_EVENT`, a plain `window`-level
 *    CustomEvent, dispatched every time `setState` below applies a new state
 *    (a click on the control) AND from a `matchMedia('(prefers-color-scheme:
 *    dark)')` 'change' listener, registered here because the STATE this
 *    decision depends on (is an explicit override in force right now) lives
 *    in this closure, not in ui.mjs -- the one case the control itself can't
 *    cause: System mode has no attribute and no click, so the OS changing its
 *    mind has to be caught separately, and only acted on while System is
 *    actually in force (checked at fire time, not baked in at registration,
 *    since which one is true can itself change between now and then).
 *
 * 4. Listen for a `'storage'` event -- the platform's own
 *    notification that `cb-theme` changed in ANOTHER browsing context
 *    sharing this origin (never fired in the tab that made the write, so
 *    this can never double-apply a click `setState` already handled
 *    locally). Without it, a reader with the index open in one tab and a
 *    board open in another -- the ordinary case -- could choose Dark in one
 *    and have the OTHER tab's still-stale control silently overwrite that
 *    choice on its very next click, because that tab's cycle position was
 *    snapshotted at boot and nothing ever told it storage moved out from
 *    under it. Re-applies the attribute, re-labels the control, and fires
 *    the same `THEME_CHANGE_EVENT` job 3 does, so a mermaid diagram already
 *    on screen in the quiet tab redraws too. Same file:/try-catch gating as
 *    every other storage access below.
 *
 * Storage contract: only 'light' / 'dark' is ever written; System is the
 * ABSENCE of the key (`removeItem`, never a stored 'system' sentinel -- an
 * explicit sentinel is residue, which is exactly what gets ruled out).
 * Every storage access is gated on BOTH `location.protocol !== 'file:'` (the
 * product decision -- a standalone archive persists nothing) AND wrapped in
 * try/catch (private-mode / disabled-storage throws even when the protocol
 * check passes; an uncaught exception here would leave the whole page
 * unthemed, not merely untheme-remembering) -- src/ui.mjs's own
 * `location.protocol === 'file:'` readonly branch is the precedent this
 * follows. */
export const themeBootScript = `
(function () {
  var KEY = '${THEME_STORAGE_KEY}';
  var CHANGE_EVENT = '${THEME_CHANGE_EVENT}';
  var root = document.documentElement;

  function readStored() {
    if (location.protocol === 'file:') return null;
    try {
      var v = window.localStorage.getItem(KEY);
      return (v === 'light' || v === 'dark') ? v : null;
    } catch (e) {
      return null;
    }
  }

  function applyAttr(state) {
    if (state === 'light' || state === 'dark') root.setAttribute('data-theme', state);
    else root.removeAttribute('data-theme');
  }

  // Step 1: synchronous, before <style> is parsed -- see this export's own
  // comment for why the ordering itself is the whole no-flash mechanism.
  applyAttr(readStored());

  function currentState() {
    var attr = root.getAttribute('data-theme');
    return (attr === 'light' || attr === 'dark') ? attr : 'system';
  }

  function nextState(state) {
    if (state === 'system') return 'light';
    if (state === 'light') return 'dark';
    return 'system';
  }

  var LABELS = { system: '${STATE_LABEL.system}', light: '${STATE_LABEL.light}', dark: '${STATE_LABEL.dark}' };
  var ICONS = { system: '${SYSTEM_ICON}', light: '${LIGHT_ICON}', dark: '${DARK_ICON}' };

  function updateButton(btn, state) {
    if (!btn) return;
    var label = LABELS[state];
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    btn.innerHTML = ICONS[state];
  }

  // Step 3 (see this export's own comment): one shared notification, fired
  // both by a click (setState below) and by the matchMedia listener further
  // down. Guarded rather than assumed -- a browser old enough to lack
  // CustomEvent still gets a working control and correct colors from step 1
  // alone; it only loses the mermaid-redraw notification, silently, same as
  // this file's every other defensive 'typeof'/try-catch guard.
  function notifyThemeChange() {
    if (typeof CustomEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }

  function setState(btn, state) {
    applyAttr(state);
    if (location.protocol !== 'file:') {
      try {
        if (state === 'system') window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, state);
      } catch (e) { /* private mode / disabled storage -- the page still themes itself */ }
    }
    updateButton(btn, state);
    notifyThemeChange();
  }

  // Step 3, continued: the one theme change the control itself never sees.
  // System mode tracks the OS live via the CSS media query alone (no
  // listener needed for the page's own colors -- see this export's own
  // comment) but an already-rendered mermaid SVG does not follow a media
  // query, so THAT still needs telling, and only while no explicit override
  // is in force -- exactly mirroring the CSS's own
  // 'root:not([data-theme="dark"])' guard, which the media query only ever
  // wins through when data-theme is absent. 'currentState()' is read again
  // inside the handler, not captured now, because whether an override is in
  // force can itself change between registration and the OS actually firing.
  if (window.matchMedia) {
    var systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemPreferenceChange = function () {
      if (currentState() === 'system') notifyThemeChange();
    };
    if (systemQuery.addEventListener) systemQuery.addEventListener('change', onSystemPreferenceChange);
    else if (systemQuery.addListener) systemQuery.addListener(onSystemPreferenceChange); // Safari < 14
  }

  // A second tab must not silently overwrite what the
  // reader just chose. 'cb-theme' is one value per origin, but each
  // document's own cycle position (currentState(), read off ITS OWN
  // data-theme attribute) is snapshotted at boot and never told about a
  // write some OTHER tab made -- with the index open in tab A and a board
  // open in tab B (the ordinary case), choosing Dark in A left B's control
  // reading a stale "Theme: System", so one click in B walked ITS stale
  // cycle position System -> Light and overwrote what A had just chosen, and
  // A reloaded Light. The 'storage' event is the platform's own signal for
  // "localStorage changed in ANOTHER browsing context sharing this origin"
  // -- it never fires in the context that made the write, so this can never
  // double-apply a click setState above already handled. Gated on
  // 'e.key === KEY' (an explicit light/dark write or an explicit removeItem
  // back to System) OR 'e.key === null' (what clear() reports, per the DOM
  // spec -- readStored() re-reads rather than trusting e.newValue, so both
  // collapse onto the same one-value-per-origin truth this file already
  // treats as authoritative). Same file:/try-catch gating as every other
  // storage access in this file (readStored, setState): an archive is
  // storage-free by decision, and this must never act if that protocol
  // check somehow lies.
  if (location.protocol !== 'file:' && window.addEventListener) {
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY && e.key !== null) return;
      try {
        applyAttr(readStored());
      } catch (e2) { return; }
      updateButton(document.querySelector('button#theme-toggle'), currentState());
      notifyThemeChange();
    });
  }

  // Step 2: wire the control once it exists. A plain <button type="button">
  // (themeToggle() above), so keyboard operability is free -- no tabindex, no
  // click handler bolted onto a non-button. Tag-qualified, not a bare
  // '#theme-toggle' id lookup: board content can mint a second element with
  // this id (src/markdown.mjs's slugify turns a heading '## Theme toggle'
  // into <h2 id="theme-toggle">, which renders before this control in tree
  // order), and only the real control is a <button> -- see themeToggle()'s
  // own comment above.
  function wire() {
    var btn = document.querySelector('button#theme-toggle');
    if (!btn) return;
    updateButton(btn, currentState());
    btn.addEventListener('click', function () {
      setState(btn, nextState(currentState()));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
`;
