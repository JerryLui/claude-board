// Markdown -> HTML, now driven by a real CommonMark/GFM engine (ADR 62: vendored
// `marked@18.0.9`, MIT, zero runtime deps, `src/vendor/marked/marked.esm.js`) instead
// of the hand-rolled line scanner this module used to carry. Extended with anchor
// emission: every heading becomes an anchor at its slug, every top-level list item
// under that heading becomes `<slug>-liN` (1-based, numbered per heading section).
// See DESIGN.md Decisions -> "Anchors at headings and list items", which ADR.md entry 28
// withdrew as a COMMENT target: the slug ids minted here stay, and are what a caller's
// `#section-slug` reference resolves against, but no `md` anchor kind reaches a comment
// any more (src/board.mjs `ANCHOR_KINDS`). One exception, decided
// deliberately: a SETEXT heading renders but mints no anchor -- see isSetextHeading
// below for why AC 10 outranks anchoring it.
//
// This module is also the single owner of heading identity for the whole repo:
// `scanHeadings` (bottom) hands src/resolve.mjs the headings, slugs, ordinals and
// source lines a `section:` reference is sliced with, so nothing re-derives them from
// raw bytes with a second set of regexes. It used to, and the two disagreed.
//
// marked is used ONLY as a tokenizer. `marked.lexer(md)` returns a fully resolved
// block+inline token tree (see `Lexer.lex` in the vendor bundle: it walks its own
// `inlineQueue` before returning, so every token's `.tokens` is already populated --
// no separate "parse" call is needed). This module walks that tree itself and emits
// HTML by hand, exactly the way it always has, rather than handing the tree to
// marked's own `Parser`/`Renderer` classes. Three things forced that choice, not
// taste:
//   1. Anchor ids. A heading's slug and a list item's `-liN` id are THIS module's
//      concept, not marked's (marked has its own incompatible heading-id scheme,
//      off by default). Something has to walk the tree deciding "is this the first
//      top-level list under a heading" regardless of who emits the tags -- and once
//      that walk exists, it may as well emit the tags too.
//   2. Raw HTML must render as text (AC 9). `sanitize` was removed from marked years
//      ago; the escape-instead-of-pass-through policy has to intercept every `html`
//      token regardless of who calls it, so a from-scratch walk costs nothing extra.
//   3. Byte-for-byte legacy output. The XSS regression tests below (ablation-
//      verified: reverting the fix they guard makes every one of them fail) pin an
//      exact attribute order (`alt` before `src`; `href` before `target` before
//      `rel`) and an exact "URL capture stops at the first unescaped `)`" truncation
//      that predates this module and that marked's own spec-correct balanced-paren
//      destination parser does NOT reproduce. `legacyInlineDestination` below
//      re-derives the href from the token's raw source with the OLD naive regex
//      specifically to keep those bytes pinned, while everything else -- reference-
//      style links, setext headings, loose lists, GFM -- comes from marked's real
//      parse. See the two functions' own comments for exactly where that split runs.
//
// Fenced code: a ```mermaid fence renders as a diagram host element, unchanged,
// through renderCode() below (AC 13). A bare ``` fence renders through the SAME
// tokenizer a `kind: 'code'` block uses -- src/render.mjs's `highlightFenceHtml`
// (TOKEN_CLASS/highlightRows/flattenTokens live there, once) -- reached by
// dependency injection rather than a direct import: this module is upstream of
// src/render.mjs already (src/board.mjs imports mdToHtmlAndAnchors from here AND
// renderBlock from render.mjs, so a markdown.mjs -> render.mjs import would close
// a cycle through board.mjs). board.mjs passes its own `highlightFenceHtml` import
// in as `opts.highlight`; every other caller (every check in test/check-pure.mjs)
// omits it and gets today's plain-escaped fallback, unchanged (SPEC_RENDERING.md
// AC 14, ADR.md entry 65).

import { marked, Lexer } from './vendor/marked/marked.esm.js';

