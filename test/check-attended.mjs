// Service-level check for the attended report (SPEC_STRANDED.md ticket 02): a board
// tab telling the daemon whether it is being looked at, and the daemon recording that
// per board. Two layers:
//
//  - `createSseHub` directly, with no HTTP at all, for the OR-across-Watchers rule and
//    the "gone means gone" rule -- nothing over HTTP surfaces those yet (nothing
//    consumes `isAttended` until SPEC_STRANDED.md ticket 05), so a unit-shaped check
//    against the hub itself is the only seam that can prove them.
//  - a real daemon on an ephemeral port, opening and dropping a board's `/events`
//    stream exactly as test/check-http.mjs's own SSE checks do, to prove AC 16: the
//    report is authenticated exactly like the board's other cookie writes, and an
//    unauthenticated one is refused rather than believed.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { startServer, createSseHub } from '../src/server.mjs';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error((err && err.stack) || err);
  }
}

// --- Layer 1: createSseHub directly, no daemon involved ---------------------------

function fakeRes() {
  return { write() {} };
}

await check('a fresh Watcher defaults to Attended, so a tab that never changes state still counts', () => {
  const hub = createSseHub();
  const watcherId = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.isAttended('b_x'), true);
  assert.ok(/^[0-9a-f]{32}$/.test(watcherId), `watcherId should be a 32-hex-char id, got ${watcherId}`);
});

await check('... but it has not CONFIRMED it is attended, which is a different question', () => {
  // The two must not collapse into one. `isAttended` answers "nothing here says the
  // reviewer is away", which is what deciding whether to raise a banner needs;
  // `isConfirmedAttended` answers "a Watcher has actually said it is looking", which is
  // what deciding whether the reviewer has COME BACK needs. A tab that has merely
  // subscribed -- i.e. one that has just reconnected -- is the first and not the second.
  const hub = createSseHub();
  const watcherId = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.isConfirmedAttended('b_x'), false, 'a Watcher that has said nothing has not said it is looking');
  hub.setAttended('b_x', watcherId, true);
  assert.equal(hub.isConfirmedAttended('b_x'), true, 'and once it reports, it has');
  hub.setAttended('b_x', watcherId, false);
  assert.equal(hub.isConfirmedAttended('b_x'), false);
  assert.equal(hub.isAttended('b_x'), false, 'a reported-hidden Watcher is not Attended by either measure');
});

await check('isAttended is the OR across every Watcher of one board', () => {
  const hub = createSseHub();
  const w1 = hub.subscribe('b_x', fakeRes());
  const w2 = hub.subscribe('b_x', fakeRes());
  hub.setAttended('b_x', w1, false);
  hub.setAttended('b_x', w2, false);
  assert.equal(hub.isAttended('b_x'), false, 'both hidden: the board is not Attended');

  hub.setAttended('b_x', w1, true);
  assert.equal(hub.isAttended('b_x'), true, 'either one looking is enough (AC 5)');

  hub.setAttended('b_x', w1, false);
  hub.setAttended('b_x', w2, true);
  assert.equal(hub.isAttended('b_x'), true, 'the OR does not care which Watcher it is');
});

await check('a board never crosses into another (AC 9)', () => {
  const hub = createSseHub();
  const wOther = hub.subscribe('b_other', fakeRes());
  hub.setAttended('b_other', wOther, true);
  assert.equal(hub.isAttended('b_x'), false, 'a board with no Watchers of its own is not Attended');
  assert.equal(hub.clientCount('b_x'), 0);
});

await check('a Watcher that goes away stops counting, with no separate timeout', () => {
  const hub = createSseHub();
  const w1 = hub.subscribe('b_x', fakeRes());
  const w2 = hub.subscribe('b_x', fakeRes());
  hub.setAttended('b_x', w1, false);
  hub.setAttended('b_x', w2, true);
  assert.equal(hub.isAttended('b_x'), true);

  hub.unsubscribe('b_x', w2); // the one Watcher that was looking closes its tab
  assert.equal(hub.isAttended('b_x'), false, 'closing the only attended tab must drop the board to unattended immediately');
  assert.equal(hub.clientCount('b_x'), 1, 'the still-open (hidden) tab must still be counted as a Watcher');

  hub.unsubscribe('b_x', w1);
  assert.equal(hub.clientCount('b_x'), 0);
  assert.equal(hub.isAttended('b_x'), false, 'no Watchers left at all is not Attended either');
});

