// Client-side script for the board page, exported as a string so render.mjs can
// inline it in a <script type="module"> tag and the page stays self-contained.
//
// Hydrates from the embedded board JSON, wires all four answer widgets (single,
// multi, text, rank) plus the per-question defer toggle, renders mermaid
// client-side from its CDN, wires comments anchored at block, markdown, and
// element level (a dom path + hint inside an html stage, a mermaid node id inside
// a rendered diagram), and the two ways out of a round — Send and Discuss in
// chat, never gated on how much is filled in, but disabled once the round has
// actually gone out, since the send bar sits outside the round section and no
// history collapse can reach it. Subscribes over SSE so a follow-up round pushes
// into this already-open tab instead of requiring a reload — marking that tab
// (title count, favicon badge, notification when it's unfocused) rather than
// stealing focus back — and re-reads the board on every (re)connect, because the
// stream has no replay and a disconnected client would otherwise lose a push for
// good.
//
// A comment gets its pin the moment it is QUEUED, not when the batch is finally
// sent: pendingComments carries a provisional number continuing the server's
// sequence and renders hollow (.pin-pending), then gives way to the server's
// numbering once a submit lands. See commentsWithPending / refreshPins below.
//
// All of that wiring -- answer widgets, comment buttons/forms, and element-level
// anchoring alike -- is factored into `wireRoot(root)` so it can run once at
// hydrate (root = document) and again on just the newly-inserted subtree after a
// push: an html or mermaid block can arrive in a round pushed long after hydrate,
// and it has to be exactly as clickable as one that was on the page at load, so
// anchoring cannot be a document-wide, one-time-only pass. wireRoot never
// reassigns innerHTML on the whole board (that would blow away an in-progress
// answer) and never re-wires an element outside the 'root' it's given (that would
// double-register listeners on an already-wired element -- see ticket 04's audit
// log for what that did to multi-select and Defer before every wiring loop here
// was scoped this way).
//
// Element-level pins render their resolved/lost styling from `board.comments` as
// embedded by src/render.mjs — already run through resolveComment server-side —
// and only use a live DOM/SVG lookup to decide *where* to draw the pin, never to
// decide whether it's resolved. See src/anchor.mjs's file comment for why: an
// earlier draft had the client re-derive resolved/lost independently, which could
// disagree with the server's verdict for the same comment.
//
// Read-only mode: opened straight from disk (file://) there is no daemon to submit
// to or subscribe to, so the page hydrates from its embedded copy, disables every
// input, and never opens an SSE connection.

import { computeBoardPatch } from './patch.mjs';
import {
  composeHint, parseMermaidDomId, MERMAID_NODE_SELECTOR,
  findPendingCommentForAnchor, removePendingComment,
} from './anchor.mjs';
import { badgeLabel } from './badge.mjs';
import { lensZoomAt, lensFit, lensOneToOne } from './lens.mjs';
import { THEME_CHANGE_EVENT } from './theme.mjs';
import { palettes } from './styles.mjs';

// Ticket 04 (light theme): mermaid variable -> CSS token, read at call time
// from the live computed style rather than hardcoded a second time in the
// client script below. QUIRKS.md used to record this file's twelve dark
// hex/rgba literals as an independently-maintained mirror of src/styles.mjs's
// own DARK palette ("Two stylesheets, one palette") -- every one of those
// twelve was an exact match for the token it's mapped to below, so a dark
// reader's diagram is unchanged except for 'lineColor'/'--muted': ticket 02
// moved --muted's own value to '#8690a2' for contrast (it used to be
// '#7b869a', this map's old hardcoded value) and this map now inherits that
// fix rather than keeping its own stale copy. 'background' and the
// 'fontFamily'/'fontSize' pair stay literal in mermaidThemeVariables below --
// neither is a color token.
//
// A real, top-level module constant (not just text inside the `ui` template
// literal below) for the same reason MERMAID_NODE_SELECTOR above is imported
// rather than retyped: it's spliced into the client script via
// JSON.stringify so the two can never drift, AND it's directly importable by
// test/check-mermaid-theme.mjs, which cross-checks every value against
// src/styles.mjs's real palettes -- the audit finding this exists to close
// (9 of 12 mappings were asserted nowhere; a palette rename that orphaned one
// used to surface only as an unhandled rejection wiping every diagram, never
// as a test failure).
export const MERMAID_TOKEN_MAP = {
  primaryColor: '--panel-2',
  primaryTextColor: '--ink',
  primaryBorderColor: '--accent',
  secondaryColor: '--panel-3',
  tertiaryColor: '--panel',
  lineColor: '--muted',
  textColor: '--ink-2',
  mainBkg: '--panel-2',
  nodeBorder: '--accent',
  clusterBkg: '--accent-glow',
  clusterBorder: '--hairline-2',
  edgeLabelBackground: '--panel',
};

