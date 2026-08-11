// The one-time handoff: how a browser that holds nothing becomes a browser that holds
// the session cookie. See PROTOCOL.md "Authorizing a browser".
//
// The shape, and why each half is the way it is:
//
//   POST /api/handoff   (secret required, like every other write)  -> { token }
//   GET  /auth/<token>  consumes it, sets the cookie, 302s to a CLEAN url
//
// The token is process-local state with a seconds-long TTL and exactly one use. That is
// the opposite of the session cookie it hands out (src/secret.mjs `sessionToken`), which
// is derived from the secret precisely so it survives a daemon restart — and the
// contrast is deliberate. A handoff that survived a restart would be a long-lived
// credential sitting in a URL, which was rejected outright; a session cookie that did
// NOT survive one would log
// every browser out on each `launchctl kickstart`.
//
// Accepted residual risk, stated rather than closed: opening a URL puts it in a process
// argument list, which any process running as this user can read with `ps`. Single-use
// plus a TTL measured in seconds means an attacker has to be polling continuously AND
// win the race against the browser that is already fetching it — and such a process
// could read the secret file anyway, so it is inside the trust boundary already. The
// mitigation is real; it is not elimination, and SECURITY.md says so.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Seconds, not minutes: the only gap this has to cover is "the shim called `open` and
 * the browser has not finished launching yet". A cold Safari/Chrome start is a couple of
 * seconds; 30 is generous for that and still short enough that a `ps` poller has almost
 * nothing to aim at. Overridable for the checks, which need to watch one expire without
 * sleeping for half a minute. */
export const DEFAULT_HANDOFF_TTL_MS = 30_000;