// --- linear-time emphasis and strikethrough (DoS fix over the vendored engine) --
//
// marked@18.0.9's own `Tokenizer.emStrong` (the `_..._`/`__..__`/`*..*`/`**..**`
// matcher) AND its `Tokenizer.del` (GFM `~~strike~~`) are each called once per
// character position by the inline scan loop, and on failure to find a closer
// each rescans forward to the end of the remaining string before giving up --
// O(n) work per FAILED position, O(n) failed positions on content shaped like
// ` _a _a _a ...` (never closes), so O(n^2) overall. Measured: 5000 reps of that
// (~15KB) took 935ms; 20000 reps (~60KB) did not finish in 10s -- confirmed for
// `_`, `*` and `~~` alike. That is the exact DoS class `test/check-pure.mjs`'s
// "N2" section pins linear time against, the one this module's own pre-marked
// scanner was written to avoid, and this vendored engine reintroduces it for
// every GFM emphasis-family delimiter. Options were: patch the vendored bytes
// (not allowed -- ADR 62 pins them to a recorded sha256 `test/check-vendor-
// digest.mjs` asserts offline) or replace the tokenizer methods. `marked.use(
// {tokenizer})` wraps whatever it's given and falls back to the original only
// when the replacement returns the literal value `false` (see the vendor
// bundle's `use()`); neither replacement below ever does, so the quadratic
// originals are never reached.
//
// Both replacements are linear by memoizing "no closing run exists in the
// searched suffix" per delimiter key (`_1`, `_2`, `*1`, `*2`, `~~`). The scan
// loop only ever shrinks its remaining string as it advances (`e =
// e.substring(...)`), so if a scan starting at length L finds no closer
// anywhere in it, no LATER call -- always a suffix of that same L-length string
// -- can find one either (a closer in a suffix would have been a closer in the
// superset that was just exhaustively searched). Once a key's bound is set,
// every subsequent call with a shorter remaining length is an instant reject;
// at most one full-length scan ever runs per key. `marked` calls the
// `emStrongMask` hook exactly once per top-level inline pass (before the
// position loop starts), which is where the shared memo resets -- without
// that, state from one board's markdown would leak into the next call's
// complexity analysis (still correct, since a false "no closer" only costs
// missed emphasis, never a hang, but resetting is cheap and keeps behaviour
// independent of call history).
//
// The "one pass over one string" scope is load-bearing and NOT automatic: a
// successful match below calls `Lexer.lexInline` on the emphasis CONTENT -- a
// different string -- which fires the same `emStrongMask` hook, replaces the memo
// and writes its own bounds into it. Left alone, the outer scan then inherited a
// bound derived from an unrelated string and rejected delimiters that string really
// does close: `*see _the notes*, then read _this_` silently dropped `<em>this</em>`,
// history-dependent within a paragraph. It also voided the complexity bound this
// whole override exists for, because every successful match wiped the memo the
// failing ones had built: `'*x* _a'.repeat(n)` measured 18KB 98ms, 36KB 352ms, 72KB
// 1344ms -- quadratic again, on interleaved input that a homogeneous DoS fixture
// cannot reach. `lexNested` below is the fix: save the memo, run the nested lex,
// restore it. Cheaper than keying the memo on the string being scanned, and it buys
// the same thing -- the nested pass is a fresh, correct, self-contained scan either
// way; only its leftovers were ever the problem.
let noCloserBelow;
const resetDelimiterMemo = () => { noCloserBelow = new Map(); };
resetDelimiterMemo();

/** Lex emphasis content through marked's inline lexer without letting the nested
 * pass's delimiter memo escape into the scan that is still running out here. */
function lexNested(text) {
  const outer = noCloserBelow;
  try {
    return Lexer.lexInline(text);
  } finally {
    noCloserBelow = outer;
  }
}

const canOpenUnderscore = c => c === '' || c === undefined || /\s/.test(c) || c === '(';
const canCloseUnderscore = c => c === undefined || /[\s).,;:!?]/.test(c);

/** `e` is the remaining source from the current scan position; `maskedSrc` is the
 * FULL original inline-scan string with code spans/links/etc already replaced by
 * same-length `[aaa...]` placeholders (computed once per pass), so a `_`/`*`
 * sitting inside one can never be mistaken for a real delimiter -- sliced to align
 * with `e` the same way the original implementation does. `prevChar` is the last
 * character already emitted, for the "can this delimiter open here" flanking
 * check; empty string at the start of the scanned text. */
function fastEmStrong(e, maskedSrc, prevChar) {
  const ch = e[0];
  if (ch !== '_' && ch !== '*') return undefined;
  let runLen = 1;
  while (e[runLen] === ch) runLen++;
  if (runLen > 2) return undefined; // 3+ runs: outside this module's scope, same as before marked
  if (ch === '_' && !canOpenUnderscore(prevChar)) return undefined;
  const afterOpen = e[runLen];
  if (afterOpen === undefined || /\s/.test(afterOpen)) return undefined;

  const key = ch + runLen;
  const bound = noCloserBelow.get(key);
  if (bound !== undefined && e.length <= bound) return undefined;

  const masked = maskedSrc.slice(maskedSrc.length - e.length);
  for (let i = runLen; i < e.length; i++) {
    if (masked[i] !== ch) continue;
    let closeLen = 1;
    while (masked[i + closeLen] === ch) closeLen++;
    if (closeLen !== runLen) { i += closeLen - 1; continue; }
    if (/\s/.test(e[i - 1])) { i += closeLen - 1; continue; }
    if (ch === '_' && !canCloseUnderscore(e[i + runLen])) { i += closeLen - 1; continue; }
    const raw = e.slice(0, i + runLen);
    const text = e.slice(runLen, i);
    return { type: runLen === 2 ? 'strong' : 'em', raw, text, tokens: lexNested(text) };
  }
  noCloserBelow.set(key, Math.min(bound ?? Infinity, e.length));
  return undefined;
}

