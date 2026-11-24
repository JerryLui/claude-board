// The away command (bin/away.mjs) against a stand-in `tailscale` that records its arguments and
// keeps a serve config of its own. No row reaches a network or the real ~/.config/claude-board.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { HANDOFF_TOKEN_RE } from '../src/handoff.mjs';
import { check, execFileAsync, freePort, rawRequest, repoRoot, readJsonLines, runMain, writeStub } from './support.mjs';

const awayBin = path.join(repoRoot, 'bin', 'away.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'claude-board-away-'));
const config = path.join(scratch, 'config');
const boards = path.join(scratch, 'boards');
for (const dir of [config, boards]) mkdirSync(dir, { mode: 0o700 });

const SECRET = 'a'.repeat(64);
const secretFile = path.join(config, 'secret');
const awayFile = path.join(config, 'away');
writeFileSync(secretFile, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = secretFile;
process.env.CLAUDE_BOARD_HOME = boards;

const HOST = 'board.example.ts.net';
const stateFile = path.join(scratch, 'state.json');
const argvLog = path.join(scratch, 'argv.jsonl');
const stub = writeStub(scratch, 'tailscale', `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ args, cli: process.env.TAILSCALE_BE_CLI, awayFile: existsSync(${JSON.stringify(awayFile)}) }) + '\\n');
const line = args.join(' ');
if (line === 'status --json') console.log(state.statusText ?? JSON.stringify(state.status));
else if (line === 'serve status --json') console.log(JSON.stringify(state.serve));
else if (args[0] === 'serve' && args.at(-1) === 'off') {
  if (state.offFails) { console.error('cannot turn that off'); process.exit(1); }
  state.serve = {};
  writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
} else if (args[0] === 'serve' && args[1] === '--bg') {
  if (state.serveSays) { console.error(state.serveSays); if (state.hangs) setTimeout(() => {}, 60000); else process.exit(1); }
  else if (!state.serveIsANoOp) {
    state.serve = { TCP: { 443: { HTTPS: true } }, Web: { [state.status.Self.DNSName.replace(/\\.$/, '') + ':443']: { Handlers: { '/': { Proxy: args.at(-1) } } } } };
    if (state.funnelAfter) state.serve.AllowFunnel = { [${JSON.stringify(`${HOST}:443`)}]: true };
    writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  }
} else process.exit(64);
`);

const running = (DNSName = `${HOST}.`, BackendState = 'Running') => ({ BackendState, Self: { DNSName }, CertDomains: [HOST] });
const target = port => `http://127.0.0.1:${port}`;
const published = (port, host = HOST) => ({ TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: target(port) } } } } });

let port;
let server;

function reset(state = {}) {
  rmSync(awayFile, { recursive: true, force: true });
  writeFileSync(argvLog, '');
  writeFileSync(stateFile, JSON.stringify({ status: running(), serve: {}, ...state }));
}

