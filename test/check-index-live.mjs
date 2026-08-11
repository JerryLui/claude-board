// The index stops lying (ADR 77): the daemon owes a
// rows endpoint, and the index's own fifteen-second tick fetches it and patches the list
// in place rather than reloading. And it stops WAITING: the page holds the daemon-wide
// stream open (`GET /api/events`) and every push on it wakes one of those same fetches,
// so a change the daemon already knows about lands in a round trip instead of up to
// fifteen seconds later. The tick is untouched and still checked here -- it is the
// fallback when the stream is down, and the only thing that re-labels a relative time on
// a row nothing has changed.
//
// One layer, deliberately: a real daemon on an ephemeral port, with the REAL
// renderIndexPage output parsed by test/dom-stand-in.mjs and the REAL indexScript run
// against it, its relative fetches rewritten onto that daemon and carrying the session
// cookie a browser tab already holds. That is the same harness
// test/check-pomodoro-page.mjs uses for the widget, and it is the only seam that can
// prove the two halves meet: a rows endpoint nobody fetches, or a client patch fed a
// hand-written payload, would each pass a narrower check and still leave the index stale.
//
// The tick is FIRED BY HAND rather than waited for -- indexScript takes `setInterval` as
// an injected parameter for exactly this, so "within one poll interval" is checked in
// milliseconds instead of fifteen real seconds. The stream is driven the same way, and
// for the same reason: `EventSource` is injected too, so a push is delivered by hand
// rather than raced for. The events driven in are the REAL ones -- the push checks below
// hold a second, raw `GET /api/events` connection open beside the page (the shape
// test/check-menubar-client.mjs's stream probe already proves) and feed the page exactly
// what the daemon sent it, so a page listening for an event name the daemon never
// broadcasts cannot pass.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS FILE. It posts awaited rounds into a real
// daemon and never opens a board, which is precisely the shape the stranded rule
// announces -- so `osascript` is a stub on PATH from the first lines below AND the
// stranded grace is pushed a day out of reach, the same belt-and-braces every other
// daemon-booting check in this suite uses.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SECRET_HEADER, SESSION_COOKIE, sessionToken } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { renderIndexPage, indexScript } from '../src/indexpage.mjs';
import { parseHTML, StandInEvent, StandInEventSource } from './dom-stand-in.mjs';

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

const workDir = mkdtempSync(path.join(tmpdir(), 'claude-board-index-live-'));
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
process.env.CLAUDE_BOARD_HOME = home;

const SECRET = 'd'.repeat(64);
const SECRET_FILE = path.join(workDir, 'secret');
writeFileSync(SECRET_FILE, `${SECRET}\n`, { mode: 0o600 });
process.env.CLAUDE_BOARD_SECRET_FILE = SECRET_FILE;

// The banner rule must never reach the reviewer's screen from this file. Both guards, not
// either: the grace makes it never fire, the PATH stub makes it harmless if it somehow did.
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(24 * 60 * 60 * 1000);
const stubDir = path.join(workDir, 'bin');
mkdirSync(stubDir, { recursive: true });
const stub = path.join(stubDir, 'osascript');
writeFileSync(stub, '#!/bin/sh\nexit 0\n');
chmodSync(stub, 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH}`;

const sessionCookieHeader = () => `${SESSION_COOKIE}=${sessionToken(SECRET)}`;
const REAL_FETCH = globalThis.fetch;

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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const QUESTION = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }] });

async function postBoard(port, body) {
  const r = await rawRequest(port, 'POST', '/api/board', {
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200, `post failed: ${r.body}`);
  return JSON.parse(r.body);
}

function projectFor(name) {
  const dir = path.join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Load the REAL index page and run the REAL indexScript against it, exactly as
 * test/check-pomodoro-page.mjs does -- see that file's comment on why the cookie is
 * attached by hand (node's fetch has no jar, and `credentials: 'same-origin'` does
 * nothing outside a browser). `intervals` captures every registration so the
 * fifteen-second tick can be fired by hand.
 *
 * `eventSource: false` loads the page in a scope with no EventSource in it at all --
 * an older browser, and the same shape test/check-pure.mjs's narrow function-extraction
 * stand-ins run this script under. The page must still work; that is criterion 5. */
function openIndexTab(port, { threads = [], query = '', eventSource = true } = {}) {
  const document = parseHTML(renderIndexPage({ threads, query }));
  const intervals = [];
  // Captured the way test/check-anchor-push.mjs captures the board page's own
  // EventSource: a subclass whose constructor keeps the instance, so a check can
  // dispatch into the very listeners the real script registered rather than calling
  // patchRows/fetchPomodoro directly -- which would prove nothing about whether the
  // subscription is wired at all. StandInEventSource (test/dom-stand-in.mjs) already
  // models exactly as much of one as this needs: a url, addEventListener, and a
  // dispatch that hands the listener a real string `ev.data`.
  let stream = null;
  class CapturingEventSource extends StandInEventSource {
    constructor(url) { super(url); stream = this; }
  }
  globalThis.fetch = (url, opts) => {
    const target = `http://127.0.0.1:${port}${url}`;
    const headers = { ...(opts && opts.headers), cookie: sessionCookieHeader() };
    return REAL_FETCH(target, { ...opts, headers });
  };
  // 'window'/'location' ride along for the same reason test/check-pomodoro-page.mjs
  // passes them: indexScript registers a 'hashchange' listener for the settings
  // panel the menu bar item opens, and a stand-in one parameter short of the real
  // page throws on load rather than failing the thing under test. The window is the
  // parsed document's own defaultView; location is a plain { hash }, empty because
  // no check here is about the fragment. 'EventSource' is the fifth and newest: the
  // page reads it through `typeof`, so passing nothing is a faithful browser without
  // one rather than a broken harness.
  new Function('document', 'setInterval', 'window', 'location', 'EventSource', indexScript)(document, (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  }, document.defaultView, { hash: '' }, eventSource ? CapturingEventSource : undefined);
  const poll = intervals.find(i => i.ms === 15000);
  assert.ok(poll, 'setup failure: the index must register a fifteen-second tick');
  return {
    document,
    /** The subscription the page opened, or null if it opened none. */
    stream,
    /** One poll interval, as the page really runs it. */
    async tick() {
      poll.fn();
      await flush();
    },
    /** One push, delivered into the page's own listener exactly as the daemon wrote
     * it on the wire -- `data` is JSON.stringify'd here because a real EventSource
     * hands a listener the raw text of the `data:` line, never a parsed object.
     * Asserts the subscription exists first: with the push path gone there is no
     * stream and no listener, and this says so instead of silently doing nothing. */
    async push(name, data) {
      assert.ok(stream, `the index page must hold the daemon-wide stream open to hear '${name}': nothing constructed an EventSource`);
      const listeners = stream.listeners.get(name) || [];
      assert.ok(listeners.length, `the index page must listen for '${name}' on the daemon-wide stream`);
      stream.dispatch(name, JSON.stringify(data));
      await flush();
    },
    restoreFetch() { globalThis.fetch = REAL_FETCH; },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 60));

