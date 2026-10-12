// The stand-in shares the server's parser bugs, so they go undetected.
// Concretely, test/dom-stand-in.mjs's OWN parser was measured disagreeing with
// src/anchor.mjs's parseHtmlTree -- the module every `dom` anchor is actually
// RESOLVED against, server-side -- on ordinary, not adversarial, markup:
//
//   <ul><li>a<li>b</ul>       stand-in: ul > li > li     parseHtmlTree: ul > [li, li]
//   <p>intro<div>after</div>  stand-in: p > div          parseHtmlTree: p, div siblings
//
// Every html-stage fixture anywhere else in this suite is the same well-formed
// `<div class="mock"><button>Send</button></div>`, so neither side's gaps were
// ever exercised. The fix (test/dom-stand-in.mjs) is to SHARE the tag-omission
// decision functions (autoCloseFor/impliedParentFor) and the entity table
// directly with src/anchor.mjs's parseHtmlTree, rather than a second, hand-ported
// copy of the same rules -- see that file's own header comment for why sharing is
// preferred over porting. This file is the fixture that verifies it:
// feed both parsers the SAME corpus (the exact shapes measured above, plus every
// other tag-omission rule autoCloseFor/impliedParentFor encodes) and assert they
// build IDENTICAL trees -- so a future edit to either side's structural handling
// that breaks agreement fails a check here, rather than silently shipping a
// stand-in that agrees with a bug instead of catching it.

import assert from 'node:assert/strict';
import { parseHtmlTree } from '../src/anchor.mjs';
import { parseNodes } from './dom-stand-in.mjs';
import { check, finish } from './support.mjs';

/** parseHtmlTree's tree ({tag, children, content}, children = ELEMENT nodes only,
 * matching resolveSteps' 1-based indexing) reduced to a canonical shape: just tag
 * names and nesting, since this file is about STRUCTURE agreement, not text-run
 * agreement (extractHint/elementText already have their own coverage in
 * test/check-pure.mjs). */
function shapeFromAnchorTree(nodes) {
  return nodes.map(n => ({ tag: n.tag, children: shapeFromAnchorTree(n.children) }));
}

/** The stand-in's real Element tree, reduced the same way -- `.children` is
 * already element-only (test/dom-stand-in.mjs's own Element.children getter),
 * exactly matching parseHtmlTree's `.children` semantics. */
function shapeFromStandInNodes(nodes) {
  return nodes.filter(n => n.nodeType === 1).map(el => ({ tag: el.tagName.toLowerCase(), children: shapeFromStandInNodes(el.children) }));
}

function assertTreesAgree(html) {
  const anchorShape = shapeFromAnchorTree(parseHtmlTree(html).children);
  const standInShape = shapeFromStandInNodes(parseNodes(html));
  assert.deepEqual(standInShape, anchorShape,
    `parser disagreement for ${JSON.stringify(html)}:\n  src/anchor.mjs  : ${JSON.stringify(anchorShape)}\n  dom-stand-in.mjs: ${JSON.stringify(standInShape)}`);
}

// --- the exact shapes measured disagreeing --------------------------

check('optional </p> before a block element: both parsers agree on <p>intro<div>after</div>', () => {
  assertTreesAgree('<p>intro<div>after</div>');
});

// --- every other autoCloseFor/impliedParentFor rule, individually -------------

check('optional </p> before another <p>: both parsers agree on <p>one<p>two', () => {
  assertTreesAgree('<p>one<p>two');
});

check('optional </p> before a heading: both parsers agree on <p>one<h2>two</h2>', () => {
  assertTreesAgree('<p>one<h2>two</h2>');
});

check('implied <tbody>: both parsers agree on <table><td>x</td></table>', () => {
  assertTreesAgree('<table><td>x</td></table>');
});

check('implied <tbody> AND <tr>: both parsers agree on <table><td>x</td><td>y</td></table>', () => {
  assertTreesAgree('<table><td>x</td><td>y</td></table>');
});

check('an explicit <tbody>: both parsers agree on <table><tbody><tr><td>x</td></tr></tbody></table>', () => {
  assertTreesAgree('<table><tbody><tr><td>x</td></tr></tbody></table>');
});

check('optional </tr> and </td>: both parsers agree on <table><tr><td>a<td>b<tr><td>c</table>', () => {
  assertTreesAgree('<table><tr><td>a<td>b<tr><td>c</table>');
});

check('optional </dt>/</dd>: both parsers agree on <dl><dt>a<dd>b<dt>c<dd>d</dl>', () => {
  assertTreesAgree('<dl><dt>a<dd>b<dt>c<dd>d</dl>');
});

check('optional </option>: both parsers agree on <select><option>a<option>b<option>c</select>', () => {
  assertTreesAgree('<select><option>a<option>b<option>c</select>');
});

check('optional </optgroup> and </option> together: both parsers agree on <select><optgroup label="g"><option>a<option>b</select>', () => {
  assertTreesAgree('<select><optgroup label="g"><option>a<option>b</select>');
});

