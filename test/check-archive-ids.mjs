// Audit 2026-07-31, findings P1 (HIGH, pre-existing)/P2/L1: every id
// src/ui.mjs and src/theme.mjs look up with `document.getElementById` --
// `board-data`, `send-btn`, `discuss-btn`, `send-status`, `theme-toggle`,
// `comment-mode-toggle`, `comment-form-<blockId>`, `comment-target-<blockId>`,
// `comment-list-<blockId>`, `blocks` -- can ALSO be minted by board content:
// src/markdown.mjs's slugify turns a heading into `id="<slug>"` on whatever
// <h1>-<h6> it sits on, with no awareness of what other ids the rest of the
// page already uses (src/markdown.mjs's own comment states the threat model:
// markdown blocks are snapshotted from arbitrary files, so one heading in a
// README or a reviewed PR is the whole capability). `## Board data` used to be
// catastrophic: `getElementById('board-data')` returned the heading instead of
// the real `<script id="board-data" type="application/json">`, `JSON.parse`
// threw on the heading's text, and the whole client IIFE died BEFORE
// `body.readonly` was ever applied -- a file:// archive then rendered with the
// read-only banner hidden, the send bar showing, and every control enabled, as
// if it were a live, writable board. `## Send btn` is a quieter variant: the
// script runs to completion, but the click handler binds to the heading
// instead of the button, and Send silently never fires.
//
// The fix (src/ui.mjs, src/theme.mjs, src/styles.mjs) tag-qualifies every one
// of these lookups (`document.querySelector('script#board-data[...]')`,
// `button#theme-toggle`, ...) instead of renaming any id: a markdown heading
// is always <h1>-<h6> and a top-level list item is always <li>, neither of
// which is ever the tag the real element carries, so the qualified selector
// can only ever match the one real element regardless of where in the
// document a colliding id happens to sit -- no dependence on which one tree
// order happens to put first.
//
// This file proves it the same way test/check-archive.mjs proves the rest of
// the archive contract: a real board, containing the exact headings that used
// to be dangerous, rendered for real, written to a REAL file on disk, read
// back off those bytes, and run through the real themeBootScript + ui client
// scripts in the real page's own order, with `location.protocol` genuinely
// `'file:'` -- never a hand-set `readonly` flag and never a hand-summary of
// what the scripts do.
//
// EXTENDED 2026-07-31 (DESIGN.md polish, post-merge): that audit swept the files
// as they stood on `direct/theme`. The polish batch landed seven MORE
// id-by-blockId lookups it never saw -- `comment-list-<blockId>` (the queued
// comment list), a second `comment-form-<blockId>` (the html-stage message
// guard), the lens's two `lensAdopt` lookups, the delete handler's
// `comment-target-<blockId>`, and `round-badge` twice (which ticket 04 also
// promoted from a <div> to a <button>) -- every one of them a bare
// getElementById. Three things guard the class of defect now rather than the
// seven instances:
//
//   1. the runtime fixture below mints EVERY one of these ids as a heading, so
//      the "scripts run to completion / the archive is still read-only" checks
//      run against all of them at once;
//   2. one live-page check drives the one whose breakage is observable in a
//      DOM stand-in at all (see its own comment on why the others are not:
//      most of these real elements sit EARLIER in tree order than any block
//      content, so a bare lookup happens to return the right element today --
//      which is precisely the tree-order dependence the fix removes);
//   3. a static sweep of all four client scripts that fails the moment a bare
//      `getElementById`, or an unqualified `#id` selector, reappears in any of
//      them. That one is the real guard: it covers lookups nobody has thought
//      to write a runtime case for, including every future one.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage, stageAgentScript } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { indexScript } from '../src/indexpage.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

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

// --- fixture: one board whose markdown mints every dangerous heading at once ---

// The markdown block is the first of its kind, so src/board.mjs mints it `d1`
// (KIND_LETTER + ordinal), the mermaid block `m1` and the question `q1` --
// which is what lets the per-block headings below name a REAL composed id
// rather than a plausible one. Asserted right after createBoard rather than
// assumed.
//
// ADR.md entry 28: the per-block comment ids (`comment-list-<id>` and friends)
// only exist on the two kinds that are still commentable, so the headings that
// have to COLLIDE with one name the mermaid block's id, not the markdown block's
// own -- the heading itself is still minted by markdown, which is the half of
// the collision this file is about (untrusted content choosing an id).
const MD_ID = 'd1';
const STAGE_ID = 'm1';

