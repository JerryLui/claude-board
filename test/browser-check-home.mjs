// Real-browser check for a board page's Home mark: it goes to the overview this browser last
// opened, Missions (`/`) or Boards (`/boards`), remembered across a reload; a browser that has
// opened neither goes to Missions. The memory is the browser's own storage, which the DOM
// stand-in does not keep across page loads.
//
// NOT wired into test/run.mjs's `checks` array, on purpose: that suite has to pass on a
// machine with no Chrome installed. Run this one by hand:
//
//   node test/browser-check-home.mjs
//
// Without Chrome it prints a skip line and exits 0.
//
// Harness: test/browser-support.mjs -- the branch's own bin/daemon.mjs on a scratch port
// and a scratch store, headless Chrome over the DevTools Protocol, one profile per run.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sessionToken } from '../src/secret.mjs';
import { runMain, skipFile } from './support.mjs';
import { CHROME, guardRun, measureTab, openTab, postJson, row, startScratchDaemon, withChrome } from './browser-support.mjs';

if (!existsSync(CHROME)) skipFile('browser-check-home', `browser-check-home: no Chrome at ${CHROME} (set CLAUDE_BOARD_CHROME_BIN to override)`);

guardRun('browser-check-home', { deadlineMs: 120000 });

const HOME_HREF = `(function () { var a = document.querySelector('a.back-to-index'); return a ? a.getAttribute('href') : null; })()`;
const VIEW = { width: 1280, height: 800, theme: 'light' };

async function main() {
  const daemon = await startScratchDaemon('cb-home');
  try {
    const port = await daemon.port();
    const origin = `http://127.0.0.1:${port}`;
    const posted = await postJson(`${origin}/api/board`, { title: 'A board', blocks: [{ kind: 'markdown', text: 'Shown.' }] }, daemon.secret);
    const boardUrl = `${origin}${new URL(posted.url).pathname}`;
    const cookie = sessionToken(daemon.secret);

    await withChrome({ tag: 'cb-home' }, async ({ send, onEvent }) => {
      const open = (url, expr = HOME_HREF) => measureTab(send, onEvent, url, cookie, { ...VIEW, expr });

      await row('a browser that opened no overview: Home goes to Missions', async note => {
        const href = await open(boardUrl);
        note(`href ${href}`);
        assert.equal(href, '/');
      });

      await row('Boards opened, then a board: Home goes to Boards, and still after the board reloads', async note => {
        await open(`${origin}/boards`, 'document.title');
        const tab = await openTab(send, onEvent, boardUrl, cookie, { ...VIEW, expr: HOME_HREF });
        try {
          note(`href ${tab.measured}`);
          assert.equal(tab.measured, '/boards');
          const reloaded = new Promise(resolve => {
            const off = onEvent(msg => { if (msg.method === 'Page.loadEventFired') { off(); resolve(); } });
          });
          await tab.sp('Page.reload', {});
          await reloaded;
          await tab.quiet();
          const after = await tab.evalPage(HOME_HREF);
          note(`after reload ${after}`);
          assert.equal(after, '/boards');
        } finally {
          await tab.close();
        }
      });

      await row('Missions opened after Boards: Home goes to Missions again', async note => {
        await open(`${origin}/`, 'document.title');
        const href = await open(boardUrl);
        note(`href ${href}`);
        assert.equal(href, '/');
      });
    });
  } finally {
    await daemon.stop();
  }
}

runMain('browser-check-home', main);
