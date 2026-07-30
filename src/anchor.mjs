// Element-level comment anchoring: pure logic shared between the client (src/ui.mjs
// owns the actual click gesture) and the server (src/board.mjs resolves a stored
// anchor at packet-assembly time). Kept dependency-free and DOM-free on purpose so
// it is testable in node with no browser (test/check-pure.mjs) — see
// SPEC_BOARD.md "Click-to-comment reaches individual elements" and PROTOCOL.md
// "Answers, comments, anchors" for the two shapes this module builds and resolves:
// { kind: 'dom', ref, hint } and { kind: 'mermaid', ref, domRef, hint }. Ticket
// 05 added `domRef`/`hint` to the mermaid shape without changing what `ref`
// means -- see "ticket 05 design" below, further down this file, for why a
// diagram node carries all three rather than replacing `ref` outright.
//
// DOM path format: a dot-separated chain of 1-based child indices from a block's
// stage root (the iframe's <body> for an html block) down to the clicked element,
// e.g. "2.1.3" means "3rd child of the 1st child of the 2nd child of the root".
// Deliberately not a CSS selector — a plain index chain has no escaping or
// pseudo-class edge cases, and resolveSteps below walks it against anything that
// exposes a `.children` collection, a real DOM element or a plain object alike,
// which is exactly what makes path *resolution* unit-testable without a browser
// too, not just path building.
//
// src/ui.mjs carries a duplicate of buildSteps/stepsToPath/pathToSteps/
// resolveSteps/extractHint/parseMermaidDomId as plain functions inside its
// template string: the served page is a single self-contained file (no bundler, no
// build step, opens from file:// per ticket 05), so nothing there can `import` this
// module at runtime. This module is the reference the duplicate is kept in sync
// against; test/check-pure.mjs exercises this module directly.

// --- ticket 03 design: one generic element reference over the board's own DOM --
//
// Written before the implementation, per SPEC_ANCHORING.md's Next Steps ("design
// the generic element reference at the start of ticket 03"). This is the design;
// the code below and in src/ui.mjs is what it produced.
//
// WHAT A REFERENCE IS. The wire shape does not change: `{ kind: 'dom', ref, hint }`,
// exactly what ticket 01/02 already stored for a click inside a hand-mocked html
// stage. What changes is which ROOT `ref` (a stepsToPath index chain) is measured
// from, and there are exactly two roots, chosen by the anchored block's own `kind`
// -- the same discriminator src/board.mjs's resolveComment already reads:
//
//   - block.kind === 'html'   -> root is the stage's iframe body (unchanged from
//     ticket 02). The click happens in a different DOCUMENT (the sandboxed
//     srcdoc), so this stays the one cross-document case -- see "isolation of
//     hand-mocked HTML is kept" in SPEC_ANCHORING.md's Decisions. Nothing about
//     this case's minting or resolving changes here.
//   - every other block kind -> root is that block's own rendered `<section
//     class="block" data-block-id="...">` in the board page's OWN document. A
//     click on a paragraph, a list item, a table cell, a line of a code
//     reference, one side of a comparison (whose nested block gets its own
//     `data-block-id` section -- see src/board.mjs's findBlock, which already
//     recurses into compare sides and question context), or a question's own
//     widget (option card, rank item) all resolve their path against the
//     block section that contains them, found by walking up from the click
//     target to the nearest `[data-block-id]` ancestor (src/ui.mjs's
//     `anchorRootFor`). That block id is what the comment attaches to -- the
//     SAME id the block's own comment form already uses, so nothing new is
//     threaded through the wire format.
//
//   This is deliberately NOT a path from `<body>`: the ticket calls that out
//   explicitly as "exactly the kind of thing that shifts on re-render" --
//   inserting an earlier round, or a block landing at a different position,
//   would shift every absolute body-rooted index. Rooting at the block's own,
//   stably-`id`ed section means a ref only has to survive that ONE block being
//   re-rendered identically from its own (unchanged) stored content, which is
//   what ticket 04 gets to rely on rather than invent.
//
//   `mermaid` keeps its own kind and its own node-id ref (parseMermaidDomId
//   below) -- ticket 05's job to fold in, not deleted here. `md` and `block`
//   anchors are untouched. So "one model" means: one path-building/resolving
//   mechanism (buildSteps/stepsToPath/resolveSteps, all below), with the html
//   stage's cross-document case and the page's own same-document case both
//   examples of it, rather than the stage being the only element-level case
//   that existed. Diagrams stay a documented third case for now.
//
// HOW A HINT IS DERIVED. `extractHint` (below) is unchanged: it collapses and
// caps an element's own text. That alone is "identity" -- criterion 6 also
// wants "containing context" (its example: "the Send button in the after
// stage", not "the small card"). The context half is necessarily DOM-shaped
// (walking ancestors, reading a compare side's own label) and stays in
// src/ui.mjs, but the RULE for turning those already-gathered, DOM-free inputs
// into a hint string -- the actual thing criterion 6 is graded on -- is
// `composeHint` below, a pure function with no DOM in its signature at all. This
// split matters for the same reason buildSteps/resolveSteps are pure while "which
// element did the click land on" is not: it is what makes the composition rule
// checkable without a browser, and per an earlier draft's mistake (a Director
// audit caught it -- see this file's git history around ticket 03), a design
// comment describing the rule is NOT the same thing as the rule being checked.
// src/ui.mjs embeds `composeHint`'s literal source via `composeHint.toString()`
// (see `computeBoardPatch`/src/patch.mjs for the established precedent this
// copies), not a hand-written re-implementation, so there is exactly one
// implementation, not two that can drift -- mutating this function changes what
// the served page actually does, which is what makes it show up in
// test/check-comment-mode.mjs's criterion-6 checks, and test/check-pure.mjs
// separately asserts the embedded copy is byte-identical to this one so a FUTURE
// hand-edit of the embedded string can never quietly diverge from it either.
//
//   hint = identity, or "identity in context" when context is non-empty.
//   identity = the element's own collapsed text (extractHint, already run by the
//     caller before composeHint sees it), or -- "its role or tag when it has no
//     text" -- a small fixed word for the handful of tags that read better as a
//     role than blank (button/link/image/field), falling back to the bare tag
//     name. That role word is appended to a present text ("Send" -> "Send
//     button") ONLY alongside real context (below) -- without something to
//     disambiguate against, an element's own text is already unambiguous on its
//     own block, and suppressing the role word there is what keeps ticket 02's
//     plain html-stage hint ('Send', not 'Send button') unchanged outside a
//     compare. Never invented from the surrounding copy either way -- see "the
//     renderer stays mechanical and read-only".
//   context = present only when the caller found a `.compare-side` ancestor
//     (src/ui.mjs's `insideCompare` argument, kept distinct from an empty label
//     string, since a compare side's own label defaults to '' and that must
//     still count as "inside a compare"): that side's own `.compare-label` text
//     (whatever the caller supplied, e.g. "After") plus a fixed noun for the
//     containing block's OWN kind (html -> "stage", mermaid -> "diagram", code
//     -> "reference", question -> "question", markdown/compare ->
//     "block"/"comparison"), read by the caller off a `data-block-kind`
//     attribute src/render.mjs now stamps on every block section. Elsewhere
//     (`insideCompare` false) context is empty and the hint is identity alone --
//     unchanged from ticket 02's plain `extractHint(el.textContent)`, which is
//     what keeps that ticket's html-stage check asserting the literal hint
//     `'Send'` true without editing it. Compare is the one place in this
//     codebase two symmetric, identically-shaped bits of content actually sit
//     side by side on purpose, which is exactly the ambiguity "the small card"
//     vs. "the Send button in the after stage" is about -- everywhere else a
//     block's own id already disambiguates without restating it in every hint.
//
//   Because context can add words the clicked element's own text never
//   contained, `resolveDomAnchor` below (which checks the STORED hint is
//   contained in the LIVE element's text) only ever has to do that for the
//   html-stage case today -- ticket 04, when it extends resolution to
//   page-scoped `dom` anchors, will need to resolve against the identity
//   portion only, not the full "identity in context" string. Flagged here so
//   that seam isn't rediscovered the hard way.
//
// HOW THE EXISTING KINDS FIT. `block` and `md` anchors are untouched by any of
// this. `dom` anchors gain a second root (above) but keep exactly the same
// wire shape, the same minting helpers, and the same resolution function
// signature (`resolveDomAnchor(html, ref, hint)`) for the case that already
// worked. What does NOT yet exist, and is explicitly left for ticket 04 rather
// than half-built here: `src/board.mjs`'s `resolveComment` still only resolves
// a `dom` anchor when `block.kind === 'html'` (see its own comment). A `dom`
// anchor minted against the new, page-scoped root reports `lost` the moment
// it round-trips through a real submit + re-render, honestly rather than
// silently -- SPEC_ANCHORING.md's "an anchor that no longer resolves reports
// what it lost" -- until ticket 04 teaches it to re-render that one block
// (`renderBlock` is already exported for exactly this) and resolve the ref
// against it the same way `resolveDomAnchor` already does for stage html.
// Nothing in ticket 03's own acceptance criteria (1, 2, 3, 6) depends on that
// round trip: the click, the hint, and the pin all work from the client's own
// local state the moment a comment is queued (src/ui.mjs's `commentsWithPending`
// marks a freshly-queued comment resolved unconditionally, never through
// resolveComment) -- see check-comment-mode.mjs's own comments for why that is
// enough to prove criteria 1/2/3/6 without needing ticket 04's server-side
// resolution first.

