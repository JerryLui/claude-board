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

check('optional </li>: <ul><li>a<li>b</ul> -- ul > [li, li], not ul > li > li', () => {
  assertTreesAgree('<ul><li>a<li>b</ul>');
});

check('optional </p> before a block element: <p>intro<div>after</div> -- p and div as SIBLINGS, not div nested inside p', () => {
  assertTreesAgree('<p>intro<div>after</div>');
});

// --- every other autoCloseFor/impliedParentFor rule, individually -------------

check('optional </p> before another <p>: <p>one<p>two -- two sibling <p>s', () => {
  assertTreesAgree('<p>one<p>two');
});

check('optional </p> before a heading: <p>one<h2>two</h2>', () => {
  assertTreesAgree('<p>one<h2>two</h2>');
});

check('implied <tbody>: <table><td>x</td></table>', () => {
  assertTreesAgree('<table><td>x</td></table>');
});

check('implied <tbody> AND <tr>: <table><td>x</td><td>y</td></table>', () => {
  assertTreesAgree('<table><td>x</td><td>y</td></table>');
});

check('an explicit <tbody> is never double-wrapped: <table><tbody><tr><td>x</td></tr></tbody></table>', () => {
  assertTreesAgree('<table><tbody><tr><td>x</td></tr></tbody></table>');
});

check('optional </tr> and </td>: <table><tr><td>a<td>b<tr><td>c</table>', () => {
  assertTreesAgree('<table><tr><td>a<td>b<tr><td>c</table>');
});

check('optional </dt>/</dd>: <dl><dt>a<dd>b<dt>c<dd>d</dl>', () => {
  assertTreesAgree('<dl><dt>a<dd>b<dt>c<dd>d</dl>');
});

check('optional </option>: <select><option>a<option>b<option>c</select>', () => {
  assertTreesAgree('<select><option>a<option>b<option>c</select>');
});

check('optional </optgroup> and </option> together: <select><optgroup label="g"><option>a<option>b</select>', () => {
  assertTreesAgree('<select><optgroup label="g"><option>a<option>b</select>');
});

check('script/style are kept as element nodes, not deleted, so a following sibling\'s index is unaffected: <div><script>var x = "<div>";</script><span>after</span></div>', () => {
  assertTreesAgree('<div><script>var x = "<div>";</script><span>after</span></div>');
});

check('a <style> body is never treated as markup either: <div><style>.a{color:red}</style><p>after</p></div>', () => {
  assertTreesAgree('<div><style>.a{color:red}</style><p>after</p></div>');
});

check('a stray, mismatched closing tag is ignored on both sides: <div>a</span><p>b</p></div>', () => {
  assertTreesAgree('<div>a</span><p>b</p></div>');
});

check('an explicit closing tag closes everything implicitly opened above it: <ul><li>a<li>b</ul><p>after</p>', () => {
  assertTreesAgree('<ul><li>a<li>b</ul><p>after</p>');
});

// Both sides treat a self-closing `<div/>` as actually self-closing, which is
// WRONG per HTML5 (a non-void element's trailing `/` is ignored by a real
// browser; `<div/>after` should nest "after" INSIDE the div) -- src/anchor.mjs's
// tokenizer gates on the same `selfClosed` flag for every non-void tag, not just
// void ones, and always did. Not this file's job to fix (a product-code
// correctness question, out of scope here), but
// sharing the same tag-omission functions means the stand-in inherits the SAME
// wrongness rather than a DIFFERENT one, which is what this check locks in: the
// two sides must keep agreeing, correct or not.
check('(pre-existing, shared) self-closing <div/> is wrongly treated as void by both sides alike -- not fixed here, but agreement is locked in', () => {
  assertTreesAgree('<div/>text after<span>inner</span></div>');
});

// --- the repo's own baseline fixture, which every OTHER check in this suite ----
// uses -- must still agree, or this file's corpus would be proving parity on
// cases nothing else exercises while breaking the one case everything else relies
// on.

check('the repo\'s own well-formed html-stage fixture still agrees: <div class="mock"><button>Send</button></div>', () => {
  assertTreesAgree('<div class="mock"><button>Send</button></div>');
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall parser-parity checks ok');
