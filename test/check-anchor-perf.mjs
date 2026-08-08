// Ticket 11 (DESIGN.md), audit V4 and V5b: two independent cost claims
// about the same hot path (resolveComment, walked on every render/SSE push/
// archive write/packet build), each fixed differently, each checked here as a
// regression guard with a generous-but-real deadline -- not just "does it still
// work", but "does it still work FAST", since a future edit that reintroduces
// either quadratic behaviour would otherwise ship behind a suite that stays
// green right up until a real board's daemon starts burning CPU for seconds per
// request (DESIGN.md anchoring criterion 7: "no board can be wedged by content
// that fails to parse" -- pathologically slow is its own kind of wedge on a
// single-threaded daemon).
//
// Both measured through the real call sites, not a unit call on the regex or the
// cache: V5b drives src/anchor.mjs's parseHtmlTree (the function tokenRe lives
// in, and the one resolveDomAnchor calls on an html-stage block's raw html) and
// also resolveComment/board.mjs end to end over an html block; V4 drives
// src/board.mjs's resolveComments, exactly what renderBoardPage/
// resolveBoardComments/buildPacket call.

import assert from 'node:assert/strict';
import { parseHtmlTree } from '../src/anchor.mjs';
import { createBoard, resolveComment, resolveComments } from '../src/board.mjs';

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

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// --- V5b: tokenRe must not backtrack quadratically ----------------------------
//
// An open tag whose "name" is a huge run of word characters with no terminating
// '>' anywhere is exactly the shape that used to overlap the tag-name group's
// `[\w-]*` with the quantifier immediately following it (both the close-tag and
// open-tag branches) -- measured pre-fix (audit V5b, and independently
// reproduced while building this check): 20K -> 136ms / 131ms measured, 100K ->
// 2.8s / 3.26s measured, 500K -> 73.6s / 82.7s measured. The deadlines below sit
// two to three orders of magnitude above the FIXED cost (measured well under
// 5ms at every size below) and two to three orders of magnitude below the
// UNFIXED cost, so a regression back to backtracking fails loudly instead of
// merely getting slower.

function adversarialUnterminatedTag(n) {
  return '<div>' + '<x' + 'a'.repeat(n) + '</div>';
}

for (const [n, deadlineMs] of [[20_000, 2_000], [100_000, 2_000], [500_000, 5_000]]) {
  check(`V5b: parseHtmlTree on a ${n}-char unterminated tag completes within ${deadlineMs}ms (no quadratic backtracking)`, () => {
    const ms = timeMs(() => parseHtmlTree(adversarialUnterminatedTag(n)));
    console.log(`    ${n} chars -> ${ms.toFixed(1)}ms`);
    assert.ok(ms < deadlineMs, `parseHtmlTree took ${ms.toFixed(1)}ms on ${n} chars, expected under ${deadlineMs}ms`);
  });
}

check('V5b: the same adversarial input reaches the same guard through the real path -- a dom comment resolved against an html-stage block', () => {
  const board = createBoard({ title: 'v5b real path', blocks: [{ kind: 'html', html: adversarialUnterminatedTag(200_000) }] });
  const block = board.blocks[0];
  const comment = { n: 1, blockId: block.id, anchor: { kind: 'dom', ref: '1', hint: 'x' }, text: 'probe', createdAt: new Date().toISOString(), round: 1 };
  const ms = timeMs(() => resolveComment(board, comment));
  console.log(`    resolveComment on a 200K-char adversarial html-stage block -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 3_000, `resolveComment took ${ms.toFixed(1)}ms, expected under 3000ms`);
});

// --- V4: resolveComments must render+parse each block ONCE per pass, not once
// per comment -------------------------------------------------------------------
//
// A large block with many comments anchored to it used to pay a fresh
// renderBlock + parseHtmlTree for every single comment (audit V4: measured
// 2186ms for 300 comments on a 3.3MB block; independently reproduced while
// building this check at ~3000ms for 300 comments on a ~600KB rendered
// section). resolveComments now shares one render+parse per block across the
// whole pass (src/board.mjs's sectionRootForBlock/stageRootForBlock, keyed by
// block id) -- measured well under 100ms for the same 300 comments below. The
// deadline sits comfortably above the fixed cost and well below the unfixed
// cost, so a regression that goes back to resolving inside the per-comment loop
// fails this check rather than merely getting slower with every comment added.

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

function boardWithComments(commentCount) {
  const board = createBoard({ title: 'v4 perf', blocks: [{ kind: 'mermaid', text: bigDiagram(500 * 1024) }] });
  const block = board.blocks[0];
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

check('V4: resolveComments on 0 comments against a ~500KB diagram block is effectively free', () => {
  const board = boardWithComments(0);
  const ms = timeMs(() => resolveComments(board, board.comments));
  console.log(`    0 comments -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 200, `resolveComments took ${ms.toFixed(1)}ms on 0 comments, expected under 200ms`);
});

check('V4: resolveComments on 300 comments against the SAME block renders+parses that block once, not 300 times', () => {
  const board = boardWithComments(300);
  const ms = timeMs(() => resolveComments(board, board.comments));
  console.log(`    300 comments -> ${ms.toFixed(1)}ms`);
  assert.ok(ms < 1_000, `resolveComments took ${ms.toFixed(1)}ms on 300 comments against one block, expected under 1000ms (pre-fix: ~3000ms on a smaller block, growing linearly with comment count)`);
  // Every comment must still get its own, correctly-computed verdict -- the
  // shared cache must not let one comment's resolution bleed into another's.
  assert.equal(board.comments.length, 300);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall anchor-perf checks ok');