/** A second subscriber on `GET /api/events`, held open beside the page the way
 * bin/menubar.m holds it -- raw HTTP, no page, no client script (the shape
 * test/check-menubar-client.mjs's stream probe already proves out). Two jobs here:
 * it is what proves the daemon really broadcasts the event the page is listening
 * for (its payload is fed straight into the page, never hand-written), and it is
 * the menu bar's stand-in for the other direction of criterion 3 -- an action taken
 * on the index page has to reach it.
 *
 * Frames are split on the blank line SSE separates them with, so the `: connected`
 * and `: heartbeat` comment frames the daemon also writes are simply not events. */
function openWireStream(port) {
  const events = [];
  let raw = '';
  let pending = '';
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'GET',
    path: '/api/events',
    headers: { host: `127.0.0.1:${port}`, [SECRET_HEADER]: SECRET },
  }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      raw += chunk;
      pending += chunk;
      const frames = pending.split('\n\n');
      pending = frames.pop();
      for (const frame of frames) {
        const name = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.*)$/m.exec(frame);
        if (name && data) events.push({ name: name[1], data: JSON.parse(data[1]) });
      }
    });
  });
  // A stream this check destroys on its way out reports the destruction as an error;
  // there is nothing to do about it and nothing to say.
  req.on('error', () => {});
  req.end();

  const until = async (what, ready, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = ready();
      if (hit) return hit;
      if (Date.now() >= deadline) throw new Error(`${what} never arrived within ${ms}ms -- the stream carried: ${JSON.stringify(raw)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  return {
    /** Resolve once the daemon has actually accepted the subscription. Anything
     * triggered before this could be broadcast to nobody and lost -- the stream
     * holds no history, which is the whole reason the page re-fetches on connect. */
    connected: () => until("the stream's own ': connected' line", () => raw.includes(': connected') || null),
    /** The next event of that name, removed from the queue so a second call waits
     * for a genuinely new one rather than re-reading the last. */
    next: name => until(`a '${name}' event`, () => {
      const i = events.findIndex(e => e.name === name);
      return i === -1 ? null : events.splice(i, 1)[0];
    }),
    close() { req.destroy(); },
  };
}

const rows = doc => doc.querySelectorAll('a.thread-item');
const rowFor = (doc, threadId) => rows(doc).find(r => r.getAttribute('data-thread-id') === threadId) || null;

async function main() {
  // `let`, not `const`: one check below genuinely restarts this daemon -- same home,
  // same port, and a brand-new stream hub that has never heard of the page still
  // sitting open against it -- and rebinds `server` to the replacement so the finally
  // at the foot of this function closes the daemon that is actually running.
  let { server, port } = await startServer({ home, port: 0 });

  try {
    // ---------------------------------------------------------------------------------
    // The endpoint itself.
    // ---------------------------------------------------------------------------------

    await check('GET /api/index/rows answers the rows and nothing else -- no page, no styles, no board bodies', async () => {
      const posted = await postBoard(port, { title: 'First session', blocks: [QUESTION('Ship?')], cwd: projectFor('alpha') });
      const r = await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } });
      assert.equal(r.status, 200);
      const { html } = JSON.parse(r.body);
      assert.match(html, /class="thread-item/, 'the rows themselves');
      assert.ok(html.includes(posted.boardId), 'naming the board each row opens');
      assert.ok(!html.includes('<!doctype'), 'and not the page around them');
      assert.ok(!html.includes('<style'), 'nor the stylesheet a reload would ship again');
      assert.ok(!html.includes('Ship?'), 'nor any board content: this is the index, not a search');
    });

    await check('the rows endpoint honours the same ?q= filter the page was rendered with', async () => {
      await postBoard(port, { title: 'A different session', blocks: [QUESTION('And this?')], cwd: projectFor('beta') });
      const all = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.equal((all.html.match(/class="thread-item/g) || []).length, 2, 'both sessions, unfiltered');

      const filtered = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows?q=beta', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.equal((filtered.html.match(/class="thread-item/g) || []).length, 1, 'the filter really filters');
      assert.ok(filtered.html.includes('A different session'));

      const none = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows?q=nothing-matches-this', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.match(none.html, /No sessions match/, 'and an empty filter says so, rather than reading as an empty store');
    });

    await check('the rows endpoint is behind the read credential, like the index it feeds', async () => {
      const r = await rawRequest(port, 'GET', '/api/index/rows');
      assert.notEqual(r.status, 200, 'a caller with no credential must not read the session list');
    });

    await check('an unchanged store answers the poll without parsing a single board document', async () => {
      // What makes this route cheap enough to answer every fifteen seconds for every open
      // index (ADR 77). `listBoards` is a synchronous read and parse of every board
      // document -- and a page board's document can be megabytes -- on the same event loop
      // as every blocked /wait and every SSE heartbeat. `GET /` paid that once per
      // navigation; a poll would pay it forever.
      //
      // Proved by taking the documents away underneath the daemon rather than by timing
      // anything: with the files unreadable, a route that still parsed them could not
      // possibly return the same rows. The fingerprint (readdir + stat, no open) is
      // unaffected by the mode change, so a route that short-circuits on it answers
      // exactly as before.
      const before = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.match(before.html, /class="thread-item/, 'setup failure: there must be rows to serve');

      const boardsDir = path.join(home, 'boards');
      const files = readdirSync(boardsDir).filter(f => f.endsWith('.json'));
      const modes = files.map(f => [f, statSync(path.join(boardsDir, f)).mode]);
      try {
        for (const [f] of modes) chmodSync(path.join(boardsDir, f), 0o000);
        const after = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
        assert.equal(after.html, before.html,
          'an unchanged store must be answered from the fingerprint, without opening a board document');
      } finally {
        for (const [f, mode] of modes) chmodSync(path.join(boardsDir, f), mode);
      }
    });

    await check('a store that HAS changed is re-read, however cheap the unchanged case is', async () => {
      // The other direction, and the one that matters more: a fingerprint that ever says
      // "nothing changed" when something did is an index that lies, which is the whole
      // defect this ticket exists to fix. Both edges a board can move on -- a new file,
      // and an existing file rewritten -- are checked, since they fingerprint differently
      // (the directory listing versus one entry's size and mtime).
      const before = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);

      const posted = await postBoard(port, { title: 'Freshly posted', blocks: [QUESTION('New?')], cwd: projectFor('eta') });
      const added = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.notEqual(added.html, before.html, 'a new board must be picked up');
      assert.ok(added.html.includes('Freshly posted'));

      await new Promise(r => setTimeout(r, 1100)); // mtime has second resolution on some stores
      await postBoard(port, { boardId: posted.boardId, blocks: [QUESTION('Amended?')] });
      const amended = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.notEqual(amended.html, added.html, 'a board rewritten in place must be picked up too');
    });

    await check('criterion 9: a round whose wait LAPSES settles its row, with nothing else writing to the store', async () => {
      // The gap a directory fingerprint cannot see, and the one status change that happens
      // with no write behind it. `readBoard` sweeps a lapsed awaited round in MEMORY --
      // "a sweep on read rather than a write on read" -- so when the wait dies the row's
      // live dot and rounds-left badge change while the file stays byte-identical: same
      // size, same mtime, same listing.
      //
      // Reachable whenever a round lapses with no agent parked in /wait, which is the
      // ordinary abandoned session: the reviewer closed the terminal, or the MCP call was
      // interrupted. `handleWait`'s own timeout branch writes, so the still-waiting case
      // heals itself; this one does not, and an index left open overnight on a quiet store
      // would go on showing a live dot for a wait that died hours ago.
      //
      // The other status checks in this file move a row by SUBMITTING, which writes, so
      // none of them can see this.
      const posted = await postBoard(port, { title: 'About to lapse', blocks: [QUESTION('Quickly?')], cwd: projectFor('theta') });
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        const live = rowFor(tab.document, posted.thread);
        assert.ok(live, 'setup failure: no row for the board under test');
        assert.equal(live.getAttribute('data-live'), 'true');
        assert.equal(live.getAttribute('data-rounds-left'), '1');

        // Bring its deadline in close. This IS a write, so the fingerprint moves -- the
        // point is what happens AFTER it, with nothing touching the store at all.
        const file = readdirSync(path.join(home, 'boards')).find(f => f.startsWith(posted.boardId));
        const stored = JSON.parse(readFileSync(path.join(home, 'boards', file), 'utf8'));
        stored.rounds[0].awaitDeadline = new Date(Date.now() + 250).toISOString();
        writeFileSync(path.join(home, 'boards', file), JSON.stringify(stored));

        await tab.tick(); // still live, and this is the poll that caches it
        assert.equal(rowFor(tab.document, posted.thread).getAttribute('data-live'), 'true',
          'setup failure: the wait must still be alive at this point');
        const printBefore = statSync(path.join(home, 'boards', file)).mtimeMs;

        await new Promise(r => setTimeout(r, 400)); // the wait dies, and NOTHING writes
        assert.equal(statSync(path.join(home, 'boards', file)).mtimeMs, printBefore,
          'setup sanity: the board file really is untouched, so only a lapse can have changed the row');

        await tab.tick();
        const settled = rowFor(tab.document, posted.thread);
        assert.equal(settled.getAttribute('data-live'), 'false', 'criterion 9: the row settles within one tick');
        assert.equal(settled.getAttribute('data-rounds-left'), '0', 'and the reviewer is no longer told they owe a trip');
        assert.equal(settled.querySelector('.rounds-left-badge'), null);
      } finally {
        tab.restoreFetch();
      }
    });

    await check('two indexes polling under different filters do not serve each other\'s rows', async () => {
      // The cache is one entry, keyed by fingerprint AND query. A cache keyed on the
      // fingerprint alone would hand a filtered index the unfiltered list the moment
      // another tab polled, silently undoing a filter the reader is looking at.
      const all = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      const filtered = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows?q=eta', { headers: { [SECRET_HEADER]: SECRET } })).body);
      const allAgain = JSON.parse((await rawRequest(port, 'GET', '/api/index/rows', { headers: { [SECRET_HEADER]: SECRET } })).body);
      assert.notEqual(filtered.html, all.html, 'the filtered poll must not be answered from the unfiltered cache');
      assert.equal(allAgain.html, all.html, 'and the unfiltered one must not be answered from the filtered cache');
    });

    // ---------------------------------------------------------------------------------
    // Criterion 9: the index reflects the store within one poll interval, with no reload.
    // ---------------------------------------------------------------------------------

    await check('criterion 9: a board posted after the page loaded appears within one tick, with no reload', async () => {
      const tab = openIndexTab(port, { threads: [] });
      try {
        assert.equal(rows(tab.document).length, 0, 'the page was rendered against an empty list on purpose');
        await tab.tick();
        assert.ok(rows(tab.document).length >= 2, 'the sessions already in the store arrive on the first tick');

        const posted = await postBoard(port, { title: 'Posted after load', blocks: [QUESTION('Now?')], cwd: projectFor('gamma') });
        await tab.tick();
        const row = rowFor(tab.document, posted.thread);
        assert.ok(row, 'the new session has a row of its own');
        assert.ok(row.getAttribute('href').includes(posted.boardId), 'linking the board it is about');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 9: a board\'s status, round count and last-activity all move within one tick', async () => {
      // Round 1 is an awaited PAGE round (an html block plus `wait`, ADR.md entry 45)
      // rather than a question, because a post into a still-open question round AMENDS it
      // (src/server.mjs handlePostBoard) instead of minting round 2 -- and a round count
      // that cannot move proves nothing.
      const posted = await postBoard(port, {
        title: 'Moving session',
        blocks: [{ kind: 'html', html: '<p>an artifact to comment on</p>' }],
        cwd: projectFor('delta'),
        wait: true,
      });
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        const before = rowFor(tab.document, posted.thread);
        assert.ok(before, 'setup failure: no row for the session under test');
        assert.equal(before.getAttribute('data-live'), 'true', 'a board with an awaited round is live');
        assert.equal(before.getAttribute('data-rounds-left'), '1');
        const beforeMeta = before.querySelector('.thread-meta').textContent;
        const beforeStamp = before.querySelector('time.rel-time').getAttribute('datetime');
        assert.match(beforeMeta, /1 round ·/, 'one round so far');

        // A second round on the same board: the count moves, the activity stamp moves.
        await new Promise(r => setTimeout(r, 1100)); // updatedAt has second resolution
        await postBoard(port, { boardId: posted.boardId, blocks: [QUESTION('And now?')] });
        await tab.tick();
        const moved = rowFor(tab.document, posted.thread);
        assert.match(moved.querySelector('.thread-meta').textContent, /2 rounds ·/, 'the round count moved');
        assert.equal(moved.getAttribute('data-rounds-left'), '2', 'and so did the trips the reviewer owes');
        assert.notEqual(moved.querySelector('time.rel-time').getAttribute('datetime'), beforeStamp,
          'and the last-activity stamp moved with it');

        // Answering everything settles the row: the status pill and the live dot go.
        for (const round of [1, 2]) {
          const r = await rawRequest(port, 'POST', `/api/board/${posted.boardId}/submit`, {
            headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
            body: JSON.stringify({ round, action: 'send', answers: [], comments: [] }),
          });
          assert.equal(r.status, 200, `submit failed: ${r.body}`);
        }
        await tab.tick();
        const settled = rowFor(tab.document, posted.thread);
        assert.equal(settled.getAttribute('data-live'), 'false', 'the status changed without a reload');
        assert.equal(settled.getAttribute('data-rounds-left'), '0');
        assert.equal(settled.querySelector('.rounds-left-badge'), null, 'and the badge is gone, not reading zero');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 9: a board that disappears from the store loses its row within one tick', async () => {
      const posted = await postBoard(port, { title: 'Doomed session', blocks: [QUESTION('Briefly?')], cwd: projectFor('epsilon') });
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        assert.ok(rowFor(tab.document, posted.thread), 'setup failure: it has to be there before it can go');

        // Removed the way the archive would remove it: the document leaves the store.
        const file = readdirSync(path.join(home, 'boards')).find(f => f.startsWith(posted.boardId));
        assert.ok(file, 'setup failure: no stored board document to remove');
        unlinkSync(path.join(home, 'boards', file));

        await tab.tick();
        assert.equal(rowFor(tab.document, posted.thread), null, 'the row goes with the board');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('a daemon slower than the tick gets ONE outstanding poll, not one per tick', async () => {
      // Without a guard, a daemon answering slower than fifteen seconds accumulates an
      // outstanding request per tick, and the answers can land out of order: a slow tick-1
      // response arriving after a fast tick-2 response differs from what was last patched
      // in, so it patches the OLDER rows in over the newer ones. It self-corrects on the
      // next tick, which is why this is a stale list rather than a leak -- but a stale
      // list shown for no reason is exactly what this ticket is about.
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick(); // one real poll first, so the list is populated and normal
        let outstanding = 0;
        globalThis.fetch = () => {
          outstanding++;
          return new Promise(() => {}); // a daemon that never answers
        };
        await tab.tick();
        await tab.tick();
        await tab.tick();
        assert.equal(outstanding, 1, 'three ticks against a hanging daemon must leave exactly one request in flight');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('a failed poll does not stop the list updating for the life of the tab', async () => {
      // The other half of the guard, and the way it could go badly wrong: a flag cleared
      // only on the success path would be left set by the first network hiccup, and the
      // index would never update again -- silently, and for as long as the tab stayed
      // open. Worse than the pile-up it guards against.
      const tab = openIndexTab(port, { threads: [] });
      try {
        const realFetch = globalThis.fetch;
        globalThis.fetch = () => Promise.reject(new Error('daemon mid-restart'));
        await tab.tick();
        assert.equal(rows(tab.document).length, 0, 'a failed poll leaves the list exactly as it was');

        globalThis.fetch = realFetch;
        await tab.tick();
        assert.ok(rows(tab.document).length > 0, 'and the very next tick recovers');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('an unchanged store leaves the list completely alone', async () => {
      // The other half of "patch in place": most ticks change nothing, and a tick that
      // changes nothing must not touch the DOM at all -- an unconditional repaint every
      // fifteen seconds would drop a text selection the reader was in the middle of.
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        const first = rows(tab.document)[0];
        assert.ok(first, 'setup failure: the store is not empty by now');
        await tab.tick();
        assert.equal(rows(tab.document)[0], first, 'the very same element object, not an equal-looking replacement');
      } finally {
        tab.restoreFetch();
      }
    });

    // ---------------------------------------------------------------------------------
    // Criterion 10: an update preserves scroll position and the search box.
    // ---------------------------------------------------------------------------------

    await check('criterion 10: a live update preserves scroll position and whatever is typed in the search box', async () => {
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        const input = tab.document.querySelector('input.search-input');
        const list = tab.document.querySelector('div.thread-list');
        const body = tab.document.querySelector('body');
        assert.ok(input && list && body, 'setup failure: the page shell is not what this asserts against');

        // The reader has scrolled down and started typing a filter without submitting it.
        tab.document.documentElement.scrollTop = 420;
        input.value = 'half-typed filt';

        // ... and while they are typing, a board lands.
        await postBoard(port, { title: 'Landed mid-type', blocks: [QUESTION('Rudely?')], cwd: projectFor('zeta') });
        await tab.tick();
        assert.ok(rows(tab.document).some(r => r.textContent.includes('Landed mid-type')),
          'setup failure: this only proves anything if the update really happened');

        assert.equal(tab.document.documentElement.scrollTop, 420, 'the scroll position survives the update');
        assert.equal(tab.document.querySelector('input.search-input'), input,
          'the search box is the same element -- a reload or a shell re-render would replace it');
        assert.equal(input.value, 'half-typed filt', 'and what was typed into it is still there');
        assert.equal(tab.document.querySelector('div.thread-list'), list, 'the list itself is patched, not replaced');
        assert.equal(tab.document.querySelector('body'), body, 'and nothing above it is rebuilt');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 10: an update under an active filter keeps the filter, rather than showing everything', async () => {
      // The page was served with ?q=, so the poll has to ask for the same rows. Fetching
      // the unfiltered list would silently undo a filter the reader is looking at.
      const tab = openIndexTab(port, { threads: [], query: 'delta' });
      try {
        await tab.tick();
        const shown = rows(tab.document);
        assert.ok(shown.length >= 1, 'the filtered rows arrive');
        assert.ok(shown.every(r => r.textContent.includes('Moving session')),
          `the poll must carry the page's own filter, got: ${shown.map(r => r.textContent.trim()).join(' | ')}`);
      } finally {
        tab.restoreFetch();
      }
    });

    // ---------------------------------------------------------------------------------
    // The push path: the page hears about a change instead of waiting for one.
    //
    // No tick is ever what DELIVERS the change under test below. That is the whole
    // point -- a tick fired after the change would make every one of these pass against
    // the poll-only page this replaced, and prove nothing. Where a tick does appear it
    // is arranging the baseline, before the change happens, or (criterion 5) it is the
    // thing under test.
    //
    // Falsification, reproduced: reverting src/indexpage.mjs alone turns six checks in
    // this file red -- the first on the subscription itself ("the page must open a live
    // connection at all"), the rest on `tab.push`'s own missing-listener assertion.
    // ---------------------------------------------------------------------------------

    await check('the index holds the daemon-wide stream open, and listens for exactly the events the daemon broadcasts', async () => {
      const tab = openIndexTab(port, { threads: [] });
      try {
        assert.ok(tab.stream, 'the page must open a live connection at all -- without one it is fifteen seconds behind the menu bar');
        assert.equal(tab.stream.url, '/api/events',
          'the DAEMON-WIDE stream (src/server.mjs handleStream), not a per-board one: the index has no board id to subscribe under');
        assert.deepEqual([...tab.stream.listeners.keys()].sort(), ['open', 'pomodoro', 'waiting'],
          'open (first connect and every reconnect), plus the two events the daemon already broadcasts -- a listener for anything else would be waiting on a push nobody sends');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 1: a board posted, and then answered, reaches the list on the daemon\'s own push -- no tick', async () => {
      const wire = openWireStream(port);
      const tab = openIndexTab(port, { threads: [] });
      try {
        await wire.connected();
        await tab.tick(); // the list starts current, so what follows can only be the push
        const posted = await postBoard(port, { title: 'Pushed in', blocks: [QUESTION('Heard?')], cwd: projectFor('iota'), wait: true });
        assert.equal(rowFor(tab.document, posted.thread), null, 'setup: the page cannot already know about it');

        // The daemon's own event, fed to the page verbatim. A page listening for a name
        // the daemon never sends fails here rather than in a hand-written payload.
        const first = await wire.next('waiting');
        assert.equal(typeof first.data.total, 'number', 'the waiting event is a COUNT, not rows -- which is why the page re-fetches instead of applying it');
        await tab.push('waiting', first.data);
        const row = rowFor(tab.document, posted.thread);
        assert.ok(row, 'the row arrives on the push alone');
        assert.equal(row.getAttribute('data-live'), 'true', 'and arrives live, exactly as a tick would have rendered it');

        // The other half of the same criterion: a round answered settles the row, again
        // with nothing but the push the daemon sends for it.
        const submitted = await rawRequest(port, 'POST', `/api/board/${posted.boardId}/submit`, {
          headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
          body: JSON.stringify({ round: 1, action: 'send', answers: [], comments: [] }),
        });
        assert.equal(submitted.status, 200, `submit failed: ${submitted.body}`);
        await tab.push('waiting', (await wire.next('waiting')).data);
        assert.equal(rowFor(tab.document, posted.thread).getAttribute('data-live'), 'false',
          'the answered row settles on the push too');
      } finally {
        tab.restoreFetch();
        wire.close();
      }
    });

    await check('criterion 1: a change landing while a fetch is outstanding is remembered, not dropped -- one more fetch, without waiting for a tick', async () => {
      // Two boards land two milliseconds apart. The first push sends a fetch, and the
      // answer to it is rendered by the daemon BEFORE the second board exists; the
      // second push arrives while that answer is still on the wire. The in-flight guard
      // (one fetch at a time, so responses cannot cross) is what makes the second push
      // meet a busy page -- and dropping it there means the list carries the first board
      // and not the second until the fifteen-second tick, which is not "within a second".
      //
      // The round trip is loopback and takes single-digit milliseconds, so the window is
      // held open by hand rather than raced for: the harness's own fetch is wrapped to
      // make the REAL request (real rows, rendered at the real instant) and then park
      // the response until this check releases it. Same discipline as firing the tick by
      // hand -- the timing under test is pinned, not hoped for.
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick(); // baseline: the list is current before either board exists
        const inflight = globalThis.fetch;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        globalThis.fetch = (url, opts) => inflight(url, opts).then(async r => { await held; return r; });

        const first = await postBoard(port, { title: 'First of two', blocks: [QUESTION('One?')], cwd: projectFor('xi') });
        await tab.push('waiting', { total: 1, now: Date.now() }); // the fetch goes out, and parks

        const second = await postBoard(port, { title: 'Second of two', blocks: [QUESTION('Two?')], cwd: projectFor('omicron') });
        await tab.push('waiting', { total: 2, now: Date.now() }); // ... and this one meets a busy page

        release();
        await flush(); // the parked answer lands: the first board, and only the first
        await flush(); // and whatever the page owes itself for the push it could not serve

        globalThis.fetch = inflight;
        assert.ok(rowFor(tab.document, first.thread), 'the board the outstanding fetch already knew about');
        assert.ok(rowFor(tab.document, second.thread),
          'the board that landed mid-fetch must arrive on its own push too -- a dropped push leaves it invisible until the fifteen-second tick, and nothing was going to ask again');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 2: a timer change reaches the widget on the daemon\'s own push -- no tick', async () => {
      // Reset first so this reads the same however the checks around it left the daemon.
      await rawRequest(port, 'POST', '/api/pomodoro/reset', { headers: { [SECRET_HEADER]: SECRET } });
      const wire = openWireStream(port);
      const tab = openIndexTab(port, { threads: [] });
      try {
        await wire.connected();
        await flush(); // the widget's own load-time fetch settles: an idle daemon
        const status = tab.document.querySelector('span#pomodoro-status');
        assert.match(status.textContent, /^Idle/, 'setup failure: the widget must start from an idle daemon');

        await rawRequest(port, 'POST', '/api/pomodoro/ensure', { headers: { [SECRET_HEADER]: SECRET } });
        await tab.push('pomodoro', (await wire.next('pomodoro')).data);
        assert.match(status.textContent, /^Work \d+\/\d+ · \d\d:\d\d$/,
          `a timer started elsewhere must show here within a push, got: "${status.textContent}"`);

        await rawRequest(port, 'POST', '/api/pomodoro/pause', { headers: { [SECRET_HEADER]: SECRET } });
        await tab.push('pomodoro', (await wire.next('pomodoro')).data);
        assert.match(status.textContent, /\(paused\)$/, `and so must pausing it, got: "${status.textContent}"`);

        // Start, pause, skip, restart, and a work interval ending with nobody at the
        // machine are five daemon-side triggers for ONE event the page cannot tell
        // apart -- every one of them is a `pomodoro` broadcast carrying the document
        // (src/server.mjs's respond, and its onBoundary hook for the unattended one).
        // Two of them here is what proves the page's single handler; that each trigger
        // broadcasts at all is the daemon's own, covered by test/check-boundary.mjs and
        // test/check-menubar-client.mjs.
      } finally {
        tab.restoreFetch();
        wire.close();
      }
    });

    await check('criterion 3, the other direction: an action taken on the index page reaches a menu-bar-shaped subscriber within a second', async () => {
      // CONFIRMED, NOT BUILT. Nothing in indexScript pushes anything: the widget's
      // buttons POST the same pomodoro routes they always did, and those routes already
      // broadcast the document they answer with (src/server.mjs's `respond`). This check
      // exists to prove that end of criterion 3 still holds now that the page is also a
      // subscriber -- not because anything was added for it.
      await rawRequest(port, 'POST', '/api/pomodoro/reset', { headers: { [SECRET_HEADER]: SECRET } });
      const wire = openWireStream(port);
      const tab = openIndexTab(port, { threads: [] });
      try {
        await wire.connected();
        await flush();
        const toggle = tab.document.querySelector('button#pomodoro-toggle');
        assert.equal(toggle.getAttribute('aria-checked'), 'false', 'setup failure: expected an idle daemon, so the press starts a timer');

        const pressedAt = Date.now();
        toggle.dispatchEvent(new StandInEvent('click'));
        const heard = await wire.next('pomodoro');
        assert.ok(Date.now() - pressedAt < 1000, `the press must reach the other surface within a second, took ${Date.now() - pressedAt}ms`);
        assert.ok(heard.data.timer && heard.data.timer.phase === 'work' && !heard.data.timer.paused,
          `the subscriber must be told what the press actually did, got: ${JSON.stringify(heard.data.timer)}`);
      } finally {
        tab.restoreFetch();
        wire.close();
      }
    });

    await check('criterion 6: a push-driven update leaves scroll position and the search box exactly as they were', async () => {
      // The tick-driven twin of this is 'criterion 10' above. Both matter, and they are
      // the same code: a push calls the same patchRows, which replaces the contents of
      // the list and nothing else. A push that reloaded, or re-rendered the shell, would
      // throw away a half-typed filter -- and it would do it while the reader was typing,
      // which is worse than a tick doing it fifteen seconds after they stopped.
      //
      // A hand-shaped event is enough here: the payload is deliberately not read (the
      // check above is what proves the daemon really sends this name).
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        const input = tab.document.querySelector('input.search-input');
        const list = tab.document.querySelector('div.thread-list');
        const body = tab.document.querySelector('body');
        tab.document.documentElement.scrollTop = 420;
        input.value = 'half-typed filt';

        await postBoard(port, { title: 'Pushed mid-type', blocks: [QUESTION('Rudely?')], cwd: projectFor('kappa') });
        await tab.push('waiting', { total: 1, now: Date.now() });
        assert.ok(rows(tab.document).some(r => r.textContent.includes('Pushed mid-type')),
          'setup failure: this only proves anything if the push really updated the list');

        assert.equal(tab.document.documentElement.scrollTop, 420, 'the scroll position survives a push');
        assert.equal(tab.document.querySelector('input.search-input'), input, 'the search box is the same element');
        assert.equal(input.value, 'half-typed filt', 'and what was typed into it is still there');
        assert.equal(tab.document.querySelector('div.thread-list'), list, 'the list itself is patched, not replaced');
        assert.equal(tab.document.querySelector('body'), body, 'and nothing above it is rebuilt');
      } finally {
        tab.restoreFetch();
      }
    });

    await check('criterion 5: with no stream at all, and with one that never says anything, the fifteen-second tick still does the whole job', async () => {
      // Nothing that works today gets slower. Two ways the stream can be unavailable: a
      // browser with no EventSource in it at all, and a connection that is made and then
      // never carries a thing (a daemon that went away, a proxy that swallows the
      // stream). Neither may cost the page anything it had before.
      const blind = openIndexTab(port, { threads: [], eventSource: false });
      try {
        assert.equal(blind.stream, null, 'setup failure: nothing may have subscribed here');
        const posted = await postBoard(port, { title: 'No stream here', blocks: [QUESTION('Still?')], cwd: projectFor('lambda') });
        await blind.tick();
        assert.ok(rowFor(blind.document, posted.thread), 'the tick alone still brings the row in, exactly as it always did');
      } finally {
        blind.restoreFetch();
      }

      const silent = openIndexTab(port, { threads: [] });
      try {
        assert.ok(silent.stream, 'setup failure: this half is about a stream that connects and then says nothing');
        const posted = await postBoard(port, { title: 'Silent stream', blocks: [QUESTION('Anyone?')], cwd: projectFor('mu') });
        await silent.tick(); // no push is ever delivered into this tab
        assert.ok(rowFor(silent.document, posted.thread), 'a silent stream must not cost the page its own tick');
      } finally {
        silent.restoreFetch();
      }
    });

    await check('criterion 4: an index left open through a real daemon restart goes live again on the reconnect alone', async () => {
      // The daemon really stops and really comes back on the same port, so the
      // replacement's stream hub has never heard of this page and holds no history for
      // it -- nothing backfills what was missed. Coming back live therefore has to mean
      // asking what the state is NOW, which is why the page re-fetches on 'open' rather
      // than waiting for the next event.
      //
      // The reconnect itself is fired by hand here for the same reason every tick in
      // this file is: EventSource reconnecting on its own is the BROWSER's behaviour,
      // deliberately not reimplemented (and so not this suite's to prove) -- what is
      // ours is what the page does when it comes back, and that is what this drives.
      await rawRequest(port, 'POST', '/api/pomodoro/reset', { headers: { [SECRET_HEADER]: SECRET } });
      const tab = openIndexTab(port, { threads: [] });
      try {
        await tab.tick();
        await flush();
        assert.match(tab.document.querySelector('span#pomodoro-status').textContent, /^Idle/, 'setup failure: expected an idle daemon before the restart');

        await new Promise(resolve => {
          server.close(resolve);
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
        await tab.tick(); // the daemon is gone: a failed fetch must leave the page alone
        const strandedRows = rows(tab.document).length;

        server = (await startServer({ home, port })).server;

        // Both changes happen while this page is disconnected, so neither can arrive as
        // an event -- they can only be found by asking.
        const posted = await postBoard(port, { title: 'Landed while down', blocks: [QUESTION('Back?')], cwd: projectFor('nu') });
        await rawRequest(port, 'POST', '/api/pomodoro/ensure', { headers: { [SECRET_HEADER]: SECRET } });
        assert.equal(rowFor(tab.document, posted.thread), null, 'setup: the page cannot know about it yet');

        await tab.push('open');
        assert.ok(rowFor(tab.document, posted.thread), 'the reconnect alone brings the list up to date -- no reload, no tick');
        assert.ok(rows(tab.document).length > strandedRows, 'setup sanity: the list really did move');
        assert.match(tab.document.querySelector('span#pomodoro-status').textContent, /^Work \d+\/\d+ · \d\d:\d\d$/,
          'and the widget with it: a reconnect re-fetches both, since neither can be replayed');
      } finally {
        tab.restoreFetch();
      }
    });

  } finally {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    globalThis.fetch = REAL_FETCH;
  }
}

main()
  .catch(err => {
    failures++;
    console.error('FAIL - unexpected error');
    console.error((err && err.stack) || err);
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nall index-live checks ok');
  });
