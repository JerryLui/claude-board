// SPEC_HEADER.md ticket 03: an ordinary board's header condenses into the same
// pill a page board's already does (AC 7), and doing so never reflows the
// column underneath it (AC 8). test/check-page-board.mjs already covers the
// page-board half of this mechanism ("criterion 16" there); this file covers
// the ordinary-board half, driven off this document's own scroll instead of a
// stage's postMessage'd one.
//
// WHAT NO CHECK HERE CAN PROVE. test/dom-stand-in.mjs has no layout engine
// (QUIRKS.md, "the stand-in has no layout"), so AC 8 -- "the column's scroll
// position and layout are unchanged" -- cannot be measured as a pixel fact.
// What IS provable at this level, and what every AC-8 check below does prove,
// is the STRUCTURAL fact that makes it true in a real browser regardless: no
// rule this ticket adds ever makes a height-affecting property (padding,
// margin, height/min-height/max-height) on '.board-head' or its children a
// function of '--stage-p'. A sticky element whose own box never changes size
// cannot reflow anything below it, in any browser, by construction.

import assert from 'node:assert/strict';
import { createBoard } from '../src/board.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { ui } from '../src/ui.mjs';
import { styles } from '../src/styles.mjs';
import { PILL_READONLY_TITLE, ROUND_OPEN_UNAWAITED_TITLE } from '../src/badge.mjs';
import { parseHTML, StandInEvent, resolveComputedProperty } from './dom-stand-in.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

// Two blocks (or any non-single-html shape) is deliberately NOT a page board
// (src/render.mjs's isPageBoard, ADR.md entry 33) -- this file's whole subject
// is the board type that scrolls its own document.
function ordinaryBoard() {
  return createBoard({
    title: 'An ordinary board',
    blocks: [{ kind: 'markdown', text: 'first block' }, { kind: 'markdown', text: 'second block' }],
  });
}

function loadBoard(pageHtml, protocol = 'http:') {
  const document = parseHTML(pageHtml);
  const window = document.defaultView;
  const location = { protocol };
  new Function('document', 'window', 'location', ui)(document, window, location);
  return document;
}

/** Drives the mechanism this file exists to check: sets the document's own
 * scroll offset and fires the 'scroll' event a real browser would, on the
 * SAME window refreshDocumentScrollChrome (src/ui.mjs) listens on -- never a
 * stage postMessage, which is test/check-page-board.mjs's own channel and a
 * deliberately different one (see the "malformed scroll report" check
 * there: an ordinary board's own embedded stage reporting scroll must NOT
 * condense this header, only the document's own scroll may). */
function scrollDocumentTo(document, top) {
  const window = document.defaultView;
  window.pageYOffset = top;
  window.dispatchEvent(new StandInEvent('scroll'));
}

const condensed = (document) => document.body.classList.contains('stage-scrolled');
const progress = (document) => document.body.style.getPropertyValue('--stage-p');
const computed = (el, prop) => resolveComputedProperty(styles, el, true, prop);

// =================================================================================
// AC 7: the header condenses on document scroll, into the same pill.
// =================================================================================

check('AC 7: an ordinary board is not a page board, and starts expanded', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));
  assert.equal(document.body.classList.contains('page-board'), false, 'setup: two blocks is an ordinary board');
  assert.equal(condensed(document), false, 'an unscrolled document leaves the header expanded');
  assert.equal(progress(document), '0.000', 'and the initial progress is written, not merely defaulted by the stylesheet');
});

check('AC 7: scrolling the document condenses the header into a pill, and scrolling back expands it', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));
  const head = document.querySelector('.board-head');
  const ident = document.querySelector('.board-head-ident');

  scrollDocumentTo(document, 800);
  assert.equal(condensed(document), true);
  assert.equal(progress(document), '1.000', 'well past the ramp, the condense is complete');
  assert.match(computed(head, 'padding-inline'), /--stage-p/, 'the controls walk into the band on the same progress a page board\'s pill does');
  assert.equal(computed(head, 'background'), 'none', 'the expanded wash moves to its own layer so it can fade, same split as the page board\'s');
  assert.match(computed(ident, 'max-width'), /--stage-p/, 'the identity text collapses on the progress rather than being switched off');
  assert.notEqual(computed(ident, 'display'), 'none', 'and collapses by width, not by display');

  scrollDocumentTo(document, 0);
  assert.equal(condensed(document), false, 'scrolling back to the top expands it again');
  assert.equal(progress(document), '0.000', 'and the progress genuinely returns to zero');
});

