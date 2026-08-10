// Service-level check for the attended report (ADR.md entry 58): a board tab telling
// the daemon whether it is being looked at, and the daemon recording that per board.
// Two layers:
//
//  - `createSseHub` directly, with no HTTP at all, for the OR-across-Watchers rule and
//    the "gone means gone" rule -- nothing over HTTP surfaces those yet (`isAttended`
//    has no production caller at all), so a unit-shaped check against the hub itself
//    is the only seam that can prove them.
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
import { startServer, createSseHub, DEFAULT_ATTENDED_WINDOW_MS } from '../src/server.mjs';

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

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** Run `fn` with a different look-away window, and put the old one back even if it
 * throws (ADR 73). The shipped window is two minutes,
 * which no check may sleep through -- the same reason, and the same idiom, as
 * test/check-stranded.mjs's `withGrace`. Restored in a `finally` so a failing assertion
 * leaves the next check running against the shipped value rather than this one's. */
async function withWindow(ms, fn) {
  const saved = process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS;
  process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS = String(ms);
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS;
    else process.env.CLAUDE_BOARD_ATTENDED_WINDOW_MS = saved;
  }
}

await check('a fresh Watcher defaults to Attended, so a tab that never changes state still counts', () => {
  const hub = createSseHub();
  const watcherId = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.isAttended('b_x'), true);
  assert.ok(/^[0-9a-f]{32}$/.test(watcherId), `watcherId should be a 32-hex-char id, got ${watcherId}`);
});

await check('... but it has not CONFIRMED it is attended, which is a different question', async () => {
  // The two must not collapse into one. `isAttended` answers "nothing here says the
  // reviewer is away", which is what deciding whether to raise a banner needs;
  // `isConfirmedAttended` answers "a Watcher has actually said it is looking", which is
  // what deciding whether the reviewer has COME BACK needs. A tab that has merely
  // subscribed -- i.e. one that has just reconnected -- is the first and not the second.
  await withWindow(40, async () => {
    const hub = createSseHub();
    const watcherId = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'a Watcher that has said nothing has not said it is looking');
    hub.setAttended('b_x', watcherId, true);
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'and once it reports, it has');
    hub.setAttended('b_x', watcherId, false);
    // Not "false at once" any more (ADR 73): the tab has just LOST focus, so it is
    // still inside its look-away window and the board is still Attended by both
    // measures. Past the window it is neither.
    await tick(120);
    assert.equal(hub.isConfirmedAttended('b_x'), false);
    assert.equal(hub.isAttended('b_x'), false, 'a Watcher hidden for longer than the window is not Attended by either measure');
  });
});

// --- Criteria 7 and 8: Attended survives a look-away, and a focused tab has no clock ---

await check('criterion 7: a tab that loses focus keeps its board Attended for the window, and stops past it', async () => {
  // The defect this exists for: read as a live boolean, a board tab sitting behind the
  // terminal -- the ordinary working posture -- counts as nobody watching, so the board
  // strands within seconds of every glance away and a banner arrives roughly once a
  // minute. The window is what makes an open tab mean "the reviewer is around".
  await withWindow(300, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true);
    hub.setAttended('b_x', w, false); // the reviewer switches to the terminal
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'the instant after the blur, the board is still watched');
    await tick(80);
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'and still watched well inside the window');
    await tick(320);
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'past the window the board may strand, exactly as before');
  });
});

await check('criterion 7: the window runs from the BLUR, not from when focus was gained', async () => {
  // A tab focused for a long stretch and then buried has just this instant stopped being
  // looked at. Stamping the window at the moment focus was GAINED would leave it already
  // expired -- and the ordinary reviewer, who sits on a board for minutes before switching
  // to the terminal, would get exactly the behaviour ADR 73 removes.
  await withWindow(200, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true);
    await tick(260); // longer than the whole window, spent focused
    hub.setAttended('b_x', w, false);
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'the window starts now, not when the tab was focused');
  });
});

await check('criterion 8: a tab that stays focused is watched for as long as it stays focused, with no idle detection', async () => {
  // No clock at all on a focused tab. Idle detection was considered and refused: nothing
  // here reads the reviewer's keyboard to decide whether they are present, so a tab left
  // focused counts as watching however long it sits there -- four windows, here.
  await withWindow(30, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true);
    await tick(140);
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'a focused tab never ages out');
    assert.equal(hub.isAttended('b_x'), true);
  });
});

await check('criterion 7: a reconnecting tab carries its own look-away window across, via sinceFocusMs', async () => {
  // A reconnect mints a FRESH Watcher, and the daemon's record of when a tab last had
  // focus lives on the Watcher -- so without this the window is lost exactly where it
  // matters: the reviewer looks at a board, switches to the terminal, `./install.sh`
  // restarts the daemon under them, EventSource reconnects, and the buried tab's first
  // report reads as "never focused". The page says how long ago it last had focus and the
  // fresh Watcher seeds its stamp from that.
  await withWindow(4000, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'a fresh Watcher has said nothing yet');
    hub.setAttended('b_x', w, false, 1, 40); // buried, last focused 40ms ago
    assert.equal(hub.isConfirmedAttended('b_x'), true, 'the window comes across with the report');
    assert.ok(hub.attendedRemainingMs('b_x') > 3000, 'and most of it is left, since the tab was focused a moment ago');
  });
});

