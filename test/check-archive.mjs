// Ticket 06 (DESIGN.md), criterion 5: "An archived board opened from disk
// with no daemon shows every pin in the right place, read-only, and invites no
// gesture it cannot honour."
//
// Every other check that drives the real client script (test/check-click.mjs,
// test/check-comment-mode.mjs, test/check-anchor-rerender.mjs, test/check-http.mjs's
// own ticket-04 round trip) loads the board with `location.protocol` set to
// `'http:'` -- the live path. None of them ever set it to `'file:'`, which is the
// ONE branch src/ui.mjs actually reads to decide read-only mode
// (`var readonly = (location.protocol === 'file:')`). This file is the first thing
// in the suite that does, and it does so the way the spec insists on: by writing a
// real rendered page to a real file on a real temp directory, with nothing
// listening on any port, reading THAT FILE's bytes back off disk, and only then
// parsing and running the real `ui` string against it with `location.protocol`
// actually set to `'file:'` -- never by constructing a document and flipping a
// `readonly` variable by hand, which would prove nothing about the branch a real
// double-click in Finder actually takes.
//
// The board carries one already-resolved comment per acceptance-criterion-1
// content kind (prose, a list item, a table cell, a line of a code reference, one
// side of a comparison, a question's own widget, a hand-mocked stage, the
// diagram), each minted through the REAL client script in a separate, ordinary
// (`http:`) session first -- exactly test/check-http.mjs's own ticket-04 round-trip
// pattern -- so every ref/hint this file submits is a genuine one the client would
// actually produce, not a hand-guessed index chain. Those, plus one deliberately
// stale anchor (so "every pin in the right place" is checked against a LOST one
// too, per DESIGN.md's "a lost anchor still reports what it lost"), are
// submitted server-side with no HTTP involved (src/board.mjs's own applySubmit --
// there is no daemon in this file, on purpose), then re-rendered, written to disk,
// and read back for the actual archive pass.
//
// Mermaid is ticket 05's territory (wireMermaidBlock, renderMermaidPins,
// renderMermaidBlocks, the `mermaid` anchor kind, the `body:not(.readonly)
// .mermaid-block ...` rules) -- this file includes a mermaid block, and its
// resolved-vs-lost verdict is asserted the same way test/check-anchor-rerender.mjs
// already asserts it (against the server-rendered comment-list text), because
// actually driving wireMermaidBlock here would mean waiting on the same
// CDN-unreachable async fallback that file's own comment documents, and because
// editing or second-guessing wireMermaidBlock/renderMermaidPins is explicitly out
// of scope for this ticket.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard, applySubmit } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { styles, palettes } from '../src/styles.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { parseHTML, StandInEvent, StandInLocalStorage, resolveComputedProperty } from './dom-stand-in.mjs';

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

/** Parse `html` and run the real `ui` client script against it, with
 * `location.protocol` set to `protocol` -- the ONLY input src/ui.mjs reads to
 * decide read-only mode. A fresh document every call. */
