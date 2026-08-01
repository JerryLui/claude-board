// The prose-vs-shim checker, shipped as a product (SPEC_MIGRATION.md ticket 03 / criterion
// 12), generalised out of `test/check-grill.mjs`'s hand-rolled assertions. Every real caller
// of this module lives OUTSIDE this repo, in some `~/.claude/skills/<name>/check.mjs` or a
// command's own check script — a different git repo that must keep working when this one is
// not installed at all. This repo only proves the checker itself, against a fixture it owns
// (`test/fixtures/prose-check-*.md`, run by `test/check-prose-check.mjs`).
//
// What it asserts, given a prose file (a SKILL.md, a command's .md) and the shim's live
// `tools/list`:
//   - the file is substantial prose, not a stub
//   - it names the tool (default `ask`) literally
//   - the tool is real, and every argument name its live schema declares is named in the prose
//   - the prose does not claim an argument the shim's real schema does not have (parsed out of
//     a "`tool` with `{ a, b }`" sentence, the convention commands/grill.md already uses — when
//     that sentence is absent, this direction is skipped rather than guessed at)
//   - every block kind / widget the prose shows in a worked example (`kind: '...'`,
//     `widget: '...'`) is one PROTOCOL.md's own "### Blocks" section actually defines
// Which assertions generalise and which stay caller-specific was a judgement call: grill's
// "no HTML template of its own", "one question per call is gone" and "revive command" checks
// were about *that command's* own history and never generalised here. `test/check-grill.mjs`
// held them until SPEC_MIGRATION.md criterion 14 took its subject out of this repo entirely
// (ticket 04); whichever repo now owns `/grill`'s prose is where assertions like those belong.
//
// --- Resolution story: how a caller outside this repo finds this file --------------------
//
// The module cannot be imported by a hardcoded absolute path baked into each caller — the
// clone can live anywhere and can move. `install.sh` already writes the one thing that names
// the clone's location durably: the LaunchAgent plist at
// `~/Library/LaunchAgents/claude-board.plist` (`CLAUDE_BOARD_LAUNCH_AGENTS_DIR` overrides the
// directory), whose `WorkingDirectory` key is this clone's absolute root
// (`install.sh` step 2, "launchd plist"). That is the one source of truth this module reuses
// rather than inventing a second one (there is no repo-path file anywhere under
// `~/.config/claude-board` — only the secret lives there).
//
// `resolveInstalledRoot()` below reads that plist and returns the clone root, or `null` when
// claude-board is not installed. A caller *inside* this repo just imports this file directly
// (a normal relative import — this is that caller). A caller *outside* this repo cannot import
// this file to call `resolveInstalledRoot()`, because finding this file IS the problem that
// function solves — so the same handful of lines have to be copied, once, into the caller's
// own `check.mjs`. That copy is documented in `PROTOCOL.md` ("The prose-vs-shim checker") as
// the canonical, copy-pasteable bootstrap, kept in sync with the implementation here. Once
// pasted, using it is the one-liner criterion 2 asks for:
//
//   const checker = await loadClaudeBoardChecker();
//   if (!checker) { console.log('skip: claude-board not installed'); process.exit(0); }
//   await checker.assertProseMatchesShim(new URL('./SKILL.md', import.meta.url).pathname);
//
// A consumer with no claude-board installed gets `null` back, never a thrown error — degrade,
// not explode (criterion 2).

import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

const DEFAULT_LABEL = 'claude-board';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Resolution: find an installed claude-board clone from the LaunchAgent plist
// install.sh already writes (see the file comment above).
// ---------------------------------------------------------------------------

/** Reads `~/Library/LaunchAgents/claude-board.plist` (or the equivalent under
 * `launchAgentsDir`) and returns the clone root named in its `WorkingDirectory` key, or
 * `null` when there is no plist, or no such key — i.e. claude-board is not installed here.
 * Never throws: an unreadable or absent plist is exactly the "not installed" case. */
export function resolveInstalledRoot({
  launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents'),
  label = DEFAULT_LABEL,
} = {}) {
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  let xml;
  try {
    xml = readFileSync(plistPath, 'utf8');
  } catch {
    return null;
  }
  const m = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  if (!m) return null;
  const root = m[1].trim();
  return root || null;
}

