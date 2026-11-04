// Real-browser check that a round answered in one tab reads answered in every open tab of
// its board: no owed dot on its pager pill, no countdown, its page the sent record rather
// than the open form. Four ways a tab can be away when the answer lands, each driven in
// one headless Chrome against the branch's own daemon:
//
// - hidden behind the tab that sends, and frozen (Page.setWebLifecycleState), for a moment
//   and then for longer than the shared stream's worker keeps a silent tab
//   (src/stream-worker.mjs, ADR 144), so the second freeze comes back through the worker
//   registering the tab again;
// - on a stream that dropped: the tab reaches the daemon through a TCP relay this check
//   cuts while the other tab, on the daemon's own port, sends;
// - on a stream worker that ended (closed over DevTools, as a crash ends it) before the
//   round is sent, which leaves every tab of that browser on a dead port;
// - an older round, its wait already lapsed, sent after a newer round exists.
//
// Every tab of one browser shares one stream through a SharedWorker, and a frozen page's
// message queue, a Web Lock and a dropped connection are browser behaviour the DOM
// stand-in has none of.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-answered-tabs.mjs [--shots <dir>]
//
// `--shots <dir>` writes there each away tab's screenshot, taken once it has shown again
// and read answered, or (the ended worker's) once it failed to.
// Without Chrome it prints a skip line and exits 0.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile, sleep, waitFor, withTimeout } from './support.mjs';
import { CHROME, guardRun, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-answered-tabs', `browser-check-answered-tabs: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-answered-tabs', { deadlineMs: 360000 });

const shotsAt = process.argv.indexOf('--shots');
const SHOTS_DIR = shotsAt === -1 ? null : path.resolve(process.argv[shotsAt + 1]);

// "Within a few seconds of that tab showing again."
const SHOWN_MS = 5000;
// A dropped stream comes back on EventSource's own retry, about 3 s, and then registers
// the tab before the tab re-reads the board.
const RECONNECT_MS = 10000;
// A tab finds its worker gone at the second beat after it went, 5 to 10 s, and opens
// a fresh one.
const WORKER_GONE_MS = 15000;
// "At once": a push, no reconnect.
const AT_ONCE_MS = 2000;
// How long a tab that missed the answer is left away before it shows again, so a push it
// was going to get has had time to arrive.
const AWAY_MS = 1500;
// src/stream-worker.mjs drops a tab silent for 75 s, on a 5 s sweep.
const PAST_TAB_SILENCE_MS = 85000;
// The lapsed round's whole wait, for the third case's own daemon.
const SHORT_WAIT_MS = 3000;

const TAB = { width: 1280, height: 900, theme: 'light', expr: 'document.title' };