function loadBoard(html, protocol) {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** Extract the real `<style>...</style>` block's CSS text from a rendered
 * page. NOT the first (or last) `<style>`/`</style>` substring in the bytes:
 * `themeBootScript` (src/theme.mjs) carries the literal words "before
 * `<style>` is even parsed" inside its own JS comments, and `styles`
 * (src/styles.mjs) itself carries "injected into the sandboxed document's
 * own `<style>`" inside a CSS comment describing the (unrelated) html-stage
 * hover outline -- real prose baked into the client script and the
 * stylesheet's own text, both landing BEFORE the true closing `</style>`, so
 * neither a naive `/<style>([\s\S]*?)<\/style>/` (grabs from the FIRST fake
 * opener) nor a `lastIndexOf('<style>', closeIdx)` (grabs the LAST one,
 * which turns out to be the CSS-comment one, still short of the real tag) is
 * safe. src/render.mjs and src/indexpage.mjs both emit the real tag
 * immediately after the boot script's own closing tag
 * (`<script>${themeBootScript}</script>\n<style>${styles}</style>`) -- an
 * exact, structural adjacency neither piece of PROSE text reproduces -- so
 * that marker is what actually locates it. */
function extractStyleBlock(html) {
  const marker = '</script>\n<style>';
  const markerIdx = html.indexOf(marker);
  assert.ok(markerIdx !== -1, 'setup failure: no boot-script-then-<style> boundary found in the rendered page');
  const openIdx = markerIdx + marker.length;
  const closeIdx = html.indexOf('</style>', openIdx);
  assert.ok(closeIdx !== -1, 'setup failure: no </style> after the real <style> tag');
  return html.slice(openIdx, closeIdx);
}

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

/** Click `el` (comment mode already on) and read back the anchor the real client
 * script minted onto `blockId`'s comment form -- test/check-http.mjs's own
 * ticket-04 `captureAnchor`, reused so every ref/hint fed into applySubmit below is
 * one the real gesture actually produced.
 *
 * Ticket 07 (DESIGN.md), audit finding V2: this used to just click and
 * read the form back, never closing it first. Six of the eight captures below
 * SHARE a block (three on the markdown block, two on the html-stage blocks), so
 * they share one <form> element across calls -- a click that does NOTHING (the
 * click handler bails before ever calling openCommentForm, e.g. because buildSteps
 * failed for that particular element) left the PREVIOUS capture's ref/hint sitting
 * on the still-open form, and the old code read that back as if it were fresh: two
 * different fixture elements ended up sharing the exact same minted anchor, with
 * nothing here or in the check functions below ever noticing. Demonstrated by the
 * audit: making buildSteps return null for TD turned test/check-comment-mode.mjs
 * red while this file stayed fully green, with its "table cell" and "list item"
 * pins turning out to be the very same <li>.
 *
 * Fixed by resetting the form to closed/blank BEFORE each click: if the click then
 * does nothing, the form stays closed and the assertion below fails LOUDLY --
 * "clicking did not open ... comment form" -- instead of silently handing back
 * stale data. Combined with the distinctness assertion right after this function's
 * call sites (`mintedPairs`, below), which further asserts no two captures ever
 * agree on the exact same (blockId, ref) pair -- the second, independent way this
 * exact bug would show up even if some future click legitimately reopens an
 * already-open form. */
function captureAnchor(document, el, blockId, text) {
  const form = document.getElementById('comment-form-' + blockId);
  assert.ok(form, `setup failure: no comment-form for block ${blockId}`);
  form.classList.remove('open');
  form.setAttribute('data-anchor-kind', '');
  form.setAttribute('data-anchor-ref', '');
  form.setAttribute('data-anchor-label', '');
  const target = document.getElementById('comment-target-' + blockId);
  if (target) target.classList.remove('open');

  el.dispatchEvent(new StandInEvent('click'));

  assert.ok(form.classList.contains('open'), `clicking did not open block ${blockId}'s comment form -- the gesture did nothing (this used to be silently masked by a PREVIOUS capture's stale ref/hint still sitting on the same shared form; see this function's own comment)`);
  const anchor = {
    kind: form.getAttribute('data-anchor-kind'),
    ref: form.getAttribute('data-anchor-ref'),
    hint: form.getAttribute('data-anchor-label'),
  };
  assert.ok(anchor.ref, `setup failure: empty ref minted for block ${blockId}`);
  return { blockId, anchor, text };
}

/** The direct-child `.pin-layer` of a page-scoped block section, or (for the
 * html/mermaid stage cases, whose pin-layer nests inside `.stage-wrap`) whatever
 * `.pin-layer` is found anywhere inside it -- same fallback test/check-http.mjs's
 * own `pinLayerFor` uses, for the same reason. */
function pinLayerFor(document, blockId) {
  const section = document.querySelector(`[data-block-id="${blockId}"]`);
  assert.ok(section, `setup failure: no section for block ${blockId}`);
  const layer = Array.prototype.slice.call(section.children)
    .find(c => c.classList && c.classList.contains('pin-layer')) || section.querySelector('.pin-layer');
  assert.ok(layer, `setup failure: block ${blockId} has no pin-layer`);
  return layer;
}

// --- fixture: one board covering every criterion-1 content kind, plus a lost ---
// anchor, submitted with real refs minted through the real client script -------

const board = createBoard({
  title: 'Ticket 06 -- an archived board',
  blocks: [
    {
      kind: 'markdown',
      text: [
        '# Findings',
        '',
        'A paragraph of prose to comment on.',
        '',
        '- alpha item',
        '- beta item',
        '',
        '| Col A | Col B |',
        '| --- | --- |',
        '| Total | 42 |',
      ].join('\n'),
    },
    { kind: 'code', text: 'const x = 1;\nconst y = 2;', lang: 'javascript' },
    {
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'markdown', text: 'the old copy, unchanged' } },
      right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Ship it</button></div>' } },
    },
    { kind: 'html', html: '<div class="mock"><button>Launch</button></div>' },
    { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
    { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  ],
});
const mdBlockId = board.blocks[0].id;
const codeBlockId = board.blocks[1].id;
const compareLeftId = board.blocks[2].left.block.id;
const compareRightId = board.blocks[2].right.block.id;
const stageBlockId = board.blocks[3].id;
const mermaidBlockId = board.blocks[4].id;
const questionId = board.blocks[5].id;

// Mint every `dom` anchor through the real gesture, in an ordinary (`http:`) live
// session -- comment mode on, one click per content kind -- exactly as a reviewer
// would produce it before this board was ever archived.
const mintHtml = renderBoardPage(board);
const mintDoc = loadBoard(mintHtml, 'http:');
enableCommentMode(mintDoc);

const prose = mintDoc.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1);
const listItem = mintDoc.querySelectorAll('.md-content li').find(el => el.textContent.trim() === 'alpha item');
const tableCell = mintDoc.querySelectorAll('.md-content td').find(el => el.textContent.trim() === '42');
const codeLine = mintDoc.querySelectorAll('.code-line').find(el => el.textContent.trim() === 'const y = 2;');
const compareProse = mintDoc.querySelectorAll('.compare-side .md-content p').find(el => el.textContent.indexOf('old copy') !== -1);
const option = mintDoc.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
assert.ok(prose && listItem && tableCell && codeLine && compareProse && option, 'setup failure: could not find every fixture element to mint an anchor on');

