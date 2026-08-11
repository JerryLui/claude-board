// Coverage for bin/demo.mjs, the one-command "does my install actually work"
// check. /api/health only proves a port is bound; this is what actually exercises
// the secret, the write gate,
// normalizeBlock, the render and the served page, the way a newcomer's first run
// would. Three shapes worth a real assertion: it fails fast, before any network
// call, when there is no local secret; it fails fast with a clear, install.sh-naming
// message when nothing is listening; and when the daemon is real, it posts the
// sample board's ACTUAL content, not a stub payload.
//
// Patterned after test/check-http.mjs (a real in-process daemon via startServer,
// never a mock) for the happy path, and test/check-mcp.mjs's dead-port/no-secret
// checks (`freePort`, the "throwaway server then close it" dead-port trick, and the
// `makeOpenRecorder` stand-in for `open`) for the two failure shapes -- duplicated
// here rather than imported, since every check file in this suite is a standalone
// process (test/run.mjs spawns each one fresh) and none of these helpers are
// exported.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { readBoard } from '../src/store.mjs';
import { KIND_LETTER, WIDGETS } from '../src/board.mjs';

const execFileP = promisify(execFile);
const demoBin = fileURLToPath(new URL('../bin/demo.mjs', import.meta.url));
const samplePath = fileURLToPath(new URL('../examples/sample-board.json', import.meta.url));
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));

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

/** A port nothing is listening on: bind ephemeral, read it back, close it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** A stand-in for `open`: records the single URL it is handed. Same shape as
 * test/check-mcp.mjs's makeOpenRecorder. */
function makeOpenRecorder(dir) {
  const script = path.join(dir, 'fake-open.sh');
  const log = path.join(dir, 'opened.log');
  writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$CLAUDE_BOARD_OPEN_LOG"\n', { mode: 0o755 });
  return {
    script,
    log,
    opened() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    },
    // Polled, not a fixed sleep: the recorder is a real detached grandchild
    // process (bin/demo.mjs spawns it detached+unref'd, same as
    // bin/authorize.mjs), and how long it takes to fork/exec/write is not this
    // check's to guess at.
    async waitForOpens(n, timeoutMs = 5000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (this.opened().length >= n) return this.opened();
        await new Promise(r => setTimeout(r, 25));
      }
      return this.opened();
    },
  };
}

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-demo-'));
const secretFile = path.join(home, 'secret');
const SECRET = 'e'.repeat(64);
writeFileSync(secretFile, SECRET, { mode: 0o600 });

let server, port;