// --- ticket 05 design: a diagram node folds into the generic model ------------
//
// SPEC_ANCHORING.md's Decision "Mermaid stops being the template" states the
// order deliberately: "The generic model comes first; a diagram node is
// anchored by it like anything else. The node id is kept alongside the generic
// reference as the more durable of the two ... kept as a fallback the generic
// model can lean on, never as the model." Concretely, in this codebase:
//
//   WIRE SHAPE. A mermaid anchor keeps its own `kind: 'mermaid'` (resolveComment
//   still branches on it, and `ref`'s meaning is unchanged -- see below) and
//   gains the SAME two fields every other element-level anchor already carries:
//   `domRef` (a stepsToPath index chain, minted by src/ui.mjs's buildSteps
//   exactly like a page-scoped `dom` anchor, rooted at the mermaid block's own
//   `<section data-block-id>`, not at `<body>` -- ticket 03's design comment
//   above gives the re-render reason) and `hint` (composeHint, the same
//   function, the same call shape as everywhere else -- a diagram node's hint
//   can now read "Start in After diagram" instead of carrying no hint at all,
//   which is what a bare node id gave criterion 6 before this ticket). `ref`
//   keeps its ticket-02 meaning: the source-declared node id recovered from
//   mermaid's own generated element id (parseMermaidDomId below) -- unchanged,
//   so every anchor `test/fixtures/pre-ticket04-board.json` already carries
//   (criterion 7) still has everything it needs to resolve exactly as before.
//
//   PRECEDENCE, AND WHY IT IS NOT COSMETIC. resolveMermaidAnchor (below) tries
//   the generic `domRef`+`hint` FIRST, through the exact same
//   resolveDomAnchorInSection every other block kind's `dom` anchor already
//   resolves through -- no new server-side mermaid-specific parsing exists, or
//   is needed, to make that true. It falls back to mermaidRefResolves (`ref`)
//   only when that first attempt fails. In practice, for as long as diagram
//   rendering stays client-side (SPEC_ANCHORING.md's Out of Scope:
//   "Server-side diagram rendering"), the generic attempt fails server-side
//   EVERY time: the block's re-rendered section (src/render.mjs's
//   renderMermaidBlock, exactly what resolveDomAnchorInSection walks) only ever
//   contains the raw `<pre class="mermaid">source</pre>` -- the SVG a click
//   actually landed in exists only in whichever browser rendered it, never on
//   the server, so there is nothing there for a step chain into an <svg> to
//   address. That is exactly what "kept as a fallback ... never as the model"
//   means for this one stage kind: the node id is, today, the field actually
//   doing the resolving -- not because it is preferred, but because it is the
//   only one of the two a server that never runs mermaid can corroborate. The
//   generic attempt is still made genuinely first, through genuinely shared
//   code, because criterion 7 and this ticket both require a diagram node to
//   behave like every other anchor kind; a special-cased "just check the node
//   id, skip the rest" branch would be exactly the per-stage-kind design this
//   ticket exists to retire, and would stop being true the moment diagram
//   rendering ever does move server-side.
//
//   The CLIENT gets more out of the generic reference than the server can. In
//   whichever browser a comment was minted in -- and in a later browser too, as
//   long as mermaid's internal SVG structure for this source hasn't shifted --
//   `domRef` addresses the clicked node directly against the LIVE rendered SVG.
//   src/ui.mjs's renderMermaidPins tries this first, for POSITIONING only, and
//   trusts it only if the element it lands on ALSO carries the stored `ref` in
//   its own generated id -- cheap cross-check, so a shifted internal structure
//   (a different mermaid CDN version, say) can never silently position a pin on
//   the wrong node. When that check fails, or there is no live SVG at all (CDN
//   unreachable -- ticket 05's other constraint, see src/ui.mjs's
//   renderMermaidBlocks), positioning falls back to the pre-ticket-05 id-
//   attribute scan over every `[id^="flowchart-"]` node. Positioning is
//   display-only either way, never authoritative: the resolved/lost verdict a
//   pin's STYLE is drawn from always comes from the server's resolveComment
//   (this file's own header comment; src/ui.mjs never re-derives it) -- an
//   offline archive review still shows every pin, using that verdict, whether
//   or not a live SVG exists to position against at all.

