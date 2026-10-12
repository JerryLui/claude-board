// Service-level check for the attended report (ADR.md entry 58): a board tab telling
// the daemon whether it is being looked at, and the daemon recording that per board.
// Two layers:
//
//  - `createSseHub` directly, with no HTTP at all, for the OR-across-Watchers rule, the
//    "gone means gone" rule and the look-away window (ADR 73), read through
//    `attendedRemainingMs` -- the one accessor the stranded rule reads -- since nothing
//    over HTTP surfaces its answer.
//  - a real daemon on an ephemeral port, opening and dropping a board's `/events`
//    stream exactly as test/check-http.mjs's own SSE checks do, to prove AC 16: the
//    report is authenticated exactly like the board's other cookie writes, and an
//    unauthenticated one is refused rather than believed.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer, createSseHub, DEFAULT_ATTENDED_WINDOW_MS } from '../src/server.mjs';
import { check, rawRequest, runMain, secretHome, sessionCookieHeader, sleep, withEnv } from './support.mjs';

// --- Layer 1: createSseHub directly, no daemon involved ---------------------------

function fakeRes() {
  return { write() {} };
}

// Every check that needs the look-away window (ADR 73) shortens it through `withEnv`: the
// shipped window is two minutes, which no check may sleep through.

await check('a fresh Watcher gets a 32-hex id and holds no attended time until it reports', () => {
  const hub = createSseHub();
  const watcherId = hub.subscribe('b_x', fakeRes());
  assert.ok(/^[0-9a-f]{32}$/.test(watcherId), `watcherId should be a 32-hex-char id, got ${watcherId}`);
  // A tab that has merely subscribed -- i.e. one that has just reconnected -- has not said
  // the reviewer is looking, so it can neither end an absence nor hold a banner back.
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'a Watcher that has said nothing is not evidence anyone is looking');
});

// --- Criteria 7 and 8: Attended survives a look-away, and a focused tab has no clock ---

await check('criterion 7: a tab that loses focus keeps its board Attended for the window, and stops past it', async () => {
  // The defect this exists for: read as a live boolean, a board tab sitting behind the
  // terminal -- the ordinary working posture -- counts as nobody watching, so the board
  // strands within seconds of every glance away and a banner arrives roughly once a
  // minute. The window is what makes an open tab mean "the reviewer is around".
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 300 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true);
    hub.setAttended('b_x', w, false); // the reviewer switches to the terminal
    assert.ok(hub.attendedRemainingMs('b_x') > 0, 'the instant after the blur, the board is still watched');
    await sleep(80);
    assert.ok(hub.attendedRemainingMs('b_x') > 0, 'and still watched well inside the window');
    await sleep(320);
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'past the window the board may strand, exactly as before');
  });
});

await check('criterion 7: the window runs from the BLUR, not from when focus was gained', async () => {
  // A tab focused for a long stretch and then buried has just this instant stopped being
  // looked at. Stamping the window at the moment focus was GAINED would leave it already
  // expired -- and the ordinary reviewer, who sits on a board for minutes before switching
  // to the terminal, would get exactly the behaviour ADR 73 removes.
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 200 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true);
    await sleep(260); // longer than the whole window, spent focused
    hub.setAttended('b_x', w, false);
    assert.ok(hub.attendedRemainingMs('b_x') > 0, 'the window starts now, not when the tab was focused');
  });
});

await check('criterion 7: a reconnecting tab carries its own look-away window across, via sinceFocusMs', async () => {
  // A reconnect mints a FRESH Watcher, and the daemon's record of when a tab last had
  // focus lives on the Watcher -- so without this the window is lost exactly where it
  // matters: the reviewer looks at a board, switches to the terminal, `./install.sh`
  // restarts the daemon under them, EventSource reconnects, and the buried tab's first
  // report reads as "never focused". The page says how long ago it last had focus and the
  // fresh Watcher seeds its stamp from that.
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 4000 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'a fresh Watcher has said nothing yet');
    hub.setAttended('b_x', w, false, 1, 40); // buried, last focused 40ms ago
    assert.ok(hub.attendedRemainingMs('b_x') > 0, 'the window comes across with the report');
    assert.ok(hub.attendedRemainingMs('b_x') > 3000, 'and most of it is left, since the tab was focused a moment ago');
  });
});