check('AC 7: the condense is a ramp with no threshold, exactly like the page board\'s', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));

  scrollDocumentTo(document, 70);
  const mid = Number(progress(document));
  assert.ok(mid > 0 && mid < 1, `a half-scrolled document is half condensed, got ${mid}`);
  assert.equal(condensed(document), true, 'and it counts as reading from the first pixel');

  const seen = [35, 70, 105, 140].map((top) => {
    scrollDocumentTo(document, top);
    return Number(progress(document));
  });
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress only ever increases with the scroll offset');
  assert.equal(new Set(seen).size, seen.length, 'and each offset maps to its own value');
  assert.equal(seen[seen.length - 1], 1, 'the ramp completes exactly at the condense distance');

  scrollDocumentTo(document, 100000);
  assert.equal(progress(document), '1.000', 'a long document cannot push the progress past 1');
});

check('AC 7: the pill holds mark, comment toggle, theme, then the state label -- the expanded header\'s own order', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));
  const head = document.querySelector('.board-head');
  const titleGroup = document.querySelector('.board-head-title');
  const actions = document.querySelector('.board-head-actions');

  assert.equal(head.children[0], titleGroup, 'setup: the mark/identity group leads the header');
  assert.equal(head.children[1], actions, 'setup: the actions group follows it');
  assert.ok(titleGroup.children[0].classList.contains('back-to-index'), 'the mark is the first thing in that group');
  assert.deepEqual(actions.children.map((c) => c.id), ['comment-mode-toggle', 'theme-toggle', 'round-meta'],
    'comment toggle, theme, state label -- ADR.md entry 61\'s order, with no round badge back between theme and the label');

  scrollDocumentTo(document, 800);
  assert.equal(condensed(document), true, 'setup: condensed');
  assert.equal(computed(document.querySelector('button#comment-mode-toggle'), 'display'), 'inline-flex',
    'condensing hides the header\'s identity text, never its controls');
  assert.equal(computed(document.querySelector('button#theme-toggle'), 'display'), 'inline-flex');
});

check('AC 7: the state label shows on an ordinary board too -- the countdown while awaited, read-only otherwise', () => {
  const awaited = createBoard({
    title: 'awaited',
    blocks: [{ kind: 'markdown', text: 'a' }, { kind: 'question', text: 'q?', widget: 'text' }],
    wait: true,
  });
  const document = loadBoard(renderBoardPage(awaited));
  const meta = document.querySelector('span#round-meta');
  assert.ok(meta, 'setup: every board renders the slot (src/render.mjs)');
  assert.equal(computed(meta, 'display'), 'inline', 'AC 7: visible on an ordinary board, not just a page board');

  const notAwaited = loadBoard(renderBoardPage(ordinaryBoard()));
  const meta2 = notAwaited.querySelector('span#round-meta');
  assert.equal(computed(meta2, 'display'), 'inline');
  assert.equal(meta2.textContent, 'read-only', 'src/render.mjs\'s own deterministic fallback, unchanged by this ticket -- AC 13 pins this word');
  // The WORD stays 'read-only' by the PM's own call (AC 13), but the hover
  // title underneath it must not repeat PILL_READONLY_TITLE's "commenting is
  // off": ordinaryBoard() is a plain, un-awaited board whose one open round
  // has an ENABLED send bar the whole time (src/ui.mjs's setSendBarEnabled
  // reads status/openRoundNumber, never awaited) -- a comment left there is
  // drained to whichever agent asks next (drainUndeliveredComments,
  // src/server.mjs), so "commenting is off" is simply false on this surface.
  // A regression back to PILL_READONLY_TITLE here is exactly what this
  // assertion exists to catch.
  assert.equal(meta2.title, ROUND_OPEN_UNAWAITED_TITLE,
    'an ordinary board\'s open, unawaited round must not claim commenting is off directly above a live Send button');
  assert.notEqual(meta2.title, PILL_READONLY_TITLE,
    'the page-board-only title must not leak onto an ordinary board\'s live round');
});