const DEFAULT_HINT_MAX = 80;

/** Trim an element's text down to a legible hint: collapse whitespace and cap
 * length. A DOM path alone means nothing to the agent reading the packet — "the
 * Send button in the after stage" is the hint's job, not the path's. */
export function extractHint(text, max = DEFAULT_HINT_MAX) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).replace(/\s+$/, '') + '…';
}

/** Compose a criterion-6 hint ("the Send button in the after stage") from
 * already-extracted, DOM-free inputs. src/ui.mjs is the only caller that ever
 * has a real element to read `text`/`tagName`/`insideCompare`/`compareLabel`/
 * `blockKind` off of -- gathering those five values IS the DOM-touching half
 * (its own `anchorContext`, next to where it embeds this function) -- but the
 * RULE for turning them into a hint string has no DOM in its signature at all,
 * which is what makes it embeddable via `composeHint.toString()` (see
 * src/patch.mjs's `computeBoardPatch` for the established precedent this
 * copies) rather than a second, hand-written copy that could silently drift --
 * see this file's design comment above ("HOW A HINT IS DERIVED") for why that
 * distinction matters here specifically.
 *
 * `ROLE_WORD`/`BLOCK_NOUN` are declared INSIDE this function on purpose, exactly
 * like `computeBoardPatch`'s own inner helpers: the embedded copy carries only
 * this function's own body, so a module-level constant would import cleanly
 * here and be a ReferenceError in the served page. `text` is expected to already
 * be `extractHint(el.textContent)` -- this function does not re-trim or
 * re-truncate it, only decides whether to append a role word and/or a
 * "in <context>" suffix. */
export function composeHint(text, tagName, insideCompare, compareLabel, blockKind) {
  var ROLE_WORD = { button: 'button', a: 'link', img: 'image', input: 'field', textarea: 'field', select: 'menu' };
  var BLOCK_NOUN = { html: 'stage', mermaid: 'diagram', code: 'reference', question: 'question', compare: 'comparison', markdown: 'block' };
  var tag = String(tagName || '').toLowerCase();
  // Audit C6: `tag`/`blockKind` come from the mock's own markup and the caller's
  // block kind respectively -- both attacker/author-influenced strings. An
  // unguarded `ROLE_WORD[tag]` walks the prototype chain for a tag like
  // 'constructor', returning `Object` (the constructor FUNCTION, not a role
  // word), which `JSON.stringify` then silently drops when the anchor is
  // persisted. `hasOwnProperty` closes that off the same way `NAMED_ENTITIES`
  // above already guards its own lookup.
  var role = Object.prototype.hasOwnProperty.call(ROLE_WORD, tag) ? ROLE_WORD[tag] : undefined;
  var context = insideCompare
    ? (String(compareLabel || '') + ' ' + (Object.prototype.hasOwnProperty.call(BLOCK_NOUN, blockKind) ? BLOCK_NOUN[blockKind] : 'block')).replace(/\s+/g, ' ').trim()
    : '';
  // The role word ("... button") is appended ONLY alongside real context --
  // without something to disambiguate against, an element's own text is already
  // unambiguous on its own block, and suppressing the role word there is what
  // keeps ticket 02's plain html-stage hint ('Send', not 'Send button')
  // unchanged outside a compare.
  var identity = text ? (context && role ? text + ' ' + role : text) : (role || tag);
  // Coerced to a string so this function can never return anything else (audit
  // C6) -- every input above is now guarded, but the return stays defensive
  // rather than relying on that staying true forever.
  return String(context ? identity + ' in ' + context : identity);
}

/** Serialise a root-to-element chain of 1-based child indices into the stored ref
 * string. */
export function stepsToPath(steps) {
  return (steps || []).join('.');
}

/** Parse a stored ref back into its step numbers. Malformed segments are dropped
 * rather than throwing, since a hand-edited or corrupted board should degrade to
 * "unresolvable", not crash the render. */
export function pathToSteps(path) {
  if (!path) return [];
  return String(path)
    .split('.')
    .map(s => parseInt(s, 10))
    .filter(n => Number.isInteger(n) && n > 0);
}

/** Walk `steps` (1-based child indices) down from `root`, an object exposing a
 * `.children` indexable collection — a real DOM Element in the browser, or a plain
 * `{ children: [...] }` tree in a unit test. Returns the node at the end of the
 * chain, or null the moment a step doesn't resolve (out of range, or a node with no
 * children) — exactly the "this anchor no longer resolves" case. */
export function resolveSteps(root, steps) {
  let node = root;
  for (const i of steps || []) {
    const kids = node && node.children;
    const child = kids ? kids[i - 1] : undefined;
    if (!child) return null;
    node = child;
  }
  return node;
}

/** Build the step chain from `root` down to `el` by walking `.parentElement`
 * (again, anything exposing that plus `.children` — a real Element, or a plain
 * `{ children, parentElement }` tree in a unit test), recording each ancestor's
 * 1-based position among its own parent's children. Returns null if `el` is not
 * inside `root` at all, so a stray click outside the stage never anchors garbage. */
export function buildSteps(root, el) {
  const steps = [];
  let node = el;
  while (node && node !== root) {
    const parent = node.parentElement;
    if (!parent) return null;
    const idx = Array.prototype.indexOf.call(parent.children, node);
    if (idx === -1) return null;
    steps.unshift(idx + 1);
    node = parent;
  }
  if (node !== root) return null;
  return steps;
}

// --- html tree, just enough of one --------------------------------------------
//
// resolveDomAnchor (below) needs to answer two questions about a *snapshotted*
// html string with no browser available: does this stored ref (an index chain)
// still address an element, and does that element's own text contain the hint?
// Earlier drafts answered a weaker, wrong question instead — "does the hint appear
// anywhere in the raw html at all" — which false-resolved against tag names and
// attribute values (a hint of "mock" matching `class="mock"`) and false-"lost"
// anything spanning nested markup, entities, or extractHint's own truncation
// ellipsis (ablation/audit-caught: see TICKETS_BOARD.md ticket 06's log). Fixed by
// actually parsing enough structure to walk the ref and read that one element's
// text, the same way a real DOM would, rather than pattern-matching the whole
// blob.
//
// Deliberately not a full HTML parser: no quirks-mode recovery, entity table
// limited to the five named entities plus numeric refs, malformed/unmatched
// closing tags are ignored rather than repaired. Same "good enough, not
// exhaustive" tier this codebase already applies elsewhere (markdown.mjs's own
// stated ceiling; mermaid's grammar staying client-side below) — a resolve
// failure here must degrade to "anchor lost", never throw or hang.

