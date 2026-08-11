// "An archived board opened from disk
// with no daemon shows every pin in the right place, read-only, and invites no
// gesture it cannot honour."
//
// Every other check that drives the real client script (test/check-click.mjs,
// test/check-comment-mode.mjs, test/check-anchor-rerender.mjs, test/check-http.mjs's
// own round trip) loads the board with `location.protocol` set to
// `'http:'` -- the live path. None of them ever set it to `'file:'`, which is the
// ONE branch src/ui.mjs actually reads to decide read-only mode
// (`var readonly = (location.protocol === 'file:')`). This file is the first thing
// in the suite that does, and it does so the way the spec insists on: by writing a
// real rendered page to a real file on a real temp directory, with nothing
// listening on any port, reading THAT FILE's bytes back off disk, and only then
// parsing and running the real client script against it with `location.protocol`
// actually set to `'file:'` -- never by constructing a document and flipping a
// `readonly` variable by hand, which would prove nothing about the branch a real
// double-click in Finder actually takes.
//
// Since ADR 70 the archive does not carry that client script (nor its stylesheet): it
// NAMES them, as bare content-addressed sibling filenames, and the daemon writes them
// beside it. So this file no longer runs the `ui` string it imported -- it takes the name
// out of the archive's own bytes, resolves it against the archive's own directory, reads
// THAT file, and runs it. Same for the CSS every cascade assertion below is computed
// against. That round trip is the only thing that actually proves a folder handed to
// someone else opens (AC 9); running an imported payload would pass just as happily
// against a page whose reference pointed nowhere.
//
// The board carries one already-resolved comment per acceptance-criterion
// content kind (prose, a list item, a table cell, a line of a code reference, one
// side of a comparison, a question's own `context` entry, a hand-mocked stage, the
// diagram), each minted through the REAL client script in a separate, ordinary
// (`http:`) session first -- exactly test/check-http.mjs's own round-trip
// pattern -- so every ref/hint this file submits is a genuine one the client would
// actually produce, not a hand-guessed index chain. Those, plus one deliberately
// stale anchor (so "every pin in the right place" is checked against a LOST one
// too, since "a lost anchor still reports what it lost"), are
// submitted server-side with no HTTP involved (src/board.mjs's own applySubmit --
// there is no daemon in this file, on purpose), then re-rendered, written to disk,
// and read back for the actual archive pass.
//
// ADR.md entry 28 ("Only the rendered kinds can be commented on", 2026-08-06):
// `question` and `compare` lost the comment affordance on their own wrapper
// entirely -- no button, no form, no page-scoped pin-layer of their own. The
// question fixture below carries an `html` `context` entry precisely so this file
// still covers a page-scoped anchor nested one level inside a question -- the kind
// this ADR keeps commentable wherever it appears -- rather than the question's own
// widget, which no longer has anywhere to mint a comment onto at all.
//
// Mermaid is a separate territory (wireMermaidBlock, renderMermaidPins,
// renderMermaidBlocks, the `mermaid` anchor kind, the `body:not(.readonly)
// .mermaid-block ...` rules) -- this file includes a mermaid block, and its
// resolved-vs-lost verdict is asserted the same way test/check-anchor-rerender.mjs
// already asserts it (against the server-rendered comment-list text), because
// actually driving wireMermaidBlock here would mean waiting on the same
// CDN-unreachable async fallback that file's own comment documents, and because
// editing or second-guessing wireMermaidBlock/renderMermaidPins is explicitly out
// of scope here.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard, applySubmit } from '../src/board.mjs';
import { writePage } from '../src/store.mjs';
import { renderBoardPage, STAGE_MARGIN_RESET } from '../src/render.mjs';
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

/** Parse `html` and run a client script against it, with `location.protocol` set to
 * `protocol` -- the ONLY input src/ui.mjs reads to decide read-only mode. A fresh
 * document every call.
 *
 * `script` defaults to the in-memory `ui` export, which is right for the minting session
 * below (an ordinary live page, never written to disk). Every ARCHIVE load in this file
 * passes the script the archive itself names, read back off disk -- see `openArchive`.
 *
 * 'EventSource' is DECLARED as a parameter of the evaluated script, closing the same trap
 * every other check file in this suite closes: left off the list, the name would resolve
 * to whatever this node build happens to expose (a global EventSource has sat behind a
 * flag since 22.x), and the MINTING call below (an ordinary http: session, readonly false)
 * would open a live connection to '/api/board/<id>/events' and throw, from a check that is
 * about archived markup. `eventSource` defaults to undefined, which is exactly that fix for
 * the minting call and every ordinary caller. loadArchive()/loadPageArchive() below are the
 * one exception: they pass their own SpyEventSource through this parameter explicitly
 * (never through globalThis) so "archive: never opens an SSE connection, even though
 * EventSource exists in this environment" keeps proving the real `!readonly` gate against a
 * name the script can actually see -- a blanket undefined here would make that check pass
 * no matter what the gate did, since `typeof EventSource` would already read 'undefined'
 * regardless of readonly. */
