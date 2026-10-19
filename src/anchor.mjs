// Element-level comment anchoring: pure logic shared between the client (src/ui.mjs
// owns the actual click gesture) and the server (src/board.mjs resolves a stored
// anchor at packet-assembly time). Kept dependency-free and DOM-free on purpose so
// it is testable in node with no browser (test/check-pure.mjs) — see
// PROTOCOL.md "Answers, comments, anchors" for the two shapes this module
// builds and resolves:
// { kind: 'dom', ref, hint } and { kind: 'mermaid', ref, domRef, hint }. The
// mermaid shape gained `domRef`/`hint` without changing what `ref`
// means -- see DESIGN.md, "### Entry 28 — element anchoring", for why a
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
// build step, opens from file://), so nothing there can `import` this
// module at runtime. This module is the reference the duplicate is kept in sync
// against; test/check-pure.mjs exercises this module directly.

// The two pre-implementation design memos that used to live here (one generic
// element reference over the board's own DOM; a diagram node folding into that
// generic model) moved to DESIGN.md, "### Entry 28 — element anchoring" --
// their now-false forward references (a `resolveComment` gap since closed, an
// "every other block kind" scope ADR entry 28 has since narrowed) are marked
// superseded there, not carried across silently. What an editor needs before
// touching the code below:
//
//   - A `dom` `ref` is a stepsToPath index chain measured from one of exactly
//     two roots, chosen by the anchored block's own `kind`: an `html` block
//     roots at its iframe's `<body>` (a different DOCUMENT -- the sandboxed
//     srcdoc); every other anchorable block roots at its own rendered
//     `<section data-block-id>` in the page's own document. Deliberately NOT a
//     path from `<body>`: an absolute, page-rooted index shifts on any
//     re-render that changes what comes before it, where a block's own
//     stably-`id`ed section only has to survive that ONE block re-rendering
//     identically from its own unchanged stored content.
//   - Per ADR entry 28 ("Only the rendered kinds can be commented on"),
//     src/ui.mjs's `anchorRootFor`/`isNonAnchorableRoot` gate this whole
//     mechanism to `html` and `mermaid` before a click ever mints a ref --
//     `md` anchors are deleted outright, not merely left unused.
//   - A `mermaid` anchor's `ref` keeps its original meaning (the source node
//     id); `resolveMermaidAnchor` tries the generic `domRef`+`hint` first and
//     falls back to `ref` only when that fails (see its own docstring below
//     for why, today, the fallback is what actually resolves). Client-side
//     positioning against a live SVG is display-only and never the verdict --
//     the resolved/lost verdict always comes from the server's
//     `resolveComment`.

const DEFAULT_HINT_MAX = 80;

/** Trim an element's text down to a legible hint: collapse whitespace and cap
 * length. A DOM path alone means nothing to the agent reading the packet — "the
 * Send button in the after stage" is the hint's job, not the path's. */
export function extractHint(text, max = DEFAULT_HINT_MAX) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).replace(/\s+$/, '') + '…';
}

/** Compose a hint ("the Send button in the after stage") from already-extracted,
 * DOM-free inputs. Gathering `text`/`tagName`/`insideCompare`/`compareLabel`/`blockKind`
 * off a real element is the DOM-touching half and stays in src/ui.mjs (its own
 * `buildHint`); the RULE for turning them into a hint string has no DOM in its
 * signature at all, which is what makes it embeddable via `composeHint.toString()` (the
 * precedent is src/patch.mjs's `computeBoardPatch`) rather than a second, hand-written
 * copy that could silently drift. See "HOW A HINT IS DERIVED" above.
 *
 * `ROLE_WORD`/`BLOCK_NOUN` are declared INSIDE this function on purpose, exactly like
 * `computeBoardPatch`'s own inner helpers: the embedded copy carries only this
 * function's body, so a module-level constant would import cleanly here and be a
 * ReferenceError in the served page. `text` is expected to already be
 * `extractHint(el.textContent)` -- this only decides whether to append a role word
 * and/or an "in <context>" suffix, never re-trimming or re-truncating. */
export function composeHint(text, tagName, insideCompare, compareLabel, blockKind) {
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
}

/** A `<video>`'s identity: its `aria-label`, else its `title`, whitespace collapsed,
 * else '' -- never its fallback content, which a browser that plays the video never
 * shows. '' leaves composeHint's tag fallback to name it ('video'), the rule every
 * other text-less element already gets. One rule for both sides that read it: the
 * stage reads it off the clicked element (src/render.mjs's stageAgentScript embeds
 * this via `.toString()`, so it stays self-contained), and resolution re-derives it
 * from the snapshot (the `label` parseHtmlTree records on a video node). */
export function videoIdentity(ariaLabel, title) {
  var label = String(ariaLabel == null ? '' : ariaLabel).replace(/\s+/g, ' ').trim();
  if (label) return label;
  return String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
}