// Exported (ticket 07) so test/dom-stand-in.mjs's tokenizer treats exactly the
// same tags as void -- the stand-in's own former copy of this list was missing
// 'param', a real (if narrow) parity gap this closes by construction rather than
// by remembering to keep two lists in sync.
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Named entities decoded when reconstructing an element's text. The five XML ones
// plus the typographic set a hand-written html stage actually uses: the hint is
// minted in the BROWSER from `textContent`, which has already decoded every entity,
// so any entity this table misses makes `elementText` return the literal source
// (`Don&rsquo;t send`) where the stored hint holds the decoded character (`Don’t
// send`) — and a live element reports LOST. Unknown entities are left verbatim
// rather than guessed at; keeping the table honest is what this list is for.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…',
  times: '×', divide: '÷', minus: '−', plusmn: '±',
  deg: '°', micro: 'µ', middot: '·', bull: '•',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
  lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  frac12: '½', frac14: '¼', frac34: '¾',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞',
  check: '✓', cross: '✗', star: '☆', hearts: '♥',
  shy: '­', iexcl: '¡', iquest: '¿',
};

// --- tag omission ------------------------------------------------------------
//
// The index chain in a stored `dom` anchor is minted by src/ui.mjs against the
// BROWSER's parse of the stage html and resolved here against this module's parse
// of the same string. If the two trees differ by a single node, the chain addresses
// a different element server-side and a live, on-screen element is reported LOST --
// the one failure mode this module's own invariant forbids (see mermaidRefResolves
// below for the same rule stated for mermaid). Earlier fixtures used only
// div/span/button/p nesting, where the two parses happen to agree; the rules below
// cover the shapes where they did not (audit H6):
//
//   <table><tr>...            the browser inserts an implied <tbody>
//   <ul><li>a<li>b</ul>       <li> auto-closes the open <li>
//   <p>intro<div>...          <div> auto-closes the open <p>
//   <script>/<style>          the browser keeps the element (with text content that
//                              is never markup); this parser used to DELETE it, so
//                              every following sibling's index was off by one
//
// Still deliberately not a full HTML parser (no foster parenting, no formatting
// element reconstruction, no quirks mode) -- the same "good enough, not exhaustive"
// tier stated above. These are the omissions that actually occur in a hand-written
// html stage.

// Start tags that close an open <p> (HTML's p end-tag omission list).
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
]);

/** Pop the elements a `tag` start implies are finished, mutating `stack`. Never pops
 * past index 0 (the synthetic root). Exported (ticket 07, SPEC_ANCHORING.md) so
 * test/dom-stand-in.mjs's own tag-omission handling is this exact function, not a
 * second, hand-ported copy that could silently drift the way it did before ticket
 * 07 (audit finding C3): sharing the DECISION functions is what keeps the two
 * parsers' trees agreeing on `<ul><li>a<li>b</ul>`-shaped input, even though the
 * stand-in's own tokenizer (which also has to build real Element objects with
 * attributes) stays separate from parseHtmlTree's. */
export function autoCloseFor(stack, tag) {
  const top = () => stack[stack.length - 1].tag;
  const popWhile = set => { while (stack.length > 1 && set.has(top())) stack.pop(); };
  if (tag === 'li') return popWhile(new Set(['p', 'li']));
  if (tag === 'dt' || tag === 'dd') return popWhile(new Set(['p', 'dt', 'dd']));
  if (tag === 'tr') return popWhile(new Set(['p', 'td', 'th', 'tr']));
  if (tag === 'td' || tag === 'th') return popWhile(new Set(['p', 'td', 'th']));
  if (tag === 'tbody' || tag === 'thead' || tag === 'tfoot') {
    return popWhile(new Set(['p', 'td', 'th', 'tr', 'tbody', 'thead', 'tfoot']));
  }
  if (tag === 'option') return popWhile(new Set(['option']));
  if (tag === 'optgroup') return popWhile(new Set(['option', 'optgroup']));
  if (CLOSES_P.has(tag)) return popWhile(new Set(['p']));
}

/** Which element the browser implicitly opens before `tag` can be inserted under
 * `parentTag`, or null. Applied repeatedly, so a `<td>` straight inside `<table>`
 * gets both the `<tbody>` and the `<tr>`. Exported for the same reason as
 * autoCloseFor above -- test/check-parser-parity.mjs feeds both this module and
 * the stand-in the same corpus and asserts identical trees. */
export function impliedParentFor(parentTag, tag) {
  if (parentTag === 'table' && (tag === 'tr' || tag === 'td' || tag === 'th')) return 'tbody';
  if ((parentTag === 'tbody' || parentTag === 'thead' || parentTag === 'tfoot')
      && (tag === 'td' || tag === 'th')) return 'tr';
  return null;
}

// The highest code point `String.fromCodePoint` accepts. A numeric entity outside
// 0..0x10FFFF (a lone `&#1114112;`, or the far larger `&#x999999999;` an attacker
// can write just as easily) makes `String.fromCodePoint` throw `RangeError` --
// this table's whole job is to never let a malformed entity anywhere near that
// call. See parseHtmlTree's "Never throws" contract just below: this function is
// the one place that contract used to be false (audit V5a).
const MAX_CODE_POINT = 0x10ffff;

/** Exported (ticket 07) so test/dom-stand-in.mjs decodes entities identically to
 * this module -- one entity table, not two that could disagree on, say, `&mdash;`
 * inside an agent-supplied html-stage mock.
 *
 * An entity this function cannot decode -- an unknown name, or a numeric
 * reference out of Unicode's range -- degrades to the literal matched text
 * (`whole`), exactly like an already-unknown named entity does two lines below.
 * That is the same "good enough, not exhaustive" degrade-don't-throw rule this
 * whole parser is built on (see parseHtmlTree's own comment), and it is what
 * keeps this function honouring parseHtmlTree's "Never throws" contract: before
 * this guard, `Number.isFinite(code)` let through any finite-but-out-of-range
 * code point (`&#1114112;` is one past the max; `&#x999999999;` parses to a
 * finite number nowhere near Unicode), and `String.fromCodePoint` raised
 * `RangeError` on it -- a throw from deep inside a "never throws" tree-builder,
 * reachable from raw, un-decoded attacker-supplied `block.html` on an html stage
 * (markdown escapes `&` before block parsing, so this is the one path that
 * reaches this function with content nobody already sanitised). */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : whole;
  });
}

