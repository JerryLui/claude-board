#!/usr/bin/env node
// Remote review: answer another Mac's boards from this one (ADR 118).
//
// Run on the machine you sit at (the "MacBook"). The daemon you want to answer runs on
// another Mac (the "remote Mac"), stays loopback-only there, and is reached through an SSH
// LocalForward in this machine's ~/.ssh/config, so this Mac's port 7392 is the remote Mac's
// 127.0.0.1:7391. Nothing here changes the daemon, its gates or its cookie: this helper
// only mints a handoff on the remote Mac, over SSH, and opens URLs under the forwarded port.
//
//   node bin/remote.mjs login [boardId]    authorize this Mac's browser for the remote Mac's
//                                          board (once a month: the cookie lives 30 days)
//   node bin/remote.mjs open <url|boardId> open one of the remote Mac's boards here
//
// Environment:
//   CLAUDE_BOARD_REMOTE_HOST  required. The remote Mac's SSH host (an alias from ~/.ssh/config
//                             is best, so the connection options live in one place).
//   CLAUDE_BOARD_REMOTE_PORT  the local end of the LocalForward. Default 7392.
//   CLAUDE_BOARD_REMOTE_DIR   the claude-board clone on the remote Mac. Default
//                             ~/Documents/claude-board; a leading ~/ means the remote Mac's home.
//   CLAUDE_BOARD_REMOTE_SSH   the ssh program. Default ssh.
//   CLAUDE_BOARD_OPEN_CMD     the opener. Default open (the default browser).
//
// Why `localhost` and never `127.0.0.1`: cookies are not port-scoped (RFC 6265 8.5, see
// src/secret.mjs). The remote Mac's cookie set on 127.0.0.1:7392 would land in the same jar
// entry as this Mac's own board cookie on 127.0.0.1:7391, under the same name, and each
// login would log the other board out. `localhost` is a different host to the cookie jar,
// the daemon's hostname gate already admits it, and Safari resolves it with no hosts-file
// edit. The daemon sets the cookie host-only (no Domain attribute), so it stays there.
//
// Why `zsh -lic` on the remote Mac: a command run over SSH gets a non-interactive shell, which
// reads neither ~/.zshrc nor, for a plain `zsh -c`, ~/.zprofile. nvm installs `node` as a
// shell function in ~/.zshrc, so only an interactive login shell finds it. Whatever that
// shell prints on the way in (a prompt theme, a banner) is tolerated: the handoff URL is
// picked out of stdout by its exact shape, and stderr is shown only on failure.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HANDOFF_TOKEN_RE, SAFE_BOARD_ID, shellQuote } from '../src/handoff.mjs';

export const DEFAULT_REMOTE_PORT = 7392;
export const DEFAULT_REMOTE_DIR = '~/Documents/claude-board';
const HEALTH_TIMEOUT_MS = 5_000;

const USAGE = [
  'Usage: node bin/remote.mjs login [boardId]',
  '       node bin/remote.mjs open <url|boardId>',
].join('\n');

/** A board id as the daemon mints them. SAFE_BOARD_ID alone admits a leading dash,
 * which bin/authorize.mjs on the remote Mac would read as a flag, so that is refused too. */
export function isBoardId(s) {
  return typeof s === 'string' && SAFE_BOARD_ID.test(s) && !s.startsWith('-');
}

/** The URL to open on this Mac for `input`, or null when it is neither a board id nor a
 * URL on the remote Mac's loopback. Only an `http://127.0.0.1:<port>` or
 * `http://localhost:<port>` prefix is rewritten, whatever the port (it is the remote Mac's own,
 * which this Mac does not need to know); everything after it is kept. Anything else is
 * refused rather than opened, since the result goes straight to a GUI launcher. */
export function localUrl(input, localPort) {
  if (typeof input !== 'string') return null;
  if (isBoardId(input)) return `http://localhost:${localPort}/b/${input}`;
  // The path keeps printable ASCII only: no space, no control character.
  const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/[\x21-\x7e]*)?$/i.exec(input);
  if (!m) return null;
  return `http://localhost:${localPort}${m[2] ?? '/'}`;
}

/** `cd` into the remote clone. A leading `~/` becomes `"$HOME"/` so the remote Mac's shell
 * expands it; the rest is quoted, so a path with a space or a quote survives both shells
 * it passes through. */
function remoteCd(dir) {
  if (dir === '~') return 'cd "$HOME"';
  if (dir.startsWith('~/')) return `cd "$HOME"/${shellQuote(dir.slice(2))}`;
  return `cd ${shellQuote(dir)}`;
}

/** The one command string ssh hands the remote Mac's login shell. Two shells read it: the
 * remote Mac's account shell (whatever it is) runs `zsh -lic <inner>`, and that zsh runs the
 * inner line, so the inner line is quoted once as a whole. `boardId` is checked by the
 * caller before this is built; it is appended bare only because SAFE_BOARD_ID admits no
 * shell metacharacter. */
export function remoteCommand(dir, boardId) {
  const inner = `${remoteCd(dir)} && node bin/authorize.mjs --print${boardId ? ` ${boardId}` : ''}`;
  return `zsh -lic ${shellQuote(inner)}`;
}

/** The handoff URL in the remote Mac's output: the last stdout line shaped exactly like what
 * `bin/authorize.mjs --print` prints, or null. */
export function pickHandoffUrl(stdout) {
  const re = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/auth\/([0-9a-f]+)$/;
  const lines = String(stdout).split(/\r?\n/).map(l => l.trim()).reverse();
  for (const line of lines) {
    const m = re.exec(line);
    if (m && HANDOFF_TOKEN_RE.test(m[1])) return line;
  }
  return null;
}

