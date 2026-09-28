// Binds bin/remote.mjs (remote review, ADR 118) to the daemon it talks to, end to end,
// with the two pieces of the real setup that a check cannot own replaced by stand-ins:
//
//   - The SSH hop. CLAUDE_BOARD_REMOTE_SSH points at a shell script that records its
//     arguments and runs the remote command string the way the mini's account shell
//     would, under `env -i` with HOME at a temp directory standing in for the mini's
//     home and PATH cut to /usr/bin:/bin. That home carries the secret and port record
//     where install.sh puts them, a Documents/claude-board symlink to this checkout, and
//     a .zshrc that is the ONLY place `node` exists, as a shell function, which is how
//     nvm installs it on the mini. So the helper's login command proves it reaches nvm's
//     node from a non-interactive SSH command, not merely that node is on some PATH.
//   - The LocalForward. A TCP relay on a second ephemeral port stands in for the
//     tunnel, so the local port and the mini's port differ, as they do for real
//     (7392 against 7391), and the rewrite between them is exercised rather than
//     coincidentally right.
//
// CLAUDE_BOARD_OPEN_CMD points at a script that records the URL it was handed, so no
// browser is ever launched. Never touches the real secret or board home. Every child is
// run with promisify(execFile), never execFileSync (QUIRKS.md "execFileSync deadlocks
// against an in-process daemon"): the daemon answers from this process's event loop.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../src/server.mjs';
import { SESSION_COOKIE } from '../src/secret.mjs';
import { shellQuote } from '../src/handoff.mjs';
import { localUrl, remoteCommand, pickHandoffUrl, isBoardId, DEFAULT_REMOTE_PORT, DEFAULT_REMOTE_DIR } from '../bin/remote.mjs';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remoteBin = path.join(repoRoot, 'bin', 'remote.mjs');

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

function rawGet(port, pathName, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathName, headers: { host, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start >= timeoutMs) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/** A port with nothing listening on it: bind 0, read it, close. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

// --- fixtures ---------------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), 'claude-board-remote-'));
const daemonHome = path.join(scratch, 'board-home');
const miniHome = path.join(scratch, 'mini-home');
const binDir = path.join(scratch, 'bin');
for (const d of [daemonHome, binDir, path.join(miniHome, '.config', 'claude-board'), path.join(miniHome, 'Documents')]) {
  mkdirSync(d, { recursive: true });
}

const SECRET = 'f'.repeat(64);
const secretFile = path.join(miniHome, '.config', 'claude-board', 'secret');
writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_HOME = daemonHome;
process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;

// The mini's clone, at the default CLAUDE_BOARD_REMOTE_DIR.
symlinkSync(repoRoot, path.join(miniHome, 'Documents', 'claude-board'));

// nvm's node: a function in .zshrc and nowhere else. It leaves a marker so the check can
// tell the function ran, and the rc prints a line on stdout first, the way a prompt theme
// or a banner does, which the helper must see past.
const nodeMarker = path.join(miniHome, 'node-came-from-zshrc');
writeFileSync(path.join(miniHome, '.zshrc'), [
  'echo "welcome to the mini (rc noise on stdout)"',
  `node() { : > ${shellQuote(nodeMarker)}; ${shellQuote(process.execPath)} "$@"; }`,
  '',
].join('\n'));

const sshStandIn = path.join(binDir, 'ssh');
writeFileSync(sshStandIn, [
  '#!/bin/sh',
  '# Stands in for ssh: record the arguments, then run the last one (the remote command)',
  '# as the mini\'s account shell would, in an environment holding nothing of this one.',
  'printf \'%s\\n\' "$@" > "$CB_SSH_RECORD"',
  'for last; do :; done',
  'exec /usr/bin/env -i HOME="$CB_MINI_HOME" PATH=/usr/bin:/bin /bin/sh -c "$last"',
  '',
].join('\n'), { mode: 0o755 });

const openStandIn = path.join(binDir, 'open');
writeFileSync(openStandIn, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$CB_OPEN_RECORD"\n', { mode: 0o755 });

let server, daemonPort, relay, relayPort;
const relaySockets = new Set();
let run = 0;

/** Run the helper as a user would, with the stand-ins wired in. Resolves
 * `{ code, stdout, stderr, opened, sshArgs }`; `opened` is every URL the opener
 * was handed (waited for briefly, since the opener is detached), `sshArgs` null when ssh
 * never ran. */
async function helper(args, envOverrides = {}, { expectOpen = true } = {}) {
  run++;
  const sshRecord = path.join(scratch, `ssh-${run}.txt`);
  const openRecord = path.join(scratch, `open-${run}.txt`);
  const { CLAUDE_BOARD_REMOTE_DIR: _d, CLAUDE_BOARD_REMOTE_PORT: _p, CLAUDE_BOARD_REMOTE_HOST: _h, ...inherited } = process.env;
  const env = {
    ...inherited,
    CLAUDE_BOARD_REMOTE_HOST: 'mini-standin',
    CLAUDE_BOARD_REMOTE_PORT: String(relayPort),
    CLAUDE_BOARD_REMOTE_SSH: sshStandIn,
    CLAUDE_BOARD_OPEN_CMD: openStandIn,
    CB_SSH_RECORD: sshRecord,
    CB_OPEN_RECORD: openRecord,
    CB_MINI_HOME: miniHome,
    ...envOverrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  let code = 0, stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await execFileP(process.execPath, [remoteBin, ...args], { env, encoding: 'utf8', timeout: 30_000 }));
  } catch (err) {
    code = typeof err.code === 'number' ? err.code : 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? String(err);
  }
  // The opener creates its record before it writes the line, and it can outlive the helper:
  // wait for a whole line, not just the file.
  if (expectOpen) await waitFor(() => { const t = existsSync(openRecord) ? readFileSync(openRecord, 'utf8') : ''; return t.length > 0 && t.endsWith('\n'); });
  else await new Promise(r => setTimeout(r, 150)); // room for a stray opener to show itself
  const opened = existsSync(openRecord) ? readFileSync(openRecord, 'utf8').split('\n').filter(Boolean) : [];
  const sshArgs = existsSync(sshRecord) ? readFileSync(sshRecord, 'utf8').split('\n').filter(Boolean) : null;
  return { code, stdout, stderr, opened, sshArgs };
}

