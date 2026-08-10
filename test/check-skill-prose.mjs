// skills/claude-board/SKILL.md check: this repo now ships one caller-facing prose file —
// the manual for the `ask` tool (ADR.md entry 11) — so for the first time since entry 5 the
// suite has a real subject for src/prose-check.mjs rather than only a fixture.
//
// That is the whole point of shipping the manual here instead of leaving a copy in
// ~/.claude: prose that claims an argument, block kind or widget the shim does not have
// fails `node test/run.mjs` in the same repo as the shim, on the commit that broke it,
// with no plist resolution and no copy-pasted loader in a downstream check.
//
// This is the *generic* battery (the tool is named, its real arguments appear, no invented
// vocabulary). Below it are the assertions specific to this file: the facts a caller cannot
// get right on its own, which are exactly the ones that used to be restated per caller and
// drift silently.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkProseFile, formatFailures, parseBlockShapes, parsePacketStatuses } from '../src/prose-check.mjs';

const SKILL_PATH = fileURLToPath(new URL('../skills/claude-board/SKILL.md', import.meta.url));
const PROTOCOL_PATH = fileURLToPath(new URL('../PROTOCOL.md', import.meta.url));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

const prose = readFileSync(SKILL_PATH, 'utf8');
const protocol = readFileSync(PROTOCOL_PATH, 'utf8');

// --- the generic battery, against a live shim ---------------------------------
const result = await checkProseFile(SKILL_PATH);
check('the manual matches the live shim', () => {
  assert.ok(result.ok, `\n${formatFailures(result.failures)}`);
});

// --- the vocabulary, in full --------------------------------------------------
// checkProse only rejects vocabulary the prose INVENTS. The manual has the opposite
// duty: it is the one place a caller reads, so a widget or block kind it omits is a
// widget or block kind no caller will ever use. `/grill`'s prose documented four widgets
// for as long as there were five, and nothing caught it, because nothing was checking
// for absence.
const { blockKinds, widgets } = parseBlockShapes(protocol);
check('every block kind PROTOCOL.md defines is documented', () => {
  const missing = blockKinds.filter(k => !prose.includes(k));
  assert.deepEqual(missing, [], `undocumented block kinds: ${missing.join(', ')}`);
});
check('every widget PROTOCOL.md defines is documented', () => {
  const missing = widgets.filter(w => !prose.includes(w));
  assert.deepEqual(missing, [], `undocumented widgets: ${missing.join(', ')}`);
});
check('every packet status PROTOCOL.md defines is documented', () => {
  const missing = parsePacketStatuses(protocol).filter(s => !prose.includes(s));
  assert.deepEqual(missing, [], `undocumented packet statuses: ${missing.join(', ')}`);
});

// --- the traps -----------------------------------------------------------------
// Each of these is a fact a caller got wrong, or omitted, while every caller kept its
// own copy of the protocol. They are asserted here so the manual cannot lose them.
check('the three isError triggers are all named', () => {
  for (const trigger of [/unreachable/i, /headless/i, /open a tab/i]) {
    assert.match(prose, trigger, `missing isError trigger: ${trigger}`);
  }
});
check('the fallback is required to relay the message verbatim', () => {
  assert.match(prose, /verbatim/i);
  assert.match(prose, /recovery command/i);
});
check('branching on status rather than choice is stated', () => {
  assert.match(prose, /never on `choice`/i);
  // The specific trap: `deferred` can carry a choice, so a caller reading `choice`
  // alone records a decision the reviewer explicitly declined to make.
  assert.match(prose, /deferred/);
});
check('an unresolvable reference is described as a visible block error, not a failed post', () => {
  assert.match(prose, /error/i);
  assert.match(prose, /still lands|still posts|still minted/i);
});
check('the section-slug rule is stated with a worked example', () => {
  assert.match(prose, /slug/i);
  assert.match(prose, /open-questions/);
});

