// The drift check for the committed sample board (examples/sample-board.mjs,
// examples/sample-board.json, examples/sample-board.html): "regenerating the
// page from its committed source produces a byte-identical file, and a check
// in the test suite fails when it does not". Patterned after test/check-archive.mjs and
// test/check-archive-ids.mjs -- a plain node script, node:assert/strict, a
// local check(name, fn) helper, process.exit(1) on any failure.
//
// Also asserts the substance of every other acceptance criterion the sample
// board exists to demonstrate: every block kind and widget rendered, every
// question answered, the manual's own rules for a question card (an explainer
// under the prompt, the context as one panel of plain items, a None option on
// the multi), all three comment-anchor flavors resolved, the round
// pager naming both of the board's two rounds and opening on the newest
// (ADR.md entry 42 -- rounds are pages now, flipped by the pager, not stacked
// and collapsed into a history rail), round 1 as a page board and round 2 as
// the block gallery it is not, round 2's answers reading back non-editable
// since it is sent, no leaked machine identity, and (loaded with
// location.protocol 'file:', the same way test/check-archive.mjs proves an
// archive is read-only) body.readonly applied.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderBoardPage, isPageRound } from '../src/render.mjs';
import { resolveComments, questionBlocks, WIDGETS, KIND_LETTER } from '../src/board.mjs';
import { ui } from '../src/ui.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { buildSampleBoard } from '../examples/sample-board.mjs';

const examplesDir = fileURLToPath(new URL('../examples/', import.meta.url));
const committedJsonText = readFileSync(path.join(examplesDir, 'sample-board.json'), 'utf8');
const committedHtmlText = readFileSync(path.join(examplesDir, 'sample-board.html'), 'utf8');
const committedBoard = JSON.parse(committedJsonText);

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

// =================================================================================
// 1-2. Drift: regenerating from committed source is byte-identical.
// =================================================================================

check('buildSampleBoard() re-run is byte-identical to the committed sample-board.json', () => {
  const fresh = buildSampleBoard();
  const freshText = JSON.stringify(fresh, null, 2) + '\n';
  assert.equal(freshText, committedJsonText,
    'examples/sample-board.json is stale -- regenerate it with `node examples/sample-board.mjs`');
});

check('renderBoardPage() of the committed JSON is byte-identical to the committed sample-board.html', () => {
  const rendered = renderBoardPage(committedBoard);
  assert.equal(rendered, committedHtmlText,
    'examples/sample-board.html is stale -- regenerate it with `node examples/sample-board.mjs`');
});

// =================================================================================
// 3-4. Every content block kind and every widget renders.
// =================================================================================

const document = parseHTML(committedHtmlText);

check('every one of the six content block kinds appears in the rendered DOM', () => {
  const kindsFound = new Set(document.querySelectorAll('[data-block-kind]').map(el => el.getAttribute('data-block-kind')));
  const expectedKinds = Object.keys(KIND_LETTER);
  for (const kind of expectedKinds) {
    assert.ok(kindsFound.has(kind), `no element carries data-block-kind="${kind}"`);
  }
  assert.equal(expectedKinds.length, 6, 'setup failure: expected exactly six block kinds in the protocol');
});

check('every one of the five widgets appears on a rendered question block', () => {
  const widgetsFound = new Set(document.querySelectorAll('.question-block[data-widget]').map(el => el.getAttribute('data-widget')));
  for (const widget of WIDGETS) {
    assert.ok(widgetsFound.has(widget), `no .question-block carries data-widget="${widget}"`);
  }
  assert.equal(WIDGETS.length, 5, 'setup failure: expected exactly five widgets in the protocol');
});

// =================================================================================
// 4b. The sample keeps the manual's own rules for a question card (ADR.md
//     entries 110/111): the explainer under the prompt, the context as one
//     panel of plain items, a None option on the multi. A showcase that broke
//     the rules the manual states would teach every caller the wrong shape.
// =================================================================================

