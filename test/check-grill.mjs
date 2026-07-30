// /grill command check: `commands/grill.md` is prose, not code, so this binds
// only what is mechanically checkable (ticket 09 / SPEC_BOARD.md "`/grill` asks
// in branch-sized rounds"):
//
//   - the file exists and carries no HTML template of its own
//   - the old "one question per tool call" rule is gone
//   - it calls the board's `ask` tool with argument names that ACTUALLY MATCH
//     what bin/mcp.mjs exposes today — parsed live off the shim's real
//     tools/list response, never a hardcoded copy, so this check catches the
//     command's instructions drifting from the tool's real shape
//   - all four widgets (single/multi/text/rank) and the three packet statuses
//     it must handle (submitted/discuss/timeout) are named
//   - the revive command it tells the user matches the one bin/mcp.mjs
//     actually prints when the daemon is unreachable — parsed live off a real
//     "daemon unreachable" tool response, the same class of bug (a string
//     copied once and left to drift) that has already bitten this project
//     twice
//
// No browser, no real daemon left running: a throwaway server is started and
// immediately closed to produce a genuinely dead port, same technique
// check-mcp.mjs uses for its "unreachable daemon" case.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from '../src/server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grillPath = path.join(repoRoot, 'commands', 'grill.md');
const mcpBin = path.join(repoRoot, 'bin', 'mcp.mjs');

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

/** Minimal scripted JSON-RPC 2.0 client over a child process's stdio — same
 * shape as check-mcp.mjs's McpClient, kept local and small since this check
 * only needs initialize/tools-list/tools-call, never a held-open wait. */
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

function spawnShim(env) {
  const child = spawn(process.execPath, [mcpBin], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new McpClient(child);
}

async function initialize(client) {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'check-grill', version: '0.0.0' },
  });
  client.notify('notifications/initialized', {});
}