/** Same shape and same complexity argument as `fastEmStrong`, scoped to GFM's
 * `~~text~~` (double tilde only -- marked's own `del` permissively also accepts
 * a single `~`, a CommonMark-GFM extension quirk no existing behaviour or test
 * relies on, so this module doesn't reproduce it). */
function fastDel(e, maskedSrc, prevChar) {
  if (e[0] !== '~' || e[1] !== '~') return undefined;
  const afterOpen = e[2];
  if (afterOpen === undefined || /\s/.test(afterOpen) || afterOpen === '~') return undefined;

  const bound = noCloserBelow.get('~~');
  if (bound !== undefined && e.length <= bound) return undefined;

  const masked = maskedSrc.slice(maskedSrc.length - e.length);
  for (let i = 2; i < e.length; i++) {
    if (masked[i] !== '~') continue;
    let runLen = 1;
    while (masked[i + runLen] === '~') runLen++;
    if (runLen !== 2) { i += runLen - 1; continue; }
    if (/\s/.test(e[i - 1])) { i += 1; continue; }
    const raw = e.slice(0, i + 2);
    const text = e.slice(2, i);
    return { type: 'del', raw, text, tokens: lexNested(text) };
  }
  noCloserBelow.set('~~', Math.min(bound ?? Infinity, e.length));
  return undefined;
}

marked.use({
  hooks: { emStrongMask(maskedSrc) { resetDelimiterMemo(); return maskedSrc; } },
  tokenizer: { emStrong: fastEmStrong, del: fastDel },
});

/** Anchor prefix for top-level list items that precede every heading in a source.
 * Underscore is deliberate: `slugify` strips `_` (and every other non-alphanumeric)
 * before it ever reaches the output, so no heading can ever produce this string and
 * the synthetic prefix cannot shadow or be shadowed by a real section. */
export const SYNTHETIC_SECTION = '_body';

/** Reserve `base` in `used`, disambiguating with -2, -3, ... exactly as `slugify`
 * does. List-item refs go through this too: they used to be minted as a bare
 * `<slug>-liN` string that was never registered, so a later `## Risks li1` heading
 * could slugify to `risks-li1` -- the same id a bullet under `## Risks` already
 * carried. Two elements then shared an id, and src/render.mjs's last-wins ref-to-label
 * lookup labelled the reviewer's comment on the bullet with the heading's
 * text. Ids are the join key; they have to be unique across BOTH kinds of anchor. */
function reserveRef(base, used, ordinals) {
  return disambiguate(base, used, ordinals);
}

/** Append `-2`, `-3`, ... until `base` is free in `used`, then reserve it.
 *
 * `ordinals` is an optional `Map<base, nextOrdinalToTry>` carried alongside `used`
 * (N headings sharing one base cost O(N^2), because every call re-probed from
 * `-2`. 131072 headings -- 512KiB of `# a`, i.e. the by-value cap -- took 10.5
 * minutes of a single-threaded daemon). Skipping ordinals already observed as taken
 * is safe and output-identical: `used` only ever grows within a pass, so a suffix
 * seen taken can never come free again. Omitting the map keeps the old linear probe,
 * which is correct but quadratic. UNCHANGED from before this module vendored marked
 * -- AC 10 pins this algorithm byte-for-byte. It is also the ONLY implementation of
 * it now: `src/resolve.mjs` used to run an independent pass over the raw bytes on
 * disk to re-derive the same ids, and the claim that it "cannot drift even slightly"
 * was wrong in five measured ways (see `scanHeadings` below). It consumes this
 * module's answer instead. */
function disambiguate(base, used, ordinals) {
  let ref = base;
  let n = ordinals?.get(base) ?? 2;
  if (used.has(ref)) {
    ref = `${base}-${n}`;
    while (used.has(ref)) ref = `${base}-${++n}`;
    n++;
  }
  ordinals?.set(base, n);
  used.add(ref);
  return ref;
}

/** Slugify heading text into an anchor id: lowercase, markdown syntax stripped,
 * non-alphanumerics collapsed to hyphens. Duplicate slugs get -2, -3, ... suffixes.
 * Exported for the checks that pin it (src/resolve.mjs used to call it directly to
 * re-derive ids from raw file bytes; it consumes `scanHeadings` below instead now,
 * so a slug is minted in exactly one place).
 * UNCHANGED (AC 10): every character-class and ordering decision here is pinned by
 * `test/check-pure.mjs`'s slug-corpus check against the pre-marked implementation,
 * which that check now runs directly (test/fixtures/markdown-pre-marked.mjs). */
export function slugify(text, used, ordinals) {
  let base = text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!base) base = 'section';
  return disambiguate(base, used, ordinals);
}