check('one question carries an explainer, rendered as prose beside its prompt on the head row', () => {
  const withExplainer = questionBlocks(committedBoard).filter(b => b.explainer);
  assert.equal(withExplainer.length, 1, 'the sample should showcase exactly one explainer');
  const q = withExplainer[0];
  const section = document.querySelector(`.question-block[data-block-id="${q.id}"]`);
  assert.ok(section, `the question carrying the explainer (${q.id}) does not render`);
  const head = section.querySelector('.question-head');
  assert.ok(head, 'the explainer question renders no .question-head row');
  assert.ok(head.querySelector('.question-prompt'), 'the prompt does not share the head row with the explainer');
  const explainer = head.querySelector('.question-explainer');
  assert.ok(explainer, 'the explainer does not render under the prompt, inside the head row');
  assert.equal(explainer.textContent.trim(), q.explainer, 'the rendered explainer does not read back the posted text');
  assert.equal(section.querySelector('.question-main .question-explainer'), null,
    'the explainer sits in the options column instead of the card\'s full row');
});

check("the multi question carries a None option, rendered as one of its choices", () => {
  const multi = questionBlocks(committedBoard).find(b => b.widget === 'multi');
  assert.ok(multi, 'the sample carries no multi question');
  const none = multi.options.find(o => /^none\b/i.test(o.label));
  assert.ok(none, 'the multi question carries no None option -- an empty selection reads back as `unanswered`, which is a blank, not an answer of none');
  const section = document.querySelector(`.question-block[data-block-id="${multi.id}"]`);
  assert.ok(section, 'the multi question does not render');
  const rendered = [...section.querySelectorAll('.card-choice')].map(el => el.getAttribute('data-choice'));
  assert.deepEqual(rendered, multi.options.map(o => o.label),
    'the rendered choices do not match the multi question\'s options, in order');
});

check("a question's context renders as one panel of plain items -- no per-item card, no kind label", () => {
  const withContext = questionBlocks(committedBoard).filter(b => Array.isArray(b.context) && b.context.length > 0);
  assert.ok(withContext.length > 0, 'no question block on the committed board carries a context block');
  for (const q of withContext) {
    const section = document.querySelector(`.question-block[data-block-id="${q.id}"]`);
    assert.ok(section, `question ${q.id} does not render`);
    const panel = section.querySelector('.question-context');
    assert.ok(panel, `question ${q.id} does not render its context as one .question-context panel`);
    const items = [...panel.querySelectorAll('.context-item')];
    assert.equal(items.length, q.context.length, `question ${q.id} renders ${items.length} context items, posted ${q.context.length}`);
    for (const [i, item] of items.entries()) {
      assert.equal(item.getAttribute('data-block-kind'), q.context[i].kind,
        `context item ${i} of question ${q.id} renders out of posted order`);
      assert.equal(item.querySelector('.block-kicker'), null,
        `context item ${i} of question ${q.id} still renders a kind label`);
    }
  }
});

// =================================================================================
// 5. Every question carries a recorded answer.
// =================================================================================

check('every question block has an answered entry in board.answers, with a non-null choice', () => {
  const questions = questionBlocks(committedBoard);
  assert.ok(questions.length >= WIDGETS.length, 'setup failure: fewer questions than widgets');
  for (const q of questions) {
    const answer = committedBoard.answers[q.id];
    assert.ok(answer, `question ${q.id} (${q.widget}) has no entry in board.answers`);
    assert.equal(answer.status, 'answered', `question ${q.id} (${q.widget}) is not answered (status: ${answer.status})`);
    assert.notEqual(answer.choice, null, `question ${q.id} (${q.widget}) has a null choice`);
  }
});

// =================================================================================
// 6. All three comment-anchor flavors, every one resolved.
// =================================================================================

check('all three anchor kinds (block, dom, mermaid) are present, and every comment resolves', () => {
  const resolved = resolveComments(committedBoard, committedBoard.comments);
  assert.ok(resolved.length > 0, 'the committed board carries no comments at all');
  const kindsSeen = new Set(resolved.map(c => c.anchor?.kind));
  for (const kind of ['block', 'dom', 'mermaid']) {
    assert.ok(kindsSeen.has(kind), `no comment carries anchor.kind === "${kind}"`);
  }
  for (const c of resolved) {
    assert.equal(c.resolved, true, `comment #${c.n} on block ${c.blockId} did not resolve (lost: ${c.lost})`);
  }
});

// =================================================================================
// 7. Two rounds; the round pager names both and opens on the newest (ADR.md
//    entry 42 deleted the history rail the old assertions here checked for --
//    rounds are pages now, flipped by the pager, not stacked and collapsed).
// =================================================================================