/** The whole second a video comment records, or null. Valid only as a finite number
 * from 0 to 86400 (a day); a string, NaN, a negative or a larger value is null,
 * dropped rather than coerced, because the stage's message and a submit body are both
 * untrusted. A valid value is floored: paused at 7.4s is second 7. Embedded by the
 * stage and the page via `.toString()`, and called by src/board.mjs's sanitizeAnchor,
 * so all three agree on what a time is. */
export function videoSecond(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400) return null;
  return Math.floor(value);
}

/** What a video comment's hint ends with: `" at m:ss"`, or `" at h:mm:ss"` from an
 * hour on. The page appends it to the composed hint, so the label the page and the
 * packet show reads "Criterion 2 clip at 0:07" beside the anchor's `time: 7`;
 * resolution strips it only when it equals this, before matching the identity.
 * Embedded by the page via `.toString()`, so it stays self-contained. */
export function videoTimeSuffix(second) {
  var s = Math.floor(second);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return ' at ' + (h ? h + ':' + two(m) : String(m)) + ':' + two(sec);
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

// resolveDomAnchor (below) needs to answer two questions about a *snapshotted*
// html string with no browser available: does this stored ref (an index chain)
// still address an element, and does that element's own text contain the hint?
// Earlier drafts answered a weaker, wrong question instead — "does the hint appear
// anywhere in the raw html at all" — which false-resolved against tag names and
// attribute values (a hint of "mock" matching `class="mock"`) and false-"lost"
// anything spanning nested markup, entities, or extractHint's own truncation
// ellipsis. Fixed by
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

// Exported so test/dom-stand-in.mjs's tokenizer treats exactly the
// same tags as void -- the stand-in's own former copy of this list was missing
// 'param', a real (if narrow) parity gap this closes by construction rather than
// by remembering to keep two lists in sync.
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// The two elements whose start tag switches the HTML tree builder into foreign
// content, and therefore the only ones where a trailing `/` on a start tag means
// anything at all. In HTML proper the tokenizer sets the self-closing flag and the
// tree builder never acknowledges it: `<div/>` opens a div that stays open and
// swallows its following siblings, exactly as if the slash were not there. Honoring
// the slash everywhere made this parser close an element the browser had left open,
// so every index after it shifted and a comment resolved against the wrong element
// (or was reported lost on an element that is plainly still on the page) -- the same
// class of divergence the quoted-`<`-in-attribute fix above closed. Inside SVG or
// MathML the flag IS acknowledged, for every descendant too, so foreignness is
// inherited down the subtree rather than tested tag by tag.
//
// Exported for the same reason VOID_ELEMENTS is: test/dom-stand-in.mjs models the
// BROWSER for this suite, and the point of this rule is that the browser and the
// resolver agree about which elements a start tag leaves open. Two copies of the
// set is two chances to disagree again.
export const FOREIGN_ROOTS = new Set(['svg', 'math']);

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
  // The Latin-1 accented letters. The table already carried this block's punctuation
  // and symbols but none of its letters, so a mock spelling an accent as a named
  // entity -- `G&aring;r vidare` -- left the server holding the literal text while the
  // browser's textContent read `Går vidare`, and a live, on-screen element was
  // reported lost. Numeric (`&#229;`) and literal UTF-8 already worked; only the named
  // spelling was missing.
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Yacute: 'Ý', THORN: 'Þ', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
};

// The index chain in a stored `dom` anchor is minted by src/ui.mjs against the
// BROWSER's parse of the stage html and resolved here against this module's parse
// of the same string. If the two trees differ by a single node, the chain addresses
// a different element server-side and a live, on-screen element is reported LOST --
// the one failure mode this module's own invariant forbids (see mermaidRefResolves
// below for the same rule stated for mermaid). Earlier fixtures used only
// div/span/button/p nesting, where the two parses happen to agree; the rules below
// cover the shapes where they did not:
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
 * past index 0 (the synthetic root). Exported so
 * test/dom-stand-in.mjs's own tag-omission handling is this exact function, not a
 * second, hand-ported copy that could silently drift the way it did before:
 * sharing the DECISION functions is what keeps the two
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
// the one place that contract used to be false.
const MAX_CODE_POINT = 0x10ffff;

/** Exported so test/dom-stand-in.mjs decodes entities identically to
 * this module -- one entity table, not two that could disagree on, say, `&mdash;`
 * inside an agent-supplied html-stage mock.
 *
 * An entity this function cannot decode -- an unknown name, or a numeric reference out
 * of Unicode's range -- degrades to the literal matched text (`whole`). That is the same
 * "good enough, not exhaustive" degrade-don't-throw rule this whole parser is built on,
 * and it is what keeps parseHtmlTree's "Never throws" contract true here: a finite
 * but out-of-range code point (`&#1114112;` is one past the max; `&#x999999999;` parses
 * to a finite number nowhere near Unicode) makes `String.fromCodePoint` raise
 * `RangeError` from deep inside a tree-builder that must not throw, reachable from raw,
 * un-decoded attacker-supplied `block.html` on an html stage (markdown escapes `&`
 * before block parsing, so this is the one path reaching here unsanitised). */
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
 * a second backtracking-capable pass over attacker-controlled input, which is
 * what `tokenRe`'s own comment below warns against. The only attribute
 * value this parser reads on every element -- added so
 * resolveDomAnchorInSection can recognise the board's own rendered chrome and
 * refuse to resolve a ref that lands there. */
