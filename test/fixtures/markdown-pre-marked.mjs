// GOLDEN REFERENCE, NOT PRODUCT CODE. This is `git show edb611b:src/markdown.mjs`
// verbatim (the hand-rolled line scanner src/markdown.mjs used before ADR 62
// vendored `marked`), kept here so SPEC_RENDERING.md AC 10 -- "heading and list-item
// slugs are byte-identical to today's slugify output, so every archived `section:`
// reference still resolves" -- can be asserted by RUNNING the old implementation
// against the new one on a shared corpus, rather than by hand-copied golden strings
// that drift the moment someone regenerates them from the current source.
//
// Checked in rather than read out of git at check time on purpose: `npm run check`
// must work from an exported source tree with no .git, and a `git show` in a check
// would make the suite depend on repository history being present.
//
// Nothing imports this outside test/check-pure.mjs, and nothing may: it is frozen at
// edb611b's bytes. If it ever needs to change, it is no longer a reference.
//
// --- edb611b:src/markdown.mjs, verbatim, from here down --------------------------
//
// Markdown -> HTML, promoted from the hand-rolled renderer in
// ~/.claude/skills/visualize/template.html (between the `/* md-render start */` and
// `/* md-render end */` markers) into a real ESM module that runs unchanged in node
// and the browser. Extended with anchor emission: every heading becomes an anchor at
// its slug, every top-level list item under that heading becomes `<slug>-liN`
// (1-based, numbered per heading section). See PROTOCOL.md "Anchors at headings and
// list items".
//
// Ceiling (inherited from the original): no reference-style links, no setext
// headings, loose lists render as separate lists, pipes inside cell code spans split
// cells. Upgrade path: vendor a full parser into this module.

/** Slugify heading text into an anchor id: lowercase, markdown syntax stripped,
 * non-alphanumerics collapsed to hyphens. Duplicate slugs get -2, -3, ... suffixes.
 * Exported (additive) so src/resolve.mjs can find the same heading a `section` ref
 * names using the identical algorithm that minted the anchor in the first place. */
/** Anchor prefix for top-level list items that precede every heading in a source.
 * Underscore is deliberate: `slugify` strips `_` (and every other non-alphanumeric)
 * before it ever reaches the output, so no heading can ever produce this string and
 * the synthetic prefix cannot shadow or be shadowed by a real section. */
export const SYNTHETIC_SECTION = '_body';

/** Reserve `base` in `used`, disambiguating with -2, -3, ... exactly as `slugify`
 * does. List-item refs go through this too: they used to be minted as a bare
 * `<slug>-liN` string that was never registered, so a later `## Risks li1` heading
 * could slugify to `risks-li1` — the same id a bullet under `## Risks` already
 * carried. Two elements then shared an id, and src/render.mjs's last-wins
 * `labelByRef` map labelled the reviewer's comment on the bullet with the heading's
 * text. Ids are the join key; they have to be unique across BOTH kinds of anchor. */
function reserveRef(base, used, ordinals) {
  return disambiguate(base, used, ordinals);
}

/** Append `-2`, `-3`, ... until `base` is free in `used`, then reserve it.
 *
 * `ordinals` is an optional `Map<base, nextOrdinalToTry>` carried alongside `used`
 * (N headings sharing one base cost O(N^2), because every call re-probed from
 * `-2`. 131072 headings — 512KiB of `# a`, i.e. the by-value cap — took 10.5 minutes
 * of a single-threaded daemon, and `src/resolve.mjs`'s independent pass the same).
 * Skipping ordinals already observed as taken is safe and output-identical: `used`
 * only ever grows within a pass, so a suffix seen taken can never come free again.
 * Omitting the map keeps the old linear probe, which is correct but quadratic. */
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

// --- linear scanners ----------------------------------------------------------
//
// Everything below runs server-side, single-threaded, on content resolved from
// arbitrary files (a table-separator probe took 63s on 400KB and ~7min on
// 1MB, blocking the whole daemon — health, every other board and every SSE stream
// with it). Two patterns were ambiguously quantified; both are replaced with
// index scans that cannot backtrack.

/** Is `row` a markdown table separator (`|---|:--:|`)? Replaces
 * `/^\s*\|?[\s|:-]+$/` + `.includes('-')`, whose `\s*` and `[\s|:-]+` overlap: on a
 * long whitespace-heavy line that fails the final `$`, the engine re-partitions the
 * split between them exponentially many ways. A character scan answers the same
 * question in one pass. */