check('the board has two rounds, and the round pager renders and names both', () => {
  assert.equal(committedBoard.rounds.length, 2, `expected exactly two rounds, got ${committedBoard.rounds.length}`);

  const roundSections = document.querySelectorAll('.round');
  assert.equal(roundSections.length, committedBoard.rounds.length, 'rendered .round count does not match board.rounds');

  assert.ok(document.querySelector('button#round-prev'), 'no previous-round chevron rendered');
  assert.ok(document.querySelector('button#round-next'), 'no next-round chevron rendered');
  const pager = document.querySelector('nav#round-pager');
  assert.ok(pager, 'no round-pager pill rendered');
  const pillEntries = [...pager.querySelectorAll('.round-page')];
  assert.equal(pillEntries.length, 2, 'the pill does not name exactly two rounds');
  assert.deepEqual(pillEntries.map(b => b.getAttribute('data-round')), ['1', '2'],
    'the pill does not name both round 1 and round 2');
});

check('the page opens on round 2, the newest round', () => {
  const current = document.querySelectorAll('.round-current');
  assert.equal(current.length, 1, 'exactly one round section may be the current page');
  assert.equal(current[0].getAttribute('data-round'), '2', 'the board does not open on its newest round');
});

// =================================================================================
// 8. Round 1 is a page board (one `html` block, nothing else); round 2 is not.
// =================================================================================

check('round 1 satisfies isPageRound and round 2 does not', () => {
  const round1Blocks = committedBoard.blocks.filter(b => b.round === 1);
  const round2Blocks = committedBoard.blocks.filter(b => b.round === 2);
  assert.equal(isPageRound(round1Blocks), true, 'round 1 is not a page board (one html block, nothing else)');
  assert.equal(isPageRound(round2Blocks), false, 'round 2 unexpectedly satisfies isPageRound -- it should be the block gallery');

  // The rendered half of the same rule: no card, no kicker, no column -- the
  // page-board section carries no .round-label and no .round-end rail
  // (renderRoundSection, src/render.mjs).
  const first = document.querySelectorAll('.round').find(el => el.getAttribute('data-round') === '1');
  assert.ok(first, 'no rendered round carries data-round="1"');
  assert.equal(first.querySelector('.round-label'), null, 'round 1 (a page board) still carries a round-label chip');
  assert.equal(first.querySelectorAll('.round-end').length, 0, 'round 1 (a page board) still carries an end rail');
  assert.equal(first.getAttribute('data-round-status'), 'open', 'round 1 (a page board) is never sent (ADR.md entry 35)');

  const second = document.querySelectorAll('.round').find(el => el.getAttribute('data-round') === '2');
  assert.ok(second, 'no rendered round carries data-round="2"');
  assert.ok(second.querySelector('.round-label'), 'round 2 (the gallery) unexpectedly renders with no round-label');
});

// =================================================================================
// 9. Round 2 is sent: every recorded answer reads back in full, every widget
//    rendered non-editable -- a sent page is not a second place to answer.
// =================================================================================

check('round 2 is sent, and every widget renders its recorded answer, non-editable', () => {
  assert.equal(committedBoard.rounds[1].status, 'sent', 'round 2 is not sent');
  const second = document.querySelectorAll('.round').find(el => el.getAttribute('data-round') === '2');
  assert.ok(String(second.getAttribute('class') || '').split(/\s+/).includes('round-history'),
    'a sent round does not carry the round-history class');
  assert.match(second.querySelector('.round-label').textContent, /\bsent\b/, 'round 2 is not labelled sent');

  const round2Questions = questionBlocks(committedBoard).filter(b => b.round === 2);
  assert.ok(round2Questions.length >= WIDGETS.length, 'round 2 does not carry a question for every widget');

  for (const q of round2Questions) {
    const answer = committedBoard.answers[q.id];
    assert.equal(answer.status, 'answered', `round 2's question ${q.id} (${q.widget}) is not answered`);
    const section = second.querySelector(`.question-block[data-block-id="${q.id}"]`);
    assert.ok(section, `round 2's question ${q.id} (${q.widget}) does not render`);

    // Every widget's own shape of "disabled" (src/render.mjs's renderWidget):
    // a native `disabled` attribute for single/multi/text, `draggable="false"`
    // for rank (a plain <li>, no native disabled state), `aria-disabled="true"`
    // for choose-between-rendered-variants (a plain <div role="button">).
    if (q.widget === 'single' || q.widget === 'multi') {
      const choices = [...section.querySelectorAll('.card-choice')];
      assert.ok(choices.length > 0, `round 2's ${q.widget} question renders no choices`);
      for (const c of choices) assert.equal(c.disabled, true, `a ${q.widget} choice is not disabled on a sent round`);
      assert.ok(choices.some(c => c.classList.contains('selected')), `no ${q.widget} choice renders as selected`);
    } else if (q.widget === 'text') {
      const textarea = section.querySelector('.answer-textarea');
      assert.ok(textarea, 'round 2\'s text question renders no textarea');
      assert.equal(textarea.disabled, true, 'the text answer is not disabled on a sent round');
      assert.equal(textarea.textContent, answer.choice, 'the text answer does not read back its recorded choice');
    } else if (q.widget === 'rank') {
      const items = [...section.querySelectorAll('.rank-list li')];
      assert.ok(items.length > 0, 'round 2\'s rank question renders no items');
      for (const li of items) assert.equal(li.getAttribute('draggable'), 'false', 'a rank item is still draggable on a sent round');
      assert.deepEqual(items.map(li => li.getAttribute('data-choice')), answer.choice,
        'the rank order rendered does not match the recorded answer');
    } else if (q.widget === 'choose-between-rendered-variants') {
      const cards = [...section.querySelectorAll('.choice-variant')];
      assert.ok(cards.length > 0, 'round 2\'s variant question renders no cards');
      for (const c of cards) assert.equal(c.getAttribute('aria-disabled'), 'true', 'a variant card is not aria-disabled on a sent round');
      assert.ok(cards.some(c => c.classList.contains('selected')), 'no variant card renders as selected');
    }
  }
});

