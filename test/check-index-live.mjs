// The index stops lying (SPEC_SIGNALS.md criteria 9 and 10; ADR 77): the daemon owes a
// rows endpoint, and the index's own fifteen-second tick fetches it and patches the list
// in place rather than reloading.
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
// milliseconds instead of fifteen real seconds.
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
import { parseHTML } from './dom-stand-in.mjs';

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
 * fifteen-second tick can be fired by hand. */
function openIndexTab(port, { threads = [], query = '' } = {}) {
  const document = parseHTML(renderIndexPage({ threads, query }));
  const intervals = [];
  globalThis.fetch = (url, opts) => {
    const target = `http://127.0.0.1:${port}${url}`;
    const headers = { ...(opts && opts.headers), cookie: sessionCookieHeader() };
    return REAL_FETCH(target, { ...opts, headers });
  };
  new Function('document', 'setInterval', indexScript)(document, (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  });
  const poll = intervals.find(i => i.ms === 15000);
  assert.ok(poll, 'setup failure: the index must register a fifteen-second tick');
  return {
    document,
    /** One poll interval, as the page really runs it. */
    async tick() {
      poll.fn();
      await flush();
    },
    restoreFetch() { globalThis.fetch = REAL_FETCH; },
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 60));

const rows = doc => doc.querySelectorAll('a.thread-item');
const rowFor = (doc, threadId) => rows(doc).find(r => r.getAttribute('data-thread-id') === threadId) || null;

async function main() {
  const { server, port } = await startServer({ home, port: 0 });

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