const mintedPairs = [
  captureAnchor(mintDoc, prose, mdBlockId, 'prose comment'),
  captureAnchor(mintDoc, listItem, mdBlockId, 'list-item comment'),
  captureAnchor(mintDoc, tableCell, mdBlockId, 'table-cell comment'),
  captureAnchor(mintDoc, codeLine, codeBlockId, 'code-line comment'),
  captureAnchor(mintDoc, compareProse, compareLeftId, 'compare-side comment'),
  captureAnchor(mintDoc, option, questionId, 'question-widget comment'),
];

const compareFrame = mintDoc.querySelectorAll('.html-stage')[0];
compareFrame.loadSrcdoc();
mintedPairs.push(captureAnchor(mintDoc, compareFrame.contentDocument.querySelector('button'), compareRightId, 'compare-stage comment'));

const standaloneFrame = mintDoc.querySelectorAll('.html-stage')[1];
standaloneFrame.loadSrcdoc();
mintedPairs.push(captureAnchor(mintDoc, standaloneFrame.contentDocument.querySelector('button'), stageBlockId, 'standalone-stage comment'));

for (const p of mintedPairs) {
  assert.equal(p.anchor.kind, 'dom');
  assert.ok(p.anchor.ref, `setup failure: empty ref minted for block ${p.blockId}`);
}

// Ticket 07 (DESIGN.md), audit finding V2, second guard: every capture
// must be genuinely distinct from every other one that shares its block -- three
// captures share mdBlockId's form (prose/list-item/table-cell) and two share the
// html-stage blocks' forms (through their own iframes). Two captures on the same
// block landing on the exact same (kind, ref) pair is exactly the symptom the
// audit measured (the "table cell" and "list item" pins turning out to be the
// same <li>) -- captureAnchor's own reset-before-click fix (see its comment)
// already turns a dead click into a loud failure there; this is the second,
// independent way the same bug would show up even for a click that legitimately
// re-opens an already-open form.
{
  const seenPerBlock = new Map();
  for (const p of mintedPairs) {
    const key = p.anchor.kind + ':' + p.anchor.ref;
    const seen = seenPerBlock.get(p.blockId) || new Set();
    assert.ok(!seen.has(key),
      `two different captures on block ${p.blockId} minted the exact same anchor (${key}) -- captureAnchor read back a stale previous capture instead of a fresh one`);
    seen.add(key);
    seenPerBlock.set(p.blockId, seen);
  }
}

// Submitted with NO daemon involved -- src/board.mjs's own applySubmit, exactly
// what the server calls, called directly. Order fixes each comment's number (n =
// index + 1), asserted below rather than hardcoded twice.
const submittedComments = [
  ...mintedPairs,
  { blockId: mermaidBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'diagram comment' },
  // Deliberately stale: no re-rendered markdown block has 99 children at any
  // depth, so this can never accidentally resolve.
  { blockId: mdBlockId, anchor: { kind: 'dom', ref: '99.99', hint: 'a sentence that used to live here' }, text: 'this used to point at something real' },
];
applySubmit(board, { action: 'send', answers: [], comments: submittedComments }, 1);
const mermaidCommentN = submittedComments.findIndex(c => c.text === 'diagram comment') + 1;
const lostCommentN = submittedComments.findIndex(c => c.text === 'this used to point at something real') + 1;

// --- write the finished page to a REAL file, with nothing listening, and read ---
// it back off disk -- the archive is what a reviewer double-clicks in Finder, not
// a string held in this process's memory.

const archiveDir = mkdtempSync(path.join(tmpdir(), 'claude-board-archive-'));
const archivePath = path.join(archiveDir, `${board.id}.html`);
const renderedNow = renderBoardPage(board);
writeFileSync(archivePath, renderedNow, 'utf8');
const fileContents = readFileSync(archivePath, 'utf8');
assert.equal(fileContents, renderedNow, 'setup failure: the file on disk does not match what was written');

