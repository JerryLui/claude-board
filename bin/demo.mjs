#!/usr/bin/env node
// The one-command "does my install actually work" moment: posts
// examples/sample-board.json to the locally installed daemon and prints/opens the
// resulting board URL. /api/health only proves a port is bound; this exercises the
// real chain a newcomer cares about -- the secret, the write gate, normalizeBlock,
// the render, the served page.
//
//   npm run demo             post the sample board, print its URL, open it
//
// Plain node:http, exactly like bin/authorize.mjs and bin/mcp.mjs, and deliberately
// not curl and not fetch()/undici. node:http consults no HTTP_PROXY/HTTPS_PROXY/
// ALL_PROXY environment variable at all -- that plumbing lives in CLI tools like curl
// and in undici's opt-in EnvHttpProxyAgent, neither of which this file touches -- so a
// `*_proxy` set for the rest of the shell cannot intercept this loopback call. There is
// no `--noproxy` to remember here because there is no proxy path to opt out of.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readSecret, secretPath, SECRET_HEADER } from '../src/secret.mjs';

const PORT = Number(process.env.CLAUDE_BOARD_PORT) || 7391;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OPEN_CMD = process.env.CLAUDE_BOARD_OPEN_CMD || 'open';
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_POST_TIMEOUT_MS) || 10_000;

function die(...lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

// Checked before any network call, same as bin/authorize.mjs: a caller with no
// secret can never post, so there is nothing to gain from waiting on a socket first.
const secret = readSecret();
if (!secret) {
  die(
    `claude-board demo: no local secret at ${secretPath()}.`,
    'Posting a board requires it -- the daemon only accepts writes from a caller holding it.',
    'Fix: run ./install.sh from the claude-board repository. It generates the secret if there',
    'isn\'t one and never rotates an existing one.'
  );
}

/** Strip the fields normalizeBlock (src/board.mjs) computes at post time and never
 * reads back from a caller -- sha, anchors, error, round, startLine -- recursively
 * through every nested block a question's context, a compare side, or a
 * choose-between-rendered-variants option can carry. What's left is exactly the raw
 * shape POST /api/board accepts: kind, id, plus either a source Ref or by-value
 * text/html. The committed sample board carries no source refs at all (its own `cwd`
 * is null -- see examples/sample-board.mjs), so nothing here needs `cwd` either;
 * every block posts by value and the whole board lands in one fresh round. */
function toPostableBlock(block) {
  if (!block || typeof block !== 'object') return block;
  const { sha, anchors, error, round, startLine, ...rest } = block;
  if (Array.isArray(rest.context)) rest.context = rest.context.map(toPostableBlock);
  if (rest.left) rest.left = { ...rest.left, block: toPostableBlock(rest.left.block) };
  if (rest.right) rest.right = { ...rest.right, block: toPostableBlock(rest.right.block) };
  if (Array.isArray(rest.options)) {
    rest.options = rest.options.map(o => ('block' in o) ? { ...o, block: toPostableBlock(o.block) } : o);
  }
  return rest;
}

const samplePath = fileURLToPath(new URL('../examples/sample-board.json', import.meta.url));
let sample;
try {
  sample = JSON.parse(readFileSync(samplePath, 'utf8'));
} catch (err) {
  die(`claude-board demo: could not read ${samplePath} (${err.message}).`);
}

const payload = {
  title: sample.title || 'claude-board demo',
  blocks: (sample.blocks || []).map(toPostableBlock),
};

/** POST a JSON body and resolve the parsed response, or reject with a tagged error.
 * Same shape as bin/authorize.mjs's postJson. */
function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        host: u.host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        [SECRET_HEADER]: secret,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(text || `daemon responded ${res.statusCode}`), { statusCode: res.statusCode }));
        }
        try { resolve(JSON.parse(text || '{}')); } catch (err) { reject(new Error(`invalid JSON from daemon: ${err.message}`)); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('daemon request timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

let result;
try {
  result = await postJson(`${BASE_URL}/api/board`, payload);
} catch (err) {
  if (err.statusCode === 401) {
    die(
      'claude-board demo: the daemon rejected this machine\'s local secret (HTTP 401).',
      `The daemon is running, so this is a credential mismatch: it was started with a different secret than the one now at ${secretPath()}.`,
      'Fix: restart the service so it re-reads the file -- launchctl kickstart -k gui/$(id -u)/claude-board'
    );
  }
  if (typeof err.statusCode === 'number') {
    die(`claude-board demo: the daemon refused the sample board (HTTP ${err.statusCode}): ${err.message}`);
  }
  die(
    `claude-board demo: the daemon is not reachable at ${BASE_URL} (${err.code || err.message}).`,
    'It looks like the daemon is not running, or not installed on this machine yet.',
    'Fix: run ./install.sh from the claude-board repository.',
    'Already installed? Revive it with: launchctl kickstart -k gui/$(id -u)/claude-board'
  );
}

// Built from THIS process's own base URL and the response, never trusted blindly:
// during a restart window whatever bound the port first answers here, same guard as
// bin/authorize.mjs's handoff token check.
if (typeof result.url !== 'string' || !result.url.startsWith(`${BASE_URL}/b/`)) {
  die('claude-board demo: the daemon returned no usable board URL. Something other than the claude-board daemon may be listening on the port.');
}

// stdout carries only the URL, so this line is pipeable/scriptable; everything else
// is advisory and goes to stderr, same split as bin/authorize.mjs.
console.log(result.url);
console.error(`claude-board demo: posted the sample board (round ${result.round}). Opening it now.`);

try {
  const child = spawn(OPEN_CMD, [result.url], { stdio: 'ignore', detached: true });
  child.on('error', err => {
    console.error(`claude-board demo: could not run ${OPEN_CMD} (${err.message}). Open this yourself:\n${result.url}`);
  });
  child.unref();
} catch (err) {
  console.error(`claude-board demo: could not run ${OPEN_CMD} (${err.message}). Open this yourself:\n${result.url}`);
}