function parseClassAttr(attrs) {
  const raw = attrValue(attrs, 'class');
  return raw == null ? null : raw.split(/\s+/).filter(Boolean);
}

/** Whether char code `c` is HTML's ASCII whitespace (tab, LF, FF, CR, space), what a
 * browser's tokenizer separates attributes with. */
function isAttrSpace(c) {
  return c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

/** Attribute `name`'s entity-decoded value from one tag's already-captured attribute
 * substring, or null when the tag has none. Walks the attributes one at a time the way
 * a browser's tokenizer does (a name, then an optional `=` and a quoted or bare value),
 * so a name spelled inside another attribute's quoted value is never read as an
 * attribute: `<video title="Demo aria-label=x">` has a title and no aria-label, as the
 * stage's own getAttribute sees it. The first of a repeated name wins, as in a browser.
 * One pass: every index is visited once and a quoted value ends at an indexOf, so
 * nothing backtracks over attacker-supplied markup. */
function attrValue(attrs, name) {
  if (!attrs) return null;
  const s = String(attrs);
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isAttrSpace(s.charCodeAt(i)) || s[i] === '/')) i++;
    if (i >= n) break;
    const nameStart = i++;
    while (i < n && !isAttrSpace(s.charCodeAt(i)) && s[i] !== '/' && s[i] !== '=' && s[i] !== '>') i++;
    const attrName = s.slice(nameStart, i).toLowerCase();
    while (i < n && isAttrSpace(s.charCodeAt(i))) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < n && isAttrSpace(s.charCodeAt(i))) i++;
      const quote = s[i];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, i + 1);
        const end = close === -1 ? n : close;
        value = s.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < n && !isAttrSpace(s.charCodeAt(i)) && s[i] !== '>') i++;
        value = s.slice(valueStart, i);
      }
    }
    if (attrName === name) return decodeEntities(value);
  }
  return null;
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
 * sparse or empty tree, which resolveSteps then reports unresolvable.
 *
 * `maxNodes` stops the parse once that many nodes (elements and text runs alike) are
 * in the tree, which keeps everything parsed so far exactly as a whole parse has it
 * and leaves out only what comes after. An html stage passes `MAX_STAGE_NODES`. */
