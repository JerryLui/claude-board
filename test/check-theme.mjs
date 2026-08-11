// Drives the REAL src/theme.mjs boot script --
// not a hand-summary of what it does -- against rendered board and index pages
// in test/dom-stand-in.mjs, proving the three-state control (System -> Light ->
// Dark -> System), its accessible name/tooltip, storage persistence across a
// reload and across pages, System's "no residue" removeItem contract, the
// file: no-write guarantee, and readonly survival, all end to end through the
// one real script every page ships (never a mock of it -- QUIRKS.md: "a mock
// of someone else's renderer is worth exactly as much as the last time someone
// checked it against the real thing").
//
// The no-flash half is checked structurally here (see section 2): a
// real browser is out of scope for this suite, so what IS checked is that the
// boot script's own, real text -- not a hand-written stand-in for it that could
// drift -- appears before <style> and before <body> in both pages' emitted
// markup.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { renderIndexPage } from '../src/indexpage.mjs';
import { themeBootScript, THEME_STORAGE_KEY, THEME_CHANGE_EVENT } from '../src/theme.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML, StandInEvent, StandInLocalStorage } from './dom-stand-in.mjs';

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

// --- loader: run the REAL themeBootScript against a freshly parsed document, ---
// exactly like every other check in this suite runs `ui` (see
// test/check-archive.mjs's own `loadBoard`). `storage`, if given, is attached to
// the fresh document's own `window` BEFORE the script runs -- modelling one
// origin's localStorage outliving any one page load, never auto-created per
// window (see StandInLocalStorage's own comment in dom-stand-in.mjs).
//
// A freshly parsed document now starts `readyState ===
// 'loading'` (dom-stand-in.mjs), matching a real page at the moment this
// inline <head> script runs -- so themeBootScript takes its real, only
// production branch (`document.addEventListener('DOMContentLoaded', wire)`)
// here too, not the 'wire() immediately' branch a real page never takes at
// that point. `document.finishParsing()` simulates the parser reaching the
// end of the document (readyState -> 'complete', a real 'DOMContentLoaded'
// dispatched), which is what actually invokes `wire()` and attaches the
// control's click listener -- every check below that clicks the control
// depends on this having run. ------------------------------------------------

function loadWithTheme(html, protocol, storage) {
  const document = parseHTML(html);
  const window = document.defaultView;
  if (storage) window.localStorage = storage;
  const location = { protocol };
  // 'EventSource' is DECLARED and never passed, binding the name to undefined inside
  // this scope so a guard reading it fires by this file's choice rather than by
  // whether this node build happens to expose a global EventSource (behind a flag
  // since 22.x) -- see QUIRKS.md's entry on the trap this closes.
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location);
  document.finishParsing();
  return document;
}

function themeToggleEl(document) {
  const btn = document.getElementById('theme-toggle');
  assert.ok(btn, 'setup failure: no #theme-toggle rendered');
  return btn;
}

function click(el) { el.dispatchEvent(new StandInEvent('click')); }

// =================================================================================
// 1. The cycle, the accessible name/tooltip, and persistence across a reload and
//    across pages -- through the real boot script driving the real control.
// =================================================================================

