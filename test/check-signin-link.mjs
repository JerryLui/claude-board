// The sign-in link (src/signin-link.mjs), against a real bin/daemon.mjs on a scratch port and
// a fake sign-in script that records how it was started: a restart has to be a real one, and
// the daemon's own output is one of the places the token must not reach.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSignin } from '../src/signin-link.mjs';
import { SESSION_COOKIE } from '../src/secret.mjs';
import { check, freePort, listFiles, rawRequest, readJsonLines, repoRoot, runMain, secretHome, sessionCookieHeader, waitFor, waitForHealthy, writeHeaders } from './support.mjs';

const { home, secret } = secretHome('claude-board-signin-');
const work = mkdtempSync(path.join(tmpdir(), 'claude-board-signin-work-'));
const script = path.join(work, 'fake-capture.mjs');
const recipe = path.join(work, 'WAYS OF WORKING.md');
const started = path.join(work, 'started.jsonl');
const SIGNIN_URL = /^\/signin\/[0-9a-f]{64}$/;

writeFileSync(recipe, '# a recipe\n');
writeFileSync(script, `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const app = process.argv[3];
console.error('stderr of ' + app);
if (app === 'dies-at-once') process.exit(1);
const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout);
appendFileSync(${JSON.stringify(started)}, JSON.stringify({ node: process.execPath, argv: process.argv.slice(1), pid: process.pid, pgid }) + '\\n');
if (app === 'stays-up') setTimeout(() => {}, 30000);
`);

const port = await freePort();
let daemon = null;
let daemonOutput = '';
const tokens = [];

