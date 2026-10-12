// The conversation boundary (ADR 69): the agent declaring, with `fresh` on `ask`, that it
// has posted no board in this conversation -- so the shim forgets the board it is holding,
// the next post mints a new thread and opens its tab, and the abandoned board's open rounds
// are closed on the way out.
//
// Service level, patterned on test/check-mcp.mjs: real bin/mcp.mjs processes driven over
// real stdio JSON-RPC, a real daemon started in-process on an ephemeral port, a real store
// under one mkdtemp home. No browser (a stub `open` on CLAUDE_BOARD_OPEN_CMD records every
// tab that would have been opened), no network beyond loopback.
//
// The boundary is a fact about ONE shim process's memory, so almost everything here needs
// two of something -- two calls, two shims, two project directories -- and the assertions
// are about which board each post landed on rather than about any single call's packet.
//
// NO REAL NOTIFICATION MAY EVER FIRE FROM THIS SUITE. Closing the abandoned round is
// exactly the stranded rule's business (a question nobody is listening for), so proving
// the Banner does not fire afterwards means letting one fire first -- with a stub
// `osascript` ahead of the real one on PATH from the first line of this file, and the
// grace pushed down to milliseconds for that one scenario only (test/run.mjs pushes it out
// of reach for every other check, and this file restores it the moment the scenario ends).

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import {
  check, fail, finish, sleep, waitForCount, withEnv, projectFor, secretHome, rawGet,
  spawnShim, makeOpenRecorder, writeStub, STUB_OSASCRIPT_LINGERING, STUB_OPEN,
  BANNER, rowsFor, spawnsFor,
} from './support.mjs';

// --- the temp world -------------------------------------------------------------------

// One mkdtemp directory holds everything: the secret file at its top, the daemon's store
// under `store`, the stubs under `bin`, and one project folder per scenario.
const { home: workDir, secret: SECRET } = secretHome('claude-board-boundary-', { secret: 'b'.repeat(64), setHome: false });
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
process.env.CLAUDE_BOARD_HOME = home;

// The grace is out of reach for the whole file except for the one scenario that shortens it
// through `withEnv`: every board this check posts is stranded by construction (a question
// round nobody opens), and a banner per scenario would be a pile of lingering stub children
// for no assertion. `withEnv` puts this value back even if the scenario throws, so a failed
// assertion does not leave the next scenario announcing real absences.
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(24 * 60 * 60 * 1000);

// --- the stubs on PATH ----------------------------------------------------------------
//
// The notifier (test/support.mjs's `STUB_OSASCRIPT_LINGERING`) records the argv it was
// spawned with, and with a linger it stays alive long enough to record the signal that kills
// it -- which is how "the banner was withdrawn" becomes observable with no banner ever
// appearing.
//
// The daemon must open no tab of its own (ADR 55). `open` is stubbed rather than merely
// unasserted, so a reopen added on that path shows up here instead of on a reader's screen.
const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', STUB_OSASCRIPT_LINGERING);
writeStub(stubDir, 'open', STUB_OPEN);
process.env.PATH = `${stubDir}:${process.env.PATH}`;
process.env.STUB_OPEN_LOG = path.join(workDir, 'daemon-open.log');
// One notifier log for the whole file, read per project folder (`rowsFor`, `spawnsFor`)
// rather than rotated per scenario: a grace armed by one scenario can fire during the next.
const OSASCRIPT_LOG = path.join(workDir, 'osascript.log');
process.env.STUB_OSASCRIPT_LOG = OSASCRIPT_LOG;
// Long enough that a banner's child is still alive when the boundary is declared, so the
// SIGTERM that withdraws it is recorded rather than raced against the child's own exit.
// Generous rather than snug: the suite runs four checks at a time beside a 60-second
// installer, and a child that reaches its own deadline first records 'deadline' instead,
// turning a real withdrawal into a red assertion about scheduling.
process.env.STUB_OSASCRIPT_LINGER_MS = '60000';

const liveShims = new Set();

/** One shim process, standing in for one Claude Code session: its own project directory
 * (`cwd`, which is what binds the board) and its own opener log (`recorder`, a
 * `makeOpenRecorder` in a folder of its own), which is what makes "which session opened a
 * tab" answerable at all. */