const board = createBoard({
  title: 'Ticket -- id-collision archive',
  blocks: [
    {
      kind: 'markdown',
      text: [
        '## Board data',
        '',
        'A heading that used to shadow the real `#board-data` script tag.',
        '',
        '## Send btn',
        '',
        'A heading that used to shadow the real Send button.',
        '',
        '## Theme toggle',
        '',
        'A heading that used to be styled by the unscoped `#theme-toggle` rule.',
        '',
        '## Discuss btn',
        '',
        'The other half of the send bar.',
        '',
        '## Send status',
        '',
        'The send bar\'s status line.',
        '',
        '## Comment mode toggle',
        '',
        'The gesture switch the whole comment layer hangs off.',
        '',
        '## Blocks',
        '',
        'The container every pushed round is inserted into.',
        '',
        '## Round badge',
        '',
        'DESIGN.md polish ticket 04 promoted the real one from a <div> to a <button>.',
        '',
        `## Comment list ${STAGE_ID}`,
        '',
        'The queued-comment list for the diagram below -- a composed id, minted by a heading.',
        '',
        `## Comment form ${STAGE_ID}`,
        '',
        'The comment form for the diagram below.',
        '',
        `## Comment target ${STAGE_ID}`,
        '',
        'The "commenting on:" line for the diagram below.',
      ].join('\n'),
    },
    { kind: 'mermaid', text: 'flowchart TD\n  A[Start] --> B[End]' },
    { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  ],
});

assert.equal(board.blocks[0].id, MD_ID,
  `setup failure: expected the markdown block to be minted as ${MD_ID}`);
assert.equal(board.blocks[1].id, STAGE_ID,
  `setup failure: expected the mermaid block to be minted as ${STAGE_ID}; the composed-id headings above name that id literally`);

const rendered = renderBoardPage(board);

const archiveDir = mkdtempSync(path.join(tmpdir(), 'claude-board-archive-ids-'));
const archivePath = path.join(archiveDir, `${board.id}.html`);
writeFileSync(archivePath, rendered, 'utf8');
const fileContents = readFileSync(archivePath, 'utf8');
assert.equal(fileContents, rendered, 'setup failure: the file on disk does not match what was written');

// --- load the archive exactly as Finder would (test/check-archive.mjs's own ---
// loadArchiveThemed): both real client scripts, in the real page's own order,
// against the real file's bytes, with location.protocol genuinely 'file:'.

function loadArchiveThemed(html) {
  const originalFetch = globalThis.fetch;
  const originalES = globalThis.EventSource;
  globalThis.fetch = () => Promise.reject(new Error('the archive must never call fetch'));
  class SpyEventSource {
    constructor() { /* no-op: an archive must never construct one */ }
  }
  globalThis.EventSource = SpyEventSource;

  const document = parseHTML(html);
  const window = document.defaultView;
  const location = { protocol: 'file:' };
  try {
    new Function('document', 'window', 'location', themeBootScript)(document, window, location);
    new Function('document', 'window', 'location', ui)(document, window, location);
    // Audit 2026-07-31 (H2): a freshly parsed document now starts `readyState
    // === 'loading'`, so the theme control's click listener is not wired
    // until this simulates the parser reaching the end of the document (see
    // test/dom-stand-in.mjs's own comment on finishParsing/readyState).
    document.finishParsing();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalES;
  }
  return document;
}

// =================================================================================
// 0. Setup sanity: the fixture actually reproduces the collision. If any of
//    these fail, the checks below would be proving nothing.
// =================================================================================

const COLLIDING_IDS = [
  'board-data', 'send-btn', 'discuss-btn', 'send-status', 'theme-toggle',
  'comment-mode-toggle', 'blocks', 'round-badge',
  `comment-list-${STAGE_ID}`, `comment-form-${STAGE_ID}`, `comment-target-${STAGE_ID}`,
];

check('setup: the markdown headings actually collide with the real ids they used to shadow', () => {
  const doc = parseHTML(fileContents);
  for (const id of COLLIDING_IDS) {
    const matches = doc.querySelectorAll(`[id="${id}"]`);
    assert.equal(matches.length, 2, `expected exactly 2 elements with id="${id}" (the real one + the heading), got ${matches.length}`);
    const heading = matches.find(el => /^H[1-6]$/.test(el.tagName));
    assert.ok(heading, `expected one of the two id="${id}" elements to be a heading`);
  }
});

// =================================================================================
// 1. The client script must not throw -- P1's failure mode was an uncaught
//    SyntaxError from JSON.parse on the heading's text, killing the whole IIFE.
// =================================================================================

check('archive with colliding headings: the real client scripts run to completion without throwing', () => {
  assert.doesNotThrow(() => loadArchiveThemed(fileContents),
    'themeBootScript + ui must not throw when board content mints headings that collide with board-data/send-btn/theme-toggle -- a throw here means P1\'s total-DoS regressed');
});

// =================================================================================
// 2. The archive is still genuinely read-only: body.readonly applied, and
//    every control disabled except the theme control.
// =================================================================================

check('archive with colliding headings: body.readonly is applied (hydration reached past the board-data lookup)', () => {
  const document = loadArchiveThemed(fileContents);
  assert.equal(document.body.classList.contains('readonly'), true,
    'body.readonly was never applied -- this is exactly P1\'s symptom: the script returned/threw before reaching the readonly gate, so a file:// archive would render as if it were a live, writable board');
});

check('archive with colliding headings: Send, Discuss and every answer control are hard-disabled', () => {
  const document = loadArchiveThemed(fileContents);
  const sendBtn = document.querySelector('button#send-btn');
  const discussBtn = document.querySelector('button#discuss-btn');
  assert.ok(sendBtn, 'setup failure: no real button#send-btn in the rendered page');
  assert.ok(discussBtn, 'setup failure: no real button#discuss-btn in the rendered page');
  assert.equal(sendBtn.disabled, true, 'button#send-btn must be disabled in a read-only archive');
  assert.equal(discussBtn.disabled, true, 'button#discuss-btn must be disabled in a read-only archive');

  const choices = document.querySelectorAll('.card-choice');
  assert.ok(choices.length > 0, 'setup failure: no answer widget rendered');
  choices.forEach(el => assert.equal(el.disabled, true, 'every .card-choice must be disabled in a read-only archive'));
});

check('archive with colliding headings: the theme control is the one exception, and stays live', () => {
  const document = loadArchiveThemed(fileContents);
  const themeBtn = document.querySelector('button#theme-toggle');
  assert.ok(themeBtn, 'setup failure: no real button#theme-toggle in the rendered page');
  assert.equal(themeBtn.disabled, false,
    'button#theme-toggle must stay enabled in a read-only archive -- an archive reader is exactly who needs to switch theme (src/theme.mjs)');
});

// =================================================================================
// 3. The one composed id whose collision is observable in a DOM stand-in: the
//    queued-comment list. Every OTHER real element these headings shadow
//    (script#board-data, the send bar, the mode toggle, div#blocks,
//    button#round-badge) is emitted in <head> or in .board-head -- EARLIER in
//    tree order than any block content -- so `getElementById` returns the real
//    element by luck, and no runtime assertion can tell the bare form from the
//    qualified one. div#comment-list-<blockId> is the exception: it is rendered
//    AFTER its own block's body (commentArea, src/render.mjs), so a heading
//    inside that body wins tree order outright and a bare lookup appends the
//    reviewer's queued comment to the heading instead of to the list.
//
//    This one runs on a LIVE page (location.protocol 'http:'), not the archive:
//    comment mode is the gesture under test and it does not exist in a
//    read-only archive at all.
// =================================================================================

/** The live (non-archive) page: `ui` only, exactly like test/check-comment-mode.mjs's
 * loadBoard -- the theme boot script owns nothing on this path. */
function loadLiveBoard() {
  const document = parseHTML(rendered);
  const window = document.defaultView;
  const location = { protocol: 'http:' };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

check('a queued comment lands in the real div#comment-list-<blockId>, not in a heading that minted the same id', () => {
  const document = loadLiveBoard();

  // Never document.getElementById here either: this check's own setup would
  // otherwise pick the heading and prove nothing.
  const toggle = document.querySelector('button#comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no real button#comment-mode-toggle rendered');
  toggle.dispatchEvent(new StandInEvent('click'));
  assert.equal(toggle.classList.contains('active'), true, 'setup failure: comment mode did not turn on');

  const anchorBtn = document.querySelectorAll(`.comment-btn[data-block-id="${STAGE_ID}"]`)[0];
  assert.ok(anchorBtn, 'setup failure: the mermaid block rendered no comment button');
  anchorBtn.dispatchEvent(new StandInEvent('click'));

  const form = document.querySelector(`form#comment-form-${STAGE_ID}`);
  assert.ok(form, 'setup failure: no real form#comment-form-' + STAGE_ID);
  assert.equal(form.classList.contains('open'), true, 'setup failure: the anchor button did not open the comment form');
  form.querySelector('input[type=text]').value = 'this heading is doing two jobs';
  form.dispatchEvent(new StandInEvent('submit'));

  const items = document.querySelectorAll('.comment-item.comment-pending');
  assert.equal(items.length, 1, `setup failure: expected exactly one queued comment, got ${items.length}`);

  const realList = document.querySelectorAll(`[id="comment-list-${STAGE_ID}"]`).find(el => el.tagName === 'DIV');
  const heading = document.querySelectorAll(`[id="comment-list-${STAGE_ID}"]`).find(el => /^H[1-6]$/.test(el.tagName));
  assert.ok(realList, 'setup failure: no real div#comment-list-' + STAGE_ID);
  assert.ok(heading, 'setup failure: the colliding heading is not in the live page');

  assert.equal(items[0].parentElement, realList,
    'the queued comment was appended to the wrong element -- a bare getElementById(\'comment-list-\' + blockId) in refreshPendingCommentItems returns the markdown HEADING that minted the same id, because commentArea renders the real list AFTER the block body');
  assert.equal(heading.querySelectorAll('.comment-item').length, 0,
    'the colliding heading must never receive a comment list entry');
});

// =================================================================================
// 4. The real guard: no client script may look an id up bare. This covers every
//    lookup, including ones no runtime case above can distinguish and every one
//    added from here on.
//
//    Deliberately run against the RAW source, comments included. A comment
//    stripper could only make this check quieter -- and a stripper that ate a
//    line of real code would make it silently PASS over exactly the defect it
//    exists to catch (test/check-pure.mjs's own stripJsComments carries the
//    long version of why stripping this codebase safely is hard). So the
//    failure direction is chosen instead: prose that spells a receiver call out
//    in full trips this, and the fix is to reword the comment. Every existing
//    comment about these lookups is already written so it does not.
// =================================================================================

const CLIENT_SCRIPTS = [
  ['src/ui.mjs -- ui', ui],
  ['src/theme.mjs -- themeBootScript', themeBootScript],
  ['src/render.mjs -- stageAgentScript()', stageAgentScript()],
  ['src/indexpage.mjs -- indexScript', indexScript],
];

check('no client script looks an id up bare: every getElementById is gone and every #id selector is tag-qualified', () => {
  for (const [label, src] of CLIENT_SCRIPTS) {
    const bare = src.match(/[)\]\w$]\s*\.\s*getElementById\s*\(/g) || [];
    assert.equal(bare.length, 0,
      `${label}: found ${bare.length} bare getElementById call(s). Board content is markdown snapshotted from arbitrary files, so a heading or top-level list item can mint any id this page uses (src/markdown.mjs slugify) -- use a tag-qualified querySelector instead ('form#comment-form-' + blockId, 'div#comment-list-' + blockId, 'button#round-badge', ...), matching the tag src/render.mjs actually emits`);

    // An unqualified '#id' selector has exactly the same hole as
    // getElementById: it matches whichever element comes first in tree order,
    // heading or real. A qualified one starts with a tag name.
    const unqualified = (src.match(/(?:querySelector|querySelectorAll|closest|matches)\s*\(\s*['"`]\s*#/g) || []);
    assert.equal(unqualified.length, 0,
      `${label}: found ${unqualified.length} unqualified '#id' selector(s) -- prefix the tag the element actually carries in src/render.mjs`);
  }
});

check('the sweep above would actually catch a regression (ablation on its own regexes)', () => {
  // Without this, a typo in either pattern leaves a permanently-green check
  // over an unguarded file -- this repo's own recurring failure shape.
  const bareRe = /[)\]\w$]\s*\.\s*getElementById\s*\(/;
  const unqualRe = /(?:querySelector|querySelectorAll|closest|matches)\s*\(\s*['"`]\s*#/;
  for (const sample of [
    "var el = document.getElementById('round-badge');",
    "var list = document.getElementById('comment-list-' + entry.blockId);",
    "lensAdopt(document.getElementById('comment-target-' + blockId));",
    "root.getElementById('x')",
  ]) {
    assert.match(sample, bareRe, `the bare-lookup pattern must match ${JSON.stringify(sample)}`);
  }
  for (const sample of [
    "document.querySelector('#board-data')",
    'document.querySelectorAll("#blocks")',
    "ev.target.closest('#round-badge')",
  ]) {
    assert.match(sample, unqualRe, `the unqualified-selector pattern must match ${JSON.stringify(sample)}`);
  }
  // ...and must NOT fire on the qualified forms the code actually uses, or the
  // sweep is unfailable-by-being-always-red rather than a guard.
  for (const sample of [
    "document.querySelector('form#comment-form-' + blockId)",
    "document.querySelector('button#round-badge')",
    "document.querySelector('script#board-data[type=\"application/json\"]')",
  ]) {
    assert.doesNotMatch(sample, bareRe, `the bare-lookup pattern must not fire on ${JSON.stringify(sample)}`);
    assert.doesNotMatch(sample, unqualRe, `the unqualified-selector pattern must not fire on ${JSON.stringify(sample)}`);
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall archive id-collision checks ok');
