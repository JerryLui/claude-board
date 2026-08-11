
(function () {
  // THE ID RULE FOR THIS WHOLE FILE, stated here once: every id lookup is
  // tag/type-qualified, never a bare getElementById or a bare '#id' selector.
  // Board content is markdown snapshotted from arbitrary files (src/markdown.mjs's
  // threat-model comment), and a heading or top-level list item mints an id of its
  // own through slugify -- '## Board data' becomes a second id="board-data", and a
  // composed id like 'comment-form-q1' is exactly as mintable. Only render.mjs's
  // OWN element ever carries the matching tag (<script>, <form>, <div>, <button>,
  // <nav>, <span>): a heading is always <h1>-<h6> and a list item always <li>, so
  // the qualifier removes the collision, and the tree-order dependence it used to
  // rest on, entirely. test/check-archive-ids.mjs pins both halves -- a real board
  // whose markdown mints every one of these ids as a heading, and a static sweep
  // of all three client scripts that fails the moment a bare lookup comes back.
  //
  // This lookup is the loudest case: a bare id lookup for 'board-data' returned
  // the heading, JSON.parse threw on its text, and the whole client IIFE died
  // before body.readonly was ever applied -- a file:// archive then rendered as if
  // it were a live, writable board.
  var dataEl = document.querySelector('script#board-data[type="application/json"]');
  if (!dataEl) return;
  var board = JSON.parse(dataEl.textContent);
  var boardId = board.id;
  var readonly = (location.protocol === 'file:');
  if (readonly) document.body.classList.add('readonly');

  // Marks the innermost element under the cursor for the page's OWN generic
  // anchor gesture (the delegated document-level listener further down), so the
  // click-to-anchor gesture is visible before it is used. An html stage's
  // element-level hover lives in a SEPARATE
  // document -- its own class, of the same name by convention but declared and
  // applied entirely inside the injected agent script src/render.mjs's
  // 'stageAgentScript' carries, never here; see that file's design comment for
  // why the two are independent (this page's stylesheet deliberately does not
  // reach into the stage's document -- QUIRKS.md "Two stylesheets, one
  // palette").
  var STAGE_HOVER_CLASS = 'cb-anchor-hover';

  var pendingComments = [];
  // A stable per-entry id, never reused, so a queued comment can be
  // addressed for edit/delete even when several on the same block share one
  // anchor (a whole-block comment carries no ref at all -- see
  // removePendingComment's own comment, src/anchor.mjs). Never sent to the
  // server as anything meaningful -- applySubmit (src/board.mjs) only ever
  // reads blockId/anchor/text off a posted comment, so an extra id field is
  // silently ignored there.
  var nextPendingId = 1;
  var selections = {};   // qid -> string (single/text) | string[] (multi/rank)
  var notes = {};
  var deferred = {};     // qid -> bool, the per-question defer affordance
  var touched = {};      // qid -> bool, has this widget actually been interacted with

  // Comment mode: off by default, so every ordinary
  // widget handler below runs exactly as it always has. Declared here, at the very
  // top alongside the other page-lifetime state, because it is read from inside
  // wireRoot's per-widget handlers (guarding single/multi/rank/defer against
  // mutating an answer while the reviewer is mid-anchor-click) as well as from the
  // generic anchor hover/click listeners further down -- both need one shared,
  // page-lifetime flag, never a per-wire-pass local.
  var commentMode = false;

  // Which html-stage <iframe>s have a stage-side agent that confirmed 'ready'
  // (see the design comment above src/render.mjs's 'stageAgentScript'). A stage
  // clears its own in-progress hover locally the moment it hears
  // 'commentMode: false' over postMessage ('stageAgentScript''s own 'mode'
  // handler) -- with 'allow-same-origin' dropped the parent cannot reach
  // 'contentDocument'/'contentWindow.document' to do it from here.
  //
  // A WeakSet, not a plain array: it only ever answers "is this specific,
  // still-referenced frame one I've heard from" ('isWiredStage',
  // 'markStageWired' below), and membership is never enumerated. Every caller
  // that needs to ACT on "every wired stage" derives its candidate list fresh
  // from the live DOM ('qsa('.html-stage', document)') and filters through
  // 'isWiredStage', so a frame an amend has already replaced -- or a placeholder
  // document nothing will ever click again -- is simply absent from that list
  // and costs nothing, with no cleanup pass of its own.
  var wiredStageFrames = typeof WeakSet === 'function' ? new WeakSet() : null;
  function isWiredStage(frame) { return !!wiredStageFrames && wiredStageFrames.has(frame); }
  function markStageWired(frame) { if (wiredStageFrames) wiredStageFrames.add(frame); }

  // A theme switch redraws every mermaid diagram in
  // place -- wireMermaidBlock (below) runs again against whatever fresh <svg>
  // that redraw leaves behind, so the pin layer repositions and (still
  // node-id-anchored) pins survive. Its click listener must NOT be
  // re-attached on that second pass, or a reader cycling the theme control
  // several times ends up with several stacked handlers minting several
  // comments per click -- the exact 'every resize would stack another click
  // handler' hazard refreshPins' own comment already names for html stages,
  // from a different trigger. Same WeakSet shape as wiredStageFrames just
  // above, for the same reason: membership only ever answers 'has this exact
  // <pre> already gotten its listener', never enumerated.
  var mermaidWiredBlocks = typeof WeakSet === 'function' ? new WeakSet() : null;
  function isMermaidBlockWired(preEl) { return !!mermaidWiredBlocks && mermaidWiredBlocks.has(preEl); }
  function markMermaidBlockWired(preEl) { if (mermaidWiredBlocks) mermaidWiredBlocks.add(preEl); }

  // Each pre.mermaid's ORIGINAL diagram source, stashed the first time
  // renderMermaidBlocks (below) runs it: mermaid.run() overwrites the node's
  // own content with the rendered SVG and marks it processed, so a second run
  // against the same node is a no-op unless the source goes back in first --
  // and once the SVG is in, the source is gone from the DOM; it cannot be
  // re-derived from the rendered markup afterwards. A WeakMap, not a data
  // attribute: nothing else in this file re-serialises a block's own content
  // into its markup a second time, and the source can be arbitrarily long.
  var mermaidSourceByBlock = typeof WeakMap === 'function' ? new WeakMap() : null;

  // Pure diff between two board JSON snapshots (added/changed block ids, rounds
  // that just became sent) -- unit-tested directly in test/check-pure.mjs via
  // src/patch.mjs. This is the EXACT same function, spliced in verbatim by
  // Function.prototype.toString() at build time (see src/ui.mjs), not a hand copy,
  // so the tested behaviour and this browser copy can never drift apart.
  var computeBoardPatch = function computeBoardPatch(prevBoard, nextBoard) {
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
};

  // The hint rule, spliced in the same way and for the same
  // reason: the exact function test/check-comment-mode.mjs's hint checks run
  // against IS src/anchor.mjs's composeHint, not a second, hand-written copy of
  // its logic. Gathering the DOM inputs this takes (buildHint, below) stays here, same
  // split as buildSteps being parity-bound while "which element did the click
  // land on" is not.
  var composeHint = function composeHint(text, tagName, insideCompare, compareLabel, blockKind) {
  var ROLE_WORD = { button: 'button', a: 'link', img: 'image', input: 'field', textarea: 'field', select: 'menu' };
  var BLOCK_NOUN = { html: 'stage', mermaid: 'diagram', code: 'reference', question: 'question', compare: 'comparison', markdown: 'block' };
  var tag = String(tagName || '').toLowerCase();
  // `tag`/`blockKind` come from the mock's own markup and the caller's
  // block kind respectively -- both attacker/author-influenced strings. An
  // unguarded `ROLE_WORD[tag]` walks the prototype chain for a tag like
  // 'constructor', returning `Object` (the constructor FUNCTION, not a role
  // word), which `JSON.stringify` then silently drops when the anchor is
  // persisted. `hasOwnProperty` closes that off the same way `decodeEntities`
  // below already guards its own `NAMED_ENTITIES` lookup.
  var role = Object.prototype.hasOwnProperty.call(ROLE_WORD, tag) ? ROLE_WORD[tag] : undefined;
  var context = insideCompare
    ? (String(compareLabel || '') + ' ' + (Object.prototype.hasOwnProperty.call(BLOCK_NOUN, blockKind) ? BLOCK_NOUN[blockKind] : 'block')).replace(/\s+/g, ' ').trim()
    : '';
  // The role word ("... button") is appended ONLY alongside real context --
  // without something to disambiguate against, an element's own text is already
  // unambiguous on its own block, and suppressing the role word there is what
  // keeps the plain html-stage hint ('Send', not 'Send button')
  // unchanged outside a compare.
  var identity = text ? (context && role ? text + ' ' + role : text) : (role || tag);
  // Coerced to a string so this function can never return anything else --
  // every input above is now guarded, but the return stays defensive
  // rather than relying on that staying true forever.
  return String(context ? identity + ' in ' + context : identity);
};

  // The two pure functions called out
  // for extraction, spliced in the same way and for the same reason as
  // composeHint just above -- src/anchor.mjs is the module test/check-pure.mjs
  // imports and checks directly, and this is the exact same code, not a
  // second hand-written copy that could silently drift. See that module's own
  // comment for the full design (why 'id', not 'blockId'+'anchor', identifies
  // a queued comment for removal; why a sent comment can never match).
  var findPendingCommentForAnchor = function findPendingCommentForAnchor(pendingComments, blockId, anchor) {
  function sameTarget(a, b) {
    if (!a || !b) return false;
    return a.kind === b.kind && (a.ref || '') === (b.ref || '');
  }
  var list = pendingComments || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c && c.blockId === blockId && sameTarget(c.anchor, anchor)) return c;
  }
  return undefined;
};
  var removePendingComment = function removePendingComment(pendingComments, id) {
  var list = pendingComments || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) continue;
    out.push(list[i]);
  }
  return out;
};

  // Two pure round facts from src/badge.mjs, spliced the same way: the
  // pager names a round with the SAME function src/render.mjs printed that
  // round's own label with, and it asks whether the page it is flipping to is a
  // full-viewport artifact with the SAME function that decided how the server
  // rendered it. Both are the "one implementation, embedded not copied" rule --
  // a hand-written twin here would be free to disagree with the markup on
  // screen, and nothing would catch it.
  var roundNumberLabel = function roundNumberLabel(n) {
  return 'Round ' + n;
};
  var roundPageLabel = function roundPageLabel(n, title) {
  return title ? roundNumberLabel(n) + ' · ' + title : roundNumberLabel(n);
};
  var isPageRound = function isPageRound(blocks) {
  return blocks.length === 1 && blocks[0].kind === 'html' && !blocks[0].error;
};

  // Same technique a third time: whether a round is *awaited* (CONTEXT.md
  // "Awaited") is what markPendingRound below gates the tab mark on, and what
  // the banner's own click target (oldestAwaitedRoundNumber) reads to find the
  // oldest one still waiting -- the exact same
  // predicate src/indexpage.mjs's badge count and src/server.mjs's
  // drainUndeliveredComments read, spliced in rather than hand-copied so a legacy
  // round (minted before ADR.md entry 45, carrying neither an awaited flag nor an
  // awaitDeadline at all) falls back to the identical shape-based inference on
  // every side instead of three that could quietly disagree. questionBlocks is
  // roundIsAwaited's own dependency (its legacy fallback), spliced for the same
  // reason, not because anything else here calls it directly.
  var questionBlocks = function questionBlocks(board) {
  const out = [];
  const visit = b => {
    if (!b) return;
    if (b.kind === 'question') {
      out.push(b);
      (b.context || []).forEach(visit);
      // choose-between-rendered-variants: an option's own block can
      // itself be a nested question (the same generality context/compare
      // already allow), so its answer has to reach applySubmit's answerable
      // set and buildPacket the same way a context/compare-nested question's
      // does.
      (b.options || []).forEach(o => visit(o.block));
    }
    if (b.kind === 'compare') {
      visit(b.left?.block);
      visit(b.right?.block);
    }
  };
  for (const b of board.blocks) visit(b);
  return out;
};
  var roundIsAwaited = function roundIsAwaited(board, r) {
  if (!r) return false;
  if (typeof r.awaited === 'boolean') return r.awaited;
  return questionBlocks(board).some(q => q.round === r.n);
};

  // The waiting signal, spliced the same way and in
  // dependency order (each one calls only a name already assigned above it --
  // 'var' hoisting makes the DECLARATION order irrelevant, but the ASSIGNMENT
  // still has to run top to bottom before any of these is ever CALLED, which it
  // does, since every line here runs synchronously at IIFE start). Real
  // functions, not a hand-written twin: badge.mjs's own header comment is what
  // explains why only THIS file may ever call roundIsCurrentlyAwaited/
  // roundCountdownText/pageBoardPillMeta with a real clock -- src/render.mjs
  // never does, so a rendered page stays a pure function of its board JSON.
  var ROUND_COUNTDOWN_TITLE = "Time left before this round's wait ends";
  var PILL_READONLY_TITLE = "No agent is listening on this page -- commenting is off.";
  var ROUND_OPEN_UNAWAITED_TITLE = "No agent is waiting live right now -- comments and answers here are saved and reach the next agent that asks.";
  var PILL_SUBMITTED_TITLE = "This round was submitted -- the answer already went out.";
  var PAGE_SEND_EXPIRED_LABEL = "Goes out with the next round";
  var PAGE_SEND_EXPIRED_TITLE = "This round ended. Comments left here are stored and reach the next agent that asks.";
  var roundIsAwaitedOpen = function roundIsAwaitedOpen(round) {
  return !!round && round.status === 'open' && round.awaited === true;
};
  var roundIsCurrentlyAwaited = function roundIsCurrentlyAwaited(round, nowMs) {
  return roundIsAwaitedOpen(round) && !!round.awaitDeadline && Date.parse(round.awaitDeadline) > nowMs;
};
  var roundCountdownText = function roundCountdownText(round, nowMs) {
  if (!roundIsCurrentlyAwaited(round, nowMs)) return null;
  const minutes = Math.ceil((Date.parse(round.awaitDeadline) - nowMs) / 60000);
  return minutes + 'm left';
};
  var pageBoardPillMeta = function pageBoardPillMeta(round, nowMs, fullpage = true) {
  const countdown = roundCountdownText(round, nowMs);
  if (countdown) return { text: countdown, title: ROUND_COUNTDOWN_TITLE };
  if (!fullpage && round && round.status === 'sent') return { text: 'submitted', title: PILL_SUBMITTED_TITLE };
  const title = (!fullpage && round && round.status === 'open') ? ROUND_OPEN_UNAWAITED_TITLE : PILL_READONLY_TITLE;
  return { text: 'read-only', title };
};

  function seedAnswers(blockIds, boardData) {
    blockIds.forEach(function (id) {
      var a = (boardData.answers || {})[id];
      if (!a) return;
      if (a.choice != null) { selections[id] = a.choice; touched[id] = true; }
      if (a.note) notes[id] = a.note;
      if (a.status === 'deferred') deferred[id] = true;
    });
  }

  seedAnswers(Object.keys(board.answers || {}), board);

  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Read-only mode is enforced at the element level, not just by guarding the
  // mutation handlers below: pointer-events:none (src/styles.mjs) stops clicks, but
  // a real <textarea>/<button> still accepts keyboard input and native HTML5 drag
  // unless actually disabled. Belt and suspenders — every input-capable element is
  // hard-disabled here, on top of every handler's own readonly guard.
  //
  // One deliberate exception: the diagram's expand
  // control. 'The lens is view-only under body.readonly. Pan and zoom work in a
  // standalone archive (pure JS, no network, consistent with the archive's
  // guarantee); the comment gesture inside it is gated exactly like every other
  // comment gesture' -- so the control that OPENS it has to stay live, while the
  // gesture INSIDE it stays gated by the same 'readonly || !commentMode' guard
  // every other anchor-minting handler carries. Skipped by class here rather
  // than re-enabled afterwards, so there is never a frame in which it is
  // disabled. (The round badge is the counter-example this is written
  // against: it became a <button>, this loop disabled it, and nobody noticed
  // until review.)
  if (readonly) {
    qsa('textarea, input, button').forEach(function (el) {
      if (el.classList && el.classList.contains('expand-btn')) return;
      el.disabled = true;
    });
    qsa('.rank-list li[draggable]').forEach(function (li) { li.removeAttribute('draggable'); });
    // (src/theme.mjs): the theme control is the one exception -- an
    // archive reader is exactly who needs it. Re-enabled right after the
    // blanket disable above rather than excluded from that selector, so the
    // selector's own literal text stays intact (test/check-pure.mjs asserts
    // it verbatim) and this reads as the carve-out it is.
    var themeToggleBtn = document.querySelector('button#theme-toggle');
    if (themeToggleBtn) themeToggleBtn.disabled = false;
    // Back-to-top is the second exception, for the same reason and by the same
    // carve-out (ADR.md entry 40): an archived page board is still a page a
    // reader scrolls, and a control that appears the moment they do and then
    // does nothing is worse than none. Unlike the theme control this one needs
    // no matching CSS carve-out -- no body.readonly rule ever hid it (QUIRKS.md
    // "Readonly is locked twice": check BOTH gates, and here only one exists).
    var backToTopEl = document.querySelector('button#back-to-top');
    if (backToTopEl) backToTopEl.disabled = false;
  }

  // Opens (and fills in) blockId's comment-form for a given anchor. Shared by the
  // .comment-btn handler and the html-stage / mermaid element-click handlers
  // (below), so exactly one place decides what "commenting on:" reads. Declared
  // above wireRoot alongside the other anchor helpers: it only ever reads/writes
  // form state already in the document, so (unlike everything wireRoot itself
  // does) it never needs re-scoping per wire pass.
  //
  // anchorDomRef is the generic page-scoped step-path a diagram-node click ALSO
  // mints, alongside its node-id anchorRef -- see src/anchor.mjs's "design"
  // comment for why a mermaid anchor carries both. Non-empty only for anchorKind
  // 'mermaid'; every other caller omits it, harmless since the submit handler
  // below only reads it for that one kind.
  //
  // editing is the existing pendingComments entry this same anchor already
  // matched (findPendingCommentForAnchor), found by the caller and never
  // re-derived here. When present the form is stamped with that entry's own id
  // and prefilled with its text, so THIS form's submit handler replaces the entry
  // rather than queuing a duplicate. Every caller with no such entry omits it,
  // which is what clears a stale edit-target left over from the last anchor this
  // same per-block form happened to be opened for.
  //
  // The lookups here follow this file's tag-qualified id rule (stated once, at
  // the board-data lookup above). Two of them are worth naming: 'comment-list-'
  // is a <div>, not a <ul>, checked against src/render.mjs rather than assumed;
  // and the qualifier survives the diagram lens, since lensAdopt MOVES the real
  // div#comment-target-/form#comment-form- into a <dialog> appended to
  // document.body -- both stay in THIS document, so a document-rooted qualified
  // selector still finds exactly one of each while the lens is open (what it
  // leaves behind is a <span class="lens-slot">, which carries no id at all).
  function openCommentForm(blockId, anchorKind, anchorRef, anchorHint, anchorDomRef, editing) {
    var form = document.querySelector('form#comment-form-' + blockId);
    if (!form) return;
    form.setAttribute('data-anchor-kind', anchorKind);
    form.setAttribute('data-anchor-ref', anchorRef || '');
    form.setAttribute('data-anchor-label', anchorHint || '');
    form.setAttribute('data-anchor-domref', anchorDomRef || '');
    if (editing) form.setAttribute('data-editing-id', String(editing.id));
    else form.removeAttribute('data-editing-id');
    var target = document.querySelector('div#comment-target-' + blockId);
    if (target) {
      target.textContent = anchorKind === 'block' ? 'commenting on: whole block' : 'commenting on: ' + (anchorHint || anchorRef);
      target.classList.add('open');
    }
    form.classList.add('open');
    var input = form.querySelector('input[type=text]');
    if (input) {
      // A DRAFT IN PROGRESS IS NEVER SILENTLY THROWN AWAY. Comment mode makes
      // EVERY click on EVERY block element open this form, so an unconditional
      // write here would let one stray click halfway through writing a remark
      // wipe what had been typed, with no undo and nothing to say it happened.
      // The field is therefore only ever written when there is something to
      // write:
      //   - an 'editing' target -- reopening a queued comment shows that
      //     comment's own text; the reviewer clicked an element they know
      //     already carries one.
      //   - an empty (or whitespace-only) field, where there is nothing to lose.
      // A non-empty draft otherwise travels to the newly-clicked anchor
      // untouched. Deliberate rather than a compromise: the 'commenting on:'
      // label directly above the field is rewritten in the same call and names
      // the new target, so the reviewer can see where the text will land --
      // visible reattachment, and reversible (the delete control), rather than
      // invisible destruction.
      if (editing) input.value = editing.text;
      else if (!String(input.value || '').trim()) input.value = '';
      input.focus();
    }
  }

  // Every SENT comment whose anchor STILL RESOLVES against the board as it
  // stands right now. src/board.mjs's resolveComment has already made that
  // call server-side and stamped its verdict on every embedded comment; this
  // is where that verdict is honoured rather than ignored.
  //
  // The distinction is load-bearing, not bookkeeping: an
  // amend that replaces a block leaves the comments anchored into its old
  // content 'resolved: false' with a 'lost' label -- their refs name nothing
  // on the page any more. A LIVE element that happens to sit at the same
  // index path in the NEW content is an unrelated element, and treating it as
  // sent would de-affordance it permanently, with no comment on it and no way
  // for the reviewer to find out why clicking it does nothing.
  // src/render.mjs's stageAgentScript delegates exactly this judgement to
  // here, in its own words: the parent is "the side that actually holds
  // board.comments and can tell a resolved sent comment from a stale ref this
  // document has no way to distinguish on its own".
  //
  // 'resolved !== false' rather than plain truthiness: every path through
  // resolveComment sets the field, but a board.comments entry embedded by an
  // older server build carries no such field at all, and must keep counting
  // as sent rather than silently becoming invisible here.
  function liveSentComments() {
    return (board.comments || []).filter(function (c) { return c && c.resolved !== false; });
  }

  // Does blockId+anchor already carry a
  // SENT comment -- board.comments, never pendingComments. Reuses
  // findPendingCommentForAnchor's own kind+ref match rule against a different
  // array rather than a second copy of it (see that function's own comment,
  // src/anchor.mjs): its name says what it's FOR, not that its match rule is
  // exclusive to the pending queue. Every one of the anchor-minting
  // click/hover handlers below calls this before treating an element as a
  // comment target at all -- a sent comment's element is not prefilled, not
  // editable, and not even hoverable as a target: it is simply no longer one.
  // Kind-agnostic on purpose: it matches on whatever kind+ref it is handed, so
  // the generic 'dom' click, the diagram node and the stage all ask it the same
  // question about their own anchor shape.
  function isSentAnchor(blockId, anchor) {
    return !!findPendingCommentForAnchor(liveSentComments(), blockId, anchor);
  }

  // (html-stage half): the dom refs
  // already carrying a SENT comment on blockId, in the ref-only shape the
  // stage's own postMessage 'mode' message carries (below) -- the parent is
  // what holds board.comments, and the stage's isolation (no
  // allow-same-origin, so contentDocument is unreachable) means it has no way
  // to learn this on its own. Only 'dom'-kind anchors: an html-stage's own
  // ref shape is always 'dom' (see handleStageClick), so a 'block' comment on
  // the same block is simply not this stage's concern.
  //
  // Sourced from liveSentComments(), not board.comments raw: a ref whose
  // comment no longer resolves is a STALE index path, and shipping it to the
  // stage de-affordances whatever unrelated element now happens to sit at that
  // path -- see liveSentComments' own comment, and src/render.mjs's
  // stageAgentScript, which names this side as the one that has to make that
  // call.
  function sentDomRefsForBlock(blockId) {
    return liveSentComments()
      .filter(function (c) { return c.blockId === blockId && c.anchor && c.anchor.kind === 'dom'; })
      .map(function (c) { return c.anchor.ref; });
  }

  // --- element-level anchoring -------------------------------------------------
  //
  // Click an element inside an html stage, or a node inside a rendered mermaid
  // diagram, to anchor a comment to it. The path/hint/node-id logic below mirrors
  // src/anchor.mjs exactly (that module is what test/check-pure.mjs exercises
  // without a browser); this copy is a thin DOM adapter over it, duplicated
  // because the served page is a single self-contained file with no import graph
  // at runtime (see the file-level comment above and the standalone-archive
  // guarantee).
  //
  // Declared here, above wireRoot: wireMermaidBlock is called from
  // renderMermaidBlocks (root-scoped, further down) and needs these in scope,
  // and is not itself a "wire this root" loop, so it does not belong nested
  // inside wireRoot's own body. An html/mermaid block can arrive in ANY round,
  // including one pushed over SSE long after hydrate, and it has to be just as
  // clickable as one that was on the page at load: every actual wiring loop below
  // is scoped to root rather than document, which is what keeps a push from
  // re-wiring (and double-registering listeners on) a block that arrived earlier
  // -- exactly how multi-select and Defer once went silently dead.

  // The three functions below are the ones that MINT an anchor at click time
  // (extractHint the hint, buildSteps the raw path, stepsToPath its serialised
  // form); src/anchor.mjs's copies are what RESOLVE that same anchor server-side,
  // at packet-assembly time and every re-render. If the two ever drift apart --
  // different index base, different whitespace handling, a different truncation
  // length -- every anchor this copy mints resolves as lost server-side, silently:
  // no existing check would notice, since each copy was only ever tested against
  // itself. test/check-pure.mjs extracts these three by the start/end markers
  // below (same technique as visualize's check.mjs: split on the markers, eval
  // with new Function) and asserts they agree with src/anchor.mjs across a
  // battery of inputs -- keep the markers in place if this code moves.

  /* anchor-parity:extractHint start */
  function extractHint(text) {
    var collapsed = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    var max = 80;
    if (collapsed.length <= max) return collapsed;
    return collapsed.slice(0, max - 1).replace(/\s+$/, '') + '…';
  }
  /* anchor-parity:extractHint end */

  /* anchor-parity:stepsToPath start */
  function stepsToPath(steps) { return (steps || []).join('.'); }
  /* anchor-parity:stepsToPath end */

  function pathToSteps(path) {
    if (!path) return [];
    return String(path).split('.').map(function (s) { return parseInt(s, 10); })
      .filter(function (n) { return isFinite(n) && n > 0; });
  }

  /* anchor-parity:buildSteps start */
  function buildSteps(root, el) {
    var steps = [];
    var node = el;
    while (node && node !== root) {
      var parent = node.parentElement;
      if (!parent) return null;
      var idx = Array.prototype.indexOf.call(parent.children, node);
      if (idx === -1) return null;
      steps.unshift(idx + 1);
      node = parent;
    }
    if (node !== root) return null;
    return steps;
  }
  /* anchor-parity:buildSteps end */

  function resolveSteps(root, steps) {
    var node = root;
    for (var i = 0; i < steps.length; i++) {
      var kids = node && node.children;
      var child = kids ? kids[steps[i] - 1] : undefined;
      if (!child) return null;
      node = child;
    }
    return node;
  }

  // Spliced in verbatim, same discipline as computeBoardPatch/composeHint above and
  // for a reason this function proved the hard way: it used to be a HAND COPY of
  // src/anchor.mjs's, and the copy was anchored at '^flowchart-'. Real mermaid 11
  // prefixes node ids with the diagram's svg id, so the copy matched nothing and
  // the diagram gesture was dead in every browser while check-pure.mjs happily
  // exercised the module version against ids mermaid never emits.
  var parseMermaidDomId = function parseMermaidDomId(domId) {
  const m = /(?:^|-)flowchart-(.+)-\d+$/.exec(String(domId ?? ''));
  return m ? m[1] : null;
};

  // The selector that must agree with the parser above, from the same source of
  // truth (src/anchor.mjs) -- the click walk-up below, the pin-candidate scan in
  // renderMermaidPins and the hover/cursor rules in src/styles.mjs all use it.
  var MERMAID_NODE_SELECTOR = "[id*=\"-flowchart-\"], [id^=\"flowchart-\"]";

  // --- hint derivation ---------------------------------------------------------
  //
  // Gather the DOM inputs, then hand them to the embedded composeHint (declared
  // near the top of this script) for the actual composition rule. This function
  // is ONLY the DOM-touching half -- finding a
  // compare-side ancestor and its label, finding the containing block's own kind
  // -- closest()/querySelector() have no meaning against the plain-object trees
  // src/anchor.mjs's own tests build, which is why THAT half stays here rather
  // than in the pure module (same split as buildSteps being parity-bound while
  // "which element did the click land on" is not).
  //
  // containerEl is the OUTER-document element that stands in for this content's
  // container -- the block section itself for page-scoped content, or the iframe
  // element for the html-stage case (its contentDocument has no reach back out to
  // the compare-side wrapping it, but the iframe element itself, sitting in the
  // outer document, does). el is the actual clicked element (in whichever document
  // it lives in) -- only its own text/tag is read, never walked upward, so
  // containerEl and el are free to be in different documents.
  function buildHint(containerEl, el) {
    var side = containerEl.closest ? containerEl.closest('.compare-side') : null;
    var insideCompare = !!side;
    var compareLabel = '';
    if (side) {
      var labelEl = side.querySelector('.compare-label');
      compareLabel = labelEl ? String(labelEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }
    var withKind = containerEl.closest ? containerEl.closest('[data-block-kind]') : null;
    var blockKind = withKind ? withKind.getAttribute('data-block-kind') : '';
    return composeHint(extractHint(el.textContent), el.tagName, insideCompare, compareLabel, blockKind);
  }

  // html stage: the iframe carries no 'allow-same-origin' (src/render.mjs), so
  // its browsing context is genuinely cross-origin from this page and
  // 'contentDocument'/'contentWindow.document' are unreachable here.
  // Element-level click-to-comment instead runs over a 'postMessage' protocol
  // with the stage's OWN agent script (injected into every html block's 'srcdoc'
  // by src/render.mjs's 'stageAgentScript'); PROTOCOL.md "Stage postMessage
  // channel" carries the message tables, the origin/identity reasoning on both
  // sides and the shape-validation rule, and this file's listener below is the
  // parent half of that same design. Pins
  // for comments already on the board render regardless of readonly, so an
  // archived board still shows them (the stage answers a 'locate' request the
  // moment it announces itself 'ready', unconditionally); only the
  // click/hover gesture is gated, by never sending 'mode' with 'commentMode:
  // true' at all while 'readonly' (setCommentMode, below).

  // A lost/unpositionable pin still has to go SOMEWHERE visible: stack them with a
  // small offset per layer rather than piling every one on the exact same pixel
  // (each .pin-layer gets its own counter via a WeakMap, so blocks don't
  // interfere). resetStackedOffset is called right beside each innerHTML reset
  // (renderDomPins/renderMermaidPins, below) because the counter has to reflect
  // only the pins in the pass currently being drawn -- one that lived for the
  // page's lifetime would walk a re-rendered layer further from its own top-left
  // on every resize, queued comment and push.
  var stackedPinCount = typeof WeakMap === 'function' ? new WeakMap() : null;
  function resetStackedOffset(layer) {
    if (stackedPinCount) stackedPinCount.delete(layer);
  }
  function nextStackedOffset(layer) {
    if (!stackedPinCount) return 0;
    var n = (stackedPinCount.get(layer) || 0);
    stackedPinCount.set(layer, n + 1);
    return n;
  }

  /** Place one numbered pin for comment c into layer. resolvedStyle (true/false)
   * always comes from the server's resolveComment verdict embedded in
   * board.comments -- never re-derived here -- so the pin and the block's comment
   * list can't disagree about whether the anchor still resolves. position (an
   * explicit {left,top} in layer-relative px, or null) is purely about where to
   * draw it; a failed/unavailable position lookup still renders the pin, just
   * stacked at a fallback offset.
   *
   * c.pending marks a comment that is queued locally but not yet sent (see
   * commentsWithPending below): it gets a pin immediately -- the whole point of
   * batching a dozen comments before one Send is that each one lands visibly as
   * you make it -- drawn hollow so it can never be mistaken for one the server has
   * already numbered. */
  function placePin(layer, c, resolvedStyle, position) {
    var pin = document.createElement('div');
    pin.className = 'anchor-pin' + (resolvedStyle ? '' : ' pin-lost') + (c.pending ? ' pin-pending' : '');
    pin.textContent = String(c.n);
    pin.title = (c.pending ? 'unsent · ' : '') +
      (resolvedStyle ? (c.anchor.hint || c.anchor.ref || '') : ('lost: ' + (c.lost || c.anchor.ref || '')));
    if (position) {
      pin.style.left = position.left + 'px';
      pin.style.top = position.top + 'px';
    } else {
      var offset = nextStackedOffset(layer);
      pin.style.left = (10 + (offset % 6) * 22) + 'px';
      pin.style.top = (10 + Math.floor(offset / 6) * 22) + 'px';
    }
    layer.appendChild(pin);
  }

  /** The next comment number the server would mint, derived from the numbers it
   * has already minted rather than from a local counter, so a provisional pin
   * continues the one visible sequence (PROTOCOL.md Identifiers: "Comments are
   * numbered 1..n across the whole board -- that number is what appears in the
   * pin"). */
  function nextCommentNumber() {
    var max = 0;
    (board.comments || []).forEach(function (c) { if (typeof c.n === 'number' && c.n > max) max = c.n; });
    return max + 1;
  }

  /** Every comment that should currently carry a pin: the server-persisted ones
   * exactly as embedded (resolved/lost verdict included, never re-derived here),
   * followed by the still-unsent queue, each given a provisional number and
   * flagged 'pending'. Reconciliation after Send needs no bookkeeping: the queue
   * is emptied and the pins re-rendered from board.comments alone, so a comment
   * can never be pinned twice -- once provisionally and once for real. */
  function commentsWithPending() {
    var base = nextCommentNumber();
    return (board.comments || []).concat(pendingComments.map(function (c, i) {
      return { blockId: c.blockId, anchor: c.anchor, text: c.text, resolved: true, n: base + i, pending: true };
    }));
  }

  /** The short label shown next to a pending entry's number -- exactly
   * src/render.mjs's anchorTag rule for an anchor that is always resolved (a
   * comment that is merely queued has nothing to have gone lost yet),
   * duplicated here for the same reason buildHint/extractHint are duplicated
   * rather than imported: the served page has no import graph at runtime (see
   * this file's header comment). */
  function pendingAnchorTag(anchor) {
    var kind = anchor && anchor.kind;
    if (kind === 'dom') return anchor.hint || anchor.ref;
    if (kind === 'mermaid') return anchor.hint || anchor.ref;
    return 'block';
  }

  /** Build one queued comment's '.comment-item.comment-pending' list entry,
   * numbered 'n' -- it carries a delete
   * control ('.comment-delete') a SENT comment's server-rendered entry
   * (src/render.mjs's commentArea) never emits, and 'data-pending-id' names
   * exactly which pendingComments entry it is, for the delete listener
   * below. */
  function renderPendingCommentItem(entry, n) {
    var item = document.createElement('div');
    item.className = 'comment-item comment-pending';
    item.setAttribute('data-anchor-kind', entry.anchor.kind);
    if (entry.anchor.ref) item.setAttribute('data-anchor-ref', entry.anchor.ref);
    item.setAttribute('data-block-id', entry.blockId);
    item.setAttribute('data-pending-id', String(entry.id));
    var label = document.createElement('span');
    label.className = 'comment-anchor';
    label.textContent = '#' + n + ' · ' + pendingAnchorTag(entry.anchor);
    item.appendChild(label);
    item.appendChild(document.createTextNode(entry.text));
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'comment-delete';
    del.setAttribute('aria-label', 'Delete this comment');
    del.textContent = '×';
    item.appendChild(del);
    return item;
  }

  /** Re-render every still-queued comment's list entry, EVERYWHERE on the page
   * -- never just the one block a comment was added to or removed from.
   * The renumbering is the reason: a provisional number is never
   * stored on a pendingComments entry, it is 'nextCommentNumber() + index'
   * (commentsWithPending above), one continuous sequence across the WHOLE
   * board (PROTOCOL.md "Identifiers"), so deleting the middle of three queued
   * comments shifts the number of every one that comes after it in
   * pendingComments -- including one queued on a DIFFERENT block. Called
   * after every push, edit and delete; a server-rendered (SENT) '.comment-item'
   * is never touched here. */
  function refreshPendingCommentItems() {
    // '.remove()' rather than 'removeChild': this codebase's own DOM stand-in
    // (test/dom-stand-in.mjs) implements 'replaceWith' (already relied on
    // elsewhere in this file) but not every ChildNode method, and
    // 'replaceWith()' with zero replacement nodes is the standard, real-DOM
    // way to remove an element from its parent -- same technique, no new
    // surface for the stand-in to be missing.
    qsa('.comment-item.comment-pending', document).forEach(function (el) { el.replaceWith(); });
    var base = nextCommentNumber();
    pendingComments.forEach(function (entry, i) {
      var list = document.querySelector('div#comment-list-' + entry.blockId);
      if (list) list.appendChild(renderPendingCommentItem(entry, base + i));
    });
  }

  /** Page-scoped 'dom' pins for one block section. ADR.md entry 28 narrowed what
   * can reach here: a code block's own <pre> used to be full of anchorable lines,
   * so this function carried a whole clipping regime (resize the layer to the
   * pre's box, nudge a pin half its width off the clip edge, re-run on the pre's
   * internal scroll) to keep a pin on a line scrolled out of view from being drawn
   * somewhere else in the section. 'code' is not commentable at all now, and
   * neither is 'markdown', so all of that is gone with them -- the only sections
   * that still carry a direct-child pin-layer are 'mermaid' and a failed 'html'
   * block, neither of which scrolls internally. */
  function renderDomPins(blockId, stageRoot, layer) {
    layer.innerHTML = '';
    resetStackedOffset(layer);
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== blockId || !c.anchor || c.anchor.kind !== 'dom') return;
      var steps = pathToSteps(c.anchor.ref);
      var el = steps.length && stageRoot ? resolveSteps(stageRoot, steps) : null;
      var position = null;
      if (el && el.getBoundingClientRect && stageRoot.getBoundingClientRect) {
        var originBox = stageRoot.getBoundingClientRect();
        var elBox = el.getBoundingClientRect();
        position = { left: elBox.left - originBox.left, top: elBox.top - originBox.top };
      }
      placePin(layer, c, !!c.resolved, position);
    });
  }

  // --- html-stage postMessage protocol -----------------------------
  //
  // The parent's half of the channel PROTOCOL.md "Stage postMessage channel"
  // documents. Three responsibilities: find which live '.html-stage' frame a
  // message actually came from (never trust an id the message itself claims),
  // validate its shape before touching any field, and act on every message type
  // the stage sends -- the listener below (window.addEventListener 'message', at
  // the end of this section) is the exhaustive list; read it there rather than
  // restating a count here.

  var STAGE_CB = 'cb-stage';
  var nextLocateId = 1;
  var pendingLocates = {}; // requestId -> { layer: pin-layer element, comments: [...] }
  // The clip point for a variant option's stage (handleStageHeight, below),
  // tuned against a real mock. Hand-kept in step with src/styles.mjs's
  // '.choice-variant .html-stage' 'max-height' -- neither file can read a value
  // out of the other (QUIRKS.md "Two stylesheets, one palette"). The CSS
  // max-height is a backstop only: THIS clamp is what actually stops a hostile
  // report, since it runs before the value ever touches the frame's inline style.
  var STAGE_HEIGHT_CAP = 600;
  // The floor beside that cap: a stage that sizes itself from the
  // viewport rather than from its own content can report a height that
  // measures whatever sliver of chrome happened to be visible -- a few
  // pixels of label, nothing else -- and without a floor that report would
  // lock the card at exactly that collapsed height forever, since a later,
  // taller report never arrives from content that isn't reflowing. 320
  // matches '.choice-variant .html-stage''s own starting height
  // (src/styles.mjs) -- the same "two independent places, kept in sync by
  // convention" shape as STAGE_HEIGHT_CAP above -- so a collapsed report
  // renders exactly at the placeholder a report that never arrived at all
  // would have left the card at, not below it.
  var STAGE_HEIGHT_FLOOR = 320;
  // How far into the artifact counts as fully "reading it" (ADR.md entry 40) --
  // the offset at which the header has finished condensing and the back-to-top
  // control has finished appearing. A RAMP, not a threshold: the condense is a
  // 0-to-1 progress across this distance (refreshStageChrome, below), so there
  // is no boundary for a reader to rest on and flicker. That flicker is exactly
  // what the old 24px threshold did, and why a wider dead zone was not the fix:
  // a dead zone moves the boundary, it does not remove it.
  //
  // 140px is a bit over one scroll notch, so an accidental nudge barely stains
  // the header while a deliberate read completes it. Shared, unchanged, by
  // refreshDocumentScrollChrome: the same "one
  // notch is a nudge, past it is a read" fact holds for a reader scrolling an
  // ordinary board's own document, not just a page board's stage.
  var STAGE_SCROLL_CONDENSE_PX = 140;

  /** Post one message to 'frame''s stage agent. Wrapped in try/catch: a frame
   * mid-teardown (an amend that replaced this block) can leave 'contentWindow'
   * momentarily null/inaccessible, and a failed post here must never take the
   * rest of the page down with it. ''*'' as the target origin is correct, not
   * lazy: 'frame.contentWindow' is a direct object reference to the exact
   * window this call means to reach (never resolved by name/origin), so there
   * is no ambiguity ''*'' could paper over the way it would for, say,
   * 'window.open'-found windows -- see the receiving side's own origin check
   * (this file's message listener, below) for why replying to an untrusted
   * caller costs nothing sensitive either way (comment-mode state and a
   * geometry request, never a secret). */
  function postToStage(frame, msg) {
    try {
      if (!frame.contentWindow) return;
      var out = { cb: STAGE_CB };
      for (var k in msg) if (Object.prototype.hasOwnProperty.call(msg, k)) out[k] = msg[k];
      frame.contentWindow.postMessage(out, '*');
    } catch (e) { /* frame gone or inaccessible; nothing to tell it */ }
  }

  /** The theme actually in force right now, as a concrete 'light' or 'dark'.
   *
   * src/theme.mjs's control has THREE states and the third one is an ABSENT
   * attribute meaning System, which is not a thing a stage can be told: a
   * sandboxed srcdoc frame could run its own '(prefers-color-scheme)' query,
   * but then it would need its own listener for OS flips AND still have to be
   * told about an explicit override, i.e. two sources of truth for one fact.
   * Resolving here instead leaves exactly one: this page already hears every OS
   * flip (src/theme.mjs's own matchMedia listener fires THEME_CHANGE_EVENT while
   * System is in force) and every click, and both end at the same broadcast
   * below. Works offline and from file:// too -- a media query is local, so an
   * archive opened from Finder with the network off still paints its artifact.
   *
   * The precedence mirrors src/styles.mjs exactly: the plain ':root' block is
   * DARK, and light only ever wins under an explicit override or an OS that
   * asks for it -- hence 'light only if the media says so', never
   * '(prefers-color-scheme: dark)' with a light default. */
  function activeTheme() {
    var attr = document.documentElement && document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    if (!window.matchMedia) return 'dark';
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  /** Is the click-to-anchor gesture even
   * on offer for 'section' (a '.html-block')? 'true' for every stage that is
   * NOT a page board's own -- ADR.md entry 28's rule stays kind-based
   * everywhere else, unchanged by this ticket -- and for a page board's stage
   * only while its own round is genuinely awaited right now (status open,
   * 'awaited === true', and short of its deadline: 'roundIsCurrentlyAwaited',
   * the one function on this whole page that reads the wall clock for this
   * purpose). 'false' covers a page board that was never awaited at all (AC
   * 8), one whose round has since been sent, and one whose wait died while
   * this very tab sat open (AC 12) -- three different histories, one gate,
   * since all three mean the same thing to a reviewer holding the mouse:
   * nobody is listening any more. Read straight off 'board.rounds' rather
   * than off any DOM state, so it can never disagree with what
   * renderPageCommentPanel (src/render.mjs) or refreshAwaitDisplay (below)
   * decided about the very same round. */
  function pageRoundCommentsAllowed(section) {
    var roundSection = section && section.closest('.round');
    var n = roundSection ? parseInt(roundSection.getAttribute('data-round'), 10) : NaN;
    if (!isFinite(n)) return true;
    if (!isPageRound(blocksOfRound(n))) return true;
    return roundIsCurrentlyAwaited(roundEntry(n), Date.now());
  }
  /** Tell every wired stage the CURRENT comment mode, the CURRENT sent-refs for
   * its own block, and the CURRENT theme (the theme rides the
   * message that already carries comment mode rather than minting a type of its
   * own; the stage tolerates each field being absent, the widening convention
   * 'sentRefs' set). One function so a mode change and a theme change can never
   * send differently-shaped messages, and so a stage is never left holding a
   * stale value of the field the other caller happened not to care about.
   *
   * Iterates frames still live in THIS document, filtered through isWiredStage
   * -- a frame that was only ever the about:blank placeholder, or one an amend
   * already replaced, is simply absent from the query and never touched. */
  function broadcastStageMode() {
    qsa('.html-stage', document).forEach(function (frame) {
      if (!isWiredStage(frame)) return;
      var section = frame.closest('.html-block');
      var blockId = section && section.getAttribute('data-block-id');
      postToStage(frame, {
        type: 'mode',
        commentMode: commentMode && pageRoundCommentsAllowed(section),
        sentRefs: blockId ? sentDomRefsForBlock(blockId) : [],
        theme: activeTheme(),
      });
    });
  }

  /** The '.html-stage' frame whose live 'contentWindow' is 'win', or null.
   * Re-derived from the live DOM on every message rather than cached by an id
   * the message could lie about -- this IS the identity check src/render.mjs's
   * design comment describes ("verify the message came from the frame you
   * think it did, not merely from some frame"): 'event.source' is a value only
   * the browser itself can set, so finding a frame whose OWN 'contentWindow'
   * (read fresh, right now) equals it is the actual proof, not an assertion
   * about it. */
  function findStageFrame(win) {
    var frames = qsa('.html-stage', document);
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var w = null;
      try { w = f.contentWindow; } catch (e) { /* cross-origin access never throws for contentWindow itself, but stay defensive */ }
      if (w === win) return f;
    }
    return null;
  }

  /** Ask 'frame''s stage for the current position of every 'dom'-anchored
   * comment on 'blockId' (server-verdict comments plus whatever is still
   * queued -- commentsWithPending, same source page-scoped pins already use).
   * The response ('positions', handled below) draws the pins; this function
   * only ever decides WHICH refs to ask about and remembers what a response
   * should draw once it lands. */
  function requestStagePositions(frame, blockId, layer) {
    var comments = commentsWithPending().filter(function (c) {
      return c.blockId === blockId && c.anchor && c.anchor.kind === 'dom';
    });
    var requestId = 'loc' + (nextLocateId++);
    // The layer's own "latest outstanding request" marker: a 'positions' reply
    // for a SUPERSEDED request (e.g. a resize fired again before the first
    // reply arrived) is ignored rather than clobbering a layer that has since
    // moved on -- see the 'positions' branch below.
    // Free whatever this layer was still waiting on. A reply for a superseded
    // request is discarded below anyway, so keeping its entry buys nothing --
    // and a stage is agent-authored input that can post 'ready' as often as it
    // likes, each one landing here. Dropping the old entry bounds this table at
    // one row per pin-layer instead of one per message the page ever received.
    if (layer.__cbLocateId) delete pendingLocates[layer.__cbLocateId];
    layer.__cbLocateId = requestId;
    pendingLocates[requestId] = { layer: layer, comments: comments };
    postToStage(frame, { type: 'locate', requestId: requestId, refs: comments.map(function (c) { return c.anchor.ref; }) });
  }

  /** A '{left, top}' this page is willing to draw a pin at: both fields
   * present and finite. The stage is attacker-controlled content -- never
   * trust a position object's shape, and never let a non-finite value (NaN,
   * Infinity, a string) reach 'pin.style.left'. */
  function isUsablePosition(pos) {
    return !!pos && typeof pos === 'object'
      && Number.isFinite(pos.left) && Number.isFinite(pos.top);
  }

  function handleStageReady(frame, section, blockId, layer) {
    markStageWired(frame);
    // A stage that arrives after the reviewer already turned comment mode on
    // (a fresh round pushed over SSE, say) needs to be told the CURRENT state,
    // not just future toggles -- setCommentMode only ever broadcasts to frames
    // isWiredStage already recognises at the moment it runs. sentRefs travels
    // in the same message: a stage
    // that has just announced itself needs to know which of ITS OWN elements
    // are already off-limits before its first hover, same as it needs to know
    // whether comment mode is even on.
    // theme travels in the same message for the same reason:
    // a stage that has just announced itself has to be painted in the reader's
    // theme before its first frame is looked at, not at the next toggle.
    //
    // Gated exactly like broadcastStageMode
    // (pageRoundCommentsAllowed, above) -- a stage that announces itself for
    // the FIRST time is otherwise the one path that never went through that
    // function at all, and would hand a non-awaited (or since-expired) page
    // round's stage 'commentMode: true' straight from the global toggle with
    // no gate in the way.
    postToStage(frame, { type: 'mode', commentMode: commentMode && pageRoundCommentsAllowed(section), sentRefs: sentDomRefsForBlock(blockId), theme: activeTheme() });
    // A stage that has just announced itself is
    // exactly the moment its own padding is still whatever its markup alone
    // gave it -- the first (and often only) chance to top it up before the
    // reader ever sees it unpadded. reportStageBand re-derives the CURRENT
    // frame itself, so this is a correct no-op on a frame that isn't it.
    reportStageBand();
    if (layer) requestStagePositions(frame, blockId, layer);
  }

  function handleStageClick(data, section, blockId) {
    if (readonly || !commentMode) return;
    // broadcastStageMode already tells a
    // gated stage 'commentMode: false', which stops the hover/click gesture at
    // its source -- this is the second, independent gate (QUIRKS.md "Readonly
    // is locked twice"), for a click message that beat that broadcast across
    // the postMessage round trip, or one from a stage this tab never told at
    // all (a resync that skipped straight to an already-expired round).
    if (!pageRoundCommentsAllowed(section)) return;
    if (typeof data.ref !== 'string' || !data.ref) return;
    var anchor = { kind: 'dom', ref: data.ref };
    if (isSentAnchor(blockId, anchor)) return;
    // A stage message is ATTACKER-CONTROLLED input, not a user gesture: the
    // sandboxed document runs agent-supplied script in the same document as
    // the agent-supplied markup, so a 'click' with any ref it likes can be
    // posted at any moment, with no reviewer involved at all. Two consequences
    // are handled right here, before anything downstream treats this ref as
    // something the reviewer pointed at:
    //
    // 1. It must never INTERRUPT composition. If this block's form is already
    //    open with text in it, the reviewer is mid-sentence; a forged (or even
    //    an honest, mistimed) message that reopened the form would wipe what
    //    they had typed. Dropped outright instead -- the stage gets no way to
    //    make the parent throw away reviewer input.
    // 2. It must never SELECT AN EDIT TARGET. See the openCommentForm call
    //    below for the whole of that reasoning.
    var openForm = document.querySelector('form#comment-form-' + blockId);
    var openInput = openForm && openForm.querySelector('input[type=text]');
    if (openForm && openForm.classList.contains('open') && openInput && String(openInput.value || '').trim()) return;
    var text = typeof data.text === 'string' ? data.text : '';
    var tag = typeof data.tag === 'string' ? data.tag : '';
    // buildHint(section, {textContent, tagName}): section (the OUTER-document
    // .html-block) is what supplies context ("After stage") if this stage
    // happens to sit inside a compare side -- the plain object stands in for
    // the clicked element (buildHint only ever reads .textContent/.tagName off
    // it, never walks upward from it), since the actual element lives in a
    // document this page can no longer reach; the stage sent its raw
    // text/tag instead, exactly what buildHint would have read directly
    // beforehand. Outside a compare, this is byte-identical to
    // plain extractHint(el.textContent) -- see src/anchor.mjs's design
    // comment.
    var hint = buildHint(section, { textContent: text, tagName: tag });
    // No 'editing' argument, deliberately, and unlike every OTHER caller of
    // openCommentForm on this page. The
    // second-click-edits behaviour is driven by matching a queued comment
    // against the anchor of the thing that was clicked -- and on this one path
    // the anchor is a string the stage chose, not something this document
    // observed. Handing it to findPendingCommentForAnchor would let a stage
    // pick WHICH of the reviewer's queued comments the next submit REPLACES:
    // post a click naming the ref of the queued comment that criticises this
    // block, and the reviewer's next remark silently overwrites it instead of
    // joining it. That is an agent deleting review feedback about its own
    // work, through a channel whose whole design assumption is that nothing it
    // says is trusted.
    //
    // Forging the ANCHOR of a new comment was always possible here and is not
    // what changed: a stage owns its own document and can always lie about
    // which of its elements was clicked. Destroying a comment that already
    // exists is a different thing entirely, and is what this refuses. The cost
    // is that a genuine second click on the same stage element queues a second
    // comment rather than reopening the first -- the previous behaviour, and
    // recoverable (the delete control), which is the direction to
    // fail in. Passing no editing target also CLEARS any stale
    // data-editing-id left on the form by an earlier, trusted gesture, so a
    // stage message can never inherit one either.
    openCommentForm(blockId, 'dom', anchor.ref, hint, '');
  }

  /** 'frame''s stage reporting its own content
   * height, so a variant option's card can grow to fit it instead of sitting
   * at '.html-stage''s fixed 320px floor -- the parent cannot measure this
   * itself (src/render.mjs's design comment on why 'contentDocument' is
   * unreachable), so the stage measures and reports, the same shape as
   * 'hover'/'positions'. Height is STAGE-AUTHORED input like every other field
   * on this channel -- a stage-posted message is agent-authored input, never
   * evidence a human acted: shape-checked ('Number.isFinite', positive -- a non-finite,
   * negative or zero report is dropped outright, same as every other
   * malformed field on this channel) and clamped between STAGE_HEIGHT_FLOOR
   * and STAGE_HEIGHT_CAP before it ever touches 'frame.style.height', so no
   * report can grow a card without limit, push page chrome off screen, or
   * claim more than its own box -- and no report can shrink one below the
   * placeholder either: a stage that sizes itself from the viewport
   * rather than its own content can report a collapsed height (a sliver of
   * label, nothing else) that never grows again, and without the floor that
   * would lock the card there permanently instead of leaving it at the
   * placeholder a late or absent report already leaves it at. 'frame' is
   * already the DOM-walk-identified frame ('findStageFrame(ev.source)' in the
   * listener below), never an id the message claims for itself.
   *
   * Applied only when 'frame' sits inside a '.choice-variant' card. Every
   * html stage sends this message, standalone or not (stageAgentScript has no
   * way to know which kind of card it ended up in -- see its own comment),
   * but a standalone stage keeps its existing floor/resize behaviour
   * untouched (a different chunk's territory); the
   * gate here, not a change to what the stage sends, is what keeps the two
   * apart. */
  function handleStageHeight(data, frame) {
    if (!Number.isFinite(data.height) || data.height <= 0) return;
    if (!frame.closest('.choice-variant')) return;
    frame.style.height = Math.max(STAGE_HEIGHT_FLOOR, Math.min(data.height, STAGE_HEIGHT_CAP)) + 'px';
  }

  function handleStagePositions(data) {
    // hasOwnProperty, not a bare lookup: 'requestId' is a string the stage
    // chooses, and a stage naming 'toString' (or 'constructor') would otherwise
    // walk the prototype chain, sail past the !pending guard below with a
    // function, and throw an uncaught TypeError out of the message listener --
    // the same shape src/anchor.mjs already guards on its own lookups.
    var pending = Object.prototype.hasOwnProperty.call(pendingLocates, data.requestId)
      ? pendingLocates[data.requestId] : null;
    if (!pending) return;
    delete pendingLocates[data.requestId];
    var layer = pending.layer;
    if (layer.__cbLocateId !== data.requestId) return; // superseded by a later request
    layer.innerHTML = '';
    resetStackedOffset(layer);
    pending.comments.forEach(function (c) {
      var raw = Object.prototype.hasOwnProperty.call(data.positions, c.anchor.ref) ? data.positions[c.anchor.ref] : null;
      placePin(layer, c, !!c.resolved, isUsablePosition(raw) ? raw : null);
    });
  }

  /** A page board's stage saying where it has been scrolled to (ADR.md entry
   * 40). The gesture happens inside an opaque-origin frame this document cannot
   * read and no IntersectionObserver here can see -- on a page board the
   * document does not scroll at all -- so this report is the only signal there
   * is, which is why entry 40 makes it a message and this file shape-checks it
   * like every other one (the caller has already established 'top' is a finite
   * number before we get here).
   *
   * All this does is RECORD, against the frame that sent it: the report is a
   * fact about one stage, and which stage it came from is the whole of what
   * makes it actionable or not. Rounds are pages in ONE document, hidden with
   * display:none (src/styles.mjs), so EVERY round's stage is mounted, running
   * and reporting at all times -- a stage on a page nobody has opened (and a
   * stage is agent-authored, assumed hostile by stageAgentScript's own design
   * comment) must not decide the chrome of the page that IS on screen. Storing
   * per frame and deciding from the current page's own record is what makes
   * that structural rather than a guard someone can drop: there is no path from
   * this data to the chrome that does not go through refreshStageChrome's
   * '.round-current' lookup.
   *
   * And the record is not bookkeeping. A frame keeps its inner scroll offset
   * across a display:none flip and fires NO event on the way back (measured in
   * Chrome 152; QUIRKS.md), so a reviewer who flips away from a half-read
   * artifact and returns is back where they left off with nothing to re-report
   * it -- the recorded top is the only thing refreshStageChrome can re-derive
   * from on the return flip. */
  function handleStageScroll(data, frame) {
    frame.__cbStageTop = data.top;
    refreshStageChrome();
  }

  /** Shared by refreshStageChrome and refreshDocumentScrollChrome (below): both
   * derive the identical 0-to-1 figure from a different offset, and this is the
   * one place that turns it into what the stylesheet reads.
   *
   * It is also the present -> absent edge of 'stage-scrolled', which is the only
   * moment reportStageBand can be trusted to re-measure the header from.
   * reportStageBand skips the header's box entirely while 'stage-scrolled' is
   * present (the condense genuinely shrinks it, src/styles.mjs, and reporting
   * THAT would pull the artifact's padding out from under the reader mid-scroll
   * -- ADR.md entry 40's whole reason for an overlay over a header that pushes),
   * and nothing else ever re-enters that measurement on the way back down: a
   * resize taken while scrolled changes the header's REST height with nobody
   * re-checking it, and the class clearing on its own is not an event anything
   * observes. Measured: 76px at rest, resize while still scrolled so the rest
   * height becomes 100px, scroll back to the top -- the stage stayed padded for
   * the stale 76px, 24px of the artifact's own first element under the header,
   * for the rest of the session. 'p<=0' is checked against whether the class WAS
   * set a moment ago, not against its own value, so an ordinary re-render at rest
   * does not re-post on every call. No recursion: reportStageBand only ever reads
   * '.board-head''s current box and posts a message. */
  function applyStageProgress(p) {
    // Three decimals, not the raw float: the value lands in a style attribute
    // that the comment/anchor code reads back, and '0.6100000000000001' is a
    // diff nobody wants to see. Below a thousandth is under a tenth of a pixel
    // of pill travel.
    document.body.style.setProperty('--stage-p', p.toFixed(3));
    var wasScrolled = document.body.classList.contains('stage-scrolled');
    document.body.classList.toggle('stage-scrolled', p > 0);
    if (wasScrolled && p <= 0) reportStageBand();
  }

  /** ADR.md entry 40's chrome, derived from the CURRENT page's own stage rather
   * than remembered as state: called on a report and on every flip, so the one
   * answer is computed the same way whichever of the two moved, and a report
   * from any other page's stage can only ever change a number nothing here reads.
   *
   * Still gated on the page-board layout, and that gate is load-bearing rather
   * than defensive: stageAgentScript is the SAME script in every stage, so an
   * ordinary board's stage reports its own internal scrolling too, and acting on
   * that would condense a header floating over nothing and float a back-to-top
   * control over a page that has its own scrollbar.
   *
   * One number, three consumers -- '--stage-p' on <body> is the 0-to-1 condense
   * progress the stylesheet does all of its arithmetic on, 'stage-scrolled' is
   * that same progress asked "off zero?", and '.visible' flips the back-to-top
   * control's 'display'. All three are derived here from the one offset, so
   * they cannot disagree about how far into the artifact the reviewer is.
   *
   * The two booleans survive the move to a continuous progress only because
   * 'display' has no interpolable midpoint and something has to flip it; every
   * part of the look is on '--stage-p'. They flip at the first pixel rather
   * than at a threshold, and the control is fully transparent there
   * (src/styles.mjs), so nothing appears until the fade actually starts. */
  function refreshStageChrome() {
    // ADR.md entry 40: an ordinary board's own
    // header condenses off this DOCUMENT's scroll instead
    // (refreshDocumentScrollChrome, below). Returning here rather than
    // forcing '--stage-p' to 0 is what keeps the two writers from fighting --
    // stageAgentScript is the SAME script in every stage, so an ordinary
    // board's own embedded artifact still posts scroll reports on this
    // channel, and one arriving after the reader has scrolled the document
    // itself must not stomp the value that scroll set.
    if (!document.body.classList.contains('page-board')) return;
    var frame = document.querySelector('.round-current .html-stage');
    var top = frame && typeof frame.__cbStageTop === 'number' ? frame.__cbStageTop : 0;
    var p = Math.min(1, Math.max(0, top / STAGE_SCROLL_CONDENSE_PX));
    applyStageProgress(p);
    if (backToTopBtn) backToTopBtn.classList.toggle('visible', p > 0);
  }

  /** ADR.md entry 59: the board clears its own chrome band, the artifact
   * does not. This measures the two bands the board's own floating chrome
   * occupies on a page board -- the header at rest, and the round pager dock
   * plus its own clearance -- and hands them to the CURRENT round's stage over
   * the same postMessage channel every other stage fact travels on
   * (stageAgentScript's 'band' handler tops its own padding up to whichever is
   * larger, never adds the two, which is what keeps criterion 2 true without
   * this file or that script ever touching a single artifact).
   *
   * Re-derives the current frame itself rather than trusting a caller's own
   * reference, so a call from handleStageReady (which runs once per frame that
   * announces itself, including a round that is not the current one) can never
   * address the wrong stage.
   *
   * The top band is measured only while the header is genuinely at rest
   * ('stage-scrolled' absent). ADR.md entry 40's own condense changes
   * '.board-head''s rendered height as a side effect of scrolling
   * (padding-block eases with --stage-p), and reporting THAT would shrink the
   * artifact's own clearance mid-scroll -- exactly the reflow entry 40 chose an
   * overlay to prevent. The last band measured at rest is kept in a closure
   * variable and resent on every later call, including ones a mid-scroll
   * resize fires.
   *
   * The bottom band is the dock's own clearance (--space-4 + the dock's real
   * measured height + --space-3, the same arithmetic '.page-comments''s
   * 'bottom' offset already uses, src/styles.mjs) PLUS the comment rail's own
   * height on top of it, when the rail is actually carrying chrome. The dock
   * term alone is only "clear of the dock" -- '.page-comments' floats ABOVE
   * that offset and is 'position: fixed' with a 'max-height' that can run to
   * nearly the full viewport (the rail is named
   * separately from the dock precisely because it is not bounded by the
   * dock's own size), so an artifact's last element sits under the rail
   * whenever the rail holds a form, a comment or the send bar --
   * '.page-comments:has(...)' is the same three-selector test this mirrors in
   * JS, since 'querySelector' is what a stand-in without ':has()' support can
   * still answer. A rail with none of the three contributes nothing: it is
   * either not rendered at all (no page round, ADR.md entry 45) or rendered
   * empty (a page round that is not awaited and has no comments on record),
   * and an empty '.page-comments' reserves no chrome of its own.
   *
   * Re-observed on every call rather than wired once at boot: the rail's own
   * height changes as comments are queued or the compose form opens, with no
   * resize, scroll or round flip in the picture, so its ResizeObserver has to
   * be re-pointed at whichever round's rail is current right now -- the same
   * reasoning 'frame'/'head'/'dock' above are re-derived fresh on every call,
   * not cached from the first one. */
  var lastTopBand = 0;
  var bandRailObserver = null;
  var bandObservedRail = null;
  function railHasChrome(rail) {
    return !!(rail && rail.querySelector
      && rail.querySelector('.comment-form.open, .comment-item, .page-send-bar'));
  }
  function reportStageBand() {
    var pageBoard = document.body.classList.contains('page-board');
    var frame = pageBoard ? document.querySelector('.round-current .html-stage') : null;
    if (!pageBoard || !frame) {
      // A round that WAS current and rail-observed can flip away to an
      // ordinary one (or a page round with no stage at all, structurally
      // impossible today but not a case worth trusting) -- detach here rather
      // than leaving the observer attached to a departed round's rail for the
      // rest of the tab. Harmless in practice (the callback re-gates on
      // page-board/frame and no-ops), but nothing else ever clears it.
      if (bandObservedRail && bandRailObserver) {
        bandRailObserver.unobserve(bandObservedRail);
        bandObservedRail = null;
      }
      return;
    }
    var head = document.querySelector('.board-head');
    if (head && head.getBoundingClientRect && !document.body.classList.contains('stage-scrolled')) {
      lastTopBand = head.getBoundingClientRect().height;
    }
    var bottom = 0;
    var dock = document.querySelector('.round-pager-dock');
    if (dock && dock.getBoundingClientRect) {
      var cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
      var space4 = cs ? parseFloat(cs.getPropertyValue('--space-4')) : NaN;
      var space3 = cs ? parseFloat(cs.getPropertyValue('--space-3')) : NaN;
      bottom = dock.getBoundingClientRect().height
        + (isFinite(space4) ? space4 : 16)
        + (isFinite(space3) ? space3 : 12);
    }
    var rail = document.querySelector('.round-current .page-comments');
    if (rail && rail.getBoundingClientRect && railHasChrome(rail)) {
      bottom += rail.getBoundingClientRect().height;
    }
    if (typeof ResizeObserver === 'function') {
      if (!bandRailObserver) bandRailObserver = new ResizeObserver(reportStageBand);
      if (rail !== bandObservedRail) {
        if (bandObservedRail) bandRailObserver.unobserve(bandObservedRail);
        if (rail) bandRailObserver.observe(rail);
        bandObservedRail = rail;
      }
    }
    postToStage(frame, { type: 'band', top: lastTopBand, bottom: bottom });
  }

  /** ADR.md entry 40: an ordinary board's own
   * sticky header condenses on THIS document's scroll, off the identical
   * '--stage-p' the stylesheet ramps every page-board rule on -- just
   * written from a plain scroll offset instead of a stage's postMessage'd
   * one, since an ordinary board scrolls itself rather than a fixed-height
   * stage frame. Gated dynamically (checked on every scroll, not just once at
   * setup), so a page board that turns into an ordinary one in place (a round
   * arriving, applyRoundPush) picks this up with no extra wiring -- the exact
   * counterpart of refreshStageChrome's own gate above, for the reverse
   * direction. */
  function refreshDocumentScrollChrome() {
    if (document.body.classList.contains('page-board')) return;
    var top = typeof window.pageYOffset === 'number' ? window.pageYOffset
      : (document.documentElement && typeof document.documentElement.scrollTop === 'number'
        ? document.documentElement.scrollTop : 0);
    applyStageProgress(Math.min(1, Math.max(0, top / STAGE_SCROLL_CONDENSE_PX)));
    // Unlike refreshStageChrome, always forced off rather than derived from
    // 'p': back-to-top is a page-board affordance only (there is no fixed
    // 100vh frame here for it to scroll, ADR.md entry 40 -- this ticket
    // condenses the header, not the frame it floats over). Needed for
    // goToRound's own call through refreshCondenseChrome above: without this,
    // flipping FROM a condensed page board TO an ordinary one left the
    // control visible and offering to scroll a stage that is no longer on
    // screen -- refreshStageChrome's own early return (above) is what stops
    // it from being cleared any other way once this document is the one
    // driving the chrome.
    if (backToTopBtn) backToTopBtn.classList.remove('visible');
  }
  window.addEventListener('scroll', refreshDocumentScrollChrome, { passive: true });
  // Explicit initial call, the same reasoning measurePillHalf's own comment
  // below gives: a reader who reloads mid-scroll, or arrives via a '#anchor'
  // link already partway down the page, must not wait for the NEXT scroll
  // event to see a condensed header that already matches where they are.
  refreshDocumentScrollChrome();

  /** The one caller (goToRound, below) that cannot know in advance which of
   * the two condense mechanisms owns the page it is about to land on: a flip
   * can go either way, page board to ordinary or back, and ADR.md entry 40's
   * "the chrome belongs to the page that earned it" has to be true the
   * instant the flip completes, not only after the next scroll or stage
   * report arrives. handleStageScroll and the window 'scroll' listener each
   * already know which mechanism they are (a stage message only ever means
   * one, a document scroll only ever means the other), so they call their own
   * function directly and never need this. */
  function refreshCondenseChrome() {
    if (document.body.classList.contains('page-board')) refreshStageChrome();
    else refreshDocumentScrollChrome();
  }

  /** The pill's own half-width, handed to the stylesheet so its centred band is
   * exactly as wide as the controls that survive the condense. Measured rather
   * than hardcoded because one of those controls resizes at runtime: the
   * read-only slot (ADR.md entry 46) appears, goes, and swaps its own text
   * between a countdown ('38m left') and 'read-only'.
   *
   * Read off the two survivors' own widths, never off the header's -- the
   * header is full-bleed at every progress by design, so its width says
   * nothing about the pill's. Includes the flex gap between them and the
   * pill's inner padding, since the band has to hold all of it.
   *
   * ponytail: a ResizeObserver on the actions row, rather than a re-measure
   * wired into every place a label can change. It costs one observer and
   * cannot be forgotten by the next control someone adds to the header. */
  function measurePillHalf() {
    var head = document.querySelector('header.board-head');
    // '.back-to-index', not a child combinator on '.board-head-title': the
    // test DOM stand-in supports only the selector subset this file uses, and
    // '>' is not in it (test/dom-stand-in.mjs).
    var brand = head && head.querySelector('.back-to-index');
    var actions = head && head.querySelector('.board-head-actions');
    if (!brand || !actions) return;
    // Layout measurement is the one thing the test DOM stand-in cannot fake
    // (it has no getComputedStyle and no box model), and faking it would prove
    // nothing anyway. Skipping leaves the stylesheet's --pill-half default,
    // which is a slightly-off pill rather than a broken one -- so this is the
    // same graceful floor as the ResizeObserver detection at the call site.
    if (typeof getComputedStyle !== 'function') return;
    // The gap is read at whatever progress the header is at, which is correct:
    // it is the same interpolated value the controls are actually sitting on.
    // The inner padding is the TOKEN, not a computed padding -- the header's
    // own padding-inline already carries the centring inset at p>0, so reading
    // it back would fold the answer into its own input.
    var gap = parseFloat(getComputedStyle(head).columnGap) || 0;
    var pad = parseFloat(getComputedStyle(document.body).getPropertyValue('--space-3')) || 0;
    var half = (brand.offsetWidth + gap + actions.offsetWidth) / 2 + pad;
    document.body.style.setProperty('--pill-half', half.toFixed(1) + 'px');
  }

  // Measure once now, and again whenever the controls that make up the pill
  // change size (the read-only slot comes, goes, and relabels). The initial
  // call is explicit rather than left to the observer's
  // own first delivery -- measured in Chrome 152, observing an element that is
  // already laid out and never resized again delivers NOTHING, so an
  // observe-only wiring left --pill-half unset for the whole session and the
  // pill sat at the stylesheet's rough default.
  //
  // Feature-detected, and harmless without: --pill-half has a default in
  // src/styles.mjs, so the floor is a slightly-off pill rather than a broken
  // one.
  (function () {
    var actions = document.querySelector('header.board-head .board-head-actions');
    if (!actions) return;
    measurePillHalf();
    if (typeof ResizeObserver === 'function') new ResizeObserver(measurePillHalf).observe(actions);
  }());

  /** How far an ordinary board's condensed wash
   * (body:not(.page-board) .board-head::after, src/styles.mjs) reaches to go
   * full-bleed without a 'vw' unit -- 'vw' includes the scrollbar's own
   * width, and an ordinary board is exactly the surface that always has a
   * real document scrollbar (a page board's own full-bleed header never had
   * to consider this: body.page-board sets 'overflow: hidden', no scrollbar
   * at all). 'clientWidth' excludes it by definition, the same measured-not-
   * guessed idiom measurePillHalf above and reportStageBand use elsewhere in
   * this file. Feature-detected only by existing (documentElement is always
   * present); harmless without a later resize, since the wash simply keeps
   * whatever width it last had -- a stale-but-still-full-bleed rectangle is
   * a far smaller defect than the seam this exists to fix at all. */
  function measureDocWidth() {
    document.body.style.setProperty('--doc-w', document.documentElement.clientWidth + 'px');
  }
  measureDocWidth();
  window.addEventListener('resize', measureDocWidth);

  var backToTopBtn = document.querySelector('button#back-to-top');
  if (backToTopBtn) {
    backToTopBtn.addEventListener('click', function () {
      // The parent cannot scroll a cross-origin frame's document, so this is a
      // request, not an action: the same 'scroll' type the stage reports with,
      // read the other way round ("put yourself at this offset"). Scoped to the
      // CURRENT page: every round's stage is mounted in this one document at all
      // times (display:none, not removed), so an unscoped broadcast would also
      // reset the reader's position inside artifacts on pages they are not
      // looking at -- and 'a page board has exactly one stage' stopped being a
      // fact about the document the moment rounds became pages (ADR.md entry 42).
      qsa('.round-current .html-stage', document).forEach(function (frame) {
        if (isWiredStage(frame)) postToStage(frame, { type: 'scroll', top: 0 });
      });
    });
  }

  // One listener for every stage on the page, registered once (never inside
  // wireRoot: a stage's 'ready' can arrive at any time after this page loads,
  // regardless of whether it was here at hydrate or arrived over an SSE push
  // long afterward -- there is no "wire this root's stages" step left to run
  // at all, since nothing here reaches into a frame until IT speaks first).
  window.addEventListener('message', function (ev) {
    // Origin, then identity, then shape -- see PROTOCOL.md "Origin validation"
    // for why "null" is the correct and complete check
    // for an opaque-origin srcdoc frame's reported origin, and why re-deriving
    // the sending frame from the live DOM (rather than trusting anything the
    // message claims about itself) is what "the frame we think it is" means.
    if (ev.origin !== 'null') return;
    var data = ev.data;
    if (!data || typeof data !== 'object' || data.cb !== STAGE_CB || typeof data.type !== 'string') return;
    var frame = findStageFrame(ev.source);
    if (!frame) return;
    var section = frame.closest('.html-block');
    if (!section) return;
    var blockId = section.getAttribute('data-block-id');
    var layer = section.querySelector('.pin-layer');

    if (data.type === 'ready') { handleStageReady(frame, section, blockId, layer); return; }
    if (data.type === 'click') { handleStageClick(data, section, blockId); return; }
    if (data.type === 'positions') {
      if (typeof data.requestId !== 'string' || !data.positions || typeof data.positions !== 'object') return;
      handleStagePositions(data);
      return;
    }
    if (data.type === 'hover') {
      // Validated, and otherwise a no-op: the stage already applies its own
      // outline locally (see stageAgentScript's own comment), so there is
      // nothing on THIS side that currently needs to react to a hover in
      // progress. Kept as a real, shape-checked branch anyway -- the protocol
      // is designed to carry it ("so the parent CAN show the hint"), and a
      // malformed 'hover' message is exactly the kind of hostile input this
      // listener has to be provably inert against, same as every other type.
      if (data.ref !== null && typeof data.ref !== 'string') return;
      if (data.text != null && typeof data.text !== 'string') return;
      return;
    }
    if (data.type === 'height') { handleStageHeight(data, frame); return; }
    if (data.type === 'scroll') {
      // Shape-checked before anything reads it, exactly like every other type on
      // this channel: a stage is agent-authored input, and 'top' is a number
      // that decides a class -- a string, NaN or Infinity here would compare
      // false against the threshold and silently pin the header expanded, which
      // reads as a broken feature rather than as rejected input.
      if (typeof data.top !== 'number' || !isFinite(data.top)) return;
      handleStageScroll(data, frame);
      return;
    }
  });

  // mermaid: wired from renderMermaidBlocks below once mermaid has either rendered
  // (svg present) or given up (svg null, CDN unreachable/offline) -- pins render
  // either way, using the server's resolved/lost verdict, so an offline archive
  // review still shows which anchors are lost instead of showing nothing at all.
  // renderMermaidBlocks is itself already root-scoped (so a push only
  // ever (re-)renders the mermaid nodes IT inserted) and is invoked with the
  // pushed subtree in exactly the same places wireRoot is, so wireMermaidBlock
  // needs no additional root-scoping of its own here.

  // section is the OUTER-document '.mermaid-block' section a
  // domRef's steps are rooted at -- the same element buildHint's containerEl
  // argument means for every other page-scoped case. Optional (a caller with no
  // live section, or an anchor with no domRef, just skips straight to the
  // id-attribute scan below): position-finding degrades, resolved/lost styling
  // never does (see src/anchor.mjs's "design" comment).
  //
  // The live element a stored 'mermaid' anchor points at, or null -- factored out
  // of renderMermaidPins (below) so the LENS's own pin layer (renderLensPins)
  // answers the same question through the same
  // precedence instead of a second, drifting copy of it. Every lookup here is
  // scoped to the 'svg'/'section' it is handed and NEVER to 'document': the lens
  // clones the rendered SVG, and a clone carries duplicate element ids, so a
  // document-wide id lookup would be ambiguous between the two copies the moment
  // the lens is open (the spec's own named trap).
  function mermaidHostFor(anchor, svg, section) {
    if (!svg || !anchor) return null;
    // The domRef is resolved against the LIVE rendered SVG (something only the
    // client, not resolveComment's server-side verdict, can ever do -- see
    // src/anchor.mjs's "design" comment), and trusted only if the element it
    // lands on ALSO carries the stored node id in its own generated id: a cheap
    // cross-check against mermaid's internal SVG structure having shifted since
    // mint time, which would otherwise silently position the pin on the wrong
    // node.
    if (anchor.domRef && section) {
      var steps = pathToSteps(anchor.domRef);
      var viaSteps = steps.length ? resolveSteps(section, steps) : null;
      if (viaSteps && viaSteps.getAttribute && parseMermaidDomId(viaSteps.getAttribute('id')) === anchor.ref) {
        return viaSteps;
      }
    }
    // Iterate and compare via parseMermaidDomId rather than interpolating the
    // stored ref into a CSS attribute-selector string: a crafted ref could
    // otherwise break out of the selector.
    var candidates = svg.querySelectorAll(MERMAID_NODE_SELECTOR);
    for (var i = 0; i < candidates.length; i++) {
      if (parseMermaidDomId(candidates[i].getAttribute('id')) === anchor.ref) return candidates[i];
    }
    return null;
  }

  function renderMermaidPins(blockId, svg, layer, section) {
    layer.innerHTML = '';
    resetStackedOffset(layer);
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== blockId || !c.anchor || c.anchor.kind !== 'mermaid') return;
      var host = mermaidHostFor(c.anchor, svg, section);
      var position = null;
      if (host && host.getBoundingClientRect && layer.getBoundingClientRect) {
        var wrapBox = layer.getBoundingClientRect();
        var hostBox = host.getBoundingClientRect();
        position = { left: hostBox.left - wrapBox.left + hostBox.width / 2, top: hostBox.top - wrapBox.top + hostBox.height / 2 };
      }
      placePin(layer, c, !!c.resolved, position);
    });
  }

  // "A mermaid node can be commented on
  // from inside the lens, and that comment is the SAME comment as one minted
  // inline -- same anchor". That is a property of there being exactly ONE minting
  // path, not of two paths happening to agree, so this is it: both the inline
  // gesture (wireMermaidBlock below) and the lens's own click handler
  // (wireLensStage, further down) call this and nothing else.
  //
  // 'section' and 'host' are always the INLINE ones. The lens hands in the
  // counterpart it mirrored out of its clone (mirrorMermaidNode), never a cloned
  // element: a domRef built against the lens canvas would name a step-path that
  // exists nowhere in the block's own server-re-rendered section, so
  // resolveMermaidAnchorAtRoot (src/anchor.mjs) would fall through to the
  // node-id half on every lens-minted comment and renderMermaidPins would
  // position it by the id scan alone -- a silent downgrade, invisible in any
  // check that only asks which ref won.
  //
  // Returns false when the node is not a comment target at all (it
  // already carries a SENT comment), so a caller can tell "did nothing" from
  // "opened a form" without re-deriving that.
  function mintMermaidComment(section, blockId, host, ref) {
    var anchor = { kind: 'mermaid', ref: ref };
    if (isSentAnchor(blockId, anchor)) return false;
    // The SAME generic domRef + hint every other element-level click mints
    // (buildSteps/buildHint, declared above) -- the node id stays the fallback
    // ref, not the model (src/anchor.mjs's "design" comment). A failure to build
    // steps (host somehow not reachable from section) still mints the anchor with
    // an empty domRef rather than aborting: the node id alone is enough to
    // comment.
    var steps = host ? buildSteps(section, host) : null;
    var domRef = (steps && steps.length) ? stepsToPath(steps) : '';
    var hint = host ? buildHint(section, host) : '';
    openCommentForm(blockId, 'mermaid', ref, hint, domRef, findPendingCommentForAnchor(pendingComments, blockId, anchor));
    return true;
  }

  function wireMermaidBlock(preEl, svg) {
    var section = preEl.closest('.mermaid-block');
    if (!section) return;
    var blockId = section.getAttribute('data-block-id');
    var layer = section.querySelector('.pin-layer');
    if (layer) renderMermaidPins(blockId, svg || null, layer, section);
    // Before the readonly/no-svg return below, deliberately: the lens is
    // view-only under body.readonly, not absent, so
    // its expand control has to be wired in an archive too. It removes ITSELF
    // when there is no rendered SVG to show.
    wireDiagramExpand(section, blockId, svg || null);
    if (readonly || !svg) return; // nothing live to click without a rendered diagram
    // Stamp every node that already
    // carries a SENT comment so the comment-mode hover/cursor rules
    // (src/styles.mjs's .cb-anchor-sent) can de-affordance it -- computed once,
    // here, from board.comments. A node's sent status can only change via a
    // real Send, which always replaces this whole section (and re-wires it
    // fresh via renderMermaidBlocks) rather than mutating it in place, so this
    // never goes stale under an unchanged, already-wired section.
    // liveSentComments(), not board.comments raw -- same reasoning as
    // sentDomRefsForBlock's: a node id whose comment no longer resolves is
    // stale, and a redrawn diagram that reuses that id for a different node
    // must not inherit the de-affordance.
    var sentRefs = liveSentComments()
      .filter(function (c) { return c.blockId === blockId && c.anchor && c.anchor.kind === 'mermaid'; })
      .map(function (c) { return c.anchor.ref; });
    if (sentRefs.length) {
      qsa(MERMAID_NODE_SELECTOR, svg).forEach(function (node) {
        var nid = parseMermaidDomId(node.getAttribute('id'));
        if (nid && sentRefs.indexOf(nid) !== -1) node.classList.add('cb-anchor-sent');
      });
    }
    // A theme switch calls this again for the SAME preEl (a fresh
    // <svg> inside it, not a fresh <pre>), purely to refresh the pins above --
    // the click listener itself must attach exactly once per element, ever,
    // or repeated switches stack repeated handlers (mermaidWiredBlocks, above).
    if (isMermaidBlockWired(preEl)) return;
    markMermaidBlockWired(preEl);
    preEl.addEventListener('click', function (ev) {
      // One gesture, toggle-gated everywhere: a diagram node is no longer a standing
      // exception either -- with comment mode off this is a no-op, exactly like
      // the generic page listener and the html stage above.
      if (readonly || !commentMode) return;
      var target = ev.target;
      var host = target && target.closest ? target.closest(MERMAID_NODE_SELECTOR) : null;
      if (!host) return;
      var ref = parseMermaidDomId(host.getAttribute('id'));
      if (!ref) return;
      mintMermaidComment(section, blockId, host, ref);
    });
  }

  // --- the diagram lens -----------------------------
  //
  // "A mermaid block carries an expand control that opens the
  // diagram in a full-viewport lens: drag pans, scroll zooms, with fit and 1:1
  // controls." "A mermaid node can be commented on from inside the
  // lens, and that comment is the same comment as one minted inline -- same
  // anchor, and its pin appears on the inline diagram after Send."
  //
  // Modelled on /explain's lens (~/.claude/skills/explain/template.html), as the
  // spec's Decision directs, and differing from it in the three places that
  // matter here:
  //
  //   1. It is opened by the explicit .expand-btn ONLY, never by clicking the
  //      diagram. /explain has no other meaning for a diagram click; this page
  //      does (comment on this node), and the spec is explicit that "the click
  //      gesture on a diagram keeps its current meaning in both modes".
  //   2. It is COMMENTABLE, through mintMermaidComment above -- the same
  //      function the inline gesture calls, so "the same comment"
  //      is structural.
  //   3. The block's own comment <form> is MOVED in here while it is open rather
  //      than duplicated (lensAdopt below). A showModal()'d <dialog> makes the
  //      rest of the document inert, so a form left behind it could be opened
  //      and never typed into -- and a second form would be a second submit
  //      handler, i.e. exactly the "second parallel kind of comment" this
  //      exists to avoid.
  //
  // THE CLONED-ID TRAP, which the spec names rather than leaving to be
  // discovered: /explain's lensOpen clones the SVG, and a clone carries
  // duplicate element ids -- with the lens open, every mermaid node id exists
  // TWICE in this document. So nothing in here ever resolves an id against
  // 'document'. Node identity crosses between the two copies structurally
  // instead, through mirrorMermaidNode below (index path out of one root,
  // resolved into the other, then cross-checked on the id), and the two id
  // lookups that do happen -- ev.target.closest(MERMAID_NODE_SELECTOR) and
  // mermaidHostFor's scan -- are each scoped to a root that is unambiguously one
  // copy or the other. This is the same class of bug as QUIRKS.md's "Real
  // mermaid node ids are prefixed", which killed the whole diagram gesture once
  // while a 380-line dedicated check stayed green.

  // The view math is pure and lives in src/lens.mjs, spliced in verbatim by
  // .toString() (same discipline as computeBoardPatch/composeHint/roundNumberLabel):
  // "the point under the cursor stays under the cursor" and "fit centres the
  // whole diagram" are arithmetic invariants a check can hold this to, and are
  // otherwise the kind of thing verified by eye and wrong by a half-pixel
  // forever. Anything they need is declared inside their own bodies -- the
  // embedded copies are function sources, so a module-level helper would not
  // exist here.
  var lensZoomAt = function lensZoomAt(view, px, py, factor, min, max) {
  var s = Math.min(max, Math.max(min, view.s * factor));
  var k = s / view.s;
  return { x: px - k * (px - view.x), y: py - k * (py - view.y), s: s };
};
  var lensFit = function lensFit(sw, sh, w, h, min, max) {
  var lo = min == null ? 0 : min;
  var hi = Math.min(max == null ? 1 : max, 1);
  var s = Math.min(Math.max(Math.min(sw / w, sh / h), lo), hi);
  return { x: (sw - w * s) / 2, y: (sh - h * s) / 2, s: s };
};
  var lensOneToOne = function lensOneToOne(sw, sh, w, h) {
  return { x: (sw - w) / 2, y: (sh - h) / 2, s: 1 };
};

  var LENS_MIN_SCALE = 0.1;
  var LENS_MAX_SCALE = 8;

  // { x, y, s } -- what 'translate(x, y) scale(s)' on .lens-canvas means, with
  // that element's transform-origin pinned to its own top-left (src/styles.mjs).
  var lensView = { x: 0, y: 0, s: 1 };
  // Built lazily on the first expand and reused for every diagram afterwards:
  // one <dialog>, whose listeners are registered exactly once. A per-block lens
  // would re-register pan/zoom handlers on every open, which is the same
  // stacked-listener failure every wiring loop in this file is scoped to avoid.
  var lens = null;
  // Set while a drag is actually moving the canvas, read by the lens's click
  // handler: a pan that ends over a node still fires a click, and "I dragged the
  // diagram" must never queue a comment. Reset on the next pointerdown.
  var lensDragMoved = false;

  /** The counterpart of 'node' in the other copy of the same diagram: its index
   * path out of 'fromRoot', resolved into 'toRoot'. cloneNode(true) preserves
   * element order exactly, so the path is the same in both -- and the result is
   * accepted only if it carries the SAME generated id, which is the cross-check
   * that turns "the two trees disagree" (the inline SVG re-rendered while the
   * lens was open, say) into null rather than into a comment silently anchored
   * on the wrong node. Structural, deliberately: an id lookup is exactly what is
   * ambiguous here. */
  function mirrorMermaidNode(fromRoot, toRoot, node) {
    if (!fromRoot || !toRoot || !node || !node.getAttribute) return null;
    var steps = buildSteps(fromRoot, node);
    var twin = steps ? resolveSteps(toRoot, steps) : null;
    if (!twin || !twin.getAttribute) return null;
    return twin.getAttribute('id') === node.getAttribute('id') ? twin : null;
  }

  function lensButton(action, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lens-btn';
    b.setAttribute('data-lens', action);
    b.textContent = label;
    return b;
  }

  function buildLens() {
    if (lens) return lens;
    var dlg = document.createElement('dialog');
    dlg.className = 'diagram-lens';
    dlg.setAttribute('aria-label', 'Diagram lens');

    var bar = document.createElement('div');
    bar.className = 'lens-bar';
    var title = document.createElement('span');
    title.className = 'lens-title';
    title.textContent = 'Diagram lens';
    var hint = document.createElement('span');
    hint.className = 'lens-hint';
    var pct = document.createElement('span');
    pct.className = 'lens-pct';
    pct.textContent = '100%';
    bar.appendChild(title);
    bar.appendChild(hint);
    bar.appendChild(pct);
    bar.appendChild(lensButton('fit', 'fit'));
    bar.appendChild(lensButton('one', '1:1'));
    bar.appendChild(lensButton('close', 'close'));

    var formHost = document.createElement('div');
    formHost.className = 'lens-form-host';

    var stage = document.createElement('div');
    stage.className = 'lens-stage';
    var canvas = document.createElement('div');
    canvas.className = 'lens-canvas';
    // "Pins in the lens live inside the zoom
    // transform, counter-scaled": the pin layer is a child of the CANVAS, not of
    // the stage, so panning and zooming move every pin for free -- no pointer-move
    // recomputation, which is the scroll-tracking cost just avoided on
    // code blocks. Each pin then gets scale(1/s) of its own (lensScalePins) so it
    // stays 20px on screen instead of being buried under itself at high zoom.
    var layer = document.createElement('div');
    layer.className = 'pin-layer';
    canvas.appendChild(layer);
    stage.appendChild(canvas);

    dlg.appendChild(bar);
    dlg.appendChild(formHost);
    dlg.appendChild(stage);
    document.body.appendChild(dlg);

    lens = { dlg: dlg, bar: bar, hint: hint, pct: pct, formHost: formHost, stage: stage,
      canvas: canvas, layer: layer, slots: [], open: false,
      blockId: null, section: null, svg: null, clone: null, size: { w: 1, h: 1 } };
    wireLensChrome();
    wireLensStage();
    return lens;
  }

  function lensStageRect() {
    return (lens && lens.stage.getBoundingClientRect)
      ? lens.stage.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
  }

  /** Push lensView at the DOM: one transform on the canvas, the readout, and the
   * per-pin counter-scale. Never re-derives a pin POSITION -- those are canvas-
   * local and a pan/zoom does not change them, which is the whole point of the
   * pins living inside the transform. */
  function lensApply() {
    if (!lens) return;
    lens.canvas.style.transform = 'translate(' + lensView.x + 'px, ' + lensView.y + 'px) scale(' + lensView.s + ')';
    lens.pct.textContent = Math.round(lensView.s * 100) + '%';
    lensScalePins();
  }

  function lensScalePins() {
    if (!lens) return;
    var k = 1 / (lensView.s || 1);
    qsa('.anchor-pin', lens.layer).forEach(function (pin) {
      // translate(-50%, -50%) FIRST, then scale: the composite still lands the
      // pin's own centre exactly on (left, top) whatever k is, so a pin does not
      // creep off its node as the zoom changes.
      pin.style.transform = 'translate(-50%, -50%) scale(' + k + ')';
    });
  }

  function lensDoFit() {
    if (!lens) return;
    var r = lensStageRect();
    // Clamped into the same band the wheel is clamped into (see lensFit's own
    // comment, src/lens.mjs): a diagram tall enough to fit BELOW the floor
    // otherwise makes the first wheel-out zoom in.
    lensView = lensFit(r.width, r.height, lens.size.w, lens.size.h, LENS_MIN_SCALE, LENS_MAX_SCALE);
    lensApply();
  }

  function lensDoOneToOne() {
    if (!lens) return;
    var r = lensStageRect();
    lensView = lensOneToOne(r.width, r.height, lens.size.w, lens.size.h);
    lensApply();
  }

  /** Positioning half: the same comments the inline diagram pins,
   * pinned again on the clone. The HOST lookup runs against the INLINE svg
   * (mermaidHostFor, so the domRef-first precedence is the one already checked)
   * and is then mirrored into the clone -- rather than scanning the clone by id,
   * which is precisely the ambiguous lookup this whole section avoids.
   * Positions are canvas-local, so they are divided back out of the live scale;
   * placePin's resolved/lost/pending styling is untouched and still comes from
   * the server's verdict, exactly as inline. */
  function renderLensPins() {
    if (!lens || !lens.open) return;
    lens.layer.innerHTML = '';
    resetStackedOffset(lens.layer);
    var s = lensView.s || 1;
    var canvasBox = lens.canvas.getBoundingClientRect ? lens.canvas.getBoundingClientRect() : null;
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== lens.blockId || !c.anchor || c.anchor.kind !== 'mermaid') return;
      var inlineHost = mermaidHostFor(c.anchor, lens.svg, lens.section);
      var host = inlineHost ? mirrorMermaidNode(lens.svg, lens.clone, inlineHost) : null;
      var position = null;
      if (host && host.getBoundingClientRect && canvasBox) {
        var b = host.getBoundingClientRect();
        position = {
          left: (b.left - canvasBox.left) / s + (b.width / s) / 2,
          top: (b.top - canvasBox.top) / s + (b.height / s) / 2,
        };
      }
      placePin(lens.layer, c, !!c.resolved, position);
    });
    lensScalePins();
  }

  function lensUpdateHint() {
    if (!lens || !lens.hint) return;
    lens.hint.textContent = (commentMode && !readonly)
      ? 'drag pans · scroll zooms · click a node to comment on it'
      : 'drag pans · scroll zooms';
  }

  /** Move 'el' into the lens, leaving a placeholder where it was so it can be put
   * back exactly where it came from. Used for the block's own comment form and
   * its "commenting on:" label -- see this section's design comment for why they
   * are moved rather than copied. Listeners survive a move, which is the whole
   * reason this works: the form that submits from inside the lens is the same
   * element, with the same submit handler, as the one that submits inline. */
  function lensAdopt(el) {
    if (!lens || !el) return;
    var slot = document.createElement('span');
    slot.className = 'lens-slot';
    el.replaceWith(slot);
    lens.slots.push({ slot: slot, el: el });
    lens.formHost.appendChild(el);
  }

  function lensReturnAdopted() {
    if (!lens) return;
    lens.slots.forEach(function (s) {
      // Detach from the lens explicitly before re-inserting: a real DOM insert
      // would move the node for us, but this file's DOM stand-in appends without
      // unlinking, and a form present in two childNodes lists at once is a bug
      // that would only ever show up in a check.
      if (s.el.replaceWith) s.el.replaceWith();
      s.slot.replaceWith(s.el);
    });
    lens.slots = [];
  }

  function lensOpen(section, blockId, svg) {
    if (!svg || !svg.cloneNode) return;
    var l = buildLens();
    // Already open: refuse rather than re-enter. A modal <dialog> makes the rest
    // of the document inert, so no second expand control is reachable while one
    // is open -- and showModal() on an already-open dialog throws, while the
    // close it would need first fires its 'close' event on a LATER task, so
    // "close then reopen" here would tear the new lens down a tick after
    // building it.
    if (l.open) return;
    // Natural size: the viewBox if mermaid emitted one (its own coordinate
    // space, independent of however wide the block happens to be right now),
    // falling back to the rendered box.
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var box = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    var w = (vb && vb.width) || (box && box.width) || 800;
    var h = (vb && vb.height) || (box && box.height) || 600;
    var clone = svg.cloneNode(true);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    if (clone.style) clone.style.maxWidth = 'none';

    l.canvas.innerHTML = '';
    l.canvas.appendChild(clone);
    l.canvas.appendChild(l.layer);
    l.canvas.style.width = w + 'px';
    l.canvas.style.height = h + 'px';

    l.blockId = blockId;
    l.section = section;
    l.svg = svg;
    l.clone = clone;
    l.size = { w: w, h: h };
    l.open = true;
    // Under readonly there is no comment gesture to host a form for, and every
    // input on the page is hard-disabled anyway -- so nothing is moved, and the
    // archive's lens is exactly what the spec asks for: pan and zoom, nothing else.
    if (!readonly) {
      lensAdopt(document.querySelector('div#comment-target-' + blockId));
      lensAdopt(document.querySelector('form#comment-form-' + blockId));
    }
    if (l.dlg.showModal) l.dlg.showModal();
    else l.dlg.setAttribute('open', ''); // no <dialog> support (this repo's DOM stand-in)
    lensUpdateHint();
    lensDoFit();
    renderLensPins();
  }

  /** A theme change re-renders every inline diagram (runMermaidRedrawPass,
   * further down), and mermaid does that by REPLACING each 'pre.mermaid''s svg
   * with a brand-new element drawn in the new palette. The lens holds a
   * cloneNode(true) of the OLD one, so without this an already-open lens goes on
   * showing a dark diagram inside light chrome (or the reverse) until it is
   * closed and reopened.
   *
   * Reachable WITHOUT the theme control: a modal dialog makes the rest of the
   * document inert, so the control itself cannot be clicked while the lens is
   * open -- but src/theme.mjs dispatches the same event on a live OS
   * light/dark switch while System is in force (its own matchMedia listener),
   * which is exactly the reader who leaves a diagram open at sunset.
   *
   * Re-clones from the fresh svg and keeps the reviewer's current pan and zoom:
   * the source text is identical across a redraw, so the layout is identical
   * too and only the colours moved -- resetting the view here would throw away
   * a position the reviewer had panned to for a change they did not ask for.
   * The pins have to be redrawn regardless, since renderLensPins measures them
   * off the clone that was just replaced. wireDiagramExpand already re-reads
   * the live svg on click, so a lens opened AFTER a redraw was never affected;
   * this is only ever about one already open. */
  function lensRetheme() {
    if (!lens || !lens.open || !lens.section) return;
    var fresh = lens.section.querySelector('pre.mermaid svg');
    if (!fresh || fresh === lens.svg || !fresh.cloneNode) return;
    var vb = fresh.viewBox && fresh.viewBox.baseVal;
    var box = fresh.getBoundingClientRect ? fresh.getBoundingClientRect() : null;
    var w = (vb && vb.width) || (box && box.width) || lens.size.w;
    var h = (vb && vb.height) || (box && box.height) || lens.size.h;
    var clone = fresh.cloneNode(true);
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    if (clone.style) clone.style.maxWidth = 'none';
    lens.canvas.innerHTML = '';
    lens.canvas.appendChild(clone);
    lens.canvas.appendChild(lens.layer);
    lens.canvas.style.width = w + 'px';
    lens.canvas.style.height = h + 'px';
    lens.svg = fresh;
    lens.clone = clone;
    lens.size = { w: w, h: h };
    lensApply();
    renderLensPins();
  }

  /** Undo everything lensOpen did. Reached both ways a modal dialog can close --
   * the close button (lensClose -> dlg.close() -> the 'close' event) and Esc,
   * which the browser handles itself and which would otherwise strand the
   * block's comment form inside a hidden dialog. */
  function lensTeardown() {
    if (!lens || !lens.open) return;
    lens.open = false;
    lensReturnAdopted();
    lens.dlg.removeAttribute('open');
    lens.canvas.innerHTML = '';
    lens.canvas.appendChild(lens.layer);
    lens.layer.innerHTML = '';
    lens.blockId = null;
    lens.section = null;
    lens.svg = null;
    lens.clone = null;
  }

  function lensClose() {
    if (!lens || !lens.open) return;
    // close() first, teardown second, and never the other way round: removing the
    // 'open' attribute by hand hides a modal dialog without taking it out of the
    // top layer, leaving the whole page inert behind an invisible sheet. The
    // 'close' event this fires lands on a later task and finds lensTeardown
    // already done (it is idempotent), which is also what makes the Esc path --
    // where the browser closes the dialog and only then tells us -- work.
    if (lens.dlg.close) lens.dlg.close();
    lensTeardown();
  }

  function wireLensChrome() {
    var l = lens;
    l.dlg.addEventListener('close', function () { lensTeardown(); });
    qsa('.lens-btn', l.bar).forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-lens');
        if (act === 'close') { lensClose(); return; }
        if (act === 'one') lensDoOneToOne();
        else lensDoFit();
      });
    });
  }

  function wireLensStage() {
    var l = lens;
    var stage = l.stage;

    stage.addEventListener('wheel', function (ev) {
      if (!lens.open) return;
      // Non-passive on purpose: without preventDefault the page behind the
      // dialog scrolls instead of the diagram zooming.
      if (ev.preventDefault) ev.preventDefault();
      var r = lensStageRect();
      // A trackpad pinch arrives as a wheel event with ctrlKey set, an order of
      // magnitude coarser per notch than an ordinary scroll.
      var factor = Math.pow(2, -ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0022));
      lensView = lensZoomAt(lensView, ev.clientX - r.left, ev.clientY - r.top, factor, LENS_MIN_SCALE, LENS_MAX_SCALE);
      lensApply();
    }, { passive: false });

    stage.addEventListener('dblclick', function (ev) {
      if (!lens.open) return;
      var r = lensStageRect();
      lensView = lensZoomAt(lensView, ev.clientX - r.left, ev.clientY - r.top, 2, LENS_MIN_SCALE, LENS_MAX_SCALE);
      lensApply();
    });

    // Pointer capture is taken only once a press has become a PAN, never on the
    // press itself -- the whole difference between this lens being commentable
    // and not. With capture active the browser retargets everything that follows
    // (pointerup, mouseup and the resulting CLICK) at the capture element, so the
    // click handler below sees '.lens-stage' as its target instead of the diagram
    // node the pointer was over, 'closest(MERMAID_NODE_SELECTOR)' finds nothing,
    // and clicking a node in the lens silently does nothing. A DOM stand-in
    // cannot see that (there is no pointer capture there), which is this repo's
    // recorded failure pattern -- QUIRKS.md "Real mermaid node ids are prefixed",
    // the same gesture, dead in every browser under a green suite.
    //
    // TWO points are tracked per press, and the difference is the whole of
    // whether the 3px threshold below means anything:
    //
    //   ox/oy  the PRESS ORIGIN. Never reassigned for the life of the press.
    //          The threshold is measured from here, so it asks the only question
    //          worth asking -- 'has the pointer travelled more than 3px since the
    //          button went down'.
    //   x/y    the LAST MOVE. Reassigned every event, because each frame's pan is
    //          the delta since the previous frame.
    //
    // Measured from the last move instead, a 120px pan dispatched as 60 moves of
    // 2px -- an ordinary slow trackpad drag -- never crosses the threshold at
    // all: lensDragMoved stays false, the capture is never taken, and releasing
    // over a node opens the comment form on whatever the pan merely dragged PAST.
    // Invisible to a structural check, so test/check-mermaid-anchor.mjs
    // dispatches exactly that sequence.
    var drag = null;
    stage.addEventListener('pointerdown', function (ev) {
      if (!lens.open || ev.button) return;
      drag = { ox: ev.clientX, oy: ev.clientY, x: ev.clientX, y: ev.clientY, id: ev.pointerId, captured: false };
      lensDragMoved = false;
    });
    stage.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      // A few pixels of jitter between press and release is a click, not a pan:
      // only past that does this become a drag at all -- suppressing the comment
      // gesture below, taking the pointer capture, and showing the grabbing
      // cursor. Measured from the press origin, never from the last move.
      if (!lensDragMoved && (Math.abs(ev.clientX - drag.ox) > 3 || Math.abs(ev.clientY - drag.oy) > 3)) {
        lensDragMoved = true;
        stage.classList.add('lens-dragging');
        if (!drag.captured && stage.setPointerCapture && drag.id != null) {
          try { stage.setPointerCapture(drag.id); } catch (err) { /* no capture available: the pan still works, it just ends at the stage edge */ }
          drag.captured = true;
        }
      }
      lensView = { x: lensView.x + (ev.clientX - drag.x), y: lensView.y + (ev.clientY - drag.y), s: lensView.s };
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      lensApply();
    });
    ['pointerup', 'pointercancel'].forEach(function (type) {
      stage.addEventListener(type, function () {
        drag = null;
        stage.classList.remove('lens-dragging');
      });
    });

    // The comment gesture, gated exactly like every other one --
    // 'readonly || !commentMode', the same guard wireMermaidBlock's own listener
    // and the generic page listener carry.
    stage.addEventListener('click', function (ev) {
      if (!lens.open || readonly || !commentMode) return;
      if (lensDragMoved) return; // that was a pan that happened to end on a node
      var host = ev.target && ev.target.closest ? ev.target.closest(MERMAID_NODE_SELECTOR) : null;
      if (!host || !lens.clone || !lens.section) return;
      var ref = parseMermaidDomId(host.getAttribute('id'));
      if (!ref) return;
      // 'host' is a CLONED node. Everything downstream needs the inline one, and
      // it is found structurally rather than by id -- see this section's design
      // comment on the cloned-id trap.
      var inlineHost = mirrorMermaidNode(lens.clone, lens.svg, host);
      mintMermaidComment(lens.section, lens.blockId, inlineHost, ref);
    });
  }

  /** "A mermaid block carries an expand control". The button is
   * server-rendered (src/render.mjs's expandButton) so it exists in a standalone
   * archive's own bytes; this only binds it, and removes it outright when mermaid
   * left no SVG behind (CDN unreachable, invalid chart) rather than leaving a
   * control that opens an empty lens. */
  function wireDiagramExpand(section, blockId, svg) {
    var btn = section.querySelector('.expand-btn');
    if (!btn) return;
    if (!svg) { btn.replaceWith(); return; }
    if (btn.__cbExpandWired) return;
    btn.__cbExpandWired = true;
    btn.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      // Re-read the live SVG rather than trusting the one captured at wire time:
      // a re-render (a theme change, an amended block) replaces it.
      var live = section.querySelector('pre.mermaid svg') || svg;
      lensOpen(section, blockId, live);
    });
  }

  // --- the html-stage lens --------------------
  //
  // "Every html stage carries an expand control that opens the stage in the
  // lens", and "inside the lens the stage receives real pointer input: a mock
  // with its own scrollable content can be scrolled there".
  //
  // It BORROWS THE DIAGRAM LENS'S CHROME, NOT ITS VIEW MATHS (the spec's Out of
  // Scope says so in as many words): same full-viewport <dialog>, same
  // '.lens-bar' / '.lens-title' / '.lens-btn' vocabulary, built once and reused.
  // But its contents are a LIVE BROWSING CONTEXT, not a cloned SVG on a pannable
  // canvas -- an iframe scrolls, zooms and lays itself out on its own, so
  // lensZoomAt/lensFit/lensOneToOne and the whole clone-and-transform path above
  // have nothing to do here. A second <dialog> rather than a mode flag on the
  // first: they share no state, only styling, and folding two unrelated stages
  // into one element is how the diagram lens's pan/zoom listeners would end up
  // firing over an iframe.
  //
  // THE FRAME IS A SECOND MOUNT OF THE SAME SRCDOC, AND DELIBERATELY NOT A
  // '.html-stage'. findStageFrame (above) identifies a message's sender by
  // walking qsa('.html-stage', document) and comparing event.source to each
  // frame's contentWindow, and that walk carries an ASSUMPTION rather than just a
  // lookup: every mounted '.html-stage' is exactly one block's inline stage, so
  // the frame it finds names the block ('.html-block' ancestor), the pin layer to
  // draw into and the sentRefs to send. A second frame wearing that class for the
  // same block makes the claim false -- 'ready' would re-run handleStageReady for
  // an already-wired block, and the two frames' 'positions' replies would race
  // for one pin layer (which keeps only the latest requestId, so the loser's pins
  // vanish). So the lens frame carries '.stage-lens-frame' and never
  // '.html-stage': findStageFrame returns null for it and its messages are
  // dropped at the identity check, before any shape validation -- a strictly
  // SMALLER surface than the inline stage has, which is the direction to fail in
  // for a frame whose whole content is agent-authored. What it costs is
  // element-level commenting inside the lens copy (no 'ready' means no 'mode');
  // the inline stage is unchanged, and for a variant option the spec had already
  // given that up to the inertness rule.
  //
  // A COPY, NOT THE INLINE FRAME MOVED IN (which is what lensAdopt does for the
  // block's comment form). Re-parenting an <iframe> destroys and recreates its
  // browsing context, so "move it in, move it back" is two reloads of the mock --
  // and while it sat in the dialog it would be outside its own '.html-block', so
  // findStageFrame would match it while the closest('.html-block') lookup right
  // after returned null: every message from the block's own stage silently
  // dropped for as long as the lens was open.
  //
  // POINTER-EVENTS, i.e. why this costs nothing at the trust boundary.
  // '.choice-variant .html-stage { pointer-events: none; }' (src/styles.mjs) is a
  // security rule, not a style choice (the spec's Decisions pin it verbatim).
  // Nothing here relaxes it: the lens frame is neither inside a '.choice-variant'
  // card nor a '.html-stage', so the rule simply does not address it. "The lens is
  // where a stage becomes live" (ADR 22) is implemented by mounting a second copy
  // somewhere the rule was never about, never by weakening the rule.
  //
  // THE SANDBOX IS COPIED, NEVER RE-SPELLED. The attribute is read off the inline
  // frame and set on the copy before it is attached, so the two are sandboxed
  // identically by construction and there is no moment in which agent script
  // could run under a weaker one. A lens frame that gained 'allow-same-origin'
  // would re-open that chain wholesale (test/check-stage-isolation.mjs's header),
  // so a frame with no sandbox attribute at all is refused outright rather than
  // mounted: fail closed, because the failure this guards is total.
  //
  // THE PICK CONTROL lives in the bar, in the '.lens-actions' slot between the
  // title and close. See stageLensPick below for why that address is the security
  // property and not a layout preference.
  var stageLens = null;

  function buildStageLens() {
    if (stageLens) return stageLens;
    var dlg = document.createElement('dialog');
    dlg.className = 'stage-lens';
    dlg.setAttribute('aria-label', 'Stage lens');

    var bar = document.createElement('div');
    bar.className = 'lens-bar';
    var title = document.createElement('span');
    title.className = 'lens-title';
    title.textContent = 'Stage lens';
    // The pick control's slot, filled per open (stageLensPick) rather than
    // built once: which control belongs here is a fact about the stage being
    // opened, not about the lens, and "a lens opened from a
    // standalone stage carries no such control" is exactly the case where it
    // has to be empty. Emptied on teardown too, so a stale control can never
    // outlive the option it named.
    var actions = document.createElement('span');
    actions.className = 'lens-actions';
    bar.appendChild(title);
    bar.appendChild(actions);
    bar.appendChild(lensButton('close', 'close'));

    var body = document.createElement('div');
    body.className = 'stage-lens-body';

    dlg.appendChild(bar);
    dlg.appendChild(body);
    document.body.appendChild(dlg);

    stageLens = { dlg: dlg, bar: bar, actions: actions, body: body, frame: null,
      blockId: null, section: null, card: null, opener: null, open: false };
    wireStageLensChrome();
    return stageLens;
  }

  /** Mount 'section''s stage in the lens. 'opener' is the control that asked for
   * it, kept so this can hand focus back to it -- passed in rather than
   * read off document.activeElement, since whether a click focuses a button at
   * all is browser-dependent (Safari does not) and the answer must not be. */
  function stageLensOpen(section, blockId, opener) {
    var inline = section.querySelector('iframe.html-stage');
    if (!inline || !inline.getAttribute) return;
    var srcdoc = inline.getAttribute('srcdoc');
    var sandbox = inline.getAttribute('sandbox');
    // Fail closed on both: with no srcdoc there is nothing to show, and with no
    // sandbox attribute the copy would be a same-origin frame running
    // agent-authored script -- see this section's design comment.
    if (srcdoc == null || !sandbox) return;
    var l = buildStageLens();
    if (l.open) return; // already open: refuse rather than re-enter (lensOpen's own reasoning)
    var frame = document.createElement('iframe');
    frame.className = 'stage-lens-frame';
    // Named for a screen reader the same way the inline stage is named by its
    // block kicker; an unlabelled frame is announced as "frame" and nothing else.
    frame.setAttribute('title', 'Expanded stage');
    frame.setAttribute('sandbox', sandbox);
    frame.setAttribute('srcdoc', srcdoc);
    l.body.innerHTML = '';
    l.body.appendChild(frame);
    l.frame = frame;
    l.blockId = blockId;
    l.section = section;
    l.opener = opener || null;
    l.open = true;
    stageLensPick(section);
    if (l.dlg.showModal) l.dlg.showModal();
    else l.dlg.setAttribute('open', ''); // no <dialog> support (this repo's DOM stand-in)
  }

  /** The control that picks the option this lens was opened from. Built per open
   * and dropped on teardown -- never once, at build time -- because WHICH option
   * it names is a fact about this open, and "a lens opened from a standalone
   * stage carries no such control" is the case where the answer is "none at all".
   *
   * WHY THE BAR IS THE SECURITY PROPERTY, not a layout preference (the terms ADR
   * 22 was accepted on): the control is an ordinary <button> in the PARENT
   * document, a flex sibling of the '.stage-lens-body' that holds the frame --
   * never inside the frame, never overlapping it. Four attacks, each stopped
   * structurally rather than by a guard:
   *
   *   - PRESSING IT. A click inside a cross-origin frame is delivered in that
   *     frame's own document and does not cross the boundary.
   *   - REACHING IT THROUGH THE DOM. 'sandbox="allow-scripts"' with no
   *     'allow-same-origin' gives the frame an opaque origin, so
   *     'window.parent.document' is unreachable from inside it -- the property
   *     test/check-stage-isolation.mjs exists to pin.
   *   - FORGING A MESSAGE. There is no message type on the stage channel that
   *     records a pick (src/render.mjs's stage-channel comment: there is
   *     deliberately no 'select' message), and this lens's frame is not even in
   *     the '.html-stage' walk the listener identifies senders with, so nothing
   *     it posts is dispatched at all.
   *   - COVERING IT. A frame paints only inside its own box, and nothing in the
   *     lens's own CSS takes the body or the frame out of flow (no position, no
   *     z-index -- src/styles.mjs).
   *
   * What remains, accepted rather than solved (ADR 22's Consequences): a mock can
   * draw CONVINCING FAKE CHROME inside its own box. Pressing that does nothing --
   * which is the point -- but nothing here can stop it being drawn. The real
   * control's fixed home in the bar, above and outside the frame, is the whole of
   * the mitigation.
   *
   * The label is agent-authored board content and lands via 'textContent': no
   * parse, so no markup in a label can ever become an element in this document.
   *
   * THREE STATES WHERE A PICK IS REFUSED, each of them 'selectVariant''s own
   * guard mirrored into the chrome so the control never reads as live while being
   * inert. readonly (a standalone file: archive): no control at all, since there
   * is no answer to record there -- the diagram lens sets the same precedent by
   * hosting no comment form. A historical round ('aria-disabled' on the card):
   * rendered, disabled, so it says present-but-unavailable where an absent
   * control would read as a missing feature. Comment mode on: rendered, disabled,
   * for the same reason the card itself stands down. Decided once, at open -- a
   * modal dialog makes the rest of the page inert, so the toggle cannot be
   * reached while the lens is up and the state cannot change under it. */
  function stageLensPick(section) {
    var l = stageLens;
    l.actions.innerHTML = '';
    l.card = null;
    var card = section.closest ? section.closest('.choice-variant') : null;
    if (!card || readonly) return;
    l.card = card;
    var pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'lens-btn lens-pick';
    pick.textContent = 'Pick ' + (card.getAttribute('data-choice') || 'this option');
    if (commentMode || card.getAttribute('aria-disabled') === 'true') pick.disabled = true;
    pick.addEventListener('click', function () {
      // The stand-in does not model a browser refusing to fire a click on a
      // disabled button (test/check-archive.mjs's own note on that), and this
      // handler must not be the one place that difference matters -- so the
      // disabled state is re-read here rather than trusted to the platform.
      if (pick.disabled) return;
      // selectVariant re-applies all three guards above on its own -- this
      // control is a caller, never an authority -- so a pick it refuses records
      // nothing and simply closes the lens.
      if (l.card) selectVariant(l.card);
      stageLensClose();
    });
    l.actions.appendChild(pick);
  }

  /** Undo everything stageLensOpen did, and hand focus back to the control that
   * opened it. Idempotent for exactly the reason lensTeardown is:
   * it is reached from this page's own Esc/backdrop handling AND from the
   * dialog's native 'close' event, which lands on a later task. Dropping the
   * frame is what ends the copy's browsing context -- the mock's script, timers
   * and all -- so a closed lens is not a hidden one still running. */
  function stageLensTeardown() {
    if (!stageLens || !stageLens.open) return;
    stageLens.open = false;
    stageLens.dlg.removeAttribute('open');
    stageLens.body.innerHTML = '';
    // The pick control named ONE option, and its listener holds that card. The
    // next open clears this slot again before filling it (stageLensPick), so
    // correctness does not rest on this line alone -- what it adds is that a
    // CLOSED lens holds neither a control nor a reference to a card an SSE
    // re-render may already have replaced.
    stageLens.actions.innerHTML = '';
    stageLens.card = null;
    stageLens.frame = null;
    stageLens.blockId = null;
    stageLens.section = null;
    var opener = stageLens.opener;
    stageLens.opener = null;
    if (opener && opener.focus) opener.focus();
  }

  function stageLensClose() {
    if (!stageLens || !stageLens.open) return;
    // close() first, teardown second -- removing the 'open' attribute by hand
    // hides a modal dialog without taking it out of the top layer, leaving the
    // page inert behind an invisible sheet (lensClose's own comment).
    if (stageLens.dlg.close) stageLens.dlg.close();
    stageLensTeardown();
  }

  function wireStageLensChrome() {
    var l = stageLens;
    l.dlg.addEventListener('close', function () { stageLensTeardown(); });
    qsa('.lens-btn', l.bar).forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-lens') === 'close') stageLensClose();
      });
    });
    // Esc. A real browser closes a modal <dialog> on Esc by itself
    // and tells us afterwards through 'close' -- but only when the key event
    // lands in THIS document, and this lens is the one page surface that can hold
    // focus inside a cross-origin frame, where the parent sees no key event at
    // all. Handling it here as well is therefore not belt-and-braces, and it is
    // also the only version of this that any check without a browser can drive
    // (the DOM stand-in has no dialog semantics whatsoever). Registered on
    // 'document' rather than on the dialog so a press with focus anywhere in the
    // parent document counts; harmless when the lens is shut, since every path
    // out of here is guarded on 'open'.
    document.addEventListener('keydown', function (ev) {
      if (!stageLens || !stageLens.open) return;
      if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
      stageLensClose();
    });
    // Backdrop. Two targets, because "the backdrop" is two
    // different elements depending on how the dialog ends up sized: the dialog
    // itself is what a real browser reports for a click on the ::backdrop area,
    // and the padded surround around the frame is what a reviewer actually aims
    // at while the dialog fills the viewport. Anything else -- the bar, its
    // controls, the frame -- keeps its own meaning, and a click INSIDE the stage
    // never reaches this document at all (it belongs to the frame's own).
    l.dlg.addEventListener('click', function (ev) {
      if (!stageLens.open) return;
      if (ev.target !== l.dlg && ev.target !== l.body) return;
      stageLensClose();
    });
  }

  /** Binding half: the control itself is server-rendered
   * (src/render.mjs's expandButton) so a standalone file: archive carries it in
   * its own bytes, and src/ui.mjs's readonly pass skips it by class -- both
   * reasons hold for a stage exactly as they do for a diagram. Guarded against a
   * second binding the same way wireDiagramExpand is: wireRoot re-runs on every
   * SSE push, over roots that may already have been wired. */
  function wireStageExpand(section) {
    var btn = section.querySelector('.expand-btn');
    if (!btn || btn.__cbExpandWired) return;
    btn.__cbExpandWired = true;
    btn.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      stageLensOpen(section, section.getAttribute('data-block-id'), btn);
    });
  }

  /** Keeps every page round's own send
   * control and hint honest as pendingComments changes -- called from
   * refreshPins (queue/edit/delete, a submit landing, a resize -- see that
   * function's own comment for why this belongs beside
   * refreshPendingCommentItems rather than at each call site individually),
   * document-wide for the identical reason: a comment queued while looking at
   * ONE page must never leave some OTHER page's already-rendered label and
   * hint stale for when the reviewer flips back to it. 'commentsWithPending'
   * is the exact same count 'renderPageCommentPanel' (src/render.mjs) reads
   * at first paint, from a different source (board.comments vs board.comments
   * PLUS the live queue) -- the two can disagree the instant a comment is
   * queued, which is precisely why this exists. */
  function updatePageSendControls() {
    qsa('.page-send-bar', document).forEach(function (bar) {
      var n = parseInt(bar.getAttribute('data-round'), 10);
      if (!isFinite(n)) return;
      var blocks = blocksOfRound(n);
      if (!blocks.length) return;
      var blockId = blocks[0].id;
      var count = commentsWithPending().filter(function (c) { return c.blockId === blockId; }).length;
      var sendBtn4 = bar.querySelector('.page-send-btn');
      if (sendBtn4) sendBtn4.textContent = count === 0 ? 'Nothing to add' : ('Send ' + count + ' comment' + (count === 1 ? '' : 's'));
      var panel = bar.closest('.page-comments');
      var hint = panel && panel.querySelector('.page-comment-hint');
      if (hint) hint.style.display = count === 0 ? '' : 'none';
    });
  }

  /** Re-render (and reposition) every pin layer under 'root' from the current
   * commentsWithPending(). Repositioning ONLY -- it must never re-run the
   * click-listener wiring (that stays one-time per stage document, since the
   * stage's own agent script attaches its listeners exactly once, when it
   * first runs -- see src/render.mjs's stageAgentScript), or every resize and
   * every queued comment would stack another click handler inside the same
   * iframe/diagram. Called on resize, the moment a comment is queued (so its
   * provisional pin appears without waiting for Send) and again once a submit
   * lands (so the provisional pins give way to the server's). For an
   * html-stage, "re-render" means asking that stage for fresh positions
   * (async, over postMessage) rather than reading them directly;
   * only stages isWiredStage recognises (i.e. that have answered 'ready' at
   * least once) are asked, since one that never will can never answer
   * anyway.
   *
   * The queued comments' LIST entries are rebuilt here too,
   * rather than at each of this function's call sites. A pin and a list entry
   * are two renderings of one array, and they were drifting: every push path
   * (applyRoundPush, applySubmittedPush, applyResync) and the post-Send handler
   * called refreshPins alone, so an amend that replaced a block left the queued
   * comment's hollow pin drawn on the new markup with no list entry beside it --
   * no anchor tag, no text, and no delete control,
   * while the comment itself stayed in pendingComments and went out on the next
   * Send. Folding the two together is what stops a future call site
   * reintroducing that by remembering one and forgetting the other; it is
   * document-wide regardless of 'root' on purpose, since provisional numbering
   * spans the whole board (refreshPendingCommentItems' own comment). */
  function refreshPins(root) {
    refreshPendingCommentItems();
    updatePageSendControls();
    qsa('.html-stage', root).forEach(function (frame) {
      if (!isWiredStage(frame)) return;
      var section = frame.closest('.html-block');
      var blockId = section && section.getAttribute('data-block-id');
      var layer = section && section.querySelector('.pin-layer');
      if (blockId && layer) requestStagePositions(frame, blockId, layer);
    });
    qsa('.mermaid-block', root).forEach(function (section) {
      var layer = section.querySelector('.pin-layer');
      var svg = section.querySelector('svg');
      if (layer) renderMermaidPins(section.getAttribute('data-block-id'), svg || null, layer, section);
    });
    wirePageDomPins(root);
    // The lens's own pin layer is not under any 'root' -- the dialog is a direct
    // child of <body> -- so it needs its own line here rather than being found by
    // the loops above. This is what makes a comment queued from INSIDE the lens
    // get its hollow pin there immediately, exactly as one queued inline does.
    renderLensPins();
  }

  /** "Can be dragged taller": measured
   * in real Chrome (not assumed -- resize interacts
   * with max-height in ways worth checking), CSS max-height clamps the rendered
   * box PERMANENTLY, including against the explicit inline height the browser's
   * own resize: vertical drag sets -- a capped <pre> is undraggable for as long
   * as max-height stays in effect, full stop, regardless of specificity or
   * origin. So the cap src/styles.mjs applies (max-height: 480px) is exactly
   * right for the FIRST paint (a short block's natural
   * height never reaches it, so nothing here ever touches one), but a genuinely
   * capped block needs that ceiling converted to a plain, breakable height once,
   * so the reviewer's drag actually moves it. Reads the already-rendered box (no
   * line-counting, no guessing at font metrics) and is a no-op the moment it
   * runs a second time, since the inline height it sets no longer leaves
   * anything for max-height to clamp. */
  function unlockCodeCapForDrag(pre) {
    if (pre.__cbCapUnlocked) return;
    // wireRoot runs against a DETACHED subtree on every push path
    // -- applyRoundPush wires 'wrap'/'frag' before appending, applySubmittedPush
    // wires 'replacement' before the swap, both deliberately (see their own
    // comments on why listeners are attached pre-attach) -- and a detached <pre>
    // reports clientHeight and scrollHeight of 0. Setting the marker first meant
    // the 'scrollHeight > clientHeight' test below was decided as 0 > 0, false,
    // on a permanently-remembered flag: every code block that arrived over SSE
    // was undraggable for the life of the page, and the post-attach
    // refreshPins() that exists precisely to redo detached work found the
    // marker already set and did nothing. Bailing WITHOUT marking leaves the
    // block for that same post-attach pass to measure properly.
    if (!pre.clientHeight) return;
    pre.__cbCapUnlocked = true;
    if (pre.scrollHeight > pre.clientHeight) {
      var height = pre.getBoundingClientRect().height;
      pre.style.maxHeight = 'none';
      pre.style.height = height + 'px';
    }
  }

  /** Page-scoped dom pins: every block whose content lives in this
   * document, not an iframe/svg -- see directChildPinLayer below for why this is a
   * shallow, direct-children-only lookup rather than qsa('.pin-layer', section).
   * Called both from refreshPins (resize / a comment just queued / submitted) and
   * once at wire time from wireRoot itself (below) -- unlike the html-stage/
   * mermaid cases, there is no async 'load'/render event to hang the FIRST paint
   * of an already-persisted comment's pin off of, so wireRoot has to do it
   * directly or a board reopened with existing element-level comments would show
   * no pins at all until the next resize. */
  function wirePageDomPins(root) {
    qsa('[data-block-id]', root).forEach(function (section) {
      var layer = directChildPinLayer(section);
      if (layer) renderDomPins(section.getAttribute('data-block-id'), section, layer);
      // A code block carries no pin-layer at all any more (ADR.md entry 28), so
      // nothing here is about pins -- but the cap-unlock still has
      // to run on every <pre> this pass sees, and this is the pass that already
      // walks every section on every push/resize.
      if (section.classList && section.classList.contains('code-block')) {
        var pre = section.querySelector('pre');
        if (pre) unlockCodeCapForDrag(pre);
      }
    });
  }

  // The direct-child .pin-layer of a block section, or null -- deliberately NOT
  // section.querySelector('.pin-layer'), which searches every descendant: a
  // question block's .question-context can hold a fully nested block (a compare
  // side, another question) with its OWN pin-layer, and a deep search from the
  // OUTER section could find the INNER one instead of its own (or find none, for
  // html/mermaid blocks, whose pin-layer is nested inside .stage-wrap on purpose
  // -- see src/render.mjs's pageDomPinLayer). Walking .children (never
  // .childNodes) stops at exactly this section's own layer or nothing.
  function directChildPinLayer(section) {
    var kids = section.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList && kids[i].classList.contains('pin-layer')) return kids[i];
    }
    return null;
  }

  // --- comment mode -------------------------------------------------------------
  //
  // A visible toggle gates one generic, page-wide hover/click gesture over
  // everything the board renders that is NOT already its own special case (the
  // html stage's and mermaid's own element click handlers, above). Those are not
  // exempt from the toggle -- 'one gesture, toggle-gated everywhere' put an
  // 'if (readonly || !commentMode) return;' guard on both, same as this listener.
  // They stay SEPARATE listeners because each already mints the more specific
  // anchor shape its surface needs: a mermaid anchor tied to the clicked node id,
  // or a dom anchor rooted at the iframe's OWN document via buildSteps(doc.body,
  // el) rather than this page's. Letting this generic listener ALSO fire on the
  // same click would either double-mint a second, conflicting anchor for a
  // mermaid node click (wireMermaidBlock's listener lives in this same document,
  // on pre.mermaid, so the click genuinely bubbles here too) or mint a nonsense
  // page-scoped anchor against the iframe element's own boundary (a click on its
  // border/padding is the one part of an html stage this document's listeners CAN
  // see -- content inside the sandboxed document never bubbles out to here at
  // all). ANCHOR_CHROME_SELECTOR below is what keeps both out of this listener's
  // reach.
  //
  // Off by default (commentMode, declared at the top of this script): every
  // ordinary widget handler in wireRoot below carries its own
  // "if (commentMode) return;" guard, so turning this ON stands those handlers
  // down and a click anchors instead of mutating an answer.

  var modeToggleBtn = document.querySelector('button#comment-mode-toggle');

  function setCommentMode(on) {
    commentMode = !!on && !readonly;
    if (modeToggleBtn) {
      // The label is the static word 'Comment' (see
      // src/render.mjs's commentModeToggle) -- on/off is carried by .active
      // and aria-pressed alone, so there is no label text to rewrite here.
      modeToggleBtn.classList.toggle('active', commentMode);
      modeToggleBtn.setAttribute('aria-pressed', commentMode ? 'true' : 'false');
    }
    document.body.classList.toggle('comment-mode', commentMode);
    if (!commentMode) clearAnchorHover();
    // The lens rides the same body class for its own
    // node hover/cursor affordance (src/styles.mjs's .lens-canvas rules), so the
    // only thing it needs told directly is what its hint line should now say.
    lensUpdateHint();
    // Every wired html stage is told the CURRENT state on every toggle, on or
    // off: a stage's own hover/click lives in a separate document that a
    // page-level 'body.comment-mode' class cannot reach into (QUIRKS.md "Two
    // stylesheets, one palette"), so each stage clears its own in-progress hover
    // locally the moment it hears 'commentMode: false' (stageAgentScript's own
    // 'mode' handler). sentRefs and the theme ride the same
    // message -- the moment mode turns on is exactly when the stage's hover
    // starts mattering, so it needs the current sent-list right then rather than
    // whatever it last happened to hear. One shared broadcast rather than a loop
    // here and a second, drifting one on the theme change: whichever fact moved,
    // a stage is told all of them, and neither caller can ship a
    // differently-shaped message.
    broadcastStageMode();
  }

  if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', function () {
      if (readonly) return;
      setCommentMode(!commentMode);
    });
  }

  // Chrome that is never an anchor target even while comment mode is on: the
  // comment infrastructure itself (a click there keeps its own, existing
  // meaning), the pins, the mode toggle, the round's own heading, a compare
  // side's label and a variant option's caption (structural chrome naming the
  // thing, not authored content -- without the caption exclusion a click on it
  // falls through to the enclosing QUESTION block, the nearest [data-block-id]
  // above it, since .variant-card carries none of its own), and pre.mermaid /
  // .html-stage. Those last two are NOT exempt from the toggle (see the comment
  // mode section above); each simply has its own listener, gated the same way,
  // that mints a more specific anchor for its surface. Excluding them here is
  // what stops this listener double-anchoring the same click.
  //
  // .stage-wrap is the part of an html OR mermaid stage outside the iframe/svg it
  // wraps -- its own border/padding, never any authored content. A click landing
  // there otherwise finds the block's own [data-block-id] section as its
  // anchorRootFor root and mints a page-scoped 'dom' ref against THAT section.
  // For a mermaid block that ref resolves correctly (resolveDomAnchorInSection
  // walks the SAME document the block re-renders into); for an html block it does
  // not, since the server's 'resolveComment' resolves EVERY 'dom' anchor on an
  // html-kind block through 'resolveDomAnchor', which roots against the IFRAME's
  // own document. A ref built from one tree and resolved against a different one
  // can coincidentally resolve to an unrelated element inside the mock rather
  // than reporting lost -- the exact false-positive resolution this whole design
  // exists to rule out. Excluding '.stage-wrap' outright was weighed against a
  // wire-format 'root' discriminator that would need coordinating mid-flight, for
  // a gesture -- anchoring a stage's own blank padding -- nothing needs. It does
  // NOT change what a click INSIDE either stage mints.
  //
  // .diagram-lens: the lens dialog is a direct child of <body>, so nothing inside
  // it has a [data-block-id] ancestor -- EXCEPT the block's own comment form,
  // moved into the lens while it is open, which does. Excluding the lens outright
  // keeps the generic gesture out of it entirely (hover marking included) and
  // leaves the lens's own listener, which mints the specific mermaid anchor its
  // surface needs, as the only thing that answers a click in there.
  var ANCHOR_CHROME_SELECTOR = '.block-kicker, .comment-btn, .comment-form, .comment-target, '
    + '.comment-list, .pin-layer, .anchor-pin, .mode-toggle, .compare-label, .variant-label, .round-label, '
    + 'pre.mermaid, .html-stage, .stage-wrap, .diagram-lens';

  function isAnchorChrome(el) {
    return !!(el.closest && el.closest(ANCHOR_CHROME_SELECTOR));
  }

  // The nearest block section a click/hover target lives in -- the root a page-
  // scoped dom anchor's path is measured from (DESIGN.md, "### Entry 28 -- element
  // anchoring").
  // Self-inclusive, matching real closest(); returns null for anything outside
  // .blocks entirely (the header, the mode toggle, the send bar), which is what
  // keeps this gesture from ever reaching page chrome without an explicit
  // exclusion list for each of them.
  function anchorRootFor(el) {
    return el.closest ? el.closest('[data-block-id]') : null;
  }

  // ADR.md entry 28 ("Only the rendered kinds can be commented on", 2026-08-06,
  // superseding the comment half of 26 and narrowing 6): the comment button and
  // the click-to-anchor gesture belong to 'html' and 'mermaid' and to nothing
  // else. This started life as a DENY list of the two wrapper kinds (question,
  // compare); entry 28 inverts it, because the rule is now drawn on kind rather
  // than on what a kind happens to wrap -- 'markdown' and 'code' are content and
  // still carry no affordance, so naming what IS anchorable is the only spelling
  // that stays true.
  //
  // A kind check on the ROOT the click/hover actually landed on, not a
  // chrome-selector addition, because a chrome selector can only exclude specific
  // elements *within* a section; it can't stop the section itself from being a
  // valid anchorRootFor result.
  //
  // Position is not part of the rule, and this is where that is true rather than
  // merely stated: anchorRootFor's closest('[data-block-id]') finds the NEAREST
  // section, so a block nested one level in -- a question's context entry, a
  // compare side's content -- is judged on its OWN data-block-kind, before the
  // wrapper is ever reached. An html stage or a mermaid diagram is therefore
  // exactly as anchorable inside a context or a compare side as it is at the top
  // level, and a markdown or code block is exactly as inert.
  var ANCHORABLE_BLOCK_KINDS = { html: true, mermaid: true };
  function isNonAnchorableRoot(root) {
    return !(root && ANCHORABLE_BLOCK_KINDS[root.getAttribute('data-block-kind')]);
  }

  var anchorHovered = null;
  function clearAnchorHover() {
    if (anchorHovered && anchorHovered.classList) {
      anchorHovered.classList.remove(STAGE_HOVER_CLASS);
      anchorHovered.classList.remove('cb-anchor-sent');
    }
    anchorHovered = null;
  }

  document.addEventListener('mouseover', function (ev) {
    if (!commentMode) return;
    var el = ev.target;
    clearAnchorHover();
    if (!el || el.nodeType !== 1 || isAnchorChrome(el)) return;
    var root = anchorRootFor(el);
    if (!root || el === root || isNonAnchorableRoot(root)) return;
    anchorHovered = el;
    // '.cb-anchor-sent' de-affordances (no outline, cursor: not-allowed --
    // src/styles.mjs) instead of the ordinary "you can anchor here" outline.
    var steps = buildSteps(root, el);
    var blockId = root.getAttribute('data-block-id');
    var sent = steps && steps.length && isSentAnchor(blockId, { kind: 'dom', ref: stepsToPath(steps) });
    el.classList.add(sent ? 'cb-anchor-sent' : STAGE_HOVER_CLASS);
  });
  document.addEventListener('mouseout', function () { if (commentMode) clearAnchorHover(); });

  document.addEventListener('click', function (ev) {
    if (!commentMode || readonly) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || isAnchorChrome(el)) return;
    var root = anchorRootFor(el);
    if (!root || el === root || isNonAnchorableRoot(root)) return;
    var steps = buildSteps(root, el);
    if (!steps || !steps.length) return;
    // Stops an <a href> from navigating, a submit-shaped element from submitting,
    // etc. -- comment mode means clicks anchor, full stop, while it's on.
    ev.preventDefault();
    var blockId = root.getAttribute('data-block-id');
    var anchor = { kind: 'dom', ref: stepsToPath(steps) };
    if (isSentAnchor(blockId, anchor)) { clearAnchorHover(); return; }
    clearAnchorHover();
    openCommentForm(blockId, 'dom', anchor.ref, buildHint(root, el), '', findPendingCommentForAnchor(pendingComments, blockId, anchor));
  });

  /** Select 'card''s option, deselecting every sibling under the same question.
   * 'aria-disabled' is this div's equivalent of a real <button>'s 'disabled'
   * attribute (src/render.mjs sets it once the block's round is historical) --
   * there is no native disabled state for a plain div to enforce on its own,
   * so every entry point checks for it here rather than relying on the
   * browser to refuse the click/keydown the way it would for an actual
   * disabled button.
   *
   * Declared HERE, at the client script's outer scope, rather than beside the
   * '.choice-variant' wiring loop inside wireRoot where it reads like it
   * belongs -- the lens pick control is a second caller,
   * and it is built from stageLensOpen, which wireRoot's locals are invisible
   * from. QUIRKS.md ("A function declared inside wireRoot is invisible from a
   * page-scoped listener, and the failure is silent") records the last time
   * this exact helper was on the wrong side of that line: the call threw a
   * ReferenceError that unwound into a postMessage try/catch several frames
   * away and vanished, with the plain-click path still working perfectly. Its
   * closing line -- "the next feature that shares a helper between wireRoot
   * and a page-scoped listener will [demonstrate it]" -- is this feature.
   *
   * There is still exactly ONE path that records a variant pick. The lens's
   * control calls this function; it does not maintain a second notion of what
   * is selected, and every guard above applies to it identically. */
  function selectVariant(card) {
    if (readonly || commentMode || card.getAttribute('aria-disabled') === 'true') return;
    var qid = card.getAttribute('data-question-id');
    var choice = card.getAttribute('data-choice');
    selections[qid] = choice;
    touched[qid] = true;
    qsa('.choice-variant[data-question-id="' + qid + '"]').forEach(function (c) {
      c.classList.toggle('selected', c === card);
    });
    updateQuestionsLeftPill();
  }

  // --- wiring, factored so it can run once at hydrate (root = document) and again
  // on just a freshly-inserted subtree after an SSE push (see applyRoundPush below)
  // -- an already-wired, already-filled-in element is never touched twice. ---------

  function wireRoot(root) {

  qsa('.choice-single', root).forEach(function (btn) {
    var qid = btn.getAttribute('data-question-id');
    var choice = btn.getAttribute('data-choice');
    if (selections[qid] === choice) btn.classList.add('selected');
    btn.addEventListener('click', function () {
      // commentMode: the generic click-to-anchor listener (below) owns
      // this click instead -- see its own comment for why every ordinary widget
      // handler stands down rather than firing alongside it.
      if (readonly || commentMode) return;
      selections[qid] = choice;
      touched[qid] = true;
      qsa('.choice-single[data-question-id="' + qid + '"]').forEach(function (b) {
        b.classList.toggle('selected', b === btn);
      });
      updateQuestionsLeftPill();
    });
  });

  qsa('.choice-multi', root).forEach(function (btn) {
    var qid = btn.getAttribute('data-question-id');
    var choice = btn.getAttribute('data-choice');
    if (!Array.isArray(selections[qid])) selections[qid] = [];
    if (selections[qid].indexOf(choice) !== -1) btn.classList.add('selected');
    btn.addEventListener('click', function () {
      if (readonly || commentMode) return;
      var arr = Array.isArray(selections[qid]) ? selections[qid].slice() : [];
      var idx = arr.indexOf(choice);
      if (idx === -1) arr.push(choice); else arr.splice(idx, 1);
      selections[qid] = arr;
      touched[qid] = true;
      btn.classList.toggle('selected', idx === -1);
      updateQuestionsLeftPill();
    });
  });

  // --- choose-between-rendered-variants: each option is a fully rendered content
  // block (src/render.mjs's renderVariantOption), so the selectable unit is a
  // plain, focusable '.choice-variant' div (role="button") rather than a real
  // <button> -- an 'html' option's iframe cannot legally nest inside one. Wired
  // by hand for the click + keyboard contract a real <button> gives for free.
  // Answer shape is otherwise identical to '.choice-single' (one label, read
  // generically by currentAnswer's default branch below), which is why there is
  // no separate case there.
  //
  // No stage-message path feeds this, deliberately: a stage message is
  // STAGE-AUTHORED input (the mock's own script can dispatch a click on
  // itself with no reviewer involved, and separately can forge the message
  // directly, since origin/identity validation only prove SOME live stage
  // sent it, never that a human did), and letting it pick an answer is the
  // agent handing itself the answer to its own question -- see src/render.mjs's
  // stage-channel comment on why there is deliberately no 'select' message. An
  // 'html' option's iframe is instead rendered 'pointer-events: none' inside
  // a '.choice-variant' card (src/styles.mjs), so a real click over the mock
  // can never reach the iframe at all -- it lands on THIS card, in the parent
  // document, exactly like a click on the option's label already does.

  qsa('.choice-variant', root).forEach(function (card) {
    var qid = card.getAttribute('data-question-id');
    var choice = card.getAttribute('data-choice');
    if (selections[qid] === choice) card.classList.add('selected');
    card.addEventListener('click', function (ev) {
      // A click landing on interactive chrome nested inside this option's OWN
      // rendered block (its comment button/form, a nested defer button, an
      // inline markdown anchor button, an existing comment-list entry, ...)
      // keeps its own meaning -- selecting the variant is this card's own
      // affordance, not a replacement for the content's.
      if (ev.target !== card && ev.target.closest
        && ev.target.closest('button, textarea, input, a, .comment-form, .comment-item')) return;
      selectVariant(card);
    });
    card.addEventListener('keydown', function (ev) {
      if (ev.target !== card) return; // a nested focusable's own key handling owns this
      // The MODIFIED chord belongs to board traversal (the document-level
      // Cmd+Enter listener at the bottom of this script), never to picking a
      // variant. Without this, a focused card turned one 'advance to the next
      // question' chord into two acts: this listener recorded a pick, and the
      // document listener then advanced off it -- so the reviewer committed an
      // answer they never chose, on whichever card happened to hold focus.
      // Plain Enter/Space stay this card's own affordance.
      if (ev.metaKey || ev.ctrlKey) return;
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();
      selectVariant(card);
    });
  });

  qsa('textarea[data-answer-for]', root).forEach(function (ta) {
    var qid = ta.getAttribute('data-answer-for');
    ta.addEventListener('input', function () {
      if (readonly) return;
      selections[qid] = ta.value;
      touched[qid] = true;
      updateQuestionsLeftPill();
    });
  });

  // Native HTML5 drag and drop. The gesture itself can't be asserted without a
  // browser; what matters for the node checks is that the answer ends up as the
  // ordered array of option labels, read from DOM order on drop.

  function rankOrder(list) {
    return qsa('li', list).map(function (li) { return li.getAttribute('data-choice'); });
  }

  function renumberRankList(list) {
    qsa('li', list).forEach(function (li, i) {
      var idx = li.querySelector('.rank-index');
      if (idx) idx.textContent = String(i + 1);
    });
  }

  qsa('.rank-list', root).forEach(function (list) {
    var qid = list.getAttribute('data-question-id');
    if (!Array.isArray(selections[qid])) selections[qid] = rankOrder(list);
    var dragging = null;
    list.addEventListener('dragstart', function (ev) {
      if (readonly || commentMode || ev.target.tagName !== 'LI') return;
      dragging = ev.target;
      dragging.classList.add('dragging');
    });
    list.addEventListener('dragend', function () {
      if (readonly || !dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      selections[qid] = rankOrder(list);
      touched[qid] = true;
      renumberRankList(list);
      updateQuestionsLeftPill();
    });
    list.addEventListener('dragover', function (ev) {
      if (readonly || !dragging) return;
      ev.preventDefault();
      var closest = { offset: -Infinity, el: null };
      qsa('li:not(.dragging)', list).forEach(function (li) {
        var box = li.getBoundingClientRect();
        var offset = ev.clientY - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) closest = { offset: offset, el: li };
      });
      if (closest.el == null) list.appendChild(dragging); else list.insertBefore(dragging, closest.el);
    });
  });

  qsa('textarea[data-note-for]', root).forEach(function (ta) {
    var qid = ta.getAttribute('data-note-for');
    if (notes[qid]) ta.value = notes[qid];
    ta.addEventListener('input', function () {
      if (readonly) return;
      notes[qid] = ta.value;
    });
  });

  qsa('.btn-defer', root).forEach(function (btn) {
    var qid = btn.getAttribute('data-defer-for');
    // Re-apply the live flag to the freshly-rendered button, exactly as the
    // single/multi/note loops above re-apply theirs. Without this, an amend that
    // re-rendered the question showed an UNdeferred button while deferred[qid]
    // stayed set -- so the reviewer saw a question they had not deferred, and
    // Send reported it deferred anyway.
    btn.classList.toggle('active', !!deferred[qid]);
    btn.addEventListener('click', function () {
      if (readonly || commentMode) return;
      deferred[qid] = !deferred[qid];
      btn.classList.toggle('active', !!deferred[qid]);
      updateQuestionsLeftPill();
    });
  });

  // A block-level comment and an element-level click inside an html stage or a
  // mermaid diagram both target the one shared comment-form for their block, via
  // openCommentForm (declared above wireRoot, alongside the other anchor helpers
  // it is shared with).

  // src/render.mjs's commentButton emits exactly one shape now: the whole-block
  // "Add comment" affordance, on the two kinds ADR.md entry 28 leaves commentable.
  // The inline 'md' variant (a button injected after a markdown heading or list
  // item) went with the anchor kind behind it, and with it the editing/sent rules
  // added for that one button -- a whole-block comment is
  // deliberately additive, never an edit, since this codebase's own design lets
  // several separate remarks share one block anchor (removePendingComment's
  // comment, src/anchor.mjs, is keyed by entry id precisely for that).
  qsa('.comment-btn', root).forEach(function (btn) {
    var blockId = btn.getAttribute('data-block-id');
    btn.addEventListener('click', function () {
      if (readonly) return;
      openCommentForm(blockId, 'block', '', '', '', null);
    });
  });

  qsa('.comment-form', root).forEach(function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (readonly) return;
      var input = form.querySelector('input[type=text]');
      var text = (input.value || '').trim();
      if (!text) return;
      var blockId = form.getAttribute('data-block-id');
      var anchorKind = form.getAttribute('data-anchor-kind') || 'block';
      var anchorRef = form.getAttribute('data-anchor-ref') || '';
      var anchorLabel = form.getAttribute('data-anchor-label') || '';
      // A diagram node's anchor carries the generic domRef/hint
      // alongside its node-id ref -- see src/anchor.mjs's "design"
      // comment for why. Read regardless of anchorKind (harmless: only the
      // 'mermaid' branch below uses it), same as every other attribute here.
      var anchorDomRef = form.getAttribute('data-anchor-domref') || '';
      var anchor = anchorKind === 'dom' ? { kind: 'dom', ref: anchorRef, hint: anchorLabel }
        : anchorKind === 'mermaid' ? { kind: 'mermaid', ref: anchorRef, domRef: anchorDomRef, hint: anchorLabel }
        : { kind: 'block' };
      // A form reopened on an anchor that
      // already has a comment queued (openCommentForm's 'editing' argument
      // stamped data-editing-id when it did) REPLACES that entry's anchor/text
      // in place rather than pushing a second, independent one. Keyed by the
      // entry's own stable id (removePendingComment's own reasoning,
      // src/anchor.mjs), never by re-matching the anchor here -- the anchor a
      // submit reads off the form is exactly the one the reopen already
      // matched, and matching again would go wrong the moment two queued
      // comments ever shared an anchor (legal for a whole-block comment).
      var editingId = form.getAttribute('data-editing-id');
      var editing = editingId ? pendingComments.find(function (c) { return String(c.id) === editingId; }) : null;
      if (editing) {
        editing.anchor = anchor;
        editing.text = text;
      } else {
        pendingComments.push({ id: nextPendingId++, blockId: blockId, anchor: anchor, text: text });
      }
      // The whole layer is re-rendered rather than one pin appended, so the
      // provisional numbers stay consistent as more comments queue up behind this
      // one; refreshPins rebuilds the list entries the same way, so editing in
      // place cannot also leave a stray second entry for the same queue item.
      refreshPins(document);
      input.value = '';
      form.removeAttribute('data-editing-id');
      form.classList.remove('open');
      var targetEl = document.querySelector('div#comment-target-' + blockId);
      if (targetEl) targetEl.classList.remove('open');
    });
  });

  // --- element-level anchoring inside an html stage ---------------
  //
  // Nothing to wire here, on purpose: previously, this loop reached into
  // every '.html-stage' frame under 'root' the moment its (real or placeholder)
  // 'contentDocument' became reachable, keyed on document identity to survive
  // the about:blank-then-real-srcdoc swap (see git history for that guard's own
  // reasoning). 'allow-same-origin' is dropped now, so 'contentDocument' is not
  // reachable AT ALL from here any more -- and does not need to be: the stage's
  // OWN agent script (injected by src/render.mjs) posts 'ready' the moment it
  // has attached its own listeners, and this file's single, page-level
  // 'window.addEventListener('message', ...)' (declared once, well above
  // wireRoot -- see its own comment) reacts to that regardless of which root a
  // stage arrived under or when. So a push that inserts a fresh html block needs
  // no anchoring-specific step here at all; wireMermaidBlock below still does,
  // since a mermaid diagram renders into THIS document and has no navigation
  // event of its own to announce readiness with.

  // Bind the expand control on every html stage under
  // this root. Unlike the anchoring wiring above there IS something to do here --
  // the control lives in the block's kicker, in THIS document, so it needs no
  // message from the stage to become bindable.
  qsa('.html-block', root).forEach(function (section) { wireStageExpand(section); });

  wirePageDomPins(root);

  } // end wireRoot

  wireRoot(document);

  // (ADR.md entry 28: the "click a comment's list entry to highlight the heading
  // it is about" gesture lived here, and went with the 'md' anchor kind it was
  // the reading half of -- an element-level comment on a stage or a diagram
  // already carries a numbered pin drawn ON the thing it is about, so there is
  // nothing left for a second, list-side highlight to point at.)

  // Deleting a queued (unsent) comment is delegated from the document: a pending
  // entry can appear at any time after hydrate (queued locally, or -- reopened
  // and re-edited -- rebuilt by refreshPendingCommentItems), so there is no
  // single wireRoot pass that could wire a "delete" button once and for all. A
  // SENT comment's server-rendered entry never carries a '.comment-delete' at
  // all, so this can never reach one.

  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.comment-delete') : null;
    if (!btn || readonly) return;
    ev.preventDefault();
    var item = btn.closest('.comment-item');
    if (!item) return;
    var id = Number(item.getAttribute('data-pending-id'));
    pendingComments = removePendingComment(pendingComments, id);
    refreshPins(document);
    // A form still open, reopened on the entry just deleted
    // instead of resubmitted: close it rather than leaving stale prefilled
    // text that would otherwise queue right back as a brand-new comment.
    var openForm = document.querySelector('.comment-form[data-editing-id="' + id + '"]');
    if (openForm) {
      openForm.removeAttribute('data-editing-id');
      openForm.classList.remove('open');
      var input = openForm.querySelector('input[type=text]');
      if (input) input.value = '';
      var openBlockId = openForm.getAttribute('data-block-id');
      var openTarget = document.querySelector('div#comment-target-' + openBlockId);
      if (openTarget) openTarget.classList.remove('open');
    }
  });

  // --- mermaid: client-side from the CDN, exactly as /visualize does today ---

  // The real MERMAID_TOKEN_MAP module constant above, spliced in by value
  // (JSON.stringify, same discipline as MERMAID_NODE_SELECTOR above) so this
  // is never a second, hand-typed copy that can silently drift from the one
  // test/check-mermaid-theme.mjs actually checks against src/styles.mjs's
  // palettes.
  var MERMAID_TOKEN_MAP = {"primaryColor":"--panel-2","primaryTextColor":"--ink","primaryBorderColor":"--accent","secondaryColor":"--panel-3","tertiaryColor":"--panel","lineColor":"--muted","textColor":"--ink-2","mainBkg":"--panel-2","nodeBorder":"--accent","clusterBkg":"--accent-glow","clusterBorder":"--hairline-2","edgeLabelBackground":"--panel"};

  // Resolved the SAME way src/styles.mjs's own selectors resolve :root's
  // tokens: an explicit data-theme attribute wins outright; absent that, the
  // live OS preference decides. This has to match the CSS exactly, not just
  // approximate it -- it is what mermaid's own 'darkMode' flag (which chooses
  // its light/dark chart internals independently of themeVariables) keys off.
  function isDarkThemeActive() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // The actual cascade result, read fresh every call -- automatically correct
  // for System mode, an explicit override, or any future selector change in
  // src/styles.mjs, with no second place left to keep in sync (see
  // MERMAID_TOKEN_MAP's own comment).
  //
  // A renamed/removed token (MERMAID_TOKEN_MAP naming a
  // custom property src/styles.mjs no longer defines) resolves to '' here,
  // and mermaid's own colour library throws on '' -- unrecoverably, if that
  // throw happens inside initialize() after a destructive restore has
  // already wiped every diagram's source. So this function itself is the
  // validation gate: ANY unresolved mapped token fails the WHOLE call
  // (returns null) rather than handing back a partial palette. Callers below
  // treat null as "not safe to draw with right now" and choose, deliberately,
  // to leave whatever is already on screen alone rather than destroy it for
  // a redraw that cannot succeed -- see runMermaidRedrawPass's own comment
  // for why that reads better than silently defaulting the one bad variable.
  function mermaidThemeVariables() {
    var computed = window.getComputedStyle(document.documentElement);
    var vars = {
      darkMode: isDarkThemeActive(),
      background: 'transparent',
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
      fontSize: '13px',
    };
    for (var key in MERMAID_TOKEN_MAP) {
      if (!Object.prototype.hasOwnProperty.call(MERMAID_TOKEN_MAP, key)) continue;
      var value = computed.getPropertyValue(MERMAID_TOKEN_MAP[key]).trim();
      if (!value) return null;
      vars[key] = value;
    }
    return vars;
  }

  // Every mermaid pass below -- the very first render, a later SSE push's render
  // of newly-inserted nodes, or a theme-triggered redraw -- is queued onto this
  // ONE module-scoped promise chain instead of running the moment it is called.
  // Real mermaid 11 claims a node's data-processed flag and does innerHTML = ''
  // before its own first internal per-node await, so two passes that are merely
  // STARTED (not SETTLED) can write to the SAME node in the same tick, and the
  // newer one ends up parsing the older one's rendered SVG as if it were diagram
  // source ("Maximum text size in diagram exceeded" / "Syntax error in text",
  // permanently, since nothing redraws it again until the NEXT theme change).
  // Queuing makes "started" and "settled" the same event for every caller here:
  // a pass's body does not begin running until every previously queued pass has
  // fully resolved.
  var mermaidQueue = Promise.resolve();
  function queueMermaidTask(fn) {
    var result = mermaidQueue.then(fn, fn);
    // Never let one task's own bug wedge the chain for every task queued
    // after it -- each fn below already narrows its OWN real failures
    // internally (offline, CDN, an unresolved theme token); anything
    // reaching here would be a bug in this file, not mermaid's, and the
    // chain has to keep moving regardless.
    mermaidQueue = result.then(function () {}, function () {});
    return result;
  }

  // The other half, "coalesce redundant redraws": three theme clicks with
  // no settling between them must not run three full redraw passes just
  // because queuing (above) stops them from corrupting each other. Each
  // redrawMermaidForTheme call captures the counter's value BEFORE queuing;
  // the queued task then checks it again once its turn actually comes up --
  // if a NEWER redraw was requested in the meantime, running this one now
  // would only draw a palette the very next queued task immediately
  // overwrites, so it is skipped entirely (the DOM is never touched), and
  // only the LAST requested redraw still matches and actually runs.
  var mermaidRedrawGeneration = 0;

  var mermaidMod = null;
  async function runMermaidRenderPass(root) {
    var nodes = qsa('pre.mermaid', root);
    if (!nodes.length) return;
    // Stash each node's raw diagram source before mermaid ever
    // touches it -- mermaid.run() replaces a node's own content with its
    // rendered SVG, so this is the only point at which the original text is
    // still there to read. runMermaidRedrawPass (below) restores it on every
    // theme switch, since a re-run needs real source to parse, not the SVG
    // (or worse, nothing) left behind by the last render.
    nodes.forEach(function (n) {
      if (mermaidSourceByBlock && !mermaidSourceByBlock.has(n)) mermaidSourceByBlock.set(n, n.textContent);
    });
    try {
      if (!mermaidMod) {
        // PINNED to an exact version, never a floating range. A bare major resolved at
        // request time, so the bytes that ran were whatever 11.x jsdelivr served that day
        // -- and they run in the BOARD PAGE'S OWN ORIGIN, alongside #board-data and under
        // connect-src 'self', so a bad publish could read every answer and submit as the
        // reviewer. Dynamic import() cannot carry an SRI hash, so the version is the only
        // pin available. Bumping it is deliberate work: change it here and in the one
        // allowlist, src/render.mjs's CSP_CLAUSES (both CSP and INDEX_CSP build from it,
        // and its script-src and font-src carry the version) -- which pins the VERSION,
        // not the file: a CSP source expression ending in / is a prefix match, so every
        // file under this package version is in policy, and a compromised jsdelivr could
        // still serve a different one of them. See SECURITY.md on what that leaves open.
        mermaidMod = window.mermaid
          || (await import('https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.esm.min.mjs')).default;
      }
      // Initialize before EVERY run(), not once ever, on
      // whatever mermaidMod already is -- gating this behind "only the first
      // time the engine loads" is exactly how a round that arrives long
      // after the reader switched theme (with no live diagram in between to
      // trigger a redraw) used to get drawn in a palette nobody chose.
      // Mermaid's 'base' theme is the only one that takes themeVariables, so
      // the diagram is drawn from the same tokens as everything around it.
      var vars = mermaidThemeVariables();
      // An unresolved token must not reach initialize -- funnel it
      // through the SAME catch as offline/CDN failure below, so it degrades
      // the same honest way: the source fallback, never a wiped diagram.
      if (!vars) throw new Error('mermaid theme token unresolved');
      mermaidMod.initialize({ startOnLoad: false, theme: 'base', themeVariables: vars });
      await mermaidMod.run({ nodes: nodes, suppressErrors: true });
    } catch (e) { /* offline, CDN failure, or an unresolved theme token: fall through to the source fallback below */ }
    nodes.forEach(function (n) {
      var svg = n.querySelector('svg');
      if (svg) { wireMermaidBlock(n, svg); return; }
      // 'no svg' here is supposed to mean mermaid genuinely
      // could not draw this node (offline/CDN unreachable, or -- under
      // suppressErrors -- mermaid's own error graphic, which IS an <svg> and
      // so already took the branch above). 'data-processed' already true
      // with STILL no svg only happens if some OTHER pass claimed this node
      // and has not finished writing it yet -- impossible now that every
      // pass is serialized through queueMermaidTask above, but kept as an
      // explicit guard rather than an assumption resting entirely on that:
      // never destroy (replaceWith) a node something else is mid-write on.
      // This is the exact site that used to replaceWith() a diagram that HAD
      // rendered out to a '.missing' fallback, permanently invisible to
      // qsa('pre.mermaid', document) forever after.
      if (n.getAttribute('data-processed') === 'true') return;
      var wrap = document.createElement('div');
      wrap.innerHTML = '<p class="missing">mermaid engine unavailable or chart invalid — raw source:</p><pre><code></code></pre>';
      wrap.querySelector('code').textContent = n.textContent;
      n.replaceWith(wrap);
      // still wire pins (lost-styled, since there's no live SVG to position
      // against) so an offline/CDN-unreachable view names what it can't show,
      // rather than rendering nothing for mermaid comments at all. wireMermaidBlock
      // no-ops safely if wrap isn't inside a .mermaid-block section.
      wireMermaidBlock(wrap, null);
    });
  }
  function renderMermaidBlocks(root) {
    return queueMermaidTask(function () { return runMermaidRenderPass(root); });
  }
  renderMermaidBlocks(document);

  // Re-run every diagram already on the page against whatever the
  // NEW active theme's variables are. mermaid.run() silently no-ops on a
  // <pre> it has already marked processed -- its rendered SVG replaced the
  // original source text, so there is nothing left for a second run to read
  // -- which is why runMermaidRenderPass (above) stashes each block's raw
  // source the first time it runs one. Restoring that text and clearing the
  // marker is what makes a second run possible at all; wireMermaidBlock then
  // re-associates the block with whatever <svg> comes out of it (a NEW
  // element, carrying a NEW generated svg id -- see
  // MERMAID_NODE_SELECTOR/parseMermaidDomId's own comments in src/anchor.mjs
  // for why that's fine: a pin's anchor keys on the source-declared node id,
  // recovered from the generated id, never the generated id itself) without
  // stacking a second click listener (isMermaidBlockWired, above).
  async function runMermaidRedrawPass() {
    if (!mermaidMod) return; // never loaded (offline/CDN unreachable) -- nothing live to redraw
    var nodes = qsa('pre.mermaid', document);
    if (!nodes.length) return;
    // Validate BEFORE the destructive restore below -- an unresolved
    // token means this redraw cannot succeed, so the chosen degradation is
    // to abort here and leave every diagram exactly as it is (still themed
    // to the OLD palette) rather than wipe every <pre> back to raw source
    // for a redraw with nothing able to draw it back. The alternative
    // (skip only the one bad variable and let mermaid default it) would
    // silently draw every FUTURE diagram with one wrong colour forever;
    // aborting instead keeps the failure visible as "the diagram didn't
    // retheme" rather than invisible as "one shape is the wrong colour".
    var vars = mermaidThemeVariables();
    if (!vars) return;
    // Only nodes this pass could RESTORE may be handed to run(). An unstashed
    // node is one that appeared after the queue snapshot -- applyRoundPush
    // attaches a new round's <pre class="mermaid"> synchronously, so a redraw
    // already queued when a round lands sees it here with no stash. Rendering it
    // anyway lets the render pass that follows stash its RENDERED SVG TEXT as if
    // it were diagram source, and the next theme switch restores that text into
    // something mermaid cannot parse -- permanently an error graphic, since no
    // later switch recovers it. The render pass owns first-render for those nodes
    // and will stash them correctly; leaving them alone here is what lets it.
    var restorable = [];
    nodes.forEach(function (n) {
      var original = mermaidSourceByBlock && mermaidSourceByBlock.has(n) ? mermaidSourceByBlock.get(n) : null;
      if (original == null) return; // never successfully rendered -- nothing to restore
      n.textContent = original;
      n.removeAttribute('data-processed');
      restorable.push(n);
    });
    if (!restorable.length) return;
    try {
      // Initialize moved INSIDE the try (it used to sit
      // outside it, AFTER the destructive restore above, so a throw here
      // was an unhandled rejection with every diagram already wiped) --
      // belt-and-suspenders alongside the validation above, not a
      // replacement for it.
      mermaidMod.initialize({ startOnLoad: false, theme: 'base', themeVariables: vars });
      await mermaidMod.run({ nodes: restorable, suppressErrors: true });
    } catch (e) { /* a redraw failure leaves the just-restored source in place; the next redraw retries from there */ }
    restorable.forEach(function (n) {
      var svg = n.querySelector('svg');
      if (svg) wireMermaidBlock(n, svg);
    });
    // An OPEN lens is showing a clone of an svg that no longer exists -- and it
    // has to happen after the wireMermaidBlock loop above, not before, so the
    // clone picks up the .cb-anchor-sent stamps that loop puts back on the
    // fresh nodes (inside the lens). See lensRetheme.
    lensRetheme();
  }
  function redrawMermaidForTheme() {
    var myGeneration = ++mermaidRedrawGeneration;
    return queueMermaidTask(function () {
      // Superseded by a newer redraw request before this one's own turn
      // in the queue arrived -- skip it entirely (never touch the DOM), see
      // mermaidRedrawGeneration's own comment above.
      if (myGeneration !== mermaidRedrawGeneration) return;
      return runMermaidRedrawPass();
    });
  }

  // src/theme.mjs's boot script dispatches this on window after EVERY theme
  // state change -- a click on the control, or (that file's own matchMedia
  // listener) a live OS preference change while System is in force. One
  // signal, one handler: this file never has to know which of those two
  // triggered it, only that the active palette may have just changed under an
  // already-rendered diagram.
  //
  // A second job rides the same signal: an html stage is a
  // separate document that no stylesheet of ours reaches (QUIRKS.md "Two
  // stylesheets, one palette"), so the board's one theme control has to PUSH
  // the new value in. Same broadcast handleStageReady and setCommentMode use,
  // so the stage hears one shape from all three; activeTheme resolves the
  // control's three states down to the two a stage can act on. This is what
  // makes the artifact carry no theme control of its own: there is exactly one
  // on the page, and it paints both documents.
  window.addEventListener('cb-theme-change', function () {
    redrawMermaidForTheme();
    broadcastStageMode();
  });

  // Cheap, partial mitigation for pin drift: reposition every pin on a window
  // resize. Does not track an iframe's own internal scroll or its resize-drag
  // handle -- a known, accepted gap rather than full continuous tracking.
  // Resizing the viewport is what makes the header
  // wrap its title differently and change height, so this is also where the band
  // gets re-measured and re-sent.
  window.addEventListener('resize', function () { refreshPins(document); reportStageBand(); });

  // --- the two ways out: Send, and Discuss in chat -----------------------------
  //
  // "Two ways out, plus a wall clock": beside Send the
  // board carries Discuss in chat, which returns the blocked ask() call
  // immediately with whatever is filled in right now and a status telling the
  // agent to stop posting boards. Both buttons post the SAME body to the SAME
  // route, differing only in 'action' (PROTOCOL.md "HTTP surface":
  // POST /api/board/:id/submit { action: 'send'|'discuss', answers, comments }),
  // so Discuss can never collect less than Send would: partial answers are the
  // point, not a degraded second path that drops the note you just typed.
  //
  // Every widget's current value is read generically off data-widget: status is
  // computed here rather than trusted from a prior render, so a question the
  // reviewer never touched comes back explicitly 'unanswered' (never defaulted,
  // never silently dropped), and defer overrides whatever status the widget
  // itself would imply. Only the currently OPEN round's questions are collected —
  // a sent round's blocks are already recorded and their controls are disabled
  // server-side (see src/render.mjs renderRoundSection), so Send can never
  // silently rewrite an answer that already went out.

  function currentAnswer(qid, widget) {
    var raw = selections[qid];
    if (widget === 'multi') {
      var arr = Array.isArray(raw) ? raw : [];
      return { choice: arr.length ? arr : null, answered: arr.length > 0 };
    }
    if (widget === 'text') {
      var t = typeof raw === 'string' ? raw.trim() : '';
      return { choice: t ? raw : null, answered: t.length > 0 };
    }
    if (widget === 'rank') {
      return { choice: touched[qid] ? (raw || null) : null, answered: !!touched[qid] };
    }
    // single, and choose-between-rendered-variants: both are one label picked
    // by clicking a card, so both share this same branch -- see
    // renderVariantChoice/renderSingleChoice (src/render.mjs), which write the
    // identical answer shape for either widget.
    return { choice: raw != null ? raw : null, answered: raw != null };
  }

  // A collision here is SILENT, unlike the board-data one at the top of this
  // script: the handler binds to a '## Send btn' heading instead of the button,
  // and Send just never fires.
  var sendBtn = document.querySelector('button#send-btn');
  var discussBtn = document.querySelector('button#discuss-btn');
  var sendStatus = document.querySelector('span#send-status');
  var sendBar = document.querySelector('div.send-bar');
  var questionsLeftPill = document.querySelector('button#questions-left-pill');

  /** Collect the open round's answers exactly as they stand right now. Shared
   * verbatim by both actions -- Discuss reads the identical surface Send does, so
   * "whatever is filled in" means the same thing either way. */
  function collectAnswers() {
    var answers = [];
    qsa('.round-open .question-block').forEach(function (qb) {
      var qid = qb.getAttribute('data-block-id');
      var widget = qb.getAttribute('data-widget');
      var result = currentAnswer(qid, widget);
      var status = deferred[qid] ? 'deferred' : (result.answered ? 'answered' : 'unanswered');
      answers.push({
        id: qid,
        status: status,
        choice: result.choice,
        note: notes[qid] || '',
      });
    });
    return answers;
  }

  /** The open round's question-blocks that still carry no status, in round
   * order -- the completeness rule (a 'deferred' question is
   * complete; only 'unanswered' is outstanding), read straight off
   * collectAnswers rather than re-derived, so the send guard below can never
   * disagree with what a submit itself would post. Empty once every question
   * has been answered or deferred. */
  function outstandingBlocks() {
    var blocks = qsa('.round-open .question-block');
    var answers = collectAnswers();
    var outstanding = [];
    answers.forEach(function (a, i) {
      if (a.status === 'unanswered') outstanding.push(blocks[i]);
    });
    return outstanding;
  }

  /** Best-known answer to "is the round's own closing rail on screen right now" --
   * written ONLY by setupSendBarDock's own IntersectionObserver callback, below,
   * the exact signal that already docks the send bar (one IntersectionObserver
   * on the closing rail drives both, so the two can never disagree and no
   * scroll handler is introduced). Defaults to false -- "the rail is not on screen" -- matching
   * setupSendBarDock's own pre-report default (no '.docked' class until an
   * intersection actually arrives) and its "no IntersectionObserver at all"
   * fallback (the bar stays permanently floating): both are exactly the state
   * this pill assumes too until told otherwise. */
  var railIntersecting = false;

  /** The pill's own count and label, reusing outstandingBlocks -- the send guard's
   * own single source of truth for what is still outstanding (the
   * count "reaches zero exactly when the send guard would no longer arm"; these
   * two can never disagree, because they read the identical function). Called
   * from every place an answer can change (below) and from setupSendBarDock's
   * callback whenever the rail's on-screen state changes -- the union of the two
   * is "the count or its visibility might now be different". Visible only at a
   * nonzero count AND the rail off screen (never at zero, and gone
   * the moment the rail is on screen); text is the button's own accessible name,
   * so no separate aria-label is needed. */
  function updateQuestionsLeftPill() {
    if (!questionsLeftPill) return;
    var count = outstandingBlocks().length;
    questionsLeftPill.textContent = count + (count === 1 ? ' question left' : ' questions left');
    questionsLeftPill.classList.toggle('visible', count > 0 && !railIntersecting);
  }

  /** The round this page can still submit: the latest round that is still open.
   * Posted with the body so the server can refuse a submit aimed at a round that
   * already went out (409) instead of silently rewriting it.
   *
   * Asked as status === 'open', not status !== 'sent': since ADR 69 a round can also
   * be 'abandoned' -- closed by a conversation that declared a boundary and walked
   * away -- and the server's own openRounds filter (handleSubmit, src/server.mjs)
   * asks it this way, so reading it the other way here would leave the Send bar live
   * on a board whose every submit is a 409. Identical for every board written before
   * that state existed: they carry only 'open' or 'sent'. */
  function openRoundNumber() {
    var n = null;
    (board.rounds || []).forEach(function (r) { if (r.status === 'open') n = r.n; });
    return n;
  }

  // --- rounds are the board's pages -------------------------------------------
  //
  // ADR.md entry 42: a thread keeps its single board and its rounds become that
  // board's pages -- edge chevrons to flip, a pill at the bottom numbering them
  // (full name on hover) and dotting the one that still owes an answer, landing
  // on the newest. Exactly
  // one '.round' section carries 'round-current' and the stylesheet displays
  // only that one, so "which round am I on" is EXPLICIT STATE here, written in
  // one place, rather than a scroll position measured against the header.
  //
  // There is no round-band IntersectionObserver any more: N used to be "the
  // topmost round crossing the sticky header line", measured over a 96px band
  // under the header, and every part of that assumed rounds stack down one
  // scrolling document. A round that fills the viewport does not stack under the
  // round before it -- there is no round before it on screen at all -- so the
  // band has nothing to measure, and the observer is deleted rather than left
  // running against a layout it can no longer describe.
  //
  // Everything that names a round now reads currentRound: the pager's own
  // current entry and its dot, the chevrons' disabled ends, whether <body> is
  // laid out as a page board, whether <body> is a sent page, and whether the
  // send bar may be used at all. refreshPager is the single place that writes
  // them all, and goToRound is the single place that moves currentRound, so
  // they cannot drift out of step with each other.
  var sendBarDockObserver = null;

  /** The page rendered current by the server (renderBoardPage puts the board on
   * its NEWEST round), read back off the document rather than recomputed, so
   * hydrate never disagrees with what was painted. The board.rounds fallback is
   * for a document with no round sections at all. */
  var currentRound = (function () {
    var painted = document.querySelector('.round-current');
    var n = painted ? parseInt(painted.getAttribute('data-round'), 10) : NaN;
    if (isFinite(n)) return n;
    var rounds = board.rounds || [];
    return rounds.length ? rounds[rounds.length - 1].n : 1;
  })();

  /** True while a submit is in flight, so a page flip mid-submit cannot hand the
   * Send button back (setSendBarEnabled is otherwise driven purely by which page
   * you are on). submitBoard owns both edges of this. */
  var submitInFlight = false;

  function roundSectionEl(n) {
    return document.querySelector('.round[data-round="' + n + '"]');
  }

  function roundEntry(n) {
    var found = null;
    (board.rounds || []).forEach(function (r) { if (r.n === n) found = r; });
    return found;
  }

  function blocksOfRound(n) {
    return (board.blocks || []).filter(function (b) { return b.round === n; });
  }

  /** Does this round still owe an answer? Still open AND actually asking something
   * -- the same rule the index badge counts by, which is what
   * keeps the dot off a page-board round: nothing ever sends one, so it is open
   * forever and would otherwise sit there accusing the reviewer of stalling. A round
   * left 'abandoned' by a boundary declaration (ADR 69) is closed too, and owes
   * nothing for the same reason a sent one does not. */
  function roundOwesAnswer(r) {
    if (!r || r.status !== 'open') return false;
    return (board.blocks || []).some(function (b) { return b.round === r.n && b.kind === 'question'; });
  }

  /** Repaint every place a
   * round's countdown or read-only state shows, from 'board.rounds' and this
   * reader's own clock -- '#round-meta' (the page board's own pill/meta slot,
   * for whichever round is CURRENT) and '#round-countdown' (the ordinary send
   * bar's, for whichever round is OPEN, page board or not). Called from
   * refreshPager (every flip and every push), from a periodic tick (so a round
   * left open on screen counts down and can revert on its own, with nobody
   * touching anything), and the instant an 'awaitExpired' SSE push says a
   * round's wait just died (below) -- never later than a real signal saying it
   * happened, which is what AC 12 asks for.
   *
   * Also the one place that ever CORRECTS the render-time decision
   * 'renderPageCommentPanel' (src/render.mjs) made about whether a page round's
   * compose/send surface is live: that function reads only 'roundIsAwaitedOpen'
   * (no clock, so the page stays a pure function of its JSON at render time --
   * see badge.mjs's own header comment), so an open, awaited round whose
   * deadline has ALREADY passed at the moment this runs still rendered the live
   * surface. '.expired' is what downgrades it here, client-side, the moment
   * 'roundIsCurrentlyAwaited' stops agreeing with 'roundIsAwaitedOpen' for the
   * same round -- one-directional by construction (a deadline never
   * un-expires), and it never touches anything already in '.comment-list'
   * ("comments already left stay on screen", AC 12). Locked twice, same
   * discipline as 'body.readonly' (QUIRKS.md): the class hides the surface in
   * CSS, and the disabled sweep just below stops a control that only LOOKS
   * gone from still working. */
  function refreshAwaitDisplay() {
    var now = Date.now();
    // Read once, used by both the uncommentable class below and the pill/meta
    // title just after it -- both need to know whether the round on screen is
    // a page board's or an ordinary one's.
    var fullpage = isPageRound(blocksOfRound(currentRound));
    // ADR.md entry 46's half that outlives the first paint (src/render.mjs's own
    // 'pageUncommentable' is the render-time half): the comment-mode toggle has
    // to go on a page board that was never awaited AND on one whose wait dies
    // while the reviewer is reading it -- so this asks the clock, which is why it
    // lives here rather than in refreshPager (which calls this on every flip
    // anyway, so the class is correct on both routes).
    document.body.classList.toggle('page-uncommentable',
      fullpage && !roundIsCurrentlyAwaited(roundEntry(currentRound), now));
    var meta = document.querySelector('span#round-meta');
    if (meta) {
      // 'fullpage' is what tells pageBoardPillMeta which of PILL_READONLY_TITLE
      // / ROUND_OPEN_UNAWAITED_TITLE is true for the 'read-only' case -- see
      // that function's own comment (src/badge.mjs): a page board's status
      // never leaves 'open' even once its wait dies, so the round object alone
      // cannot make this call.
      var m = pageBoardPillMeta(roundEntry(currentRound), now, fullpage);
      meta.textContent = m.text;
      meta.title = m.title;
    }
    var cd = document.querySelector('span#round-countdown');
    if (cd) {
      var text = roundCountdownText(roundEntry(openRoundNumber()), now);
      cd.textContent = text || '';
      cd.title = text ? ROUND_COUNTDOWN_TITLE : '';
      cd.classList.toggle('visible', !!text);
    }
    qsa('.page-comments', document).forEach(function (panel) {
      if (panel.classList.contains('expired')) return;
      var section = panel.closest('.round');
      var n = section ? parseInt(section.getAttribute('data-round'), 10) : NaN;
      if (!isFinite(n)) return;
      var round = roundEntry(n);
      if (roundIsAwaitedOpen(round) && !roundIsCurrentlyAwaited(round, now)) {
        // Last exit before the freeze. 'pendingComments' lives ONLY in this tab's
        // memory (see its declaration) and the Send control is the only thing that
        // ever moves it to the board, so freezing the control with the queue still
        // in it is the one way a reviewer's typed comments get silently destroyed:
        // they sit on screen looking saved until the tab is reloaded. Flushed
        // first, frozen second -- the payload is captured synchronously inside
        // submitPageRound, so the disable sweep below cannot race it.
        flushPendingOnExpiry(n);
        panel.classList.add('expired');
        qsa('input, button', panel).forEach(function (el) { el.disabled = true; });
        // Frozen, but not mute: the control stays on screen saying where the
        // comments went (badge.mjs's own comment on this label). Set after the
        // disable sweep so it cannot be re-enabled by it.
        var expiredSend = panel.querySelector('.page-send-btn');
        if (expiredSend) {
          expiredSend.textContent = PAGE_SEND_EXPIRED_LABEL;
          expiredSend.title = PAGE_SEND_EXPIRED_TITLE;
        }
      }
    });
    // A page round that just expired must stop offering its click-to-anchor
    // gesture too, even mid-hover -- broadcastStageMode re-tells every wired
    // stage its current allowance the same way any other mode change does.
    broadcastStageMode();
  }

  /** Repaint every control that names a round, from currentRound and 'board'.
   * Called on every flip AND after every push that changes what the rounds are
   * (a new one arriving, an earlier one going sent), so the pager, the body's
   * layout classes and the send bar are always one consistent statement about
   * the same page.
   *
   * Entries are created once and updated in place, never rebuilt wholesale:
   * rounds are only ever appended (src/board.mjs never removes one), and a
   * rebuild would drop keyboard focus out of the control the reviewer is
   * tabbing through.
   *
   * The explicit 'disabled = false' is the pager's carve-out from the read-only
   * hydrate pass at the top of this file, which hard-disables every button on
   * the page: an archive's rounds are pages too, and flipping between them is
   * navigation, not editing (the same carve-out .expand-btn and #theme-toggle
   * already have, made here rather than there because this function has to write
   * these buttons' disabled state anyway). */
  function refreshPager() {
    var rounds = board.rounds || [];
    var nav = document.querySelector('nav#round-pager');
    if (nav) {
      rounds.forEach(function (r) {
        var btn = nav.querySelector('.round-page[data-round="' + r.n + '"]');
        if (!btn) {
          btn = document.createElement('button');
          btn.setAttribute('type', 'button');
          btn.setAttribute('data-round', String(r.n));
          nav.appendChild(btn);
        }
        btn.className = 'round-page'
          + (r.n === currentRound ? ' round-page-current' : '')
          + (roundOwesAnswer(r) ? ' round-page-owed' : '');
        // Numeral on the face, full name as the accessible name and the hover
        // title -- the same split roundPagerMarkup renders at first paint (see
        // roundNumberLabel).
        var full = roundPageLabel(r.n, r.title || '');
        btn.textContent = String(r.n);
        btn.setAttribute('title', full);
        btn.setAttribute('aria-label', full);
        if (r.n === currentRound) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
        btn.disabled = false;
      });
    }
    var caption = document.querySelector('div#round-pager-caption');
    if (caption) {
      var cur = null;
      rounds.forEach(function (r) { if (r.n === currentRound) cur = r; });
      caption.textContent = roundPageLabel(currentRound, (cur && cur.title) || '');
    }
    var rns = rounds.map(function (r) { return r.n; });
    var first = rns.length ? rns[0] : 1;
    var last = rns.length ? rns[rns.length - 1] : 1;
    var prev = document.querySelector('button#round-prev');
    var next = document.querySelector('button#round-next');
    // Disabled at the ends, never hidden: a control that disappears at round 1
    // is a control the reviewer has to find again at round 2.
    if (prev) prev.disabled = currentRound <= first;
    if (next) next.disabled = currentRound >= last;

    // The layout follows the PAGE, not the board (entry 42: "a page-board round
    // is one page, filling the viewport; a question round is another"). This is
    // what lets one thread hold both -- the artifact keeps the full-viewport
    // page it was rendered as, and flipping to the question round puts the
    // ordinary column back with no reload.
    document.body.classList.toggle('page-board', isPageRound(blocksOfRound(currentRound)));

    // "A page already sent is read-only" -- the guarantee the deleted history
    // rail carried. The stylesheet's body.sent-page rules are the visible half;
    // the send bar is the half no round-scoped mechanism can reach, since its
    // buttons live outside every round section (the same gap that once let a
    // double click submit an already-sent round twice -- see setSendBarEnabled).
    var entry = roundEntry(currentRound);
    document.body.classList.toggle('sent-page', !!entry && entry.status === 'sent');
    var open = openRoundNumber();
    if (!submitInFlight) setSendBarEnabled(open !== null && currentRound === open);

    refreshAwaitDisplay();
  }

  /** Flip to round 'n'. The one writer of currentRound.
   *
   * Refuses a round with no section on the page rather than blanking the board:
   * a client that missed a push has a 'board' naming a round its DOM has never
   * held, and the resync (below) is what repairs that.
   *
   * The pins are recomputed because a hidden page is a page with no layout: a
   * stage inside display:none reports a zero-sized box, so a pin drawn while it
   * was hidden is drawn in the wrong place. Same call the resize handler and
   * every push already make, for the same reason.
   *
   * scrollIntoView rather than a bare scroll-to-top: an ordinary round can be
   * taller than the viewport, so arriving at a new page still scrolled halfway
   * down the last one is the one thing that would make a flip feel broken.
   * '.round' carries scroll-margin-top: var(--head-clear), so the arriving page
   * clears the sticky header. Guarded on the method existing at all
   * (test/dom-stand-in.mjs records the call rather than performing it). */
  function goToRound(n, scroll) {
    var section = roundSectionEl(n);
    if (!section) return;
    currentRound = n;
    qsa('.round').forEach(function (s) { s.classList.toggle('round-current', s === section); });
    refreshPager();
    // ADR.md entry 40's chrome belongs to the page that earned it, so it is
    // re-derived here from whatever the page flipped TO last reported -- after
    // refreshPager, which is what puts (or takes) 'page-board' on <body>.
    //
    // Derived, never cleared, and that is the whole fix for the return flip: an
    // arriving page whose stage was left scrolled halfway down comes back at that
    // same offset (a display:none frame keeps its inner scroll and fires no event
    // on re-show -- QUIRKS.md), so a clear-on-flip left the reviewer mid-artifact
    // with an expanded header over the top of it and no way back up until they
    // happened to scroll again. Reading the record instead makes the flip in and
    // the flip out the same computation.
    //
    // Derived here on the flip and NOT in refreshPager: that function is a
    // repaint, called on hydrate and on an SSE catch-up as well as from here, and
    // an earlier version that cleared there wiped the condensed header out from
    // under a reviewer who was still scrolled into the artifact and had not
    // flipped anywhere.
    //
    // refreshCondenseChrome, not refreshStageChrome directly: a flip can land
    // on either board type, and refreshStageChrome
    // alone now only ever answers for a page board -- it deliberately leaves an
    // ordinary board's own '--stage-p' untouched (see its own comment) so a
    // stray stage message cannot fight the document-scroll-driven value. Landing
    // on an ordinary board therefore needs refreshDocumentScrollChrome called
    // instead, or the header would keep whatever condense state the PREVIOUS
    // (page-board) page had earned, floating a pill over a column that has
    // nothing to do with it.
    refreshCondenseChrome();
    // The band belongs to the page just flipped TO, same reasoning as
    // refreshCondenseChrome just above: a page board arriving here needs its
    // stage topped up, and a round that isn't one is simply ignored by
    // reportStageBand's own page-board gate.
    reportStageBand();
    updateQuestionsLeftPill();
    refreshPins(document);
    if (scroll !== false && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  }

  /** One step either way, clamped at both ends. Shared by the chevrons and the
   * arrow keys, so a step means the same thing however it was asked for. */
  function stepRound(delta) {
    var rns = (board.rounds || []).map(function (r) { return r.n; });
    var i = rns.indexOf(currentRound);
    if (i === -1) return;
    var target = rns[i + delta];
    if (target == null) return;
    goToRound(target);
  }

  /** The send bar drops its blur scrim and docks flush
   * the instant the round's own end (.round-end -- at most one on the page, see
   * renderRoundSection's own comment) scrolls into view, and floats over content
   * the rest of the time. An IntersectionObserver on the rail itself, and now
   * the only one on the page: the round badge's own band observer went with the
   * layout it measured (see "rounds are the board's pages" above). This one is
   * untouched by that, because it asks about the round you are ON, which is
   * exactly the round a page shows -- no scroll handler, and the default
   * root/rootMargin/threshold are already what "on screen" means here.
   *
   * Guarded twice, belt and suspenders (QUIRKS.md "Readonly is locked twice"):
   * '.send-bar' is already 'display: none' under body.readonly,
   * but bailing here too means an archive never even constructs the observer.
   * Also guarded on IntersectionObserver existing at all -- test/dom-stand-in.mjs
   * has none (QUIRKS.md "The stand-in has no layout"), and a browser too old to
   * have it should still show a working, permanently-floating send bar rather
   * than throw.
   *
   * Re-run wherever the round set changes: the set of '.round-end'
   * elements on the page changes exactly when the set of '.round' sections
   * does -- a round arriving over SSE adds one, a round collapsing into history
   * (markRoundHistory) removes one. No '.round-end' at all (every round sent,
   * nothing left to reach) leaves the bar in its ordinary floating state.
   *
   * This is also the pill's own
   * signal now: one IntersectionObserver on the closing rail drives both, so
   * the two can never disagree and no scroll handler is introduced. railIntersecting
   * (above) is written ONLY here, and updateQuestionsLeftPill is called on every
   * branch that changes what it should read -- never a second, independent
   * observer, which is the whole point. */
  function setupSendBarDock() {
    if (readonly) return;
    if (!sendBar) return;
    if (typeof IntersectionObserver !== 'function') return;
    if (sendBarDockObserver) sendBarDockObserver.disconnect();
    var rail = document.querySelector('.round-end');
    if (!rail) { sendBar.classList.remove('docked'); railIntersecting = false; updateQuestionsLeftPill(); return; }
    // The viewport's bottom strip is not free space: '.send-bar' is sticky at
    // 'bottom: 0' and drawn over it, so a default-margin observer flips
    // 'docked' the instant the rail's first pixel enters the viewport -- while
    // that pixel is still BEHIND the bar. That window (the bar's own height,
    // measured in Chrome at ~77px) used to be covered by the docked bar's top
    // hairline; it was removed on the grounds that the rail is
    // already a line two rows above, which is only true once the rail has
    // cleared the bar. Shrinking the observer's root by the bar's height is
    // what makes that premise true: 'docked' now means "the rail is on
    // screen AND above the bar", and until then the bar keeps its gradient
    // scrim, which is the treatment for content still running on underneath.
    // Measured at observe time rather than hardcoded, for the same reason
    // '--round-pager-dock-h' is measured: the bar grows a row on narrow
    // windows (the 560px breakpoint near the end of src/styles.mjs).
    var barHeight = Math.round(sendBar.getBoundingClientRect().height);
    sendBarDockObserver = new IntersectionObserver(function (entries) {
      var entry = entries[0];
      var intersecting = !!entry && entry.isIntersecting;
      sendBar.classList.toggle('docked', intersecting);
      railIntersecting = intersecting;
      updateQuestionsLeftPill();
    }, { rootMargin: '0px 0px -' + barHeight + 'px 0px' });
    sendBarDockObserver.observe(rail);
  }

  /** '.page-comments' (a page board's floating comment panel) has to clear
   * '.round-pager-dock', the round pager's fixed bottom-centre box. A
   * ResizeObserver on the dock is the mechanism that survives: it measures the
   * dock's REAL box, independent of where either element sits in the tree, and
   * writes it to '--round-pager-dock-h' (src/styles.mjs's '.page-comments'),
   * which recomputes its 'bottom' every time the property changes -- CSS custom
   * properties are live, so no second call is needed to push the new value into
   * layout. Observed rather than measured once at load, so a change to the dock's
   * own font size, padding or row count carries with it.
   *
   * A number typed into the stylesheet cannot do this: the dock's height changes
   * with its own content ('2379f12' grew it from one row to two and broke exactly
   * that kind of number). CSS anchor positioning ('anchor()') was tried and
   * reverted -- it requires the anchor to precede the positioned element in DOM
   * order, which the dock does not (it renders after '.blocks', and
   * '.page-comments' is nested inside a block within '.blocks'), and it hit a
   * second, separate containing-block failure even after that was worked around:
   * confirmed wrong in a real browser (computed 'bottom: auto'), a class of
   * failure this repo's DOM stand-in cannot see at all (QUIRKS.md "The stand-in
   * has no layout" -- no ResizeObserver either, hence the guard below). */
  function setupPagerDockHeightTracking() {
    var dock = document.querySelector('div.round-pager-dock');
    if (!dock) return;
    // Both writers report the same box. 'contentRect' is the CONTENT box and
    // this measurement is the BORDER box; they agree only while the dock has no
    // padding or border, which is exactly the assumption the comment below
    // refuses to make about its own future ("a future change to the dock's own
    // font size, padding or row count"). A zero is never written: a dock that
    // measures 0 at hydrate (display:none on a board that has not painted it
    // yet) would otherwise replace the stylesheet's 84px fallback with nothing,
    // and on the no-ResizeObserver path nothing would ever correct it.
    function write(h) {
      if (!(h > 0)) return;
      document.documentElement.style.setProperty('--round-pager-dock-h', h + 'px');
    }
    // Measured once here, and only THEN observed -- the same correction
    // measurePillHalf's own wiring carries, for the identical reason: measured in
    // Chrome, a ResizeObserver on an element already laid out and never resized
    // again delivers nothing at all. Without this explicit first measure, a board
    // whose dock loads at its final size (most of them) leaves the property unset
    // for the whole session, and every rule that reads it -- '.page-comments''s
    // clearance and the sent round's own bottom reservation, both in
    // src/styles.mjs -- silently runs on its 84px fallback instead of the real
    // 63.4px. Not a crash: a too-large fallback over-reserves rather than
    // overlapping, so it reads as slightly loose spacing.
    // reportStageBand reads the dock's own box again rather than this property
    // (the stand-in's getComputedStyle cannot see a runtime
    // .style.setProperty write, only a static stylesheet, so the bottom band is
    // measured straight off the element every time, same as write() does here),
    // and is called alongside write() so the two never drift apart on which dock
    // height is current.
    write(dock.getBoundingClientRect().height);
    reportStageBand();
    if (typeof ResizeObserver !== 'function') return;
    // The entry is deliberately unread: its 'contentRect' is the content box,
    // and write() wants the border box on both paths (see its comment). The
    // observer here is a trigger, not a source of the measurement.
    var ro = new ResizeObserver(function () {
      write(dock.getBoundingClientRect().height);
      reportStageBand();
    });
    ro.observe(dock);
  }

  setupSendBarDock();
  setupPagerDockHeightTracking();
  // The page is already painted on the right round (renderBoardPage), so this
  // only brings the CONTROLS up to it -- no flip, no scroll. It is also what
  // re-enables the pager in a read-only archive, after the blanket disable pass
  // at the top of this file (see refreshPager's own comment), and (via
  // refreshAwaitDisplay) fills in the real countdown figure this page's own
  // first paint deliberately left for the client to compute (badge.mjs's
  // header comment on why -- no 'Date.now()' at render time).
  refreshPager();
  // AC 5: an awaited page round opens with comment mode ON, so the reviewer
  // never has to find the toggle first -- the hint inside the empty
  // panel (renderPageCommentPanel, src/render.mjs) is what teaches the
  // click-to-comment gesture instead, since the toggle itself is no longer
  // what reveals it here. 'roundIsCurrentlyAwaited', not merely
  // 'roundIsAwaitedOpen': an already-expired round has nothing to teach the
  // gesture FOR (AC 12 turns it read-only before the reviewer can act on it
  // either way), so this only ever fires for a round that genuinely still has
  // time on the clock. Once only, here at hydrate -- flipping to a DIFFERENT
  // awaited page round later does not re-force the toggle, so a reviewer who
  // deliberately turned it off keeps it off (ADR.md entry 40's own "the mode
  // is switched mid-read, not suspended by the scroll" already makes this the
  // reviewer's own control from here on).
  if (isPageRound(blocksOfRound(currentRound)) && roundIsCurrentlyAwaited(roundEntry(currentRound), Date.now())) {
    setCommentMode(true);
  }
  // A round left open on screen
  // has to count down and can revert to read-only entirely on its own, with
  // nobody touching anything -- the periodic half of refreshAwaitDisplay,
  // beside the flip-triggered call in refreshPager and the 'awaitExpired' SSE
  // nudge below. Skipped in a read-only archive: there is no live board for
  // any of this to change. 'unref'd, same discipline as
  // src/pomodoro.mjs's own timer and src/server.mjs's SSE heartbeat -- a
  // lingering interval must never be the reason an in-process check's node
  // process fails to exit on its own (a real browser has no 'unref', so the
  // guard is a no-op there and the interval just runs).
  if (!readonly) {
    var awaitTickTimer = setInterval(refreshAwaitDisplay, 20000);
    if (awaitTickTimer && typeof awaitTickTimer.unref === 'function') awaitTickTimer.unref();
  }

  // The three round controls, all wired to the same two functions. The pill is
  // delegated at the <nav> rather than per entry, so an entry created later by
  // refreshPager (a round arriving over SSE) is live the moment it exists,
  // with no second wiring pass and no chance of a double-registered listener.
  var roundPrevBtn = document.querySelector('button#round-prev');
  var roundNextBtn = document.querySelector('button#round-next');
  if (roundPrevBtn) roundPrevBtn.addEventListener('click', function () { stepRound(-1); });
  if (roundNextBtn) roundNextBtn.addEventListener('click', function () { stepRound(1); });
  var roundPagerNav = document.querySelector('nav#round-pager');
  if (roundPagerNav) {
    roundPagerNav.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.round-page') : null;
      if (!btn) return;
      var n = parseInt(btn.getAttribute('data-round'), 10);
      if (isFinite(n)) goToRound(n);
    });
  }

  /** Go to the round that still needs an answer -- now a page flip, not a
   * scroll (ADR.md entry 42). Inert exactly when that page is already the one
   * showing, and inert when nothing is open at all (every round already sent,
   * nothing left to go to).
   *
   * Shared by arrival from the index (below) -- the banner's own click target
   * is a DIFFERENT function, jumpToStrandedRound (further below), because it
   * wants a different round (criterion 12: the oldest still awaited, not the
   * latest unsent one this one names). Both exist for the same reason: each is
   * the reviewer saying "take me to the thing that needs an answer", just
   * naming a different "thing". One implementation per meaning, so neither can
   * drift into disagreeing with itself about where that is -- and this one
   * routes through goToRound, so it cannot drift from the pager either.
   *
   * ADR.md entry 42: the header's own round badge used to be a third caller,
   * deferring to this same function on click rather than navigating on its
   * own -- the badge is gone, and this function stays
   * exactly as it was for its remaining caller. */
  function jumpToOpenRound() {
    var target = openRoundNumber();
    if (target == null || target === currentRound) return;
    goToRound(target);
  }

  // Arriving from the index, whose live rows link to '#open-round'
  // (src/indexpage.mjs): land on the round that still needs an answer rather
  // than on round 1 of a thread the reviewer has already answered most of. A
  // sentinel resolved here, not a native fragment jump to a per-round id --
  // markdown blocks are snapshotted from arbitrary files and their headings mint
  // ids on this very page (test/check-archive-ids.mjs), so no id this page emits
  // for its own structure is safe to navigate by. Inert when nothing is open, and
  // inert when the open round is ALREADY the page showing (jumpToOpenRound's own
  // guard) -- which since a board opens on its newest round is now the ordinary
  // case, the open round usually being the newest. Read defensively: location is
  // whatever scope the script runs in supplies, and a hash-less stand-in
  // (test/dom-stand-in.mjs) must not throw here.
  //
  // Deferred past 'load' and one frame, NOT run inline here, which is where this
  // first shipped and did nothing at all: a module script runs before the
  // document finishes loading, and the browser's own post-load scroll
  // positioning for the navigation then overwrites whatever the page scrolled
  // itself to. Verified in Chrome against a three-round board -- inline, the page
  // sat at the top with the badge still reading "round 1 of 3"; the identical
  // scrollIntoView issued after load lands on round 3 every time. The frame is
  // what keeps the smooth scroll (src/styles.mjs: html { scroll-behavior:
  // smooth }) from being started and immediately cancelled by that same
  // positioning pass. Both fallbacks matter for the DOM stand-in, which has
  // neither requestAnimationFrame nor a load event: there, the jump simply
  // happens straight away.
  function jumpToOpenRoundAfterPaint() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(jumpToOpenRound);
    else jumpToOpenRound();
  }
  if (location && location.hash === '#open-round') {
    if (document.readyState === 'complete') jumpToOpenRoundAfterPaint();
    else window.addEventListener('load', jumpToOpenRoundAfterPaint);
  }

  /** The banner's own click target -- by design it resolves to the oldest
   * round still waiting at the moment it is clicked. Deliberately NOT openRoundNumber() -- that names the LATEST
   * unsent round, which is right for '#open-round' (arriving from the index)
   * and for what this page can still submit, but wrong here: a lapsed round
   * must never outrank an older one still genuinely awaited, and 'sent' vs
   * 'not sent' is not the same question as 'awaited' at all (a page round can
   * be unsent and still not awaited, ADR.md entry 35). Walks ascending
   * board.rounds and returns the FIRST match, so it is the oldest by
   * construction, reading roundIsAwaited -- the same predicate markPendingRound
   * gates the tab mark on -- off the live 'board' SSE keeps current, so a
   * click landing on a tab that has been open and pushing to in the
   * background resolves against whatever is awaited right now, not whatever
   * was awaited when the banner first fired. */
  function oldestAwaitedRoundNumber() {
    var rounds = board.rounds || [];
    var now = Date.now();
    for (var i = 0; i < rounds.length; i++) {
      // roundIsCurrentlyAwaited, NOT roundIsAwaited: the bare flag is write-once
      // in the only direction that matters here, because applySubmit
      // (src/board.mjs) stamps 'status: sent' on an answered round and leaves
      // 'awaited: true' standing. Reading the flag alone therefore resolved this
      // click to the first round the reviewer had ALREADY ANSWERED, on every
      // board past its first exchange -- which is every board this feature is
      // for. This is the same predicate the countdown and the send surface read
      // (roundIsAwaitedOpen plus a live deadline), so the page cannot disagree
      // with itself about which round is waiting; and it is what the daemon's own
      // waitingRounds (src/badge.mjs) asks, so the click lands on the round the
      // banner was raised about rather than on some earlier one.
      if (roundIsCurrentlyAwaited(rounds[i], now)) return rounds[i].n;
    }
    return null;
  }

  function jumpToStrandedRound() {
    var target = oldestAwaitedRoundNumber();
    if (target == null || target === currentRound) return;
    goToRound(target);
  }

  function jumpToStrandedRoundAfterPaint() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(jumpToStrandedRound);
    else jumpToStrandedRound();
  }

  // '#stranded-round': the daemon's banner click, distinct from '#open-round'
  // (src/indexpage.mjs's live rows, above) so that sentinel's own "latest
  // unsent round" meaning is untouched -- src/notify.mjs and bin/notify.m
  // compose the URL this reads.
  //
  // Checked from four edges, not just 'load' the way '#open-round' is: the
  // commonest stranded shape is a hidden-but-CONNECTED tab, so the click is a
  // same-document fragment change on a tab that is already open -- no 'load'
  // fires at all, only 'hashchange'. And a second click landing while the tab
  // is still sitting at this exact hash from an earlier one is not even a
  // navigation the browser reports -- revealing an already-frontmost-URL tab
  // is silent, hash unchanged, no 'hashchange' either -- so this also rides
  // 'visibilitychange' and 'focus', below, the two edges that mean the
  // reviewer just arrived (not 'blur', which means the opposite).
  // The hash is consumed (cleared, no navigation) the instant it is read, so
  // an ordinary LATER refocus -- the reviewer having since navigated on their
  // own -- can never re-trigger the jump and steal it back; and because it is
  // cleared, a genuine follow-up click reusing the same literal hash value is
  // once again a real change from the browser's point of view, so it is
  // detected the same way the first one was.
  function maybeJumpToStrandedRound() {
    if (!location || location.hash !== '#stranded-round') return;
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', location.pathname + location.search);
    } else {
      location.hash = '';
    }
    jumpToStrandedRoundAfterPaint();
  }
  if (location && location.hash === '#stranded-round') {
    if (document.readyState === 'complete') maybeJumpToStrandedRound();
    else window.addEventListener('load', maybeJumpToStrandedRound);
  }
  window.addEventListener('hashchange', maybeJumpToStrandedRound);

  /** Enable/disable BOTH send-bar buttons together. They live in .send-bar,
   * outside any round section, so markRoundHistory (which disables everything
   * inside the round it collapses) never reaches them -- that is precisely how a
   * plain double-click used to submit an already-sent round a second time,
   * duplicating its comments and their pin numbers. Never re-enables anything in
   * readonly mode, where every control is hard-disabled at hydrate.
   *
   * And never on a PAGE-BOARD page (ADR.md entry 35: a rendered page is a thing
   * you read, not a form you submit). The stylesheet hides the whole bar there
   * ('body.page-board .send-bar'), which is why the markup keeps it at all -- a
   * comment queued on the artifact rides the next round's submit, and that round
   * is a page next door, not a reload -- but hiding a control is not disabling
   * one, and the two mechanisms are exactly as independent here as QUIRKS.md
   * ("Readonly is locked twice") records them being for body.readonly. Left to
   * CSS alone, the document-level Cmd/Ctrl+Enter handler (which gates on this
   * button's own 'disabled' and nothing else) reached a hidden but perfectly
   * live Send: one chord closed the artifact's round and flushed every queued
   * comment into a submit no agent was waiting on. Fixed HERE rather than in
   * that handler because "a page board is not sendable" is a property of the
   * page, so every route to Send -- the chord, a forced press on the hidden
   * button, a future control that calls submitBoard -- has to meet it, not just
   * the one route the defect was found through.
   *
   * Narrow on purpose: it is the PAGE that refuses, not the board. A thread
   * whose first round is an artifact and whose second asks something has one
   * page of each (entry 42), and refreshPager calls this on every flip, so
   * flipping to the question page hands Send straight back. */
  function setSendBarEnabled(on) {
    if (readonly) return;
    if (on && isPageRound(blocksOfRound(currentRound))) on = false;
    if (sendBtn) sendBtn.disabled = !on;
    if (discussBtn) discussBtn.disabled = !on;
  }

  /** One submit path, one fetch, parameterised by action ('send' | 'discuss') --
   * never two divergent copies of the body-building code. Both buttons go
   * disabled for the duration and STAY disabled once the round has gone out; only
   * a genuine failure (or a new round arriving over SSE) re-enables them.
   *
   * The page-board refusal is repeated here, one line, rather than trusted to
   * the disabled button setSendBarEnabled leaves behind: this is the only
   * function that posts, so a route that reaches it without going through the
   * button's state at all -- a forced press on a disabled control, a future
   * caller, a push path that re-enables the bar before refreshPager corrects it
   * -- still cannot send an artifact's round. Both gates stay independently
   * checked (test/check-page-board.mjs asserts the button IS disabled as well as
   * that nothing posts), so neither can quietly carry the other. */
  function submitBoard(action) {
    if (readonly) return;
    if (isPageRound(blocksOfRound(currentRound))) return;
    var answers = collectAnswers();
    setSendBarEnabled(false);
    // Held until the response lands, so that flipping to another page and back
    // mid-flight cannot hand the button back (refreshPager enables the bar
    // purely from which page you are on, and would otherwise re-arm a submit
    // that is already in the air).
    submitInFlight = true;
    if (sendStatus) sendStatus.textContent = action === 'discuss' ? 'Handing over to chat...' : 'Sending...';
    fetch('/api/board/' + boardId + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, round: openRoundNumber(), answers: answers, comments: pendingComments }),
    }).then(function (r) {
      // 409 is not an error: it means this round was already sent (a second tab,
      // or a double click that beat the disable). The right response is the same
      // as a success -- stop offering to send it again -- not a red error the
      // reviewer will try to clear by clicking Send once more.
      if (r.status === 409) return { alreadySent: true };
      if (!r.ok) throw new Error('submit failed: ' + r.status);
      return r.json();
    }).then(function (result) {
      submitInFlight = false;
      if (result && result.alreadySent) {
        // A 409 stored NOTHING (src/board.mjs refuses the submit outright), so
        // every queued comment is still unsent and is KEPT here, pins and list
        // entries untouched, with the reviewer told they still have them:
        // pendingComments lives only in this page's memory, so emptying it on a
        // refusal would destroy every one of them with no undo and no copy
        // anywhere.
        //
        // The send bar stays disabled, which is the same call the success path
        // makes and for the same reason: this round is out, and re-enabling
        // would only offer a button whose next press earns another 409. What
        // actually re-enables it is a NEW round arriving -- applyRoundPush's
        // own setSendBarEnabled(openRoundNumber() !== null) -- which is exactly
        // the moment the preserved queue becomes sendable again. The tab's
        // pending mark is left alone too: it counts rounds not yet read, which
        // a refused submit says nothing about.
        if (sendStatus) {
          sendStatus.textContent = pendingComments.length
            ? 'Already sent by another tab — nothing was submitted. Your '
              + pendingComments.length + ' queued comment(s) are still here and will go with the next round.'
            : 'Already sent.';
        }
        return;
      }
      // Queue emptied first, then the pin layers re-rendered: from here the pins
      // come from board.comments alone, so the provisional ones are replaced
      // rather than joined by the server-numbered copies of the same comments.
      pendingComments = [];
      refreshPins(document);
      clearPendingMark();
      if (sendStatus) {
        sendStatus.textContent = action === 'discuss' ? 'Handed over to chat.' : 'Sent.';
      }
      // Deliberately NOT re-enabled here: the round is out.
    }).catch(function (err) {
      submitInFlight = false;
      if (sendStatus) sendStatus.textContent = 'Error: ' + err.message;
      setSendBarEnabled(true);   // nothing went out -- the reviewer must be able to retry
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      if (readonly) return;
      // Already armed (by this click path or by Cmd+Enter -- one shared
      // sendArmed flag, see "Cmd+Enter board traversal" below): this press IS
      // the confirmation, identically to a second chord. Submit unconditionally,
      // with no re-check of what is still outstanding -- an armed button always
      // means "send what's here now", the same contract the keyboard path
      // already has.
      if (sendArmed) {
        disarmSend();
        submitBoard('send');
        return;
      }
      // A 'deferred' question is complete, only an
      // 'unanswered' one is outstanding -- and an outstanding question arms
      // the button instead of sending. Reuses collectAnswers's own rule via
      // outstandingBlocks, so this can never drift from what submitBoard is
      // about to post.
      var outstanding = outstandingBlocks();
      if (outstanding.length) {
        armSendGuard(outstanding);
        return;
      }
      submitBoard('send');
    });
  }
  if (discussBtn) {
    discussBtn.addEventListener('click', function () {
      if (readonly) return;
      submitBoard('discuss');
    });
  }

  /** The queue's last chance to leave the tab, called on the transition into
   * '.expired' and nowhere else. A no-op unless this round actually holds
   * queued comments, so an expiring page nobody wrote on stays a pure display
   * change and posts nothing. The submit itself is the ordinary one: it stores
   * the comments and closes the round, and because the round is no longer
   * awaited by then, 'drainUndeliveredComments' (src/server.mjs) is what carries
   * them to the next agent that asks -- AC 12's "ride the thread's next packet",
   * now that a lapsed round stops swallowing its own comments.
   *
   * ponytail: this needs the tab to be open at the deadline. Comments typed into
   * a tab that is closed (or a laptop asleep) before it passes were never
   * anywhere but that tab's memory and are gone either way -- this does not make
   * that worse, and the upgrade path, if it ever bites, is the same flush on
   * 'beforeunload'/'visibilitychange' rather than a durable client-side queue. */
  function flushPendingOnExpiry(roundN) {
    var blocks = blocksOfRound(roundN);
    if (!isPageRound(blocks)) return;
    var id = blocks[0].id;
    if (!pendingComments.some(function (c) { return c.blockId === id; })) return;
    submitPageRound(roundN, 'send');
  }

  /** The awaited page's own Send/Discuss --
   * submitBoard's analogue for a page round, deliberately never sharing that
   * function's path. submitBoard refuses outright on a page round (ADR.md
   * entry 35: "a page board is not sendable" through the ordinary send bar)
   * and always names openRoundNumber(), the LATEST unsent round -- wrong for
   * an awaited page round that is not the latest, exactly the gap ticket 01
   * left for this one: "the browser's own Send control ... still assumes a
   * single submittable round ... 03 is free to give an awaited page round's
   * Send control its own correct round number rather than whatever the
   * single latest-open number is". 'roundN' is read off the button's own
   * 'data-round' (baked in at render time by renderPageCommentPanel,
   * src/render.mjs), never derived from which page happens to be current.
   *
   * Comments are filtered to THIS round's own block before posting:
   * 'pendingComments' is one flat, board-wide queue, and bundling every
   * pending comment into every submit -- what submitBoard itself still does,
   * unchanged and out of this ticket's scope -- would misfile a comment left
   * on a DIFFERENT open round under this one's number the moment two rounds
   * are genuinely open at once (ticket 01's "a board can hold two open rounds
   * at once"). A page round carries exactly one block, so "this round's own
   * comments" and "this block's own comments" are the same set -- whatever is
   * left over stays queued, exactly the AC 12 promise ("comments already left
   * stay on screen and ride the thread's next packet") for a comment on some
   * OTHER round that has not gone out yet either. */
  function submitPageRound(roundN, action) {
    if (readonly) return;
    var round = roundEntry(roundN);
    if (!round || round.status !== 'open') return;
    var blocks = blocksOfRound(roundN);
    if (!isPageRound(blocks)) return;
    var blockId = blocks[0].id;
    var mine = pendingComments.filter(function (c) { return c.blockId === blockId; });
    var section = roundSectionEl(roundN);
    var pageSendBtn = section && section.querySelector('.page-send-btn');
    var pageDiscussBtn = section && section.querySelector('.page-discuss-btn');
    // Disabled the instant the click lands, before the round trip even starts
    // -- the same reason submitBoard's own setSendBarEnabled(false) runs
    // before its fetch, so a double click (or a click during a slow network)
    // can never fire this twice.
    if (pageSendBtn) pageSendBtn.disabled = true;
    if (pageDiscussBtn) pageDiscussBtn.disabled = true;
    fetch('/api/board/' + boardId + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, round: roundN, answers: [], comments: mine }),
    }).then(function (r) {
      // 409: already sent, by another tab or a double click that beat the
      // disable above -- not an error, and the live 'submitted' push (already
      // on its way, or this thread's next resync) is what settles the
      // surface, exactly submitBoard's own reasoning for the identical case.
      if (r.status === 409) return { alreadySent: true };
      if (!r.ok) throw new Error('submit failed: ' + r.status);
      return r.json();
    }).then(function (result) {
      if (result && result.alreadySent) return;
      pendingComments = pendingComments.filter(function (c) { return c.blockId !== blockId; });
      refreshPins(document);
      clearPendingMark();
    }).catch(function () {
      // Nothing went out -- hand the controls back so the reviewer can retry,
      // the same recovery submitBoard's own catch performs. Except on a panel
      // that has since frozen (the flush-on-expiry path above): there the round
      // is over, retrying is not on offer, and re-enabling would leave a control
      // that CSS has already hidden still live to a keyboard -- exactly the
      // "locked twice" rule QUIRKS.md states for every other read-only surface.
      var frozen = section && section.querySelector('.page-comments.expired');
      if (frozen) return;
      if (pageSendBtn) pageSendBtn.disabled = false;
      if (pageDiscussBtn) pageDiscussBtn.disabled = false;
    });
  }

  // Delegated at the document, the same idiom the round pager's own nav uses
  // (and for the same reason): a page round's send control can arrive well
  // after hydrate (a fresh awaited page round pushed over SSE), and delegation
  // means it is live the instant it exists, with no second wiring pass and no
  // chance of a double-registered listener.
  document.addEventListener('click', function (ev) {
    if (readonly || !ev.target || !ev.target.closest) return;
    var sendBtn3 = ev.target.closest('.page-send-btn');
    if (sendBtn3) {
      var n1 = parseInt(sendBtn3.getAttribute('data-round'), 10);
      if (isFinite(n1)) submitPageRound(n1, 'send');
      return;
    }
    var discussBtn3 = ev.target.closest('.page-discuss-btn');
    if (discussBtn3) {
      var n2 = parseInt(discussBtn3.getAttribute('data-round'), 10);
      if (isFinite(n2)) submitPageRound(n2, 'discuss');
    }
  });

  // --- Cmd+Enter board traversal, and the Send guard --------------------------
  //
  // A single document-level keydown listener is the whole keyboard path through
  // a board -- there was none before this. Plain Enter is deliberately left
  // alone everywhere: both textareas on a board (the answer box for a 'text'
  // widget, and every question's note field) legitimately take newlines, so
  // only the modified chord (meta or ctrl -- no platform detection, that exact
  // test on every platform) is ever intercepted.
  //
  // Arriving at Send -- on the button itself, on the last question, or on a
  // round with no question blocks at all -- reads outstandingBlocks() and
  // does exactly what a mouse click on Send would do with that same answer:
  // nothing outstanding sends on that press, no relabel, no second press;
  // anything outstanding arms with the click guard's own
  // treatment (armSendGuard below) -- scroll, ring, label, Escape, all
  // identical to a click. The keyboard path never re-derives "outstanding"
  // itself, so it can never disagree with what submitBoard or the click guard
  // see. Escape disarms without sending. Discuss has no keyboard path at all:
  // it ends board posting for the whole session and is irreversible, so it
  // stays mouse-only by design.
  //
  // Advance always targets the NEXT question's note field, never "the next
  // unanswered one" -- a key that jumps a different distance depending on
  // invisible state is worse than a predictable one.
  //
  // sendArmed is shared with the plain mouse click on Send (see the sendBtn
  // listener above, which calls armSendGuard/disarmSend below) -- one flag,
  // one arm (armSendGuard), one way out (disarmSend), reached from either
  // input. There used to be a second, keyboard-only arm (armSend, "you're
  // done, confirm") that fired unconditionally on arrival regardless of what
  // was outstanding -- deleted along with its label:
  // arriving at Send now always means what a click on Send means.

  var sendArmed = false;
  var sendOriginalLabel = sendBtn ? sendBtn.textContent : '';
  var flaggedBlock = null; // the outstanding question-block armSendGuard rang, if any

  /** Scrolls to and rings the first outstanding question (outstanding[0],
   * already in round order -- see outstandingBlocks) and relabels Send with
   * the count and its warning treatment, correctly singular at exactly one.
   * The one arm the page has: reached from a mouse click on Send and from
   * Cmd+Enter arriving at Send, identically either way. Never called with an
   * empty outstanding array -- both callers only reach here when there is
   * something to flag. */
  function armSendGuard(outstanding) {
    if (!sendBtn) return;
    flaggedBlock = outstanding[0];
    flaggedBlock.classList.add('flagged');
    if (flaggedBlock.scrollIntoView) flaggedBlock.scrollIntoView({ block: 'center' });
    sendBtn.classList.add('warn');
    var n = outstanding.length;
    sendBtn.textContent = n + (n === 1 ? ' question unanswered' : ' questions unanswered') + ' — send anyway?';
    sendBtn.focus();
    if (sendStatus) sendStatus.textContent = 'jumped to the first unanswered';
    sendArmed = true;
  }

  function disarmSend() {
    if (!sendBtn) return;
    sendBtn.textContent = sendOriginalLabel;
    sendArmed = false;
    if (flaggedBlock) {
      // Guards a disarm fired when nothing was actually armed (e.g. Escape
      // on an unarmed board) -- armSendGuard is the only arm left, and it
      // always sets flaggedBlock in the same call that sets sendArmed.
      sendBtn.classList.remove('warn');
      flaggedBlock.classList.remove('flagged');
      flaggedBlock = null;
      if (sendStatus) sendStatus.textContent = '';
    }
  }

  /** Focus a question block's note field and bring it on screen -- the same
   * guarded scrollIntoView shape goToRound above already uses, so a DOM
   * stand-in with no scrollIntoView at all still runs this without throwing. */
  function focusNoteField(block) {
    var el = block && block.querySelector ? block.querySelector('[data-note-for]') : null;
    if (!el) return;
    el.focus();
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }

  /** Put a question block's own TOP on screen and move focus there -- the
   * pill's landing, deliberately not focusNoteField. A note field sits at the
   * END of its question, so focusing it scrolls the reviewer PAST the very
   * question they asked to be taken to: a block with a long context column puts
   * that field most of a screen below the question's first line, and the pill
   * then reads as "jump to the comment box". The block's own top is the thing
   * the reviewer was promised, and .question-block's scroll-margin-top clears
   * the sticky header so 'start' does not park it behind the chrome.
   *
   * tabindex is set here rather than in the rendered markup because this is the
   * only path that focuses a block: '-1' keeps it out of the Tab order while
   * making it a legal script-focus target (the ordinary skip-link shape), so
   * keyboard and screen-reader users continue from the question instead of from
   * the pill they left. focus takes preventScroll so the browser's own
   * bring-focus-on-screen cannot undo the alignment scrollIntoView just asked
   * for -- both guarded the same way focusNoteField's scrollIntoView is, so a
   * DOM stand-in missing either method still runs this without throwing. */
  function goToQuestion(block) {
    if (!block) return;
    block.setAttribute('tabindex', '-1');
    if (block.scrollIntoView) block.scrollIntoView({ block: 'start' });
    if (block.focus) block.focus({ preventScroll: true });
  }

  /** The pill's click target is
   * the send guard's target, not a second notion of 'next question' -- the exact
   * same outstandingBlocks()[0] armSendGuard flags, but landed on the way
   * goToQuestion above describes rather than armSendGuard's own scroll-and-ring:
   * the pill leaves the guard alone entirely (never touches sendArmed, the
   * 'warn' class or send-status), it only moves the reviewer there. Gated on
   * commentMode like every other action-taking control wireRoot wires -- see the
   * single/multi/defer handlers above -- so a click meant to anchor a comment can
   * never also be read as "go answer this". */
  if (questionsLeftPill) {
    questionsLeftPill.addEventListener('click', function () {
      if (readonly || commentMode) return;
      var outstanding = outstandingBlocks();
      if (!outstanding.length) return;
      goToQuestion(outstanding[0]);
    });
  }

  document.addEventListener('keydown', function (ev) {
    // Flip a page with the arrow keys -- the chevrons' keyboard twin (ADR.md
    // entry 42). Nothing else on this page handles an arrow key, so this
    // collides with nothing; what it DOES need is the guard nothing here has
    // needed before, since every other document-level key this file handles is
    // either Escape or modified. An unmodified ArrowLeft in a textarea is the
    // caret moving, not a page flip, so a key landing in a field is left alone
    // -- read off the target's own tag rather than a selector, so no DOM
    // stand-in's selector engine is in the path of a correctness guard.
    // Modified arrows are the platform's (browser back/forward, word-wise
    // motion, extend-selection) and are never intercepted.
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
      var focused = ev.target;
      var tag = focused && focused.tagName ? String(focused.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (focused && focused.isContentEditable) return;
      // An open lens is a modal reading of ONE block, and a flip underneath it
      // swaps the page that block belongs to while the reviewer is still looking
      // at it. showModal() does not stop a key bubbling to the document -- this
      // file already relies on that for the lens's own Escape handler ("a press
      // with focus anywhere in the parent document counts"), and showModal puts
      // focus on the lens's close <button>, which sails straight through the tag
      // guard above. Refuse rather than close: the arrow key is the reviewer
      // reading, not the reviewer leaving, and no flip path closes a lens.
      if ((lens && lens.open) || (stageLens && stageLens.open)) return;
      stepRound(ev.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (ev.key === 'Escape') {
      if (sendArmed) disarmSend();
      return; // not swallowed -- Escape has no other job on this page yet, but nothing here owns it either
    }
    if (ev.key !== 'Enter') return;
    if (!ev.metaKey && !ev.ctrlKey) return; // plain Enter is never intercepted, anywhere
    if (readonly) return; // no keyboard path at all in a read-only file:// archive
    // One guard covers two cases: no send button, or it disabled -- which is
    // true both when no round is open (the send bar starts disabled there)
    // and mid-submit (submitBoard's first act is setSendBarEnabled(false), so
    // a second chord mid-flight cannot double-send).
    if (!sendBtn || sendBtn.disabled) return;
    var target = ev.target;
    // Discuss is mouse-only by design -- it ends board posting for the whole
    // session and is irreversible, so no keyboard path may reach it.
    //
    // preventDefault is what actually enforces that, and returning bare here
    // was a real hole: #discuss-btn is a genuine
    // <button>, and a browser's default action for Enter on a focused button
    // is to ACTIVATE it -- held modifiers do not suppress that the way they
    // change an <a href>'s behaviour. So a bare return handed the chord
    // straight back to the platform, which fired the button's own click
    // listener and posted submitBoard('discuss'): the exact irreversible
    // keyboard path this guard exists to forbid. The DOM stand-in cannot see
    // this (it does not model native activation at all -- see its own header),
    // so test/check-enter.mjs pins the guard's defaultPrevented instead.
    if (target && target.closest && target.closest('button#discuss-btn')) {
      ev.preventDefault();
      return;
    }

    if (sendArmed) {
      disarmSend();
      ev.preventDefault();
      submitBoard('send');
      return;
    }

    ev.preventDefault(); // every branch below either arrives at Send or moves focus -- never leave the chord to the textarea
    var blocks = qsa('.round-open .question-block'); // the exact set, exact order, collectAnswers itself walks
    var arrived = (target && target.closest && target.closest('button#send-btn')) || blocks.length === 0;
    if (!arrived) {
      var current = target && target.closest ? target.closest('.question-block') : null;
      var idx = current ? blocks.indexOf(current) : -1;
      if (idx === -1) {
        focusNoteField(blocks[0]);
        return;
      }
      if (idx !== blocks.length - 1) {
        focusNoteField(blocks[idx + 1]);
        return;
      }
      // The last question falls through to the same "arrived at Send" rule.
    }
    var outstanding = outstandingBlocks();
    if (outstanding.length) {
      armSendGuard(outstanding);
    } else {
      submitBoard('send');
    }
  });

  // --- "Open once, then badge" ------------
  //
  // The tab is opened exactly once, for a thread's first board; every later round
  // arrives over SSE into that same tab, so the page itself has to be what tells
  // the reviewer something new landed. A page-side mark that never steals focus
  // (the whole reason the tab is not reopened): the page's own amber tile
  // carrying a bold ink numeral for how many rounds are owed, drawn onto a
  // data-URI favicon. The notification that used to fire alongside it, for a
  // hidden or unfocused tab, is gone -- the daemon raises that banner now
  // (ADR.md entry 58), reading the same visibility/focus edges via the attended
  // report just below, so the favicon stays the tab's own silent glance.
  // The title used to carry a "(n) " prefix too; it doesn't any more -- a numeral
  // already sitting in the tab mark makes that case weaker, not stronger, so
  // document.title is just left alone.
  //
  // Every part degrades silently and never blocks: no canvas, a throw from it
  // leaves the round pushed and the page working, just unmarked. All of it is
  // inert in readonly mode -- there is no SSE connection there to push a round
  // in the first place, and every entry point below returns early on 'readonly'
  // anyway, so the standalone file:// archive never draws a mark.

  var pendingRounds = 0;
  var faviconLink = null;
  var baseFavicon = null;

  /** Draw the pending mark as a data URI: the SAME amber tile the page's own
   * unmarked mark uses (src/styles.mjs's MARK_SHAPES -- same fill, same rx 9
   * corner), carrying a bold ink numeral. No state paints a second tile colour;
   * ink mass, not a colour swap, is what peripheral vision reads at 16px in a
   * tab that is by definition unfocused. Canvas, not a file: PROTOCOL.md's
   * zero-dependency / single-self-contained-file rule means no new asset can
   * ship beside the page. Canvas TEXT, not another SVG data URI, is deliberate --
   * SVG favicons resolve fonts inconsistently, and a missing family there would
   * silently drop the digit and leave a blank amber tile reading as idle, the
   * worst failure this mark could have. Returns null on any canvas or font
   * failure, and the caller (setFaviconBadge) just leaves the tab's existing
   * mark alone rather than risk that blank tile. Both colours are interpolated
   * from src/styles.mjs's dark palette so the tile and its numeral can't drift
   * from the page's own mark (they had: this used to paint a hardcoded blue that
   * was two palette edits behind --accent).
   *
   * Sizes are optical, not linear: one digit sets 22px; two digits step down to
   * 18px rather than scaling proportionally, because the pair reads as one mass
   * and only its height matters; the 9+ overflow (any count past 99 -- a real
   * board rarely passes three open rounds, so an honest two-digit count like 12
   * is worth keeping rather than flattening early) drops to 17px. 22 on a 32px
   * tile is deliberately oversized -- the digit has to survive the downsample to
   * 16px, where its stem lands on roughly 1.5 device pixels at 1x. See ADR.md
   * entry 30, which replaced the inverted tile with this numeral. */
  function drawFavicon(n) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#e5b04d';
      ctx.beginPath();
      ctx.roundRect(0, 0, 32, 32, 9);
      ctx.fill();
      var label = n > 99 ? '9+' : String(n);
      var size = n > 99 ? 17 : (n >= 10 ? 18 : 22);
      ctx.fillStyle = '#0a1020';
      ctx.font = 'bold ' + size + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 16, 16.8);
      return canvas.toDataURL('image/png');
    } catch (e) { return null; }
  }

  /** Show (pending truthy) or hide (falsy) the tab's pending-count favicon mark.
   * Hiding puts back the page's own mark (faviconLink, src/styles.mjs) rather
   * than clearing the href, which would leave the tab blank once every round is
   * answered; the <link> is still created here if the document somehow carries
   * none, so this degrades to the old behaviour instead of throwing. */
  function setFaviconBadge(pending) {
    try {
      if (!faviconLink) {
        faviconLink = document.querySelector('link[rel="icon"]');
        if (!faviconLink) {
          faviconLink = document.createElement('link');
          faviconLink.setAttribute('rel', 'icon');
          document.head.appendChild(faviconLink);
        }
        baseFavicon = faviconLink.getAttribute('href');
      }
      if (!pending) {
        if (baseFavicon) faviconLink.setAttribute('href', baseFavicon);
        else faviconLink.removeAttribute('href');
        return;
      }
      var href = drawFavicon(pending);
      if (href) faviconLink.setAttribute('href', href);
    } catch (e) { /* no favicon mark; the daemon's banner still covers a hidden tab */ }
  }

  /** The tab mark (AC 9) gates on whether round n is awaited, i.e. whether the
   * ask() call that posted it is still genuinely blocked on it (CONTEXT.md
   * "Awaited"). A fire-and-forget artifact round (no wait) is not: nobody is
   * listening for a submit that will never come, so marking it pending would be
   * a lie the UI has no business telling. 'board' is read directly off the
   * closure rather than passed in: applyRoundPush (this function's only caller)
   * has already reassigned it to the post-push board by the time this runs, so
   * n's own round record -- awaited flag included -- is right there. */
  function markPendingRound(n) {
    if (readonly) return;
    var r = (board.rounds || []).filter(function (x) { return x.n === n; })[0];
    if (!roundIsAwaited(board, r)) return;
    pendingRounds++;
    setFaviconBadge(pendingRounds);
  }

  function clearPendingMark() {
    if (!pendingRounds) return;
    pendingRounds = 0;
    setFaviconBadge(0);
  }

  // --- Attended report: does the daemon know this tab is being looked at? -----
  //
  // CONTEXT.md "Watcher"/"Attended", ADR.md entry 58: the daemon is the one
  // notifier now, and it can only tell a buried tab from a genuinely absent
  // reviewer if the tab itself says which. 'attendedWatcherId' is the id the SSE
  // stream hands this connection in its own 'watcher' event (below, where 'es' is
  // created) -- nothing is reported before it arrives, since a report naming no
  // watcher has nothing to update. Fed from the SAME visibility/focus listeners
  // the favicon badge already uses, just below, PLUS 'blur' (which the favicon
  // mark has no use for -- losing focus while still visible never means "come
  // back and look", so clearPendingMark stays off it).
  //
  // 'blur' is the product's main scenario, not a latency gap: a board left open
  // on one screen while the reviewer works in another window is neither hidden
  // nor unfocused-via-visibilitychange, so with only visibilitychange/focus this
  // tab reports 'attended: true' once, at open, and never again for the rest of
  // the wait -- the daemon reads that stale true as "someone is looking" and
  // raises nothing. The OS handing focus to another app is exactly the edge
  // visibilitychange/focus cannot see on their own (document.hidden stays false,
  // and 'focus' only fires on REGAINING it).
  var attendedWatcherId = null;
  // Bumped by every reportAttended() call -- a fresh DOM edge or a fresh watcher
  // id (a reconnect) alike -- so a POST or a pending retry from an EARLIER call
  // can tell it has been superseded before it acts. A single timer handle cannot
  // do this: more than one POST can be in flight at once (a reviewer alt-tabbing
  // across the board fires focus, blur, focus, blur within a couple hundred
  // milliseconds), and each fires its own reportAttended() before any earlier one
  // has rejected, so there is nothing yet to clear. A shared, monotonically
  // increasing epoch lets EVERY stale chain recognise itself as stale, not just
  // the one a lone handle happened to be tracking.
  //
  // Also sent on the wire as 'seq' (below): HTTP does not guarantee the second
  // POST sent lands second, and a focus->true racing past a blur->false leaves
  // the daemon holding 'true' with nobody looking, silent for the rest of the
  // wait. Never reset on reconnect -- a fresh watcherId starts a fresh, seq-less
  // record on the daemon side, so a counter that only ever grows keeps every
  // report this tab EVER sends ordered against itself with no reset to
  // coordinate with the server.
  var attendedEpoch = 0;
  // When this TAB last had focus, in its own clock, and 0 if it never has. Sent
  // alongside every report as 'sinceFocusMs' so the daemon's two-minute look-away
  // window (ADR.md entry 73) survives an SSE reconnect.
  //
  // Without it the window is lost exactly where it is needed most. The daemon's
  // record of when a tab last had focus lives in the SSE hub, per Watcher, and a
  // reconnect mints a FRESH Watcher that has never reported focus -- so a buried
  // tab's first report after one is 'attended: false' against no prior focus at
  // all, the window reads as zero, and the bare grace is armed. That is the
  // ordinary install.sh update: reviewer looks at a board, switches to the
  // terminal, the daemon restarts under them, EventSource reconnects, and fifteen
  // seconds later a banner fires for a round they were looking at half a minute
  // ago -- the precise defect entry 73 exists to remove.
  //
  // Stamped from the TAB's own state, never from the mere fact of connecting: a
  // tab that has never been looked at sends nothing and gets no window, because
  // "connected implies recently focused" is the reading entry 73 refuses.
  var attendedLastFocusAt = 0;
  // What the LAST report said about this tab, and the only reason the stamp above can be
  // correct. Reports are edge-driven, so a tab focused for ten minutes sends nothing in
  // between: stamping only when a report says 'attended: true' pins the stamp to the
  // moment focus was GAINED, and the blur report -- which takes the false branch and
  // stamps nothing at all -- then claims focus was lost ten minutes ago. Anyone who reads
  // a board for longer than the daemon's window and then buries the tab would hand the
  // next reconnect a window that was already spent, which is criterion 7's defect
  // surviving untouched for exactly the reviewer this product is for.
  //
  // So the tab stamps when it HAD focus before this report or HAS it now -- the mirror of
  // the daemon's own rule for the Watchers it can observe itself (src/server.mjs's
  // setAttended, 'watcher.attended === true || attended'). A blur then reads ~0, which is
  // the truth: the tab had focus right up to this instant.
  var attendedWasFocused = false;

  function isTabAttended() {
    return !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus());
  }

  // Doubles from 2s, capped at the SSE heartbeat interval (15s default --
  // PROTOCOL.md, src/server.mjs's DEFAULT_SSE_HEARTBEAT_MS; not imported here,
  // this being the standalone client script, so the two are kept in step by
  // hand rather than by reference) -- the connection is already paying for a
  // wakeup at that cadence, so retrying any faster once failures are settled
  // buys nothing. Three doublings (2s, 4s, 8s) clear the ceiling, then every
  // attempt after holds there for as long as the daemon stays unreachable.
  var ATTENDED_RETRY_CEILING_MS = 15000;
  function nextAttendedRetryDelay(attempt) {
    return Math.min(2000 * Math.pow(2, attempt), ATTENDED_RETRY_CEILING_MS);
  }

  /** Sends one attended report, and -- only on failure -- arms a retry.
   * UNBOUNDED in attempts, deliberately: a tab that is visible and focused
   * produces no further visibility/focus/blur edge to retry it on its own (the
   * reviewer is already looking and has no reason to touch it), so a fixed
   * retry count just moves the mute hole from "one dropped POST" to "three or
   * however many" -- worse during exactly the daemon-restart storm where
   * failures cluster, since isAttended no longer tolerates a Watcher that has
   * never successfully reported at all. Idle the instant a report lands
   * (nothing schedules anything on success): only a FAILED report may ever
   * leave a timer armed, so an attended tab that is reporting fine costs
   * nothing beyond the edges it already rides. */
  function reportAttended() {
    if (readonly || !attendedWatcherId) return;
    attendedEpoch++;
    sendAttended(attendedEpoch, 0);
  }

  function sendAttended(epoch, attempt) {
    // Guards the SEND, not just the retry: a stale timer firing after a
    // fresher call already reported is a no-op outright, rather than an
    // extra (merely redundant, since the body always reads isTabAttended()
    // live) POST the daemon has to receive and this connection has to pay
    // for. Always true on attempt 0 -- reportAttended just bumped the epoch
    // to this exact value the line before calling here -- so this only ever
    // turns AWAY a retry, never the report that armed it.
    if (readonly || epoch !== attendedEpoch) return;
    var watcher = attendedWatcherId;
    // Read ONCE and reused for both fields below: reading isTabAttended() twice
    // could report 'attended: false' with a sinceFocusMs of 0 (or the reverse) if
    // focus moved between the two calls, which is the one combination that lies.
    var attended = isTabAttended();
    if (attended || attendedWasFocused) attendedLastFocusAt = Date.now();
    attendedWasFocused = attended;
    // 'seq' is THIS call's own epoch, captured as the function's argument --
    // never the live attendedEpoch read fresh at send time, which a retry
    // would otherwise report as newer than the (possibly stale) attended
    // value it is actually carrying.
    //
    // 'sinceFocusMs' is computed at SEND time rather than captured with the
    // epoch, for the opposite reason: it describes how long ago focus was lost
    // as of the moment this POST leaves, so a retry that fires eight seconds
    // later must carry eight seconds more.
    //
    // Sent ONLY when this tab does not have focus right now, and only when it
    // has had focus at some point. A report that says 'attended: true' already
    // says the stronger thing, and a tab that has never been looked at has
    // nothing to tell -- an absent field is "I do not know", which is not the
    // same claim as zero, and zero is what would hand a never-focused tab a
    // full window it has not earned.
    var report = { watcher: watcher, attended: attended, seq: epoch };
    if (!attended && attendedLastFocusAt) report.sinceFocusMs = Math.max(0, Date.now() - attendedLastFocusAt);
    fetch('/api/board/' + boardId + '/attended', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }).then(function (r) {
      // A rejected response (401 mid-secret-rotation, 5xx, anything not 2xx)
      // resolves this promise -- only a network failure rejects it on its own --
      // so without this the daemon recording nothing reads to the page as
      // indistinguishable from success, and nothing here would ever retry.
      // Thrown INTO the catch below so a bad response takes the exact same
      // unbounded-with-backoff path a dropped one already does; the argument
      // for why that path must be unbounded (this function's own header
      // comment) applies to a rejected report every bit as much as a lost one.
      if (!r.ok) throw new Error('attended report rejected: ' + r.status);
    }).catch(function () {
      // Superseded -- a fresher reportAttended() call (a later edge, or a
      // reconnect's fresh watcher id) already bumped attendedEpoch past the
      // one THIS chain was minted under -- must never arm its own retry on
      // top of whatever the fresher call is already doing. readonly can in
      // principle flip too (the archive never sets attendedWatcherId in the
      // first place, so this is belt only).
      if (readonly || epoch !== attendedEpoch) return;
      setTimeout(function () { sendAttended(epoch, attempt + 1); }, nextAttendedRetryDelay(attempt));
    });
  }

  // Coming back to the tab is the acknowledgement: the mark clears the moment the
  // document becomes visible/focused again, so a stale numeral never outlives
  // the rounds it counted. The attended report rides the same edges PLUS 'blur', which has nothing
  // to say to the favicon or the banner's click sentinel (losing focus while
  // still visible is not "come back and look", nor is it an arrival) but
  // everything to say to the daemon (see attendedWatcherId's own comment above
  // for why). The banner's own click sentinel, maybeJumpToStrandedRound, rides
  // visibilitychange and focus only -- the two edges that mean "arriving", not
  // blur, which means the opposite.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) clearPendingMark(); reportAttended(); maybeJumpToStrandedRound(); });
  window.addEventListener('focus', function () { clearPendingMark(); reportAttended(); maybeJumpToStrandedRound(); });
  window.addEventListener('blur', function () { reportAttended(); });

  // --- SSE: a follow-up round pushes into this already-open tab ---------------
  //
  // "Open once, then badge" / "Always on under launchd":
  // the daemon can restart mid-review -- on a crash, a kickstart, or an install
  // taking an update -- so the page
  // must reconnect rather than lose the thread. EventSource does that natively
  // (automatic retry on drop); since nothing can mutate the board while the daemon
  // is down, a bare reconnect is enough to catch back up — no resync fetch needed.
  // Guarded exactly like every other daemon-only capability: never opened in
  // read-only (file://) mode, so the standalone archive stays network-free.

  function markRoundHistory(n) {
    var section = document.querySelector('.round[data-round="' + n + '"]');
    if (!section) return;
    section.classList.remove('round-open');
    section.classList.add('round-history');
    section.setAttribute('data-round-status', 'sent');
    var label = section.querySelector('.round-label');
    if (label && label.textContent.indexOf('sent') === -1) label.textContent = label.textContent + ' · sent';
    // renderRoundSection only ever emits .round-end
    // for an open round -- a round arriving pre-rendered as historical (a fresh
    // load, or a server-rendered replacement over SSE) never carries one in the
    // first place. This is the one path where a round goes historical WITHOUT a
    // fresh render (an SSE 'round' push's roundsNowSent, or applySubmittedPush's
    // own no-html fallback): the rail this same section rendered while it was
    // still open has to come back out here too, or the live transition leaves a
    // "5 questions" marker sitting inside a round nothing can act on any more --
    // server markup and this live transition would disagree about which rounds
    // ever carry one (QUIRKS.md "the stylesheet and the markup are checked
    // against each other" -- the same discipline, applied here by hand instead
    // of by a check). The caller (applyRoundPush/applySubmittedPush) re-runs
    // setupSendBarDock right after, so a dock observer never ends up watching a
    // node this just removed.
    // .replaceWith() with no arguments is a real, spec-accurate way to remove a
    // node (an empty replacement set means "just take it out"), already
    // implemented by test/dom-stand-in.mjs's Element for the mermaid-fallback
    // path -- no new stand-in surface needed for this.
    var rail = section.querySelector('.round-end');
    if (rail) rail.replaceWith();
    // The diagram's expand control is exempt, exactly as it is in the readonly
    // pass at the top of this file, and for the same reason ("the lens is
    // view-only under body.readonly ... pan and zoom work"). A round collapsing
    // into history makes its ANSWERS immutable; it does not make its diagrams
    // unreadable, and a settled round is precisely where someone re-reads one.
    qsa('textarea, input, button', section).forEach(function (el) {
      if (el.classList && el.classList.contains('expand-btn')) return;
      el.disabled = true;
    });
    // Mirror renderRoundSection's server-side markup exactly (draggable="false"
    // on a historical rank item), not just "inputs disabled": disabling the
    // li tag's own controls does nothing to its native HTML5 drag capability,
    // which lives on the draggable attribute of the list item itself.
    qsa('.rank-list li[draggable]', section).forEach(function (li) { li.removeAttribute('draggable'); });
  }

  /** Find a block element by id without splicing the (potentially caller-chosen,
   * though src/board.mjs now rejects a malformed one at mint time) id into a CSS
   * attribute-selector string -- an id containing a double-quote would otherwise
   * throw, or with ] or , could match an unrelated block entirely. */
  function findBlockEl(root, id) {
    return qsa('.block', root).find(function (el) { return el.getAttribute('data-block-id') === id; }) || null;
  }

  function clearFieldState(blockIds) {
    blockIds.forEach(function (id) {
      delete selections[id];
      delete notes[id];
      delete deferred[id];
      delete touched[id];
    });
  }

  // Close the diagram lens before any of the three
  // paths below start replacing sections. The lens holds a CLONE of a diagram
  // that is about to stop existing, and -- until it is closed -- the block's own
  // comment form, moved in there and due back at a placeholder in markup this is
  // about to throw away. Closing first returns the form while its slot is still
  // in the document; leaving it open would strand it inside a dialog and leave
  // two elements sharing one id the moment the replacement rendered its own.
  function applyRoundPush(data) {
    lensClose();
    // The stage lens needs the same treatment for the same reason, and was
    // never given it: it holds a pick control bound to a card this push is
    // about to replace, so a press on it would record a choice against markup
    // nobody can see any more -- possibly naming an option this very amend
    // removed. stageLensTeardown's own comment already claims a closed lens
    // holds no such reference; this is what makes the claim true on a push.
    stageLensClose();
    // Whatever the send guard armed against is no longer what the reviewer is
    // looking at: an amend can add the very question the count was warning
    // about. Leaving it armed lets the button keep saying "1 question
    // unanswered" beside a pill that now reads two, and a press then sends
    // with no guard at all -- the two controls must never disagree.
    disarmSend();
    var patch = computeBoardPatch(board, data.board);
    // Advance the closure's board to the post-push state now, BEFORE any DOM
    // work below: the pin rendering wireRoot and renderMermaidBlocks drive reads
    // board.comments to place pins on whatever they wire, including the nodes
    // this very push is about to insert -- reassigning 'board' only at the end
    // would render any pin-layer populated during this call against the board as
    // it stood BEFORE this push, one push stale. computeBoardPatch above is the
    // only thing that needed the old value.
    board = data.board;
    // A block's content genuinely changed (an amend replaced it): whatever the
    // reviewer had typed/selected against the OLD content no longer corresponds
    // to anything on screen once the new markup lands, so it is cleared here --
    // never left to silently ride along as an invisible, stale answer. A block
    // that is merely NEW, or one nothing here touched, is never in this list
    // (computeBoardPatch), so nothing else is ever cleared.
    clearFieldState(patch.changedBlockIds);
    // Then seed newly-appeared/just-replaced block ids from whatever the server
    // already has recorded for them (rare, but possible for a re-amend) -- an
    // existing, in-progress, UNCHANGED block is never in either list, so its
    // live selections/notes/deferred/touched entries are never touched here.
    // This is the mechanism that makes "filled-but-unsent fields survive the
    // push" provable rather than incidental: it is the same computeBoardPatch
    // that test/check-pure.mjs exercises directly against plain board JSON, no
    // DOM involved.
    seedAnswers(patch.addedBlockIds.concat(patch.changedBlockIds), data.board);

    // Nothing has to un-page anything here any more: a round is a page of its
    // own (ADR.md entry 42), so the artifact keeps the full-viewport page it was
    // rendered as and the arriving round is simply another page beside it. The
    // page-board class, entry 40's condensed chrome and the sent-page lock all
    // follow whichever page is current, and refreshPager (called by goToRound
    // below) is the one place that writes them.
    //
    // The send bar was only ever CSS-hidden on a page board, never dropped (see
    // renderBoardPage), so a comment the reviewer queued on the artifact rides
    // this new round's submit exactly as ADR.md entry 35 describes, instead of
    // being stranded on a page with no way out.
    //
    // Which page the reviewer should be left on once this push has landed,
    // decided BEFORE the DOM changes (ADR.md entry 42). A round arriving is
    // what the reviewer at the front of the board is waiting for, so they are
    // carried to it; a reviewer who has deliberately flipped back to an earlier
    // page is not yanked off it -- the tab mark and the pager's own dot are how
    // they learn a new one exists. "At the front" is "on what was, until this
    // push, the newest page", which covers the ordinary case exactly: the board
    // opened on its newest round, and the round this push is about to send is
    // that same one. Read off the DOM rather than off 'board', which was
    // advanced to the post-push state above: the pages on screen are what "the
    // reviewer is at the front" is a statement about.
    var pagesBefore = qsa('.round');
    var newestBefore = pagesBefore.length
      ? parseInt(pagesBefore[pagesBefore.length - 1].getAttribute('data-round'), 10)
      : null;
    var followTheRound = data.mode === 'new-round' && currentRound === newestBefore;

    if (data.mode === 'new-round') {
      var container = document.querySelector('div#blocks');
      if (container) {
        var wrap = document.createElement('div');
        wrap.innerHTML = data.html;
        // Wire BEFORE moving into the live document: qsa/addEventListener works
        // identically on a detached subtree and the listeners survive the move,
        // which is what keeps wireRoot's own scope limited to exactly the nodes
        // this push added -- never re-wiring (and thereby double-registering
        // listeners on) every block already in #blocks.
        wireRoot(wrap);
        var nodes = Array.prototype.slice.call(wrap.childNodes);
        nodes.forEach(function (node) { container.appendChild(node); });
        // Mermaid needs real layout (getBBox etc.), so it only runs once the
        // nodes are attached -- and only scanned within each node THIS push
        // inserted, never the whole #blocks container, so an already-rendered
        // diagram from an earlier round is never re-scanned.
        nodes.forEach(function (node) { if (node.querySelectorAll) renderMermaidBlocks(node); });
        // The section arrives carrying 'round-current' whenever it is the
        // board's newest round -- renderRoundSection derives that from the same
        // board both sides hold, which is what keeps a pushed fragment
        // byte-identical to the one a reload would render. Whether the reviewer
        // is actually MOVED to it is this client's call, not the server's, and
        // the goToRound below makes exactly one section current either way.
      }
    } else if (data.mode === 'amend') {
      var roundSection = document.querySelector('.round[data-round="' + data.round + '"]');
      if (roundSection) {
        var frag = document.createElement('div');
        frag.innerHTML = data.html;
        // Same ordering fix as above, scoped to just the amended blocks: wiring
        // frag here can never reach the round's other, untouched blocks, since
        // they were never inside this detached fragment.
        wireRoot(frag);
        var blockEls = qsa('.block', frag);
        // An amend legitimately adds top-level blocks to the open round, so a
        // block with nowhere to land is inserted -- but only when the pushed
        // board actually carries it at the TOP level. A nested block (a compare
        // side, a question's context) has no place of its own in a round: its
        // markup belongs inside its owner's, so appending it here would leave
        // the owner on screen still showing the withdrawn content with an orphan
        // copy below it. Dropping it is the safe half of that trade -- the block
        // is still in 'board', so the next resync re-renders its owner properly.
        // Before the rail, not after it: .round-end closes an open round, and a
        // block appended past it renders outside the round it belongs to.
        var rail = roundSection.querySelector('.round-end');
        blockEls.forEach(function (blockEl) {
          var id = blockEl.getAttribute('data-block-id');
          var existing = findBlockEl(roundSection, id);
          if (existing) { existing.replaceWith(blockEl); return; }
          var topLevel = (data.board.blocks || []).some(function (b) { return b.id === id; });
          if (!topLevel) return;
          if (rail) { roundSection.insertBefore(blockEl, rail); } else { roundSection.appendChild(blockEl); }
        });
        blockEls.forEach(function (blockEl) { renderMermaidBlocks(blockEl); });
      }
    }

    // wireRoot(wrap)/
    // wireRoot(frag) above both ran BEFORE the subtree was attached, so
    // wirePageDomPins (called from inside wireRoot) computed every page-scoped
    // pin's position from a detached node -- getBoundingClientRect walks
    // parentElement up to wherever the chain actually ends, so a detached
    // wrap/frag gives a DIFFERENT (not just zero) box than the same element once
    // attached, and every pin it drew landed off-position. The html-stage/
    // mermaid cases already self-correct (their pins are (re)computed from
    // 'load'/mermaid.run, both of which only fire post-attach), but nothing
    // re-ran wirePageDomPins for the page-scoped case -- so it is done here,
    // now that the subtree is actually in the live document, same as the
    // 'resize' handler and submitBoard().then already do.
    refreshPins(document);

    patch.roundsNowSent.forEach(markRoundHistory);
    // Re-observe AFTER markRoundHistory: a round this push just collapsed into
    // history had its .round-end stripped above, and the round this push just
    // inserted (if any) carries its own, server-rendered -- setupSendBarDock has
    // to look at the document as it stands now, not as it stood before either
    // change landed.
    setupSendBarDock();
    // The pill's COUNT (unlike the dock/rail half, which only resyncs once the
    // observer above actually reports) is a plain count over the document as it
    // now stands, so it is refreshed here rather than waiting on that async
    // report -- a round collapsing into history or a fresh one arriving both
    // change what outstandingBlocks() sees.
    updateQuestionsLeftPill();

    // The pages this push changed: a fresh one exists, an earlier one has gone
    // sent, and both the pager's entries and the badge's M are stale until this
    // runs. goToRound when the reviewer was at the front (see followTheRound
    // above) -- which also lands the page-board/sent-page layout classes and the
    // send bar on the round that just arrived; refreshPager alone otherwise, so
    // a reviewer reading an earlier page keeps it and only sees the new entry
    // appear, dotted, in the pill. Either way exactly one section is current,
    // whatever 'round-current' the pushed markup happened to carry.
    // Either way this goes through goToRound, and that is not a tidiness
    // preference: the arriving section carries the server's own 'round-current'
    // whenever it is the newest round, so a branch that only refreshed the
    // controls would leave TWO sections current and two pages on screen at once.
    // Restating the page (no scroll) is what takes the class back off it.
    if (followTheRound) goToRound(data.round);
    else goToRound(currentRound, false);

    // The round is in the DOM; now mark the TAB, since this push is the whole
    // reason the tab was not reopened and focus not stolen ("Open
    // once, then badge and notify"). Last, and after every early-return above, so
    // a push that failed to render is never counted as one waiting to be read.
    markPendingRound(data.round);
    // Rider fix, unrelated to the timer: submitBoard's "Sent."/"Handed over to
    // chat." (or the 409 "Already sent." text) belongs to the round that just
    // went out, not the one that just arrived -- left alone, it would sit next
    // to the freshly re-enabled send bar until the reviewer submitted again.
    if (sendStatus && openRoundNumber() !== null) sendStatus.textContent = '';
  }

  function applySubmittedPush(data) {
    lensClose(); // see applyRoundPush above
    stageLensClose();
    disarmSend();
    var section = document.querySelector('.round[data-round="' + data.round + '"]');
    var replacedIds = section ? qsa('.block', section).map(function (el) { return el.getAttribute('data-block-id'); }) : [];
    // Advance board before any DOM work -- same reasoning as applyRoundPush
    // above: wireRoot's element-level anchoring reads board.comments
    // to place pins on whatever it wires, including the just-submitted section
    // this call is about to swap in.
    board = data.board;
    if (data.html) {
      var wrap = document.createElement('div');
      wrap.innerHTML = data.html;
      var replacement = wrap.firstElementChild;
      if (replacement) {
        wireRoot(replacement);
        if (section) { section.replaceWith(replacement); } else {
          // This client's DOM never had the round at all (e.g. it missed an
          // earlier 'round' push while disconnected): insert it now rather than
          // silently having no record of it, so a straggler still ends up
          // showing the round it missed as history, not a gap.
          var container = document.querySelector('div#blocks');
          if (container) container.appendChild(replacement);
        }
        renderMermaidBlocks(replacement);
      }
    } else if (section) {
      // Defensive fallback only -- src/server.mjs always sends html on a
      // 'submitted' event. Without it, disable what's already on screen rather
      // than leave the round looking editable; this can leave a NON-submitting
      // tab showing its own unrelated in-progress state as if it were what was
      // sent, which is exactly why the fragment path above is preferred.
      markRoundHistory(data.round);
    }
    // The section this push replaced may have been the page on screen, and the
    // replacement is a DIFFERENT element carrying whatever 'round-current' the
    // server's own render decided (renderRoundSection marks the newest round).
    // Re-asserting the reviewer's page over it is what keeps the document
    // showing what it showed a moment ago -- and re-runs the sent-page lock, so
    // a reviewer sitting on the round that just went out has it turn read-only
    // under them rather than staying an editable copy of a sent answer. Not a
    // flip, so no scroll: this is the same page, restated.
    goToRound(currentRound, false);
    // Same reasoning as applyRoundPush's own call: the just-submitted round's
    // .round-end is gone (its replacement markup is historical, never carries
    // one -- and the markRoundHistory fallback branch above strips it too), so
    // the dock observer has to re-read the document rather than keep watching a
    // node that may no longer be attached.
    setupSendBarDock();
    updateQuestionsLeftPill();
    // Same fix as applyRoundPush above -- wireRoot(replacement) ran against
    // a detached node, so any page-scoped pin it drew is positioned wrong now
    // that the section is actually attached. Recompute once, here, after attach.
    refreshPins(document);
    // The round is now sent: nothing in it is worth preserving as "in progress"
    // any more, however this client happened to have it filled in. Both sources
    // are used deliberately -- board.blocks is the TOP level only, so a question
    // nested in a compare block or in another question's context appears solely
    // in replacedIds, harvested from the DOM subtree actually being replaced.
    var roundBlockIds = (data.board.blocks || []).filter(function (b) { return b.round === data.round; }).map(function (b) { return b.id; });
    clearFieldState(roundBlockIds.concat(replacedIds));
    // Sent means sent: the send bar stays disabled until a new round arrives, so
    // a second click (or a second tab) can never re-submit a round that went
    // out. goToRound above has already said exactly this (the bar is live only
    // on the open round's own page); this is the same call kept explicit,
    // because "a sent round is never submittable twice" is not a fact that
    // should depend on the pager's internals.
    setSendBarEnabled(openRoundNumber() !== null && currentRound === openRoundNumber());
  }

  // --- resync: catch up on whatever landed while this client was not listening --
  //
  // EventSource reconnects on its own, but the stream carries no replay: anything
  // broadcast between the drop and the reconnect is gone for good, and the server
  // emits no id: lines for a Last-Event-ID replay to work from. That window is
  // not hypothetical — a sleeping laptop, a tab restored from the index while the
  // agent is mid-amend, a page served a moment before the round it is about to
  // miss. The failure is silent and expensive: the reviewer sends what they can
  // see, and the question they never saw comes back 'unanswered' to the very agent
  // that just added it.
  //
  // So every time the subscription opens — the first time included — the current
  // board is re-read and diffed against the local copy with the same
  // computeBoardPatch every push uses. A first connection with nothing missed
  // diffs to nothing and does nothing at all; only a real gap touches the DOM.
  //
  // The board is re-read from the page route rather than a JSON endpoint of its
  // own because that page already inlines exactly the payload this needs
  // ('#board-data', resolveComment already run over it) AND the server-rendered
  // markup for every round — so the catch-up reuses the same fragments a live
  // push would have carried, instead of the client inventing its own markup.
  function applyResync(fresh, doc) {
    var patch = computeBoardPatch(board, fresh);
    if (!patch.addedBlockIds.length && !patch.changedBlockIds.length && !patch.roundsNowSent.length) return;
    lensClose(); // see applyRoundPush above -- after the no-op early return, not before
    stageLensClose();

    var roundOf = {};
    (fresh.blocks || []).forEach(function (b) { roundOf[b.id] = b.round; });

    // computeBoardPatch reports the FLATTENED tree (a compare side, a question's
    // context, a variant option -- see src/patch.mjs's "NESTED BLOCKS COUNT"),
    // but the round renders top-level blocks only: a nested block's markup lives
    // INSIDE its owner's, and the live path never sends it on its own
    // (src/server.mjs's buildRoundPushPayload is handed amendRound's top-level
    // ids). Mapping each touched id back to the top-level block that carries it
    // is what keeps the catch-up path saying the same thing the live one does.
    // Without it, an amended compare side came back as its own fragment: the
    // amend below could not find it in the round, appended it at round level,
    // and left the comparison on screen still showing the withdrawn content.
    // It also fixes the case where the ONLY change is nested -- roundOf has no
    // entry for a nested id, so no round was collected and the whole resync
    // fell through to the status-only branch, advancing 'board' without ever
    // re-rendering what changed.
    var ownerOf = {};
    (function walkOwners(blocks, owner) {
      (blocks || []).forEach(function (b) {
        if (!b || typeof b !== 'object') return;
        var top = owner || b.id;
        ownerOf[b.id] = top;
        if (b.context) walkOwners(b.context, top);
        if (b.left && b.left.block) walkOwners([b.left.block], top);
        if (b.right && b.right.block) walkOwners([b.right.block], top);
        if (b.options) walkOwners(b.options.map(function (o) { return o.block; }).filter(Boolean), top);
      });
    })(fresh.blocks, null);

    var touchedIds = [];
    patch.addedBlockIds.concat(patch.changedBlockIds).forEach(function (id) {
      var top = ownerOf[id] || id;
      if (touchedIds.indexOf(top) === -1) touchedIds.push(top);
    });
    var rounds = [];
    touchedIds.forEach(function (id) {
      var n = roundOf[id];
      if (n != null && rounds.indexOf(n) === -1) rounds.push(n);
    });
    rounds.sort(function (a, b) { return a - b; });

    if (!rounds.length) {
      // Only status to catch up on -- a round went sent while we were away.
      board = fresh;
      clearFieldState(patch.changedBlockIds);
      patch.roundsNowSent.forEach(markRoundHistory);
      // The pager states everything this branch changed -- the badge, the dot
      // on a round that no longer owes an answer, and the send bar, which a
      // round going sent while this client was away must take away even though
      // the reviewer never left the page it was on.
      refreshPager();
      refreshPins(document);
      return;
    }

    // Replayed as the pushes that were missed, through the same applyRoundPush
    // the live path uses -- one code path for "arrived live" and "arrived late",
    // so a client that reconnects mid-thread ends up indistinguishable from one
    // that was there the whole time (PROTOCOL.md "SSE events").
    rounds.forEach(function (n) {
      var freshSection = doc.querySelector('.round[data-round="' + n + '"]');
      if (!freshSection) return;
      var localSection = document.querySelector('.round[data-round="' + n + '"]');
      if (!localSection) {
        applyRoundPush({ round: n, mode: 'new-round', board: fresh, html: freshSection.outerHTML });
        return;
      }
      var html = '';
      touchedIds.forEach(function (id) {
        if (roundOf[id] !== n) return;
        var el = findBlockEl(freshSection, id);
        if (el) html += el.outerHTML;
      });
      if (html) applyRoundPush({ round: n, mode: 'amend', board: fresh, html: html });
    });
    refreshPins(document);
  }

  function resync() {
    if (readonly) return;
    fetch('/b/' + encodeURIComponent(boardId)).then(function (r) {
      if (!r.ok) throw new Error('resync failed: ' + r.status);
      return r.text();
    }).then(function (text) {
      // DOMParser does not run scripts or fetch subresources, so parsing the
      // served page here is inert -- it is read purely as a data envelope.
      // Tag/type-qualified for the same reason as the hydrate-time lookup at
      // the top of this script -- this document is parsed straight from
      // response bytes, so a '## Board data' heading could satisfy a bare id
      // lookup here too.
      var doc = new DOMParser().parseFromString(text, 'text/html');
      var node = doc.querySelector('script#board-data[type="application/json"]');
      if (!node) return;
      applyResync(JSON.parse(node.textContent), doc);
    }).catch(function () {
      // A failed catch-up must never break the page: the live subscription is
      // still open, and the next reconnect tries again.
    });
  }

  if (!readonly && typeof EventSource !== 'undefined') {
    var es = new EventSource('/api/board/' + boardId + '/events');
    // 'open' fires on the first connection AND on every automatic reconnect,
    // which is exactly the set of moments this client may have missed something.
    es.addEventListener('open', function () { resync(); });
    // Sent first, ahead of anything else, by src/server.mjs's handleEvents -- see
    // PROTOCOL.md "SSE events". Reporting immediately on receipt covers both the
    // initial load (a tab opened straight into the background never fires
    // visibilitychange/focus on its own) and every reconnect (a fresh watcherId
    // needs its own first report, since the daemon holds no history for it).
    es.addEventListener('watcher', function (ev) {
      try { attendedWatcherId = JSON.parse(ev.data).id; reportAttended(); } catch (e) { /* malformed; the next reconnect tries again */ }
    });
    es.addEventListener('round', function (ev) {
      try { applyRoundPush(JSON.parse(ev.data)); } catch (e) { /* malformed push; ignore rather than crash the page */ }
    });
    es.addEventListener('submitted', function (ev) {
      try { applySubmittedPush(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    });
    // AC 12: "when a wait dies while the page is open, the page is told over
    // SSE". src/server.mjs's handleWait broadcasts this the instant its own
    // /wait call times out, which is genuinely earlier than the periodic tick
    // above would otherwise catch it. No payload is needed -- every fact this
    // repaints (board.rounds' own status/awaited/awaitDeadline, and this
    // reader's own clock) is already known locally; the event exists purely as
    // a wake-up nudge, so a malformed or absent 'data' still repaints.
    es.addEventListener('awaitExpired', function () { refreshAwaitDisplay(); });
  }
})();