await check('sinceFocusMs seeds only an unknown Watcher, and can never extend a running window', async () => {
  // The two things it must not become. A report may not stretch a window the daemon is
  // already tracking -- otherwise a tab could hold its board attended forever by
  // re-reporting `sinceFocusMs: 0` -- and it may not invent one for a tab that never said
  // it had focus, which is the "connected implies recently focused" reading ADR 73 refuses.
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 200 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true, 1);   // the daemon observes focus itself
    hub.setAttended('b_x', w, false, 2);  // ... and the blur that starts the window
    await sleep(140);
    const left = hub.attendedRemainingMs('b_x');
    assert.ok(left > 0 && left < 100, `the window should be most of the way through, got ${left}`);
    hub.setAttended('b_x', w, false, 3, 0); // "I had focus this instant" -- must not reset it
    const after = hub.attendedRemainingMs('b_x');
    assert.ok(after <= left, `a report must not extend a window the daemon observed, ${left} -> ${after}`);
    await sleep(120);
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'so it still ages out on the daemon\'s own clock');
  });

  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 4000 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, false, 1); // no sinceFocusMs at all: nothing to count from
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'connected is not recently focused');
  });
});

await check('a sinceFocusMs older than the window lands as an expired window, not an error', async () => {
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 100 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.setAttended('b_x', w, false, 1, 60_000), true, 'applied, like any other report');
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'a tab last looked at a minute ago is not Attended, and the remainder never goes negative');
  });
});

await check('attendedAnywhereRemainingMs: the whole machine\'s answer, in the per-board reader\'s own three shapes', async () => {
  // What the Banner level "On when no board is open" reads (ADR.md entry 58), and the one
  // question no per-board accessor can answer. The MAXIMUM across boards, not the first
  // board that answers: a reading that went quiet as soon as one board answered 0 would
  // banner in cases the level below it stays quiet in, and the ladder would stop being
  // monotone.
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 4000 }, async () => {
    const hub = createSseHub();
    assert.equal(hub.attendedAnywhereRemainingMs(), 0, 'a daemon nobody has connected to is not Attended anywhere');
    const a = hub.subscribe('b_a', fakeRes());
    const b = hub.subscribe('b_b', fakeRes());
    assert.equal(hub.attendedAnywhereRemainingMs(), 0, 'and neither is one whose Watchers have said nothing yet');

    hub.setAttended('b_b', b, false, 1, 40); // one buried tab, on ONE of the two boards
    assert.ok(hub.attendedAnywhereRemainingMs() > 3000,
      `a window running on any board at all is the machine's answer, got ${hub.attendedAnywhereRemainingMs()}`);
    assert.equal(hub.attendedRemainingMs('b_a'), 0,
      'while the OTHER board still answers 0 for itself -- which is exactly the gap between the two middle Banner levels');

    hub.setAttended('b_a', a, true, 1);
    assert.equal(hub.attendedAnywhereRemainingMs(), Infinity, 'a tab focused right now, anywhere, has no clock running on it');
  });

  // And it ages out on the same clock the per-board answer does, or the middle level would
  // be a mute button rather than a delay.
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 60 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    hub.setAttended('b_x', w, true, 1);
    hub.setAttended('b_x', w, false, 2); // the blur that starts the window
    const left = hub.attendedAnywhereRemainingMs();
    assert.ok(left > 0 && left <= 60, `the window is running machine-wide too, got ${left}`);
    await sleep(140);
    assert.equal(hub.attendedAnywhereRemainingMs(), 0, 'and once every window anywhere is spent, nobody is Attended');
  });
});