check('setup: the file actually landed on disk at a real path', () => {
  assert.ok(archivePath.startsWith(archiveDir), 'setup failure: the archive path is not under the temp dir it was written to');
  assert.equal(fileContents.length > 0, true);
});

// The whole archive/live split is one byte-identical page (DESIGN.md "JSON is
// truth, the page is a projection", proven at the daemon level by
// test/check-http.mjs's own "served page / pages/ file / fresh render" check): the
// SAME markup src/render.mjs emits for a live GET is what gets written to disk and
// read back here -- nothing in the bytes changes, only the branch src/ui.mjs takes
// once `location.protocol` is actually `'file:'`.

// --- load the archive exactly as Finder would: from the file's own bytes, with --
// `location.protocol` actually 'file:' -- never a hand-set `readonly` flag. -------

function loadArchive() {
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  let fetchCalled = false;
  let esConstructed = false;
  globalThis.fetch = (...args) => { fetchCalled = true; return Promise.reject(new Error('the archive must never call fetch')); };
  class SpyEventSource {
    constructor() { esConstructed = true; }
  }
  globalThis.EventSource = SpyEventSource;
  const document = loadBoard(fileContents, 'file:');
  return {
    document,
    restore() { globalThis.fetch = originalFetch; globalThis.EventSource = originalES; },
    fetchCalled: () => fetchCalled,
    esConstructed: () => esConstructed,
  };
}

// Ticket 05: like loadArchive() above, but also runs src/theme.mjs's
// themeBootScript -- the SAME bytes read off disk above, run through BOTH real
// client scripts in the real page's own order (the inline pre-<style> boot
// script first, then ui's deferred module script second), with
// location.protocol genuinely 'file:', never a hand-set flag (this file's own
// header comment). `storage`, if given, is attached to the fresh document's own
// window BEFORE either script runs -- one StandInLocalStorage instance passed to
// two separate calls models one origin's storage outliving a single sitting
// (test/dom-stand-in.mjs's own comment on StandInLocalStorage), which is what
// the reopen check below needs. fetch/EventSource are stubbed exactly like
// loadArchive(), for the same reason: the archive must never reach for either.
function loadArchiveThemed(storage) {
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  globalThis.fetch = () => Promise.reject(new Error('the archive must never call fetch'));
  class SpyEventSource {
    constructor() { /* no-op: an archive must never construct one */ }
  }
  globalThis.EventSource = SpyEventSource;

  const document = parseHTML(fileContents);
  const window = document.defaultView;
  if (storage) window.localStorage = storage;
  const location = { protocol: 'file:' };
  new Function('document', 'window', 'location', themeBootScript)(document, window, location);
  new Function('document', 'window', 'location', ui)(document, window, location);
  // Audit 2026-07-31 (H2): a freshly parsed document now starts `readyState
  // === 'loading'`, so the theme control's click listener is not wired until
  // this simulates the parser reaching the end of the document (see
  // test/dom-stand-in.mjs's own comment on finishParsing/readyState) --
  // every check below that clicks the control depends on this having run.
  document.finishParsing();

  return {
    document,
    restore() { globalThis.fetch = originalFetch; globalThis.EventSource = originalES; },
  };
}

// =================================================================================
// 1. Every pin in the right place, including a lost one.
// =================================================================================

check('archive: the page-scoped pins (prose, list item, table cell, code line, compare side, question widget) all land resolved, in their own block\'s pin-layer', () => {
  const { document, restore } = loadArchive();
  try {
    assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');
    const pageScoped = mintedPairs.filter(p => [mdBlockId, codeBlockId, compareLeftId, questionId].includes(p.blockId));
    const byBlock = new Map();
    for (const p of pageScoped) byBlock.set(p.blockId, (byBlock.get(p.blockId) || 0) + 1);
    for (const [blockId, expectedCount] of byBlock) {
      const layer = pinLayerFor(document, blockId);
      // The markdown block also carries the deliberately-lost anchor's own pin
      // (see the dedicated lost-anchor check below) -- filtered out here by class,
      // not by count, so this check stays about "the minted ones resolve" and the
      // lost one's own check stays the one place that asserts it.
      const resolvedPins = layer.querySelectorAll('.anchor-pin').filter(p => !p.classList.contains('pin-lost'));
      assert.equal(resolvedPins.length, expectedCount, `expected ${expectedCount} resolved pin(s) in block ${blockId}'s pin-layer, got ${resolvedPins.length}`);
    }
  } finally { restore(); }
});