async function main() {
  // --- the file exists, is non-trivial prose --------------------------------

  let text;
  await check('commands/grill.md exists and is non-empty', () => {
    text = readFileSync(grillPath, 'utf8');
    assert.ok(text.length > 500, 'expected substantial prose, not a stub');
  });
  if (!text) { console.error('cannot continue without commands/grill.md'); process.exit(1); }

  // --- no HTML template of its own -------------------------------------------

  // The blocklist is deliberately broad: the earlier one named only container and
  // form tags, so a hand-authored template built entirely from p/a/img/ul/li/
  // h1-h6/pre/code/iframe would have passed while being exactly the thing
  // acceptance criterion 9 forbids. Markdown headings/lists/fences are not HTML
  // tags, so legitimate prose in this file trips none of these.
  await check('commands/grill.md carries no HTML template', () => {
    assert.doesNotMatch(
      text,
      /<(!DOCTYPE|html|head|body|div|span|table|tr|td|th|style|script|section|article|main|nav|header|footer|button|input|form|label|select|textarea|iframe|img|svg|canvas|ul|ol|li|dl|p|a|h[1-6]|pre|code|em|strong|b|i)\b/i,
      'the command must supply blocks and question text, never a template'
    );
  });

  // --- "one question per tool call" rule is gone -----------------------------
  //
  // Semantic, not one exact historical sentence. Mutation testing found that
  // appending a PARAPHRASE ("One question per tool call. Ask it, wait, then move
  // to the next.") left the old check green, which made acceptance criterion 9
  // effectively unasserted. So: find every sentence that states the one-question
  // rule in any of its recognisable forms, and require each one to be a statement
  // that the rule is GONE (this file legitimately says so once, in the past
  // tense) rather than an instruction to follow it.

  await check('the "one question per round/call" rule is gone, in any phrasing', () => {
    const statesTheRule = /(one question (per|at a time|to a)|a single question per|one at a time)/i;
    const disavows = /\b(gone|old|former|no longer|removed|replaced|never|not|don't|instead of|rather than)\b/i;
    const sentences = text.split(/(?<=[.!?])\s+|\n/);
    const offenders = sentences.filter(s => statesTheRule.test(s) && !disavows.test(s));
    assert.deepEqual(
      offenders, [],
      'commands/grill.md still instructs asking one question at a time; the rule must be gone, not reworded:\n' + offenders.join('\n')
    );
    // ...and the replacement rule has to be positively stated, not merely absent.
    // Widened 2026-07-30 from /branch-sized/ to either phrasing: the command now
    // batches by dependency LAYER (every branch nothing unresolved gates, in one
    // round) rather than one branch per round. See SPEC_BOARD.md Decisions ->
    // "/grill asks in layer-sized rounds".
    assert.match(
      text, /(layer-sized|branch-sized)/i,
      'the replacement rule (layer-sized rounds) must be stated positively'
    );
  });

  await check('a round is described as layer-sized (several questions posted together)', () => {
    // The upper bound moved from eight to ten with the layer rule, so match the
    // shape "three to <n>" rather than one historical number.
    assert.match(text, /three to (eight|nine|ten)/i);
    assert.match(text, /\bround\b/i);
    // The point of the layer rule: independent branches share a round, and only a
    // real dependency sequences them.
    assert.match(
      text, /dependen/i,
      'layer-sized rounds must say what sequences a question: a real dependency, not topic proximity'
    );
  });

  await check("the board's ask tool is named as the route questions take", () => {
    // The schema check below compares argument NAMES, which it happily does
    // against a file that never mentions the tool at all -- so name it here.
    assert.match(text, /`ask`/, 'commands/grill.md must name the `ask` tool literally');
    assert.match(text, /`ask`[\s\S]{0,400}(board|round)/i);
  });

  // --- ask tool argument names match bin/mcp.mjs's REAL schema ---------------

  const home = mkdtempSync(path.join(tmpdir(), 'claude-board-grill-check-'));

  // The local secret, in this check's own temp dir — never ~/.config/claude-board. The
  // shim refuses to post without one (see PROTOCOL.md "The local secret"), and the
  // unreachable-daemon check below is about a DEAD DAEMON, not a missing credential:
  // without this seam it would assert against the wrong refusal entirely.
  const secretFile = path.join(home, 'secret');
  writeFileSync(secretFile, 'd'.repeat(64), { mode: 0o600 });
  process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;

  const { server, port } = await startServer({ home, port: 0 });

  let askSchema;
  await check("references the board's ask tool with argument names matching bin/mcp.mjs's real schema", async () => {
    const client = spawnShim({
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_PORT: String(port),
      CLAUDE_BOARD_NO_OPEN: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
    try {
      await initialize(client);
      const res = await client.request('tools/list', {});
      const tool = res.result.tools.find(t => t.name === 'ask');
      assert.ok(tool, 'shim must expose a tool literally named "ask"');
      askSchema = tool.inputSchema;
      const propNames = Object.keys(askSchema.properties || {});
      assert.ok(propNames.length > 0, 'ask tool schema must declare at least one property');
      for (const name of propNames) {
        assert.match(
          text,
          new RegExp('`' + name + '`'),
          `commands/grill.md must reference the ask tool's real argument \`${name}\``
        );
      }
      for (const name of askSchema.required || []) {
        assert.ok(propNames.includes(name), `sanity: required "${name}" must be a declared property`);
      }
    } finally {
      client.close();
    }
  });

  // --- all four widgets and the three packet statuses are named --------------

  await check('all four widgets (single/multi/text/rank) are named', () => {
    for (const w of ['single', 'multi', 'text', 'rank']) {
      assert.match(text, new RegExp('`' + w + '`'), `widget "${w}" must be named`);
    }
  });

  // Every status the packet can actually carry, read out of PROTOCOL.md's own
  // Packet block rather than hardcoded here -- `error` was defined there and in
  // bin/mcp.mjs while the command documented only the other three, so a real
  // outcome had no documented handling at all.
  await check('every packet status PROTOCOL.md defines is named and handled', () => {
    const protocol = readFileSync(path.join(repoRoot, 'PROTOCOL.md'), 'utf8');
    const line = protocol.split('\n').find(l => /^\s*status,/.test(l));
    assert.ok(line, "expected PROTOCOL.md's Packet block to declare `status,` with its allowed values");
    const statuses = [...line.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
    assert.ok(statuses.length >= 4, `expected PROTOCOL.md to define at least 4 packet statuses, found ${statuses.join(', ')}`);
    for (const s of statuses) {
      assert.match(text, new RegExp('`' + s + '`'), `status "${s}" must be named in commands/grill.md`);
      // Named in passing is not handled: each must head its own bullet saying
      // what to do about it.
      assert.match(
        text,
        new RegExp('^- \\*\\*`' + s + '`\\*\\*', 'm'),
        `status "${s}" must have its own handling bullet, not merely be mentioned`
      );
    }
  });

  await check('discuss means stopping further boards for the rest of the session', () => {
    assert.match(text, /stop posting/i);
  });

  await check('unanswered and deferred are named as explicit signals, not silently re-asked', () => {
    assert.match(text, /\bunanswered\b/i);
    assert.match(text, /\bdeferred\b/i);
  });

  // --- the revive command matches what bin/mcp.mjs ACTUALLY prints -----------

  await check('the revive command matches what bin/mcp.mjs actually prints when the daemon is unreachable', async () => {
    await new Promise(resolve => server.close(resolve)); // now nothing listens on `port`: genuinely dead
    const client = spawnShim({
      CLAUDE_BOARD_HOME: home,
      CLAUDE_BOARD_PORT: String(port),
      CLAUDE_BOARD_NO_OPEN: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_BOARD_POST_TIMEOUT_MS: '2000',
    });
    try {
      await initialize(client);
      const res = await client.request('tools/call', {
        name: 'ask',
        arguments: { title: 'grill-check unreachable daemon', blocks: [{ kind: 'markdown', text: '# x' }] },
      });
      const result = res.result;
      assert.equal(result.isError, true, 'an unreachable daemon must be a loud error, not a quiet fallback');
      const message = result.content[0].text;
      const m = message.match(/Revive it with: (.+)/);
      assert.ok(m, `expected bin/mcp.mjs's unreachable-daemon message to name a revive command, got: ${message}`);
      const reviveCommand = m[1].trim();
      assert.ok(reviveCommand.length > 0);
      assert.ok(
        text.includes(reviveCommand),
        `commands/grill.md must include the exact revive command bin/mcp.mjs prints: "${reviveCommand}"`
      );
    } finally {
      client.close();
    }
  });

  await check('fails loudly: no automatic terminal fallback is described', () => {
    assert.match(text, /no (automatic )?fallback/i);
  });

  // --- the context-reference shape it documents is the one the code READS -----
  //
  // H7: the command used to say context is "addressed by `{ path, section?, lines? }`"
  // and never named `source`, while src/board.mjs resolves a content block's
  // reference off `raw.source` and nothing else. A block written the documented
  // way resolved to an empty block with no error at all — the worst kind of drift,
  // since neither side complains. The field name is read out of src/board.mjs
  // here rather than hardcoded, so renaming it in the code fails this check
  // instead of silently re-opening the same gap.

  await check('the context-block reference shape /grill documents is the field src/board.mjs actually resolves', () => {
    const boardSrc = readFileSync(path.join(repoRoot, 'src', 'board.mjs'), 'utf8');
    const m = boardSrc.match(/if \(raw\.(\w+)\)\s*\{[\s\S]{0,200}?resolveRef\(raw\.(\w+)/);
    assert.ok(m, 'expected src/board.mjs to resolve a content block reference off a named raw field');
    assert.equal(m[1], m[2], 'sanity: the guarded field and the resolved field must be the same one');
    const refField = m[1];
    assert.match(
      text,
      new RegExp('`' + refField + '`'),
      `commands/grill.md must name \`${refField}\` — the key src/board.mjs reads a reference from`
    );
    // The bare Ref shape must never be presented as the block's own address: that
    // is the exact wording that shipped the gap.
    assert.doesNotMatch(
      text,
      /addressed by `\{ path/,
      'the Ref belongs under the `' + refField + '` key, never spread onto the block itself'
    );
    // And at least one worked example must show it nested, not just prose saying so.
    assert.match(
      text,
      new RegExp(refField + ':\\s*\\{\\s*path:'),
      `commands/grill.md must carry an example block showing ${refField}: { path: ... }`
    );
  });

  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all grill checks ok');
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