function isTableSeparator(row) {
  let sawDash = false;
  for (let k = 0; k < row.length; k++) {
    const ch = row[k];
    if (ch === '-') { sawDash = true; continue; }
    if (ch === '|' || ch === ':' || ch === ' ' || ch === '\t') continue;
    return false;
  }
  return sawDash;
}

const isSpace = c => c === '' || /\s/.test(c);
const canOpenBefore = c => c === '' || /\s/.test(c) || c === '(';
const canCloseAfter = c => c === '' || /[\s).,;:!?]/.test(c);

/** Wrap `delim`-delimited runs in `<tag>`, with the module's existing rule that a
 * delimiter opens only after start/space/`(` and closes only before
 * end/space/punctuation — so intraword `_` (snake_case, MAP_AUTH.md) stays literal.
 *
 * Replaces `/(^|[\s(])__(?=\S)([\s\S]*?\S)__(?=$|[\s).,;:!?])/g` and its single-`_`
 * twin. The lazy `[\s\S]*?\S` is the classic quadratic shape (measured: 3.4s on
 * 256KB, ~54s on 1MB of underscore-heavy prose — reachable from ordinary content,
 * no crafting required). This scan is linear in one non-obvious step: when no legal
 * CLOSER exists after the first opener, none exists after any later opener either
 * (a later opener searches a strict suffix of the same space), so the whole rest of
 * the string is emitted verbatim instead of re-scanned per opener. */
function emphasize(s, delim, tag) {
  const dl = delim.length;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf(delim, i);
    if (open === -1) break;
    const before = open === 0 ? '' : s[open - 1];
    const afterOpen = s[open + dl] ?? '';
    if (!canOpenBefore(before) || isSpace(afterOpen)) {
      out += s.slice(i, open + dl);
      i = open + dl;
      continue;
    }
    let close = -1;
    for (let j = open + dl + 1; ;) {
      const k = s.indexOf(delim, j);
      if (k === -1) break;
      if (!isSpace(s[k - 1]) && canCloseAfter(s[k + dl] ?? '')) { close = k; break; }
      j = k + 1;
    }
    if (close === -1) break; // no closer anywhere ahead: nothing later can match either
    out += s.slice(i, open) + '<' + tag + '>' + s.slice(open + dl, close) + '</' + tag + '>';
    i = close + dl;
  }
  return out + s.slice(i);
}

// C0 controls (and DEL) are stripped from a URL before its scheme is tested and
// before it is emitted. The scheme regex only matches at offset 0 and JS
// `\s` does not cover \x01-\x08 / \x0e-\x1f, while the URL capture `[^)\s]+`
// happily admits them — so `[x](\x01javascript:alert(1))` sailed past the
// allowlist. It is not cosmetic: the HTML tokenizer keeps U+0001 inside the
// attribute value, but the WHATWG URL parser strips leading C0 controls before
// reading the scheme, so the browser really does navigate to `javascript:` and
// execute at the daemon's origin. Markdown blocks are snapshotted from arbitrary
// files, which is the exact threat the allowlist exists for. Stripping (rather
// than just testing the stripped form) also matters: the emitted href must be the
// string that was vetted, not the raw one.
const stripUrlControls = u => String(u).replace(/[\x00-\x1f\x7f]+/g, '');

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

/**
 * Render markdown to HTML and extract anchors.
 * @param {string} md
 * @returns {{ html: string, anchors: Array<{kind: 'md', ref: string, label: string}> }}
 */
