// The spin-down state: the one flag the Master Chief's /spin-down sets (`POST /api/spin-down`),
// read back on its own route, on every binding a session's hook reads and on the Missions
// overview; and a mission's `parked` state, its card reading Parked with the line that
// resumes it, or Needs you with a Parked tag while a round it left waits on the PM.
//
// One layer: a real daemon on a temporary store and ephemeral port, the Missions page it
// serves parsed by test/dom-stand-in.mjs. The page's live repaint draws with the same
// missionsParts the server's first paint does (test/check-missions-view.mjs keeps that).

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SECRET_HEADER } from '../src/secret.mjs';
import { startServer } from '../src/server.mjs';
import { parseHTML } from './dom-stand-in.mjs';
import { check, deadPid, runMain, secretHome, writeStub, rawRequest, writeHeaders, postBoard } from './support.mjs';

const { home: workDir, secret: SECRET } = secretHome('claude-board-spin-down-', { secret: 'c'.repeat(64), setHome: false });
const home = path.join(workDir, 'store');
mkdirSync(home, { recursive: true });
process.env.CLAUDE_BOARD_HOME = home;
process.env.CLAUDE_BOARD_STRANDED_GRACE_MS = String(24 * 60 * 60 * 1000);
const stubDir = path.join(workDir, 'bin');
writeStub(stubDir, 'osascript', '#!/bin/sh\nexit 0\n');
process.env.PATH = `${stubDir}:${process.env.PATH}`;

let port;

async function post(route, body, headers = writeHeaders(SECRET)) {
  const r = await rawRequest(port, 'POST', route, { headers, body: JSON.stringify(body) });
  return { status: r.status, body: r.body ? JSON.parse(r.body) : null };
}

async function get(route) {
  const r = await rawRequest(port, 'GET', route, { headers: { [SECRET_HEADER]: SECRET } });
  assert.equal(r.status, 200, `reading ${route}: ${r.body}`);
  return JSON.parse(r.body);
}

async function missionsPage() {
  const page = await rawRequest(port, 'GET', '/', { headers: { [SECRET_HEADER]: SECRET } });
  assert.equal(page.status, 200);
  return parseHTML(page.body);
}

const cardFor = (doc, key) => doc.querySelectorAll('article.mission-card').find(c => c.getAttribute('data-mission-key') === key) || null;
const columnOf = (doc, key) => cardFor(doc, key)?.closest('section.mission-col')?.getAttribute('data-col') ?? null;
const tags = card => card.querySelectorAll('span.mission-tag').map(t => t.textContent);

