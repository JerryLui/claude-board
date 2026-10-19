// Two independent cost claims about the same hot path (resolveComment, walked
// on every render/SSE push/archive write/packet build), each fixed
// differently, each checked here as a regression guard with a
// generous-but-real deadline -- not just "does it still work", but "does it
// still work FAST", since a future edit that reintroduces either quadratic
// behaviour would otherwise ship behind a suite that stays green right up
// until a real board's daemon starts burning CPU for seconds per request:
// no board can be wedged by content that fails to parse, and pathologically
// slow is its own kind of wedge on a single-threaded daemon.
//
// Both measured through the real call sites, not a unit call on the regex or
// the cache: the backtrack guard drives src/anchor.mjs's parseHtmlTree (the
// function tokenRe lives in, and the one resolveDomAnchor calls on an
// html-stage block's raw html) and also resolveComment/board.mjs end to end
// over an html block; the shared-parse guard drives src/board.mjs's
// resolveComments, exactly what renderBoardPage/resolveBoardComments/
// buildPacket call.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { parseHtmlTree, htmlBodyRootFrom, extractHint } from '../src/anchor.mjs';
import { createBoard, resolveComment, resolveComments, buildPacket } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { MAX_HTML_BYTES } from '../src/resolve.mjs';
import { check, finish } from './support.mjs';

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// --- tokenRe must not backtrack quadratically ----------------------------
//
// An open tag whose "name" is a huge run of word characters with no terminating
// '>' anywhere is exactly the shape that used to overlap the tag-name group's
// `[\w-]*` with the quantifier immediately following it (both the close-tag and
// open-tag branches) -- measured pre-fix, and independently
// reproduced while building this check: 20K -> 136ms / 131ms measured, 100K ->
// 2.8s / 3.26s measured, 500K -> 73.6s / 82.7s measured. The deadlines below sit
// two to three orders of magnitude above the FIXED cost (measured well under
// 5ms at every size below) and two to three orders of magnitude below the
// UNFIXED cost, so a regression back to backtracking fails loudly instead of
// merely getting slower.

function adversarialUnterminatedTag(n) {
  return '<div>' + '<x' + 'a'.repeat(n) + '</div>';
}

// No 20K row: unfixed, 20K took 136ms, inside any deadline worth setting, so it could not fail.
for (const [n, deadlineMs] of [[100_000, 2_000], [500_000, 5_000]]) {
  check(`parseHtmlTree on a ${n}-char unterminated tag completes within ${deadlineMs}ms (no quadratic backtracking)`, () => {
    const ms = timeMs(() => parseHtmlTree(adversarialUnterminatedTag(n)));
    console.log(`    ${n} chars -> ${ms.toFixed(1)}ms`);
    assert.ok(ms < deadlineMs, `parseHtmlTree took ${ms.toFixed(1)}ms on ${n} chars, expected under ${deadlineMs}ms`);
  });
}