/** Extract an opening tag's `class` attribute value, split into class-name
 * tokens, or null if it has none. `attrs` is one tag's ALREADY-CAPTURED
 * attribute substring (tokenRe's own `m[3]`), never the whole document, so
 * this is a bounded secondary scan over a few dozen characters at most -- not
 * a second backtracking-capable pass over attacker-controlled input the way
 * tokenRe's own comment above warns against avoiding. The only attribute
 * value this otherwise attribute-blind parser reads (see this section's own
 * header comment) -- added (audit V3) so resolveDomAnchorInSection can
 * recognise the board's own rendered chrome and refuse to resolve a ref that
 * lands there. */
function parseClassAttr(attrs) {
  if (!attrs) return null;
  const m = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/i.exec(attrs);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? '';
  return decodeEntities(raw).split(/\s+/).filter(Boolean);
}

/** Strip HTML comments with a linear `indexOf` scan. The obvious
 * `/<!--[\s\S]*?-->/g` is lazy-quantified over an any-character class, which on a
 * long unterminated comment degrades quadratically — and every byte of this
 * function's input is attacker-influenced file content that gets re-parsed on every
 * render, SSE fragment and packet (see the head of this file). */
function stripComments(src) {
  if (src.indexOf('<!--') === -1) return src;
  let out = '';
  let from = 0;
  for (;;) {
    const start = src.indexOf('<!--', from);
    if (start === -1) { out += src.slice(from); return out; }
    out += src.slice(from, start);
    const end = src.indexOf('-->', start + 4);
    if (end === -1) return out; // unterminated: the rest is comment, as in a browser
    from = end + 3;
  }
}

/** Parse `html` into a lightweight element tree. Each element node is
 * `{ tag, children, content }`: `children` holds ELEMENT nodes only, 1-based
 * `resolveSteps` above indexes into it exactly like a real `Element.children`
 * collection (text nodes are not counted, matching the DOM); `content` holds
 * every child (element and `{ tag: '#text', text }` alike) in document order, for
 * reconstructing this element's own text.
 *
 * Implied tags (`<tbody>` inside `<table>`, auto-closed `p`/`li`/`tr`/`td`/`option`)
 * are applied so the tree matches what the browser's parser builds from the same
 * string — see the tag-omission comment above for why an off-by-one node is a
 * correctness bug, not a cosmetic one.
 *
 * `<script>`/`<style>` are kept as ELEMENT nodes (the browser keeps them, and every
 * following sibling's index depends on it) with their raw text blanked: their body
 * is consumed by an `indexOf` scan for the matching close tag, so a `<` inside is
 * never mistaken for markup and never contributes text. HTML comments are stripped
 * first, also by `indexOf`.
 *
 * Runs in time linear in the input: no backtracking-capable pattern anywhere on this
 * path. Never throws — an html string too broken to make sense of just yields a
 * sparse or empty tree, which resolveSteps then reports unresolvable. */
export function parseHtmlTree(html) {
  const root = { tag: '#root', children: [], content: [] };
  const stack = [root];
  const src = stripComments(String(html ?? ''));
  const lower = src.toLowerCase(); // computed once: used to find script/style ends

  const open = (tag, attrs) => {
    // `cls` (audit V3): the one attribute value this otherwise attribute-blind
    // parser reads, so resolveDomAnchorInSection can recognise the board's own
    // rendered chrome (`.block-kicker`, `.pin-layer`, ...) and refuse to
    // resolve a ref that lands there -- see isChromeNode below. Scoped to one
    // already-captured tag's attribute substring, never a second scan over the
    // whole document.
    const node = { tag, children: [], content: [], cls: parseClassAttr(attrs) };
    const top = stack[stack.length - 1];
    top.children.push(node);
    top.content.push(node);
    return node;
  };

  // Alternation is unambiguous (each branch is anchored on a distinct prefix) and
  // every quantifier is over a negated class that excludes both `>` and `<`, so an
  // unterminated tag fails at the next `<` instead of rescanning to end-of-input
  // from every start position. Single linear scan, no backtracking blowup.
  //
  // The tag-name group `[\w-]*` is followed by `(?![\w-])` in both the close-tag
  // and open-tag branches -- without it, that group and what immediately follows
  // (`[^>]*` in the close-tag branch; the attribute group's own `[^><"']` default
  // alternative in the open-tag branch) both accept plain word characters, so on
  // an unterminated tag the engine tried every possible split between the two
  // groups before giving up: O(n) splits, each requiring an O(n) re-match of the
  // remainder, for O(n^2) total (measured: 500 K chars -> 73.6s per comment,
  // audit V5b). The lookahead pins the tag-name group to its one greedy, maximal
  // match -- it fails in O(1) at every shorter length instead of handing off to
  // the next group -- so a failed match is O(n), not O(n^2). Every input that
  // used to match still matches the same way: a well-formed tag name is always
  // immediately followed by `>`, `/`, whitespace or a quote, none of which are
  // `[\w-]`, so the lookahead is already satisfied by the same maximal match the
  // greedy quantifier picks first.
  const tokenRe = /<![^>]*>|<\/([a-zA-Z][\w-]*)(?![\w-])[^>]*>|<([a-zA-Z][\w-]*)(?![\w-])((?:"[^"<]*"|'[^'<]*'|[^><"'])*?)(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = tokenRe.exec(src)) != null) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let i = stack.length - 1;
      while (i > 0 && stack[i].tag !== tag) i--;
      if (i > 0) stack.length = i; // unmatched close: ignored, never throws
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const selfClosed = m[4] === '/';
      autoCloseFor(stack, tag);
      for (let guard = 0; guard < 4; guard++) {
        const implied = impliedParentFor(stack[stack.length - 1].tag, tag);
        if (!implied) break;
        stack.push(open(implied));
      }
      const node = open(tag, m[3]);
      if (tag === 'script' || tag === 'style') {
        // Kept as a node (matching the browser), body consumed and blanked.
        const close = lower.indexOf('</' + tag, tokenRe.lastIndex);
        const end = close === -1 ? src.length : src.indexOf('>', close);
        tokenRe.lastIndex = end === -1 ? src.length : end + 1;
        continue;
      }
      if (!VOID_ELEMENTS.has(tag) && !selfClosed) stack.push(node);
    } else if (m[5]) {
      stack[stack.length - 1].content.push({ tag: '#text', text: decodeEntities(m[5]) });
    } else if (m[6]) {
      // A bare '<' that starts nothing tag-shaped is literal text, as in a browser.
      stack[stack.length - 1].content.push({ tag: '#text', text: '<' });
    }
  }
  return root;
}

/** Every descendant text run of `node`, in document order, concatenated —
 * `Element.textContent`'s equivalent over the tree parseHtmlTree builds. */
