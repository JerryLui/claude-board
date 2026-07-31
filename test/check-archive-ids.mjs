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

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { themeBootScript } from '../src/theme.mjs';
import { parseHTML } from './dom-stand-in.mjs';

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
      ].join('\n'),
    },
    { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
  ],
});

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

check('setup: the markdown headings actually collide with the real ids they used to shadow', () => {
  const doc = parseHTML(fileContents);
  for (const id of ['board-data', 'send-btn', 'theme-toggle']) {
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall archive id-collision checks ok');