await check('two reports in flight at once are applied in the page\'s order, not the network\'s', () => {
  // A focus and a blur ~100ms apart are two POSTs, and the browser opens a second
  // connection for the later one while the first is still outstanding -- so the network
  // decides which lands first. Applied in arrival order, a blur overtaken by its own
  // earlier focus leaves the Watcher marked attended with the reviewer gone: then
  // `isConfirmedAttended` is true forever, every evaluate resolves to a return, no grace
  // is ever armed, and no banner fires for the rest of that wait, with no further DOM
  // edge coming to correct it.
  const hub = createSseHub();
  const w = hub.subscribe('b_x', fakeRes());

  assert.equal(hub.setAttended('b_x', w, false, 2), true, 'the blur, seq 2, arrives first');
  assert.equal(hub.isConfirmedAttended('b_x'), false);
  assert.equal(hub.setAttended('b_x', w, true, 1), false, 'the focus it overtook, seq 1, is dropped');
  assert.equal(hub.isConfirmedAttended('b_x'), false, 'so the reviewer is still correctly gone');

  assert.equal(hub.setAttended('b_x', w, true, 3), true, 'a genuinely newer edge still applies');
  assert.equal(hub.isConfirmedAttended('b_x'), true);
  assert.equal(hub.setAttended('b_x', w, false, 3), false, 'a repeat of the same seq is not newer');
  assert.equal(hub.isConfirmedAttended('b_x'), true);
});

await check('a report with no seq at all is applied, so a page predating the ordering still works', () => {
  const hub = createSseHub();
  const w = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.setAttended('b_x', w, true, 5), true);
  assert.equal(hub.setAttended('b_x', w, false), true, 'no seq: applied, degrade rather than refuse');
  assert.equal(hub.isAttended('b_x'), false);
  // ... and it leaves the counter alone, so seq'd reports still order among themselves.
  assert.equal(hub.setAttended('b_x', w, true, 4), false, 'still older than the seq 5 already applied');
});

await check('a report naming an unknown watcher, or an unknown board, is a silent no-op', () => {
  const hub = createSseHub();
  assert.equal(hub.setAttended('b_never_subscribed', 'deadbeef', true), false);
  const w1 = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.setAttended('b_x', 'not-the-real-id', true), false, 'a stale id from a since-disconnected tab must not resurrect an entry');
  assert.equal(hub.isAttended('b_x'), true, 'the real Watcher (default-Attended) must be untouched by the bogus report');
  hub.unsubscribe('b_x', w1);
});

// --- Layer 2: a real daemon, HTTP only ---------------------------------------------

const home = mkdtempSync(path.join(tmpdir(), 'claude-board-attended-'));
process.env.CLAUDE_BOARD_HOME = home;

const SECRET_FILE = path.join(home, 'secret');
const SECRET = 'b'.repeat(64);
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

function sessionCookieHeader() {
  return `${SESSION_COOKIE}=${sessionToken(SECRET)}`;
}

/** Raw node:http request -- like test/check-http.mjs's own `rawRequest` -- because the
 * cookie and same-origin checks below need headers `fetch()` refuses to let a caller
 * set (`Cookie`, `Origin`, `Sec-Fetch-Site` are all forbidden headers for `fetch`). */