check('the same adversarial input reaches the same guard through the real path -- a dom comment resolved against an html-stage block', () => {
  const board = createBoard({ title: 'v5b real path', blocks: [{ kind: 'html', html: adversarialUnterminatedTag(200_000) }] });
  const block = board.blocks[0];
  const comment = { n: 1, blockId: block.id, anchor: { kind: 'dom', ref: '1', hint: 'x' }, text: 'probe', createdAt: new Date().toISOString(), round: 1 };
  const ms = timeMs(() => resolveComment(board, comment));
  console.log(`    resolveComment on a 200K-char adversarial html-stage block -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 3_000, `resolveComment took ${ms.toFixed(1)}ms, expected under 3000ms`);
});

// --- resolveComments must render+parse each block ONCE per pass, not once
// per comment -------------------------------------------------------------------
//
// A large block with many comments anchored to it used to pay a fresh
// renderBlock + parseHtmlTree for every single comment (measured
// 2186ms for 300 comments on a 3.3MB block; independently reproduced while
// building this check at ~3000ms for 300 comments on a ~600KB rendered
// section). resolveComments now shares one render+parse per block across the
// whole pass (src/board.mjs's sectionRootForBlock/stageRootForBlock, keyed by
// block id) -- measured well under 100ms for the same 300 comments below. The
// deadline sits comfortably above the fixed cost and well below the unfixed
// cost, so a regression that goes back to resolving inside the per-comment loop
// fails this check rather than merely getting slower with every comment added.
// Re-measured against the diagram fixture below (2026-10-12): 3.7ms with the
// cache, 974ms with resolveComments passing no cache -- which a 1,000ms deadline
// let through, so the deadline is 250ms.

// ADR.md entry 28 leaves `mermaid` commentable, so the big block is a diagram
// rather than a markdown list -- a shape a board can genuinely still accumulate
// comments on. What the cache is measured over (renderBlock + parseHtmlTree, once
// per block per pass rather than once per comment) is the same code either way.
function bigDiagram(targetBytes) {
  const line = 'flowchart LR\n';
  let out = line;
  let i = 0;
  while (Buffer.byteLength(out, 'utf8') < targetBytes) out += `  n${i} --> n${i + 1}\n`, i++;
  return out;
}

// The post carries a small, valid diagram and the ~500KB text is written into the
// STORED block afterwards, because ADR.md entry 117 refuses any diagram past
// mermaid's own 50,000-character limit at the door: no post can carry this block
// any more, while a board stored before that door keeps whatever it drew. The
// door sits on the posting path alone and never runs again on a block already in
// a board, and a stored board is exactly what resolveComments walks -- so what
// the two checks below measure is unchanged, only how the fixture gets its bytes.
// `sha` is rewritten alongside `text` so the stored block stays the self-consistent
// shape normalizeBlock would have minted for it before the limit landed.
function boardWithComments(commentCount) {
  const board = createBoard({ title: 'v4 perf', blocks: [{ kind: 'mermaid', text: 'flowchart LR\n  a --> b\n' }] });
  const block = board.blocks[0];
  block.text = bigDiagram(500 * 1024);
  block.sha = createHash('sha256').update(block.text, 'utf8').digest('hex');
  // Both deadlines below are only meaningful over a block of that size, so the
  // size is asserted rather than assumed: an edit that drops the write-in would
  // otherwise leave two checks passing in microseconds against a two-line diagram.
  assert.ok(Buffer.byteLength(block.text, 'utf8') >= 500 * 1024, 'the stored block must carry the ~500KB diagram the deadlines are set against');
  for (let i = 0; i < commentCount; i++) {
    board.comments.push({
      n: i + 1,
      blockId: block.id,
      anchor: { kind: 'dom', ref: '1.1', hint: `probe ${i}` },
      text: `comment ${i}`,
      createdAt: new Date().toISOString(),
      round: 1,
    });
  }
  return board;
}

check('resolveComments on 300 comments against the SAME block renders+parses that block once, not 300 times', () => {
  const board = boardWithComments(300);
  // Every dom-path probe above comes back lost against a diagram; one comment names a
  // node the diagram declares instead, so a verdict that bled from one comment to the
  // next through the shared cache would show.
  board.comments[150].anchor = { kind: 'mermaid', ref: 'n150', hint: 'probe 150' };
  let resolved;
  const ms = timeMs(() => { resolved = resolveComments(board, board.comments); });
  console.log(`    300 comments -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 250, `resolveComments took ${ms.toFixed(1)}ms on 300 comments against one block, expected under 250ms (uncached: ~1000ms, growing linearly with comment count)`);
  // Every comment still gets its own, correctly-computed verdict -- the shared
  // cache must not let one comment's resolution bleed into another's.
  assert.deepEqual(resolved.map(c => c.n), board.comments.map(c => c.n), 'one verdict per comment, in order');
  for (const i of [0, 149, 150, 151, 299]) {
    assert.deepEqual(resolved[i], resolveComment(board, board.comments[i]),
      `comment ${i + 1}'s cached verdict must equal its uncached one`);
  }
  assert.deepEqual(resolved.filter(c => c.resolved).map(c => c.n), [151], 'only the comment naming a real node resolves');
});

// --- a stage may carry the post limit (ADR 121) ---------------------------------
//
// An html stage may carry up to MAX_HTML_BYTES (25,000,000), where the 512 KiB block
// cap used to bound every pass over it. The rows below hold the four shapes that cap
// was hiding, each measured before its fix on an M-series Mac, then the passes the
// daemon makes over a ~24 MB stage, benign and adversarial, each under a deadline set
// for a 2-core CI box running several checks at once.

// A `<!` declaration and a close tag both run over `<` to their `>`. With no `>`
// anywhere, each one scanned to the end of the input, failed, and the next `<!` or `</`
// scanned to the end again: 11.2 s for 250 K chars of `<!`, 188 s for 1 M. Fixed, 250 K
// takes about 1 ms. (250 K, not more: the unfixed run must fail inside the runner's
// per-check deadline rather than be killed by it.)
for (const [what, unit] of [['`<!` declarations', '<!'], ['close tags', '</a']]) {
  check(`parseHtmlTree on 250 K chars of unterminated ${what} completes within 2,000ms (no rescan to the end from every start)`, () => {
    const html = unit.repeat(Math.floor(250_000 / unit.length));
    const ms = timeMs(() => parseHtmlTree(html));
    console.log(`    250K chars of ${unit} -> ${ms.toFixed(1)}ms`);
    assert.ok(ms < 2_000, `parseHtmlTree took ${ms.toFixed(1)}ms, expected under 2000ms`);
  });
}