// --- escaping -------------------------------------------------------------------
//
// esc() runs on every plain-text fragment (marked hands this module RAW source
// text -- unlike the old scanner, nothing here pre-escapes the whole document up
// front). Sufficient for HTML *text* content: &, < and > become entities. Attribute
// values (alt, src, href, and the heading/list-item id) are a different context: an
// unescaped " or ' there lets crafted content break out of the attribute and inject
// a live handler, e.g. `![" onerror=alert(1) x="](y.png)`. escAttr adds
// quote-escaping on top of &/</> -- it must not redo those, or literal `&amp;` in
// source would double-escape to `&amp;amp;`.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// C0 controls (and DEL) are stripped from a URL before its scheme is tested and
// before it is emitted. The scheme regex only matches at offset 0 and JS `\s` does
// not cover \x01-\x08 / \x0e-\x1f, while a raw destination happily admits them -- so
// `[x](\x01javascript:alert(1))` sailed past the allowlist. It is not cosmetic: the
// HTML tokenizer keeps U+0001 inside the attribute value, but the WHATWG URL parser
// strips leading C0 controls before reading the scheme, so the browser really does
// navigate to `javascript:` and execute at the daemon's origin. Markdown blocks are
// snapshotted from arbitrary files, which is the exact threat the allowlist exists
// for. Stripping (rather than just testing the stripped form) also matters: the
// emitted href must be the string that was vetted, not the raw one.
//
// A leading SPACE is the same hole with a byte nobody thinks of as a control. WHATWG
// URL parsing strips leading and trailing C0 controls *or U+0020* before it reads the
// scheme -- `new URL(' javascript:alert(1)').protocol === 'javascript:'` -- so a
// destination that begins with a space matched no scheme here, was classified as
// relative, and was emitted live while the browser still saw `javascript:`. Reachable
// through the two destination syntaxes that PRESERVE leading whitespace, both new
// with marked: an angle-bracket destination (`[x](< javascript:alert(1)>)`, every
// byte between < and > is the URL) and a reference definition (`[r]: < vbscript:x>`).
// The trim is at the ENDS only, matching the parser: an interior space is
// percent-encoded by the URL parser, not removed, so removing it here would change a
// legitimate destination's bytes. The rest of the whitespace the parser strips (tab,
// LF, CR -- removed from anywhere in the URL) is already inside the \x00-\x1f class
// below; other Unicode whitespace is NOT stripped by the parser, so a scheme hidden
// behind U+00A0 never reaches the browser as a scheme at all.
const stripUrlControls = u => String(u).replace(/[\x00-\x1f\x7f]+/g, '').replace(/^ +| +$/g, '');