check('archive: the compare-side and standalone html-stage pins land resolved once each stage\'s real srcdoc document has "loaded"', () => {
  const { document, restore } = loadArchive();
  try {
    const frames = document.querySelectorAll('.html-stage');
    assert.equal(frames.length, 2, 'setup failure: expected two html stages (compare-right, standalone)');
    frames.forEach(f => f.loadSrcdoc());

    const compareLayer = pinLayerFor(document, compareRightId);
    const comparePins = compareLayer.querySelectorAll('.anchor-pin');
    assert.equal(comparePins.length, 1, `expected 1 pin in the compare stage's pin-layer, got ${comparePins.length}`);
    assert.equal(comparePins[0].classList.contains('pin-lost'), false);

    const standaloneLayer = pinLayerFor(document, stageBlockId);
    const standalonePins = standaloneLayer.querySelectorAll('.anchor-pin');
    assert.equal(standalonePins.length, 1, `expected 1 pin in the standalone stage's pin-layer, got ${standalonePins.length}`);
    assert.equal(standalonePins[0].classList.contains('pin-lost'), false);
  } finally { restore(); }
});

check('archive: a lost page-scoped anchor still reports what it lost -- a pin-lost pin and a "lost: <hint>" comment-list entry, not silence', () => {
  const { document, restore } = loadArchive();
  try {
    const layer = pinLayerFor(document, mdBlockId);
    const lostPins = layer.querySelectorAll('.anchor-pin.pin-lost');
    assert.equal(lostPins.length, 1, `expected exactly one lost pin in the markdown block's pin-layer, got ${lostPins.length}`);
    assert.ok(String(lostPins[0].title || '').indexOf('lost: a sentence that used to live here') !== -1,
      `expected the lost pin's title to name what it lost, got ${JSON.stringify(lostPins[0].title)}`);
    assert.ok(fileContents.includes(`#${lostCommentN} · lost: a sentence that used to live here`), 'the comment list must name what the anchor lost, on the page itself');
    assert.ok(fileContents.includes('comment-lost'));
  } finally { restore(); }
});

check('archive: the diagram\'s (mermaid) comment renders resolved, by its node id -- not routed through any mermaid wiring this ticket does not own', () => {
  // Deliberately server-rendered-text only (see this file's header comment): the
  // client script's own mermaid rendering is async against an unreachable CDN and
  // owned by ticket 05, not asserted here.
  assert.ok(fileContents.includes(`#${mermaidCommentN} · A`), 'the mermaid node-id comment must render resolved (its node id, not "lost: ...")');
  assert.ok(!fileContents.includes(`#${mermaidCommentN} · lost:`), 'the mermaid comment must not report lost');
});

// =================================================================================
// 2. Read-only throughout, and the toggle claim specifically.
// =================================================================================

check('archive: ticket 03\'s claim -- the comment-mode toggle is both CSS-hidden and hard-disabled in readonly -- verified, not trusted', () => {
  // The CSS side, read directly rather than assumed from ticket 03's own report.
  assert.match(styles, /body\.readonly \.mode-toggle \{[^}]*display: none/, 'expected a body.readonly rule hiding .mode-toggle');

  // The behavioural side: the SAME toggle element the live page renders, run
  // through the real script with location.protocol at 'file:'.
  const { document, restore } = loadArchive();
  try {
    const toggle = document.getElementById('comment-mode-toggle');
    assert.ok(toggle, 'the toggle is still IN the markup (the page is byte-identical live or archived -- see this file\'s header comment); readonly hides it structurally, not by omitting it');
    assert.equal(toggle.disabled, true, 'the toggle must be hard-disabled, not merely styled to look disabled');
    assert.equal(toggle.classList.contains('active'), false);

    // Belt and suspenders, proven independently of the native `disabled` attribute
    // (this stand-in does not model a browser's own click-suppression on a
    // disabled element -- see test/dom-stand-in.mjs's EventTarget): even a
    // dispatched click must not turn comment mode on.
    toggle.dispatchEvent(new StandInEvent('click'));
    assert.equal(toggle.classList.contains('active'), false, 'clicking the toggle in readonly must never turn comment mode on');
    assert.equal(document.body.classList.contains('comment-mode'), false, 'body must never gain .comment-mode in a read-only archive');
  } finally { restore(); }
});

check('archive: ticket 04\'s back-to-index control is absent, not merely disabled -- there is no daemon behind "/" in a file:// archive', () => {
  // The CSS side, read directly rather than assumed.
  assert.match(styles, /body\.readonly \.back-to-index \{[^}]*display: none/, 'expected a body.readonly rule hiding .back-to-index');

  const { document, restore } = loadArchive();
  try {
    const backLink = document.querySelector('.back-to-index');
    assert.ok(backLink, 'the control is still IN the markup (one byte-identical page, live or archived) -- readonly hides it structurally, not by omitting it');
    assert.equal(backLink.getAttribute('href'), '/', 'setup failure: expected the control to point at the thread index');
  } finally { restore(); }
});

