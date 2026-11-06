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

const SAFE_APP = /^[a-z][a-z0-9-]{0,63}$/;

/** No count limit: a link handed out stays good until it is used, so a mint never makes room,
 * and only the secret's holder mints. `SAFE_APP`'s length bounds what one link can hold. */
export function createSigninStore() {
  return createHandoffStore({ ttlMs: Infinity });
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
  if (typeof app !== 'string' || !SAFE_APP.test(app)) return `app must match ${SAFE_APP.source}`;
  if (typeof recipe !== 'string' || !path.isAbsolute(recipe) || !isFile(recipe)) return 'recipe must be an absolute path to an existing file';
  return null;
}

/** How long a click waits before it says the browser is opening. What cannot start (an app
 * with no sign-in, a recipe that no longer parses, a Chromium that cannot launch) exits inside
 * this; what lives past it is a browser on its way. */
const EARLY_EXIT_MS = 2000;

/** Start the command, detached so a daemon restart leaves the PM's sign-in running. Resolves
 * false on a spawn that fails, thrown or emitted, or a non-zero exit inside the wait, and true
 * otherwise. An argument array, never a shell, and no token in it.
 *
 * Its stderr is the daemon's own descriptor, so a line the run writes after a click (a profile
 * it could not remove) lands in the daemon's log. Inherited, not piped: a pipe would end with
 * this daemon and leave a surviving run writing to nothing. */
export function startSignin({ app, recipe }) {
  return new Promise(resolve => {
    const failed = reason => {
      console.error(`claude-board: the sign-in for ${app} could not start: ${reason}`);
      resolve(false);
    };
    let child;
    try {
      child = spawn(process.execPath, [signinScript(), 'signin', app, '--recipe', recipe], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (err) {
      return failed(err.message);
    }
    child.once('error', err => failed(err.message));
    child.once('spawn', () => {
      child.unref();
      setTimeout(() => resolve(true), EARLY_EXIT_MS);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0) console.error(`claude-board: the sign-in for ${app} exited with ${signal ?? `code ${code}`}`);
      resolve(code === 0);
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
