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

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('check-skill-prose ok');