await check('sinceFocusMs seeds only an unknown Watcher, and can never extend a running window', async () => {
  // The two things it must not become. A report may not stretch a window the daemon is
  // already tracking -- otherwise a tab could hold its board attended forever by
  // re-reporting `sinceFocusMs: 0` -- and it may not invent one for a tab that never said
  // it had focus, which is the "connected implies recently focused" reading ADR 73 refuses.
  await withWindow(200, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true, 1);   // the daemon observes focus itself
    hub.setAttended('b_x', w, false, 2);  // ... and the blur that starts the window
    await tick(140);
    const left = hub.attendedRemainingMs('b_x');
    assert.ok(left > 0 && left < 100, `the window should be most of the way through, got ${left}`);
    hub.setAttended('b_x', w, false, 3, 0); // "I had focus this instant" -- must not reset it
    const after = hub.attendedRemainingMs('b_x');
    assert.ok(after <= left, `a report must not extend a window the daemon observed, ${left} -> ${after}`);
    await tick(120);
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'so it still ages out on the daemon\'s own clock');
  });

  await withWindow(4000, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, false, 1); // no sinceFocusMs at all: nothing to count from
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'connected is not recently focused');
    assert.equal(hub.attendedRemainingMs('b_x'), 0);
  });
});

await check('a sinceFocusMs older than the window lands as an expired window, not an error', async () => {
  await withWindow(100, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.setAttended('b_x', w, false, 1, 60_000), true, 'applied, like any other report');
    assert.equal(hub.isConfirmedAttended('b_x'), false, 'a tab last looked at a minute ago is not Attended');
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'and the remainder never goes negative');
  });
});

await check('criterion 7: a tab that has never had focus gets no window of its own', async () => {
  // A tab opened in the background and never looked at. It has nothing to count two
  // minutes from, and treating "connected" as "recently focused" would hand any
  // subscriber a mute button on a board it has never been in front of.
  await withWindow(5_000, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, false);
    assert.equal(hub.isConfirmedAttended('b_x'), false);
    assert.equal(hub.isAttended('b_x'), false);
  });
});

await check('the window is two minutes by default, and every unusable value falls back to it', async () => {
  // Same guard, and the same reasoning, as the stranded grace: `Number('')` is 0 and
  // blanking a plist entry is how an operator turns a knob off, so accepting 0 would
  // quietly reinstate "a buried tab is nobody watching" -- the exact defect ADR 73 fixes.
  assert.equal(DEFAULT_ATTENDED_WINDOW_MS, 120_000, 'the two minutes CONTEXT.md\'s "Attended" names');
  for (const bad of ['', '   ', '0', '-1', 'soon', 'NaN', '2m']) {
    await withWindow(bad, async () => {
      const hub = createSseHub();
      const w = hub.subscribe('b_x', fakeRes());
      hub.setAttended('b_x', w, true);
      hub.setAttended('b_x', w, false);
      await tick(30);
      assert.equal(hub.isConfirmedAttended('b_x'), true,
        `CLAUDE_BOARD_ATTENDED_WINDOW_MS=${JSON.stringify(bad)} must fall back to the shipped two minutes, not to no window at all`);
    });
  }
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

await check('a report with no seq at all is applied, so a page predating the ordering still works', async () => {
  await withWindow(40, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.setAttended('b_x', w, true, 5), true);
    assert.equal(hub.setAttended('b_x', w, false), true, 'no seq: applied, degrade rather than refuse');
    // Applied, but the tab has only just lost focus, so it is still inside its look-away
    // window (ADR 73) -- the report having landed is what the window is measured FROM.
    await tick(120);
    assert.equal(hub.isAttended('b_x'), false);
    // ... and it leaves the counter alone, so seq'd reports still order among themselves.
    assert.equal(hub.setAttended('b_x', w, true, 4), false, 'still older than the seq 5 already applied');
  });
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

  await check('the route carries sinceFocusMs through, and refuses a malformed one', async () => {
    // Optional and validated exactly as `seq` is: a page that predates the field sends
    // none and keeps working, and present-but-malformed is a 400 rather than something
    // coerced into a window.
    const { req, data: watcher } = await openSseAndReadFirstFrame(port, boardId, { [SECRET_HEADER]: SECRET });
    try {
      const send = body => rawRequest(port, 'POST', `/api/board/${boardId}/attended`, {
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
        body: JSON.stringify({ watcher: watcher.id, attended: false, ...body }),
      });
      assert.equal((await send({ sinceFocusMs: 500 })).status, 200);
      assert.equal((await send({})).status, 200, 'and one with no sinceFocusMs at all is accepted');
      for (const bad of [-1, 1.5, '500', null]) {
        assert.equal((await send({ sinceFocusMs: bad })).status, 400,
          `sinceFocusMs ${JSON.stringify(bad)} must be refused, not coerced`);
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
