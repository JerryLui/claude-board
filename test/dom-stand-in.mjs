// A minimal, zero-dependency DOM stand-in for test/check-click.mjs
// and test/check-click-pin.mjs. It exists to run
// the REAL src/ui.mjs client script -- not a hand-summary of what it does --
// against something DOM-shaped enough that a real click gesture can travel
// through it end to end.
//
// It is deliberately NOT a browser: it implements exactly the surface src/ui.mjs
// touches while wiring an html-stage iframe, handling a click inside it, and (for
// the pin check) queueing the comment that click opens a form for --
// element/attribute/classList/className/style/dataset plumbing, createTextNode,
// cloneNode (the diagram lens clones an SVG, and
// the duplicate ids that produces are the whole point of the trap it navigates),
// innerHTML (a real setter, parsing the assigned markup with this
// file's own parseNodes, not a no-op; see Element's own comment for why that
// used to matter), firstElementChild/outerHTML (see Element's own
// comments: these used to be silently absent, so applySubmittedPush/applyResync
// silently no-op'd against `undefined` instead of erroring, which is exactly the
// "quietly does nothing" failure mode this whole file exists to catch elsewhere;
// implemented for real rather than stubbed to throw, since the SSE
// push checks (test/check-anchor-push.mjs) need firstElementChild to work), a
// small CSS-selector subset (tag, .class, #id, [attr], [attr="value"],
// [attr^="value"], :not(), comma lists and descendant combinators -- no >, +, ~
// or nth-child, none of which ui.mjs uses), bubbling addEventListener/
// dispatchEvent, `clientHeight`/`scrollHeight` (a
// deliberately minimal model: 0 when the node is not in a document, and
// otherwise whatever the fixture declared; see Element's own comment for why
// that is one true statement about the browser rather than the beginning of a
// layout engine), and a stand-in EventSource so a 'round'/'submitted'
// push can be driven end to end without a real network. Anything ui.mjs touches
// on a path no check here exercises (fetch, Notification, canvas, DOMParser) is
// simply left undefined/inert -- `typeof x !== 'undefined'` guards and untaken
// branches mean the script never needs them to exist or do anything.
//
// This file's HTML
// parser now shares its tag-omission DECISIONS (autoCloseFor/impliedParentFor,
// which elements auto-close on which start tags, which parents are implied) with
// src/anchor.mjs's own parseHtmlTree, imported directly rather than re-derived --
// the two parsers used to agree only by accident on the repo's own narrow
// fixtures and diverge on ordinary markup like `<ul><li>a<li>b</ul>` (the stand-in
// nested the second `<li>` inside the first) or `<table><td>` (no implied
// `<tbody>`/`<tr>` at all outside the one table special-case this file used to
// hand-roll). The TOKENIZER itself stays separate -- this file has to build real
// Element objects with attributes (class, id, data-*, srcdoc, ...) and knows about
// `<iframe>`, neither of which parseHtmlTree's plain-object tree needs -- but the
// STRUCTURAL decisions are the one shared implementation, and
// test/check-parser-parity.mjs feeds both a corpus of the exact shapes that used
// to disagree and asserts identical trees, so a future edit to either side's rules
// that breaks agreement fails a check rather than shipping silently.
//
// The one piece of browser behaviour this stand-in exists to reproduce faithfully: an
// <iframe> does not start out empty. The moment it is parsed, a real browser has
// already given it a live `contentDocument` for `about:blank` -- readyState
// 'complete', a real (empty) `<body>` -- well before the `srcdoc` navigation has
// run. So IframeElement below manufactures that placeholder document eagerly, at
// parse time, exactly like a real browser does; the real srcdoc document only
// replaces it when the caller explicitly invokes `frame.loadSrcdoc()`, which is
// this stand-in's stand-in for the asynchronous navigation completing and firing
// `load`. Getting this ordering right is the entire point of the check that uses
// this module -- collapsing it to a single synchronous document would make the
// check green against the still-broken src/ui.mjs, which is exactly the failure
// mode a test suite exists to catch.

// The tag-omission rules and
// entity table are the SAME implementation src/anchor.mjs's parseHtmlTree uses,
// imported directly rather than hand-ported a second time -- see the parsing
// section below and test/check-parser-parity.mjs.
//
// This file now also models `window`/
// `postMessage` and actually EXECUTES a document's own `<script>` elements --
// new capability, not previously implemented at all (a `<script>`'s body used
// to be parsed and blanked, matching the browser's tree shape, but never run).
// This is what lets a check drive the real stage-side agent script
// src/render.mjs now injects into every html-stage `srcdoc` (see that file's
// design comment for the protocol this exists to test) end to end, the same
// way this file already runs the real src/ui.mjs -- and it is what lets a
// check prove the OTHER direction too: that a `<script>` an agent supplies in
// `block.html` cannot reach back out to the parent page's own `document`, the
// property this file exists to establish. See
// StandInWindow, IframeElement.loadSrcdoc and runInlineScripts below.
//
// `HEAD_ONLY_TAGS`, imported
// the same way as the tag-omission rules above, is what makes `parseHTML`
// hoist a leading run of head-only elements (`<style>`, `<script>`, `<meta>`,
// `<link>`, `<title>`, `<base>`) out of the synthetic body the same way a real
// browser's `document.body` never contains them -- see parseHTML's own
// comment, further down, for where that hoist runs. `resolveDomAnchor`
// (src/anchor.mjs) does the identical hoist server-side; both documents this
// file ever builds (the outer page AND an html stage's own srcdoc)
// go through this same parseHTML, so both get it.
import { autoCloseFor, impliedParentFor, decodeEntities, VOID_ELEMENTS, HEAD_ONLY_TAGS } from '../src/anchor.mjs';
// StandInWindow's getComputedStyle below used to
// resolve a requested custom property against the imported `palettes` object
// directly -- a hand-written copy of theme precedence that never read this
// text at all. It now runs the real cascade resolver (further down this
// file) over THIS string, so a change to the stylesheet's own selectors or
// nesting changes what a check sees, not just a change to the palette
// values.
import { styles } from '../src/styles.mjs';

// --- HTML parsing: just enough to build a tree from the exact markup
// src/render.mjs's renderBoardPage emits, and (unlike this file's own header
// comment used to claim) from arbitrary agent-supplied `srcdoc` HTML too --
// This file's tag-omission
// handling is now genuinely shared with src/anchor.mjs's parseHtmlTree (see the
// file header comment), not a second, narrower hand-port of the same rules. -----

// Exported by src/anchor.mjs so the two tokenizers never carry two,
// independently-maintained lists of the same facts.
export const VOID_TAGS = VOID_ELEMENTS;

// script/style bodies are raw text in real HTML -- entities are never decoded
// inside them, and a stray '<' or '>' in the source (ui.mjs's own code is full of
// both) must never be mistaken for a tag. Mirrors src/anchor.mjs's parseHtmlTree
// treatment of the same two tags, for the same reason.
const OPAQUE_TAGS = new Set(['script', 'style']);

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentElement = null;
  }
  get textContent() { return this.data; }
}

/** Parse an attribute list starting at `state.i`, mutating `el.attributes` and
 * `state.i`. The one piece of tokenizing that genuinely cannot be shared with
 * src/anchor.mjs's parseHtmlTree: that module never needs attribute VALUES (it
 * only reads tag names and a self-closing flag), while this stand-in has to
 * recover `class`/`id`/`data-*`/`srcdoc`/... to build a real, queryable Element. */
function parseAttrs(html, state, el) {
  const n = html.length;
  while (state.i < n) {
    while (state.i < n && /\s/.test(html[state.i])) state.i++;
    if (html[state.i] === '>' || (html[state.i] === '/' && html[state.i + 1] === '>')) return;
    const nameMatch = /^[^\s="'>/]+/.exec(html.slice(state.i));
    if (!nameMatch) { state.i++; continue; }
    const name = nameMatch[0].toLowerCase();
    state.i += nameMatch[0].length;
    while (state.i < n && /\s/.test(html[state.i])) state.i++;
    let value = '';
    if (html[state.i] === '=') {
      state.i++;
      while (state.i < n && /\s/.test(html[state.i])) state.i++;
      if (html[state.i] === '"' || html[state.i] === "'") {
        const quote = html[state.i];
        state.i++;
        const end = html.indexOf(quote, state.i);
        value = html.slice(state.i, end === -1 ? n : end);
        state.i = end === -1 ? n : end + 1;
      } else {
        const bare = /^[^\s>]*/.exec(html.slice(state.i))[0];
        value = bare;
        state.i += bare.length;
      }
      value = decodeEntities(value);
    }
    el.attributes.set(name, value);
  }
}

/** Parse `html` into a flat list of top-level nodes (Element/TextNode), building
 * real child trees. A single left-to-right scan over an explicit element STACK --
 * structurally the same shape as src/anchor.mjs's parseHtmlTree (see that file's
 * own comment on `parseHtmlTree`) -- rather than this file's former recursive
 * descent, specifically so `autoCloseFor`/`impliedParentFor` (imported from that
 * module) can be called at exactly the same points in exactly the same way: they
 * mutate/inspect a stack of open elements, which a recursive-descent parser (whose
 * "stack" is the JS call stack, invisible to a shared helper) cannot hand them.
 * `<!doctype ...>` and `<!-- -->` are skipped; a stray/mismatched closing tag is
 * ignored rather than thrown on (same tolerance as parseHtmlTree, for the same
 * reason: an html string too broken to make sense of degrades to a sparse tree,
 * never a crash). */
export function parseNodes(html) {
  const n = html.length;
  const state = { i: 0 };
  // A synthetic root, exactly like parseHtmlTree's `{ tag: '#root', ... }`:
  // autoCloseFor/impliedParentFor read `.tag` (Element's own lowercase-tagName
  // getter, added for exactly this) and never pop past index 0.
  const root = new Element('#root');
  const stack = [root];
  const top = () => stack[stack.length - 1];

  function appendNode(node) {
    const parent = top();
    node.parentElement = parent;
    parent.childNodes.push(node);
    return node;
  }

  while (state.i < n) {
    if (html.startsWith('<!--', state.i)) {
      const end = html.indexOf('-->', state.i);
      state.i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', state.i)) {
      const end = html.indexOf('>', state.i);
      state.i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[state.i] === '<' && html[state.i + 1] === '/') {
      const end = html.indexOf('>', state.i);
      const closeName = html.slice(state.i + 2, end === -1 ? n : end).trim().toLowerCase();
      state.i = end === -1 ? n : end + 1;
      // Search the WHOLE open-element stack for a match, exactly like
      // parseHtmlTree's own close-tag handling -- not just the innermost frame, so
      // an explicit `</ul>` correctly closes an implicitly-still-open `<li>` too.
      let idx = stack.length - 1;
      while (idx > 0 && stack[idx].tag !== closeName) idx--;
      if (idx > 0) stack.length = idx; // unmatched close: ignored, never throws
      continue;
    }
    if (html[state.i] === '<') {
      const tagMatch = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(state.i));
      if (!tagMatch) {
        // A stray '<' that starts nothing tag-shaped is literal text, as in a
        // browser and in parseHtmlTree -- this file used to silently DROP the
        // character instead (a real, if narrow, parity gap this closes).
        appendNode(new TextNode('<'));
        state.i++;
        continue;
      }
      const tagName = tagMatch[1].toLowerCase();
      state.i += tagMatch[0].length;
      const el = tagName === 'iframe' ? new IframeElement() : new Element(tagName);
      parseAttrs(html, state, el);
      let selfClosing = false;
      if (html[state.i] === '/' && html[state.i + 1] === '>') { selfClosing = true; state.i += 2; } else if (html[state.i] === '>') state.i++;

      // Tag omission, via the SAME functions src/anchor.mjs's parseHtmlTree calls
      // at the same point in its own scan (see this file's header comment): close
      // whatever `tagName` implies is finished, then open whatever `tagName`
      // implies must exist first (a `<td>` straight inside `<table>` gets both an
      // implied `<tbody>` and an implied `<tr>`, via the guarded loop below).
      autoCloseFor(stack, tagName);
      for (let guard = 0; guard < 4; guard++) {
        const implied = impliedParentFor(top().tag, tagName);
        if (!implied) break;
        const impliedEl = new Element(implied);
        appendNode(impliedEl);
        stack.push(impliedEl);
      }

      appendNode(el);

      if (OPAQUE_TAGS.has(tagName)) {
        // Kept as a node (matching the browser and parseHtmlTree), body consumed
        // and never treated as markup -- an entity is never decoded inside it
        // either, same reasoning as parseHtmlTree's own script/style handling.
        const closeSeq = '</' + tagName;
        const idx = html.toLowerCase().indexOf(closeSeq, state.i);
        const body = idx === -1 ? html.slice(state.i) : html.slice(state.i, idx);
        const closeGt = idx === -1 ? -1 : html.indexOf('>', idx);
        state.i = closeGt === -1 ? n : closeGt + 1;
        if (body.length) {
          const t = new TextNode(body);
          t.parentElement = el;
          el.childNodes.push(t);
        }
        continue; // never pushed onto the stack -- always a leaf
      }

      if (!VOID_TAGS.has(tagName) && !selfClosing) stack.push(el);
      continue;
    }
    const nextLt = html.indexOf('<', state.i);
    const raw = nextLt === -1 ? html.slice(state.i) : html.slice(state.i, nextLt);
    state.i = nextLt === -1 ? n : nextLt;
    if (raw.length) appendNode(new TextNode(decodeEntities(raw)));
  }

  return root.childNodes;
}

