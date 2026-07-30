// A minimal, zero-dependency DOM stand-in for test/check-click.mjs (ticket 01,
// SPEC_ANCHORING.md) and test/check-click-pin.mjs (ticket 02). It exists to run
// the REAL src/ui.mjs client script -- not a hand-summary of what it does --
// against something DOM-shaped enough that a real click gesture can travel
// through it end to end.
//
// It is deliberately NOT a browser: it implements exactly the surface src/ui.mjs
// touches while wiring an html-stage iframe, handling a click inside it, and (for
// ticket 02's pin check) queueing the comment that click opens a form for --
// element/attribute/classList/className/style/dataset plumbing, createTextNode,
// innerHTML (ticket 04 -- a real setter, parsing the assigned markup with this
// file's own parseNodes, not a no-op; see Element's own comment for why that
// used to matter), firstElementChild/outerHTML (ticket 07 -- see Element's own
// comments: these used to be silently absent, so applySubmittedPush/applyResync
// silently no-op'd against `undefined` instead of erroring, which is exactly the
// "quietly does nothing" failure mode this whole file exists to catch elsewhere;
// implemented for real rather than stubbed to throw, since ticket 07's own SSE
// push checks (test/check-anchor-push.mjs) need firstElementChild to work), a
// small CSS-selector subset (tag, .class, #id, [attr], [attr="value"],
// [attr^="value"], :not(), comma lists and descendant combinators -- no >, +, ~
// or nth-child, none of which ui.mjs uses), bubbling addEventListener/
// dispatchEvent, and (ticket 07) a stand-in EventSource so a 'round'/'submitted'
// push can be driven end to end without a real network. Anything ui.mjs touches
// on a path no check here exercises (fetch, Notification, canvas, DOMParser) is
// simply left undefined/inert -- `typeof x !== 'undefined'` guards and untaken
// branches mean the script never needs them to exist or do anything.
//
// Ticket 07 (SPEC_ANCHORING.md), addressing audit finding C3: this file's HTML
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
// The one piece of browser behaviour this stand-in exists to reproduce faithfully
// (see SPEC_ANCHORING.md Decisions -> "Criterion 8 runs in a DOM stand-in"): an
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
// mode SPEC_ANCHORING.md's Testing section warns about.

// Ticket 07 (SPEC_ANCHORING.md), audit finding C3: the tag-omission rules and
// entity table are the SAME implementation src/anchor.mjs's parseHtmlTree uses,
// imported directly rather than hand-ported a second time -- see the parsing
// section below and test/check-parser-parity.mjs.
//
// Ticket 10 (SPEC_ANCHORING.md): this file now also models `window`/
// `postMessage` and actually EXECUTES a document's own `<script>` elements --
// new capability, not previously implemented at all (a `<script>`'s body used
// to be parsed and blanked, matching the browser's tree shape, but never run).
// This is what lets a check drive the real stage-side agent script
// src/render.mjs now injects into every html-stage `srcdoc` (see that file's
// design comment for the protocol this exists to test) end to end, the same
// way this file already runs the real src/ui.mjs -- and it is what lets a
// check prove the OTHER direction too: that a `<script>` an agent supplies in
// `block.html` cannot reach back out to the parent page's own `document`, the
// property ticket 10 exists to establish (S1 in the 2026-07-29 audit). See
// StandInWindow, IframeElement.loadSrcdoc and runInlineScripts below.
//
// Ticket 08 (SPEC_ANCHORING.md), audit finding C2: `HEAD_ONLY_TAGS`, imported
// the same way as the tag-omission rules above, is what makes `parseHTML`
// hoist a leading run of head-only elements (`<style>`, `<script>`, `<meta>`,
// `<link>`, `<title>`, `<base>`) out of the synthetic body the same way a real
// browser's `document.body` never contains them -- see parseHTML's own
// comment, further down, for where that hoist runs. `resolveDomAnchor`
// (src/anchor.mjs) does the identical hoist server-side; both documents this
// file ever builds (the outer page AND an html stage's own srcdoc, ticket 10's
// addition) go through this same parseHTML, so both get it.
import { autoCloseFor, impliedParentFor, decodeEntities, VOID_ELEMENTS, HEAD_ONLY_TAGS } from '../src/anchor.mjs';