/** The programmatic half of the resolution story, for code that already has some way to
 * import this file (this repo's own tests; a future caller reachable some other way, e.g. a
 * monorepo symlink). Returns this module's own exports loaded from the *installed* clone
 * (which may not be this file at all, if called from a different checkout), or `null` with a
 * console.error explaining why — never throws. Real external callers cannot call this
 * function without already having it, which is exactly why `PROTOCOL.md` documents the small
 * bootstrap that inlines the same two steps (resolve, then dynamic import) instead. */
export async function loadInstalledChecker(opts = {}) {
  const root = resolveInstalledRoot(opts);
  if (!root) {
    console.error(
      '[prose-check] claude-board is not installed on this machine (no LaunchAgent plist ' +
      'found at ~/Library/LaunchAgents/claude-board.plist) — skipping the prose-vs-shim check.'
    );
    return null;
  }
  const modulePath = path.join(root, 'src', 'prose-check.mjs');
  if (!existsSync(modulePath)) {
    console.error(
      `[prose-check] found a claude-board clone at ${root} (from the installed LaunchAgent ` +
      `plist) but it has no src/prose-check.mjs — an old install predating this checker. Skipping.`
    );
    return null;
  }
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (err) {
    console.error(`[prose-check] failed to load ${modulePath}: ${err && err.message || err} — skipping.`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PROTOCOL.md's own vocabulary: the block kinds and widgets under "### Blocks", and the
// packet statuses under "## Packet". Mined from test/check-grill.mjs's packet-status parse
// (same technique: read the value out of the doc rather than hardcode a copy here too).
// ---------------------------------------------------------------------------

/** `{ blockKinds, widgets }`, parsed out of the fenced code block directly under PROTOCOL.md's
 * "### Blocks" heading — never a hardcoded copy, so a protocol change updates one file. Throws
 * if that section is missing or unparseable: a checker that silently saw zero kinds would pass
 * every prose file by vacuous truth, which is worse than failing loudly. */
export function parseBlockShapes(protocolText) {
  const idx = protocolText.indexOf('### Blocks');
  if (idx === -1) throw new Error("PROTOCOL.md: expected a '### Blocks' section");
  const after = protocolText.slice(idx);
  const fenceStart = after.indexOf('```js');
  if (fenceStart === -1) throw new Error("PROTOCOL.md: expected a ```js fence under '### Blocks'");
  const fenceEnd = after.indexOf('```', fenceStart + 5);
  if (fenceEnd === -1) throw new Error("PROTOCOL.md: unterminated ```js fence under '### Blocks'");
  const section = after.slice(fenceStart, fenceEnd);

  // Scoped to that one fence deliberately: the later "### Answers, comments, anchors" section
  // also declares `{ kind: 'block' }` / `{ kind: 'md' }` / etc for Anchor, a different
  // vocabulary entirely, and must never leak into "real block kinds".
  const blockKinds = [...new Set([...section.matchAll(/\{\s*kind:\s*'([\w-]+)'/g)].map(m => m[1]))];
  const widgetLine = section.match(/^widget\s*=\s*(.+)$/m);
  if (!widgetLine) throw new Error("PROTOCOL.md: expected a 'widget = ...' union line under '### Blocks'");
  const widgets = [...widgetLine[1].matchAll(/'([\w-]+)'/g)].map(m => m[1]);

  if (!blockKinds.length) throw new Error("PROTOCOL.md: found no block kinds under '### Blocks'");
  if (!widgets.length) throw new Error('PROTOCOL.md: found no widgets in the widget union line');
  return { blockKinds, widgets };
}

/** Every status the Packet can carry, read out of PROTOCOL.md's own `status,` line — the same
 * parse `test/check-grill.mjs` already does inline, generalised here so both share it. */
export function parsePacketStatuses(protocolText) {
  const line = protocolText.split('\n').find(l => /^\s*status,/.test(l));
  if (!line) throw new Error("PROTOCOL.md: expected a 'status,' line documenting the Packet's allowed values");
  const statuses = [...line.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  if (statuses.length < 2) throw new Error(`PROTOCOL.md: expected at least 2 packet statuses, found: ${statuses.join(', ') || 'none'}`);
  return statuses;
}

// ---------------------------------------------------------------------------
// What a prose file CLAIMS, auto-detected from its own worked examples — the same
// `kind: 'x'` / `widget: 'x'` object-literal convention commands/grill.md already writes its
// examples in, plus the "`tool` with `{ a, b }`" sentence it uses to state the tool's whole
// argument list.
// ---------------------------------------------------------------------------

export function extractClaims(proseText, toolName = 'ask') {
  const blockKinds = [...new Set([...proseText.matchAll(/kind:\s*'([\w-]+)'/g)].map(m => m[1]))];
  const widgets = [...new Set([...proseText.matchAll(/widget:\s*'([\w-]+)'/g)].map(m => m[1]))];
  const callShape = proseText.match(new RegExp('`' + escapeRegExp(toolName) + '`\\s+with\\s+`\\{([^}]*)\\}`'));
  const args = callShape ? callShape[1].split(',').map(s => s.trim()).filter(Boolean) : null;
  return { blockKinds, widgets, args };
}

// ---------------------------------------------------------------------------
// Whether a prose file "shows" a given argument name at all — two conventions, not one.
// `commands/grill.md` backticks each argument on its own (`` `title` ``); `/visualize`,
// `/explain` and `/gamify` instead show a fenced worked example whose object keys ARE the
// argument names (`ask({ title: ..., blocks: [...] })`). The first version of this checker
// only recognised the first convention, which failed all three of those real callers on
// arguments they name in the clearest possible form — asserting a formatting convention
// instead of the behaviour ("does the prose demonstrably show this argument"). Deliberately
// NOT a bare substring match: `title` and `blocks` are ordinary English words, and matching
// them unscoped would make the assertion vacuous (SPEC_MIGRATION.md's own "Testing" section
// names exactly this failure mode).
// ---------------------------------------------------------------------------

/** Every fenced code block's contents, concatenated — where the object-key convention is
 * scoped to, so an English sentence that happens to contain "title:" as prose (a caption, a
 * label) never counts. */
export function extractFencedCode(proseText) {
  return [...proseText.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
}

/** True when `argName` appears either backticked anywhere in the prose, or as an object key
 * inside a fenced code block — `argName: value` (explicit), or the ES6 shorthand property
 * `argName,`/`argName }` that two of the three real renderer skills actually use (`{ title,
 * blocks: [...] }`, where `title` alone is both the local variable and the key). Bounded by a
 * non-identifier character (or start of line) on the left, so `subtitle:` never counts as
 * naming `title`; bounded by `:`, `,` or `}` (whitespace-tolerant) on the right, so this stays
 * "appears in object-literal position", not a bare substring match. */
export function argumentNamedInProse(proseText, argName, fencedCode = extractFencedCode(proseText)) {
  if (new RegExp('`' + escapeRegExp(argName) + '`').test(proseText)) return true;
  return new RegExp('(?:^|[^\\w$])' + escapeRegExp(argName) + '\\s*[:,}]', 'm').test(fencedCode);
}

// ---------------------------------------------------------------------------
// The assertion itself: pure, given the prose text and the live shim's tools/list (plus,
// optionally, PROTOCOL.md's text for the block-kind/widget checks). No process spawning here
// — that lives in getLiveTools/checkProseFile below — so this half is trivial to unit test.
// ---------------------------------------------------------------------------

/** Runs the battery and returns `{ ok, failures, claims, schemaProps }` — it never throws
 * itself (each assertion is caught and recorded), so a caller can decide how to report or
 * exit. `claimedArgNames`, when passed explicitly, overrides the auto-detected `{ a, b }`
 * sentence — the opt-in escape hatch for prose that states its arguments some other way. */
export function checkProse({
  proseText,
  tools,
  protocolText,
  toolName = 'ask',
  minLength = 100,
  claimedArgNames,
} = {}) {
  const failures = [];
  const record = (name, fn) => {
    try {
      fn();
    } catch (err) {
      failures.push({ name, message: (err && err.message) || String(err) });
    }
  };

  record('prose is substantial, not a stub', () => {
    assert.ok(
      typeof proseText === 'string' && proseText.length >= minLength,
      `expected at least ${minLength} chars of prose, got ${proseText ? proseText.length : 0}`
    );
  });

  record(`names the \`${toolName}\` tool literally`, () => {
    assert.match(proseText, new RegExp('`' + escapeRegExp(toolName) + '`'), `prose must reference \`${toolName}\``);
  });

  const tool = (tools || []).find(t => t.name === toolName);
  record(`\`${toolName}\` is a tool the shim's live tools/list actually exposes`, () => {
    assert.ok(tool, `shim has no tool named "${toolName}" (live tools: ${(tools || []).map(t => t.name).join(', ') || 'none'})`);
  });

  const schemaProps = tool ? Object.keys((tool.inputSchema && tool.inputSchema.properties) || {}) : [];

  if (tool) {
    const fencedCode = extractFencedCode(proseText);
    record(`every real \`${toolName}\` argument is named in the prose`, () => {
      const missing = schemaProps.filter(name => !argumentNamedInProse(proseText, name, fencedCode));
      assert.deepEqual(missing, [], `prose never mentions argument(s): ${missing.join(', ')}`);
    });
  }

  const claims = extractClaims(proseText, toolName);
  const args = claimedArgNames !== undefined ? claimedArgNames : claims.args;
  if (tool && args) {
    record(`prose does not claim a \`${toolName}\` argument the shim does not expose`, () => {
      const unknown = args.filter(name => !schemaProps.includes(name));
      assert.deepEqual(
        unknown, [],
        `prose claims argument(s) the shim's real schema does not have: ${unknown.join(', ')} (real: ${schemaProps.join(', ')})`
      );
    });
  }

  if (protocolText) {
    const { blockKinds: realBlockKinds, widgets: realWidgets } = parseBlockShapes(protocolText);
    if (claims.blockKinds.length) {
      record('every block kind the prose shows in a worked example is one PROTOCOL.md defines', () => {
        const unknown = claims.blockKinds.filter(k => !realBlockKinds.includes(k));
        assert.deepEqual(unknown, [], `prose shows block kind(s) not in PROTOCOL.md: ${unknown.join(', ')} (real: ${realBlockKinds.join(', ')})`);
      });
    }
    if (claims.widgets.length) {
      record('every widget the prose shows in a worked example is one PROTOCOL.md defines', () => {
        const unknown = claims.widgets.filter(w => !realWidgets.includes(w));
        assert.deepEqual(unknown, [], `prose shows widget(s) not in PROTOCOL.md: ${unknown.join(', ')} (real: ${realWidgets.join(', ')})`);
      });
    }
  }

  return { ok: failures.length === 0, failures, claims, schemaProps };
}

// ---------------------------------------------------------------------------
// Getting the shim's live tools/list. A minimal scripted JSON-RPC 2.0 client over a child
// process's stdio, mined from test/check-grill.mjs's McpClient — same shape, kept local since
// this only ever needs initialize/tools-list, never a held-open wait.
// ---------------------------------------------------------------------------

class McpClient {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.on('data', chunk => this._onData(chunk));
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pend = this.pending.get(msg.id);
        if (pend) { this.pending.delete(msg.id); pend(msg); }
      }
    }
  }
  request(method, params) {
    const id = this.nextId++;
    const p = new Promise(resolve => this.pending.set(id, resolve));
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  close() {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    try { this.child.kill(); } catch { /* already dead */ }
  }
}

/** Spawns `mcpPath` (the shim entry point, e.g. `<repoRoot>/bin/mcp.mjs`), does
 * initialize + tools/list, and returns the live `tools` array. `env` is merged over
 * `process.env`, the same shape `child_process.spawn` always takes. */
export async function getLiveTools({ mcpPath, env = {} } = {}) {
  if (!mcpPath) throw new Error('getLiveTools requires mcpPath: the absolute path to the shim entry point');
  const child = spawn(process.execPath, [mcpPath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new McpClient(child);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'prose-check', version: '0.0.0' },
    });
    client.notify('notifications/initialized', {});
    const res = await client.request('tools/list', {});
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    return res.result.tools;
  } finally {
    client.close();
  }
}

// ---------------------------------------------------------------------------
// The one-call entry point criterion 3 asks for: given a prose file path, do the whole thing
// — spin up a throwaway daemon and shim (never the caller's real installed one; a check run
// must never touch a real store or a real secret), fetch the live tools/list, read this same
// clone's own PROTOCOL.md, and run checkProse. `mcpPath`/`protocolText` resolve against
// REPO_ROOT (this file's own location) by default, which is the installed clone's root once
// this module has been reached via resolveInstalledRoot/loadInstalledChecker — so a caller
// outside this repo gets its OWN installed shim and protocol checked, with no path of its own
// to supply.
// ---------------------------------------------------------------------------

export async function checkProseFile(proseFilePath, options = {}) {
  const proseText = readFileSync(proseFilePath, 'utf8');
  const home = mkdtempSync(path.join(tmpdir(), 'claude-board-prose-check-'));
  const secretFile = path.join(home, 'secret');
  writeFileSync(secretFile, 'd'.repeat(64), { mode: 0o600 });

  // The daemon's request handler reads CLAUDE_BOARD_SECRET_FILE from THIS process's own env
  // (it runs in-process via startServer, not spawned), so it has to be set here too, not only
  // in the shim child's env below — same seam test/check-grill.mjs uses. Restored afterwards
  // so a second call in the same process (this repo's own self-test checks two fixtures) does
  // not leak one fixture's temp secret into the next.
  const prevSecretFile = process.env.CLAUDE_BOARD_SECRET_FILE;
  process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;

  const { server, port } = await startServer({ home, port: 0 });
  try {
    const mcpPath = options.mcpPath || path.join(REPO_ROOT, 'bin', 'mcp.mjs');
    const tools = await getLiveTools({
      mcpPath,
      env: {
        CLAUDE_BOARD_HOME: home,
        CLAUDE_BOARD_PORT: String(port),
        CLAUDE_BOARD_NO_OPEN: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_BOARD_SECRET_FILE: secretFile,
      },
    });
    const protocolText = options.protocolText !== undefined
      ? options.protocolText
      : readProtocolTextIfPresent();
    return checkProse({ ...options, proseText, tools, protocolText });
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (prevSecretFile === undefined) delete process.env.CLAUDE_BOARD_SECRET_FILE;
    else process.env.CLAUDE_BOARD_SECRET_FILE = prevSecretFile;
  }
}

function readProtocolTextIfPresent() {
  try {
    return readFileSync(path.join(REPO_ROOT, 'PROTOCOL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/** `result.failures` is an array of `{ name, message }` objects — useful to a caller that
 * wants to inspect them programmatically, but `String(failures)` / `` `${failures}` `` on an
 * array of objects renders `[object Object]`, which is exactly the trap a caller reaches for
 * first. This is the one place that rendering is spelled out, so every user-facing surface
 * (the thrown Error below, or a caller printing `result.failures` itself) reads the same way. */
export function formatFailures(failures) {
  return failures.map(f => `- ${f.name}: ${f.message}`).join('\n');
}

/** The literal one-liner: run the whole check, print each assertion, and throw a single
 * summary error if anything failed (so a caller's own `check.mjs` can do
 * `await assertProseMatchesShim(path)` and let it propagate to a top-level `.catch`, exactly
 * the pattern `test/check-grill.mjs` already uses for its own `main().catch(...)`). The
 * thrown Error's own `.message` carries the full readable summary, not just a count — a
 * caller that does the natural thing (`console.error(err.message)`) sees every failure's name
 * and message, never `[object Object]`. */
export async function assertProseMatchesShim(proseFilePath, options = {}) {
  const result = await checkProseFile(proseFilePath, options);
  for (const f of result.failures) {
    console.error(`FAIL - ${f.name}\n  ${f.message}`);
  }
  if (!result.ok) {
    throw new Error(
      `${result.failures.length} prose-vs-shim check(s) failed for ${proseFilePath}:\n${formatFailures(result.failures)}`
    );
  }
  console.log(`ok - prose-vs-shim checks passed for ${proseFilePath}`);
  return result;
}
