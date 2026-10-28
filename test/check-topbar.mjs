// The two home views and their one top bar: Missions at `/`, the board's home page, and
// the boards list at `/boards`, each under the bar src/indexpage.mjs's renderTopBar draws.
// Markup level, against the pages a real daemon serves on an ephemeral port: the bar is
// the same bytes on both views apart from which tab is on, the boards list keeps its
// filter, and an old `/?q=` link lands on the boards list with its query. Where the bar
// sits and how wide the list runs is layout, which test/browser-check-topbar.mjs measures
// in a real Chrome (QUIRKS.md "The DOM stand-in's ceilings").
//
// One board here waits on an answer, which is the stranded rule's shape: the PATH stub
// and the grace keep any banner off the screen, as in every daemon-booting check.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { renderBoardPage } from '../src/render.mjs';
import { createBoard } from '../src/board.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { check, runMain, secretHome, writeStub, rawRequest, projectFor, postBoard } from './support.mjs';

const { home: workDir, secret: SECRET } = secretHome('claude-board-topbar-', { secret: 'e'.repeat(64), setHome: false });
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
process.env.CLAUDE_BOARD_HOME = home;
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(24 * 60 * 60 * 1000);
const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', '#!/bin/sh\nexit 0\n');
process.env.PATH = `${stubDir}:${process.env.PATH}`;

const QUESTION = prompt => ({ kind: 'question', prompt, widget: 'single', options: [{ label: 'Yes' }] });
const NOTE = text => ({ kind: 'markdown', text });
const BAR = /<header class="board-head">[\s\S]*?<\/header>/;

async function get(port, pathName) {
  return rawRequest(port, 'GET', pathName, { headers: { [SECRET_HEADER]: SECRET } });
}

/** The bar's markup with the active tab's two marks taken off, so what is left is
 * everything that has to be the same on both views. */
function barWithoutActive(html) {
  const bar = html.match(BAR);
  assert.ok(bar, 'setup: the page carries the top bar');
  return bar[0].replace(/ class="view-tab on"/, ' class="view-tab"').replace(/ aria-current="page"/, '');
}

const tabs = doc => doc.querySelectorAll('a.view-tab').map(a => ({
  label: a.textContent.replace(/\d+ waiting$/, '').trim(),
  href: a.getAttribute('href'),
  on: a.getAttribute('class') === 'view-tab on',
  current: a.getAttribute('aria-current'),
}));