async function away(args, env = {}, umask = null) {
  const child = { ...process.env, CLAUDE_BOARD_TAILSCALE_CMD: stub, CLAUDE_BOARD_PORT: String(port), ...env };
  const [file, argv] = umask === null
    ? [process.execPath, [awayBin, ...args]]
    : ['/bin/sh', ['-c', `umask ${umask}; exec "$@"`, 'sh', process.execPath, awayBin, ...args]];
  try {
    return { code: 0, ...await execFileAsync(file, argv, { env: child, encoding: 'utf8', timeout: 30_000 }) };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
}

const calls = () => readJsonLines(argvLog);
const asked = () => calls().map(call => call.args.join(' '));
const serveState = () => JSON.parse(readFileSync(stateFile, 'utf8')).serve;
const SERVE_OFF = 'serve --https=443 off';
const serveOn = () => `serve --bg --https=443 ${target(port)}`;

async function main() {
  ({ server, port } = await startServer({ home: boards, port: 0 }));
  const boardAnswers = async () => (await rawRequest(port, 'GET', '/', { host: HOST })).status;

  await check('on publishes this board by the named host, and only then writes the one owner-only setting, whatever the umask', async () => {
    for (const umask of ['000', '022', '777']) {
      reset();
      const r = await away(['on', 'board'], {}, umask);
      assert.equal(r.code, 0, r.stderr);
      const serve = calls().find(call => call.args[1] === '--bg');
      assert.deepEqual([serve.args.join(' '), serve.awayFile, serve.cli], [serveOn(), false, '1'], 'published before the setting is written');
      assert.equal(readFileSync(awayFile, 'utf8'), `${HOST}\n`);
      const stat = lstatSync(awayFile);
      assert.deepEqual([stat.isFile(), stat.mode & 0o777], [true, 0o600], `umask ${umask}`);
      assert.deepEqual(readdirSync(config).sort(), ['away', 'secret'], 'no half-written file is left beside it');
      assert.match(r.stdout, /https:\/\/board\.example\.ts\.net .*\n.*only a browser signed in by a link.*\n.*HTTPS certificates have to be on/);
      assert.ok(r.stdout.includes(`Next: CLAUDE_BOARD_PORT=${port} node bin/away.mjs link`), r.stdout);
      assert.equal(await boardAnswers(), 401, 'the running board answers to the name, and asks for a sign-in');
    }
    const twice = await away(['on', 'board']);
    assert.deepEqual([twice.code, readFileSync(awayFile, 'utf8')], [0, `${HOST}\n`], 'on again over its own handler is no foreign one');
  });

  await check('on refuses before anything is published or written, naming why and the next step', async () => {
    const web = handlers => ({ Web: { [`${HOST}:443`]: { Handlers: handlers } } });
    for (const [what, state, says, next = /^Next: /m] of [
      ['a Mac not yet renamed', { status: running('old-name.example.ts.net.') }, /calls this Mac "old-name", not "board"/, /Next: rename it/],
      ['a name that only starts alike', { status: running('board-2.example.ts.net.') }, /calls this Mac "board-2"/],
      ['Tailscale stopped', { status: running(undefined, 'Stopped') }, /not running \(it says Stopped\)/],
      ['Tailscale signed out', { status: running('', 'NeedsLogin') }, /NeedsLogin/],
      ['no name at all', { status: { BackendState: 'Running', Self: {} } }, /no usable name/],
      ['a name outside Tailscale', { status: running('board.example.com.') }, /no usable name/],
      ['a status that is not one', { statusText: 'Tailscale is updating' }, /Tailscale is updating/],
      ['Funnel on this board', { serve: { ...web({}), AllowFunnel: { [`${HOST}:443`]: true } } }, /Funnel is on for board\.example\.ts\.net:443/, /tailscale funnel reset/],
      ['Funnel on another port', { serve: { AllowFunnel: { [`${HOST}:8443`]: true } } }, /Funnel is on/],
      ['Funnel in a foreground session', { serve: { Foreground: { s1: { AllowFunnel: { [`${HOST}:443`]: true } } } } }, /Funnel is on/],
      ['another program behind 443', { serve: web({ '/': { Proxy: 'http://127.0.0.1:3000' } }) }, /already serves something else.*\n.*127\.0\.0\.1:3000/, /tailscale serve --https=443 off/],
      ['a path beside the board', { serve: web({ '/': { Proxy: target(port) }, '/notes': { Text: 'hi' } }) }, /\/notes/],
      ['raw TCP on 443', { serve: { TCP: { 443: { TCPForward: '127.0.0.1:22' } } } }, /port 443: .*127\.0\.0\.1:22/],
      ['a foreground session on 443', { serve: { Foreground: { s1: web({ '/': { Proxy: target(port) } }) } } }, /already serves something else/],
    ]) {
      reset(state);
      const r = await away(['on', 'board']);
      assert.equal(r.code, 1, `${what}: ${r.stdout}`);
      assert.match(r.stderr, says, what);
      assert.match(r.stderr, next, what);
      assert.match(r.stderr, /Nothing was changed\./, what);
      assert.ok(!existsSync(awayFile), `${what}: no setting is written`);
      assert.deepEqual(asked().filter(line => !line.endsWith('--json')), [], `${what}: Tailscale is only asked, never told`);
    }
    reset();
    const missing = await away(['on', 'board'], { CLAUDE_BOARD_TAILSCALE_CMD: path.join(scratch, 'no-such-tailscale') });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /was not found[\s\S]*Next: /);
    const noSecret = await away(['on', 'board'], { CLAUDE_BOARD_SECRET_FILE: path.join(scratch, 'empty', 'secret') });
    assert.deepEqual([noSecret.code, noSecret.stdout], [1, '']);
    assert.match(noSecret.stderr, /no local secret[\s\S]*install\.sh/);
    assert.deepEqual(asked(), []);
  });

  await check('on whose forwarder did not come up prints Tailscale\'s own words, writes nothing and leaves nothing published', async () => {
    const words = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.example/f/serve';
    for (const [state, says] of [
      [{ serveSays: words }, words],
      [{ serveSays: words, hangs: true }, words],
      [{ serveIsANoOp: true }, 'Tailscale did not turn the forwarder on'],
      [{ funnelAfter: true }, 'Tailscale did not turn the forwarder on'],
      [{ funnelAfter: true, earlier: true }, 'Tailscale did not turn the forwarder on'],
    ]) {
      reset(state);
      if (state.earlier) writeFileSync(awayFile, `${HOST}\n`, { mode: 0o600 });
      const r = await away(['on', 'board'], { CLAUDE_BOARD_TAILSCALE_TIMEOUT_MS: '4000' });
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes(says), r.stderr);
      assert.match(r.stderr, /HTTPS certificates have to be on[\s\S]*Next: [\s\S]*Away is off\. .*[Nn]othing is published/);
      assert.ok(!existsSync(awayFile));
      assert.deepEqual(serveState(), {});
      assert.equal(await boardAnswers(), 403);
    }
  });

  await check('on that cannot write the setting takes the forwarder down again', async () => {
    reset();
    chmodSync(config, 0o500);
    try {
      const r = await away(['on', 'board']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /could not be written[\s\S]*Next: [\s\S]*Away is off\. The forwarder is off again/);
      assert.ok(asked().includes(SERVE_OFF));
      assert.deepEqual(serveState(), {});
    } finally {
      chmodSync(config, 0o700);
    }
    assert.ok(!existsSync(awayFile));
  });

  await check('a link where the setting goes is never written through: on refuses it, off removes the link and not its target', async () => {
    reset();
    const elsewhere = path.join(scratch, 'elsewhere');
    writeFileSync(elsewhere, 'untouched\n');
    symlinkSync(elsewhere, awayFile);
    const r = await away(['on', 'board']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a plain file[\s\S]*Next: .*node bin\/away\.mjs off/);
    assert.deepEqual(asked(), []);
    assert.equal((await away(['off'])).code, 0);
    assert.ok(!existsSync(awayFile) && readFileSync(elsewhere, 'utf8') === 'untouched\n');
  });

  await check('a directory where the setting goes, which off cannot remove, is refused by on as one to remove by hand', async () => {
    reset();
    mkdirSync(awayFile);
    const r = await away(['on', 'board']);
    assert.deepEqual([r.code, r.stdout], [1, '']);
    assert.match(r.stderr, /is not a plain file\.\nNext: remove it by hand, then run this again\./);
    assert.deepEqual(asked(), []);
  });

  await check('off refuses the name at once, then takes the forwarder down; run again it has nothing to do', async () => {
    reset();
    await away(['on', 'board']);
    writeFileSync(argvLog, '');
    const r = await away(['off']);
    assert.deepEqual([r.code, r.stderr], [0, '']);
    const off = calls().find(call => call.args.join(' ') === SERVE_OFF);
    assert.deepEqual([off.awayFile, existsSync(awayFile)], [false, false], 'the setting goes before the forwarder does');
    assert.match(r.stdout, /Away is off[\s\S]*publishes nothing for this board/);
    assert.equal(await boardAnswers(), 403);
    writeFileSync(argvLog, '');
    const again = await away(['off']);
    assert.deepEqual([again.code, asked()], [0, ['serve status --json']]);
    assert.match(again.stdout, /already off[\s\S]*publishes nothing for this board/);
  });

  await check('off turns the board\'s name away with no Tailscale to ask, and fails only when the setting itself stays', async () => {
    for (const state of [{ serve: published(port), offFails: true }, {}]) {
      reset(state);
      writeFileSync(awayFile, `${HOST}\n`, { mode: 0o600 });
      const env = state.offFails ? {} : { CLAUDE_BOARD_TAILSCALE_CMD: path.join(scratch, 'no-such-tailscale') };
      const r = await away(['off'], env);
      assert.deepEqual([r.code, existsSync(awayFile)], [0, false]);
      assert.match(r.stderr, state.offFails ? /cannot turn that off[\s\S]*still publishes[\s\S]*Next: run `tailscale serve --https=443 off`/ : /was not found[\s\S]*Next: once Tailscale runs/);
    }
    reset({ serve: { Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } } });
    const foreign = await away(['off']);
    assert.equal(foreign.code, 0);
    assert.match(foreign.stderr, /Left alone[\s\S]*127\.0\.0\.1:3000/);
    assert.ok(!asked().includes(SERVE_OFF), 'another program\'s forwarder is not this command\'s to take down');
    reset();
    mkdirSync(awayFile);
    const stuck = await away(['off']);
    assert.equal(stuck.code, 1);
    assert.match(stuck.stderr, /could not be removed[\s\S]*Next: /);
  });

  await check('link prints one https address on stdout that signs in one browser, landing where it was asked to', async () => {
    reset();
    writeFileSync(awayFile, `${HOST}\n`, { mode: 0o600 });
    for (const [args, lands] of [[['link'], '/'], [['link', 'b_0123456789abcdef'], '/b/b_0123456789abcdef']]) {
      const r = await away(args);
      assert.equal(r.code, 0, r.stderr);
      const [, token] = /^https:\/\/board\.example\.ts\.net\/auth\/([0-9a-f]{64})\n$/.exec(r.stdout) ?? [];
      assert.match(token ?? '', HANDOFF_TOKEN_RE, r.stdout);
      assert.match(r.stderr, /once, for 10 minutes/);
      const signedIn = await rawRequest(port, 'POST', `/auth/${token}`, { host: HOST, headers: { origin: `https://${HOST}` } });
      assert.deepEqual([signedIn.status, signedIn.headers.location], [303, lands]);
    }
    assert.deepEqual(asked(), [], 'a link needs nothing of Tailscale');
  });

  await check('link refuses with away off, a board it cannot name, a daemon that is down, one that predates away, and whatever else holds the port', async () => {
    reset();
    const isOff = await away(['link']);
    assert.deepEqual([isOff.code, isOff.stdout], [1, '']);
    assert.match(isOff.stderr, /away is off[\s\S]*Next: .*node bin\/away\.mjs on <name>/);
    writeFileSync(awayFile, `${HOST}\n`, { mode: 0o600 });
    chmodSync(awayFile, 0o640);
    const openToOthers = await away(['link']);
    assert.deepEqual([openToOthers.code, openToOthers.stdout], [1, '']);
    assert.match(openToOthers.stderr, /mode 640[\s\S]*Next: /);
    chmodSync(awayFile, 0o600);
    const unnamed = await away(['link', '../x']);
    assert.deepEqual([unnamed.code, unnamed.stdout], [1, '']);
    assert.match(unnamed.stderr, /not a board id/);
    const down = await away(['link'], { CLAUDE_BOARD_PORT: String(await freePort()) });
    assert.deepEqual([down.code, down.stdout], [1, '']);
    assert.match(down.stderr, /not reachable[\s\S]*launchctl kickstart/);
    for (const [answer, says] of [
      [{ token: 'f'.repeat(64), ttlMs: 30000 }, /older than away links[\s\S]*install\.sh/],
      [{ token: 'evil.example/x', origin: 'away', host: 'evil.example' }, /no usable handoff token/],
      [null, /no usable handoff token/],
    ]) {
      const other = http.createServer((req, res) => res.end(JSON.stringify(answer)));
      await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
      const r = await away(['link'], { CLAUDE_BOARD_PORT: String(other.address().port) });
      other.close();
      assert.deepEqual([r.code, r.stdout], [1, '']);
      assert.match(r.stderr, says);
    }
    const other = path.join(scratch, 'other');
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(path.join(other, 'secret'), `${SECRET}\n`, { mode: 0o600 });
    writeFileSync(path.join(other, 'away'), `${HOST}\n`, { mode: 0o600 });
    reset();
    const daemonOff = await away(['link'], { CLAUDE_BOARD_SECRET_FILE: path.join(other, 'secret') });
    assert.deepEqual([daemonOff.code, daemonOff.stdout], [1, '']);
    assert.match(daemonOff.stderr, /HTTP 409[\s\S]*away is off[\s\S]*Next: .*node bin\/away\.mjs status/);
  });

  await check('status reads and changes nothing; a word it does not know prints how to call it', async () => {
    reset({ serve: published(port) });
    writeFileSync(awayFile, `${HOST}\n`, { mode: 0o600 });
    const r = await away(['status']);
    assert.match(r.stdout, /Away is on: https:\/\/board\.example\.ts\.net\n.*publishes this board/);
    assert.deepEqual(asked(), ['serve status --json']);
    writeFileSync(argvLog, '');
    for (const args of [[], ['on'], ['off', 'now'], ['nonsense'], ['on', 'board', 'extra']]) {
      const usage = await away(args);
      assert.equal(usage.code, 1);
      assert.match(usage.stderr, /Usage: node bin\/away\.mjs on <name>/);
    }
    assert.deepEqual([asked(), statSync(awayFile).size], [[], HOST.length + 1]);
  });
}

await runMain('away', main, { cleanup: () => { server?.close(); rmSync(scratch, { recursive: true, force: true }); } });