check('AC 7: the condensed pill reuses the page board\'s own chrome tokens, pinned as a fact about the stylesheet', () => {
  // resolveComputedProperty never matches a pseudo-element (dom-stand-in.mjs:
  // "an unrecognised token (:hover, ::before, ...): never matches"), so the
  // pill's own chrome -- drawn on a '::before' -- can only be pinned by
  // reading the stylesheet's own text, the same shape
  // test/check-page-board.mjs uses for '.round-meta:empty'.
  const ordinaryPill = styles.match(/body:not\(\.page-board\) \.board-head::before \{([^}]*)\}/s);
  const pageBoardPill = styles.match(/body\.page-board \.board-head::before \{([^}]*)\}/s);
  assert.ok(ordinaryPill, 'setup: the ordinary-board pill rule exists');
  assert.ok(pageBoardPill, 'setup: the page-board pill rule exists');
  for (const token of ['var(--panel)', 'var(--hairline)', 'var(--r-lg)', 'var(--shadow-2)']) {
    assert.ok(pageBoardPill[1].includes(token), `setup: the page board's own pill declares ${token}`);
    assert.ok(ordinaryPill[1].includes(token), `the ordinary board's pill must declare the identical token ${token}`);
  }
  assert.match(ordinaryPill[1], /opacity: var\(--stage-p\)/, 'and fades in on the same progress');
});

check('AC 7: the pill panel is centred on the CONTROL ROW, not on .board-head\'s own (asymmetrically padded) box', () => {
  // Coordinator review (2026-08-09), measured live in Chrome against
  // examples/sample-board.html: a first attempt ('top: 50%; height: 42px;
  // transform: translateY(-50%)') drew the panel 40.18px-82.18px down an
  // 80.376px box, 3.6px past its own bottom edge, with every control sitting
  // mostly or entirely above it. This is why: neither this check's own
  // resolveComputedProperty (via dom-stand-in.mjs) nor the coordinator's own
  // tooling runs layout, so 'transform' -- a paint-only shift -- can never be
  // asserted into the position it is supposed to produce. The fix drops it:
  // 'top'/'bottom' set together (no 'height', no 'transform') fixes the
  // panel's height AND position from two declarations neither of which
  // depends on anything but the CSS box model, provably checkable here.
  const ordinaryPill = styles.match(/body:not\(\.page-board\) \.board-head::before \{([^}]*)\}/s);
  assert.ok(ordinaryPill, 'setup: the ordinary-board pill rule exists');
  assert.doesNotMatch(ordinaryPill[1], /\bheight\s*:/,
    'a declared height plus top/bottom would overconstrain the box -- the panel\'s height must come from the gap between top and bottom alone');
  assert.doesNotMatch(ordinaryPill[1], /\btransform\s*:/,
    'transform is paint-only and invisible to computed-style position -- reintroducing it here reintroduces exactly the bug this check exists to catch');

  // '.board-head''s own padding is what the pill's centreline has to answer
  // to (flex 'align-items: center' centres each child on the padding box,
  // not the border box), so the two rules are read together: whichever
  // tokens the header ACTUALLY uses for top/bottom padding must be the same
  // two tokens the pill's own top/bottom formula subtracts against, or a
  // future change to one drifts silently out of step with the other.
  const headBase = styles.match(/\n\.board-head \{([^}]*)\}/s);
  assert.ok(headBase, 'setup: the base .board-head rule exists');
  const paddingDecl = headBase[1].match(/padding:\s*([^;]+);/);
  assert.ok(paddingDecl, 'setup: .board-head declares a padding shorthand');
  const [top, , bottom] = paddingDecl[1].trim().split(/\s+/);
  assert.ok(top && bottom, `setup: could not read a 3-value padding shorthand from '${paddingDecl[1]}'`);

  const topDecl = ordinaryPill[1].match(/(?:^|\s)top:\s*([^;]+);/);
  const bottomDecl = ordinaryPill[1].match(/(?:^|\s)bottom:\s*([^;]+);/);
  assert.ok(topDecl && bottomDecl, 'setup: the pill declares both top and bottom');
  assert.ok(topDecl[1].includes(top) && topDecl[1].includes(bottom),
    `the pill's 'top' must be expressed against the SAME padding tokens .board-head itself uses (${top}, ${bottom}), got '${topDecl[1]}'`);
  assert.ok(bottomDecl[1].includes(top) && bottomDecl[1].includes(bottom),
    `the pill's 'bottom' must be expressed against the same tokens too, got '${bottomDecl[1]}'`);

  // The structural proof itself: 'top' and 'bottom' must be exact mirror
  // images of each other -- the SAME token-difference term, with the sign
  // immediately in front of it flipped (never the token order within it,
  // which is a different, wrong kind of "mirror": '(a - b)' negated is
  // '-(a - b)', not '(b - a)' restated with a '+' -- they're equal in value
  // but this check is pinning the SOURCE TEXT, which is what a future editor
  // actually reads and edits). That symmetry is what fixes the panel's total
  // height at a constant regardless of '.board-head''s own height, AND
  // centres it on the padding-corrected centreline, in one property pair.
  // Whitespace-normalised so reformatting the rule can't defeat this by
  // accident.
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const diffTerm = `(${top} - ${bottom})`;
  assert.ok(norm(topDecl[1]).includes(`+ ${diffTerm}`), `setup: expected top to add '${diffTerm}', got '${topDecl[1]}'`);
  const mirrored = norm(topDecl[1]).replace(`+ ${diffTerm}`, `- ${diffTerm}`);
  assert.notEqual(norm(topDecl[1]), mirrored, 'setup: the mirroring substitution above must actually change something');
  assert.equal(norm(bottomDecl[1]), mirrored,
    `'bottom' must be 'top' with the token-difference term's leading sign flipped -- got top='${topDecl[1]}', bottom='${bottomDecl[1]}'`);
});