// --- selector engine: tag / .class / #id / [attr] / [attr="v"] / [attr^="v"] /
// :not(...), comma-separated groups, whitespace-separated descendant chains. No
// combinators, no other pseudo-classes -- ui.mjs never uses them. -----------------

function parseAttrSelector(inner) {
  // `*=` (substring) is supported because src/anchor.mjs's MERMAID_NODE_SELECTOR
  // needs it: mermaid 11 prefixes a node's id with the diagram's own svg id, so
  // `^=` cannot see a real node. A stand-in that throws on a selector the shipped
  // code uses is a stand-in that cannot check the shipped code.
  const m = /^([A-Za-z0-9_-]+)(?:([\^*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(inner.trim());
  if (!m) throw new Error(`unsupported attribute selector: [${inner}]`);
  const name = m[1];
  if (!m[2]) return { name, op: null, value: null };
  const op = m[2] === '^=' ? 'prefix' : m[2] === '*=' ? 'contains' : 'equals';
  const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  return { name, op, value };
}

function parseCompound(token) {
  let i = 0;
  const n = token.length;
  let tag = null;
  const classes = [];
  let id = null;
  const attrs = [];
  const nots = [];
  const tagMatch = /^[A-Za-z*][A-Za-z0-9-]*/.exec(token);
  if (tagMatch) { tag = tagMatch[0].toLowerCase(); i = tagMatch[0].length; }
  while (i < n) {
    const c = token[i];
    if (c === '.') {
      const m = /^\.[A-Za-z0-9_-]+/.exec(token.slice(i));
      classes.push(m[0].slice(1));
      i += m[0].length;
    } else if (c === '#') {
      const m = /^#[A-Za-z0-9_-]+/.exec(token.slice(i));
      id = m[0].slice(1);
      i += m[0].length;
    } else if (c === '[') {
      const end = token.indexOf(']', i);
      attrs.push(parseAttrSelector(token.slice(i + 1, end)));
      i = end + 1;
    } else if (token.slice(i, i + 5) === ':not(') {
      const end = token.indexOf(')', i);
      nots.push(parseCompound(token.slice(i + 5, end)));
      i = end + 1;
    } else {
      throw new Error(`unsupported selector token "${token}" (this stand-in only supports the subset src/ui.mjs actually uses)`);
    }
  }
  return { tag, classes, id, attrs, nots };
}

function elementMatchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  if (compound.tag && compound.tag !== '*' && el.tagName.toLowerCase() !== compound.tag) return false;
  for (const cls of compound.classes) if (!el.classList.contains(cls)) return false;
  if (compound.id !== null && el.getAttribute('id') !== compound.id) return false;
  for (const attr of compound.attrs) {
    const val = el.getAttribute(attr.name);
    if (attr.op === null) { if (val === null) return false; }
    else if (attr.op === 'equals') { if (val !== attr.value) return false; }
    else if (attr.op === 'contains') { if (val === null || !val.includes(attr.value)) return false; }
    else if (val === null || !val.startsWith(attr.value)) return false;
  }
  for (const not of compound.nots) if (elementMatchesCompound(el, not)) return false;
  return true;
}

function parseSelectorGroup(selectorText) {
  return selectorText.split(',').map(s => s.trim()).filter(Boolean).map(part => part.split(/\s+/).filter(Boolean).map(parseCompound));
}

function elementMatchesChain(el, chain) {
  if (!elementMatchesCompound(el, chain[chain.length - 1])) return false;
  let cur = el.parentElement;
  for (let idx = chain.length - 2; idx >= 0; idx--) {
    let found = false;
    while (cur && cur.nodeType === 1) {
      if (elementMatchesCompound(cur, chain[idx])) { found = true; break; }
      cur = cur.parentElement;
    }
    if (!found) return false;
    cur = cur.parentElement;
  }
  return true;
}

function searchDescendants(root, selectorText) {
  const groups = parseSelectorGroup(selectorText);
  const out = [];
  (function walk(el) {
    for (const child of el.children) {
      if (groups.some(chain => elementMatchesChain(child, chain))) out.push(child);
      walk(child);
    }
  })(root);
  return out;
}

// --- event dispatch: always bubbles up the parentElement chain (real DOM only
// bubbles events whose `bubbles` flag is set, but every event this stand-in ever
// dispatches -- click, mouseover, mouseout, load, dragstart, dragend, dragover --
// is one src/ui.mjs relies on reaching an ancestor listener, so a universal
// bubble is simpler and never wrong for this check's purposes). -------------------
//
// 'dragstart' needs no
// dedicated event class or `dataTransfer` stub -- deliberately. src/ui.mjs's own
// `list.addEventListener('dragstart', ...)` handler (the one comment mode's
// `commentMode ||` guard sits in) reads exactly one thing off the event: `.target`
// (to check `.tagName !== 'LI'`), which the generic StandInEvent/dispatchEvent
// pair below already provides -- a real browser only fires 'dragstart' on an
// element carrying `draggable="true"` after the user initiates a native drag
// gesture, which this stand-in does not simulate any more than it simulates a
// disabled `<button>` natively suppressing a dispatched click (see
// test/check-archive.mjs's own comment on that same, pre-existing limit) --
// test/check-comment-mode.mjs dispatches the event directly on the `<li>`,
// bypassing that native gesture entirely, same as every other synthetic click
// this file drives. `dragover`'s handler additionally reads `ev.clientY` (a live
// pointer coordinate) to decide WHERE to reorder to; that geometry-dependent half
// of the gesture -- actually moving an `<li>` in response to a pointer position --
// is NOT modelled here (no `clientY` is stubbed, since nothing in this suite
// dispatches a 'dragover') and is named, not silently skipped, in
// test/check-comment-mode.mjs's own comment: this stand-in has no pointer
// position or native drag-and-drop state machine, the same documented ceiling
// that already applies to the rank drag in general. No
// `dataTransfer` object is stubbed at all: nothing in src/ui.mjs's drag handlers
// ever reads or writes one, so leaving it absent means a future edit that DID try
// to touch `ev.dataTransfer.setData(...)` throws immediately (a TypeError on
// `undefined`) rather than silently no-opping -- exactly the "unimplemented
// surface throws" discipline this file's header comment states, achieved here by
// omission rather than a stub that would have to guess at a shape nothing needs
// yet.

/** `props` carries whatever else the handler
 * under test reads off the event -- in practice the pointer fields
 * (`clientX`/`clientY`/`pointerId`/`button`) the diagram lens's pan gesture
 * needs. Copied on verbatim rather than declared as named parameters, so this
 * stays the one event class every check in this repo constructs and a handler
 * that starts reading a new field needs no change here.
 *
 * This is deliberately NOT a claim that the stand-in now models pointer input.
 * There is still no hit-testing, no pointer capture (QUIRKS.md's own entry on
 * what that steals), no coalescing and no native drag state machine -- a check
 * dispatches the exact event sequence it wants to assert about, which is the
 * same ceiling and the same technique as every other synthetic click here. What
 * it DOES make reachable is the arithmetic the sequence feeds: whether a
 * gesture that moves 120px in sixty 2px steps is understood as a drag. That is
 * a question about accumulated numbers, not about layout, and it was the one
 * thing standing between that bug and a check that could see it -- the
 * existing assertion could only regex-match the handler's SHAPE, which is
 * precisely how a threshold measuring the wrong quantity survived review.
 *
 * The same verbatim-copy path is also how a keyboard event's modifier flags
 * reach a handler here -- `new StandInEvent('keydown', { key: 'Enter',
 * metaKey: true })` needs no dedicated support, `metaKey`/`ctrlKey`/etc. ride
 * `props` exactly like the pointer fields above. Don't add named parameters
 * for them. */
export class StandInEvent {
  constructor(type, props) {
    this.type = type;
    this.target = null;
    this.defaultPrevented = false;
    if (props) for (const k of Object.keys(props)) this[k] = props[k];
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { /* not used on any path this check exercises */ }
}

class EventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  // Previously absent (the old throwaway `window` stub each check
  // file constructed by hand supplied its own no-op instead). A real
  // implementation, not a no-op -- see this file's header comment on keeping
  // "unimplemented surface throws rather than silently no-ops" from drifting
  // into "implemented surface silently does nothing either": setCommentMode
  // (src/ui.mjs) is not expected to call this today, but a window-shaped
  // object that accepts registration and then can never unregister would be a
  // silent trap for whoever adds the next `removeEventListener` call.
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }
  dispatchEvent(event) {
    // A plain StandInEvent's `target` is a normal writable field, but
    // src/theme.mjs's `cb-theme-change` notification dispatches a REAL
    // platform `CustomEvent` through here -- window.dispatchEvent has to accept
    // one in a real browser too, since a hand-rolled plain object fails there
    // with "parameter 1 is not of type 'Event'". A genuine Event's `.target` is
    // an accessor with no setter, so this assignment throws in strict mode
    // (every ES module is strict); harmless to skip, since `.type` and
    // `.defaultPrevented` -- the only two fields anything dispatched through
    // this stand-in ever reads -- stay readable on it regardless.
    try { event.target = event.target || this; } catch (e) { /* real Event: target is getter-only, see above */ }
    let cur = this;
    while (cur) {
      const handlers = cur.listeners && cur.listeners.get(event.type);
      if (handlers) for (const fn of handlers.slice()) fn.call(cur, event);
      cur = cur.parentElement || null;
    }
    return !event.defaultPrevented;
  }
}

/** Stand-in for `MediaQueryList` (`window.matchMedia(query)`'s return value) --
 * src/ui.mjs's `isDarkThemeActive`/`mermaidThemeVariables` and
 * src/theme.mjs's own OS-preference-change listener both read `.matches` and
 * `.addEventListener('change', ...)` off one of these. `_setMatches` is a test
 * hook with no real-`MediaQueryList` equivalent (a real one has no settable
 * `.matches` -- only the OS can change it): it exists purely so a check can
 * simulate "the OS preference changed while the page was open" without a real
 * browser, firing 'change' the same way StandInWindow._setSystemPrefersDark
 * (below) does when it flips an already-vended instance. */
export class StandInMediaQueryList extends EventTarget {
  constructor(query, matches) {
    super();
    this.media = query;
    this.matches = !!matches;
  }
  // Legacy pre-EventTarget MediaQueryList API (Safari < 14): harmless to
  // support alongside addEventListener/removeEventListener, and src/theme.mjs
  // falls back to it defensively.
  addListener(fn) { this.addEventListener('change', fn); }
  removeListener(fn) { this.removeEventListener('change', fn); }
  _setMatches(next) {
    const nextBool = !!next;
    if (this.matches === nextBool) return;
    this.matches = nextBool;
    this.dispatchEvent({ type: 'change', matches: this.matches, media: this.media });
  }
}

/** Whether `query` (a `(prefers-color-scheme: dark|light)` string, the only
 * shape src/theme.mjs or src/ui.mjs ever asks for) matches, given one
 * underlying "does the OS prefer dark" boolean -- the two queries are treated
 * as strict opposites, which is all this repo's own CSS/JS ever assumes (see
 * src/styles.mjs's `@media (prefers-color-scheme: light)` block: there is no
 * third "no preference" case handled anywhere in this codebase, so the
 * stand-in does not invent one either). */
function matchesPrefersColorScheme(query, systemPrefersDark) {
  if (/prefers-color-scheme:\s*dark/.test(query)) return !!systemPrefersDark;
  if (/prefers-color-scheme:\s*light/.test(query)) return !systemPrefersDark;
  return false;
}

// --- CSS cascade resolver ----------------------------
//
// StandInWindow's getComputedStyle used to reimplement theme precedence by hand,
// in JS, from the imported `palettes` object -- it never read `styles`
// (src/styles.mjs) at all, so a change to the STYLESHEET's own selectors or
// nesting (e.g. accidentally nesting the explicit `:root[data-theme="light"]`
// override inside `@media (prefers-color-scheme: light)`, which breaks a dark-OS
// reader's Light choice in a real browser) was invisible to every check that read
// a token through getComputedStyle. What follows is a small, real cascade
// resolver over the ACTUAL `styles` text: parse rules (including `@media`
// wrapping), evaluate a `(prefers-color-scheme: ...)` condition against
// `_systemPrefersDark`, match a selector against a real element (walking
// `.parentElement`, same as the selector engine above), and resolve ties by
// CSS's own (id-count, class/attr/pseudo-count, type-count) specificity tuple,
// then source order -- not a CSS engine (this only ever has to be as general as
// the stylesheet it reads), but a real one: a change to the stylesheet's
// selectors or nesting changes what this returns.
//
// Two different callers need two different SHAPES of match:
//   - `:root` (plain, `:not([data-theme="dark"])`, `[data-theme="light"]`) --
//     custom-property tokens, matched only against `document.documentElement`
//     (`:root` always refers to a document's root element, i.e. `<html>`).
//   - ordinary tag/.class/#id/[attr]/:not()/descendant-chain selectors -- e.g.
//     `body.readonly button#theme-toggle` -- matched against any real element
//     and its ancestors, needed for the readonly carve-out:
//     asserting the COMPUTED display a real button ends up with, not any one
//     rule's spelling -- QUIRKS.md's own warning against the latter).
// One tolerant parser (parseCascadeCompound below) covers both: a leading
// `:root` is a pseudo-class matched against `el.tagName === 'HTML'`,
// contributing specificity like any other pseudo-class/attribute; anything else
// unrecognised (a dynamic pseudo-class/pseudo-element this resolver has no
// pointer/focus state to evaluate -- `:hover`, `:disabled`,
// `::-webkit-scrollbar`, ...) makes the compound (and therefore the whole rule)
// NEVER match, deliberately -- a correct answer for a resolver with no live
// interaction state, not a guess standing in for one, and never a thrown error:
// this has to walk arbitrary, human-authored CSS, not the fixed, known selector
// vocabulary the runtime engine above (parseCompound, which THROWS on the same
// input) exists to run.

/** Split `css` into top-level "head { body }" blocks, tracking brace depth so a
 * wrapper's own nested rules (an `@media` block's contents, a `@keyframes`
 * block's percentage stops) stay intact as one block's body, to be recursed
 * into by the caller rather than split apart here. Comments must already be
 * stripped. */
function tokenizeCssBlocks(css) {
  const blocks = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    const headStart = i;
    while (i < n && css[i] !== '{') i++;
    if (i >= n) break; // trailing text with no block: ignore
    const head = css.slice(headStart, i).trim();
    i++; // consume '{'
    const bodyStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      if (depth === 0) break;
      i++;
    }
    const body = css.slice(bodyStart, i);
    i++; // consume the matching '}'
    blocks.push({ head, body });
  }
  return blocks;
}