// A C0 control byte doesn't just threaten a URL's scheme test -- it can keep
// marked from recognising a destination as a link AT ALL. `[x](\x00javascript:
// alert(1))` used to still reach `legacyInlineDestination` below (which strips
// controls via `safeUrl`/`stripUrlControls` same as any other destination), but
// marked's own link-destination regex refuses to match across a NUL byte, so the
// whole construct falls through as a single opaque 'text' token -- no link/image
// token is ever produced for `legacyInlineDestination` to fix up, and the raw
// `\x00javascript:alert(1))` bytes would otherwise reach the page as inert-but-
// unpleasant text (still not a live href, but a real behavioural regression from
// the pre-marked scanner, which caught this the same way it caught every other
// URL). Stripping stray C0 controls (except the three structural whitespace ones
// markdown depends on) from the WHOLE document before it ever reaches marked
// closes that gap at the source instead of chasing it through every tokenizer
// corner: with the byte gone, marked tokenizes the link normally and the
// existing scheme allowlist runs exactly as it does for any other destination.
const stripDocumentControls = md => String(md).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// marked's own first act on a document (`carriageReturn: /\r\n|\r/g` in the vendor
// bundle) -- done here instead, up front, so the string this module counts lines and
// offsets in is byte-identical to the one the tokenizer sees. Neither this nor
// stripDocumentControls above ever adds or removes a `\n`, so a line number is the
// same number in the stripped text and in the caller's own normalised split (see
// scanHeadings).
const normalizeNewlines = md => String(md).replace(/\r\n|\r/g, '\n');
const countNewlines = s => {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

/** Is this heading token's raw source a SETEXT heading (`Title\n=====`) rather than
 * an ATX one (`## Title`)? An ATX heading is always one line; a setext heading is
 * always its title line(s) plus an underline, so a newline anywhere but at the very
 * end is the whole test -- no re-derivation of CommonMark's underline rules, which is
 * exactly the kind of second opinion this module is trying not to hold.
 *
 * Setext headings RENDER (SPEC_RENDERING.md AC 11 names them as one of the four gaps
 * marked closes) but mint NO anchor, which is a product decision, not an oversight:
 * AC 10 requires slugs byte-identical to the pre-marked parser so archived `section:`
 * refs keep resolving, and that parser had no setext headings at all. Anchoring one
 * would consume a slug and an ordinal it never consumed, so a document mixing a
 * setext heading with a duplicate-text `#` heading would shift every later slug.
 * Skipping the mint keeps `currentSlug` and the `-liN` counter on the last ATX
 * heading too -- again matching what the old parser did with what it saw as ordinary
 * paragraph text. */
const isSetextHeading = raw => raw.replace(/\n+$/, '').includes('\n');

// Only http(s), mailto, and schemeless (relative/fragment/protocol-relative) URLs
// render as a live href/src; javascript:, data:, vbscript: and any other scheme are
// neutralised. Markdown blocks are resolved by reference from arbitrary files on
// disk -- the reviewer did not necessarily write or vet the URL, so a crafted
// `[t](javascript:alert(1))` must not become a clickable script trigger.
const isSafeUrl = u => {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  return !m || /^(https?|mailto)$/i.test(m[1]);
};
/** The vetted, normalised URL to emit, or '' when the scheme is not allowed. */
const safeUrl = u => {
  const clean = stripUrlControls(u);
  return isSafeUrl(clean) ? clean : '';
};

// --- legacy inline-destination re-derivation (security byte-pin) -----------------
//
// marked's own link/image href (`token.href`) comes from a spec-correct parse of
// the destination -- including CommonMark's "balanced parentheses don't need
// escaping" rule. The pre-marked regex this module used (`[^)\s]+`, no paren
// balancing at all) stopped at the FIRST unescaped `)`, full stop. For a crafted
// destination like `y.png"onerror=alert(1)x="`, that is a real behavioural
// difference: marked's parser sees one balanced `(1)` pair inside and correctly
// consumes the whole thing as one destination, while the old scanner truncated
// after `alert(1` and left `)x="` as trailing paragraph text. The regression tests
// below pin the OLD (truncated) bytes exactly, so for INLINE `[text](dest)` /
// `![alt](dest)` syntax -- recognisable because the token's raw source still has a
// literal `(` right after the `]` -- this function re-runs that exact legacy regex
// against `token.raw` and returns both the truncated destination and how much of
// `raw` it consumed. Whatever `raw` has left over (marked consumed it into the
// token; the old scanner would have left it as literal trailing text) is spliced
// back in as escaped text by the caller. Reference-style links (`[text][ref]`, no
// literal `(` at all) and autolinks don't match this pattern and fall through to
// marked's real (and, per AC 11, newly-supported) resolution untouched. */
function legacyInlineDestination(raw, isImage) {
  const re = isImage ? /^!\[[^\]]*\]\(([^)\s]+)\)/ : /^\[[^\]]+\]\(([^)\s]+)\)/;
  const m = re.exec(raw);
  return m ? { href: m[1], consumed: m[0].length } : null;
}

// --- table cell splitting, code-span aware (AC 11, gap 4) ------------------------
//
// marked's own cell splitter (`ee` in the vendor bundle) walks a table row looking
// for unescaped `|` characters and has no notion of a backtick code span at all --
// `` | `x|y` | `` splits into cells "`x" and "y`" exactly like the old scanner
// closing this ceiling was meant to fix. This module re-splits every header/body
// row itself, off the table token's own `raw` (so the row text always matches
// exactly what marked decided was part of the table -- no independent re-detection
// of table boundaries, which is where a hand-rolled scanner could disagree with
// marked's and silently eat or leak a line), tracking backtick-run state so a pipe
// between a matched opening and closing run of the SAME length is never a split
// point. A run with no matching close is not a code span (CommonMark rule) and its
// backticks are ordinary characters the scan continues straight through. */
function splitTableRowCells(row) {
  const s = row.replace(/^\|/, '').replace(/\| *$/, '');
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let j = i;
      while (s[j] === '`') j++;
      const openLen = j - i;
      let k = j, close = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let k2 = k;
          while (s[k2] === '`') k2++;
          if (k2 - k === openLen) { close = k2; break; }
          k = k2;
        } else k++;
      }
      if (close === -1) { cur += s.slice(i, j); i = j; continue; } // no match: literal backticks
      cur += s.slice(i, close);
      i = close;
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  // `\|` unescapes to a literal pipe post-split, same as marked's own splitter --
  // matching its behaviour (rather than CommonMark's "no escapes inside code spans"
  // rule) keeps ordinary (non-code-span) cells byte-identical to before.
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

/**
 * Render markdown to HTML and extract anchors.
 * @param {string} md
 * @param {{ highlight?: (text: string, lang: string) => string }} [opts] -
 *   `highlight`, when given, is called for a non-mermaid fenced code block's text
 *   and `lang` and must return the fence's WHOLE markup -- `<pre><code>...`
 *   already `tok-*`-classed, optionally wrapped in the language-label div
 *   (src/render.mjs's `highlightFenceHtml` is the one real implementation; see
 *   renderCode below and ADR.md entry 65 for why this is an injected argument
 *   rather than an import). Omitted, a fence renders exactly as it always has:
 *   plain, escaped, unhighlighted -- every caller in test/check-pure.mjs relies on
 *   that default.
 * @returns {{ html: string, anchors: Array<{kind: 'md', ref: string, label: string}> }}
 */