// Audit finding H3: `body.readonly button#theme-toggle { display: inline-flex;
// }` (src/styles.mjs) is the readonly carve-out that keeps the theme control
// visible while `body.readonly .mode-toggle { display: none; }` hides every
// OTHER control wearing `.mode-toggle`'s chrome (the comment-mode toggle
// above). Nothing asserted it before this: delete that one rule and the
// theme control inherits the SAME `display: none` the comment-mode toggle
// gets, in every archive, silently -- QUIRKS.md's own "readonly is locked
// twice" entry names exactly this shape of gap. Asserted as the COMPUTED
// display (test/dom-stand-in.mjs's resolveComputedProperty, audit C1/H3),
// against the file's own <style> text and the REAL button element from a
// loaded archive -- not the rule's spelling, which is what QUIRKS.md warns
// against asserting.
check('archive: audit finding H3 -- the theme control\'s COMPUTED display is inline-flex under body.readonly, not silently inheriting .mode-toggle\'s own display:none', () => {
  const cssText = extractStyleBlock(fileContents);

  const { document, restore } = loadArchive();
  try {
    assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');
    const btn = document.getElementById('theme-toggle');
    assert.ok(btn, 'setup failure: no #theme-toggle rendered in the archive');
    const display = resolveComputedProperty(cssText, btn, true, 'display');
    assert.equal(display, 'inline-flex',
      `the real button's computed display in a readonly archive must be inline-flex -- got "${display}" (deleting body.readonly button#theme-toggle leaves it display:none, hidden by the SAME rule that correctly hides the comment-mode toggle)`);
  } finally { restore(); }
});

check('archive: the send bar is disabled and posts nothing, even when clicked directly', () => {
  const { document, restore, fetchCalled } = loadArchive();
  try {
    const sendBtn = document.getElementById('send-btn');
    const discussBtn = document.getElementById('discuss-btn');
    assert.ok(sendBtn && discussBtn);
    assert.equal(sendBtn.disabled, true);
    assert.equal(discussBtn.disabled, true);
    sendBtn.dispatchEvent(new StandInEvent('click'));
    discussBtn.dispatchEvent(new StandInEvent('click'));
    assert.equal(fetchCalled(), false, 'clicking Send/Discuss in a read-only archive must never call fetch -- there is no daemon to post to');
  } finally { restore(); }
});

check('archive: answer widgets, the note field, and the defer button are all hard-disabled and do not record input', () => {
  const { document, restore } = loadArchive();
  try {
    const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
    assert.ok(yes);
    assert.equal(yes.disabled, true);
    yes.dispatchEvent(new StandInEvent('click'));
    assert.equal(yes.classList.contains('selected'), false, 'a disabled choice must not become selected even if clicked');

    const note = document.querySelector(`textarea[data-note-for="${questionId}"]`);
    assert.ok(note);
    assert.equal(note.disabled, true);

    const defer = document.querySelector(`.btn-defer[data-defer-for="${questionId}"]`);
    assert.ok(defer);
    assert.equal(defer.disabled, true);
    defer.dispatchEvent(new StandInEvent('click'));
    assert.equal(defer.classList.contains('active'), false, 'a disabled defer button must not toggle even if clicked');
  } finally { restore(); }
});

check('archive: never opens an SSE connection, even though EventSource exists in this environment', () => {
  const { esConstructed, restore } = loadArchive();
  try {
    assert.equal(esConstructed(), false, 'a read-only archive must never construct an EventSource -- there is no daemon to stream from');
  } finally { restore(); }
});

// =================================================================================
// 3. No gesture it cannot honour: no hover, no click, in either document.
// =================================================================================

check('archive: hovering ordinary content adds no highlight class -- the affordance is not offered, not merely non-functional', () => {
  const { document, restore } = loadArchive();
  try {
    const targets = [
      document.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1),
      document.querySelectorAll('.md-content li').find(el => el.textContent.trim() === 'alpha item'),
      document.querySelectorAll('.code-line').find(el => el.textContent.trim() === 'const y = 2;'),
      document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1),
    ];
    for (const el of targets) {
      assert.ok(el, 'setup failure: a hover target was not found');
      el.dispatchEvent(new StandInEvent('mouseover'));
      assert.equal(el.classList.contains('cb-anchor-hover'), false, `hovering ${el.tagName} must not mark it as anchorable in a read-only archive`);
    }
    assert.equal(document.body.classList.contains('comment-mode'), false);
  } finally { restore(); }
});

