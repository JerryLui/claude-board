#!/usr/bin/env node
// The recovery command. One command that re-authorizes a browser holding no
// credential — a cleared cookie jar, a second profile, a different browser — without
// reinstalling, restarting the service, or touching the store.
//
// This is part of the read gate, not a convenience beside it. Gating reads means a
// credential can be lost, and the board's entire value is that the page opens; without
// this the first cleared cookie jar reads as a broken install. src/render.mjs's refusal
// page names this file by absolute path, and src/handoff.mjs `recoveryCommand` is the
// single source of that string.
//
//   node bin/authorize.mjs                 mint a handoff, open the default browser on it
//   node bin/authorize.mjs --print         print the URL instead — paste it into whichever
//                                          browser or profile actually needs authorizing
//   node bin/authorize.mjs <boardId>       land on that board rather than the index
//
// It needs the local secret, because minting a handoff is a write. That is the correct
// boundary and not an inconvenience: anything that could authorize a browser without the
// secret would be a way around the gate this exists to serve.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readSecret, secretPath, SECRET_HEADER } from '../src/secret.mjs';
import { HANDOFF_TOKEN_RE, SAFE_BOARD_ID } from '../src/handoff.mjs';

const PORT = Number(process.env.CLAUDE_BOARD_PORT) || 7391;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OPEN_CMD = process.env.CLAUDE_BOARD_OPEN_CMD || 'open';
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_POST_TIMEOUT_MS) || 10_000;

function die(...lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const boardId = args.find(a => !a.startsWith('-')) ?? null;

if (boardId !== null && !SAFE_BOARD_ID.test(boardId)) {
  die(`claude-board authorize: ${JSON.stringify(boardId)} is not a board id.`,
    'Usage: node bin/authorize.mjs [--print] [boardId]');
}

const secret = readSecret();
if (!secret) {
  // Same fix, same wording discipline as bin/mcp.mjs `missingSecretMessage`: name the
  // command that actually helps, and no others. A kickstart fixes nothing here.
  die(
    `claude-board authorize: no local secret at ${secretPath()}.`,
    'Authorizing a browser requires it — the daemon derives the browser\'s cookie from it.',
    'Fix: run ./install.sh from the claude-board repository. It generates the secret if there',
    'isn\'t one and never rotates an existing one.'
  );
}

/** POST a JSON body and resolve the parsed response, or reject with a tagged error.
 * Plain node:http, zero dependencies, same as the rest of this repository. */
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

let minted;
try {
  minted = await postJson(`${BASE_URL}/api/handoff`, { boardId });
} catch (err) {
  if (err.statusCode === 401) {
    die(
      'claude-board authorize: the daemon rejected this machine\'s local secret (HTTP 401).',
      `The daemon is running, so this is a credential mismatch: it was started with a different secret than the one now at ${secretPath()}.`,
      'Fix: restart the service so it re-reads the file — launchctl kickstart -k gui/$(id -u)/claude-board'
    );
  }
  if (typeof err.statusCode === 'number') {
    die(`claude-board authorize: the daemon refused to mint a handoff (HTTP ${err.statusCode}): ${err.message}`);
  }
  die(
    `claude-board authorize: the daemon is not reachable at ${BASE_URL} (${err.code || err.message}).`,
    'Revive it with: launchctl kickstart -k gui/$(id -u)/claude-board',
    'If it was never installed on this machine, run ./install.sh from the claude-board repository first.'
  );
}

// Built from THIS process's own base URL, never from anything in the response body:
// during a restart window whatever bound the port first answers here, and the next step
// hands the result to a GUI launcher. Same guard, same reason, as bin/mcp.mjs.
if (typeof minted.token !== 'string' || !HANDOFF_TOKEN_RE.test(minted.token)) {
  die('claude-board authorize: the daemon returned no usable handoff token. Something other than the daemon may be listening on the port.');
}
const url = `${BASE_URL}/auth/${minted.token}`;

if (printOnly) {
  // stdout, alone on a line, so it can be piped or copied. The advisory goes to stderr.
  console.log(url);
  console.error(
    `Single use, valid for about ${Math.max(1, Math.round((minted.ttlMs ?? 0) / 1000))}s. ` +
    'Open it in the browser you want authorized; it redirects to a clean URL you can bookmark.'
  );
  process.exit(0);
}

// Detached and unref'd: authorizing must not leave a process hanging around waiting for
// a browser to exit. Failure is reported rather than swallowed — a silent no-op here is
// indistinguishable from the gate being broken.
try {
  const child = spawn(OPEN_CMD, [url], { stdio: 'ignore', detached: true });
  child.on('error', err => {
    console.error(`claude-board authorize: could not run ${OPEN_CMD} (${err.message}). Open this yourself, once, within a few seconds:\n${url}`);
    process.exit(1);
  });
  child.unref();
} catch (err) {
  die(`claude-board authorize: could not run ${OPEN_CMD} (${err.message}). Open this yourself, once, within a few seconds:\n${url}`);
}

console.error('claude-board: opening an authorized tab. The URL it lands on carries no credential and is safe to bookmark.');