export function mdToHtmlAndAnchors(md, opts = {}) {
  const { highlight } = opts;
  const anchors = [];
  // Every heading this pass could place in the source, in document order (see
  // scanHeadings below, which is what src/resolve.mjs consumes). Set by
  // renderHeading; `topLevelLine` is the 0-based line of the top-level token being
  // rendered, or null for anything nested (inside a list item, say), whose position
  // this walk cannot pin down.
  const headings = [];
  let topLevelLine = null;
  const usedSlugs = new Set();
  // Carried beside usedSlugs so duplicate-slug disambiguation stays O(1) amortised;
  // see disambiguate() above. Shared by the heading and list-item passes, because
  // they disambiguate against the same set.
  const slugOrdinals = new Map();
  let currentSlug = null;
  let liCounter = 0;

  // --- inline ---------------------------------------------------------------

  const renderInline = tokens => tokens.map(renderInlineToken).join('');

  function renderInlineToken(t) {
    switch (t.type) {
      case 'escape': return esc(t.text);
      case 'text': return t.tokens ? renderInline(t.tokens) : esc(t.text);
      case 'strong': return '<strong>' + renderInline(t.tokens) + '</strong>';
      case 'em': return '<em>' + renderInline(t.tokens) + '</em>';
      case 'del': return '<del>' + renderInline(t.tokens) + '</del>';
      case 'codespan': return '<code>' + esc(t.text) + '</code>';
      case 'br': return '<br>';
      case 'html':
        // Raw inline HTML (AC 9): a live tag reaching here came straight off the
        // referenced file, unsandboxed, into the board page's own origin -- render
        // its source as text rather than letting the browser parse it as markup.
        return esc(t.text);
      case 'image': {
        const legacy = legacyInlineDestination(t.raw, true);
        const tag = '<img alt="' + escAttr(t.text) + '" src="' + escAttr(safeUrl(legacy ? legacy.href : t.href)) + '">';
        return legacy ? tag + esc(t.raw.slice(legacy.consumed)) : tag;
      }
      case 'link': {
        const legacy = legacyInlineDestination(t.raw, false);
        const href = safeUrl(legacy ? legacy.href : t.href) || '#';
        const tag = '<a href="' + escAttr(href) + '" target="_blank" rel="noopener noreferrer">' + renderInline(t.tokens) + '</a>';
        return legacy ? tag + esc(t.raw.slice(legacy.consumed)) : tag;
      }
      default: return esc(t.text ?? t.raw ?? '');
    }
  }

  // --- block ------------------------------------------------------------------
  //
  // `quoted` mirrors the pre-marked module's flag exactly: a heading or list item
  // rendered while inside a blockquote is somebody ELSE's document being cited, so
  // it must not mint an anchor, must not carry an id, and must not consume a slug
  // or a `-liN` ordinal -- a source quoting `> ## Plan` above its own `## Plan`
  // must give the REAL heading `plan`, not hand it to the quotation.
  //
  // `listDepth` replaces the old indentation-stack: a list is "top-level" (its
  // items are anchor-eligible) exactly when it is not nested inside another list
  // item's own content. Depth resets to 0 on entering a blockquote (a list
  // directly inside one is still depth-0 there; `quoted` alone is what suppresses
  // it), and increments by exactly one crossing from a list item into a list
  // token nested in that item's `tokens`.

  function renderBlocks(tokens, quoted, listDepth) {
    let out = '';
    for (const t of tokens) out += renderBlockToken(t, quoted, listDepth);
    return out;
  }

  function renderBlockToken(t, quoted, listDepth) {
    switch (t.type) {
      case 'space': case 'def': return '';
      case 'hr': return '<hr>';
      case 'heading': return renderHeading(t, quoted);
      case 'paragraph': return '<p>' + renderInline(t.tokens) + '</p>';
      case 'blockquote': return '<blockquote>' + renderBlocks(t.tokens, true, 0) + '</blockquote>';
      case 'code': return renderCode(t);
      case 'html':
        // Raw HTML block (AC 9), same escape-not-markup policy as the inline case.
        // Wrapped in <p> to match the old scanner's fallback: an unrecognised line
        // (which is all a raw HTML line ever was, pre-marked) fell through to the
        // generic paragraph branch.
        return '<p>' + esc(t.text ?? t.raw) + '</p>';
      case 'table': return renderTable(t);
      case 'list': return renderList(t, quoted, listDepth);
      // 'text' reaches here only for a stray top-level text token (marked's
      // block-level catch-all); give it the same paragraph treatment.
      case 'text': return '<p>' + (t.tokens ? renderInline(t.tokens) : esc(t.text)) + '</p>';
      default: return '';
    }
  }

  function renderHeading(t, quoted) {
    const open = '<h' + t.depth;
    const close = '</h' + t.depth + '>';
    const setext = isSetextHeading(t.raw);
    // A quoted heading is somebody else's document (see renderBlocks above) and mints
    // nothing at all -- not even a line in the heading index, since there is no
    // anchor for a `section:` ref to have been shown.
    if (quoted) return open + '>' + renderInline(t.tokens) + close;
    const slug = setext ? null : slugify(t.text, usedSlugs, slugOrdinals);
    // Recorded even when the slug is null: an unanchored heading still ENDS the
    // section above it, because that is what a reader sees on the page.
    if (topLevelLine !== null) headings.push({ ref: slug, level: t.depth, line: topLevelLine });
    if (setext) return open + '>' + renderInline(t.tokens) + close;
    currentSlug = slug;
    liCounter = 0;
    anchors.push({ kind: 'md', ref: slug, label: t.text });
    return open + ' id="' + escAttr(slug) + '">' + renderInline(t.tokens) + close;
  }

  function renderCode(t) {
    // Mermaid fences pass through as a diagram host element, unchanged (AC 13) --
    // NOT through the code-highlighting path even when `highlight` is given, but
    // as raw text for the client-side mermaid.js to read from .textContent, which
    // HTML-decodes entities transparently, so escaping here is both safe and
    // invisible to the diagram.
    if ((t.lang || '').trim() === 'mermaid') return '<pre class="mermaid">' + esc(t.text) + '</pre>';
    // A bare fence: routed through the SAME tokenizer a `kind: 'code'` block uses
    // (AC 14, ADR.md entry 65) when the caller supplied one -- `highlight` is
    // `highlightFenceHtml` from src/render.mjs, injected by src/board.mjs, never
    // imported here directly (see this file's header comment for why). No gutter,
    // no line numbers: a fence carries no `source.lines`, so there is no "file's
    // real line number" (AC 7) to give it, and `highlightFenceHtml` never adds
    // one -- just the same `tok-*` spans a code block's body would get, over the
    // exact same bytes (plus, for a vendored lang, its own language-label
    // wrapper -- see that function's comment), so copy-paste out of a fence still
    // yields the original text. `highlight` now hands back the fence's WHOLE
    // markup (`<pre><code>...`, not just what goes inside `<code>`), since the
    // label has to sit on a wrapper around `<pre>` and this is the one call site
    // that knows where the fence's markup begins and ends. No `highlight` (every
    // caller in test/check-pure.mjs, which tests this module in isolation): fall
    // back to plain escaped text, byte-for-byte what this branch has always
    // returned -- no label, since there is no highlighter here to decide whether
    // `lang` names a vendored grammar.
    if (highlight) return highlight(t.text, t.lang || '');
    return '<pre><code>' + esc(t.text) + '</code></pre>';
  }

  function renderTable(t) {
    const lines = t.raw.replace(/\n+$/, '').split('\n');
    const bodyLines = lines.slice(2, 2 + t.rows.length);
    let out = '<table><tr>';
    for (let i = 0; i < t.header.length; i++) {
      out += '<th' + alignAttr(t.align[i]) + '>' + renderCellText(lines[0], i) + '</th>';
    }
    out += '</tr>';
    for (let r = 0; r < t.rows.length; r++) {
      out += '<tr>';
      for (let c = 0; c < t.rows[r].length; c++) {
        out += '<td' + alignAttr(t.align[c]) + '>' + renderCellText(bodyLines[r] ?? '', c) + '</td>';
      }
      out += '</tr>';
    }
    return out + '</table>';

    function renderCellText(rowText, col) {
      const cells = splitTableRowCells(rowText);
      const text = cells[col] ?? '';
      return renderInline(Lexer.lexInline(text));
    }
  }
  const alignAttr = a => (a ? ' align="' + a + '"' : '');

  function renderList(listToken, quoted, listDepth) {
    const topLevel = !quoted && listDepth === 0;
    // A list that precedes every heading in the document still gets anchors,
    // unconditionally -- "one anchor per heading and per top-level list item" --
    // and a headingless source (a bare criteria list, the single most likely thing
    // to be posted for review) previously yielded ZERO anchors, so nothing in it
    // could be commented on at element level at all. SYNTHETIC_SECTION needs no
    // entry in usedSlugs -- slugify() strips underscores, so it can never collide
    // with a real heading's slug -- which keeps heading slug numbering
    // byte-identical to the pre-marked parser's (AC 10).
    if (topLevel && currentSlug === null) { currentSlug = SYNTHETIC_SECTION; liCounter = 0; }
    const tag = listToken.ordered ? 'ol' : 'ul';
    const start = listToken.ordered && listToken.start && listToken.start !== 1 ? ' start="' + listToken.start + '"' : '';
    let out = '<' + tag + start + '>';
    for (const item of listToken.items) out += renderListItem(item, quoted, topLevel, listDepth);
    return out + '</' + tag + '>';
  }

  function renderListItem(item, quoted, topLevel, listDepth) {
    // The ref is minted ONCE and reserved in usedSlugs, then used for both the id
    // attribute and the anchor entry -- computing it twice is what let a heading
    // slug and a list-item id collide (see reserveRef above).
    let ref = null;
    if (!quoted && topLevel && currentSlug) {
      liCounter++;
      ref = reserveRef(currentSlug + '-li' + liCounter, usedSlugs, slugOrdinals);
      anchors.push({ kind: 'md', ref, label: itemLabelText(item) });
    }
    let body = '';
    for (const t of item.tokens) {
      if (t.type === 'text') body += t.tokens ? renderInline(t.tokens) : esc(t.text);
      else if (t.type === 'checkbox') body += renderCheckbox(t);
      else body += renderBlockToken(t, quoted, listDepth + 1);
    }
    return '<li' + (ref ? ' id="' + escAttr(ref) + '"' : '') + '>' + body + '</li>';
  }

  const renderCheckbox = t => '<input type="checkbox" disabled' + (t.checked ? ' checked' : '') + '> ';

  /** The item's own label text (pre-inline-parse, raw source), for the anchor
   * entry -- NOT including a nested sub-list's text. Old code built this the same
   * way: the item line(s) themselves, joined, before any sub-list content. */
  function itemLabelText(item) {
    const t = item.tokens.find(x => x.type === 'text' || x.type === 'paragraph');
    return t ? t.text : (item.text || '');
  }

  // The top-level walk, hand-rolled rather than `renderBlocks(...)`, for one reason:
  // it also tracks where each top-level token STARTS. marked's tokens carry no source
  // position, but a block token's `raw` is the source text it consumed, and top-level
  // raws concatenate back into the document -- so an offset (and a line, since
  // counting newlines in each raw is the same total work) can be carried along beside
  // the render for free. That is the number src/resolve.mjs needs to slice a section
  // WITHOUT re-deriving headings with a second scanner of its own.
  //
  // "Concatenate back into the document" is checked, not assumed: the moment a raw
  // does not sit where the running offset says it does, line tracking stops and every
  // later heading is recorded with no line. A heading with no line is unresolvable as
  // a `section:` (a loud "not found"), never a heading resolved to the WRONG lines --
  // which is the failure mode the second scanner had, and the whole point of removing
  // it.
  const src = stripDocumentControls(normalizeNewlines(md));
  let html = '';
  let offset = 0;
  let line = 0;
  let aligned = true;
  for (const t of marked.lexer(src)) {
    if (aligned && !src.startsWith(t.raw, offset)) aligned = false;
    // Only a top-level HEADING token owns the current line: anything else may contain
    // a nested heading (a `- # x` list item does), which sits somewhere inside the
    // token rather than at its first line.
    topLevelLine = aligned && t.type === 'heading' ? line : null;
    html += renderBlockToken(t, false, 0);
    if (aligned) {
      offset += t.raw.length;
      line += countNewlines(t.raw);
    }
  }
  topLevelLine = null;
  return { html, anchors, headings };
}