export function handoffTtlMs() {
  const v = Number(process.env.CLAUDE_BOARD_HANDOFF_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HANDOFF_TTL_MS;
}

/** 32 random bytes as hex. Checked rather than trusted at both ends: the daemon splices
 * nothing into a header from it, but the shim and bin/authorize.mjs both build a URL to
 * hand to `open` out of a value the daemon supplied, and "the daemon" is whatever is
 * listening on the port (see bin/mcp.mjs `safeBoardUrl` for the same reasoning). */
export const HANDOFF_TOKEN_RE = /^[0-9a-f]{64}$/;

// A board id is minted by src/board.mjs and always matches this, but the id in a
// handoff request is whatever the caller typed. It is spliced into the `Location`
// header of the redirect below, so it is checked rather than trusted: a CR/LF would
// forge a header and a leading `//` or scheme would turn the redirect into an open
// redirect off this origin.
//
// Re-exported from src/store.mjs rather than declared twice. The store is what turns an
// id into a filesystem path, so it owns the definition; two copies of one pattern is how
// a tightening in one place silently leaves the other wide.
export { SAFE_BOARD_ID } from './store.mjs';
import { SAFE_BOARD_ID } from './store.mjs';

/** Where a consumed handoff sends the browser. The caller names a BOARD, never a path:
 * the only two possible targets are this daemon's index and one of its board pages, so
 * there is no redirect target an attacker can choose in the first place. Anything that
 * is not a board id lands on the index rather than being refused — a stale board id is
 * a reason to show the reviewer the index, not a reason to leave them on an error. */
export function handoffTarget(boardId) {
  return typeof boardId === 'string' && SAFE_BOARD_ID.test(boardId) ? `/b/${boardId}` : '/';
}

/** The port the daemon listens on unless told otherwise. Declared HERE rather than in
 * src/server.mjs, which re-exports it: server.mjs imports this module, so the constant
 * has to live on the side that does not import back, and recoveryCommand below needs it
 * to know whether the port is worth naming. */
export const DEFAULT_PORT = 7391;

/** The repository this daemon is running from. `install.sh` points launchd at a clone
 * wherever the user put it, so this is the only way to name the recovery command with a
 * path that actually exists on the reader's machine.
 *
 * `CLAUDE_BOARD_REPO_ROOT` wins when it is set. It has to: `install.sh` now stages a copy
 * of `bin/daemon.mjs` and this whole `src/` directory into
 * `claude-board.app/Contents/Resources` and points the launcher at THAT copy (see
 * `bin/launcher.c`'s `CLAUDE_BOARD_DAEMON`, baked from the installed path, and its
 * `OVERRIDE_ENV`), so `import.meta.url` below would resolve to a directory inside the
 * bundle once a launcher is in use — and `bin/authorize.mjs`, which `recoveryCommand`
 * below names, is deliberately NOT copied there (it is the shim, run from the clone and
 * registered with Claude Code by absolute path). Naming it from inside the bundle would
 * print a command that does not exist. `CLAUDE_BOARD_REPO_ROOT` is the actual clone path
 * in that case, compiled into the launcher for the identical reason `CLAUDE_BOARD_NODE`
 * is. The plain computation below is what a daemon running directly out of a clone still
 * uses — the degraded (no-launcher) path, and anything importing this module out of a
 * clone directly (a check, a throwaway script). */
export function repoRoot() {
  if (process.env.CLAUDE_BOARD_REPO_ROOT) return process.env.CLAUDE_BOARD_REPO_ROOT;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Single-quote a path for a shell, if and only if it needs it. The clone lives wherever
 * the user cloned it, which is routinely `~/Documents/claude board` — a refusal page
 * that names a command the reader cannot paste is the same as naming no command at all. */
export function shellQuote(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The ONE command that re-authorizes a browser holding no credential — a cleared
 * cookie jar, a second profile, a different browser. Absolute by default, so it can be
 * pasted from anywhere; named verbatim by the refusal page's JSON error body, by
 * bin/mcp.mjs when it cannot mint a handoff, and by README.md. All three read it from
 * here so they cannot drift apart.
 *
 * Carries the port when it is not the default. bin/authorize.mjs
 * reads CLAUDE_BOARD_PORT from the shell that runs it, not from the daemon it is
 * recovering, so on a non-default-port install the command as printed talked to 7391 —
 * which is either nothing at all, or somebody else's service, to which it would then
 * present this daemon's secret.
 *
 * `{ absolute: false }` drops `repoRoot()` and prints the bare `node
 * bin/authorize.mjs` instead. The one caller that wants this is the HTML refusal page
 * (src/server.mjs `sendCredentialRefusal`): it renders to any TAB that lands on the
 * read gate, a cross-origin-shaped navigation included, and the absolute form is
 * `repoRoot()` — on a stock macOS clone, a real `/Users/<name>/...` path — so printing
 * it there names both the reader's home directory and the account it belongs to, to a
 * caller the gate could not verify. The relative form is still actionable: run it from
 * inside the clone, which is the fix this whole route exists to point at. Every other
 * caller keeps the absolute form, because it is read by something that already holds a
 * terminal on this machine — pasting it works from any cwd, which is the point there. */
export function recoveryCommand(port = Number(process.env.CLAUDE_BOARD_PORT) || DEFAULT_PORT, { absolute = true } = {}) {
  const cmd = `node ${absolute ? shellQuote(path.join(repoRoot(), 'bin', 'authorize.mjs')) : 'bin/authorize.mjs'}`;
  return port === DEFAULT_PORT ? cmd : `CLAUDE_BOARD_PORT=${port} ${cmd}`;
}

/** The live handoffs of ONE daemon instance. Created per request handler rather than at
 * module level, so two servers in one process (as the checks spin up) never hand each
 * other's tokens out.
 *
 * `now` and `mintToken` are injected for the checks: a store whose clock and randomness
 * are arguments can be tested for expiry and collision without sleeping or hoping. */
export function createHandoffStore({ ttlMs = null, now = Date.now, mintToken = () => randomBytes(32).toString('hex') } = {}) {
  const live = new Map(); // token -> { target, expiresAt }

  function prune() {
    const t = now();
    for (const [token, entry] of live) {
      if (entry.expiresAt <= t) live.delete(token);
    }
  }

  return {
    /** Mint a handoff for `target` (a path from handoffTarget, never caller text). */
    mint(target) {
      // Bounded by construction: every mint drops everything already expired, and a
      // handoff lives for seconds, so a process that hammers this route cannot grow the
      // map past the number of mints it manages inside one TTL.
      prune();
      const token = mintToken();
      const expiresAt = now() + (ttlMs ?? handoffTtlMs());
      live.set(token, { target, expiresAt });
      return { token, expiresAt };
    },

    /** Redeem `token` exactly once, or return null.
     *
     * The delete happens BEFORE the expiry test and before anything is returned, which
     * is what makes "single use" hold against a replay racing the real browser: node is
     * single-threaded, so between the `get` and the `delete` no other request can run,
     * and the second caller finds nothing whatever the first one goes on to do.
     *
     * Expired, already-used and never-existed are one outcome on purpose. Three
     * distinguishable answers would tell a `ps` poller that it found a real token and
     * merely arrived late, which is exactly the signal worth denying it. */
    consume(token) {
      const entry = live.get(token);
      if (!entry) return null;
      live.delete(token);
      if (entry.expiresAt <= now()) return null;
      return entry;
    },

    /** Live (unconsumed, unexpired) count. For the checks, and for nothing else. */
    size() {
      prune();
      return live.size;
    },
  };
}