export function parseHtmlTree(html, { maxNodes = Infinity } = {}) {
  const root = { tag: '#root', children: [], content: [] };
  const stack = [root];
  const src = stripComments(String(html ?? ''));
  const lower = src.toLowerCase(); // computed once: used to find script/style ends
  // Per tag, the stack index of every element of that tag pushed so far, innermost
  // last, so a close tag finds its element without walking the stack. Walking it made
  // every unmatched close O(depth): `<div>` repeated, then `</x>` repeated, is O(n^2),
  // measured at 1.4 s for 250 K chars and 14 s for 1 M (ADR 121). An index goes stale
  // when its element is popped (by a close, an auto-close or a truncation), and a stale
  // one no longer holds an element of its tag; the lookup drops stale indices off the
  // end as it meets them, so each is dropped once. The last index still holding its tag
  // is the innermost open element of that tag: one pushed later sits higher on the
  // stack for as long as both are open.
  const openAt = new Map();
  const push = node => {
    let at = openAt.get(node.tag);
    if (!at) { at = []; openAt.set(node.tag, at); }
    at.push(stack.length);
    stack.push(node);
  };
  const innermostOpen = tag => {
    const at = openAt.get(tag);
    if (!at) return 0;
    while (at.length) {
      const i = at[at.length - 1];
      if (i < stack.length && stack[i].tag === tag) return i;
      at.pop();
    }
    return 0;
  };

  let nodes = 0;
  const open = (tag, attrs) => {
    // `cls`: the one attribute value this otherwise attribute-blind
    // parser reads, so resolveDomAnchorInSection can recognise the board's own
    // rendered chrome (`.block-kicker`, `.pin-layer`, ...) and refuse to
    // resolve a ref that lands there -- see isChromeNode below. Scoped to one
    // already-captured tag's attribute substring, never a second scan over the
    // whole document.
    nodes++;
    const node = { tag, children: [], content: [], cls: parseClassAttr(attrs) };
    // `label`: a video's identity (videoIdentity), read from its own two
    // attributes because its text is fallback content the stage never names it by.
    if (tag === 'video') node.label = videoIdentity(attrValue(attrs, 'aria-label'), attrValue(attrs, 'title'));
    const top = stack[stack.length - 1];
    top.children.push(node);
    top.content.push(node);
    return node;
  };

  // Alternation is unambiguous (each branch is anchored on a distinct prefix) and
  // every open-tag quantifier is over a negated class that excludes both `>` and `<`, so an
  // unterminated tag fails at the next `<` instead of rescanning to end-of-input
  // from every start position. Single linear scan, no backtracking blowup.
  //
  // The tag-name group `[\w-]*` is followed by `(?![\w-])` in both the close-tag
  // and open-tag branches -- without it, that group and what immediately follows
  // (`[^>]*` in the close-tag branch; the attribute group's own `[^><"']` default
  // alternative in the open-tag branch) both accept plain word characters, so on
  // an unterminated tag the engine tried every possible split between the two
  // groups before giving up: O(n) splits, each requiring an O(n) re-match of the
  // remainder, for O(n^2) total (measured: 500 K chars -> 73.6s per comment).
  // The lookahead pins the tag-name group to its one greedy, maximal
  // match -- it fails in O(1) at every shorter length instead of handing off to
  // the next group -- so a failed match is O(n), not O(n^2). Every input that
  // used to match still matches the same way: a well-formed tag name is always
  // immediately followed by `>`, `/`, whitespace or a quote, none of which are
  // `[\w-]`, so the lookahead is already satisfied by the same maximal match the
  // greedy quantifier picks first.
  // A quoted attribute value may contain `<`: per HTML's attribute-value states it is
  // an ordinary character there, not a parse error. Excluding it ended the tag
  // early, so `<div title="x<y">` swallowed a sibling and every index after it shifted
  // -- either a live element misreported lost, or, with repeated sibling text, a
  // confident resolve against the WRONG element. `onclick="if(a<b)f()"` and
  // `aria-label="< Back"` are ordinary agent markup, not hostile. Still unambiguously
  // terminated by the closing quote, so no backtracking is reintroduced.
  // The `<!` declaration and the close tag end at `>` or at the end of the input. Their
  // bodies run over `<` (a browser reads `<!x<y>` as one bogus comment and `</a <b>`
  // as one end tag), so a body with no `>` used to scan to the end, fail, leave a
  // literal `<`, and scan to the end again from the next `<!` or `</`: O(n^2), measured
  // at 11.2 s for 250 K chars of `<!` and 188 s for 1 M (ADR 121). Ending at the input's
  // end is also what a browser does, which swallows the rest into the unclosed comment
  // or tag.
  const tokenRe = /<![^>]*(?:>|$)|<\/([a-zA-Z][\w-]*)(?![\w-])[^>]*(?:>|$)|<([a-zA-Z][\w-]*)(?![\w-])((?:"[^"]*"|'[^']*'|[^><"'])*?)(\/?)>|([^<]+)|(<)/g;
  // Stack index of the open <svg>/<math> we are inside, or -1. Only the OUTERMOST
  // one is recorded (foreignness is inherited, so a nested one changes nothing),
  // and it goes stale exactly when the stack is truncated to at or below it -- by a
  // close tag, an auto-close, or the end of a subtree -- which the `>= stack.length`
  // test below catches without any bookkeeping on the pop paths.
  let foreignAt = -1;
  let m;
  while (nodes < maxNodes && (m = tokenRe.exec(src)) != null) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = innermostOpen(tag);
      if (i > 0) stack.length = i; // unmatched close: ignored, never throws
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const selfClosed = m[4] === '/';
      autoCloseFor(stack, tag);
      // Retire a stale foreignAt HERE, after every pop this tag causes and before
      // the implied-parent pushes below. Testing it after those pushes reads the
      // re-grown stack and can find a closed <svg>'s index still "in range": in
      // `<table><svg></svg><td/>` the two implied pushes (tbody, tr) put the stack
      // back past index 2, so the `/` on `<td/>` was honoured as if the td were
      // still inside foreign content and the td closed immediately -- making the
      // next element its SIBLING where a browser makes it a CHILD, and shifting
      // every index after it. Both parsers shared the ordering, so parity could not
      // catch it; test/check-pure.mjs pins the shape itself.
      if (foreignAt >= stack.length) foreignAt = -1;
      for (let guard = 0; guard < 4; guard++) {
        const implied = impliedParentFor(stack[stack.length - 1].tag, tag);
        if (!implied) break;
        push(open(implied));
      }
      const node = open(tag, m[3]);
      if (tag === 'script' || tag === 'style') {
        // Kept as a node (matching the browser), body consumed and blanked.
        const close = lower.indexOf('</' + tag, tokenRe.lastIndex);
        const end = close === -1 ? src.length : src.indexOf('>', close);
        tokenRe.lastIndex = end === -1 ? src.length : end + 1;
        continue;
      }
      const foreign = foreignAt !== -1 || FOREIGN_ROOTS.has(tag);
      if (VOID_ELEMENTS.has(tag) || (selfClosed && foreign)) continue;
      if (foreignAt === -1 && foreign) foreignAt = stack.length;
      push(node);
    } else if (m[5]) {
      nodes++;
      stack[stack.length - 1].content.push({ tag: '#text', text: decodeEntities(m[5]) });
    } else if (m[6]) {
      // A bare '<' that starts nothing tag-shaped is literal text, as in a browser.
      nodes++;
      stack[stack.length - 1].content.push({ tag: '#text', text: '<' });
    }
  }
  return root;
}