await check('the window is two minutes by default, and every unusable value falls back to it', async () => {
  // Same guard, and the same reasoning, as the stranded grace: `Number('')` is 0 and
  // blanking a plist entry is how an operator turns a knob off, so accepting 0 would
  // quietly reinstate "a buried tab is nobody watching" -- the exact defect ADR 73 fixes.
  assert.equal(DEFAULT_ATTENDED_WINDOW_MS, 120_000, 'the two minutes CONTEXT.md\'s "Attended" names');
  for (const bad of ['', '   ', '0', '-1', 'soon', 'NaN', '2m']) {
    await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: bad }, async () => {
      const hub = createSseHub();
      const w = hub.subscribe('b_x', fakeRes());
      hub.setAttended('b_x', w, true);
      hub.setAttended('b_x', w, false);
      await sleep(30);
      assert.ok(hub.attendedRemainingMs('b_x') > 0,
        `CLAUDE_BOARD_ATTENDED_WINDOW_MS=${JSON.stringify(bad)} must fall back to the shipped two minutes, not to no window at all`);
    });
  }
});

await check('a board is Attended while any one of its Watchers is focused, whichever one it is', () => {
  const hub = createSseHub();
  const w1 = hub.subscribe('b_x', fakeRes());
  const w2 = hub.subscribe('b_x', fakeRes());
  hub.setAttended('b_x', w1, false);
  hub.setAttended('b_x', w2, false);
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'both hidden, neither ever focused: the board is not Attended');

  hub.setAttended('b_x', w1, true);
  assert.equal(hub.attendedRemainingMs('b_x'), Infinity, 'either one looking is enough (AC 5)');

  hub.setAttended('b_x', w1, false); // w1 is now only inside its look-away window
  hub.setAttended('b_x', w2, true);
  assert.equal(hub.attendedRemainingMs('b_x'), Infinity,
    'the OR does not care which Watcher it is: a reading of w1 alone would answer its window, not Infinity');
});

await check('a Watcher on another board neither attends nor counts toward this one (AC 9)', () => {
  const hub = createSseHub();
  const wOther = hub.subscribe('b_other', fakeRes());
  hub.setAttended('b_other', wOther, true);
  assert.equal(hub.attendedRemainingMs('b_other'), Infinity, 'the premise: the other board is being looked at');
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'a board with no Watchers of its own is not Attended');
  assert.equal(hub.clientCount('b_x'), 0, 'and has no connected client, whatever another board has');
});

await check('a Watcher that goes away stops counting, with no separate timeout', () => {
  const hub = createSseHub();
  const w1 = hub.subscribe('b_x', fakeRes());
  const w2 = hub.subscribe('b_x', fakeRes());
  hub.setAttended('b_x', w1, false);
  hub.setAttended('b_x', w2, true);
  assert.equal(hub.attendedRemainingMs('b_x'), Infinity);

  hub.unsubscribe('b_x', w2); // the one Watcher that was looking closes its tab
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'closing the only attended tab must drop the board to unattended immediately');
  assert.equal(hub.clientCount('b_x'), 1, 'the still-open (hidden) tab must still be counted as a Watcher');

  hub.unsubscribe('b_x', w1);
  assert.equal(hub.clientCount('b_x'), 0);
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'no Watchers left at all is not Attended either');
});