/** Flatten `css` into leaf rules -- a selector plus its own declarations, no
 * further nesting -- in SOURCE ORDER across the whole sheet (the array index a
 * caller iterates with is therefore exactly what "later wins a specificity tie"
 * means in a real cascade). An `@media (...)` wrapper contributes its condition
 * to every rule nested inside it; any other at-rule (`@keyframes`, ...) is
 * walked the same way with no condition added -- its own nested blocks (a
 * keyframe's percentage selectors) simply never match anything
 * parseCascadeCompound resolves later. */
function collectLeafRules(css) {
  const leaves = [];
  (function walk(text, mediaConditions) {
    for (const { head, body } of tokenizeCssBlocks(text)) {
      if (/^@media\b/i.test(head)) {
        walk(body, [...mediaConditions, head.replace(/^@media\b/i, '').trim()]);
      } else if (head.startsWith('@')) {
        walk(body, mediaConditions);
      } else {
        leaves.push({ selector: head, body, mediaConditions });
      }
    }
  })(css, []);
  return leaves;
}

/** Parse one leaf rule's declaration-block body into a `Map` of property ->
 * value. Every property this resolver is ever asked about (`--custom-property`
 * names, `display`) has a value with no colon of its own (hex/rgba color, a
 * keyword) -- splitting on the FIRST `:` in each `;`-separated declaration is
 * exactly what a real CSS declaration-list parse means for this stylesheet's
 * own shapes, without needing a real CSS value tokenizer. */