/** Every descendant text run of `node`, in document order, concatenated —
 * `Element.textContent`'s equivalent over the tree parseHtmlTree builds. */
export function elementText(node) {
  if (!node) return '';
  // Iterative, because this parser's contract is that it never throws (see the file
  // header) and recursion broke it: ~5000 levels of nesting -- well inside the
  // by-value cap, and cheap for an agent to emit -- threw RangeError out of
  // resolveComment. On the submit path that surfaced as a bare 500 the reviewer's
  // Send could never get past, and because handleSubmit resolves a second time for
  // the SSE broadcast, a board could persist and then throw on every later /wait.
  const parts = [];
  const stack = [];
  // Seeded from node.content, not node, so a `#text` passed in directly still yields
  // '' exactly as the recursive form did.
  const seed = node.content || [];
  for (let k = seed.length - 1; k >= 0; k--) stack.push(seed[k]);
  while (stack.length) {
    const cur = stack.pop();
    if (cur.tag === '#text') { parts.push(cur.text); continue; }
    const content = cur.content || [];
    for (let k = content.length - 1; k >= 0; k--) stack.push(content[k]);
  }
  return parts.join('');
}

/** What an element's hint needs from one run of its text, or from a whole subtree:
 * `visible` (any non-whitespace at all), `head` (the visible text with whitespace
 * collapsed and trimmed, cut once it passes `max`), and whether whitespace comes
 * before its first visible character (`lead`) and after its last (`trail`). A run with
 * nothing visible carries only `ws`, whether it holds any whitespace. Two summaries
 * side by side join into one, a gap between them collapsing to a single space. */
function textSummary(text, max) {
  if (!text) return { visible: false, ws: false };
  const visibleRun = /\S{1,128}/g;
  let head = '';
  let end = 0;
  let m;
  while (head.length <= max && (m = visibleRun.exec(text)) !== null) {
    if (head && m.index > end) head += ' ';
    head += m[0];
    end = visibleRun.lastIndex;
  }
  if (!head) return { visible: false, ws: true };
  return { visible: true, head, lead: /\s/.test(text[0]), trail: /\s/.test(text[text.length - 1]) };
}

function joinSummaries(parts, max) {
  let out = null;
  let pendingWs = false;
  for (const part of parts) {
    if (!part.visible) { pendingWs = pendingWs || part.ws; continue; }
    if (!out) {
      out = { visible: true, head: part.head, lead: pendingWs || part.lead, trail: part.trail };
    } else {
      if (out.head.length <= max) out.head += (out.trail || pendingWs || part.lead ? ' ' : '') + part.head;
      out.trail = part.trail;
    }
    pendingWs = false;
  }
  if (!out) return { visible: false, ws: pendingWs };
  out.trail = out.trail || pendingWs;
  return out;
}

/** `extractHint(elementText(node))`, without reading more of the node's text than the
 * hint keeps. A comment's identity check asks for one hint per comment, and reading the
 * element's whole text cost each comment its whole subtree: 240 ms a comment on a
 * `<pre>` holding 24 MB, now that a stage may be that large (ADR 121), and 30 ms a
 * comment on an element over half a million empty ones. So each text run is read only
 * until its collapsed text passes `max` (at most 128 visible characters a step), and
 * each element's summary is kept for as long as its tree lives (`summaries`, keyed by
 * node), built children first without recursion: one walk over a tree, however many
 * comments land in it. */