check('AC 7: the header\'s own padding-inline leaves the pill\'s intended air where the pill is, not a hole between the mark and the actions', () => {
  // Coordinator review (2026-08-09), measured live in Chrome against
  // examples/sample-board.html: without the '+ var(--space-3)' term below,
  // '.board-head''s padding-inline at full condense pulls the content in to
  // EXACTLY '2 * --pill-half' -- the same width the panel itself is drawn
  // at (its own 'inset-inline' below, unchanged) -- so 'justify-content:
  // space-between' (the base '.board-head' rule, untouched by this file) has
  // nowhere to put pill-half's own baked-in slack (measurePillHalf,
  // src/ui.mjs: 'half = (brand + gap + actions) / 2 + pad') except the one
  // gap it controls, between the mark and the actions row: a 24px hole dead
  // centre in the pill, the mark flush on its left border and the state
  // label flush on its right. Adding '--space-3' shrinks the padding (and so
  // the content width) by that same amount, undoing pill-half's '+ pad' term
  // and pulling the content tight against itself -- leaving the panel's
  // unchanged extra width to sit as symmetric air on both edges instead.
  const headRule = styles.match(/body:not\(\.page-board\) \.board-head \{([^}]*)\}/s);
  const pillRule = styles.match(/body:not\(\.page-board\) \.board-head::before \{([^}]*)\}/s);
  assert.ok(headRule && pillRule, 'setup: both rules exist');
  const paddingInline = headRule[1].match(/padding-inline:\s*([^;]+);/);
  const insetInline = pillRule[1].match(/inset-inline:\s*([^;]+);/);
  assert.ok(paddingInline && insetInline, 'setup: both declare an inline inset expression');
  assert.match(paddingInline[1], /\+\s*var\(--space-3\)/,
    'the header\'s own padding-inline must add var(--space-3) back on top of (50% - --pill-half), or the content tightens to exactly the panel\'s own width with nowhere for the pill-half slack to go but the middle gap');
  assert.doesNotMatch(insetInline[1], /var\(--space-3\)/,
    'the PANEL\'s own inset-inline must stay exactly (50% - --pill-half) -- widening it too would just move the hole rather than close it, since it is the DIFFERENCE between the two that has to shrink to zero');
});