async function startDaemon() {
  daemon = spawn(process.execPath, [path.join(repoRoot, 'bin', 'daemon.mjs')], {
    env: { ...process.env, CLAUDE_BOARD_PORT: String(port), CLAUDE_BOARD_SIGNIN_SCRIPT: script },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', c => { daemonOutput += c; });
  daemon.stderr.on('data', c => { daemonOutput += c; });
  assert.ok(await waitForHealthy(port, 15000), `the daemon came up:\n${daemonOutput}`);
}

function stopDaemon() {
  return new Promise(resolve => {
    if (!daemon || daemon.exitCode !== null) return resolve();
    daemon.once('exit', resolve);
    daemon.kill('SIGTERM');
  });
}

async function request(method, pathName, opts) {
  const res = await rawRequest(port, method, pathName, opts);
  assert.equal(res.headers['set-cookie'], undefined, `${method} ${pathName} sets no cookie`);
  return res;
}

const mintBody = (over = {}) => JSON.stringify({ app: 'demo-app2', recipe, ...over });
const mintRequest = (body = mintBody(), headers = writeHeaders(secret)) => request('POST', '/api/signin-link', { headers, body });

async function mint(over) {
  const res = await mintRequest(mintBody(over));
  assert.equal(res.status, 200, res.body);
  const { url, ...rest } = JSON.parse(res.body);
  assert.deepEqual(rest, {}, 'the mint answers the url and nothing else');
  const { origin, pathname } = new URL(url);
  assert.equal(origin, `http://127.0.0.1:${port}`);
  assert.match(pathname, SIGNIN_URL);
  tokens.push(pathname.split('/')[2]);
  return pathname;
}

const startedRuns = () => readJsonLines(started);
const STARTED_PAGE = '<h1>The sign-in browser is opening</h1>\n<p>It opens on the Mac running the board. Finish signing in there; you can close this tab.</p>';
const SPENT_PAGE = '<h1>This sign-in link is spent</h1>\n<p>It was already used, the board has restarted, or the sign-in could not start. Type the sign-in command your session named in a terminal instead, or ask it for a new link.</p>';

/** A link for `app`, clicked, and its run on record. Everything an earlier click started has
 * landed by then, so a run count taken after this is a settled one. */
async function settleOn(app) {
  const link = await mint({ app });
  assert.equal((await request('GET', link)).status, 200);
  await waitFor(() => startedRuns().some(run => run.argv[2] === app), { what: `the ${app} run` });
}

async function main() {
  await startDaemon();

  await check('only the secret mints: nothing, the session cookie and a cross-origin page are refused', async () => {
    const json = { 'content-type': 'application/json' };
    assert.equal((await mintRequest(mintBody(), json)).status, 401);
    assert.equal((await mintRequest(mintBody(), { ...json, cookie: sessionCookieHeader(secret) })).status, 401);
    assert.equal((await mintRequest(mintBody(), writeHeaders(secret, { origin: 'http://evil.example' }))).status, 403);
  });

  await check('a mint is refused for a bad app or recipe', async () => {
    const rows = [
      { app: 'a'.repeat(65) }, { app: 'Upper' }, { app: '-flag' }, { app: '9lead' }, { app: 'a b' }, { app: 'app\n' }, { app: '' }, { app: 5 }, { app: undefined },
      { recipe: 'relative.md' }, { recipe: path.join(work, 'missing.md') }, { recipe: work }, { recipe: `${recipe}\0` }, { recipe: 5 }, { recipe: undefined },
    ];
    for (const row of rows) {
      const res = await mintRequest(mintBody(row));
      assert.equal(res.status, 400, `${JSON.stringify(row)} is refused`);
      assert.deepEqual(Object.keys(JSON.parse(res.body)), ['error']);
    }
  });

  await check('a mint is refused while the sign-in script is absent', async () => {
    renameSync(script, `${script}.away`);
    try {
      assert.equal((await mintRequest()).status, 400);
    } finally {
      renameSync(`${script}.away`, script);
    }
  });

  await check('a link is refused off loopback, and that refusal does not spend it', async () => {
    const link = await mint({ app: 'host-guard' });
    assert.equal((await request('GET', link, { host: 'evil.example' })).status, 403);
    assert.equal((await request('GET', link)).status, 200);
    await waitFor(() => startedRuns().some(run => run.argv[2] === 'host-guard'), { what: 'the host-guard run' });
  });

  await check('another site cannot spend a link: it reads as spent and the link stays good', async () => {
    const link = await mint({ app: 'cross-site' });
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'http://evil.example' }]) {
      const res = await request('GET', link, { headers });
      assert.equal(res.status, 410, JSON.stringify(headers));
      assert.ok(res.body.includes(SPENT_PAGE), res.body);
    }
    assert.equal((await request('GET', link, { headers: { 'sec-fetch-site': 'none' } })).status, 200);
    await waitFor(() => startedRuns().some(run => run.argv[2] === 'cross-site'), { what: 'the cross-site run' });
  });

  await check('the first click starts the script once, detached, with exactly the command', async () => {
    const link = await mint();
    const res = await request('GET', link);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.body.includes(STARTED_PAGE), res.body);
    assert.ok(!res.body.includes(tokens.at(-1)), 'the page does not repeat the token');

    await waitFor(() => startedRuns().some(run => run.argv[2] === 'demo-app2'), { what: 'the run' });
    const run = startedRuns().find(r => r.argv[2] === 'demo-app2');
    assert.equal(run.node, process.execPath);
    assert.deepEqual(run.argv, [script, 'signin', 'demo-app2', '--recipe', recipe]);
    assert.equal(run.pgid, run.pid, 'it leads its own process group, so a board restart leaves it running');

    const replay = await request('GET', link);
    assert.equal(replay.status, 410, 'the second click is spent');
    const unknown = await request('GET', `/signin/${'f'.repeat(64)}`);
    assert.equal(unknown.status, 410);
    assert.equal(unknown.body, replay.body, 'used and unknown read the same');
    assert.equal((await request('GET', '/signin/not-a-token')).body, replay.body);
    assert.ok(replay.body.includes(SPENT_PAGE), replay.body);
    assert.ok(!replay.body.includes(tokens.at(-1)), 'the spent page holds no token');

    await settleOn('after-replay');
    assert.equal(startedRuns().filter(r => r.argv[2] === 'demo-app2').length, 1, 'the replay started nothing');
  });

  await check('neither store answers for the other: a sign-in token is no handoff, and a handoff no sign-in', async () => {
    const link = await mint({ app: 'cross-store' });
    const token = link.split('/')[2];
    assert.equal((await request('GET', `/auth/${token}`)).status, 401);

    const handoff = JSON.parse((await request('POST', '/api/handoff', { headers: writeHeaders(secret), body: '{}' })).body).token;
    assert.equal((await request('GET', `/signin/${handoff}`)).status, 410);
    const redeemed = await rawRequest(port, 'GET', `/auth/${handoff}`);
    assert.match(String(redeemed.headers['set-cookie']), new RegExp(`^${SESSION_COOKIE}=`), 'the sign-in route left the handoff unspent');
  });

  await check('a recipe gone by the click reads as spent and starts nothing', async () => {
    const moved = path.join(work, 'moved.md');
    writeFileSync(moved, '# a recipe\n');
    const link = await mint({ app: 'gone-recipe', recipe: moved });
    rmSync(moved);
    assert.equal((await request('GET', link)).status, 410);
    await settleOn('after-gone-recipe');
    assert.ok(!startedRuns().some(run => run.argv[2] === 'gone-recipe'));
  });

  await check('a sign-in that dies at once reads as spent, never as opening', async () => {
    const res = await request('GET', await mint({ app: 'dies-at-once' }));
    assert.equal(res.status, 410);
    assert.ok(res.body.includes(SPENT_PAGE), res.body);
  });

  await check('a sign-in still running past the wait reads as opening', async () => {
    const res = await request('GET', await mint({ app: 'stays-up' }));
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(STARTED_PAGE), res.body);
    await waitFor(() => startedRuns().some(run => run.argv[2] === 'stays-up'), { what: 'the stays-up run' });
    process.kill(startedRuns().find(run => run.argv[2] === 'stays-up').pid);
  });

  await check("a run's stderr reaches the daemon's output, a clean exit's warning as much as a failure's", async () => {
    await settleOn('warns-and-exits-0');
    for (const app of ['dies-at-once', 'warns-and-exits-0']) await waitFor(() => daemonOutput.includes(`stderr of ${app}`), { what: `the stderr of ${app}` });
  });

  await check('a spawn that fails, thrown or emitted, answers false', async () => {
    assert.equal(await startSignin({ app: 'thrown', recipe: 'nul\0' }), false, 'node throws on a NUL in an argument');
    const node = process.execPath;
    process.execPath = path.join(work, 'no-such-node');
    const emitted = startSignin({ app: 'emitted', recipe });
    process.execPath = node;
    assert.equal(await emitted, false, 'a missing binary is an error event');
  });

  await check('a restart voids an unused link', async () => {
    const link = await mint({ app: 'unused' });
    await stopDaemon();
    await startDaemon();
    const res = await request('GET', link);
    assert.equal(res.status, 410);
    assert.ok(res.body.includes(SPENT_PAGE), res.body);
    await settleOn('after-restart');
    assert.ok(!startedRuns().some(run => run.argv[2] === 'unused'));
  });

  await check('a second mint for the same app leaves the first link good', async () => {
    const app = 'a'.repeat(64);
    const links = [await mint({ app }), await mint({ app })];
    assert.notEqual(links[0], links[1]);
    for (const link of links) assert.equal((await request('GET', link)).status, 200);
    await waitFor(() => startedRuns().filter(run => run.argv[2] === app).length === 2, { what: 'both runs' });
  });

  await check('no token reaches the board data dir, the daemon output, or the started command', async () => {
    await stopDaemon();
    const files = listFiles(home);
    assert.ok(files.length > 0, 'the data dir holds files to search');
    const written = [daemonOutput, readFileSync(started, 'utf8'), ...files.map(file => readFileSync(file, 'utf8'))].join('\n');
    for (const token of tokens) assert.ok(!written.includes(token));
  });
}

await runMain('signin-link', main, {
  cleanup: async () => {
    await stopDaemon();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  },
});