function loadBoard(html, protocol, script = ui, eventSource) {
  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', 'EventSource', script)(document, window, location, eventSource);
  return document;
}

/** Resolve one of the two sibling files an archive NAMES, exactly as a browser opening
 * that file would: take the bare filename out of the page's own bytes, join it to the
 * directory the page is in, and read it. Nothing here knows the payload in advance --
 * that is the point (ADR 70, AC 9). A reference that is anything but a bare filename
 * fails the assertion before it can be joined, which is what makes this a real test of
 * the Finder surface rather than a re-derivation of what render.mjs meant. */
function readNamedSibling(pagePath, pageText, pattern, what) {
  const m = pageText.match(pattern);
  assert.ok(m, `the archive on disk names no ${what}`);
  const name = m[1];
  assert.ok(!name.includes('/') && !name.includes(':') && !name.startsWith('.'),
    `the archive's ${what} reference "${name}" is not a bare sibling filename, so it cannot resolve from Finder`);
  return readFileSync(path.join(path.dirname(pagePath), name), 'utf8');
}

const namedScript = (pagePath, pageText) =>
  readNamedSibling(pagePath, pageText, /<script defer src="([^"]+)"><\/script>/, 'client script');
const namedStylesheet = (pagePath, pageText) =>
  readNamedSibling(pagePath, pageText, /<link rel="stylesheet" href="([^"]+)">/, 'stylesheet');

// This file used to carry an `extractStyleBlock(html)` that pulled the page's CSS out of
// its inlined `<style>` block, located by the structural adjacency render.mjs emitted
// (`</script>\n<style>`) because the payloads themselves contain the literal words
// `<style>` and `</style>` inside their own comments. ADR 70 removed the inlining
// entirely, and with it that whole problem: the CSS is now a named sibling file, read by
// `namedStylesheet` above. That is also a STRICTLY better check than the old one was --
// the old marker would simply have vanished from the bytes, leaving every cascade
// assertion in this file passing against a stylesheet the archive no longer had any way
// to load.

function enableCommentMode(document) {
  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: the toggle did not turn comment mode on');
}