check('archive: hovering inside the isolated html-stage document adds no outline, and no hover stylesheet is even injected into it (QUIRKS.md "two stylesheets, one palette")', () => {
  const { document, restore } = loadArchive();
  try {
    const frame = document.querySelectorAll('.html-stage')[1]; // standalone stage
    frame.loadSrcdoc();
    const stageDoc = frame.contentDocument;
    const button = stageDoc.querySelector('button');
    assert.ok(button);

    // Not offered, not merely inert: wireHtmlStage's own readonly guard sits
    // BEFORE the hover <style> is ever created (test/check-pure.mjs already pins
    // this ordering structurally) -- checked here behaviourally, against the
    // iframe's own live document, which the board page's stylesheet deliberately
    // never reaches (QUIRKS.md).
    assert.equal((stageDoc.head ? stageDoc.head.children.length : 0), 0, 'no stylesheet should be injected into the stage document in readonly');

    button.dispatchEvent(new StandInEvent('mouseover'));
    assert.equal(button.classList.contains('cb-anchor-hover'), false, 'hovering inside an archived html stage must not outline the element');
  } finally { restore(); }
});

check('archive: clicking prose, a list item, a table cell, a code line, a compare side, and a question widget opens no comment form', () => {
  const { document, restore } = loadArchive();
  try {
    const cases = [
      [document.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1), mdBlockId],
      [document.querySelectorAll('.md-content li').find(el => el.textContent.trim() === 'alpha item'), mdBlockId],
      [document.querySelectorAll('.md-content td').find(el => el.textContent.trim() === '42'), mdBlockId],
      [document.querySelectorAll('.code-line').find(el => el.textContent.trim() === 'const y = 2;'), codeBlockId],
      [document.querySelectorAll('.compare-side .md-content p').find(el => el.textContent.indexOf('old copy') !== -1), compareLeftId],
      [document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1), questionId],
    ];
    for (const [el, blockId] of cases) {
      assert.ok(el, 'setup failure: a click target was not found');
      el.dispatchEvent(new StandInEvent('click'));
      const form = document.getElementById('comment-form-' + blockId);
      assert.equal(form.classList.contains('open'), false, `clicking must not open block ${blockId}'s comment form in a read-only archive`);
    }
  } finally { restore(); }
});

check('archive: clicking inside either html stage (compare-side or standalone) opens no comment form', () => {
  const { document, restore } = loadArchive();
  try {
    const frames = document.querySelectorAll('.html-stage');
    frames.forEach(f => f.loadSrcdoc());
    const [compareBtn, standaloneBtn] = [
      frames[0].contentDocument.querySelector('button'),
      frames[1].contentDocument.querySelector('button'),
    ];
    compareBtn.dispatchEvent(new StandInEvent('click'));
    standaloneBtn.dispatchEvent(new StandInEvent('click'));
    assert.equal(document.getElementById('comment-form-' + compareRightId).classList.contains('open'), false);
    assert.equal(document.getElementById('comment-form-' + stageBlockId).classList.contains('open'), false);
  } finally { restore(); }
});

check('archive: the block-level "comment" button opens no form either -- disabled AND inert, not one masquerading as the other', () => {
  const { document, restore } = loadArchive();
  try {
    const btn = document.querySelector(`.comment-btn[data-block-id="${mdBlockId}"]`);
    assert.ok(btn, 'setup failure: no block-level comment button rendered for the markdown block');
    assert.equal(btn.disabled, true);
    btn.dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + mdBlockId);
    assert.equal(form.classList.contains('open'), false, 'the block-level comment button must not open a form in a read-only archive');
  } finally { restore(); }
});