// --- HTML parsing: just enough to build a tree from the exact markup
// src/render.mjs's renderBoardPage emits, and (unlike this file's own header
// comment used to claim) from arbitrary agent-supplied `srcdoc` HTML too --
// ticket 07 (SPEC_ANCHORING.md), audit finding C3: this file's tag-omission
// handling is now genuinely shared with src/anchor.mjs's parseHtmlTree (see the
// file header comment), not a second, narrower hand-port of the same rules. -----

// Exported by src/anchor.mjs (ticket 07) so the two tokenizers never carry two,
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
// Ticket 07 follow-up (SPEC_ANCHORING.md, audit finding C5): 'dragstart' needs no
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
// SPEC_BOARD.md's Testing section already states for the rank drag in general. No
// `dataTransfer` object is stubbed at all: nothing in src/ui.mjs's drag handlers
// ever reads or writes one, so leaving it absent means a future edit that DID try
// to touch `ev.dataTransfer.setData(...)` throws immediately (a TypeError on
// `undefined`) rather than silently no-opping -- exactly the "unimplemented
// surface throws" discipline this file's header comment states, achieved here by
// omission rather than a stub that would have to guess at a shape nothing needs
// yet.

export class StandInEvent {
  constructor(type) {
    this.type = type;
    this.target = null;
    this.defaultPrevented = false;
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
  // Ticket 10: previously absent (the old throwaway `window` stub each check
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
    event.target = event.target || this;
    let cur = this;
    while (cur) {
      const handlers = cur.listeners && cur.listeners.get(event.type);
      if (handlers) for (const fn of handlers.slice()) fn.call(cur, event);
      cur = cur.parentElement || null;
    }
    return !event.defaultPrevented;
  }
}

// --- window / postMessage (ticket 10, SPEC_ANCHORING.md) -----------------------
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
  }
  // A default only ever used for self-messaging (nothing in this repo's client
  // script does that); IframeElement.loadSrcdoc overrides this per-instance with
  // a closure bound to the actual pair of windows involved, exactly like a real
  // browser's own postMessage is bound to the calling script's actual global,
  // not to some fixed default.
  postMessage(data) {
    this.dispatchEvent({ type: 'message', data, origin: 'self', source: this });
  }
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
    this.disabled = false;
    this._style = {};
  }
  // Real CSSStyleDeclaration coerces every assigned value to a string and ignores
  // unrecognised properties; this stand-in only needs property assignment
  // (`pin.style.left = n + 'px'`, as src/ui.mjs's placePin does) to work without
  // throwing, so a plain object is enough -- nothing here reads computed style.
  get style() { return this._style; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  // Lowercase tagName, read by parseNodes' stack machinery (autoCloseFor/
  // impliedParentFor, imported from src/anchor.mjs, read `.tag` off whatever the
  // stack holds -- see this file's own comment on parseNodes for why the shared
  // functions need this rather than `.tagName`).
  get tag() { return this.tagName.toLowerCase(); }
  get firstElementChild() { return this.children[0] || null; }
  // Ticket 10: walks .parentElement up to the owning StandInDocument (nodeType
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
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get id() { return this.getAttribute('id') || ''; }
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
  // Ticket 04: previously undefined (this file's own header comment used to list
  // innerHTML alongside fetch/EventSource/canvas as "left undefined/inert" --
  // nothing before this ticket asserted on a re-render of a block that ALREADY
  // carried a persisted comment through wireHtmlStage's two-pass wiring, so the
  // gap never showed). `layer.innerHTML = ''` (src/ui.mjs's renderDomPins/
  // renderMermaidPins, run once at hydrate and again on refresh) silently did
  // NOTHING on the old undefined property -- every re-draw APPENDED instead of
  // replacing, so a pre-existing html-stage comment got a duplicate pin the
  // moment the stage's placeholder-then-real document lifecycle ran both wiring
  // passes (exactly what test/check-anchor-rerender.mjs's old-board fixture
  // check does, and a real browser does on every page load). Fidelity added, not
  // weakened (same precedent as ticket 02's className/style/createTextNode): a
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
  // Ticket 07 (SPEC_ANCHORING.md), audit finding V6: previously absent entirely
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
  // Ticket 04: src/ui.mjs's mermaid loader (renderMermaidBlocks) calls
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
    this.parentElement = null;
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
  focus() { /* no-op: nothing in this check asserts on focus */ }
  // Ticket 07 (SPEC_ANCHORING.md), audit finding V1 (director-verified
  // separately): this used to return an unconditional all-zero box for every
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
    const titleEl = findChildByTag(this.head, 'title');
    this._title = titleEl ? titleEl.textContent : '';
    this.readyState = 'complete';
    // Ticket 10: real DOM's `document.defaultView` -- the window this document
    // belongs to. Wired by whoever CONSTRUCTS a document (parseHTML /
    // aboutBlankDocument below), never here in the constructor itself: a
    // StandInDocument has to exist before its matching StandInWindow can be
    // told about it (the window's own `.document` back-reference needs a
    // document to point at).
    this.defaultView = null;
  }
  get title() { return this._title; }
  set title(v) { this._title = v; }
  hasFocus() { return true; }
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
  const win = new StandInWindow();
  win.document = doc;
  doc.defaultView = win;
  return doc;
}