function cookieParts(res) {
  const set = [].concat(res.headers['set-cookie'] || []).find(c => c.startsWith(`${SESSION_COOKIE}=`));
  return set ? set.split(';').map(s => s.trim()) : null;
}

async function main() {
  // --- pure pieces --------------------------------------------------------------

  await check('defaults: local port 7392, remote clone ~/Documents/claude-board', () => {
    assert.equal(DEFAULT_REMOTE_PORT, 7392);
    assert.equal(DEFAULT_REMOTE_DIR, '~/Documents/claude-board');
  });

  await check('INSTALL.md documents the setup with the helper\'s own defaults, and package.json runs it', () => {
    const doc = readFileSync(path.join(repoRoot, 'INSTALL.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## Remote review'));
    assert.ok(section.length > 200, 'INSTALL.md has a Remote review section');
    assert.ok(section.includes(`LocalForward ${DEFAULT_REMOTE_PORT} 127.0.0.1:7391`), 'the SSH config line, on the default local port');
    for (const needle of ['npm run remote -- login', 'npm run remote -- open', 'CLAUDE_BOARD_REMOTE_HOST', 'CLAUDE_BOARD_REMOTE_PORT', 'CLAUDE_BOARD_REMOTE_DIR', DEFAULT_REMOTE_DIR, 'Once a month', 'tunnel must be up', 'must be logged in']) {
      assert.ok(section.includes(needle), `the section names ${needle}`);
    }
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.remote, 'node bin/remote.mjs');
  });

  await check('the rewrite maps the mini\'s loopback URL, any port, to localhost on the local port', () => {
    const id = 'b_0123456789abcdef0123456789abcdef';
    assert.equal(localUrl(`http://127.0.0.1:7391/b/${id}`, 7392), `http://localhost:7392/b/${id}`);
    assert.equal(localUrl('http://localhost:8123/', 7392), 'http://localhost:7392/');
    assert.equal(localUrl('http://127.0.0.1:7391', 7400), 'http://localhost:7400/');
    assert.equal(localUrl(`http://127.0.0.1:7391/b/${id}?x=1#q2`, 7392), `http://localhost:7392/b/${id}?x=1#q2`);
    assert.equal(localUrl(id, 7392), `http://localhost:7392/b/${id}`, 'a bare id');
  });

  await check('the rewrite refuses anything that is not a loopback board URL or a board id', () => {
    for (const bad of [
      'https://127.0.0.1:7391/b/x', 'http://example.com:7391/b/x', 'http://127.0.0.1:7391@example.com/',
      'http://127.0.0.1/b/x', 'http://127.0.0.2:7391/', 'http://[::1]:7391/', 'javascript:alert(1)',
      'http://127.0.0.1:7391/b/x y', 'http://127.0.0.1:7391/b/x\n', '../etc', 'a;b', '-x', '', 'b/x',
    ]) {
      assert.equal(localUrl(bad, 7392), null, `must refuse ${JSON.stringify(bad)}`);
    }
    assert.equal(isBoardId('--print'), false, 'a leading dash would reach the mini as a flag');
  });

  await check('the remote command goes through an interactive login zsh, the dir quoted, ~/ left to the mini', () => {
    assert.equal(remoteCommand('~/Documents/claude-board', null), 'zsh -lic \'cd "$HOME"/Documents/claude-board && node bin/authorize.mjs --print\'');
    assert.match(remoteCommand('~/Documents/claude-board', 'b_1'), /--print b_1'$/);
  });

  await check('the handoff URL is picked out of shell noise by its exact shape', () => {
    const tok = 'a'.repeat(64);
    assert.equal(pickHandoffUrl(`banner\nhttp://127.0.0.1:7391/auth/${tok}\n`), `http://127.0.0.1:7391/auth/${tok}`);
    assert.equal(pickHandoffUrl('http://127.0.0.1:7391/auth/abc\n'), null, 'a short token is not a handoff');
    assert.equal(pickHandoffUrl(`http://evil.example:7391/auth/${tok}\n`), null);
  });

  // --- against a daemon ---------------------------------------------------------

  ({ server, port: daemonPort } = await startServer({ home: daemonHome, port: 0 }));
  // install.sh's port record, which bin/authorize.mjs on the "mini" reads.
  writeFileSync(path.join(miniHome, '.config', 'claude-board', 'port'), `${daemonPort}\n`);

  relay = net.createServer(sock => {
    const up = net.connect(daemonPort, '127.0.0.1');
    relaySockets.add(sock).add(up);
    sock.pipe(up).pipe(sock);
    const drop = () => { sock.destroy(); up.destroy(); relaySockets.delete(sock); relaySockets.delete(up); };
    sock.on('error', drop).on('close', drop);
    up.on('error', drop).on('close', drop);
  });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  relayPort = relay.address().port;
  assert.notEqual(relayPort, daemonPort);

  await check('setup: node is not on the stand-in mini\'s PATH', async () => {
    await assert.rejects(execFileP('/usr/bin/env', ['-i', `HOME=${miniHome}`, 'PATH=/usr/bin:/bin', '/bin/sh', '-c', 'command -v node']));
  });

  const host = `localhost:${relayPort}`;
  const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

  await check('login: over a non-interactive ssh with node only in .zshrc, the opener gets a localhost handoff that logs the browser in', async () => {
    const r = await helper(['login']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(nodeMarker), 'node must have come from the .zshrc function, as nvm installs it');
    assert.deepEqual(r.sshArgs.slice(0, -1), ['-T', '-o', 'ClearAllForwardings=yes', 'mini-standin'], 'the host from CLAUDE_BOARD_REMOTE_HOST, no second forward');
    assert.equal(r.opened.length, 1);
    const url = r.opened[0];
    assert.match(url, new RegExp(`^http://localhost:${relayPort}/auth/[0-9a-f]{64}$`), 'localhost on the local port, never 127.0.0.1');

    // What the browser does with it, through the relay: Host is localhost:<local port>.
    const redeemed = await rawGet(relayPort, new URL(url).pathname, host, HTML);
    assert.equal(redeemed.status, 302);
    assert.equal(redeemed.headers.location, '/', 'relative, so it lands on localhost:<local port> unchanged');
    const parts = cookieParts(redeemed);
    assert.ok(parts, 'the handoff sets the session cookie');
    assert.ok(!parts.some(p => /^domain=/i.test(p)), 'host-only: no Domain attribute, so it lives under localhost alone and never reaches 127.0.0.1\'s jar');
    assert.ok(parts.some(p => /^max-age=\d+$/i.test(p)), 'persistent, so it survives a browser restart');

    const index = await rawGet(relayPort, '/', host, { ...HTML, cookie: parts[0] });
    assert.equal(index.status, 200, 'the mini\'s index shows under localhost');
    const bare = await rawGet(relayPort, '/', host, HTML);
    assert.notEqual(bare.status, 200, 'and not without the cookie');
  });

  await check('login <boardId>: the handoff lands on that board', async () => {
    const id = 'b_0123456789abcdef0123456789abcdef';
    const r = await helper(['login', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.sshArgs.at(-1), new RegExp(`--print ${id}'$`));
    const redeemed = await rawGet(relayPort, new URL(r.opened[0]).pathname, host, HTML);
    assert.equal(redeemed.headers.location, `/b/${id}`);
  });

  await check('login: CLAUDE_BOARD_REMOTE_DIR overrides the clone path, with ~, a space and a quote in it', async () => {
    mkdirSync(path.join(miniHome, 'odd dir'), { recursive: true });
    symlinkSync(repoRoot, path.join(miniHome, 'odd dir', "it's"));
    try {
      const r = await helper(['login'], { CLAUDE_BOARD_REMOTE_DIR: "~/odd dir/it's" });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.opened[0], new RegExp(`^http://localhost:${relayPort}/auth/[0-9a-f]{64}$`));
    } finally {
      unlinkSync(path.join(miniHome, 'odd dir', "it's"));
    }
  });

  await check('login: a wrong CLAUDE_BOARD_REMOTE_DIR exits non-zero, says so, opens nothing', async () => {
    const r = await helper(['login'], { CLAUDE_BOARD_REMOTE_DIR: '~/nowhere' }, { expectOpen: false });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /CLAUDE_BOARD_REMOTE_DIR/);
    assert.deepEqual(r.opened, []);
  });

  await check('login: an unsafe board id exits non-zero with a message, before ssh, opening nothing', async () => {
    for (const bad of ['../x', 'a;touch pwned', '--print']) {
      const r = await helper(['login', bad], {}, { expectOpen: false });
      assert.notEqual(r.code, 0, bad);
      assert.match(r.stderr, /not a board id/);
      assert.equal(r.sshArgs, null, 'nothing is sent to the mini');
      assert.deepEqual(r.opened, []);
    }
  });

  await check('login: an unset host exits non-zero with a message, before ssh, opening nothing', async () => {
    const r = await helper(['login'], { CLAUDE_BOARD_REMOTE_HOST: undefined }, { expectOpen: false });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /CLAUDE_BOARD_REMOTE_HOST is not set/);
    assert.equal(r.sshArgs, null);
    assert.deepEqual(r.opened, []);
  });

  await check('login: with the tunnel down it says so and spends no handoff', async () => {
    const r = await helper(['login'], { CLAUDE_BOARD_REMOTE_PORT: String(await closedPort()) }, { expectOpen: false });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /tunnel is down/);
    assert.doesNotMatch(r.stderr, /LocalForward \d+ 127\.0\.0\.1:7391/, 'the remote daemon may run on its own CLAUDE_BOARD_PORT, so the hint names no fixed port');
    assert.equal(r.sshArgs, null);
    assert.deepEqual(r.opened, []);
  });

  await check('open: the URL the agent printed and the bare id both open the board at localhost:<local port>', async () => {
    const id = 'b_fedcba9876543210fedcba9876543210';
    for (const arg of [`http://127.0.0.1:7391/b/${id}`, id]) {
      const r = await helper(['open', arg]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.opened, [`http://localhost:${relayPort}/b/${id}`], arg);
      assert.equal(r.sshArgs, null, 'open never needs ssh');
    }
  });

  await check('open: an unsafe id or a foreign URL exits non-zero with a message and opens nothing', async () => {
    for (const bad of ['../x', 'https://example.com/b/x', 'http://127.0.0.1:7391@example.com/']) {
      const r = await helper(['open', bad], {}, { expectOpen: false });
      assert.notEqual(r.code, 0, bad);
      assert.match(r.stderr, /neither a board id nor a board URL/);
      assert.deepEqual(r.opened, []);
    }
  });

  await check('open: with CLAUDE_BOARD_REMOTE_PORT unset it targets localhost:7392', async () => {
    // Whatever this machine has on 7392 (usually nothing, maybe a real tunnel), the helper
    // either opens localhost:7392 through the stand-in opener or names localhost:7392 as down.
    const id = 'b_fedcba9876543210fedcba9876543210';
    const r = await helper(['open', id], { CLAUDE_BOARD_REMOTE_PORT: undefined }, { expectOpen: false });
    if (r.code === 0) assert.deepEqual(r.opened, [`http://localhost:7392/b/${id}`]);
    else assert.match(r.stderr, /http:\/\/localhost:7392\b/);
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(async () => {
    for (const s of relaySockets) s.destroy();
    if (relay) await new Promise(resolve => relay.close(resolve));
    if (server) {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(scratch, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall remote checks ok');
  });