// --- one commenting rule ---------------------------------------------------------
// ADR.md entry 28 ("Only the rendered kinds can be commented on") supersedes the
// comment half of entry 26 and narrows entry 28: only `html` and `mermaid` carry the
// comment control and the click-to-anchor gesture, wherever they appear, and
// `markdown`/`code` carry neither, anywhere. This is the canonical wording that
// both this manual and PROTOCOL.md are measured against. The source is gitignored
// and unreachable from this repo, so the rule is pinned here by hand rather than
// read live — exactly the shape every other check in this file already takes.
// Prose wraps at the line, so the rule is matched on whitespace-normalized text
// rather than a regex threaded with \s* at every wrap point.
const norm = s => s.replace(/\s+/g, ' ');
const COMMENTABLE_RULE = norm(
  "Only the rendered kinds are — `mermaid` and `html` — and they are wherever they " +
  "appear, including inside a question's `context` and inside a `compare` side. " +
  "`markdown` and `code` are not, anywhere. The rule is drawn on kind, never on position",
);
check('the manual states the narrowed commenting rule', () => {
  assert.ok(norm(prose).includes(COMMENTABLE_RULE), 'manual is missing the narrowed commenting rule');
});
check('PROTOCOL.md states the narrowed commenting rule', () => {
  assert.ok(norm(protocol).includes(COMMENTABLE_RULE), 'PROTOCOL.md is missing the narrowed commenting rule');
});
check('the manual does not promise the wider "anything rendered" commenting rule', () => {
  assert.doesNotMatch(prose, /comments? on any element/i);
  assert.doesNotMatch(prose, /regardless of kind/i);
});
check('PROTOCOL.md does not promise the wider "anything rendered" commenting rule', () => {
  assert.doesNotMatch(protocol, /comments? on any element/i);
  assert.doesNotMatch(protocol, /regardless of kind/i);
});