const summaries = new WeakMap();
export function elementHint(node, max = DEFAULT_HINT_MAX) {
  if (!node) return '';
  const summaryOf = el => {
    const kept = summaries.get(el);
    return kept && kept.max === max ? kept.summary : null;
  };
  const stack = [node];
  while (stack.length) {
    const el = stack[stack.length - 1];
    if (summaryOf(el)) { stack.pop(); continue; }
    const content = el.content || [];
    let ready = true;
    for (const child of content) {
      if (child.tag !== '#text' && !summaryOf(child)) { stack.push(child); ready = false; }
    }
    if (!ready) continue;
    stack.pop();
    const parts = content.map(child => (child.tag === '#text' ? textSummary(child.text, max) : summaryOf(child)));
    summaries.set(el, { max, summary: joinSummaries(parts, max) });
  }
  const summary = summaryOf(node);
  return summary.visible ? extractHint(summary.head, max) : '';
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

/** Whether `node`'s own live content still backs a stored `hint`. Content is
 * snapshotted at post time, so a still-live element's text has not changed since mint
 * time: re-deriving the IDENTITY half of composeHint's rule from it (extractHint of the
 * element's own text, a video's label (videoIdentity) in place of its text, or -- with
 * no text at all, e.g. an image -- composeHint's role-word/tag fallback) reproduces
 * exactly what composeHint started the stored hint with.
 *
 * Matched by EQUALITY against one of the exact shapes composeHint can produce --
 * `identity`, `identity + ' in ' + <anything>`, or `identity + ' ' + role + ' in ' +
 * <anything>` -- never by `hint.startsWith(identity)`. A prefix test resolves the
 * comment onto the WRONG element and reports it resolved: `<button>S</button>` satisfies
 * it against a stored hint `'Send'`, and ANY empty element satisfies it against a hint
 * beginning with its bare tag name (`'div is broken'` against an empty `<div>`, whose
 * fallback identity is the string `'div'`).
 *
 * `ownHint`, when given, is the extracted hint that stands in for the node's own
 * (resolveAtRoot passes the hint of a video's fallback text, for an anchor minted
 * before a video was named by its label). */
function domIdentityHintMatches(node, hint, ownHint) {
  const normalizedHint = String(hint ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedHint) return false;
  const text = ownHint !== undefined ? ownHint : node.tag === 'video' ? extractHint(node.label) : elementHint(node);
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

// resolveDomAnchor's `ref` is a step chain minted client-side from a real
// browser's `document.body` (src/render.mjs's `stageAgentScript` roots buildSteps
// at the stage document's own `document.body`, exactly like a page-scoped anchor
// roots at a block's own section) -- never from parseHtmlTree's synthetic `#root`, whose
// children are just "every top-level thing this parse saw", head-only or not.
// A browser starts every document in "in head" insertion mode: a leading
// style/script/meta/link/title/base element is inserted into `<head>`, and the
// first non-head-only start tag or non-whitespace text switches insertion mode
// to "in body" for everything from there on (a `<style>` AFTER that switch is
// an ordinary body child, same as this module already modelled). An explicit
// `<html>`/`<head>`/`<body>` wrapper is honoured as given rather than
// re-hoisted. Left unmodelled, an ordinary mock that inlines its own styling --
// which this codebase's own isolation choice is what makes an author
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

// --- resolution surface exclusion -------------------------------------------
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
// and fail-safe (a reported "lost", never a wrong resolve) compared to a
// forged ref actually reaching real page chrome.
const CHROME_CLASSES = new Set([
  'block-kicker', 'context-tools', 'fold-toggle', 'comment-btn', 'comment-form', 'comment-target',
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

/** The ref+hint check every `dom`/`mermaid` resolution path below ultimately reduces to,
 * against an ALREADY-PARSED root. This is the shared bottom half that lets a caller
 * parse/render a block ONCE and resolve every comment on it against that one root
 * (src/board.mjs's `resolveComment` is that caller), instead of re-parsing -- and, for
 * the page-scoped case, re-rendering -- the block once per comment for a result that
 * cannot change within one pass. `resolveDomAnchor`/`resolveDomAnchorInSection` below
 * stay the right call for a single one-off anchor and are thin wrappers around this.
 *
 * Walks via `resolveStepsRejectingChrome` (above) rather than plain `resolveSteps`, so
 * every caller that bottoms out here refuses to resolve into the board's own rendered
 * chrome, the same exclusion src/ui.mjs's click listener applies before minting a ref.
 *
 * `time` is a `dom` anchor's video second, absent on every other anchor. A timed anchor
 * resolves only onto a `<video>`, and its hint's `" at m:ss"` suffix is stripped before
 * the identity match only when it equals that second's (videoTimeSuffix). An untimed
 * anchor on a `<video>` also resolves under the video's fallback text: the name the
 * stage gave a video before videoIdentity, which comments stored then still carry. */
export function resolveAtRoot(root, ref, hint, time) {
  const steps = pathToSteps(ref);
  if (!steps.length) return false;
  const node = resolveStepsRejectingChrome(root, steps);
  if (!node) return false;
  if (time == null && node.tag === 'video' && domIdentityHintMatches(node, hint, elementHint(node))) return true;
  if (time == null) return domIdentityHintMatches(node, hint);
  const second = videoSecond(time);
  if (second === null || node.tag !== 'video') return false;
  const timedHint = String(hint ?? '').replace(/\s+/g, ' ').trim();
  const suffix = videoTimeSuffix(second);
  return domIdentityHintMatches(node, timedHint.endsWith(suffix) ? timedHint.slice(0, -suffix.length) : timedHint);
}

/** How many nodes an html stage's tree holds at most: one per byte of the 512 KiB
 * block cap, as many as a stage under that cap could ever produce (one text run per
 * bare `<`), so no stage that fit the old cap loses a node. A stage may now carry up
 * to 25,000,000 bytes (src/resolve.mjs's MAX_HTML_BYTES, ADR 121), and its tree costs
 * about 400 bytes of heap an element: measured unbounded at 24 MB, `<div>` repeated
 * built 4.8 M elements, a 1.8 GB tree in 1.2 s, against the daemon's 4.4 GB heap;
 * bounded, 250 MB in 180 ms. Bounding the nodes keeps every pass at the old cap's worst
 * case; a stage carrying video or screenshots spends its bytes in a few attributes and
 * needs a handful of nodes. An anchor on an element past the bound resolves lost. */
export const MAX_STAGE_NODES = 512 * 1024;

/** The root a `dom` anchor rooted at an html stage's iframe body resolves
 * against, given the block's own snapshotted `html` string -- modelled as a
 * browser's `document.body` would see it, not parseHtmlTree's raw synthetic
 * root (see HEAD_ONLY_TAGS/bodyRootChildren above). Exported (same
 * pattern as `sectionRootFrom` below) so a caller resolving several comments
 * against the same html-stage block -- src/board.mjs's `resolveComments`
 * batch path -- can parse and hoist once instead of per comment; that cache
 * is exactly what makes this the one place that fix has to live, since a
 * cached-but-unhoisted root would silently undo it for every comment after
 * the first. */
export function htmlBodyRootFrom(html) {
  return { children: bodyRootChildren(parseHtmlTree(html, { maxNodes: MAX_STAGE_NODES })) };
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
 * element is always `parseHtmlTree(sectionHtml).children[0]`. Exported so
 * a caller resolving several comments against the same block can parse
 * once and pass the result to `resolveAtRoot`/`resolveMermaidAnchorAtRoot`
 * directly instead of re-parsing per comment. */
export function sectionRootFrom(sectionHtml) {
  return parseHtmlTree(sectionHtml).children[0] || null;
}

/** Whether a page-scoped `dom` anchor (root = the anchored block's own
 * `<section data-block-id>`, not an html stage's iframe body — see the pointer
 * near the top of this file) still resolves against `sectionHtml`, the
 * block's own section re-rendered from its stored content by src/board.mjs's
 * resolveComment (src/render.mjs's `renderBlock`, exported for exactly this).
 * Differs from `resolveDomAnchor` above only in the root: `buildSteps` mints a
 * page-scoped ref from the block's own section element (src/ui.mjs's
 * `anchorRootFor`), not from `<body>` — so resolution has to walk from that same
 * element, not from the parse's synthetic root. The chrome exclusion is
 * applied inside `resolveAtRoot`, not repeated here. */
export function resolveDomAnchorInSection(sectionHtml, ref, hint) {
  const sectionRoot = sectionRootFrom(sectionHtml);
  if (!sectionRoot) return false;
  return resolveAtRoot(sectionRoot, ref, hint);
}

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
 * the unprefixed id mermaid does not actually emit. Confirmed against mermaid@11,
 * fetched from the CDN this repo used before vendoring it, 2026-07-30. Both
 * shapes are accepted: mermaid 10 emitted the bare form, and an archived board
 * holds whatever its own render produced. */
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
 * server-side on every render/packet) but
 * "does this exact token still appear in the text at all", answered by a single
 * linear scan with no backtracking-capable pattern. A plain presence check can
 * false-positive if the id string happens to appear inside a label rather than as
 * a real id; it cannot false-negative on a legitimate, still-present id, which is
 * the failure mode that actually matters for "an anchor that no longer resolves
 * reports what it lost" — a live anchor must never be misreported
 * lost. Parsing mermaid's grammar fully stays client-side, from its own vendored engine. */
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
    // Deliberately +1, not +needle.length. Skipping the whole failed occurrence looks
    // like the obvious linearisation and is WRONG: needles that overlap themselves can
    // start again inside one, and the inner start can be the one that passes the
    // boundary test. `a.a` in `za.a.a` is the smallest case -- the occurrence at 1
    // fails on `z`, the one at 3 passes, and skipping to 4 misses it, reporting a live
    // anchor lost. That is the one direction this function may never err in.
    //
    // The cost this leaves -- (len(text) - len(needle)) * len(needle) -- is bounded
    // instead at the door: sanitizeAnchor caps a stored `ref` at MAX_ANCHOR_FIELD, so
    // the long-needle case that made this quadratic can no longer be persisted.
    from = i + 1;
  }
}

/** Same precedence as `resolveMermaidAnchor` below, against an ALREADY-PARSED
 * section root (see `resolveAtRoot`/`sectionRootFrom` above) instead of a raw
 * `sectionHtml` string this function would otherwise parse
 * itself on every call. `sectionRoot` may be null (an empty/unrenderable
 * section) -- the generic half then simply cannot resolve, same as
 * `resolveDomAnchorInSection` returning false for a missing section root. */
export function resolveMermaidAnchorAtRoot(sectionRoot, source, anchor) {
  if (sectionRoot && resolveAtRoot(sectionRoot, anchor?.domRef, anchor?.hint)) return true;
  return mermaidRefResolves(source, anchor?.ref);
}

/** Whether a mermaid node's anchor still resolves -- the generic,
 * page-scoped dom reference tried first, the node id leaned on as a fallback.
 * See DESIGN.md, "### Entry 28 — element anchoring", for the full reasoning; this
 * is deliberately a thin composition of two functions that already exist and
 * are already independently tested (resolveDomAnchorInSection, mermaidRefResolves)
 * rather than a third parsing path of its own -- the one new thing here is the
 * ORDER, which is the whole point this design exists to get right and pin down
 * somewhere checkable. `sectionHtml` is the mermaid block's own section,
 * re-rendered from its stored content exactly like resolveDomAnchorInSection's
 * other caller (src/board.mjs's resolveComment); `source` is the block's own
 * snapshotted diagram text, exactly what mermaidRefResolves already checked
 * before this design. `anchor` is the stored `{ kind: 'mermaid', ref, domRef,
 * hint }` object (or an older one carrying only `ref` -- both
 * `domRef` and `hint` are optional on purpose, see DESIGN.md). */
export function resolveMermaidAnchor(sectionHtml, source, anchor) {
  return resolveMermaidAnchorAtRoot(sectionRootFrom(sectionHtml), source, anchor);
}

// --- the pending-comment queue, pure ----------------------------------------
//
// `pendingComments` itself (an array of `{ id, blockId, anchor, text }`) lives
// only in src/ui.mjs's page-lifetime state -- there is no server shape for it,
// nothing here persists it, deliberately: deletion and editing
// apply only to a comment still queued client-side, never to anything in
// `board.comments`, which stays append-only. The two functions below carry the
// click-to-edit gesture and the list entry's delete control, out here rather
// than inline in a click handler where only the eye could verify them. Both are
// embedded verbatim into src/ui.mjs's client script via `.toString()` (the same
// technique as `composeHint`/`parseMermaidDomId` above), so anything either one
// needs is declared INSIDE its own body, not as a further module-level helper
// the embedded copy could never see.

/** The still-QUEUED comment (an entry of `pendingComments`, never
 * `board.comments`) already anchored at `blockId` + the same clicked-element
 * identity as `anchor` -- same `kind`, and the same `ref` (`hint`/`domRef` are
 * cosmetic labels composed for the agent to read, never compared) -- or
 * `undefined` if none. Every anchor-minting click
 * handler in src/ui.mjs (the generic page-wide listener, the html-stage's
 * `handleStageClick`, and `wireMermaidBlock`'s own) calls this BEFORE opening
 * a blank form, so a second click on an element already carrying a queued
 * comment reopens and edits it instead of queuing a duplicate.
 *
 * A SENT comment can never satisfy this by construction rather than by caller
 * discipline: it lives in `board.comments`, a different array from
 * `pendingComments` at every real call site, and this function has no notion of
 * "sent" at all -- it only searches whatever list it is given. src/ui.mjs
 * deliberately calls it with `board.comments` too, to answer the different
 * question "does this element already carry a SENT comment", reusing the one
 * match rule rather than a second copy of it. */
export function findPendingCommentForAnchor(pendingComments, blockId, anchor) {
  // A video comment's second is part of its target: another second on the same
  // video is a different anchor, never a duplicate of this one.
  function sameTarget(a, b) {
    if (!a || !b) return false;
    return a.kind === b.kind && (a.ref || '') === (b.ref || '')
      && (a.time == null ? null : a.time) === (b.time == null ? null : b.time);
  }
  var list = pendingComments || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (c && c.blockId === blockId && sameTarget(c.anchor, anchor)) return c;
  }
  return undefined;
}

/** `pendingComments` with the entry whose own `id` is `id` removed -- a NEW array,
 * never a mutation of the one passed in, so a caller still holding the old reference
 * is unaffected. An `id` matching nothing already queued is a no-op.
 *
 * Renumbering the remaining provisional pins so they stay contiguous needs no step
 * here: a provisional comment's number is never stored ON it, it is derived from its
 * POSITION in this array (`nextCommentNumber() + index`, src/ui.mjs's
 * `commentsWithPending`) every time the pin layers and comment lists are redrawn, so
 * "removing the middle of three" is an ordinary case rather than a special one.
 *
 * Keyed by `id`, not by `blockId`+`anchor`: a whole-block comment (`{ kind: 'block' }`)
 * carries no `ref` at all, and the design explicitly keeps that gesture free to add
 * several separate, textually-different remarks on one block -- so several legitimate
 * queued comments can share one anchor, and deleting ONE list entry must not risk
 * removing a different one that merely looks the same. */
export function removePendingComment(pendingComments, id) {
  var list = pendingComments || [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) continue;
    out.push(list[i]);
  }
  return out;
}