function parseCssDeclarations(body) {
  const decls = new Map();
  for (const raw of body.split(';')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    decls.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return decls;
}

/** Parse ONE compound selector token (no combinators/whitespace) for the
 * cascade resolver: an optional leading `:root`, then any number of `.class` /
 * `#id` / `[attr]` / `[attr="v"]` / `[attr^="v"]` / `:not(...)`. Returns `null`
 * -- "never matches", not a thrown error -- for anything else (see this
 * section's own header comment for why). `:root` is tracked separately from
 * `tag` (a real element's `tagName` is 'HTML', never literally the
 * pseudo-class), but contributes to specificity exactly like any other
 * pseudo-class/attribute selector, matching real CSS's own rule that `:root`
 * and `[attr]` sit in the same specificity bucket. */
function parseCascadeCompound(token) {
  const n = token.length;
  let i = 0;
  let tag = null;
  let isRoot = false;
  const classes = [];
  let id = null;
  const attrs = [];
  const nots = [];
  if (token.slice(0, 5) === ':root') {
    isRoot = true;
    i = 5;
  } else {
    const tagMatch = /^[A-Za-z*][A-Za-z0-9-]*/.exec(token);
    if (tagMatch) { tag = tagMatch[0].toLowerCase(); i = tagMatch[0].length; }
  }
  while (i < n) {
    const c = token[i];
    if (c === '.') {
      const m = /^\.[A-Za-z0-9_-]+/.exec(token.slice(i));
      if (!m) return null;
      classes.push(m[0].slice(1));
      i += m[0].length;
    } else if (c === '#') {
      const m = /^#[A-Za-z0-9_-]+/.exec(token.slice(i));
      if (!m) return null;
      id = m[0].slice(1);
      i += m[0].length;
    } else if (c === '[') {
      const end = token.indexOf(']', i);
      if (end === -1) return null;
      let attr;
      try { attr = parseAttrSelector(token.slice(i + 1, end)); } catch (e) { return null; }
      attrs.push(attr);
      i = end + 1;
    } else if (token.slice(i, i + 5) === ':not(') {
      const end = token.indexOf(')', i);
      if (end === -1) return null;
      const inner = parseCascadeCompound(token.slice(i + 5, end));
      if (!inner) return null;
      nots.push(inner);
      i = end + 1;
    } else {
      return null; // an unrecognised token (:hover, ::before, ...): never matches
    }
  }
  return { tag, isRoot, classes, id, attrs, nots };
}

function cascadeCompoundMatches(el, compound) {
  if (!compound || !el || el.nodeType !== 1) return false;
  if (compound.isRoot) { if (el.tagName !== 'HTML') return false; }
  else if (compound.tag && compound.tag !== '*' && el.tagName.toLowerCase() !== compound.tag) return false;
  for (const cls of compound.classes) if (!el.classList.contains(cls)) return false;
  if (compound.id !== null && el.getAttribute('id') !== compound.id) return false;
  for (const attr of compound.attrs) {
    const val = el.getAttribute(attr.name);
    if (attr.op === null) { if (val === null) return false; }
    else if (attr.op === 'equals') { if (val !== attr.value) return false; }
    else if (attr.op === 'contains') { if (val === null || !val.includes(attr.value)) return false; }
    else if (val === null || !val.startsWith(attr.value)) return false;
  }
  for (const not of compound.nots) if (cascadeCompoundMatches(el, not)) return false;
  return true;
}

/** Real CSS specificity, as an (ids, classes, types) tuple -- `:root` and an
 * attribute selector are both "classes" bucket (weight 1 each); `:not(X)`
 * contributes X's OWN specificity, not a weight of its own (the real CSS rule,
 * and the reason `body.readonly button#theme-toggle` -- one id -- beats
 * `body.readonly .mode-toggle` -- zero ids, more classes -- regardless of which
 * comes first in the sheet; see src/styles.mjs's own comment on that rule). */
function cascadeCompoundSpecificity(compound) {
  let ids = compound.id !== null ? 1 : 0;
  let classes = compound.classes.length + compound.attrs.length + (compound.isRoot ? 1 : 0);
  let types = (compound.tag && compound.tag !== '*') ? 1 : 0;
  for (const not of compound.nots) {
    const s = cascadeCompoundSpecificity(not);
    ids += s.ids; classes += s.classes; types += s.types;
  }
  return { ids, classes, types };
}

function splitCascadeSelectorGroups(selectorText) {
  return selectorText.split(',').map(s => s.trim()).filter(Boolean).map(part => part.split(/\s+/).filter(Boolean));
}

/** Match `targetEl` (and its ancestors, for a descendant chain longer than one
 * compound) against a selector already split into whitespace-separated
 * compound TOKENS -- returns the chain's total specificity tuple on a match,
 * `null` on no match OR on a compound this resolver cannot parse (see
 * parseCascadeCompound). Same walk as `elementMatchesChain` above (the runtime
 * querySelector engine), reimplemented against `parseCascadeCompound` rather
 * than the throwing `parseCompound`, for the reason this section's header
 * comment gives. */
function cascadeChainMatch(targetEl, tokens) {
  const compounds = tokens.map(parseCascadeCompound);
  if (compounds.some(c => c === null)) return null;
  if (!cascadeCompoundMatches(targetEl, compounds[compounds.length - 1])) return null;
  let cur = targetEl.parentElement;
  for (let idx = compounds.length - 2; idx >= 0; idx--) {
    let found = false;
    while (cur && cur.nodeType === 1) {
      if (cascadeCompoundMatches(cur, compounds[idx])) { found = true; break; }
      cur = cur.parentElement;
    }
    if (!found) return null;
    cur = cur.parentElement;
  }
  let ids = 0, classes = 0, types = 0;
  for (const c of compounds) {
    const s = cascadeCompoundSpecificity(c);
    ids += s.ids; classes += s.classes; types += s.types;
  }
  return { ids, classes, types };
}

function specificityGreater(a, b) {
  if (a.ids !== b.ids) return a.ids > b.ids;
  if (a.classes !== b.classes) return a.classes > b.classes;
  return a.types > b.types;
}
function specificityEqual(a, b) { return a.ids === b.ids && a.classes === b.classes && a.types === b.types; }

/** The resolver itself: `propName`'s winning value for `targetEl` under a real
 * cascade over `cssText`, given one "does the OS prefer dark" fact
 * (`systemPrefersDark`) -- `''` if nothing in the sheet sets it there, same as a
 * real `getPropertyValue` on an unset custom property. Walks every leaf rule in
 * source order, skips one whose `@media` condition(s) do not hold
 * (matchesPrefersColorScheme's own comment: an unrelated media feature, e.g.
 * `(max-width: 860px)`, always evaluates false here -- this resolver has no
 * viewport, so a rule gated on one correctly never applies) or whose selector
 * does not match `targetEl`, and keeps the highest-specificity match, breaking
 * a tie by source order (a LATER rule of equal specificity wins, same as a real
 * cascade) -- exactly the mechanism that makes `:root[data-theme="light"]`'s
 * unconditional override beat `:root:not([data-theme="dark"])`'s media-gated
 * one when both match (nest the override inside the
 * media query and it stops matching on a dark OS at all, which THIS walk --
 * unlike a hand-copied precedence rule -- actually notices). */
export function resolveComputedProperty(cssText, targetEl, systemPrefersDark, propName) {
  const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const leaves = collectLeafRules(noComments);
  let winner = null;
  leaves.forEach((leaf, sourceIndex) => {
    if (!leaf.mediaConditions.every(cond => matchesPrefersColorScheme(cond, systemPrefersDark))) return;
    const decls = parseCssDeclarations(leaf.body);
    if (!decls.has(propName)) return;
    let best = null;
    for (const tokens of splitCascadeSelectorGroups(leaf.selector)) {
      const spec = cascadeChainMatch(targetEl, tokens);
      if (spec && (!best || specificityGreater(spec, best))) best = spec;
    }
    if (!best) return;
    if (!winner || specificityGreater(best, winner.spec) ||
        (specificityEqual(best, winner.spec) && sourceIndex > winner.sourceIndex)) {
      winner = { value: decls.get(propName), spec: best, sourceIndex };
    }
  });
  return winner ? winner.value : '';
}

// --- window / postMessage -----------------------
//
// A minimal stand-in for the two `window` objects a board page and one of its
// html-stage iframes each get in a real browser, existing ONLY to carry
// `postMessage`/`addEventListener('message', ...)` -- the channel src/ui.mjs and
// the stage-side agent script src/render.mjs injects now use instead of the
// parent ever reaching into `contentDocument`/`contentWindow.document` (see
// render.mjs's own design comment for the protocol this exists to run for real).
//
// Delivery is SYNCHRONOUS (dispatched inline inside `postMessage`, not queued),
// unlike a real browser's task-queued delivery. Documented simplification, same
// tier as this file's other departures from a real browser (StandInEvent's
// dispatch is synchronous too, and EventSource's `dispatch` is a direct call, not
// a network round trip): nothing this file's checks assert on depends on
// message delivery being asynchronous, only on it happening at all, reaching the
// right window, and carrying the right shape -- and synchronous delivery makes
// that provable with a plain assertion immediately after triggering it, rather
// than needing a manual "flush" step invented solely for this file.
//
// The two ends of one specific relationship (a page and ONE of its stages) are
// wired by IframeElement.loadSrcdoc below via plain per-instance closures, not
// by any shared state on this class: `frame.contentWindow.postMessage` (called
// BY the parent) delivers TO the stage's own listeners tagged as coming FROM the
// outer window, and `window.parent.postMessage` (called by the stage's own
// script) delivers TO the outer window's listeners tagged as coming from the
// stage -- each closure captures exactly the two window objects it connects, so
// a page with several stages never confuses one stage's messages for another's
// (see loadSrcdoc's own comment for why a class-level "current peer" field would
// get this wrong the moment a page has more than one stage).
export class StandInWindow extends EventTarget {
  constructor() {
    super();
    this.parent = this; // matches a real un-framed window: window.parent === window
    this._mediaQueries = new Map();
    // The one underlying "does the OS prefer dark" fact both
    // `matchMedia('(prefers-color-scheme: dark)')` and `...light)` are derived
    // from (see matchesPrefersColorScheme above). Defaults to dark, matching
    // this repo's own dark-first default (src/styles.mjs: the plain `:root`
    // block is DARK, LIGHT only wins under an explicit override or an OS/media
    // match) -- a check that needs the OTHER default sets
    // `window._systemPrefersDark = false` itself, BEFORE running the script
    // under test, exactly like it already sets `location.protocol` or attaches
    // a `StandInLocalStorage` up front rather than through a setter.
    this._systemPrefersDark = true;
  }
  // A default only ever used for self-messaging (nothing in this repo's client
  // script does that); IframeElement.loadSrcdoc overrides this per-instance with
  // a closure bound to the actual pair of windows involved, exactly like a real
  // browser's own postMessage is bound to the calling script's actual global,
  // not to some fixed default.
  postMessage(data) {
    this.dispatchEvent({ type: 'message', data, origin: 'self', source: this });
  }
  // `window.matchMedia(query)` -- one `StandInMediaQueryList` per
  // distinct query string, cached, so a check that grabs the same instance the
  // script under test registered its 'change' listener on (by calling
  // `matchMedia` again with the identical query) can drive that listener via
  // `_setSystemPrefersDark` below, the same way a real OS preference flip
  // would fire it.
  matchMedia(query) {
    if (!this._mediaQueries.has(query)) {
      this._mediaQueries.set(query, new StandInMediaQueryList(query, matchesPrefersColorScheme(query, this._systemPrefersDark)));
    }
    return this._mediaQueries.get(query);
  }
  /** Test hook (see `_systemPrefersDark`'s own comment): simulates a live OS
   * light/dark preference change while the page is open, updating every
   * already-vended MediaQueryList and firing 'change' on the ones whose
   * `.matches` actually flips -- never on one that doesn't, so a listener
   * counting its own calls can tell "the OS changed" apart from "matchMedia
   * was merely queried again".
   *
   * TWO passes, and the split is not tidiness: one OS preference change is one
   * fact, so in a real browser EVERY MediaQueryList already reflects it by the
   * time any 'change' listener runs. Doing it in a single pass dispatches each
   * listener from inside the loop that is still updating the others, so a
   * handler on '(prefers-color-scheme: dark)' that reads
   * '(prefers-color-scheme: light)' -- exactly what src/theme.mjs's OS listener
   * plus src/ui.mjs's activeTheme do between them -- sees the OLD value and
   * concludes the opposite theme. Found that way: a page-board stage was told
   * 'dark' on a flip TO light, against code that is correct in a browser. */
  _setSystemPrefersDark(next) {
    this._systemPrefersDark = !!next;
    const flipped = [];
    this._mediaQueries.forEach(mql => {
      const nextMatches = matchesPrefersColorScheme(mql.media, this._systemPrefersDark);
      if (mql.matches !== nextMatches) flipped.push(mql);
      mql.matches = nextMatches;
    });
    flipped.forEach(mql => mql.dispatchEvent({ type: 'change', matches: mql.matches, media: mql.media }));
  }
  /** `window.getComputedStyle(el).getPropertyValue('--token')` --
   * src/ui.mjs's mermaidThemeVariables reads mermaid's whole palette this way
   * rather than importing src/styles.mjs's `palettes` directly into the client
   * script, specifically so it reflects whatever the CASCADE actually resolved
   * (System mode, an explicit override, a future selector change) rather than
   * a second, independent read of the same preference. This used to
   * reimplement that precedence by hand from `palettes`, which
   * meant it could never notice a broken STYLESHEET (see "CSS cascade
   * resolver" above); it now runs the real resolver over `styles`
   * (src/styles.mjs's exported string), the same text a real browser parses.
   * Only `document.documentElement` resolves to anything (every token this
   * repo ever reads lives on `:root`); any other element's computed style is
   * empty, which is fine -- nothing in this codebase asks `getComputedStyle`
   * about anything else (a check that needs a non-custom-property, non-:root
   * value -- e.g. a real button's `display` -- calls the
   * exported `resolveComputedProperty` directly, not through this method). */
  getComputedStyle(el) {
    const win = this;
    return {
      getPropertyValue(prop) {
        const docEl = win.document && win.document.documentElement;
        if (!docEl || el !== docEl) return '';
        return resolveComputedProperty(styles, docEl, win._systemPrefersDark, prop);
      },
    };
  }
}

/** Minimal `window.history` stand-in for `history.replaceState(state, title,
 * url)` -- test/dom-stand-in.mjs otherwise has no navigation model at all.
 * NOT attached to StandInWindow by default: a check that wants the
 * `window.history.replaceState` branch of some client code exercised attaches
 * one explicitly (`window.history = new StandInHistory(location)`), which is
 * also what keeps a callee's OWN fallback for "no window.history" -- src/ui.mjs's
 * maybeJumpToStrandedRound has one -- under its own coverage: a check that does
 * nothing special gets `window.history === undefined`, exactly like before this
 * class existed, rather than every check silently losing that branch the moment
 * a generic stand-in grew a history object.
 *
 * Records every call verbatim (`replaceStateCalls`), so a check can assert
 * exactly what was replaced, and applies the one real side effect anything in
 * this repo depends on: replacing the URL updates the bound `location`-like
 * object to match, including dropping any fragment the new URL does not carry.
 * A real `history.replaceState(null, '', pathnamePlusSearch)` -- the shape
 * src/ui.mjs's own call takes -- does exactly this to `location.hash` with no
 * navigation and no event; it is the mechanism the sentinel-consumption logic
 * depends on to make a later, genuine re-click detectable again. Splits the
 * fragment off `url` by hand rather than parsing it as a real URL: this
 * repo's `location` stand-ins are plain objects, not real Location/URL
 * instances (test/check-sample-board.mjs's `{ protocol: 'file:' }`, this
 * file's own callers' `{ protocol, hash }`), so a real URL parser would choke
 * on a bare path-plus-search string with no origin. */
export class StandInHistory {
  constructor(location) {
    this.location = location;
    this.replaceStateCalls = [];
  }
  replaceState(state, title, url) {
    this.replaceStateCalls.push({ state, title, url });
    if (!this.location) return;
    const hashIdx = url.indexOf('#');
    this.location.hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  }
}

/** An element's inline `style`: a plain object for ordinary properties, plus the
 * three methods a custom property needs. Real CSSStyleDeclaration stores custom
 * properties in their own namespace reachable only through these -- `el.style['--x']`
 * does NOT round-trip in a browser -- so they get their own map here rather than
 * being written onto the object as keys. A test asserting on `--stage-p` therefore
 * has to call `getPropertyValue`, exactly as it would against a real DOM, and
 * cannot accidentally pass by reading a key a browser would never have set.
 *
 * Values are coerced to strings, the one CSSOM behaviour src/ui.mjs's callers can
 * observe (they write numbers via `toFixed`, so this is already a string, but a
 * caller that writes a raw number must not read one back). */
function makeStyle() {
  const custom = new Map();
  return {
    setProperty(prop, value) { custom.set(prop, String(value)); },
    getPropertyValue(prop) { return custom.has(prop) ? custom.get(prop) : ''; },
    removeProperty(prop) {
      const had = custom.has(prop) ? custom.get(prop) : '';
      custom.delete(prop);
      return had;
    },
  };
}

export class Element extends EventTarget {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentElement = null;
    this.value = '';
    this._style = makeStyle();
    // Back `scrollIntoView` below -- a count plus the most recent options
    // object, not a simulation. See that method's own comment for why.
    this.scrollIntoViewCallCount = 0;
    this.scrollIntoViewLastOptions = null;
  }
  // Real CSSStyleDeclaration coerces every assigned value to a string and ignores
  // unrecognised properties; this stand-in needs plain property assignment
  // (`pin.style.left = n + 'px'`, as src/ui.mjs's placePin does) plus the custom
  // property trio, which is how src/ui.mjs writes the page-board condense
  // progress (`--stage-p`). Nothing here reads COMPUTED style -- there is no box
  // model to compute one from -- so src/ui.mjs feature-detects getComputedStyle
  // and skips the one measurement that would need it.
  get style() { return this._style; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  // Lowercase tagName, read by parseNodes' stack machinery (autoCloseFor/
  // impliedParentFor, imported from src/anchor.mjs, read `.tag` off whatever the
  // stack holds -- see this file's own comment on parseNodes for why the shared
  // functions need this rather than `.tagName`).
  get tag() { return this.tagName.toLowerCase(); }
  get firstElementChild() { return this.children[0] || null; }
  // Walks .parentElement up to the owning StandInDocument (nodeType
  // 9), the bubbling terminus every element chain already ends at -- real DOM's
  // `Element.ownerDocument`. Computed on demand rather than stamped in at parse
  // time: IframeElement.loadSrcdoc uses it to find ITS OWN outer window (via
  // `.defaultView`), and needs the answer to reflect wherever this element
  // actually lives right now, not wherever parseNodes first built it.
  get ownerDocument() {
    let node = this.parentElement;
    while (node && node.nodeType !== 9) node = node.parentElement;
    return node || null;
  }
  // --- box metrics: exactly one true statement, deliberately not a layout model -
  //
  // This turns on ONE fact about the browser, and it
  // is not a fact about layout: a node that is not in a document has no box, so
  // `clientHeight` and `scrollHeight` are both 0 no matter what it contains.
  // Every push path in src/ui.mjs wires its subtree while it is still DETACHED
  // (applyRoundPush wires `wrap`/`frag` before appending, applySubmittedPush
  // wires `replacement` before the swap -- all three deliberately, so listeners
  // attach without re-wiring the blocks already on the page), so anything that
  // MEASURES during that pass measures zero. `unlockCodeCapForDrag` claimed its
  // once-only marker before measuring, which made every code block arriving over
  // SSE permanently undraggable -- and the whole suite stayed green, because
  // these two properties simply did not exist here.
  //
  // What is modelled: connected -> whatever the FIXTURE declared; detached -> 0.
  // What is NOT modelled, and must not start being: any relationship between an
  // element's content, its CSS, and its size. This stand-in cannot compute a box
  // and must never appear to -- QUIRKS.md's "a mock of someone else's renderer is
  // an assumption about their output" applies to Chrome's layout engine more than
  // to anything else in this file. A fixture states a measurement it took (or
  // that the check's own scenario stipulates); this reports it back, and reports
  // 0 the moment the node is not in a document, which is the only part the
  // browser decides on its own.
  //
  // An undeclared element reads 0 even when connected -- "this stand-in knows no
  // box for this node", not "this node is 0px tall". That is why the guard under
  // test is `if (!pre.clientHeight) return;` (bail, retry later) rather than
  // anything that treats a zero as a settled answer.
  //
  // The numbers a fixture supplies for the code-block case come from a real
  // measurement, recorded rather than invented: a capped <pre> of 200 lines in
  // Chrome 150 reports clientHeight 480 / scrollHeight 4478 attached, and 0 / 0
  // in the identical detached subtree.
  get isConnected() { return !!this.ownerDocument; }
  get clientHeight() { return this.declaredBox('data-standin-client-height'); }
  get scrollHeight() { return this.declaredBox('data-standin-scroll-height'); }
  declaredBox(attr) {
    if (!this.isConnected) return 0;
    const n = Number(this.getAttribute(attr));
    return Number.isFinite(n) ? n : 0;
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get id() { return this.getAttribute('id') || ''; }
  // `disabled` is a boolean IDL-reflected attribute -- narrowly, deliberately
  // narrower than a claim that this stand-in reflects attributes onto
  // properties in general (it does not: `value`/`checked`/etc. stay plain
  // fields, same as every other property on this class). This one earns the
  // real reflection because the rendered page and the client script disagree
  // about WHICH mechanism sets it: src/render.mjs emits a bare `disabled`
  // content attribute on `#send-btn` whenever no round is open
  // (`renderBoardPage`), while src/ui.mjs's setSendBarEnabled flips the same
  // control with a PROPERTY write (`sendBtn.disabled = !on`) once a round
  // opens over SSE -- exactly like a real browser, where those are two
  // spellings of one underlying state, not two states. A plain `this.disabled
  // = false` field (this class's old shape) made them two worlds here: the
  // rendered attribute was invisible to `.disabled`, so a guard reading
  // `sendBtn.disabled` -- the one Cmd+Enter traversal's "do nothing when the
  // send bar is already disabled" criterion depends on -- read `false` against
  // a button a real browser reports as disabled. Presence, not truthiness of
  // the stored value, is what real DOM tests: a bare `disabled` attribute's
  // value is the empty string (`getAttribute('disabled') === ''`), which is
  // itself falsy, so this must check `hasAttribute`, never the attribute's
  // VALUE.
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  // className is a reflected property, same attribute classList reads/writes --
  // src/ui.mjs's placePin sets it directly (`pin.className = 'anchor-pin ...'`)
  // rather than going through classList, exactly like real DOM code often does.
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v == null ? '' : String(v)); }
  get classList() {
    const self = this;
    const read = () => (self.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return {
      contains: c => read().includes(c),
      add: (...cs) => { const set = new Set(read()); cs.forEach(c => set.add(c)); self.setAttribute('class', [...set].join(' ')); },
      remove: (...cs) => { const set = new Set(read()); cs.forEach(c => set.delete(c)); self.setAttribute('class', [...set].join(' ')); },
      toggle: (c, force) => {
        const want = force === undefined ? !read().includes(c) : force;
        if (want) { const set = new Set(read()); set.add(c); self.setAttribute('class', [...set].join(' ')); } else { const set = new Set(read()); set.delete(c); self.setAttribute('class', [...set].join(' ')); }
        return want;
      },
    };
  }
  get dataset() {
    const self = this;
    const toAttr = prop => 'data-' + String(prop).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    return new Proxy({}, {
      get: (_, prop) => { const v = self.getAttribute(toAttr(prop)); return v === null ? undefined : v; },
      set: (_, prop, value) => { self.setAttribute(toAttr(prop), String(value)); return true; },
      has: (_, prop) => self.getAttribute(toAttr(prop)) !== null,
    });
  }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) {
    const t = new TextNode(v == null ? '' : String(v));
    t.parentElement = this;
    this.childNodes = [t];
  }
  // Previously undefined (this file's own header comment used to list
  // innerHTML alongside fetch/EventSource/canvas as "left undefined/inert" --
  // nothing before this asserted on a re-render of a block that ALREADY
  // carried a persisted comment through wireHtmlStage's two-pass wiring, so the
  // gap never showed). `layer.innerHTML = ''` (src/ui.mjs's renderDomPins/
  // renderMermaidPins, run once at hydrate and again on refresh) silently did
  // NOTHING on the old undefined property -- every re-draw APPENDED instead of
  // replacing, so a pre-existing html-stage comment got a duplicate pin the
  // moment the stage's placeholder-then-real document lifecycle ran both wiring
  // passes (exactly what test/check-anchor-rerender.mjs's old-board fixture
  // check does, and a real browser does on every page load). Fidelity added, not
  // weakened (same precedent as className/style/createTextNode): a
  // real setter, reusing this file's own `parseNodes` (the exact parser that
  // already builds the page/iframe tree) so an assignment of real markup (e.g.
  // src/ui.mjs's comment-item innerHTML) gets real child nodes, not just an
  // empty-string special case.
  get innerHTML() { return ''; } // never read back by anything this stand-in runs
  set innerHTML(html) {
    const nodes = parseNodes(String(html == null ? '' : html));
    nodes.forEach(n => { n.parentElement = this; });
    this.childNodes = nodes;
  }
  // Previously absent entirely
  // (accessing it returned `undefined`, not even an empty string), so
  // src/ui.mjs's applyResync -- `html += el.outerHTML` inside a loop, `''`
  // concatenated with `undefined` -- silently built the STRING "undefined" into
  // what it then tried to parse as markup, rather than throwing or visibly
  // failing. A real, if minimal, serializer: reconstructs `<tag attrs>...
  // </tag>` from this element's own tagName/attributes/childNodes, escaping text
  // exactly enough to round-trip back through this file's own parseNodes/
  // decodeEntities (which is the only parser it ever has to satisfy -- this is
  // not a general HTML serializer). script/style bodies are emitted verbatim,
  // matching how parseNodes reads them back (raw text, never entity-decoded).
  get outerHTML() {
    const tag = this.tag;
    let attrs = '';
    for (const [name, value] of this.attributes) {
      attrs += ' ' + name + '="' + String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
    }
    if (VOID_TAGS.has(tag)) return '<' + tag + attrs + '>';
    const isOpaque = tag === 'script' || tag === 'style';
    const inner = this.childNodes.map(n => {
      if (n.nodeType === 1) return n.outerHTML;
      const text = String(n.data == null ? '' : n.data);
      return isOpaque ? text : text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }).join('');
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
  }
  appendChild(node) { node.parentElement = this; this.childNodes.push(node); return node; }
  // src/ui.mjs's amend path inserts a newly-added top-level block BEFORE the
  // round's closing rail rather than after it. Real semantics, including the
  // one that matters here: a null (or unparented) reference node degrades to
  // an append, exactly as the DOM specifies, so a round with no rail still
  // takes the block.
  insertBefore(node, ref) {
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentElement = this;
    if (idx === -1) this.childNodes.push(node); else this.childNodes.splice(idx, 0, node);
    return node;
  }
  // The diagram lens clones the rendered mermaid SVG
  // into its own canvas (src/ui.mjs's lensOpen), which is what puts TWO elements
  // carrying each mermaid node id in the document at once -- the duplicate-id
  // trap this exists to get right. Previously absent here, so a check
  // could not drive the lens at all. Real semantics, deliberately including the
  // part that matters: a deep clone reproduces element ORDER and ATTRIBUTES
  // exactly (ids included, duplicated on purpose), and carries no listeners, so
  // src/ui.mjs's structural "mirror this node into the other copy" path is
  // exercised against the same shape a browser produces rather than a friendlier
  // one. Detached from any parent, like the real thing.
  cloneNode(deep) {
    const copy = new Element(this.tag);
    this.attributes.forEach((value, name) => copy.setAttribute(name, value));
    if (deep) {
      this.childNodes.forEach(n => {
        copy.appendChild(n.nodeType === 1 ? n.cloneNode(true) : new TextNode(n.data));
      });
    }
    return copy;
  }
  // src/ui.mjs's mermaid loader (renderMermaidBlocks) calls
  // `n.replaceWith(wrap)` on its CDN-unreachable/offline fallback path -- the
  // ordinary case in this stand-in, which never has real network access, and
  // previously undefined here for the same reason as innerHTML above (nothing
  // before test/check-anchor-rerender.mjs ran the real `ui` script over a page
  // that actually contains a `pre.mermaid` node, so the gap never showed; it
  // crashed the process with "n.replaceWith is not a function" the first time
  // one did). Real ChildNode semantics: splice `this` out of its parent's
  // childNodes and splice `nodes` in at the same position.
  replaceWith(...nodes) {
    const parent = this.parentElement;
    if (!parent) return;
    const idx = parent.childNodes.indexOf(this);
    if (idx === -1) return;
    nodes.forEach(node => { node.parentElement = parent; });
    parent.childNodes.splice(idx, 1, ...nodes);
    // Only when this node is genuinely out of the tree. `el.replaceWith(el)` is
    // a real thing a caller does -- src/ui.mjs's amend loop walks the fragment's
    // nested blocks too, so a compare side that arrived inside its own owner is
    // "replaced" by itself -- and a browser leaves it exactly where it is.
    // Nulling unconditionally detached it here instead, which made every nested
    // block in an amended fragment look like a round-level orphan to any check
    // that walked ancestors (closest, wirePageDomPins' own walk).
    if (!nodes.includes(this)) this.parentElement = null;
  }
  querySelector(sel) { return searchDescendants(this, sel)[0] || null; }
  querySelectorAll(sel) { return searchDescendants(this, sel); }
  closest(sel) {
    const groups = parseSelectorGroup(sel);
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (groups.some(chain => elementMatchesChain(cur, chain))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  // Cmd+Enter board traversal needs to assert WHAT got focused, which the old
  // no-op here (`/* nothing in this check asserts on focus */`) could never
  // answer. Real semantics, via `ownerDocument` (this file's existing
  // on-demand back-reference to the owning StandInDocument, computed above --
  // no separate wiring needed at parse/append time): moves the owning
  // document's `activeElement` to `this`. Two things a real browser also
  // refuses, modelled here because a check leans on both:
  //  - an element not currently in any document (`ownerDocument` null) can't
  //    become the active element of a document it isn't part of -- a no-op,
  //    not a throw, exactly like calling `.focus()` on a detached real node.
  //  - a `disabled` element never becomes `document.activeElement`, no matter
  //    how `.focus()` is called on it.
  focus() {
    const doc = this.ownerDocument;
    if (!doc || this.disabled) return;
    doc.activeElement = this;
  }
  // Real semantics: only resets `activeElement` back to `document.body` (via
  // the getter's own fallback -- see StandInDocument's `_activeElement`
  // comment) when THIS element is the one currently focused. Blurring an
  // element that isn't focused, or one that's detached, does nothing --
  // same as a real browser.
  blur() {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement === this) doc.activeElement = null;
  }
  // No layout engine here (this file's own header comment; QUIRKS.md "The
  // stand-in has no layout") so there is no scroll position to actually
  // move -- this records that the call happened and with what, which is all
  // Cmd+Enter traversal's own check needs to assert ("scrolled the newly
  // focused block into view, asking for the options it asked for"). Same
  // shape as `getBoundingClientRect`'s own comment just below: deterministic
  // and inspectable stands in for a real geometric effect this stand-in
  // cannot compute.
  scrollIntoView(options) {
    this.scrollIntoViewCallCount++;
    this.scrollIntoViewLastOptions = options === undefined ? null : options;
  }
  // This used to return an unconditional all-zero box for every
  // element, attached or not -- so a pin placed correctly and a pin placed at
  // (0,0) were byte-identical in every assertion, and the director confirmed
  // replacing BOTH of src/ui.mjs's position computations with a hardcoded
  // {left:9999, top:-4242} caused zero check failures. There is no real layout
  // engine here (see this file's own header comment on its stated ceiling), but a
  // position only has to be DETERMINISTIC and DISTINGUISHABLE per element for a
  // check to tell "positioned on the element that was actually clicked" apart
  // from "positioned at the origin" or "positioned on the wrong element" -- so
  // this derives a box purely from the element's own place in its OWN document
  // (walked via parentElement/children, the exact same steps buildSteps uses to
  // mint an anchor's ref, so the position and the ref it is drawn for are
  // grounded in the same structural fact): each ancestor's 1-based sibling index,
  // folded into a left/top pair. Two different elements collide only in the
  // unlikely case their full index-chains hash to the same fold, and calling this
  // twice on the SAME element always returns the SAME box (unlike a real
  // browser's layout, an ablation cannot fake determinism by returning something
  // that merely varies run to run). A caller compares two of these rects
  // (`elBox.left - stageBox.left`, etc., exactly as src/ui.mjs's renderDomPins/
  // renderMermaidPins do) to get a pin position a check can independently
  // recompute and assert against -- see test/check-click-pin.mjs. */
  getBoundingClientRect() {
    const steps = [];
    let node = this;
    while (node && node.parentElement && node.parentElement.nodeType === 1) {
      const parent = node.parentElement;
      const idx = parent.children.indexOf(node);
      steps.unshift(idx === -1 ? 0 : idx);
      node = parent;
    }
    const depth = steps.length;
    const left = depth * 20;
    const top = steps.reduce((sum, s, i) => sum + (s + 1) * (i + 1) * 7, 0);
    const width = 80;
    const height = 18;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }
}

function findChildByTag(el, tag) {
  return el ? el.children.find(c => c.tagName === tag.toUpperCase()) || null : null;
}

export class StandInDocument extends EventTarget {
  constructor(htmlEl) {
    super();
    this.nodeType = 9;
    this.documentElement = htmlEl;
    this.head = findChildByTag(htmlEl, 'head');
    this.body = findChildByTag(htmlEl, 'body');
    this.parentElement = null; // bubbling terminus: an element's ancestor chain ends here
    htmlEl.parentElement = this;
    this.hidden = false;
    // Backs `activeElement` below. Real DOM: `document.activeElement` is
    // `document.body` when nothing has been explicitly focused, and is never
    // null once the document exists. `this.body` itself, two lines up, can
    // still be null at this exact point -- an explicit `<html>` with no
    // `<body>` inside leaves `findChildByTag` nothing to find -- so this only
    // tracks WHAT has been focused (null = nothing) and the `activeElement`
    // getter falls back to `this.body` lazily on every read, rather than
    // caching a (possibly stale-or-null) body reference now. Same ordering
    // discipline Element's own `ownerDocument` uses above: compute on demand
    // from whatever is true right now, don't stamp in a snapshot taken before
    // the document was necessarily finished being assembled.
    this._activeElement = null;
    const titleEl = findChildByTag(this.head, 'title');
    this._title = titleEl ? titleEl.textContent : '';
    // Defaults to 'loading', matching a real browser's
    // `document.readyState` at the moment an inline <head> script runs (this
    // repo's boot script, src/theme.mjs's themeBootScript, is placed BEFORE
    // <style>, i.e. before the parser has even reached <body> -- see that
    // export's own comment on why the ordering is the whole no-flash
    // mechanism). Previously hardcoded 'complete' here, which meant
    // `document.readyState === 'loading'` -- the boot script's ONLY real
    // branch (`document.addEventListener('DOMContentLoaded', wire)`) -- was
    // unreachable from any check in this suite; only the 'not loading, wire()
    // immediately' branch a real page never takes at that point ever ran.
    // Callers that need a document already past that point (the about:blank
    // placeholder a real browser hands an <iframe> instantly, or a stage's
    // srcdoc content once its own "navigation" has finished -- see
    // aboutBlankDocument and IframeElement.loadSrcdoc below) set `readyState`
    // to 'complete' themselves; a caller driving the OUTER page calls
    // `finishParsing()` below at the point it wants to simulate the parser
    // reaching the end of the document, never by poking `readyState` alone --
    // that method also dispatches the real `DOMContentLoaded` event
    // `themeBootScript`'s deferred branch actually waits for, so the two can
    // never drift apart.
    this.readyState = 'loading';
    // Real DOM's `document.defaultView` -- the window this document
    // belongs to. Wired by whoever CONSTRUCTS a document (parseHTML /
    // aboutBlankDocument below), never here in the constructor itself: a
    // StandInDocument has to exist before its matching StandInWindow can be
    // told about it (the window's own `.document` back-reference needs a
    // document to point at).
    this.defaultView = null;
  }
  get title() { return this._title; }
  set title(v) { this._title = v; }
  // See `_activeElement`'s own comment in the constructor for why this falls
  // back to `this.body` on every read instead of being initialised once.
  // Element.focus()/blur() (below) are the only writers; nothing else should
  // assign this directly.
  get activeElement() { return this._activeElement || this.body; }
  set activeElement(el) { this._activeElement = el; }
  hasFocus() { return true; }
  /** Simulates the HTML parser reaching the end of the
   * document -- flips `readyState` to 'complete' and dispatches a real
   * 'DOMContentLoaded', the one event `themeBootScript`'s deferred branch
   * (registered because `readyState` was 'loading' when it ran) actually
   * waits for. A caller runs the head boot script FIRST (readyState still
   * 'loading', matching its real position before <body> exists), then any
   * deferred/module script (src/ui.mjs's `ui`, a real `<script type="module">`
   * -- deferred by the platform until after parsing finishes, which per spec
   * happens BEFORE `DOMContentLoaded` fires), THEN calls this -- see this
   * file's checks' own loaders for the exact three-step sequence. */
  finishParsing() {
    this.readyState = 'complete';
    this.dispatchEvent(new StandInEvent('DOMContentLoaded'));
  }
  getElementById(id) {
    let found = null;
    (function walk(el) {
      if (found) return;
      for (const child of el.children) {
        if (child.getAttribute('id') === id) { found = child; return; }
        walk(child);
        if (found) return;
      }
    })(this.documentElement);
    return found;
  }
  createElement(tag) { return tag.toLowerCase() === 'iframe' ? new IframeElement() : new Element(tag); }
  createTextNode(data) { return new TextNode(data == null ? '' : String(data)); }
  querySelector(sel) { return searchDescendants(this.documentElement, sel)[0] || null; }
  querySelectorAll(sel) { return searchDescendants(this.documentElement, sel); }
}

/** A synthetic `about:blank` document: what a real browser gives an <iframe>'s
 * `contentDocument` the instant the element exists, before any `srcdoc`/`src`
 * navigation has run -- readyState 'complete', a real (empty) `<body>`. See this
 * file's header comment; reproducing this placeholder is the entire reason this
 * stand-in exists rather than a generic DOM shim. */
function aboutBlankDocument() {
  const html = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  html.appendChild(head);
  html.appendChild(body);
  const doc = new StandInDocument(html);
  // Unlike StandInDocument's own new default ('loading',
  // matching a real page's inline <head> boot script) -- about:blank really is
  // immediately 'complete' in a real browser, per this file's own header
  // comment on why IframeElement manufactures this placeholder eagerly at all;
  // that fact predates and is unrelated to the theme-boot-script ordering fix,
  // so it is restored explicitly here rather than left at the new default.
  doc.readyState = 'complete';
  const win = new StandInWindow();
  win.document = doc;
  doc.defaultView = win;
  return doc;
}

/** Run every `<script>` element found in `doc`, in document order, against
 * `win` -- new capability, not previously
 * implemented (a script's body used to be parsed and blanked, matching the
 * browser's tree shape, but never executed). This is what lets IframeElement's
 * `loadSrcdoc` actually run the stage-side agent script src/render.mjs now
 * injects into every html-stage `srcdoc` -- and, just as load-bearing, whatever
 * a MOCK's own `block.html` supplies alongside it, since the whole point of
 * this is proving what such a script can and cannot reach.
 *
 * Deliberately NOT interleaved with parsing: a real browser executes a
 * `<script>` the instant its parser reaches it (which is why a script placed
 * BEFORE other content can't see that content yet, and why one placed after
 * `document.body` exists can rely on it) -- this stand-in parses the whole
 * document first, then runs every script against the already-complete tree.
 * That is a real, documented simplification (this file's stated ceiling is "the
 * specific behaviour the defect turns on", not a general browser), which is
 * exactly why src/render.mjs places its injected agent script AFTER the mock's
 * own markup: the agent's own listeners are attached via delegation from
 * `document.body` (`addEventListener` on the body, matching clicks on any
 * descendant regardless of when it was added), so execution order relative to
 * the mock's OWN content never matters for it, in this stand-in or in a real
 * browser alike. An external `src=` is skipped, never fetched (QUIRKS.md "no
 * external assets" -- nothing this repo ever emits has one); a script that
 * throws is swallowed and the rest still run, same as a real browser logging
 * one script's error to the console rather than aborting the page -- letting a
 * broken or deliberately hostile mock script abort `loadSrcdoc()` entirely
 * would make the very isolation property this exists to prove
 * untestable. */
function runInlineScripts(doc, win) {
  const scripts = doc.querySelectorAll('script');
  for (const scriptEl of scripts) {
    if (scriptEl.getAttribute('src')) continue;
    const src = scriptEl.textContent;
    if (!src) continue;
    try {
      new Function('document', 'window', src)(doc, win);
    } catch (e) { /* one script's error must not stop the page */ }
  }
}

// The origin a stage's incoming (parent -> stage) message reports on `event.
// origin`, in this stand-in. A fixed placeholder, not a real network origin:
// see render.mjs's design comment ("PARENT -> STAGE") for why the stage-side
// agent never needs to validate this string -- only `event.source ===
// window.parent`, an identity no script anywhere can forge, matters on that
// side of the channel. The PARENT's own receive-side check (the one that
// actually matters for isolation) validates the STAGE's reported origin instead --
// see wireFrameMessaging below and src/ui.mjs's own message listener.
const PARENT_TO_STAGE_ORIGIN = 'http://board.local';

/** Wire the two-way postMessage relationship between one iframe and its owning
 * page. Called once, from IframeElement.loadSrcdoc, the moment the
 * REAL srcdoc content (never the about:blank placeholder, which runs no script
 * and so never sends anything) is parsed. Two independent closures, each bound
 * to exactly the two window objects THIS relationship connects -- deliberately
 * not a shared/class-level "current peer" field, which would get every stage
 * but the last-wired one wrong the moment a page renders more than one
 * html-stage block (see StandInWindow's own file comment): */
function wireFrameMessaging(stageWindow, outerWindow) {
  // Called BY the stage's own script as `window.parent.postMessage(...)` --
  // delivers to the OUTER window's listeners, reporting the opaque origin a
  // real sandboxed-without-allow-same-origin srcdoc document actually has (the
  // literal string "null" -- see render.mjs's design comment for why that is
  // the one and only value a browser ever serializes an opaque origin as).
  var parentHandle = {
    postMessage(data) {
      outerWindow.dispatchEvent({ type: 'message', data, origin: 'null', source: stageWindow });
    },
  };
  stageWindow.parent = parentHandle;
  // Called BY the parent as `frame.contentWindow.postMessage(...)` -- delivers
  // to the STAGE's own listeners, reporting the outer page's (placeholder)
  // origin, with `source` set to `parentHandle` -- the EXACT SAME object
  // `stageWindow.parent` points to, not `outerWindow` itself. This is what
  // makes the stage-side identity check (`event.source === window.parent`,
  // see render.mjs's design comment and stageAgentScript's own message
  // listener) a check that can actually pass: real browsers hand a script
  // `window.parent` and `event.source` (on a message that really came from
  // that parent) as the literal SAME WindowProxy object, so this stand-in has
  // to preserve that same identity, not merely resemble it -- comparing
  // against `outerWindow` directly here would make the stage's own identity
  // check permanently fail, silently dropping every parent -> stage message
  // (a real, caught-by-running-it bug the first draft of this file had).
  // Overrides StandInWindow's default self-messaging postMessage with one
  // bound to this specific pair.
  stageWindow.postMessage = function (data) {
    stageWindow.dispatchEvent({ type: 'message', data, origin: PARENT_TO_STAGE_ORIGIN, source: parentHandle });
  };
}

export class IframeElement extends Element {
  constructor() {
    super('iframe');
    this.contentDocument = aboutBlankDocument();
    this.contentWindow = this.contentDocument.defaultView;
  }
  /** Stand-in for the srcdoc navigation actually completing: parses the iframe's
   * `srcdoc` attribute (already entity-decoded by the outer-page parse, exactly as
   * a browser decodes an attribute value) as a fresh document, swaps it in for the
   * about:blank placeholder, and fires `load` on the frame -- same as a real
   * browser once the navigation finishes, asynchronously, after any synchronous
   * script on the page has already run. Must be called explicitly by the check,
   * AFTER the client script's initial synchronous pass, for the same reason.
   *
   * Now also wires this frame's own two-way postMessage channel
   * (wireFrameMessaging, above -- a no-op if this element is not currently
   * inside a document with its own window, which the parent -> child direction
   * genuinely cannot function without) and RUNS every `<script>` the parsed
   * document contains (runInlineScripts, above) -- this is what actually
   * executes the stage-side agent script src/render.mjs injects, and any
   * script an adversarial mock supplies alongside it, against a window whose
   * `.parent` is a narrow object exposing ONLY `postMessage` -- never
   * `.document`, never the real outer `window` -- which is the isolation
   * property this exists to prove (see test/check-stage-isolation.mjs). */
  loadSrcdoc() {
    this.contentDocument = parseHTML(this.getAttribute('srcdoc') || '');
    // parseHTML's documents now default to 'loading'
    // (matching the OUTER page at the moment its own inline boot script
    // runs), but this method models the srcdoc navigation ALREADY having
    // finished (it dispatches 'load' at the end, and nothing here interleaves
    // script execution with parsing -- see this method's own comment) -- a
    // real stage document at that point is 'complete', not 'loading' forever.
    // Nothing in src/render.mjs's stageAgentScript (or an agent-supplied mock
    // script) reads document.readyState, so this is fidelity, not a behaviour
    // fix for anything this suite currently exercises.
    this.contentDocument.readyState = 'complete';
    const stageWindow = this.contentDocument.defaultView;
    this.contentWindow = stageWindow;
    const outerDoc = this.ownerDocument;
    const outerWindow = outerDoc && outerDoc.defaultView;
    if (outerWindow) wireFrameMessaging(stageWindow, outerWindow);
    runInlineScripts(this.contentDocument, stageWindow);
    const ev = new StandInEvent('load');
    this.dispatchEvent(ev);
  }
}

/** Parse a full page (or a bare fragment, e.g. an html block's srcdoc content) into
 * a StandInDocument. A fragment with no <html>/<head>/<body> of its own is
 * auto-wrapped into a synthetic <html><head>...</head><body>...fragment...</body>,
 * exactly as a real browser does when it parses `srcdoc` content that is not
 * itself a full document -- including hoisting a LEADING run of head-only
 * elements (style/script/meta/link/title/base) into the synthetic `<head>`
 * rather than leaving them as `<body>`'s first children: this stand-in mints every html-stage `dom` ref
 * from `frame.contentDocument.body`, same as a real browser, so if this parser
 * disagreed with src/anchor.mjs's own HEAD_ONLY_TAGS-hoisting `resolveDomAnchor`
 * (imported above, one shared list, not a second one), a check driving a real
 * click through this stand-in could never actually exercise the bug this fixed --
 * both would agree with each other, just not with a real browser. An explicit
 * top-level `<head>` or `<body>` is honoured as given, same as src/anchor.mjs's
 * own `bodyRootChildren`.
 *
 * Also constructs this document's own `StandInWindow` and wires the
 * mutual `defaultView`/`document` reference a real `document`/`window` pair
 * always has -- every document this file ever builds (the outer page, an html
 * stage's real srcdoc content, the about:blank placeholder above) goes through
 * here or aboutBlankDocument, so every document always has a window, and the
 * SAME hoisting applies to both the outer page and a stage's srcdoc:
 * `stageAgentScript` is appended to `block.html` and relies on
 * `document.body` meaning what a real browser's does, exactly like the
 * `dom`-ref-minting a mock's own content already depended on before this
 * capability existed. */
export function parseHTML(htmlString) {
  const topNodes = parseNodes(htmlString);
  let htmlEl = topNodes.find(n => n.nodeType === 1 && n.tagName === 'HTML');
  if (!htmlEl) {
    const explicitBody = topNodes.find(n => n.nodeType === 1 && n.tagName === 'BODY');
    const withoutHead = topNodes.filter(n => !(n.nodeType === 1 && n.tagName === 'HEAD'));
    htmlEl = new Element('html');
    const head = new Element('head');
    const body = explicitBody || new Element('body');
    if (explicitBody) {
      for (const n of withoutHead) {
        if (n === explicitBody) continue;
        if (n.nodeType === 1 && HEAD_ONLY_TAGS.has(n.tag)) head.appendChild(n);
      }
    } else {
      let i = 0;
      while (i < withoutHead.length) {
        const node = withoutHead[i];
        const isHeadOnlyEl = node.nodeType === 1 && HEAD_ONLY_TAGS.has(node.tag);
        const isWhitespaceText = node.nodeType === 3 && /^\s*$/.test(node.data);
        if (!isHeadOnlyEl && !isWhitespaceText) break;
        if (isHeadOnlyEl) head.appendChild(node);
        i++;
      }
      for (; i < withoutHead.length; i++) body.appendChild(withoutHead[i]);
    }
    htmlEl.appendChild(head);
    htmlEl.appendChild(body);
  }
  const doc = new StandInDocument(htmlEl);
  const win = new StandInWindow();
  win.document = doc;
  doc.defaultView = win;
  return doc;
}

// --- EventSource stand-in -----------------------
//
// src/ui.mjs reads a bare, unqualified `EventSource` (never `typeof EventSource
// !== 'undefined'`-guarded for the constructor call itself -- only for whether to
// open the subscription at all), resolved out of whatever global scope the check
// running `new Function('document','window','location', ui)(...)` executes
// in -- exactly like `globalThis.fetch` is already stubbed in
// test/check-comment-mode.mjs. This is what closes the SSE gap:
// "stub EventSource in the stand-in and fire a round push, then assert the pushed
// content is actually anchorable" -- see test/check-anchor-push.mjs, which sets
// `globalThis.EventSource` to a subclass of this before running `ui`, captures the
// constructed instance, and calls `.dispatch('round', json)` to drive
// applyRoundPush/applySubmittedPush exactly as a real server push would, through
// the real `es.addEventListener('round', ...)` src/ui.mjs itself registers --
// never by calling applyRoundPush directly, which would prove nothing about
// whether the subscription is actually wired.
//
// Deliberately not a full EventSource: no readyState transitions, no automatic
// reconnect, no `Last-Event-ID` -- nothing in src/ui.mjs's own SSE handling
// depends on any of that (see its own file comment: reconnect is native
// EventSource behaviour the browser provides for free), so faking it here would
// test this stand-in, not src/ui.mjs.
export class StandInEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }
  /** Fire a named SSE event with `data` -- a STRING, exactly like a real
   * EventSource's `ev.data` (the raw text of the server's `data:` line): src/
   * ui.mjs's own listeners do `JSON.parse(ev.data)`, so a caller here has to
   * `JSON.stringify` first too, same as the real wire format (PROTOCOL.md "SSE
   * events"), not hand a pre-parsed object across. */
  dispatch(type, data) {
    const ev = { type, data, target: this };
    (this.listeners.get(type) || []).slice().forEach(fn => fn(ev));
  }
  close() { this.readyState = 2; }
}