function rawRequest(port, method, pathName, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body, 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathName,
      headers: { host: `127.0.0.1:${port}`, ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a raw SSE connection and resolve with the first REAL (`event:`-carrying) frame
 * -- everything this check needs to prove is that `watcher` is the first EVENT the
 * stream sends, skipping past the leading `: connected\n\n` comment line, which is not
 * one (`handleEvents`, src/server.mjs, writes that ahead of the `watcher` event on
 * every connection). Mirrors test/check-http.mjs's own `openSseClient`, trimmed to one
 * frame. The caller owns destroying `req` when done, exactly as that helper
 * documents. */
function openSseAndReadFirstFrame(port, boardId, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `/api/board/${boardId}/events`, headers: { host: `127.0.0.1:${port}`, ...headers } },
      res => {
        let buf = '';
        res.setEncoding('utf8');
        function onData(chunk) {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = raw.split('\n');
            const evLine = lines.find(l => l.startsWith('event:'));
            if (!evLine) continue; // a bare ": connected"/heartbeat comment; keep waiting
            const dataLine = lines.find(l => l.startsWith('data:'));
            res.off('data', onData);
            resolve({
              req, res,
              event: evLine.slice('event:'.length).trim(),
              data: dataLine && JSON.parse(dataLine.slice('data:'.length).trim()),
            });
            return;
          }
        }
        res.on('data', onData);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server, port;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));

  const created = JSON.parse((await rawRequest(port, 'POST', '/api/board', {
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
    body: JSON.stringify({ title: 'Attended report', blocks: [{ kind: 'markdown', text: '# hi' }] }),
  })).body);
  const boardId = created.boardId;

  await check('GET /api/board/:id/events sends "watcher" as its first event, ahead of round/submitted', async () => {
    const { req, event, data } = await openSseAndReadFirstFrame(port, boardId, { [SECRET_HEADER]: SECRET });
    try {
      assert.equal(event, 'watcher');
      assert.ok(data && typeof data.id === 'string' && data.id.length > 0, `expected { id } data, got ${JSON.stringify(data)}`);
    } finally {
      req.destroy();
    }
  });

  await check('AC 16: an unauthenticated attended report is refused, not believed', async () => {
    const r = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watcher: 'whatever', attended: false }),
    });
    assert.equal(r.status, 401, 'no secret and no cookie must be refused, exactly like every other write');
    assert.equal(r.body, '', 'a write refusal carries no body, same as submit\'s');
  });

  await check('AC 16: a forged cross-origin report is refused before it ever reaches the credential check', async () => {
    const r = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: sessionCookieHeader() },
      body: JSON.stringify({ watcher: 'whatever', attended: true }),
    });
    assert.equal(r.status, 403, 'a page on another origin holding a stolen cookie must not be able to silence a banner');
  });

  await check('the authorized browser (its session cookie, same-origin) can send an attended report', async () => {
    const { req, data: watcher } = await openSseAndReadFirstFrame(port, boardId, { [SECRET_HEADER]: SECRET });
    try {
      const r = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
          'sec-fetch-site': 'same-origin',
          cookie: sessionCookieHeader(),
        },
        body: JSON.stringify({ watcher: watcher.id, attended: false }),
      });
      assert.equal(r.status, 200, 'the cookie must be accepted here exactly as it is on submit (isAuthorizedWrite, src/server.mjs)');
      assert.deepEqual(JSON.parse(r.body), { ok: true });
    } finally {
      req.destroy();
    }
  });

  await check('the shim\'s own secret also works, same as every other write', async () => {
    const r = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ watcher: 'unknown-but-authorized', attended: true }),
    });
    assert.equal(r.status, 200);
  });

  await check('the route carries the sequence through, and refuses a malformed one', async () => {
    const { req, data: watcher } = await openSseAndReadFirstFrame(port, boardId, { [SECRET_HEADER]: SECRET });
    try {
      const send = (attended, seq) => rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
        body: JSON.stringify(seq === undefined ? { watcher: watcher.id, attended } : { watcher: watcher.id, attended, seq }),
      });
      assert.equal((await send(false, 2)).status, 200);
      assert.equal((await send(true, 1)).status, 200, 'an overtaken report is still answered 200 -- the tab cannot know');
      assert.equal((await send(true)).status, 200, 'and one with no seq at all is accepted');
      for (const bad of [-1, 1.5, '2', null]) {
        assert.equal((await send(true, bad)).status, 400, `seq ${JSON.stringify(bad)} must be refused, not coerced`);
      }
    } finally {
      req.destroy();
    }
  });

  await check('a malformed body is a 400, not a crash', async () => {
    const missingWatcher = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ attended: true }),
    });
    assert.equal(missingWatcher.status, 400);

    const missingAttended = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ watcher: 'w1' }),
    });
    assert.equal(missingAttended.status, 400);
  });

  await check('the wrong content-type is a 415, exactly like every other JSON write', async () => {
    const r = await rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
      headers: { 'content-type': 'text/plain', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ watcher: 'w1', attended: true }),
    });
    assert.equal(r.status, 415);
  });

  await check('an unknown board id is a silent 200, not a 404 -- there is nothing on disk to be missing', async () => {
    const r = await rawRequest(port, 'POST', '/api/board/b_deadbeefdeadbeefdeadbeefdeadbeef/attended', {
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
      body: JSON.stringify({ watcher: 'w1', attended: true }),
    });
    assert.equal(r.status, 200);
  });
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error(err);
  })
  .finally(() => {
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall attended checks ok');
  });
