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

import { spawn } from 'node:child_process';
import { daemonPort } from '../src/secret.mjs';
import { SAFE_BOARD_ID } from '../src/handoff.mjs';
import { die, mintHandoff } from '../src/mint-handoff.mjs';

const OPEN_CMD = process.env.CLAUDE_BOARD_OPEN_CMD || 'open';

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const boardId = args.find(a => !a.startsWith('-')) ?? null;

if (boardId !== null && !SAFE_BOARD_ID.test(boardId)) {
  die(`claude-board authorize: ${JSON.stringify(boardId)} is not a board id.`,
    'Usage: node bin/authorize.mjs [--print] [boardId]');
}

const minted = await mintHandoff('authorize', { boardId });
// Built from THIS process's own base URL, never from anything in the response body:
// during a restart window whatever bound the port first answers here, and the next step
// hands the result to a GUI launcher. Same guard, same reason, as bin/mcp.mjs.
const url = `http://127.0.0.1:${daemonPort()}/auth/${minted.token}`;

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