async function main() {
  ({ server, port } = await startServer({ home, port: 0, secret: SECRET }));

  await check('posts the sample board\'s actual content and prints a working board URL', async () => {
    const recorder = makeOpenRecorder(home);
    // execFile, never execFileSync: the daemon this points at runs in THIS
    // process (see QUIRKS.md "execFileSync deadlocks against an in-process
    // daemon") -- a synchronous spawn would block the event loop the daemon
    // needs to answer its own request.
    const { stdout, stderr } = await execFileP(process.execPath, [demoBin], {
      env: {
        ...process.env,
        CLAUDE_BOARD_PORT: String(port),
        CLAUDE_BOARD_SECRET_FILE: secretFile,
        CLAUDE_BOARD_OPEN_CMD: recorder.script,
        CLAUDE_BOARD_OPEN_LOG: recorder.log,
      },
      encoding: 'utf8',
      timeout: 15_000,
    });

    const url = stdout.trim();
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/b/b_[0-9a-f]{32}$`),
      'stdout must carry exactly one pasteable board URL, on this daemon\'s own port');
    assert.match(stderr, /posted the sample board/);

    const boardId = url.slice(url.lastIndexOf('/b/') + 3);
    const board = readBoard(boardId, home);
    assert.equal(board.title, sample.title, 'the posted board keeps the sample\'s own title');
    assert.equal(board.blocks.length, sample.blocks.length, 'every top-level sample block landed, none dropped or split');
    // The committed sample's ids are already unique kind-letter+ordinal (h1, d1,
    // m1, ...) and a fresh board's id ledger starts empty, so nothing here
    // should have been renumbered -- proving the transform keeps `id` rather
    // than stripping it.
    assert.deepEqual(board.blocks.map(b => b.id), sample.blocks.map(b => b.id));

    const kindsOnBoard = new Set(board.blocks.map(b => b.kind));
    for (const kind of Object.keys(KIND_LETTER)) {
      assert.ok(kindsOnBoard.has(kind), `sample block kind "${kind}" did not land on the posted board`);
    }
    const questionWidgets = new Set(board.blocks.filter(b => b.kind === 'question').map(b => b.widget));
    for (const widget of WIDGETS) {
      assert.ok(questionWidgets.has(widget), `sample question widget "${widget}" did not land on the posted board`);
    }

    const opened = await recorder.waitForOpens(1);
    assert.deepEqual(opened, [url], 'the printed URL is exactly what got handed to the opener');
  });

  await check('finds a custom port from the record beside the secret, with no env set', async () => {
    // daemonPort()'s middle branch: `claude mcp add` registers no environment, so a
    // custom-port install is only reachable through the record install.sh writes.
    // A shell with no CLAUDE_BOARD_PORT exported must still land on the daemon.
    writeFileSync(path.join(home, 'port'), String(port));
    const recorder = makeOpenRecorder(home);
    const env = {
      ...process.env,
      CLAUDE_BOARD_SECRET_FILE: secretFile,
      CLAUDE_BOARD_OPEN_CMD: recorder.script,
      CLAUDE_BOARD_OPEN_LOG: recorder.log,
    };
    delete env.CLAUDE_BOARD_PORT;
    const { stdout } = await execFileP(process.execPath, [demoBin], { env, encoding: 'utf8', timeout: 15_000 });
    assert.match(stdout.trim(), new RegExp(`^http://127\\.0\\.0\\.1:${port}/b/b_[0-9a-f]{32}$`),
      'the record alone must carry the demo to the daemon\'s actual port');
  });

  await check('fails fast, before any network call, when there is no local secret', async () => {
    // Pointed at a port with nothing on it too, deliberately (same reasoning as
    // test/check-mcp.mjs's identically-named check): that is what proves this
    // trips on the secret guard rather than on ECONNREFUSED.
    const deadPort = await freePort();
    const start = Date.now();
    let err;
    try {
      await execFileP(process.execPath, [demoBin], {
        env: {
          ...process.env,
          CLAUDE_BOARD_PORT: String(deadPort),
          CLAUDE_BOARD_SECRET_FILE: path.join(home, 'does-not-exist'),
        },
        encoding: 'utf8',
        timeout: 5_000,
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    assert.ok(err, 'must exit non-zero with no secret on disk');
    assert.ok(elapsed < 2000, `refusal must be immediate, took ${elapsed}ms`);
    assert.match(err.stderr, /no local secret/i);
    assert.match(err.stderr, /install\.sh/);
    assert.doesNotMatch(err.stderr, /not reachable/i, 'must refuse before it ever opens a socket');
  });

  await check('fails fast with a clear, actionable message when nothing is listening', async () => {
    const { server: throwaway, port: deadPort } = await startServer({
      home: mkdtempSync(path.join(tmpdir(), 'claude-board-demo-dead-')),
      port: 0,
    });
    await new Promise(resolve => throwaway.close(resolve)); // now nothing listens on deadPort

    let err;
    try {
      await execFileP(process.execPath, [demoBin], {
        env: {
          ...process.env,
          CLAUDE_BOARD_PORT: String(deadPort),
          CLAUDE_BOARD_SECRET_FILE: secretFile,
        },
        encoding: 'utf8',
        timeout: 15_000,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must exit non-zero when nothing is listening');
    assert.match(err.stderr, /not reachable/i);
    assert.match(err.stderr, /the daemon is not running, or not installed/i);
    assert.match(err.stderr, /install\.sh/);
    assert.match(err.stderr, /launchctl kickstart -k gui\/\$\(id -u\)\/claude-board/);
  });
}

try {
  await main();
} finally {
  if (server) server.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall demo checks ok');