check('a <script> body holding markup: both parsers agree on <div><script>var x = "<div>";</script><span>after</span></div>', () => {
  assertTreesAgree('<div><script>var x = "<div>";</script><span>after</span></div>');
});

check('a <style> body: both parsers agree on <div><style>.a{color:red}</style><p>after</p></div>', () => {
  assertTreesAgree('<div><style>.a{color:red}</style><p>after</p></div>');
});

check('a stray, mismatched closing tag: both parsers agree on <div>a</span><p>b</p></div>', () => {
  assertTreesAgree('<div>a</span><p>b</p></div>');
});

// The first measured disagreement, <ul><li>a<li>b</ul>, is this input's prefix.
check('optional </li> then an explicit closing tag: both parsers agree on <ul><li>a<li>b</ul><p>after</p>', () => {
  assertTreesAgree('<ul><li>a<li>b</ul><p>after</p>');
});

// Both sides used to treat a self-closing `<div/>` as actually self-closing, and
// this file locked that shared wrongness in as "at least they agree". They now
// agree on the CORRECT answer instead: HTML5's tree builder never acknowledges the
// self-closing flag on an HTML element, so `<div/>after<span>inner</span>` leaves
// the div open and nests both of them inside it -- which is what the browser the
// reviewer is actually looking at does, and therefore what the element a comment
// anchors to has to be. The one place the flag does count is foreign content, so
// the SVG cases below are the other half of the same rule.
check('a self-closing <div/> is not self-closing: the div stays open and the following elements nest INSIDE it, as in a browser', () => {
  assertTreesAgree('<div/>text after<span>inner</span></div>');
  const [div] = parseHtmlTree('<div/>text after<span>inner</span></div>').children;
  assert.equal(div.tag, 'div');
  assert.equal(div.children.length, 1, 'the <span> is the div\'s child, not its sibling -- an ignored `/` leaves the element open');
  assert.equal(div.children[0].tag, 'span');
});

check('a non-void element with a trailing /: both parsers agree on a self-closed <li>, <p> and <span>', () => {
  assertTreesAgree('<ul><li/><li/><li/></ul>');
  assertTreesAgree('<div><p/><p>second</p></div>');
  assertTreesAgree('<div><span/>a</div><span>sibling</span>');
});

check('inside SVG/MathML both parsers agree on self-closed roots and descendants, and <svg><circle/><rect/></svg><span> parses as svg > [circle, rect] then span', () => {
  assertTreesAgree('<svg/><p>after</p>');
  assertTreesAgree('<div><svg><circle/><rect/></svg><span>after</span></div>');
  assertTreesAgree('<math/><p>after</p>');
  const [div] = parseHtmlTree('<div><svg><circle/><rect/></svg><span>after</span></div>').children;
  assert.deepEqual(shapeFromAnchorTree(div.children), [
    { tag: 'svg', children: [{ tag: 'circle', children: [] }, { tag: 'rect', children: [] }] },
    { tag: 'span', children: [] },
  ], 'circle and rect are siblings inside the svg, and the span follows the svg -- not one nested chain');
});

check('foreignness ends with the foreign subtree: a <div/> after a closed <svg> is an ordinary open div again', () => {
  assertTreesAgree('<svg><circle/></svg><div/><span>inner</span>');
  // Parity alone cannot catch getting this one wrong -- both sides run the same
  // bookkeeping in the same order, so they would agree on the wrong tree; the shape
  // itself is pinned in test/check-pure.mjs. It stays in this corpus so the two
  // sides cannot drift apart on it either.
  assertTreesAgree('<table><svg></svg><td/><span>x</span></table>');
  const shape = shapeFromAnchorTree(parseHtmlTree('<svg><circle/></svg><div/><span>inner</span>').children);
  assert.deepEqual(shape, [
    { tag: 'svg', children: [{ tag: 'circle', children: [] }] },
    { tag: 'div', children: [{ tag: 'span', children: [] }] },
  ]);
});

// --- a small, deterministic outerHTML round-trip --
//
// firstElementChild/outerHTML used to be entirely absent from the stand-in (not
// even an empty string -- plain `undefined`), so src/ui.mjs's applyResync built
// the literal STRING "undefined" into markup it then tried to parse, rather than
// throwing or visibly failing. Implemented for real (see Element.outerHTML's own
// comment); this proves it actually round-trips back through this file's own
// parser, since that -- not byte-for-byte fidelity to a browser's serializer -- is
// the only contract this stand-in has to satisfy.

check('outerHTML round-trips through parseNodes: parse, serialize, re-parse, same shape', () => {
  const html = '<div class="mock" data-x="a &amp; b"><button>Send</button><p>one<span>two</span></p></div>';
  const [el] = parseNodes(html);
  const reparsed = parseNodes(el.outerHTML);
  assert.equal(reparsed.length, 1);
  assert.deepEqual(shapeFromStandInNodes(reparsed), shapeFromStandInNodes([el]));
  assert.equal(reparsed[0].getAttribute('data-x'), 'a & b', 'an attribute value must survive an outerHTML round-trip, entities and all');
  assert.equal(reparsed[0].querySelector('button').textContent, 'Send');
});

finish('parser-parity');
