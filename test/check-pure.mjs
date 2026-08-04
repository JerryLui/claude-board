// Pure-module check: imports src/markdown.mjs, src/board.mjs and src/render.mjs
// directly and asserts markdown-to-HTML, block splitting, anchor ids, and the packet
// shape including unanswered, deferred and notes. No network, no daemon.
//
// Extends the visualize skill's check.mjs convention (~/.claude/skills/visualize/
// check.mjs), minus its delimiter-extraction hack now that markdown.mjs is a real
// module: carries the same assertions (bold, inline code escaping, links, images,
// em, nested lists, tables, blockquotes, fenced code, mermaid fences) so the
// promotion out of the visualize template provably loses nothing, plus this
// project's own additions (anchors, packet assembly).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync, mkdirSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mdToHtml, mdToHtmlAndAnchors, slugify } from '../src/markdown.mjs';
import { createBoard, addRound, amendRound, applySubmit, buildPacket, resolveComment, findBlock, questionBlocks } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, stageAgentScript, STAGE_ACCENT_HEX, renderRefusalPage, CSP } from '../src/render.mjs';
import { sessionToken, sessionCookieMatches, SESSION_COOKIE } from '../src/secret.mjs';
import { createHandoffStore, handoffTarget, recoveryCommand, shellQuote } from '../src/handoff.mjs';
import { resolveRef, langForPath, resolvePath, resolveRefRoots, resolveBoardCwd, DEFAULT_REF_ROOTS, MAX_REF_BYTES } from '../src/resolve.mjs';
// Both used only by the reference-boundary checks (audit 2026-07-31). The descriptor
// discipline inside resolveRef is asserted by swapping the file out BETWEEN the check
// and the read, which means patching the fs namespace src/resolve.mjs imports from --
// node:module's syncBuiltinESMExports is what propagates such a patch into an ESM
// module's already-bound named imports.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ui } from '../src/ui.mjs';
import { styles, palettes, faviconLink } from '../src/styles.mjs';
import { indexScript, buildThreadIndex, renderIndexPage, folderName, roundCount } from '../src/indexpage.mjs';
import { computeBoardPatch } from '../src/patch.mjs';
import { badgeLabel } from '../src/badge.mjs';
import { lensZoomAt, lensFit, lensOneToOne } from '../src/lens.mjs';
import {
  extractHint, stepsToPath, pathToSteps, resolveSteps, buildSteps, composeHint,
  parseHtmlTree, elementText, resolveDomAnchor, resolveDomAnchorInSection,
  parseMermaidDomId, mermaidRefResolves, resolveMermaidAnchor, MERMAID_NODE_SELECTOR,
  findPendingCommentForAnchor, removePendingComment,
} from '../src/anchor.mjs';
import { parseHTML, StandInEvent } from './dom-stand-in.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack || err);
  }
}

// Fixture source files for reference-resolution checks: a dedicated temp dir
// (mkdtempSync, same convention as CLAUDE_BOARD_HOME elsewhere), cleaned up at the
// end regardless of pass/fail.
const fixturesDir = mkdtempSync(path.join(tmpdir(), 'claude-board-pure-fixtures-'));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Strip the inlined <style> block, the #board-data JSON payload, and the client
 * <script type="module"> from a rendered page, leaving only the block markup that
 * renderBlock actually emitted. Asserting against the raw page string is unsafe for
 * a block-kind-coverage check: a class name like "compare-grid" or "mermaid-block"
 * is also a CSS selector in src/styles.mjs and a querySelector string literal in
 * src/ui.mjs, and any field value on a block (a label, a snippet of prose) is also
 * present in the JSON board.blocks the page inlines verbatim for hydration -- none
 * of that proves the corresponding renderBlock case ran. Stripping all three first
 * means a needle can only be found where the renderer actually put it. */
function renderedMarkup(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<script id="board-data"[^>]*>[\s\S]*?<\/script>/, '')
    .replace(/<script type="module">[\s\S]*?<\/script>/, '');
}

// --- markdown.mjs: carried from visualize/check.mjs -------------------------------

check('mdToHtml carries the visualize renderer\'s pinned behaviour', () => {
  const out = mdToHtml([
    '# Title',
    '',
    'A **bold** move with `x < y`, about 75 % done, a [link](https://x.se) and ![alt](img.png).',
    '',
    '_Findings for MAP_AUTH.md, method census._ The `ssn_country` field and plain ssn_country stay literal, __double__ works.',
    '',
    '- one',
    '  - nested',
    '- two',
    '',
    '| H1 | H2 |',
    '|----|----|',
    '| a  | b  |',
    '',
    '> quoted',
    '',
    '```',
    'if (a < b) {}',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
  ].join('\n'));

  const expect = [
    '<strong>bold</strong>',
    '<code>x &lt; y</code>',
    'about 75 % done',
    '<a href="https://x.se">link</a>',
    '<img alt="alt" src="img.png">',
    '<em>Findings for MAP_AUTH.md, method census.</em>',
    'plain ssn_country stay literal',
    '<strong>double</strong>',
    '<ul><li id="title-li1">one<ul><li>nested</li></ul></li><li id="title-li2">two</li></ul>',
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table>',
    '<blockquote><p>quoted</p></blockquote>',
    '<pre><code>if (a &lt; b) {}</code></pre>',
    '<pre class="mermaid">flowchart LR\n  A --&gt; B</pre>',
  ];
  for (const e of expect) {
    assert.ok(out.includes(e), `missing: ${e}\ngot: ${out}`);
  }
  // heading now carries its anchor id (the promotion's one behavioural addition)
  assert.ok(out.includes('<h1 id="title">Title</h1>'));
});

// --- markdown.mjs: anchors ----------------------------------------------------------

check('one anchor per heading and per top-level list item', () => {
  const md = [
    '# Acceptance Criteria',
    '',
    '- one',
    '  - nested under one',
    '- two',
    '- three',
    '',
    '## Open Questions',
    '',
    '1. first question',
    '2. second question',
  ].join('\n');
  const { html, anchors } = mdToHtmlAndAnchors(md);

  const refs = anchors.map(a => a.ref);
  assert.deepEqual(refs, [
    'acceptance-criteria',
    'acceptance-criteria-li1',
    'acceptance-criteria-li2',
    'acceptance-criteria-li3',
    'open-questions',
    'open-questions-li1',
    'open-questions-li2',
  ]);
  assert.ok(html.includes('<h1 id="acceptance-criteria">'));
  assert.ok(html.includes('id="acceptance-criteria-li1"'));
  assert.ok(html.includes('id="acceptance-criteria-li3"'));
  // nested list items are not top-level and get no anchor id
  assert.ok(!html.includes('id="acceptance-criteria-li1-li'));
  assert.ok(!/<li id="[^"]*">nested under one/.test(html));
});

check('duplicate heading text gets a disambiguated slug', () => {
  const md = '# Notes\n\nfirst\n\n# Notes\n\nsecond';
  const { anchors } = mdToHtmlAndAnchors(md);
  assert.deepEqual(anchors.map(a => a.ref), ['notes', 'notes-2']);
});

// --- ticket 10: attribute-value escaping in the markdown renderer (security) ------
//
// markdown.mjs's `esc` covered only & < > and was never applied to attribute values
// at all -- `alt`, `src` and `href` were built by raw string concatenation, so
// `!["  onerror=alert(1) x="](y.png)` rendered a live `onerror` handler:
// `<img alt="" onerror=alert(1) x="" src="y.png">`. Content reaches this renderer by
// reference from arbitrary files on disk, so this is a real injection path, not a
// hypothetical one. Every check below asserts the dangerous construct (an
// unquoted/breaking-out attribute, a live event handler, a javascript: URL) is
// *absent* from the rendered markup, not merely that some safe substring like
// `alt=` is present -- that weaker style of assertion would still pass against the
// vulnerable renderer. (Ablation-verified: reverting the markdown.mjs fix and
// re-running this file fails every check in this section -- see the ticket log.)

// A crafted attribute value that broke out would leave the browser parsing a
// SECOND, bareword attribute on the same tag (that's exactly what "onerror=alert(1)
// x=" is: not part of alt's value, but a new onerror attribute followed by a new x
// attribute). So the general, content-independent signature of "no break-out
// happened" is that the whole opening tag is accounted for by exactly the attributes
// this renderer is supposed to emit, each value quote-delimited with no literal `"`
// inside it -- i.e. the tag matches this strict shape end to end, `>$` included. A
// looser check like "the string onerror=alert doesn't appear anywhere" is not
// enough: that substring legitimately appears, harmlessly, inside a *correctly*
// quoted attribute value (see the exact-output assertions below) or as ordinary text
// content -- it would falsely fail on safe output. Shape-matching the whole tag is
// what actually distinguishes "quoted value that happens to contain those words"
// from "a second attribute got created".
function soleTag(html, re) {
  const m = re.exec(html);
  assert.ok(m, `expected tag not found in: ${html}`);
  return m[0];
}

check('a crafted image alt cannot break out of the alt="..." attribute to inject a live handler', () => {
  const out = mdToHtml('![" onerror=alert(1) x="](y.png)');
  const tag = soleTag(out, /<img[^]*?>/);
  assert.ok(/^<img alt="[^"]*" src="[^"]*">$/.test(tag), `img tag is not exactly alt+src, a live attribute leaked in: ${tag}`);
  assert.equal(out, '<p><img alt="&quot; onerror=alert(1) x=&quot;" src="y.png"></p>');
});

check('a crafted image src cannot break out of the src="..." attribute to inject a live handler', () => {
  const out = mdToHtml('![alt](y.png"onerror=alert(1)x=")');
  const tag = soleTag(out, /<img[^]*?>/);
  assert.ok(/^<img alt="[^"]*" src="[^"]*">$/.test(tag), `img tag is not exactly alt+src, a live attribute leaked in: ${tag}`);
  assert.equal(out, '<p><img alt="alt" src="y.png&quot;onerror=alert(1">x=")</p>');
});

check('a crafted link url cannot break out of the href="..." attribute to inject a live handler', () => {
  const out = mdToHtml('[t](https://x.se/"onmouseover=alert(1)x=")');
  const tag = soleTag(out, /<a[^]*?>/);
  assert.ok(/^<a href="[^"]*">$/.test(tag), `a tag is not exactly href, a live attribute leaked in: ${tag}`);
  assert.equal(out, '<p><a href="https://x.se/&quot;onmouseover=alert(1">t</a>x=")</p>');
});

check('a crafted heading cannot break out of the id="..." attribute its anchor slug is rendered into', () => {
  const md = '# " onmouseover=alert(1) x="\n\n- " onmouseover=alert(1) y="';
  const { html, anchors } = mdToHtmlAndAnchors(md);
  const h1 = soleTag(html, /<h1[^]*?>/);
  const li = soleTag(html, /<li[^]*?>/);
  assert.ok(/^<h1 id="[^"]*">$/.test(h1), `h1 tag is not exactly id, a live attribute leaked in: ${h1}`);
  assert.ok(/^<li id="[^"]*">$/.test(li), `li tag is not exactly id, a live attribute leaked in: ${li}`);
  assert.equal(html, '<h1 id="onmouseoveralert1-x">" onmouseover=alert(1) x="</h1>' +
    '<ul><li id="onmouseoveralert1-x-li1">" onmouseover=alert(1) y="</li></ul>');
  // the slug itself only ever contains [a-z0-9-] -- slugify strips everything else
  // before the id attribute is even built, so the anchor ref used for comment
  // resolution (src/board.mjs, src/render.mjs data-anchor-ref) is equally clean.
  assert.ok(anchors.every(a => /^[a-z0-9-]+$/.test(a.ref)));
});

check('a javascript: link URL is neutralised, not rendered as a live href', () => {
  const out = mdToHtml('[t](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(out), `javascript: URL rendered live: ${out}`);
  assert.equal(out, '<p><a href="#">t</a>)</p>');
});

check('a javascript: image src is neutralised, not rendered as a live src', () => {
  const out = mdToHtml('![alt](javascript:alert(1))');
  assert.ok(!/src="javascript:/i.test(out), `javascript: URL rendered live: ${out}`);
  assert.equal(out, '<p><img alt="alt" src="">)</p>');
});

check('a data: image src is neutralised too -- the allowlist is http(s)/mailto/relative/fragment, not a javascript:-only denylist', () => {
  const out = mdToHtml('![alt](data:text/html,<script>alert(1)</script>)');
  assert.ok(!/src="data:/i.test(out), `data: URL rendered live: ${out}`);
});

check('http, https, mailto, relative and fragment URLs still render as live links -- the javascript: fix does not neuter ordinary markdown', () => {
  assert.equal(mdToHtml('[h](https://x.se/path)'), '<p><a href="https://x.se/path">h</a></p>');
  assert.equal(mdToHtml('[m](mailto:a@b.com)'), '<p><a href="mailto:a@b.com">m</a></p>');
  assert.equal(mdToHtml('[r](/a/b)'), '<p><a href="/a/b">r</a></p>');
  assert.equal(mdToHtml('[f](#sec)'), '<p><a href="#sec">f</a></p>');
});

// --- board.mjs: block normalisation, rounds, packet assembly ----------------------

check('createBoard mints ids, renders markdown blocks, and starts round 1', () => {
  const board = createBoard({
    title: 'Ticket 01 review',
    blocks: [
      { kind: 'markdown', text: '# Acceptance Criteria\n\n- one\n- two' },
      {
        kind: 'question',
        prompt: 'Ship it?',
        widget: 'single',
        options: [{ label: 'Yes' }, { label: 'No', description: 'not yet' }],
        context: [{ kind: 'markdown', text: '# Context\n\nsome prose' }],
      },
    ],
  });

  assert.match(board.id, /^b_[0-9a-f]{32}$/);
  assert.match(board.thread, /^th_[0-9a-f]{8}$/);
  assert.equal(board.rounds.length, 1);
  assert.equal(board.rounds[0].status, 'open');
  assert.equal(board.blocks.length, 2);

  const md = board.blocks[0];
  assert.equal(md.kind, 'markdown');
  assert.equal(md.id, 'd1');
  assert.equal(md.round, 1);
  assert.ok(md.html.includes('<h1 id="acceptance-criteria">'));
  assert.equal(md.anchors.length, 3);
  assert.equal(typeof md.sha, 'string');
  assert.equal(md.sha.length, 64);

  const q = board.blocks[1];
  assert.equal(q.kind, 'question');
  assert.equal(q.id, 'q1');
  assert.equal(q.context.length, 1);
  assert.equal(q.context[0].kind, 'markdown');
  assert.equal(q.context[0].id, 'd2'); // ids stay ordinal across nested context too
});

check('addRound continues the id sequence and adds an open round', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# A' }] });
  const round2 = addRound(board, { blocks: [{ kind: 'markdown', text: '# B' }] });
  assert.equal(round2, 2);
  assert.equal(board.rounds.length, 2);
  assert.equal(board.rounds[1].status, 'open');
  assert.equal(board.blocks[1].id, 'd2');
  assert.equal(board.blocks[1].round, 2);
});

check('every round stores its own title, and an amend refines it without ever blanking it', () => {
  // `ask` requires a non-empty title on every call and commands/grill.md tells the
  // agent to make it the branch name. Destructuring only `blocks` threw it away on
  // every round after the first. (Ablation: drop `title` from the round object in
  // addRound and the second assertion below reads '' -- with nothing else failing,
  // which is precisely how this stayed broken while the suite was green.)
  const board = createBoard({ title: 'feat/one', blocks: [{ kind: 'markdown', text: '# A' }] });
  assert.equal(board.rounds[0].title, 'feat/one', 'round 1 carries the title too, not just the board');

  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'markdown', text: '# B' }], title: 'fix/two' });
  assert.equal(board.rounds[1].title, 'fix/two');
  assert.equal(board.title, 'feat/one', 'the board title stays what the thread was opened with');

  amendRound(board, { blocks: [{ kind: 'markdown', text: '# C' }] });
  assert.equal(board.rounds[1].title, 'fix/two', 'an amend naming no title must not blank the label on screen');
  amendRound(board, { blocks: [{ kind: 'markdown', text: '# D' }], title: 'fix/two-renamed' });
  assert.equal(board.rounds[1].title, 'fix/two-renamed');

  // A round posted without one falls back to the board title rather than a bare number.
  addRound(board, { blocks: [{ kind: 'markdown', text: '# E' }] });
  assert.equal(board.rounds[2].title, 'feat/one');
});

// --- ticket 04: amending a still-open round, and the additive-push patch --------

check('amendRound appends a new block into the still-open round without minting round 2', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# A' }] });
  const result = amendRound(board, { blocks: [{ kind: 'markdown', text: '# B' }] });
  assert.equal(result.round, 1);
  assert.deepEqual(result.blockIds, ['d2']);
  assert.equal(board.rounds.length, 1, 'no new round is minted by an amend');
  assert.equal(board.rounds[0].status, 'open');
  assert.equal(board.blocks.length, 2);
  assert.equal(board.blocks[1].round, 1);
});

check('amendRound replaces a block in place when the incoming block carries an existing id', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# Original' }] });
  const originalId = board.blocks[0].id;
  const result = amendRound(board, { blocks: [{ id: originalId, kind: 'markdown', text: '# Replaced' }] });
  assert.deepEqual(result.blockIds, [originalId]);
  assert.equal(board.blocks.length, 1, 'a replace must not append a duplicate block');
  assert.ok(board.blocks[0].text.includes('Replaced'));
});

check('amendRound throws once the open round has already been sent (use addRound instead)', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# A' }] });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  assert.throws(() => amendRound(board, { blocks: [{ kind: 'markdown', text: '# B' }] }));
});

check('amendRound refuses to hijack a block id that belongs to a different, already-sent round', () => {
  // Ablation: reverting the `board.blocks[idx].round !== openRound.n` guard in
  // src/board.mjs back to a bare `idx !== -1` makes this pass instead of throw,
  // and the block silently moves rounds -- exactly the corruption this guards.
  const board = createBoard({
    title: 't',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  const q1 = board.blocks[0].id;
  applySubmit(board, { action: 'send', answers: [{ id: q1, status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'markdown', text: '# Round Two' }] });

  assert.throws(
    () => amendRound(board, { blocks: [{ id: q1, kind: 'question', prompt: 'Hijacked', widget: 'single', options: [{ label: 'Yes' }] }] }),
    /cannot amend/,
  );
  // and the board is untouched by the rejected attempt
  const stillQ1 = board.blocks.find(b => b.id === q1);
  assert.equal(stillQ1.round, 1);
  assert.equal(stillQ1.prompt, 'Ship it?');
});

check('a caller-supplied block id must match the minted id shape; anything else is rejected rather than accepted verbatim', () => {
  // Ablation: this closes the same vector as the amend-hijack guard above from a
  // different angle -- an id containing DOM-selector-breaking characters (which
  // src/ui.mjs's amend-lookup interpolates into a CSS attribute selector) is
  // rejected at mint time rather than trusted through to the browser.
  assert.throws(
    () => createBoard({ title: 't', blocks: [{ id: 'not a real id', kind: 'markdown', text: '# A' }] }),
    /invalid block id/,
  );
  assert.throws(
    () => createBoard({ title: 't', blocks: [{ id: 'd1"], .block[data-block-id="x', kind: 'markdown', text: '# A' }] }),
    /invalid block id/,
  );
  // a well-formed, minted-shaped id is still accepted (this is the legitimate
  // amend "replace this exact block" path)
  const board = createBoard({ title: 't', blocks: [{ id: 'd7', kind: 'markdown', text: '# A' }] });
  assert.equal(board.blocks[0].id, 'd7');
});

check('computeBoardPatch: a round push is additive -- the prior round\'s blocks are never reported as added or changed', () => {
  const before = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# Round One' }] });
  const round1BlockId = before.blocks[0].id;
  applySubmit(before, { action: 'send', answers: [], comments: [] }, 1);
  const after = JSON.parse(JSON.stringify(before));
  const round2 = addRound(after, { blocks: [{ kind: 'markdown', text: '# Round Two' }] });

  const patch = computeBoardPatch(before, after);
  // Ablation: computing this by diffing the two board objects wholesale (e.g.
  // "anything JSON.stringify'd differently") rather than per-block ids would flag
  // round 1's block here too, since board.updatedAt/rounds also changed.
  assert.ok(!patch.addedBlockIds.includes(round1BlockId));
  assert.ok(!patch.changedBlockIds.includes(round1BlockId));
  assert.equal(patch.changedBlockIds.length, 0);
  assert.equal(patch.addedBlockIds.length, 1);
  assert.notEqual(patch.addedBlockIds[0], round1BlockId);
  assert.deepEqual(patch.roundsNewlyOpen, [round2]);
  assert.deepEqual(patch.roundsNowSent, []);
});

check('computeBoardPatch: a submit flips exactly that round from open to sent, and reports no added blocks', () => {
  const board = createBoard({
    title: 't',
    blocks: [{ kind: 'question', prompt: 'Q', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  const before = JSON.parse(JSON.stringify(board));
  applySubmit(board, { action: 'send', answers: [{ id: board.blocks[0].id, choice: 'Yes' }], comments: [] }, 1);
  const patch = computeBoardPatch(before, board);
  assert.deepEqual(patch.roundsNowSent, [1]);
  assert.deepEqual(patch.roundsNewlyOpen, []);
  assert.deepEqual(patch.addedBlockIds, []);
});

check('computeBoardPatch: an amend that replaces one block reports only that block as changed', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# Original' }] });
  const originalId = board.blocks[0].id;
  const before = JSON.parse(JSON.stringify(board));
  amendRound(board, { blocks: [{ id: originalId, kind: 'markdown', text: '# Replaced content' }] });
  const patch = computeBoardPatch(before, board);
  assert.deepEqual(patch.changedBlockIds, [originalId]);
  assert.deepEqual(patch.addedBlockIds, []);
});

check('the exact function embedded in ui.mjs (via .toString()) is executable and behaves identically to the imported one', () => {
  // Proves the toString()-splicing mechanism itself, not just that the text
  // "function computeBoardPatch(" appears somewhere: a hand-copied, silently
  // drifted reimplementation would satisfy a bare substring check but fail this.
  const rehydrated = new Function('return (' + computeBoardPatch.toString() + ')')();
  const before = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# A' }] });
  const after = JSON.parse(JSON.stringify(before));
  addRound(after, { blocks: [{ kind: 'markdown', text: '# B' }] });
  assert.deepEqual(rehydrated(before, after), computeBoardPatch(before, after));
});

check('ui.mjs embeds the literal source of computeBoardPatch, not a hand-copied reimplementation', () => {
  assert.ok(
    ui.includes(computeBoardPatch.toString()),
    'the client script must contain the exact function source, so the unit-tested implementation and the browser copy can never drift apart',
  );
});

// Ticket 03 / criterion 6: the same computeBoardPatch technique, applied to the
// hint-composition rule test/check-comment-mode.mjs's criterion-6 checks exercise
// end to end. An earlier draft got this specifically wrong: src/anchor.mjs
// carried a design COMMENT describing the rule but no actual code, so reverting
// that file changed nothing any check could see -- exactly the "looks right,
// believed correct, not actually exercised" shape DESIGN.md exists to
// repair. This check is what makes that regression loud again if it recurs: a
// hand-edit of ui.mjs's embedded copy that diverges from src/anchor.mjs's real
// composeHint fails here even before any behavioural check would notice.
check('ui.mjs embeds the literal source of composeHint, not a hand-copied reimplementation', () => {
  assert.ok(
    ui.includes(composeHint.toString()),
    'the client script must contain the exact function source, so criterion 6\'s hint rule and the browser copy can never drift apart',
  );
});

check('composeHint: identity alone outside a compare, matching ticket 02\'s plain html-stage hint unchanged', () => {
  assert.equal(composeHint('Send', 'button', false, '', ''), 'Send');
  assert.equal(composeHint('Send', 'button', false, '', 'html'), 'Send', 'blockKind alone (no compare ancestor) must never add context');
  assert.equal(composeHint('Total', 'td', false, '', 'markdown'), 'Total', 'a plain table cell carries no role word and no context');
});

check('composeHint: identity + role word + context inside a compare, the criterion-6 shape', () => {
  assert.equal(composeHint('Send', 'button', true, 'After', 'html'), 'Send button in After stage');
  assert.equal(composeHint('old copy', 'p', true, 'Before', 'markdown'), 'old copy in Before block');
});

check('composeHint: a compare side with its own label left blank still counts as "inside a compare" (insideCompare, not a truthy label, is the signal)', () => {
  assert.equal(composeHint('Send', 'button', true, '', 'html'), 'Send button in stage');
});

check('composeHint: falls back to a role word, then the bare tag name, for an element with no text', () => {
  assert.equal(composeHint('', 'img', false, '', ''), 'image');
  assert.equal(composeHint('', 'button', true, 'After', 'html'), 'button in After stage');
  assert.equal(composeHint('', 'div', false, '', ''), 'div', 'a tag with no role word in the table falls back to its own bare name');
});

// Audit C6: `ROLE_WORD[tag]`/`BLOCK_NOUN[blockKind]` had no `hasOwnProperty`
// guard, so a tag/blockKind of 'constructor' (or any other Object.prototype
// member name) walked the prototype chain instead of missing the lookup --
// returning the `Object` CONSTRUCTOR FUNCTION as the "role word"/"block noun",
// which JSON.stringify then silently drops (`undefined`) when the anchor is
// persisted, or stringifies into "function Object() { [native code] }" once
// concatenated into a longer hint.
check('composeHint: C6 regression -- a tag or blockKind of "constructor" (or any other Object.prototype member) must never leak a function into the hint', () => {
  const bare = composeHint('', 'constructor', false, '', '');
  assert.equal(typeof bare, 'string', 'composeHint must always return a string');
  assert.equal(bare, 'constructor', 'an unrecognised tag falls back to its own bare name, not Object.prototype.constructor');

  const withContext = composeHint('Send', 'constructor', true, 'After', 'html');
  assert.equal(typeof withContext, 'string');
  assert.equal(withContext, 'Send in After stage', 'no role word for an unrecognised tag, and no leaked function/native-code text');
  assert.doesNotMatch(withContext, /native code|function Object/);

  const badBlockKind = composeHint('x', 'span', true, 'A', 'constructor');
  assert.equal(typeof badBlockKind, 'string');
  assert.equal(badBlockKind, 'x in A block', 'an unrecognised blockKind (including "constructor") degrades to the same "block" fallback as any other unknown kind');
});

check('composeHint: every block-kind noun the ticket names, and an unknown kind degrades to "block" rather than throwing', () => {
  assert.equal(composeHint('x', 'span', true, 'A', 'html'), 'x in A stage');
  assert.equal(composeHint('x', 'span', true, 'A', 'mermaid'), 'x in A diagram');
  assert.equal(composeHint('x', 'span', true, 'A', 'code'), 'x in A reference');
  assert.equal(composeHint('x', 'span', true, 'A', 'question'), 'x in A question');
  assert.equal(composeHint('x', 'span', true, 'A', 'compare'), 'x in A comparison');
  assert.equal(composeHint('x', 'span', true, 'A', 'markdown'), 'x in A block');
  assert.equal(composeHint('x', 'span', true, 'A', 'nonsense-kind'), 'x in A block');
});

// Ticket 04 / criterion 7-8 (DESIGN.md polish): the round badge's label, the same
// toString()-splicing technique again -- see src/badge.mjs's own file comment for
// why `round ${rounds.length}` (the old, position-blind label) was a real bug,
// not a wording nitpick.

check('the exact badgeLabel embedded in ui.mjs (via .toString()) is executable and behaves identically to the imported one', () => {
  const rehydrated = new Function('return (' + badgeLabel.toString() + ')')();
  assert.equal(rehydrated(1, 1), badgeLabel(1, 1));
  assert.equal(rehydrated(2, 3), badgeLabel(2, 3));
});

check('ui.mjs embeds the literal source of badgeLabel, not a hand-copied reimplementation', () => {
  assert.ok(
    ui.includes(badgeLabel.toString()),
    'the client script must contain the exact function source, so the checked behaviour and the browser copy can never drift apart',
  );
});

check('badgeLabel: a single-round board reads "round 1 of 1", never just "round 1"', () => {
  // The exact case the old label got wrong in the other direction (it would have
  // read "round 1" here, which is not the bug -- the bug was a two-round board
  // reading "round 2" throughout). Pinned anyway: it is the cheapest case to get
  // right and the easiest to get wrong with an off-by-one on `total`.
  assert.equal(badgeLabel(1, 1), 'round 1 of 1');
});

check('badgeLabel: the post-push shape -- M grows, N (the round still in view) does not', () => {
  // Criterion 8: a round arriving over SSE grows `total` immediately; the
  // reviewer's own read position (`current`) is untouched by that arrival. Two
  // independent numbers, so a one-argument implementation ("round N of N") would
  // pass the 1-of-1 case above and fail here.
  assert.equal(badgeLabel(1, 2), 'round 1 of 2');
  assert.equal(badgeLabel(2, 2), 'round 2 of 2');
});

// Ticket 05 / criterion 10 (DESIGN.md polish): the diagram lens's view math, the
// same toString()-splicing technique a third time -- see src/lens.mjs's own file
// comment. Each of these is held to an arithmetic invariant rather than to a
// remembered constant, which is the only way "scroll zooms" can be checked
// without a browser at all: the FEEL of a zoom is entirely "did the thing under
// my cursor stay under my cursor".

check('the exact lens view math embedded in ui.mjs (via .toString()) is executable and behaves identically to the imported functions', () => {
  const zoom = new Function('return (' + lensZoomAt.toString() + ')')();
  const fit = new Function('return (' + lensFit.toString() + ')')();
  const one = new Function('return (' + lensOneToOne.toString() + ')')();
  assert.deepEqual(zoom({ x: 10, y: 20, s: 1 }, 100, 50, 2, 0.1, 8), lensZoomAt({ x: 10, y: 20, s: 1 }, 100, 50, 2, 0.1, 8));
  assert.deepEqual(fit(800, 600, 1600, 400), lensFit(800, 600, 1600, 400));
  assert.deepEqual(one(800, 600, 1600, 400), lensOneToOne(800, 600, 1600, 400));
});

check('ui.mjs embeds the literal source of lensZoomAt/lensFit/lensOneToOne, not hand-copied reimplementations', () => {
  for (const fn of [lensZoomAt, lensFit, lensOneToOne]) {
    assert.ok(
      ui.includes(fn.toString()),
      `the client script must contain the exact source of ${fn.name}, so the checked behaviour and the browser copy can never drift apart`,
    );
  }
});

check('lensZoomAt: the canvas point under the cursor is still under the cursor after the zoom -- the invariant that makes scroll-to-zoom feel like zooming', () => {
  // A canvas-local point p renders at view.x + view.s * p (transform-origin is
  // the canvas's own top-left -- src/styles.mjs's .lens-canvas). Pick a cursor
  // position, work out which canvas point is under it, zoom, and demand that the
  // SAME canvas point still renders there.
  const before = { x: -240, y: 90, s: 1.75 };
  const [px, py] = [512, 301];
  const pointUnder = { x: (px - before.x) / before.s, y: (py - before.y) / before.s };
  for (const factor of [1.4, 1 / 1.4, 4, 0.25]) {
    const after = lensZoomAt(before, px, py, factor, 0.1, 8);
    const nowAt = { x: after.x + after.s * pointUnder.x, y: after.y + after.s * pointUnder.y };
    assert.ok(Math.abs(nowAt.x - px) < 1e-9, `zoom by ${factor} moved the point under the cursor horizontally: ${nowAt.x} !== ${px}`);
    assert.ok(Math.abs(nowAt.y - py) < 1e-9, `zoom by ${factor} moved the point under the cursor vertically: ${nowAt.y} !== ${py}`);
  }
});

check('lensZoomAt: the same invariant holds AT the clamp, so a zoom that cannot go further is a no-op rather than a pan', () => {
  // The failure this rules out is specific and easy to write: clamp the scale but
  // derive the pan from the UNCLAMPED factor, and every wheel notch past the
  // limit slides the diagram sideways while the percentage readout sits still.
  const at = { x: -40, y: -70, s: 8 };
  const [px, py] = [400, 250];
  const clamped = lensZoomAt(at, px, py, 3, 0.1, 8);
  assert.equal(clamped.s, 8, 'scale must not pass the maximum');
  assert.deepEqual(clamped, { x: at.x, y: at.y, s: 8 }, 'a zoom that hits the clamp must not move the diagram at all');
  const floor = { x: 11, y: 12, s: 0.1 };
  assert.deepEqual(lensZoomAt(floor, px, py, 0.25, 0.1, 8), { x: 11, y: 12, s: 0.1 });
});

check('lensFit puts the whole diagram inside the stage and centres it, and never magnifies one that already fits', () => {
  // Wider than tall against a squarer stage: the width is what binds.
  const wide = lensFit(800, 600, 1600, 400);
  assert.equal(wide.s, 0.5);
  assert.ok(wide.x >= 0 && wide.y >= 0, 'a fitted diagram never starts off the top or left of the stage');
  assert.ok(wide.x + 1600 * wide.s <= 800 + 1e-9, 'the fitted diagram must end inside the stage horizontally');
  assert.ok(wide.y + 400 * wide.s <= 600 + 1e-9, 'the fitted diagram must end inside the stage vertically');
  assert.equal(wide.x, (800 - 1600 * wide.s) / 2, 'centred horizontally');
  assert.equal(wide.y, (600 - 400 * wide.s) / 2, 'centred vertically');
  // Taller than wide: the height binds instead.
  assert.equal(lensFit(800, 600, 400, 2400).s, 0.25);
  // Already smaller than the stage: fit is not "fill" -- a two-node flowchart
  // blown up to a 27" display is not what the control is for.
  const small = lensFit(1200, 900, 300, 200);
  assert.equal(small.s, 1);
  assert.equal(small.x, 450);
  assert.equal(small.y, 350);
});

check('lensFit clamps into the SAME band lensZoomAt does, so the first wheel-out on a very tall diagram cannot zoom IN (finding D7)', () => {
  // The defect, stated as arithmetic: a 400x24000 flowchart fits an 800x600
  // stage at 0.025, well below lensZoomAt's 0.1 floor. Wheel out from there and
  // `Math.max(min, s * factor)` returns 0.1 -- a LARGER scale than the view
  // started at, so the control zooms in when asked to zoom out. Only reachable
  // on diagrams big enough to need the lens in the first place.
  const unclamped = lensFit(800, 600, 400, 24000);
  assert.ok(unclamped.s < 0.1, 'setup: with no floor this diagram fits below the zoom floor');
  const wheelOut = lensZoomAt(unclamped, 400, 300, 0.9, 0.1, 8);
  assert.ok(wheelOut.s > unclamped.s, 'setup: which is exactly why zooming OUT from there moves the scale UP');

  const fitted = lensFit(800, 600, 400, 24000, 0.1, 8);
  assert.equal(fitted.s, 0.1, 'fit must not land below the floor the wheel is clamped to');
  assert.deepEqual(lensZoomAt(fitted, 400, 300, 0.9, 0.1, 8), { x: fitted.x, y: fitted.y, s: 0.1 },
    'and from a clamped fit, a wheel-out is a no-op rather than a zoom in the wrong direction');

  // The cap stays a cap whatever `max` says -- "fit never magnifies" is a
  // separate decision from how far the wheel may go.
  assert.equal(lensFit(1200, 900, 300, 200, 0.1, 8).s, 1, 'fit must still never magnify, even with max 8');
  // ...and the pre-clamp call shape is untouched, so every other caller and
  // every assertion above it reads exactly as it did.
  assert.deepEqual(lensFit(800, 600, 1600, 400), lensFit(800, 600, 1600, 400, 0, 1));
});

check('lensOneToOne shows the diagram at exactly 100% and centred, going negative when it is bigger than the stage', () => {
  assert.deepEqual(lensOneToOne(800, 600, 400, 200), { x: 200, y: 200, s: 1 });
  // The case the "fit" formula would get wrong if 1:1 were implemented as a fit
  // with the scale forced to 1: a diagram larger than the stage must be centred
  // on its middle (negative offsets), not pinned to the stage's top-left.
  const big = lensOneToOne(800, 600, 2000, 1400);
  assert.equal(big.s, 1);
  assert.ok(big.x < 0 && big.y < 0, 'a 1:1 view of an oversized diagram centres on its middle');
  assert.equal(big.x + 2000 / 2, 400, 'the diagram\'s centre sits at the stage\'s centre horizontally');
  assert.equal(big.y + 1400 / 2, 300, 'the diagram\'s centre sits at the stage\'s centre vertically');
});

check('packet shape names board, round, and every question status/choice/note', () => {
  const board = createBoard({
    title: 'Widget check',
    blocks: [
      { kind: 'markdown', text: '# Acceptance Criteria\n\n- one\n- two' },
      { kind: 'question', prompt: 'Answered?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
      { kind: 'question', prompt: 'Untouched?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] },
      { kind: 'question', prompt: 'Deferred?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] },
    ],
  });

  applySubmit(board, {
    action: 'send',
    answers: [
      { id: 'q1', status: 'answered', choice: 'Yes', note: 'looks good' },
      { id: 'q3', status: 'deferred', choice: null, note: 'ask later' },
      // q2 deliberately left out -> must come back explicitly unanswered
    ],
    comments: [
      { blockId: 'd1', anchor: { kind: 'md', ref: 'acceptance-criteria-li2', label: 'two' }, text: 'criterion 2 needs work' },
      { blockId: 'd1', anchor: { kind: 'md', ref: 'acceptance-criteria-li9', label: 'ghost' }, text: 'anchor that no longer exists' },
      { blockId: 'q1', anchor: { kind: 'block' }, text: 'whole-block comment' },
    ],
  }, 1);

  const packet = buildPacket(board, 1, 'http://127.0.0.1:7391/b/' + board.id);

  assert.equal(packet.board, board.id);
  assert.equal(packet.thread, board.thread);
  assert.equal(packet.round, 1);
  assert.equal(packet.status, 'submitted');
  assert.equal(packet.answers.length, 3);

  const byId = Object.fromEntries(packet.answers.map(a => [a.id, a]));
  assert.equal(byId.q1.status, 'answered');
  assert.equal(byId.q1.choice, 'Yes');
  assert.equal(byId.q1.note, 'looks good');
  assert.equal(byId.q2.status, 'unanswered');
  assert.equal(byId.q2.choice, null);
  assert.equal(byId.q2.note, ''); // note always present, '' when empty
  assert.equal(byId.q3.status, 'deferred');
  assert.equal(byId.q3.note, 'ask later');

  assert.equal(packet.comments.length, 3);
  const resolved = packet.comments.find(c => c.anchor.ref === 'acceptance-criteria-li2');
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.blockKind, 'markdown');
  assert.equal(resolved.lost, undefined);

  const lost = packet.comments.find(c => c.anchor.ref === 'acceptance-criteria-li9');
  assert.equal(lost.resolved, false);
  assert.equal(lost.lost, 'acceptance-criteria-li9');

  const blockLevel = packet.comments.find(c => c.blockId === 'q1');
  assert.equal(blockLevel.resolved, true);
  assert.equal(blockLevel.anchor.kind, 'block');
});

check('a comment whose block no longer exists reports what it lost, not silently drops', () => {
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '# A\n\nprose' }] });
  board.comments.push({ n: 1, blockId: 'd99', anchor: { kind: 'block' }, text: 'orphaned', createdAt: new Date().toISOString(), round: 1 });
  const resolved = resolveComment(board, board.comments[0]);
  assert.equal(resolved.resolved, false);
  assert.equal(resolved.lost, 'd99');
  assert.equal(findBlock(board, 'd99'), null);
});

// --- src/anchor.mjs: element-level anchoring, pure (ticket 06) --------------------
//
// Click gestures themselves need a browser and are explicitly out of scope for the
// automated checks (DESIGN.md Testing); src/anchor.mjs is the seam that carries
// every bit of anchoring logic that *isn't* the gesture -- path building, hint
// extraction, path resolution, mermaid id round-tripping -- so it can be proven
// here without simulating a DOM. src/ui.mjs's click handlers are a thin duplicate
// of these same functions (necessarily: the served page has no import graph at
// runtime, see ticket 05's standalone-archive guarantee), exercised only by hand.

check('extractHint collapses whitespace and caps length, never inventing a coordinate', () => {
  assert.equal(extractHint('  Send   \n  Message  '), 'Send Message');
  assert.equal(extractHint(''), '');
  assert.equal(extractHint(null), '');
  const long = 'x'.repeat(120);
  const hint = extractHint(long);
  assert.ok(hint.length <= 80);
  assert.ok(hint.endsWith('…'));
});

check('stepsToPath / pathToSteps round-trip a dom path, and pathToSteps degrades malformed input to empty rather than throwing', () => {
  assert.equal(stepsToPath([2, 1, 3]), '2.1.3');
  assert.deepEqual(pathToSteps('2.1.3'), [2, 1, 3]);
  assert.deepEqual(pathToSteps(''), []);
  assert.deepEqual(pathToSteps(null), []);
  assert.deepEqual(pathToSteps('2.garbage.3'), [2, 3]); // non-numeric segment dropped, not thrown
  assert.deepEqual(pathToSteps('2.0.3'), [2, 3]); // 0 is not a valid 1-based index
});

// A plain object tree stands in for a real DOM element here -- both just need a
// `.children` array, which is the whole point of the shared shape (see
// src/anchor.mjs's file comment): resolveSteps/buildSteps don't know or care which
// one they're walking.
function el(tag, children) {
  return { tag, children: children || [] };
}

check('buildSteps and resolveSteps are exact inverses of each other over a plain node tree', () => {
  const target = el('button');
  const tree = el('body', [
    el('div', [el('span'), target]),
    el('div'),
  ]);
  target.parentElement = tree.children[0];
  tree.children[0].parentElement = tree;
  tree.children[1].parentElement = tree;

  const steps = buildSteps(tree, target);
  assert.deepEqual(steps, [1, 2]); // 1st child of body, 2nd child of that div
  assert.equal(resolveSteps(tree, steps), target);
});

check('buildSteps refuses to anchor a click that landed outside the given root', () => {
  const root = el('body', [el('div')]);
  root.children[0].parentElement = root;
  const outsider = el('span'); // detached: no parentElement chain back to root
  assert.equal(buildSteps(root, outsider), null);
});

check('resolveSteps reports null the moment a step no longer resolves -- the "this anchor is lost" case, structurally', () => {
  const tree = el('body', [el('div', [el('span')])]);
  assert.equal(resolveSteps(tree, [1, 1]), tree.children[0].children[0]);
  assert.equal(resolveSteps(tree, [1, 2]), null); // that div only has one child
  assert.equal(resolveSteps(tree, [9]), null); // body doesn't have 9 children
});

// --- parseHtmlTree / elementText: the "just enough" html structure walk -----------
//
// An earlier draft validated a `dom` anchor by testing whether the hint appeared
// ANYWHERE in the raw html string, never touching `ref` at all. That both
// false-resolved (a hint matching a class name or tag name) and false-"lost"
// (nested markup, entities, or extractHint's own truncation ellipsis broke the
// contiguous-substring match) -- caught by audit, see DESIGN.md's board slice
// 06 log. These checks pin the fix: ref must actually address an element, and only
// that element's own text is checked against the hint.

check('parseHtmlTree builds an element tree where .children is element-only (matching real Element.children, not childNodes)', () => {
  const root = parseHtmlTree('<div>a<span>b</span>c</div>');
  assert.equal(root.children.length, 1); // one element child: div
  const div = root.children[0];
  assert.equal(div.tag, 'div');
  assert.equal(div.children.length, 1); // text nodes "a"/"c" are not counted here
  assert.equal(div.children[0].tag, 'span');
});

check('elementText reconstructs textContent in document order across mixed text/element children', () => {
  const root = parseHtmlTree('<button>Click <span>me</span> now</button>');
  const button = root.children[0];
  assert.equal(elementText(button), 'Click me now'); // not "Click nowme"
});

check('parseHtmlTree decodes the five named entities plus numeric character references', () => {
  const root = parseHtmlTree('<p>Save &amp; Exit &#38; &#x26;</p>');
  assert.equal(elementText(root.children[0]), 'Save & Exit & &');
});

check('parseHtmlTree treats script/style bodies as opaque -- a "<" inside them is never mistaken for a tag, and the element itself is KEPT so sibling indices match the browser', () => {
  const root = parseHtmlTree('<div><script>if (a < b) {}</script><p>real</p></div>');
  const div = root.children[0];
  // The browser keeps <script> as an element child, so every following sibling's
  // index depends on it being counted here too. Deleting it (the old behaviour)
  // shifted <p> from index 2 to index 1 server-side, and a stored ref of "1.2"
  // then resolved to nothing -- a live element reported lost.
  assert.equal(div.children.length, 2);
  assert.equal(div.children[0].tag, 'script');
  assert.equal(elementText(div.children[0]), ''); // body blanked, never parsed as markup
  assert.equal(div.children[1].tag, 'p');
  assert.equal(elementText(div), 'real'); // the script source is not part of the text
});

check('parseHtmlTree ignores an unmatched closing tag rather than throwing', () => {
  assert.doesNotThrow(() => parseHtmlTree('<div></span><p>ok</p></div>'));
  const root = parseHtmlTree('<div></span><p>ok</p></div>');
  assert.equal(elementText(root.children[0]), 'ok');
});

// --- resolveDomAnchor: ref AND hint both have to agree ----------------------------

check('resolveDomAnchor resolves when ref addresses an element whose own text contains the hint', () => {
  const html = '<div class="mock"><button>Send</button></div>';
  assert.ok(resolveDomAnchor(html, '1.1', 'Send')); // div is 1, button is div's 1st child
  assert.equal(resolveDomAnchor(html, '9.9', 'Send'), false); // ref addresses nothing
});

check('resolveDomAnchor rejects a hint that only matches an attribute value or tag name, not real text -- the false-resolve an earlier draft had', () => {
  const html = '<div class="mock"><button>Send</button></div>';
  assert.equal(resolveDomAnchor(html, '1.1', 'mock'), false); // "mock" is a class value, not button's text
  assert.equal(resolveDomAnchor(html, '1.1', 'div'), false); // "div" is a tag name, not button's text
});

// Audit 2026-07-29, finding C1: `domIdentityHintMatches` ended
// `return normalizedHint.startsWith(normalizedIdentity)`, checking the
// relationship backwards -- a live element whose text is a literal PREFIX of
// some unrelated stored hint satisfied `startsWith` by coincidence, resolving
// the comment onto the wrong element rather than reporting it lost. These are
// the three rows the director measured true (should be false) on HEAD before
// the fix; see this check's own name for the row each assertion locks in.
check('resolveDomAnchor: C1 regression -- a stored hint that merely STARTS WITH the live element\'s text must not resolve (the inverted prefix check\'s false-positive)', () => {
  assert.equal(resolveDomAnchor('<div class="mock"><button>S</button></div>', '1.1', 'Send'), false,
    'row 1: button text "S" is a prefix of stored hint "Send" -- must not resolve');
  assert.equal(resolveDomAnchor('<div class="mock"><div></div></div>', '1.1', 'div is broken'), false,
    'row 2: an empty <div>\'s bare-tag-name identity "div" is a prefix of stored hint "div is broken" -- must not resolve');
  assert.equal(resolveDomAnchor('<div class="mock"><button></button></div>', '1.1', 'button me'), false,
    'row 3: an empty <button>\'s role-word identity "button" is a prefix of stored hint "button me" -- must not resolve');
});

check('resolveDomAnchor resolves across nested markup and HTML entities in the hinted element\'s text -- the false-lost an earlier draft had', () => {
  const html = '<div><button>Click <span>me</span></button><p>A &amp; B</p></div>';
  assert.ok(resolveDomAnchor(html, '1.1', 'Click me')); // button, text spans a nested <span>
  assert.ok(resolveDomAnchor(html, '1.2', 'A & B')); // p, text contains a real entity
});

check('resolveDomAnchor tolerates extractHint\'s own truncation ellipsis on a long hint', () => {
  const longText = 'x'.repeat(120);
  const html = `<div><p>${longText}</p></div>`;
  const truncated = extractHint(longText); // ends in an ellipsis, per extractHint's own contract
  assert.ok(truncated.endsWith('…'));
  assert.ok(resolveDomAnchor(html, '1.1', truncated));
});

check('resolveDomAnchor requires a non-empty hint, and degrades to false rather than throwing on malformed input', () => {
  const html = '<div><button>Send</button></div>';
  assert.equal(resolveDomAnchor(html, '1.1', ''), false);
  assert.equal(resolveDomAnchor(html, '1.1', null), false);
  assert.equal(resolveDomAnchor(html, '', 'Send'), false);
  assert.equal(resolveDomAnchor(html, null, 'Send'), false);
  assert.doesNotThrow(() => resolveDomAnchor('<div><unclosed>', '1.1', 'Send'));
});

// Audit 2026-07-29, finding C2: a browser parses `srcdoc` as a full document
// and hoists a leading <style>/<script>/<meta>/<link>/<title>/<base> into
// <head>, so `document.body`'s first child is the mock's own top-level
// element, not the style tag -- exactly what src/ui.mjs mints every ref
// against. `resolveDomAnchor` used to resolve against parseHtmlTree's raw
// synthetic root instead, which kept the leading <style> as a body sibling and
// shifted every following index by one: the browser-minted ref reported LOST,
// and the UNHOISTED ref one index later resolved instead. Both director
// measurements from the audit, now inverted.
check('resolveDomAnchor: C2 regression -- a leading <style> before the mock\'s real content must not shift ref indices', () => {
  const html = '<style>.mock{font:14px system-ui}</style><div class="mock"><button>Send</button></div>';
  assert.equal(resolveDomAnchor(html, '1.1', 'Send'), true,
    'what a real browser mints (body.children[0] is the div, unaffected by the hoisted <style>) must resolve');
  assert.equal(resolveDomAnchor(html, '2.1', 'Send'), false,
    'the pre-fix off-by-one ref (treating <style> as body.children[0]) must NOT resolve');
});

check('resolveDomAnchor: C2 -- an explicit top-level <body> and a full <!doctype html> document are both modelled the same way', () => {
  const withBody = '<style>.mock{color:red}</style><body><div class="mock"><button>Send</button></div></body>';
  assert.equal(resolveDomAnchor(withBody, '1.1', 'Send'), true);

  const fullDoc = '<!doctype html><html><head><meta charset="utf-8"><style>.mock{color:red}</style></head><body><div class="mock"><button>Send</button></div></body></html>';
  assert.equal(resolveDomAnchor(fullDoc, '1.1', 'Send'), true);

  // A <style> AFTER real body content has already started is an ordinary body
  // child, not hoisted -- only a LEADING run is head-only.
  const styleAfterContent = '<div class="mock"><button>Send</button></div><style>.mock{color:red}</style>';
  assert.equal(resolveDomAnchor(styleAfterContent, '1.1', 'Send'), true);
  assert.equal(resolveDomAnchor(styleAfterContent, '2', 'style'), true,
    'a <style> AFTER real content has already started stays an ordinary body child at its real index, not hoisted');
});

// --- mermaid ---------------------------------------------------------------------

check('parseMermaidDomId recovers the source-declared node id from mermaid\'s own generated element id, not an invented scheme', () => {
  // The shape mermaid 11 -- the version the page's CDN tag actually pins -- emits:
  // the node id is PREFIXED with the diagram's own svg id. These four are copied
  // verbatim from a real browser rendering test/fixtures/mermaid-real-ids.json's
  // source; a regex anchored at ^flowchart- returns null for every one of them,
  // which is what left the diagram gesture dead in every browser while this file
  // stayed green against the bare ids below.
  assert.equal(parseMermaidDomId('mermaid-1785397890978-flowchart-shim-0'), 'shim');
  assert.equal(parseMermaidDomId('mermaid-1785397890978-flowchart-daemon-1'), 'daemon');
  assert.equal(parseMermaidDomId('mermaid-1785397890978-flowchart-page-3'), 'page');
  assert.equal(parseMermaidDomId('mermaid-1785397890978-flowchart-submit-5'), 'submit');
  // A node id that itself contains a hyphen still round-trips under the prefix.
  assert.equal(parseMermaidDomId('mermaid-1785397890978-flowchart-check-out-7'), 'check-out');
  // mermaid 10's bare form stays supported: an archived board holds whatever its
  // own render produced, and must keep resolving after this change.
  assert.equal(parseMermaidDomId('flowchart-A-3'), 'A');
  assert.equal(parseMermaidDomId('flowchart-checkoutButton-12'), 'checkoutButton');
  assert.equal(parseMermaidDomId('some-other-id'), null); // doesn't match the flowchart-<id>-<seq> shape
  assert.equal(parseMermaidDomId(''), null);
  // Not every id containing the word is a node: the sequence suffix is required.
  assert.equal(parseMermaidDomId('mermaid-123-flowchart-noSequence'), null);
});

check('mermaidRefResolves traces a ref back to the diagram source, and reports false for a ref the source never declared', () => {
  const source = 'flowchart LR\n  A[Start] --> B[End]';
  assert.ok(mermaidRefResolves(source, 'A'));
  assert.ok(mermaidRefResolves(source, 'B'));
  assert.equal(mermaidRefResolves(source, 'Z'), false);
  assert.equal(mermaidRefResolves(source, ''), false);
});

check('mermaidRefResolves does not false-negative on chained arrows or inline-label edges -- what the old arrow-grammar regex got wrong', () => {
  // A --> B --> C: an earlier regex-based id extractor only ever captured the first
  // two ids in a chain and lost the tail (audit-caught, see ticket 06's log).
  const chained = 'flowchart LR\n  A --> B --> C';
  assert.ok(mermaidRefResolves(chained, 'A'));
  assert.ok(mermaidRefResolves(chained, 'B'));
  assert.ok(mermaidRefResolves(chained, 'C'), 'the tail of a chained arrow must still resolve');

  // A -- yes --> B: mermaid's inline-label edge syntax (not the `-->|label|` pipe
  // form) -- the old regex mistook the label word itself for a node id.
  const inlineLabel = 'flowchart LR\n  A -- yes --> B';
  assert.ok(mermaidRefResolves(inlineLabel, 'A'));
  assert.ok(mermaidRefResolves(inlineLabel, 'B'));
});

check('mermaidRefResolves runs in linear time even against a large, adversarial-shaped source -- no catastrophic backtracking', () => {
  // The old arrow-chain regex had measured catastrophic backtracking on input like
  // this (audit-caught: 10s+ at 160KB). A plain indexOf-based scan must stay fast.
  const adversarial = 'A-'.repeat(50000);
  const start = Date.now();
  const result = mermaidRefResolves(adversarial, 'nonexistent-ref');
  assert.equal(result, false);
  assert.ok(Date.now() - start < 1000, 'mermaidRefResolves must not exhibit exponential/quadratic blowup on adversarial input');
});

// --- src/board.mjs resolveComment: the lost-anchor treatment extended to dom and --
// mermaid anchors (it already covered md and block; see the check above and
// PROTOCOL.md "Anchors at headings and list items").

check('resolveComment resolves a dom anchor whose ref+hint are still valid together, and reports lost for one that never matched', () => {
  const board = createBoard({
    title: 'dom anchor',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
  });
  const blockId = board.blocks[0].id;
  board.comments.push(
    { n: 1, blockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'move this left', createdAt: new Date().toISOString(), round: 1 },
    { n: 2, blockId, anchor: { kind: 'dom', ref: '9.9', hint: 'Launch' }, text: 'stale anchor', createdAt: new Date().toISOString(), round: 1 },
    { n: 3, blockId, anchor: { kind: 'dom', ref: '1.1', hint: 'mock' }, text: 'ref right, hint is actually a class name', createdAt: new Date().toISOString(), round: 1 },
  );
  const resolved = resolveComment(board, board.comments[0]);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.blockKind, 'html');
  assert.equal(resolved.lost, undefined);

  const lost = resolveComment(board, board.comments[1]);
  assert.equal(lost.resolved, false);
  // Ticket 04: a lost `dom` anchor reports the stored HINT ("Launch"), not the
  // opaque index-chain ref ("9.9") -- the hint is what a human or agent can
  // actually recognise as "what this comment was about" once the element it
  // named is gone (DESIGN.md ticket 04: "the stored hint is what
  // survives when the element does not"). An `md`/`mermaid` anchor's ref is
  // already human-legible (a heading slug, a diagram node id), so those still
  // report their ref -- see the checks below for mermaid and check-http.mjs for
  // md.
  assert.equal(lost.lost, 'Launch');

  const wrongHint = resolveComment(board, board.comments[2]);
  assert.equal(wrongHint.resolved, false, 'a right ref with a hint that only matches an attribute value must not resolve');
});

check('resolveComment resolves a mermaid anchor whose node id is still in the diagram source, and reports lost for one that never was', () => {
  const board = createBoard({
    title: 'mermaid anchor',
    blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' }],
  });
  const blockId = board.blocks[0].id;
  board.comments.push(
    { n: 1, blockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'rename this node', createdAt: new Date().toISOString(), round: 1 },
    { n: 2, blockId, anchor: { kind: 'mermaid', ref: 'Ghost' }, text: 'stale anchor', createdAt: new Date().toISOString(), round: 1 },
  );
  const resolved = resolveComment(board, board.comments[0]);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.blockKind, 'mermaid');

  const lost = resolveComment(board, board.comments[1]);
  assert.equal(lost.resolved, false);
  assert.equal(lost.lost, 'Ghost');
});

// --- ticket 05: resolveMermaidAnchor's precedence -- generic first, node id ---
// leaned on as a fallback, per DESIGN.md's "Mermaid stops being the
// template" -- see src/anchor.mjs's "ticket 05 design" comment for the full
// reasoning. Direct, pure tests over resolveMermaidAnchor itself (not just
// through resolveComment/board.mjs) so the precedence is checkable and
// ablatable in one place, plus a resolveComment-level check right after
// proving the same precedence survives the real server-side call site.
//
// A mermaid block's server-rendered section never contains the live SVG a
// click actually landed in (rendering is client-side, from the CDN -- see this
// file's own header comment), so resolveDomAnchorInSection can only ever find
// an element that was ALREADY in that server-rendered markup -- there is no
// diagram node there to find. To construct the "generic resolves" half of the
// fallback deliberately (not just leave it unreachable), these tests point
// `domRef` at the `.stage-wrap` element every mermaid section's server-rendered
// markup does contain (path "2" -- section's children are [kicker, stage-wrap,
// ...comment area]), with a hint derived from ITS text (which is just its
// `pre.mermaid` child's diagram-source text, `.stage-wrap` itself carrying
// none), not a diagram node's. That is not how a real click mints a mermaid
// anchor (a click always lands on a live SVG node, never on the stage
// wrapper) -- it is a deliberate, honest construction that exercises
// resolveDomAnchorInSection succeeding on its own terms, so the precedence
// test proves the ORDER, not just that the id fallback happens to always win
// because the generic half can never succeed in this codebase today.
//
// `pre.mermaid` itself (audit V3, ticket 08) is excluded from the resolution
// surface -- the same chrome exclusion src/ui.mjs's click listener already
// applies (ANCHOR_CHROME_SELECTOR lists `pre.mermaid` precisely because a real
// click there is handled by wireMermaidBlock's own listener, never this
// generic path) -- so it can no longer stand in for "the one element the
// server-rendered markup contains" the way it used to; `.stage-wrap`, one
// level up, is not chrome and serves the same constructive purpose.
{
  const mermaidBoard = createBoard({
    title: 'ticket 05 -- mermaid anchor precedence',
    blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' }],
  });
  const mermaidBlock = mermaidBoard.blocks[0];
  const mermaidSectionHtml = renderBlock(mermaidBlock, mermaidBoard, new Map(), false);
  const mermaidSectionRoot = parseHtmlTree(mermaidSectionHtml).children[0];
  const stageWrapNode = resolveSteps(mermaidSectionRoot, pathToSteps('2'));
  assert.ok(stageWrapNode && (stageWrapNode.cls || []).includes('stage-wrap'),
    'setup failure: "2" must address the mermaid block\'s own <div class="stage-wrap"> element');
  const preHint = extractHint(elementText(stageWrapNode));
  // Sanity check the construction itself before relying on it below -- the same
  // discipline test/check-anchor-rerender.mjs's own "contrast" check uses.
  assert.equal(resolveDomAnchorInSection(mermaidSectionHtml, '2', preHint), true,
    'setup failure: the deliberately-constructed generic ref must actually resolve against the pre.mermaid element');

  check('resolveMermaidAnchor: the generic reference does not resolve, the node id does -- the anchor survives', () => {
    const anchor = { kind: 'mermaid', ref: 'A', domRef: '99.99', hint: 'nowhere in this section' };
    assert.equal(resolveDomAnchorInSection(mermaidSectionHtml, anchor.domRef, anchor.hint), false, 'setup failure: domRef must NOT resolve for this case');
    assert.equal(mermaidRefResolves(mermaidBlock.text, anchor.ref), true, 'setup failure: ref must resolve for this case');
    assert.equal(resolveMermaidAnchor(mermaidSectionHtml, mermaidBlock.text, anchor), true,
      'the node id must carry the anchor when the generic reference no longer resolves');
  });

  check('resolveMermaidAnchor: the reverse -- the generic reference resolves, the node id does not -- the anchor still survives', () => {
    const anchor = { kind: 'mermaid', ref: 'Ghost', domRef: '2', hint: preHint };
    assert.equal(resolveDomAnchorInSection(mermaidSectionHtml, anchor.domRef, anchor.hint), true, 'setup failure: domRef must resolve for this case');
    assert.equal(mermaidRefResolves(mermaidBlock.text, anchor.ref), false, 'setup failure: ref must NOT resolve for this case');
    assert.equal(resolveMermaidAnchor(mermaidSectionHtml, mermaidBlock.text, anchor), true,
      'the generic reference must carry the anchor on its own, genuinely tried first -- not merely because the node id happens to agree');
  });

  check('resolveMermaidAnchor: neither the generic reference nor the node id resolve -- the anchor is lost, and reports what it lost', () => {
    const anchor = { kind: 'mermaid', ref: 'Ghost', domRef: '99.99', hint: 'nowhere in this section' };
    assert.equal(resolveMermaidAnchor(mermaidSectionHtml, mermaidBlock.text, anchor), false,
      'an anchor whose generic reference AND node id are both stale must not resolve');

    mermaidBoard.comments.push({ n: 1, blockId: mermaidBlock.id, anchor, text: 'stale both ways', createdAt: new Date().toISOString(), round: 1 });
    const resolved = resolveComment(mermaidBoard, mermaidBoard.comments[0]);
    assert.equal(resolved.resolved, false);
    assert.equal(resolved.lost, 'nowhere in this section', 'a lost mermaid anchor with a hint must report the hint (ticket 04\'s lostLabel rule), not the bare node id');
  });

  check('resolveComment: a mermaid anchor with domRef/hint that resolves generically, but a node id that does not, still resolves through the real server-side call site', () => {
    const okBoard = createBoard({
      title: 'ticket 05 -- resolveComment reaches the generic half too',
      blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' }],
    });
    const okBlock = okBoard.blocks[0];
    okBoard.comments.push({
      n: 1, blockId: okBlock.id,
      anchor: { kind: 'mermaid', ref: 'Ghost', domRef: '2', hint: preHint },
      text: 'generic half carries this one', createdAt: new Date().toISOString(), round: 1,
    });
    const resolved = resolveComment(okBoard, okBoard.comments[0]);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.lost, undefined);
  });
}

// --- audit V3: the block's own chrome must never be inside the resolution surface --

check('resolveDomAnchorInSection: V3 regression -- a ref addressing a markdown block\'s own kicker chrome must not resolve, even with a matching hint', () => {
  const board = createBoard({ title: 'V3', blocks: [{ kind: 'markdown', text: '# Notes\n\nSome text.' }] });
  const sectionHtml = renderBlock(board.blocks[0], board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  const kicker = resolveSteps(sectionRoot, pathToSteps('1'));
  assert.ok(kicker && (kicker.cls || []).includes('block-kicker'), 'setup failure: "1" must address the block-kicker chrome');
  const kickerHint = extractHint(elementText(kicker));
  // Sanity: the chrome element's own identity really is what a forged ref would
  // need to claim to pass domIdentityHintMatches on its own terms.
  assert.ok(kickerHint, 'setup failure: the kicker must carry some text to construct a plausible forged hint from');
  assert.equal(resolveDomAnchorInSection(sectionHtml, '1', kickerHint), false,
    'a ref into the block-kicker must never resolve, no matter how well the hint matches its text');
});

check('resolveComment: V3 regression -- a forged dom anchor stored against a block\'s own chrome (the audit\'s own measured shape) reports lost, not resolved', () => {
  const board = createBoard({ title: 'V3 end to end', blocks: [{ kind: 'markdown', text: '# Notes\n\nSome text.' }] });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send', answers: [],
    comments: [{ blockId, anchor: { kind: 'dom', ref: '1', hint: 'Markdown comment' }, text: 'forged' }],
  }, 1);
  assert.equal(resolveComment(board, board.comments[0]).resolved, false,
    'a dom anchor into a markdown block\'s own kicker (its comment-button text) must not resolve');
});

check('resolveMermaidAnchor: V3 regression -- a forged domRef into the block\'s own chrome (the audit\'s own measured shape: a nonexistent node id, domRef "1") never carries the anchor, only mermaidRefResolves can', () => {
  const board = createBoard({ title: 'V3 mermaid', blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' }] });
  const block = board.blocks[0];
  const sectionHtml = renderBlock(block, board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  const kicker = resolveSteps(sectionRoot, pathToSteps('1'));
  assert.ok(kicker && (kicker.cls || []).includes('block-kicker'), 'setup failure: "1" must address the block-kicker chrome');
  const kickerHint = extractHint(elementText(kicker));
  const anchor = { kind: 'mermaid', ref: 'NODE_THAT_NEVER_EXISTED', domRef: '1', hint: kickerHint };
  assert.equal(resolveDomAnchorInSection(sectionHtml, anchor.domRef, anchor.hint), false,
    'domRef "1" addresses the block-kicker, which is chrome -- must not resolve even with a matching hint');
  assert.equal(resolveMermaidAnchor(sectionHtml, block.text, anchor), false,
    'with domRef excluded and the node id never declared in source, the anchor must be lost, not silently resolved via the generic half');
});

// --- applySubmit: an untrusted anchor is sanitised, not stored verbatim (V3) --

check('applySubmit: an anchor with an unrecognised kind degrades to a whole-block comment rather than being stored verbatim', () => {
  const board = createBoard({ title: 'sanitize kind', blocks: [{ kind: 'markdown', text: '# Notes' }] });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send', answers: [],
    comments: [{ blockId, anchor: { kind: 'sql-injection', ref: '1; DROP TABLE boards' }, text: 'x' }],
  }, 1);
  assert.deepEqual(board.comments[0].anchor, { kind: 'block' });
});

check('applySubmit: a dom/md/mermaid anchor with a non-string or missing ref degrades to a whole-block comment', () => {
  const board = createBoard({ title: 'sanitize ref', blocks: [{ kind: 'markdown', text: '# Notes' }] });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send', answers: [],
    comments: [
      { blockId, anchor: { kind: 'dom', ref: { toString: () => '1' }, hint: 'Notes' }, text: 'object ref' },
      { blockId, anchor: { kind: 'dom', hint: 'Notes' }, text: 'missing ref' },
      { blockId, anchor: { kind: 'md' }, text: 'missing ref, md' },
    ],
  }, 1);
  for (const c of board.comments) assert.deepEqual(c.anchor, { kind: 'block' });
});

check('applySubmit: a comment naming a blockId that is not a real block on the board is dropped, not stored', () => {
  const board = createBoard({ title: 'sanitize blockId', blocks: [{ kind: 'markdown', text: '# Notes' }] });
  applySubmit(board, {
    action: 'send', answers: [],
    comments: [
      { blockId: 'ghost99', anchor: { kind: 'block' }, text: 'no such block' },
      { blockId: board.blocks[0].id, anchor: { kind: 'block' }, text: 'real block' },
    ],
  }, 1);
  assert.equal(board.comments.length, 1, 'only the comment naming a real block must be stored');
  assert.equal(board.comments[0].text, 'real block');
});

// --- audit U5: a dom anchor must not survive its block's kind changing under it --

// NOTE on reachability: `resolveBlockId` (above in this file) already refuses
// an incoming block whose `kind` doesn't match its `id`'s own kind-letter
// prefix (`{id:'h1', kind:'markdown', ...}` throws "does not start with the
// 'h' letter"), on every normalizeBlock path amendRound uses -- so the exact
// "amendRound swaps a block's kind at the same id" mechanism the audit
// describes is NOT reachable through the normal write path today; a block's
// kind is permanently fixed by its own id once minted. The fixture below
// constructs the shape by direct mutation instead of through amendRound, to
// prove resolveComment's OWN guard is correct defense-in-depth regardless --
// against a hand-edited store file, or any future change elsewhere that
// relaxes that constraint -- matching the symmetry the `mermaid` branch's own
// `block.kind === 'mermaid' &&` guard already has, unconditionally, for the
// same reason.
check('resolveComment: U5 regression -- a dom anchor whose block\'s kind no longer matches the kind it was minted against reports lost, not resolved against the new shape by coincidence', () => {
  const board = createBoard({
    title: 'U5',
    // Two top-level children in the iframe body, so ref "2.1" (not "1.1") is
    // what a real click on "Send" mints -- deliberately NOT index "1", which a
    // page-scoped section's own chrome (block-kicker) always occupies, so this
    // fixture isolates U5's own guard from V3's separate chrome exclusion
    // rather than being caught by it instead.
    blocks: [{ kind: 'html', html: '<div class="deco"></div><div class="mock"><button>Send</button></div>' }],
  });
  const blockId = board.blocks[0].id;
  const htmlSectionHtml = board.blocks[0].html;
  assert.equal(resolveDomAnchor(htmlSectionHtml, '2.1', 'Send'), true, 'setup failure: the ref must resolve against the original html');

  // A comment minted while the block was still 'html' -- pushed directly, the
  // same way this file's own mermaid-precedence and nested-compare fixtures
  // construct a specific stored shape, standing in for what a real click ->
  // (queued, not yet sent) -> Send would have produced against the live DOM at
  // click time (mintBlockKind records the block's kind AT THAT MOMENT).
  board.comments.push({
    n: 1, blockId, anchor: { kind: 'dom', ref: '2.1', hint: 'Send' }, text: 'about the button',
    createdAt: new Date().toISOString(), round: 1, mintBlockKind: 'html',
  });

  // The block at this SAME id is now some other kind -- a well-formed markdown
  // block, minted normally on a throwaway board, then spliced in directly
  // (see this check's own NOTE above for why not through amendRound). Its own
  // heading text is chosen so an UNGUARDED dom branch would coincidentally
  // resolve "2.1" (md-content's own first, non-chrome child) against it too.
  const donor = createBoard({ title: 'donor', blocks: [{ kind: 'markdown', text: '# Send' }] });
  board.blocks[0] = { ...donor.blocks[0], id: blockId, round: board.blocks[0].round };
  assert.equal(findBlock(board, blockId).kind, 'markdown', 'setup failure: the block must genuinely be a different kind at the same id');
  const newSectionHtml = renderBlock(findBlock(board, blockId), board, new Map(), false);
  assert.equal(resolveDomAnchorInSection(newSectionHtml, '2.1', 'Send'), true,
    'setup failure: "2.1" must coincidentally address the new heading\'s text so this fixture actually exercises the collision, not just an out-of-range ref');
  assert.equal(resolveComment(board, board.comments[0]).resolved, false,
    'a dom anchor minted against the block when it was "html" must not be resolved against its "markdown" replacement, even though "2.1" coincidentally addresses matching text there');
});

check('resolveComment: a dom anchor with no recorded mintBlockKind (a pre-ticket-08 comment) resolves exactly as before -- the guard is backward compatible', () => {
  const board = createBoard({ title: 'U5 backcompat', blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }] });
  const blockId = board.blocks[0].id;
  // Hand-built, bypassing applySubmit, exactly like an older archive's stored
  // JSON would be -- no mintBlockKind field at all.
  board.comments.push({ n: 1, blockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'old comment', createdAt: new Date().toISOString(), round: 1 });
  assert.equal(resolveComment(board, board.comments[0]).resolved, true);
});

// --- audit U4 (routed to ticket 08's resolver-side half by the director) ------
//
// An 'html' block has two client-side roots but resolveComment used to assume
// only one: `.html-stage` (the iframe) is chrome, reached only through
// wireHtmlStage's own listener, which mints a ref rooted at the iframe's
// `contentDocument.body`. `.stage-wrap` (the div THAT WRAPS the iframe) is NOT
// chrome, so a click on its own boundary -- padding around the iframe, never
// landing inside the sandboxed document -- is caught by the generic
// page-scoped listener instead, which mints a ref rooted at the block's own
// SECTION, the same as every other block kind. This locks in that
// resolveComment now tries both roots for an 'html' block, not just the
// iframe one.
check('resolveComment: U4 regression -- a dom anchor rooted at an html block\'s own SECTION (a click on .stage-wrap, not chrome, never landing inside the sandboxed iframe) still resolves, not just an iframe-body-rooted one', () => {
  const board = createBoard({ title: 'U4', blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }] });
  const blockId = board.blocks[0].id;
  const sectionHtml = renderBlock(board.blocks[0], board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  // block-kicker(1), stage-wrap(2){iframe, pin-layer}, comment-target(3)... --
  // "2" addresses .stage-wrap itself (el === root of the click, i.e. the
  // wrapper div, carrying no visible text of its own since an iframe's
  // sandboxed content never contributes to the OUTER document's textContent).
  const stageWrap = resolveSteps(sectionRoot, pathToSteps('2'));
  assert.ok(stageWrap && (stageWrap.cls || []).includes('stage-wrap'), 'setup failure: "2" must address .stage-wrap');
  const hint = extractHint(elementText(stageWrap)) || composeHint('', 'div', false, '', '');
  assert.equal(hint, 'div');

  // The iframe body has exactly one top-level child (the mock div at index
  // 1), so ref "2" is out of range against it -- confirming this anchor
  // genuinely needs the SECTION root, not the iframe one, to resolve at all.
  assert.equal(resolveDomAnchor(board.blocks[0].html, '2', hint), false, 'setup failure: "2" must NOT resolve against the iframe body alone');
  assert.equal(resolveDomAnchorInSection(sectionHtml, '2', hint), true, 'setup failure: "2" must resolve against the section root');

  board.comments.push({ n: 1, blockId, anchor: { kind: 'dom', ref: '2', hint }, text: 'about the stage wrapper', createdAt: new Date().toISOString(), round: 1, mintBlockKind: 'html' });
  assert.equal(resolveComment(board, board.comments[0]).resolved, true,
    'a dom anchor rooted at the html block\'s own section (not the iframe) must still resolve -- the resolver must not assume block.kind === "html" means "always root at the iframe"');
});

// --- audit U1/U2: anchors into answer-derived content, re-measured with C1 fixed --
//
// Judgement call (ticket 08, see this repo's report for the full reasoning):
// NOT fixed here, by design. DESIGN.md's Decision "An anchor survives
// re-render, not editing" scopes the promise to content unchanged since post
// time. U1's status line and U2's rank order both derive from `board.answers`,
// which only changes when the reviewer answers/re-ranks and sends -- an edit
// of that specific block's answer, not a re-render of unchanged stored JSON. A
// bare re-render (a second page load, an SSE push of the same round) never
// shifts a rank order or an answer status, so it never loses either pin; only
// an intervening Send that changes the answer does, and honestly reports what
// it lost rather than silently vanishing or misattributing -- exactly what
// criterion 4's second half promises. What DOES matter, and is fixed by C1
// above: before that fix, a rank re-order could resolve onto the WRONG
// sibling (a silent misattribution) whenever one option's identity was a
// prefix of another's; after it, the same re-order always degrades to an
// honest "lost", never a wrong resolve. This locks in that re-measurement
// using the audit's own scenario (options "Ship it" / "Ship it later" / "Drop
// it", where "Ship it" is a literal prefix of "Ship it later").

check('U1, re-verified (director could not reproduce it; confirmed here with the real board.mjs functions): a status-line comment is lost by the very Send that carries it, when that Send also answers the question', () => {
  const board = createBoard({
    title: 'U1',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const qid = board.blocks[0].id;
  const sectionHtml = renderBlock(board.blocks[0], board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  // question-main(1) > question-footer(5) > answer-status span(2) -- fixed
  // sibling positions regardless of widget contents (block-kicker, prompt,
  // widget, note-field, footer are always exactly one element each).
  const statusNode = resolveSteps(sectionRoot, pathToSteps('1.5.2'));
  assert.ok(statusNode && (statusNode.cls || []).includes('answer-status'), 'setup failure: "1.5.2" must address the status span');
  const hint = extractHint(elementText(statusNode));
  assert.equal(hint, 'status: unanswered');
  assert.equal(resolveDomAnchorInSection(sectionHtml, '1.5.2', hint), true, 'setup failure: must resolve while genuinely unanswered');

  // The reviewer's ONE Send carries both the comment minted against the
  // still-unanswered status line AND the answer itself -- an answer can only
  // ever be merged into the SAME round its question was posted in
  // (applySubmit's own `answerable` set), so "anchor while unanswered, answer
  // it, Send" is necessarily one request, not two.
  applySubmit(board, {
    action: 'send',
    answers: [{ id: qid, choice: 'Yes' }],
    comments: [{ blockId: qid, anchor: { kind: 'dom', ref: '1.5.2', hint }, text: 'still says unanswered?' }],
  }, 1);

  const resolved = resolveComment(board, board.comments[0]);
  // Judgement call (not a bug -- see this block's own header comment): the
  // status text this anchor names genuinely changed as a direct result of the
  // reviewer's own answer, in the same request. Reported lost, honestly, per
  // criterion 4's second half.
  assert.equal(resolved.resolved, false, 'answering the question changes the status line this anchor named -- must report lost, not silently keep resolving against now-false text');
  assert.equal(resolved.lost, 'status: unanswered');
});

check('U2, re-measured with C1 fixed: a rank re-order that used to silently misattribute the pin onto a prefix-colliding sibling now honestly reports lost instead', () => {
  const board = createBoard({
    title: 'U2',
    blocks: [{ kind: 'question', prompt: 'Rank', widget: 'rank', options: [{ label: 'Ship it' }, { label: 'Ship it later' }, { label: 'Drop it' }] }],
  });
  const rid = board.blocks[0].id;
  const sectionHtml = renderBlock(board.blocks[0], board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  // question-main(1) > rank-list(3) > 2nd <li> ("Ship it later")
  const secondLi = resolveSteps(sectionRoot, pathToSteps('1.3.2'));
  const hint = extractHint(elementText(secondLi));
  assert.equal(hint, '2 Ship it later');

  board.comments.push({ n: 1, blockId: rid, anchor: { kind: 'dom', ref: '1.3.2', hint }, text: 'about this one', createdAt: new Date().toISOString(), round: 1, mintBlockKind: 'question' });
  assert.equal(resolveComment(board, board.comments[0]).resolved, true, 'setup failure: must resolve before any re-rank');

  // Re-rank so "Ship it" (a literal prefix of the stored hint's identity
  // "Ship it later") now sits at the SAME ref, "1.3.2".
  applySubmit(board, { action: 'send', answers: [{ id: rid, choice: ['Ship it later', 'Ship it', 'Drop it'] }], comments: [] }, 1);
  addRound(board, { blocks: [] });
  applySubmit(board, { action: 'send', answers: [{ id: rid, choice: ['Ship it', 'Ship it later', 'Drop it'] }], comments: [] }, 2);

  const afterRerank = resolveComment(board, board.comments[0]);
  assert.equal(afterRerank.resolved, false, 'C1 fixed: must report lost, never silently resolve onto "Ship it" just because it is a prefix of the stored hint "2 Ship it later"');
  assert.equal(afterRerank.lost, '2 Ship it later', 'the reviewer must be told what was lost, not have it silently reattributed to the wrong option');
});

check('findBlock and resolveComment reach an html/mermaid block nested inside a compare block nested inside a question\'s context -- not just top-level compares', () => {
  const board = createBoard({
    title: 'nested compare in question context',
    blocks: [{
      kind: 'question',
      prompt: 'Which stage is right?',
      widget: 'single',
      options: [{ label: 'Left' }, { label: 'Right' }],
      context: [{
        kind: 'compare',
        left: { label: 'Before', block: { kind: 'html', html: '<button>Old</button>' } },
        right: { label: 'After', block: { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' } },
      }],
    }],
  });
  const q = board.blocks[0];
  const compare = q.context[0];
  const htmlBlockId = compare.left.block.id;
  const mermaidBlockId = compare.right.block.id;

  assert.equal(findBlock(board, htmlBlockId)?.kind, 'html');
  assert.equal(findBlock(board, mermaidBlockId)?.kind, 'mermaid');

  board.comments.push(
    { n: 1, blockId: htmlBlockId, anchor: { kind: 'dom', ref: '1', hint: 'Old' }, text: 'update this', createdAt: new Date().toISOString(), round: 1 },
    { n: 2, blockId: mermaidBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'rename', createdAt: new Date().toISOString(), round: 1 },
  );
  const domResolved = resolveComment(board, board.comments[0]);
  assert.equal(domResolved.resolved, true, 'a real anchor nested inside compare-inside-question-context must not report lost');
  assert.equal(domResolved.blockKind, 'html');

  const mermaidResolved = resolveComment(board, board.comments[1]);
  assert.equal(mermaidResolved.resolved, true);
  assert.equal(mermaidResolved.blockKind, 'mermaid');
});

// --- ui.mjs / anchor.mjs parity: the mint side must agree with the resolve side --
//
// src/ui.mjs duplicates extractHint, stepsToPath and buildSteps as plain functions
// inside its template string -- necessarily, since the served page has no import
// graph at runtime (ticket 05's standalone-archive guarantee) -- rather than
// importing src/anchor.mjs. Nothing before this point ever checked that the two
// copies actually agree: src/anchor.mjs's own copies are exercised directly above,
// and ui.mjs's copy was previously only checked structurally (readonly guards,
// etc.), never executed.
//
// The risk this closes: src/ui.mjs's buildSteps/stepsToPath/extractHint MINT an
// anchor's ref/hint at click time, in the browser; src/anchor.mjs's resolveSteps/
// resolveDomAnchor RESOLVE that same ref/hint server-side, at packet-assembly time
// and every re-render. If the two implementations ever drift -- a different index
// base, different handling of text/whitespace-only children, a different
// truncation length or ellipsis character -- every anchor the browser mints would
// resolve as lost server-side. The reviewer sees a pin; the agent receives "lost
// anchor". No test that only exercises one side would ever notice.
//
// Technique: extract the three functions out of the `ui` template string by
// explicit start/end markers (src/ui.mjs's `/* anchor-parity:<name> start/end */`
// comments) and eval them with `new Function`, precisely as
// ~/.claude/skills/visualize/check.mjs does for template.html's own inline
// functions. Extraction failure is itself asserted (loudly, as its own check) so
// a future rename/restructure of ui.mjs surfaces as a failing check, not a
// silently-skipped one.

/** Pull the source between `/* anchor-parity:<name> start *(/` and the matching
 * `end` marker out of `src`, or throw a clear, specific error -- never returns
 * undefined/empty silently. */
function extractMarked(src, name) {
  const startMarker = '/* anchor-parity:' + name + ' start */';
  const endMarker = '/* anchor-parity:' + name + ' end */';
  const afterStart = src.split(startMarker);
  if (afterStart.length < 2) {
    throw new Error('anchor-parity extraction failed: start marker not found for "' + name + '" in src/ui.mjs -- ' +
      'the function may have been renamed or moved without its markers');
  }
  const body = afterStart[1].split(endMarker);
  if (body.length < 2) {
    throw new Error('anchor-parity extraction failed: end marker not found for "' + name + '" in src/ui.mjs');
  }
  return body[0];
}

/** Extract `name` from the ui.mjs template string and eval it into a callable,
 * via the same `new Function(src + '; return name;')()` technique as
 * ~/.claude/skills/visualize/check.mjs. Throws (not returns null/undefined) if
 * extraction or eval fails, so a broken extraction fails loudly as its own check
 * rather than producing a function that silently does nothing useful. */
function extractUiFunction(name) {
  const src = extractMarked(ui, name);
  const fn = new Function(src + '; return ' + name + ';')();
  if (typeof fn !== 'function') {
    throw new Error('anchor-parity extraction for "' + name + '" did not yield a function');
  }
  return fn;
}

check('anchor-parity: extraction actually finds and evaluates all three marked functions in ui.mjs (fails loudly, not silently, if the markers ever go missing)', () => {
  assert.equal(typeof extractUiFunction('extractHint'), 'function');
  assert.equal(typeof extractUiFunction('stepsToPath'), 'function');
  assert.equal(typeof extractUiFunction('buildSteps'), 'function');
  assert.throws(() => extractUiFunction('doesNotExist'), /start marker not found/);
});

const uiExtractHint = extractUiFunction('extractHint');
const uiStepsToPath = extractUiFunction('stepsToPath');
const uiBuildSteps = extractUiFunction('buildSteps');

check('anchor-parity: extractHint -- ui.mjs\'s copy agrees with src/anchor.mjs across whitespace, boundary and ellipsis cases', () => {
  const cases = [
    '',
    '   ',
    '\n\t  \n',
    'Send',
    '  Send   Message  ',
    'Send\nMessage\twith\r\ntabs and newlines',
    'x'.repeat(79),   // just under the 80-char truncation boundary
    'x'.repeat(80),   // exactly at the boundary
    'x'.repeat(81),   // just over
    'x'.repeat(200),  // well over
    'y'.repeat(75) + '…', // source text already contains the ellipsis character, under the boundary
    'z'.repeat(85) + '…', // ...and over it, where extractHint's own truncation also kicks in
    'word '.repeat(30), // long, but whitespace-heavy -- collapsing changes the pre-truncation length
    null,
    undefined,
  ];
  for (const input of cases) {
    const uiOut = uiExtractHint(input);
    const anchorOut = extractHint(input);
    assert.equal(uiOut, anchorOut, 'extractHint parity failed for input: ' + JSON.stringify(input) + ' (ui: ' + JSON.stringify(uiOut) + ', anchor.mjs: ' + JSON.stringify(anchorOut) + ')');
  }
});

check('anchor-parity: stepsToPath -- ui.mjs\'s copy agrees with src/anchor.mjs across empty, single and multi-digit step chains', () => {
  const cases = [[], [1], [1, 2, 3], [10, 2, 300], [1, 1, 1, 1, 1]];
  for (const steps of cases) {
    assert.equal(uiStepsToPath(steps), stepsToPath(steps), 'stepsToPath parity failed for: ' + JSON.stringify(steps));
  }
});

/** Recursively wire `.parentElement` on every element in a `{ tag, children }`
 * tree (anchor.mjs's parseHtmlTree already builds `children` element-only,
 * matching real DOM `Element.children` -- this only adds the upward pointers
 * buildSteps needs that parseHtmlTree itself has no reason to set). */
function linkParents(node) {
  for (const child of node.children || []) {
    child.parentElement = node;
    linkParents(child);
  }
  return node;
}

/** Every element node in `tree`, root included -- so a battery of round-trip
 * checks can hit every depth/breadth case (single child, last child, deepest
 * leaf, etc.) in one pass without hand-picking targets. */
function everyElement(node, out) {
  out = out || [];
  out.push(node);
  for (const child of node.children || []) everyElement(child, out);
  return out;
}

check('anchor-parity: buildSteps -- ui.mjs\'s copy agrees with src/anchor.mjs over hand-built trees (single child, last child, deep, wide)', () => {
  const trees = [
    // single-child chain at every level
    linkParents(el('body', [el('div', [el('span', [el('em')])])])),
    // wide: five siblings, target each in turn including the last
    linkParents(el('body', [el('a'), el('b'), el('c'), el('d'), el('e')])),
    // deep + wide mixed, so a "last child of a last child" case exists
    linkParents(el('body', [
      el('div', [el('span'), el('button')]),
      el('div', [el('a'), el('b'), el('c')]),
    ])),
  ];
  let compared = 0;
  for (const tree of trees) {
    for (const target of everyElement(tree)) {
      const uiSteps = uiBuildSteps(tree, target);
      const anchorSteps = buildSteps(tree, target);
      assert.deepEqual(uiSteps, anchorSteps, 'buildSteps parity failed for a target in tree ' + JSON.stringify(tree.tag));
      compared++;
      if (target !== tree) {
        // round trip: the ui.mjs copy mints the path, src/anchor.mjs's resolveSteps
        // (the actual server-side resolution function) must land back on the same
        // element -- this is the exact mint -> resolve boundary the ticket's
        // guarantee depends on.
        assert.equal(resolveSteps(tree, uiSteps), target, 'round trip (ui buildSteps -> anchor.mjs resolveSteps) failed to land back on the clicked element');
      }
    }
  }
  assert.ok(compared >= 10, 'expected the battery to cover at least 10 distinct targets, covered ' + compared);
});

check('anchor-parity: buildSteps -- agrees even when text and whitespace-only nodes sit between the elements being indexed', () => {
  // Realistic markup: literal whitespace between tags becomes real text-node
  // children in a browser DOM. anchor.mjs's own parseHtmlTree already excludes
  // them from `.children` (matching Element.children) -- reusing it here as the
  // shared tree builder means this battery exercises the exact scenario a
  // hand-rolled index-chain implementation most plausibly gets wrong, without
  // hand-modelling text nodes ourselves (see this module's file comment for why
  // parseHtmlTree exists at all).
  const html = [
    '<div>',
    '  <button>A</button>',
    '  ',
    '  <span>B</span>',
    '\n\n',
    '  <p>C<br>\n  D</p>',
    '</div>',
  ].join('\n');
  const tree = linkParents(parseHtmlTree(html));
  let compared = 0;
  for (const target of everyElement(tree)) {
    if (target === tree) continue; // the synthetic #root has no real position to build steps to
    const uiSteps = uiBuildSteps(tree, target);
    const anchorSteps = buildSteps(tree, target);
    assert.deepEqual(uiSteps, anchorSteps, 'buildSteps parity failed with whitespace-interleaved children for tag ' + target.tag);
    assert.equal(resolveSteps(tree, uiSteps), target, 'round trip failed to land back on the clicked element with whitespace-interleaved children');
    compared++;
  }
  assert.ok(compared >= 5, 'expected at least 5 targets from the whitespace-interleaved fixture, covered ' + compared);
});

check('anchor-parity: buildSteps -- both copies refuse a click outside the given root, identically', () => {
  const root = linkParents(el('body', [el('div')]));
  const outsider = el('span'); // detached, no parentElement chain back to root
  assert.equal(uiBuildSteps(root, outsider), null);
  assert.equal(buildSteps(root, outsider), null);
});

// --- render.mjs: pure function of the JSON -----------------------------------------

check('renderBoardPage is a pure function that inlines its own board JSON', () => {
  const board = createBoard({
    title: 'Render check',
    blocks: [
      { kind: 'markdown', text: '# Acceptance Criteria\n\n- one\n- two' },
      { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] },
    ],
  });
  const html1 = renderBoardPage(board);
  const html2 = renderBoardPage(board);
  assert.equal(html1, html2);
  assert.ok(html1.includes('id="board-data"'));
  assert.ok(html1.includes(JSON.stringify(board.id)));
  assert.ok(html1.includes('id="acceptance-criteria"'));
  assert.ok(html1.includes('data-anchor-ref="acceptance-criteria-li1"'));
  assert.ok(html1.includes('data-choice="A"'));
  assert.ok(html1.includes('id="send-btn"'));
});

// A temp CLAUDE_BOARD_HOME sanity guard: this check touches no disk at all, but
// assert the convention still holds for anything added here later.
check('this check never touches the real store', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'claude-board-pure-'));
  try {
    assert.notEqual(tmp, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- src/resolve.mjs: content-by-reference resolution -----------------------------

check('resolveRef slices a 1-based inclusive line range and hashes the result', () => {
  const file = path.join(fixturesDir, 'lines.txt');
  writeFileSync(file, ['one', 'two', 'three', 'four', 'five'].join('\n'), 'utf8');
  const result = resolveRef({ path: 'lines.txt', lines: [2, 4] }, { cwd: fixturesDir });
  assert.equal(result.text, 'two\nthree\nfour');
  assert.equal(typeof result.sha, 'string');
  assert.equal(result.sha.length, 64);
  assert.equal(result.error, undefined);
});

check('resolveRef slices a markdown section by heading slug, stopping at the next same-or-shallower heading', () => {
  const file = path.join(fixturesDir, 'doc.md');
  writeFileSync(file, [
    '# Title',
    '',
    'intro prose',
    '',
    '## Notes',
    '',
    'note body',
    '- item one',
    '',
    '## Other',
    '',
    'other body',
  ].join('\n'), 'utf8');
  const result = resolveRef({ path: 'doc.md', section: 'notes' }, { cwd: fixturesDir });
  assert.ok(result.text.startsWith('## Notes'));
  assert.ok(result.text.includes('note body'));
  assert.ok(!result.text.includes('## Other'));
  assert.ok(!result.text.includes('other body'));
});

check('resolveRef reports missing file, bad line range, and missing section as errors, never throws', () => {
  const at = { cwd: fixturesDir };
  assert.equal(typeof resolveRef({ path: 'nope.md' }, at).error, 'string');
  writeFileSync(path.join(fixturesDir, 'short.txt'), 'only one line', 'utf8');
  assert.equal(typeof resolveRef({ path: 'short.txt', lines: [5, 8] }, at).error, 'string');
  assert.equal(typeof resolveRef({ path: 'short.txt', lines: [3, 1] }, at).error, 'string'); // to < from
  writeFileSync(path.join(fixturesDir, 'doc2.md'), '# Title\n\nprose', 'utf8');
  assert.equal(typeof resolveRef({ path: 'doc2.md', section: 'does-not-exist' }, at).error, 'string');
  assert.equal(typeof resolveRef(null).error, 'string');
});

check('langForPath guesses a language from the extension, falling back to empty', () => {
  assert.equal(langForPath('src/board.mjs'), 'javascript');
  assert.equal(langForPath('README'), '');
});

check('a board carrying reference-resolved content snapshots text+sha at post time, and a bad reference reports an error without dropping the block', () => {
  const codeFile = path.join(fixturesDir, 'snippet.js');
  writeFileSync(codeFile, ['function add(a, b) {', '  return a + b;', '}', ''].join('\n'), 'utf8');
  const mdFile = path.join(fixturesDir, 'contract.md');
  writeFileSync(mdFile, '# Contract\n\n## Notes\n\nresolved by reference', 'utf8');

  const board = createBoard({
    title: 'Reference resolution',
    cwd: fixturesDir,
    blocks: [
      { kind: 'code', source: { path: 'snippet.js', lines: [1, 2] } },
      { kind: 'markdown', source: { path: 'contract.md', section: 'notes' } },
      { kind: 'markdown', source: { path: 'missing-file.md' } },
    ],
  });

  const code = board.blocks[0];
  assert.equal(code.text, 'function add(a, b) {\n  return a + b;');
  assert.equal(code.lang, 'javascript'); // guessed from the source path when no explicit lang
  assert.equal(code.sha.length, 64);
  assert.equal(code.error, undefined);

  const md = board.blocks[1];
  assert.ok(md.text.includes('resolved by reference'));
  assert.ok(md.html.includes('resolved by reference'));
  assert.equal(md.error, undefined);

  const broken = board.blocks[2];
  assert.equal(board.blocks.length, 3); // the bad reference is still minted, not dropped
  assert.equal(broken.kind, 'markdown');
  assert.equal(broken.text, '');
  assert.equal(typeof broken.error, 'string');
  assert.ok(broken.error.includes('missing-file.md'));
});

check('a block with a failed resolution renders its error on the page instead of vanishing', () => {
  const board = createBoard({
    title: 'Broken reference',
    cwd: fixturesDir,
    blocks: [{ kind: 'code', source: { path: 'does-not-exist.js' } }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('class="resolve-error"'));
  assert.ok(markup.includes('Could not resolve'));
});

// --- SPEC_HTMLREF.md: an html block may carry source: { path }, routed through the -
// --- same resolveRef every other referenced kind uses, path-only ------------------

check('SPEC_HTMLREF.md criterion 1: an html source ref renders a stage byte-identical to the same content posted by value', () => {
  const file = path.join(fixturesDir, 'referenced-stage.html');
  const markup = '<div class="mock"><button>Ship it</button></div>';
  writeFileSync(file, markup, 'utf8');

  const refBoard = createBoard({
    title: 'html by reference',
    cwd: fixturesDir,
    blocks: [{ kind: 'html', source: { path: 'referenced-stage.html' } }],
  });
  const valueBoard = createBoard({
    title: 'html by value',
    blocks: [{ kind: 'html', html: markup }],
  });

  const refBlock = refBoard.blocks[0];
  assert.equal(refBlock.error, undefined);
  assert.equal(refBlock.html, markup); // resolved through the same field every other consumer of an html block reads
  assert.equal(typeof refBlock.sha, 'string');
  assert.equal(refBlock.sha.length, 64); // snapshotted like every other referenced kind

  const refMarkup = renderBlock(refBlock, refBoard, new Map(), false);
  const valueMarkup = renderBlock(valueBoard.blocks[0], valueBoard, new Map(), false);
  // Both boards mint the same first id ('h1') for their one block, so nothing here
  // depends on stripping ids to compare -- if this is byte-identical, the stage the
  // reviewer sees from a reference is indistinguishable from a hand-mocked one.
  assert.equal(refMarkup, valueMarkup);
  // The literal markup is attribute-escaped inside srcdoc (quotes -> &quot;), so
  // assert on a quote-free fragment of it that survives escaping unchanged --
  // proof the resolved file's content actually reached the stage, not just that
  // the two renders happen to agree.
  assert.ok(refMarkup.includes('srcdoc='));
  assert.ok(refMarkup.includes('Ship it'), 'the resolved file content must actually reach the srcdoc');

  // One stored shape per kind, not one per way the content arrived: PROTOCOL.md's
  // block table states `source` and `sha` unconditionally for html, the same as
  // markdown/mermaid/code get for free by routing through resolveContent. The
  // by-value branch mints them by hand, so it is the one that can drift.
  const valueBlock = valueBoard.blocks[0];
  assert.equal(valueBlock.source, null);
  assert.equal(valueBlock.sha, refBlock.sha, 'identical content by either route must snapshot to the identical sha');
  assert.deepEqual(Object.keys(valueBlock).sort(), Object.keys(refBlock).sort());
});

check('SPEC_HTMLREF.md criterion 2: lines or section on an html source is refused with a block-level error naming markup slicing, never thrown', () => {
  const file = path.join(fixturesDir, 'sliceable-stage.html');
  writeFileSync(file, '<html><body><p>one</p><p>two</p></body></html>', 'utf8');

  const linesBoard = createBoard({
    title: 'html source, lines refused',
    cwd: fixturesDir,
    blocks: [
      { kind: 'html', source: { path: 'sliceable-stage.html', lines: [1, 1] } },
      { kind: 'markdown', source: { path: 'no-such-file.md' } },
    ],
  });
  const linesBlock = linesBoard.blocks[0];
  assert.equal(typeof linesBlock.error, 'string'); // reported on the block, not thrown -- createBoard above did not throw
  assert.match(linesBlock.error, /slic/i);
  assert.match(linesBlock.error, /markup/i);
  assert.equal(linesBlock.html, '');
  // Same shape every other resolve failure takes (PROTOCOL.md's resolve-failure
  // contract): content empty, sha the hash of that empty content -- not absent. This
  // refusal fires before resolveContent runs, so it is the one error path that could
  // silently drift from the shape the rest of the protocol promises. Asserted against
  // a sibling block that failed the ordinary way rather than a hardcoded digest, so
  // the two can never disagree without this failing.
  const failedSibling = linesBoard.blocks[1];
  assert.equal(typeof failedSibling.error, 'string');
  assert.equal(linesBlock.sha, failedSibling.sha);

  const sectionBoard = createBoard({
    title: 'html source, section refused',
    cwd: fixturesDir,
    blocks: [{ kind: 'html', source: { path: 'sliceable-stage.html', section: 'notes' } }],
  });
  const sectionBlock = sectionBoard.blocks[0];
  assert.equal(typeof sectionBlock.error, 'string');
  assert.match(sectionBlock.error, /slic/i);
  assert.match(sectionBlock.error, /markup/i);

  // Refused is visible on the page, not silently ignored (the parameter is not
  // dropped and the whole file is not quietly substituted for the requested slice).
  const markup = renderedMarkup(renderBoardPage(linesBoard));
  assert.ok(markup.includes('class="resolve-error"'));
});

check('SPEC_HTMLREF.md criterion 3: a referenced html file over the 512 KiB cap is refused as a block-level error, and the board still posts with its other blocks intact', () => {
  const big = path.join(fixturesDir, 'oversize-stage.html');
  writeFileSync(big, 'x'.repeat(MAX_REF_BYTES + 1), 'utf8');
  try {
    const board = createBoard({
      title: 'html source, over cap',
      cwd: fixturesDir,
      blocks: [
        { kind: 'html', source: { path: 'oversize-stage.html' } },
        { kind: 'markdown', text: 'still here' },
      ],
    });
    assert.equal(board.blocks.length, 2); // the oversize reference is refused, not dropped
    const htmlBlock = board.blocks[0];
    assert.equal(typeof htmlBlock.error, 'string');
    assert.match(htmlBlock.error, /exceeds the .* cap/);
    assert.equal(htmlBlock.html, '');
    const mdBlock = board.blocks[1];
    assert.equal(mdBlock.error, undefined);
    assert.equal(mdBlock.text, 'still here'); // the surrounding board is untouched
  } finally {
    unlinkSync(big);
  }
});

// --- four answer widgets: packet shape, including unanswered, deferred, notes -----

check('all four widgets produce their documented answer shape in the packet, including unanswered, deferred, and notes', () => {
  const board = createBoard({
    title: 'Widget survey',
    blocks: [
      { kind: 'question', prompt: 'Pick one', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] },
      { kind: 'question', prompt: 'Pick some', widget: 'multi', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
      { kind: 'question', prompt: 'Say something', widget: 'text', options: [] },
      { kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
      { kind: 'question', prompt: 'Set aside for later', widget: 'single', options: [{ label: 'X' }] },
      { kind: 'question', prompt: 'Never touched', widget: 'multi', options: [{ label: 'A' }] },
    ],
  });
  const [single, multi, text, rank, deferredId, neverTouched] = board.blocks.map(b => b.id);

  applySubmit(board, {
    action: 'send',
    answers: [
      { id: single, status: 'answered', choice: 'A', note: 'clean call' },
      { id: multi, status: 'answered', choice: ['A', 'C'], note: 'both' },
      { id: text, status: 'answered', choice: 'a full paragraph of free-form prose', note: '' },
      { id: rank, status: 'answered', choice: ['C', 'A', 'B'], note: 'reordered' },
      { id: deferredId, status: 'deferred', choice: null, note: 'coming back to this' },
      // neverTouched deliberately absent -> must come back explicitly unanswered
    ],
    comments: [],
  }, 1);

  const packet = buildPacket(board, 1, 'http://127.0.0.1:7391/b/' + board.id);
  assert.equal(packet.answers.length, 6);
  const byId = Object.fromEntries(packet.answers.map(a => [a.id, a]));

  assert.equal(byId[single].widget, 'single');
  assert.equal(byId[single].status, 'answered');
  assert.equal(byId[single].choice, 'A');
  assert.equal(byId[single].note, 'clean call');

  assert.equal(byId[multi].widget, 'multi');
  assert.deepEqual(byId[multi].choice, ['A', 'C']);
  assert.equal(byId[multi].note, 'both');

  assert.equal(byId[text].widget, 'text');
  assert.equal(typeof byId[text].choice, 'string');
  assert.equal(byId[text].choice, 'a full paragraph of free-form prose');
  assert.equal(byId[text].note, ''); // note always present, '' when empty

  assert.equal(byId[rank].widget, 'rank');
  assert.deepEqual(byId[rank].choice, ['C', 'A', 'B']);
  assert.equal(byId[rank].note, 'reordered');

  assert.equal(byId[deferredId].status, 'deferred');
  assert.equal(byId[deferredId].choice, null);
  assert.equal(byId[deferredId].note, 'coming back to this');

  assert.equal(byId[neverTouched].status, 'unanswered');
  assert.equal(byId[neverTouched].choice, null);
  assert.equal(byId[neverTouched].note, '');
});

check('render markup: multi-select, text, rank and defer carry the data attributes src/ui.mjs reads generically', () => {
  const board = createBoard({
    title: 'Widget markup',
    blocks: [
      { kind: 'question', prompt: 'Pick some', widget: 'multi', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { kind: 'question', prompt: 'Say something', widget: 'text', options: [] },
      { kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'First' }, { label: 'Second' }] },
    ],
  });
  const markup = renderedMarkup(renderBoardPage(board));

  assert.ok(markup.includes('class="card-choice choice-multi"'));
  assert.ok(markup.includes('data-choice="Red"'));
  assert.ok(markup.includes('data-answer-for='));
  assert.ok(markup.includes('class="rank-list"'));
  assert.ok(markup.includes('draggable="true"'));
  assert.ok(markup.includes('data-choice="First"'));
  assert.ok(markup.includes('class="btn-defer"'));
  assert.ok(markup.includes('data-defer-for='));
  assert.ok(markup.includes('data-widget="multi"'));
  assert.ok(markup.includes('data-widget="text"'));
  assert.ok(markup.includes('data-widget="rank"'));
});

check('the rank widget renders options in the stored order when there is a prior answer', () => {
  const board = createBoard({
    title: 'Rank order',
    blocks: [{ kind: 'question', prompt: 'Order these', widget: 'rank', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
  });
  const qid = board.blocks[0].id;
  applySubmit(board, { action: 'send', answers: [{ id: qid, status: 'answered', choice: ['C', 'A', 'B'], note: '' }], comments: [] }, 1);
  const markup = renderedMarkup(renderBoardPage(board));
  const order = [...markup.matchAll(/data-choice="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['C', 'A', 'B']);
});

// --- ticket 04: the history rail ---------------------------------------------------
//
// DESIGN.md Decisions -> "A board is a session-scoped thread with rounds": "the
// sent round collapsed into a history rail with its answers still readable."

check('a sent round renders as history with its prompt, choice and note still readable; a still-open round renders live', () => {
  const board = createBoard({
    title: 'History rail',
    blocks: [{ kind: 'question', prompt: 'Round 1 question', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const q1 = board.blocks[0].id;
  applySubmit(board, { action: 'send', answers: [{ id: q1, status: 'answered', choice: 'Yes', note: 'first round note' }], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'question', prompt: 'Round 2 question', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }] });

  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(/<section class="round round-history" data-round="1" data-round-status="sent">/.test(markup));
  assert.ok(markup.includes('Round 1 question'), 'the sent round\'s prompt must still be readable');
  assert.ok(markup.includes('first round note'), 'the sent round\'s note must still be readable');
  // the answer is "still readable" specifically as the selected choice, not just
  // present as text somewhere on the page (ablation: dropping the `selected` class
  // while leaving the label text would pass a bare `.includes('Yes')` check)
  assert.ok(/class="card-choice choice-single selected"[^>]*data-choice="Yes"/.test(markup));

  assert.ok(/<section class="round round-open" data-round="2" data-round-status="open">/.test(markup));
  assert.ok(markup.includes('Round 2 question'), 'the still-open round must render live below the history');
});

check('interactive controls inside a history round are rendered disabled, so a later Send can never silently rewrite a sent answer', () => {
  const board = createBoard({
    title: 'History disabled',
    blocks: [{ kind: 'question', prompt: 'Q1', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const q1 = board.blocks[0].id;
  applySubmit(board, { action: 'send', answers: [{ id: q1, status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'markdown', text: '# more' }] });

  const html = renderBoardPage(board);
  const historySection = /<section class="round round-history"[\s\S]*?<section class="round round-open"/.exec(html)[0];
  // Ablation: rendering the round-1 widgets without `historical` (i.e. always
  // passing `false`) leaves this identical to the open-round markup and fails here.
  assert.ok(historySection.includes('disabled'), 'a sent round\'s answer controls must be disabled in the markup');
  assert.ok(/class="card-choice choice-single selected"[^>]*disabled/.test(historySection) || /disabled[^>]*class="card-choice choice-single selected"/.test(historySection));
});

check('a history round\'s comment form is disabled too, on every CONTENT block kind -- not just markdown', () => {
  // Audit finding: commentArea() didn't originally take `historical` at all, so a
  // fresh page load of a board with a sent round left every comment form fully
  // live even though the round's answer controls were correctly disabled --
  // divergent from what the client-side collapse (markRoundHistory) already did.
  // Covers code too, not just markdown, since renderBlock threads `historical`
  // into every CONTENT kind's commentArea call. `question` is deliberately not
  // one of the two fixture blocks any more (ADR "Commenting is confined to
  // content blocks", 2026-08-01): it carries no commentArea at all, so it would
  // prove nothing about historical-threading here.
  const board = createBoard({
    title: 'Comment form disabled',
    blocks: [
      { kind: 'markdown', text: '# Notes' },
      { kind: 'code', text: 'const x = 1;', lang: 'javascript' },
    ],
  });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'markdown', text: '# more' }] });

  const html = renderBoardPage(board);
  const historySection = /<section class="round round-history"[\s\S]*?<section class="round round-open"/.exec(html)[0];
  const commentForms = [...historySection.matchAll(/<form class="comment-form"[\s\S]*?<\/form>/g)];
  assert.equal(commentForms.length, 2, 'both blocks in the sent round must carry a comment form');
  for (const [form] of commentForms) {
    assert.ok(/<input type="text" placeholder="Add a comment" disabled>/.test(form), `comment input must be disabled in a history round:\n${form}`);
    assert.ok(/<button type="submit" disabled>Add<\/button>/.test(form), `comment submit must be disabled in a history round:\n${form}`);
  }

  // and the still-open round's comment forms stay fully live
  const openSection = html.slice(html.indexOf('<section class="round round-open"'));
  assert.ok(/<input type="text" placeholder="Add a comment">/.test(openSection));
  assert.ok(!/placeholder="Add a comment" disabled/.test(openSection));
});

check('renderRoundSection produces byte-identical markup for a round whether called directly or through renderBoardPage', () => {
  const board = createBoard({
    title: 'Consistency',
    blocks: [{ kind: 'question', prompt: 'Q', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  const commentsByBlock = groupCommentsByBlock(board.comments.map(c => resolveComment(board, c)));
  const direct = renderRoundSection(board, 1, commentsByBlock);
  const wholePage = renderBoardPage(board);
  assert.ok(wholePage.includes(direct.trim()), 'src/server.mjs renders the exact same fragment for an SSE push of a new round as the full page does');
});

check('renderBlock renders a single block fragment usable for an SSE amend push, matching the block markup inside the full page', () => {
  const board = createBoard({
    title: 'Amend fragment',
    blocks: [{ kind: 'markdown', text: '# Amend target\n\noriginal' }],
  });
  const commentsByBlock = groupCommentsByBlock(board.comments.map(c => resolveComment(board, c)));
  const fragment = renderBlock(board.blocks[0], board, commentsByBlock, false);
  assert.ok(renderBoardPage(board).includes(fragment.trim()));
});

// --- five context kinds render into the page ---------------------------------------

check('all five context kinds render into the page: markdown, code, mermaid, html, compare', () => {
  const board = createBoard({
    title: 'Context kinds',
    blocks: [
      { kind: 'markdown', text: '# Prose\n\nsome text' },
      { kind: 'code', text: 'const x = 1;', lang: 'javascript' },
      { kind: 'mermaid', text: 'flowchart LR\n  A --> B' },
      { kind: 'html', html: '<div class="mock"><button>Click</button></div>' },
      {
        kind: 'compare',
        left: { label: 'Before', block: { kind: 'markdown', text: '# Before\n\nold copy' } },
        right: { label: 'After', block: { kind: 'markdown', text: '# After\n\nnew copy' } },
      },
    ],
  });
  // Stripped of the inlined <style>, the #board-data JSON, and the client <script>:
  // every needle below can only be satisfied by markup renderBlock actually emitted,
  // not by a CSS selector, a querySelector string literal in src/ui.mjs, or a field
  // value riding along in the hydration payload. (Verified: replacing the compare
  // arm of the render dispatch with `return ''` makes this check fail, as it must.)
  const markup = renderedMarkup(renderBoardPage(board));

  assert.ok(markup.includes('class="md-content"'));
  assert.ok(markup.includes('some text'));

  assert.ok(markup.includes('class="block code-block"'));
  // Ticket 03: every source line is its own element (criterion 1's "a line of a
  // code reference" needs an element the generic dom anchor can build a path to).
  assert.ok(markup.includes('<pre><code><span class="code-line">const x = 1;</span></code></pre>'));
  assert.ok(markup.includes('Code · javascript'));

  assert.ok(markup.includes('class="block mermaid-block"'));
  assert.ok(markup.includes('<pre class="mermaid">flowchart LR'));

  assert.ok(markup.includes('class="block html-block"'));
  assert.ok(markup.includes('class="html-stage"'));
  assert.ok(markup.includes('srcdoc='));
  assert.ok(markup.includes('&lt;button&gt;Click&lt;/button&gt;')); // srcdoc is attribute-escaped, not stripped

  assert.ok(markup.includes('class="block compare-block"'));
  assert.ok(markup.includes('class="compare-grid"'));
  assert.ok(markup.includes('<div class="compare-label">Before</div>'));
  assert.ok(markup.includes('<div class="compare-label">After</div>'));
  assert.ok(markup.includes('old copy'));
  assert.ok(markup.includes('new copy'));
});

// --- ADR "Commenting is confined to content blocks", 2026-08-01 ------------------
//
// Two block kinds render no content of their own -- `question` is a card around
// a widget, `compare` is a grid around two nested blocks -- and lose the
// whole-block comment affordance entirely: no commentButton in the kicker, and
// (since a button-less commentArea would just be dead, unreachable markup -- an
// "Add a comment" input and empty comment-list with no button to open them, and
// an empty page-scoped pin-layer nothing can ever populate, since the click
// gesture over these two kinds is inert too) no commentArea/pageDomPinLayer
// either. The four content kinds -- markdown, mermaid, html, code -- are
// unaffected: same commentButton, same commentArea, same pin-layer as before
// this ADR entry, on a block that renders nothing at all (criterion 7).

check('criterion 2: a question block renders no comment button, no comment form, no comment area, and no page-scoped pin-layer', () => {
  const board = createBoard({
    title: 'No comment chrome on question',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  const qId = board.blocks[0].id;
  const markup = renderedMarkup(renderBoardPage(board));
  // Nothing else on this single-block board, so the first </section> reached is
  // this block's own closing tag (no nested context here to worry about).
  const section = markup.slice(markup.indexOf('<section class="block question-block"'), markup.indexOf('</section>') + '</section>'.length);

  assert.ok(!section.includes('comment-btn'), 'a question block must render no .comment-btn at all');
  assert.ok(!section.includes(`comment-form-${qId}`), 'a question block must render no comment-form for its own id');
  assert.ok(!section.includes(`comment-target-${qId}`), 'a question block must render no comment-target for its own id');
  assert.ok(!section.includes(`comment-list-${qId}`), 'a question block must render no comment-list for its own id');
  // Every content kind's own top-level section still carries a direct-child
  // .pin-layer (pageDomPinLayer) -- a question's wrapper carries none, since
  // nothing can ever populate one: no button/gesture ever mints an anchor
  // against the wrapper itself any more.
  assert.ok(!section.includes('class="pin-layer"'), 'a question block\'s own section must carry no page-scoped pin-layer');
});

check('criterion 2: a compare block renders no comment button, no comment form, no comment area, and no page-scoped pin-layer on the wrapper -- only its two nested sides may carry one', () => {
  const board = createBoard({
    title: 'No comment chrome on compare',
    blocks: [{
      kind: 'compare',
      left: { label: 'Before', block: { kind: 'markdown', text: '# Before' } },
      right: { label: 'After', block: { kind: 'markdown', text: '# After' } },
    }],
  });
  const compareId = board.blocks[0].id;
  const markup = renderedMarkup(renderBoardPage(board));
  const outerKicker = /<section class="block compare-block"[^>]*>\s*<div class="block-kicker">([\s\S]*?)<\/div>/.exec(markup)[1];

  assert.equal(outerKicker.trim(), 'Compare', 'the compare wrapper\'s own kicker must carry no comment button, just its label');
  assert.ok(!markup.includes(`comment-form-${compareId}`), 'a compare block must render no comment-form for its own id');
  assert.ok(!markup.includes(`comment-target-${compareId}`), 'a compare block must render no comment-target for its own id');
  assert.ok(!markup.includes(`comment-list-${compareId}`), 'a compare block must render no comment-list for its own id');
  // No direct-child pin-layer between the wrapper's own kicker and its grid --
  // the only place a page-scoped pin-layer belonging to the OUTER section
  // (rather than one of the two nested sides) could ever sit.
  const wrapperStart = markup.indexOf(`data-block-id="${compareId}" data-block-kind="compare"`);
  const gridStart = markup.indexOf('class="compare-grid"', wrapperStart);
  assert.ok(!markup.slice(wrapperStart, gridStart).includes('class="pin-layer"'), 'no pin-layer between the compare wrapper\'s kicker and its grid');
});

check('criterion 1 + the ADR\'s wrapper/content split: markdown, mermaid, html and code keep their comment button, form and pin-layer exactly as before -- unaffected by the question/compare narrowing', () => {
  const board = createBoard({
    title: 'Content kinds keep their button',
    blocks: [
      { kind: 'markdown', text: '# Prose' },
      { kind: 'mermaid', text: 'flowchart LR\n  A --> B' },
      { kind: 'html', html: '<div class="mock"></div>' },
      { kind: 'code', text: 'const x = 1;', lang: 'javascript' },
    ],
  });
  const [mdId, mermaidId, htmlId, codeId] = board.blocks.map(b => b.id);
  const markup = renderedMarkup(renderBoardPage(board));

  for (const id of [mdId, mermaidId, htmlId, codeId]) {
    assert.ok(markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `expected a whole-block comment button for ${id}`);
    assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${id}"`), `expected a comment-form for ${id}`);
    assert.ok(markup.includes(`id="comment-target-${id}"`), `expected a comment-target for ${id}`);
    assert.ok(markup.includes(`id="comment-list-${id}"`), `expected a comment-list for ${id}`);
  }
});

check('criterion 7: the whole-block comment button still opens the comment form when a content block has nothing to point at -- a failed reference, and an empty stage', () => {
  // A reference that failed to resolve: markdown and code both render a
  // .resolve-error note instead of content, but the button/form survive --
  // they live in the kicker/commentArea, outside the `block.error` branch.
  const board = createBoard({
    title: 'Blank content, button still works',
    cwd: fixturesDir,
    blocks: [
      { kind: 'code', source: { path: 'does-not-exist.js' } },
      { kind: 'html', html: '' }, // a stage that came up blank
    ],
  });
  const codeId = board.blocks[0].id;
  const htmlId = board.blocks[1].id;
  const markup = renderedMarkup(renderBoardPage(board));

  assert.ok(markup.includes('class="resolve-error"'), 'setup failure: the code block must have failed to resolve');
  assert.ok(markup.includes(`data-block-id="${codeId}" data-anchor-kind="block"`), 'a code block with a failed reference must still render its whole-block comment button');
  assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${codeId}"`), 'and still render the form that button opens');

  assert.ok(markup.includes(`data-block-id="${htmlId}" data-anchor-kind="block"`), 'an html block with a blank stage must still render its whole-block comment button');
  assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${htmlId}"`), 'and still render the form that button opens');
});

check('a question\'s nested context block and a compare side\'s nested block keep their own comment button/form/pin-layer untouched -- the rule is about the wrapper, not what is inside it', () => {
  const board = createBoard({
    title: 'Nested blocks stay commentable',
    blocks: [
      {
        kind: 'question',
        prompt: 'Ship it?',
        widget: 'single',
        options: [{ label: 'Yes' }],
        context: [{ kind: 'markdown', text: '# Context' }],
      },
      {
        kind: 'compare',
        left: { label: 'Before', block: { kind: 'markdown', text: '# Before' } },
        right: { label: 'After', block: { kind: 'markdown', text: '# After' } },
      },
    ],
  });
  const contextId = board.blocks[0].context[0].id;
  const leftId = board.blocks[1].left.block.id;
  const rightId = board.blocks[1].right.block.id;
  const markup = renderedMarkup(renderBoardPage(board));

  for (const id of [contextId, leftId, rightId]) {
    assert.ok(markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `expected a whole-block comment button for nested block ${id}`);
    assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${id}"`), `expected a comment-form for nested block ${id}`);
  }
});

// --- ticket 06: numbered pins on the element, in html-stage and mermaid blocks ----

check('html and mermaid blocks each render a stage-wrap + pin-layer, the anchor point src/ui.mjs positions numbered pins into', () => {
  const board = createBoard({
    title: 'Pin layers',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
      { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
    ],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const htmlBlockId = board.blocks[0].id;
  const mermaidBlockId = board.blocks[1].id;
  assert.ok(markup.includes(`<div class="pin-layer" data-block-id="${htmlBlockId}"></div>`));
  assert.ok(markup.includes(`<div class="pin-layer" data-block-id="${mermaidBlockId}"></div>`));
  assert.ok(markup.includes('class="stage-wrap"'));
});

// --- the element-level gesture has to be discoverable -------------------------
//
// Found in the manual pass, 2026-07-29: the wiring below was correct and unusable.
// A mermaid diagram and an iframe'd mock both read as pictures, nothing in either
// said an individual element could take a comment, and the reviewer's first move was
// the kicker's block-level button — which is exactly the outcome criterion 10 was
// written against ("the agent receives 'the Send button in the after stage' rather
// than 'the small card'"). Two affordances, one per stage kind, plus the note.

check('both stage kinds tell the reviewer their elements are clickable, and a read-only archive does not', () => {
  const board = createBoard({
    title: 'Stage affordances',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
      { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
    ],
  });
  const page = renderBoardPage(board);
  const markup = renderedMarkup(page);

  const hints = [...markup.matchAll(/<span class="stage-hint">([^<]*)<\/span>/g)].map(m => m[1]);
  assert.equal(hints.length, 2, `expected one hint per stage kind, got: ${JSON.stringify(hints)}`);
  assert.ok(hints.some(h => /click any element/i.test(h)), 'the html stage must say its elements are clickable');
  assert.ok(hints.some(h => /turn on comment mode to click a node/i.test(h)), 'the mermaid stage must say comment mode has to be on before its nodes are clickable');

  // Each hint sits in its own block's kicker, not both in one.
  const htmlKicker = /<div class="block-kicker">HTML stage.*?<\/div>/s.exec(markup);
  const mermaidKicker = /<div class="block-kicker">Mermaid.*?<\/div>/s.exec(markup);
  assert.ok(htmlKicker && htmlKicker[0].includes('stage-hint'), 'the html-stage kicker carries the hint');
  assert.ok(mermaidKicker && mermaidKicker[0].includes('stage-hint'), 'the mermaid kicker carries the hint');

  // Nothing is clickable in a standalone file: archive, so the invitation is hidden
  // there rather than lying. (styles, not markup: the page is byte-identical either
  // way — ticket 05's standalone guarantee.)
  assert.match(page, /body\.readonly \.stage-hint \{[^}]*display: none/, 'a read-only archive must hide the hint');
});

check('a mermaid node highlights under the cursor, and an html stage gets the same affordance injected into its own document', () => {
  // Mermaid renders into the page's own DOM, so the page stylesheet can reach it.
  // Ticket 05: gated on body.comment-mode too, same as everything else this
  // gesture touches -- a diagram node is no longer a standing exception.
  // Bound to a REAL mermaid 11 node id rather than to the selector's spelling. The
  // rules used to be asserted as literal `g[id^="flowchart-"]` text, which is how a
  // dead affordance stayed green: the string matched, and the selector it described
  // matched nothing mermaid actually renders. Here the check builds the id mermaid
  // emits and asks whether the shipped rule would select it.
  const realNodeId = 'mermaid-1785397890978-flowchart-shim-0';
  const hoverSelectors = /(.+):hover \{[^}]*outline: 2px solid var\(--accent\)/.exec(styles);
  assert.ok(hoverSelectors, 'the mermaid hover rule must still exist');
  const cursorRule = new RegExp(`([^{}]+)\\{[^}]*cursor: pointer`).exec(
    styles.slice(styles.indexOf('.mermaid-block svg g')));
  assert.ok(cursorRule, 'the mermaid cursor rule must still exist');

  // Every alternative in the shared selector is scoped and comment-mode gated, and
  // at least one of them selects a real node id.
  const alts = MERMAID_NODE_SELECTOR.split(',').map(s => s.trim());
  assert.ok(alts.length > 0);
  for (const alt of alts) {
    assert.match(styles, new RegExp(`body\\.comment-mode:not\\(\\.readonly\\) \\.mermaid-block svg g${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `the hover/cursor rules must cover the selector alternative ${alt}, scoped and comment-mode gated`);
  }
  const selectsReal = alts.some(alt => {
    const m = /^\[id([\^*]?)="(.+)"\]$/.exec(alt);
    if (!m) return false;
    return m[1] === '*' ? realNodeId.includes(m[2]) : m[1] === '^' ? realNodeId.startsWith(m[2]) : realNodeId === m[2];
  });
  assert.ok(selectsReal, `no alternative in ${MERMAID_NODE_SELECTOR} selects a real mermaid 11 node id (${realNodeId}) — the hover affordance and pointer cursor would be invisible in every browser`);

  // Ticket 10: the html stage is now a genuinely cross-origin iframe (no
  // `allow-same-origin`), so nothing in src/ui.mjs can reach in to inject a
  // stylesheet or track a hover any more -- that lives entirely inside
  // stageAgentScript (src/render.mjs), the string inlined into every html
  // block's `srcdoc`, exercised for real by test/check-click.mjs and friends.
  // This check inspects that one real copy structurally: the affordance must
  // be gated on comment mode actually being ON, not merely present
  // unconditionally (an archived, read-only board never sends `commentMode:
  // true` at all -- src/ui.mjs's `setCommentMode` -- so this is what keeps
  // test/check-archive.mjs's "no hover stylesheet is even injected" true).
  const script = stageAgentScript();
  const modeIdx = script.indexOf("data.type === 'mode'");
  const styleIdx = script.indexOf("createElement('style')");
  const ensureIdx = script.indexOf('function ensureHoverStyle');
  const hoverIdx = script.indexOf("addEventListener('mouseover'");
  assert.ok(modeIdx !== -1, "stageAgentScript must handle the parent's 'mode' message");
  assert.ok(styleIdx !== -1, 'stageAgentScript must inject a stylesheet into the stage document');
  assert.ok(hoverIdx !== -1, 'stageAgentScript must track the hovered element');
  assert.ok(ensureIdx !== -1 && ensureIdx < styleIdx, 'the stylesheet injection must live inside a function, not run unconditionally at script start');
  assert.ok(
    /if \(commentMode\) ensureHoverStyle\(\);/.test(script),
    "the hover stylesheet must be injected lazily, only once comment mode has actually turned on -- never unconditionally at script start (which would inject it into a read-only archive's stage too)",
  );

  // One class name, used by both the rule and the handler that sets it: a rename in
  // either alone would leave a highlight that never shows, with nothing failing.
  const decl = /var HOVER_CLASS = '([^']+)';/.exec(script);
  assert.ok(decl, 'HOVER_CLASS must be declared once in the stage agent script');
  assert.ok(script.includes("'.' + HOVER_CLASS + ' {"), 'the injected rule must be built from HOVER_CLASS');
  assert.ok(script.includes('classList.add(HOVER_CLASS)'), 'the handler must set the same class');
  // Everywhere OTHER than the one declaration itself must reference the
  // variable, never re-spell the class name as a second literal.
  const afterDecl = script.slice(decl.index + decl[0].length);
  assert.ok(!afterDecl.includes(`'${decl[1]}'`), 'the class name must not be repeated as a literal');
});

// --- DESIGN.md polish ticket 02, criterion 12 (html-stage half) -----------------
//
// An element already carrying a SENT comment must be VISIBLY inert inside the
// stage too, not just click-inert (src/ui.mjs's handleStageClick already
// covers the click half). The stage cannot know "sent" on its own -- see
// QUIRKS.md "Two stylesheets, one palette" -- so the parent's 'mode' message
// now carries a 'sentRefs' array the stage uses to pick SENT_CLASS over
// HOVER_CLASS on hover.

check('stageAgentScript de-affordances an already-SENT element on hover: a SENT_CLASS rule, chosen instead of HOVER_CLASS for a ref the parent named sent', () => {
  const script = stageAgentScript();

  // A second class, declared once, with its own rule -- same discipline as
  // HOVER_CLASS just above, checked the same way so the two can never quietly
  // drift out of that discipline independently.
  const sentDecl = /var SENT_CLASS = '([^']+)';/.exec(script);
  assert.ok(sentDecl, 'SENT_CLASS must be declared once in the stage agent script');
  assert.ok(script.includes("'.' + SENT_CLASS + ' {"), 'the de-affordance rule must be built from SENT_CLASS');
  assert.match(script.slice(script.indexOf("'.' + SENT_CLASS + ' {")), /cursor: not-allowed/,
    'the SENT_CLASS rule must set cursor: not-allowed');
  // No outline for a de-affordanced element -- it must not merely look like a
  // DIFFERENT kind of target, it must not look like a target at all. Scoped to
  // the rule's own declaration block, not the whole script (the HOVER_CLASS
  // rule right next to it legitimately does set one).
  const sentRuleBody = /\.' \+ SENT_CLASS \+ ' \{([^}]*)\}/.exec(script);
  assert.ok(sentRuleBody, 'expected to find the SENT_CLASS rule body');
  assert.ok(!/outline/.test(sentRuleBody[1]), 'a de-affordanced element must not carry an outline of any kind');

  // The mouseover handler must actually choose between the two classes based
  // on whether the hovered element's own ref is in sentRefs -- not just declare
  // the class and never use it.
  const hoverBody = script.slice(script.indexOf("addEventListener('mouseover'"));
  const hoverHandlerBody = hoverBody.slice(0, hoverBody.indexOf('});'));
  assert.match(hoverHandlerBody, /sentRefs\.indexOf\(ref\) !== -1/, 'the hover handler must check the hovered ref against sentRefs');
  assert.match(hoverHandlerBody, /classList\.add\(SENT_CLASS\)/, 'a sent ref must get SENT_CLASS');
  assert.match(hoverHandlerBody, /classList\.add\(HOVER_CLASS\)/, 'a non-sent ref must still get the ordinary HOVER_CLASS');

  // clearHover must remove both classes -- leaving SENT_CLASS behind on
  // mouseout would strand a de-affordanced element in that state forever.
  const clearHoverBody = script.slice(script.indexOf('function clearHover'), script.indexOf('function clearHover') + 300);
  assert.match(clearHoverBody, /classList\.remove\(HOVER_CLASS\)/);
  assert.match(clearHoverBody, /classList\.remove\(SENT_CLASS\)/);

  // The 'mode' handler must read sentRefs off the message, shape-checked like
  // every other field this channel carries (see this file's own design
  // comment on shape validation) -- an array of strings, never trusted blind.
  const modeBody = script.slice(script.indexOf("data.type === 'mode'"), script.indexOf("data.type === 'locate'"));
  assert.match(modeBody, /Array\.isArray\(data\.sentRefs\)/, "the 'mode' handler must shape-check sentRefs before using it");
  assert.match(modeBody, /sentRefs = data\.sentRefs\.filter/, "a malformed entry (non-string) must be dropped, not compared against later");
});

check('the parent tells a stage its sentRefs at both the moments that matter: when it first announces ready, and on every mode toggle', () => {
  // handleStageReady: a stage that arrives (or re-arrives, after an amend)
  // needs the CURRENT sent list the moment it is wired, same reasoning as it
  // already needs the current commentMode (this file's own comment on
  // handleStageReady).
  const readyBody = namedFunctionBody(ui, 'handleStageReady');
  assert.ok(readyBody, 'handleStageReady not found');
  assert.match(readyBody, /sentRefs:\s*sentDomRefsForBlock\(blockId\)/, "handleStageReady's postToStage must carry sentRefs");

  // setCommentMode: broadcast to every wired stage on every toggle, not just
  // at ready time -- turning mode ON is exactly the moment the stage's hover
  // starts mattering.
  const setModeBody = namedFunctionBody(ui, 'setCommentMode');
  assert.ok(setModeBody, 'setCommentMode not found');
  assert.match(setModeBody, /sentRefs:\s*blockId \? sentDomRefsForBlock\(blockId\) : \[\]/,
    'setCommentMode\'s broadcast to every wired stage must also carry that stage\'s own sentRefs');

  // sentDomRefsForBlock itself: only 'dom'-kind anchors on the named block --
  // an html-stage's own anchors are always 'dom' (handleStageClick mints
  // nothing else), so a mermaid/md/block comment elsewhere must never leak in.
  const helperBody = namedFunctionBody(ui, 'sentDomRefsForBlock');
  assert.ok(helperBody, 'sentDomRefsForBlock not found');
  assert.match(helperBody, /c\.anchor\.kind === 'dom'/);
});

check('a dom-anchored comment renders its hint and number in the block\'s comment list; a lost one names the ref it lost', () => {
  const board = createBoard({
    title: 'dom comment list',
    blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }],
  });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [
      { blockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'move it' },
      { blockId, anchor: { kind: 'dom', ref: '9.9', hint: 'Launch' }, text: 'stale' },
    ],
  }, 1);
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('#1 · Send'));
  // Ticket 04: the lost tag names the stored hint ("Launch"), not the opaque
  // ref ("9.9") -- see the matching resolveComment check above for why.
  assert.ok(markup.includes('#2 · lost: Launch'));
  assert.ok(markup.includes('comment-lost'));
});

check('a mermaid-anchored comment renders its node id and number in the block\'s comment list; a lost one names the ref it lost', () => {
  const board = createBoard({
    title: 'mermaid comment list',
    blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' }],
  });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [
      { blockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'rename' },
      { blockId, anchor: { kind: 'mermaid', ref: 'Ghost' }, text: 'stale' },
    ],
  }, 1);
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('#1 · A'));
  assert.ok(markup.includes('#2 · lost: Ghost'));
});

check('a question carrying non-markdown context kinds normalises and renders them inline', () => {
  const board = createBoard({
    title: 'Question with mixed context',
    blocks: [{
      kind: 'question',
      prompt: 'Which diagram is right?',
      widget: 'single',
      options: [{ label: 'Left' }, { label: 'Right' }],
      context: [
        { kind: 'mermaid', text: 'flowchart TD\n  X --> Y' },
        { kind: 'html', html: '<p>mock</p>' },
      ],
    }],
  });
  const q = board.blocks[0];
  assert.equal(q.context.length, 2);
  assert.equal(q.context[0].kind, 'mermaid');
  assert.equal(q.context[1].kind, 'html');
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('class="question-context"'));
  assert.ok(markup.includes('<pre class="mermaid">flowchart TD'));
  assert.ok(markup.includes('class="html-stage"'));
});

// --- ticket 05: snapshot and standalone archive ------------------------------------
//
// See DESIGN.md Decisions -> "JSON is truth, the page is a projection" and
// "Questions by value, content by reference, snapshotted at post time". The HTTP
// check (test/check-http.mjs) covers the store-mutation and end-to-end
// rewrite/delete guarantees; these are the pure-function halves: renderBoardPage
// must be byte-exact given the same JSON, and it must never re-read a `source` ref.

check('renderBoardPage is byte-identical across repeated calls, across a JSON round-trip, and after answering', () => {
  const board = createBoard({
    title: 'Byte-exact re-render',
    blocks: [
      { kind: 'markdown', text: '# Acceptance Criteria\n\n- one\n- two' },
      { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  });

  const first = renderBoardPage(board);
  const second = renderBoardPage(board);
  assert.equal(first, second);

  // A board round-tripped through JSON (exactly what store.mjs does on every read)
  // must render identically to the live object -- this is what proves render.mjs
  // depends only on the JSON shape, not on object identity, key insertion order
  // surviving by luck, or any non-enumerable/Map/Set state.
  const roundTripped = JSON.parse(JSON.stringify(board));
  assert.equal(renderBoardPage(roundTripped), first);

  // Answering legitimately changes the page; repeated renders of that *new*
  // snapshot must still be self-identical, and still survive a JSON round-trip.
  applySubmit(board, {
    action: 'send',
    answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: 'ok' }],
    comments: [{ blockId: 'd1', anchor: { kind: 'block' }, text: 'noted' }],
  }, 1);
  const afterAnswer1 = renderBoardPage(board);
  const afterAnswer2 = renderBoardPage(board);
  assert.equal(afterAnswer1, afterAnswer2);
  assert.notEqual(afterAnswer1, first); // sanity: the answer actually changed the page
  assert.equal(renderBoardPage(JSON.parse(JSON.stringify(board))), afterAnswer1);
});

check('a board whose referenced source was rewritten, then deleted, still renders the post-time snapshot byte-for-byte', () => {
  const srcFile = path.join(fixturesDir, 'snapshot-source.md');
  writeFileSync(srcFile, '# Doc\n\noriginal content on screen when answered', 'utf8');

  const board = createBoard({
    title: 'Snapshot guarantee',
    cwd: fixturesDir,
    blocks: [{ kind: 'markdown', source: { path: 'snapshot-source.md' } }],
  });
  const originalText = board.blocks[0].text;
  const originalSha = board.blocks[0].sha;
  assert.ok(originalText.includes('original content on screen when answered'));

  const renderedOriginal = renderBoardPage(board);

  writeFileSync(srcFile, '# Doc\n\nCOMPLETELY REWRITTEN, nothing like the original', 'utf8');
  const afterRewrite = renderBoardPage(board);
  assert.equal(afterRewrite, renderedOriginal); // byte-exact, not "looks similar"
  assert.equal(board.blocks[0].text, originalText);
  assert.equal(board.blocks[0].sha, originalSha);

  unlinkSync(srcFile);
  const afterDelete = renderBoardPage(board);
  assert.equal(afterDelete, renderedOriginal);
  const markup = renderedMarkup(afterDelete);
  assert.ok(markup.includes('original content on screen when answered'));
  assert.ok(!markup.includes('COMPLETELY REWRITTEN'));
});

// --- ticket 05: standalone read-only archive ----------------------------------------
//
// Chrome-automated checks of the interactive layer are out of scope (DESIGN.md
// Testing), so this is a structural check on the shipped mechanism rather than a
// simulated click: the client script (src/ui.mjs, exported as a plain string) must
// decide read-only mode synchronously from the page's own protocol, and every
// listener that would mutate answer/comment state or reach the network must guard
// on that decision. (Ablation-tested: dropping the guard from any one of the
// mutating listeners below makes this check fail.)

/** Extract the body of every `.addEventListener(<event>, function (...) { ... })`
 * callback in `src`, via brace counting (the script has no braces inside string
 * literals in listener bodies, so a naive counter is safe here). */
function listenerBodies(src) {
  const out = [];
  const re = /\.addEventListener\((?:'[^']+'|"[^"]+")\s*,\s*(?:async\s*)?function\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const openIdx = re.lastIndex - 1;
    let depth = 1;
    let j = openIdx + 1;
    while (depth > 0 && j < src.length) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    out.push(src.slice(openIdx + 1, j - 1));
  }
  return out;
}

/** Extract the body of a top-level `function <name>(...) { ... }` declaration in
 * `src`, via the same brace-counting as listenerBodies. Returns null if `name`
 * isn't found. Used to check *ordering* within a single function (e.g. "the pin
 * render call happens before the readonly early-return, not after") -- something a
 * whole-file substring search can't pin down, since it can't tell which
 * `if (readonly) return;` among several in the file a given call precedes. */
function namedFunctionBody(src, name) {
  const marker = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = marker.exec(src);
  if (!m) return null;
  const openIdx = m.index + m[0].length - 1;
  let depth = 1;
  let j = openIdx + 1;
  while (depth > 0 && j < src.length) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') depth--;
    j++;
  }
  return src.slice(openIdx + 1, j - 1);
}

check('mode detection is synchronous, from the document\'s own protocol -- never a network probe to the daemon', () => {
  assert.ok(/var readonly\s*=\s*\(location\.protocol === 'file:'\)/.test(ui));
  // Exactly two fetches, both accounted for: the submit, and the resync that
  // catches this client up on anything broadcast while it was disconnected. Any
  // third one is a network call nobody has justified -- in particular, mode
  // detection must never become a probe to the daemon.
  const fetchCalls = [...ui.matchAll(/fetch\(([^)]*)/g)].map(m => m[1]);
  assert.equal(fetchCalls.length, 2, `expected exactly the submit and resync fetches, found ${fetchCalls.length}`);
  assert.ok(fetchCalls.some(c => c.includes('/submit')), 'one fetch must be the submit');
  assert.ok(fetchCalls.some(c => c.includes("'/b/'")), 'the other must be the resync read of the board');
  // Both live behind a readonly guard: the standalone file:// archive is
  // network-free, period.
  assert.match(namedFunctionBody(ui, 'resync'), /if \(readonly\) return;/);
});

check('every ui.mjs listener that mutates answer/comment state or submits guards on readonly', () => {
  const bodies = listenerBodies(ui);
  // submitBoard( is in this list because the fetch now lives inside that one
  // shared function (Send and Discuss in chat post the same body to the same
  // route, differing only in `action`) rather than inline in a click listener --
  // the listeners that reach it must still be as inert in readonly as the ones
  // that write selections/notes/deferred directly.
  const mutators = bodies.filter(b => /selections\[|notes\[|deferred\[|pendingComments\.push|fetch\(|submitBoard\(/.test(b));
  assert.ok(mutators.length >= 9, `expected at least 9 mutating/submitting listeners, found ${mutators.length}`);
  for (const b of mutators) {
    assert.ok(/\breadonly\b/.test(b), `listener mutates state without checking readonly:\n${b}`);
  }
  // ...and the shared submit path guards on its own account too, so a future
  // caller that forgets can't post from a read-only page.
  const submitBody = namedFunctionBody(ui, 'submitBoard');
  assert.ok(submitBody, 'expected a single shared submitBoard(action) in src/ui.mjs');
  assert.ok(/^\s*if \(readonly\) return;/.test(submitBody), 'submitBoard must return early in readonly mode');
});

// --- ticket 06: the click-to-comment gesture must be inert in read-only mode, ---
// exactly like every other mutating listener above, and pin rendering (which is
// what makes an archived board still show its pins) must NOT be gated on it.

check('the html-stage and mermaid element-click listeners guard on readonly too, so click-to-comment is inert in read-only mode', () => {
  const bodies = listenerBodies(ui);
  const anchorClickBodies = bodies.filter(b => /openCommentForm\(/.test(b));
  // Ticket 03 named 4 listeners that open a comment form: .comment-btn, the
  // html-stage click, the mermaid click, and the generic comment-mode click.
  // Ticket 10 moved the html-stage one behind a postMessage dispatch --
  // `openCommentForm(` no longer appears literally inside an
  // `addEventListener` callback for that case, only inside the named
  // `handleStageClick` helper the single `message` listener calls. Ticket 05 of
  // The polish batch (DESIGN.md) did the same to the mermaid one, for the same kind of reason:
  // a diagram node can now be clicked in TWO places (inline, and inside the
  // lens) and both must mint the identical anchor, so both call one named
  // `mintMermaidComment` instead of each opening a form themselves. The literal
  // body count is therefore down to 2, and the two extracted helpers are
  // asserted below for exactly the property the inline versions used to prove.
  assert.equal(anchorClickBodies.length, 2, 'expected exactly 2 DIRECT listeners that open a comment form: .comment-btn, the generic comment-mode click');
  for (const b of anchorClickBodies) {
    assert.ok(/\breadonly\b/.test(b), `a listener opens a comment form without checking readonly:\n${b}`);
  }

  const stageClickBody = namedFunctionBody(ui, 'handleStageClick');
  assert.ok(stageClickBody, 'handleStageClick not found -- the html-stage click is minted here, dispatched from the single window message listener');
  assert.ok(/openCommentForm\(/.test(stageClickBody), 'handleStageClick must open a comment form');
  assert.ok(/\breadonly\b/.test(stageClickBody), 'handleStageClick opens a comment form without checking readonly');

  // DESIGN.md polish ticket 05: the mermaid half. One minting function, and every
  // listener that reaches it carries the same readonly guard the inline mermaid
  // listener used to carry on its own -- including the lens's, which is the
  // whole of "the comment gesture inside it is gated exactly like every other
  // comment gesture" (the spec's own Decision on the readonly lens).
  const mintBody = namedFunctionBody(ui, 'mintMermaidComment');
  assert.ok(mintBody, 'mintMermaidComment not found -- both diagram-node click paths mint through it');
  assert.ok(/openCommentForm\(/.test(mintBody), 'mintMermaidComment must open a comment form');
  const mintCallers = bodies.filter(b => /mintMermaidComment\(/.test(b));
  assert.equal(mintCallers.length, 2, `expected exactly 2 listeners minting a mermaid comment -- the inline diagram click and the lens's -- found ${mintCallers.length}`);
  for (const b of mintCallers) {
    assert.ok(/\breadonly\b/.test(b), `a diagram-node click listener mints a comment without checking readonly:\n${b}`);
  }
});

check('pin rendering is never gated by readonly, only the click/hover gesture is -- an archived (readonly) board still shows its pins', () => {
  // wireMermaidBlock's shape is unchanged: one function, pin rendering then a
  // readonly early-return before the click listener, so ordering WITHIN that
  // one function is still the right thing to pin down (ablation-verified --
  // moving the guard above the pin-render call in a scratch copy left a
  // weaker, presence-only version of this check green).
  const mermaidBody = namedFunctionBody(ui, 'wireMermaidBlock');
  assert.ok(mermaidBody, 'wireMermaidBlock not found');
  const pinIdxMermaid = mermaidBody.indexOf('renderMermaidPins(');
  const guardIdxMermaid = mermaidBody.indexOf('if (readonly'); // wireMermaidBlock's guard also checks `|| !svg`
  assert.ok(pinIdxMermaid !== -1, 'wireMermaidBlock must call renderMermaidPins');
  assert.ok(guardIdxMermaid !== -1, 'wireMermaidBlock must have a readonly early-return gating the click listener');
  assert.ok(pinIdxMermaid < guardIdxMermaid, 'renderMermaidPins must run before the readonly early-return, not after -- otherwise an archived board loses its pins');

  // Ticket 10: the html-stage case no longer has one function with an
  // ordering to pin down -- pin positioning (handleStageReady ->
  // requestStagePositions, fired the moment a stage announces itself
  // 'ready') and the click gesture (handleStageClick) are separate functions
  // dispatched from one message listener, so the equivalent property is that
  // NEITHER handleStageReady NOR requestStagePositions ever checks `readonly`
  // at all (nothing gates drawing a pin), while handleStageClick does (see
  // the previous check, which already asserts that half). A stage never even
  // being TOLD comment mode is on in the first place -- setCommentMode
  // refusing readonly -- is what keeps the archived gesture inert instead;
  // this is what keeps the archived PINS visible.
  const readyBody = namedFunctionBody(ui, 'handleStageReady');
  const requestBody = namedFunctionBody(ui, 'requestStagePositions');
  assert.ok(readyBody, 'handleStageReady not found');
  assert.ok(requestBody, 'requestStagePositions not found');
  assert.ok(!/\breadonly\b/.test(readyBody), 'handleStageReady must never gate on readonly -- an archived stage still needs its pins positioned');
  assert.ok(!/\breadonly\b/.test(requestBody), 'requestStagePositions must never gate on readonly -- an archived stage still needs its pins positioned');
});

// --- the lens's pointer capture (DESIGN.md polish ticket 05) ---------------------
//
// Asserted structurally, and only because the behaviour is genuinely out of
// reach here: there is no such thing as pointer capture in this repo's DOM
// stand-in, so a check that drives the lens there cannot tell the two versions
// apart. It is not a hypothetical -- it was MEASURED in Chrome during this
// ticket. Taking the capture on 'pointerdown' makes the browser retarget
// everything after it, the resulting 'click' included, at the capture element,
// so the lens's click handler saw '.lens-stage' instead of the diagram node the
// pointer was over and clicking a node in the lens silently did nothing, with
// every check in test/check-mermaid-anchor.mjs green. Same precedent as ticket
// 02's stage half (see its log): the shape is pinned here, the behaviour rests
// on the in-browser drive.
//
// The limit of this check, stated rather than left to be discovered a second
// time: it constrains the ORDER of two lines and nothing else. It passed
// throughout the period when the threshold those lines sit behind measured the
// wrong quantity entirely (finding D5 -- `drag.x/y` reassigned every move, so
// the gate asked "did this ONE FRAME move more than 3px" and a slow pan never
// crossed it, leaving both lines permanently unreached), and it still passes
// against a pointermove handler whose first statement is `return;`. The
// BEHAVIOUR now has behavioural cover: test/check-mermaid-anchor.mjs dispatches
// a real 120px pan as sixty 2px moves and asserts on the outcome. What is left
// here is the one property that genuinely has no behavioural reach -- the
// stand-in has no pointer capture at all -- plus a guard against the no-op case
// so this can never again be green over a handler that does nothing.
check('the lens takes pointer capture only once a press has become a pan, never on the press itself -- or the comment gesture inside the lens is dead in every browser', () => {
  const bodies = listenerBodies(ui);
  const captureCalls = bodies.filter(b => /setPointerCapture\(/.test(b));
  assert.equal(captureCalls.length, 1, `exactly one listener may take pointer capture, found ${captureCalls.length}`);
  const [body] = captureCalls;
  assert.ok(/pointermove/.test(ui.slice(Math.max(0, ui.indexOf(body) - 200), ui.indexOf(body))),
    'the capture must be taken from the pointermove handler, not from pointerdown');
  assert.ok(/lensDragMoved = true;[\s\S]{0,400}setPointerCapture\(/.test(body),
    'the capture must be taken only after the drag threshold has been crossed -- a plain click must never have capture active');
  // Not a no-op: the first statement of the handler must not be an
  // unconditional early return, which would satisfy every assertion above
  // while the pan gesture did nothing at all.
  assert.ok(!/^\s*return\s*;/.test(body),
    'the pointermove handler must not begin with an unconditional return -- the assertions above constrain the order of two lines, not whether either is ever reached');
});

check('readonly mode hard-disables every input-capable element and strips native drag, not just CSS pointer-events', () => {
  assert.ok(/if \(readonly\) \{[\s\S]*?el\.disabled = true;/.test(ui));
  assert.ok(ui.includes("qsa('textarea, input, button')"));
  assert.ok(ui.includes('removeAttribute(\'draggable\')'));
});

check('CSS gates the readonly banner and Send bar strictly on body.readonly', () => {
  assert.ok(styles.includes('.readonly-banner { display: none;'));
  assert.ok(styles.includes('body.readonly .readonly-banner { display: block; }'));
  assert.ok(styles.includes('body.readonly .send-bar { display: none; }'));
});

check('renderBoardPage always emits the readonly-banner element in the body markup (client JS decides visibility)', () => {
  const board = createBoard({ title: 'Banner', blocks: [] });
  assert.ok(renderedMarkup(renderBoardPage(board)).includes('class="readonly-banner"'));
});

// --- ticket 04: SSE push is applied additively, never a wholesale re-render -----
//
// Field preservation on a push is browser-DOM behaviour, which DESIGN.md's
// Testing section explicitly puts out of automated scope ("checked by opening a
// board and using it"). What IS provable here without a browser: the client script
// never wipes the live board container and only ever inserts/replaces targeted
// nodes, and it subscribes over SSE only in the same circumstances every other
// daemon-only capability is allowed to run.

check('the client script never wholesale-replaces the blocks container on a push -- only targeted insertion/replacement', () => {
  // Ablation: if applyRoundPush did `document.getElementById('blocks').innerHTML =
  // data.html` (or similar on any live container) instead of building a detached
  // wrapper and moving/replacing individual nodes, this fails.
  assert.ok(
    !/getElementById\('blocks'\)\.innerHTML\s*=/.test(ui) && !/querySelector\('\.blocks'\)\.innerHTML\s*=/.test(ui),
    'a push must never reassign innerHTML on the live blocks container',
  );
  assert.ok(ui.includes('new EventSource('), 'the page must subscribe to round pushes over SSE');
  assert.ok(/appendChild|replaceWith/.test(ui), 'a push must be applied via targeted DOM insertion/replacement, not a blanket re-render');
});

check('SSE subscription is guarded exactly like every other daemon-only capability -- never opened in readonly (file://) mode', () => {
  const idx = ui.indexOf('new EventSource(');
  assert.ok(idx !== -1);
  const before = ui.slice(Math.max(0, idx - 200), idx);
  assert.ok(/if\s*\(\s*!readonly/.test(before), 'EventSource must only be opened when the page is not in readonly mode (ablation: dropping this guard would open a network connection from the standalone file:// archive)');
});

check('a push seeds newly-appeared block answers through the same computeBoardPatch used elsewhere -- it does not touch any existing block\'s selections/notes/deferred entries', () => {
  // Structural proof that field preservation rests on computeBoardPatch's
  // added/changed sets, not on some separate ad-hoc mechanism: the only place
  // selections/notes/deferred are seeded from server data outside of the initial
  // hydrate is seedAnswers(patch.addedBlockIds.concat(patch.changedBlockIds), ...).
  assert.ok(ui.includes('seedAnswers(patch.addedBlockIds.concat(patch.changedBlockIds)'));
  assert.equal([...ui.matchAll(/\bselections\[/g)].length >= 1, true);
});

check('a push wires the freshly-parsed fragment BEFORE inserting it into the live document -- never re-wiring blocks the push did not touch', () => {
  // Real bug found and fixed during audit: wireRoot(container) / wireRoot(roundSection)
  // called AFTER moving the new nodes into the live #blocks / round section
  // re-registers every listener on every block ALREADY there too (wireRoot has no
  // idempotence guard -- an already-wired element gets a second listener set).
  // Confirmed by direct experiment: two listeners on the same multi-select button
  // toggle it on then immediately back off, so multi-select and Defer become
  // silent no-ops after any push. Fix: wire the DETACHED wrap/frag first --
  // querySelectorAll and addEventListener behave identically whether or not the
  // subtree is attached to the document, and the listeners survive the later
  // move -- so wireRoot's own scope is exactly the new nodes, never anything
  // already on screen. This asserts the ORDER, which is the only thing that
  // actually prevents the double-registration (ablation: swapping the two lines
  // back reproduces the bug and this check fails).
  const newRoundIdx = ui.indexOf("data.mode === 'new-round'");
  const newRoundBlock = ui.slice(newRoundIdx, ui.indexOf("} else if (data.mode === 'amend')", newRoundIdx));
  const wireIdxA = newRoundBlock.indexOf('wireRoot(wrap)');
  const appendIdxA = newRoundBlock.indexOf('container.appendChild(node)');
  assert.ok(wireIdxA !== -1 && appendIdxA !== -1, 'expected wireRoot(wrap) and container.appendChild(node) in the new-round push branch');
  assert.ok(wireIdxA < appendIdxA, 'wireRoot(wrap) must run before the new nodes are appended into the live #blocks container');

  const amendIdx = ui.indexOf("data.mode === 'amend'");
  const amendBlock = ui.slice(amendIdx, ui.indexOf('patch.roundsNowSent.forEach', amendIdx));
  const wireIdxB = amendBlock.indexOf('wireRoot(frag)');
  const replaceIdxB = amendBlock.indexOf('.replaceWith(blockEl)');
  assert.ok(wireIdxB !== -1 && replaceIdxB !== -1, 'expected wireRoot(frag) and .replaceWith(blockEl) in the amend push branch');
  assert.ok(wireIdxB < replaceIdxB, 'wireRoot(frag) must run before the amended blocks replace/join the live round section');
});

// --- ticket 04 / ticket 06 merge: element-level anchoring must be wired on -----
// content that arrives over a push, not just on what was on the page at hydrate.
//
// Before this merge, ticket 06's html-stage wiring was a separate, unscoped,
// run-once-at-load pass (`qsa('.html-stage')`, no root, executed exactly once
// right after hydrate) -- correct for round 1, but silently inert for any html
// or mermaid stage that arrives in a round pushed later over SSE, since nothing
// ever re-ran that pass. Folding it into wireRoot(root), scoped to root exactly
// like every other wiring loop, is what makes anchoring keep working after a
// push. The two checks below prove this end to end without a browser: the first
// proves anchoring wiring genuinely lives inside wireRoot (not bolted on as a
// second, separate pass); the second proves every DOM-insertion branch that
// handles a push actually calls wireRoot on the content it just inserted. Neither
// fact alone is sufficient -- ticket 04's push code could wire a subtree that
// never wires anchors, or the anchoring wiring could live somewhere a push never
// reaches -- so both need to hold, and did not both hold on either side of this
// merge before it was resolved this way.

check('element-level anchoring on a pushed html stage needs no per-push wiring pass at all -- ticket 10 replaced the root-scoped DOM wiring this check used to require with a page-level, push-agnostic message listener', () => {
  // Before ticket 10: `wireHtmlStage` reached into `frame.contentDocument`
  // directly, so a pushed stage had to be found and wired EXPLICITLY, inside
  // wireRoot, scoped to whatever subtree a push actually inserted -- an
  // unscoped, run-once-at-load pass was silently inert for anything pushed
  // later (see this section's own header comment on the ticket 04/06 merge
  // this check was originally written to prove). Ticket 10 drops
  // `allow-same-origin`, so that direct reach is impossible now regardless of
  // scoping -- and, structurally, unnecessary: a stage's own agent script
  // announces itself 'ready' the moment it runs, wherever/whenever its
  // iframe ends up in the document, and ONE page-level
  // `window.addEventListener('message', ...)` (registered once, never
  // inside wireRoot, never re-registered per push) reacts to it. So the
  // property this check now proves is the opposite shape of before: there is
  // NO root-scoped html-stage wiring loop left inside wireRoot to find (an
  // ablation that reintroduced one would be regressing toward the pre-
  // ticket-10 architecture, not fixing anything), and exactly one page-level
  // message listener exists, declared outside wireRoot.
  const wireRootBody = namedFunctionBody(ui, 'wireRoot');
  assert.ok(wireRootBody, 'wireRoot not found');
  assert.ok(
    !wireRootBody.includes("qsa('.html-stage'"),
    'wireRoot must not contain an html-stage-specific wiring loop any more -- ticket 10 replaced it with a page-level message listener; a match here means the old, contentDocument-reaching architecture crept back in',
  );

  const messageListenerSites = [...ui.matchAll(/window\.addEventListener\('message', function \(ev\) \{/g)];
  assert.equal(messageListenerSites.length, 1, 'expected exactly one window-level "message" listener');
  const messageListenerIdx = messageListenerSites[0].index;
  const wireRootIdx = ui.indexOf('function wireRoot(root)');
  assert.ok(wireRootIdx !== -1, 'wireRoot not found');
  const wireRootEnd = wireRootIdx + namedFunctionBody(ui, 'wireRoot').length;
  assert.ok(
    messageListenerIdx < wireRootIdx || messageListenerIdx > wireRootEnd,
    'the message listener must be registered OUTSIDE wireRoot -- once for the page\'s whole lifetime, not re-registered on every push (which would double-handle every later stage\'s messages)',
  );

  // The actual end-to-end proof that a pushed html stage is genuinely
  // anchorable -- comment mode on, click the pushed element, a pin lands --
  // lives in test/check-anchor-push.mjs, driven through the real
  // subscription src/ui.mjs itself opens, exactly the kind of check
  // DESIGN.md's Testing section asks for over a structural one like
  // this file's own checks.
});

check('a round pushed over SSE has its html/mermaid stages wired for anchoring: applyRoundPush and applySubmittedPush call wireRoot on exactly the content they insert', () => {
  // Combined with the previous check, this proves a pushed html/mermaid block
  // ends up exactly as anchorable as one that was on the page at load. Ablation:
  // deleting any one of these three wireRoot(...) calls (or pointing it at the
  // wrong variable) makes this fail, and -- because anchoring wiring lives inside
  // wireRoot per the previous check -- would also mean that push silently never
  // wires anchoring on the content it inserts.
  const pushBody = namedFunctionBody(ui, 'applyRoundPush');
  assert.ok(pushBody, 'applyRoundPush not found');
  assert.ok(/wireRoot\(wrap\)/.test(pushBody), 'the new-round branch must wire the round fragment it just parsed');
  assert.ok(/wireRoot\(frag\)/.test(pushBody), 'the amend branch must wire the blocks it just parsed');

  const submittedBody = namedFunctionBody(ui, 'applySubmittedPush');
  assert.ok(submittedBody, 'applySubmittedPush not found');
  assert.ok(
    /wireRoot\(replacement\)/.test(submittedBody),
    'the submitted-round swap-in must also wire its replacement content -- a round that just went out can still carry an html/mermaid stage whose EXISTING pins/comments are worth showing correctly',
  );
});

check('an amend that replaces a block clears the reviewer\'s local field state for that block, rather than leaving a stale, invisible value behind', () => {
  // Real bug found and fixed during audit: a replace-amend re-renders the block
  // fresh from the server (an open round's textarea comes back empty, since
  // board.answers has no entry yet), but the client's own `selections`/`notes`
  // dicts were left untouched -- so a reviewer who had typed something into a
  // block that then got replaced would see a BLANK field on screen while Send
  // still submitted their old, now-invisible text. Fix: clearFieldState() runs
  // on patch.changedBlockIds before seeding, so a replaced block always starts
  // clean.
  assert.ok(ui.includes('clearFieldState(patch.changedBlockIds)'));
  const clearIdx = ui.indexOf('function clearFieldState');
  const clearBody = ui.slice(clearIdx, ui.indexOf('}\n', ui.indexOf('}\n', clearIdx) + 1));
  assert.ok(/delete selections\[id\]/.test(clearBody));
  assert.ok(/delete notes\[id\]/.test(clearBody));
  assert.ok(/delete deferred\[id\]/.test(clearBody));
  assert.ok(/delete touched\[id\]/.test(clearBody));
});

check('the emitted page has no external script or stylesheet reference -- everything needed to open standalone is inlined', () => {
  const board = createBoard({
    title: 'Standalone',
    blocks: [{ kind: 'markdown', text: '# A' }, { kind: 'question', prompt: 'Q', widget: 'single', options: [{ label: 'X' }] }],
  });
  const html = renderBoardPage(board);
  assert.ok(!/<link[^>]+rel=["']stylesheet["']/.test(html));
  assert.ok(!/<script[^>]+\bsrc=/.test(html));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('id="board-data"'));
});

// =================================================================================
// Audit regressions (2026-07-28). Each check below fails without its fix; the
// ablation that proves it is named in the check's own comment.
// =================================================================================

// --- H4 / N5: block ids are the board's only join key ----------------------------

check('H4: a caller-supplied id raises the ordinal counter, so the next minted id cannot collide with it', () => {
  // Ablation: drop BOTH of resolveBlockId's collision guards (the
  // `counters[m[1]] = Math.max(...)` bump and the `while (ids.taken.has(id) ||
  // ids.minted.has(id))` skip -- either alone still holds, which is the point) and
  // both blocks come back as 'q1'. board.answers is keyed by id, so the two
  // questions collapse to one entry and the packet reports the reviewer's answer to
  // "Ship it?" against the prompt "Delete the table?". Verified: the deepEqual below
  // fails with ['q1','q1'].
  const board = createBoard({
    title: 'dup',
    blocks: [
      { kind: 'question', id: 'q1', prompt: 'Ship it?', widget: 'single', options: [{ label: 'yes' }, { label: 'no' }] },
      { kind: 'question', prompt: 'Delete the table?', widget: 'single', options: [{ label: 'yes' }, { label: 'no' }] },
    ],
  });
  assert.deepEqual(board.blocks.map(b => b.id), ['q1', 'q2']);

  applySubmit(board, {
    action: 'send',
    answers: [
      { id: 'q1', status: 'answered', choice: 'yes', note: '' },
      { id: 'q2', status: 'answered', choice: 'no', note: '' },
    ],
    comments: [],
  }, 1);
  const packet = buildPacket(board, 1, 'http://x');
  const byPrompt = Object.fromEntries(packet.answers.map(a => [a.prompt, a.choice]));
  assert.equal(byPrompt['Ship it?'], 'yes');
  assert.equal(byPrompt['Delete the table?'], 'no');
});

check('H4: two blocks in one post cannot claim the same id', () => {
  // Ablation: remove the `ids.minted.has(id)` branch and both blocks are minted as
  // 'q1', silently.
  assert.throws(
    () => createBoard({
      title: 'dup',
      blocks: [
        { kind: 'question', id: 'q1', prompt: 'A', widget: 'single', options: [{ label: 'x' }] },
        { kind: 'question', id: 'q1', prompt: 'B', widget: 'single', options: [{ label: 'x' }] },
      ],
    }),
    /duplicate block id q1/,
  );
});

check('H4: addRound refuses an id that already exists on the board -- a Send racing an amend cannot destroy round 1\'s answer', () => {
  // Ablation: remove `idLedgerFromBoard` from addRound (pass emptyIdLedger()) and the
  // second q1 is appended into round 2, board.answers['q1'] is overwritten by the new
  // block's answer, and round 1's history rail renders a question with no answer.
  const board = createBoard({
    title: 't',
    blocks: [{ kind: 'question', prompt: 'Round one?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  applySubmit(board, { action: 'send', answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);

  assert.throws(
    () => addRound(board, { blocks: [{ id: 'q1', kind: 'question', prompt: 'Hijacked', widget: 'single', options: [{ label: 'Yes' }] }] }),
    /belongs to round 1/,
  );
  assert.equal(board.rounds.length, 1, 'the rejected addRound must not have minted a round');
  assert.equal(board.blocks.length, 1);
  assert.equal(board.blocks[0].prompt, 'Round one?');
  assert.equal(board.answers.q1.choice, 'Yes');
});

check('N5: a caller-supplied id must carry the kind letter of the block it names', () => {
  // Ablation: drop the `m[1] !== KIND_LETTER[kind]` branch. Then `{kind:'markdown',
  // id:'q2'}` is accepted while `counters.q` stays at 1, the next question mints
  // 'q2', collides with the markdown block and REPLACES it -- the markdown silently
  // vanishes from the board and any comment anchored to it now resolves against a
  // question block.
  assert.throws(
    () => createBoard({ title: 't', blocks: [{ kind: 'markdown', id: 'q2', text: '# A' }] }),
    /does not start with the 'd' letter/,
  );
  const board = createBoard({
    title: 't',
    blocks: [
      { kind: 'question', prompt: 'Q1', widget: 'single', options: [{ label: 'x' }] },
      { kind: 'markdown', text: '# A' },
    ],
  });
  amendRound(board, { blocks: [{ kind: 'markdown', id: 'd1', text: '# A revised' }] });
  assert.equal(board.blocks.length, 2, 'a same-letter amend still replaces in place');
  assert.equal(board.blocks[1].text, '# A revised');
});

// --- C2: content resolution is confined to the board's project directory ---------

check('C2: an absolute reference path is refused, not read', () => {
  // Ablation: restore `path.isAbsolute(ref.path) ? ref.path : ...` in resolvePath and
  // /etc/passwd's contents land in the board JSON and the served page.
  const r = resolveRef({ path: '/etc/passwd' }, { cwd: fixturesDir });
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /absolute/);
  assert.equal(r.text, undefined);
});

check('C2: a relative reference cannot traverse out of the board cwd with ../', () => {
  // Ablation: remove the path.relative()/startsWith('..') check and this reads
  // /etc/hosts.
  const nested = path.join(fixturesDir, 'deep', 'deeper');
  mkdirSync(nested, { recursive: true });
  const r = resolveRef({ path: '../../../../../../../../etc/hosts' }, { cwd: nested });
  assert.equal(typeof r.error, 'string');
  assert.equal(r.text, undefined);
});

check('C2: a symlink pointing out of the board cwd is refused -- confinement is on the REALPATH, not the spelling', () => {
  // Ablation: resolve with path.resolve() instead of realpathSync() and the symlink
  // reads straight through, since its own spelling never leaves the project.
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'exfiltrated', 'utf8');
    const link = path.join(fixturesDir, 'escape-link');
    try { unlinkSync(link); } catch { /* not there yet */ }
    symlinkSync(path.join(outside, 'secret.txt'), link);
    const r = resolveRef({ path: 'escape-link' }, { cwd: fixturesDir });
    assert.equal(typeof r.error, 'string');
    assert.equal(r.text, undefined);
    assert.ok(!String(r.text ?? '').includes('exfiltrated'));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

check('C2: an ordinary relative reference inside the project still resolves, and resolvePath reports {path} not a bare string', () => {
  writeFileSync(path.join(fixturesDir, 'inside.txt'), 'still works', 'utf8');
  assert.equal(resolveRef({ path: 'inside.txt' }, { cwd: fixturesDir }).text, 'still works');
  assert.equal(resolvePath({ path: 'inside.txt' }, fixturesDir).error, undefined);
  assert.ok(resolvePath({ path: 'inside.txt' }, fixturesDir).path.endsWith('inside.txt'));
});

// --- the reference allowlist (ADR.md entry 3, DESIGN.md polish criterion 13) -------
//
// References now resolve inside `cwd` OR inside a configured root (default
// `~/.claude`), and nowhere else. This is the one security boundary this batch moves,
// so both halves are asserted rather than hand-verified: an allowlisted path resolves
// AND reaches the page, and a path outside both is still refused -- with the same two
// error strings it was refused with when `cwd` was the whole boundary, spelled out
// here in full so a quiet rewording cannot pass as "still refused".

const ABSOLUTE_REFUSAL = p => `refusing absolute reference path ${p}: references resolve inside the board's project directory`;
const OUTSIDE_REFUSAL = p => `refusing reference ${p}: resolves outside the board's project directory`;

/** Run `fn` with CLAUDE_BOARD_REF_ROOTS set to `spec` (or unset, for `undefined`),
 * restoring whatever this process actually has afterwards. The daemon reads the
 * variable, so the end-to-end half of criterion 13 has to go through it rather than
 * through the `roots` parameter. */
function withRefRoots(spec, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_BOARD_REF_ROOTS');
  const prev = process.env.CLAUDE_BOARD_REF_ROOTS;
  if (spec === undefined) delete process.env.CLAUDE_BOARD_REF_ROOTS;
  else process.env.CLAUDE_BOARD_REF_ROOTS = spec;
  try {
    return fn();
  } finally {
    if (had) process.env.CLAUDE_BOARD_REF_ROOTS = prev;
    else delete process.env.CLAUDE_BOARD_REF_ROOTS;
  }
}

check('allowlist: a reference under an allowlisted root resolves, and its content reaches the rendered page', () => {
  // Ablation: drop the insideRoots() branch in resolvePath and this is the red
  // refusal box the whole ticket exists to remove -- a session discussing a skill
  // file cannot show it.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-refroot-'));
  const project = mkdtempSync(path.join(tmpdir(), 'claude-board-refproject-'));
  try {
    mkdirSync(path.join(root, 'skills', 'explain'), { recursive: true });
    const skill = path.join(root, 'skills', 'explain', 'SKILL.md');
    writeFileSync(skill, '# Explain\n\nthe skill file this session is discussing\n', 'utf8');

    // Absolute, because that is how ~/.claude content is addressed: from a project
    // directory it has no relative spelling that is not a pile of `../`.
    const resolved = resolvePath({ path: skill }, project, [realpathSync(root)]);
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.path, realpathSync(skill));

    // A typo inside a root reads as the missing file it is, not as "absolute paths
    // are refused" -- the latter would send the agent looking for the wrong fix. The
    // reason is spelled out rather than lifted from errno; see the oracle check below.
    const typo = path.join(root, 'skills', 'explain', 'SKILL.mb');
    assert.match(resolvePath({ path: typo }, project, [realpathSync(root)]).error, /cannot read .*no such file/);

    // ...and end to end, through CLAUDE_BOARD_REF_ROOTS, which is the only way the
    // daemon under launchd ever learns about a root.
    withRefRoots(root, () => {
      const board = createBoard({
        title: 'allowlisted reference',
        cwd: project,
        blocks: [{ kind: 'markdown', source: { path: skill } }],
      });
      assert.equal(board.blocks[0].error, undefined, `expected no resolve error, got: ${board.blocks[0].error}`);
      assert.ok(board.blocks[0].text.includes('the skill file this session is discussing'));
      const markup = renderedMarkup(renderBoardPage(board));
      assert.ok(markup.includes('the skill file this session is discussing'), 'the resolved content must render on the page');
      assert.ok(!markup.includes('class="resolve-error"'), 'an allowlisted reference must not render as a refusal');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

check('allowlist: a path outside BOTH cwd and the allowlist is still refused, with the existing error', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-refroot-outside-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-outside-both-'));
  try {
    writeFileSync(path.join(root, 'allowed.md'), 'allowed', 'utf8');
    writeFileSync(path.join(outside, 'secret.txt'), 'exfiltrated', 'utf8');
    const roots = [realpathSync(root)];

    // An absolute path naming nothing inside a root: the refusal that has always
    // covered /etc/passwd, unchanged, wording included.
    const abs = resolvePath({ path: '/etc/passwd' }, fixturesDir, roots);
    assert.equal(abs.path, undefined);
    assert.equal(abs.error, ABSOLUTE_REFUSAL('/etc/passwd'));

    // ...including one that only *looks* allowlisted until it is normalised. Built by
    // concatenation, not path.join, which would normalise the `..` away before
    // resolvePath ever saw it.
    const sneaky = `${realpathSync(root)}/../${path.basename(realpathSync(outside))}/secret.txt`;
    assert.equal(resolvePath({ path: sneaky }, fixturesDir, roots).error, ABSOLUTE_REFUSAL(sneaky));

    // A relative path traversing out of the project and landing outside every root.
    const rel = path.relative(realpathSync(fixturesDir), path.join(realpathSync(outside), 'secret.txt'));
    const traversal = resolvePath({ path: rel }, fixturesDir, roots);
    assert.equal(traversal.path, undefined);
    assert.equal(traversal.error, OUTSIDE_REFUSAL(rel));

    // And the whole way through resolveRef: refused means not read.
    const r = resolveRef({ path: rel }, { cwd: fixturesDir, roots });
    assert.equal(r.text, undefined);
    assert.equal(r.error, OUTSIDE_REFUSAL(rel));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

check('SPEC_HTMLREF.md criterion 4: a referenced html path outside cwd and every allowlisted root is refused as a block-level error, on the same terms as any other kind\'s ref', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-html-outside-'));
  try {
    const secret = path.join(outside, 'secret.html');
    writeFileSync(secret, '<script>alert(document.cookie)</script>', 'utf8');

    // Absolute, naming nothing inside a root -- the identical refusal an absolute
    // code reference to the same path gets, since both route through resolveRef
    // with no kind-specific carve-out.
    const htmlBoard = createBoard({
      title: 'html source, absolute path refused',
      cwd: fixturesDir,
      blocks: [{ kind: 'html', source: { path: secret } }],
    });
    const codeBoard = createBoard({
      title: 'code source, absolute path refused (for comparison)',
      cwd: fixturesDir,
      blocks: [{ kind: 'code', source: { path: secret } }],
    });
    assert.equal(htmlBoard.blocks[0].error, ABSOLUTE_REFUSAL(secret));
    assert.equal(htmlBoard.blocks[0].error, codeBoard.blocks[0].error, 'html is confined on the same terms as any other kind');
    assert.equal(htmlBoard.blocks[0].html, '');

    // A relative reference that traverses out of the project.
    const rel = path.relative(realpathSync(fixturesDir), secret);
    const relBoard = createBoard({
      title: 'html source, traversal refused',
      cwd: fixturesDir,
      blocks: [{ kind: 'html', source: { path: rel } }],
    });
    assert.equal(relBoard.blocks[0].error, OUTSIDE_REFUSAL(rel));
    assert.ok(!(relBoard.blocks[0].html || '').includes('alert(document.cookie)'));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

check('allowlist: a symlink out of cwd, and a symlink out of a root, are both refused -- confinement stays on the REALPATH', () => {
  // Ablation: check containment on path.resolve() instead of realpathSync() and
  // either link below reads straight through, since neither link's own spelling
  // ever leaves the place it sits in.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-refroot-link-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-linktarget-'));
  try {
    const target = path.join(outside, 'secret.txt');
    writeFileSync(target, 'exfiltrated', 'utf8');
    const roots = [realpathSync(root)];

    // A file inside cwd, symlinked out of cwd and out of every root.
    const inProject = path.join(fixturesDir, 'escape-link-allowlist');
    try { unlinkSync(inProject); } catch { /* not there yet */ }
    symlinkSync(target, inProject);
    const fromProject = resolveRef({ path: 'escape-link-allowlist' }, { cwd: fixturesDir, roots });
    assert.equal(fromProject.text, undefined);
    assert.equal(fromProject.error, OUTSIDE_REFUSAL('escape-link-allowlist'));

    // The same trick from inside an allowlisted root: lexically allowlisted, really
    // not. The allowlist must not become a hole the old boundary did not have.
    const inRoot = path.join(root, 'escape-link');
    symlinkSync(target, inRoot);
    const fromRoot = resolveRef({ path: inRoot }, { cwd: fixturesDir, roots });
    assert.equal(fromRoot.text, undefined);
    assert.equal(fromRoot.error, OUTSIDE_REFUSAL(inRoot));
  } finally {
    try { unlinkSync(path.join(fixturesDir, 'escape-link-allowlist')); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

check('allowlist: an unusable configured root is dropped, never widened and never fatal', () => {
  // Every entry gets resolveBoardCwd's treatment, i.e. exactly what the board's own
  // cwd gets. Ablation: skip the validation and `CLAUDE_BOARD_REF_ROOTS=/` turns the
  // whole filesystem into an allowlist -- keys, browser profiles, shell history.
  const good = mkdtempSync(path.join(tmpdir(), 'claude-board-refroot-good-'));
  try {
    const home = os.homedir();
    const aFile = path.join(good, 'not-a-directory.md');
    writeFileSync(aFile, 'x', 'utf8');
    const gone = path.join(good, 'no-such-directory');

    assert.deepEqual(resolveRefRoots('/'), [], 'the filesystem root is not an allowlist');
    assert.deepEqual(resolveRefRoots(home), [], '$HOME is every project at once');
    assert.deepEqual(resolveRefRoots(path.dirname(home)), [], 'a directory above $HOME is broader still');
    assert.deepEqual(resolveRefRoots(gone), [], 'a root that does not exist is dropped');
    assert.deepEqual(resolveRefRoots(aFile), [], 'a regular file is not a root');
    assert.deepEqual(resolveRefRoots('relative/path'), [], 'a relative root would resolve against the daemon\'s own cwd');
    assert.deepEqual(resolveRefRoots(''), [], 'an explicitly empty value is the cwd-only boundary, not the default');

    // A bad entry beside a good one drops only itself, and the survivor is the
    // realpath. Dedup too, so a repeated root is not a repeated stat on every ref.
    assert.deepEqual(
      resolveRefRoots(`/:${gone}:${good}:${good}`),
      [realpathSync(good)],
      'one unusable entry must not take the usable ones down with it',
    );

    // ...and a dropped root really is dropped: nothing under it resolves.
    assert.equal(
      resolvePath({ path: '/etc/passwd' }, fixturesDir, resolveRefRoots('/')).error,
      ABSOLUTE_REFUSAL('/etc/passwd'),
    );
  } finally {
    rmSync(good, { recursive: true, force: true });
  }
});

// --- the 2026-07-31 audit of that boundary (S1-S4, S7-S9) ------------------------
//
// Everything above asserts the allowlist does what ADR.md entry 3 says. Everything
// below asserts the things it turned out to ALSO do. Each check names the finding it
// closes and the ablation that reopens it.

check('S1/S3: an absent CLAUDE_BOARD_REF_ROOTS grants nothing, and the default is three directories rather than all of ~/.claude', () => {
  // S3, the delivery question. Every install predating ADR.md entry 3 has a plist with
  // no CLAUDE_BOARD_REF_ROOTS key, and the daemon restarts itself whenever src/ changes
  // (QUIRKS.md, "WatchPaths never restarted the daemon"). A default compiled in HERE
  // therefore goes live on those machines during a routine `git pull` -- a read boundary
  // widening with no reinstall, nothing printed and nobody asked. So absent grants
  // nothing and install.sh writes the default, which makes running the installer the
  // consent event. Ablation: default to ~/.claude (or to DEFAULT_REF_ROOTS) here and
  // this goes red while every existing install silently gains reference roots.
  assert.deepEqual(withRefRoots(undefined, () => resolveRefRoots(process.env.CLAUDE_BOARD_REF_ROOTS)), []);
  assert.deepEqual(resolveRefRoots(''), [], 'an explicitly empty value means the same thing');

  // S1, the scope question, decided by the ADR's own justification: "render the skill,
  // command or agent file it is discussing" is these three directories. ~/.claude as a
  // whole is also .credentials.json, settings.json, shell snapshots, every project's
  // transcripts and every plugin's private state.
  assert.deepEqual([...DEFAULT_REF_ROOTS], ['~/.claude/skills', '~/.claude/commands', '~/.claude/agents']);
  assert.ok(Object.isFrozen(DEFAULT_REF_ROOTS), 'a shared allowlist default must not be mutable by a caller');

  // ...and the narrowing has teeth, asserted against a stand-in tree so it does not
  // turn into a statement about what this machine happens to have under ~/.claude.
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'claude-board-fakehome-'));
  try {
    const dotClaude = path.join(realpathSync(fakeHome), '.claude');
    for (const r of DEFAULT_REF_ROOTS) mkdirSync(path.join(dotClaude, path.basename(r)), { recursive: true });
    const skill = path.join(dotClaude, 'skills', 'SKILL.md');
    writeFileSync(skill, '# the skill under discussion\n', 'utf8');
    const credentials = path.join(dotClaude, '.credentials.json');
    writeFileSync(credentials, '{"token":"exfiltrated"}', 'utf8');

    const roots = resolveRefRoots(DEFAULT_REF_ROOTS.map(r => path.join(dotClaude, path.basename(r))).join(':'));
    assert.equal(roots.length, 3, 'all three default roots must survive validation');
    assert.equal(resolvePath({ path: skill }, null, roots).path, skill, 'a skill file still resolves');
    assert.equal(
      resolveRef({ path: credentials }, { cwd: null, roots }).text,
      undefined,
      'the parent of the three roots is not itself a root',
    );
    // ...and it would have, under the old default: allowlist ~/.claude itself and the
    // same reference reads straight through.
    assert.equal(
      resolveRef({ path: credentials }, { cwd: null, roots: resolveRefRoots(dotClaude) }).text,
      '{"token":"exfiltrated"}',
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

/** Run `fn` with `fs[name]` patched to `impl`, propagated into the named import
 * src/resolve.mjs already bound (that is what `syncBuiltinESMExports` is for), and
 * restored on every exit.
 *
 * This is how the check/read gap below is driven deterministically instead of raced: the
 * attacker's swap happens *inside* a syscall src/resolve.mjs makes, so the step that
 * follows it is always the second half of a race already lost. WHICH syscall matters,
 * and the two checks below deliberately pick different ones — see the second for why
 * hooking the confinement lookup cannot pin the descriptor. */
function withFsHook(name, impl, fn) {
  const original = fs[name];
  const patched = (...args) => impl(original, ...args);
  if (original.native) patched.native = original.native;
  fs[name] = patched;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

check('S2: a symlink swapped in between the confinement check and the read cannot change what is read', () => {
  // resolveRef used to realpath a STRING, statSync that string, then readFileSync that
  // string -- three lookups of one name, so the boundary was decided on one inode and
  // the bytes came from whatever the name meant a moment later. A hunter measured a
  // ~1.2% win rate over 91k attempts against it and carried a private key out. Racing
  // that in CI would be a flaky check, so the swap is driven from inside realpathSync:
  // the confinement half gets the honest in-boundary answer, and by the time the read
  // half runs the name is a symlink pointing out of every root.
  //
  // Ablation: put `statSync(abs)` + `readFileSync(abs)` back in resolveRef and this
  // check reads the secret.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-toctou-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-toctou-target-'));
  try {
    const secret = path.join(outside, 'id_ed25519');
    writeFileSync(secret, '-----BEGIN PRIVATE KEY-----\nexfiltrated\n', 'utf8');
    const bait = path.join(realpathSync(root), 'SKILL.md');
    writeFileSync(bait, '# harmless\n', 'utf8');
    const roots = [realpathSync(root)];

    let swapped = false;
    const r = withFsHook('realpathSync', (original, p, ...rest) => {
      const out = original(p, ...rest);
      if (!swapped && out === bait) {
        swapped = true; // exactly once, on the lookup that decides the boundary
        unlinkSync(bait);
        symlinkSync(secret, bait);
      }
      return out;
    }, () => resolveRef({ path: bait }, { cwd: null, roots }));

    assert.ok(swapped, 'the swap must actually have fired, or this check proves nothing');
    assert.equal(r.text, undefined, 'the read must not follow a symlink swapped in after the check');
    assert.ok(!String(r.text ?? '').includes('exfiltrated'));
    assert.match(r.error, /cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

check('S2: swapping an ANCESTOR directory for a symlink is refused too -- macOS O_NOFOLLOW_ANY is real and this pins it', () => {
  // Plain O_NOFOLLOW only protects the last path component, so the same race run one
  // directory up still wins: replace `<root>/sub` with a symlink and `<root>/sub/SKILL.md`
  // opens somewhere else entirely. macOS has O_NOFOLLOW_ANY for exactly this, Node does
  // not export it, and src/resolve.mjs therefore carries the raw number -- which makes
  // this check the only thing standing between that number and silently meaning nothing.
  // Ablation: swap O_NOFOLLOW_ANY for constants.O_NOFOLLOW in REF_OPEN_FLAGS.
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-toctou-dir-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'claude-board-toctou-dirtarget-'));
  try {
    const sub = path.join(realpathSync(root), 'sub');
    mkdirSync(sub, { recursive: true });
    const bait = path.join(sub, 'SKILL.md');
    writeFileSync(bait, '# harmless\n', 'utf8');
    writeFileSync(path.join(realpathSync(outside), 'SKILL.md'), 'exfiltrated\n', 'utf8');
    const roots = [realpathSync(root)];

    let swapped = false;
    const r = withFsHook('realpathSync', (original, p, ...rest) => {
      const out = original(p, ...rest);
      if (!swapped && out === bait) {
        swapped = true;
        unlinkSync(bait);
        rmSync(sub, { recursive: true, force: true });
        symlinkSync(realpathSync(outside), sub);
      }
      return out;
    }, () => resolveRef({ path: bait }, { cwd: null, roots }));

    assert.ok(swapped, 'the swap must actually have fired');
    assert.equal(r.text, undefined, 'no component of an already-canonical path may be a symlink at open time');
    assert.match(r.error, /cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

check('S4: $HOME under another spelling is still $HOME -- refused as a cwd and as a root, on identity not on string equality', () => {
  // macOS gives $HOME at least two more canonical spellings, and realpathSync collapses
  // neither: it does not correct case on a case-insensitive volume, and an APFS firmlink
  // makes /System/Volumes/Data/Users/you a second real path to the same directory. Both
  // were ACCEPTED, so the one refusal whose whole job is "not every project at once, plus
  // ssh keys, browser profiles and shell history" could be spelled around.
  // Ablation: restore `contains(real, home)` as the whole test and every case below
  // becomes an accepted reference root.
  const homeReal = realpathSync(os.homedir());
  const homeId = fs.statSync(homeReal);
  const aliases = [
    path.join('/System/Volumes/Data', path.relative('/', homeReal)),
    homeReal.toUpperCase(),
    homeReal.toLowerCase(),
  ];
  let tested = 0;
  for (const alias of aliases) {
    if (alias === homeReal) continue;
    let st;
    try { st = fs.statSync(alias); } catch { continue; } // not how this machine is laid out
    if (st.dev !== homeId.dev || st.ino !== homeId.ino) continue;
    tested++;
    assert.match(String(resolveBoardCwd(alias).error), /\$HOME/, `${alias} names $HOME and must be refused as a cwd`);
    assert.deepEqual(resolveRefRoots(alias), [], `${alias} must not become a reference root`);
  }
  assert.ok(tested > 0, 'this machine offers no alternate spelling of $HOME, so the check would prove nothing');

  // And a directory ABOVE $HOME under an alias: /System/Volumes/Data is nobody's
  // ancestor by inode -- walking up from realpath($HOME) never reaches it -- yet it
  // contains every home on the machine.
  if (existsSync(path.join('/System/Volumes/Data', path.relative('/', homeReal)))) {
    assert.match(String(resolveBoardCwd('/System/Volumes/Data').error), /\$HOME/);
    assert.deepEqual(resolveRefRoots('/System/Volumes/Data'), []);
  }
});

check('S2: a regular file renamed over the path between the open and the read cannot change what is read', () => {
  // The descriptor half of the S2 fix, pinned on its own, because the two checks above
  // do NOT pin it. Both of them swap in a SYMLINK, which O_NOFOLLOW_ANY refuses at
  // openSync before any read is reached -- so they cover the flag and say nothing about
  // where the bytes come from. Reverting `readFileSync(fd)` to `readFileSync(abs)` left
  // the entire suite green (found by mutation testing, 2026-07-31): the flag was masking
  // the descriptor.
  //
  // The two defend different attacks. The flag closes the symlink swap. The descriptor
  // closes the swap that needs no symlink at all -- rename() a different REGULAR file
  // over the name, which no open flag can see, and which the guards then pass on one
  // inode while the bytes come from another. So this check hooks openSync rather than
  // realpathSync: hooking the confinement lookup swaps too early to discriminate, since
  // the open that follows would pick up the impostor either way.
  //
  // Ablation: `raw = readFileSync(abs, 'utf8')` in resolveRef and this reads the impostor.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-fdread-'));
  try {
    const real = realpathSync(root);
    const bait = path.join(real, 'SKILL.md');
    const impostor = path.join(real, 'impostor.md');
    writeFileSync(bait, 'CHECKED-AND-READ\n', 'utf8');
    writeFileSync(impostor, 'SWAPPED-IN-AFTER-THE-OPEN\n', 'utf8');
    const roots = [real];

    let swapped = false;
    const r = withFsHook('openSync', (original, p, ...rest) => {
      const fd = original(p, ...rest);
      if (!swapped && p === bait) {
        swapped = true;
        // Atomic, and deliberately NOT a symlink: the descriptor already names the old
        // inode, and rename leaves it perfectly readable through that descriptor while
        // the NAME now means something else entirely.
        fs.renameSync(impostor, bait);
      }
      return fd;
    }, () => resolveRef({ path: bait }, { cwd: null, roots }));

    assert.ok(swapped, 'the swap must actually have fired, or this check proves nothing');
    assert.equal(readFileSync(bait, 'utf8'), 'SWAPPED-IN-AFTER-THE-OPEN\n', 'and the name must really have changed under it');

    assert.equal(r.error, undefined, `expected a clean read from the descriptor, got: ${r.error}`);
    assert.equal(r.text, 'CHECKED-AND-READ\n', 'the bytes must come from the descriptor the guards ran on, not from the name');
    assert.ok(!String(r.text ?? '').includes('SWAPPED-IN-AFTER-THE-OPEN'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('S2: the regular-file and byte-cap guards run on the descriptor too, not on the name a second time', () => {
  // The third piece of the same property, and it needed its own check for the same
  // reason the one above did: with the read pinned but the GUARDS still asking the name,
  // `fstatSync(fd)` -> `statSync(abs)` survived every check in this file. That mutant is
  // a live refusal bug rather than a disclosure one -- the guards would describe a file
  // the bytes do not come from -- and the shape it restores is exactly the check/read
  // gap: decide on one inode, act on another.
  //
  // Both swaps below replace the name with something the NAME-based guard would refuse
  // while the descriptor is still a perfectly good small regular file. Shipped, each
  // reads cleanly. Ablation: `statSync(abs)` in place of `fstatSync(fd)` and each comes
  // back as a refusal instead.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-fdguard-'));
  try {
    const real = realpathSync(root);
    const roots = [real];

    // The name becomes a DIRECTORY, which the type guard refuses.
    // The name becomes an OVERSIZED file, which the byte-cap guard refuses.
    const swaps = [
      ['a directory', bait => { unlinkSync(bait); mkdirSync(bait); }],
      ['a file over the byte cap', bait => { unlinkSync(bait); writeFileSync(bait, 'x'.repeat(MAX_REF_BYTES + 1), 'utf8'); }],
    ];
    for (const [what, swap] of swaps) {
      const bait = path.join(real, `SKILL-${what.replace(/\W+/g, '-')}.md`);
      writeFileSync(bait, 'READ-FROM-THE-DESCRIPTOR\n', 'utf8');

      let swapped = false;
      const r = withFsHook('openSync', (original, p, ...rest) => {
        const fd = original(p, ...rest);
        if (!swapped && p === bait) {
          swapped = true;
          swap(bait);
        }
        return fd;
      }, () => resolveRef({ path: bait }, { cwd: null, roots }));

      assert.ok(swapped, `the swap to ${what} must actually have fired`);
      assert.equal(r.error, undefined, `after the name became ${what}, expected a clean read, got: ${r.error}`);
      assert.equal(r.text, 'READ-FROM-THE-DESCRIPTOR\n', `the guards must describe the descriptor, not the ${what} now at that name`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('S4/NEW-1: a SYMLINKED $HOME is still $HOME -- both sides are realpath\'d before identity is compared', () => {
  // The second half of the same defect, and the one string comparison could never have
  // caught: `homedir()` hands back whatever HOME says, symlink and all, while the
  // candidate has already been through realpathSync. So with HOME a symlink the two
  // never matched, and $HOME itself, its realpath, AND the directory above it were all
  // accepted as reference roots -- every project on the machine, quotable into a board.
  // Ablation: restore `contains(real, homedir())` as the whole test and all five
  // assertions below flip to ACCEPTED.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-board-homelink-')));
  const prevHome = process.env.HOME;
  try {
    mkdirSync(path.join(base, 'real'));
    symlinkSync(path.join(base, 'real'), path.join(base, 'home'));
    process.env.HOME = path.join(base, 'home'); // os.homedir() reads $HOME first on POSIX

    assert.deepEqual(resolveRefRoots(path.join(base, 'home')), [], '$HOME by its symlinked spelling');
    assert.deepEqual(resolveRefRoots(path.join(base, 'real')), [], '$HOME by its realpath');
    assert.deepEqual(resolveRefRoots(base), [], 'the directory above $HOME');
    assert.match(String(resolveBoardCwd(path.join(base, 'home')).error), /\$HOME/);
    assert.match(String(resolveBoardCwd(base).error), /\$HOME/);

    // ...and a directory genuinely UNDER $HOME is still perfectly usable, which is the
    // whole point of refusing only $HOME and above rather than the tree.
    const project = path.join(base, 'real', 'project');
    mkdirSync(project);
    assert.deepEqual(resolveRefRoots(project), [project]);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(base, { recursive: true, force: true });
  }
});

check('NEW-3: the project directory itself is never a reference target, wherever the project happens to live', () => {
  // `real !== root` used to be a term of the cwd disjunct only, so the insideRoots
  // fallback cancelled it whenever the project sat under an allowlisted root -- and
  // resolvePath then returned `{ path: <a directory> }` as a SUCCESS. Not a read today
  // (resolveRef refuses it on the descriptor) but the exported contract admitted it, and
  // the error an agent saw moved depending on where its project happened to live.
  // Ablation: move `real !== root` back inside the first disjunct.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-selfref-root-'));
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'claude-board-selfref-project-'));
  try {
    const roots = [realpathSync(root)];
    const inside = path.join(realpathSync(root), 'project');
    mkdirSync(inside, { recursive: true });

    for (const [where, project] of [['inside an allowlisted root', inside], ['outside every root', realpathSync(elsewhere)]]) {
      for (const spelling of ['.', './']) {
        const r = resolvePath({ path: spelling }, project, roots);
        assert.equal(r.path, undefined, `a project ${where} must not resolve as its own reference (${spelling})`);
        assert.equal(r.error, OUTSIDE_REFUSAL(spelling));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

check('NEW-4: a RELATIVE reference reaches an allowlisted root too, not only an absolute one', () => {
  // Every positive allowlist check above addresses the root absolutely, because that is
  // how ~/.claude content is normally spelled. Which left resolvePath's RELATIVE branch
  // completely unexercised for the allowlist: ablating `insideRoots` out of it alone
  // kept the whole suite green. `../root/skills/…` from a sibling project directory is
  // the route, and an agent that knows where the project sits will spell it that way.
  // Ablation: drop `|| insideRoots(real, roots)` from the relative branch only.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-board-relroot-')));
  try {
    const root = path.join(base, 'root');
    const project = path.join(base, 'project');
    const neither = path.join(base, 'neither');
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(neither, { recursive: true });
    writeFileSync(path.join(root, 'skills', 'SKILL.md'), 'reached relatively\n', 'utf8');
    writeFileSync(path.join(neither, 'private.md'), 'exfiltrated', 'utf8');
    const roots = [root];

    const rel = path.join('..', 'root', 'skills', 'SKILL.md');
    assert.equal(resolvePath({ path: rel }, project, roots).path, path.join(root, 'skills', 'SKILL.md'));
    assert.equal(resolveRef({ path: rel }, { cwd: project, roots }).text, 'reached relatively\n');

    // ...and the same relative shape into a sibling that is in NEITHER cwd nor a root is
    // still refused, so this is the allowlist widening and not `../` going unchecked.
    const escape = path.join('..', 'neither', 'private.md');
    const refused = resolveRef({ path: escape }, { cwd: project, roots });
    assert.equal(refused.text, undefined);
    assert.equal(refused.error, OUTSIDE_REFUSAL(escape));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

check('S7: which refusal comes back never depends on anything outside the boundary -- no existence-and-errno oracle', () => {
  // The refusal used to splice err.code from the failed realpathSync into its message,
  // and picked between two messages on that basis. Since an agent can write inside an
  // allowlisted root, a planted symlink turned every refused reference into "does this
  // path exist, and may I read it?" for anywhere on the disk. The docstring above it
  // claimed the opposite, which is worse than no docstring.
  // Ablation: restore the `${err.code}` splice and the pairs below diverge.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-board-oracle-'));
  const project = mkdtempSync(path.join(tmpdir(), 'claude-board-oracle-project-'));
  try {
    const roots = [realpathSync(root)];
    const present = '/etc/hosts';
    const absent = '/etc/definitely-not-here-9d2f1a';

    // Absolute: two symlinks inside a root, one aimed at something real and one not.
    const toPresent = path.join(realpathSync(root), 'probe-present');
    const toAbsent = path.join(realpathSync(root), 'probe-absent');
    symlinkSync(present, toPresent);
    symlinkSync(absent, toAbsent);
    const hit = resolvePath({ path: toPresent }, project, roots).error;
    const miss = resolvePath({ path: toAbsent }, project, roots).error;
    assert.equal(hit, OUTSIDE_REFUSAL(toPresent));
    assert.equal(miss, OUTSIDE_REFUSAL(toAbsent));
    assert.equal(
      hit.replace(toPresent, 'P'), miss.replace(toAbsent, 'P'),
      'the reply must carry no bit about the target, only the path the caller already knew',
    );

    // Relative: ../ reaches the same places and leaked the same errno.
    const relPresent = path.relative(realpathSync(project), present);
    const relAbsent = path.relative(realpathSync(project), absent);
    assert.equal(resolvePath({ path: relPresent }, project, roots).error, OUTSIDE_REFUSAL(relPresent));
    assert.equal(resolvePath({ path: relAbsent }, project, roots).error, OUTSIDE_REFUSAL(relAbsent));

    // What survives is the one distinction that is entirely in-boundary, and the reason
    // the second message exists at all: a name that is simply not there inside a place
    // you may already read reads as missing, not as a confinement failure.
    assert.match(resolvePath({ path: path.join(realpathSync(root), 'typo.md') }, project, roots).error, /no such file/);
    assert.match(resolvePath({ path: 'typo.md' }, project, roots).error, /no such file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

check('S9: a root whose name contains a colon fails the whole spec closed instead of granting a sibling', () => {
  // `:` separates entries and `:` is legal in a directory name, so `/data/my:dir` splits
  // into `/data/my` and `dir`. The old code dropped the unusable `dir` as "not absolute"
  // and GRANTED `/data/my` -- an unrelated directory the user never named, everything in
  // it quotable into any board. There is no spelling that recovers the intent, so the
  // spec grants nothing. Ablation: drop the isAbsolute fail-closed in resolveRefRoots
  // and the first assertion comes back holding the sibling.
  const base = mkdtempSync(path.join(tmpdir(), 'claude-board-colon-'));
  try {
    const real = realpathSync(base);
    const intended = path.join(real, 'my:dir');
    const sibling = path.join(real, 'my');
    mkdirSync(intended, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'not-yours.md'), 'never asked for', 'utf8');

    assert.deepEqual(resolveRefRoots(intended), [], 'an unrepresentable root grants nothing');
    assert.equal(
      resolveRef({ path: path.join(sibling, 'not-yours.md') }, { cwd: null, roots: resolveRefRoots(intended) }).text,
      undefined,
      'the sibling the split invented must not be readable',
    );

    // An entry that is merely unusable is unambiguous, and still drops only itself:
    // DEFAULT_REF_ROOTS names three directories not every machine has, and one absent
    // must not take the other two with it.
    const good = path.join(real, 'good');
    mkdirSync(good, { recursive: true });
    assert.deepEqual(resolveRefRoots(`${path.join(real, 'absent')}:${good}`), [good]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

check('S8: the hard-link limit is stated in SECURITY.md rather than left for a reader to discover', () => {
  // Not fixed, deliberately. A hard link inside an allowlisted root, pointing at a file
  // outside every root, is a second equally real name for one inode -- realpath cannot
  // tell it from the first and neither can a descriptor, so the confinement above simply
  // does not see it. (Reproducible in one line: `ln <secret> <root>/x.md`.) Refusing
  // st.nlink > 1 was the only candidate fix and it refuses legitimately hard-linked
  // content with nothing to separate the cases. So the deliverable is an honest sentence
  // in the posture document, and this is the check that it is still there.
  const security = readFileSync(path.join(repoRoot, 'SECURITY.md'), 'utf8');
  const notDefended = security.indexOf('### Not defended, by design');
  assert.ok(notDefended > 0, 'SECURITY.md must still have a "Not defended, by design" section');
  const section = security.slice(notDefended, security.indexOf('\n## ', notDefended));
  assert.match(section, /hard link/i, 'the hard-link limit belongs under "Not defended, by design"');
});

// --- H5: a special or huge file must not wedge the single-threaded daemon --------

check('H5: a fifo is refused by stat, never opened -- readFileSync on one would block the daemon\'s only thread forever', () => {
  // Ablation: remove the statSync/isFile() guard and this check HANGS (no assertion
  // failure, no timeout -- the process never exits), which is exactly the daemon's
  // failure mode: health, every other board and every SSE stream stop with it.
  const fifo = path.join(fixturesDir, 'wedge.fifo');
  try { unlinkSync(fifo); } catch { /* not there yet */ }
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    return; // no mkfifo on this platform; the size cap below still exercises the guard
  }
  const started = Date.now();
  const r = resolveRef({ path: 'wedge.fifo' }, { cwd: fixturesDir });
  assert.ok(Date.now() - started < 1000, 'resolving a fifo must return immediately, not block');
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /not a regular file/);
  unlinkSync(fifo);
});

check('H5: a directory is refused as "not a regular file" rather than read', () => {
  mkdirSync(path.join(fixturesDir, 'a-directory'), { recursive: true });
  const r = resolveRef({ path: 'a-directory' }, { cwd: fixturesDir });
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /not a regular file/);
});

check('H5: a file over the byte cap is refused by stat, before any of it is read into memory', () => {
  // Ablation: remove the st.size check and the whole file is slurped inline on the
  // request thread.
  const big = path.join(fixturesDir, 'huge.txt');
  writeFileSync(big, 'x'.repeat(MAX_REF_BYTES + 1), 'utf8');
  const r = resolveRef({ path: 'huge.txt' }, { cwd: fixturesDir });
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /exceeds the .* cap/);
  assert.equal(r.text, undefined);
  unlinkSync(big);
});

check('N2/cap: a by-value text or html block over the same cap is a loud 400-able error, not silently accepted', () => {
  // Ablation: remove byValueText and a multi-megabyte `html` string posted by value
  // is stored verbatim and re-parsed by src/anchor.mjs on every render, SSE fragment
  // and packet -- the file cap does not cover by-value content.
  const oversize = 'x'.repeat(MAX_REF_BYTES + 1);
  assert.throws(() => createBoard({ title: 't', blocks: [{ kind: 'html', html: oversize }] }), /over the .*-byte cap/);
  assert.throws(() => createBoard({ title: 't', blocks: [{ kind: 'markdown', text: oversize }] }), /over the .*-byte cap/);
});

check("SPEC_HTMLREF.md criterion 5: the by-value over-cap message no longer tells the caller a source reference raises the cap, because it does not", () => {
  // Ablation: revert the message in src/board.mjs's byValueText to "use a source
  // reference instead" and this fails -- a reference to content this size is refused
  // by resolveRef's own whole-file fstat check (src/resolve.mjs) before any slicing,
  // so that phrasing names a remedy that does not work for ANY kind, html included.
  const oversize = 'x'.repeat(MAX_REF_BYTES + 1);
  let caught = null;
  try {
    createBoard({ title: 't', blocks: [{ kind: 'html', html: oversize }] });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'an over-cap by-value block must still throw');
  assert.match(caught.message, /over the .*-byte cap/);
  assert.ok(!/use a source reference instead/i.test(caught.message), 'must not name a remedy that does not raise the cap');
  // What the message says instead must actually be true: a reference to a file this
  // size is refused too, proven end to end rather than merely asserted in prose.
  const big = path.join(fixturesDir, 'criterion5-oversize.html');
  writeFileSync(big, oversize, 'utf8');
  try {
    const board = createBoard({ title: 't', cwd: fixturesDir, blocks: [{ kind: 'html', source: { path: 'criterion5-oversize.html' } }] });
    assert.match(board.blocks[0].error, /exceeds the .* cap/);
  } finally {
    unlinkSync(big);
  }
});

// --- H6: the server's html tree must be the tree the browser built ---------------
//
// Every fixture here is a shape where the browser's parser inserts or auto-closes an
// element. src/ui.mjs mints the index chain against the LIVE dom; src/anchor.mjs
// resolves it against the snapshot. A one-node disagreement makes a live, on-screen
// element report LOST (breaking acceptance criterion 10 and this module's own "a
// live anchor is never misreported lost" invariant), and the pin renders pin-lost.
//
// Ablation for all four: revert parseHtmlTree to the tag-omission-free version (no
// autoCloseFor/impliedParentFor, script/style deleted by regex) and every
// resolveDomAnchor assertion below flips to false.

check('H6: <table><tr> resolves through the tbody the browser implies', () => {
  const html = '<table><tr><td>Send</td></tr></table>';
  const root = parseHtmlTree(html);
  const table = root.children[0];
  assert.equal(table.tag, 'table');
  assert.equal(table.children[0].tag, 'tbody', 'the browser inserts tbody; so must this parser');
  // browser chain for the <td>: table(1) > tbody(1) > tr(1) > td(1)
  assert.ok(resolveDomAnchor(html, '1.1.1.1', 'Send'));
});

check('H6: <ul><li>alpha<li>beta</ul> gives two SIBLING list items, not a nested one', () => {
  const html = '<ul><li>alpha<li>beta</ul>';
  const root = parseHtmlTree(html);
  const ul = root.children[0];
  assert.equal(ul.children.length, 2);
  assert.equal(elementText(ul.children[0]), 'alpha');
  assert.equal(elementText(ul.children[1]), 'beta');
  assert.ok(resolveDomAnchor(html, '1.2', 'beta'));
});

check('H6: <p>intro<div>Send</div> auto-closes the p, so the div is a SIBLING at index 2', () => {
  const html = '<p>intro<div>Send</div>';
  const root = parseHtmlTree(html);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].tag, 'p');
  assert.equal(elementText(root.children[0]), 'intro');
  assert.equal(root.children[1].tag, 'div');
  assert.ok(resolveDomAnchor(html, '2', 'Send'));
});

check('H6: a <style> element is COUNTED as a child, so the button after it keeps the index the browser gave it', () => {
  const html = '<div>a</div><style>.x{}</style><button>Send</button>';
  const root = parseHtmlTree(html);
  assert.deepEqual(root.children.map(c => c.tag), ['div', 'style', 'button']);
  assert.ok(resolveDomAnchor(html, '3', 'Send'), 'the browser mints "3" for the button; deleting <style> made this "2" server-side');
  assert.equal(resolveDomAnchor(html, '2', 'Send'), false);
});

check('N9: an element whose text uses a typographic entity still matches the hint the browser minted from textContent', () => {
  // Ablation: shrink NAMED_ENTITIES back to the six-entry table and elementText
  // returns the literal "Don&rsquo;t send" while the stored hint holds "Don’t send"
  // -- a live button reports lost.
  const html = '<div><button>Don&rsquo;t send</button></div>';
  assert.equal(elementText(parseHtmlTree(html).children[0].children[0]), 'Don’t send');
  assert.ok(resolveDomAnchor(html, '1.1', 'Don’t send'));
  assert.ok(resolveDomAnchor('<p>a &mdash; b &hellip; c &times; d &rarr; e</p>', '1', 'a — b … c × d → e'));
});

// --- N4: mermaid's dominant edge operator ----------------------------------------

check('N4: a mermaid ref resolves across -->, -.->, --- and -->|label| edges', () => {
  // Ablation: put `-` back in isWordChar and every `A` assertion below flips to
  // false -- the reviewer clicks node A and the packet says the anchor was lost
  // against the very source it was minted from, while B resolves.
  assert.ok(mermaidRefResolves('flowchart TD\n  A-->B', 'A'));
  assert.ok(mermaidRefResolves('flowchart TD\n  A-->B', 'B'));
  assert.ok(mermaidRefResolves('flowchart TD\n  A-.->B', 'A'));
  assert.ok(mermaidRefResolves('flowchart TD\n  A---B', 'A'));
  assert.ok(mermaidRefResolves('flowchart TD\n  A-->|yes|B', 'A'));
  assert.equal(mermaidRefResolves('flowchart TD\n  A-->B', 'Ghost'), false);
});

// --- M6 / L1: one slug algorithm, one label ---------------------------------------

check('M6: the anchor slug for a heading with an entity is the SAME slug resolveRef resolves as a section', () => {
  // Ablation: slugify the escaped text again (`slugify(escapedText, ...)`) and the
  // anchor becomes 'risk-amp-reward' while only section 'risk-reward' resolves --
  // the only slug the agent is ever shown is the one that cannot work.
  const src = '# Doc\n\n## Risk & Reward\n\nbody text here\n\n## After\n\ntail';
  const { anchors } = mdToHtmlAndAnchors(src);
  const ref = anchors.find(a => a.label === 'Risk & Reward').ref;
  assert.equal(ref, 'risk-reward');

  const file = path.join(fixturesDir, 'amp.md');
  writeFileSync(file, src, 'utf8');
  const resolved = resolveRef({ path: 'amp.md', section: ref }, { cwd: fixturesDir });
  assert.equal(resolved.error, undefined, 'the slug the agent was shown must resolve as a section');
  assert.ok(resolved.text.includes('body text here'));
  assert.ok(!resolved.text.includes('tail'));
});

check('L1: an anchor label is the raw source text, escaped once at emit time -- not entity-escaped twice', () => {
  // Ablation: push `escapedText`/`it.text` as the label and the UI and the packet
  // both show "Risk &amp; Reward".
  const { anchors, html } = mdToHtmlAndAnchors('## Risk & Reward\n\n- a & b\n');
  assert.equal(anchors[0].label, 'Risk & Reward');
  assert.equal(anchors[1].label, 'a & b');
  assert.ok(html.includes('Risk &amp; Reward'), 'the HTML body itself is still escaped exactly once');
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '## Risk & Reward\n' }] });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('data-anchor-label="Risk &amp; Reward"'));
  assert.ok(!markup.includes('Risk &amp;amp; Reward'));
});

// --- N6 / N7 / N8: the two heading scanners must agree, and ids must be unique ----

check('N6: a "#" comment inside a fenced code block is not a heading -- sliceSection skips fences exactly like markdown.mjs', () => {
  // Ablation: drop the inFence toggle in sliceSection and the Setup section is
  // truncated at the fence with NO error, silently dropping its body.
  const src = [
    '## Setup', '', 'run this:', '', '```sh', '# Install deps', 'npm i', '```', '',
    'and then you are done.', '', '## Next', '', 'unrelated',
  ].join('\n');
  writeFileSync(path.join(fixturesDir, 'fenced.md'), src, 'utf8');
  const r = resolveRef({ path: 'fenced.md', section: 'setup' }, { cwd: fixturesDir });
  assert.equal(r.error, undefined);
  assert.ok(r.text.includes('npm i'));
  assert.ok(r.text.includes('and then you are done.'), 'the section must not stop at the fenced "# Install deps"');
  assert.ok(!r.text.includes('unrelated'));
});

check('N6: fenced "#" lines do not shift heading ordinals, so a -2 slug names the same heading in both scanners', () => {
  const src = ['# Notes', '', '```sh', '# Notes', '```', '', '# Notes', '', 'second real one'].join('\n');
  writeFileSync(path.join(fixturesDir, 'ordinals.md'), src, 'utf8');
  const { anchors } = mdToHtmlAndAnchors(src);
  assert.deepEqual(anchors.map(a => a.ref), ['notes', 'notes-2']);
  const r = resolveRef({ path: 'ordinals.md', section: 'notes-2' }, { cwd: fixturesDir });
  assert.equal(r.error, undefined);
  assert.ok(r.text.includes('second real one'));
});

check('N7: a quoted heading or bullet mints no anchor and consumes no slug', () => {
  // Ablation: drop the `quoted` flag and the quotation takes the `plan` slug while
  // the real heading gets `plan-2` -- which resolveRef (blind to blockquotes) then
  // refuses, while `plan` returns the real body under an id naming the quotation.
  const src = ['> ## Plan', '> - quoted bullet', '', '## Plan', '', '- real bullet'].join('\n');
  const { anchors, html } = mdToHtmlAndAnchors(src);
  assert.deepEqual(anchors.map(a => a.ref), ['plan', 'plan-li1']);
  assert.equal(anchors[0].label, 'Plan');
  assert.equal(anchors[1].label, 'real bullet');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(!/<blockquote><h2 id=/.test(html), 'a quoted heading carries no id');
  assert.equal((html.match(/id="plan"/g) || []).length, 1);
});

check('N8: a heading slug can never collide with a list-item id', () => {
  // Ablation: mint the li ref as a bare string again (no reserveRef) and both the
  // bullet and the "Risks li1" heading render id="risks-li1"; render.mjs's last-wins
  // labelByRef then labels a comment on the bullet with the heading's text.
  const { anchors, html } = mdToHtmlAndAnchors('## Risks\n\n- first risk\n- second risk\n\n## Risks li1\n\nprose');
  const refs = anchors.map(a => a.ref);
  assert.equal(new Set(refs).size, refs.length, 'every anchor ref must be unique');
  assert.equal((html.match(/id="risks-li1"/g) || []).length, 1);
  const byRef = new Map(anchors.map(a => [a.ref, a.label]));
  assert.equal(byRef.get('risks-li1'), 'first risk');
});

// --- P3: criterion 5 holds unconditionally ---------------------------------------

check('P3: a headingless markdown source still yields one anchor per top-level list item', () => {
  // Ablation: remove the SYNTHETIC_SECTION assignment and this returns anchors: [],
  // so nothing in the single most likely thing to post -- a bare criteria list --
  // can be commented on at element level at all.
  const { anchors, html } = mdToHtmlAndAnchors('- one\n- two');
  assert.equal(anchors.length, 2);
  assert.deepEqual(anchors.map(a => a.ref), ['_body-li1', '_body-li2']);
  assert.deepEqual(anchors.map(a => a.label), ['one', 'two']);
  assert.ok(html.includes('id="_body-li1"'));
  // ids stay stable while the document's shape is unchanged
  assert.deepEqual(mdToHtmlAndAnchors('- one\n- two').anchors.map(a => a.ref), ['_body-li1', '_body-li2']);
  // and the synthetic prefix cannot be produced by slugify, so it can never shadow
  // a real heading's slug
  assert.notEqual(slugify('_body', new Set()), '_body');
  const mixed = mdToHtmlAndAnchors('- preamble\n\n## Body\n\n- under a heading');
  assert.deepEqual(mixed.anchors.map(a => a.ref), ['_body-li1', 'body', 'body-li1']);
});

// --- L2: an unanswerable question is a rejection, not a silent 'single' -----------

check('L2: an unrecognised widget is rejected instead of silently becoming "single"', () => {
  // Ablation: restore `WIDGETS.includes(raw.widget) ? raw.widget : 'single'` and
  // {widget:'freetext'} renders a question with no cards and no textarea -- literally
  // unanswerable -- which Send then reports back as `unanswered`, so the agent
  // misreports it as "the reviewer left it blank".
  assert.throws(
    () => createBoard({ title: 't', blocks: [{ kind: 'question', prompt: 'Why?', widget: 'freetext', options: [] }] }),
    /unknown widget/,
  );
});

check('L2: a single/multi/rank/choose-between-rendered-variants question with zero options is rejected; a text question with none is fine', () => {
  for (const widget of ['single', 'multi', 'rank', 'choose-between-rendered-variants']) {
    assert.throws(
      () => createBoard({ title: 't', blocks: [{ kind: 'question', prompt: 'Pick', widget, options: [] }] }),
      /requires at least one option/,
      `widget ${widget} with no options must be rejected`,
    );
  }
  const ok = createBoard({ title: 't', blocks: [{ kind: 'question', prompt: 'Say', widget: 'text', options: [] }] });
  assert.equal(ok.blocks[0].widget, 'text');
});

// --- SPEC_MIGRATION.md criterion 2: choose-between-rendered-variants --------------

check('choose-between-rendered-variants: each option carries a nested block normalized through the same path as a compare side\'s, minting a real, unique id', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', description: 'first cut', block: { kind: 'html', html: '<button>A</button>' } },
        { label: 'B', block: { kind: 'markdown', text: '# B' } },
      ],
    }],
  });
  const q = board.blocks[0];
  assert.equal(q.options.length, 2);
  assert.equal(q.options[0].label, 'A');
  assert.equal(q.options[0].description, 'first cut');
  assert.equal(q.options[0].block.kind, 'html');
  assert.equal(q.options[1].block.kind, 'markdown');
  // Real, unique, kind-letter-prefixed ids -- not inert strings, and never
  // colliding with each other or with the question's own id.
  assert.match(q.options[0].block.id, /^h\d+$/);
  assert.match(q.options[1].block.id, /^d\d+$/);
  assert.notEqual(q.options[0].block.id, q.options[1].block.id);
  assert.notEqual(q.options[0].block.id, q.id);
  // No 'preview' field at all on this widget's options -- that shape belongs
  // to every OTHER widget only.
  assert.equal(q.options[0].preview, undefined);
});

check('choose-between-rendered-variants: an option with no block is null-tolerant, exactly like a compare side with none', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which?',
      widget: 'choose-between-rendered-variants',
      options: [{ label: 'Empty' }],
    }],
  });
  assert.equal(board.blocks[0].options[0].block, null);
});

check('choose-between-rendered-variants: a duplicate id across two options\' blocks is rejected, the same protection a compare side\'s block already gets', () => {
  // Ablation: skip walking `options[].block` in resolveBlockId's `ids` ledger
  // (idLedgerFromBoard/emptyIdLedger's `minted` set within one normalizeBoard
  // pass) and this passes when it must throw -- two option blocks would
  // silently share an id, corrupting whichever one a comment or answer later
  // addresses.
  assert.throws(
    () => createBoard({
      title: 'variants',
      blocks: [{
        kind: 'question',
        prompt: 'Which?',
        widget: 'choose-between-rendered-variants',
        options: [
          { label: 'A', block: { id: 'h1', kind: 'html', html: '<p>a</p>' } },
          { label: 'B', block: { id: 'h1', kind: 'html', html: '<p>b</p>' } },
        ],
      }],
    }),
    /duplicate block id/,
  );
});

check('choose-between-rendered-variants: renders each option\'s nested block through the real renderBlock dispatch, inside a selectable div (not a button)', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Card A', description: 'the safe one', block: { kind: 'html', html: '<button>Send</button>' } },
        { label: 'Card B', block: { kind: 'markdown', text: '# heading B' } },
      ],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));

  assert.ok(markup.includes('class="options options-variants"'));
  assert.ok(markup.includes('class="variant-card choice-variant"') || /class="variant-card choice-variant[" ]/.test(markup));
  assert.ok(markup.includes('role="button"'));
  // The nested blocks' OWN rendered markup is present -- proof renderBlock
  // actually ran for each option, not a fallback: an html option is a real
  // sandboxed iframe, a markdown option is real md-content, each with its own
  // block-kind class and its own data-block-id distinct from the question's.
  assert.ok(markup.includes('class="block html-block"'));
  assert.ok(markup.includes('class="html-stage"'));
  assert.ok(markup.includes('&lt;button&gt;Send&lt;/button&gt;'));
  assert.ok(markup.includes('class="block markdown-block"'));
  assert.ok(markup.includes('id="heading-b"'), 'the markdown option\'s own heading must carry its real anchor id');
  assert.ok(markup.includes('heading B'));
  assert.ok(markup.includes('Card A'));
  assert.ok(markup.includes('the safe one'));
  assert.ok(markup.includes('Card B'));
  // Never a <button> wrapping the card's content -- that is exactly what an
  // iframe cannot legally nest inside.
  assert.ok(!/<button[^>]*class="variant-card/.test(markup));
});

check('choose-between-rendered-variants: an html option\'s iframe is rendered pointer-events: none -- a real click can never reach it, only the card around it can ever record a pick', () => {
  // SECURITY, not polish (director review): without this, a real, trusted
  // click over the visible mock content of an html-kind option would land
  // INSIDE the iframe rather than on the card, and the stage is untrusted,
  // agent-authored content -- see src/render.mjs's "NO 'select' MESSAGE,
  // DELIBERATELY" design comment for the two paths that made a stage-
  // reported click-to-select message unsafe. This is the one half of the fix
  // no DOM stand-in can exercise directly (QUIRKS.md: no real layout, no
  // pointer-events hit-testing); test/check-stage-isolation.mjs proves the
  // other half -- that even a message the stage manages to get out carries
  // no path back to a selection.
  assert.match(styles, /\.choice-variant\s+\.html-stage\s*\{[^}]*pointer-events:\s*none/,
    'src/styles.mjs must render an html option\'s iframe pointer-events: none inside a .choice-variant card');
});

check('choose-between-rendered-variants: a click dispatched INSIDE an html option\'s own mock document never selects the option, whether genuine or self-dispatched by the mock\'s own script', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [{ label: 'A', block: { kind: 'html', html: '<div class="mock"><button>A</button></div>' } }],
    }],
  });
  const document = loadVariantBoard(board);
  const frame = document.querySelector('.html-stage');
  frame.loadSrcdoc();
  const card = document.querySelector('.choice-variant');
  // Simulates the exact scenario the fix exists for: content that clicks
  // itself (an autoplaying demo, an animation), ordinary for /example's real
  // interactive mockups, with no reviewer involved at all.
  frame.contentDocument.querySelector('button').dispatchEvent(new StandInEvent('click'));
  assert.equal(card.classList.contains('selected'), false,
    'a click originating inside the mock -- genuine or script-dispatched -- must never select the option');
});

check('choose-between-rendered-variants: an option with no block falls back to "no content", the same fallback a contentless compare side shows', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{ kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants', options: [{ label: 'Empty' }] }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('class="unsupported-widget">no content</p>'));
});

check('choose-between-rendered-variants: the picked option stays visible and the card is disabled once its round is sent, the same contract every other widget honours', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Yes', block: { kind: 'markdown', text: 'yes copy' } },
        { label: 'No', block: { kind: 'markdown', text: 'no copy' } },
      ],
    }],
  });
  applySubmit(board, { action: 'send', answers: [{ id: board.blocks[0].id, status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  const markup = renderedMarkup(renderBoardPage(board));
  const historySection = markup.slice(markup.indexOf('round-history'));
  assert.match(historySection, /class="variant-card choice-variant selected"[^>]*aria-disabled="true"/);
  assert.match(historySection, /tabindex="-1"/);
  assert.ok(historySection.includes('yes copy'), 'the picked option\'s own rendered content must stay visible once sent');
});

check('choose-between-rendered-variants: findBlock and resolveComment reach an option\'s nested block, exactly as they already reach a compare side\'s', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', block: { kind: 'html', html: '<button>Old</button>' } },
        { label: 'B', block: { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' } },
      ],
    }],
  });
  const q = board.blocks[0];
  const htmlBlockId = q.options[0].block.id;
  const mermaidBlockId = q.options[1].block.id;

  assert.equal(findBlock(board, htmlBlockId)?.kind, 'html');
  assert.equal(findBlock(board, mermaidBlockId)?.kind, 'mermaid');

  board.comments.push(
    { n: 1, blockId: htmlBlockId, anchor: { kind: 'dom', ref: '1', hint: 'Old' }, text: 'update this', createdAt: new Date().toISOString(), round: 1 },
    { n: 2, blockId: mermaidBlockId, anchor: { kind: 'mermaid', ref: 'A' }, text: 'rename', createdAt: new Date().toISOString(), round: 1 },
  );
  const domResolved = resolveComment(board, board.comments[0]);
  assert.equal(domResolved.resolved, true, 'a real anchor nested inside an option must not report lost');
  assert.equal(domResolved.blockKind, 'html');

  const mermaidResolved = resolveComment(board, board.comments[1]);
  assert.equal(mermaidResolved.resolved, true);
  assert.equal(mermaidResolved.blockKind, 'mermaid');
});

check('choose-between-rendered-variants: a question nested inside an option\'s own block is findable by questionBlocks and its answer reaches the packet', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which?',
      widget: 'choose-between-rendered-variants',
      options: [{ label: 'A', block: { kind: 'question', prompt: 'Nested?', widget: 'single', options: [{ label: 'Yes' }] } }],
    }],
  });
  const outer = board.blocks[0];
  const nested = outer.options[0].block;
  const ids = questionBlocks(board).map(b => b.id);
  assert.deepEqual(ids.sort(), [outer.id, nested.id].sort());

  applySubmit(board, {
    action: 'send',
    answers: [{ id: outer.id, status: 'answered', choice: 'A', note: '' }, { id: nested.id, status: 'answered', choice: 'Yes', note: '' }],
    comments: [],
  }, 1);
  const packet = buildPacket(board, 1, 'http://x');
  assert.deepEqual(packet.answers.map(a => a.id).sort(), [outer.id, nested.id].sort());
});

check('renderWidget throws for a widget with no render case, rather than silently rendering renderSingleChoice\'s empty cards (ablation: this must fail against a `default: return renderSingleChoice(...)`)', () => {
  // Constructed directly, bypassing createBoard/normalizeBlock's own WIDGETS
  // validation (which would reject this widget before it ever reached render)
  // -- this proves renderWidget's OWN defence, the one that matters if a
  // future WIDGETS entry is ever added without a matching render case.
  const board = createBoard({ title: 't', blocks: [{ kind: 'question', prompt: 'Q', widget: 'single', options: [{ label: 'Yes' }] }] });
  board.blocks[0].widget = 'nonsense-widget';
  assert.throws(() => renderBoardPage(board), /no render case for widget/);
});

check('computeBoardPatch reports an option\'s nested block, by its own id, when a choose-between-rendered-variants question is amended', () => {
  const q = (text) => ({
    id: 'q1', round: 1, kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
    options: [
      { label: 'A', block: { id: 'd1', round: 1, kind: 'markdown', text, html: `<p>${text}</p>`, anchors: [] } },
      { label: 'B', block: { id: 'd2', round: 1, kind: 'markdown', text: 'unchanged', html: '<p>unchanged</p>', anchors: [] } },
    ],
  });
  const prev = { blocks: [q('old copy')], rounds: [{ n: 1, status: 'open' }] };
  const next = { blocks: [q('new copy')], rounds: [{ n: 1, status: 'open' }] };
  const patch = computeBoardPatch(prev, next);
  assert.ok(patch.changedBlockIds.includes('d1'), 'the changed option\'s own block must be reported by its own id');
  assert.ok(!patch.changedBlockIds.includes('d2'), 'the untouched sibling option must not be reported');
  assert.ok(!patch.changedBlockIds.includes('q1'), 'the container question did not itself change');
});

// choose-between-rendered-variants: the actual click/keyboard gesture, driven
// through the real client script in the DOM stand-in -- the same discipline
// test/check-click.mjs's own header comment names ("exercising the real
// gesture rather than the pieces underneath it").

function loadVariantBoard(board, protocol = 'http:') {
  const document = parseHTML(renderBoardPage(board));
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

check('choose-between-rendered-variants: clicking a card selects it and deselects its sibling (ablation: this must fail if selectVariant is never wired to \'.choice-variant\')', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', block: { kind: 'markdown', text: 'copy A' } },
        { label: 'B', block: { kind: 'markdown', text: 'copy B' } },
      ],
    }],
  });
  const document = loadVariantBoard(board);
  const cards = document.querySelectorAll('.choice-variant');
  assert.equal(cards.length, 2, 'setup failure: expected two rendered variant cards');
  cards[0].dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), true, 'clicking a card must select it');
  assert.equal(cards[1].classList.contains('selected'), false);
  cards[1].dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[0].classList.contains('selected'), false, 'selecting a sibling must deselect the previous pick');
  assert.equal(cards[1].classList.contains('selected'), true);
});

check('choose-between-rendered-variants: Enter/Space while the card has focus selects it -- the keyboard-operable half of a container that cannot be a real <button>', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [{ label: 'A', block: { kind: 'markdown', text: 'copy A' } }],
    }],
  });
  const document = loadVariantBoard(board);
  const card = document.querySelector('.choice-variant');
  assert.equal(card.getAttribute('tabindex'), '0', 'an open round\'s card must be in the tab order');
  assert.equal(card.getAttribute('role'), 'button');
  card.dispatchEvent(new StandInEvent('keydown', { key: 'Enter' }));
  assert.equal(card.classList.contains('selected'), true, 'Enter must select the focused card');
  card.dispatchEvent(new StandInEvent('keydown', { key: 'Tab' }));
  // no assertion needed beyond "did not throw" -- Tab must not be treated as a select key
});

check('choose-between-rendered-variants: a click on the option\'s own comment button opens the comment form and does NOT select the card', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [{ label: 'A', block: { kind: 'markdown', text: '# heading' } }],
    }],
  });
  const document = loadVariantBoard(board);
  const card = document.querySelector('.choice-variant');
  const nestedBlockId = board.blocks[0].options[0].block.id;
  const commentBtn = document.querySelector('button.comment-btn[data-block-id="' + nestedBlockId + '"]');
  assert.ok(commentBtn, 'setup failure: no comment button rendered for the nested block');
  commentBtn.dispatchEvent(new StandInEvent('click'));
  assert.equal(card.classList.contains('selected'), false, 'clicking the nested block\'s own comment button must not select the variant');
  const form = document.getElementById('comment-form-' + nestedBlockId);
  assert.equal(form.classList.contains('open'), true, 'the comment button\'s own gesture must still work, undisturbed by the card wrapping it');
});

check('choose-between-rendered-variants: turning comment mode on makes a plain card click do nothing, the same stand-down every other choice widget already honours', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [{ label: 'A', block: { kind: 'markdown', text: 'copy A' } }],
    }],
  });
  const document = loadVariantBoard(board);
  document.getElementById('comment-mode-toggle').dispatchEvent(new StandInEvent('click'));
  const card = document.querySelector('.choice-variant');
  card.dispatchEvent(new StandInEvent('click'));
  assert.equal(card.classList.contains('selected'), false, 'a plain click must not select while comment mode is on');
});

check('choose-between-rendered-variants: a historical (sent) round\'s card ignores both a click and Enter, and the picked option stays visibly selected', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', block: { kind: 'markdown', text: 'copy A' } },
        { label: 'B', block: { kind: 'markdown', text: 'copy B' } },
      ],
    }],
  });
  applySubmit(board, { action: 'send', answers: [{ id: board.blocks[0].id, status: 'answered', choice: 'A', note: '' }], comments: [] }, 1);
  const document = loadVariantBoard(board);
  const cards = document.querySelectorAll('.choice-variant');
  assert.equal(cards[0].classList.contains('selected'), true, 'the picked option must still render selected once sent');
  assert.equal(cards[0].getAttribute('aria-disabled'), 'true');
  assert.equal(cards[0].getAttribute('tabindex'), '-1', 'a historical card must be out of the tab order');
  cards[1].dispatchEvent(new StandInEvent('click'));
  assert.equal(cards[1].classList.contains('selected'), false, 'a historical round must never accept a new pick');
  assert.equal(cards[0].classList.contains('selected'), true, 'and must not lose the original pick either');
});

// --- C3: an answer must name a real question of the round being submitted ---------

check('C3: an answer whose id names no question block of that round is ignored, not stored', () => {
  // Ablation: remove the `answerable.has(a.id)` guard and a forged submit writes
  // board.answers['ghost9'], which buildPacket hands straight to the agent.
  const board = createBoard({
    title: 't',
    blocks: [
      { kind: 'markdown', text: '# A' },
      { kind: 'question', prompt: 'Real?', widget: 'single', options: [{ label: 'Yes' }] },
    ],
  });
  applySubmit(board, {
    action: 'send',
    answers: [
      { id: 'ghost9', status: 'answered', choice: 'Yes', note: 'forged' },
      { id: 'd1', status: 'answered', choice: 'Yes', note: 'not a question' },
      { id: 'q1', status: 'answered', choice: 'Yes', note: 'real' },
    ],
    comments: [],
  }, 1);
  assert.equal(board.answers.ghost9, undefined);
  assert.equal(board.answers.d1, undefined);
  assert.equal(board.answers.q1.note, 'real');
  assert.deepEqual(Object.keys(board.answers), ['q1']);
});

check('C3: a later round\'s submit cannot rewrite an already-sent round\'s answer', () => {
  const board = createBoard({
    title: 't',
    blocks: [{ kind: 'question', prompt: 'R1?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  applySubmit(board, { action: 'send', answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'question', prompt: 'R2?', widget: 'single', options: [{ label: 'A' }] }] });
  applySubmit(board, {
    action: 'send',
    answers: [{ id: 'q1', status: 'answered', choice: 'No', note: 'rewritten' }, { id: 'q2', status: 'answered', choice: 'A', note: '' }],
    comments: [],
  }, 2);
  assert.equal(board.answers.q1.choice, 'Yes', 'round 1\'s settled answer must survive round 2\'s submit');
  assert.equal(board.answers.q2.choice, 'A');
});

// --- N3: nested questions are real questions -------------------------------------

check('N3: answers to questions nested in a compare side or a question\'s context reach the packet', () => {
  // Ablation: walk `board.blocks` directly in buildPacket/applySubmit instead of
  // questionBlocks() and the packet reports ONLY the top-level question -- the
  // reviewer answered three, the answers were persisted, and the agent is told one.
  const board = createBoard({
    title: 'nested',
    blocks: [
      {
        kind: 'compare',
        left: { label: 'A', block: { kind: 'question', prompt: 'In compare?', widget: 'single', options: [{ label: 'Yes' }] } },
        right: { label: 'B', block: { kind: 'markdown', text: '# B' } },
      },
      {
        kind: 'question',
        prompt: 'Top level?',
        widget: 'single',
        options: [{ label: 'Yes' }],
        context: [{ kind: 'question', prompt: 'In context?', widget: 'single', options: [{ label: 'Yes' }] }],
      },
    ],
  });
  const ids = questionBlocks(board).map(b => b.id);
  assert.equal(ids.length, 3, 'three question blocks exist on this board');

  applySubmit(board, {
    action: 'send',
    answers: ids.map(id => ({ id, status: 'answered', choice: 'Yes', note: '' })),
    comments: [],
  }, 1);
  assert.deepEqual(Object.keys(board.answers).sort(), [...ids].sort());

  const packet = buildPacket(board, 1, 'http://x');
  assert.deepEqual(packet.answers.map(a => a.id).sort(), [...ids].sort());
  for (const a of packet.answers) assert.equal(a.choice, 'Yes');
});

check('N11: the STORED json carries an explicit unanswered entry for an untouched question, nested ones included', () => {
  // Ablation: delete the unanswered-synthesis loop in applySubmit. The packet still
  // looks right (buildPacket has its own fallback), which is why the suite stayed
  // green -- but the archive, which criteria 4 and 14 rest on, can no longer tell
  // "the reviewer left this blank" from "this round was never submitted".
  const board = createBoard({
    title: 't',
    blocks: [
      { kind: 'question', prompt: 'Touched?', widget: 'single', options: [{ label: 'Yes' }] },
      { kind: 'question', prompt: 'Untouched?', widget: 'single', options: [{ label: 'Yes' }], context: [{ kind: 'question', prompt: 'Nested untouched?', widget: 'single', options: [{ label: 'Yes' }] }] },
    ],
  });
  applySubmit(board, { action: 'send', answers: [{ id: 'q1', status: 'answered', choice: 'Yes', note: '' }], comments: [] }, 1);
  const stored = JSON.parse(JSON.stringify(board)); // exactly what src/store.mjs persists
  assert.equal(stored.answers.q2.status, 'unanswered');
  assert.equal(stored.answers.q2.choice, null);
  assert.equal(stored.answers.q2.note, '');
  assert.equal(stored.answers.q3.status, 'unanswered');
});

// --- M4: the packet is the round, not the thread's history ------------------------

check('M4: the packet carries only the round being submitted, and every entry names its round', () => {
  // Ablation: drop the `b.round === round` / `c.round === round` filters and round
  // 2's packet redelivers round 1 -- /grill re-addresses settled feedback and
  // re-reports round 1's `deferred` as a fresh signal.
  const board = createBoard({
    title: 't',
    blocks: [
      { kind: 'markdown', text: '# R1\n\n- one' },
      { kind: 'question', prompt: 'R1 question', widget: 'single', options: [{ label: 'Yes' }] },
    ],
  });
  applySubmit(board, {
    action: 'send',
    answers: [{ id: 'q1', status: 'deferred', choice: null, note: 'later' }],
    comments: [{ blockId: 'd1', anchor: { kind: 'md', ref: 'r1-li1', label: 'one' }, text: 'round 1 feedback' }],
  }, 1);

  addRound(board, { blocks: [{ kind: 'question', prompt: 'R2 question', widget: 'single', options: [{ label: 'A' }] }] });
  applySubmit(board, {
    action: 'send',
    answers: [{ id: 'q2', status: 'answered', choice: 'A', note: '' }],
    comments: [{ blockId: 'd1', anchor: { kind: 'block' }, text: 'round 2 feedback' }],
  }, 2);

  const p1 = buildPacket(board, 1, 'http://x');
  assert.deepEqual(p1.answers.map(a => a.id), ['q1']);
  assert.deepEqual(p1.comments.map(c => c.text), ['round 1 feedback']);

  const p2 = buildPacket(board, 2, 'http://x');
  assert.deepEqual(p2.answers.map(a => a.id), ['q2'], 'round 2 must not redeliver round 1');
  assert.deepEqual(p2.comments.map(c => c.text), ['round 2 feedback']);
  assert.equal(p2.answers[0].round, 2);
  assert.equal(p2.comments[0].round, 2);
  assert.equal(typeof p2.comments[0].createdAt, 'string');
  // the full history is still in the board itself, and still distinguishable
  assert.equal(Object.keys(board.answers).length, 2);
  assert.equal(board.comments.length, 2);
});

// --- N1: the scheme allowlist cannot be stepped around with a control byte --------

check('N1: a leading C0 control byte does not smuggle javascript: past the scheme allowlist', () => {
  // Ablation: drop stripUrlControls and `[x](\x01javascript:alert(1))` emits
  // href="\x01javascript:alert(1" -- the HTML tokenizer keeps U+0001 in the
  // attribute, but the WHATWG URL parser strips leading C0 controls before reading
  // the scheme, so the browser navigates to javascript: and executes at the
  // daemon's origin. Markdown blocks come from arbitrary files on disk, which is the
  // exact threat the allowlist exists for.
  for (const ctrl of ['\x00', '\x01', '\x08', '\x0e', '\x1f', '\x7f']) {
    const html = mdToHtml(`[x](${ctrl}javascript:alert(1))`);
    assert.ok(!html.includes('javascript:'), `control byte ${ctrl.charCodeAt(0)} must not smuggle a javascript: href`);
    assert.ok(html.includes('href="#"'));
    const img = mdToHtml(`![x](${ctrl}javascript:alert(1))`);
    assert.ok(!img.includes('javascript:'));
  }
  // and the emitted URL is the vetted, normalised one -- no stray control bytes
  const clean = mdToHtml('[x](\x01https://example.com/a)');
  assert.ok(clean.includes('href="https://example.com/a"'));
  assert.ok(!clean.includes('\x01'));
  // ticket 10's original guarantees still hold
  assert.ok(mdToHtml('[t](javascript:alert(1))').includes('href="#"'));
  assert.ok(mdToHtml('[t](https://x.se)').includes('href="https://x.se"'));
});

// --- N2: nothing on the request thread may backtrack quadratically ----------------
//
// The daemon is single-threaded: while any of these run, health, every other board
// and every SSE stream are stopped. Each bound below is ~50x the fixed
// implementation's measured time and a small fraction of the pre-fix time.

check('N2: a long non-separator line after a table-shaped line is probed in linear time', () => {
  // Ablation: restore /^\s*\|?[\s|:-]+$/ + .includes('-'): 100KB took 4.0s, 400KB
  // 63s, ~1MB about 7 minutes -- from two lines of ordinary-looking input.
  const md = '| h |\n' + ' '.repeat(200000) + 'x\n';
  const started = Date.now();
  mdToHtml(md);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `table-separator probe took ${elapsed}ms on 200KB`);
});

check('N2: underscore-heavy prose with no closing delimiter is scanned in linear time', () => {
  // Ablation: restore the lazy /(^|[\s(])_(?=\S)([\s\S]*?\S)_(?=$|[\s).,;:!?])/g
  // pair: 3.4s at 256KB, ~54s at 1MB -- reachable from ordinary prose, no crafting.
  const md = ' _a'.repeat(150000); // 450KB, inside the by-value cap
  const started = Date.now();
  mdToHtml(md);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `underscore emphasis took ${elapsed}ms on 450KB`);
});

check('N2: an html block full of unclosed script tags is parsed in linear time -- the persistent one', () => {
  // Ablation: restore the /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi strip: 5.4s at
  // 224KB, ~100s at 1MB. This one is PERSISTENT -- a single dom-anchored comment
  // makes resolveComment re-run it on every renderBoardPage, every SSE fragment and
  // every buildPacket, so one comment poisons the board for good.
  const html = '<script>x'.repeat(25000);
  const started = Date.now();
  parseHtmlTree(html);
  resolveDomAnchor(html, '1', 'x');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `parseHtmlTree took ${elapsed}ms on ~225KB`);
});

check('N2: emphasis still renders correctly after the rewrite -- linearity did not cost behaviour', () => {
  assert.ok(mdToHtml('a __bold__ b').includes('<strong>bold</strong>'));
  assert.ok(mdToHtml('a _em_ b').includes('<em>em</em>'));
  assert.ok(mdToHtml('_Findings for MAP_AUTH.md, census._').includes('<em>Findings for MAP_AUTH.md, census.</em>'));
  assert.ok(!mdToHtml('plain ssn_country stays literal').includes('<em>'));
});

// --- C2, second half: the caller does not get to choose an unbounded cwd ----------
//
// Confinement to `cwd` buys nothing while the caller also picks `cwd`: `cwd: '/'` plus
// a relative path reaches the whole filesystem, which is how the coordinator's live
// exfil still worked after the per-reference confinement landed. These pin what the
// binding does achieve. What it does NOT achieve is written down in `bindBoardCwd`'s
// comment in src/board.mjs and is a spec question, not a gap these checks paper over.

check('C2b: the live exfil PoC -- an unbounded cwd plus a relative path -- is refused at post time', () => {
  // Ablation: drop the `real === path.parse(real).root` branch in resolveBoardCwd and
  // this board is created with cwd '/', after which { path: 'etc/passwd' } resolves,
  // confinement and all, and the content lands in the board JSON and the served page.
  assert.throws(
    () => createBoard({
      title: 'exfil',
      cwd: '/',
      blocks: [{ kind: 'code', source: { path: 'etc/passwd' } }],
    }),
    /filesystem root is not a project directory/,
  );
});

check('C2b: $HOME, a directory above it, a non-directory and a path that does not exist are all refused as cwd', () => {
  // Ablation: drop the homedir()/contains() branch and `cwd: os.homedir()` is accepted
  // -- every project at once, plus ssh keys, browser profiles and shell history, all
  // reachable by relative path from a board that passes every other check.
  const home = os.homedir();
  assert.throws(() => createBoard({ title: 't', cwd: home, blocks: [] }), /too broad/);
  assert.throws(() => createBoard({ title: 't', cwd: path.dirname(home), blocks: [] }), /too broad/);
  const file = path.join(fixturesDir, 'not-a-dir.txt');
  writeFileSync(file, 'x', 'utf8');
  assert.throws(() => createBoard({ title: 't', cwd: file, blocks: [] }), /not a directory/);
  assert.throws(() => createBoard({ title: 't', cwd: path.join(fixturesDir, 'nope'), blocks: [] }), /does not exist/);
  assert.throws(() => createBoard({ title: 't', cwd: 'relative/project', blocks: [] }), /must be an absolute path/);
});

check('C2b: a bound cwd is stored canonicalised, so the board records the directory its content actually came from', () => {
  const link = path.join(fixturesDir, 'project-link');
  const realProject = path.join(fixturesDir, 'real-project');
  mkdirSync(realProject, { recursive: true });
  writeFileSync(path.join(realProject, 'note.md'), '# Note\n\nreal body', 'utf8');
  try { unlinkSync(link); } catch { /* not there yet */ }
  symlinkSync(realProject, link);

  const board = createBoard({
    title: 'canonical',
    cwd: link,
    blocks: [{ kind: 'markdown', source: { path: 'note.md' } }],
  });
  assert.equal(board.cwd, realpathSync(realProject), 'the stored cwd is the realpath, not the spelling posted');
  assert.ok(board.blocks[0].text.includes('real body'));
});

check('C2b: a later round cannot retarget a live board at a different project directory', () => {
  // Ablation: remove assertCwdNotRetargeted from addRound/amendRound and a second post
  // moves the filesystem out from under a board the reviewer already has open, with
  // round 1 still on screen vouching for it.
  const projectA = path.join(fixturesDir, 'project-a');
  const projectB = path.join(fixturesDir, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(path.join(projectA, 'a.md'), '# A\n\nfrom project A', 'utf8');
  writeFileSync(path.join(projectB, 'b.md'), '# B\n\nfrom project B', 'utf8');

  const board = createBoard({ title: 't', cwd: projectA, blocks: [{ kind: 'markdown', source: { path: 'a.md' } }] });
  const boundCwd = board.cwd;

  assert.throws(
    () => amendRound(board, { blocks: [{ kind: 'markdown', source: { path: 'b.md' } }], cwd: projectB }),
    /cannot change the project directory of a live board/,
  );
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  assert.throws(
    () => addRound(board, { blocks: [{ kind: 'markdown', source: { path: 'b.md' } }], cwd: projectB }),
    /cannot change the project directory of a live board/,
  );
  assert.equal(board.cwd, boundCwd, 'the rejected attempts must leave the binding untouched');
  assert.equal(board.blocks.length, 1, 'and must not have added a block');

  // agreeing with the existing binding is not a retarget, and a round with no cwd at
  // all -- what the shim actually sends -- still works
  assert.doesNotThrow(() => addRound(board, { blocks: [{ kind: 'markdown', text: '# ok' }], cwd: projectA }));
  assert.doesNotThrow(() => amendRound(board, { blocks: [{ kind: 'markdown', text: '# also ok' }] }));
});

check('C2b: a second board in an EXISTING thread inherits that thread\'s cwd and cannot move it', () => {
  // The thread's directory is bound once. `threadCwd` is what src/server.mjs passes
  // when the post names a thread that already exists (see the report: that call site
  // is the one line this needs on the server side).
  const projectA = path.join(fixturesDir, 'thread-a');
  const projectB = path.join(fixturesDir, 'thread-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const bound = realpathSync(projectA);

  const second = createBoard({ title: 't2', thread: 'th_abcd1234', cwd: projectA, threadCwd: bound, blocks: [] });
  assert.equal(second.cwd, bound);
  assert.equal(second.thread, 'th_abcd1234');
  // omitting cwd entirely inherits the thread's, rather than falling back to "none"
  assert.equal(createBoard({ title: 't3', thread: 'th_abcd1234', threadCwd: bound, blocks: [] }).cwd, bound);
  assert.throws(
    () => createBoard({ title: 't4', thread: 'th_abcd1234', cwd: projectB, threadCwd: bound, blocks: [] }),
    /cannot retarget thread/,
  );
});

check('C2b: a board with NO cwd cannot resolve a reference at all -- it never falls back to the daemon\'s own directory', () => {
  // Ablation: restore `realpathSync(cwd || process.cwd())` and a board that named no
  // project directory resolves against whatever directory launchd started the daemon
  // in -- a directory nobody chose, that no board records, and that is plausibly /.
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', source: { path: 'package.json' } }] });
  assert.equal(board.cwd, null);
  assert.match(board.blocks[0].error, /no project directory/);
  assert.equal(board.blocks[0].text, '');
  assert.match(resolveRef({ path: 'package.json' }).error, /no project directory/);
});

// --- N10: an out-of-range line reference is an error, not an empty block ----------

check('N10: a line range past the end of a newline-terminated file errors instead of returning empty text', () => {
  // Ablation: split without dropping the phantom trailing element and lines:[4,4] on
  // a 3-line file returns { text: '', sha: e3b0c442... } with NO error, rendering an
  // empty <pre> the reviewer cannot interpret -- PROTOCOL.md names out-of-range
  // lines as exactly what `error` is for.
  writeFileSync(path.join(fixturesDir, 'three.txt'), 'a\nb\nc\n', 'utf8');
  const at = { cwd: fixturesDir };
  assert.match(resolveRef({ path: 'three.txt', lines: [4, 4] }, at).error, /past end of file/);
  assert.match(resolveRef({ path: 'three.txt', lines: [2, 9] }, at).error, /past end of file/);
  assert.equal(resolveRef({ path: 'three.txt', lines: [1, 3] }, at).text, 'a\nb\nc');
  assert.equal(resolveRef({ path: 'three.txt', lines: [3, 3] }, at).text, 'c');
});

// --- P1: Discuss in chat, the second way out -----------------------------------
//
// DESIGN.md Decisions -> "Two ways out, plus a wall clock" / acceptance
// criterion 7. The whole path behind it (POST /submit {action:'discuss'},
// board.state='discuss', the shim's stop-posting branch) shipped and is checked
// elsewhere; for a long stretch the AFFORDANCE did not exist at all, so half of
// criterion 7 was dead with every server-side check still green. These assertions
// are against the rendered markup with the <style> block, the #board-data payload
// and the client script stripped (renderedMarkup above) -- the string "discuss"
// occurs in the inlined JSON's `state` field and in src/ui.mjs's own source, so an
// assertion against the raw page would pass without a button existing.

check('the send bar carries Discuss in chat beside Send, in the rendered markup', () => {
  const board = createBoard({
    title: 'Two ways out',
    blocks: [{ kind: 'question', prompt: 'Pick', widget: 'single', options: [{ label: 'A' }] }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('id="send-btn"'));
  assert.ok(markup.includes('id="discuss-btn"'), 'the board must render a Discuss-in-chat control, not just Send');
  assert.match(markup, /Discuss in chat/, 'the control must be labelled for a human, not just carry an id');
  // Beside Send, inside the one .send-bar -- which is what makes it disappear in
  // readonly exactly as Send does (body.readonly .send-bar { display: none }).
  const bar = markup.slice(markup.indexOf('<div class="send-bar">'), markup.indexOf('</div>', markup.indexOf('id="send-btn"')));
  assert.ok(bar.includes('id="discuss-btn"'), 'Discuss must live inside the send bar, so readonly hides both together');
  assert.ok(bar.includes('id="send-btn"'));
});

check('Discuss posts the same body as Send through one shared submit path, differing only in action', () => {
  // One fetch, one body-building path: a second, hand-copied fetch is how Discuss
  // would quietly come to collect less than Send does (DESIGN.md: it returns
  // "whatever is filled in" -- partial answers are the point).
  const submitFetches = [...ui.matchAll(/fetch\([^)]*\/submit/g)];
  assert.equal(submitFetches.length, 1, 'both actions must share one submit fetch, not carry two divergent copies');
  const submitBody = namedFunctionBody(ui, 'submitBoard');
  assert.ok(submitBody, 'expected a shared submitBoard(action)');
  assert.match(submitBody, /action:\s*action/, 'the posted body must carry the caller-chosen action verbatim');
  assert.match(submitBody, /comments:\s*pendingComments/, 'Discuss must carry the queued comments too');
  assert.match(submitBody, /collectAnswers\(\)/, 'Discuss must read the same answer surface Send does');
  const listeners = listenerBodies(ui);
  const discussListener = listeners.find(b => /submitBoard\('discuss'\)/.test(b));
  const sendListener = listeners.find(b => /submitBoard\('send'\)/.test(b));
  assert.ok(discussListener, "a click listener must post action 'discuss'");
  assert.ok(sendListener, "a click listener must post action 'send'");
  assert.match(discussListener, /\breadonly\b/, 'Discuss must be inert in readonly mode');
});

check('Send also requests notification permission -- the one click guaranteed to be on a focused tab', () => {
  // notifyRound's own requestPermission() call only fires from the hidden-tab
  // branch, i.e. the one moment Chrome will NOT raise the prompt in the
  // foreground (it queues it instead). Send is the fix: the tab is definitely
  // focused there, so a reviewer stuck at "default" permission has a way in.
  const listeners = listenerBodies(ui);
  const sendListener = listeners.find(b => /submitBoard\('send'\)/.test(b));
  assert.ok(sendListener, "expected the Send click listener");
  assert.match(sendListener, /requestNotifyPermissionFromSend\(\)|requestPermission\(\)/, 'Send must request notification permission');
  const permFn = namedFunctionBody(ui, 'requestNotifyPermissionFromSend');
  assert.ok(permFn, 'expected a requestNotifyPermissionFromSend helper in src/ui.mjs');
  assert.match(permFn, /if \(readonly\) return;/, 'must be inert in the file:// archive -- it requests nothing');
  assert.match(permFn, /typeof Notification === 'undefined'/, 'must degrade silently where Notification does not exist');
  assert.match(permFn, /Notification\.permission !== 'default'/, 'granted must be left alone and denied must never be re-prompted');
  assert.match(permFn, /requestPermission\(\)/);
  assert.ok(!/new Notification\(/.test(permFn), 'the Send path requests permission only -- creating a Notification stays notifyRound\'s job');
});

// --- P6: a queued comment gets its pin immediately ------------------------------
//
// DESIGN.md calls the batching the win ("queue a dozen comments, send once");
// criterion 10 says "a numbered pin appears on the element". The queue-side of
// that used to push onto pendingComments and never touch a pin layer, so no pin
// appeared until after Send. commentsWithPending is extracted and evaluated here
// rather than pattern-matched, so the numbering is actually exercised.

function evalCommentsWithPending(board, pendingComments) {
  const next = namedFunctionBody(ui, 'nextCommentNumber');
  const body = namedFunctionBody(ui, 'commentsWithPending');
  assert.ok(next && body, 'expected nextCommentNumber and commentsWithPending in src/ui.mjs');
  const fn = new Function('board', 'pendingComments',
    `function nextCommentNumber() {${next}}\nfunction commentsWithPending() {${body}}\nreturn commentsWithPending();`);
  return fn(board, pendingComments);
}

check('a comment queued but not yet sent gets a provisional number continuing the server sequence, flagged pending', () => {
  const board = {
    comments: [
      { n: 1, blockId: 'h1', anchor: { kind: 'dom', ref: '1.1' }, text: 'first', resolved: true },
      { n: 2, blockId: 'm1', anchor: { kind: 'mermaid', ref: 'A' }, text: 'second', resolved: false, lost: 'A' },
    ],
  };
  const pending = [
    { blockId: 'h1', anchor: { kind: 'dom', ref: '1.2' }, text: 'queued one' },
    { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'B' }, text: 'queued two' },
  ];
  const all = evalCommentsWithPending(board, pending);
  assert.equal(all.length, 4, 'pending comments must appear alongside the persisted ones, not instead of them');
  // The server's own comments are passed through untouched, verdict included.
  assert.deepEqual(all.slice(0, 2), board.comments);
  assert.equal(all[2].n, 3, 'the first queued comment continues the sequence');
  assert.equal(all[3].n, 4, 'and the next one continues it again');
  assert.equal(all[2].pending, true);
  assert.equal(all[3].pending, true);
  assert.ok(!all[0].pending && !all[1].pending, 'a sent comment must never be flagged pending');
  // Once the queue is emptied (a submit landed) the provisional pins are gone --
  // the reconciliation, and why a comment can never be pinned twice.
  assert.deepEqual(evalCommentsWithPending(board, []), board.comments);
});

check('an empty board numbers the first queued comment 1, not 0 or NaN', () => {
  const all = evalCommentsWithPending({ comments: [] }, [{ blockId: 'h1', anchor: { kind: 'dom', ref: '1' }, text: 'x' }]);
  assert.equal(all.length, 1);
  assert.equal(all[0].n, 1);
});

check('both pin renderers draw from commentsWithPending, and queueing a comment refreshes the pins right then', () => {
  const domPins = namedFunctionBody(ui, 'renderDomPins');
  const mermaidPins = namedFunctionBody(ui, 'renderMermaidPins');
  assert.match(domPins, /commentsWithPending\(\)/, 'dom pins must include the unsent queue, not only board.comments');
  assert.match(mermaidPins, /commentsWithPending\(\)/, 'mermaid pins must include the unsent queue, not only board.comments');
  // The queue-a-comment listener itself has to trigger a redraw; without it the
  // pin would only appear on the next resize.
  const queueListener = listenerBodies(ui).find(b => /pendingComments\.push/.test(b));
  assert.ok(queueListener, 'expected the comment-form submit listener');
  assert.match(queueListener, /refreshPins\(/, 'queueing a comment must place its pin immediately, not wait for Send');
  // And a landed submit must empty the queue BEFORE redrawing, or the provisional
  // pins would be joined by the server-numbered copies of the same comments.
  const submitBody = namedFunctionBody(ui, 'submitBoard');
  const emptyIdx = submitBody.indexOf('pendingComments = []');
  const refreshIdx = submitBody.indexOf('refreshPins(', emptyIdx === -1 ? 0 : emptyIdx);
  assert.ok(emptyIdx !== -1, 'a landed submit must empty the pending queue');
  assert.ok(refreshIdx > emptyIdx, 'pins must be re-rendered after the queue is emptied, so provisional pins give way to the server\'s');
});

check('a pending pin is visually distinguishable from a sent one, in both the client and the stylesheet', () => {
  const placePin = namedFunctionBody(ui, 'placePin');
  assert.match(placePin, /c\.pending \? ' pin-pending' : ''/, 'placePin must mark a provisional pin with its own class');
  assert.ok(styles.includes('.anchor-pin.pin-pending'), 'src/styles.mjs must style .pin-pending differently from a sent pin');
});

// --- DESIGN.md polish ticket 02: the pending-comment queue, pure -----------------
//
// findPendingCommentForAnchor (criterion 1's "reopen and edit", also reused for
// criterion 12's "already sent") and removePendingComment (criterion 2's delete
// control) are the two functions this ticket's own log calls out for
// extraction, exercised here with no DOM at all -- src/ui.mjs only ever embeds
// this exact src/anchor.mjs source via .toString(), so what is checked here is
// what actually runs on the page.

check('findPendingCommentForAnchor finds a queued comment by anchor, across every anchor kind actually in use', () => {
  const pending = [
    { id: 1, blockId: 'd1', anchor: { kind: 'md', ref: 'findings', label: 'Findings' }, text: 'md one' },
    { id: 2, blockId: 'h1', anchor: { kind: 'dom', ref: '1.2', hint: 'the Send button' }, text: 'dom one' },
    { id: 3, blockId: 'm1', anchor: { kind: 'mermaid', ref: 'A', domRef: '1.1', hint: 'Start' }, text: 'mermaid one' },
    { id: 4, blockId: 'd1', anchor: { kind: 'block' }, text: 'a whole-block remark' },
  ];
  assert.equal(findPendingCommentForAnchor(pending, 'd1', { kind: 'md', ref: 'findings' }).id, 1);
  assert.equal(findPendingCommentForAnchor(pending, 'h1', { kind: 'dom', ref: '1.2' }).id, 2);
  assert.equal(findPendingCommentForAnchor(pending, 'm1', { kind: 'mermaid', ref: 'A' }).id, 3);
  assert.equal(findPendingCommentForAnchor(pending, 'd1', { kind: 'block' }).id, 4);
  // The match is on blockId + anchor kind/ref, not hint/domRef/label -- a
  // caller re-deriving the SAME clicked element's anchor a second time is not
  // guaranteed to recompute byte-identical cosmetic fields (composeHint can
  // legitimately read different live text between two clicks), and criterion
  // 1 must still recognise it as the same target.
  assert.equal(findPendingCommentForAnchor(pending, 'h1', { kind: 'dom', ref: '1.2', hint: 'a different hint now' }).id, 2);
  // A ref/kind/block that was never queued is simply not found.
  assert.equal(findPendingCommentForAnchor(pending, 'h1', { kind: 'dom', ref: '9.9' }), undefined);
  assert.equal(findPendingCommentForAnchor(pending, 'd1', { kind: 'md', ref: 'findings' }) !== undefined, true, 'setup sanity');
  assert.equal(findPendingCommentForAnchor(pending, 'nope', { kind: 'md', ref: 'findings' }), undefined, 'a different blockId must not match');
});

check('findPendingCommentForAnchor never matches a SENT comment -- criterion 3\'s "no edit path" holds at the function level, not just by caller discipline', () => {
  // A comment shaped exactly like a sent one (it carries an 'n', the way
  // board.comments entries do) but living in a list that is NOT the page's
  // pendingComments -- the point being that this function has no notion of
  // "sent" at all, it only ever searches the list it is handed. Called with an
  // EMPTY pendingComments (the real, unsent queue), the sent-shaped comment
  // sitting elsewhere can never be found through this function.
  const sentComments = [{ n: 1, blockId: 'h1', anchor: { kind: 'dom', ref: '1.2' }, text: 'already sent' }];
  const pendingComments = [];
  assert.equal(findPendingCommentForAnchor(pendingComments, 'h1', { kind: 'dom', ref: '1.2' }), undefined,
    'a sent comment living outside pendingComments must never be found by this function');
  // And the SAME function, called with board.comments itself (exactly what
  // src/ui.mjs's isSentAnchor does for criterion 12), DOES find it -- proving
  // the function is a plain list search, not silently sent-aware.
  assert.equal(findPendingCommentForAnchor(sentComments, 'h1', { kind: 'dom', ref: '1.2' }).text, 'already sent');
});

check('removePendingComment removes the middle of three, and the remaining two renumber contiguously', () => {
  const pending = [
    { id: 10, blockId: 'h1', anchor: { kind: 'dom', ref: '1.1' }, text: 'first' },
    { id: 11, blockId: 'h1', anchor: { kind: 'dom', ref: '1.2' }, text: 'second' },
    { id: 12, blockId: 'h1', anchor: { kind: 'dom', ref: '1.3' }, text: 'third' },
  ];
  const after = removePendingComment(pending, 11);
  assert.equal(after.length, 2, 'exactly one entry must be removed');
  assert.deepEqual(after.map(c => c.id), [10, 12], 'the other two must survive, in their original relative order');
  // Provisional numbers are never stored on an entry -- they are derived from
  // POSITION (nextCommentNumber() + index, src/ui.mjs's commentsWithPending),
  // so re-deriving them from the shorter array IS the renumbering criterion 2
  // requires: what were provisional #2 and #3 become #2 and #3 again (of two),
  // contiguous, with no gap where the deleted middle one used to be.
  const base = 1; // as if board.comments is empty, nextCommentNumber() === 1
  const numbered = after.map((c, i) => ({ id: c.id, n: base + i }));
  assert.deepEqual(numbered, [{ id: 10, n: 1 }, { id: 12, n: 2 }]);
  // The original array is untouched -- a pure function, not a mutation.
  assert.equal(pending.length, 3, 'removePendingComment must not mutate the array it was given');
});

check('removePendingComment with an id that matches nothing queued is a no-op', () => {
  const pending = [
    { id: 1, blockId: 'h1', anchor: { kind: 'dom', ref: '1.1' }, text: 'only one' },
  ];
  const after = removePendingComment(pending, 999);
  assert.deepEqual(after, pending, 'an id already removed, or never queued, must leave the list unchanged');
  const emptied = removePendingComment([], 1);
  assert.deepEqual(emptied, [], 'removing from an already-empty queue is also a no-op, not a throw');
});

// --- P2 (page side): badge the tab and notify, never steal focus ---------------
//
// DESIGN.md Decisions -> "Open once, then badge and notify": "pending count in
// the title, badge on the favicon, and a macOS notification instead of a focus
// steal when the tab is open but unfocused". None of the three existed.

function evalTitleBadge(startingTitle, count) {
  const body = namedFunctionBody(ui, 'setTitleBadge');
  assert.ok(body, 'expected setTitleBadge in src/ui.mjs');
  const doc = { title: startingTitle };
  new Function('document', 'baseTitle', 'count', `(function setTitleBadge(count) {${body}})(count);`)(doc, startingTitle, count);
  return doc.title;
}

check('a pending round puts its count in the document title, and clearing restores the title exactly', () => {
  assert.equal(evalTitleBadge('Round one', 1), '(1) Round one');
  assert.equal(evalTitleBadge('Round one', 3), '(3) Round one');
  assert.equal(evalTitleBadge('Round one', 0), 'Round one', 'clearing must restore the original title, not leave "(0)"');
});

check('an SSE round push marks the tab: title count, favicon badge and a notification', () => {
  const push = namedFunctionBody(ui, 'applyRoundPush');
  assert.ok(push, 'expected applyRoundPush in src/ui.mjs');
  assert.match(push, /markPendingRound\(/, 'a round push must mark the tab -- the tab is never reopened, so the page has to say so itself');
  const mark = namedFunctionBody(ui, 'markPendingRound');
  assert.match(mark, /setTitleBadge\(/);
  assert.match(mark, /setFaviconBadge\(/);
  assert.match(mark, /notifyRound\(/);
  assert.match(mark, /if \(readonly\) return;/, 'marking must be inert in readonly mode');
});

check('the favicon badge is drawn inline as a data URI -- no new asset file, nothing external', () => {
  const draw = namedFunctionBody(ui, 'drawFavicon');
  assert.ok(draw, 'expected drawFavicon in src/ui.mjs');
  assert.match(draw, /createElement\('canvas'\)/);
  assert.match(draw, /toDataURL\(/, 'the badge must be a data URI the page draws, not a fetched or bundled file');
  const set = namedFunctionBody(ui, 'setFaviconBadge');
  assert.match(set, /baseFavicon/, 'clearing the badge must restore the page\'s own mark, not leave the last count on it');
  assert.match(set, /removeAttribute\('href'\)/, 'and with no mark to restore it must still unbadge rather than keep the count');
  // Nothing about this may add an external reference to the emitted page.
  const html = renderBoardPage(createBoard({ title: 'Fav', blocks: [{ kind: 'markdown', text: '# A' }] }));
  assert.ok(!/<link[^>]+href=["']?http/.test(html));
});

check('every page carries the same inline mark, and unbadging has something to restore', () => {
  // One icon, three pages, no asset file: the board (and so the `file:` archive
  // written from it), the index, and the refusal page a wrong browser reaches.
  assert.ok(faviconLink.startsWith('<link rel="icon" href="data:image/svg+xml,'),
    `the mark must be inline, not a file beside the page: ${faviconLink.slice(0, 60)}`);
  assert.ok(!faviconLink.includes('#'),
    'an unescaped # truncates a data URI at the first colour -- the href must be percent-encoded');
  const svg = decodeURIComponent(faviconLink.slice(faviconLink.indexOf(',') + 1, -2));
  assert.ok(svg.includes(palettes.dark['--accent']) && svg.includes(palettes.dark['--accent-ink']),
    'the mark paints the palette, not a hand-copied hex that a palette edit would leave behind');

  const board = renderBoardPage(createBoard({ title: 'Fav', blocks: [{ kind: 'markdown', text: '# A' }] }));
  assert.ok(board.includes(faviconLink), 'the board page must carry the mark');
  assert.ok(renderIndexPage({ threads: [] }).includes(faviconLink), 'the index must carry the mark');
  assert.ok(renderRefusalPage().includes(faviconLink), 'the refusal page must carry the mark');
});

check('the notification fires only when the tab is unfocused, degrades silently, and never steals focus', () => {
  const notify = namedFunctionBody(ui, 'notifyRound');
  assert.ok(notify, 'expected notifyRound in src/ui.mjs');
  assert.match(notify, /typeof Notification === 'undefined'/, 'must degrade silently where Notification does not exist');
  assert.match(notify, /document\.hidden/, 'a visible, focused tab already shows the round -- no notification');
  assert.match(notify, /hasFocus/);
  assert.match(notify, /if \(!unfocused\) return;/);
  assert.match(notify, /Notification\.permission === 'denied'/, 'a denied permission must never be re-prompted');
  assert.match(notify, /requestPermission\(\)/, 'permission is requested lazily, on the first round that would notify');
  assert.match(notify, /if \(readonly\) return;/, 'the standalone file:// archive must never ask for notification permission');
  // The tag carries the round number: round 3 must not silently replace round
  // 2's entry in Notification Center. Only a genuine re-delivery of the SAME
  // round (same n) should collapse into one.
  assert.match(notify, /tag: 'claude-board-' \+ boardId \+ '-' \+ n/, 'the notification tag must be unique per round, not per board');
  // A click on the notification brings the tab forward, lands on the round that
  // needs an answer, and dismisses itself -- the one deliberate exception to
  // "never steal focus" (see below). The order is asserted, not just the three
  // calls: scrolling a window that has not been brought forward yet is what the
  // reviewer would experience as the jump silently not happening.
  assert.match(notify, /\.onclick\s*=\s*function\s*\(\)\s*\{\s*window\.focus\(\);\s*jumpToOpenRound\(\);\s*\S*\.close\(\);?\s*\}/, 'a click on the notification must focus the tab, jump to the open round, then dismiss itself -- in that order');
  // The focus steal is exactly what this replaces: nothing in the client script
  // may pull the window forward UNBIDDEN. "Never" means never unbidden, not
  // never at all -- a click on the notification IS the reviewer asking, which
  // is why the assertion below allows exactly one occurrence, and only inside
  // the click handler just asserted above.
  const focusCalls = ui.match(/window\.focus\(/g) || [];
  assert.equal(focusCalls.length, 1, 'window.focus( must appear exactly once in the whole file -- inside the notification click handler and nowhere else');
  assert.match(notify, /window\.focus\(\)/, 'the sole window.focus( call in the file must live inside notifyRound (the click handler built above)');
});

check('coming back to the tab clears the marks', () => {
  const clear = namedFunctionBody(ui, 'clearPendingMark');
  assert.ok(clear, 'expected clearPendingMark in src/ui.mjs');
  assert.match(clear, /setTitleBadge\(0\)/);
  assert.match(clear, /setFaviconBadge\(0\)/);
  assert.ok(/visibilitychange/.test(ui), 'the marks must clear when the document becomes visible again');
  assert.ok(/addEventListener\('focus'/.test(ui), 'and when the window regains focus');
  // A landed submit clears them too: nothing is pending once the round went out.
  assert.match(namedFunctionBody(ui, 'submitBoard'), /clearPendingMark\(\)/);
});

// --- dead/mismatched CSS --------------------------------------------------------

check('the inline anchor-button class the markup emits is the one the stylesheet rules on', () => {
  const board = createBoard({ title: 'Anchors', blocks: [{ kind: 'markdown', text: '# Heading\n\n- one' }] });
  const markup = renderedMarkup(renderBoardPage(board));
  const m = markup.match(/class="comment-btn ([a-z-]+)"/);
  assert.ok(m, 'expected the markdown block to emit an inline anchor button');
  const cls = m[1];
  assert.ok(
    styles.includes('.' + cls),
    `src/styles.mjs has no rule for ".${cls}", the class src/render.mjs actually emits -- inline anchor buttons fall back to base styling`
  );
  assert.ok(!/\.comment-inline\b/.test(styles), 'the orphaned .comment-inline rule must be gone, not left beside its replacement');
});

check('.anchor-target is wired: a comment list entry names the anchor it points at, and the client applies the class', () => {
  const board = createBoard({ title: 'Target', blocks: [{ kind: 'markdown', text: '# Acceptance Criteria\n\n- one' }] });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send',
    answers: [],
    comments: [{ blockId, anchor: { kind: 'md', ref: 'acceptance-criteria', label: 'Acceptance Criteria' }, text: 'this one' }],
  }, 1);
  const markup = renderedMarkup(renderBoardPage(board));
  assert.match(markup, /class="comment-item" data-anchor-kind="md" data-anchor-ref="acceptance-criteria"/,
    'a comment list entry must carry the anchor it targets, so clicking it can highlight that anchor');
  // ...and the client actually applies the class the stylesheet rules on, rather
  // than the rule staying orphaned as it was.
  const highlight = namedFunctionBody(ui, 'highlightAnchor');
  assert.ok(highlight, 'expected highlightAnchor in src/ui.mjs');
  assert.match(highlight, /classList\.add\('anchor-target'\)/);
  assert.match(highlight, /classList\.remove\('anchor-target'\)/, 'exactly one anchor may be highlighted at a time');
  assert.ok(styles.includes('.anchor-target'), 'the rule the client applies must still exist');
});

// --- computeBoardPatch sees NESTED blocks ---------------------------------------
//
// board.blocks is the top level only, but a question inside a compare side or
// inside another question's `context` is rendered with its own data-block-id and
// its own widget -- and Send iterates the DOM, where it very much exists. While
// the diff walked only the top level, an amend that rewrote such a question
// reported only its CONTAINER's id, clearFieldState never cleared the nested
// question, and the reviewer's selection against the OLD prompt was posted under
// the new one. The scenario below is that exact one, with the prompts chosen so
// the consequence is unmistakable.

check('computeBoardPatch reports a question nested inside a compare block when its prompt is rewritten', () => {
  const nested = (prompt) => ({
    id: 'x1', round: 1, kind: 'compare',
    left: { label: 'L', block: { id: 'q1', round: 1, kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }] } },
    right: { label: 'R', block: { id: 'd1', round: 1, kind: 'markdown', text: 'same', html: '<p>same</p>', anchors: [] } },
  });
  const prev = { blocks: [nested('Approve the copy change?')], rounds: [{ n: 1, status: 'open' }] };
  const next = { blocks: [nested('Delete the production database?')], rounds: [{ n: 1, status: 'open' }] };
  const patch = computeBoardPatch(prev, next);
  assert.ok(
    patch.changedBlockIds.includes('q1'),
    'the nested question whose prompt was rewritten must be reported, or the reviewer\'s stale answer rides under the new prompt'
  );
  assert.ok(!patch.changedBlockIds.includes('d1'), 'the untouched sibling must not be reported');
  assert.ok(
    !patch.changedBlockIds.includes('x1'),
    'the container itself did not change -- reporting it would clear field state for blocks that are still current'
  );
});

check('computeBoardPatch reports a question context block, and a brand-new nested block, by their own ids', () => {
  const q = (contextText) => ({
    id: 'q1', round: 1, kind: 'question', prompt: 'Pick', widget: 'single', options: [{ label: 'A' }],
    context: [{ id: 'c1', round: 1, kind: 'code', text: contextText, sha: contextText, lang: 'js' }],
  });
  const prev = { blocks: [q('const a = 1;')], rounds: [] };
  const next = { blocks: [q('const a = 2;')], rounds: [] };
  assert.deepEqual(computeBoardPatch(prev, next).changedBlockIds, ['c1']);

  const withExtra = { blocks: [{ ...q('const a = 1;'), context: [{ id: 'c1', round: 1, kind: 'code', text: 'const a = 1;', sha: 'const a = 1;', lang: 'js' }, { id: 'c2', round: 1, kind: 'markdown', text: 'new', html: '<p>new</p>', anchors: [] }] }], rounds: [] };
  const added = computeBoardPatch(prev, withExtra);
  assert.deepEqual(added.addedBlockIds, ['c2'], 'a nested block that did not exist before is an addition, under its own id');
  assert.deepEqual(added.changedBlockIds, []);
});

check('the nested walk survives the .toString() splice into the client script', () => {
  // The browser copy is computeBoardPatch.toString() -- a MODULE-LEVEL helper
  // would import fine for these checks and be a ReferenceError in the page.
  const src = computeBoardPatch.toString();
  const spliced = new Function('return (' + src + ')')();
  const prev = { blocks: [{ id: 'x1', round: 1, kind: 'compare', left: { label: 'L', block: { id: 'q1', round: 1, kind: 'question', prompt: 'old' } }, right: { label: 'R', block: null } }], rounds: [] };
  const next = { blocks: [{ id: 'x1', round: 1, kind: 'compare', left: { label: 'L', block: { id: 'q1', round: 1, kind: 'question', prompt: 'new' } }, right: { label: 'R', block: null } }], rounds: [] };
  assert.deepEqual(spliced(prev, next).changedBlockIds, ['q1']);
  assert.ok(ui.includes('flattenBlocks'), 'the flattening must travel with the function into src/ui.mjs');
});

check('a submitted push clears field state for every block in the replaced subtree, nested ones included', () => {
  const body = namedFunctionBody(ui, 'applySubmittedPush');
  assert.match(body, /qsa\('\.block', section\)/, 'the ids must be harvested from the DOM subtree, where nested blocks exist');
  assert.match(body, /clearFieldState\(roundBlockIds\.concat\(replacedIds\)\)/,
    'board.blocks alone is the top level only -- a nested question would keep its stale state');
});

// --- a sent round can never be re-submitted --------------------------------------
//
// #send-btn lives in .send-bar, OUTSIDE any round section, so markRoundHistory
// (which disables everything inside the round it collapses) never reaches it and
// no CSS hides it. With the old unconditional re-enable in .finally(), a plain
// double-click posted twice: the second landed on an already-sent round, and its
// comments were appended again with fresh numbers -- duplicate pins for one
// comment.

check('a landed submit leaves the send bar disabled; only a failure re-enables it', () => {
  const body = namedFunctionBody(ui, 'submitBoard');
  assert.ok(!/\.finally\(/.test(body), 'the unconditional re-enable in .finally() is exactly the double-submit hole');
  const successArm = body.slice(body.indexOf('}).then(function (result)'), body.indexOf('}).catch('));
  assert.ok(successArm.length > 0, 'expected a success arm in submitBoard');
  assert.ok(!/setSendBarEnabled\(true\)/.test(successArm), 'a submit that landed must NOT re-enable the send bar');
  const failureArm = body.slice(body.indexOf('}).catch('));
  assert.match(failureArm, /setSendBarEnabled\(true\)/, 'a failed submit must let the reviewer retry');
});

check('the submitted push disables the send bar, and a new round brings it back', () => {
  const submitted = namedFunctionBody(ui, 'applySubmittedPush');
  const roundPush = namedFunctionBody(ui, 'applyRoundPush');
  assert.match(submitted, /setSendBarEnabled\(openRoundNumber\(\) !== null\)/,
    'a submitted push must lock the send bar -- markRoundHistory cannot reach it, it is outside the round');
  assert.match(roundPush, /setSendBarEnabled\(openRoundNumber\(\) !== null\)/,
    'a new round must bring the send bar back');
  const open = namedFunctionBody(ui, 'openRoundNumber');
  assert.match(open, /r\.status !== 'sent'/, 'the open round is the one not yet sent');
  // Never re-enable anything in a read-only page, where everything is hard-disabled.
  assert.match(namedFunctionBody(ui, 'setSendBarEnabled'), /if \(readonly\) return;/);
});

check('the submit body names the round it targets, and a 409 reads as already-sent rather than an error', () => {
  const body = namedFunctionBody(ui, 'submitBoard');
  assert.match(body, /round: openRoundNumber\(\)/,
    'the server can only refuse a stale submit if the body says which round it is for');
  assert.match(body, /r\.status === 409/, 'a 409 means the round already went out');
  assert.match(body, /alreadySent: true/);
  assert.ok(
    body.indexOf('r.status === 409') < body.indexOf("throw new Error('submit failed"),
    'the 409 branch must come before the generic failure throw, or it renders as a red error the reviewer clears by clicking Send again'
  );
});

// --- resync on (re)connect -------------------------------------------------------
//
// EventSource reconnects, but the stream has no replay and the server emits no
// `id:` lines -- so anything broadcast while this client was disconnected was lost
// permanently. Concretely: the reviewer reopens the board from the index while the
// agent amends the open round; the page never learns of the added question, they
// send what they see, and that question returns `unanswered` to the agent that
// just added it.

check('the subscription resyncs on every open, through the same computeBoardPatch a live push uses', () => {
  assert.match(ui, /es\.addEventListener\('open', function \(\) \{ resync\(\); \}\)/,
    "'open' fires on the first connect AND every reconnect -- exactly the moments something may have been missed");
  const resyncBody = namedFunctionBody(ui, 'resync');
  assert.match(resyncBody, /fetch\('\/b\/' \+ encodeURIComponent\(boardId\)\)/, 'resync must re-read the current board');
  // Tag/type-qualified, not a bare getElementById -- audit 2026-07-31,
  // finding P1: this document is parsed straight from response bytes, so a
  // '## Board data' heading could satisfy a bare id lookup here exactly like
  // it could at hydrate time (see the top of `ui` itself, and
  // test/check-archive-ids.mjs, which drives this end to end).
  assert.match(resyncBody, /querySelector\('script#board-data\[type="application\/json"\]'\)/, 'the board JSON comes from the page\'s own embedded payload, found by a selector no heading can satisfy');
  assert.match(resyncBody, /\.catch\(/, 'a failed catch-up must never break the live subscription');

  const apply = namedFunctionBody(ui, 'applyResync');
  assert.match(apply, /computeBoardPatch\(board, fresh\)/, 'the catch-up must diff, not blindly re-render');
  assert.match(apply, /if \(!patch\.addedBlockIds\.length && !patch\.changedBlockIds\.length && !patch\.roundsNowSent\.length\) return;/,
    'a first connection with nothing missed must do nothing at all -- no DOM churn, no badge');
  assert.match(apply, /mode: 'new-round'/, 'a round missed entirely is replayed as the new-round push it was');
  assert.match(apply, /mode: 'amend'/, 'an amend missed on an existing round is replayed as an amend');
  assert.match(apply, /applyRoundPush\(/, 'one code path for arrived-live and arrived-late');
  // ...and the round-status-only case, which inserts nothing.
  assert.match(apply, /patch\.roundsNowSent\.forEach\(markRoundHistory\)/);
});

// --- the "commenting on:" line is rendered on every block, so it must be hidden ---

check('.comment-target is emitted for every block and has a rule that keeps it hidden until a comment is being composed', () => {
  const board = createBoard({
    title: 'Six blocks',
    blocks: [1, 2, 3, 4, 5, 6].map(i => ({ kind: 'markdown', text: `# H${i}` })),
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const emitted = [...markup.matchAll(/class="comment-target"/g)];
  assert.equal(emitted.length, 6, 'render.mjs emits one per block, unconditionally');
  assert.ok(
    /\.comment-target \{[^}]*display: none/.test(styles),
    'without a rule, six blocks render six stray lines each claiming a comment is in progress'
  );
  assert.ok(styles.includes('.comment-target.open'), 'and a rule that shows it while a comment IS being composed');
  // The client opens and closes it alongside the form it labels.
  const open = namedFunctionBody(ui, 'openCommentForm');
  assert.match(open, /target\.classList\.add\('open'\)/);
  const queueListener = listenerBodies(ui).find(b => /pendingComments\.push/.test(b));
  assert.match(queueListener, /classList\.remove\('open'\)/, 'and closes it again once the comment is queued');
});

// --- defer survives a re-render ---------------------------------------------------

check('the defer button re-applies the live deferred flag on every wire, like every other widget', () => {
  // wireRoot runs again on a pushed/amended subtree. single/multi/note all
  // re-apply their state to the fresh element; defer did not, so an amend showed
  // an UNdeferred button while Send still reported the question deferred.
  // Everything BEFORE the click listener is registered -- the click handler
  // carries its own toggle, so slicing the whole loop would let that copy satisfy
  // the assertion and prove nothing about what happens at wire time.
  const deferLoop = ui.slice(ui.indexOf("qsa('.btn-defer', root)"));
  const beforeListener = deferLoop.slice(0, deferLoop.indexOf('addEventListener'));
  assert.match(beforeListener, /btn\.classList\.toggle\('active', !!deferred\[qid\]\)/,
    'the freshly-rendered defer button must show the state the client actually holds, at wire time');
});

// --- no more mirror drift between the markup and the stylesheet -------------------

/** Strip line and block comments from JS source, respecting
 * string/template-literal and regex-literal boundaries -- audit finding M5:
 * the orphan-class check below used to substring-search the RAW emitter
 * source, comments included, so `.mode-toggle-icon` (named only in a doc
 * comment above `themeToggle()`, src/theme.mjs) satisfied it even after
 * being dropped from the real markup that comment describes (src/theme.mjs's
 * own `class="mode-toggle mode-toggle-icon"` string). A naive line-by-line
 * comment strip is unsafe here for two reasons this codebase actually
 * exercises: these five files ARE the client-script template literals (`ui`,
 * `stageAgentScript()`, `themeBootScript`) -- real code, not comments, that a
 * template-literal-blind stripper would otherwise be free to mutilate if it
 * misread a comment-shaped sequence inside one -- and at least one of them
 * (src/markdown.mjs, the bold/italic markdown replace pair) contains a regex
 * literal whose own body, read blind to regex syntax, contains a run of
 * escaped asterisks immediately followed by its closing slash -- exactly the
 * two-character sequence that ends a block comment, so a scanner that cannot
 * tell a regex literal from ordinary code would treat the regex's own middle
 * as a comment closer and mis-scan everything after it. This is a small,
 * single-pass character scanner (not a real JS parser) that tracks
 * string/template-literal boundaries and uses the standard "does the
 * previous significant token complete a value" heuristic to tell a regex
 * literal's opening slash apart from division, so both hazards above are
 * skipped over intact rather than corrupted. */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = ''; // last emitted non-whitespace char, for regex-vs-division
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      const end = src.indexOf('*/', i);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      lastSignificant = quote;
      i = j;
      continue;
    }
    // A regex literal, but only where the previous significant token means a
    // value has NOT just ended here (real division always follows one) --
    // the standard regex-vs-division disambiguation.
    if (c === '/' && !/[\w$\])]/.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        else if (src[j] === '[') { inClass = true; j++; }
        else if (src[j] === ']') { inClass = false; j++; }
        else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
        else if (src[j] === '\n') break; // not actually a regex after all
        else j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) j++; // trailing flags (g, i, ...)
        out += src.slice(i, j);
        lastSignificant = 'x'; // a regex literal is a value, like an identifier
        i = j;
        continue;
      }
      // fall through: not actually a regex -- treat '/' as an ordinary char
    }
    if (!/\s/.test(c)) lastSignificant = c;
    out += c;
    i++;
  }
  return out;
}

check('every class the stylesheet rules on is a class something actually emits', () => {
  const emitters = ['src/render.mjs', 'src/ui.mjs', 'src/indexpage.mjs', 'src/markdown.mjs', 'src/theme.mjs']
    .map(f => stripJsComments(readFileSync(path.join(repoRoot, f), 'utf8'))).join('\n');
  const ruled = new Set();
  for (const m of styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)) ruled.add(m[1]);
  const orphans = [...ruled].filter(c => !emitters.includes(c));
  assert.deepEqual(orphans, [], `src/styles.mjs rules on classes nothing emits: ${orphans.join(', ')}`);
});

// --- indexpage.mjs: the thread index's own render path (ticket 06) ----------------
// buildThreadIndex, renderIndexPage, folderName, roundCount and threadRow (the last
// not exported -- exercised only through renderIndexPage's output, same as every
// other unexported render helper in this file) were imported by no test at all: the
// audit's T1. `folderName` and `roundCount` gained an `export` here for exactly this
// -- neither needed one to do its job inside indexpage.mjs, only to be reached from
// outside it.

function extractThreadItem(html, boardId) {
  // The href tolerates a trailing fragment: a live row links to
  // `/b/<id>#open-round` so the board opens at the round still owed an answer
  // (its own check below), and every check here is about the row's CONTENT, not
  // about which of the two href shapes it happens to carry.
  const re = new RegExp(`<a class="thread-item[^"]*" href="/b/${boardId}(?:#[^"]*)?"[\\s\\S]*?</a>`);
  const m = html.match(re);
  if (!m) throw new Error(`no thread-item found for board ${boardId}`);
  return m[0];
}

/** What a person actually sees, not what the markup happens to contain: strips
 * every tag and attribute (href, data-thread-id, data-pending, the machine
 * `datetime` value, ...) and collapses whitespace, leaving only rendered text.
 * A "distinct rows" check comparing raw item HTML instead of this is worthless
 * -- href and data-thread-id differ by board id on every row regardless of
 * anything visible, so raw-string comparison passes even when a reviewer would
 * see three identical rows. This is exactly the shape of check an audit finding
 * called out: distinctness has to be asserted on what renders, not on markup a
 * reviewer never looks at. */
function visibleText(item) {
  return item.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Tolerates the leading live-dot span every fresh board carries (round 1 is always
// `status: 'open'`), so a check that only cares about the headline text is not
// coupled to liveness, which none of these checks are about.
function headlineRe(text) {
  return new RegExp(`<div class="thread-title"[^>]*>(?:<span class="live-dot"[^>]*></span> )?${text}</div>`);
}

check('folderName: the last path segment only, and null for no cwd', () => {
  assert.equal(folderName('/Users/jerry/Documents/claude-board/sub/dir'), 'dir');
  assert.equal(folderName(null), null);
  assert.equal(folderName(''), null);
});

check('roundCount: a board doc\'s own rounds-array length, zero for a shape that has none', () => {
  const board = createBoard({ title: 'x', cwd: fixturesDir });
  assert.equal(roundCount(board), 1);
  addRound(board, {});
  assert.equal(roundCount(board), 2);
  assert.equal(roundCount({}), 0, 'must read as zero, not throw, on a board-shaped object with no rounds at all');
});

check('the pending badge counts only what the reviewer still owes: deferred and never-submitted, NOT unanswered', () => {
  // Regression, from real use: a fully-submitted 4-round board showed "5 pending"
  // — 3 `unanswered` plus 2 `deferred`. `unanswered` is an explicit signal the
  // reviewer sent (PROTOCOL.md: status is the only thing that says whether a
  // question was decided), so counting it left a badge nothing could clear:
  // leaving an optional "anything else?" blank IS answering it.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'pending');
  mkdirSync(dir, { recursive: true });
  const board = createBoard({
    title: 'four states',
    cwd: dir,
    blocks: [
      { kind: 'question', prompt: 'decided', widget: 'text' },
      { kind: 'question', prompt: 'left blank on purpose', widget: 'text' },
      { kind: 'question', prompt: 'revisit later', widget: 'text' },
      { kind: 'question', prompt: 'never submitted at all', widget: 'text' },
    ],
  });
  const ids = board.blocks.filter(b => b.kind === 'question').map(b => b.id);
  board.answers = {
    [ids[0]]: { status: 'answered', choice: 'yes', note: '' },
    [ids[1]]: { status: 'unanswered', choice: null, note: '' },
    // ids[2] deferred WITH a populated choice: the shape PROTOCOL.md pins as
    // legal, so the count must key on status and not on choice being non-null.
    [ids[2]]: { status: 'deferred', choice: 'leaning this way', note: '' },
    // ids[3] deliberately absent.
  };

  const [thread] = buildThreadIndex([board]);
  assert.equal(thread.pending, 2, 'exactly the deferred one and the missing one');

  const item = extractThreadItem(renderIndexPage({ threads: [thread] }), board.id);
  assert.match(item, /2 pending/, 'and the badge a reviewer actually reads says 2');
  assert.doesNotMatch(item, /4 pending/, 'never the raw question count');
});

check('a board whose every question is answered or explicitly left blank reads as zero pending', () => {
  // The state the reviewer must be able to reach. Before the fix above, a board
  // carrying one blank optional question could never show a clear badge.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'pending-zero');
  mkdirSync(dir, { recursive: true });
  const board = createBoard({
    title: 'done',
    cwd: dir,
    blocks: [
      { kind: 'question', prompt: 'the real question', widget: 'text' },
      { kind: 'question', prompt: 'anything else?', widget: 'text' },
    ],
  });
  const ids = board.blocks.filter(b => b.kind === 'question').map(b => b.id);
  board.answers = {
    [ids[0]]: { status: 'answered', choice: 'yes', note: '' },
    [ids[1]]: { status: 'unanswered', choice: null, note: '' },
  };
  const [thread] = buildThreadIndex([board]);
  assert.equal(thread.pending, 0, 'a submitted board with nothing outstanding must be able to read zero');
});

check('an index row headlines the board title; the project is shown as a folder basename only, full path on a title attribute', () => {
  const sub = path.join(fixturesDir, 'indexpage-fixtures', 'sub', 'dir');
  mkdirSync(sub, { recursive: true });
  const board = createBoard({ title: 'Ship the new lens', cwd: sub });
  const threads = buildThreadIndex([board]);
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, board.id);
  assert.match(item, headlineRe('Ship the new lens'), 'the headline is the title');
  assert.doesNotMatch(item, /thread-title[^>]*>[^<]*\/[^<]*</, 'the headline element must not carry the full path');
  const pathRe = new RegExp(`<div class="thread-path" title="${board.cwd.replace(/\//g, '\\/')}">dir</div>`);
  assert.match(item, pathRe, 'the path line shows the folder basename as text, full cwd only on title');
});

check('a board with no title falls back to the folder name as the headline, and the path line does not then duplicate it', () => {
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'widgets');
  mkdirSync(dir, { recursive: true });
  const board = createBoard({ title: '', cwd: dir });
  const threads = buildThreadIndex([board]);
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, board.id);
  assert.match(item, headlineRe('widgets'), 'headline falls back to the folder basename');
  assert.doesNotMatch(item, /<div class="thread-path"/, 'no second line repeating what the headline already says');
});

check('a board with neither a title nor a cwd still produces exactly one headline', () => {
  const board = createBoard({ title: '', cwd: null });
  const threads = buildThreadIndex([board]);
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, board.id);
  const headlineCount = (item.match(/<div class="thread-title"/g) || []).length;
  assert.equal(headlineCount, 1, 'exactly one headline element, never zero or two');
  assert.match(item, headlineRe('\\(untitled\\)'), 'falls back to a plain label, not the literal word "untitled" read as if it were a real title, and not an empty headline');
});

check('three threads sharing one cwd render as three visibly distinct rows, told apart by title', () => {
  // DESIGN.md's Decisions section calls this out by name: keying by project
  // directory instead of by thread would collapse these into one row.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'shared');
  mkdirSync(dir, { recursive: true });
  const titles = ['Pick a database', 'Pick a queue', 'Pick a cache'];
  const boards = titles.map(title => createBoard({ title, cwd: dir }));
  const threads = buildThreadIndex(boards);
  assert.equal(threads.length, 3, 'three distinct threads, not collapsed by the shared cwd');
  const html = renderIndexPage({ threads });
  const items = boards.map(b => extractThreadItem(html, b.id));
  // On VISIBLE text, not raw markup: href and data-thread-id differ by board id
  // on every row regardless of anything a reviewer can see, so comparing raw
  // item strings would pass even for three rows that read identically.
  assert.equal(new Set(items.map(visibleText)).size, 3, 'each row must actually read differently to a reviewer, not just differ in markup nobody sees');
  titles.forEach((title, i) => assert.match(items[i], headlineRe(title), `row ${i} headlines its own title`));
});

check('three TITLE-LESS threads sharing one cwd still render as three distinct rows -- title alone cannot tell them apart here', () => {
  // The titled check above is satisfied even if the row's only discriminator
  // were the title itself. An audit finding was a regression here specifically
  // for title-less boards, where the headline (folder name) AND the path line
  // (suppressed once the folder IS the headline) collide identically across all
  // three, leaving nothing visible to vary except whatever else the row carries.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'shared-untitled');
  mkdirSync(dir, { recursive: true });
  const boards = [0, 1, 2].map(() => createBoard({ title: '', cwd: dir }));
  const threads = buildThreadIndex(boards);
  assert.equal(threads.length, 3, 'three distinct threads, not collapsed by the shared cwd');
  const html = renderIndexPage({ threads });
  const items = boards.map(b => extractThreadItem(html, b.id));
  items.forEach(item => assert.match(item, headlineRe('shared-untitled'), 'headline collides on the folder name, as expected'));
  items.forEach(item => assert.doesNotMatch(item, /<div class="thread-path"/, 'and the path line is suppressed, as expected -- neither is left to distinguish them'));
  const texts = items.map(visibleText);
  assert.equal(new Set(texts).size, 3, 'still three rows that actually READ differently, despite the headline collision -- not just three different href/data-thread-id attributes');
  boards.forEach((b, i) => assert.ok(texts[i].includes(b.thread), `row ${i}'s VISIBLE text must identify its own thread even when headline and path do not`));
});

check('.thread-meta carries the thread id unconditionally, not just when a collision makes it necessary', () => {
  const board = createBoard({ title: 'Has a title, has a cwd', cwd: fixturesDir });
  const threads = buildThreadIndex([board]);
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, board.id);
  assert.ok(visibleText(item).includes(board.thread), 'the thread id must be visible text on every row, unconditionally -- not only in an attribute nobody reads');
});

check('buildThreadIndex uses the PRIMARY board\'s own round count for a multi-doc thread, never a cross-board sum', () => {
  // A thread's row links to primary.id, one specific board doc -- so its round
  // count has to describe THAT board, or it contradicts the page the row opens.
  // A prior version summed roundCount across the whole group, which could show a
  // round number that exists on neither board behind the thread.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'multiboard');
  mkdirSync(dir, { recursive: true });
  const b1 = createBoard({ title: 'first doc', cwd: dir, thread: 'th_indexpage_shared' });
  addRound(b1, {});
  addRound(b1, {}); // b1: 3 rounds
  const b2 = createBoard({ title: 'second doc', cwd: dir, thread: 'th_indexpage_shared' });
  addRound(b2, {}); // b2: 2 rounds
  const threads = buildThreadIndex([b1, b2]);
  assert.equal(threads.length, 1, 'one thread, even with two board docs behind it');
  assert.equal(threads[0].boardCount, 2);
  const primary = threads[0].boardId === b1.id ? b1 : b2;
  assert.equal(threads[0].rounds, roundCount(primary), 'the row must describe the board it actually links to, not the group');
  assert.notEqual(threads[0].rounds, roundCount(b1) + roundCount(b2), 'must not be the cross-board sum -- 5 is a round count that exists on neither board');
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, threads[0].boardId);
  const n = roundCount(primary);
  assert.match(item, new RegExp('\\b' + n + ' round' + (n === 1 ? '' : 's') + '\\b'), 'worded as a count ("N rounds"), matching the linked board');
});

check('the round segment reads as a count, not an ordinal, is pluralized correctly, and is suppressed entirely at zero', () => {
  // "round N" reads as a POSITION (which round you're on) -- src/badge.mjs's own
  // doc comment names exactly this confusion as a real bug, not a wording
  // nitpick, for the board page's own badge. The index row is a total, never a
  // position, and must not be worded as if it were one.
  const oneRound = createBoard({ title: 'one round', cwd: fixturesDir });
  const twoRounds = createBoard({ title: 'two rounds', cwd: fixturesDir });
  addRound(twoRounds, {});
  const noRounds = createBoard({ title: 'no rounds', cwd: fixturesDir });
  noRounds.rounds = [];
  const threads = buildThreadIndex([oneRound, twoRounds, noRounds]);
  const html = renderIndexPage({ threads });
  const oneItem = extractThreadItem(html, oneRound.id);
  const twoItem = extractThreadItem(html, twoRounds.id);
  const zeroItem = extractThreadItem(html, noRounds.id);
  assert.match(oneItem, /\b1 round\b/, 'singular for exactly one round');
  assert.doesNotMatch(oneItem, /1 rounds\b/, 'never "1 rounds"');
  assert.match(twoItem, /\b2 rounds\b/, 'plural for more than one');
  assert.doesNotMatch(html, /\bround \d/i, 'never worded as an ordinal ("round N") anywhere on the page');
  assert.doesNotMatch(zeroItem, /\b0 rounds?\b/, 'the segment is suppressed, not shown as "0 rounds", for a board with no rounds at all');
});

check('the row\'s time element carries both a machine-readable datetime and the exact formatted value for hover', () => {
  const board = createBoard({ title: 'Time check', cwd: fixturesDir });
  const threads = buildThreadIndex([board]);
  const html = renderIndexPage({ threads });
  const item = extractThreadItem(html, board.id);
  const m = item.match(/<time class="rel-time" datetime="([^"]*)" title="([^"]*)">([^<]*)<\/time>/);
  assert.ok(m, 'the row must render a .rel-time element carrying both datetime and title');
  assert.equal(m[1], board.updatedAt, 'datetime carries the raw ISO value the client script parses');
  assert.equal(m[3], m[2], 'the visible text and the hover title must be the exact same formatted value');
  assert.notEqual(m[2], board.updatedAt, 'the hover value is the human-formatted date, not the raw ISO string verbatim');
  assert.match(m[2], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/, 'formatted as "YYYY-MM-DD HH:MM:SSZ"');
});

check('a live row opens the board AT the round still owed an answer; a settled row does not', () => {
  // Reported from real use: clicking a thread several rounds deep landed the
  // reviewer at round 1 -- history they had already sent -- and made them scroll
  // past all of it to reach the question actually waiting for them.
  const live = createBoard({ title: 'three rounds, last one open', cwd: fixturesDir });
  applySubmit(live, { action: 'send', answers: [], comments: [] }, 1);
  addRound(live, {});
  applySubmit(live, { action: 'send', answers: [], comments: [] }, 2);
  addRound(live, {}); // round 3 open
  const settled = createBoard({ title: 'everything sent', cwd: fixturesDir });
  applySubmit(settled, { action: 'send', answers: [], comments: [] }, 1);

  const threads = buildThreadIndex([live, settled]);
  const html = renderIndexPage({ threads });
  assert.match(html, new RegExp(`href="/b/${live.id}#open-round"`), 'the live row must carry the fragment that takes the reviewer to the open round');
  assert.match(html, new RegExp(`href="/b/${settled.id}"`), 'a settled row keeps the bare href -- nothing is open, so there is nowhere to jump to');

  // Not a per-round id (`#round-3`): board content is markdown snapshotted from
  // arbitrary files, and its headings mint ids on the same page (a `## Round 3`
  // heading slugifies to exactly that), so a native fragment jump is hijackable.
  // The sentinel is resolved by src/ui.mjs instead -- and it has to actually be
  // wired there, through the same jumpToOpenRound the round badge uses.
  assert.doesNotMatch(html, /href="\/b\/[^"]*#round-\d/, 'never a per-round element id, which board content can mint for itself');
  assert.match(ui, /location\.hash === '#open-round'/, 'src/ui.mjs must recognise the sentinel the index links to');
  assert.match(ui, /function jumpToOpenRoundAfterPaint\(\)\s*\{[\s\S]{0,200}?jumpToOpenRound\)?\(?\)?/, 'and resolve it through jumpToOpenRound, not through a second definition of where the open round is');
  // Verified in Chrome: run inline at hydrate, the jump is overwritten by the
  // browser's own post-load scroll positioning and the reviewer stays at the top
  // -- which is exactly how this shipped broken the first time. The wiring, not
  // just the intent, has to survive.
  assert.match(ui, /window\.addEventListener\('load', jumpToOpenRoundAfterPaint\)/, 'the jump must be deferred to the load event, not issued inline while the document is still loading');
});

// --- the index page's client script (ticket 06) ------------------------------------
// `node --check` on src/indexpage.mjs only proves the OUTER template literal that
// wraps `indexScript` is well-formed; it says nothing about whether the CLIENT
// script embedded inside it parses, exactly the gap QUIRKS.md's backtick entry
// describes for src/ui.mjs. `new Function(...)` is the only thing that actually
// runs it, same technique every check that exercises `ui` already relies on.

check('renderIndexPage actually places indexScript on the page, inside a live <script type="module">', () => {
  // The check below proves indexScript parses and runs IN ISOLATION -- it does
  // not prove renderIndexPage ever puts it on the page at all. Deleting
  // `<script type="module">${indexScript}</script>` from renderIndexPage leaves
  // every other check in this file green: the relative-time feature could ship
  // entirely disconnected from the page that is supposed to carry it, and
  // nothing would say so. See QUIRKS.md.
  const html = renderIndexPage({ threads: [] });
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'the page must carry a <script type="module"> at all');
  assert.equal(m[1], indexScript, 'and its contents must be indexScript itself, not a stale or partial copy');
});

check('indexScript (the relative-time client script) parses and runs against a minimal document/setInterval stand-in', () => {
  const els = [
    { _datetime: '2020-01-01T00:00:00.000Z', textContent: '2020-01-01 00:00:00Z', getAttribute(n) { return n === 'datetime' ? this._datetime : null; } },
  ];
  const fakeDocument = { querySelectorAll: sel => (sel === '.rel-time' ? els : []) };
  let intervalFn = null;
  let intervalMs = null;
  const fakeSetInterval = (fn, ms) => { intervalFn = fn; intervalMs = ms; return 1; };
  // Throws (a real syntax error, or a thrown reference to something undefined in
  // this stand-in) if indexScript does not actually parse and run end to end.
  new Function('document', 'setInterval', indexScript)(fakeDocument, fakeSetInterval);
  assert.equal(typeof intervalFn, 'function', 'refresh must be wired through setInterval so an open tab keeps relative times fresh');
  assert.notEqual(els[0].textContent, '2020-01-01 00:00:00Z', 'refresh() must actually run once up front and overwrite the placeholder text, not wait for the first interval tick');
  // The narrowest bucket relTime has ("a minute ago", 45s-90s) is 45 seconds
  // wide. A poll slower than that can step clean over the bucket depending on
  // where a row's load time happens to land within it -- an audit-caught defect
  // (60000 used to be the value here). 20000 is a generous margin under 45000,
  // not a literal restatement of whatever indexScript happens to use today.
  assert.ok(intervalMs > 0 && intervalMs <= 20000, `refresh must poll often enough to never skip the narrowest bucket -- got ${intervalMs}ms`);
});

/** Extract `relTime` out of the `indexScript` string by appending a `return`, the
 * same `new Function(src + '; return name;')()` technique extractUiFunction uses
 * on `ui` above (test/check-pure.mjs's own anchor-parity section) — safe here
 * because indexScript declares it as a plain top-level function, not hidden
 * inside an IIFE. `document`/`setInterval` stand-ins are still required: indexScript's
 * own top-level `refresh(); setInterval(refresh, ...);` calls run as a side
 * effect of merely evaluating it, before the appended `return` is ever reached.
 * Throws loudly, not silently, if extraction ever breaks. */
function extractRelTime() {
  const noopDocument = { querySelectorAll: () => [] };
  const noopSetInterval = () => {};
  const fn = new Function('document', 'setInterval', indexScript + '; return relTime;')(noopDocument, noopSetInterval);
  if (typeof fn !== 'function') throw new Error('indexScript extraction did not yield relTime as a function');
  return fn;
}

check('relTime: pinned at the exact boundaries its own if-chain names, with a fixed "now" rather than the wall clock', () => {
  // relTime rounds each unit FIRST and thresholds the ROUNDED value (moment.js's
  // own algorithm) rather than thresholding the raw ms diff and rounding only for
  // display -- the former shape had a real bug an audit caught: a diff that
  // rounds UP to the next tier's boundary still printed in the tier below it for
  // one more tick (44m59s read "45 minutes ago", 45m00s one second later read
  // "an hour ago"). These boundaries are pinned at the value where each unit
  // itself rounds over, not at the round-number-looking-but-wrong spellings
  // (45min/22h/25d) the old, buggy version used.
  const relTime = extractRelTime();
  const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const now = 1_700_000_000_000; // arbitrary fixed instant
  const at = msAgo => new Date(now - msAgo).toISOString();

  // 45s boundary
  assert.equal(relTime(at(45 * SEC - 1), now), 'just now');
  assert.equal(relTime(at(45 * SEC), now), 'a minute ago');
  // 90s boundary (round(diff/MIN) reaches 2 here, not a hardcoded 90*SEC check)
  assert.equal(relTime(at(90 * SEC - 1), now), 'a minute ago');
  assert.equal(relTime(at(90 * SEC), now), '2 minutes ago');
  // minutes->hour: rounds to 45 minutes at 44min30s, not at the old raw 45min
  assert.equal(relTime(at(44 * MIN + 30 * SEC - 1), now), '44 minutes ago');
  assert.equal(relTime(at(44 * MIN + 30 * SEC), now), 'an hour ago');
  // 90min boundary (round(diff/HOUR) reaches 2 here)
  assert.equal(relTime(at(90 * MIN - 1), now), 'an hour ago');
  assert.equal(relTime(at(90 * MIN), now), '2 hours ago');
  // hours->day: rounds to 22 hours at 21h30m, not at the old raw 22h
  assert.equal(relTime(at(21 * HOUR + 30 * MIN - 1), now), '21 hours ago');
  assert.equal(relTime(at(21 * HOUR + 30 * MIN), now), 'a day ago');
  // 36h boundary (round(diff/DAY) reaches 2 here)
  assert.equal(relTime(at(36 * HOUR - 1), now), 'a day ago');
  assert.equal(relTime(at(36 * HOUR), now), '2 days ago');
  // days->month: rounds to 25 days at 24d12h, not at the old raw 25d
  assert.equal(relTime(at(24 * DAY + 12 * HOUR - 1), now), '24 days ago');
  assert.equal(relTime(at(24 * DAY + 12 * HOUR), now), 'a month ago');
  // months->year: never "12 months ago" -- rounds to 12 at 345 days and becomes
  // "a year ago" there instead
  assert.equal(relTime(at(345 * DAY - 1), now), '11 months ago');
  assert.equal(relTime(at(345 * DAY), now), 'a year ago');
  // year->years: rounds to 2 years at 547d12h
  assert.equal(relTime(at(547 * DAY + 12 * HOUR - 1), now), 'a year ago');
  assert.equal(relTime(at(547 * DAY + 12 * HOUR), now), '2 years ago');

  // future/clock-skew timestamps clamp to "just now" rather than reading negative
  assert.equal(relTime(new Date(now + 5000).toISOString(), now), 'just now');
  // an unparseable value is returned verbatim, not "NaN ago" or a thrown error
  assert.equal(relTime('not-a-date', now), 'not-a-date');
  // new Date(null).getTime() is 0, not NaN, so isNaN alone does not catch a null
  // iso -- it used to compute a diff against the Unix epoch and print something
  // like "54 years ago" instead of leaving the caller's null alone.
  assert.equal(relTime(null, now), null, 'a null iso must be returned verbatim, not treated as the epoch');
});

// A palette change has to stay a one-block edit (DESIGN.md acceptance criterion
// 6). This invariant already rotted once -- the header comment above `styles`
// asserted it while 21 rules quietly reached past the token block for a raw
// literal -- so it is enforced here instead of merely claimed in prose.
const RAW_COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|\brgba?\([^)]*\)/;

// A "token block" is any rule -- :root, or :root nested inside a @media query
// (ticket 02's light palette), or any future selector -- whose declarations are
// ALL either a custom property (`--name: value;`) or `color-scheme` (the one
// non-custom-property declaration a palette's :root carries alongside it).
// Blanking every such leaf rule out (character-for-character, so line numbers
// still line up) before scanning is what lets this check not know the token
// block's selector in advance -- it stays correct however many get added, and
// it does not require special-casing ticket 02's second block by name.
//
// The regex below matches leaf declaration blocks only (no braces inside the
// body): run globally left-to-right over CSS that nests a rule inside a
// @media/@keyframes wrapper, a failed match at the wrapper's own `{` makes the
// engine retry at the next character, so the first successful match is always
// the innermost rule -- exactly the block whose declarations this needs to see.
function isTokenBlockBody(body) {
  const decls = body.split(';').map(d => d.trim()).filter(Boolean);
  if (decls.length === 0) return false;
  return decls.every(d => {
    const prop = d.slice(0, d.indexOf(':')).trim();
    return prop.startsWith('--') || prop === 'color-scheme';
  });
}

/** Finds the first raw color literal outside any token block in `css` (comments
 * and token blocks both blanked to whitespace first, character-for-character,
 * so the reported line number still lines up with the source), or null if the
 * rest of the sheet is clean.
 *
 * Module scope rather than closed over one check, because there are now two
 * stylesheets this rule binds: src/styles.mjs's, and the refusal page's inline
 * one. The refusal page is not an exception to the rule -- it is a second
 * stylesheet that has to obey it, for the reason the stage does not (see 'the
 * refusal page follows the theme' below). */
function firstLeakOutsideTokenBlocks(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' '));
  let sawTokenBlock = false;
  const stripped = noComments.replace(/[^{}]+\{[^{}]*\}/g, block => {
    const body = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
    if (!isTokenBlockBody(body)) return block;
    sawTokenBlock = true;
    return block.replace(/[^\n]/g, ' ');
  });
  assert.ok(sawTokenBlock, 'no token block (a rule of only custom properties) found');
  const m = RAW_COLOR.exec(stripped);
  if (!m) return null;
  const line = css.slice(0, m.index).split('\n').length;
  return `'${m[0]}' on line ${line}`;
}

check('no rule outside a token block carries a raw hex or rgba literal', () => {
  const pageLeak = firstLeakOutsideTokenBlocks(styles);
  assert.equal(pageLeak, null, `src/styles.mjs has a raw color literal outside its token blocks: ${pageLeak}`);
});

check('the sandboxed stage stylesheet is exempt from the raw-literal rule, and the exemption is honest', () => {
  // Spec criterion 6's binding amendment: "The sandboxed stage stylesheet
  // (stageAgentScript) is exempt and keeps its literal." A prior version of
  // this exemption let `stageAgentScript()`'s injected CSS satisfy the SAME
  // "token block" shape the check above blanks out (a `:root { --accent:
  // <anything> }` rule), which made the check self-certifying: it would have
  // passed even if the stage's literal were changed to '#ff0000' (2026-07-31
  // audit, finding H5), because "wrapped in a one-declaration :root block" was
  // the only thing it ever checked for.
  //
  // The real reason the stage gets a literal at all (STAGE_ACCENT_HEX's own
  // comment, src/render.mjs, has the full account) is that the srcdoc
  // document it's injected into is sandboxed and never receives the page's
  // tokens -- but a CUSTOM PROPERTY is exactly the mechanism that would reach
  // through that isolation anyway: properties inherit, so agent-authored
  // HTML in that same document could declare its own `--accent` and silently
  // hijack the outline with no specificity contest. So what is actually true
  // and worth guarding here is the ABSENCE of any custom property in the
  // stage stylesheet, not the presence of some hex or other. That is read
  // from STAGE_ACCENT_HEX, a real exported constant, rather than
  // reconstructed by regexing every single-quoted chunk out of the whole
  // client-script string the way this check used to (`stageAgentScript()`
  // is hundreds of lines of client JS, including `.toString()`-embedded
  // functions from src/anchor.mjs) -- an apostrophe inside a `//` comment
  // anywhere in that string offsets which quoted chunks the regex sees, so
  // what it "scanned" was parity luck, not the actual injected CSS.
  assert.ok(/^#[0-9a-fA-F]{6}$/.test(STAGE_ACCENT_HEX),
    `STAGE_ACCENT_HEX (src/render.mjs) must be a plain hex literal -- the one value untrusted content in the stage document cannot override -- not a custom property or anything else it could be hijacked through: ${STAGE_ACCENT_HEX}`);

  const script = stageAgentScript();
  const ensureBody = script.slice(script.indexOf('function ensureHoverStyle'), script.indexOf('function clearHover'));
  assert.ok(ensureBody.length > 0 && !ensureBody.includes('function clearHover'),
    'setup failure: could not isolate ensureHoverStyle from stageAgentScript() to inspect its injected CSS');
  assert.ok(!/--[a-zA-Z-]/.test(ensureBody),
    `the stage stylesheet (ensureHoverStyle, stageAgentScript, src/render.mjs) must declare or reference NO custom property at all -- that is the actual isolation property this exemption relies on, and it is what a sandboxed srcdoc document cannot protect on its own (custom properties inherit from agent-authored ancestors regardless of the iframe boundary): ${ensureBody}`);

  assert.ok(script.includes('outline: 2px solid ' + STAGE_ACCENT_HEX + ' !important'),
    'stageAgentScript() must actually inject STAGE_ACCENT_HEX -- the exported constant this check reads is not proof of what is served if the two drift apart');

  // The hand-maintained half of QUIRKS.md "Two stylesheets, one palette":
  // this literal has no test forcing it to stay in step with --accent short
  // of this one. Also exactly what falsifies the check above as a decoy --
  // changing STAGE_ACCENT_HEX to some other plain hex (e.g. '#ff0000') still
  // declares no custom property and still round-trips through the assertion
  // just above, so only THESE assertions catch a value that drifted from the
  // token it is supposed to track.
  //
  // Three assertions rather than one, because "stays in step with --accent"
  // was the wrong requirement and stated it in a way that read as correct:
  // it tracked the DARK value, on a surface that is white in BOTH palettes,
  // leaving the outline at 2.61:1 -- under the 3:1 WCAG floor for non-text
  // UI, on the stage's only per-element targeting feedback. src/styles.mjs's
  // LIGHT palette comment had already rejected that exact colour on white
  // ("#7c9cff on white is ~2.3:1"); nothing connected the two. So the premise
  // and the requirement are now asserted directly, and the palette pin is
  // kept only as a drift guard on top of them.
  assert.equal(palettes.dark['--stage-bg'], palettes.light['--stage-bg'],
    `the stage's premise is gone: --stage-bg now differs between palettes (dark ${palettes.dark['--stage-bg']}, light ${palettes.light['--stage-bg']}), so the stage is no longer theme-independent and STAGE_ACCENT_HEX (src/render.mjs) can no longer be one value for both -- it needs a light/dark story, which the sandboxed stage stylesheet has no way to express (QUIRKS.md "Two stylesheets, one palette")`);

  // WCAG 2.1 relative luminance, the same formula src/styles.mjs's palette
  // comments quote their ratios from.
  const luminance = (hex) => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const stageBg = palettes.light['--stage-bg'] === '#fff' ? '#ffffff' : palettes.light['--stage-bg'];
  const ratio = contrast(STAGE_ACCENT_HEX, stageBg);
  assert.ok(ratio >= 3,
    `the stage hover outline (STAGE_ACCENT_HEX, src/render.mjs) is ${ratio.toFixed(2)}:1 against the stage's background ${stageBg} -- under the 3:1 WCAG minimum for non-text UI. This outline is the ONLY per-element targeting feedback the stage gives, so a reviewer who cannot see it can be led to anchor a comment to an element they never saw highlighted (the same failure the '--accent: transparent' hijack caused, reached by a palette choice instead)`);

  assert.equal(STAGE_ACCENT_HEX, palettes.light['--accent'],
    `the stage's hand-maintained literal (STAGE_ACCENT_HEX, src/render.mjs) no longer matches --accent's LIGHT value (${palettes.light['--accent']}) -- light, not dark, because the stage renders on white in both palettes, so the light accent is the one chosen to have contrast there (src/styles.mjs's LIGHT palette comment). QUIRKS.md "Two stylesheets, one palette" requires updating it by hand when that token changes`);
});

// --- the handoff, and the credential it hands out ---------------------------------
// Everything about the read gate that does not need a socket lives here; the routes
// themselves are test/check-http.mjs's.

check('a handoff is single-use, and a replay racing the first use loses', () => {
  const store = createHandoffStore({ ttlMs: 10_000 });
  const { token } = store.mint('/b/b_one');
  assert.equal(store.size(), 1);
  assert.deepEqual(store.consume(token)?.target, '/b/b_one');
  assert.equal(store.size(), 0, 'consuming removes it, rather than marking it');
  assert.equal(store.consume(token), null, 'the second caller gets nothing');
  // The delete happens before anything is returned, so a replay arriving between the
  // browser's fetch and the redirect being written still finds an empty map.
  const { token: t2 } = store.mint('/');
  const [first, second] = [store.consume(t2), store.consume(t2)];
  assert.ok(first && !second, 'exactly one of two consumers of the same token wins');
});

check('an expired handoff and a spent one are indistinguishable to the caller', () => {
  let now = 1_000_000;
  const store = createHandoffStore({ ttlMs: 30_000, now: () => now });
  const { token } = store.mint('/b/b_two');
  now += 30_001;
  assert.equal(store.consume(token), null, 'expiry is refused');
  // Same null as a spent token and as a token that never existed. Three distinguishable
  // answers would tell a `ps` poller it found a real token and merely arrived late.
  assert.equal(store.consume('f'.repeat(64)), null);
  assert.equal(store.size(), 0, 'and an expired handoff does not accumulate');
});

check('a handoff expires strictly, not on the boundary', () => {
  let now = 0;
  const store = createHandoffStore({ ttlMs: 1000, now: () => now });
  const a = store.mint('/');
  now = 999;
  assert.ok(store.consume(a.token), 'still live one millisecond before the deadline');
  const b = store.mint('/');
  now = 999 + 1000;
  assert.equal(store.consume(b.token), null, 'dead at exactly the deadline, not one tick after');
});

check('minting prunes expired handoffs, so a hammered route cannot grow the map', () => {
  let now = 0;
  const store = createHandoffStore({ ttlMs: 100, now: () => now });
  for (let i = 0; i < 50; i++) store.mint('/');
  assert.equal(store.size(), 50);
  now = 1000;
  store.mint('/');
  assert.equal(store.size(), 1, 'only the live one survives');
});

check('a handoff target is one of two shapes this daemon chose, never caller text', () => {
  assert.equal(handoffTarget('b_0123456789abcdef'), '/b/b_0123456789abcdef');
  // Anything that is not a board id lands on the index. That is what makes an open
  // redirect impossible by construction rather than by escaping: there is no caller
  // input that reaches the Location header at all.
  for (const hostile of [
    'https://evil.example', '//evil.example', '../../etc/passwd', 'b_x\r\nSet-Cookie: cb_session=x',
    '', null, undefined, 42, {}, 'b_' + 'a'.repeat(200),
  ]) {
    assert.equal(handoffTarget(hostile), '/', `${JSON.stringify(hostile)} must not become a redirect target`);
  }
});

check('the session cookie is derived from the secret, so it survives a daemon restart', () => {
  const a = sessionToken('a'.repeat(64));
  assert.match(a, /^[0-9a-f]{64}$/);
  // Two independent daemons holding the same secret accept the same cookie: that is
  // what makes `launchctl kickstart` invisible to an open browser.
  assert.equal(sessionToken('a'.repeat(64)), a);
  // Rotating the secret invalidates every browser at once. Intended, not a bug.
  assert.notEqual(sessionToken('b'.repeat(64)), a);
  assert.equal(sessionToken(null), null, 'no secret, no cookie: the daemon fails closed');
  assert.equal(sessionToken(''), null);
});

check('the session cookie matcher accepts only the real cookie, and never throws on a missing one', () => {
  const secret = 'c'.repeat(64);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${sessionToken(secret)}`, secret), true);
  assert.equal(sessionCookieMatches(`other=1; ${SESSION_COOKIE}=${sessionToken(secret)}; x=2`, secret), true);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${sessionToken('d'.repeat(64))}`, secret), false);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=short`, secret), false, 'a length mismatch is false, not a timingSafeEqual throw');
  assert.equal(sessionCookieMatches('', secret), false);
  assert.equal(sessionCookieMatches(undefined, secret), false);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${sessionToken(secret)}`, null), false, 'no secret on disk accepts nothing');
});

check('a duplicate session cookie cannot shadow the real one: the FIRST match wins', () => {
  // audit 2026-07-31 S5. Cookies ignore ports, so any other server on this host can set
  // a second cb_session for it. Last-wins meant one such cookie sorting later shadowed
  // the daemon's own and locked the reviewer out of every board -- permanently, because
  // bin/authorize.mjs re-mints at the same (host, path) key and leaves the duplicate in
  // place, so the one command the refusal page names could not clear it.
  // RFC 6265 section 5.4 sends the most specific match first, which is the host-and-path
  // cookie this daemon set. Ablation: restore last-wins in parseCookies and this reds.
  const secret = 'c'.repeat(64);
  const real = sessionToken(secret);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${real}; ${SESSION_COOKIE}=junk`, secret), true, 'a duplicate appended after the real cookie must not shadow it');
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${real}; other=1; ${SESSION_COOKIE}=${'e'.repeat(64)}`, secret), true, 'nor a duplicate that is the right shape but the wrong value');
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${real}`, secret), false, 'and a bare-name cookie sorting first is still honoured as first -- the ordering is the browser\'s statement about specificity, not something to search past');
});

check('the recovery command names a file that exists, absolutely, and survives a path with spaces', () => {
  const cmd = recoveryCommand();
  const script = path.join(repoRoot, 'bin', 'authorize.mjs');
  assert.ok(cmd.includes(script), `the command must name ${script}`);
  assert.ok(path.isAbsolute(script) && existsSync(script), 'and that file must actually be there — a refusal page naming a missing script is worse than no page');
  // The clone lives wherever the user put it, routinely under a path with a space.
  assert.equal(shellQuote('/Users/x/claude-board'), '/Users/x/claude-board', 'an ordinary path is left alone');
  assert.equal(shellQuote('/Users/x/my board'), `'/Users/x/my board'`, 'a space is quoted, so the command can be pasted as-is');
  assert.equal(shellQuote("/Users/x/o'brien"), `'/Users/x/o'\\''brien'`, 'and a quote in the path does not break out of the quoting');
});

check('the refusal page names the recovery command and reveals nothing about the store', () => {
  const html = renderRefusalPage(recoveryCommand());
  assert.ok(html.includes(recoveryCommand()), 'the one command that restores access must be on the page verbatim');
  assert.match(html, /not authorized/i);
  assert.match(html, /<meta http-equiv="Content-Security-Policy"/, 'it renders under the same locked-down policy as a board');
  assert.doesNotMatch(html, /<script/i, 'and needs no script to say what it says');
  // It is served for a missing board and an existing one alike, so it must say nothing
  // about either: a "board not found" here would leak existence to an id enumerator.
  assert.doesNotMatch(html, /board-data|boardId|b_[0-9a-f]/);

  assert.match(html, /@media \(prefers-color-scheme: light\)/,
    'the refusal page must carry a light variant -- it has no stylesheet link and no script, so this media query is the only theme signal it can act on');
  assert.match(html, /color-scheme: light/,
    'and must set color-scheme, or the scrollbar and any form chrome stay dark against a light page');
});

check('the refusal page follows the theme, from the palettes rather than a hand-copy', () => {
  // Two separate failures, one after the other, on the page a reader sees at
  // exactly the moment they hold nothing else. First it shipped dark-only --
  // six hardcoded hex, no light variant, so a light-mode machine got a black
  // slab where every other route rendered #eef1f7 (2026-07-31 audit, R5).
  // Then the light variant was added the same way it was diagnosed: by hand.
  // Which left the DARK half still on its original six literals, none of them
  // a value in either palette, so the page went on mismatching every dark
  // board it sat in front of and no check noticed -- the drift had simply
  // moved to the side nobody had just been looking at.
  //
  // So the requirement asserted here is not "these values are right" but "no
  // value is written down here at all": src/render.mjs reads `palettes` at
  // render time. Self-containment (no stylesheet link, no script, no network,
  // so it renders under the same locked-down CSP a board does) rules out
  // LINKING src/styles.mjs; it never ruled out reading the same data.
  //
  // Contrast the stage stylesheet, which keeps its literal for a reason that
  // does not apply here: it is injected into a sandboxed srcdoc the page's
  // tokens deliberately never reach, and a custom property is the one thing
  // that WOULD reach through that boundary (QUIRKS.md "Two stylesheets, one
  // palette"). This page renders on the page's own background, in the page's
  // own document. It has no such excuse.
  const html = renderRefusalPage(recoveryCommand());
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  assert.ok(css.length > 0, 'setup failure: could not isolate the refusal page stylesheet');

  const leak = firstLeakOutsideTokenBlocks(css);
  assert.equal(leak, null,
    `the refusal page's stylesheet has a raw color literal outside its token blocks: ${leak} -- every colour it paints must come from src/styles.mjs's palettes through a var(), or it drifts from the boards it sits in front of`);

  // The token blocks themselves must hold the real values, both palettes. The
  // check above only proves nothing is painted outside them; this proves what
  // is inside them was not typed by hand.
  for (const [token, where] of [['--bg', 'the page background'], ['--ink', 'the heading'],
    ['--ink-2', 'the body text'], ['--panel-2', 'the command block'],
    ['--hairline-2', 'its border'], ['--code-ink', 'the command itself'], ['--muted', 'the footnote']]) {
    for (const theme of ['dark', 'light']) {
      assert.ok(css.includes(`${token}: ${palettes[theme][token]};`),
        `the refusal page's ${theme} block must declare ${token} at its ${theme} value (${palettes[theme][token]}), for ${where} -- it is read from src/styles.mjs at render time, so a missing declaration means the page is painting that surface from an inherited default instead`);
    }
  }
});

check('the recovery command is one string, read from one place by everything that prints it', () => {
  // A second copy in the refusal page, the shim or the README is a copy that drifts,
  // and a command that names the wrong path costs the reviewer the session.
  const server = readFileSync(path.join(repoRoot, 'src/server.mjs'), 'utf8');
  const shim = readFileSync(path.join(repoRoot, 'bin/mcp.mjs'), 'utf8');
  for (const [name, src] of [['src/server.mjs', server], ['bin/mcp.mjs', shim]]) {
    assert.match(src, /recoveryCommand\(\)/, `${name} must call recoveryCommand() rather than spell the command out`);
    assert.doesNotMatch(src, /node .*bin\/authorize\.mjs/, `${name} must not hardcode a second copy of it`);
  }
});

check('nothing in the tree still refers to the deleted board-scoped submit token', () => {
  // SPEC_LAUNCH.md: "Submit collapses into the read credential", and the deletion lands
  // in the same slice as the gate. A leftover reference is a leftover code path.
  const files = ['src/secret.mjs', 'src/server.mjs', 'src/handoff.mjs', 'src/ui.mjs', 'bin/mcp.mjs', 'bin/authorize.mjs', 'PROTOCOL.md'];
  for (const f of files) {
    const src = readFileSync(path.join(repoRoot, f), 'utf8');
    for (const dead of ['cb_submit', 'SUBMIT_COOKIE', 'submitToken']) {
      assert.ok(!src.includes(dead), `${f} still mentions ${dead}`);
    }
  }
});

rmSync(fixturesDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pure checks ok');