function spawnSession({ cwd, recorder }) {
  const client = spawnShim({
    CLAUDE_BOARD_HOME: home,
    CLAUDE_BOARD_PORT: String(port),
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_BOARD_PROGRESS_MS: '5000',
    CLAUDE_BOARD_OPEN_CMD: recorder.script,
    CLAUDE_BOARD_OPEN_LOG: recorder.log,
    CLAUDE_BOARD_NO_OPEN: undefined, // opening is exercised for real, into the recorder
  }, { cwd });
  liveShims.add(client);
  return client;
}

// --- store readers --------------------------------------------------------------------

function boardIds() {
  const dir = path.join(home, 'boards');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.tmp-')).map(f => f.slice(0, -'.json'.length));
}

function storedBoard(id) {
  return JSON.parse(readFileSync(path.join(home, 'boards', `${id}.json`), 'utf8'));
}

/** Poll for a board file this call minted, rather than assuming the store holds one:
 * several scenarios share this home, so "a board appeared" has to mean a NEW one. */
async function waitForNewBoard(known, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fresh = boardIds().filter(id => !known.has(id));
    if (fresh.length) return fresh[0];
    await sleep(20);
  }
  throw new Error('timed out waiting for a new board document');
}

/** Which board a recorded tab-open actually lands on. The shim normally opens a one-time
 * handoff rather than the board URL, so this follows it exactly as the browser does — one
 * GET, no redirect following — and reads the board out of the `Location`.
 *
 * The bare `/b/<id>` form is accepted too, because it is a real, documented outcome and
 * not a failure: a shim whose handoff mint does not come back opens the board URL directly
 * and says so on stderr (bin/mcp.mjs `handoffUrl`). Which board the tab landed on is the
 * question here, and both forms answer it; test/check-mcp.mjs is where the handoff itself
 * is pinned. Insisting on the redirect would make this check fail for a slow mint under a
 * loaded suite, which is a statement about scheduling rather than about boundaries. */
