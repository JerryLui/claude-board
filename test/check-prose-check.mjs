// src/prose-check.mjs check: this repo ships the shared prose-vs-shim checker as a product
// and proves it here, against a fixture prose
// file this repo owns (test/fixtures/prose-check-*.md) — every REAL caller lives outside this
// repo, so this is the one place the checker's own correctness is on the hook.
//
// Two directions, both required (a checker that only ever passes is worth nothing):
//   - test/fixtures/prose-check-good.md must PASS every check
//   - test/fixtures/prose-check-drifted.md must FAIL, specifically on the argument the shim
//     does not expose AND the widget that does not exist — not just "something failed"
//
// Plus unit coverage of the pure pieces (parseBlockShapes, parsePacketStatuses,
// extractClaims) and the resolution story (resolveInstalledRoot / loadInstalledChecker),
// which the two fixture runs above exercise only indirectly.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBlockShapes,
  parsePacketStatuses,
  extractClaims,
  checkProse,
  checkProseFile,
  formatFailures,
  resolveInstalledRoot,
  loadInstalledChecker,
  REPO_ROOT,
} from '../src/prose-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'test', 'fixtures');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

async function main() {
  // --- pure parsing, unit-level -------------------------------------------------------

  await check('parseBlockShapes reads real block kinds and widgets out of PROTOCOL.md', () => {
    const protocolText = `
### Blocks

\`\`\`js
{ kind: 'markdown', source: Ref|null, text, sha, html, anchors: [Anchor], error? }
{ kind: 'mermaid',  source: Ref|null, text, sha, error? }
{ kind: 'code',     source: Ref,      text, sha, lang, error? }
{ kind: 'html',     html }
{ kind: 'compare',  left: { label, block }, right: { label, block } }
{ kind: 'question', prompt, context: [ContentBlock], widget, options: [Option] }

Ref    = { path, section?, lines? }
Option = { label, description?, preview? }
widget = 'single' | 'multi' | 'text' | 'rank'
\`\`\`

### Answers, comments, anchors

\`\`\`js
Anchor  = { kind: 'block' }
        | { kind: 'md', ref, label }
        | { kind: 'dom', ref, hint }
\`\`\`
`;
    const { blockKinds, widgets } = parseBlockShapes(protocolText);
    assert.deepEqual(blockKinds, ['markdown', 'mermaid', 'code', 'html', 'compare', 'question']);
    assert.deepEqual(widgets, ['single', 'multi', 'text', 'rank']);
    // The Anchor section's kinds (block/md/dom) must never leak into "real block kinds" —
    // it is a different vocabulary, and 'block' or 'md' passing as a content block kind would
    // be exactly the false-negative this scoping exists to prevent.
    assert.ok(!blockKinds.includes('block'), 'Anchor kind "block" leaked into block kinds');
    assert.ok(!blockKinds.includes('md'), 'Anchor kind "md" leaked into block kinds');
  });

  await check('parseBlockShapes against the REAL PROTOCOL.md in this repo', () => {
    const protocolText = readRepoFile('PROTOCOL.md');
    const { blockKinds, widgets } = parseBlockShapes(protocolText);
    for (const k of ['markdown', 'mermaid', 'code', 'html', 'compare', 'question']) {
      assert.ok(blockKinds.includes(k), `expected real PROTOCOL.md to define block kind "${k}"`);
    }
    for (const w of ['single', 'multi', 'text', 'rank']) {
      assert.ok(widgets.includes(w), `expected real PROTOCOL.md to define widget "${w}"`);
    }
  });

  await check('parsePacketStatuses reads every status off the real PROTOCOL.md Packet line', () => {
    const protocolText = readRepoFile('PROTOCOL.md');
    const statuses = parsePacketStatuses(protocolText);
    for (const s of ['submitted', 'discuss', 'timeout', 'error']) {
      assert.ok(statuses.includes(s), `expected PROTOCOL.md to declare packet status "${s}"`);
    }
  });

  await check('extractClaims auto-detects kind/widget examples and the "{ a, b }" call shape', () => {
    const text = "Call `ask` with `{ title, blocks }`. Example: { kind: 'code', ... } and widget: 'single'.";
    const claims = extractClaims(text, 'ask');
    assert.deepEqual(claims.blockKinds, ['code']);
    assert.deepEqual(claims.widgets, ['single']);
    assert.deepEqual(claims.args, ['title', 'blocks']);
  });

  await check('extractClaims returns null args when the "{ a, b }" sentence is absent (opt-in, not guessed)', () => {
    const claims = extractClaims('This prose never states its call shape.', 'ask');
    assert.equal(claims.args, null);
  });

  // --- resolution story ----------------------------------------------------------------

  await check('resolveInstalledRoot returns null when no plist exists (not installed)', () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'claude-board-no-plist-'));
    try {
      assert.equal(resolveInstalledRoot({ launchAgentsDir: emptyDir }), null);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  await check('resolveInstalledRoot reads WorkingDirectory out of a real-shaped plist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-fake-launchagents-'));
    try {
      const fakeRoot = '/tmp/some-claude-board-clone';
      writeFileSync(
        path.join(dir, 'claude-board.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>claude-board</string>
	<key>WorkingDirectory</key>
	<string>${fakeRoot}</string>
</dict>
</plist>
`,
        'utf8'
      );
      assert.equal(resolveInstalledRoot({ launchAgentsDir: dir }), fakeRoot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('loadInstalledChecker degrades to null (not throw) when nothing is installed', async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'claude-board-no-plist-'));
    try {
      const result = await loadInstalledChecker({ launchAgentsDir: emptyDir });
      assert.equal(result, null);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  await check('loadInstalledChecker degrades to null when the plist names a clone with no prose-check.mjs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-fake-launchagents-'));
    const staleClone = mkdtempSync(path.join(tmpdir(), 'claude-board-stale-clone-'));
    try {
      writeFileSync(
        path.join(dir, 'claude-board.plist'),
        plistNaming(staleClone),
        'utf8'
      );
      const result = await loadInstalledChecker({ launchAgentsDir: dir });
      assert.equal(result, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(staleClone, { recursive: true, force: true });
    }
  });

  await check('loadInstalledChecker successfully loads a real clone (this one) via its plist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-board-fake-launchagents-'));
    try {
      writeFileSync(path.join(dir, 'claude-board.plist'), plistNaming(REPO_ROOT), 'utf8');
      const mod = await loadInstalledChecker({ launchAgentsDir: dir });
      assert.ok(mod, 'expected loadInstalledChecker to resolve this repo and load it');
      assert.equal(typeof mod.checkProse, 'function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- the fixtures: both directions ----------------------------------------------------

  await check('the good fixture passes every check', async () => {
    const result = await checkProseFile(path.join(fixturesDir, 'prose-check-good.md'));
    if (!result.ok) {
      console.error('unexpected failures:', JSON.stringify(result.failures, null, 2));
    }
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  await check('the drifted fixture FAILS, specifically on the bogus argument and the bogus widget', async () => {
    const result = await checkProseFile(path.join(fixturesDir, 'prose-check-drifted.md'));
    assert.equal(result.ok, false, 'expected the drifted fixture to fail at least one check');
    const messages = result.failures.map(f => f.message).join('\n');
    assert.match(messages, /notes/, 'expected the checker to name the "notes" argument the shim does not expose');
    assert.match(messages, /checkbox/, 'expected the checker to name the "checkbox" widget that does not exist');
  });

  // A checker that only ever recognised backticked arguments would pass a fixture using
  // ONLY that convention and never notice the fenced-object-key convention was unimplemented
  // — which is exactly what let /visualize, /explain and /gamify fail spuriously the first
  // time around. These two fixtures never backtick their argument names at all, so they can
  // only pass or fail through the fenced-code path.

  await check('the good-fenced fixture (arguments named only as fenced object keys, including ES6 shorthand) passes every check', async () => {
    const result = await checkProseFile(path.join(fixturesDir, 'prose-check-good-fenced.md'));
    if (!result.ok) {
      console.error('unexpected failures:', JSON.stringify(result.failures, null, 2));
    }
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  await check('the drifted-fenced fixture (a fenced example missing a real argument) still FAILS', async () => {
    const result = await checkProseFile(path.join(fixturesDir, 'prose-check-drifted-fenced.md'));
    assert.equal(result.ok, false, 'expected the drifted-fenced fixture to fail at least one check');
    const messages = result.failures.map(f => f.message).join('\n');
    assert.match(messages, /blocks/, 'expected the checker to name the missing "blocks" argument');
  });

  // The three real renderer SKILL.md files that failed spuriously (/visualize, /explain,
  // /gamify) live in a different git repo (~/.claude/skills/) and are deliberately NOT
  // exercised here: this repo's own suite proves the checker against a fixture it owns and
  // controls, never against another repo's files at a path this repo has no business
  // assuming exists. That verification was
  // done ad hoc instead — see the task report — and belongs to each skill's own check.mjs
  // once that work lands, not to test/run.mjs here.

  // --- checkProse's pure half, directly, with a hand-built tools/list (no shim spawned) --

  await check('checkProse: an explicit claimedArgNames override catches a bogus arg with no "{ a, b }" sentence', () => {
    const tools = [{ name: 'ask', inputSchema: { type: 'object', properties: { title: {}, blocks: {} }, required: ['title', 'blocks'] } }];
    const proseText = 'Post through `ask`. It takes a title and some blocks, no more than that, and returns a packet.'.padEnd(120, ' ');
    const result = checkProse({ proseText, tools, claimedArgNames: ['title', 'blocks', 'notes'] });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => /does not expose/.test(f.name)));
  });

  await check('checkProse: passes cleanly on well-formed prose with no PROTOCOL.md text supplied (block/widget checks skipped, not failed)', () => {
    const tools = [{ name: 'ask', inputSchema: { type: 'object', properties: { title: {}, blocks: {} }, required: ['title', 'blocks'] } }];
    const proseText = 'Call `ask` with `{ title, blocks }` to post a round. `title` names the round, `blocks` carries its content.'.padEnd(140, ' ');
    const result = checkProse({ proseText, tools });
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  // --- delegating-caller mode ---------------------------------------------------
  // The regression this exists for: `commands/grill.md` and `commands/wayfind.md` were
  // migrated to point at the manual instead of restating the call, and the full battery
  // then failed them for exactly that fix.
  const delegatingTools = [{ name: 'ask', inputSchema: { type: 'object', properties: { title: {}, blocks: {} } } }];
  const delegatingProse = 'Questions go through the board. Read the `claude-board` skill for the call, the widgets and the packet.'.padEnd(140, ' ');

  await check('checkProse: delegating prose passes without naming the tool or its arguments', () => {
    const result = checkProse({ proseText: delegatingProse, tools: delegatingTools, delegatesTo: 'claude-board' });
    assert.equal(result.ok, true, formatFailures(result.failures));
  });

  await check('checkProse: the same prose fails the full battery, so the mode is doing the work', () => {
    const result = checkProse({ proseText: delegatingProse, tools: delegatingTools });
    assert.equal(result.ok, false);
  });

  await check('checkProse: delegating prose that drops the pointer at the manual fails', () => {
    const orphaned = 'Questions go through the board somehow. Post the round and read the answers back.'.padEnd(140, ' ');
    const result = checkProse({ proseText: orphaned, tools: delegatingTools, delegatesTo: 'claude-board' });
    assert.ok(result.failures.some(f => /owns the call/.test(f.name)));
  });

  await check('checkProse: delegating mode still rejects vocabulary the caller invents', () => {
    const invented = 'Read the `claude-board` skill for the call. Attach `context: [{ kind: \'hologram\' }]` to the question.'.padEnd(140, ' ');
    const result = checkProse({
      proseText: invented,
      tools: delegatingTools,
      delegatesTo: 'claude-board',
      protocolText: readRepoFile('PROTOCOL.md'),
    });
    assert.ok(result.failures.some(f => /block kind/.test(f.name)));
  });

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all prose-check checks ok');
}

function readRepoFile(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function plistNaming(workingDirectory) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>claude-board</string>
	<key>WorkingDirectory</key>
	<string>${workingDirectory}</string>
</dict>
</plist>
`;
}

main().catch(err => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