// =================================================================================
// 10. No absolute path, machine name, username, or real-project content.
// =================================================================================

// Identity-SHAPED patterns, not this machine's actual username and hostname. The
// artifact is generated once, on one machine, and then verified forever on every
// other one -- so `text.includes(os.userInfo().username)` is structurally incapable
// of catching the leak it exists for: CI runs as `runner`, and the author's username
// baked into the committed bytes sails straight past. The reverse also bites --
// os.hostname() here is `Mac`, three characters, which false-positives on ordinary
// prose (it once matched `BlinkMacSystemFont` in a mock's font stack). A pattern
// catches a leak regardless of whose machine produced it, and cannot collide with an
// English word. Applied to all three committed artifacts, not just the JSON: the page
// inlines the whole document plus 400KB of script and style, and the generator is
// committed too.
const IDENTITY_PATTERNS = [
  [/\/Users\/[^/"\s\\]+/, 'a macOS home directory'],
  [/\/home\/[^/"\s\\]+/, 'a Linux home directory'],
  [/[A-Z]:\\\\?Users\\\\?/i, 'a Windows home directory'],
  [/\$HOME\b/, 'a $HOME reference'],
  [/\/var\/folders\//, 'a macOS per-user temp directory'],
  [/\/private\/(?:tmp|var)\//, 'a macOS private path'],
  [/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, 'an email address'],
  [/\b[\w-]+\.local\b/, 'a Bonjour hostname'],
];

check('the committed artifacts leak no absolute path, username, hostname or email', () => {
  for (const [name, text] of [
    ['sample-board.json', committedJsonText],
    ['sample-board.html', committedHtmlText],
    ['sample-board.mjs', readFileSync(path.join(examplesDir, 'sample-board.mjs'), 'utf8')],
  ]) {
    for (const [pattern, label] of IDENTITY_PATTERNS) {
      const hit = text.match(pattern);
      assert.ok(!hit, `committed ${name} contains ${label}: ${JSON.stringify(hit && hit[0])}`);
    }
  }
  assert.equal(committedBoard.cwd, null, 'the committed board must carry no project directory');
});

// =================================================================================
// 11. Opened from file://, the page is read-only.
// =================================================================================

check('loaded with location.protocol "file:", the page\'s body carries the readonly class', () => {
  const freshDocument = parseHTML(committedHtmlText);
  const window = freshDocument.defaultView;
  const location = { protocol: 'file:' };
  // 'EventSource' is DECLARED and never passed, binding the name to undefined inside
  // this scope so the guard fires by this file's choice rather than by whether this
  // node build happens to expose a global EventSource (behind a flag since 22.x).
  new Function('document', 'window', 'location', 'EventSource', ui)(freshDocument, window, location);
  assert.equal(freshDocument.body.classList.contains('readonly'), true,
    'body did not gain the readonly class when opened with location.protocol === "file:"');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall sample-board checks ok');
