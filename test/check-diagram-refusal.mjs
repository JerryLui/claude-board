// ADR.md entry 117: the daemon judges diagrams with the exact vendored engine
// before a round can be stored. This check stays at that engine seam so every
// grammar, refusal class, lazy-load boundary, and fail-open path is pinned without
// starting a daemon or involving the browser renderer.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

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

const globalsBeforeParserImport = Object.getOwnPropertyNames(globalThis).sort();
const rssBeforeImport = process.memoryUsage().rss;
let globalsAfterParserImport;
let rssAfterParserImport;
let globalsBeforeEngine;
let api;
let importError;
try {
  api = await import('../src/mermaid-parse.mjs');
  globalsAfterParserImport = Object.getOwnPropertyNames(globalThis).sort();
  rssAfterParserImport = process.memoryUsage().rss;
  await import('../src/board.mjs');
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

  const parseTimes = [];
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
    } else {
      parseTimes.push(elapsed);
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

  const fastest = Math.min(...parseTimes);
  const slowest = Math.max(...parseTimes);
  check(`ADR.md entry 117: measured engine parse range ${fastest.toFixed(1)}-${slowest.toFixed(1)} ms`, () => {
    assert.ok(Number.isFinite(fastest) && Number.isFinite(slowest));
  });
}

if (failures) process.exit(1);