const question = (prompt, requestId) => ({
  ...(requestId ? { requestId } : {}),
  blocks: [{ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
});

/** What a tab shows of round `n`: its page's status, the owed dot on its pager pill, the
 * countdown's text while it shows on round `n`'s own page (it counts down the page on
 * screen), the page on screen, and whether Send is live. */
const LOOK = n => `(function () {
  var section = document.querySelector('.round[data-round="${n}"]');
  var pill = document.querySelector('nav#round-pager .round-page[data-round="${n}"]');
  var countdown = document.querySelector('span#round-countdown');
  var current = document.querySelector('.round.round-current');
  var onScreen = current ? Number(current.getAttribute('data-round')) : null;
  var send = document.querySelector('button#send-btn');
  return {
    status: section ? section.getAttribute('data-round-status') : null,
    owed: !!pill && pill.classList.contains('round-page-owed'),
    countdown: onScreen === ${n} && countdown && countdown.classList.contains('visible') ? countdown.textContent : '',
    current: onScreen,
    sendLive: !!send && !send.disabled,
    visibility: document.visibilityState,
  };
})()`;

const answered = look => look.status === 'sent' && !look.owed && !look.countdown;

/** Waits up to `ms` for round `n` to read answered in `tab`; answers how long it took, or
 * fails with what the tab still showed. */
async function answeredWithin(tab, n, ms, who) {
  const started = Date.now();
  let look = null;
  const ok = await waitFor(async () => answered(look = await tab.evalPage(LOOK(n))), { timeoutMs: ms, intervalMs: 100 });
  assert.ok(ok, `${who} still showed round ${n} open ${ms} ms on: ${JSON.stringify(look)}`);
  return Date.now() - started;
}

/** Answers Yes to round `n`'s question in `tab`, on the page it is on, and presses Send. */
async function sendRound(tab, n) {
  const sent = await tab.evalPage(`(function () {
    var section = document.querySelector('.round[data-round="${n}"]');
    if (!section || !section.classList.contains('round-current')) return 'round ${n} is not the page on screen';
    var yes = section.querySelector('.choice-single');
    if (!yes) return 'round ${n} has no option to pick';
    yes.click();
    var send = document.querySelector('button#send-btn');
    if (!send || send.disabled) return 'Send is not live on round ${n}';
    send.click();
    return 'sent';
  })()`);
  assert.equal(sent, 'sent', sent);
}

async function show(send, tab) {
  await send('Target.activateTarget', { targetId: tab.targetId });
}

async function shoot(tab, name, note) {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  const { data } = await tab.sp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS_DIR, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  note(`shot: ${file}`);
}

/** A TCP relay to the daemon that can be cut: every connection through it is dropped and,
 * until it is restored, refused at once. A tab loaded through it rides a stream of its own
 * (another origin, so another SharedWorker), the shape of a reviewer reaching the daemon
 * through a tunnel that drops. */
function createCutRelay(daemonPort) {
  const sockets = new Set();
  let cut = false;
  const server = net.createServer(client => {
    client.on('error', () => {});
    if (cut) { client.destroy(); return; }
    const upstream = net.connect(daemonPort, '127.0.0.1');
    upstream.on('error', () => {});
    sockets.add(client);
    sockets.add(upstream);
    const forget = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', forget);
    upstream.on('close', forget);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return {
    async listen() {
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      return server.address().port;
    },
    cut() {
      cut = true;
      for (const s of [...sockets]) s.destroy();
    },
    restore() { cut = false; },
    close() {
      for (const s of [...sockets]) s.destroy();
      return new Promise(res => server.close(res));
    },
  };
}

async function awayTabs() {
  const daemon = await startScratchDaemon('cb-answered-tabs');
  const relay = createCutRelay(await daemon.port());
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const relayOrigin = `http://127.0.0.1:${await relay.listen()}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    const cookie = sessionToken(daemon.secret);

    await withChrome({ tag: 'cb-answered-tabs' }, async ({ send, onEvent }) => {
      /** Two tabs of a fresh one-question board, `sender` in front; `awayOrigin` is where
       * the other tab loads it from. */
      async function twoTabs(title, awayOrigin) {
        const requestId = `${title}-request`;
        const board = await post({ title, ...question(`${title}?`, requestId) });
        const pathname = new URL(board.url).pathname;
        const away = await openTab(send, onEvent, `${awayOrigin}${pathname}`, cookie, TAB);
        const sender = await openTab(send, onEvent, `${origin}${pathname}`, cookie, TAB);
        // The same post again is a retry the daemon dedupes: it changes nothing and
        // answers how many tabs it counts as the board's Watchers.
        const watchers = async () => (await post({ boardId: board.boardId, title, ...question(`${title}?`, requestId) })).clients;
        assert.equal(await waitFor(async () => (await watchers()) === 2, { timeoutMs: 5000, intervalMs: 100 }), true,
          'setup: the board never counted both tabs');
        for (const [who, tab] of [['the away tab', away], ['the sending tab', sender]]) {
          const look = await tab.evalPage(LOOK(1));
          assert.ok(look.status === 'open' && look.owed && look.countdown && look.sendLive,
            `setup: ${who} did not show round 1 open, dotted and counting down: ${JSON.stringify(look)}`);
        }
        assert.equal((await away.evalPage(LOOK(1))).visibility, 'hidden', 'setup: the away tab is not hidden behind the sender');
        return { board, away, sender, watchers };
      }

      await row('a tab hidden and frozen while another tab sends reads answered within a few seconds of showing', async note => {
        const { away, sender } = await twoTabs('Frozen briefly', origin);
        await away.sp('Page.setWebLifecycleState', { state: 'frozen' });
        await sendRound(sender, 1);
        note(`sending tab: answered in ${await answeredWithin(sender, 1, AT_ONCE_MS, 'the sending tab')} ms`);
        await sleep(AWAY_MS);
        // DevTools still evaluates in a frozen page; the page's own tasks wait.
        const held = await withTimeout(away.evalPage(LOOK(1)), 3000, 'setup: the frozen tab answered no evaluation');
        assert.equal(held.status, 'open', `setup: the frozen tab took the answer while frozen, so this row never thawed one: ${JSON.stringify(held)}`);
        await away.sp('Page.setWebLifecycleState', { state: 'active' });
        await show(send, away);
        note(`frozen tab: answered ${await answeredWithin(away, 1, SHOWN_MS, 'the frozen tab')} ms after showing`);
        await shoot(away, 'hidden-tab-shown.png', note);
        await away.close();
        await sender.close();
      });

      await row('a tab frozen past the worker\'s silence, the answer sent after it was dropped, reads answered within a few seconds of showing', async note => {
        const { away, sender, watchers } = await twoTabs('Frozen long', origin);
        await away.sp('Page.setWebLifecycleState', { state: 'frozen' });
        await sleep(PAST_TAB_SILENCE_MS);
        assert.equal(await watchers(), 1, 'setup: the worker still holds the frozen tab, so this row is the brief freeze again');
        await sendRound(sender, 1);
        await answeredWithin(sender, 1, AT_ONCE_MS, 'the sending tab');
        await sleep(AWAY_MS);
        await away.sp('Page.setWebLifecycleState', { state: 'active' });
        await show(send, away);
        note(`frozen tab: answered ${await answeredWithin(away, 1, SHOWN_MS, 'the frozen tab')} ms after showing`);
        await away.close();
        await sender.close();
      });

      await row('a tab whose stream dropped while another tab sends reads answered once it reconnects', async note => {
        const { away, sender } = await twoTabs('Dropped stream', relayOrigin);
        relay.cut();
        await sendRound(sender, 1);
        await answeredWithin(sender, 1, AT_ONCE_MS, 'the sending tab');
        await sleep(AWAY_MS);
        const missed = await away.evalPage(LOOK(1));
        assert.equal(missed.status, 'open', `setup: the cut tab heard the answer anyway, so its stream never dropped: ${JSON.stringify(missed)}`);
        relay.restore();
        await show(send, away);
        note(`dropped tab: answered ${await answeredWithin(away, 1, RECONNECT_MS, 'the dropped tab')} ms after the stream came back`);
        await shoot(away, 'dropped-stream-tab.png', note);
        await away.close();
        await sender.close();
      });

      await row('every tab of a browser whose stream worker ended reads a round sent there answered: the tab shown again within a few seconds, the sending tab within two beats', async note => {
        const { away, sender } = await twoTabs('Worker ended', origin);
        const workers = async () => (await send('Target.getTargets')).targetInfos
          .filter(t => t.type === 'shared_worker' && t.url.startsWith(`${origin}/api/stream/`));
        const [worker, ...others] = await workers();
        assert.ok(worker && !others.length, 'setup: the two tabs do not share one stream worker');
        // What a worker crash or a Task Manager End process does; Chrome tells its tabs nothing.
        await send('Target.closeTarget', { targetId: worker.targetId });
        assert.equal(await waitFor(async () => (await workers()).length === 0, { timeoutMs: 3000, intervalMs: 100 }), true,
          'setup: the stream worker outlived its close');
        const sentAt = Date.now();
        await sendRound(sender, 1);
        await sleep(AWAY_MS);
        await show(send, away);
        try {
          note(`tab shown again: answered ${await answeredWithin(away, 1, SHOWN_MS, 'the tab shown again')} ms after showing`);
        } finally {
          await shoot(away, 'worker-ended-tab.png', note);
        }
        await answeredWithin(sender, 1, WORKER_GONE_MS, 'the sending tab');
        note(`sending tab: answered ${Date.now() - sentAt} ms after its Send`);
        await away.close();
        await sender.close();
      });
    });
  } finally {
    await relay.close();
    await daemon.stop();
  }
}

async function lapsedOlderRound() {
  const daemon = await startScratchDaemon('cb-answered-lapsed', { env: { CLAUDE_BOARD_TIMEOUT_MS: String(SHORT_WAIT_MS) } });
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    const cookie = sessionToken(daemon.secret);

    await withChrome({ tag: 'cb-answered-lapsed' }, async ({ send, onEvent }) => {
      await row('an older round sent after its wait lapsed, a newer round open, closes at once in every tab, its pager pill included', async note => {
        const board = await post({ title: 'Lapsed older round', ...question('Round one?') });
        const pathname = new URL(board.url).pathname;
        const onTwo = await openTab(send, onEvent, `${origin}${pathname}`, cookie, TAB);
        const onOne = await openTab(send, onEvent, `${origin}${pathname}`, cookie, TAB);
        const sender = await openTab(send, onEvent, `${origin}${pathname}`, cookie, TAB);
        const tabs = [['the tab left on round 2', onTwo], ['the other tab on round 1', onOne], ['the sending tab', sender]];
        await sleep(SHORT_WAIT_MS + 500);
        const second = await post({ boardId: board.boardId, title: 'Round two', ...question('Round two?') });
        assert.equal(second.round, 2, `setup: the post after round 1 lapsed amended it instead of opening round 2 (round ${second.round})`);
        for (const [who, tab] of tabs) {
          await tab.until(`document.querySelector('.round.round-current[data-round="2"]')`, `${who} landing on round 2`);
          const one = await tab.evalPage(LOOK(1));
          assert.ok(one.status === 'open' && one.owed, `setup: ${who} did not show the lapsed round 1 open and dotted: ${JSON.stringify(one)}`);
        }
        for (const [who, tab] of [tabs[1], tabs[2]]) {
          await tab.evalPage(`document.querySelector('nav#round-pager .round-page[data-round="1"]').click()`);
          await tab.until(`document.querySelector('.round.round-current[data-round="1"]')`, `${who} flipping to round 1`);
        }
        await sendRound(sender, 1);
        for (const [who, tab] of tabs) note(`${who}: round 1 answered in ${await answeredWithin(tab, 1, AT_ONCE_MS, who)} ms`);
        const readerLook = await onOne.evalPage(LOOK(1));
        assert.ok(readerLook.current === 1 && !readerLook.sendLive,
          `the other tab on round 1 left it, or still offers Send on it: ${JSON.stringify(readerLook)}`);
        const two = await onTwo.evalPage(LOOK(2));
        assert.ok(two.current === 2 && two.status === 'open' && two.owed,
          `the tab left on round 2 lost it, or round 2 stopped reading unsent and dotted: ${JSON.stringify(two)}`);
        await show(send, onTwo);
        await shoot(onTwo, 'older-round-pager.png', note);
        for (const [, tab] of tabs) await tab.close();
      });
    });
  } finally {
    await daemon.stop();
  }
}

async function main() {
  await awayTabs();
  await lapsedOlderRound();
}

runMain('browser-check-answered-tabs', main);