async function main() {
  const started = await startServer({ home, port: 0 });
  const { server } = started;
  port = started.port;
  try {
    await check('the spin-down flag: on through POST, read on its route, every binding and the Missions overview; off clears it', async () => {
      assert.deepEqual(await get('/api/spin-down'), { on: false }, 'off until set');
      assert.deepEqual((await get('/api/missions')).spinDown, { on: false });

      const on = await post('/api/spin-down', { on: true, by: 'master-chief' });
      assert.equal(on.status, 200);
      assert.equal(on.body.on, true);
      assert.ok(Number.isFinite(Date.parse(on.body.at)), `at is the time it went on: ${on.body.at}`);
      const flag = { on: true, at: on.body.at, by: 'master-chief' };
      assert.deepEqual(on.body, flag);
      assert.deepEqual(await get('/api/spin-down'), flag);
      assert.deepEqual((await get('/api/missions')).spinDown, { on: true, at: flag.at });
      // A session bound to nothing still reads it: a successor reads it before it binds.
      assert.deepEqual((await get('/api/binding?id=sess-unbound')).spinDown, { on: true, at: flag.at });
      assert.equal((await post('/api/mission/BOUND_ONE', { title: 'Bound one', phase: 'direct', state: 'working' })).status, 200);
      assert.equal((await post('/api/mission/BOUND_ONE/session', { pid: process.pid, id: 'sess-bound' })).status, 200);
      const binding = await get('/api/binding?id=sess-bound');
      assert.deepEqual([binding.key, binding.spinDown], ['BOUND_ONE', { on: true, at: flag.at }]);

      const again = await post('/api/spin-down', { on: true, by: 'someone-else' });
      assert.deepEqual(again.body, flag, 'set again while on, it keeps when and by whom it went on');

      const chip = (await missionsPage()).querySelector('span.mission-spin-down');
      assert.deepEqual([chip?.textContent, chip?.getAttribute('title')],
        ['Spin-down on', `Spin-down since ${flag.at}: no merge, deploy or release step runs`], 'the Missions view says spin-down is on');

      const off = await post('/api/spin-down', { on: false });
      assert.deepEqual([off.status, off.body], [200, { on: false }]);
      assert.deepEqual(await get('/api/spin-down'), { on: false });
      assert.deepEqual((await get('/api/missions')).spinDown, { on: false });
      assert.deepEqual((await get('/api/binding?id=sess-bound')).spinDown, { on: false });
      assert.equal((await missionsPage()).querySelector('span.mission-spin-down'), null, 'off, the Missions view says nothing');
    });

    await check('the spin-down flag is written with the secret alone, and a body off its shape writes nothing', async () => {
      const noSecret = await post('/api/spin-down', { on: true }, { 'content-type': 'application/json' });
      assert.equal(noSecret.status, 401);
      for (const [body, error] of [
        [{ on: 'yes' }, 'on must be true or false'],
        [{}, 'on must be true or false'],
        [{ on: true, until: 'morning' }, 'the body has an unknown field: until'],
        [{ on: true, by: 7 }, 'by must be a string of at most 200 characters'],
      ]) {
        const r = await post('/api/spin-down', body);
        assert.deepEqual([r.status, r.body.error], [400, error]);
      }
      assert.deepEqual(await get('/api/spin-down'), { on: false });
    });

    await check('a parked mission reads parked, under waiting, its card tagged Parked with the line that resumes it and its board', async () => {
      const posted = await postBoard(port, SECRET, { title: 'Parked board', mission: 'PARKED_ONE', blocks: [{ kind: 'markdown', text: 'Shown.' }] });
      // Parked as the session's last act, its process since ended: never stalled or gone.
      assert.equal((await post('/api/mission/PARKED_ONE', { title: 'Parked one', phase: 'direct', state: 'working' })).status, 200);
      assert.equal((await post('/api/mission/PARKED_ONE/session', { pid: await deadPid() })).status, 200);
      const written = await post('/api/mission/PARKED_ONE', { state: 'parked', next: 'relaunch PARKED_ONE from its spec' });
      assert.equal(written.status, 200);
      assert.deepEqual([written.body.state, written.body.view, written.body.gone], ['parked', 'parked', null]);
      assert.equal((await get('/api/missions')).counts.parked, 1);

      const doc = await missionsPage();
      const card = cardFor(doc, 'PARKED_ONE');
      assert.equal(columnOf(doc, 'PARKED_ONE'), 'waiting');
      assert.deepEqual(tags(card), ['Parked']);
      assert.deepEqual(card.querySelectorAll('p.mission-fact').map(n => n.textContent), ['Resumerelaunch PARKED_ONE from its spec']);
      assert.equal(card.querySelector('span.mission-tag.mission-parked').textContent, 'Parked');
      assert.equal(card.querySelector('a.mission-link').getAttribute('href'), `/b/${posted.boardId}`);
    });

    await check('a mission parked on a question reads needs-you, its card tagged Parked beside the round it left', async () => {
      const posted = await postBoard(port, SECRET, { title: 'Asking board', mission: 'PARKED_ASKING',
        blocks: [{ kind: 'question', prompt: 'Which?', widget: 'single', options: [{ label: 'A' }, { label: 'B' }] }] });
      const written = await post('/api/mission/PARKED_ASKING', { title: 'Parked asking', phase: 'grill', state: 'parked', waitingOn: 'your pick' });
      assert.deepEqual([written.status, written.body.view], [200, 'needs-you']);

      const doc = await missionsPage();
      const card = cardFor(doc, 'PARKED_ASKING');
      assert.equal(columnOf(doc, 'PARKED_ASKING'), 'needs-you');
      assert.deepEqual(tags(card), ['Parked']);
      assert.deepEqual(card.querySelectorAll('p.mission-fact').map(n => n.textContent), ['Waiting onyour pick']);
      assert.equal(card.querySelector('a.mission-link').getAttribute('href'), `/b/${posted.boardId}`);
    });
  } finally {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
}

runMain('spin-down', main, { cleanup: () => rmSync(workDir, { recursive: true, force: true }) });
