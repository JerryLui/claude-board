// Real-browser check for the shared stream (ADR 144): every tab of one browser rides one
// connection to the daemon, so a reviewer holding more board tabs than Chrome's six
// connections per host still gets the next page at once. Each tab still counts as its
// board's Watcher, a push still reaches it, the index's daemon-wide events still arrive,
// and closing a tab drops its Watcher at once. A SharedWorker, a Web Lock and Chrome's
// connection cap are browser behaviour the DOM stand-in has none of; the daemon's half
// (beats, the sweep, the routes) is test/check-shared-stream.mjs's.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-shared-stream.mjs
//
// Without Chrome it prints a skip line and exits 0.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile, waitFor } from './support.mjs';
import { CHROME, guardRun, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-shared-stream', `browser-check-shared-stream: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-shared-stream', { deadlineMs: 240000 });

const BOARD_TABS = 7; // one past Chrome's six connections per host
const PROMPT_LOAD_MS = 5000;
const WAITING_EXPR = "parseInt(document.querySelector('span#waiting-count').textContent || '0', 10)";

async function main() {
  const daemon = await startScratchDaemon('cb-shared-stream');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const post = body => postJson(`${origin}/api/board`, body, daemon.secret);
    const cookie = sessionToken(daemon.secret);
    const boards = [];
    for (let i = 1; i <= BOARD_TABS; i++) {
      boards.push(await post({
        title: `Shared stream board ${i}`,
        blocks: [{ kind: 'question', prompt: `Question on board ${i}?`, widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
      }));
    }
    const tabOpts = { width: 1280, height: 900, theme: 'light', expr: 'document.title' };

    await withChrome({ tag: 'cb-shared-stream' }, async ({ send, onEvent }) => {
      const tabs = [];
      await row(`${BOARD_TABS} board tabs each load within ${PROMPT_LOAD_MS} ms`, async note => {
        for (const b of boards) {
          const started = Date.now();
          tabs.push(await openTab(send, onEvent, `${origin}${new URL(b.url).pathname}`, cookie, tabOpts));
          const took = Date.now() - started;
          note(`board ${tabs.length}: ${took} ms`);
          assert.ok(took < PROMPT_LOAD_MS, `board tab ${tabs.length} took ${took} ms to load`);
        }
      });

      let index = null;
      await row('the boards list loads within the same bound beside them', async note => {
        const started = Date.now();
        index = await openTab(send, onEvent, `${origin}/boards`, cookie, { ...tabOpts, expr: WAITING_EXPR });
        const took = Date.now() - started;
        note(`boards list: ${took} ms`);
        assert.ok(took < PROMPT_LOAD_MS, `the boards list took ${took} ms to load`);
      });

      await row('every board tab is its board\'s one Watcher, reports under its id, and a push reaches it', async () => {
        for (let i = 0; i < boards.length; i++) {
          const marker = `Pushed into board ${i + 1}`;
          const answer = await post({ boardId: boards[i].boardId, blocks: [{ kind: 'markdown', text: marker }] });
          assert.equal(answer.clients, 1, `board ${i + 1} counted ${answer.clients} Watchers`);
          await tabs[i].until(`document.body.textContent.indexOf(${JSON.stringify(marker)}) !== -1`, `the push into board ${i + 1}`);
          const reported = await tabs[i].evalPage(`window.__cbNet.requests.indexOf(${JSON.stringify(`POST /api/board/${boards[i].boardId}/attended`)}) !== -1`);
          assert.ok(reported, `board ${i + 1}'s tab never reported whether it is attended, so it never heard its Watcher id`);
        }
      });

      await row('the boards list hears the daemon-wide count change', async () => {
        const before = Number(index.measured);
        await post({
          title: 'One more waiting board',
          blocks: [{ kind: 'question', prompt: 'Another?', widget: 'single', options: [{ label: 'Yes' }, { label: 'No' }] }],
        });
        await index.until(`${WAITING_EXPR} === ${before + 1}`, 'the waiting count rising');
      });

      await row('a live tab its worker dropped is a Watcher again by its next beat', async () => {
        // A pagehide the tab survives stands in for a drop after a long sleep: either way the
        // worker no longer holds a tab that is still open and beating.
        await tabs[2].evalPage("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))");
        const count = async () => (await post({ boardId: boards[2].boardId, blocks: [{ kind: 'markdown', text: 'count' }] })).clients;
        assert.equal(await waitFor(async () => (await count()) === 0, { timeoutMs: 3000, intervalMs: 100 }), true, 'the dropped tab still counted');
        assert.equal(await waitFor(async () => (await count()) === 1, { timeoutMs: 8000, intervalMs: 250 }), true, 'the dropped tab never came back');
      });

      await row('closing a board tab drops its Watcher at once', async () => {
        await tabs[0].close();
        let clients = null;
        await waitFor(async () => {
          clients = (await post({ boardId: boards[0].boardId, blocks: [{ kind: 'markdown', text: 'After the close' }] })).clients;
          return clients === 0;
        }, { timeoutMs: 3000, intervalMs: 200 });
        assert.equal(clients, 0, `board 1 still counted ${clients} Watchers 3 s after its tab closed`);
        const other = await post({ boardId: boards[1].boardId, blocks: [{ kind: 'markdown', text: 'Still here' }] });
        assert.equal(other.clients, 1, 'closing one tab dropped another board\'s Watcher');
      });
    });
  } finally {
    await daemon.stop();
  }
}

runMain('browser-check-shared-stream', main);