export function elementText(node) {
  if (!node) return '';
  let out = '';
  for (const child of node.content || []) {
    out += child.tag === '#text' ? child.text : elementText(child);
  }
  return out;
}

/** Common-prefix length of two strings, ordinal comparison. Helper for
 * `roleAwareInPrefix` below. */
function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** The "<identity> [<role word>] in " prefix `composeHint` would have produced
 * for this `text`/`tag` alongside SOME non-empty context -- i.e. everything up
 * to and including the literal " in " that precedes the context suffix, with
 * the role word included only when composeHint would have appended one.
 * Derived by calling the real `composeHint` twice with two probe contexts
 * chosen to diverge at their very first character, then taking the two
 * results' common prefix -- rather than a second, hand-copied ROLE_WORD table
 * that could silently drift from composeHint's own (see this file's "one
 * implementation, not two" comment above composeHint). Returns '' for a
 * text-less element: composeHint never appends a role word to a bare
 * role/tag-name identity, only to real text (see composeHint's own comment on
 * why). */
function roleAwareInPrefix(text, tag) {
  if (!text) return '';
  const a = composeHint(text, tag, true, 'Qprobe', 'markdown');
  const b = composeHint(text, tag, true, 'Zprobe', 'markdown');
  return a.slice(0, commonPrefixLength(a, b));
}

/** Ticket 04, fixed by the 2026-07-29 audit (finding C1): whether `node`'s own
 * live content still backs a stored `hint`. Content is snapshotted at post time
 * (SPEC_ANCHORING.md Decisions -> "An anchor survives re-render, not editing"),
 * so a still-live element's own text hasn't changed since mint time:
 * re-deriving the IDENTITY half of composeHint's rule from that unchanged text
 * (extractHint of the resolved element's own text, or -- when there's no text
 * at all, e.g. an image -- composeHint's own role-word/tag fallback) reproduces
 * exactly what composeHint started the stored hint with at mint time.
 *
 * The ORIGINAL ticket-04 version checked `hint.startsWith(recomputedIdentity)`,
 * which reads right (a hint with an appended role word or "in <context>" suffix
 * really does start with its own identity) but is backwards as a MATCH test: a
 * live element whose text shrank to a literal prefix of some unrelated stored
 * hint -- `<button>S</button>` against a stored hint `'Send'`, or ANY empty
 * element against a stored hint beginning with its bare tag name (`'div is
 * broken'` against an empty `<div>`, whose fallback identity is the string
 * `'div'`) -- also satisfies `startsWith` by coincidence, without the two
 * strings actually being the same identity. That is audit finding C1: it does
 * not merely fail to catch a lost anchor, it resolves the comment onto the
 * WRONG element and reports it resolved.
 *
 * The fix checks EQUALITY against one of the exact shapes composeHint can
 * produce -- `identity`, `identity + ' in ' + <anything>`, or `identity + ' '
 * + role + ' in ' + <anything>` -- rather than inferring the identity portion
 * with a prefix test. A bare tag-name fallback identity (no role word, no
 * text) therefore only ever matches a hint that equals it exactly or extends
 * it with a genuine " in <context>" suffix, never an unrelated hint that
 * merely happens to start with the same three letters. */
function domIdentityHintMatches(node, hint) {
  const normalizedHint = String(hint ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedHint) return false;
  const text = extractHint(elementText(node));
  const tag = String(node.tag || '');
  const identity = String(text || composeHint('', tag, false, '', '')).replace(/\s+/g, ' ').trim();
  if (!identity) return false;
  if (normalizedHint === identity) return true;
  const bareInPrefix = identity + ' in ';
  if (normalizedHint.length > bareInPrefix.length && normalizedHint.startsWith(bareInPrefix)) return true;
  const roleInPrefix = roleAwareInPrefix(text, tag);
  return !!roleInPrefix
    && normalizedHint.length > roleInPrefix.length
    && normalizedHint.startsWith(roleInPrefix);
}

// --- html body root (audit finding C2) ----------------------------------------
//
// resolveDomAnchor's `ref` is a step chain minted client-side from a real
// browser's `document.body` (src/ui.mjs's wireHtmlStage roots buildSteps at
// `frame.contentDocument.body`, exactly like a page-scoped anchor roots at a
// block's own section) -- never from parseHtmlTree's synthetic `#root`, whose
// children are just "every top-level thing this parse saw", head-only or not.
// A browser starts every document in "in head" insertion mode: a leading
// style/script/meta/link/title/base element is inserted into `<head>`, and the
// first non-head-only start tag or non-whitespace text switches insertion mode
// to "in body" for everything from there on (a `<style>` AFTER that switch is
// an ordinary body child, same as this module already modelled). An explicit
// `<html>`/`<head>`/`<body>` wrapper is honoured as given rather than
// re-hoisted. Left unmodelled, an ordinary mock that inlines its own styling --
// which SPEC_ANCHORING.md's own isolation Decision is what makes an author
// do -- shifts the index of every element that follows the leading `<style>`,
// so a browser's `body.children[0]` (the real, clicked element) is this
// module's `root.children[1]`: every ref minted against the real DOM reports
// LOST against the unhoisted parse. Exported so test/dom-stand-in.mjs's own
// srcdoc parsing (test/check-click.mjs and friends' simulated "browser") hoists
// the exact same set of tags, not a second, independently-maintained list.
export const HEAD_ONLY_TAGS = new Set(['style', 'script', 'meta', 'link', 'title', 'base']);

/** Reduce parseHtmlTree's raw top-level parse to what a browser's
 * `document.body` would contain for the same string -- see HEAD_ONLY_TAGS
 * above for the full reasoning. */
function bodyRootChildren(root) {
  let children = root.children;
  const htmlEl = children.find(n => n.tag === 'html');
  if (htmlEl) children = htmlEl.children;
  const bodyEl = children.find(n => n.tag === 'body');
  if (bodyEl) return bodyEl.children;
  const withoutHead = children.filter(n => n.tag !== 'head');
  let i = 0;
  while (i < withoutHead.length && HEAD_ONLY_TAGS.has(withoutHead[i].tag)) i++;
  return withoutHead.slice(i);
}

