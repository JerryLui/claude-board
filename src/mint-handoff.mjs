import http from 'node:http';
import { readSecret, secretPath, daemonPort, SECRET_HEADER } from './secret.mjs';
import { HANDOFF_TOKEN_RE } from './handoff.mjs';

const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_BOARD_POST_TIMEOUT_MS) || 10_000;

export function die(...lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

/** The local secret, or the process ends naming the fix. */
export function requireSecret(command) {
  const secret = readSecret();
  if (secret) return secret;
  // Same fix, same wording discipline as bin/mcp.mjs `missingSecretMessage`: name the
  // command that actually helps, and no others. A kickstart fixes nothing here.
  return die(
    `claude-board ${command}: no local secret at ${secretPath()}.`,
    'Authorizing a browser requires it — the daemon derives the browser\'s cookie from it.',
    'Fix: run ./install.sh from the claude-board repository. It generates the secret if there',
    'isn\'t one and never rotates an existing one.'
  );
}

/** POST a JSON body and resolve the parsed response, or reject with a tagged error. */
export function postJson(urlStr, body, secret) {
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

/** Mint one handoff on this machine's daemon, or the process ends naming the fix (`refusedNext`
 * when the daemon answers and refuses). Answers the daemon's response, its token checked and
 * nothing else in it trusted. */
export async function mintHandoff(command, body, refusedNext = null) {
  const secret = requireSecret(command);
  const baseUrl = `http://127.0.0.1:${daemonPort()}`;
  let minted;
  try {
    minted = await postJson(`${baseUrl}/api/handoff`, body, secret);
  } catch (err) {
    if (err.statusCode === 401) {
      die(
        `claude-board ${command}: the daemon rejected this machine's local secret (HTTP 401).`,
        `The daemon is running, so this is a credential mismatch: it was started with a different secret than the one now at ${secretPath()}.`,
        'Fix: restart the service so it re-reads the file — launchctl kickstart -k gui/$(id -u)/claude-board'
      );
    }
    if (typeof err.statusCode === 'number') {
      die(`claude-board ${command}: the daemon refused to mint a handoff (HTTP ${err.statusCode}): ${err.message}`, ...(refusedNext ? [refusedNext] : []));
    }
    die(
      `claude-board ${command}: the daemon is not reachable at ${baseUrl} (${err.code || err.message}).`,
      'Revive it with: launchctl kickstart -k gui/$(id -u)/claude-board',
      'If it was never installed on this machine, run ./install.sh from the claude-board repository first.'
    );
  }
  // During a restart window whatever bound the port first answers here, and the caller hands
  // the result to a browser.
  if (typeof minted?.token !== 'string' || !HANDOFF_TOKEN_RE.test(minted.token)) {
    die(`claude-board ${command}: the daemon returned no usable handoff token. Something other than the daemon may be listening on the port.`);
  }
  return minted;
}
