#!/usr/bin/env node
// launchd entry point (ticket 08 wires the plist); boots the HTTP server on
// 127.0.0.1:7391 (CLAUDE_BOARD_PORT overrides).
//
// Shutdown has to be prompt, because it is not rare: reload-on-change (below) exits
// the daemon whenever its own source changes, KeepAlive restarts it on crash or on
// that exit alike, and the revive command in every unreachable-daemon message is a
// kickstart. `server.close()` alone never gets there — it stops accepting new
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, DEFAULT_PORT } from '../src/server.mjs';

const SHUTDOWN_GRACE_MS = Number(process.env.CLAUDE_BOARD_SHUTDOWN_MS) || 2_000;
const WANTED_PORT = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT;

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

// --- reload on change (opt-in) -----------------------------------------------
//
// SPEC_LAUNCH.md criterion 17: a plist-level WatchPaths cannot restart this job.
// WatchPaths only ever *starts* a job that isn't running, and KeepAlive guarantees
// this one always already is, so the two keys fight instead of composing (see
// QUIRKS.md "WatchPaths does not restart the daemon"). The mechanism that DOES
// compose with KeepAlive is the daemon exiting itself: KeepAlive brings it straight
// back up, and whatever changed on disk is what the new process runs.
//
// Opt-in via CLAUDE_BOARD_RELOAD_ON_CHANGE=1, which only install.sh's generated
// plist sets (in EnvironmentVariables). Default OFF is load-bearing, not a nicety:
// this same file is spawned constantly by the check suite (test/check-mcp.mjs,
// test/check-install.mjs) and by hand during development, none of which expect a
// file touch under src/ or bin/ — e.g. an editor's atomic save, or this very check
// suite copying fixtures around — to make their daemon vanish mid-test. On, this
// only ever runs under launchd, where KeepAlive is the reason it's safe.
if (process.env.CLAUDE_BOARD_RELOAD_ON_CHANGE === '1') {
  watchForReload();
}

function watchForReload() {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const watchDirs = [path.join(repoRoot, 'src'), path.join(repoRoot, 'bin')];

  // Editors don't write a file in place; they write a temp file and rename it over
  // the target (sometimes twice — once for a backup), which is two or three fs
  // events for one save. Debounce so one save triggers exactly one exit, and log
  // whichever file was seen first — the rest of the burst is that same save, not
  // separate news.
  const DEBOUNCE_MS = 300;
  let debounceTimer = null;
  let firstTrigger = null;

  function onEvent(dirLabel, filename) {
    if (!firstTrigger) firstTrigger = `${dirLabel}/${filename || '(unknown file)'}`;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // The one required log line: which file, and why the daemon is about to
      // disappear from under whoever is watching it.
      console.error(
        `claude-board daemon exiting to reload: ${firstTrigger} changed ` +
        `(CLAUDE_BOARD_RELOAD_ON_CHANGE=1). launchd KeepAlive restarts it; it will not ` +
        `do so more than once per 10s, so a second edit inside that window waits out ` +
        `the rest of it before the daemon comes back.`
      );
      shutdown('reload on change');
    }, DEBOUNCE_MS);
    debounceTimer.unref();
  }

  for (const dir of watchDirs) {
    const label = path.basename(dir);
    try {
      // Non-recursive (no `recursive: true`): src/ and bin/ are both flat, and
      // recursive watching is only portable to macOS/Windows anyway — staying
      // non-recursive means this never has to think about that.
      const watcher = fs.watch(dir, (eventType, filename) => onEvent(label, filename));
      watcher.unref?.();
    } catch (err) {
      console.error(`claude-board daemon: could not watch ${dir} for reload (${(err && err.code) || err})`);
    }
  }
}