// --- resolution surface exclusion (audit finding V3) --------------------------
//
// A block's re-rendered section is mostly the board's OWN chrome, not authored
// content: src/render.mjs's renderMarkdownBlock, for instance, emits a section
// whose 6 children are block-kicker, md-content, pin-layer, comment-target,
// comment-form, comment-list -- five of six are chrome, only one is the
// content a reviewer could actually have clicked. src/ui.mjs's own click
// listener never mints a ref into any of them (ANCHOR_CHROME_SELECTOR,
// checked via `closest()` before buildSteps ever runs), but resolveComment had
// no matching exclusion: `applySubmit` stores whatever `anchor` shape a submit
// body carries, so a forged or hand-edited `dom`/`mermaid` anchor whose `ref`
// happens to address the kicker or the comment list resolved "true" against
// content that was never a reviewer's click target at all. Mirrored here by
// class, not by re-deriving position: parseHtmlTree now records each element's
// `class` attribute (see `open`/`parseClassAttr` above) for exactly this.
//
// Folded into `resolveAtRoot` below (not left as a second wrapper) so every
// caller that reduces to it -- the html-stage root, a page-scoped section
// root, and (through `resolveMermaidAnchorAtRoot`) a mermaid section root --
// gets the same exclusion for free, including src/board.mjs's cached/batched
// `resolveComments` entry point, which resolves straight from an already-
// parsed root and would otherwise bypass it entirely. An html stage's iframe
// body carries no page chrome of its own (block-kicker etc. live in the
// PARENT document, outside the sandboxed srcdoc), so this can only ever
// matter there in the pathological case of a hand-mocked element that
// happens to reuse one of the board's own internal class names -- narrower
// and fail-safe (a reported "lost", never a wrong resolve) compared to V3's
// actual finding of a forged ref reaching real page chrome.
const CHROME_CLASSES = new Set([
  'block-kicker', 'comment-btn', 'comment-form', 'comment-target',
  'comment-list', 'pin-layer', 'anchor-pin', 'mode-toggle', 'compare-label',
  'round-label', 'html-stage',
]);

/** Ancestor-or-self chrome test, mirroring src/ui.mjs's `isAnchorChrome`
 * (`el.closest(ANCHOR_CHROME_SELECTOR)`) over parseHtmlTree's tree instead of a
 * live DOM: true for a class this file's own `CHROME_CLASSES` names, or a
 * `<pre class="mermaid">` (`pre.mermaid` in the client's selector -- a tag+class
 * pair, the one entry in ANCHOR_CHROME_SELECTOR that isn't class-only). */
function isChromeNode(node) {
  if (!node) return false;
  const cls = node.cls || [];
  if (cls.some(c => CHROME_CLASSES.has(c))) return true;
  if (node.tag === 'pre' && cls.includes('mermaid')) return true;
  return false;
}

/** Like `resolveSteps`, but returns null the moment the walk passes through a
 * chrome element (`isChromeNode` above) -- at any depth, not just at the final
 * node, matching `closest()`'s ancestor-or-self semantics: a ref two levels
 * inside `.comment-list` is chrome because its ANCESTOR is, even though the
 * leaf node itself carries no chrome class of its own. */
function resolveStepsRejectingChrome(root, steps) {
  let node = root;
  for (const i of steps || []) {
    const kids = node && node.children;
    const child = kids ? kids[i - 1] : undefined;
    if (!child || isChromeNode(child)) return null;
    node = child;
  }
  return node;
}

/** The ref+hint check every `dom`/`mermaid` resolution path below ultimately
 * reduces to, against an ALREADY-PARSED root. Factored out of resolveDomAnchor/
 * resolveDomAnchorInSection (ticket 11, audit V4): `resolveComment` used to call
 * those two functions once per COMMENT, and each call parsed (and, for the
 * page-scoped case, re-rendered) the anchored block from scratch -- on a board
 * with many comments on the same block, every comment after the first repeated
 * work whose result could not have changed, since nothing about the block
 * changed between comments in the same resolution pass. This is the shared
 * bottom half that lets a caller parse/render a block ONCE and resolve every
 * comment on it against that one root -- src/board.mjs's `resolveComment` is
 * that caller; `resolveDomAnchor`/`resolveDomAnchorInSection` below remain the
 * right thing to call for a single one-off anchor (as every existing test
 * does), and are now thin wrappers around this.
 *
 * Audit V3: walks via `resolveStepsRejectingChrome` (above) rather than plain
 * `resolveSteps`, so every caller that bottoms out here refuses to resolve
 * into the board's own rendered chrome, the same exclusion src/ui.mjs's click
 * listener already applies before it ever mints a ref. */
export function resolveAtRoot(root, ref, hint) {
  const steps = pathToSteps(ref);
  if (!steps.length) return false;
  const node = resolveStepsRejectingChrome(root, steps);
  if (!node) return false;
  return domIdentityHintMatches(node, hint);
}

/** The root a `dom` anchor rooted at an html stage's iframe body resolves
 * against, given the block's own snapshotted `html` string -- modelled as a
 * browser's `document.body` would see it, not parseHtmlTree's raw synthetic
 * root (see HEAD_ONLY_TAGS/bodyRootChildren above, audit C2). Exported (same
 * pattern as `sectionRootFrom` below) so a caller resolving several comments
 * against the same html-stage block -- src/board.mjs's `resolveComments`
 * batch path -- can parse and hoist once instead of per comment; that cache
 * is exactly what makes this the one place C2's fix has to live, since a
 * cached-but-unhoisted root would silently undo it for every comment after
 * the first. */
export function htmlBodyRootFrom(html) {
  return { children: bodyRootChildren(parseHtmlTree(html)) };
}

/** Whether a `dom` anchor rooted at an html stage's iframe body still
 * resolves: `ref` (the index-chain path) must address an element in `html`'s
 * parsed structure and that element's own identity (see
 * domIdentityHintMatches above) must back the stored `hint`. Both checks
 * matter — see this file's comment above for what went wrong when only the
 * hint was checked against the raw html blob. */
export function resolveDomAnchor(html, ref, hint) {
  return resolveAtRoot(htmlBodyRootFrom(html), ref, hint);
}

/** The section root a page-scoped `dom`/`mermaid` anchor resolves against, given
 * `sectionHtml` (a block's own section, re-rendered from its stored content).
 * `renderBlock` emits exactly one top-level element (the `<section>` itself,
 * everything else in its output is surrounding whitespace text), so that
 * element is always `parseHtmlTree(sectionHtml).children[0]`. Exported (ticket
 * 11) so a caller resolving several comments against the same block can parse
 * once and pass the result to `resolveAtRoot`/`resolveMermaidAnchorAtRoot`
 * directly instead of re-parsing per comment. */
export function sectionRootFrom(sectionHtml) {
  return parseHtmlTree(sectionHtml).children[0] || null;
}

