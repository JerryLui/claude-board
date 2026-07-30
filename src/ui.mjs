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
import { composeHint, parseMermaidDomId, MERMAID_NODE_SELECTOR } from './anchor.mjs';

export const ui = `
(function () {
  var dataEl = document.getElementById('board-data');
  if (!dataEl) return;
  var board = JSON.parse(dataEl.textContent);
  var boardId = board.id;
  var readonly = (location.protocol === 'file:');
  if (readonly) document.body.classList.add('readonly');

  // Marks the innermost element under the cursor for the page's OWN generic
  // anchor gesture (the delegated document-level listener further down), so the
  // click-to-anchor gesture is visible before it is used. An html stage's
  // element-level hover (ticket 10, SPEC_ANCHORING.md) lives in a SEPARATE
  // document -- its own class, of the same name by convention but declared and
  // applied entirely inside the injected agent script src/render.mjs's
  // 'stageAgentScript' carries, never here; see that file's design comment for
  // why the two are independent (this page's stylesheet deliberately does not
  // reach into the stage's document -- QUIRKS.md "Two stylesheets, one
  // palette").
  var STAGE_HOVER_CLASS = 'cb-anchor-hover';

  var pendingComments = [];
  var selections = {};   // qid -> string (single/text) | string[] (multi/rank)
  var notes = {};
  var deferred = {};     // qid -> bool, the per-question defer affordance
  var touched = {};      // qid -> bool, has this widget actually been interacted with

  // Comment mode (ticket 03, SPEC_ANCHORING.md): off by default, so every ordinary
  // widget handler below runs exactly as it always has. Declared here, at the very
  // top alongside the other page-lifetime state, because it is read from inside
  // wireRoot's per-widget handlers (guarding single/multi/rank/defer against
  // mutating an answer while the reviewer is mid-anchor-click) as well as from the
  // generic anchor hover/click listeners further down -- both need one shared,
  // page-lifetime flag, never a per-wire-pass local.
  var commentMode = false;

  // Which html-stage <iframe>s have a stage-side agent that confirmed 'ready'
  // (ticket 10, SPEC_ANCHORING.md -- see the design comment above
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
  if (readonly) {
    qsa('textarea, input, button').forEach(function (el) { el.disabled = true; });
    qsa('.rank-list li[draggable]').forEach(function (li) { li.removeAttribute('draggable'); });
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
  function openCommentForm(blockId, anchorKind, anchorRef, anchorHint, anchorDomRef) {
    var form = document.getElementById('comment-form-' + blockId);
    if (!form) return;
    form.setAttribute('data-anchor-kind', anchorKind);
    form.setAttribute('data-anchor-ref', anchorRef || '');
    form.setAttribute('data-anchor-label', anchorHint || '');
    form.setAttribute('data-anchor-domref', anchorDomRef || '');
    var target = document.getElementById('comment-target-' + blockId);
    if (target) {
      target.textContent = anchorKind === 'block' ? 'commenting on: whole block' : 'commenting on: ' + (anchorHint || anchorRef);
      // Shown only while a comment is actually being composed on this block --
      // it is rendered on every block unconditionally (src/render.mjs), so it
      // opens and closes together with the form it labels.
      target.classList.add('open');
    }
    form.classList.add('open');
    var input = form.querySelector('input[type=text]');
    if (input) input.focus();
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

  // html stage (ticket 10, SPEC_ANCHORING.md): the iframe no longer carries
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
  // U6 (SPEC_ANCHORING.md ticket 09, audit finding U6): this counter used to
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

  function renderDomPins(blockId, stageRoot, layer) {
    layer.innerHTML = '';
    resetStackedOffset(layer);
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== blockId || !c.anchor || c.anchor.kind !== 'dom') return;
      var steps = pathToSteps(c.anchor.ref);
      var el = steps.length && stageRoot ? resolveSteps(stageRoot, steps) : null;
      var position = null;
      if (el && el.getBoundingClientRect && stageRoot.getBoundingClientRect) {
        var stageBox = stageRoot.getBoundingClientRect();
        var elBox = el.getBoundingClientRect();
        position = { left: elBox.left - stageBox.left, top: elBox.top - stageBox.top };
      }
      placePin(layer, c, !!c.resolved, position);
    });
  }

  // --- html-stage postMessage protocol (ticket 10) -----------------------------
  //
  // The parent's half of the design in src/render.mjs's 'stageAgentScript'
  // comment. Three responsibilities: find which live '.html-stage' frame a
  // message actually came from (never trust an id the message itself claims),
  // validate its shape before touching any field, and act on exactly the four
  // message types the stage ever sends.

  var STAGE_CB = 'cb-stage';
  var nextLocateId = 1;
  var pendingLocates = {}; // requestId -> { layer: pin-layer element, comments: [...] }

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
    // isWiredStage already recognises at the moment it runs.
    postToStage(frame, { type: 'mode', commentMode: commentMode });
    if (layer) requestStagePositions(frame, blockId, layer);
  }

  function handleStageClick(data, section, blockId) {
    if (readonly || !commentMode) return;
    if (typeof data.ref !== 'string' || !data.ref) return;
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
    openCommentForm(blockId, 'dom', data.ref, buildHint(section, { textContent: text, tagName: tag }));
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
  function renderMermaidPins(blockId, svg, layer, section) {
    layer.innerHTML = '';
    resetStackedOffset(layer);
    commentsWithPending().forEach(function (c) {
      if (c.blockId !== blockId || !c.anchor || c.anchor.kind !== 'mermaid') return;
      var host = null;
      if (svg) {
        // Ticket 05: try the generic domRef first, against the LIVE rendered
        // SVG (something only the client, not resolveComment's server-side
        // verdict, can ever do -- see src/anchor.mjs's "ticket 05 design"
        // comment). Trusted only if the element it lands on ALSO carries the
        // stored node id in its own generated id -- a cheap cross-check against
        // mermaid's internal SVG structure having shifted since mint time,
        // which would otherwise silently position the pin on the wrong node.
        if (c.anchor.domRef && section) {
          var steps = pathToSteps(c.anchor.domRef);
          var viaSteps = steps.length ? resolveSteps(section, steps) : null;
          if (viaSteps && viaSteps.getAttribute && parseMermaidDomId(viaSteps.getAttribute('id')) === c.anchor.ref) {
            host = viaSteps;
          }
        }
        if (!host) {
          // Iterate and compare via parseMermaidDomId rather than interpolating
          // the stored ref into a CSS attribute-selector string: a crafted ref
          // could otherwise break out of the selector (see TICKETS_BOARD.md
          // ticket 06's log). This is display-positioning only -- resolved/lost
          // styling never depends on this lookup succeeding, either path.
          var candidates = svg.querySelectorAll(MERMAID_NODE_SELECTOR);
          for (var i = 0; i < candidates.length; i++) {
            if (parseMermaidDomId(candidates[i].getAttribute('id')) === c.anchor.ref) { host = candidates[i]; break; }
          }
        }
      }
      var position = null;
      if (host && host.getBoundingClientRect && layer.getBoundingClientRect) {
        var wrapBox = layer.getBoundingClientRect();
        var hostBox = host.getBoundingClientRect();
        position = { left: hostBox.left - wrapBox.left + hostBox.width / 2, top: hostBox.top - wrapBox.top + hostBox.height / 2 };
      }
      placePin(layer, c, !!c.resolved, position);
    });
  }

  function wireMermaidBlock(preEl, svg) {
    var section = preEl.closest('.mermaid-block');
    if (!section) return;
    var blockId = section.getAttribute('data-block-id');
    var layer = section.querySelector('.pin-layer');
    if (layer) renderMermaidPins(blockId, svg || null, layer, section);
    if (readonly || !svg) return; // nothing live to click without a rendered diagram
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
      // Ticket 05: mint the SAME generic domRef + hint every other element-level
      // click mints (buildSteps/buildHint, declared above, already used by the
      // html stage and the generic listener) -- the node id stays the fallback
      // ref, not the model (src/anchor.mjs's "ticket 05 design" comment). A
      // failure to build steps (host somehow not reachable from section) still
      // mints the anchor with an empty domRef rather than aborting: the node id
      // alone is enough to comment, exactly as it was before this ticket.
      var steps = buildSteps(section, host);
      var domRef = (steps && steps.length) ? stepsToPath(steps) : '';
      var hint = buildHint(section, host);
      openCommentForm(blockId, 'mermaid', ref, hint, domRef);
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
   * anyway. */
  function refreshPins(root) {
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
  function wirePageDomPins(root) {
    qsa('[data-block-id]', root).forEach(function (section) {
      var layer = directChildPinLayer(section);
      if (layer) renderDomPins(section.getAttribute('data-block-id'), section, layer);
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

  var modeToggleBtn = document.getElementById('comment-mode-toggle');

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
      if (isWiredStage(frame)) postToStage(frame, { type: 'mode', commentMode: commentMode });
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
  var ANCHOR_CHROME_SELECTOR = '.block-kicker, .comment-btn, .comment-form, .comment-target, '
    + '.comment-list, .pin-layer, .anchor-pin, .mode-toggle, .compare-label, .round-label, '
    + 'pre.mermaid, .html-stage, .stage-wrap';

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

  var anchorHovered = null;
  function clearAnchorHover() {
    if (anchorHovered && anchorHovered.classList) anchorHovered.classList.remove(STAGE_HOVER_CLASS);
    anchorHovered = null;
  }

  document.addEventListener('mouseover', function (ev) {
    if (!commentMode) return;
    var el = ev.target;
    clearAnchorHover();
    if (!el || el.nodeType !== 1 || isAnchorChrome(el)) return;
    var root = anchorRootFor(el);
    if (!root || el === root) return;
    // Marks ONLY ev.target (criterion 2: "that element, and not its ancestors") --
    // never walked up, exactly like the iframe's own hover handler above.
    anchorHovered = el;
    el.classList.add(STAGE_HOVER_CLASS);
  });
  document.addEventListener('mouseout', function () { if (commentMode) clearAnchorHover(); });

  document.addEventListener('click', function (ev) {
    if (!commentMode || readonly) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || isAnchorChrome(el)) return;
    var root = anchorRootFor(el);
    if (!root || el === root) return;
    var steps = buildSteps(root, el);
    if (!steps || !steps.length) return;
    // Stops an <a href> from navigating, a submit-shaped element from submitting,
    // etc. -- comment mode means clicks anchor, full stop, while it's on.
    ev.preventDefault();
    clearAnchorHover();
    var blockId = root.getAttribute('data-block-id');
    openCommentForm(blockId, 'dom', stepsToPath(steps), buildHint(root, el));
  });

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
  // The gesture itself can't be asserted without a browser (see SPEC_BOARD.md
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

  qsa('.comment-btn', root).forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (readonly) return;
      var blockId = btn.getAttribute('data-block-id');
      var anchorKind = btn.getAttribute('data-anchor-kind') || 'block';
      var anchorRef = btn.getAttribute('data-anchor-ref') || '';
      var anchorLabel = btn.getAttribute('data-anchor-label') || '';
      openCommentForm(blockId, anchorKind, anchorRef, anchorLabel);
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
      pendingComments.push({ blockId: blockId, anchor: anchor, text: text });
      var provisionalN = nextCommentNumber() + pendingComments.length - 1;
      var list = document.getElementById('comment-list-' + blockId);
      if (list) {
        var item = document.createElement('div');
        item.className = 'comment-item comment-pending';
        item.setAttribute('data-anchor-kind', anchor.kind);
        if (anchor.ref) item.setAttribute('data-anchor-ref', anchor.ref);
        item.setAttribute('data-block-id', blockId);
        var tag = anchor.kind === 'md' ? anchor.label
          : anchor.kind === 'dom' ? (anchor.hint || anchor.ref)
          : anchor.kind === 'mermaid' ? (anchor.hint || anchor.ref)
          : 'block';
        item.innerHTML = '<span class="comment-anchor">#' + provisionalN + ' · ' + String(tag).replace(/</g, '&lt;') + '</span>';
        item.appendChild(document.createTextNode(text));
        list.appendChild(item);
      }
      // The pin lands NOW, not after Send: a queued comment has no server-assigned
      // n, so commentsWithPending mints a provisional one continuing the sequence
      // and placePin draws it hollow (.pin-pending). Re-rendering the whole layer
      // rather than appending one pin is what keeps the provisional numbers
      // consistent as more comments queue up behind this one.
      refreshPins(document);
      input.value = '';
      form.classList.remove('open');
      var targetEl = document.getElementById('comment-target-' + blockId);
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
    if (item.getAttribute('data-anchor-kind') !== 'md') return;
    highlightAnchor(item.getAttribute('data-block-id'), item.getAttribute('data-anchor-ref'));
  });

  // --- mermaid: client-side from the CDN, exactly as /visualize does today ---

  var mermaidMod = null;
  async function renderMermaidBlocks(root) {
    var nodes = qsa('pre.mermaid', root);
    if (!nodes.length) return;
    try {
      if (!mermaidMod) {
        mermaidMod = window.mermaid
          || (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
        // The board page is dark unconditionally (src/styles.mjs sets
        // color-scheme: dark and a fixed palette), so the diagram is too --
        // keying this off the OS scheme, as it used to, dropped a light
        // 'neutral' diagram into a dark page for anyone on a light desktop.
        // Mermaid's 'base' theme is the only one that takes themeVariables, so
        // the diagram is drawn from the same tokens as everything around it.
        mermaidMod.initialize({
          startOnLoad: false,
          theme: 'base',
          themeVariables: {
            darkMode: true,
            background: 'transparent',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            fontSize: '13px',
            primaryColor: '#18202f',
            primaryTextColor: '#eaeef6',
            primaryBorderColor: '#7c9cff',
            secondaryColor: '#1e2839',
            tertiaryColor: '#131a27',
            lineColor: '#7b869a',
            textColor: '#b6bfd0',
            mainBkg: '#18202f',
            nodeBorder: '#7c9cff',
            clusterBkg: 'rgba(124, 156, 255, 0.06)',
            clusterBorder: 'rgba(255, 255, 255, 0.14)',
            edgeLabelBackground: '#131a27',
          },
        });
      }
      await mermaidMod.run({ nodes: nodes, suppressErrors: true });
    } catch (e) { /* offline or CDN failure: fall through to the source fallback below */ }
    nodes.forEach(function (n) {
      var svg = n.querySelector('svg');
      if (svg) { wireMermaidBlock(n, svg); return; }
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
  renderMermaidBlocks(document);

  // Cheap, partial mitigation for pin drift: reposition every pin on a window
  // resize. Does not track an iframe's own internal scroll or its resize-drag
  // handle (SPEC_BOARD.md puts gesture-level fidelity like this outside automated
  // scope; a known, accepted gap rather than an attempt at full continuous
  // tracking).
  // Repositioning only -- refreshPins (above) deliberately does not re-run the
  // click-listener wiring, or every resize would stack another click handler on
  // the same iframe/diagram.
  window.addEventListener('resize', function () { refreshPins(document); });

  // --- the two ways out: Send, and Discuss in chat -----------------------------
  //
  // SPEC_BOARD.md Decisions -> "Two ways out, plus a wall clock": beside Send the
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
    // single
    return { choice: raw != null ? raw : null, answered: raw != null };
  }

  var sendBtn = document.getElementById('send-btn');
  var discussBtn = document.getElementById('discuss-btn');
  var sendStatus = document.getElementById('send-status');

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

  /** The round this page can still submit: the latest round that is not yet sent.
   * Posted with the body so the server can refuse a submit aimed at a round that
   * already went out (409) instead of silently rewriting it. */
  function openRoundNumber() {
    var n = null;
    (board.rounds || []).forEach(function (r) { if (r.status !== 'sent') n = r.n; });
    return n;
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
      // Queue emptied first, then the pin layers re-rendered: from here the pins
      // come from board.comments alone, so the provisional ones are replaced
      // rather than joined by the server-numbered copies of the same comments.
      pendingComments = [];
      refreshPins(document);
      clearPendingMark();
      if (sendStatus) {
        sendStatus.textContent = result && result.alreadySent ? 'Already sent.'
          : (action === 'discuss' ? 'Handed over to chat.' : 'Sent.');
      }
      // Deliberately NOT re-enabled here: the round is out.
    }).catch(function (err) {
      if (sendStatus) sendStatus.textContent = 'Error: ' + err.message;
      setSendBarEnabled(true);   // nothing went out -- the reviewer must be able to retry
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function () {
      if (readonly) return;
      submitBoard('send');
    });
  }
  if (discussBtn) {
    discussBtn.addEventListener('click', function () {
      if (readonly) return;
      submitBoard('discuss');
    });
  }

  // --- "Open once, then badge and notify" (SPEC_BOARD.md Decisions) ------------
  //
  // The tab is opened exactly once, for a thread's first board; every later round
  // arrives over SSE into that same tab, so the page itself has to be what tells
  // the reviewer something new landed. Three marks, all page-side, none of which
  // steals focus (the whole reason the tab is not reopened): a pending count in
  // document.title, a badge drawn onto a data-URI favicon, and -- only when this
  // document is hidden or unfocused -- a system notification.
  //
  // Every part degrades silently and never blocks: no canvas, no Notification
  // constructor, permission denied or a throw from any of them leaves the round
  // pushed and the page working, just unmarked. Permission is requested lazily, on
  // the first round that would actually notify, never at load. All of it is inert
  // in readonly mode -- there is no SSE connection there to push a round in the
  // first place, and every entry point below returns early on 'readonly' anyway,
  // so the standalone file:// archive neither draws a badge nor asks for anything.

  var pendingRounds = 0;
  var baseTitle = document.title;
  var faviconLink = null;

  /** Draw an n-badged favicon as a data URI. Canvas, not a file: PROTOCOL.md's
   * zero-dependency / single-self-contained-file rule means no new asset can ship
   * beside the page. Returns null if canvas is unavailable, and the caller just
   * leaves the favicon alone. */
  function drawFavicon(count) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#10141b';
      ctx.fillRect(0, 0, 32, 32);
      ctx.fillStyle = '#6ea8fe';
      ctx.beginPath();
      ctx.arc(16, 16, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b1220';
      ctx.font = 'bold 20px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 9 ? '9+' : String(count), 16, 17);
      return canvas.toDataURL('image/png');
    } catch (e) { return null; }
  }

  /** Badge (count > 0) or unbadge (count === 0) the tab's favicon. The <link> is
   * created here rather than emitted by src/render.mjs so the served markup keeps
   * carrying no external-looking reference at all. */
  function setFaviconBadge(count) {
    try {
      if (!faviconLink) {
        faviconLink = document.querySelector('link[rel="icon"]');
        if (!faviconLink) {
          faviconLink = document.createElement('link');
          faviconLink.setAttribute('rel', 'icon');
          document.head.appendChild(faviconLink);
        }
      }
      if (!count) { faviconLink.removeAttribute('href'); return; }
      var href = drawFavicon(count);
      if (href) faviconLink.setAttribute('href', href);
    } catch (e) { /* no favicon badge; the title count still marks the tab */ }
  }

  function setTitleBadge(count) {
    document.title = count ? '(' + count + ') ' + baseTitle : baseTitle;
  }

  /** A notification INSTEAD of a focus steal, and only when the reviewer isn't
   * already looking: a visible, focused tab already shows the round, so notifying
   * would be noise. Nothing here ever pulls the window forward. */
  function notifyRound(n) {
    if (readonly) return;
    if (typeof Notification === 'undefined') return;
    var unfocused = document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
    if (!unfocused) return;
    var body = 'Round ' + n + ' is waiting for you.';
    function fire() {
      try { new Notification(baseTitle, { body: body, tag: 'claude-board-' + boardId }); } catch (e) { /* denied or unsupported */ }
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
    setTitleBadge(pendingRounds);
    setFaviconBadge(pendingRounds);
    notifyRound(n);
  }

  function clearPendingMark() {
    if (!pendingRounds) return;
    pendingRounds = 0;
    setTitleBadge(0);
    setFaviconBadge(0);
  }

  // Coming back to the tab is the acknowledgement: the marks clear the moment the
  // document becomes visible/focused again, so a stale "(3)" never outlives the
  // rounds it counted.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) clearPendingMark(); });
  window.addEventListener('focus', function () { clearPendingMark(); });

  // --- SSE: a follow-up round pushes into this already-open tab ---------------
  //
  // "Open once, then badge and notify" / "Always on under launchd, reloaded by
  // WatchPaths" (SPEC_BOARD.md): the daemon can restart mid-review, so the page
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
    qsa('textarea, input, button', section).forEach(function (el) { el.disabled = true; });
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

  function applyRoundPush(data) {
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
      var container = document.getElementById('blocks');
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

    // U3 (SPEC_ANCHORING.md ticket 09, audit finding U3): wireRoot(wrap)/
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

    // The round is in the DOM; now mark the TAB, since this push is the whole
    // reason the tab was not reopened and focus not stolen (SPEC_BOARD.md "Open
    // once, then badge and notify"). Last, and after every early-return above, so
    // a push that failed to render is never counted as one waiting to be read.
    markPendingRound(data.round);
    // A round that is not yet sent is a round this page may submit -- this is what
    // brings the send bar back after a previous round was collapsed into history.
    setSendBarEnabled(openRoundNumber() !== null);
  }

  function applySubmittedPush(data) {
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
          var container = document.getElementById('blocks');
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
    // U3: same fix as applyRoundPush above -- wireRoot(replacement) ran against
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
      var doc = new DOMParser().parseFromString(text, 'text/html');
      var node = doc.getElementById('board-data');
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