await check('two reports in flight at once are applied in the page\'s order, not the network\'s', () => {
  // A focus and a blur ~100ms apart are two POSTs, and the browser opens a second
  // connection for the later one while the first is still outstanding -- so the network
  // decides which lands first. Applied in arrival order, a blur overtaken by its own
  // earlier focus leaves the Watcher marked attended with the reviewer gone: then
  // `attendedRemainingMs` answers Infinity forever, every evaluate resolves to a return, no
  // grace is ever armed, and no banner fires for the rest of that wait, with no further
  // DOM edge coming to correct it.
  const hub = createSseHub();
  const w = hub.subscribe('b_x', fakeRes());

  assert.equal(hub.setAttended('b_x', w, false, 2), true, 'the blur, seq 2, arrives first');
  assert.equal(hub.attendedRemainingMs('b_x'), 0);
  assert.equal(hub.setAttended('b_x', w, true, 1), false, 'the focus it overtook, seq 1, is dropped');
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'so the reviewer is still correctly gone');

  assert.equal(hub.setAttended('b_x', w, true, 3), true, 'a genuinely newer edge still applies');
  assert.equal(hub.attendedRemainingMs('b_x'), Infinity);
  assert.equal(hub.setAttended('b_x', w, false, 3), false, 'a repeat of the same seq is not newer');
  // Infinity, not merely > 0: an applied blur would leave a running window, still > 0.
  assert.equal(hub.attendedRemainingMs('b_x'), Infinity, 'so the tab is still focused');
});

await check('a report with no seq at all is applied, so a page predating the ordering still works', async () => {
  await withEnv({ CLAUDE_BOARD_ATTENDED_WINDOW_MS: 40 }, async () => {
    const hub = createSseHub();
    const w = hub.subscribe('b_x', fakeRes());
    assert.equal(hub.setAttended('b_x', w, true, 5), true);
    assert.equal(hub.setAttended('b_x', w, false), true, 'no seq: applied, degrade rather than refuse');
    // Applied, but the tab has only just lost focus, so it is still inside its look-away
    // window (ADR 73) -- the report having landed is what the window is measured FROM.
    await sleep(120);
    assert.equal(hub.attendedRemainingMs('b_x'), 0, 'past the window: the unsequenced blur was applied');
    // ... and it leaves the counter alone, so seq'd reports still order among themselves.
    assert.equal(hub.setAttended('b_x', w, true, 4), false, 'still older than the seq 5 already applied');
  });
});

await check('a report naming an unknown watcher, or an unknown board, is a silent no-op', () => {
  const hub = createSseHub();
  assert.equal(hub.setAttended('b_never_subscribed', 'deadbeef', true), false);
  const w1 = hub.subscribe('b_x', fakeRes());
  assert.equal(hub.setAttended('b_x', 'not-the-real-id', true), false, 'a stale id from a since-disconnected tab must not resurrect an entry');
  assert.equal(hub.attendedRemainingMs('b_x'), 0, 'the real Watcher, which has said nothing, must be untouched by the bogus report');
  hub.unsubscribe('b_x', w1);
});

// --- Layer 2: a real daemon, HTTP only ---------------------------------------------

const { home, secret: SECRET } = secretHome('claude-board-attended-', { secret: 'b'.repeat(64) });

/** Open a raw SSE connection and resolve with the first REAL (`event:`-carrying) frame
 * -- everything this check needs to prove is that `watcher` is the first EVENT the
 * stream sends, skipping past the leading `: connected\n\n` comment line, which is not
 * one (`handleEvents`, src/server.mjs, writes that ahead of the `watcher` event on
 * every connection). Mirrors test/support.mjs's `openSseClient`, trimmed to one frame.
 * The caller owns destroying `req` when done. */
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
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: sessionCookieHeader(SECRET) },
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
          cookie: sessionCookieHeader(SECRET),
        },
        body: JSON.stringify({ watcher: watcher.id, attended: false }),
      });
      assert.equal(r.status, 200, 'the cookie must be accepted here exactly as it is on submit (isAuthorizedWrite, src/server.mjs)');
      assert.deepEqual(JSON.parse(r.body), { ok: true });
    } finally {
      req.destroy();
    }
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

runMain('attended', main, {
  cleanup: () => {
    if (server) server.close();
    rmSync(home, { recursive: true, force: true });
  },
});