/** Click `el` (comment mode already on) and read back the anchor the real client
 * script minted onto `blockId`'s comment form -- test/check-http.mjs's own
 * `captureAnchor`, reused so every ref/hint fed into applySubmit below is
 * one the real gesture actually produced.
 *
 * This used to just click and
 * read the form back, never closing it first. Six of the eight captures below
 * SHARE a block (three on the markdown block, two on the html-stage blocks), so
 * they share one <form> element across calls -- a click that does NOTHING (the
 * click handler bails before ever calling openCommentForm, e.g. because buildSteps
 * failed for that particular element) left the PREVIOUS capture's ref/hint sitting
 * on the still-open form, and the old code read that back as if it were fresh: two
 * different fixture elements ended up sharing the exact same minted anchor, with
 * nothing here or in the check functions below ever noticing. Demonstrated by
 * making buildSteps return null for TD, which turned test/check-comment-mode.mjs
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

// --- fixture: one board covering every content kind, plus a lost --------------
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
      // ADR.md entry 28: a compare SIDE holding a rendered kind keeps that kind's
      // affordance -- the rule is drawn on kind, never on position. An errored
      // diagram, because its `.resolve-error` note is the one element of a mermaid
      // section the generic page-scoped gesture can reach.
      left: { label: 'Before', block: { kind: 'mermaid', source: { path: 'no-such-diagram-arch-a.mmd' } } },
      right: { label: 'After', block: { kind: 'html', html: '<div class="mock"><button>Ship it</button></div>' } },
    },
    { kind: 'html', html: '<div class="mock"><button>Launch</button></div>' },
    { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
    {
      kind: 'question',
      prompt: 'Pick one',
      widget: 'single',
      options: [{ label: 'Yes' }, { label: 'No' }],
      // ADR.md entry 28 took the affordance off the wrapper; entry 28 decides what
      // a `context` entry keeps, on its own kind. An html stage here is exactly as
      // commentable as one at the top level -- the nested case this fixture needs.
      context: [{ kind: 'html', html: '<div class="mock"><button>Confirm</button></div>' }],
    },
    // A second errored diagram, so the page-scoped half has two independent
    // targets (the markdown/code blocks used to supply four).
    { kind: 'mermaid', source: { path: 'no-such-diagram-arch-b.mmd' } },
  ],
});
const mdBlockId = board.blocks[0].id;
const codeBlockId = board.blocks[1].id;
const compareLeftId = board.blocks[2].left.block.id;
const compareRightId = board.blocks[2].right.block.id;
const stageBlockId = board.blocks[3].id;
const mermaidBlockId = board.blocks[4].id;
const questionId = board.blocks[5].id;
const questionContextId = board.blocks[5].context[0].id;
const errorDiagramId = board.blocks[6].id;

// Mint every `dom` anchor through the real gesture, in an ordinary (`http:`) live
// session -- comment mode on, one click per content kind -- exactly as a reviewer
// would produce it before this board was ever archived.
const mintHtml = renderBoardPage(board);
const mintDoc = loadBoard(mintHtml, 'http:');
enableCommentMode(mintDoc);

const errorNote = blockId => mintDoc.querySelector(`[data-block-id="${blockId}"] .resolve-error`);
const compareDiagramNote = errorNote(compareLeftId);
const standaloneDiagramNote = errorNote(errorDiagramId);
assert.ok(compareDiagramNote && standaloneDiagramNote, 'setup failure: could not find every fixture element to mint an anchor on');

const mintedPairs = [
  captureAnchor(mintDoc, compareDiagramNote, compareLeftId, 'compare-side comment'),
  captureAnchor(mintDoc, standaloneDiagramNote, errorDiagramId, 'errored-diagram comment'),
];

const frameFor = blockId => mintDoc.querySelector(`[data-block-id="${blockId}"] .html-stage`);
for (const [blockId, text] of [[compareRightId, 'compare-stage comment'], [stageBlockId, 'standalone-stage comment'], [questionContextId, 'question-context comment']]) {
  const frame = frameFor(blockId);
  assert.ok(frame, `setup failure: no html stage rendered for block ${blockId}`);
  frame.loadSrcdoc();
  mintedPairs.push(captureAnchor(mintDoc, frame.contentDocument.querySelector('button'), blockId, text));
}

for (const p of mintedPairs) {
  assert.equal(p.anchor.kind, 'dom');
  assert.ok(p.anchor.ref, `setup failure: empty ref minted for block ${p.blockId}`);
}

// Second guard: every capture
// must be genuinely distinct from every other one that shares its block -- three
// captures used to share mdBlockId's form (prose/list-item/table-cell), and the
// html-stage blocks mint through their own iframes. Two captures on the same
// block landing on the exact same (kind, ref) pair is exactly the symptom
// measured (the "table cell" and "list item" pins turning out to be the
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
  // Deliberately stale: no re-rendered block has 99 children at any depth, so this
  // can never accidentally resolve.
  { blockId: errorDiagramId, anchor: { kind: 'dom', ref: '99.99', hint: 'a sentence that used to live here' }, text: 'this used to point at something real' },
  // Comments stored against a `markdown` and a `code` block, in the
  // exact shapes a pre-ADR-28 board carries them -- a whole-block one and an
  // element-level `dom` one. Neither block renders a comment surface any more, so
  // the archive has to come out without them and without erroring on the way.
  { blockId: mdBlockId, anchor: { kind: 'block' }, text: 'ARCHIVED-MARKDOWN-BLOCK-COMMENT' },
  { blockId: mdBlockId, anchor: { kind: 'dom', ref: '2.1', hint: 'Findings' }, text: 'ARCHIVED-MARKDOWN-DOM-COMMENT' },
  { blockId: codeBlockId, anchor: { kind: 'dom', ref: '2.1', hint: 'const x = 1;' }, text: 'ARCHIVED-CODE-DOM-COMMENT' },
];
applySubmit(board, { action: 'send', answers: [], comments: submittedComments }, 1);
const mermaidCommentN = submittedComments.findIndex(c => c.text === 'diagram comment') + 1;
const lostCommentN = submittedComments.findIndex(c => c.text === 'this used to point at something real') + 1;

// --- write the finished page to a REAL file, with nothing listening, and read ---
// it back off disk -- the archive is what a reviewer double-clicks in Finder, not
// a string held in this process's memory.
//
// Through src/store.mjs's `writePage` rather than a bare `writeFileSync`, since ADR 70:
// an archive is a file plus the folder it sits in, and `writePage` is the code that puts
// the three shared siblings there. Hand-writing the page would leave a folder no browser
// could open, and this file would then be proving the Finder surface works using bytes it
// had assembled itself.

const archiveHome = mkdtempSync(path.join(tmpdir(), 'claude-board-archive-'));
const archiveDir = path.join(archiveHome, 'pages');
const archivePath = path.join(archiveDir, `${board.id}.html`);
const renderedNow = renderBoardPage(board);
writePage(board.id, renderedNow, archiveHome);
const fileContents = readFileSync(archivePath, 'utf8');
assert.equal(fileContents, renderedNow, 'setup failure: the file on disk does not match what was written');

// The script and the stylesheet this archive NAMES, read back off disk by resolving that
// bare name against the archive's own directory -- never the in-memory `ui`/`styles`
// exports. Every load and every cascade assertion below runs against these, so a page
// naming a file that is not there, or naming it in a form that does not resolve from
// Finder, fails the whole file rather than passing on payloads this process happened to
// have imported (AC 9).
const archiveScript = namedScript(archivePath, fileContents);
const archiveCss = namedStylesheet(archivePath, fileContents);

check('setup: the file actually landed on disk at a real path', () => {
  assert.ok(archivePath.startsWith(archiveDir), 'setup failure: the archive path is not under the temp dir it was written to');
  assert.equal(fileContents.length > 0, true);
});

check('archive: the sibling files the page names are really beside it on disk, and really are the shared payloads', () => {
  assert.equal(archiveScript, ui, 'the script sitting next to the archive must be the real client script, byte for byte');
  assert.equal(archiveCss, styles, 'the stylesheet sitting next to the archive must be the real stylesheet, byte for byte');
});

// The whole archive/live split is one byte-identical page ("JSON is
// truth, the page is a projection", proven at the daemon level by
// test/check-http.mjs's own "served page / pages/ file / fresh render" check): the
// SAME markup src/render.mjs emits for a live GET is what gets written to disk and
// read back here -- nothing in the bytes changes, only the branch src/ui.mjs takes
// once `location.protocol` is actually `'file:'`.

// --- load the archive exactly as Finder would: from the file's own bytes, with --
// `location.protocol` actually 'file:' -- never a hand-set `readonly` flag. -------

function loadArchive() {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  let esConstructed = false;
  globalThis.fetch = (...args) => { fetchCalled = true; return Promise.reject(new Error('the archive must never call fetch')); };
  class SpyEventSource {
    constructor() { esConstructed = true; }
  }
  // Passed through loadBoard's own `eventSource` parameter directly, never via
  // globalThis -- see loadBoard's comment on why this is one of the two callers
  // that must.
  const document = loadBoard(fileContents, 'file:', archiveScript, SpyEventSource);
  return {
    document,
    restore() { globalThis.fetch = originalFetch; },
    fetchCalled: () => fetchCalled,
    esConstructed: () => esConstructed,
  };
}

// Like loadArchive() above, but also runs src/theme.mjs's
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
  globalThis.fetch = () => Promise.reject(new Error('the archive must never call fetch'));

  const document = parseHTML(fileContents);
  const window = document.defaultView;
  if (storage) window.localStorage = storage;
  const location = { protocol: 'file:' };
  // Unlike loadArchive()/loadPageArchive(), nothing here reads back whether an
  // EventSource was constructed, so 'EventSource' is simply declared and left
  // unpassed -- same as every ordinary site in this suite -- rather than stood
  // up on globalThis: a declared parameter shadows the global either way, so a
  // stand-in left there would never be seen even if one were still assigned.
  new Function('document', 'window', 'location', 'EventSource', themeBootScript)(document, window, location);
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);
  // A freshly parsed document now starts `readyState
  // === 'loading'`, so the theme control's click listener is not wired until
  // this simulates the parser reaching the end of the document (see
  // test/dom-stand-in.mjs's own comment on finishParsing/readyState) --
  // every check below that clicks the control depends on this having run.
  document.finishParsing();

  return {
    document,
    restore() { globalThis.fetch = originalFetch; },
  };
}

// =================================================================================
// 1. Every pin in the right place, including a lost one.
// =================================================================================

check('archive: the page-scoped pins (a compare side\'s diagram, a standalone diagram) all land resolved, in their own block\'s pin-layer', () => {
  const { document, restore } = loadArchive();
  try {
    assert.equal(document.body.classList.contains('readonly'), true, 'setup failure: opening from file:// must add body.readonly');
    const pageScoped = mintedPairs.filter(p => [compareLeftId, errorDiagramId].includes(p.blockId));
    const byBlock = new Map();
    for (const p of pageScoped) byBlock.set(p.blockId, (byBlock.get(p.blockId) || 0) + 1);
    for (const [blockId, expectedCount] of byBlock) {
      const layer = pinLayerFor(document, blockId);
      // The standalone errored diagram also carries the deliberately-lost anchor's
      // own pin (see the dedicated lost-anchor check below) -- filtered out by class,
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
    assert.equal(frames.length, 3, 'setup failure: expected three html stages (compare-right, standalone, question-context)');
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
    const layer = pinLayerFor(document, errorDiagramId);
    const lostPins = layer.querySelectorAll('.anchor-pin.pin-lost');
    assert.equal(lostPins.length, 1, `expected exactly one lost pin in the errored diagram's pin-layer, got ${lostPins.length}`);
    assert.ok(String(lostPins[0].title || '').indexOf('lost: a sentence that used to live here') !== -1,
      `expected the lost pin's title to name what it lost, got ${JSON.stringify(lostPins[0].title)}`);
    assert.ok(fileContents.includes(`#${lostCommentN} · lost: a sentence that used to live here`), 'the comment list must name what the anchor lost, on the page itself');
    assert.ok(fileContents.includes('comment-lost'));
  } finally { restore(); }
});

check('archive: the diagram\'s (mermaid) comment renders resolved, by its node id -- not routed through any mermaid wiring owned elsewhere', () => {
  // Deliberately server-rendered-text only (see this file's header comment): the
  // client script's own mermaid rendering is async against an unreachable CDN and
  // not asserted here.
  assert.ok(fileContents.includes(`#${mermaidCommentN} · A`), 'the mermaid node-id comment must render resolved (its node id, not "lost: ...")');
  assert.ok(!fileContents.includes(`#${mermaidCommentN} · lost:`), 'the mermaid comment must not report lost');
});

// =================================================================================
// 2. Read-only throughout, and the toggle claim specifically.
// =================================================================================

check('archive: the claim -- the comment-mode toggle is both CSS-hidden and hard-disabled in readonly -- verified, not trusted', () => {
  // The CSS side, read directly rather than assumed.
  // The selector shares its rule with body.page-uncommentable (ADR 46's own
  // hiding of the same control on a page nobody is listening to), so match the
  // readonly selector wherever it sits in that list rather than pinning it as the
  // whole prelude.
  assert.match(styles, /body\.readonly \.mode-toggle[^{]*\{[^}]*display: none/, 'expected a body.readonly rule hiding .mode-toggle');

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

check('archive: the back-to-index control is absent, not merely disabled -- there is no daemon behind "/" in a file:// archive', () => {
  // The CSS side, read directly rather than assumed.
  assert.match(styles, /body\.readonly \.back-to-index \{[^}]*display: none/, 'expected a body.readonly rule hiding .back-to-index');

  const { document, restore } = loadArchive();
  try {
    const backLink = document.querySelector('.back-to-index');
    assert.ok(backLink, 'the control is still IN the markup (one byte-identical page, live or archived) -- readonly hides it structurally, not by omitting it');
    assert.equal(backLink.getAttribute('href'), '/', 'setup failure: expected the control to point at the thread index');
  } finally { restore(); }
});

// `body.readonly button#theme-toggle { display: inline-flex;
// }` (src/styles.mjs) is the readonly carve-out that keeps the theme control
// visible while `body.readonly .mode-toggle { display: none; }` hides every
// OTHER control wearing `.mode-toggle`'s chrome (the comment-mode toggle
// above). Nothing asserted it before this: delete that one rule and the
// theme control inherits the SAME `display: none` the comment-mode toggle
// gets, in every archive, silently -- QUIRKS.md's own "readonly is locked
// twice" entry names exactly this shape of gap. Asserted as the COMPUTED
// display (test/dom-stand-in.mjs's resolveComputedProperty),
// against the file's own <style> text and the REAL button element from a
// loaded archive -- not the rule's spelling, which is what QUIRKS.md warns
// against asserting.
check('archive: the theme control\'s COMPUTED display is inline-flex under body.readonly, not silently inheriting .mode-toggle\'s own display:none', () => {
  const cssText = archiveCss;

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
      document.querySelector('.code-block pre'),
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

check('archive: hovering inside the isolated html-stage document adds no outline, and no HOVER stylesheet is ever injected into it (QUIRKS.md "two stylesheets, one palette") -- the always-present gutter-fix reset is the one exception, and it is unconditional by design', () => {
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
    //
    // Exactly ONE style element is expected now, not zero: STAGE_MARGIN_RESET
    // (the html-stage gutter fix) is server-rendered into every srcdoc
    // unconditionally, readonly or not -- an archived board's hand-authored
    // mocks need to render edge to edge exactly as much as a live one's do, so
    // this one is never gated on comment mode the way the hover stylesheet is.
    // The property this check actually exists to pin is narrower: the HOVER
    // stylesheet specifically (the one carrying the outline/cursor rules,
    // identified by HOVER_CLASS's own name) is never among them.
    const headStyles = stageDoc.head ? stageDoc.head.children.filter(el => el.tagName === 'STYLE') : [];
    assert.equal(headStyles.length, 1, 'the stage document must carry exactly the one always-present reset style, and no other');
    assert.equal(headStyles[0].textContent, STAGE_MARGIN_RESET.replace(/^<style>|<\/style>$/g, ''),
      'the one style present must be byte-identical to the exported STAGE_MARGIN_RESET, not a hand-copied guess at it');
    assert.ok(!headStyles.some(el => el.textContent.indexOf('cb-anchor-hover') !== -1),
      'no stylesheet carrying the hover rule (HOVER_CLASS) may ever be injected into a read-only archive\'s stage');

    button.dispatchEvent(new StandInEvent('mouseover'));
    assert.equal(button.classList.contains('cb-anchor-hover'), false, 'hovering inside an archived html stage must not outline the element');
  } finally { restore(); }
});

check('archive: clicking a compare side\'s diagram, a standalone diagram, prose, a table cell or a code reference opens no comment form anywhere', () => {
  const { document, restore } = loadArchive();
  try {
    const cases = [
      document.querySelector(`[data-block-id="${compareLeftId}"] .resolve-error`),
      document.querySelector(`[data-block-id="${errorDiagramId}"] .resolve-error`),
      document.querySelectorAll('.md-content p').find(el => el.textContent.indexOf('paragraph of prose') !== -1),
      document.querySelectorAll('.md-content td').find(el => el.textContent.trim() === '42'),
      document.querySelector('.code-block pre'),
    ];
    for (const el of cases) {
      assert.ok(el, 'setup failure: a click target was not found');
      el.dispatchEvent(new StandInEvent('click'));
    }
    // Checked over the page as a whole: the markdown and code blocks render no
    // comment-form at all any more (ADR.md entry 28), so a blockId-keyed lookup
    // would find null on exactly the targets this check exists to cover.
    const anyOpen = document.querySelectorAll('.comment-form').some(f => f.classList.contains('open'));
    assert.equal(anyOpen, false, 'clicking must not open any comment form in a read-only archive');
  } finally { restore(); }
});

check('an archived board carrying stored markdown and code comments renders without them and without error', () => {
  const { document, restore } = loadArchive();
  try {
    for (const [name, blockId] of [['markdown', mdBlockId], ['code', codeBlockId]]) {
      const section = document.querySelector(`[data-block-id="${blockId}"]`);
      assert.ok(section, `setup failure: the ${name} block did not render at all`);
      assert.equal(section.querySelectorAll('.comment-item').length, 0, `a ${name} block must render no comment entries`);
      assert.equal(section.querySelectorAll('.comment-btn').length, 0, `a ${name} block must render no comment button`);
      assert.equal(section.querySelectorAll('.pin-layer').length, 0, `a ${name} block must render no pin-layer`);
      assert.equal(document.getElementById('comment-form-' + blockId), null, `a ${name} block must render no comment form`);
    }
    // The stored text appears nowhere a reviewer reads it -- asserted over the
    // rendered entries, not over the file's bytes, since the board's own JSON is
    // inlined into #board-data either way.
    const rendered = document.querySelectorAll('.comment-item').map(el => el.textContent);
    for (const gone of ['ARCHIVED-MARKDOWN-BLOCK-COMMENT', 'ARCHIVED-MARKDOWN-DOM-COMMENT', 'ARCHIVED-CODE-DOM-COMMENT']) {
      assert.equal(rendered.some(t => t.indexOf(gone) !== -1), false, `a stored comment on a markdown/code block must not render: ${gone}`);
    }
    // ...and the same archive's comments on the rendered kinds are all still there,
    // so this cannot pass against a page that dropped every comment.
    assert.ok(rendered.length >= mintedPairs.length, `the comments on html/mermaid blocks must still render, got ${rendered.length} entries`);
  } finally { restore(); }
});

// ADR.md entry 28 ("Only the rendered kinds can be commented on", 2026-08-06): this
// used to also assert that clicking the question's own `.choice-single` widget
// opened no comment form in the archive -- one more case alongside the others
// above. That assumed a comment-form existed for the question block at all,
// closed pending a click; there is now no such element, live or archived, since
// renderQuestionBlock no longer emits a commentButton/commentArea for the
// wrapper. Retired as a per-element case in the loop above (nothing there can
// distinguish "readonly disabled it" from "there was never anything to
// disable") and replaced with the structural assertion it actually reduces to:
// no comment-form exists for the question wrapper at all, in the archive same
// as live.
check('archive: a question wrapper carries no comment-form element at all -- not merely a disabled/closed one (ADR.md entry 28)', () => {
  const { document, restore } = loadArchive();
  try {
    assert.equal(document.getElementById('comment-form-' + questionId), null, 'a question block must render no comment-form of its own, in the archive same as live');
    const yes = document.querySelectorAll('.choice-single').find(el => el.textContent.indexOf('Yes') !== -1);
    assert.ok(yes, 'setup failure: no choice-single option rendered');
    yes.dispatchEvent(new StandInEvent('click'));
    assert.equal(document.getElementById('comment-form-' + questionId), null, 'clicking the question\'s own widget must not conjure a comment-form into existence either');
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
    const btn = document.querySelector(`.comment-btn[data-block-id="${mermaidBlockId}"]`);
    assert.ok(btn, 'setup failure: no block-level comment button rendered for the diagram block');
    assert.equal(btn.disabled, true);
    btn.dispatchEvent(new StandInEvent('click'));
    const form = document.getElementById('comment-form-' + mermaidBlockId);
    assert.equal(form.classList.contains('open'), false, 'the block-level comment button must not open a form in a read-only archive');
  } finally { restore(); }
});

// Was "the emitted page still has no external script or stylesheet reference" -- ADR 70
// replaced that rule with a narrower one (QUIRKS.md, "No external assets — not even
// mermaid, now three bare sibling filenames"): every reference the page loads must be
// either self-carrying (`data:`) or a bare sibling filename that really is sitting
// beside it. Both halves matter here specifically, because this board carries
// compare/html/mermaid content and nine comments -- the richest page the renderer
// emits, and the one most likely to sneak a reference to something outside the folder.
check('archive: every reference the emitted page loads resolves inside its own folder, even carrying compare/html/mermaid content and nine comments', () => {
  for (const [, tag, attrs] of fileContents.matchAll(/<(link|script|img|iframe)\b([^>]*)>/g)) {
    const m = attrs.match(/\s(?:src|href)="([^"]*)"/);
    if (!m || m[1].startsWith('data:')) continue;
    const ref = m[1];
    assert.ok(!ref.includes('/') && !ref.includes(':') && !ref.startsWith('.'),
      `<${tag}> loads "${ref}", which is not a bare sibling filename -- it cannot resolve from Finder`);
    assert.equal(readFileSync(path.join(archiveDir, ref), 'utf8').length > 0, true,
      `<${tag}> names "${ref}", which is not on disk beside the archive`);
  }
  assert.ok(archiveScript.length > 0 && archiveCss.length > 0, 'setup failure: the archive names no script or stylesheet at all');
});

// =================================================================================
// 4. Light theme: the archive follows the OS, its control still
//    works for the sitting, and nothing persists across a reopen -- spec:
//    "Follow the OS; the control still works for the sitting but persists
//    nothing." Exercised against the SAME bytes read off disk above, the same
//    way every other check in this file is: never a hand-set `readonly` flag,
//    never a constructed document standing in for the real file (this file's
//    own header comment).
// =================================================================================

// This used to assert the two light rules by their
// SPELLING -- a regex matching the literal `@media { :root:not(...) { ... } }`
// nesting and a separate `:root[data-theme="light"] { ... }` match, each
// checked for a substring. That is exactly the trap QUIRKS.md's "the
// stylesheet and the markup are checked against each other" entry warns
// against (see also the mermaid-id trap it documents): nesting the override
// INSIDE the media query -- breaking a dark-OS reader's Light choice, the one
// case this feature exists for -- still contains both substrings, so the old
// version of this check stayed green through it. Replaced with the real
// cascade resolver (test/dom-stand-in.mjs) run against the file's
// OWN `<style>` text (not the in-memory `styles` export -- if render.mjs ever
// diverged from it, this would still catch that too), asserting the full
// {OS dark, OS light} x {no attribute, data-theme="light", data-theme="dark"}
// matrix resolves to the intended palette.
check('archive: the bytes on disk carry a real, working cascade -- every (OS preference, data-theme) combination resolves to the intended palette, computed from the file\'s own <style> text, not asserted by any one rule\'s spelling', () => {
  const cssText = archiveCss;

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

// =================================================================================
// 5. Criterion 7: a PAGE board archived to disk opens from Finder with the
//    network off and shows the same artifact, not an empty frame.
//
//    Its own file, its own bytes, written and read back the same way the board
//    above is -- a page board is a different rendering of the same page
//    (src/render.mjs's isPageBoard, ADR.md entry 33), and the thing that could
//    fail here is specific to it: the artifact's markup is snapshotted INTO the
//    page at post time (entry 32), so if any of it ever became a reference to
//    something outside the file, this is where an offline reader would get a
//    blank 100vh frame instead of a page.
// =================================================================================

const pageArtifact = '<style>.doc{font:14px system-ui}</style>'
  + '<div class="doc"><h1>ARCHIVED_ARTIFACT_MARKER</h1><p id="out">unrun</p></div>'
  + '<script>document.getElementById("out").textContent = "the artifact\'s own script ran";</script>';
// Bound to a real project directory, like every board a reviewer actually
// archives: `cwd` is the one field on a board that names something about the
// machine rather than about the work, and the check below is what keeps it out
// of a file meant to be handed to someone else.
const pageBoardDoc = createBoard({ title: 'Archived artifact', cwd: archiveDir, blocks: [{ kind: 'html', html: pageArtifact }] });
const pageArchivePath = path.join(archiveDir, `${pageBoardDoc.id}.html`);
writePage(pageBoardDoc.id, renderBoardPage(pageBoardDoc), archiveHome);
const pageFileContents = readFileSync(pageArchivePath, 'utf8');
// Resolved from THIS page's own bytes, not reused from the board above: two archives in
// one folder must each name their own siblings, and a page board is a different render.
const pageArchiveScript = namedScript(pageArchivePath, pageFileContents);

function loadPageArchive() {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  let esConstructed = false;
  globalThis.fetch = () => { fetchCalled = true; return Promise.reject(new Error('the archive must never call fetch')); };
  class SpyEventSource {
    constructor() { esConstructed = true; }
  }
  // Passed through loadBoard's own `eventSource` parameter directly -- see
  // loadBoard's comment and loadArchive()'s identical call just above.
  const document = loadBoard(pageFileContents, 'file:', pageArchiveScript, SpyEventSource);
  return {
    document,
    restore() { globalThis.fetch = originalFetch; },
    fetchCalled: () => fetchCalled,
    esConstructed: () => esConstructed,
  };
}

check('criterion 7: a page board archived to disk opens from Finder as a page board, with the artifact in the frame rather than an empty one', () => {
  const { document, restore, fetchCalled, esConstructed } = loadPageArchive();
  try {
    assert.equal(document.body.classList.contains('page-board'), true,
      'the archived page board must still lay out as one -- the class is in the bytes, not applied by anything the daemon does');
    assert.equal(document.body.classList.contains('readonly'), true, 'and opening from file:// must still make it read-only');

    const frame = document.querySelector('.html-stage');
    assert.ok(frame, 'the frame itself must be in the archived bytes');
    const srcdoc = frame.getAttribute('srcdoc');
    // Read off the FRAME's own attribute, never off the raw bytes: the whole
    // board is inlined as JSON in #board-data too, so `fileContents.includes(...)`
    // is true whether or not the stage ever carried the artifact (QUIRKS.md: "A
    // rendered page contains every comment's text twice").
    assert.ok(srcdoc.includes('ARCHIVED_ARTIFACT_MARKER'),
      'the artifact\'s own markup must be inside the frame\'s srcdoc -- an archive that framed a path would open blank with the network off');
    assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0, 'with the same leading reset a live page renders');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');

    // And the artifact is live, not a picture: its own script runs from the
    // bytes on disk, with nothing listening anywhere.
    frame.loadSrcdoc();
    assert.equal(frame.contentDocument.getElementById('out').textContent, 'the artifact\'s own script ran');

    assert.equal(fetchCalled(), false, 'the archived page board must never reach the network');
    assert.equal(esConstructed(), false, 'and must open no event stream');
  } finally { restore(); }
});

check('criterion 7: the archived page board carries no local project path -- the file is the artifact, so it is the thing that gets sent to someone else', () => {
  // The whole board is inlined as JSON in #board-data (that is what makes the
  // archive standalone), and a bare spread of the board put `cwd` -- the
  // realpath'd project directory, i.e. the reader's username and their whole
  // directory layout -- into every archived file. Nothing renders it and
  // nothing reads it back, so it is pure exhaust, and criterion 7 is exactly
  // what makes it matter: the archive is now a single self-contained file that
  // IS the artifact, and therefore the natural thing to attach to a ticket.
  assert.ok(pageBoardDoc.cwd, 'setup failure: the fixture board must actually be bound to a project directory, or this check proves nothing');

  const el = parseHTML(pageFileContents).getElementById('board-data');
  assert.ok(el, 'setup failure: no #board-data payload in the archived bytes');
  const data = JSON.parse(el.textContent);
  assert.equal(data.id, pageBoardDoc.id, 'setup failure: #board-data must be this board');
  assert.equal('cwd' in data, false, 'the inlined board must not carry the local project path at all -- not null, absent');

  // And on the bytes as well as on the parsed payload: safeJson escapes, so a
  // path could ride along in a spelling the JSON parse above normalises away.
  assert.ok(!pageFileContents.includes(pageBoardDoc.cwd),
    'the archived file must not contain the project directory anywhere in its bytes');
});

check('criterion 7: every reference the archived page board loads resolves inside its own folder either', () => {
  for (const [, tag, attrs] of pageFileContents.matchAll(/<(link|script|img|iframe)\b([^>]*)>/g)) {
    const m = attrs.match(/\s(?:src|href)="([^"]*)"/);
    if (!m || m[1].startsWith('data:')) continue;
    const ref = m[1];
    assert.ok(!ref.includes('/') && !ref.includes(':') && !ref.startsWith('.'),
      `<${tag}> loads "${ref}" -- an artifact that pulled anything in from outside the folder would be a page board that opens empty from Finder`);
    assert.equal(readFileSync(path.join(archiveDir, ref), 'utf8').length > 0, true,
      `<${tag}> names "${ref}", which is not on disk beside the archive`);
  }
  // The artifact's own markup is snapshotted into the page's `srcdoc`, escaped -- so the
  // stage's `<style>`/`<script>` are attribute text, not tags, and cannot be reached by
  // the tag scan above. This is what keeps them accounted for.
  assert.ok(pageFileContents.includes('&lt;style&gt;'), 'the artifact must still be carried inline, escaped into its srcdoc');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall archive checks ok');