check('AC 7: below the 560px breakpoint the condense is suppressed outright, not drawn undersized', () => {
  // Coordinator review (2026-08-09), measured live in Chrome against
  // examples/sample-board.html: '--pill-half' is measured as a SINGLE-ROW sum
  // (measurePillHalf, src/ui.mjs: brand + columnGap + actions), which
  // describes nothing once '.board-head' becomes a column here (the rule two
  // lines above this one) -- the actions row hugged the pill's left border
  // with ~60px of empty pill to its right, behind a 42px band drawn across
  // the middle of a two-row header with the mark above it and the state
  // label below it, neither one inside the band. Rather than teach the pill a
  // second, column-aware shape nobody asked for, the condense is switched off
  // entirely below this breakpoint: the header renders exactly as it always
  // has, at every scroll offset.
  const narrow = styles.match(/@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/);
  assert.ok(narrow, 'setup: the narrow-viewport media block exists');
  assert.match(narrow[1], /(?<!:not\(\.page-board\)\s)\bbody\s*\{\s*--stage-p:\s*0\s*!important;\s*\}/,
    'the condense must be pinned OFF (not merely undersized) below 560px, and with !important -- refreshDocumentScrollChrome (src/ui.mjs) writes --stage-p as an INLINE style, which outranks a plain stylesheet rule of any specificity');
  // Unscoped 'body' on purpose: a page board's pill is the same arithmetic off
  // the same single-row '--pill-half', and nothing exempts it from the
  // 'flex-direction: column' rule in this block, so it breaks here the same
  // way. An earlier pass wrote 'body:not(.page-board)' to keep its own ticket
  // small; that left the identical defect live on the other board kind.
  assert.doesNotMatch(narrow[1], /:not\(\.page-board\)\s*\{\s*--stage-p:\s*0\s*!important/,
    'the suppression must NOT exempt page boards -- their pill breaks below 560px in exactly the way an ordinary board\'s did');

  // Pinning '--stage-p' only neutralises what actually READS it. The pill's
  // own top/bottom (the previous check) are deliberately NOT a function of
  // '--stage-p' -- they hold the panel centred on the control row at every
  // progress, including 0 -- so what makes an unwanted position harmless at
  // rest is that the panel is fully TRANSPARENT there: opacity is what has
  // to depend on '--stage-p', and padding-inline is what has to stop
  // indenting the content, or a pinned-invisible panel would still leave the
  // header looking condensed. Both are asserted directly against the two
  // rules, not inferred.
  const headRule = styles.match(/body:not\(\.page-board\) \.board-head \{([^}]*)\}/s);
  const pillRule = styles.match(/body:not\(\.page-board\) \.board-head::before \{([^}]*)\}/s);
  assert.ok(headRule && pillRule, 'setup: both rules exist');
  assert.match(headRule[1], /padding-inline:\s*calc\(var\(--stage-p\)/,
    'the header\'s own padding-inline must be driven by --stage-p, or pinning it to 0 below the breakpoint would not stop the content from indenting');
  assert.match(pillRule[1], /opacity:\s*var\(--stage-p\)/,
    'the panel\'s own opacity must be driven by --stage-p, or pinning it to 0 below the breakpoint would leave a mispositioned panel visible instead of invisible');
});

