// The sign-in link: one click that starts a screen run's sign-in browser on this Mac. See
// PROTOCOL.md "Starting a sign-in" and SECURITY.md "The sign-in link".
//
//   POST /api/signin-link  (secret required)  { app, recipe } -> { url }
//   GET  /signin/<token>   consumes it, starts the command, answers a plain page
//
// The opposite of a handoff in the two ways that matter. It grants nothing: the store
// below is its own instance, so no token of its can reach `GET /auth/<token>`, and the
// route sets no cookie. And it has no lifetime, because a person reads it in a chat and
// clicks when they are at the machine, which a handoff's 30 seconds cannot cover. What
// bounds it instead: one use, memory only, gone on a daemon restart.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHandoffStore } from './handoff.mjs';

/** Unused links a daemon holds. Links never expire, so this is the only thing that stops
 * a loop growing the store for the life of the process; a mint past it is refused, never
 * made room for, because a link already handed out stays good until it is used. */
export const MAX_SIGNIN_LINKS = 32;

const SAFE_APP = /^[a-z][a-z0-9-]*$/;

export function createSigninStore() {
  return createHandoffStore({ ttlMs: Infinity, maxLive: MAX_SIGNIN_LINKS });
}

/** Absent from bin/launcher.c's passthrough list on purpose: under the launcher this is
 * always the default, from the compiled-in HOME, so rewriting the plist cannot choose what
 * the bundle runs. */
function signinScript() {
  return process.env.CLAUDE_BOARD_SIGNIN_SCRIPT || path.join(homedir(), '.claude', 'scripts', 'ui-evidence', 'capture.mjs');
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Why `{ app, recipe }` cannot start a sign-in right now, or null when it can. Asked at
 * the mint and again at the click: a link can wait for days, and a script or recipe gone by
 * then should read as a link that failed, not as a browser that never comes. */
export function signinRefusal({ app, recipe }) {
  if (!isFile(signinScript())) return 'the sign-in script is not installed on this machine';
  if (typeof app !== 'string' || !SAFE_APP.test(app)) return 'app must match ^[a-z][a-z0-9-]*$';
  if (typeof recipe !== 'string' || !path.isAbsolute(recipe) || !isFile(recipe)) return 'recipe must be an absolute path to an existing file';
  return null;
}

/** Start the command, detached so a daemon restart leaves the PM's sign-in running.
 * Resolves whether it started. An argument array, never a shell, and no token in it. */
export function startSignin({ app, recipe }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [signinScript(), 'signin', app, '--recipe', recipe], { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('exit', code => {
      if (code) console.error(`claude-board: the sign-in for ${app} exited with code ${code}`);
    });
  });
}

const page = (title, line) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
</head>
<body>
<h1>${title}</h1>
<p>${line}</p>
</body>
</html>
`;

export const SIGNIN_STARTED_PAGE = page(
  'The sign-in browser is opening',
  'It opens on the Mac running the board. Finish signing in there; you can close this tab.',
);

/** One page for used, unknown and could-not-start: a poller learns nothing about which it
 * hit, and the page holds nothing from the request. */
export const SIGNIN_SPENT_PAGE = page(
  'This sign-in link is spent',
  'It was already used, the board has restarted, or the sign-in could not start. Type the sign-in command your session named in a terminal instead, or ask it for a new link.',
);