// An unmatched close tag used to walk the whole stack looking for its element, so deep
// nesting followed by unmatched closes is O(n^2): 1.4 s for 250 K chars, 14 s for 1 M.
// Fixed, 1 M takes about 20 ms.
check('parseHtmlTree on 1 MB of nesting then unmatched close tags completes within 2,000ms (a close never walks the stack)', () => {
  const html = '<div>'.repeat(100_000) + '</x>'.repeat(125_000);
  const ms = timeMs(() => parseHtmlTree(html));
  console.log(`    100K <div> then 125K </x> -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 2_000, `parseHtmlTree took ${ms.toFixed(1)}ms, expected under 2000ms`);
});

// A stage's tree costs about 400 bytes of heap an element, so 24 MB of `<div>` built
// 4.8 M elements and a 1.8 GB tree for one resolve pass, against the daemon's 4.4 GB
// heap. The tree stops at MAX_STAGE_NODES (src/anchor.mjs), the most a stage under the
// old cap could produce; bounded, the same input holds about 250 MB.
check('the tree of a ~24 MB html stage of nested elements holds under 1 GB of heap', () => {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc');
  const html = '<div>'.repeat(24_000_000 / 5);
  gc();
  const before = process.memoryUsage().heapUsed;
  const root = htmlBodyRootFrom(html);
  gc();
  const grew = process.memoryUsage().heapUsed - before;
  console.log(`    24 MB of <div> -> tree of ${(grew / 1e6).toFixed(0)} MB`);
  assert.ok(root.children.length === 1, 'setup: the stage parsed to one outer element');
  assert.ok(grew < 1e9, `the tree held ${(grew / 1e6).toFixed(0)} MB, expected under 1000 MB`);
});

// The ~24 MB stage shapes. Benign is what the cap was raised for: a video inlined as one
// data URI, and an evidence page of ten full-size screenshots as data: images beside a
// clip. The rest are the adversarial shapes: unterminated quoted attributes, deep
// nesting, one tag with millions of attributes, an unterminated comment and tag, and
// one element holding 24 MB of text, which 50 comments name (the hint check used to
// read an element's whole text once a comment: 240 ms each, 12 s a pass for these 50).
const STAGE_BYTES = 24_000_000;
const fill = (unit, bytes) => unit.repeat(Math.floor(bytes / unit.length));
const STAGES = [
  ['benign: a video as one data URI', `<video controls aria-label="Criterion 2 clip"><source type="video/mp4" src="data:video/mp4;base64,${fill('QUFB', STAGE_BYTES)}"></video>`, '1'],
  ['benign: ten screenshots as data: images and a clip', Array.from({ length: 10 }, (_, i) => `<figure><img alt="Shot ${i}" width="1280" src="data:image/png;base64,${fill('iVBO', STAGE_BYTES / 10 - 300)}"><figcaption>Shot ${i}</figcaption></figure>`).join('') + `<video controls aria-label="Criterion 2 clip" src="data:video/mp4;base64,${fill('QUFB', 2_000)}"></video>`, '1'],
  ['unterminated quoted attributes', fill('<a b="', STAGE_BYTES), '1'],
  ['deep nesting', fill('<div>', STAGE_BYTES), '1'],
  ['one tag, millions of attributes', `<div ${fill('a=1 ', STAGE_BYTES)}>x</div>`, '1'],
  ['an unterminated comment', `<p>x</p><!--${fill('x', STAGE_BYTES)}`, '1'],
  ['an unterminated tag', `<p>x</p><div${fill(' a', STAGE_BYTES)}`, '1'],
  ['one element holding 24 MB of text', `<main><pre>${fill('lorem ipsum dolor sit amet ', STAGE_BYTES)}</pre></main>`, '1.1'],
];

// Measured on jerry-m6 at the fix (2026-10-19), per pass, worst shape (deep nesting):
// parse 150 ms, render 1,320 ms, anchor resolve 300 ms, packet 280 ms. The deadlines
// leave a 2-core CI box running other checks room to be several times slower; each
// regression above costs seconds to hours past them.
const PASS_DEADLINE_MS = { parse: 3_000, render: 10_000, resolve: 3_000, packet: 3_000 };

for (const [what, html, ref] of STAGES) {
  check(`every daemon-thread pass over a ~24 MB html stage stays within its deadline: ${what}`, () => {
    assert.ok(html.length >= STAGE_BYTES * 0.99 && html.length <= MAX_HTML_BYTES, `setup: the stage is ${html.length} bytes`);
    const board = createBoard({ title: 'a stage at the post limit', blocks: [{ kind: 'html', html }], wait: true });
    const block = board.blocks[0];
    const hint = ref === '1.1' ? extractHint('lorem ipsum dolor sit amet '.repeat(4)) : 'x';
    for (let i = 0; i < 50; i++) {
      board.comments.push({ n: i + 1, blockId: block.id, anchor: { kind: 'dom', ref, hint }, text: `comment ${i}`, createdAt: new Date().toISOString(), round: 1 });
    }
    const ms = {
      parse: timeMs(() => htmlBodyRootFrom(html)),
      render: timeMs(() => renderBoardPage(board)),
      resolve: timeMs(() => resolveComments(board, board.comments)),
      packet: timeMs(() => buildPacket(board, 1, 'http://127.0.0.1/b/x')),
    };
    console.log(`    ${Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(', ')}`);
    for (const [pass, deadline] of Object.entries(PASS_DEADLINE_MS)) {
      assert.ok(ms[pass] < deadline, `${pass} took ${ms[pass].toFixed(0)}ms, expected under ${deadline}ms`);
    }
    if (ref === '1.1') {
      assert.equal(resolveComments(board, board.comments).filter(c => c.resolved).length, 50, 'and every comment on the text still resolves');
    }
  });
}

finish('anchor-perf');
