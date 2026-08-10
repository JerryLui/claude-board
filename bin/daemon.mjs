#!/usr/bin/env node
// launchd entry point; boots the HTTP server on
// 127.0.0.1:7391 (CLAUDE_BOARD_PORT overrides).
//
// Shutdown has to be prompt, because it is not rare: KeepAlive restarts the daemon on
// every crash, `./install.sh` boots it out and back in to take an update, and the revive
// command in every unreachable-daemon message is a kickstart. `server.close()` alone
// never gets there — it stops accepting new
// connections and then waits for the open ones to end, and an SSE stream
// (/api/board/:id/events) never ends by design. launchd would SIGTERM, watch us
// ignore it, and SIGKILL after ExitTimeOut, so every reload cost ~20s of total
// outage — during which every `ask` fails — and ended in an unclean kill that can
// land mid-write. So: stop accepting, then destroy the open connections outright (an
// SSE client reconnects natively; a shim waiter reattaches by board id), with a short
// forced-exit timer as the backstop.
//
// Startup failure is reported, not thrown. `startServer` rejects on EADDRINUSE, and an
// unhandled rejection out of a top-level await is a stack trace with no name on the
// actual problem — which is exactly the shape of a launchd crash-loop (old process
// won't die, replacement can't bind, repeat). A service whose contract is "fail
// loudly" has to say what went wrong, in one line, on stderr where launchd keeps it.

import { startServer, DEFAULT_PORT } from '../src/server.mjs';

const SHUTDOWN_GRACE_MS = Number(process.env.CLAUDE_BOARD_SHUTDOWN_MS) || 2_000;
const WANTED_PORT = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT;

// The seam that makes bin/launcher.c's environment allowlist checkable without booting
// under real launchd: every variable actually present in this process's own
// environment, sorted, NAMES ONLY -- never values, since this goes to
// ~/Library/Logs/claude-board/daemon.out.log under a real install, which is not a
// private log. One line, printed unconditionally (not behind a debug flag) so a check
// -- or a person diagnosing "why can't the board read that file" -- can compare it
// against the launcher's compiled-in overrides and passthrough allowlist and see
// exactly what got through, rather than what was merely supposed to.
console.log(`claude-board env: ${Object.keys(process.env).sort().join(',')}`);

let started;
try {
  started = await startServer({});
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `claude-board daemon cannot start: 127.0.0.1:${WANTED_PORT} is already in use (EADDRINUSE). ` +
      `Another claude-board daemon is probably still running or still shutting down. ` +
      `Check with: lsof -nP -iTCP:${WANTED_PORT} -sTCP:LISTEN — then stop it, or restart the service with ` +
      `launchctl kickstart -k gui/$(id -u)/claude-board`
    );
  } else {
    console.error(`claude-board daemon cannot start: ${(err && (err.code || err.message)) || err}`);
  }
  process.exit(1);
}

const { server, port, home } = started;
console.log(`claude-board daemon listening on 127.0.0.1:${port} (store: ${home})`);

// Persistent, for everything after the initial bind: a listener error, or a stray
// rejection out of a request handler, must be visible in the log rather than take
// the service down silently (or, on some node versions, not at all).
server.on('error', err => {
  console.error(`claude-board daemon server error: ${(err && (err.code || err.message)) || err}`);
});
process.on('unhandledRejection', reason => {
  console.error('claude-board daemon unhandled rejection (the daemon stays up; this is a bug):', reason);
});
process.on('uncaughtException', err => {
  console.error('claude-board daemon uncaught exception, exiting for launchd to restart:', (err && err.stack) || err);
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return; // a second SIGTERM must not restart the clock
  shuttingDown = true;
  console.log(`claude-board daemon shutting down (${signal})`);

  // Backstop: exit even if a socket refuses to die. unref'd so it never keeps an
  // otherwise-finished process alive.
  const forced = setTimeout(() => {
    console.log('claude-board daemon forcing exit after shutdown grace period');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  server.close(() => process.exit(0));
  // Node >= 18.2. Idle keep-alive sockets go immediately — nothing is in flight on
  // them. Everything still open (the SSE streams, any held-open /wait, and possibly
  // a POST that landed a millisecond ago) gets a brief grace to finish first, so a
  // request that *can* complete does, and only then gets destroyed.
  server.closeIdleConnections?.();
  const cutOff = setTimeout(() => server.closeAllConnections?.(), Math.min(200, SHUTDOWN_GRACE_MS / 2));
  cutOff.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Source changes do NOT restart this daemon. It used to watch src/ and bin/ and exit
// on a write there (CLAUDE_BOARD_RELOAD_ON_CHANGE=1, set only by install.sh's generated
// plist), on the reasoning that KeepAlive would bring the new code straight back up.
// Removed deliberately: the daemon vanishing on every save is a restart nobody asked
// for in the middle of a review -- it drops every SSE stream and every held-open wait --
// and an edit landing mid-write could take the daemon down with a syntax error and leave
// launchd throttling a crash loop, which is exactly what happened. Updates go through
// `./install.sh` (or `launchctl kickstart -k gui/$(id -u)/claude-board` for a plain
// restart), i.e. at a moment somebody chose. A plist-level `WatchPaths` is not the answer
// either: it only ever *starts* a job that is not running, and `KeepAlive` guarantees this
// one always already is, so the two fight rather than compose.