function die(...lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

function localPortFromEnv() {
  const raw = process.env.CLAUDE_BOARD_REMOTE_PORT;
  if (raw === undefined || raw === '') return DEFAULT_REMOTE_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    die(`claude-board remote: CLAUDE_BOARD_REMOTE_PORT=${JSON.stringify(raw)} is not a port.`);
  }
  return n;
}

/** Is the tunnel up? Asks the forwarded port for the daemon's health, the one route that
 * needs no credential, with `Host: localhost:<port>` as the browser will send it. Checked
 * before anything else so a closed SSH session reads as that, not as a spent handoff. */
function tunnelUp(localPort) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: localPort,
      path: '/api/health',
      method: 'GET',
      headers: { host: `localhost:${localPort}` },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString('utf8')).ok === true); } catch { resolve(false); }
      });
    });
    req.setTimeout(HEALTH_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function requireTunnel(localPort) {
  if (await tunnelUp(localPort)) return;
  die(
    `claude-board remote: no board answers at http://localhost:${localPort}.`,
    'The tunnel is down: open the SSH session to the remote Mac whose host entry carries',
    `  LocalForward ${localPort} 127.0.0.1:<remote daemon port>`,
    '(the remote daemon port is 7391 unless the remote Mac sets CLAUDE_BOARD_PORT)',
    'and keep it open while you review. If the tunnel is up, the remote Mac\'s daemon is not running',
    '(after a reboot someone has to log in at the remote Mac before it starts).'
  );
}

/** Hand `url` to the opener, detached, the same way bin/authorize.mjs does. A failure is
 * reported with the URL, so it can still be opened by hand. */
function openUrl(url) {
  const opener = process.env.CLAUDE_BOARD_OPEN_CMD || 'open';
  const fail = err => die(`claude-board remote: could not run ${opener} (${err.message}). Open this yourself:\n${url}`);
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', fail);
    child.unref();
  } catch (err) {
    fail(err);
  }
}

/** Run the handoff mint on the remote Mac. Resolves `{ code, stdout, stderr }`; never a sync
 * spawn, so the check can serve the daemon from its own event loop. stdin is closed:
 * a password or passphrase prompt goes to the terminal through ssh's own /dev/tty. */
function runRemote(host, command) {
  const ssh = process.env.CLAUDE_BOARD_REMOTE_SSH || 'ssh';
  // -T: no terminal on the remote Mac. ClearAllForwardings: the host entry's LocalForward is
  // already held by the SSH session carrying the tunnel; binding it again here would
  // only print a warning.
  const args = ['-T', '-o', 'ClearAllForwardings=yes', host, command];
  return new Promise(resolve => {
    const child = spawn(ssh, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', e => resolve({ code: 127, stdout: '', stderr: `could not run ${ssh}: ${e.message}` }));
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

async function login(boardId) {
  if (boardId !== null && !isBoardId(boardId)) {
    die(`claude-board remote: ${JSON.stringify(boardId)} is not a board id.`, USAGE);
  }
  const host = process.env.CLAUDE_BOARD_REMOTE_HOST;
  if (!host) {
    die(
      'claude-board remote: CLAUDE_BOARD_REMOTE_HOST is not set.',
      'Set it to the remote Mac\'s SSH host, the alias under which ~/.ssh/config carries the LocalForward.'
    );
  }
  if (host.startsWith('-') || /\s/.test(host)) {
    die(`claude-board remote: CLAUDE_BOARD_REMOTE_HOST=${JSON.stringify(host)} is not a host name.`);
  }
  const localPort = localPortFromEnv();
  const dir = process.env.CLAUDE_BOARD_REMOTE_DIR || DEFAULT_REMOTE_DIR;
  await requireTunnel(localPort);

  const r = await runRemote(host, remoteCommand(dir, boardId));
  const printed = pickHandoffUrl(r.stdout);
  if (r.code !== 0 || !printed) {
    die(
      `claude-board remote: the remote Mac did not mint a handoff (ssh ${host} exited ${r.code}).`,
      ...(r.stderr.trim() ? [r.stderr.trim().split('\n').slice(-8).join('\n')] : []),
      `It ran bin/authorize.mjs --print from ${dir} on ${host} (set CLAUDE_BOARD_REMOTE_DIR if the clone is elsewhere).`
    );
  }
  // The token lives about 30 seconds from the moment the remote Mac minted it, so it is opened
  // at once. The redirect it answers with is relative, so it lands on localhost too.
  openUrl(localUrl(printed, localPort));
  console.error(`claude-board: opening the remote Mac's board at http://localhost:${localPort}/. The cookie lasts 30 days; run login again when a tab says it is not authorized.`);
}

async function open(target) {
  if (!target) die(USAGE);
  const localPort = localPortFromEnv();
  const url = localUrl(target, localPort);
  if (!url) {
    die(
      `claude-board remote: ${JSON.stringify(target)} is neither a board id nor a board URL.`,
      'Give the URL the agent printed (http://127.0.0.1:7391/b/<id>) or the bare id.'
    );
  }
  await requireTunnel(localPort);
  openUrl(url);
}

async function main() {
  const [cmd, arg = null, ...rest] = process.argv.slice(2);
  if (rest.length) die(USAGE);
  if (cmd === 'login') return login(arg);
  if (cmd === 'open') return open(arg);
  die(USAGE);
}

// Importable (test/check-remote.mjs reads the pure pieces) without running a command.
// Compared through realpath so a symlinked checkout still runs.
function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (process.argv[1] && isMain()) {
  await main();
}
