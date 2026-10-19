// skills/claude-board/SKILL.md check: this repo ships the one copy of the mechanism —
// the manual for the `ask` tool (ADR.md entries 11 and 102) — so for the first time since
// entry 5 the suite has a real subject for src/prose-check.mjs rather than only a fixture.
//
// Entry 102 is why this file is not the only caller-facing prose here and is still the only
// subject: a caller shipped from this repo (skills/grill-example/SKILL.md, the INSTALL.md
// migration) names the board and defers every argument, block kind and widget to the manual,
// so it has no mechanism to bind. Nothing checks that it stays that way.
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
import { check, configure, finish } from './support.mjs';

const SKILL_PATH = fileURLToPath(new URL('../skills/claude-board/SKILL.md', import.meta.url));
const PROTOCOL_PATH = fileURLToPath(new URL('../PROTOCOL.md', import.meta.url));
const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));

configure({ format: 'aligned' });

const prose = readFileSync(SKILL_PATH, 'utf8');
const protocol = readFileSync(PROTOCOL_PATH, 'utf8');
const readme = readFileSync(README_PATH, 'utf8');
// Prose wraps at the line, so every rule matched below is matched on whitespace-normalized
// text rather than a regex threaded with \s* at every wrap point.
const norm = s => s.replace(/\s+/g, ' ');


// Every rule below is a function of the text it judges, so "the other direction" further
// down runs the SAME function against a copy with one fact removed and demands that it
// throw. An ablation that re-ran its own copy of a pattern, or asserted its own edit, would
// prove only itself.
function fails(rule, text, message = /./) {
  let err = null;
  try { rule(text); } catch (e) { err = e; }
  assert.ok(err instanceof assert.AssertionError, 'the check still passed on text that lost what it guards');
  assert.match(err.message, message);
}

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
const documentsEvery = (what, names) => text => {
  const missing = names.filter(n => !text.includes(n));
  assert.deepEqual(missing, [], `undocumented ${what}: ${missing.join(', ')}`);
};
const documentsEveryWidget = documentsEvery('widgets', widgets);
const documentsEveryStatus = documentsEvery('packet statuses', parsePacketStatuses(protocol));
check('every block kind PROTOCOL.md defines is documented', () => documentsEvery('block kinds', blockKinds)(prose));
check('every widget PROTOCOL.md defines is documented', () => documentsEveryWidget(prose));
check('every packet status PROTOCOL.md defines is documented', () => documentsEveryStatus(prose));

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
const branchesOnStatus = text => {
  assert.match(text, /never on `choice`/i);
  // The specific trap: `deferred` can carry a choice, so a caller reading `choice`
  // alone records a decision the reviewer explicitly declined to make.
  assert.match(text, /deferred/);
};
check('branching on status rather than choice is stated', () => branchesOnStatus(prose));
// ADR.md entry 112: the post is refused whole, so the manual has to say so and name the
// ways out. The claim it replaced -- the block still lands, the post still returns 200,
// nothing in the return value tells you -- taught the agent to ignore a broken reference.
const describesRefusal = text => {
  assert.match(norm(text), /refused whole/i);
  assert.match(norm(text), /`CLAUDE_BOARD_REF_ROOTS`/);
  assert.doesNotMatch(norm(text), /still lands|still returns 200|nothing in the return value/i);
};
check('an unresolvable reference is described as a refused post, and the boundary with it', () => describesRefusal(prose));
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
const COMMENTABLE_RULE = norm(
  "Only the rendered kinds are — `mermaid` and `html` — and they are wherever they " +
  "appear, including inside a question's `context` and inside a `compare` side. " +
  "`markdown` and `code` are not, anywhere. The rule is drawn on kind, never on position",
);
const statesCommentableRule = text => {
  assert.ok(norm(text).includes(COMMENTABLE_RULE), 'missing the narrowed commenting rule');
};
const promisesNoWiderRule = text => {
  assert.doesNotMatch(text, /comments? on any element/i);
  assert.doesNotMatch(text, /regardless of kind/i);
};
check('the manual states the narrowed commenting rule', () => statesCommentableRule(prose));
check('PROTOCOL.md states the narrowed commenting rule', () => statesCommentableRule(protocol));
check('the manual does not promise the wider "anything rendered" commenting rule', () => promisesNoWiderRule(prose));
check('PROTOCOL.md does not promise the wider "anything rendered" commenting rule', () => promisesNoWiderRule(protocol));