/** Run every `<script>` element found in `doc`, in document order, against
 * `win` -- ticket 10 (SPEC_ANCHORING.md): new capability, not previously
 * implemented (a script's body used to be parsed and blanked, matching the
 * browser's tree shape, but never executed). This is what lets IframeElement's
 * `loadSrcdoc` actually run the stage-side agent script src/render.mjs now
 * injects into every html-stage `srcdoc` -- and, just as load-bearing, whatever
 * a MOCK's own `block.html` supplies alongside it, since the whole point of
 * this ticket is proving what such a script can and cannot reach.
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
 * would make the very isolation property this ticket exists to prove
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
// actually matters for S1) validates the STAGE's reported origin instead --
// see wireFrameMessaging below and src/ui.mjs's own message listener.
const PARENT_TO_STAGE_ORIGIN = 'http://board.local';

/** Wire the two-way postMessage relationship between one iframe and its owning
 * page -- ticket 10. Called once, from IframeElement.loadSrcdoc, the moment the
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
   * Ticket 10: now also wires this frame's own two-way postMessage channel
   * (wireFrameMessaging, above -- a no-op if this element is not currently
   * inside a document with its own window, which the parent -> child direction
   * genuinely cannot function without) and RUNS every `<script>` the parsed
   * document contains (runInlineScripts, above) -- this is what actually
   * executes the stage-side agent script src/render.mjs injects, and any
   * script an adversarial mock supplies alongside it, against a window whose
   * `.parent` is a narrow object exposing ONLY `postMessage` -- never
   * `.document`, never the real outer `window` -- which is the isolation
   * property this ticket exists to prove (see test/check-stage-isolation.mjs). */
  loadSrcdoc() {
    this.contentDocument = parseHTML(this.getAttribute('srcdoc') || '');
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
 * rather than leaving them as `<body>`'s first children (ticket 08,
 * SPEC_ANCHORING.md, audit C2): this stand-in mints every html-stage `dom` ref
 * from `frame.contentDocument.body`, same as a real browser, so if this parser
 * disagreed with src/anchor.mjs's own HEAD_ONLY_TAGS-hoisting `resolveDomAnchor`
 * (imported above, one shared list, not a second one), a check driving a real
 * click through this stand-in could never actually exercise the bug C2 fixed --
 * both would agree with each other, just not with a real browser. An explicit
 * top-level `<head>` or `<body>` is honoured as given, same as src/anchor.mjs's
 * own `bodyRootChildren`.
 *
 * Ticket 10: also constructs this document's own `StandInWindow` and wires the
 * mutual `defaultView`/`document` reference a real `document`/`window` pair
 * always has -- every document this file ever builds (the outer page, an html
 * stage's real srcdoc content, the about:blank placeholder above) goes through
 * here or aboutBlankDocument, so every document always has a window, and the
 * SAME hoisting applies to both the outer page and a stage's srcdoc: ticket
 * 10's `stageAgentScript` is appended to `block.html` and relies on
 * `document.body` meaning what a real browser's does, exactly like the
 * `dom`-ref-minting a mock's own content already depended on before this
 * ticket. */
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

// --- EventSource stand-in (ticket 07, SPEC_ANCHORING.md) -----------------------
//
// src/ui.mjs reads a bare, unqualified `EventSource` (never `typeof EventSource
// !== 'undefined'`-guarded for the constructor call itself -- only for whether to
// open the subscription at all), resolved out of whatever global scope the check
// running `new Function('document','window','location', ui)(...)` executes
// in -- exactly like `globalThis.fetch` is already stubbed in
// test/check-comment-mode.mjs. This is what closes audit finding V1's SSE row:
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