async function main() {
  const { server, port } = await startServer({ home, port: 0 });
  try {
    await postBoard(port, SECRET, { title: 'Alpha session', blocks: [NOTE('A')], cwd: projectFor(workDir, 'alpha') });
    await postBoard(port, SECRET, { title: 'Beta session', blocks: [NOTE('B')], cwd: projectFor(workDir, 'beta') });

    await check('Missions and Boards serve the same top bar, apart from which tab is on', async () => {
      const missions = await get(port, '/');
      const boards = await get(port, '/boards');
      assert.equal(missions.status, 200);
      assert.equal(boards.status, 200);
      assert.equal(barWithoutActive(missions.body), barWithoutActive(boards.body));

      assert.deepEqual(tabs(parseHTML(missions.body)), [
        { label: 'Missions', href: '/', on: true, current: 'page' },
        { label: 'Boards', href: '/boards', on: false, current: null },
      ]);
      assert.deepEqual(tabs(parseHTML(boards.body)), [
        { label: 'Missions', href: '/', on: false, current: null },
        { label: 'Boards', href: '/boards', on: true, current: 'page' },
      ]);
    });

    await check('the bar is the board page\'s own header: its shell, mark, title, timer, Comment and theme', async () => {
      const doc = parseHTML((await get(port, '/boards')).body);
      const boardDoc = parseHTML(renderBoardPage(createBoard({ title: 'A board', blocks: [{ kind: 'html', html: '<p>x</p>' }] })));
      const bar = doc.querySelector('div.board-shell header.board-head');
      assert.ok(bar, 'the bar sits in the board page\'s own shell');
      assert.equal(bar.querySelector('h1').textContent, 'claude-board');
      assert.equal(bar.querySelector('a.back-to-index').getAttribute('href'), '/');
      assert.equal(bar.querySelector('a.back-to-index').innerHTML, boardDoc.querySelector('a.back-to-index').innerHTML,
        'the board head\'s own mark, at its size');
      const actions = bar.querySelector('div.board-head-actions');
      assert.deepEqual(actions.children.map(el => el.getAttribute('id')), ['pomodoro-widget', 'comment-mode-toggle', 'theme-toggle']);
      assert.equal(actions.querySelector('button#theme-toggle').outerHTML, boardDoc.querySelector('button#theme-toggle').outerHTML);
    });

    await check('Comment sits in the bar disabled on both views, where nothing waits on a comment (ADR 46, 98)', async () => {
      for (const p of ['/', '/boards']) {
        const toggle = parseHTML((await get(port, p)).body).querySelector('button#comment-mode-toggle');
        assert.ok(toggle, `${p}: the Comment control is in the bar`);
        assert.equal(toggle.getAttribute('disabled'), '', `${p}: and is off`);
        assert.equal(toggle.getAttribute('title'), 'Nothing here is waiting on a comment');
      }
      const board = parseHTML(renderBoardPage(createBoard({ title: 'B', blocks: [{ kind: 'html', html: '<p>x</p>' }] })));
      assert.equal(board.querySelector('button#comment-mode-toggle').getAttribute('disabled'), null,
        'a board page\'s Comment is untouched');
    });

    await check('the Boards tab counts the rounds waiting, the same total GET /api/waiting serves', async () => {
      const zero = parseHTML((await get(port, '/')).body).querySelector('span#waiting-count');
      assert.equal(zero.getAttribute('hidden'), '', 'nothing waiting: the count hides');
      await postBoard(port, SECRET, { title: 'Gamma session', blocks: [QUESTION('G?')], cwd: projectFor(workDir, 'gamma'), wait: true });
      const total = JSON.parse((await get(port, '/api/waiting')).body).total;
      assert.equal(total, 1, 'setup: one round waiting');
      for (const p of ['/', '/boards']) {
        const count = parseHTML((await get(port, p)).body).querySelector('span#waiting-count');
        assert.equal(count.textContent, '1 waiting', p);
        assert.equal(count.getAttribute('hidden'), null, p);
      }
    });

    await check('Missions at / is an empty state in its mount point, with no boards list', async () => {
      const doc = parseHTML((await get(port, '/')).body);
      const mount = doc.querySelector('section#missions');
      assert.ok(mount, 'the missions mount point');
      assert.equal(mount.querySelector('p.empty-state').textContent,
        'No missions yet. Work a session records as a mission shows up here.');
      assert.equal(doc.querySelector('div.thread-list'), null);
      assert.equal(doc.querySelector('form.search-form'), null);
    });

    await check('the Boards view keeps the filter: the box submits to /boards and the list holds only what matches', async () => {
      const doc = parseHTML((await get(port, '/boards?q=beta')).body);
      const form = doc.querySelector('form.search-form');
      assert.equal(form.getAttribute('action'), '/boards');
      assert.equal(form.getAttribute('method'), 'get');
      assert.equal(form.querySelector('input.search-input').getAttribute('value'), 'beta');
      assert.equal(doc.querySelector('div.thread-list').getAttribute('data-query'), 'beta');
      assert.deepEqual(doc.querySelectorAll('div.thread-title').map(t => t.textContent.trim()), ['Beta session']);
      const all = parseHTML((await get(port, '/boards')).body).querySelectorAll('div.thread-title').map(t => t.textContent.trim());
      assert.deepEqual(all.sort(), ['Alpha session', 'Beta session', 'Gamma session']);
    });

    await check('an old /?q= link lands on the Boards view with its query', async () => {
      for (const [from, to] of [['/?q=beta', '/boards?q=beta'], ['/?q=two%20words', '/boards?q=two%20words'], ['/?q=', '/boards?q=']]) {
        const r = await get(port, from);
        assert.equal(r.status, 302, from);
        assert.equal(r.headers.location, to, from);
      }
      assert.equal((await get(port, '/')).status, 200, 'no q: Missions');
    });
  } finally {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
}

runMain('topbar', main, { cleanup: () => rmSync(workDir, { recursive: true, force: true }) });