// --- what an artifact must be -----------------------------------------------------
// The two rules the manual is the single home for: `/visualize`, `/explain` and `/gamify`
// cite it rather than restating them, so a rule that drifts out of this file is a rule
// that exists nowhere. Both are mechanism, not taste — a stage renders in an opaque-origin
// frame and an opaque origin resolves no relative URL (ADR.md entry 32), and outside a page
// board the frame's height is whatever the stage reports. Entry 33 is the shape rule those
// two hang off: it is invisible at the call site, so a caller that posts a second block
// loses the layout with nothing to tell it so.
const ARTIFACT_RULES = {
  'an artifact is one self-contained file': [
    /self-contained/i, /`data:`/, /opaque-origin/i, /relative URL/i,
  ],
  'a stage is sized from its own content': [
    /sizes itself from its own content, never from the viewport/i,
    /the frame's height is derived from what the stage reports/i,
  ],
  'one `html` block and nothing else is a page board': [
    /page board/i, /one `html` block and nothing else/i,
  ],
};
const statesRule = (text, patterns) => patterns.every(p => p.test(norm(text)));
for (const [rule, patterns] of Object.entries(ARTIFACT_RULES)) {
  check(`the manual states that ${rule}`, () => {
    for (const p of patterns) assert.match(norm(prose), p, `manual is missing: ${p}`);
  });
}
check('the manual states the fallback a rendered artifact takes when the board is down', () => {
  // `/visualize`, `/explain` and `/gamify` used to each carry their own version of this,
  // and each one was really a note about the deleted `/file/` link. They now cite the
  // manual instead, which makes this sentence the only place the fallback exists: an
  // artifact survives the board being down because it is already a file, so the agent
  // opens it and says where. Lose the sentence and three skills fall silent at exactly
  // the moment the reviewer has nothing else to look at.
  assert.match(norm(prose), /it is a file on disk, so `open` it and say where it is/i);
  assert.match(norm(prose), /nothing else points at it/i);
});
check('the fallback check fails on prose that lost the open-it-and-say-where rule', () => {
  // Normalized first: the sentence wraps across two source lines, so the drift has to be
  // applied to the same whitespace-normalized text the check above matches against.
  assert.doesNotMatch(norm(prose).replace(/`open` it and say where it is/g, ''),
    /it is a file on disk, so `open` it and say where it is/i);
});
check('the manual points at no served file, now that the route is gone', () => {
  // ADR.md entry 38 deleted `GET /file/`; the drift this guards against is the manual's
  // pointer section outliving the route it documented, so reinstating one line of that
  // section must trip the check.
  assert.doesNotMatch(prose, /\/file\//, 'the manual still documents the deleted /file/ route');
  const reverted = prose.replace(
    '## Posting a rendered artifact',
    '## Pointing at a rendered file\n\nlink to `http://127.0.0.1:<port>/file/<basename>`\n\n## Posting a rendered artifact',
  );
  assert.match(reverted, /\/file\//, 'the section being reverted no longer exists in the manual');
});

// --- the other direction --------------------------------------------------------
// A check that only ever passes is worth nothing (test/check-prose-check.mjs's own
// rule, applied here). The absence checks above are the ones at risk of being vacuous —
// they search a 150-line document for short strings — so each is re-run against a copy
// with that one fact deleted, and must fail there.
function drifted(pattern) {
  return prose.replace(pattern, '');
}
check('the vocabulary checks fail on prose that lost a widget', () => {
  const text = drifted(/choose-between-rendered-variants/g);
  const missing = widgets.filter(w => !text.includes(w));
  assert.deepEqual(missing, ['choose-between-rendered-variants'],
    'dropping a widget from the manual did not fail the widget check');
});
check('the vocabulary checks fail on prose that lost a packet status', () => {
  const text = drifted(/discuss/g);
  const missing = parsePacketStatuses(protocol).filter(s => !text.includes(s));
  assert.deepEqual(missing, ['discuss'],
    'dropping a status from the manual did not fail the status check');
});
check('the trap checks fail on prose that lost the status-not-choice rule', () => {
  assert.doesNotMatch(drifted(/never on `choice`/g), /never on `choice`/i);
});
check('the commenting-rule check fails on prose that lost the narrowed rule', () => {
  const text = norm(prose).replace(COMMENTABLE_RULE, '');
  assert.ok(!text.includes(COMMENTABLE_RULE), 'removing the rule did not fail the rule check');
});
check('the artifact-rule checks fail on prose that lost the self-contained rule', () => {
  assert.ok(!statesRule(drifted(/self-contained/g), ARTIFACT_RULES['an artifact is one self-contained file']),
    'dropping the self-contained rule from the manual did not fail its check');
});
check('the artifact-rule checks fail on prose that lost the sizing rule', () => {
  assert.ok(!statesRule(drifted(/never from the viewport/g), ARTIFACT_RULES['a stage is sized from its own content']),
    'dropping the sizing rule from the manual did not fail its check');
});
check('the artifact-rule checks fail on prose that lost the page-board shape rule', () => {
  assert.ok(!statesRule(drifted(/one `html` block and nothing else/g), ARTIFACT_RULES['one `html` block and nothing else is a page board']),
    'dropping the page-board shape rule from the manual did not fail its check');
});
// --- the boundary, and the one rule guarding it -----------------------------------
// ADR 69: `fresh` is checked by the generic battery above (it is a real schema argument,
// so the manual has to name it), but WHEN to pass it cannot be. Nothing can detect a
// missed declaration, and the one thing that makes the agent able to answer "have I
// posted a board in this conversation?" after a `/compact` is having written the URL into
// chat -- a compaction summary is built from the conversation, not from tool results. That
// rule lives nowhere else, so it is pinned here.
check('the manual tells the agent when a boundary is declared', () => {
  assert.match(norm(prose), /you have posted no board in this conversation/i);
  assert.match(norm(prose), /after a `\/clear`/i);
});
check('the manual tells the agent to state the board URL in chat every round', () => {
  assert.match(norm(prose), /say the board's URL in chat after every round/i);
  assert.match(norm(prose), /`\/compact` rebuilds your context from the conversation/i);
});
check('the URL-in-chat check fails on prose that lost the rule', () => {
  assert.doesNotMatch(norm(drifted(/Say the board's URL in chat after every round/)),
    /say the board's URL in chat after every round/i);
});

check('the commenting-rule absence check fails if the manual regains the old claim', () => {
  // The exact sentence SKILL.md carried before this pass:
  // "The reviewer answers in any order, comments on any element by clicking it, and
  // submits once." Reintroducing it must trip the absence check.
  const marker = 'comments on a rendered stage or diagram by clicking it';
  assert.ok(prose.includes(marker), 'the sentence being reverted no longer exists in the manual');
  const reverted = prose.replace(marker, 'comments on any element by clicking it');
  assert.match(reverted, /comments? on any element/i);
});
check('the commenting-rule absence check fails if PROTOCOL.md regains the old claim', () => {
  // PROTOCOL.md's choose-between-rendered-variants section used to close on:
  // "...and every option's whole-block comment button still works regardless of
  // kind (it renders in the parent document, not the iframe)." Reintroducing that
  // claim anywhere must trip the absence check.
  const marker = /so an `html` or `mermaid`\s*\noption still carries one regardless of the iframe\./;
  assert.match(protocol, marker, 'the sentence being reverted no longer exists in PROTOCOL.md');
  const reverted = protocol.replace(marker,
    "so every option's whole-block comment button still works regardless of kind (it\nrenders in the parent document, not the iframe).");
  assert.match(reverted, /regardless of kind/i);
});

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('check-skill-prose ok');