check('archive: the emitted page still has no external script or stylesheet reference, even carrying compare/html/mermaid content and nine comments', () => {
  assert.ok(!/<link[^>]+rel=["']stylesheet["']/.test(fileContents));
  assert.ok(!/<script[^>]+\bsrc=/.test(fileContents));
  assert.ok(fileContents.includes('<style>'));
});

// =================================================================================
// 4. Ticket 05 (light theme): the archive follows the OS, its control still
//    works for the sitting, and nothing persists across a reopen -- spec:
//    "Follow the OS; the control still works for the sitting but persists
//    nothing." Exercised against the SAME bytes read off disk above, the same
//    way every other check in this file is: never a hand-set `readonly` flag,
//    never a constructed document standing in for the real file (this file's
//    own header comment).
// =================================================================================

// Audit 2026-07-31 (C1): this used to assert the two light rules by their
// SPELLING -- a regex matching the literal `@media { :root:not(...) { ... } }`
// nesting and a separate `:root[data-theme="light"] { ... }` match, each
// checked for a substring. That is exactly the trap QUIRKS.md's "the
// stylesheet and the markup are checked against each other" entry warns
// against (see also the mermaid-id trap it documents): nesting the override
// INSIDE the media query -- breaking a dark-OS reader's Light choice, the one
// case this feature exists for -- still contains both substrings, so the old
// version of this check stayed green through it. Replaced with the real
// cascade resolver (test/dom-stand-in.mjs, audit C1) run against the file's
// OWN `<style>` text (not the in-memory `styles` export -- if render.mjs ever
// diverged from it, this would still catch that too), asserting the full
// {OS dark, OS light} x {no attribute, data-theme="light", data-theme="dark"}
// matrix resolves to the intended palette.
check('archive: the bytes on disk carry a real, working cascade -- every (OS preference, data-theme) combination resolves to the intended palette, computed from the file\'s own <style> text, not asserted by any one rule\'s spelling', () => {
  const cssText = extractStyleBlock(fileContents);

  const document = parseHTML(fileContents);
  const docEl = document.documentElement;

  const cases = [
    { systemDark: true, attr: null, expect: 'dark' },
    { systemDark: true, attr: 'light', expect: 'light' },
    { systemDark: true, attr: 'dark', expect: 'dark' },
    { systemDark: false, attr: null, expect: 'light' },
    { systemDark: false, attr: 'light', expect: 'light' },
    { systemDark: false, attr: 'dark', expect: 'dark' },
  ];
  for (const { systemDark, attr, expect } of cases) {
    if (attr) docEl.setAttribute('data-theme', attr); else docEl.removeAttribute('data-theme');
    const got = resolveComputedProperty(cssText, docEl, systemDark, '--bg');
    assert.equal(got, palettes[expect]['--bg'],
      `OS ${systemDark ? 'dark' : 'light'} + data-theme=${attr || '(none)'}: expected ${expect}'s --bg from the file's own <style> text, got "${got}"`);
  }
});

check('archive: opened fresh, the control is live -- not merely present-and-enabled -- and clicking it actually cycles data-theme through light and dark, without ever writing to storage', () => {
  const storage = new StandInLocalStorage();
  const { document, restore } = loadArchiveThemed(storage);
  try {
    const btn = document.getElementById('theme-toggle');
    assert.ok(btn, 'setup failure: no #theme-toggle rendered in the archive');
    assert.equal(btn.disabled, false, 'the theme control must not be disabled in the archive (test/check-theme.mjs already proves this on an in-memory page; re-checked here against the real bytes on disk)');
    assert.equal(document.documentElement.hasAttribute('data-theme'), false, 'setup failure: the archive must start following the OS -- no data-theme attribute');

    // Belt and suspenders, same as this file's own toggle check above: the
    // stand-in does not model a browser's native click-suppression on a
    // disabled element, so `disabled === false` is asserted directly, not
    // inferred from the click's effect alone.
    btn.dispatchEvent(new StandInEvent('click'));
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'clicking the control in the real archive must switch to light -- the control is live');
    btn.dispatchEvent(new StandInEvent('click'));
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark', 'clicking again must switch to dark');

    assert.equal(storage.map.size, 0, 'the archive must never write to storage, even while the control is actively cycling');
  } finally { restore(); }
});

check('archive: reopening the SAME file in a fresh document, sharing the storage stand-in a previous sitting used, comes up with no data-theme -- the previous sitting\'s explicit choice left nothing behind', () => {
  const sharedStorage = new StandInLocalStorage();

  const first = loadArchiveThemed(sharedStorage);
  try {
    const firstBtn = first.document.getElementById('theme-toggle');
    firstBtn.dispatchEvent(new StandInEvent('click')); // System -> Light: an explicit choice, made during this sitting
    assert.equal(first.document.documentElement.getAttribute('data-theme'), 'light', 'setup failure: the first sitting did not switch to light');
    assert.equal(sharedStorage.map.size, 0, 'setup failure: even mid-sitting the archive must not have written to storage');
  } finally { first.restore(); }

  // A brand-new document/window (a real reopen mints a fresh one -- see
  // loadArchiveThemed's own comment), but the SAME storage instance: this is
  // the one input that could leak a previous sitting's choice into a reopen,
  // and it is exactly what test/check-theme.mjs's `file:` guard is supposed to
  // prevent from ever being written to in the first place.
  const second = loadArchiveThemed(sharedStorage);
  try {
    assert.equal(second.document.documentElement.hasAttribute('data-theme'), false, 'reopening the archive must return to the OS preference -- the previous sitting\'s explicit Light choice must not leak in, even sharing the same storage instance');
    const secondBtn = second.document.getElementById('theme-toggle');
    assert.equal(secondBtn.getAttribute('aria-label'), 'Theme: System', 'the control itself must also read back System on reopen, not the previous sitting\'s Light');
  } finally { second.restore(); }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall archive checks ok');
