// ADR.md entry 117: the daemon judges diagrams with the exact vendored engine
// before a round can be stored. This check stays at that engine seam so every
// grammar, refusal class, lazy-load boundary, and fail-open path is pinned without
// starting a daemon or involving the browser renderer -- and then one step out, at
// the board-normalisation door (src/board.mjs's createBoard), where a refusal names
// the block, fence, file, option or side it came from and the per-post budget runs.
//
// Every repo module is imported dynamically, after the globals snapshot: a static
// import would load the parser before the first check measures what importing it adds.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check, finish } from './support.mjs';

const globalsBeforeParserImport = Object.getOwnPropertyNames(globalThis).sort();
const rssBeforeImport = process.memoryUsage().rss;
let globalsAfterParserImport;
let rssAfterParserImport;
let globalsBeforeEngine;
let api;
let boardApi;
let importError;
try {
  api = await import('../src/mermaid-parse.mjs');
  globalsAfterParserImport = Object.getOwnPropertyNames(globalThis).sort();
  rssAfterParserImport = process.memoryUsage().rss;
  boardApi = await import('../src/board.mjs');
  await import('../src/server.mjs');
  globalsBeforeEngine = Object.getOwnPropertyNames(globalThis).sort();
} catch (err) {
  importError = err;
}

check('ADR.md entry 117: the sandboxed diagram parser module imports', () => {
  if (importError) throw importError;
  assert.equal(typeof api.checkDiagram, 'function');
  assert.equal(api.MERMAID_MAX_TEXT, 50_000);
});