/** Every heading in `md` that this module can place in the source, in document
 * order, beside the source lines those positions index into:
 * `{ lines, headings: [{ ref, level, line }] }` -- `ref` is the anchor slug, or
 * null for a heading that renders but mints no anchor (a setext one); `line` is
 * 0-based into `lines`.
 *
 * This exists so heading identity has exactly ONE owner. src/resolve.mjs's
 * `sliceSection` used to re-derive headings, fences and slugs from the raw file with
 * its own regexes, and the two scanners drifted in five measured ways (indented and
 * bare ATX, `~~~` and length-mismatched fences, phantom setext titles over indented
 * code / html blocks / link definitions, control bytes that only one side stripped
 * before slugifying, and multi-line setext titles shifting later ordinals). Every one
 * of those returned the WRONG section silently, which is a content-substitution
 * primitive: the agent asks for the slug the board displayed, and the reviewer is
 * shown a different region of the file. Re-deriving is the bug; there is no set of
 * regexes that stays in step with a real parser.
 *
 * `lines` comes back from here too, rather than being re-split by the caller, so the
 * line numbering and the lines themselves cannot disagree either (marked normalises
 * `\r\n` and a lone `\r` to `\n` before it counts anything, so the caller has to
 * index into the same normalisation, not into its own split of the raw bytes). */
export function scanHeadings(md) {
  return { lines: normalizeNewlines(md).split('\n'), headings: mdToHtmlAndAnchors(md).headings };
}

/** Render markdown to HTML only (drops the anchor list). Kept as the direct
 * promotion of the original `mdToHtml` for callers that don't need anchors.
 * `opts` passes straight through to mdToHtmlAndAnchors (see its own doc comment
 * for the `highlight` shape). */
export function mdToHtml(md, opts) {
  return mdToHtmlAndAnchors(md, opts).html;
}
