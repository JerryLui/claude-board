// Pure diff between two board JSON snapshots -- the seam that proves an SSE push
// is applied additively (new content only) rather than by wholesale re-render. See
// PROTOCOL.md "Board document" for the shape being diffed, and DESIGN.md
// Decisions -> "A board is a session-scoped thread with rounds": the sent round
// collapses into a history rail with its answers still readable, and an amend to
// a round still open does not disturb fields already filled in but not yet sent.
//
// No DOM, no I/O, no closures over anything outside its own parameters -- this
// function runs unmodified in two places: imported directly here for the node
// checks (test/check-pure.mjs), and embedded VERBATIM into the client script via
// `computeBoardPatch.toString()` (see src/ui.mjs). One implementation, two
// runtimes, so the unit-tested behaviour and the browser's copy can never drift
// apart. Written in the plain function/var style src/ui.mjs already uses
// throughout, since this text is spliced directly into that script.
//
// Deliberately conservative about what counts as "changed": a block is only
// reported in `changedBlockIds` when its serialised content actually differs, so a
// push that adds a brand-new round never mentions any block from an existing one,
// and a round that hasn't just transitioned to 'sent' is never listed in
// `roundsNowSent`. Consumers rely on those two negatives to prove they never touch
// DOM they shouldn't.
//
// NESTED BLOCKS COUNT. `board.blocks` is the top level only, but a question's
// `context` blocks and a compare block's two sides are themselves blocks with
// their own ids, and src/render.mjs renders every one of them with its own
// data-block-id, its own widget and its own comment form. Walking only the top
// level made this function's central promise ("a changed block is reported, so
// the client can clear the reviewer's stale field state for it") silently false
// for exactly those: an amend that replaced a compare block reported only the
// compare block's id, so the question nested inside it kept the selection the
// reviewer had made against the OLD prompt, and Send -- which iterates the DOM,
// where the nested question very much exists -- posted that stale choice under
// the new prompt. Every walk below is therefore over the flattened tree.
//
// flattenBlocks and ownContent are declared INSIDE this function on purpose: the
// browser copy is produced by `computeBoardPatch.toString()` (see src/ui.mjs),
// which carries the function's own body and nothing else -- a module-level helper
// would import cleanly for the node checks and be a ReferenceError in the page.
export function computeBoardPatch(prevBoard, nextBoard) {
  /** Every block in display order, nested ones included: a question's `context`
   * blocks and both sides of a compare block are blocks with their own ids and
   * their own rendered widgets/comment forms. */
  function flattenBlocks(blocks, out) {
    (blocks || []).forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      out.push(b);
      if (b.context) flattenBlocks(b.context, out);
      if (b.left && b.left.block) flattenBlocks([b.left.block], out);
      if (b.right && b.right.block) flattenBlocks([b.right.block], out);
      // choose-between-rendered-variants: an option's own `block`
      // is a nested block with its own id, its own rendered widget and its own
      // comment form, exactly like a compare side's -- walked here for the
      // same reason the two lines above are, or an amend that replaced only an
      // option's block would report nothing changed and the reviewer's stale
      // field state against the OLD option content would ride along.
      if (b.options) flattenBlocks(b.options.map(function (o) { return o.block; }).filter(Boolean), out);
    });
    return out;
  }

  /** A block's own content, WITHOUT its nested children: comparing whole subtrees
   * would report a compare/question block as changed merely because something
   * nested inside it changed, and the client would then clear field state for a
   * block that did not actually change. Each nested block is compared on its own
   * account instead, under its own id. The two `label`s are pulled up because
   * they belong to the compare block itself, not to either nested block.
   * `options` (choose-between-rendered-variants) is handled the same way: each
   * option's own `block` is dropped from the comparison (compared separately,
   * under its own id, by the flattened walk above) and replaced with just the
   * nested block's id, so the SET of options / which block each one points at
   * is still compared, without re-comparing either option's entire nested
   * content a second time. */
  function ownContent(block) {
    var copy = {};
    Object.keys(block).forEach(function (k) {
      if (k === 'context' || k === 'left' || k === 'right' || k === 'options') return;
      copy[k] = block[k];
    });
    if (block.left) copy.leftLabel = block.left.label;
    if (block.right) copy.rightLabel = block.right.label;
    if (block.options) {
      copy.options = block.options.map(function (o) {
        return { label: o.label, description: o.description, preview: o.preview, blockId: o.block ? o.block.id : null };
      });
    }
    return copy;
  }

  var prevBlocksById = {};
  flattenBlocks(prevBoard.blocks, []).forEach(function (b) { prevBlocksById[b.id] = b; });

  var addedBlockIds = [];
  var changedBlockIds = [];
  flattenBlocks(nextBoard.blocks, []).forEach(function (b) {
    var prev = prevBlocksById[b.id];
    if (!prev) {
      addedBlockIds.push(b.id);
    } else if (JSON.stringify(ownContent(prev)) !== JSON.stringify(ownContent(b))) {
      changedBlockIds.push(b.id);
    }
  });

  var prevRoundsByN = {};
  (prevBoard.rounds || []).forEach(function (r) { prevRoundsByN[r.n] = r; });

  var roundsNewlyOpen = [];
  var roundsNowSent = [];
  (nextBoard.rounds || []).forEach(function (r) {
    var prev = prevRoundsByN[r.n];
    if (!prev) {
      roundsNewlyOpen.push(r.n);
    } else if (prev.status !== 'sent' && r.status === 'sent') {
      roundsNowSent.push(r.n);
    }
  });

  return {
    addedBlockIds: addedBlockIds,
    changedBlockIds: changedBlockIds,
    roundsNewlyOpen: roundsNewlyOpen,
    roundsNowSent: roundsNowSent,
  };
}