{
  const boardA = createBoard({ title: 'Theme A', blocks: [{ kind: 'markdown', text: '# A' }] });
  const htmlA = renderBoardPage(boardA);
  const storage = new StandInLocalStorage();
  const docA = loadWithTheme(htmlA, 'http:', storage);
  const btn = themeToggleEl(docA);

  check('theme: starts in System -- no data-theme attribute, and the control names it', () => {
    assert.equal(docA.documentElement.getAttribute('data-theme'), null);
    assert.equal(btn.getAttribute('aria-label'), 'Theme: System');
    assert.equal(btn.getAttribute('title'), 'Theme: System');
  });

  check('theme: one click cycles System -> Light, updating both the attribute and the control\'s name/tooltip', () => {
    click(btn);
    assert.equal(docA.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(btn.getAttribute('aria-label'), 'Theme: Light');
    assert.equal(btn.getAttribute('title'), 'Theme: Light');
  });

  check('theme: a second click cycles Light -> Dark', () => {
    click(btn);
    assert.equal(docA.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(btn.getAttribute('aria-label'), 'Theme: Dark');
    assert.equal(btn.getAttribute('title'), 'Theme: Dark');
  });

  check('theme: a third click cycles Dark -> System, removing the attribute entirely rather than resetting it to a value', () => {
    click(btn);
    assert.equal(docA.documentElement.hasAttribute('data-theme'), false);
    assert.equal(btn.getAttribute('aria-label'), 'Theme: System');
    assert.equal(btn.getAttribute('title'), 'Theme: System');
  });

  check('theme: choosing Light stores it under THEME_STORAGE_KEY', () => {
    click(btn); // System -> Light
    assert.equal(docA.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(storage.getItem(THEME_STORAGE_KEY), 'light');
  });

  // --- persistence: a FRESH document (a DIFFERENT board entirely), same
  // storage, comes up already themed -- before any click. This is the
  // "survives a reload and applies to any other board opened afterwards"
  // guarantee.
  check('theme: a freshly loaded, different board comes up data-theme="light" before any click', () => {
    const boardB = createBoard({ title: 'Theme B', blocks: [{ kind: 'markdown', text: '# B' }] });
    const htmlB = renderBoardPage(boardB);
    const docB = loadWithTheme(htmlB, 'http:', storage); // same storage instance, brand new document/window
    assert.equal(docB.documentElement.getAttribute('data-theme'), 'light', 'the stored preference must apply before any click, on a different board entirely');
    const btnB = themeToggleEl(docB);
    assert.equal(btnB.getAttribute('aria-label'), 'Theme: Light', 'the control itself must reflect the stored state at load, not just the attribute');
  });

  // --- the index page, using storage the BOARD page wrote -- the half
  // a board-only test would miss.
  check('theme: the index page, loaded fresh from the SAME storage a board page wrote, also comes up data-theme="light" before any click', () => {
    const idxHtml = renderIndexPage({ threads: [] });
    const idxDoc = loadWithTheme(idxHtml, 'http:', storage);
    assert.equal(idxDoc.documentElement.getAttribute('data-theme'), 'light');
    const idxBtn = themeToggleEl(idxDoc);
    assert.equal(idxBtn.getAttribute('aria-label'), 'Theme: Light');
  });

  // --- returning to System removes the key -- no sentinel left behind
  // ("no residue from the previous explicit choice").
  check('theme: cycling back to System removes the storage key entirely -- no "system" sentinel written', () => {
    click(btn); // light -> dark
    click(btn); // dark -> system
    assert.equal(docA.documentElement.hasAttribute('data-theme'), false);
    assert.equal(storage.getItem(THEME_STORAGE_KEY), null, 'getItem must report the key absent, not a sentinel value');
    assert.equal(storage.map.has(THEME_STORAGE_KEY), false, 'the key itself must be genuinely gone from storage, not merely read back as null through some other path');
  });
}

// =================================================================================
// 2. No-flash, structurally: the boot script's actual text precedes <style> and
//    precedes <body> in both pages' emitted markup. Asserted by locating the
//    real, exported `themeBootScript` string in the output -- not a
//    hand-written stand-in for it that could silently drift from what
//    src/render.mjs / src/indexpage.mjs actually emit.
// =================================================================================

check('board page: the real themeBootScript text appears before <style> and before <body>', () => {
  const board = createBoard({ title: 'Order', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  const scriptIdx = html.indexOf(themeBootScript);
  const styleIdx = html.indexOf('<style>');
  const bodyIdx = html.indexOf('<body');
  assert.ok(scriptIdx !== -1, 'the exact themeBootScript text must appear verbatim in the rendered page');
  assert.ok(styleIdx !== -1 && bodyIdx !== -1, 'setup failure: page missing <style>/<body>');
  assert.ok(scriptIdx < styleIdx, 'the boot script must run before <style> is parsed, or the first paint can still be dark');
  assert.ok(scriptIdx < bodyIdx, 'the boot script must run before <body> -- that ordering is what makes it pre-paint at all');
});

check('index page: the real themeBootScript text appears before <style> and before <body>', () => {
  const html = renderIndexPage({ threads: [] });
  const scriptIdx = html.indexOf(themeBootScript);
  const styleIdx = html.indexOf('<style>');
  const bodyIdx = html.indexOf('<body');
  assert.ok(scriptIdx !== -1, 'the exact themeBootScript text must appear verbatim in the rendered index page');
  assert.ok(styleIdx !== -1 && bodyIdx !== -1, 'setup failure: index page missing <style>/<body>');
  assert.ok(scriptIdx < styleIdx);
  assert.ok(scriptIdx < bodyIdx);
});

// =================================================================================
// 3. file: is storage-free by decision: the control still works locally, but
//    never touches storage -- gated on BOTH the protocol check and a try/catch
//    (belt and suspenders; see src/theme.mjs's own comment on why both).
// =================================================================================

check('theme: on file:, cycling the control changes data-theme locally but leaves the storage stand-in completely empty', () => {
  const board = createBoard({ title: 'Archive', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  const storage = new StandInLocalStorage();
  const document = loadWithTheme(html, 'file:', storage);
  const btn = themeToggleEl(document);

  assert.equal(document.documentElement.hasAttribute('data-theme'), false);
  assert.equal(storage.map.size, 0, 'setup failure: storage stand-in must start empty');

  // Asserted after EVERY click, not just at the end of the cycle: the cycle's
  // last click lands back on System, which legitimately calls removeItem --
  // checking emptiness only there would miss a bug that wrongly writes on the
  // System -> Light and Light -> Dark clicks and only "self-heals" on the final
  // Dark -> System one (ablation-verified: dropping the file: guard while
  // leaving the removeItem-on-System branch intact makes exactly that happen,
  // and an end-of-cycle-only assertion here stayed green through it).
  click(btn);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'the control must still work locally in an archive -- it just persists nothing');
  assert.equal(storage.map.size, 0, 'must not have written to storage after the System -> Light click');
  click(btn);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(storage.map.size, 0, 'must not have written to storage after the Light -> Dark click');
  click(btn);
  assert.equal(document.documentElement.hasAttribute('data-theme'), false);
  assert.equal(storage.map.size, 0, 'must not have written to storage after the Dark -> System click');
});

// =================================================================================
// 4. The control survives readonly -- in deliberate contrast to the
//    comment-mode toggle, which test/check-archive.mjs already asserts IS
//    disabled there.
// =================================================================================

check('theme: the control is present and NOT disabled in a read-only (file://) board page -- unlike the comment-mode toggle', () => {
  const board = createBoard({ title: 'Readonly', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  const storage = new StandInLocalStorage();
  const document = parseHTML(html);
  const window = document.defaultView;
  window.localStorage = storage;
  const location = { protocol: 'file:' };
  // Same order a real page executes them in: the head boot script first
  // (readyState still 'loading' -- see loadWithTheme's own comment above),
  // then ui's own deferred module script, then the parser finishing (which is
  // what actually wires the control's click listener). 'EventSource' declared
  // and left unpassed on both, same reason as loadWithTheme above.
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);
  document.finishParsing();

  assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');

  const btn = themeToggleEl(document);
  assert.equal(btn.disabled, false, 'the theme control must NOT be disabled in a read-only archive -- an archive reader is exactly who needs it');

  const commentToggle = document.getElementById('comment-mode-toggle');
  assert.ok(commentToggle, 'setup failure: no comment-mode toggle rendered');
  assert.equal(commentToggle.disabled, true, 'contrast check: the comment-mode toggle IS disabled in readonly (test/check-archive.mjs owns this claim; re-checked here only as the contrast the ticket names)');

  // And it still actually works there (spec: "In an archive the control must
  // still work for the sitting; it just writes nothing").
  click(btn);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(storage.map.size, 0, 'still writes nothing, even while readonly');
});

// =================================================================================
// 5. A second tab must not silently overwrite what the
//    reader just chose. localStorage is one value per origin, but each
//    document's own cycle position is read off ITS OWN data-theme attribute,
//    snapshotted at boot -- nothing ever told a quiet tab that ANOTHER tab
//    sharing the same storage just wrote to it. A real browser fires
//    'storage' on every OTHER same-origin window the moment that happens;
//    this stand-in's StandInLocalStorage is a plain Map with no cross-window
//    wiring of its own, so each check below dispatches that event by hand --
//    exactly what the platform would have delivered -- onto the REAL boot
//    script's REAL listener, never a hand-summary of what it does.
// =================================================================================

{
  const boardA = createBoard({ title: 'Tab A', blocks: [{ kind: 'markdown', text: '# A' }] });
  const boardB = createBoard({ title: 'Tab B', blocks: [{ kind: 'markdown', text: '# B' }] });
  const sharedStorage = new StandInLocalStorage();
  const docA = loadWithTheme(renderBoardPage(boardA), 'http:', sharedStorage);
  const docB = loadWithTheme(renderBoardPage(boardB), 'http:', sharedStorage);
  const btnA = themeToggleEl(docA);
  const btnB = themeToggleEl(docB);

  check('theme: tab A choosing Dark, then tab B told storage changed, re-applies the attribute and re-labels tab B\'s own control', () => {
    assert.equal(btnB.getAttribute('aria-label'), 'Theme: System', 'setup failure: tab B must start on System, matching no stored override yet');
    click(btnA); // System -> Light
    click(btnA); // Light -> Dark
    assert.equal(sharedStorage.getItem(THEME_STORAGE_KEY), 'dark', 'setup failure: tab A did not persist Dark');
    assert.equal(docB.documentElement.hasAttribute('data-theme'), false, 'setup failure: tab B must not have moved on its own -- nothing told it yet');

    let changeFired = 0;
    docB.defaultView.addEventListener(THEME_CHANGE_EVENT, () => { changeFired++; });
    const storageEvent = new StandInEvent('storage');
    storageEvent.key = THEME_STORAGE_KEY;
    docB.defaultView.dispatchEvent(storageEvent);

    assert.equal(docB.documentElement.getAttribute('data-theme'), 'dark', 'tab B must re-apply the attribute a sibling tab just wrote');
    assert.equal(btnB.getAttribute('aria-label'), 'Theme: Dark', 'tab B\'s own control must re-label itself, not keep reporting the stale state');
    assert.equal(changeFired, 1, 'tab B must also notify the rest of the page (mermaid redraw) exactly once');
  });

  check('theme: an unrelated storage key changing must not touch this page\'s theme', () => {
    const before = docB.documentElement.getAttribute('data-theme');
    const ev = new StandInEvent('storage');
    ev.key = 'some-other-origin-key';
    docB.defaultView.dispatchEvent(ev);
    assert.equal(docB.documentElement.getAttribute('data-theme'), before, 'a storage event for a different key must be ignored entirely');
  });

  check('theme: e.key === null (what clear() reports) is treated as System, same as an explicit removeItem', () => {
    // StandInLocalStorage (test/dom-stand-in.mjs) models get/set/removeItem
    // only, not clear() -- removeItem reaches the same end state (the key
    // genuinely gone) that a real clear() would, which is what this dispatch
    // then simulates the platform reporting.
    sharedStorage.removeItem(THEME_STORAGE_KEY);
    const ev = new StandInEvent('storage');
    ev.key = null;
    docB.defaultView.dispatchEvent(ev);
    assert.equal(docB.documentElement.hasAttribute('data-theme'), false, 'a null-key storage event must return this tab to System');
    assert.equal(btnB.getAttribute('aria-label'), 'Theme: System');
  });
}

check('theme: on file:, a storage event must never act -- the listener is gated on the same protocol check as every other storage access', () => {
  const board = createBoard({ title: 'Archive', blocks: [{ kind: 'markdown', text: '# A' }] });
  const storage = new StandInLocalStorage();
  storage.setItem(THEME_STORAGE_KEY, 'dark'); // as if a live tab, sharing an origin, had already chosen Dark
  const document = loadWithTheme(renderBoardPage(board), 'file:', storage);
  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: file: must never read storage even at boot');

  const ev = new StandInEvent('storage');
  ev.key = THEME_STORAGE_KEY;
  document.defaultView.dispatchEvent(ev);
  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'a file:// archive must never act on a storage event, even one naming the right key');
});

// =================================================================================
// 6. themeBootScript's only production branch (readyState
//    'loading' at the moment it runs, since it is inline in <head> before
//    <body> even exists) actually runs, and the two jobs inside it happen in
//    the order that matters -- data-theme is applied SYNCHRONOUSLY, before
//    any DOMContentLoaded dispatch (the no-flash guarantee), and
//    the control is wired only AFTER it (wiring needs the button, which does
//    not exist yet at synchronous-boot time). Both of H2's mutations --
//    deleting the DOMContentLoaded listener entirely, or moving
//    applyAttr(readStored()) into wire() -- must fail this check.
// =================================================================================

check('theme: readyState starts "loading" (a real page\'s state when this inline <head> script runs) -- data-theme is set synchronously, before DOMContentLoaded, but the control is not wired until after it', () => {
  const board = createBoard({ title: 'Ordering', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  const storage = new StandInLocalStorage();
  storage.setItem(THEME_STORAGE_KEY, 'light');
  const document = parseHTML(html);
  assert.equal(document.readyState, 'loading', 'setup failure: a freshly parsed document must start "loading", matching the moment a real inline <head> script runs');
  const window = document.defaultView;
  window.localStorage = storage;
  const location = { protocol: 'http:' };

  // 'EventSource' declared and left unpassed, same reason as loadWithTheme above.
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location);

  // Job 1 (data-theme) must already be correct -- synchronous, no
  // DOMContentLoaded needed. Fails if applyAttr(readStored()) is moved into
  // wire() (H2's second mutation): that would restore the dark-then-light
  // flash this guards against.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light',
    'data-theme must be applied synchronously, before <body> (and its #theme-toggle) even exist');

  // Job 2 (wiring) must NOT have happened yet: a click now must do nothing.
  const btn = themeToggleEl(document);
  click(btn);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light',
    'the control must not be wired yet -- a click before DOMContentLoaded must do nothing (if it does anything, wire() ran too early)');

  document.finishParsing();

  // Job 2 must have happened now: the SAME click that just did nothing must
  // now work. Fails if the `document.addEventListener('DOMContentLoaded',
  // wire)` line is deleted entirely (H2's first mutation): wire() then never
  // runs at all, on either page, live or archived.
  click(btn);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark',
    'after DOMContentLoaded, the control must be wired -- clicking must cycle the state (light -> dark)');
});

// =================================================================================
// 7. A throwing localStorage backend (private mode / disabled
//    storage) must never crash the boot script -- a read failure degrades to
//    System, a write failure is silently swallowed, and the page keeps
//    theming itself locally either way (src/theme.mjs's own comment: "an
//    uncaught exception here would leave the whole page unthemed, not merely
//    untheme-remembering").
// =================================================================================

check('theme: a throwing localStorage backend never crashes the boot script -- a throwing getItem degrades to System, a throwing setItem is swallowed, and the control keeps working locally', () => {
  class ThrowingStorage {
    getItem() { throw new Error('storage disabled'); }
    setItem() { throw new Error('storage disabled'); }
    removeItem() { throw new Error('storage disabled'); }
  }
  const board = createBoard({ title: 'Throwing storage', blocks: [{ kind: 'markdown', text: '# A' }] });
  const html = renderBoardPage(board);
  let document;
  assert.doesNotThrow(() => { document = loadWithTheme(html, 'http:', new ThrowingStorage()); },
    'a throwing getItem must not escape the boot script -- readStored()\'s own try/catch must swallow it');
  assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'a throwing getItem must degrade to System, same as no stored preference at all');

  const btn = themeToggleEl(document);
  assert.doesNotThrow(() => click(btn), 'a throwing setItem must not escape setState -- the click must still work');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'the click must still apply locally even though storage cannot record it');
});

// =================================================================================
// 8. Without a CustomEvent constructor (an old browser), the
//    control must still apply data-theme and relabel itself -- only the
//    mermaid-redraw notification is silently skipped (src/theme.mjs's
//    notifyThemeChange: `if (typeof CustomEvent !== 'function') return;`).
// =================================================================================

check('theme: without a CustomEvent constructor, the control still works -- data-theme applies and the label updates, only the mermaid-redraw notification is silently skipped', () => {
  const originalCustomEvent = globalThis.CustomEvent;
  delete globalThis.CustomEvent;
  try {
    const board = createBoard({ title: 'No CustomEvent', blocks: [{ kind: 'markdown', text: '# A' }] });
    const html = renderBoardPage(board);
    const document = loadWithTheme(html, 'http:', new StandInLocalStorage());
    const btn = themeToggleEl(document);
    assert.doesNotThrow(() => click(btn), 'a click must not throw even when CustomEvent does not exist');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'the theme itself must still apply');
    assert.equal(btn.getAttribute('aria-label'), 'Theme: Light', 'the control must still relabel itself');
  } finally {
    globalThis.CustomEvent = originalCustomEvent;
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall theme checks ok');
