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
// The pre-marked (edb611b) markdown module, frozen as a fixture: AC 10
// ("slugs byte-identical to today's output, so every archived section: ref
// still resolves") is asserted by running BOTH implementations over one corpus, not
// by golden strings re-derived from the current source. See the fixture's header.
import { mdToHtmlAndAnchors as legacyMdToHtmlAndAnchors } from './fixtures/markdown-pre-marked.mjs';
import { createBoard, addRound, amendRound, applySubmit, buildPacket, resolveComment, findBlock, questionBlocks } from '../src/board.mjs';
import { renderBoardPage, renderRoundSection, renderBlock, groupCommentsByBlock, stageAgentScript, STAGE_ACCENT_HEX, STAGE_MARGIN_RESET, isPageBoard, renderRefusalPage, CSP, INDEX_CSP, COMMENT_ICON, highlightFenceHtml } from '../src/render.mjs';
import { sessionToken, sessionCookieMatches, SESSION_COOKIE } from '../src/secret.mjs';
import { createHandoffStore, handoffTarget, recoveryCommand, shellQuote } from '../src/handoff.mjs';
import { resolveRef, langForPath, resolvePath, resolveRefRoots, resolveBoardCwd, DEFAULT_REF_ROOTS, MAX_REF_BYTES } from '../src/resolve.mjs';
import { SUPPORTED_LANGUAGES } from '../src/vendor/prism/index.mjs';
// Both used only by the reference-boundary checks. The descriptor
// discipline inside resolveRef is asserted by swapping the file out BETWEEN the check
// and the read, which means patching the fs namespace src/resolve.mjs imports from --
// node:module's syncBuiltinESMExports is what propagates such a patch into an ESM
// module's already-bound named imports.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ui } from '../src/ui.mjs';
import { styles, palettes, faviconLink } from '../src/styles.mjs';
import { indexScript, buildThreadIndex, renderIndexPage, folderName, roundCount } from '../src/indexpage.mjs';
import { formatCountdown, DEFAULT_SETTINGS } from '../src/pomodoro.mjs';
import { TOMATO_ICON, REST_ICON } from '../src/pomodoro-widget.mjs';
import { cueNames, NO_CUE } from '../src/cues.mjs';
import { computeBoardPatch } from '../src/patch.mjs';
import { ASSET_NAME, SCRIPT_ASSET, STYLE_ASSET, MERMAID_ASSET } from '../src/assets.mjs';
import {
  roundIsAwaitedOpen, roundIsCurrentlyAwaited, roundCountdownText, pageBoardPillMeta,
  closeLapsedAwaitedRounds, roundWaitLapsed,
  PILL_READONLY_TITLE, ROUND_OPEN_UNAWAITED_TITLE, ROUND_COUNTDOWN_TITLE, PILL_SUBMITTED_TITLE,
} from '../src/badge.mjs';
// Namespace import, alongside the named one above -- AC 12's own check below
// needs to assert badgeLabel is ABSENT from this module's exports, which a
// named `import { badgeLabel }` cannot express (a missing named export is a
// SyntaxError at load time, not something a check could catch and report).
import * as badgeExports from '../src/badge.mjs';
import { lensZoomAt, lensFit, lensOneToOne } from '../src/lens.mjs';
import {
  extractHint, stepsToPath, pathToSteps, resolveSteps, buildSteps, composeHint,
  parseHtmlTree, elementText, resolveDomAnchor, resolveDomAnchorInSection,
  parseMermaidDomId, mermaidRefResolves, resolveMermaidAnchor, MERMAID_NODE_SELECTOR,
  findPendingCommentForAnchor, removePendingComment,
} from '../src/anchor.mjs';
import { parseHTML, StandInEvent, resolveComputedProperty } from './dom-stand-in.mjs';

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

/** Strip the #board-data JSON payload from a rendered page, leaving only the block markup
 * that renderBlock actually emitted. Asserting against the raw page string is unsafe for a
 * block-kind-coverage check: any field value on a block (a label, a snippet of prose) is
 * also present in the JSON board.blocks the page inlines verbatim for hydration, and
 * finding it there proves nothing about whether the corresponding renderBlock case ran.
 *
 * This used to strip two more things, for the same reason: the inlined `<style>` block
 * (where a class name like "compare-grid" is also a CSS selector) and the inlined client
 * `<script type="module">` (where it is also a querySelector string literal). Since ADR 70
 * the page carries neither -- it names them as sibling files -- so the JSON payload is the
 * only haystack left that can produce a false positive. */
function renderedMarkup(html) {
  return html.replace(/<script id="board-data"[^>]*>[\s\S]*?<\/script>/, '');
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
    '<a href="https://x.se" target="_blank" rel="noopener noreferrer">link</a>',
    '<img alt="alt" src="img.png">',
    '<em>Findings for MAP_AUTH.md, method census.</em>',
    'plain ssn_country stay literal',
    '<strong>double</strong>',
    '<ul><li id="title-li1">one<ul><li>nested</li></ul></li><li id="title-li2">two</li></ul>',
    '<div class="table-scroll"><table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table></div>',
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

// --- attribute-value escaping in the markdown renderer (security) ------
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
  // href plus the two FIXED attributes every link now carries, spelled literally rather
  // than as a wildcard: a crafted `onmouseover=` still has nowhere to land.
  assert.ok(/^<a href="[^"]*" target="_blank" rel="noopener noreferrer">$/.test(tag), `a tag is not exactly href+target+rel, a live attribute leaked in: ${tag}`);
  assert.equal(out, '<p><a href="https://x.se/&quot;onmouseover=alert(1" target="_blank" rel="noopener noreferrer">t</a>x=")</p>');
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
  assert.equal(out, '<p><a href="#" target="_blank" rel="noopener noreferrer">t</a>)</p>');
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
  assert.equal(mdToHtml('[h](https://x.se/path)'), '<p><a href="https://x.se/path" target="_blank" rel="noopener noreferrer">h</a></p>');
  assert.equal(mdToHtml('[m](mailto:a@b.com)'), '<p><a href="mailto:a@b.com" target="_blank" rel="noopener noreferrer">m</a></p>');
  assert.equal(mdToHtml('[r](/a/b)'), '<p><a href="/a/b" target="_blank" rel="noopener noreferrer">r</a></p>');
  assert.equal(mdToHtml('[f](#sec)'), '<p><a href="#sec" target="_blank" rel="noopener noreferrer">f</a></p>');
});

// --- markdown.mjs: ticket 03 -- vendoring marked closes the stated ceiling --------
//
// src/markdown.mjs now tokenizes through the vendored `marked@18.0.9` (ADR 62)
// instead of the hand-rolled line scanner these checks used to exercise directly,
// while keeping slugify, anchor emission and raw-HTML escaping this module's own.
// One contiguous block, appended after the pre-existing markdown section above so
// a parallel ticket appending elsewhere in this file merges cleanly.

check('AC 9: raw HTML in a markdown source renders as text, inline and as a block -- never as live markup', () => {
  const inline = mdToHtml('before <script>alert(1)</script> after, and <img src=x onerror=alert(2)> tag.');
  assert.ok(!/<script>/i.test(inline), `a raw <script> tag must not reach the page live: ${inline}`);
  assert.ok(inline.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(inline.includes('&lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(!/onerror=/.test(inline.replace(/&lt;.*?&gt;/g, '')), 'no live onerror attribute may survive outside the escaped text');

  const block = mdToHtml('<div class="x" onclick="alert(1)">\nhi\n</div>\n');
  assert.ok(!/<div/i.test(block), `a raw block-level <div> must not reach the page live: ${block}`);
  assert.ok(block.includes('&lt;div class="x" onclick="alert(1)"&gt;'));

  // The ablation-verified XSS payloads this fix must not disturb (test/check-pure.mjs's
  // own security section above) exercise markdown IMAGE/LINK syntax, a completely
  // different code path from raw inline/block HTML tags -- this check is the raw-HTML
  // half AC 9 separately requires, closing the gap markdown.mjs's own header comment
  // used to name as its stated ceiling.
});

check('AC 10: heading and list-item slugs are byte-identical to the pre-marked implementation, across a corpus including duplicate-disambiguation', () => {
  // Golden values captured by running this exact corpus through the pre-rewrite
  // (hand-rolled-scanner) src/markdown.mjs before src/vendor/marked was wired in --
  // a mechanical snapshot, not a re-derivation from the current source, so a
  // regression in the anchor-emission rewrite has something independent to diff
  // against. AC 10's other half -- that `src/resolve.mjs:500`'s independent
  // `slugify` pass still agrees -- is covered structurally: `slugify` itself is the
  // same exported function, byte-unchanged by this rewrite (see its own comment).
  const corpus = [
    '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6',
    '# Notes\n\na\n\n# Notes\n\nb\n\n# Notes\n\nc\n\n# Notes\n\nd',
    '# Risk & Reward!\n\n## What\'s Next??\n\n### CAFÉ Déjà Vu',
    '# Section One\n\n- alpha\n- beta\n- gamma\n\n## Section Two\n\n1. first\n2. second\n\n### Section Three',
    '# Risks\n\n- one\n- two\n\n## Risks li1',
    '- lone one\n- lone two\n\n# First Heading\n\n- a\n- b',
    '# Deep\n\n- top1\n  - nested1\n  - nested2\n- top2\n  - nested3',
    '# Real\n\n> ## Quoted\n> - quoted item\n\n## Real2',
    Array.from({ length: 12 }, () => '# Same').join('\n\n'),
  ];
  const golden = [
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    ['notes', 'notes-2', 'notes-3', 'notes-4'],
    ['risk-reward', 'whats-next', 'caf-dj-vu'],
    ['section-one', 'section-one-li1', 'section-one-li2', 'section-one-li3', 'section-two', 'section-two-li1', 'section-two-li2', 'section-three'],
    ['risks', 'risks-li1', 'risks-li2', 'risks-li1-2'],
    ['_body-li1', '_body-li2', 'first-heading', 'first-heading-li1', 'first-heading-li2'],
    ['deep', 'deep-li1', 'deep-li2'],
    ['real', 'real2'],
    ['same', 'same-2', 'same-3', 'same-4', 'same-5', 'same-6', 'same-7', 'same-8', 'same-9', 'same-10', 'same-11', 'same-12'],
  ];
  corpus.forEach((md, i) => {
    const refs = mdToHtmlAndAnchors(md).anchors.map(a => a.ref);
    assert.deepEqual(refs, golden[i], `corpus[${i}] slug drift -- got ${JSON.stringify(refs)}, want ${JSON.stringify(golden[i])}`);
  });
});

check('AC 11: reference-style links resolve through a [ref]: definition, not just inline (text) syntax', () => {
  // A link title, if the definition carries one, is not rendered -- same as before
  // this module vendored marked, which never supported titles at all (the inline
  // `(href)` syntax had no capture for one).
  const out = mdToHtml('[ref link][1]\n\n[1]: https://example.com "title"\n');
  assert.equal(out, '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">ref link</a></p>');
});

check('AC 11: setext headings (Title\\n===) RENDER as headings at the right level, but mint no anchor -- AC 10 outranks anchoring them', () => {
  // The product call (AC 11 closes the setext gap; AC 10 requires
  // slugs byte-identical to the pre-marked parser, which had no setext at all):
  // setext headings render, and are skipped by the anchor minter. Anchoring them
  // would consume slug ordinals the old parser never consumed, so a document mixing
  // a setext heading with a duplicate-text `#` heading would shift every later slug
  // and break archived `section:` references. The byte-identity proof against the
  // real pre-marked implementation is the check below.
  const { html, anchors } = mdToHtmlAndAnchors('Setext One\n==========\n\nbody\n\nSetext Two\n----------\n');
  assert.equal(html, '<h1>Setext One</h1><p>body</p><h2>Setext Two</h2>');
  assert.deepEqual(anchors, [], 'a setext heading mints no anchor and consumes no slug');
});

check('AC 10/11: a document mixing setext and duplicate-text ATX headings mints slugs byte-identical to the pre-marked parser', () => {
  // Not golden strings: the actual edb611b implementation, imported and run on the
  // same corpus (test/fixtures/markdown-pre-marked.mjs -- see its header). A setext
  // heading was invisible to that parser, so every slug after one has to land on the
  // same ordinal it did then, which is precisely what a setext anchor would break.
  const corpus = [
    'Notes\n=====\n\nsetext body\n\n# Notes\n\natx body\n\n# Notes\n\nmore\n',
    '# Plan\n\n- a\n- b\n\nPlan\n----\n\nquiet\n\n## Plan\n\ntail\n',
    'Intro\n=====\n\nbody\n\nDetails\n-------\n\ndetail\n\n## Trailer\n\ntrailer\n',
    '# Same\n\nSame\n----\n\n# Same\n\n- item\n',
  ];
  for (const md of corpus) {
    const now = mdToHtmlAndAnchors(md).anchors.map(a => a.ref);
    const then = legacyMdToHtmlAndAnchors(md).anchors.map(a => a.ref);
    assert.deepEqual(now, then, `slug drift against the pre-marked parser for ${JSON.stringify(md)}`);
  }
  // ...while the headings themselves still RENDER, which is the half AC 11 keeps.
  assert.ok(mdToHtmlAndAnchors(corpus[0]).html.startsWith('<h1>Notes</h1>'));
});

check('AC 11: a loose list (blank line between items) wraps each item in its own <p>, unlike a tight list', () => {
  const loose = mdToHtml('- one\n\n- two\n\n- three\n');
  assert.equal(loose, '<ul><li id="_body-li1"><p>one</p></li><li id="_body-li2"><p>two</p></li><li id="_body-li3"><p>three</p></li></ul>');
  const tight = mdToHtml('- one\n- two\n');
  assert.equal(tight, '<ul><li id="_body-li1">one</li><li id="_body-li2">two</li></ul>');
});

check('AC 11: a pipe inside a table cell\'s code span no longer splits the cell in two', () => {
  const out = mdToHtml('| a | b |\n|---|---|\n| `x|y` | z |\n');
  assert.equal(out, '<div class="table-scroll"><table><tr><th>a</th><th>b</th></tr><tr><td><code>x|y</code></td><td>z</td></tr></table></div>');
});

check('an INDENTED table renders every column -- GFM allows up to three spaces in front of the leading pipe, and the last column used to fall off the end', () => {
  // splitTableRowCells stripped the leading pipe with `^\|`, anchored at column 0.
  // marked tokenizes an indented table exactly like an unindented one, so at 1-3
  // spaces of indent the pipe survived the strip, split as an ordinary separator and
  // produced an empty cell in front of every real one. renderTable asks for exactly
  // header.length columns, so every row shifted right by one and the LAST column was
  // silently dropped -- content loss in the surface whose promise is a faithful view
  // of the source. Ablation: restore `^\|` and every indented case below loses `c`/`3`.
  const flush = mdToHtml('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n');
  for (const indent of [' ', '  ', '   ']) {
    const md = `${indent}| a | b | c |\n${indent}|---|---|---|\n${indent}| 1 | 2 | 3 |\n`;
    assert.equal(mdToHtml(md), flush, `${indent.length} space(s) of indent must render byte-identically to no indent`);
  }
  // Four spaces is an indented code block, not a table -- the boundary the strip is
  // deliberately drawn at, asserted so widening it later is a visible change.
  assert.ok(mdToHtml('    | a | b |\n    |---|---|\n').includes('<pre><code>'),
    'four spaces is CommonMark\'s indented code block; the leading-pipe strip must not reach that far');
});

check('a character reference in source renders as the character it names, not as its own literal source text', () => {
  // esc() escaped every `&`, so a source `&amp;` left this module as `&amp;amp;` and
  // the reviewer read the literal text "&amp;" where the file says "&". CommonMark
  // decodes character references in prose; the fix passes a `&` that already begins
  // one through untouched and lets the browser decode it, exactly as marked's own
  // renderer does. Ablation: escape every `&` again and the first four go double.
  assert.equal(mdToHtml('A &amp; B'), '<p>A &amp; B</p>');
  assert.equal(mdToHtml('&lt;tag&gt; stays text'), '<p>&lt;tag&gt; stays text</p>');
  assert.equal(mdToHtml('caf&eacute;'), '<p>caf&eacute;</p>');
  assert.equal(mdToHtml('&#38; and &#x26;'), '<p>&#38; and &#x26;</p>');

  // A bare ampersand is not a reference and still escapes -- exactly once, as before.
  assert.equal(mdToHtml('Risk & Reward'), '<p>Risk &amp; Reward</p>');
  assert.equal(mdToHtml('a &notaref b'), '<p>a &amp;notaref b</p>');
  // A BACKSLASH-escaped one is literal source text, so it must still double: `\&amp;`
  // is the author asking for the five characters, not for an ampersand.
  assert.equal(mdToHtml('\\&amp;'), '<p>&amp;amp;</p>');

  // Code and raw HTML are the contexts CommonMark does NOT decode: they show the
  // file's own bytes, entity and all, and must keep the full escape.
  assert.equal(mdToHtml('`&amp;`'), '<p><code>&amp;amp;</code></p>');
  assert.ok(mdToHtml('```\n&amp;\n```\n').includes('<pre><code>&amp;amp;</code></pre>'));
  assert.ok(mdToHtml('<a href="x?a=1&amp;b=2">hi</a>').includes('&amp;amp;'),
    'raw HTML renders as its own source text (AC 9), so nothing in it decodes either');

  // The attribute context keeps the full escape too, and this one is load-bearing:
  // safeUrl vets the scheme HERE, the browser decodes character references AFTER, so
  // a reference that would decode into a scheme must never reach the attribute
  // intact. `javascript&colon;` decodes to `javascript:` in a real browser.
  const sneaky = mdToHtml('[x](javascript&colon;alert(1))');
  assert.ok(!sneaky.includes('javascript&colon;'), 'a `&` in a URL must stay escaped -- the allowlist cannot see a scheme hidden behind a character reference');
  assert.ok(sneaky.includes('javascript&amp;colon;'), 'and it is the escaped form that reaches the attribute');
});

check('AC 12: GFM is on -- task lists, strikethrough, autolinks and tables all render', () => {
  const tasks = mdToHtml('- [ ] todo\n- [x] done\n');
  assert.ok(tasks.includes('<input type="checkbox" disabled> todo'));
  assert.ok(tasks.includes('<input type="checkbox" disabled checked> done'));

  assert.ok(mdToHtml('~~gone~~').includes('<del>gone</del>'));

  const autolinks = mdToHtml('http://example.com and www.foo.com');
  assert.ok(autolinks.includes('<a href="http://example.com" target="_blank" rel="noopener noreferrer">http://example.com</a>'));
  assert.ok(autolinks.includes('<a href="http://www.foo.com" target="_blank" rel="noopener noreferrer">www.foo.com</a>'));

  const table = mdToHtml('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n');
  assert.equal(table, '<div class="table-scroll"><table><tr><th align="left">L</th><th align="center">C</th><th align="right">R</th></tr>' +
    '<tr><td align="left">a</td><td align="center">b</td><td align="right">c</td></tr></table></div>');
});

check('AC 13: a ```mermaid fence still becomes <pre class="mermaid"> even alongside the new GFM/reference-link machinery', () => {
  const md = '# Diagram\n\nSee [the spec][s].\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n[s]: https://example.com\n';
  const out = mdToHtml(md);
  assert.ok(out.includes('<pre class="mermaid">flowchart LR\n  A --&gt; B</pre>'));
  assert.ok(out.includes('href="https://example.com"'));
});

check('N2 (extended): a GFM strikethrough run with no closing ~~ is scanned in linear time -- the same DoS class emphasis was fixed against, now covering marked\'s del tokenizer too', () => {
  const md = ' ~~a'.repeat(150000); // 600KB, inside the by-value cap
  const started = Date.now();
  mdToHtml(md);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `strikethrough scan took ${elapsed}ms on 600KB`);
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

// --- amending a still-open round, and the additive-push patch --------

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

// The same computeBoardPatch technique, applied to the
// hint-composition rule test/check-comment-mode.mjs's checks exercise
// end to end. An earlier draft got this specifically wrong: src/anchor.mjs
// carried a design COMMENT describing the rule but no actual code, so reverting
// that file changed nothing any check could see -- exactly the "looks right,
// believed correct, not actually exercised" shape this check exists to
// repair. This check is what makes that regression loud again if it recurs: a
// hand-edit of ui.mjs's embedded copy that diverges from src/anchor.mjs's real
// composeHint fails here even before any behavioural check would notice.
check('ui.mjs embeds the literal source of composeHint, not a hand-copied reimplementation', () => {
  assert.ok(
    ui.includes(composeHint.toString()),
    'the client script must contain the exact function source, so the hint rule and the browser copy can never drift apart',
  );
});

check('composeHint: identity alone outside a compare, matching the plain html-stage hint unchanged', () => {
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

// `ROLE_WORD[tag]`/`BLOCK_NOUN[blockKind]` had no `hasOwnProperty`
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

check('composeHint: every block-kind noun, and an unknown kind degrades to "block" rather than throwing', () => {
  assert.equal(composeHint('x', 'span', true, 'A', 'html'), 'x in A stage');
  assert.equal(composeHint('x', 'span', true, 'A', 'mermaid'), 'x in A diagram');
  assert.equal(composeHint('x', 'span', true, 'A', 'code'), 'x in A reference');
  assert.equal(composeHint('x', 'span', true, 'A', 'question'), 'x in A question');
  assert.equal(composeHint('x', 'span', true, 'A', 'compare'), 'x in A comparison');
  assert.equal(composeHint('x', 'span', true, 'A', 'markdown'), 'x in A block');
  assert.equal(composeHint('x', 'span', true, 'A', 'nonsense-kind'), 'x in A block');
});

// ADR.md entry 42 deleted the round badge and its
// `badgeLabel` formatter along with it -- the checks that used to pin its
// round-count formatting and its embedded-source went with them. The two
// checks below pin what replaced them: AC 9's glyph, read off COMMENT_ICON's
// own path data (same discipline as src/pomodoro-widget.mjs's TOMATO_ICON/
// REST_ICON, see that check's own comment), and AC 12's absence, which the
// checks above never asserted -- only a comment said so.

const COMMENT_PATHS = [...COMMENT_ICON.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
assert.equal(COMMENT_PATHS.length, 1, 'setup sanity: COMMENT_ICON is a single <path>');

check('the comment-mode toggle wears the exact same glyph as the whole-block comment button -- COMMENT_ICON\'s own path data, not a second, re-drawn copy', () => {
  // Two blocks, neither a page board, so both controls exist on the same
  // page: an html block earns a .comment-btn (ADR.md entry 28), and the
  // second block is what keeps this from being inferred as a page board
  // (isPageRound requires exactly one block) so the header's own actions
  // row -- and #comment-mode-toggle inside it -- renders in the ordinary,
  // non-fullpage shape.
  const board = createBoard({
    title: 'AC 9 glyph',
    blocks: [{ kind: 'html', html: '<p>stage</p>' }, { kind: 'markdown', text: 'second block' }],
  });
  const document = parseHTML(renderBoardPage(board));

  const toggle = document.getElementById('comment-mode-toggle');
  assert.ok(toggle, 'setup failure: no #comment-mode-toggle rendered');
  const togglePaths = [...toggle.querySelectorAll('path')].map(p => p.getAttribute('d'));
  assert.deepEqual(togglePaths, COMMENT_PATHS,
    'the comment-mode toggle must render COMMENT_ICON\'s own path data, not a hand-drawn glyph (e.g. the old crosshair) that could silently drift from it');

  const commentBtn = document.querySelector('.comment-btn');
  assert.ok(commentBtn, 'setup failure: no .comment-btn rendered for the html block');
  const btnPaths = [...commentBtn.querySelectorAll('path')].map(p => p.getAttribute('d'));
  assert.deepEqual(btnPaths, COMMENT_PATHS, 'setup sanity: the whole-block comment button must also use COMMENT_ICON');

  assert.deepEqual(togglePaths, btnPaths,
    'the toggle and the whole-block comment button must share the exact same glyph -- one source (COMMENT_ICON), not two spellings of "comment"');
});

check('ADR.md entry 42: no #round-badge/.round-badge element renders anywhere, on an ordinary board or a page board, and badgeLabel is gone from src/badge.mjs\'s exports', () => {
  assert.equal('badgeLabel' in badgeExports, false,
    'src/badge.mjs must no longer export badgeLabel -- AC 12 names this file and this export explicitly');

  const ordinary = createBoard({ title: 'AC 12 ordinary', blocks: [{ kind: 'markdown', text: '# hi' }] });
  addRound(ordinary, { blocks: [{ kind: 'markdown', text: '# second round' }] });
  const ordinaryHtml = renderBoardPage(ordinary);
  assert.ok(!ordinaryHtml.includes('round-badge'), 'an ordinary, multi-round board must render no #round-badge/.round-badge element');

  const page = createBoard({ title: 'AC 12 page board', blocks: [{ kind: 'html', html: '<p>stage</p>' }] });
  const pageHtml = renderBoardPage(page);
  assert.ok(!pageHtml.includes('round-badge'), 'a page board must render no #round-badge/.round-badge element either');

  // "At rest or condensed": the two markup shapes are one and the same DOM
  // node either way (styles.mjs's own comment: "the ONLY #round-meta in the
  // document, condensed or not" applies by the same construction to every
  // header control, and .round-badge simply never renders at all now) -- CSS
  // repositions it, nothing server-side ever emits a second copy for the
  // condensed state. The live scroll-driven transition itself, on a page
  // board, is exercised in test/check-page-board.mjs.

  // AC 12's second half: the pager dock, not the header, is where a round is
  // still named -- confirmed here rather than assumed, so this check would
  // fail if that naming vanished too rather than just moving.
  const headerMatch = ordinaryHtml.match(/<header class="board-head">[\s\S]*?<\/header>/);
  assert.ok(headerMatch, 'setup failure: no <header class="board-head"> found');
  assert.doesNotMatch(headerMatch[0], /round\s*\d/i,
    'the header itself must name no round by number, at rest (AC 12)');
  const captionMatch = ordinaryHtml.match(/<div class="round-pager-caption"[^>]*>([^<]*)<\/div>/);
  assert.ok(captionMatch, 'setup failure: no .round-pager-caption rendered');
  assert.match(captionMatch[1], /round\s*\d/i,
    'the pager dock\'s own caption must still name the round -- proving the naming moved to the dock rather than disappearing entirely');
});

// The waiting signal, src/badge.mjs's own two-
// function split (render-time, no clock, vs. client-time, wall-clock aware).
// See that file's header comment for why the split exists at all.

check('roundIsAwaitedOpen: true only for an OPEN round minted awaited === true, never merely truthy', () => {
  assert.equal(roundIsAwaitedOpen({ status: 'open', awaited: true }), true);
  assert.equal(roundIsAwaitedOpen({ status: 'open', awaited: false }), false);
  assert.equal(roundIsAwaitedOpen({ status: 'sent', awaited: true }), false, 'a sent round is never this, whatever awaitDeadline still says');
  assert.equal(roundIsAwaitedOpen({ status: 'open', awaited: 1 }), false, 'truthy but not === true (a legacy shape, or a bug) must not pass');
  assert.equal(roundIsAwaitedOpen({ status: 'open' }), false, 'a legacy round with no awaited key at all (undefined) is not awaited');
  assert.equal(roundIsAwaitedOpen(null), false, 'a missing round record is not awaited, not a throw');
});

check('roundIsCurrentlyAwaited: roundIsAwaitedOpen AND short of the deadline -- the one place a wall clock enters this file', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const openRound = { status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:10:00.000Z' };
  assert.equal(roundIsCurrentlyAwaited(openRound, now), true, '10 minutes still to go');
  assert.equal(roundIsCurrentlyAwaited(openRound, now + 10 * 60_000 + 1), false, 'one millisecond past the deadline: no longer awaited');
  assert.equal(roundIsCurrentlyAwaited({ status: 'sent', awaited: true, awaitDeadline: '2026-08-07T12:10:00.000Z' }, now), false,
    'sent survives its deadline unchanged (ticket 01\'s own contract) and must still read as not-awaited');
  assert.equal(roundIsCurrentlyAwaited({ status: 'open', awaited: true, awaitDeadline: null }, now), false, 'no deadline at all: never awaited');
});

check('closeLapsedAwaitedRounds: the flag that mintAwait stamps is unstamped the moment its own deadline passes', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const board = {
    rounds: [
      { n: 1, status: 'open', awaited: true, awaitDeadline: '2026-08-07T11:59:59.000Z' }, // lapsed
      { n: 2, status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:10:00.000Z' }, // still running
      { n: 3, status: 'sent', awaited: true, awaitDeadline: '2026-08-07T11:00:00.000Z' }, // already closed by a send
      { n: 4, status: 'open' },                                                           // legacy: no keys at all
      { n: 5, status: 'open', awaited: false, awaitDeadline: null },                      // never awaited
    ],
  };
  assert.equal(closeLapsedAwaitedRounds(board, now), 1, 'exactly the one lapsed round is closed');
  assert.equal(board.rounds[0].awaited, false);
  assert.equal(board.rounds[0].awaitDeadline, '2026-08-07T11:59:59.000Z',
    'the deadline STAYS -- it is the record of when the wait died, and what the dedupe reads');
  assert.equal(board.rounds[0].status, 'open', 'only the flag moves; nothing here sends or archives a round');
  assert.equal(board.rounds[1].awaited, true, 'a wait still inside its deadline is untouched');
  assert.equal(board.rounds[3].awaited, undefined, 'a legacy round has no flag to unstamp and must not grow one');
  assert.equal(closeLapsedAwaitedRounds(board, now), 0, 'idempotent: a second sweep finds nothing left to close');
  assert.equal(closeLapsedAwaitedRounds({}, now), 0, 'a board with no rounds array is 0, not a throw');
});

check('roundWaitLapsed: true for the whole rest of a round\'s life once its deadline passes, swept or not', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  assert.equal(roundWaitLapsed({ awaited: true, awaitDeadline: '2026-08-07T12:10:00.000Z' }, now), false);
  assert.equal(roundWaitLapsed({ awaited: true, awaitDeadline: '2026-08-07T11:59:59.000Z' }, now), true);
  assert.equal(roundWaitLapsed({ awaited: false, awaitDeadline: '2026-08-07T11:59:59.000Z' }, now), true,
    'already swept: still lapsed, which is what stops the dedupe resuming it');
  assert.equal(roundWaitLapsed({ status: 'open' }, now), false, 'no deadline at all: nothing has lapsed');
  assert.equal(roundWaitLapsed(null, now), false);
});

check('roundCountdownText: "Nm left", always rounded UP, never printed once the round stops being currently awaited', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  assert.equal(roundCountdownText({ status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' }, now), '38m left');
  // 37 minutes and 1 second left must still round UP to 38, not truncate to 37 --
  // a reviewer watching the figure tick down must never see it undercount the
  // time actually remaining.
  assert.equal(roundCountdownText({ status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:37:01.000Z' }, now), '38m left');
  assert.equal(roundCountdownText({ status: 'sent', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' }, now), null);
  assert.equal(roundCountdownText({ status: 'open', awaited: false, awaitDeadline: '2026-08-07T12:38:00.000Z' }, now), null);
  assert.equal(roundCountdownText(null, now), null);
});

check('pageBoardPillMeta: the countdown text/title while awaited, and "read-only" for every closed round on the default (page-board) caller', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const awaited = { status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' };
  assert.deepEqual(pageBoardPillMeta(awaited, now), { text: '38m left', title: ROUND_COUNTDOWN_TITLE });
  // Default (no third arg) is 'fullpage', matching every call site before
  // that parameter existed -- PILL_READONLY_TITLE stays what a page board
  // (and any caller not yet told otherwise) gets, a Submitted round
  // included: ADR 89 gives 'submitted' to an ORDINARY board only (see
  // PILL_SUBMITTED_TITLE's own comment on why a page board is held off it at
  // the pill itself, not only by ADR.md entry 44 keeping Send off its
  // browser surface).
  for (const closed of [
    { status: 'sent', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' },
    { status: 'open', awaited: false, awaitDeadline: null },
    null,
  ]) {
    assert.deepEqual(pageBoardPillMeta(closed, now), { text: 'read-only', title: PILL_READONLY_TITLE });
  }
});

check('pageBoardPillMeta: on an ORDINARY board (fullpage=false), an open-but-unawaited round\'s title stops claiming commenting is off, and a Submitted round reads "submitted"', () => {
  // The exact shape a plain `ask` with no `wait: true` leaves behind
  // (src/board.mjs:526's default): open, not awaited. On a page board this
  // is genuinely dark (PILL_READONLY_TITLE, unchanged above); on an ordinary
  // board it sits over an ENABLED send bar (src/ui.mjs's setSendBarEnabled
  // reads status/openRoundNumber, never awaited) and a comment left there is
  // drained to the next agent that asks (drainUndeliveredComments,
  // src/server.mjs) -- so the title must say that instead.
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const openUnawaited = { status: 'open', awaited: false, awaitDeadline: null };
  assert.deepEqual(pageBoardPillMeta(openUnawaited, now, false),
    { text: 'read-only', title: ROUND_OPEN_UNAWAITED_TITLE },
    'fullpage=false, status "open": the title must be ROUND_OPEN_UNAWAITED_TITLE, not the page-board one');
  // The SAME round object, asked about as a page board (fullpage=true, or the
  // default), must still get the old title -- a page board's status never
  // leaves 'open' even once its wait dies (ADR.md entry 44), so `fullpage`
  // itself, not `round.status` alone, is what has to make this call.
  assert.deepEqual(pageBoardPillMeta(openUnawaited, now, true), { text: 'read-only', title: PILL_READONLY_TITLE },
    'the identical round object, asked about as a page board, must keep the page-board title');

  // ADR 89: a Submitted round on an ORDINARY board reads "submitted" -- but
  // the SAME round object, asked about as a page board, must stay
  // "read-only": criterion 12 holds a page board off 'submitted' at the pill
  // itself, not only by ADR.md entry 44 keeping Send off its browser
  // surface, since `applySubmit` does not itself refuse a page round.
  const sent = { status: 'sent', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' };
  assert.deepEqual(pageBoardPillMeta(sent, now, false), { text: 'submitted', title: PILL_SUBMITTED_TITLE },
    'fullpage=false, status "sent": the pill must read "submitted"');
  assert.deepEqual(pageBoardPillMeta(sent, now, true), { text: 'read-only', title: PILL_READONLY_TITLE },
    'the identical round object, asked about as a page board, must stay "read-only", never "submitted"');
});

check('the exact waiting-signal functions embedded in ui.mjs (via .toString()) are executable and behave identically to the imported ones', () => {
  // Spliced in dependency order (roundIsAwaitedOpen, then roundIsCurrentlyAwaited,
  // then roundCountdownText, then pageBoardPillMeta), each calling only a name
  // already assigned above it -- src/ui.mjs's own comment on the splice explains
  // why that is safe regardless of *when* any of them is later called. Rehydrated
  // together, in the same order, so this proves the actual dependency chain works
  // standalone, not just that each function parses in isolation.
  const rehydrated = new Function(`
    var ROUND_COUNTDOWN_TITLE = ${JSON.stringify(ROUND_COUNTDOWN_TITLE)};
    var PILL_READONLY_TITLE = ${JSON.stringify(PILL_READONLY_TITLE)};
    var ROUND_OPEN_UNAWAITED_TITLE = ${JSON.stringify(ROUND_OPEN_UNAWAITED_TITLE)};
    var PILL_SUBMITTED_TITLE = ${JSON.stringify(PILL_SUBMITTED_TITLE)};
    var roundIsAwaitedOpen = ${roundIsAwaitedOpen.toString()};
    var roundIsCurrentlyAwaited = ${roundIsCurrentlyAwaited.toString()};
    var roundCountdownText = ${roundCountdownText.toString()};
    var pageBoardPillMeta = ${pageBoardPillMeta.toString()};
    return { roundIsAwaitedOpen: roundIsAwaitedOpen, roundIsCurrentlyAwaited: roundIsCurrentlyAwaited, roundCountdownText: roundCountdownText, pageBoardPillMeta: pageBoardPillMeta };
  `)();
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const round = { status: 'open', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' };
  assert.equal(rehydrated.roundIsAwaitedOpen(round), roundIsAwaitedOpen(round));
  assert.equal(rehydrated.roundIsCurrentlyAwaited(round, now), roundIsCurrentlyAwaited(round, now));
  assert.equal(rehydrated.roundCountdownText(round, now), roundCountdownText(round, now));
  assert.deepEqual(rehydrated.pageBoardPillMeta(round, now), pageBoardPillMeta(round, now));
  // The third-arg (fullpage=false) branch too -- otherwise a drift in the
  // embedded copy's ROUND_OPEN_UNAWAITED_TITLE handling could pass every check
  // above and still ship a stale title to a live tab.
  const openUnawaited = { status: 'open', awaited: false, awaitDeadline: null };
  assert.deepEqual(rehydrated.pageBoardPillMeta(openUnawaited, now, false), pageBoardPillMeta(openUnawaited, now, false));
  // And the Submitted branch (ADR 89), on an ORDINARY board -- the only
  // caller that ever reaches it (a page board's `sent` round stays
  // "read-only", asserted above). The embedded copy needs its own
  // PILL_SUBMITTED_TITLE in scope, not just the two read-only titles above,
  // or a sent round would throw a ReferenceError in a real tab instead of
  // merely rendering the wrong word.
  const sent = { status: 'sent', awaited: true, awaitDeadline: '2026-08-07T12:38:00.000Z' };
  assert.deepEqual(rehydrated.pageBoardPillMeta(sent, now, false), pageBoardPillMeta(sent, now, false));
});

check('ui.mjs embeds the literal source of every waiting-signal function, not a hand-copied reimplementation', () => {
  for (const fn of [roundIsAwaitedOpen, roundIsCurrentlyAwaited, roundCountdownText, pageBoardPillMeta]) {
    assert.ok(ui.includes(fn.toString()), `client script must contain ${fn.name}'s exact source`);
  }
});

check('src/render.mjs never calls Date.now() -- the waiting signal it renders must stay a pure function of the board JSON (see badge.mjs\'s own header comment on the split)', () => {
  const renderSource = readFileSync(fileURLToPath(new URL('../src/render.mjs', import.meta.url)), 'utf8');
  assert.ok(!renderSource.includes('Date.now'),
    'src/render.mjs must never read the wall clock: examples/sample-board.html and test/check-sample-board.mjs pin exact bytes, which a render-time Date.now() would make non-reproducible');
});

// The diagram lens's view math, the
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

check('lensFit clamps into the SAME band lensZoomAt does, so the first wheel-out on a very tall diagram cannot zoom IN', () => {
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
      // A diagram, not prose: ADR.md entry 28 deleted the `md` anchor kind along
      // with the affordance that minted it, so the resolved/lost pair below is
      // carried by the two kinds that are still commentable.
      { kind: 'mermaid', text: 'flowchart LR\n  one --> two' },
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
      { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'two' }, text: 'criterion 2 needs work' },
      { blockId: 'm1', anchor: { kind: 'mermaid', ref: 'ghost' }, text: 'anchor that no longer exists' },
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
  // ADR 99: the packet carries no `resolved` key at all, on any comment --
  // resolved or lost, `lost` alone tells the two apart.
  for (const c of packet.comments) assert.equal('resolved' in c, false, `packet comment #${c.n} must carry no resolved key`);

  const resolved = packet.comments.find(c => c.anchor.ref === 'two');
  assert.equal(resolved.blockKind, 'mermaid');
  assert.equal(resolved.lost, undefined);

  const lost = packet.comments.find(c => c.anchor.ref === 'ghost');
  assert.equal(lost.lost, 'ghost');

  const blockLevel = packet.comments.find(c => c.blockId === 'q1');
  assert.equal(blockLevel.lost, undefined);
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

// --- src/anchor.mjs: element-level anchoring, pure --------------------
//
// Click gestures themselves need a browser and are explicitly out of scope for the
// automated checks; src/anchor.mjs is the seam that carries
// every bit of anchoring logic that *isn't* the gesture -- path building, hint
// extraction, path resolution, mermaid id round-tripping -- so it can be proven
// here without simulating a DOM. src/ui.mjs's click handlers are a thin duplicate
// of these same functions (necessarily: the served page has no import graph at
// runtime, see the standalone-archive guarantee), exercised only by hand.

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
// contiguous-substring match) -- caught as a real bug. These checks pin the fix: ref must actually address an element, and only
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

// `domIdentityHintMatches` ended
// `return normalizedHint.startsWith(normalizedIdentity)`, checking the
// relationship backwards -- a live element whose text is a literal PREFIX of
// some unrelated stored hint satisfied `startsWith` by coincidence, resolving
// the comment onto the wrong element rather than reporting it lost. These are
// the three rows that measured true (should be false) on HEAD before
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

check('a `/`-suffixed non-void start tag anchors the element the BROWSER resolves, not one the resolver invented', () => {
  // HTML5's tree builder never acknowledges the self-closing flag on an HTML
  // element, so `<div/>` opens a div that STAYS OPEN and takes what follows as its
  // children. parseHtmlTree gated on the flag for every non-void tag, so the
  // resolver closed a div the browser had left open: every following element became
  // a top-level sibling server-side and a child on screen, and every index past the
  // `<div/>` shifted. A comment left on the button below either resolved against the
  // wrong element or came back `resolved: false` -- "you commented on something
  // that's gone" about an element plainly still on the page. Ablation: gate on
  // `selfClosed` for every tag again and every assertion here flips.
  const html = '<div class="panel"/><button>Send</button><p>after</p>';
  // The browser's own reading of the same bytes first (test/dom-stand-in.mjs is this
  // suite's browser), so the expected ref is not this file's second opinion.
  const panel = parseHTML(html).querySelector('div.panel');
  assert.equal(panel.children.length, 2, 'in a browser the trailing slash closes nothing: the button and the paragraph are both the div\'s children');
  assert.equal(panel.children[0].textContent, 'Send');
  assert.equal(panel.children[1].textContent, 'after');

  // `1.1` is "the first child of the first top-level element" -- what the client
  // mints for that button. It has to resolve, and the ref that only made sense
  // under the old, browser-disagreeing shape must not.
  assert.ok(resolveDomAnchor(html, '1.1', 'Send'), 'the button is the div\'s first child, server-side as in the page');
  assert.equal(resolveDomAnchor(html, '2', 'Send'), false, 'it is not a top-level sibling of the div -- that was the divergence');
  assert.ok(resolveDomAnchor(html, '1.2', 'after'), 'the paragraph is the div\'s second child');

  // SVG is where the flag really is acknowledged, for the whole subtree, so it must
  // keep working the other way -- the fix is "follow the browser", not "ignore the
  // slash".
  const svg = '<svg><circle/><rect/></svg><p>after</p>';
  assert.ok(resolveDomAnchor(svg, '2', 'after'), 'a closed <svg> leaves the paragraph a top-level sibling, exactly as a browser has it');
});

check('a CLOSED <svg> earlier in the document does not make a later `/`-suffixed HTML element self-closing -- the foreign-content flag must not outlive its subtree', () => {
  // The bookkeeping that tracks "am I inside SVG/MathML" is a stack INDEX, retired
  // when the stack shrinks back to it. Retiring it after the implied-parent pushes
  // instead of before read the re-grown stack: `<td>` inside `<table>` pushes an
  // implied `<tbody>` and `<tr>`, putting the stack back past a closed `<svg>`'s old
  // index, so the `/` on `<td/>` was honoured as if the td sat in foreign content.
  // The td closed immediately and `<span>` became its SIBLING -- while the same
  // markup WITHOUT the svg (and a real browser, in both) makes the span its CHILD.
  // A comment on that span then anchors to a different element depending on whether
  // an unrelated svg appeared earlier in the stage. test/check-parser-parity.mjs
  // cannot see this: both parsers share the ordering, so they agree on the wrong
  // answer. Hence the absolute shape below, not a parity assertion. Ablation: move
  // the `foreignAt >= stack.length` reset back below the implied-parent loop in
  // src/anchor.mjs and the first case regresses to a `td`/`span` sibling pair.
  const shape = nodes => nodes.map(n => ({ tag: n.tag, children: shape(n.children) }));
  const expected = [{ tag: 'tbody', children: [{ tag: 'tr', children: [{ tag: 'td', children: [{ tag: 'span', children: [] }] }] }] }];

  const [withSvg] = parseHtmlTree('<table><svg></svg><td/><span>x</span></table>').children;
  assert.deepEqual(shape(withSvg.children.slice(1)), expected,
    'the span is the td\'s child: a closed <svg> two elements earlier must not reach the `/` on <td/>');
  assert.equal(withSvg.children[0].tag, 'svg', 'setup failure: the svg itself is still the table\'s first child');

  const [withoutSvg] = parseHtmlTree('<table><td/><span>x</span></table>').children;
  assert.deepEqual(shape(withoutSvg.children), expected, 'and removing the svg changes nothing -- which is the whole point');

  // The same shape one level down: a foreign subtree that has genuinely closed
  // leaves ordinary HTML ordinary, however deep the implied scaffolding went.
  const nested = parseHtmlTree('<div><svg><circle/></svg><div/><span>x</span></div>').children[0];
  assert.deepEqual(shape(nested.children), [
    { tag: 'svg', children: [{ tag: 'circle', children: [] }] },
    { tag: 'div', children: [{ tag: 'span', children: [] }] },
  ]);
});

check('resolveDomAnchor requires a non-empty hint, and degrades to false rather than throwing on malformed input', () => {
  const html = '<div><button>Send</button></div>';
  assert.equal(resolveDomAnchor(html, '1.1', ''), false);
  assert.equal(resolveDomAnchor(html, '1.1', null), false);
  assert.equal(resolveDomAnchor(html, '', 'Send'), false);
  assert.equal(resolveDomAnchor(html, null, 'Send'), false);
  assert.doesNotThrow(() => resolveDomAnchor('<div><unclosed>', '1.1', 'Send'));
});

// A browser parses `srcdoc` as a full document
// and hoists a leading <style>/<script>/<meta>/<link>/<title>/<base> into
// <head>, so `document.body`'s first child is the mock's own top-level
// element, not the style tag -- exactly what src/ui.mjs mints every ref
// against. `resolveDomAnchor` used to resolve against parseHtmlTree's raw
// synthetic root instead, which kept the leading <style> as a body sibling and
// shifted every following index by one: the browser-minted ref reported LOST,
// and the UNHOISTED ref one index later resolved instead. Both
// measurements, now inverted.
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
  // two ids in a chain and lost the tail.
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
  // this (10s+ at 160KB). A plain indexOf-based scan must stay fast.
  const adversarial = 'A-'.repeat(50000);
  const start = Date.now();
  const result = mermaidRefResolves(adversarial, 'nonexistent-ref');
  assert.equal(result, false);
  assert.ok(Date.now() - start < 1000, 'mermaidRefResolves must not exhibit exponential/quadratic blowup on adversarial input');
});

// --- src/board.mjs resolveComment: the lost-anchor treatment extended to dom and --
// mermaid anchors (it already covered block, and the `md` kind it also covered then; see
// the check above. ADR.md entry 28 has since deleted `md` outright -- `ANCHOR_KINDS` is
// block/dom/mermaid -- so a stored `md` anchor now degrades instead of resolving).

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
  // A lost `dom` anchor reports the stored HINT ("Launch"), not the
  // opaque index-chain ref ("9.9") -- the hint is what a human or agent can
  // actually recognise as "what this comment was about" once the element it
  // named is gone ("the stored hint is what
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

// --- resolveMermaidAnchor's precedence -- generic first, node id ---
// leaned on as a fallback -- "Mermaid stops being the
// template" -- see DESIGN.md, "### Entry 28 — element anchoring", for the full
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
// `pre.mermaid` itself is excluded from the resolution
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
    assert.equal(resolved.lost, 'nowhere in this section', 'a lost mermaid anchor with a hint must report the hint (the lostLabel rule), not the bare node id');
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

// --- the block's own chrome must never be inside the resolution surface --

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

check('resolveComment: V3 regression -- a forged dom anchor stored against a block\'s own chrome reports lost, not resolved', () => {
  const board = createBoard({ title: 'V3 end to end', blocks: [{ kind: 'markdown', text: '# Notes\n\nSome text.' }] });
  const blockId = board.blocks[0].id;
  applySubmit(board, {
    action: 'send', answers: [],
    comments: [{ blockId, anchor: { kind: 'dom', ref: '1', hint: 'Markdown comment' }, text: 'forged' }],
  }, 1);
  assert.equal(resolveComment(board, board.comments[0]).resolved, false,
    'a dom anchor into a markdown block\'s own kicker (its comment-button text) must not resolve');
});

check('resolveMermaidAnchor: V3 regression -- a forged domRef into the block\'s own chrome (a nonexistent node id, domRef "1") never carries the anchor, only mermaidRefResolves can', () => {
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

// --- a dom anchor must not survive its block's kind changing under it --

// NOTE on reachability: `resolveBlockId` (above in this file) already refuses
// an incoming block whose `kind` doesn't match its `id`'s own kind-letter
// prefix (`{id:'h1', kind:'markdown', ...}` throws "does not start with the
// 'h' letter"), on every normalizeBlock path amendRound uses -- so the exact
// "amendRound swaps a block's kind at the same id" mechanism
// is NOT reachable through the normal write path today; a block's
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

check('resolveComment: a dom anchor with no recorded mintBlockKind (a comment predating that field) resolves exactly as before -- the guard is backward compatible', () => {
  const board = createBoard({ title: 'U5 backcompat', blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }] });
  const blockId = board.blocks[0].id;
  // Hand-built, bypassing applySubmit, exactly like an older archive's stored
  // JSON would be -- no mintBlockKind field at all.
  board.comments.push({ n: 1, blockId, anchor: { kind: 'dom', ref: '1.1', hint: 'Send' }, text: 'old comment', createdAt: new Date().toISOString(), round: 1 });
  assert.equal(resolveComment(board, board.comments[0]).resolved, true);
});

// --- an 'html' block's two client-side dom roots ------
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

// --- anchors into answer-derived content, re-measured with C1 fixed --
//
// Judgement call: NOT fixed here, by design. The decision "An anchor survives
// re-render, not editing" scopes the promise to content unchanged since post
// time. U1's status line and U2's rank order both derive from `board.answers`,
// which only changes when the reviewer answers/re-ranks and sends -- an edit
// of that specific block's answer, not a re-render of unchanged stored JSON. A
// bare re-render (a second page load, an SSE push of the same round) never
// shifts a rank order or an answer status, so it never loses either pin; only
// an intervening Send that changes the answer does, and honestly reports what
// it lost rather than silently vanishing or misattributing -- exactly what
// that decision's second half promises. What DOES matter, and is fixed by C1
// above: before that fix, a rank re-order could resolve onto the WRONG
// sibling (a silent misattribution) whenever one option's identity was a
// prefix of another's; after it, the same re-order always degrades to an
// honest "lost", never a wrong resolve. This locks in that re-measurement
// using the same scenario (options "Ship it" / "Ship it later" / "Drop
// it", where "Ship it" is a literal prefix of "Ship it later").

check('U1, re-verified (previously not reproduced; confirmed here with the real board.mjs functions): a status-line comment is lost by the very Send that carries it, when that Send also answers the question', () => {
  const board = createBoard({
    title: 'U1',
    blocks: [{ kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
  });
  const qid = board.blocks[0].id;
  const sectionHtml = renderBlock(board.blocks[0], board, new Map(), false);
  const sectionRoot = parseHtmlTree(sectionHtml).children[0];
  // question-footer(3) > answer-status span(2) -- fixed sibling positions for a
  // question with no context card: question-main, note-field and footer are the
  // section's three children, and the note and the footer are the section's own
  // (full-width rows under both columns), not question-main's.
  const statusNode = resolveSteps(sectionRoot, pathToSteps('3.2'));
  assert.ok(statusNode && (statusNode.cls || []).includes('answer-status'), 'setup failure: "3.2" must address the status span');
  const hint = extractHint(elementText(statusNode));
  assert.equal(hint, 'status: unanswered');
  assert.equal(resolveDomAnchorInSection(sectionHtml, '3.2', hint), true, 'setup failure: must resolve while genuinely unanswered');

  // The reviewer's ONE Send carries both the comment minted against the
  // still-unanswered status line AND the answer itself -- an answer can only
  // ever be merged into the SAME round its question was posted in
  // (applySubmit's own `answerable` set), so "anchor while unanswered, answer
  // it, Send" is necessarily one request, not two.
  applySubmit(board, {
    action: 'send',
    answers: [{ id: qid, choice: 'Yes' }],
    comments: [{ blockId: qid, anchor: { kind: 'dom', ref: '3.2', hint }, text: 'still says unanswered?' }],
  }, 1);

  const resolved = resolveComment(board, board.comments[0]);
  // Judgement call (not a bug -- see this block's own header comment): the
  // status text this anchor names genuinely changed as a direct result of the
  // reviewer's own answer, in the same request. Reported lost, honestly, per
  // that decision's second half.
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
// graph at runtime (the standalone-archive guarantee) -- rather than
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
  // The heading/list-item `id` attributes survive ADR.md entry 28 -- they are what
  // test/check-archive-ids.mjs's collision guard is about and what a `section:`
  // reference slugifies against (src/resolve.mjs). What went with entry 28 is the
  // inline anchor BUTTON that used to sit beside them (`data-anchor-ref`).
  assert.ok(html1.includes('id="acceptance-criteria"'));
  assert.ok(!html1.includes('data-anchor-ref="acceptance-criteria-li1"'),
    'a markdown heading/list item must carry no comment anchor button (ADR.md entry 28)');
  assert.ok(html1.includes('data-choice="A"'));
  assert.ok(html1.includes('id="send-btn"'));
});

// --- the page board: inferred from the board's shape, laid out at viewport size ---
//
// ADR.md entries 32/33. The rule is a pure function of the board JSON and
// the layout is pure markup plus the stylesheet, so both are asserted here, on
// renderBoardPage's own output -- the cheap seam. The gesture, the sandbox and
// the live transition need a document and the real client script, and are in
// test/check-page-board.mjs; the archive is in test/check-archive.mjs.
//
// Computed values below come from test/dom-stand-in.mjs's resolveComputedProperty
// -- the real cascade over the real stylesheet, against an element in its real
// place in the rendered document -- rather than from matching a rule's spelling.
// QUIRKS.md ("Asserting a rule by its text is itself a trap") is why: a rule can
// be spelled perfectly and select nothing, and every one of these rules is an
// override of a value the ordinary board already sets, so which one wins IS the
// property under test.

const PAGE_ARTIFACT = '<style>.doc{font:14px system-ui}</style><div class="doc"><h1>Quarterly</h1><p>body</p></div>';

function pageBoard(html = PAGE_ARTIFACT) {
  return createBoard({ title: 'Rendered artifact', blocks: [{ kind: 'html', html }] });
}

/** The rendered page as a live document, plus the pieces every page-board check
 * below reads off it. */
function renderedPage(board) {
  const document = parseHTML(renderBoardPage(board));
  return {
    document,
    body: document.body,
    shell: document.querySelector('.board-shell'),
    head: document.querySelector('.board-head'),
    section: document.querySelector('.html-block'),
    frame: document.querySelector('.html-stage'),
    sendBar: document.querySelector('.send-bar'),
  };
}

/** Every property that could paint a card around the artifact, and the values
 * that mean "no card". Asserting the SHORTHANDS alone (`background`, `border`,
 * `padding`, `box-shadow`) was the version this replaces, and it was blind by
 * construction: the CSS cascade resolves shorthand and longhand independently
 * here, so a later rule re-adding the card as `background-color` / `border-left`
 * / `padding-left` restores a visibly boxed artifact while every shorthand still
 * computes to the page-board override. This asks the question the criterion
 * actually asks -- "is anything painting a box around this?" -- of each property
 * that could answer yes, rather than of the four spellings the fix happened to
 * use. An unset property ('') is fine: nothing means nothing. */
const NO_CARD_PROPERTIES = [
  'background', 'background-color', 'background-image',
  'border', 'border-width', 'border-style',
  'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-shadow',
];
const NO_CARD_VALUES = new Set(['', 'none', '0', '0px', 'transparent', 'initial', 'unset']);

function assertNoCard(el) {
  for (const prop of NO_CARD_PROPERTIES) {
    const value = resolveComputedProperty(styles, el, true, prop).trim();
    assert.ok(NO_CARD_VALUES.has(value),
      `a page board draws no card around the artifact, but '${prop}' computes to '${value}' on the block section`);
  }
}

check('isPageBoard: exactly one html block and nothing else -- a question, a second content block or a failed reference is an ordinary board (ADR.md entry 33)', () => {
  assert.equal(isPageBoard(pageBoard()), true, 'one html block and nothing else is a page board');
  assert.equal(isPageBoard(createBoard({
    title: 'artifact + question',
    blocks: [{ kind: 'html', html: PAGE_ARTIFACT }, { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
  })), false, 'a post carrying a question is an ordinary board');
  assert.equal(isPageBoard(createBoard({
    title: 'artifact + a stats line',
    blocks: [{ kind: 'html', html: PAGE_ARTIFACT }, { kind: 'markdown', text: '12 charts, 3 sections' }],
  })), false, 'any second block is an ordinary board -- which is why the renderer skills drop the stats line');
  assert.equal(isPageBoard(createBoard({
    title: 'two artifacts',
    blocks: [{ kind: 'html', html: PAGE_ARTIFACT }, { kind: 'html', html: PAGE_ARTIFACT }],
  })), false, 'two stages are two blocks, not one page');
  assert.equal(isPageBoard(createBoard({ title: 'no stage', blocks: [{ kind: 'markdown', text: 'hello' }] })), false);
  // A second round makes a second block, so a board only stays a page board for
  // as long as it holds nothing else -- the same rule, not a second one.
  const grown = pageBoard();
  applySubmit(grown, { action: 'send', answers: [], comments: [] }, 1);
  addRound(grown, { blocks: [{ kind: 'question', prompt: 'Any comments?', widget: 'text' }] });
  assert.equal(isPageBoard(grown), false, 'a round that asks something turns a page board back into an ordinary board');
});

check('isPageBoard: a failed reference is never a page board -- there is no stage to fill the viewport with, only an error card', () => {
  const board = pageBoard();
  // The shape src/board.mjs's normalizeBlock leaves behind when a reference does
  // not resolve (the html is gone, an error rides in its place) -- spliced in by
  // hand because amendRound will not mint one (QUIRKS.md "A block's id is
  // kind-locked").
  board.blocks[0] = { ...board.blocks[0], html: '', error: 'cannot read dash.html: no such file' };
  assert.equal(isPageBoard(board), false);
  const html = renderBoardPage(board);
  assert.ok(!html.includes('<body class="page-board">'), 'a board whose only block failed to resolve must render as an ordinary board');
  assert.ok(html.includes('resolve-error'), 'setup failure: the error card is what such a block renders');
});

check('criterion 1: a page board renders the stage edge to edge -- no card, no kicker, no 1120px column, and the header floats over the frame', () => {
  const { document, body, shell, head, section, frame } = renderedPage(pageBoard());
  // The LAYOUT is still one class, which is what the whole stylesheet keys off.
  // 'page-uncommentable' rides alongside it on this fixture and is orthogonal to
  // layout -- it is ADR 46's "a page nobody is listening to is uncommentable",
  // asserted on its own below.
  assert.ok(body.classList.contains('page-board'), 'the layout is one class on <body>, which is what the whole stylesheet keys off');

  // no column
  assert.equal(resolveComputedProperty(styles, shell, true, 'max-width'), 'none', 'the shell must stop being a 1120px column');
  assert.equal(resolveComputedProperty(styles, shell, true, 'padding'), '0', 'and must carry no side gutter, or the frame is not edge to edge');

  // no card: the block's panel, border, radius, padding and hover lift all go
  assertNoCard(section);

  // no kicker, and nothing else printed over the artifact
  assert.equal(document.querySelectorAll('.block-kicker').length, 0, 'a page board renders no kicker at all');
  assert.equal(document.querySelectorAll('.round-label').length, 0, 'nor the "Round 1" chip over a full-viewport artifact');
  assert.equal(document.querySelectorAll('.round-end').length, 0, 'nor the closing rail');

  // the header floats OVER the frame rather than pushing it: a sticky header is
  // in flow, so it would push a 100vh frame down by its own height and leave the
  // artifact's last band below a fold nothing can scroll to (ADR.md entry 40).
  assert.equal(resolveComputedProperty(styles, head, true, 'position'), 'fixed');
  assert.ok(head, 'the header itself stays -- entry 40 changes its position, never its contents');
  assert.ok(document.getElementById('comment-mode-toggle'), 'including the comment-mode toggle');
  assert.ok(document.getElementById('theme-toggle'), 'and the theme control');
  assert.ok(document.getElementById('round-meta'), 'and the state label (ADR.md entry 42 -- the round badge that used to sit beside it is gone)');

  // the frame is still a frame: same section, same nesting, same sandbox
  assert.equal(section.getAttribute('data-block-kind'), 'html');
  assert.equal(frame.parentElement.className, 'stage-wrap');
  assert.ok(frame.parentElement.querySelector('.pin-layer'), 'the pin layer must still sit over the frame');
});

check('criterion 2: the page board stage is a constant 100vh that scrolls internally, and the page itself does not scroll', () => {
  const { body, frame } = renderedPage(pageBoard());
  assert.equal(resolveComputedProperty(styles, frame, true, 'height'), '100vh', 'the frame is a constant viewport height, not a box grown to content');
  assert.doesNotMatch(resolveComputedProperty(styles, frame, true, 'height'), /--stage-p/,
    'and constant means constant through the condense ramp too -- a frame sized on the progress reflows the artifact under the reader');
  assert.equal(resolveComputedProperty(styles, frame, true, 'min-height'), '0', 'the 320px floor is lifted, so the frame is exactly 100vh and nothing else');
  assert.equal(resolveComputedProperty(styles, frame, true, 'resize'), 'none', 'a frame the reviewer can drag taller is a frame whose height changes while it is read');
  assert.equal(resolveComputedProperty(styles, body, true, 'overflow'), 'hidden', 'the board page itself never scrolls -- the artifact scrolls inside its own frame');
  assert.equal(frame.getAttribute('style'), null, 'and nothing is server-rendered into an inline height');
});

check('criterion 3 (markup half): a page board neither strips nor rewrites the artifact -- same srcdoc bytes, same sandbox, reset still leading', () => {
  const board = pageBoard();
  const { frame } = renderedPage(board);
  const srcdoc = frame.getAttribute('srcdoc');
  assert.equal(srcdoc, STAGE_MARGIN_RESET + board.blocks[0].html + stageAgentScript(),
    'the page board must snapshot exactly the bytes an ordinary stage does -- nothing about this layout touches block.html');
  assert.equal(srcdoc.indexOf(STAGE_MARGIN_RESET), 0,
    'the reset must stay LEADING, or it stops hoisting out of body and every dom-anchor ref index shifts by one (renderHtmlBlock\'s own comment)');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts',
    'the artifact\'s own scripts run inside it -- and never with allow-same-origin');
});

check('criterion 6: a post carrying a question, or any second block, renders exactly as a board does today -- column, card, kicker, lens control and send bar', () => {
  const withQuestion = createBoard({
    title: 'artifact + question',
    blocks: [{ kind: 'html', html: PAGE_ARTIFACT }, { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }] }],
  });
  const { document, body, shell, head, frame, sendBar } = renderedPage(withQuestion);
  assert.equal(body.className, '', 'an ordinary board carries no page-board class');
  assert.equal(resolveComputedProperty(styles, shell, true, 'max-width'), '1120px', 'the artifact is back in the column');
  assert.equal(resolveComputedProperty(styles, head, true, 'position'), 'sticky');
  assert.equal(resolveComputedProperty(styles, frame, true, 'height'), '', 'and the stage is back at its ordinary size');
  assert.equal(resolveComputedProperty(styles, frame, true, 'min-height'), '320px');
  assert.ok(document.querySelector('.html-block .block-kicker'), 'the kicker is back');
  assert.ok(document.querySelector('.html-block .expand-btn'), 'and its lens is one click away');
  assert.ok(document.querySelector('.round-label'), 'and the round renders as an ordinary round');
  assert.notEqual(resolveComputedProperty(styles, sendBar, true, 'display'), 'none', 'and the send bar is live, since there is now something to answer');

  // Byte-for-byte identical to what the same board rendered before this feature
  // existed: the ordinary path is not merely "still works", it is untouched.
  const secondBlock = createBoard({ title: 'artifact + note', blocks: [{ kind: 'html', html: PAGE_ARTIFACT }, { kind: 'markdown', text: 'a stats line' }] });
  const ordinary = renderBoardPage(secondBlock);
  assert.ok(ordinary.includes('<body>'), 'a two-block board opens <body> with no class at all');
  assert.ok(ordinary.includes('<div class="block-kicker">HTML stage '), 'and renders the stage in its usual card');
});

check('criterion 11: a page board offers no way to send -- no Send, no Discuss, no unanswered count', () => {
  const { document, sendBar } = renderedPage(pageBoard());
  assert.equal(resolveComputedProperty(styles, sendBar, true, 'display'), 'none',
    'the send bar is hidden the same way body.readonly hides it -- one rule, the whole bar, buttons and pill together');
  // The pill is nested inside the bar so it inherits that, and
  // is separately at zero: a page board asks nothing, so there is no count.
  const pill = document.getElementById('questions-left-pill');
  assert.equal(pill.classList.contains('visible'), false, 'the unanswered count is never shown on a board that asks nothing');
  assert.equal(pill.textContent, '0 questions left');
  assert.equal(document.querySelectorAll('.round-open .question-block').length, 0, 'and there is nothing on the page to answer');
});

check('criterion 25: a page board carries no expand control, and every other stage still carries one', () => {
  const { document } = renderedPage(pageBoard());
  assert.equal(document.querySelectorAll('.expand-btn').length, 0,
    'the lens a page board would open is a copy of what already fills the viewport');
  assert.equal(document.querySelectorAll('.comment-btn').length, 0,
    'and the kicker\'s comment button goes with it -- the click gesture inside the frame is the affordance here');

  // every other stage that has one is unchanged: standalone in a column, and a
  // variant option. (A question's context renders as prose with no kicker at
  // all -- ADR.md entry 26, unrelated to this and untouched by it.)
  const ordinary = parseHTML(renderBoardPage(createBoard({
    title: 'every other stage',
    blocks: [
      { kind: 'html', html: PAGE_ARTIFACT },
      {
        kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
        options: [{ label: 'A', block: { kind: 'html', html: PAGE_ARTIFACT } }],
        context: [{ kind: 'html', html: PAGE_ARTIFACT }],
      },
    ],
  })));
  assert.equal(ordinary.querySelectorAll('.expand-btn').length, 2,
    'the standalone stage and the variant option each keep their own expand control');
});

check('a page board is still a pure function of its board JSON, and still inlines it', () => {
  const board = pageBoard();
  const a = renderBoardPage(board);
  const b = renderBoardPage(JSON.parse(JSON.stringify(board)));
  assert.equal(a, b);
  assert.ok(a.includes('id="board-data"'));
  assert.ok(a.includes(JSON.stringify(board.id)));
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

// --- an html block may carry source: { path }, routed through the -
// --- same resolveRef every other referenced kind uses, path-only ------------------

check('an html source ref renders a stage byte-identical to the same content posted by value', () => {
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

check('lines or section on an html source is refused with a block-level error naming markup slicing, never thrown', () => {
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

check('a referenced html file over the 512 KiB cap is refused as a block-level error, and the board still posts with its other blocks intact', () => {
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

// --- a sent round, on its own page ---------------------------------------
//
// The decision "A board is a session-scoped thread with rounds": a sent round
// stays fully readable and is never a second place to edit the same answer.
// ADR.md entry 42 moved it off the history rail and onto its own page -- what
// is asserted here is the half that did not change: the markup a sent round
// renders, and the disabled state that markup carries.

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

  // The newest round also carries 'round-current': it is the page the board
  // opens on (ADR.md entry 42), and the stylesheet displays only that one.
  assert.ok(/<section class="round round-open round-current" data-round="2" data-round-status="open">/.test(markup));
  assert.ok(markup.includes('Round 2 question'), 'the still-open round must render live on the page the board opens on');
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
  const historySection = /<section class="round round-history"[\s\S]*?<section class="round round-open/.exec(html)[0];
  // Ablation: rendering the round-1 widgets without `historical` (i.e. always
  // passing `false`) leaves this identical to the open-round markup and fails here.
  assert.ok(historySection.includes('disabled'), 'a sent round\'s answer controls must be disabled in the markup');
  assert.ok(/class="card-choice choice-single selected"[^>]*disabled/.test(historySection) || /disabled[^>]*class="card-choice choice-single selected"/.test(historySection));
});

check('a history round\'s comment form is disabled too, on every CONTENT block kind -- not just markdown', () => {
  // commentArea() didn't originally take `historical` at all, so a
  // fresh page load of a board with a sent round left every comment form fully
  // live even though the round's answer controls were correctly disabled --
  // divergent from what the client-side collapse (markRoundHistory) already did.
  // Covers both commentable kinds, since renderBlock threads `historical` into
  // each one's commentArea call. `question`/`compare` are deliberately not fixture
  // blocks (ADR.md entry 28) and neither are `markdown`/`code` any more (entry 28):
  // none of the four carries a commentArea at all, so none would prove anything
  // about historical-threading here.
  const board = createBoard({
    title: 'Comment form disabled',
    blocks: [
      { kind: 'mermaid', text: 'flowchart LR\n  A --> B' },
      { kind: 'html', html: '<div class="mock"></div>' },
    ],
  });
  applySubmit(board, { action: 'send', answers: [], comments: [] }, 1);
  addRound(board, { blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  C --> D' }] });

  const html = renderBoardPage(board);
  const historySection = /<section class="round round-history"[\s\S]*?<section class="round round-open/.exec(html)[0];
  const commentForms = [...historySection.matchAll(/<form class="comment-form"[\s\S]*?<\/form>/g)];
  assert.equal(commentForms.length, 2, 'both blocks in the sent round must carry a comment form');
  for (const [form] of commentForms) {
    assert.ok(/<input type="text" placeholder="Add a comment" disabled>/.test(form), `comment input must be disabled in a history round:\n${form}`);
    assert.ok(/<button type="submit" disabled>Add<\/button>/.test(form), `comment submit must be disabled in a history round:\n${form}`);
  }

  // and the still-open round's comment forms stay fully live
  const openSection = html.slice(html.indexOf('<section class="round round-open'));
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
  // ADR.md entry 63 brought the per-row wrapping back, but for a
  // different reason than ADR.md entry 28 deleted the old `.code-line` anchor
  // spans for: `.code-row` carries the AC 7 gutter number (a `data-line`
  // attribute, never a text node -- see test/check-pure.mjs's own dedicated
  // rendering-ticket-02 section below for the copy-fidelity proof), not a comment
  // anchor. `const` and `1` are highlighted (javascript is a vendored grammar).
  assert.ok(markup.includes(
    '<pre><code><span class="code-row" data-line="1">'
    + '<span class="tok-keyword">const</span> x = <span class="tok-number">1</span>;</span></code></pre>',
  ));
  assert.ok(!markup.includes('code-line'), 'a code block must emit no OLD-style per-line anchor spans (ADR.md entry 28)');
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
// this ADR entry, on a block that renders nothing at all.

check('a question block renders no comment button, no comment form, no comment area, and no page-scoped pin-layer', () => {
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

check('a compare block renders no comment button, no comment form, no comment area, and no page-scoped pin-layer on the wrapper -- only its two nested sides may carry one', () => {
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

check('ADR.md entry 28: mermaid and html keep their comment button, form and pin-layer; markdown and code carry none of it', () => {
  const board = createBoard({
    title: 'Only the rendered kinds keep their button',
    blocks: [
      { kind: 'markdown', text: '# Prose' },
      { kind: 'mermaid', text: 'flowchart LR\n  A --> B' },
      { kind: 'html', html: '<div class="mock"></div>' },
      { kind: 'code', text: 'const x = 1;', lang: 'javascript' },
    ],
  });
  const [mdId, mermaidId, htmlId, codeId] = board.blocks.map(b => b.id);
  const markup = renderedMarkup(renderBoardPage(board));

  for (const id of [mermaidId, htmlId]) {
    assert.ok(markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `expected a whole-block comment button for ${id}`);
    assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${id}"`), `expected a comment-form for ${id}`);
    assert.ok(markup.includes(`id="comment-target-${id}"`), `expected a comment-target for ${id}`);
    assert.ok(markup.includes(`id="comment-list-${id}"`), `expected a comment-list for ${id}`);
  }
  for (const id of [mdId, codeId]) {
    assert.ok(!markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `a markdown/code block must render no comment button (${id})`);
    assert.ok(!markup.includes(`comment-form-${id}`), `a markdown/code block must render no comment form (${id})`);
    assert.ok(!markup.includes(`comment-target-${id}`), `a markdown/code block must render no comment target (${id})`);
    assert.ok(!markup.includes(`comment-list-${id}`), `a markdown/code block must render no comment list (${id})`);
    const section = markup.slice(markup.indexOf(`data-block-id="${id}"`));
    assert.ok(!section.slice(0, section.indexOf('</section>')).includes('class="pin-layer"'),
      `a markdown/code block's own section must carry no page-scoped pin-layer (${id})`);
  }
});

check('the whole-block comment button still opens the comment form when a content block has nothing to point at -- a failed reference, and an empty stage', () => {
  // A reference that failed to resolve renders a .resolve-error note instead of
  // content, but the button/form survive -- they live in the kicker/commentArea,
  // outside the `block.error` branch. Checked on `mermaid` rather than `code`:
  // ADR.md entry 28 leaves a code block no button to survive with.
  const board = createBoard({
    title: 'Blank content, button still works',
    cwd: fixturesDir,
    blocks: [
      { kind: 'mermaid', source: { path: 'does-not-exist.mmd' } },
      { kind: 'html', html: '' }, // a stage that came up blank
    ],
  });
  const diagramId = board.blocks[0].id;
  const htmlId = board.blocks[1].id;
  const markup = renderedMarkup(renderBoardPage(board));

  assert.ok(markup.includes('class="resolve-error"'), 'setup failure: the mermaid block must have failed to resolve');
  assert.ok(markup.includes(`data-block-id="${diagramId}" data-anchor-kind="block"`), 'a mermaid block with a failed reference must still render its whole-block comment button');
  assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${diagramId}"`), 'and still render the form that button opens');

  assert.ok(markup.includes(`data-block-id="${htmlId}" data-anchor-kind="block"`), 'an html block with a blank stage must still render its whole-block comment button');
  assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${htmlId}"`), 'and still render the form that button opens');
});

check('a rendered kind nested inside a question\'s context or a compare side keeps its own comment button and form -- and a markdown one in the same slot keeps none', () => {
  const board = createBoard({
    title: 'Nested blocks are judged on their own kind',
    blocks: [
      {
        kind: 'question',
        prompt: 'Ship it?',
        widget: 'single',
        options: [{ label: 'Yes' }],
        context: [
          { kind: 'html', html: '<div class="mock"></div>' },
          { kind: 'markdown', text: '# Context' },
        ],
      },
      {
        kind: 'compare',
        left: { label: 'Before', block: { kind: 'mermaid', text: 'flowchart LR\n  A --> B' } },
        right: { label: 'After', block: { kind: 'code', text: 'const x = 1;', lang: 'javascript' } },
      },
    ],
  });
  const contextStageId = board.blocks[0].context[0].id;
  const contextProseId = board.blocks[0].context[1].id;
  const leftId = board.blocks[1].left.block.id;
  const rightId = board.blocks[1].right.block.id;
  const markup = renderedMarkup(renderBoardPage(board));

  // ADR.md entry 28 draws the rule on kind, never on position: these two are as
  // commentable nested as they would be at the top level.
  for (const id of [contextStageId, leftId]) {
    assert.ok(markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `expected a whole-block comment button for nested block ${id}`);
    assert.ok(markup.includes(`<form class="comment-form" id="comment-form-${id}"`), `expected a comment-form for nested block ${id}`);
  }
  // ...and these two are as inert nested as they would be at the top level.
  for (const id of [contextProseId, rightId]) {
    assert.ok(!markup.includes(`data-block-id="${id}" data-anchor-kind="block"`), `a nested markdown/code block must render no comment button (${id})`);
    assert.ok(!markup.includes(`comment-form-${id}`), `a nested markdown/code block must render no comment form (${id})`);
  }
});

// --- numbered pins on the element, in html-stage and mermaid blocks ----

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

// --- the element-level gesture's discoverability lives in the toggle alone ----
//
// The wiring was correct and unusable, so a
// permanent hint line was added to each stage's kicker. It was deleted again:
// a four-option `choose-between-rendered-variants` question repeated that line once
// per option, in the place vertical space is scarcest, saying what the comment-mode
// toggle was already made visible chrome to say. Nothing replaces it -- the toggle
// carries discoverability alone now, on both stage kinds and in both page states.

check('neither stage kind renders a hint in its kicker, and the stylesheet defines no .stage-hint rule at all', () => {
  const board = createBoard({
    title: 'Stage affordances',
    blocks: [
      { kind: 'html', html: '<div class="mock"><button>Send</button></div>' },
      { kind: 'mermaid', text: 'flowchart LR\n  A[Start] --> B[End]' },
    ],
  });
  const page = renderBoardPage(board);
  const markup = renderedMarkup(page);

  // Each kicker carries no hint -- inverted from "the kicker carries the hint".
  const htmlKicker = /<div class="block-kicker">HTML stage.*?<\/div>/s.exec(markup);
  const mermaidKicker = /<div class="block-kicker">Mermaid.*?<\/div>/s.exec(markup);
  assert.ok(htmlKicker && !htmlKicker[0].includes('stage-hint'), 'the html-stage kicker must carry no hint');
  assert.ok(mermaidKicker && !mermaidKicker[0].includes('stage-hint'), 'the mermaid kicker must carry no hint');

  // Not merely hidden in a read-only archive any more -- the rule itself is gone,
  // so there is nothing left for `body.readonly` to override.
  assert.ok(!page.includes('.stage-hint'), 'the stylesheet must define no .stage-hint rule at all');
});

check('a mermaid node highlights under the cursor, and an html stage gets the same affordance injected into its own document', () => {
  // Mermaid renders into the page's own DOM, so the page stylesheet can reach it.
  // Gated on body.comment-mode too, same as everything else this
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

  // The html stage is now a genuinely cross-origin iframe (no
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

// --- the sent-comment visual inertness fix (html-stage half) -----------------
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

  // The broadcast to every wired stage, which happens on every mode toggle and
  // not just at ready time -- turning mode ON is exactly the moment the stage's
  // hover starts mattering. It lives in broadcastStageMode rather than inline in
  // setCommentMode because a THEME change sends the identical
  // message, and two copies of it could ship different shapes; asserted here
  // through both hops, so neither the payload nor the delegation can be dropped
  // without failing.
  const broadcastBody = namedFunctionBody(ui, 'broadcastStageMode');
  assert.ok(broadcastBody, 'broadcastStageMode not found');
  assert.match(broadcastBody, /sentRefs:\s*blockId \? sentDomRefsForBlock\(blockId\) : \[\]/,
    'the broadcast to every wired stage must carry that stage\'s own sentRefs');
  assert.match(broadcastBody, /theme:\s*activeTheme\(\)/,
    'and the theme it must now paint itself in');
  const setModeBody = namedFunctionBody(ui, 'setCommentMode');
  assert.ok(setModeBody, 'setCommentMode not found');
  assert.match(setModeBody, /broadcastStageMode\(\)/,
    'setCommentMode must still reach every wired stage, now through that one shared broadcast');

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
  // The lost tag names the stored hint ("Launch"), not the opaque
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

// ADR.md entry 26: this board's context carries an 'html' block, so the question
// carries a rendered stage and renders full width -- context stacks as prose
// inside .question-main (.question-context-prose), never the .question-context
// card. See the "full width, context as prose" block below for the stage-free
// counterpart, which still gets the old .question-context card unchanged.
check('a question carrying non-markdown context kinds normalises and renders them inline, as prose once one of them is a rendered stage', () => {
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
  assert.ok(!markup.includes('class="question-context"'), 'a stage-carrying question must not render the .question-context card');
  assert.ok(markup.includes('class="question-context-prose"'));
  assert.ok(markup.includes('<pre class="mermaid">flowchart TD'));
  assert.ok(markup.includes('class="html-stage"'));
});

// --- ADR.md entry 26: full width, context as prose ---------------------------
//
// See the decision "The full-width rule keys on the presence of a
// rendered stage, not on the widget" and ADR.md entry 26. Two changes, one
// condition (src/render.mjs's questionCarriesStage): a question whose options
// or context carry a rendered stage (an 'html' block, whole or nested inside a
// 'compare' side) drops its .question-context card and renders context as bare
// prose inside .question-main instead -- no .block card, no .block-kicker, no
// comment button/form/pin-layer on the context items themselves. A question
// with no stage anywhere renders exactly as it did before this entry: unchanged.

check('a question whose CONTEXT carries a rendered stage renders full width -- no .question-context card, no second grid column', () => {
  const board = createBoard({
    title: 'Stage in context',
    blocks: [{
      kind: 'question',
      prompt: 'Does this mock look right?',
      widget: 'single',
      options: [{ label: 'Yes' }, { label: 'No' }],
      context: [{ kind: 'html', html: '<button>Ship</button>' }],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(!markup.includes('class="question-context"'), 'must not render the two-column card wrapper');
  assert.ok(markup.includes('class="question-context-prose"'), 'must render the prose wrapper instead');
  assert.ok(markup.includes('class="html-stage"'), 'the stage itself must still render');
});

check('a question whose OPTIONS carry a rendered stage (choose-between-rendered-variants) ALSO renders full width when it has unrelated context too', () => {
  const board = createBoard({
    title: 'Stage in options, plain context',
    blocks: [{
      kind: 'question',
      prompt: 'Which mock is right?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'A', block: { kind: 'html', html: '<p>a</p>' } },
        { label: 'B', block: { kind: 'html', html: '<p>b</p>' } },
      ],
      context: [{ kind: 'markdown', text: 'Some code excerpt as context.' }],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(!markup.includes('class="question-context"'), 'the rule keys on the stage in OPTIONS, not on what kind the context happens to be');
  assert.ok(markup.includes('class="question-context-prose"'));
});

check('negative case: a question with NO rendered stage anywhere -- in options or context -- is genuinely unaffected and keeps the .question-context card (ablation: this must fail if questionCarriesStage or the branch reading it is ever deleted in favour of "always full width")', () => {
  const board = createBoard({
    title: 'No stage anywhere',
    blocks: [{
      kind: 'question',
      prompt: 'Ship it?',
      widget: 'single',
      options: [{ label: 'Yes' }, { label: 'No' }],
      context: [{ kind: 'markdown', text: 'Some prose context, no mock.' }],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('class="question-context"'), 'a stage-free question must keep today\'s .question-context card');
  assert.ok(!markup.includes('class="question-context-prose"'), 'and must never render the prose wrapper');
  // The card still goes through the ordinary renderBlock path -- kicker, comment
  // button and all -- exactly as it did before this entry.
  assert.ok(markup.includes('Markdown'), 'the nested block\'s own kicker label must still render, unaffected');
});

check('a stage nested inside a compare side, inside a question\'s context, also counts as a rendered stage (blockCarriesStage recurses into compare)', () => {
  const board = createBoard({
    title: 'Stage inside compare inside context',
    blocks: [{
      kind: 'question',
      prompt: 'Before or after?',
      widget: 'single',
      options: [{ label: 'Before' }, { label: 'After' }],
      context: [{
        kind: 'compare',
        left: { label: 'Before', block: { kind: 'markdown', text: 'old copy' } },
        right: { label: 'After', block: { kind: 'html', html: '<p>new mock</p>' } },
      }],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(!markup.includes('class="question-context"'), 'a stage nested inside a compare side must still trigger full width');
  assert.ok(markup.includes('class="question-context-prose"'));
  assert.ok(markup.includes('class="compare-grid"'), 'the compare\'s own side-by-side grid is untouched, out of scope');
  assert.ok(markup.includes('class="html-stage"'));
});

check('a stage-carrying question\'s context renders no card, no border-carrying wrapper, and no kicker -- only prose, above the options', () => {
  const board = createBoard({
    title: 'No card, no kicker',
    blocks: [{
      kind: 'question',
      prompt: 'Read this note, then pick.',
      widget: 'single',
      options: [{ label: 'A' }, { label: 'B' }],
      context: [
        { kind: 'markdown', text: 'A short note.' },
        { kind: 'html', html: '<p>the mock</p>' },
      ],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const sectionStart = markup.indexOf('<section class="block question-block"');
  const sectionEnd = markup.indexOf('</section>', sectionStart) + '</section>'.length;
  const section = markup.slice(sectionStart, sectionEnd);

  // Scoped to the context prose region alone -- the question's OWN top-level
  // kicker ("Question · single") legitimately keeps .block-kicker, so the
  // absence check has to look only between the prose wrapper and the options,
  // not across the whole section.
  const contextIdx = section.indexOf('question-context-prose');
  const optionsIdx = section.indexOf('class="options"');
  assert.ok(contextIdx !== -1 && optionsIdx !== -1 && contextIdx < optionsIdx, 'setup failure: must find both markers in order');
  const contextRegion = section.slice(contextIdx, optionsIdx);

  // No card, no border-carrying wrapper, no kicker label anywhere in the context
  // prose -- the markdown context's own "Markdown" kicker text (which the
  // pre-existing renderBlock path would have emitted) must be entirely absent.
  assert.ok(!contextRegion.includes('block-kicker'), 'no .block-kicker inside the context prose');
  assert.ok(!contextRegion.includes('>Markdown<'), 'no "Markdown" kicker label for the context markdown item');
  assert.ok(!contextRegion.includes('class="block '), 'no .block card wrapper on a context item');

  // The comment affordance is scoped per ITEM, by kind. This check used to assert
  // "no comment-btn, no comment-form anywhere in the context prose", which was
  // ADR.md entry 26's "no comment control" read across every kind at once. Entry
  // 28 supersedes that half of 26: the rule is drawn on kind and never on
  // position, so the html item here keeps the affordance it has everywhere else,
  // and the markdown item beside it keeps none. The words -- "no
  // card, no border, no kicker" -- are asserted above and are untouched by that:
  // a comment button is none of the three.
  const proseItem = markdownContextId => {
    const start = contextRegion.indexOf(`data-block-id="${markdownContextId}"`);
    assert.ok(start !== -1, `setup failure: no context item for ${markdownContextId}`);
    const next = contextRegion.indexOf('class="context-item', start);
    return contextRegion.slice(start, next === -1 ? contextRegion.length : next);
  };
  const mdItem = proseItem(board.blocks[0].context[0].id);
  const stageItem = proseItem(board.blocks[0].context[1].id);
  assert.ok(!mdItem.includes('comment-btn'), 'no whole-block comment button on a markdown context item');
  assert.ok(!mdItem.includes('comment-form-'), 'no comment form on a markdown context item');
  assert.ok(!mdItem.includes('pin-layer'), 'no pin layer on a markdown context item');
  assert.ok(stageItem.includes('comment-btn'), 'an html stage in a question\'s context keeps its comment button (ADR.md entry 28)');
  assert.ok(stageItem.includes(`comment-form-${board.blocks[0].context[1].id}`), 'and its own comment form');

  // Prose, positioned between the prompt and the options.
  const promptIdx = section.indexOf('question-prompt');
  assert.ok(promptIdx < contextIdx && contextIdx < optionsIdx, 'context prose must sit under the prompt and above the options');
});

check('a code block in a stage-carrying question\'s context renders as plain prose -- no per-line anchor spans, no comment affordance, and no ReferenceError on the way', () => {
  // The prose context path is the one place `code` is rendered by something
  // other than renderCodeBlock. When ADR.md entry 28 deleted renderCodeLines it
  // was still being CALLED from there, so this whole branch threw
  // "renderCodeLines is not defined" -- unreachable from every other fixture in
  // the suite, because a code context item only reaches it alongside a stage.
  const board = createBoard({
    title: 'Code beside a stage',
    blocks: [{
      kind: 'question',
      prompt: 'Does the mock match the snippet?',
      widget: 'single',
      options: [{ label: 'Yes' }, { label: 'No' }],
      context: [
        { kind: 'html', html: '<p>the mock</p>' },
        { kind: 'code', text: 'const x = 1;\nconst y = 2;', lang: 'javascript' },
      ],
    }],
  });
  const codeId = board.blocks[0].context[1].id;
  let markup;
  assert.doesNotThrow(() => { markup = renderedMarkup(renderBoardPage(board)); },
    'a code block in a stage-carrying question\'s context must render at all');

  assert.ok(markup.includes('class="question-context-prose"'), 'setup failure: this fixture must take the prose context path');
  assert.ok(markup.includes('<pre><code>const x = 1;\nconst y = 2;</code></pre>'), 'the snippet renders as plain escaped text');
  assert.ok(!markup.includes('code-line'), 'no per-line anchor spans anywhere (ADR.md entry 28)');
  assert.ok(!markup.includes(`comment-form-${codeId}`), 'a code context item carries no comment form');
  assert.ok(!markup.includes(`data-block-id="${codeId}" data-anchor-kind="block"`), 'and no comment button');
});

// --- snapshot and standalone archive ------------------------------------
//
// See the decisions "JSON is truth, the page is a projection" and
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

// --- standalone read-only archive ----------------------------------------
//
// Chrome-automated checks of the interactive layer are out of scope,
// so this is a structural check on the shipped mechanism rather than a
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
  // Exactly four fetches, all accounted for: the ordinary send bar's submit,
  // the resync that catches this client up on anything broadcast while it was
  // disconnected, submitPageRound's own submit -- a second POST to the same
  // route, since an awaited page round's Send control names its OWN round
  // rather than sharing submitBoard's openRoundNumber()-targeted path (ticket
  // 01's own note left for this one) -- and (ADR.md entry 58) reportAttended's
  // POST to /attended, the tab telling the daemon whether it is being looked
  // at. Any fifth is a
  // network call nobody has justified -- in particular, mode detection must
  // never become a probe to the daemon.
  const fetchCalls = [...ui.matchAll(/fetch\(([^)]*)/g)].map(m => m[1]);
  assert.equal(fetchCalls.length, 4, `expected exactly the two submit fetches, the resync and the attended report, found ${fetchCalls.length}`);
  const submitCalls = fetchCalls.filter(c => c.includes('/submit'));
  assert.equal(submitCalls.length, 2, 'both submitBoard and submitPageRound must post to /submit');
  assert.ok(fetchCalls.some(c => c.includes("'/b/'")), 'one fetch must be the resync read of the board');
  assert.ok(fetchCalls.some(c => c.includes('/attended')), 'one fetch must be the attended report');
  // All four live behind a readonly guard: the standalone file:// archive is
  // network-free, period.
  assert.match(namedFunctionBody(ui, 'resync'), /if \(readonly\) return;/);
  assert.match(namedFunctionBody(ui, 'submitPageRound'), /^\s*if \(readonly\) return;/);
  assert.match(namedFunctionBody(ui, 'reportAttended'), /if \(readonly \|\| !attendedWatcherId\) return;/);
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

// --- the click-to-comment gesture must be inert in read-only mode, ---
// exactly like every other mutating listener above, and pin rendering (which is
// what makes an archived board still show its pins) must NOT be gated on it.

check('the html-stage and mermaid element-click listeners guard on readonly too, so click-to-comment is inert in read-only mode', () => {
  const bodies = listenerBodies(ui);
  const anchorClickBodies = bodies.filter(b => /openCommentForm\(/.test(b));
  // 4 listeners open a comment form: .comment-btn, the
  // html-stage click, the mermaid click, and the generic comment-mode click.
  // The html-stage one now sits behind a postMessage dispatch --
  // `openCommentForm(` no longer appears literally inside an
  // `addEventListener` callback for that case, only inside the named
  // `handleStageClick` helper the single `message` listener calls. The same was
  // done to the mermaid one, for the same kind of reason:
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

  // The mermaid half. One minting function, and every
  // listener that reaches it carries the same readonly guard the inline mermaid
  // listener used to carry on its own -- including the lens's, which is the
  // whole of "the comment gesture inside it is gated exactly like every other
  // comment gesture".
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

  // The html-stage case no longer has one function with an
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

// --- the lens's pointer capture ---------------------
//
// Asserted structurally, and only because the behaviour is genuinely out of
// reach here: there is no such thing as pointer capture in this repo's DOM
// stand-in, so a check that drives the lens there cannot tell the two versions
// apart. It is not a hypothetical -- it was MEASURED in Chrome. Taking the
// capture on 'pointerdown' makes the browser retarget
// everything after it, the resulting 'click' included, at the capture element,
// so the lens's click handler saw '.lens-stage' instead of the diagram node the
// pointer was over and clicking a node in the lens silently did nothing, with
// every check in test/check-mermaid-anchor.mjs green. Same precedent as
// before: the shape is pinned here, the behaviour rests
// on the in-browser drive.
//
// The limit of this check, stated rather than left to be discovered a second
// time: it constrains the ORDER of two lines and nothing else. It passed
// throughout the period when the threshold those lines sit behind measured the
// wrong quantity entirely (`drag.x/y` reassigned every move, so
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

// --- SSE push is applied additively, never a wholesale re-render -----
//
// Field preservation on a push is browser-DOM behaviour, which is
// explicitly out of automated scope ("checked by opening a
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
  // Real bug found and fixed: wireRoot(container) / wireRoot(roundSection)
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

// --- element-level anchoring must be wired on -----
// content that arrives over a push, not just on what was on the page at hydrate.
//
// Before this merge, the html-stage wiring was a separate, unscoped,
// run-once-at-load pass (`qsa('.html-stage')`, no root, executed exactly once
// right after hydrate) -- correct for round 1, but silently inert for any html
// or mermaid stage that arrives in a round pushed later over SSE, since nothing
// ever re-ran that pass. Folding it into wireRoot(root), scoped to root exactly
// like every other wiring loop, is what makes anchoring keep working after a
// push. The two checks below prove this end to end without a browser: the first
// proves anchoring wiring genuinely lives inside wireRoot (not bolted on as a
// second, separate pass); the second proves every DOM-insertion branch that
// handles a push actually calls wireRoot on the content it just inserted. Neither
// fact alone is sufficient -- the push code could wire a subtree that
// never wires anchors, or the anchoring wiring could live somewhere a push never
// reaches -- so both need to hold, and did not both hold on either side of this
// merge before it was resolved this way.

check('element-level anchoring on a pushed html stage needs no per-push wiring pass at all -- a page-level, push-agnostic message listener replaced the root-scoped DOM wiring this check used to require', () => {
  // Previously: `wireHtmlStage` reached into `frame.contentDocument`
  // directly, so a pushed stage had to be found and wired EXPLICITLY, inside
  // wireRoot, scoped to whatever subtree a push actually inserted -- an
  // unscoped, run-once-at-load pass was silently inert for anything pushed
  // later (see this section's own header comment on the merge
  // this check was originally written to prove). Dropping
  // `allow-same-origin` makes that direct reach impossible now regardless of
  // scoping -- and, structurally, unnecessary: a stage's own agent script
  // announces itself 'ready' the moment it runs, wherever/whenever its
  // iframe ends up in the document, and ONE page-level
  // `window.addEventListener('message', ...)` (registered once, never
  // inside wireRoot, never re-registered per push) reacts to it. So the
  // property this check now proves is the opposite shape of before: there is
  // NO root-scoped html-stage wiring loop left inside wireRoot to find (an
  // ablation that reintroduced one would be regressing toward the old
  // architecture, not fixing anything), and exactly one page-level
  // message listener exists, declared outside wireRoot.
  const wireRootBody = namedFunctionBody(ui, 'wireRoot');
  assert.ok(wireRootBody, 'wireRoot not found');
  assert.ok(
    !wireRootBody.includes("qsa('.html-stage'"),
    'wireRoot must not contain an html-stage-specific wiring loop any more -- a page-level message listener replaced it; a match here means the old, contentDocument-reaching architecture crept back in',
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
  // that's asked for over a structural one like
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
  // Real bug found and fixed: a replace-amend re-renders the block
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

// This check used to read "the emitted page has no external script or stylesheet
// reference -- everything needed to open standalone is inlined", and rejected any
// `<link rel=stylesheet>` or `<script src=>` outright (QUIRKS.md, "No external assets —
// not even mermaid, now three bare sibling filenames"). ADR 70 supersedes that rule: a
// page now REFERENCES the shared script and stylesheet rather than carrying 438KB of
// byte-identical copies of them. What replaces it is narrower and stricter -- the
// reference must be a BARE SIBLING FILENAME, which is the single form that resolves
// identically from a page served at `/b/<id>` and from the same bytes double-clicked in
// Finder. An absolute path, a URL, a protocol-relative
// `//host/x` or a subdirectory would each break the Finder surface (AC 9), so each is
// still a failure here; that is what this check now defends.
/** Every subresource a document's markup pulls, by the attribute the browser would
 * fetch. Navigation hrefs (the back-to-index `<a href="/">`) are deliberately not in
 * this set: they are not loads, and they are allowed to be absolute. */
function subresourceRefs(html) {
  const refs = [];
  for (const [, tag, attrs] of html.matchAll(/<(link|script|img|iframe)\b([^>]*)>/g)) {
    const m = attrs.match(/\s(?:src|href)="([^"]*)"/);
    if (m) refs.push({ tag, ref: m[1] });
  }
  return refs;
}

/** ADR 70's rule itself, in ONE place: the emitted page and an html stage's `srcdoc`
 * are held to the identical standard, since both resolve against the same base URL and
 * both have to work from Finder. */
function assertBareSiblingRef(tag, ref, where) {
  // A `data:` URL carries its own bytes, so it is self-contained by definition -- that is
  // the favicon (src/styles.mjs's faviconLink), and it stays allowed.
  if (ref.startsWith('data:')) return;
  assert.ok(ASSET_NAME.test(ref),
    `${where}: <${tag}> loads "${ref}", which is not a bare content-addressed sibling filename -- ` +
    'an absolute path, a URL, a protocol-relative reference or a subdirectory all fail to ' +
    'resolve when the page is opened from Finder (ADR 70)');
  assert.ok(!ref.includes('/') && !ref.includes(':') && !ref.startsWith('.'),
    `${where}: <${tag}> loads "${ref}", which is not bare: no separator, no scheme, no dot segment`);
}

check('the emitted page references the shared script and stylesheet as BARE SIBLING FILENAMES, and nothing else external', () => {
  const board = createBoard({
    title: 'Standalone',
    blocks: [{ kind: 'markdown', text: '# A' }, { kind: 'question', prompt: 'Q', widget: 'single', options: [{ label: 'X' }] }],
  });
  const html = renderBoardPage(board);

  const refs = subresourceRefs(html);
  assert.ok(refs.length >= 3, `setup failure: expected at least the favicon, the stylesheet and the script, found ${refs.length}`);

  for (const { tag, ref } of refs) assertBareSiblingRef(tag, ref, 'the page');

  // And the two it must name are the real content-addressed ones, not some spelling that
  // merely looks like one. (Ablation: hardcode a name in render.mjs and this fails the
  // moment the payload changes, which is exactly the drift the hash exists to catch.)
  assert.ok(html.includes(`<link rel="stylesheet" href="${STYLE_ASSET}">`), 'the page must name the current stylesheet asset');
  assert.ok(html.includes(`<script defer src="${SCRIPT_ASSET}"></script>`), 'the page must name the current script asset');

  // Deferred CLASSIC script, never a module: Chrome CORS-blocks a module script over
  // `file:`, so `type="module"` here silently kills the Finder surface. `defer` is what
  // keeps the execution timing a module tag already had (after parse, before
  // DOMContentLoaded), which two `document.readyState === 'complete'` branches in
  // src/ui.mjs read.
  assert.ok(!/<script[^>]*\btype="module"[^>]*\bsrc=/.test(html), 'the shared script must not be referenced as a module');

  // The board JSON is still inlined -- it is per-board, so it has nothing to share.
  assert.ok(html.includes('id="board-data"'));

  // And the payloads themselves are genuinely gone from the bytes, which is the weight
  // half of AC 8: naming the file while still carrying it would pass every assertion above.
  assert.ok(!html.includes(ui), 'the page must not still carry the client script');
  assert.ok(!html.includes(styles), 'the page must not still carry the stylesheet');
});

// An html stage's `srcdoc` is a second document inside the first, and since the board
// began providing its vendored mermaid engine to diagram-bearing stages, it is a
// document that names a subresource of its own. The rule above applies to it unchanged
// and for the same two reasons: a `srcdoc` frame inherits its parent's base URL, so a
// bare filename resolves to `/b/<name>` served and to the file beside the archive from
// Finder, and nothing else resolves on both. This is the check that blesses that one
// form -- and refuses every other spelling of it.
check('an html stage\'s srcdoc names subresources by the SAME bare-sibling rule the page does', () => {
  const board = createBoard({
    title: 'Stage with a diagram',
    blocks: [
      { kind: 'html', html: '<div class="doc"><pre class="mermaid">flowchart LR\n  A --> B</pre></div>' },
      { kind: 'markdown', text: 'not a page board' },
    ],
  });
  const html = renderBoardPage(board);
  const srcdocs = [...html.matchAll(/srcdoc="([^"]*)"/g)].map(m => m[1]);
  assert.equal(srcdocs.length, 1, `setup failure: expected exactly one stage, found ${srcdocs.length}`);

  // What the browser hands the srcdoc parser: the attribute value, entity-decoded.
  // `&amp;` last, mirroring the order src/render.mjs's own escaper applies.
  const stageDoc = srcdocs[0]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  const refs = subresourceRefs(stageDoc);
  assert.equal(refs.length, 1, `a diagram-bearing stage pulls exactly the engine, found ${JSON.stringify(refs)}`);
  for (const { tag, ref } of refs) assertBareSiblingRef(tag, ref, 'a stage srcdoc');
  assert.equal(refs[0].ref, MERMAID_ASSET, 'and it is the real content-addressed engine, not a spelling that resembles one');

  // The rule is only worth having if the shapes it forbids actually fail it. Each of
  // these resolves fine served and to nothing at all from Finder, which is exactly the
  // asymmetry that makes an archive look like it works until the network is off.
  for (const bad of ['/b/mermaid-0123456789abcdef.js', 'assets/mermaid-0123456789abcdef.js',
    '//cdn.example/mermaid-0123456789abcdef.js', 'https://cdn.example/mermaid.min.js',
    './mermaid-0123456789abcdef.js', '../mermaid-0123456789abcdef.js']) {
    assert.throws(() => assertBareSiblingRef('script', bad, 'ablation'),
      `"${bad}" must fail the bare-sibling rule, and does not`);
  }

  // And a stage with no diagram in it names nothing at all -- the marker is what
  // decides, so a diagram-free board's bytes are exactly what they were.
  const plain = renderBoardPage(createBoard({
    title: 'Stage with no diagram',
    blocks: [{ kind: 'html', html: '<div class="doc"><button>Send</button></div>' }, { kind: 'markdown', text: 'x' }],
  }));
  const plainSrcdoc = [...plain.matchAll(/srcdoc="([^"]*)"/g)].map(m => m[1])[0];
  assert.ok(plainSrcdoc, 'setup failure: no stage rendered');
  assert.equal(subresourceRefs(plainSrcdoc.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')).length, 0,
    'a diagram-free stage must pull nothing');
  assert.doesNotMatch(plain, /mermaid-[0-9a-f]{16}\.js/, 'and the page must not name the engine anywhere');
});

// =================================================================================
// Regressions. Each check below fails without its fix; the
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
  // block's answer, and round 1's page renders a question with no answer.
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

// --- the reference allowlist (ADR.md entry 3) -------
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
 * variable, so the end-to-end half of this rule has to go through it rather than
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

check('a referenced html path outside cwd and every allowlisted root is refused as a block-level error, on the same terms as any other kind\'s ref', () => {
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

// --- that boundary, further hardening (S1-S4, S7-S9) ------------------------
//
// Everything above asserts the allowlist does what ADR.md entry 3 says. Everything
// below asserts the things it turned out to ALSO do. Each check names the finding it
// closes and the ablation that reopens it.

check('S1/S3: an absent CLAUDE_BOARD_REF_ROOTS grants nothing, and the default is three directories rather than all of ~/.claude', () => {
  // S3, the delivery question. Every install predating ADR.md entry 3 has a plist with
  // no CLAUDE_BOARD_REF_ROOTS key, and on the degraded, no-launcher path bin/daemon.mjs
  // runs straight out of the clone (QUIRKS.md "A bare `kickstart` no longer picks up a
  // source edit — only `./install.sh` does", whose parenthetical carries that exception).
  // A default compiled in HERE therefore goes live on those machines during a routine
  // `git pull` -- a read boundary widening with no reinstall, nothing printed and nobody
  // asked. So absent grants
  // nothing and install.sh writes the default, which makes running the installer the
  // consent event. Ablation: default to ~/.claude (or to DEFAULT_REF_ROOTS) here and
  // this goes red while every existing install silently gains reference roots.
  assert.deepEqual(withRefRoots(undefined, () => resolveRefRoots(process.env.CLAUDE_BOARD_REF_ROOTS)), []);
  assert.deepEqual(resolveRefRoots(''), [], 'an explicitly empty value means the same thing');

  // S1, the scope question, decided by the ADR's own justification: "render the skill,
  // command or agent file it is discussing" is these three directories. ~/.claude as a
  // whole is also .credentials.json, settings.json, shell snapshots, every project's
  // transcripts and every plugin's private state.
  //
  // The fourth entry is the render directory, so a stage an agent just
  // rendered can be posted by reference instead of inlined by value. It is pinned here
  // for a second reason beyond drift: it must stay a directory only this user writes to.
  // A world-writable shared root (/tmp) was the rejected alternative -- a default ships
  // to every install on the next pull, and a reference root is read on an agent's say-so.
  assert.deepEqual(
    [...DEFAULT_REF_ROOTS],
    ['~/.claude/skills', '~/.claude/commands', '~/.claude/agents', '~/Documents/renders'],
  );
  assert.ok(
    !DEFAULT_REF_ROOTS.some(r => r === '/tmp' || r.startsWith('/tmp/') || r === '/var/tmp'),
    'a world-writable directory must never be a DEFAULT reference root; name it explicitly if you want it',
  );
  assert.ok(Object.isFrozen(DEFAULT_REF_ROOTS), 'a shared allowlist default must not be mutable by a caller');

  // ...and the narrowing has teeth, asserted against a stand-in tree so it does not
  // turn into a statement about what this machine happens to have under ~/.claude.
  // Every default root is stood in for by its basename under one parent, which is what
  // makes the last two assertions about the BOUNDARY rather than about any one root's
  // real location -- allowlisting the leaves must not allowlist the directory holding
  // them, whichever leaves those are.
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'claude-board-fakehome-'));
  try {
    const dotClaude = path.join(realpathSync(fakeHome), '.claude');
    for (const r of DEFAULT_REF_ROOTS) mkdirSync(path.join(dotClaude, path.basename(r)), { recursive: true });
    const skill = path.join(dotClaude, 'skills', 'SKILL.md');
    writeFileSync(skill, '# the skill under discussion\n', 'utf8');
    const credentials = path.join(dotClaude, '.credentials.json');
    writeFileSync(credentials, '{"token":"exfiltrated"}', 'utf8');

    const roots = resolveRefRoots(DEFAULT_REF_ROOTS.map(r => path.join(dotClaude, path.basename(r))).join(':'));
    assert.equal(roots.length, DEFAULT_REF_ROOTS.length, 'every default root must survive validation');
    assert.equal(resolvePath({ path: skill }, null, roots).path, skill, 'a skill file still resolves');
    assert.equal(
      resolveRef({ path: credentials }, { cwd: null, roots }).text,
      undefined,
      'the parent of the default roots is not itself a root',
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

check('cwd confinement is revalidated at reference-resolution time, not trusted from an earlier bind -- swapping the project directory for a symlink to $HOME in between is refused, not used as root', () => {
  // createBoard validates cwd via resolveBoardCwd at BIND time (bindBoardCwd,
  // src/board.mjs) -- rejected there if it were $HOME or the filesystem root. Every
  // later resolveRef/resolvePath call then re-realpaths that same cwd STRING and used
  // to trust whatever it got back as the confinement root, without ever re-running that
  // rejection. Two separate realpaths of one name is a check-to-use gap: replace the
  // project directory itself with a symlink to $HOME in between -- something an
  // attacker who can write inside the project's own parent directory can do without
  // touching the board -- and the second realpath returns $HOME, so a ref like
  // '.ssh/id_rsa' resolves "inside root" and would have been read out.
  // Ablation: revert resolvePath's `root` to a bare `realpathSync(cwd)` and this reads
  // the planted secret.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-board-cwdswap-')));
  const prevHome = process.env.HOME;
  try {
    const fakeHome = path.join(base, 'home');
    mkdirSync(fakeHome);
    writeFileSync(path.join(fakeHome, 'id_ed25519'), '-----BEGIN PRIVATE KEY-----\nexfiltrated\n', 'utf8');
    process.env.HOME = fakeHome; // os.homedir() reads $HOME first on POSIX

    const project = path.join(base, 'project');
    mkdirSync(project);

    // Bind time: exactly what createBoard runs, and it must accept an ordinary directory.
    const bound = resolveBoardCwd(project);
    assert.equal(bound.error, undefined, 'an ordinary project directory must bind cleanly');
    assert.equal(bound.path, project);

    // The attacker's window: the project directory is replaced by a symlink to $HOME,
    // under the exact name resolveBoardCwd just accepted -- the board's stored cwd.
    rmSync(project, { recursive: true, force: true });
    symlinkSync(fakeHome, project);

    const viaResolvePath = resolvePath({ path: 'id_ed25519' }, bound.path, []);
    assert.equal(viaResolvePath.path, undefined, 'the swapped-in $HOME must not become the confinement root');
    assert.match(viaResolvePath.error, /\$HOME/, 'refused for being $HOME, the same reason bind time would have refused it');

    const viaResolveRef = resolveRef({ path: 'id_ed25519' }, { cwd: bound.path, roots: [] });
    assert.equal(viaResolveRef.text, undefined, 'a ref must not resolve inside $HOME because the project dir now points there');
    assert.ok(!String(viaResolveRef.text ?? '').includes('exfiltrated'));
    assert.match(viaResolveRef.error, /\$HOME/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(base, { recursive: true, force: true });
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
  // the entire suite green (found by mutation testing): the flag was masking
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

check("the by-value over-cap message no longer tells the caller a source reference raises the cap, because it does not", () => {
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
// element report LOST (breaking this module's own "a
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
  // The rendered page used to carry the same label on an inline anchor button;
  // ADR.md entry 28 deleted that button, so what is pinned here is the escaping of
  // the body itself, which must still happen exactly once.
  const board = createBoard({ title: 't', blocks: [{ kind: 'markdown', text: '## Risk & Reward\n' }] });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('Risk &amp; Reward'));
  assert.ok(!markup.includes('Risk &amp;amp; Reward'));
  assert.ok(!markup.includes('data-anchor-label'), 'no markdown anchor button carries a label any more');
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

// --- A setext heading mints NO anchor (see
// the AC 10/11 checks near the top of this file), so `sliceSection` must not resolve
// one either -- an unresolvable ref is an error the agent sees, where a resolvable
// one nobody minted is content substitution. It still ENDS an enclosing section,
// because the reader sees a heading there. -----------------------------------

check('N9: a section: ref naming a setext heading does not resolve, because no anchor was ever minted for it -- and it still terminates the section above it', () => {
  const src = [
    '## Above', '', 'above body', '',
    'Details', '-------', '', 'detail body', '',
    '## Trailer', '', 'trailer body', '',
  ].join('\n');
  // The real anchors markdown.mjs mints for this exact file -- the set a `section:`
  // ref is supposed to agree with, and 'details' is deliberately not in it.
  const { anchors } = mdToHtmlAndAnchors(src);
  assert.deepEqual(anchors.map(a => a.ref), ['above', 'trailer']);

  writeFileSync(path.join(fixturesDir, 'setext.md'), src, 'utf8');

  const details = resolveRef({ path: 'setext.md', section: 'details' }, { cwd: fixturesDir });
  assert.equal(typeof details.error, 'string',
    'a setext heading has no anchor, so naming its slug must be an error, not a silently different slice');

  // ...but the h2 above it still ends where the (unanchored) setext h2 begins: what
  // the reader sees as a heading is where the section stops.
  const above = resolveRef({ path: 'setext.md', section: 'above' }, { cwd: fixturesDir });
  assert.equal(above.error, undefined);
  assert.equal(above.text, '## Above\n\nabove body\n');

  const trailer = resolveRef({ path: 'setext.md', section: 'trailer' }, { cwd: fixturesDir });
  assert.equal(trailer.error, undefined);
  assert.equal(trailer.text, '## Trailer\n\ntrailer body\n');
});

check('N9: a "---" horizontal rule, a table\'s own separator row, and a fenced "=====" are never mistaken for a setext underline', () => {
  // Every one of these traps is independently verified against the REAL parser
  // above (this file's own manual probes, not re-asserted here) -- this pins the
  // same non-confusion through sliceSection specifically, since it is a separate,
  // hand-rolled scanner that has to reach the identical conclusion on its own.
  const src = [
    '# Real Heading', '', 'para before hr', '', '---', '', 'after hr, not a heading', '',
    '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
    '```', 'fake # heading', '=====', '```', '',
    '## Trailer', '', 'trailer body', '',
  ].join('\n');
  writeFileSync(path.join(fixturesDir, 'setext-traps.md'), src, 'utf8');

  const real = resolveRef({ path: 'setext-traps.md', section: 'real-heading' }, { cwd: fixturesDir });
  assert.equal(real.error, undefined);
  // The hr, the table, and the fenced '=====' must all stay INSIDE this section --
  // none of them may be misread as a heading that would truncate it early.
  assert.ok(real.text.includes('| --- | --- |'), 'the table separator row must survive as body text');
  assert.ok(real.text.includes('fake # heading\n====='), 'the fenced "=====" must survive as body text, unexamined');
  assert.ok(real.text.includes('## Trailer'), 'nothing before it may have truncated the section early');

  // And neither the hr nor the table row ever mints a phantom heading of their
  // own -- a ref naming the text right after the hr must fail exactly as it did
  // before this ticket (there is no heading there, only a paragraph).
  const phantom = resolveRef({ path: 'setext-traps.md', section: 'after-hr-not-a-heading' }, { cwd: fixturesDir });
  assert.equal(typeof phantom.error, 'string', 'a bare paragraph after an hr must never resolve as a section');
});

check('N9: ATX resolution is byte-identical to before this ticket -- setext support changes nothing about it', () => {
  // The exact fixture N6's own ordinal test above uses, plus a bare "---" HR
  // and a GFM table thrown in beside the ATX headings -- both are shapes a
  // setext-aware scanner could plausibly trip on, and neither may perturb the
  // ATX result by one byte. matchHeadingAt's ATX branch returns before any
  // setext-only guard ever runs, which is what this pins directly rather than
  // just by inference.
  const src = [
    '# Notes', '', 'para one', '', '---', '', 'para two', '',
    '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
    '## Sub', '', 'sub body', '',
  ].join('\n');
  writeFileSync(path.join(fixturesDir, 'atx-unaffected.md'), src, 'utf8');
  const notes = resolveRef({ path: 'atx-unaffected.md', section: 'notes' }, { cwd: fixturesDir });
  assert.equal(notes.error, undefined);
  assert.equal(notes.text,
    '# Notes\n\npara one\n\n---\n\npara two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n## Sub\n\nsub body\n');
  const sub = resolveRef({ path: 'atx-unaffected.md', section: 'sub' }, { cwd: fixturesDir });
  assert.equal(sub.error, undefined);
  assert.equal(sub.text, '## Sub\n\nsub body\n');
});

// --- S1: heading identity has ONE owner ------------------------------------------
//
// src/markdown.mjs mints every anchor from the real (marked) token stream;
// src/resolve.mjs's sliceSection used to re-derive headings and slugs with a SECOND,
// hand-rolled scanner. Two scanners drift, and every disagreement returned the WRONG
// section SILENTLY -- a content-substitution primitive, since the agent asks for the
// slug the board displayed and the reviewer is shown a different region of the file.
// The five measured disagreements are pinned individually below, and the property
// that subsumes them ("the anchor set and the resolvable-section set are the same
// set, and each slice starts at its own heading") is pinned last, over every one of
// those corpora at once.

/** Write `md` to a fixture and return { anchors, headingIds, resolve(slug) }.
 * `headingIds` is read out of the RENDERED html rather than guessed from the anchor
 * list, so it is exactly the set of ids a reviewer's browser can scroll to. */
function headingFixture(name, md) {
  writeFileSync(path.join(fixturesDir, name), md, 'utf8');
  const { html, anchors } = mdToHtmlAndAnchors(md);
  const headingIds = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map(m => m[1]);
  return {
    anchors: anchors.map(a => a.ref),
    headingIds,
    resolve: slug => resolveRef({ path: name, section: slug }, { cwd: fixturesDir }),
  };
}

check('S1a: an indented ATX heading (up to 3 spaces) and a bare "#" are headings to the parser, so they must be headings to sliceSection too', () => {
  // Ablation: restore the `^(#{1,6})\s+` column-0 regex and `section: 'notes'` skips
  // the indented heading entirely, resolving to the plain one -- the reviewer reads
  // the wrong section with no error anywhere.
  const f = headingFixture('indented-atx.md', '   ## Notes\n\nindented body\n\n## Notes\n\nplain body\n');
  assert.deepEqual(f.headingIds, ['notes', 'notes-2']);
  assert.ok(f.resolve('notes').text.includes('indented body'));
  assert.ok(!f.resolve('notes').text.includes('plain body'));
  assert.ok(f.resolve('notes-2').text.includes('plain body'));

  // A bare '#' with no text is a heading to marked (slug 'section', since slugify
  // falls back to that for empty text); the old regex required a space after the
  // hashes and missed it.
  const g = headingFixture('bare-hash.md', '#\n\nbody\n\n# section\n\nother\n');
  assert.deepEqual(g.headingIds, ['section', 'section-2']);
  assert.ok(g.resolve('section').text.includes('body'));
  assert.ok(g.resolve('section-2').text.includes('other'));
});

check('S1b: a ~~~ fence, and a longer backtick fence containing a shorter one, hide their contents from the section scanner', () => {
  // Ablation: restore `isFence = /^```/` and the '# Notes' inside the ~~~ fence
  // counts as a real heading -- 'notes' then resolves to a line of sample code and
  // the real '## Notes' becomes 'notes-2', which is not the slug the board showed.
  const tilde = headingFixture('tilde-fence.md', '## API\n\n~~~\n# Notes\n~~~\n\napi body\n\n## Notes\n\nreal notes\n');
  assert.deepEqual(tilde.headingIds, ['api', 'notes']);
  assert.ok(tilde.resolve('notes').text.startsWith('## Notes'));
  assert.ok(tilde.resolve('notes').text.includes('real notes'));
  assert.ok(tilde.resolve('api').text.includes('api body'), 'the fenced "# Notes" must not truncate the API section');

  // Fence length matching: a ``` line INSIDE a ```` fence closes nothing.
  const long = headingFixture('long-fence.md', '## API\n\n````\n```\n# Notes\n```\n````\n\n## Notes\n\nreal notes\n');
  assert.deepEqual(long.headingIds, ['api', 'notes']);
  assert.ok(long.resolve('notes').text.startsWith('## Notes'));
  assert.ok(long.resolve('api').text.includes('# Notes'), 'the whole 4-backtick fence stays inside the API section');
});

check('S1c: an indented code block, an html block and a link-reference definition above a "---" never invent a setext heading', () => {
  // Ablation: restore looksLikeBlockStart (list markers and '>' only) and the
  // indented `API` sample above the rule is accepted as a setext title -- inventing
  // a heading marked never emitted, which took the 'api' slug and pushed the REAL
  // '## API' section to 'api-2'. Verified end to end: the ref resolved to the code
  // block.
  for (const [name, before] of [
    ['indented-code-rule.md', '    API'],
    ['html-block-rule.md', '<div>\nx\n</div>'],
    ['linkdef-rule.md', '[r]: https://x.se'],
  ]) {
    const f = headingFixture(name, `# Doc\n\n${before}\n---\n\n## API\n\nreal api body\n`);
    assert.deepEqual(f.headingIds, ['doc', 'api'], `${name}: only the real headings may exist`);
    const api = f.resolve('api');
    assert.equal(api.error, undefined);
    assert.ok(api.text.startsWith('## API'), `${name}: 'api' must resolve to the real heading, got ${JSON.stringify(api.text.slice(0, 40))}`);
    assert.ok(api.text.includes('real api body'));
    assert.equal(typeof f.resolve('api-2').error, 'string', `${name}: there is no second API heading to name`);
  }
});

check('S1d: a control byte inside a heading slugs the same on the board and on disk -- the document-level strip is not a second scanner\'s to forget', () => {
  // \x0c is a benign, common byte in real text, and it matches JS \s -- so a second
  // scanner calling slugify on RAW bytes off disk (never through
  // stripDocumentControls) collapsed it to a hyphen and minted 'a-b' where the board
  // showed 'ab'. This one fires by accident, not just under attack.
  const f = headingFixture('formfeed.md', '# A\x0cB\n\nbody\n\n# AB\n\nsecond\n');
  assert.deepEqual(f.headingIds, ['ab', 'ab-2']);
  assert.ok(f.resolve('ab').text.includes('body'));
  assert.ok(!f.resolve('ab').text.includes('second'));
  assert.ok(f.resolve('ab-2').text.includes('second'));
  assert.equal(typeof f.resolve('a-b').error, 'string', 'the slug nobody minted must not resolve');
});

check('S1e: a multi-line setext title consumes no ordinal on either side, so every later slug still names the same heading', () => {
  // The old scanner skipped a multi-line setext title, and the comment claimed that
  // was "safe... never a WRONG match". Skipping it also removed a name from `used`,
  // shifting every later ordinal -- so 'notes-2' named a different heading in each
  // scanner. Now that setext mints no anchor at all, both sides skip it together.
  const f = headingFixture('multiline-setext.md',
    '## Notes\n\nfirst\n\nline one\nline two\n---\n\nbody\n\n## Notes\n\nsecond\n');
  assert.deepEqual(f.headingIds, ['notes', 'notes-2']);
  assert.ok(f.resolve('notes').text.includes('first'));
  assert.ok(f.resolve('notes-2').text.includes('second'));
  assert.equal(typeof f.resolve('line-one-line-two').error, 'string');
});

check('S1: the anchor set and the resolvable-section set are the same set, and every slice starts at its own heading', () => {
  // The property the five checks above are instances of. A heading id the board
  // displays must resolve; a slug nobody minted must not; and the slice must begin
  // at the heading whose slug was asked for, not merely somewhere plausible.
  const corpus = {
    'p-indented.md': '   ## Notes\n\nindented\n\n## Notes\n\nplain\n',
    'p-fences.md': '## API\n\n~~~\n# Notes\n~~~\n\nbody\n\n## Notes\n\nreal\n',
    'p-setext.md': 'Setext\n======\n\nbody\n\n# Setext\n\nreal setext\n',
    'p-controls.md': '# A\x0cB\n\nbody\n\n# AB\n\nsecond\n',
    'p-quoted.md': '> ## Plan\n> quoted\n\n## Plan\n\nreal plan\n',
    'p-crlf.md': '# A\r\n\r\nbody\r\n\r\n## B\r\n\r\ntail\r\n',
    'p-mixed.md': '# Doc\n\n- a\n- b\n\n## Doc\n\n```\n# Doc\n```\n\n## Doc\n\ntail\n',
  };
  for (const [name, md] of Object.entries(corpus)) {
    const f = headingFixture(name, md);
    for (const id of f.headingIds) {
      const r = f.resolve(id);
      assert.equal(r.error, undefined, `${name}: heading id ${JSON.stringify(id)} is on the page but does not resolve`);
      const first = r.text.split('\n')[0].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      assert.match(first, /^ {0,3}#{1,6}/,
        `${name}: the slice for ${JSON.stringify(id)} must start at its own ATX heading line, got ${JSON.stringify(first)}`);
    }
    // ...and a list-item anchor is not a section: it names an element, not a range.
    for (const ref of f.anchors.filter(a => !f.headingIds.includes(a))) {
      assert.equal(typeof f.resolve(ref).error, 'string', `${name}: ${ref} is a list-item anchor, not a section`);
    }
  }
});

check('S1/render: a resolved reference reports the 1-based source line its text starts on, so a sliced code block can number its gutter from the file', () => {
  // Exposed for src/render.mjs's gutter (ADR.md entry 63: every code row
  // carries its file's real line number). A section-sliced block used to number
  // from 1 because sliceSection knew the start line and did not report it.
  const md = ['# Top', '', 'intro', '', '## Middle', '', 'middle body', '', '## End', '', 'tail'].join('\n');
  writeFileSync(path.join(fixturesDir, 'startline.md'), md, 'utf8');
  const at = { cwd: fixturesDir };
  assert.equal(resolveRef({ path: 'startline.md', section: 'middle' }, at).startLine, 5);
  assert.equal(resolveRef({ path: 'startline.md', section: 'top' }, at).startLine, 1);
  // Total, not section-only: a line range reports its own start, and a whole-file
  // read starts at line 1 -- so a caller never has to guess which shape it got.
  assert.equal(resolveRef({ path: 'startline.md', lines: [3, 5] }, at).startLine, 3);
  assert.equal(resolveRef({ path: 'startline.md' }, at).startLine, 1);
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

// --- P3: this rule holds unconditionally ---------------------------------------

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

// --- choose-between-rendered-variants --------------

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

check('choose-between-rendered-variants: an html-kind option carries the full-width modifier class, a non-html option does not (ablation: delete the stageModifier line in renderVariantOption and the first assertion fails)', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question',
      prompt: 'Which mockup?',
      widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Card A', block: { kind: 'html', html: '<p>mock</p>' } },
        { label: 'Card B', block: { kind: 'markdown', text: 'copy' } },
      ],
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const cardA = /<div class="variant-card[^"]*"[^>]*data-choice="Card A">/.exec(markup);
  const cardB = /<div class="variant-card[^"]*"[^>]*data-choice="Card B">/.exec(markup);
  assert.ok(cardA, 'setup failure: no card found for the html option');
  assert.ok(cardB, 'setup failure: no card found for the markdown option');
  assert.ok(cardA[0].includes('variant-card--stage'), 'an html-kind option\'s card must carry the full-width modifier class');
  assert.ok(!cardB[0].includes('variant-card--stage'), 'a markdown-kind option\'s card must NOT carry it -- it keeps the existing grid');

  // grid-column: 1 / -1 is what turns the modifier into "one per row at full
  // width" regardless of how many auto-fit columns .options-variants
  // currently has -- see src/styles.mjs's own comment on .variant-card--stage.
  assert.match(styles, /\.variant-card--stage\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    'src/styles.mjs must span an html-kind option across every grid column, not size it like the other columns');
});

check('choose-between-rendered-variants (fallback): a variant option\'s stage starts no shorter than the 320px floor it replaces -- the floor must not cost a mock height while its report is still in flight or never arrives (ablation: this fails if the starting height in src/styles.mjs\'s .choice-variant .html-stage rule is ever dropped below 320px)', () => {
  // Real Chrome measurement (see this feature's own entry in QUIRKS.md and
  // src/render.mjs's "WHEN this runs" comment): a stage's first accurate
  // report is necessarily deferred past this document's own first layout
  // pass, which can in principle be late, or -- on a browser old enough to
  // lack requestAnimationFrame, or a mock whose script throws before it ever
  // reports -- never arrive at all. An earlier cut of this rule shipped a
  // 200px starting height, which is 120px SHORTER than the fixed floor this
  // whole feature exists to improve on: worse than before, for as long (or,
  // in the never-arrives case, as often) as that gap lasts. This asserts the
  // rule's own text rather than anything the stand-in could compute (it has
  // no layout at all, QUIRKS.md), the same shape test/check-pure.mjs already
  // uses for other rules asserted by their exact wording.
  assert.match(styles, /\.choice-variant \.html-stage \{ min-height: 0; height: 320px; max-height: 600px; resize: none; overflow: hidden; \}/,
    'a variant option\'s stage must start at least as tall as the 320px floor it replaces, not the old 200px placeholder');
});

/** Stub the ONE entry point a real browser actually uses for a stage's first
 * height report -- requestAnimationFrame, called twice in a row
 * (stageAgentScript's reportHeightAfterLayout) -- rather than driving the
 * plain, synchronous reportHeight() a fabricated scrollHeight could satisfy
 * on its own regardless of whether the deferral is even still there. That
 * synchronous call is exactly the path measured to be always-zero in a real
 * browser (src/render.mjs's "WHEN this runs" comment on reportHeight, and
 * QUIRKS.md's own entry on the measurement): a check that drove it directly
 * would keep passing even if reportHeightAfterLayout's own rAF chain were
 * deleted outright and something called reportHeight() straight from script
 * scope again -- precisely the failure this repo's mermaid-id trap
 * (QUIRKS.md) warns about, a check that agrees with a wrong assumption about
 * timing rather than exercising the real one.
 *
 * This stub CAPTURES callbacks instead of invoking them, so the deferral
 * itself is provable: `drain()` runs whatever is currently queued, and since
 * invoking one callback can queue ANOTHER (stageAgentScript's rAF nested
 * inside its own rAF callback), it loops until the queue is empty rather than
 * draining one fixed snapshot -- one `drain()` call is enough however deep
 * the real chain nests. test/dom-stand-in.mjs has no event loop of its own to
 * schedule a real deferred callback on, and no notion of "layout has
 * happened" to defer UNTIL (QUIRKS.md "The stand-in has no layout"), so this
 * proves the WIRING (a report is not applied until AFTER an explicit,
 * separate drain step, and the chain that eventually applies it is
 * requestAnimationFrame, twice, reaching reportHeight) rather than anything
 * about real frame timing -- the same ceiling already noted for
 * ResizeObserver. Restores the original binding (usually `undefined`, since
 * Node has no requestAnimationFrame) even if `fn` throws, same idiom
 * test/check-enter.mjs's `withFetchCapture` already uses. */
function withCapturedRAF(fn) {
  const original = globalThis.requestAnimationFrame;
  const queue = [];
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); };
  const drain = () => { while (queue.length) queue.shift()(); };
  try {
    fn(drain);
  } finally {
    globalThis.requestAnimationFrame = original;
  }
}

check('choose-between-rendered-variants: a variant option\'s stage grows to the height it reports, floored at the 320px placeholder and capped at 600px -- never below the floor, never past the cap, and never before its own rendering opportunity (ablation 1: change handleStageHeight\'s Math.min(data.height, STAGE_HEIGHT_CAP) to just data.height and the "taller than the cap" assertion fails; ablation 2: drop the Math.max(STAGE_HEIGHT_FLOOR, ...) wrapper and the "collapsed report floors" assertion fails; ablation 3: change reportHeightAfterLayout\'s body back to a bare reportHeight() call and the "not yet applied" assertion fails)', () => {
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [
        // dom-stand-in.mjs models scrollHeight as exactly one fact: whatever a
        // fixture declares via data-standin-scroll-height, once the node is
        // connected (QUIRKS.md "The stand-in has no layout"). An explicit
        // top-level <body> in a mock's own html is honoured as given by
        // parseHTML, so the declared attribute lands on the same node
        // stageAgentScript's reportHeight() reads (document.body.scrollHeight).
        { label: 'Collapsed', block: { kind: 'html', html: '<body data-standin-scroll-height="180"><p>collapsed mock</p></body>' } },
        { label: 'Tall', block: { kind: 'html', html: '<body data-standin-scroll-height="4000"><p>tall mock</p></body>' } },
      ],
    }],
  });
  const document = loadVariantBoard(board);
  const frames = document.querySelectorAll('.html-stage');
  assert.equal(frames.length, 2, 'setup failure: expected two rendered stages');

  withCapturedRAF((drain) => {
    frames.forEach(f => f.loadSrcdoc());
    // The measured-in-real-Chrome property itself: nothing is applied yet,
    // because nothing has told this document its rendering opportunity has
    // happened. This is the assertion that fails against the ORIGINAL bug
    // (a synchronous reportHeight() call, which always reads 0 pre-layout in
    // a real browser but would read the fixture's declared value HERE,
    // immediately, since the stand-in's declared scrollHeight has no notion
    // of "before" or "after" layout at all).
    assert.ok(!frames[0].style.height, 'a height report must not be applied before this document\'s own rendering opportunity');
    assert.ok(!frames[1].style.height, 'a height report must not be applied before this document\'s own rendering opportunity');
    drain(); // a real browser: waits for the actual rendering opportunity, then runs the queued (nested) rAF callbacks
  });

  // A stage that measures itself from the viewport can report a
  // collapsed height (here, 180 -- shorter than the 320px placeholder) that
  // never grows again. Before the floor, this locked the card at 180px
  // forever; now it renders at the placeholder instead.
  assert.equal(frames[0].style.height, '320px',
    'a mock that reports a collapsed height (below the 320px placeholder) must floor there, never lock the card at the collapsed height it actually reported');
  assert.equal(frames[1].style.height, '600px',
    'a mock taller than the cap must be clipped there, not at its full reported height (4000px)');
});

check('choose-between-rendered-variants (scope): a STANDALONE html stage\'s reported height is never applied -- the existing floor/resize stays untouched, this feature is variant-option-only (ablation: delete handleStageHeight\'s frame.closest(\'.choice-variant\') gate and this fails, because the report would then apply everywhere)', () => {
  const board = createBoard({
    title: 'standalone',
    blocks: [{ kind: 'html', html: '<body data-standin-scroll-height="4000"><p>tall mock</p></body>' }],
  });
  const document = loadVariantBoard(board);
  const frame = document.querySelector('.html-stage');
  withCapturedRAF((drain) => { frame.loadSrcdoc(); drain(); });
  assert.ok(!frame.style.height, 'a standalone stage sends the same \'height\' message every html stage does (stageAgentScript cannot tell which kind of card it is in) -- the parent must decline to apply it outside a .choice-variant card');
});

check('choose-between-rendered-variants: a mock the cap CLIPS scrolls under the wheel, in place -- the notch is forwarded to the stage, chains back to the page at both ends, and never reaches an unclipped card (ablation 1: drop forwardStageWheel\'s "travel <= 0" gate and the short mock\'s notch is consumed; ablation 2: drop either chaining guard and the notch stops going back to the page at that end; ablation 3: delete the stage\'s \'scrollBy\' branch and nothing moves at all)', () => {
  // The gap this closes: an option's stage is 'pointer-events: none' (ADR.md
  // entry 78, and this must not relax it), so a wheel over the mock lands on
  // the CARD -- and the parent cannot scroll an opaque-origin document either.
  // A mock taller than the 600px cap was therefore clipped with everything
  // past the cap unreachable in place.
  //
  // What a stand-in cannot supply is the gesture or the layout: the wheel is
  // dispatched here rather than turned, and the scroll it asks for is captured
  // rather than performed (QUIRKS.md "The stand-in has no layout"). What it DOES
  // reach is the whole decision path -- clipped or not, which end the reader is
  // at, the shape of the message, and that the real stage script acts on it.
  const board = createBoard({
    title: 'variants',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Tall', block: { kind: 'html', html: '<body data-standin-scroll-height="900"><p>tall mock</p></body>' } },
        { label: 'Short', block: { kind: 'html', html: '<body data-standin-scroll-height="400"><p>short mock</p></body>' } },
      ],
    }],
  });
  const document = loadVariantBoard(board);
  const cards = document.querySelectorAll('.choice-variant');
  const frames = document.querySelectorAll('.html-stage');
  withCapturedRAF((drain) => { frames.forEach(f => f.loadSrcdoc()); drain(); });
  assert.equal(frames[0].style.height, '600px', 'setup failure: the tall mock must be the clipped one');
  assert.equal(frames[1].style.height, '400px', 'setup failure: the short mock must not be clipped');

  // Captured, not performed: the stand-in lays nothing out, so this stands in
  // for the stage document actually moving -- and it is the real
  // stageAgentScript's own call, reached over the real channel, not a stub of
  // the handler.
  const moved = [];
  frames[0].contentWindow.scrollBy = (opts) => { moved.push(opts); };
  frames[1].contentWindow.scrollBy = () => { throw new Error('an unclipped mock must never be scrolled'); };

  const notch = (card, props) => {
    const ev = new StandInEvent('wheel', { deltaY: 120, deltaMode: 0, ...props });
    card.dispatchEvent(ev);
    return ev;
  };

  const down = notch(cards[0]);
  assert.deepEqual(moved, [{ top: 120, left: 0, behavior: 'auto' }],
    'a notch over a clipped mock must reach the stage as a pixel delta -- the mock cannot receive the wheel itself, which is the whole reason for the message');
  assert.equal(down.defaultPrevented, true, 'and the page must not scroll under the reader at the same time');

  // Unclipped: nothing is hidden, so the gesture is the page's, untouched.
  const short = notch(cards[1]);
  assert.equal(short.defaultPrevented, false,
    'a card with nothing hidden must leave the wheel to the page -- consuming it there would make an ordinary scroll past the variant sticky');

  // Units: a browser reporting LINES rather than pixels must still move the
  // mock by a notch, not by three pixels.
  moved.length = 0;
  notch(cards[0], { deltaY: 3, deltaMode: 1 });
  assert.deepEqual(moved, [{ top: 48, left: 0, behavior: 'auto' }], 'a line-mode wheel must be converted to pixels');

  // Chaining, top end: the stage has never reported an offset, so it is at the
  // top -- an upward notch belongs to the page.
  moved.length = 0;
  const up = notch(cards[0], { deltaY: -120 });
  assert.deepEqual(moved, [], 'at the top of the mock an upward notch must go back to the page');
  assert.equal(up.defaultPrevented, false);

  // Chaining, bottom end: 900 of content in a 600 frame is 300px of travel, so
  // a stage reporting 300 is showing its last pixel.
  frames[0].contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top: 300 }, '*');
  const past = notch(cards[0]);
  assert.deepEqual(moved, [], 'at the bottom of the mock a downward notch must go back to the page -- a card that keeps consuming it traps the reader');
  assert.equal(past.defaultPrevented, false);

  // And the stage side is shape-checked like every other inbound number on this
  // channel: a stage is agent-authored, and so is anything that reaches it.
  frames[0].contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top: 0 }, '*');
  [{ delta: '120' }, { delta: NaN }, { delta: Infinity }, {}, { delta: { valueOf: () => 120 } }].forEach((fields) => {
    frames[0].contentWindow.postMessage({ cb: 'cb-stage', type: 'scrollBy', ...fields });
    assert.deepEqual(moved, [], `a malformed delta must never reach scrollBy: ${JSON.stringify(fields)}`);
  });
  frames[0].contentWindow.postMessage({ cb: 'cb-stage', type: 'scrollBy', delta: 120 });
  assert.deepEqual(moved, [{ top: 120, left: 0, behavior: 'auto' }],
    'and the well-formed one still moves the mock, so the check above rejects the messages rather than the mechanism being dead');
});

check('choose-between-rendered-variants: a stage cannot hold the wheel hostage -- a frozen report releases the notch within bounded slack, a fake mid-range report cannot trap the upward direction, a pinch (ctrl+wheel) is never consumed, and believed travel is capped (ablation 1: drop the ledger checks and a frozen report consumes downward notches forever; ablation 2: drop the ctrlKey gate and a pinch over a clipped mock is swallowed; ablation 3: drop STAGE_TRAVEL_CAP and a stage honoring its reports holds the wheel for a billion fake pixels)', () => {
  // The gap this closes (found by audit, 2026-08-12): the check above proves
  // the chaining a COOPERATING stage gets, but ownership of the notch was
  // decided entirely from two numbers the stage itself reports.
  // A stage lying about either -- an absurd height, a position that never
  // moves -- captured every downward notch over the card forever, and one
  // faked mid-range report closed the upward escape too. The stand-in half
  // here reaches the whole decision path; that the release is visible on
  // screen is the demo board's half (QUIRKS.md "The DOM stand-in's ceilings").
  const board = createBoard({
    title: 'hostile',
    blocks: [{
      kind: 'question', prompt: 'Which?', widget: 'choose-between-rendered-variants',
      options: [
        { label: 'Hostile', block: { kind: 'html', html: '<body data-standin-scroll-height="900"><p>liar</p></body>' } },
        { label: 'Short', block: { kind: 'html', html: '<body data-standin-scroll-height="400"><p>short mock</p></body>' } },
      ],
    }],
  });
  const document = loadVariantBoard(board);
  const card = document.querySelector('.choice-variant');
  const frames = document.querySelectorAll('.html-stage');
  withCapturedRAF((drain) => { frames.forEach(f => f.loadSrcdoc()); drain(); });

  const moved = [];
  frames[0].contentWindow.scrollBy = (opts) => { moved.push(opts); };

  // The stage now lies: an enormous height, and it will never report movement.
  frames[0].contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'height', height: 1e9 }, '*');
  assert.equal(frames[0].style.height, '600px', 'the style clamp must hold against the same report regardless');

  const notch = (props) => {
    const ev = new StandInEvent('wheel', { deltaY: 120, deltaMode: 0, ...props });
    card.dispatchEvent(ev);
    return ev;
  };

  // Pinch: a zoom gesture, never the stage's, clipped or not.
  const pinch = notch({ ctrlKey: true });
  assert.equal(pinch.defaultPrevented, false, 'a ctrl+wheel (trackpad pinch) over a clipped mock must stay the page\'s');
  assert.deepEqual(moved, [], 'and must not be forwarded to the stage either');

  // Frozen position: notches are consumed only until the page's ledger of
  // forwarded pixels outruns the report by the slack, then the page scrolls
  // again with the pointer still over the card.
  let released = -1;
  for (let i = 0; i < 30; i++) {
    if (!notch({}).defaultPrevented) { released = i; break; }
  }
  assert.ok(released > 0, 'the first notches ARE consumed -- release is a drift judgment, not a blanket refusal to scroll clipped mocks');
  assert.ok(released <= 15, `a frozen report must release the wheel within a bounded number of notches, got ${released < 0 ? 'never' : released}`);
  assert.equal(notch({}).defaultPrevented, false, 'and it stays released while the report stays frozen');

  // One faked mid-range report must not close the upward escape: the ledger
  // never forwarded anything like 5000 pixels, so the claim is not honored.
  frames[0].contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top: 5000 }, '*');
  const up = notch({ deltaY: -120 });
  assert.equal(up.defaultPrevented, false, 'an upward notch against a position the page never forwarded goes back to the page');

  // Active liar: a stage that honors every forwarded pixel in its reports is
  // indistinguishable from a real scroll -- so the height it claimed is only
  // believed up to STAGE_TRAVEL_CAP, and at that boundary the notch is the
  // page's despite a claimed billion pixels still "hidden".
  frames[0].contentWindow.parent.postMessage({ cb: 'cb-stage', type: 'scroll', top: 30000 - 600 }, '*');
  const past = notch({});
  assert.equal(past.defaultPrevented, false, 'at the travel cap a downward notch chains back to the page, whatever height the stage claimed');
});

check('choose-between-rendered-variants: an html option\'s iframe is rendered pointer-events: none -- a real click can never reach it, only the card around it can ever record a pick', () => {
  // SECURITY, not polish: without this, a real, trusted
  // click over the visible mock content of an html-kind option would land
  // INSIDE the iframe rather than on the card, and the stage is untrusted,
  // agent-authored content -- see ADR.md entry 78 for the two paths that made a
  // stage-reported click-to-select message unsafe. This is the one half of the fix
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
  // 'EventSource' is DECLARED and never passed -- see the fuller explanation on
  // indexScript's own sibling site further down this file (~line 7460) for why:
  // left off the parameter list, the name resolves to whatever the HOST exposes,
  // and node has shipped a global EventSource behind a flag since 22.x. Here it
  // binds ui.mjs's own `typeof EventSource === 'undefined'` guard to undefined
  // for the same reason, so this stand-in never opens a real connection against
  // the relative board-events URL.
  new Function('document', 'window', 'location', 'EventSource', ui)(document, window, location);
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
      // An html option, not a markdown one: ADR.md entry 28 leaves a markdown
      // block no comment button anywhere, nested in a variant card included.
      options: [{ label: 'A', block: { kind: 'html', html: '<div class="mock"><button>Go</button></div>' } }],
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
  // green -- but the archive can no longer tell
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
  //
  // A leading SPACE belongs in this loop for exactly the same reason and was missing:
  // WHATWG's URL parser strips leading and trailing C0 controls *or U+0020* before it
  // reads the scheme (`new URL(' javascript:alert(1)').protocol === 'javascript:'`),
  // while the scheme regex here is anchored at offset 0, so a space made the
  // destination look schemeless -- i.e. relative -- and it was emitted live. The rest
  // of the whitespace the URL parser removes (tab, LF, CR, stripped from anywhere in
  // the URL, not just the ends) is already inside the \x00-\x1f range this loop
  // covers; U+00A0 and friends are NOT stripped by the parser, so a scheme behind one
  // never reaches the browser as a scheme and needs no entry here.
  for (const ctrl of ['\x00', '\x01', '\x08', '\x0e', '\x1f', '\x7f', ' ']) {
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
  // the original guarantees still hold
  assert.ok(mdToHtml('[t](javascript:alert(1))').includes('href="#"'));
  assert.ok(mdToHtml('[t](https://x.se)').includes('href="https://x.se"'));
});

check('N1: a leading space in an ANGLE-BRACKET destination or a reference definition does not smuggle a scheme past the allowlist either', () => {
  // The loop above hides the space case behind CommonMark's own inline-destination
  // rule (`[x]( javascript:...)` has its leading whitespace eaten by the parser
  // before the allowlist ever sees it). The two destination syntaxes that PRESERVE a
  // leading space are both new with marked -- an angle-bracket destination, where
  // every byte between < and > is the URL, and a reference definition, whose
  // destination is resolved elsewhere in the document -- so both are regressions
  // against the pre-marked scanner, which rendered all of these as inert text.
  //
  // Ablation: drop the space from stripUrlControls' trim and
  // `[x](< javascript:alert(1)>)` emits href=" javascript:alert(1)" live, which the
  // browser navigates to as javascript: at the daemon's origin.
  // "Live" is the question, not "the word appears": an href of `&lt;javascript:...`
  // is a RELATIVE url to the browser (a scheme must start with a letter, and `<` is
  // not one of the bytes the URL parser strips), so it is inert even though the
  // substring is there. What is live is a blocked scheme behind nothing but the
  // whitespace the URL parser removes before it reads the scheme.
  const liveBlockedScheme = html => /(?:href|src)="[\s\x00-\x1f]*(?:javascript|vbscript|data):/i.test(html);

  const link = mdToHtml('[x](< javascript:alert(1)>)');
  assert.ok(!liveBlockedScheme(link), `angle-bracket destination smuggled a javascript: href: ${link}`);
  assert.ok(link.includes('href="#"'));

  const ref = mdToHtml('[r]: < vbscript:x>\n\n[r]\n');
  assert.ok(!liveBlockedScheme(ref), `reference definition smuggled a vbscript: href: ${ref}`);

  const img = mdToHtml('![i](< data:text/html,x>)');
  assert.ok(!liveBlockedScheme(img), `angle-bracket image destination smuggled a data: src: ${img}`);

  // Trailing space, same parser rule (WHATWG strips C0-or-space from BOTH ends), and
  // a space on each side at once.
  assert.ok(!liveBlockedScheme(mdToHtml('[x](<javascript:alert(1) >)')));
  assert.ok(!liveBlockedScheme(mdToHtml('[x](< javascript:alert(1) >)')));

  // ...while an ordinary angle-bracket destination still renders live, trimmed to
  // the bytes that were actually vetted.
  assert.equal(mdToHtml('[x](< https://example.com/a >)'),
    '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer">x</a></p>');
  // An INTERIOR space is not something the URL parser strips (it percent-encodes it),
  // so it stays in the emitted href -- trimming is at the ends only.
  assert.ok(mdToHtml('[x](<a b.png>)').includes('href="a b.png"'));
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

check('N2: a WIDE table is rendered in time linear in its length, not quadratic in its column count', () => {
  // renderCellText re-split the whole row for every column in it, so a table cost
  // O(columns x row length). Measured on this machine, same table shape as below:
  // 500 columns 40ms, 1000 162ms, 2000 582ms, 8000 8962ms -- a clean 4x per
  // doubling, putting a 512 KiB table (~24k columns) at about two MINUTES of the
  // daemon's one thread, with health, every other board and every open SSE stream
  // stopped behind it. Nothing about the input is adversarial: a generated matrix
  // or a benchmark grid is exactly this shape, and the cost is re-paid on every
  // `section:` resolution of the same file. Splitting each row ONCE makes it linear:
  // the same table below renders in ~90ms. Ablation: move the split back inside the
  // per-column helper and this check runs for minutes and trips the file's deadline.
  const cols = 24000;
  const row = prefix => '|' + Array.from({ length: cols }, (_, i) => ` ${prefix}${i} `).join('|') + '|';
  const md = row('c') + '\n|' + Array.from({ length: cols }, () => '---').join('|') + '|\n' + row('v') + '\n';
  assert.ok(md.length > 400 * 1024 && md.length <= 512 * 1024, `setup: the table must be a realistic 512 KiB block, got ${md.length} bytes`);
  const started = Date.now();
  const html = mdToHtml(md);
  const elapsed = Date.now() - started;
  // The bound is this section's usual ~20-50x the measured time, so a loaded or
  // 2-core CI box cannot make it a false red; the contract it stands for is ~1s.
  assert.ok(elapsed < 2000, `a ${Math.round(md.length / 1024)}KB wide table took ${elapsed}ms`);
  // Linear or not, it still has to render every column it was given.
  assert.equal((html.match(/<th/g) || []).length, cols, 'every header cell must render');
  assert.equal((html.match(/<td/g) || []).length, cols, 'every body cell must render');
});

check('N2: a markdown block full of just-under-cap code fences is bounded as a BLOCK, not once per fence', () => {
  // src/render.mjs's MAX_HIGHLIGHT_CHARS caps one CALL, and each fence was its own
  // call, so a document could buy the cap's worst case as many times as it liked and
  // the "slow request, not a hang" promise held for no realistic document. Measured
  // here: 20 fences of 8000 adversarial typescript characters (an unterminated regex
  // literal -- a truncated or minified .js) cost 5911ms of one blocked thread when
  // every fence tokenizes, against 285ms once the budget is spent across the whole
  // document. Ablation: remove MAX_DOC_HIGHLIGHT_CHARS from src/markdown.mjs's
  // renderCode and this goes back to seconds and keeps climbing with fence count.
  const fence = '```typescript\n/' + 'a'.repeat(8000) + '\n```\n\n';
  const text = fence.repeat(20);
  const started = Date.now();
  const board = createBoard({ title: 'N2 fences', blocks: [{ kind: 'markdown', text }] });
  const elapsed = Date.now() - started;
  // 5000, not the 2000 this started at: the fixed path measures ~285ms here but has
  // been seen at 1157ms on a box under real CPU load, and the ablation is ~17s, so
  // nothing this check is for gets past a 5s bound.
  assert.ok(elapsed < 5000, `a markdown block of 20 near-cap fences took ${elapsed}ms`);
  const html = board.blocks[0].html;
  assert.equal((html.match(/<pre>/g) || []).length, 20, 'setup failure: all 20 fences must have rendered');
  // What the budget costs is colour, and only colour: the fence keeps its language
  // label, its rows and its exact bytes, which is the same degradation a single
  // over-cap block already took.
  assert.equal((html.match(/class="fence-lang"/g) || []).length, 20, 'every fence keeps its language label -- the budget declines tokenization, it does not blank the fence');
  const document = parseHTML(html);
  const bodies = [...document.querySelectorAll('pre code')].map(el => el.textContent);
  assert.equal(bodies.length, 20);
  for (const body of bodies) assert.equal(body, '/' + 'a'.repeat(8000), 'every fence still copies back byte-identically, budget or no budget');
});

check('the fence budget buys tokenizing, and pays for nothing else: a fence that never reaches the tokenizer does not spend it', () => {
  // Two ways a fence reaches the highlighter and does no tokenizer work at all: no
  // info string, and an info string naming a language this build never vendored (a
  // reviewer's ```cobol, ```zig, ```make). Charging either bought nothing and
  // silently stripped the colour off the next fence that could have used the
  // budget. Each dump below is on its own big enough to exhaust the whole document
  // allowance, so if it is charged the javascript fence after it goes plain.
  // Ablation: charge on `lang` being non-empty (or unconditionally) in
  // highlightFenceHtml and the 'unvendored language' row fails; charge
  // unconditionally and both rows do.
  // 8100 + ~1KB is over the 8192-character document allowance and each part is
  // under it, so the two fences fit only because the first one is free. A dump
  // bigger than the whole allowance would be declined on affordability instead and
  // prove nothing about charging.
  const js = 'const x = "hi"; // note\n'.repeat(40); // ~1KB, comfortably inside the budget
  const dump = 'x'.repeat(8100) + '\n';
  for (const [name, info] of [['no info string', ''], ['an unvendored language', 'cobol']]) {
    const text = '```' + info + '\n' + dump + '```\n\n```javascript\n' + js + '```\n';
    const board = createBoard({ title: name, blocks: [{ kind: 'markdown', text }] });
    const fences = board.blocks[0].html.split('<pre>').slice(1);
    assert.equal(fences.length, 2, `setup failure (${name}): expected two fences`);
    assert.ok(fences[1].includes('class="tok-'),
      `${name}: a fence the tokenizer never ran on must not spend the budget the javascript fence after it needs`);
  }
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

check('N2: INTERLEAVED successful and failing delimiters are scanned in linear time -- the memo must not survive the nested lexInline a successful match runs', () => {
  // The memo's soundness argument ("the scan only ever shrinks its remaining
  // string") holds for ONE inline pass over ONE string. A successful match calls
  // Lexer.lexInline on the emphasis CONTENT -- a different string, which fires the
  // same emStrongMask hook and, while the memo was module-level and unsaved, wiped
  // the outer pass's bounds and left its own behind. The outer scan then inherited a
  // bound derived from an unrelated string: quadratic again, and (see the check
  // below) silently wrong.
  //
  // Homogeneous input -- ' _a' repeated, as the two checks above use -- cannot catch
  // this: it never matches, so it never nests, so the memo never leaks. It takes an
  // input that alternates matching and non-matching delimiters. Measured with the
  // leak: 18KB 98ms, 36KB 352ms, 72KB 1344ms -- 4x per doubling.
  const md = '*x* _a'.repeat(50000); // 300KB, inside the by-value cap
  const started = Date.now();
  mdToHtml(md);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `interleaved emphasis took ${elapsed}ms on 300KB`);
});

check('N2: a nested emphasis scan does not silently delete a LATER emphasis in the same paragraph', () => {
  // The same leak, in its correctness form: the inner lexInline's "no closer below
  // length L" bound outlived the nested call and rejected a delimiter the outer
  // string really does close. History-dependent within one paragraph, which is what
  // makes it so hard to see -- `_b_ *_aaaa*` and `plain _b_` render the emphasis,
  // `*_aaaa* _b_` drops it.
  assert.equal(mdToHtml('*see _the notes*, then read _this_'),
    '<p><em>see _the notes</em>, then read <em>this</em></p>');
  assert.equal(mdToHtml('*_aaaa* _b_'), '<p><em>_aaaa</em> <em>b</em></p>');
  assert.equal(mdToHtml('_b_ *_aaaa*'), '<p><em>b</em> <em>_aaaa</em></p>');
  // strikethrough shares the memo and the same nested-lexInline path
  assert.equal(mdToHtml('~~x~~ and ~~y~~'), '<p><del>x</del> and <del>y</del></p>');
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
  // A non-directory and a path that does not exist share ONE refusal, deliberately:
  // distinguishing them made the message an existence-and-type oracle over the whole
  // disk. Assert both are refused, never that they are told apart.
  const file = path.join(fixturesDir, 'not-a-dir.txt');
  writeFileSync(file, 'x', 'utf8');
  assert.throws(() => createBoard({ title: 't', cwd: file, blocks: [] }), /not a readable directory/);
  assert.throws(() => createBoard({ title: 't', cwd: path.join(fixturesDir, 'nope'), blocks: [] }), /not a readable directory/);
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
// The decision "Two ways out, plus a wall clock". The whole path behind it
// (POST /submit {action:'discuss'},
// board.state='discuss', the shim's stop-posting branch) shipped and is checked
// elsewhere; for a long stretch the AFFORDANCE did not exist at all, so half of
// that promise was dead with every server-side check still green. These assertions
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
  // One fetch, one body-building path WITHIN submitBoard itself: a second,
  // hand-copied fetch in there is how Discuss would quietly come to collect
  // less than Send does (it returns "whatever is filled in" -- partial
  // answers are the point). Scoped to submitBoard's own body, not the whole
  // file -- submitPageRound carries a SECOND, independent /submit
  // fetch (the awaited page round's own Send/Discuss,
  // which never shares this path -- see that function's own header comment
  // for why), and that one is no more a "divergent copy" of this one than
  // resync's own fetch is.
  const submitBody = namedFunctionBody(ui, 'submitBoard');
  assert.ok(submitBody, 'expected a shared submitBoard(action)');
  const submitFetches = [...submitBody.matchAll(/fetch\([^)]*\/submit/g)];
  assert.equal(submitFetches.length, 1, 'both actions must share one submit fetch, not carry two divergent copies');
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

check('Send never requests browser notification permission -- that entry point is gone with the browser notifier', () => {
  // ADR.md entry 58: the daemon is the one notifier now; the page has nothing
  // left to ask permission for. requestNotifyPermissionFromSend does not exist,
  // and nothing on the Send/Cmd+Enter paths calls the browser's own
  // requestPermission -- see the criterion-21 grep in check-notify-cleanup.mjs
  // for the tree-wide version of this assertion.
  assert.equal(namedFunctionBody(ui, 'requestNotifyPermissionFromSend'), null,
    'requestNotifyPermissionFromSend must be deleted, not left as dead code');
  const listeners = listenerBodies(ui);
  const sendListener = listeners.find(b => /submitBoard\('send'\)/.test(b));
  assert.ok(sendListener, "expected the Send click listener");
  assert.ok(!/requestNotifyPermissionFromSend\(\)|requestPermission\(\)/.test(sendListener),
    'Send must no longer request browser notification permission');
});

// --- P6: a queued comment gets its pin immediately ------------------------------
//
// The batching is the win ("queue a dozen comments, send once");
// the promise is "a numbered pin appears on the element". The queue-side of
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

// --- the pending-comment queue, pure -----------------
//
// findPendingCommentForAnchor ("reopen and edit", also reused for
// "already sent") and removePendingComment (the delete
// control) are the two functions called out for
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
  // legitimately read different live text between two clicks), and this
  // must still recognise it as the same target.
  assert.equal(findPendingCommentForAnchor(pending, 'h1', { kind: 'dom', ref: '1.2', hint: 'a different hint now' }).id, 2);
  // A ref/kind/block that was never queued is simply not found.
  assert.equal(findPendingCommentForAnchor(pending, 'h1', { kind: 'dom', ref: '9.9' }), undefined);
  assert.equal(findPendingCommentForAnchor(pending, 'd1', { kind: 'md', ref: 'findings' }) !== undefined, true, 'setup sanity');
  assert.equal(findPendingCommentForAnchor(pending, 'nope', { kind: 'md', ref: 'findings' }), undefined, 'a different blockId must not match');
});

check('findPendingCommentForAnchor never matches a SENT comment -- the "no edit path" rule holds at the function level, not just by caller discipline', () => {
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
  // src/ui.mjs's isSentAnchor does), DOES find it -- proving
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
  // so re-deriving them from the shorter array IS the renumbering this
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

// --- P2 (page side): mark the tab, never steal focus ---------------
//
// The decision "Open once, then badge": the page's own amber tile carrying a
// bold ink numeral on the favicon. The notification that used to fire beside
// it is gone -- ADR.md entry 58 moved that job to the daemon, which the tab
// now feeds through the attended report (below) instead of raising its own.
// The title used to carry a "(n) " prefix; it lost it for good -- a numeral
// already sitting in the tab mark makes that case weaker, not stronger, so
// document.title stays untouched even though the mark itself counts again.

check('document.title never takes a pending-count prefix -- setTitleBadge is gone, not just unused', () => {
  assert.equal(namedFunctionBody(ui, 'setTitleBadge'), null, 'the "(n) " title prefix must be deleted, not left as dead code');
  assert.ok(!/\(['"]\s*\(['"]\s*\+/.test(ui), 'no "(" + count title-prefix construction may remain anywhere in the client script');
  // The one legitimate mutation of document.title in the whole page is the
  // initial baseTitle capture; nothing may reassign it afterwards.
  assert.ok(!/document\.title\s*=/.test(ui), 'nothing may assign document.title any more -- the tab stops counting');
});

check('an SSE round push marks the tab: favicon mark, no title write, no notification call', () => {
  const push = namedFunctionBody(ui, 'applyRoundPush');
  assert.ok(push, 'expected applyRoundPush in src/ui.mjs');
  assert.match(push, /markPendingRound\(/, 'a round push must mark the tab -- the tab is never reopened, so the page has to say so itself');
  const mark = namedFunctionBody(ui, 'markPendingRound');
  assert.match(mark, /setFaviconBadge\(/);
  assert.ok(!/notifyRound\(/.test(mark), 'markPendingRound must no longer call a browser notifyRound -- ADR.md entry 58 moved that job to the daemon');
  assert.ok(!/setTitleBadge/.test(mark), 'marking a round pending must no longer touch the title');
  assert.match(mark, /if \(readonly\) return;/, 'marking must be inert in readonly mode');
  // The tab mark gates on whether the round
  // is genuinely awaited -- reads roundIsAwaited off the SAME board this
  // function's caller already advanced to the post-push state (applyRoundPush's
  // own comment on why 'board' is reassigned before markPendingRound runs).
  assert.match(mark, /roundIsAwaited\(/, 'the gate must read the shared roundIsAwaited predicate (src/badge.mjs), not reinvent one');
});

check('markPendingRound: an awaited round marks the tab; a non-awaited one (including a legacy-shaped round with no awaited key) does not', () => {
  // Same ablation-through-a-real-scope technique as the favicon checks below
  // (drawFavicon/setFaviconBadge run through new Function against a stand-in) --
  // the extracted markPendingRound/roundIsAwaited/questionBlocks bodies are the
  // EXACT client-embedded code (src/ui.mjs's .toString() splice), not a
  // hand-written restatement of the gate.
  const markBody = namedFunctionBody(ui, 'markPendingRound');
  const awaitedBody = namedFunctionBody(ui, 'roundIsAwaited');
  const questionBody = namedFunctionBody(ui, 'questionBlocks');
  assert.ok(markBody && awaitedBody && questionBody, 'expected markPendingRound, roundIsAwaited and questionBlocks in src/ui.mjs');

  function run(board, n) {
    const calls = { setFaviconBadge: [] };
    const scope = new Function(
      'board', 'n', 'calls',
      `var readonly = false; var pendingRounds = 0;
       function setFaviconBadge(p) { calls.setFaviconBadge.push(p); }
       function questionBlocks(b) {${questionBody}}
       function roundIsAwaited(b, r) {${awaitedBody}}
       function markPendingRound(n) {${markBody}}
       markPendingRound(n);
       return pendingRounds;`,
    );
    const pendingRounds = scope(board, n, calls);
    return { pendingRounds, calls };
  }
  // setFaviconBadge is stubbed rather than spliced in real: this check is about
  // WHETHER markPendingRound reaches the favicon call at all, not about
  // drawFavicon's own drawing, which the checks above already cover directly.

  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'mark-pending');
  mkdirSync(dir, { recursive: true });

  // A fresh question round: awaited is stamped true at mint time.
  const asking = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'question', prompt: 'q', widget: 'text' }] });
  let r = run(asking, 1);
  assert.equal(r.pendingRounds, 1, 'an awaited question round must mark the tab');

  // A fresh page round posted WITHOUT wait: true -- awaited is stamped false.
  const plainPage = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'html', html: '<p>hi</p>' }] });
  assert.equal(plainPage.rounds[0].awaited, false, 'setup sanity: a page round without wait must mint awaited: false');
  r = run(plainPage, 1);
  assert.equal(r.pendingRounds, 0, 'a fire-and-forget artifact round must not mark the tab');

  // A fresh page round posted WITH wait: true -- awaited is stamped true.
  const awaitedPage = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'html', html: '<p>hi</p>' }], wait: true });
  assert.equal(awaitedPage.rounds[0].awaited, true, 'setup sanity: wait: true must mint awaited: true');
  r = run(awaitedPage, 1);
  assert.equal(r.pendingRounds, 1, 'an awaited page round must mark the tab');

  // Legacy shape: a round record with NO awaited key at all (undefined, not
  // false) -- the exact shape a board persisted before ADR.md entry 45 carries.
  // A question block still present must fall back to the OLD shape-based
  // inference and still mark, or an amend arriving live on an old open
  // question round would silently stop marking the tab it always used to.
  const legacyAsking = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'question', prompt: 'q', widget: 'text' }] });
  delete legacyAsking.rounds[0].awaited;
  delete legacyAsking.rounds[0].awaitDeadline;
  assert.ok(!('awaited' in legacyAsking.rounds[0]), 'setup sanity: the key must be genuinely absent, not merely undefined-valued');
  r = run(legacyAsking, 1);
  assert.equal(r.pendingRounds, 1, 'a legacy round with a question block must still mark the tab');

  // Legacy shape, page round: no awaited key AND no question block -- the old
  // inference reads this as not-awaited too, so it must stay silent, the same
  // as the fresh plainPage case above.
  const legacyPage = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'html', html: '<p>hi</p>' }] });
  delete legacyPage.rounds[0].awaited;
  delete legacyPage.rounds[0].awaitDeadline;
  r = run(legacyPage, 1);
  assert.equal(r.pendingRounds, 0, 'a legacy page round with no question block must not mark the tab');
});

check('the favicon mark draws the page\'s own amber tile with a bold ink numeral -- no inverted tile anywhere', () => {
  const draw = namedFunctionBody(ui, 'drawFavicon');
  assert.ok(draw, 'expected drawFavicon in src/ui.mjs');
  assert.match(draw, /createElement\('canvas'\)/);
  assert.match(draw, /toDataURL\(/, 'the mark must be a data URI the page draws, not a fetched or bundled file');
  assert.match(draw, /fillText\(/, 'the count is drawn as canvas text, not an SVG data URI');
  assert.ok(!/<svg/.test(draw), 'the pending mark must never be built as an SVG string -- a missing font there would silently drop the digit');
  // The tile is the SAME amber tile the unmarked tab shows, same fill, same rx 9
  // corner -- no state paints a second tile colour, and the inverted dark ground
  // plus its arc pip are gone outright, not merely unused.
  assert.match(draw, new RegExp(`fillStyle = '${palettes.dark['--warning']}'`),
    'the pending tile must be the SAME amber --warning the unmarked tab shows, off the palette rather than hand-copied');
  assert.ok(!draw.includes(palettes.dark['--bg']),
    'no state may paint a second (dark) tile colour -- the inverted tile is gone, not just unused');
  assert.ok(!/\.arc\(/.test(draw), 'the amber pip is gone, not unused -- no inverted mark is reachable anywhere');
  assert.match(draw, /roundRect\(0, 0, 32, 32, 9\)/,
    'same tile as the page mark, same corner: pending is a state of it, not a different drawing');
  // The numeral is ink on amber -- the same ink MARK_SHAPES' rows already use.
  assert.match(draw, new RegExp(`fillStyle = '${palettes.dark['--accent-ink']}'`),
    'the numeral must be --accent-ink, off the palette rather than hand-copied');
  // The sizing ladder, optical steps rather than a linear scale --
  // 22px at one digit, 18px at two, 17px for the 9+ overflow, capped at 99.
  assert.match(draw, /22/, 'expected the one-digit size in the sizing ladder');
  assert.match(draw, /18/, 'expected the two-digit size in the sizing ladder');
  assert.match(draw, /17/, 'expected the 9+ overflow size in the sizing ladder');
  assert.match(draw, /9\+/, 'the 9+ overflow token must still exist, now capped at 99 rather than 9');
  const set = namedFunctionBody(ui, 'setFaviconBadge');
  assert.match(set, /baseFavicon/, 'clearing the mark must restore the page\'s own mark, not leave the badge on it');
  assert.match(set, /removeAttribute\('href'\)/, 'and with no mark to restore it must still unmark rather than keep the count');
  assert.match(set, /drawFavicon\(pending\)/, 'the drawn mark must carry the real pending count, not a countless pip');
  // Nothing about this may add an external reference to the emitted page.
  const html = renderBoardPage(createBoard({ title: 'Fav', blocks: [{ kind: 'markdown', text: '# A' }] }));
  assert.ok(!/<link[^>]+href=["']?http/.test(html));
});

check('a numbered mark applies while a round is pending, sized by the digit ladder, and the page\'s own mark comes back once nothing is', () => {
  // drawFavicon/setFaviconBadge are exercised directly, the same shape the prior
  // countless-mark check used: pull the real function bodies out of the client
  // script (source text, not a browser) and run them against a stand-in document
  // plus a stand-in canvas context that records what got drawn.
  const drawBody = namedFunctionBody(ui, 'drawFavicon');
  const setBody = namedFunctionBody(ui, 'setFaviconBadge');
  assert.ok(drawBody && setBody, 'expected drawFavicon and setFaviconBadge in src/ui.mjs');
  function run(pending) {
    const calls = { fillText: null, font: null };
    const link = { rel: 'icon', href: 'data:image/svg+xml,BASE', getAttribute(n) { return this[n]; }, setAttribute(n, v) { this[n] = v; }, removeAttribute(n) { this[n] = undefined; } };
    const doc = {
      querySelector: () => link,
      createElement: () => ({
        getContext: () => ({
          fillStyle: '', font: '', textAlign: '', textBaseline: '',
          beginPath() {}, roundRect() {}, fill() {},
          fillText(text, x, y) { calls.fillText = [text, x, y]; calls.font = this.font; },
        }),
        toDataURL: () => 'data:image/png,PIP',
      }),
      head: { appendChild() {} },
    };
    // ui.mjs's `${palettes.dark[...]}` interpolations already resolved to literal
    // hex strings when the `ui` template literal itself was evaluated at import
    // time, so the extracted bodies below reference no free `palettes` variable.
    const scope = new Function(
      'document', 'pending',
      `var faviconLink = null; var baseFavicon = null;
       function drawFavicon(n) {${drawBody}}
       function setFaviconBadge(pending) {${setBody}}
       setFaviconBadge(pending);
       return faviconLink.href;`
    );
    const href = scope(doc, pending);
    return { href, calls };
  }

  let r = run(1);
  assert.equal(r.href, 'data:image/png,PIP', 'something pending must swap in the drawn mark');
  assert.equal(r.calls.fillText[0], '1', 'a single digit must render as itself');
  assert.equal(r.calls.fillText[1], 16, 'the numeral is centred at x 16');
  assert.equal(r.calls.fillText[2], 16.8, 'the numeral is centred at y 16.8');
  assert.match(r.calls.font, /22px/, 'one digit renders at 22px');

  r = run(12);
  assert.equal(r.calls.fillText[0], '12', '12 must render honestly as 12, not flattened to an overflow token');
  assert.match(r.calls.font, /18px/, 'two digits render at 18px');

  r = run(150);
  assert.equal(r.calls.fillText[0], '9+', 'a count above 99 renders as the 9+ overflow token');
  assert.match(r.calls.font, /17px/, 'the 9+ overflow renders at 17px');

  r = run(0);
  assert.equal(r.href, 'data:image/svg+xml,BASE', 'nothing pending must restore the page\'s own unbadged mark, not leave the drawn one or go blank');
});

check('a canvas or font failure during drawFavicon leaves the tab\'s existing mark alone, never a blank amber tile', () => {
  // Canvas text can fail (unsupported context, a throwing font
  // path) the way an SVG data URI's font resolution silently degrades -- but
  // unlike the SVG case, a throw here is caught and the caller keeps whatever
  // mark the tab already had, rather than swap in a half-drawn or blank tile.
  const drawBody = namedFunctionBody(ui, 'drawFavicon');
  const setBody = namedFunctionBody(ui, 'setFaviconBadge');
  const link = { rel: 'icon', href: 'data:image/png,PRIOR-BADGE', getAttribute(n) { return this[n]; }, setAttribute(n, v) { this[n] = v; }, removeAttribute(n) { this[n] = undefined; } };
  const doc = {
    querySelector: () => link,
    createElement: () => ({
      getContext: () => ({
        fillStyle: '', font: '', textAlign: '', textBaseline: '',
        beginPath() {}, roundRect() {}, fill() {},
        fillText() { throw new Error('font failure'); },
      }),
      toDataURL: () => 'data:image/png,SHOULD-NOT-BE-USED',
    }),
    head: { appendChild() {} },
  };
  const scope = new Function(
    'document', 'pending',
    `var faviconLink = null; var baseFavicon = null;
     function drawFavicon(n) {${drawBody}}
     function setFaviconBadge(pending) {${setBody}}
     setFaviconBadge(pending);
     return faviconLink.href;`
  );
  const href = scope(doc, 5);
  assert.equal(href, 'data:image/png,PRIOR-BADGE', 'a drawing failure must leave whatever mark the tab already had, never paint a blank amber tile');
});

check('every page carries the same inline mark, and unbadging has something to restore', () => {
  // One icon, three pages, no asset file: the board (and so the `file:` archive
  // written from it), the index, and the refusal page a wrong browser reaches.
  assert.ok(faviconLink.startsWith('<link rel="icon" href="data:image/svg+xml,'),
    `the mark must be inline, not a file beside the page: ${faviconLink.slice(0, 60)}`);
  assert.ok(!faviconLink.includes('#'),
    'an unescaped # truncates a data URI at the first colour -- the href must be percent-encoded');
  const svg = decodeURIComponent(faviconLink.slice(faviconLink.indexOf(',') + 1, -2));
  assert.ok(svg.includes(palettes.dark['--warning']) && svg.includes(palettes.dark['--accent-ink']),
    'the mark paints the palette, not a hand-copied hex that a palette edit would leave behind');
  assert.ok(!svg.includes(palettes.light['--warning']),
    'light --warning is a brown tuned for text contrast -- the tile must name DARK explicitly or it turns to mud');

  const board = renderBoardPage(createBoard({ title: 'Fav', blocks: [{ kind: 'markdown', text: '# A' }] }));
  assert.ok(board.includes(faviconLink), 'the board page must carry the mark');
  assert.ok(renderIndexPage({ threads: [] }).includes(faviconLink), 'the index must carry the mark');
  assert.ok(renderRefusalPage().includes(faviconLink), 'the refusal page must carry the mark');
});

check('the tab mark and the in-page mark are one drawing, at two sizes', () => {
  // The tile in the board head's home control and the one leading the index title
  // are the favicon's own rects, not a second copy that a geometry edit would
  // leave behind. Compare shapes, not whole documents: the favicon carries xmlns
  // and no width/height, the in-page mark the reverse.
  const shapes = decodeURIComponent(faviconLink.slice(faviconLink.indexOf(',') + 1, -2))
    .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  assert.ok(shapes.startsWith('<rect'), `expected the favicon body to be bare rects: ${shapes.slice(0, 40)}`);

  const board = renderBoardPage(createBoard({ title: 'Mark', blocks: [{ kind: 'markdown', text: '# A' }] }));
  const home = board.match(/<a class="back-to-index"[^>]*>(.*?)<\/a>/s);
  assert.ok(home, 'expected the home control in the board head');
  assert.ok(home[1].includes(shapes), 'the home control must hold the mark itself, not its own copy of the geometry');
  assert.match(home[1], /width="30" height="30"/, 'sized to the 30px slot it took over');
  assert.match(home[0], /aria-label="All threads"/,
    'the mark replaced a labelled arrow -- losing the label would leave a screen reader an unnamed link');

  const index = renderIndexPage({ threads: [] });
  const head = index.match(/<div class="index-head-titles">(.*?)<h1>/s);
  assert.ok(head && head[1].includes(shapes), 'the index mark must lead the title, and be the same drawing');
  assert.match(head[1], /width="36" height="36"/);
});

check('the browser notifier is gone: no notifyRound, no Notification API, no unbidden window.focus(', () => {
  // ADR.md entry 58: one notifier for a round, and it is the daemon's. The
  // page-side notifyRound, its permission dance, and the click handler that
  // used to steal focus back are all deleted outright, not left unused --
  // see the criterion-21 grep in check-notify-cleanup.mjs for the tree-wide
  // assertion this narrows to src/ui.mjs's own client script.
  assert.equal(namedFunctionBody(ui, 'notifyRound'), null, 'the browser-side notifyRound must be deleted, not left as dead code');
  assert.ok(!/\bNotification\b/.test(ui), 'no reference to the browser Notification API may remain in the client script');
  // window.focus( used to appear exactly once, inside notifyRound's own click
  // handler -- the one deliberate exception to "never steal focus". With that
  // handler gone, nothing may pull the window forward at all any more.
  const focusCalls = ui.match(/window\.focus\(/g) || [];
  assert.equal(focusCalls.length, 0, 'window.focus( must not appear anywhere in the client script -- its one caller, the notification click handler, is deleted');
});

check('coming back to the tab clears the mark', () => {
  const clear = namedFunctionBody(ui, 'clearPendingMark');
  assert.ok(clear, 'expected clearPendingMark in src/ui.mjs');
  assert.match(clear, /setFaviconBadge\(0\)/);
  assert.ok(!/setTitleBadge/.test(clear), 'there is nothing left to un-title -- clearing must not reference the deleted title badge');
  assert.ok(/visibilitychange/.test(ui), 'the mark must clear when the document becomes visible again');
  assert.ok(/addEventListener\('focus'/.test(ui), 'and when the window regains focus');
  // A landed submit clears it too: nothing is pending once the round went out.
  assert.match(namedFunctionBody(ui, 'submitBoard'), /clearPendingMark\(\)/);
});

// --- dead/mismatched CSS --------------------------------------------------------

// Both of these used to be POSITIVE wiring checks -- one on the inline anchor
// button's own class, one on `.anchor-target`, the highlight a comment list entry
// applied to the heading it named. ADR.md entry 28 deleted the `md` anchor kind
// and both of those surfaces with it, so what is pinned now is their absence: the
// class-purity check below catches an orphaned RULE, but only an explicit check
// catches the markup, the client function and the rule all coming back together.
check('the inline anchor button and the .anchor-target highlight are gone, markup and stylesheet alike (ADR.md entry 28)', () => {
  const board = createBoard({ title: 'Anchors', blocks: [{ kind: 'markdown', text: '# Heading\n\n- one' }] });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(!/class="comment-btn [a-z-]+"/.test(markup), 'a markdown block must emit no inline anchor button');
  assert.ok(!markup.includes('data-anchor-kind="md"'), 'nothing may emit an md-kind anchor');
  assert.ok(!/\.inline-anchor-btn\b/.test(styles), 'the orphaned .inline-anchor-btn rule must be gone with the button it styled');
  assert.ok(!/\.comment-inline\b/.test(styles), 'the orphaned .comment-inline rule must be gone, not left beside its replacement');
  assert.ok(!/\.anchor-target\b/.test(styles), 'the orphaned .anchor-target rule must be gone with the gesture it styled');
  assert.equal(namedFunctionBody(ui, 'highlightAnchor'), null, 'highlightAnchor must be gone from src/ui.mjs');
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
  // Rounds became pages (ADR.md entry 42), so "may this page send" gained a
  // second half: the open round must exist AND be the page on screen. Both
  // halves are asserted, since dropping either is a way back to a live Send on
  // a round that is already out.
  assert.match(submitted, /setSendBarEnabled\(openRoundNumber\(\) !== null && currentRound === openRoundNumber\(\)\)/,
    'a submitted push must lock the send bar -- markRoundHistory cannot reach it, it is outside the round');
  assert.match(roundPush, /if \(followTheRound\) goToRound\(data\.round\);/,
    'a new round must bring the send bar back, which it does by making that round the page (goToRound -> refreshPager -> setSendBarEnabled)');
  assert.match(namedFunctionBody(ui, 'refreshPager'),
    /if \(!submitInFlight\) setSendBarEnabled\(open !== null && currentRound === open\)/,
    'and the one place that decides it reads both halves');
  const open = namedFunctionBody(ui, 'openRoundNumber');
  // Asked positively, and it has to be: since ADR 69 a round can close as 'abandoned' too
  // (a conversation declared a boundary and walked away), and "not sent" would read that
  // as still open -- a live Send bar on a board whose every submit is a 409, which is the
  // exact shape this whole check exists to keep off the screen.
  assert.match(open, /r\.status === 'open'/, 'the open round is the one still open, not merely the one not sent');
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
  // Tag/type-qualified, not a bare getElementById -- this document is parsed
  // straight from response bytes, so a
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
  // Six COMMENTABLE blocks: ADR.md entry 28 means "every block" now names the two
  // rendered kinds, and a markdown fixture would emit none at all.
  const board = createBoard({
    title: 'Six blocks',
    blocks: [1, 2, 3, 4, 5, 6].map(i => ({ kind: 'mermaid', text: `flowchart LR\n  A${i} --> B${i}` })),
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const emitted = [...markup.matchAll(/class="comment-target"/g)];
  assert.equal(emitted.length, 6, 'render.mjs emits one per commentable block, unconditionally');
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
 * string/template-literal and regex-literal boundaries --
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
  const emitters = ['src/render.mjs', 'src/ui.mjs', 'src/indexpage.mjs', 'src/markdown.mjs', 'src/theme.mjs', 'src/pomodoro-widget.mjs']
    .map(f => stripJsComments(readFileSync(path.join(repoRoot, f), 'utf8'))).join('\n');
  const ruled = new Set();
  for (const m of styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)) ruled.add(m[1]);
  const orphans = [...ruled].filter(c => !emitters.includes(c));
  assert.deepEqual(orphans, [], `src/styles.mjs rules on classes nothing emits: ${orphans.join(', ')}`);
});

// --- indexpage.mjs: the thread index's own render path ----------------
// buildThreadIndex, renderIndexPage, folderName, roundCount and threadRow (the last
// not exported -- exercised only through renderIndexPage's output, same as every
// other unexported render helper in this file) were imported by no test at all.
// `folderName` and `roundCount` gained an `export` here for exactly this
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
 * every tag and attribute (href, data-thread-id, data-rounds-left, the machine
 * `datetime` value, ...) and collapses whitespace, leaving only rendered text.
 * A "distinct rows" check comparing raw item HTML instead of this is worthless
 * -- href and data-thread-id differ by board id on every row regardless of
 * anything visible, so raw-string comparison passes even when a reviewer would
 * see three identical rows. This is exactly the shape of check that matters:
 * distinctness has to be asserted on what renders, not on markup a
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
  assert.equal(folderName('/Users/alex/Documents/claude-board/sub/dir'), 'dir');
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

check('the rounds-left badge counts open rounds that still ask something, not question blocks -- correctly singular at one, plural at two', () => {
  // Two board docs in one thread, the ordinary shape for a session that starts a
  // second board without closing the first. boardA's single open round carries
  // TWO question blocks; boardB's carries one. The count must read 2 -- one round
  // apiece -- never 3, which is what a question-block count (the predecessor this
  // replaces) would have read.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'rounds-left');
  mkdirSync(dir, { recursive: true });
  const boardA = createBoard({
    title: 'first',
    cwd: dir,
    blocks: [
      { kind: 'question', prompt: 'q1', widget: 'text' },
      { kind: 'question', prompt: 'q2', widget: 'text' },
    ],
  });
  const boardB = createBoard({
    title: 'second',
    cwd: dir,
    thread: boardA.thread,
    blocks: [{ kind: 'question', prompt: 'q3', widget: 'text' }],
  });
  const [thread] = buildThreadIndex([boardA, boardB]);
  assert.equal(thread.roundsLeft, 2, 'two open rounds that each ask something, regardless of how many question blocks either carries');
  assert.notEqual(thread.roundsLeft, 3, 'setup sanity: must not be counting the three question BLOCKS');

  const item = extractThreadItem(renderIndexPage({ threads: [thread] }), thread.boardId);
  assert.match(item, /2 rounds left/, 'plural at two');

  // Settle boardB's round, leaving exactly one open round on the thread.
  const qidB = boardB.blocks.find(b => b.kind === 'question').id;
  boardB.answers = { [qidB]: { status: 'answered', choice: 'x', note: '' } };
  boardB.rounds[0].status = 'sent';
  const [oneLeft] = buildThreadIndex([boardA, boardB]);
  assert.equal(oneLeft.roundsLeft, 1);
  const item2 = extractThreadItem(renderIndexPage({ threads: [oneLeft] }), oneLeft.boardId);
  assert.match(item2, /1 round left/, 'correctly singular at one');
  assert.doesNotMatch(item2, /1 rounds left/, 'never "1 rounds left"');
});

check('an index row with no open asking round renders no badge element at all -- not a zero-reading one', () => {
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'rounds-left-zero');
  mkdirSync(dir, { recursive: true });
  const board = createBoard({ title: 'settled', cwd: dir, blocks: [{ kind: 'question', prompt: 'q', widget: 'text' }] });
  const qid = board.blocks[0].id;
  board.answers = { [qid]: { status: 'answered', choice: 'x', note: '' } };
  board.rounds[0].status = 'sent';
  const [thread] = buildThreadIndex([board]);
  assert.equal(thread.roundsLeft, 0);
  const item = extractThreadItem(renderIndexPage({ threads: [thread] }), board.id);
  assert.doesNotMatch(item, /rounds-left-badge/, 'no badge element at all, zero-reading or otherwise');
  assert.doesNotMatch(item, /\brounds? left\b/, 'no leftover badge text either');
  assert.doesNotMatch(item, /class="thread-status"/, 'no empty status wrapper left in its place');
});

check('a question left deferred inside an already-SENT round contributes nothing to the count', () => {
  // A sent round cannot be returned to -- so once `applySubmit` marks a round `sent`,
  // whatever any of its questions were left as is no longer an open trip back to
  // the board, `deferred` included.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'rounds-left-deferred');
  mkdirSync(dir, { recursive: true });
  const board = createBoard({ title: 'x', cwd: dir, blocks: [{ kind: 'question', prompt: 'q', widget: 'text' }] });
  const qid = board.blocks[0].id;
  board.answers = { [qid]: { status: 'deferred', choice: null, note: '' } };
  board.rounds[0].status = 'sent';
  const [thread] = buildThreadIndex([board]);
  assert.equal(thread.roundsLeft, 0, 'a deferred question inside a SENT round is not an open round');
});

check('a round that asks nothing contributes nothing to the count, and the badge and the live dot never disagree', () => {
  // `applySubmit` is the only thing that marks a round `sent`, and a reviewer submits by
  // answering. So a round with no question block had no reachable way out of `open`, and
  // its row pulsed a live dot forever right beside its own honest empty badge.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'asks-nothing');
  mkdirSync(dir, { recursive: true });

  // The shape every render skill now posts: a pointer to a document, asking nothing.
  const pointer = createBoard({
    title: 'An html block that names a file',
    cwd: dir,
    blocks: [{ kind: 'markdown', text: 'see ~/Documents/renders/doc.html' }],
  });
  assert.equal(pointer.rounds[0].status, 'open', 'the round really is open -- nothing submitted it');
  const [pointerThread] = buildThreadIndex([pointer]);
  assert.equal(pointerThread.live, false, 'but nobody owes it anything, so it is not live');
  assert.equal(pointerThread.roundsLeft, 0);
  const pointerItem = extractThreadItem(renderIndexPage({ threads: [pointerThread] }), pointer.id);
  assert.doesNotMatch(pointerItem, /live-dot/);
  assert.doesNotMatch(pointerItem, /rounds-left-badge/, 'badge and live dot must agree: neither renders here');

  // A round that DOES ask is still live -- the fix must not silence a real prompt.
  const asking = createBoard({
    title: 'needs an answer',
    cwd: dir,
    blocks: [{ kind: 'question', prompt: 'which one?', widget: 'text' }],
  });
  const [askingThread] = buildThreadIndex([asking]);
  assert.equal(askingThread.live, true, 'an unanswered question is exactly what the dot is for');
  assert.equal(askingThread.roundsLeft, 1);
  const askingItem = extractThreadItem(renderIndexPage({ threads: [askingThread] }), asking.id);
  assert.match(askingItem, /live-dot/);
  assert.match(askingItem, /1 round left/, 'badge and live dot must agree: both render here');

  // And the case from the reported screenshot: a thread whose questions were all answered
  // and sent, then closed out with a summary round that asks nothing.
  const closed = createBoard({
    title: 'IBKR trade history',
    cwd: dir,
    blocks: [{ kind: 'question', prompt: 'scope?', widget: 'text' }],
  });
  const qid = closed.blocks.find(b => b.kind === 'question').id;
  closed.answers = { [qid]: { status: 'answered', choice: 'yes', note: '' } };
  closed.rounds[0].status = 'sent';
  addRound(closed, { title: 'wrap-up', blocks: [{ kind: 'markdown', text: 'here is the summary' }] });
  const [closedThread] = buildThreadIndex([closed]);
  assert.equal(closedThread.live, false, 'a closing summary must not re-arm the dot on a finished thread');
  assert.equal(closedThread.roundsLeft, 0, 'the wrap-up round asks nothing, so it must not re-arm the badge either');
});

check('an awaited page board (posted with wait: true) counts toward the badge and the live dot; the identical shape posted without wait counts toward neither', () => {
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'awaited-page-round');
  mkdirSync(dir, { recursive: true });
  const html = '<div class="mock"><button>Send</button></div>';

  const awaitedPage = createBoard({ title: 'awaited page', cwd: dir, blocks: [{ kind: 'html', html }], wait: true });
  assert.equal(awaitedPage.rounds[0].awaited, true, 'setup sanity: wait: true must mint awaited: true');
  const [awaitedThread] = buildThreadIndex([awaitedPage]);
  assert.equal(awaitedThread.live, true, 'an open awaited page round is a trip the reviewer still owes -- ADR.md entry 45');
  assert.equal(awaitedThread.roundsLeft, 1);
  const awaitedItem = extractThreadItem(renderIndexPage({ threads: [awaitedThread] }), awaitedPage.id);
  assert.match(awaitedItem, /live-dot/);
  assert.match(awaitedItem, /1 round left/);

  const plainPage = createBoard({ title: 'plain page', cwd: dir, blocks: [{ kind: 'html', html }] });
  assert.equal(plainPage.rounds[0].awaited, false, 'setup sanity: no wait must mint awaited: false');
  const [plainThread] = buildThreadIndex([plainPage]);
  assert.equal(plainThread.live, false, 'a fire-and-forget page board (no wait) asks nothing and hears nothing back');
  assert.equal(plainThread.roundsLeft, 0);
  const plainItem = extractThreadItem(renderIndexPage({ threads: [plainThread] }), plainPage.id);
  assert.doesNotMatch(plainItem, /live-dot/);
  assert.doesNotMatch(plainItem, /rounds-left-badge/);
});

check('AC 9: a legacy round with no `awaited` key at all still counts when it carries a question (the pre-ticket-01 shape), and still does not when it carries neither a question nor an explicit wait', () => {
  // The trap this ticket names explicitly: a board persisted before ADR.md entry
  // 45 landed carries NEITHER `awaited` NOR `awaitDeadline` on any of its round
  // records -- `undefined`, not `false`. openAwaitedRounds (src/indexpage.mjs)
  // must read such a board through roundIsAwaited's (src/badge.mjs) legacy
  // fallback -- the OLD shape-based inference -- rather than a bare `r.awaited`
  // read, or every one of a legacy board's open question rounds would silently
  // stop counting toward the badge and the tab mark the moment this ticket
  // shipped, invisible to any check written only against freshly-minted boards.
  const dir = path.join(fixturesDir, 'indexpage-fixtures', 'legacy-round-shape');
  mkdirSync(dir, { recursive: true });

  const legacyAsking = createBoard({ title: 'legacy asking', cwd: dir, blocks: [{ kind: 'question', prompt: 'q', widget: 'text' }] });
  delete legacyAsking.rounds[0].awaited;
  delete legacyAsking.rounds[0].awaitDeadline;
  assert.ok(!('awaited' in legacyAsking.rounds[0]), 'setup sanity: the key must be genuinely absent, not merely undefined-valued');
  const [legacyAskingThread] = buildThreadIndex([legacyAsking]);
  assert.equal(legacyAskingThread.live, true, 'a legacy round carrying a question block must still count -- the regression this ticket must not introduce');
  assert.equal(legacyAskingThread.roundsLeft, 1);

  const legacyPage = createBoard({ title: 'legacy page', cwd: dir, blocks: [{ kind: 'html', html: '<div class="mock"><button>Send</button></div>' }] });
  delete legacyPage.rounds[0].awaited;
  delete legacyPage.rounds[0].awaitDeadline;
  const [legacyPageThread] = buildThreadIndex([legacyPage]);
  assert.equal(legacyPageThread.live, false, 'a legacy page round with no question block reads not-awaited under the same old inference, so it must not count either');
  assert.equal(legacyPageThread.roundsLeft, 0);
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
  // Keying by project
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
  // were the title itself. There was a regression here specifically
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
  // Round 3 open AND asking something. The question is what makes the row live at all
  // (a round nobody can answer is not waiting on anyone), and it is also the thing this
  // check is about: the fragment exists to land the reviewer on the prompt still owed.
  addRound(live, { blocks: [{ kind: 'question', prompt: 'the one still waiting', widget: 'text' }] });
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

// --- the index page's client script ------------------------------------
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
  // querySelector: () => null -- the pomodoro widget's own
  // initPomodoroWidget() looks up 'div#pomodoro-widget' first (tag-qualified,
  // never a bare getElementById -- see "no client script looks an id up bare"
  // in test/check-archive-ids.mjs) and bails out immediately when it is
  // absent, which real page markup this minimal stand-in does not model.
  // Proven separately by the pomodoro-specific checks further down. Without
  // this stub, indexScript still parses fine but THROWS the moment it runs,
  // for a reason that has nothing to do with relTime/refresh.
  const fakeDocument = { querySelectorAll: sel => (sel === '.rel-time' ? els : []), querySelector: () => null };
  let intervalFn = null;
  let intervalMs = null;
  const fakeSetInterval = (fn, ms) => { intervalFn = fn; intervalMs = ms; return 1; };
  // Throws (a real syntax error, or a thrown reference to something undefined in
  // this stand-in) if indexScript does not actually parse and run end to end.
  //
  // 'EventSource' is DECLARED and never passed, which is the whole point: it binds
  // the name to undefined inside this scope, so initIndexStream's own
  // `typeof EventSource === 'undefined'` guard takes its early return for a reason
  // this file controls. Left off the list, the name would resolve to whatever the
  // HOST happens to expose -- and node has had a global EventSource behind a flag
  // since 22.x -- at which point this stand-in would construct a real one against
  // the relative URL '/api/events' and throw, from a check that is about relTime.
  // A test that passes because of the interpreter's build options is not passing.
  // The three sibling sites below declare it for the same reason;
  // test/check-index-live.mjs is the one place that really supplies one.
  new Function('document', 'setInterval', 'EventSource', indexScript)(fakeDocument, fakeSetInterval);
  assert.equal(typeof intervalFn, 'function', 'refresh must be wired through setInterval so an open tab keeps relative times fresh');
  assert.notEqual(els[0].textContent, '2020-01-01 00:00:00Z', 'refresh() must actually run once up front and overwrite the placeholder text, not wait for the first interval tick');
  // The narrowest bucket relTime has ("a minute ago", 45s-90s) is 45 seconds
  // wide. A poll slower than that can step clean over the bucket depending on
  // where a row's load time happens to land within it -- a defect
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
  const noopDocument = { querySelectorAll: () => [], querySelector: () => null }; // see the check above: initPomodoroWidget's own bail-out
  const noopSetInterval = () => {};
  const fn = new Function('document', 'setInterval', 'EventSource', indexScript + '; return relTime;')(noopDocument, noopSetInterval);
  if (typeof fn !== 'function') throw new Error('indexScript extraction did not yield relTime as a function');
  return fn;
}

check('relTime: pinned at the exact boundaries its own if-chain names, with a fixed "now" rather than the wall clock', () => {
  // relTime rounds each unit FIRST and thresholds the ROUNDED value (moment.js's
  // own algorithm) rather than thresholding the raw ms diff and rounding only for
  // display -- the former shape had a real bug: a diff that
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

// A palette change has to stay a one-block edit. This invariant already rotted once -- the header comment above `styles`
// asserted it while 21 rules quietly reached past the token block for a raw
// literal -- so it is enforced here instead of merely claimed in prose.
const RAW_COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|\brgba?\([^)]*\)/;

// A "token block" is any rule -- :root, or :root nested inside a @media query
// (a light-palette variant), or any future selector -- whose declarations are
// ALL either a custom property (`--name: value;`) or `color-scheme` (the one
// non-custom-property declaration a palette's :root carries alongside it).
// Blanking every such leaf rule out (character-for-character, so line numbers
// still line up) before scanning is what lets this check not know the token
// block's selector in advance -- it stays correct however many get added, and
// it does not require special-casing that second block by name.
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
  // The binding amendment: "The sandboxed stage stylesheet
  // (stageAgentScript) is exempt and keeps its literal." A prior version of
  // this exemption let `stageAgentScript()`'s injected CSS satisfy the SAME
  // "token block" shape the check above blanks out (a `:root { --accent:
  // <anything> }` rule), which made the check self-certifying: it would have
  // passed even if the stage's literal were changed to '#ff0000', because
  // "wrapped in a one-declaration :root block" was
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
  // it tracked the DARK value, on a surface that was white in BOTH palettes,
  // leaving the outline at 2.61:1 -- under the 3:1 WCAG floor for non-text
  // UI, on the stage's only per-element targeting feedback. src/styles.mjs's
  // LIGHT palette comment had already rejected that exact colour on white
  // ("#7c9cff on white is ~2.3:1"); nothing connected the two. So the premise
  // and the requirement are asserted directly, and the palette pin is kept
  // only as a drift guard on top of them.
  //
  // The PREMISE is the half that changed (2026-08-05). It used to be "both
  // palettes' --stage-bg are identical, so the stage is theme-independent and
  // one literal is trivially right". The stage surface is now a neutral
  // artboard per palette and a mock owns its own background, so the premise
  // this pins is the opposite one -- the two surfaces DIFFER -- and the
  // requirement below has to hold against each of them separately rather than
  // against the single colour there used to be. Note what that costs the
  // decoy-resistance of the trio: "one literal" is no longer free, it is a
  // claim about arithmetic, which is exactly what the requirement assertion
  // now checks twice.
  assert.notEqual(palettes.dark['--stage-bg'], palettes.light['--stage-bg'],
    `--stage-bg is the same colour in both palettes (${palettes.dark['--stage-bg']}), which is the premise this stage's design overturned: the stage surface is a neutral artboard that differs per palette, and a mock that wants a particular canvas paints it itself (src/styles.mjs's two --stage-bg comments). One surface for both themes means either the dark board carries a slab of the light board's chrome or the reverse`);

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
  // '#fff' and '#ffffff' are the same colour and only one of them parses here.
  const expand = (hex) => (/^#[0-9a-fA-F]{3}$/.test(hex) ? '#' + hex.slice(1).replace(/./g, (c) => c + c) : hex);

  // The requirement, once per surface: the outline is one literal and it has
  // to clear the bar on BOTH artboards, not on whichever one happens to be
  // under a reviewer's theme. (Per-palette hexes would satisfy this
  // too -- delivered over the parent's 'mode' postMessage -- and this loop is
  // the assertion that would then run twice with two hexes instead of one.)
  for (const [themeName, palette] of Object.entries(palettes)) {
    const stageBg = expand(palette['--stage-bg']);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(stageBg),
      `setup failure: the ${themeName} palette's --stage-bg (${palette['--stage-bg']}) is not a hex this check can measure -- if the stage surface becomes an rgba() or a gradient, this contrast assertion has to learn to composite it, not be dropped`);
    // The legibility half, and it is not implied by the outline bar
    // below: a near-black surface would leave the mid-blue outline at ~3.16:1
    // (passing) while rendering a mock that paints no background invisible.
    // Such a mock sets no color either, so its text is the UA's black -- which
    // is the whole reason both artboards are light neutrals rather than one
    // light and one dark.
    const inkRatio = contrast('#000000', stageBg);
    assert.ok(inkRatio >= 4.5,
      `the ${themeName} palette's stage surface ${stageBg} leaves the UA's default BLACK text at ${inkRatio.toFixed(2)}:1 -- under the 4.5:1 body-text bar. A mock that paints no background of its own also sets no color, so that is exactly what it renders in; the stage surface has to stay light enough to read it in BOTH palettes (src/styles.mjs's --stage-bg comments)`);

    const ratio = contrast(STAGE_ACCENT_HEX, stageBg);
    assert.ok(ratio >= 3,
      `the stage hover outline (STAGE_ACCENT_HEX, src/render.mjs) is ${ratio.toFixed(2)}:1 against the ${themeName} palette's stage surface ${stageBg} -- under the 3:1 WCAG minimum for non-text UI. This outline is the ONLY per-element targeting feedback the stage gives, so a reviewer who cannot see it can be led to anchor a comment to an element they never saw highlighted (the same failure the '--accent: transparent' hijack caused, reached by a palette choice instead). One literal serves both palettes only for as long as it clears 3:1 on both: either move the surfaces further apart in luminance, or give the stage a per-palette hex over the parent's 'mode' message`);
  }

  assert.equal(STAGE_ACCENT_HEX, palettes.light['--accent'],
    `the stage's hand-maintained literal (STAGE_ACCENT_HEX, src/render.mjs) no longer matches --accent's LIGHT value (${palettes.light['--accent']}) -- light, not dark, because both stage artboards are LIGHT neutrals (a srcdoc that paints no background renders the UA's black text, so neither can be dark), and the light accent is the one tuned for contrast on a light surface (src/styles.mjs's LIGHT palette comment). QUIRKS.md "Two stylesheets, one palette" requires updating it by hand when that token changes`);
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

check('a duplicate session cookie cannot shadow the real one, at EITHER end of the header', () => {
  // Cookies ignore ports (RFC 6265 section
  // 8.5), so any other server on this host can set a second cb_session. Whichever single
  // end the parse picked, the other end shadowed the real credential and locked the
  // reviewer out of every board -- permanently, because bin/authorize.mjs re-mints the
  // Path=/ key and cannot clear a duplicate set at a longer path, so the one command the
  // refusal page names could not fix it.
  // The original fix read section 5.4 backwards: it orders LONGER paths FIRST, and this
  // daemon's cookie is Path=/, the shortest possible, so it sorts LAST. Section 5.4 is
  // also only a SHOULD whose own note calls servers depending on this order "erroneously"
  // dependent. So neither end is safe and the parse searches every value.
  // Ablation: make sessionCookieMatches pick values[0] or values.at(-1) and one of the
  // three assertions below reds.
  const secret = 'c'.repeat(64);
  const real = sessionToken(secret);
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${real}; ${SESSION_COOKIE}=junk`, secret), true, 'a duplicate appended after the real cookie must not shadow it');
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=${real}; other=1; ${SESSION_COOKIE}=${'e'.repeat(64)}`, secret), true, 'nor a duplicate that is the right shape but the wrong value');
  assert.equal(sessionCookieMatches(`${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${real}`, secret), true, 'and a shadowing duplicate sorting FIRST must not lock the reviewer out either -- §5.4 puts longer paths first, and this daemon\'s cookie is Path=/, so it sorts last');
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
  // slab where every other route rendered #eef1f7.
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
  // "Submit collapses into the read credential", and the deletion lands
  // in the same slice as the gate. A leftover reference is a leftover code path.
  const files = ['src/secret.mjs', 'src/server.mjs', 'src/handoff.mjs', 'src/ui.mjs', 'bin/mcp.mjs', 'bin/authorize.mjs', 'PROTOCOL.md'];
  for (const f of files) {
    const src = readFileSync(path.join(repoRoot, f), 'utf8');
    for (const dead of ['cb_submit', 'SUBMIT_COOKIE', 'submitToken']) {
      assert.ok(!src.includes(dead), `${f} still mentions ${dead}`);
    }
  }
});

// --- the pomodoro widget ---------------------------
// Drives the REAL indexScript against the REAL renderIndexPage() markup, through
// test/dom-stand-in.mjs -- never a hand-summary of what the widget does
// (QUIRKS.md: "a mock of someone else's renderer is worth exactly as much as the
// last time someone checked it against the real thing"). `fetch` is stubbed on
// globalThis for the duration of each check (same idiom test/check-enter.mjs's
// withFetchCapture and test/check-comment-mode.mjs already use for `ui`);
// `setInterval` is still the explicit new Function(...) parameter the indexScript
// checks above already rely on, which is what lets a check fire a "tick" or a
// "poll" by hand instead of racing a real 1s/15s timer. This whole section is
// async (a local `checkAsync`, awaited below) because a pomodoro fetch's own
// `.then()` chain needs at least one real event-loop turn to settle -- the plain
// synchronous `check()` above cannot observe that.

let asyncFailures = 0;
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    asyncFailures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

/** Stub globalThis.fetch for the duration of `fn(calls)`, recording every call
 * (url, method, credentials, parsed JSON body) and resolving each with
 * `handler(call)` as the response's JSON body. Restores the original fetch even
 * if `fn` throws -- same discipline test/check-archive-ids.mjs's own fetch stubs
 * already follow. */
async function withPomodoroFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  // Tagged so loadIndexWithPomodoro below can ENFORCE the precondition it documents
  // rather than trust it. The widget fetches during init, so a load outside this
  // helper puts a real request on the wire from a pure check and leaves the rest of
  // the file guessing which fetch answered it.
  const stub = (url, opts) => {
    const call = {
      url: String(url),
      method: (opts && opts.method) || 'GET',
      credentials: opts && opts.credentials,
      body: opts && opts.body ? JSON.parse(opts.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handler(call)) });
  };
  stub.pomodoroStub = true;
  globalThis.fetch = stub;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

/** Empties the microtask queue (and then some): fetchPomodoro/postPomodoro's own
 * chain is `fetch(...).then(r => r.json()).then(data => {...})`, and the stub
 * above adds its own `Promise.resolve()` on top -- several microtask hops.
 * `setTimeout(resolve, 0)` is scheduled as a macrotask, and Node drains every
 * pending microtask before running the next macrotask, so one call here is
 * always enough regardless of exactly how many `.then()` links are chained. */
function flushPomodoro() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Fixture cue values, read from cueNames() itself rather than hardcoded --
// mirrors src/cues.mjs's own "enumerated, never a second guess at the
// directory" discipline, so these checks stay correct on whatever machine
// actually runs them instead of assuming a specific 14 ("a
// picker offering a name the bundle cannot resolve is a silent boundary").
// Three distinct names are what let a check prove the three pickers actually
// remember their own choice independently rather than three
// fields that happen to agree by accident.
const ALL_CUES = cueNames();
const CUE_A = ALL_CUES[1] || NO_CUE;
const CUE_B = ALL_CUES[2] || NO_CUE;
const CUE_C = ALL_CUES[3] || NO_CUE;

// The two menubar keys ride along at their DEFAULTS here, so
// every check using this fixture reads a document shaped exactly like the one the
// daemon actually serves; the checks that are about those two keys set their own
// values rather than leaning on these.
const POMODORO_SETTINGS = { workMin: 25, breakMin: 5, longBreakMin: 15, longEvery: 4, notify: true, bannerLevel: 'this-board', cueWork: CUE_A, cueBreak: CUE_B, cueLongBreak: NO_CUE, menubarCountdown: true, menubarHidden: false };

/** Parse the real renderIndexPage() output and run the real indexScript against
 * it, capturing every setInterval registration by hand (there are three: refresh's
 * own 15s poll, tickPomodoro's 1s local repaint, and fetchPomodoro's own poll) so
 * a check can fire any one of them without a real timer. Must run with
 * globalThis.fetch already stubbed (initPomodoroWidget's own fetchPomodoro() call
 * fires synchronously as part of loading).
 *
 * `window`/`location` join the two parameters this already passed, matching the
 * `new Function('document', 'window', 'location', ui)` contract every check that
 * drives `ui` already uses -- indexScript reads both for the settings panel's
 * `#pomodoro-settings` fragment. The window is the document's OWN defaultView
 * (test/dom-stand-in.mjs wires one per parsed document), so a 'hashchange' a
 * check dispatches on `loaded.window` reaches the listener the real script
 * registered, rather than a throwaway stub nothing is attached to. `location` is
 * a plain `{ hash }`, the same shape this suite's other location stand-ins take;
 * `hash` defaults to none, which is what every check that is not about the
 * fragment wants. */
function loadIndexWithPomodoro({ hash = '' } = {}) {
  assert.ok(globalThis.fetch && globalThis.fetch.pomodoroStub,
    'setup failure: loadIndexWithPomodoro must run inside withPomodoroFetch -- initPomodoroWidget fetches while loading, so an unstubbed load sends a real request out of a pure check');
  const document = parseHTML(renderIndexPage({ threads: [] }));
  const intervals = [];
  const fakeSetInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const location = { hash, pathname: '/', search: '' };
  // A history stand-in that RECORDS rather than one that merely absorbs the call: the
  // fragment being spent after it has been acted on is a behaviour with a consequence
  // (a second press of the popover's gear works), so a check has to be able to see it.
  const history = { calls: [], replaceState(state, title, url) { this.calls.push(url); location.hash = ''; } };
  new Function('document', 'setInterval', 'window', 'location', 'history', 'EventSource', indexScript)(document, fakeSetInterval, document.defaultView, location, history);
  return { document, intervals, window: document.defaultView, location, history };
}

function pomodoroTickFn(intervals) {
  const entry = intervals.find(e => e.ms === 1000);
  assert.ok(entry, 'setup failure: tickPomodoro was never registered via setInterval(tickPomodoro, 1000)');
  return entry.fn;
}

/** The widget's own re-fetch poll (POMODORO_POLL_MS), told apart from
 * `refresh`'s 15s thread-list poll by being the LAST registration at that
 * interval -- initPomodoroWidget runs after refresh's own setInterval, and both
 * currently sit at 15000. Fired by hand so a check can land a full re-fetch at a
 * chosen moment instead of waiting a real 15 seconds. */
function fetchPomodoroFn(intervals) {
  const matches = intervals.filter(e => e.ms !== 1000);
  assert.ok(matches.length, 'setup failure: no pomodoro re-fetch interval was registered');
  return matches[matches.length - 1].fn;
}

check('pomodoro widget: the markup is emitted in index-head-actions, beside themeToggle(), with all eleven settings fields present', () => {
  const html = renderIndexPage({ threads: [] });
  assert.match(html, /<div class="pomodoro-widget" id="pomodoro-widget">/);
  assert.match(html, /<span class="pomodoro-status" id="pomodoro-status">/);
  // A switch with a readable state, never the old hidden Pause/Resume pill: it
  // wore .mode-toggle, whose author-sheet `display: inline-flex` beats the UA
  // sheet's `[hidden] { display: none }`, so `hidden` never actually hid it.
  // Asserting the ABSENCE of `hidden` here is what keeps that from coming back.
  assert.match(html, /<button type="button" class="pomodoro-switch" id="pomodoro-toggle" role="switch" aria-checked="false"/, 'the control must be a role="switch" with a server-rendered off state -- nothing is known until the first fetch resolves');
  assert.doesNotMatch(html, /id="pomodoro-toggle"[^>]*\shidden/, 'the switch must never rely on the `hidden` attribute/property: .pomodoro-switch sets `display`, and an author display rule outranks the UA stylesheet\'s [hidden] rule');
  assert.match(html, /id="pomodoro-toggle"[^>]*aria-label="Start pomodoro"/, 'an icon-only control must name the action it performs');
  assert.match(html, /<details class="pomodoro-settings" id="pomodoro-settings">/, 'the settings panel must be a <details> -- collapsed by default with no JS required to open it');
  assert.match(html, /<form class="pomodoro-settings-form" id="pomodoro-settings-form">/);
  // One control per settings key, and the control's `name` IS the key -- which is
  // what lets pomodoroSyncForm and onPomodoroSettingsSubmit look every field up by
  // the same spelling the daemon stores. The two menubar keys
  // are on this list for that reason even though one of them renders as its own
  // negation ("Show in menu bar"): the inversion is in the ticked STATE, never in
  // the name.
  for (const field of ['workMin', 'breakMin', 'longBreakMin', 'longEvery', 'notify', 'bannerLevel', 'cueWork', 'cueBreak', 'cueLongBreak', 'menubarCountdown', 'menubarHidden']) {
    assert.match(html, new RegExp(`name="${field}"`), `settings form must carry a ${field} field`);
  }
  // The retired boolean ("not kept as a master mute") must be
  // gone entirely -- markup, not just unused.
  assert.doesNotMatch(html, /name="sound"/, 'the sound checkbox must be retired -- the three cue pickers replace it');
  assert.match(html, /id="pomodoro-reset"/);
  // Beside themeToggle(), not replacing it -- the theme control must still render.
  // Matched by the real <button ... id="theme-toggle"> tag shape, not a bare
  // substring search: 'pomodoro-widget'/'theme-toggle' both also appear in this
  // file's own CSS comments (src/styles.mjs) and in indexScript's querySelector
  // strings, so a plain indexOf() compares whichever occurrence happens to sort
  // first among ALL of those, not the two real markup elements this check
  // actually cares about (caught by running this check before adding this
  // comment -- the CSS-comment occurrence sorted first and broke the ordering
  // assertion for a reason that had nothing to do with the real markup).
  const widgetMatch = html.match(/<div class="pomodoro-widget" id="pomodoro-widget">/);
  const themeMatch = html.match(/<button type="button" id="theme-toggle"/);
  assert.ok(widgetMatch && themeMatch, 'setup failure: could not locate both real markup elements');
  assert.ok(widgetMatch.index < themeMatch.index, 'both controls must render inside the same header, the widget before the theme toggle');
});

check('pomodoro widget: Restart/Forward render as one segmented pill between the countdown and the switch -- real buttons, keyboard-reachable, named for a screen reader, always present', () => {
  const html = renderIndexPage({ threads: [] });
  assert.match(html, /<span class="pomodoro-ctl-group">/, 'the pair must be one pill, not two independent controls');
  // Real <button>s, not a div/span wearing a click handler -- that is the whole
  // of what makes them keyboard-reachable with no extra tabindex plumbing (a
  // <span onclick> is invisible to Tab).
  const restartMatch = html.match(/<button type="button" class="pomodoro-ctl" id="pomodoro-restart" aria-label="Restart interval" title="Restart interval">/);
  const forwardMatch = html.match(/<button type="button" class="pomodoro-ctl" id="pomodoro-forward" aria-label="Forward to next interval" title="Forward to next interval">/);
  assert.ok(restartMatch, 'Restart must be a real <button>, icon-only, carrying both an aria-label and a matching title');
  assert.ok(forwardMatch, 'Forward must be a real <button>, icon-only, carrying both an aria-label and a matching title');
  // Restart left, Forward right, and the whole pill sits between the countdown
  // and the switch -- ordering, not just presence.
  const statusMatch = html.match(/<span class="pomodoro-status" id="pomodoro-status">/);
  const toggleMatch = html.match(/<button type="button" class="pomodoro-switch" id="pomodoro-toggle"/);
  assert.ok(statusMatch && toggleMatch, 'setup failure: could not locate the countdown or the switch');
  assert.ok(
    statusMatch.index < restartMatch.index && restartMatch.index < forwardMatch.index && forwardMatch.index < toggleMatch.index,
    'expected countdown, then Restart, then Forward, then the switch, in that order'
  );
  // Nothing here ever hides the pair -- unlike the switch's aria-checked, there
  // is no idle-vs-running variant of this markup at all, which is what makes
  // "always present" true by construction rather than by a runtime check.
  assert.doesNotMatch(html.slice(restartMatch.index, forwardMatch.index + 200), /\shidden(?:[\s=>]|$)/, 'the controls must never rely on the `hidden` attribute -- always present means always present');
});

check('pomodoro widget: the three cue rows read Work / Short break / Long break under a hairline and a "Cues" caption, and the duration row beside them is relabeled to match', () => {
  const html = renderIndexPage({ threads: [] });
  assert.match(html, /<hr class="pomodoro-settings-divider">/, 'the Cues section needs its own hairline -- no fold, no tab');
  assert.match(html, /<div class="pomodoro-settings-caption">Cues<\/div>/);
  // `<select name="x"` with no closing `>`, so an attribute added to the tag later
  // (aria-label, say) does not fail an assertion about the row's LABEL, which is the
  // only thing this check is about. The pinned part is the visible wording the spec
  // chose -- Work / Short break / Long break -- and that it wraps the right field.
  assert.match(html, /<label class="pomodoro-field">Work<select name="cueWork"[ >]/);
  assert.match(html, /<label class="pomodoro-field">Short break<select name="cueBreak"[ >]/);
  assert.match(html, /<label class="pomodoro-field">Long break<select name="cueLongBreak"[ >]/);
  // Every cue picker carries a group-qualified accessible name. The "Cues" caption
  // above is a plain div: browse mode reads it, tabbing does not, and tabbing is how
  // this panel is used -- so without these the three combo boxes announce as bare
  // "Work" / "Short break" / "Long break" straight after the identically-worded
  // duration rows. Each label must still CONTAIN the visible text, or a voice-control
  // user saying "click Work" stops matching (WCAG 2.5.3).
  for (const [field, visible] of [['cueWork', 'Work'], ['cueBreak', 'Short break'], ['cueLongBreak', 'Long break']]) {
    const m = html.match(new RegExp(`<select name="${field}"[^>]*aria-label="([^"]*)"`));
    assert.ok(m, `${field} must carry an aria-label -- the Cues caption is not announced while tabbing`);
    assert.ok(m[1].includes(visible), `${field}'s accessible name ("${m[1]}") must contain its visible label ("${visible}")`);
    assert.notEqual(m[1], visible, `${field}'s accessible name must say more than the visible label, or it is indistinguishable from the duration row of the same name`);
  }
  // The duration row keeps its own wording, relabeled from "Break (min)" to
  // "Short break (min)" so it matches the cue row beside it.
  assert.match(html, /<label class="pomodoro-field">Short break \(min\)<input type="number" name="breakMin"/);
  assert.doesNotMatch(html, /<label class="pomodoro-field">Break \(min\)</, 'the old, unqualified "Break (min)" label must be gone');
});

check('pomodoro widget: each cue picker offers exactly cueNames() -- None plus the sounds this machine actually has -- and nothing else', () => {
  const html = renderIndexPage({ threads: [] });
  const names = cueNames();
  for (const field of ['cueWork', 'cueBreak', 'cueLongBreak']) {
    const m = html.match(new RegExp(`<select name="${field}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(m, `setup failure: no <select name="${field}"> found`);
    const values = [...m[1].matchAll(/<option value="([^"]*)">/g)].map(x => x[1]);
    // Compared against the REAL cueNames() output, not a hand-typed list of
    // 14 -- src/cues.mjs's own header comment is exactly why: a hardcoded
    // list here would be right about a stock machine and silently wrong
    // about one whose /System/Library/Sounds has been pruned or added to.
    assert.deepEqual(values, names, `${field}'s options must be exactly cueNames(), in the same order`);
  }
});

check('pomodoro widget: the settings control is an icon, and the icon carries a name', () => {
  const html = renderIndexPage({ threads: [] });
  const summary = html.match(/<summary class="pomodoro-settings-summary"[^>]*>([\s\S]*?)<\/summary>/);
  assert.ok(summary, 'setup failure: no settings <summary> rendered');
  // "Settings", not "Pomodoro settings": the panel behind this cogwheel is the
  // index's general settings panel now -- the pomodoro is one captioned section in
  // it, beside Banners, Cues and Store -- and the one name the panel has must not
  // claim it is the pomodoro's.
  assert.match(summary[0], /aria-label="Settings"/, 'an icon-only control must be named for a screen reader (ui-ux-pro-max accessibility priority 1)');
  assert.match(summary[0], /title="Settings"/, 'and named on hover for everyone else');
  assert.match(summary[1], /^<svg\b/, 'the summary\'s content must be the cogwheel glyph itself');
  assert.doesNotMatch(summary[1], /[Ss]ettings/, 'the visible label text must be gone -- the icon replaces it, it does not sit beside it');
  // Inline SVG, never an emoji or an external asset (QUIRKS.md "No external
  // assets, ever"; ui-ux-pro-max style rules name emoji-as-icon as the
  // anti-pattern). Matches how src/theme.mjs draws its own three glyphs.
  assert.match(summary[1], /stroke="currentColor"/, 'the glyph must be a stroke-based inline SVG in the same family as src/theme.mjs\'s icons');
});

check('pomodoro widget: the status text alone denies selection; the settings panel\'s inputs and labels are untouched', () => {
  const statusRule = styles.match(/\.pomodoro-status\s*\{[^}]*\}/);
  assert.ok(statusRule, 'setup failure: no .pomodoro-status rule found in src/styles.mjs');
  assert.match(statusRule[0], /user-select:\s*none/, '.pomodoro-status must deny selection -- a double-click or a drag across the countdown must select nothing');

  // The rest of the widget is buttons, which never need it, and the settings
  // panel is real <input>/<label> form controls the reader must still be able to
  // select and copy from. No OTHER pomodoro-scoped rule may carry the same
  // property -- a broad `.pomodoro-widget *` or similar would also catch the
  // form.
  const otherPomodoroRules = [...styles.matchAll(/\.pomodoro-[a-z-]+(?:[^{]*)\{[^}]*\}/g)]
    .filter(m => !m[0].startsWith('.pomodoro-status'));
  for (const m of otherPomodoroRules) {
    assert.doesNotMatch(m[0], /user-select:\s*none/, `only .pomodoro-status may deny selection, found it in: ${m[0].slice(0, 60)}...`);
  }
});

check('pomodoro widget: reuses formatCountdown verbatim -- indexScript embeds the real function source, not a second mm:ss formatter', () => {
  assert.ok(indexScript.includes(formatCountdown.toString()), 'indexScript must contain formatCountdown\'s own real source, spliced in via .toString() (src/ui.mjs\'s roundNumberLabel/computeBoardPatch technique), not a hand-copied restatement of it');
  // A second, independently written formatter would very likely reach for the
  // same padStart(2, '0') idiom formatCountdown itself uses -- counting
  // occurrences catches that shape of regression without demanding indexScript
  // contain literally nothing else that mentions padStart.
  const padStartInScript = (indexScript.match(/padStart/g) || []).length;
  const padStartInFormatCountdown = (formatCountdown.toString().match(/padStart/g) || []).length;
  assert.equal(padStartInScript, padStartInFormatCountdown, 'indexScript must not contain a second, hand-written mm:ss formatter alongside the embedded formatCountdown');
});

check('pomodoro widget: polls on the same order of magnitude as refresh\'s own 15s poll, never every second', () => {
  const m = indexScript.match(/POMODORO_POLL_MS\s*=\s*(\d+)/);
  assert.ok(m, 'setup failure: POMODORO_POLL_MS not found in indexScript');
  const ms = Number(m[1]);
  assert.ok(ms >= 5000 && ms <= 20000, `POMODORO_POLL_MS must be a modest poll interval, not per-second -- got ${ms}ms`);
});

check('pomodoroRemainingMs: a browser clock skewed by a full minute renders the identical countdown once the daemon-derived offset is applied', () => {
  const remainingMs = extractIndexScriptFn('pomodoroRemainingMs');
  const deadline = 1_000_000_000;
  const serverNow = deadline - 5 * 60_000; // 5 minutes left, per the daemon's own clock
  const timer = { phase: 'work', deadline, paused: false };

  // Tab A: a browser clock that happens to agree with the server exactly.
  const msA = remainingMs(timer, /* offset */ 0, /* browserNow */ serverNow);
  assert.equal(msA, 5 * 60_000);

  // Tab B: a browser clock running a full minute FAST. The offset (computed at
  // fetch time as serverNow - browserNow, exactly what fetchPomodoro computes)
  // absorbs the skew entirely.
  const skewedBrowserNow = serverNow + 60_000;
  const offsetB = serverNow - skewedBrowserNow; // -60000
  const msB = remainingMs(timer, offsetB, skewedBrowserNow);
  assert.equal(msB, msA, 'two clocks disagreeing by a minute must render the identical remaining time once each has its own daemon-derived offset applied -- this is the "two open tabs show the same remaining time" property, reduced to one pure function');

  // Sanity: the skew must actually matter to a NAIVE calculation (deadline -
  // browserNow, no offset at all), or the assertion above would pass by
  // accident regardless of whether the offset correction exists at all.
  const naive = Math.max(0, deadline - skewedBrowserNow);
  assert.notEqual(naive, msA, 'setup sanity: dropping the offset correction must actually change the answer, or this check proves nothing');
});

check('pomodoroRemainingMs: a paused timer ignores the clock entirely, returning the frozen remainingMs', () => {
  const remainingMs = extractIndexScriptFn('pomodoroRemainingMs');
  const ms = remainingMs({ phase: 'break', paused: true, remainingMs: 42_000 }, /* offset */ 999_999, /* browserNow */ 0);
  assert.equal(ms, 42_000, 'a paused timer must never consult offset/browserNow -- there is no live deadline left on the wire to subtract anything from');
});

check('pomodoroRemainingMs: no timer at all is 0, never a thrown error', () => {
  const remainingMs = extractIndexScriptFn('pomodoroRemainingMs');
  assert.equal(remainingMs(null, 0, Date.now()), 0);
});

/** Same `new Function(src + '; return name;')()` extraction technique
 * extractRelTime already uses on indexScript, generalised to any of its plain
 * top-level function declarations -- safe here for the same reason: none of
 * indexScript's pomodoro functions are hidden inside an IIFE. */
function extractIndexScriptFn(name) {
  const noopDocument = { querySelectorAll: () => [], querySelector: () => null };
  const noopSetInterval = () => {};
  const fn = new Function('document', 'setInterval', 'EventSource', `${indexScript}\n; return ${name};`)(noopDocument, noopSetInterval);
  if (typeof fn !== 'function') throw new Error(`indexScript extraction did not yield ${name} as a function`);
  return fn;
}

await checkAsync('a pomodoro-widget check that throws while the widget is loading cannot poison the rest of this file: the fetch stub is always restored, and an unstubbed load fails loudly instead of reaching the network', async () => {
  // Every widget check here replaces globalThis.fetch, and checkAsync catches a
  // failure and keeps going -- so a stub that outlived its own check would silently
  // answer, and RECORD, every request the checks after it make, turning one red into
  // a file of nonsense. Two guards, both asserted rather than assumed:
  const original = globalThis.fetch;
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: Date.now() };

  // 1. A throw from inside the stub's scope (init is where these throw, since
  // loadIndexWithPomodoro runs the real script) still restores it.
  await assert.rejects(
    withPomodoroFetch(() => doc, async () => {
      loadIndexWithPomodoro();
      throw new Error('the widget blew up while loading');
    }),
    /blew up while loading/);
  assert.equal(globalThis.fetch, original, 'the real fetch must be back after a failed check, stub and all');
  assert.ok(!globalThis.fetch.pomodoroStub);

  // 2. The precondition loadIndexWithPomodoro documents is enforced: initPomodoroWidget
  // fetches while loading, so an unstubbed load would put a real request on the wire
  // from a check that is supposed to be pure -- and leave an unhandled rejection
  // behind rather than a legible failure.
  assert.throws(() => loadIndexWithPomodoro(), /must run inside withPomodoroFetch/);
  assert.equal(globalThis.fetch, original, 'and a refused load leaves the global exactly as it found it');
});

await checkAsync('pomodoro widget: no timer running renders a calm idle state (the state named, no duration and no countdown) and leaves the switch off but live', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  let document;
  await withPomodoroFetch(() => doc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  const status = document.querySelector('span#pomodoro-status');
  const toggle = document.querySelector('button#pomodoro-toggle');
  assert.ok(status, 'setup failure: no #pomodoro-status rendered');
  assert.match(status.textContent, /idle/i, 'no timer must read as a calm idle state, not an error (spec: "a real state, not an error")');
  // ADR 90 retired the bracketed work length this used to require ("Idle (25 min)",
  // from a spec asking for "the durations, or a dash"): a duration that is not counting
  // down, in the place a countdown sits, reads as a countdown that has stopped. The
  // state is the whole of the line now, and it is the same word the Popover has always
  // used -- so this asserts NO number rather than a particular one.
  // One assertion, not three: `/\d/` already denies every digit, so the `\d\d:\d\d`
  // countdown and `\d+/\d+` cycle-position patterns that used to follow it could
  // never fail -- dead assertions reading as coverage they did not provide. Both are
  // strict subsets of this line, and both are named in its message so nothing is
  // lost but the two lines that could not run.
  assert.doesNotMatch(status.textContent, /\d/, 'an absent timer names the state and nothing else: no duration (nothing is counting down), no mm:ss countdown, no n/m cycle position');
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'idle is the switch\'s off state');
  assert.equal(toggle.getAttribute('aria-label'), 'Start pomodoro', 'idle: the switch\'s job is to START one, and its name has to say so');
  // The predecessor set `hidden` here and relied on it to disappear -- which it
  // never did, .mode-toggle's own `display: inline-flex` outranking the UA
  // sheet's `[hidden]` rule, leaving an empty pill with no timer to act on.
  assert.notEqual(toggle.hidden, true, 'the switch must stay visible and live when idle -- it is the control that starts a pomodoro, and hiding it is what broke it before');
});

await checkAsync('pomodoro widget: a running timer renders "<Phase> mm:ss" from the real formatCountdown and shows a live Pause control', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 1, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs + 12 * 60_000 + 34_000, paused: false }, now: nowMs };
  let document;
  await withPomodoroFetch(() => doc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  const status = document.querySelector('span#pomodoro-status');
  const toggle = document.querySelector('button#pomodoro-toggle');
  assert.match(status.textContent, /Work/);
  assert.match(status.textContent, /12:3[0-9]/, `expected roughly 12:34 in ${status.textContent}`);
  assert.equal(toggle.getAttribute('aria-checked'), 'true', 'a running, unpaused timer is the switch\'s ON state');
  assert.equal(toggle.getAttribute('aria-label'), 'Pause pomodoro');
});

await checkAsync('pomodoro widget: a running work or short-break interval names its position in the cycle as "Work 3/4 · 12:34"; a long break carries no position', async () => {
  const nowMs = Date.now();
  // cycle: 2 means two work intervals already completed this cycle -- the THIRD
  // is the one now running, out of POMODORO_SETTINGS.longEvery (4).
  const workDoc = { settings: POMODORO_SETTINGS, cycle: 2, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs + 12 * 60_000 + 34_000, paused: false }, now: nowMs };
  let document;
  await withPomodoroFetch(() => workDoc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  let status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /^Work 3\/4 · 12:3[0-9]$/, `expected "Work 3/4 · 12:34"-shaped text, got "${status.textContent}"`);

  // A short break inherits the SAME cycle value as the work interval it follows
  // (settleBoundary only increments `cycle` when a BREAK ends, src/pomodoro.mjs)
  // -- so it carries the identical position, not a fresh count of its own.
  const breakDoc = { settings: POMODORO_SETTINGS, cycle: 2, cycleDate: '2020-01-01', timer: { phase: 'break', deadline: nowMs + 4 * 60_000, paused: false }, now: nowMs };
  await withPomodoroFetch(() => breakDoc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /^Break 3\/4 · 04:00$/, `expected "Break 3/4 · 04:00"-shaped text, got "${status.textContent}"`);

  // A long break carries no position, but still gets the dot -- same shape as
  // the popover's cb_status_label (bin/menubar.m) when it has no position either.
  const longBreakDoc = { settings: POMODORO_SETTINGS, cycle: 3, cycleDate: '2020-01-01', timer: { phase: 'longBreak', deadline: nowMs + 15 * 60_000, paused: false }, now: nowMs };
  await withPomodoroFetch(() => longBreakDoc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /^Long break · 15:00$/, `a long break must carry no position, got "${status.textContent}"`);
  assert.doesNotMatch(status.textContent, /\d+\/\d+/, 'a long break must never render a cycle position');
});

await checkAsync('pomodoro widget: lowering longEvery mid-cycle never renders a position past the end of the cycle', async () => {
  // Reachable by an ordinary act: the reviewer drops "long break every" from 8
  // to 2 while `cycle` is already 5. settleBoundary does not renormalise cycle
  // on a settings write -- it resets only at the next long break -- so the bare
  // ordinal would read "6/2" for up to one whole interval. cycle + 1 is the
  // breakNumber settleBoundary is about to test for `% longEvery`, and at or
  // past longEvery the next break IS the long one, so the clamped reading
  // ("the last interval of this cycle") is the true one, not a cosmetic fudge.
  const nowMs = Date.now();
  const doc = {
    settings: { ...POMODORO_SETTINGS, longEvery: 2 },
    cycle: 5,
    cycleDate: '2020-01-01',
    timer: { phase: 'work', deadline: nowMs + 5 * 60_000, paused: false },
    now: nowMs,
  };
  let document;
  await withPomodoroFetch(() => doc, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  const status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /^Work 2\/2 · 05:00$/, `expected the position clamped to the cycle's own length, got "${status.textContent}"`);
});

await checkAsync('pomodoro widget: a paused timer renders the frozen remainingMs, shows Resume, and never ticks locally', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 1, cycleDate: '2020-01-01', timer: { phase: 'break', paused: true, remainingMs: 90_000 }, now: nowMs };
  let document, intervals;
  await withPomodoroFetch(() => doc, async () => {
    ({ document, intervals } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  const status = document.querySelector('span#pomodoro-status');
  const toggle = document.querySelector('button#pomodoro-toggle');
  assert.match(status.textContent, /Break/);
  assert.match(status.textContent, /01:30/);
  assert.match(status.textContent, /paused/i);
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'paused reads as off, the same as idle -- both are turned back on by the same gesture');
  assert.equal(toggle.getAttribute('aria-label'), 'Resume pomodoro', 'paused and idle share the off POSITION but never the label: one resumes, the other starts');

  // Paused must never tick locally (spec: "the countdown does not tick while
  // paused"): firing the 1s local-repaint interval by hand must render the
  // exact same text, since pomodoroRemainingMs ignores offset/browserNow for a
  // paused timer entirely.
  const before = status.textContent;
  pomodoroTickFn(intervals)();
  assert.equal(status.textContent, before, 'a paused timer must render identical text after a tick -- ticking it would silently un-freeze the countdown');
});

// The phase -> mark mapping (header glyph only -- the tab's own favicon is
// fixed and carries no phase at all, ADR 85) and the null-phase guard. The
// pure predicates are extracted and driven directly first (the non-trivial
// logic the spec names as needing a runnable check), then the same states
// are driven end to end through the real indexScript + renderIndexPage
// markup, the same DOM-stand-in shape every other pomodoro widget check
// above already uses.

check('pomodoroIsResting: only a RUNNING, UNPAUSED break or long break counts as resting -- work, idle, a paused timer in ANY phase (including mid-break), and a phase the daemon has never reported all read false', () => {
  const isResting = extractIndexScriptFn('pomodoroIsResting');
  assert.equal(isResting(null), false, 'no timer at all (no poll has returned yet) must never read as resting -- the anti-flicker guard');
  assert.equal(isResting(undefined), false);
  assert.equal(isResting({ phase: 'work', paused: false }), false);
  assert.equal(isResting({ phase: 'break', paused: false }), true);
  assert.equal(isResting({ phase: 'longBreak', paused: false }), true, 'a long break must satisfy the identical rest condition as a short break');
  assert.equal(isResting({ phase: 'break', paused: true }), false, 'a PAUSED break must keep the ordinary mark -- idle and paused both keep it regardless of which phase they are paused in');
  assert.equal(isResting({ phase: 'longBreak', paused: true }), false);
  assert.equal(isResting({ phase: 'idle', paused: false }), false, 'a phase name the daemon has never actually sent must never be read as resting');
  assert.equal(isResting({ phase: undefined, paused: false }), false);
});

check('pomodoroIsActiveWork: only a RUNNING, UNPAUSED work interval turns the glyph amber -- idle and paused (any phase) stay muted', () => {
  const isActiveWork = extractIndexScriptFn('pomodoroIsActiveWork');
  assert.equal(isActiveWork(null), false);
  assert.equal(isActiveWork({ phase: 'work', paused: false }), true);
  assert.equal(isActiveWork({ phase: 'work', paused: true }), false, 'a paused work interval must not read as active -- paused keeps the muted tomato, not amber');
  assert.equal(isActiveWork({ phase: 'break', paused: false }), false);
  assert.equal(isActiveWork({ phase: 'longBreak', paused: false }), false);
});

// The two glyphs told apart by their <path> count/geometry, read off the REAL
// TOMATO_ICON/REST_ICON exports (src/pomodoro-widget.mjs) rather than a
// hand-typed expectation that could drift from the actual drawings. Both carry
// the same silhouette -- the stem-and-leaves pair, two <path>s -- and REST_ICON
// adds a third, the one flat bar across the middle that ADR 84 made the rest
// mark. Not "stemless": the break glyph gained the silhouette when the
// silhouette became the thing every state draws.
const TOMATO_PATHS = [...TOMATO_ICON.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
const REST_PATHS = [...REST_ICON.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
assert.equal(TOMATO_PATHS.length, 2, 'setup sanity: TOMATO_ICON must carry the stem/leaves pair as two <path>s');
assert.deepEqual(REST_PATHS, [...TOMATO_PATHS, 'M9.4 14.6h5.2'],
  'setup sanity: REST_ICON must be the tomato silhouette plus the one flat rest bar (ADR 84)');

// The one favicon href the page ever carries -- ADR 85 deleted the swap, so
// every case below is checked against this SAME value rather than a
// per-case expectation.
const FAVICON_HREF = faviconLink.match(/href="([^"]+)"/)[1];

function pomodoroGlyphPaths(document) {
  const slot = document.querySelector('span#pomodoro-icon-slot');
  return [...slot.querySelectorAll('path')].map(p => p.getAttribute('d'));
}

await checkAsync('a running, unpaused break or long break swaps the header glyph to the rest glyph, muted; work alone turns the glyph amber; idle, paused, and a paused break all keep the ordinary tomato -- the tab favicon never moves off its one href in any of these states', async () => {
  const nowMs = Date.now();
  const cases = [
    { name: 'idle', timer: null, paths: TOMATO_PATHS, amber: false, restStatus: false },
    { name: 'running work', timer: { phase: 'work', deadline: nowMs + 5 * 60_000, paused: false }, paths: TOMATO_PATHS, amber: true, restStatus: false },
    { name: 'paused work', timer: { phase: 'work', paused: true, remainingMs: 90_000 }, paths: TOMATO_PATHS, amber: false, restStatus: false },
    { name: 'running short break', timer: { phase: 'break', deadline: nowMs + 5 * 60_000, paused: false }, paths: REST_PATHS, amber: false, restStatus: true },
    { name: 'running long break', timer: { phase: 'longBreak', deadline: nowMs + 15 * 60_000, paused: false }, paths: REST_PATHS, amber: false, restStatus: true },
    // "Idle and paused keep the muted tomato" applies even mid-break:
    // pausing never hands the rest mark to a phase that would otherwise earn it.
    { name: 'paused short break', timer: { phase: 'break', paused: true, remainingMs: 90_000 }, paths: TOMATO_PATHS, amber: false, restStatus: false },
    { name: 'paused long break', timer: { phase: 'longBreak', paused: true, remainingMs: 90_000 }, paths: TOMATO_PATHS, amber: false, restStatus: false },
  ];
  for (const c of cases) {
    const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: c.timer, now: nowMs };
    let document;
    await withPomodoroFetch(() => doc, async () => {
      ({ document } = loadIndexWithPomodoro());
      await flushPomodoro();
    });
    // Pins ADR 85: no Timer state ever moves the tab's favicon off its one href.
    const favicon = document.querySelector('link[rel="icon"]');
    assert.equal(favicon.getAttribute('href'), FAVICON_HREF, `${c.name}: the favicon must never move off its one href`);
    assert.deepEqual(pomodoroGlyphPaths(document), c.paths, `${c.name}: expected the ${c.paths === REST_PATHS ? 'rest' : 'tomato'} glyph`);
    const icon = document.querySelector('span#pomodoro-icon-slot .pomodoro-icon');
    assert.equal(icon.classList.contains('pomodoro-icon-amber'), c.amber, `${c.name}: amber class mismatch`);
    // Accessible name never changes, whichever glyph is mounted.
    assert.equal(icon.getAttribute('aria-label'), 'Pomodoro', `${c.name}: the glyph's accessible name must still read "Pomodoro"`);
    const status = document.querySelector('span#pomodoro-status');
    assert.equal(status.classList.contains('pomodoro-status-rest'), c.restStatus, `${c.name}: status-muted class mismatch`);
  }
});

// This regression line stays its own line, not a row in the table above: a table
// row is easy to edit away while the table still passes. Staying true costs
// nothing -- renderPomodoroGlyph only ever mounts REST_ICON under
// pomodoroIsResting, which idle (timer === null) cannot satisfy, so idle has
// always drawn the muted tomato and the menu bar item is the surface that has to
// come to it. What this pins is that it STAYS that way while the item is built
// against it: both surfaces read idle as one shape.
await checkAsync('idle draws the muted tomato and never the rest glyph, in the server-rendered markup and after the first fetch alike', async () => {
  const nowMs = Date.now();
  const idle = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  // The server-rendered slot first: no script has run at all here, and this is
  // what a reader sees for the whole first round trip.
  const served = parseHTML(renderIndexPage({ threads: [] }));
  assert.deepEqual(pomodoroGlyphPaths(served), TOMATO_PATHS, 'the slot must be server-rendered with the tomato -- the first paint is idle too');
  let document;
  await withPomodoroFetch(() => idle, async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
  });
  const paths = pomodoroGlyphPaths(document);
  assert.deepEqual(paths, TOMATO_PATHS, 'idle must draw the tomato');
  assert.notDeepEqual(paths, REST_PATHS, 'and specifically NOT the rest glyph -- the two bars mean "a break is running", which idle is not');
  const icon = document.querySelector('span#pomodoro-icon-slot .pomodoro-icon');
  assert.equal(icon.classList.contains('pomodoro-icon-amber'), false, 'muted, not amber: idle has nothing to turn up for');
});

await checkAsync('before the first pomodoro fetch resolves, the header glyph stays exactly as server-rendered -- never flickers through the rest mark even though the (stubbed, not-yet-answered) daemon reports a break the moment it does answer', async () => {
  const nowMs = Date.now();
  const restingDoc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: { phase: 'break', deadline: nowMs + 5 * 60_000, paused: false }, now: nowMs };
  await withPomodoroFetch(() => restingDoc, async () => {
    const { document } = loadIndexWithPomodoro();
    // Deliberately NO flushPomodoro() -- the opening fetch has been ISSUED but
    // has not resolved, so pomodoroDoc is still null and nothing has run
    // renderPomodoro (or its glyph logic) even once yet.
    assert.deepEqual(pomodoroGlyphPaths(document), TOMATO_PATHS, 'the glyph must still be the plain tomato before any poll has returned');
  });
});

await checkAsync('the header glyph returns to the tomato within one poll interval of a break ending, with no reload', async () => {
  const nowMs = Date.now();
  const resting = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: { phase: 'break', deadline: nowMs + 5 * 60_000, paused: false }, now: nowMs };
  const backToWork = { ...resting, cycle: 1, timer: { phase: 'work', deadline: nowMs + 25 * 60_000, paused: false } };
  let document, intervals, current = resting;
  await withPomodoroFetch(() => current, async () => {
    ({ document, intervals } = loadIndexWithPomodoro());
    await flushPomodoro();
    assert.deepEqual(pomodoroGlyphPaths(document), REST_PATHS, 'setup failure: expected the rest glyph while the break is still running');

    // The break ends on the DAEMON's own clock, never client-side (this
    // section's own header comment: tickPomodoro only ever asks, it never
    // decides) -- so the only thing that can move this page is the widget's own
    // re-fetch poll, fired here by hand instead of waiting POMODORO_POLL_MS for
    // real.
    current = backToWork;
    fetchPomodoroFn(intervals)();
    await flushPomodoro();
  });
  assert.deepEqual(pomodoroGlyphPaths(document), TOMATO_PATHS, 'the glyph must revert to the tomato within one poll of the break ending');
});

await checkAsync('pomodoro widget: the local tick never advances the phase on its own -- an expired countdown re-fetches instead of guessing the next phase', async () => {
  const nowMs = Date.now();
  // Deliberately already past its own deadline -- if tickPomodoro ever grew its
  // own boundary-crossing logic (a second, client-side settleBoundary), THIS is
  // where it would show up: the phase would flip to 'break' locally, with no
  // fetch involved at all.
  const stale = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs - 5000, paused: false }, now: nowMs };
  let document, intervals, calls;
  calls = await withPomodoroFetch(() => stale, async (c) => {
    ({ document, intervals } = loadIndexWithPomodoro());
    await flushPomodoro();
    const before = c.length;
    pomodoroTickFn(intervals)();
    await flushPomodoro();
    assert.equal(c.length, before + 1, 'a tick against an already-expired timer must trigger exactly one re-fetch');
    assert.equal(c[c.length - 1].url, '/api/pomodoro', 'the re-fetch must be a plain GET, never a write that could itself decide the next phase');
  });
  // The doc handed back by every fetch in this check is the SAME stale 'work'
  // document -- proving the phase shown is still whatever the (stubbed) daemon
  // said, never something tickPomodoro invented on its own.
  assert.match(document.querySelector('span#pomodoro-status').textContent, /Work/, 'the phase must still be exactly what the daemon last reported, not locally advanced');
});

await checkAsync('pomodoro widget: clicking the toggle while running posts /api/pomodoro/pause with the session cookie, and applies the response', async () => {
  const nowMs = Date.now();
  const running = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: { phase: 'work', deadline: nowMs + 60_000, paused: false }, now: nowMs };
  const paused = { ...running, timer: { phase: 'work', paused: true, remainingMs: 60_000 } };
  let document;
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? paused : running), async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
    document.querySelector('button#pomodoro-toggle').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'the click must issue a POST');
  assert.equal(post.url, '/api/pomodoro/pause');
  assert.equal(post.credentials, 'same-origin', 'the browser holds only the session cookie, not the secret -- credentials must be sent');
  const after = document.querySelector('button#pomodoro-toggle');
  assert.equal(after.getAttribute('aria-checked'), 'false', 'the response must be applied: the switch must now read off');
  assert.equal(after.getAttribute('aria-label'), 'Resume pomodoro');
});

await checkAsync('pomodoro widget: flipping the switch on while idle posts /api/pomodoro/ensure -- the manual way to start one, without waiting for a session-start hook', async () => {
  const nowMs = Date.now();
  const idle = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const started = { ...idle, timer: { phase: 'work', deadline: nowMs + 25 * 60_000, paused: false } };
  let document;
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? started : idle), async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
    document.querySelector('button#pomodoro-toggle').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'the click must issue a POST -- an idle switch that does nothing is exactly the bug this replaced');
  assert.equal(post.url, '/api/pomodoro/ensure', 'starting by hand reuses the daemon\'s existing session-start route, never a second start path');
  assert.equal(post.credentials, 'same-origin', 'the browser holds only the session cookie -- POMODORO_COOKIE_ACTIONS (src/server.mjs) has to include ensure for this to be authorised at all');
  assert.equal(document.querySelector('button#pomodoro-toggle').getAttribute('aria-checked'), 'true', 'the started timer must be applied back: the switch reads on');
});

await checkAsync('pomodoro widget: a click landing before the first fetch resolves does nothing at all -- it must never guess ensure against a daemon that may already be running one', async () => {
  const nowMs = Date.now();
  const idle = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => idle, async (c) => {
    const { document } = loadIndexWithPomodoro();
    // Deliberately NO flushPomodoro() first: the widget has been wired but its
    // opening fetch has not settled, so pomodoroDoc is still null.
    document.querySelector('button#pomodoro-toggle').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
    assert.equal(c.filter(x => x.method === 'POST').length, 0, 'nothing may be posted while the widget still has no idea what the daemon holds');
  });
  assert.ok(calls.length >= 1, 'setup sanity: the opening GET must still have happened');
});

await checkAsync('pomodoro widget: clicking the toggle while paused posts /api/pomodoro/resume', async () => {
  const nowMs = Date.now();
  const paused = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: { phase: 'break', paused: true, remainingMs: 30_000 }, now: nowMs };
  const running = { ...paused, timer: { phase: 'break', deadline: nowMs + 30_000, paused: false } };
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? running : paused), async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('button#pomodoro-toggle').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post);
  assert.equal(post.url, '/api/pomodoro/resume');
});

// The Restart/Forward pair. Same shape as the toggle checks above: stub the fetch, dispatch a real
// click, assert on the POST that resulted and that the response landed back
// in the widget -- never a hand-summary of what onPomodoroForwardClick/
// onPomodoroRestartClick claim to do.
await checkAsync('pomodoro widget: clicking Forward posts /api/pomodoro/forward with the session cookie, and the response is applied back into the widget instantly', async () => {
  const nowMs = Date.now();
  const running = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs + 20 * 60_000, paused: false }, now: nowMs };
  const forwarded = { ...running, cycle: 1, timer: { phase: 'break', deadline: nowMs + 5 * 60_000, paused: false } };
  let document;
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? forwarded : running), async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
    document.querySelector('button#pomodoro-forward').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'the click must issue a POST');
  assert.equal(post.url, '/api/pomodoro/forward');
  assert.equal(post.credentials, 'same-origin', 'the browser holds only the session cookie -- POMODORO_COOKIE_ACTIONS (src/server.mjs) has to include forward for this to be authorised at all');
  const status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /Break/, 'the response must be applied back into the widget -- the countdown must move to the phase the daemon actually forwarded to, without waiting for the next poll');
  assert.match(status.textContent, /0[45]:[0-5][0-9]/, `expected roughly the fresh 5-minute break in ${status.textContent}`);
});

await checkAsync('pomodoro widget: clicking Restart posts /api/pomodoro/restart with the session cookie, and the response is applied back into the widget instantly', async () => {
  const nowMs = Date.now();
  const running = { settings: POMODORO_SETTINGS, cycle: 3, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs + 30_000, paused: false }, now: nowMs };
  const restarted = { ...running, timer: { phase: 'work', deadline: nowMs + 25 * 60_000, paused: false } };
  let document;
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? restarted : running), async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
    document.querySelector('button#pomodoro-restart').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'the click must issue a POST');
  assert.equal(post.url, '/api/pomodoro/restart');
  assert.equal(post.credentials, 'same-origin', 'the browser holds only the session cookie -- POMODORO_COOKIE_ACTIONS (src/server.mjs) has to include restart for this to be authorised at all');
  const status = document.querySelector('span#pomodoro-status');
  assert.match(status.textContent, /Work/, 'restart keeps the same phase running -- it never advances to the next one');
  assert.match(status.textContent, /24:5[0-9]|25:00/, `expected the deadline re-minted to a full 25-minute work interval in ${status.textContent}, not the ~30s that was left`);
});

await checkAsync('pomodoro widget: reset needs two clicks -- the first only relabels the SAME control, the second posts /api/pomodoro/reset, and confirm() is never called', async () => {
  const nowMs = Date.now();
  const running = { settings: POMODORO_SETTINGS, cycle: 2, cycleDate: '2020-01-01', timer: { phase: 'work', deadline: nowMs + 60_000, paused: false }, now: nowMs };
  const idle = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: '2020-01-01', timer: null, now: nowMs };
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => { throw new Error('must never call confirm() -- a blocking modal is exactly what the two-step button exists to avoid'); };
  try {
    await withPomodoroFetch(call => (call.method === 'POST' ? idle : running), async (calls) => {
      const { document } = loadIndexWithPomodoro();
      await flushPomodoro();
      const resetBtn = document.querySelector('button#pomodoro-reset');
      assert.equal(resetBtn.textContent, 'Reset');

      resetBtn.dispatchEvent(new StandInEvent('click'));
      await flushPomodoro();
      assert.equal(resetBtn.textContent, 'Really reset?', 'the first click must only arm the confirm, relabeling the SAME control -- never a second element, never confirm()');
      assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'the first click must not post anything yet');

      resetBtn.dispatchEvent(new StandInEvent('click'));
      await flushPomodoro();
      const posts = calls.filter(c => c.method === 'POST');
      assert.equal(posts.length, 1, 'the second click must post exactly once');
      assert.equal(posts[0].url, '/api/pomodoro/reset');
    });
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

await checkAsync('pomodoro widget: submitting the settings form posts all eleven fields to /api/pomodoro/settings, and the response is applied back into the form', async () => {
  const nowMs = Date.now();
  const initial = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  // Rotated relative to POMODORO_SETTINGS (CUE_A/CUE_B/None), not just three
  // arbitrary new names -- proves each of the three fields round-trips its
  // OWN new value rather than the write path silently mixing them up. bannerLevel is
  // moved to 'off' while notify goes false too, but to a value that is not a mere
  // negation of notify (bannerLevel is a four-way select, not a checkbox) -- a bug
  // that wired the two controls to the same underlying value, rather than two
  // independent ones, would still show up as a mismatch against POMODORO_SETTINGS'
  // own bannerLevel: 'this-board'.
  // Both menubar keys leave their defaults too, and in OPPOSITE
  // directions: the countdown goes off, the item stays shown. A patch that dropped
  // either -- or that wired the pair to one underlying value -- fails the deepEqual
  // below rather than passing on a coincidence.
  const savedSettings = { workMin: 50, breakMin: 10, longBreakMin: 20, longEvery: 3, notify: false, bannerLevel: 'off', cueWork: CUE_B, cueBreak: NO_CUE, cueLongBreak: CUE_C, menubarCountdown: false, menubarHidden: false };
  const saved = { ...initial, settings: savedSettings };
  let document;
  const calls = await withPomodoroFetch(call => (call.method === 'POST' ? saved : initial), async () => {
    ({ document } = loadIndexWithPomodoro());
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    form.querySelector('input[name="workMin"]').value = '50';
    form.querySelector('input[name="breakMin"]').value = '10';
    form.querySelector('input[name="longBreakMin"]').value = '20';
    form.querySelector('input[name="longEvery"]').value = '3';
    form.querySelector('input[name="notify"]').checked = false;
    form.querySelector('select[name="bannerLevel"]').value = 'off';
    form.querySelector('select[name="cueWork"]').value = CUE_B;
    form.querySelector('select[name="cueBreak"]').value = NO_CUE;
    form.querySelector('select[name="cueLongBreak"]').value = CUE_C;
    form.querySelector('input[name="menubarCountdown"]').checked = false;
    // TICKED, and the expectation above is menubarHidden: false -- the control is
    // "Show in menu bar", the key is the negation of it.
    form.querySelector('input[name="menubarHidden"]').checked = true;
    form.dispatchEvent(new StandInEvent('submit'));
    await flushPomodoro();
  });
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, 'submitting must POST');
  assert.equal(post.url, '/api/pomodoro/settings');
  assert.deepEqual(post.body, savedSettings, 'all eleven settings fields must round-trip in one patch, exactly as entered -- workMin, breakMin, longBreakMin, longEvery, notify, bannerLevel, cueWork, cueBreak, cueLongBreak, menubarCountdown, menubarHidden');
  // Applied back, not merely echoed: re-reading the form after the response
  // shows the daemon's own saved value, proving the round trip is real -- for
  // both a duration field and one cue field (each picker is its
  // own value, independent of the other two).
  assert.equal(document.querySelector('form#pomodoro-settings-form input[name="workMin"]').value, 50);
  assert.equal(document.querySelector('form#pomodoro-settings-form select[name="cueWork"]').value, CUE_B);
  // Saving is done, so the panel is done: it closes on the RESPONSE, never
  // optimistically beside the post (a rejected patch must leave it open).
  assert.equal(document.querySelector('details#pomodoro-settings').open, false, 'a successful save must close the settings panel');
});

await checkAsync('pomodoro widget: the three cue pickers sync independently from the daemon\'s settings on the first fetch, one value per phase', async () => {
  assert.notEqual(CUE_A, CUE_B, 'setup failure: this machine needs at least two distinct sounds under /System/Library/Sounds for this fixture to mean anything');
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    assert.equal(form.querySelector('select[name="cueWork"]').value, CUE_A);
    assert.equal(form.querySelector('select[name="cueBreak"]').value, CUE_B);
    assert.equal(form.querySelector('select[name="cueLongBreak"]').value, NO_CUE);
  });
});

await checkAsync('pomodoro widget: the Banner level select syncs from settings.bannerLevel independently of Notify (criterion 17)', async () => {
  const nowMs = Date.now();
  // notify ON, bannerLevel 'always' -- disagreeing with notify in the direction that
  // matters (not the default 'this-board' POMODORO_SETTINGS already carries), so a
  // sync bug that read the select off the notify checkbox's value (or off a single
  // shared field) shows up here as a mismatch, not a coincidental pass.
  const doc = { settings: { ...POMODORO_SETTINGS, notify: true, bannerLevel: 'always' }, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    assert.equal(form.querySelector('input[name="notify"]').checked, true, 'notify must sync to its own saved value');
    assert.equal(form.querySelector('select[name="bannerLevel"]').value, 'always', 'bannerLevel must sync to ITS OWN saved value, not follow notify');
  });
});

// The client-side half: a change has to reach a real network
// call, and nothing here may let a REAL request
// out. withPomodoroFetch keeps globalThis.fetch stubbed for the whole
// withPomodoroFetch(...) call, so the wait below is what lets the debounced
// call actually fire while it is still safely captured by the stub -- letting it
// fire AFTER fetch is restored would send a real request out from this test.
//
// It WAITS FOR THE CALL rather than sleeping a fixed 250ms past indexpage.mjs's
// 150ms debounce. A fixed sleep is a bet that the machine will run a timer roughly
// on time, and `JOBS=10` (test/run.mjs runs check files concurrently) is exactly
// the condition that loses that bet: the debounce timer lands after the sleep has
// already returned, the check reads zero preview calls, and "exactly one preview"
// fails as if the client never fired. Polling for the call turns the fixed wait
// into a floor, not a ceiling. The settle window afterwards is what keeps the
// "exactly one" assertions honest -- a stray SECOND preview was scheduled at
// roughly the same moment as the one we waited for, so it has to be given the same
// room to arrive.
async function waitForPreviews(calls, expected) {
  const previews = () => calls.filter(c => c.url === '/api/pomodoro/preview').length;
  const deadline = Date.now() + 10_000;
  while (previews() < expected && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 250));
}

await checkAsync('pomodoro widget: changing a cue picker posts a preview immediately, before Save, and never writes the stored settings', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async (seen) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('details#pomodoro-settings').open = true;
    const cueWork = document.querySelector('form#pomodoro-settings-form select[name="cueWork"]');
    cueWork.value = CUE_C;
    cueWork.dispatchEvent(new StandInEvent('change'));
    await waitForPreviews(seen, 1);
  });
  const previews = calls.filter(c => c.url === '/api/pomodoro/preview');
  assert.equal(previews.length, 1, 'exactly one preview request, once the debounce settles');
  assert.equal(previews[0].method, 'POST');
  assert.equal(previews[0].credentials, 'same-origin', 'same credentials shape as every other pomodoro write in this file');
  assert.deepEqual(previews[0].body, { cue: CUE_C });
  assert.equal(calls.filter(c => c.url === '/api/pomodoro/settings').length, 0, 'a preview must never be a write');
});

await checkAsync('pomodoro widget: ticking Notify fires one test banner immediately, and is not a write', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('details#pomodoro-settings').open = true;
    const notify = document.querySelector('form#pomodoro-settings-form input[name="notify"]');
    notify.checked = true;
    notify.dispatchEvent(new StandInEvent('change'));
  });
  const tests = calls.filter(c => c.url === '/api/pomodoro/notifyTest');
  assert.equal(tests.length, 1, 'exactly one test-notification request');
  assert.equal(tests[0].method, 'POST');
  assert.equal(tests[0].credentials, 'same-origin', 'same credentials shape as every other pomodoro request in this file');
  assert.equal(calls.filter(c => c.url === '/api/pomodoro/settings').length, 0, 'ticking Notify must not save anything -- Save is still the write');
});

await checkAsync('pomodoro widget: unticking Notify fires nothing -- a banner saying notifications work, because they were just turned off, is the wrong answer', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const notify = document.querySelector('form#pomodoro-settings-form input[name="notify"]');
    notify.checked = false;
    notify.dispatchEvent(new StandInEvent('change'));
  });
  assert.deepEqual(calls.filter(c => c.url === '/api/pomodoro/notifyTest'), []);
});

await checkAsync('pomodoro widget: picking a Banner level fires no test banner and no cue preview -- that audition stays Notify\'s alone, and the level is not one of the three cue pickers even though it is also a <select> (criterion 18: not one per kind)', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('details#pomodoro-settings').open = true;
    const bannerLevel = document.querySelector('form#pomodoro-settings-form select[name="bannerLevel"]');
    bannerLevel.value = 'always';
    bannerLevel.dispatchEvent(new StandInEvent('change'));
    // A real wait past onPomodoroCueChange's own POMODORO_PREVIEW_DEBOUNCE_MS
    // (150ms), not just flushPomodoro's microtask drain -- the bug this guards
    // against (onPomodoroCueChange scoped by bare tagName === 'SELECT', which
    // Banner level now also is) fires its preview fetch on a debounce timer, so
    // asserting immediately after dispatch would pass even with the guard
    // missing, simply because the timer had not fired yet.
    await new Promise(resolve => setTimeout(resolve, 220));
  });
  assert.deepEqual(calls.filter(c => c.url === '/api/pomodoro/notifyTest'), [], 'picking a Banner level must not fire the one test banner -- that stays Notify\'s alone');
  assert.deepEqual(calls.filter(c => c.url === '/api/pomodoro/preview'), [], 'picking a Banner level must not fire a cue preview -- it is a <select> but not one of the three cue pickers');
  assert.equal(calls.filter(c => c.url === '/api/pomodoro/settings').length, 0, 'picking a Banner level must not save anything either -- Save is still the write');
});

await checkAsync('pomodoro widget: selecting None previews it like any other value -- no special-cased silence on the client, the server owns "plays nothing"', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async (seen) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const cueBreak = document.querySelector('form#pomodoro-settings-form select[name="cueBreak"]');
    cueBreak.value = NO_CUE;
    cueBreak.dispatchEvent(new StandInEvent('change'));
    await waitForPreviews(seen, 1);
  });
  const previews = calls.filter(c => c.url === '/api/pomodoro/preview');
  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0].body, { cue: NO_CUE });
});

await checkAsync('pomodoro widget: a rapid run of changes on the same picker (a held arrow key) collapses to one preview of the value it lands on, never a chorus', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async (seen) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const cueWork = document.querySelector('form#pomodoro-settings-form select[name="cueWork"]');
    // Simulates a held arrow key: several 'change' events land back to back,
    // well inside the debounce window -- exactly the shape a real key-repeat
    // produces (see onPomodoroCueChange's own comment, src/indexpage.mjs).
    for (const value of [CUE_A, CUE_B, NO_CUE, CUE_C]) {
      cueWork.value = value;
      cueWork.dispatchEvent(new StandInEvent('change'));
    }
    await waitForPreviews(seen, 1);
  });
  const previews = calls.filter(c => c.url === '/api/pomodoro/preview');
  assert.equal(previews.length, 1, 'four rapid changes on one picker must collapse into exactly one preview request, never one per change');
  assert.deepEqual(previews[0].body, { cue: CUE_C }, 'the one preview that does fire must carry the value the picker actually landed on, not an earlier one it passed through');
});

await checkAsync('pomodoro widget: changing TWO different pickers in quick succession still previews both -- the debounce is per field, not one shared gate', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => doc, async (seen) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    const cueWork = form.querySelector('select[name="cueWork"]');
    const cueBreak = form.querySelector('select[name="cueBreak"]');
    cueWork.value = CUE_C;
    cueWork.dispatchEvent(new StandInEvent('change'));
    cueBreak.value = NO_CUE;
    cueBreak.dispatchEvent(new StandInEvent('change'));
    await waitForPreviews(seen, 2);
  });
  const previews = calls.filter(c => c.url === '/api/pomodoro/preview');
  assert.equal(previews.length, 2, 'two different pickers changed close together must each still preview -- a shared debounce would drop the first');
  assert.deepEqual(previews.map(p => p.body), [{ cue: CUE_C }, { cue: NO_CUE }]);
});

await checkAsync('pomodoro widget: closing the panel without saving reverts a previewed cue back to the stored value -- a preview is not a write', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async (seen) => {
    const { document, intervals } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    const cueWork = document.querySelector('form#pomodoro-settings-form select[name="cueWork"]');
    assert.equal(cueWork.value, CUE_A, 'setup failure: expected the daemon\'s stored value synced in first');
    panel.open = true;
    cueWork.value = CUE_C;                 // the reader previews a different sound
    cueWork.dispatchEvent(new StandInEvent('change'));
    panel.open = false;                    // ...then closes without Save
    pomodoroTickFn(intervals)();           // the repaint tick is what actually re-syncs (pomodoroSyncForm's own guard)
    assert.equal(cueWork.value, CUE_A, 'closing without saving must revert the picker to the daemon\'s actual stored cue, exactly like every other abandoned edit');
    await waitForPreviews(seen, 1);        // let the still-pending preview fire against the stub, not the real fetch
  });
});

// The reported bug, reduced to its mechanism: type into one field, move to
// another, and a repaint tick lands. The old pomodoroSyncForm skipped only the
// field holding FOCUS, so everything already typed and tabbed away from was
// overwritten from the daemon's (still unsaved) values within one second.
await checkAsync('pomodoro widget: a repaint tick while the settings panel is open never overwrites a field the reader has already edited and left', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document, intervals } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    const form = document.querySelector('form#pomodoro-settings-form');
    const workMin = form.querySelector('input[name="workMin"]');
    const breakMin = form.querySelector('input[name="breakMin"]');

    panel.open = true;                 // the reader opens the panel
    workMin.value = '42';              // types a new work length
    breakMin.focus();                  // and moves on to the next field

    pomodoroTickFn(intervals)();       // one second passes
    await flushPomodoro();
    assert.equal(workMin.value, '42', 'the edited value must survive a repaint -- focus moving on is not the reader abandoning the edit, and only Save ends it');

    // A full re-fetch (the 15s poll) must not undo it either: the daemon still
    // holds the OLD number, since nothing has been saved yet.
    await fetchPomodoroFn(intervals)();
    assert.equal(workMin.value, '42', 'a background poll landing mid-edit must not overwrite the panel either');
  });
});

await checkAsync('pomodoro widget: the panel resumes syncing the moment it closes, so it never opens on stale values', async () => {
  const nowMs = Date.now();
  const doc = { settings: { ...POMODORO_SETTINGS, workMin: 33 }, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document, intervals } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    const workMin = document.querySelector('form#pomodoro-settings-form input[name="workMin"]');
    panel.open = true;
    workMin.value = '999';             // an edit the reader abandons
    panel.open = false;                // ...by closing the panel
    pomodoroTickFn(intervals)();
    assert.equal(String(workMin.value), '33', 'a closed panel holds no edit worth protecting: it must go back to showing what the daemon actually has');
  });
});

await checkAsync('pomodoro widget: a click anywhere outside the settings panel closes it, and a click inside it does not', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    panel.open = true;

    // Inside first: a click on a field the reader is filling in must not close
    // the panel out from under them.
    document.querySelector('form#pomodoro-settings-form input[name="workMin"]')
      .dispatchEvent(new StandInEvent('click'));
    assert.equal(panel.open, true, 'a click INSIDE the panel must leave it open');

    // Then outside. Dispatched on a real element elsewhere on the page and
    // allowed to bubble to document, exactly as a browser delivers it.
    document.querySelector('input.search-input').dispatchEvent(new StandInEvent('click'));
    assert.equal(panel.open, false, 'a click outside the panel must close it');
  });
});

await checkAsync('pomodoro widget: closing the panel by clicking away disarms a half-confirmed Reset rather than leaving it armed for the next open', async () => {
  const nowMs = Date.now();
  const running = { settings: POMODORO_SETTINGS, cycle: 1, cycleDate: null, timer: { phase: 'work', deadline: nowMs + 60_000, paused: false }, now: nowMs };
  await withPomodoroFetch(() => running, async (calls) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    const resetBtn = document.querySelector('button#pomodoro-reset');
    panel.open = true;
    resetBtn.dispatchEvent(new StandInEvent('click'));
    assert.equal(resetBtn.textContent, 'Really reset?', 'setup failure: the first click must arm it');

    document.querySelector('input.search-input').dispatchEvent(new StandInEvent('click'));
    assert.equal(resetBtn.textContent, 'Reset', 'clicking away must disarm it -- an armed Reset surviving a close means the NEXT click on it wipes the loop with no confirmation at all');

    panel.open = true;
    resetBtn.dispatchEvent(new StandInEvent('click'));
    assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'and that next click must be a fresh first click, posting nothing');
  });
});

// =================================================================================
// The settings panel's two menu bar controls, and the
// fragment the popover's gear opens the panel on. The idle-tomato
// regression line sits with the other glyph checks further up, beside the states
// it is about.
// =================================================================================

check('the settings panel carries its own captioned group for the menu bar, in the same hairline + caption idiom every other section uses', () => {
  const html = renderIndexPage({ threads: [] });
  // One hairline per section boundary. The absolute count belongs to the panel's own
  // shape check below, which is what fails if a section is added or dropped; what
  // this line is about is that the menu bar
  // group did not invent a second idiom to separate itself with.
  assert.equal((html.match(/<hr class="pomodoro-settings-divider">/g) || []).length, 4, 'the menu bar group needs a hairline like every other section -- no fold, no tab, no new idiom');
  assert.match(html, /<div class="pomodoro-settings-caption">Menu bar<\/div>/);
  // The exact visible labels, and that each wraps the field it names. Not an
  // attribute-agnostic substring: which control the reader is ticking is the
  // whole of what these two rows have to get right.
  assert.match(html, /<label class="pomodoro-field pomodoro-field-check">Countdown<input type="checkbox" name="menubarCountdown"[ >]/, 'the countdown control must be labelled by what the reader sees in the menu bar, not by its key name');
  assert.match(html, /<label class="pomodoro-field pomodoro-field-check">Show in menu bar<input type="checkbox" name="menubarHidden"[ >]/, 'the hide preference must render as a POSITIVE -- a box labelled "Hidden" that you tick to make something appear is backwards, and this row is the only way back once the item is gone');
  assert.doesNotMatch(html, /pomodoro-field[^>]*">Hidden</, 'no negative spelling of the same control may render alongside or instead of it');
  // Reuses the classes the existing checkboxes already carry -- no new class, and
  // therefore no new CSS rule for the orphan-class check above to fail on.
  const menubarRows = [...html.matchAll(/<label class="([^"]*)">[^<]*<input type="checkbox" name="menubar[A-Za-z]+"/g)].map(m => m[1]);
  assert.equal(menubarRows.length, 2, 'setup failure: expected exactly two menubar rows');
  for (const cls of menubarRows) assert.equal(cls, 'pomodoro-field pomodoro-field-check', 'both rows must wear the same classes the Notify checkboxes already do');
  // The group sits inside the panel, and Reset stays where it was: criterion 8
  // says the panel is where Reset lives, and this slice does not move it.
  const captionIdx = html.indexOf('<div class="pomodoro-settings-caption">Menu bar</div>');
  const actionsIdx = html.indexOf('<div class="pomodoro-settings-actions">');
  const resetIdx = html.indexOf('id="pomodoro-reset"');
  assert.ok(captionIdx > -1 && actionsIdx > captionIdx && resetIdx > actionsIdx, 'the menu bar group must sit inside the panel, above the Save/Reset row -- and Reset must still be in the panel at all');
});

await checkAsync('pomodoro widget: both menu bar controls sync from the daemon\'s stored settings, and the "Show in menu bar" box is the INVERSE of menubarHidden', async () => {
  const nowMs = Date.now();
  // The state a reader who hid the item from this very panel is in: hidden true,
  // countdown false. A sync that read the stored value straight through would tick
  // "Show in menu bar" for a HIDDEN item -- the reader would then untick it to try
  // to bring it back and store hidden: true a second time.
  const hidden = { settings: { ...POMODORO_SETTINGS, menubarCountdown: false, menubarHidden: true }, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => hidden, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    assert.equal(form.querySelector('input[name="menubarCountdown"]').checked, false, 'the countdown box must sync to its own stored value');
    assert.equal(form.querySelector('input[name="menubarHidden"]').checked, false, 'a HIDDEN item must show "Show in menu bar" UNTICKED -- ticked means shown');
  });
  // ...and the ordinary state, so this cannot pass by both boxes being stuck off.
  const shown = { settings: { ...POMODORO_SETTINGS, menubarCountdown: true, menubarHidden: false }, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => shown, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    assert.equal(form.querySelector('input[name="menubarCountdown"]').checked, true);
    assert.equal(form.querySelector('input[name="menubarHidden"]').checked, true, 'a SHOWN item must show the box ticked');
  });
});

await checkAsync('pomodoro widget: unticking "Show in menu bar" saves menubarHidden: true through the same settings patch every other field uses -- no second save path', async () => {
  const nowMs = Date.now();
  const initial = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const calls = await withPomodoroFetch(() => initial, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const form = document.querySelector('form#pomodoro-settings-form');
    // The opposite arrangement to the eleven-field check above, which ticks it:
    // between the two, both directions of the one inversion in this form are
    // pinned, which is the half most likely to be got backwards.
    form.querySelector('input[name="menubarHidden"]').checked = false;
    form.querySelector('input[name="menubarCountdown"]').checked = true;
    form.dispatchEvent(new StandInEvent('submit'));
    await flushPomodoro();
  });
  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one write, and it is the settings patch -- not a second route of its own');
  assert.equal(posts[0].url, '/api/pomodoro/settings');
  assert.equal(posts[0].body.menubarHidden, true, 'unticking "Show in menu bar" must store hidden: TRUE');
  assert.equal(posts[0].body.menubarCountdown, true, 'and the countdown box must carry its own value straight through, uninverted');
});

// The menu bar popover's gear opens the index page's existing pomodoro
// panel by navigating the browser to http://127.0.0.1:7391/#pomodoro-settings, so
// the panel has to open itself -- deliberately NOT left to the browser's own
// fragment-auto-expand for a closed <details>, which is recent and unevenly
// shipped.
await checkAsync('loading the index page on the #pomodoro-settings fragment opens the panel, filled, and brings it into view', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro({ hash: '#pomodoro-settings' });
    const panel = document.querySelector('details#pomodoro-settings');
    // Not yet: the opening fetch has not settled, and pomodoroSyncForm never
    // writes into an OPEN panel -- opening it here would strand the reader in
    // front of a panel whose every field is blank until they close it again.
    assert.notEqual(panel.open, true, 'the panel must not open before the first fetch has filled the form');
    await flushPomodoro();
    assert.equal(panel.open, true, 'the fragment must open the panel once the values are in it');
    assert.equal(String(document.querySelector('form#pomodoro-settings-form input[name="workMin"]').value), '25', 'and it must open onto the daemon\'s actual values, not a blank form');
    assert.equal(panel.scrollIntoViewCallCount, 1, 'a panel that opened offscreen is indistinguishable from one that did not open');
  });
});

await checkAsync('pomodoro widget: an ordinary index load opens nothing -- only the fragment does', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = document.querySelector('details#pomodoro-settings');
    assert.notEqual(panel.open, true, 'the settings panel stays collapsed by default -- the fragment is the only thing that opens it');
    assert.equal(panel.scrollIntoViewCallCount, 0, 'and nothing scrolls the page on an ordinary load');
  });
});

await checkAsync('the fragment arriving in a tab already open on the index -- a hashchange, never a load -- opens the panel too', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const loaded = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = loaded.document.querySelector('details#pomodoro-settings');
    assert.notEqual(panel.open, true, 'setup failure: expected a closed panel before the fragment arrives');
    // A real browser updates location first, then fires the event.
    loaded.location.hash = '#pomodoro-settings';
    loaded.window.dispatchEvent(new StandInEvent('hashchange'));
    assert.equal(panel.open, true, 'a tab already on this page sees only the hash change, so that alone has to open the panel');
    // The panel has been syncing all along while closed, so it opens on current
    // values with no extra fetch of its own.
    assert.equal(String(loaded.document.querySelector('form#pomodoro-settings-form input[name="workMin"]').value), '25');
  });
});

await checkAsync('the fragment is SPENT once it has opened the panel, so a second press of the gear into the same tab still works', async () => {
  // The failure this pins is silent and second-use-only: a browser handed a URL a tab is
  // already parked on surfaces that tab and fires no 'hashchange', so a reader who opened
  // Settings, closed the panel, and clicked Settings again would get nothing at all. Only
  // reachable through a real browser's tab reuse, which is why the fix is asserted here as
  // "the hash was cleared" rather than by driving the browser behaviour that needs it.
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const loaded = loadIndexWithPomodoro({ hash: '#pomodoro-settings' });
    await flushPomodoro();
    const panel = loaded.document.querySelector('details#pomodoro-settings');
    assert.equal(panel.open, true, 'setup failure: the fragment must have opened the panel');
    assert.deepEqual(loaded.history.calls, ['/'],
      'the fragment must be replaced (never pushed, and never by assigning location.hash, which would fire the event this handler stands in for)');
    assert.equal(loaded.location.hash, '', 'and the tab must no longer be parked on the fragment it has already acted on');
  });
});

await checkAsync('pomodoro widget: a hashchange to any OTHER fragment leaves the panel alone', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async () => {
    const loaded = loadIndexWithPomodoro();
    await flushPomodoro();
    const panel = loaded.document.querySelector('details#pomodoro-settings');
    loaded.location.hash = '#something-else';
    loaded.window.dispatchEvent(new StandInEvent('hashchange'));
    assert.notEqual(panel.open, true, 'only this page\'s own fragment may open the panel');
  });
});

// --- the settings panel is general now, and holds the store control (ADR 71) ------
// AC 14 (ADR.md entry 71: reachable from the settings panel on the index, takes the
// window as an input, and deletes on a single click) and AC 15: reads as general
// settings rather than the pomodoro's, with the store control in its own captioned
// section. What the prune actually DOES to the store is test/check-prune.mjs's job;
// these two are about the surface that fires it.

check('settings panel: reads as general settings -- five captioned sections in order, and the store control sits in its own', () => {
  const html = renderIndexPage({ threads: [] });
  const captions = [...html.matchAll(/<div class="pomodoro-settings-caption">([^<]*)<\/div>/g)].map(m => m[1]);
  assert.deepEqual(captions, ['Pomodoro', 'Cues', 'Banners', 'Menu bar', 'Store'],
    'the panel must name every section it holds -- a panel where only Cues is captioned reads as the pomodoro\'s with an unlabelled top half');
  // The device is the one the panel already had: a hairline BETWEEN sections, so one
  // fewer than there are captions (nothing sits above the first).
  assert.equal((html.match(/<hr class="pomodoro-settings-divider">/g) || []).length, captions.length - 1,
    'each section after the first is separated by the existing hairline, and the first carries none');

  // The store control is under the Store caption and after every pomodoro field --
  // ordering, not just presence. Save/Reset stay ABOVE it: they belong to the sections
  // they follow, and neither touches the store.
  const at = re => { const m = html.match(re); assert.ok(m, `setup failure: ${re} not found`); return m.index; };
  const storeCaption = at(/<div class="pomodoro-settings-caption">Store<\/div>/);
  assert.ok(at(/id="pomodoro-reset"/) < storeCaption, 'Save/Reset must sit above the Store section, or they read as its actions');
  assert.ok(storeCaption < at(/id="store-prune-days"/) && at(/id="store-prune-days"/) < at(/id="store-prune"/),
    'the window field then the button, both below the Store caption');

  // One click, and no way to reach a submit by accident: `type="button"` is what keeps
  // Enter in the window field a settings SAVE rather than a deletion.
  assert.match(html, /<button type="button" class="pomodoro-btn pomodoro-btn-danger" id="store-prune"/,
    'the delete control must be type="button" -- a default submit button inside this form would prune on Enter');

  // The window has no default. Not "min=1 and value=30": no value attribute at all, so
  // an untouched field means no window was named and the click refuses (ADR 71).
  const field = html.match(/<input type="number" name="pruneDays"[^>]*>/);
  assert.ok(field, 'setup failure: no pruneDays input rendered');
  assert.doesNotMatch(field[0], /\svalue=/, 'the window must never be prefilled -- the one number that decides what dies is named at the call, never implied');
  assert.doesNotMatch(field[0], /\splaceholder=/, 'and not suggested by a placeholder either');

  // Every control under a caption carries its own aria-label repeating the caption's
  // word -- the rule the Cues pickers already follow, for the same reason: the caption
  // is a plain div, read in browse mode but not while tabbing. Each must still CONTAIN
  // its visible text (WCAG 2.5.3 label-in-name).
  for (const [re, visible] of [[/<input type="number" name="pruneDays"[^>]*aria-label="([^"]*)"/, 'Older than (days)'], [/id="store-prune"[^>]*aria-label="([^"]*)"/, 'Delete boards']]) {
    const m = html.match(re);
    assert.ok(m, `the Store control matching ${re} must carry an aria-label`);
    assert.ok(m[1].toLowerCase().includes(visible.toLowerCase()), `"${m[1]}" must contain its visible label "${visible}"`);
    assert.ok(/store/i.test(m[1]), `"${m[1]}" must name its section, the way the cue pickers name theirs`);
  }
});

await checkAsync('settings panel: the Store control deletes on ONE click, posting the window it was given and nothing else', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  const handler = call => (call.url === '/api/store/prune' ? { ok: true, boards: 0, assets: 0 } : doc);
  await withPomodoroFetch(handler, async (calls) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('details#pomodoro-settings').open = true;
    document.querySelector('input#store-prune-days').value = '30';
    document.querySelector('button#store-prune').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();

    const prunes = calls.filter(c => c.url === '/api/store/prune');
    assert.equal(prunes.length, 1, 'ONE click must delete -- no arming step, deliberately unlike the Reset button in the same panel');
    assert.equal(prunes[0].method, 'POST');
    assert.equal(prunes[0].credentials, 'same-origin', 'the index page holds only the session cookie, so it must be sent');
    assert.deepEqual(prunes[0].body, { days: 30 }, 'the window the reader named, as a number, and nothing else');
    // Never through the pomodoro's own writer: the response is a pair of counts, and
    // applying it into pomodoroDoc would wipe the widget's state.
    assert.equal(calls.filter(c => c.url.startsWith('/api/pomodoro/')).length, 0, 'a prune must post to no pomodoro route');
  });
});

await checkAsync('settings panel: a Store click with no window named is refused client-side -- nothing is posted, and it says so', async () => {
  const nowMs = Date.now();
  const doc = { settings: POMODORO_SETTINGS, cycle: 0, cycleDate: null, timer: null, now: nowMs };
  await withPomodoroFetch(() => doc, async (calls) => {
    const { document } = loadIndexWithPomodoro();
    await flushPomodoro();
    document.querySelector('details#pomodoro-settings').open = true;
    // Untouched, which is how the field renders: no default, ever.
    document.querySelector('button#store-prune').dispatchEvent(new StandInEvent('click'));
    await flushPomodoro();
    assert.equal(calls.filter(c => c.url === '/api/store/prune').length, 0,
      'a prune with no window named must not reach the daemon at all -- refused, never filled in with a plausible number');
    assert.match(document.querySelector('span#store-prune-status').textContent, /window/i,
      'and the refusal must be visible, or the click reads as a control that silently does nothing');
  });
});

check('a markdown link opens in a new tab and drops its opener', () => {
  // A board is a thing the reviewer is in the middle of: a same-tab navigation throws
  // away unsubmitted answers and half-typed comments with no warning. The `noopener`
  // half is the security one -- the opened document must not hold a window handle back
  // into a page that is authorized against the daemon.
  const html = mdToHtml('see [the render](https://example.com/doc.html)');
  assert.match(html, /<a href="https:\/\/example\.com\/doc\.html" target="_blank" rel="noopener noreferrer">the render<\/a>/);
  // A refused scheme still collapses to `#`, and still carries the same attributes --
  // the neutralised link must not become the one that navigates the board away.
  const bad = mdToHtml('[x](javascript:alert(1))');
  assert.match(bad, /<a href="#" target="_blank" rel="noopener noreferrer">/);
  assert.ok(!bad.includes('javascript:'));
});

check('no board or index CSP names an external host -- mermaid is vendored, not a CDN pin any more', () => {
  // Superseded: this used to pin the one exact `mermaid@<version>` string the CSP
  // named in both script-src and font-src, the board's own loader in src/ui.mjs, and
  // (unreachably, from this repo) a skill-side renderer's own CDN fallback all had to
  // agree on, because a CSP source expression ending in `/` is a prefix match -- a
  // floating major would have been refused, and a drift between the three would have
  // gone blank on the next board nobody thought to look at. Mermaid is vendored now (a
  // digest-pinned file under src/vendor/mermaid/, loaded the same content-addressed,
  // same-origin way as every other sibling asset -- see src/ui.mjs), so there is no
  // longer a version string for three parties to keep in sync: the policy simply names
  // no external host at all, for mermaid or anything else. What that leaves to pin is
  // the negative -- offline and structural, so a reintroduced CDN allowance (mermaid's
  // or any other) fails here rather than on the next `/security-review`. `font-src`
  // itself is not gone: it keeps exactly `data:`, for an artifact's own inline font
  // (skills/claude-board/SKILL.md tells artifact authors to inline every font as a
  // `data:` URI, since an `html` stage renders at an opaque origin) -- the AC here is
  // no external host, not no clause.
  // Checked against a CLOSED SET of allowed source expressions, not against a pattern
  // for the hosts we happen to remember. The previous gate here was `!/https?:\/\//`
  // plus a literal `jsdelivr` test, and both miss the shape a real regression takes: a
  // CSP host source needs no scheme, so `unpkg.com/npm/...` or `font-src data:
  // fonts.gstatic.com` sails through every one of them. Enumerating what a source is
  // ALLOWED to be inverts that -- an external host fails by construction, in any
  // spelling, including one nobody here thought to name.
  const ALLOWED_CSP_SOURCES = new Set(["'none'", "'self'", "'unsafe-inline'", 'data:', 'blob:']);
  for (const [name, csp] of [['CSP', CSP], ['INDEX_CSP', INDEX_CSP]]) {
    for (const clause of csp.split(';')) {
      const [directive, ...sources] = clause.trim().split(/\s+/).filter(Boolean);
      if (!directive) continue;
      for (const src of sources) {
        assert.ok(ALLOWED_CSP_SOURCES.has(src),
          `${name}'s ${directive} names ${src}, which is not in the closed set of allowed source expressions (${[...ALLOWED_CSP_SOURCES].join(' ')}) -- no external host may reach either policy, however it is spelled. Got: ${csp}`);
      }
    }
  }

  // And the loader itself: no dynamic import() of a URL -- src/ui.mjs's mermaid
  // loader is a same-origin classic <script src> element instead (see that file's own
  // comment on why: an ES module fetch is CORS-gated over `file:` regardless of
  // same-origin-ness, and upstream's own build only works as a classic script in the
  // first place). Matched as an actual CALL (a string/template literal argument),
  // not just the substring "import(" -- this file's own client-script comments say
  // 'import()' in prose, which must not trip a check about real code.
  const ui = readFileSync(path.join(repoRoot, 'src/ui.mjs'), 'utf8');
  assert.ok(!/import\(\s*['"`]/.test(ui), `src/ui.mjs must contain no dynamic import(<url>) call any more, found one: ${ui.match(/.{0,40}import\(\s*['"`].{0,40}/)?.[0]}`);
});

// =================================================================================
// ADR.md entry 63 -- renderCodeBlock's syntax
// highlighting, six-hue palette wiring, real-line-number gutter and copy fidelity.
// AC 1, 4 (contrast half lives in test/check-contrast.mjs), 6, 7 (non-diff half --
// ticket 05 owns a diff row's new/old fallback), 8. One contiguous block, appended
// last, so a parallel ticket's own additions elsewhere in this file merge cleanly.
// =================================================================================

check('AC 1: a lang with a vendored grammar highlights; absent or unvendored lang renders plain and escaped, same as before this ticket', () => {
  const board = createBoard({
    title: 'AC 1',
    blocks: [
      { kind: 'code', text: 'const x = "hi"; // note', lang: 'javascript' }, // vendored
      { kind: 'code', text: 'const x = "hi"; // note', lang: 'not-a-real-language' }, // unvendored
      { kind: 'code', text: '<div>x</div>' }, // no lang at all
    ],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const sections = [...markup.matchAll(/<section class="block code-block"[\s\S]*?<\/section>/g)].map(m => m[0]);
  assert.equal(sections.length, 3, 'setup failure: expected three code blocks');

  const [highlighted, unvendored, noLang] = sections;
  assert.ok(highlighted.includes('class="tok-keyword"'), 'javascript is vendored: const must be tokenised as a keyword');
  assert.ok(highlighted.includes('class="tok-string"'), 'javascript is vendored: the string literal must be tokenised');
  assert.ok(highlighted.includes('class="tok-comment"'), 'javascript is vendored: the trailing comment must be tokenised');

  for (const section of [unvendored, noLang]) {
    assert.ok(!section.includes('class="tok-'), 'no grammar (unvendored lang, or none at all) must emit no tok-* span');
    // Plain and escaped, exactly as renderCodeBlock did before this ticket -- the
    // ONLY thing new for a fallback block is the AC 7 gutter row wrapper.
    assert.ok(/<span class="code-row" data-line="1">[^<]*<\/span>/.test(section) || section.includes('&lt;div&gt;x&lt;/div&gt;'),
      `fallback body must be plain escaped text inside its one gutter row: ${section}`);
  }
  assert.ok(noLang.includes('&lt;div&gt;x&lt;/div&gt;'), 'a lang-less block must still HTML-escape its text');
});

check('AC 6: highlighting is classes only -- no inline colour anywhere in a code block, so a theme swap re-colours it for free with no re-post', () => {
  // The whole trick ADR.md entry 63 relies on: renderBoardPage never sees a theme
  // and never will (theme is a client-side toggle over CSS custom properties,
  // src/theme.mjs) -- so the only way "switching theme re-colours an
  // already-rendered block" can be TRUE is if the server never bakes a colour in
  // at all. Grepping the emitted code-block markup for a hex/rgb colour or a
  // `style=` attribute is a direct, mechanical proof of that, not an inference.
  const board = createBoard({
    title: 'AC 6',
    blocks: [{ kind: 'code', text: 'def f(x):\n    return x + 1  # comment\n', lang: 'python' }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(section.includes('class="tok-'), 'setup failure: python must actually highlight for this check to mean anything');
  assert.ok(!/style\s*=/.test(section), 'a code block must carry no inline style attribute at all');
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(section), 'a code block must carry no literal hex colour');
  assert.ok(!/rgba?\(/.test(section), 'a code block must carry no literal rgb/rgba colour');
});

check('AC 7 (non-diff half): a whole-file or by-value block numbers from line 1 and drops the phantom trailing-newline row; an explicit source.lines range numbers from its own start and keeps a genuinely blank last line', () => {
  const byValue = createBoard({
    title: 'AC 7a',
    blocks: [{ kind: 'code', text: 'one\ntwo\nthree', lang: 'javascript' }],
  });
  const byValueRows = [...renderBoardPage(byValue).matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(byValueRows, [1, 2, 3], 'a by-value block with no trailing newline numbers every real line, starting at 1');

  const trailingNL = createBoard({
    title: 'AC 7b',
    blocks: [{ kind: 'code', text: 'one\ntwo\nthree\n', lang: 'javascript' }],
  });
  const trailingRows = [...renderBoardPage(trailingNL).matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(trailingRows, [1, 2, 3],
    'a trailing newline is the file\'s own convention (src/resolve.mjs\'s fileLines), not a fourth blank line -- it must not mint a phantom row 4');

  const srcFile = path.join(fixturesDir, 'gutter-range.txt');
  // Lines: 1 "alpha", 2 "beta", 3 "" (blank), 4 "gamma", 5 "" (blank), 6 "zeta".
  writeFileSync(srcFile, ['alpha', 'beta', '', 'gamma', '', 'zeta'].join('\n'), 'utf8');
  const ranged = createBoard({
    title: 'AC 7c',
    cwd: fixturesDir,
    blocks: [{ kind: 'code', source: { path: 'gutter-range.txt', lines: [2, 5] } }],
  });
  const rangedRows = [...renderBoardPage(ranged).matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(rangedRows, [2, 3, 4, 5],
    'an explicit source.lines range starts numbering at its own first line and keeps every requested row, blank ones included -- never the from-1/drop-trailing-blank rule the whole-file case uses');
});

check('AC 8: selecting and copying a code block yields block.text back exactly -- no gutter digits, no injected newlines, for a plain block, a highlighted multi-line one, one with a trailing newline, and one whose last line is genuinely blank', () => {
  const cases = [
    'const x = 1;', // single line, highlighted
    'one\ntwo\nthree', // multi-line, no trailing newline
    'one\ntwo\nthree\n', // multi-line, WITH a trailing newline (the artifact AC 7 drops from the gutter, but never from the text)
    'alpha\n\nbeta\n', // a genuinely blank middle line
    '/* a\n   multi-line\n   comment */\nconst after = 1;', // a single Prism token spanning three physical lines
    '', // empty block
  ];
  for (const text of cases) {
    const board = createBoard({ title: 'AC 8', blocks: [{ kind: 'code', text, lang: 'javascript' }] });
    const document = parseHTML(renderBoardPage(board));
    const codeEl = document.querySelector('.code-block pre code');
    assert.ok(codeEl, `setup failure: no rendered <code> for ${JSON.stringify(text)}`);
    assert.equal(codeEl.textContent, text,
      `copied text must be byte-identical to block.text for ${JSON.stringify(text)}, got ${JSON.stringify(codeEl.textContent)}`);
  }
});

check('AC 8, structurally: a multi-line highlighted token never leaves an unbalanced span straddling a row boundary', () => {
  // The hazard highlightRows (src/render.mjs) exists to avoid: tokenising the WHOLE
  // text first and only then splitting on '\n' would let a single tok-comment span
  // cross into the next row's own <span class="code-row">, an invalid nesting no
  // DOM can represent -- parseHTML would either throw or silently reshuffle it,
  // either of which breaks the byte-identity check above. Counted directly here so
  // a regression shows up as an obvious tag-count mismatch, not a confusing parse
  // failure three checks away.
  const board = createBoard({
    title: 'AC 8 balance',
    blocks: [{ kind: 'code', text: '/* start\nmiddle\nend */\nconst x = 1;\n// trailing comment', lang: 'javascript' }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  const opens = (section.match(/<span/g) || []).length;
  const closes = (section.match(/<\/span>/g) || []).length;
  assert.equal(opens, closes, `every opened span must close within the section: ${opens} opens vs ${closes} closes`);
  // Five physical lines -> five gutter rows, none skipped and none merged.
  const dataLines = [...section.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(dataLines, [1, 2, 3, 4, 5]);
});

check('every vendored language src/resolve.mjs\'s langForPath can name actually highlights through renderCodeBlock, not just through grammarFor in isolation', () => {
  // grammarFor is exercised directly by test/check-vendor-digest.mjs (ticket 01,
  // AC 2/15); this proves the SAME grammars are reachable end to end through the
  // render path this ticket owns, for one representative snippet per language.
  //
  // ALL 20 of AC 2's languages, not a subset. This sweep used to cover 16 and omit
  // exactly markdown, tsx, jsx and html -- and `markdown` was the one of those four
  // that genuinely emitted no tok-* span at all (flattenTokens read only `t.type`,
  // and Prism's markdown grammar carries every one of its coloured types as an
  // ALIAS instead: `title` is `alias: 'important'`, `code-snippet` is
  // `alias: ['code', 'keyword']`, while its own top-level type names -- title, bold,
  // italic, list, url, code-snippet, blockquote -- intersect TOKEN_CLASS nowhere).
  // A `markdown` code block was therefore indistinguishable from the no-grammar
  // fallback, against AC 1's promise, and the sweep's own omission is what let that
  // ship green. Hence: the list below is asserted to BE AC 2's list, so the next
  // language added cannot be quietly left out of it either.
  const samples = {
    javascript: 'const x = 1; // c',
    typescript: 'const x: number = 1;',
    tsx: 'const App = (): JSX.Element => <div className="a">{x}</div>;',
    jsx: 'const App = () => <div className="a">{x}</div>;',
    python: 'def f(x):\n    return x',
    ruby: 'def f(x)\n  x\nend',
    go: 'func main() { x := 1 }',
    rust: 'fn main() { let x = 1; }',
    java: 'class X { int x = 1; }',
    c: 'int main() { int x = 1; }',
    cpp: 'int main() { int x = 1; }',
    bash: 'echo "hi" # note',
    json: '{"a": 1}',
    yaml: 'a: 1',
    markdown: '# Title\n\n**bold** text and `a snippet`.\n',
    html: '<!doctype html>\n<div class="a">text</div>',
    css: '/* note */\n.a { content: "x"; }',
    sql: 'SELECT * FROM t;',
    swift: 'let x = 1',
    kotlin: 'val x = 1',
  };
  // 'diff' is the one SUPPORTED_LANGUAGES name deliberately absent: ADR.md entry 64
  // makes "a diff row never carries a six-hue tok-* class" true by construction, so
  // asserting one here would assert the opposite of AC 5. Its own rendering is
  // covered by the ticket-05 section below.
  assert.deepEqual(
    Object.keys(samples).sort(),
    SUPPORTED_LANGUAGES.filter(l => l !== 'diff').sort(),
    'this sweep must cover every vendored language AC 2 names -- no quiet omissions');
  for (const [lang, text] of Object.entries(samples)) {
    const board = createBoard({ title: `lang ${lang}`, blocks: [{ kind: 'code', text, lang }] });
    const markup = renderedMarkup(renderBoardPage(board));
    const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
    assert.ok(section.includes('class="tok-'), `${lang}: expected at least one highlighted token, got: ${section}`);
  }
});

// =================================================================================
// ADR.md entry 65: a fenced code
// block inside markdown highlights through the SAME tokenizer a `kind: 'code'`
// block uses (src/render.mjs's highlightRows/TOKEN_CLASS, reached here through the
// exported highlightFenceHtml and, in the real render path, src/board.mjs's
// dependency injection into mdToHtmlAndAnchors -- see that entry for why an
// injected argument stands in for an import neither module can carry directly).
// =================================================================================

check('AC 14: a fenced code block inside markdown highlights through the exact same tokenizer as a kind: "code" block -- same input, same spans, both entry points', () => {
  const code = 'const x = "hi"; // note\nfunction f(n) {\n  return n + 1;\n}';
  const board = createBoard({
    title: 'AC 14',
    blocks: [
      { kind: 'code', text: code, lang: 'javascript' },
      { kind: 'markdown', text: '```javascript\n' + code + '\n```\n' },
    ],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const codeSection = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  const mdSection = /<section class="block markdown-block"[\s\S]*?<\/section>/.exec(markup)[0];
  const codeInner = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(codeSection);
  const mdInner = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(mdSection);
  assert.ok(codeInner, 'setup failure: no rendered kind:"code" body');
  assert.ok(mdInner, 'setup failure: no rendered markdown fence body');
  assert.ok(codeInner[1].includes('class="tok-keyword"'), 'setup failure: the code block itself must actually highlight');

  // Strip the AC 7 gutter wrapper (`<span class="code-row" data-line="N">...
  // </span>`, one per real '\n'-joined row -- see codeBody, src/render.mjs) down to
  // the bare tok-*-classed markup a fence gets directly from highlightFenceHtml,
  // which never adds that wrapper (this file's own "the gutter is a code-block
  // affordance" decision -- a fence has no source.lines, so no real line number to
  // gutter). Splitting on '\n' first is safe here specifically because AC 8's
  // structural check already proves no tok-* span ever straddles a row boundary,
  // so every line is exactly one balanced `<span class="code-row" ...>...</span>`.
  const gutterless = codeInner[1].split('\n')
    .map(row => row.replace(/^<span class="code-row" data-line="\d+">/, '').replace(/<\/span>$/, ''))
    .join('\n');
  assert.equal(gutterless, mdInner[1],
    'the same source text and lang must produce byte-identical tok-* spans through both entry points, modulo the code-block-only gutter');

  // And directly against the seam itself: proves the markdown path is really
  // CALLING this function (via board.mjs's injection), not an independent
  // implementation that happens to agree on this one input. highlightFenceHtml now
  // returns the fence's WHOLE markup (the label wrapper included, see below), so
  // the comparison is against its own <code> inner text, extracted the same way
  // mdInner was, not against the raw return value.
  const directInner = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(highlightFenceHtml(code, 'javascript'));
  assert.ok(directInner, 'setup failure: highlightFenceHtml(code, \'javascript\') did not return <pre><code>...</code></pre>');
  assert.equal(mdInner[1], directInner[1],
    'a markdown fence\'s highlighted body must be exactly what highlightFenceHtml returns for the same text and lang');

  // Spec contract edit, 2026-08-09: a vendored language gets a small label, added
  // on a wrapper div around <pre> -- never inside <code> (mdInner[1], asserted
  // above, is unaffected by it) -- so a reader can tell what a fence is without
  // reading its contents, the same thing the standalone block's kicker already
  // gives a 'kind: code' block.
  assert.ok(mdSection.includes('<div class="fence-lang" data-lang="javascript">'),
    'a fence whose lang has a vendored grammar must be wrapped in the language-label div, carrying the lang verbatim');
});

check('the language label is generated content, not a DOM node: wrapping a labelled fence in the div does not change what its <code> contains, so copy fidelity holds exactly as it did before the label existed', () => {
  // Same proof shape as AC 8 above (parseHTML + .textContent), aimed specifically
  // at the new wrapper: if the label were ever a real text node (or if escAttr's
  // output somehow leaked into <code>) this would be the assertion that catches
  // it, since a DOM parse -- unlike a substring check -- reads exactly what a
  // browser selection would copy.
  const code = 'const x = "hi"; // note\nfunction f(n) {\n  return n + 1;\n}';
  const board = createBoard({ title: 'fence label copy', blocks: [{ kind: 'markdown', text: '```javascript\n' + code + '\n```\n' }] });
  const document = parseHTML(renderBoardPage(board));
  const wrapper = document.querySelector('.fence-lang');
  assert.ok(wrapper, 'setup failure: no rendered .fence-lang wrapper');
  const codeEl = wrapper.querySelector('pre code');
  assert.ok(codeEl, 'setup failure: no rendered <code> inside the label wrapper');
  assert.equal(codeEl.textContent, code,
    `copied fence text must be byte-identical to the fence's own text with a language label present, got ${JSON.stringify(codeEl.textContent)}`);
});

check('AC 14: a fence with no lang, or an unvendored one, falls back to plain escaped text inside markdown -- same fallback rule as a kind: "code" block (AC 1)', () => {
  const board = createBoard({
    title: 'AC 14 fallback',
    blocks: [
      { kind: 'markdown', text: '```\n<div>x</div>\n```\n' }, // no lang at all
      { kind: 'markdown', text: '```not-a-real-language\nconst x = 1;\n```\n' }, // unvendored
    ],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const sections = [...markup.matchAll(/<section class="block markdown-block"[\s\S]*?<\/section>/g)].map(m => m[0]);
  assert.equal(sections.length, 2, 'setup failure: expected two markdown blocks');
  for (const section of sections) {
    assert.ok(!section.includes('class="tok-'), 'no grammar (unvendored lang, or none at all) must emit no tok-* span inside markdown either');
    // Spec contract edit, 2026-08-09: the label tracks the exact same
    // vendored-or-not test as the colour itself (grammarFor(lang)), so neither a
    // lang-less fence nor an unvendored one gets the wrapper div -- the markup is
    // byte-for-byte '<pre><code>...' with no label, same as before this change.
    assert.ok(!section.includes('class="fence-lang"'), 'no vendored grammar must mean no language label either, same condition as the colour');
    assert.ok(section.includes('<pre><code>'), 'setup failure: expected an unwrapped <pre><code> for a fence with no label');
  }
  assert.ok(sections[0].includes('&lt;div&gt;x&lt;/div&gt;'), 'a lang-less fence must still HTML-escape its text');
});

check('AC 13 still holds alongside AC 14: a ```mermaid fence is never routed through the highlighter, even now that a plain fence is', () => {
  const board = createBoard({
    title: 'AC 13 vs 14',
    blocks: [{ kind: 'markdown', text: '```mermaid\nflowchart TD\n  a --> b\n```\n' }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  assert.ok(markup.includes('<pre class="mermaid">flowchart TD'), 'a mermaid fence must still become <pre class="mermaid">, raw text for the client to read');
  const section = /<section class="block markdown-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(!section.includes('class="tok-'), 'a mermaid fence must never be tokenised -- it is diagram source, not code');
  assert.ok(!section.includes('class="code-row"'), 'a mermaid fence must never get a code-block gutter either');
  // markdown.mjs's renderCode branches to the mermaid host BEFORE ever calling
  // `highlight` (see its own comment), so the language-label wrapper -- which
  // only highlightFenceHtml can add -- must never appear on a mermaid fence.
  assert.ok(!section.includes('class="fence-lang"'), 'a mermaid fence must never get the language label either -- it never reaches highlightFenceHtml at all');
});

check('every other markdown check (no highlight option passed) keeps rendering a fence plain and escaped, byte-identical to before this ticket', () => {
  // mdToHtml/mdToHtmlAndAnchors called directly, with no `opts.highlight` -- every
  // check above this section in this file does exactly that, and this pins the
  // default explicitly so a future change to board.mjs's wiring can't silently
  // start highlighting these too without a check noticing.
  const out = mdToHtml('```javascript\nconst x = 1;\n```\n');
  assert.equal(out, '<pre><code>const x = 1;</code></pre>', 'no highlight option: a fence must render exactly as it always has, no tok-* span');
});

// =================================================================================
// A diff reads as a diff -- AC 3 (.diff/.patch ->
// lang: 'diff'), AC 5 (add/remove fill, six-hue colour suppressed by construction,
// ADR.md entry 64), the diff half of AC 7 (new/old line numbers from the diff's own hunk headers),
// and AC 8 through the diff path (copy fidelity, '+'/'-' signs included since they
// are the diff file's own bytes, never anything this renderer invented).
// =================================================================================

check('AC 3: .diff and .patch resolve to lang: \'diff\' through langForPath', () => {
  assert.equal(langForPath('changes.diff'), 'diff');
  assert.equal(langForPath('changes.patch'), 'diff');
  assert.equal(langForPath('src/foo.diff'), 'diff');
});

check('AC 3, end to end: a code block resolved from a .diff file gets lang: \'diff\' with no explicit lang, and renders through the diff path', () => {
  writeFileSync(path.join(fixturesDir, 'sample.diff'), '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', 'utf8');
  const board = createBoard({ title: 'AC3', cwd: fixturesDir, blocks: [{ kind: 'code', source: { path: 'sample.diff' } }] });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(section.includes('class="code-diff"'), 'a .diff reference must highlight through the diff path with no lang given explicitly');
  assert.ok(section.includes('class="code-row diff-del"'));
  assert.ok(section.includes('class="code-row diff-add"'));
});

check('AC 5: an added row carries --good at alpha 0.12 (.diff-add), a removed row carries --critical at alpha 0.12 (.diff-del), and a diff block NEVER carries a six-hue tok-* class -- structurally, not by inference', () => {
  const board = createBoard({
    title: 'AC 5',
    blocks: [{
      kind: 'code',
      lang: 'diff',
      text: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-removed line\n+added line\n',
    }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(/<span class="code-row diff-del" data-line="\d+">-removed line<\/span>/.test(section),
    'a removed row must carry .diff-del');
  assert.ok(/<span class="code-row diff-add" data-line="\d+">\+added line<\/span>/.test(section),
    'an added row must carry .diff-add');
  // The structural promise itself: "the fill is never composited under a six-hue
  // token" is made true by construction (TOKEN_CLASS has no diff token mapped to a
  // tok-* name) -- asserted here directly against the rendered bytes, not trusted
  // from reading the source.
  assert.ok(!section.includes('class="tok-'), 'a diff block must never emit a six-hue tok-* span, added/removed rows included');
  // And the block-level colour drop (AC 5's "syntax colour drops to --code-ink"):
  // the <code> element itself carries the modifier class that overrides
  // .code-block pre code's own --code-base default (src/styles.mjs).
  assert.ok(section.includes('<pre><code class="code-diff">'), 'a diff block\'s <code> must carry the code-diff modifier class');
});

check('AC 5: a diff\'s own structural lines (file headers, hunk headers) are styled as --muted italic (.diff-meta), never fill, never a gutter number', () => {
  const board = createBoard({
    title: 'AC 5 meta',
    blocks: [{ kind: 'code', lang: 'diff', text: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n' }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(section.includes('<span class="code-row"><span class="diff-meta">--- a/x</span></span>'));
  assert.ok(section.includes('<span class="code-row"><span class="diff-meta">+++ b/x</span></span>'));
  assert.ok(section.includes('<span class="code-row"><span class="diff-meta">@@ -1 +1 @@</span></span>'));
  assert.ok(!/diff-meta[\s\S]{0,40}data-line/.test(section) && !/data-line="\d+"[^>]*>\s*<span class="diff-meta"/.test(section),
    'a header row\'s own .code-row must carry no data-line attribute at all -- it names no line in either file');
});

check('AC 7 (diff half): an added/context row is numbered with the NEW-file line, a removed row falls back to the OLD-file line, and header/hunk rows carry no gutter number at all', () => {
  const text = [
    '--- a/x', '+++ b/x',
    '@@ -1,4 +1,5 @@',
    ' unchanged one',      // context -- new file line 1
    '-old two',            // removed -- old file line 2
    '-old three',          // removed -- old file line 3
    '+new two',            // added -- new file line 2
    '+new three',          // added -- new file line 3
    '+new four',           // added -- new file line 4
    ' unchanged five',     // context -- new file line 5
    '',
  ].join('\n');
  const board = createBoard({ title: 'AC7 diff', blocks: [{ kind: 'code', lang: 'diff', text }] });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  const rows = [...section.matchAll(/<span class="code-row([^"]*)"( data-line="(\d+)")?>/g)]
    .map(m => ({ cls: m[1].trim(), line: m[3] ? Number(m[3]) : null }));
  assert.deepEqual(rows, [
    { cls: '', line: null },              // --- a/x (file header)
    { cls: '', line: null },              // +++ b/x (file header)
    { cls: '', line: null },              // @@ ... @@ (hunk header)
    { cls: '', line: 1 },                 // unchanged one -> new-file line 1
    { cls: 'diff-del', line: 2 },         // old two -> old-file line 2
    { cls: 'diff-del', line: 3 },         // old three -> old-file line 3
    { cls: 'diff-add', line: 2 },         // new two -> new-file line 2
    { cls: 'diff-add', line: 3 },         // new three -> new-file line 3
    { cls: 'diff-add', line: 4 },         // new four -> new-file line 4
    { cls: '', line: 5 },                 // unchanged five -> new-file line 5
  ]);
});

check('AC 7 (diff half): a malformed or header-less diff degrades to every row reading blank in the gutter -- no line number invented, and no throw', () => {
  const board = createBoard({
    title: 'AC7 malformed',
    blocks: [{ kind: 'code', lang: 'diff', text: 'this is not\na real unified diff\nat all\n' }],
  });
  assert.doesNotThrow(() => renderBoardPage(board));
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(!/data-line="\d+"/.test(section), 'a diff with no recognisable hunk header must gutter nothing, not guess');
  assert.ok(!section.includes('diff-add') && !section.includes('diff-del'), 'no add/remove fill without a real hunk to derive it from');
  assert.ok(section.includes('this is not'), 'the text itself must still render, plain, not dropped');
});

check('AC 7 (diff half): a multi-file diff resets its line counters at the second file\'s own headers -- never reads it against the first file\'s stale coordinates', () => {
  const text = [
    'diff --git a/one.txt b/one.txt',
    '--- a/one.txt', '+++ b/one.txt',
    '@@ -1,1 +1,1 @@',
    '-file one old',
    '+file one new',
    'diff --git a/two.txt b/two.txt',
    '--- a/two.txt', '+++ b/two.txt',
    '@@ -10,1 +20,1 @@',
    '-file two old',
    '+file two new',
    '',
  ].join('\n');
  const board = createBoard({ title: 'AC7 multi-file', blocks: [{ kind: 'code', lang: 'diff', text }] });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(/<span class="code-row diff-del" data-line="1">-file one old<\/span>/.test(section));
  assert.ok(/<span class="code-row diff-add" data-line="1">\+file one new<\/span>/.test(section));
  // File two's hunk starts at old=10/new=20 -- if the counters leaked across the
  // 'diff --git' boundary these would read 2/2 (one past file one's single line)
  // instead of the coordinates file two's own '@@' actually names.
  assert.ok(/<span class="code-row diff-del" data-line="10">-file two old<\/span>/.test(section));
  assert.ok(/<span class="code-row diff-add" data-line="20">\+file two new<\/span>/.test(section));
});

check('AC 8 through the diff path: selecting and copying a diff block yields the original bytes exactly -- \'+\'/\'-\' signs included (they are the file\'s own bytes), no gutter digits, no injected newlines', () => {
  const cases = [
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', // trailing newline
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',   // no trailing newline
    'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,3 @@\n ctx\n-gone\n+here\n+also here\n',
    'not a diff at all, just text\nwith a - dash and a + plus in it\n', // malformed, still must round-trip
    '',
  ];
  for (const text of cases) {
    const board = createBoard({ title: 'AC8 diff', blocks: [{ kind: 'code', lang: 'diff', text }] });
    const document = parseHTML(renderBoardPage(board));
    const codeEl = document.querySelector('.code-block pre code');
    assert.ok(codeEl, `setup failure: no rendered <code> for ${JSON.stringify(text)}`);
    assert.equal(codeEl.textContent, text,
      `copied text must be byte-identical to block.text for ${JSON.stringify(text)}, got ${JSON.stringify(codeEl.textContent)}`);
  }
});

check('a markdown \'diff\' fence highlights through the SAME tokenizer as a kind: "code" diff block (ADR.md entry 65) -- header lines get .diff-meta AND added/removed rows get the .diff-add/.diff-del fill (ticket 05\'s Delivers line: "a referenced .patch/.diff file, or a fenced diff, renders with added and removed rows tinted the way a patch viewer tints them"), but still no gutter -- a fence carries no source.lines, so it has no real line number, but the fill needs nothing but the diff\'s own hunk headers', () => {
  const diffText = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new';
  const board = createBoard({
    title: 'diff fence',
    blocks: [{ kind: 'markdown', text: '```diff\n' + diffText + '\n```\n' }],
  });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block markdown-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(section.includes('class="diff-meta"'), 'the fence\'s own header lines must still get the diff-meta treatment through the shared tokenizer');
  // The fix this section pins: a fenced diff DOES get the add/remove fill now --
  // a naive re-read of ADR 65 ("a fence never gets codeBody's gutter") used to be
  // read as "a fence never gets ANY row wrapper", which silently dropped the fill
  // too and left a fenced diff reading as undifferentiated text, the exact gap
  // this ticket exists to close.
  assert.ok(/<span class="code-row diff-flat diff-del">-old<\/span>/.test(section), 'a removed row inside a diff fence must carry .diff-del');
  assert.ok(/<span class="code-row diff-flat diff-add">\+new<\/span>/.test(section), 'an added row inside a diff fence must carry .diff-add');
  // But still no GUTTER: no data-line attribute anywhere (a fence has no
  // source.lines, so no real line number to show -- AC 7 is a kind: 'code' block
  // promise only), and .diff-flat is what keeps a fenced diff's rows flush left
  // rather than indented for a gutter column that would never show anything.
  assert.ok(!/data-line/.test(section), 'a fence must never gutter a line number, diff or not -- it has no source.lines');
  assert.ok(section.includes('diff-flat'), 'every row of a diff fence must carry the no-gutter modifier');
  assert.ok(!section.includes('class="tok-'), 'a diff fence must never emit a six-hue tok-* span, same structural promise as a kind: "code" diff block');
  // And directly against the seam: byte-identical to what highlightFenceHtml
  // returns for the same input, same as AC 14's own proof for an ordinary language.
  // highlightFenceHtml returns the WHOLE fence markup (label wrapper included, see
  // its own comment), so this compares <code> inner text to <code> inner text.
  const mdInner = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(section);
  assert.ok(mdInner, 'setup failure: no rendered fence body');
  const directInner = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(highlightFenceHtml(diffText, 'diff'));
  assert.ok(directInner, 'setup failure: highlightFenceHtml(diffText, \'diff\') did not return <pre><code>...</code></pre>');
  assert.equal(mdInner[1], directInner[1]);

  // 'diff' is itself a vendored grammar (SUPPORTED_LANGUAGES), so a fenced diff
  // gets the same language label as any other vendored fence -- the label tracks
  // "does this lang have a grammar", not "does it use the six-hue palette" (ADR
  // 64 suppresses colour on a diff row, a separate and later decision).
  assert.ok(section.includes('<div class="fence-lang" data-lang="diff">'), 'a fenced diff must still get the language label -- diff is vendored too');
});

check('a markdown \'diff\' fence: copy fidelity still holds through the new fill-only row wrapper -- \'+\'/\'-\' signs included, no gutter digits (there are none), no injected newlines', () => {
  // A fence's OWN closing ``` sits on its own line, and that line-ending is
  // fence delimiter syntax, not content -- marked's fence tokenizer never hands
  // the trailing '\n' immediately before the closing fence to the renderer as
  // part of `t.text`, for ANY language (verified directly against an ordinary
  // javascript fence, unrelated to this ticket's diff-only change). So each case
  // below is built with the closing fence unconditionally on its own fresh line
  // (never glued onto the diff text's own last line, which would malform the
  // fence itself), and the byte this must round-trip is `diffText` with at most
  // one trailing '\n' stripped -- exactly what the fence's `t.text` actually is.
  const cases = [
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', // trailing newline
    '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',   // no trailing newline
    '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
  ];
  for (const diffText of cases) {
    const fenceBody = diffText.endsWith('\n') ? diffText : diffText + '\n';
    const board = createBoard({ title: 'fence copy', blocks: [{ kind: 'markdown', text: '```diff\n' + fenceBody + '```\n' }] });
    const document = parseHTML(renderBoardPage(board));
    const codeEl = document.querySelector('.md-content pre code');
    assert.ok(codeEl, `setup failure: no rendered fence <code> for ${JSON.stringify(diffText)}`);
    const expected = diffText.replace(/\n$/, '');
    assert.equal(codeEl.textContent, expected,
      `copied fence text must be byte-identical to the fence's own text for ${JSON.stringify(diffText)}, got ${JSON.stringify(codeEl.textContent)}`);
  }
});

check('a markdown \'diff\' fence: the kind: "code" diff block path is unaffected -- still real gutter numbers, no .diff-flat, exactly as before this fix', () => {
  const diffText = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n';
  const board = createBoard({ title: 'block unaffected', blocks: [{ kind: 'code', lang: 'diff', text: diffText }] });
  const markup = renderedMarkup(renderBoardPage(board));
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  assert.ok(!section.includes('diff-flat'), 'a kind: "code" diff block must never carry the fence-only no-gutter modifier');
  assert.ok(/<span class="code-row" data-line="1"> context<\/span>/.test(section), 'a context row must still carry its real gutter number');
  assert.ok(/<span class="code-row diff-del" data-line="2">-old<\/span>/.test(section), 'a removed row must still carry its real gutter number');
  assert.ok(/<span class="code-row diff-add" data-line="2">\+new<\/span>/.test(section), 'an added row must still carry its real gutter number');
});

// =================================================================================
// Defects found in src/render.mjs after the
// rendering feature landed. One contiguous block, appended last, same convention as
// the ticket sections above. Each check below went red against the code as shipped.
// =================================================================================

check('a code block\'s gutter number is both escaped and validated: a non-integer source.lines[0] never reaches the data-line attribute, and never as markup', () => {
  // Reachability, which is the whole reason this is not theoretical: src/resolve.mjs's
  // resolveRef validates `lines` in the `else if (ref.lines)` arm of an if/else whose
  // FIRST arm is `ref.section`. A reference carrying BOTH selectors takes the section
  // branch, so `lines` is never bounds-checked, never integer-checked, and never
  // errors -- and src/board.mjs stores `source: raw.source ?? null` verbatim, so the
  // caller's own bytes arrive at codeBody with `block.error` undefined. The block
  // looks perfectly healthy; the page carries live markup out of an attribute.
  writeFileSync(path.join(fixturesDir, 'gutter-xss.md'), '# Install\n\nalpha\nbeta\n', 'utf8');
  const payload = '1"><img src=x onerror=alert(1)><span data-x="';
  const board = createBoard({
    title: 'gutter injection',
    cwd: fixturesDir,
    blocks: [{ kind: 'code', source: { path: 'gutter-xss.md', section: 'install', lines: [payload, 2] } }],
  });
  assert.equal(board.blocks[0].error, undefined,
    'setup: the section selector wins, so the reference resolves clean -- the "looks healthy" half of the defect');
  const page = renderBoardPage(board);
  const markup = renderedMarkup(page);

  // The escaping half. `<img src=x` must not exist as markup anywhere the renderer
  // wrote it. (The board JSON in #board-data still carries the payload as a JSON
  // string value -- that is hydration data, not markup, and renderedMarkup strips it;
  // see QUIRKS.md "a rendered page contains every comment's text twice".)
  // Note the payload IS expected to appear, escaped, as text: sourceLabel puts the
  // reference's own selectors in the block kicker, and that string goes through
  // escHtml like every other kicker. Escaped text carrying the characters 'onerror='
  // is inert; what must not exist is a TAG.
  assert.ok(!markup.includes('<img'), `a gutter number must never open a tag: ${markup.slice(markup.indexOf('code-block'), markup.indexOf('code-block') + 400)}`);
  assert.doesNotMatch(markup, /<\w+[^>]*\son\w+\s*=/i, 'a gutter number must never carry an event handler into a real tag');

  // The validation half. Escaping alone would leave `data-line="1&quot;&gt;&lt;img
  // ..."` -- inert, but a nonsense gutter rendered through
  // `::before { content: attr(data-line) }`. Every emitted gutter number is a
  // plain integer or the attribute is absent; nothing else is a line number.
  for (const [, value] of markup.matchAll(/data-line="([^"]*)"/g)) {
    assert.match(value, /^\d+$/, `every data-line value must be a bare integer, got ${JSON.stringify(value)}`);
  }
  // And the degradation is the sane one: a block whose range is not a real range is
  // not an explicit range at all, so it numbers from 1 like any whole-file block
  // rather than from whatever the caller put there.
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(markup)[0];
  const lines = [...section.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(lines[0], 1, 'an unvalidated range falls back to the whole-file numbering, not to the caller\'s bytes');
});

check('N2: a code block is bounded on the request thread -- Prism\'s tokenizers are quadratic on ordinary unterminated content, and the daemon is single-threaded', () => {
  // Measured on this machine (see MAX_HIGHLIGHT_CHARS in src/render.mjs for the full
  // table): `'/' + 'a'.repeat(n)` -- an unterminated regex literal, i.e. a truncated
  // or minified .js -- through the typescript grammar takes 73ms at 4KB, 286ms at
  // 8KB, 1178ms at 16KB, a clean 4x per doubling. Ablation (drop the cutoff): the
  // 256KB block below is 8192x the threshold's work at (256/8)^2 = 1024x, i.e. about
  // five MINUTES of one blocked thread -- and paid AGAIN on every renderBoardPage,
  // every SSE fragment and every packet build, since highlighting is not cached.
  const text = '/' + 'a'.repeat(256 * 1024 - 1); // inside byValueText's MAX_REF_BYTES cap
  const board = createBoard({ title: 'N2 prism', blocks: [{ kind: 'code', lang: 'typescript', text }] });
  const started = Date.now();
  const page = renderBoardPage(board);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `rendering a 256KB adversarial code block took ${elapsed}ms`);
  assert.ok(page.includes('code-block'), 'setup failure: the block must actually have rendered');
});

check('the highlighting cutoff is a fallback, not a failure: under it a block still highlights, over it it renders exactly as an unvendored lang does, and copy fidelity holds on both sides', () => {
  const under = 'const x = "hi"; // note\n'.repeat(300); // ~7KB, under the threshold
  const over = 'const x = "hi"; // note\n'.repeat(2000);  // ~46KB, over it
  assert.ok(under.length < 8192 && over.length > 8192, 'setup: one sample each side of MAX_HIGHLIGHT_CHARS');

  const boardUnder = createBoard({ title: 'under', blocks: [{ kind: 'code', lang: 'javascript', text: under }] });
  const boardOver = createBoard({ title: 'over', blocks: [{ kind: 'code', lang: 'javascript', text: over }] });
  const markupUnder = renderedMarkup(renderBoardPage(boardUnder));
  const markupOver = renderedMarkup(renderBoardPage(boardOver));
  assert.ok(markupUnder.includes('class="tok-'), 'a block under the cutoff must still highlight -- the cutoff is not allowed to be so tight it turns the feature off');
  assert.ok(!markupOver.includes('class="tok-'), 'a block over the cutoff falls back to AC 1\'s plain escaped rendering, the same branch an unvendored lang takes');
  // AC 7 and AC 8 are unaffected on either side: the gutter still numbers every row,
  // and the text still round-trips byte for byte.
  for (const [name, board, text] of [['under', boardUnder, under], ['over', boardOver, over]]) {
    const document = parseHTML(renderBoardPage(board));
    assert.equal(document.querySelector('.code-block pre code').textContent, text,
      `${name} the cutoff, the block's text must still copy back byte-identically`);
  }
  assert.ok(/data-line="2000"/.test(markupOver), 'an unhighlighted block still gets its full gutter -- only tokenization is skipped');
});

check('the diff classifier reads a \'---\'/\'+++\' line as a FILE HEADER only outside a hunk: inside one, those bytes are the file\'s own content behind a +/- prefix', () => {
  // The prefix is prepended to the file's bytes, so a removed '-- legacy join' (a SQL
  // comment) arrives as '--- legacy join' and an added '++i_count;' arrives as
  // '+++i_count;'. Both used to match the file-header branch, which set BOTH counters
  // to null -- so every row after them lost its gutter number AND its diff-add/
  // diff-del tint. Trivially reachable: '---' rules and YAML front matter in this
  // repo's own docs, '--' comments in any .sql.
  const text = [
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,3 +1,3 @@',
    ' SELECT 1;',
    '--- legacy join',   // REMOVED: the file's own '-- legacy join'
    '+++i_count;',       // ADDED: the file's own '++i_count;'
    ' SELECT 2;',
    '',
  ].join('\n');
  const board = createBoard({ title: 'diff header confusion', blocks: [{ kind: 'code', lang: 'diff', text }] });
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(renderedMarkup(renderBoardPage(board)))[0];
  const rows = [...section.matchAll(/<span class="code-row([^"]*)"( data-line="(\d+)")?>/g)]
    .map(m => ({ cls: m[1].trim(), line: m[3] ? Number(m[3]) : null }));
  assert.deepEqual(rows, [
    { cls: '', line: null },        // --- a/q.sql   (a real file header: outside any hunk)
    { cls: '', line: null },        // +++ b/q.sql   (ditto)
    { cls: '', line: null },        // @@ -1,3 +1,3 @@
    { cls: '', line: 1 },           // ' SELECT 1;'  context, new line 1
    { cls: 'diff-del', line: 2 },   // '--- legacy join' is CONTENT, not a header
    { cls: 'diff-add', line: 2 },   // '+++i_count;' likewise
    { cls: '', line: 3 },           // ' SELECT 2;'  context, new line 3 -- the row that used to lose everything
  ]);
});

check('a hunk ends when the line counts its own @@ header declares are exhausted, so a following file\'s headers are read as headers again', () => {
  // The other half of consuming the declared counts: a plain (non-git) multi-file
  // unified diff has no 'diff --git' line to fall back on -- only the '---'/'+++'
  // pair, which is exactly the shape the check above proves is NOT a header inside a
  // hunk. Leaving hunk state at exhaustion is what makes both true at once.
  const text = [
    '--- a/one.txt', '+++ b/one.txt',
    '@@ -1,1 +1,1 @@',
    '-one old',
    '+one new',
    '--- a/two.txt', '+++ b/two.txt',
    '@@ -10,1 +20,1 @@',
    '-two old',
    '+two new',
    '',
  ].join('\n');
  const board = createBoard({ title: 'plain multi-file diff', blocks: [{ kind: 'code', lang: 'diff', text }] });
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(renderedMarkup(renderBoardPage(board)))[0];
  const rows = [...section.matchAll(/<span class="code-row([^"]*)"( data-line="(\d+)")?>/g)]
    .map(m => ({ cls: m[1].trim(), line: m[3] ? Number(m[3]) : null }));
  assert.deepEqual(rows, [
    { cls: '', line: null },
    { cls: '', line: null },
    { cls: '', line: null },
    { cls: 'diff-del', line: 1 },
    { cls: 'diff-add', line: 1 },
    { cls: '', line: null },        // file two's '---' -- the hunk above is exhausted, so this IS a header
    { cls: '', line: null },
    { cls: '', line: null },
    { cls: 'diff-del', line: 10 },  // file two's own coordinates, never file one's stale ones
    { cls: 'diff-add', line: 20 },
  ]);
});

check('\'\\ No newline at end of file\' is diff meta, not a context line: it is a line of neither file, so it takes no gutter number and advances no counter', () => {
  // Canonical git output for editing a last line that has no trailing newline. The
  // marker fell through to the context branch, which gave it a number of its own AND
  // advanced both counters -- so the added 'three!' (line 3 of the new file) rendered
  // as line 4, and both marker rows carried numbers.
  const text = [
    '--- a/f.txt', '+++ b/f.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    ' two',
    '-three',
    '\\ No newline at end of file',
    '+three!',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const board = createBoard({ title: 'no newline marker', blocks: [{ kind: 'code', lang: 'diff', text }] });
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(renderedMarkup(renderBoardPage(board)))[0];
  const rows = [...section.matchAll(/<span class="code-row([^"]*)"( data-line="(\d+)")?>/g)]
    .map(m => ({ cls: m[1].trim(), line: m[3] ? Number(m[3]) : null }));
  assert.deepEqual(rows, [
    { cls: '', line: null },        // --- a/f.txt
    { cls: '', line: null },        // +++ b/f.txt
    { cls: '', line: null },        // @@ -1,3 +1,3 @@
    { cls: '', line: 1 },           // ' one'
    { cls: '', line: 2 },           // ' two'
    { cls: 'diff-del', line: 3 },   // '-three'   -> OLD file line 3
    { cls: '', line: null },        // '\ No newline...' -- a line of neither file
    { cls: 'diff-add', line: 3 },   // '+three!'  -> NEW file line 3, not 4
    { cls: '', line: null },        // '\ No newline...'
  ]);
});

check('flattenTokens consults a token\'s ALIAS as well as its type, which is the only thing that makes lang: \'markdown\' highlight at all', () => {
  // Prism attaches a token's colour-bearing name to `alias` for whole grammars at a
  // time -- a string for one name, an array for several. markdown is the extreme
  // case: not one of its own top-level type names (title, bold, italic, list, url,
  // code-snippet, blockquote) is in TOKEN_CLASS, while `title` carries
  // `alias: 'important'` and `code-snippet` carries `alias: ['code', 'keyword']`,
  // both of which ARE.
  const board = createBoard({
    title: 'markdown highlighting',
    blocks: [{ kind: 'code', lang: 'markdown', text: '# Title\n\nSome **bold** text and `a snippet`.\n' }],
  });
  const section = /<section class="block code-block"[\s\S]*?<\/section>/.exec(renderedMarkup(renderBoardPage(board)))[0];
  assert.ok(section.includes('class="tok-keyword"'),
    `a markdown heading's 'title' token reaches tok-keyword only through its alias: ${section}`);
  // The ARRAY form specifically, on its own and not behind an `||`: a string-only
  // implementation passes the assertion above (title's alias is a bare string) and
  // still misses this one, which is `code-snippet`'s ['code', 'keyword'] -- 'code'
  // is not in TOKEN_CLASS, so only walking past it to 'keyword' produces this span.
  assert.match(section, /<span class="tok-keyword">`a snippet`<\/span>/,
    'the array-valued alias form (code-snippet -> [code, keyword]) must be consulted too, not just the string form');
  // And the promise the alias lookup must NOT break: a diff row still carries no
  // six-hue class. The diff grammar's aliases are deleted/inserted/unchanged/diff/
  // bold -- none in TOKEN_CLASS -- so ADR 64 holds by construction, alias lookup and
  // all. Asserted, not assumed, because widening the lookup is exactly the change
  // that could have quietly broken it.
  const diffBoard = createBoard({
    title: 'alias vs diff',
    blocks: [{ kind: 'code', lang: 'diff', text: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n' }],
  });
  const diffSection = /<section class="block code-block"[\s\S]*?<\/section>/.exec(renderedMarkup(renderBoardPage(diffBoard)))[0];
  assert.ok(!diffSection.includes('class="tok-'), 'consulting aliases must not let a diff token pick up a six-hue class');
});

check('a code block numbers its gutter from a start line the block carries, not from 1 -- the render half of "a section-sliced block is numbered where the section actually starts"', () => {
  // `hasExplicitRange` was `Array.isArray(source.lines)`, so a block resolved by
  // `section` (which has source.section and NO source.lines) took the "starts at
  // line 1" branch reserved for whole-file and by-value blocks: a block whose kicker
  // reads notes.md#install numbered its first row 1 when the section starts at line
  // 6, and a reviewer citing a line number was five off.
  //
  // Both halves are wired now: src/resolve.mjs reports `startLine` on every
  // successful resolution, src/board.mjs carries it onto the normalised block, and
  // renderBlock numbers from it. `block.startLine` is deliberately a normalised BLOCK
  // field rather than something read back out of `block.source` -- src/board.mjs
  // builds a code block from an explicit field list, so a caller cannot forge it the
  // way it can forge `source.lines` (see the gutter-injection check above).
  writeFileSync(path.join(fixturesDir, 'section-gutter.md'), '# Intro\n\nalpha\n\n# Install\n\nrun it\n', 'utf8');
  const board = createBoard({
    title: 'section gutter',
    cwd: fixturesDir,
    blocks: [{ kind: 'code', source: { path: 'section-gutter.md', section: 'install' } }],
  });
  assert.equal(board.blocks[0].startLine, 5,
    'the whole point: a section-sliced block knows where its section starts in the file');
  const sliced = renderBlock(board.blocks[0], board, new Map(), false);
  assert.deepEqual([...sliced.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1])), [5, 6, 7],
    '"# Install" is line 5 of the fixture, so the section\'s first row is gutter 5');

  // A by-value block carries no start line and still numbers from 1, exactly as before.
  const byValue = renderBlock({ ...board.blocks[0], startLine: undefined }, board, new Map(), false);
  assert.deepEqual([...byValue.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3],
    'with no start line to consume, a block still numbers from 1 exactly as before');

  // Same trust boundary as source.lines[0]: a start line that is not an integer is
  // not a start line, and never reaches the attribute.
  for (const bad of ['5"><img src=x>', 5.5, null, NaN, '5']) {
    const html = renderBlock({ ...board.blocks[0], startLine: bad }, board, new Map(), false);
    assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map(m => Number(m[1])), [1, 2, 3],
      `a non-integer startLine (${JSON.stringify(bad)}) must fall back to 1, not be interpolated`);
    assert.ok(!html.includes('<img'), 'and must never reach the attribute as markup');
  }
});

check('a gutter row is an INLINE box: the rows are joined by the text\'s own real newlines, so a block-level row would render and copy every one of them as a second, blank line', () => {
  // Found in a real Chrome against the committed examples/sample-board.html:
  // `.code-row { display: block }` plus the literal '\n' separators src/render.mjs
  // joins rows with means each of those newlines, under `white-space: pre`, forms an
  // anonymous block between two block-level rows and renders as a blank line.
  // Measured there: row box height 19.38px against a row-top-to-row-top delta of
  // 41.77px, and window.getSelection().toString() over a five-line javascript block
  // giving 8 newlines against the 4 in its text. Every gutter-numbered block rendered
  // AND copied double-spaced, which makes AC 8 false in a browser.
  //
  // The suite has no browser, so what is asserted here is the INVARIANT the fix
  // establishes, at the two places that jointly decide the outcome: the renderer
  // separates rows with a real newline (which is what keeps textContent honest), and
  // the stylesheet therefore must not make a row a block-level box (which is what
  // would turn each of those newlines into a second line break). The browser-level
  // rendering and copy behaviour behind this was verified by hand.
  const board = createBoard({
    title: 'row boxes',
    blocks: [
      { kind: 'code', lang: 'javascript', text: 'const a = 1;\nconst b = 2;\nconst c = 3;' },
      { kind: 'code', lang: 'diff', text: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n' },
      { kind: 'markdown', text: '```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```\n' },
    ],
  });
  const page = renderBoardPage(board);
  const markup = renderedMarkup(page);
  assert.match(markup, /<\/span>\n<span class="code-row/,
    'setup: rows are separated by a literal newline -- that is what AC 8\'s copy fidelity rests on, and what makes the row\'s own display value load-bearing');

  const document = parseHTML(page);
  const BLOCK_LEVEL = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'flow-root']);
  const rows = [
    document.querySelector('.code-block pre code .code-row'),
    document.querySelector('.code-block pre code.code-diff .code-row'),
    document.querySelector('.md-content pre code .code-row'),
  ];
  const names = ['a highlighted code block', 'a diff code block', 'a diff fence inside markdown'];
  rows.forEach((row, i) => {
    assert.ok(row, `setup failure: no .code-row found for ${names[i]}`);
    const display = resolveComputedProperty(styles, row, true, 'display').trim();
    assert.ok(!BLOCK_LEVEL.has(display),
      `.code-row on ${names[i]} computes 'display: ${display}'. A block-level row beside a literal '\\n' separator double-spaces the block on screen and doubles the newlines in a copy -- either the separators go (breaking textContent fidelity) or the row stays inline. It stays inline.`);
  });

  // The gutter column still has to be reserved without taking the row out of flow --
  // the ::before is the only thing that can do that now, so it must be an in-flow
  // box with a width rather than an absolutely positioned one over a padding-left.
  const gutterRule = /\.code-row::before\s*\{([^}]*)\}/.exec(styles);
  assert.ok(gutterRule, 'the gutter ::before rule must still exist');
  assert.doesNotMatch(gutterRule[1], /position\s*:\s*absolute/,
    'an absolutely positioned gutter needs the row to establish a containing block, which is what position: relative + display: block was for');
  assert.match(gutterRule[1], /display\s*:\s*inline-block/,
    'the gutter cell reserves its column by being an inline-block of fixed width, in flow, inside an inline row');
});

check('the stylesheet is structurally well formed: every comment closes, no stray \'*/\', and no text sits outside a rule or a comment', () => {
  // This exists because a malformed COMMENT silently deletes the RULE AFTER IT, and
  // nothing else in the suite can see that happen. Reproduced, in Chrome, against a
  // committed examples/sample-board.html: a comment block was closed early by a '*/'
  // mid-prose, so ~30 lines of explanatory text became bare CSS. A browser's parser
  // error-recovers by consuming garbage until it resyncs, and the resync point is
  // the NEXT '{' -- so the prose was swallowed as the prelude of the following rule
  // and '.code-row::before' vanished from document.styleSheets entirely. Every rule
  // after it parsed normally, so exactly one rule was lost and nothing else looked
  // wrong: the gutter numbers stopped rendering while the fill, the flat-fence
  // modifier and the six-hue palette all still worked.
  //
  // The reason this needs its OWN check rather than a better assertion on the rule
  // is the trap QUIRKS.md names one level up: test/dom-stand-in.mjs's
  // resolveComputedProperty reads the stylesheet TEXT, so it resolves a rule that a
  // browser never parsed. Any assertion built on it agrees with a careful reading of
  // the source by construction, and a careful reading of the source is exactly what
  // was already wrong. What follows is deliberately not a cascade question at all --
  // it asks only whether the delimiters that decide where rules BEGIN AND END are
  // consistent, which is the one property a text-level checker can answer honestly.
  const scan = { depth: 0, inComment: false, stripped: '' };
  let line = 1;
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] === '\n') line += 1;
    if (!scan.inComment && styles.startsWith('/*', i)) { scan.inComment = true; i += 1; continue; }
    if (scan.inComment) {
      if (styles.startsWith('*/', i)) { scan.inComment = false; i += 1; }
      continue;
    }
    // `line` counts within the emitted stylesheet, NOT within src/styles.mjs -- the
    // whole file is one template literal that starts partway down it, so the two
    // differ by however many lines of real JS precede it. The offending text is
    // quoted for that reason: it is what actually locates the spot.
    assert.ok(!styles.startsWith('*/', i),
      `a '*/' with no open comment, at stylesheet line ${line}: ${JSON.stringify(styles.slice(Math.max(0, i - 60), i + 2))}. Everything from the comment's real end to the next '{' is being parsed as CSS, which makes the following rule's prelude garbage and deletes that rule from the stylesheet a browser builds.`);
    scan.stripped += styles[i];
  }
  assert.equal(scan.inComment, false, 'src/styles.mjs ends inside an unterminated comment -- everything from the last \'/*\' onward is missing from the stylesheet');

  // With comments accounted for, the remaining text must be nothing but rules: a
  // prelude, a balanced block, repeat. A leftover tail is text outside any rule.
  let prelude = '';
  const preludes = [];
  for (const ch of scan.stripped) {
    if (ch === '{') {
      if (scan.depth === 0) { preludes.push(prelude.trim()); prelude = ''; }
      scan.depth += 1;
    } else if (ch === '}') {
      scan.depth -= 1;
      assert.ok(scan.depth >= 0, 'src/styles.mjs closes a brace that was never opened');
      if (scan.depth === 0) prelude = '';
    } else if (scan.depth === 0) {
      prelude += ch;
    }
  }
  assert.equal(scan.depth, 0, 'src/styles.mjs leaves a block unclosed');
  assert.equal(prelude.trim(), '', `src/styles.mjs has text after its last rule, outside any comment: ${JSON.stringify(prelude.trim().slice(0, 200))}`);

  // And each prelude must actually look like a selector list or an at-rule. A
  // swallowed comment shows up here as a prelude hundreds of characters long, which
  // is the shape no real selector in this file has: the longest legitimate one is
  // 157 characters (the four-part mermaid hover selector built from
  // MERMAID_NODE_SELECTOR). 400 is that with headroom to spare -- a deliberately
  // loose bound, since the failure it exists to catch overshot it by 5x.
  // ponytail: a length bound, not a selector grammar. Its ceiling is a swallowed
  // comment SHORTER than 400 characters, which would slip past; the upgrade path if
  // that ever happens is to check the emitted CSS against a real parser rather than
  // to keep tightening the number. The ';' test below is the same guard from the
  // other side -- a semicolon can only reach depth 0 out of a declaration that has
  // escaped its block.
  for (const p of preludes) {
    assert.ok(p.length <= 400,
      `src/styles.mjs has a ${p.length}-character rule prelude, which is prose that escaped a comment rather than a selector: ${JSON.stringify(p.slice(0, 200))}`);
    assert.ok(!p.includes(';'),
      `src/styles.mjs has a ';' outside any rule block, in the prelude ${JSON.stringify(p.slice(0, 200))}`);
  }

  // Finally, the specific rule this was found through -- named, so a regression
  // reads as "the gutter is gone" rather than as an abstract parse complaint.
  assert.ok(preludes.includes('.code-row::before'),
    'the gutter rule must be its own rule, with its own prelude -- not absorbed into the prelude of whatever precedes it');
});

if (asyncFailures) failures += asyncFailures;

rmSync(fixturesDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall pure checks ok');