check('AC 7: the header\'s wash reaches the real viewport edges, not the 1120px column, and never with a raw vw unit', () => {
  // PM review of a real screenshot (2026-08-09), the expanded (--stage-p: 0)
  // state, separate from the pill: 'inset: 0' on '.board-head::after' sizes
  // the wash to '.board-head''s OWN box -- the 1120px column, since this
  // header is 'position: sticky' inside it, unlike a page board's, which is
  // full-bleed by construction (position: fixed, no document scrollbar at
  // all). A wash confined to the column reads as a rounded blur-plus-gradient
  // rectangle with a visible seam where it meets the plain page background
  // outside it.
  //
  // 'vw' is the obvious escape and the wrong one FOR THIS RULE SPECIFICALLY:
  // an ordinary board is exactly the one surface that always has a real
  // document scrollbar, and 'vw' units include the scrollbar's own width --
  // '100vw' overflows the true visible width by however wide the scrollbar
  // is, trading the seam for an induced horizontal scrollbar. (Not a
  // blanket ban on 'vw' anywhere in the ordinary-board block: the identity
  // block's own 'max-width: calc((1 - --stage-p) * 60vw)' a few rules below
  // is a bounded text-width constraint, not a full-bleed positioning trick,
  // and carries no scrollbar risk -- QUIRKS.md's own "the stand-in has no
  // layout" is why the wash's OWN rule is what gets pinned as a fact about
  // the source, never measured: there is no scrollbar-vs-viewport
  // distinction for a stand-in with no layout to draw.)
  const washRule = styles.match(/body:not\(\.page-board\) \.board-head::after \{\s*top: 0;([^}]*)\}/s);
  assert.ok(washRule, 'setup: the ordinary-board wash rule exists (matched past the shared content/position/z-index rule of the same selector)');
  assert.doesNotMatch(washRule[1], /\d+vw\b/, 'the wash\'s own rule must not use a vw unit -- see this check\'s own comment for why');
  assert.doesNotMatch(washRule[1], /inset:\s*0/, 'the wash must not reuse the page-board rule\'s "inset: 0" -- that sizes to .board-head\'s own (column-width) box, exactly the defect this check exists to catch');
  assert.match(washRule[1], /width:\s*var\(--doc-w/,
    'the wash\'s width must be the MEASURED viewport width (measureDocWidth, src/ui.mjs -- document.documentElement.clientWidth, which excludes the scrollbar), not a vw unit or the column\'s own 100%');
  assert.match(washRule[1], /left:\s*50%/,
    'centred on .board-head\'s own 50% -- which is also the viewport\'s own centre, since .board-shell (margin: 0 auto) centres the column at every width');
  assert.match(washRule[1], /transform:\s*translateX\(-50%\)/,
    'the box is shifted left by half of ITS OWN (measured, full-viewport) width, not the column\'s -- this is what actually reaches both real edges');
});

// WHAT NO CHECK HERE CAN PROVE. That the panel geometrically CONTAINS the
// mark and the actions row at a real width, and that the narrow-viewport
// override actually neutralises the ramp rather than merely resolving to a
// harmless-looking value -- both are real layout facts
// (getBoundingClientRect, matchMedia against an actual viewport), and
// test/dom-stand-in.mjs models neither (QUIRKS.md, "the stand-in has no
// layout"). Both were confirmed live in Chrome against
// examples/sample-board.html's ordinary-board round (round 2): containment at
// 1324px (mark and the state label both inside the panel's measured rect,
// ~6-12px of air on every edge) and at the content width the 1120px column
// caps out at; the narrow-viewport suppression by applying the media block's
// own declarations directly (this environment's viewport could not be
// resized below its own floor) and confirming '--stage-p' resolves to '0'
// and the pill's opacity to '0' under them, with a screenshot showing the
// plain, uncondensed, two-row header and no pill artifact. AC 8 (the header's
// own height never moving) was reconfirmed live across a full scroll cycle
// on the fixed geometry too. TICKETS_HEADER.md's own log for this ticket
// records the exact numbers.

// =================================================================================
// AC 8: condensing an ordinary board never moves its content.
// =================================================================================

check('AC 8: nothing that changes the header\'s own box height is ever a function of --stage-p', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));
  const head = document.querySelector('.board-head');
  const ident = document.querySelector('.board-head-ident');

  // Captured before AND after a full condense: if any of these differed, the
  // sticky box would have changed size mid-scroll -- exactly the reflow AC 8
  // forbids, since a sticky element's own box stays part of flow at every
  // scroll offset.
  const before = {
    padding: computed(head, 'padding'),
    marginTop: computed(head, 'margin-top'),
    marginBottom: computed(head, 'margin-bottom'),
    identMaxHeight: computed(ident, 'max-height'),
  };
  scrollDocumentTo(document, 800);
  assert.equal(progress(document), '1.000', 'setup: fully condensed');
  const after = {
    padding: computed(head, 'padding'),
    marginTop: computed(head, 'margin-top'),
    marginBottom: computed(head, 'margin-bottom'),
    identMaxHeight: computed(ident, 'max-height'),
  };
  assert.deepEqual(after, before, 'every height-affecting property must resolve identically expanded and condensed');

  // The stronger, structural half: none of them may even REFERENCE the
  // progress variable, for either board type's own rule -- resolving to the
  // same literal value at two sampled progresses is consistent with an
  // invariant, but doesn't rule out a formula that merely returns to the same
  // number at 0 and 1 (a page board's own padding-block does exactly that
  // shape of thing over other properties). Contrast this directly with
  // test/check-page-board.mjs's own "the collapsed identity block gives up
  // its height as well as its width" check, which asserts the OPPOSITE for
  // '.board-head-ident' on a page board -- the difference is the whole point
  // of AC 8.
  assert.doesNotMatch(before.padding, /--stage-p/);
  assert.doesNotMatch(before.marginTop, /--stage-p/);
  assert.doesNotMatch(before.marginBottom, /--stage-p/);
  assert.doesNotMatch(before.identMaxHeight, /--stage-p/,
    'an ordinary board\'s identity block must keep its own height across the whole ramp -- collapsing it, as the page board does, is what would reflow the column');
  assert.equal(before.identMaxHeight, '', 'no rule sets it at all for this board type, which is the stronger form of "constant"');
});