// --- what an artifact must be -----------------------------------------------------
// The two rules the manual is the single home for: `/visualize`, `/explain` and `/gamify`
// cite it rather than restating them, so a rule that drifts out of this file is a rule
// that exists nowhere. Both are mechanism, not taste — a stage renders in an opaque-origin
// frame and a relative reference there resolves against the BOARD PAGE's own URL rather
// than the artifact's folder (ADR.md entries 32 and 108; the "resolves to nothing" version
// of that sentence was measured wrong in Chrome and corrected), and outside a page
// board the frame's height is whatever the stage reports. Entry 33 is the shape rule those
// two hang off: it is invisible at the call site, so a caller that posts a second block
// loses the layout with nothing to tell it so.
//
// The self-contained rule now carries one exception, and the manual has to state its exact
// width or a renderer will read it as licence to reference anything: mermaid is provided by
// the board (ADR 108), fonts, images and styles stay inline.
//
// Each rule names the fact "the other direction" removes to prove its check can fail.
const statesAll = patterns => text => {
  for (const p of patterns) assert.match(norm(text), p, `manual is missing: ${p}`);
};
const ARTIFACT_RULES = {
  'an artifact is one self-contained file': {
    patterns: [
      /self-contained/i, /`data:`/, /opaque-origin/i, /relative reference/i,
      /mermaid/i, /fonts, images and styles stay inline/i,
    ],
    lost: ['the self-contained rule', /self-contained/g],
  },
  'a stage is sized from its own content': {
    patterns: [
      /sizes itself from its own content, never from the viewport/i,
      /the frame's height is derived from what the stage reports/i,
    ],
    lost: ['the sizing rule', /never from the viewport/g],
  },
  'one `html` block and nothing else is a page board': {
    patterns: [/page board/i, /one `html` block and nothing else/i],
    lost: ['the page-board shape rule', /one `html` block and nothing else/g],
  },
  // ADR 121: an evidence page inlines its shots and clips, so a renderer has to know a
  // stage may run to the post limit while a markdown, code or mermaid block may not.
  'a stage may carry up to the post limit, and every other block keeps 512 KiB': {
    patterns: [/a stage may carry up to the post's 25 MB/i, /every other block keeps 512 KiB/i],
    lost: ['the stage cap', /up to the post's 25 MB/g],
  },
};
for (const [rule, { patterns }] of Object.entries(ARTIFACT_RULES)) {
  check(`the manual states that ${rule}`, () => statesAll(patterns)(prose));
}
// `/visualize`, `/explain` and `/gamify` used to each carry their own version of this,
// and each one was really a note about the deleted `/file/` link. They now cite the
// manual instead, which makes this sentence the only place the fallback exists: an
// artifact survives the board being down because it is already a file, so the agent
// opens it and says where. Lose the sentence and three skills fall silent at exactly
// the moment the reviewer has nothing else to look at.
const statesFallback = text => {
  assert.match(norm(text), /it is a file on disk, so `open` it and say where it is/i);
  assert.match(norm(text), /nothing else points at it/i);
};
check('the manual states the fallback a rendered artifact takes when the board is down', () => statesFallback(prose));
const pointsAtNoServedFile = text => {
  assert.doesNotMatch(text, /\/file\//, 'the manual still documents the deleted /file/ route');
};
check('the manual points at no served file, and reinstating the old /file/ section fails that check', () => {
  // ADR.md entry 38 deleted `GET /file/`; the drift this guards against is the manual's
  // pointer section outliving the route it documented, so reinstating one line of that
  // section must trip the check.
  pointsAtNoServedFile(prose);
  fails(pointsAtNoServedFile, prose.replace(
    '## Posting a rendered artifact',
    '## Pointing at a rendered file\n\nlink to `http://127.0.0.1:<port>/file/<basename>`\n\n## Posting a rendered artifact',
  ));
});

// --- what one round holds --------------------------------------------------------
// Three rules that bind every round whoever posts it, so the manual is their one home: a round
// is capped (the reviewer's confusion grows with round size), a question about a screen carries
// its mock rather than a description of one, and no option hands the decision back, since a
// "your call" option makes every recommended pick read as either agreement or delegation.
const ROUND_RULES = {
  'a round is capped, and a branch too big for one splits': {
    patterns: [
      /at most 6 questions or about 4,000 characters of prompts, explainers and options/i,
      /split a branch too big for one round across rounds/i,
    ],
    lost: ['the cap', /at most 6 questions/g],
  },
  'a question about a screen carries its mock in the same round': {
    patterns: [/a question about a screen or control carries its mock in its own `context`, in the same round/i],
    lost: ['the mock rule', /carries its mock/g],
  },
  'no option delegates the decision': {
    patterns: [/never offer a "your call" or "you decide" option/i, /ambiguous between agreement and delegation/i],
    lost: ['the no-delegation rule', /never offer a "your call"/g],
  },
};
for (const [rule, { patterns }] of Object.entries(ROUND_RULES)) {
  check(`the manual states that ${rule}`, () => statesAll(patterns)(prose));
}

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
const statesUrlInChat = text => {
  assert.match(norm(text), /say the board's URL in chat after every round/i);
  assert.match(norm(text), /`\/compact` rebuilds your context from the conversation/i);
};
check('the manual tells the agent to state the board URL in chat every round', () => statesUrlInChat(prose));

// --- README agreement -------------------------------------------------------------
// README.md is a second, separately-maintained doc that also shows the call shape, and
// the fresh-eyes audit (2026-08-11, N2) caught it stale — a name and an argument (`fresh`)
// behind the live shim. Nothing above touches README.md at all (`checkProseFile` was run
// against SKILL_PATH only), so pin the same live-schema facts against README's own worked
// example, the same way SKILL.md is pinned above it in this file. The pattern names the
// tool by its MCP-qualified name, so a short or invented form fails here too.
const README_CALL_RE = /mcp__claude-board__ask\(\{([^}]*)\}\)/;
const readmeCallMatchesSchema = text => {
  const m = text.match(README_CALL_RE);
  assert.ok(m, 'README must show a worked `mcp__claude-board__ask({ ... })` call, by the tool\'s MCP-qualified name');
  const shown = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  const real = [...result.schemaProps].sort();
  assert.deepEqual(shown, real, `README's call shows [${shown.join(', ')}], the live schema has [${real.join(', ')}]`);
};
check('README\'s worked call names the tool as mcp__claude-board__ask with exactly the live schema\'s arguments -- none missing, none invented', () => {
  readmeCallMatchesSchema(readme);
});

// --- README discloses the menu bar + pomodoro -----------------------------------------
// N3: a menu-bar status item and a pomodoro timer install alongside the daemon, and the
// audit's fresh-eyes pass found neither word anywhere in the README. Pinned here rather
// than left to review, since a doc pass rewriting the top of the file is exactly the kind
// of edit that could silently drop a disclosure paragraph.
const disclosesMenuBar = text => {
  assert.match(text, /menu[- ]bar/i, 'README must mention the menu-bar status item that installs alongside the daemon');
};
const namesMenuBarOptOut = text => {
  assert.match(text, /pomodoro settings/i, 'README must point at the pomodoro settings as where the status item is hidden from');
  assert.match(text, /survives? logout and reinstall/i, 'README must state the hide choice survives logout and reinstall');
};
check('README discloses the menu-bar status item', () => disclosesMenuBar(readme));
check('README discloses the pomodoro timer', () => {
  assert.match(readme, /pomodoro/i, 'README must mention the pomodoro timer that installs alongside the daemon');
});
check('README names the menu-bar opt-out and that it survives reinstall', () => namesMenuBarOptOut(readme));

// --- the other direction --------------------------------------------------------
// A check that only ever passes is worth nothing (test/check-prose-check.mjs's own
// rule, applied here). The presence checks above are the ones at risk of being vacuous --
// they search a 150-line document for short strings -- and the absence checks are at risk
// of a pattern that no longer matches the claim it was written against. So each one is run
// again, as the same function, against a copy with that one fact removed (or the old claim
// restored), and must fail there.
function drifted(pattern) {
  return prose.replace(pattern, '');
}
check('the widget check fails on prose that lost a widget, naming exactly that widget', () => {
  fails(documentsEveryWidget, drifted(/choose-between-rendered-variants/g),
    /^undocumented widgets: choose-between-rendered-variants\n/);
});
check('the packet-status check fails on prose that lost a status, naming exactly that status', () => {
  fails(documentsEveryStatus, drifted(/discuss/g), /^undocumented packet statuses: discuss\n/);
});
check('the status-not-choice check fails on prose that lost the rule', () => {
  fails(branchesOnStatus, drifted(/never on `choice`/g));
});
check('the refusal check fails on prose that regains the landed-block claim', () => {
  fails(describesRefusal, `${prose}\nThe block still lands and the post still returns 200.\n`);
});
check('the commenting-rule check fails on prose that lost the narrowed rule', () => {
  fails(statesCommentableRule, norm(prose).replace(COMMENTABLE_RULE, ''));
});
check('the commenting-rule absence check fails if the manual regains the old claim', () => {
  // The exact sentence SKILL.md carried before this pass:
  // "The reviewer answers in any order, comments on any element by clicking it, and
  // submits once." Reintroducing it must trip the absence check.
  const marker = 'comments on a rendered stage or diagram by clicking it';
  assert.ok(prose.includes(marker), 'the sentence being reverted no longer exists in the manual');
  fails(promisesNoWiderRule, prose.replace(marker, 'comments on any element by clicking it'));
});
check('the commenting-rule absence check fails if PROTOCOL.md regains the old claim', () => {
  // PROTOCOL.md's choose-between-rendered-variants section used to close on:
  // "...and every option's whole-block comment button still works regardless of
  // kind (it renders in the parent document, not the iframe)." Reintroducing that
  // claim anywhere must trip the absence check.
  const marker = /so an `html` or `mermaid`\s*\noption still carries one regardless of the iframe\./;
  assert.match(protocol, marker, 'the sentence being reverted no longer exists in PROTOCOL.md');
  fails(promisesNoWiderRule, protocol.replace(marker,
    "so every option's whole-block comment button still works regardless of kind (it\nrenders in the parent document, not the iframe)."));
});
for (const [kind, rules] of [['artifact', ARTIFACT_RULES], ['round', ROUND_RULES]]) {
  for (const { patterns, lost: [what, pattern] } of Object.values(rules)) {
    check(`the ${kind}-rule checks fail on prose that lost ${what}`, () => {
      fails(statesAll(patterns), drifted(pattern));
    });
  }
}
check('the fallback check fails on prose that lost the open-it-and-say-where rule', () => {
  // Normalized first: the sentence wraps across two source lines, so the drift has to be
  // applied to the same whitespace-normalized text the check matches against.
  fails(statesFallback, norm(prose).replace(/`open` it and say where it is/g, ''));
});
check('the URL-in-chat check fails on prose that lost the rule', () => {
  fails(statesUrlInChat, drifted(/Say the board's URL in chat after every round/));
});
check('the README call-shape check fails on prose that lost the `fresh` argument', () => {
  fails(readmeCallMatchesSchema, readme.replace(README_CALL_RE, m => m.replace(/,\s*fresh/, '')));
});
check('the disclosure checks fail on a README that lost the menu-bar paragraph', () => {
  const stripped = readme.replace(/### The menu bar item and the timer[\s\S]*?survives logout and reinstall\.\n/, '');
  fails(disclosesMenuBar, stripped);
  fails(namesMenuBarOptOut, stripped);
});

await finish(null, { failText: n => `${n} failure(s)` });
console.log('check-skill-prose ok');