/** Ticket 04: whether a page-scoped `dom` anchor (root = the anchored block's own
 * `<section data-block-id>`, not an html stage's iframe body — see this file's
 * "ticket 03 design" comment above) still resolves against `sectionHtml`, the
 * block's own section re-rendered from its stored content by src/board.mjs's
 * resolveComment (src/render.mjs's `renderBlock`, exported for exactly this).
 * Differs from `resolveDomAnchor` above only in the root: `buildSteps` mints a
 * page-scoped ref from the block's own section element (src/ui.mjs's
 * `anchorRootFor`), not from `<body>` — so resolution has to walk from that same
 * element, not from the parse's synthetic root. Audit V3's chrome exclusion is
 * applied inside `resolveAtRoot`, not repeated here. */
export function resolveDomAnchorInSection(sectionHtml, ref, hint) {
  const sectionRoot = sectionRootFrom(sectionHtml);
  if (!sectionRoot) return false;
  return resolveAtRoot(sectionRoot, ref, hint);
}

// --- mermaid ---------------------------------------------------------------

/** Mermaid's own generated element id for a flowchart node ends
 * `flowchart-<nodeId>-<sequence>`, and in the mermaid 11 the page actually loads
 * it is PREFIXED with the diagram's own svg id, e.g.
 * `mermaid-1785397890978-flowchart-shim-0`. Recover the source-declared node id a
 * click landed on, so the anchor traces back to the diagram source rather than
 * inventing a new id scheme. Returns null for anything that doesn't match the
 * shape (a click on an edge label, the diagram background, etc. — those don't
 * anchor). Only flowchart diagrams are covered: sequence/class/state/ER diagrams
 * use different id conventions and are a documented gap, not silently
 * mis-anchored (a click there simply doesn't anchor an element, same as clicking
 * blank space).
 *
 * The prefix is why this is not anchored at `^`. Matching only `^flowchart-` is
 * what made the whole diagram gesture dead in a real browser — click, hover
 * affordance and pin rendering all keyed off that prefix and none of them ever
 * matched, while every check passed because the checks hand-wrote SVG bearing
 * the unprefixed id mermaid does not actually emit. Confirmed against mermaid@11
 * from the CDN, 2026-07-30. Both shapes are accepted: mermaid 10 emitted the
 * bare form, and an archived board holds whatever its own render produced. */
export function parseMermaidDomId(domId) {
  const m = /(?:^|-)flowchart-(.+)-\d+$/.exec(String(domId ?? ''));
  return m ? m[1] : null;
}

/** The selector half of the same rule, shared by the click handler's walk-up, the
 * pin-candidate scan and the hover/cursor CSS — kept here so those three and
 * parseMermaidDomId cannot drift apart again, which is exactly how the gesture
 * died. `[id^=]` alone misses mermaid 11's prefixed ids; `[id*=]` on `-flowchart-`
 * catches them, with the bare `^` form kept for mermaid 10 / older archives. */
export const MERMAID_NODE_SELECTOR = '[id*="-flowchart-"], [id^="flowchart-"]';

/** Does `ref` (a mermaid node id) still trace back to the diagram source? A
 * deliberately weak question — not "enumerate every id the source declares"
 * (earlier drafts tried to parse mermaid's arrow/shape grammar to do that; it was
 * both wrong on ordinary syntax like chained arrows and inline-label edges, and
 * had catastrophic-backtracking behaviour on adversarial input, since this runs
 * server-side on every render/packet — see TICKETS_BOARD.md ticket 06's log) but
 * "does this exact token still appear in the text at all", answered by a single
 * linear scan with no backtracking-capable pattern. A plain presence check can
 * false-positive if the id string happens to appear inside a label rather than as
 * a real id; it cannot false-negative on a legitimate, still-present id, which is
 * the failure mode that actually matters for "an anchor that no longer resolves
 * reports what it lost" (SPEC_BOARD.md) — a live anchor must never be misreported
 * lost. Parsing mermaid's grammar fully stays client-side, from its own CDN engine
 * (SPEC_BOARD.md "The daemon renders markdown; the page renders mermaid"). */
export function mermaidRefResolves(source, ref) {
  if (!ref) return false;
  const text = String(source ?? '');
  const needle = String(ref);
  // `-` is NOT a boundary-blocking character. Mermaid's dominant edge operators are
  // `-->`, `---`, `-.->` and `-->|label|`, all of which put a hyphen immediately
  // against a node id, so treating `-` as a word character reported `A` LOST in
  // `A-->B` -- i.e. lost against the very source the anchor was minted from seconds
  // earlier, and asymmetrically (`B` resolved), which reads to the agent like
  // corruption rather than a stale anchor. The cost of dropping it is that an id
  // like `A-1` also matches inside `A-1-2`; that is a false POSITIVE, the direction
  // this function is explicitly allowed to err in (see above) -- a live anchor must
  // never be misreported lost.
  const isWordChar = c => /[A-Za-z0-9_]/.test(c);
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : text[i - 1];
    const after = i + needle.length >= text.length ? '' : text[i + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = i + 1;
  }
}

/** Ticket 05: whether a mermaid node's anchor still resolves -- the generic,
 * page-scoped dom reference tried first, the node id leaned on as a fallback.
 * See this file's "ticket 05 design" comment above for the full reasoning; this
 * is deliberately a thin composition of two functions that already exist and
 * are already independently tested (resolveDomAnchorInSection, mermaidRefResolves)
 * rather than a third parsing path of its own -- the one new thing here is the
 * ORDER, which is the whole point ticket 05 exists to get right and pin down
 * somewhere checkable. `sectionHtml` is the mermaid block's own section,
 * re-rendered from its stored content exactly like resolveDomAnchorInSection's
 * other caller (src/board.mjs's resolveComment); `source` is the block's own
 * snapshotted diagram text, exactly what mermaidRefResolves already checked
 * before this ticket. `anchor` is the stored `{ kind: 'mermaid', ref, domRef,
 * hint }` object (or an older, pre-ticket-05 one carrying only `ref` -- both
 * `domRef` and `hint` are optional on purpose, see the design comment). */
/** Same precedence as `resolveMermaidAnchor` below, against an ALREADY-PARSED
 * section root (see `resolveAtRoot`/`sectionRootFrom` above -- ticket 11, audit
 * V4) instead of a raw `sectionHtml` string this function would otherwise parse
 * itself on every call. `sectionRoot` may be null (an empty/unrenderable
 * section) -- the generic half then simply cannot resolve, same as
 * `resolveDomAnchorInSection` returning false for a missing section root. */
export function resolveMermaidAnchorAtRoot(sectionRoot, source, anchor) {
  if (sectionRoot && resolveAtRoot(sectionRoot, anchor?.domRef, anchor?.hint)) return true;
  return mermaidRefResolves(source, anchor?.ref);
}

export function resolveMermaidAnchor(sectionHtml, source, anchor) {
  return resolveMermaidAnchorAtRoot(sectionRootFrom(sectionHtml), source, anchor);
}