check('AC 8: the rules that actually stay IN FLOW never declare a height-affecting property at all', () => {
  // A structural scan over the stylesheet's own text (QUIRKS.md, "the stand-in
  // has no layout" -- the technique test/check-round-pager.mjs uses for its own
  // "DISABLED is not hidden" invariant), scoped to the three selectors whose
  // boxes actually participate in the document's flow: '.board-head' itself
  // (the sticky box AC 8 is about), and the two children whose own height
  // could otherwise change it, '.board-head-ident' and '.board-head-title'.
  // Deliberately NOT the pill's own '::before'/'::after' -- those ARE allowed
  // a height (this file's own fixed 42px), because a pseudo-element is
  // 'position: absolute', out of flow, and contributes nothing to the box
  // whose constancy this criterion depends on.
  const forbidden = /\b(padding-block|padding-top|padding-bottom|padding\s*:|margin-top|margin\s*:|height|min-height|max-height)\s*:/;
  const headRule = styles.match(/body:not\(\.page-board\) \.board-head \{([^}]*)\}/s);
  const identRule = styles.match(/body:not\(\.page-board\) \.board-head-ident \{([^}]*)\}/s);
  const titleRule = styles.match(/body:not\(\.page-board\) \.board-head-title \{([^}]*)\}/s);
  assert.ok(headRule, 'setup: the ordinary-board .board-head rule exists');
  assert.ok(identRule, 'setup: the ordinary-board .board-head-ident rule exists');
  assert.ok(titleRule, 'setup: the ordinary-board .board-head-title rule exists');
  assert.doesNotMatch(headRule[1], forbidden,
    'the sticky header\'s own box must declare no height-affecting property off the ramp -- that box\'s size is what AC 8 depends on staying constant');
  assert.doesNotMatch(identRule[1], forbidden,
    'the collapsing identity block keeps its own height here (unlike a page board\'s, which collapses it) -- that is what keeps .board-head\'s own height constant');
  assert.doesNotMatch(titleRule[1], forbidden,
    'and its title/mark group has nothing height-affecting either -- only its own horizontal gap ramps');
});

check('AC 8: the condense mechanism itself never scrolls the document -- only an explicit gesture may', () => {
  const document = loadBoard(renderBoardPage(ordinaryBoard()));
  const window = document.defaultView;
  const calls = [];
  window.scrollTo = (...args) => calls.push(args);

  scrollDocumentTo(document, 400);
  scrollDocumentTo(document, 900);
  scrollDocumentTo(document, 0);

  assert.deepEqual(calls, [], 'reporting and reacting to a scroll must never itself re-scroll the document');
});

check('AC 8: a page board is unaffected -- this document\'s own scroll event drives nothing on that channel', () => {
  const pageBoard = createBoard({
    title: 'a page board',
    blocks: [{ kind: 'html', html: '<p>hello</p>' }],
    wait: true,
  });
  const document = loadBoard(renderBoardPage(pageBoard));
  assert.equal(document.body.classList.contains('page-board'), true, 'setup: one html block and nothing else');
  assert.equal(progress(document), '', 'setup: a page board\'s own --stage-p is unwritten until its STAGE reports (test/check-page-board.mjs\'s own channel)');

  scrollDocumentTo(document, 800);

  assert.equal(progress(document), '',
    'refreshDocumentScrollChrome must gate itself off page-board bodies -- this document scrolling is not the stage scrolling');
  assert.equal(condensed(document), false);
});