export const ui = `
(function () {
  // Tag/type-qualified, not a bare getElementById: board content is markdown
  // snapshotted from arbitrary files (src/markdown.mjs's own comment on the
  // threat model), and a heading '## Board data' slugifies to a SECOND
  // id="board-data" on an <h2> that renders before this real script tag in
  // tree order (audit 2026-07-31, finding P1). A bare id lookup for
  // 'board-data' used to return that heading, JSON.parse threw on its text, and the whole
  // client IIFE died before body.readonly was ever applied -- a file:// archive
  // then rendered as if it were a live, writable board. No heading is ever a
  // <script>, so this selector cannot be satisfied by anything markdown emits.
  var dataEl = document.querySelector('script#board-data[type="application/json"]');
  if (!dataEl) return;
  var board = JSON.parse(dataEl.textContent);
  var boardId = board.id;
  var readonly = (location.protocol === 'file:');
  if (readonly) document.body.classList.add('readonly');

  // Marks the innermost element under the cursor for the page's OWN generic
  // anchor gesture (the delegated document-level listener further down), so the
  // click-to-anchor gesture is visible before it is used. An html stage's
  // element-level hover (ticket 10, DESIGN.md) lives in a SEPARATE
  // document -- its own class, of the same name by convention but declared and
  // applied entirely inside the injected agent script src/render.mjs's
  // 'stageAgentScript' carries, never here; see that file's design comment for
  // why the two are independent (this page's stylesheet deliberately does not
  // reach into the stage's document -- QUIRKS.md "Two stylesheets, one
  // palette").
  var STAGE_HOVER_CLASS = 'cb-anchor-hover';

  var pendingComments = [];
  // Ticket 02: a stable per-entry id, never reused, so a queued comment can be
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

  // Comment mode (ticket 03, DESIGN.md): off by default, so every ordinary
  // widget handler below runs exactly as it always has. Declared here, at the very
  // top alongside the other page-lifetime state, because it is read from inside
  // wireRoot's per-widget handlers (guarding single/multi/rank/defer against
  // mutating an answer while the reviewer is mid-anchor-click) as well as from the
  // generic anchor hover/click listeners further down -- both need one shared,
  // page-lifetime flag, never a per-wire-pass local.
  var commentMode = false;

  // Which html-stage <iframe>s have a stage-side agent that confirmed 'ready'
  // (ticket 10, DESIGN.md -- see the design comment above
  // src/render.mjs's 'stageAgentScript'). Replaces the old 'stageHoverClears'
  // array, which reached across into each stage's own document directly to
  // clear an in-progress hover -- no longer possible at all once
  // 'allow-same-origin' is dropped (the parent can no longer touch
  // 'contentDocument'/'contentWindow.document'); a stage clears its own hover
  // locally now, the moment it hears 'commentMode: false' over postMessage
  // ('stageAgentScript''s own 'mode' handler).
  //
  // A WeakSet, not a plain array: ticket 09's audit finding U7 caught the
  // PREVIOUS version of this same idea (a plain array every wire pass pushed a
  // new entry onto, nothing ever removed) leaking one entry per stage forever,
  // including for the placeholder document nothing will ever click again. A
  // WeakSet only ever answers "is this specific, still-referenced frame one
  // I've heard from" ('isWiredStage', 'markStageWired' below) -- membership is
  // never enumerated directly; every caller that needs to ACT on "every wired
  // stage" derives its candidate list fresh from the live DOM
  // ('qsa('.html-stage', document)') and filters through 'isWiredStage', so a
  // frame an amend has already replaced is simply absent from that list and
  // costs nothing, ever, without this needing its own cleanup pass.
  var wiredStageFrames = typeof WeakSet === 'function' ? new WeakSet() : null;
  function isWiredStage(frame) { return !!wiredStageFrames && wiredStageFrames.has(frame); }
  function markStageWired(frame) { if (wiredStageFrames) wiredStageFrames.add(frame); }

  // Ticket 04 (light theme): a theme switch redraws every mermaid diagram in
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
  var computeBoardPatch = ${computeBoardPatch.toString()};

  // Ticket 03's criterion-6 hint rule, spliced in the same way and for the same
  // reason: the exact function test/check-comment-mode.mjs's hint checks run
  // against IS src/anchor.mjs's composeHint, not a second, hand-written copy of
  // its logic. An earlier draft got this wrong in a way a Director audit caught:
  // src/anchor.mjs carried only a design COMMENT describing this rule, no actual
  // code, so nothing bound "what the design says" to "what this page runs" --
  // reverting that file changed nothing any check could see. Embedding the real
  // function closes that gap the same way computeBoardPatch above already does.
  // Gathering the DOM inputs this takes (buildHint, below) stays here, same
  // split as buildSteps being parity-bound while "which element did the click
  // land on" is not.
  var composeHint = ${composeHint.toString()};

  // Polish ticket 02 (DESIGN.md): the two pure functions its own log calls out
  // for extraction, spliced in the same way and for the same reason as
  // composeHint just above -- src/anchor.mjs is the module test/check-pure.mjs
  // imports and checks directly, and this is the exact same code, not a
  // second hand-written copy that could silently drift. See that module's own
  // comment for the full design (why 'id', not 'blockId'+'anchor', identifies
  // a queued comment for removal; why a sent comment can never match).
  var findPendingCommentForAnchor = ${findPendingCommentForAnchor.toString()};
  var removePendingComment = ${removePendingComment.toString()};

  // Ticket 04's badge label, same technique again: 'round N of M' is pure
  // formatting with no DOM, and src/badge.mjs is what test/check-pure.mjs
  // exercises directly -- embedding its literal source here (not a hand copy)
  // is what proves this page renders the exact string that was checked.
  var badgeLabel = ${badgeLabel.toString()};

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
  // One deliberate exception (DESIGN.md polish ticket 05): the diagram's expand
  // control. 'The lens is view-only under body.readonly. Pan and zoom work in a
  // standalone archive (pure JS, no network, consistent with the archive's
  // guarantee); the comment gesture inside it is gated exactly like every other
  // comment gesture' -- so the control that OPENS it has to stay live, while the
  // gesture INSIDE it stays gated by the same 'readonly || !commentMode' guard
  // every other anchor-minting handler carries. Skipped by class here rather
  // than re-enabled afterwards, so there is never a frame in which it is
  // disabled. (Ticket 04's round badge is the counter-example this is written
  // against: it became a <button>, this loop disabled it, and nobody noticed
  // until review.)
  if (readonly) {
    qsa('textarea, input, button').forEach(function (el) {
      if (el.classList && el.classList.contains('expand-btn')) return;
      el.disabled = true;
    });
    qsa('.rank-list li[draggable]').forEach(function (li) { li.removeAttribute('draggable'); });
    // Ticket 03 (src/theme.mjs): the theme control is the one exception -- an
    // archive reader is exactly who needs it. Re-enabled right after the
    // blanket disable above rather than excluded from that selector, so the
    // selector's own literal text stays intact (test/check-pure.mjs asserts
    // it verbatim) and this reads as the carve-out it is. Tag-qualified
    // ('button#theme-toggle', not a bare id) for the same reason as
    // src/theme.mjs's own lookup -- a heading can mint a second
    // id="theme-toggle" that is never a <button> (audit finding L1).
    var themeToggleBtn = document.querySelector('button#theme-toggle');
    if (themeToggleBtn) themeToggleBtn.disabled = false;
  }

  // Opens (and fills in) blockId's comment-form for a given anchor. Shared by the
  // .comment-btn handler and the html-stage / mermaid element-click handlers
  // (ticket 02 / ticket 05, below) -- exactly one place decides what
  // "commenting on:" reads. Declared here, above wireRoot, alongside every
  // anchor helper it's shared with: it only ever reads/writes form state
  // already in the document, so (unlike everything wireRoot itself does) it
  // never needs to be re-scoped or guarded against being called more than once.
  //
  // anchorDomRef (ticket 05) is the generic page-scoped step-path a diagram-node
  // click ALSO mints, alongside its node-id anchorRef -- see src/anchor.mjs's
  // "ticket 05 design" comment for why a mermaid anchor carries both. It is only
  // ever non-empty for anchorKind 'mermaid'; every other caller omits it and the
  // stored attribute is just the empty string, harmless since the submit
  // handler below only reads it for that one kind.
  //
  // editing (DESIGN.md polish ticket 02, criterion 1) is the existing
  // pendingComments entry this same anchor already matched
  // (findPendingCommentForAnchor), found by the caller -- never re-derived
  // here. When present, the form is stamped with the entry's own id and the
  // input is prefilled with its text, so THIS form's submit handler (below)
  // replaces that entry rather than queuing a duplicate. Every caller that has
  // no such entry (including every '.comment-btn' click, which never looked
  // for one) omits it, which is what clears any stale edit-target left over
  // from the last anchor this same per-block form happened to be opened for.
  //
  // Every id lookup in this file -- the per-block ones (form#comment-form-,
  // div#comment-target-, div#comment-list-<blockId>) and the page-wide ones
  // (script#board-data, button#theme-toggle, button#comment-mode-toggle,
  // button#send-btn/button#discuss-btn/span#send-status, button#round-badge,
  // div#blocks) -- is tag-qualified rather than a bare getElementById. Board
  // content is markdown snapshotted from arbitrary files (src/markdown.mjs's
  // threat-model comment), and a heading or top-level list item can mint an id
  // identical to any of these (slugify), including a composed one like
  // 'comment-form-q1'. Only render.mjs's OWN element ever carries the matching
  // tag (<form>, <div>, <button>, ...) for one of these ids -- a heading is
  // always <h1>-<h6> and a list item is always <li>, neither of which any of
  // these lookups' tag qualifiers can ever match -- so tag-qualifying removes
  // the collision, and the tree-order dependence it used to rely on, entirely
  // (audit 2026-07-31, findings P1/P2/L1).
  //
  // Two of these are not obvious from the id alone and were checked against
  // src/render.mjs rather than assumed: 'round-badge' is a <button> (ticket 04
  // promoted it from the <div> it used to be), and 'comment-list-<blockId>' is
  // a <div>, not a <ul>. And the qualifier survives the diagram lens: lensAdopt
  // MOVES the real div#comment-target-/form#comment-form- into a <dialog> that
  // lensOpen appended to document.body, so both stay in this document and a
  // document-rooted qualified selector still finds exactly one of each while
  // the lens is open (what it leaves behind is a <span class="lens-slot">,
  // which carries no id at all).
  //
  // test/check-archive-ids.mjs pins both halves: a real board whose markdown
  // mints every one of these ids as a heading, and a static sweep of all three
  // client scripts that fails the moment a bare getElementById (or an
  // unqualified '#id' selector) comes back.
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
      // Shown only while a comment is actually being composed on this block --
      // it is rendered on every block unconditionally (src/render.mjs), so it
      // opens and closes together with the form it labels.
      target.classList.add('open');
    }
    form.classList.add('open');
    var input = form.querySelector('input[type=text]');
    if (input) {
      // A DRAFT IN PROGRESS IS NEVER SILENTLY THROWN AWAY (finding NEW-3). This
      // used to be an unconditional 'input.value = editing ? editing.text : """"',
      // which was harmless while a comment form was only opened by pressing an
      // explicit button -- but comment mode makes EVERY click on EVERY block
      // element open it, so one stray click halfway through writing a remark
      // wiped what had been typed, with no undo and nothing to say it had
      // happened. New behaviour introduced by this batch, not old behaviour.
      //
      // So the field is only ever written when there is something to write:
      //   - an 'editing' target -- criterion 1's whole point is that reopening a
      //     queued comment shows that comment's own text; the reviewer clicked
      //     an element they know already carries one.
      //   - an empty (or whitespace-only) field, where there is nothing to lose.
      // A non-empty draft otherwise travels to the newly-clicked anchor
      // untouched. That is deliberate rather than a compromise: the
      // 'commenting on:' label directly above the field is rewritten in the same
      // call and names the new target, so the reviewer can see where the text
      // will land -- visible reattachment, and reversible (criterion 2's delete
      // control), rather than invisible destruction.
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
  // The distinction is load-bearing for criterion 12, not bookkeeping: an
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

  // DESIGN.md polish ticket 02, criterion 12: does blockId+anchor already carry a
  // SENT comment -- board.comments, never pendingComments. Reuses
  // findPendingCommentForAnchor's own kind+ref match rule against a different
  // array rather than a second copy of it (see that function's own comment,
  // src/anchor.mjs): its name says what it's FOR, not that its match rule is
  // exclusive to the pending queue. Every one of the anchor-minting
  // click/hover handlers below calls this before treating an element as a
  // comment target at all -- a sent comment's element is not prefilled, not
  // editable, and not even hoverable as a target: it is simply no longer one.
  // Kind-agnostic on purpose: it matches on whatever kind+ref it is handed, so
  // the 'md' anchor button, the generic 'dom' click, the diagram node and the
  // stage all ask it the same question about their own anchor shape.
  function isSentAnchor(blockId, anchor) {
    return !!findPendingCommentForAnchor(liveSentComments(), blockId, anchor);
  }

  // DESIGN.md polish ticket 02, criterion 12 (html-stage half): the dom refs
  // already carrying a SENT comment on blockId, in the ref-only shape the
  // stage's own postMessage 'mode' message carries (below) -- the parent is
  // what holds board.comments, and the stage's isolation (ticket 10: no
  // allow-same-origin, so contentDocument is unreachable) means it has no way
  // to learn this on its own. Only 'dom'-kind anchors: an html-stage's own
  // ref shape is always 'dom' (see handleStageClick), so a 'block'/'md'/
  // 'mermaid' comment on the same block is simply not this stage's concern.
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

  // --- element-level anchoring (ticket 06): click an element inside an html    ---
  // stage or a node inside a rendered mermaid diagram to anchor a comment to it.
  // The path/hint/node-id logic below mirrors src/anchor.mjs exactly (that module
  // is what test/check-pure.mjs exercises without a browser); this copy is a thin
  // DOM adapter over it, duplicated because the served page is a single
  // self-contained file with no import graph at runtime (see the file-level
  // comment above and ticket 05's standalone-archive guarantee).
  //
  // Declared here, above wireRoot: wireHtmlStage is CALLED from inside wireRoot
  // (scoped to root, below) and wireMermaidBlock is called from
  // renderMermaidBlocks (also root-scoped, further down) -- both need these in
  // scope, and neither is itself a "wire this root" loop, so neither belongs
  // nested inside wireRoot's own body. An html/mermaid block can arrive in ANY
  // round, including one pushed over SSE long after hydrate, and it has to be
  // just as clickable as one that was on the page at load: wireHtmlStage's own
  // guard (keyed on which live contentDocument was actually wired, not a boolean --
  // see its own comment for why), plus every actual wiring loop below being scoped
  // to root rather than document, is what keeps a push from re-wiring (and
  // double-registering pin-layer state on) a stage that arrived earlier -- see
  // ticket 04's audit log: a push that re-wires already-placed elements is
  // exactly how multi-select and Defer went silently dead there.

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
    var collapsed = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
    var max = 80;
    if (collapsed.length <= max) return collapsed;
    return collapsed.slice(0, max - 1).replace(/\\s+$/, '') + '…';
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
  var parseMermaidDomId = ${parseMermaidDomId.toString()};

  // The selector that must agree with the parser above, from the same source of
  // truth (src/anchor.mjs) -- the click walk-up below, the pin-candidate scan in
  // renderMermaidPins and the hover/cursor rules in src/styles.mjs all use it.
  var MERMAID_NODE_SELECTOR = ${JSON.stringify(MERMAID_NODE_SELECTOR)};

  // --- hint derivation (ticket 03): gather DOM inputs, then hand them to the  ---
  // embedded composeHint (declared near the top of this script) for the actual
  // composition rule. This function is ONLY the DOM-touching half -- finding a
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
      compareLabel = labelEl ? String(labelEl.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    var withKind = containerEl.closest ? containerEl.closest('[data-block-kind]') : null;
    var blockKind = withKind ? withKind.getAttribute('data-block-kind') : '';
    return composeHint(extractHint(el.textContent), el.tagName, insideCompare, compareLabel, blockKind);
  }

  // html stage (ticket 10, DESIGN.md): the iframe no longer carries
  // 'allow-same-origin' (src/render.mjs), so its browsing context is genuinely
  // cross-origin from this page and 'contentDocument'/'contentWindow.document'
  // are unreachable here -- reaching in is exactly the pre-existing security
  // hole (2026-07-29 audit, S1) this ticket exists to close. Element-level
  // click-to-comment instead runs over a 'postMessage' protocol with the
  // stage's OWN agent script (injected into every html block's 'srcdoc' by
  // src/render.mjs's 'stageAgentScript' -- see that function's own, full design
  // comment for the message list, the origin/identity reasoning on both sides,
  // and the shape-validation rule; this file's listener below is the other
  // half of that same design, kept in one place rather than restated). Pins
  // for comments already on the board render regardless of readonly, so an
  // archived board still shows them (the stage answers a 'locate' request the
  // moment it announces itself 'ready', unconditionally); only the
  // click/hover gesture is gated, by never sending 'mode' with 'commentMode:
  // true' at all while 'readonly' (setCommentMode, below).

  // A lost/unpositionable pin still has to go SOMEWHERE visible: stack them with a
  // small offset per layer rather than piling every one on the exact same pixel
  // (each .pin-layer gets its own counter via a WeakMap, so blocks don't interfere).
  //
  // U6 (DESIGN.md ticket 09, audit finding U6): this counter used to
  // live for the page's whole lifetime, incrementing every call while
  // 'layer.innerHTML = ''' (renderDomPins/renderMermaidPins, below) cleared the
  // very pins it was counting -- so a layer re-rendered on every resize, queued
  // comment and push walked further from its own top-left on every pass, with
  // nothing to do with how many lost pins were ever actually IN it at once.
  // resetStackedOffset is called right next to each innerHTML reset so the
  // counter always reflects only the pins currently being drawn into this pass.
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
    if (kind === 'md') return anchor.label;
    if (kind === 'dom') return anchor.hint || anchor.ref;
    if (kind === 'mermaid') return anchor.hint || anchor.ref;
    return 'block';
  }

  /** Build one queued comment's '.comment-item.comment-pending' list entry,
   * numbered 'n' -- DESIGN.md polish ticket 02 criteria 2/3: it carries a delete
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
   * Criterion 2's renumbering is the reason: a provisional number is never
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

  // Half a pin's own minimum size ('.anchor-pin { min-width: 20px; height: 20px }',
  // src/styles.mjs) -- how far inside a clipping edge its CENTRE has to sit for
  // the whole badge to stay visible. See renderDomPins below.
  var PIN_HALF = 10;

  function renderDomPins(blockId, stageRoot, layer) {
    layer.innerHTML = '';
    resetStackedOffset(layer);
    // Polish ticket 03 (DESIGN.md): a code block's own <pre> gets a height cap
    // (src/styles.mjs) and scrolls internally once its content passes it. This
    // layer otherwise spans the WHOLE section -- fine for markdown/compare/
    // question, whose content never scrolls on its own, but wrong for a capped
    // code block: a line scrolled out of the pre's own viewport would still
    // land somewhere INSIDE the section's box (over the kicker, say) and draw
    // its pin at the wrong spot instead of the right one. Decision: clip
    // rather than track. Resizing the layer (inline style) to exactly the
    // <pre>'s own box -- combined with '.code-block .pin-layer' overflow:
    // hidden (src/styles.mjs) -- means a line's computed position, once it
    // falls outside that box, is simply clipped by the browser rather than
    // drawn somewhere else in the section; no separate "is this line visible"
    // check needed, and no change at all for a code block that failed to
    // resolve (no <pre> to measure, so origin stays the whole section, exactly
    // as every other block kind above). It reappears correctly the instant it
    // scrolls back into view, since position is recomputed from a live
    // getBoundingClientRect() on every call -- including the 'scroll' listener
    // wirePageDomPins attaches to the <pre> below.
    var pre = stageRoot.classList && stageRoot.classList.contains('code-block')
      ? stageRoot.querySelector('pre') : null;
    var originEl = pre || stageRoot;
    var clipBox = null;
    if (pre && stageRoot.getBoundingClientRect && pre.getBoundingClientRect) {
      var sectionBox = stageRoot.getBoundingClientRect();
      var preBox = pre.getBoundingClientRect();
      // clientTop/clientLeft, not zero (finding NEW-4): getBoundingClientRect
      // returns BORDER boxes, but an absolutely-positioned child's top/left
      // resolve against its containing block's PADDING box. '.block' carries a
      // 1px border, so every pin in a code block was drawn 1px down and 1px
      // right of where it belonged -- small, but it is also the exact offset
      // that pushed a pin anchored at the pre's own origin fully outside the
      // clipping box. Guarded with '|| 0': the DOM stand-in has no such
      // property, and an undefined here would turn every offset into NaN.
      layer.style.top = (preBox.top - sectionBox.top - (stageRoot.clientTop || 0)) + 'px';
      layer.style.left = (preBox.left - sectionBox.left - (stageRoot.clientLeft || 0)) + 'px';
      layer.style.width = preBox.width + 'px';
      layer.style.height = preBox.height + 'px';
      layer.style.right = 'auto';
      layer.style.bottom = 'auto';
      clipBox = preBox;
    }
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== blockId || !c.anchor || c.anchor.kind !== 'dom') return;
      var steps = pathToSteps(c.anchor.ref);
      var el = steps.length && stageRoot ? resolveSteps(stageRoot, steps) : null;
      var position = null;
      if (el && el.getBoundingClientRect && originEl.getBoundingClientRect) {
        var originBox = originEl.getBoundingClientRect();
        var elBox = el.getBoundingClientRect();
        position = { left: elBox.left - originBox.left, top: elBox.top - originBox.top };
        // A pin is drawn centred on its point ('translate(-50%, -50%)',
        // src/styles.mjs), so a point sitting exactly on the clipping box's own
        // edge loses three quarters of the pin -- its number included -- to
        // '.code-block .pin-layer { overflow: hidden }'. Reachable, and not
        // hypothetically: a <pre> is not in ANCHOR_CHROME_SELECTOR, so a
        // comment-mode click on its padding gutter anchors the <pre> ITSELF and
        // lands the pin at exactly {0, 0} (finding NEW-4).
        //
        // Nudged inside ONLY when the anchored element genuinely overlaps the
        // visible box. That condition is what keeps the spec's decision intact
        // -- "pins in a capped code block are clipped, not repositioned", so a
        // line scrolled out of the pre's own viewport still HIDES rather than
        // being drawn at the wrong line. This moves a pin at most half its own
        // width, and only for an element that really is on screen.
        if (clipBox && elBox.right > clipBox.left && elBox.left < clipBox.right
          && elBox.bottom > clipBox.top && elBox.top < clipBox.bottom) {
          position = {
            left: Math.min(Math.max(position.left, PIN_HALF), Math.max(clipBox.width - PIN_HALF, PIN_HALF)),
            top: Math.min(Math.max(position.top, PIN_HALF), Math.max(clipBox.height - PIN_HALF, PIN_HALF)),
          };
        }
      }
      placePin(layer, c, !!c.resolved, position);
    });
  }

  // --- html-stage postMessage protocol (ticket 10) -----------------------------
  //
  // The parent's half of the design in src/render.mjs's 'stageAgentScript'
  // comment. Three responsibilities: find which live '.html-stage' frame a
  // message actually came from (never trust an id the message itself claims),
  // validate its shape before touching any field, and act on exactly the five
  // message types the stage ever sends.

  var STAGE_CB = 'cb-stage';
  var nextLocateId = 1;
  var pendingLocates = {}; // requestId -> { layer: pin-layer element, comments: [...] }
  // SPEC_STAGES.md criterion 11: the clip point for a variant option's stage
  // (handleStageHeight, below) -- tuned once against a real mock, per the
  // spec's own "around 600px" call. Hand-kept in step with src/styles.mjs's
  // '.choice-variant .html-stage' 'max-height', the same "two independent
  // places, kept in sync by convention" shape QUIRKS.md's "Two stylesheets,
  // one palette" already documents for this file's stage-side hex and
  // 'cursor' rule -- neither file can read a value out of the other (this one
  // is a client script in a template literal; the CSS is a second, separate
  // one). The CSS max-height is a backstop only: THIS clamp is the one that
  // actually stops a hostile report, since it runs before the value ever
  // touches the frame's inline style at all.
  var STAGE_HEIGHT_CAP = 600;

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
    // in the same message (DESIGN.md polish ticket 02, criterion 12): a stage
    // that has just announced itself needs to know which of ITS OWN elements
    // are already off-limits before its first hover, same as it needs to know
    // whether comment mode is even on.
    postToStage(frame, { type: 'mode', commentMode: commentMode, sentRefs: sentDomRefsForBlock(blockId) });
    if (layer) requestStagePositions(frame, blockId, layer);
  }

  function handleStageClick(data, section, blockId) {
    if (readonly || !commentMode) return;
    if (typeof data.ref !== 'string' || !data.ref) return;
    var anchor = { kind: 'dom', ref: data.ref };
    // DESIGN.md polish ticket 02, criterion 12: an element inside this stage
    // that already carries a SENT comment is no longer a comment target at
    // all -- clicking it does nothing (the parent never even opens a form),
    // one of the three anchor-minting entry points this criterion has to hold
    // for. The stage's own hover styling is unchanged by this (see QUIRKS.md
    // "Two stylesheets, one palette" -- that de-affordance would need its own
    // protocol addition into stageAgentScript, deliberately left out of this
    // client-side-only slice; noted as a known gap, not silently dropped).
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
    // before this ticket. Outside a compare, this is byte-identical to ticket
    // 02's plain extractHint(el.textContent) -- see src/anchor.mjs's design
    // comment.
    var hint = buildHint(section, { textContent: text, tagName: tag });
    // No 'editing' argument, deliberately, and unlike every OTHER caller of
    // openCommentForm on this page (audit finding S5). Criterion 1's
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
    // comment rather than reopening the first -- the pre-ticket behaviour, and
    // recoverable (criterion 2's delete control), which is the direction to
    // fail in. Passing no editing target also CLEARS any stale
    // data-editing-id left on the form by an earlier, trusted gesture, so a
    // stage message can never inherit one either.
    openCommentForm(blockId, 'dom', anchor.ref, hint, '');
  }

  /** SPEC_STAGES.md criteria 10/11: 'frame''s stage reporting its own content
   * height, so a variant option's card can grow to fit it instead of sitting
   * at '.html-stage''s fixed 320px floor -- the parent cannot measure this
   * itself (src/render.mjs's design comment on why 'contentDocument' is
   * unreachable), so the stage measures and reports, the same shape as
   * 'hover'/'positions'. Height is STAGE-AUTHORED input like every other field
   * on this channel (QUIRKS.md "A stage-posted message is agent-authored
   * input"): shape-checked ('Number.isFinite', positive -- a non-finite,
   * negative or zero report is dropped outright, same as every other
   * malformed field on this channel) and clamped to STAGE_HEIGHT_CAP before
   * it ever touches 'frame.style.height', so no report can grow a card
   * without limit, push page chrome off screen, or claim more than its own
   * box. 'frame' is already the DOM-walk-identified frame
   * ('findStageFrame(ev.source)' in the listener below), never an id the
   * message claims for itself.
   *
   * Applied only when 'frame' sits inside a '.choice-variant' card. Every
   * html stage sends this message, standalone or not (stageAgentScript has no
   * way to know which kind of card it ended up in -- see its own comment),
   * but a standalone stage keeps its existing floor/resize behaviour
   * untouched (spec criterion 13 -- a different chunk's territory); the
   * gate here, not a change to what the stage sends, is what keeps the two
   * apart. */
  function handleStageHeight(data, frame) {
    if (!Number.isFinite(data.height) || data.height <= 0) return;
    if (!frame.closest('.choice-variant')) return;
    frame.style.height = Math.min(data.height, STAGE_HEIGHT_CAP) + 'px';
  }

  function handleStagePositions(data) {
    var pending = pendingLocates[data.requestId];
    if (!pending) return; // unknown/stale request id -- never trusted blindly
    delete pendingLocates[data.requestId];
    var layer = pending.layer;
    if (layer.__cbLocateId !== data.requestId) return; // superseded by a later request
    layer.innerHTML = '';
    resetStackedOffset(layer); // ticket 09, audit finding U6: reset next to every innerHTML clear
    pending.comments.forEach(function (c) {
      var raw = Object.prototype.hasOwnProperty.call(data.positions, c.anchor.ref) ? data.positions[c.anchor.ref] : null;
      placePin(layer, c, !!c.resolved, isUsablePosition(raw) ? raw : null);
    });
  }

  // One listener for every stage on the page, registered once (never inside
  // wireRoot: a stage's 'ready' can arrive at any time after this page loads,
  // regardless of whether it was here at hydrate or arrived over an SSE push
  // long afterward -- there is no "wire this root's stages" step left to run
  // at all, since nothing here reaches into a frame until IT speaks first).
  window.addEventListener('message', function (ev) {
    // Origin, then identity, then shape -- see src/render.mjs's design comment
    // ("ORIGIN VALIDATION") for why "null" is the correct and complete check
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
  });

  // mermaid: wired from renderMermaidBlocks below once mermaid has either rendered
  // (svg present) or given up (svg null, CDN unreachable/offline) -- pins render
  // either way, using the server's resolved/lost verdict, so an offline archive
  // review still shows which anchors are lost instead of showing nothing at all.
  // renderMermaidBlocks is itself already root-scoped (ticket 04, so a push only
  // ever (re-)renders the mermaid nodes IT inserted) and is invoked with the
  // pushed subtree in exactly the same places wireRoot is, so wireMermaidBlock
  // needs no additional root-scoping of its own here.

  // section (ticket 05) is the OUTER-document '.mermaid-block' section a
  // domRef's steps are rooted at -- the same element buildHint's containerEl
  // argument means for every other page-scoped case. Optional (a caller with no
  // live section, or an anchor with no domRef, just skips straight to the
  // id-attribute scan below): position-finding degrades, resolved/lost styling
  // never does (see src/anchor.mjs's "ticket 05 design" comment).
  //
  // The live element a stored 'mermaid' anchor points at, or null -- factored out
  // of renderMermaidPins (below) so the LENS's own pin layer (renderLensPins,
  // polish ticket 05 (DESIGN.md)) answers the same question through the same
  // precedence instead of a second, drifting copy of it. Every lookup here is
  // scoped to the 'svg'/'section' it is handed and NEVER to 'document': the lens
  // clones the rendered SVG, and a clone carries duplicate element ids, so a
  // document-wide id lookup would be ambiguous between the two copies the moment
  // the lens is open (the spec's own named trap).
  function mermaidHostFor(anchor, svg, section) {
    if (!svg || !anchor) return null;
    // Ticket 05 (DESIGN.md): try the generic domRef first, against the LIVE
    // rendered SVG (something only the client, not resolveComment's server-side
    // verdict, can ever do -- see src/anchor.mjs's "ticket 05 design" comment).
    // Trusted only if the element it lands on ALSO carries the stored node id in
    // its own generated id -- a cheap cross-check against mermaid's internal SVG
    // structure having shifted since mint time, which would otherwise silently
    // position the pin on the wrong node.
    if (anchor.domRef && section) {
      var steps = pathToSteps(anchor.domRef);
      var viaSteps = steps.length ? resolveSteps(section, steps) : null;
      if (viaSteps && viaSteps.getAttribute && parseMermaidDomId(viaSteps.getAttribute('id')) === anchor.ref) {
        return viaSteps;
      }
    }
    // Iterate and compare via parseMermaidDomId rather than interpolating the
    // stored ref into a CSS attribute-selector string: a crafted ref could
    // otherwise break out of the selector (see DESIGN.md's board slice 06 log).
    // This is display-positioning only -- resolved/lost styling never depends on
    // this lookup succeeding, either path.
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

  // DESIGN.md polish ticket 05, criterion 11: "a mermaid node can be commented on
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
  // Returns false when the node is not a comment target at all (criterion 12: it
  // already carries a SENT comment), so a caller can tell "did nothing" from
  // "opened a form" without re-deriving that.
  function mintMermaidComment(section, blockId, host, ref) {
    var anchor = { kind: 'mermaid', ref: ref };
    // Criterion 12: a node that already carries a SENT comment is no longer a
    // comment target -- clicking it does nothing, in the lens exactly as inline.
    if (isSentAnchor(blockId, anchor)) return false;
    // Ticket 05 (DESIGN.md): mint the SAME generic domRef + hint every other
    // element-level click mints (buildSteps/buildHint, declared above, already
    // used by the html stage and the generic listener) -- the node id stays the
    // fallback ref, not the model (src/anchor.mjs's "ticket 05 design" comment).
    // A failure to build steps (host somehow not reachable from section) still
    // mints the anchor with an empty domRef rather than aborting: the node id
    // alone is enough to comment, exactly as it was before that ticket.
    var steps = host ? buildSteps(section, host) : null;
    var domRef = (steps && steps.length) ? stepsToPath(steps) : '';
    var hint = host ? buildHint(section, host) : '';
    // DESIGN.md polish ticket 02, criterion 1: a second click on a node that
    // already has a QUEUED (unsent) comment reopens and edits it, rather than
    // minting a duplicate -- again, in the lens exactly as inline.
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
    // view-only under body.readonly, not absent (DESIGN.md polish ticket 05), so
    // its expand control has to be wired in an archive too. It removes ITSELF
    // when there is no rendered SVG to show.
    wireDiagramExpand(section, blockId, svg || null);
    if (readonly || !svg) return; // nothing live to click without a rendered diagram
    // DESIGN.md polish ticket 02, criterion 12: stamp every node that already
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
    // Ticket 04: a theme switch calls this again for the SAME preEl (a fresh
    // <svg> inside it, not a fresh <pre>), purely to refresh the pins above --
    // the click listener itself must attach exactly once per element, ever,
    // or repeated switches stack repeated handlers (mermaidWiredBlocks, above).
    if (isMermaidBlockWired(preEl)) return;
    markMermaidBlockWired(preEl);
    preEl.addEventListener('click', function (ev) {
      // One gesture, toggle-gated everywhere (the user's decision, relayed by
      // the director, ticket 03): a diagram node is no longer a standing
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

  // --- the diagram lens (DESIGN.md polish ticket 05) -----------------------------
  //
  // Criterion 10: "a mermaid block carries an expand control that opens the
  // diagram in a full-viewport lens: drag pans, scroll zooms, with fit and 1:1
  // controls." Criterion 11: "a mermaid node can be commented on from inside the
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
  //      function the inline gesture calls, so criterion 11's "the same comment"
  //      is structural.
  //   3. The block's own comment <form> is MOVED in here while it is open rather
  //      than duplicated (lensAdopt below). A showModal()'d <dialog> makes the
  //      rest of the document inert, so a form left behind it could be opened
  //      and never typed into -- and a second form would be a second submit
  //      handler, i.e. exactly the "second parallel kind of comment" the ticket
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
  // .toString() (same discipline as computeBoardPatch/composeHint/badgeLabel):
  // "the point under the cursor stays under the cursor" and "fit centres the
  // whole diagram" are arithmetic invariants a check can hold this to, and are
  // otherwise the kind of thing verified by eye and wrong by a half-pixel
  // forever. Anything they need is declared inside their own bodies -- the
  // embedded copies are function sources, so a module-level helper would not
  // exist here.
  var lensZoomAt = ${lensZoomAt.toString()};
  var lensFit = ${lensFit.toString()};
  var lensOneToOne = ${lensOneToOne.toString()};

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
    // Criterion 11 / the spec's "Pins in the lens live inside the zoom
    // transform, counter-scaled": the pin layer is a child of the CANVAS, not of
    // the stage, so panning and zooming move every pin for free -- no pointer-move
    // recomputation, which is the scroll-tracking cost ticket 03 just avoided on
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

  /** Criterion 11, positioning half: the same comments the inline diagram pins,
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

  /** DESIGN.md polish criterion 15, the two batches' one real collision: a theme
   * change re-renders every inline diagram (runMermaidRedrawPass, further
   * down), and mermaid does that by REPLACING each 'pre.mermaid''s svg with a
   * brand-new element drawn in the new palette. The lens holds a
   * cloneNode(true) of the OLD one, so an already-open lens went on showing a
   * dark diagram inside light chrome (or the reverse) until it was closed and
   * reopened -- measured in Chrome 2026-07-31: after a light switch the lens's
   * node rects still read rgb(24, 32, 47) (dark --panel-2) with rgb(234, 238,
   * 246) labels while the inline diagram behind it had correctly become
   * rgb(245, 246, 251) / rgb(23, 28, 42).
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
    // press itself. Measured in Chrome, and it is the whole difference between
    // this lens being commentable and not: with capture active, the browser
    // retargets everything that follows -- pointerup, mouseup and the resulting
    // CLICK -- at the capture element, so the click handler below sees
    // '.lens-stage' as its target instead of the diagram node the pointer was
    // actually over, 'closest(MERMAID_NODE_SELECTOR)' finds nothing, and
    // clicking a node in the lens silently does nothing. Nothing in a DOM
    // stand-in can see that (there is no such thing as pointer capture there),
    // which puts it squarely in this repo's own recorded failure pattern:
    // QUIRKS.md "Real mermaid node ids are prefixed", the same gesture, dead in
    // every browser under a green suite. Deferring the capture costs nothing --
    // the first few pixels of a pan are still delivered to the stage because the
    // pointer is over it -- and a drag that then leaves the stage entirely is
    // captured by the time it gets there.
    // TWO points are tracked per press, not one, and the difference is the
    // whole of whether the threshold below means anything (audit finding D5,
    // reproduced in Chrome):
    //
    //   ox/oy  the PRESS ORIGIN. Never reassigned for the life of the press.
    //          The 3px threshold is measured from here, so it asks the only
    //          question worth asking -- 'has the pointer travelled more than
    //          3px since the button went down'.
    //   x/y    the LAST MOVE. Reassigned every event, because each frame's pan
    //          is the delta since the previous frame.
    //
    // An earlier version kept one pair and reassigned it on every move, so
    // 'dx/dy' was the PER-EVENT delta and the gate read 'did this single frame
    // move more than 3px'. A 120px pan dispatched as 60 moves of 2px -- an
    // ordinary slow drag, and exactly what a trackpad produces -- never
    // satisfied it: lensDragMoved stayed false the whole way, the branch below
    // never ran, so the pointer capture was never taken either (dead code in
    // the same 'if'), and releasing over a node opened the comment form on
    // whatever the pan had merely dragged PAST. Measured in Chrome, and
    // invisible to a structural check, which is why there is now a behavioural
    // one in test/check-mermaid-anchor.mjs that dispatches exactly that
    // sequence.
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

    // Criterion 11: the comment gesture, gated exactly like every other one --
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

  /** Criterion 10's "a mermaid block carries an expand control". The button is
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

  // --- the html-stage lens (SPEC_STAGES criteria 3, 4 and 12) --------------------
  //
  // Criterion 3: "every html stage carries an expand control that opens the stage
  // in the lens". Criterion 4: "inside the lens the stage receives real pointer
  // input: a mock with its own scrollable content can be scrolled there".
  //
  // It BORROWS THE DIAGRAM LENS'S CHROME, NOT ITS VIEW MATHS (the spec's Out of
  // Scope says so in as many words): same full-viewport <dialog>, same '.lens-bar'
  // / '.lens-title' / '.lens-btn' vocabulary, built once and reused. But its
  // contents are a LIVE BROWSING CONTEXT, not a cloned SVG on a pannable canvas --
  // an iframe scrolls, zooms and lays itself out on its own, so lensZoomAt/
  // lensFit/lensOneToOne and the whole clone-and-transform path above have nothing
  // to do here. A second <dialog> rather than a mode flag on the first one: they
  // share no state, only styling, and folding two unrelated stages into one
  // element is how the diagram lens's pan/zoom listeners would end up firing over
  // an iframe.
  //
  // THE FRAME IS A SECOND MOUNT OF THE SAME SRCDOC, AND DELIBERATELY NOT A
  // '.html-stage'. This is the one decision here worth arguing rather than
  // reading off the code:
  //
  //   - The parent identifies a stage message's sender by walking
  //     qsa('.html-stage', document) and comparing event.source to each frame's
  //     contentWindow (findStageFrame, above). That walk carries an ASSUMPTION,
  //     not just a lookup: every mounted '.html-stage' is exactly one block's
  //     inline stage, so the frame it finds names the block ('.html-block'
  //     ancestor), the pin layer to draw into and the sentRefs to send. A second
  //     frame wearing that class for the same block makes that claim false --
  //     'ready' would re-run handleStageReady for a block whose inline stage is
  //     already wired, and the two frames' 'positions' replies would race for one
  //     pin layer (the layer keeps only the latest requestId, so whichever answers
  //     second wins and the other's pins vanish).
  //   - So the lens frame carries '.stage-lens-frame' and never '.html-stage'.
  //     findStageFrame returns null for it, and its messages are dropped at the
  //     identity check, before any shape validation -- the same treatment any
  //     other window on the page gets. That is a strictly SMALLER surface than the
  //     inline stage has, not a new one, which is the direction to fail in for a
  //     frame whose whole content is agent-authored.
  //   - What it costs: the lens copy is not commentable at element level (no
  //     'ready' means no 'mode', so its own agent never turns its hover/click
  //     gesture on). The inline stage still is, unchanged -- and for a variant
  //     option the spec had already given that up to the inertness rule ("Out of
  //     Scope: restoring element-level comment anchoring inside a variant
  //     option's stage").
  //
  // A COPY, NOT THE INLINE FRAME MOVED IN (which is what lensAdopt does for the
  // block's comment form, and would have been the obvious symmetry). Re-parenting
  // an <iframe> destroys and recreates its browsing context -- the srcdoc document
  // reloads, so "move it in, move it back" is two reloads of the mock rather than
  // none -- and while it sat in the dialog it would be outside its own
  // '.html-block', so findStageFrame would match it and the closest('.html-block')
  // lookup right after would return null: every message from the block's own
  // stage silently dropped for as long as the lens was open. A fresh mount leaves
  // the inline stage untouched, which is most of criterion 13.
  //
  // POINTER-EVENTS, i.e. why criterion 4 costs nothing at the trust boundary.
  // '.choice-variant .html-stage { pointer-events: none; }' (src/styles.mjs) is a
  // security rule, not a style choice (criterion 9, and the spec's Decisions pin
  // it verbatim). Nothing here relaxes it: the lens frame is neither inside a
  // '.choice-variant' card nor a '.html-stage', so the rule simply does not
  // address it, and the frame is live because a plain iframe in a plain dialog is
  // live. "The lens is where a stage becomes live" (ADR 22) is implemented by
  // mounting a second copy somewhere the rule was never about, never by weakening
  // the rule.
  //
  // THE SANDBOX IS COPIED, NEVER RE-SPELLED. The attribute is read off the inline
  // frame and set on the copy before anything else and before it is attached, so
  // the two frames are sandboxed identically by construction and there is no
  // moment in which agent script could run under a weaker one. A lens frame that
  // gained 'allow-same-origin' would re-open the 2026-07-29 audit's S1 chain
  // wholesale (test/check-stage-isolation.mjs's header), so a frame with no
  // sandbox attribute at all is refused outright rather than mounted: fail closed,
  // because the failure this guards is total.
  //
  // THE PICK CONTROL (criteria 6, 7 and 8) lives in the bar, in the '.lens-actions'
  // slot between the title and close. See stageLensPick below for the whole of why
  // that address is the security property and not a layout preference.
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
    // opened, not about the lens, and criterion 6's "a lens opened from a
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
   * it, kept so criterion 12 can hand focus back to it -- passed in rather than
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

  /** Criteria 6, 7 and 8: the control that picks the option this lens was opened
   * from. Built per open and dropped on teardown -- never once, at build time --
   * because WHICH option it names is a fact about this open, and criterion 6's
   * "a lens opened from a standalone stage carries no such control" is the case
   * where the answer is "none at all".
   *
   * WHY THE BAR IS THE SECURITY PROPERTY, not a layout preference (criterion 7,
   * and the terms ADR 22 was accepted on). The control is an ordinary <button> in
   * the PARENT document, a flex sibling of the '.stage-lens-body' that holds the
   * frame -- never inside the frame, never overlapping it. Four attacks and what
   * actually stops each, all four mechanisms structural rather than guarded:
   *
   *   - PRESSING IT. A click inside a cross-origin frame is delivered in that
   *     frame's own document and does not cross the boundary; the stage's script
   *     can dispatch all the clicks it likes on its own elements and none of them
   *     is this button. There is no synthesized-click path either, because:
   *   - REACHING IT THROUGH THE DOM. 'sandbox="allow-scripts"' with no
   *     'allow-same-origin' gives the frame an opaque origin, so
   *     'window.parent.document' is unreachable from inside it -- the property
   *     test/check-stage-isolation.mjs exists to pin (2026-07-29 audit, S1).
   *   - FORGING A MESSAGE. There is no message type on the stage channel that
   *     records a pick (stageAgentScript's "NO 'select' MESSAGE, DELIBERATELY"),
   *     and this lens's frame is not even in the '.html-stage' walk the listener
   *     identifies senders with, so nothing it posts is dispatched at all.
   *   - COVERING IT. A frame paints only inside its own box, and nothing in the
   *     lens's own CSS takes the body or the frame out of flow (no position,
   *     no z-index -- src/styles.mjs), so the stage has no way to draw over the
   *     bar.
   *
   * What remains, and is accepted rather than solved (ADR 22's Consequences): a
   * mock can draw CONVINCING FAKE CHROME inside its own box. Pressing that does
   * nothing -- which is the point -- but nothing here can stop it being drawn.
   * The real control's fixed home in the bar, above and outside the frame, is the
   * whole of the mitigation.
   *
   * The label is agent-authored board content and lands via 'textContent': no
   * parse, so no markup in a label can ever become an element in this document.
   *
   * THREE STATES WHERE A PICK IS REFUSED, and what this control does in each --
   * every one of them is 'selectVariant''s own guard, mirrored into the chrome so
   * the control never reads as live while being inert:
   *   - readonly (a standalone file: archive): no control at all. There is no
   *     answer to record in an archive -- the send bar is gone and every input is
   *     hard-disabled -- and the diagram lens already sets this precedent by
   *     hosting no comment form there. The archive's stage lens is a viewer.
   *   - a historical round ('aria-disabled' on the card): rendered, disabled. The
   *     card behaves the same way -- visible, still showing which option won,
   *     refusing to change it -- and a control that is present-but-unavailable
   *     says that, where an absent one would read as a missing feature.
   *   - comment mode on: rendered, disabled, for the same reason the card itself
   *     stands down in comment mode (every widget handler does). Decided once, at
   *     open: a modal dialog makes the rest of the page inert, so the toggle
   *     cannot be reached while the lens is up and the state cannot change under
   *     it. */
  function stageLensPick(section) {
    var l = stageLens;
    l.actions.innerHTML = '';
    l.card = null;
    var card = section.closest ? section.closest('.choice-variant') : null;
    if (!card || readonly) return;
    l.card = card;
    var pick = document.createElement('button');
    pick.type = 'button';
    // '.lens-btn' for the bar's own chrome, '.lens-pick' as the accent that
    // makes the one control that RECORDS something look unlike the one that
    // merely closes (src/styles.mjs).
    pick.className = 'lens-btn lens-pick';
    pick.textContent = 'Pick ' + (card.getAttribute('data-choice') || 'this option');
    if (commentMode || card.getAttribute('aria-disabled') === 'true') pick.disabled = true;
    pick.addEventListener('click', function () {
      // The stand-in does not model a browser refusing to fire a click on a
      // disabled button (test/check-archive.mjs's own note on that), and this
      // handler must not be the one place that difference matters -- so the
      // disabled state is re-read here rather than trusted to the platform.
      if (pick.disabled) return;
      // Criterion 8, "in one act": record through the ONE path that records
      // every other pick, then close. selectVariant re-applies all three guards
      // above on its own -- this control is a caller, never an authority -- so
      // a pick that it refuses records nothing and simply closes the lens.
      if (l.card) selectVariant(l.card);
      stageLensClose();
    });
    l.actions.appendChild(pick);
  }

  /** Undo everything stageLensOpen did, and hand focus back to the control that
   * opened it (criterion 12). Idempotent for exactly the reason lensTeardown is:
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
    // criterion 6 does not rest on this line alone -- what it adds is that a
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
    // Criterion 12, Esc. A real browser closes a modal <dialog> on Esc by itself
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
    // Criterion 12, backdrop. Two targets, because "the backdrop" is two
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

  /** Criterion 3, binding half: the control itself is server-rendered
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
   * (async, over postMessage -- ticket 10) rather than reading them directly;
   * only stages isWiredStage recognises (i.e. that have answered 'ready' at
   * least once) are asked, since one that never will can never answer
   * anyway.
   *
   * The queued comments' LIST entries are rebuilt here too (audit finding D3),
   * rather than at each of this function's call sites. A pin and a list entry
   * are two renderings of one array, and they were drifting: every push path
   * (applyRoundPush, applySubmittedPush, applyResync) and the post-Send handler
   * called refreshPins alone, so an amend that replaced a block left the queued
   * comment's hollow pin drawn on the new markup with no list entry beside it --
   * no anchor tag, no text, and, criterion 2's whole point, no delete control,
   * while the comment itself stayed in pendingComments and went out on the next
   * Send. Folding the two together is what stops a future call site
   * reintroducing that by remembering one and forgetting the other; it is
   * document-wide regardless of 'root' on purpose, since provisional numbering
   * spans the whole board (refreshPendingCommentItems' own comment). */
  function refreshPins(root) {
    refreshPendingCommentItems();
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
    // get its hollow pin there immediately, exactly as one queued inline does
    // (DESIGN.md polish ticket 05, criterion 11).
    renderLensPins();
  }

  /** Page-scoped dom pins (ticket 03): every block whose content lives in this
   * document, not an iframe/svg -- see directChildPinLayer below for why this is a
   * shallow, direct-children-only lookup rather than qsa('.pin-layer', section).
   * Called both from refreshPins (resize / a comment just queued / submitted) and
   * once at wire time from wireRoot itself (below) -- unlike the html-stage/
   * mermaid cases, there is no async 'load'/render event to hang the FIRST paint
   * of an already-persisted comment's pin off of, so wireRoot has to do it
   * directly or a board reopened with existing element-level comments would show
   * no pins at all until the next resize. */
  /** Polish ticket 03 (DESIGN.md), criterion 5's "can be dragged taller": measured
   * in real Chrome (not assumed -- the ticket's own warning that resize interacts
   * with max-height in ways worth checking), CSS max-height clamps the rendered
   * box PERMANENTLY, including against the explicit inline height the browser's
   * own resize: vertical drag sets -- a capped <pre> is undraggable for as long
   * as max-height stays in effect, full stop, regardless of specificity or
   * origin. So the cap src/styles.mjs applies (max-height: 480px) is exactly
   * right for the FIRST paint (criteria 5 and 6 alike -- a short block's natural
   * height never reaches it, so nothing here ever touches one), but a genuinely
   * capped block needs that ceiling converted to a plain, breakable height once,
   * so the reviewer's drag actually moves it. Reads the already-rendered box (no
   * line-counting, no guessing at font metrics) and is a no-op the moment it
   * runs a second time, since the inline height it sets no longer leaves
   * anything for max-height to clamp. */
  function unlockCodeCapForDrag(pre) {
    if (pre.__cbCapUnlocked) return;
    // The marker is claimed only once there is a real box to measure (audit
    // finding D1). wireRoot runs against a DETACHED subtree on every push path
    // -- applyRoundPush wires 'wrap'/'frag' before appending, applySubmittedPush
    // wires 'replacement' before the swap, both deliberately (see their own
    // comments on why listeners are attached pre-attach) -- and a detached <pre>
    // reports clientHeight and scrollHeight of 0. Setting the marker first meant
    // the 'scrollHeight > clientHeight' test below was decided as 0 > 0, false,
    // on a permanently-remembered flag: every code block that arrived over SSE
    // was undraggable for the life of the page, and the post-attach
    // refreshPins() that exists precisely to redo detached work (U3) found the
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

  function wirePageDomPins(root) {
    qsa('[data-block-id]', root).forEach(function (section) {
      var layer = directChildPinLayer(section);
      if (layer) renderDomPins(section.getAttribute('data-block-id'), section, layer);
      // Polish ticket 03 (DESIGN.md): renderDomPins' code-block branch clips pins
      // to the <pre>'s own box, but is otherwise only ever re-run from here --
      // on resize, a comment queued, or Send (refreshPins above), never on the
      // pre's own internal scroll. Wired once per <pre> (a marker on the
      // element itself, not a set here, since this whole function re-runs on
      // every one of those triggers and must never stack a second listener
      // inside the same scrolling element).
      if (section.classList && section.classList.contains('code-block')) {
        var pre = section.querySelector('pre');
        if (pre) {
          unlockCodeCapForDrag(pre);
          if (layer && !pre.__cbPinsScrollWired) {
            pre.__cbPinsScrollWired = true;
            pre.addEventListener('scroll', function () {
              renderDomPins(section.getAttribute('data-block-id'), section, layer);
            });
          }
        }
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

  // --- comment mode (ticket 03): a visible toggle gates one generic, page-wide  --
  // hover/click gesture over everything the board renders that is NOT already its
  // own special case (the html stage's and mermaid's own element click handlers,
  // above -- ticket 12: those are no longer a standing exemption from the toggle,
  // the user's 'one gesture, toggle-gated everywhere' decision put an
  // 'if (readonly || !commentMode) return;' guard on both, same as this listener.
  // They stay SEPARATE listeners, not because they are exempt, but because each
  // already mints the more specific anchor shape its surface needs -- a mermaid
  // anchor tied to the clicked node id, or a dom anchor rooted at the iframe's
  // OWN document via buildSteps(doc.body, el) rather than this page's. Letting
  // this generic listener ALSO fire on the same click would either double-mint a
  // second, conflicting anchor for a mermaid node click (wireMermaidBlock's
  // listener lives in this same document, on pre.mermaid, so the click genuinely
  // bubbles here too) or mint a nonsense page-scoped anchor against the iframe
  // element's own boundary (a click on its border/padding is the one part of an
  // html stage this document's listeners CAN see -- content inside the sandboxed
  // document never bubbles out to here at all). ANCHOR_CHROME_SELECTOR below is
  // what keeps both out of this listener's reach.
  //
  // Off by default (commentMode, declared at the top of this script) is what
  // makes criterion 3 true by construction: every ordinary widget handler in
  // wireRoot below has its own "if (commentMode) return;" guard, so turning this
  // OFF (the default, and the only state a reviewer who never finds the toggle
  // ever sees) reproduces ticket 02's behaviour exactly, and turning it ON stands
  // those handlers down so a click anchors instead of mutating an answer.

  // Tag-qualified, same reason as every other id-by-string lookup in this
  // file -- see openCommentForm's own comment above.
  var modeToggleBtn = document.querySelector('button#comment-mode-toggle');

  function setCommentMode(on) {
    commentMode = !!on && !readonly;
    if (modeToggleBtn) {
      modeToggleBtn.classList.toggle('active', commentMode);
      modeToggleBtn.setAttribute('aria-pressed', commentMode ? 'true' : 'false');
      var label = modeToggleBtn.querySelector('.mode-toggle-label');
      if (label) label.textContent = 'Comment mode: ' + (commentMode ? 'on' : 'off');
    }
    document.body.classList.toggle('comment-mode', commentMode);
    if (!commentMode) clearAnchorHover();
    // DESIGN.md polish ticket 05: the lens rides the same body class for its own
    // node hover/cursor affordance (src/styles.mjs's .lens-canvas rules), so the
    // only thing it needs told directly is what its hint line should now say.
    lensUpdateHint();
    // One gesture, toggle-gated everywhere (the user's decision, relayed by the
    // director): every currently-known html stage is told the CURRENT state on
    // every toggle, on or off -- ticket 10 moved the stage's own hover/click
    // into a separate document with no reach for a single page-level
    // 'body.comment-mode' class to cross into (QUIRKS.md "Two stylesheets, one
    // palette"), so each stage clears its own in-progress hover locally the
    // moment it hears 'commentMode: false' (see stageAgentScript's own 'mode'
    // handler) rather than this page reaching in to do it. Iterates frames
    // still live in THIS document, filtered through isWiredStage (see
    // wiredStageFrames' own comment, ticket 09's audit finding U7) -- a frame
    // that was only ever the about:blank placeholder, or one an amend already
    // replaced, is simply absent from 'qsa('.html-stage', document)' and never
    // touched.
    qsa('.html-stage', document).forEach(function (frame) {
      if (!isWiredStage(frame)) return;
      // DESIGN.md polish ticket 02, criterion 12: sentRefs travels alongside
      // commentMode on every toggle, not just at 'ready' -- the moment mode
      // turns on is exactly the moment the stage's hover starts mattering, so
      // it needs the current sent-list right then, not whatever it happened
      // to hear last. section/blockId re-derived per frame (this loop, unlike
      // handleStageReady, does not already have one in scope).
      var section = frame.closest('.html-block');
      var blockId = section && section.getAttribute('data-block-id');
      postToStage(frame, { type: 'mode', commentMode: commentMode, sentRefs: blockId ? sentDomRefsForBlock(blockId) : [] });
    });
  }

  if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', function () {
      if (readonly) return;
      setCommentMode(!commentMode);
    });
  }

  // Chrome that is never an anchor target even while comment mode is on: the
  // comment infrastructure itself (a click there keeps its own, existing
  // meaning), the pins, the mode toggle, a compare side's own label (structural
  // chrome, not authored content), the round's own heading, and pre.mermaid /
  // .html-stage -- ticket 12: NOT because those two are still exempt from the
  // toggle (they aren't, see the comment mode section above), but because each
  // already has its own listener, gated the same way, that mints a more specific
  // anchor for its surface than this generic one could. Excluding them here is
  // what stops this listener from double-anchoring the same click.
  //
  // .stage-wrap (2026-07-29 audit finding U4, routed to ticket 10 by the
  // director once ticket 09 found it working next door): the part of an html
  // OR mermaid stage outside the iframe/svg it wraps -- its own border/padding,
  // never any authored content of its own. Before this line, a click landing
  // there (not chrome-excluded) still found the block's own [data-block-id]
  // section as its anchorRootFor root and minted a page-scoped 'dom' ref
  // against THAT section. For a mermaid block that ref resolves correctly
  // (resolveDomAnchorInSection walks the SAME document the block re-renders
  // into); for an html block it does not -- the server's 'resolveComment'
  // resolves EVERY 'dom' anchor on an html-kind block through
  // 'resolveDomAnchor', which roots against the IFRAME's own document, not the
  // page-scoped section the click actually minted the ref against. A ref built
  // from one tree and resolved against a different one can coincidentally
  // resolve to an unrelated element inside the mock rather than reporting
  // lost -- the exact false-positive-resolution failure mode this whole spec
  // exists to rule out. Simplest correct fix (the director's call, weighed
  // against a wire-format 'root' discriminator that would need coordinating
  // with ticket 08 mid-flight, for a gesture -- anchoring a stage's own blank
  // padding -- nothing needs): exclude '.stage-wrap' outright, on both stage
  // kinds, the same way '.html-stage'/'pre.mermaid' already are. Does NOT
  // change what a click INSIDE either stage mints -- the html stage's own
  // postMessage-minted ref (ticket 10) and mermaid's own node-click ref are
  // untouched; only the wrap's own dead padding stops being anchorable.
  //
  // .diagram-lens (polish ticket 05, DESIGN.md): the lens dialog is a direct child
  // of <body>, so nothing inside it has a [data-block-id] ancestor and this
  // listener would already find no root for a click there -- EXCEPT that the
  // block's own comment form is moved into the lens while it is open, and that
  // form does carry data-block-id. Excluding the lens outright keeps the generic
  // gesture out of it entirely (hover marking included) and leaves the lens's own
  // listener, which mints the specific mermaid anchor its surface needs, as the
  // only thing that answers a click in there.
  //
  // .variant-label (SPEC_MIGRATION.md criterion 2): a choose-between-rendered-variants option's own
  // caption (its label/description) -- structural chrome naming the option, not
  // authored content, exactly the same reasoning as .compare-label just above
  // it. Without this, clicking the caption would fall through to the enclosing
  // QUESTION block's own section (the nearest [data-block-id] above it, since
  // .variant-card itself carries no data-block-id of its own) and mint a
  // page-scoped anchor there -- harmless, but not what a click on a caption
  // should mean.
  var ANCHOR_CHROME_SELECTOR = '.block-kicker, .comment-btn, .comment-form, .comment-target, '
    + '.comment-list, .pin-layer, .anchor-pin, .mode-toggle, .compare-label, .variant-label, .round-label, '
    + 'pre.mermaid, .html-stage, .stage-wrap, .diagram-lens';

  function isAnchorChrome(el) {
    return !!(el.closest && el.closest(ANCHOR_CHROME_SELECTOR));
  }

  // The nearest block section a click/hover target lives in -- the root a page-
  // scoped dom anchor's path is measured from (src/anchor.mjs's design comment).
  // Self-inclusive, matching real closest(); returns null for anything outside
  // .blocks entirely (the header, the mode toggle, the send bar), which is what
  // keeps this gesture from ever reaching page chrome without an explicit
  // exclusion list for each of them.
  function anchorRootFor(el) {
    return el.closest ? el.closest('[data-block-id]') : null;
  }

  // ADR "Commenting is confined to content blocks" (2026-08-01): question and
  // compare are wrappers, not content -- a comment anchored to either names no
  // item the agent can act on. This is a kind check on the ROOT the click/hover
  // actually landed on, not a chrome-selector addition, because a chrome
  // selector can only exclude specific elements *within* a section; it can't
  // stop the section itself from being a valid anchorRootFor result. And
  // anchorRootFor's closest('[data-block-id]') already finds the NESTED
  // section first, so this only ever fires when 'root' IS the question/compare
  // section itself: a click on a question's prompt, an option card, a rank
  // item, the answer textarea, the note field or the status line, or on a
  // compare's kicker, grid, a side's label, or a side with no content block,
  // all resolve 'root' to that wrapper section directly, since none of them
  // sit inside a nested [data-block-id] of their own. A block nested one level
  // in -- a question's context entry, a compare side's content -- renders
  // through the same renderBlock dispatch as every other block (src/render.mjs)
  // and so carries its OWN data-block-id/data-block-kind, which
  // closest('[data-block-id]') finds first, before ever reaching the wrapper;
  // its root's kind is markdown/mermaid/html/code, not question/compare, so it
  // stays fully live and untouched by this check.
  var NON_ANCHORABLE_BLOCK_KINDS = { question: true, compare: true };
  function isNonAnchorableRoot(root) {
    return !!(root && NON_ANCHORABLE_BLOCK_KINDS[root.getAttribute('data-block-kind')]);
  }

  var anchorHovered = null;
  function clearAnchorHover() {
    if (anchorHovered && anchorHovered.classList) {
      anchorHovered.classList.remove(STAGE_HOVER_CLASS);
      // DESIGN.md polish ticket 02, criterion 12: the de-affordance class the
      // mouseover handler below applies instead of STAGE_HOVER_CLASS when the
      // hovered element already carries a SENT comment.
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
    // Marks ONLY ev.target (criterion 2: "that element, and not its ancestors") --
    // never walked up, exactly like the iframe's own hover handler above.
    anchorHovered = el;
    // DESIGN.md polish ticket 02, criterion 12: an element that already carries a
    // SENT comment is visibly not a comment target -- de-affordanced (no
    // outline, cursor: not-allowed via .cb-anchor-sent in src/styles.mjs)
    // rather than marked with the ordinary "you can anchor here" outline.
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
    // Criterion 12: already carries a SENT comment -- no longer a comment
    // target, clicking it does nothing.
    if (isSentAnchor(blockId, anchor)) { clearAnchorHover(); return; }
    clearAnchorHover();
    // Criterion 1: a second click on an element that already has a QUEUED
    // (unsent) comment reopens and edits it, rather than minting a duplicate.
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
   * belongs -- SPEC_STAGES criterion 8's lens pick control is a second caller,
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
  }

  // --- wiring, factored so it can run once at hydrate (root = document) and again
  // on just a freshly-inserted subtree after an SSE push (see applyRoundPush below)
  // -- an already-wired, already-filled-in element is never touched twice. ---------

  function wireRoot(root) {

  // --- single-choice: one selection per question -----------------------------

  qsa('.choice-single', root).forEach(function (btn) {
    var qid = btn.getAttribute('data-question-id');
    var choice = btn.getAttribute('data-choice');
    if (selections[qid] === choice) btn.classList.add('selected');
    btn.addEventListener('click', function () {
      // commentMode: ticket 03's generic click-to-anchor listener (below) owns
      // this click instead -- see its own comment for why every ordinary widget
      // handler stands down rather than firing alongside it.
      if (readonly || commentMode) return;
      selections[qid] = choice;
      touched[qid] = true;
      qsa('.choice-single[data-question-id="' + qid + '"]').forEach(function (b) {
        b.classList.toggle('selected', b === btn);
      });
    });
  });

  // --- multi-select: independently toggled cards ------------------------------

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
  // No stage-message path feeds this. An earlier version had the html-stage
  // agent (stageAgentScript, src/render.mjs) report every click over
  // postMessage so one landing on the visible mock content could select the
  // card too -- reverted before this ticket merged: that message is
  // STAGE-AUTHORED input (the mock's own script can dispatch a click on
  // itself with no reviewer involved, and separately can forge the message
  // directly, since origin/identity validation only prove SOME live stage
  // sent it, never that a human did), and letting it pick an answer is the
  // agent handing itself the answer to its own question -- see
  // stageAgentScript's own "NO 'select' MESSAGE, DELIBERATELY" comment. An
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

  // --- free text: the answer itself, separate from the per-question note -----

  qsa('textarea[data-answer-for]', root).forEach(function (ta) {
    var qid = ta.getAttribute('data-answer-for');
    ta.addEventListener('input', function () {
      if (readonly) return;
      selections[qid] = ta.value;
      touched[qid] = true;
    });
  });

  // --- drag-to-rank: native HTML5 drag and drop reorder -----------------------
  //
  // The gesture itself can't be asserted without a browser (see DESIGN.md
  // Testing); what matters for the node checks is that the answer ends up as the
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

  // --- per-question note (every widget carries one) ---------------------------

  qsa('textarea[data-note-for]', root).forEach(function (ta) {
    var qid = ta.getAttribute('data-note-for');
    if (notes[qid]) ta.value = notes[qid];
    ta.addEventListener('input', function () {
      if (readonly) return;
      notes[qid] = ta.value;
    });
  });

  // --- per-question defer: distinct from simply leaving a question blank -----

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
    });
  });

  // --- comments: block-level, an inline markdown-anchor button, or an element-  --
  // level click inside an html stage / mermaid diagram (ticket 06, wired further
  // below) -- all target the one shared comment-form for their block, via
  // openCommentForm (declared above wireRoot, alongside the other anchor helpers
  // it's shared with).

  // This loop wires BOTH shapes src/render.mjs's commentButton emits, and they
  // are not the same gesture (DESIGN.md polish criteria 1 and 12, audit findings
  // P1/P2):
  //
  //   kind 'block'  the whole-block "Add comment" affordance. Several separate
  //                 remarks on one block stay legal -- this codebase's own
  //                 design says so explicitly (removePendingComment's comment,
  //                 src/anchor.mjs, is keyed by entry id precisely because
  //                 several queued comments can legitimately share this
  //                 anchor), so it never edits and never de-affordances.
  //   kind 'md'     the inline anchor button injected after a markdown heading
  //                 or list item (injectAnchorButtons, src/render.mjs). This IS
  //                 an anchored element, and the ONLY producer of 'md' anchors
  //                 on the page -- so it takes exactly the same two rules the
  //                 'dom' and 'mermaid' gestures already take: a second click
  //                 on one that already carries a QUEUED comment reopens and
  //                 edits it rather than minting a duplicate (criterion 1), and
  //                 one that already carries a SENT comment is not a comment
  //                 target at all (criterion 12).
  //
  // Both rules were absent here until finding P1/P2: this handler called
  // openCommentForm with four arguments -- no editing lookup, no sent gate --
  // so clicking a heading anchor twice queued two independent comments with two
  // pins, which is verbatim the Problem statement this batch exists to fix and
  // is the alternative the spec's Decisions explicitly reject ("a second click
  // on an anchored element edits, it does not add").
  //
  // The sent gate is NOT conditioned on comment mode, unlike the hover
  // de-affordance below: this button is live in both modes, and a sent comment
  // is immutable in both. What IS comment-mode-scoped is the VISIBLE half --
  // .cb-anchor-sent, whose stylesheet rule requires body.comment-mode (the
  // spec's Decision: "de-affordanced in comment mode only ... the reading view
  // stays unmarked"). Stamped at wire time from board.comments, and correct for
  // as long as that stays true of this button: sent-ness only ever changes
  // through a real Send, which replaces the whole round section server-side and
  // re-runs this loop over the replacement (applySubmittedPush).
  qsa('.comment-btn', root).forEach(function (btn) {
    var blockId = btn.getAttribute('data-block-id');
    var anchorKind = btn.getAttribute('data-anchor-kind') || 'block';
    var anchorRef = btn.getAttribute('data-anchor-ref') || '';
    var anchorLabel = btn.getAttribute('data-anchor-label') || '';
    // Only an ANCHORED kind gets an identity to match a queued or sent comment
    // against; 'block' deliberately gets none, which is what keeps it additive.
    var anchor = anchorKind === 'md' ? { kind: 'md', ref: anchorRef } : null;
    if (anchor && isSentAnchor(blockId, anchor)) btn.classList.add('cb-anchor-sent');
    btn.addEventListener('click', function () {
      if (readonly) return;
      if (anchor && isSentAnchor(blockId, anchor)) return;
      openCommentForm(blockId, anchorKind, anchorRef, anchorLabel, '',
        anchor ? findPendingCommentForAnchor(pendingComments, blockId, anchor) : null);
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
      // Ticket 05: a diagram node's anchor carries the generic domRef/hint
      // alongside its node-id ref -- see src/anchor.mjs's "ticket 05 design"
      // comment for why. Read regardless of anchorKind (harmless: only the
      // 'mermaid' branch below uses it), same as every other attribute here.
      var anchorDomRef = form.getAttribute('data-anchor-domref') || '';
      var anchor = anchorKind === 'md' ? { kind: 'md', ref: anchorRef, label: anchorLabel }
        : anchorKind === 'dom' ? { kind: 'dom', ref: anchorRef, hint: anchorLabel }
        : anchorKind === 'mermaid' ? { kind: 'mermaid', ref: anchorRef, domRef: anchorDomRef, hint: anchorLabel }
        : { kind: 'block' };
      // DESIGN.md polish ticket 02 criterion 1: a form reopened on an anchor that
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
      // The pin lands NOW, not after Send: a queued comment has no server-assigned
      // n, so commentsWithPending mints a provisional one continuing the sequence
      // and placePin draws it hollow (.pin-pending). Re-rendering the whole layer
      // rather than appending one pin is what keeps the provisional numbers
      // consistent as more comments queue up behind this one. The comment-list
      // entries are rebuilt the same way (refreshPins calls
      // refreshPendingCommentItems -- finding D3), not just appended to --
      // editing in place must not also produce a stray second list entry for
      // the same, now-updated queue item.
      refreshPins(document);
      input.value = '';
      form.removeAttribute('data-editing-id');
      form.classList.remove('open');
      var targetEl = document.querySelector('div#comment-target-' + blockId);
      if (targetEl) targetEl.classList.remove('open');
    });
  });

  // --- element-level anchoring inside an html stage (ticket 10) ---------------
  //
  // Nothing to wire here, on purpose: before this ticket, this loop reached into
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

  // Criterion 3 (SPEC_STAGES): bind the expand control on every html stage under
  // this root. Unlike the anchoring wiring above there IS something to do here --
  // the control lives in the block's kicker, in THIS document, so it needs no
  // message from the stage to become bindable.
  qsa('.html-block', root).forEach(function (section) { wireStageExpand(section); });

  // Page-scoped dom pins (ticket 03): same-document content needs no 'load' event
  // to wait on, so this runs synchronously, right here, for whatever root wireRoot
  // was just given -- see wirePageDomPins's own comment for why this can't just
  // wait for the next refreshPins call.
  wirePageDomPins(root);

  } // end wireRoot

  wireRoot(document);

  // --- click a comment's list entry to highlight the thing it is about ---------
  //
  // A markdown-anchored comment names a heading or list item that is right there
  // on the page; .anchor-target (src/styles.mjs) outlines it. Delegated from the
  // document rather than wired per element inside wireRoot, deliberately: entries
  // appear three ways -- server-rendered at load, appended locally the moment a
  // comment is queued, and inside a round pushed over SSE -- and a single
  // delegated listener covers all three without any risk of the double-registration
  // that scoping every wireRoot loop to 'root' exists to prevent.
  //
  // Not gated on readonly: highlighting reads the page, it never mutates the
  // board, and it is exactly as useful in a standalone archive as in a live tab.

  function highlightAnchor(blockId, ref) {
    qsa('.anchor-target').forEach(function (el) { el.classList.remove('anchor-target'); });
    if (!ref) return;
    var section = findBlockEl(document, blockId);
    if (!section) return;
    // Matched by iteration, never by splicing ref into a selector string: a ref
    // containing a quote or bracket would otherwise throw or match the wrong
    // element (same reasoning as findBlockEl / renderMermaidPins above).
    var target = null;
    qsa('.md-content [id]', section).forEach(function (el) {
      if (!target && el.getAttribute('id') === ref) target = el;
    });
    if (!target) return;
    target.classList.add('anchor-target');
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
  }

  document.addEventListener('click', function (ev) {
    var item = ev.target && ev.target.closest ? ev.target.closest('.comment-item') : null;
    if (!item) return;
    // DESIGN.md polish ticket 02: the delete "x" has its own listener, just below --
    // it must not ALSO trigger this entry's highlight-on-click behaviour.
    if (ev.target.closest && ev.target.closest('.comment-delete')) return;
    if (item.getAttribute('data-anchor-kind') !== 'md') return;
    highlightAnchor(item.getAttribute('data-block-id'), item.getAttribute('data-anchor-ref'));
  });

  // --- delete a queued (unsent) comment from its own list entry -----------------
  // (DESIGN.md polish ticket 02, criterion 2). Delegated from the document, same
  // reasoning as the highlight listener just above: a pending entry can appear
  // at any time after hydrate (queued locally, or -- reopened and re-edited --
  // rebuilt by refreshPendingCommentItems), so there is no single wireRoot pass
  // that could wire a "delete" button once and for all. A SENT comment's
  // server-rendered entry never carries a '.comment-delete' at all (criterion 3),
  // so this can never reach one.

  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.comment-delete') : null;
    if (!btn || readonly) return;
    ev.preventDefault();
    var item = btn.closest('.comment-item');
    if (!item) return;
    var id = Number(item.getAttribute('data-pending-id'));
    pendingComments = removePendingComment(pendingComments, id);
    refreshPins(document); // rebuilds the list entries too -- finding D3
    // A form still open, reopened (criterion 1) on the entry just deleted
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
  var MERMAID_TOKEN_MAP = ${JSON.stringify(MERMAID_TOKEN_MAP)};

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
  // Audit finding M2: a renamed/removed token (MERMAID_TOKEN_MAP naming a
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

  // Audit findings D1/D2: every mermaid pass below -- the very first render,
  // a later SSE push's render of newly-inserted nodes, or a theme-triggered
  // redraw -- is queued onto this ONE module-scoped promise chain instead of
  // running the moment it's called. Real mermaid 11 claims a node's
  // data-processed flag and does innerHTML = '' before its own first
  // internal per-node await, so two passes that are merely STARTED (not
  // SETTLED) can still write to the SAME node in the same tick: the newer
  // pass's restore-to-source can land on a node the older pass has already
  // begun re-rendering, and the older pass's eventual innerHTML = svg can
  // land back on that node before the newer pass ever reaches it -- so the
  // newer pass ends up parsing the OLDER pass's rendered SVG as if it were
  // diagram source (D1's "Maximum text size in diagram exceeded" /
  // "Syntax error in text", permanently, since nothing redraws it again
  // until the NEXT theme change). Queuing makes "started" and "settled" the
  // same event for every caller here: a pass's own function body does not
  // even begin running until every previously queued pass has fully
  // resolved, so no pass can ever observe another pass's half-finished node.
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

  // D1's other half, "coalesce redundant redraws": three theme clicks with
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
    // Ticket 04: stash each node's raw diagram source before mermaid ever
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
        mermaidMod = window.mermaid
          || (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
      }
      // Audit finding M1: initialize before EVERY run(), not once ever, on
      // whatever mermaidMod already is -- gating this behind "only the first
      // time the engine loads" is exactly how a round that arrives long
      // after the reader switched theme (with no live diagram in between to
      // trigger a redraw) used to get drawn in a palette nobody chose.
      // Mermaid's 'base' theme is the only one that takes themeVariables, so
      // the diagram is drawn from the same tokens as everything around it.
      var vars = mermaidThemeVariables();
      // M2: an unresolved token must not reach initialize -- funnel it
      // through the SAME catch as offline/CDN failure below, so it degrades
      // the same honest way: the source fallback, never a wiped diagram.
      if (!vars) throw new Error('mermaid theme token unresolved');
      mermaidMod.initialize({ startOnLoad: false, theme: 'base', themeVariables: vars });
      await mermaidMod.run({ nodes: nodes, suppressErrors: true });
    } catch (e) { /* offline, CDN failure, or an unresolved theme token: fall through to the source fallback below */ }
    nodes.forEach(function (n) {
      var svg = n.querySelector('svg');
      if (svg) { wireMermaidBlock(n, svg); return; }
      // Audit finding D2: 'no svg' here is supposed to mean mermaid genuinely
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

  // Ticket 04: re-run every diagram already on the page against whatever the
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
    // M2: validate BEFORE the destructive restore below -- an unresolved
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
    // Only nodes this pass could RESTORE may be handed to run(). An unstashed node is
    // one that appeared after the queue snapshot -- applyRoundPush attaches a new
    // round's <pre class="mermaid"> synchronously, so a redraw already queued when a
    // round lands sees it here with no stash. Rendering it anyway (which this used to
    // do: the restore skipped it, the run did not) let the render pass that follows
    // stash its RENDERED SVG TEXT as if it were diagram source. The next theme switch
    // then restored that text, mermaid failed to parse it, and the diagram was
    // permanently an error graphic -- a third and fourth switch never recovered it
    // (audit 2026-07-31 R1). The render pass owns first-render for those nodes and will
    // stash them correctly; leaving them alone here is what lets it.
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
      // M2 continued: initialize moved INSIDE the try (it used to sit
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
    // fresh nodes (criterion 12 inside the lens). See lensRetheme.
    lensRetheme();
  }
  function redrawMermaidForTheme() {
    var myGeneration = ++mermaidRedrawGeneration;
    return queueMermaidTask(function () {
      // D1: superseded by a newer redraw request before this one's own turn
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
  window.addEventListener('${THEME_CHANGE_EVENT}', function () { redrawMermaidForTheme(); });

  // Cheap, partial mitigation for pin drift: reposition every pin on a window
  // resize. Does not track an iframe's own internal scroll or its resize-drag
  // handle (DESIGN.md puts gesture-level fidelity like this outside automated
  // scope; a known, accepted gap rather than an attempt at full continuous
  // tracking).
  // Repositioning only -- refreshPins (above) deliberately does not re-run the
  // click-listener wiring, or every resize would stack another click handler on
  // the same iframe/diagram.
  window.addEventListener('resize', function () { refreshPins(document); });

  // --- the two ways out: Send, and Discuss in chat -----------------------------
  //
  // DESIGN.md Decisions -> "Two ways out, plus a wall clock": beside Send the
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

  // Tag-qualified, same reason as every other id-by-string lookup in this
  // file (see openCommentForm's own comment) -- '## Send btn' is exactly as
  // mintable as '## Board data', and unlike the board-data collision (which
  // throws and kills the whole script) this one is silent: the handler binds
  // to the heading instead of the button, and Send just never fires (audit
  // finding P2).
  var sendBtn = document.querySelector('button#send-btn');
  var discussBtn = document.querySelector('button#discuss-btn');
  var sendStatus = document.querySelector('span#send-status');
  var sendBar = document.querySelector('div.send-bar');

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
   * order -- criterion 3's own completeness rule (a 'deferred' question is
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

  /** The round this page can still submit: the latest round that is not yet sent.
   * Posted with the body so the server can refuse a submit aimed at a round that
   * already went out (409) instead of silently rewriting it. */
  function openRoundNumber() {
    var n = null;
    (board.rounds || []).forEach(function (r) { if (r.status !== 'sent') n = r.n; });
    return n;
  }

  // --- round badge: "round N of M" (polish ticket 04, DESIGN.md) -----------------
  //
  // N is the topmost round crossing the sticky header line, via
  // IntersectionObserver with a root margin matching the header -- no scroll
  // handler (Decisions). Verified in real Chrome (not just this page's own DOM
  // stand-in, which has no IntersectionObserver at all): a first attempt shrank
  // the observed band to a literal 1px line at the header's bottom edge, which
  // is exactly what the spec's wording describes -- and is real-browser-false.
  // A programmatic scroll (this page sets 'html { scroll-behavior: smooth }',
  // and criterion 9's own jump uses it) animates over several frames;
  // IntersectionObserver only samples at rendering steps, not continuously, so
  // a 1px band can have a .round section's edge land on either side of it
  // between two consecutive samples without either sample ever reporting
  // it intersecting -- confirmed by recreating the exact observer mid-scroll
  // and watching it report every section not-intersecting even though the
  // header line plainly passed through one of them moments before. ROUND_BAND_PX
  // below is the fix: a band with real thickness immediately under the header,
  // not a mathematical line -- thick enough that no realistic scroll step jumps
  // over it, thin enough to still mean "right at the header", not "anywhere in
  // the viewport". Since .round sections stack with no overlap, both are
  // essentially never simultaneously in the band except for the moment the gap
  // between two rounds passes through it, and the last entry processed in that
  // rare batch wins (qsa/IntersectionObserver both preserve document order, so
  // that is the LOWER section, i.e. the one the reviewer is arriving at).
  //
  // badgeCurrentRound is set ONLY from the observer callback -- never reset by
  // an SSE push arriving further down the page, which must not yank the
  // reviewer's read position back to round 1 -- only M (board.rounds.length)
  // changes on a push; see renderBadge, and applyRoundPush/applySubmittedPush/
  // applyResync further down, all of which call it after advancing 'board'.
  //
  // Guarded on IntersectionObserver existing at all: neither this page's own
  // check suite's DOM stand-in nor a very old browser defines it, and the badge
  // simply keeps whatever text it was last given rather than throwing.
  var ROUND_BAND_PX = 96;
  var badgeCurrentRound = (board.rounds && board.rounds[0]) ? board.rounds[0].n : 1;
  var roundObserver = null;
  var sendBarDockObserver = null;

  function renderBadge() {
    var el = document.querySelector('button#round-badge');
    if (el) el.textContent = badgeLabel(badgeCurrentRound, (board.rounds || []).length);
  }

  function headerHeight() {
    var header = document.querySelector('.board-head');
    return header ? Math.round(header.getBoundingClientRect().height) : 0;
  }

  /** (Re)build the observer against the CURRENT header height and viewport, and
   * watch every .round section on the page. Called at hydrate and on resize --
   * the header's own height changes at the narrow-viewport breakpoint
   * (src/styles.mjs), and IntersectionObserver has no API to edit a live
   * instance's rootMargin, so a resize means throwing the old one away and
   * re-observing every section fresh. */
  /** The last '.round' whose own top edge is at or above the header line -- i.e.
   * the round you are actually reading, decided by position rather than by
   * intersection. The fallback for the case the band CANNOT answer (finding
   * NEW-1): the band is a fixed strip at [h, h + ROUND_BAND_PX] from the
   * viewport top, but the page cannot scroll past its own end, and there is
   * ~222px of slack below the last round (the .blocks gap, the send bar, and
   * .board-shell's 128px bottom padding). So the LAST round has to be taller
   * than roughly 'innerHeight - 222 - (h + ROUND_BAND_PX)' -- about 414px at an
   * 813px viewport, ~700px on a large display -- before it can ever reach the
   * band at all. Measured in Chrome: a 169px round 2 tops out at y=406 at
   * maximum scroll, never intersects, and the badge sits on 'round 1 of 2' with
   * the reviewer bottomed out on round 2. That short trailing round is normally
   * the freshly-pushed OPEN one, i.e. exactly the round the badge exists to name
   * -- and it also broke criterion 9, since badgeCurrentRound never became the
   * open round and the click's 'already there' guard therefore never fired.
   *
   * The line is roundBandBottom (below), NOT a bare 'headerHeight() +
   * ROUND_BAND_PX', and that difference is the whole of finding NEW-1 -- see
   * that variable's own comment.
   *
   * qsa preserves document order, so the last match is the lowest qualifying
   * section: the one the reviewer has scrolled INTO, not one scrolled past.
   * Since '.round' sections stack without overlapping, "the last one whose top
   * has crossed the line" IS "the one the line is currently inside", which is
   * the Decision's own wording computed directly instead of inferred from which
   * entries the observer happened to include in this batch. */
  function roundAtHeaderLine() {
    var found = null;
    qsa('.round').forEach(function (section) {
      if (!section.getBoundingClientRect) return;
      if (section.getBoundingClientRect().top <= roundBandBottom) found = section;
    });
    return found;
  }

  function setBadgeRound(section) {
    if (!section) return;
    var n = parseInt(section.getAttribute('data-round'), 10);
    if (!isFinite(n)) return;
    badgeCurrentRound = n;
    renderBadge();
  }

  /** How far below the viewport's top the "header line" actually sits, in px.
   * Normally 'headerHeight() + ROUND_BAND_PX' -- but CLAMPED DOWNWARD so the
   * last round can always reach it, which is finding NEW-1.
   *
   * The defect: the band was a fixed strip at [h, h + 96] and the page cannot
   * scroll past its own end. Below the last round sits ~222px of slack (the
   * .blocks gap, the send bar, and .board-shell's 128px bottom padding), so a
   * trailing round has to be roughly 'innerHeight - 222 - (h + 96)' tall --
   * about 414px at an 813px viewport, ~700px on a large display -- before it can
   * EVER enter that strip. A shorter one never does, and that is normally the
   * freshly-pushed OPEN round, i.e. exactly the round the badge exists to name.
   * Measured in Chrome at innerHeight 913, h 81: a 432px round 2 bottoms out
   * with its top at y=243 against a line at y=177 and the badge reads
   * 'round 1 of 2' with the reviewer looking at round 2. Criterion 9 fell over
   * with it, since badgeCurrentRound never became the open round and the click's
   * "already there" guard therefore never fired.
   *
   * A fallback keyed on "nothing is intersecting" does NOT fix this, and it is
   * worth recording why: a tall round 1 SPANS the strip the whole way down and
   * never stops intersecting, so no such callback ever arrives. The line itself
   * has to move. Clamping it to where the last round's top ends up at maximum
   * scroll leaves every ordinary page untouched (a tall last round puts that
   * value far above the line, so the max() keeps the line where it was) and only
   * ever reaches down for the case that is otherwise unreachable. */
  var roundBandBottom = ROUND_BAND_PX;

  function measureRoundBand() {
    var h = headerHeight();
    var viewport = window.innerHeight || 0;
    var line = h + ROUND_BAND_PX;
    var sections = qsa('.round');
    var last = sections.length ? sections[sections.length - 1] : null;
    if (last && last.getBoundingClientRect) {
      var doc = document.documentElement || {};
      // What is still scrollable from wherever we are right now. 'last.top' is
      // relative to the CURRENT scroll, so subtracting this gives its top at
      // maximum scroll regardless of where the reviewer happens to be.
      var remaining = Math.max((doc.scrollHeight || 0) - viewport - (window.scrollY || 0), 0);
      // '+ ROUND_BAND_PX' is not padding, it is what makes the observer FIRE.
      // Clamping the line to exactly where the last round's top comes to rest
      // leaves the section grazing the band's edge with zero intersection AREA,
      // and a zero-area overlap is not an intersection -- no callback, no
      // recompute, and the badge stays wrong for the same reason it was wrong
      // before, one measurement further along. Measured in Chrome: with the
      // line at exactly 243 and round 2 resting at 243, nothing fired at all.
      // Giving the band its ordinary thickness below that resting point means
      // the section crosses the line while there is still scroll left, so the
      // crossing is a real event. Costs nothing on any page where the clamp
      // does not apply, since the max() keeps the ordinary line there.
      line = Math.max(line, Math.ceil(last.getBoundingClientRect().top - remaining) + ROUND_BAND_PX);
    }
    roundBandBottom = Math.min(line, Math.max(viewport - 1, 1));
    return h;
  }

  function setupRoundObserver() {
    if (typeof IntersectionObserver !== 'function') return;
    if (roundObserver) roundObserver.disconnect();
    var h = measureRoundBand();
    var bottom = Math.max((window.innerHeight || 0) - roundBandBottom, 0);
    roundObserver = new IntersectionObserver(function () {
      // The observer is the TRIGGER, never the answer: which entries a batch
      // happens to contain depends on which sections changed state, and the
      // section that should win may not have changed at all (a tall round 1
      // stays intersecting while a short round 2 arrives beneath it). The
      // answer is recomputed positionally instead -- still no scroll handler,
      // which is what the Decision actually asks for.
      setBadgeRound(roundAtHeaderLine());
    }, { rootMargin: '-' + h + 'px 0px -' + bottom + 'px 0px', threshold: 0 });
    qsa('.round').forEach(function (section) { roundObserver.observe(section); });
  }

  /** DESIGN.md round-end criterion 2: the send bar drops its blur scrim and docks flush
   * the instant the round's own end (.round-end -- at most one on the page, see
   * renderRoundSection's own comment) scrolls into view, and floats over content
   * the rest of the time. An IntersectionObserver on the rail itself, same
   * discipline as setupRoundObserver just above and for the same reason (no
   * scroll handler) -- default root/rootMargin/threshold are exactly what "on
   * screen" means here, unlike the round badge's line, which has to dodge the
   * sticky header and therefore cannot use the plain viewport.
   *
   * Guarded twice, belt and suspenders (QUIRKS.md "Readonly is locked twice"):
   * '.send-bar' is already 'display: none' under body.readonly (criterion 6),
   * but bailing here too means an archive never even constructs the observer.
   * Also guarded on IntersectionObserver existing at all -- test/dom-stand-in.mjs
   * has none (QUIRKS.md "The stand-in has no layout"), and a browser too old to
   * have it should still show a working, permanently-floating send bar rather
   * than throw.
   *
   * Re-run wherever setupRoundObserver already is: the set of '.round-end'
   * elements on the page changes exactly when the set of '.round' sections
   * does -- a round arriving over SSE adds one, a round collapsing into history
   * (markRoundHistory) removes one. No '.round-end' at all (every round sent,
   * nothing left to reach) leaves the bar in its ordinary floating state. */
  function setupSendBarDock() {
    if (readonly) return;
    if (!sendBar) return;
    if (typeof IntersectionObserver !== 'function') return;
    if (sendBarDockObserver) sendBarDockObserver.disconnect();
    var rail = document.querySelector('.round-end');
    if (!rail) { sendBar.classList.remove('docked'); return; }
    sendBarDockObserver = new IntersectionObserver(function (entries) {
      var entry = entries[0];
      sendBar.classList.toggle('docked', !!entry && entry.isIntersecting);
    });
    sendBarDockObserver.observe(rail);
  }

  setupRoundObserver();
  setupSendBarDock();
  window.addEventListener('resize', function () { setupRoundObserver(); });

  /** Scroll to the round that still needs an answer. Inert exactly when that is
   * already where you are -- "at the open round there is nothing to take you to"
   * (Decisions) -- and inert when nothing is open at all (every round already
   * sent, nothing left to jump to).
   *
   * Shared by the round badge (DESIGN.md:520, its whole job), the
   * notification's click handler, and arrival from the index (below), all of
   * which want the same destination for the same reason: each is the reviewer
   * saying "take me to the thing that needs an answer". One implementation, so
   * they can never drift into disagreeing about where that is. */
  function jumpToOpenRound() {
    var target = openRoundNumber();
    if (target == null || target === badgeCurrentRound) return;
    var section = document.querySelector('.round[data-round="' + target + '"]');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  }

  var roundBadgeBtn = document.querySelector('button#round-badge');
  if (roundBadgeBtn) {
    // Criterion 9: jumps to the round that still needs an answer.
    roundBadgeBtn.addEventListener('click', jumpToOpenRound);
  }

  // Arriving from the index, whose live rows link to '#open-round'
  // (src/indexpage.mjs): land on the round that still needs an answer rather
  // than on round 1 of a thread the reviewer has already answered most of. A
  // sentinel resolved here, not a native fragment jump to a per-round id --
  // markdown blocks are snapshotted from arbitrary files and their headings mint
  // ids on this very page (test/check-archive-ids.mjs), so no id this page emits
  // for its own structure is safe to navigate by. Inert when nothing is open, and
  // inert when the open round IS the first one (jumpToOpenRound's own guard,
  // badgeCurrentRound still being the first round at hydrate) -- which is the top
  // of the page the browser already put us at. Read defensively: location is
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

  /** Enable/disable BOTH send-bar buttons together. They live in .send-bar,
   * outside any round section, so markRoundHistory (which disables everything
   * inside the round it collapses) never reaches them -- that is precisely how a
   * plain double-click used to submit an already-sent round a second time,
   * duplicating its comments and their pin numbers. Never re-enables anything in
   * readonly mode, where every control is hard-disabled at hydrate. */
  function setSendBarEnabled(on) {
    if (readonly) return;
    if (sendBtn) sendBtn.disabled = !on;
    if (discussBtn) discussBtn.disabled = !on;
  }

  /** One submit path, one fetch, parameterised by action ('send' | 'discuss') --
   * never two divergent copies of the body-building code. Both buttons go
   * disabled for the duration and STAY disabled once the round has gone out; only
   * a genuine failure (or a new round arriving over SSE) re-enables them. */
  function submitBoard(action) {
    if (readonly) return;
    var answers = collectAnswers();
    setSendBarEnabled(false);
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
      if (result && result.alreadySent) {
        // A 409 stored NOTHING (src/board.mjs refuses the submit outright), so
        // every queued comment is still unsent -- and the queue used to be
        // emptied here anyway, alongside the success path, destroying all of
        // them with no undo and no copy anywhere: pendingComments lives only in
        // this page's memory (audit finding D2). Kept instead, pins and list
        // entries untouched, and the reviewer told they still have them, so
        // they go out with the next round rather than having to be retyped from
        // memory.
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
      if (sendStatus) sendStatus.textContent = 'Error: ' + err.message;
      setSendBarEnabled(true);   // nothing went out -- the reviewer must be able to retry
    });
  }

  /** A second entry point into the SAME permission dance notifyRound runs, fired
   * from the one moment the tab is definitely focused: Chrome only raises the
   * prompt in the foreground on a focused tab, and notifyRound's own request
   * happens from the hidden-tab branch -- the one moment it CAN'T. A reviewer
   * stranded at "default" would otherwise have no way to reach "granted" short
   * of a round landing while they happen to be looking away. Request only, never
   * a Notification -- that stays notifyRound's job alone. */
  function requestNotifyPermissionFromSend() {
    if (readonly) return;
    if (typeof Notification === 'undefined') return;
    try {
      if (Notification.permission !== 'default') return; // granted: nothing to do; denied: never re-prompt
      var req = Notification.requestPermission();
      if (req && typeof req.then === 'function') req.then(function () {}, function () { /* ignore */ });
    } catch (e) { /* degrade silently -- must never block or delay the submit */ }
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      if (readonly) return;
      // Already armed (by this click path or by Cmd+Enter -- one shared
      // sendArmed flag, see "Cmd+Enter board traversal" below): this press IS
      // the confirmation, identically to a second chord. Submit unconditionally,
      // with no re-check of what is still outstanding -- an armed button always
      // means "send what's here now", the same contract the keyboard path
      // already has (criterion 5).
      if (sendArmed) {
        disarmSend();
        requestNotifyPermissionFromSend();
        submitBoard('send');
        return;
      }
      // Criterion 3 and 4: a 'deferred' question is complete, only an
      // 'unanswered' one is outstanding -- and an outstanding question arms
      // the button instead of sending. Reuses collectAnswers's own rule via
      // outstandingBlocks, so this can never drift from what submitBoard is
      // about to post.
      var outstanding = outstandingBlocks();
      if (outstanding.length) {
        armSendGuard(outstanding);
        return;
      }
      requestNotifyPermissionFromSend();
      submitBoard('send');
    });
  }
  if (discussBtn) {
    discussBtn.addEventListener('click', function () {
      if (readonly) return;
      submitBoard('discuss');
    });
  }

  // --- Cmd+Enter board traversal, and the Send guard --------------------------
  //
  // A single document-level keydown listener is the whole keyboard path through
  // a board -- there was none before this. Plain Enter is deliberately left
  // alone everywhere: both textareas on a board (the answer box for a 'text'
  // widget, and every question's note field) legitimately take newlines, so
  // only the modified chord (meta or ctrl -- no platform detection, that exact
  // test on every platform) is ever intercepted.
  //
  // Advancing to Send is a two-step confirm, not a one-shot send: the first
  // chord at the last question (or already on Send) ARMS the button -- focuses
  // it, relabels it, submits nothing -- and only a SECOND chord while armed
  // calls submitBoard('send'), identically to a mouse click. The deliberate
  // second keystroke is the confirmation, the same way a single click is a
  // deliberate act. Escape disarms without sending. Discuss has no keyboard
  // path at all: it ends board posting for the whole session and is
  // irreversible, so it stays mouse-only by design.
  //
  // Advance always targets the NEXT question's note field, never "the next
  // unanswered one" -- a key that jumps a different distance depending on
  // invisible state is worse than a predictable one.
  //
  // sendArmed is shared with the plain mouse click on Send (see the sendBtn
  // listener above, which calls armSendGuard/disarmSend below) -- one flag,
  // not two independently tracked "armed" states, so Escape disarms whichever
  // way the button got armed and a press from either input is what a second
  // press from EITHER input expects: submit. The two arm flavors stay visually
  // distinct because they mean different things -- armSend (keyboard, reaching
  // the end of a traversal) is "you're done, confirm"; armSendGuard (a click
  // with questions still outstanding, DESIGN.md round-end criteria 3-5) is "this
  // round isn't finished, are you sure" -- but both set the identical sendArmed
  // flag and both are undone by the identical disarmSend.

  var sendArmed = false;
  var sendOriginalLabel = sendBtn ? sendBtn.textContent : '';
  var flaggedBlock = null; // the outstanding question-block armSendGuard rang, if any

  function armSend() {
    if (!sendBtn) return;
    sendBtn.focus();
    sendBtn.textContent = 'Press Enter again to send';
    sendArmed = true;
  }

  /** The click guard's own arm: scrolls to and rings the first outstanding
   * question (outstanding[0], already in round order -- see
   * outstandingBlocks) and relabels Send with the count and its warning
   * treatment, correctly singular at exactly one. Never called with an empty
   * outstanding array -- the sendBtn click listener only reaches here when
   * there is something to flag. */
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
      // Only the guard flavor touches the warning class, the ring, and
      // send-status -- armSend (plain keyboard arm) never sets any of these,
      // so a Cmd+Enter arm/disarm leaves send-status exactly as it found it.
      sendBtn.classList.remove('warn');
      flaggedBlock.classList.remove('flagged');
      flaggedBlock = null;
      if (sendStatus) sendStatus.textContent = '';
    }
  }

  /** Focus a question block's note field and bring it on screen -- the same
   * guarded scrollIntoView shape highlightAnchor and the round-badge click
   * handler above already use, so a DOM stand-in with no scrollIntoView at
   * all still runs this without throwing. */
  function focusNoteField(block) {
    var el = block && block.querySelector ? block.querySelector('[data-note-for]') : null;
    if (!el) return;
    el.focus();
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  }

  document.addEventListener('keydown', function (ev) {
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
    // was a real hole (director /check finding): #discuss-btn is a genuine
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

    ev.preventDefault(); // every branch below either arms Send or moves focus -- never leave the chord to the textarea
    var blocks = qsa('.round-open .question-block'); // the exact set, exact order, collectAnswers itself walks
    if ((target && target.closest && target.closest('button#send-btn')) || blocks.length === 0) {
      armSend();
      return;
    }
    var current = target && target.closest ? target.closest('.question-block') : null;
    var idx = current ? blocks.indexOf(current) : -1;
    if (idx === -1) {
      // Focus is on the body, the header, etc. -- not inside any open
      // question block. Start the traversal from the top.
      focusNoteField(blocks[0]);
    } else if (idx === blocks.length - 1) {
      armSend();
    } else {
      focusNoteField(blocks[idx + 1]);
    }
  });

  // --- "Open once, then badge and notify" (DESIGN.md Decisions) ------------
  //
  // The tab is opened exactly once, for a thread's first board; every later round
  // arrives over SSE into that same tab, so the page itself has to be what tells
  // the reviewer something new landed. Two marks, both page-side, neither of which
  // steals focus (the whole reason the tab is not reopened): a countless "you owe
  // an answer" pip drawn onto a data-URI favicon, and -- only when this document
  // is hidden or unfocused -- a system notification that does carry the round
  // number, because Notification Center is not a tab strip glanced at in passing.
  // The title used to carry a "(n) " prefix too; it doesn't any more -- knowing
  // you owe an answer is worth a glance, knowing it's three answers wasn't worth
  // the extra mark, so document.title is just left alone.
  //
  // Every part degrades silently and never blocks: no canvas, no Notification
  // constructor, permission denied or a throw from any of them leaves the round
  // pushed and the page working, just unmarked. Permission is requested lazily, on
  // the first round that would actually notify, never at load. All of it is inert
  // in readonly mode -- there is no SSE connection there to push a round in the
  // first place, and every entry point below returns early on 'readonly' anyway,
  // so the standalone file:// archive neither draws a mark nor asks for anything.

  var pendingRounds = 0;
  var baseTitle = document.title;
  var faviconLink = null;
  var baseFavicon = null;

  /** Draw the countless pending mark as a data URI: no digit anywhere -- it is the
   * page's own mark with the two colours SWAPPED, an ink tile carrying an amber
   * pip. Canvas, not a file: PROTOCOL.md's zero-dependency /
   * single-self-contained-file rule means no new asset can ship beside the page.
   * Returns null if canvas is unavailable, and the caller just leaves the favicon
   * alone. Both colours are interpolated from src/styles.mjs's dark palette so the
   * pip and the tile it replaces can't drift apart (they had: this used to paint a
   * hardcoded blue that was two palette edits behind --accent).
   *
   * Inverted rather than drawn on the amber tile, because --warning is already how
   * the product says "waiting on you" everywhere else (.live-dot,
   * .pending-badge.has-pending): an amber pip on an amber tile is the same object
   * as idle at 16px, and the tab this has to work in is by definition the
   * unfocused one, where a value flip is the only change peripheral vision
   * reliably catches. Same rx 9 as the mark, so idle and pending are one object in
   * two states rather than two shapes -- which is also why the tile is a roundRect
   * and not the circle this used to draw. roundRect needs Safari 16.4+ /
   * Chrome 99+, fine for a macOS-only tool, and where it is missing the catch
   * below returns null and the tab keeps its unbadged mark. See ADR.md entry 12. */
  function drawFavicon() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '${palettes.dark['--bg']}';
      ctx.beginPath();
      ctx.roundRect(0, 0, 32, 32, 9);
      ctx.fill();
      ctx.fillStyle = '${palettes.dark['--warning']}';
      ctx.beginPath();
      ctx.arc(16, 16, 6, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png');
    } catch (e) { return null; }
  }

  /** Show (pending truthy) or hide (falsy) the tab's countless favicon mark.
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
      var href = drawFavicon();
      if (href) faviconLink.setAttribute('href', href);
    } catch (e) { /* no favicon mark; the notification still covers a hidden tab */ }
  }

  /** A notification INSTEAD of a focus steal, and only when the reviewer isn't
   * already looking: a visible, focused tab already shows the round, so notifying
   * would be noise. Nothing here ever pulls the window forward UNBIDDEN -- the
   * one exception is the notification's own click handler below, because a
   * click on it is the reviewer asking to be brought back. */
  function notifyRound(n) {
    if (readonly) return;
    if (typeof Notification === 'undefined') return;
    var unfocused = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (!unfocused) return;
    var body = 'Round ' + n + ' is waiting for you.';
    function fire() {
      // The tag carries the round number so round 3 gets its own entry in
      // Notification Center instead of silently replacing round 2's -- only a
      // genuine re-delivery of the SAME round should collapse into one.
      try {
        var notif = new Notification(baseTitle, { body: body, tag: 'claude-board-' + boardId + '-' + n });
        // Focus, then land on the round that needs an answer, then dismiss. The
        // jump is the round badge's own helper, not a second implementation of
        // it: a reviewer who clicks a notification is asking the same question
        // the badge answers, and arriving at whatever they last scrolled to
        // makes them ask it again by hand. Ordering matters -- the scroll must
        // happen on a window already brought forward.
        notif.onclick = function () { window.focus(); jumpToOpenRound(); notif.close(); };
      } catch (e) { /* denied or unsupported */ }
    }
    try {
      if (Notification.permission === 'granted') { fire(); return; }
      if (Notification.permission === 'denied') return;              // never re-prompt
      var req = Notification.requestPermission();                     // lazily, on the first round that would notify
      if (req && typeof req.then === 'function') {
        req.then(function (perm) { if (perm === 'granted') fire(); }, function () { /* ignore */ });
      }
    } catch (e) { /* degrade silently -- marking the tab must never block a push */ }
  }

  function markPendingRound(n) {
    if (readonly) return;
    pendingRounds++;
    setFaviconBadge(pendingRounds);
    notifyRound(n);
  }

  function clearPendingMark() {
    if (!pendingRounds) return;
    pendingRounds = 0;
    setFaviconBadge(0);
  }

  // Coming back to the tab is the acknowledgement: the mark clears the moment the
  // document becomes visible/focused again, so a stale favicon pip never outlives
  // the rounds it stood for.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) clearPendingMark(); });
  window.addEventListener('focus', function () { clearPendingMark(); });

  // --- SSE: a follow-up round pushes into this already-open tab ---------------
  //
  // "Open once, then badge and notify" / "Always on under launchd" (DESIGN.md):
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
    // DESIGN.md round-end criterion 1/6: renderRoundSection only ever emits .round-end
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
    // node (ChildNode.replaceWith("") -- an empty replacement set means "just
    // take it out"), already implemented by test/dom-stand-in.mjs's Element for
    // the mermaid-fallback path -- no new stand-in surface needed for this.
    var rail = section.querySelector('.round-end');
    if (rail) rail.replaceWith();
    // The diagram's expand control is exempt, exactly as it is in the readonly
    // pass at the top of this file, and for the same reason (DESIGN.md polish
    // ticket 05: "the lens is view-only under body.readonly ... pan and zoom
    // work"). A round collapsing into history makes its ANSWERS immutable; it
    // does not make its diagrams unreadable, and a settled round is precisely
    // where someone re-reads one. The readonly pass was patched for this and
    // this loop was not (audit finding D6), so a diagram went permanently
    // un-expandable the moment its round was sent -- from a page that had been
    // showing the control a second earlier.
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

  // DESIGN.md polish ticket 05: close the diagram lens before any of the three
  // paths below start replacing sections. The lens holds a CLONE of a diagram
  // that is about to stop existing, and -- until it is closed -- the block's own
  // comment form, moved in there and due back at a placeholder in markup this is
  // about to throw away. Closing first returns the form while its slot is still
  // in the document; leaving it open would strand it inside a dialog and leave
  // two elements sharing one id the moment the replacement rendered its own.
  function applyRoundPush(data) {
    lensClose();
    var patch = computeBoardPatch(board, data.board);
    // Advance the closure's board to the post-push state now, BEFORE any DOM
    // work below: wireRoot (via wireHtmlStage/wireMermaidBlock, ticket 06) reads
    // board.comments to place pins on whatever it wires, including the nodes
    // this very push is about to insert -- if board were only reassigned at the
    // end (as it originally was here), any pin-layer populated during this call
    // would render against the board as it was BEFORE this push, one push stale.
    // computeBoardPatch above is the only thing that needed the old value.
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

    if (data.mode === 'new-round') {
      // Tag-qualified, same reason as every other id-by-string lookup in
      // this file -- '## Blocks' slugifies to the same collision shape.
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
        // Criterion 7: the round this push just inserted has to be watchable
        // too, or scrolling into it would never update N. Rebuilt wholesale
        // rather than observing the one new section: the band's own lower edge
        // is clamped against how far the page can still scroll (see
        // measureRoundBand -- finding NEW-1), and inserting a round changes
        // exactly that. A push that only added an observation would leave the
        // band measured against the PREVIOUS document height, which is the same
        // staleness in a new place.
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
        blockEls.forEach(function (blockEl) {
          var id = blockEl.getAttribute('data-block-id');
          var existing = findBlockEl(roundSection, id);
          if (existing) { existing.replaceWith(blockEl); } else { roundSection.appendChild(blockEl); }
        });
        blockEls.forEach(function (blockEl) { renderMermaidBlocks(blockEl); });
      }
    }

    // U3 (DESIGN.md ticket 09, audit finding U3): wireRoot(wrap)/
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

    // Rebuilt for BOTH modes, not just 'new-round': an amend replaces block
    // markup and therefore changes the document's height, which the band's own
    // lower edge is measured against (measureRoundBand -- finding NEW-1). It
    // also re-observes whatever sections now exist, which is what makes a
    // freshly-inserted round watchable at all (criterion 7).
    setupRoundObserver();

    patch.roundsNowSent.forEach(markRoundHistory);
    // Re-observe AFTER markRoundHistory: a round this push just collapsed into
    // history had its .round-end stripped above, and the round this push just
    // inserted (if any) carries its own, server-rendered -- setupSendBarDock has
    // to look at the document as it stands now, not as it stood before either
    // change landed.
    setupSendBarDock();

    // Criterion 8: a round arriving over SSE used to leave the badge reading
    // whatever the page happened to render at load, stale until reload -- the
    // badge was written server-side and this push never touched it. board was
    // already reassigned above, so board.rounds.length (M) is current here.
    renderBadge();

    // The round is in the DOM; now mark the TAB, since this push is the whole
    // reason the tab was not reopened and focus not stolen (DESIGN.md "Open
    // once, then badge and notify"). Last, and after every early-return above, so
    // a push that failed to render is never counted as one waiting to be read.
    markPendingRound(data.round);
    // A round that is not yet sent is a round this page may submit -- this is what
    // brings the send bar back after a previous round was collapsed into history.
    setSendBarEnabled(openRoundNumber() !== null);
  }

  function applySubmittedPush(data) {
    lensClose(); // see applyRoundPush above
    var section = document.querySelector('.round[data-round="' + data.round + '"]');
    var replacedIds = section ? qsa('.block', section).map(function (el) { return el.getAttribute('data-block-id'); }) : [];
    // Advance board before any DOM work -- same reasoning as applyRoundPush
    // above: wireRoot's element-level anchoring (ticket 06) reads board.comments
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
    // Criterion 7, and the exact mirror of what applyRoundPush already does for
    // its own inserted section (audit finding D4): the round section this push
    // replaced was the one the observer was watching, and it is GONE -- an
    // IntersectionObserver holds no claim on the element that took its place.
    // Without re-observing, scrolling through the just-submitted round stopped
    // moving N at all, so the badge sat on whatever number it last saw and read
    // "round 1 of 3" halfway down round 3, which is the very lie criterion 7
    // exists to end. Looked up fresh from the live document rather than reusing
    // the local 'replacement', for the same reason applyRoundPush does: only the
    // document knows what actually landed.
    setupRoundObserver();
    // Same reasoning as applyRoundPush's own call: the just-submitted round's
    // .round-end is gone (its replacement markup is historical, never carries
    // one -- and the markRoundHistory fallback branch above strips it too), so
    // the dock observer has to re-read the document rather than keep watching a
    // node that may no longer be attached.
    setupSendBarDock();
    // U3: same fix as applyRoundPush above -- wireRoot(replacement) ran against
    // a detached node, so any page-scoped pin it drew is positioned wrong now
    // that the section is actually attached. Recompute once, here, after attach.
    refreshPins(document);
    // M does not change on a submit, but the badge is re-rendered anyway for
    // the same reason applyRoundPush does: board was just reassigned, and
    // "never goes stale" is simplest to guarantee by never special-casing
    // which pushes are allowed to skip it.
    renderBadge();
    // The round is now sent: nothing in it is worth preserving as "in progress"
    // any more, however this client happened to have it filled in. Both sources
    // are used deliberately -- board.blocks is the TOP level only, so a question
    // nested in a compare block or in another question's context appears solely
    // in replacedIds, harvested from the DOM subtree actually being replaced.
    var roundBlockIds = (data.board.blocks || []).filter(function (b) { return b.round === data.round; }).map(function (b) { return b.id; });
    clearFieldState(roundBlockIds.concat(replacedIds));
    // Sent means sent: the send bar stays disabled until a new round arrives, so
    // a second click (or a second tab) can never re-submit a round that went out.
    setSendBarEnabled(openRoundNumber() !== null);
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

    var roundOf = {};
    (fresh.blocks || []).forEach(function (b) { roundOf[b.id] = b.round; });
    var touchedIds = patch.addedBlockIds.concat(patch.changedBlockIds);
    var rounds = [];
    touchedIds.forEach(function (id) {
      var n = roundOf[id];
      if (n != null && rounds.indexOf(n) === -1) rounds.push(n);
    });
    rounds.sort(function (a, b) { return a - b; });

    if (!rounds.length) {
      // Nothing to insert, only status to catch up on (a round went sent while we
      // were away): advance and collapse it, without pretending a round arrived.
      board = fresh;
      clearFieldState(patch.changedBlockIds);
      patch.roundsNowSent.forEach(markRoundHistory);
      renderBadge();
      setSendBarEnabled(openRoundNumber() !== null);
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
    es.addEventListener('round', function (ev) {
      try { applyRoundPush(JSON.parse(ev.data)); } catch (e) { /* malformed push; ignore rather than crash the page */ }
    });
    es.addEventListener('submitted', function (ev) {
      try { applySubmittedPush(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    });
  }
})();
`;