export function mdToHtmlAndAnchors(md) {
  const codes = [];
  const stash = h => '\x00' + (codes.push(h) - 1) + '\x00';
  // esc() runs once over the whole raw markdown before any block/inline parsing (see
  // `blocks(esc(md))` below), so every text fragment handled downstream already has
  // &, < and > turned into entities -- sufficient for HTML *text* content. Attribute
  // values (alt, src, href, and the heading/list-item id) are a different context:
  // an unescaped " or ' there lets crafted content break out of the attribute and
  // inject a live handler, e.g. `![" onerror=alert(1) x="](y.png)`. escAttr adds
  // quote-escaping on top of the &/</> escaping esc() already did -- it must not
  // redo &/</> itself, or it would double-escape (&amp; -> &amp;amp;).
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // Exact inverse of esc(), for the two places that need the PRE-escape source text
  // back: the anchor slug and the anchor label.
  //
  // The slug: src/resolve.mjs slugifies the RAW heading line off disk, so
  // if this module slugified the escaped text the two would disagree -- `## Risk &
  // Reward` minted the anchor `risk-amp-reward` while `section: 'risk-reward'` was
  // the only thing that resolved, i.e. the only slug the agent was ever shown for
  // that heading was the one guaranteed to fail next round.
  //
  // The label: every consumer (src/render.mjs's escHtml/escAttr,
  // src/ui.mjs's comment list) escapes the label at emit time, so carrying an
  // already-escaped label double-escaped it and `Risk & Reward` reached the packet
  // and the page as `Risk &amp; Reward`.
  //
  // Order matters and is the reverse of esc()'s: &lt;/&gt; first, &amp; last, so an
  // author's literal `&amp;` (escaped to `&amp;amp;`) comes back as `&amp;` rather
  // than collapsing a step too far to `&`.
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Only http(s), mailto, and schemeless (relative/fragment/protocol-relative) URLs
  // render as a live href/src; javascript:, data:, vbscript: and any other scheme
  // are neutralised. Markdown blocks are resolved by reference from arbitrary files
  // on disk -- the reviewer did not necessarily write or vet the URL, so a crafted
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
  const inline = s => {
    // Order is load-bearing: code spans and links are stashed out of the way first,
    // emphasis runs over what is left, and the stashes are restored last -- so an
    // underscore inside `ssn_country` or inside a URL is never emphasis input.
    let t = s
      .replace(/`([^`]+)`/g, (m, c) => stash('<code>' + c + '</code>'))
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => stash('<img alt="' + escAttr(a) + '" src="' + escAttr(safeUrl(u)) + '">'))
      // Every link leaves in a new tab. A board is a thing the reviewer is in the middle
      // of -- unsubmitted answers, comments half typed -- and a same-tab navigation
      // discards all of it with no warning and no way back to the draft. `noopener`
      // comes with `_blank` in modern browsers, but is spelled out because the reason it
      // is wanted here is specific: the opened document must not hold a live
      // `window.opener` handle back into a page that is authorized against the daemon.
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t2, u) => stash('<a href="' + escAttr(safeUrl(u) || '#') + '" target="_blank" rel="noopener noreferrer">' + t2 + '</a>'))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // underscore emphasis opens only after start/space/( and closes only before
    // end/space/punctuation, so intraword _ (snake_case, MAP_AUTH.md) stays literal
    t = emphasize(t, '__', 'strong');
    t = emphasize(t, '_', 'em');
    return t.replace(/\x00(\d+)\x00/g, (m, i) => codes[i]);
  };

  const anchors = [];
  const usedSlugs = new Set();
  // Carried beside usedSlugs so duplicate-slug disambiguation stays O(1) amortised;
  // see disambiguate() above. Must be shared by the heading and list-item passes,
  // because they disambiguate against the same set.
  const slugOrdinals = new Map();
  let currentSlug = null;
  let liCounter = 0;

  /** `quoted` is set for the blockquote recursion: a quoted heading or
   * bullet is somebody ELSE's document being cited, so it must not mint an anchor,
   * must not carry an id, and must not consume a slug or a `-liN` ordinal. It used
   * to: a source quoting `> ## Plan` above its own `## Plan` gave the quotation the
   * `plan` anchor and the real heading `plan-2`, so `section: 'plan-2'` errored in
   * src/resolve.mjs (which sees no blockquotes at all) while `section: 'plan'`
   * returned the real body under an id pointing at the quotation. */
  const blocks = (text, quoted = false) => {
    // A trailing CR is stripped per line rather than left for the block regexes to
    // trip over: `.` and `$` do not match `\r`, so `- a\r` passed the list
    // guard, failed the item pattern, matched no continuation, and broke out of the
    // item loop WITHOUT advancing `i` -- an infinite loop that pinned a core and took
    // the whole daemon with it, on nothing more exotic than a CRLF file in the
    // project. `## Plan\r` separately yielded zero anchors. src/resolve.mjs does the
    // same, so the two heading passes stay byte-identical.
    const lines = text.split('\n').map(s => (s.endsWith('\r') ? s.slice(0, -1) : s));
    let html = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      if (/^```/.test(l.trim())) {
        const lang = l.trim().slice(3).trim();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
        i++;
        html += lang === 'mermaid'
          ? '<pre class="mermaid">' + buf.join('\n') + '</pre>'
          : '<pre><code>' + buf.join('\n') + '</code></pre>';
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const escapedText = h[2];       // post-esc(): what the HTML body is built from
        const sourceText = unesc(escapedText); // pre-esc(): what the slug and label come from
        if (quoted) {
          html += '<h' + level + '>' + inline(escapedText) + '</h' + level + '>';
          i++;
          continue;
        }
        const slug = slugify(sourceText, usedSlugs, slugOrdinals);
        currentSlug = slug;
        liCounter = 0;
        anchors.push({ kind: 'md', ref: slug, label: sourceText });
        html += '<h' + level + ' id="' + escAttr(slug) + '">' + inline(escapedText) + '</h' + level + '>';
        i++;
        continue;
      }
      if (/^\s*&gt;/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
        html += '<blockquote>' + blocks(buf.join('\n'), true) + '</blockquote>'; continue;
      }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
        html += '<table><tr>' + cells(l).map(c => '<th>' + c + '</th>').join('') + '</tr>';
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          html += '<tr>' + cells(lines[i++]).map(c => '<td>' + c + '</td>').join('') + '</tr>';
        }
        html += '</table>'; continue;
      }
      if (/^\s*-{3,}\s*$/.test(l)) { html += '<hr>'; i++; continue; }
      if (/^(\s*)([-*+]|\d+\.)\s+/.test(l)) {
        // A list that precedes every heading in the document still gets anchors,
        // unconditionally --
        // "one anchor per heading and per top-level list item" -- and a headingless
        // source (a bare criteria list, the single most likely thing to be posted
        // for review) previously yielded ZERO anchors, so nothing in it could be
        // commented on at element level at all. `_body` is the synthetic section
        // prefix: slugify() strips underscores, so it can never collide with a real
        // heading's slug, and it therefore needs no entry in usedSlugs -- which
        // keeps heading slug numbering byte-identical to src/resolve.mjs's
        // independent pass over the same file.
        if (!quoted && currentSlug === null) {
          currentSlug = SYNTHETIC_SECTION;
          liCounter = 0;
        }
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (m) { items.push({ ind: m[1].length, ord: /\d/.test(m[2]), text: m[3] }); i++; }
          else if (items.length && /^\s+\S/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i++].trim(); }
          else break;
        }
        // Unconditional progress. The guard above and the item pattern here disagree
        // for any line the guard admits but `(.*)$` rejects -- a stray CR (now
        // normalised away) or a U+2028/U+2029 line separator, which `.` also refuses.
        // Without this the loop re-enters on the same `i` forever; rendering the line
        // as a paragraph is both terminating and closer to what it looks like.
        if (!items.length) { html += '<p>' + inline(l) + '</p>'; i++; continue; }
        let out = ''; const stack = [];
        for (const it of items) {
          let topLevel;
          let openTag;
          if (!stack.length || it.ind > stack[stack.length - 1].ind) {
            const tag = it.ord ? 'ol' : 'ul';
            stack.push({ ind: it.ind, tag });
            topLevel = stack.length === 1;
            openTag = '<' + tag + '><li';
          } else {
            while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) out += '</li></' + stack.pop().tag + '>';
            topLevel = stack.length === 1;
            openTag = '</li><li';
          }
          // The ref is minted ONCE and reserved in usedSlugs, then used for both the
          // id attribute and the anchor entry -- computing it twice is what let a
          // heading slug and a list-item id collide (see reserveRef above).
          let ref = null;
          if (!quoted && topLevel && currentSlug) {
            liCounter++;
            ref = reserveRef(currentSlug + '-li' + liCounter, usedSlugs, slugOrdinals);
            // label from the PRE-escape source text, same as the heading above
            anchors.push({ kind: 'md', ref, label: unesc(it.text) });
          }
          out += openTag + (ref ? ' id="' + escAttr(ref) + '"' : '') + '>' + inline(it.text);
        }
        while (stack.length) out += '</li></' + stack.pop().tag + '>';
        html += out; continue;
      }
      const buf = [l]; i++;
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#{1,6}\s|```|&gt;|[-*+]\s|\d+\.\s|\||-{3,}\s*$)/.test(lines[i])) buf.push(lines[i++]);
      html += '<p>' + inline(buf.join(' ')) + '</p>';
    }
    return html;
  };

  const html = blocks(esc(md));
  return { html, anchors };
}

/** Render markdown to HTML only (drops the anchor list). Kept as the direct
 * promotion of the original `mdToHtml` for callers that don't need anchors. */
export function mdToHtml(md) {
  return mdToHtmlAndAnchors(md).html;
}