if (!importError) {
  const { checkDiagram, MERMAID_MAX_TEXT } = api;
  const rssAfterImport = process.memoryUsage().rss;

  check('ADR.md entry 117: importing the parser does not add a daemon global or load the engine', () => {
    assert.deepEqual(globalsAfterParserImport, globalsBeforeParserImport);
    assert.ok(rssAfterParserImport - rssBeforeImport < 32 * 1024 * 1024,
      `parser import grew rss by ${rssAfterParserImport - rssBeforeImport} bytes; the engine appears to have loaded eagerly`);
  });

  const tooLong = 'x'.repeat(MERMAID_MAX_TEXT + 1);
  const overLimit = checkDiagram(tooLong);
  check('ADR.md entry 117: 50,001 characters are refused before the engine loads, naming both length and limit', () => {
    assert.deepEqual(overLimit, {
      message: "Diagram is 50,001 characters; Mermaid's limit is 50,000.",
      line: null,
    });
    assert.deepEqual(Object.getOwnPropertyNames(globalThis).sort(), globalsBeforeEngine);
    assert.ok(process.memoryUsage().rss - rssAfterImport < 16 * 1024 * 1024,
      'the over-limit precheck loaded the engine');
  });

  const fixtures = {
    flowchart: 'flowchart LR\n A --> B',
    sequence: 'sequenceDiagram\n Alice->>Bob: Hello',
    class: 'classDiagram\n class Animal',
    state: 'stateDiagram-v2\n [*] --> Still',
    er: 'erDiagram\n CUSTOMER ||--o{ ORDER : places',
    gantt: 'gantt\n title Work\n dateFormat YYYY-MM-DD\n section Build\n Task :a1, 2026-01-01, 1d',
    pie: 'pie\n "Dogs" : 1\n "Cats" : 2',
    gitGraph: 'gitGraph\n commit',
    mindmap: 'mindmap\n root((mindmap))\n  Origins',
    timeline: 'timeline\n title History\n 2026 : Event',
    journey: 'journey\n title Day\n section Morning\n Coffee: 5: Me',
    quadrant: 'quadrantChart\n x-axis Low --> High\n y-axis Low --> High\n quadrant-1 Reach\n A: [0.3, 0.6]',
    sankey: 'sankey-beta\nA,B,1',
    xychart: 'xychart-beta\n x-axis [1, 2]\n y-axis 0 --> 10\n line [2, 4]',
    block: 'block-beta\n columns 1\n A',
    requirement: 'requirementDiagram\n requirement test_req {\n  id: 1\n  text: the user must be able to search\n  risk: high\n  verifymethod: test\n }',
    c4: 'C4Context\n Person(person, "Person")',
    architecture: 'architecture-beta\n group api(cloud)[API]\n service server(server)[Server] in api',
    packet: 'packet-beta\n 0-7: "Header"',
    kanban: 'kanban\n column1[Todo]\n  task1[Task]',
    'front matter': '---\ntitle: Nodes\n---\nflowchart LR\n A --> B',
    'init directive': '%%{init: {"theme": "neutral"}}%%\nflowchart LR\n A --> B',
  };

  let firstCallMs = 0;
  let rssBeforeFirstCheck = 0;
  let rssAfterFirstCheck = 0;
  for (const [type, source] of Object.entries(fixtures)) {
    const start = performance.now();
    if (type === 'flowchart') rssBeforeFirstCheck = process.memoryUsage().rss;
    const result = checkDiagram(source);
    const elapsed = performance.now() - start;
    if (type === 'flowchart') {
      firstCallMs = elapsed;
      rssAfterFirstCheck = process.memoryUsage().rss;
    }
    check(`ADR.md entry 117: vendored Mermaid parses ${type}`, () => {
      assert.equal(result, null);
    });
  }

  check(`ADR.md entry 117: engine loads only on first in-limit check (${firstCallMs.toFixed(1)} ms, rss ${rssBeforeFirstCheck}->${rssAfterFirstCheck}) and leaks no global`, () => {
    assert.ok(rssAfterFirstCheck - rssBeforeFirstCheck > 20 * 1024 * 1024,
      `first check grew rss by only ${rssAfterFirstCheck - rssBeforeFirstCheck} bytes; engine load was not observed`);
    assert.deepEqual(Object.getOwnPropertyNames(globalThis).sort(), globalsBeforeEngine);
  });

  const syntax = checkDiagram('flowchart LR\n a --> ((b');
  check('ADR.md entry 117: a flowchart parse error is refused with its engine line', () => {
    assert.deepEqual(syntax, { message: 'Parse error on line 2:', line: 2 });
  });

  const lexical = checkDiagram('flowchart LR\n a --> §');
  check('ADR.md entry 117: a lexical error is refused with its engine line', () => {
    assert.equal(lexical?.message, 'Lexical error on line 2. Unrecognized text.');
    assert.equal(lexical?.line, 2);
  });

  const htmlBrNodeLog = [];
  const htmlBrNode = checkDiagram('flowchart LR\n a["x<br/>y"] --> b', { log: line => htmlBrNodeLog.push(line) });
  check('ADR.md entry 117: a flowchart with a <br/> node label passes with no fail-open log', () => {
    assert.equal(htmlBrNode, null);
    assert.equal(htmlBrNodeLog.length, 0);
  });

  const htmlBrEdgeLog = [];
  const htmlBrEdge = checkDiagram('flowchart LR\n a -->|"x<br/>y"| b', { log: line => htmlBrEdgeLog.push(line) });
  check('ADR.md entry 117: a flowchart with a <br/> edge label passes with no fail-open log', () => {
    assert.equal(htmlBrEdge, null);
    assert.equal(htmlBrEdgeLog.length, 0);
  });

  const htmlBoldLog = [];
  const htmlBold = checkDiagram('flowchart LR\n a["<b>x</b>"] --> b', { log: line => htmlBoldLog.push(line) });
  check('ADR.md entry 117: a flowchart with a <b> label passes with no fail-open log', () => {
    assert.equal(htmlBold, null);
    assert.equal(htmlBoldLog.length, 0);
  });

  const brokenHtmlLog = [];
  const brokenHtml = checkDiagram('flowchart LR\n a["x<br/>y"] --> ((b', { log: line => brokenHtmlLog.push(line) });
  check('ADR.md entry 117: a broken flowchart with a <br/> label is refused naming its line, not failed open', () => {
    assert.deepEqual(brokenHtml, { message: 'Parse error on line 2:', line: 2 });
    assert.equal(brokenHtmlLog.length, 0);
  });

  const unknown = checkDiagram('notADiagram\n A --> B');
  check('ADR.md entry 117: an unknown diagram type is refused', () => {
    assert.deepEqual(unknown, {
      message: 'No diagram type detected matching given configuration for text: notADiagram',
      line: null,
    });
  });

  // The echo the refusal carries is capped at ECHO_CAP characters, ellipsis included,
  // so the whole message is the engine's prefix plus that cap and nothing more: pinned
  // exactly, because a looser bound would sit green through any widening of the cap.
  const UNKNOWN_PREFIX = 'No diagram type detected matching given configuration for text: ';
  const ECHO_CAP = 80;
  const UNKNOWN_MESSAGE_LENGTH = UNKNOWN_PREFIX.length + ECHO_CAP;

  const longUnknownSource = `notADiagram ${'x'.repeat(39_988)}`;
  const longUnknown = checkDiagram(longUnknownSource);
  check(`ADR.md entry 117: a 40,000-character unknown-type line is refused in ${UNKNOWN_MESSAGE_LENGTH} characters`, () => {
    assert.equal(longUnknownSource.length, 40_000);
    assert.equal(UNKNOWN_MESSAGE_LENGTH, 144);
    assert.equal(longUnknown?.line, null);
    assert.equal(longUnknown.message.length, UNKNOWN_MESSAGE_LENGTH,
      `the refusal carried ${longUnknown.message.length} characters into the agent's context`);
    assert.equal(longUnknown.message.slice(UNKNOWN_PREFIX.length).length, ECHO_CAP);
    assert.ok(longUnknown.message.startsWith(`${UNKNOWN_PREFIX}notADiagram `),
      `unexpected refusal: ${String(longUnknown.message).slice(0, 120)}`);
    assert.ok(longUnknown.message.endsWith('…'));
  });

  // A cut that counted code units would land mid-pair here and hand the agent a lone
  // high surrogate, which survives JSON and reads as U+FFFD.
  const astralSource = `notADiagram ${'x'.repeat(66)}${'\u{1F600}'.repeat(20)}`;
  const astralUnknown = checkDiagram(astralSource);
  check('ADR.md entry 117: an echo cut inside astral characters ends on a whole character', () => {
    assert.ok(astralUnknown.message.isWellFormed(),
      `the refusal ends in a lone surrogate: ${JSON.stringify(astralUnknown.message.slice(-6))}`);
    const echo = astralUnknown.message.slice(UNKNOWN_PREFIX.length);
    assert.ok(echo.endsWith('…'));
    assert.doesNotMatch(echo.slice(0, -1), /[\uD800-\uDBFF]$/);
    assert.equal(Array.from(echo).length, ECHO_CAP);
    assert.ok(echo.endsWith('\u{1F600}…'),
      `unexpected echo tail: ${JSON.stringify(echo.slice(-4))}`);
  });

  const edges = Array.from({ length: 501 }, (_, i) => ` n${i} --> n${i + 1}`).join('\n');
  const edgeLimit = checkDiagram(`flowchart LR\n${edges}`);
  check('ADR.md entry 117: Mermaid engine limits refuse the diagram', () => {
    assert.deepEqual(edgeLimit, {
      message: 'Edge limit exceeded. 500 edges found, but the limit is 500.',
      line: null,
    });
  });

  const logged = [];
  const engineFailure = checkDiagram(42, { log: line => logged.push(line) });
  check('ADR.md entry 117: a non-diagram TypeError fails open and logs one line naming the input', () => {
    assert.equal(engineFailure, null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /42/);
    assert.match(logged[0], /TypeError/);
    assert.ok(!logged[0].includes('\n'));
  });


  // --- the board-normalisation door ------------------------------------------------
  const { createBoard } = boardApi;
  // board.mjs already loaded this module through src/markdown.mjs; the dynamic import
  // hands back that same instance, which the lex-count check below wraps.
  const { marked } = await import('../src/vendor/marked/marked.esm.js');

  /** The message a refused post came back with. Fails the check if the post was
   * accepted instead -- an assertion on a message nobody threw would pass by accident. */
  function refusedPost(post) {
    try {
      post();
    } catch (err) {
      return err.message;
    }
    throw new assert.AssertionError({ message: 'the post was accepted; a diagram that does not parse must refuse it' });
  }

  check('ADR.md entry 117: a bad mermaid block names its id and parser line, while the fixed block lands', () => {
    const bad = 'flowchart LR\n a --> ((b';
    const message = refusedPost(() => createBoard({
      title: 'bad mermaid',
      blocks: [{ id: 'm1', kind: 'mermaid', text: bad }],
    }));
    assert.equal(message,
      'mermaid block m1 does not parse. Parse error on line 2. Way out: fix the source and post again; a fence you cannot fix goes up by value with its language changed so it renders as code');
    assert.doesNotThrow(() => createBoard({
      title: 'fixed mermaid',
      blocks: [{ id: 'm1', kind: 'mermaid', text: 'flowchart LR\n a --> b' }],
    }));
  });

  check('ADR.md entry 117: bad by-value markdown fences name top-level, context and compare positions together', () => {
    const badFence = '```mermaid\nflowchart LR\n a --> ((b\n```';
    const lines = refusedPost(() => createBoard({
      title: 'three bad fences',
      blocks: [
        { kind: 'markdown', text: badFence },
        {
          kind: 'question', prompt: 'Context?', widget: 'single', options: [{ label: 'Yes' }],
          context: [{ kind: 'markdown', text: badFence }],
        },
        {
          kind: 'compare',
          left: { label: 'Left', block: { kind: 'markdown', text: badFence } },
          right: { label: 'Right', block: null },
        },
      ],
    })).split('\n');

    assert.equal(lines.length, 3, 'one refusal per fence, in one rejected post');
    assert.match(lines[0], /^mermaid fence 1 in markdown block d1 does not parse\. Parse error on line 2\. Way out:/);
    assert.match(lines[1], /^mermaid fence 1 in markdown block d2 in context 1 of question q1 does not parse\. Parse error on line 2\. Way out:/);
    assert.match(lines[2], /^mermaid fence 1 in markdown block d3 on left side of compare block x1 does not parse\. Parse error on line 2\. Way out:/);
  });

  check('ADR.md entry 117: a bad fence in referenced markdown names the posted file path', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'claude-board-diagram-refusal-'));
    try {
      writeFileSync(path.join(cwd, 'broken-diagram.md'), '```mermaid\nflowchart LR\n a --> ((b\n```\n', 'utf8');
      const message = refusedPost(() => createBoard({
        title: 'referenced bad fence',
        cwd,
        blocks: [{ kind: 'markdown', source: { path: 'broken-diagram.md' } }],
      }));
      assert.match(message, /^mermaid fence 1 in markdown block d1 from referenced file broken-diagram\.md does not parse\. Parse error on line 2\. Way out:/);
      assert.ok(message.includes('fix the file, or post the section by value with the fence marked as code'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  /** Every line `fn` printed through console.error, which is where src/board.mjs and the
   * diagram engine both log what they let through (ADR.md entry 117). */
  function capturedErrors(fn) {
    const printed = [];
    const original = console.error;
    console.error = (...args) => printed.push(args.join(' '));
    try {
      fn();
    } finally {
      console.error = original;
    }
    return printed;
  }

  check('ADR.md entry 117: a bad diagram inside a variant option names the option', () => {
    const message = refusedPost(() => createBoard({
      title: 'bad variant',
      blocks: [{
        kind: 'question',
        prompt: 'Which?',
        widget: 'choose-between-rendered-variants',
        options: [
          { label: 'Good', block: { kind: 'mermaid', text: 'flowchart LR\n a --> b' } },
          { label: 'Bad', block: { kind: 'mermaid', text: 'flowchart LR\n a --> ((b' } },
        ],
      }],
    }));
    assert.match(message,
      /^mermaid block m2 in option 2 of question q1 does not parse\. Parse error on line 2\. Way out:/);
  });

  check('ADR.md entry 117: a bad diagram on a compare right side names the side', () => {
    const message = refusedPost(() => createBoard({
      title: 'bad right side',
      blocks: [{
        kind: 'compare',
        left: { label: 'Left', block: { kind: 'markdown', text: '# Fine' } },
        right: { label: 'Right', block: { kind: 'mermaid', text: 'flowchart LR\n a --> ((b' } },
      }],
    }));
    assert.match(message,
      /^mermaid block m1 on right side of compare block x1 does not parse\. Parse error on line 2\. Way out:/);
  });

  check('ADR.md entry 117: a post past its diagram budget lands unchecked, with one line logged', () => {
    // MIN_DIAGRAM_COST is 500 characters and the post's whole allowance is 50,000, so a
    // hundred two-line diagrams spend it exactly -- the cheapest way to reach the end of
    // the budget, and the shape the budget exists for.
    const good = { kind: 'mermaid', text: 'flowchart LR\n a --> b' };
    const bad = { kind: 'mermaid', text: 'flowchart LR\n a --> ((b' };
    let board;
    const printed = capturedErrors(() => {
      board = createBoard({
        title: 'budget spent',
        blocks: [...Array.from({ length: 100 }, () => ({ ...good })), { ...bad }, { ...bad }],
      });
    });

    assert.equal(board.blocks.length, 102, 'a spent budget refuses nothing: the post lands whole');
    assert.equal(board.blocks[100].text, bad.text, 'the unchecked diagram is stored as posted');
    const budgetLines = printed.filter(line => line.includes('Diagram budget'));
    assert.equal(budgetLines.length, 1, 'one line per post, not one per diagram left unchecked');
    assert.match(budgetLines[0],
      /^Diagram budget of 50,000 characters ran out at mermaid block m101, which costs 500 with 0 left; the rest of this post's diagrams go unchecked$/);

    // The allowance is per post, not per process: the next post checks its first diagram.
    assert.match(refusedPost(() => createBoard({ title: 'next post', blocks: [{ ...bad }] })),
      /^mermaid block m1 does not parse\./);
  });

  check("ADR.md entry 117: a diagram over the engine's own limit is refused without touching the budget", () => {
    // `readJsonBody` admits 25 MB, so a diagram past the engine's 50,000-character text
    // limit is a legal post -- and the one diagram the engine is certain to reject. Its
    // refusal comes off a length test with no parse behind it, so it costs the budget
    // nothing and must not be paid for out of it: charging it would leave every later
    // diagram in the post unchecked for work nobody did.
    const head = 'flowchart LR\n a --> b\n%% ';
    const oversized = head + 'x'.repeat(50_001 - head.length);
    let lines;
    const printed = capturedErrors(() => {
      lines = refusedPost(() => createBoard({
        title: 'over the limit first',
        blocks: [
          { kind: 'mermaid', text: oversized },
          { kind: 'mermaid', text: 'flowchart LR\n a --> ((b' },
        ],
      })).split('\n');
    });

    assert.deepEqual(lines, [
      "mermaid block m1 does not parse. Diagram is 50,001 characters; Mermaid's limit is 50,000. Way out: fix the source and post again; a fence you cannot fix goes up by value with its language changed so it renders as code",
      'mermaid block m2 does not parse. Parse error on line 2. Way out: fix the source and post again; a fence you cannot fix goes up by value with its language changed so it renders as code',
    ]);
    assert.deepEqual(printed.filter(line => line.includes('Diagram budget')), [],
      'nothing was spent, so nothing is logged as spent');
  });

  check('ADR.md entry 117: a markdown block is lexed once on the post path', () => {
    const originalLexer = marked.lexer;
    let lexes = 0;
    marked.lexer = function countingLexer(...args) {
      lexes++;
      return originalLexer.apply(this, args);
    };
    try {
      createBoard({
        title: 'one lex per block',
        blocks: [
          { kind: 'markdown', text: '# Title\n\n```mermaid\nflowchart LR\n a --> b\n```\n' },
          {
            kind: 'question',
            prompt: 'Pick',
            widget: 'single',
            explainer: '```mermaid\nflowchart LR\n a --> b\n```',
            context: [{ kind: 'markdown', text: '```mermaid\nflowchart LR\n c --> d\n```' }],
            options: [{ label: 'Yes' }],
          },
        ],
      });
    } finally {
      marked.lexer = originalLexer;
    }
    // One per markdown document in the post: the block, the question's context block and
    // its explainer. The door reads its fences off those renders; lexing them again to
    // find the fences is the doubled markdown work ADR.md entry 117 does without.
    assert.equal(lexes, 3, 'every markdown document on the post path is lexed exactly once');
  });
}

finish(null, { failText: null });