async function boardBehindOpen(openedUrl) {
  const direct = openedUrl.match(/\/b\/([A-Za-z0-9_-]+)$/);
  if (direct) return direct[1];
  const landed = await rawGet(openedUrl);
  assert.equal(landed.status, 302, `a tab-open must land on a board or a handoff redirect (got ${landed.status})`);
  return String(landed.headers.location || '').replace(/^\/b\//, '');
}

const QUESTION = { kind: 'question', prompt: 'Ship it?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] };
const NOTE = { kind: 'markdown', text: '# Note\n\nnothing to answer here' };

const askArgs = (title, blocks, extra = {}) => ({ name: 'ask', arguments: { title, blocks, ...extra } });

let server, port, base;

async function main() {
  ({ server, port } = await startServer({ home, port: 0 }));
  base = `http://127.0.0.1:${port}`;

  // === AC 1, 2, 3: declaring a boundary after a real board =============================

  await check('a declared boundary mints a new thread on a new board and opens its tab, and closes the abandoned board\'s open round', async () => {
    const project = projectFor(workDir, 'cleared');
    const recorder = makeOpenRecorder(projectFor(workDir, 'opener-cleared'));
    const client = spawnSession({ cwd: project, recorder });
    const known = new Set(boardIds());
    let firstCall;

    await withEnv({ CLAUDE_BOARD_STRANDED_GRACE_MS: 60 }, async () => {
      // The conversation before the /clear: a question round, so there is something
      // genuinely awaited to be walked away from.
      firstCall = client.requestWithId('tools/call', askArgs('Old work', [QUESTION]));
      const boardA = await waitForNewBoard(known);
      const openedFirst = await recorder.waitForOpens(1);
      assert.equal(openedFirst.length, 1, 'the conversation\'s first board opens exactly one tab');
      assert.equal(await boardBehindOpen(openedFirst[0]), boardA, 'and it opens on that board');

      // Nobody opens it, so the daemon announces it -- which is the state AC 3 is about:
      // a banner standing for a round that is about to be abandoned.
      const rows = await waitForCount(() => rowsFor(OSASCRIPT_LOG, 'cleared'), 1, { timeoutMs: 10_000, intervalMs: 10 });
      assert.deepEqual(rows, [['spawn', '-e', BANNER('cleared')]], 'the abandoned round had a Banner standing for it');
      assert.ok(storedBoard(boardA).strandedBanner, 'and the daemon recorded it on the board');

      // The /clear. The shim process is the same one -- that is the whole problem -- so
      // the declaration is the only thing that can separate the two conversations.
      const second = await client.request('tools/call', askArgs('New work', [NOTE], { fresh: true }));
      const packet = second.result;
      assert.equal(packet.isError, false, `the fresh post must succeed: ${packet.content && packet.content[0] && packet.content[0].text}`);

      const boardB = packet.board;
      assert.notEqual(boardB, boardA, 'AC 1: the first question after a /clear lands on a NEW board');
      assert.equal(storedBoard(boardB).cwd, storedBoard(boardA).cwd, 'in the same project directory, which never moved');
      assert.notEqual(packet.thread, storedBoard(boardA).thread, 'AC 2: and that board belongs to a NEW thread');

      const openedBoth = await recorder.waitForOpens(2);
      assert.equal(openedBoth.length, 2, 'AC 1: the new board opens a second tab');
      assert.equal(await boardBehindOpen(openedBoth[1]), boardB, 'on the new board, not the abandoned one');

      // AC 3, the durable half: every round on the abandoned board is closed, and closed
      // as neither answered nor lapsed.
      const abandoned = storedBoard(boardA);
      assert.deepEqual(abandoned.rounds.map(r => r.status), ['abandoned'], 'AC 3: no round on it is left open');
      const round = abandoned.rounds[0];
      assert.equal(round.awaited, false, 'AC 3: and none is left awaited');
      assert.equal(round.sentAt, null, 'nothing was sent: nobody answered it');
      assert.equal(round.action, undefined, 'and no outcome is recorded, so nothing reads it back as an answer');
      assert.match(round.abandonedAt, /^\d{4}-\d\d-\d\dT/, 'the moment it was abandoned is stamped on it');
      assert.ok(round.awaitDeadline, 'the deadline it was minted with is left in place, exactly as a lapse leaves it');
      assert.deepEqual(abandoned.answers, {}, 'and no answer was fabricated for it');

      // AC 3, the live half: the Banner is withdrawn and cannot fire again.
      // The record is NOT cleared, and that is ADR.md entry 74 rather than a leak: the
      // announcement mark is per round and permanent, and abandoning a board is not the
      // reviewer returning to it. What goes is the banner on screen and the pid that named
      // the process serving it -- the withdrawal, without the "and now the next round may
      // announce itself" that used to come with it.
      const spent = storedBoard(boardA).strandedBanner;
      assert.ok(spent, 'the mark stays: a round announced once is announced for its whole life');
      assert.equal(spent.returned, false, 'and so does the shut gate -- nobody came back, they cleared');
      assert.equal(spent.pid, null, 'only the pid goes, with the process about to be killed');
      const withdrawn = await waitForCount(() => rowsFor(OSASCRIPT_LOG, 'cleared'), 2, { timeoutMs: 10_000, intervalMs: 10 });
      assert.ok(withdrawn.some(r => r[0] === 'SIGTERM'),
        `SIGTERM specifically: it is the path that withdraws the delivered banner from Notification Center (rows: ${JSON.stringify(withdrawn)})`);

      // Re-evaluated from scratch, the way any later event on this board would: nothing is
      // awaited, so nothing is announced -- now or ever, since only a round landing on this
      // board could arm it again and none ever will.
      const poke = await fetch(`${base}/api/board/${boardA}/attended`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: SECRET },
        body: JSON.stringify({ watcher: 'w_nobody', attended: false }),
      });
      assert.equal(poke.status, 200);
      await sleep(200); // several graces
      assert.equal(spawnsFor(OSASCRIPT_LOG, 'cleared').length, 1, 'AC 3: its Banner does not fire afterwards');
    });

    // No wait on the abandoned round can ever return again (a late Send stores its
    // answers for `read` -- ADR 114 -- but never re-arms this call), so the blocked call
    // that posted it is released here rather than left polling to the wall clock.
    client.notify('notifications/cancelled', { requestId: firstCall.id, reason: 'check done' });
    await sleep(50);
    client.close();
  });

  await check('AC 2: the index lists the cleared conversation and the new one as separate rows', async () => {
    const page = await rawGet(`${base}/`, { [SECRET_HEADER]: SECRET });
    assert.equal(page.status, 200);
    const rows = [...page.body.matchAll(/data-thread-id="([^"]+)"/g)].map(m => m[1]);
    const threads = boardIds().map(id => storedBoard(id)).filter(b => b.cwd && b.cwd.endsWith('/cleared')).map(b => b.thread);
    assert.equal(new Set(threads).size, 2, 'the two conversations really did mint two threads');
    for (const t of threads) assert.ok(rows.includes(t), `the index is missing a row for thread ${t}`);
    assert.equal(rows.length, new Set(rows).size, 'one row per thread, never two rows for one');
  });

  await check('an abandoned board stops advertising an open round on the index', async () => {
    const abandoned = boardIds().map(id => storedBoard(id)).find(b => b.rounds.some(r => r.status === 'abandoned'));
    const page = await rawGet(`${base}/`, { [SECRET_HEADER]: SECRET });
    const row = page.body.match(new RegExp(`data-thread-id="${abandoned.thread}"[^>]*`))[0];
    assert.match(row, /data-rounds-left="0"/, 'nothing on it is still owed');
    assert.match(row, /data-live="false"/, 'and the row is not live');
  });

  // === AC 4: no declaration, no boundary ===============================================

  await check('AC 4: a post that does not declare a boundary pushes a round onto the current board', async () => {
    const project = projectFor(workDir, 'carry-on');
    const recorder = makeOpenRecorder(projectFor(workDir, 'opener-carry-on'));
    const client = spawnSession({ cwd: project, recorder });
    try {
      const known = new Set(boardIds());
      const first = (await client.request('tools/call', askArgs('Round one', [NOTE]))).result;
      const second = (await client.request('tools/call', askArgs('Round two', [NOTE]))).result;

      assert.equal(second.board, first.board, 'the second round lands on the same board');
      assert.equal(second.thread, first.thread, 'in the same thread');
      assert.equal(second.round, 2, 'as round 2, exactly as before');
      assert.deepEqual(boardIds().filter(id => !known.has(id)), [first.board], 'and no second board document exists');
      // Wait for the one tab that IS expected before asserting there is no second: `open`
      // is spawned detached and nothing here ever learns it ran, so a bare sleep asserts
      // the machine's scheduling rather than the shim's behaviour.
      assert.equal((await recorder.waitForOpens(1)).length, 1, 'the conversation opened its one tab');
      await sleep(300);
      assert.equal(recorder.opened().length, 1, 'and no second tab is opened');
    } finally {
      client.close();
    }
  });

  // === AC 5: declaring with nothing to abandon =========================================

  await check('AC 5: declaring a boundary in a conversation that has posted no board is a no-op', async () => {
    const project = projectFor(workDir, 'virgin');
    const recorder = makeOpenRecorder(projectFor(workDir, 'opener-virgin'));
    const client = spawnSession({ cwd: project, recorder });
    try {
      const known = new Set(boardIds());
      const only = (await client.request('tools/call', askArgs('First ever', [NOTE], { fresh: true }))).result;
      assert.equal(only.isError, false, 'the call succeeds with nothing to walk away from');

      const minted = boardIds().filter(id => !known.has(id));
      assert.deepEqual(minted, [only.board], 'one board');
      const threads = new Set(minted.map(id => storedBoard(id).thread));
      assert.equal(threads.size, 1, 'one thread');
      const opened = await recorder.waitForOpens(1);
      await sleep(300); // long enough for a second open to have shown up if one were coming
      assert.equal(recorder.opened().length, 1, `one tab (opened: ${JSON.stringify(opened)})`);
      assert.equal(await boardBehindOpen(recorder.opened()[0]), only.board, 'on the board that was actually minted');
    } finally {
      client.close();
    }
  });

  // === AC 6: two sessions, one project directory =======================================

  await check('AC 6: two sessions in one project directory are unaffected by each other\'s declarations', async () => {
    // The same directory for both, deliberately: `cwd` is the only thing the two shims
    // have in common, and it is what a daemon-side rule would be tempted to key on.
    const project = projectFor(workDir, 'shared-project');
    const recorderA = makeOpenRecorder(projectFor(workDir, 'opener-shared-a'));
    const recorderB = makeOpenRecorder(projectFor(workDir, 'opener-shared-b'));
    const a = spawnSession({ cwd: project, recorder: recorderA });
    const b = spawnSession({ cwd: project, recorder: recorderB });
    try {
      const sessionA = (await a.request('tools/call', askArgs('Session A', [NOTE]))).result;
      const sessionB = (await b.request('tools/call', askArgs('Session B', [NOTE]))).result;
      assert.notEqual(sessionB.board, sessionA.board, 'two sessions never shared a board to begin with');

      const bBefore = storedBoard(sessionB.board);
      const aClears = (await a.request('tools/call', askArgs('Session A, cleared', [NOTE], { fresh: true }))).result;
      assert.notEqual(aClears.board, sessionA.board, 'A really did move to a new board');

      // B is untouched by A's declaration: same board, same thread, same rounds, and its
      // next post still lands where it always would have.
      const bAfter = storedBoard(sessionB.board);
      assert.deepEqual(bAfter.rounds.map(r => r.status), bBefore.rounds.map(r => r.status),
        'AC 6: one session clearing does not close the other\'s rounds');
      assert.equal(bAfter.thread, bBefore.thread, 'nor move its thread');

      const bNext = (await b.request('tools/call', askArgs('Session B, round two', [NOTE]))).result;
      assert.equal(bNext.board, sessionB.board, 'AC 6: B\'s next post lands on B\'s own board');
      assert.equal(bNext.round, 2, 'as its round 2');
      assert.equal((await recorderB.waitForOpens(1)).length, 1, 'B opened its own one tab');
      await sleep(300);
      assert.equal(recorderB.opened().length, 1, 'and B never opened a second tab');
    } finally {
      a.close();
      b.close();
    }
  });

  // === the route itself ================================================================

  await check('abandoning is idempotent, scoped to the board named, and refuses an unknown one', async () => {
    const target = boardIds().map(id => storedBoard(id)).find(b => b.rounds.some(r => r.status === 'abandoned'));
    const again = await fetch(`${base}/api/board/${target.id}/abandon`, { method: 'POST', headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).closed, [], 'a second declaration finds nothing left open and closes nothing');

    const missing = await fetch(`${base}/api/board/b_nosuchboard/abandon`, { method: 'POST', headers: { [SECRET_HEADER]: SECRET } });
    assert.equal(missing.status, 404, 'a board id that names nothing is a 404, not a silent success');
  });

  await check('abandoning needs the local secret: the browser session cookie does not reach it', async () => {
    const live = boardIds().map(id => storedBoard(id)).find(b => b.rounds.every(r => r.status === 'open'));
    assert.ok(live, 'there is a board with an open round to try this against');
    const refused = await fetch(`${base}/api/board/${live.id}/abandon`, { method: 'POST' });
    assert.equal(refused.status, 401, 'no credential, no closing somebody else\'s round');
    assert.deepEqual(storedBoard(live.id).rounds.map(r => r.status), live.rounds.map(r => r.status), 'and nothing changed');
  });

  await check('the daemon opened no tab of its own throughout', () => {
    const opened = existsSync(process.env.STUB_OPEN_LOG) ? readFileSync(process.env.STUB_OPEN_LOG, 'utf8') : '';
    assert.equal(opened, '', 'a stub `open` sits ahead of the real one on PATH: only the shim ever opens a tab');
  });
}

try {
  await main();
} catch (err) {
  fail('the check itself threw', err);
} finally {
  for (const c of liveShims) c.close();
  if (server) {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
  rmSync(workDir, { recursive: true, force: true });
}

await finish('boundary', { failText: n => `${n} boundary check(s) failed` });