// --- localStorage stand-in (src/theme.mjs) ---------------------------
//
// A plain Map-backed getItem/setItem/removeItem, string keys and values only --
// the one thing src/theme.mjs's `themeBootScript` needs, and all it needs (it
// never reads `.length`, iterates keys, or reacts to a 'storage' event). Belongs
// here rather than inside one check file: another check needs the exact same
// stand-in to prove a `file:` archive never touches it at all, and duplicating
// it per check would risk the two copies drifting apart the way QUIRKS.md warns
// a hand-copied mock always eventually does.
//
// Deliberately NOT auto-attached to StandInWindow: one instance models one
// origin's storage, and a real browser hands every document from that origin
// (including a fresh reload) the SAME underlying storage, not a fresh one per
// `window` object. This stand-in's `parseHTML`/`aboutBlankDocument` each mint a
// brand-new `StandInWindow` per call (modelling a real reload's brand-new
// `window`), so a caller that wants to prove a preference "survives a reload"
// has to construct ONE `StandInLocalStorage` and assign it to
// `window.localStorage` on every document/window it loads, exactly the way a
// real browser's origin storage outlives any one document. Auto-creating a new
// instance per window would make persistence untestable by construction.
export class StandInLocalStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  get size() { return this.map.size; }
}

// --- IntersectionObserver stand-in ------------------
//
// QUIRKS.md "The stand-in has no layout" already explains why this file never had
// one: nothing here lays anything out, so there is no real geometry for a real
// IntersectionObserver to intersect against. The round badge's own
// setupRoundObserver, deleted since, ran under no check at all for exactly that
// reason -- it guarded on `typeof IntersectionObserver !== 'function'` and
// returned, which the stand-in's total absence of the constructor was always
// enough to exercise. That observer is gone now (ADR.md entry 42: rounds are
// pages, decided by explicit state instead of measured scroll position, which is
// precisely what this DOM CAN see -- test/check-round-pager.mjs).
//
// setupSendBarDock (src/ui.mjs) is the first thing in
// this codebase that needs to DRIVE an IntersectionObserver's callback in both
// directions, not just prove the missing-constructor guard is safe: "rail on
// screen -> docked" and "rail off screen -> floating" are both real, checkable
// behaviour, and neither is provable by asserting a listener got registered. Real
// geometry (rects, ratios, rootBounds) is still out of reach here for the same
// reason it always has been -- this fakes the ONE fact src/ui.mjs's callback ever
// reads off an entry (`isIntersecting`) and gives a check a way to fire it
// directly, standing in for "the rail's box crossed the viewport's edge" the way
// StandInEventSource's `dispatch` stands in for a real server push, never a
// simulation of scrolling, rootMargin or threshold math the stand-in has no way
// to get right.
export class StandInIntersectionObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
  }
  observe(target) {
    if (this.targets.indexOf(target) === -1) this.targets.push(target);
  }
  unobserve(target) {
    const idx = this.targets.indexOf(target);
    if (idx !== -1) this.targets.splice(idx, 1);
  }
  disconnect() { this.targets = []; }
  /** Test hook, not a real IntersectionObserver capability: fire this observer's
   * own callback as though `target` just crossed into (`isIntersecting: true`) or
   * out of (`false`) view. `target` is asserted to be one this observer is
   * actually watching, the same discipline StandInEventSource's own dispatch
   * doc comment describes -- driving a callback for an element nobody `observe()`d
   * would prove the check's own wiring, not src/ui.mjs's. */
  _setIntersecting(target, isIntersecting) {
    if (this.targets.indexOf(target) === -1) {
      throw new Error('StandInIntersectionObserver._setIntersecting: target is not observed by this observer');
    }
    this.callback([{ target, isIntersecting }], this);
  }
}
